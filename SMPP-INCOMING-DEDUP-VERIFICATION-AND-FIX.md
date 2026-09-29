# Incoming SMPP Deduplication — Verification + Fix Report

**Date:** 2026-09-29 · **Scope:** incoming/receiving SMPP only (`backend/smppService.js`, `backend/schema.js`).
Panel Sharing / HTTP forwarding / outbound / multi-connection topics deliberately untouched.
**Method:** everything below was verified LIVE — real panel process + real SMPP carrier + real SQLite in `/home/user/smpp-live-test/`. Nothing is assumed.

---

## A. Verification answers (before the fix)

### 1. Does the system really have a 10-second deduplication limitation? — **YES (confirmed live)**
A message redelivered after the 10s bucket boundary was stored again. Reproduced live: deliver_sm at t=0 → 1 row; identical PDU at t=+15s → 2nd row (harness `live-test.js`, T2).

### 2. Where exactly is the window implemented? — `dedupKeyFor()`, old smppService.js L234-244
`bucket = Math.floor(Date.now() / 10000)` — the clock is baked **into the dedup key**:
`fp:sha1(src|dst|text|bucket)`. The ledger table `smpp_seen` (`UNIQUE(connection_id, dedup_key)`) is only checked for exact key matches, so the same SMS in a different 10s bucket = a different key = no duplicate detection.

### 3. Can a delayed carrier redelivery create a second `sms_records` row? — **YES (confirmed live)**
Mechanism: carrier redelivers whenever it gets a NACK (`ingest()` returns `ESME_RSYSERR` on any internal exception, e.g. SQLite busy) or when a link drops mid-flight. Retry timers are typically 30–60s — already outside the 10s window.

### 4. Does SMPP provide a reliable unique message ID for inbound (MO) SMS? — **NOT guaranteed.** Verified empirically (`probe-pdu.js`): a plain `deliver_sm` carries **no `message_id`** (that field is only defined in responses), and `sequence_number` is per-session per-PDU (a redelivery is a *new* PDU with a new sequence number — useless as an id). Optional TLVs *can* carry ids (`receipted_message_id 0x001E`, vendor TLVs) — supported by the library and now used when present — but a carrier is not obliged to send them on MO traffic.

### 5. Is such an id stable across sessions/binds? — **Not guaranteed across sessions.** Ids (when present) are unique per carrier account; the panel already handles all binds of one connection under a shared `connection_id` ledger, which is the correct "appropriate" scope. (Cross-connection/global dedup was out of scope per instructions and is also semantically unsafe for counter-style ids from different carriers.)

### 6. Identifiers actually available on an inbound PDU (probe-dumped): `source_addr`, `destination_addr`, `esm_class` (UDHI bit 0x40, receipt bits 0x04/0x08/0x0C), `data_coding`, PDU `sequence_number`, UDH concatenation elements (IEI 0x00/0x08: reference/total/seq), `sar_*` TLVs (0x020C/0x020E/0x020F), `receipted_message_id` TLV (0x001E), `message_state` TLV (0x0427, receipts only), text.

### 7. How were multipart SMS handled? — **SILENTLY BROKEN (confirmed live, worse than assumed).**
The library delivers UDH elements as **raw Buffers** `[IEI, len, …]` but `reassemble()` expected `{id, value}` objects → `ref` never parsed → reassembly never ran. Baseline result: one physical 2-part SMS was stored as **2 separate rows** (message id 1 = part 1 text, id 2 = part 2 text). Multipart OTPs inflated every record count.

### 8. How were delivery receipts handled? — **Mostly OK, one confirmed leak.**
`esm_class` receipt bit (0x04): ignored ✔ (0 rows live). Receipt-shaped text with esm=0 (regex `/^id:\S+ sub:\d+/`): ignored ✔. **Leak confirmed live:** a receipt carrying only the `message_state` TLV (0x0427) with plain text `delivered` was **stored as a normal SMS** (row id 3 in baseline). Plus SMPP 5.0 ack types 0x08/0x0C were not filtered.

### Other implementation defects found during verification
- Ingest catch-all **NACKs** (`ESME_RSYSERR`) on transient internal errors → this is precisely what triggers carrier redeliveries that the 10s window then fails to catch.
- `smpp_seen` had **no TTL pruning** (rows forever).

---

## B. Root cause (summary)

The 10s window was a **design error**: the clock was embedded in the dedup key itself (`fp:sha1(src|dst|text|10s-bucket)`), so duplicate detection was only possible inside a bucket. Combined with NACK-triggered carrier redeliveries at 30–60s, duplicates were guaranteed under real-world conditions. Multipart messages had an additional, independent parsing bug storing every segment as its own row.

## C. The fix (implemented in `backend/smppService.js` — minimal, one file)

**Three-tier dedup, keyed on what identifies the physical message:**

