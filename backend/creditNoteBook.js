'use strict';
/*
 * Credit Notes — weekly payout tracking layer.
 *
 * Rules implemented here (per approved spec):
 *  - amounts always come from EXISTING payout data:
 *      agent rows   -> SUM(payment_ledger.amount) for that agent's weekly cycle_key
 *      manager rows -> the same manager-rate payout expression the manager
 *                      dashboard uses, summed over the manager's SMS in the week
 *  - the weekly period is the EXISTING payment_schedule week (e.g. Mon -> Sun)
 *    produced by schedulePeriodFor(); nothing is hard-coded here.
 *  - the CURRENT week is continuously re-synced, older weeks stay as recorded.
 *  - the minimum payout is NOT changed: nothing here resets, deletes or merges
 *    earlier weeks; release is only a recorded status change (money moves
 *    outside the panel).  Released rows are frozen and never deleted.
 *  - 3 months (14 weekly cycles) of history is kept and returned.
 *  - releasing a manager's note never touches an agent's note (independent rows).
 */
const HISTORY_WEEKS = 14;              // 3 months of weekly cycles
const PAYMENT_TYPE = 'weekly';         // the configured payout week drives credit notes

function civilAdd(dateStr, n) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
/* exact micro-unit decimal add (payout amounts can carry more than 2 dp) */
function toMicros(v) {
  let s = String(v ?? '').trim().replace(/[$,\s]/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/); if (!m) return 0n;
  s = m[0];
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  let [a, b = ''] = s.split('.');
  b = (b + '000000').slice(0, 6);
  const n = BigInt(a || '0') * 1000000n + BigInt(b || '0');
  return neg ? -n : n;
}
function fmtMoney(micros) {
  const neg = micros < 0n; let n = neg ? -micros : micros;
  const whole = n / 1000000n; let frac = (n % 1000000n).toString().padStart(6, '0');
  frac = frac.slice(0, 2).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

function mount(app, io) {
  const {
    db, authRequired, requireRole, requireAgentChatUnlock,
    schedulePeriodFor, utcSqlFromMs, ukParts, utcMsFromUkDate, civilAdd: serverCivilAdd,
    rolePayoutSql, paymentTypesSettings, paymentMinimum, normalizeDecimalString, paymentAudit,
  } = io;

  const add = serverCivilAdd || civilAdd;
  const num = v => Number(normalizeDecimalString(v) || '0') || 0;

  function ukToday() { const p = ukParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }

  /* The configured weekly cycle containing ukDate (existing schedule logic). */
  function weekOf(ukDate) { return schedulePeriodFor(PAYMENT_TYPE, ukDate); }

  /* Manager-level payout for one exact week, from the manager's SMS records. */
  function managerWeekAmount(managerId, startStr, endStr) {
    const from = utcSqlFromMs(utcMsFromUkDate(startStr, 0));
    const to = utcSqlFromMs(utcMsFromUkDate(endStr, 1));
    const row = db.get(
      `SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(${rolePayoutSql('manager')},''),'0') AS REAL)),0) AS p
       FROM sms_records s LEFT JOIN numbers n ON n.id=s.number_id LEFT JOIN ranges r ON r.id=s.range_id
       WHERE COALESCE(s.is_test,0)=0 AND s.manager_id=? AND s.received_at>=? AND s.received_at<?`,
      [managerId, from, to]);
    return (row && row.p) || 0;
  }
  function agentWeekAmount(agentId, cycleKey) {
    const row = db.get(
      `SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(amount,''),'0') AS REAL)),0) AS p
       FROM payment_ledger WHERE agent_id=? AND payment_type=? AND cycle_key=?`,
      [agentId, PAYMENT_TYPE, cycleKey]);
    return (row && row.p) || 0;
  }

  function upsertNote(subjectRole, subjectId, managerId, cycleKey) {
    const per = schedulePeriodFor(PAYMENT_TYPE, cycleKey);
    const eligibleAt = utcSqlFromMs(per.payMs);
    const raw = subjectRole === 'manager'
      ? managerWeekAmount(subjectId, per.start, per.end)
      : agentWeekAmount(subjectId, cycleKey);
    const amount = fmtMoney(toMicros(round2(raw)));
    const ex = db.get('SELECT * FROM credit_notes WHERE subject_role=? AND subject_id=? AND payment_type=? AND cycle_key=?',
      [subjectRole, subjectId, PAYMENT_TYPE, cycleKey]);
    if (!ex) {
      db.run(`INSERT INTO credit_notes (subject_role,subject_id,manager_id,payment_type,cycle_key,period_start,period_end,eligible_at,amount,basis,status,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,'Pending',?)`,
        [subjectRole, subjectId, managerId ?? null, PAYMENT_TYPE, cycleKey, per.start, per.end, eligibleAt, amount,
          subjectRole === 'manager' ? 'sms' : 'ledger', nowSql()]);
      return;
    }
    /* Released rows are frozen forever; anything else keeps tracking the
       accumulated payout (the current week especially). */
    if (String(ex.status) === 'Released') return;
    db.run(`UPDATE credit_notes SET amount=?, period_start=?, period_end=?, eligible_at=?, manager_id=COALESCE(?,manager_id), updated_at=?
            WHERE id=?`,
      [amount, per.start, per.end, eligibleAt, managerId ?? null, nowSql(), ex.id]);
  }
  function round2(v) { const n = Number(v) || 0; return (Math.round(n * 100) / 100).toFixed(2); }

  /* Keep the 14-week window present/updated for every manager and agent.
     Only additive writes to credit_notes; payout data itself is never touched. */
  function sync() {
    const today = ukToday();
    const curStart = weekOf(today).start;
    const weeks = [];
    for (let i = 0; i < HISTORY_WEEKS; i++) weeks.push(add(curStart, -7 * i));
    const agents = db.all("SELECT id, username, parent_id FROM users WHERE role='agent'");
    const managers = db.all("SELECT id, username FROM users WHERE role='manager'");
    for (const m of managers) for (const w of weeks) upsertNote('manager', m.id, m.id, w);
    for (const a of agents) for (const w of weeks) upsertNote('agent', a.id, a.parent_id ?? null, w);
  }
  function syncSafe() { try { sync(); } catch (e) { /* reads must still work */ } }

  function agentIdsOfManager(managerId) {
    return db.all('SELECT id, username FROM users WHERE role=? AND parent_id=?', ['agent', managerId]).map(r => r.id);
  }

  function queryNotes(user, q) {
    syncSafe();
    const limit = Math.min(500, Math.max(1, parseInt(q.limit || '500', 10) || 500));
    const weeks = Math.min(26, Math.max(1, parseInt(q.weeks || String(HISTORY_WEEKS), 10) || HISTORY_WEEKS));
    const today = ukToday();
    const minKey = add(weekOf(today).start, -7 * (weeks - 1));
    const where = ['cn.payment_type=?', 'cn.cycle_key>=?'];
    const params = [PAYMENT_TYPE, minKey];
    const ors = [];
    if (user.role === 'admin') {
      /* admin sees manager notes + agent notes; optional filters narrow it */
      if (q.subject_role) { where.push('cn.subject_role=?'); params.push(String(q.subject_role)); }
      if (q.manager_id) {
        const mid = parseInt(q.manager_id, 10);
        if (mid) {
          const ids = agentIdsOfManager(mid);
          if (q.subject_role === 'manager') { where.push('cn.subject_id=?'); params.push(mid); }
          else if (q.subject_role === 'agent') {
            where.push('cn.subject_role=?'); params.push('agent'); where.push('cn.subject_id IN (' + (ids.length ? ids.map(() => '?').join(',') : 'NULL') + ')'); params.push(...ids);
          } else {
            ors.push({ sql: '(cn.subject_role=? AND cn.subject_id=?)', params: ['manager', mid] });
            ors.push({ sql: '(cn.subject_role=? AND cn.subject_id IN (' + (ids.length ? ids.map(() => '?').join(',') : 'NULL') + '))', params: ['agent', ...ids] });
          }
        }
      }
      if (q.agent_id) {
        const aid = parseInt(q.agent_id, 10);
        if (q.subject_role === 'manager') { where.push('1=0'); }
        else { where.push("cn.subject_role='agent'"); where.push('cn.subject_id=?'); params.push(aid || -1); }
      }
    } else if (user.role === 'manager') {
      const ids = agentIdsOfManager(user.id);
      where.push(`(cn.subject_role='agent' AND cn.subject_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'}) OR (cn.subject_role='manager' AND cn.subject_id=?))`);
      params.push(...ids, user.id);
      if (q.agent_id) { const aid = parseInt(q.agent_id, 10); where.push('cn.subject_role=?'); params.push('agent'); where.push('cn.subject_id=?'); params.push(aid || -1); }
      if (q.manager_id) {
        const mid = parseInt(q.manager_id, 10);
        if (mid && mid !== user.id) { where.push('1=0'); }
      }
      if (q.subject_role) { where.push('cn.subject_role=?'); params.push(String(q.subject_role)); }
    } else if (user.role === 'agent') {
      where.push("cn.subject_role='agent'"); where.push('cn.subject_id=?'); params.push(user.id);
      if (q.agent_id && parseInt(q.agent_id, 10) !== user.id) throw Object.assign(new Error('Forbidden'), { status: 403 });
    } else {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    if (q.status) { where.push('cn.status=?'); params.push(String(q.status)); }
    if (q.payment_type && String(q.payment_type) !== PAYMENT_TYPE) {
      /* only the configured weekly cycle produces credit notes */
      where.push('1=0');
    }
    let sql = `SELECT cn.*, us.username AS subject_name,
                      um.username AS manager_name, ur.username AS released_by_username
               FROM credit_notes cn
               LEFT JOIN users us ON us.id = cn.subject_id AND us.role = cn.subject_role
               LEFT JOIN users um ON um.id = cn.manager_id
               LEFT JOIN users ur ON ur.id = cn.released_by
               WHERE ` + where.join(' AND ');
    if (ors.length) {
      const parts = ors.map(o => o.sql);
      sql += ' AND (' + parts.join(' OR ') + ')';
      for (const o of ors) params.push(...o.params);
    }
    sql += ' ORDER BY (cn.status=?) DESC, cn.cycle_key DESC, cn.subject_role ASC, subject_name ASC LIMIT ?';
    params.push('Pending', limit);
    const rows = db.all(sql, params);

    /* Outstanding = everything still Pending, regardless of the page filter. */
    const outstanding = scopeTotals(user);
    const settings = paymentTypesSettings().map(t => ({ payment_type: t.payment_type, label: t.label, min_withdrawal: t.min_withdrawal }));
    const per = weekOf(today);
    return {
      role: user.role,
      generated_at: new Date().toISOString(),
      payment_type: PAYMENT_TYPE,
      week: { start: per.start, end: per.end, payable_on: utcSqlFromMs(per.payMs), cycle_key: per.start },
      history_weeks: weeks,
      minimum: { weekly: paymentMinimum(PAYMENT_TYPE), by_type: settings },
      totals: outstanding,
      rows: rows.map(r => ({
        id: r.id, subject_role: r.subject_role, subject_id: r.subject_id, subject_name: r.subject_name || '',
        manager_id: r.manager_id, manager_name: r.manager_name || '',
        payment_type: r.payment_type, cycle_key: r.cycle_key, period_start: r.period_start, period_end: r.period_end,
        eligible_at: r.eligible_at, amount: r.amount, basis: r.basis,
        status: r.status, is_current: r.cycle_key === per.start,
        released_at: r.released_at || '', released_by: r.released_by || null,
        released_by_name: r.released_by_name || r.released_by_username || '', released_by_role: r.released_by_role || '',
        release_note: r.release_note || '', paid_to: r.paid_to || '',
        can_release: user.role === 'admin' ? r.status === 'Pending'
          : (user.role === 'manager' ? (r.subject_role === 'agent' && r.status === 'Pending' && isMyAgent(user.id, r.subject_id)) : false),
      })),
      total: rows.length,
      notes: [
        'Amounts mirror existing payout data (payment ledger for agents, manager payout rates for managers); no money moves here.',
        'Release only records that the payout was made outside the panel; earlier weeks are never reset or deleted.',
        'Releasing a manager note never releases that manager\'s agent notes — each note is released separately.',
      ],
    };
  }
  function isMyAgent(managerId, agentId) {
    return !!db.get("SELECT id FROM users WHERE id=? AND role='agent' AND parent_id=?", [agentId, managerId]);
  }
  /* Totals for the viewer's whole scope (independent of row filters). */
  function scopeTotals(user) {
    let cond = '', params = [];
    if (user.role === 'admin') { cond = '1=1'; }
    else if (user.role === 'manager') {
      const ids = agentIdsOfManager(user.id);
      cond = `(subject_role='agent' AND subject_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})) OR (subject_role='manager' AND subject_id=?)`;
      params = [...ids, user.id];
    } else { cond = "subject_role='agent' AND subject_id=?"; params = [user.id]; }
    const r = db.all(`SELECT subject_role, status, cycle_key, amount FROM credit_notes WHERE payment_type=? AND (${cond})`, [PAYMENT_TYPE, ...params]);
    let pending = 0n, released = 0n, myPend = 0n, myRel = 0n;
    for (const x of r) {
      const v = toMicros(x.amount);
      if (x.status === 'Released') released += v; else pending += v;
      if (user.role === 'manager' && x.subject_role === 'manager') { if (x.status === 'Released') myRel += v; else myPend += v; }
      if (user.role === 'agent') { if (x.status === 'Released') myRel += v; else myPend += v; }
    }
    return {
      pending: fmtMoney(pending), released: fmtMoney(released), total: fmtMoney(pending + released),
      my_pending: fmtMoney(myPend), my_released: fmtMoney(myRel), my_total: fmtMoney(myPend + myRel),
      rows_scoped: r.length,
    };
  }

  function releaseNote(req, id) {
    const user = req.user;
    const row = db.get('SELECT * FROM credit_notes WHERE id=?', [id]);
    if (!row) throw Object.assign(new Error('Credit note not found'), { status: 404 });
    if (String(row.status) === 'Released') throw Object.assign(new Error('This credit note is already released'), { status: 409 });
    if (user.role === 'admin') { /* admin may release manager and agent notes */ }
    else if (user.role === 'manager') {
      if (row.subject_role !== 'agent' || !isMyAgent(user.id, row.subject_id)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    } else throw Object.assign(new Error('Forbidden'), { status: 403 });
    const paidTo = String((req.body && req.body.paid_to) || '').slice(0, 120);
    const note = String((req.body && req.body.release_note) || '').slice(0, 300);
    db.run(`UPDATE credit_notes SET status='Released', released_at=?, released_by=?, released_by_name=?, released_by_role=?, release_note=?, paid_to=?, updated_at=? WHERE id=? AND status<>'Released'`,
      [nowSql(), user.id, user.username || '', user.role || '', note, paidTo, nowSql(), row.id]);
    const fresh = db.get('SELECT * FROM credit_notes WHERE id=?', [row.id]);
    if (fresh && String(fresh.status) !== 'Released') throw Object.assign(new Error('Release did not apply'), { status: 409 });
    try {
      paymentAudit(req, 'credit_note_release', {
        agent_id: row.subject_role === 'agent' ? row.subject_id : null,
        manager_id: row.subject_role === 'manager' ? row.subject_id : row.manager_id,
        payment_type: row.payment_type, amount: row.amount, status: 'Released',
        details: { credit_note_id: row.id, cycle_key: row.cycle_key, subject_role: row.subject_role, subject_id: row.subject_id, paid_to: paidTo, note },
      });
    } catch (e) { /* audit must never block the recorded release */ }
    return { ok: true, note: mapRow(fresh), message: 'Credit note released. Agent notes are not affected.' };
  }
  function mapRow(r) {
    return r ? { id: r.id, subject_role: r.subject_role, subject_id: r.subject_id, payment_type: r.payment_type, cycle_key: r.cycle_key, period_start: r.period_start, period_end: r.period_end, eligible_at: r.eligible_at, amount: r.amount, status: r.status, released_at: r.released_at || '', released_by_name: r.released_by_name || '', released_by_role: r.released_by_role || '', release_note: r.release_note || '', paid_to: r.paid_to || '' } : null;
  }

  app.get('/api/credit-notes', authRequired, requireRole('admin', 'manager', 'agent'), requireAgentChatUnlock, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(queryNotes(req.user, req.query || {})); }
    catch (e) { res.status(e.status || 400).json({ error: e.message || 'Unable to read credit notes' }); }
  });
  app.post('/api/credit-notes/:id/release', authRequired, requireRole('admin', 'manager'), (req, res) => {
    try { res.json(releaseNote(req, parseInt(req.params.id, 10))); }
    catch (e) { res.status(e.status || 400).json({ error: e.message || 'Unable to release credit note' }); }
  });
  /* admin: combined view of manager + agent notes across selected managers (same endpoint + ?manager_id=) */

  return { _test: { queryNotes, releaseNote, sync, weekOf, HISTORY_WEEKS, fmtMoney, toMicros } };
}
module.exports = { mount, HISTORY_WEEKS };
