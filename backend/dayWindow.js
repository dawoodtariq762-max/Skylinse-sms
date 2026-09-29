/**
 * Day windows for carrier SMS statistics — UTC only.
 * ===========================================================================
 * The carrier (and the reference panel) works on UTC days: its CDR timestamps
 * are UTC and its dashboard day boundary is 00:00 UTC. The panel used to bucket
 * SMS counts by Europe/London, so "Today" disagreed with the carrier by up to
 * one hour of traffic and the displayed (UTC) timestamps did not match the
 * counting window.
 *
 * These helpers are used ONLY for SMS counting/reporting. Payout/payment
 * schedules keep their existing UK calendar logic — nothing here touches
 * payments.
 *
 * received_at itself is unchanged: it stays UTC exactly as stored.
 * ===========================================================================
 */
'use strict';

const DAY_MS = 86400000;

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' of a Date in UTC. */
function utcDateStr(d = new Date()) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** UTC calendar date, offset by whole days (0 = today). */
function utcDayString(offsetDays = 0, now = new Date()) {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays);
  return utcDateStr(new Date(base));
}

/** Add whole days to a 'YYYY-MM-DD' string. */
function utcDateAdd(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return utcDateStr(new Date(Date.UTC(y, m - 1, d + days)));
}

/**
 * Bucket date for a stored UTC timestamp ('YYYY-MM-DD HH:MM:SS' or ISO).
 * Empty/invalid → today's UTC date (same fallback the old helper used).
 */
function statDateUtc(ts) {
  try {
    if (!ts) return utcDayString(0);
    const m = String(ts).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return utcDayString(0);
    return `${m[1]}-${m[2]}-${m[3]}`;
  } catch (_) { return utcDayString(0); }
}

/** WHERE fragment: column inside the UTC day `dateStr` (spanning `days` days). */
function utcDayRangeSql(column, dateStr, days = 1) {
  const start = `${dateStr} 00:00:00`;
  const end = `${utcDateAdd(dateStr, days)} 00:00:00`;
  return `${column} >= '${start}' AND ${column} < '${end}'`;
}

/** WHERE fragment: column on the UTC day `offsetDays` from today. */
function utcDayOffsetSql(column, offsetDays = 0) {
  return utcDayRangeSql(column, utcDayString(offsetDays), 1);
}

/**
 * WHERE fragment: last `n` UTC days including today.
 * Lower bound only, matching the previous behaviour for rows dated in the
 * future (clock skew / provider-supplied timestamps).
 */
function utcLastDaysSql(column, n) {
  return `${column} >= '${utcDayString(-(n - 1))} 00:00:00'`;
}

/** WHERE fragment: current UTC calendar month. */
function utcThisMonthSql(column) {
  const today = utcDayString(0);
  const first = today.slice(0, 7) + '-01';
  const [y, m] = first.split('-').map(Number);
  const firstNext = utcDateStr(new Date(Date.UTC(y, m, 1)));
  return `${column} >= '${first} 00:00:00' AND ${column} < '${firstNext} 00:00:00'`;
}

/** Milliseconds of the UTC instant a UTC date begins (for range APIs). */
function utcMsFromDay(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

module.exports = {
  DAY_MS,
  utcDateStr,
  utcDayString,
  utcDateAdd,
  statDateUtc,
  utcDayRangeSql,
  utcDayOffsetSql,
  utcLastDaysSql,
  utcThisMonthSql,
  utcMsFromDay,
};
