/* Explicit upstream Return (not downstream Unallocate). Uses existing page/table. */
(function(){'use strict';
 const root=document.getElementById('page-numbers');if(!root||!window.API)return;
 const role=/\/(admin|manager|agent|client)(?:\.html)?(?:\/|$)/.exec(location.pathname)?.[1];if(!role)return;
 let busy=false,lastVersion=null;
 const host=root.querySelector('.toolbar .filter-row,.toolbar .toolbar-left,.toolbar,.table-controls .tc-left')||root;
 function selected(){return Array.from(root.querySelectorAll('#numBody input[data-id]:checked,.rowchk[data-id]:checked,.rc[data-id]:checked')).map(c=>Number(c.dataset.id));}
 async function refresh(){
   const tasks=[];
   for(const name of ['loadNumbers','loadDashboard',role==='admin'?'loadNumberSummary':'loadNumberSummaryForBulk']){if(typeof window[name]==='function')tasks.push(Promise.resolve().then(()=>window[name]()));}
   await Promise.allSettled(tasks);
 }
 async function run(operation,button){
   const ids=selected();if(!ids.length){alert('Select numbers using their checkboxes first.');return;}
   let rate;
   if(operation==='client-rate'){
     rate=prompt('Client payout per SMS for the selected Client allocations. Empty or zero = 0.00. Existing earned payments are not changed.','');
     if(rate===null)return;
     if(!/^\s*(?:\d+(?:\.\d{1,6})?)?\s*$/.test(rate)||Number(rate)>100000){alert('Enter a non-negative decimal with at most 6 decimal places.');return;}
     if(!confirm('Update the Client payout for '+ids.length+' selected numbers? This affects the active configuration, not historical payments.'))return;
   }else{
     const message=role==='client'?'Only the selected numbers will leave your Client allocation and become available to your Agent (or your direct allocating parent). Other Client numbers stay unchanged.':'The selected numbers will return to Admin Unallocated. ALL affected Manager, Agent and Client assignments on these numbers will also be released. Number records and SMS/CDR history will NOT be deleted.';
     if(!confirm('Return '+ids.length+' selected numbers?\n\n'+message))return;
   }
   if(busy)return;busy=true;button.disabled=true;
   try{const result=await API.post('/numbers/'+operation,{ids,...(operation==='client-rate'?{rate}:{})});await refresh();alert(result.count+' numbers '+(operation==='client-rate'?'updated.':'returned.'));}
   catch(e){alert(e.message||'The operation failed. Refresh and try again.');await refresh();}
   finally{busy=false;button.disabled=false;}
 }
 function button(label,operation){const b=document.createElement('button');b.type='button';b.className='btn btn-ghost';b.textContent=label;b.setAttribute('aria-label',label);b.dataset.numberOperation=operation;b.addEventListener('click',()=>run(operation,b));host.appendChild(b);}
 button('Return selected','return');if(role==='agent')button('Set Client payout','client-rate');
 // Cross-panel freshness without exposing tokens in stream URLs or changing auth.
 // Version is global metadata only; all actual rows remain role-scoped.
 async function check(){if(busy||document.hidden)return;try{const r=await API.get('/numbers/allocation-version');if(lastVersion!==null&&lastVersion!==r.version)await refresh();lastVersion=r.version;}catch(_){} }
 window.addEventListener('focus',check);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});setInterval(check,10000);check();
})();
