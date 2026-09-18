#!/usr/bin/env node
/**
 * scripts/retry-failed-sms.js
 * =============================================================================
 * Batch Recovery Tool for Failed / Unallocated SMS in Skyline SMS
 *
 * When SMS arrive from upstream (SMPP / HTTP) for numbers that were not yet
 * uploaded into the system, they are preserved safely in `failed_sms_queue`.
 *
 * After uploading those numbers, run this tool to:
 * 1. Find all pending failed SMS whose destination numbers now exist in the system.
 * 2. Ingest them into `sms_records` with their original timestamps.
 * 3. Add legitimate records to `payment_ledger`.
 * 4. Mark queue status as 'Retried'.
 * 5. Rebuild `sms_daily_stats` so the panel count immediately matches upstream!
 * 6. Report any remaining numbers that are STILL not uploaded.
 *
 * Usage:
 *   node scripts/retry-failed-sms.js            # Preview recoverable SMS (dry run)
 *   node scripts/retry-failed-sms.js --apply    # Execute recovery & update dashboard
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const isApply = process.argv.includes('--apply');

const dbFile = process.env.DB_FILE
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, '..', 'backend', 'data.sqlite');

if (!fs.existsSync(dbFile)) {
  console.error(`[ERROR] Database file not found at: ${dbFile}`);
  process.exit(1);
}

console.log('===============================================================');
console.log(' Skyline SMS — Failed / Unallocated SMS Recovery Tool');
console.log('===============================================================');
console.log(`Target DB: ${dbFile}`);
console.log(`Mode:      ${isApply ? 'APPLY (Executing recovery & updating stats)' : 'DRY RUN (Preview only, no data changed)'}`);
console.log('---------------------------------------------------------------');

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

function cleanPhone(v) {
  return String(v || '').trim().replace(/[^0-9]/g, '');
}

function classifySender(cli) {
  const s = String(cli || '').trim();
  if (!s) return 'unknown';
  const digits = s.replace(/[^0-9]/g, '');
  if (/^[A-Za-z][A-Za-z0-9 _.-]{1,20}$/.test(s) && /[A-Za-z]/.test(s)) return 'alphanumeric_sender';
  if (/^\+?\d{10,15}$/.test(s)) return 'phone_number';
  if (/^\d{3,8}$/.test(digits) && digits.length === s.replace(/^\+/, '').length) return 'shortcode';
  return 'unknown';
}

function extractOtpCode(message) {
  const text = String(message || '');
  const digit = text.match(/\b\d{4,8}\b/);
  if (digit) return digit[0];
  const alphaNum = text.match(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,12}\b/);
  return alphaNum ? alphaNum[0] : '';
}

function normalizePaymentCycle(cycle) {
  const c = String(cycle || '').toLowerCase().trim();
  if (c === 'daily' || c === '1/1' || c === '1_1' || c === 'daily_1_1') return 'daily';
  if (c === 'weekly_7_7' || c === '7/7' || c === '7_7') return 'weekly_7_7';
  if (c === 'monthly_30x45' || c === '30/45' || c === '30_45' || c === 'monthly') return 'monthly_30x45';
  return 'weekly_7_1';
}

function normalizePaymentType(cycle) {
  const c = normalizePaymentCycle(cycle);
  if (c === 'daily') return 'daily';
  if (c === 'weekly_7_7' || c === 'weekly_7_1') return 'weekly';
  if (c === 'monthly_30x45') return 'monthly_30x45';
  return 'weekly';
}

function payoutRateForPaymentCycle(row, cycle) {
  const c = normalizePaymentCycle(cycle);
  const ov = row.number_rate;
  const candidates = c === 'daily'
    ? [ov, row.rate_1_1, row.rate_7_1, row.rate_30_45]
    : (c === 'weekly_7_7'
      ? [ov, row.rate_7_7, row.rate_7_1, row.rate_30_45, row.rate_1_1]
      : (c === 'monthly_30x45'
        ? [ov, row.rate_30_45, row.rate_7_1, row.rate_1_1]
        : [ov, row.rate_7_1, row.rate_7_7, row.rate_30_45, row.rate_1_1]));

  for (const v of candidates) {
    const s = String(v || '').trim();
    if (s && !isNaN(Number(s)) && Number(s) > 0) return s;
  }
  return '0';
}

// 1. Fetch pending failed SMS
const pendingList = db.prepare(`
  SELECT id, number, cli, message, raw_payload, error, created_at
  FROM failed_sms_queue
  WHERE status = 'Pending'
  ORDER BY id ASC
`).all();

console.log(`Found ${pendingList.length} pending failed SMS in queue.\n`);

if (pendingList.length === 0) {
  console.log('[OK] No pending failed SMS found in queue.');
  db.close();
  process.exit(0);
}

// Cache numbers and ranges for fast matching
const allNumbers = db.prepare(`SELECT * FROM numbers`).all();
const numberMap = new Map();
for (const n of allNumbers) {
  const c = cleanPhone(n.number);
  if (c) numberMap.set(c, n);
  numberMap.set(String(n.number).trim(), n);
}

// Cache test numbers
const testNumMap = new Map();
try {
  const allTests = db.prepare(`
    SELECT t.*, t.test_number AS number, r.name AS range_name
    FROM range_test_numbers t
    LEFT JOIN ranges r ON r.id = t.range_id
    WHERE t.active = 1
  `).all();
  for (const t of allTests) {
    const c = cleanPhone(t.test_number);
    if (c) testNumMap.set(c, t);
    testNumMap.set(String(t.test_number).trim(), t);
  }
} catch (_) {}

const rangeMap = new Map();
try {
  const allRanges = db.prepare(`SELECT * FROM ranges`).all();
  for (const r of allRanges) rangeMap.set(r.id, r);
} catch (_) {}

const recoverable = [];
const unallocatedMap = new Map();

for (const f of pendingList) {
  const cDst = cleanPhone(f.number);
  const matched = numberMap.get(cDst) || numberMap.get(String(f.number).trim());
  const matchedTest = !matched ? (testNumMap.get(cDst) || testNumMap.get(String(f.number).trim())) : null;

  if (matched) {
    recoverable.push({ f, number: matched, isTest: 0 });
  } else if (matchedTest) {
    recoverable.push({
      f,
      number: {
        id: null,
        number: matchedTest.test_number,
        range_id: matchedTest.range_id,
        rate: '',
        payout: '0',
        manager_id: null,
        agent_id: null,
        client_id: null
      },
      isTest: 1
    });
  } else {
    const rawNum = String(f.number || 'unknown').trim();
    unallocatedMap.set(rawNum, (unallocatedMap.get(rawNum) || 0) + 1);
  }
}

console.log(`Recoverable SMS (numbers now in system): ${recoverable.length}`);
console.log(`Still unallocated SMS (numbers NOT yet uploaded): ${pendingList.length - recoverable.length}\n`);

if (recoverable.length > 0) {
  console.log('Sample of recoverable SMS ready to be imported:');
  recoverable.slice(0, 10).forEach((item, idx) => {
    console.log(`  [#${idx+1}] Queue ID: ${item.f.id} | Number: ${item.f.number} | CLI: ${item.f.cli} | Msg: "${String(item.f.message||'').slice(0, 40)}..." | Arrived: ${item.f.created_at}`);
  });
  if (recoverable.length > 10) {
    console.log(`  ... and ${recoverable.length - 10} more SMS ready for ingestion.`);
  }
}

if (unallocatedMap.size > 0) {
  console.log('\n---------------------------------------------------------------');
  console.log('⚠️  The following numbers received SMS but are STILL NOT uploaded:');
  console.log('---------------------------------------------------------------');
  for (const [num, count] of unallocatedMap.entries()) {
    console.log(`  • Number: ${num.padEnd(20)} -> ${count} SMS waiting`);
  }
  console.log('Tip: If any of these are yours, upload them to their range in the panel');
  console.log('     and re-run this script to import their messages too!');
  console.log('---------------------------------------------------------------');
}

if (!isApply) {
  console.log('\nThis was a DRY RUN. No changes were made.');
  console.log('To import all recoverable SMS into your panel right now, run:');
  console.log('  node scripts/retry-failed-sms.js --apply');
  console.log('---------------------------------------------------------------');
  db.close();
  process.exit(0);
}

// EXECUTE RECOVERY
console.log(`\nStarting ingestion of ${recoverable.length} recovered SMS...`);

const insertSmsStmt = db.prepare(`
  INSERT INTO sms_records (
    number_id, number, range_id, cli, sender_type, message, otp_code,
    client_id, agent_id, manager_id, is_test, test_batch_id, source,
    payout_rate, payout_amount, payment_type, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertLedgerStmt = db.prepare(`
  INSERT OR IGNORE INTO payment_ledger (
    sms_record_id, agent_id, manager_id, range_id,
    payment_type, amount, earned_at, cycle_key, eligible_at, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
`);

const updateQueueStmt = db.prepare(`
  UPDATE failed_sms_queue
  SET status = 'Retried', retry_count = retry_count + 1, updated_at = datetime('now')
  WHERE id = ?
`);

const checkDupStmt = db.prepare(`
  SELECT id FROM sms_records
  WHERE number = ? AND cli = ? AND message = ? AND received_at = ?
  LIMIT 1
`);

let insertedCount = 0;
let skippedDupCount = 0;

const runRecovery = db.transaction(() => {
  for (const item of recoverable) {
    const { f, number: n, isTest } = item;
    const receivedAt = f.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Dedup check against sms_records
    const existing = checkDupStmt.get(n.number, f.cli || '', f.message || '', receivedAt);
    if (existing) {
      updateQueueStmt.run(f.id);
      skippedDupCount++;
      continue;
    }

    const rangeRow = (n.range_id ? rangeMap.get(n.range_id) : {}) || {};
    const cycle = normalizePaymentCycle(n.payterm || rangeRow.payment_type || 'weekly_7_1');
    const paymentType = normalizePaymentType(cycle);
    const rate = isTest ? '0' : payoutRateForPaymentCycle({ ...rangeRow, number_rate: n.rate, number_payout: n.payout }, cycle);
    const senderType = classifySender(f.cli || '');
    const otpCode = extractOtpCode(f.message || '');

    const res = insertSmsStmt.run(
      n.id,
      n.number,
      n.range_id,
      f.cli || '',
      senderType,
      f.message || '',
      otpCode,
      n.client_id,
      n.agent_id,
      n.manager_id,
      isTest,
      isTest ? 'RETRY_TEST' : '',
      'failed_sms_retry',
      rate,
      rate,
      paymentType,
      receivedAt
    );

    const smsRecordId = res.lastInsertRowid;

    if (!isTest && smsRecordId && n.agent_id && Number(rate) > 0) {
      try {
        const cycKey = `${receivedAt.slice(0, 10)}:${paymentType}`;
        insertLedgerStmt.run(
          smsRecordId,
          n.agent_id,
          n.manager_id,
          n.range_id,
          paymentType,
          rate,
          receivedAt,
          cycKey,
          receivedAt
        );
      } catch (e) {
        // ignore ledger duplicate/failure
      }
    }

    updateQueueStmt.run(f.id);
    insertedCount++;
  }
});

runRecovery();

console.log(`[OK] Ingested ${insertedCount} SMS successfully into sms_records!`);
if (skippedDupCount > 0) {
  console.log(`[OK] Skipped ${skippedDupCount} SMS (already existed in sms_records).`);
}

// Rebuild sms_daily_stats
console.log('\nRecalculating sms_daily_stats...');
try {
  db.exec(`
    DELETE FROM sms_daily_stats WHERE stat_date >= date('now', '-3 days');
    
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
      AND date(received_at) >= date('now', '-3 days')
    GROUP BY sd, manager_id, agent_id, client_id, cli
    ON CONFLICT(stat_date, manager_id, agent_id, client_id, cli)
    DO UPDATE SET
      sms_count = excluded.sms_count,
      payout_sum = excluded.payout_sum;
  `);
  console.log('[OK] sms_daily_stats updated successfully.');
} catch (e) {
  console.warn('[WARN] Could not rebuild sms_daily_stats automatically:', e.message);
}

db.close();

console.log('===============================================================');
console.log(' RECOVERY FINISHED!');
console.log(` Recovered messages are now live on the panel.`);
console.log(' Run `pm2 restart powerx` to refresh backend cache.');
console.log('===============================================================');
