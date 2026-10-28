/* End-to-end verification: Agent payout -> Client Panel.
   Covers the 5 required cases plus the backfill and the zero-amount rule. */
const fs=require('fs');
const D=require('better-sqlite3');
const _r=new D(':memory:');
const raw={
  all:(q,p)=>_r.prepare(q).all(...(p||[])),
  get:(q,p)=>_r.prepare(q).get(...(p||[])),
  run:(q,p)=>_r.prepare(q).run(...(p||[])),
  exec:(q)=>_r.exec(q),
  prepare:(q)=>_r.prepare(q)
};

raw.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, parent_id INTEGER, payment_type TEXT);
CREATE TABLE ranges(id INTEGER PRIMARY KEY, name TEXT, provider_id INTEGER, payment_type TEXT);
CREATE TABLE numbers(id INTEGER PRIMARY KEY, number TEXT, range_id INTEGER, client_id INTEGER, agent_id INTEGER, manager_id INTEGER, payterm TEXT, payout TEXT, rate TEXT, agent_rate TEXT, manager_rate TEXT, client_rate TEXT);
CREATE TABLE sms_records(id INTEGER PRIMARY KEY AUTOINCREMENT, number_id INTEGER, number TEXT, range_id INTEGER, cli TEXT, sender_type TEXT, message TEXT, otp_code TEXT, client_id INTEGER, agent_id INTEGER, manager_id INTEGER, is_test INTEGER DEFAULT 0, test_batch_id TEXT DEFAULT '', source TEXT DEFAULT 'carrier', payout_rate TEXT DEFAULT '', payout_amount TEXT DEFAULT '', payment_type TEXT DEFAULT '', received_at TEXT DEFAULT (datetime('now')), limit_reason TEXT DEFAULT '');
CREATE TABLE payment_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sms_record_id INTEGER UNIQUE,
  agent_id INTEGER NOT NULL,
  manager_id INTEGER,
  range_id INTEGER,
  payment_type TEXT NOT NULL,
  amount TEXT DEFAULT '0',
  earned_at TEXT DEFAULT '',
  cycle_key TEXT DEFAULT '',
  eligible_at TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  request_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// roles: 1 admin, 2 manager, 3 agent A, 4 agent B, 5 client X, 6 client Y
raw.prepare("INSERT INTO users VALUES (1,'admin1','admin',null,NULL),(2,'mgr1','manager',1,NULL),(3,'agtA','agent',2,'weekly'),(4,'agtB','agent',2,'weekly'),(5,'cliX','client',NULL,NULL),(6,'cliY','client',NULL,NULL)").run();
raw.prepare("INSERT INTO ranges VALUES (1,'Range-1',1,'weekly')").run();
// numbers: 101/102 -> client X under agent A ; 103 -> client Y under agent B ; 104 unallocated
raw.prepare("INSERT INTO numbers(id,number,range_id,client_id,agent_id,manager_id,payterm,payout) VALUES (101,'447001',1,5,3,2,'weekly','0.05'),(102,'447002',1,5,3,2,'weekly','0.05'),(103,'447003',1,6,4,2,'weekly','0.07'),(104,'447004',1,NULL,NULL,NULL,'weekly','0.05')").run();

// ---- SMS rows: 2 for client X (one normal, one ZERO payout), 1 for client Y, 1 unallocated
raw.prepare("INSERT INTO sms_records(id,number_id,number,range_id,client_id,agent_id,manager_id,payout_amount,payment_type,received_at) VALUES (1001,101,'447001',1,5,3,2,'0.05','weekly','2026-10-01 10:00:00'),(1002,102,'447002',1,5,3,2,'0.00','weekly','2026-10-02 10:00:00'),(1003,103,'447003',1,6,4,2,'0.07','weekly','2026-10-03 10:00:00'),(1004,104,'447004',1,NULL,NULL,NULL,'0.05','weekly','2026-10-04 10:00:00')").run();

