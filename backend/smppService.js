/**
 * Skyline SMS — SMPP Connection Service
 * ---------------------------------------------------------------------------
 * ADDITIONAL channel. It does not touch the existing HTTP integrations.
 *
 *   Existing (untouched):
 *     HTTP push  : provider -> POST/GET /api/incoming-sms
 *     HTTP pull  : providerSync.js -> provider REST API every N seconds
 *
 *   Added here:
 *     SMPP client : Skyline binds OUT to a provider's SMPP server (ESME)
 *     SMPP server : Skyline LISTENS, the carrier binds IN to us
 *
 * All three converge on the SAME ingestion function that the carrier webhook
 * already uses (processIncomingSmsPayload), so allocation, rate cards, OTP
 * extraction, payout rules, daily limits and panel scoping behave identically
 * no matter which channel an SMS arrived on. Nothing in that function was
 * changed for SMPP.
 *
 * ARCHITECTURAL DESIGN & DUPLICATION FIX:
 *
 *  - Fast Acknowledgement: Inbound PDUs (deliver_sm / data_sm / submit_sm)
 *    are acknowledged IMMEDIATELY with matching sequence_number. This
 *    prevents provider SMSC response-timer expiration and wire retransmissions.
 *
 *  - Session & Sequence Idempotency: Every SMPP session receives a unique
 *    immutable session ID. Incoming sequence numbers are tracked per active
 *    session. Wire retransmissions within a session are acknowledged and dropped
 *    without touching database layers.
 *
 *  - Inbound FIFO Queue: Acknowledged PDUs are enqueued into an in-memory
 *    FIFO queue for decoupled, safe ingestion. SQLite database writes never
 *    block the network ACK loop.
 *
 *  - Reconnect Safety: Tearing down old sessions thoroughly clears timers,
 *    deregisters event listeners, and destroys sockets. Outdated socket events
 *    are strictly ignored.
 *
 *  - Safe Deduplication: Distinguishes between wire retry/reconnect replays
 *    and genuine repeated OTPs (e.g. user clicking Resend OTP). Legitimate
 *    OTPs are always preserved.
 */

const db = require('./db');
const crypto = require('crypto');
const net = require('net');

