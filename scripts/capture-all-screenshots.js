const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:4000';
const OUT_DIR = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function getAuthToken(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return await res.json();
}

async function capture() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  console.log('🚀 Starting screenshot capture engine for SKYLINE SMS...');

  const creds = {
    admin: await getAuthToken('vibepk', 'vibepk123'),
    manager: await getAuthToken('skymanager', 'Manager@123'),
    agent: await getAuthToken('skyagent', 'Agent@123'),
    client: await getAuthToken('skyclient', 'Client@123'),
    test: await getAuthToken('test', 'test123')
  };

  const tasks = [
    // 1. LOGIN PORTAL
    {
      name: '01_login_portal',
      url: '/panel-login',
      auth: null,
      sections: [{ id: 'default', title: 'Main Login Interface' }]
    },
    // 2. ADMIN PANEL
    {
      name: '02_admin',
      url: '/admin',
      auth: creds.admin,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('dashboard')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('numbers')) },
        { id: 'live_sms', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('smsDetail')) },
        { id: 'users', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('agents')) },
        { id: 'payment_mgmt', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('payMgmt')) },
        { id: 'ai_assistant', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('aiKnowledge')) }
      ]
    },
    // 3. MANAGER PANEL
    {
      name: '03_manager',
      url: '/manager',
      auth: creds.manager,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'agents', fn: (p) => p.evaluate(() => window.showPage && window.showPage('agents')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPage && window.showPage('numbers')) },
        { id: 'live_sms', fn: (p) => p.evaluate(() => window.showPage && window.showPage('smsDetail')) }
      ]
    },
    // 4. AGENT PANEL
    {
      name: '04_agent',
      url: '/agent',
      auth: creds.agent,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPage && window.showPage('numbers')) },
        { id: 'live_sms', fn: (p) => p.evaluate(() => window.showPage && window.showPage('smsDetail')) },
        { id: 'payouts', fn: (p) => p.evaluate(() => window.showPage && window.showPage('payment')) }
      ]
    },
    // 5. CLIENT PANEL
    {
      name: '05_client',
      url: '/client',
      auth: creds.client,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPage && window.showPage('numbers')) }
      ]
    },
    // 6. MANAGEMENT PANEL
    {
      name: '06_management',
      url: '/management',
      auth: creds.admin,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('dashboard')) },
        { id: 'providers', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('providers')) },
        { id: 'backups', fn: (p) => p.evaluate(() => window.showPageByName && window.showPageByName('backupManagement')) }
      ]
    },
    // 7. PAYMENT PANEL
    {
      name: '07_payment',
      url: '/payment',
      auth: creds.admin,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'requests', fn: (p) => p.evaluate(() => window.showPage && window.showPage('requests')) }
      ]
    },
    // 8. PANEL SHARING
    {
      name: '08_panel_sharing',
      url: '/panel-sharing',
      auth: creds.admin,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPage && window.showPage('numbers')) }
      ]
    },
    // 9. TEST PANEL
    {
      name: '09_test_panel',
      url: '/test',
      auth: creds.test,
      sections: [
        { id: 'dashboard', fn: (p) => p.evaluate(() => window.showPage && window.showPage('dashboard')) },
        { id: 'numbers', fn: (p) => p.evaluate(() => window.showPage && window.showPage('numbers')) }
      ]
    }
  ];

  let count = 0;
  for (const t of tasks) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });

      if (t.auth && t.auth.token) {
        const { token, user } = t.auth;
        await page.evaluateOnNewDocument((tok, u, th) => {
          sessionStorage.setItem('ms_token', tok);
          sessionStorage.setItem('ms_role', u.role);
          sessionStorage.setItem('ms_user', u.username);
          sessionStorage.setItem('ms_name', u.name);
          localStorage.setItem('ms_token', tok);
          localStorage.setItem('ms_role', u.role);
          localStorage.setItem('ms_user', u.username);
          localStorage.setItem('ms_name', u.name);
          localStorage.setItem('sk-theme', th);
          localStorage.setItem('gx-theme', th);
        }, token, user, theme);
      } else {
        await page.evaluateOnNewDocument((th) => {
          localStorage.setItem('sk-theme', th);
          localStorage.setItem('gx-theme', th);
        }, theme);
      }

      await page.goto(`${BASE}${t.url}`, { waitUntil: 'networkidle0' });
      await page.evaluate((th) => {
        if (window.Skyline && window.Skyline.theme) window.Skyline.theme.apply(th);
        if (th === 'light') {
          document.body.classList.add('sk-light', 'gx-light');
          document.documentElement.classList.add('sk-light', 'gx-light');
        } else {
          document.body.classList.remove('sk-light', 'gx-light');
          document.documentElement.classList.remove('sk-light', 'gx-light');
        }
      }, theme);

      await new Promise((r) => setTimeout(r, 600));

      for (const sec of t.sections) {
        if (sec.fn) {
          try {
            await sec.fn(page);
            await new Promise((r) => setTimeout(r, 600));
          } catch (e) {
            console.warn(`Section nav failed for ${t.name} ${sec.id}:`, e.message);
          }
        }
        const filename = `${t.name}_${sec.id}_${theme}.png`;
        const filepath = path.join(OUT_DIR, filename);
        await page.screenshot({ path: filepath });
        count++;
        console.log(`[${count}] Saved: ${filename}`);
      }
      await page.close();
    }
  }

  await browser.close();
  console.log(`\n🎉 Successfully generated all ${count} panel and section screenshots in ${OUT_DIR}!`);
}

capture().catch((e) => {
  console.error('Fatal capture error:', e);
  process.exit(1);
});
