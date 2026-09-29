# SMPP Deep-Dive: Record Count Mismatch (14k vs 28k) — LIVE-VERIFIED

**Date:** 2026-09-29 · **Status:** ✅ All findings reproduced live (not static analysis only) using the real panel + real SMPP + real SQLite. Harness: `/home/user/smpp-live-test/` (`mock-provider.js` = fake carrier SMPP+HTTP, `live-test.js`, `verify-fix.js`).

## ✅ LIVE TEST RESULTS (empirical, 2026-09-29)

| Test | Finding | Result |
|---|---|---|
| T1 | Same PDU twice **within 10s**, same connection | 1 row — dedup works as designed |
| **T2** | **F3:** Same PDU redelivered **>10s later** | **2 rows — BUG CONFIRMED.** 10s fingerprint window expired |
| **T3** | **F2:** Same message over the **second** connection to same provider | **2 rows — BUG CONFIRMED.** `smpp_seen` is per-`connection_id` |
| **T4** | **F1:** Same content via **SMPP, then HTTP webhook** | **2 rows — BUG CONFIRMED.** No shared dedup ledger between channels |
| **T5** | **F5:** Inactive sharing user / manager-only number / empty `attribute_url` | All **stored, never forwarded, ZERO log rows** — invisible loss |
| **T6** | **F6:** Failed HTTP forward | 1 attempt, **never retried** (verified after 28s) — permanent loss |
| **T7*** | **HTTP `connection_type` forwarding** | **100% broken: every forward crashed `cleanUrl is not defined`** |
| **T8** | Panel-sharing "Total OTP Received" dashboard | Counted 5 stored rows while only **1** was actually delivered |

**T7\* — found BY the live test, not by static reading:** `cleanUrl()` is used in `server.js` (lines ~4912 and ~5018) but only defined in `providerSync.js`. Every HTTP forward threw a ReferenceError caught as `failed`. If the customer panel that shows "14k" is fed via HTTP forwarding, **it received zero HTTPS forwards since the day that code shipped.** Fixed in `backend/server.js` and re-verified live: after the fix the real OTP reached the mock customer endpoint (`status: 'success'`, HTTP hit observed), and genuine remote errors now log honestly as `failed / HTTP 500` instead of the misleading crash.

`sharing_forward_logs` after test (before fix): `su#4 failed: 'cleanUrl is not defined'`, `su#5 failed: 'cleanUrl is not defined'` — 0 successes for all HTTP users.

---

**Scope:** `backend/smppService.js`, `backend/server.js`, `backend/providerSync.js`, `backend/schema.js`, `backend/db.js`

---

## 1. Symptom

One side shows **~14,000** records, the other shows **~28,000** — an almost exact **2× ratio**. That ratio is the single most important clue: it indicates something happening *systematically twice per message* (or half the traffic taking a dead path), not random failure.

There are two possible readings of the symptom, and the code contains confirmed defects for **both**. Run the SQL in §5 (takes < 5 minutes) to know which one you have:

| | **Scenario A — our DB doubled** | **Scenario B — forwarding loss** |
|---|---|---|
| Story | Provider delivered 14k real OTPs; our panel stored 28k rows | Our panel stored 28k; the customer's panel (Panel Sharing) only received 14k |
| Visible as | `sms_records` row count = 2× provider's report | sms_records = 28k, customer panel = 14k |
| Main suspects | F1, F2, F3 (§3) | F5, F6, F7 (§4) |

---

## 2. Architecture: 4 inbound channels, 4 **separate** dedup ledgers

Every channel ends in the same function — `processIncomingSmsPayload()` (server.js:5560) — which does **one unconditional `INSERT INTO sms_records`** (server.js:5650). It has **no generic duplicate check of its own** beyond a provider-supplied id. Each channel keeps its *own* dedup ledger instead:

