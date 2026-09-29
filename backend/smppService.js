/**
 * Power X SMS — SMPP Connection Service
 * ---------------------------------------------------------------------------
 * ADDITIONAL channel. It does not touch the existing HTTP integrations.
 *
 *   Existing (untouched):
 *     HTTP push  : provider -> POST/GET /api/incoming-sms
 *     HTTP pull  : providerSync.js -> provider REST API every N seconds
 *
 *   Added here:
 *     SMPP client : Power X binds OUT to a provider's SMPP server (ESME)
 *     SMPP server : Power X LISTENS, the carrier binds IN to us
 *
 * All three converge on the SAME ingestion function that the carrier webhook
 * already uses (processIncomingSmsPayload), so allocation, rate cards, OTP
 * extraction, payout rules, daily limits and panel scoping behave identically
 * no matter which channel an SMS arrived on. Nothing in that function was
 * changed for SMPP.
 *
 * DESIGN NOTES
 *
 *  - Isolation: every connection runs in its own state object. One bad
 *    connection can never take down another, and an SMPP failure can never
 *    reach the Express request path — every callback is wrapped.
 *
 *  - Lazy require: the `smpp` package is only loaded when a connection is
 *    actually started. If the dependency is missing the rest of the panel
 *    still boots normally; the SMPP screen simply reports it.
 *
 *  - Reconnect: exponential backoff with jitter, capped by
 *    max_reconnect_seconds. Reconnect timers are unref()'d so they never hold
 *    the process open.
 *
 *  - Deduplication: SMPP links redeliver on any missing response, so every
 *    inbound message is keyed. If the PDU carries a receipted_message_id we
 *    use it; otherwise a deterministic fingerprint of
 *    (src|dst|text|time-bucket) is used, exactly like the HTTP pull path.
 *
 *  - Concatenated (multipart) SMS are reassembled before ingestion, so a long
 *    OTP message is stored as one row and the OTP regex sees the whole text.
 *
 *  - Back-pressure: inbound handling is synchronous and cheap (one DB write
 *    via the shared better-sqlite3 layer). No queue is needed, and the event
 *    loop is never blocked by network waits.
 */

const db = require('./db');
const crypto = require('crypto');
const net = require('net');
const ident = require('./smppIdentity');

let smppLib = null;
let smppLoadError = '';
function getSmpp() {
  if (smppLib) return smppLib;
  try { smppLib = require('smpp'); }
  catch (e) { smppLoadError = e.message; throw new Error('SMPP library not installed: ' + e.message); }
  installRawPduCapture(smppLib);
  return smppLib;
}

/**
 * The library parses known fields and drops everything else, so a vendor TLV or
 * a non-standard appended message_id would be invisible to us. Keep the RAW
 * bytes of every inbound PDU on the object instead: the wrapping functions
 * reproduce the library's own 6-line implementations exactly (verified against
 * node_modules/smpp/lib/pdu.js:56-70) and add one property. Nothing about
 * parsing, framing or responses changes.
 */
