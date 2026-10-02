'use strict';
/*
 * Unit test: weekly Credit Notes book (backend/creditNoteBook.js).
 * Pure in-memory SQLite; asserts the approved rules:
 *  - amounts come from the existing ledger (agent) / manager-rate SMS payout (manager)
 *  - current week keeps updating; released weeks are frozen; nothing is deleted
 *  - releasing a manager note never releases agent notes
 *  - manager can only release own agents; agent can only read own notes; admin sees all
 *  - minimum payout rule untouched (values echoed from payment_v2_settings)
 */
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

/* --- minimal copies of the EXISTING server helpers this module consumes --- */
function fmt(n) { const p = String(n).padStart(2, '0'); return p; }
function civilAdd(dateStr, n) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${fmt(dt.getUTCMonth() + 1)}-${fmt(dt.getUTCDate())}`;
}
const NOW = new Date('2026-09-30T12:00:00Z');           // Wednesday 2026-09-30
const CUR_WEEK = '2026-09-28';                          // Monday (weekly_start_dow=1)
const PAYABLE = '2026-10-07 00:00:00';                  // Wed of the following week (weekly_pay_dow=3)

const io = {
  schedulePeriodFor(type, ukDateStr) {
    const dow = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T00:00:00Z').getUTCDay()];
    const startDow = 1, payDow = 3;
    const idxOf = (s) => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[s];
    const dowIdx = idxOf(dow(ukDateStr));
    const startMs = Date.UTC(...ukDateStr.split('-').map((v, i) => i === 1 ? +v - 1 : +v)) - ((dowIdx - startDow + 7) % 7) * 86400000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    const end = civilAdd(start, 6);
    const delay = ((payDow - ((startDow + 6) % 7) + 6) % 7) + 1;
    const payDate = civilAdd(end, delay);
    return { start, end, payMs: Date.UTC(...payDate.split('-').map((v, i) => i === 1 ? +v - 1 : +v)) };
  },
  utcSqlFromMs(ms) { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); },
  ukParts(d) { const u = new Date(d.toISOString()); return { year: String(u.getUTCFullYear()), month: fmt(u.getUTCMonth() + 1), day: fmt(u.getUTCDate()) }; },
  utcMsFromUkDate(s, plus = 0) { const d = civilAdd(s, plus); return Date.UTC(...d.split('-').map((v, i) => i === 1 ? +v - 1 : +v)); },
  civilAdd,
  rolePayoutSql(role) { return 's.payout_rate'; },   // stand-in for the real server expression (s.* columns)
  paymentTypesSettings() { return [{ payment_type: 'weekly', label: 'Weekly', min_withdrawal: '15' }, { payment_type: 'daily', label: 'Daily', min_withdrawal: '5' }]; },
  paymentMinimum(t) { return t === 'weekly' ? '15' : '5'; },
  normalizeDecimalString(v) { const s = String(v ?? '').replace(/[^0-9.\-]/g, ''); return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); },
  paymentAudit() { auditCalls++; },
};
let auditCalls = 0;

const sql = new Database(':memory:');
sql.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, parent_id INTEGER, payment_type TEXT DEFAULT '');
CREATE TABLE ranges(id INTEGER PRIMARY KEY, name TEXT, rate_7_1 TEXT);
CREATE TABLE numbers(id INTEGER PRIMARY KEY, range_id INTEGER);
CREATE TABLE sms_records(id INTEGER PRIMARY KEY, number_id INTEGER, range_id INTEGER, manager_id INTEGER, agent_id INTEGER, client_id INTEGER, received_at TEXT, is_test INTEGER DEFAULT 0, payout_rate TEXT DEFAULT '', payout_amount TEXT DEFAULT '');
CREATE TABLE payment_ledger(id INTEGER PRIMARY KEY, sms_record_id INTEGER UNIQUE, agent_id INTEGER, manager_id INTEGER, range_id INTEGER, payment_type TEXT, amount TEXT, earned_at TEXT, cycle_key TEXT, eligible_at TEXT, status TEXT, request_id INTEGER);
CREATE TABLE payment_v2_settings(payment_type TEXT PRIMARY KEY, label TEXT, min_withdrawal TEXT, active INTEGER, sort_order INTEGER);
CREATE TABLE payment_audit_logs(id INTEGER PRIMARY KEY, actor_id INTEGER, actor_name TEXT, actor_role TEXT, action TEXT, request_id INTEGER, agent_id INTEGER, manager_id INTEGER, payment_type TEXT, amount TEXT, wallet_address TEXT, status TEXT, details TEXT);
CREATE TABLE payment_schedule(payment_type TEXT PRIMARY KEY, weekly_start_dow INTEGER, weekly_pay_dow INTEGER, monthly_start_day INTEGER, monthly_delay_days INTEGER);
CREATE TABLE credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_role TEXT NOT NULL, subject_id INTEGER NOT NULL, manager_id INTEGER,
  payment_type TEXT DEFAULT 'weekly', cycle_key TEXT NOT NULL, period_start TEXT DEFAULT '', period_end TEXT DEFAULT '',
  eligible_at TEXT DEFAULT '', amount TEXT DEFAULT '0', basis TEXT DEFAULT 'ledger', status TEXT DEFAULT 'Pending',
  released_at TEXT DEFAULT '', released_by INTEGER, released_by_name TEXT DEFAULT '', released_by_role TEXT DEFAULT '',
  release_note TEXT DEFAULT '', paid_to TEXT DEFAULT '', created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
  UNIQUE(subject_role, subject_id, payment_type, cycle_key));
INSERT INTO users VALUES (1,'Admin','admin',NULL,''),(2,'Manager One','manager',1,''),(3,'Agent A','agent',2,''),(4,'Agent B','agent',2,''),(5,'Other Manager','manager',1,''),(6,'Other Agent','agent',5,''),(7,'Client X','client',3,'');
INSERT INTO ranges VALUES (1,'RANGE_A','2');
INSERT INTO numbers VALUES (1,1);
INSERT INTO payment_schedule VALUES ('weekly',1,3,1,45);
/* manager-level SMS payout: two SMS in the CURRENT week (10 + 5) and one older week (4) */
INSERT INTO sms_records(id,number_id,range_id,manager_id,agent_id,received_at,is_test,payout_rate) VALUES
 (1,1,1,2,3,'2026-09-29 10:00:00',0,'10'),
 (2,1,1,2,4,'2026-09-30 09:00:00',0,'5'),
 (3,1,1,2,3,'2026-09-22 10:00:00',0,'4'),
 (4,1,1,5,6,'2026-09-29 10:00:00',0,'7');
/* agent ledger: A current week 3+2, A previous week 15, B current week 1 */
INSERT INTO payment_ledger(sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status) VALUES
 (1,3,2,1,'weekly','3','2026-09-29 10:00:00','2026-09-28','${PAYABLE}','open'),
 (2,4,2,1,'weekly','5','2026-09-30 09:00:00','2026-09-28','${PAYABLE}','open'),
 (3,3,2,1,'weekly','15','2026-09-22 10:00:00','2026-09-21','2026-09-30 00:00:00','open'),
 (4,6,5,1,'weekly','9','2026-09-29 10:00:00','2026-09-28','${PAYABLE}','paid');
`);

