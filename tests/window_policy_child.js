'use strict';
/**
 * Opt-in retry-window policy probe (SMPP_FALLBACK_RETRY_WINDOW_SECONDS > 0).
 *
 * This is the OTHER side of the documented trade-off. It runs its own panel +
 * its own mock SMSC + its own throw-away database, with an SMSC that provides
 * NO message id and the operator's opted-in window set to 12 s, and measures
 * exactly what the operator gets:
 *
 *   - retry +4 s (same session)                    → 1 row
 *   - retry after a reconnect                      → 1 row
 *   - retry after delete + re-create of the account → 1 row
 *   - the SAME identical message 16 s later        → 2 rows (window expired)
 *   - LIMITATION: a genuine identical message 4 s later → suppressed (1 row)
 *
 * The last line is the reason this policy is OFF by default: it cannot tell a
 * retry from a genuine resend, so it can drop a legitimate SMS.
 *
 * argv: DATA_DIR, HTTP_PORT, MOCK_PORT_IGNORED(own), WINDOW_SECONDS
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
const WINDOW = Number(process.argv[5] || 45);
const DATA_DIR = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'panel-window-'));
const PORT = Number(process.argv[3] || 47151);

process.env.TZ = 'Europe/London';
process.env.DATA_DIR = DATA_DIR;
process.env.POWERX_ROLE = 'api';
process.env.PORT = String(PORT);
process.env.SMPP_ENABLED = 'true';
process.env.SMPP_FALLBACK_RETRY_WINDOW_SECONDS = String(WINDOW);
process.env.PAYMENT_LEDGER_BACKFILL_ON_STARTUP = 'false';

const { MockSmsc, bootPanel, api, login, sleep, waitReady } = require('./lib/mock_smsc');
const { db, smppService } = bootPanel({});
const NUM = '447700900123';
let seq = 1;

const q = (sql, p = []) => db.get(sql, p);
const x = (sql, p = []) => db.run(sql, p);

(async () => {
  await waitReady(db, 30000);
  const token = await login(PORT);

  x("INSERT INTO ranges (name, prefix, currency, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES ('W','44','USD','1.0','1.0','1.0','1.0')");
  const rangeId = q("SELECT id FROM ranges WHERE name='W'").id;
  x('INSERT INTO numbers (range_id, number, rate, payout, manager_id, agent_id, client_id) VALUES (?,?,?,?,1,1,1)', [rangeId, NUM, '1.0', '0.5']);

  const mock = new MockSmsc();
  const mockPort = await mock.listen();

  async function connect(name) {
    const r = await api(PORT, 'POST', '/api/smpp/connections', {
      name, mode: 'client', active: true, host: '127.0.0.1', port: mockPort,
      system_id: 'e2e-sys', password: 'e2e-pass', bind_type: 'transceiver', enquire_link_seconds: 30,
    }, token);
    if (r.status !== 200) throw new Error('create failed: ' + r.status);
    const id = r.body.connection.id;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const st = smppService.statusOf(id);
      if (st && st.status === 'bound') break;
      await sleep(100);
    }
    return id;
  }

  async function push(o) {
    const s = seq++;
    mock.deliver(Object.assign({ idTlv: 0 }, o, { seq: s }));
    const t0 = Date.now();
    for (;;) {
      const resp = mock.respFor(s);
      if (resp) return resp.status;
      if (Date.now() - t0 > 8000) return null;
      await sleep(20);
    }
  }

  const t0 = Date.now();
  const since = () => Date.now() - t0;
  const waitUntil = async (ms) => { const d = ms - since(); if (d > 0) await sleep(d); };

  let connId = await connect('W SMSC');
  const Z = { smid: 'W-1', src: '447955500001', dst: NUM, text: 'Your code is 707070' };
  const rows = () => q('SELECT COUNT(*) c FROM sms_records WHERE cli=?', [Z.src]).c;

  const r = {};
  await waitUntil(0);
  r.first = await push(Z);
  r.rowsAfterFirst = rows();

  await waitUntil(4000);                       // inside the window
  r.retry = await push(Z);
  r.rowsAfterRetry = rows();

  smppService.stopConnection(connId); await sleep(300); smppService.startConnection(connId);
  { const t = Date.now(); while (Date.now() - t < 10000) { const st = smppService.statusOf(connId); if (st && st.status === 'bound') break; await sleep(100); } }
  await waitUntil(9000);                       // inside the window
  r.retryAfterReconnect = await push(Z);
  r.rowsAfterReconnect = rows();

  await api(PORT, 'DELETE', '/api/smpp/connections/' + connId, undefined, token);
  connId = await connect('W SMSC 2');
  await waitUntil(14000);                      // inside the window, new connection row
  r.retryAfterRecreate = await push(Z);
  r.rowsAfterRecreate = rows();

  // documented LIMITATION: a *genuine* identical message inside the window
  await waitUntil(19000);
  r.genuineInsideWindow = await push({ smid: 'W-2', src: Z.src, dst: NUM, text: Z.text });
  r.rowsAfterGenuineInsideWindow = rows();

  // after the window expires the identical message is kept
  await waitUntil(WINDOW * 1000 + 6000);
  r.genuineOutsideWindow = await push({ smid: 'W-3', src: Z.src, dst: NUM, text: Z.text });
  r.rowsAfterGenuineOutsideWindow = rows();
  r.window = WINDOW;
  r.ageAtLastPushSeconds = Math.round(since() / 1000);
  r.suppressedWarningLogged = !!q("SELECT id FROM smpp_logs WHERE detail LIKE '%duplicate suppressed%' LIMIT 1");

  console.log('RESULT ' + JSON.stringify(r));
  mock.close();
  process.exit(0);
})().catch((e) => {
  console.error('window probe failed: ' + (e && e.stack || e));
  process.exit(1);
});
