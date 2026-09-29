#!/usr/bin/env node
'use strict';
/**
 * Rollback for the SMPP dedup-v2 change (schema side).
 *
 * SAFE BY DESIGN:
 *   - dry run by default; nothing is written without --apply
 *   - the SMS/dedup database is COPIED (consistent snapshot via VACUUM INTO)
 *     before any write
 *   - sms_records is never modified except for the identity bookkeeping values
 *     this change added (dedup_identity / identity_state), and only with
 *     --clear-identities. No SMS row is ever deleted. Timestamps untouched.
 *   - refuses to drop smpp_parts while it still holds unfinished parts unless
 *     --force is given (those parts would otherwise be lost — deliver them
 *     first, or accept the loss explicitly)
 *
 * Usage (run with the panel STOPPED):
 *   node backend/scripts/rollback-dedup-v2.js                 # dry run (default)
 *   node backend/scripts/rollback-dedup-v2.js --apply         # drop the two new tables
 *   node backend/scripts/rollback-dedup-v2.js --apply --clear-identities
 *   node backend/scripts/rollback-dedup-v2.js --apply --reset-meta --force
 *
 * Env: DATA_DIR (same as the panel) or --db <path>
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const APPLY = has('--apply') || has('--yes');
const CLEAR_IDENTITIES = has('--clear-identities');
const RESET_META = has('--reset-meta');
const FORCE = has('--force');

const dbPath = val('--db')
  || process.env.DB_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'data.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error('✖ database not found: ' + dbPath + '\n  pass --db <path> or set DATA_DIR');
  process.exit(2);
}

let Database;
try { Database = require('better-sqlite3'); }
catch (_) { Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3')); }

const db = new Database(dbPath);
const q = (sql, p = []) => { try { return db.prepare(sql).get(p); } catch (_) { return null; } };
const all = (sql, p = []) => { try { return db.prepare(sql).all(p); } catch (_) { return []; } };
const run = (sql, p = []) => db.prepare(sql).run(p);
const tableExists = (t) => !!q("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
const indexExists = (t) => !!q("SELECT name FROM sqlite_master WHERE type='index' AND name=?", [t]);
const meta = (k) => { try { const r = q('SELECT value FROM meta WHERE key=?', [k]); return r ? r.value : null; } catch (_) { return null; } };

function inventory() {
  return {
    db: dbPath,
    sms_records: (q('SELECT COUNT(*) c FROM sms_records') || {}).c || 0,
    dedup_identity_column_present: (() => { try { return (q("SELECT COUNT(*) c FROM pragma_table_info('sms_records') WHERE name='dedup_identity'") || {}).c || 0; } catch (_) { return 0; } })(),
    sms_with_dedup_identity: (() => { try { return (q("SELECT COUNT(*) c FROM sms_records WHERE COALESCE(dedup_identity,'')<>''") || {}).c || 0; } catch (_) { return 0; } })(),
    sms_marked: (() => { try { return (q("SELECT COUNT(*) c FROM sms_records WHERE COALESCE(identity_state,'')<>''") || {}).c || 0; } catch (_) { return 0; } })(),
    ledger_table: tableExists('sms_dedup_ledger'),
    ledger_rows: tableExists('sms_dedup_ledger') ? ((q('SELECT COUNT(*) c FROM sms_dedup_ledger') || {}).c || 0) : 0,
    parts_table: tableExists('smpp_parts'),
    parts_rows: tableExists('smpp_parts') ? ((q('SELECT COUNT(*) c FROM smpp_parts') || {}).c || 0) : 0,
    partial_index: indexExists('idx_sms_records_dedup_strong'),
    state_index: indexExists('idx_sms_records_identity_state'),
    connection_uid_column_present: (() => { try { return (q("SELECT COUNT(*) c FROM pragma_table_info('smpp_connections') WHERE name='connection_uid'") || {}).c || 0; } catch (_) { return 0; } })(),
    meta_migrated: meta('dedup_v2_migrated'),
    meta_identity_state: meta('dedup_v2_identity_state'),
  };
}

console.log('SMPP dedup-v2 rollback — ' + (APPLY ? 'APPLY' : 'DRY RUN') + (APPLY && !has('--yes') ? '' : ''));
console.log('mode: ' + (APPLY ? 'writes will happen' : 'nothing will be written (add --apply)'));
console.log(JSON.stringify(inventory(), null, 2));

const inv = inventory();
const pending = inv.parts_rows;
if (pending && APPLY && !FORCE) {
  console.error(`\n✖ smpp_parts still holds ${pending} unfinished part(s).`);
  for (const p of all('SELECT connection_uid, group_key, seq, total, received_at FROM smpp_parts ORDER BY received_at')) {
    console.error('   - ' + p.connection_uid + '  ' + p.group_key + '  part ' + p.seq + '/' + p.total + '  ' + p.received_at);
  }
  console.error('   Those parts are not stored anywhere else yet. Either let the panel finish');
  console.error('   them (or wait for the staleness sweep) and re-run, or pass --force to drop them.');
  process.exit(3);
}

if (!APPLY) {
  console.log('\n-- dry run: nothing written. The --apply run would:');
  console.log('   1. snapshot the database (VACUUM INTO) before touching anything');
  if (inv.parts_table) console.log('   2. DROP TABLE smpp_parts' + (pending ? '   (holds ' + pending + ' part(s) — --force required)' : ''));
  if (inv.ledger_table) console.log('   3. DROP TABLE sms_dedup_ledger   (' + inv.ledger_rows + ' identity rows)');
  if (CLEAR_IDENTITIES) console.log('   4. clear sms_records.dedup_identity / identity_state values (' + inv.sms_with_dedup_identity + ' / ' + inv.sms_marked + ' rows) — content untouched');
  else console.log('   4. (skip) identity values kept — the pre-fix code ignores them; add --clear-identities to blank them');
  if (RESET_META) console.log('   5. clear meta keys dedup_v2_migrated / dedup_v2_identity_state (a future deploy re-runs the migration)');
  if (inv.partial_index) console.log('   note: index idx_sms_records_dedup_strong is left in place — harmless for the old code');
  console.log('\n   sms_records rows are NEVER deleted or edited beyond the two added columns.');
  process.exit(0);
}

/* ---------------- apply ---------------- */
const snap = dbPath + '.pre-rollback-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
try {
  db.prepare('VACUUM INTO ?').run(snap);
  console.log('\n✔ snapshot written: ' + path.basename(snap));
} catch (e) {
  console.error('✖ could not create a snapshot (' + e.message + ') — refusing to continue');
  process.exit(4);
}

