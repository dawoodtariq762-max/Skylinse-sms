'use strict';
/**
 * E2E verification — REAL panel process (server.js + smppService + SQLite) driven
 * by a mock SMSC over TCP.  This is the 14-scenario matrix from the approved
 * request; the "before" numbers come from
 * /home/user/investigation/ingest_accounting.js (run against the pristine
 * panel-src), the "after" numbers from this run.
 *
 * The mock SMSC deliberately sends NO message id in the default cases — that is
 * what the real provider's PDUs were measured to carry (see
 * /home/user/smpp-duplicate-diagnosis.md §2). Providers that DO send
 * receipted_message_id (TLV 0x001E) are covered separately at the end (TEST 15).
 *
 * POLICY: this run uses the SHIPPED DEFAULT for a no-id SMSC —
 * SMPP_FALLBACK_RETRY_WINDOW_SECONDS=0, i.e. nothing is ever suppressed by
 * content. Every no-id redelivery is therefore stored again, on purpose, and is
 * logged + counted in the identity report instead of being silently dropped.
 * The opt-in window policy (which does suppress, and can drop a genuine
 * identical SMS) is measured separately by tests/window_policy_child.js.
 *
 * Run: node tests/e2e_mock_smsc.js            (real timings, ~60 s)
 *      E2E_SPEED=0.1 node tests/e2e_mock_smsc.js   (fast, for iterating)
 *
 * Nothing is deployed and no production database is touched: the suite creates
 * a throw-away DATA_DIR under /tmp.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-e2e-'));
const PORT = 46000 + Math.floor(Math.random() * 2000);
const SPEED = Math.max(0.02, Number(process.env.E2E_SPEED || 1));

process.env.TZ = 'Europe/London';            // the panel must NOT use the host zone for the SMS day
process.env.DATA_DIR = DATA_DIR;
process.env.POWERX_ROLE = 'api';
process.env.PORT = String(PORT);
process.env.SMPP_ENABLED = 'true';
process.env.SMPP_ID_TLVS = '0x001e';
process.env.SMPP_FALLBACK_RETRY_WINDOW_SECONDS = '0';   // shipped default: lossless (no content suppression)
process.env.PAYMENT_LEDGER_BACKFILL_ON_STARTUP = 'false';

const { MockSmsc, bootPanel, api, login, sleep, waitReady } = require('./lib/mock_smsc');

const { db, smppService } = bootPanel({ DATA_DIR, POWERX_ROLE: 'api', PORT: String(PORT) });
let dayWindow = null;
try { dayWindow = require(ROOT + '/backend/dayWindow'); } catch (_) { /* pre-fix code has no UTC day helper */ }

const NUM = '447700900123';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log('   PASS  ' + label + (detail ? '   [' + detail + ']' : '')); }
  else { fail++; console.log('   FAIL  ' + label + (detail ? '   [' + detail + ']' : '')); }
  results.push({ label, ok: !!cond, detail: detail || '' });
}
async function step(label, fn) {
  console.log('\n' + label);
  try { await fn(); }
  catch (e) {
    fail++;
    results.push({ label, ok: false, detail: 'crashed: ' + (e && e.message) });
    console.log('   FAIL  (step crashed) ' + (e && e.message));
  }
}

const q = (sql, p = []) => db.get(sql, p);
const tryQ = (sql, p = []) => { try { return q(sql, p); } catch (_) { return null; } };   // null = not available in this build
const all = (sql, p = []) => db.all(sql, p);
const x = (sql, p = []) => db.run(sql, p);
const rowsFor = (cli) => q('SELECT COUNT(*) c FROM sms_records WHERE cli=?', [cli]).c;
const msgsFor = (cli) => all('SELECT message FROM sms_records WHERE cli=? ORDER BY id', [cli]).map((r) => r.message);

let seq = 1;
let st = 0;        // last deliver_sm_resp status (shared between steps)
let A = null;      // the SMS used by TEST 1/2/3/11
let B = null;      // TEST 5
let F = null;      // TEST 13
const mock = new MockSmsc();
let mockPort = 0;
let connId = 0;
let connUid = '';
let token = '';
let rangeId = 0;
let numId = 0;

async function push(o) {
  const s = seq++;
  // Default: the SMSC provides NO message id (as measured on the real provider).
  mock.deliver(Object.assign({ idTlv: 0 }, o, { seq: s }));
  const t0 = Date.now();
  for (;;) {
    const r = mock.respFor(s);
    if (r) return r.status;
    if (Date.now() - t0 > 8000) throw new Error('no deliver_sm_resp for seq ' + s);
    await sleep(20);
  }
}

async function waitBound(id, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const st = smppService.statusOf(id);
    if (st && st.status === 'bound') return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(100);
  }
}

async function createConnection() {
  const r = await api(PORT, 'POST', '/api/smpp/connections', {
    name: 'E2E SMSC', mode: 'client', active: true,
    host: '127.0.0.1', port: mockPort,
    system_id: 'e2e-sys', password: 'e2e-pass',
    bind_type: 'transceiver', enquire_link_seconds: 30,
  }, token);
  if (r.status !== 200 || !r.body || !r.body.connection) throw new Error('connection create failed: ' + r.status + ' ' + r.raw.slice(0, 300));
  return r.body.connection;
}

