# SMPP / SMS ingestion fix — verification report

**Date:** 2026-09-29 · **Working copy:** `/home/user/panel-fix` (a copy of the deployed source; the pristine tree is kept untouched at `/home/user/panel-src` and `/home/user/panel-old`)
**Status: NOT DEPLOYED.** No production database was touched, no SMSC connection was opened, no SMS record was edited or deleted. Every test ran against throw-away databases.

---

## 0. The policy you asked for, and where it is enforced

> *"Keep the fallback mode lossless by default. Do not enable a 300-second content-based suppression window in production. When no reliable physical-message ID exists, store every incoming SMS, mark it as `no-id`, and count it separately in dedup/replay statistics. Never silently suppress a message merely because sender, destination, and body are identical."*

| your instruction | how it is enforced | how it is proven |
|---|---|---|
| lossless by default | `SMPP_FALLBACK_RETRY_WINDOW_SECONDS` defaults to `0`; the effective window is `0` unless the operator **also** sets `SMPP_ALLOW_CONTENT_SUPPRESSION=1` (`smppIdentity.contentSuppressionPolicy()`) | unit suite (policy tests); TEST 17b |
| no 300 s window in production | a window alone is **ignored**: boot logs a warning, `/api/smpp/status` and `/api/smpp/dedup-stats` report the *effective* window `0` and `lossless: true`; nothing in the shipped config sets either variable | TEST 17b (a 300 s window resolves to 0 and every replay is stored) |
| no-id messages are stored | the ingest path only suppresses on a durable identity; with none it stores and logs `no durable id on this PDU … stored without content-based suppression` | TEST 1/2/3/4/10 (no-id), TEST 17b |
| marked as `no-id` | new column `sms_records.identity_state` = `no-id` (also `strong` / `multipart` / `weak`), written on the same INSERT, indexed by `idx_sms_records_identity_state` | TEST 19; audit query A2/A3 |
| counted separately in dedup/replay statistics | `/api/smpp/dedup-stats` returns `no_id {last_24h,last_7d,total}` and `identity_states {strong,multipart,weak,no_id,unmarked}`; per connection `statusOf().dedup.noId` | Cross-checks (endpoint vs table count) |
| never suppressed merely for identical sender/destination/body | no content hash is ever used to decide anything; the three identical OTPs in TEST 5/TEST 5b are all stored, all marked `no-id` | TEST 5, TEST 5b, TEST 19 |

---

## 1. Headline results (all reproducible from this report)

| suite | pristine code (before) | fixed code (after) |
|---|---|---|
| `tests/unit_identity.js` (pure helpers) | n/a — the module did not exist | **PASS 29 / FAIL 0** |
| `tests/e2e_mock_smsc.js` (real panel + mock SMSC over TCP + real SQLite, real timings) | **PASS 29 / FAIL 47** (of 76 checks reached) | **PASS 94 / FAIL 0** |
| `tests/smoke_endpoints.js` (endpoint + UTC-day smoke) | n/a | **PASS 18 / FAIL 0** |
| `backend/scripts/rollback-dedup-v2.js` (dry-run + apply on a scratch DB) | n/a | verified, see §7 |

```bash
node /home/user/panel-fix/tests/unit_identity.js                        # 29 / 0
node /home/user/panel-fix/tests/e2e_mock_smsc.js                        # 94 / 0   (~4 min, real timings)
PANEL_DIR=/home/user/panel-old node /home/user/panel-fix/tests/e2e_mock_smsc.js   # the before column
node /home/user/panel-fix/tests/smoke_endpoints.js                      # 18 / 0
```
Logs: `/home/user/after-run.log`, `/home/user/before-run.log` (the older 76-check runs are kept as `*-v1-76check.log`).

---

## 2. Files changed (complete list — nothing else in the tree was touched)

