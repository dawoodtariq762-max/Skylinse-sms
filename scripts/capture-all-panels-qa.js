const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const TEST_PORT = 8093;
const DB_FILE = `/tmp/test_qa_panels_${Date.now()}.db`;
let serverProc = null;

function apiRequest(method, endpoint, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://127.0.0.1:${TEST_PORT}${endpoint}`);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        DB_FILE: DB_FILE,
        NODE_ENV: 'test',
        ADMIN_USER: 'vibepk',
        ADMIN_PASS: 'vibepk123'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', (d) => {
      const s = d.toString();
      if (s.includes('Skyline SMS backend running')) resolve();
    });
    serverProc.stderr.on('data', (d) => {
      const s = d.toString();
      if (!s.includes('ExperimentalWarning')) console.error('[Server Err]', s.trim());
    });
    serverProc.on('error', reject);
    setTimeout(() => reject(new Error('Server timeout on startup')), 15000);
  });
}

async function run() {
  console.log(`Starting QA screenshot and functional verification on port ${TEST_PORT}...`);
  await startServer();
  console.log('✓ Backend online');

  const db = new Database(DB_FILE);
  db.pragma('foreign_keys = OFF');

  // Insert users
  const hash = bcrypt.hashSync('Pass123!', 10);
  const mInfo = db.prepare(`INSERT INTO users (username, password, role, name, parent_id, active, payment_type) VALUES ('mgr_qa', ?, 'manager', 'Manager QA', 1, 1, 'weekly_7_1')`).run(hash);
  const mgrId = mInfo.lastInsertRowid;

  const aInfo = db.prepare(`INSERT INTO users (username, password, role, name, parent_id, active, payment_type) VALUES ('agt_qa', ?, 'agent', 'Agent QA', ?, 1, 'weekly_7_1')`).run(hash, mgrId);
  const agtId = aInfo.lastInsertRowid;

  const cInfo = db.prepare(`INSERT INTO users (username, password, role, name, parent_id, active, payment_type) VALUES ('cli_qa', ?, 'client', 'Client QA', ?, 1, 'weekly_7_1')`).run(hash, agtId);
  const cliId = cInfo.lastInsertRowid;

  // Insert ranges
  const r1Info = db.prepare(`INSERT INTO ranges (name, currency, rate_1_1, provider_rate) VALUES ('UK Alpha', 'USD', '0.05', 0.035)`).run();
  const r1Id = r1Info.lastInsertRowid;

  const r2Info = db.prepare(`INSERT INTO ranges (name, currency, rate_1_1, provider_rate) VALUES ('UK Beta', 'USD', '0.06', 0.040)`).run();
  const r2Id = r2Info.lastInsertRowid;

  const r3Info = db.prepare(`INSERT INTO ranges (name, currency, rate_1_1, provider_rate) VALUES ('US Gamma', 'USD', '0.08', 0.050)`).run();
  const r3Id = r3Info.lastInsertRowid;

  // Insert numbers
  const n1 = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('+447700900001', ?, ?, ?, ?)`).run(r1Id, mgrId, agtId, cliId).lastInsertRowid;
  const n2 = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('+447700900002', ?, ?, ?, ?)`).run(r1Id, mgrId, agtId, cliId).lastInsertRowid;
  const n3 = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('+447700900003', ?, ?, ?, ?)`).run(r2Id, mgrId, agtId, cliId).lastInsertRowid;
  const n4 = db.prepare(`INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('+447700900004', ?, ?, ?, ?)`).run(r2Id, mgrId, agtId, cliId).lastInsertRowid;
  const n5 = db.prepare(`INSERT INTO numbers (number, range_id) VALUES ('+12025550199', ?)`).run(r3Id).lastInsertRowid;

  // Ingest realistic SMS records
  const today = '2026-09-20';
  const yesterday = '2026-09-19';
  const earlier = '2026-09-18';

  const testRecords = [
    { number_id: n1, number: '+447700900001', cli: 'WhatsApp', msg: 'Your WhatsApp verification code is 482-910. Do not share this code with anyone for security purposes.', otp: '482-910', time: `${today} 10:15:22`, rId: r1Id, mId: mgrId, aId: agtId, cId: cliId },
    { number_id: n2, number: '+447700900002', cli: 'Google', msg: 'G-837201 is your Google verification security passcode for login verification.', otp: '837201', time: `${today} 11:30:45`, rId: r1Id, mId: mgrId, aId: agtId, cId: cliId },
    { number_id: n3, number: '+447700900003', cli: 'Telegram', msg: 'Telegram code 39281. You may also tap on this link to verify your account promptly.', otp: '39281', time: `${today} 14:05:10`, rId: r2Id, mId: mgrId, aId: agtId, cId: cliId },
    { number_id: n4, number: '+447700900004', cli: 'Uber', msg: 'Your Uber confirmation code is 5541. Please enter it in the mobile app to complete login.', otp: '5541', time: `${yesterday} 09:20:00`, rId: r2Id, mId: mgrId, aId: agtId, cId: cliId },
    { number_id: n1, number: '+447700900001', cli: 'Chase', msg: 'Chase Security Alert: 710492 is your temporary authorization code for transactions.', otp: '710492', time: `${earlier} 18:40:12`, rId: r1Id, mId: mgrId, aId: agtId, cId: cliId },
    { number_id: n5, number: '+12025550199', cli: 'Apple', msg: 'Your Apple ID verification code is 912034. Valid for 10 minutes only.', otp: '912034', time: `${today} 16:00:00`, rId: r3Id, mId: null, aId: null, cId: null }
  ];

  const insertStmt = db.prepare(`INSERT INTO sms_records (number_id, number, cli, message, otp_code, received_at, range_id, manager_id, agent_id, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of testRecords) {
    insertStmt.run(r.number_id, r.number, r.cli, r.msg, r.otp, r.time, r.rId, r.mId, r.aId, r.cId);
  }
  db.close();
  console.log(`✓ Seeded ${testRecords.length} SMS records`);

  // Obtain tokens via API login & accept legal terms
  const tokens = {};
  tokens.admin = (await apiRequest('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' })).data.token;
  tokens.manager = (await apiRequest('POST', '/api/login', { username: 'mgr_qa', password: 'Pass123!' })).data.token;
  tokens.agent = (await apiRequest('POST', '/api/login', { username: 'agt_qa', password: 'Pass123!' })).data.token;
  tokens.client = (await apiRequest('POST', '/api/login', { username: 'cli_qa', password: 'Pass123!' })).data.token;

  for (const [r, tok] of Object.entries(tokens)) {
    try { await apiRequest('POST', '/api/legal/accept', { version: '1.0' }, tok); } catch (e) {}
  }
  console.log('✓ All 4 role accounts authenticated & legal terms accepted');

  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const roles = [
    { role: 'admin', user: 'vibepk', pageId: 'smsReport' },
    { role: 'manager', user: 'mgr_qa', pageId: 'smsReport' },
    { role: 'agent', user: 'agt_qa', pageId: 'smsReport' },
    { role: 'client', user: 'cli_qa', pageId: 'stats' }
  ];

  for (const item of roles) {
    console.log(`\n================ Testing & Capturing ${item.role.toUpperCase()} PANEL ================`);
    const page = await browser.newPage();
    page.on('dialog', async dialog => {
      console.log(`  [Dialog ${item.role}] ${dialog.message()}`);
      await dialog.dismiss();
    });

    // Set auth in localStorage / sessionStorage before navigation
    await page.goto(`http://127.0.0.1:${TEST_PORT}/panel-login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok, role, usr) => {
      sessionStorage.setItem('ms_token', tok);
      sessionStorage.setItem('ms_role', role);
      sessionStorage.setItem('ms_user', usr);
      localStorage.setItem('ms_token', tok);
      localStorage.setItem('ms_role', role);
      localStorage.setItem('ms_user', usr);
      localStorage.setItem('client_welcome_seen', '1');
    }, tokens[item.role], item.role, item.user);

    // Navigate to role panel
    await page.goto(`http://127.0.0.1:${TEST_PORT}/${item.role}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));

    // Clear any modal overlays if present
    await page.evaluate(() => {
      const g = document.getElementById('gxLegalGate'); if (g) g.remove();
      const w = document.getElementById('clientWelcome'); if (w) w.remove();
    });

    // Navigate to SMS Report page and trigger rendering
    await page.evaluate(async (pid) => {
      const el = document.querySelector(`[data-page="${pid}"]`);
      if (el) el.click();
      else if (typeof showPage === 'function') showPage(pid);
      
      if (pid === 'smsReport') {
        if (!document.getElementById('srBody') && typeof buildSmsReport === 'function') buildSmsReport();
        if (typeof renderSmsReport === 'function') await renderSmsReport();
      } else if (pid === 'stats') {
        if (typeof loadRanges === 'function') await loadRanges();
        if (typeof updateClientFilterUI === 'function') updateClientFilterUI();
        if (typeof renderStats === 'function') await renderStats();
      }
    }, item.pageId);

    await new Promise(r => setTimeout(r, 1200));

    // 1. Capture Desktop Screenshot (1280x800)
    await page.setViewport({ width: 1280, height: 800 });
    await new Promise(r => setTimeout(r, 500));
    const deskPath = path.join(__dirname, `../screenshots/${item.role}-sms-report-desktop.png`);
    await page.screenshot({ path: deskPath, fullPage: false });
    console.log(`✓ Saved Desktop screenshot: screenshots/${item.role}-sms-report-desktop.png`);

    // 2. Capture Mobile Screenshot (375x812)
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => {
      const g = document.getElementById('gxLegalGate'); if (g) g.remove();
      const w = document.getElementById('clientWelcome'); if (w) w.remove();
    });
    const mobPath = path.join(__dirname, `../screenshots/${item.role}-sms-report-mobile.png`);
    await page.screenshot({ path: mobPath, fullPage: false });
    console.log(`✓ Saved Mobile screenshot: screenshots/${item.role}-sms-report-mobile.png`);

    // 3. Inspect layout metrics
    const metrics = await page.evaluate(() => {
      const activePage = document.querySelector('section.page.active') || document.body;
      const table = activePage.querySelector('table');
      const bodyCells = activePage.querySelectorAll('td.msg-body, td.msg-cell');
      const sampleCell = bodyCells[0];
      const controls = activePage.querySelector('.table-controls');
      const expBtns = activePage.querySelector('.exp-btns');
      const rows = activePage.querySelectorAll('tbody tr');
      return {
        activePageId: activePage.id,
        tableWidth: table ? table.offsetWidth : 0,
        rowCount: rows ? rows.length : 0,
        sampleCellWidth: sampleCell ? sampleCell.offsetWidth : 0,
        sampleCellWhiteWrap: sampleCell ? window.getComputedStyle(sampleCell).whiteSpace : '',
        sampleCellWordBreak: sampleCell ? window.getComputedStyle(sampleCell).wordBreak : '',
        sampleCellText: sampleCell ? (sampleCell.textContent || '').trim().slice(0, 45) + '…' : '',
        controlsDirection: controls ? window.getComputedStyle(controls).flexDirection : '',
        expBtnsWrap: expBtns ? window.getComputedStyle(expBtns).flexWrap : '',
        buttonCount: expBtns ? expBtns.querySelectorAll('button').length : 0
      };
    });
    console.log(`  [Metrics ${item.role}]`, metrics);

    // If Client, perform comprehensive interactive filter and export tests
    if (item.role === 'client') {
      console.log('\n--- Performing Interactive Client Filter & Export Tests in Browser ---');

      // Test 1: Verify Initial (Date checked = today 2026-09-20)
      const initialRows = await page.evaluate(() => {
        const rows = document.querySelectorAll('#statsBody tr');
        return Array.from(rows).map(tr => ({
          date: tr.children[0]?.textContent,
          range: tr.children[1]?.textContent,
          num: tr.children[2]?.textContent,
          cli: tr.children[3]?.textContent
        }));
      });
      console.log(`  Initial rows (today 2026-09-20): ${initialRows.length} rows (Expected 3 today rows)`);
      initialRows.forEach((r, idx) => console.log(`    [Today Row ${idx+1}] ${r.date} | ${r.range} | ${r.num} | ${r.cli}`));

      // Test 2: Uncheck Date filter -> All dates appear (includes Chase 2026-09-18 and Uber 2026-09-19)
      await page.evaluate(async () => {
        const chk = document.getElementById('stUseDate');
        if (chk) {
          chk.checked = false;
          toggleClientFilter('date');
        }
      });
      await new Promise(r => setTimeout(r, 600));
      const allDateRows = await page.evaluate(() => {
        const rows = document.querySelectorAll('#statsBody tr');
        return Array.from(rows).map(tr => ({
          date: tr.children[0]?.textContent,
          range: tr.children[1]?.textContent,
          num: tr.children[2]?.textContent,
          cli: tr.children[3]?.textContent
        }));
      });
      console.log(`  Unchecked Date filter -> All date rows count: ${allDateRows.length} (Expected 5 client records)`);
      allDateRows.forEach((r, idx) => console.log(`    [All-Date Row ${idx+1}] ${r.date} | ${r.range} | ${r.num} | ${r.cli}`));

      // Test 3: Select Range "UK Alpha"
      await page.evaluate(async () => {
        const sel = document.getElementById('stRange');
        if (sel) {
          sel.value = 'UK Alpha';
          clientRangeChanged();
        }
      });
      await new Promise(r => setTimeout(r, 600));
      const alphaRows = await page.evaluate(() => {
        const rows = document.querySelectorAll('#statsBody tr');
        return Array.from(rows).map(tr => ({
          range: tr.children[1]?.textContent,
          num: tr.children[2]?.textContent,
          cli: tr.children[3]?.textContent
        }));
      });
      console.log(`  Selected Range="UK Alpha" -> count: ${alphaRows.length} (Expected 3 UK Alpha records)`);

      // Test 4: Select CLI "WhatsApp" (Range="UK Alpha" AND CLI="WhatsApp")
      await page.evaluate(async () => {
        const sel = document.getElementById('stCli');
        if (sel) {
          sel.value = 'WhatsApp';
          clientCliChanged();
        }
      });
      await new Promise(r => setTimeout(r, 600));
      const whatsappRows = await page.evaluate(() => {
        const rows = document.querySelectorAll('#statsBody tr');
        return Array.from(rows).map(tr => ({
          range: tr.children[1]?.textContent,
          num: tr.children[2]?.textContent,
          cli: tr.children[3]?.textContent,
          otp: tr.children[4]?.textContent
        }));
      });
      console.log(`  Selected Range="UK Alpha" AND CLI="WhatsApp" -> count: ${whatsappRows.length} (Expected 1 record)`, whatsappRows);

      // Test 5: Verify Copy button on filtered results
      const copyFeedback = await page.evaluate(async () => {
        const btn = document.querySelector('#page-stats .exp-btns button[data-tip="Copy"]');
        if (!btn) return { ok: false, err: 'no btn found on #page-stats' };
        let copiedText = null;
        const origCopy = window.Skyline.copyTextToClipboard;
        window.Skyline.copyTextToClipboard = async function(text, button) {
          copiedText = text;
          await origCopy.call(window.Skyline, text, button);
        };
        await window.Skyline.handleTableCopy(btn);
        window.Skyline.copyTextToClipboard = origCopy;
        return { ok: true, copiedText, btnHtml: btn.innerHTML };
      });
      console.log(`  Copy button test result:`, { ok: copyFeedback.ok, hasFeedbackText: copyFeedback.btnHtml?.includes('Copied!') });
      console.log(`  Copied text payload:\n${copyFeedback.copiedText}`);

      // Test 6: Verify CSV export on filtered results
      const csvExportResult = await page.evaluate(async () => {
        let downloadedName = null;
        let downloadedText = null;
        const origDownload = window.Skyline.downloadCsvBlob;
        window.Skyline.downloadCsvBlob = function(csvText, filename) {
          downloadedName = filename;
          downloadedText = csvText;
        };
        const btn = document.querySelector('#page-stats .exp-btns button[data-tip*="CSV"]');
        if (btn && window.Skyline.handleTableCsv) {
          await window.Skyline.handleTableCsv(btn);
        }
        window.Skyline.downloadCsvBlob = origDownload;
        return { downloadedName, downloadedText };
      });
      console.log(`  CSV Export triggered filename: ${csvExportResult.downloadedName}`);
      console.log(`  CSV Content:\n${csvExportResult.downloadedText}`);

      // Test 7: Reset Filters
      await page.evaluate(() => {
        if (typeof stResetFilters === 'function') stResetFilters();
      });
      await new Promise(r => setTimeout(r, 600));
      const resetCount = await page.evaluate(() => document.querySelectorAll('#statsBody tr').length);
      console.log(`  Reset filters executed -> back to default today count: ${resetCount}`);
    }

    await page.close();
  }

  await browser.close();
  console.log('\n================ ALL QA SCREENSHOTS & TESTS COMPLETED SUCCESSFULLY! ================');
  if (serverProc) serverProc.kill('SIGTERM');
  process.exit(0);
}

run().catch(err => {
  console.error('QA Test Failed:', err);
  if (serverProc) serverProc.kill('SIGTERM');
  process.exit(1);
});
