'use strict';
/**
 * Rate / payout hierarchy test — Admin -> Manager -> Agent -> Client.
 *
 * Runs the REAL panel (backend/server.js) against a throwaway SQLite DB, drives
 * every allocation level through the real HTTP APIs, feeds real SMS through the
 * real carrier webhook, and asserts what each level stores, displays and is paid.
 *
 * Usage: node rate-hierarchy-test.js [port]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.argv[2] || 4811);
/* Works both flat (panel root) and from the packaged tests/ folder. */
const ROOT = require('fs').existsSync(require('path').join(__dirname, 'backend', 'server.js'))
  ? __dirname : require('path').resolve(__dirname, '..');
const DATA_DIR = `/tmp/rate-hier-${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) { pass++; results.push('PASS  ' + name); }
  else { fail++; results.push('FAIL  ' + name + (detail ? '  ->  ' + detail : '')); }
}
const eq = (name, got, want) => ok(name, String(got) === String(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const numEq = (name, got, want) => { const g = (got === undefined || got === null || got === '') ? NaN : parseFloat(got);
  ok(name, Number.isFinite(g) && Math.abs(g - want) < 1e-9, `got ${JSON.stringify(got)} want ~${want}`); };

function req(method, url, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { ...(headers || {}) };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    if (token) h.authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: h }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) { j = d; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const GET = (u, t) => req('GET', u, { token: t });
const POST = (u, b, t) => req('POST', u, { token: t, body: b });
const PUT = (u, b, t, h) => req('PUT', u, { token: t, body: b, headers: h });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await GET('/api/health'); if (r.status < 500) return; } catch (_) {}
    await sleep(300);
  }
  throw new Error('server did not start');
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), POWERX_ROLE: 'api', JWT_SECRET: 'rate-hier-test-secret',
           PAYMENT_LEDGER_BACKFILL_ON_STARTUP: 'false', SMPP_ALLOW_CONTENT_SUPPRESSION: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);

  try {
    await waitReady();
    // ---------- login ----------
    const adminLogin = await POST('/api/login', { username: 'vibepk', password: 'vibepk123' });
    const admin = adminLogin.body.token;
    ok('admin login', !!admin, JSON.stringify(adminLogin.body).slice(0, 120));

    // ---------- users: manager -> agent -> client ----------
    const mk = async (username, role, parent_id) => {
      const r = await POST('/api/users', { username, password: 'Test1234', role, parent_id }, admin);
      const id = (r.body && (r.body.id || (r.body.user && r.body.user.id)));
      ok(`create ${role} ${username}`, !!id, JSON.stringify(r.body).slice(0, 160));
      return id;
    };
    const mgrId = await mk('h_mgr', 'manager', undefined);
    const agtId = await mk('h_agt', 'agent', mgrId);
    const cliId = await mk('h_cli', 'client', agtId);
    const agt2Id = await mk('h_agt2', 'agent', undefined);   // direct admin -> agent (no manager)

    const login = async (username) => (await POST('/api/login', { username, password: 'Test1234' })).body.token;
    const mgr = await login('h_mgr'), agt = await login('h_agt'), cli = await login('h_cli'), agt2 = await login('h_agt2');
    ok('manager/agent/client/agent2 logins', !!(mgr && agt && cli && agt2));

    // ---------- range with default rate 0.012 ----------
    const rangeName = 'HIER-' + Date.now();
    const rr = await POST('/api/ranges', { name: rangeName, prefix: '4477', currency: 'USD', payment_type: 'weekly_7_1', rate_7_1: '0.012', rate_1_1: '0.010', rate_7_7: '0.013', rate_30_45: '0.014' }, admin);
    ok('range created with default rate 0.012', rr.status === 200 && rr.body.ok === true, JSON.stringify(rr.body));
    const ranges = (await GET('/api/ranges', admin)).body;
    const range = ranges.find(r => r.name === rangeName);
    ok('range id resolved', !!range, JSON.stringify(ranges).slice(0, 120));

    // ---------- numbers ----------
    const nums = [];
    for (let i = 0; i < 12; i++) nums.push('4477009' + String(100000 + i));
    const imp = await POST('/api/numbers/import', { range_id: range.id, numbers: nums, payterm: 'weekly_7_1' }, admin);
    ok('numbers import accepted', imp.status === 200, JSON.stringify(imp.body).slice(0, 160));
    for (let i = 0; i < 40; i++) {
      const j = await GET('/api/numbers/import-jobs/' + (imp.body.job && imp.body.job.job_id), admin);
      if (j.body && j.body.status === 'done') break;
      await sleep(250);
    }
    const numList = (await GET('/api/numbers?range_id=' + range.id, admin)).body;
    const ids = numList.map(n => n.id);
    eq('12 numbers present in range', ids.length, 12);

    const numById = async (id) => (await GET('/api/numbers?range_id=' + range.id, admin)).body.find(n => n.id === id);

    // =====================================================================
    // A. range default rate is used when Admin types nothing
    // =====================================================================
    const aIds = ids.slice(0, 3);
    const allocA = await POST('/api/numbers/smart-divide', { range_ids: [range.id], target_ids: [mgrId], qty: 3, payterm: 'weekly_7_1' }, admin);
    ok('A: admin -> manager (no rate typed) accepted', allocA.status === 200 && allocA.body.total === 3, JSON.stringify(allocA.body).slice(0, 160));
    const aRows = (await GET('/api/numbers?range_id=' + range.id + '&owner=h_mgr', admin)).body.filter(n => aIds.includes(n.id));
    eq('A: no rate typed -> the manager level column stays empty (no cross-level write)', aRows[0] && aRows[0].manager_rate, '');
    eq('A: the range default 0.012 is the effective rate of that allocation', aRows[0] && aRows[0].effective_rate, '0.012');
    const mgrSummary = (await GET('/api/numbers/summary', mgr)).body.find(r => r.range_name === rangeName);
    eq('A: manager sees 0.012 as own default rate', mgrSummary && mgrSummary.my_rate, '0.012');

    // =====================================================================
    // B. Admin's typed rate becomes the effective rate of that allocation
    // =====================================================================
    const bIds = ids.slice(3, 5);
    const allocB = await POST('/api/numbers/allocate', { ids: bIds, target_id: mgrId, rate: '0.014', payterm: 'weekly_7_1' }, admin);
    ok('B: admin -> manager @0.014 accepted', allocB.status === 200 && allocB.body.allocated === 2, JSON.stringify(allocB.body).slice(0, 160));
    const bRows = (await GET('/api/numbers?range_id=' + range.id + '&owner=h_mgr', admin)).body.filter(n => bIds.includes(n.id));
    eq('B: manager_rate = typed 0.014', bRows[0] && bRows[0].manager_rate, '0.014');
    eq('B: display effective_rate = 0.014 (admin view)', bRows[0] && bRows[0].effective_rate, '0.014');

    const cIds = ids.slice(5, 6);
    await POST('/api/numbers/allocate', { ids: cIds, target_id: agt2Id, rate: '0.011' }, admin);
    const cRows = (await GET('/api/numbers?range_id=' + range.id, admin)).body.filter(n => cIds.includes(n.id));
    eq('B: direct Admin->Agent rate 0.011 stored', cRows[0] && cRows[0].agent_rate, '0.011');

    // =====================================================================
    // C. Manager -> Agent: default = the manager's own rate; change respected
    // =====================================================================
    const cNumIds = ids.filter(id => !aIds.concat(bIds, cIds).includes(id));
    await POST('/api/numbers/smart-divide', { range_ids: [range.id], target_ids: [agtId], qty: 2, payterm: 'weekly_7_1' }, mgr);
    const mgrOwned = (await GET('/api/numbers?range_id=' + range.id + '&owner=h_agt', mgr)).body;
    ok('C: manager -> agent allocated 2 numbers', mgrOwned.length === 2, JSON.stringify(mgrOwned.map(r => r.number)));
    eq('C: blank Manager->Agent keeps the agent level empty', mgrOwned[0] && mgrOwned[0].agent_rate, '');
    eq('C: manager level NOT overwritten by the agent allocation', mgrOwned[0] && mgrOwned[0].manager_rate, '');
    const agtDefEff = await (async () => { const r = (await GET('/api/numbers', agt)).body.find(n => n.id === mgrOwned[0].id); return r && r.effective_rate; })();
    eq('C: agent effective default = the manager rate it was given (0.012)', agtDefEff, '0.012');

    /* the manager's own 0.014 number (from B) is now allocated onward at 0.011:
       the agent gets 0.011, the manager keeps 0.014. */
    const cNum = bIds[1];
    await POST('/api/numbers/allocate', { ids: [cNum], target_id: agtId, rate: '0.011' }, mgr);
    const cNumRow = await numById(cNum);
    eq('C: changed agent rate stored 0.011', cNumRow.agent_rate, '0.011');
    eq('C: manager_rate still 0.014 untouched', cNumRow.manager_rate, '0.014');
    eq('C: manager sees own rate 0.014 for that number', cNumRow.effective_rate, '0.014');
    eq('C: agent sees own rate 0.011 for that number', await (async () => (await GET('/api/numbers', agt)).body.find(n => n.id === cNum).effective_rate)(), '0.011');

    // =====================================================================
    // D. Agent -> Client: default 0.00; changed value respected
    // =====================================================================
    const agentOwned = (await GET('/api/numbers?range_id=' + range.id, agt)).body;
    const dFree = agentOwned.filter(n => !n.client);
    const dZero = dFree.find(n => n.id !== cNum).id, dPaid = cNum;   /* 0.012-chain and 0.011-chain */
    await POST('/api/numbers/allocate', { ids: [dZero], target_id: cliId }, agt);           // no rate -> 0
    await POST('/api/numbers/allocate', { ids: [dPaid], target_id: cliId, rate: '0.008' }, agt);
    const zRow = await numById(dZero), pRow = await numById(dPaid);
    eq('D: client rate defaults to 0', zRow.client_rate, '0');
    eq('D: client payout defaults to 0', zRow.payout, '0');
    eq('D: changed client rate stored 0.008', pRow.client_rate, '0.008');
    eq('D: agent rate untouched by client allocation', pRow.agent_rate, '0.011');
    eq('D: manager rate untouched by client allocation', pRow.manager_rate, '0.014');

    // client-facing payloads: own rate only, no internal rates
    const cliNums = (await GET('/api/numbers', cli)).body;
    const cliZero = cliNums.find(n => n.number === zRow.number), cliPaid = cliNums.find(n => n.number === pRow.number);
    eq('D: client sees own rate 0 for number allocated at 0', cliZero && cliZero.payout, '0');
    eq('D: client sees own rate 0.008', cliPaid && cliPaid.payout, '0.008');
    const leaked = cliNums.filter(n => n.manager_rate !== undefined || n.agent_rate !== undefined || n.rate_7_1 !== undefined);
    ok('D: client /api/numbers leaks no internal rate fields', leaked.length === 0, JSON.stringify(leaked.slice(0, 1)));

    // =====================================================================
    // PAYOUT CALCULATIONS (real SMS through the real webhook)
    // =====================================================================
    const lock = { 'x-carrier-lock': 'Dawood' };
    const car = await PUT('/api/carrier-settings', { integration_status: 'enabled', carrier_ip: '127.0.0.1', http_callback_url: '/api/incoming-sms' }, admin, lock);
    ok('carrier webhook enabled for test', car.status === 200, JSON.stringify(car.body).slice(0, 140));

    const sendSms = async (number, cliNum, body) => (await POST('/api/incoming-sms', { number, cli: cliNum, message: body })).status;
    const st1 = await sendSms(pRow.number, '447700900111', 'OTP 111222 on client-paid number');
    const st2 = await sendSms(zRow.number, '447700900112', 'OTP 333444 on client-zero number');
    const mgrRowB = bRows[0];
    const st3 = await sendSms(mgrRowB.number, '447700900113', 'OTP 555666 on manager number');
    ok('ingest accepted (3 SMS)', st1 === 200 && st2 === 200 && st3 === 200, `${st1}/${st2}/${st3}`);

    const db = require(path.join(ROOT, 'node_modules', 'better-sqlite3'))(path.join(DATA_DIR, 'data.sqlite'), { readonly: true });
    const smsRow = (num) => db.prepare('SELECT * FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(num);
    const sPaid = smsRow(pRow.number), sZero = smsRow(zRow.number), sMgr = smsRow(mgrRowB.number);
    eq('payout: stored snapshot = pay-chain end (agent 0.011), client rate stays read-time', sPaid && sPaid.payout_amount, '0.011');
    eq('payout: stored snapshot of the 0.012-chain number = agent 0.012', sZero && sZero.payout_amount, '0.012');
    eq('payout: manager-level 0.014 stored (no client on that number)', sMgr && sMgr.payout_amount, '0.014');
    const led = db.prepare('SELECT amount FROM payment_ledger WHERE sms_record_id=?').all(sPaid.id)[0];
    eq('payout: agent ledger keeps AGENT rate 0.011 (not the client 0.008)', led && led.amount, '0.011');
    const led3 = db.prepare('SELECT amount FROM payment_ledger WHERE sms_record_id=?').all(sMgr.id)[0];
    ok('payout: no agent on manager-owned number -> no agent ledger row', !led3, JSON.stringify(led3));

    // per-role report payouts (single day window = today)
    const today = new Date().toISOString().slice(0, 10);
    const paged = async (token) => (await GET(`/api/sms/paged?from=${today}&to=${today}&limit=100`, token)).body;
    const rowFor = (data, num) => (data.rows || []).find(r => r.number === num);
    const adminRows = await paged(admin), mgrRows = await paged(mgr), agtRows = await paged(agt), cliRows = await paged(cli);
    eq('report: admin row payout on client number = allocated level (0.014)', rowFor(adminRows, pRow.number) && rowFor(adminRows, pRow.number).payout_rate, '0.014');
    eq('report: manager row payout = own manager rate 0.014', rowFor(mgrRows, pRow.number) && rowFor(mgrRows, pRow.number).payout_rate, '0.014');
    eq('report: agent row payout = own agent rate 0.011', rowFor(agtRows, pRow.number) && rowFor(agtRows, pRow.number).payout_rate, '0.011');
    eq('report: client row payout = own client rate 0.008', rowFor(cliRows, pRow.number) && rowFor(cliRows, pRow.number).payout_rate, '0.008');
    eq('report: client row payout on 0-rated number = 0', rowFor(cliRows, zRow.number) && rowFor(cliRows, zRow.number).payout_rate, '0');
    ok('report: client rows expose no internal rates',
      !rowFor(cliRows, pRow.number) || (rowFor(cliRows, pRow.number).manager_rate === undefined && rowFor(cliRows, pRow.number).agent_rate === undefined && rowFor(cliRows, pRow.number).rate_7_1 === undefined));
    numEq('report totals: agent = 0.011 + 0.012 (both own agent rates)', agtRows.totalPayment, 0.023);
    numEq('report totals: client = 0.008 + 0 (own client rates only)', cliRows.totalPayment, 0.008);
    numEq('report totals: manager = 0.014 + 0.014 + 0.012 (own manager rates)', mgrRows.totalPayment, 0.040);
    numEq('report totals: admin = the admin allocation of each SMS (0.014 + 0.012 + 0.014)', adminRows.totalPayment, 0.040);

    // dashboard + stats summary per level
    const dash = async (t) => (await GET('/api/dashboard', t)).body;
    numEq('dashboard: manager payout_week = own manager rates (0.040)', (await dash(mgr)).payout_week, 0.040);
    numEq('dashboard: agent payout_week = own agent rates (0.023)', (await dash(agt)).payout_week, 0.023);
    numEq('dashboard: client payout_week = own client rates (0.008)', (await dash(cli)).payout_week, 0.008);
    numEq('dashboard: admin payout_7d = own allocation rates (0.040)', (await dash(admin)).payout_7d, 0.040);
    const statsClient = (await GET(`/api/stats-summary/client?from=${today}&to=${today}`, admin)).body;
    ok('stats-summary: admin sees client payment at client level 0.008',
      (statsClient.rows || []).some(r => r.key === 'h_cli' && parseFloat(r.payment) === 0.008), JSON.stringify(statsClient.rows));
    const statsAgent = (await GET(`/api/stats-summary/agent?from=${today}&to=${today}`, admin)).body;
    ok('stats-summary: admin sees agent payment at agent level 0.023',
      (statsAgent.rows || []).some(r => r.key === 'h_agt' && parseFloat(r.payment) === 0.023), JSON.stringify(statsAgent.rows));
    const statsManager = (await GET(`/api/stats-summary/manager?from=${today}&to=${today}`, admin)).body;
    ok('stats-summary: admin sees manager payment at manager level 0.040',
      (statsManager.rows || []).some(r => r.key === 'h_mgr' && parseFloat(r.payment) === 0.040), JSON.stringify(statsManager.rows));
    const statsRange = (await GET(`/api/stats-summary/range?from=${today}&to=${today}`, mgr)).body;
    ok('stats-summary/range: manager facet pays at the manager level (0.040)',
      (statsRange.rows || []).some(r => parseFloat(r.payment) === 0.040), JSON.stringify(statsRange.rows));
    const statsByAgent = (await GET(`/api/stats/agent?from=${today}&to=${today}`, admin)).body;
    ok('stats/agent facet: agent pays own level (0.023)',
      (statsByAgent.rows || []).some(r => r.key === 'h_agt' && parseFloat(r.payment) === 0.023), JSON.stringify(statsByAgent).slice(0, 400));
    const grouped = (await GET(`/api/sms/report?from=${today}&to=${today}&group=client`, admin)).body;
    ok('grouped report: my_payout (admin) 0.040 and client_payout 0.008',
      grouped.totals && parseFloat(grouped.totals.my_payout) === 0.040 && parseFloat(grouped.totals.client_payout) === 0.008, JSON.stringify(grouped.totals));
    const groupedCli = (await GET(`/api/sms/report?from=${today}&to=${today}&group=number`, cli)).body;
    ok('grouped report (client): my_payout = own client rates only (0.008)',
      groupedCli.totals && parseFloat(groupedCli.totals.my_payout) === 0.008, JSON.stringify(groupedCli.totals));

    // =====================================================================
    // G. Agent SELF-ALLOCATE keeps the manager's level rate (never the card)
    // =====================================================================
    const range2Name = 'SEL-' + Date.now();
    await POST('/api/ranges', { name: range2Name, prefix: '4478', currency: 'USD', payment_type: 'weekly_7_1', rate_7_1: '0.012' }, admin);
    const range2 = (await GET('/api/ranges', admin)).body.find(r => r.name === range2Name);
    const nums2 = ['4478001' + '10001', '4478001' + '10002', '4478001' + '10003'];
    const imp2 = await POST('/api/numbers/import', { range_id: range2.id, numbers: nums2, payterm: 'weekly_7_1' }, admin);
    for (let i = 0; i < 40; i++) {
      const j = await GET('/api/numbers/import-jobs/' + (imp2.body.job && imp2.body.job.job_id), admin);
      if (j.body && j.body.status === 'done') break;
      await sleep(250);
    }
    const ids2 = (await GET('/api/numbers?range_id=' + range2.id, admin)).body.map(n => n.id);
    eq('G: second range has 3 numbers', ids2.length, 3);
    await POST('/api/numbers/allocate', { ids: ids2, target_id: mgrId, rate: '0.017' }, admin);
    const sel = (await GET('/api/agent/self-allocate/ranges', agt)).body;
    const selRange = (sel.ranges || []).find(r => r.id === range2.id);
    ok('G: self-allocate range shows the MANAGER rate 0.017, not the card 0.012',
      selRange && selRange.rates && selRange.rates.weekly === '0.017' && selRange.rate_source === 'manager', JSON.stringify(selRange));
    const selfAlloc = await POST('/api/agent/self-allocate', { range_id: range2.id, quantity: 2, billing_period: 'weekly' }, agt);
    ok('G: agent self-allocated 2 numbers from the manager pool', selfAlloc.status === 200 && selfAlloc.body.allocated === 2, JSON.stringify(selfAlloc.body).slice(0, 200));
    const selRows = (await GET('/api/numbers?range_id=' + range2.id, agt)).body;
    ok('G: self-allocated numbers keep manager_rate 0.017 AND agent_rate 0.017',
      selRows.length === 2 && selRows.every(n => n.manager_rate === '0.017' && n.agent_rate === '0.017'), JSON.stringify(selRows.map(n => [n.manager_rate, n.agent_rate])));
    await sendSms(selRows[0].number, '447700900116', 'OTP 121212 self allocated');
    const selSms = smsRow(selRows[0].number);
    eq('G: self-allocated SMS pays the agent level 0.017 (not the card 0.012)', selSms.payout_amount, '0.017');
    const selLed = db.prepare('SELECT amount FROM payment_ledger WHERE sms_record_id=?').all(selSms.id)[0];
    eq('G: ledger uses the agent level 0.017', selLed && selLed.amount, '0.017');
    const gAdmin = await paged(admin), gMgr = await paged(mgr), gAgt = await paged(agt);
    eq('G: agent report payout = 0.017', rowFor(gAgt, selRows[0].number).payout_rate, '0.017');
    eq('G: manager report payout = 0.017', rowFor(gMgr, selRows[0].number).payout_rate, '0.017');
    eq('G: admin report payout = 0.017', rowFor(gAdmin, selRows[0].number).payout_rate, '0.017');
    // client level on a self-allocated number: still 0 until the agent sets one
    await POST('/api/numbers/allocate', { ids: [selRows[0].id], target_id: cliId }, agt);
    await sendSms(selRows[0].number, '447700900118', 'OTP 565656 self allocated then client default');
    const gCliRows = (await GET('/api/sms/paged?from=' + today + '&to=' + today + '&limit=100', cli)).body;
    eq('G: client payout on self-allocated number defaults to 0', rowFor(gCliRows, selRows[0].number).payout_rate, '0');
    await POST('/api/numbers/allocate', { ids: [selRows[1].id], target_id: cliId, rate: '0.006' }, agt);
    const gCliRows2 = (await GET('/api/sms/paged?from=' + today + '&to=' + today + '&limit=100', cli)).body;
    const selSms2 = await sendSms(selRows[1].number, '447700900117', 'OTP 343434 self + client rate');
    const gCliRows3 = (await GET('/api/sms/paged?from=' + today + '&to=' + today + '&limit=100', cli)).body;
    eq('G: client sees only their own assigned 0.006', rowFor(gCliRows3, selRows[1].number).payout_rate, '0.006');
    ok('G: client payload carries no internal rate fields',
      !rowFor(gCliRows3, selRows[1].number) || (rowFor(gCliRows3, selRows[1].number).manager_rate === undefined && rowFor(gCliRows3, selRows[1].number).agent_rate === undefined));

    // =====================================================================
    // Parent rates never overwritten + range default still 0.012 on the range
    // =====================================================================
    const rangeAfter = (await GET('/api/ranges', admin)).body.find(r => r.name === rangeName);
    eq('range rate card unchanged (0.012)', rangeAfter.rate_7_1, '0.012');
    const finalRows = (await GET('/api/numbers?range_id=' + range.id, admin)).body;
    const mixed = finalRows.filter(n => n.manager_id && n.agent_id && n.client_id)
      .map(n => `${n.manager_rate}/${n.agent_rate}/${n.client_rate}`);
    ok('three-level rows keep all three independent rates (blank levels stay blank -> read-time defaults)',
      mixed.includes('0.014/0.011/0.008') && mixed.includes('//0'), JSON.stringify(mixed));

    // =====================================================================
    // E. Admin -> Client directly (no agent): admin pays the CLIENT rate
    // =====================================================================
    const eNum = finalRows.find(n => !n.manager_id && !n.agent_id && !n.client_id);
    ok('E: one unallocated number left for the direct-to-client case', !!eNum, JSON.stringify(finalRows.length));
    await POST('/api/numbers/allocate', { ids: [eNum.id], target_id: cliId, rate: '0.009' }, admin);
    const eRow = await numById(eNum.id);
    eq('E: client_rate stored 0.009', eRow.client_rate, '0.009');
    await sendSms(eNum.number, '447700900114', 'OTP 777888 direct admin to client');
    const eSms = smsRow(eNum.number);
    eq('E: stored payout snapshot = client level (no agent/manager)', eSms.payout_amount, '0.009');
    const eAdmin = await paged(admin), eCli = await paged(cli);
    eq('E: admin payout = 0.009 (its own allocation, not the range card 0.012)', rowFor(eAdmin, eNum.number).payout_rate, '0.009');
    eq('E: client payout = 0.009', rowFor(eCli, eNum.number).payout_rate, '0.009');
    const eCliNums = (await GET('/api/numbers', cli)).body.find(n => n.number === eNum.number);
    ok('E: client number row shows own rate, no internals',
      eCliNums && eCliNums.payout === '0.009' && eCliNums.manager_rate === undefined && eCliNums.rate_7_1 === undefined, JSON.stringify(eCliNums));

    // =====================================================================
    // F. System zero (provider reports payout 0) => 0 at EVERY level
    // =====================================================================
    const zres = await POST('/api/incoming-sms', { number: pRow.number, cli: '447700900115', message: 'OTP 999000 provider zero', payout: '0' });
    eq('F: provider-zero ingest accepted', zres.status, 200);
    const zSms = smsRow(pRow.number);
    eq('F: stored payout snapshot = 0', zSms.payout_amount, '0');
    ok('F: limit_reason recorded', !!zSms.limit_reason, JSON.stringify(zSms.limit_reason));
    const fAdmin = await paged(admin), fMgr = await paged(mgr), fAgt = await paged(agt), fCli = await paged(cli);
    const fRow = (rows) => (rows.rows || []).filter(r => r.number === pRow.number).sort((a, b) => b.id - a.id)[0];
    ['admin', 'manager', 'agent', 'client'].forEach((r, i) => {
      const rows = [fAdmin, fMgr, fAgt, fCli][i];
      eq(`F: system-zeroed SMS pays 0 in the ${r} report`, fRow(rows) && fRow(rows).payout_rate, '0');
    });
    // =====================================================================
    // H. blank allocation = the level's OWN source, never the range card
    // =====================================================================
    const hFree = (await GET('/api/numbers?range_id=' + range.id, admin)).body.filter(n => !n.manager_id && !n.agent_id && !n.client_id).slice(0, 2);
    ok('H: two still-unallocated numbers available', hFree.length === 2, JSON.stringify(hFree.map(n => n.number)));
    await POST('/api/numbers/allocate', { ids: hFree.map(n => n.id), target_id: mgrId, rate: '0.013' }, admin);
    const hAlloc = await POST('/api/numbers/allocate', { ids: hFree.map(n => n.id), target_id: agtId }, mgr);   // blank
    ok('H: blank Manager -> Agent allocation accepted', hAlloc.status === 200, JSON.stringify(hAlloc.body).slice(0, 140));
    const hRow = await numById(hFree[0].id);
    eq('H: admin allocation kept 0.013', hRow.manager_rate, '0.013');
    eq('H: blank allocation left the agent level empty', hRow.agent_rate, '');
    const hAgtEff = await (async () => { const r = (await GET('/api/numbers', agt)).body.find(n => n.id === hFree[0].id); return r && r.effective_rate; })();
    eq('H: agent default follows the manager rate 0.013 (not the card 0.012)', hAgtEff, '0.013');
    await sendSms(hRow.number, '447700900119', 'OTP 787878 blank agent default');
    const hSmsRow = smsRow(hRow.number);
    eq('H: stored payout snapshot = agent level 0.013', hSmsRow.payout_amount, '0.013');
    const hLed = db.prepare('SELECT amount FROM payment_ledger WHERE sms_record_id=?').all(hSmsRow.id)[0];
    eq('H: ledger pays the agent 0.013', hLed && hLed.amount, '0.013');
    const hAdminRows = await paged(admin), hMgrRows = await paged(mgr), hAgtRows = await paged(agt);
    eq('H: admin report payout = its own allocation 0.013', rowFor(hAdminRows, hRow.number) && rowFor(hAdminRows, hRow.number).payout_rate, '0.013');
    eq('H: manager report payout = own manager rate 0.013', rowFor(hMgrRows, hRow.number) && rowFor(hMgrRows, hRow.number).payout_rate, '0.013');
    eq('H: agent report payout = own agent default 0.013', rowFor(hAgtRows, hRow.number) && rowFor(hAgtRows, hRow.number).payout_rate, '0.013');

    db.close();
  } catch (e) {
    fail++;
    results.push('FAIL  test crashed: ' + (e && e.stack || e));
  } finally {
    child.kill('SIGKILL');
  }

  console.log(results.join('\n'));
  console.log(`\nRATE-HIERARCHY  PASS ${pass}  FAIL ${fail}   (DATA_DIR ${DATA_DIR})`);
  process.exit(fail ? 1 : 0);
})();
