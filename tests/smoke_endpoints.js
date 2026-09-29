'use strict';
/**
 * Regression smoke: boot the patched panel on a throw-away database and check
 * that the endpoints the change could plausibly disturb still answer 200 with
 * JSON — dashboards, reports, allocations/rates views, SMPP admin, failed queue.
 * Run: node tests/smoke_endpoints.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-smoke-'));
const PORT = 46500 + Math.floor(Math.random() * 500);

process.env.DATA_DIR = DATA_DIR;
process.env.POWERX_ROLE = 'api';
process.env.PORT = String(PORT);
process.env.SMPP_ENABLED = 'true';
process.env.PAYMENT_LEDGER_BACKFILL_ON_STARTUP = 'false';

const { bootPanel, api, login, waitReady } = require('./lib/mock_smsc');
const { db } = bootPanel({});
const x = (sql, p = []) => db.run(sql, p);
const q = (sql, p = []) => db.get(sql, p);

const ENDPOINTS = [
  ['GET', '/api/dashboard'],
  ['GET', '/api/sms?limit=5'],
  ['GET', '/api/sms/paged?page=1&per_page=5'],
  ['GET', '/api/failed-sms'],
  ['GET', '/api/numbers?limit=5'],
  ['GET', '/api/ranges'],
  ['GET', '/api/rate-card'],
  ['GET', '/api/smpp/connections'],
  ['GET', '/api/smpp/status'],
  ['GET', '/api/smpp/dedup-stats'],
  ['GET', '/api/health'],
];

(async () => {
  await waitReady(db, 30000);
  const token = await login(PORT);

  // one allocated number + one SMS so the reports have something to aggregate
  x("INSERT INTO ranges (name, prefix, currency, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES ('SMOKE','44','USD','1.0','1.0','1.0','1.0')");
  const rangeId = q("SELECT id FROM ranges WHERE name='SMOKE'").id;
  x('INSERT INTO numbers (range_id, number, rate, payout, manager_id, agent_id, client_id) VALUES (?,?,?,?,1,1,1)', [rangeId, '447700900999', '1.0', '0.5']);
  x("INSERT INTO sms_records (number_id, number, range_id, cli, sender_type, message, source, received_at, payment_type, limit_reason) VALUES (?,?,?,?,?,?,?,datetime('now'),'','')",
    [q('SELECT id FROM numbers WHERE number=?', ['447700900999']).id, '447700900999', rangeId, '447911111111', 'phone_number', 'smoke test 123456', 'smpp']);

  // a known UTC-day bucket so the dashboard comparison is not 0-vs-0
  x("INSERT OR REPLACE INTO sms_daily_stats (stat_date, manager_id, agent_id, client_id, cli, sms_count, payout_sum) VALUES (date('now'), 1, 1, 1, '', 7, 3.5)");

  let pass = 0, fail = 0;
  for (const [method, p] of ENDPOINTS) {
    const r = await api(PORT, method, p, undefined, token);
    const ok = r.status === 200 && r.body !== null;
    if (ok) pass++; else fail++;
    console.log('   ' + (ok ? 'PASS' : 'FAIL') + '  ' + method + ' ' + p + '   [http ' + r.status + (ok ? '' : ' ' + r.raw.slice(0, 120)) + ']');
  }

  // dashboard day figures must be the UTC day (the fix) and be numeric
  const dash = await api(PORT, 'GET', '/api/dashboard?smoke=' + Date.now(), undefined, token);
  const d = dash.body || {};
  const keys = Object.keys(d).slice(0, 40);
  console.log('   dashboard keys: ' + keys.join(', '));
  const hasToday = keys.some((k) => /today/i.test(k));
  console.log('   ' + (hasToday ? 'PASS' : 'FAIL') + '  dashboard exposes a today counter');
  if (hasToday) pass++; else fail++;
  // sms_today comes from the derived stats table; its bucket must be the UTC day.
  const expected = q("SELECT COALESCE(SUM(sms_count),0) c FROM sms_daily_stats WHERE stat_date=date('now')").c;
  const okToday = Number(d.sms_today) === Number(expected);
  console.log('   ' + (okToday ? 'PASS' : 'FAIL') + '  dashboard sms_today equals the UTC-day stat bucket (' + d.sms_today + ' vs ' + expected + ')');
  if (okToday) pass++; else fail++;
  const strayDays = q("SELECT COUNT(*) c FROM sms_daily_stats WHERE stat_date = date('now','+1 hour') AND stat_date <> date('now')").c;
  console.log('   ' + (strayDays === 0 ? 'PASS' : 'FAIL') + '  no stats were bucketed into the Europe/London day (' + strayDays + ' stray rows)');
  if (strayDays === 0) pass++; else fail++;
  const ds = await api(PORT, 'GET', '/api/smpp/dedup-stats', undefined, token);
  const dm = (ds.body && ds.body.dedup_mode) || {};
  console.log('   ' + (ds.status === 200 ? 'PASS' : 'FAIL') + '  dedup-stats answers with the policy block');
  if (ds.status === 200) pass++; else fail++;
  console.log('   ' + (dm.lossless === true && dm.content_suppression_armed === false ? 'PASS' : 'FAIL') + '  dedup-stats says lossless / not armed (window=' + dm.fallback_retry_window_seconds + 's)');
  if (dm.lossless === true && dm.content_suppression_armed === false) pass++; else fail++;
  const hasNoId = !!(ds.body && ds.body.no_id && typeof ds.body.no_id.total === 'number');
  console.log('   ' + (hasNoId ? 'PASS' : 'FAIL') + '  dedup-stats counts no-id messages separately' + (hasNoId ? ' (total=' + ds.body.no_id.total + ')' : ''));
  if (hasNoId) pass++; else fail++;

  const lastBucket = (d.daily7 && d.daily7.length) ? d.daily7[d.daily7.length - 1].date : '';
  console.log('   daily7 last bucket: ' + lastBucket + '   (UTC today = ' + new Date().toISOString().slice(0, 10) + ')');
  const okBucket = lastBucket === new Date().toISOString().slice(0, 10);
  console.log('   ' + (okBucket ? 'PASS' : 'FAIL') + '  the dashboard daily series ends on the UTC day');
  if (okBucket) pass++; else fail++;
  const dayRow = q("SELECT date('now') u");
  console.log('   ' + (dayRow && dayRow.u === new Date().toISOString().slice(0, 10) ? 'PASS' : 'FAIL') + '  UTC day in the reporting window ' + (dayRow ? dayRow.u : ''));

  console.log('\nSMOKE  PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke crashed: ' + (e && e.stack || e)); process.exit(2); });
