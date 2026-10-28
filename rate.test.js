/* Agent -> Client rate/payout rule verification.
   Uses the ACTUAL effExpr SQL extracted from backend/server.js so the test
   exercises shipped logic, not a re-implementation. */
const fs = require('fs');
const D = require('better-sqlite3');
const src = fs.readFileSync(__dirname + '/backend/server.js', 'utf8');

// pull the client-branch effective-rate expression straight out of the source
const m = src.match(/\} else if \(role === 'client'\) \{[\s\S]*?effExpr = `([\s\S]*?)`;/);
if (!m) { console.error('could not extract client effExpr from server.js'); process.exit(1); }
const EFF = m[1];
console.log('Extracted client effExpr from server.js:\n  ' + EFF.replace(/\s+/g, ' ').trim() + '\n');

const _r = new D(':memory:');
const db = {
  all: (q, p) => _r.prepare(q).all(...(p || [])),
  get: (q, p) => _r.prepare(q).get(...(p || [])),
  run: (q, p) => _r.prepare(q).run(...(p || [])),
  exec: (q) => _r.exec(q),
  prepare: (q) => _r.prepare(q),
};
db.exec(`CREATE TABLE numbers(
  id INTEGER PRIMARY KEY, number TEXT, range_id INTEGER,
  client_id INTEGER, agent_id INTEGER, manager_id INTEGER,
  rate TEXT DEFAULT '', payout TEXT DEFAULT '',
  manager_rate TEXT DEFAULT '', agent_rate TEXT DEFAULT '', client_rate TEXT DEFAULT ''
);`);
db.exec(`CREATE TABLE ranges(id INTEGER PRIMARY KEY, name TEXT, rate_7_1 TEXT, rate_7_7 TEXT, rate_1_1 TEXT, rate_30_45 TEXT);`);
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, parent_id INTEGER);`);

// two agents, two clients, so we can also prove no cross-agent leakage
db.run("INSERT INTO users VALUES (1,'admin1','admin',null),(2,'mgr1','manager',1),(3,'agtA','agent',2),(4,'agtB','agent',2),(5,'cliX','client',null),(6,'cliY','client',null)");
db.run("INSERT INTO ranges VALUES (1,'R1','0.9','0.8','0.7','0.6')"); // a range rate that must NEVER leak in

// id, agent, client, client_rate, payout, rate
const rows = [
  [1, 3, 5, '',     '',     '0.9'],   // agent configured nothing
  [2, 3, 5, '0',    '0',    '0.9'],   // agent configured zero
  [3, 3, 5, '0.00', '0.00', '0.9'],   // agent configured 0.00
  [4, 3, 5, '0.1',  '0.1',  '0.9'],   // agent configured 0.1
  [5, 3, 5, '0.2',  '0.2',  '0.9'],   // agent configured 0.2
  [6, 3, 5, '1.25', '1.25', '0.9'],   // other valid non-zero
  // STALE CASE: agent has since zeroed the rate, but an old non-zero value
  // lingers in the `payout` column (the exact bug being fixed)
  [7, 3, 5, '',     '0.75', '0.9'],
  // another agent's number allocated to another client
  [8, 4, 6, '0.3',  '0.3',  '0.9'],
];
for (const [id, a, c, cr, po, rt] of rows)
  db.run('INSERT INTO numbers(id,agent_id,client_id,client_rate,payout,rate) VALUES (?,?,?,?,?,?)', [id, a, c, cr, po, rt]);

function rateFor(id) {
  return db.get('SELECT ' + EFF + ' AS effective_rate FROM numbers n WHERE n.id=?', [id]).effective_rate;
}
// what the OLD buggy expression would have returned (client_rate -> payout -> '0')
function oldRateFor(id) {
  return db.get(`SELECT COALESCE(
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(n.client_rate,''))),'NA'),''),
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(n.payout,''))),'NA'),''),
      '0') AS v FROM numbers n WHERE n.id=?`, [id]).v;
}

let pass = 0, fail = 0;
function t(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   (got: ' + extra + ')' : '')); }
}

console.log('=== requirement table: Agent configured value -> Client rate ===');
t('empty / not configured   -> 0', rateFor(1) === '0', rateFor(1));
t('"0"                      -> 0', rateFor(2) === '0', rateFor(2));
t('"0.00"                   -> 0', rateFor(3) === '0', rateFor(3));
t('"0.1"                    -> 0.1', rateFor(4) === '0.1', rateFor(4));
t('"0.2"                    -> 0.2', rateFor(5) === '0.2', rateFor(5));
t('other valid non-zero 1.25-> 1.25', rateFor(6) === '1.25', rateFor(6));

console.log('\n=== zeroing must not leave an obsolete value behind ===');
t('rate cleared/zeroed + stale payout 0.75 -> client sees 0', rateFor(7) === '0', rateFor(7));
console.log('    (old buggy expression would have returned: ' + oldRateFor(7) + ' from the stale payout column)');
t('and that is exactly what the old logic got wrong', oldRateFor(7) === '0.75');

console.log('\n=== no invented default from the range rate ===');
let leaked = false;
for (const id of [1, 2, 3, 7]) if (rateFor(id) === '0.9' || rateFor(id) === '0.8' || rateFor(id) === '0.6') leaked = true;
t('range rate 0.9/0.8/0.6 never substituted', !leaked);

console.log('\n=== no cross-agent / cross-client leakage ===');
t("agent A's client (id5) sees 0.2", rateFor(5) === '0.2', rateFor(5));
t("agent B's client (id8) sees 0.3", rateFor(8) === '0.3', rateFor(8));
t('the two are different (independent)', rateFor(5) !== rateFor(8));

console.log('\n=== stability: repeated reads identical (refresh / re-login) ===');
const snap = [1, 2, 3, 4, 5, 6, 7, 8].map(rateFor).join('|');
const snap2 = [1, 2, 3, 4, 5, 6, 7, 8].map(rateFor).join('|');
t('two full passes identical', snap === snap2, snap + ' vs ' + snap2);

console.log('\n=== zero-normalisation covers every zero spelling ===');
for (const z of ['0', '0.0', '0.00', '0.000', '0.000000']) {
  db.run('UPDATE numbers SET client_rate=? WHERE id=9 OR id=9', [z]);
  db.run('INSERT OR REPLACE INTO numbers(id,agent_id,client_id,client_rate,payout,rate) VALUES (9,3,5,?,?,?)', [z, z, '0.9']);
  t("'" + z + "' resolves to 0", rateFor(9) === '0', rateFor(9));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
