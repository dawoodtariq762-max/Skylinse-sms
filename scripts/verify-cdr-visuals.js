const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = '/tmp/cdr_visual_test.db';
const OUT_DIR = path.join(__dirname, '..', 'artifacts', 'screenshots', 'cdr');

fs.mkdirSync(OUT_DIR, { recursive: true });

function postLogin(username, password) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username, password });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  if (fs.existsSync('/tmp/p19test.db')) {
    fs.copyFileSync('/tmp/p19test.db', DB);
  } else {
    console.error('Fixture /tmp/p19test.db missing');
    process.exit(1);
  }

  const srv = spawn('node', ['backend/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB, BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
    stdio: 'ignore'
  });

  await new Promise(r => setTimeout(r, 2000));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // 1. Admin login
    const adm = await postLogin('vibepk', 'vibepk123');
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => {
      localStorage.setItem('ms_token', tok);
      localStorage.setItem('ms_role', 'admin');
      localStorage.setItem('ms_user', 'vibepk');
      localStorage.setItem('ms_name', 'vibepk');
      sessionStorage.setItem('ms_token', tok);
      sessionStorage.setItem('ms_role', 'admin');
    }, adm.token);

    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '#gxLegalGate { display: none !important; }' }));
      const el = document.getElementById('gxLegalGate');
      if (el) el.remove();
      if (typeof showPage === 'function') showPage('smsDetail');
      else if (typeof showPageByName === 'function') showPageByName('smsDetail');
      if (typeof loadAdminPageData === 'function') loadAdminPageData('smsDetail');
    });
    await new Promise(r => setTimeout(r, 1500));

    // Screenshot 1: Admin Raw CDR Report (Matching Image 1)
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-1-admin-raw.png'), fullPage: false });
    console.log('Saved cdr-1-admin-raw.png');

    // Screenshot 2: Grouped by Hour, Day, Month (Matching Image 2)
    await page.evaluate(() => {
      document.querySelectorAll('.cdr-gb-chk').forEach(c => c.checked = false);
      const h = document.getElementById('sdUseHour'); if (h) h.checked = true;
      const d = document.getElementById('sdUseDay'); if (d) d.checked = true;
      const m = document.getElementById('sdUseMonth'); if (m) m.checked = true;
      if (window.__cdrInstance) {
        window.__cdrInstance.state.page = 1;
        window.__cdrInstance.render();
      }
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-2-grouped-hour-day-month.png'), fullPage: false });
    console.log('Saved cdr-2-grouped-hour-day-month.png');

    // Screenshot 3: Grouped by Hour, Day, Range (Matching Image 3)
    await page.evaluate(() => {
      document.querySelectorAll('.cdr-gb-chk').forEach(c => c.checked = false);
      const h = document.getElementById('sdUseHour'); if (h) h.checked = true;
      const d = document.getElementById('sdUseDay'); if (d) d.checked = true;
      const r = document.getElementById('sdUseRange'); if (r) r.checked = true;
      if (window.__cdrInstance) {
        window.__cdrInstance.state.page = 1;
        window.__cdrInstance.render();
      }
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-3-grouped-hour-day-range.png'), fullPage: false });
    console.log('Saved cdr-3-grouped-hour-day-range.png');

    // Screenshot 4: Grouped by Hour, Range (Matching Image 4)
    await page.evaluate(() => {
      document.querySelectorAll('.cdr-gb-chk').forEach(c => c.checked = false);
      const h = document.getElementById('sdUseHour'); if (h) h.checked = true;
      const r = document.getElementById('sdUseRange'); if (r) r.checked = true;
      if (window.__cdrInstance) {
        window.__cdrInstance.state.page = 1;
        window.__cdrInstance.render();
      }
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-4-grouped-hour-range.png'), fullPage: false });
    console.log('Saved cdr-4-grouped-hour-range.png');

    // 2. Manager view
    const mgr = await postLogin('p19m1', 'Test123!');
    await page.goto(`${BASE}/manager`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => {
      localStorage.setItem('ms_token', tok);
      localStorage.setItem('ms_role', 'manager');
      localStorage.setItem('ms_user', 'p19m1');
      sessionStorage.setItem('ms_token', tok);
      sessionStorage.setItem('ms_role', 'manager');
    }, mgr.token);
    await page.goto(`${BASE}/manager`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '#gxLegalGate { display: none !important; }' }));
      const el = document.getElementById('gxLegalGate');
      if (el) el.remove();
      if (typeof showPage === 'function') showPage('smsDetail');
      if (typeof loadManagerPageData === 'function') loadManagerPageData('smsDetail');
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-5-manager-report.png'), fullPage: false });
    console.log('Saved cdr-5-manager-report.png');

    // 3. Agent view
    const agt = await postLogin('p19a1', 'Test123!');
    await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => {
      localStorage.setItem('ms_token', tok);
      localStorage.setItem('ms_role', 'agent');
      localStorage.setItem('ms_user', 'p19a1');
      sessionStorage.setItem('ms_token', tok);
      sessionStorage.setItem('ms_role', 'agent');
    }, agt.token);
    await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '#gxLegalGate { display: none !important; }' }));
      const el = document.getElementById('gxLegalGate');
      if (el) el.remove();
      if (typeof showPage === 'function') showPage('smsDetail');
      if (typeof loadAgentPageData === 'function') loadAgentPageData('smsDetail');
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT_DIR, 'cdr-6-agent-report.png'), fullPage: false });
    console.log('Saved cdr-6-agent-report.png');

    console.log('\nALL 6 CDR SCREENSHOTS SUCCESSFULLY CAPTURED!');
  } finally {
    await browser.close();
    srv.kill();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
