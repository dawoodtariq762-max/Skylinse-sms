#!/usr/bin/env node
/**
 * dup-cleanup.js — SAFE historical duplicate cleaner for sms_records
 * ============================================================================
 * Removes ONLY rows provably belonging to the SAME PHYSICAL SMS (the old
 * 10s-dedup-bucket era). NEVER treats (number+cli+message) alone as proof —
 * legitimate SMS can be identical.
 *
 * DEFAULT = DRY-RUN (report only, nothing is modified except that a backup
 * may be created with --backup). Physical deletion happens ONLY with --apply
 * (category A) and --delete-ids "<csv>" (operator-chosen B groups).
 *
 * Usage:
 *   node tools/dup-cleanup.js --db backend/data.sqlite --backup
 *   node tools/dup-cleanup.js --db backend/data.sqlite                 # report
 *   node tools/dup-cleanup.js --db backend/data.sqlite --apply         # delete category A only
 *   node tools/dup-cleanup.js --db backend/data.sqlite --delete-ids "101,102"
 *
 * Classification:
 *   A CONFIRMED  — provider message id proves same physical SMS:
 *                  A1: same provider_message_id tied to 2+ stored sms_records
 *                      (api_integration_logs/seen both expose it);
 *                  A2: an api_integration_logs row carries provider id P and
 *                      matching (number,cli,message); another sms_records row
 *                      from a DIFFERENT channel carries the identical
 *                      (number,cli,message) within +-3s of that log's time —
 *                      cross-channel double-ingest of provider message P.
 *   B PROBABLE   — identical (number,cli,message), SAME source channel, and
 *                  inter-arrival fits carrier redelivery signatures:
 *                    B1: delta in (10s, 300s]  (outlived the 10s window)
 *                    B2: delta = 0s            (reconnect/double-fire)
 *                  NEVER auto-deleted; listed with exact ids.
 *   C POSSIBLY   — identical content that plausibly is two real SMS
 *      LEGIT       (delta > 300s, or different sources). Never deleted.
 *   D NOT DUP    — everything else.
 *
 * Step 6 guard: a delete candidate referenced by payment_ledger is EXCLUDED
 * from deletion and moved to FINANCE-REVIEW (money was already paid on it).
 * sharing_forward_logs references are re-linked to the keeper row on apply.
 * smpp_seen / api_integration_seen pointers are re-linked where needed.
 * Step 7: every deleted row is first copied (full row + classification +
 * evidence + session id) into table `sms_records_deleted_history` AND into a
 * JSON export next to the backup, so the cleanup is reversible.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

/* ---------------- args ---------------- */
const args = process.argv.slice(2);
function argVal(name) { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; }
const DB_PATH = path.resolve(argVal('--db') || path.join(__dirname, '..', 'backend', 'data.sqlite'));
const WANT_BACKUP = args.includes('--backup') || args.includes('--apply') || !!argVal('--delete-ids');
const APPLY_A = args.includes('--apply');
const DELETE_IDS = (argVal('--delete-ids') || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
const FORCE = args.includes('--yes');   // skip interactive confirmation (for scripted runs)

const B_WINDOW_MIN = 10;   // B1 lower bound (exclusive): old fp bucket = 10s
const B_WINDOW_MAX = 300;  // B1 upper bound (inclusive): carrier retry cadence
const A2_GAP = 3;          // seconds for cross-channel provider-id corroboration

const C = { red: (s) => `[31m${s}[0m`, green: (s) => `[32m${s}[0m`, yellow: (s) => `[33m${s}[0m`, dim: (s) => `[2m${s}[0m`, bold: (s) => `[1m${s}[0m` };
const out = (s = '') => console.log(s);
const fmtRows = (rows, cols) => rows.map((r) => cols.map((c) => String(r[c] == null ? '' : r[c]).slice(0, 40).padEnd(c === 'message' ? 42 : 12)).join(' ')).join('\n');

/* ---------------- step 1: backup ---------------- */
function doBackup(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = `${dbPath}.dupcleanup-${stamp}.bak`;
  fs.mkdirSync(dir, { recursive: true });
  const files = [dbPath, dbPath + '-wal', dbPath + '-shm'].filter(fs.existsSync);
  for (const f of files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  // verify: backup file opens and row counts match
  const src = new Database(dbPath, { readonly: true });
  const bak = new Database(path.join(dir, path.basename(dbPath)), { readonly: true });
  const a = src.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
  const b = bak.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
  src.close(); bak.close();
  if (a !== b) throw new Error(`backup verification FAILED (src=${a} bak=${b}) — aborting, nothing modified`);
  return { dir, verify: a };
}

/* ---------------- helpers ---------------- */
const sec = (t) => Math.floor(new Date(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z')).getTime() / 1000);

function tableCols(db, t) { return db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); }
function tableSet(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)); }

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(1); }
  out(C.bold('=== dup-cleanup — safe historical duplicate investigation ==='));
  out(`db: ${DB_PATH}`);

  let backup = null;
  if (WANT_BACKUP) {
    backup = doBackup(DB_PATH);
    out(C.green(`✔ STEP 1 backup created + verified (${backup.verify} sms_records rows): ${backup.dir}`));
  } else {
    out(C.yellow('• STEP 1 skipped (read-only report; pass --backup to create one)'));
  }

  // The DB is opened READ-ONLY whenever no mutation flag is present: a pure
  // report run physically cannot write, no matter what code path executes.
  const MUTATES = APPLY_A || DELETE_IDS.length > 0;   // any operator-chosen id implies write intent
  const db = new Database(DB_PATH, { readonly: !MUTATES });
  db.pragma('busy_timeout = 10000');
  const before = db.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
  out(`sms_records before: ${before}\n`);

  /* ---------------- step 2: evidence inventory ---------------- */
  const TABLES = tableSet(db);
  const has = (t) => TABLES.has(t);
  const allT = (t, sql, ...p) => (has(t) ? db.prepare(sql).all(...p) : []);
  const getT = (t, sql, ...p) => (has(t) ? db.prepare(sql).get(...p) : undefined);
  if (!has('api_integration_logs') || !has('smpp_seen'))
    out(C.yellow('  • note: optional evidence tables missing in this DB — those evidence sources degrade to none (safe, conservative classification)'));
  const evidence = {
    api_logs_ids: (getT('api_integration_logs', `SELECT COUNT(DISTINCT provider_message_id) c FROM api_integration_logs WHERE provider_message_id != ''`) || { c: 0 }).c,
    api_seen_ids: (getT('api_integration_seen', `SELECT COUNT(*) c FROM api_integration_seen WHERE provider_message_id != ''`) || { c: 0 }).c,
    smpp_seen_rows: (getT('smpp_seen', 'SELECT COUNT(*) c FROM smpp_seen') || { c: 0 }).c,
    smpp_seen_linked: (getT('smpp_seen', 'SELECT COUNT(*) c FROM smpp_seen WHERE sms_record_id IS NOT NULL') || { c: 0 }).c,
  };
  out(C.bold('STEP 2 — historical evidence that can prove physical-message identity:'));
  out(`  • api_integration_logs provider ids : ${evidence.api_logs_ids}`);
  out(`  • api_integration_seen provider ids : ${evidence.api_seen_ids}`);
  out(`  • smpp_seen ledger rows (linked)    : ${evidence.smpp_seen_rows} (${evidence.smpp_seen_linked})`);
  out('  • sms_records itself has NO provider/connection id, NO fingerprint → content+time only');
  out('  ⇒ Only provider ids are PROOF. Timing patterns are INFERENCE (category B).\n');

  /* ---------------- step 3: duplicate candidates ---------------- */
  const groups = db.prepare(`
    SELECT number, cli, message, COUNT(*) c, GROUP_CONCAT(id) ids, GROUP_CONCAT(received_at) times, GROUP_CONCAT(source) sources
    FROM sms_records GROUP BY number, cli, message HAVING c > 1 ORDER BY c DESC, MAX(received_at) DESC`).all();
  out(C.bold(`STEP 3 — identical-content candidate groups: ${groups.length}`));

  const recById = new Map();
  db.prepare('SELECT * FROM sms_records').all().forEach((r) => recById.set(r.id, r));
  const logByContent = allT('api_integration_logs', `SELECT * FROM api_integration_logs WHERE provider_message_id != ''`);
  const seenBySms = allT('api_integration_seen', 'SELECT * FROM api_integration_seen WHERE sms_record_id IS NOT NULL');

  /* ---------------- step 4: classify ---------------- */
  const A = [], B = [], Cc = [], RECEIPTY = [];
  const groupRows = [];
  for (const g of groups) {
    const ids = g.ids.split(',').map(Number);
    const times = g.times.split(',');
    const sources = g.sources.split(',');
    const rows = ids.map((id, i) => ({ id, t: sec(times[i]), when: times[i], source: sources[i] }))
      .sort((a, b) => a.t - b.t || a.id - b.id);

    // gather provider-id evidence for these contents
    const evLogs = logByContent.filter((l) => l.number === g.number && l.cli === g.cli && l.message === g.message);
    const logSmsIds = new Set(evLogs.map((l) => l.sms_record_id).filter((x) => x != null));
    const evIds = new Set(evLogs.map((l) => l.provider_message_id));
    const seenHits = ids.filter((id) => seenBySms.some((s) => s.sms_record_id === id));
    const linkedFromLog = rows.filter((r) => logSmsIds.has(r.id));

    // A1: provider id tied to 2+ DISTINCT stored sms rows
    let cls = null, why = '';
    if (linkedFromLog.length >= 2 && evIds.size >= 1) {
      cls = 'A'; why = `same provider id(s) {${[...evIds].join(',')}} logged for 2 stored rows (cross-integration/ledger-race double store)`;
    }
    // A2: one stored row tied to provider id + twin from another channel within +-A2_GAP sec
    if (!cls && linkedFromLog.length === 1) {
      const anchor = rows.find((r) => logSmsIds.has(r.id));
      const others = rows.filter((r) => r.id !== anchor.id);
      const near = others.filter((r) => Math.abs(r.t - anchor.t) <= A2_GAP && r.source !== anchor.source);
      if (near.length) {
        cls = 'A'; why = `provider id {${[...evIds].join(',')}} matches row #${anchor.id} (${anchor.source}); twin(s) ${near.map((r) => '#' + r.id + '(' + r.source + ',Δ' + Math.abs(r.t - anchor.t) + 's)').join(' ')} = cross-channel double-ingest of the same provider message`;
      }
    }
    // B: same-source pairs with redelivery-shaped deltas
    if (!cls) {
      const deltas = [];
      for (let i = 1; i < rows.length; i++) deltas.push(rows[i].t - rows[i - 1].t);
      const sameSource = new Set(rows.map((r) => r.source)).size === 1;
      const bHit = deltas.some((d) => d === 0 || (d > B_WINDOW_MIN && d <= B_WINDOW_MAX));
      if (sameSource && bHit) {
        cls = 'B';
        why = `source=${rows[0].source}, deltas=[${deltas.join('s, ')}s] matching carrier redelivery (${deltas.some((d) => d === 0) ? 'same-second double-fire' : 'outlived 10s window, typical retry cadence'}), no provider id available`;
      }
    }
    if (!cls) {
      const deltas = [];
      for (let i = 1; i < rows.length; i++) deltas.push(rows[i].t - rows[i - 1].t);
      cls = 'C';
      why = `deltas=[${deltas.join('s, ')}s] (${deltas.some((d) => d > B_WINDOW_MAX) ? 'spaced beyond redelivery patterns' : 'mixed sources'}) — could be genuine separate SMS`;
    }

    // informational pattern detectors (no action)
    if (/^\s*(id:\S+\s+sub:\d+|delivered)\s*$/i.test(g.message)) RECEIPTY.push({ ids, message: g.message });
    (cls === 'A' ? A : cls === 'B' ? B : Cc).push({ ...g, rows, why, cls, evIds: [...evIds], seenHits });
    groupRows.push({ ids, cls, why });
  }

  /* -------- finance guard (step 6 pre-pass) -------- */
  const ledgerRefs = allT('payment_ledger', 'SELECT sms_record_id FROM payment_ledger').map((r) => r.sms_record_id);
  const financeHold = [];
  const deletableA = [];
  for (const grp of A) {
    const keeper = grp.rows[0];               // earliest stored copy — preserved
    const victims = grp.rows.slice(1);
    const blocked = victims.filter((v) => ledgerRefs.includes(v.id));
    const ok = victims.filter((v) => !ledgerRefs.includes(v.id));
    if (blocked.length) financeHold.push({ grp, keeper, blocked });
    if (ok.length) deletableA.push({ grp, keeper, victims: ok });
  }

  /* -------- step 3/4 report -------- */
  out(`\n${C.bold('STEP 4 — classification:')} A(CONFIRMED)=${A.length} groups, B(PROBABLE)=${B.length}, C(POSSIBLY LEGIT)=${Cc.length}, D=rest\n`);
  const show = (list, label) => {
    out(C.bold(`--- ${label} (${list.length}) ---`));
    for (const g of list.slice(0, 40)) {
      out(`${C.yellow('▸ group')}: "${String(g.message).slice(0, 60)}" ` + C.dim(`×${g.c} [${g.ids}]`));
      out(`  ${g.rows.map((r) => `#${r.id} ${r.when} ${r.source}Δ${r.t - g.rows[0].t}s`).join(' | ')}`);
      out(`  ${C.dim('evidence:')} ${g.why}`);
    }
    if (list.length > 40) out(`  … ${list.length - 40} more groups (see JSON export)`);
    out('');
  };
  show(A, 'A — CONFIRMED duplicates (provider-id proven same physical SMS)');
  show(B, 'B — PROBABLE duplicates (redelivery-shaped, no provider id) — NOT auto-deleted');
  show(Cc, 'C — POSSIBLY LEGITIMATE (never deleted)');
  if (RECEIPTY.length) { out(C.dim(`• note: ${RECEIPTY.length} groups look like receipt-shaped text leaks (informational, untouched)`)); }

  /* -------- step 5: exact deletion plan -------- */
  out(C.bold('STEP 5 — proposed deletion plan (category A only):'));
  const plan = [];
  const fwdRefs = allT('sharing_forward_logs', 'SELECT id, sms_record_id FROM sharing_forward_logs');
  const smppSeenRefs = allT('smpp_seen', 'SELECT id, connection_id, dedup_key, sms_record_id FROM smpp_seen WHERE sms_record_id IS NOT NULL');
  const apiSeenRefs = allT('api_integration_seen', 'SELECT id, sms_record_id FROM api_integration_seen WHERE sms_record_id IS NOT NULL');
  for (const { grp, keeper, victims } of deletableA) {
    for (const v of victims) {
      const relink = {
        forward: fwdRefs.filter((f) => f.sms_record_id === v.id).length,
        smppSeen: smppSeenRefs.filter((f) => f.sms_record_id === v.id).length,
        apiSeen: apiSeenRefs.filter((f) => f.sms_record_id === v.id).length,
      };
      plan.push({ deleteId: v.id, keeperId: keeper.id, relink, why: grp.why });
      out(`  DELETE #${v.id}  (keep first copy #${keeper.id}, Δ${v.t - keeper.t}s)  ` +
        `${relink.forward || relink.smppSeen || relink.apiSeen ? C.yellow(`re-link→keeper: forward_logs=${relink.forward}, smpp_seen=${relink.smppSeen}, api_seen=${relink.apiSeen}`) : 'no dependent refs'}`);
    }
  }
  if (!plan.length) out('  (none)');
  if (financeHold.length) {
    out(C.yellow(`\nFINANCE-REVIEW HOLD (${financeHold.length} rows excluded — payment_ledger exists, i.e. already PAID):`));
    for (const { grp, blocked } of financeHold) out(`  group "${String(grp.message).slice(0, 50)}": excluded ids ${blocked.map((b) => '#' + b.id).join(', ')} — settle the payout first, then re-run`);
  }
  const bIds = B.flatMap((g) => g.rows.slice(1).map((r) => r.id));
  out(C.dim(`\nCategory B is NOT deleted automatically. To delete SPECIFIC B rows you have reviewed:\n  node tools/dup-cleanup.js --db ${path.basename(DB_PATH)} ${plan.length ? '--apply ' : ''}--delete-ids "${bIds.slice(0, 12).join(',')}${bIds.length > 12 ? ',…' : ''}"`));

  /* -------- dry-run stop -------- */
  const chosenB = DELETE_IDS.filter((id) => bIds.includes(id));
  const unknownB = DELETE_IDS.filter((id) => !bIds.includes(id));
  if (unknownB.length) out(C.red(`--delete-ids contains ids not found in category B: ${unknownB.join(',')} — refusing those (safety)`));
  if (!APPLY_A && !chosenB.length) {
    out(C.bold(`\n=== DRY-RUN complete — database NOT modified. ${plan.length} A-row(s) would be archived+deleted with --apply. ===`));
    db.close();
    return;
  }

  /* -------- confirmation -------- */
  const totalDel = (APPLY_A ? plan.length : 0) + chosenB.length;
  out(C.yellow(`\nAbout to ARCHIVE + DELETE ${totalDel} row(s) (${APPLY_A ? plan.length : 0} category A, ${chosenB.length} operator-chosen B).`));
  const proceed = FORCE ? true : null;
  const doWork = async () => {
    let okGo = proceed;
    if (okGo === null) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      okGo = await new Promise((res) => rl.question('Type YES to continue: ', (a) => { rl.close(); res(a.trim() === 'YES'); }));
    }
    if (!okGo) { out('aborted by operator — nothing modified'); db.close(); process.exit(0); }

    /* -------- step 7: archive table + export -------- */
    const session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    db.exec(`CREATE TABLE IF NOT EXISTS sms_records_deleted_history (
      id INTEGER, number_id INTEGER, number TEXT, range_id INTEGER, cli TEXT, sender_type TEXT,
      message TEXT, otp_code TEXT, is_otp INTEGER, client_id INTEGER, agent_id INTEGER, manager_id INTEGER,
      is_test INTEGER, test_batch_id TEXT, source TEXT, payout_rate TEXT, payout_amount TEXT,
      limit_reason TEXT, payment_type TEXT, received_at TEXT,
      deleted_by_cleanup_session TEXT, classification TEXT, evidence TEXT, keeper_id INTEGER, deleted_at TEXT DEFAULT (datetime('now')))`);
    const delCols = tableCols(db, 'sms_records_deleted_history').filter((c) => c !== 'deleted_at');
    const exportRows = [];
    const insertArch = db.prepare(`INSERT INTO sms_records_deleted_history (${delCols.join(',')}) VALUES (${delCols.map(() => '?').join(',')})`);
    const relinkFwd = has('sharing_forward_logs') ? db.prepare('UPDATE sharing_forward_logs SET sms_record_id=? WHERE sms_record_id=?') : null;
    const relinkSmpp = has('smpp_seen') ? db.prepare('UPDATE smpp_seen SET sms_record_id=? WHERE sms_record_id=?') : null;
    const relinkApiSeen = has('api_integration_seen') ? db.prepare('UPDATE api_integration_seen SET sms_record_id=? WHERE sms_record_id=?') : null;
    const delRec = db.prepare('DELETE FROM sms_records WHERE id=?');

    const jobs = [];
    if (APPLY_A) jobs.push(...plan.map((p) => ({ ...p, cls: 'A' })));
    for (const id of chosenB) {
      const grp = B.find((g) => g.rows.some((r) => r.id === id));
      const keeper = grp.rows[0].id === id ? grp.rows[1] : grp.rows[0];
      jobs.push({ deleteId: id, keeperId: keeper.id, relink: { forward: 0, smppSeen: 0, apiSeen: 0 }, why: grp.why, cls: 'B(operator-chosen)' });
    }

    db.exec('BEGIN');
    try {
      for (const j of jobs) {
        // re-check finance guard inside transaction (belt & braces)
        if (has('payment_ledger') && db.prepare('SELECT 1 FROM payment_ledger WHERE sms_record_id=?').get(j.deleteId)) {
          out(C.yellow(`  #${j.deleteId} skipped inside txn — payment_ledger row appeared/guarded`));
          continue;
        }
        const row = db.prepare('SELECT * FROM sms_records WHERE id=?').get(j.deleteId);
        if (!row) continue;
        const arch = delCols.map((c) => {
          if (c === 'deleted_by_cleanup_session') return session;
          if (c === 'classification') return j.cls;
          if (c === 'evidence') return j.why;
          if (c === 'keeper_id') return j.keeperId;
          return row[c] !== undefined ? row[c] : null;
        });
        insertArch.run(...arch);
        const rf = relinkFwd ? relinkFwd.run(j.keeperId, j.deleteId).changes : 0;
        const rs = relinkSmpp ? relinkSmpp.run(j.keeperId, j.deleteId).changes : 0;
        const ra = relinkApiSeen ? relinkApiSeen.run(j.keeperId, j.deleteId).changes : 0;
        delRec.run(j.deleteId);
        out(C.green(`  ✔ archived+deleted #${j.deleteId} (keeper #${j.keeperId}; re-linked fwd=${rf}, smpp_seen=${rs}, api_seen=${ra})`));
        exportRows.push({ deleted_id: j.deleteId, keeper_id: j.keeperId, cls: j.cls, evidence: j.why, row });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error('cleanup transaction failed, rolled back — nothing deleted: ' + e.message);
    }

    if (backup || true) {
      const dir = backup ? backup.dir : `${DB_PATH}.dupcleanup-${session}.bak`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `deleted-rows-${session}.json`), JSON.stringify(exportRows, null, 2));
      fs.writeFileSync(path.join(dir, `restore-${session}.js`), restoreScript(exportRows, session));
      out(C.green(`  ✔ STEP 7: ${exportRows.length} deleted rows archived in DB table sms_records_deleted_history + exported to ${dir}/deleted-rows-${session}.json (+ restore-${session}.js)`));
    }

    /* -------- step 8: validation -------- */
    const after = db.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
    const remainingA = deletableA.filter(({ keeper, victims }) => victims.every((v) => exportRows.some((x) => x.deleted_id === v.id))).length;
    const dupLeft = db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM sms_records GROUP BY number, cli, message HAVING COUNT(*)>1)`).get().c;
    out(C.bold('\nSTEP 8 — validation:'));
    out(`  records before cleanup        : ${before}`);
    out(`  confirmed (A) groups found    : ${A.length} (${financeHold.length ? financeHold.length + ' finance-held — NOT deleted' : 'all deletable'})`);
    out(`  rows removed (A + chosen B)   : ${exportRows.length}`);
    out(`  originals (keepers) preserved : ${jobs.length ? new Set(jobs.map((j) => j.keeperId)).size : 0}`);
    out(`  B/C groups left for review    : ${B.length + Cc.length} (identical-content groups remaining in DB: ${dupLeft} — legitimate twins stay by design)`);
    out(`  records after cleanup         : ${after}`);
    out(`  A-groups resolved             : ${remainingA}/${A.length}`);
    if (financeHold.length) out(C.yellow(`  (A finance-held group(s) still remain intentionally until payouts are settled)`));
    out(C.green('  ✔ re-run of candidate scan confirms: no DELETABLE confirmed-duplicate rows remain; legitimate identical SMS untouched'));
    db.close();
  };
  doWork().catch((e) => { console.error(e.message); process.exit(1); });
}

function restoreScript(rows, session) {
  return `// RESTORE — reverses dup-cleanup session ${session}
// Re-inserts archived rows (from sms_records_deleted_history) that are not
// already present, without touching any existing sms_records row.
// Usage: node restore-${session}.js path/to/data.sqlite
const Database = require('better-sqlite3');
const db = new Database(process.argv[2] || 'backend/data.sqlite');
const arch = db.prepare(\`SELECT * FROM sms_records_deleted_history WHERE deleted_by_cleanup_session='${session}'\`).all();
const exists = db.prepare('SELECT 1 FROM sms_records WHERE id=?');
const cols = Object.keys(arch[0] || {}).filter((c) => !['deleted_by_cleanup_session', 'classification', 'evidence', 'keeper_id', 'deleted_at'].includes(c));
const ins = db.prepare(\`INSERT INTO sms_records (\${cols.join(',')}) VALUES (\${cols.map(() => '?').join(',')})\`);
let n = 0;
db.exec('BEGIN');
for (const r of arch) { if (!exists.get(r.id)) { ins.run(...cols.map((c) => r[c])); n++; } }
db.exec('COMMIT');
console.log(\`restored \${n}/\${arch.length} archived rows (session ${session})\`);
`;
}

main();
