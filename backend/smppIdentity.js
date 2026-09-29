/**
 * SMPP physical-message identity helpers
 * ===========================================================================
 * Pure functions only: no DB, no sockets, no timers. They answer one question
 * for every inbound PDU:
 *
 *     "What is the strongest DURABLE identity of this physical SMS?"
 *
 * Why this file exists
 * --------------------
 * `smpp@0.6.0-rc.4` parses a deliver_sm into known fields and silently drops
 * everything else — including any vendor TLV or non-standard field a carrier
 * may use to carry a per-message id. The library also exposes UDH elements as
 * raw Buffers, while the old reassembly code expected `{id, value}` objects.
 * Both facts are handled here, against the RAW PDU bytes.
 *
 * Identity strength (see smpp-fix-plan.md §3):
 *   tlv:<tag> / mid:<value>  — SMSC-provided durable id. A retry carries the
 *                              same value; a genuinely new SMS does not.
 *   mp:<hash>                — multipart part, derived from the UDH concat IE
 *                              (structure + part content), window-scoped.
 *   pdu:<hash>               — canonical body hash, WEAK: it cannot tell a
 *                              retry from a genuine identical resend. Only
 *                              used when explicitly enabled.
 * ===========================================================================
 */
'use strict';

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * Raw PDU parsing
 * ------------------------------------------------------------------ */

// Body layouts up to the point where TLVs start. 'sm' consumes sm_length
// bytes that were read by the preceding 'u8' (sm_length).
const LAYOUT_DELIVER_SUBMIT = ['cstr', 'u8', 'u8', 'cstr', 'u8', 'u8', 'cstr',
  'u8', 'u8', 'u8', 'cstr', 'cstr', 'u8', 'u8', 'u8', 'u8', 'u8', 'sm'];
const LAYOUT_DATA_SM = ['cstr', 'u8', 'u8', 'cstr', 'u8', 'u8', 'cstr', 'u8', 'u8', 'u8'];

const COMMANDS = {
  0x00000004: { name: 'submit_sm', layout: LAYOUT_DELIVER_SUBMIT },
  0x00000005: { name: 'deliver_sm', layout: LAYOUT_DELIVER_SUBMIT },
  0x00000015: { name: 'data_sm', layout: LAYOUT_DATA_SM },
};

function cstringAt(buf, off) {
  if (off >= buf.length) return null;
  const end = buf.indexOf(0, off);
  if (end < 0) return null;
  return { value: buf.subarray(off, end).toString('utf8'), next: end + 1 };
}

/**
 * Parse the fixed parameters and the TLV region of a raw PDU.
 * Returns null when the buffer is not a PDU we understand.
 */