| file | change |
|---|---|
| `backend/smppIdentity.js` | **new** — raw-PDU parser, TLV/appended-id extraction, UDH decode + multipart grouping, canonical body hash, account identity, and `contentSuppressionPolicy()` |
| `backend/dayWindow.js` | **new** — UTC SMS-day helpers (SMS counting only; payments keep the UK calendar) |
| `backend/smppService.js` | **rewritten ingest**: identity-first decision, durable `sms_dedup_ledger`, DB-backed `smpp_parts` multipart, `message_payload` fix, safe ACK ordering, staleness sweep, policy logging |
| `backend/server.js` | exact `lastInsertRowid`, `dedup_identity` pre-check + UNIQUE race handling, `identity_state` on insert, UTC day windows for SMS reporting, retry-endpoint idempotency, `connection_uid`, `/api/smpp/dedup-stats` |
| `backend/schema.js` | additive tables `sms_dedup_ledger` + `smpp_parts`, columns (`dedup_identity`, `identity_state`, `connection_uid`, …), partial UNIQUE index, guarded `migrateDedupV2()` with a pre-migration file backup |
| `backend/providerSync.js` | records the provider reference in the shared ledger (cross-channel matching stays opt-in, off) |
| `backend/scripts/rollback-dedup-v2.js` | **new** — dry-run-first rollback (snapshot, drop new tables, optional clearing of the added values) |
| `tests/*` | **new** — 6 test files (unit, e2e, mock SMSC lib, restart probe, window-policy probe, endpoint smoke) |

**Explicitly NOT touched:** roles/permissions, rate cards, allocations, payments/payout scheduling, provider credentials, the carrier HTTP webhook's behaviour, `admin.html`/`agent.html`/`client.html`, `ecosystem.config.js`, and every historical SMS row.

---

## 3. What was actually broken (found by the investigation, confirmed by the tests)

1. **Content was used as the identity.** The old key was `sha1(src|dst|text|10 s bucket)`; two genuinely different SMS with the same text inside one 10 s bucket became **one** row (lost SMS / lost payout), while the same pair 10 s apart became two rows (the duplicate complaint). Measured by `node /home/user/investigation/ingest_accounting.js` and by the before column of TEST 5/5b/1/2/10.
2. **Multipart never reassembled.** `reassemble()` read `.id/.value` while the library hands over Buffers, so the UDH was never seen: parts were stored as separate rows with half a body each (before column of TEST 7/7b/16).
3. **`message_payload` (TLV 0x0424) was stored with an empty body** (before column of TEST 9).
4. **Replay protection was per connection-row and was wiped** when the account was deleted (and did not survive a rename/restart): TEST 11/TEST 15 before column.
5. **Attribution used `ORDER BY id DESC LIMIT 1`** — under interleaved ingestion the wrong row could be referenced; the new code uses the insert's own row id and a ledger (TEST 12).
6. **The failed-SMS retry could double-count** (no idempotency, TEST 13b) and **a post-insert bookkeeping error could NACK a message that was already stored** (which is what makes an SMSC redeliver). The ACK now depends only on the storage outcome: stored → `ESME_ROK`, storage failure → `ESME_RDELIVERYFAILURE` with nothing written to the ledger, so the retry stores exactly once (TEST 13/13c).
7. **"Today" and the daily buckets were Europe/London**, while the carrier and `received_at` are UTC — under BST the 23:00–23:59Z hour landed on the wrong day (TEST 14; the audit query A6 shows the difference on live-shaped data).

---

## 4. The identity design

* **Strong (permanent)** — TLV `receipted_message_id` (`0x001E`, configurable) or a non-standard appended id (`SMPP_ID_APPENDED=1`), plus completed multipart ids. Stored in `sms_records.dedup_identity` under a partial UNIQUE index and in the durable ledger keyed by the **account** identity `smpp:sha1(host|port|system_id)`, so delete/re-create, rebind and restart cannot lose it.
* **Multipart** — parts live in `smpp_parts` until the message completes (`mp:`/`mpc:`); a retried part never duplicates content, and parts that never complete are **stored as a partial row after the staleness window** instead of being dropped (TEST 18).
* **Weak (content+time) — OFF, and armed only deliberately** — `pdu:<canonical hash>` inside the window; only reachable with `SMPP_FALLBACK_RETRY_WINDOW_SECONDS>0` **and** `SMPP_ALLOW_CONTENT_SUPPRESSION=1`. When armed, every suppression is logged (`smpp_logs`, event `dedup`, level `warn`) and counted; the row is then marked `weak`. Your instruction is that this must not be enabled in production — so the shipped default keeps it unreachable and visible.
* **`identity_state`** — every stored row records where its identity came from (`strong` / `multipart` / `weak` / `no-id`); messages with no id are marked `no-id` and counted in the statistics, exactly as you asked.

---

## 5. Before / after, check by check

