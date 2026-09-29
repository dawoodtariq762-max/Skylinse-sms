# SMPP / SMS ingestion diagnosis — why our panel shows more SMS than the reference panel

**Date:** 2026-09-29 · **Scope:** diagnosis only — no production code changed, no repo file modified.
**Method:** source inspection of the deployed panel (`panel-src`, commit `fbee64e`), execution of the panel's *own*
helper functions against wire-accurate SMPP PDUs, live queries against the reference panel (techsms.org),
and direct TCP probe of the SMSC. Every claim below is marked **[measured]**, **[proven]** or **[inferred]**.

Reproduction scripts (run them yourself, nothing is mocked except the clock):
`/home/user/investigation/pdu_probe.js`, `udh_payload_probe.js`, `reassemble_proof.js`, `ingest_accounting.js`.

---

## 1. ISSUE

| # | Symptom as reported | Verdict after investigation |
|---|---|---|
| 1 | Our panel shows **significantly more SMS** than the reference panel | **Confirmed cause found.** Our ingest stores the same physical SMS more than once and stores multi-part SMS as several rows. The SMPP duplicate check is a **10-second** window that any SMSC retry, session drop or reconnect defeats. **[proven]** |
| 2 | Messages appear to **re-import on refresh** | Refresh does **not** re-import from SMPP — no such code path exists. The extra rows are already in `sms_records`; the report simply re-queries them. **[proven]** |
| 3 | Some SMS seem **pushed repeatedly** | Real: redelivered PDUs are stored again whenever they arrive more than 10 s after the first copy — including after every reconnect/restart. **[proven]** |
| 4 | **"Today" counts differ** vs the reference | Two independent causes: (a) our "today" is a **Europe/London** calendar day while the reference and the carrier data are **UTC**; (b) our counts include duplicate rows. **[measured + proven]** |

**Whose fault is it?** Ours (the ingestion/dedup design), not the SMSC and not the reference panel.
The SMSC redelivering a message it did not see acknowledged is *normal SMPP behaviour*; a correct receiver
must be able to recognise a repeat **for as long as the SMSC may retry** — we only recognise it for 10 seconds.

---

## 2. EVIDENCE

### E1 — Reference panel, measured live (2026-09-29, UTC day) **[measured]**

| metric | value |
|---|---|
| `/api/cdr` rows listed | **567** |
| distinct `id`s among them | **553** |
| `/api/admin/dashboard-stats` → `today_sms` | **553** |
| `today_revenue` / `today_profit` | 5.432 / 0.8148 |
| active numbers / total users | 14,600 / 0 |
| 2026-09-28 / 2026-09-27 totals | 14,844 / 14,882 |
| hour with the most traffic | **00:00Z → 393 rows (69 % of that day)** |