function installRawPduCapture(smpp) {
  if (!smpp || smpp.__powerxRawCapture) return;
  const PDU = smpp.PDU;
  if (!PDU || typeof PDU.fromStream !== 'function') return;
  const origFromStream = PDU.fromStream;
  const origFromBuffer = PDU.fromBuffer;
  PDU.fromStream = function (stream, command_length) {
    const buffer = stream.read(command_length - 4);
    if (!buffer) return false;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(command_length, 0);
    const rawBuffer = Buffer.concat([head, buffer]);
    const pdu = new PDU(rawBuffer);
    try { pdu.__rawBuffer = rawBuffer; } catch (_) {}
    return pdu;
  };
  if (typeof origFromBuffer === 'function') {
    PDU.fromBuffer = function (buffer) {
      const pdu = new PDU(buffer);
      try { pdu.__rawBuffer = Buffer.from(buffer); } catch (_) {}
      return pdu;
    };
  }
  smpp.__powerxRawCapture = true;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function safeStr(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

/**
 * short_message arrives in several shapes depending on the peer and the
 * data_coding used: a plain string, a Buffer, or the library's decoded
 * { message, udh } object. Normalise all of them to text.
 */
function pduText(pdu) {
  const sm = pdu && pdu.short_message;
  let text = '';
  if (sm === null || sm === undefined || sm === '') text = '';
  else if (typeof sm === 'string') text = sm;
  else if (Buffer.isBuffer(sm)) text = sm.toString('utf8');
  else if (typeof sm === 'object') {
    if (typeof sm.message === 'string') text = sm.message;
    else if (Buffer.isBuffer(sm.message)) text = sm.message.toString('utf8');
    else text = '';
  } else text = safeStr(sm);

  // SMPP message_payload (0x0424): the library parses the TLV but leaves
  // short_message empty, and it exposes the payload as an OBJECT
  // ({message:"..."}) — the old fallback returned "" for it, so the body was
  // stored empty and two different payload messages collided on one dedup key.
  if (!String(text).length) {
    const pl = payloadText(pdu);
    if (pl) return pl;
  }
  return text;
}

/** Text carried in the message_payload TLV (0x0424), or '' when absent. */
function payloadText(pdu) {
  const pl = pdu && pdu.message_payload;
  if (pl === null || pl === undefined) return '';
  if (typeof pl === 'string') return pl;
  if (Buffer.isBuffer(pl)) return pl.toString('utf8');
  if (typeof pl === 'object') {
    if (typeof pl.message === 'string') return pl.message;
    if (Buffer.isBuffer(pl.message)) return pl.message.toString('utf8');
  }
  return '';
}

/** True when this PDU's body came from the message_payload TLV. */
function usesPayload(pdu) {
  try {
    if (payloadText(pdu) && !String((pdu && pdu.short_message) || '').length) {
      const sm = pdu && pdu.short_message;
      const smEmpty = sm === null || sm === undefined || sm === '' ||
        (typeof sm === 'object' && !Buffer.isBuffer(sm) && !String(sm.message || '').length);
      return !!smEmpty;
    }
  } catch (_) {}
  return false;
}

/**
 * UDH of a concatenated message, exactly as the library exposes it.
 * (smpp@0.6.0-rc.4 returns an array of Buffers — see smppIdentity.decodeUdhElements)
 */
function pduUdh(pdu) {
  const sm = pdu && pdu.short_message;
  if (sm && typeof sm === 'object' && Array.isArray(sm.udh)) return sm.udh;
  return null;
}

function isDeliveryReceipt(pdu) {
  // esm_class bit 0x04 marks a delivery receipt rather than a real inbound SMS.
  const esm = Number(pdu && pdu.esm_class) || 0;
  if ((esm & 0x3c) === 0x04) return true;
  const t = pduText(pdu);
  return /^id:[^\s]+\s+sub:\d+/i.test(String(t).trim());
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ *
 * Database access
 * ------------------------------------------------------------------ */

function listConnections(activeOnly = false) {
  const where = activeOnly ? 'WHERE active=1' : '';
  return db.all(`SELECT * FROM smpp_connections ${where} ORDER BY id ASC`);
}

function getConnection(id) {
  return db.get('SELECT * FROM smpp_connections WHERE id=?', [id]);
}

/**
 * Runtime state write. runNoSave() is used for the same reason as in
 * providerSync.js: enquire_link keeps firing forever and must not cost a disk
 * flush every time. Real ingestion (which does flush) happens separately.
 */
function markConnection(id, fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return;
  try {
    db.runNoSave(
      `UPDATE smpp_connections SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`,
      [...keys.map(k => fields[k]), id]
    );
  } catch (_) { /* never let bookkeeping break a live link */ }
}

const LOG_KEEP = 2000;
function logEvent(conn, event, level, detail, peer) {
  try {
    db.runNoSave(
      `INSERT INTO smpp_logs (connection_id,connection_name,event,level,detail,peer) VALUES (?,?,?,?,?,?)`,
      [conn ? conn.id : null, conn ? conn.name : '', event, level || 'info', String(detail || '').slice(0, 500), String(peer || '').slice(0, 80)]
    );
    if (Math.random() < 0.02) {
      db.runNoSave(`DELETE FROM smpp_logs WHERE id NOT IN (SELECT id FROM smpp_logs ORDER BY id DESC LIMIT ${LOG_KEEP})`);
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Service state
 * ------------------------------------------------------------------ */

const runtime = new Map();   // connection id -> state
let deps = null;             // { log, processIncomingSmsPayload, clearApiReadCache }
let started = false;
let flushTimer = null;
let partsTimer = null;
let bookkeepingDirty = false;

function markDirty() { bookkeepingDirty = true; }

function flushBookkeeping() {
  if (!bookkeepingDirty) return;
  bookkeepingDirty = false;
  try { db.save && db.save(); } catch (_) {}
}

function stateOf(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      id,
      session: null,
      server: null,
      sessions: new Set(),     // server mode: bound peer sessions
      status: 'stopped',
      reconnectTimer: null,
      enquireTimer: null,
      attempt: 0,
      stopping: false,
      parts: new Map(),        // compat in-memory assembler (tooling/tests)
      dedup: {},               // counters surfaced in the status view
      ackPending: new Map(),   // sequence_number -> identity awaiting ack flush
      ident: null,             // content-free identity diagnostics
    });
  }
  return runtime.get(id);
}

/* ------------------------------------------------------------------ *
 * Inbound message handling (shared by client and server modes)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Inbound message handling (shared by client and server modes)
 *
 * DEDUP DESIGN (see smpp-fix-plan.md §3)
 *   identity tier 1 : SMSC-provided durable id (configured TLV / verified
 *                     appended field)  -> survives reconnect, restart,
 *                     connection delete+recreate; never expires
 *   identity tier 2 : multipart part, from the UDH concatenation IE
 *   identity tier 3 : canonical body hash — OPTIONAL and off by default, be-
 *                     cause it cannot tell a retry from a genuine identical
 *                     message; when off, such a message is STORED (lossless).
 *
 * No content+time rule is ever used to drop a message.
 * ------------------------------------------------------------------ */

function identityConfig() {
  const rawTags = String(process.env.SMPP_ID_TLVS || '').split(/[\s,]+/).filter(Boolean);
  const tags = rawTags.map(t => parseInt(String(t).replace(/^0x/i, ''), 16)).filter(n => Number.isFinite(n) && n > 0);
  const pol = ident.contentSuppressionPolicy(process.env);
  return {
    idTlvs: tags.length ? tags : [0x001e],                    // receipted_message_id by default
    allowAppended: String(process.env.SMPP_ID_APPENDED || '0') === '1',
    // Tier 3 (content+time) is LOSSLESS by default: the effective window stays
    // 0 unless the operator sets a window AND arms it explicitly with
    // SMPP_ALLOW_CONTENT_SUPPRESSION=1. See smppIdentity.contentSuppressionPolicy().
    fallbackRequested: pol.requested,
    fallbackArmed: pol.armed,
    fallbackWindow: pol.window,
    partsMaxAge: Math.max(30, parseInt(process.env.SMPP_PARTS_MAX_AGE_SECONDS || '300', 10) || 300),
  };
}

function ageSeconds(sqlTs) {
  try {
    const t = Date.parse(String(sqlTs || '').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(t)) return 1e9;
    return Math.max(0, Math.round((Date.now() - t) / 1000));
  } catch (_) { return 1e9; }
}

/** Stable SMSC-account identity; survives row delete/re-create. */
function connectionUid(conn) {
  if (conn && conn.connection_uid) return conn.connection_uid;
  const uid = ident.connectionUidOf(conn)
    || (conn && String(conn.mode) === 'server' ? 'smpp:server:' + String(conn.listen_port || 0) : '');
  if (uid) {
    try {
      db.runNoSave("UPDATE smpp_connections SET connection_uid=? WHERE id=? AND (connection_uid IS NULL OR connection_uid='')", [uid, conn.id]);
      markDirty();
    } catch (_) {}
  }
  return uid || ('smpp:conn:' + (conn ? conn.id : 0));   // last-resort legacy key
}

/* ---- durable ledger ---- */
function ledgerFind(uid, kind, value) {
  try {
    return db.get('SELECT id, sms_record_id, first_seen_at, acked_at, seen_count FROM sms_dedup_ledger WHERE connection_uid=? AND identity_kind=? AND identity=?',
      [uid, kind, value]);
  } catch (_) { return null; }
}
function ledgerRecord(uid, kind, value, smsId, channel) {
  const now = nowSql();
  try {
    db.run(`INSERT INTO sms_dedup_ledger (connection_uid,identity_kind,identity,channel,sms_record_id,first_seen_at,last_seen_at,acked_at,seen_count)
            VALUES (?,?,?,?,?,?,?,'',1)
            ON CONFLICT(connection_uid,identity_kind,identity) DO UPDATE SET
              last_seen_at=excluded.last_seen_at,
              seen_count=seen_count+1,
              sms_record_id=COALESCE(excluded.sms_record_id, sms_record_id)`,
      [uid, kind, value, channel || 'smpp', smsId || null, now, now]);
  } catch (e) { try { deps.log.warn('[SMPP] ledger write failed: ' + e.message); } catch (_) {} }
}
function ledgerBump(id) {
  try { db.runNoSave('UPDATE sms_dedup_ledger SET last_seen_at=?, seen_count=seen_count+1 WHERE id=?', [nowSql(), id]); markDirty(); } catch (_) {}
}
function ledgerAck(uid, kind, value) {
  try { db.runNoSave('UPDATE sms_dedup_ledger SET acked_at=? WHERE connection_uid=? AND identity_kind=? AND identity=?', [nowSql(), uid, kind, value]); markDirty(); } catch (_) {}
}
function ledgerAckBySeq(st, seq) {
  const p = st && st.ackPending ? st.ackPending.get(seq) : null;
  if (!p) return;
  st.ackPending.delete(seq);
  if (p.uid && p.kind && p.value) ledgerAck(p.uid, p.kind, p.value);
}

/* ---- identity diagnostics (content-free) ---- */
function noteIdentity(st, conn, parsed, chosen, cfg) {
  try {
    st.ident = st.ident || { messages: 0, idsSeen: 0, tags: {}, samples: [], reported: false, report: '' };
    const r = st.ident;
    r.messages++;
    if (chosen) r.idsSeen++;
    for (const t of (parsed && parsed.tlvs) || []) r.tags[t.tag] = (r.tags[t.tag] || 0) + 1;
    if (r.samples.length < 3 && parsed && parsed.trailingHex) r.samples.push(parsed.trailingHex);
    if (!r.reported && r.messages >= 3) {
      r.reported = true;
      const tags = Object.keys(r.tags).map(t => '0x' + Number(t).toString(16).padStart(4, '0') + 'x' + r.tags[t]).join(' ') || 'none';
      r.report = `id on ${r.idsSeen}/${r.messages} msgs; TLVs seen: ${tags}; tlv-area hex sample: ${r.samples[0] || '(empty)'}`;
      const level = r.idsSeen ? 'info' : 'warn';
      logEvent(conn, 'ident', level, 'identity report: ' + r.report +
        (r.idsSeen ? '' : ' — NO durable SMSC id found. Without one, a retry and a genuine identical message are indistinguishable, so the panel never suppresses by content (lossless default). Configure SMPP_ID_TLVS / SMPP_ID_APPENDED if the SMSC sends an id.'));
      try { deps.log.log(`[SMPP-IDENT] ${conn.name}: ${r.report}`); } catch (_) {}
    }
  } catch (_) {}
}

/* ---- multipart (DB-backed: survives restart, dedups replayed parts) ---- */
function handleMultipartPart(conn, st, ctx) {
  const uid = ctx.uid, info = ctx.concat, cfg = identityConfig();
  const groupKey = `${ctx.src}|${ctx.dst}|${info.ref}|${info.total}`;
  const partIdentity = ctx.strong ? ('id:' + ctx.strong.kind + ':' + ctx.strong.value)
    : ident.multipartPartIdentity(uid, ctx.src, ctx.dst, info, ctx.text);
  const existing = db.get('SELECT text FROM smpp_parts WHERE connection_uid=? AND group_key=? AND seq=?', [uid, groupKey, info.seq]);
  if (existing) {
    if (existing.text === ctx.text) {
      st.dedup.multipartPartsRetry = (st.dedup.multipartPartsRetry || 0) + 1;
      logEvent(conn, 'multipart', 'info', `part retry suppressed (ref=${info.ref} seq=${info.seq}/${info.total})`);
      return asIngest(0, ctx.strong, 'part-retry');
    }
    // Same slot, different content → the reference is being reused by a NEW
    // message. Never merge the two: supersede the stale group and start over.
    const pend = db.get('SELECT COUNT(*) c FROM smpp_parts WHERE connection_uid=? AND group_key=?', [uid, groupKey]);
    logEvent(conn, 'multipart', 'warn', `concat reference reused with different content (ref=${info.ref}) — superseding ${pend ? pend.c : 0} pending part(s), starting a new group`);
    db.run('DELETE FROM smpp_parts WHERE connection_uid=? AND group_key=?', [uid, groupKey]);
  }
  db.run(`INSERT OR REPLACE INTO smpp_parts (connection_uid,group_key,seq,total,part_identity,part_strong,text,received_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    [uid, groupKey, info.seq, info.total, partIdentity, ctx.strong ? 1 : 0, ctx.text, nowSql()]);
  st.dedup.multipartParts = (st.dedup.multipartParts || 0) + 1;
  logEvent(conn, 'multipart', 'info', `part ${info.seq}/${info.total} received (ref=${info.ref}, hasId=${ctx.strong ? 1 : 0})`);

  const rows = db.all('SELECT seq,text,part_identity,part_strong FROM smpp_parts WHERE connection_uid=? AND group_key=? ORDER BY seq ASC', [uid, groupKey]);
  if (new Set(rows.map(r => r.seq)).size < info.total) return asIngest(0, ctx.strong, 'part-waiting');

  db.run('DELETE FROM smpp_parts WHERE connection_uid=? AND group_key=?', [uid, groupKey]);
  const fullText = rows.map(r => r.text).join('');
  const allStrong = rows.every(r => Number(r.part_strong) === 1);
  st.dedup.multipartCompleted = (st.dedup.multipartCompleted || 0) + 1;
  logEvent(conn, 'multipart', 'info', `multipart completed: ${rows.length}/${info.total} parts, ${fullText.length} chars (ref=${info.ref})`);
  const identity = allStrong
    ? { kind: 'mpc', value: ident.sha1(rows.map(r => r.part_identity).join('|')).slice(0, 40) }
    : { kind: 'mp', value: ident.multipartMessageIdentity(uid, ctx.src, ctx.dst, info, rows.map(r => r.text)) };
  return storeMessage(conn, st, Object.assign({}, ctx, {
    text: fullText,
    identity,
    strongIdentity: allStrong,
    strong: null,
    multipart: { parts: rows.length, total: info.total, ref: info.ref },
  }));
}

/* ---- single store path (used for single-part and completed multipart) ---- */
function storeMessage(conn, st, ctx) {
  const cfg = identityConfig();
  const uid = ctx.uid;
  let identity = ctx.identity || ctx.strong || null;
  let strong = ctx.strongIdentity !== undefined ? !!ctx.strongIdentity : !!ctx.strong;

  // Tier 3 (weak) is only ever consulted when explicitly enabled.
  if (!identity && !strong && cfg.fallbackWindow > 0 && ctx.raw) {
    const wv = ident.weakPduIdentity(uid, ctx.raw);
    if (wv) { identity = { kind: 'pdu', value: wv }; strong = false; }
  }

  // Opt-in cross-channel equivalence (see server.js): when the operator has
  // declared that the API/provider reference and the SMPP id share one
  // namespace, a message already recorded by another channel is the same
  // physical SMS. Off by default — identical content alone is never evidence.
  if (identity && strong && String(process.env.SMPP_CROSS_CHANNEL_IDENTITY || '0') === '1') {
    try {
      const cross = db.get("SELECT sms_record_id FROM sms_dedup_ledger WHERE identity=? AND identity_kind='api' LIMIT 1", [identity.value]);
      if (cross) {
        st.dedup.crossChannel = (st.dedup.crossChannel || 0) + 1;
        logEvent(conn, 'dedup', 'info', `duplicate suppressed across channels (${identity.kind}:${String(identity.value).slice(0, 12)}… already stored by the API channel)`);
        return asIngest(0, identity, 'duplicate-cross-channel', cross.sms_record_id);
      }
    } catch (_) {}
  }

  if (identity) {
    const prev = ledgerFind(uid, identity.kind, identity.value);
    if (prev) {
      const age = ageSeconds(prev.first_seen_at);
      const weak = (identity.kind === 'pdu');
      if (!weak || age <= cfg.fallbackWindow) {
        ledgerBump(prev.id);
        st.dedup.duplicates = (st.dedup.duplicates || 0) + 1;
        logEvent(conn, 'dedup', weak ? 'warn' : 'info',
          `duplicate suppressed [${identity.kind}:${String(identity.value).slice(0, 12)}…] first seen ${prev.first_seen_at}, age ${age}s, ack ${prev.acked_at ? 'confirmed' : 'UNCONFIRMED'}${weak ? ` (CONTENT SUPPRESSION ARMED: identical sender/destination/body inside the ${cfg.fallbackWindow}s window — no stored row is ever modified)` : ''}`);
        return asIngest(0, identity, 'duplicate', prev.sms_record_id, { weak, age });
      }
      // weak identity outside the window → treated as a genuinely new message
      logEvent(conn, 'dedup', 'warn', `weak identity outside the ${cfg.fallbackWindow}s window (age ${age}s) — storing as a NEW message`);
    }
  }

  if (!strong) {
    st.dedup.noId = (st.dedup.noId || 0) + 1;
    if (!identity) {
      logEvent(conn, 'ident', 'warn', `no durable id on this PDU (${ctx.src || '?'} -> ${ctx.dst || '?'}) — stored without content-based suppression`);
    }
  }

  const dedupColumn = strong && identity
    ? 'smpp:' + ident.sha1(uid + '|' + identity.kind + '|' + identity.value).slice(0, 40)
    : '';

  /* Persisted marking, so the operator can count what actually happened:
       strong    — a durable provider/SMSC id (or completed all-strong multipart)
       multipart — a concatenated message rebuilt from UDH parts
       weak      — ONLY ever with the armed content-suppression window
       no-id     — NO physical identity existed; stored anyway (lossless) */
  const identityState = ctx.multipart
    ? 'multipart'
    : (identity && strong ? 'strong' : (identity ? 'weak' : 'no-id'));

  const result = deps.processIncomingSmsPayload(
    { ip: ctx.peer || 'SMPP', smpp_connection: conn.name },
    { number: ctx.dst, cli: ctx.src, message: ctx.text },
    `smpp:${conn.name}`,
    { source: 'smpp', dedupIdentity: dedupColumn, identityState }
  );

  const ok = result && result.status === 200;
  const smsId = ok && result.body ? (result.body.id || null) : null;
  const duplicate = !!(ok && result.body && result.body.duplicate);

  if (ok) {
    if (identity) ledgerRecord(uid, identity.kind, identity.value, smsId, 'smpp');
    if (!duplicate) {
      db.runNoSave('UPDATE smpp_connections SET total_received=total_received+1, last_activity_at=? WHERE id=?', [nowSql(), conn.id]);
      if (ctx.multipart) {
        logEvent(conn, 'deliver', 'info', `received multipart ${ctx.multipart.parts}/${ctx.multipart.total} (ref=${ctx.multipart.ref}) from ${ctx.src || '?'} to ${ctx.dst || '?'}`);
      } else {
        logEvent(conn, 'deliver', 'info', `received from ${ctx.src || '?'} to ${ctx.dst || '?'}${ctx.payloadUsed ? ' (message_payload)' : ''}`);
      }
      try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
    } else {
      st.dedup.crossChannel = (st.dedup.crossChannel || 0) + 1;
      logEvent(conn, 'dedup', 'info', 'duplicate ignored by the shared ingest path (dedup_identity already present)');
    }
    markDirty();
    return asIngest(0, identity, duplicate ? 'duplicate' : 'stored', smsId, { strong });
  }

  const why = (result && result.body && result.body.error) || 'rejected';
  const persistenceFailed = !result || Number(result.status) >= 500;
  if (persistenceFailed) {
    // We do NOT have this message. Claiming success would make the SMSC drop it
    // for good; a negative ack is the only way it can ever be stored. Nothing
    // was written to the ledger, so the SMSC's retry inserts it exactly once.
    logEvent(conn, 'error', 'error', `not stored (persistence failure: ${why}) — negative ack, expecting SMSC retry`);
    markDirty();
    return asIngest((smppLib && smppLib.ESME_RDELIVERYFAILURE) || 0x00000045, identity, 'storage-failed', null, { strong });
  }
  // Evaluation rejection (unknown number, unparseable payload): parked in the
  // operator's Failed SMS queue. Acked 0 on purpose — the SMSC retrying cannot
  // fix it and would only multiply rows.
  logEvent(conn, 'deliver', 'warn', `not stored: ${why}${ctx.dst ? ' (' + ctx.dst + ')' : ''}`);
  markDirty();
  return asIngest(0, identity, 'rejected', null, { strong });
}

/** Normalised ingest outcome carried back to the ACK code. */
function asIngest(status, identity, outcome, smsId, extra) {
  return { status: status | 0, identity: identity || null, outcome: outcome || '', sms_record_id: smsId || null, extra: extra || {} };
}

/**
 * Ingest one inbound PDU. Returns the SMPP command_status for the response:
 *   ESME_ROK (0)          — stored, suppressed as a duplicate, or parked in the
 *                           Failed SMS queue for an operator (never re-requested
 *                           from the SMSC: the SMSC retrying cannot fix a bad
 *                           number and would only multiply rows)
 *   ESME_RSYSERR (0x08)   — only when the message could NOT be evaluated at all
 *                           (a genuine exception). A post-insert bookkeeping
 *                           failure no longer lands here — see storeMessage().
 *   ESME_RDELIVERYFAILURE — the store itself failed (DB error). The message is
 *                           NOT on disk and the SMSC must retry it; nothing was
 *                           written to the ledger, so that retry stores once.
 */
function ingest(conn, st, pdu, peer) {
  const ERR_SYS = (smppLib && smppLib.ESME_RSYSERR) || 0x00000008;
  try {
    if (isDeliveryReceipt(pdu)) {
      logEvent(conn, 'deliver', 'info', 'delivery receipt ignored', peer);
      markDirty();
      return 0;
    }

    const cfg = identityConfig();
    const parsed = pdu.__rawBuffer ? ident.parseRawPdu(pdu.__rawBuffer) : null;
    const candidates = ident.identityCandidates(parsed, cfg);
    const strong = candidates.length ? candidates[0] : null;

    const src = safeStr(pdu.source_addr).trim();
    const dst = safeStr(pdu.destination_addr).trim();
    const text = pduText(pdu);

    noteIdentity(st, conn, parsed, strong, cfg);

    if (!dst) {
      logEvent(conn, 'deliver', 'warn', 'missing destination_addr', peer);
      markDirty();
      return 0;   // never NACK: the peer would redeliver this forever
    }

    const ctx = {
      uid: connectionUid(conn),
      src, dst, text,
      strong, raw: pdu.__rawBuffer || null,
      peer, payloadUsed: usesPayload(pdu),
    };

    const udhElements = ident.decodeUdhElements(pduUdh(pdu));
    const concat = ident.concatInfo(udhElements);

    let out;
    if (concat, concat && Number(concat.total) > 1) {
      out = handleMultipartPart(conn, st, Object.assign({}, ctx, { concat }));
    } else {
      out = storeMessage(conn, st, ctx);
    }

    // Remember which identity this sequence number produced so the ACK path can
    // record "the SMSC was told" — retry evidence, useful in the logs.
    if (out && out.identity) {
      st.ackPending.set(pdu.sequence_number, { uid: ctx.uid, kind: out.identity.kind, value: out.identity.value });
      if (st.ackPending.size > 500) {
        const first = st.ackPending.keys().next().value;
        st.ackPending.delete(first);
      }
    }
    return out && out.status ? out.status : 0;
  } catch (e) {
    try { deps.log.warn(`[SMPP] ${conn.name}: ingest failed: ${e.message}`); } catch (_) {}
    logEvent(conn, 'error', 'error', 'ingest failed: ' + e.message, peer);
    st.dedup.errors = (st.dedup.errors || 0) + 1;
    markDirty();
    return ERR_SYS;
  }
}

/**
 * Compatibility helper kept for tooling/tests: an in-memory UDH-aware
 * assembler over the SAME primitives the DB-backed path uses.
 */
function reassemble(st, key, udh, text) {
  st.parts = st.parts || new Map();
  const elements = ident.decodeUdhElements(udh);
  const info = ident.concatInfo(elements);
  if (!info || Number(info.total) < 2) return text;
  const bucket = `${key}:${info.ref}:${info.total}`;
  let entry = st.parts.get(bucket);
  if (!entry) { entry = { total: info.total, parts: new Map(), at: Date.now() }; st.parts.set(bucket, entry); }
  entry.parts.set(info.seq, text);
  if (st.parts.size > 500) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of st.parts) if (v.at < cutoff) st.parts.delete(k);
  }
  if (entry.parts.size < info.total) return null;
  st.parts.delete(bucket);
  let out = '';
  for (let i = 1; i <= info.total; i++) out += (entry.parts.get(i) || '');
  return out;
}

/* ------------------------------------------------------------------ *
 * CLIENT mode — Power X binds OUT to the provider
 * ------------------------------------------------------------------ */

function scheduleReconnect(conn) {
  const st = stateOf(conn.id);
  if (st.stopping) return;
  if (st.reconnectTimer) return;

  const base = clampInt(conn.reconnect_seconds, 1, 3600, 10);
  const max = clampInt(conn.max_reconnect_seconds, base, 86400, 300);
  // Exponential backoff with jitter: a provider that is down does not get
  // hammered, and many connections do not all retry in the same instant.
  const backoff = Math.min(max, base * Math.pow(2, Math.min(st.attempt, 10)));
  const delay = Math.round((backoff * 0.7 + backoff * 0.3 * Math.random()) * 1000);

  st.status = 'reconnecting';
  markConnection(conn.id, { status: 'reconnecting' });
  logEvent(conn, 'reconnect', 'warn', `retry in ${Math.round(delay / 1000)}s (attempt ${st.attempt + 1})`);
  markDirty();

  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    const fresh = getConnection(conn.id);
    if (!fresh || !fresh.active) return;
    startClient(fresh);
  }, delay);
  if (st.reconnectTimer.unref) st.reconnectTimer.unref();
}

function teardownClient(st) {
  if (st.enquireTimer) { clearInterval(st.enquireTimer); st.enquireTimer = null; }
  if (st.session) {
    try { st.session.removeAllListeners(); } catch (_) {}
    try { st.session.close(); } catch (_) {}
    try { st.session.destroy && st.session.destroy(); } catch (_) {}
    st.session = null;
  }
}

function startClient(conn) {
  const smpp = getSmpp();
  const st = stateOf(conn.id);
  st.stopping = false;
  teardownClient(st);

  if (!conn.host) {
    markConnection(conn.id, { status: 'error', last_error: 'host is required for client mode' });
    logEvent(conn, 'error', 'error', 'host is required for client mode');
    markDirty();
    return;
  }

  const port = clampInt(conn.port, 1, 65535, 2775);
  const scheme = conn.use_tls ? 'ssmpp' : 'smpp';
  const url = `${scheme}://${conn.host}:${port}`;

  st.status = 'connecting';
  markConnection(conn.id, { status: 'connecting', last_error: '' });
  logEvent(conn, 'bind', 'info', `connecting to ${url}`);
  markDirty();

  let session;
  try {
    session = smpp.connect(
      { url, connectTimeout: clampInt(conn.connect_timeout_ms, 1000, 120000, 15000) },
      () => onClientConnected(conn, session)
    );
  } catch (e) {
    markConnection(conn.id, { status: 'error', last_error: 'connect failed: ' + e.message, consecutive_failures: (conn.consecutive_failures || 0) + 1 });
    logEvent(conn, 'error', 'error', 'connect failed: ' + e.message);
    markDirty();
    st.attempt++;
    scheduleReconnect(conn);
    return;
  }

  st.session = session;

  // Every handler is guarded: an exception inside an SMPP callback must never
  // escape into the process and take the panel down.
  session.on('error', (e) => {
    const msg = (e && e.message) || String(e);
    if (st.status !== 'reconnecting') {
      markConnection(conn.id, { status: 'error', last_error: msg, consecutive_failures: (getConnection(conn.id) || {}).consecutive_failures + 1 || 1 });
      logEvent(conn, 'error', 'error', msg);
      markDirty();
    }
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('close', () => {
    if (st.stopping) return;
    markConnection(conn.id, { status: 'disconnected' });
    logEvent(conn, 'unbind', 'warn', 'connection closed by peer');
    markDirty();
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('deliver_sm', (pdu) => {
    let status = 0;
    try { status = ingest(conn, st, pdu, conn.host); }
    catch (e) { status = (smpp.ESME_RSYSERR || 8); }
    try {
      // The success/failure response is unchanged; the write callback only
      // records that the SMSC was actually told (retry evidence for the log).
      session.send(pdu.response({ command_status: status }), null,
        () => ledgerAckBySeq(st, pdu.sequence_number),
        () => {});
    } catch (_) {}
  });

  // Some providers push via data_sm instead of deliver_sm.
  session.on('data_sm', (pdu) => {
    let status = 0;
    try { status = ingest(conn, st, pdu, conn.host); }
    catch (e) { status = (smpp.ESME_RSYSERR || 8); }
    try {
      session.send(pdu.response({ command_status: status }), null,
        () => ledgerAckBySeq(st, pdu.sequence_number),
        () => {});
    } catch (_) {}
  });

  session.on('enquire_link', (pdu) => {
    try { session.send(pdu.response()); } catch (_) {}
  });

  session.on('unbind', (pdu) => {
    try { session.send(pdu.response()); } catch (_) {}
    try { session.close(); } catch (_) {}
  });
}

function onClientConnected(conn, session) {
  const smpp = smppLib;
  const st = stateOf(conn.id);

  const bindFn = {
    transceiver: 'bind_transceiver',
    receiver: 'bind_receiver',
    transmitter: 'bind_transmitter',
  }[String(conn.bind_type || 'transceiver').toLowerCase()] || 'bind_transceiver';

  const params = {
    system_id: conn.system_id || '',
    password: conn.password || '',
  };
  if (conn.system_type) params.system_type = conn.system_type;
  if (conn.address_range) params.address_range = conn.address_range;

  let responded = false;
  const bindTimeout = setTimeout(() => {
    if (responded) return;
    responded = true;
    logEvent(conn, 'error', 'error', 'bind timed out (no response from provider)');
    markConnection(conn.id, { status: 'error', last_error: 'bind timed out' });
    markDirty();
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  }, clampInt(conn.connect_timeout_ms, 1000, 120000, 15000));
  if (bindTimeout.unref) bindTimeout.unref();

  try {
    session[bindFn](params, (pdu) => {
      if (responded) return;
      responded = true;
      clearTimeout(bindTimeout);

      if (!pdu || pdu.command_status !== 0) {
        const code = pdu ? pdu.command_status : -1;
        const name = describeBindError(code);
        markConnection(conn.id, {
          status: 'error',
          last_error: `bind rejected: ${name}`,
          consecutive_failures: (getConnection(conn.id) || {}).consecutive_failures + 1 || 1,
        });
        logEvent(conn, 'bind', 'error', `bind rejected: ${name}`);
        markDirty();
        st.attempt++;
        teardownClient(st);
        scheduleReconnect(conn);
        return;
      }

      st.attempt = 0;
      st.status = 'bound';
      markConnection(conn.id, {
        status: 'bound',
        last_error: '',
        last_connected_at: nowSql(),
        last_activity_at: nowSql(),
        consecutive_failures: 0,
      });
      logEvent(conn, 'bind', 'info', `bound as ${bindFn.replace('bind_', '')} (system_id=${conn.system_id})`);
      markDirty();

      startEnquireLink(conn, session);
      // A link that just came up may have queued outbound messages waiting.
      setImmediate(() => { try { drainOutbox(conn.id); } catch (_) {} });
    });
  } catch (e) {
    if (!responded) {
      responded = true;
      clearTimeout(bindTimeout);
      logEvent(conn, 'error', 'error', 'bind failed: ' + e.message);
      markDirty();
      st.attempt++;
      teardownClient(st);
      scheduleReconnect(conn);
    }
  }
}

function describeBindError(code) {
  const smpp = smppLib || {};
  const map = {
    [smpp.ESME_RBINDFAIL || 0x0d]: 'bind failed',
    [smpp.ESME_RINVSYSID || 0x0f]: 'invalid system_id',
    [smpp.ESME_RINVPASWD || 0x0e]: 'invalid password',
    [smpp.ESME_RALYBND || 0x05]: 'already bound',
    [smpp.ESME_RINVSERTYP || 0x104]: 'invalid system_type',
  };
  return map[code] || `status 0x${Number(code || 0).toString(16)}`;
}

function startEnquireLink(conn, session) {
  const st = stateOf(conn.id);
  if (st.enquireTimer) clearInterval(st.enquireTimer);
  const secs = clampInt(conn.enquire_link_seconds, 5, 3600, 30);

  st.enquireTimer = setInterval(() => {
    if (!st.session) return;
    let answered = false;
    const t = setTimeout(() => {
      if (answered) return;
      // The socket looks open but the peer is not answering: this is the
      // classic "half-open link" that silently swallows traffic. Force a
      // reconnect rather than sitting there believing we are bound.
      logEvent(conn, 'error', 'warn', 'enquire_link timeout — forcing reconnect');
      markConnection(conn.id, { status: 'error', last_error: 'enquire_link timeout' });
      markDirty();
      st.attempt++;
      teardownClient(st);
      scheduleReconnect(conn);
    }, Math.min(secs * 1000, 20000));
    if (t.unref) t.unref();

    try {
      st.session.enquire_link({}, () => {
        answered = true;
        clearTimeout(t);
        markConnection(conn.id, { last_activity_at: nowSql() });
        markDirty();
      });
    } catch (e) {
      answered = true;
      clearTimeout(t);
    }
  }, secs * 1000);
  if (st.enquireTimer.unref) st.enquireTimer.unref();
}

/* ------------------------------------------------------------------ *
 * SERVER mode — the carrier binds IN to Power X
 * ------------------------------------------------------------------ */

function ipAllowed(conn, ip) {
  const list = String(conn.allowed_ips || '').split(/[\s,;]+/).filter(Boolean);
  if (!list.length) return true;                 // empty = allow any
  const clean = String(ip || '').replace(/^::ffff:/, '');
  return list.some(a => a.replace(/^::ffff:/, '') === clean);
}

function startServer(conn) {
  const smpp = getSmpp();
  const st = stateOf(conn.id);
  st.stopping = false;
  stopServer(st);

  const port = clampInt(conn.listen_port, 1, 65535, 0);
  if (!port) {
    markConnection(conn.id, { status: 'error', last_error: 'listen_port is required for server mode' });
    logEvent(conn, 'error', 'error', 'listen_port is required for server mode');
    markDirty();
    return;
  }

  const server = smpp.createServer({}, (session) => onPeerSession(conn, session));
  st.server = server;

  server.on('error', (e) => {
    const msg = (e && e.code === 'EADDRINUSE')
      ? `port ${port} is already in use`
      : ((e && e.message) || String(e));
    markConnection(conn.id, { status: 'error', last_error: msg });
    logEvent(conn, 'error', 'error', msg);
    markDirty();
    st.server = null;
    // Retry: the port may free up (e.g. an old process exiting).
    st.attempt++;
    scheduleServerRetry(conn);
  });

  try {
    server.listen(port, () => {
      st.attempt = 0;
      st.status = 'listening';
      markConnection(conn.id, { status: 'listening', last_error: '', last_connected_at: nowSql(), consecutive_failures: 0 });
      logEvent(conn, 'listen', 'info', `listening on port ${port}`);
      markDirty();
    });
  } catch (e) {
    markConnection(conn.id, { status: 'error', last_error: 'listen failed: ' + e.message });
    logEvent(conn, 'error', 'error', 'listen failed: ' + e.message);
    markDirty();
  }
}

function scheduleServerRetry(conn) {
  const st = stateOf(conn.id);
  if (st.stopping || st.reconnectTimer) return;
  const base = clampInt(conn.reconnect_seconds, 1, 3600, 10);
  const max = clampInt(conn.max_reconnect_seconds, base, 86400, 300);
  const delay = Math.min(max, base * Math.pow(2, Math.min(st.attempt, 8))) * 1000;
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    const fresh = getConnection(conn.id);
    if (fresh && fresh.active) startServer(fresh);
  }, delay);
  if (st.reconnectTimer.unref) st.reconnectTimer.unref();
}

function onPeerSession(conn, session) {
  const smpp = smppLib;
  const st = stateOf(conn.id);
  const peer = (session.socket && session.socket.remoteAddress) || '';

  session.on('error', () => { try { session.close(); } catch (_) {} });
  session.on('close', () => {
    st.sessions.delete(session);
    markConnection(conn.id, { status: st.sessions.size ? 'bound' : 'listening' });
    logEvent(conn, 'unbind', 'info', `peer disconnected (${st.sessions.size} bound)`, peer);
    markDirty();
  });

  const handleBind = (pdu, kind) => {
    try {
      if (!ipAllowed(conn, peer)) {
        logEvent(conn, 'bind', 'warn', `rejected: IP not allowed`, peer);
        markDirty();
        session.send(pdu.response({ command_status: smpp.ESME_RBINDFAIL }));
        setTimeout(() => { try { session.close(); } catch (_) {} }, 50);
        return;
      }
      const okId = String(conn.system_id || '');
      const okPw = String(conn.password || '');
      if (safeStr(pdu.system_id) !== okId || safeStr(pdu.password) !== okPw) {
        logEvent(conn, 'bind', 'warn', `rejected: bad credentials (system_id=${safeStr(pdu.system_id)})`, peer);
        markDirty();
        session.send(pdu.response({ command_status: smpp.ESME_RINVPASWD }));
        setTimeout(() => { try { session.close(); } catch (_) {} }, 50);
        return;
      }
      session.send(pdu.response({ system_id: 'GalaxySMS' }));
      st.sessions.add(session);
      markConnection(conn.id, { status: 'bound', last_error: '', last_connected_at: nowSql(), last_activity_at: nowSql(), consecutive_failures: 0 });
      logEvent(conn, 'bind', 'info', `peer bound as ${kind} (system_id=${okId})`, peer);
      markDirty();
    } catch (e) {
      try { session.close(); } catch (_) {}
    }
  };

  session.on('bind_transceiver', (pdu) => handleBind(pdu, 'transceiver'));
  session.on('bind_receiver', (pdu) => handleBind(pdu, 'receiver'));
  session.on('bind_transmitter', (pdu) => handleBind(pdu, 'transmitter'));

  session.on('enquire_link', (pdu) => {
    try { session.send(pdu.response()); markConnection(conn.id, { last_activity_at: nowSql() }); markDirty(); } catch (_) {}
  });

  session.on('unbind', (pdu) => {
    try { session.send(pdu.response()); session.close(); } catch (_) {}
  });

  // Carrier delivering an inbound SMS to us.
  session.on('submit_sm', (pdu) => {
    let status = 0, id = '';
    try {
      if (!st.sessions.has(session)) {
        status = smpp.ESME_RINVBNDSTS || 4;    // not bound
      } else {
        status = ingest(conn, st, pdu, peer);
        id = 'PX' + Date.now().toString(36);
      }
    } catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try {
      session.send(pdu.response({ command_status: status, message_id: id }), null,
        () => ledgerAckBySeq(st, pdu.sequence_number), () => {});
    } catch (_) {}
  });

  session.on('deliver_sm', (pdu) => {
    let status = 0;
    try { status = st.sessions.has(session) ? ingest(conn, st, pdu, peer) : (smpp.ESME_RINVBNDSTS || 4); }
    catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try {
      session.send(pdu.response({ command_status: status }), null,
        () => ledgerAckBySeq(st, pdu.sequence_number), () => {});
    } catch (_) {}
  });

  session.on('data_sm', (pdu) => {
    let status = 0;
    try { status = st.sessions.has(session) ? ingest(conn, st, pdu, peer) : (smpp.ESME_RINVBNDSTS || 4); }
    catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try {
      session.send(pdu.response({ command_status: status }), null,
        () => ledgerAckBySeq(st, pdu.sequence_number), () => {});
    } catch (_) {}
  });
}

function stopServer(st) {
  for (const s of st.sessions) { try { s.close(); } catch (_) {} }
  st.sessions.clear();
  if (st.server) {
    try { st.server.close(); } catch (_) {}
    st.server = null;
  }
}

/* ------------------------------------------------------------------ *
 * Outbound (submit_sm)
 * ------------------------------------------------------------------ */

/**
 * Queue a message. It is written to smpp_outbox first so nothing is lost if
 * the link is down; drainOutbox() sends it when a session is available.
 */
function queueOutbound(connectionId, destination, message, sourceAddr, userId) {
  const conn = getConnection(connectionId);
  if (!conn) throw new Error('Connection not found');
  const dst = String(destination || '').trim();
  if (!dst) throw new Error('destination is required');
  const text = String(message == null ? '' : message);
  if (!text) throw new Error('message is required');

  db.run(
    `INSERT INTO smpp_outbox (connection_id,destination,source_addr,message,status,created_by) VALUES (?,?,?,?,'queued',?)`,
    [connectionId, dst, String(sourceAddr || conn.default_source_addr || ''), text, userId || null]
  );
  const row = db.get('SELECT id FROM smpp_outbox ORDER BY id DESC LIMIT 1');
  setImmediate(() => { try { drainOutbox(connectionId); } catch (_) {} });
  return { ok: true, id: row ? row.id : null, status: 'queued' };
}

function pickSession(st) {
  if (st.session) return st.session;                       // client mode
  for (const s of st.sessions) return s;                   // server mode: first bound peer
  return null;
}

function drainOutbox(connectionId) {
  const conn = getConnection(connectionId);
  if (!conn) return;
  const st = stateOf(connectionId);
  const session = pickSession(st);
  if (!session) return;                    // not connected: stay queued

  const rows = db.all('SELECT * FROM smpp_outbox WHERE connection_id=? AND status=? ORDER BY id ASC LIMIT 50', [connectionId, 'queued']);
  for (const row of rows) {
    try {
      const params = {
        destination_addr: row.destination,
        short_message: row.message,
      };
      const src = row.source_addr || conn.default_source_addr || '';
      if (src) params.source_addr = src;

      db.runNoSave('UPDATE smpp_outbox SET attempts=attempts+1 WHERE id=?', [row.id]);

      session.submit_sm(params, (pdu) => {
        try {
          if (pdu && pdu.command_status === 0) {
            db.run(`UPDATE smpp_outbox SET status='sent', provider_message_id=?, error='', sent_at=? WHERE id=?`,
              [safeStr(pdu.message_id), nowSql(), row.id]);
            db.runNoSave('UPDATE smpp_connections SET total_sent=total_sent+1, last_activity_at=? WHERE id=?', [nowSql(), connectionId]);
            logEvent(conn, 'submit', 'info', `sent to ${row.destination}`);
          } else {
            const code = pdu ? `0x${Number(pdu.command_status).toString(16)}` : 'no response';
            db.run(`UPDATE smpp_outbox SET status='failed', error=? WHERE id=?`, [`submit_sm rejected (${code})`, row.id]);
            logEvent(conn, 'submit', 'error', `rejected for ${row.destination}: ${code}`);
          }
          markDirty();
        } catch (_) {}
      });
    } catch (e) {
      try {
        db.run(`UPDATE smpp_outbox SET status='failed', error=? WHERE id=?`, [String(e.message).slice(0, 300), row.id]);
        logEvent(conn, 'submit', 'error', `send failed for ${row.destination}: ${e.message}`);
        markDirty();
      } catch (_) {}
    }
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function startConnection(id) {
  const conn = getConnection(id);
  if (!conn) throw new Error('Connection not found');
  if (!conn.active) return { ok: false, error: 'Connection is not active' };
  if (!deps) return { ok: false, error: 'SMPP service is not running' };

  try { getSmpp(); }
  catch (e) {
    markConnection(id, { status: 'error', last_error: e.message });
    markDirty();
    return { ok: false, error: e.message };
  }

  stopConnection(id, true);
  const st = stateOf(id);
  st.attempt = 0;
  st.stopping = false;

  if (String(conn.mode) === 'server') startServer(conn);
  else startClient(conn);
  return { ok: true };
}

function stopConnection(id, silent) {
  const st = stateOf(id);
  st.stopping = true;
  if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
  teardownClient(st);
  stopServer(st);
  st.status = 'stopped';
  st.parts.clear();
  if (!silent) {
    const conn = getConnection(id);
    markConnection(id, { status: 'stopped', last_error: '' });
    if (conn) logEvent(conn, 'unbind', 'info', 'stopped by operator');
    markDirty();
  }
  return { ok: true };
}

function restartConnection(id) {
  stopConnection(id, true);
  return startConnection(id);
}

function statusOf(id) {
  const conn = getConnection(id);
  if (!conn) return null;
  const st = runtime.get(id);
  const pcfg = identityConfig();
  return {
    id: conn.id,
    name: conn.name,
    mode: conn.mode,
    active: !!conn.active,
    status: conn.status || 'stopped',
    live: st ? st.status : 'stopped',
    bound_sessions: st ? (st.session ? 1 : st.sessions.size) : 0,
    last_error: conn.last_error || '',
    last_connected_at: conn.last_connected_at || '',
    last_activity_at: conn.last_activity_at || '',
    consecutive_failures: conn.consecutive_failures || 0,
    total_received: conn.total_received || 0,
    total_sent: conn.total_sent || 0,
    queued: (db.get('SELECT COUNT(*) c FROM smpp_outbox WHERE connection_id=? AND status=?', [id, 'queued']) || {}).c || 0,
    connection_uid: conn.connection_uid || '',
    dedup_policy: {
      still: 'no message is ever suppressed because content looks identical',
      id_tlvs: pcfg.idTlvs,
      appended_id: !!pcfg.allowAppended,
      content_suppression_requested_seconds: pcfg.fallbackRequested,
      content_suppression_armed: !!pcfg.fallbackArmed,
      content_suppression_window_seconds: pcfg.fallbackWindow,
      lossless: !(pcfg.fallbackArmed && pcfg.fallbackWindow > 0),
    },
    dedup: st && st.dedup ? Object.assign({}, st.dedup) : {},
    identity_report: (st && st.ident && st.ident.report) ? st.ident.report : '',
    pending_parts: (() => { try { return (db.get('SELECT COUNT(*) c FROM smpp_parts WHERE connection_uid=?', [conn.connection_uid || '']) || {}).c || 0; } catch (_) { return 0; } })(),
  };
}

function start(d) {
  if (started) return;
  deps = d || {};
  if (!deps.log) deps.log = console;
  if (typeof deps.processIncomingSmsPayload !== 'function') {
    deps.log.warn('[SMPP] disabled: no ingestion function supplied');
    return;
  }
  started = true;

  const enabled = String(process.env.SMPP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    deps.log.log('• SMPP service disabled (SMPP_ENABLED=false)');
    return;
  }

  // Any connection left in a live state by a previous run is stale after a
  // restart; reset so the UI never shows a bind that does not exist.
  try { db.runNoSave(`UPDATE smpp_connections SET status='stopped' WHERE status NOT IN ('stopped','error')`); db.save && db.save(); } catch (_) {}

  let list = [];
  try { list = listConnections(true); } catch (_) { list = []; }

  if (list.length) {
    try { getSmpp(); }
    catch (e) {
      deps.log.warn(`• SMPP: ${list.length} active connection(s) configured but library unavailable: ${e.message}`);
      return;
    }
  }

  for (const c of list) {
    try { startConnection(c.id); }
    catch (e) { deps.log.warn(`[SMPP] ${c.name}: start failed: ${e.message}`); }
  }

  // One periodic flush, mirroring providerSync's bookkeeping strategy: link
  // chatter must not cost a disk write every few seconds.
  flushTimer = setInterval(() => { try { flushBookkeeping(); } catch (_) {} }, 5 * 60 * 1000);
  if (flushTimer.unref) flushTimer.unref();

  // Retry anything still queued when a link recovers.
  const outboxTimer = setInterval(() => {
    try { for (const c of listConnections(true)) drainOutbox(c.id); } catch (_) {}
  }, 30000);
  if (outboxTimer.unref) outboxTimer.unref();

  // Incomplete multipart messages: never silently lost — after the staleness
  // window the parts we actually received are stored and logged.
  partsTimer = setInterval(() => { try { sweepStaleParts(); } catch (_) {} }, 60000);
  if (partsTimer.unref) partsTimer.unref();

  // Policy summary — loud on purpose: content suppression is never a silent
  // side effect of an env var.
  try {
    const pc = identityConfig();
    if (pc.fallbackRequested > 0 && !pc.fallbackArmed) {
      deps.log.warn(`• [SMPP] a ${pc.fallbackRequested}s content-suppression window was requested but is NOT armed (set SMPP_ALLOW_CONTENT_SUPPRESSION=1 to allow it) — ignoring it: every message is stored (lossless)`);
    }
    deps.log.log(pc.fallbackArmed && pc.fallbackWindow > 0
      ? `• [SMPP] !! CONTENT SUPPRESSION ARMED !! identical sender+destination+body inside ${pc.fallbackWindow}s is treated as a retry (a genuine identical resend can be suppressed) — /api/smpp/dedup-stats shows the counts`
      : `• [SMPP] lossless mode: nothing is ever suppressed because the content looks identical; messages with no provider id are stored and marked identity_state='no-id' (see /api/smpp/dedup-stats)`);
  } catch (_) {}
  deps.log.log(`• SMPP service active: ${list.length} connection(s) configured`);
}

function stop() {
  for (const id of Array.from(runtime.keys())) {
    try { stopConnection(id, true); } catch (_) {}
  }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (partsTimer) { clearInterval(partsTimer); partsTimer = null; }
  flushBookkeeping();
  started = false;
}

function onExit() {
  try { stop(); } catch (_) {}
}
process.once('SIGINT', onExit);
process.once('SIGTERM', onExit);
process.once('beforeExit', () => { try { flushBookkeeping(); } catch (_) {} });

/**
 * Flush multipart groups older than the staleness window. The parts that did
 * arrive are stored as one row (logged as incomplete) so a missing part can
 * never silently lose the message.
 */
function sweepStaleParts() {
  const cfg = identityConfig();
  let conns = [];
  try { conns = listConnections(true); } catch (_) { return; }
  for (const conn of conns) {
    const uid = connectionUid(conn);
    let groups = [];
    try {
      groups = db.all('SELECT group_key, COUNT(*) c, MAX(received_at) last FROM smpp_parts WHERE connection_uid=? GROUP BY group_key', [uid]);
    } catch (_) { continue; }
    for (const g of groups) {
      if (!g.last || ageSeconds(g.last) < cfg.partsMaxAge) continue;
      const parts = db.all('SELECT seq, text FROM smpp_parts WHERE connection_uid=? AND group_key=? ORDER BY seq ASC', [uid, g.group_key]);
      db.run('DELETE FROM smpp_parts WHERE connection_uid=? AND group_key=?', [uid, g.group_key]);
      const bits = String(g.group_key).split('|');
      const text = parts.map(pp => pp.text).join('');
      logEvent(conn, 'multipart', 'warn', `incomplete multipart timed out: ${parts.length}/${Number(bits[3]) || '?'} parts, ${text.length} chars (ref=${bits[2] || '?'}) — storing the received part(s)`);
      try {
        storeMessage(conn, stateOf(conn.id), {
          uid, src: bits[0] || '', dst: bits[1] || '', text,
          strong: null, raw: null, identity: null, peer: conn.host,
          partial: true, multipart: { parts: parts.length, total: Number(bits[3]) || 0, ref: bits[2] || '', incomplete: true },
        });
      } catch (e) {
        deps.log.warn(`[SMPP] ${conn.name}: incomplete multipart store failed: ${e.message}`);
      }
    }
  }
}

module.exports = {
  start, stop,
  listConnections, getConnection,
  startConnection, stopConnection, restartConnection,
  statusOf,
  queueOutbound, drainOutbox,
  flushBookkeeping,
  isLibraryAvailable() { try { getSmpp(); return true; } catch (_) { return false; } },
  libraryError() { return smppLoadError; },
  _internal: {
    pduText, payloadText, usesPayload, pduUdh, isDeliveryReceipt, ipAllowed, clampInt, reassemble,
    identityConfig, connectionUid, ledgerFind, ledgerRecord, storeMessage, handleMultipartPart, sweepStaleParts,
    asIngest, ident,
  },
};