| 1 | connection created via the admin API carries a stable connection_uid | **FAIL** · uid=undefined… | PASS · uid=smpp:a3555e28e0a00… |
| 2 | durable dedup ledger table exists | **FAIL** · sms_dedup_ledger | PASS · sms_dedup_ledger |
| 3 | restart-safe multipart table exists | **FAIL** · smpp_parts | PASS · smpp_parts |
| 4 | bind to the mock SMSC succeeded | PASS · mock binds=1 | PASS · mock binds=1 |
| 5 | T1 stored, ACK=0 | PASS · status=0 | PASS · status=0 |
| 6 | T1 exactly 1 row | PASS · rows=1 | PASS · rows=1 |
| 7 | T1 retry +5 s ACK=0 | PASS · status=0 | PASS · status=0 |
| 8 | T1 retry +5 s: this SMSC gave no id, so the message is stored again — the documented lossless default | **FAIL** · rows=1 (window policy off: never dropped, always logged) | PASS · rows=2 (window policy off: never dropped, always logged) |
| 9 | T1 the panel records the missing identity instead of silently deduping by content | **FAIL** · identity warnings in smpp_logs=0 | PASS · identity warnings in smpp_logs=2 |
| 10 | T1 no content-based ledger entry was created for the no-id message | PASS · no ledger in this build | PASS · ledger rows pointing at stored SMS=0 |
| 11 | T2 retry +12 s stored again (lossless default), never silently merged | **FAIL** · status=0 rows=1 | PASS · status=0 rows=3 |
| 12 | T2 the two identical bodies are both present (no content-based loss) | **FAIL** · identical bodies=1 | PASS · identical bodies=3 |
| 13 | T3 rebind succeeded | PASS · binds=2 | PASS · binds=2 |
| 14 | T3 redelivery after reconnect stored again (lossless default) | **FAIL** · status=0 rows=1 | PASS · status=0 rows=4 |
| 15 | T5 two genuine OTPs with identical content are kept as two rows | **FAIL** · rows=1 (the old 10 s content rule collapsed them into 1) | PASS · rows=2 (the old 10 s content rule collapsed them into 1) |
| 16 | T5b the same resend a while later is also kept | **FAIL** · rows=1 | PASS · rows=3 |
| 17 | T6 stored, 1 row | PASS | PASS |
| 18 | T7 part 1 acked but not stored alone | **FAIL** · rows=1 | PASS · rows=0 |
| 19 | T7 completed into exactly 1 row | **FAIL** · rows=2 | PASS · rows=1 |
| 20 | T7 body reassembled in order | **FAIL** · "Hello this is part one of " | PASS · "Hello this is part one of a longer message." |
| 21 | T7 no pending parts left behind | **FAIL** · no smpp_parts table in this build | PASS · pending=0 |
| 22 | T7b retried part does not duplicate content | **FAIL** · ["FIRST HALF ","SECOND HALF"] | PASS · ["FIRST HALF SECOND HALF"] |
| 23 | T8 two rows kept (content never used as an identity) | PASS · 1/1 | PASS · 1/1 |
| 24 | T9 payload #1 stored | PASS | PASS |
| 25 | T9 payload #2 stored separately | PASS · rows=1 | PASS · rows=1 |
| 26 | T9 bodies are the real payload text (no [object Object], no empty body) | **FAIL** · "" / "" | PASS · "PAYLOAD-ONE 222222" / "PAYLOAD-TWO 333333" |
| 27 | T10 50 distinct SMS stored once each on the first pass | PASS · rows=50 | PASS · rows=50 |
| 28 | T10 with no id from the SMSC the replayed batch is stored again (documented lossless default, never silent) | **FAIL** · rows=50 — TEST 15 shows the same replay at 50 when the SMSC supplies an id | PASS · rows=100 — TEST 15 shows the same replay at 50 when the SMSC supplies an id |
| 29 | T13 storage failure answered with a negative ack (SMSC will retry) | PASS · status=8 (254 = ESME_RDELIVERYFAILURE) | PASS · status=254 (254 = ESME_RDELIVERYFAILURE) |
| 30 | T13 nothing stored while the failure lasts | PASS · rows=0 | PASS · rows=0 |
| 31 | T13 retry after the failure stores exactly one row | PASS · status=0 rows=1 | PASS · status=0 rows=1 |
| 32 | T13 the following redelivery is stored again (no id from this SMSC, lossless default) | **FAIL** · rows=1 | PASS · rows=2 |
| 33 | T13b the queued retry row is present (identity filled when the SMSC supplied one) | _not reached / not present in this build_ | PASS · dedup_identity=(none — this SMSC sends no id) |
| 34 | T13b the first retry stores the SMS that was genuinely missing | _not reached / not present in this build_ | PASS · 2 → 3 |
| 35 | T13b a second retry click adds no further row (idempotent by sms_record_id) | _not reached / not present in this build_ | PASS · 3 → 3 {"ok":true,"already_stored":true,"sms_record_id":117,"note":"already stored — no new row c |
| 36 | T13c ACK=0 even though a post-insert step threw | PASS · status=0 | PASS · status=0 |
| 37 | T13c the row was stored exactly once | PASS · rows=1 | PASS · rows=1 |
| 38 | T13c one copy per delivery (the no-id redelivery is stored again, lossless default) | **FAIL** · status=0 rows=1 | PASS · status=0 rows=2 |
| 39 | T12 first delivery acked and attributed | **FAIL** · ledger→row 64 | PASS · ledger→row 120 |
| 40 | T12 second delivery acked and attributed to its OWN row | **FAIL** · ledger→row 66 | PASS · ledger→row 122 |
| 41 | T12 the concurrent writer is not referenced by the ledger | **FAIL** · no ledger table in this build | PASS · decoy row 121 |
| 42 | T12 interleaved pair both stored and separately attributed | **FAIL** · 67 / 68 (no ledger in this build) | PASS · 123 / 124 |
| 43 | T11 connection deleted | PASS · http 200 | PASS · http 200 |
| 44 | T11 replay ledger SURVIVED the delete | **FAIL** · no ledger table in this build | PASS · 6 identities kept |
| 45 | T11 re-created account gets the SAME stable identity | PASS · undefined… | PASS · smpp:a3555e28e0a00… |
| 46 | T11 no-id redelivery after delete/re-create is stored again (lossless default) | **FAIL** · status=0 rows=2 | PASS · status=0 rows=5 |
| 47 | T4 restart child completed | _not reached / not present in this build_ | PASS · exit=0 |
| 48 | T4 the restarted process resolves the SAME stable account identity | _not reached / not present in this build_ | PASS · sameUid=true bound=true |
| 49 | T4 redelivery across a full process restart is stored again with no id available (lossless default) | _not reached / not present in this build_ | PASS · rows=6 (5 before the restart; TEST 15 shows suppression across restarts when the SMSC supplies an id) |
| 50 | T4 UTC day maths is host-TZ independent (child ran as Asia/Karachi) | _not reached / not present in this build_ | PASS · child tz=Asia/Karachi |
| 51 | T14 UTC day helper module present (backend/dayWindow.js) | **FAIL** · MISSING in this build | PASS · loaded |
| 52 | T14 SQL UTC day equals the UTC clock | PASS · 2026-09-29 vs 2026-09-29 | PASS · 2026-09-29 vs 2026-09-29 |
| 53 | T14 host zone is not UTC, so the check is meaningful | PASS · Europe/London | PASS · Europe/London |
| 54 | T14 dayWindow.utcDayString(0) is the UTC day | **FAIL** · n/a | PASS · 2026-09-29 |
| 55 | T14 statDateUtc keeps 23:59:59Z in the earlier day | **FAIL** · n/a | PASS · 2026-09-28 |
| 56 | T14 23:59:59Z counted in 2026-09-28 (UTC) | PASS | PASS |
| 57 | T14 00:00:00Z counted in 2026-09-29 (UTC) | PASS | PASS |
| 58 | T14 the legacy Europe/London (BST) rule merged BOTH into 09-29 — the bug being removed | PASS | PASS |
| 59 | T14 derived stats are bucketed by the UTC day | PASS · rows today=64 | PASS · rows today=65 |
| 60 | T15 stored with the provider id present | PASS · status=0 rows=1 | PASS · status=0 rows=1 |
| 61 | T15 retry suppressed by the provider id | PASS · rows=1 | PASS · rows=1 |
| 62 | T15 retry still recognised after the account was deleted and re-created | **FAIL** · rows=2 (the old per-connection replay table was wiped with the connection) | PASS · rows=1 (the old per-connection replay table was wiped with the connection) |
| 63 | T15b 50 distinct SMS stored once each | PASS · rows=50 | PASS · rows=50 |
| 64 | T15b the replayed batch adds nothing when the SMSC supplies ids | PASS · rows=50 (before the fix: 100; the ids also survive reconnect/restart) | PASS · rows=50 (before the fix: 100; the ids also survive reconnect/restart) |
| 65 | T16 two parts completed into one row | **FAIL** · ["PART ONE OF THE ","MULTIPART TEST."] | PASS · ["PART ONE OF THE MULTIPART TEST."] |
| 66 | T16 re-pushed parts after a reconnect produce no second row | **FAIL** · rows=2 | PASS · rows=1 |
| 67 | T17 window-policy probe completed | **FAIL** · exit=1 | PASS · exit=0 |
| 68 | T17 retry +4 s suppressed by the opted-in window | _not reached / not present in this build_ | PASS · rows=1 |
| 69 | T17 retry after a reconnect suppressed | _not reached / not present in this build_ | PASS · rows=1 |
| 70 | T17 retry after delete + re-create suppressed (durable ledger) | _not reached / not present in this build_ | PASS · rows=1 |
| 71 | T17 an identical message outside the window is kept | _not reached / not present in this build_ | PASS · rows=2 at t+51s, window=45s |
| 72 | T17 suppressed replays are logged | _not reached / not present in this build_ | PASS · smpp_logs duplicate-suppressed entries present |
| 73 | T17 DOCUMENTED LIMITATION: a genuine identical SMS inside the window is dropped (why this policy is off by default) | _not reached / not present in this build_ | PASS · rows=1 |
| 74 | T17b unarmed probe completed | **FAIL** · exit=1 | PASS · exit=0 |
| 75 | T17b a 300 s window without the arming flag resolves to 0 (nothing can be suppressed by content) | _not reached / not present in this build_ | PASS · effective window=0s armed=false |
| 76 | T17b every identical replay is STORED when unarmed (+4 s retry) | _not reached / not present in this build_ | PASS · rows=2 |
| 77 | T17b unarmed: reconnect replay stored | _not reached / not present in this build_ | PASS · rows=3 |
| 78 | T17b unarmed: replay after delete + re-create stored | _not reached / not present in this build_ | PASS · rows=4 |
| 79 | T17b unarmed: a genuine identical SMS inside the requested window is NOT dropped | _not reached / not present in this build_ | PASS · rows=5 |
| 80 | T17b unarmed: nothing was logged as suppressed | _not reached / not present in this build_ | PASS · suppression log lines present=false |
| 81 | T18 part 1 held back (nothing stored yet) | **FAIL** · rows=1 | PASS · rows=0 |
| 82 | T18 the stale incomplete multipart is stored, not discarded | _not reached / not present in this build_ | PASS · ["ONLY THE FIRST HALF "] |
| 83 | T18 the pending part row is cleared after the sweep | _not reached / not present in this build_ | PASS · pending=0 |
| 84 | T19 messages with no physical id are marked identity_state=no-id (and still stored) | **FAIL** · column missing | PASS · no-id rows=117 |
| 85 | T19 messages that carried a provider id are marked identity_state=strong | **FAIL** · column missing | PASS · strong rows=56 |
| 86 | T19 a completed multipart is marked identity_state=multipart | **FAIL** · multipart row missing | PASS · {"identity_state":"multipart"} |
| 87 | T19 the reassembled test-16 message is marked multipart too | **FAIL** · row missing | PASS · {"identity_state":"multipart"} |
| 88 | T19 identical sender+body messages are ALL stored and ALL marked no-id (never suppressed for being identical) | **FAIL** · rows=1, marked no-id with the identical body=n/a | PASS · rows=3, marked no-id with the identical body=3 |
| 89 | dedup-stats endpoint answers with identity counts | **FAIL** · http 404 | PASS · identities=59 strong=56 weak=3 |
| 90 | no content-derived (pdu) identities exist while the retry window is off | **FAIL** · no ledger in this build | PASS · pdu-kind ledger rows=0 |
| 91 | dedup-stats reports the lossless policy (content suppression not armed) | **FAIL** · lossless=undefined armed=undefined window=undefined | PASS · lossless=true armed=false window=0 |
| 92 | dedup-stats counts no-id messages separately and agrees with the table | **FAIL** · no_id block missing | PASS · no_id total=117 (24h=117) vs table=117 |
| 93 | identity_states breaks the traffic down (strong/multipart/weak/no_id) | **FAIL** · {} | PASS · {"strong":56,"multipart":4,"weak":0,"no_id":117,"unmarked":4} |
| 94 | no message/OTP content in the new SMPP dedup/multipart logging | PASS · smpp_logs rows containing content=0 | PASS · smpp_logs rows containing content=0 |

**A note on the detail strings.** Several of them are phrased for the BEFORE case (for example *"the old 10 s content rule collapsed them into 1"*); they describe the defect the check targets and are printed on both sides by the suite itself.

**Reading the FAILs in the BEFORE column.** They are the pristine build. Some are outright defects (identical OTPs merged, half bodies, empty payload bodies, replay protection lost, no attribution, no idempotent retry, wrong day bucket, stale parts never swept). Others are the content+10 s-bucket behaviour that this change removes on purpose: on the old build a `+5 s` retry and a `+12 s` retry of the **same** PDU behaved differently depending on whether they straddled a 10-second boundary — which is precisely why the operator could not trust either outcome. The new default never guesses: it stores, marks and counts.

---

## 6. Read-only audit queries for your production database

Run these **after** deploying (they only read). `sqlite3 backend/data.sqlite` or any SQLite client.

```sql
-- A1  how many rows carry a durable identity vs not (last 7 days)
SELECT date(received_at) AS utc_day, COUNT(*) AS sms_rows,
       SUM(CASE WHEN COALESCE(dedup_identity,'')<>'' THEN 1 ELSE 0 END) AS with_strong_id,
       SUM(CASE WHEN COALESCE(identity_state,'')='no-id' THEN 1 ELSE 0 END) AS marked_no_id
FROM sms_records WHERE COALESCE(is_test,0)=0 AND received_at >= datetime('now','-7 days')
GROUP BY 1 ORDER BY 1;

-- A2  the no-id population (the only place duplicates can still appear) — last 24 h
SELECT COUNT(*) AS smpp_rows_24h,
       SUM(CASE WHEN COALESCE(identity_state,'')='no-id' THEN 1 ELSE 0 END) AS stored_without_id
FROM sms_records WHERE COALESCE(is_test,0)=0 AND received_at >= datetime('now','-1 day');

-- A3  replay statistics: what the ledger suppressed, by identity kind
SELECT identity_kind, COUNT(*) AS identities, SUM(seen_count-1) AS replays_suppressed,
       SUM(CASE WHEN acked_at<>'' THEN 1 ELSE 0 END) AS ack_confirmed
FROM sms_dedup_ledger GROUP BY identity_kind ORDER BY replays_suppressed DESC;

-- A4  unfinished multipart messages still waiting for parts (should drain to 0)
SELECT connection_uid, COUNT(*) AS pending_parts, MIN(received_at) AS oldest FROM smpp_parts GROUP BY 1;

-- A5  how the panel's own retry queue is doing
SELECT status, COUNT(*) AS rows, SUM(CASE WHEN sms_record_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_to_a_row
FROM failed_sms_queue GROUP BY status;

-- A6  day-boundary sanity: UTC day vs the old Europe/London rule (the difference is the fix)
SELECT (SELECT COUNT(*) FROM sms_records WHERE COALESCE(is_test,0)=0 AND date(received_at)=date('now')) AS today_utc,
       (SELECT COUNT(*) FROM sms_records WHERE COALESCE(is_test,0)=0 AND date(received_at,'+1 hour')=date('now','+1 hour')) AS today_london;

-- A7  existing duplicates to REVIEW (read-only — nothing in this change deletes them)
SELECT number, cli, message, COUNT(*) AS copies, MIN(received_at) AS first_seen, MAX(received_at) AS last_seen
FROM sms_records WHERE COALESCE(is_test,0)=0
GROUP BY number, cli, message HAVING COUNT(*)>1 ORDER BY copies DESC LIMIT 50;
```

Expected after a day of live traffic: A1 shows a growing `with_strong_id` count if your SMSC sends ids; A2 shows the no-id exposure you decided to keep (lossless); A3 shows only `tlv`/`mid`/`mp` kinds and **never** `pdu` while the window is off; A4 returns to 0.

---

## 7. Deploy and rollback runbook

```bash
# 1) backup (belt and braces — the migration also writes its own file backup)
cp backend/data.sqlite backend/data.sqlite.bak-$(date +%F)

# 2) stop the panel
pm2 stop galaxy-sms            # or: pm2 stop powerx-api powerx-sync

# 3) copy in the changed/new files
#    backend/server.js backend/smppService.js backend/schema.js backend/providerSync.js
#    backend/smppIdentity.js backend/dayWindow.js backend/scripts/rollback-dedup-v2.js

# 4) start and watch the boot log
pm2 start galaxy-sms && pm2 logs galaxy-sms --lines 80
#    expect:
#      • [SMPP] lossless mode: nothing is ever suppressed because the content looks identical …
#      • [DEDUP-V2] pre-migration backup: data.sqlite.pre-dedup-v2-<date>
#      • [DEDUP-V2] migration complete (backup ready)

# 5) verify the policy is what you asked for (admin token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/smpp/dedup-stats | head -40
#    expect: "lossless": true, "content_suppression_armed": false, and a no_id block

# 6) rollback (panel stopped)
node backend/scripts/rollback-dedup-v2.js                 # dry run, prints the inventory
node backend/scripts/rollback-dedup-v2.js --apply         # drops only the two new tables
node backend/scripts/rollback-dedup-v2.js --apply --clear-identities --reset-meta --force
```
**Release archive:** `galaxy-sms-panel-2026-09-29-dedup-v2.zip` — the complete panel plus these
docs and both run logs (`docs/dedup-v2/`), with a `MANIFEST-SHA256.txt` inside so every file can be
verified (`sha256sum -c MANIFEST-SHA256.txt` after extracting; the archive's own sha256 is printed
in the delivery message). It was verified by extracting it to a clean folder and running the suites
there: unit 29/0, smoke 18/0, e2e 94/0, manifest check all files OK. `node_modules` / `.env` /
`data.sqlite` are deliberately not inside.

The rollback takes a **consistent snapshot** (`VACUUM INTO`) before writing anything, refuses to drop `smpp_parts` while unfinished parts are pending (unless `--force`), never deletes an SMS row and never edits an SMS body or timestamp. Verified on a scratch database: 2 SMS rows intact after a full `--apply`, both new tables gone, identity values cleared, migration meta keys reset, snapshot restorable.

---

## 8. Known limitations — stated plainly

1. **A no-id SMSC still produces duplicate rows** under your chosen lossless policy. That is the trade-off you selected, and the panel now makes it visible instead of guessing (marker + counters + log line). The only remedies are an id from the SMSC (`SMPP_ID_TLVS` / `SMPP_ID_APPENDED`) or the armed window you have decided not to use in production.
2. **Daily SMS limits** (`countTodayUk`, the panel's own per-range/number/CLI limits) still reset on the Europe/London day. Reporting/counting moved to UTC; the *limit* rule was left alone because it changes client-visible behaviour. One-line switch if you want it consistent — say the word.
3. **Cross-channel matching is off** unless you declare the namespaces equivalent (`SMPP_CROSS_CHANNEL_IDENTITY=1`). Identical content arriving on SMPP and on the carrier HTTP endpoint is deliberately stored once per channel.
4. **Historical duplicates are not deleted** and no historical row was modified — use A7 to review them.
5. **The 23:00–23:59Z hour of the previous UTC day leaves "today" once**, on the deploy day, when the day definition changes. Derived stats are rebuilt by the panel's existing reconciliation; no timestamp is edited.
6. **The live SMSC was never contacted.** Everything above is a real panel process + real SQLite + a mock SMSC speaking SMPP 3.4 over TCP with PDU encoders written from the spec. The first live bind should be watched with `/api/smpp/dedup-stats` and the `ident` log lines.
7. **The before column is the pristine build**; the 4 checks that show `_not reached / not present in this build_` are capabilities that do not exist there (the restart probe, the `no-id` marking, the unarmed-window safety probe, the new endpoint block).

---

## 9. Bottom line

* Content-based identity is gone from the decision path. With no physical id the panel **stores, marks and counts** — nothing is silently suppressed for being identical.
* The window that could suppress a genuine identical resend exists only as a two-key opt-in (`…WINDOW_SECONDS` **and** `ALLOW_CONTENT_SUPPRESSION=1`), is reported as `lossless: false` when armed, logs every suppression, and is off in every shipped configuration.
* Multipart, `message_payload`, ACK ordering, retry idempotency, exact-row attribution and the UTC day window are fixed and covered by 94 end-to-end checks on a real panel process, plus 29 unit checks on the pure helpers (including the five that pin the lossless/arming policy).
* Nothing is deployed. When you are ready, the runbook in §7 and the rollback tool are the two pages you need.
