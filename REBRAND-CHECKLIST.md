# Skyline SMS Rebrand + Feature Overhaul — Implementation Checklist (internal)

Verified facts from inspection (lines referred as of pre-edit state):

## 0. Logos & branding
- [ ] A1. Process /home/user/uploads/image-1.png (720x1275, dark bg, black bars):
      crop content → transparent knockout version for panel use → assets/skyline-logo.png (replace 92K placeholder).
      Also regenerate skyline-favicon.png (48-64px) + skyline-icon.png (512) + skyline-appicon.png (192) from same art.
      Keep OLD galaxy-*/powerx-* files untouched on disk (not referenced anymore → verify by grep after).
- [ ] A2. CSS: .powerx-logo-img object-fit:cover→contain (portrait-safe) in admin/agent/management/client/login; bump query strings ?v=skyline-20260929.
- [ ] A3. Visible brand strings: api.js:394 'powerx-export' fallback → 'skyline-export'; admin.html:2233 'powerx-sms-latest-backup.sqlite' → 'skyline-sms-latest-backup.sqlite'; backend/pubreq.js ALL Galaxy SMS strings (L96 galaxy@example.com→skyline@example.com, L97 From "Galaxy SMS"→"Skyline SMS", L126 header, L135/L156 texts, L202/L439/L440/L472/L473 subjects+bodies); providerSync.js:195 UA GalaxySMS-Sync/1.0 → SkylineSMS-Sync/1.0.
      KEEP (technical identifiers, not user-visible): POWERX_FTS env, galaxy_providers table, lamix-light.css filename, class name powerx-logo-img, code comments.
- [ ] A4. Re-grep: no Galaxy/GΛLΛXY/Power X/Lamix visible text anywhere (html/js), except internal comments/identifiers.

## 1. Removals (map + complaint)
Admin: map tile admin.html:376 div.gx-map-card; GX.map call admin.html:1984.
Agent: map tile agent.html:382; GX.map call agent.html:1368.
Client: map tile client.html:322; GX.map call client.html:537.
Management: NONE (verified).
- Complaint: admin nav-item:321 + page-complaints:520 + ADMIN_ALLOWED_PAGES:690 del 'complaints' + route admin.html:2981; agent nav:340 + page-complaints:515 + route:1468; client tab:291 + page-complaints:384 + route:597. Remove chat.js include admin:685/agent:690/client:420 (GXChat used ONLY for complaints — verified). Management has none.
- [ ] Keep assets/chat.js file + backend chat APIs intact.
- [ ] Ensure no empty card left on dashboards (tile removal only; check layout after).

## 2. Dashboard shortcut cards (screenshot style, responsive)
- Current tile lists: admin=[allocation,numbers,managers,agents,clients,smsDetail]; agent=[selfAllocate,numbers,clients,smsDetail,creditNotes]; client=[numbers,stats,test] BUT dashboard-ui.js OVERWRITES client to 5 items incl. 'unavailable' tiles (fix: only My Numbers + Detailed Reports); management: none.
- [ ] B1. dashboard-ui.js client branch: replace list with ['My Numbers','Detailed Reports'] only, no unavailable placeholders, no lm-rebuild.
- [ ] B2. Restyle .gx-shortcut to screenshot style: white/light tile, border, colored icon ABOVE label, ~5-per-row desktop, stacked full-width mobile; accents already in dashboard-ui (lm-acc-1..6) — restyle per lamix palette; add responsive CSS (media queries) in each panel's <style> or shared lamix css. Image-2 (desktop): simple light tiles, small colored icon, label under. Image-3 (mobile): full-width stacked cards.
- [ ] B3. Distinct icon per card (dashboard-ui already maps href→icon; extend mapping incl. selfAllocate/test).

## 3. SMS Detail Report filter changes (admin/manager/agent + client page-stats)
- [ ] C1. REMOVE Time filter UI + logic: admin (admin.html ~L2902 builder row, renderer tdVal/ttVal refs, sdUseTime, sdToggleTime(), sd_reset branches); management.html:939 + tfVal/ttVal L1347; agent.html:1137 + L1270.
- [ ] C2. Client page-stats: remove Time row (stTFrom/stTTo at client.html:353) + stResetFilters ref + renderStats params (find tf/tt send keys).
- [ ] C3. Verify Range filter searchable dropdown everywhere (admin sdSelRange exists; client stRange via renderSearchSelect; verify management/agent exist — agent L1270 has sdRange). Group-by (incl Range, Hour/Day/Month) UNTOUCHED.
- [ ] C4. Backend: confirm absence of time params is fine (server optional time args) — no backend change expected; do not touch timestamps/timezone code.

