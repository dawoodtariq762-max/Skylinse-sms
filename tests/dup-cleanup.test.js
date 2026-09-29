'use strict';
/**
 * tests/dup-cleanup.test.js — Safety contract for tools/dup-cleanup.js
 *
 * Runs ONLY read-only modes by default (dry-run / --backup) against a
 * synthetic database, honoring the production rule:
 *   NEVER touch backend/data.sqlite, NEVER --apply, NEVER --delete-ids.
 * The archive/apply/restore pipeline is also asserted — but ONLY when
 * explicitly enabled with DUP_CLEANUP_ALLOW_APPLY=1 (uses a disposable
 * synthetic copy even then).
 *
 * Run: node tests/dup-cleanup.test.js
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'dup-cleanup.js');
const ALLOW_APPLY = process.env.DUP_CLEANUP_ALLOW_APPLY === '1';

let total = 0;
function test(name, fn) { fn(); total++; console.log('PASS', name); }
function runTool(dbFile, args = []) {
  return execFileSync(process.execPath, [TOOL, '--db', dbFile, ...args], { encoding: 'utf8' });
}
function logicalHash(file) {
  const db = new Database(file, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  const h = crypto.createHash('sha256');
  for (const t of tables) {
    h.update(t);
    for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) h.update(JSON.stringify(row));
  }
  db.close();
  return h.digest('hex');
}

/* ---------------- synthetic fixture (mirrors historical dup patterns) ---------------- */
function makeFixture(dir) {
  const file = path.join(dir, 'fixture.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sms_records (id INTEGER PRIMARY KEY, number TEXT, cli TEXT, message TEXT, source TEXT, received_at TEXT);
    CREATE TABLE payment_ledger (id INTEGER PRIMARY KEY, sms_record_id INTEGER UNIQUE, agent_id INTEGER, amount TEXT);
    CREATE TABLE sharing_forward_logs (id INTEGER PRIMARY KEY, sms_record_id INTEGER, status TEXT);
    CREATE TABLE smpp_seen (id INTEGER PRIMARY KEY, connection_id INTEGER, dedup_key TEXT, sms_record_id INTEGER, received_at TEXT);
    CREATE TABLE api_integration_seen (id INTEGER PRIMARY KEY, integration_id INTEGER, duplicate_key TEXT, provider_message_id TEXT, sms_record_id INTEGER);
    CREATE TABLE api_integration_logs (id INTEGER PRIMARY KEY, integration_id INTEGER, status TEXT, number TEXT, cli TEXT, message TEXT, provider_message_id TEXT, sms_record_id INTEGER, created_at TEXT);
  `);
  const ins = db.prepare('INSERT INTO sms_records VALUES (?,?,?,?,?,?)');
  [
    [1, '1', 'W', 'code 482-991', 'api_integration', '2026-09-20 10:00:00'],   // A1 pair
    [2, '1', 'W', 'code 482-991', 'api_integration', '2026-09-20 10:00:03'],
    [3, '2', 'G', 'G-732114 code', 'smpp', '2026-09-21 14:00:00'],            // A2 cross-channel pair
    [4, '2', 'G', 'G-732114 code', 'api_integration', '2026-09-21 14:00:02'],
    [5, '3', 'T', 'tg 88412', 'smpp', '2026-09-22 09:00:00'],                 // B1 (Δ35s)
    [6, '3', 'T', 'tg 88412', 'smpp', '2026-09-22 09:00:35'],
    [7, '4', 'V', 'viber 2211', 'carrier', '2026-09-23 12:00:01'],            // B2 (Δ0s)
    [8, '4', 'V', 'viber 2211', 'carrier', '2026-09-23 12:00:01'],
    [9, '5', 'W', 'OTP 123456', 'smpp', '2026-09-24 09:00:00'],               // C (Δ1920s)
    [10, '5', 'W', 'OTP 123456', 'smpp', '2026-09-24 09:32:00'],
    [11, '6', 'P', 'pay 99120', 'api_integration', '2026-09-25 11:00:00'],    // A but finance-held (#12 paid)
    [12, '6', 'P', 'pay 99120', 'api_integration', '2026-09-25 11:00:02'],
  ].forEach((r) => ins.run(...r));
  const log = db.prepare('INSERT INTO api_integration_logs (integration_id,status,number,cli,message,provider_message_id,sms_record_id,created_at) VALUES (?,?,?,?,?,?,?,?)');
  log.run(1, 'success', '1', 'W', 'code 482-991', 'PX-991', 1, '2026-09-20 10:00:00');
  log.run(2, 'success', '1', 'W', 'code 482-991', 'PX-991', 2, '2026-09-20 10:00:03');
  log.run(3, 'success', '2', 'G', 'G-732114 code', 'PX-772', 4, '2026-09-21 14:00:02');
  log.run(1, 'success', '6', 'P', 'pay 99120', 'PX-FIN', 11, '2026-09-25 11:00:00');
  log.run(2, 'success', '6', 'P', 'pay 99120', 'PX-FIN', 12, '2026-09-25 11:00:02');
  db.exec("INSERT INTO payment_ledger (sms_record_id,agent_id,amount) VALUES (12,101,'1.25')");
  db.exec("INSERT INTO sharing_forward_logs (sms_record_id,status) VALUES (6,'success')");
  db.exec("INSERT INTO smpp_seen (connection_id,dedup_key,sms_record_id,received_at) VALUES (7,'fp:x',6,'2026-09-22 09:00:35')");
  db.exec("INSERT INTO api_integration_seen (integration_id,duplicate_key,provider_message_id,sms_record_id) VALUES (3,'cb:PX-772','PX-772',4)");
  db.close();
  return file;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcleanup-test-'));
const DBF = makeFixture(tmp);

/* ================= TEST 1 — dry-run classification is exact ================= */
test('dry-run classifies A/B/C/D exactly and plans only provable deletions', () => {
  const out = runTool(DBF);
  assert.match(out, /A\(CONFIRMED\)=3 groups, B\(PROBABLE\)=2, C\(POSSIBLY LEGIT\)=1/, 'A/B/C counts');
  assert.match(out, /DELETE #2 {2}\(keep first copy #1/, 'A1 deletion planned, keeper first');
  assert.match(out, /DELETE #4 {2}\(keep first copy #3/, 'A2 cross-channel deletion planned');
  assert.match(out, /re-link→keeper: forward_logs=0, smpp_seen=0, api_seen=1/, 'A2 re-link plan shown');
  assert.match(out, /FINANCE-REVIEW HOLD.*excluded ids #12/s, 'finance-guard excludes paid duplicate');
  assert.match(out, /tg 88412.*deltas=\[35s\]/s, 'B1 redelivery-shaped group listed');
  assert.match(out, /viber 2211.*deltas=\[0s\]/s, 'B2 same-second group listed');
  assert.match(out, /OTP 123456.*deltas=\[1920s\].*genuine separate/s, 'C group marked possibly legitimate');
  assert.match(out, /DRY-RUN complete — database NOT modified/, 'read-only banner');
});

/* ================= TEST 2 — dry-run is physically read-only ================= */
test('dry-run leaves the database byte-logically unchanged and creates nothing', () => {
  const before = logicalHash(DBF);
  runTool(DBF);
  assert.equal(logicalHash(DBF), before, 'all table contents identical after dry-run');
  const db = new Database(DBF, { readonly: true });
  const arch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_records_deleted_history'").get();
  db.close();
  assert.equal(arch, undefined, 'no archive table created in report mode');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.dupcleanup-'));
  assert.deepEqual(leftovers, [], 'no backup/archive dirs created without --backup');
});

/* ================= TEST 3 — unknown --delete-ids are refused, nothing changes ================= */
test('operator ids outside category B are refused with zero writes', () => {
  const out = runTool(DBF, ['--delete-ids', '9999,5555']);
  assert.match(out, /not found in category B.*refusing/s, 'refusal printed');
  assert.match(out, /DRY-RUN complete/, 'still ends as dry-run');
});

/* ================= TEST 4 — --backup is verified and does not alter source ================= */
test('--backup creates a verified copy and leaves the source untouched', () => {
  const before = logicalHash(DBF);
  const out = runTool(DBF, ['--backup']);
  assert.match(out, /backup created \+ verified \(\d+ sms_records rows\)/, 'verification line');
  const dirs = fs.readdirSync(tmp).filter((f) => f.includes('.dupcleanup-') && f.endsWith('.bak'));
  assert.equal(dirs.length, 1, 'exactly one backup dir');
  assert.ok(fs.existsSync(path.join(tmp, dirs[0], path.basename(DBF))), 'backup file exists');
  assert.equal(logicalHash(DBF), before, 'source unchanged by --backup');
});

/* ================= TEST 5 — apply/archive/restore (GATED, off by default) ================= */
if (ALLOW_APPLY) {
  test('apply archives before deleting, re-links deps, restore reverses it', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcleanup-apply-'));
    const copy = path.join(workDir, 'copy.sqlite');
    fs.copyFileSync(DBF, copy);
    const out = runTool(copy, ['--apply', '--yes']);
    assert.match(out, /archived\+deleted #2/, 'row #2 archived+deleted');
    assert.match(out, /archived\+deleted #4/, 'row #4 archived+deleted');
    assert.match(out, /records after cleanup         : 10/, '12→10 rows');
    assert.match(out, /#12 skipped|excluded ids #12/s, 'finance-held #12 NOT deleted');
    const db = new Database(copy);
    const arch = db.prepare('SELECT id,keeper_id,classification FROM sms_records_deleted_history ORDER BY id').all();
    assert.deepEqual(arch, [{ id: 2, keeper_id: 1, classification: 'A' }, { id: 4, keeper_id: 3, classification: 'A' }], 'archive holds full originals');
    assert.equal(db.prepare('SELECT sms_record_id FROM api_integration_seen WHERE sms_record_id=3').get() !== undefined, true, 'api_seen re-linked to keeper #3');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sms_records WHERE id IN (2,4)').get().c, 0, 'duplicates gone');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sms_records').get().c, 10, 'count after');
    db.close();
    const bakDir = fs.readdirSync(workDir).filter((f) => f.endsWith('.bak'))[0];
    const restore = fs.readdirSync(path.join(workDir, bakDir)).find((f) => f.startsWith('restore-'));
    execFileSync(process.execPath, [path.join(workDir, bakDir, restore), copy], { encoding: 'utf8' });
    const db2 = new Database(copy, { readonly: true });
    assert.equal(db2.prepare('SELECT COUNT(*) c FROM sms_records').get().c, 12, 'restore returns all rows');
    db2.close();
  });
} else {
  console.log('SKIP apply/archive/restore (set DUP_CLEANUP_ALLOW_APPLY=1 to enable — uses a disposable synthetic copy)');
}

console.log(`${total} dup-cleanup safety contract checks passed${ALLOW_APPLY ? '' : ' (apply-path gated off)'}.`);
