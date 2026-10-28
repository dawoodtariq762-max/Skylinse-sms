'use strict';
/* One authoritative outbound client rate. Never use upstream/range rates as defaults. */
function configuredClientRate(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return '0.00';
  if (!/^\d+(?:\.\d{1,6})?$/.test(s) || Number(s) > 100000) {
    const e = new Error('Client rate must be a non-negative decimal (max 6 decimal places, max 100000)'); e.status = 400; throw e;
  }
  return Number(s) === 0 ? '0.00' : s;
}
// Strict SQL equivalent for legacy reads: malformed/empty/zero configuration is
// zero, never an invitation to use a range or stale payout fallback.
function clientRateSql(alias='n') {
  const s=`TRIM(COALESCE(${alias}.client_rate,''))`;
  return `CASE WHEN ${s} NOT GLOB '*[^0-9.]*' AND ${s} GLOB '[0-9]*'
    AND LENGTH(${s})-LENGTH(REPLACE(${s},'.',''))<=1
    AND (INSTR(${s},'.')=0 OR LENGTH(${s})-INSTR(${s},'.') BETWEEN 1 AND 6)
    AND CAST(${s} AS REAL)>0 AND CAST(${s} AS REAL)<=100000
    THEN ${s} ELSE '0.00' END`;
}
function clientRateForSmsSql() {
  return `CASE WHEN n.client_id IS s.client_id AND n.agent_id IS s.agent_id AND s.client_id IS NOT NULL THEN (${clientRateSql('n')}) ELSE NULL END`;
}
function selection(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    const e = new Error('Select 1–50000 distinct positive integer number IDs'); e.status = 400; throw e;
  }
  return ids;
}
function problem(message, status) { const e = new Error(message); e.status = status; throw e; }
/* A savepoint is required: the server already opens a request-level transaction.
   Validation, writes, and history are all reverted together on any failure. */
function selectedWrite(db, user, ids, operation, value) {
  selection(ids);
  if (!user || !['admin','manager','agent','client'].includes(user.role)) problem('Not allowed',403);
  const own = !db.inTransaction();
  if (own) db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT selected_number_write');
  try {
    db.exec('CREATE TEMP TABLE selected_number_ids(id INTEGER PRIMARY KEY)');
    for (let i=0;i<ids.length;i+=1000) { const chunk=ids.slice(i,i+1000);db.runNoSave(`INSERT INTO selected_number_ids(id) VALUES ${chunk.map(()=>'(?)').join(',')}`,chunk); }
    const rows=db.all('SELECT id,number,manager_id,agent_id,client_id,client_rate,payout FROM numbers WHERE id IN (SELECT id FROM selected_number_ids)');
    if (rows.length !== ids.length) problem('One or more numbers no longer exist; nothing changed',409);
    const col={manager:'manager_id',agent:'agent_id',client:'client_id'}[user.role];
    if (col && rows.some(r=>r[col]!==user.id)) problem('One or more numbers are not allocated to you; nothing changed',403);
    let sets,params=[];
    if (operation==='return') {
      if (user.role==='admin' && rows.some(r=>r.manager_id==null&&r.agent_id==null&&r.client_id==null)) problem('One or more numbers are already unallocated; nothing changed',409);
      sets=user.role==='client' ? "client_id=NULL,client_rate='0.00',payout='0.00'" : "manager_id=NULL,agent_id=NULL,client_id=NULL,manager_rate='',agent_rate='',client_rate='0.00',payout='0.00',rate=''";
    } else if(operation==='client-rate') {
      if(user.role!=='agent') problem('Only Agents can update their Client allocation rates',403);
      if(rows.some(r=>r.client_id==null)) problem('Select only numbers currently assigned to your Clients',409);
      const children=new Set(db.all("SELECT id FROM users WHERE role='client' AND parent_id=?",[user.id]).map(r=>r.id));
      if(rows.some(r=>!children.has(r.client_id))) problem('Client is outside your hierarchy',403);
      value=configuredClientRate(value);sets='client_rate=?,payout=?';params=[value,value];
    } else problem('Unknown operation',400);
    db.runNoSave(`UPDATE numbers SET ${sets} WHERE id IN (SELECT id FROM selected_number_ids)`,params);
    for(const r of rows) db.runNoSave('INSERT INTO number_history(number_id,number,action,from_owner,to_owner,details,user_id) VALUES(?,?,?,?,?,?,?)',[
      r.id,r.number,operation==='return'?'returned':'client_rate_updated',String(r.client_id||r.agent_id||r.manager_id||''),user.role==='client'?String(r.agent_id||r.manager_id||''):'',JSON.stringify({role:user.role,before:{manager_id:r.manager_id,agent_id:r.agent_id,client_id:r.client_id,client_rate:r.client_rate,payout:r.payout},...(operation==='client-rate'?{rate:value}:{destination:user.role==='client'?'parent_inventory':'admin_unallocated'})}),user.id]);
    db.exec('DROP TABLE selected_number_ids');db.exec('RELEASE selected_number_write');if(own)db.exec('COMMIT');
    return {ok:true,count:rows.length,...(operation==='client-rate'?{rate:value}:{destination:user.role==='client'?'parent_inventory':'admin_unallocated'})};
  } catch(e) {
    try{db.exec('ROLLBACK TO selected_number_write');db.exec('RELEASE selected_number_write');if(own)db.exec('ROLLBACK');}catch(_){}
    throw e;
  }
}
module.exports={configuredClientRate,clientRateSql,clientRateForSmsSql,selectedWrite,selection};
