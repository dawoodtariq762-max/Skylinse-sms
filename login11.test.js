/* §1.1 — a fresh login must always land on the role's Dashboard.
   Simulates initPanelHistory()'s initialPage selection exactly as shipped in
   assets/api.js, across every combination of stale URL, stale localStorage
   page and fresh-login flag. */
const fs = require('fs');
const src = fs.readFileSync('/home/user/cur/assets/api.js', 'utf8');
const lines = src.split('\n');
const s = lines.findIndex(l => l.includes('let freshLogin=false;'));
if (s < 0) { console.log('  ✗ §1.1 branch not found in assets/api.js'); process.exit(1); }
let e = s; while (e < lines.length && !/initialPage\s*=\s*pageFromUrl\(\)/.test(lines[e])) e++;
const block = lines.slice(s - 1, e + 2).join("\n");

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra ? '  -> ' + extra : '')); } };

function run({ urlPath, hash, lastPage, fresh, current }) {
  const sessionStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  const localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  if (fresh) sessionStorage._d['ams_fresh_login'] = '1';
  if (lastPage) localStorage._d['ams_last_page_agent'] = lastPage;
  const panelKeyForStorage = () => 'agent';
  const defaultPageForCurrentPanel = () => 'dashboard';
  const currentPageName = () => current || '';
  const pageFromUrl = () => {
    const p = (urlPath || '').split('/').filter(Boolean);
    return (p.length >= 2 && p[0] === 'agent') ? p[1] : (hash || '');
  };
  const pageUrl = p => '/agent/' + p;
  const history = { replaceState() {} };
  const fn = new Function('sessionStorage', 'localStorage', 'panelKeyForStorage',
    'defaultPageForCurrentPanel', 'currentPageName', 'pageFromUrl', 'pageUrl', 'history',
    block + '\nreturn {initialPage, sessionStorage, localStorage};');
  return fn(sessionStorage, localStorage, panelKeyForStorage, defaultPageForCurrentPanel, currentPageName, pageFromUrl, pageUrl, history);
}

console.log('\n  --- fresh login must force Dashboard ---');
let r = run({ urlPath: '/agent/sms-numbers', lastPage: 'sms-numbers', fresh: true });
ok(r.initialPage === 'dashboard', 'fresh login + stale URL + stale last_page -> dashboard', r.initialPage);
ok(r.localStorage.getItem('ams_last_page_agent') === 'dashboard', 'stale last_page overwritten to dashboard');
ok(r.sessionStorage.getItem('ams_fresh_login') === null, 'flag consumed exactly once');

r = run({ urlPath: '/agent/range-allocation', hash: 'reports', lastPage: 'reports', fresh: true });
ok(r.initialPage === 'dashboard', 'fresh login from Range Allocation -> dashboard', r.initialPage);

r = run({ urlPath: '/agent/dashboard', lastPage: 'dashboard', fresh: true });
ok(r.initialPage === 'dashboard', 'fresh login already on dashboard -> dashboard');

console.log('\n  --- in-session navigation / reload must be preserved ---');
r = run({ urlPath: '/agent/sms-numbers', lastPage: 'sms-numbers', fresh: false });
ok(r.initialPage === 'sms-numbers', 'reload on SMS Numbers stays on SMS Numbers', r.initialPage);

r = run({ urlPath: '/agent/reports', fresh: false });
ok(r.initialPage === 'reports', 'direct URL /agent/reports -> reports', r.initialPage);

r = run({ urlPath: '/agent', hash: 'sms-numbers', lastPage: 'rateCard', fresh: false });
ok(r.initialPage === 'sms-numbers', 'hash beats stored last_page (unchanged precedence)', r.initialPage);

r = run({ urlPath: '/agent', lastPage: 'rateCard', fresh: false });
ok(r.initialPage === 'rateCard', 'no URL page -> stored last_page (unchanged)', r.initialPage);

r = run({ urlPath: '/agent', fresh: false, current: 'numbers' });
ok(r.initialPage === 'numbers', 'falls back to current page (unchanged)', r.initialPage);

r = run({ urlPath: '/agent', fresh: false });
ok(r.initialPage === 'dashboard', 'falls back to panel default (unchanged)', r.initialPage);

console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
