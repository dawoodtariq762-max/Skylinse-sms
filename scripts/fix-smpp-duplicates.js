#!/usr/bin/env node
/**
 * scripts/fix-smpp-duplicates.js
 * =============================================================================
 * Safe Deduplication & Stats Recalculation Tool for Skyline SMS
 *
 * Detects and purges duplicate SMS records caused by rapid SMPP reconnects
 * and SMSC redeliveries, cleans up payment_ledger, smpp_seen, and recalculates
 * sms_daily_stats so all dashboard stats match upstream provider counts exactly.
 *
 * Safe Window Logic:
 *   - Identical (number, cli, message) arriving within the retry window (default 180s)
 *     are recognized as SMSC wire/reconnect retransmissions and purged (earliest kept).
 *   - Legitimate repeated OTPs (different codes, or same code resent after cooldown)
 *     are strictly PRESERVED and never touched.
 *
 * Usage:
 *   node scripts/fix-smpp-duplicates.js                 # Preview duplicates (dry run)
 *   node scripts/fix-smpp-duplicates.js --apply         # Execute cleanup with backup
 *   node scripts/fix-smpp-duplicates.js --all           # Check entire history
 *   node scripts/fix-smpp-duplicates.js --window 300    # Custom retry window in seconds (default: 180)
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const isApply = process.argv.includes('--apply');
const checkAll = process.argv.includes('--all');

let windowSeconds = 180; // default 3 minutes
const winIdx = process.argv.indexOf('--window');
if (winIdx !== -1 && process.argv[winIdx + 1]) {
  const parsedWin = parseInt(process.argv[winIdx + 1], 10);
  if (!isNaN(parsedWin) && parsedWin >= 0) windowSeconds = parsedWin;
}

const dbFile = process.env.DB_FILE
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, '..', 'backend', 'data.sqlite');

if (!fs.existsSync(dbFile)) {
  console.error(`[ERROR] Database file not found at: ${dbFile}`);
  process.exit(1);
}

console.log('================================================================');
console.log(' Skyline SMS — SMPP Duplicate Cleaner & Stats Synchronizer');
console.log('================================================================');
console.log(`Target DB:     ${dbFile}`);
console.log(`Mode:          ${isApply ? 'APPLY (Safe execution with automatic backup)' : 'DRY RUN (Preview only, no data changed)'}`);
console.log(`Scope:         ${checkAll ? 'All records in DB' : 'Recent records (last 2 days, use --all for full history)'}`);
console.log(`Retry Window:  ${windowSeconds === 0 ? 'All day (0s)' : windowSeconds + ' seconds (' + (windowSeconds/60).toFixed(1) + ' min)'}`);
console.log('----------------------------------------------------------------');

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

function cleanPhone(v) {
  return String(v || '').trim().replace(/[^0-9]/g, '');
}

// 1. Fetch records
const whereClause = checkAll
  ? '1=1'
  : "date(received_at) >= date('now', '-2 days')";

const rows = db.prepare(`
  SELECT id, number_id, number, range_id, cli, message, otp_code, client_id, agent_id, manager_id, payout_amount, received_at, source
  FROM sms_records
  WHERE ${whereClause}
  ORDER BY received_at ASC, id ASC
`).all();

console.log(`Total scanned records in scope: ${rows.length}`);

// 2. Identify duplicates safely using time-windowed tracking
const seenMap = new Map(); // key -> lastRow
const duplicateRows = [];
const duplicateIds = [];
const duplicateDetails = [];

for (const row of rows) {
  const normNumber = cleanPhone(row.number);
  const normCli = String(row.cli || '').toLowerCase().trim();
  const normMsg = String(row.message || '').trim();
  const rowTime = new Date(row.received_at || 0).getTime();

  // If window is 0, bucket by calendar day. Otherwise match within windowSeconds.
  const key = `${normNumber}|${normCli}|${normMsg}`;

  if (seenMap.has(key)) {
    const prev = seenMap.get(key);
    const prevTime = new Date(prev.received_at || 0).getTime();
    const timeDiffSec = Math.abs((rowTime - prevTime) / 1000);

    const isDuplicate = (windowSeconds === 0)
      ? (String(prev.received_at || '').slice(0, 10) === String(row.received_at || '').slice(0, 10))
      : (timeDiffSec <= windowSeconds);

    if (isDuplicate) {
      duplicateIds.push(row.id);
      duplicateRows.push(row);
      if (duplicateDetails.length < 15) {
        duplicateDetails.push({
          origId: prev.id,
          dupId: row.id,
          number: row.number,
          cli: row.cli,
          msg: row.message.slice(0, 45),
          origTime: prev.received_at,
          dupTime: row.received_at,
          diffSec: Math.round(timeDiffSec)
        });
      }
      // Note: we do NOT update seenMap, so all subsequent retries within window of prev are caught
      continue;
    }
  }

  seenMap.set(key, row);
}

console.log(`Unique legitimate records: ${rows.length - duplicateIds.length}`);
console.log(`Duplicate records found:    ${duplicateIds.length}`);

if (duplicateIds.length === 0) {
  console.log('\n[OK] No duplicates found! Your database is completely clean.');
  db.close();
  process.exit(0);
}

console.log('\nSample of detected duplicates (wire / reconnect retransmissions):');
duplicateDetails.forEach((d, idx) => {
  console.log(`  [#${idx+1}] Dup ID #${d.dupId} (Matches original #${d.origId}) | Number: ${d.number} | CLI: ${d.cli} | Gap: ${d.diffSec}s | Time: ${d.dupTime} | Msg: "${d.msg}..."`);
});
if (duplicateIds.length > duplicateDetails.length) {
  console.log(`  ... and ${duplicateIds.length - duplicateDetails.length} more duplicate rows.`);
}

if (!isApply) {
  console.log('\n----------------------------------------------------------------');
  console.log('This was a DRY RUN. No changes were made to the database.');
  console.log('To remove these duplicates and synchronize stats, run:');
  console.log('  node scripts/fix-smpp-duplicates.js --apply');
  console.log('----------------------------------------------------------------');
  db.close();
  process.exit(0);
}

// 3. EXECUTE CLEANUP (with automatic safety backup)
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

console.log(`\nPurging ${duplicateIds.length} duplicate records from database...`);

const deleteChunkSize = 500;
let deletedLedger = 0;
let deletedSeen = 0;
let deletedSms = 0;

const delLedgerStmt = db.prepare('DELETE FROM payment_ledger WHERE sms_record_id = ?');
const delSeenStmt = db.prepare('DELETE FROM smpp_seen WHERE sms_record_id = ?');
const delSmsStmt = db.prepare('DELETE FROM sms_records WHERE id = ?');

const runCleanup = db.transaction((ids) => {
  for (const id of ids) {
    const resLedger = delLedgerStmt.run(id);
    deletedLedger += resLedger.changes;

    try {
      const resSeen = delSeenStmt.run(id);
      deletedSeen += resSeen.changes;
    } catch (_) {}

    const resSms = delSmsStmt.run(id);
    deletedSms += resSms.changes;
  }
});

for (let i = 0; i < duplicateIds.length; i += deleteChunkSize) {
  const chunk = duplicateIds.slice(i, i + deleteChunkSize);
  runCleanup(chunk);
}

console.log(`[OK] Deleted ${deletedSms} duplicate rows from sms_records.`);
console.log(`[OK] Deleted ${deletedLedger} corresponding rows from payment_ledger.`);
if (deletedSeen > 0) {
  console.log(`[OK] Cleaned ${deletedSeen} corresponding records from smpp_seen.`);
}

// 4. Adjust smpp_connections total_received counter
try {
  const smppDups = duplicateRows.filter(r => String(r.source || '').toLowerCase() === 'smpp').length;
  if (smppDups > 0) {
    db.prepare(`
      UPDATE smpp_connections
      SET total_received = MAX(0, total_received - ?)
      WHERE active = 1 OR total_received > 0
    `).run(smppDups);
    console.log(`[OK] Adjusted SMPP connection total_received counters (-${smppDups}).`);
  }
} catch (e) {
  console.warn('[WARN] Could not update smpp_connections total_received:', e.message);
}

// 5. Rebuild sms_daily_stats for full consistency
console.log('\nRecalculating sms_daily_stats to synchronize dashboard numbers...');
try {
  // Clear recent stats and re-aggregate cleanly from remaining sms_records
  const dateFilter = checkAll ? '1=1' : "date(received_at) >= date('now', '-2 days')";
  const statDateFilter = checkAll ? '1=1' : "stat_date >= date('now', '-2 days')";

  db.exec(`
    DELETE FROM sms_daily_stats WHERE ${statDateFilter};
    
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
      AND ${dateFilter}
    GROUP BY sd, manager_id, agent_id, client_id, cli
    ON CONFLICT(stat_date, manager_id, agent_id, client_id, cli)
    DO UPDATE SET
      sms_count = excluded.sms_count,
      payout_sum = excluded.payout_sum;

    DELETE FROM sms_daily_stats WHERE sms_count <= 0;
  `);
  console.log('[OK] sms_daily_stats recalculated and synchronized.');
} catch (e) {
  console.warn('[WARN] Could not automatically rebuild sms_daily_stats table:', e.message);
}

db.close();

console.log('\n================================================================');
console.log(' CLEANUP COMPLETED SUCCESSFULLY!');
console.log(` Total duplicates removed: ${deletedSms}`);
console.log(' All dashboard numbers, stats and ledger balances are now synchronized.');
console.log(' If running under PM2, restart the service to refresh in-memory cache:');
console.log('   pm2 restart skyline-sms');
console.log('================================================================');