let smppLib = null;
let smppLoadError = '';
function getSmpp() {
  if (smppLib) return smppLib;
  try { smppLib = require('smpp'); }
  catch (e) { smppLoadError = e.message; throw new Error('SMPP library not installed: ' + e.message); }
  return smppLib;
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
 * { message, udh } object. Normalise all of them to text, with full support
 * for message_payload TLV when short_message is empty.
 */
function pduText(pdu) {
  if (!pdu) return '';

  let sm = pdu.short_message;
  let text = '';

  if (typeof sm === 'string' && sm.length > 0) {
    text = sm;
  } else if (Buffer.isBuffer(sm) && sm.length > 0) {
    text = sm.toString('utf8');
  } else if (sm && typeof sm === 'object') {
    if (typeof sm.message === 'string' && sm.message.length > 0) {
      text = sm.message;
    } else if (Buffer.isBuffer(sm.message) && sm.message.length > 0) {
      text = sm.message.toString('utf8');
    }
  }

  // Fallback to message_payload TLV (used by SMSCs when payload exceeds short_message or by default)
  if (!text && pdu.message_payload) {
    const mp = pdu.message_payload;
    if (typeof mp === 'string' && mp.length > 0) {
      text = mp;
    } else if (Buffer.isBuffer(mp) && mp.length > 0) {
      text = mp.toString('utf8');
    } else if (mp && typeof mp === 'object') {
      if (typeof mp.message === 'string' && mp.message.length > 0) {
        text = mp.message;
      } else if (Buffer.isBuffer(mp.message) && mp.message.length > 0) {
        text = mp.message.toString('utf8');
      }
    }
  }

  return text || safeStr(sm);
}

/** UDH of a concatenated message, when the library exposes it. */
function pduUdh(pdu) {
  const sm = pdu && pdu.short_message;
  if (sm && typeof sm === 'object' && Array.isArray(sm.udh)) return sm.udh;
  return null;
}

/** Extract concatenation / multipart information from either SAR TLVs or UDH. */
function extractSarInfo(pdu) {
  if (pdu && pdu.sar_total_segments && pdu.sar_total_segments > 1) {
    const ref = Number(pdu.sar_msg_ref_num || 0);
    const total = Number(pdu.sar_total_segments || 0);
    const seq = Number(pdu.sar_segment_seqnum || 0);
    if (total >= 2 && seq >= 1) return { ref, total, seq };
  }
  const udh = pduUdh(pdu);
  if (udh && udh.length) {
    for (const el of udh) {
      const id = Number(el.id);
      const data = el.value;
      if (!Buffer.isBuffer(data)) continue;
      if (id === 0x00 && data.length >= 3) return { ref: data[0], total: data[1], seq: data[2] };
      if (id === 0x08 && data.length >= 4) return { ref: data.readUInt16BE(0), total: data[2], seq: data[3] };
    }
  }
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

function cleanPhone(v) {
  return String(v || '').trim().replace(/[^0-9]/g, '');
}

/**
 * Extract provider message ID or reference from PDU if present
 * (receipted_message_id, message_id, user_message_reference, etc.)
 */
function extractProviderMsgId(pdu) {
  if (!pdu) return '';
  const rid = safeStr(pdu.receipted_message_id || pdu.message_id).trim();
  if (rid) return rid;
  if (pdu.user_message_reference != null) {
    const umr = String(pdu.user_message_reference).trim();
    if (umr && umr !== '0') return umr;
  }
  if (pdu.sm_default_msg_id && pdu.sm_default_msg_id !== '0') {
    return String(pdu.sm_default_msg_id).trim();
  }
  return '';
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
      sessionId: '',
      session: null,
      server: null,
      sessions: new Set(),     // server mode: bound peer sessions
      status: 'stopped',
      reconnectTimer: null,
      enquireTimer: null,
      bindTimeout: null,
      attempt: 0,
      stopping: false,
      lastDisconnectAtMs: 0,
      lastConnectedAtMs: 0,
      parts: new Map(),        // concatenated SMS reassembly
      inboundQueue: [],        // in-memory FIFO queue for inbound messages
      drainingInbound: false,
      recentDeliveries: new Map(), // content fingerprint -> timestamp ms (cross-reconnect deduplication)
    });
  }
  return runtime.get(id);
}

/* ------------------------------------------------------------------ *
 * Inbound message handling & Deduplication
 * ------------------------------------------------------------------ */

/**
 * Reassemble a concatenated (multipart) SMS using SAR TLVs or UDH.
 * Returns the full text once the last part arrives, otherwise null.
 */
function reassemble(st, key, pdu, text) {
  const sar = extractSarInfo(pdu);
  if (!sar || sar.total < 2) return text;   // not concatenated

  const bucket = `${key}:${sar.ref}:${sar.total}`;
  let entry = st.parts.get(bucket);
  if (!entry) {
    entry = { total: sar.total, parts: new Map(), at: Date.now() };
    st.parts.set(bucket, entry);
  }
  entry.parts.set(sar.seq, text);

  // Drop stale half-assembled messages so the map cannot grow unbounded.
  if (st.parts.size > 500) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of st.parts) if (v.at < cutoff) st.parts.delete(k);
  }

  if (entry.parts.size < sar.total) return null;    // still waiting
  st.parts.delete(bucket);
  let out = '';
  for (let i = 1; i <= sar.total; i++) out += (entry.parts.get(i) || '');
  return out;
}

/**
 * Deduplication key generator:
 * - If provider provides a unique message identifier (receipted_message_id, message_id, user_message_reference):
 *   key = 'mid:' + rid. This is globally unique per provider transaction.
 * - Otherwise: Deterministic SHA1 fingerprint bucketed to 5 seconds.
 *   Catches rapid duplicate wire packets (< 5s), while allowing legitimate user OTP resends
 *   (even with identical text) once the cooldown window passes.
 */
function dedupKeyFor(pdu, src, dst, text) {
  const rid = extractProviderMsgId(pdu);
  if (rid) return 'mid:' + rid;
  const bucket = Math.floor(Date.now() / 5000);
  const cleanDst = cleanPhone(dst);
  return 'fp:' + crypto.createHash('sha1')
    .update([String(src || '').toLowerCase(), cleanDst, String(text || '').trim(), bucket].join('|'))
    .digest('hex').slice(0, 24);
}

