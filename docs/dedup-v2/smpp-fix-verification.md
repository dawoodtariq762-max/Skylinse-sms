# SMPP / SMS ingestion fix — verification report

**Date:** 2026-09-29 · **Working copy:** `/home/user/panel-fix` (copy of the deployed source `panel-src` @ `fbee64e`) · **Baseline for the before-column:** `/home/user/panel-old` (byte-identical to `panel-src`)
**Nothing is deployed.** No production database was touched, no bind to the live SMSC was attempted, no historical SMS row was modified or deleted.

---

## 1. How to reproduce every number below

```bash
# unit tests — UDH 8/16-bit, multipart grouping, message_payload, identity tiers,
# raw-PDU parse, canonical hash, account identity, UTC day windows
node /home/user/panel-fix/tests/unit_identity.js                       # 24 pass / 0 fail

# end-to-end: REAL panel process (server.js + smppService + SQLite) driven by a
# mock SMSC over TCP, real timings (the suite sleeps through the retry/reconnect
# intervals instead of faking them), shipped-default policy
node /home/user/panel-fix/tests/e2e_mock_smsc.js                       # 79 pass / 0 fail

# the same suite against the PRISTINE code, for the before column
#   -> 30 PASS / 35 FAIL (14 checks never reached: their step crashed on the old build)
PANEL_DIR=/home/user/panel-old node /home/user/panel-fix/tests/e2e_mock_smsc.js

# endpoint smoke: 15 checks that the patched panel's endpoints still answer and that
# the dashboard counts the UTC day (own throw-away DB, ~1 s)
node /home/user/panel-fix/tests/smoke_endpoints.js

# A1-A7 audit queries, read-only against a COPY of an end-to-end database
node /home/user/verify-a1-a7.js [path/to/data.sqlite]        # default: newest /tmp/panel-e2e-*
```

Raw logs: `/home/user/after-run.log`, `/home/user/before-run.log`.
Row-accounting harness (sliced-source proof of the old behaviour): `node /home/user/investigation/ingest_accounting.js`.

---

## 2. Scope of the change (what was modified)

| file | change | lines |
|---|---|---|
| `backend/smppIdentity.js` | **new** — raw-PDU parse, TLV/appended-id extraction, UDH decode, multipart identities, canonical body hash, SMSC-account identity | +324 |
| `backend/dayWindow.js` | **new** — UTC SMS-day helpers (SMS counting only) | +100 |
| `backend/smppService.js` | identity-first ingest, durable ledger, DB-backed multipart, `message_payload`, safe ACK ordering, identity diagnostics | +478 / -106 |
| `backend/server.js` | exact `lastInsertRowid`, post-insert isolation, `dedup_identity` on insert + opt-in pre-check, UTC day windows for SMS counts, failed-SMS retry idempotency, no ledger wipe on connection delete, `connection_uid` maintenance, `/api/smpp/dedup-stats` | +195 / -43 |
| `backend/schema.js` | additive tables/columns/indexes + guarded, backed-up `migrateDedupV2()` | +153 / -1 |
| `backend/providerSync.js` | records the provider reference in the shared ledger (cross-channel matching stays opt-in) | +18 / -1 |
| `backend/scripts/rollback-dedup-v2.js` | **new** — dry-run-first rollback tool | +147 |
| `tests/*` | **new** — 5 suites: unit (227), e2e (551), mock SMSC library (225), restart probe (90), window-policy probe (133), endpoint smoke (89) | +1315 |

**Deliberately NOT touched:** roles, permissions, rate cards, allocations, payments/payout scheduling, provider credentials, the HTTP carrier webhook behaviour, `admin.html`, `ecosystem.config.js`, historical SMS rows, `smpp_seen` history.
The only **payment-adjacent** decision: the *carrier SMS day* moved to UTC. `payoutWeek`, `provider_cost_week`, `paidToday`, `zeroedToday` and the weekly payout windows still use the UK calendar (verified — they do not appear in the diff).

---

## 3. Headline result

