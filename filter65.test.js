/* §6.5 — Admin SMS Numbers Manager/Agent filter regression suite.
   Builds a real hierarchy against a live server and asserts that the
   Manager / Agent filters return ONLY numbers currently held at that tier. */
const BASE = process.env.BASE || 'http://127.0.0.1:8104';
const ADMIN = { username: 'vibepk', password: 'vibepk123' };
let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  -> ' + extra : '')); }
}
let T = '';
async function api(m, p, b) {
  const r = await fetch(BASE + p, { method: m,
    headers: Object.assign({ 'Content-Type': 'application/json' }, T ? { Authorization: 'Bearer ' + T } : {}),
    body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async qs => { const r = await api('GET', '/api/numbers?paged=1&limit=100&' + qs); return (r.body && r.body.rows) || []; };
const idsOf = rows => rows.map(r => r.id).sort((a, b) => a - b);

(async () => {
  const l = await api('POST', '/api/login', ADMIN);
  if (!l.body || !l.body.token) { console.log('LOGIN FAILED', l.status, JSON.stringify(l.body)); process.exit(1); }
  T = l.body.token;

  const stamp = Date.now().toString().slice(-6);
  const nm = 'm' + stamp, na1 = 'a1' + stamp, na2 = 'a2' + stamp, nm2 = 'm2' + stamp;
  const mk = async (u, role, parent) => (await api('POST', '/api/users', Object.assign({ username: u, password: 'Testpass123', role }, parent ? { parent_id: parent } : {}))).body || {};
  const M = await mk(nm, 'manager'), M2 = await mk(nm2, 'manager');
  const A1 = await mk(na1, 'agent', M.id), A2 = await mk(na2, 'agent', M.id);
  ok(M.id && M2.id && A1.id && A2.id, 'hierarchy created (manager + 2 child agents + 2nd manager)');

  await api('POST', '/api/providers-info', { name: 'PROV-' + stamp, conn_type: 'HTTP', payment_term: 'Weekly', currency: 'USD', status: 'Active' });
  await api('POST', '/api/ranges', { name: 'R65-' + stamp, provider: 'PROV-' + stamp, rate_1_1: '0.30', rate_7_1: '0.30', rate_7_7: '0.30', rate_30_45: '0.30', payment_type: 'weekly' });
  const rlist = (await api('GET', '/api/ranges')).body || [];
  const range = rlist.find(x => x.name === 'R65-' + stamp);
  ok(!!(range && range.id), 'range created');

  const nums = []; for (let i = 0; i < 12; i++) nums.push('4477' + stamp + String(10 + i));
  const imp = await api('POST', '/api/numbers/import', { range_id: range.id, numbers: nums });
  const jobId = imp.body && imp.body.job && imp.body.job.job_id;
  for (let i = 0; i < 60; i++) { const j = await api('GET', '/api/numbers/import-jobs/' + jobId); if (j.body && j.body.status === 'completed') break; await sleep(250); }

  const all = await get('range=' + encodeURIComponent(range.name));
  const ids = idsOf(all);
  ok(ids.length === 12, '12 numbers imported into the range', 'got ' + ids.length);

  const alloc = (list, target) => api('POST', '/api/numbers/allocate', { ids: list, target_id: target });
  const toM  = ids.slice(0, 4);   // 4 held by manager M
  const toM2 = ids.slice(4, 6);   // 2 held by manager M2
  const toA1 = ids.slice(6, 8);   // 2 held by agent A1 (child of M)
  const toA2 = ids.slice(8, 9);   // 1 held by agent A2 (child of M)
  // ids[9..11] stay unallocated
  await alloc(toM, M.id); await alloc(toM2, M2.id); await alloc(toA1, A1.id); await alloc(toA2, A2.id);

  console.log('\n  --- §6.5 core assertions ---');
  let rows = await get('manager=' + nm);
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toM),
     'Manager filter shows ONLY numbers allocated to that Manager (' + toM.length + ')',
     'got ' + JSON.stringify(idsOf(rows)));
  ok(rows.every(r => r.manager_name === nm && !r.agent_name && !r.client_name),
     'Manager filter rows carry no Agent/Client (not merely associated)');

  rows = await get('manager=' + nm2);
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toM2),
     'Manager filter excludes another Manager\'s numbers', 'got ' + JSON.stringify(idsOf(rows)));

  rows = await get('agent=' + na1);
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toA1),
     'Agent filter shows ONLY that Agent\'s numbers', 'got ' + JSON.stringify(idsOf(rows)));

  rows = await get('agent=' + na2);
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toA2), 'Agent filter isolates sibling Agent');

  console.log('\n  --- composition with Range / Provider / search / pagination ---');
  rows = await get('manager=' + nm + '&range=' + encodeURIComponent(range.name));
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toM), 'Manager + Range filter compose');

  rows = await get('manager=' + nm + '&provider=' + encodeURIComponent('PROV-' + stamp));
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toM), 'Manager + Provider filter compose');

  rows = await get('manager=' + nm + '&range=' + encodeURIComponent('NO-SUCH-RANGE'));
  ok(rows.length === 0, 'Manager + non-matching Range returns 0');

  rows = await get('agent=' + na1 + '&provider=' + encodeURIComponent('PROV-' + stamp));
  ok(JSON.stringify(idsOf(rows)) === JSON.stringify(toA1), 'Agent + Provider filter compose');

  // pagination / counts: page through the manager result 1 per page
  const p1 = await api('GET', '/api/numbers?paged=1&limit=2&manager=' + nm);
  const p2 = await api('GET', '/api/numbers?paged=1&limit=2&page=2&manager=' + nm);
  ok(p1.body && p1.body.total === toM.length, 'total count matches (' + toM.length + ')', p1.body && String(p1.body.total));
  ok((p1.body.rows || []).length === 2 && (p2.body.rows || []).length === 2, 'pagination returns full pages');
  const seen = idsOf((p1.body.rows || []).concat(p2.body.rows || []));
  ok(JSON.stringify(seen) === JSON.stringify(toM), 'all pages together = the Manager\'s numbers');

  // digit search still works alongside (scoped to this run's range)
  const one = (await get('range=' + encodeURIComponent(range.name))).find(r => r.id === toM[0]);
  const digits = String(one.number).replace(/\D/g, '');
  rows = await get('manager=' + nm + '&search=' + encodeURIComponent(digits));
  ok(rows.length >= 1 && rows.some(r => r.id === toM[0]), 'Manager + digit search compose',
     'searched ' + digits + ' got ' + rows.length);

  console.log('\n  --- unallocated / allocated toggles unaffected ---');
  // scoped to this run's range so leftover numbers from other tests cannot skew the count
  const RS = 'range=' + encodeURIComponent(range.name) + '&';
  rows = await get(RS + 'allocation=unallocated');
  ok(idsOf(rows).length === 3, 'allocation=unallocated still returns the 3 free numbers', 'got ' + idsOf(rows).length);
  rows = await get(RS + 'allocation=allocated');
  ok(idsOf(rows).length === 9, 'allocation=allocated still returns the 9 taken numbers', 'got ' + idsOf(rows).length);

  console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + '  pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