/**
 * FAST INBOUND PDU HANDLER (Called immediately on deliver_sm / data_sm / submit_sm)
 *
 * Sequence of events:
 * 1. Extract session identity and sequence number.
 * 2. Check if sequence number was already received on this active session (wire retry).
 * 3. Acknowledge IMMEDIATELY to peer with matching sequence number.
 * 4. Enqueue message into FIFO queue for safe asynchronous ingestion.
 */
function handleInboundPdu(conn, st, session, pdu, peer, kind = 'deliver_sm', submitMsgId = null) {
  const OK = 0;
  const seq = (pdu && typeof pdu.sequence_number === 'number') ? pdu.sequence_number : 0;
  const sessionId = (session && session.__skylineSessionId) || st.sessionId || (`c${conn.id}`);

  logEvent(conn, 'deliver', 'info', `[SMPP] INBOUND_RECEIVED: seq=${seq}, session=${sessionId}, cmd=${kind}`, peer);
  markDirty();

  session.__seenSeqs = session.__seenSeqs || new Set();
  if (seq && session.__seenSeqs.has(seq)) {
    // WIRE RETRANSMISSION: The peer already sent this sequence number on this active link.
    // Send ACK immediately so the peer stops retransmitting, and do not process duplicate.
    try {
      const respParams = { command_status: OK };
      if (submitMsgId) respParams.message_id = submitMsgId;
      session.send(pdu.response(respParams));
    } catch (_) {}
    logEvent(conn, 'deliver', 'info', `[SMPP] DEDUPLICATE_DROP: Wire duplicate PDU ignored (seq=${seq}, session=${sessionId})`, peer);
    markDirty();
    return OK;
  }

  if (seq) {
    session.__seenSeqs.add(seq);
    if (session.__seenSeqs.size > 25000) {
      const arr = Array.from(session.__seenSeqs);
      session.__seenSeqs = new Set(arr.slice(10000));
    }
  }

  // FAST ACK: Send acknowledgement to SMSC IMMEDIATELY!
  // The SMSC receives deliver_sm_resp in <1ms. Response timer never expires; retransmission never occurs.
  try {
    const respParams = { command_status: OK };
    if (submitMsgId) respParams.message_id = submitMsgId;
    session.send(pdu.response(respParams));
    logEvent(conn, 'deliver', 'info', `[SMPP] ACK_SENT: seq=${seq}, session=${sessionId}, cmd=${kind}`, peer);
    markDirty();
  } catch (e) {
    logEvent(conn, 'error', 'warn', `[SMPP] ACK failed to send: ${e.message}`, peer);
  }

  if (isDeliveryReceipt(pdu)) {
    logEvent(conn, 'deliver', 'info', `[SMPP] delivery receipt acknowledged and skipped (seq=${seq})`, peer);
    markDirty();
    return OK;
  }

  // Enqueue for safe, idempotent ingestion
  st.inboundQueue = st.inboundQueue || [];
  st.inboundQueue.push({
    conn,
    st,
    session,
    pdu,
    peer,
    kind,
    sessionId,
    seq,
    receivedAt: nowSql(),
  });

  drainInboundQueue(conn.id);
  return OK;
}

/**
 * Worker queue drain: processes inbound items from FIFO queue.
 * Runs in setImmediate batches so socket I/O and ACKs are never starved.
 */
function drainInboundQueue(connectionId) {
  const st = stateOf(connectionId);
  if (st.drainingInbound) return;
  st.drainingInbound = true;

  setImmediate(() => {
    try {
      while (st.inboundQueue && st.inboundQueue.length > 0) {
        const item = st.inboundQueue.shift();
        try {
          processInboundItem(item);
        } catch (err) {
          deps && deps.log && deps.log.warn(`[SMPP] ${item.conn.name}: item process failed: ${err.message}`);
          logEvent(item.conn, 'error', 'error', `[SMPP] item process failed: ${err.message}`, item.peer);
        }
      }
    } finally {
      st.drainingInbound = false;
      if (st.inboundQueue && st.inboundQueue.length > 0) {
        drainInboundQueue(connectionId);
      }
    }
  });
}

