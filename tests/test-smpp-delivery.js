/**
 * Comprehensive SMPP Delivery & Ingestion Verification Suite
 * Tests actual backend/smppService.js against a live Mock SMSC server.
 */
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test-smpp-live.sqlite');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

process.env.DB_FILE = TEST_DB;

const Database = require('better-sqlite3');
const origDb = new Database(path.join(__dirname, '../backend/data.sqlite'));

origDb.backup(TEST_DB).then(async () => {
  origDb.close();
  const testDb = new Database(TEST_DB);

  testDb.exec(`
    DELETE FROM numbers;
    DELETE FROM sms_records;
    DELETE FROM smpp_seen;
    DELETE FROM smpp_logs;
    INSERT INTO users (id, username, password, role, active) VALUES (1, 'admin', 'dummy', 'admin', 1) ON CONFLICT(id) DO NOTHING;
    INSERT INTO ranges (id, name, prefix, country, payment_type, rate_1_1, rate_7_1, rate_7_7, rate_30_45)
      VALUES (1, 'UK JV 01', '447', 'UK', 'Weekly', '0.05', '0.05', '0.05', '0.05') ON CONFLICT(id) DO NOTHING;
    INSERT INTO numbers (id, number, range_id, rate, payout)
      VALUES (1, '+447571897329', 1, '0.05', '0.05');
    INSERT OR REPLACE INTO smpp_connections (id, name, host, port, system_id, password, bind_type, mode, active, enquire_link_seconds, reconnect_seconds)
      VALUES (1, 'TECH_MOCK', '127.0.0.1', 27751, 'skyline', 'secret', 'transceiver', 'client', 1, 30, 5);
  `);

  const smpp = require('smpp');
  const db = require('../backend/db');
  await db.init();
  const smppService = require('../backend/smppService');

  let smscSession = null;
  const server = smpp.createServer({}, (session) => {
    session.on('bind_transceiver', (pdu) => {
      session.send(pdu.response({ system_id: 'MOCK_SMSC' }));
      smscSession = session;
    });
    session.on('enquire_link', (pdu) => {
      session.send(pdu.response());
    });
  });

  await new Promise((resolve) => server.listen(27751, resolve));
  console.log('[MOCK_SMSC] Server listening on 27751');

  // Realistic mock of processIncomingSmsPayload from server.js
  const mockProcessIncoming = (req, payload, sourceIp, opts) => {
    const exact = String(payload.number || '').trim();
    const cleanDst = exact.replace(/[^0-9]/g, '');
    const num = testDb.prepare("SELECT * FROM numbers WHERE REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-','')=?").get(cleanDst);
    if (!num) return { status: 404, body: { error: 'Number not found/allocated' } };
    
    const info = testDb.prepare(`
      INSERT INTO sms_records (number_id, number, range_id, cli, message, otp_code, is_test, source, received_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'smpp', datetime('now'))
    `).run(num.id, num.number, num.range_id, payload.cli, payload.message, payload.message.match(/\b\d{4,8}\b/)?.[0] || '');
    return { status: 200, body: { ok: true, id: info.lastInsertRowid } };
  };

  smppService.start({
    log: console,
    processIncomingSmsPayload: mockProcessIncoming,
    clearApiReadCache: () => {}
  });

  for (let i = 0; i < 50; i++) {
    if (smscSession) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!smscSession) throw new Error('SMPP client failed to bind!');
  console.log('✓ SMPP client successfully bound to Mock SMSC!\n');

  function sendDeliverSm(params) {
    return new Promise((resolve) => {
      const pdu = new smpp.PDU('deliver_sm');
      Object.assign(pdu, params);
      smscSession.deliver_sm(pdu, (resp) => {
        resolve(resp);
      });
    });
  }

  console.log('====================================================');
  console.log('TEST 1: Legitimate OTP Resend Sequence on SAME Phone & SAME App');
  console.log('  - OTP 1: WhatsApp sends code 888123');
  console.log('  - Duplicate wire packet at 0s (should be suppressed)');
  console.log('  - OTP 2: User resends after 6s (WhatsApp resends code 888123) -> MUST BE RECEIVED');
  console.log('  - OTP 3: User resends after 12s (WhatsApp resends code 888123) -> MUST BE RECEIVED');
  console.log('  - OTP 4: Code expires, new code 999456 generated -> MUST BE RECEIVED');
  console.log('====================================================');

  const countBefore1 = testDb.prepare("SELECT count(*) as c FROM sms_records").get().c;

  // OTP 1
  await sendDeliverSm({
    source_addr: 'WhatsApp',
    destination_addr: '447571897329',
    short_message: 'Your WhatsApp code is 888123'
  });

  // Rapid duplicate on wire (< 5s)
  await sendDeliverSm({
    source_addr: 'WhatsApp',
    destination_addr: '447571897329',
    short_message: 'Your WhatsApp code is 888123'
  });

  // Advance time past 5s window to simulate user clicking resend
  const origNow = Date.now;
  Date.now = () => origNow() + 6000;
  await sendDeliverSm({
    source_addr: 'WhatsApp',
    destination_addr: '447571897329',
    short_message: 'Your WhatsApp code is 888123'
  });

  Date.now = () => origNow() + 12000;
  await sendDeliverSm({
    source_addr: 'WhatsApp',
    destination_addr: '447571897329',
    short_message: 'Your WhatsApp code is 888123'
  });

  Date.now = () => origNow() + 60000;
  await sendDeliverSm({
    source_addr: 'WhatsApp',
    destination_addr: '447571897329',
    short_message: 'Your WhatsApp code is 999456'
  });

  Date.now = origNow;

  const countAfter1 = testDb.prepare("SELECT count(*) as c FROM sms_records").get().c;
  const records1 = testDb.prepare("SELECT id, number, cli, message, otp_code FROM sms_records WHERE id > ? ORDER BY id ASC").all(countBefore1);
  console.log(`Test 1 Result: ${records1.length} records stored in DB (Expected 4):`);
  records1.forEach(r => console.log(`  [ID ${r.id}] CLI: ${r.cli} | Code: ${r.otp_code} | Msg: ${r.message}`));
  const test1Pass = records1.length === 4;
  console.log('Test 1 Passed:', test1Pass ? 'YES' : 'NO');

  console.log('\n====================================================');
  console.log('TEST 2: message_payload TLV Message Delivery');
  console.log('====================================================');
  const maxIdBefore2 = testDb.prepare("SELECT COALESCE(MAX(id), 0) as m FROM sms_records").get().m;

  await sendDeliverSm({
    source_addr: 'Google',
    destination_addr: '447571897329',
    short_message: '',
    message_payload: 'Your Google verification code is 445566'
  });

  const record2 = testDb.prepare("SELECT id, number, cli, message, otp_code FROM sms_records WHERE id > ? ORDER BY id DESC LIMIT 1").get(maxIdBefore2);
  console.log('Test 2 Result:', record2 ? `[ID ${record2.id}] Code: "${record2.otp_code}" | Msg: "${record2.message}"` : 'FAILED');
  const test2Pass = record2 && record2.otp_code === '445566' && record2.message.includes('445566');
  console.log('Test 2 Passed:', test2Pass ? 'YES' : 'NO');

  console.log('\n====================================================');
  console.log('TEST 3: SAR TLV Concatenated SMS Reassembly');
  console.log('====================================================');
  const maxIdBefore3 = testDb.prepare("SELECT COALESCE(MAX(id), 0) as m FROM sms_records").get().m;

  // Segment 1
  await sendDeliverSm({
    source_addr: 'BankAuth',
    destination_addr: '447571897329',
    sar_msg_ref_num: 555,
    sar_total_segments: 2,
    sar_segment_seqnum: 1,
    short_message: 'Security Alert from Bank: You have requested an online transfer. '
  });

  // Segment 2
  await sendDeliverSm({
    source_addr: 'BankAuth',
    destination_addr: '447571897329',
    sar_msg_ref_num: 555,
    sar_total_segments: 2,
    sar_segment_seqnum: 2,
    short_message: 'Your one-time authorization code is 987654. Do not share.'
  });

  const record3 = testDb.prepare("SELECT id, number, cli, message, otp_code FROM sms_records WHERE id > ? ORDER BY id DESC LIMIT 1").get(maxIdBefore3);
  console.log('Test 3 Result:', record3 ? `[ID ${record3.id}] Code: "${record3.otp_code}" | Msg: "${record3.message}"` : 'FAILED');
  const test3Pass = record3 && record3.otp_code === '987654' && record3.message.includes('Security Alert') && record3.message.includes('987654');
  console.log('Test 3 Passed:', test3Pass ? 'YES' : 'NO');

  console.log('\n====================================================');
  console.log('FINAL VERIFICATION SUMMARY:');
  console.log(`  - Test 1 (OTP Resend on same number/app): ${test1Pass ? 'PASSED ✓' : 'FAILED ✗'}`);
  console.log(`  - Test 2 (message_payload TLV extraction): ${test2Pass ? 'PASSED ✓' : 'FAILED ✗'}`);
  console.log(`  - Test 3 (Concatenated SAR TLV reassembly): ${test3Pass ? 'PASSED ✓' : 'FAILED ✗'}`);
  console.log('====================================================');

  smppService.stop();
  server.close();
  testDb.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  if (!test1Pass || !test2Pass || !test3Pass) {
    process.exit(1);
  }
}).catch(e => {
  console.error('Test failed with error:', e);
  process.exit(1);
});
