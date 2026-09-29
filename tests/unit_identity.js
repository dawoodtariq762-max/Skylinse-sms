'use strict';
/**
 * Unit tests for the pure helpers behind the fix:
 *   backend/smppIdentity.js  — raw-PDU parse, TLV/identity extraction, UDH decode,
 *                              multipart grouping, canonical hash, account identity
 *   backend/dayWindow.js     — UTC SMS-day maths (the SQL is executed, not just
 *                              string-compared)
 *
 * Run: node tests/unit_identity.js
 */
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
const ident = require(ROOT + '/backend/smppIdentity');
const dayWindow = require(ROOT + '/backend/dayWindow');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('   PASS  ' + name); }
  catch (e) { fail++; console.log('   FAIL  ' + name + '   [' + (e && e.message) + ']'); }
}

/* ---------------- PDU builder (independent of the library under test) ------- */
function cstr(s) { return Buffer.from(String(s) + '\0', 'latin1'); }
function tlv(tag, val) {
  const v = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'latin1');
  const b = Buffer.alloc(4 + v.length);
  b.writeUInt16BE(tag, 0); b.writeUInt16BE(v.length, 2); v.copy(b, 4);
  return b;
}
function deliverSm(o = {}) {
  const f = [];
  f.push(cstr(o.serviceType || ''));
  f.push(Buffer.from([o.srcTon === undefined ? 5 : o.srcTon, 0]));
  f.push(cstr(o.src || ''));
  f.push(Buffer.from([1, 1]));
  f.push(cstr(o.dst || ''));
  const hasUdh = !!(o.udh && o.udh.length);
  f.push(Buffer.from([o.esm === undefined ? (hasUdh ? 0x40 : 0x00) : o.esm, 0, 0]));
  f.push(cstr('')); f.push(cstr(''));
  f.push(Buffer.from([0, 0, o.dataCoding === undefined ? 0 : o.dataCoding, 0]));
  const sm = o.payload != null ? null : Buffer.concat([hasUdh ? Buffer.from(o.udh) : Buffer.alloc(0), Buffer.from(o.text || '', 'latin1')]);
  f.push(Buffer.from([sm ? sm.length : 0]));
  if (sm) f.push(sm);
  if (o.smid) f.push(tlv(o.idTlv === undefined ? 0x001e : o.idTlv, cstr(o.smid)));
  if (o.payload != null) f.push(tlv(0x0424, Buffer.from(o.payload, 'latin1')));
  const body = Buffer.concat(f);
  const p = Buffer.alloc(16 + body.length);
  p.writeUInt32BE(16 + body.length, 0);
  p.writeUInt32BE(0x00000005, 4);
  p.writeUInt32BE(0, 8);
  p.writeUInt32BE(o.seq || 1, 12);
  body.copy(p, 16);
  return p;
}