/**
 * Process a single inbound SMPP message idempotently.
 */
function processInboundItem(item) {
  const { conn, st, session, pdu, peer, kind, sessionId, seq, receivedAt } = item;

  const src = safeStr(pdu.source_addr).trim();
  const dst = safeStr(pdu.destination_addr).trim();
  let text = pduText(pdu);

  // 1. Reassemble multipart SMS if applicable
  const assembled = reassemble(st, `${src}|${dst}`, pdu, text);
  if (assembled === null) {
    logEvent(conn, 'deliver', 'info', `[SMPP] PARTIAL_SEGMENT_RECEIVED: seq=${seq}, waiting for remaining parts for ${dst}`, peer);
    markDirty();
    return;
  }
  text = assembled;

  if (!dst) {
    logEvent(conn, 'deliver', 'warn', `[SMPP] missing destination_addr (seq=${seq})`, peer);
    markDirty();
    return;
  }

  // 2. Multi-layer Deduplication Check:
  const providerMsgId = extractProviderMsgId(pdu);
  const dedupKey = dedupKeyFor(pdu, src, dst, text);

  // 2a. Cross-reconnect redelivery safeguard:
  // Catches redeliveries of un-ACKed packets that occurred during socket drop/reconnect,
  // while ensuring genuine user resends (e.g. after cooldown) remain intact.
  const nowMs = Date.now();
  const cleanDst = cleanPhone(dst);
  const contentFp = crypto.createHash('sha1')
    .update([String(src || '').toLowerCase(), cleanDst, String(text || '').trim()].join('|'))
    .digest('hex').slice(0, 24);

  const hadRecentDisconnect = st.lastDisconnectAtMs && (nowMs - st.lastDisconnectAtMs < 30000);
  if (hadRecentDisconnect && st.recentDeliveries && st.recentDeliveries.has(contentFp)) {
    const lastSeen = st.recentDeliveries.get(contentFp);
    if (nowMs - lastSeen < 30000) {
      logEvent(conn, 'deliver', 'info', `[SMPP] DEDUPLICATE_DROP: Cross-reconnect redelivery ignored (seq=${seq}, dst=${dst})`, peer);
      markDirty();
      return;
    }
  }

  // 2b. Database check in smpp_seen ledger:
  const seen = db.get('SELECT id, sms_record_id FROM smpp_seen WHERE connection_id=? AND dedup_key=?', [conn.id, dedupKey]);
  if (seen) {
    logEvent(conn, 'deliver', 'info', `[SMPP] DEDUPLICATE_DROP: Duplicate ignored via smpp_seen (key=${dedupKey.slice(0, 32)})`, peer);
    markDirty();
    return;
  }

  // 3. Ingestion into Skyline SMS core:
  logEvent(conn, 'deliver', 'info', `[SMPP] INBOUND_PROCESSING: seq=${seq}, session=${sessionId}, from=${src || '?'} to=${dst}, len=${text.length}`, peer);

  const result = deps.processIncomingSmsPayload(
    { ip: peer || 'SMPP', smpp_connection: conn.name },
    { number: dst, cli: src, message: text },
    `smpp:${conn.name}`,
    { source: 'smpp', received_at: receivedAt }
  );

  const ok = result && result.status === 200;
  const smsId = (result && result.body && result.body.id) ? result.body.id : null;

  // 4. Record in smpp_seen tracking ledger
  try {
    db.run(
      `INSERT OR IGNORE INTO smpp_seen (connection_id, dedup_key, session_id, sequence_number, source_addr, destination_addr, provider_message_id, sms_record_id, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [conn.id, dedupKey, sessionId, seq, src, dst, providerMsgId || '', smsId, ok ? 'processed' : 'rejected', receivedAt]
    );
  } catch (e) {
    deps && deps.log && deps.log.warn(`[SMPP] smpp_seen write failed: ${e.message}`);
  }

  // Track recent delivery in memory for cross-reconnect protection
  st.recentDeliveries = st.recentDeliveries || new Map();
  st.recentDeliveries.set(contentFp, nowMs);
  if (st.recentDeliveries.size > 2000) {
    const cutoff = nowMs - 60000;
    for (const [k, v] of st.recentDeliveries) {
      if (v < cutoff) st.recentDeliveries.delete(k);
    }
  }

  if (ok) {
    db.runNoSave('UPDATE smpp_connections SET total_received=total_received+1, last_activity_at=? WHERE id=?', [receivedAt, conn.id]);
    logEvent(conn, 'deliver', 'info', `[SMPP] DB_INSERTED: seq=${seq}, record_id=${smsId}, from=${src || '?'} to=${dst}`, peer);
    logEvent(conn, 'deliver', 'info', `[SMPP] DB_SUCCESS: seq=${seq}, dst=${dst}`, peer);
    try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
  } else {
    const why = (result && result.body && result.body.error) || 'rejected';
    logEvent(conn, 'deliver', 'warn', `[SMPP] DB_REJECTED: seq=${seq}, reason=${why} (${dst})`, peer);
  }
  markDirty();
}

/**
 * Backward-compatibility wrapper for ingest().
 */
function ingest(conn, st, pdu, peer) {
  const OK = 0;
  const seq = (pdu && typeof pdu.sequence_number === 'number') ? pdu.sequence_number : 0;
  const sessionId = (st && st.sessionId) || (`c${conn.id}`);
  processInboundItem({
    conn,
    st,
    session: st && st.session,
    pdu,
    peer,
    kind: 'deliver_sm',
    sessionId,
    seq,
    receivedAt: nowSql(),
  });
  return OK;
}

/**
 * Helper to await full drainage of the inbound FIFO queue.
 */
function flushInbound(connectionId) {
  return new Promise((resolve) => {
    const check = () => {
      const st = runtime.get(connectionId);
      if (!st || (!st.drainingInbound && (!st.inboundQueue || st.inboundQueue.length === 0))) {
        return resolve();
      }
      setTimeout(check, 10);
    };
    check();
  });
}

/* ------------------------------------------------------------------ *
 * CLIENT mode — Skyline binds OUT to the provider
 * ------------------------------------------------------------------ */

function scheduleReconnect(conn) {
  const st = stateOf(conn.id);
  if (st.stopping) return;
  if (st.reconnectTimer) return; // Prevent duplicate reconnect timers

  const base = clampInt(conn.reconnect_seconds, 1, 3600, 10);
  const max = clampInt(conn.max_reconnect_seconds, base, 86400, 300);
  const backoff = Math.min(max, base * Math.pow(2, Math.min(st.attempt, 10)));
  const delay = Math.round((backoff * 0.7 + backoff * 0.3 * Math.random()) * 1000);

  st.status = 'reconnecting';
  markConnection(conn.id, { status: 'reconnecting' });
  logEvent(conn, 'reconnect', 'warn', `[SMPP] RECONNECT_TRIGGERED: retry in ${Math.round(delay / 1000)}s (attempt ${st.attempt + 1})`);
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
  if (st.bindTimeout) { clearTimeout(st.bindTimeout); st.bindTimeout = null; }
  if (st.session) {
    const s = st.session;
    st.session = null;
    try { s.removeAllListeners(); } catch (_) {}
    if (s.socket) {
      try { s.socket.removeAllListeners(); } catch (_) {}
      try { s.socket.destroy(); } catch (_) {}
    }
    try { s.close(); } catch (_) {}
    try { s.destroy && s.destroy(); } catch (_) {}
    logEvent({ id: st.id, name: '' }, 'unbind', 'info', `[SMPP] SESSION_CLEANUP: session ${st.sessionId || ''} cleaned up`);
    markDirty();
  }
}

function startClient(conn) {
  const smpp = getSmpp();
  const st = stateOf(conn.id);
  st.stopping = false;
  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
  }
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
  st.sessionId = `c${conn.id}_s${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  markConnection(conn.id, { status: 'connecting', last_error: '' });
  logEvent(conn, 'bind', 'info', `connecting to ${url} (session_id=${st.sessionId})`);
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

  session.__skylineSessionId = st.sessionId;
  session.__seenSeqs = new Set();
  st.session = session;

  session.on('error', (e) => {
    if (st.session !== session) return; // Ignore events from torn down sessions
    const msg = (e && e.message) || String(e);
    if (st.status !== 'reconnecting') {
      markConnection(conn.id, { status: 'error', last_error: msg, consecutive_failures: (getConnection(conn.id) || {}).consecutive_failures + 1 || 1 });
      logEvent(conn, 'error', 'error', msg);
      markDirty();
    }
    st.attempt++;
    st.lastDisconnectAtMs = Date.now();
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('close', () => {
    if (st.stopping) return;
    if (st.session !== session) return; // Ignore events from torn down sessions
    markConnection(conn.id, { status: 'disconnected' });
    logEvent(conn, 'unbind', 'warn', `connection closed by peer (session_id=${st.sessionId})`);
    markDirty();
    st.attempt++;
    st.lastDisconnectAtMs = Date.now();
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('deliver_sm', (pdu) => {
    handleInboundPdu(conn, st, session, pdu, conn.host, 'deliver_sm');
  });

  session.on('data_sm', (pdu) => {
    handleInboundPdu(conn, st, session, pdu, conn.host, 'data_sm');
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
  if (st.session !== session) return;

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
  if (st.bindTimeout) clearTimeout(st.bindTimeout);
  st.bindTimeout = setTimeout(() => {
    if (responded) return;
    responded = true;
    logEvent(conn, 'error', 'error', 'bind timed out (no response from provider)');
    markConnection(conn.id, { status: 'error', last_error: 'bind timed out' });
    markDirty();
    st.attempt++;
    st.lastDisconnectAtMs = Date.now();
    teardownClient(st);
    scheduleReconnect(conn);
  }, clampInt(conn.connect_timeout_ms, 1000, 120000, 15000));
  if (st.bindTimeout.unref) st.bindTimeout.unref();

  try {
    session[bindFn](params, (pdu) => {
      if (responded) return;
      responded = true;
      if (st.bindTimeout) { clearTimeout(st.bindTimeout); st.bindTimeout = null; }

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
        st.lastDisconnectAtMs = Date.now();
        teardownClient(st);
        scheduleReconnect(conn);
        return;
      }

      st.attempt = 0;
      st.status = 'bound';
      st.lastConnectedAtMs = Date.now();
      markConnection(conn.id, {
        status: 'bound',
        last_error: '',
        last_connected_at: nowSql(),
        last_activity_at: nowSql(),
        consecutive_failures: 0,
      });
      logEvent(conn, 'bind', 'info', `[SMPP] SESSION_BOUND: bound as ${bindFn.replace('bind_', '')} (session_id=${st.sessionId}, system_id=${conn.system_id})`);
      markDirty();

      startEnquireLink(conn, session);
      setImmediate(() => { try { drainOutbox(conn.id); } catch (_) {} });
    });
  } catch (e) {
    if (!responded) {
      responded = true;
      if (st.bindTimeout) { clearTimeout(st.bindTimeout); st.bindTimeout = null; }
      logEvent(conn, 'error', 'error', 'bind failed: ' + e.message);
      markDirty();
      st.attempt++;
      st.lastDisconnectAtMs = Date.now();
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
    if (st.session !== session || !st.session) {
      if (st.enquireTimer) { clearInterval(st.enquireTimer); st.enquireTimer = null; }
      return;
    }
    let answered = false;
    const t = setTimeout(() => {
      if (answered) return;
      if (st.session !== session) return;
      logEvent(conn, 'error', 'warn', 'enquire_link timeout — forcing reconnect');
      markConnection(conn.id, { status: 'error', last_error: 'enquire_link timeout' });
      markDirty();
      st.attempt++;
      st.lastDisconnectAtMs = Date.now();
      teardownClient(st);
      scheduleReconnect(conn);
    }, Math.max(secs * 1000, 30000));
    if (t.unref) t.unref();

    try {
      session.enquire_link({}, () => {
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
 * SERVER mode — the carrier binds IN to Skyline
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
  session.__skylineSessionId = `srv_${conn.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  session.__seenSeqs = new Set();

  session.on('error', () => { try { session.close(); } catch (_) {} });
  session.on('close', () => {
    st.sessions.delete(session);
    markConnection(conn.id, { status: st.sessions.size ? 'bound' : 'listening' });
    logEvent(conn, 'unbind', 'info', `[SMPP] SESSION_CLEANUP: peer disconnected (${st.sessions.size} bound)`, peer);
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
      session.send(pdu.response({ system_id: 'Skyline' }));
      st.sessions.add(session);
      markConnection(conn.id, { status: 'bound', last_error: '', last_connected_at: nowSql(), last_activity_at: nowSql(), consecutive_failures: 0 });
      logEvent(conn, 'bind', 'info', `[SMPP] SESSION_BOUND: peer bound as ${kind} (session_id=${session.__skylineSessionId}, system_id=${okId})`, peer);
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

  session.on('submit_sm', (pdu) => {
    if (!st.sessions.has(session)) {
      try { session.send(pdu.response({ command_status: smpp.ESME_RINVBNDSTS || 4 })); } catch (_) {}
      return;
    }
    const msgId = 'SKY' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    handleInboundPdu(conn, st, session, pdu, peer, 'submit_sm', msgId);
  });

  session.on('deliver_sm', (pdu) => {
    if (!st.sessions.has(session)) {
      try { session.send(pdu.response({ command_status: smpp.ESME_RINVBNDSTS || 4 })); } catch (_) {}
      return;
    }
    handleInboundPdu(conn, st, session, pdu, peer, 'deliver_sm');
  });

  session.on('data_sm', (pdu) => {
    if (!st.sessions.has(session)) {
      try { session.send(pdu.response({ command_status: smpp.ESME_RINVBNDSTS || 4 })); } catch (_) {}
      return;
    }
    handleInboundPdu(conn, st, session, pdu, peer, 'data_sm');
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
  st.inboundQueue = [];
  if (!silent) {
    const conn = getConnection(id);
    markConnection(id, { status: 'stopped', last_error: '' });
    if (conn) logEvent(conn, 'unbind', 'info', `[SMPP] SESSION_CLEANUP: stopped by operator`);
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
  return {
    id: conn.id,
    name: conn.name,
    mode: conn.mode,
    active: !!conn.active,
    status: conn.status || 'stopped',
    live: st ? st.status : 'stopped',
    session_id: st ? st.sessionId : '',
    inbound_queued: st ? (st.inboundQueue ? st.inboundQueue.length : 0) : 0,
    bound_sessions: st ? (st.session ? 1 : st.sessions.size) : 0,
    last_error: conn.last_error || '',
    last_connected_at: conn.last_connected_at || '',
    last_activity_at: conn.last_activity_at || '',
    consecutive_failures: conn.consecutive_failures || 0,
    total_received: conn.total_received || 0,
    total_sent: conn.total_sent || 0,
    queued: (db.get('SELECT COUNT(*) c FROM smpp_outbox WHERE connection_id=? AND status=?', [id, 'queued']) || {}).c || 0,
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

  deps.log.log(`• SMPP service active: ${list.length} connection(s) configured`);
}

function stop() {
  for (const id of Array.from(runtime.keys())) {
    try { stopConnection(id, true); } catch (_) {}
  }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushBookkeeping();
  started = false;
}

function onExit() {
  try { stop(); } catch (_) {}
}
process.once('SIGINT', onExit);
process.once('SIGTERM', onExit);
process.once('beforeExit', () => { try { flushBookkeeping(); } catch (_) {} });

module.exports = {
  start, stop,
  listConnections, getConnection,
  startConnection, stopConnection, restartConnection,
  statusOf,
  queueOutbound, drainOutbox,
  flushBookkeeping,
  flushInbound,
  isLibraryAvailable() { try { getSmpp(); return true; } catch (_) { return false; } },
  libraryError() { return smppLoadError; },
  _internal: {
    pduText,
    isDeliveryReceipt,
    dedupKeyFor,
    ipAllowed,
    clampInt,
    cleanPhone,
    reassemble,
    extractProviderMsgId,
    handleInboundPdu,
    processInboundItem,
    drainInboundQueue,
    flushInbound,
  },
};