const db = {
  get: (s, p = []) => sql.prepare(s).get(...p),
  all: (s, p = []) => sql.prepare(s).all(...p),
  run: (s, p = []) => sql.prepare(s).run(...p),
};
const app = { get() {}, post() {} };
const { mount } = require('../backend/creditNoteBook');
const api = mount(app, Object.assign({ db, authRequired: (q, s, n) => n(), requireRole: () => (q, s, n) => n(), requireAgentChatUnlock: (q, s, n) => n() }, io));

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS', name); }

/* date used by the module is real "now" — freeze by overriding Date via ukParts injection */
io.ukParts = () => ({ year: '2026', month: '09', day: '30' });

test('Sync creates 14 weekly notes per manager and agent (3 months kept)', () => {
  api._test.sync();
  const all = db.all("SELECT * FROM credit_notes");
  assert.equal(all.length, (2 + 3) * 14);                       // 2 managers + 3 agents
  assert.ok(all.every(r => r.status === 'Pending'));
  assert.ok(all.every(r => r.cycle_key <= CUR_WEEK));
});

test('Agent note = existing ledger amount, accumulated live in the current week', () => {
  const a = api._test.queryNotes({ id: 3, role: 'agent' }, {});
  const cur = a.rows.find(r => r.cycle_key === CUR_WEEK);
  assert.equal(cur.amount, '3');
  assert.equal(cur.is_current, true);
  assert.equal(cur.period_start, '2026-09-28');
  assert.equal(cur.period_end, '2026-10-04');                   // Mon -> Sun from the configured week
  assert.equal(cur.eligible_at, PAYABLE);
  /* a NEW ledger row in the same week must be reflected on the next read (no week-end creation) */
  db.run("INSERT INTO payment_ledger(sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status) VALUES (5,3,2,1,'weekly','2','2026-09-30 11:00:00','2026-09-28','" + PAYABLE + "','open')");
  const again = api._test.queryNotes({ id: 3, role: 'agent' }, {});
  assert.equal(again.rows.find(r => r.cycle_key === CUR_WEEK).amount, '5');
});

