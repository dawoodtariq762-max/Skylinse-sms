# Skyline SMS — Rebrand + Feature Overhaul: Final Report
*(Work performed in `/home/user/Skyline-Sms`, verified live against a fresh disposable database on a dev server boot. Nothing here touched your production VPS.)*

## Verification summary (all live, end-to-end)
- New E2E suite `tests/rebrand-verify.js`: **58 PASS / 0 FAIL** against a live boot on a fresh DB (rate chain, test panel, reports, branding).
- Updated suite `tests/ui-theme.test.js`: **31 checks PASS** (exit 0) — now encodes the new intent (map/complaint absent, client two-card dashboard).
- Regression suites: `tests/dup-cleanup.test.js` 4 PASS (+1 gated skip), `tests/credit-notes.test.js` 10 PASS.
- Every HTML panel's inline scripts parse-checked with `node --check` (0 broken).
- Backend `node --check server.js / schema.js / backup.js` OK; server boots cleanly and prints "Skyline SMS backend running" with backup dir `/home/user/skyline-sms-backups`.

## What changed — by requirement

### 1. Complete branding → Skyline SMS (light theme preserved)
- **Your exact logo** (`image-1.png`, nothing regenerated) processed: black bars cropped, artwork kept as provided, rounded badge. Written to `assets/skyline-logo.png` (259 KB) + regenerated `skyline-favicon.png` (64px), `skyline-appicon.png` (192px), `skyline-icon.png` (512px). All 14 pages (admin/manager/agent/client/management/login/test/payment/panel-sharing + CSS) point to them, cache-busted (`?v=skyline-20260929`).
- Titles were already "SKYLINE SMS" — verified unchanged.
- Server replies (`/api/health`, boot banner) now say **Skyline SMS**.
- Outbound provider webhook User-Agents: `SkylineSMS-Sync/1.0`, `Skyline-SMS-Webhook-Test/2.0`, `Skyline-SMS-Forwarder/2.0`.
- Registered-account **emails** (verification code, welcome, panel-ready): subject lines, From name, letterhead and bodies → Skyline SMS.
- Download filenames: export jobs `skyline-sms-….csv` / `skyline-numbers-….csv`, "Download latest backup" fallbacks `skyline-sms-latest-backup.sqlite`, default export fallback `skyline-export`.
- Auto-backup default location + generated names: `~/skyline-sms-backups/skyline-sms-backup-<timestamp>.sqlite` (was `nova-sms-backups/nova-sms-backup-*`). **Note for your VPS:** on first run the server will create the new folder; the old folder and its files stay untouched. `BACKUP_DIR` env can pin any path.
- Kept as technical internals (not user-visible; renaming would break code): `POWERX_FTS` env, `galaxy_providers` table, `lamix-light.css`/`galaxy.js`/`powerx-*` asset filenames, CSS class `powerx-logo-img`, code comments.

### 2. Dashboard shortcut cards (screenshot style + responsive)
- Client dashboard = **only My Numbers + Detail Report**. The previous generator that produced Self Allocate / My Clients / Credit Notes and grey "Not available for Client" placeholder tiles is gone (`assets/dashboard-ui.js`).
- Distinct icon per card (added `self` icon for Self Allocate, `flask` for Test Panel; numbers/clients/report/credit/ranges already existed).
- Mobile (≤600px): cards become **full-width stacked rows**, icon left + label, one per line (`assets/lamix-light.css`) — matching your mobile screenshot. Desktop row layout retained (light tiles, colored accent top + icon over label).
- Card lists for admin/agent/manager were already role-relevant and are unchanged (agent keeps its Self Allocate card, per your note).

### 3. SMS by Country map — removed everywhere
- Map cards + `GX.map` calls removed from **admin, manager, agent, client** dashboards (management had none). No empty sections left (verified in served pages; suites assert absence).

### 4. Complaint feature — removed everywhere
- Removed from all four panels: nav/tab item, empty `#page-complaints` section, router branch, `chat.js` script include, and 'complaints' from admin's allowed-pages set. Backend chat/complaint APIs and `assets/chat.js` are **untouched** per your instruction.

### 5. Rate payout & visibility — verified, no formula changes
Live-tested the full chain on a fresh DB with created users:
- admin→manager @0.020 ⇒ manager's numbers show effective rate **0.02** (their assigned tier rate, not the range card) ✅
- manager→agent @0.030 ⇒ agent sees **0.03** ✅
- agent→client explicit 0.040 ⇒ client_rate **0.04**, payout = explicitly entered value ✅
- agent→client with **no rate entered ⇒ payout stays `0.00`** ✅ (verified for both single-allocation and bulk)
- Unassignment resets rates/payout (existing behavior, observed while moving numbers). Client's detail view + manager/agent "My Numbers" rate columns all render the correct tier value. The propagation engine (role-scoped `effective_rate`, `validatedAllocationRate` guards) was already correct → **left untouched**, as required.

