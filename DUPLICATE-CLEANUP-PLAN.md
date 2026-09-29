# Historical SMS Duplicate Cleanup — Investigation, Tool & Verified Plan

**Date:** 2026-09-29 · **Principle:** delete ONLY provable duplicates of the same physical SMS. Identical content alone is never proof.
**Deliverable:** `tools/dup-cleanup.js` — standalone, **read-only by default**, archive-first, reversible. Validated end-to-end on a synthetic production-like DB (this workspace has no production `data.sqlite`; the git repo doesn't contain one — you run the same commands on the server).

---

## Step 2 — What historical data can actually prove "same physical SMS"? (inspected from the real schema)

| Historical field | Where | Proof value |
|---|---|---|
| `provider_message_id` | `api_integration_logs`, `api_integration_seen` | ✅ **PROOF** — provider-unique per physical message |
| dedup ledger key → `sms_record_id` | `smpp_seen` (`mid:`/`fp:`), `api_integration_seen` (`cb:`) | ✅ links keeper rows to keys; only ONE row per key (dropped dups leave no trace) |
| `source` | `sms_records` | channel (`smpp`/`carrier`/`api_integration`/`api_sync`) — needed for cross-channel matching |
| `received_at` (1s, UTC) | `sms_records` | timing-pattern inference only — **never proof alone** |
| `number + cli + message` | `sms_records` | grouping key ONLY — legit SMS can be identical (per your warning) |
| SMPP connection id / sequence / UDH ref | — | ❌ **not persisted historically** — cannot be recovered |
| `payment_ledger.sms_record_id` (UNIQUE) | financial | ⚠️ a duplicate that got PAID — excludes it from deletion (finance decides) |
| `sharing_forward_logs.sms_record_id` | forwarding | dependency to re-link, not evidence |

**Bottom line:** historical messages ingested via SMPP carry *no* persisted physical id (the old code never stored it), so the only provable (category A) duplicates are those tied to a **provider message id** in the API-integration tables — everything else with identical content is inference and lands in **B (ask-first)** or **C (never)**.

## Classification rules implemented (exactly per your spec)

- **A1 confirmed:** ≥2 stored `sms_records` rows tied to the same provider message id (cross-integration double-store / ledger-race retry).
- **A2 confirmed:** provider id + identical (number,cli,message) logged for one stored row **and** a twin from a *different* channel within ±3s (cross-channel double-ingest of that same provider message).
- **B probable:** identical content, **same channel**, and inter-arrival Δ=0s (reconnect double-fire) or 10s<Δ≤300s (outlived the old window at a carrier-retry cadence). **Never auto-deleted** — listed with exact ids and deltas.
- **C possibly legitimate:** identical content Δ>300s or mixed channels. **Never deleted.**
- **D:** everything else.
- **Trap-aware:** quick identical twins (e.g. `OTP 123456` 45s apart) classify as B — *shown, but you choose each id explicitly* — because a genuine resend looks byte-identical to a redelivery.

## Verified demo (synthetic DB with every historical pattern)

```
22 rows → dry-run: A=3 groups, B=5 (incl. the OTP-123456 trap pair), C=2
STEP 5 plan : DELETE #2 (Δ3s, PX-991), #4 (Δ2s, PX-772, re-link api_seen→#3);
              #14 (PX-FIN) EXCLUDED — payment_ledger exists → FINANCE-REVIEW
--apply     : 2 archived+deleted; validation: before 22 → after 20
--delete-ids 16 (operator-chosen B): archived+deleted, sharing_forward_logs AND smpp_seen re-linked to keeper #15
restore     : 3/3 rows back from archive (+ restore-<session>.js) → 22 rows again
untouched   : C twins (09:00 vs 09:32 identical "OTP 123456"), mixed-channel pair, ALL B rows until chosen
```

## Run on your production server (runbook)

```bash
cd /path/to/Skyline-Sms                 # provides node_modules/better-sqlite3
# recommended: stop the panel (or run in a quiet window) — WAL allows live reads,
# but --apply should not race active writes
# 1. REPORT ONLY (nothing modified):
node tools/dup-cleanup.js --db backend/data.sqlite
# 2. REPORT + verified backup:
node tools/dup-cleanup.js --db backend/data.sqlite --backup
#    ->  <db>.dupcleanup-<ts>.bak/ (verified byte/readable copy, counts compared)
# 3. REVIEW the printed groups: every candidate shows id, number, cli, message,
#    received_at, source, provider id, channel, Δt. NOTHING deleted yet.
# 4. Apply category A only (asks YES):
node tools/dup-cleanup.js --db backend/data.sqlite --apply
# 5. Delete SPECIFIC B rows you reviewed (your explicit id list):
node tools/dup-cleanup.js --db backend/data.sqlite --delete-ids "201,487,902"
# 6. Re-run step 1 to validate (step 8 prints before/after counts automatically).
```

Safety properties (all verified above):
- **Backup before any modification**, verified readable with matching row count; else abort.
- **Keeper = earliest stored copy**; only later copies deleted; keeper row never modified.
- **Finance guard:** candidates referenced by `payment_ledger` are excluded mid-transaction (belt & braces re-check) and reported as FINANCE-REVIEW (money already paid on them).
- **Dependencies:** `sharing_forward_logs`, `smpp_seen`, `api_integration_seen` are re-linked to the keeper; `api_integration_logs` left as audit history (logs may reference archived ids intentionally).
- **Reversible:** every deleted row is first archived to `sms_records_deleted_history` (full row + classification + evidence + keeper + session) **and** exported as JSON + a working `restore-<session>.js`.
- **Transactional:** any failure rolls back — no partial deletions.
- B deletion requires an explicit operator id list — there is no flag that bulk-deletes category B, by design.

## Expected outcome on your real DB

Most 10s-bug SMPP dupes will classify **B** (timing-shaped, no persisted provider id) — the historical data genuinely cannot *prove* them, so the tool won't pretend. A deletions clean up everything provable; B is a reviewed, per-id decision with full evidence printed per group. Legit identical SMS (C) stay untouched regardless of flags.