test('Earlier weeks preserved (15 + 5 = separate records, total outstanding 20)', () => {
  const a = api._test.queryNotes({ id: 3, role: 'agent' }, { status: 'Pending' });
  assert.equal(a.rows.find(r => r.cycle_key === '2026-09-21').amount, '15');
  assert.equal(a.totals.my_pending, '20');
  assert.equal(a.totals.rows_scoped, 14);
});

test('Manager note = manager-rate payout of the same week (existing expression)', () => {
  const m = api._test.queryNotes({ id: 2, role: 'manager' }, { subject_role: 'manager' });
  assert.equal(m.rows.find(r => r.cycle_key === CUR_WEEK).amount, '15');   // 10 + 5
  assert.equal(m.rows.find(r => r.cycle_key === '2026-09-21').amount, '4');
});

test('Manager sees own note + own agents only (other manager/agent hidden)', () => {
  const m = api._test.queryNotes({ id: 2, role: 'manager' }, {});
  assert.ok(m.rows.some(r => r.subject_role === 'manager' && r.subject_id === 2));
  assert.ok(m.rows.some(r => r.subject_role === 'agent' && r.subject_id === 3));
  assert.ok(!m.rows.some(r => r.subject_id === 5 || r.subject_id === 6));
});

test('Agent scope is own notes and no IDOR', () => {
  const a = api._test.queryNotes({ id: 3, role: 'agent' }, {});
  assert.ok(a.rows.every(r => r.subject_role === 'agent' && r.subject_id === 3));
  assert.throws(() => api._test.queryNotes({ id: 3, role: 'agent' }, { agent_id: '4' }), /Forbidden/);
});

test('Admin sees manager + agent notes, filterable by manager and by agent', () => {
  const all = api._test.queryNotes({ id: 1, role: 'admin' }, {});
  assert.equal(all.rows.length, (2 + 3) * 14);
  assert.ok(all.rows.some(r => r.subject_role === 'manager'));
  assert.ok(all.rows.some(r => r.subject_role === 'agent'));
  const byMgr = api._test.queryNotes({ id: 1, role: 'admin' }, { manager_id: '2' });
  assert.ok(byMgr.rows.every(r => (r.subject_role === 'manager' && r.subject_id === 2) || (r.subject_role === 'agent' && r.manager_id === 2)));
  const byAgent = api._test.queryNotes({ id: 1, role: 'admin' }, { agent_id: '4', subject_role: 'agent' });
  assert.ok(byAgent.rows.every(r => r.subject_id === 4));
});

test('Release: manager releases own agent note only, recorded with who/paid-to', () => {
  const note = db.get("SELECT * FROM credit_notes WHERE subject_role='agent' AND subject_id=3 AND cycle_key=?", [CUR_WEEK]);
  const out = api._test.releaseNote({ user: { id: 2, username: 'Manager One', role: 'manager' }, body: { paid_to: 'BINANCE-UID-123', release_note: 'paid 02 Oct' } }, note.id);
  assert.equal(out.note.status, 'Released');
  const row = db.get('SELECT * FROM credit_notes WHERE id=?', [note.id]);
  assert.equal(row.released_by, 2);
  assert.equal(row.released_by_name, 'Manager One');
  assert.equal(row.released_by_role, 'manager');
  assert.equal(row.paid_to, 'BINANCE-UID-123');
  assert.ok(row.released_at);
  assert.equal(auditCalls, 1);
  /* manager cannot release another manager's agent, nor their own manager note */
  const other = db.get("SELECT * FROM credit_notes WHERE subject_role='agent' AND subject_id=6 AND cycle_key=?", [CUR_WEEK]);
  assert.throws(() => api._test.releaseNote({ user: { id: 2, role: 'manager', username: 'm' }, body: {} }, other.id), /Forbidden/);
  const own = db.get("SELECT * FROM credit_notes WHERE subject_role='manager' AND subject_id=2 AND cycle_key=?", [CUR_WEEK]);
  assert.throws(() => api._test.releaseNote({ user: { id: 2, role: 'manager', username: 'm' }, body: {} }, own.id), /Forbidden/);
  assert.throws(() => api._test.releaseNote({ user: { id: 3, role: 'agent', username: 'a' }, body: {} }, own.id), /Forbidden/);
});

