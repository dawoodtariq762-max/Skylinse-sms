const puppeteer = require('puppeteer');
const path = require('path');
const { sign } = require('../backend/auth');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Use client token
  const token = sign({ id: 5, username: 'skyclient', role: 'client' });
  await page.goto('http://127.0.0.1:4000/panel-login', { waitUntil: 'networkidle0' });
  await page.evaluate((tok) => {
    sessionStorage.setItem('ms_token', tok);
    sessionStorage.setItem('ms_role', 'client');
    sessionStorage.setItem('ms_user', 'skyclient');
    localStorage.setItem('ms_token', tok);
    localStorage.setItem('ms_role', 'client');
    localStorage.setItem('ms_client_welcome_seen', '1');
  }, token);

  await page.goto('http://127.0.0.1:4000/client', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 600));

  // Dismiss welcome modal if open and switch to SMS stats page
  await page.evaluate(() => {
    if (window.closeClientWelcome) window.closeClientWelcome();
    const welcome = document.getElementById('clientWelcomeModal');
    if (welcome) welcome.remove();
    if (window.showPage) window.showPage('stats');
    const f = document.getElementById('stFrom');
    const t = document.getElementById('stTo');
    if (f) f.value = '2026-09-01';
    if (t) t.value = '2026-09-30';
    // Group by Range and CLI
    const gbR = document.getElementById('stGbRange');
    const gbC = document.getElementById('stGbCli');
    if (gbR) gbR.checked = true;
    if (gbC) gbC.checked = true;
    if (window.renderStats) window.renderStats();
  });

  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: path.join(__dirname, '../screenshots/client-grouped-report-desktop.png') });
  console.log('✓ Captured screenshots/client-grouped-report-desktop.png');

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
