/* End-to-end hierarchical number-return verification against a LIVE server.
   Logs in once per role (login limiter = 10 / 5 min), then exercises:
     A. Client returns 4 of 25 -> only those leave, Agent keeps them
     B. Agent returns -> Clients released, Manager released, Admin sees free
     C. Manager returns -> cascades to Agent + Clients
     D. Admin unallocated inventory
     E. permissions, duplicates, already-returned, SMS/CDR preserved, atomicity
*/
const B = 'http://localhost:8102';
const D = require('better-sqlite3');
const _d = new D('backend/ret.sqlite');
const db = {
  get: (q, p) => _d.prepare(q).get(...(p || [])),
  all: (q, p) => _d.prepare(q).all(...(p || [])),
  run: (q, p) => _d.prepare(q).run(...(p || [])),
  exec: (q) => _d.exec(q),
};
const idOf = (n) => (db.get('SELECT id FROM users WHERE username=?', [n]) || {}).id;
const M = idOf('rt_mgr'), A = idOf('rt_agt'), C = idOf('rt_cli'), C2 = idOf('rt_cli2');

async function call(method, path, body, token) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t }; }
}
const post = (p, b, t) => call('POST', p, b, t);
const get = (p, t) => call('GET', p, undefined, t);

function counts() {
  return db.get(`SELECT
    SUM(CASE WHEN client_id=?  THEN 1 ELSE 0 END) cli,
    SUM(CASE WHEN client_id=? THEN 1 ELSE 0 END) cli2,
    SUM(CASE WHEN agent_id=?   THEN 1 ELSE 0 END) agt,
    SUM(CASE WHEN manager_id=? THEN 1 ELSE 0 END) mgr,
    SUM(CASE WHEN manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL THEN 1 ELSE 0 END) free
    FROM numbers WHERE range_id=77`, [C, C2, A, M]);
}
function ownedBy(col, id) { return db.all(`SELECT id FROM numbers WHERE ${col}=? AND range_id=77 ORDER BY id`, [id]).map(r => r.id); }
const smsCount = () => db.get('SELECT COUNT(*) n FROM sms_records').n;
const numCount = () => db.get('SELECT COUNT(*) n FROM numbers WHERE range_id=77').n;

let pass = 0, fail = 0;
function t(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + extra : '')); }
}

