#!/usr/bin/env node
'use strict';
/**
 * Rollback / audit tool for the SMPP dedup-v2 schema additions
 * ===========================================================================
 * The migration (`migrateDedupV2()` in backend/schema.js) is purely ADDITIVE:
 * it creates two new tables, adds nullable/defaulted columns and one partial
 * index. It never edits, rewrites or deletes an existing SMS row.
 *
 * This script is the reverse switch. It is deliberately conservative:
 *
 *   node backend/scripts/rollback-dedup-v2.js                    # dry run (default)
 *   node backend/scripts/rollback-dedup-v2.js --yes --clear-columns
 *   node backend/scripts/rollback-dedup-v2.js --yes --drop-tables
 *   node backend/scripts/rollback-dedup-v2.js --yes --restore-backup
 *   node backend/scripts/rollback-dedup-v2.js --yes --full
 *
 *   --clear-columns   empty sms_records.dedup_identity, failed_sms_queue
 *                     .dedup_identity/.sms_record_id and
 *                     smpp_connections.connection_uid, and drop the partial
 *                     UNIQUE index. All rows are kept. This is the safe way
 *                     back to the pre-fix behaviour: the code that is not
 *                     aware of these columns simply ignores them.
 *   --drop-tables     additionally DROP sms_dedup_ledger and smpp_parts.
 *                     That deletes the replay history only — never SMS records.
 *   --restore-backup  replace the live database with the pre-migration backup
 *                     file recorded by the migration. The panel MUST be stopped.
 *   --full            clear-columns + drop-tables (keeps the SMS history).
 *
 * Safety: without --yes nothing is written; the dry run prints exactly what
 * would change, with row counts, and where the backup file is.
 */
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--yes');
const DO_COLS = has('--clear-columns') || has('--full');
const DO_TABLES = has('--drop-tables') || has('--full');
const DO_RESTORE = has('--restore-backup');

const db = require('../db');

function info(label, value) { console.log(`  ${label.padEnd(34)} ${value}`); }

