const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const TEST_DB = '/tmp/test_sms_report_filters_' + Date.now() + '.db';
const TEST_PORT = 8099;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SUFFIX = Date.now().toString(36);

try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (_) {}
try { if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
try { if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}

let serverProcess = null;
let tokens = {};

function request(method, pathUrl, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log(`Starting SMS Report Filters & Responsive Test Suite on port ${TEST_PORT}...`);

  // Start server
  serverProcess = spawn('node', ['backend/server.js'], {
    env: { ...process.env, PORT: String(TEST_PORT), DB_FILE: TEST_DB, JWT_SECRET: 'test-secret-report-filters', NODE_ENV: 'test' },
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', (d) => {
    const s = d.toString();
    console.log('[Server Out]', s.trim());
    if (s.includes('Skyline SMS backend running')) {
      console.log('✓ Backend server running');
    }
  });

  serverProcess.stderr.on('data', (d) => {
    // console.error('[Server Err]', d.toString());
  });

  // Wait for server to come online
  let online = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) { online = true; break; }
    } catch (_) {}
  }
  if (!online) throw new Error('Server failed to start');
  console.log('PASS | server_start | Backend online');

  await new Promise(r => setTimeout(r, 300));
  const db = new Database(TEST_DB);
  db.pragma('foreign_keys = OFF');

  // Authenticate admin
  const loginRes = await request('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' });
  assert.strictEqual(loginRes.status, 200, 'Admin login should succeed');
  tokens.admin = loginRes.data.token;
  const adminUser = loginRes.data.user;
  console.log('PASS | auth_admin | Admin logged in');

  // Manager
  const mgrUsername = 'mgr_' + SUFFIX;
  const mgrRes = await request('POST', '/api/users', {
    username: mgrUsername,
    password: 'password123',
    role: 'manager',
    name: 'Test Manager'
  }, tokens.admin);
  const mgrList = await request('GET', '/api/users/manager', null, tokens.admin);
  const mgrUser = (mgrList.data || []).find(u => u.username === mgrUsername);
  assert(mgrUser, 'Manager user should exist in /api/users/manager');
  const mgrLogin = await request('POST', '/api/login', { username: mgrUsername, password: 'password123' });
  tokens.manager = mgrLogin.data.token;

  // Agent
  const agtUsername = 'agt_' + SUFFIX;
  const agtRes = await request('POST', '/api/users', {
    username: agtUsername,
    password: 'password123',
    role: 'agent',
    name: 'Test Agent',
    parent_id: mgrUser.id
  }, tokens.admin);
  const agtList = await request('GET', '/api/users/agent', null, tokens.admin);
  const agtUser = (agtList.data || []).find(u => u.username === agtUsername);
  assert(agtUser, 'Agent user should exist in /api/users/agent');
  const agtLogin = await request('POST', '/api/login', { username: agtUsername, password: 'password123' });
  tokens.agent = agtLogin.data.token;

  // Client
  const cliUsername = 'cli_' + SUFFIX;
  const cliRes = await request('POST', '/api/users', {
    username: cliUsername,
    password: 'password123',
    role: 'client',
    name: 'Test Client',
    parent_id: agtUser.id
  }, tokens.admin);
  const cliList = await request('GET', '/api/users/client', null, tokens.admin);
  const cliUser = (cliList.data || []).find(u => u.username === cliUsername);
  assert(cliUser, 'Client user should exist in /api/users/client');
  const cliLogin = await request('POST', '/api/login', { username: cliUsername, password: 'password123' });
  tokens.client = cliLogin.data.token;
  console.log('PASS | setup_users | Manager, Agent, Client users created & authenticated');

  // Seed ranges
  const r1Res = await request('POST', '/api/ranges', {
    name: 'Range_Alpha',
    prefix: '4470',
    currency: 'USD',
    rate_1_1: '0.05',
    rate_7_1: '0.05',
    rate_7_7: '0.05',
    rate_30_45: '0.05',
    provider: 'TestCarrier'
  }, tokens.admin);

  const r2Res = await request('POST', '/api/ranges', {
    name: 'Range_Beta',
    prefix: '4471',
    currency: 'USD',
    rate_1_1: '0.06',
    rate_7_1: '0.06',
    rate_7_7: '0.06',
    rate_30_45: '0.06',
    provider: 'TestCarrier'
  }, tokens.admin);

  const r3Res = await request('POST', '/api/ranges', {
    name: 'Range_Gamma',
    prefix: '4472',
    currency: 'USD',
    rate_1_1: '0.07',
    rate_7_1: '0.07',
    rate_7_7: '0.07',
    rate_30_45: '0.07',
    provider: 'TestCarrier'
  }, tokens.admin);

  const rangesList = (await request('GET', '/api/ranges', null, tokens.admin)).data;
  const rangeA = rangesList.find(r => r.name === 'Range_Alpha').id;
  const rangeB = rangesList.find(r => r.name === 'Range_Beta').id;
  const rangeC = rangesList.find(r => r.name === 'Range_Gamma').id;

  // Seed numbers
  const num1Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('447000000001', ?, ?, ?, ?)`).run(rangeA, mgrUser.id, agtUser.id, cliUser.id).lastInsertRowid;
  const num2Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('447000000002', ?, ?, ?, ?)`).run(rangeA, mgrUser.id, agtUser.id, cliUser.id).lastInsertRowid;
  const num3Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('447100000003', ?, ?, ?, NULL)`).run(rangeB, mgrUser.id, agtUser.id).lastInsertRowid;
  const num4Id = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('447200000004', ?, NULL, NULL, NULL)`).run(rangeC).lastInsertRowid;
  console.log('PASS | setup_inventory | Ranges & numbers seeded with hierarchy');

  // Seed SMS records
  const insertSms = db.prepare(`
    INSERT INTO sms_records (received_at, number, cli, message, otp_code, range_id, client_id, agent_id, manager_id, payout_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Record 1: Date 2026-09-01 10:00:00, Range A, Num1, CLI "GOOGLE", msg "Code 111"
  insertSms.run('2026-09-01 10:00:00', '447000000001', 'GOOGLE', 'Code 111', '111', rangeA, cliUser.id, agtUser.id, mgrUser.id, '0.05');

  // Record 2: Date 2026-09-01 11:00:00, Range A, Num1, CLI "WHATSAPP", msg "Code 222"
  insertSms.run('2026-09-01 11:00:00', '447000000001', 'WHATSAPP', 'Code 222', '222', rangeA, cliUser.id, agtUser.id, mgrUser.id, '0.05');

  // Record 3: Date 2026-09-01 12:00:00, Range A, Num2, CLI "GOOGLE", msg "Code 333"
  insertSms.run('2026-09-01 12:00:00', '447000000002', 'GOOGLE', 'Code 333', '333', rangeA, cliUser.id, agtUser.id, mgrUser.id, '0.05');

  // Record 4: Date 2026-09-02 10:00:00, Range A, Num1, CLI "GOOGLE", msg "Code 444"
  insertSms.run('2026-09-02 10:00:00', '447000000001', 'GOOGLE', 'Code 444', '444', rangeA, cliUser.id, agtUser.id, mgrUser.id, '0.05');

  // Record 5: Date 2026-09-02 14:00:00, Range B, Num3, CLI "TELEGRAM", msg "Code 555"
  insertSms.run('2026-09-02 14:00:00', '447100000003', 'TELEGRAM', 'Code 555', '555', rangeB, null, agtUser.id, mgrUser.id, '0.06');

  // Record 6: Date 2026-09-03 16:00:00, Range C, Num4, CLI "MICROSOFT", msg "Code 666"
  insertSms.run('2026-09-03 16:00:00', '447200000004', 'MICROSOFT', 'Code 666', '666', rangeC, null, null, null, '0.07');

  console.log('PASS | setup_sms | 6 SMS records seeded across dates, ranges, numbers, CLIs');

  // =========================================================================
  // PART 1: TEST ALL 15 FILTER COMBINATIONS ON /sms/paged
  // =========================================================================
  console.log('\n--- VERIFYING ALL 15 FILTER COMBINATIONS (Strict AND Logic) ---');

  // 1. Date only
  const c1 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01', null, tokens.admin);
  assert.strictEqual(c1.data.total, 3, 'Combo 1: Date only should return 3 records (1, 2, 3)');
  console.log('PASS | combo1_date_only | Returned 3 records');
  console.log('PASS | combo1_date_only | Returned 3 records');

  // 2. Range only
  const c2 = await request('GET', '/api/sms/paged?range=Range_Alpha', null, tokens.admin);
  assert.strictEqual(c2.data.total, 4, 'Combo 2: Range only should return 4 records (1, 2, 3, 4)');
  console.log('PASS | combo2_range_only | Returned 4 records');

  // 3. Number only
  const c3 = await request('GET', '/api/sms/paged?number=447000000001', null, tokens.admin);
  assert.strictEqual(c3.data.total, 3, 'Combo 3: Number only should return 3 records (1, 2, 4)');
  console.log('PASS | combo3_number_only | Returned 3 records');

  // 4. CLI only
  const c4 = await request('GET', '/api/sms/paged?cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c4.data.total, 3, 'Combo 4: CLI only should return 3 records (1, 3, 4)');
  console.log('PASS | combo4_cli_only | Returned 3 records');

  // 5. Date + Range
  const c5 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&range=Range_Alpha', null, tokens.admin);
  assert.strictEqual(c5.data.total, 3, 'Combo 5: Date + Range should return 3 records');
  console.log('PASS | combo5_date_range | Returned 3 records');

  // 6. Date + Number
  const c6 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&number=447000000001', null, tokens.admin);
  assert.strictEqual(c6.data.total, 2, 'Combo 6: Date + Number should return 2 records (1, 2)');
  console.log('PASS | combo6_date_number | Returned 2 records');

  // 7. Date + CLI
  const c7 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c7.data.total, 2, 'Combo 7: Date + CLI should return 2 records (1, 3)');
  console.log('PASS | combo7_date_cli | Returned 2 records');

  // 8. Range + Number
  const c8 = await request('GET', '/api/sms/paged?range=Range_Alpha&number=447000000001', null, tokens.admin);
  assert.strictEqual(c8.data.total, 3, 'Combo 8: Range + Number should return 3 records (1, 2, 4)');
  console.log('PASS | combo8_range_number | Returned 3 records');

  // 9. Range + CLI
  const c9 = await request('GET', '/api/sms/paged?range=Range_Alpha&cli=WHATSAPP', null, tokens.admin);
  assert.strictEqual(c9.data.total, 1, 'Combo 9: Range + CLI should return 1 record (2)');
  console.log('PASS | combo9_range_cli | Returned 1 record');

  // 10. Number + CLI
  const c10 = await request('GET', '/api/sms/paged?number=447000000001&cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c10.data.total, 2, 'Combo 10: Number + CLI should return 2 records (1, 4)');
  console.log('PASS | combo10_number_cli | Returned 2 records');

  // 11. Date + Range + Number
  const c11 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&range=Range_Alpha&number=447000000001', null, tokens.admin);
  assert.strictEqual(c11.data.total, 2, 'Combo 11: Date + Range + Number should return 2 records (1, 2)');
  console.log('PASS | combo11_date_range_number | Returned 2 records');

  // 12. Date + Range + CLI
  const c12 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&range=Range_Alpha&cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c12.data.total, 2, 'Combo 12: Date + Range + CLI should return 2 records (1, 3)');
  console.log('PASS | combo12_date_range_cli | Returned 2 records');

  // 13. Date + Number + CLI
  const c13 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&number=447000000001&cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c13.data.total, 1, 'Combo 13: Date + Number + CLI should return 1 record (1)');
  console.log('PASS | combo13_date_number_cli | Returned 1 record');

  // 14. Range + Number + CLI
  const c14 = await request('GET', '/api/sms/paged?range=Range_Alpha&number=447000000001&cli=WHATSAPP', null, tokens.admin);
  assert.strictEqual(c14.data.total, 1, 'Combo 14: Range + Number + CLI should return 1 record (2)');
  console.log('PASS | combo14_range_number_cli | Returned 1 record');

  // 15. All 4 filters simultaneous (Date + Range + Number + CLI)
  const c15 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&range=Range_Alpha&number=447000000001&cli=GOOGLE', null, tokens.admin);
  assert.strictEqual(c15.data.total, 1, 'Combo 15: All 4 filters simultaneous should match exactly record 1');
  assert.strictEqual(c15.data.rows[0].otp_code, '111');
  console.log('PASS | combo15_all_four_filters | Returned exactly matching record (1)');

  // 16. Strict AND logic validation (contradictory / non-matching returns 0)
  const c16 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&range=Range_Alpha&number=447000000001&cli=TELEGRAM', null, tokens.admin);
  assert.strictEqual(c16.data.total, 0, 'Strict AND logic must return 0 records when CLI does not match');
  console.log('PASS | strict_and_zero_results | Contradictory filters correctly returned 0 records');

  // =========================================================================
  // ROLE SCOPING TESTS
  // =========================================================================
  console.log('\n--- VERIFYING ROLE SCOPING ON /sms/paged ---');
  // Manager should see Records 1-5 (assigned), but NOT Record 6 (unassigned Range C)
  const mgrRes1 = await request('GET', '/api/sms/paged', null, tokens.manager);
  assert.strictEqual(mgrRes1.data.total, 5, 'Manager should see only 5 records');
  const mgrHasRangeC = mgrRes1.data.rows.some(r => r.range_name === 'Range_Gamma');
  assert.strictEqual(mgrHasRangeC, false, 'Manager must never see Range_Gamma');
  console.log('PASS | manager_scope_enforced | Manager sees 5 records and Range C is blocked');

  // Manager filter test with CLI + Date
  const mgrRes2 = await request('GET', '/api/sms/paged?from=2026-09-01&to=2026-09-01&cli=GOOGLE', null, tokens.manager);
  assert.strictEqual(mgrRes2.data.total, 2, 'Manager sees exactly 2 GOOGLE records on 2026-09-01');
  console.log('PASS | manager_filters_working | Manager CLI + Date filter verified');

  // Agent should see Records 1-5, but NOT Record 6
  const agtRes1 = await request('GET', '/api/sms/paged', null, tokens.agent);
  assert.strictEqual(agtRes1.data.total, 5, 'Agent should see only 5 records');
  const agtHasRangeC = agtRes1.data.rows.some(r => r.range_name === 'Range_Gamma');
  assert.strictEqual(agtHasRangeC, false, 'Agent must never see Range_Gamma');
  console.log('PASS | agent_scope_enforced | Agent sees 5 records and Range C is blocked');

  // Client should see only Records 1-4 (assigned to cliUser)
  const cliRes1 = await request('GET', '/api/sms/paged', null, tokens.client);
  assert.strictEqual(cliRes1.data.total, 4, 'Client should see only 4 records');
  console.log('PASS | client_scope_enforced | Client sees only their 4 records');

  // =========================================================================
  // FRONTEND DOM ELEMENT TESTS
  // =========================================================================
  console.log('\n--- VERIFYING FRONTEND TEMPLATES & HTML ELEMENT STRUCTURE ---');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const managerHtml = fs.readFileSync('manager.html', 'utf8');
  const agentHtml = fs.readFileSync('agent.html', 'utf8');
  const clientHtml = fs.readFileSync('client.html', 'utf8');

  // Admin checks
  assert(adminHtml.includes('id="srCli"'), 'admin.html must contain #srCli');
  assert(adminHtml.includes('id="srRange"'), 'admin.html must contain #srRange');
  assert(adminHtml.includes('id="srNumber"'), 'admin.html must contain #srNumber');
  assert(adminHtml.includes('id="srFrom"'), 'admin.html must contain #srFrom');
  assert(adminHtml.includes('id="srTo"'), 'admin.html must contain #srTo');
  assert(adminHtml.includes('class="filter-item"'), 'admin.html must use .filter-item');
  assert(adminHtml.includes('class="filter-btn-group"'), 'admin.html must use .filter-btn-group');
  assert(adminHtml.includes("if(cliVal)params.set('cli',cliVal);"), 'admin.html must forward cliVal to /sms/paged');
  console.log('PASS | admin_html_structure | admin.html contains all 4 filters and responsive markup');

  // Manager checks
  assert(managerHtml.includes('id="srCli"'), 'manager.html must contain #srCli');
  assert(managerHtml.includes('id="srRange"'), 'manager.html must contain #srRange');
  assert(managerHtml.includes('id="srNumber"'), 'manager.html must contain #srNumber');
  assert(managerHtml.includes('id="srFrom"'), 'manager.html must contain #srFrom');
  assert(managerHtml.includes('id="srTo"'), 'manager.html must contain #srTo');
  assert(managerHtml.includes('class="filter-item"'), 'manager.html must use .filter-item');
  assert(managerHtml.includes('class="filter-btn-group"'), 'manager.html must use .filter-btn-group');
  assert(managerHtml.includes("if(cliVal)params.set('cli',cliVal);"), 'manager.html must forward cliVal to /sms/paged');
  console.log('PASS | manager_html_structure | manager.html contains all 4 filters and responsive markup');

  // Agent checks
  assert(agentHtml.includes('id="srCli"'), 'agent.html must contain #srCli');
  assert(agentHtml.includes('id="srRange"'), 'agent.html must contain #srRange');
  assert(agentHtml.includes('id="srNumber"'), 'agent.html must contain #srNumber');
  assert(agentHtml.includes('id="srFrom"'), 'agent.html must contain #srFrom');
  assert(agentHtml.includes('id="srTo"'), 'agent.html must contain #srTo');
  assert(agentHtml.includes('class="filter-item"'), 'agent.html must use .filter-item');
  assert(agentHtml.includes('class="filter-btn-group"'), 'agent.html must use .filter-btn-group');
  assert(agentHtml.includes("if(cliVal)params.set('cli',cliVal);"), 'agent.html must forward cliVal to /sms/paged');
  console.log('PASS | agent_html_structure | agent.html contains all 4 filters and responsive markup');

  // Client checks
  assert(clientHtml.includes('id="stCli"'), 'client.html must contain #stCli');
  assert(clientHtml.includes('id="stRange"'), 'client.html must contain #stRange');
  assert(clientHtml.includes('id="stFrom"'), 'client.html must contain #stFrom');
  assert(clientHtml.includes('id="stTo"'), 'client.html must contain #stTo');
  assert(clientHtml.includes('class="filter-item"'), 'client.html must use .filter-item');
  assert(clientHtml.includes('class="filter-btn-group"'), 'client.html must use .filter-btn-group');
  console.log('PASS | client_html_structure | client.html contains filters and responsive markup');

  // =========================================================================
  // PUPPETEER RESPONSIVE RENDERING & OVERFLOW TESTS
  // =========================================================================
  console.log('\n--- VERIFYING RESPONSIVE VIEWPORTS WITH PUPPETEER ---');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const viewports = [
    { name: '320px Mobile S', width: 320, height: 640 },
    { name: '360px Mobile M', width: 360, height: 640 },
    { name: '375px iPhone X', width: 375, height: 667 },
    { name: '390px iPhone 12/13/14', width: 390, height: 844 },
    { name: '414px iPhone XR/Max', width: 414, height: 896 },
    { name: '768px Tablet', width: 768, height: 1024 },
    { name: '1280px Desktop', width: 1280, height: 800 }
  ];

  const pagesToTest = [
    { role: 'admin', url: `${BASE}/admin`, token: tokens.admin, pageId: 'smsReport' },
    { role: 'manager', url: `${BASE}/manager`, token: tokens.manager, pageId: 'smsReport' },
    { role: 'agent', url: `${BASE}/agent`, token: tokens.agent, pageId: 'smsReport' },
    { role: 'client', url: `${BASE}/client`, token: tokens.client, pageId: 'stats' }
  ];

  for (const pageCfg of pagesToTest) {
    const page = await browser.newPage();
    page.on('console', msg => console.log(`[Browser ${pageCfg.role}]`, msg.type(), msg.text()));
    page.on('pageerror', err => console.log(`[Browser ${pageCfg.role} ERR]`, err.message));

    // Set auth in localStorage / sessionStorage before navigation
    await page.goto(`${BASE}/panel-login`);
    await page.evaluate((tok, role) => {
      sessionStorage.setItem('ms_token', tok);
      sessionStorage.setItem('ms_role', role);
      localStorage.setItem('ms_token', tok);
      localStorage.setItem('ms_role', role);
    }, pageCfg.token, pageCfg.role);

    await page.goto(pageCfg.url, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 600));

    // Navigate to the target report page
    const navResult = await page.evaluate((pid) => {
      const hasShowPage = typeof showPage === 'function';
      if (hasShowPage) showPage(pid);
      if (pid === 'smsReport' && typeof buildSmsReport === 'function') {
        if (!document.getElementById('srFrom')) buildSmsReport();
      }
      return {
        hasShowPage,
        hasBuildSmsReport: typeof buildSmsReport === 'function',
        hasSrFrom: !!document.getElementById('srFrom'),
        currentUrl: location.href
      };
    }, pageCfg.pageId);
    console.log(`  [Puppeteer Nav] ${pageCfg.role}:`, navResult);
    await new Promise(r => setTimeout(r, 600));

    console.log(`\nTesting ${pageCfg.role} panel on viewports:`);

    for (const vp of viewports) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await new Promise(r => setTimeout(r, 300));

      const overflowCheck = await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        const scrollWidth = Math.max(body.scrollWidth, html.scrollWidth);
        const clientWidth = html.clientWidth;
        // Check filter container
        const filterRow = document.querySelector('.filter-row');
        const filterRowWidth = filterRow ? filterRow.scrollWidth : 0;
        const filterRowClient = filterRow ? filterRow.clientWidth : 0;
        return {
          scrollWidth,
          clientWidth,
          hasOverflow: scrollWidth > clientWidth + 2,
          filterRowWidth,
          filterRowClient
        };
      });

      assert(!overflowCheck.hasOverflow, `Horizontal overflow detected in ${pageCfg.role} at ${vp.name}! scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth}`);
      console.log(`  ✓ ${vp.name} (${vp.width}x${vp.height}): No horizontal overflow (scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth})`);
    }

    // Verify filter elements are present and interactive
    const filterElementsVisible = await page.evaluate((isClient) => {
      const from = document.getElementById(isClient ? 'stFrom' : 'srFrom');
      const to = document.getElementById(isClient ? 'stTo' : 'srTo');
      const range = document.getElementById(isClient ? 'stRange' : 'srRange');
      const cli = document.getElementById(isClient ? 'stCli' : 'srCli');
      return {
        hasFrom: !!from,
        hasTo: !!to,
        hasRange: !!range,
        hasCli: !!cli
      };
    }, pageCfg.role === 'client');

    assert(filterElementsVisible.hasFrom, `${pageCfg.role}: From input must exist`);
    assert(filterElementsVisible.hasTo, `${pageCfg.role}: To input must exist`);
    assert(filterElementsVisible.hasRange, `${pageCfg.role}: Range dropdown must exist`);
    assert(filterElementsVisible.hasCli, `${pageCfg.role}: CLI dropdown must exist`);
    console.log(`  ✓ Filter inputs successfully verified on ${pageCfg.role}`);

    await page.close();
  }

  await browser.close();
  console.log('\nPASS | puppeteer_responsive_viewports | All 7 viewports verified across 4 panels with zero horizontal overflow');

  console.log('\n========================================================================');
  console.log('ALL TESTS PASSED: SMS REPORT FILTERS & RESPONSIVE LAYOUT VERIFIED!');
  console.log('========================================================================\n');
}

main().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
}).finally(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (_) {}
  try { if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
  try { if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
});