(async () => {
  const T = {};
  for (const [k, u] of [['admin', 'vibepk'], ['mgr', 'rt_mgr'], ['agt', 'rt_agt'], ['cli', 'rt_cli'], ['cli2', 'rt_cli2']]) {
    const r = await post('/api/login', { username: u, password: u === 'vibepk' ? 'vibepk123' : 'Testpass123' });
    T[k] = (r.body || {}).token;
    if (!T[k]) { console.error('login failed for ' + u + ': ' + JSON.stringify(r.body)); process.exit(1); }
  }
  console.log('logged in: admin, manager, agent, client, client2\n');

  // ---------- build the starting state ----------
  console.log('=== setup ===');
  // reset range 77 to a known-unallocated state so reruns are deterministic
  db.run("UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, manager_rate='', agent_rate='', client_rate='', payout='0' WHERE range_id=77");
  const allIds = db.all('SELECT id FROM numbers WHERE range_id=77 ORDER BY id').map(r => r.id);
  let a1 = await post('/api/numbers/allocate', { ids: allIds, target_id: M, payout: '0.5' }, T.admin);
  console.log('  admin->manager  [' + a1.status + '] ' + JSON.stringify(a1.body).slice(0, 100));
  const mgrIds = ownedBy('manager_id', M);
  const toAgent = mgrIds.slice(0, 25);
  let a2 = await post('/api/numbers/allocate', { ids: toAgent, target_id: A, payout: '0.3' }, T.mgr);
  console.log('  manager->agent  [' + a2.status + '] ' + JSON.stringify(a2.body).slice(0, 100));
  let a3 = await post('/api/numbers/allocate', { ids: toAgent, target_id: C, payout: '0.1' }, T.agt);
  console.log('  agent->client   [' + a3.status + '] ' + JSON.stringify(a3.body).slice(0, 140));
  let c = counts();
  console.log('  client=' + c.cli + ' agent=' + c.agt + ' manager=' + c.mgr + ' free=' + c.free);
  t('setup: client holds 25', c.cli === 25, c.cli);
  t('setup: agent holds 25', c.agt === 25, c.agt);
  t('setup: manager holds 30', c.mgr === 30, c.mgr);
  const sms0 = smsCount(), nums0 = numCount();

  // ================= A. CLIENT RETURNS 4 of 25 =================
  console.log('\n=== A. Client returns 4 of 25 ===');
  const cliIds = ownedBy('client_id', C);
  const ret4 = cliIds.slice(0, 4);
  const unret = cliIds.slice(4);
  let prev = await post('/api/numbers/return', { ids: ret4 }, T.cli);
  t('preview returns ok + preview flag', prev.status === 200 && prev.body.preview === true, JSON.stringify(prev.body).slice(0, 120));
  t('preview reports 4 numbers', prev.body.count === 4, prev.body.count);
  t('preview says it is NOT cascading', prev.body.cascades === false, prev.body.cascades);
  let r = await post('/api/numbers/return', { ids: ret4, confirm: true }, T.cli);
  t('confirmed return ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  c = counts();
  console.log('  after: client=' + c.cli + ' agent=' + c.agt + ' manager=' + c.mgr + ' free=' + c.free);
  t('client now holds 21 (25-4)', c.cli === 21, c.cli);
  t('agent STILL holds 25 (numbers stay with agent)', c.agt === 25, c.agt);
  t('manager STILL holds 30 (not returned to admin)', c.mgr === 30, c.mgr);
  t('admin free count is still 0 (not sent to admin)', c.free === 0, c.free);
  const stillMine = ownedBy('client_id', C);
  t('the 21 untouched numbers are unchanged', JSON.stringify(stillMine) === JSON.stringify(unret));
  t('returned 4 released from client', ret4.every(id => !stillMine.includes(id)));
  t('returned 4 still belong to the agent', ret4.every(id => ownedBy('agent_id', A).includes(id)));
  t('returned 4 are free for the agent (client_id NULL)', ret4.every(id => db.get('SELECT client_id FROM numbers WHERE id=?', [id]).client_id === null));

  // ================= E1. PERMISSIONS =================
  console.log('\n=== E. Permissions ===');
  const otherCli = ownedBy('client_id', C).slice(0, 2);
  let bad = await post('/api/numbers/return', { ids: otherCli, confirm: true }, T.cli2);
  t('another client CANNOT return them (404/403)', bad.status === 404 || bad.status === 403, bad.status);
  const mgrOnly = ownedBy('manager_id', M).filter(id => !ownedBy('agent_id', A).includes(id));
  bad = await post('/api/numbers/return', { ids: mgrOnly.slice(0, 1), confirm: true }, T.agt);
  t('agent CANNOT return a manager-only number', bad.status === 404 || bad.status === 403, bad.status);
  bad = await post('/api/numbers/return', { ids: [999999], confirm: true }, T.cli);
  t('nonexistent id rejected safely', bad.status >= 400, bad.status);
  bad = await post('/api/numbers/return', {}, T.cli);
  t('missing ids rejected', bad.status === 400, bad.status);
  bad = await post('/api/numbers/return', { ids: ['abc', null, -5], confirm: true }, T.cli);
  t('garbage ids rejected', bad.status >= 400, bad.status);

  // ================= B. AGENT RETURNS =================
  console.log('\n=== B. Agent returns numbers up to Admin ===');
  const agtIds = ownedBy('agent_id', A);
  const agtRet = agtIds.slice(0, 6);          // 6 numbers, 2 of which belong to client2
  const c2Before = ownedBy('client_id', C2);
  prev = await post('/api/numbers/return', { ids: agtRet }, T.agt);
  t('preview reports the cascade', prev.body.cascades === true, prev.body.cascades);
  t('preview lists clients that will be released', Array.isArray(prev.body.releases_clients), JSON.stringify(prev.body.releases_clients));
  r = await post('/api/numbers/return', { ids: agtRet, confirm: true }, T.agt);
  t('agent return ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  c = counts();
  console.log('  after: client=' + c.cli + ' client2=' + c.cli2 + ' agent=' + c.agt + ' manager=' + c.mgr + ' free=' + c.free);
  t('agent now holds 19 (25-6)', c.agt === 19, c.agt);
  t('manager released those 6 (30-6=24)', c.mgr === 24, c.mgr);
  t('admin free count is 6', c.free === 6, c.free);
  t('returned numbers free of client', agtRet.every(id => db.get('SELECT client_id FROM numbers WHERE id=?', [id]).client_id === null));
  t('returned numbers free of agent', agtRet.every(id => db.get('SELECT agent_id FROM numbers WHERE id=?', [id]).agent_id === null));
  t('returned numbers free of manager', agtRet.every(id => db.get('SELECT manager_id FROM numbers WHERE id=?', [id]).manager_id === null));
  const c2After = ownedBy('client_id', C2);
  t('downstream client2 allocations were released', agtRet.filter(id => c2Before.includes(id)).every(id => !c2After.includes(id)));

  // ================= C. MANAGER RETURNS =================
  console.log('\n=== C. Manager returns numbers (cascade) ===');
  const mgrNow = ownedBy('manager_id', M);
  const mgrRet = mgrNow.slice(0, 5);
  const agtBefore = ownedBy('agent_id', A), cliBefore = ownedBy('client_id', C);
  prev = await post('/api/numbers/return', { ids: mgrRet }, T.mgr);
  t('preview reports the cascade', prev.body.cascades === true, prev.body.cascades);
  r = await post('/api/numbers/return', { ids: mgrRet, confirm: true }, T.mgr);
  t('manager return ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  c = counts();
  console.log('  after: client=' + c.cli + ' agent=' + c.agt + ' manager=' + c.mgr + ' free=' + c.free);
  t('manager now holds 19 (24-5)', c.mgr === 19, c.mgr);
  t('admin free count is 11 (6+5)', c.free === 11, c.free);
  t('agent released those 5', agtBefore.filter(id => mgrRet.includes(id)).every(id => !ownedBy('agent_id', A).includes(id)));
  t('client released those 5', cliBefore.filter(id => mgrRet.includes(id)).every(id => !ownedBy('client_id', C).includes(id)));
  t('no orphan downstream: nothing has client/agent without manager',
    db.get(`SELECT COUNT(*) n FROM numbers WHERE range_id=77 AND manager_id IS NULL AND (agent_id IS NOT NULL OR client_id IS NOT NULL)`).n === 0);

  // ================= D + E: integrity =================
  console.log('\n=== D/E. Integrity: no duplicates, no data loss ===');
  t('number count unchanged (30, nothing deleted)', numCount() === nums0, numCount() + ' vs ' + nums0);
  t('SMS/CDR history untouched (' + sms0 + ' rows)', smsCount() === sms0, smsCount() + ' vs ' + sms0);
  t('no number has conflicting duplicate owners',
    db.get(`SELECT COUNT(*) n FROM numbers WHERE range_id=77 AND agent_id IS NOT NULL AND client_id IS NOT NULL AND manager_id IS NULL`).n === 0);
  t('every number id still unique', db.get('SELECT COUNT(DISTINCT id) n FROM numbers WHERE range_id=77').n === 30);

  // idempotency / already-returned
  console.log('\n=== already-returned + duplicates ===');
  const again = await post('/api/numbers/return', { ids: mgrRet, confirm: true }, T.mgr);
  t('returning already-returned numbers is rejected safely', again.status === 404, again.status);
  const dup = await post('/api/numbers/return', { ids: [ownedBy('manager_id', M)[0], ownedBy('manager_id', M)[0], ownedBy('manager_id', M)[0]], confirm: true }, T.mgr);
  t('duplicate ids in one request handled (no double counts)', dup.status === 200 && dup.body.count === 1, dup.body.count);

  // refresh / re-login stability
  console.log('\n=== refresh + re-login stability ===');
  const a = JSON.stringify(counts());
  const b2 = JSON.stringify(counts());
  t('repeated reads identical', a === b2);
  const rl = await post('/api/login', { username: 'rt_mgr', password: 'Testpass123' });
  if (rl.body && rl.body.token) {
    const after = JSON.stringify(counts());
    t('state stable after re-login', after === a);
  } else { console.log('  SKIP  re-login (rate limited)'); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