| # | Channel | Entry point | Dedup ledger | Scope of dedup |
|---|---|---|---|---|
| 1 | SMPP (client + server mode) | `ingest()` smppService.js:249 | `smpp_seen` | per `connection_id` only |
| 2 | Carrier HTTP webhook | server.js:5678 | `api_integration_seen` (`cb:<id>`) | only if provider sends a message id |
| 3 | Provider Sync (API pull) | providerSync.js:510 | `sync_seen` | per `provider_id` only |
| 4 | API Integration pull | server.js:5745+ | `api_integration_seen` (sha256 key) | per integration row only |

**Nothing dedups the same physical SMS arriving over two different channels.** This is the root design flaw behind Scenario A.

---

## 3. Findings — Scenario A (panel stores ~2× more than real)

### F1 — Cross-channel duplication: the same SMS ingested via 2 channels  🔴 HIGH
If a provider is configured on **two channels at once** — e.g. an SMPP connection **and** Provider Sync / API Integration pulling the same provider API — every message is inserted twice. Proof from code:

- SMPP ingest dedups against `smpp_seen(connection_id, dedup_key)` only (smppService.js:282).
- Provider sync (providerSync.js:565) calls `processIncomingSmsPayload` with **no message id**, so the webhook `cb:` ledger never sees it; it dedups only against `sync_seen`.
- Webhook dedup (server.js:5600-5612) fires only when the payload carries an id — SMPP and sync payloads carry none.

➡ **This produces an exact 2×**, matching the 14k/28k ratio precisely.
**Check:** is the same provider configured in *both* "SMPP Connections" and "Provider Sync / HTTP Integrations"?

### F2 — Duplicate `smpp_connections` rows to the same provider  🔴 HIGH
The schema has **no UNIQUE constraint** on `(host, port, system_id)` or `listen_port` (schema.js:513+). Two connection rows pointing at the same provider each receive every MO message, and because the dedup ledger is keyed on `connection_id`, **row #2's copy is not recognized as a duplicate** (smppService.js:282). Again an exact 2×.
**Check:** `SELECT id,name,mode,host,port,listen_port,system_id,total_received FROM smpp_connections;` — two rows for the same provider with similar `total_received`?

### F3 — Dedup fingerprint window is only 10 seconds  🟠 MEDIUM
When the peer supplies no message id, the dedup key is
`sha1(src|dst|text|floor(now/10s))` (smppService.js:234-244). A redelivered message **>10s later gets a different key and is stored again**.

When does a peer redeliver? Whenever it gets a NACK — and `ingest()` returns `ESME_RSYSERR` (a NACK) on *any* internal exception (smppService.js ~L320). Realistic trigger: `better-sqlite3` throwing after `busy_timeout = 10000` (db.js:59) during a heavy full-database file save (this DB layer rewrites the **whole database file** on saves — db.js:288). Provider retries 30–60s later → new fingerprint → duplicate row.
**Check:** in duplicate pairs (SQL §5.2), time gaps >10s apart prove this; gaps of 0–1s prove F1/F2.

### F4 — Delivery receipts filter is good, but multipart redelivery re-uses the 10s window  🟡 LOW
Receipts are correctly ignored (smppService.js:101-109). UDH multipart reassembly is deduped only after assembly, so a full re-delivery of a long SMS has the same >10s weakness as F3.

---

## 4. Findings — Scenario B (we stored 28k, customer's panel got 14k)

### F0 — HTTP forwarding was 100% dead (`cleanUrl is not defined`)  🔴🔴 CRITICAL — LIVE-VERIFIED, **FIXED**
`forwardSharingOtpIfNeeded` (server.js:5018) and the admin route `/api/panel-sharing/http/test` (server.js:4912) call `cleanUrl()`, which was never defined in `server.js` (it lives only in `providerSync.js`). Verified live: **every** HTTP forward crashed instantly and logged `failed / cleanUrl is not defined`. **Any sharing user configured with `connection_type = 'http'` received ZERO OTPs.** If your customer panel showing 14k is HTTP-fed, this alone explains the gap — possibly combined with F5 mapping gaps for the remainder.
**Fix applied:** `cleanUrl` added to `backend/server.js` and re-verified live end-to-end (real SMPP OTP → real HTTP POST received by the target; `status='success'` in `sharing_forward_logs`).
**Check your live DB:** `SELECT COUNT(*) FROM sharing_forward_logs WHERE error='cleanUrl is not defined';` — every one of those rows is an OTP the customer panel never got. After deploying the fix, new OTPs forward correctly; the historical ones would need a one-off re-push script.