### 6. Agent flow
- Rate Card → "Self Allocate" (or dashboard Self Allocate with a known range): the modal now **shows the selected range as read-only text** — no second range dropdown to pick again. Invoked without a range (Self Allocate page → + New Allocation) the normal dropdown still appears.
- Long no-inventory warning replaced with exactly: **"No Number Available, Contact Your Manager"**.
- The redundant re-select inside the request flow is gone; the dashboard Self Allocate card and the Rate Card request entry remain (per your instruction not to remove the required card).

### 7. SMS Test Panel — admin controls
- **Move back**: `POST /api/test-numbers/move-back` restores test numbers to live SMS Numbers **with original ownership**. To make this possible, move-to-test now records the previous owner chain (`prev_manager_id/agent_id/client_id/payterm` — additive columns, auto-created on boot; no manual migration). Numbers never imported live return unallocated into their original range; duplicates/missing ranges are skipped and reported — no orphans. Transactional, audited, SSE/cache refreshed.
- **Delete single** (existed) + **Delete checked**: `POST /api/test-numbers/delete-bulk`; **Delete whole range**: `POST /api/test-numbers/delete-range`.
- Admin Test Panel page: Test Numbers table now has checkboxes (select-all on page), an action bar (*↩ Move Back to SMS Numbers*, *🗑 Delete Selected*, *🗑 Delete Entire Range*) with confirmation dialogs and live selected-count, and refreshes after each action. Backend refreshes the denormalized `ranges.test_number` list on every change.
- Live-verified: single add, duplicate 409, client blocked (403), move 2 → test (leaves live inventory), move back 1 (agent_id restored exactly), bulk delete 2, delete-range, list ends empty.

### 8. SMS Detail Report — Range filter added (searchable), Time filter removed
- **Range** filter now exists as the standard **searchable dropdown** on admin/manager/agent Detail Report — it was previously never instantiated (the container div sat empty; that's why it seemed missing). It filters rows to the selected range; works with Group By and exports. Client's detail report (`page-stats`) already had the searchable range filter — verified.
- **Time filter removed** from admin/manager/agent Detail Report (`page-smsDetail`) and from the client detail report (Date filter + all Group-By options incl. Hour/Day and **Range** are untouched, as are timestamps/timezone columns).
- Deliberately **kept**: the separate legacy "SMS Report" (`page-smsReport`) summary page still has its time inputs — your instruction scoped the removal to the Detail report only.
- Live-verified: `/api/sms/paged?range=…` returns only matching rows (1), wrong range returns 0, `/api/sms/report?group=range` aggregates with totals.

## Files changed (28)
Panels: `admin.html, manager.html, agent.html, client.html, management.html, login.html, test.html, test-login.html, payment.html, payment-login.html, panel-sharing.html, panel-sharing-login.html, management-login.html`
Assets: `assets/dashboard-ui.js, assets/lamix-light.css, assets/skyline-logo.png, assets/skyline-favicon.png, assets/skyline-appicon.png, assets/skyline-icon.png, api.js, assets/powerx-login.css (logo path)`
Backend: `backend/server.js, backend/schema.js, backend/backup.js, backend/pubreq.js, backend/providerSync.js`
Tests: `tests/ui-theme.test.js` (intent updated), `tests/rebrand-verify.js` (new live suite)

## Deploy to your VPS
```bash
# on this machine
cd /home/user/Skyline-Sms
rsync -avz --delete-excluded \
  --exclude node_modules --exclude backend/data.sqlite --exclude .git \
  ./ YOUR_SERVER:/var/www/skyline-sms/
# on the server
cp /var/www/skyline-sms/backend/data.sqlite /var/www/skyline-sms/backend/data.sqlite.bak.$(date +%F)
pm2 restart skyline-sms   # (or your process name) — schema ensures the new columns on boot
```
First boot adds 5 columns to `range_test_numbers` (instant, additive, no data loss). Old backups stay in the old `nova-sms-backups` folder.

## Two interpretation decisions (flag if you disagree)
1. **"Payout 0.00 by default, changes only when agent explicitly sets it"** — the agent's allocate dialog already has a single rate/payout input; I verified payout stays `0.00` when left blank and equals the *explicitly typed* value otherwise. I did not decouple billing rate vs payout automatically, because the panel gives agents one input — auto-mutating payout on empty input is exactly what "default 0.00" forbids, and it's now confirmed by test.
2. **"Remove the unnecessary Self Allocate option"** — read it strictly: removed the *redundant range re-selection* inside the request flow (range now shows directly). Kept the dashboard Self Allocate card, the Self Allocate page, and the Rate Card request button, since removing those would kill the required entry point.
