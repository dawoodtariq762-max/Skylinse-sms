/**
 * Event-loop block detector + slow-request logger (DIAGNOSTIC).
 * ============================================================================
 * WHY THIS EXISTS
 *   The Management Panel appears to make the whole application unavailable.
 *   better-sqlite3 is SYNCHRONOUS, so any single slow query blocks the entire
 *   Node event loop — every other request on the server stalls, the reverse
 *   proxy eventually returns 504, and the app looks "down" even though no
 *   process crashed. That makes the failure invisible to ordinary error logs:
 *   there is no exception, just a very long silence.
 *
 *   This module answers the only question that matters:
 *       "WHICH request was holding the event loop when the freeze happened?"
 *
 * WHAT IT DOES
 *   1. An event-loop lag monitor ticks every BLOCKMON_TICK_MS (default 1000).
 *      If the observed tick is late by more than BLOCKMON_WARN_MS (default 500),
 *      it logs `[BLOCKED] lag=<ms> inflight=<urls>` — the URLs that were being
 *      served at that moment are the suspects.
 *   2. A request logger records every request's wall-clock duration. Anything
 *      slower than BLOCKMON_SLOW_MS (default 1000) is logged as
 *      `[SLOW_REQUEST] <ms> <method> <url>`.
 *
 * SAFETY / OVERHEAD
 *   - Purely observational. It never modifies, rejects or delays a request.
 *   - One unref'd timer plus two timestamps per request. Negligible cost.
 *   - Disabled entirely unless BLOCKMON=1 is set in the environment, so it is
 *     inert by default and can be switched on only while diagnosing.
 *
 * ENABLE
 *   Add BLOCKMON=1 to the PM2 app env (or export it before starting), restart,
 *   reproduce the freeze, then read the log:
 *
 *     pm2 logs powerx-api --lines 2000 --nostream | grep -E 'BLOCKED|SLOW_REQUEST'
 *
 *   The last URL printed before a large `[BLOCKED] lag=...` is the culprit.
 * ============================================================================
 */
'use strict';

const TICK_MS = Math.max(200, parseInt(process.env.BLOCKMON_TICK_MS || '1000', 10) || 1000);
const WARN_MS = Math.max(100, parseInt(process.env.BLOCKMON_WARN_MS || '500', 10) || 500);
const SLOW_MS = Math.max(100, parseInt(process.env.BLOCKMON_SLOW_MS || '1000', 10) || 1000);
const ENABLED = String(process.env.BLOCKMON || '0') === '1';

/* Requests currently in flight, so a lag spike can be attributed to a URL. */
const inflight = new Map();
let reqSeq = 0;

/** Express middleware: time every request and track what is in flight. */
function requestTracker(req, res, next) {
  if (!ENABLED) return next();
  const id = ++reqSeq;
  const started = process.hrtime.bigint();
  const label = `${req.method} ${req.originalUrl || req.url}`;
  inflight.set(id, { label, started });

  res.on('finish', () => {
    inflight.delete(id);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= SLOW_MS) console.warn(`[SLOW_REQUEST] ${ms.toFixed(0)}ms ${label}`);
  });
  res.on('close', () => inflight.delete(id));
  return next();
}

/** Start the lag monitor. Call once, after the server is wired up. */
function startLagMonitor(logger = console) {
  if (!ENABLED) return null;
  let last = process.hrtime.bigint();
  let worst = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Number(now - last) / 1e6 - TICK_MS;
    last = now;
    if (lag < WARN_MS) return;
    if (lag > worst) worst = Math.round(lag);
    const urls = [];
    for (const v of inflight.values()) {
      const held = Number(now - v.started) / 1e6;
      urls.push(`${v.label} (held ${held.toFixed(0)}ms)`);
    }
    logger.warn(
      `[BLOCKED] lag=${lag.toFixed(0)}ms worst=${worst}ms ` +
      (urls.length ? `inflight=[${urls.join(' | ')}]` : 'inflight=[none — blocked outside a request, e.g. a timer/backup/job]')
    );
  }, TICK_MS);
  if (timer.unref) timer.unref();
  logger.log(`• blockMonitor active (tick=${TICK_MS}ms warn=${WARN_MS}ms slow=${SLOW_MS}ms)`);
  return timer;
}

module.exports = { requestTracker, startLagMonitor, ENABLED };
