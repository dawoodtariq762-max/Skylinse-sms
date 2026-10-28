# Skyline SMS — Post-Rebrand Repair

**Repo analysed:** `github.com/dawoodtariq762-max/Skylinse-sms` — 274 files, HEAD `3dfeae3`
**Date:** 2026-10-28

---

## 0. Status and honesty statement

Read this first, so nothing is overclaimed:

- I have **no access to your VPS**. I did **not** inspect the live server, its database, its logs, or its running processes. Everything below is derived from the **repository source code** plus **tests I ran locally against synthetic databases**.
- **No data was lost**, and nothing here assumes it was. No database was reset, recreated or overwritten. No provider, number range or SMPP connection was recreated.
- The GitHub repository has **not** been modified or pushed by me. The files in this package are for you to review and deploy.
- Anywhere I could not confirm something from code, it is marked **[UNVERIFIED]** or **[NEEDS YOUR CONFIRMATION]**.

---

## 1. Root causes

### 1.1 Rebrand regression: `POWERX_ROLE` removed — **CONFIRMED from git**

Confidence: **Certain.** Proven by the commit diff.

The rebrand commit `3dfeae3` renamed the process-split environment variable to `SKYLINE_ROLE` but dropped the old name from the read chain:

```js
// backend/server.js, as of 3dfeae3
const AMS_ROLE = (process.env.SKYLINE_ROLE || process.env.AMS_ROLE || process.env.ALMADA_ROLE || 'all').toLowerCase();
```

But `deploy/ecosystem.config.cjs` still starts the two PM2 processes with the **old** variable:

| PM2 process | env | memory cap |
|---|---|---|
| `powerx-api` | `POWERX_ROLE: 'api'` | 1500M |
| `powerx-sync` | `POWERX_ROLE: 'sync'` | 800M |

`grep -rn 'POWERX_ROLE' backend/` returns **no matches** — the backend no longer reads it at all.

**Consequence:** both processes fall through to `'all'`. The role guard that is supposed to split them (documented in the code at `server.js:7146-7150`) becomes unreachable, so on the VPS:

1. **Both** processes call `app.listen(PORT)` → `EADDRINUSE` → crash loop (PM2 `max_restarts:10`).
2. **Both** call `smppService.start()` → double bind on the SMPP port, doubled `total_received` counters, duplicate inbound handling.
3. **Both** start every timer — the 12 s provider sync, the retention sweep, the backup job, and the 5 s API poller.
4. `powerx-sync` is capped at **800 MB** but is running a full web stack → repeated OOM restarts.

**Fix:** `POWERX_ROLE` restored as a legacy fallback in the read chain.

### 1.2 The Management Panel blocks the entire server — **CONFIRMED from code, measured locally**

Confidence: **High** that this is a real and serious defect. Whether it is *the* sole cause of your full outage needs one log check (§8) — but it is the only code path found that can stall **every** request on the server from the Management Panel.

`GET /api/providers-info` (`backend/server.js:6183`) runs, **for every provider**, a loop containing roughly twelve queries — of which **six** are aggregations over `sms_records`:

```js
const sumRange = (sel, extra="", params=[]) => db.get(
  `SELECT COALESCE(SUM(CAST(s.payout_amount AS REAL)),0) p
     FROM sms_records s JOIN ranges r ON r.id=s.range_id
    WHERE r.provider_id=? ${extra}`, [sel, ...params])?.p || 0;
```

Two compounding problems:

1. **Six separate scans** per provider (lifetime, week, previous week, month, previous month, previous 3 months) — where **one** pass would do.
2. Every one wraps the indexed column in `strftime()` — `strftime('%Y-%m-%d', s.received_at) BETWEEN ? AND ?` and `strftime('%Y-%m', s.received_at) = ?`. This is **non-sargable**: SQLite cannot use `idx_sms_range_date`, so each of the six queries degenerates into a **full table scan** of `sms_records`.

**Why this takes the whole app down:** `backend/db.js` uses **better-sqlite3, which is synchronous**. Every `db.get()` blocks the Node event loop for its full duration — not just this request, but **every** request on the server. With a large `sms_records` table and several providers, one page load can block the event loop for seconds.

