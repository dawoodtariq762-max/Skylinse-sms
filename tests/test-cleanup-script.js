/**
 * tests/test-cleanup-script.js
 * Validates the fix-smpp-duplicates.js script on synthetic duplicates and legitimate OTPs.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const TEST_DB = '/tmp/test_cleanup_dedup.db';
try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (_) {}

const db = new Database(TEST_DB);
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
  CREATE TABLE ranges (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE numbers (id INTEGER PRIMARY KEY, number TEXT);
  CREATE TABLE sms_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id INTEGER,
    number TEXT,
    range_id INTEGER,
    cli TEXT,
    sender_type TEXT DEFAULT '',
    message TEXT,
    otp_code TEXT,
    client_id INTEGER,
    agent_id INTEGER,
    manager_id INTEGER,
    is_test INTEGER DEFAULT 0,
    source TEXT DEFAULT 'smpp',
    payout_rate TEXT DEFAULT '0.05',
    payout_amount TEXT DEFAULT '0.05',
    received_at TEXT
  );
  CREATE TABLE payment_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sms_record_id INTEGER,
    agent_id INTEGER,
    manager_id INTEGER,
    range_id INTEGER,
    amount TEXT,
    earned_at TEXT,
    status TEXT DEFAULT 'open'
  );
  CREATE TABLE smpp_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER,
    dedup_key TEXT,
    sms_record_id INTEGER
  );
  CREATE TABLE smpp_connections (
    id INTEGER PRIMARY KEY,
    name TEXT,
    active INTEGER DEFAULT 1,
    total_received INTEGER DEFAULT 0
  );
  CREATE TABLE sms_daily_stats (
    stat_date TEXT,
    manager_id INTEGER,
    agent_id INTEGER,
    client_id INTEGER,
    cli TEXT,
    sms_count INTEGER,
    payout_sum REAL,
    PRIMARY KEY(stat_date, manager_id, agent_id, client_id, cli)
  );

  INSERT INTO smpp_connections (id, name, active, total_received) VALUES (1, 'TEST', 1, 10);
`);

// Insert synthetic dataset:
// 1. Message 1: 10:00:00 - OTP 888123 (Original)
// 2. Message 2: 10:00:08 - OTP 888123 (DUPLICATE retransmit, gap 8s) -> SHOULD BE PURGED
// 3. Message 3: 10:00:20 - OTP 888123 (DUPLICATE retransmit, gap 20s) -> SHOULD BE PURGED
// 4. Message 4: 10:25:00 - OTP 888123 (Legitimate resend, gap 25 min) -> SHOULD BE PRESERVED
// 5. Message 5: 10:00:00 - Number 2, OTP 111111 (Original)
// 6. Message 6: 10:00:05 - Number 2, OTP 222222 (Different code, consecutive) -> SHOULD BE PRESERVED
// 7. Message 7: 10:00:15 - Number 2, OTP 111111 (DUPLICATE retransmit of #5) -> SHOULD BE PURGED
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;

const testData = [
  { id: 1, num: '+447571897329', cli: 'WhatsApp', msg: 'Your code is 888123', otp: '888123', time: `${todayStr} 10:00:00` },
  { id: 2, num: '+447571897329', cli: 'WhatsApp', msg: 'Your code is 888123', otp: '888123', time: `${todayStr} 10:00:08` }, // dup of 1
  { id: 3, num: '+447571897329', cli: 'WhatsApp', msg: 'Your code is 888123', otp: '888123', time: `${todayStr} 10:00:20` }, // dup of 1
  { id: 4, num: '+447571897329', cli: 'WhatsApp', msg: 'Your code is 888123', otp: '888123', time: `${todayStr} 10:25:00` }, // legit resend 25m later
  { id: 5, num: '+447999888777', cli: 'Google',   msg: 'Your code is 111111', otp: '111111', time: `${todayStr} 10:00:00` },
  { id: 6, num: '+447999888777', cli: 'Google',   msg: 'Your code is 222222', otp: '222222', time: `${todayStr} 10:00:05` }, // legit different code
  { id: 7, num: '+447999888777', cli: 'Google',   msg: 'Your code is 111111', otp: '111111', time: `${todayStr} 10:00:15` }, // dup of 5
];

for (const d of testData) {
  db.prepare(`
    INSERT INTO sms_records (id, number_id, number, range_id, cli, message, otp_code, agent_id, manager_id, client_id, received_at)
    VALUES (?, 1, ?, 1, ?, ?, ?, 1, 1, 1, ?)
  `).run(d.id, d.num, d.cli, d.msg, d.otp, d.time);

  db.prepare(`
    INSERT INTO payment_ledger (sms_record_id, agent_id, manager_id, range_id, amount, earned_at)
    VALUES (?, 1, 1, 1, '0.05', ?)
  `).run(d.id, d.time);

  db.prepare(`
    INSERT INTO smpp_seen (connection_id, dedup_key, sms_record_id)
    VALUES (1, ?, ?)
  `).run(`test:${d.id}`, d.id);
}

db.close();

console.log('--- Testing Dry Run ---');
const dryOutput = execSync(`DB_FILE=${TEST_DB} node scripts/fix-smpp-duplicates.js`).toString();
console.log(dryOutput);

if (!dryOutput.includes('Duplicate records found:    3')) {
  console.error('FAIL: Expected 3 duplicates found in dry run!');
  process.exit(1);
}

console.log('--- Testing Apply ---');
const applyOutput = execSync(`DB_FILE=${TEST_DB} node scripts/fix-smpp-duplicates.js --apply`).toString();
console.log(applyOutput);

const verifyDb = new Database(TEST_DB);
const remainingSms = verifyDb.prepare('SELECT id, number, cli, message, otp_code, received_at FROM sms_records ORDER BY id ASC').all();
const remainingLedger = verifyDb.prepare('SELECT id, sms_record_id FROM payment_ledger').all();
const conn = verifyDb.prepare('SELECT total_received FROM smpp_connections WHERE id=1').get();

console.log(`Remaining SMS records in DB (${remainingSms.length}):`);
remainingSms.forEach(r => console.log(`  [ID ${r.id}] ${r.number} | ${r.cli} | Code: ${r.otp_code} | Time: ${r.received_at}`));

if (remainingSms.length !== 4) {
  console.error(`FAIL: Expected 4 remaining records, found ${remainingSms.length}`);
  process.exit(1);
}

const remainingIds = remainingSms.map(r => r.id);
// IDs 2, 3, 7 should have been deleted. IDs 1, 4, 5, 6 should remain.
if (!remainingIds.includes(1) || !remainingIds.includes(4) || !remainingIds.includes(5) || !remainingIds.includes(6)) {
  console.error('FAIL: Legitimate records were incorrectly deleted!', remainingIds);
  process.exit(1);
}
if (remainingIds.includes(2) || remainingIds.includes(3) || remainingIds.includes(7)) {
  console.error('FAIL: Duplicate records were not deleted!', remainingIds);
  process.exit(1);
}
if (remainingLedger.length !== 4) {
  console.error('FAIL: Payment ledger was not synchronized with SMS records!', remainingLedger.length);
  process.exit(1);
}
if (conn.total_received !== 7) { // 10 initial - 3 dups = 7
  console.error('FAIL: SMPP connection total_received was not adjusted!', conn.total_received);
  process.exit(1);
}

verifyDb.close();
try { fs.unlinkSync(TEST_DB); } catch (_) {}
console.log('\n✅ VERIFICATION PASSED: Deduplication script accurately purged only wire retries and preserved all legitimate OTPs!\n');
