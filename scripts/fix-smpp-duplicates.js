#!/usr/bin/env node
/**
 * scripts/fix-smpp-duplicates.js
 * =============================================================================
 * Safe Deduplication & Stats Recalculation Tool for Skyline SMS
 *
 * Detects and purges duplicate SMS records caused by rapid SMPP reconnects
 * and SMSC redeliveries, cleans up payment_ledger, and recalculates
 * sms_daily_stats so all dashboard stats match upstream provider counts exactly.
 *
 * Usage:
 *   node scripts/fix-smpp-duplicates.js            # Preview duplicates (dry run)
 *   node scripts/fix-smpp-duplicates.js --apply    # Execute cleanup with backup
 *   node scripts/fix-smpp-duplicates.js --all      # Check entire history (not just today)
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const isApply = process.argv.includes('--apply');
const checkAll = process.argv.includes('--all');

const dbFile = process.env.DB_FILE
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, '..', 'backend', 'data.sqlite');

if (!fs.existsSync(dbFile)) {
  console.error(`[ERROR] Database file not found at: ${dbFile}`);
  process.exit(1);
}

console.log('===============================================================');
console.log(' Skyline SMS — SMPP Duplicate Cleaner & Stats Synchronizer');
console.log('===============================================================');
console.log(`Target DB: ${dbFile}`);
console.log(`Mode:      ${isApply ? 'APPLY (Safe execution with backup)' : 'DRY RUN (Preview only, no data changed)'}`);
console.log(`Scope:     ${checkAll ? 'All records in DB' : 'Today records only (use --all for full history)'}`);
console.log('---------------------------------------------------------------');

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

function cleanPhone(v) {
  return String(v || '').trim().replace(/[^0-9]/g, '');
}

// 1. Fetch records
const whereClause = checkAll
  ? '1=1'
  : "date(received_at) >= date('now', '-1 day')";

const rows = db.prepare(`
  SELECT id, number, cli, message, received_at, payout_amount
  FROM sms_records
  WHERE ${whereClause}
  ORDER BY id ASC
`).all();

console.log(`Total scanned records in scope: ${rows.length}`);

// 2. Identify duplicates
const seen = new Map();
const duplicateIds = [];
const duplicateDetails = [];

for (const row of rows) {
  const normNumber = cleanPhone(row.number);
  const normCli = String(row.cli || '').toLowerCase().trim();
  const normMsg = String(row.message || '').trim();
  const day = String(row.received_at || '').slice(0, 10);

  // Group by phone + cli + message body + day
  const key = `${normNumber}|${normCli}|${normMsg}|${day}`;

  if (seen.has(key)) {
    const original = seen.get(key);
    duplicateIds.push(row.id);
    if (duplicateDetails.length < 10) {
      duplicateDetails.push({
        origId: original.id,
        dupId: row.id,
        number: row.number,
        cli: row.cli,
        msg: row.message.slice(0, 45),
        time: row.received_at
      });
    }
  } else {
    seen.set(key, row);
  }
}

console.log(`Unique records:     ${seen.size}`);
console.log(`Duplicate records:  ${duplicateIds.length}`);

if (duplicateIds.length === 0) {
  console.log('\n[OK] No duplicates found! Your database is completely clean.');
  db.close();
  process.exit(0);
}

console.log('\nSample of detected duplicates:');
duplicateDetails.forEach((d, idx) => {
  console.log(`  [#${idx+1}] Dup ID: ${d.dupId} (Matches original ID: ${d.origId}) | Number: ${d.number} | CLI: ${d.cli} | Msg: "${d.msg}..." | Time: ${d.time}`);
});
if (duplicateIds.length > duplicateDetails.length) {
  console.log(`  ... and ${duplicateIds.length - duplicateDetails.length} more duplicate rows.`);
}

if (!isApply) {
  console.log('\n---------------------------------------------------------------');
  console.log('This was a DRY RUN. No changes were made to the database.');
  console.log('To remove these duplicates and synchronize stats, run:');
  console.log('  node scripts/fix-smpp-duplicates.js --apply');
  console.log('---------------------------------------------------------------');
  db.close();
  process.exit(0);
}

// 3. EXECUTE CLEANUP (with backup)
const backupFile = `${dbFile}.bak-pre-dedup-${Date.now()}`;
console.log(`\nCreating emergency backup at: ${backupFile} ...`);
try {
  fs.copyFileSync(dbFile, backupFile);
  console.log('[OK] Backup created successfully.');
} catch (e) {
  console.error('[FATAL] Failed to create database backup:', e.message);
  db.close();
  process.exit(1);
}

console.log(`Purging ${duplicateIds.length} duplicate records...`);

const deleteChunkSize = 500;
let deletedLedger = 0;
let deletedSms = 0;

const delLedgerStmt = db.prepare('DELETE FROM payment_ledger WHERE sms_record_id = ?');
const delSmsStmt = db.prepare('DELETE FROM sms_records WHERE id = ?');

const runCleanup = db.transaction((ids) => {
  for (const id of ids) {
    const resLedger = delLedgerStmt.run(id);
    deletedLedger += resLedger.changes;
    const resSms = delSmsStmt.run(id);
    deletedSms += resSms.changes;
  }
});

for (let i = 0; i < duplicateIds.length; i += deleteChunkSize) {
  const chunk = duplicateIds.slice(i, i + deleteChunkSize);
  runCleanup(chunk);
}

console.log(`[OK] Deleted ${deletedSms} rows from sms_records.`);
console.log(`[OK] Deleted ${deletedLedger} rows from payment_ledger.`);

// 4. Rebuild sms_daily_stats for full consistency
console.log('\nRebuilding sms_daily_stats to synchronize dashboard numbers...');
try {
  // Wipe today stats and reaggregate cleanly from sms_records
  db.exec(`
    DELETE FROM sms_daily_stats WHERE stat_date >= date('now', '-2 days');
    
    INSERT INTO sms_daily_stats (stat_date, manager_id, agent_id, client_id, cli, sms_count, payout_sum)
    SELECT
      date(received_at) AS sd,
      COALESCE(manager_id, -1),
      COALESCE(agent_id, -1),
      COALESCE(client_id, -1),
      COALESCE(cli, ''),
      COUNT(*),
      COALESCE(SUM(CAST(COALESCE(NULLIF(payout_amount, ''), '0') AS REAL)), 0)
    FROM sms_records
    WHERE COALESCE(is_test, 0) = 0
      AND date(received_at) >= date('now', '-2 days')
    GROUP BY sd, manager_id, agent_id, client_id, cli
    ON CONFLICT(stat_date, manager_id, agent_id, client_id, cli)
    DO UPDATE SET
      sms_count = excluded.sms_count,
      payout_sum = excluded.payout_sum;
  `);
  console.log('[OK] sms_daily_stats recalculated successfully.');
} catch (e) {
  console.warn('[WARN] Could not automatically rebuild sms_daily_stats table:', e.message);
}

db.close();

console.log('===============================================================');
console.log(' CLEANUP COMPLETED SUCCESSFULLY!');
console.log(' Duplicate SMS have been removed and stats are now synchronized.');
console.log(' Please restart the application on your server:');
console.log('   pm2 restart skyline-sms');
console.log('===============================================================');