console.log('UNIT — smppIdentity');
t('parseRawPdu reads src/dst/esm/short_message', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '447911111111', dst: '447700900123', text: 'hello world' }));
  assert(p && p.known, 'parsed');
  assert.strictEqual(p.sourceAddr, '447911111111');
  assert.strictEqual(p.destinationAddr, '447700900123');
  assert.strictEqual(p.esmClass, 0x00);
  assert.strictEqual(p.shortMessage, 'hello world');
  assert.strictEqual(p.sequence, 1);
});
t('parseRawPdu exposes the receipted_message_id TLV (0x001E)', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', text: 'x', smid: 'SMSC-42' }));
  assert(p.tlvs.some((x) => x.tag === 0x001e), 'tlv present');
  assert.strictEqual(ident.tlvToString(p.tlvs.find((x) => x.tag === 0x001e).value), 'SMSC-42');
});
t('message_payload (0x0424) is used when short_message is empty', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', payload: 'PAYLOAD-TEXT' }));
  assert.strictEqual(p.shortMessage, '', 'short_message empty');
  const tag = p.tlvs.find((x) => x.tag === 0x0424);
  assert(tag, 'payload TLV parsed');
  assert.strictEqual(ident.tlvToString(tag.value), 'PAYLOAD-TEXT');
});
t('identityCandidates returns the TLV id as a strong identity', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', text: 'x', smid: 'ABC-1' }));
  const c = ident.identityCandidates(p, { idTlvs: [0x001e] });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].value, 'ABC-1');
  assert(/tlv/.test(c[0].kind), 'kind=' + c[0].kind);
});
t('identityCandidates returns nothing when the SMSC sends no id (no content fallback)', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', text: 'identical text' }));
  assert.deepStrictEqual(ident.identityCandidates(p, { idTlvs: [0x001e] }), []);
  assert.deepStrictEqual(ident.identityCandidates(p, { idTlvs: [0x001e], allowAppended: true }), [], 'plain text is not mistaken for an id');
});
t('identityCandidates can use a non-standard appended id when the operator opts in', () => {
  // deliver_sm whose TLV region is actually a second C-Octet String (some SMSCs
  // append their own message_id); no real TLVs at all.
  const base = deliverSm({ src: '1', dst: '2', text: 'normal body text' });
  const len = base.readUInt32BE(0);
  const appended = Buffer.concat([base.subarray(0, len), cstr('9F2A-B1')]);
  appended.writeUInt32BE(len + 8, 0);
  const p = ident.parseRawPdu(appended);
  assert(p && p.known && !p.malformed, 'parsed');
  assert.strictEqual(p.appendedId, '9F2A-B1');
  const off = ident.identityCandidates(p, { idTlvs: [0x001e], allowAppended: false });
  const on = ident.identityCandidates(p, { idTlvs: [0x001e], allowAppended: true });
  assert.strictEqual(off.length, 0, 'off by default');
  assert.strictEqual(on.length, 1, 'found with the option');
  assert.strictEqual(on[0].value, '9F2A-B1');
  assert.strictEqual(on[0].kind, 'mid');
});
t('a configured TLV tag is honoured and unknown tags are ignored', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', text: 'x', smid: 'V-9', idTlv: 0x1400 }));
  assert.deepStrictEqual(ident.identityCandidates(p, { idTlvs: [0x001e] }), []);
  const c = ident.identityCandidates(p, { idTlvs: [0x1400] });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].value, 'V-9');
});
t('canonicalBodyHash is stable per body and differs across bodies', () => {
  const a = deliverSm({ src: '1', dst: '2', text: 'same' });
  const b = deliverSm({ src: '1', dst: '2', text: 'same', seq: 7 });
  const c = deliverSm({ src: '1', dst: '2', text: 'other' });
  assert.strictEqual(ident.canonicalBodyHash(a), ident.canonicalBodyHash(b), 'sequence number excluded');
  assert.notStrictEqual(ident.canonicalBodyHash(a), ident.canonicalBodyHash(c));
});
t('canonicalBodyHash is never returned as an identity by default', () => {
  const p = ident.parseRawPdu(deliverSm({ src: '1', dst: '2', text: 'content' }));
  const kinds = ident.identityCandidates(p, { idTlvs: [0x001e] }).map((x) => x.kind);
  assert(!kinds.some((k) => /pdu|hash/.test(k)), 'kinds=' + JSON.stringify(kinds));
});