| Tier | Trigger | Key | Duplicate window |
|---|---|---|---|
| `mid:` | carrier message id TLV present | `mid:<id>` | windowless, TTL 30d (`SMPP_DEDUP_MID_TTL_DAYS`) |
| `mp:` | multipart (UDH or `sar_*` TLV) | `mp:sha1(src\|dst\|ref\|total\|text)` | windowless, TTL 7d (`SMPP_DEDUP_UDH_TTL_DAYS`) |
| `fp:` | fallback, single-part no-id | `fp:sha1(src\|dst\|text)` — **clock removed from key** | anchored window `SMPP_DEDUP_FP_WINDOW_SECONDS` (default **120s**) |

Implementation details:
- New `concatInfo()` normalizes multipart descriptors from UDH raw buffers **and** `{id,value}` objects **and** `sar_*` TLVs; `reassemble()` now actually reassembles (bug from §A.7 fixed).
- `fp` window moved from the key into the query: `… AND datetime(received_at) >= datetime('now','-W seconds')`; ledger row re-anchored (`INSERT OR REPLACE`) only **when a new copy is stored** — dropped sightings never extend the window, so a redelivery storm can't swallow a future legit twin.
- `isDeliveryReceipt()` strengthened: also ignores esm types 0x08/0x0C and any PDU with a `message_state` TLV (leak from §A.8 fixed).
- Ledger prune on startup + every 6h (`pruneDedupLedger`): `mid` 30d, `mp` 7d, `fp` window+5min.
- Scope kept per-connection; NACK/ACK behavior, outgoing code, panel sharing, server.js, schema.js, and all existing DB rows untouched. Mid-tier id keys unchanged from the old scheme, so existing ledgers stay compatible; dead old-style fp rows simply age out via pruning.

## D. Technical limitation (honest, provider-dependent)

If the carrier sends **no message id** on a **single-part** SMS, then byte-wise there is *physically nothing* distinguishing `same SMS redelivered at +30s` from `a new, identical SMS at +30s`. No software can separate them; a window is the only practical fallback. Consequences:
- `fp` redeliveries later than the window **still leak** (accepted; default 120s covers standard carrier retry cadences 5/10/30/60s, and the mp/mid tiers have no such limit).
- `fp` identical-but-genuine twins arriving **within** the window are merged (bounded, and the window is anchored so it never grows). Tune per provider via env: strict OTP farms that resend identical codes fast can lower it (e.g. 30s); flaky carriers can raise it.
- The clean permanent fix lives on the carrier side: ask for MO message ids (or sar/UDH) in the bind contract; whenever present, tiers 1–2 make dedup exact and windowless.

Multiparts keep one corner: 8-bit UDH refs recycle after 256 messages; two different messages could be merged only if src+dst+ref+total **and full text** all coincide within 7 days — for identical "OTP resend" texts this is exactly the physical-identity case anyway. 16-bit refs (IEI 0x08) and sar refs shrink it further. Documented, accepted.

---

## E. Test results (fixed code, live run — production-real: real SMPP, real DB)

Panel started with `SMPP_DEDUP_FP_WINDOW_SECONDS=45` for pace (prod default 120s).

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Immediate redelivery (same SMS twice at once) | 1 record | 1 | ✅ PASS |
| 2 | **Delayed redelivery >10s** (t≈+15s) | 1 record, no 2nd row | 1 | ✅ **FIXED** (was 2 pre-fix) |
| 3 | Genuine identical SMS (twins, spaced > window) | 2 records | 2 | ✅ PASS |
| 4 | Two legitimate `OTP 123456` messages | 2 records | 2 | ✅ PASS |
| 5 | Identical content, different message ids (A1001/A1002) | 2 records | 2 | ✅ PASS |
| 6 | Same message id twice, >10s apart | dropped (total stays 2 from T5) | 2 | ✅ PASS |
| 7a | Multipart 2-part assembly | 1 row, **full assembled text**, 0 part-rows | 1 (full text, 0 parts) | ✅ **FIXED** (was 2 part-rows pre-fix) |
| 7b | Multipart redelivery (same ref, +15s) dup; new ref same text kept | 2 records total | 2 | ✅ PASS |
| 8 | Receipts: esm 0x04 / id-text pattern / `message_state` TLV | 0 rows stored; real SMS after = 1 | 0 + 1 | ✅ **FIXED** (TLV-receipt stored pre-fix) |
| — | Boundary/anchor demo: no-id repeat at +80s (>45s window) | stored as new (anchor never chain-extends; irreducible fp limit shown) | 2 | ✅ as designed |

Ledger after suite: `fp:5, mid:2, mp:2` rows — exactly the stored distinct messages.

Regression: `node --check` on both changed files ✔; `tests/ui-theme.test.js` 27/27 ✔; module load ✔. Existing `sms_records` untouched; schema unchanged (no migration needed).

## F. Files changed / created
- `backend/smppService.js` — **only file changed** (≈+150 lines: concatInfo, tiered dedup, anchored fp window, receipt strengthening, ledger pruning, env knobs).
- Harness (not production code): `/home/user/smpp-live-test/` — `mock-provider.js`, `probe-pdu.js`, `baseline-mp.js`, `dedup-verify.js`, `verify-fix.js`.
