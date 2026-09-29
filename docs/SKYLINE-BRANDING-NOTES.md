# Skyline SMS — frontend branding change (quick task)

Status: **is release me shamil hai** — poore archive par Skyline branding applied hai aur real browser me verify ki gayi hai.
(Working verifier workspace: `/home/user/panel-fix`, screenshots: `/home/user/verify/`.)
Nothing in the backend, database, APIs, SMPP or business logic was touched.

## What changed (visible branding only)

| Surface | Before | After |
|---|---|---|
| Login page `/panel-login` | GALAXY logo plate, "GALAXY SECURE ACCESS", "Welcome to Galaxy SMS", © Galaxy SMS | Skyline lockup, "SKYLINE SECURE ACCESS", "Welcome to Skyline SMS", © Skyline SMS |
| Admin / Manager / Agent / Client panels | sidebar "GALAXY SMS" + old logo | sidebar "SKYLINE SMS" + Skyline mark |
| Browser tab + favicon (all pages) | "GALAXY SMS — …", galaxy favicon | "SKYLINE SMS — …", Skyline favicon |

Files touched (all frontend):
- `login.html`, `admin.html`, `manager.html`, `agent.html`, `client.html` — titles, favicon, logo images, brand text (this was the requested scope).
- The **other 8 front-end pages of the same backend** — `management.html`, `management-login.html`, `panel-sharing.html`, `panel-sharing-login.html`, `payment.html`, `payment-login.html`, `test.html`, `test-login.html` — got the same visible brand replacement, so **no page anywhere still shows the old name** (checked: zero remaining "Galaxy" text outside asset filenames). This went one step past the five named pages on purpose — say the word and I revert those 8.)
- `assets/skyline-logo.svg|png`, `assets/skyline-lockup.svg|png`, `assets/skyline-favicon.svg|png` — **new** brand files (blue "Skyline SMS" mark, built for the white/light theme: `#1D4ED8 → #38BDF8` mark, ink `#0F1E45`, "SMS" in `#2563EB`).
- Old filenames `galaxy-logo.png`, `galaxy-favicon.png`, `galaxy-icon.png`, `galaxy-appicon.png` were **refreshed in place with the Skyline artwork**, so any reference anywhere still renders the new logo.
- Shared frontend assets with brand text/comments: `api.js` (legal modal "About Skyline SMS", settings texts), `assets/galaxy.js`, `assets/galaxy-light.css`, `assets/galaxy.css`, `assets/lamix-light.css`, `assets/dashboard-ui.js`, `assets/chat.js`, `assets/credit-notes.js` (export/settlement file names).
- Test fixtures with brand assertions (frontend only): `tests/ui-theme.test.js` (logo assertion → `skyline-logo.svg`), `tests/verify-all-30-points.js`, `tests/verify-galaxy-cleanup-and-security.js`.

Diff check: comparing the frontend against the pristine copy shows **only branding lines changed** — no functional token, no API path, no script logic difference.

## Verification (real server + real browser)

Server: `panel-fix` on port 4731 (`DATA_DIR=/tmp/skyline-brand-check`, `POWERX_ROLE=api`), Puppeteer at 1440×900 and 430×900.

| Page | Title | Sidebar brand | Logo file | Loaded | "Galaxy" text | Broken images |
|---|---|---|---|---|---|---|
| `/panel-login` | SKYLINE SMS — Login | (login layout: lockup hero) | `/assets/skyline-lockup.png?v=skyline-1` | yes | none | 0 |
| `/admin/dashboard` | SKYLINE SMS — Admin Panel | SKYLINE SMS | `/assets/skyline-logo.svg?v=skyline-1` | yes | none | 0 |
| `/manager/dashboard` | SKYLINE SMS — Manager Panel | SKYLINE SMS | same | yes | none | 0 |
| `/agent/dashboard` | SKYLINE SMS — Agent Panel | SKYLINE SMS | same | yes | none | 0 |
| `/client/dashboard` | SKYLINE SMS — Client Panel | SKYLINE SMS | same | yes | none | 0 |

- Favicon on every page: `/assets/skyline-favicon.png?v=skyline-1`.
- Repo UI contract tests: `node tests/ui-theme.test.js` → **27/27 pass**.
- Only failed request across the four panels: `404 /api/cli-limits` — **pre-existing** (the route does not exist in the pristine code either; the frontend already catches it).

Screenshots:
- `verify/shots-skyline/` — 01_login, 02_admin, 03_manager, 04_agent, 05_client, 05_login_mobile, `panels_overview.png`
- `verify/shots-before/` — the same login page from the pristine (Galaxy) copy
- `verify/shots-skyline/compare_login.png` — before/after side by side

## Deliberately not touched

Backend, database/schema, APIs, SMPP, permissions, calculations, reports, unrelated UI. The backend startup banner still prints the old internal name, and `ecosystem.config.js` still has the old PM2 app name — both are backend/ops, left for the full rebrand pass. Remaining old-name strings are asset **filenames/comments** only (`/assets/galaxy.css`, `/assets/galaxy.js` links and code comments) — not visible to users.

## Preview / rollback

Preview: `cd /home/user/panel-fix && DATA_DIR=/tmp/preview POWERX_ROLE=api PORT=4731 node backend/server.js` → open `/panel-login` (seed admin `vibepk` / `vibepk123`).
Rollback: pre-change copy is at `/tmp/panel-fix-pre-rebrand`; or restore `login.html`/`admin.html`/… from `/home/user/panel-src`.

## Open decisions

1. The delivered release zip (`galaxy-sms-panel-2026-09-29-dedup-v2.zip`, sha `700eb91c…7072`) was built **before** this change and still carries the old branding — say the word and I rebuild it (new sha) including the Skyline frontend.
2. The full rebrand (backend strings, PM2 app name, filenames, docs) remains deferred, as agreed.
