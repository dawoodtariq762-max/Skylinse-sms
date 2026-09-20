const puppeteer = require('puppeteer');
const http = require('http');

const PORT = 8102;
const BASE = `http://127.0.0.1:${PORT}`;

async function getAuth(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return await res.json();
}

async function main() {
  const adminAuth = await getAuth('vibepk', 'vibepk123');
  console.log('Logged in admin:', adminAuth.role);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.goto(`${BASE}/panel-login`);
  await page.evaluate((auth) => {
    localStorage.setItem('ms_token', auth.token);
    localStorage.setItem('ms_role', auth.user.role);
    localStorage.setItem('ms_user', auth.user.username);
    localStorage.setItem('ms_name', auth.user.name || auth.user.username);
    sessionStorage.setItem('ms_token', auth.token);
    sessionStorage.setItem('ms_role', auth.user.role);
    sessionStorage.setItem('ms_user', auth.user.username);
    sessionStorage.setItem('ms_name', auth.user.name || auth.user.username);
  }, adminAuth);

  await page.goto(`${BASE}/admin`);
  await page.waitForSelector('#page-dashboard', { timeout: 5000 });

  const viewports = [320, 360, 375, 390, 414, 768, 1280];

  console.log('\n======================================================');
  console.log('DIAGNOSING RESPONSIVE LAYOUT & OVERFLOW ISSUES');
  console.log('======================================================\n');

  for (const w of viewports) {
    await page.setViewport({ width: w, height: 850 });
    
    // 1. Diagnose SMS Detailed Report
    await page.evaluate(() => { window.showPageByName && window.showPageByName('smsDetail'); });
    await new Promise(r => setTimeout(r, 600));

    const detDiag = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const bodyW = document.body.scrollWidth;
      const mainW = document.querySelector('.main')?.scrollWidth || 0;
      const tb = document.querySelector('#page-smsDetail .cdr-toolbar');
      const frow1 = document.querySelector('#page-smsDetail .cdr-filter-row:first-child');
      const frow2 = document.querySelector('#page-smsDetail .cdr-filter-row:nth-child(2)');
      const gbRow = document.querySelector('#page-smsDetail .cdr-group-row');
      const cardHead = document.querySelector('#page-smsDetail .cdr-card-head');
      const cardCtl = document.querySelector('#page-smsDetail .cdr-card-controls');
      const ctlLeft = document.querySelector('#page-smsDetail .cdr-controls-left');
      const ctlRight = document.querySelector('#page-smsDetail .cdr-controls-right');
      const foot = document.querySelector('#page-smsDetail .cdr-foot');

      // Find all overflowing elements relative to viewport
      const overflowing = [];
      document.querySelectorAll('*').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.right > winW + 1 && !el.classList.contains('cdr-table-wrap') && !el.classList.contains('tscroll') && el.tagName !== 'TABLE' && el.tagName !== 'TBODY' && el.tagName !== 'TR' && el.tagName !== 'TD' && el.tagName !== 'TH') {
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
          overflowing.push(`${el.tagName.toLowerCase()}${id}${cls} (right: ${Math.round(rect.right)}px, width: ${Math.round(rect.width)}px)`);
        }
      });

      return {
        docW, winW, bodyW, mainW,
        hasDocOverflow: docW > winW,
        overflowCount: overflowing.length,
        overflowSample: overflowing.slice(0, 6),
        tbW: tb ? tb.offsetWidth : 0,
        frow2W: frow2 ? frow2.scrollWidth : 0
      };
    });

    console.log(`--- SMS Detailed Report @ ${w}px ---`);
    console.log(`Viewport: ${w}px | Page scrollWidth: ${detDiag.docW}px | Overflow? ${detDiag.hasDocOverflow}`);
    if (detDiag.overflowSample.length) {
      console.log('Overflowing elements sample:');
      detDiag.overflowSample.forEach(s => console.log('   •', s));
    }

    // 2. Diagnose SMS Report
    await page.evaluate(() => { window.showPageByName && window.showPageByName('smsReport'); });
    await new Promise(r => setTimeout(r, 600));

    const repDiag = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const overflowing = [];
      document.querySelectorAll('*').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.right > winW + 1 && !el.classList.contains('tscroll') && el.tagName !== 'TABLE' && el.tagName !== 'TBODY' && el.tagName !== 'TR' && el.tagName !== 'TD' && el.tagName !== 'TH') {
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
          overflowing.push(`${el.tagName.toLowerCase()}${id}${cls} (right: ${Math.round(rect.right)}px, width: ${Math.round(rect.width)}px)`);
        }
      });

      const filterRow = document.querySelector('#page-smsReport .filter-row');
      const tableControls = document.querySelector('#page-smsReport .table-controls');

      return {
        docW, winW,
        hasDocOverflow: docW > winW,
        overflowCount: overflowing.length,
        overflowSample: overflowing.slice(0, 6),
        filterRowW: filterRow ? filterRow.scrollWidth : 0,
        tableControlsW: tableControls ? tableControls.scrollWidth : 0
      };
    });

    console.log(`--- SMS Report @ ${w}px ---`);
    console.log(`Viewport: ${w}px | Page scrollWidth: ${repDiag.docW}px | Overflow? ${repDiag.hasDocOverflow}`);
    if (repDiag.overflowSample.length) {
      console.log('Overflowing elements sample:');
      repDiag.overflowSample.forEach(s => console.log('   •', s));
    }
    console.log('');
  }

  await browser.close();
  process.exit(0);
}

// Start backend server on 8102
const { spawn } = require('child_process');
const srv = spawn('node', ['backend/server.js'], { env: { ...process.env, PORT: String(PORT) } });
setTimeout(() => {
  main().finally(() => srv.kill());
}, 1500);