test('Released note is frozen: later week payouts do NOT change it and it is never deleted', () => {
  const before = db.get("SELECT * FROM credit_notes WHERE subject_role='agent' AND subject_id=3 AND cycle_key=?", [CUR_WEEK]);
  db.run("INSERT INTO payment_ledger(sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status) VALUES (6,3,2,1,'weekly','100','2026-09-30 12:00:00','2026-09-28','" + PAYABLE + "','open')");
  api._test.sync();
  const after = db.get('SELECT * FROM credit_notes WHERE id=?', [before.id]);
  assert.equal(after.amount, before.amount);
  assert.equal(after.status, 'Released');
  assert.ok(before.id);
});

test('Releasing the manager note does NOT release that manager\'s agent notes', () => {
  const mNote = db.get("SELECT * FROM credit_notes WHERE subject_role='manager' AND subject_id=2 AND cycle_key=?", [CUR_WEEK]);
  const rel = api._test.releaseNote({ user: { id: 1, username: 'Admin', role: 'admin' }, body: { paid_to: 'Binance TX 99' } }, mNote.id);
  assert.equal(rel.note.status, 'Released');
  const agentsPending = db.all("SELECT status FROM credit_notes WHERE subject_role='agent' AND manager_id=2 AND cycle_key=? AND id<>?", [CUR_WEEK, db.get("SELECT id FROM credit_notes WHERE subject_role='agent' AND subject_id=3 AND cycle_key=?", [CUR_WEEK]).id]);
  assert.ok(agentsPending.length >= 1);
  assert.ok(agentsPending.every(r => r.status === 'Pending'));
});

test('Released notes stay visible in history with release info', () => {
  const a = api._test.queryNotes({ id: 3, role: 'agent' }, { status: 'Released' });
  const cur = a.rows.find(r => r.cycle_key === CUR_WEEK);
  assert.equal(cur.status, 'Released');
  assert.equal(cur.released_by_name, 'Manager One');
  assert.equal(cur.paid_to, 'BINANCE-UID-123');
  assert.equal(cur.cycle_key, CUR_WEEK);
  assert.equal(cur.period_start, '2026-09-28');
});

test('Double release rejected; totals split Pending vs Released; minimums echoed unchanged', () => {
  const rel = db.get("SELECT * FROM credit_notes WHERE status='Released' LIMIT 1");
  assert.throws(() => api._test.releaseNote({ user: { id: 1, role: 'admin', username: 'Admin' }, body: {} }, rel.id), /already released/);
  const a = api._test.queryNotes({ id: 1, role: 'admin' }, {});
  assert.equal(a.minimum.weekly, '15');
  assert.ok(a.minimum.by_type.find(t => t.payment_type === 'daily').min_withdrawal === '5');
  assert.ok(Number(a.totals.pending) > 0 && Number(a.totals.released) > 0);
  assert.equal(a.week.cycle_key, CUR_WEEK);
  assert.equal(a.week.payable_on, PAYABLE);
});

test('Weekly window bounds: rows older than 14 cycles are not returned but stay in the table', () => {
  const oldKey = '2026-01-05';
  db.run("INSERT INTO credit_notes(subject_role,subject_id,manager_id,payment_type,cycle_key,period_start,period_end,amount,status) VALUES ('agent',3,2,'weekly',?,?,'2026-01-11','7','Pending')", [oldKey, oldKey]);
  const a = api._test.queryNotes({ id: 1, role: 'admin' }, {});
  assert.ok(!a.rows.some(r => r.cycle_key === oldKey));
  assert.equal(db.get("SELECT COUNT(*) c FROM credit_notes WHERE cycle_key=?", [oldKey]).c, 1);
});

console.log(`${n} credit-note tests passed; in-memory database only.`);
sql.close();