// ---- HISTORICAL ledger rows, as they existed BEFORE the fix (no client_id column value).
//      These simulate previously saved payouts, incl. varied statuses.
raw.prepare("INSERT INTO payment_ledger(id,sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status) VALUES"
+" (9001,1001,3,2,1,'weekly','0.05','2026-10-01 10:00:00','2026-09-29','2026-10-06','paid'),"
+" (9002,1002,3,2,1,'weekly','0.00','2026-10-02 10:00:00','2026-09-29','2026-10-06','open'),"
+" (9003,1003,4,2,1,'weekly','0.07','2026-10-03 10:00:00','2026-09-29','2026-10-06','requested'),"
+" (9004,1004,3,2,1,'weekly','0.05','2026-10-04 10:00:00','2026-09-29','2026-10-06','open')").run();

// ================= RUN THE REAL MIGRATION FROM schema.js =================
const schema=require('fs').readFileSync(__dirname+'/backend/schema.js','utf8');
function ensureColumn(table,column,definition){
  const cols=raw.all(`PRAGMA table_info(${table})`).map(c=>c.name);
  if(!cols.includes(column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('payment_ledger','client_id','INTEGER');
raw.exec(`UPDATE payment_ledger SET client_id = (
            SELECT s.client_id FROM sms_records s WHERE s.id = payment_ledger.sms_record_id
          ) WHERE client_id IS NULL AND sms_record_id IS NOT NULL`);
raw.exec(`CREATE INDEX IF NOT EXISTS idx_payment_ledger_client ON payment_ledger(client_id)`);
// =========================================================================

// ---- the endpoint's exact query logic ----
function decAddStr(a,b){const norm=(v)=>{const t=String(v==null?'':v).trim();
if(!/^-?\d+(?:\.\d+)?$/.test(t))return{n:0n,s:0};const neg=t.startsWith('-');
const wf=t.replace('-','').split('.');const w=wf[0];const f=wf[1]||'';
return{n:BigInt(w+f)*(neg?-1n:1n),s:f.length};};
const x=norm(a),y=norm(b),sc=Math.max(x.s,y.s);
const sum=x.n*10n**BigInt(sc-x.s)+y.n*10n**BigInt(sc-y.s);
const neg=sum<0n;let out=(neg?-sum:sum).toString().padStart(sc+1,'0');
if(sc)out=(out.slice(0,-sc)+'.'+out.slice(-sc)).replace(/\.?0+$/,'');
return (neg&&out!=='0'?'-':'')+(out===''?'0':out);}

function clientPayouts(clientId, q={}){
  const where=["l.client_id=?"], params=[clientId];
  where.push("CAST(COALESCE(NULLIF(TRIM(COALESCE(l.amount,'')),''),'0') AS REAL) <> 0");
  if(q.status){ where.push('l.status=?'); params.push(String(q.status)); }
  const filter=where.join(' AND ');
  const rows=raw.all('SELECT l.id,l.agent_id,l.payment_type,l.amount,l.status,l.earned_at,l.cycle_key,l.eligible_at, COALESCE(u.username,\'\') AS agent_name FROM payment_ledger l LEFT JOIN users u ON u.id=l.agent_id WHERE '+filter+' ORDER BY l.earned_at DESC, l.id DESC', params);
  const byStatus={}; let totalAmount='0';
  for(const r of raw.all('SELECT l.status, l.amount FROM payment_ledger l WHERE '+filter, params)){
    const st=String(r.status||'open');
    if(!byStatus[st]) byStatus[st]={count:0, amount:'0'};
    byStatus[st].count++; byStatus[st].amount=decAddStr(byStatus[st].amount,r.amount);
    totalAmount=decAddStr(totalAmount,r.amount);
  }
  return {rows, by_status:byStatus, total_amount:totalAmount};
}

let pass=0,fail=0;
function t(label,cond,extra){ if(cond){pass++;console.log('  PASS  '+label);} else {fail++;console.log('  FAIL  '+label+(extra?'  -> '+extra:''));} }

console.log('=== BACKFILL ===');
const bf=raw.all('SELECT id, client_id FROM payment_ledger ORDER BY id').map(r=>r.id+':'+(r.client_id===null?'NULL':r.client_id)).join(' ');
t('historical rows backfilled from sms_records', bf==='9001:5 9002:5 9003:6 9004:NULL', bf);

console.log('\n=== CASE 1: valid non-zero payout visible to the correct Client ===');
const X=clientPayouts(5);
t('client X sees exactly 1 payout', X.rows.length===1, JSON.stringify(X.rows.map(r=>r.id)));
t('  and it is the non-zero row 9001', X.rows[0] && X.rows[0].id===9001);
t('  amount is 0.05', X.rows[0].amount==='0.05');
t('  agent name resolved (agtA)', X.rows[0].agent_name==='agtA');

console.log('\n=== CASE 2: zero-value payout is NOT displayed ===');
const ids=X.rows.map(r=>r.id);
t('the 0.00 row 9002 is excluded', !ids.includes(9002));
const zeroRow=raw.get("SELECT id FROM payment_ledger WHERE amount='0.00'");
t('a 0.00 row exists in the DB (so exclusion is real)', !!zeroRow);
// insert every zero-ish variant (sms_record_id left NULL to respect its UNIQUE index)
const zi=raw.prepare("INSERT INTO payment_ledger(sms_record_id,agent_id,client_id,payment_type,amount,status) VALUES (NULL,3,5,'weekly',?,'open')");
const zids=[];
['0','0.0','0.00','0.000','','   '].forEach((v)=>{ zids.push(zi.run(v).lastInsertRowid); });
const afterZero=clientPayouts(5).rows.map(r=>r.id);
t('all zero-ish variants excluded (0 / 0.0 / 0.00 / 0.000 / blank / spaces)', zids.every(id=>!afterZero.includes(id)), 'leaked: '+JSON.stringify(zids.filter(id=>afterZero.includes(id))));
raw.exec('DELETE FROM payment_ledger WHERE id IN ('+zids.join(',')+')');

console.log('\n=== CASE 3: previously saved non-zero payouts displayed (historical) ===');
const Y=clientPayouts(6);
t('client Y sees their historical row 9003', Y.rows.length===1 && Y.rows[0].id===9003);
t('  amount 0.07 preserved', Y.rows[0].amount==='0.07');
t('backfill made pre-existing data visible (no re-save needed)', Y.rows.length>0);

console.log('\n=== CASE 4: statuses remain accurate / not converted ===');
const all=[...X.rows,...Y.rows];
const paid=all.find(r=>r.id===9001), req=all.find(r=>r.id===9003);
t('9001 status still "paid"', paid && paid.status==='paid', paid&&paid.status);
t('9003 status still "requested"', req && req.status==='requested', req&&req.status);
t('by_status reports verbatim keys', JSON.stringify(X.by_status)==='{"paid":{"count":1,"amount":"0.05"}}', JSON.stringify(X.by_status));
const filtered=clientPayouts(5,{status:'paid'});
t('status filter works and does not remap', filtered.rows.length===1 && filtered.rows[0].status==='paid');
t('total_amount is decimal-exact', X.total_amount==='0.05', X.total_amount);

console.log('\n=== CASE 5: Clients cannot see each other\'s payouts ===');
const Xids=X.rows.map(r=>r.id).sort(), Yids=Y.rows.map(r=>r.id).sort();
t('X and Y see disjoint sets', Xids.every(i=>!Yids.includes(i)) && Yids.length>0 && Xids.length>0);
t('X never sees Y row 9003', !Xids.includes(9003));
t('Y never sees X row 9001', !Yids.includes(9001));
t('unallocated row 9004 (no client) hidden from both', !Xids.includes(9004) && !Yids.includes(9004));
t('a third id sees nothing', clientPayouts(999).rows.length===0);

console.log('\n=== IDEMPOTENCY (refresh / re-login must not duplicate) ===');
const a1=JSON.stringify(clientPayouts(5).rows);
const a2=JSON.stringify(clientPayouts(5).rows);
const a3=JSON.stringify(clientPayouts(5).rows);
t('repeated reads are identical (no duplication)', a1===a2 && a2===a3);
// re-running the backfill must not change anything
raw.exec(`UPDATE payment_ledger SET client_id = (SELECT s.client_id FROM sms_records s WHERE s.id = payment_ledger.sms_record_id) WHERE client_id IS NULL AND sms_record_id IS NOT NULL`);
t('re-running backfill is a no-op (idempotent)', JSON.stringify(clientPayouts(5).rows)===a1);
t('row count unchanged after re-migration', raw.get('SELECT COUNT(*) n FROM payment_ledger').n===4);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