That produces exactly your reported symptom, and explains the two "missing data" symptoms as **collateral**:

- The Management Panel opens → Providers page → the event loop is blocked for seconds.
- `/api/smpp/connections` is queued behind it, so the SMPP section renders empty.
- `POST /api/providers-info` is queued behind it too, so creating a provider appears to fail.
- Close the tab → no new requests are issued → the queue drains → the app recovers.

**Fix:** one pass with conditional `SUM`s and sargable half-open date bounds, plus a covering index. Results are **identical** (verified — §4).

> Note: `git log -S "payout_prev_3m"` shows this code came from the **initial commit** `5f6f018`, **not** from the rebrand. It is a pre-existing latent defect that grew into an outage as `sms_records` grew.

### 1.3 SMPP connection "T- SMS" not listed — code is **correct**

Confidence in the code: **High**. Confidence in the cause: **Medium** (starvation, §1.2).

I traced the full path and found **no defect** in it:

- `management.html:3155 loadSmpp()` → `API.get('/smpp/connections')` + `/api/smpp/status`
- `server.js:720` → `smppService.listConnections().map(smppPublic)`
- `smppService.js:119` → `SELECT * FROM smpp_connections ORDER BY id ASC` (with `activeOnly=false`, so **no** active filter)
- `smppPublic()` only strips `password` and adds `has_password`

There is no status filter, no permission filter, no provider join, and no name-based filter that could hide a row. **If the row exists in the database the app is reading, this endpoint returns it.**

So the empty section is either (a) the request being starved by §1.2 — the most likely explanation, since it is the same blocked event loop — or (b) the row living in a different database file than the running process opens **[NEEDS YOUR CONFIRMATION — see §8B/C]**.

I have **not** changed the SMPP connection, its config, its credentials, or the table. Nothing here resets or duplicates it.

### 1.4 Providers not listed / creation fails — code is **correct**

Same conclusion. `GET /api/providers-info` reads `SELECT * FROM ams_providers ORDER BY name COLLATE NOCASE` with no filter. `POST /api/providers-info` inserts `(name, conn_type, payment_term, currency, status, notes)`, and the frontend (`management.html:2535 saveProvider()`) sends exactly those fields. No defect found in either.

Both symptoms are consistent with the event-loop starvation in §1.2, which the fix removes.

### 1.5 Number ranges need a provider — **CONFIRMED from `schema.js`**

Confidence: **Certain.**

`ranges.provider_id` is the authoritative link (`backend/schema.js:947-974`). The boot-time backfill links a range to a provider **only** when the stored free-text matches a provider name **exactly**:

```sql
UPDATE ranges SET provider_id = (
   SELECT gp.id FROM ams_providers gp
    WHERE LOWER(TRIM(gp.name)) = LOWER(TRIM(ranges.provider)) LIMIT 1)
 WHERE provider_id IS NULL AND COALESCE(TRIM(provider),'') <> ''
```

`LOWER(TRIM('T-SMS'))` never equals `LOWER(TRIM('T- SMS'))` — the space defeats it. So a range whose text is `T-SMS`, or blank, or any variant, keeps `provider_id = NULL`: it appears under no provider and fails the newer validation on edit. **This is the mismatch you described**, and it is a formatting gap, not data loss.

The repair script (§5) closes that gap.

---

## 2. Files changed — exact repo-relative paths

| # | Repo path | Status | Change |
|---|---|---|---|
| 1 | `backend/server.js` | modified | (a) `POWERX_ROLE` restored as legacy fallback (~line 7150); (b) `/api/providers-info` aggregation rewritten to one indexed pass (line ~6183) |
| 2 | `backend/schema.js` | modified | Added covering index `idx_sms_range_date_payout` (after `idx_sms_range_date`, ~line 713) |
| 3 | `deploy/ecosystem.config.cjs` | modified | Both PM2 apps now set `SKYLINE_ROLE` **and** keep `POWERX_ROLE` |
| 4 | `scripts/repair-link-ranges-to-provider.js` | **NEW** | Idempotent, dry-run-by-default range→provider repair |

Total: `3 files changed, 57 insertions(+), 12 deletions(-)` plus one new 234-line script.

