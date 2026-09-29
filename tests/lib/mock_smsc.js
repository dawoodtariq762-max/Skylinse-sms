'use strict';
/**
 * Shared helpers for the end-to-end suite.
 *
 * The mock SMSC speaks just enough SMPP 3.4 over TCP for node-smpp's client
 * mode: it answers bind_transceiver / enquire_link / unbind and pushes
 * deliver_sm PDUs (including UDH multipart and message_payload TLVs). Every
 * response the real backend sends back is recorded, so the tests can assert on
 * the ACK status the SMSC would have seen.
 *
 * The PDU encoder here is deliberately hand-written from the spec (3.4.7.1
 * deliver_sm field order) rather than borrowed from the library that parses it,
 * so the test is not checking the library against itself.
 */

const net = require('net');
const http = require('http');

const CMD = {
  BIND_RECEIVER: 0x00000001,
  BIND_TRANSMITTER: 0x00000002,
  DELIVER_SM: 0x00000005,
  UNBIND: 0x00000006,
  BIND_TRANSCEIVER: 0x00000009,
  DATA_SM: 0x00000103,
  ENQUIRE_LINK: 0x00000015,
};

function cstr(s) { return Buffer.from(String(s == null ? '' : s) + '\0', 'latin1'); }
function latin(s) { return Buffer.from(String(s == null ? '' : s), 'latin1'); }

function tlv(tag, val) {
  const v = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'latin1');
  const b = Buffer.alloc(4 + v.length);
  b.writeUInt16BE(tag, 0);
  b.writeUInt16BE(v.length, 2);
  v.copy(b, 4);
  return b;
}

function pdu(cmd, status, seq, body) {
  const b = Buffer.alloc(16 + (body ? body.length : 0));
  b.writeUInt32BE(16 + (body ? body.length : 0), 0);
  b.writeUInt32BE(cmd >>> 0, 4);
  b.writeUInt32BE(status >>> 0, 8);
  b.writeUInt32BE(seq, 12);
  if (body) body.copy(b, 16);
  return b;
}

/**
 * deliver_sm per SMPP 3.4 §4.6.1 (deliver_sm / 3.4.7.1).
 * opts: {seq, smid, src, dst, text, udh:[bytes], payload:string, esm, idTlv, status}
 */
function buildDeliverSm(opts = {}) {
  const f = [];
  f.push(cstr(opts.serviceType || ''));
  f.push(Buffer.from([opts.srcTon === undefined ? 5 : opts.srcTon, opts.srcNpi || 0]));
  f.push(cstr(opts.src));
  f.push(Buffer.from([opts.dstTon === undefined ? 1 : opts.dstTon, opts.dstNpi === undefined ? 1 : opts.dstNpi]));
  f.push(cstr(opts.dst));
  const hasUdh = !!(opts.udh && opts.udh.length);
  const esm = opts.esm !== undefined ? opts.esm : (hasUdh ? 0x40 : 0x00);
  f.push(Buffer.from([esm, opts.protocolId || 0, opts.priority || 0]));
  f.push(cstr(opts.schedule || ''));
  f.push(cstr(opts.validity || ''));
  f.push(Buffer.from([opts.registered || 0, opts.replace || 0, opts.dataCoding === undefined ? 0 : opts.dataCoding, opts.defaultMsgId || 0]));

  const text = opts.text === undefined ? '' : String(opts.text);
  const sm = opts.payload != null
    ? null
    : Buffer.concat([hasUdh ? Buffer.from(opts.udh) : Buffer.alloc(0), latin(text)]);
  f.push(Buffer.from([sm ? sm.length : 0]));
  if (sm) f.push(sm);

  if (opts.smid != null && opts.idTlv !== 0) f.push(tlv(opts.idTlv === undefined ? 0x001e : opts.idTlv, cstr(opts.smid)));
  if (opts.payload != null) f.push(tlv(0x0424, latin(opts.payload)));
  if (opts.extraTlvs) for (const t of opts.extraTlvs) f.push(t);

  return pdu(CMD.DELIVER_SM, opts.status || 0, opts.seq || 1, Buffer.concat(f));
}