The "Panel Sharing → delivered to the other panel" path (`forwardSharingOtpIfNeeded`, server.js:4994) has **four independent loss points**, and — importantly — the Panel Sharing dashboard's "Total OTP Received" counts **stored** rows (server.js:4428), not successful forwards, so the dashboard will happily show 28k while 14k silently vanished.

### F5 — Half the traffic may never enter the forwarder at all  🔴 HIGH (matches 50% loss)
Forwarding happens **only if all of these hold:**

1. the number has an `agent_id` (manager/client-allocated numbers never forward),
2. that agent is mapped to an **active** sharing user — and only the **first** matching sharing user row is used (`db.get`, server.js:4423,4996). A second sharing user for the same agent is ignored,
3. for legacy "activity" connections: `attribute_url` set — otherwise an **early return with no log row at all** (server.js:5072), completely invisible loss.

If roughly half your numbers sit under an agent with no sharing user (or a sharing user marked inactive), the forwarded count halves — exactly the observed 28k → 14k.
**Check:** SQL §5.7 compares stored-per-sharing-agent vs forwarded.

### F6 — HTTP forwarding: single attempt, no retry, no requeue  🔴 HIGH
The HTTP forward is one `fetch` with a 10s timeout (server.js:5030-5065). Any failure — timeout, HTTP 500, TLS error — writes a `failed` row to `sharing_forward_logs` **and is never retried**. Under sustained load a 50% failure rate on a struggling endpoint is entirely plausible.
**Check:** `SELECT status, COUNT(*) FROM sharing_forward_logs GROUP BY status;`

### F7 — SMPP forwarding: "first session" blackhole + queued-stuck rows  🔴 HIGH
To deliver an OTP into the customer's SMPP session (Direction B), `drainOutbox()` picks **the first session in the bound-sessions Set** (`pickSession`, smppService.js:769-772). If the customer rebound and their old socket is half-open (TCP not yet reset — common), forwards are written into a **dead socket and vanish**. Additionally:

- there is **no timeout on the `submit_sm` callback** (smppService.js:789+): a peer that accepts the write but never answers `submit_sm_resp` leaves the row `queued` — it is re-sent on the next drain (duplicate on their side), or drains only happen on *bind* and *new enqueue*, so a stuck row can sit indefinitely,
- rows never expire; if no session is bound they wait silently.

**Check:** SQL §5.8 — look for old `queued` rows and repeated `attempts`.

### F8 — Server mode accepts `submit_sm`, `deliver_sm` and `data_sm` on one session  🟡 LOW
All three feed `ingest()` (smppService.js:709-733). A misbehaving peer sending the same message on two PDU types would be caught by the 10s fingerprint — but crosses into F3's weakness.

---

## 5. Verification kit (run against the live `data.db`)

```sql
-- 5.1 Real volume by source (which channels are actually ingesting?)
SELECT source, COUNT(*) AS rows_, date(received_at) d
FROM sms_records GROUP BY source, d ORDER BY d DESC;

-- 5.2 Are there TRUE duplicates? (same number+cli+message, same content)
SELECT number, cli, message, COUNT(*) c,
       GROUP_CONCAT(id) ids, GROUP_CONCAT(received_at) times
FROM sms_records
WHERE date(received_at) >= date('now','-3 days')
GROUP BY number, cli, message
HAVING c > 1 ORDER BY c DESC LIMIT 50;
-- times ~0-1s apart  -> Scenario A, F1/F2 (two channels/connections)
-- times >10s apart   -> F3 (redelivery past the dedup window)

-- 5.3 Two rows for the same provider?
SELECT id,name,mode,host,port,listen_port,system_id,status,total_received
FROM smpp_connections ORDER BY host;

-- 5.4 Duplicate-key ledger sizes (should look sane vs received volume)
SELECT connection_id, COUNT(*) FROM smpp_seen GROUP BY connection_id;

-- 5.5 "Duplicate ignored" activity in logs
SELECT level, COUNT(*) FROM smpp_logs WHERE detail LIKE '%duplicate%' GROUP BY level;

-- 5.6 Forwarding success rate (Scenario B)
SELECT connection_type, status, COUNT(*)
FROM sharing_forward_logs GROUP BY connection_type, status;

-- 5.7 How many STORED rows belong to agents with NO active sharing user?
SELECT COUNT(*) AS never_forwarded
FROM sms_records s
WHERE COALESCE(s.is_test,0)=0
  AND (s.agent_id IS NULL
       OR s.agent_id NOT IN (SELECT agent_user_id FROM sharing_users WHERE active=1));

-- 5.8 Stuck / retried SMPP forwards
SELECT status, COUNT(*), MAX(attempts) FROM smpp_outbox GROUP BY status;
SELECT id, connection_id, destination, attempts, created_at
FROM smpp_outbox WHERE status='queued' ORDER BY id LIMIT 20;
```

