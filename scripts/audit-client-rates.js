'use strict';
/* Offline audit: never open/create an unspecified DB, never rewrite SMS/payments.
 * --apply only reconciles payout to an explicit valid client_rate on an active
 * Client allocation. Empty/invalid legacy configuration remains review-only.
 */
const fs=require('fs'),path=require('path');const Database=require('better-sqlite3');
const {configuredClientRate}=require('../backend/allocation-safety');
const apply=process.argv.includes('--apply');const file=process.env.DB_FILE||(process.env.DATA_DIR?path.join(process.env.DATA_DIR,'data.sqlite'):null);
if(!file||!fs.existsSync(file)){console.error('Set DB_FILE to an existing database. Back it up and stop the application before --apply.');process.exit(1);}
const db=new Database(file,{readonly:!apply,fileMustExist:true});let corrected=0,ambiguous=0,mismatches=0;
try{
 const run=()=>{let after=0;while(true){const rows=db.prepare('SELECT id,number,client_rate,payout FROM numbers WHERE client_id IS NOT NULL AND id>? ORDER BY id LIMIT 1000').all(after);if(!rows.length)break;after=rows[rows.length-1].id;for(const row of rows){
  let rate;try{if(row.client_rate==null||String(row.client_rate).trim()==='')throw Error('unknown');rate=configuredClientRate(row.client_rate);}catch(_){ambiguous++;continue;}
  if(String(row.payout)!==rate){mismatches++;if(apply){db.prepare('UPDATE numbers SET payout=? WHERE id=?').run(rate,row.id);db.prepare("INSERT INTO number_history(number_id,number,action,details) VALUES(?,?,'client_rate_reconciled',?)").run(row.id,row.number,JSON.stringify({source:'explicit_client_rate',before:row.payout,after:rate}));corrected++;}}
 }
 }
 if(apply&&corrected){db.prepare("INSERT INTO meta(key,value) VALUES('numbers_ver','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();}
 };
 if(apply)db.transaction(run).immediate();else run();
 console.log(JSON.stringify({mode:apply?'apply':'dry-run',explicitRateMismatches:mismatches,corrected,ambiguousRequiresOwnerReview:ambiguous,historicalSmsOrPaymentsChanged:0},null,2));
}finally{db.close();}