Also included: `skyline-repair.patch` — a ready-to-apply `git diff` of the three modified files.

---

## 3. The fixes in detail

### 3.1 `backend/server.js` — `POWERX_ROLE` (crash root cause)

```js
const AMS_ROLE = (process.env.SKYLINE_ROLE || process.env.AMS_ROLE
               || process.env.ALMADA_ROLE || process.env.POWERX_ROLE || 'all').toLowerCase();
```

Zero-risk: it only adds a fallback that is consulted when the newer variables are unset. It makes your existing `ecosystem.config.cjs` work again **without** you having to edit anything on the VPS.

### 3.2 `backend/server.js` — `/api/providers-info` (event-loop blocking)

Six `strftime`-wrapped scans collapsed into one indexed pass:

```sql
SELECT COUNT(*) AS msgs,
  COALESCE(SUM(CAST(COALESCE(s.payout_amount,'0') AS REAL)),0) AS lifetime,
  COALESCE(SUM(CASE WHEN s.received_at >= ? AND s.received_at <  ? THEN ... END),0) AS wk,
  COALESCE(SUM(CASE WHEN s.received_at >= ? AND s.received_at <  ? THEN ... END),0) AS pw,
  COALESCE(SUM(CASE WHEN s.received_at >= ? AND s.received_at <  ? THEN ... END),0) AS mm,
  COALESCE(SUM(CASE WHEN s.received_at >= ? AND s.received_at <  ? THEN ... END),0) AS pm,
  COALESCE(SUM(CASE WHEN s.received_at >= ? AND NOT (s.received_at >= ? AND s.received_at < ?) THEN ... END),0) AS p3
 FROM sms_records s JOIN ranges r ON r.id = s.range_id
WHERE r.provider_id = ?
```

The date bounds are half-open (`>= start AND < next_start`) so no row is counted twice or dropped, and the raw `received_at` column is compared directly so the index can be used. Nothing else in the handler changed — same fields, same output shape, same semantics.

### 3.3 `backend/schema.js` — covering index

```js
db.run(`CREATE INDEX IF NOT EXISTS idx_sms_range_date_payout
          ON sms_records(range_id, received_at, payout_amount)`);
```

`CREATE INDEX IF NOT EXISTS` — additive, created on next boot, no migration step.

### 3.4 `deploy/ecosystem.config.cjs`

```js
env: { SKYLINE_ROLE: 'api',  POWERX_ROLE: 'api'  }   // powerx-api
env: { SKYLINE_ROLE: 'sync', POWERX_ROLE: 'sync' }   // powerx-sync
```

Both names are set so the file works with either a pre-fix or post-fix build.

---

## 4. Tests actually performed

All of the following were **run locally, against synthetic databases I built for the purpose**. None were run against your VPS or your real data.

### 4.1 Query equivalence — new query vs old query

Built a database with 2 providers, 8 ranges and 5,040 `sms_records` spread over 2026-06-01 → 2026-10-28, then computed every aggregate both ways:

| Field | Old | New | |
|---|---|---|---|
| msgs | 3780.000000 | 3780.000000 | MATCH |
| lifetime | 2877.888100 | 2877.888100 | MATCH |
| week | 66.115300 | 66.115300 | MATCH |
| prev week | 164.340500 | 164.340500 | MATCH |
| month | 574.142300 | 574.142300 | MATCH |
| prev month | 562.457500 | 562.457500 | MATCH |
| prev 3m | 1715.547500 | 1715.547500 | MATCH |

Repeated for the second provider — **all 14 values identical**. **Result: `ALL VALUES IDENTICAL`.**

### 4.2 Performance at 600,000 rows

| Scenario | Old | New | Speedup |
|---|---|---|---|
| 1 provider, before index | 381.7 ms | 178.9 ms | 2.1x |
| 1 provider, after index | 188.6 ms | **43.6 ms** | **4.3x** |
| 4 providers (realistic panel load), after index | **777 ms** | **175 ms** | **4.4x** |

Values were byte-identical before and after adding the index (`values unchanged by index: true`).