Also check the dashboard counters you were comparing: **Panel Sharing → Dashboard "Total OTP Received"** counts *stored* rows joined to sharing users (it even misses the `su.active` filter — server.js:4428), while **Forward Logs** show actual delivery. Those two numbers are *expected* to differ if forwards are failing.

---

## 6. Recommended fixes (prioritized)

**Immediate (config, no code):**
1. If the same provider is on **two channels** (SMPP + Sync/API pull) — **disable one**. (F1)
2. If two `smpp_connections` rows point to one provider — **delete/deactivate one**, then clear its `smpp_seen` rows. (F2)
3. Compare `sms_records` source counts vs forwards (§5.6–5.7) to confirm which half is "missing".

**Code fixes I can implement on your go:**

| # | Fix | Status |
|---|---|---|
| 0 | **`cleanUrl` missing in server.js** — HTTP forwarding dead | ✅ **DONE + live-verified** |
| 1 | Global cross-channel dedup: content-hash ledger `(number, cli, normalized_message, day)` with UNIQUE index, checked inside `processIncomingSmsPayload` so **all 4 channels** dedup against one place (window ~24h, so repeated-but-genuine same-text SMS on later days still store) | Proposed (Medium) |
| 2 | Extend SMPP fingerprint window 10s → 24h (bucket per hour, or store exact fp + `received_at` expiry) | Proposed (Small) |
| 3 | UNIQUE guard on `smpp_connections(host, port, system_id)` + UI warning | Proposed (Small) |
| 4 | Forwarding overhaul: forward to **all** matching sharing users (`db.all`), log the silent `attribute_url` drop, **retry queue** for failed HTTP forwards (exponential backoff, max 5), dead-session pruning + submit_sm response timeout in `pickSession`/`drainOutbox` | Proposed (Medium) |
| 5 | Fix the Panel Sharing dashboard counter: count `status='success'` forwards and add the missing `su.active` filter | Proposed (Small) |
| 6 | One-off cleanup script: identify + soft-delete existing duplicate `sms_records` (keeps first id, re-links payment ledger); optional one-off re-push of OTPs lost to F0 | Proposed (Medium) |

---

## 7. Bottom line (now evidence-based)

- **Verified live:** every HTTP-configured sharing user received **zero** OTPs (`cleanUrl is not defined`) — fixed and re-verified.
- **Verified live:** duplicates ARE stored when (a) the same message crosses two channels (SMPP+webhook), (b) two SMPP connections see it, or (c) a provider redelivers after the 10s dedup window — each mechanism produced real double rows in `sms_records`.
- **Verified live:** stored OTPs are silently never forwarded (no log at all) for manager-only numbers, inactive sharing users, and empty `attribute_url`; failed forwards are never retried.
- Run §5's SQL on the **production** DB to size the real damage — especially:
  `SELECT status, error, COUNT(*) FROM sharing_forward_logs GROUP BY status, error;` and the duplicate-pair time-gap query (§5.2).
- Tell me the numbers and I'll implement fixes #1–#6 exactly where the data points.
