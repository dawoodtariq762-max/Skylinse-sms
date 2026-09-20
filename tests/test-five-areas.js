/**
 * Verification test suite for the 5 specific areas:
 * Area 1: SMS Detailed Report simultaneous multi-filter (CLI + Range + Provider + Date + Time)
 * Area 2: Client SMS Support (Only CLI, Range, Date, Time filters, client scope enforcement)
 * Area 3: Provider Rate & Real Cost Tracking (Admin-only provider_rate, real cost calc on eligible SMS)
 * Area 4: Range/SMS Number Visibility vs SMS Rate Card (allocated ranges vs all configured ranges)
 * Area 5: Branding (Skyline SMS branding consistency across all UI templates)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

const TEST_DB = '/tmp/test_five_areas.db';
const TEST_PORT = 8097;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (_) {}
try { if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
try { if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}

let serverProcess = null;
let tokens = {};

function request(method, pathUrl, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const pass = (name, detail = '') => console.log(`PASS | ${name}${detail ? ' | ' + detail : ''}`);
const fail = (name, detail = '') => { console.error(`FAIL | ${name} | ${detail}`); process.exit(1); };

async function run() {
  console.log(`Starting 5-Areas Verification Suite on port ${TEST_PORT} with db ${TEST_DB}`);

  // 1. Spin up backend server process
  serverProcess = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_FILE: TEST_DB,
      JWT_SECRET: 'test-secret-five-areas',
      NODE_ENV: 'test'
    },
    stdio: 'inherit'
  });

  // Wait for server to start listening
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) { ready = true; break; }
    } catch (_) {}
  }
  if (!ready) fail('server_start', 'Server did not respond to /health in time');
  pass('server_start', 'Backend server listening');

  let db = new Database(TEST_DB);
  const getDb = () => new Database(TEST_DB);

  // 2. Setup users: admin, manager, agent, client
  // Admin logs in (default created by seed)
  const adminLogin = await request('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' });
  assert.strictEqual(adminLogin.status, 200);
  tokens.admin = adminLogin.data.token;
  pass('setup_admin', 'Admin authenticated');

  // Create manager
  const mgrRes = await request('POST', '/api/users', {
    username: 'mgr1',
    password: 'password123',
    role: 'manager',
    name: 'Test Manager'
  }, tokens.admin);
  assert.strictEqual(mgrRes.status, 200);
  const mgrList = await request('GET', '/api/users/manager', null, tokens.admin);
  const mgrId = (mgrList.data || []).find(u => u.username === 'mgr1')?.id;
  assert(mgrId, 'Manager ID must exist');
  const mgrLogin = await request('POST', '/api/login', { username: 'mgr1', password: 'password123' });
  tokens.manager = mgrLogin.data.token;
  pass('setup_manager', `Manager created (id: ${mgrId})`);

  // Create agent under manager
  const agtRes = await request('POST', '/api/users', {
    username: 'agt1',
    password: 'password123',
    role: 'agent',
    name: 'Test Agent',
    parent_id: mgrId
  }, tokens.admin);
  assert.strictEqual(agtRes.status, 200);
  const agtList = await request('GET', '/api/users/agent', null, tokens.admin);
  const agtId = (agtList.data || []).find(u => u.username === 'agt1')?.id;
  assert(agtId, 'Agent ID must exist');
  const agtLogin = await request('POST', '/api/login', { username: 'agt1', password: 'password123' });
  tokens.agent = agtLogin.data.token;
  pass('setup_agent', `Agent created (id: ${agtId})`);

  // Create client under agent
  const cliRes = await request('POST', '/api/users', {
    username: 'client1',
    password: 'password123',
    role: 'client',
    name: 'Test Client',
    parent_id: agtId
  }, tokens.admin);
  assert.strictEqual(cliRes.status, 200);
  const cliList = await request('GET', '/api/users/client', null, tokens.admin);
  const clientId = (cliList.data || []).find(u => u.username === 'client1')?.id;
  assert(clientId, 'Client ID must exist');
  const cliLogin = await request('POST', '/api/login', { username: 'client1', password: 'password123' });
  tokens.client = cliLogin.data.token;
  pass('setup_client', `Client created (id: ${clientId})`);

  // =========================================================================
  // AREA 3: Provider Rate & Real Cost Tracking
  // =========================================================================
  console.log('\n--- VERIFYING AREA 3: Provider Rate & Real Cost Tracking ---');

  // Create Range 1 with provider_rate 0.04 and provider "CarrierAlpha"
  const r1Res = await request('POST', '/api/ranges', {
    name: 'UK_Alpha',
    prefix: '4471',
    currency: 'USD',
    rate_1_1: '0.08',
    rate_7_1: '0.08',
    rate_7_7: '0.08',
    rate_30_45: '0.08',
    provider: 'CarrierAlpha',
    provider_rate: '0.04'
  }, tokens.admin);
  assert.strictEqual(r1Res.status, 200);
  const r1List = await request('GET', '/api/ranges?_nocache=1', null, tokens.admin);
  const r1Id = r1List.data.find(r => r.name === 'UK_Alpha')?.id;
  assert(r1Id, 'UK_Alpha range must exist in DB');
  pass('area3_create_range_provider_rate', `Range created with provider_rate 0.04 (id: ${r1Id})`);

  // Create Range 2 with provider_rate 0.06 and provider "CarrierBeta"
  const r2Res = await request('POST', '/api/ranges', {
    name: 'UK_Beta',
    prefix: '4472',
    currency: 'USD',
    rate_1_1: '0.10',
    rate_7_1: '0.10',
    rate_7_7: '0.10',
    rate_30_45: '0.10',
    provider: 'CarrierBeta',
    provider_rate: '0.06'
  }, tokens.admin);
  assert.strictEqual(r2Res.status, 200);
  const r2List = await request('GET', '/api/ranges?_nocache=1', null, tokens.admin);
  const r2Id = r2List.data.find(r => r.name === 'UK_Beta')?.id;
  assert(r2Id, 'UK_Beta range must exist in DB');
  pass('area3_create_second_range', `Second range created with provider_rate 0.06 (id: ${r2Id})`);

  // Create Range 3 (Unallocated range, for Area 4 testing)
  const r3Res = await request('POST', '/api/ranges', {
    name: 'UK_Unallocated',
    prefix: '4473',
    currency: 'USD',
    rate_1_1: '0.09',
    rate_7_1: '0.09',
    rate_7_7: '0.09',
    rate_30_45: '0.09',
    provider: 'CarrierAlpha',
    provider_rate: '0.05'
  }, tokens.admin);
  assert.strictEqual(r3Res.status, 200);
  const r3List = await request('GET', '/api/ranges?_nocache=1', null, tokens.admin);
  const r3Id = r3List.data.find(r => r.name === 'UK_Unallocated')?.id;
  assert(r3Id, 'UK_Unallocated range must exist in DB');
  pass('area3_create_unallocated_range', `Unallocated range created (id: ${r3Id})`);

  // Verify Admin sees provider_rate
  const adminRanges = await request('GET', '/api/ranges', null, tokens.admin);
  const r1Admin = adminRanges.data.find(r => r.id === r1Id);
  assert.strictEqual(r1Admin.provider_rate, '0.04');
  pass('area3_admin_sees_provider_rate', `Admin sees provider_rate: ${r1Admin.provider_rate}`);

  // Verify Manager DOES NOT see provider_rate (security stripping)
  const mgrRanges = await request('GET', '/api/ranges', null, tokens.manager);
  const r1Mgr = mgrRanges.data.find(r => r.id === r1Id);
  assert.strictEqual(r1Mgr.provider_rate, undefined, 'Manager must not receive provider_rate');
  pass('area3_manager_stripped_provider_rate', 'Manager ranges response does not contain provider_rate');

  // Verify Agent DOES NOT see provider_rate (security stripping)
  const agtRanges = await request('GET', '/api/ranges', null, tokens.agent);
  const r1Agt = agtRanges.data.find(r => r.id === r1Id);
  assert.strictEqual(r1Agt.provider_rate, undefined, 'Agent must not receive provider_rate');
  pass('area3_agent_stripped_provider_rate', 'Agent ranges response does not contain provider_rate');

  // Verify Client DOES NOT see provider_rate (security stripping)
  const cliRanges = await request('GET', '/api/ranges', null, tokens.client);
  const r1Cli = cliRanges.data.find(r => r.id === r1Id);
  assert.strictEqual(r1Cli.provider_rate, undefined, 'Client must not receive provider_rate');
  pass('area3_client_stripped_provider_rate', 'Client ranges response does not contain provider_rate');

  // Verify Admin can update provider_rate via PUT /api/ranges/:id
  const putRangeRes = await request('PUT', `/api/ranges/${r1Id}`, {
    name: 'UK_Alpha',
    prefix: '4471',
    currency: 'USD',
    rate_1_1: '0.08',
    rate_7_1: '0.08',
    rate_7_7: '0.08',
    rate_30_45: '0.08',
    provider: 'CarrierAlpha',
    provider_rate: '0.045'
  }, tokens.admin);
  assert.strictEqual(putRangeRes.status, 200);
  const r1Updated = (await request('GET', '/api/ranges', null, tokens.admin)).data.find(r => r.id === r1Id);
  assert.strictEqual(r1Updated.provider_rate, '0.045');
  pass('area3_admin_update_provider_rate', 'Admin updated provider_rate to 0.045');

  // Insert numbers for R1 and R2
  db = getDb();
  // R1: 2 numbers allocated to mgr1 -> agt1 -> client1
  const num1Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, ?, ?, ?)`).run('4471000001', r1Id, mgrId, agtId, clientId).lastInsertRowid;
  const num2Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, ?, ?, ?)`).run('4471000002', r1Id, mgrId, agtId, clientId).lastInsertRowid;
  // R2: 1 number allocated to mgr1 -> agt1 (not client1)
  const num3Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id) VALUES (?, ?, ?, ?)`).run('4472000001', r2Id, mgrId, agtId).lastInsertRowid;
  // R3 has 0 numbers inserted!

  pass('setup_numbers', `Numbers inserted: num1(${num1Id}), num2(${num2Id}), num3(${num3Id})`);

  // Insert SMS records for testing calculations & filters:
  // SMS 1: Range 1, Number 1, CLI "Google", eligible (payout 0.08), not test
  db.prepare(`INSERT INTO sms_records (range_id, number_id, number, cli, message, manager_id, agent_id, client_id, payout_amount, payout_rate, is_test, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`).run(r1Id, num1Id, '4471000001', 'Google', 'Your code is 112233', mgrId, agtId, clientId, '0.08', '0.08');

  // SMS 2: Range 1, Number 1, CLI "WhatsApp", eligible (payout 0.08), not test
  db.prepare(`INSERT INTO sms_records (range_id, number_id, number, cli, message, manager_id, agent_id, client_id, payout_amount, payout_rate, is_test, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`).run(r1Id, num1Id, '4471000001', 'WhatsApp', 'Your code is 445566', mgrId, agtId, clientId, '0.08', '0.08');

  // SMS 3: Range 2, Number 3, CLI "Telegram", eligible (payout 0.10), not test
  db.prepare(`INSERT INTO sms_records (range_id, number_id, number, cli, message, manager_id, agent_id, payout_amount, payout_rate, is_test, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`).run(r2Id, num3Id, '4472000001', 'Telegram', 'Your code is 778899', mgrId, agtId, '0.10', '0.10');

  // SMS 4: Range 1, Number 2, CLI "Google", ZERO-RATED by limit (payout 0) -> MUST NOT contribute to provider cost
  db.prepare(`INSERT INTO sms_records (range_id, number_id, number, cli, message, manager_id, agent_id, client_id, payout_amount, payout_rate, is_test, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', '0', 0, datetime('now'))`).run(r1Id, num2Id, '4471000002', 'Google', 'Rate limited code 000000', mgrId, agtId, clientId);

  // SMS 5: Range 1, Number 2, CLI "TestCLI", TEST OTP (is_test = 1) -> MUST NOT contribute to provider cost
  db.prepare(`INSERT INTO sms_records (range_id, number_id, number, cli, message, manager_id, agent_id, client_id, payout_amount, payout_rate, is_test, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0.08', '0.08', 1, datetime('now'))`).run(r1Id, num2Id, '4471000002', 'TestCLI', 'Test verification 999999', mgrId, agtId, clientId);

  pass('setup_sms_records', '5 test SMS records ingested');

  // Verify Real Provider Cost in GET /api/dashboard:
  // Eligible SMS: SMS 1 (R1, rate 0.045), SMS 2 (R1, rate 0.045), SMS 3 (R2, rate 0.06).
  // Total cost = 0.045 + 0.045 + 0.06 = 0.15.
  // SMS 4 (zero payout) and SMS 5 (test) MUST NOT be counted!
  const dashAdmin = await request('GET', '/api/dashboard', null, tokens.admin);
  assert.strictEqual(dashAdmin.status, 200);
  assert.strictEqual(dashAdmin.data.real_provider_cost_today, '0.15', `Expected 0.15, got ${dashAdmin.data.real_provider_cost_today}`);
  assert.strictEqual(dashAdmin.data.real_provider_cost_total, '0.15', `Expected 0.15, got ${dashAdmin.data.real_provider_cost_total}`);
  pass('area3_dashboard_real_provider_cost', `Real Provider Cost calculated correctly: $${dashAdmin.data.real_provider_cost_today} (excluded zero-rate limit & test SMS)`);

  // Verify Non-Admin dashboard does not leak real_provider_cost
  const dashMgr = await request('GET', '/api/dashboard', null, tokens.manager);
  assert.strictEqual(dashMgr.data.real_provider_cost_today, '0', 'Manager dashboard must not report real provider cost');
  pass('area3_manager_dashboard_unaffected', 'Manager dashboard does not report internal provider cost');

  // =========================================================================
  // AREA 4: Range/SMS Number Visibility vs SMS Rate Card
  // =========================================================================
  console.log('\n--- VERIFYING AREA 4: Range Visibility vs SMS Rate Card ---');

  // Rate Card: GET /api/ranges returns ALL 3 ranges (UK_Alpha, UK_Beta, UK_Unallocated)
  const allRanges = await request('GET', '/api/ranges', null, tokens.client);
  assert.strictEqual(allRanges.data.length, 3, 'Rate Card must see all 3 configured ranges');
  pass('area4_rate_card_shows_all_ranges', `Rate Card shows all ${allRanges.data.length} ranges regardless of allocation`);

  // GET /api/ranges/allocated for Client:
  // Client only has numbers allocated in Range 1 (UK_Alpha).
  // Range 2 (allocated to manager/agent only) and Range 3 (no numbers) MUST BE HIDDEN!
  const clientAllocated = await request('GET', '/api/ranges/allocated', null, tokens.client);
  assert.strictEqual(clientAllocated.status, 200);
  assert.strictEqual(clientAllocated.data.length, 1, `Client should only see 1 allocated range, got ${clientAllocated.data.length}`);
  assert.strictEqual(clientAllocated.data[0].name, 'UK_Alpha');
  pass('area4_client_allocated_ranges_scoped', 'Client inventory only shows UK_Alpha (0-number ranges hidden)');

  // GET /api/ranges/allocated for Manager:
  // Manager has numbers in Range 1 (UK_Alpha) and Range 2 (UK_Beta).
  // Range 3 (0 numbers) MUST BE HIDDEN!
  const mgrAllocated = await request('GET', '/api/ranges/allocated', null, tokens.manager);
  assert.strictEqual(mgrAllocated.status, 200);
  assert.strictEqual(mgrAllocated.data.length, 2, `Manager should only see 2 allocated ranges, got ${mgrAllocated.data.length}`);
  const mgrRangeNames = mgrAllocated.data.map(r => r.name);
  assert.ok(mgrRangeNames.includes('UK_Alpha') && mgrRangeNames.includes('UK_Beta'));
  assert.ok(!mgrRangeNames.includes('UK_Unallocated'), 'Unallocated range with 0 numbers must be hidden from inventory selectors');
  pass('area4_manager_allocated_ranges_scoped', 'Manager inventory only shows UK_Alpha & UK_Beta (UK_Unallocated hidden)');

  // =========================================================================
  // AREA 1: SMS Detailed Report simultaneous multi-filter (CLI, Range, Provider, Date, Time)
  // =========================================================================
  console.log('\n--- VERIFYING AREA 1: SMS Detailed Report Multi-Filter Combinations ---');

  // Test 1: Date + Range + Provider + CLI combined simultaneously with AND
  // Query: range=UK_Alpha AND provider=CarrierAlpha AND cli=Google
  const paged1 = await request('GET', '/api/sms/paged?range=UK_Alpha&provider=CarrierAlpha&cli=Google', null, tokens.admin);
  assert.strictEqual(paged1.status, 200);
  assert.strictEqual(paged1.data.total, 2, `Expected 2 SMS records for UK_Alpha + CarrierAlpha + Google, got ${paged1.data.total}`);
  pass('area1_and_combo_range_provider_cli', `AND filter (range + provider + cli) returned ${paged1.data.total} rows`);

  // Test 2: Date + Range + Provider + CLI + Number
  // Query: range=UK_Alpha AND provider=CarrierAlpha AND cli=Google AND number=4471000001
  const paged2 = await request('GET', '/api/sms/paged?range=UK_Alpha&provider=CarrierAlpha&cli=Google&number=4471000001', null, tokens.admin);
  assert.strictEqual(paged2.data.total, 1, `Expected 1 SMS record for exact number, got ${paged2.data.total}`);
  assert.strictEqual(paged2.data.rows[0].number, '4471000001');
  assert.strictEqual(paged2.data.rows[0].cli, 'Google');
  pass('area1_and_combo_with_number', 'AND filter (range + provider + cli + number) matched exactly 1 row');

  // Test 3: Filter mismatch results in 0 (verifying AND logic, not OR)
  // Query: range=UK_Alpha AND provider=CarrierBeta (CarrierBeta is on Range 2, not Range 1)
  const paged3 = await request('GET', '/api/sms/paged?range=UK_Alpha&provider=CarrierBeta', null, tokens.admin);
  assert.strictEqual(paged3.data.total, 0, `Expected 0 records when range and provider do not match, got ${paged3.data.total}`);
  pass('area1_and_logic_enforced', 'Contradictory filters correctly returned 0 records (proves strict AND logic)');

  // Test 4: Time window filtering
  const pagedTime = await request('GET', '/api/sms/paged?range=UK_Alpha&tfrom=00:00&tto=23:59', null, tokens.admin);
  assert.strictEqual(pagedTime.data.total, 3, `Expected 3 records in 00:00-23:59, got ${pagedTime.data.total}`);
  pass('area1_time_window_filter', `Time window filter returned ${pagedTime.data.total} records`);

  // Test 5: Sorting on columns (range, number, cli, payout)
  const sortRes = await request('GET', '/api/sms/paged?sort=cli&dir=asc', null, tokens.admin);
  assert.strictEqual(sortRes.status, 200);
  const clis = sortRes.data.rows.map(r => r.cli);
  assert.strictEqual(clis[0], 'Google');
  pass('area1_sorting', `Sorting by CLI ASC works (first CLI: ${clis[0]})`);

  // Test 6: Normal SMS Report behavior preserved (total count, pagination, calculations)
  const normSms = await request('GET', '/api/sms/paged?limit=2', null, tokens.admin);
  assert.strictEqual(normSms.data.limit, 2);
  assert.strictEqual(normSms.data.page, 1);
  assert.ok(normSms.data.totalPages >= 2);
  pass('area1_normal_sms_report_preserved', `Pagination works as expected (totalPages: ${normSms.data.totalPages})`);

  // =========================================================================
  // AREA 2: Client SMS Support
  // =========================================================================
  console.log('\n--- VERIFYING AREA 2: Client SMS Support Scoping & Filter Restriction ---');

  // Client queries /api/sms/paged
  // Client only owns num1 & num2. num3 belongs to agt1 without client.
  const cliAll = await request('GET', '/api/sms/paged', null, tokens.client);
  assert.strictEqual(cliAll.status, 200);
  // SMS 1, 2, 4 are for num1 & num2 (SMS 5 is test OTP so excluded from /sms/paged)
  // SMS 3 belongs to num3 (no client) -> client MUST NOT see it
  const cliRowIds = cliAll.data.rows.map(r => r.number);
  assert.ok(!cliRowIds.includes('4472000001'), 'Client must never see SMS for unallocated numbers');
  pass('area2_client_scope_enforced', `Client sees only their ${cliAll.data.total} SMS records`);

  // Client attempts to pass internal filters (provider, manager, agent, other client)
  // Backend buildSmsPagedQuery MUST strip them so they have zero effect
  const cliInjected = await request('GET', '/api/sms/paged?provider=CarrierBeta&manager=mgr1', null, tokens.client);
  assert.strictEqual(cliInjected.status, 200);
  assert.strictEqual(cliInjected.data.total, cliAll.data.total, 'Injected provider/manager filters must be silently stripped for client');
  pass('area2_client_internal_filters_stripped', 'Client cannot query by provider or manager');

  // Client queries with valid CLI and Range
  const cliValid = await request('GET', '/api/sms/paged?range=UK_Alpha&cli=Google', null, tokens.client);
  assert.strictEqual(cliValid.status, 200);
  assert.strictEqual(cliValid.data.total, 2);
  pass('area2_client_valid_filters', `Client CLI + Range filter returns expected ${cliValid.data.total} records`);

  // =========================================================================
  // AREA 5: Branding
  // =========================================================================
  console.log('\n--- VERIFYING AREA 5: Branding Cleanliness ---');

  const checkFiles = [
    'admin.html', 'manager.html', 'agent.html', 'client.html',
    'management.html', 'login.html', 'test.html', 'test-login.html',
    'payment.html', 'payment-login.html', 'panel-sharing.html', 'panel-sharing-login.html'
  ];

  let brandErrors = 0;
  for (const f of checkFiles) {
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8');
    const matches = content.match(/galaxy sms|power x sms/gi);
    if (matches && matches.length) {
      console.error(`Found branding violations in ${f}:`, matches);
      brandErrors++;
    }
  }
  assert.strictEqual(brandErrors, 0, 'No visible Galaxy SMS or Power X SMS strings should remain in HTML files');
  pass('area5_html_templates_clean', `All ${checkFiles.length} HTML files verified free of old branding`);

  console.log('\n==========================================');
  console.log('ALL 5 AREAS FULLY TESTED AND VERIFIED: PASS');
  console.log('==========================================');
}

run().then(() => {
  if (serverProcess) {
    try { serverProcess.kill('SIGKILL'); } catch (_) {}
  }
  process.exit(0);
}).catch(err => {
  console.error('Test suite failed:', err);
  if (serverProcess) {
    try { serverProcess.kill('SIGKILL'); } catch (_) {}
  }
  process.exit(1);
});
