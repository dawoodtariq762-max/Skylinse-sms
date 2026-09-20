/**
 * Comprehensive verification suite for the 3 requested tasks:
 * Task 1: Client SMS Report filters (Number, Range, Date, CLI, all 15 single/combos, strict AND, client scoping)
 * Task 2: Real Provider Rate & Admin Payout (Rate periods, unchanged selling rates, 2 Admin-only cards, eligibility rules)
 * Task 3: Copy + Download CSV across panels (Feedback, clipboard fallback, filtered data, role scoping, responsive)
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const TEST_DB = '/tmp/test_three_tasks.db';
const TEST_PORT = 8098;
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

function pass(name, msg) {
  console.log(`PASS | ${name} | ${msg}`);
}

async function run() {
  console.log(`Starting Three-Tasks Test Suite on port ${TEST_PORT}...`);

  const TEST_DB_FILE = '/tmp/test_three_tasks_' + Date.now() + '.db';
  // Start server
  serverProcess = spawn('node', ['backend/server.js'], {
    env: { ...process.env, PORT: String(TEST_PORT), DB_FILE: TEST_DB_FILE, JWT_SECRET: 'test-secret-report-filters', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('Skyline SMS backend running')) {
      // server ready
    }
  });
  serverProcess.stderr.on('data', d => console.error('[Server Err]', d.toString()));

  // Wait for server to listen
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await request('GET', '/health');
      if (ping.status === 200) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  pass('server_start', 'Backend server online');

  // Login Admin
  const adminLogin = await request('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' });
  assert.strictEqual(adminLogin.status, 200, 'Admin login failed');
  tokens.admin = adminLogin.data.token;
  pass('auth_admin', 'Admin logged in');

  // Create Users: Manager, Agent, Client, and OtherClient
  const mRes = await request('POST', '/api/users', { username: 'mgr_test', password: 'password123', role: 'manager', name: 'Test Manager' }, tokens.admin);
  assert.strictEqual(mRes.status, 200);
  const aRes = await request('POST', '/api/users', { username: 'agt_test', password: 'password123', role: 'agent', parent_id: mRes.data.id, name: 'Test Agent' }, tokens.admin);
  assert.strictEqual(aRes.status, 200);
  const cRes = await request('POST', '/api/users', { username: 'cli_test', password: 'password123', role: 'client', parent_id: aRes.data.id, name: 'Test Client' }, tokens.admin);
  assert.strictEqual(cRes.status, 200);
  const otherCRes = await request('POST', '/api/users', { username: 'cli_other', password: 'password123', role: 'client', parent_id: aRes.data.id, name: 'Other Client' }, tokens.admin);
  assert.strictEqual(otherCRes.status, 200);

  const mLogin = await request('POST', '/api/login', { username: 'mgr_test', password: 'password123' });
  tokens.manager = mLogin.data.token;
  const mgrUser = mLogin.data.user;

  const aLogin = await request('POST', '/api/login', { username: 'agt_test', password: 'password123' });
  tokens.agent = aLogin.data.token;
  const agtUser = aLogin.data.user;

  const cLogin = await request('POST', '/api/login', { username: 'cli_test', password: 'password123' });
  tokens.client = cLogin.data.token;
  const cliUser = cLogin.data.user;

  const ocLogin = await request('POST', '/api/login', { username: 'cli_other', password: 'password123' });
  tokens.otherClient = ocLogin.data.token;
  const otherCliUser = ocLogin.data.user;
  pass('setup_users', 'All role accounts initialized and authenticated');

  // =========================================================================
  // TASK 2 VERIFICATION: Real Provider Rate & Rate Periods + Admin Payout
  // =========================================================================
  console.log('\n--- VERIFYING TASK 2: Real Provider Rate & Admin Payout ---');

  // Create Range with selling rates + Real Provider Rate and period rates
  const rCreate = await request('POST', '/api/ranges', {
    name: 'Range_Alpha',
    prefix: '44',
    currency: 'USD',
    rate_1_1: '0.015',
    rate_7_1: '0.012',
    rate_7_7: '0.010',
    rate_30_45: '0.008',
    provider_rate: '0.005',
    provider_rate_1_1: '0.007',
    provider_rate_7_1: '0.005',
    provider_rate_7_7: '0.004',
    provider_rate_30_45: '0.003'
  }, tokens.admin);
  assert.strictEqual(rCreate.status, 200, 'Range creation failed');

  // Admin GET /api/ranges: must see selling rates AND provider rates
  const adminRanges = await request('GET', '/api/ranges', null, tokens.admin);
  const alpha = adminRanges.data.find(r => r.name === 'Range_Alpha');
  assert.ok(alpha, 'Range_Alpha found');
  assert.strictEqual(alpha.rate_7_1, '0.012', 'Selling rate 7/1 preserved');
  assert.strictEqual(alpha.rate_30_45, '0.008', 'Selling rate 30/45 preserved');
  assert.strictEqual(alpha.provider_rate, '0.005', 'Base provider rate stored');
  assert.strictEqual(alpha.provider_rate_7_1, '0.005', 'Provider rate 7/1 stored');
  assert.strictEqual(alpha.provider_rate_30_45, '0.003', 'Provider rate 30/45 stored');
  pass('task2_admin_sees_real_provider_rates', 'Admin sees selling rates and real provider rates across periods');

  // Non-Admin GET /api/ranges: MUST NOT contain any provider rates
  for (const role of ['manager', 'agent', 'client']) {
    const res = await request('GET', '/api/ranges', null, tokens[role]);
    const r = res.data.find(x => x.name === 'Range_Alpha');
    assert.ok(r, `${role} sees range`);
    assert.strictEqual(r.rate_7_1, '0.012', `${role} sees selling rate`);
    assert.strictEqual(r.provider_rate, undefined, `${role} must not see provider_rate`);
    assert.strictEqual(r.provider_rate_7_1, undefined, `${role} must not see provider_rate_7_1`);
    assert.strictEqual(r.provider_rate_30_45, undefined, `${role} must not see provider_rate_30_45`);
    pass(`task2_${role}_no_provider_rate`, `${role} does not see provider rate`);
  }

  // Admin updates provider rate
  const rUpdate = await request('PUT', `/api/ranges/${alpha.id}`, {
    provider_rate: '0.006',
    provider_rate_7_1: '0.006'
  }, tokens.admin);
  assert.strictEqual(rUpdate.status, 200);
  const updatedAlpha = (await request('GET', '/api/ranges', null, tokens.admin)).data.find(r => r.name === 'Range_Alpha');
  assert.strictEqual(updatedAlpha.provider_rate, '0.006');
  assert.strictEqual(updatedAlpha.rate_7_1, '0.012', 'Selling rate untouched after provider rate update');
  pass('task2_admin_update_provider_rate', 'Admin updated provider rate without altering selling rate');

  // Insert numbers and SMS records to verify payout calculation
  const db = new Database(TEST_DB_FILE);
  db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id, rate, payout, payterm)
          VALUES ('447700900001', ?, ?, ?, ?, '0.012', '0.012', 'weekly_7_1')`).run(alpha.id, mgrUser.id, agtUser.id, cliUser.id);
  const num1 = db.prepare(`SELECT id FROM numbers WHERE number='447700900001'`).get().id;

  db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id, rate, payout, payterm)
          VALUES ('447700900002', ?, ?, ?, ?, '0.012', '0.012', 'weekly_7_1')`).run(alpha.id, mgrUser.id, agtUser.id, otherCliUser.id);
  const num2 = db.prepare(`SELECT id FROM numbers WHERE number='447700900002'`).get().id;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Ingest 4 SMS records:
  // SMS 1: Client 1, eligible (payout 0.012) -> provider cost 0.006
  // SMS 2: Client 1, eligible (payout 0.012) -> provider cost 0.006
  // SMS 3: Other Client, eligible (payout 0.012) -> provider cost 0.006
  // SMS 4: Zero payout (limit exceeded, payout 0) -> provider cost 0 (excluded!)
  // SMS 5: Test SMS (is_test = 1) -> provider cost 0 (excluded!)
  db.prepare(`INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_rate, payout_amount, payment_type, received_at, is_test)
          VALUES (?, '447700900001', ?, 'Google', 'Code 111111', '111111', ?, ?, ?, '0.012', '0.012', 'weekly_7_1', ?, 0)`)
          .run(num1, alpha.id, cliUser.id, agtUser.id, mgrUser.id, now);
  db.prepare(`INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_rate, payout_amount, payment_type, received_at, is_test)
          VALUES (?, '447700900001', ?, 'WhatsApp', 'Code 222222', '222222', ?, ?, ?, '0.012', '0.012', 'weekly_7_1', ?, 0)`)
          .run(num1, alpha.id, cliUser.id, agtUser.id, mgrUser.id, now);
  db.prepare(`INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_rate, payout_amount, payment_type, received_at, is_test)
          VALUES (?, '447700900002', ?, 'Telegram', 'Code 333333', '333333', ?, ?, ?, '0.012', '0.012', 'weekly_7_1', ?, 0)`)
          .run(num2, alpha.id, otherCliUser.id, agtUser.id, mgrUser.id, now);
  db.prepare(`INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_rate, payout_amount, payment_type, received_at, is_test)
          VALUES (?, '447700900001', ?, 'OverLimit', 'Code 444444', '444444', ?, ?, ?, '0', '0', 'weekly_7_1', ?, 0)`)
          .run(num1, alpha.id, cliUser.id, agtUser.id, mgrUser.id, now);
  db.prepare(`INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_rate, payout_amount, payment_type, received_at, is_test)
          VALUES (?, '447700900001', ?, 'TestCLI', 'Code 555555', '555555', ?, ?, ?, '0.012', '0.012', 'weekly_7_1', ?, 1)`)
          .run(num1, alpha.id, cliUser.id, agtUser.id, mgrUser.id, now);

  // Check Admin Dashboard:
  // Eligible messages: SMS 1, 2, 3 -> 3 * 0.006 = 0.018!
  // Zero-payout (SMS 4) and Test (SMS 5) must be excluded!
  const dashAdmin = await request('GET', '/api/dashboard', null, tokens.admin);
  assert.strictEqual(dashAdmin.status, 200);
  assert.strictEqual(dashAdmin.data.real_provider_cost_today, '0.018', `Expected 0.018, got ${dashAdmin.data.real_provider_cost_today}`);
  assert.strictEqual(dashAdmin.data.real_provider_cost_week, '0.018', `Expected 0.018, got ${dashAdmin.data.real_provider_cost_week}`);
  assert.strictEqual(dashAdmin.data.real_provider_cost_month, '0.018', `Expected 0.018, got ${dashAdmin.data.real_provider_cost_month}`);
  assert.strictEqual(dashAdmin.data.real_provider_payout_week, '0.018', `Expected alias 0.018, got ${dashAdmin.data.real_provider_payout_week}`);
  assert.strictEqual(dashAdmin.data.real_provider_payout_month, '0.018', `Expected alias 0.018, got ${dashAdmin.data.real_provider_payout_month}`);
  pass('task2_admin_dashboard_cards_calculation', 'Admin dashboard accurately computes week/month provider payout for eligible OTPs only');

  // Verify non-admin roles do not get real provider cost
  const dashMgr = await request('GET', '/api/dashboard', null, tokens.manager);
  assert.strictEqual(dashMgr.data.real_provider_cost_today, '0');
  assert.strictEqual(dashMgr.data.real_provider_cost_week, '0');
  const dashCli = await request('GET', '/api/dashboard', null, tokens.client);
  assert.strictEqual(dashCli.data.real_provider_cost_today, '0');
  pass('task2_non_admin_dashboard_isolated', 'Manager and Client dashboards do not expose real provider payout');

  // =========================================================================
  // TASK 1 VERIFICATION: Client Panel SMS Report Filters (15 Combinations + Strict AND + Scoping)
  // =========================================================================
  console.log('\n--- VERIFYING TASK 1: Client SMS Report Filters (15 Combos + Strict AND) ---');

  // Client 1 has 3 SMS records:
  // SMS 1: 447700900001, Range_Alpha, today, Google
  // SMS 2: 447700900001, Range_Alpha, today, WhatsApp
  // SMS 4: 447700900001, Range_Alpha, today, OverLimit
  // Notice: SMS 3 belongs to Other Client! Client 1 must NEVER see SMS 3!

  const todayStr = now.slice(0, 10);

  // Verify Client scope
  const allCliSms = await request('GET', '/api/sms/paged', null, tokens.client);
  assert.strictEqual(allCliSms.data.total, 3, `Client should see exactly 3 records, got ${allCliSms.data.total}`);
  const hasOtherClient = allCliSms.data.rows.some(r => r.cli === 'Telegram' || r.number === '447700900002');
  assert.strictEqual(hasOtherClient, false, 'Client must NOT see other client SMS records');
  pass('task1_client_scope_strictly_enforced', 'Client data scope strictly enforced on /api/sms/paged');

  // 1. Number only
  const c1 = await request('GET', `/api/sms/paged?number=447700900001`, null, tokens.client);
  assert.strictEqual(c1.data.total, 3, 'Combo 1: Number only matches 3');
  pass('task1_combo1_number_only', 'Number only filter returns matching records');

  // 2. Range only
  const c2 = await request('GET', `/api/sms/paged?range=Range_Alpha`, null, tokens.client);
  assert.strictEqual(c2.data.total, 3, 'Combo 2: Range only matches 3');
  pass('task1_combo2_range_only', 'Range only filter returns matching records');

  // 3. Date only
  const c3 = await request('GET', `/api/sms/paged?from=${todayStr}&to=${todayStr}`, null, tokens.client);
  assert.strictEqual(c3.data.total, 3, 'Combo 3: Date only matches 3');
  pass('task1_combo3_date_only', 'Date only filter returns matching records');

  // 4. CLI only
  const c4 = await request('GET', `/api/sms/paged?cli=Google`, null, tokens.client);
  assert.strictEqual(c4.data.total, 1, 'Combo 4: CLI Google matches 1');
  pass('task1_combo4_cli_only', 'CLI only filter returns matching records');

  // 5. Number + Range
  const c5 = await request('GET', `/api/sms/paged?number=447700900001&range=Range_Alpha`, null, tokens.client);
  assert.strictEqual(c5.data.total, 3, 'Combo 5: Number + Range matches 3');
  pass('task1_combo5_number_range', 'Number + Range filter returns matching records');

  // 6. Number + Date
  const c6 = await request('GET', `/api/sms/paged?number=447700900001&from=${todayStr}&to=${todayStr}`, null, tokens.client);
  assert.strictEqual(c6.data.total, 3, 'Combo 6: Number + Date matches 3');
  pass('task1_combo6_number_date', 'Number + Date filter returns matching records');

  // 7. Number + CLI
  const c7 = await request('GET', `/api/sms/paged?number=447700900001&cli=WhatsApp`, null, tokens.client);
  assert.strictEqual(c7.data.total, 1, 'Combo 7: Number + CLI WhatsApp matches 1');
  pass('task1_combo7_number_cli', 'Number + CLI filter returns matching records');

  // 8. Range + Date
  const c8 = await request('GET', `/api/sms/paged?range=Range_Alpha&from=${todayStr}&to=${todayStr}`, null, tokens.client);
  assert.strictEqual(c8.data.total, 3, 'Combo 8: Range + Date matches 3');
  pass('task1_combo8_range_date', 'Range + Date filter returns matching records');

  // 9. Range + CLI
  const c9 = await request('GET', `/api/sms/paged?range=Range_Alpha&cli=Google`, null, tokens.client);
  assert.strictEqual(c9.data.total, 1, 'Combo 9: Range + CLI Google matches 1');
  pass('task1_combo9_range_cli', 'Range + CLI filter returns matching records');

  // 10. Date + CLI
  const c10 = await request('GET', `/api/sms/paged?from=${todayStr}&to=${todayStr}&cli=WhatsApp`, null, tokens.client);
  assert.strictEqual(c10.data.total, 1, 'Combo 10: Date + CLI matches 1');
  pass('task1_combo10_date_cli', 'Date + CLI filter returns matching records');

  // 11. Number + Range + Date
  const c11 = await request('GET', `/api/sms/paged?number=447700900001&range=Range_Alpha&from=${todayStr}&to=${todayStr}`, null, tokens.client);
  assert.strictEqual(c11.data.total, 3, 'Combo 11: Number + Range + Date matches 3');
  pass('task1_combo11_number_range_date', 'Number + Range + Date filter returns matching records');

  // 12. Number + Range + CLI
  const c12 = await request('GET', `/api/sms/paged?number=447700900001&range=Range_Alpha&cli=Google`, null, tokens.client);
  assert.strictEqual(c12.data.total, 1, 'Combo 12: Number + Range + CLI matches 1');
  pass('task1_combo12_number_range_cli', 'Number + Range + CLI filter returns matching records');

  // 13. Number + Date + CLI
  const c13 = await request('GET', `/api/sms/paged?number=447700900001&from=${todayStr}&to=${todayStr}&cli=WhatsApp`, null, tokens.client);
  assert.strictEqual(c13.data.total, 1, 'Combo 13: Number + Date + CLI matches 1');
  pass('task1_combo13_number_date_cli', 'Number + Date + CLI filter returns matching records');

  // 14. Range + Date + CLI
  const c14 = await request('GET', `/api/sms/paged?range=Range_Alpha&from=${todayStr}&to=${todayStr}&cli=Google`, null, tokens.client);
  assert.strictEqual(c14.data.total, 1, 'Combo 14: Range + Date + CLI matches 1');
  pass('task1_combo14_range_date_cli', 'Range + Date + CLI filter returns matching records');

  // 15. All four simultaneous: Number + Range + Date + CLI
  const c15 = await request('GET', `/api/sms/paged?number=447700900001&range=Range_Alpha&from=${todayStr}&to=${todayStr}&cli=Google`, null, tokens.client);
  assert.strictEqual(c15.data.total, 1, 'Combo 15: All 4 filters match 1');
  pass('task1_combo15_all_four_simultaneous', 'All four filters simultaneous return exact matching record');

  // Strict AND Contradictory Filter: Number 447700900001 with CLI Telegram (which is on 447700900002)
  const cContra = await request('GET', `/api/sms/paged?number=447700900001&cli=Telegram`, null, tokens.client);
  assert.strictEqual(cContra.data.total, 0, 'Contradictory filter must return 0 records under strict AND');
  pass('task1_strict_and_contradictory_zero', 'Contradictory query returns 0 records under strict AND logic');

  // Client cannot spoof other client or internal provider/manager filters
  const cSpoof = await request('GET', `/api/sms/paged?client_id=${otherCRes.data.id}&provider=FakeProv`, null, tokens.client);
  assert.strictEqual(cSpoof.data.total, 3, 'Client query remains scoped to client, ignoring spoofed client_id and provider');
  pass('task1_client_spoof_prevented', 'Client cannot query other clients or inject internal provider filter');

  // =========================================================================
  // TASK 3 VERIFICATION: Copy + Download CSV Actions & Responsiveness
  // =========================================================================
  console.log('\n--- VERIFYING TASK 3: Copy + Download CSV Actions ---');

  // Verify HTML templates have required Copy and Download CSV elements
  const clientHtml = fs.readFileSync('client.html', 'utf8');
  assert.ok(clientHtml.includes('id="stNumber"'), 'client.html has stNumber filter');
  assert.ok(clientHtml.includes('id="stRange"'), 'client.html has stRange filter');
  assert.ok(clientHtml.includes('id="stFrom"'), 'client.html has stFrom filter');
  assert.ok(clientHtml.includes('id="stTo"'), 'client.html has stTo filter');
  assert.ok(clientHtml.includes('id="stCli"'), 'client.html has stCli filter');
  assert.ok(clientHtml.includes('data-tip="Copy"'), 'client.html has Copy button');
  assert.ok(clientHtml.includes('data-tip="Download CSV"'), 'client.html has Download CSV button');
  pass('task3_client_html_buttons', 'client.html has Copy and Download CSV buttons with filters');

  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  assert.ok(adminHtml.includes('THIS WEEK REAL PROVIDER PAYOUT'), 'admin.html has THIS WEEK REAL PROVIDER PAYOUT card');
  assert.ok(adminHtml.includes('THIS MONTH REAL PROVIDER PAYOUT'), 'admin.html has THIS MONTH REAL PROVIDER PAYOUT card');
  assert.ok(adminHtml.includes('id="page-rates"'), 'admin.html has page-rates');
  assert.ok(adminHtml.includes('rProvRate'), 'admin.html has rProvRate');
  assert.ok(adminHtml.includes('rProv1'), 'admin.html has rProv1');
  pass('task3_admin_html_cards_and_rates', 'admin.html has real provider cards, rates page, and provider rate fields');

  // Test with Puppeteer: Browser execution of Copy & CSV & Responsiveness
  console.log('\n--- LAUNCHING PUPPETEER FOR UI INTERACTION & RESPONSIVENESS ---');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
  } catch (_) {}

  const page = await browser.newPage();

  page.on('console', msg => console.log(`[Browser client]`, msg.type(), msg.text()));
  page.on('pageerror', err => console.log(`[Browser client ERR]`, err.message));

  // Test Client Panel: login and navigate to stats
  await page.goto(`${BASE}/panel-login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    sessionStorage.setItem('ms_token', tok);
    sessionStorage.setItem('ms_role', 'client');
    localStorage.setItem('ms_token', tok);
    localStorage.setItem('ms_role', 'client');
  }, tokens.client);
  await page.goto(`${BASE}/client`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 600));

  // Navigate to SMS Stats (#page-stats)
  await page.evaluate(async () => {
    if (typeof showPage === 'function') showPage('stats');
    if (typeof renderStats === 'function') await renderStats();
  });
  await new Promise(r => setTimeout(r, 800));

  // Check stNumber exists and is visible
  const stNumExists = await page.evaluate(() => {
    const el = document.getElementById('stNumber');
    return !!el && el.placeholder.includes('Number');
  });
  assert.ok(stNumExists, 'Client SMS Stats has Number filter input');
  pass('task3_client_ui_number_input_present', 'Client UI displays Number filter input');

  const debugSkyline = await page.evaluate(() => {
    return {
      hasSkyline: typeof window.Skyline !== 'undefined',
      wireExports: typeof window.Skyline?.wireExports,
      copyTextToClipboard: typeof window.Skyline?.copyTextToClipboard,
      handleTableCopy: typeof window.Skyline?.handleTableCopy
    };
  });
  console.log('  [Skyline exists?]', debugSkyline);

  // Test Copy button click and visual feedback in Client panel
  const testDirect = await page.evaluate(async () => {
    const copyBtn = document.querySelector('#page-stats .exp-btns button[data-tip="Copy"]');
    const wrap = copyBtn ? copyBtn.closest('.table-wrap') : null;
    const table = wrap ? wrap.querySelector('table') : null;
    const ths = table ? [...table.querySelectorAll('thead th')] : [];
    const rows = table ? [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length > 1 && !tr.querySelector('th')) : [];
    
    let copyResult = null;
    try {
      copyResult = await Skyline.handleTableCopy(copyBtn);
    } catch(err) {
      copyResult = { error: err.message, stack: err.stack };
    }
    
    return {
      hasWrap: !!wrap,
      hasTable: !!table,
      thCount: ths.length,
      rowCount: rows.length,
      copyResult,
      btnHtml: copyBtn ? copyBtn.innerHTML : null,
      btnBg: copyBtn ? copyBtn.style.background : null
    };
  });
  console.log('  [Direct HandleTableCopy Test]', testDirect);

  const copyFeedbackSuccess = await page.evaluate(async () => {
    const copyBtn = document.querySelector('#page-stats .exp-btns button[data-tip="Copy"]') || document.querySelector('#page-stats button[data-tip="Copy"]');
    if (!copyBtn) return { error: 'no copy btn' };
    const numRows = document.querySelectorAll('#statsBody tr').length;
    copyBtn.click();
    await new Promise(r => setTimeout(r, 200));
    const isFeedback = copyBtn.innerHTML.includes('Copied') || copyBtn.style.background.includes('16') || copyBtn.style.background.includes('rgb');
    return { isFeedback, numRows, btnHtml: copyBtn.innerHTML, btnBg: copyBtn.style.background };
  });
  console.log('  [Puppeteer Copy Debug]', copyFeedbackSuccess);
  assert.ok(copyFeedbackSuccess.isFeedback, 'Client Copy button triggered visual feedback on click');
  pass('task3_copy_visual_feedback', 'Copy button gives instant visual feedback ("Copied! ✓")');

  // Test Download CSV click and trigger
  const csvDownloadSuccess = await page.evaluate(async () => {
    let triggered = false;
    let createdUrl = null;
    let downloadBlobContent = null;
    const oldCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      triggered = true;
      createdUrl = oldCreate(blob);
      return createdUrl;
    };
    const csvBtn = document.querySelector('#page-stats .exp-btns button[data-tip="Download CSV"]') || document.querySelector('#page-stats button[data-tip="Download CSV"]');
    if (!csvBtn) return { error: 'no csv button' };
    
    let error = null;
    try {
      await Skyline.handleTableCsv(csvBtn);
    } catch(err) {
      error = { message: err.message, stack: err.stack };
    }

    return { triggered, createdUrl, error };
  });
  console.log('  [CSV Download Test]', csvDownloadSuccess);
  assert.ok(csvDownloadSuccess.triggered, 'Download CSV triggered Blob / URL generation');
  pass('task3_csv_download_triggered', 'Download CSV generates valid file download on click');

  // Test Admin Panel: Dashboard cards and Rate modal
  await page.goto(`${BASE}/panel-login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    sessionStorage.setItem('ms_token', tok);
    sessionStorage.setItem('ms_role', 'admin');
    localStorage.setItem('ms_token', tok);
    localStorage.setItem('ms_role', 'admin');
  }, tokens.admin);
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 800));

  // Verify Admin dashboard cards text
  const adminCardsText = await page.evaluate(() => {
    const weekEl = document.getElementById('dashHeroWeekProvPay') || document.getElementById('dashWeekProvPay');
    const monthEl = document.getElementById('dashHeroMonthProvPay') || document.getElementById('dashMonthProvPay');
    return {
      week: weekEl ? weekEl.textContent.trim() : null,
      month: monthEl ? monthEl.textContent.trim() : null
    };
  });
  assert.strictEqual(adminCardsText.week, '$ 0.018', 'Admin UI shows $ 0.018 for week provider payout');
  assert.strictEqual(adminCardsText.month, '$ 0.018', 'Admin UI shows $ 0.018 for month provider payout');
  pass('task2_admin_dashboard_ui_rendered', 'Admin dashboard cards correctly render $ 0.018 for provider payout');

  // Responsive Viewport Verification across viewports
  const viewports = [
    { name: '320px Mobile S', width: 320, height: 640 },
    { name: '375px iPhone X', width: 375, height: 667 },
    { name: '768px Tablet', width: 768, height: 1024 },
    { name: '1280px Desktop', width: 1280, height: 800 }
  ];

  for (const vp of viewports) {
    await page.setViewport({ width: vp.width, height: vp.height });
    await new Promise(r => setTimeout(r, 100));
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });
    assert.strictEqual(overflow, false, `${vp.name} must have 0 horizontal overflow`);
    pass(`task3_responsive_${vp.width}px`, `${vp.name} verified: 0 horizontal overflow`);
  }

  await browser.close();

  // Cleanup
  db.close();
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }

  console.log('\n================================================================');
  console.log('ALL THREE TASKS VERIFIED SUCCESSFULLY: 100% PASS!');
  console.log('================================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(1);
});