## 4. Agent flow
- [ ] D1. openSelfAlloc(preselectedRangeName): when preselected → hide saModalRange select, show readonly range label; when not → keep dropdown. (agent.html:1774)
- [ ] D2. Message agent.html:1837 → "No Number Available, Contact Your Manager" (short).
- [ ] D3. Remove redundant Self Allocate option from rate-card/request flow: rate card row Action button stays (range request entry); remove duplicate "+ Self Allocate" head button on My Numbers page (agent.html:460) — CONFIRM interpretation with user? No — keep minimal: keep page button? (decision: keep; the redundant one per spec = asking range again, fixed by D1). Revisit after user confirmation not requested → go with spec text: unnecessary = re-select; fixed by D1.
- [ ] D4. loadSelfAllocRanges flow: from Self Allocate page direct link w/ range in URL (?range=) → preselect (existing openSelfAlloc handles).

## 5. Rates / payout propagation
- State of code: allocation writes tier rates (manager_rate/agent_rate/client_rate) + effective_rate display expressions are role-scoped (server.js:2095-2130). validatedAllocationRate caps format (2262). Client-target allocations set payout=clientRateVal (handleAllocate 2349/2353/2358 + smart-divide 3144/3146/3149); requirement: payout stays 0.00 unless explicitly set.
- [ ] E1. DECOUPLE: client-target allocation sets client_rate only; payout untouched (stays old/default '0') UNLESS body.explicit_payout provided. Add explicit_payout support; default keeps payout.
      UI: agent aaPayout input semantics — currently sends payout:po,rate:po (treated as rate+payout). Decide: keep client_rate from rate field; payout only when explicit_payout provided; update agent/management/admin alloc modals: label "Rate (client billing)" + optional "Client Payout" (default 0.00). Manager management.html:1389 sends payout:po — re-map to rate.
      PUBREQ writes L4644/4757/4865 — public request flows; leave untouched (out of panel scope) — NOTE in final report.
- [ ] E2. Live verification chain: admin→manager (rate R1) ⇒ manager view shows R1; manager→agent (R2) ⇒ agent sees R2, payout '0'; agent→client rate R3 no payout ⇒ client payout 0.00, client_rate R3; explicit payout P ⇒ payout P.

## 6. Test Panel admin controls (admin only)
Existing: move-to-test (numbers→test, DELETES live row: server.js:2984), POST/DELETE single test-number, import.
- [ ] F1. schema.js: ensureColumn on range_test_numbers: prev_number_id INTEGER, prev_manager_id INTEGER, prev_agent_id INTEGER, prev_client_id INTEGER, prev_payterm TEXT DEFAULT ''. (additive, safe)
- [ ] F2. move-to-test: capture prev ownership into new cols on insert.
- [ ] F3. NEW POST /api/test-numbers/move-back {ids:[range_test_numbers ids]}: insert into numbers (range_id, number, prev owners/payterm, rate '' payout '0', alloc_source='move_back'), delete test row, refresh ranges.test_number concat; transaction; audit log. Duplicate guard: skip if cleaned number already in numbers. No orphan: always back into its range_id (range must exist, else error→skip + report).
- [ ] F4. NEW DELETE /api/test-numbers/bulk {ids:[]} and DELETE /api/test-numbers/by-range {range_id} (+confirm client-side). Single DELETE exists.
- [ ] F5. Admin UI page-test: Test Numbers table gets checkbox column + action bar (Delete Selected / Move Back Selected / Delete Entire Range via testNumRange dropdown) with confirm() dialogs; refresh table after; totals/exports unchanged.

## 7. Testing (after each stage + full at end)
- Boot backend on free port w/ test DB copy; exercise: login as each seeded role; dashboard renders (no map/complaint); cards responsive (resize viewport via node? manual CSS check); smsDetail filters work post-removal (range filter returns rows; no console errors re sdTime refs); agent self-alloc modal pre-select; admin test move-back/delete incl. confirm flows via API; rate chain E2 via API; grep branding again; run existing test suites (ui-theme.test.js etc.).

## Guardrails
- No renames of technical identifiers (POWERX_FTS etc.).
- SMPP/ingestion/payments untouched (except the scoped payout-write change E1, documented).
- If something is unsafe/ambiguous → stop and report (not hack).
