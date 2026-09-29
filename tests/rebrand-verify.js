/* Skyline SMS rebrand + overhaul verification (run against live test server on :4100). */
const B = 'http://127.0.0.1:4100/api';
let adminTok, mgrTok, agtTok, cliTok;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(path, body, tok) {
  const r = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function get(path, tok) {
  const r = await fetch(B + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  const j = await r.json().catch(() => ({}));
  if (Array.isArray(j)) { j.http_status = r.status; return j; }
  return { status: r.status, ...j };
}
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌ FAIL:', msg); } }

async function main() {
  console.log('== AUTH ==');
  const la = await post('/login', { username: 'vibepk', password: 'vibepk123' });
  adminTok = la.token; ok(!!adminTok, 'admin login');
  ok((await get('/health')).service === 'Skyline SMS', 'health service says Skyline SMS');

  console.log('== USERS ==');
  const um = await post('/users', { username: 'mgr1', password: 'mgr1pass', role: 'manager', name: 'Manager One' }, adminTok);
  ok(um.status === 200 || um.status === 201 || um.ok, 'manager created ' + (um.error || ''));
  const ua = await post('/users', { username: 'agt1', password: 'agt1pass', role: 'agent', name: 'Agent One', parent_id: um.id || um.user?.id }, adminTok);
  ok(ua.status === 200 || ua.status === 201 || ua.ok, 'agent created ' + (ua.error || ''));
  const uc = await post('/users', { username: 'cli1', password: 'cli1pass', role: 'client', name: 'Client One', parent_id: ua.id || ua.user?.id }, adminTok);
  ok(uc.status === 200 || uc.status === 201 || uc.ok, 'client created ' + (uc.error || ''));
  const mgrId = um.id || um.user?.id, agtId = ua.id || ua.user?.id, cliId = uc.id || uc.user?.id;
  ok(mgrId && agtId && cliId, `ids mgr=${mgrId} agt=${agtId} cli=${cliId}`);
  mgrTok = (await post('/login', { username: 'mgr1', password: 'mgr1pass' })).token;
  agtTok = (await post('/login', { username: 'agt1', password: 'agt1pass' })).token;
  cliTok = (await post('/login', { username: 'cli1', password: 'cli1pass' })).token;
  ok(mgrTok && agtTok && cliTok, 'all logins');

  console.log('== RANGE + NUMBERS ==');
  const rg = await post('/ranges', { name: 'SkylineTestRange', currency: 'USD', rate_1_1: 'NA', rate_7_1: '0.0100', rate_7_7: '0.0090', rate_30_45: '0.0080', payment_type: 'weekly_7_1', test_numbers: '111000001,111000002' }, adminTok);
  ok(rg.ok, 'range created ' + (rg.error || ''));
  const ranges = await get('/ranges', adminTok);
  const range = ranges.find(r => r.name === 'SkylineTestRange');
  ok(!!range, 'range listed');
  const tnSeed = await get('/test-numbers?paged=1&page=1&limit=50&range=SkylineTestRange', adminTok);
  ok(tnSeed.rows.some(r => String(r.number) === '111000001'), 'test numbers seeded on range (in panel)');

  // import 40 live numbers
  const nums = Array.from({ length: 40 }, (_, i) => '7770000' + String(100 + i));
  const imp = await post('/numbers/import', { range_id: range.id, range_name: 'SkylineTestRange', numbers: nums }, adminTok);
  ok(imp.ok || (imp.inserted >= 40), '40 numbers imported: ' + JSON.stringify(imp).slice(0, 120));

  // import runs as a background job — poll until 40 numbers exist
  let allNums = { rows: [] };
  for (let i = 0; i < 30; i++) {
    allNums = await get('/numbers?paged=1&page=1&limit=100', adminTok);
    if ((allNums.rows || []).length >= 40) break;
    await sleep(500);
  }
  ok((allNums.rows || []).length >= 40, 'import job landed (rows=' + (allNums.rows || []).length + ')');

  console.log('== RATE CHAIN admin->manager->agent->client ==');
  // admin allocates 10 to manager with explicit rate 0.020 (handleAllocate ids path)
  const ids10 = allNums.rows.slice(0, 10).map(r => r.id);
  const a1 = await post('/numbers/allocate', { ids: ids10, target_id: mgrId, payterm: 'weekly_7_1', rate: '0.020' }, adminTok);
  ok(a1.ok || a1.allocated === 10, 'admin->manager 10 allocated ' + (a1.error || JSON.stringify(a1).slice(0, 100)));
  const mNums = await get('/numbers?paged=1&page=1&limit=50', mgrTok);
  ok(mNums.rows.length === 10, 'manager sees 10 numbers');
  ok(mNums.rows.every(r => Math.abs(parseFloat(r.effective_rate) - 0.02) < 1e-9), 'manager effective_rate=0.02 (assigned), row: ' + (mNums.rows[0] || {}).effective_rate);

  // manager -> agent 6 at 0.030
  const mIds = mNums.rows.slice(0, 6).map(r => r.id);
  const a2 = await post('/numbers/allocate', { ids: mIds, target_id: agtId, payterm: 'weekly_7_1', rate: '0.030' }, mgrTok);
  ok(a2.ok || a2.allocated === 6, 'manager->agent 6 allocated ' + (a2.error || ''));
  const agNums = await get('/numbers?paged=1&page=1&limit=50', agtTok);
  ok(agNums.rows.length === 6, 'agent sees 6 numbers');
  ok(agNums.rows.every(r => Math.abs(parseFloat(r.effective_rate) - 0.03) < 1e-9), 'agent effective_rate=0.03 (manager-assigned), got ' + (agNums.rows[0] || {}).effective_rate);

  // agent -> client 2 with explicit rate 0.040
  const c2 = agNums.rows.slice(0, 2).map(r => r.id);
  const a3 = await post('/numbers/allocate', { ids: c2, target_id: cliId, payterm: 'weekly_7_1', rate: '0.040' }, agtTok);
  ok(a3.ok || a3.allocated === 2, 'agent->client 2 allocated ' + (a3.error || ''));
  // agent -> client remaining 2 with NO rate (default payout)
  const c2b = agNums.rows.slice(2, 4).map(r => r.id);
  const a3b = await post('/numbers/allocate', { ids: c2b, target_id: cliId, payterm: 'weekly_7_1' }, agtTok);
  ok(a3b.ok || a3b.allocated === 2, 'agent->client 2 more (no rate) allocated ' + (a3b.error || ''));

  const cliNumbers = await get('/numbers?paged=1&page=1&limit=50', cliTok);
  ok(cliNumbers.rows.length === 4, 'client sees 4 numbers');
  const explicit = cliNumbers.rows.filter(r => c2.includes(r.id));
  const defaulted = cliNumbers.rows.filter(r => c2b.includes(r.id));
  ok(explicit.every(r => Math.abs(parseFloat(r.client_rate) - 0.04) < 1e-9), 'explicit client_rate=0.04 preserved');
  ok(defaulted.every(r => String(r.payout) === '0'), 'default payout stays 0.00, got ' + JSON.stringify(defaulted.map(r => r.payout)));

  console.log('== TEST PANEL ==');
  // single add
  const t1 = await post('/test-numbers', { range_name: 'SkylineTestRange', number: '111000003' }, adminTok);
  ok(t1.ok, 'single test number added ' + (t1.error || ''));
  // duplicate rejected
  const t1d = await post('/test-numbers', { range_name: 'SkylineTestRange', number: '111000003' }, adminTok);
  ok(t1d.status === 409, 'duplicate test number rejected (409)');
  // client cannot add
  const t1c = await post('/test-numbers', { range_name: 'SkylineTestRange', number: '111000009' }, cliTok);
  ok(t1c.status === 403 || t1c.status === 401, 'client blocked from test-number admin');

  // move 2 agent-owned numbers to test (ownership captured)
  const mvIds = agNums.rows.slice(4, 6).map(r => r.id);
  const mv = await post('/numbers/move-to-test', { ids: mvIds }, adminTok);
  ok(mv.ok && mv.moved === 2, '2 numbers moved to test ' + JSON.stringify(mv).slice(0, 120));
  const tlist0 = await get('/test-numbers?paged=1&page=1&limit=50&range=SkylineTestRange', adminTok);
  const movedRows = tlist0.rows.filter(r => mvIds.includes(r.prev_number_id || -1) || true);
  // check via direct where on numbers that live rows are gone
  const stillLive = await get('/numbers?paged=1&page=1&limit=100', agtTok);
  ok(!stillLive.rows.some(r => mvIds.includes(r.id)), 'moved numbers left live inventory (agent sees 4, has ' + stillLive.rows.length + ')');

  // move ONE back — ownership must be restored
  const tList = await get('/test-numbers?paged=1&page=1&limit=50&range=SkylineTestRange', adminTok);
  ok(tList.rows.length >= 3, 'test numbers listed with filter (' + tList.rows.length + ')');
  const oneBack = tList.rows.find(r => !['111000001', '111000002', '111000003'].includes(String(r.number)));
  ok(!!oneBack && !!oneBack.id, 'found moved test number row w/ id');
  const mb = await post('/test-numbers/move-back', { ids: [oneBack.id] }, adminTok);
  ok(mb.ok && mb.moved === 1, 'move-back executed ' + JSON.stringify(mb).slice(0, 100));
  // verify restored ownership via admin numbers export query
  const after = await get('/numbers?paged=1&page=1&limit=500&range=SkylineTestRange', adminTok);
  const restored = after.rows.find(r => String(r.number) === String(oneBack.number));
  ok(!!restored, 'moved-back number present in live numbers');
  ok(restored && String(restored.agent_id) === String(agtId), `ownership restored to agent (agent_id=${restored && restored.agent_id} expect ${agtId})`);
  ok(restored && String(restored.range_name) === 'SkylineTestRange', 'range preserved');
  // idempotency-ish: moving back same cleaned number again must skip
  const tList2 = await get('/test-numbers?paged=1&page=1&limit=50&range=SkylineTestRange', adminTok);
  const dupGuess = tList2.rows.find(r => String(r.number) === String(restored.number));
  ok(!dupGuess, 'no stale test row left for restored number');

  // bulk delete 2 (of the seeded 111000001..2 + 111000003)
  const bulkIds = tList2.rows.filter(r => ['111000001', '111000002'].includes(String(r.number))).map(r => r.id);
  ok(bulkIds.length === 2, 'bulk target rows found');
  const bd = await post('/test-numbers/delete-bulk', { ids: bulkIds }, adminTok);
  ok(bd.ok && bd.deleted === 2, 'bulk delete 2 → ' + JSON.stringify(bd).slice(0, 80));
  // delete-range (remaining 111000003)
  const dr = await post('/test-numbers/delete-range', { range_id: range.id }, adminTok);
  ok(dr.ok && dr.deleted >= 1, 'delete-range deleted ' + dr.deleted);
  const tList3 = await get('/test-numbers?paged=1&page=1&limit=50&range=SkylineTestRange', adminTok);
  ok(tList3.total === 0, 'range now has 0 test numbers');
  const rng2 = (await get('/ranges', adminTok)).find(r => r.name === 'SkylineTestRange');
  ok((rng2.test_number || '') === '', 'ranges.test_number cache refreshed empty');

  console.log('== SMS DETAIL REPORT (range filter + time-free) ==');
  // ingest one test-free sms row hitting our live number to a client
  const cliNum = cliNumbers.rows[0];
  // incoming-sms HTTP gate (carrier integration) is OFF on this dev box; insert an SMS row directly
  const Database = require('better-sqlite3');
  const dbf = new Database(process.env.TEST_DB || '/tmp/skyline-test2.sqlite');
  const nRow = dbf.prepare('SELECT * FROM numbers WHERE number=?').get(String(cliNum.number));
  dbf.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,source,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))`).run(nRow.id, nRow.number, nRow.range_id, 'Verify', 'sim', 'Your code is 123456', '123456', nRow.client_id, nRow.agent_id, nRow.manager_id, 'verify_script');
  dbf.close();
  await sleep(2500); // read-cache TTL
  const rep = await get('/sms/paged?paged=1&page=1&limit=10&range=SkylineTestRange', adminTok);
  ok(rep.total >= 1 && rep.rows.every(r => r.range_name === 'SkylineTestRange'), 'range filter works on /sms/paged (' + rep.total + ')');
  const rep2 = await get('/sms/paged?paged=1&page=1&limit=10&range=NoSuchRange', adminTok);
  ok(rep2.total === 0, 'wrong range returns 0');
  // grouped by range totalling
  const rep3 = await get('/sms/report?group=range&page=1&limit=10', adminTok);
  ok(rep3.rows && rep3.rows.some(r => (r.dims && r.dims.range === 'SkylineTestRange') || r.range === 'SkylineTestRange'), 'group-by range works (' + JSON.stringify((rep3.rows[0]||{}).dims||'') + ')');

  console.log('== AGENT SELF-ALLOCATE API ==');
  const sar = await get('/agent/self-allocate/ranges', agtTok);
  ok(sar && Array.isArray(sar.ranges), 'self-allocate ranges API responds');

  console.log('== STATIC/BRAND ==');
  for (const p of ['/login', '/admin', '/manager', '/agent', '/client', '/management']) {
    const r = await fetch('http://127.0.0.1:4100' + p);
    const t = await r.text();
    ok(r.status === 200 && /SKYLINE SMS/i.test(t), p + ' renders w/ SKYLINE SMS');
    ok(!/complaints|gx-map-card/i.test(t), p + ' no complaint/map markup');
  }
  const lg = await fetch('http://127.0.0.1:4100/assets/skyline-logo.png');
  ok(lg.status === 200 && (lg.headers.get('content-type') || '').includes('png'), 'logo asset serves');
  const ui = await fetch('http://127.0.0.1:4100/assets/dashboard-ui.js'); const uit = await ui.text();
  ok(uit.includes("'/client/stats'") && !uit.includes('Not available for Client'), 'client dashboard cards trimmed in served file');

  console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(2); });