const done = [];
try {
  if (tableExists('smpp_parts')) { run('DROP TABLE smpp_parts'); done.push('dropped smpp_parts'); }
  if (tableExists('sms_dedup_ledger')) { run('DROP TABLE sms_dedup_ledger'); done.push('dropped sms_dedup_ledger'); }
  if (CLEAR_IDENTITIES) {
    let a = 0, b = 0;
    try { a = run("UPDATE sms_records SET dedup_identity='' WHERE COALESCE(dedup_identity,'')<>''").changes; } catch (_) {}
    try { b = run("UPDATE sms_records SET identity_state='' WHERE COALESCE(identity_state,'')<>''").changes; } catch (_) {}
    done.push('cleared identity values (' + a + ' dedup_identity, ' + b + ' identity_state)');
  }
  if (RESET_META) {
    try { run("DELETE FROM meta WHERE key IN ('dedup_v2_migrated','dedup_v2_identity_state')"); done.push('reset migration meta keys'); } catch (_) {}
  }
} catch (e) {
  console.error('✖ rollback failed halfway: ' + e.message);
  console.error('  snapshot is available at ' + snap);
  process.exit(5);
}

console.log('apply: ' + (done.join('; ') || 'nothing to do'));
console.log('after: ' + JSON.stringify(inventory(), null, 2));
console.log('\nNow redeploy the previous code (server.js / smppService.js / schema.js / providerSync.js)');
console.log('and start the panel. The snapshot above is your restore point.');
db.close();