function parseRawPdu(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 16) return null;
  const commandLength = raw.readUInt32BE(0);
  if (commandLength < 16 || commandLength > raw.length) return null;
  const commandId = raw.readUInt32BE(4);
  const sequence = raw.readUInt32BE(12);
  const body = raw.subarray(16, commandLength);
  const spec = COMMANDS[commandId];
  if (!spec) return { commandId, sequence, body, known: false, tlvs: [], appendedId: null, trailingHex: '', tlvOk: false };

  let i = 0;
  let smLength = 0;
  let cstrSeen = 0;
  const fixed = { serviceType: '', sourceAddrTon: 0, sourceAddrNpi: 0, sourceAddr: '',
    destAddrTon: 0, destAddrNpi: 0, destinationAddr: '', esmClass: 0, protocolId: 0,
    priorityFlag: 0, shortMessage: '' };
  for (const p of spec.layout) {
    if (p === 'cstr') {
      const cs = cstringAt(body, i);
      if (!cs) return { commandId, sequence, body, known: true, tlvs: [], appendedId: null, trailingHex: '', tlvOk: false, malformed: true };
      if (cstrSeen === 0) fixed.serviceType = cs.value;
      else if (cstrSeen === 1) fixed.sourceAddr = cs.value;
      else if (cstrSeen === 2) fixed.destinationAddr = cs.value;
      cstrSeen += 1;
      i = cs.next;
    } else if (p === 'u8') {
      if (i >= body.length) return { commandId, sequence, body, known: true, tlvs: [], appendedId: null, trailingHex: '', tlvOk: false, malformed: true };
      // sm_length is the byte read immediately before the short_message field
      smLength = body[i];
      i += 1;
    } else if (p === 'sm') {
      if (i + smLength > body.length) return { commandId, sequence, body, known: true, tlvs: [], appendedId: null, trailingHex: '', tlvOk: false, malformed: true };
      fixed.shortMessage = body.subarray(i, i + smLength).toString('latin1');
      i += smLength;
    }
  }

  const out = { commandId, sequence, command: spec.name, body, known: true, tlvStart: i, tlvs: [], appendedId: null, tlvOk: true };
  out.serviceType = fixed.serviceType;
  out.sourceAddr = fixed.sourceAddr;
  out.destinationAddr = fixed.destinationAddr;
  out.esmClass = body.length >= 16 ? 0 : 0;   // filled below for deliver_sm/submit_sm
  out.shortMessage = fixed.shortMessage;
  out.smLength = fixed.shortMessage.length;
  out.trailingHex = body.subarray(i, Math.min(i + 64, body.length)).toString('hex');

  // esm_class sits after destination_addr in this layout (off by construction for
  // data_sm, which has no sm_length/short_message); re-walk the small prefix.
  if (spec.layout === LAYOUT_DELIVER_SUBMIT) {
    let k = 0;
    for (const p of ['cstr', 'u8', 'u8', 'cstr', 'u8', 'u8', 'cstr']) {
      if (p === 'cstr') { const cs = cstringAt(body, k); if (!cs) break; k = cs.next; }
      else k += 1;
    }
    if (k < body.length) out.esmClass = body[k];
  }

  // Walk TLVs (tag 2 bytes, length 2 bytes, value).
  let j = i;
  let parsedAny = false;
  while (j + 4 <= body.length) {
    const tag = body.readUInt16BE(j);
    const len = body.readUInt16BE(j + 2);
    if (j + 4 + len > body.length) { out.tlvOk = false; break; }
    out.tlvs.push({ tag, value: body.subarray(j + 4, j + 4 + len) });
    parsedAny = true;
    j += 4 + len;
  }
  if (j !== body.length) out.tlvOk = false;

  // Non-standard appended C-Octet String "message_id" (some SMSCs do this even
  // though SMPP 3.4 does not define message_id for deliver_sm). Only accepted
  // when the remainder parses cleanly as TLVs and the value looks like an id.
  if (!parsedAny && body.length > i) {
    const cs = cstringAt(body, i);
    if (cs && cs.next <= body.length && looksLikeMessageId(cs.value)) {
      let k = cs.next, ok = true;
      const extra = [];
      while (k + 4 <= body.length) {
        const tag = body.readUInt16BE(k);
        const len = body.readUInt16BE(k + 2);
        if (k + 4 + len > body.length) { ok = false; break; }
        extra.push({ tag, value: body.subarray(k + 4, k + 4 + len) });
        k += 4 + len;
      }
      if (ok && k === body.length) {
        out.appendedId = cs.value;
        out.tlvs = extra;
        out.tlvOk = true;
      }
    }
  }
  return out;
}

/** Printable, bounded-length, id-shaped value (not a phone number, not text). */
function looksLikeMessageId(v) {
  const s = String(v || '').trim();
  if (s.length < 3 || s.length > 64) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(s)) return false;
  if (/^\d{7,}$/.test(s) && s.length >= 15) return false;   // MSISDN-like
  return true;
}

function tlvToString(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  // id TLVs are either ASCII/hex strings or raw bytes; prefer printable ASCII.
  const ascii = buf.toString('latin1').replace(/\0+$/, '');
  if (/^[\x20-\x7e]{1,64}$/.test(ascii)) return ascii.trim();
  return buf.toString('hex');
}

/**
 * Build the ordered identity candidate list for a parsed PDU.
 * cfg = { idTlvs: [0x001e], allowAppended: bool }
 */
function identityCandidates(parsed, cfg) {
  const out = [];
  if (!parsed || !parsed.known) return out;
  const tags = (cfg && cfg.idTlvs && cfg.idTlvs.length) ? cfg.idTlvs : [0x001e];
  for (const { tag, value } of parsed.tlvs || []) {
    if (!tags.includes(tag)) continue;
    const v = tlvToString(value);
    if (v) out.push({ kind: 'tlv:0x' + tag.toString(16).padStart(4, '0'), value: v, source: 'tlv' });
  }
  if (parsed.appendedId && (!cfg || cfg.allowAppended !== false)) {
    out.push({ kind: 'mid', value: parsed.appendedId, source: 'appended' });
  }
  return out;
}

/** Full canonical body (everything except the header/sequence) — used for the
 *  weak pdu:<hash> fallback and for retry evidence. Sequence number and
 *  command_status are excluded so a retried PDU hashes identically. */
function canonicalBodyHash(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 16) return '';
  const len = raw.readUInt32BE(0);
  const body = raw.subarray(16, Math.min(len, raw.length));
  return crypto.createHash('sha1').update(body).digest('hex');
}

/* ------------------------------------------------------------------ *
 * UDH / concatenation
 * ------------------------------------------------------------------ */

/**
 * Normalise whatever the library exposes as UDH into a list of information
 * elements: [{ iei, data: Buffer }].
 *
 * The installed library (smpp@0.6.0-rc.4, defs.js filters.message.decode)
 * returns `short_message.udh` as an array of Buffers, each starting with its
 * own IEI+length: [IEI][LEN][DATA…]. Older/other builds return objects with
 * {id, value}; both shapes are accepted.
 */
