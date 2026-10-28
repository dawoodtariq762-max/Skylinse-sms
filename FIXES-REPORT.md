# Skyline SMS requested fixes — final report

## Delivery and scope
Completed locally in `/home/user/skyline-sms`, starting from the existing modified repository in `/home/user/galaxy-sms`. Existing Galaxy SMS name/logo retained; the three requested repairs did not authorize a further visual rebrand. No commit, push or GitHub upload was made. No operational database was provided or modified. Test records existed only in new disposable databases, not application data.

## 1. CAPTCHA: root cause and fix
The current login uses legacy `gx-login` / `gx-light` classes while several newer login overrides target `ams-login`. The existing color/animation cascade did not provide the requested black calculation text. Added a narrow final-cascade selector covering both naming schemes, setting `#captchaText` color and WebKit text fill to `#111`. No CAPTCHA generation, arithmetic validation, answer refresh, login code, logo, layout or background changed. Actual Chromium login reports #111 on #eef2ff, rejects a wrong answer and authenticates with a correct answer. The original CAPTCHA is client-side arithmetic; this work preserves it and does not claim to turn it into a server-side anti-bot mechanism.

## 2. Agent → Client payout rate: root cause and fix
The data model has separate upstream rates (`manager_rate`, `agent_rate`, `rate`) and the Agent's outbound Client configuration (`client_rate`, mirrored to `payout`). Reads could fall back from absent `client_rate` to stale `payout`; the Client formatter also forced two decimal places on valid nonzero values. Bulk workflows did not all expose an outbound Client-rate input. Historical report joins could show a later owner's current Client payout on an earlier owner's SMS.

Changes:
- One strict outbound-rate parser and SQL read expression. Empty/null/zero → `0.00`; valid nonzero values retain their configured decimal text. Malformed rates are rejected on writes and rendered as zero on legacy reads, never replaced by a range/upstream rate.
- Allocate and smart-divide synchronize both stored Client fields. Explicit zero overwrites both, not only the display.
- Added authenticated Agent-only `POST /api/numbers/client-rate` to update selected current Client allocations, with both number ownership and Client parent validation, atomic audit history, cache invalidation and committed writes before success.
- Added **Set Client payout** and explicit bulk/smart-divide payout inputs, without a nonzero prefilling default. Client display preserves `$0.1`, while zero is `$0.00`.
- Current Client-payout report fields use the authoritative rate, with a snapshot-owner guard: when the current owner differs from the SMS owner, the current-rate annotation is unavailable rather than leaking another Client's current value. This is not a reconstructed historical rate.
- Upstream Agent ledger earnings, existing earned SMS/payment snapshots, currencies, payment statuses and billing periods are not retroactively recalculated. The rate-update action changes active configuration, not past income records.

## 3. Number Return: root cause and fix
The existing Unallocate route only cleared the tier below the caller, leaving the Agent/Manager attached; Clients had no return selection/action. This was different from the requested upstream semantics. Existing bulk operations could also accept mixed selections partially rather than reject the whole request.

Added `POST /api/numbers/return` and a shared service using the existing `numbers` ownership columns, not duplicate allocation records:
- Client clears only `client_id` and Client rate fields; retains Agent/Manager inventory.
- Agent, Manager or Admin return clears Manager, Agent and Client ownership and tier rates for selected numbers, making them Admin Unallocated.
- Strict integer IDs, duplicates/unknown/already-unallocated/unauthorized ownership checks. Invalid mixed selections do not partially apply.
- Selection validation, ownership checks, number updates and number-history audit entries share a SQLite savepoint/transaction. A forced history-write failure was tested and rolls back the number changes.
- Role pages use the existing multi-selection interface; Client received checkboxes in its current SMS Numbers table. A clearly labelled Return selected action uses a cascade confirmation.
- Existing Unallocate behavior remains separate and unchanged.
- Counts/list queries use the same ownership columns, so existing filters reflect returns. New `GET /api/numbers/allocation-version` supports lightweight visible-panel polling (10 seconds, also on focus). Initiating page refreshes immediately; other actual row queries remain authenticated and role-scoped.
- Number rows, SMS/CDR history, payment rows/statuses and unrelated allocations are not deleted or rewritten.

## Tests actually performed
Actual Express server, real JWT login and SQLite records in an isolated OS-temp database; Node 20 and headless Chromium. These are real application workflows, not mocked API responses or stripped HTML shells.

### API/database results
- Empty, zero, exact nonzero, 6dp, changed-to-zero, persisted GET and fresh login: PASS
- Rate isolation / invalid rate / role guard and malformed legacy reads: PASS
- Client 4 of 25 return: Agent retains all 25, 4 reusable, 21 Client assignments remain: PASS
- Actual Agent allocation route blank/zero/nonzero/reset and returned-number reuse: PASS
- Actual smart-divide exact Client payout: PASS
- Mixed unauthorized, other Agent/Manager, duplicates, missing IDs, malformed IDs: all-or-nothing rejection PASS
- Agent upstream cascade and Admin Unallocated/Manager removal, repeated return rejection: PASS
- Manager return across two Agents cascades selected Clients only: PASS
- Admin return authority: PASS
- All number records and historical SMS unchanged; no fixture orphans: PASS
- Refresh and re-login after returns: PASS
- Injected history-insert failure rolls back number update: PASS
- Repair dry-run/no write, explicit zero mismatch repair, ambiguous blank preserved, SMS untouched: PASS
- Reallocated number cannot expose another Agent/Client current rate through old Client SMS history: PASS