**Interpretation, stated honestly:** 777 ms of blocked event loop is serious but would not by itself take a server down for good. On your production volume — which is larger, and with more providers — the blocking scales with the size of `sms_records` multiplied by the number of providers, and `loadProviders()` re-runs on **every** provider add/edit/delete/payment and on every navigation to the page, so clicks stack. Confirming the exact magnitude on your box is one command (§8A).

### 4.3 Syntax checks

`node --check` passed on `backend/server.js`, `backend/schema.js`, `deploy/ecosystem.config.cjs` and the repair script.

### 4.4 Repair script — full behavioural test

Built a database with 8 ranges covering every case:

| Range | text | provider_id before | Expected |
|---|---|---|---|
| 1 Range A | `T-SMS` | NULL | → T- SMS (normalised match) |
| 2 Range B | `T- SMS` | NULL | → T- SMS |
| 3 Range C | *(blank)* | NULL | → T- SMS (target) |
| 4 Range D | `Unknown Co` | NULL | → T- SMS (target) |
| 5 Range E | `Acme` | **2 (valid)** | **untouched** |
| 6 Range F | `T-SMS` | **1 (valid)** | **untouched** |
| 7 Range G | `Ghost` | **999 (dangling)** | → T- SMS |
| 8 Range H | `T-SMS` | NULL | **skipped** (soft-deleted) |

Results:

- **Dry run** printed the full plan and reported `Needing repair: 5`. Verified by re-querying: **zero rows changed**.
- Soft-deleted range 8 correctly excluded (7 in scope, not 8).
- **`--apply`** updated exactly 5 rows. Verified after: ranges 1,2,3,4,7 → `provider_id = 1`; range 5 → still `2`; range 6 → still `1`; range 8 → still `NULL`.
- **`ranges.provider` text unchanged** on every row (`T-SMS` is still `T-SMS`), and **`rate` unchanged** on every row.
- **Idempotency:** re-running reports `Already correctly linked: 7`, `Needing repair: 0`, `Nothing to do`.
- A timestamped JSON backup of the previous `provider_id` values was written before applying.

This test also caught a genuine bug in my first version (an alias mismatch in the count query), which I fixed.

### 4.5 What was **not** tested

- Nothing was tested against your VPS, your real database, or your real SMPP connection.
- The SMPP listing, provider listing and provider creation **endpoints were not exercised against live data** — I verified them by code reading only, and found no defect.
- No browser test of the Management Panel was run.
- The `POWERX_ROLE` fix was verified by reading the diff and by syntax check; it was **not** run under PM2.

---

## 5. DB repair script — ranges → provider

`scripts/repair-link-ranges-to-provider.js`

### What it does

For ranges whose `provider_id` is **NULL or points at a provider that no longer exists** — and only those:

- **Phase A** — if the stored provider text matches an existing provider after normalisation (case- and punctuation/space-insensitive, so `T-SMS` → `T- SMS`), link to **that** provider.
- **Phase B** — otherwise link to the target provider (default `T- SMS`).

### What it never does

- Never touches ranges that already have a **valid** `provider_id`.
- Never modifies `ranges.provider` (the informational reference text).
- Never modifies range IDs, names, numbers, rates, allocations or ownership.
- Never touches `ams_providers`, financial values, or SMPP connections.
- Never deletes anything.

### Safeguards

- **Dry run is the default.** Running it with no flags changes nothing — it only prints the plan. This satisfies "inspect, show me the proposed changes, then get approval".
- Writes require an explicit `--apply`.
- Every UPDATE is guarded so it can only ever affect a row that is *still* broken:
  ```sql
  WHERE id = ? AND (provider_id IS NULL
                    OR provider_id NOT IN (SELECT id FROM ams_providers))
  ```
  → **idempotent**: a second run updates 0 rows (verified).
- Opens the database **read-only** unless `--apply` is given.
- Before writing, saves the previous `provider_id` of every affected row to
  `scripts/range-provider-repair-backup-<timestamp>.json`.
- Aborts safely if the target provider does not exist, listing the providers that do.

### Commands

```bash
cd /path/to/Skylinse-sms

# 1. INSPECT — dry run, changes nothing. Review the output.
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS"

# If you need to point at a specific database file:
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS" --db=/path/to/data.sqlite

# 2. APPLY — only after you have reviewed and approved the printed list
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS" --apply

# 3. VERIFY — should report "Needing repair: 0"
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS"
```