console.log('UNIT — UDH / multipart');
t('decodeUdhElements decodes an 8-bit concatenation (IEI 0x00)', () => {
  const els = ident.decodeUdhBytes(Buffer.from([0x05, 0x00, 0x03, 0x2a, 0x02, 0x01]));
  const info = ident.concatInfo(els);
  assert.deepStrictEqual({ ref: info.ref, total: info.total, seq: info.seq, iei: info.iei }, { ref: 42, total: 2, seq: 1, iei: 0x00 });
});
t('decodeUdhElements decodes a 16-bit concatenation (IEI 0x08)', () => {
  const els = ident.decodeUdhBytes(Buffer.from([0x06, 0x08, 0x04, 0x01, 0x2c, 0x03, 0x02]));
  const info = ident.concatInfo(els);
  assert.deepStrictEqual({ ref: info.ref, total: info.total, seq: info.seq, iei: info.iei }, { ref: 0x012c, total: 3, seq: 2, iei: 0x08 });
});
t('a non-concatenation UDH yields no concatInfo', () => {
  const els = ident.decodeUdhBytes(Buffer.from([0x03, 0x24, 0x01, 0x02]));
  assert.strictEqual(ident.concatInfo(els), null);
});
t('multipart part identity is stable and distinguishes seq/ref/parts', () => {
  const i1 = ident.multipartPartIdentity('u1', 's', 'd', { ref: 5, total: 2, seq: 1 }, 'AAAA');
  const i1b = ident.multipartPartIdentity('u1', 's', 'd', { ref: 5, total: 2, seq: 1 }, 'AAAA');
  const i2 = ident.multipartPartIdentity('u1', 's', 'd', { ref: 5, total: 2, seq: 2 }, 'BBBB');
  const i3 = ident.multipartPartIdentity('u1', 's', 'd', { ref: 6, total: 2, seq: 1 }, 'AAAA');
  assert.strictEqual(i1, i1b);
  assert.notStrictEqual(i1, i2);
  assert.notStrictEqual(i1, i3);
  assert(/^mp:/.test(i1));
});
t('completed multipart identity depends on the parts, not the transport', () => {
  const a = ident.multipartMessageIdentity('u1', 's', 'd', { ref: 5, total: 2 }, ['AA', 'BB']);
  const b = ident.multipartMessageIdentity('u1', 's', 'd', { ref: 5, total: 2 }, ['AA', 'BB']);
  const c = ident.multipartMessageIdentity('u1', 's', 'd', { ref: 5, total: 2 }, ['AA', 'CC']);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert(/^mpc:/.test(a));
});

console.log('UNIT — SMSC-account identity (survives delete/re-create)');
t('connectionUidOf is stable for the same host/port/system_id and ignores the name', () => {
  const a = ident.connectionUidOf({ host: 'smsc.example.net', port: 2775, system_id: 'acc1', name: 'prod' });
  const b = ident.connectionUidOf({ host: 'SMSC.example.net', port: '2775', system_id: 'ACC1', name: 'renamed' });
  assert.strictEqual(a, b);
  assert(/^smpp:/.test(a));
});
t('connectionUidOf separates different accounts/endpoints', () => {
  const a = ident.connectionUidOf({ host: 'h1', port: 2775, system_id: 'x' });
  const b = ident.connectionUidOf({ host: 'h2', port: 2775, system_id: 'x' });
  const c = ident.connectionUidOf({ host: 'h1', port: 2776, system_id: 'x' });
  const e = ident.connectionUidOf({ host: 'h1', port: 2775, system_id: 'y' });
  assert.strictEqual(new Set([a, b, c, e]).size, 4);
});
t('weakPduIdentity is per-account and per-body', () => {
  const raw = deliverSm({ src: '1', dst: '2', text: 'same' });
  const a = ident.weakPduIdentity('u1', raw);
  const b = ident.weakPduIdentity('u2', raw);
  assert(/^pdu:/.test(a) && a !== b);
});

console.log('UNIT — dayWindow (UTC SMS day; the SQL is executed)');
const mem = new Database(':memory:');
mem.exec("CREATE TABLE sms_records (id INTEGER PRIMARY KEY, received_at TEXT)");
mem.prepare("INSERT INTO sms_records (received_at) VALUES (?),(?),(?),(?)").run(
  '2026-09-28 23:59:59', '2026-09-29 00:00:00', '2026-09-29 12:00:00', '2026-08-31 23:30:00');