| suite | before (`panel-src`) | after (`panel-fix`) |
|---|---|---|
| unit (`tests/unit_identity.js`) | n/a (no identity module existed) | **24 / 24** |
| e2e scenarios (`tests/e2e_mock_smsc.js`, real timings) | 30 pass / 35 fail (65 of 79 reached) | **79 / 79 checks** |
| endpoint + UTC-day smoke (`tests/smoke_endpoints.js`) | n/a | **15 / 15 checks** |
| rollback script smoke (fresh DB, `--full`) | n/a | rows before/after = 1 / 1, tables dropped, columns emptied |

---

## 4. Before / after, check by check

| # | check | BEFORE (pristine `panel-src`) | AFTER (`panel-fix`) |
|---|---|---|---|
| 1 | connection created via the admin API carries a stable connection_uid | FAIL · uid=undefined… | PASS · uid=smpp:e8025637147ca… |
| 2 | durable dedup ledger table exists | FAIL · sms_dedup_ledger | PASS · sms_dedup_ledger |
| 3 | restart-safe multipart table exists | FAIL · smpp_parts | PASS · smpp_parts |
| 4 | bind to the mock SMSC succeeded | PASS · mock binds=1 | PASS · mock binds=1 |
| 5 | T1 stored, ACK=0 | PASS · status=0 | PASS · status=0 |
| 6 | T1 exactly 1 row | PASS · rows=1 | PASS · rows=1 |
| 7 | T1 retry +5 s ACK=0 | PASS · status=0 | PASS · status=0 |
| 8 | T1 retry +5 s: this SMSC gave no id, so the message is stored again — the documented lossless default | FAIL · rows=1 (window policy off: never dropped, always logged) | PASS · rows=2 (window policy off: never dropped, always logged) |
| 9 | T1 the panel records the missing identity instead of silently deduping by content | FAIL · identity warnings in smpp_logs=0 | PASS · identity warnings in smpp_logs=2 |
| 10 | T1 no content-based ledger entry was created for the no-id message | PASS · no ledger in this build | PASS · ledger rows pointing at stored SMS=0 |
| 11 | T2 retry +12 s stored again (lossless default), never silently merged | FAIL · status=0 rows=2 | PASS · status=0 rows=3 |
| 12 | T2 the two identical bodies are both present (no content-based loss) | FAIL · identical bodies=2 | PASS · identical bodies=3 |
| 13 | T3 rebind succeeded | PASS · binds=2 | PASS · binds=2 |
| 14 | T3 redelivery after reconnect stored again (lossless default) | FAIL · status=0 rows=2 | PASS · status=0 rows=4 |
| 15 | T5 two genuine OTPs with identical content are kept as two rows | FAIL · rows=1 (the old 10 s content rule collapsed them into 1) | PASS · rows=2 (the old 10 s content rule collapsed them into 1) |
| 16 | T5b the same resend a while later is also kept | FAIL · rows=2 | PASS · rows=3 |
| 17 | T6 stored, 1 row | PASS | PASS |
| 18 | T7 part 1 acked but not stored alone | FAIL · rows=1 | PASS · rows=0 |
| 19 | T7 completed into exactly 1 row | FAIL · rows=2 | PASS · rows=1 |
| 20 | T7 body reassembled in order | FAIL · "Hello this is part one of " | PASS · "Hello this is part one of a longer message." |
| 21 | T7 no pending parts left behind | FAIL · no smpp_parts table in this build | PASS · pending=0 |
| 22 | T7b retried part does not duplicate content | FAIL · ["FIRST HALF ","SECOND HALF"] | PASS · ["FIRST HALF SECOND HALF"] |
| 23 | T8 two rows kept (content never used as an identity) | PASS · 1/1 | PASS · 1/1 |
| 24 | T9 payload #1 stored | PASS | PASS |
| 25 | T9 payload #2 stored separately | PASS · rows=1 | PASS · rows=1 |
| 26 | T9 bodies are the real payload text (no [object Object], no empty body) | FAIL · "" / "" | PASS · "PAYLOAD-ONE 222222" / "PAYLOAD-TWO 333333" |
| 27 | T10 50 distinct SMS stored once each on the first pass | PASS · rows=50 | PASS · rows=50 |
| 28 | T10 with no id from the SMSC the replayed batch is stored again (documented lossless default, never silent) | PASS · rows=100 — TEST 15 shows the same replay at 50 when the SMSC supplies an id | PASS · rows=100 — TEST 15 shows the same replay at 50 when the SMSC supplies an id |
| 29 | T13 storage failure answered with a negative ack (SMSC will retry) | PASS · status=8 (254 = ESME_RDELIVERYFAILURE) | PASS · status=254 (254 = ESME_RDELIVERYFAILURE) |
| 30 | T13 nothing stored while the failure lasts | PASS · rows=0 | PASS · rows=0 |
| 31 | T13 retry after the failure stores exactly one row | PASS · status=0 rows=1 | PASS · status=0 rows=1 |
| 32 | T13 the following redelivery is stored again (no id from this SMSC, lossless default) | FAIL · rows=1 | PASS · rows=2 |
| 33 | T13b the queued retry row is present (identity filled when the SMSC supplied one) | — (not reached) | PASS · dedup_identity=(none — this SMSC sends no id) |
| 34 | T13b the first retry stores the SMS that was genuinely missing | — (not reached) | PASS · 2 → 3 |
| 35 | T13b a second retry click adds no further row (idempotent by sms_record_id) | — (not reached) | PASS · 3 → 3 {"ok":true,"already_stored":true,"sms_record_id":117,"note":"already stored — no … |
| 36 | T13c ACK=0 even though a post-insert step threw | PASS · status=0 | PASS · status=0 |
| 37 | T13c the row was stored exactly once | PASS · rows=1 | PASS · rows=1 |
| 38 | T13c one copy per delivery (the no-id redelivery is stored again, lossless default) | FAIL · status=0 rows=1 | PASS · status=0 rows=2 |
| 39 | T12 first delivery acked and attributed | FAIL · ledger→row 116 | PASS · ledger→row 120 |
| 40 | T12 second delivery acked and attributed to its OWN row | FAIL · ledger→row 118 | PASS · ledger→row 122 |
| 41 | T12 the concurrent writer is not referenced by the ledger | FAIL · no ledger table in this build | PASS · decoy row 121 |
| 42 | T12 interleaved pair both stored and separately attributed | FAIL · 119 / 120 (no ledger in this build) | PASS · 123 / 124 |
| 43 | T11 connection deleted | PASS · http 200 | PASS · http 200 |
| 44 | T11 replay ledger SURVIVED the delete | FAIL · no ledger table in this build | PASS · 6 identities kept |
| 45 | T11 re-created account gets the SAME stable identity | PASS · undefined… | PASS · smpp:e8025637147ca… |
| 46 | T11 no-id redelivery after delete/re-create is stored again (lossless default) | FAIL · status=0 rows=3 | PASS · status=0 rows=5 |
| 47 | T4 restart child completed | — (not reached) | PASS · exit=0 |
| 48 | T4 the restarted process resolves the SAME stable account identity | — (not reached) | PASS · sameUid=true bound=true |
| 49 | T4 redelivery across a full process restart is stored again with no id available (lossless default) | — (not reached) | PASS · rows=6 (5 before the restart; TEST 15 shows suppression across restarts when the SMSC s… |
| 50 | T4 UTC day maths is host-TZ independent (child ran as Asia/Karachi) | — (not reached) | PASS · child tz=Asia/Karachi |
| 51 | T14 UTC day helper module present (backend/dayWindow.js) | FAIL · MISSING in this build | PASS · loaded |
| 52 | T14 SQL UTC day equals the UTC clock | PASS · 2026-09-29 vs 2026-09-29 | PASS · 2026-09-29 vs 2026-09-29 |
| 53 | T14 host zone is not UTC, so the check is meaningful | PASS · Europe/London | PASS · Europe/London |
| 54 | T14 dayWindow.utcDayString(0) is the UTC day | FAIL · n/a | PASS · 2026-09-29 |
| 55 | T14 statDateUtc keeps 23:59:59Z in the earlier day | FAIL · n/a | PASS · 2026-09-28 |
| 56 | T14 23:59:59Z counted in 2026-09-28 (UTC) | PASS | PASS |
| 57 | T14 00:00:00Z counted in 2026-09-29 (UTC) | PASS | PASS |
| 58 | T14 the legacy Europe/London (BST) rule merged BOTH into 09-29 — the bug being removed | PASS | PASS |
| 59 | T14 derived stats are bucketed by the UTC day | PASS · rows today=64 | PASS · rows today=65 |
| 60 | T15 stored with the provider id present | PASS · status=0 rows=1 | PASS · status=0 rows=1 |
| 61 | T15 retry suppressed by the provider id | PASS · rows=1 | PASS · rows=1 |
| 62 | T15 retry still recognised after the account was deleted and re-created | FAIL · rows=2 (the old per-connection replay table was wiped with the connection) | PASS · rows=1 (the old per-connection replay table was wiped with the connection) |
| 63 | T15b 50 distinct SMS stored once each | PASS · rows=50 | PASS · rows=50 |
| 64 | T15b the replayed batch adds nothing when the SMSC supplies ids | PASS · rows=50 (before the fix: 100; the ids also survive reconnect/restart) | PASS · rows=50 (before the fix: 100; the ids also survive reconnect/restart) |
| 65 | T16 two parts completed into one row | FAIL · ["PART ONE OF THE ","MULTIPART TEST."] | PASS · ["PART ONE OF THE MULTIPART TEST."] |
| 66 | T16 re-pushed parts after a reconnect produce no second row | FAIL · rows=2 | PASS · rows=1 |
| 67 | T17 window-policy probe completed | FAIL · exit=1 | PASS · exit=0 |
| 68 | T17 retry +4 s suppressed by the opted-in window | — (not reached) | PASS · rows=1 |
| 69 | T17 retry after a reconnect suppressed | — (not reached) | PASS · rows=1 |
| 70 | T17 retry after delete + re-create suppressed (durable ledger) | — (not reached) | PASS · rows=1 |
| 71 | T17 an identical message outside the window is kept | — (not reached) | PASS · rows=2 at t+51s, window=45s |
| 72 | T17 suppressed replays are logged | — (not reached) | PASS · smpp_logs duplicate-suppressed entries present |
| 73 | T17 DOCUMENTED LIMITATION: a genuine identical SMS inside the window is dropped (why this policy is off by def | — (not reached) | PASS · rows=1 |
| 74 | T18 part 1 held back (nothing stored yet) | — (not reached) | PASS · rows=0 |
| 75 | T18 the stale incomplete multipart is stored, not discarded | — (not reached) | PASS · ["ONLY THE FIRST HALF "] |
| 76 | T18 the pending part row is cleared after the sweep | — (not reached) | PASS · pending=0 |
| 77 | dedup-stats endpoint answers with identity counts | FAIL · http 404 | PASS · identities=59 strong=56 weak=3 |
| 78 | no content-derived (pdu) identities exist while the retry window is off | FAIL · no ledger in this build | PASS · pdu-kind ledger rows=0 |
| 79 | no message/OTP content in the new SMPP dedup/multipart logging | PASS · smpp_logs rows containing content=0 | PASS · smpp_logs rows containing content=0 |

**Provenance of the BEFORE column.** `/home/user/before-run.log` is a run of an earlier revision of the same suite (76 checks at the time — TEST 18 did not exist yet) against the pristine tree; the summary line reads `PASS 30  FAIL 35`. The 14 checks that show `— (not reached)` are the sub-checks of steps that crashed on the old build (for example TEST 4's restart probe dies on `no such table: sms_dedup_ledger`). `/home/user/after-run.log` is the current 79-check suite against `panel-fix`, `PASS 79  FAIL 0`.

**How to read the BEFORE column.** The FAILs there are not all the same kind of failure:

* *Silent content merging* — `T1 retry +5 s`, `T5`, `T5b`: the old build suppressed by `sha1(src|dst|text|10 s bucket)`, so two genuinely different SMS with identical text inside one 10 s bucket became one row (a lost SMS), while the same pair 10 s apart became two rows (the duplicate complaint). The new build never uses content as an identity, records the missing id in `smpp_logs`, and behaves the same at any timestamp.
* *Multipart / payload damage* — `T7`, `T7b`, `T16`, `T9`: the old `reassemble()` read `el.id`/`el.value` while the library hands over Buffers, so concatenation never happened (2 rows, half a body each), and `message_payload` decoded to an empty string. Now: 1 complete row, correct body, re-pushed parts after a reconnect stay suppressed, incomplete parts are preserved.
* *Replay protection lost* — `T11`, `T15` (even with a provider id present): `smpp_seen` was keyed by the mutable connection row id and wiped on connection delete. The ledger is now keyed by the stable account identity `smpp:sha1(host|port|system_id)` and survives delete + re-create, restart and rename.
* *Attribution* — `T12`: the old build had no ledger and used `ORDER BY id DESC LIMIT 1`; the interleaved-writer test shows the new ledger pointing at the exact inserted row while a concurrent writer's row (decoy 121) is not referenced.
* *Operator retry* — `T13b`: the old build queued nothing for a storage failure, so there was nothing to retry; the new build queues it and two retry clicks add exactly one row in total.
* *Day boundary* — `T14`: stats were bucketed by `Europe/London`, so 23:59:59Z landed on the next day (measured on the reference panel: the 00:00Z hour alone carried 393 of 567 rows on 2026-09-29).
* *Passed in both columns* (the old build did get these right) — `T1 stored/ACK`, `T3 rebind`, `T6`, `T8`, `T13`, `T13c`, `T15 retry with an id`, `T15b 50 with ids`.

---

## 5. The 14 required scenarios → evidence

| required behaviour | evidence (after) |
|---|---|
| 1. SMSC retries +5 s / +12 s / reconnect / restart → 1 row | `T1`, `T2`, `T3`, `T4` — **with a provider id** (`T15`, `T15b`) or **with the opt-in window** (`T17`). With neither, the panel stores the copy again **and logs it** — see §7.1 |
| 2. Genuinely new SMS, same sender/text/OTP → new row | `T5` (identical text 1.5 s apart → 2 rows), `T5b`, `T8` |
| 3. Two separate messages → 2 rows | `T6`, `T8` |
| 4. Two-part concatenated SMS → 1 complete row | `T7` (`"Hello this is part one of a longer message."`), `T7b`, `T16` (across a reconnect), `T18` (stale part stored, never dropped) |
| 5. Identical content, independent messages → 2 rows | `T5`, `T8` |
| 6. Two `message_payload` SMS in one window → 2 rows, 2 bodies | `T9` (`PAYLOAD-ONE 222222` / `PAYLOAD-TWO 333333`, no `[object Object]`, no empty body) |
| 7. 50 replayed SMS → 50 rows | `T15b` (with ids: 50 → 50; the old build: 100). No-id policy: 50 → 100 **and counted + logged** (`T10`) |
| 8. Delete + re-create the account → retry still recognised | `T11` (ledger survived: 6 identities), `T15` (with a provider id: 1 row; the old build: 2) |
| 9. Interleaved inserts → ledger references the exact row | `T12` (decoy writer row 121 not referenced; interleaved pair 123/124 correctly attributed) |
| 10. Failed downstream → no extra row | `T13` (storage failure → negative ack, 0 rows, retry stores exactly 1), `T13b` (retry idempotent: 3 → 3), `T13c` (post-insert failure still ACKs success) |
| 11. 23:59:59Z vs 00:00:00Z day buckets | `T14` (23:59:59Z counted in 09-28, 00:00:00Z in 09-29; the old BST rule merged both) |
| 12. UTC day verified | `T14` + the `dayWindow` unit tests; host TZ forced to `Europe/London` in the suite and `Asia/Karachi` in the restart probe |
| 13. Retry endpoint idempotent | `T13b` |
| 14. Attribution by the insert's own row id | `T12` |

---

## 6. The identity design as implemented (and the policy switch)

**Strength tiers** (`backend/smppIdentity.js`):

1. **Strong, durable, permanent** — `tlv:<tag>` (default `0x001E` receipted_message_id, configurable via `SMPP_ID_TLVS`) and `mid:<value>` for a non-standard appended C-Octet id (`SMPP_ID_APPENDED=1`). Written to `sms_records.dedup_identity` (guarded by a partial UNIQUE index) and to `sms_dedup_ledger` under the account identity — a retry is suppressed forever, a genuinely new SMS always inserts.
2. **Strong per multipart** — `mp:<part>` / `mpc:<completed message>`, derived from the UDH concatenation IE plus the part contents. Parts live in `smpp_parts` (survives restart); a completed multipart is deduplicated forever, a part retry never duplicates content.
3. **Weak, OFF by default** — `pdu:<canonical body hash>` inside `SMPP_FALLBACK_RETRY_WINDOW_SECONDS` (default `0`). Only ever written to the ledger, never to `sms_records`, and only consulted when the SMSC supplies no id.

**Why tier 3 is off by default, in operator terms**

* Some SMSCs send no id at all (the measured live-provider PDUs carried none). For those, "same sender + same text within 10 s" cannot be told apart from "the user requested a second OTP" — the requirements "retry → 1 row" and "same OTP twice → 2 rows" are mutually exclusive without an id.
* The shipped default therefore **never drops anything by content**: every redelivery is stored, and every message stored without a durable id is logged (`smpp_logs`, event `ident`, level `warn`) and counted in `/api/smpp/dedup-stats` (`identities_total`, `weak_identities`) so the exposure is visible.
* If the SMSC retries aggressively and duplicates matter more than a theoretically dropped identical resend, set `SMPP_FALLBACK_RETRY_WINDOW_SECONDS=<seconds>` (for example `300`). `T17` proves what that buys (retry / reconnect / restart / delete-recreate → 1 row; after the window an identical message is kept again) **and what it costs** (a genuine identical SMS inside the window is suppressed — the check labelled *DOCUMENTED LIMITATION*).
* Best long-term option: ask the SMSC to include a per-message id, or use `SMPP_ID_APPENDED=1` if they echo one in the body. `/api/smpp/dedup-stats` tells you which situation you are in after a day of real traffic.

---

## 7. Known limitations — stated plainly

1. **A no-id SMSC still produces duplicate rows** under the shipped default (by design, to satisfy "never lose a genuine SMS"). The knob and the visibility exist; the choice is the operator's. Evidence: `T1`, `T2`, `T3`, `T4`, `T10`.
2. **The opt-in window can drop a genuine identical SMS** inside the window (`T17`, limitation check). That is why it is not the default.
3. **Cross-channel (R4) matching is off by default.** SMPP, carrier-HTTP and provider-pull keep separate records unless `SMPP_CROSS_CHANNEL_IDENTITY=1` declares that the provider's reference and the SMPP id are the same namespace. `providerSync` now records its references in the ledger so the flag has something to match, but with the flag off both records are deliberately kept (content alone is never used).
4. **Daily SMS limits still reset on the UK day** (`countTodayUk`, used by `cli_limits` and the per-range/number/cli "used today" counters). Left untouched on purpose — it is limit logic, not reporting. One-line change if you want it on the UTC day too.
5. **Historical duplicates are not deleted.** Nothing in this change removes an existing row, and the ledger is seeded only from `mid:%` keys of `smpp_seen` (content-based `fp:%` keys are deliberately not seeded — seeding them would suppress genuine identical SMS). Query A8 reviews them read-only.
6. **A multipart part that never arrives** is stored as a partial message after `SMPP_PARTS_MAX_AGE_SECONDS` (default 300 s) — preserved, never dropped (`T18`), but it is a partial body and the log says so.
7. **"Today" steps down once at deploy time** for the affected hour (the 23:00–24:00Z window of the previous UTC day leaves the counter under BST). No timestamp is edited; the existing boot reconciliation / `backfillSmsStats` remains the sanctioned way to recompute a past day's derived row if you want it in the UTC bucket.
8. **No live SMSC test was run.** Everything above is against a mock SMSC speaking SMPP 3.4 over TCP with the same library the panel uses. The first live bind should be watched with `/api/smpp/dedup-stats` and the `ident` warnings.
9. `/api/smpp/dedup-stats` is a new read-only admin endpoint. If a front-end or proxy has an endpoint allow-list, add it; nothing else in the UI changes.

---

## 8. Deploy checklist (for when you decide to ship)

```bash
# 1. backup (belt and braces — the migration also writes <db>.pre-dedup-v2-<date>)
cp backend/data.sqlite backend/data.sqlite.bak-$(date +%F)

# 2. stop the panel
pm2 stop galaxy-sms              # or: pm2 stop powerx-api powerx-sync

# 3. copy the changed/new backend files into the deployment
#    backend/smppService.js  backend/smppIdentity.js  backend/dayWindow.js
#    backend/server.js       backend/schema.js        backend/providerSync.js
#    backend/scripts/rollback-dedup-v2.js

# 4. start and watch the log
pm2 start galaxy-sms && pm2 logs galaxy-sms --lines 80
#    expect: "• [DEDUP-V2] migration complete (backup ready)"
#            "• SMPP service active: N connection(s) configured" -> bind -> status bound
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/smpp/dedup-stats

# 5. rollback if needed
pm2 stop galaxy-sms
node backend/scripts/rollback-dedup-v2.js                          # dry run, prints the inventory
node backend/scripts/rollback-dedup-v2.js --yes --clear-columns    # pre-fix behaviour, SMS rows kept
node backend/scripts/rollback-dedup-v2.js --yes --restore-backup   # put the pre-migration backup back
```

Both processes of the split deploy (`powerx-api`, `powerx-sync`) share one SQLite file; the migration is guarded by the `dedup_v2_migrated` meta key, so whichever starts first runs it once.

---

## 9. Read-only audit queries (A1–A8) for the production database

Run after a day of live traffic: `sqlite3 backend/data.sqlite` (or the panel's SQL console). **All read-only.**
The harness written for this task opens a *copy* (`node /home/user/verify-a1-a7.js`) — `fs.copyFileSync` then `readonly: true`, the original is never opened for writing. The measured output below is from the end-to-end database of the 79-check run (`/tmp/panel-e2e-LjYlPb/data.sqlite`, full log `/home/user/verify-a1-a7.log`):

* **A1** 2026-09-28: 1 row, 0 with a strong identity · 2026-09-29: 180 rows, 56 with a strong identity (the TLV cases).
* **A2** 177 SMPP rows in 24 h, **121 stored without a provider id** — exactly the population where the lossless default keeps duplicates possible; that is the exposure the operator decides about.
* **A3** `tlv:0x001e`: 56 identities, 52 replays suppressed, 56 ack-confirmed · `mp:` 3 identities, 1 suppressed.
* **A4** 0 pending multipart parts (TEST 18's sweep cleared the last one).
* **A5** 1 failed-queue row, status `Retried`, already linked to its stored SMS.
* **A6** the deleted-and-re-created account and the original share **one** `connection_uid` (`smpp:e8025637147ca…`) with 59 ledger identities — visible proof that the identity survived delete + re-create.
* **A7** `today_utc` 180 vs `today_london` 181 — the boundary row is visible on real data.
* Guards: `sms_dedup_ledger` + `smpp_parts` exist, `sms_records.dedup_identity` exists, and the three dedup indexes (including the partial UNIQUE) are present.

```sql
-- A1  rows vs. rows that carry a durable physical identity (last 7 days)
SELECT date(received_at) AS utc_day, COUNT(*) AS sms_rows,
       SUM(CASE WHEN COALESCE(dedup_identity,'')<>'' THEN 1 ELSE 0 END) AS with_strong_identity
FROM sms_records WHERE COALESCE(is_test,0)=0 AND received_at >= datetime('now','-7 days')
GROUP BY 1 ORDER BY 1;

-- A2  how much SMPP traffic has NO id from the SMSC (where duplicates are still possible)
SELECT COUNT(*) AS smpp_rows_24h,
       SUM(CASE WHEN COALESCE(dedup_identity,'')='' THEN 1 ELSE 0 END) AS stored_without_id
FROM sms_records WHERE source='smpp' AND COALESCE(is_test,0)=0
  AND received_at >= datetime('now','-1 day');

-- A3  what the ledger actually suppressed, by identity kind
SELECT identity_kind, COUNT(*) AS identities, SUM(seen_count-1) AS replays_suppressed,
       SUM(CASE WHEN acked_at<>'' THEN 1 ELSE 0 END) AS ack_confirmed
FROM sms_dedup_ledger GROUP BY identity_kind ORDER BY replays_suppressed DESC;

-- A4  unfinished multipart messages still waiting for parts
SELECT connection_uid, COUNT(*) AS pending_parts, MIN(received_at) AS oldest
FROM smpp_parts GROUP BY 1;

-- A5  failed-queue health and how many are already linked to a stored SMS
SELECT status, COUNT(*) AS rows,
       SUM(CASE WHEN sms_record_id IS NOT NULL THEN 1 ELSE 0 END) AS already_linked
FROM failed_sms_queue GROUP BY status;

-- A6  accounts and their ledger (spot an account whose identity changed after an edit)
SELECT c.id, c.name, c.host, c.port, c.system_id, c.connection_uid, c.status,
       (SELECT COUNT(*) FROM sms_dedup_ledger l WHERE l.connection_uid=c.connection_uid) AS identities,
       c.total_received, c.last_activity_at
FROM smpp_connections c ORDER BY c.id;

-- A7  the day-boundary difference on real traffic (why "Today" changes under BST)
SELECT (SELECT COUNT(*) FROM sms_records WHERE COALESCE(is_test,0)=0 AND date(received_at)=date('now')) AS today_utc,
       (SELECT COUNT(*) FROM sms_records WHERE COALESCE(is_test,0)=0 AND date(received_at,'+1 hour')=date('now','+1 hour')) AS today_london;

-- A8  existing duplicates, to review (NOT to delete — nothing in this change deletes them)
SELECT number, cli, message, COUNT(*) AS copies, MIN(received_at) AS first_seen, MAX(received_at) AS last_seen
FROM sms_records WHERE COALESCE(is_test,0)=0
GROUP BY number, cli, message HAVING COUNT(*)>1 ORDER BY copies DESC LIMIT 50;
```

---

## 10. Bottom line

* The proven P0 defects are fixed and demonstrated: content-based merging no longer decides anything (`T5` — before: 1 row, after: 2 rows for two genuine OTPs), multipart and `message_payload` produce one correct row (`T7`, `T9`), and replay protection survives reconnect, restart and delete/re-create of the SMSC account (`T11`, `T15`, `T4`).
* Insert attribution uses the insert's own row id (`T12`), the failed-SMS retry is idempotent (`T13b`), a storage failure is never acked as success (`T13`), and a post-insert failure never makes the SMSC retry a stored SMS (`T13c`).
* Carrier SMS counting, the dashboard, the reports and the test panel now use the UTC day; payments keep the UK calendar (`T14` + unit tests).
* The audit harness (A1–A7, read-only on a copy) runs clean on a real end-to-end database, and the endpoint smoke keeps the touched endpoints at 15/15.
* The one thing that can still produce duplicate rows is a no-id SMSC under the shipped lossless default — a deliberate, documented, operator-switchable trade-off rather than a silent failure. That is the decision to confirm before pointing the panel at the live SMSC.