Options: `--provider="Name"` (default `T- SMS`), `--db=PATH`, `--apply`, `--include-deleted` (soft-deleted ranges are skipped by default), `--help`.

It needs `better-sqlite3`, which is already a dependency of the backend — run it from the project root on the VPS.

> **Take a database backup before step 2.** You already have backups; this is a belt-and-braces reminder, not a sign the script is risky.

---

## 6. GitHub cleanup candidates

**Nothing was deleted.** Nothing should be deleted until you have a tag or branch to restore from.

First, create a safety marker so nothing is ever truly lost:

```bash
git tag backup-before-cleanup-2026-10-28 && git push origin backup-before-cleanup-2026-10-28
```

### 6.1 Safe-removal candidates — verified unreferenced by the app

I grepped every `.html` page and every `backend/*.js` file. **No HTML page and no backend file loads any of these assets.** (Two apparent hits were false positives: a placeholder URL `…/lamix/viewstats` in `management.html:1070`, and my own new comment in `server.js`.)

`assets/galaxy-appicon.png`, `galaxy-favicon.png`, `galaxy-icon.png`, `galaxy-logo.png`, `galaxy-light.css`, `galaxy-rebrand.css`, `galaxy.css`, `galaxy.js`, `lamix-light.css`, `powerx-favicon.png`, `powerx-login.css`, `powerx-logo-192.png`, `powerx-logo.png`, `powerx-theme.css`

**Caveat you must respect:** `galaxy.css` and `galaxy.js` **are** referenced by scripts under `tests/` (`verify-all-30-points.js`, `p19j-verify.js`, `p19k-verify.js`, `verify-sections-31-to-55.js`, `verify-production-fixes.js`, and others). Deleting those two assets will break those verification scripts. Either leave `galaxy.css`/`galaxy.js` in place, or delete the obsolete `tests/` scripts at the same time.

Also `.sudo_as_admin_successful` — a stray root-marker file in the repo root, no purpose.

**How to delete one file on GitHub:** navigate to the file → click the **pencil** (Edit) → the **three-dot** menu (⋯) in the editor header → **Delete file** → add a commit message → **Commit changes**.

**From the command line:**
```bash
git rm assets/galaxy-logo.png
git commit -m "Remove unused legacy-brand asset"
git push
```

### 6.2 Needs further verification — do **not** delete yet

`scripts/powerx-diskguard.sh`, `scripts/powerx-watchdog.sh`, `bench-*.js`, `capture-*`, `diagnose-responsive.js`, `rebuild-readme.py`, `panel-audit.py`, `bench-toolkit/`, `tools/`

These may be wired into cron jobs, PM2 or operational runbooks on the VPS. Check `crontab -l`, `/etc/cron.d/`, and `pm2 list` before removing any of them.

### 6.3 Must preserve — never delete

- `backend/data.sqlite`, `backend/data.sqlite-wal`, `backend/data.sqlite-shm`, and everything under `data/`
- `backend/chat-uploads/`
- `.env` and any credentials
- `deploy/` (including `deploy/litestream/` and `ecosystem.config.cjs`)
- `release/*.json`
- All backups and recovery copies
- **Old README files and update-history documentation** — kept deliberately, per your instruction

### 6.4 About the ~21 one-off report markdown files

These are diagnosis write-ups. They are harmless and historically useful — **recommend keeping them**, consistent with your instruction to preserve update-history documentation.

---

## 7. VPS deployment

Adapt paths to your actual install directory.

```bash
# 0. Back up first
cd /path/to/Skylinse-sms
cp backend/data.sqlite "backend/data.sqlite.bak-$(date +%F-%H%M)"
git tag backup-before-repair-2026-10-28

# 1. Deploy the code (copy the files from this package, preserving structure)
#    backend/server.js
#    backend/schema.js
#    deploy/ecosystem.config.cjs
#    scripts/repair-link-ranges-to-provider.js
#    — or apply the patch:
git apply skyline-repair.patch

# 2. Do NOT reinstall dependencies or restart yet — first, the optional DB repair
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS"          # dry run
node scripts/repair-link-ranges-to-provider.js --provider="T- SMS" --apply  # after review

# 3. Restart cleanly. Delete the old processes so PM2 picks up the new env.
pm2 delete powerx-api powerx-sync
pm2 start deploy/ecosystem.config.cjs
pm2 save

# 4. Watch the logs — you want to see ONE api process and ONE sync process,
#    and no EADDRINUSE.
pm2 logs --lines 100
```