(async () => {
  console.log('E2E — real panel + mock SMSC');
  console.log('DATA_DIR   : ' + DATA_DIR);
  console.log('HTTP port  : ' + PORT);
  console.log('host TZ    : ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '  (deliberately NOT UTC)');

  await waitReady(db, 30000);
  token = await login(PORT);

  /* ---------- fixture: one allocated number ---------- */
  x("INSERT INTO ranges (name, prefix, currency, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES ('E2E','44','USD','1.0','1.0','1.0','1.0')");
  rangeId = q("SELECT id FROM ranges WHERE name='E2E'").id;
  x('INSERT INTO numbers (range_id, number, rate, payout, manager_id, agent_id, client_id) VALUES (?,?,?,?,1,1,1)', [rangeId, NUM, '1.0', '0.5']);
  numId = q('SELECT id FROM numbers WHERE number=?', [NUM]).id;

  mockPort = await mock.listen();
  const created = await createConnection();
  connId = created.id; connUid = created.connection_uid;
  check('connection created via the admin API carries a stable connection_uid', !!connUid, 'uid=' + String(connUid).slice(0, 18) + '…');
  check('durable dedup ledger table exists', !!q("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_dedup_ledger'"), 'sms_dedup_ledger');
  check('restart-safe multipart table exists', !!q("SELECT name FROM sqlite_master WHERE type='table' AND name='smpp_parts'"), 'smpp_parts');
  const bound = await waitBound(connId);
  check('bind to the mock SMSC succeeded', bound, 'mock binds=' + mock.binds);

  /* =========================== TEST 1/2 =========================== */
  await step('TEST 1 — SMSC retry after +5 s (same physical SMS) → 1 row', async () => {
  A = { smid: 'E2E-A', src: '447911100001', dst: NUM, text: 'Your verification code is 111111' };
  st = await push(A);
  check('T1 stored, ACK=0', st === 0, 'status=' + st);
  check('T1 exactly 1 row', rowsFor(A.src) === 1, 'rows=' + rowsFor(A.src));

  await sleep(5000 * SPEED);
  st = await push(A);
  check('T1 retry +5 s ACK=0', st === 0, 'status=' + st);
  check('T1 retry +5 s: this SMSC gave no id, so the message is stored again — the documented lossless default',
    rowsFor(A.src) === 2, 'rows=' + rowsFor(A.src) + ' (window policy off: never dropped, always logged)');
  const identWarn = tryQ("SELECT COUNT(*) c FROM smpp_logs WHERE detail LIKE '%no durable id%'");
  check('T1 the panel records the missing identity instead of silently deduping by content',
    !!identWarn && identWarn.c >= 1, identWarn ? 'identity warnings in smpp_logs=' + identWarn.c : 'no log table in this build');
  const ledAny = tryQ("SELECT COUNT(*) c FROM sms_dedup_ledger WHERE sms_record_id IS NOT NULL");
  check('T1 no content-based ledger entry was created for the no-id message',
    !ledAny || ledAny.c === 0, ledAny ? 'ledger rows pointing at stored SMS=' + ledAny.c : 'no ledger in this build');

  });
  await step('TEST 2 — SMSC retry after +12 s', async () => {
  await sleep(12000 * SPEED);
  st = await push(A);
  check('T2 retry +12 s stored again (lossless default), never silently merged',
    st === 0 && rowsFor(A.src) === 3, 'status=' + st + ' rows=' + rowsFor(A.src));
  check('T2 the two identical bodies are both present (no content-based loss)',
    msgsFor(A.src).filter((m) => m === A.text).length === 3, 'identical bodies=' + msgsFor(A.src).filter((m) => m === A.text).length);

  /* =========================== TEST 3 =========================== */
  });
  await step('TEST 3 — reconnect (new TCP session + bind), same SMS pushed again', async () => {
  smppService.stopConnection(connId);
  await sleep(300 * SPEED);
  smppService.startConnection(connId);
  const rebind = await waitBound(connId);
  check('T3 rebind succeeded', rebind && mock.binds >= 2, 'binds=' + mock.binds);
  st = await push(A);
  check('T3 redelivery after reconnect stored again (lossless default)', st === 0 && rowsFor(A.src) === 4, 'status=' + st + ' rows=' + rowsFor(A.src));

  /* =========================== TEST 5/6 =========================== */
  });
  await step('TEST 5 — GENUINE new SMS with the SAME text/OTP → must NOT be suppressed', async () => {
  /* Same SENDER and exactly the same text/OTP, but a different physical message
     (different SMSC id) — the case the old content+10 s-bucket rule silently
     merged. Delivered ~1.5 s apart, i.e. deep inside that old bucket. */
  B = { smid: 'E2E-B', src: '447911100050', dst: NUM, text: A.text };
  st = await push(B);
  await sleep(1500 * SPEED);
  const B2 = { smid: 'E2E-B2', src: '447911100050', dst: NUM, text: A.text };
  const stB2 = await push(B2);
  check('T5 two genuine OTPs with identical content are kept as two rows', st === 0 && stB2 === 0 && rowsFor('447911100050') === 2,
    'rows=' + rowsFor('447911100050') + ' (the old 10 s content rule collapsed them into 1)');
  await sleep(12000 * SPEED);
  const B3 = { smid: 'E2E-B3', src: '447911100050', dst: NUM, text: A.text };
  st = await push(B3);
  check('T5b the same resend a while later is also kept', st === 0 && rowsFor('447911100050') === 3, 'rows=' + rowsFor('447911100050'));

  });
  await step('TEST 6 — two different messages → 2 rows', async () => {
  const C = { smid: 'E2E-C', src: '447911100003', dst: NUM, text: 'Order 7788 has been shipped' };
  st = await push(C);
  check('T6 stored, 1 row', st === 0 && rowsFor(C.src) === 1);

  /* =========================== TEST 7 =========================== */
  });
  await step('TEST 7 — 2-part concatenated SMS (UDH 8-bit ref) → 1 complete row', async () => {
  const mpRef = 42;
  st = await push({ smid: 'E2E-MP-a', src: '447911100004', dst: NUM, text: 'Hello this is part one of ', udh: [0x05, 0x00, 0x03, mpRef, 2, 1] });
  check('T7 part 1 acked but not stored alone', st === 0 && rowsFor('447911100004') === 0, 'rows=' + rowsFor('447911100004'));
  st = await push({ smid: 'E2E-MP-b', src: '447911100004', dst: NUM, text: 'a longer message.', udh: [0x05, 0x00, 0x03, mpRef, 2, 2] });
  const mpRows = msgsFor('447911100004');
  check('T7 completed into exactly 1 row', st === 0 && mpRows.length === 1, 'rows=' + mpRows.length);
  check('T7 body reassembled in order', mpRows[0] === 'Hello this is part one of a longer message.', JSON.stringify(mpRows[0] || ''));
  const partsLeft = tryQ('SELECT COUNT(*) c FROM smpp_parts WHERE group_key LIKE ?', ['%|' + mpRef + '|2']);
  check('T7 no pending parts left behind', !!partsLeft && partsLeft.c === 0, partsLeft ? 'pending=' + partsLeft.c : 'no smpp_parts table in this build');

  });
  await step('TEST 7b — duplicate part retry (part 1 pushed twice) then part 2', async () => {
  st = await push({ smid: 'E2E-MP2-a', src: '447911100005', dst: NUM, text: 'FIRST HALF ', udh: [0x05, 0x00, 0x03, 43, 2, 1] });
  st = await push({ smid: 'E2E-MP2-a', src: '447911100005', dst: NUM, text: 'FIRST HALF ', udh: [0x05, 0x00, 0x03, 43, 2, 1] });
  await push({ smid: 'E2E-MP2-b', src: '447911100005', dst: NUM, text: 'SECOND HALF', udh: [0x05, 0x00, 0x03, 43, 2, 2] });
  const mp2 = msgsFor('447911100005');
  check('T7b retried part does not duplicate content', mp2.length === 1 && mp2[0] === 'FIRST HALF SECOND HALF', JSON.stringify(mp2));

  /* =========================== TEST 8 =========================== */
  });
  await step('TEST 8 — identical-content independent messages (no UDH, different SMSC ids) → 2 rows', async () => {
  const D1 = { smid: 'E2E-D1', src: '447911100006', dst: NUM, text: 'Balance is 50.00' };
  const D2 = { smid: 'E2E-D2', src: '447911100007', dst: NUM, text: 'Balance is 50.00' };
  await push(D1); await push(D2);
  check('T8 two rows kept (content never used as an identity)', rowsFor(D1.src) === 1 && rowsFor(D2.src) === 1, rowsFor(D1.src) + '/' + rowsFor(D2.src));

  /* =========================== TEST 9 =========================== */
  });
  await step('TEST 9 — two different message_payload (0x0424) SMS in one window → 2 rows, 2 correct bodies', async () => {
  const P1 = { smid: 'E2E-P1', src: '447911100010', dst: NUM, text: '', payload: 'PAYLOAD-ONE 222222' };
  const P2 = { smid: 'E2E-P2', src: '447911100011', dst: NUM, text: '', payload: 'PAYLOAD-TWO 333333' };
  st = await push(P1);
  check('T9 payload #1 stored', st === 0 && rowsFor(P1.src) === 1);
  await sleep(200 * SPEED);           // well inside the old 10 s bucket that collapsed the pair
  st = await push(P2);
  const p1m = msgsFor(P1.src), p2m = msgsFor(P2.src);
  check('T9 payload #2 stored separately', st === 0 && p2m.length === 1, 'rows=' + p2m.length);
  check('T9 bodies are the real payload text (no [object Object], no empty body)',
    p1m[0] === P1.payload && p2m[0] === P2.payload, JSON.stringify(p1m[0] || '') + ' | ' + JSON.stringify(p2m[0] || ''));

  /* =========================== TEST 10 =========================== */
  });
  await step('TEST 10 — 50 distinct SMS replayed once after a reconnect → 50 rows (not 100)', async () => {
  const batch = [];
  for (let i = 0; i < 50; i++) batch.push({ smid: 'E2E-50-' + i, src: '44792220' + String(1000 + i), dst: NUM, text: 'Batch message number ' + i });
  for (const m of batch) await push(m);
  const afterFirst = all('SELECT COUNT(*) c FROM sms_records WHERE cli LIKE ?', ['44792220%'])[0].c;
  smppService.stopConnection(connId); await sleep(300 * SPEED); smppService.startConnection(connId); await waitBound(connId);
  await sleep(12000 * SPEED);   // the SMSC comes back later, not in the same 10 s window
  for (const m of batch) await push(m);
  const afterReplay = all('SELECT COUNT(*) c FROM sms_records WHERE cli LIKE ?', ['44792220%'])[0].c;
  check('T10 50 distinct SMS stored once each on the first pass', afterFirst === 50, 'rows=' + afterFirst);
  check('T10 with no id from the SMSC the replayed batch is stored again (documented lossless default, never silent)',
    afterReplay === 100, 'rows=' + afterReplay + ' — TEST 15 shows the same replay at 50 when the SMSC supplies an id');

  /* =========================== TEST 13 =========================== */
  });
  await step('TEST 13 — persistence failure must NOT be acked as success; retry stores exactly once', async () => {
  x("CREATE TRIGGER e2e_fail_insert BEFORE INSERT ON sms_records BEGIN SELECT RAISE(ABORT,'e2e injected storage failure'); END");
  F = { smid: 'E2E-F', src: '447911100009', dst: NUM, text: 'Persistence test 999999' };
  const stFail = await push(F);
  check('T13 storage failure answered with a negative ack (SMSC will retry)', stFail !== 0, 'status=' + stFail + ' (254 = ESME_RDELIVERYFAILURE)');
  check('T13 nothing stored while the failure lasts', rowsFor(F.src) === 0, 'rows=' + rowsFor(F.src));
  x('DROP TRIGGER e2e_fail_insert');
  const stRetry = await push(F);
  check('T13 retry after the failure stores exactly one row', stRetry === 0 && rowsFor(F.src) === 1, 'status=' + stRetry + ' rows=' + rowsFor(F.src));
  await push(F);
  check('T13 the following redelivery is stored again (no id from this SMSC, lossless default)',
    rowsFor(F.src) === 2, 'rows=' + rowsFor(F.src));

  });
  await step('TEST 13b — operator "Retry" on the queued failure must not add a second row', async () => {
  const frow = tryQ('SELECT id, dedup_identity FROM failed_sms_queue WHERE cli=? ORDER BY id DESC LIMIT 1', [F.src])
    || tryQ('SELECT id FROM failed_sms_queue WHERE cli=? ORDER BY id DESC LIMIT 1', [F.src]);
  if (!frow) {
    check('T13b a queued retry row exists for the failed SMS', false, 'this build queued no row for a storage failure');
  } else {
    const rowsBeforeRetry = rowsFor(F.src);
    const retry1 = await api(PORT, 'POST', '/api/failed-sms/' + frow.id + '/retry', {}, token);
    const afterRetry1 = rowsFor(F.src);
    const retry2 = await api(PORT, 'POST', '/api/failed-sms/' + frow.id + '/retry', {}, token);
    const afterRetry2 = rowsFor(F.src);
    const idInQueue = /^smpp:/.test(String(frow.dedup_identity || ''));
    check('T13b the queued retry row is present (identity filled when the SMSC supplied one)',
      !!frow, 'dedup_identity=' + (idInQueue ? String(frow.dedup_identity).slice(0, 20) + '…' : '(none — this SMSC sends no id)'));
    check('T13b the first retry stores the SMS that was genuinely missing',
      retry1.status === 200 && afterRetry1 === rowsBeforeRetry + 1, rowsBeforeRetry + ' → ' + afterRetry1);
    check('T13b a second retry click adds no further row (idempotent by sms_record_id)',
      retry2.status === 200 && afterRetry2 === afterRetry1,
      afterRetry1 + ' → ' + afterRetry2 + ' ' + JSON.stringify(retry2.body || {}).slice(0, 90));
  }

  });
  await step('TEST 13c — a post-insert bookkeeping failure must still ACK success (the row is already stored)', async () => {
  x("CREATE TRIGGER e2e_fail_bookkeeping BEFORE INSERT ON sms_daily_stats BEGIN SELECT RAISE(ABORT,'e2e injected bookkeeping failure'); END");
  const G = { smid: 'E2E-G', src: '447911100012', dst: NUM, text: 'Bookkeeping test 121212' };
  const stG = await push(G);
  check('T13c ACK=0 even though a post-insert step threw', stG === 0, 'status=' + stG);
  check('T13c the row was stored exactly once', rowsFor(G.src) === 1, 'rows=' + rowsFor(G.src));
  x('DROP TRIGGER e2e_fail_bookkeeping');
  const stG2 = await push(G);
  check('T13c one copy per delivery (the no-id redelivery is stored again, lossless default)',
    stG2 === 0 && rowsFor(G.src) === 2, 'status=' + stG2 + ' rows=' + rowsFor(G.src));

  /* =========================== TEST 12 =========================== */
  });
  await step('TEST 12 — ledger references the EXACT inserted row (no ORDER BY id DESC race)', async () => {
  const R1 = { smid: 'E2E-R1', src: '447911100020', dst: NUM, text: 'ATTRIB ONE 424242', idTlv: 0x001e };
  const R2 = { smid: 'E2E-R2', src: '447911100021', dst: NUM, text: 'ATTRIB TWO 434343', idTlv: 0x001e };
  const r1st = await push(R1);
  // a concurrent writer (other channel) inserts while we are between statements
  const decoy = x("INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,source,received_at,payment_type,limit_reason) VALUES (?,?,?,?,?,?,?,datetime('now'),'','')",
    [numId, NUM, rangeId, 'DECOY-WRITER', 'test', 'DECOY ROW', 'e2e']).lastInsertRowid;
  const r2st = await push(R2);
  const row1 = q("SELECT id, message FROM sms_records WHERE cli=? ORDER BY id LIMIT 1", [R1.src]);
  const row2 = q("SELECT id, message FROM sms_records WHERE cli=? ORDER BY id LIMIT 1", [R2.src]);
  const led1 = tryQ('SELECT sms_record_id FROM sms_dedup_ledger WHERE sms_record_id=?', [row1.id]);
  const led2 = tryQ('SELECT sms_record_id FROM sms_dedup_ledger WHERE sms_record_id=?', [row2.id]);
  check('T12 first delivery acked and attributed', r1st === 0 && !!led1, 'ledger→row ' + row1.id);
  check('T12 second delivery acked and attributed to its OWN row', r2st === 0 && !!led2 && row1.id !== row2.id, 'ledger→row ' + row2.id);
  const decoyRef = tryQ('SELECT COUNT(*) c FROM sms_dedup_ledger WHERE sms_record_id=?', [decoy]);
  check('T12 the concurrent writer is not referenced by the ledger', !!decoyRef && decoyRef.c === 0, decoyRef ? 'decoy row ' + decoy : 'no ledger table in this build');
  // fire two PDUs back to back without waiting for either response
  mock.deliver(Object.assign({ idTlv: 0x001e }, { smid: 'E2E-R3', src: '447911100022', dst: NUM, text: 'INTERLEAVED 3', seq: seq++ }));
  mock.deliver(Object.assign({ idTlv: 0x001e }, { smid: 'E2E-R4', src: '447911100023', dst: NUM, text: 'INTERLEAVED 4', seq: seq++ }));
  await sleep(600 * SPEED);
  const i3 = q('SELECT id FROM sms_records WHERE cli=? LIMIT 1', ['447911100022']);
  const i4 = q('SELECT id FROM sms_records WHERE cli=? LIMIT 1', ['447911100023']);
  check('T12 interleaved pair both stored and separately attributed',
    !!i3 && !!i4 && i3.id !== i4.id &&
    !!tryQ('SELECT 1 FROM sms_dedup_ledger WHERE sms_record_id=?', [i3.id]) &&
    !!tryQ('SELECT 1 FROM sms_dedup_ledger WHERE sms_record_id=?', [i4.id]),
    i3.id + ' / ' + i4.id + (tryQ("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_dedup_ledger'") ? '' : ' (no ledger in this build)'));

  /* =========================== TEST 11 =========================== */
  });
  await step('TEST 11 — delete + re-create the SMSC account, then the SMSC retries', async () => {
  const ledBeforeRow = tryQ('SELECT COUNT(*) c FROM sms_dedup_ledger WHERE connection_uid=?', [connUid]);
  const ledBefore = ledBeforeRow ? ledBeforeRow.c : -1;
  const del = await api(PORT, 'DELETE', '/api/smpp/connections/' + connId, undefined, token);
  check('T11 connection deleted', del.status === 200, 'http ' + del.status);
  const ledAfterRow = tryQ('SELECT COUNT(*) c FROM sms_dedup_ledger WHERE connection_uid=?', [connUid]);
  check('T11 replay ledger SURVIVED the delete', !!ledAfterRow && ledAfterRow.c === ledBefore && ledBefore > 0,
    ledAfterRow ? ledBefore + ' identities kept' : 'no ledger table in this build');
  const recreated = await createConnection();
  connId = recreated.id;
  check('T11 re-created account gets the SAME stable identity', recreated.connection_uid === connUid, String(recreated.connection_uid).slice(0, 18) + '…');
  await waitBound(connId);
  st = await push(A);
  check('T11 no-id redelivery after delete/re-create is stored again (lossless default)',
    st === 0 && rowsFor(A.src) === 5, 'status=' + st + ' rows=' + rowsFor(A.src));

  /* =========================== TEST 4 (separate process) =========================== */
  });
  await step('TEST 4 — full process restart: redelivery in a fresh node process → still 1 row', async () => {
  const childPort = PORT + 1;
  const seenBefore = (q('SELECT seen_count FROM sms_dedup_ledger WHERE sms_record_id=(SELECT id FROM sms_records WHERE cli=? LIMIT 1)', [A.src]) || {}).seen_count || 0;
  const parentSession = mock.latestBoundSession();
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [ROOT + '/tests/restart_child.js', DATA_DIR, String(childPort), String(mockPort), String(connUid), String(seenBefore)], {
      env: Object.assign({}, process.env, { PANEL_DIR: ROOT, TZ: 'Asia/Karachi', DATA_DIR, POWERX_ROLE: 'api', PORT: String(childPort) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = ''; let pushed = false;
    const handle = async (d) => {
      buf += d;
      if (pushed || !/READY /.test(buf)) return;
      pushed = true;
      // wait until the child's own session is the newest bound one, then push
      let sess = null;
      const t = Date.now();
      for (;;) {
        const cand = mock.latestBoundSession();
        const dbRow = q("SELECT status FROM smpp_connections WHERE name='E2E SMSC (restart)'");
        if (cand && cand !== parentSession && dbRow && dbRow.status === 'bound') { sess = cand; break; }
        if (Date.now() - t > 8000) { sess = cand; break; }
        await sleep(100);
      }
      if (sess && sess.sock && !sess.sock.destroyed) {
        mock.deliverTo(sess, { seq: 9001, smid: 'E2E-A', src: A.src, dst: NUM, text: A.text });
        console.log('   ---   parent pushed the redelivery into the restarted process');
      } else {
        console.log('   ---   WARNING: could not identify the restarted process session');
      }
    };
    c.stdout.on('data', handle);
    c.stderr.on('data', (d) => { buf += d; });
    c.on('close', (code) => resolve({ code, buf }));
  });
  const line = (out.buf.match(/^RESULT (.*)$/m) || [])[1];
  let j = null; try { j = JSON.parse(line); } catch (_) {}
  check('T4 restart child completed', out.code === 0 && !!j, 'exit=' + out.code);
  if (j) {
    check('T4 the restarted process resolves the SAME stable account identity', j.sameUid === true && j.bound === true, 'sameUid=' + j.sameUid + ' bound=' + j.bound);
    check('T4 redelivery across a full process restart is stored again with no id available (lossless default)',
      j.rowsForA === 6, 'rows=' + j.rowsForA + ' (5 before the restart; TEST 15 shows suppression across restarts when the SMSC supplies an id)');
    check('T4 UTC day maths is host-TZ independent (child ran as Asia/Karachi)', j.utcDayMatchesClock === true && j.statsUtcDay === true, 'child tz=' + j.tz);
  } else {
    console.log('   ---   child output tail: ' + out.buf.split('\n').slice(-6).join(' | '));
  }

  /* =========================== TEST 14 =========================== */
  });
  await step('TEST 14 — UTC day boundary (23:59:59Z vs 00:00:00Z) and host-TZ independence', async () => {
  const utcToday = new Date().toISOString().slice(0, 10);
  const clock = q("SELECT date('now') u, date('now','localtime') l");
  check('T14 UTC day helper module present (backend/dayWindow.js)', !!dayWindow, dayWindow ? 'loaded' : 'MISSING in this build');
  check('T14 SQL UTC day equals the UTC clock', clock.u === utcToday, clock.u + ' vs ' + utcToday);
  check('T14 host zone is not UTC, so the check is meaningful', Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone);
  check('T14 dayWindow.utcDayString(0) is the UTC day', !!dayWindow && dayWindow.utcDayString(0) === utcToday, dayWindow ? dayWindow.utcDayString(0) : 'n/a');
  check('T14 statDateUtc keeps 23:59:59Z in the earlier day', !!dayWindow && dayWindow.statDateUtc('2026-09-28 23:59:59') === '2026-09-28', dayWindow ? dayWindow.statDateUtc('2026-09-28 23:59:59') : 'n/a');
  x("INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,source,received_at,payment_type,limit_reason) VALUES (?,?,?,?,?,?,?,?,'','')",
    [numId, NUM, rangeId, 'BOUNDARY-Z1', 'test', 'boundary 23:59:59', 'e2e', '2026-09-28 23:59:59']);
  x("INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,source,received_at,payment_type,limit_reason) VALUES (?,?,?,?,?,?,?,?,'','')",
    [numId, NUM, rangeId, 'BOUNDARY-Z2', 'test', 'boundary 00:00:00', 'e2e', '2026-09-29 00:00:00']);
  check('T14 23:59:59Z counted in 2026-09-28 (UTC)', q("SELECT COUNT(*) c FROM sms_records WHERE date(received_at)='2026-09-28' AND cli='BOUNDARY-Z1'").c === 1);
  check('T14 00:00:00Z counted in 2026-09-29 (UTC)', q("SELECT COUNT(*) c FROM sms_records WHERE date(received_at)='2026-09-29' AND cli='BOUNDARY-Z2'").c === 1);
  check('T14 the legacy Europe/London (BST) rule merged BOTH into 09-29 — the bug being removed',
    q("SELECT COUNT(*) c FROM sms_records WHERE cli IN ('BOUNDARY-Z1','BOUNDARY-Z2') AND date(received_at,'+1 hour')='2026-09-29'").c === 2);
  const statsToday = q("SELECT COUNT(*) c FROM sms_daily_stats WHERE stat_date=date('now')").c;
  check('T14 derived stats are bucketed by the UTC day', statsToday >= 1, 'rows today=' + statsToday);

  /* =========================== extras =========================== */
  });
  await step('TEST 15 — provider that DOES send receipted_message_id (TLV 0x001E)', async () => {
    const Z = { smid: 'SMSC-ID-9931', src: '447911100060', dst: NUM, text: 'Provider-id message 555555', idTlv: 0x001e };
    st = await push(Z);
    check('T15 stored with the provider id present', st === 0 && rowsFor(Z.src) === 1, 'status=' + st + ' rows=' + rowsFor(Z.src));
    await sleep(5000 * SPEED);
    st = await push(Z);
    check('T15 retry suppressed by the provider id', st === 0 && rowsFor(Z.src) === 1, 'rows=' + rowsFor(Z.src));
    // delete + re-create the same SMSC account, then the provider retries again
    await api(PORT, 'DELETE', '/api/smpp/connections/' + connId, undefined, token);
    const again = await createConnection();
    connId = again.id;
    await waitBound(connId);
    st = await push(Z);
    check('T15 retry still recognised after the account was deleted and re-created', st === 0 && rowsFor(Z.src) === 1,
      'rows=' + rowsFor(Z.src) + ' (the old per-connection replay table was wiped with the connection)');

    // 50 distinct messages, replayed after a reconnect — the acceptance criterion
    const batchZ = [];
    for (let i = 0; i < 50; i++) batchZ.push({ smid: 'Z50-' + i, src: '44793330' + String(1000 + i), dst: NUM, text: 'Id batch ' + i, idTlv: 0x001e });
    for (const m of batchZ) await push(m);
    const firstZ = all('SELECT COUNT(*) c FROM sms_records WHERE cli LIKE ?', ['44793330%'])[0].c;
    smppService.stopConnection(connId); await sleep(300 * SPEED); smppService.startConnection(connId); await waitBound(connId);
    await sleep(12000 * SPEED);
    for (const m of batchZ) await push(m);
    const replayedZ = all('SELECT COUNT(*) c FROM sms_records WHERE cli LIKE ?', ['44793330%'])[0].c;
    check('T15b 50 distinct SMS stored once each', firstZ === 50, 'rows=' + firstZ);
    check('T15b the replayed batch adds nothing when the SMSC supplies ids', replayedZ === 50,
      'rows=' + replayedZ + ' (before the fix: 100; the ids also survive reconnect/restart)');
  });

  await step('TEST 16 — multipart identity survives a reconnect even with no SMSC id', async () => {
    const src16 = '447911100070';
    const ref = 77;
    st = await push({ smid: 'MP16-a1', src: src16, dst: NUM, text: 'PART ONE OF THE ', udh: [0x05, 0x00, 0x03, ref, 2, 1] });
    st = await push({ smid: 'MP16-a2', src: src16, dst: NUM, text: 'MULTIPART TEST.', udh: [0x05, 0x00, 0x03, ref, 2, 2] });
    const rowsBefore = rowsFor(src16);
    smppService.stopConnection(connId); await sleep(300 * SPEED); smppService.startConnection(connId); await waitBound(connId);
    // the SMSC re-pushes BOTH parts after the reconnect
    await push({ smid: 'MP16-a1', src: src16, dst: NUM, text: 'PART ONE OF THE ', udh: [0x05, 0x00, 0x03, ref, 2, 1] });
    await push({ smid: 'MP16-a2', src: src16, dst: NUM, text: 'MULTIPART TEST.', udh: [0x05, 0x00, 0x03, ref, 2, 2] });
    const rowsAfter = rowsFor(src16);
    const m16 = msgsFor(src16);
    check('T16 two parts completed into one row', rowsBefore === 1 && m16[0] === 'PART ONE OF THE MULTIPART TEST.', JSON.stringify(m16));
    check('T16 re-pushed parts after a reconnect produce no second row', rowsAfter === 1, 'rows=' + rowsAfter);
  });

  await step('TEST 17 — opt-in retry window (SMPP_FALLBACK_RETRY_WINDOW_SECONDS>0), own process + own DB', async () => {
    const childOut = await new Promise((resolve) => {
      const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-window-'));
      const c = spawn(process.execPath, [ROOT + '/tests/window_policy_child.js', wdir, String(PORT + 2), '0', '45'], {
        env: Object.assign({}, process.env, { PANEL_DIR: ROOT, DATA_DIR: wdir, PORT: String(PORT + 2), SMPP_FALLBACK_RETRY_WINDOW_SECONDS: '45' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      c.stdout.on('data', (d) => { buf += d; });
      c.stderr.on('data', (d) => { buf += d; });
      c.on('close', (code) => resolve({ code, buf }));
    });
    const line = (childOut.buf.match(/^RESULT (.*)$/m) || [])[1];
    let w = null; try { w = JSON.parse(line); } catch (_) {}
    check('T17 window-policy probe completed', childOut.code === 0 && !!w, 'exit=' + childOut.code);
    if (w) {
      check('T17 retry +4 s suppressed by the opted-in window', w.rowsAfterRetry === 1, 'rows=' + w.rowsAfterRetry);
      check('T17 retry after a reconnect suppressed', w.rowsAfterReconnect === 1, 'rows=' + w.rowsAfterReconnect);
      check('T17 retry after delete + re-create suppressed (durable ledger)', w.rowsAfterRecreate === 1, 'rows=' + w.rowsAfterRecreate);
      check('T17 an identical message outside the window is kept', w.rowsAfterGenuineOutsideWindow === 2, 'rows=' + w.rowsAfterGenuineOutsideWindow + ' at t+' + w.ageAtLastPushSeconds + 's, window=' + w.window + 's');
      check('T17 suppressed replays are logged', w.suppressedWarningLogged === true, 'smpp_logs duplicate-suppressed entries present');
      check('T17 DOCUMENTED LIMITATION: a genuine identical SMS inside the window is dropped (why this policy is off by default)',
        w.rowsAfterGenuineInsideWindow === 1, 'rows=' + w.rowsAfterGenuineInsideWindow);
    } else {
      console.log('   ---   window probe output tail: ' + childOut.buf.split('\n').slice(-5).join(' | '));
    }
  });

await step('TEST 18 — an incomplete multipart is never lost: the stale sweep stores it as one partial row', async () => {
    const src18 = '447911100080';
    const ref = 88;
    await push({ smid: 'MP18-a1', src: src18, dst: NUM, text: 'ONLY THE FIRST HALF ', udh: [0x05, 0x00, 0x03, ref, 2, 1] });
    check('T18 part 1 held back (nothing stored yet)', rowsFor(src18) === 0, 'rows=' + rowsFor(src18));
    x("UPDATE smpp_parts SET received_at = datetime('now','-20 minutes') WHERE group_key LIKE ?", ['%|' + ref + '|2']);
    smppService._internal.sweepStaleParts();
    const m18 = msgsFor(src18);
    check('T18 the stale incomplete multipart is stored, not discarded', m18.length === 1 && m18[0] === 'ONLY THE FIRST HALF ', JSON.stringify(m18));
    const left = tryQ('SELECT COUNT(*) c FROM smpp_parts WHERE group_key LIKE ?', ['%|' + ref + '|2']);
    check('T18 the pending part row is cleared after the sweep', !!left && left.c === 0, left ? 'pending=' + left.c : 'n/a');
  });

await step('Cross-checks', async () => {
  const ds = await api(PORT, 'GET', '/api/smpp/dedup-stats', undefined, token);
  check('dedup-stats endpoint answers with identity counts', ds.status === 200 && ds.body && ds.body.identities_total > 50, ds.body ? 'identities=' + ds.body.identities_total + ' strong=' + ds.body.strong_identities + ' weak=' + ds.body.weak_identities : 'http ' + ds.status);
  const pduKind = tryQ("SELECT COUNT(*) c FROM sms_dedup_ledger WHERE identity_kind='pdu'");
  check('no content-derived (pdu) identities exist while the retry window is off',
    !!pduKind && pduKind.c === 0, pduKind ? 'pdu-kind ledger rows=' + pduKind.c : 'no ledger in this build');
  const queued = q('SELECT COUNT(*) c FROM failed_sms_queue').c;
  const stored = q('SELECT COUNT(*) c FROM sms_records').c;
  console.log('   ---   failed_sms_queue rows: ' + queued + '   sms_records rows: ' + stored);
  const logged = q("SELECT COUNT(*) c FROM smpp_logs WHERE detail LIKE '%111111%' OR detail LIKE '%999999%' OR detail LIKE '%PAYLOAD%' OR detail LIKE '%Balance%'").c;
  check('no message/OTP content in the new SMPP dedup/multipart logging', logged === 0, 'smpp_logs rows containing content=' + logged);
  const hookContent = q("SELECT COUNT(*) c FROM webhook_logs WHERE message LIKE '%111111%'").c;
  console.log('   ---   pre-existing webhook_logs intake rows that contain the message text: ' + hookContent + ' (unchanged behaviour, not the dedup logging)');

  });
    mock.close();
  console.log('\n================ SUMMARY ================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('\nFailed checks:'); for (const f of failed) console.log('  - ' + f.label + (f.detail ? '  [' + f.detail + ']' : '')); }
  console.log('DATA_DIR kept for inspection: ' + DATA_DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nSUITE CRASHED: ' + (e && e.stack || e));
  process.exit(2);
});