* The reference row carries `id` (an integer = the SMSC's message id), `timestamp` (UTC, `YYYY-MM-DDTHH:MM:SS`),
  `destination`, `sender_id`, `message`, `rate`, `range_name`, `allocated_to`. This user sees **no SMPP
  sequence/message-id field**, but the `id` is stable and unique per message — that is what its dedup keys on.
* The reference's own list is not perfect either: 14 rows repeat an identical `id`, and 64 groups repeat
  `destination + message` within seconds. Its **dashboard counts distinct ids (553)** while its **list shows 567**
  — a 14-row gap. So when comparing panels, compare *distinct physical SMS*, not raw row counts.
* Date helpers in the reference bundle use `Intl.DateTimeFormat("en-CA",{timeZone:"UTC"})` → **the reference day
  boundary is 00:00 UTC.**

> Your earlier expectation of "400–500 SMS/day" does not match the reference's measured volume (14,844 on Sep-28).
> If that number came from a different range/account, tell me — but the **ratio** between the two panels is what
> the mechanisms below explain.

### E2 — How our panel currently identifies a duplicate (exact code)

`backend/smppService.js:234` `dedupKeyFor()`:

```js
const rid = safeStr(pdu && (pdu.receipted_message_id || pdu.message_id)).trim();
if (rid) return 'mid:' + rid;                       // never taken: see E3
const bucket = Math.floor(Date.now() / 10000);      // <-- 10 SECOND bucket
return 'fp:' + sha1([src, dst, text, bucket].join('|')).digest('hex').slice(0, 24);
```

* Key stored in `smpp_seen`, unique on `(connection_id, dedup_key)` (`schema.js:556/564`).
* `sms_records` itself has **no uniqueness at all** — `id INTEGER PRIMARY KEY AUTOINCREMENT` only (`schema.js:98`),
  and `server.js:5750` inserts unconditionally. The ledger is the *only* guard.
* The ledger is **deleted** when an SMPP connection row is deleted (`server.js:679`), and it is scoped by the
  *row id* `connection_id` — re-adding the same SMSC connection creates a brand-new namespace.
* `sms_records` is never auto-deleted (`SMS_RETENTION_DAYS` default `0`, `server.js:847`) → duplicates are permanent.

### E3 — What the SMSC can actually send, and what our library exposes **[proven]**

Executed with the exact dependency (`smpp@0.6.0-rc.4`, in our `node_modules`):

| probe | result |
|---|---|
| `deliver_sm` param list in `defs.js:1159` | contains **no `message_id`** (only `submit_sm_resp`/`deliver_sm_resp` have one) |
| deliver_sm carrying an SMPP-3.4 `message_id` cstring | `pdu.message_id === undefined`; the parser walks it as a **TLV tag `21587` ("TS")** |
| `receipted_message_id` (0x001E) TLV | not exposed as a top-level field either |
| ⇒ `dedupKeyFor()` | **always** takes the 10-second fingerprint branch; the `mid:` branch is dead code |
| multi-part message with `esm_class=0x40` | `short_message = { udh: [ Buffer(00 03 42 02 01) ], message: "…" }` — UDH elements are **Buffers** |
| our `pduUdh()` + `reassemble()` on that buffer | `reassemble()` reads `el.id` / `el.value` → both `undefined` → `ref === null` → **returns the part text unchanged**; `st.parts.size` stays 0 → **multi-part SMS is never joined; each part becomes its own row** |
| `message_payload` (0x0424) TLV | library exposes `{message:"…"}`; our `pduText()` sees `short_message={message:""}` → returns `""` → **body stored empty**, and two *different* payload OTPs in the same 10 s bucket get the **same** key → the second is **silently dropped** |

### E4 — End-to-end row accounting (real DDL + real SQL + production functions) **[proven]**

`node /home/user/investigation/ingest_accounting.js` — one physical SMS in, how many `sms_records` rows out:

| scenario | rows stored | expected |
|---|---|---|
| SMSC retry at +0 s and +5 s (inside the 10 s bucket) | **1** | 1 ✅ |
| SMSC retry at **+12 s** (bucket rolled over) | **2** | 1 ❌ **duplicate** |
| panel restart, SMSC redelivers afterwards | **2** | 1 ❌ **duplicate** |
| connection deleted & re-created, SMSC redelivers | **2** | 1 ❌ **duplicate** |
| one **2-part** concatenated SMS | **2** | 1 ❌ **fragmented** |
| same OTP text genuinely requested again 3 min later | 2 | 2 ✅ (must not be collapsed) |
| two **different** OTPs via `message_payload` in one bucket | **1** | 2 ❌ **an SMS was lost** |
| link outage: 50 SMS replayed 4 min later | **100** | 50 ❌ **2×** |

Also measured: 3 redeliveries of one SMS → 3 rows; `COUNT(DISTINCT number,cli,message)` = 1.
The dashboard/report counts rows, so it reports **3**.

### E5 — Acknowledgements and why redelivery happens **[proven behaviour + inferred timing]**

* `ingest()` returns `ESME_OK` on the normal path — good. But it returns **`ESME_RSYSERR` (non-zero) on any
  exception** (`smppService.js:316`), which *instructs the SMSC to retry*. The insert happens *before* several
  later steps, so an exception after the insert → SMS already stored **and** SMSC told to resend → second row.
* If the TCP session dies (or a write fails silently — our `send()` is wrapped in `try/catch`) **before the
  `deliver_sm_resp` reaches the SMSC**, the SMSC retries by design. Retry timers in SMSCs are typically
  **30 s – 5 min** — far longer than our 10 s window, so every such retry becomes a duplicate.
* `enquire_link` is handled by the library (`smpp.js:75`) and our `deliver_sm_resp` correlates correctly
  (`pdu.response()` copies `sequence_number`, `pdu.js:79`) — **ack/bind mechanics are not themselves broken**;
  the vulnerability is the 10 s memory.
* Sequence numbers are per-session and reset on reconnect → they **cannot** be used as a durable identity.

**[inferred, needs your SMSC log to confirm]** the actual retry rate of `api.techsms.org`. Confirm with:
`SELECT event, COUNT(*) FROM smpp_logs WHERE event IN ('duplicate','deliver') GROUP BY event;`
and by counting duplicate content groups in `sms_records` (query A4 in §8).

### E6 — Timezone / "Today" **[measured + proven]**

| question | answer |
|---|---|
| What timestamp do we store? | `received_at` = **our** receipt time, UTC (`datetime('now')`, `nowSql()` `ISO…Z` sliced). The SMSC's own message time is not parsed or stored. |
| What timezone is the carrier data / reference panel? | **UTC** (reference CDR `timestamp`s and its date helpers). |
| What timezone is our backend? | Stores and mostly compares in **UTC**. |
| What timezone is our **"Today"**? | **Europe/London** — every dashboard/report day bucket is `ukStatDate(received_at)` / `ukTodayDateStr()` (`server.js:88,906,3881`). |
| What timezone does the frontend show? | Raw `received_at` string → **UTC**. |
| How is "today" computed? | Sum of `sms_daily_stats.sms_count` where `stat_date = ukTodayDateStr(0)` — a **UK** calendar day. |

Consequence, measured: on 2026-09-29 (BST, UTC+1) our UK "today" window starts at **2026-09-28 23:00 UTC**.
The reference's last UTC hour of Sep-28 contains **27 rows** (distinct ids 27) that the reference counts as
*yesterday* and we count as *today*. Visually, a "Today" report starts with rows stamped **yesterday 23:xx**.
During the UTC-midnight hour (69 % of that day's traffic) the two panels disagree the most. This mismatch
**only exists while the UK is on BST** — it will silently disappear on 26 Oct 2026 and return in March, which is
itself a way to verify the diagnosis.

### E7 — What is *not* causing duplicates (audited, ruled out)

| suspicion | finding |
|---|---|
| PM2 cluster double-processing | `ecosystem.config.js` = **fork, instances 1** (cluster explicitly forbidden). |
| Split `powerx-api` / `powerx-sync` both ingesting | role gating: `sync` skips HTTP+SMPP (`server.js:6211`), `api` skips provider sync → no double ingest. |
| Frontend refresh triggering an SMPP fetch/import | No such call exists; the only frontend sync call is `API.post('/sync/providers/…')`. Report tables are re-rendered (`innerHTML=`), never appended. |
| HTTP API-integration poller inserting rows | **Never started** — `pollApiIntegrations()` is not invoked (`server.js:6214` logs "poller disabled"). |
| Provider pull (`providerSync`) duplicating | Dedups on `(provider_id, provider_ref)` via `sync_seen`; the 30 s `overlap_seconds` re-read is deliberately absorbed by that ledger. **But** it does not dedup against SMPP/webhook rows (see R4). |
| Dashboard cache showing stale/duplicated data | 10 s read cache only; can delay changes, cannot invent rows. |

---

## 3. ROOT CAUSE

**R1 — The duplicate memory is a 10-second fingerprint (`smppService.js:234`).**
Any redelivery more than 10 s after the first copy — SMSC retry, post-drop retry, restart, reconnect, or a whole
backlog replay — computes a *different* key and is inserted as a new row. Because the `mid:` branch can never be
taken (E3), there is **no** identifier-based fallback. **This is the single largest source of "more SMS than reality".**

**R2 — Multi-part SMS are stored part-by-part.** `reassemble()` (`smppService.js:200`) reads a UDH structure
(`{id, value}`) that the installed library does not produce (it produces `Buffer`s). `ref` is always `null`, so a
2-part SMS = 2 rows, a 3-part = 3 rows, etc. The concat reference that *could* identify the message is right there
in the UDH and is being discarded.

**R3 — Replay protection is destroyed by connection edits.** `DELETE FROM smpp_seen WHERE connection_id=?`
(`server.js:679`) plus ledger scoping by row id means deleting/re-creating the connection (or the panel being
re-pointed at a new connection row) forgets every message ever seen.

**R4 — No cross-channel dedup.** SMPP (`smppService`), the carrier webhooks (`server.js:5774/5791`) and provider
pull (`providerSync:561`) each have their own ledger, and none consults the others. If the *same* traffic reaches
us twice by two channels, both copies are stored — and counted.

**R5 — No database-level safety net.** `sms_records` has no unique constraint and the insert is unconditional,
so nothing downstream can correct a dedup miss; duplicates live forever (no retention).

**R6 — "Today" is a UK day over UTC timestamps, while the reference and the carrier are UTC.** Independent of
duplicates, this shifts up to one hour of traffic between "today"/"yesterday" (27 rows measured on this stream).

**R7 — Related correctness bugs found on the way:** `message_payload` bodies are stored as `""` and two distinct
payload SMS in the same 10 s bucket collapse to one (data loss, not inflation); `saved = SELECT id … ORDER BY id
DESC LIMIT 1` (`server.js:5753`) can link a ledger row to the wrong SMS under interleaved writes;
the `failed_sms_queue` retry path (`server.js:5490`) inserts an **additional** `sms_records` row for a message that
may already have been stored.

---

## 4. AFFECTED CODE

| file:line | function | why it matters |
|---|---|---|
| `backend/smppService.js:234` | `dedupKeyFor()` | 10 s bucket; unreachable `mid:` branch → R1 |
| `backend/smppService.js:281-287` | `ingest()` dedup lookup | only guard before insert |
| `backend/smppService.js:301` | `INSERT OR IGNORE INTO smpp_seen` | written *after* insert; lost on any later throw |
| `backend/smppService.js:314-318` | `ingest()` return | `ESME_RSYSERR` on exception → asks the SMSC to resend |
| `backend/smppService.js:200-232` | `reassemble()` | reads `el.id`/`el.value`; library gives `Buffer` → R2 |
| `backend/smppService.js:95-99` | `pduUdh()` | returns raw library shape; must decode UDH bytes |
| `backend/smppService.js:79-93` | `pduText()` | `message_payload` body lost (empty string) |
| `backend/server.js:5656-5764` | `processIncomingSmsPayload()` | unconditional insert; ledger/id attribution |
| `backend/server.js:5750-5753` | insert + `saved` lookup | no uniqueness; `ORDER BY id DESC LIMIT 1` mis-attribution |
| `backend/server.js:679`, `backend/schema.js:556-565` | ledger + delete | replay protection wiped / scoped to a row id |
| `backend/server.js:88-96`, `906-940`, `3881` | `ukStatDate()` / `ukTodayDateStr()` / `ukDayRangeSql()` | UK-day buckets over UTC data → R6 |
| `backend/providerSync.js:542-583` | `syncProvider()` | good dedup, but isolated from other channels → R4 |
| `backend/schema.js:98-118` | `sms_records` DDL | no unique constraint → R5 |

---

## 5. PROPOSED FIX (nothing implemented yet — awaiting your approval)

Staged, smallest-risk-first. Nothing here touches roles, rates, allocations, payments, or any unrelated report.

**P0 — stop the bleeding (SMPP dedup only; ~120 lines in one file)**
1. Replace the 10 s bucket with a **durable, content-addressed key with a long redelivery window**:
   `key = sha1(source_addr | destination_addr | data_coding | text | udh-concat-ref:seq/total | payload)`,
   suppressed for a configurable `SMPP_DEDUP_WINDOW_SECONDS` (proposal: **600 s**, and log every suppression).
   *Content* is used, not the clock, so a retry at +12 s, +2 min or after a restart hits the same key and is dropped;
   a genuinely repeated identical SMS later than the window is still stored (no merging of distinct SMS).
2. Fix `reassemble()` to decode UDH from the Buffer (`id=udh[0][0]`, `ref=udh[0][2]`, `total=udh[0][3]`, `seq=udh[0][4]`,
   and the 16-bit form `id=0x08`), and include the concat ref in the dedup key so **redelivered parts** are also
   suppressed. Multi-part then stores **one** row with the full text (matching the reference's view).
3. Fix `pduText()` to read `pdu.message_payload` when `short_message` is empty (kills both the empty-body bug and
   the payload key collision).
4. Keep ACKs exactly as they are (always ACK success on the normal path) — **do not** change when we ack.

**P1 — make the ledger survive reality**
5. Scope the ledger by **connection identity** (`host + system_id`, or a stable `connection_uid`) instead of the
   mutable row id, and **stop deleting** `smpp_seen` on connection delete.
6. Add an optional **DB safety net** (needs your approval because it touches structure): a `dedup_key` column +
   unique index on `sms_records`, so an ingest that slips past the ledger cannot double-insert. Without it, dedup
   stays a single point of failure.

**P2 — "Today" / timezone (decision needed, see §9)**
7. Make the day definition **consistent with the data and the reference**: either (a) count UTC days (matches the
   carrier/reference, DST-proof), or (b) keep UK days but relabel the UI *and* render `received_at` in UK time so
   numbers and visible timestamps agree. Raw `received_at` stays UTC either way — **no historical row is touched**;
   only the derived `sms_daily_stats` buckets are recomputed with the existing, sanctioned rebuild engine
   (`scheduleStatsFullRebuild()` / `backfillSmsStats()`), which is keyed off `received_at` and is chunked/idempotent.

**P3 — hardening / visibility**
8. Fix `saved` id attribution (`lastInsertRowid` instead of `ORDER BY id DESC LIMIT 1`).
9. Report "duplicates suppressed" in the SMPP status/log view so this class of problem is visible next time.
10. Seed the replay ledger from existing `sms_records` (so already-stored duplicates do not re-arrive as new rows).

---

## 6. RISK

| change | risk | mitigation |
|---|---|---|
| Long dedup window (P0.1) | a **genuinely repeated identical SMS** inside the window (same src/dst/text, e.g. a user re-requesting the same OTP within 10 min) would be suppressed | keep the window configurable and conservative, log every suppression with key+sms id, and prefer the SMSC message id if a raw-capture check shows it is present; make the window per-connection |
| Multipart reassembly (P0.2) | a part lost in transit would hold a partial message pending | existing 5-minute staleness sweep is kept; pending parts are flushed on timeout instead of being dropped |
| Ledger keyed by identity (P1.5) | two connections to the same SMSC account would share one namespace | intended; restore the deleted-connection case explicitly |
| `dedup_key` column + unique index (P1.6) | DB structure change; could reject a legitimate row if the key is too coarse | approved-only, reversible `CREATE UNIQUE INDEX`, no data rewritten; keys are content+today only |
| Day-definition change (P2.7) | dashboard numbers shift by ≤1 h of traffic at the boundary; historical day buckets change | raw data untouched; rebuild is the existing engine; run it in a maintenance window and spot-check a known day before/after |
| **Never touched** | roles, permissions, rate cards, allocations, payments, unrelated reports, working features | changes are confined to `smppService.js` dedup/reassembly, the ledger scope, and day-bucket helpers |

Verification plan before anything is called fixed: re-run `ingest_accounting.js` (expect 1 row for every retry
scenario, 1 row for the 2-part SMS, 2 rows for the two payload OTPs), then a live bind to the SMSC with
redelivery replay and a 24-hour row-count comparison against `/api/cdr` distinct ids.

---

## 7. Reference ↔ ours comparison table (needs your DB)

I do not have access to the live panel database, so the "Ours" column must be filled in from your side.
The reference side (left) is real data pulled today; the "Ours" columns are the queries in §8.

| Reference SMS (measured) | Ours — same SMS? | Duplicate rows? | Timestamp delta | Reason |
|---|---|---|---|---|
| id 260699 · 2026-09-29 07:05:39Z · to 525656168166 · "As requested, we've updated your number…" | ? | ? | `received_at` − 07:05:39Z | compare via query A3 |
| id 250196 · 2026-09-29 00:28:47Z · to 528139639670 · "…Codigo de entrega: 8150…" | ? | ? | as above | 00:xxZ rows are the ones the TZ mismatch moves across the day boundary |
| ids 251157 (×2 rows, identical id) | n/a | reference itself repeats this id | — | reference's own list-vs-dashboard gap (567 vs 553) |

Fill-in procedure: pick 5 reference rows (id, timestamp, destination, message), then run A1–A3 below against our
DB. Match on `number = destination` and `message` (normalise whitespace), then compare `received_at` to the
reference `timestamp`; `COUNT(*) > 1` on a match = we stored that SMS more than once.
Expected outcome per R1/R2: duplicates concentrate on rows whose first copy is followed by *any* session event,
and on every multi-part message.

---

## 8. Audit SQL appendix (read-only; run on the live DB)

```sql
-- A1. how much inflation exists per source channel
SELECT source, COUNT(*) AS rows,
       COUNT(DISTINCT number||'|'||cli||'|'||message) AS distinct_messages
FROM sms_records GROUP BY source ORDER BY rows DESC;

-- A2. the worst duplicate groups (same content, stored N times)
SELECT number, cli, substr(message,1,60) AS msg, COUNT(*) AS copies,
       MIN(received_at) AS first_seen, MAX(received_at) AS last_seen,
       CAST((julianday(MAX(received_at))-julianday(MIN(received_at)))*86400 AS INT) AS seconds_apart
FROM sms_records GROUP BY number, cli, message HAVING copies > 1
ORDER BY copies DESC LIMIT 50;

-- A3. find one specific reference SMS (edit the values)
SELECT id, number, cli, message, received_at, source
FROM sms_records WHERE number='525656168166' AND message LIKE 'As requested, we''ve updated%'
ORDER BY received_at;

-- A4. duplicate-rate estimate: retries land 10s..hours apart; genuine repeats too — inspect the histogram
SELECT CASE WHEN seconds_apart < 60 THEN '<1min'
            WHEN seconds_apart < 600 THEN '1-10min'
            WHEN seconds_apart < 3600 THEN '10min-1h' ELSE '>1h' END AS gap,
       COUNT(*) AS groups
FROM (SELECT CAST((julianday(MAX(received_at))-julianday(MIN(received_at)))*86400 AS INT) AS seconds_apart
      FROM sms_records GROUP BY number, cli, message HAVING COUNT(*) > 1)
GROUP BY gap ORDER BY groups DESC;

-- A5. is the panel bound twice to the same SMSC? (two sessions = every SMS delivered twice)
SELECT id, name, mode, host, port, system_id, bind_type, active, status, total_received
FROM smpp_connections;

-- A6. ledger sanity: keys vs stored rows, and whether the ledger is being wiped
SELECT (SELECT COUNT(*) FROM smpp_seen) AS seen_keys,
       (SELECT COUNT(*) FROM sms_records WHERE source='smpp') AS smpp_rows,
       (SELECT COUNT(*) FROM smpp_logs WHERE detail LIKE 'duplicate ignored%') AS suppressions_logged;

-- A7. today's numbers under both day definitions (the TZ question)
SELECT date(received_at) AS utc_day, COUNT(*) AS rows
FROM sms_records WHERE received_at >= datetime('now','-2 days') GROUP BY utc_day;
SELECT date(received_at,'+60 minutes') AS uk_day_bst, COUNT(*) AS rows
FROM sms_records WHERE received_at >= datetime('now','-2 days') GROUP BY uk_day_bst;
```

---

## 9. Open items / decisions I need from you

1. **Run A1–A6** (or give me DB access / a copy) — that gives the exact attribution of your duplicates and fills
   the §7 table.
2. **Confirm the SMSC's retry behaviour** — if you have access to a techsms SMSC log, or allow a short controlled
   bind, I can verify whether `api.techsms.org` ever sets `message_id`/`receipted_message_id` on `deliver_sm`
   (my probe shows our library drops it regardless — a raw capture would settle whether we can rely on it).
3. **TZ decision (P2.7):** count **UTC** days (matches the carrier/reference) or keep **UK** days with matching
   labels and display? I recommend UTC for carrier traffic.
4. **Approval to implement P0/P1** — after approval I will implement, then re-run the accounting harness and show
   the before/after table; nothing will be reported as fixed until those tests pass.

**SMSC reachability check (already done, read-only):** `api.techsms.org:2775` TCP connects in 4 ms and stays
silent until the client speaks (normal SMPP). **I have not bound to it** — no login/bind has been attempted, so
no production session was disturbed.