function decodeUdhElements(udh) {
  const out = [];
  if (!udh) return out;
  if (Buffer.isBuffer(udh)) return decodeUdhBytes(udh);
  if (Array.isArray(udh)) {
    for (const el of udh) {
      if (Buffer.isBuffer(el)) { decodeUdhBytes(el).forEach(e => out.push(e)); continue; }
      if (el && typeof el === 'object') {
        const id = el.id !== undefined ? el.id : el.iei;
        const val = el.value !== undefined ? el.value : el.data;
        if (id === undefined || val === undefined) continue;
        const data = Buffer.isBuffer(val) ? val : Buffer.from(Array.isArray(val) ? val : []);
        out.push({ iei: Number(id) & 0xff, data });
      }
    }
  }
  return out;
}

/** Parse a raw UDH byte string: repeated [IEI][LEN][LEN bytes]. */
function decodeUdhBytes(buf) {
  const out = [];
  let i = 0;
  // Some SMSCs include the UDHL byte first; skip it when it matches.
  if (buf.length > 1 && buf[0] === buf.length - 1) i = 1;
  while (i + 2 <= buf.length) {
    const iei = buf[i];
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) break;
    out.push({ iei, data: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

/**
 * Concatenation info from decoded IEs.
 *   IEI 0x00 — 8-bit reference:  [ref][total][seq]
 *   IEI 0x08 — 16-bit reference: [refHi][refLo][total][seq]
 * Returns { iei, ref, total, seq } or null.
 */
function concatInfo(elements) {
  for (const el of elements || []) {
    const d = el.data || Buffer.alloc(0);
    if (el.iei === 0x00 && d.length >= 3) {
      return { iei: 0x00, ref: d[0], total: d[1], seq: d[2] };
    }
    if (el.iei === 0x08 && d.length >= 4) {
      return { iei: 0x08, ref: d.readUInt16BE(0), total: d[2], seq: d[3] };
    }
  }
  return null;
}

/** UDH presence/type summary for logging (no message content). */
function udhSummary(elements) {
  if (!elements || !elements.length) return '';
  return elements.map(e => '0x' + e.iei.toString(16).padStart(2, '0') + ':' + (e.data ? e.data.length : 0)).join(',');
}

/* ------------------------------------------------------------------ *
 * Identity construction
 * ------------------------------------------------------------------ */

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

/** Identity for a single multipart part: structure + that part's content. */
function multipartPartIdentity(connectionUid, src, dst, info, text) {
  return 'mp:' + sha1([connectionUid, src, dst, info.ref, info.total, info.seq, text].join('|')).slice(0, 40);
}

/** Identity for a completed multipart message, from its parts. */
function multipartMessageIdentity(connectionUid, src, dst, info, texts) {
  return 'mpc:' + sha1([connectionUid, src, dst, info.ref, info.total, texts.join('\u0000')].join('|')).slice(0, 40);
}

/** Weak fallback identity (canonical body). Never written to sms_records. */
function weakPduIdentity(connectionUid, rawBuffer) {
  const h = canonicalBodyHash(rawBuffer);
  return h ? 'pdu:' + sha1(connectionUid + '|' + h).slice(0, 40) : '';
}

/** Stable identity of an SMSC account/connection, independent of the row id. */
function connectionUidOf(conn) {
  const host = String((conn && conn.host) || '').trim().toLowerCase();
  const port = String((conn && conn.port) || '').trim();
  const sys = String((conn && conn.system_id) || '').trim().toLowerCase();
  if (!host && !sys) return '';
  return 'smpp:' + sha1([host, port, sys].join('|')).slice(0, 32);
}

/** A provider/API-side identity, kept in a separate namespace by default. */
function apiIdentity(provider, ref) {
  return 'api:' + sha1(String(provider || '') + '|' + String(ref || '')).slice(0, 40);
}

/**
 * Content-suppression policy (tier 3). Pure function so it can be unit-tested.
 *
 * The panel is LOSSLESS by default: a message is never suppressed because the
 * sender, destination and body look identical. A content+time window is only
 * honoured when the operator BOTH configures a window AND explicitly arms it
 * with SMPP_ALLOW_CONTENT_SUPPRESSION=1 — so a forgotten env var can never
 * enable content-based suppression in production.
 */
function contentSuppressionPolicy(env) {
  const e = env || process.env || {};
  const requested = Math.max(0, parseInt(e.SMPP_FALLBACK_RETRY_WINDOW_SECONDS || '0', 10) || 0);
  const armed = String(e.SMPP_ALLOW_CONTENT_SUPPRESSION || '0') === '1';
  return { requested, armed, window: armed ? requested : 0, enabled: !!(armed && requested > 0) };
}

module.exports = {
  parseRawPdu,
  identityCandidates,
  tlvToString,
  looksLikeMessageId,
  canonicalBodyHash,
  decodeUdhElements,
  decodeUdhBytes,
  concatInfo,
  udhSummary,
  multipartPartIdentity,
  multipartMessageIdentity,
  weakPduIdentity,
  connectionUidOf,
  apiIdentity,
  contentSuppressionPolicy,
  sha1,
};
