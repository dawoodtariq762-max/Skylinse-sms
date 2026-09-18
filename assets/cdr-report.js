/**
 * Skyline SMS — CDR / SMS Detailed Report Rebuild & Multi-Filter Controller
 * Reference: Pixel-perfect match with screenshots (Raw list + Multi-dimension grouping)
 */
(function(window){
  'use strict';

  function pad2(n){ return String(n).padStart(2, '0'); }

  function getUkTodayDateTime(isEnd){
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    const ds = `${y}-${m}-${day}`;
    return isEnd ? `${ds} 23:59:59` : `${ds} 00:00:00`;
  }

  function cleanMoney(v){
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return '$0.00';
    return '$' + n.toFixed(3).replace(/(\.\d{2})0$/, '$1');
  }

  function escapeHtml(s){
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function CdrReport(opts){
    this.role = opts.role || 'admin';
    this.containerId = opts.containerId || 'page-smsDetail';
    this.api = window.API || { get: async (u) => fetch(u).then(r=>r.json()) };
    this.state = {
      page: 1,
      limit: '25',
      sort: '',
      dir: 'desc',
      total: 0,
      totalPages: 1,
      rows: [],
      grouped: false,
      activeDimensions: [],
      totalSms: 0,
      totalPayment: '0.00',
      totalClientPayout: '0.00',
      currency: 'USD',
      hiddenCols: new Set()
    };
    this.init();
  }

  CdrReport.prototype.init = async function(){
    this.renderLayout();
    this.bindEvents();
    await this.populateDropdowns();
    return this.render();
  };

  CdrReport.prototype.renderLayout = function(){
    const el = document.getElementById(this.containerId);
    if(!el) return;

    const isClient = this.role === 'client';
    const isAgent = this.role === 'agent';
    const isManager = this.role === 'manager';
    const isAdmin = this.role === 'admin';

    const fromVal = getUkTodayDateTime(false);
    const toVal = getUkTodayDateTime(true);

    let roleUserFilters = '';
    if (isAdmin) {
      roleUserFilters = `
        <div class="cdr-field">
          <label class="cdr-label">Filter Provider</label>
          <select id="cdrProvider" class="cdr-select"><option value="">All providers</option></select>
        </div>
        <div class="cdr-field">
          <label class="cdr-label">Filter Manager</label>
          <select id="cdrManager" class="cdr-select"><option value="">All managers</option></select>
        </div>
        <div class="cdr-field">
          <label class="cdr-label">Filter Agent</label>
          <select id="cdrAgent" class="cdr-select"><option value="">All agents</option></select>
        </div>
        <div class="cdr-field">
          <label class="cdr-label">Filter Client</label>
          <select id="cdrClient" class="cdr-select"><option value="">All clients</option></select>
        </div>
      `;
    } else if (isManager) {
      roleUserFilters = `
        <div class="cdr-field">
          <label class="cdr-label">Filter Agent</label>
          <select id="cdrAgent" class="cdr-select"><option value="">All agents</option></select>
        </div>
        <div class="cdr-field">
          <label class="cdr-label">Filter Client</label>
          <select id="cdrClient" class="cdr-select"><option value="">All clients</option></select>
        </div>
      `;
    } else if (isAgent) {
      roleUserFilters = `
        <div class="cdr-field">
          <label class="cdr-label">Filter Client</label>
          <select id="cdrClient" class="cdr-select"><option value="">All clients</option></select>
        </div>
      `;
    }

    let roleGbCheckboxes = '';
    if (isAdmin) {
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseUser" value="manager"> Manager</label>`;
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseAgent" value="agent"> Agent</label>`;
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseClient" value="client"> Client</label>`;
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseProvider" value="provider"> Provider</label>`;
    } else if (isManager) {
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseAgent" value="agent"> Agent</label>`;
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseUser" value="client"> Client</label>`;
    } else if (isAgent) {
      roleGbCheckboxes += `<label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseUser" value="client"> Client</label>`;
    }

    el.innerHTML = `
      <div class="cdr-container">
        <div class="cdr-subtitle">Detailed records of every inbound SMS.</div>
        
        <!-- Filter Toolbar -->
        <div class="cdr-toolbar">
          <div class="cdr-filter-row">
            <div class="cdr-field">
              <label class="cdr-label">From</label>
              <div class="cdr-dt-wrap">
                <input type="text" id="cdrFrom" class="cdr-input" value="${fromVal}">
                <button type="button" class="cdr-cal-btn" onclick="document.getElementById('cdrFromNative').showPicker ? document.getElementById('cdrFromNative').showPicker() : document.getElementById('cdrFromNative').focus()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </button>
                <input type="date" id="cdrFromNative" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0" onchange="document.getElementById('cdrFrom').value=this.value+' 00:00:00'">
              </div>
            </div>

            <div class="cdr-field">
              <label class="cdr-label">To</label>
              <div class="cdr-dt-wrap">
                <input type="text" id="cdrTo" class="cdr-input" value="${toVal}">
                <button type="button" class="cdr-cal-btn" onclick="document.getElementById('cdrToNative').showPicker ? document.getElementById('cdrToNative').showPicker() : document.getElementById('cdrToNative').focus()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </button>
                <input type="date" id="cdrToNative" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0" onchange="document.getElementById('cdrTo').value=this.value+' 23:59:59'">
              </div>
            </div>

            <div class="cdr-field">
              <label class="cdr-label">Filter Range</label>
              <select id="cdrRange" class="cdr-select"><option value="">All ranges</option></select>
            </div>

            ${roleUserFilters}
          </div>

          <div class="cdr-filter-row">
            <div class="cdr-field" style="flex: 2 1 220px;">
              <label class="cdr-label">Search Number</label>
              <input type="text" id="cdrNumber" class="cdr-input" placeholder="Search Number">
            </div>

            <div class="cdr-field" style="flex: 2 1 220px;">
              <label class="cdr-label">Search CLI</label>
              <input type="text" id="cdrCli" class="cdr-input" placeholder="Search CLI">
            </div>

            <div class="cdr-field-fixed" style="display:flex;gap:8px;">
              <button type="button" id="cdrExportBtn" class="cdr-btn-export">Export Report</button>
              <button type="button" id="cdrShowBtn" class="cdr-btn-show">Show Report</button>
              <button type="button" id="cdrResetBtn" class="cdr-btn-reset" title="Reset Filters">Reset</button>
            </div>
          </div>

          <div class="cdr-group-row">
            <span class="cdr-group-label">Group by</span>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseHour" value="hour"> Hour</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseDay" value="day"> Day</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseMonth" value="month"> Month</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseRange" value="range"> Range</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseNumber" value="number"> Number</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseCli" value="cli"> CLI</label>
            ${roleGbCheckboxes}
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseCurrency" value="currency"> Currency</label>
            <label class="cdr-gb-item"><input type="checkbox" class="cdr-gb-chk" id="sdUseStatus" value="status"> Status</label>
          </div>
          <div id="sdChips" style="display:flex;flex-wrap:wrap;align-items:center;margin-top:6px;gap:6px;"></div>

          <!-- Compatibility hidden controls for test harness & helpers -->
          <input type="checkbox" id="sdUseDate" checked style="display:none">
          <input type="checkbox" id="sdUseTime" style="display:none">
          <input type="time" id="sdTimeFrom" style="display:none">
          <input type="time" id="sdTimeTo" style="display:none">
          <input type="date" id="sdDateFrom" style="display:none">
          <input type="date" id="sdDateTo" style="display:none">
        </div>

        <!-- Table Card Section -->
        <div class="cdr-card">
          <div class="cdr-card-head">
            <div class="cdr-title">CDR REPORTS &amp; STATS</div>
            <div class="cdr-card-controls">
              <div class="cdr-controls-left">
                <div class="cdr-search-inline">
                  <label>Search:</label>
                  <input type="text" id="cdrSearch" placeholder="by message text or range">
                </div>
                <button type="button" class="cdr-btn-tool" id="cdrBtnCopy">Copy</button>
                <button type="button" class="cdr-btn-tool" id="cdrBtnTxt">TXT</button>
                <button type="button" class="cdr-btn-tool" id="cdrBtnCsv">CSV</button>
                <button type="button" class="cdr-btn-tool" id="cdrBtnExcel">Excel</button>
              </div>

              <div class="cdr-controls-right">
                <label>Show Records:</label>
                <select id="cdrLen">
                  <option value="10">10</option>
                  <option value="25" selected>25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="All">All</option>
                </select>
                <button type="button" class="cdr-btn-tool" id="cdrToggleColsBtn">Show / hide columns</button>
              </div>
            </div>
            <div id="cdrColChooser" style="display:none;padding:10px;background:#1e293b;border-radius:4px;gap:12px;flex-wrap:wrap;border:1px solid #334155;"></div>
          </div>

          <div class="cdr-table-wrap">
            <table class="cdr-table" id="cdrTable">
              <thead id="cdrThead"></thead>
              <tbody id="sdBody"></tbody>
            </table>
          </div>

          <div class="cdr-foot" id="cdrFoot">
            <div id="cdrFootLeft"></div>
            <div class="cdr-pagination" id="cdrPagination"></div>
          </div>
        </div>
      </div>
    `;
  };

  CdrReport.prototype.bindEvents = function(){
    const self = this;
    const showBtn = document.getElementById('cdrShowBtn');
    if (showBtn) showBtn.onclick = () => { self.state.page = 1; self.render(); };

    const resetBtn = document.getElementById('cdrResetBtn');
    if (resetBtn) resetBtn.onclick = () => { self.reset(); };

    const exportBtn = document.getElementById('cdrExportBtn');
    if (exportBtn) exportBtn.onclick = () => { self.exportAllCsv(); };

    const searchInput = document.getElementById('cdrSearch');
    if (searchInput) {
      let st;
      searchInput.oninput = () => {
        clearTimeout(st);
        st = setTimeout(() => { self.state.page = 1; self.render(); }, 350);
      };
    }

    const numInput = document.getElementById('cdrNumber');
    if (numInput) {
      numInput.onkeydown = (e) => { if (e.key === 'Enter') { self.state.page = 1; self.render(); } };
    }

    const cliInput = document.getElementById('cdrCli');
    if (cliInput) {
      cliInput.onkeydown = (e) => { if (e.key === 'Enter') { self.state.page = 1; self.render(); } };
    }

    const lenSel = document.getElementById('cdrLen');
    if (lenSel) {
      lenSel.onchange = () => {
        self.state.limit = lenSel.value;
        self.state.page = 1;
        self.render();
      };
    }

    // Checkboxes change triggers instant re-render of grouped view
    const chks = document.querySelectorAll('.cdr-gb-chk');
    chks.forEach(chk => {
      chk.onchange = () => {
        self.state.page = 1;
        self.render();
      };
    });

    // Quick export buttons
    const btnCopy = document.getElementById('cdrBtnCopy');
    if (btnCopy) btnCopy.onclick = () => self.copyTable();
    const btnTxt = document.getElementById('cdrBtnTxt');
    if (btnTxt) btnTxt.onclick = () => self.downloadTxt();
    const btnCsv = document.getElementById('cdrBtnCsv');
    if (btnCsv) btnCsv.onclick = () => self.downloadCsv();
    const btnExcel = document.getElementById('cdrBtnExcel');
    if (btnExcel) btnExcel.onclick = () => self.downloadExcel();

    const colBtn = document.getElementById('cdrToggleColsBtn');
    if (colBtn) {
      colBtn.onclick = () => {
        const chooser = document.getElementById('cdrColChooser');
        if (chooser) chooser.style.display = chooser.style.display === 'none' ? 'flex' : 'none';
      };
    }
  };

  CdrReport.prototype.populateDropdowns = async function(){
    try {
      // Load ranges
      const rangeSel = document.getElementById('cdrRange');
      if (rangeSel) {
        const ranges = await this.api.get('/ranges');
        if (Array.isArray(ranges)) {
          rangeSel.innerHTML = '<option value="">All ranges</option>' + ranges.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
        }
      }

      // Load providers for Admin
      const provSel = document.getElementById('cdrProvider');
      if (provSel && this.role === 'admin') {
        const provs = await this.api.get('/ranges/providers');
        if (Array.isArray(provs)) {
          provSel.innerHTML = '<option value="">All providers</option>' + provs.map(p => `<option value="${p}">${p}</option>`).join('');
        }
      }

      // Load users
      const mgrSel = document.getElementById('cdrManager');
      if (mgrSel && this.role === 'admin') {
        const mgrs = await this.api.get('/users/manager');
        if (Array.isArray(mgrs)) {
          mgrSel.innerHTML = '<option value="">All managers</option>' + mgrs.map(m => `<option value="${m.username}">${m.username}</option>`).join('');
        }
      }

      const agtSel = document.getElementById('cdrAgent');
      if (agtSel && ['admin', 'manager'].includes(this.role)) {
        const agts = await this.api.get('/users/agent');
        if (Array.isArray(agts)) {
          agtSel.innerHTML = '<option value="">All agents</option>' + agts.map(a => `<option value="${a.username}">${a.username}</option>`).join('');
        }
      }

      const cliSel = document.getElementById('cdrClient');
      if (cliSel && ['admin', 'manager', 'agent'].includes(this.role)) {
        const clis = await this.api.get('/users/client');
        if (Array.isArray(clis)) {
          cliSel.innerHTML = '<option value="">All clients</option>' + clis.map(c => `<option value="${c.username}">${c.username}</option>`).join('');
        }
      }
    } catch(e) {
      console.warn('CDR dropdown population failed:', e);
    }
  };

  CdrReport.prototype.getActiveGroupBy = function(){
    const chks = document.querySelectorAll('.cdr-gb-chk:checked');
    const out = [];
    chks.forEach(c => out.push(c.value));
    return out;
  };

  CdrReport.prototype.buildQueryParams = function(isExport = false){
    const p = new URLSearchParams();
    const g = (id) => (document.getElementById(id)?.value || '').trim();

    const fromVal = g('cdrFrom');
    if (fromVal) p.set('from', fromVal);

    const toVal = g('cdrTo');
    if (toVal) p.set('to', toVal);

    const rangeVal = g('cdrRange');
    if (rangeVal) p.set('range', rangeVal);

    const numVal = g('cdrNumber');
    if (numVal) p.set('number', numVal);

    const cliVal = g('cdrCli');
    if (cliVal) p.set('cli', cliVal);

    const provVal = g('cdrProvider');
    if (provVal && this.role === 'admin') p.set('provider', provVal);

    const mgrVal = g('cdrManager');
    if (mgrVal && this.role === 'admin') p.set('manager', mgrVal);

    const agtVal = g('cdrAgent');
    if (agtVal && ['admin', 'manager'].includes(this.role)) p.set('agent', agtVal);

    const cliUserVal = g('cdrClient');
    if (cliUserVal && ['admin', 'manager', 'agent'].includes(this.role)) p.set('client', cliUserVal);

    const searchVal = g('cdrSearch');
    if (searchVal) p.set('search', searchVal);

    const gb = this.getActiveGroupBy();
    if (gb.length > 0) p.set('group_by', gb.join(','));

    p.set('page', String(this.state.page || 1));
    p.set('limit', isExport ? 'All' : (this.state.limit || '25'));

    if (this.state.sort) {
      p.set('sort', this.state.sort);
      p.set('dir', this.state.dir || 'desc');
    }

    return p;
  };

  CdrReport.prototype.render = async function(){
    const params = this.buildQueryParams();
    let data;
    try {
      data = await this.api.get('/sms/paged?' + params.toString());
    } catch(e) {
      console.error('Failed to load CDR report:', e);
      data = { rows: [], total: 0 };
    }

    this.state.rows = data.rows || [];
    this.state.total = data.total || 0;
    this.state.totalPages = data.totalPages || 1;
    this.state.page = data.page || 1;
    this.state.grouped = !!data.grouped;
    this.state.activeDimensions = data.dimensions || this.getActiveGroupBy();
    this.state.totalSms = data.totalSms != null ? data.totalSms : data.total;
    this.state.totalPayment = data.totalPayment || '0.00';
    this.state.totalClientPayout = data.totalClientPayout || '0.00';
    this.state.currency = data.currency || 'USD';

    this.renderThead();
    this.renderTbody();
    this.renderFoot();
  };

  CdrReport.prototype.renderThead = function(){
    const thead = document.getElementById('cdrThead');
    if (!thead) return;

    const self = this;
    const gb = this.state.activeDimensions;
    let html = '<tr>';

    if (this.state.grouped && gb.length > 0) {
      const dimLabels = {
        hour: 'HOUR',
        day: 'DAY',
        month: 'MONTH',
        range: 'RANGE',
        number: 'NUMBER',
        cli: 'CLI',
        client: 'CLIENT',
        currency: 'CURRENCY',
        status: 'STATUS',
        provider: 'PROVIDER',
        manager: 'MANAGER',
        agent: 'AGENT'
      };

      gb.forEach(d => {
        const lbl = dimLabels[d] || d.toUpperCase();
        const arrow = self.state.sort === d ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
        html += `<th class="sortable" onclick="window.__cdrInstance.setSort('${d}')">${lbl}${arrow}</th>`;
      });

      if (!gb.includes('currency')) {
        const arrow = self.state.sort === 'currency' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
        html += `<th class="sortable" onclick="window.__cdrInstance.setSort('currency')">CURRENCY${arrow}</th>`;
      }

      const smsArrow = self.state.sort === 'sms' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('sms')">SMS${smsArrow}</th>`;

      const payArrow = self.state.sort === 'my_payout' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('my_payout')">MY PAYOUT${payArrow}</th>`;

      if (this.role !== 'client') {
        const cliPayArrow = self.state.sort === 'client_payout' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
        html += `<th class="sortable" onclick="window.__cdrInstance.setSort('client_payout')">CLIENT PAYOUT${cliPayArrow}</th>`;
      }
    } else {
      // Raw detailed CDR report table (Screenshot 1)
      const dateArrow = self.state.sort === 'date' || !self.state.sort ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('date')">DATE${dateArrow}</th>`;

      const rArrow = self.state.sort === 'range' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('range')">RANGE${rArrow}</th>`;

      const nArrow = self.state.sort === 'number' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('number')">NUMBER${nArrow}</th>`;

      const cArrow = self.state.sort === 'cli' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('cli')">CLI${cArrow}</th>`;

      html += `<th>SMS</th>`;

      if (this.role !== 'client') {
        html += `<th>CLIENT</th>`;
      }

      html += `<th>CURRENCY</th>`;

      const pArrow = self.state.sort === 'payout' ? (self.state.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
      html += `<th class="sortable" onclick="window.__cdrInstance.setSort('payout')">MY PAYOUT${pArrow}</th>`;
    }

    html += '</tr>';
    thead.innerHTML = html;
  };

  CdrReport.prototype.renderTbody = function(){
    const tbody = document.getElementById('sdBody') || document.getElementById('cdrTbody');
    if (!tbody) return;

    const rows = this.state.rows || [];
    const gb = this.state.activeDimensions;

    if (!rows.length) {
      const colSpan = this.state.grouped ? gb.length + 4 : 8;
      tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;padding:32px;color:#94a3b8">No records found</td></tr>`;
      return;
    }

    let html = '';
    if (this.state.grouped && gb.length > 0) {
      rows.forEach(r => {
        const primaryDim = gb[0] || 'cli';
        const primaryVal = r[primaryDim] != null ? r[primaryDim] : (r.name || r.cli || r.number || '');
        html += `<tr class="gx-facet-row" onclick="window.sdPick && window.sdPick('${primaryDim}', '${escapeHtml(String(primaryVal))}')">`;
        gb.forEach(d => {
          let val = '—';
          if (d === 'hour') val = r.hour || '—';
          else if (d === 'day') val = r.day || '—';
          else if (d === 'month') val = r.month || '—';
          else if (d === 'range') val = r.range_name || r.name || '—';
          else if (d === 'number') val = r.number || '—';
          else if (d === 'cli') val = r.cli || '—';
          else if (d === 'client') val = r.client_name || '—';
          else if (d === 'currency') val = r.currency || 'USD';
          else if (d === 'status') val = r.status || 'Delivered';
          else if (d === 'provider') val = r.provider || '—';
          else if (d === 'manager') val = r.manager_name || '—';
          else if (d === 'agent') val = r.agent_name || '—';
          const isMono = ['number', 'cli', 'hour', 'day', 'month'].includes(d);
          html += `<td class="${isMono ? 'mono' : ''}">${escapeHtml(String(val))}</td>`;
        });

        if (!gb.includes('currency')) {
          html += `<td>${escapeHtml(String(r.currency || 'USD'))}</td>`;
        }

        html += `<td class="mono">${r.sms != null ? r.sms : (r.sms_count || 0)}</td>`;
        html += `<td class="cell-money">${cleanMoney(r.my_payout || 0)}</td>`;
        if (this.role !== 'client') {
          html += `<td class="cell-money">${cleanMoney(r.client_payout || 0)}</td>`;
        }
        html += '</tr>';
      });
    } else {
      // Raw CDR rows
      rows.forEach(r => {
        const dt = (r.received_at || '').slice(0, 19);
        const rng = r.range_name || '—';
        const num = r.number || '—';
        const cli = r.cli || '—';
        const msg = String(r.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const clientName = r.client_name || '-';
        const cur = r.currency || 'USD';
        const pay = cleanMoney(r.payout_amount || r.payout_rate || 0);

        html += `<tr>
          <td class="mono">${escapeHtml(dt)}</td>
          <td>${escapeHtml(rng)}</td>
          <td class="mono">${escapeHtml(num)}</td>
          <td class="mono">${escapeHtml(cli)}</td>
          <td class="msg-cell">${msg}</td>
          ${this.role !== 'client' ? `<td>${escapeHtml(clientName)}</td>` : ''}
          <td>${escapeHtml(cur)}</td>
          <td class="cell-money">${pay}</td>
        </tr>`;
      });
    }

    tbody.innerHTML = html;
  };

  CdrReport.prototype.renderFoot = function(){
    const footLeft = document.getElementById('cdrFootLeft');
    const pagination = document.getElementById('cdrPagination');
    if (!footLeft || !pagination) return;

    if (this.state.grouped && this.state.activeDimensions.length > 0) {
      // Summary footer row matching Image 2
      let summaryHtml = `
        <div class="cdr-foot-summary">
          <span>Total SMS: <b>${this.state.totalSms.toLocaleString()}</b></span>
          <span>Currency: <b>${this.state.currency}</b></span>
          <span>My Payout: <b>${cleanMoney(this.state.totalPayment)}</b></span>
      `;
      if (this.role !== 'client') {
        summaryHtml += `<span>Client Payout: <b>${cleanMoney(this.state.totalClientPayout)}</b></span>`;
      }
      summaryHtml += `</div>`;
      footLeft.innerHTML = summaryHtml;
    } else {
      const fromCount = this.state.total === 0 ? 0 : (this.state.page - 1) * Number(this.state.limit || 25) + 1;
      const toCount = Math.min(this.state.total, this.state.page * Number(this.state.limit || 25));
      footLeft.innerHTML = `Showing ${fromCount} to ${toCount} of ${this.state.total.toLocaleString()} records`;
    }

    // Pagination buttons
    let pagHtml = '';
    const cur = this.state.page;
    const max = this.state.totalPages;

    pagHtml += `<button type="button" ${cur <= 1 ? 'disabled' : ''} onclick="window.__cdrInstance.setPage(${cur - 1})">‹</button>`;

    const startP = Math.max(1, cur - 2);
    const endP = Math.min(max, cur + 2);
    for (let p = startP; p <= endP; p++) {
      pagHtml += `<button type="button" class="${p === cur ? 'active' : ''}" onclick="window.__cdrInstance.setPage(${p})">${p}</button>`;
    }

    pagHtml += `<button type="button" ${cur >= max ? 'disabled' : ''} onclick="window.__cdrInstance.setPage(${cur + 1})">›</button>`;
    pagination.innerHTML = pagHtml;
  };

  CdrReport.prototype.setPage = function(p){
    if (p < 1 || p > this.state.totalPages) return;
    this.state.page = p;
    this.render();
  };

  CdrReport.prototype.setSort = function(k){
    if (this.state.sort === k) {
      this.state.dir = this.state.dir === 'asc' ? 'desc' : 'asc';
    } else {
      this.state.sort = k;
      this.state.dir = (['sms', 'my_payout', 'client_payout', 'payout'].includes(k)) ? 'desc' : 'asc';
    }
    this.render();
  };

  CdrReport.prototype.reset = function(){
    const cdrFrom = document.getElementById('cdrFrom');
    if (cdrFrom) cdrFrom.value = getUkTodayDateTime(false);
    const cdrTo = document.getElementById('cdrTo');
    if (cdrTo) cdrTo.value = getUkTodayDateTime(true);

    ['cdrRange', 'cdrNumber', 'cdrCli', 'cdrProvider', 'cdrManager', 'cdrAgent', 'cdrClient', 'cdrSearch'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    const chks = document.querySelectorAll('.cdr-gb-chk');
    chks.forEach(c => c.checked = false);

    const chips = document.getElementById('sdChips');
    if (chips) chips.innerHTML = '';
    window.__sdSel = {};

    this.state.page = 1;
    this.state.sort = '';
    this.state.dir = 'desc';
    this.render();
  };

  CdrReport.prototype.exportAllCsv = async function(){
    const params = this.buildQueryParams(true);
    let data;
    try {
      data = await this.api.get('/sms/paged?' + params.toString());
    } catch(e) {
      alert('Export failed: ' + e.message);
      return;
    }

    const rows = data.rows || [];
    if (!rows.length) {
      alert('No records to export');
      return;
    }

    const gb = data.dimensions || this.getActiveGroupBy();
    let csv = '';

    if (data.grouped && gb.length > 0) {
      const headers = [...gb.map(d => d.toUpperCase())];
      if (!gb.includes('currency')) headers.push('CURRENCY');
      headers.push('SMS', 'MY_PAYOUT');
      if (this.role !== 'client') headers.push('CLIENT_PAYOUT');
      csv += headers.join(',') + '\r\n';

      rows.forEach(r => {
        const line = [];
        gb.forEach(d => {
          let val = '';
          if (d === 'range') val = r.range_name || r.name || '';
          else if (d === 'client') val = r.client_name || '';
          else val = r[d] || '';
          line.push(`"${String(val).replace(/"/g, '""')}"`);
        });
        if (!gb.includes('currency')) line.push(`"${r.currency || 'USD'}"`);
        line.push(r.sms != null ? r.sms : (r.sms_count || 0));
        line.push(r.my_payout || 0);
        if (this.role !== 'client') line.push(r.client_payout || 0);
        csv += line.join(',') + '\r\n';
      });
    } else {
      const headers = ['DATE', 'RANGE', 'NUMBER', 'CLI', 'SMS'];
      if (this.role !== 'client') headers.push('CLIENT');
      headers.push('CURRENCY', 'MY_PAYOUT');
      csv += headers.join(',') + '\r\n';

      rows.forEach(r => {
        const line = [
          `"${r.received_at || ''}"`,
          `"${r.range_name || ''}"`,
          `"${r.number || ''}"`,
          `"${r.cli || ''}"`,
          `"${String(r.message || '').replace(/"/g, '""')}"`
        ];
        if (this.role !== 'client') line.push(`"${r.client_name || ''}"`);
        line.push(`"${r.currency || 'USD'}"`);
        line.push(r.payout_amount || r.payout_rate || 0);
        csv += line.join(',') + '\r\n';
      });
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `CDR_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  CdrReport.prototype.copyTable = function(){
    const table = document.getElementById('cdrTable');
    if (!table) return;
    let text = '';
    for (let r of table.rows) {
      const cells = Array.from(r.cells).map(c => c.innerText.trim());
      text += cells.join('\t') + '\n';
    }
    navigator.clipboard.writeText(text).then(() => alert('Table copied to clipboard!'));
  };

  CdrReport.prototype.downloadTxt = function(){
    const table = document.getElementById('cdrTable');
    if (!table) return;
    let text = '';
    for (let r of table.rows) {
      const cells = Array.from(r.cells).map(c => c.innerText.trim());
      text += cells.join('\t') + '\n';
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `CDR_Table_${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
  };

  CdrReport.prototype.downloadCsv = function(){
    const table = document.getElementById('cdrTable');
    if (!table) return;
    let text = '';
    for (let r of table.rows) {
      const cells = Array.from(r.cells).map(c => `"${c.innerText.trim().replace(/"/g, '""')}"`);
      text += cells.join(',') + '\n';
    }
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `CDR_Table_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  CdrReport.prototype.downloadExcel = function(){
    const table = document.getElementById('cdrTable');
    if (!table) return;
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>${table.outerHTML}</body></html>`;
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `CDR_Table_${new Date().toISOString().slice(0, 10)}.xls`;
    link.click();
  };

  window.initCdrReport = function(opts){
    window.__cdrInstance = new CdrReport(opts || {});
    return window.__cdrInstance;
  };

  // Compatibility helpers for test harness and legacy calls
  window.toggleDetailFilters = function(){
    if (window.__cdrInstance) {
      window.__cdrInstance.state.page = 1;
      return window.__cdrInstance.render();
    }
  };

  window.renderSmsDetail = function(){
    if (window.__cdrInstance) {
      return window.__cdrInstance.render();
    }
  };

  window.sdPick = function(dim, val){
    window.__sdSel = window.__sdSel || {};
    window.__sdSel[dim] = val;
    if (dim === 'cli') {
      const el = document.getElementById('cdrCli'); if (el) el.value = val;
    } else if (dim === 'number') {
      const el = document.getElementById('cdrNumber'); if (el) el.value = val;
    } else if (dim === 'range') {
      const el = document.getElementById('cdrRange'); if (el) el.value = val;
    }
    // Uncheck group checkbox so it switches to drill detail rows
    const chk = document.getElementById('sdUse' + dim.charAt(0).toUpperCase() + dim.slice(1));
    if (chk) chk.checked = false;
    const chips = document.getElementById('sdChips');
    if (chips) {
      chips.innerHTML = `<span class="gx-chip">${dim.toUpperCase()}: <b>${escapeHtml(val)}</b> <span class="x" onclick="window.sdUnpick('${dim}')" style="cursor:pointer;margin-left:6px;color:#f87c8a;font-weight:bold;">&#10005;</span></span>`;
    }
    if (window.__cdrInstance) {
      window.__cdrInstance.state.page = 1;
      return window.__cdrInstance.render();
    }
  };

  window.sdUnpick = function(dim){
    window.__sdSel = window.__sdSel || {};
    window.__sdSel[dim] = '';
    if (dim === 'cli') {
      const el = document.getElementById('cdrCli'); if (el) el.value = '';
    } else if (dim === 'number') {
      const el = document.getElementById('cdrNumber'); if (el) el.value = '';
    } else if (dim === 'range') {
      const el = document.getElementById('cdrRange'); if (el) el.value = '';
    }
    const chips = document.getElementById('sdChips');
    if (chips) chips.innerHTML = '';
    const chk = document.getElementById('sdUse' + dim.charAt(0).toUpperCase() + dim.slice(1));
    if (chk) chk.checked = true;
    if (window.__cdrInstance) {
      window.__cdrInstance.state.page = 1;
      return window.__cdrInstance.render();
    }
  };

  window.sdReset = function(){
    if (window.__cdrInstance) window.__cdrInstance.reset();
  };

})(window);