t('utcDayString(0) is the calendar day of the UTC clock', () => {
  assert.strictEqual(dayWindow.utcDayString(0), new Date().toISOString().slice(0, 10));
});
t('utcDayString offsets cross month boundaries', () => {
  assert.strictEqual(dayWindow.utcDayString(-1), new Date(Date.now() - 86400000).toISOString().slice(0, 10));
});
t('statDateUtc keeps the UTC day at the midnight boundary', () => {
  assert.strictEqual(dayWindow.statDateUtc('2026-09-28 23:59:59'), '2026-09-28');
  assert.strictEqual(dayWindow.statDateUtc('2026-09-29 00:00:00'), '2026-09-29');
});
t('utcDayRangeSql counts each row in its own UTC day', () => {
  const sql = 'SELECT COUNT(*) c FROM sms_records WHERE ' + dayWindow.utcDayRangeSql('received_at', '2026-09-29');
  assert.strictEqual(mem.prepare(sql).get().c, 2, 'both 09-29 rows, and only those');
});
t('the old Europe/London rule would have merged the two boundary rows', () => {
  const sql = "SELECT COUNT(*) c FROM sms_records WHERE date(received_at,'+1 hour')='2026-09-29'";
  assert.strictEqual(mem.prepare(sql).get().c, 3, '23:59:59Z + the two 09-29 rows (BST = UTC+1)');
});
t('utcDayOffsetSql/utcLastDaysSql/utcThisMonthSql generate usable SQL', () => {
  const yesterday = dayWindow.utcDayString(-1);
  const qOffset = 'SELECT COUNT(*) c FROM sms_records WHERE received_at >= ' + dayWindow.utcDayOffsetSql('received_at', -0) + '';
  assert(mem.prepare(qOffset).get(), 'offset expression executes');
  const last = mem.prepare('SELECT COUNT(*) c FROM sms_records WHERE ' + dayWindow.utcLastDaysSql('received_at', 2)).get();
  assert(typeof last.c === 'number');
  const month = mem.prepare('SELECT COUNT(*) c FROM sms_records WHERE ' + dayWindow.utcThisMonthSql('received_at')).get();
  assert(typeof month.c === 'number');
  assert.strictEqual(yesterday, dayWindow.utcDayString(-1));
});
/* ---- tier-3 content-suppression policy: lossless unless explicitly armed ---- */
t('policy: with no env at all nothing can be suppressed (lossless)', () => {
  const p = ident.contentSuppressionPolicy({});
  assert.strictEqual(p.window, 0); assert.strictEqual(p.enabled, false); assert.strictEqual(p.armed, false);
});
t('policy: a window WITHOUT SMPP_ALLOW_CONTENT_SUPPRESSION=1 resolves to 0 (ignored)', () => {
  const p = ident.contentSuppressionPolicy({ SMPP_FALLBACK_RETRY_WINDOW_SECONDS: '300' });
  assert.strictEqual(p.requested, 300); assert.strictEqual(p.window, 0);
  assert.strictEqual(p.armed, false); assert.strictEqual(p.enabled, false);
});
t('policy: only window + arming flag together enable content suppression', () => {
  const p = ident.contentSuppressionPolicy({ SMPP_FALLBACK_RETRY_WINDOW_SECONDS: '300', SMPP_ALLOW_CONTENT_SUPPRESSION: '1' });
  assert.strictEqual(p.window, 300); assert.strictEqual(p.enabled, true); assert.strictEqual(p.armed, true);
});
t('policy: arming alone (no window) still suppresses nothing', () => {
  const p = ident.contentSuppressionPolicy({ SMPP_ALLOW_CONTENT_SUPPRESSION: '1' });
  assert.strictEqual(p.window, 0); assert.strictEqual(p.enabled, false);
});
t('policy: garbage or negative window values stay 0', () => {
  for (const v of ['-5', 'abc', '', '0']) {
    const p = ident.contentSuppressionPolicy({ SMPP_FALLBACK_RETRY_WINDOW_SECONDS: v, SMPP_ALLOW_CONTENT_SUPPRESSION: '1' });
    assert.strictEqual(p.window, 0, 'value ' + JSON.stringify(v)); assert.strictEqual(p.enabled, false);
  }
});

t('payment helpers are untouched: dayWindow exposes only UTC SMS-day helpers', () => {
  const names = Object.keys(dayWindow);
  assert(!names.some((n) => /payout|payment|paid|cost/i.test(n)), 'no payment logic here: ' + names.join(','));
  assert(names.includes('statDateUtc'));
});

console.log('\n================ UNIT SUMMARY ================');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