**What you should see once the `POWERX_ROLE` fix is live:**

- `powerx-api` prints `• SKYLINE_ROLE=api: backup + provider-sync timers skipped …`
- `powerx-sync` prints `• SKYLINE_ROLE=sync: timers-only process — HTTP listen + SMPP skipped …`
- **No** `EADDRINUSE`, and `powerx-sync` stops OOM-restarting.

**Rollback:** `git checkout -- backend/server.js backend/schema.js deploy/ecosystem.config.cjs && pm2 restart all`. The database repair is reverted from the JSON backup it wrote, or from your `.bak-` copy.

---

## 8. What I could not verify — please run these

I have no VPS access, so I am not going to pretend otherwise. These are **read-only** commands; paste the output back and I will confirm the diagnosis.

### A. Confirm the event-loop blocking (one command)

`backend/db.js` logs every query slower than 200 ms as `[SLOW_QUERY] <ms>ms :: <sql>`, and `/api/health` exposes the worst one.

```bash
pm2 logs powerx-api --lines 3000 --nostream | grep SLOW_QUERY | sort -t']' -k2 -rn | head -20
```

If you see `[SLOW_QUERY]` lines whose SQL contains `payout_amount` or `sms_records`, §1.2 is confirmed and the fix addresses it directly.

### B. Confirm the "T- SMS" SMPP row exists

```bash
cd /path/to/Skylinse-sms
sqlite3 backend/data.sqlite "SELECT id, name, mode, host, port, system_id, active, status, total_received FROM smpp_connections ORDER BY id;"
```

- If the row **is** there → the listing code is fine and the empty panel was the starvation in §1.2, now fixed. No action needed.
- If it is **not** there → the running process is opening a **different** database file than the one you are inspecting. Go to C.

### C. Confirm which database file the app actually opens

```bash
pm2 env powerx-api | grep -Ei 'DB_FILE|DATA_DIR'
pm2 logs powerx-api --lines 200 --nostream | grep 'Database file'
ls -la backend/data.sqlite data/*.sqlite 2>/dev/null
```

Note that `.env.example:30` sets a **relative** `DB_FILE=backend/data.sqlite` while `ecosystem.config.cjs` sets **no `cwd`** — so if the app is started from a different directory it may silently open the wrong file. If C shows a mismatch, tell me and I will help pin `cwd` in the PM2 config. **Do not move or copy the database to "fix" it.**

### D. Confirm the crash-loop history

```bash
pm2 describe powerx-api | grep -Ei 'restarts|status|uptime|memory'
pm2 describe powerx-sync | grep -Ei 'restarts|status|uptime|memory'
pm2 logs powerx-sync --lines 300 --nostream --err | grep -Ei 'EADDRINUSE|in use|error' | head
```

---

## 9. Remaining issues (pre-existing, not caused by the rebrand)

These were **out of scope** for this repair and are **not** fixed. Documented for your awareness:

- **SMPP dedup is per-connection, not global.** The unique index on `smpp_seen` is `(connection_id, dedup_key)` (`schema.js:649`), so two connections carrying the same SMS both count it. Documented in the repo's own `SMPP-14K-VS-28K-INVESTIGATION.md` (2026-09-29), which predates the rebrand.
- **10-second dedup window** — retries outside it are counted as new messages (same document).
- **Failed forwards are never retried or logged** (same document, F5/F6).
- **`smpp_connections` has no `provider_id` column**, so there is no structural provider↔SMPP-connection mapping — provider attribution relies on matching connection *name* to provider *name*. This is a plausible long-term reason for provider attribution looking "mixed up", and is a **design change**, not something I would do as part of a repair.
- `cleanUrl` (previously undefined, `T7`) — **already fixed** in this codebase; it is defined at `backend/providerSync.js:71`.

None of these cause the symptoms you reported, and none should be changed without a separate decision.
