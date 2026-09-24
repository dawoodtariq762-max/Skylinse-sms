const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // 1. Login Page Desktop
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:4000/login', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(__dirname, '../screenshots/login-page-desktop.png') });
  console.log('✓ Captured screenshots/login-page-desktop.png');

  // 2. Login Page Mobile
  await page.setViewport({ width: 375, height: 667, isMobile: true });
  await page.screenshot({ path: path.join(__dirname, '../screenshots/login-page-mobile.png') });
  console.log('✓ Captured screenshots/login-page-mobile.png');

  // 3. Admin Rates Override Modal
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:4000/panel-login', { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    sessionStorage.setItem('ms_token', 'test');
    sessionStorage.setItem('ms_role', 'admin');
    sessionStorage.setItem('ms_user', 'vibepk');
  });

  // Login as admin via API and set token in session
  const tokenRes = await page.evaluate(async () => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'vibepk', password: 'vibepk123' })
    });
    const d = await res.json();
    if(d.token) {
      sessionStorage.setItem('ms_token', d.token);
      sessionStorage.setItem('ms_role', 'admin');
      sessionStorage.setItem('ms_user', 'vibepk');
      return d.token;
    }
    return null;
  });

  if (tokenRes) {
    await page.goto('http://127.0.0.1:4000/admin', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 800));
    // Open user rates modal for a manager
    await page.evaluate(() => {
      if (window.openUserRatesModal) {
        window.openUserRatesModal('manager', 19, 'mgr_mu9irr2p');
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(__dirname, '../screenshots/admin-rates-override-modal.png') });
    console.log('✓ Captured screenshots/admin-rates-override-modal.png');
  }

  await browser.close();
  console.log('Done additional captures.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
