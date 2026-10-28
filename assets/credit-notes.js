/* Credit Notes — read-only ledger settlements. No payment, allocation or ledger writes.
 * Phase-2 UI: no statement notice block, no maturity/PIN explanatory footer,
 * From/To date fields, Payment Type = Daily/Weekly/Monthly and a derived
 * Status = Pending / Cleared / Paid (from the existing ledger fields only).
 *
 * §16 — Payment clearance:
 *   §16.1 A Clear control marks a settlement group as paid/cleared.
 *   §16.2 A dedicated Clearance tab lists everything cleared.
 *   §16.3 The Clear control is ADMIN ONLY — a Manager never sees it here, and the
 *         server rejects the request with 403 regardless.
 *   §16.5/§16.6 Clearing records a marker in a separate table. It never writes to
 *         payment_ledger, so no amount, status or eligibility is recalculated.
 */
(function(){
'use strict';
function init(){
 const root=document.getElementById('page-creditNotes');if(!root)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 /* Status is derived from the values the API already returns:
      Paid    = paid_amount > 0        (money actually paid out)
      Cleared = maturity === 'matured' (stored eligibility date has passed)
      Pending = everything else        (upcoming or not recorded)               */
 const statusOf=r=>{
   const paid=parseFloat(String(r.paid_amount||'0'))||0;
   if(paid>0)return 'Paid';
   return r.maturity==='matured'?'Cleared':'Pending';
 };
 const STATUS_TAG={Paid:'tag-green',Cleared:'tag-blue',Pending:'tag-amber'};
 const TERM={daily:'Daily',weekly:'Weekly',monthly_30x45:'Monthly'};
 /* §16.3: role is resolved once from /api/me. Only 'admin' may clear. */
 let MY_ROLE=null;
 (async()=>{ try{ const u=await API.get('/me'); MY_ROLE=(u&&u.role)||''; applyRole(); }catch(e){ MY_ROLE=''; applyRole(); } })();
 function applyRole(){
  const isAdmin = MY_ROLE==='admin';
  const clrTab=document.getElementById('cnTabClearance');
  if(clrTab) clrTab.style.display = (isAdmin||MY_ROLE==='manager') ? '' : 'none';
  document.querySelectorAll('.cn-clear-btn').forEach(b=>b.style.display=isAdmin?'':'none');
  const note=document.getElementById('cnRoleNote');
  if(note) note.textContent = isAdmin
    ? 'You can clear settlements. Clearing records a marker only — no ledger amount is recalculated.'
    : (MY_ROLE==='manager' ? 'Only an Admin can clear settlements. You can view the Clearance tab.' : '');
 }
 root.innerHTML=`<div class="page-head"><div><h2>Credit Notes</h2><div class="breadcrumb"><b>Finance</b> › Credit Notes</div></div></div>
 <div class="ams-cnc-tabs" role="tablist">
   <button class="ams-cnc-tab active" id="cnTabStatements" role="tab" type="button">Statements</button>
   <button class="ams-cnc-tab" id="cnTabClearance" role="tab" type="button">Clearance</button>
 </div>
 <div class="muted" id="cnRoleNote" style="margin:6px 2px 0;font-size:12px"></div>
 <div id="cnPaneStatements">
 <form class="toolbar ams-statement-filters" id="cnFilters">
 <label>From<input id="cnFrom" type="date"></label><label>To<input id="cnTo" type="date"></label>
 <label>Payment Type<select id="cnType"><option value="">All types</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly_30x45">Monthly</option></select></label>
 <label>Status<select id="cnStatusFilter"><option value="">All</option><option value="pending">Pending</option><option value="cleared">Cleared</option><option value="paid">Paid</option></select></label>
 <button class="btn btn-blue" type="submit">Show Report</button><button class="btn btn-ghost" type="reset">Reset</button><button class="btn btn-ghost" id="cnRefresh" type="button" title="Re-read the live ledger">Refresh</button></form>
 <div class="table-wrap"><div class="card-head"><h3>Credit Notes</h3></div>
 <div class="table-controls"><div class="tc-left"><button class="btn btn-ghost" id="cnCsv" type="button" disabled>CSV · current page</button></div><div class="tc-right"><label for="cnSize">Show records</label> <select id="cnSize"><option>25</option><option>50</option><option>100</option></select></div></div>
 <div id="cnStatus" class="ams-statement-status" role="status" aria-live="polite"></div>
 <div class="tscroll"><table class="ams-statement-table"><thead><tr><th>Cycle start</th><th>Agent</th><th>Term</th><th>Currency</th><th>Ledger amount</th><th>CDRs</th><th>Eligible at (UTC)</th><th>Status</th><th>Open</th><th>Requested</th><th>Paid</th><th>Other</th><th>Request IDs</th><th>Clearance</th></tr></thead><tbody id="cnBody"></tbody></table></div>
 <div class="table-foot"><span id="cnCount">No report loaded</span><div class="pagination"><button id="cnPrev" type="button" disabled>Previous</button><button id="cnNext" type="button" disabled>Next</button></div></div></div>
 </div>
 <div id="cnPaneClearance" style="display:none">
 <form class="toolbar ams-statement-filters" id="cnClrFilters">
 <label>From<input id="cnClrFrom" type="date"></label><label>To<input id="cnClrTo" type="date"></label>
 <label>Payment Type<select id="cnClrType"><option value="">All types</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly_30x45">Monthly</option></select></label>
 <button class="btn btn-blue" type="submit">Show Cleared</button><button class="btn btn-ghost" type="reset">Reset</button><button class="btn btn-ghost" id="cnClrRefresh" type="button">Refresh</button></form>
 <div class="table-wrap"><div class="card-head"><h3>Clearance</h3></div>
 <div id="cnClrStatus" class="ams-statement-status" role="status" aria-live="polite"></div>
 <div class="tscroll"><table class="ams-statement-table"><thead><tr><th>Cleared at (UTC)</th><th>Cycle start</th><th>Agent</th><th>Term</th><th>Amount at clearance</th><th>Cleared by</th><th>Note</th><th>Action</th></tr></thead><tbody id="cnClrBody"></tbody></table></div>
 <div class="table-foot"><span id="cnClrCount">No clearance loaded</span><div class="pagination"><button id="cnClrPrev" type="button" disabled>Previous</button><button id="cnClrNext" type="button" disabled>Next</button></div></div></div>
 </div>
 <style>.ams-cnc-tabs{display:flex;gap:8px;margin:10px 2px 0}.ams-cnc-tab{padding:6px 14px;border-radius:8px;border:1px solid var(--ds-line2,#cfd2d8);background:transparent;color:inherit;font-weight:600;font-size:13px;cursor:pointer}.ams-cnc-tab.active{background:#3256df;border-color:#3256df;color:#fff}</style>
`;
 const el=id=>document.getElementById(id);let page=1,totalPages=1,rows=[],serial=0;
 let clrPage=1,clrTotalPages=1,clrRows=[];
 function showTab(which){
  const st=which==='clearance';
  el('cnPaneStatements').style.display=st?'none':'';
  el('cnPaneClearance').style.display=st?'':'none';
  el('cnTabStatements').classList.toggle('active',!st);
  el('cnTabClearance').classList.toggle('active',st);
  if(st) loadClearances(); else load();
 }
 el('cnTabStatements').onclick=()=>showTab('statements');
 el('cnTabClearance').onclick=()=>showTab('clearance');
 /* ---------- §16.1/§16.5 clear / undo (server enforces admin-only) ---------- */
 async function clearGroup(r){
  if(!confirm('Mark this settlement as cleared/paid?\n\n'+r.agent_name+' · '+(TERM[r.payment_type]||r.payment_type)+' · '+(r.cycle_key||'Not recorded')
    +'\nAmount: '+r.total_amount+'\n\nThis records a clearance marker only. No ledger amount is recalculated.')) return;
  try{
   await API.post('/payment-v2/credit-notes/clear',{agent_id:r.agent_id,payment_type:r.payment_type,
     cycle_key:r.cycle_key||'',eligible_at:r.eligible_at||'',amount:String(r.total_amount||'0'),note:''});
   load();
  }catch(e){ alert((e&&e.message)||'Unable to clear this settlement'); }
 }
 async function unclearGroup(c){
  if(!confirm('Reverse the clearance for '+(c.agent_name||('Agent #'+c.agent_id))+' · '+(TERM[c.payment_type]||c.payment_type)+' · '+(c.cycle_key||'Not recorded')+'?\n\nThis removes the clearance marker only. No ledger amount is affected.')) return;
  try{
   await API.post('/payment-v2/credit-notes/unclear',{agent_id:c.agent_id,payment_type:c.payment_type,
     cycle_key:c.cycle_key||'',eligible_at:c.eligible_at||''});
   loadClearances();
  }catch(e){ alert((e&&e.message)||'Unable to reverse this clearance'); }
 }
 document.addEventListener('click',function(ev){
  const b=ev.target&&ev.target.closest?ev.target.closest('[data-cn-clear],[data-cn-unclear]'):null;
  if(!b) return;
  const ci=b.getAttribute('data-cn-unclear');
  if(ci!=null){ const c=clrRows[Number(ci)]; if(c) unclearGroup(c); return; }
  const ri=b.getAttribute('data-cn-clear');
  if(ri!=null){ const r=rows[Number(ri)]; if(r) clearGroup(r); }
 });
 /* --------------------------- statements load --------------------------- */
 async function load(){
  const own=++serial;rows=[];el('cnCsv').disabled=true;el('cnPrev').disabled=true;el('cnNext').disabled=true;el('cnBody').innerHTML='';el('cnStatus').textContent='Loading…';
  const q=new URLSearchParams({page:String(page),limit:el('cnSize').value});
  for(const [k,id] of [['from','cnFrom'],['to','cnTo'],['payment_type','cnType']])if(el(id).value)q.set(k,el(id).value);
  /* Status maps onto the ledger's stored eligibility (the only field the API filters on):
     Pending -> not yet eligible, Cleared -> eligible (matured), Paid -> eligible + paid rows. */
  const statusFilter=el('cnStatusFilter').value;
  if(statusFilter==='pending')q.set('maturity','upcoming');
  else if(statusFilter==='cleared'||statusFilter==='paid')q.set('maturity','matured');
  try{
   const data=await API.get('/payment-v2/credit-notes?'+q);if(own!==serial)return;
   rows=(data.rows||[]).filter(r=>statusFilter!=='paid'||statusOf(r)==='Paid');
   page=data.page;totalPages=data.totalPages;
   el('cnBody').innerHTML=rows.map((r,i)=>{const st=statusOf(r);const cleared=Number(r.cleared)===1;
     return `<tr><td>${esc(r.cycle_key||'Not recorded')}</td><td>${esc(r.agent_name)}</td><td>${esc(TERM[r.payment_type]||r.payment_type)}</td><td>Not recorded</td><td class="amount">${esc(r.total_amount)}</td><td>${r.cdr_count}</td><td>${esc(r.eligible_at||'Not recorded')}</td><td><span class="tag ${STATUS_TAG[st]}">${esc(st)}</span></td><td class="amount">${esc(r.open_amount)}</td><td class="amount">${esc(r.requested_amount)}</td><td class="amount">${esc(r.paid_amount)}</td><td class="amount">${esc(r.other_amount)}</td><td>${r.request_ids.map(esc).join(', ')||'—'}</td>`
     +`<td>${cleared?'<span class="tag tag-green">Cleared</span>':'<span class="tag tag-amber">Open</span>'}<button class="btn btn-ghost btn-sm cn-clear-btn" type="button" data-cn-clear="${i}" style="margin-left:6px;display:none">${cleared?'Update':'Clear'}</button></td></tr>`;}).join('')||'<tr><td colspan="14" style="text-align:center;padding:30px">No settlements match these filters.</td></tr>';
   el('cnStatus').textContent=rows.length?('Showing '+rows.length+' of '+data.total+' settlement group(s) on this page'):'No settlements match these filters.';
   el('cnCount').textContent=`${data.total} settlement group(s) · Page ${page} of ${totalPages}`;
   el('cnPrev').disabled=page<=1;el('cnNext').disabled=page>=totalPages;el('cnCsv').disabled=!rows.length;
   applyRole();
  }catch(e){if(own!==serial)return;el('cnCount').textContent='Report unavailable';el('cnStatus').textContent=e.message||'Unable to load';
   /* FINAL POLISH 5E: the Agent panel needs a way back to live data after this
      failure. The old hint was a raw <a href="/agent/payment">, which is not a
      served route — it left the SPA on an error page. It now uses the panel's own
      navigation hook (no page reload) and offers Refresh once the PIN is verified.
      Read-only: this never creates, reprices or pays a Credit Note. */
   if(/PIN|unlock|locked/i.test(e.message||'')){
    const st=el('cnStatus');
    const go=document.createElement('button');go.type='button';go.className='btn btn-ghost btn-sm';
    go.style.marginLeft='8px';go.textContent='Open Payment Section';
    go.onclick=()=>{ if(typeof window.amsGotoPaymentPage==='function') window.amsGotoPaymentPage(); else st.textContent='Open the Payment Section from the sidebar and verify your Security PIN, then return here and press Refresh.'; };
    st.appendChild(go);
    const rf=document.createElement('button');rf.type='button';rf.className='btn btn-ghost btn-sm';
    rf.style.marginLeft='6px';rf.textContent='Refresh';rf.onclick=()=>load();
    st.appendChild(rf);
   }
  }
 }
 /* --------------------------- §16.2 clearance load --------------------------- */
 async function loadClearances(){
  clrRows=[];el('cnClrPrev').disabled=true;el('cnClrNext').disabled=true;el('cnClrBody').innerHTML='';el('cnClrStatus').textContent='Loading…';
  const q=new URLSearchParams({page:String(clrPage),limit:'50'});
  for(const [k,id] of [['from','cnClrFrom'],['to','cnClrTo'],['payment_type','cnClrType']])if(el(id).value)q.set(k,el(id).value);
  try{
   const data=await API.get('/payment-v2/credit-notes/clearances?'+q);
   clrRows=data.rows||[];clrPage=data.page;clrTotalPages=data.totalPages;
   const isAdmin=MY_ROLE==='admin';
   el('cnClrBody').innerHTML=clrRows.map((c,i)=>`<tr><td>${esc((c.cleared_at||'').replace('T',' '))}</td><td>${esc(c.cycle_key||'Not recorded')}</td><td>${esc(c.agent_name||('Agent #'+c.agent_id))}</td><td>${esc(TERM[c.payment_type]||c.payment_type)}</td><td class="amount">${esc(c.amount)}</td><td>${esc(c.cleared_by_name||'—')}</td><td>${esc(c.note||'—')}</td>`
     +`<td>${isAdmin?`<button class="btn btn-ghost btn-sm" type="button" data-cn-unclear="${i}">Reverse</button>`:'<span class="muted">Admin only</span>'}</td></tr>`).join('')
     ||'<tr><td colspan="8" style="text-align:center;padding:30px">No settlements have been cleared yet.</td></tr>';
   el('cnClrStatus').textContent=clrRows.length?('Showing '+clrRows.length+' of '+data.total+' cleared settlement(s)'):'No settlements have been cleared yet.';
   el('cnClrCount').textContent=`${data.total} cleared · Page ${clrPage} of ${clrTotalPages} · Total ${data.total_amount||'0'}`;
   el('cnClrPrev').disabled=clrPage<=1;el('cnClrNext').disabled=clrPage>=clrTotalPages;
  }catch(e){el('cnClrCount').textContent='Clearance unavailable';el('cnClrStatus').textContent=e.message||'Unable to load clearances';}
 }
 el('cnFilters').onsubmit=e=>{e.preventDefault();page=1;load()};el('cnFilters').onreset=()=>setTimeout(()=>{page=1;load()},0);
 el('cnRefresh').onclick=()=>load();   /* FINAL POLISH 5E: explicit safe refresh, same request, current filters kept */
 el('cnSize').onchange=()=>{page=1;load()};el('cnPrev').onclick=()=>{if(page>1){page--;load()}};el('cnNext').onclick=()=>{if(page<totalPages){page++;load()}};
 el('cnClrFilters').onsubmit=e=>{e.preventDefault();clrPage=1;loadClearances()};
 el('cnClrFilters').onreset=()=>setTimeout(()=>{clrPage=1;loadClearances()},0);
 el('cnClrRefresh').onclick=()=>loadClearances();
 el('cnClrPrev').onclick=()=>{if(clrPage>1){clrPage--;loadClearances()}};
 el('cnClrNext').onclick=()=>{if(clrPage<clrTotalPages){clrPage++;loadClearances()}};
 el('cnCsv').onclick=()=>{
  const cells=['cycle_key','agent_name','payment_type','currency','total_amount','cdr_count','eligible_at','status','open_amount','requested_amount','paid_amount','other_amount','request_ids','cleared'];
  const cell=v=>'"'+String(v??'Not recorded').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const valueOf=(r,k)=>k==='status'?statusOf(r):(k==='cleared'?(Number(r.cleared)===1?'Cleared':'Open'):(Array.isArray(r[k])?r[k].join(';'):r[k]));
  const text=[cells.map(cell).join(','),...rows.map(r=>cells.map(k=>cell(valueOf(r,k))).join(','))].join('\r\n');
  const u=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download='ams-credit-notes-page-'+page+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
 };
 /* Loads every time the page becomes visible (first open and each return), so the
    Agent sees the same live settlement rows the Admin and Manager panels see. */
 let active=false;const changed=()=>{const next=root.classList.contains('active');if(next&&!active){
   (el('cnPaneClearance').style.display!=='none')?loadClearances():load();}active=next;};
 new MutationObserver(changed).observe(root,{attributes:true,attributeFilter:['class']});changed();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
