'use strict';
// All records live in a new OS temporary directory; never opens the deployment DB.
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {spawn,spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
if(process.argv.includes('--fixture')){(async()=>{
 const db=require('../backend/db');await db.init();require('../backend/schema').createTables();const bcrypt=require('bcryptjs');const hash=bcrypt.hashSync(process.env.TEST_PASSWORD,4);
 for(const [id,role,parent] of [[1,'admin',null],[2,'manager',1],[3,'agent',2],[4,'client',3],[5,'agent',2],[6,'client',5],[7,'manager',1],[8,'agent',7],[9,'client',8]])db.run('INSERT INTO users(id,username,password,role,name,parent_id,active) VALUES(?,?,?,?,?,?,1)',[id,'qa'+id,hash,role,'QA '+id,parent]);
 db.run("INSERT INTO ranges(id,name,rate_7_1) VALUES(1,'QA Range','9.99')");
 for(let id=1;id<=32;id++){const a=id<=25?3:id<=29?5:8,c=id<=25?4:id<=29?6:9,m=id<=29?2:7;db.run("INSERT INTO numbers(id,number,range_id,manager_id,agent_id,client_id,manager_rate,agent_rate,client_rate,payout,rate) VALUES(?,?,1,?,?,?,'3','2','0.1','0.1','4')",[id,'44770000'+String(id).padStart(4,'0'),m,a,c]);}
 db.run("INSERT INTO sms_records(number_id,number,range_id,manager_id,agent_id,client_id,message,cli,payout_rate,payout_amount) VALUES(1,'447700000001',1,2,3,4,'Historical message','QA','2','2')");
 db.run("INSERT INTO payment_ledger(sms_record_id,agent_id,manager_id,range_id,payment_type,amount,status) VALUES(1,3,2,1,'weekly','2','paid')");
 db.run("INSERT INTO meta(key,value) VALUES('p19k_stats_reconciled','1') ON CONFLICT(key) DO UPDATE SET value='1'");
 })().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});return;}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skyline-tests-')),dbFile=path.join(dir,'isolated.sqlite'),password=crypto.randomBytes(18).toString('hex');
 const env={...process.env,DB_FILE:dbFile,DATA_DIR:dir,JWT_SECRET:crypto.randomBytes(32).toString('hex'),TEST_PASSWORD:password,AMS_ROLE:'api',PAYMENT_LEDGER_BACKFILL_ON_STARTUP:'false',PORT:'4183',SMPP_ENABLED:'false'};
 const fixture=spawnSync(process.execPath,[__filename,'--fixture'],{cwd:root,env,encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
 const db=new(require('better-sqlite3'))(dbFile);let log='';const server=spawn(process.execPath,['backend/server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
 const base='http://127.0.0.1:4183';let checks=[],loginAttempt=0;
 async function request(token,url,body,expected=200){const res=await fetch(base+'/api'+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(url==='/login'?{'X-Forwarded-For':'127.1.0.'+(++loginAttempt)}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data;}
 async function login(id){return(await request(null,'/login',{username:'qa'+id,password})).token;}
 try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout '+log)),15000);server.stdout.on('data',()=>{if(log.includes('backend running')){clearTimeout(t);resolve()}});server.on('exit',c=>{clearTimeout(t);reject(Error('server exited '+c+' '+log))});});
 const tokens={};for(let id=1;id<=9;id++)tokens[id]=await login(id);
 const nums=async(id,q='')=>request(tokens[id],'/numbers?paged=1&limit=100'+q);
 // Simulate a stale fallback: explicit zero is authoritative even when old payout is nonzero.
 db.prepare("UPDATE numbers SET client_rate='0.00',payout='8.88' WHERE id=1").run();assert.equal((await nums(4)).rows.find(r=>r.id===1).payout,'0.00');
 for(const [raw,expected] of [['','0.00'],['0','0.00'],['0.00','0.00'],['0.1','0.1'],['0.2','0.2'],['0.123456','0.123456'],['0.1000','0.1000'],['0','0.00']]){
  await request(tokens[3],'/numbers/client-rate',{ids:[1],rate:raw});const stored=db.prepare('SELECT client_rate,payout FROM numbers WHERE id=1').get();assert.deepEqual(stored,{client_rate:expected,payout:expected});assert.equal((await nums(4)).rows.find(r=>r.id===1).effective_rate,expected);tokens[4]=await login(4);assert.equal((await nums(4)).rows.find(r=>r.id===1).payout,expected);
 }checks.push('Empty, zero, exact nonzero, 6dp, changed-to-zero, persisted GET and fresh login: PASS');
 await request(tokens[5],'/numbers/client-rate',{ids:[1],rate:'0.7'},403);await request(tokens[4],'/numbers/client-rate',{ids:[1],rate:'0.7'},403);await request(tokens[3],'/numbers/client-rate',{ids:[1],rate:'garbage'},400);for(const invalid of ['0.1junk','-0.1','1e2','100001','0.1234567']){db.prepare('UPDATE numbers SET client_rate=?,payout=? WHERE id=1').run(invalid,'9');await request(tokens[3],'/numbers/client-rate',{ids:[2],rate:'0'});assert.equal((await nums(4)).rows.find(r=>r.id===1).payout,'0.00');}
 await request(tokens[3],'/numbers/client-rate',{ids:[1],rate:'0'});checks.push('Rate isolation / invalid rate / role guard and malformed legacy reads: PASS');
 const ledgerBefore=db.prepare('SELECT * FROM payment_ledger').all();const historyBefore=db.prepare('SELECT * FROM sms_records').all(),other=db.prepare('SELECT * FROM numbers WHERE id=26').get();
 const v0=(await request(tokens[1],'/numbers/allocation-version')).version;
 await request(tokens[4],'/numbers/return',{ids:[1,2,3,4]});assert.equal((await nums(4)).total,21);for(const id of [1,2,3,4]){const r=db.prepare('SELECT * FROM numbers WHERE id=?').get(id);assert.equal(r.client_id,null);assert.equal(r.agent_id,3);assert.equal(r.manager_id,2);}assert.equal((await nums(3,'&allocation=unallocated')).total,4);assert.equal((await nums(1,'&allocation=unallocated')).total,0);assert((await request(tokens[1],'/numbers/allocation-version')).version>v0);checks.push('Client 4 of 25 return: Agent retains all 25, 4 reusable, 21 Client assignments remain: PASS');
 // Reuse returned inventory through the real allocation route, not direct SQL.
 for(const [id,rate,expected] of [[1,'','0.00'],[2,'0.00','0.00'],[3,'0.1','0.1'],[3,'0','0.00']]){
  await request(tokens[3],'/numbers/allocate',{ids:[id],target_id:4,rate});assert.equal(db.prepare('SELECT payout FROM numbers WHERE id=?').get(id).payout,expected);
 }checks.push('Actual Agent allocation route blank/zero/nonzero/reset and returned-number reuse: PASS');
 await request(tokens[3],'/numbers/smart-divide',{range_ids:[1],target_ids:[4],qty:1,rate:'0.2',background:false});assert.equal(db.prepare('SELECT payout FROM numbers WHERE id=4').get().payout,'0.2');checks.push('Actual smart-divide exact Client payout: PASS');
 for(const [token,ids,status] of [[tokens[4],[1,26],403],[tokens[5],[1],403],[tokens[7],[1],403],[tokens[3],[1,1],400],[tokens[3],[1,99999],409],[tokens[3],['1'],400]]){const before=db.prepare('SELECT * FROM numbers').all();await request(token,'/numbers/return',{ids},status);assert.deepEqual(db.prepare('SELECT * FROM numbers').all(),before);}checks.push('Mixed unauthorized, other Agent/Manager, duplicates, missing IDs, malformed IDs: all-or-nothing rejection PASS');
 await request(tokens[3],'/numbers/return',{ids:[1,2]});for(const id of [1,2]){const r=db.prepare('SELECT * FROM numbers WHERE id=?').get(id);assert.equal(r.client_id,null);assert.equal(r.agent_id,null);assert.equal(r.manager_id,null);}assert.equal((await nums(1,'&allocation=unallocated')).total,2);assert.equal((await nums(3)).total,23);assert.equal((await nums(2)).total,27);await request(tokens[1],'/numbers/return',{ids:[1]},409);checks.push('Agent upstream cascade and Admin Unallocated/Manager removal, repeated return rejection: PASS');
 await request(tokens[2],'/numbers/return',{ids:[3,26]});assert.equal((await nums(1,'&allocation=unallocated')).total,4);assert.equal((await nums(6)).total,3);assert.deepEqual(db.prepare('SELECT * FROM numbers WHERE id=27').get(),{...other,id:27,number:'447700000027'});checks.push('Manager return across two Agents cascades selected Clients only: PASS');
 await request(tokens[1],'/numbers/return',{ids:[30]});assert.equal((await nums(9)).total,2);checks.push('Admin return authority: PASS');
 assert.deepEqual(db.prepare('SELECT * FROM payment_ledger').all(),ledgerBefore);assert.deepEqual(db.prepare('SELECT * FROM sms_records').all(),historyBefore);assert.equal(db.prepare('SELECT COUNT(*) c FROM numbers').get().c,32);assert.equal(db.prepare('SELECT COUNT(*) c FROM numbers WHERE client_id IS NOT NULL AND agent_id IS NULL').get().c,0);assert.equal(db.prepare('SELECT COUNT(*) c FROM numbers WHERE agent_id IS NOT NULL AND manager_id IS NULL').get().c,0);checks.push('All number records and historical SMS unchanged; no fixture orphans: PASS');
 tokens[3]=await login(3);tokens[4]=await login(4);assert(!(await nums(3)).rows.some(r=>[1,2,3].includes(r.id)));assert(!(await nums(4)).rows.some(r=>[1,2,3].includes(r.id)));checks.push('Refresh and re-login after returns: PASS');
 // Force a real database write failure after number UPDATE to verify savepoint rollback.
 db.exec("CREATE TRIGGER qa_fail_history BEFORE INSERT ON number_history BEGIN SELECT RAISE(ABORT,'test failure'); END");const before=db.prepare('SELECT * FROM numbers').all();await request(tokens[3],'/numbers/return',{ids:[5]},500);assert.deepEqual(db.prepare('SELECT * FROM numbers').all(),before);db.exec('DROP TRIGGER qa_fail_history');checks.push('Injected history-insert failure rolls back number update: PASS');
 fs.writeFileSync(path.join(root,'tests','integration-results.json'),JSON.stringify({checks},null,2));console.log(checks.join('\n'));
 // Offline repair touches only demonstrably explicit Client rate mismatches.
 db.prepare("UPDATE numbers SET client_rate='0',payout='9' WHERE id=27").run();
 db.prepare("UPDATE numbers SET client_rate='',payout='8' WHERE id=28").run();
 let audit=spawnSync(process.execPath,['scripts/audit-client-rates.js'],{cwd:root,env,encoding:'utf8'});assert.equal(audit.status,0,audit.stderr);assert.equal(JSON.parse(audit.stdout).ambiguousRequiresOwnerReview,1);assert.equal(db.prepare('SELECT payout FROM numbers WHERE id=27').get().payout,'9');
 audit=spawnSync(process.execPath,['scripts/audit-client-rates.js','--apply'],{cwd:root,env,encoding:'utf8'});assert.equal(audit.status,0,audit.stderr);assert.equal(db.prepare('SELECT payout FROM numbers WHERE id=27').get().payout,'0.00');assert.equal(db.prepare('SELECT payout FROM numbers WHERE id=28').get().payout,'8');assert.deepEqual(db.prepare('SELECT * FROM sms_records').all(),historyBefore);checks.push('Repair dry-run/no write, explicit zero mismatch repair, ambiguous blank preserved, SMS untouched: PASS');
 fs.writeFileSync(path.join(root,'tests','integration-results.json'),JSON.stringify({checks},null,2));console.log(checks[checks.length-1]);
 await request(tokens[1],'/numbers/allocate',{ids:[1],target_id:6,rate:'0.8'});
 assert.equal((await nums(6)).rows.find(r=>r.id===1).payout,'0.8');assert(!(await nums(4)).rows.some(r=>r.id===1));const historical=await request(tokens[4],'/sms/paged?limit=25');assert.equal(historical.rows.find(r=>r.number_id===1).number_payout,null);assert.equal(historical.rows.find(r=>r.number_id===1).number_rate,null);checks.push('Reallocated number cannot expose another Agent/Client current rate through old Client SMS history: PASS');
 fs.writeFileSync(path.join(root,'tests','integration-results.json'),JSON.stringify({checks},null,2));console.log(checks[checks.length-1]);
 // Browser runner can use this temporary test server and credentials through stdin, never files.
 if(process.env.RUN_BROWSER==='1'){const r=spawnSync(process.execPath,[path.join(root,'tests','browser.js')],{cwd:root,env:{...env,QA_BASE:base},encoding:'utf8',timeout:120000});console.log(r.stdout);assert.equal(r.status,0,r.stderr);}
 }finally{server.kill('SIGTERM');db.close();await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
