'use strict';
/**
 * TEST 4 — full process restart.
 *
 * Booted by tests/e2e_mock_smsc.js with the SAME DATA_DIR (the real SQLite file,
 * not memory) as a brand-new node process, in a different host timezone
 * (Asia/Karachi) to prove the day maths does not follow the host zone.
 *
 * It re-creates the same SMSC account (same host/port/system_id) and waits for
 * the parent's mock SMSC to push the very SMS that the previous process already
 * stored. The durable ledger must recognise it across the restart.
 *
 * argv: DATA_DIR, HTTP_PORT, MOCK_PORT, EXPECTED_CONNECTION_UID, SEEN_COUNT_BEFORE
 */
const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
const [DATA_DIR, PORT, MOCK_PORT, EXPECTED_UID, SEEN_BEFORE] = process.argv.slice(2);

process.env.TZ = 'Asia/Karachi';
process.env.DATA_DIR = DATA_DIR;
process.env.POWERX_ROLE = 'api';
process.env.PORT = String(PORT);
process.env.SMPP_ENABLED = 'true';
process.env.PAYMENT_LEDGER_BACKFILL_ON_STARTUP = 'false';

const { bootPanel, api, login, sleep, waitReady } = require('./lib/mock_smsc');
const { db, smppService } = bootPanel({});
const dayWindow = require(ROOT + '/backend/dayWindow');

const cli = '447911100001';

(async () => {
  await waitReady(db, 30000);
  const token = await login(PORT);

  const r = await api(PORT, 'POST', '/api/smpp/connections', {
    name: 'E2E SMSC (restart)', mode: 'client', active: true,
    host: '127.0.0.1', port: Number(MOCK_PORT), system_id: 'e2e-sys', password: 'e2e-pass',
    bind_type: 'transceiver', enquire_link_seconds: 30,
  }, token);
  if (r.status !== 200) throw new Error('create failed: ' + r.status + ' ' + r.raw.slice(0, 200));
  const conn = r.body.connection;
  const sameUid = conn.connection_uid === EXPECTED_UID;

  const connId = conn.id;
  let bound = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const st = smppService.statusOf(connId);
    if (st && st.status === 'bound') { bound = true; break; }
    await sleep(100);
  }

  // Tell the parent we are bound; it pushes the redelivery into THIS session.
  console.log('READY ' + JSON.stringify({ connId, connection_uid: conn.connection_uid, bound, sameUid }));

  const seenBefore = Number(SEEN_BEFORE || 0);
  let seenCount = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    try {
      const row = db.get('SELECT seen_count FROM sms_dedup_ledger WHERE sms_record_id=(SELECT id FROM sms_records WHERE cli=? LIMIT 1)', [cli]);
      if (row) { seenCount = row.seen_count; if (row.seen_count > seenBefore) break; }
    } catch (_) { /* pre-fix build: no ledger table at all */ }
    await sleep(150);
  }

  await sleep(300); // let any (wrong) insert settle before counting

  const rowsForA = db.get('SELECT COUNT(*) c FROM sms_records WHERE cli=?', [cli]).c;
  const utcDayMatchesClock = dayWindow.utcDayString(0) === new Date().toISOString().slice(0, 10);
  const statsUtcDay = db.get("SELECT COUNT(*) c FROM sms_daily_stats WHERE stat_date = date('now')").c > 0;
  const ledgerPresent = !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_dedup_ledger'");

  console.log('RESULT ' + JSON.stringify({
    sameUid,
    bound,
    rowsForA,
    suppressed: rowsForA === 1 && (seenCount === null ? true : seenCount > seenBefore),
    ledgerPresent,
    seenBefore,
    seenCount,
    utcDayMatchesClock,
    statsUtcDay,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  process.exit(0);
})().catch((e) => {
  console.error('restart child failed: ' + (e && e.stack || e));
  process.exit(1);
});
