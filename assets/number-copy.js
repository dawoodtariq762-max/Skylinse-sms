/* Per-number copy control for the existing SMS Numbers tables (Admin, Manager, Agent, Client).
   Frontend presentation only: reads the number already rendered in the row, never changes
   number data, filters, permissions, allocation or any API. No network requests are made. */
(function () {
  'use strict';
  var TABLES = ['numBody', 'numbersBody'];
  var MAX_ROWS = 20000;
  var GLYPH_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var GLYPH_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  var live = null;
  function liveRegion() {
    if (live && live.isConnected) return live;
    live = document.createElement('div');
    live.className = 'gx-copy-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    return live;
  }
  function announce(text) {
    try { liveRegion().textContent = text; } catch (e) {}
    try { clearTimeout(announce._t); announce._t = setTimeout(function () { if (live) live.textContent = ''; }, 1600); } catch (e) {}
  }
  // Only for clipboards that are unavailable (non-secure context / older browser).
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function digitsOf(text) { return (String(text).match(/\d/g) || []).length; }
  // Locates the number cell inside an existing row. Returns {number, host} or null.
  // Reads only what the existing renderer already printed; nothing is recalculated.
  function findNumber(row) {
    var cell = row.querySelector('td.gx-num');
    if (!cell) {
      var cells = row.querySelectorAll('td');
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].querySelector('button,input,a,select')) continue;
        var probe = (cells[i].textContent || '').trim();
        if (/^\+?[0-9][0-9\s()+.-]*$/.test(probe) && digitsOf(probe) >= 7) { cell = cells[i]; break; }
      }
    }
    if (!cell) return null;
    var source = cell.querySelector('b') || cell;
    var raw = String(source.textContent || '').trim();
    if (!/^\+?[0-9][0-9\s()+.-]*$/.test(raw) || digitsOf(raw) < 7) return null;
    return { number: raw, host: cell };
  }
  function makeButton(number) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gx-copy-inline';
    btn.dataset.copy = number;
    btn.title = 'Copy number';
    btn.setAttribute('aria-label', 'Copy number ' + number);
    btn.innerHTML = GLYPH_COPY;
    return btn;
  }
  /* Adds the copy control to ONE row. Same control, same click behaviour, same
     clipboard call as before — only the timing changed: rows get their button when
     they are about to be seen (see start()) instead of all rows at once. */
  function decorateRow(row) {
    if (!row || row.dataset.gxCopyDone === '1') return;
    var found = findNumber(row);
    if (!found) return;
    found.host.appendChild(makeButton(found.number));
    row.dataset.gxCopyDone = '1';
  }
  /* Mark every row of the numbers tables for viewport-scoped decoration. This pass
     inserts NOTHING into the DOM (that is what kept a huge table re-laying out), so it
     is cheap enough to re-run after the list re-renders. */
  function scanRows() {
    for (var t = 0; t < TABLES.length; t++) {
      var body = document.getElementById(TABLES[t]);
      if (!body) continue;
      var rows = body.rows || [];
      var limit = Math.min(rows.length, MAX_ROWS);
      for (var i = 0; i < limit; i++) {
        var row = rows[i];
        if (!row || row.dataset.gxCopyDone === '1' || row.dataset.gxCopyObs === '1') continue;
        row.dataset.gxCopyObs = '1';
        if (io) { try { io.observe(row); } catch (e) { decorateRow(row); } }
        else decorateRow(row);
      }
    }
  }
  var io = null;
  function onClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('.gx-copy-inline') : null;
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    var number = btn.dataset.copy || '';
    if (!number) return;
    writeClipboard(number).then(function (ok) {
      if (!ok) { announce('Copy failed. Select the number and copy manually.'); return; }
      btn.classList.add('is-copied');
      btn.innerHTML = GLYPH_DONE;
      btn.title = 'Copied';
      btn.setAttribute('aria-label', 'Copied number ' + number);
      announce('Number copied: ' + number);
      clearTimeout(btn._gxCopyTimer);
      btn._gxCopyTimer = setTimeout(function () {
        btn.classList.remove('is-copied');
        btn.innerHTML = GLYPH_COPY;
        btn.title = 'Copy number';
        btn.setAttribute('aria-label', 'Copy number ' + number);
      }, 1300);
    });
  }
  function start() {
    document.addEventListener('click', onClick, true);
    /* Viewport-scoped decoration (performance): the previous version gave every row of
       the list its own copy button up front — up to MAX_ROWS inserts plus a full-table
       re-scan on every DOM change. On a large "Show Records = All" page that was the
       main reason the tab froze. Now a row gets its button when it comes near the
       viewport, so a 50k-row page costs the same as a 25-row page. */
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (!e.isIntersecting) continue;
          try { io.unobserve(e.target); } catch (err) { }
          decorateRow(e.target);
        }
      }, { rootMargin: '400px 0px' });
    }
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () { scheduled = false; if (window.__gxPainting) return; /* big paint in progress — the paint-done event will re-scan */ try { scanRows(); } catch (e) { } }, 150);
    }
    if (window.MutationObserver) {
      /* Only marks rows for observation — never inserts anything, so it cannot feed
         itself the way the old decorate() did. */
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('gx-paint-done', function () { try { scanRows(); } catch (e) { } });
    scanRows();
    liveRegion();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