class MockSmsc {
  constructor() {
    this.resps = [];      // every response the backend sent us
    this.requests = [];
    this.sessions = [];   // one entry per inbound TCP session, newest last
    this.sock = null;
    this.binds = 0;
    this.server = net.createServer((s) => this._onConn(s));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  _onConn(sock) {
    this.sock = sock;
    const session = { sock, buf: Buffer.alloc(0), binds: 0, closed: false };
    this.sessions.push(session);
    sock.on('data', (d) => { session.buf = Buffer.concat([session.buf, d]); this._drain(session); });
    sock.on('error', () => {});
    sock.on('close', () => { session.closed = true; if (this.sock === sock) this.sock = null; });
  }

  /** Newest TCP session that completed a bind — used when a second panel
   *  process (the restart probe) binds to the same mock. */
  latestBoundSession() {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s.binds > 0 && !s.closed) return s;
    }
    return null;
  }

  _drain(session) {
    while (session.buf.length >= 4) {
      const len = session.buf.readUInt32BE(0);
      if (len < 16 || session.buf.length < len) break;
      const raw = session.buf.subarray(0, len);
      session.buf = session.buf.subarray(len);
      this._onPdu(raw, session);
    }
  }

  _onPdu(raw, session) {
    const cmd = raw.readUInt32BE(4);
    const status = raw.readUInt32BE(8);
    const seq = raw.readUInt32BE(12);
    const isResp = (cmd >>> 0) >= 0x80000000;
    if (isResp) this.resps.push({ cmd, status, seq });
    else {
      this.requests.push({ cmd, seq });
      if (cmd === CMD.BIND_TRANSCEIVER || cmd === CMD.BIND_RECEIVER || cmd === CMD.BIND_TRANSMITTER) {
        this.binds++;
        if (session) session.binds++;
        const body = Buffer.concat([cstr('MOCKSMS'), tlv(0x0210, Buffer.from([0x34]))]);
        this._write(pdu((cmd | 0x80000000) >>> 0, 0, seq, body), session);
      } else if (cmd === CMD.ENQUIRE_LINK) {
        this._write(pdu(0x80000015, 0, seq), session);
      } else if (cmd === CMD.UNBIND) {
        this._write(pdu(0x80000006, 0, seq), session);
      }
    }
  }

  _write(b, session) {
    const s = session || (this.latestBoundSession()) || { sock: this.sock };
    if (s && s.sock && !s.sock.destroyed) s.sock.write(b);
  }

  /** Push a deliver_sm and return its sequence number. */
  deliver(opts) { const seq = opts.seq; this._write(buildDeliverSm(opts)); return seq; }

  /** Push a deliver_sm onto a specific session (the restart probe's session). */
  deliverTo(session, opts) { session.sock.write(buildDeliverSm(opts)); return opts.seq; }

  /** The last response the backend sent for the given sequence number. */
  respFor(seq, kind) {
    const k = kind || 0x80000005; // deliver_sm_resp
    const list = this.resps.filter((r) => r.seq === seq && r.cmd === k);
    return list.length ? list[list.length - 1] : null;
  }

  close() { try { this.server.close(); } catch (_) {} try { this.sock && this.sock.destroy(); } catch (_) {} }
}

/* ---------------- panel boot / HTTP helpers ---------------- */

function bootPanel(env) {
  const ROOT = process.env.PANEL_DIR || '/home/user/panel-fix';
  Object.assign(process.env, env || {});
  const db = require(ROOT + '/backend/db');
  const smppService = require(ROOT + '/backend/smppService');
  require(ROOT + '/backend/server');
  return { db, smppService, ROOT };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(db, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const u = db.get('SELECT COUNT(*) c FROM users');
      const t = db.get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('sms_records','sms_dedup_ledger')");
      if (u && u.c > 0 && t && t.c >= 1) return true;
    } catch (_) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('panel did not become ready');
    await sleep(150);
  }
}

function api(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(port, username = 'vibepk', password = 'vibepk123') {
  const r = await api(port, 'POST', '/api/login', { username, password });
  if (r.status !== 200) throw new Error('login failed: ' + r.status + ' ' + r.raw.slice(0, 200));
  const token = r.body && (r.body.token || r.body.access_token || (r.body.data && r.body.data.token));
  if (!token) throw new Error('login returned no token: ' + r.raw.slice(0, 200));
  return token;
}

module.exports = { CMD, buildDeliverSm, cstr, tlv, pdu, latin, MockSmsc, bootPanel, api, login, sleep, waitReady };