(async () => {
  await db.init();
  const file = (typeof db.getDbFile === 'function' && db.getDbFile()) || '(unknown)';
  console.log('SMPP dedup-v2 rollback');
  console.log('database: ' + file);
  console.log('mode    : ' + (APPLY ? 'APPLY' : 'DRY RUN (add --yes to change anything)') + '\n');

  const tableExists = (t) => !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
  const columnExists = (t, c) => {
    try { return db.all(`PRAGMA table_info(${t})`).some((x) => x.name === c); } catch (_) { return false; }
  };
  const count = (sql) => { try { return (db.get(sql) || {}).c || 0; } catch (_) { return -1; }; };

  /* ---------------- 1. inventory ---------------- */
  console.log('1) What the migration added');
  info('sms_dedup_ledger table', tableExists('sms_dedup_ledger') ? 'present (' + count('SELECT COUNT(*) c FROM sms_dedup_ledger') + ' identities)' : 'absent');
  info('smpp_parts table', tableExists('smpp_parts') ? 'present (' + count('SELECT COUNT(*) c FROM smpp_parts') + ' pending parts)' : 'absent');
  info('sms_records.dedup_identity', columnExists('sms_records', 'dedup_identity') ? 'present (' + count("SELECT COUNT(*) c FROM sms_records WHERE COALESCE(dedup_identity,'')<>''") + ' rows filled, all SMS rows kept)' : 'absent');
  info('failed_sms_queue.dedup_identity', columnExists('failed_sms_queue', 'dedup_identity') ? 'present' : 'absent');
  info('failed_sms_queue.sms_record_id', columnExists('failed_sms_queue', 'sms_record_id') ? 'present' : 'absent');
  info('smpp_connections.connection_uid', columnExists('smpp_connections', 'connection_uid') ? 'present (' + count("SELECT COUNT(*) c FROM smpp_connections WHERE COALESCE(connection_uid,'')<>''") + ' accounts identified)' : 'absent');
  info('meta.dedup_v2_migrated', (() => { try { const r = db.get("SELECT value FROM meta WHERE key='dedup_v2_migrated'"); return r ? r.value : '(unset)'; } catch (_) { return '(no meta table)'; } })());
  let backup = '';
  try { const r = db.get("SELECT value FROM meta WHERE key='dedup_v2_backup'"); backup = r ? r.value : ''; } catch (_) {}
  info('pre-migration backup', backup ? backup + (fs.existsSync(backup) ? ' (exists)' : ' (MISSING)') : '(none recorded)');
  info('sms_records rows (never touched)', count('SELECT COUNT(*) c FROM sms_records'));

  if (!APPLY) {
    console.log('\nNothing was changed. Re-run with --yes and one of:');
    console.log('  --clear-columns    back to pre-fix behaviour, SMS history untouched');
    console.log('  --drop-tables      also drop the replay ledger + pending parts');
    console.log('  --restore-backup   put the pre-migration backup file back (stop the panel first)');
    console.log('  --full             clear-columns + drop-tables');
    console.log('\nThe old code (pre-fix) ignores the added columns/tables completely, so');
    console.log('restoring the previous backend build does not require this script at all.');
    process.exit(0);
  }

  /* ---------------- 2. restore the backup file ---------------- */
  if (DO_RESTORE) {
    if (!backup || !fs.existsSync(backup)) {
      console.error('No usable pre-migration backup was recorded; refusing to guess.');
      process.exit(2);
    }
    const park = file + '.rolled-back-' + new Date().toISOString().replace(/[:.]/g, '-');
    console.log('\n2) Restoring the pre-migration backup');
    console.log('   current database -> ' + park);
    console.log('   ' + backup + ' -> ' + file);
    console.log('   STOP THE PANEL (pm2 stop …) BEFORE CONTINUING.');
    if (!fs.existsSync(park)) fs.copyFileSync(file, park);
    fs.copyFileSync(backup, file);
    console.log('   done. Start the panel again (pm2 start …).');
    process.exit(0);
  }

  /* ---------------- 3. clear the dedup columns/index ---------------- */
  if (DO_COLS) {
    console.log('\n3) Clearing the dedup columns (rows are kept)');
    const before = count('SELECT COUNT(*) c FROM sms_records');
    if (columnExists('smpp_connections', 'connection_uid')) {
      db.run("UPDATE smpp_connections SET connection_uid=''");
      console.log('   smpp_connections.connection_uid emptied');
    }
    if (columnExists('failed_sms_queue', 'dedup_identity')) {
      db.run("UPDATE failed_sms_queue SET dedup_identity=''");
      console.log('   failed_sms_queue.dedup_identity emptied (queued SMS are kept)');
    }
    if (columnExists('failed_sms_queue', 'sms_record_id')) {
      db.run('UPDATE failed_sms_queue SET sms_record_id=NULL');
      console.log('   failed_sms_queue.sms_record_id cleared');
    }
    if (columnExists('sms_records', 'dedup_identity')) {
      db.run("UPDATE sms_records SET dedup_identity=''");
      console.log('   sms_records.dedup_identity emptied (all ' + before + ' SMS rows kept)');
    }
    try { db.run('DROP INDEX IF EXISTS idx_sms_records_dedup_strong'); console.log('   partial UNIQUE index idx_sms_records_dedup_strong dropped'); } catch (e) { console.log('   index drop skipped: ' + e.message); }
    try { db.run("DELETE FROM meta WHERE key IN ('dedup_v2_migrated','dedup_v2_backup')"); console.log('   migration marker cleared (a future start will re-run the migration)'); } catch (_) {}
    const after = count('SELECT COUNT(*) c FROM sms_records');
    console.log('   sms_records rows before/after: ' + before + ' / ' + after);
  }

  /* ---------------- 4. drop the new tables ---------------- */
  if (DO_TABLES) {
    console.log('\n4) Dropping the replay ledger and pending parts');
    const led = count('SELECT COUNT(*) c FROM sms_dedup_ledger');
    const parts = count('SELECT COUNT(*) c FROM smpp_parts');
    db.run('DROP INDEX IF EXISTS idx_sms_dedup_unique');
    db.run('DROP INDEX IF EXISTS idx_sms_dedup_sms');
    db.run('DROP INDEX IF EXISTS idx_smpp_parts_age');
    db.run('DROP TABLE IF EXISTS sms_dedup_ledger');
    db.run('DROP TABLE IF EXISTS smpp_parts');
    console.log('   dropped sms_dedup_ledger (' + led + ' identities) and smpp_parts (' + parts + ' pending parts)');
    console.log('   note: replay protection for ALREADY-SEEN messages is gone with them.');
  }

  console.log('\nDone. sms_records was not modified' + (DO_COLS ? ' beyond emptying the added column' : '') + '.');
  process.exit(0);
})().catch((e) => {
  console.error('rollback failed: ' + (e && e.stack || e));
  process.exit(1);
});
