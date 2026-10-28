# Setup and deployment — targeted fixes

This is the original Express/SQLite panel, not a replacement application. The request calls it Skyline SMS; existing Galaxy SMS branding/logo is retained because no further rebrand was requested.

## Existing deployment
1. Back up the application directory, existing `.env`, full SQLite database (use SQLite backup or stop writes first), uploads and provider configuration. Do not delete or recreate your database.
2. Stop the existing application process during deployment. Extract this ZIP to a staging directory first; compare it with your deployed version before overlaying source files. Keep your real `.env`, database, uploaded assets and operational data. None are included in this source-only delivery.
3. **Keep/set the existing `JWT_SECRET` in your real environment before restarting.** This build no longer embeds a shared development signing key. Preserve the exact secret already in use to retain sessions. If your old deployment relied on a source-code fallback rather than environment configuration, move that same secret into your private environment, or deliberately rotate it and require re-login. Do not distribute it.
4. Keep existing account/security settings in SQLite. No users, stored passwords, balances, billing periods, currencies or payment statuses are reset. Default bootstrap credentials have been removed from shipped source. New-install bootstrap is environment-based; existing accounts are unaffected.
5. Use Node.js 20 or newer. Run `npm ci` from the project directory. The existing lockfile is included; native better-sqlite3 requires a compatible Node platform/toolchain.
6. Restart with your existing PM2/systemd process configuration, or `npm start`. Use the same database path and environment as before. No new allocation table/column migration is required. The existing application's schema startup still runs as it always did; do not run seed/reset scripts manually.
7. Hard-refresh browsers. Theme stylesheet URLs are cache-busted. Verify `/health`, login, all four roles' SMS Numbers pages, rates and returns with staging accounts before production use.

## Optional legacy active-rate reconciliation
Back up the DB, stop the application and point to the existing database explicitly:

```sh
DB_FILE=/absolute/path/to/existing.sqlite node scripts/audit-client-rates.js
```

This defaults to read-only audit. If you have reviewed it and want to reconcile only explicit valid `client_rate` values with stale `payout` fields:

```sh
DB_FILE=/absolute/path/to/existing.sqlite node scripts/audit-client-rates.js --apply
```

The apply operation is transactional, writes number-history entries and bumps the allocation-cache version. It never modifies SMS, CDR or payment history. Empty/invalid legacy rate configurations are counted as ambiguous and deliberately not rewritten. Their live effective rate is safely zero; establish original intent with the owner before any historical correction. Restart the application afterward. No production reconciliation has been performed as part of this delivery.

## Fresh installation only
Copy `.env.example` to `.env` privately. Set your own `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD`, `ADMIN_SECURITY_CODE`, `CARRIER_LOCK_PASSWORD`, public origin and database path. Set `BRANDING_PASSWORD` if creating the Branding-console account. `TEST_PANEL_INITIAL_PASSWORD` is optional: without it, no new test account is created. These variables create missing bootstrap records only; they do not reset existing stored credentials. If security-code variables are omitted for a fresh system, unpredictable codes are stored instead of shared defaults; explicitly configure them so you can use the security dialogs. Never ship `.env` in an archive.

## Use
- **Client → Return selected:** removes only the Client assignment; the Agent retains inventory (or the direct allocating parent, for existing direct-allocation workflows).
- **Agent/Manager → Return selected:** releases all three ownership levels on only those IDs, so Admin sees Unallocated. Confirmation explains the cascade.
- **Admin → Return selected:** releases selected currently allocated numbers to Admin Unallocated.
- **Unallocate:** retains its existing downstream-only meaning; it has not been silently repurposed.
- Agent **Set Client payout:** select currently Client-assigned numbers, enter a value and confirm. Blank/zero stores `0.00`; valid nonzero decimals retain their configured text (up to the existing supported 6 decimal places and 100000 cap). The Client display retains the currency symbol.
- Agent Allocate Selected, Smart Divide and bulk/range allocation accept explicit Client payout. No upstream/range value is prefilled as an outbound Client payout.
- Other open panels check a version every 10 seconds while visible and on focus. The initiating panel refreshes immediately. Actual data queries remain role-scoped.

## Tests
```sh
npm test
node scripts/check-syntax.js
```

Tests create their own OS-temp SQLite file, random test passwords and test signing secret, run the actual application, then remove the isolated DB. They do not use `.env`'s database. Port 4183 must be free. Tests supply simulated forwarded loopback addresses to avoid treating repeated automated logins as a brute-force attack; production login limiting is unchanged.

Optional actual-page browser tests:
```sh
npm install --no-save --package-lock=false playwright
npx playwright install --with-deps chromium
npm run test:browser
```

Or set `PLAYWRIGHT_MODULE` to an existing installed Playwright module. Browser tests run through real CAPTCHA login and supported APIs; no role scripts/auth gates are removed. Test screenshots show synthetic accounts/data only.

There is no compile/build step in this static-HTML project. `npm ci`, native addon loading, source syntax checks, server startup and API/browser workflows are the relevant checks.
