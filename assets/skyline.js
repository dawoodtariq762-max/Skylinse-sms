/* ============================================================================
   SKYLINE SMS — UI & Component System (skyline.js)
   Provides: icon system, tooltips, E.164 country resolution, world map,
   error/empty states, mobile card-table helpers, export formatters.
   Backward-compatible: binds to window.Skyline and window.GX.
   ========================================================================== */
(function(){
'use strict';

const Skyline = {};

/* ---------------- E.164 Country Resolution Map ---------------- */
Skyline.E164 = {
  "1":["us","United States"],"7":["ru","Russia"],"20":["eg","Egypt"],"27":["za","South Africa"],"30":["gr","Greece"],
  "31":["nl","Netherlands"],"32":["be","Belgium"],"33":["fr","France"],"34":["es","Spain"],"40":["ro","Romania"],
  "41":["ch","Switzerland"],"43":["at","Austria"],"44":["gb","United Kingdom"],"45":["dk","Denmark"],"46":["se","Sweden"],
  "47":["no","Norway"],"48":["pl","Poland"],"49":["de","Germany"],"51":["pe","Peru"],"52":["mx","Mexico"],"53":["cu","Cuba"],
  "54":["ar","Argentina"],"55":["br","Brazil"],"56":["cl","Chile"],"57":["co","Colombia"],"58":["ve","Venezuela"],
  "60":["my","Malaysia"],"61":["au","Australia"],"62":["id","Indonesia"],"63":["ph","Philippines"],"64":["nz","New Zealand"],
  "65":["sg","Singapore"],"66":["th","Thailand"],"81":["jp","Japan"],"82":["kr","South Korea"],"84":["vn","Vietnam"],
  "86":["cn","China"],"90":["tr","Turkey"],"91":["in","India"],"92":["pk","Pakistan"],"93":["af","Afghanistan"],
  "94":["lk","Sri Lanka"],"95":["mm","Myanmar"],"98":["ir","Iran"],"212":["ma","Morocco"],"213":["dz","Algeria"],
  "216":["tn","Tunisia"],"218":["ly","Libya"],"220":["gm","Gambia"],"221":["sn","Senegal"],"222":["mr","Mauritania"],
  "223":["ml","Mali"],"224":["gn","Guinea"],"225":["ci","Ivory Coast"],"226":["bf","Burkina Faso"],"227":["ne","Niger"],
  "228":["tg","Togo"],"229":["bj","Benin"],"230":["mu","Mauritius"],"231":["lr","Liberia"],"232":["sl","Sierra Leone"],
  "233":["gh","Ghana"],"234":["ng","Nigeria"],"235":["td","Chad"],"236":["cf","Central African Republic"],"237":["cm","Cameroon"],
  "238":["cv","Cape Verde"],"239":["st","São Tomé"],"240":["gq","Equatorial Guinea"],"241":["ga","Gabon"],"242":["cg","Congo"],
  "243":["cd","DR Congo"],"244":["ao","Angola"],"245":["gw","Guinea-Bissau"],"248":["sc","Seychelles"],"249":["sd","Sudan"],
  "250":["rw","Rwanda"],"251":["so","Somalia"],"252":["so","Somalia"],"253":["dj","Djibouti"],"254":["ke","Kenya"],
  "255":["tz","Tanzania"],"256":["ug","Uganda"],"257":["bi","Burundi"],"258":["mz","Mozambique"],"260":["zm","Zambia"],
  "261":["mg","Madagascar"],"263":["zw","Zimbabwe"],"264":["na","Namibia"],"265":["mw","Malawi"],"266":["ls","Lesotho"],
  "267":["bw","Botswana"],"268":["sz","Eswatini"],"269":["km","Comoros"],"291":["er","Eritrea"],"350":["gi","Gibraltar"],
  "351":["pt","Portugal"],"352":["lu","Luxembourg"],"353":["ie","Ireland"],"354":["is","Iceland"],"355":["al","Albania"],
  "356":["mt","Malta"],"357":["cy","Cyprus"],"358":["fi","Finland"],"359":["bg","Bulgaria"],"370":["lt","Lithuania"],
  "371":["lv","Latvia"],"372":["ee","Estonia"],"373":["md","Moldova"],"374":["am","Armenia"],"375":["by","Belarus"],
  "376":["ad","Andorra"],"377":["mc","Monaco"],"378":["sm","San Marino"],"380":["ua","Ukraine"],"381":["rs","Serbia"],
  "382":["me","Montenegro"],"383":["xk","Kosovo"],"385":["hr","Croatia"],"386":["si","Slovenia"],"387":["ba","Bosnia"],
  "389":["mk","North Macedonia"],"39":["it","Italy"],"420":["cz","Czechia"],"421":["sk","Slovakia"],"423":["li","Liechtenstein"],
  "500":["fk","Falkland Islands"],"501":["bz","Belize"],"502":["gt","Guatemala"],"503":["sv","El Salvador"],"504":["hn","Honduras"],
  "505":["ni","Nicaragua"],"506":["cr","Costa Rica"],"507":["pa","Panama"],"509":["ht","Haiti"],"590":["gp","Guadeloupe"],
  "594":["gf","French Guiana"],"595":["py","Paraguay"],"596":["mq","Martinique"],"597":["sr","Suriname"],"598":["uy","Uruguay"],
  "599":["cw","Curaçao"],"670":["tl","Timor-Leste"],"673":["bn","Brunei"],"674":["nr","Nauru"],"675":["pg","Papua New Guinea"],
  "676":["to","Tonga"],"678":["vu","Vanuatu"],"679":["fj","Fiji"],"680":["pw","Palau"],"682":["ck","Cook Islands"],
  "685":["ws","Samoa"],"686":["ki","Kiribati"],"687":["nc","New Caledonia"],"688":["tv","Tuvalu"],"689":["pf","French Polynesia"],
  "690":["tk","Tokelau"],"691":["fm","Micronesia"],"692":["mh","Marshall Islands"],"850":["kp","North Korea"],"852":["hk","Hong Kong"],
  "853":["mo","Macao"],"855":["kh","Cambodia"],"856":["la","Laos"],"880":["bd","Bangladesh"],"886":["tw","Taiwan"],
  "960":["mv","Maldives"],"961":["lb","Lebanon"],"962":["jo","Jordan"],"963":["sy","Syria"],"964":["iq","Iraq"],
  "965":["kw","Kuwait"],"966":["sa","Saudi Arabia"],"967":["ye","Yemen"],"968":["om","Oman"],"970":["ps","Palestine"],
  "971":["ae","UAE"],"972":["il","Israel"],"973":["bh","Bahrain"],"974":["qa","Qatar"],"975":["bt","Bhutan"],
  "976":["mn","Mongolia"],"977":["np","Nepal"],"992":["tj","Tajikistan"],"993":["tm","Turkmenistan"],"994":["az","Azerbaijan"],
  "995":["ge","Georgia"],"996":["kg","Kyrgyzstan"],"998":["uz","Uzbekistan"]
};

Skyline.countryOf = function(num){
  const s = String(num||'').replace(/[^\d]/g,'');
  if(s.length < 7) return null;
  for(const L of [3,2,1]){
    const hit = Skyline.E164[s.slice(0,L)];
    if(hit) return {iso:hit[0], name:hit[1]};
  }
  return null;
};

/* ---------------- Inline SVG Icon Set ---------------- */
const P = {
  allocate:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  unallocate:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/>',
  trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  trashAll:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="2" y1="2" x2="22" y2="22"/>',
  move:'<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  flask:'<path d="M9 3h6"/><line x1="10" y1="3" x2="10" y2="9"/><line x1="14" y1="3" x2="14" y2="9"/><path d="M10 9L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9"/>',
  filterX:'<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/><line x1="23" y1="23" x2="17" y2="17"/><line x1="17" y1="23" x2="23" y2="17"/>',
  split:'<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  edit:'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  dots:'<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  warn:'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  dollar:'<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  globe:'<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  hash:'<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  inbox:'<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  layers:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  skyline:'<polygon points="12,22 12,11 16,11 16,22 18,22 18,7 22,7 22,22 2,22 2,15 6,15 6,22 8,22 8,3 12,3"/><line x1="2" y1="22" x2="22" y2="22"/>'
};

Skyline.icon = function(name, cls){
  return '<svg class="'+(cls||'')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(P[name]||'')+'</svg>';
};

Skyline.action = function(icon, tip, onclick, kind){
  return '<button type="button" class="gx-btn '+(kind||'')+'" data-tip="'+String(tip).replace(/"/g,'&quot;')+'" aria-label="'+String(tip).replace(/"/g,'&quot;')+'" onclick="'+onclick+'">'+Skyline.icon(icon)+'</button>';
};

Skyline.compact = function(rootSel, map){
  document.querySelectorAll(rootSel+' [data-gx]').forEach(b=>{
    const key=b.getAttribute('data-gx'), spec=map[key]; if(!spec) return;
    const tip=b.getAttribute('data-gx-tip')||spec.tip||key;
    const w=document.createElement('span'); w.innerHTML=Skyline.action(spec.icon, tip, b.getAttribute('onclick')||'', spec.kind||'');
    b.replaceWith(w.firstElementChild);
  });
};

/* ---------------- States ---------------- */
Skyline.empty = function(msg, icon){
  return '<div class="empty-state" style="text-align:center;padding:36px 18px;color:var(--sk-muted)"><div class="es-icon" style="margin-bottom:10px;opacity:.7">'+Skyline.icon(icon||'inbox')+'</div><div style="font-size:13.5px;font-weight:600">'+(msg||'No records found')+'</div></div>';
};

Skyline.error = function(msg, retryFnName){
  return '<div class="error-state" style="text-align:center;padding:28px 16px;color:#fca5a5"><div style="margin-bottom:8px">'+Skyline.icon('warn')+'</div><div style="font-weight:700;font-size:14px">Request failed</div><div style="color:var(--sk-muted);font-size:12.5px;margin:4px 0 12px">'+(msg||'Something went wrong. Please try again.')+'</div>'+(retryFnName?'<button type="button" class="btn btn-blue" onclick="'+retryFnName+'">'+Skyline.icon('refresh')+' Retry</button>':'')+'</div>';
};

Skyline.loading = function(){
  return '<div class="skeleton" style="height:120px;background:linear-gradient(90deg,rgba(56,189,248,.04) 25%,rgba(56,189,248,.10) 50%,rgba(56,189,248,.04) 75%);border-radius:12px;animation:skPulse 1.6s ease infinite"></div>';
};

Skyline.safe = function(fn, fallbackMsg){
  return function(){
    try{ return fn.apply(this, arguments); }
    catch(e){ console.error('[Skyline]', e);
      try{
        const host = document.querySelector('#page-cliSearch .table-wrap') || document.querySelector('.table-wrap');
        if(host) host.innerHTML = Skyline.error((e&&e.message)||'', 'runCliSearch()');
      }catch(_){}
    }
  };
};

/* ---------------- Mobile Card Tables ---------------- */
Skyline.applyCardLabels = function(tableSel){
  const table = document.querySelector(tableSel); if(!table) return;
  const heads = [...table.querySelectorAll('thead th')].map(th => th.innerText.replace(/[\u21C5\u25B2\u25BC]/g,'').trim());
  table.querySelectorAll('tbody tr').forEach(tr => {
    [...tr.children].forEach((td, i) => {
      if(!td.hasAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]);
    });
  });
};

/* ---------------- World Heatmap ---------------- */
Skyline.map = async function(hostSel, data){
  const host=document.querySelector(hostSel); if(!host) return;
  let svg;
  try{
    if(!Skyline.map._svg){ const r=await fetch('/assets/world.svg'); Skyline.map._svg=await r.text(); }
    svg=Skyline.map._svg;
  }catch(e){ host.innerHTML=Skyline.error('Map could not be loaded'); return; }
  const arr=(data||[]).filter(d=>d.count>0);
  const vmax=Math.max(1,...arr.map(d=>d.count));
  const names={}; arr.forEach(d=>names[d.iso]=d);
  host.innerHTML='<div class="gx-map-wrap">'+svg+'</div>'+
    '<div class="gx-map-legend" style="display:flex;justify-content:space-between;padding:8px 12px;font-size:11.5px;color:var(--sk-muted)"><span class="k"><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--sk-primary);margin-right:6px"></span> SMS volume today (darker = more)</span><span class="k" id="gxMapTop"></span></div>';
  const infoEl=document.createElement('div');
  infoEl.className='gx-map-info'; infoEl.id='gxMapInfo'; host.appendChild(infoEl);
  let hideTimer=null;
  const showInfo=(d)=>{
    clearTimeout(hideTimer);
    infoEl.innerHTML='<b>'+d.name+'</b><br><span class="cnt">'+d.count.toLocaleString()+'</span> SMS today';
    infoEl.style.display='block';
    hideTimer=setTimeout(()=>{ infoEl.style.display='none'; },3200);
  };
  host.querySelectorAll('path[id]').forEach(p=>{
    const id=p.id.toLowerCase();
    const d=names[id];
    if(d){
      const t=Math.sqrt(d.count/vmax);
      p.classList.add('gx-on');
      p.setAttribute('fill-opacity',(0.28+0.72*t).toFixed(2));
      const tip=document.createElementNS('http://www.w3.org/2000/svg','title');
      tip.textContent=d.name+': '+d.count.toLocaleString()+' SMS today';
      p.appendChild(tip);
      p.addEventListener('click',()=>showInfo(d));
    }
  });
  const top=[...arr].sort((a,b)=>b.count-a.count).slice(0,5);
  const topEl=host.querySelector('#gxMapTop');
  if(topEl && top.length) topEl.textContent='Top: '+top.map(d=>d.name+' '+d.count.toLocaleString()).join(' · ');
};

/* ---------------- Payment Term Formatter ---------------- */
Skyline.payterm = function(v){
  if(v===null||v===undefined) return '';
  const s=String(v).trim(); if(!s) return '';
  const m={daily:'1/1','1_1':'1/1','1/1':'1/1',weekly:'7/1','7_1':'7/1','7x1':'7x1','7/1':'7/1',weekly_7_1:'7/1',weekly_7_7:'7/7','7_7':'7/7','7/7':'7/7','7x7':'7x7',monthly_30x45:'30/45','30_45':'30/45','30x45':'30x45','30/45':'30/45',monthly:'30/45'};
  return m[s.toLowerCase()]||s;
};

/* ---------------- Copy & CSV Export System ---------------- */
Skyline.copyTextToClipboard = async function(text, btn){
  const feedback = () => {
    if(!btn) return;
    const oldHtml = btn.dataset.gxOrigHtml || btn.innerHTML;
    btn.dataset.gxOrigHtml = oldHtml;
    btn.innerHTML = '<span style="font-size:11px;font-weight:700;line-height:1;display:inline-flex;align-items:center;padding:0 4px;">Copied! ✓</span>';
    const oldBg = btn.style.background;
    const oldColor = btn.style.color;
    const oldBorder = btn.style.borderColor;
    btn.style.background = '#10b981';
    btn.style.color = '#ffffff';
    btn.style.borderColor = '#34d399';
    setTimeout(()=>{
      btn.innerHTML = oldHtml;
      btn.style.background = oldBg;
      btn.style.color = oldColor;
      btn.style.borderColor = oldBorder;
    }, 1500);
  };

  let ok = false;
  if(navigator.clipboard && window.isSecureContext){
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch(err) {
      console.warn('[Skyline] navigator.clipboard failed, trying fallback', err);
    }
  }
  if(!ok){
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch(err) {
      console.warn('[Skyline] execCommand fallback failed', err);
    }
  }
  feedback();
  return ok;
};

Skyline.downloadCsvBlob = function(csvText, filename){
  const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || ('skyline-export-' + new Date().toISOString().slice(0, 10) + '.csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

Skyline.downloadTxtBlob = function(txtText, filename){
  const blob = new Blob([txtText], { type: 'text/plain;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || ('skyline-export-' + new Date().toISOString().slice(0, 10) + '.txt');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

Skyline.csvEsc = function(val){
  if(val === null || val === undefined) return '""';
  return '"' + String(val).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
};

Skyline.handleTableCopy = async function(btn){
  const wrap = btn.closest('.table-wrap') || btn.closest('.card') || document.querySelector('section.page.active .table-wrap');
  const table = wrap ? wrap.querySelector('table') : null;
  if(!table) return;
  const ths = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').replace(/[\u21C5\u25B2\u25BC⇅]/g, '').trim()).filter(Boolean);
  const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length > 1 && !tr.querySelector('th'));
  if(!rows.length) return;
  const lines = [];
  lines.push(ths.join('\t'));
  rows.forEach(tr => {
    const cells = [...tr.children].map(td => (td.innerText || td.textContent || '').trim().replace(/\s+/g, ' '));
    lines.push(cells.join('\t'));
  });
  await Skyline.copyTextToClipboard(lines.join('\n'), btn);
};

Skyline.handleTableCsv = async function(btn){
  const activePage = document.querySelector('section.page.active') || btn.closest('section.page');
  const pageId = activePage ? activePage.id : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  const feedback = () => {
    if(!btn) return;
    const oldHtml = btn.dataset.gxOrigHtml || btn.innerHTML;
    btn.dataset.gxOrigHtml = oldHtml;
    btn.innerHTML = '<span style="font-size:11px;font-weight:700;line-height:1;display:inline-flex;align-items:center;padding:0 4px;">Exported! ✓</span>';
    const oldBg = btn.style.background;
    const oldColor = btn.style.color;
    btn.style.background = '#2563eb';
    btn.style.color = '#ffffff';
    setTimeout(()=>{
      btn.innerHTML = oldHtml;
      btn.style.background = oldBg;
      btn.style.color = oldColor;
    }, 1500);
  };

  // 1. SMS Numbers page
  if(pageId === 'page-numbers' || pageId === 'numbers'){
    try {
      const rf = document.getElementById('numRange')?.value || '';
      const q = (document.getElementById('numSearch')?.value || '').trim();
      const cf = document.getElementById('numClient')?.value || '';
      const params = new URLSearchParams({ limit: '10000', paged: '1' });
      if(rf) params.set('range', rf);
      if(q) params.set('search', q);
      if(cf) params.set('client', cf);
      const res = await API.get('/numbers?' + params.toString());
      const rows = res.rows || (Array.isArray(res) ? res : []);
      if(rows.length > 0){
        const user = (window.API && API.user) ? API.user : {};
        let headers, mapRow;
        if(user.role === 'client'){
          headers = ['Range', 'Number', 'Payterm', 'Status', 'Last SMS Time', 'SD Limit', 'SW Limit'];
          mapRow = r => [r.range_name || r.range || '', r.number || '', r.payterm || 'Weekly', r.status || 'Active', r.last_sms_at || '', r.sd_limit || 0, r.sw_limit || 0];
        } else {
          headers = ['Range', 'Prefix', 'Country', 'Number', 'Manager', 'Agent', 'Client', 'Rate', 'Payout', 'Status'];
          mapRow = r => [r.range_name || r.range || '', r.prefix || '', r.country || '', r.number || '', r.manager_name || '', r.agent_name || '', r.client_name || '', r.rate || 'NA', r.payout || 'NA', r.status || 'Active'];
        }
        const csv = [headers.map(Skyline.csvEsc).join(',')].concat(rows.map(r => mapRow(r).map(Skyline.csvEsc).join(','))).join('\r\n');
        Skyline.downloadCsvBlob(csv, `SMS_Numbers_${dateStr}.csv`);
        feedback();
        return;
      }
    } catch(e){
      console.warn('[Skyline] numbers export failed', e);
    }
  }

  // 2. SMS Report page or Client SMS Stats page
  if(pageId === 'page-smsReport' || pageId === 'page-stats' || pageId === 'smsReport' || pageId === 'stats'){
    try {
      const useDate = document.getElementById('stUseDate') ? document.getElementById('stUseDate').checked : (document.getElementById('sdUseDate') ? document.getElementById('sdUseDate').checked : true);
      const useRange = document.getElementById('stUseRange') ? document.getElementById('stUseRange').checked : (document.getElementById('sdUseRange') ? document.getElementById('sdUseRange').checked : true);
      const useCli = document.getElementById('stUseCli') ? document.getElementById('stUseCli').checked : (document.getElementById('sdUseCli') ? document.getElementById('sdUseCli').checked : true);
      const useNumber = document.getElementById('stUseNumber') ? document.getElementById('stUseNumber').checked : (document.getElementById('sdUseNumber') ? document.getElementById('sdUseNumber').checked : true);

      const f = useDate ? (document.getElementById('srFrom')?.value || document.getElementById('stFrom')?.value || '') : '';
      const t = useDate ? (document.getElementById('srTo')?.value || document.getElementById('stTo')?.value || '') : '';
      const tf = useDate ? (document.getElementById('srTFrom')?.value || document.getElementById('stTFrom')?.value || '') : '';
      const tt = useDate ? (document.getElementById('srTTo')?.value || document.getElementById('stTTo')?.value || '') : '';
      const rf = useRange ? (document.getElementById('srRange')?.value || document.getElementById('stRange')?.value || '') : '';
      const cf = useCli ? (document.getElementById('srCli')?.value || document.getElementById('stCli')?.value || '') : '';
      const nf = useNumber ? (document.getElementById('srNumber')?.value || document.getElementById('stNumber')?.value || '') : '';
      const mf = document.getElementById('srManager')?.value || '';
      const q = document.getElementById('srSearch')?.value || document.getElementById('stSearch')?.value || '';

      const params = new URLSearchParams({ limit: '10000', page: '1', sort: 'date', dir: 'desc' });
      if(f) params.set('from', f);
      if(t) params.set('to', t);
      if(tf) params.set('tfrom', tf);
      if(tt) params.set('tto', tt);
      if(rf) params.set('range', rf);
      if(cf) params.set('cli', cf);
      if(nf) params.set('number', nf.trim());
      if(mf) params.set('manager', mf);
      if(q) params.set('search', q.trim());

      const res = await API.get('/sms/paged?' + params.toString());
      const rows = res.rows || (Array.isArray(res) ? res : []);
      if(rows.length > 0){
        const user = (window.API && API.user) ? API.user : {};
        let headers, mapRow;
        if(user.role === 'client'){
          headers = ['Date (UK)', 'Range', 'Number', 'CLI', 'OTP Code', 'Message'];
          mapRow = r => [(r.received_at || '').slice(0, 19), r.range_name || '', r.number || '', r.cli || '', r.otp_code || '', r.message || ''];
        } else {
          headers = ['Date (UK)', 'Range', 'Number', 'CLI', 'OTP Code', 'Message', 'Manager', 'Agent', 'Client', 'Payout Rate', 'Payout Amount'];
          mapRow = r => [(r.received_at || '').slice(0, 19), r.range_name || '', r.number || '', r.cli || '', r.otp_code || '', r.message || '', r.manager_name || '', r.agent_name || '', r.client_name || '', r.payout_rate || '0', r.payout_amount || '0'];
        }
        const csv = [headers.map(Skyline.csvEsc).join(',')].concat(rows.map(r => mapRow(r).map(Skyline.csvEsc).join(','))).join('\r\n');
        Skyline.downloadCsvBlob(csv, `SMS_Report_${dateStr}.csv`);
        feedback();
        return;
      }
    } catch(e){
      console.warn('[Skyline] sms report export failed', e);
    }
  }

  // 3. CDR Report / Detailed Report
  if(pageId === 'page-smsDetail' || pageId === 'smsDetail'){
    if(window.cdrReport && typeof window.cdrReport.exportAllCsv === 'function'){
      window.cdrReport.exportAllCsv();
      feedback();
      return;
    }
  }

  // 4. Rate Management
  if(pageId === 'page-rates' || pageId === 'rates'){
    if(window.ratesData && window.ratesData.length){
      const user = (window.API && API.user) ? API.user : {};
      let headers, mapRow;
      if(user.role === 'admin'){
        headers = ['Range Name', 'Prefix', 'Test Number', 'Currency', 'Rate 1/1', 'Rate 7/1', 'Rate 7/7', 'Rate 30/45', 'Provider Rate', 'Memo'];
        mapRow = r => [r.name || '', r.prefix || '', r.test_number || '', r.currency || 'USD', r.rate_1_1 || 'NA', r.rate_7_1 || 'NA', r.rate_7_7 || 'NA', r.rate_30_45 || 'NA', r.provider_rate || '0', r.memo || ''];
      } else {
        headers = ['Range Name', 'Prefix', 'Test Number', 'Currency', 'Rate 1/1', 'Rate 7/1', 'Rate 7/7', 'Rate 30/45', 'Memo'];
        mapRow = r => [r.name || '', r.prefix || '', r.test_number || '', r.currency || 'USD', r.rate_1_1 || 'NA', r.rate_7_1 || 'NA', r.rate_7_7 || 'NA', r.rate_30_45 || 'NA', r.memo || ''];
      }
      const q = (document.getElementById('rateSearch')?.value || '').toLowerCase();
      const filtered = window.ratesData.filter(r => (r.name||'').toLowerCase().includes(q) || (r.test_number||'').includes(q));
      const csv = [headers.map(Skyline.csvEsc).join(',')].concat(filtered.map(r => mapRow(r).map(Skyline.csvEsc).join(','))).join('\r\n');
      Skyline.downloadCsvBlob(csv, `Rate_Management_${dateStr}.csv`);
      feedback();
      return;
    }
  }

  // 5. Fallback: Export current table from DOM
  const wrap = btn.closest('.table-wrap') || btn.closest('.card') || document.querySelector('section.page.active .table-wrap');
  const table = wrap ? wrap.querySelector('table') : null;
  if(table){
    const ths = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').replace(/[\u21C5\u25B2\u25BC⇅]/g, '').trim()).filter(Boolean);
    const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length > 1 && !tr.querySelector('th'));
    if(rows.length > 0){
      const lines = [ths.map(Skyline.csvEsc).join(',')];
      rows.forEach(tr => {
        const cells = [...tr.children].map(td => (td.innerText || td.textContent || '').trim());
        lines.push(cells.map(Skyline.csvEsc).join(','));
      });
      Skyline.downloadCsvBlob(lines.join('\r\n'), `${pageId || 'Table'}_Export_${dateStr}.csv`);
      feedback();
      return;
    }
  }
  alert('No data available to export.');
};

Skyline.handleTableTxt = async function(btn){
  const activePage = document.querySelector('section.page.active') || btn.closest('section.page');
  const pageId = activePage ? activePage.id : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  const feedback = () => {
    if(!btn) return;
    const oldHtml = btn.dataset.gxOrigHtml || btn.innerHTML;
    btn.dataset.gxOrigHtml = oldHtml;
    btn.innerHTML = '<span style="font-size:11px;font-weight:700;line-height:1;display:inline-flex;align-items:center;padding:0 4px;">Exported! ✓</span>';
    const oldBg = btn.style.background;
    const oldColor = btn.style.color;
    btn.style.background = '#2563eb';
    btn.style.color = '#ffffff';
    setTimeout(()=>{
      btn.innerHTML = oldHtml;
      btn.style.background = oldBg;
      btn.style.color = oldColor;
    }, 1500);
  };

  // 1. SMS Numbers page
  if(pageId === 'page-numbers' || pageId === 'numbers'){
    try {
      const rf = document.getElementById('numRange')?.value || '';
      const q = (document.getElementById('numSearch')?.value || '').trim();
      const cf = document.getElementById('numClient')?.value || '';
      const params = new URLSearchParams({ limit: '10000', paged: '1' });
      if(rf) params.set('range', rf);
      if(q) params.set('search', q);
      if(cf) params.set('client', cf);
      const res = await API.get('/numbers?' + params.toString());
      const rows = res.rows || (Array.isArray(res) ? res : []);
      if(rows.length > 0){
        const user = (window.API && API.user) ? API.user : {};
        let headers, mapRow;
        if(user.role === 'client'){
          headers = ['Range', 'Number', 'Payterm', 'Status', 'Last SMS Time', 'SD Limit', 'SW Limit'];
          mapRow = r => [r.range_name || r.range || '', r.number || '', r.payterm || 'Weekly', r.status || 'Active', r.last_sms_at || '', r.sd_limit || 0, r.sw_limit || 0];
        } else {
          headers = ['Range', 'Prefix', 'Country', 'Number', 'Manager', 'Agent', 'Client', 'Rate', 'Payout', 'Status'];
          mapRow = r => [r.range_name || r.range || '', r.prefix || '', r.country || '', r.number || '', r.manager_name || '', r.agent_name || '', r.client_name || '', r.rate || 'NA', r.payout || 'NA', r.status || 'Active'];
        }
        const txt = [headers.join('\t')].concat(rows.map(r => mapRow(r).join('\t'))).join('\r\n');
        Skyline.downloadTxtBlob(txt, `SMS_Numbers_${dateStr}.txt`);
        feedback();
        return;
      }
    } catch(e){
      console.warn('[Skyline] numbers txt export failed', e);
    }
  }

  // 2. SMS Report page or Client SMS Stats page
  if(pageId === 'page-smsReport' || pageId === 'page-stats' || pageId === 'smsReport' || pageId === 'stats'){
    try {
      const useDate = document.getElementById('stUseDate') ? document.getElementById('stUseDate').checked : (document.getElementById('sdUseDate') ? document.getElementById('sdUseDate').checked : true);
      const useRange = document.getElementById('stUseRange') ? document.getElementById('stUseRange').checked : (document.getElementById('sdUseRange') ? document.getElementById('sdUseRange').checked : true);
      const useCli = document.getElementById('stUseCli') ? document.getElementById('stUseCli').checked : (document.getElementById('sdUseCli') ? document.getElementById('sdUseCli').checked : true);
      const useNumber = document.getElementById('stUseNumber') ? document.getElementById('stUseNumber').checked : (document.getElementById('sdUseNumber') ? document.getElementById('sdUseNumber').checked : true);

      const f = useDate ? (document.getElementById('srFrom')?.value || document.getElementById('stFrom')?.value || '') : '';
      const t = useDate ? (document.getElementById('srTo')?.value || document.getElementById('stTo')?.value || '') : '';
      const tf = useDate ? (document.getElementById('srTFrom')?.value || document.getElementById('stTFrom')?.value || '') : '';
      const tt = useDate ? (document.getElementById('srTTo')?.value || document.getElementById('stTTo')?.value || '') : '';
      const rf = useRange ? (document.getElementById('srRange')?.value || document.getElementById('stRange')?.value || '') : '';
      const cf = useCli ? (document.getElementById('srCli')?.value || document.getElementById('stCli')?.value || '') : '';
      const nf = useNumber ? (document.getElementById('srNumber')?.value || document.getElementById('stNumber')?.value || '') : '';
      const mf = document.getElementById('srManager')?.value || '';
      const q = document.getElementById('srSearch')?.value || document.getElementById('stSearch')?.value || '';

      const params = new URLSearchParams({ limit: '10000', page: '1', sort: 'date', dir: 'desc' });
      if(f) params.set('from', f);
      if(t) params.set('to', t);
      if(tf) params.set('tfrom', tf);
      if(tt) params.set('tto', tt);
      if(rf) params.set('range', rf);
      if(cf) params.set('cli', cf);
      if(nf) params.set('number', nf.trim());
      if(mf) params.set('manager', mf);
      if(q) params.set('search', q.trim());

      const res = await API.get('/sms/paged?' + params.toString());
      const rows = res.rows || (Array.isArray(res) ? res : []);
      if(rows.length > 0){
        const user = (window.API && API.user) ? API.user : {};
        let headers, mapRow;
        if(user.role === 'client'){
          headers = ['Date (UK)', 'Range', 'Number', 'CLI', 'OTP Code', 'Message'];
          mapRow = r => [(r.received_at || '').slice(0, 19), r.range_name || '', r.number || '', r.cli || '', r.otp_code || '', (r.message || '').replace(/\r?\n/g, ' ')];
        } else {
          headers = ['Date (UK)', 'Range', 'Number', 'CLI', 'OTP Code', 'Message', 'Manager', 'Agent', 'Client', 'Payout Rate', 'Payout Amount'];
          mapRow = r => [(r.received_at || '').slice(0, 19), r.range_name || '', r.number || '', r.cli || '', r.otp_code || '', (r.message || '').replace(/\r?\n/g, ' '), r.manager_name || '', r.agent_name || '', r.client_name || '', r.payout_rate || '0', r.payout_amount || '0'];
        }
        const txt = [headers.join('\t')].concat(rows.map(r => mapRow(r).join('\t'))).join('\r\n');
        Skyline.downloadTxtBlob(txt, `SMS_Report_${dateStr}.txt`);
        feedback();
        return;
      }
    } catch(e){
      console.warn('[Skyline] sms report txt export failed', e);
    }
  }

  // 3. CDR Report / Detailed Report
  if(pageId === 'page-smsDetail' || pageId === 'smsDetail'){
    if(window.cdrReport && typeof window.cdrReport.downloadTxt === 'function'){
      window.cdrReport.downloadTxt();
      feedback();
      return;
    }
  }

  // 4. Rate Management
  if(pageId === 'page-rates' || pageId === 'rates'){
    if(window.ratesData && window.ratesData.length){
      const user = (window.API && API.user) ? API.user : {};
      let headers, mapRow;
      if(user.role === 'admin'){
        headers = ['Range Name', 'Prefix', 'Test Number', 'Currency', 'Rate 1/1', 'Rate 7/1', 'Rate 7/7', 'Rate 30/45', 'Provider Rate', 'Memo'];
        mapRow = r => [r.name || '', r.prefix || '', r.test_number || '', r.currency || 'USD', r.rate_1_1 || 'NA', r.rate_7_1 || 'NA', r.rate_7_7 || 'NA', r.rate_30_45 || 'NA', r.provider_rate || '0', r.memo || ''];
      } else {
        headers = ['Range Name', 'Prefix', 'Test Number', 'Currency', 'Rate 1/1', 'Rate 7/1', 'Rate 7/7', 'Rate 30/45', 'Memo'];
        mapRow = r => [r.name || '', r.prefix || '', r.test_number || '', r.currency || 'USD', r.rate_1_1 || 'NA', r.rate_7_1 || 'NA', r.rate_7_7 || 'NA', r.rate_30_45 || 'NA', r.memo || ''];
      }
      const q = (document.getElementById('rateSearch')?.value || '').toLowerCase();
      const filtered = window.ratesData.filter(r => (r.name||'').toLowerCase().includes(q) || (r.test_number||'').includes(q));
      const txt = [headers.join('\t')].concat(filtered.map(r => mapRow(r).join('\t'))).join('\r\n');
      Skyline.downloadTxtBlob(txt, `Rate_Management_${dateStr}.txt`);
      feedback();
      return;
    }
  }

  // 5. Fallback: Export current table from DOM as tab-delimited text
  const wrap = btn.closest('.table-wrap') || btn.closest('.card') || document.querySelector('section.page.active .table-wrap');
  const table = wrap ? wrap.querySelector('table') : null;
  if(table){
    const ths = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').replace(/[\u21C5\u25B2\u25BC⇅]/g, '').trim()).filter(Boolean);
    const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length > 1 && !tr.querySelector('th'));
    if(rows.length > 0){
      const lines = [ths.join('\t')];
      rows.forEach(tr => {
        const cells = [...tr.children].map(td => (td.innerText || td.textContent || '').trim().replace(/\r?\n/g, ' '));
        lines.push(cells.join('\t'));
      });
      Skyline.downloadTxtBlob(lines.join('\r\n'), `${pageId || 'Table'}_Export_${dateStr}.txt`);
      feedback();
      return;
    }
  }
  alert('No data available to export.');
};

/* ---------------- Export Wiring (Copy / CSV / Excel) ---------------- */
Skyline.wireExports = function(){
  document.addEventListener('click', async (e)=>{
    const b = e.target.closest('.exp-btns button, .exp-btns .gx-btn, .exp-btns .btn, button[data-tip="Copy"], button[data-tip="Download CSV"], button[data-tip="Download Excel"], button[data-tip="Download TXT"], button[data-tip="TXT"], #cdrBtnCopy, #cdrBtnTxt, #cdrBtnCsv, #cdrBtnExcel');
    if(!b) return;
    const tip = (b.getAttribute('data-tip') || b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
    if(tip.includes('copy')){
      e.preventDefault();
      await Skyline.handleTableCopy(b);
      return;
    }
    if(tip.includes('txt') || tip.includes('download txt')){
      e.preventDefault();
      await Skyline.handleTableTxt(b);
      return;
    }
    if(tip.includes('csv') || tip.includes('download csv') || tip.includes('excel') || tip.includes('download excel')){
      e.preventDefault();
      await Skyline.handleTableCsv(b);
      return;
    }
  });
};
try{ Skyline.wireExports(); }catch(e){}

/* ---------------- SVG Icon Set ---------------- */
const I=(p)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
Skyline.icons={
  copy:I('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  download:I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload:I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  reset:I('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  refresh:I('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  filter:I('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  search:I('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  check:I('<polyline points="20 6 9 17 4 12"/>'),
  undo:I('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  trash:I('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>'),
  edit:I('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  save:I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  tag:I('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  x:I('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  test:I('<path d="M9 3h6"/><path d="M10 3v6L4.6 18.6A2 2 0 0 0 6.4 21.5h11.2a2 2 0 0 0 1.8-2.9L14 9V3"/><line x1="7.5" y1="15" x2="16.5" y2="15"/>'),
  power:I('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
  plus:I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  calendar:I('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  shuffle:I('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
  eye:I('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  key:I('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m3 3L22 7l-3-3-3.5 3.5z"/>'),
  play:I('<polygon points="6 3 20 12 6 21 6 3"/>'),
  dollar:I('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  history:I('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')
};
Skyline.svg=(k)=>Skyline.icons[k]?('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+Skyline.icons[k]+'</svg>'):'';

/* Emoji icon-btns -> consistent SVG */
Skyline.iconifyActions=function(root){
  const map={'\u270e':'edit','\u270f':'edit','\ud83d\uddd1':'trash','\u2699':'key','\u25b6':'play','\u27f3':'refresh','\u21c4':'shuffle','\ud83d\udc41':'eye'};
  (root||document).querySelectorAll('.icon-btn').forEach(b=>{
    const t=(b.textContent||'').trim();
    const k=map[t]||map[t.replace(/[\u270e\u270f\ud83d\uddd1\u2699\u25b6\u27f3\u21c4\ud83d\udc41]/g,'')];
    if(k&&Skyline.icons[k]){
      b.innerHTML=Skyline.icons[k];
      const tip=b.getAttribute('title')||b.getAttribute('data-tip')||k;
      b.setAttribute('data-tip',tip); b.setAttribute('aria-label',tip); b.setAttribute('title',tip);
    }
  });
};
let _skIcoT=null;
try{
  new MutationObserver(()=>{ clearTimeout(_skIcoT); _skIcoT=setTimeout(()=>Skyline.iconifyActions(),120); })
    .observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}

/* ---------------- Light/Dark Theme Toggle ---------------- */
Skyline.theme = {
  apply(t){
    const isLight = t==='light';
    document.body.classList.toggle('gx-light', isLight);
    document.body.classList.toggle('sk-light', isLight);
    try{ document.documentElement.classList.toggle('gx-light', isLight); document.documentElement.classList.toggle('sk-light', isLight); }catch(e){}
  },
  current(){ try{ return localStorage.getItem('sk-theme')||localStorage.getItem('gx-theme')||'dark'; }catch(e){ return 'dark'; } },
  init(){
    this.apply(this.current());
    const build=()=>{
      const btn=document.createElement('button');
      btn.type='button'; btn.className='gx-theme-btn'; btn.setAttribute('data-tip','Skyline Dark / Light mode'); btn.setAttribute('aria-label','Toggle theme');
      const sun='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/></svg>';
      const moon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      const paint=()=>{ btn.innerHTML = document.body.classList.contains('sk-light')||document.body.classList.contains('gx-light') ? moon : sun; };
      paint();
      btn.addEventListener('click',()=>{
        const next = (document.body.classList.contains('sk-light')||document.body.classList.contains('gx-light')) ? 'dark' : 'light';
        this.apply(next);
        try{ localStorage.setItem('sk-theme', next); localStorage.setItem('gx-theme', next); }catch(e){}
        paint();
      });
      const tb=document.querySelector('.tb-right')||document.querySelector('.tb1')||document.querySelector('.topbar')||document.querySelector('.mgr-topbar');
      if(tb){ tb.appendChild(btn); }
      else { btn.style.cssText='position:fixed;right:14px;bottom:14px;z-index:90'; document.body.appendChild(btn); }
    };
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', build);
    else build();
  }
};
try{ Skyline.theme.init(); }catch(e){}
try{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>Skyline.iconifyActions()); else Skyline.iconifyActions(); }catch(e){}

Skyline.pay3=(v)=>{let s=String(v??'').replace(/[$,\s]/g,'');const m=s.match(/-?\d+(?:\.\d+)?/);if(!m)return '0';const p=m[0].split('.');if(p.length<2)return p[0];const d=p[1].slice(0,3).replace(/0+$/,'');return d?p[0]+'.'+d:p[0];};
Skyline.moneyShort=(v)=>{const n=Number(v)||0;const a=Math.abs(n);if(a>=1e9)return (n/1e9).toFixed(a%1e9?2:0)+'B';if(a>=1e6)return (n/1e6).toFixed(a%1e6?2:0)+'M';if(a>=1e4)return (n/1e3).toFixed(a%1e3?1:0)+'K';let s=String(n);if(s.includes('.'))s=s.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');return s;};

/* Export to window */
Skyline.Skyline = Skyline;
Skyline.GX = Skyline;
window.Skyline = Skyline;
window.GX = Skyline;

})();
