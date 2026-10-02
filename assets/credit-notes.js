/* Credit Notes page: weekly payout notes (Pending/Released tracking over EXISTING
   payout data) + the read-only live settlement statement. No payout/allocation logic here. */
(function () {
  'use strict';
  function init() {
    const root = document.getElementById('page-creditNotes'); if (!root) return;
    ensureStyle();
    if (root.dataset.built) return;
    root.dataset.built = '1';
    let ROLE = 'agent';
    try { ROLE = (window.API && API.role && API.role()) || 'agent'; } catch (e) { }
    const IS_ADMIN = ROLE === 'admin';
    const IS_MANAGER = ROLE === 'manager';
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = v => '$' + String(v ?? '0');

    root.innerHTML = `
      <div class="page-head"><div><h2>Credit Notes</h2><div class="breadcrumb"><b>Finance</b> › Weekly Payout Notes</div></div></div>
      <div class="gx-cn-notice">Weekly notes follow the <b>existing payout week configured in Payment Management</b> (e.g. Mon → Sun). Amounts come from existing payout data — nothing is recalculated, reset or rerouted here. Marking a note <b>Released</b> only records that the payment was made outside the panel${IS_MANAGER ? ' (e.g. Binance)' : ''}. Earlier weeks are never deleted, and releasing a manager's note never releases their agents' notes.</div>
      <div class="gx-cn-tabs" id="cnTabs">
        <button type="button" class="gx-cn-tab active" data-tab="weekly">Weekly Credit Notes</button>
        <button type="button" class="gx-cn-tab" data-tab="statement">Settlement Statement</button>
      </div>

      <section id="cnWeeklyPanel">
        <div class="gx-cn-cards" id="cnwCards"></div>
        <form class="toolbar" id="cnwFilters">
          ${IS_ADMIN ? `<label>Notes <select id="cnwSubject"><option value="">Manager + Agent notes</option><option value="manager">Manager notes</option><option value="agent">Agent notes</option></select></label>
          <label>Manager <select id="cnwManager"><option value="">All managers</option></select></label>` : ''}
          ${(IS_ADMIN || IS_MANAGER) ? `<label>${IS_ADMIN ? 'Agent' : 'Agent (mine)'} <select id="cnwAgent"><option value="">All agents</option></select></label>` : ''}
          <label>Status <select id="cnwStatus"><option value="">All</option><option value="Pending" selected>Pending</option><option value="Released">Released</option></select></label>
          <label>History <select id="cnwWeeks"><option value="4">Last 4 weeks</option><option value="8">Last 8 weeks</option><option value="14" selected>Last 3 months</option><option value="26">Last 6 months</option></select></label>
          <button class="btn btn-blue" type="submit">Show Notes</button>
          <button class="btn btn-ghost" type="reset">Reset</button>
        </form>
        <div class="table-wrap">
          <div class="card-head"><h3>WEEKLY CREDIT NOTES · <span id="cnwScope">MY NOTES</span></h3></div>
          <div class="table-controls">
            <div class="tc-left"><button class="btn btn-ghost" id="cnwCsv" type="button">Export CSV</button><span class="gx-cn-updated" id="cnwUpdated"></span></div>
            <div class="tc-right"><label for="cnwLen">Show records</label> <select id="cnwLen"><option>25</option><option selected>50</option><option>100</option><option value="All">All</option></select></div>
          </div>
          <div id="cnwStatusMsg" class="gx-statement-status" role="status" aria-live="polite"></div>
          <div class="tscroll"><table><thead id="cnwHead"></thead><tbody id="cnwBody"></tbody></table></div>
          <div class="table-foot"><span id="cnwInfo">No notes loaded</span></div>
        </div>
      </section>

      <section id="cnStatementPanel" style="display:none">
        <div class="gx-statement-notice"><b>Read-only live statement</b> · These records describe existing ledger earnings. They are not issued documents and do not add credit or change payment eligibility.<br>Currency is not recorded on the historical ledger. Amounts below are ledger units; weekly terms are shown exactly as stored.</div>
        <form class="toolbar gx-statement-filters" id="cnFilters">
          <label>Cycle from<input id="cnFrom" type="date"></label><label>Cycle to<input id="cnTo" type="date"></label>
          <label>Payment type<select id="cnType"><option value="">All types</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly_30x45">Monthly (30x45)</option></select></label>
          <label>Maturity<select id="cnMaturity"><option value="">All</option><option value="matured">Matured</option><option value="upcoming">Upcoming</option><option value="unknown">Not recorded</option></select></label>
          <button class="btn btn-blue" type="submit">Show Report</button><button class="btn btn-ghost" type="reset">Reset</button></form>
        <div class="table-wrap"><div class="card-head"><h3>CREDIT NOTES · LIVE SETTLEMENTS</h3></div>
        <div class="table-controls"><div class="tc-left"><button class="btn btn-ghost" id="cnCsv" type="button" disabled>CSV · current page</button></div><div class="tc-right"><label for="cnSize">Show records</label> <select id="cnSize"><option>25</option><option>50</option><option>100</option></select></div></div>
        <div id="cnStatus" class="gx-statement-status" role="status" aria-live="polite"></div>
        <div class="tscroll"><table class="gx-statement-table"><thead><tr><th>Cycle start</th><th>Agent</th><th>Term</th><th>Currency</th><th>Ledger amount</th><th>CDRs</th><th>Eligible at (UTC)</th><th>Maturity</th><th>Open</th><th>Requested</th><th>Paid</th><th>Other</th><th>Request IDs</th></tr></thead><tbody id="cnBody"></tbody></table></div>
        <div class="table-foot"><span id="cnCount">No report loaded</span><div class="pagination"><button id="cnPrev" type="button" disabled>Previous</button><button id="cnNext" type="button" disabled>Next</button></div></div></div>
        <p class="hint" style="margin-top:12px">Matured does not mean paid or automatically withdrawable. Existing minimums, payment-request rules and Security PIN protection remain in effect. Date filters use stored cycle-start dates. CSV exports only the displayed page.</p>
      </section>`;

    const el = id => document.getElementById(id);
    /* ---------------- tabs ---------------- */
    let tab = 'weekly';
    function setTab(t) {
      tab = t;
      root.querySelectorAll('.gx-cn-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
      el('cnWeeklyPanel').style.display = t === 'weekly' ? '' : 'none';
      el('cnStatementPanel').style.display = t === 'statement' ? '' : 'none';
      if (t === 'statement') loadStatement(); else loadNotes();
    }
    root.querySelectorAll('.gx-cn-tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));

    /* ================= WEEKLY CREDIT NOTES ================= */
    let data = null, rows = [];
    function renderCards() {
      const c = el('cnwCards'); if (!c) return;
      const t = (data && data.totals) || {};
      const min = ((data && data.minimum) || {}).weekly || '0';
      const wk = (data && data.week) || {};
      const cur = rows.find(r => r.is_current && (IS_ADMIN ? r.subject_role === 'agent' : true));
      const cards = [];
      if (IS_ADMIN) {
        cards.push(['Current payout week', wk.start || '—', (wk.start ? wk.start + ' → ' + wk.end : '')]);
        cards.push(['Outstanding (Pending)', money(t.pending), t.rows_scoped + ' note(s) tracked']);
        cards.push(['Released to date', money(t.released), 'recorded releases']);
        cards.push(['Weekly minimum payout', money(min), 'existing rule, unchanged']);
      } else if (IS_MANAGER) {
        cards.push(['My note · current week', money(t.my_pending), (wk.start || '—') + ' → ' + (wk.end || '—')]);
        cards.push(['My outstanding (Pending)', money(t.my_pending), 'admin releases my note']);
        cards.push(['Agents outstanding (Pending)', money(t.pending), 'I release agent notes after paying']);
        cards.push(['Weekly minimum payout', money(min), 'unchanged']);
      } else {
        cards.push(['Current week', money(t.my_pending), (wk.start || '—') + ' → ' + (wk.end || '—')]);
        cards.push(['Total outstanding', money(t.my_pending), 'Pending']);
        cards.push(['Total released', money(t.my_released), 'paid & recorded']);
        cards.push(['Weekly minimum payout', money(min), 'unchanged']);
      }
      c.innerHTML = cards.map(x => `<div class="gx-cn-card"><div class="lbl">${esc(x[0])}</div><div class="val">${esc(x[1])}</div><div class="sub">${esc(x[2])}</div></div>`).join('');
      const scope = el('cnwScope');
      if (scope) scope.textContent = IS_ADMIN ? 'MANAGER + AGENT NOTES' : IS_MANAGER ? 'MY NOTE + MY AGENTS' : 'MY WEEKLY NOTES';
      if (cur && wk.start) { /* current-week marker already in the row */ }
    }
    function fillSelect(sel, allLabel, entries) {
      if (!sel) return;
      const keep = sel.value;
      sel.innerHTML = `<option value="">${allLabel}</option>` + entries.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
      if (keep && entries.some(([id]) => String(id) === String(keep))) sel.value = keep;
    }
    function fillSelects() {
      if (IS_ADMIN) {
        const mgrs = new Map(); rows.filter(r => r.subject_role === 'manager').forEach(r => mgrs.set(String(r.subject_id), r.subject_name));
        fillSelect(el('cnwManager'), 'All managers', [...mgrs.entries()]);
      }
      if (IS_ADMIN || IS_MANAGER) {
        const ags = new Map(); rows.filter(r => r.subject_role === 'agent').forEach(r => { if (!ags.has(String(r.subject_id))) ags.set(String(r.subject_id), r.subject_name + (r.manager_name ? ' (' + r.manager_name + ')' : '')); });
        fillSelect(el('cnwAgent'), 'All agents', [...ags.entries()]);
      }
    }
    function subjOutstanding() {
      const m = new Map();
      rows.forEach(r => { if (r.status !== 'Released') { const k = r.subject_role + ':' + r.subject_id; m.set(k, (m.get(k) || 0) + (Number(r.amount) || 0)); } });
      const out = new Map();
      m.forEach((v, k) => out.set(k, Math.round(v * 100) / 100));
      return out;
    }
    function renderRows() {
      const head = el('cnwHead'), body = el('cnwBody');
      const showManager = IS_ADMIN || IS_MANAGER;
      head.innerHTML = `<tr><th>Week (cycle start)</th><th>Period</th>${IS_ADMIN ? '<th>Note</th>' : ''}${showManager ? '<th>Agent</th>' : ''}<th>Amount</th>${showManager ? '<th>Outstanding</th>' : ''}<th>Status</th>${showManager ? '<th>Released by / paid to</th>' : '<th>Released by / paid to</th>'}<th>Action</th></tr>`;
      const len = el('cnwLen').value;
      const pag = API.paginateRows('cnwTable', rows, len, 'cnwInfo', renderRows);
      const total = pag.total; const pageRows = pag.rows;
      const out = subjOutstanding();
      body.innerHTML = pageRows.map(r => {
        const subj = (r.subject_role === 'manager' ? '<span class="tag tag-mgr">Manager</span> ' : '<span class="tag tag-agt">Agent</span> ') + esc(r.subject_name || '—');
        const stat = r.status === 'Released' ? '<span class="tag tag-green">Released</span>' : '<span class="tag tag-amber">Pending</span>';
        const who = [r.released_by_name ? esc(r.released_by_name) + (r.released_by_role ? ' (' + esc(r.released_by_role) + ')' : '') : '', r.released_at ? esc(String(r.released_at).slice(0, 16)) : '', r.paid_to ? 'paid to ' + esc(r.paid_to) : ''].filter(Boolean).join('<br>') || '—';
        const action = r.can_release ? `<button type="button" class="btn btn-green btn-sm" onclick="GXCnRelease(${r.id})">Release</button>` : (r.status === 'Released' ? '<span class="muted">—</span>' : '<span class="muted" style="font-size:12px">released by admin</span>');
        const rowCls = r.is_current ? ' class="cn-current"' : '';
        return `<tr${rowCls}><td>${esc(r.cycle_key)}${r.is_current ? ' <span class="tag tag-blue" style="font-size:10px">current</span>' : ''}</td><td class="muted">${esc(r.period_start)} → ${esc(r.period_end)}</td>${IS_ADMIN ? `<td>${subj}</td>` : ''}${showManager ? `<td>${esc(r.subject_name || '—')}${r.subject_role === 'manager' ? ' <span class="tag tag-mgr" style="font-size:10px">my note</span>' : ''}${IS_ADMIN && r.manager_name ? ' <span class="muted" style="font-size:11px">mgr: ' + esc(r.manager_name) + '</span>' : ''}</td>` : ''}<td class="cell-money">${esc(r.amount)}</td>${showManager ? `<td class="cell-money">${money(String(out.get(r.subject_role + ':' + r.subject_id) ?? 0))}</td>` : ''}<td>${stat}</td><td>${who}${r.release_note ? '<br><span class="muted" style="font-size:11px">' + esc(r.release_note) + '</span>' : ''}</td><td>${action}</td></tr>`;
      }).join('') || `<tr><td colspan="9" class="muted" style="text-align:center;padding:26px">No credit notes for these filters.</td></tr>`;
      const info = el('cnwInfo');
      if (info) info.textContent = `${pageRows.length} of ${total} note(s) · Pending first, newest week first`;
    }
    async function loadNotes() {
      const body = el('cnwBody');
      body.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:26px">Loading credit notes…</td></tr>';
      el('cnwStatusMsg').textContent = '';
      const q = new URLSearchParams();
      if (IS_ADMIN && el('cnwSubject') && el('cnwSubject').value) q.set('subject_role', el('cnwSubject').value);
      if (IS_ADMIN && el('cnwManager') && el('cnwManager').value) q.set('manager_id', el('cnwManager').value);
      if ((IS_ADMIN || IS_MANAGER) && el('cnwAgent') && el('cnwAgent').value) q.set('agent_id', el('cnwAgent').value);
      if (el('cnwStatus') && el('cnwStatus').value) q.set('status', el('cnwStatus').value);
      q.set('weeks', el('cnwWeeks').value);
      try {
        data = await API.get('/credit-notes?' + q.toString());
        rows = data.rows || [];
        renderCards(); fillSelects(); renderRows();
        el('cnwUpdated').textContent = 'Live · updated ' + String(data.generated_at || '').replace('T', ' ').replace('Z', ' UTC');
        el('cnwStatusMsg').textContent = `Payout week: ${data.week.start} → ${data.week.end} · payable ${data.week.payable_on} · current week keeps updating until released`;
      } catch (e) {
        body.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:26px">${esc(e.message || 'Unable to load credit notes')}</td></tr>`;
        el('cnwInfo').textContent = 'Credit notes unavailable';
        el('cnwStatusMsg').textContent = /PIN|unlock|locked/i.test(e.message || '') ? 'Verify the Security PIN in the Payment section to view credit notes.' : (e.message || '');
      }
    }
    el('cnwFilters').onsubmit = e => { e.preventDefault(); loadNotes(); };
    el('cnwFilters').onreset = () => setTimeout(loadNotes, 0);
    ['cnwSubject', 'cnwManager', 'cnwAgent', 'cnwStatus', 'cnwWeeks'].forEach(id => { const n = el(id); if (n) n.onchange = loadNotes; });
    el('cnwLen').onchange = () => renderRows();
    el('cnwCsv').onclick = () => {
      const cols = ['cycle_key', 'period_start', 'period_end', 'subject_role', 'subject_name', 'manager_name', 'amount', 'status', 'released_at', 'released_by_name', 'released_by_role', 'paid_to', 'release_note'];
      const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const text = [cols.join(','), ...rows.map(r => cols.map(k => cell(r[k])).join(','))].join('\r\n');
      const u = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = u; a.download = 'skyline-credit-notes.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000);
    };
    /* Release modal (record-only; payment happens outside the panel) */
    window.GXCnRelease = function (id) {
      const r = rows.find(x => x.id === id); if (!r) return;
      const ov = document.createElement('div'); ov.className = 'modal-overlay show'; ov.id = 'cnReleaseModal';
      ov.innerHTML = `<div class="modal" style="max-width:520px"><div class="modal-head"><h3>Release credit note</h3><button class="modal-close" onclick="closeModal('cnReleaseModal')">×</button></div>
        <div class="modal-body">
          <p style="margin:0 0 12px;font-size:13.5px">${esc(r.subject_role === 'manager' ? 'Manager' : 'Agent')} <b>${esc(r.subject_name)}</b> · week <b>${esc(r.cycle_key)}</b> (${esc(r.period_start)} → ${esc(r.period_end)})<br>Amount: <b>${esc(r.amount)}</b></p>
          <div class="form-group"><label>Paid to (Binance UID / TXID reference)</label><input id="cnRelPaidTo" placeholder="e.g. Binance UID or transaction ID" value=""></div>
          <div class="form-group"><label>Release note (optional)</label><input id="cnRelNote" placeholder="e.g. paid via Binance on 2026-10-02"></div>
          <div class="hint">Send the payment outside the panel first (Binance etc.). Releasing only records it here and never changes payout calculations. ${r.subject_role === 'manager' ? 'This does NOT release this manager\'s agent notes — release each agent note separately.' : ''}</div>
          <div style="display:flex;gap:10px;margin-top:12px"><button class="btn btn-green" onclick="GXCnConfirmRelease(${r.id})">Confirm Release</button><button class="btn btn-ghost" onclick="closeModal('cnReleaseModal')">Cancel</button></div>
        </div></div>`;
      ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    };
    window.GXCnConfirmRelease = async function (id) {
      const paid_to = (el('cnRelPaidTo') || {}).value || '';
      const release_note = (el('cnRelNote') || {}).value || '';
      try {
        await API.post('/credit-notes/' + id + '/release', { paid_to: paid_to.trim(), release_note: release_note.trim() });
        if (window.closeModal) closeModal('cnReleaseModal'); else { const o = el('cnReleaseModal'); if (o) o.remove(); }
        loadNotes();
      } catch (e) { alert('❌ ' + (e.message || 'Unable to release credit note')); }
    };
    /* ================= SETTLEMENT STATEMENT (unchanged behaviour) ================= */
    let page = 1, totalPages = 1, srows = [], serial = 0;
    async function loadStatement() {
      const own = ++serial; srows = []; el('cnCsv').disabled = true; el('cnPrev').disabled = true; el('cnNext').disabled = true; el('cnBody').innerHTML = ''; el('cnStatus').textContent = 'Loading ledger statement…';
      const q = new URLSearchParams({ page: String(page), limit: el('cnSize').value });
      for (const [k, id] of [['from', 'cnFrom'], ['to', 'cnTo'], ['payment_type', 'cnType'], ['maturity', 'cnMaturity']]) if (el(id).value) q.set(k, el(id).value);
      try {
        const d = await API.get('/payment-v2/credit-notes?' + q); if (own !== serial) return;
        srows = d.rows || []; page = d.page; totalPages = d.totalPages;
        el('cnBody').innerHTML = srows.map(r => `<tr><td>${esc(r.cycle_key || 'Not recorded')}</td><td>${esc(r.agent_name)}</td><td>${esc({ daily: 'Daily', weekly: 'Weekly', monthly_30x45: 'Monthly (30x45)' }[r.payment_type] || r.payment_type)}</td><td>Not recorded</td><td class="amount">${esc(r.total_amount)}</td><td>${r.cdr_count}</td><td>${esc(r.eligible_at || 'Not recorded')}</td><td><span class="tag ${r.maturity === 'matured' ? 'tag-green' : r.maturity === 'upcoming' ? 'tag-amber' : 'tag-gray'}">${esc(r.maturity)}</span></td><td class="amount">${esc(r.open_amount)}</td><td class="amount">${esc(r.requested_amount)}</td><td class="amount">${esc(r.paid_amount)}</td><td class="amount">${esc(r.other_amount)}</td><td>${r.request_ids.map(esc).join(', ') || '—'}</td></tr>`).join('') || '<tr><td colspan="13" style="text-align:center;padding:30px">No ledger settlements match these filters.</td></tr>';
        el('cnStatus').textContent = 'Live ledger data · generated ' + d.generated_at.replace('T', ' ').replace('Z', ' UTC');
        el('cnCount').textContent = `${d.total} settlement group(s) · Page ${page} of ${totalPages}`;
        el('cnPrev').disabled = page <= 1; el('cnNext').disabled = page >= totalPages; el('cnCsv').disabled = !srows.length;
      } catch (e) {
        if (own !== serial) return; el('cnCount').textContent = 'Report unavailable'; el('cnStatus').textContent = e.message || 'Unable to load statement';
        if (/PIN|unlock|locked/i.test(e.message || '')) {
          const a = document.createElement('a'); a.href = '/agent/payment'; a.textContent = ' Open Payment Section to verify your existing Security PIN.'; el('cnStatus').appendChild(a);
        }
      }
    }
    el('cnFilters').onsubmit = e => { e.preventDefault(); page = 1; loadStatement(); };
    el('cnFilters').onreset = () => setTimeout(() => { page = 1; loadStatement(); }, 0);
    el('cnSize').onchange = () => { page = 1; loadStatement(); };
    el('cnPrev').onclick = () => { if (page > 1) { page--; loadStatement(); } };
    el('cnNext').onclick = () => { if (page < totalPages) { page++; loadStatement(); } };
    el('cnCsv').onclick = () => {
      const cells = ['cycle_key', 'agent_name', 'payment_type', 'currency', 'total_amount', 'cdr_count', 'eligible_at', 'maturity', 'open_amount', 'requested_amount', 'paid_amount', 'other_amount', 'request_ids'];
      const cell = v => '"' + String(v ?? 'Not recorded').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
      const text = [cells.map(cell).join(','), ...srows.map(r => cells.map(k => cell(Array.isArray(r[k]) ? r[k].join(';') : r[k])).join(','))].join('\r\n');
      const u = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = u; a.download = 'skyline-live-settlement-page-' + page + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000);
    };
    /* load when the page becomes visible */
    let active = false;
    const changed = () => { const next = root.classList.contains('active'); if (next && !active) { active = true; setTab(tab); } else if (!next) active = false; };
    new MutationObserver(changed).observe(root, { attributes: true, attributeFilter: ['class'] });
    changed();
  }
  function ensureStyle() {
    if (document.getElementById('gx-cn-style')) return;
    const st = document.createElement('style'); st.id = 'gx-cn-style';
    st.textContent = `
      .gx-cn-notice{margin:0 0 14px;padding:11px 14px;border:1px solid rgba(212,175,55,.4);background:rgba(212,175,55,.10);border-radius:10px;font-size:12.5px;line-height:1.55;color:var(--text,#e9eaf6)}
      .gx-cn-tabs{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
      .gx-cn-tab{padding:9px 16px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.18));background:transparent;color:inherit;font-size:13px;font-weight:600;cursor:pointer}
      .gx-cn-tab.active{background:#2563eb;border-color:#2563eb;color:#fff}
      #page-creditNotes .toolbar{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:flex-end}
      #page-creditNotes .toolbar label{display:inline-flex;flex-direction:row;align-items:center;gap:8px;white-space:nowrap}
      #page-creditNotes .toolbar label select,#page-creditNotes .toolbar label input{width:auto;min-width:150px}
      .gx-cn-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:14px}
      .gx-cn-card{padding:14px 16px;border:1px solid var(--border,rgba(255,255,255,.14));border-radius:12px;background:var(--card,rgba(255,255,255,.03))}
      .gx-cn-card .lbl{font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;opacity:.75;margin-bottom:6px}
      .gx-cn-card .val{font-size:19px;font-weight:700}
      .gx-cn-card .sub{font-size:11.5px;opacity:.7;margin-top:5px}
      .gx-cn-updated{font-size:12px;opacity:.7;margin-left:10px}
      tr.cn-current td{background:rgba(37,99,235,.08)}
      .gx-cn-tag2{font-size:10px}`;
    document.head.appendChild(st);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