### Browser results
- Actual login CAPTCHA computes as #111 against rgb(238, 242, 255): PASS
- Incorrect CAPTCHA prevents login and refreshes calculation: PASS
- Correct CAPTCHA authenticates and opens Client panel: PASS
- Client selected Return, confirmation, persisted removal after reload: PASS
- Client real re-login preserves returned-number removal: PASS
- Agent Set Client payout prompt, confirmation and real API write: PASS
- Client actual payout cell updates to $0.00 after Agent resets rate to zero: PASS
- agent actual role page, selection and visible Return in both themes: PASS
- Open Client panel automatically drops Agent-returned number via version polling: PASS
- agent real selected Return confirmation and API success: PASS
- manager actual role page, selection and visible Return in both themes: PASS
- manager real selected Return confirmation and API success: PASS
- admin actual role page, selection and visible Return in both themes: PASS
- admin real selected Return confirmation and API success: PASS
- Browser page errors: 0.
- Visually reviewed actual login and Agent SMS Numbers screenshots for readability and placement.
- Source parse checks: 68 script units; 0 failures.
- `npm ci`: successful; existing dependency lockfile retained.
- Native SQLite module and full server startup: successful during tests.
- No build script exists in the original project; this is static HTML served by Express. Added reproducible `npm test` and optional `npm run test:browser` commands.

## Schema, historical records and packaging security
No new allocation tables/columns or destructive migrations were needed. No production migration or historical-data correction was performed.

`audit-client-rates.js` defaults to read-only mode. Its optional explicit `--apply` only aligns stale `payout` with a demonstrably explicit valid `client_rate` on active allocations, logs number history transactionally and bumps the allocation version. Blank/invalid legacy configuration remains review-only; no historical SMS or payment value is guessed. Dry-run, safe explicit-zero repair and ambiguous-record preservation were tested.

To meet the instruction not to package passwords/secrets, embedded bootstrap/test passwords, shared security-code defaults and the development JWT signing fallback were removed from source. Existing stored account hashes/security codes are not reset. Fresh/missing bootstrap accounts use private environment variables. JWT_SECRET must now be explicitly configured; preserve the existing secret on deployment. `.env.example` contains blank secret slots, not credentials. See deployment instructions for missing-account/security setup. This packaging change does not alter roles, token claims, login validation or permissions.

## Limitations and unverified items
- No production database, provider credentials or production user accounts were supplied. Production acceptance, live SMPP/provider delivery, financial settlement and full unrelated workflow regression testing remain outside what was actually exercised.
- Historical ambiguous rates cannot be safely reconstructed. The supplied audit reports ambiguity; owner review is required. No mass retroactive financial rewrite is included.
- The global allocation-version poll is eventual across already-open panels (up to 10 seconds while visible, plus focus refresh), not a new real-time push infrastructure.
- Existing direct Admin/Manager-to-Client allocations are supported: Client return retains whichever upstream owner actually exists, rather than inventing an Agent.
- Valid rate limits retain the supported maximum 6 decimal places and 100000 bound; unsupported inputs are rejected, not silently rounded.
- Dependency audit currently reports 4 pre-existing advisories (1 moderate, 2 high, 1 critical); dependencies were not upgraded under this focused fix. The audit JSON is included. Multer also emits an existing deprecation/security warning.
- The existing login references `/assets/qtech.css` and `/assets/qtech.js`, which were absent from the supplied repository. These pre-existing missing legacy resources were not invented or replaced; actual CAPTCHA/login tests succeeded with the existing loaded styles/scripts. This is documented rather than silently redesigning the login.

## Deployment/restart
1. Back up the deployment and database; stage the complete source archive separately.
2. Preserve the destination `.env`, existing JWT_SECRET, database and uploaded assets/provider configuration. Do not replace production config with `.env.example`.
3. Stop the existing process, overlay reviewed source, run `npm ci`, then restart using the existing PM2/systemd configuration or `npm start`.
4. Do not reset/seed/recreate the production DB. Optional reconciliation is dry-run-first and should be reviewed/offline with a backup.
5. Hard-refresh browsers and exercise the staging acceptance checklist for all roles. Full instructions are in `SETUP-AND-DEPLOY.md`.

## Changed/new files relative to the previous workspace delivery
- `.env.example`
- `SETUP-AND-DEPLOY.md`
- `admin.html`
- `agent.html`
- `assets/galaxy-theme.css`
- `assets/number-return.js`
- `backend/allocation-safety.js`
- `backend/auth.js`
- `backend/branding.js`
- `backend/schema.js`
- `backend/seed.js`
- `backend/server.js`
- `branding-login.html`
- `branding.html`
- `chat.html`
- `client.html`
- `login.html`
- `management-login.html`
- `management.html`
- `manager.html`
- `package.json`
- `panel-sharing-login.html`
- `panel-sharing.html`
- `payment-login.html`
- `payment.html`
- `scripts/audit-client-rates.js`
- `scripts/check-syntax.js`
- `test-login.html`
- `test.html`
- `tests/browser-results.json`
- `tests/browser.js`
- `tests/dependency-audit.json`
- `tests/integration-results.json`
- `tests/integration.js`
- `tests/screenshots/admin-dark.png`
- `tests/screenshots/admin-light.png`
- `tests/screenshots/agent-dark.png`
- `tests/screenshots/agent-light.png`
- `tests/screenshots/client-dark.png`
- `tests/screenshots/client-light.png`
- `tests/screenshots/login-captcha.png`
- `tests/screenshots/manager-dark.png`
- `tests/screenshots/manager-light.png`
- `tests/syntax-results.json`

`FIXES-REPORT.md` is this report. The archive also contains all unchanged source/assets/configuration templates from the existing project. Test screenshots contain synthetic QA data, not real user records.
