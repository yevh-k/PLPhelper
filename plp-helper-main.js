/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 1 — TRSL BRIDGE                                     ║
   ║  Слухає повідомлення від PLP (BroadcastChannel/LS).           ║
   ║  Додатково: після Overall Report парсить #ppr_detailed        ║
   ║  і відправляє unpr:map {LOGIN→lastDirectTs} на PLP.           ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  const CH = 'TRSL_UPH_BRIDGE_V1';
  const chan = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(CH) : null;
  const useLS = !chan;
  const LS_REQ = 'TRSL_UPH_BRIDGE_REQ', LS_RES = 'TRSL_UPH_BRIDGE_RES', LS_EVT = 'TRSL_UPH_BRIDGE_EVT';
  const send = (obj) => {
    if (chan) { chan.postMessage(obj); }
    else {
      const key = (/:(result|ready|map)$/.test(obj.type)) ? LS_RES : LS_EVT;
      localStorage.setItem(key, JSON.stringify({ ...obj, _rnd: Math.random() }));
    }
  };

  const waitFor = (cond, { interval = 150, timeout = 26000 } = {}) => new Promise(res => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (cond()) { clearInterval(id); res(true); }
      else if (Date.now() - t0 > timeout) { clearInterval(id); res(false); }
    }, interval);
  });

  const waitForSummary = async (timeout = 26000) => {
    const deadline = Date.now() + timeout;
    const check = () => { try { return parseSummaryUPH() != null; } catch (_) { return false; } };
    if (check()) return true;
    const docs = roots();
    return await new Promise(res => {
      let done = false;
      const observers = [];
      const finish = (ok) => {
        if (done) return; done = true;
        try { observers.forEach(o => o.disconnect()); } catch (_) { }
        res(ok);
      };
      const tick = () => { if (check()) return finish(true); if (Date.now() > deadline) return finish(false); };
      for (const d of docs) {
        try {
          const MO = (d.defaultView && d.defaultView.MutationObserver) ? d.defaultView.MutationObserver : MutationObserver;
          const mo = new MO(() => { tick(); });
          mo.observe(d.documentElement || d.body, { childList: true, subtree: true, characterData: true });
          observers.push(mo);
        } catch (_) { }
      }
      const id = setInterval(() => { if (done) { clearInterval(id); return; } tick(); }, 800);
      tick();
    });
  };

  function parseWindowToMinutes(win) {
    const s = String(win || '').trim().toLowerCase();
    const m = s.match(/^(\d+)(m|h)$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!(n > 0)) return null;
    return m[2] === 'h' ? n * 60 : n;
  }
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtTime = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const T = (el) => (el && (el.textContent || '').trim()) || '';
  const up = (s) => (s || '').trim().toUpperCase();
  const num = (s) => {
    if (!s) return NaN;
    const c = (s + '').replace(/[^0-9,.\-]/g, '');
    const n = c.replace(/\s+/g, '').replace(/(\d)[,](\d{3})(\D|$)/g, '$1$2$3').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
    return parseFloat(n);
  };

  function roots() {
    const list = [document];
    const ifr = Array.from(document.querySelectorAll('iframe'));
    for (const f of ifr) { try { const d = f.contentDocument; if (d && d.body) list.push(d); } catch (_) { } }
    return list;
  }
  function nextTable(node) {
    let n = node;
    for (let i = 0; i < 12 && n; i++) { n = n.nextElementSibling; if (n && n.tagName === 'TABLE') return n; }
    return null;
  }
  function findHeadingTable(regex) {
    for (const r of roots()) {
      const hs = [...r.querySelectorAll('h1,h2,h3,h4,h5')].filter(h => regex.test((h.textContent || '')));
      for (const h of hs) { const tbl = nextTable(h); if (tbl) return tbl; }
    }
    return null;
  }
  function keysOf(tbl) {
    const thead = tbl.querySelector('thead');
    let ths = thead ? [...thead.querySelectorAll('th')] : [];
    if (!ths.length) { const tr = tbl.querySelector('tr'); if (tr) { const th2 = [...tr.querySelectorAll('th')]; if (th2.length) ths = th2; } }
    return ths.map(th => T(th).toLowerCase());
  }

  function parseSummaryUPH() {
    let tbl = findHeadingTable(/trs\s*summary/i);
    if (!tbl) {
      outer: for (const r of roots()) {
        for (const t of r.querySelectorAll('table')) {
          const ks = keysOf(t);
          const hasProc = ks.some(k => k.startsWith('code') || k.startsWith('process') || k.startsWith('activity'));
          const hasOps = ks.some(k => k.startsWith('operations') || k === 'ops');
          const hasUPH = ks.includes('uph');
          if (hasProc && (hasOps || hasUPH)) { tbl = t; break outer; }
        }
      }
    }
    if (!tbl) return null;
    const ks = keysOf(tbl);
    let iProc = ks.findIndex(k => k.startsWith('code') || k.startsWith('process') || k.startsWith('activity'));
    let iOps = ks.findIndex(k => k.startsWith('operations') || k === 'ops');
    let iUPH = ks.indexOf('uph');
    let iTimeH = ks.findIndex(k => k.startsWith('total time'));
    if (iProc < 0) iProc = 0;
    const rows = [...(tbl.querySelector('tbody')?.querySelectorAll('tr') || tbl.querySelectorAll('tr'))];
    if (rows.length && rows[0].querySelectorAll('th').length) rows.shift();
    const pickRe = /(^\s*pick\b)|item\s*x-?dock|pre\s*relo/i;
    let resultUPH = null; let totalOps = 0, totalH = null;
    rows.forEach(tr => {
      const tds = tr.querySelectorAll('td'); if (!tds.length) return;
      const proc = T(tds[Math.min(iProc, tds.length - 1)]);
      if (/^\s*result\s*$/i.test(proc) && iUPH >= 0 && iUPH < tds.length) { const u = num(T(tds[iUPH])); if (!isNaN(u)) resultUPH = u; }
      if (pickRe.test(proc)) { if (iOps >= 0 && iOps < tds.length) { const o = num(T(tds[iOps])); if (!isNaN(o)) totalOps += o; } }
    });
    if (resultUPH != null && !isNaN(resultUPH)) return { uph: resultUPH };
    if (iTimeH >= 0) {
      for (const tr of rows) { const tds = tr.querySelectorAll('td'); if (!tds.length) continue; const proc = T(tds[Math.min(iProc, tds.length - 1)]); if (/^\s*result\s*$/i.test(proc) && iTimeH < tds.length) { const h = num(T(tds[iTimeH])); if (!isNaN(h)) { totalH = h; break; } } }
      if (totalH == null) { let sumH = 0; for (const tr of rows) { const tds = tr.querySelectorAll('td'); if (!tds.length) continue; const proc = T(tds[Math.min(iProc, tds.length - 1)]); if (/(^\s*pick\b)/i.test(proc) && iTimeH < tds.length) { const h = num(T(tds[iTimeH])); if (!isNaN(h)) sumH += h; } } if (sumH > 0) totalH = sumH; }
    }
    if (totalH && totalH > 0 && totalOps > 0) { return { uph: totalOps / totalH }; }
    return null;
  }

  function parseOverallPickMap() {
    let table = null; let meta = null;
    outer: for (const r of roots()) {
      const all = [...r.querySelectorAll('table')];
      for (const t of all) {
        const ks = keysOf(t);
        const iUser = ks.findIndex(k => k.startsWith('user') || k.startsWith('login'));
        const iProc = ks.findIndex(k => k.startsWith('code') || k.startsWith('process') || k.startsWith('activity'));
        const iUPH  = ks.indexOf('uph');
        const iOps  = ks.findIndex(k => k.startsWith('operations') || k === 'ops');
        // "Total [h]" (new) or "Total time [h]" (old) — match both
        const iTime = ks.findIndex(k => k.startsWith('total time') || k === 'total [h]' || k === 'total' || (k.startsWith('total') && k.includes('[h]')));
        if (iUser >= 0 && iProc >= 0 && (iUPH >= 0 || (iOps >= 0 && iTime >= 0))) { table = t; meta = { iUser, iProc, iUPH, iOps, iTime }; break outer; }
      }
    }
    if (!table) return null;
    const rows = [...(table.querySelector('tbody')?.querySelectorAll('tr') || table.querySelectorAll('tr'))];
    if (rows.length && rows[0].querySelectorAll('th').length) rows.shift();
    const pickRe = /(^\s*pick\b)|item\s*x-?dock|pre\s*relo/i;
    const agg = {};
    rows.forEach(tr => {
      const tds = tr.querySelectorAll('td'); if (!tds.length) return;
      const login = up(T(tds[Math.min(meta.iUser, tds.length - 1)]).split(';')[0]); if (!login) return;
      const proc = T(tds[Math.min(meta.iProc, tds.length - 1)]);
      if (!pickRe.test(proc)) return;
      if (!agg[login]) agg[login] = { ops: 0, time: 0, uphSum: 0, cnt: 0 };
      if (meta.iOps >= 0 && meta.iOps < tds.length) { const o = num(T(tds[meta.iOps])); if (!isNaN(o) && o > 0) agg[login].ops += o; }
      if (meta.iTime >= 0 && meta.iTime < tds.length) { const h = num(T(tds[meta.iTime])); if (!isNaN(h) && h > 0) agg[login].time += h; }
      if (meta.iUPH >= 0 && meta.iUPH < tds.length) { const u = num(T(tds[meta.iUPH])); if (!isNaN(u) && u > 0) { agg[login].uphSum += u; agg[login].cnt += 1; } }
    });
    const map = {};
    Object.keys(agg).forEach(login => {
      const a = agg[login]; let uph = null;
      // Prefer ops/time calculation (most accurate), fall back to UPH column average
      if (a.ops > 0 && a.time > 0) uph = a.ops / a.time;
      else if (a.cnt > 0) uph = a.uphSum / a.cnt;
      if (uph != null && !isNaN(uph) && uph > 0) map[login] = Math.round(uph);
    });
    return Object.keys(map).length ? map : null;
  }

  // === Parse Activities Details table for last direct (Pick*) operation time per login ===
  // Returns { tsMap: {login→ms}, nonActive: Set<login> }
  // nonActive = workers whose CURRENT last operation is NOT a pick (STOP, Replen, etc.)
  // Operations considered "pick" — PICKING, Pick Multi, Pick Single, Item X-Dock, Pre-Relo
  const _pickOpRe = /^\s*pick/i;            // matches PICKING, Pick Multi, Pick Single, etc.
  const _procRe   = /^\s*pick\b|item\s*x-?dock|pre\s*relo/i; // process column filter (stricter)

  function findActivitiesTable(r) {
    // 1) Try known IDs first
    for (const id of ['ppr_detailed', 'activity_table', 'activities_table', 'trsl_table', 'report_table', 'details_table']) {
      const t = r.querySelector('#' + id); if (t) return t;
    }
    // 2) Fallback: find by column signatures
    //    New TRSL 3.x: "Direct transaction time" + "User"
    //    Old TRSL 2.x: "Last saw" + "User"/"Login"
    return [...r.querySelectorAll('table')].find(t => {
      const allHdrs = [...t.querySelectorAll('th')].map(h => (h.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());
      const hdrs = allHdrs.length ? allHdrs : [...(t.querySelector('tr')?.querySelectorAll('td') || [])].map(h => (h.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());
      const hasUser = hdrs.some(h => h.startsWith('user') || h.startsWith('login'));
      const hasTs   = hdrs.some(h => h.includes('direct transaction') || h.includes('transaction time') || h.includes('last saw'));
      return hasUser && hasTs;
    }) || null;
  }

  function parseLastSawMap() {
    const tsMap = {};      // login → last DIRECT pick timestamp ms
    const nonActive = new Map(); // login → last non-pick task name

    for (const r of roots()) {
      const tbl = findActivitiesTable(r);
      if (!tbl) continue;

      const headerRow = tbl.querySelector('thead tr') || tbl.querySelector('tr');
      if (!headerRow) continue;
      const ths = [...headerRow.querySelectorAll('th,td')].map(h => (h.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());

      const iProc    = ths.findIndex(h => h === 'process' || h.startsWith('process'));
      const iUser    = ths.findIndex(h => h.startsWith('user') || h.startsWith('login'));

      // New TRSL column names (TRSL 3.x):
      //   col 10: "Last operation"         — current task name (STOP, Pick Item X-Dock, etc.)
      //   col 11: "Transaction time"       — last operation timestamp
      //   col 12: "Last direct operation"  — last pick task name
      //   col 13: "Direct transaction time"— last pick timestamp  ← use this for UNPR
      const iDirectTs  = ths.findIndex(h => h.includes('direct transaction'));
      const iLastOp    = ths.findIndex(h => h === 'last operation' || (h.includes('last op') && !h.includes('direct')));
      // Fallback: old "last saw" format (TRSL 2.x)
      const iLastSaw   = ths.findIndex(h => h.includes('last saw'));

      // Need at least user + some timestamp column
      if (iUser < 0 || (iDirectTs < 0 && iLastSaw < 0)) continue;

      const rows = [...(tbl.querySelector('tbody')?.querySelectorAll('tr') || tbl.querySelectorAll('tr'))]
        .filter(tr => tr.querySelectorAll('td').length > 0);

      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (!tds.length) return;

        // Filter by process column: only Pick* / x-dock / pre-relo rows
        if (iProc >= 0) {
          const proc = (tds[Math.min(iProc, tds.length - 1)]?.textContent || '').trim();
          if (!_procRe.test(proc)) return;
        }

        const login = (tds[Math.min(iUser, tds.length - 1)]?.textContent || '')
          .replace(/\s+/g, '').split(';')[0].replace(/[^A-Z0-9]/gi, '').toUpperCase().trim();
        if (!login || login === '-') return;

        // --- Timestamp: prefer "Direct transaction time", fall back to "last saw" format ---
        let ts = 0;
        if (iDirectTs >= 0 && iDirectTs < tds.length) {
          // New format: "DD.MM.YYYY HH:MM" in a single cell
          const cell = (tds[iDirectTs]?.textContent || '').replace(/\s+/g, ' ').trim();
          const m = cell.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
          if (m) ts = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
        } else if (iLastSaw >= 0 && iLastSaw < tds.length) {
          // Old format: "DD.MM.YYYY HH:MM / DD.MM.YYYY HH:MM" — prefer second (direct)
          const cell = (tds[iLastSaw]?.textContent || '').replace(/\s+/g, ' ').trim();
          const matches = [...cell.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/g)];
          if (matches.length) {
            const m = matches.length > 1 ? matches[1] : matches[0];
            ts = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
          }
        }
        if (!ts || isNaN(ts)) return;
        if (!tsMap[login] || ts > tsMap[login]) tsMap[login] = ts;

        // --- Non-pick task detection: read "Last operation" column ---
        if (iLastOp >= 0 && iLastOp < tds.length) {
          const opName = (tds[iLastOp]?.textContent || '').replace(/\s+/g, ' ').trim();
          // Non-pick = operation is NOT a pick/x-dock process
          if (opName && !_pickOpRe.test(opName)) {
            nonActive.set(login, opName);
          }
        }
      });
    }
    return { tsMap, nonActive };
  }

  function clickOverallButton() {
    for (const r of roots()) {
      let btn = r.querySelector('#overall_report');
      if (btn && !btn.disabled) { btn.click(); return true; }
      const candidates = [...r.querySelectorAll('button,input[type="button"],input[type="submit"]')];
      btn = candidates.find(b => /overall/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || ''))
        && !/personal/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || ''))
        && !b.disabled);
      if (btn) { btn.click(); return true; }
    }
    return false;
  }

  async function overallRefresh60m(win) {
    const end = new Date();
    const mins = parseWindowToMinutes(win) || 60;
    const start = new Date(end.getTime() - mins * 60 * 1000);
    const winNorm = (parseWindowToMinutes(win) ? String(win).trim().toLowerCase() : '60m');
    const setRow = (id, d) => { for (const r of roots()) { const row = r.querySelector('#' + id); const dI = row?.querySelector('.input_date'); const tI = row?.querySelector('.input_time'); if (dI) { dI.value = fmtDate(d); dI.dispatchEvent(new Event('input', { bubbles: true })); dI.dispatchEvent(new Event('change', { bubbles: true })); } if (tI) { tI.value = fmtTime(d); tI.dispatchEvent(new Event('input', { bubbles: true })); tI.dispatchEvent(new Event('change', { bubbles: true })); } } };
    setRow('to_dstamp', end);
    setRow('from_dstamp', start);
    for (const r of roots()) { const loginInp = r.querySelector('#login'); if (loginInp) { loginInp.value = ''; loginInp.dispatchEvent(new Event('input', { bubbles: true })); loginInp.dispatchEvent(new Event('change', { bubbles: true })); } }
    clickOverallButton();
    await waitForSummary(22000);
    send({ type: 'overall:ready', ts: Date.now(), window: winNorm });
  }

  async function overallGet() {
    const map = parseOverallPickMap();
    send({ type: 'overall:map', data: map || {}, ts: Date.now() });
    // v2.1.28: UNPR map reporting removed.
  }

  // ─── Personal report queue — prevents concurrent run() race conditions ───
  let _runQueue = Promise.resolve();
  let _runQueued = new Set();   // logins already queued — drop duplicates
  let _overallActive = false;   // true while overall:refresh is in progress

  async function run(login, win, srcTag) {
    const L = (login || '').toUpperCase();
    const mins = parseWindowToMinutes(win) || 60;
    const winNorm = (parseWindowToMinutes(win) ? String(win).trim().toLowerCase() : '60m');
    const ready = await waitFor(() => roots().some(r => r.querySelector('#plp_wrapper') || r.querySelector('#data_content')), { timeout: 8000 });
    if (!ready) { send({ type: 'calcUPH:result', login: L, uph: 0, window: winNorm, src: (srcTag || 'PLP') }); return; }
    // If overall report is running, skip — overall:map will provide data
    if (_overallActive) { send({ type: 'calcUPH:result', login: L, uph: 0, window: winNorm, src: (srcTag || 'PLP') }); return; }
    const end = new Date();
    const start = new Date(end.getTime() - mins * 60 * 1000);
    const setRow = (id, d) => { for (const r of roots()) { const row = r.querySelector('#' + id); const dI = row?.querySelector('.input_date'); const tI = row?.querySelector('.input_time'); if (dI) { dI.value = fmtDate(d); dI.dispatchEvent(new Event('input', { bubbles: true })); dI.dispatchEvent(new Event('change', { bubbles: true })); } if (tI) { tI.value = fmtTime(d); tI.dispatchEvent(new Event('input', { bubbles: true })); tI.dispatchEvent(new Event('change', { bubbles: true })); } } };
    setRow('to_dstamp', end);
    setRow('from_dstamp', start);
    for (const r of roots()) { const loginInp = r.querySelector('#login'); if (loginInp) { loginInp.value = L; loginInp.dispatchEvent(new Event('input', { bubbles: true })); loginInp.dispatchEvent(new Event('change', { bubbles: true })); break; } }
    for (const r of roots()) {
      const btn = [...r.querySelectorAll('button,input[type="button"],input[type="submit"]')]
        .find(b => /personal/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || '')) && !b.disabled);
      if (btn) { btn.click(); break; }
    }
    await waitForSummary(24000);
    const s = parseSummaryUPH();
    _runQueued.delete(L);
    if (s && (s.uph || 0) > 0) { send({ type: 'calcUPH:result', login: L, uph: Math.round(s.uph), window: winNorm, src: (srcTag || 'PLP') }); return; }
    send({ type: 'calcUPH:result', login: L, uph: 0, window: winNorm, src: (srcTag || 'PLP') });
  }

  function enqueueRun(login, win, srcTag) {
    const L = (login || '').toUpperCase();
    if (_runQueued.has(L)) return;   // already waiting — skip duplicate
    if (_overallActive) return;      // overall refresh running — skip
    _runQueued.add(L);
    _runQueue = _runQueue.then(() => run(L, win, srcTag)).catch(() => { _runQueued.delete(L); });
  }

  async function overallRefresh60m(win) {
    _overallActive = true;
    _runQueued.clear(); // cancel pending personal checks — overall will cover them
    const end = new Date();
    const mins = parseWindowToMinutes(win) || 60;
    const start = new Date(end.getTime() - mins * 60 * 1000);
    const winNorm = (parseWindowToMinutes(win) ? String(win).trim().toLowerCase() : '60m');
    const setRow = (id, d) => { for (const r of roots()) { const row = r.querySelector('#' + id); const dI = row?.querySelector('.input_date'); const tI = row?.querySelector('.input_time'); if (dI) { dI.value = fmtDate(d); dI.dispatchEvent(new Event('input', { bubbles: true })); dI.dispatchEvent(new Event('change', { bubbles: true })); } if (tI) { tI.value = fmtTime(d); tI.dispatchEvent(new Event('input', { bubbles: true })); tI.dispatchEvent(new Event('change', { bubbles: true })); } } };
    setRow('to_dstamp', end);
    setRow('from_dstamp', start);
    for (const r of roots()) { const loginInp = r.querySelector('#login'); if (loginInp) { loginInp.value = ''; loginInp.dispatchEvent(new Event('input', { bubbles: true })); loginInp.dispatchEvent(new Event('change', { bubbles: true })); } }
    clickOverallButton();
    await waitForSummary(22000);
    _overallActive = false;
    send({ type: 'overall:ready', ts: Date.now(), window: winNorm });
  }

  function onMessage(msg) {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'calcUPH' && msg.login) { enqueueRun(msg.login, msg.window, msg.src); }
      if (msg.type === 'overall:refresh') { overallRefresh60m(msg.window || '60m'); }
      if (msg.type === 'overall:get') { overallGet(); }
    } catch (_) { }
  }
  if (chan) { chan.onmessage = (ev) => onMessage(ev.data); }
  window.addEventListener('storage', (e) => { if (useLS && (e.key === LS_REQ || e.key === LS_EVT) && e.newValue) { try { onMessage(JSON.parse(e.newValue)); } catch (_) { } } });

})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 2 – INLINE DS/NS BUTTONS (Overall + Personal)       ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function roots() { const list = [document]; const ifr = Array.from(document.querySelectorAll('iframe')); for (const f of ifr) { try { const d = f.contentDocument; if (d && d.body) list.push(d); } catch (_) { } } return list; }
  function getCorrectedBaseDate() { const now = new Date(); const h = now.getHours(); const m = now.getMinutes(); if (h < 5 || (h === 0 && m >= 1)) now.setDate(now.getDate() - 1); return now; }
  function setRow(root, id, d) { const row = root.querySelector('#' + id); if (!row) return false; const dI = row.querySelector('.input_date'); const tI = row.querySelector('.input_time'); if (dI) dI.value = fmtDate(d); if (tI) tI.value = fmtTime(d); if (dI) { dI.dispatchEvent(new Event('input', { bubbles: true })); dI.dispatchEvent(new Event('change', { bubbles: true })); } if (tI) { tI.dispatchEvent(new Event('input', { bubbles: true })); tI.dispatchEvent(new Event('change', { bubbles: true })); } return true; }
  function setRangeAll(type) { const base = getCorrectedBaseDate(); const from = new Date(base), to = new Date(base); if (type === 'DS') { from.setHours(6, 0, 0, 0); to.setHours(16, 30, 0, 0); } else { from.setHours(16, 30, 0, 0); to.setDate(to.getDate() + 1); to.setHours(3, 0, 0, 0); } for (const r of roots()) { setRow(r, 'from_dstamp', from); setRow(r, 'to_dstamp', to); } }
  function clickOverall(root) { let btn = root.querySelector('#overall_report'); if (btn && !btn.disabled) { btn.click(); return true; } const cand = [...root.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"],div[role="button"]')]; const pick = cand.find(b => { const t = (b.value || b.textContent || b.getAttribute('aria-label') || b.title || '').toLowerCase(); return t.includes('overall') && !t.includes('personal') && !b.disabled; }); if (pick) { pick.click(); return true; } return false; }
  function clickPersonal(root) { let btn = root.querySelector('#run_trsl'); if (btn && !btn.disabled) { btn.click(); return true; } const candidates = [...root.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"],div[role="button"]')]; btn = candidates.find(b => /personal/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || '')) && !b.disabled); if (btn) { btn.click(); return true; } return false; }
  function findOverall() { for (const r of roots()) { let btn = r.querySelector('#overall_report'); if (btn) return { root: r, btn }; const cand = [...r.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"],div[role="button"]')].find(b => /overall/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || '')) && !/personal/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || ''))); if (cand) return { root: r, btn: cand }; } return null; }
  function findPersonal() { for (const r of roots()) { let btn = r.querySelector('#run_trsl'); if (btn) return { root: r, btn }; const cand = [...r.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"],div[role="button"]')].find(b => /personal/i.test((b.value || b.textContent || b.getAttribute('aria-label') || b.title || ''))); if (cand) return { root: r, btn: cand }; } return null; }
  function copyButtonStyle(fromBtn, toBtn) { if (fromBtn.className) toBtn.className = fromBtn.className + ' trsl-dsns-btn'; toBtn.style.marginLeft = '6px'; }
  function isVisible(root, el) { if (!el) return false; const s = root.defaultView.getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; if (!root.body.contains(el)) return false; return true; }

  function ensureOverallDSNS() {
    const found = findOverall(); if (!found) return false;
    const { root, btn: overallBtn } = found;
    if (root.getElementById('trsl-inline-dsns-wrap')) return true;
    const wrap = root.createElement('span'); wrap.id = 'trsl-inline-dsns-wrap'; wrap.style.display = 'inline-flex'; wrap.style.alignItems = 'center';
    const ds = root.createElement('button'); ds.textContent = 'DS';
    const ns = root.createElement('button'); ns.textContent = 'NS';
    copyButtonStyle(overallBtn, ds); copyButtonStyle(overallBtn, ns);
    ds.addEventListener('click', () => { setRangeAll('DS'); setTimeout(() => clickOverall(root), 120); });
    ns.addEventListener('click', () => { setRangeAll('NS'); setTimeout(() => clickOverall(root), 120); });
    wrap.appendChild(ds); wrap.appendChild(ns);
    overallBtn.insertAdjacentElement('afterend', wrap);
    function sync() { wrap.style.display = isVisible(root, overallBtn) ? 'inline-flex' : 'none'; }
    const mo = new root.defaultView.MutationObserver(sync);
    mo.observe(root.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'class', 'hidden'] });
    setInterval(sync, 1000); sync(); return true;
  }

  function ensurePersonalDSNS() {
    const found = findPersonal(); if (!found) return false;
    const { root, btn: personalBtn } = found;
    if (root.getElementById('trsl-inline-dsns-personal')) return true;
    const wrap = root.createElement('span'); wrap.id = 'trsl-inline-dsns-personal'; wrap.style.display = 'inline-flex'; wrap.style.alignItems = 'center';
    const ds = root.createElement('button'); ds.textContent = 'DS';
    const ns = root.createElement('button'); ns.textContent = 'NS';
    copyButtonStyle(personalBtn, ds); copyButtonStyle(personalBtn, ns);
    ds.addEventListener('click', () => { setRangeAll('DS'); setTimeout(() => clickPersonal(root), 120); });
    ns.addEventListener('click', () => { setRangeAll('NS'); setTimeout(() => clickPersonal(root), 120); });
    wrap.appendChild(ds); wrap.appendChild(ns);
    personalBtn.insertAdjacentElement('afterend', wrap);
    function sync() { wrap.style.display = isVisible(root, personalBtn) ? 'inline-flex' : 'none'; }
    const mo = new root.defaultView.MutationObserver(sync);
    mo.observe(root.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'class', 'hidden'] });
    setInterval(sync, 1000); sync(); return true;
  }

  let a1 = 0, a2 = 0;
  const id1 = setInterval(() => { if (ensureOverallDSNS() || ++a1 > 240) clearInterval(id1); }, 250);
  const id2 = setInterval(() => { if (ensurePersonalDSNS()) { clearInterval(id2); } else if (++a2 > 240) clearInterval(id2); }, 250);
})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 3 – PLP HELPER                                      ║
   ║  UPH badges, ETA per picker, UNPR alert, settings, filter    ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  // ─── CSS ──────────────────────────────────────────────────────
  const css = `
  /* UPH badge */
  .uph-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;background:#eef6ff;color:#1a73e8;font-size:11px;border:1px solid #bcd5ff;vertical-align:baseline;cursor:help}
  .uph-badge.unpr{background:#fff1f0!important;color:#a8071a!important;border-color:#ffccc7!important}
  .uph-unit{margin-left:3px;font-weight:700;opacity:.96}
  .uph-arrow{display:inline-block;margin-left:2px;font-size:10px;font-weight:900;line-height:1;transform:translateY(-1px)}
  .uph-arrow.up{color:#1fa971;text-shadow:0 0 4px rgba(31,169,113,.14)}
  .uph-arrow.down{color:#d93f5f;text-shadow:0 0 4px rgba(217,63,95,.14)}
  .uph-arrow.flat{color:#8c8c8c}

  /* UPH tooltip */
  .uph-tip{position:fixed;z-index:100000;background:#111;color:#fff;font-size:12px;padding:6px 8px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:360px}

  /* ETA per picker in picklist units cell */
  .eta-picker{display:inline-block;margin-left:5px;padding:0 5px;border-radius:8px;background:#f1fff1;color:#0b7a0b;border:1px solid #bfe5bf;font-size:10px;vertical-align:baseline}
  .eta-picker.warn{background:#fff7e6;color:#ad6800;border-color:#f5d7a6}
  .eta-picker.err{background:#fff1f0;color:#a8071a;border-color:#ffccc7}

  /* IDLE badge (probe-based) */
  .plp-idle-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;background:#fff7e6;color:#ad6800;font-size:11px;border:1px solid #f5d7a6}
  .plp-idle-cell{background:#fff7e6!important}

  /* UNPR badge (TRSL lastSaw-based) */
  .plp-unpr-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;background:#fff1f0;color:#a8071a;font-size:11px;border:1px solid #ffccc7;font-weight:700}
  .plp-unpr-cell{background:#fff1f0!important;outline:2px solid #ffccc7}
  /* Task badge — worker is on a non-pick task */
  .plp-task-badge{display:inline-block;margin-left:5px;padding:0 6px;border-radius:10px;font-size:11px;font-weight:700;letter-spacing:.2px;border:1px solid transparent}
  .plp-task-STOP,.plp-task-IDLEOUTAGE,.plp-task-IDLEINTAKE{background:#a8071a;color:#fff;border-color:#7a0010}
  .plp-task-BREAK{background:#d48806;color:#fff;border-color:#ad6800}
  .plp-task-MEETING{background:#1677ff;color:#fff;border-color:#0958d9}
  .plp-task-TRAINING{background:#531dab;color:#fff;border-color:#391085}
  .plp-task-PUTAWAY1,.plp-task-PUTAWAY{background:#0958d9;color:#fff;border-color:#003eb3}
  .plp-task-PACKINGM,.plp-task-PACKING{background:#d46b08;color:#fff;border-color:#ad4e00}
  .plp-task-PICKING{background:#389e0d;color:#fff;border-color:#237804}
  .plp-task-OTHER{background:#595959;color:#fff;border-color:#3a3a3a}
  /* UPH badge when showing task (replaces number in pick-tower) */
  .uph-badge.task{background:transparent!important;border-color:transparent!important;padding:0}

  /* ETA badge in overview */
  .eta-wrap{display:block;margin-top:2px;font-size:11px;line-height:1.1}
  .eta-badge{display:inline-block;padding:0 6px;border-radius:10px;background:#f1fff1;color:#0b7a0b;border:1px solid #bfe5bf}
  .eta-badge.warn{background:#fff7e6;color:#ad6800;border-color:#f5d7a6}
  .eta-badge.err{background:#fff1f0;color:#a8071a;border-color:#ffccc7}

  /* Tabs action area */
  .plp-tabs-actions{display:inline-flex;gap:6px;align-items:center;margin-left:10px}
  .plp-tabs-sep{color:#999;margin:0 4px}

  /* ═══ Buttons – super odhaczacz style ═══ */
  .plp-btn{
    display:inline-flex;align-items:center;justify-content:center;
    padding:0 10px;height:34px;min-width:34px;
    background:#fff;border:1px solid #bbb;border-radius:6px;
    cursor:pointer;font-size:12px;font-weight:700;
    box-shadow:0 2px 6px rgba(0,0,0,.15);user-select:none;
    white-space:nowrap;
  }
  .plp-btn:hover{background:#f0f0f0}
  .plp-btn:active{transform:translateY(1px)}

  .plp-gear{
    display:inline-flex;align-items:center;justify-content:center;
    width:34px;height:34px;
    background:#fff;border:1px solid #bbb;border-radius:6px;
    cursor:pointer;font-size:15px;
    box-shadow:0 2px 6px rgba(0,0,0,.15);user-select:none;
  }
  .plp-gear:hover{background:#f0f0f0}
  .plp-gear:active{transform:translateY(1px)}

  .plp-pickers-click{cursor:pointer;text-decoration:underline}

  /* Mini modal */
  #plp-mini-bg{position:fixed;inset:0;z-index:2051;background:rgba(0,0,0,.35);display:none}
  #plp-mini-box{position:relative;max-width:520px;width:520px;background:#fff;color:#000;border-radius:10px;border:1px solid #ddd;margin:60px auto;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  #plp-mini-close{position:absolute;right:10px;top:8px;cursor:pointer;color:#333;font-size:16px}
  #plp-mini-content{max-height:70vh;overflow:auto}

  /* ═══ Settings modal – Thresholds style (TT-inspired) ═══ */
  #plp-sett-bg{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2052;display:none;align-items:flex-start;justify-content:center;padding-top:40px}
  #plp-sett-box{background:#fff;color:#000;border-radius:10px;border:1px solid #ddd;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px;max-width:620px;width:620px;max-height:85vh;overflow-y:auto}
  #plp-sett-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px;font-size:14px}
  #plp-sett-close{cursor:pointer;color:#333;font-size:16px}
  .plp-sett-section{margin-top:12px;margin-bottom:4px;font-weight:700;color:#222;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  .plp-sett-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px}
  .plp-sett-tbl th,.plp-sett-tbl td{border:1px solid #eee;padding:7px 8px}
  .plp-sett-tbl th{background:#f6f8fa;text-align:left;width:55%}
  .plp-sett-tbl input[type="number"],.plp-sett-tbl input[type="text"]{width:100%;border:1px solid #d0d7de;border-radius:6px;padding:5px 7px;box-sizing:border-box;font-size:12px}
  .plp-sett-tbl input[type="checkbox"]{width:16px;height:16px;cursor:pointer}
  .plp-sett-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:12px}

  /* ═══ Left filter panel (super odhaczacz) ═══ */
  #plp-check-panel{
    position:fixed;left:35px;top:300px;z-index:999999;
    display:flex;flex-direction:column;gap:8px;
  }
  .plp-check-btn{
    width:34px;height:34px;background:#fff;border:1px solid #bbb;
    border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,.15);user-select:none;
  }
  .plp-check-btn:hover{background:#f0f0f0}
  .plp-check-btn.holding{outline:2px solid #1a73e8;outline-offset:1px}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ─── Utilities ────────────────────────────────────────────────
  const T = el => (el && (el.textContent || '').trim()) || '';
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const sanitize = s => (s || '').split(';')[0].replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const waitFor = (cond, { interval = 150, timeout = 60000 } = {}) => new Promise(res => {
    const t0 = Date.now();
    const id = setInterval(() => { if (cond()) { clearInterval(id); res(true); } else if (Date.now() - t0 > timeout) { clearInterval(id); res(false); } }, interval);
  });
  const fmtDurShort = (h) => {
    if (!isFinite(h) || h <= 0) return '0m';
    const m = Math.round(h * 60);
    if (m >= 60) { const hh = Math.floor(m / 60); return hh + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); }
    return m + 'm';
  };

  // ─── BroadcastChannel / LS bridge ─────────────────────────────
  const CH = 'TRSL_UPH_BRIDGE_V1';
  const chan = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(CH) : null;
  const useLS = !chan; const LS_KEY = 'TRSL_UPH_BRIDGE_MSG';
  const send = (obj) => { if (chan) { chan.postMessage(obj); } else { localStorage.setItem(LS_KEY, JSON.stringify({ ...obj, _rnd: Math.random(), _ts: Date.now() })); } };

  // ─── UPH Cache (in-memory + localStorage) ─────────────────────
  function getCache() { if (!window.PLP_UPH_CACHE) window.PLP_UPH_CACHE = {}; return window.PLP_UPH_CACHE; }
  function resetCache() { window.PLP_UPH_CACHE = {}; }
  const LS_UPH_CACHE = 'PLP_UPH_CACHE_V1';
  const LS_UPH_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

  function saveUPHCacheToLS() { try { localStorage.setItem(LS_UPH_CACHE, JSON.stringify({ ts: Date.now(), data: getCache() })); } catch (_) { } }
  function loadUPHCacheFromLS() {
    try {
      const raw = localStorage.getItem(LS_UPH_CACHE); if (!raw) return false;
      const obj = JSON.parse(raw); if (!obj || !obj.data) return false;
      if (obj.ts && (Date.now() - obj.ts) > LS_UPH_CACHE_MAX_AGE_MS) return false;
      setCache(obj.data); return true;
    } catch (_) { return false; }
  }
  function setCache(map) {
    if (!window.PLP_UPH_CACHE) window.PLP_UPH_CACHE = {};
    if (map && typeof map === 'object') {
      for (const [login, v] of Object.entries(map)) { const uph = Number(v) || 0; if (uph > 0) window.PLP_UPH_CACHE[login] = uph; }
    }
    saveUPHCacheToLS();
  }
  function setCacheKey(login, uph) { const c = getCache(); c[login] = Number(uph) || 0; saveUPHCacheToLS(); trendPush(login, c[login]); }

  // ─── Settings ─────────────────────────────────────────────────
  const K = {
    AUTO: 'PLP_AUTO_REFRESH_ON', TRSL_MANUAL_ONLY: 'PLP_TRSL_REFRESH_MANUAL_ONLY', ETA_FMT: 'PLP_ETA_FORMAT',
    SMALL_THR: 'PLP_SMALL_THRESHOLD', IGN_SMALL: 'PLP_IGNORE_SMALL_NON_STARTED',
    S_WARN: 'PLP_SBD_WARN_ON',
    FB_TCON: 'PLP_FALLBACK_UPH_TCON', FB_SCON: 'PLP_FALLBACK_UPH_SCON',
    FB_ICON: 'PLP_FALLBACK_UPH_ICON', FB_BCON: 'PLP_FALLBACK_UPH_BCON', FB_RCON: 'PLP_FALLBACK_UPH_RCON',
    OSR_MIN: 'PLP_OSR_MIN_UPH', OSR_MAX: 'PLP_OSR_MAX_UPH',
    ETA_SF: 'PLP_ETA_SAFETY_FACTOR', OSR_OH_MIN: 'PLP_OSR_OVERHEAD_MIN',
    TREND_DELTA: 'PLP_TREND_DELTA_UPH',
    IDLE_ON: 'PLP_IDLE_ALERT_ON', IDLE_MIN: 'PLP_IDLE_PICK_MIN',
    IDLE_COOLDOWN: 'PLP_IDLE_COOLDOWN_MIN', IDLE_PROBE_WIN: 'PLP_IDLE_PROBE_WINDOW',
    // NEW: UNPR
    UNPR_ON: 'PLP_UNPR_ALERT_ON',
    UNPR_MIN: 'PLP_UNPR_MIN_NOPICK',
    UNPR_COOLDOWN: 'PLP_UNPR_COOLDOWN_MIN',
  };
  const DEF = {
    [K.AUTO]: '0', [K.TRSL_MANUAL_ONLY]: '1', [K.ETA_FMT]: 'duration',
    [K.SMALL_THR]: '15', [K.IGN_SMALL]: '1', [K.S_WARN]: '1',
    [K.FB_TCON]: '95', [K.FB_SCON]: '95', [K.FB_ICON]: '95', [K.FB_BCON]: '95', [K.FB_RCON]: '95',
    [K.OSR_MIN]: '50', [K.OSR_MAX]: '90', [K.ETA_SF]: '1.35', [K.OSR_OH_MIN]: '1',
    [K.TREND_DELTA]: '5',
    [K.IDLE_ON]: '0', [K.IDLE_MIN]: '4', [K.IDLE_COOLDOWN]: '15', [K.IDLE_PROBE_WIN]: '5m',
    [K.UNPR_ON]: '0', [K.UNPR_MIN]: '4', [K.UNPR_COOLDOWN]: '15',
  };
  function getSet(k) { if (localStorage.getItem(k) == null) localStorage.setItem(k, DEF[k]); return localStorage.getItem(k); }
  function setSet(k, v) { localStorage.setItem(k, String(v)); }
  function trslManualOnly() { return getSet(K.TRSL_MANUAL_ONLY) === '1'; }

  // ─── UPH Trend ────────────────────────────────────────────────
  const LS_UPH_TREND = 'PLP_UPH_TREND_V1';
  const TREND_MAX = 3;
  function loadJSON(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch (_) { return fb; } }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { } }
  function trendDelta() { return Math.max(1, Number(getSet(K.TREND_DELTA) || 5)); }
  const _trend = loadJSON(LS_UPH_TREND, {});
  function trendPush(login, uph) {
    try {
      if (!login) return; const v = Number(uph) || 0; if (v <= 0) return;
      const now = Date.now(); const arr = Array.isArray(_trend[login]) ? _trend[login] : [];
      if (arr.length && arr[arr.length - 1] && arr[arr.length - 1].v === v && (now - arr[arr.length - 1].ts) < 30000) return;
      arr.push({ ts: now, v }); while (arr.length > TREND_MAX) arr.shift();
      _trend[login] = arr; saveJSON(LS_UPH_TREND, _trend);
    } catch (_) { }
  }
  function trendArrow(login) {
    const arr = Array.isArray(_trend[login]) ? _trend[login] : [];
    if (arr.length < 2) return { arrow: '', delta: 0, dir: 'flat' };
    const a = arr[arr.length - 1].v, b = arr[arr.length - 2].v, d = a - b, thr = trendDelta();
    if (d >= thr) return { arrow: 'up', delta: d, dir: 'up' };
    if (d <= -thr) return { arrow: 'down', delta: d, dir: 'down' };
    return { arrow: '', delta: d, dir: 'flat' };
  }
  function trendArrowMarkup(login) {
    const t = trendArrow(login);
    if (!t || !t.arrow) return '';
    if (t.arrow === 'up') return ' <span class="uph-arrow up"><svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle;display:inline-block"><polygon points="5,1 9.5,9 0.5,9" fill="#1fa971"/></svg></span>';
    if (t.arrow === 'down') return ' <span class="uph-arrow down"><svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle;display:inline-block"><polygon points="5,9 9.5,1 0.5,1" fill="#d93f5f"/></svg></span>';
    return '';
  }

  // ─── Idle state (probe-based) ──────────────────────────────────
  const LS_IDLE_STATE = 'PLP_IDLE_STATE_V1';
  const _idle = loadJSON(LS_IDLE_STATE, { lastActive: {}, lastAlert: {} });
  function idleOn() { return false; /* removed by v2.1.28 */ }
  function idleMin() { return Math.max(1, Number(getSet(K.IDLE_MIN) || 4)); }
  function idleCooldownMin() { return Math.max(1, Number(getSet(K.IDLE_COOLDOWN) || 15)); }
  function idleProbeWindow() { return (getSet(K.IDLE_PROBE_WIN) || '5m').trim(); }
  function notePickSignal(login, isActive) { if (!login) return; if (isActive) _idle.lastActive[login] = Date.now(); saveJSON(LS_IDLE_STATE, _idle); }
  function canAlert(login) { const cd = idleCooldownMin() * 60 * 1000; return (Date.now() - (_idle.lastAlert[login] || 0)) >= cd; }
  function markAlerted(login) { _idle.lastAlert[login] = Date.now(); saveJSON(LS_IDLE_STATE, _idle); }

  // ─── UNPR state (TRSL lastSaw-based) ──────────────────────────
  const LS_UNPR_STATE  = 'PLP_UNPR_STATE_V1';
  const LS_UNPR_STATUS = 'PLP_UNPR_STATUS_V1';
  const _unpr = loadJSON(LS_UNPR_STATE, { lastAlert: {}, lastTaskAlert: {} });
  if (!_unpr.lastTaskAlert) _unpr.lastTaskAlert = {}; // migrate old format
  let _unprLastSaw  = {};          // login → timestamp ms (last DIRECT pick, from TRSL)
  let _unprNonActive = new Map();  // login → task name (STOP / Replen / etc.)
  let _unprFreshTs  = 0;           // timestamp of last unpr:map received — 0 = no data yet
  let _unprStatus   = { ts: 0, flagged: {}, mins: {}, taskMap: {} }; // NOT persisted to LS
  function saveUnprStatus() { /* intentionally not persisted — marks only valid after fresh refresh */ }

  function unprOn() { return false; /* removed by v2.1.28 */ }
  function unprMin() { return Math.max(1, Number(getSet(K.UNPR_MIN) || 4)); }
  function unprCooldown() { return Math.max(1, Number(getSet(K.UNPR_COOLDOWN) || 15)); }
  function canUnprAlert(login)  { const cd = unprCooldown() * 60 * 1000; return (Date.now() - (_unpr.lastAlert[login] || 0)) >= cd; }
  function markUnprAlerted(login) { _unpr.lastAlert[login] = Date.now(); saveJSON(LS_UNPR_STATE, _unpr); }
  function canTaskAlert(login)  { const cd = unprCooldown() * 60 * 1000; return (Date.now() - (_unpr.lastTaskAlert[login] || 0)) >= cd; }
  function markTaskAlerted(login) { _unpr.lastTaskAlert[login] = Date.now(); saveJSON(LS_UNPR_STATE, _unpr); }
  const fmtMins = ms => Math.round(ms / 60000);

  // ─── Login cell map ────────────────────────────────────────────
  function findPickTowerTables() {
    const tables = [...document.querySelectorAll('table')];
    return tables.filter(tbl => {
      const hdr = tbl.querySelector('tr'); if (!hdr) return false;
      const h = [...hdr.querySelectorAll('th')].map(x => norm(T(x)));
      return h.some(k => k.startsWith('user') || k.startsWith('login')) && h.some(k => k.startsWith('units'));
    });
  }
  function getPlainLoginFromCell(td) { const clone = td.cloneNode(true); clone.querySelectorAll('.uph-badge,.plp-idle-badge,.plp-unpr-badge,.plp-task-badge').forEach(x => x.remove()); return sanitize(T(clone)); }
  function mapLoginCells() {
    const map = new Map();
    findPickTowerTables().forEach(tbl => {
      const hdr = tbl.querySelector('tr'); const h = [...hdr.querySelectorAll('th')].map(x => norm(T(x)));
      const iU = h.findIndex(k => k.startsWith('user') || k.startsWith('login'));
      const iN = h.findIndex(k => k.startsWith('units'));
      if (iU < 0 || iN < 0) return;
      [...tbl.querySelectorAll('tr')].slice(1).forEach(tr => {
        const tdUser = tr.children[iU], tdUnits = tr.children[iN];
        if (!tdUser || !tdUnits) return;
        const login = getPlainLoginFromCell(tdUser);
        const unitsStr = T(tdUnits); const m = unitsStr.match(/(\d+)\s*\/\s*(\d+)/);
        const units = m ? parseInt(m[1], 10) : parseInt(unitsStr.replace(/[^0-9]/g, ''), 10);
        if (!login || !(units > 0)) return;
        if (!map.has(login)) map.set(login, []);
        map.get(login).push(tdUser);
      });
    });
    return map;
  }

  // ─── Badge lock ────────────────────────────────────────────────
  if (!window.PLP_BADGE_LOCK) window.PLP_BADGE_LOCK = {};
  function lockLogin(login, ms = 60000) { window.PLP_BADGE_LOCK[login] = Date.now() + ms; }
  function locked(login) { return Date.now() < (window.PLP_BADGE_LOCK[login] || 0); }

  // ─── Apply UPH badge to login cell ────────────────────────────
  function updateLoginBadge(login, src) {
    const cells = mapLoginCells();
    const els = cells.get(login) || [];
    const task = _unprNonActive.get(login); // non-null if on non-pick task
    if (task) { markTaskBadge(login, task); return; } // task overrides UPH
    const v = Number(getCache()[login] || 0);
    const time = new Date().toLocaleTimeString();
    const t = trendArrow(login); const delta = t?.delta || 0;
    const dt = delta === 0 ? 'Δ 0' : (delta > 0 ? 'Δ +' + delta : 'Δ ' + delta);
    const isUnpr = unprOn() && isLoginUnpr(login);
    const arrowHtml = trendArrowMarkup(login);
    els.forEach(td => {
      let b = td.querySelector('.uph-badge');
      if (!b) { b = document.createElement('span'); b.className = 'uph-badge'; td.appendChild(b); }
      b.className = 'uph-badge'; // reset (remove task class if it was set)
      b.innerHTML = v + ' <span class="uph-unit">UPH</span>' + arrowHtml;
      b.dataset.src = src; b.dataset.ts = String(Date.now());
      b.title = String(src).toUpperCase() + ' @ ' + time + (arrowHtml ? '  ' + dt : '');
      b.classList.toggle('unpr', isUnpr);
    });
    if (src === 'calc60') lockLogin(login);
  }

  // Apply ALL cached badges (called after DOM refresh)
  function applyAllCachedBadges() {
    const cache = getCache();
    const cells = mapLoginCells();
    for (const [login, els] of cells.entries()) {
      const task = _unprNonActive.get(login);
      if (task) { markTaskBadge(login, task); continue; } // task overrides UPH
      const v = Number(cache[login] || 0); if (!v) continue;
      const isUnpr = unprOn() && isLoginUnpr(login);
      const arrowHtml = trendArrowMarkup(login);
      els.forEach(td => {
        let b = td.querySelector('.uph-badge');
        if (!b) { b = document.createElement('span'); b.className = 'uph-badge'; td.appendChild(b); }
        b.className = 'uph-badge'; // reset
        b.innerHTML = v + ' <span class="uph-unit">UPH</span>' + arrowHtml;
        b.dataset.src = 'cache'; b.dataset.ts = String(Date.now());
        b.classList.toggle('unpr', isUnpr);
      });
    }
  }

  function applyOverallMap(data) {
    const raw = data || {};
    const cells = mapLoginCells();
    for (const [login, els] of cells.entries()) {
      const task = _unprNonActive.get(login);
      if (task) { markTaskBadge(login, task); continue; } // task overrides UPH
      if (!Object.prototype.hasOwnProperty.call(raw, login)) continue;
      const val = Number(raw[login]) || 0; if (!(val > 0)) continue;
      if (locked(login)) continue;
      const isUnpr = unprOn() && isLoginUnpr(login);
      const arrowHtml = trendArrowMarkup(login);
      els.forEach(td => {
        let b = td.querySelector('.uph-badge');
        if (!b) { b = document.createElement('span'); b.className = 'uph-badge'; td.appendChild(b); }
        b.className = 'uph-badge'; // reset
        b.innerHTML = val + ' <span class="uph-unit">UPH</span>' + arrowHtml;
        b.dataset.src = 'overall'; b.dataset.ts = String(Date.now());
        b.classList.toggle('unpr', isUnpr);
      });
      setCacheKey(login, val);
    }
  }

  // ─── ETA per picker in picklists ──────────────────────────────
  function applyPickerETAs() {
    const fbUPH = Number(getSet(K.FB_TCON) || DEF[K.FB_TCON]);
    findPickTowerTables().forEach(tbl => {
      const hdr = tbl.querySelector('tr');
      const ths = [...hdr.querySelectorAll('th')].map(x => norm(T(x)));
      const iU = ths.findIndex(k => k.startsWith('user') || k.startsWith('login'));
      const iN = ths.findIndex(k => k.startsWith('units'));
      if (iU < 0 || iN < 0) return;
      [...tbl.querySelectorAll('tr')].slice(1).forEach(tr => {
        const tdUser = tr.children[iU], tdUnits = tr.children[iN];
        if (!tdUser || !tdUnits) return;
        const login = getPlainLoginFromCell(tdUser);
        const unitsStr = T(tdUnits);
        const m = unitsStr.match(/(\d+)\s*\/\s*(\d+)/);
        const unitsLeft = m ? parseInt(m[1], 10) : parseInt(unitsStr.replace(/[^0-9]/g, ''), 10);
        let badge = tdUnits.querySelector('.eta-picker');
        if (!login || !(unitsLeft > 0)) { if (badge) badge.remove(); return; }
        const uph = Number(getCache()[login] || 0) || fbUPH;
        const etaH = unitsLeft / Math.max(1, uph);
        const etaStr = fmtDurShort(etaH);
        if (!badge) { badge = document.createElement('span'); badge.className = 'eta-picker'; tdUnits.appendChild(badge); }
        badge.textContent = '≈' + etaStr;
        badge.title = login + ' UPH:' + Math.round(uph) + ' → ' + unitsLeft + ' units left';
        badge.className = 'eta-picker' + (etaH > 2 ? ' err' : etaH > 1 ? ' warn' : '');
      });
    });
  }

  // ─── UNPR detection ────────────────────────────────────────────
  function isLoginUnpr(login) {
    return !!(_unprStatus && _unprStatus.flagged && _unprStatus.flagged[login]);
  }

  function assignedLogins() {
    const tbl = document.getElementById('pickLists_table'); const out = new Set();
    if (!tbl) return out;
    const hdr = tbl.querySelector('tr'); if (!hdr) return out;
    const hs = [...hdr.querySelectorAll('th')].map(h => T(h).toLowerCase());
    const iUser = hs.indexOf('user');
    if (iUser < 0) return out;
    [...tbl.querySelectorAll('tr')].slice(1).forEach(r => {
      if (!r.classList.contains('picklist_in_progress')) return;
      const cell = r.children[iUser]; const login = getPlainLoginFromCell(cell);
      if (login && login !== '-') out.add(login);
    });
    return out;
  }

  function mapPickListsUserCells() {
    const tbl = document.getElementById('pickLists_table'); const map = new Map();
    if (!tbl) return map;
    const hdr = tbl.querySelector('tr'); if (!hdr) return map;
    const hs = [...hdr.querySelectorAll('th')].map(h => T(h).toLowerCase());
    const iUser = hs.indexOf('user'); if (iUser < 0) return map;
    [...tbl.querySelectorAll('tr')].slice(1).forEach(r => {
      // Only "In Progress" rows — Released lists should not get task/UNPR badges
      if (!r.classList.contains('picklist_in_progress')) return;
      const cell = r.children[iUser]; if (!cell) return;
      const login = getPlainLoginFromCell(cell); if (!login || login === '-') return;
      if (!map.has(login)) map.set(login, []);
      map.get(login).push(cell);
    });
    return map;
  }

  function clearUnprMarks() {
    document.querySelectorAll('.plp-unpr-badge').forEach(x => x.remove());
    document.querySelectorAll('.plp-task-badge:not(.uph-badge *)').forEach(x => x.remove());
    document.querySelectorAll('.plp-unpr-cell').forEach(x => x.classList.remove('plp-unpr-cell'));
    document.querySelectorAll('.uph-badge.unpr').forEach(x => x.classList.remove('unpr'));
    // Reset UPH badges that were replaced by task display
    document.querySelectorAll('.uph-badge.task').forEach(b => {
      b.className = 'uph-badge';
      // UPH value will be restored by applyAllCachedBadges on next reapply
    });
  }

  // Returns CSS class suffix for a given task name
  function taskCssClass(task) {
    const t = (task || '').toUpperCase().replace(/\s+/g, '');
    const known = ['STOP','BREAK','MEETING','TRAINING','PUTAWAY1','PUTAWAY','PACKINGM','PACKING','PICKING','IDLEINTAKE','IDLEOUTAGE'];
    const match = known.find(k => t.startsWith(k));
    return match || 'OTHER';
  }

  // Task badge in PICKLIST table cells (user column) — added as sibling span
  function markTaskBadge(login, task) {
    const cls = taskCssClass(task);
    const label = (task || 'TASK').toUpperCase();
    const pickCells = mapPickListsUserCells().get(login) || [];
    pickCells.forEach(td => {
      let b = td.querySelector('.plp-task-badge');
      if (!b) { b = document.createElement('span'); b.className = 'plp-task-badge'; td.appendChild(b); }
      // Reset all color classes
      b.className = 'plp-task-badge plp-task-' + cls;
      b.textContent = label;
      b.title = login + ' is currently on: ' + task;
    });
    // In pick-tower LOGIN cells: replace UPH badge content with task badge
    const loginCells = mapLoginCells().get(login) || [];
    loginCells.forEach(td => {
      let b = td.querySelector('.uph-badge');
      if (!b) { b = document.createElement('span'); b.className = 'uph-badge'; td.appendChild(b); }
      b.className = 'uph-badge task';
      b.innerHTML = '<span class="plp-task-badge plp-task-' + cls + '">' + label + '</span>';
      b.title = login + ' — ' + task;
    });
  }

  // Scroll to and highlight a worker's row — used on toast click
  function scrollToLogin(login) {
    if (!login) return;
    const tbl = document.getElementById('pickLists_table');
    if (tbl) {
      const hdr = tbl.querySelector('tr');
      if (hdr) {
        const hs = [...hdr.querySelectorAll('th')].map(h => T(h).toLowerCase());
        const iUser = hs.indexOf('user');
        if (iUser >= 0) {
          for (const row of [...tbl.querySelectorAll('tr')].slice(1)) {
            const cell = row.children[iUser];
            if (cell && getPlainLoginFromCell(cell) === login) {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              row.style.outline = '3px solid #faad14';
              setTimeout(() => { row.style.outline = ''; }, 2500);
              return;
            }
          }
        }
      }
    }
    // Fallback: pick-tower login cells
    const cells = mapLoginCells().get(login);
    if (cells && cells[0]) {
      const tr = cells[0].closest('tr');
      if (tr) {
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        tr.style.outline = '3px solid #faad14';
        setTimeout(() => { tr.style.outline = ''; }, 2500);
      }
    }
  }

  function showToast(html, login) {
    let toast = document.getElementById('plp-unpr-toast');
    if (!toast) {
      toast = document.createElement('div'); toast.id = 'plp-unpr-toast';
      toast.style.cssText = 'position:fixed;top:12px;right:14px;z-index:9999999;background:#a8071a;color:#fff;padding:10px 16px 10px 14px;border-radius:8px;font-weight:700;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.4);display:none;max-width:360px;cursor:pointer;line-height:1.5;user-select:none';
      document.body.appendChild(toast);
    }
    toast.innerHTML = html + '<span style="display:block;font-size:10px;font-weight:400;opacity:.7;margin-top:3px">🔍 click to find worker</span>';
    toast.dataset.login = login || '';
    toast.style.display = 'block';
    if (toast._clickHandler) toast.removeEventListener('click', toast._clickHandler);
    toast._clickHandler = () => { toast.style.display = 'none'; scrollToLogin(toast.dataset.login); };
    toast.addEventListener('click', toast._clickHandler);
    if (toast._hideTimer) clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 12000);
  }

  function notifyTask(login, task) {
    showToast('🔴 Non-pick task: <b>' + login + '</b><br><span style="font-weight:400;font-size:11px">currently on: <b>' + task + '</b></span>', login);
    try { if (typeof GM_notification === 'function') GM_notification({ title: '🔴 Non-pick task', text: login + ' — currently on: ' + task, timeout: 7000 }); } catch (_) { }
  }

  function markUnpr(login, mins) {
    const cells = mapPickListsUserCells().get(login) || [];
    cells.forEach(td => {
      td.classList.add('plp-unpr-cell');
      let ex = td.querySelector('.plp-unpr-badge');
      if (!ex) { ex = document.createElement('span'); ex.className = 'plp-unpr-badge'; td.appendChild(ex); }
      ex.textContent = 'UNPR ' + mins + 'm';
      ex.title = 'No picks for ' + mins + 'min (lastSaw from TRSL Overall)';
    });
    const loginCells = mapLoginCells().get(login) || [];
    loginCells.forEach(td => { const b = td.querySelector('.uph-badge'); if (b) b.classList.add('unpr'); });
  }

  function notifyUnpr(login, mins) {
    showToast('⚠️ UNPR: <b>' + login + '</b><br><span style="font-weight:400;font-size:11px">no picks for ~' + mins + 'min (still assigned)</span>', login);
    try { if (typeof GM_notification === 'function') GM_notification({ title: '⚠️ UNPR picker', text: login + ' — no picks ~' + mins + 'min', timeout: 7000 }); } catch (_) { }
  }

  function unprCheck() {
    if (!unprOn() || !_unprFreshTs) {
      if (!_unprFreshTs) _fullClearUnprMarks();
      return;
    }

    const nowTs  = Date.now();
    const thrMs  = unprMin() * 60 * 1000;
    const flagged  = {};
    const minsMap  = {};
    const taskMap  = {};

    // Only show task badges / alerts for workers who are on a picklist in PLP
    const assigned = assignedLogins(); // workers with picklist_in_progress

    // 1) Non-pick task workers — only those assigned in PLP picklist
    for (const [login, task] of _unprNonActive.entries()) {
      if (!assigned.has(login)) continue; // not on a PLP pick list → ignore
      taskMap[login] = task;
      if (canTaskAlert(login)) { notifyTask(login, task); markTaskAlerted(login); }
    }

    // 2) UNPR time-threshold — only logins with TRSL data AND assigned in PLP
    for (const login of Object.keys(_unprLastSaw)) {
      if (_unprNonActive.has(login)) continue; // handled above
      if (!assigned.has(login)) continue;       // not on a PLP pick list → ignore
      const last = _unprLastSaw[login];
      if (!last) continue;
      const idleFor = nowTs - last;
      if (idleFor > thrMs) {
        const mins = fmtMins(idleFor);
        flagged[login] = true;
        minsMap[login] = mins;
        if (canUnprAlert(login)) { notifyUnpr(login, mins); markUnprAlerted(login); }
      }
    }

    _unprStatus = { ts: nowTs, flagged, mins: minsMap, taskMap };
    applyUnprHighlightsFromCache();
  }

  // HARD SWITCH: disable all automatic personal TRSL checks.
  // Personal TRSL can run only on explicit click on a login cell.
  const AUTO_PERSONAL_TRSL_CHECKS = false;

  // ─── Idle (probe-based) tick ───────────────────────────────────
  const inflight = new Set();
  function askUPH(login) {
    try {
      const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(CH) : null;
      const _send = (o) => { if (bc) bc.postMessage(o); else localStorage.setItem(LS_KEY, JSON.stringify({ ...o, _rnd: Math.random(), _ts: Date.now() })); };
      if (!inflight.has(login)) { inflight.add(login); _send({ type: 'calcUPH', login, window: '60m', src: 'PLP' }); setTimeout(() => inflight.delete(login), 20000); }
    } catch (_) { }
  }
  function askUPHWindow(login, win) {
    if (!AUTO_PERSONAL_TRSL_CHECKS) return;
    try {
      const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(CH) : null;
      const _send = (o) => { if (bc) bc.postMessage(o); else localStorage.setItem(LS_KEY, JSON.stringify({ ...o, _rnd: Math.random(), _ts: Date.now() })); };
      _send({ type: 'calcUPH', login, window: win, src: 'PLP_IDLE' });
    } catch (_) { }
  }

  // Idle probe only starts after first data arrives from TRSL (not on page load)
  let _dataReceived = false;
  let _overallInProgress = false; // true while overall:refresh → overall:map cycle is active

  function idleTick() {
    if (!AUTO_PERSONAL_TRSL_CHECKS) return;
    if (!idleOn() || !_dataReceived || _overallInProgress) return;
    const assigned = [...assignedLogins()]; const win = idleProbeWindow();
    let i = 0;
    (function step() { if (i >= assigned.length) return; askUPHWindow(assigned[i++], win); setTimeout(step, 180); })();
    setTimeout(() => {
      const now = Date.now(); const thrMs = idleMin() * 60 * 1000;
      for (const login of assigned) {
        const la = _idle.lastActive[login] || 0; if (!la) continue;
        const idleFor = now - la;
        if (idleFor > thrMs) {
          const mins = fmtMins(idleFor);
          // idle marks (orange, probe-based) - lighter than UNPR
          const cells = mapPickListsUserCells().get(login) || [];
          cells.forEach(td => {
            td.classList.add('plp-idle-cell');
            let ex = td.querySelector('.plp-idle-badge');
            if (!ex) { ex = document.createElement('span'); ex.className = 'plp-idle-badge'; td.appendChild(ex); }
            ex.textContent = 'IDLE ' + mins + 'm';
          });
          if (canAlert(login)) {
            try { if (typeof GM_notification === 'function') GM_notification({ title: 'IDLE picker', text: login + ' idle ~' + mins + 'min', timeout: 6000 }); } catch (_) { }
            markAlerted(login);
          }
        }
      }
    }, 1300);
  }
  // v2.1.28: idle detection removed; idleTick interval disabled.
  // No immediate fire on load — idle probe starts only after first TRSL data arrives

  function reapplyPersistentDecorations() {
    try { applyAllCachedBadges(); } catch (_) { }
    try { applyPickerETAs(); } catch (_) { }
    try { applyUnprHighlightsFromCache(); } catch (_) { }
    try { if (typeof window.PLP_ETA_REFRESH === 'function') window.PLP_ETA_REFRESH(); } catch (_) { }
  }

  const _BADGE_CLASSES = new Set(['uph-badge','plp-task-badge','plp-unpr-badge','plp-idle-badge','uph-unit','uph-arrow']);
  function isBadgeMutation(mutations) {
    return mutations.every(m =>
      [...m.addedNodes, ...m.removedNodes].every(n =>
        n.nodeType === Node.TEXT_NODE ||
        (n.nodeType === Node.ELEMENT_NODE && [...n.classList].some(c => _BADGE_CLASSES.has(c)))
      )
    );
  }

  // ─── DOM refresh watcher (re-apply badges after table re-render) ─
  (function watchPickListsDOM() {
    let lastDomRefreshUPH = 0;
    let lastSignature = '';
    let attachedTbl = null;
    const TABLE_COOLDOWN_MS = 15000;
    function scheduleDomRefreshUPH() {
      const nowTs = Date.now();
      if ((nowTs - lastDomRefreshUPH) < TABLE_COOLDOWN_MS) return;
      clearTimeout(watchPickListsDOM._r);
      watchPickListsDOM._r = setTimeout(() => {
        lastDomRefreshUPH = Date.now();
        doRefresh(false); // auto DOM refresh; skipped when manual-only mode is ON
      }, 900);
    }
    function tableSignature(tbl) {
      try {
        const rows = [...tbl.querySelectorAll('tr')].slice(1, 8);
        return rows.map(r => {
          const clone = r.cloneNode(true);
          clone.querySelectorAll('.uph-badge,.plp-task-badge,.plp-unpr-badge,.plp-idle-badge').forEach(x => x.remove());
          return (clone.textContent || '').replace(/\s+/g, ' ').trim();
        }).join('|').slice(0, 800);
      } catch (_) { return ''; }
    }
    const tblMo = new MutationObserver((mutations) => {
      if (isBadgeMutation(mutations)) return; // ignore our own badge changes
      clearTimeout(watchPickListsDOM._t);
      watchPickListsDOM._t = setTimeout(() => {
        reapplyPersistentDecorations();
        const tbl = document.getElementById('pickLists_table');
        if (!tbl) return;
        const sig = tableSignature(tbl);
        if (sig && sig !== lastSignature) {
          lastSignature = sig;
          scheduleDomRefreshUPH();
        }
      }, 220);
    });
    function attachTableObserver() {
      const tbl = document.getElementById('pickLists_table');
      if (!tbl) return false;
      if (attachedTbl === tbl) return true;
      try { tblMo.disconnect(); } catch (_) { }
      attachedTbl = tbl;
      lastSignature = tableSignature(tbl);
      tblMo.observe(tbl, { childList: true, subtree: true, attributes: false });
      reapplyPersistentDecorations();
      return true;
    }
    const bodyMo = new MutationObserver((mutations) => {
      if (isBadgeMutation(mutations)) return; // ignore badge-only changes
      clearTimeout(watchPickListsDOM._b);
      watchPickListsDOM._b = setTimeout(() => {
        attachTableObserver();
        reapplyPersistentDecorations();
      }, 180);
    });
    bodyMo.observe(document.body, { childList: true, subtree: true });
    let tries = 0;
    const id = setInterval(() => {
      const attached = attachTableObserver();
      if (attached) {
        reapplyPersistentDecorations();
        if (++tries > 5) clearInterval(id); // stop once table is stable
      } else if (++tries > 60) clearInterval(id); // give up after 60s if no table
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) setTimeout(reapplyPersistentDecorations, 120);
    });
    window.addEventListener('focus', () => setTimeout(reapplyPersistentDecorations, 120));
    // Gentle periodic reapply — only UPH/ETA badges, not destructive clear
    setInterval(() => {
      if (!document.getElementById('pickLists_table')) return;
      try { applyAllCachedBadges(); } catch (_) { }
      try { applyPickerETAs(); } catch (_) { }
      // Task/UNPR reapply only if DOM changed (badges missing)
      try {
        const hasTaskBadges = !!document.querySelector('.plp-task-badge,.plp-unpr-badge');
        const needsTask = _unprFreshTs && (Object.keys(_unprStatus.taskMap || {}).length > 0 || Object.keys(_unprStatus.flagged || {}).length > 0);
        if (needsTask && !hasTaskBadges) applyUnprHighlightsFromCache();
      } catch (_) { }
    }, 3000);
    attachTableObserver();
  })();

  const UNPR_FRESH_MAX_MS = 15 * 60 * 1000;

  // ─── Task/UNPR decoration state tracking (prevents flicker) ─────
  let _appliedTaskLogins = new Map();   // login → task (currently rendered task badges)
  let _appliedUnprLogins = new Map();   // login → mins (currently rendered unpr badges)

  // Idempotent: only removes badges for logins no longer flagged, adds for new ones
  function applyUnprHighlightsFromCache() {
    if (!_unprFreshTs) { _fullClearUnprMarks(); return; }
    if (Date.now() - _unprFreshTs > UNPR_FRESH_MAX_MS) { _unprFreshTs = 0; _fullClearUnprMarks(); return; }

    const taskMap  = _unprStatus.taskMap  || {};
    const flagged  = _unprStatus.flagged  || {};
    const minsMap  = _unprStatus.mins     || {};

    // --- Task badges ---
    // Remove badges for logins no longer on a task
    for (const login of _appliedTaskLogins.keys()) {
      if (!taskMap[login]) {
        _clearTaskBadgeFor(login);
        _appliedTaskLogins.delete(login);
      }
    }
    // Add/update badges for logins on a task
    for (const [login, task] of Object.entries(taskMap)) {
      if (_appliedTaskLogins.get(login) !== task) {
        markTaskBadge(login, task);
        _appliedTaskLogins.set(login, task);
      }
    }

    // --- UNPR time badges ---
    for (const login of _appliedUnprLogins.keys()) {
      if (!flagged[login]) { _clearUnprBadgeFor(login); _appliedUnprLogins.delete(login); }
    }
    for (const login of Object.keys(flagged)) {
      const mins = minsMap[login] || '?';
      if (_appliedUnprLogins.get(login) !== mins) {
        markUnpr(login, mins);
        _appliedUnprLogins.set(login, mins);
      }
    }

    // Restore UPH for logins that just lost their task badge
    applyAllCachedBadges();
  }

  // Full clear — only called when data expires or UNPR is turned off
  function _fullClearUnprMarks() {
    _appliedTaskLogins.clear();
    _appliedUnprLogins.clear();
    clearUnprMarks();
  }
  function _clearTaskBadgeFor(login) {
    (mapPickListsUserCells().get(login) || []).forEach(td => td.querySelector('.plp-task-badge')?.remove());
    (mapLoginCells().get(login) || []).forEach(td => {
      const b = td.querySelector('.uph-badge'); if (b) { b.className = 'uph-badge'; }
    });
  }
  function _clearUnprBadgeFor(login) {
    (mapPickListsUserCells().get(login) || []).forEach(td => {
      td.querySelector('.plp-unpr-badge')?.remove();
      td.classList.remove('plp-unpr-cell');
    });
    (mapLoginCells().get(login) || []).forEach(td => td.querySelector('.uph-badge')?.classList.remove('unpr'));
  }

  // ─── Messaging from TRSL ──────────────────────────────────────
  function onIncoming(msg) {
    try {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'calcUPH:result' && msg.login) {
        const v = Number(msg.uph) || 0;
        const win = String(msg.window || msg.win || '');
        if (win && /^(?:4m|5m|10m)$/i.test(win)) notePickSignal(msg.login, v > 0);
        else if (msg.src === 'PLP_IDLE' || msg.req === 'idle') notePickSignal(msg.login, v > 0);
        if (v > 0) { setCacheKey(msg.login, v); updateLoginBadge(msg.login, 'calc60'); applyPickerETAs(); setTimeout(reapplyPersistentDecorations, 120); }
      }
      if (msg.type === 'overall:ready') { send({ type: 'overall:get' }); }
      if (msg.type === 'overall:map' && msg.data) {
        _overallInProgress = false; // overall cycle complete — idle probe can resume
        if (!_dataReceived) { _dataReceived = true; setTimeout(idleTick, 2000); }
        setCache(msg.data);
        applyOverallMap(msg.data);
        applyPickerETAs();
        if (typeof window.PLP_ETA_REFRESH === 'function') setTimeout(window.PLP_ETA_REFRESH, 60);
        setTimeout(reapplyPersistentDecorations, 150);
        setTimeout(reapplyPersistentDecorations, 900);
        setTimeout(reapplyPersistentDecorations, 2200);
      }
      // UNPR lastSaw map from TRSL — only marks appear after this message
      if (msg.type === 'unpr:map' && msg.data) { return; /* v2.1.28: UNPR removed */ }
    } catch (_) { }
  }
  if (chan) { chan.onmessage = (ev) => onIncoming(ev.data); }
  window.addEventListener('storage', (e) => { if (useLS && e.key === LS_KEY && e.newValue) { try { onIncoming(JSON.parse(e.newValue)); } catch (_) { } } });

  // ─── Click on login cell → calc60 ─────────────────────────────
  function ensureTip() { let tip = document.querySelector('.uph-tip'); if (!tip) { tip = document.createElement('div'); tip.className = 'uph-tip'; tip.style.display = 'none'; document.body.appendChild(tip); } return tip; }
  document.addEventListener('click', async (e) => {
    const td = e.target.closest && e.target.closest('td'); if (!td) return;
    const tr = td.parentElement; const tbl = tr?.closest('table'); if (!tbl) return;
    const hdr = tbl?.querySelector('tr'); if (!hdr) return;
    const ths = [...hdr.querySelectorAll('th')].map(h => norm(T(h)));
    const iUnits = ths.findIndex(k => k.startsWith('units')); const iUser = ths.findIndex(k => k.startsWith('user') || k.startsWith('login'));
    if (iUnits < 0 || iUser < 0) return; if (td.cellIndex !== iUser) return;
    const login = getPlainLoginFromCell(td); if (!login) return;
    const unitStr = T(tr.children[iUnits]); const m = unitStr.match(/(\d+)\s*\/\s*(\d+)/);
    const units = m ? parseInt(m[1], 10) : parseInt(unitStr.replace(/[^0-9]/g, ''), 10);
    if (!(units > 0)) return;
    const tip = ensureTip(); const rect = td.getBoundingClientRect();
    tip.innerHTML = `<b>${login}</b><br><span style='opacity:.7'>UPH (last 60m): calculating…</span>`;
    tip.style.display = 'block'; tip.style.left = (rect.right + 6 + window.scrollX) + 'px'; tip.style.top = (rect.top + window.scrollY) + 'px';
    // manual explicit per-login TRSL check (kept on click)
    askUPH(login);
    try { await navigator.clipboard.writeText(login); } catch (_) { try { const ta = document.createElement('textarea'); ta.value = login; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (__) { } }
    const t0 = Date.now();
    const poll = setInterval(() => {
      const val = Number(getCache()[login] || 0);
      if (val > 0 || Date.now() - t0 > 18000) {
        clearInterval(poll);
        tip.innerHTML = `<b>${login}</b><br>UPH (last 60m): <b>${val || 0}</b>`;
        setTimeout(() => { tip.style.display = 'none'; }, 1200);
        if (val > 0) { updateLoginBadge(login, 'calc60'); applyPickerETAs(); }
      }
    }, 400);
  }, true);

  // ─── Refresh ──────────────────────────────────────────────────
  function doRefresh(manual = false) {
    try {
      // Setting: when enabled, TRSL Overall refresh is allowed only from explicit Refresh UPH buttons.
      if (!manual && trslManualOnly()) {
        send({ type: 'overall:get' }); // read already-open TRSL report without clicking Overall Report
        setTimeout(reapplyPersistentDecorations, 250);
        return;
      }
      _overallInProgress = true; // block idleTick until overall:map comes back
      send({ type: 'overall:refresh' });
      setTimeout(reapplyPersistentDecorations, 400);
      setTimeout(reapplyPersistentDecorations, 1800);
      setTimeout(reapplyPersistentDecorations, 4500);
      setTimeout(reapplyPersistentDecorations, 8500);
      // Safety: clear flag after 45s in case overall:map never arrives
      setTimeout(() => { _overallInProgress = false; }, 45000);
    } catch (_) { }
  }

  // ─── Warm start ────────────────────────────────────────────────
  function warmStartUPH() {
    const restored = loadUPHCacheFromLS();
    if (restored) { applyAllCachedBadges(); applyPickerETAs(); setTimeout(reapplyPersistentDecorations, 200); }
    send({ type: 'overall:get' });
    if (!trslManualOnly()) { setTimeout(() => { send({ type: 'overall:refresh' }); }, restored ? 400 : 800); }
  }

  // ─── Settings modal (TT-style) ─────────────────────────────────
  function ensureSettings() {
    let bg = document.getElementById('plp-sett-bg'); if (bg) return bg;
    bg = document.createElement('div'); bg.id = 'plp-sett-bg';

    const box = document.createElement('div'); box.id = 'plp-sett-box';
    const head = document.createElement('div'); head.id = 'plp-sett-head';
    const title = document.createElement('div'); title.textContent = 'Settings';
    const close = document.createElement('div'); close.id = 'plp-sett-close'; close.textContent = '✖'; close.onclick = () => bg.style.display = 'none';
    head.appendChild(title); head.appendChild(close); box.appendChild(head);

    function section(label) {
      const d = document.createElement('div'); d.className = 'plp-sett-section'; d.textContent = label; box.appendChild(d);
    }
    function table(rows) {
      // rows: [{label, id, type, min, max, step, opts}]
      const tbl = document.createElement('table'); tbl.className = 'plp-sett-tbl';
      rows.forEach(row => {
        const tr = document.createElement('tr');
        const th = document.createElement('th'); th.textContent = row.label;
        const td = document.createElement('td');
        if (row.type === 'checkbox') {
          const inp = document.createElement('input'); inp.type = 'checkbox'; inp.id = row.id;
          td.appendChild(inp);
        } else if (row.type === 'radio') {
          row.opts.forEach(opt => {
            const inp = document.createElement('input'); inp.type = 'radio'; inp.name = row.name; inp.value = opt.value; inp.id = row.id + '_' + opt.value;
            const lbl = document.createElement('label'); lbl.htmlFor = inp.id; lbl.textContent = ' ' + opt.label; lbl.style.marginRight = '12px';
            td.appendChild(inp); td.appendChild(lbl);
          });
        } else {
          const inp = document.createElement('input'); inp.type = row.type || 'number'; inp.id = row.id;
          if (row.min !== undefined) inp.min = row.min; if (row.max !== undefined) inp.max = row.max;
          if (row.step !== undefined) inp.step = row.step; if (row.placeholder) inp.placeholder = row.placeholder;
          td.appendChild(inp);
        }
        tr.appendChild(th); tr.appendChild(td); tbl.appendChild(tr);
      });
      box.appendChild(tbl);
    }

    // ETA / UPH section
    section('UPH / ETA');
    table([
      { label: 'Auto refresh (on page load)', id: 'ps-auto', type: 'checkbox' },
      { label: 'TRSL refresh only by Refresh UPH', id: 'ps-trsl-manual', type: 'checkbox' },
      { label: 'ETA format', id: 'ps-fmt', type: 'radio', name: 'ps-fmt', opts: [{ value: 'duration', label: 'Duration (1h 20m)' }, { value: 'time', label: 'Finish time (≈ 14:35)' }] },
      { label: 'OSR min UPH', id: 'ps-osr-min', type: 'number', min: 1, max: 300, step: 1 },
      { label: 'OSR max UPH', id: 'ps-osr-max', type: 'number', min: 1, max: 500, step: 1 },
      { label: 'ETA safety factor ×', id: 'ps-sf', type: 'number', min: 1.0, max: 2.5, step: 0.05 },
      { label: 'OSR per-list overhead (min)', id: 'ps-oh', type: 'number', min: 0, max: 60, step: 0.5 },
      { label: 'Small list threshold (≤ units)', id: 'ps-small-thr', type: 'number', min: 0, max: 999, step: 1 },
      { label: 'Ignore small non-started lists', id: 'ps-ign-small', type: 'checkbox' },
      { label: 'Show SBD warnings', id: 'ps-sbd', type: 'checkbox' },
      { label: 'UPH trend threshold (Δ)', id: 'ps-trend-delta', type: 'number', min: 1, max: 50, step: 1 },
    ]);
    // v2.1.28: UNPR settings removed.
    // v2.1.28: Idle settings removed.

    // Fallback UPH section
    section('Fallback UPH (when no data)');
    table([
      { label: 'Fallback UPH — TCON/OSR', id: 'ps-fb-tcon', type: 'number', min: 10, max: 300, step: 5 },
      { label: 'Fallback UPH — SCON', id: 'ps-fb-scon', type: 'number', min: 10, max: 300, step: 5 },
      { label: 'Fallback UPH — ICON', id: 'ps-fb-icon', type: 'number', min: 10, max: 300, step: 5 },
      { label: 'Fallback UPH — BCON', id: 'ps-fb-bcon', type: 'number', min: 10, max: 300, step: 5 },
      { label: 'Fallback UPH — RCON', id: 'ps-fb-rcon', type: 'number', min: 10, max: 300, step: 5 },
    ]);

    const acts = document.createElement('div'); acts.className = 'plp-sett-actions';
    const cancel = document.createElement('button'); cancel.className = 'plp-btn'; cancel.textContent = 'CANCEL'; cancel.onclick = () => bg.style.display = 'none';
    const save = document.createElement('button'); save.className = 'plp-btn'; save.textContent = 'SAVE';
    save.onclick = () => {
      setSet(K.AUTO, document.getElementById('ps-auto').checked ? '1' : '0');
      setSet(K.TRSL_MANUAL_ONLY, document.getElementById('ps-trsl-manual').checked ? '1' : '0');
      const fmt = (document.querySelector('input[name="ps-fmt"]:checked') || { value: 'duration' }).value; setSet(K.ETA_FMT, fmt);
      setSet(K.OSR_MIN, String(Math.max(1, Number(document.getElementById('ps-osr-min').value) || Number(DEF[K.OSR_MIN]))));
      setSet(K.OSR_MAX, String(Math.max(1, Number(document.getElementById('ps-osr-max').value) || Number(DEF[K.OSR_MAX]))));
      setSet(K.ETA_SF, String(Math.max(1, Number(document.getElementById('ps-sf').value) || Number(DEF[K.ETA_SF]))));
      setSet(K.OSR_OH_MIN, String(Math.max(0, Number(document.getElementById('ps-oh').value) || Number(DEF[K.OSR_OH_MIN]))));
      setSet(K.SMALL_THR, String(Math.max(0, Number(document.getElementById('ps-small-thr').value) || Number(DEF[K.SMALL_THR]))));
      setSet(K.IGN_SMALL, document.getElementById('ps-ign-small').checked ? '1' : '0');
      setSet(K.S_WARN, document.getElementById('ps-sbd').checked ? '1' : '0');
      setSet(K.TREND_DELTA, String(Math.max(1, Number(document.getElementById('ps-trend-delta').value) || Number(DEF[K.TREND_DELTA]))));
      setSet(K.FB_TCON, String(Math.max(10, Number(document.getElementById('ps-fb-tcon').value) || Number(DEF[K.FB_TCON]))));
      setSet(K.FB_SCON, String(Math.max(10, Number(document.getElementById('ps-fb-scon').value) || Number(DEF[K.FB_SCON]))));
      setSet(K.FB_ICON, String(Math.max(10, Number(document.getElementById('ps-fb-icon').value) || Number(DEF[K.FB_ICON]))));
      setSet(K.FB_BCON, String(Math.max(10, Number(document.getElementById('ps-fb-bcon').value) || Number(DEF[K.FB_BCON]))));
      setSet(K.FB_RCON, String(Math.max(10, Number(document.getElementById('ps-fb-rcon').value) || Number(DEF[K.FB_RCON]))));
      bg.style.display = 'none';
      if (typeof window.PLP_ETA_REFRESH === 'function') window.PLP_ETA_REFRESH();
      applyAllCachedBadges(); applyPickerETAs();
    };
    acts.appendChild(cancel); acts.appendChild(save); box.appendChild(acts);
    bg.appendChild(box); document.body.appendChild(bg);
    return bg;
  }

  function openSettings() {
    const bg = ensureSettings(); bg.style.display = 'flex';
    document.getElementById('ps-auto').checked = (getSet(K.AUTO) === '1');
    document.getElementById('ps-trsl-manual').checked = (getSet(K.TRSL_MANUAL_ONLY) === '1');
    const fmt = getSet(K.ETA_FMT) || 'duration';
    const rf = document.querySelector(`input[name="ps-fmt"][value="${fmt}"]`) || document.querySelector('input[name="ps-fmt"][value="duration"]');
    if (rf) rf.checked = true;
    document.getElementById('ps-osr-min').value = getSet(K.OSR_MIN);
    document.getElementById('ps-osr-max').value = getSet(K.OSR_MAX);
    document.getElementById('ps-sf').value = getSet(K.ETA_SF);
    document.getElementById('ps-oh').value = getSet(K.OSR_OH_MIN);
    document.getElementById('ps-small-thr').value = getSet(K.SMALL_THR);
    document.getElementById('ps-ign-small').checked = (getSet(K.IGN_SMALL) === '1');
    document.getElementById('ps-sbd').checked = (getSet(K.S_WARN) === '1');
    document.getElementById('ps-trend-delta').value = getSet(K.TREND_DELTA);
    document.getElementById('ps-fb-tcon').value = getSet(K.FB_TCON);
    document.getElementById('ps-fb-scon').value = getSet(K.FB_SCON);
    document.getElementById('ps-fb-icon').value = getSet(K.FB_ICON);
    document.getElementById('ps-fb-bcon').value = getSet(K.FB_BCON);
    document.getElementById('ps-fb-rcon').value = getSet(K.FB_RCON);
  }

  // ─── Tabs buttons: Refresh UPH + ⚙️ ──────────────────────────
  function renderTabsButtons() {
    const tabs = document.querySelector('#plp_summary #tabs, #tabs'); if (!tabs) return false;
    const pickTab = tabs.querySelector('.tab_selector[data-target="pickLists"], .tab_selector[data-target="picklists" i]'); if (!pickTab) return false;
    if (document.getElementById('plp-tabs-actions')) return true;
    const wrap = document.createElement('span'); wrap.id = 'plp-tabs-actions'; wrap.className = 'plp-tabs-actions';
    const sep = document.createElement('span'); sep.className = 'plp-tabs-sep'; sep.textContent = '·';
    const btn = document.createElement('button'); btn.className = 'plp-btn'; btn.id = 'plp-refresh-uph-tab'; btn.textContent = '↻ Refresh UPH'; btn.onclick = () => doRefresh(true);
    const gear = document.createElement('span'); gear.className = 'plp-gear'; gear.textContent = '⚙️'; gear.title = 'Settings'; gear.onclick = () => openSettings();
    pickTab.insertAdjacentElement('afterend', wrap); wrap.appendChild(sep); wrap.appendChild(btn); wrap.appendChild(gear);
    return true;
  }
  (function attachTabsControls() {
    let tries = 0;
    const id = setInterval(() => { if (renderTabsButtons() || ++tries > 120) clearInterval(id); }, 300);
    const mo = new MutationObserver(() => { renderTabsButtons(); });
    mo.observe(document.body, { childList: true, subtree: true });
  })();

  // ─── Overview ETA ──────────────────────────────────────────────
  (function () {
    const $T = el => (el && (el.textContent || '').trim()) || '';
    const fmtDur = h => { if (!isFinite(h) || h <= 0) return '0m'; const m = Math.round(h * 60); return Math.floor(m / 60) ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m % 60}m`; };
    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
    const minUPH = () => Number(getSet(K.OSR_MIN) || DEF[K.OSR_MIN]);
    const maxUPH = () => Number(getSet(K.OSR_MAX) || DEF[K.OSR_MAX]);
    const safety = () => Number(getSet(K.ETA_SF) || DEF[K.ETA_SF]);
    const overheadMin = () => Number(getSet(K.OSR_OH_MIN) || DEF[K.OSR_OH_MIN]);
    function fbFor(prefix) { switch (prefix) { case 'TCON': return Number(getSet(K.FB_TCON) || DEF[K.FB_TCON]); case 'SCON': return Number(getSet(K.FB_SCON) || DEF[K.FB_SCON]); case 'ICON': return Number(getSet(K.FB_ICON) || DEF[K.FB_ICON]); case 'BCON': return Number(getSet(K.FB_BCON) || DEF[K.FB_BCON]); case 'RCON': return Number(getSet(K.FB_RCON) || DEF[K.FB_RCON]); default: return 95; } }
    function smallThr() { return Number(getSet(K.SMALL_THR) || DEF[K.SMALL_THR]); }
    function ignSmall() { return (getSet(K.IGN_SMALL) || '1') === '1'; }
    function etaFormat() { return getSet(K.ETA_FMT) || 'duration'; }
    function sbdWarnOn() { return (getSet(K.S_WARN) || '1') === '1'; }

    function getOverviewCtx() {
      const tab = document.querySelector('.tab[data-name="overview"]'); if (!tab) return null;
      const tbl = tab.querySelector('table'); if (!tbl) return null;
      const hdr = tbl.querySelector('tr'); if (!hdr) return null;
      const ths = [...hdr.querySelectorAll('th')].map(h => $T(h).toLowerCase());
      const iIdentifier = ths.indexOf('identifier'), iPending = ths.indexOf('pending units'), iPickers = ths.indexOf('pickers'), iSBD = ths.indexOf('nearest sbd'), iLists = ths.indexOf('lists');
      if (iIdentifier < 0 || iPending < 0) return null;
      return { tbl, iIdentifier, iPending, iPickers, iSBD, iLists };
    }
    function safePending(td) { const clone = td.cloneNode(true); const eta = clone.querySelector('.eta-wrap'); if (eta) eta.remove(); const s = $T(clone); const m = s.match(/\d+/); return m ? Number(m[0]) : 0; }
    function parseSBD(s) { const m = (s || '').match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}).*?(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (m) { const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3].length === 2 ? ('20' + m[3]) : m[3]), h = Number(m[4]), mi = Number(m[5]), se = Number(m[6] || 0); return new Date(y, mo - 1, d, h, mi, se); } const t = Date.parse(s); return isNaN(t) ? null : new Date(t); }
    function collectOSRLists(osrId) {
      const tbl = document.getElementById('pickLists_table'); if (!tbl) return [];
      const hdr = tbl.querySelector('tr'); if (!hdr) return [];
      const hs = [...hdr.querySelectorAll('th')].map(h => $T(h).toLowerCase());
      const iStream = hs.indexOf('stream'), iMaster = hs.indexOf('master wave'), iUnits = hs.findIndex(x => x.includes('units left')), iUser = hs.indexOf('user');
      if (iStream < 0 || iMaster < 0 || iUnits < 0 || iUser < 0) return [];
      const rows = [...tbl.querySelectorAll('tr')].slice(1); const out = [];
      rows.forEach(r => {
        const c = r.children; if (!c || c.length <= Math.max(iStream, iMaster, iUnits, iUser)) return;
        const streamPrefix = (c[iStream].querySelector('.prefix') ? $T(c[iStream].querySelector('.prefix')) : '').toUpperCase();
        if (streamPrefix !== 'TCON') return;
        const mw = $T(c[iMaster]).trim(); if (mw !== osrId) return;
        const unitsStr = $T(c[iUnits]); const m = unitsStr.match(/(\d+)\s*\/\s*(\d+)/);
        const units = m ? parseInt(m[1], 10) : parseInt(unitsStr.replace(/[^0-9]/g, ''), 10);
        const user = $T(c[iUser]); const started = (r.classList.contains('picklist_in_progress') || (!!user && user !== '-'));
        out.push({ unitsLeft: units || 0, started, user: user && user !== '-' ? sanitize(user) : null });
      });
      return out;
    }
    function etaListItem(list, cache, fb) { const u = Math.max(0, Number(list.unitsLeft) || 0); if (u === 0) return 0; let uph = 0; if (list.user) { const val = Number(cache[list.user] || 0); if (val > 0) uph = val; } if (uph <= 0) uph = fb; uph = clamp(uph, minUPH(), maxUPH()); let h = u / Math.max(1, uph); h += overheadMin() / 60; return h; }
    function stylePickersCells(ctx) { const { tbl, iPickers } = ctx; if (iPickers < 0) return; const rows = [...tbl.querySelectorAll('tr')].slice(1); rows.forEach(tr => { const td = tr.children[iPickers]; if (!td) return; td.classList.add('plp-pickers-click'); }); }

    function render() {
      const ctx = getOverviewCtx(); if (!ctx) return;
      const { tbl, iIdentifier, iPending, iPickers, iSBD, iLists } = ctx; stylePickersCells(ctx);
      const rows = [...tbl.querySelectorAll('tr')].slice(1);
      rows.forEach(tr => {
        const idTD = tr.children[iIdentifier]; const pendTD = tr.children[iPending]; if (!idTD || !pendTD) return;
        const idClone = idTD.cloneNode(true); const pref = idClone.querySelector('.prefix'); const prefix = pref ? $T(pref).toUpperCase() : ''; if (pref) pref.remove();
        const tail = $T(idClone).trim(); const pending = safePending(pendTD);
        const pickers = (iPickers >= 0 && tr.children[iPickers]) ? Number(($T(tr.children[iPickers]).match(/\d+/) || [0])[0]) : 0;
        const sbdText = (iSBD >= 0 && tr.children[iSBD]) ? $T(tr.children[iSBD]) : ''; const sbd = parseSBD(sbdText);
        const listsCount = (iLists >= 0 && tr.children[iLists]) ? Number(($T(tr.children[iLists]).match(/\d+/) || [0])[0]) : 0;
        let cls = 'eta-badge'; let text = 'ETA n/a'; let tip = '';
        const cache = getCache(); const mUPH = minUPH(), MUPH = maxUPH(), SF = safety(), OH = overheadMin();
        if (prefix === 'TCON') {
          const lists = collectOSRLists(tail); const fb = fbFor('TCON'); const thr = smallThr(); const ignoreSmall = ignSmall(); let candidates = [];
          if (lists.length > 0) { if (ignoreSmall) { candidates = lists.filter(L => (L.unitsLeft || 0) > thr || ((L.unitsLeft || 0) <= thr && L.started)); } else { candidates = lists.slice(); } }
          let etaHrs = null;
          if (candidates.length > 0) { etaHrs = Math.max(...candidates.map(L => etaListItem(L, cache, fb))); }
          else if (lists.length > 0) { etaHrs = Math.max(...lists.map(L => etaListItem(L, cache, fb))); }
          else { const keys = Object.keys(cache); const avgUPH = keys.length ? (keys.map(k => Number(cache[k]) || 0).filter(v => v > 0).reduce((a, b) => a + b, 0) / keys.length) : 0; let effUPH = (avgUPH > 0 ? avgUPH : fb); effUPH = clamp(effUPH, mUPH, MUPH); if (pending === 0) { cls = 'eta-badge'; text = 'ETA 0m'; } else if (pickers > 0) { let base = pending / (pickers * Math.max(1, effUPH)); base += (listsCount > 0 ? (listsCount * OH / 60) : 0); etaHrs = base; } }
          if (etaHrs != null) {
            etaHrs *= SF;
            if (sbd && sbdWarnOn()) { const finish = new Date(Date.now() + etaHrs * 3600 * 1000); const gapH = (sbd - finish) / 3600000; if (gapH < 0) cls += ' err'; else if (gapH <= 1) cls += ' warn'; }
            if (!/warn|err/.test(cls)) { if (etaHrs > 6) cls += ' err'; else if (etaHrs > 3) cls += ' warn'; }
            text = (etaFormat() === 'time') ? `≈ ${new Date(Date.now() + etaHrs * 3600 * 1000).toLocaleTimeString()}` : `ETA ${fmtDur(etaHrs)}`;
            tip = `CLAMP ${mUPH}-${MUPH} +OH ${OH}m ×SF ${SF}`;
          }
        } else {
          const fb = fbFor(prefix); const keys = Object.keys(cache); const avgUPH = keys.length ? (keys.map(k => Number(cache[k]) || 0).filter(v => v > 0).reduce((a, b) => a + b, 0) / keys.length) : 0;
          let effUPH = (avgUPH > 0 ? avgUPH : fb); effUPH = clamp(effUPH, mUPH, MUPH);
          if (pending === 0) { cls = 'eta-badge'; text = 'ETA 0m'; }
          else if (pickers > 0) {
            let hrs = pending / (pickers * Math.max(1, effUPH)); if (listsCount > 0) hrs += (listsCount * OH / 60); hrs *= SF;
            if (sbd && sbdWarnOn()) { const finish = new Date(Date.now() + hrs * 3600 * 1000); const gapH = (sbd - finish) / 3600000; if (gapH < 0) cls += ' err'; else if (hrs > 3) cls += ' warn'; }
            if (!/warn|err/.test(cls)) { if (hrs > 6) cls += ' err'; else if (hrs > 3) cls += ' warn'; }
            text = (etaFormat() === 'time') ? `≈ ${new Date(Date.now() + hrs * 3600 * 1000).toLocaleTimeString()}` : `ETA ${fmtDur(hrs)}`;
            tip = `CLAMP ${mUPH}-${MUPH} +OH ${OH}m ×SF ${SF}`;
          } else { cls = 'eta-badge warn'; text = 'ETA n/a'; }
        }
        let wrap = pendTD.querySelector('.eta-wrap'); if (!wrap) { wrap = document.createElement('div'); wrap.className = 'eta-wrap'; pendTD.appendChild(wrap); }
        let b = wrap.querySelector('.eta-badge'); if (!b) { b = document.createElement('span'); b.className = 'eta-badge'; wrap.appendChild(b); }
        b.className = cls; b.textContent = text; if (tip) b.title = tip; else b.removeAttribute('title');
      });
    }

    function attach() {
      const tab = document.querySelector('.tab[data-name="overview"]'); if (!tab) return false;
      const mo = new MutationObserver(() => { clearTimeout(attach._t); attach._t = setTimeout(render, 150); });
      mo.observe(tab, { childList: true, subtree: true }); render(); return true;
    }
    let tries = 0; const id = setInterval(() => { if (attach() || ++tries > 200) clearInterval(id); }, 250);
    window.PLP_ETA_REFRESH = render;
  })();

  // ─── Mini modal (Pickers list from Overview) ──────────────────
  (function () {
    const $T = el => (el && (el.textContent || '').trim()) || '';
    const $norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const $san = s => (s || '').trim().toUpperCase();
    function ensureMiniModal() {
      let bg = document.getElementById('plp-mini-bg'); if (bg) return bg;
      bg = document.createElement('div'); bg.id = 'plp-mini-bg';
      const box = document.createElement('div'); box.id = 'plp-mini-box';
      const close = document.createElement('div'); close.id = 'plp-mini-close'; close.textContent = '✖'; close.addEventListener('click', () => { bg.style.display = 'none'; });
      const content = document.createElement('div'); content.id = 'plp-mini-content';
      box.appendChild(close); box.appendChild(content); bg.appendChild(box); document.body.appendChild(bg);
      box.addEventListener('click', ev => ev.stopPropagation()); bg.addEventListener('click', () => { bg.style.display = 'none'; });
      return bg;
    }
    function openMiniModal(html) { const bg = ensureMiniModal(); document.getElementById('plp-mini-content').innerHTML = html; bg.style.display = 'block'; }
    function getPlainUser(td) { const clone = td.cloneNode(true); clone.querySelectorAll('.uph-badge,.plp-idle-badge,.plp-unpr-badge,.plp-task-badge').forEach(x => x.remove()); return $T(clone); }
    document.addEventListener('click', (e) => {
      const td = e.target.closest && e.target.closest('td'); if (!td) return;
      const tr = td.parentElement; const tbl = tr?.closest('table'); if (!tbl) return;
      const inOverview = !!tbl.closest('.tab[data-name="overview"]'); if (!inOverview) return;
      const hdr = tbl.querySelector('tr'); if (!hdr) return;
      const headers = [...hdr.querySelectorAll('th')].map(h => $norm($T(h)));
      const iPickers = headers.indexOf('pickers'), iIdentifier = headers.indexOf('identifier');
      if (iPickers < 0 || iIdentifier < 0) return; if (td.cellIndex !== iPickers) return;
      e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
      const identTd = tr.children[iIdentifier]; const prefixEl = identTd.querySelector('.prefix'); const prefix = (prefixEl ? $T(prefixEl) : '').toUpperCase(); const identTail = $T(identTd).replace(prefix, '').trim();
      const pickTable = document.getElementById('pickLists_table');
      if (!pickTable) { openMiniModal('<div style="padding:8px 4px;">Pick lists are not ready yet.</div>'); return; }
      const rows = [...pickTable.querySelectorAll('tr')].slice(1); const bag = [];
      rows.forEach(r => {
        const c = r.children; if (!c || c.length < 11) return;
        const streamPrefix = (c[0].querySelector('.prefix') ? $T(c[0].querySelector('.prefix')) : '').toUpperCase();
        const masterWave = $T(c[1]); const user = getPlainUser(c[10]);
        if (!user || user === '-') return;
        if (prefix === 'TCON') { if (masterWave === identTail) bag.push($san(user) + ';'); }
        else { if (streamPrefix === prefix) bag.push($san(user) + ';'); }
      });
      const uniq = [...new Set(bag)]; const textBlock = uniq.join('\n');
      const headerLabel = (prefix === 'TCON') ? `${prefix} ${identTail}` : prefix;
      const html = `
        <div style="font-weight:600;margin:0 24px 8px 0;">${headerLabel} — PICKERS (${uniq.length})</div>
        <div style="display:flex;gap:10px;">
          <textarea id="plp-mini-text" style="flex:1;min-height:240px;font-family:monospace;font-size:12px;padding:8px;border:1px solid #d0d7de;background:#fff;color:#000;">${textBlock}</textarea>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button id="plp-mini-copy" style="padding:6px 10px;">COPY</button>
          </div>
        </div>
        ${uniq.length ? '' : '<i>No active pickers</i>'}
      `;
      openMiniModal(html);
      setTimeout(() => {
        const ta = document.getElementById('plp-mini-text'); const btn = document.getElementById('plp-mini-copy');
        if (btn && ta) {
          btn.addEventListener('click', async ev => {
            ev.stopPropagation(); ev.preventDefault();
            try { ta.select(); document.execCommand('copy'); } catch (_) { try { await navigator.clipboard.writeText(ta.value); } catch (__) { } }
            btn.textContent = 'COPIED'; setTimeout(() => btn.textContent = 'COPY', 1200);
          });
        }
      }, 0);
    }, true);
  })();

  // ─── Summary Filter Panel (Super Odhaczacz 3000+) ─────────────
  (function () {
    const HOLD_MS = 350;
    const OSR_IDLE_HIDE_MS = 3000;
    let _osrSideSig = '';
    let _osrHideTimer = null;
    let _osrHiddenByIdle = false;

    const STREAM_GROUPS = {
      TCON: { label: 'T',  title: 'TCON/OSR: hover = show OSR, click = toggle, hold/dblclick = only TCON', prefixes: () => [...document.querySelectorAll('.show_prefix[data-prefix^="OSR"]')].map(x => x.dataset.prefix).filter(Boolean), color: '#B10252' },
      SCON: { label: 'S',  title: 'SCON: click = toggle, hold/dblclick = only SCON', prefixes: () => ['SCON'], color: 'green' },
      ICON: { label: 'I',  title: 'ICON: click = toggle, hold/dblclick = only ICON', prefixes: () => ['ICON'], color: 'Blue' },
      PCON: { label: 'P*', title: 'PCON + CCON: click = toggle, hold/dblclick = only PCON/CCON', prefixes: () => ['PCON', 'CCON'], color: '#E033FF' },
      BPRE: { label: 'B/P', title: 'B2B + PRE-RELO: click = toggle, hold/dblclick = only BCON/RCON', prefixes: () => ['BCON', 'RCON'], color: 'linear-gradient(135deg,#0ea9bb 0 50%,#5F5D9C 50% 100%)' },
    };

    const getBoxes = () => [...document.querySelectorAll('.show_prefix')];
    const getBox = prefix => document.querySelector('.show_prefix[data-prefix="' + prefix + '"]');
    const getPrefixesFor = key => (STREAM_GROUPS[key] ? STREAM_GROUPS[key].prefixes().filter(Boolean) : [key]);

    function setCheckbox(cb, should) {
      if (!cb) return;
      if (cb.checked !== should) {
        cb.checked = should;
        cb.dispatchEvent(new Event('click', { bubbles: true }));
      }
    }
    function isGroupActive(key) {
      const prefixes = new Set(getPrefixesFor(key));
      if (!prefixes.size) return false;
      return getBoxes().some(cb => prefixes.has(cb.dataset.prefix) && cb.checked);
    }
    function anyGroupVisible(key) {
      const prefixes = new Set(getPrefixesFor(key));
      return getBoxes().some(cb => prefixes.has(cb.dataset.prefix));
    }
    function paintButton(el, active) {
      const cfg = STREAM_GROUPS[el.dataset.streamKey]; if (!cfg) return;
      if (active) {
        el.style.background = cfg.color;
        el.style.color = '#fff';
        el.style.borderColor = '#222';
        el.style.boxShadow = '0 0 0 2px rgba(0,0,0,.10), 0 2px 8px rgba(0,0,0,.25)';
        el.style.transform = 'translateY(-1px)';
      } else {
        el.style.background = '#fff';
        el.style.color = '#111';
        el.style.borderColor = '#bbb';
        el.style.boxShadow = '0 2px 6px rgba(0,0,0,.15)';
        el.style.transform = '';
      }
      el.style.opacity = anyGroupVisible(el.dataset.streamKey) ? '1' : '.45';
    }
    function setOnly(prefixes) {
      const set = new Set(prefixes || []);
      getBoxes().forEach(cb => setCheckbox(cb, set.has(cb.dataset.prefix)));
      _osrSideSig = '';
      setTimeout(syncButtonColors, 30);
    }
    function addOnly(prefixes) {
      const set = new Set(prefixes || []);
      getBoxes().forEach(cb => { if (set.has(cb.dataset.prefix)) setCheckbox(cb, true); });
      _osrSideSig = '';
      setTimeout(syncButtonColors, 30);
    }
    function removeOnly(prefixes) {
      const set = new Set(prefixes || []);
      getBoxes().forEach(cb => { if (set.has(cb.dataset.prefix)) setCheckbox(cb, false); });
      _osrSideSig = '';
      setTimeout(syncButtonColors, 30);
    }
    function toggleGroup(key) {
      const p = getPrefixesFor(key); if (!p.length) return;
      isGroupActive(key) ? removeOnly(p) : addOnly(p);
    }
    function clearAll() { setOnly([]); }

    function osrShort(prefix) {
      const s = String(prefix || '').toUpperCase();
      const m = s.match(/^(OSR).*?(\d{3})$/);
      if (m) return m[1] + m[2];
      return s.startsWith('OSR') && s.length > 6 ? 'OSR' + s.slice(-3) : s;
    }
    function getOsrPrefixes() {
      // Same order as Summary rows, therefore same priority order.
      return [...document.querySelectorAll('.show_prefix[data-prefix^="OSR"]')].map(x => x.dataset.prefix).filter(Boolean);
    }
    function getOsrSummaryColor(prefix) {
      try {
        const cb = getBox(prefix);
        const row = cb ? cb.closest('tr') : null;
        const badge = row ? row.querySelector('.prefix') : null;
        if (badge) {
          const inline = (badge.getAttribute('style') || '').match(/background(?:-color)?\s*:\s*([^;]+)/i);
          if (inline && inline[1]) return inline[1].trim();
          const c = getComputedStyle(badge).backgroundColor;
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        }
      } catch (_) { }
      const palette = ['#B10252', '#D2691E', 'black', '#888'];
      const idx = Math.max(0, getOsrPrefixes().indexOf(prefix));
      return palette[Math.min(idx, palette.length - 1)];
    }
    function contrastColor(bg) {
      const s = String(bg || '').trim().toLowerCase();
      if (s === 'black' || s === '#000' || s === '#000000') return '#fff';
      const hex = s.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        const n = parseInt(hex[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return ((r * 299 + g * 587 + b * 114) / 1000) > 150 ? '#111' : '#fff';
      }
      const rgb = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (rgb) {
        const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
        return ((r * 299 + g * 587 + b * 114) / 1000) > 150 ? '#111' : '#fff';
      }
      return '#fff';
    }
    function ensureOsrSidePanel() {
      let panel = document.getElementById('plp-osr-side-panel');
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = 'plp-osr-side-panel';
      panel.style.cssText = 'position:fixed;left:76px;top:300px;z-index:999999;display:none;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;overflow-x:hidden;padding:2px;';
      ['mousemove', 'pointermove', 'mouseenter', 'click', 'wheel', 'touchstart'].forEach(ev => panel.addEventListener(ev, bumpOsrActivity, { passive: true }));
      document.body.appendChild(panel);
      return panel;
    }
    function hideOsrSidePanel() {
      const panel = document.getElementById('plp-osr-side-panel');
      if (!panel) return;
      panel.style.display = 'none';
      _osrHiddenByIdle = true;
      if (_osrHideTimer) clearTimeout(_osrHideTimer);
      _osrHideTimer = null;
    }
    function bumpOsrActivity() {
      _osrHiddenByIdle = false;
      if (_osrHideTimer) clearTimeout(_osrHideTimer);
      _osrHideTimer = setTimeout(hideOsrSidePanel, OSR_IDLE_HIDE_MS);
    }
    function showOsrPanelByT() {
      _osrHiddenByIdle = false;
      _osrSideSig = '';
      renderOsrSidePanel(true);
    }
    function renderOsrSidePanel(forceShow = false) {
      const panel = ensureOsrSidePanel();
      const osrs = getOsrPrefixes();
      const shouldShow = !!(forceShow || (!_osrHiddenByIdle && isGroupActive('TCON') && osrs.length));
      const sig = shouldShow ? osrs.map(p => p + ':' + (getBox(p)?.checked ? '1' : '0') + ':' + getOsrSummaryColor(p)).join('|') : 'hidden';
      if (_osrSideSig === sig && ((panel.style.display !== 'none') === shouldShow)) return;
      _osrSideSig = sig;
      if (!shouldShow || !osrs.length) {
        if (panel.style.display !== 'none') panel.style.display = 'none';
        if (panel.innerHTML) panel.innerHTML = '';
        return;
      }
      panel.style.display = 'flex';
      panel.innerHTML = '';
      osrs.forEach(prefix => {
        const active = !!getBox(prefix)?.checked;
        const summaryColor = getOsrSummaryColor(prefix);
        const b = document.createElement('div');
        b.className = 'plp-check-btn plp-osr-mini-btn';
        b.dataset.osrPrefix = prefix;
        b.textContent = osrShort(prefix);
        b.title = prefix + ': click = toggle, hold/dblclick = only this OSR';
        b.style.width = '58px';
        b.style.height = '26px';
        b.style.fontSize = '11px';
        b.style.borderColor = summaryColor;
        b.style.background = active ? summaryColor : '#fff';
        b.style.color = active ? contrastColor(summaryColor) : '#111';
        b.style.boxShadow = active ? '0 0 0 2px rgba(0,0,0,.10), 0 2px 8px rgba(0,0,0,.25)' : '0 2px 6px rgba(0,0,0,.15)';

        let timer = null, longFired = false, clickTimer = null;
        const startHold = ev => {
          bumpOsrActivity();
          longFired = false; b.classList.add('holding'); if (timer) clearTimeout(timer);
          timer = setTimeout(() => { longFired = true; b.classList.remove('holding'); setOnly([prefix]); }, HOLD_MS);
          if (ev && ev.type === 'touchstart') { try { ev.preventDefault(); } catch (_) { } }
        };
        const cancelHold = () => { if (timer) clearTimeout(timer); timer = null; b.classList.remove('holding'); };
        b.addEventListener('mousedown', startHold); b.addEventListener('touchstart', startHold, { passive:false });
        b.addEventListener('mouseup', cancelHold); b.addEventListener('mouseleave', cancelHold); b.addEventListener('touchend', cancelHold); b.addEventListener('touchcancel', cancelHold);
        b.addEventListener('click', ev => {
          bumpOsrActivity();
          if (longFired) { longFired = false; try { ev.preventDefault(); ev.stopPropagation(); } catch (_) { } return; }
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
          clickTimer = setTimeout(() => { clickTimer = null; const cb = getBox(prefix); if (cb) setCheckbox(cb, !cb.checked); _osrSideSig = ''; setTimeout(syncButtonColors, 30); }, 230);
        }, true);
        b.addEventListener('dblclick', ev => { bumpOsrActivity(); try { ev.preventDefault(); ev.stopPropagation(); } catch (_) { } if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } setOnly([prefix]); }, true);
        panel.appendChild(b);
      });
      bumpOsrActivity();
    }
    function syncButtonColors() {
      document.querySelectorAll('#plp-check-panel .plp-check-btn[data-stream-key]').forEach(btn => paintButton(btn, isGroupActive(btn.dataset.streamKey)));
      renderOsrSidePanel(false);
    }

    function dualBtn(key) {
      const cfg = STREAM_GROUPS[key];
      const el = document.createElement('div');
      el.className = 'plp-check-btn';
      el.dataset.streamKey = key;
      el.textContent = cfg.label;
      el.title = cfg.title;
      let timer = null, longFired = false, clickTimer = null;

      if (key === 'TCON') {
        // Hover on T shows the OSR side panel immediately; auto-hide still works after 3s of no movement.
        el.addEventListener('mouseenter', showOsrPanelByT, true);
        el.addEventListener('mousemove', () => { if (document.getElementById('plp-osr-side-panel')?.style.display !== 'none') bumpOsrActivity(); }, true);
        el.addEventListener('pointerenter', showOsrPanelByT, true);
      }

      const startHold = ev => {
        if (key === 'TCON') bumpOsrActivity();
        longFired = false; el.classList.add('holding'); if (timer) clearTimeout(timer);
        timer = setTimeout(() => { longFired = true; el.classList.remove('holding'); setOnly(getPrefixesFor(key)); if (key === 'TCON') showOsrPanelByT(); }, HOLD_MS);
        if (ev && ev.type === 'touchstart') { try { ev.preventDefault(); } catch (_) { } }
      };
      const cancelHold = () => { if (timer) clearTimeout(timer); timer = null; el.classList.remove('holding'); };
      el.addEventListener('mousedown', startHold); el.addEventListener('touchstart', startHold, { passive:false });
      el.addEventListener('mouseup', cancelHold); el.addEventListener('mouseleave', cancelHold); el.addEventListener('touchend', cancelHold); el.addEventListener('touchcancel', cancelHold);
      el.addEventListener('click', ev => {
        if (key === 'TCON') bumpOsrActivity();
        if (longFired) { longFired = false; try { ev.preventDefault(); ev.stopPropagation(); } catch (_) { } return; }
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => { clickTimer = null; toggleGroup(key); if (key === 'TCON') showOsrPanelByT(); }, 230);
      }, true);
      el.addEventListener('dblclick', ev => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) { }
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        setOnly(getPrefixesFor(key));
        if (key === 'TCON') showOsrPanelByT();
      }, true);
      return el;
    }
    function simpleBtn(label, tip, fn) {
      const el = document.createElement('div'); el.className = 'plp-check-btn'; el.textContent = label; el.title = tip;
      el.addEventListener('click', ev => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) { } fn(); }, true);
      return el;
    }
    function createPanel() {
      if (document.getElementById('plp-check-panel')) { syncButtonColors(); return; }
      const panel = document.createElement('div'); panel.id = 'plp-check-panel';
      panel.appendChild(simpleBtn('×', 'Super Odhaczacz 3000+ — clear all', clearAll));
      panel.appendChild(dualBtn('TCON'));
      panel.appendChild(dualBtn('SCON'));
      panel.appendChild(dualBtn('ICON'));
      panel.appendChild(dualBtn('PCON'));
      panel.appendChild(dualBtn('BPRE'));
      const refreshBtn = document.createElement('div');
      refreshBtn.className = 'plp-check-btn'; refreshBtn.id = 'plp-refresh-check-btn';
      refreshBtn.textContent = '↻'; refreshBtn.title = 'Refresh UPH'; refreshBtn.addEventListener('click', () => doRefresh(true), true);
      panel.appendChild(refreshBtn);
      document.body.appendChild(panel);
      ensureOsrSidePanel();
      syncButtonColors();
    }
    document.addEventListener('click', ev => { if (ev.target?.classList?.contains('show_prefix')) { _osrSideSig = ''; setTimeout(syncButtonColors, 30); } }, true);
    const mo = new MutationObserver(mutations => {
      const onlyOwn = mutations.length > 0 && mutations.every(m => {
        const t = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
        return !!(t?.closest?.('#plp-check-panel,#plp-osr-side-panel'));
      });
      if (onlyOwn) return;
      if (document.querySelector('.show_prefix')) { createPanel(); syncButtonColors(); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  })();

  // ─── Boot ──────────────────────────────────────────────────────
  window.PLP_DIAG = function () {
 const cache = getCache();
 return {
  version: '2.1.30-remote',
  refreshMode: trslManualOnly() ? 'manual-refresh-uph-only' : 'overall-auto-refresh-enabled',
  perLoginAutoChecks: false,
  autoPersonalTRSLChecks: false,
  idleProbeAutoDisabled: true,
  manualLoginClickChecksOnly: true,
  trslRefreshManualOnly: trslManualOnly(),
  unprFreshTs: _unprFreshTs,
  unprLastSawCount: Object.keys(_unprLastSaw || {}).length,
  taskMapCount: _unprNonActive instanceof Map ? _unprNonActive.size : 0,
  taskSample: _unprNonActive instanceof Map ? Object.fromEntries([..._unprNonActive.entries()].slice(0, 8)) : {},
  cache: { size: Object.keys(cache).length, sample: Object.fromEntries(Object.entries(cache).slice(0, 8)) }
 };
};

  (async function init() {
    const ok = await waitFor(() => !!document.body, { timeout: 20000 }); if (!ok) return;
    warmStartUPH();
    if (getSet(K.AUTO) === '1') { setTimeout(() => doRefresh(false), 3000); }
  })();

})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 4 – TOTES IN TRANSIT (docked in PLP)                ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  if (window.__TT_TOTES_INIT__) return;
  window.__TT_TOTES_INIT__ = true;

  var BASE = ['MULT', 'SING', 'ITM', 'B2B', 'PRE'];
  var DEFAULT_CFG = { showAll: false, showMin: { MULT: 20, SING: 20, ITM: 20, B2B: 20, PRE: 20 }, criticalMin: { MULT: 60, SING: 60, ITM: 60, B2B: 60, PRE: 60 } };
  var SQL_REFRESH_SEC = 280, TICK_MS = 5000;
  var LS_CFG = 'TT_CFG_V10', LS_CACHE = 'TT_CACHE_V10';
  var __inflight = false, __abort = null, __lastUiTs = 0, lastSQL = 0;

  function loadJSON(k, fb) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  function normalizeCfg(saved) {
    saved = saved || {};
    var out = { showAll: !!saved.showAll, showMin: {}, criticalMin: {} }, p;
    for (p in DEFAULT_CFG.showMin) out.showMin[p] = DEFAULT_CFG.showMin[p];
    for (p in DEFAULT_CFG.criticalMin) out.criticalMin[p] = DEFAULT_CFG.criticalMin[p];
    if (saved.showMin) { for (p in saved.showMin) out.showMin[String(p).toUpperCase()] = Number(saved.showMin[p]); }
    if (saved.criticalMin) { for (p in saved.criticalMin) out.criticalMin[String(p).toUpperCase()] = Number(saved.criticalMin[p]); }
    for (var i = 0; i < BASE.length; i++) {
      var k = BASE[i];
      if (!(out.showMin[k] >= 0)) out.showMin[k] = DEFAULT_CFG.showMin[k];
      if (!(out.criticalMin[k] >= 0)) out.criticalMin[k] = DEFAULT_CFG.criticalMin[k];
      if (!(out.criticalMin[k] >= 0)) out.criticalMin[k] = out.showMin[k] + 40;
    }
    for (p in out.showMin) { if (!(out.criticalMin[p] >= 0)) out.criticalMin[p] = out.showMin[p] + 40; }
    return out;
  }
  var cfg = normalizeCfg(loadJSON(LS_CFG, DEFAULT_CFG));
  saveJSON(LS_CFG, cfg);
  var cache = loadJSON(LS_CACHE, { ts: 0, dataFull: null, dataFiltered: [], stats: null, lastSource: 'cache', meta: null });

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) { s = (s == null ? '' : String(s)); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtTS(ts) { if (!ts) return '—'; var d = new Date(ts); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function prepareDateLikeChaseTool(time) { var offset = (new Date()).getTimezoneOffset() * 60 * 1000; var t = (typeof time === 'number') ? time : Date.parse(time); return new Date(t + offset); }
  function ageMinFromOldest(dstamp) { var now = Date.now(); var d = prepareDateLikeChaseTool(dstamp).getTime(); return Math.round(Math.abs(d - now) / 60000); }
  function ageShortFromMinutes(mins) { mins = Number(mins) || 0; if (mins >= 1440) { var days = Math.floor(mins / 1440), hrs = Math.floor((mins % 1440) / 60); return days + 'd ' + hrs + 'h'; } if (mins >= 60) { var h = Math.floor(mins / 60), m = mins % 60; return h + 'h ' + m + 'm'; } return mins + 'm'; }
  function wgPrefix(workGroup) { var s = (workGroup == null ? '' : String(workGroup)).trim().toUpperCase(); if (!s) return ''; if (s.indexOf('MULT') === 0 || s.indexOf('MUL') === 0) return 'MULT'; if (s.indexOf('SING') === 0 || s.indexOf('SIN') === 0) return 'SING'; if (s.indexOf('ITM') === 0 || s.indexOf('ITEM') === 0) return 'ITM'; if (s.indexOf('B2B') === 0) return 'B2B'; if (s.indexOf('PRE') === 0) return 'PRE'; var out = ''; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 65 && c <= 90) out += s.charAt(i); else break; } return out || s; }
  function fmtSBDShort(ts) { if (!ts) return '—'; var d = prepareDateLikeChaseTool(ts); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function extraKeys() { var keys = []; for (var k in cfg.showMin) { k = String(k).toUpperCase(); var isBase = false; for (var i = 0; i < BASE.length; i++) { if (BASE[i] === k) { isBase = true; break; } } if (!isBase) keys.push(k); } keys.sort(); return keys; }

  function detectDS() { try { var ds = (window.grafanaBootData && window.grafanaBootData.settings && window.grafanaBootData.settings.datasources) || {}; for (var name in ds) { if (ds[name] && ds[name].type === 'postgres') { return { uid: ds[name].uid, id: ds[name].id }; } } } catch (e) { } return { uid: 'mFpJIAhVk', id: 108 }; }
  var DS = detectDS();

  async function grafanaQuery(sql) {
    if (__abort) { try { __abort.abort(); } catch (_) { } }
    __abort = new AbortController();
    var api = (window.origin || location.origin) + '/api/ds/query';
    var sd = new Date(), ed = new Date();
    var payload = { queries: [{ refId: 'A', datasource: { uid: DS.uid, type: 'postgres' }, rawSql: String(sql), format: 'table', datasourceId: DS.id, intervalMs: 60000, maxDataPoints: 1447 }], range: { from: sd.toISOString(), to: ed.toISOString(), raw: { from: sd.toISOString(), to: ed.toISOString() } }, from: String(sd.getTime()), to: String(ed.getTime()) };
    var res = await fetch(api, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-grafana-org-id': '1', 'accept': 'application/json, text/plain, */*' }, body: JSON.stringify(payload), signal: __abort.signal });
    if (!res.ok) { var txt = ''; try { txt = await res.text(); } catch (_2) { } throw new Error('Grafana query failed: ' + res.status + '. ' + (txt || '').slice(0, 250)); }
    return res.json();
  }

  function retrieveData(raw) { var frame = raw && raw.results && raw.results.A && raw.results.A.frames && raw.results.A.frames[0]; if (!frame) return []; var values = frame.data && frame.data.values; var fields = frame.schema && frame.schema.fields; if (!values || !fields) return []; var rowsCount = (values[0] && values[0].length) || 0, colsCount = values.length, data = []; for (var r = 0; r < rowsCount; r++) { var obj = {}; for (var c = 0; c < colsCount; c++) { obj[fields[c] && fields[c].name] = values[c][r]; } data.push(obj); } return data; }

  var __schemaMeta = null;
  async function discoverSchemaMeta() {
    if (__schemaMeta) return __schemaMeta;
    var sql = "SELECT table_schema, table_name FROM information_schema.tables WHERE lower(table_name) IN ('move_task','order_header','inventory_transaction')";
    var raw = await grafanaQuery(sql); var rows = retrieveData(raw); if (!rows || !rows.length) return null;
    var by = {};
    for (var i = 0; i < rows.length; i++) { var s = String(rows[i].table_schema || '').trim(), t = String(rows[i].table_name || '').trim(); if (!s || !t) continue; if (!by[s]) by[s] = new Set(); by[s].add(t); }
    function has(set, name) { for (var v of set) { if (String(v).toUpperCase() === name) return true; } return false; }
    var chosen = null;
    for (var s in by) { if (has(by[s], 'MOVE_TASK') && has(by[s], 'ORDER_HEADER') && has(by[s], 'INVENTORY_TRANSACTION')) { chosen = s; break; } }
    if (!chosen) { for (var s2 in by) { if (has(by[s2], 'MOVE_TASK')) { chosen = s2; break; } } }
    if (!chosen) return null;
    var MT = null, OH = null, IVT = null;
    for (var j = 0; j < rows.length; j++) { if (String(rows[j].table_schema || '').trim() !== chosen) continue; var tn = String(rows[j].table_name || '').trim(), up = tn.toUpperCase(); if (up === 'MOVE_TASK') MT = tn; if (up === 'ORDER_HEADER') OH = tn; if (up === 'INVENTORY_TRANSACTION') IVT = tn; }
    if (!MT || !OH || !IVT) return null;
    __schemaMeta = { schema: chosen, MT, OH, IVT }; return __schemaMeta;
  }

  function buildSQL(meta) {
    const SCH = `"${meta.schema}"`, MT = `${SCH}."${meta.MT}"`, OH = `${SCH}."${meta.OH}"`, IVT = `${SCH}."${meta.IVT}"`;
    return `WITH mt_transit AS (SELECT mt."CONTAINER_ID",mt."WORK_GROUP",mt."DSTAMP" AS mt_dstamp,oh."SHIP_BY_DATE" FROM ${MT} mt JOIN ${OH} oh ON oh."ORDER_ID"=mt."TASK_ID" WHERE mt."STATUS"='Consol' AND ((SUBSTR(mt."WORK_GROUP",1,1)='M' AND mt."FROM_LOC_ID"='CONTAINER' AND SUBSTR(mt."TO_LOC_ID",1,4)='DROP') OR (SUBSTR(mt."WORK_GROUP",1,1)<>'M' AND SUBSTR(mt."FROM_LOC_ID",1,4)='DROP' AND SUBSTR(mt."TO_LOC_ID",1,4)='PACK')) AND mt."DSTAMP">=NOW()-INTERVAL '3 HOURS'),agg AS (SELECT "CONTAINER_ID",MIN("mt_dstamp") AS transit_start,MAX("WORK_GROUP") AS work_group,MIN("SHIP_BY_DATE") AS sbd FROM mt_transit GROUP BY "CONTAINER_ID"),lp AS (SELECT ivt."CONTAINER_ID",ivt."FROM_LOC_ID" AS last_location,ivt."USER_ID" AS login,ivt."DSTAMP",ROW_NUMBER() OVER(PARTITION BY ivt."CONTAINER_ID" ORDER BY ivt."DSTAMP" DESC) AS rn FROM ${IVT} ivt WHERE ivt."CODE"='Pick' AND ivt."DSTAMP">=NOW()-INTERVAL '3 HOURS' AND ivt."FROM_LOC_ID" LIKE 'L%' AND ivt."TO_LOC_ID"='CONTAINER' AND ivt."FINAL_LOC_ID" LIKE 'PACK%') SELECT a."CONTAINER_ID" AS container_id,a.work_group,a.transit_start,a.sbd,l.last_location,l.login FROM agg a LEFT JOIN lp l ON l."CONTAINER_ID"=a."CONTAINER_ID" AND l.rn=1 ORDER BY a.transit_start ASC;`;
  }

  function isPLPMode() { return window.location.hash === '#PLP'; }

  function ensureDockedContainer() {
    if (document.getElementById('tt_panel')) return true;
    var refreshInfo = document.getElementById('refresh_info'), plpSummary = document.getElementById('plp_summary'), wrapper = document.getElementById('script_wrapper');
    if (!refreshInfo || !plpSummary || !wrapper) return false;
    var style = document.createElement('style'); style.id = 'tt_panel_css';
    style.textContent = '#tt_panel{margin:10px 0;padding:10px;background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.10);font-family:Arial,sans-serif;color:#000}#tt_panel .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}#tt_panel .title{font-weight:700}#tt_panel .actions{display:flex;gap:8px;align-items:center}#tt_panel .btn{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 10px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.15);user-select:none}#tt_panel .btn:hover{background:#f0f0f0}#tt_panel .btn:active{transform:translateY(1px)}#tt_panel .meta{color:#555;display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:11px;margin-bottom:6px}#tt_panel .meta b{color:#111}#tt_panel .wrap{max-height:160px;overflow:auto;border:1px solid #eee;border-radius:6px}#tt_panel table{width:100%;border-collapse:collapse;font-size:11px}#tt_panel th,#tt_panel td{border:1px solid #eee;padding:6px;text-align:left}#tt_panel th{background:#f6f8fa;position:sticky;top:0;z-index:1}#tt_panel td.num{text-align:right;font-variant-numeric:tabular-nums}#tt_panel tr.danger{background:#ffe6e6}#tt_panel .badge{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid #ddd;background:#f6f8fa;color:#333;font-size:11px}#tt_panel .badge.live{background:#eaffea;border-color:#bfe5bf;color:#0b7a0b}#tt_panel .badge.stale{background:#fff7e6;border-color:#f5d7a6;color:#ad6800}#tt_panel.tt-empty .wrap{max-height:34px!important}#tt_cfg_bg{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000000;display:flex;align-items:center;justify-content:center}#tt_cfg_box{width:640px;max-width:94vw;background:#fff;color:#000;border-radius:10px;border:1px solid #ddd;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px}#tt_cfg_head{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px}#tt_cfg_close{cursor:pointer;color:#333;font-size:16px}.tt_cfg_tbl{width:100%;border-collapse:collapse;font-size:12px}.tt_cfg_tbl th,.tt_cfg_tbl td{border:1px solid #eee;padding:8px}.tt_cfg_tbl th{background:#f6f8fa;text-align:left}.tt_cfg_tbl input{width:100%;border:1px solid #d0d7de;border-radius:6px;padding:6px 8px}#tt_cfg_actions{display:flex;justify-content:space-between;gap:10px;margin-top:12px;align-items:center}#tt_cfg_actions .right{display:flex;gap:10px}#tt_cfg_actions label{display:flex;gap:8px;align-items:center;color:#333;font-size:12px}.tt_section_title{margin-top:12px;margin-bottom:6px;font-weight:700;color:#222}.tt_del_btn{width:36px}';
    document.head.appendChild(style);
    var panel = document.createElement('div'); panel.id = 'tt_panel';
    panel.innerHTML = '<div class="head"><div class="title">Totes in Transit <span id="tt_state" class="badge stale">stale</span></div><div class="actions"><button class="btn" id="tt_refresh">Refresh</button><button class="btn" id="tt_gear" title="Thresholds (minutes)">⚙️</button></div></div><div class="meta"><div>DS: <b id="tt_ds">—</b></div><div>Schema: <b id="tt_schema">—</b></div><div>Shown: <b id="tt_shown">0</b> / Total: <b id="tt_total">0</b></div><div>Updated: <b id="tt_updated">—</b></div></div><div class="wrap" id="tt_wrap"><div style="padding:6px 8px;color:#777;font-size:11px;">Loading…</div></div>';
    wrapper.insertBefore(panel, plpSummary);
    document.getElementById('tt_refresh').addEventListener('click', function (e) { try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } catch (_) { } forceRefresh(true); }, true);
    document.getElementById('tt_gear').addEventListener('click', function () { openSettings(); });
    return true;
  }

  function closeSettings() { var bg = document.getElementById('tt_cfg_bg'); if (bg) bg.remove(); }
  function rebuildExtraRows() {
    var body = document.getElementById('tt_cfg_extra_body'); if (!body) return;
    body.innerHTML = ''; var keys = extraKeys();
    if (!keys.length) { body.innerHTML = '<tr><td colspan="4" style="color:#777"><i>No additional prefixes.</i></td></tr>'; return; }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], tr = document.createElement('tr'); tr.setAttribute('data-prefix', k);
      tr.innerHTML = '<td><input class="pfx" value="' + esc(k) + '"></td><td><input class="show" type="number" min="0" step="1" value="' + Number(cfg.showMin[k]) + '"></td><td><input class="crit" type="number" min="0" step="1" value="' + Number(cfg.criticalMin[k]) + '"></td><td><button class="btn tt_del_btn" title="Remove">✖</button></td>';
      (function (key) { tr.querySelector('.tt_del_btn').addEventListener('click', function () { delete cfg.showMin[key]; delete cfg.criticalMin[key]; saveJSON(LS_CFG, cfg); rebuildExtraRows(); }); })(k);
      body.appendChild(tr);
    }
  }

  function openSettings() {
    closeSettings();
    var bg = document.createElement('div'); bg.id = 'tt_cfg_bg';
    bg.innerHTML = '<div id="tt_cfg_box"><div id="tt_cfg_head"><div>Thresholds (minutes)</div><div id="tt_cfg_close">✖</div></div><div class="tt_section_title">Base prefixes</div><table class="tt_cfg_tbl"><thead><tr><th style="width:110px">Prefix</th><th>Show > (min)</th><th>Critical > (min)</th></tr></thead><tbody><tr><td><b>MULT</b></td><td><input type="number" id="cfg_show_MULT" min="0" step="1"></td><td><input type="number" id="cfg_crit_MULT" min="0" step="1"></td></tr><tr><td><b>SING</b></td><td><input type="number" id="cfg_show_SING" min="0" step="1"></td><td><input type="number" id="cfg_crit_SING" min="0" step="1"></td></tr><tr><td><b>ITM</b></td><td><input type="number" id="cfg_show_ITM" min="0" step="1"></td><td><input type="number" id="cfg_crit_ITM" min="0" step="1"></td></tr><tr><td><b>B2B</b></td><td><input type="number" id="cfg_show_B2B" min="0" step="1"></td><td><input type="number" id="cfg_crit_B2B" min="0" step="1"></td></tr><tr><td><b>PRE</b></td><td><input type="number" id="cfg_show_PRE" min="0" step="1"></td><td><input type="number" id="cfg_crit_PRE" min="0" step="1"></td></tr></tbody></table><div class="tt_section_title">Additional prefixes</div><table class="tt_cfg_tbl"><thead><tr><th style="width:110px">Prefix</th><th>Show > (min)</th><th>Critical > (min)</th><th style="width:40px"></th></tr></thead><tbody id="tt_cfg_extra_body"></tbody></table><div id="tt_cfg_actions"><label><input type="checkbox" id="cfg_show_all"> Show all totes (no filter)</label><div class="right"><button class="btn" id="cfg_add_prefix">Add prefix</button><button class="btn" id="cfg_reset">Reset</button><button class="btn" id="cfg_save">Save</button></div></div></div>';
    document.body.appendChild(bg);
    document.getElementById('cfg_show_MULT').value = cfg.showMin.MULT; document.getElementById('cfg_show_SING').value = cfg.showMin.SING; document.getElementById('cfg_show_ITM').value = cfg.showMin.ITM; document.getElementById('cfg_show_B2B').value = cfg.showMin.B2B; document.getElementById('cfg_show_PRE').value = cfg.showMin.PRE;
    document.getElementById('cfg_crit_MULT').value = cfg.criticalMin.MULT; document.getElementById('cfg_crit_SING').value = cfg.criticalMin.SING; document.getElementById('cfg_crit_ITM').value = cfg.criticalMin.ITM; document.getElementById('cfg_crit_B2B').value = cfg.criticalMin.B2B; document.getElementById('cfg_crit_PRE').value = cfg.criticalMin.PRE;
    document.getElementById('cfg_show_all').checked = !!cfg.showAll;
    rebuildExtraRows();
    document.getElementById('tt_cfg_close').addEventListener('click', closeSettings);
    bg.addEventListener('click', function (e) { if (e.target === bg) closeSettings(); });
    document.getElementById('cfg_add_prefix').addEventListener('click', function () { var base = 'NEW', name = base, i = 1; while (cfg.showMin[name] !== undefined) { name = base + (i++); } cfg.showMin[name] = 20; cfg.criticalMin[name] = 60; saveJSON(LS_CFG, cfg); rebuildExtraRows(); });
    document.getElementById('cfg_reset').addEventListener('click', function () { cfg = normalizeCfg(DEFAULT_CFG); saveJSON(LS_CFG, cfg); closeSettings(); rerenderFromCache(); });
    document.getElementById('cfg_save').addEventListener('click', function () {
      cfg.showAll = document.getElementById('cfg_show_all').checked;
      cfg.showMin.MULT = Number(document.getElementById('cfg_show_MULT').value); cfg.showMin.SING = Number(document.getElementById('cfg_show_SING').value); cfg.showMin.ITM = Number(document.getElementById('cfg_show_ITM').value); cfg.showMin.B2B = Number(document.getElementById('cfg_show_B2B').value); cfg.showMin.PRE = Number(document.getElementById('cfg_show_PRE').value);
      cfg.criticalMin.MULT = Number(document.getElementById('cfg_crit_MULT').value); cfg.criticalMin.SING = Number(document.getElementById('cfg_crit_SING').value); cfg.criticalMin.ITM = Number(document.getElementById('cfg_crit_ITM').value); cfg.criticalMin.B2B = Number(document.getElementById('cfg_crit_B2B').value); cfg.criticalMin.PRE = Number(document.getElementById('cfg_crit_PRE').value);
      var body = document.getElementById('tt_cfg_extra_body'); var trs = body ? body.querySelectorAll('tr[data-prefix]') : [];
      for (var i = 0; i < trs.length; i++) { var tr = trs[i]; var pfx = (tr.querySelector('.pfx').value || '').trim().toUpperCase(); if (!pfx) continue; var s = Number(tr.querySelector('.show').value), c = Number(tr.querySelector('.crit').value); if (!isNaN(s)) cfg.showMin[pfx] = s; if (!isNaN(c)) cfg.criticalMin[pfx] = c; }
      cfg = normalizeCfg(cfg); saveJSON(LS_CFG, cfg); closeSettings(); rerenderFromCache();
    });
  }

  function rerenderFromCache() { if (cache && cache.dataFull) { var filtered = applyFilters(cache.dataFull); cache.dataFiltered = filtered; saveJSON(LS_CACHE, cache); render(filtered, { ts: cache.ts || 0, live: false }); } else { forceRefresh(true); } }
  function applyFilters(fullList) { cache.stats = { total: (fullList || []).length }; if (cfg.showAll) return fullList || []; var out = []; for (var i = 0; i < (fullList || []).length; i++) { var r = fullList[i], p = wgPrefix(r.work_group), lim = cfg.showMin[p]; if (!(lim >= 0)) continue; if ((Number(r.ageMin) || 0) > lim) out.push(r); } return out; }

  function render(data, meta) {
    meta = meta || {}; if (!isPLPMode()) return; if (!ensureDockedContainer()) return;
    document.getElementById('tt_ds').textContent = (DS.uid || '—') + ' (#' + (DS.id || '—') + ')';
    document.getElementById('tt_schema').textContent = (cache.meta && cache.meta.schema) ? cache.meta.schema : '—';
    var badge = document.getElementById('tt_state'); badge.textContent = meta.live ? 'live' : 'stale'; badge.classList.remove('live', 'stale'); badge.classList.add(meta.live ? 'live' : 'stale');
    document.getElementById('tt_total').textContent = String((cache.stats && cache.stats.total) ? cache.stats.total : 0);
    document.getElementById('tt_shown').textContent = String(data ? data.length : 0);
    document.getElementById('tt_updated').textContent = fmtTS(meta.ts || cache.ts || 0);
    var wrap = document.getElementById('tt_wrap'), panel = document.getElementById('tt_panel');
    if (!data || !data.length) { if (panel) panel.classList.add('tt-empty'); wrap.innerHTML = '<div style="padding:6px 8px;color:#777;font-size:11px;">No totes</div>'; return; }
    if (panel) panel.classList.remove('tt-empty');
    var sorted = data.slice().sort(function (a, b) { return (b.ageMin || 0) - (a.ageMin || 0); }); if (sorted.length > 200) sorted = sorted.slice(0, 200);
    var html = '<table><thead><tr><th style="width:70px">Prefix</th><th style="width:120px">Container</th><th style="width:70px">Age</th><th style="width:150px">Last Location</th><th style="width:90px">Login</th><th style="width:85px">SBD</th></tr></thead><tbody>';
    for (var i = 0; i < sorted.length; i++) { var r = sorted[i], p = wgPrefix(r.work_group), crit = cfg.criticalMin[p], danger = (crit >= 0) && ((r.ageMin || 0) > crit); html += '<tr' + (danger ? ' class="danger"' : '') + '><td>' + esc(p) + '</td><td>' + esc(r.container) + '</td><td class="num">' + esc(r.ageStr) + '</td><td>' + esc(r.last_location || '—') + '</td><td>' + esc(r.login || '—') + '</td><td>' + esc(r.sbdShort || '—') + '</td></tr>'; }
    html += '</tbody></table>'; wrap.innerHTML = html;
  }

  async function forceRefresh(manual) {
    if (__inflight) return; __inflight = true;
    var watchdog = setTimeout(function () { try { if (__abort) __abort.abort(); } catch (_) { } __inflight = false; }, 20000);
    try {
      if (!isPLPMode()) return; if (!ensureDockedContainer()) return;
      var meta = await discoverSchemaMeta(); if (!meta) throw new Error('Schema discovery failed');
      cache.meta = meta;
      var sql = buildSQL(meta), raw = await grafanaQuery(sql), rows = retrieveData(raw);
      var map = new Map();
      for (var i = 0; i < rows.length; i++) { var v = rows[i], cid = v.container_id; if (!cid) continue; if (!map.has(cid)) { map.set(cid, { container: cid, work_group: v.work_group || '', transit_start: v.transit_start, sbd: v.sbd, last_location: v.last_location || '', login: v.login || '' }); } }
      var out = []; map.forEach(function (t) { var ageMin = ageMinFromOldest(t.transit_start); out.push({ container: t.container, work_group: t.work_group, ageMin: ageMin, ageStr: ageShortFromMinutes(ageMin), last_location: t.last_location ? fmtL1(t.last_location) : '', login: t.login, sbdShort: t.sbd ? fmtSBDShort(t.sbd) : '' }); });
      function fmtL1(loc) { var s = (loc == null ? '' : String(loc)).toUpperCase(); if (/^L\d-\d{3}-\d{2}-\d{2}$/.test(s)) return s; var m = s.match(/^L(\d)(\d{3})(\d{2})(\d{2})$/); return m ? ('L' + m[1] + '-' + m[2] + '-' + m[3] + '-' + m[4]) : s; }
      cache.dataFull = out; cache.dataFiltered = applyFilters(out); cache.ts = Date.now(); cache.lastSource = 'sql'; saveJSON(LS_CACHE, cache); __lastUiTs = cache.ts;
      render(cache.dataFiltered, { ts: cache.ts, live: true });
    } catch (e) { console.warn('[TT] refresh failed', e); cache.ts = Date.now(); __lastUiTs = cache.ts; render(cache.dataFiltered || [], { ts: cache.ts, live: false }); }
    finally { clearTimeout(watchdog); __inflight = false; }
  }

  async function tick() {
    if (!isPLPMode()) return; if (!ensureDockedContainer()) return; if (__inflight) return;
    var now = Date.now(), due = (now - lastSQL) >= (SQL_REFRESH_SEC * 1000);
    if (!document.hidden && due) { lastSQL = now; forceRefresh(false); return; }
    if ((cache.ts || 0) !== __lastUiTs) { __lastUiTs = (cache.ts || 0); render(cache.dataFiltered || [], { ts: cache.ts || 0, live: false }); }
  }

  window.TT_DIAG = function () { return { ds: DS, cfg: cfg, cacheTs: cache.ts || 0, cacheTotal: cache.dataFull ? cache.dataFull.length : 0, cacheShown: cache.dataFiltered ? cache.dataFiltered.length : 0, schemaMeta: cache.meta || __schemaMeta }; };

  tick();
  setInterval(tick, TICK_MS);
})();

// v2.1.28 cleanup: remove old UNPR/idle badges from previous versions.
(function(){
  try {
    localStorage.setItem('PLP_UNPR_ALERT_ON','0');
    localStorage.setItem('PLP_IDLE_ALERT_ON','0');
    document.querySelectorAll('.plp-unpr-badge,.plp-idle-badge').forEach(x => x.remove());
    document.querySelectorAll('.uph-badge.unpr,.uph-badge.idle').forEach(x => { x.classList.remove('unpr'); x.classList.remove('idle'); });
  } catch (_) {}
})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 5 – UNITS CLICK REFRESH SQL                         ║
   ║  v2.1.28: keeps original list length; settings cleaned        ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  const css = `
    .pt_zone table tr:not(:first-child) td:nth-child(3){cursor:pointer;text-decoration:none!important;}
    .pt_zone table tr:not(:first-child) td:nth-child(3):hover{background:#eef6ff!important;outline:1px solid #90c4ff;}
    @keyframes plp-unit-flash{0%{background-color:#d4f7d4}100%{background-color:inherit}}
    .plp-unit-flash{animation:plp-unit-flash .9s ease-out;}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const inflight = new Set(); let schemaCache = null, dsCache = null;
  const T = el => (el && (el.textContent || '').trim()) || '';
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function qIdent(s){ return '"' + String(s).replace(/"/g,'""') + '"'; }
  function sqlLit(s){ return "'" + String(s).replace(/'/g,"''") + "'"; }
  function detectDS(){ if (dsCache) return dsCache; try { const ds = (window.grafanaBootData && window.grafanaBootData.settings && window.grafanaBootData.settings.datasources) || {}; for (const name in ds) if (ds[name] && ds[name].type === 'postgres') { dsCache = {uid: ds[name].uid, id: ds[name].id}; return dsCache; } } catch (_) {} dsCache = {uid:'mFpJIAhVk', id:108}; return dsCache; }
  async function grafanaQuery(sql){
    const DS = detectDS(), api = (window.origin || location.origin) + '/api/ds/query', now = new Date();
    const payload = { queries:[{refId:'A', datasource:{uid:DS.uid,type:'postgres'}, rawSql:sql, format:'table', datasourceId:DS.id, intervalMs:60000, maxDataPoints:1447}], range:{from:now.toISOString(), to:now.toISOString(), raw:{from:now.toISOString(), to:now.toISOString()}}, from:String(now.getTime()), to:String(now.getTime()) };
    const res = await fetch(api, {method:'POST', credentials:'include', headers:{'content-type':'application/json','x-grafana-org-id':'1','accept':'application/json, text/plain, */*'}, body:JSON.stringify(payload)});
    if (!res.ok) { let body=''; try{body=await res.text();}catch(_){} throw new Error('Query failed: '+res.status+' '+body.slice(0,180)); }
    return res.json();
  }
  function retrieveData(raw){ const frame = raw && raw.results && raw.results.A && raw.results.A.frames && raw.results.A.frames[0]; if (!frame) return []; const values = frame.data && frame.data.values, fields = frame.schema && frame.schema.fields; if (!values || !fields) return []; const len = values[0] ? values[0].length : 0, out=[]; for (let r=0;r<len;r++){ const obj={}; for(let c=0;c<values.length;c++) obj[fields[c] && fields[c].name]=values[c][r]; out.push(obj); } return out; }
  async function getSchema(){ if (schemaCache) return schemaCache; const rows = retrieveData(await grafanaQuery("SELECT table_schema FROM information_schema.tables WHERE lower(table_name)='move_task' ORDER BY CASE WHEN upper(table_schema)='GODLX83P' THEN 0 ELSE 1 END, table_schema")); for (const r of rows){ const s=String(r.table_schema||'').trim(); if (s){ schemaCache=s; return s; } } throw new Error('MOVE_TASK schema not found'); }
  function flash(el){ if(!el)return; el.classList.remove('plp-unit-flash'); void el.offsetWidth; el.classList.add('plp-unit-flash'); el.addEventListener('animationend',()=>el.classList.remove('plp-unit-flash'),{once:true}); }
  function getPickTowerListId(tr){ const el = tr && tr.querySelector('.picklist_identifier'); return el ? String(el.dataset.listId || el.getAttribute('data-list-id') || T(el)).replace(/[^A-Z0-9_-]/gi,'').trim().toUpperCase() : ''; }
  function getUnitsTextOnly(td){ try{ const clone=td.cloneNode(true); clone.querySelectorAll('.eta-picker,.uph-badge,.plp-task-badge,.plp-unpr-badge,.plp-idle-badge,.plp-units-mini,.plp-unit-flash').forEach(x=>x.remove()); return T(clone); }catch(_){ return T(td); } }
  function getExistingListLength(td){ const m=getUnitsTextOnly(td).match(/\b\d+\s*\/\s*(\d+)\b/); return m ? Number(m[1]) : 0; }
  function preserveImportantChildren(td){ try{ return [...td.childNodes].filter(n=>n.nodeType===Node.ELEMENT_NODE).filter(n=>!String(n.className||'').includes('plp-unit-flash')).map(n=>n.cloneNode(true)); }catch(_){ return []; } }
  function setUnitsCell(td,left,sqlTotal,strong){ const kept=preserveImportantChildren(td), total=getExistingListLength(td) || sqlTotal; td.innerHTML = strong ? '<span style="font-weight:700;">'+left+'</span> / '+total : String(left)+' / '+String(total); kept.forEach(k=>{ td.appendChild(document.createTextNode(' ')); td.appendChild(k); }); return total; }
  function updatePicklistTableRow(listId,left,sqlTotal){ const tbl=document.getElementById('pickLists_table'); if(!tbl)return; const hdr=tbl.querySelector('tr'); if(!hdr)return; const h=[...hdr.querySelectorAll('th')].map(x=>norm(T(x))), iu=h.findIndex(x=>x.includes('units left')||x==='units'||x.startsWith('units')), il=h.findIndex(x=>x==='list id'||x.includes('list id')||x.includes('pick list')||x==='list'); if(iu<0||il<0)return; [...tbl.querySelectorAll('tr')].slice(1).forEach(row=>{ const lc=row.children[il], uc=row.children[iu]; if(!lc||!uc)return; const got=T(lc).replace(/[^A-Z0-9_-]/gi,'').trim().toUpperCase(); if(got!==listId&&!got.startsWith(listId))return; setUnitsCell(uc,left,sqlTotal,true); flash(uc); }); }
  async function refreshListUnits(listId, unitsTd){
    if(!listId||inflight.has(listId))return; inflight.add(listId);
    const origHTML=unitsTd.innerHTML; unitsTd.style.opacity='0.45'; unitsTd.title='Refreshing units by LIST_ID…';
    try{ const schema=await getSchema(); const sql='SELECT COUNT(CASE WHEN "STATUS" IN (\'Released\',\'In Progress\') THEN 1 END) AS units_left,COUNT(*) AS units_total FROM '+qIdent(schema)+'."MOVE_TASK" WHERE "LIST_ID" = '+sqlLit(listId)+' AND "TASK_TYPE" = \'O\' AND SUBSTR("WORK_ZONE",5,1) = \'L\''; const rows=retrieveData(await grafanaQuery(sql)); window.PLP_UNITS_LAST_SQL={listId,schema,sql,rows,previousTotal:getExistingListLength(unitsTd),ts:Date.now()}; if(!rows.length) throw new Error('No SQL result rows'); const left=Number(rows[0].units_left||rows[0].UNITS_LEFT||0)||0, sqlTotal=Number(rows[0].units_total||rows[0].UNITS_TOTAL||0)||0; unitsTd.style.opacity=''; const totalShown=setUnitsCell(unitsTd,left,sqlTotal,false); unitsTd.title='Refreshed: '+new Date().toLocaleTimeString()+' | length kept: '+totalShown; flash(unitsTd); updatePicklistTableRow(listId,left,sqlTotal); setTimeout(()=>{try{if(typeof window.PLP_ETA_REFRESH==='function')window.PLP_ETA_REFRESH();}catch(_){}},60); setTimeout(()=>{try{if(typeof applyPickerETAs==='function')applyPickerETAs();}catch(_){}},90); }
    catch(e){ console.warn('[PLP Units Refresh]',e); window.PLP_UNITS_LAST_SQL_ERROR={listId,error:String(e&&e.message?e.message:e),ts:Date.now()}; unitsTd.innerHTML=origHTML; unitsTd.style.opacity=''; unitsTd.title='Refresh failed'; }
    finally{ setTimeout(()=>inflight.delete(listId),3000); }
  }
  document.addEventListener('click',(e)=>{ const td=e.target.closest&&e.target.closest('td'); if(!td||!td.closest('.pt_zone'))return; const tr=td.parentElement, tbl=tr&&tr.closest('table'), hdr=tbl&&tbl.querySelector('tr'); if(!tr||!tbl||!hdr)return; const h=[...hdr.querySelectorAll('th')].map(x=>norm(T(x))), iu=h.findIndex(x=>x.startsWith('units')); if(iu<0||td.cellIndex!==iu)return; const listId=getPickTowerListId(tr); if(!listId)return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); refreshListUnits(listId,td); }, true);
})();

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 6 – PICK TOWER PRIO DISPLAY                         ║
   ║  v2.1.29: shows PT Prio as calculated prio / WMS priority     ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  if (window.__PLP_PT_PRIO_ENHANCER__) return;
  window.__PLP_PT_PRIO_ENHANCER__ = true;

  const T = el => (el && (el.textContent || '').trim()) || '';
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cleanList = s => String(s || '').replace(/[^A-Z0-9_-]/gi, '').trim().toUpperCase();
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const css = `
    .plp-wms-prio-after{font-size:10px;font-weight:700;color:#666;margin-left:2px;white-space:nowrap;}
    .plp-wms-prio-after.hot{color:rgb(16 84 219);}
    .plp-prio-cell-updated{font-variant-numeric:tabular-nums;}
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function parsePrioCellText(txt) {
    const s = String(txt || '').replace(/\s+/g, ' ').trim();
    // Pick Lists table normally uses: "calculatedPrio (WMS_PRIO)".
    let m = s.match(/^(\d+)\s*\((\d+)\)/);
    if (m) return { calc: m[1], wms: m[2] };
    // Already enhanced or manually changed: "calculatedPrio / WMS_PRIO".
    m = s.match(/^(\d+)\s*\/\s*(\d+)/);
    if (m) return { calc: m[1], wms: m[2] };
    // Fallback: first two numbers in the cell.
    const nums = s.match(/\d+/g) || [];
    return { calc: nums[0] || '', wms: nums[1] || '' };
  }

  function buildPrioIndexFromPickLists() {
    const map = new Map();
    const tbl = document.getElementById('pickLists_table');
    if (!tbl) return map;
    const hdr = tbl.querySelector('tr');
    if (!hdr) return map;
    const headers = [...hdr.querySelectorAll('th')].map(th => norm(T(th)));
    const iList = headers.findIndex(h => h === 'list id' || h.includes('list id') || h.includes('pick list'));
    const iPrio = headers.findIndex(h => h === 'prio' || h.startsWith('prio '));
    if (iList < 0 || iPrio < 0) return map;
    [...tbl.querySelectorAll('tr')].slice(1).forEach(row => {
      const listCell = row.children[iList];
      const prioCell = row.children[iPrio];
      if (!listCell || !prioCell) return;
      const listId = cleanList(T(listCell));
      if (!listId) return;
      const parsed = parsePrioCellText(T(prioCell));
      if (!parsed.wms) return;
      map.set(listId, parsed);
    });
    return map;
  }

  function getPickTowerListId(row, iList) {
    const cell = row.children[iList];
    if (!cell) return '';
    const el = cell.querySelector('.picklist_identifier');
    return cleanList((el && (el.dataset.listId || el.getAttribute('data-list-id') || T(el))) || T(cell));
  }

  function getBasePrioFromCell(td) {
    if (!td) return '';
    const clone = td.cloneNode(true);
    clone.querySelectorAll('.plp-wms-prio-after').forEach(x => x.remove());
    const raw = T(clone).split('/')[0].trim();
    return raw || '0';
  }

  function enhancePickTowerPrio() {
    const prioMap = buildPrioIndexFromPickLists();
    if (!prioMap.size) return false;
    let changed = 0;
    document.querySelectorAll('.pt_zone table').forEach(tbl => {
      const hdr = tbl.querySelector('tr');
      if (!hdr) return;
      const headers = [...hdr.querySelectorAll('th')].map(th => norm(T(th)));
      const iList = headers.findIndex(h => h === 'list id' || h.includes('list id'));
      const iPrio = headers.findIndex(h => h === 'prio' || h.startsWith('prio'));
      if (iList < 0 || iPrio < 0) return;
      [...tbl.querySelectorAll('tr')].slice(1).forEach(row => {
        const td = row.children[iPrio];
        if (!td) return;
        const listId = getPickTowerListId(row, iList);
        const info = prioMap.get(listId);
        if (!info || info.wms == null || info.wms === '') return;
        const base = getBasePrioFromCell(td);
        const sig = base + '/' + info.wms;
        if (td.dataset.plpPrioSig === sig) return;
        td.dataset.plpPrioSig = sig;
        td.classList.add('plp-prio-cell-updated');
        const hot = Number(info.wms) > 0 ? ' hot' : '';
        td.innerHTML = esc(base) + ' <span class="plp-wms-prio-after' + hot + '" title="WMS priority for this list">/ ' + esc(info.wms) + '</span>';
        changed++;
      });
    });
    return changed > 0;
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(enhancePickTowerPrio, 180);
  }

  const mo = new MutationObserver(schedule);
  function boot() {
    try { enhancePickTowerPrio(); } catch (_) {}
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    setInterval(() => { try { enhancePickTowerPrio(); } catch (_) {} }, 2500);
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  window.PLP_PT_PRIO_DIAG = function () {
    const m = buildPrioIndexFromPickLists();
    return { version: '2.1.30-remote', remote: true, mapSize: m.size, sample: Object.fromEntries([...m.entries()].slice(0, 10)) };
  };
})();

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  SECTION 7 – HIGH RISK ACCESS UNDERLINE                      ║
   ║  Marks High Risk access logins only in Pick tower visualisation.    ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  if (window.__PLP_HIGH_RISK_ACCESS__) return;
  window.__PLP_HIGH_RISK_ACCESS__ = true;

  // Source file used to build this embedded list:
  // https://cevalogisticsoffice365-my.sharepoint.com/personal/marcin_poborski_cevalogistics_com/Documents/High%20Risk%20permission.xlsx
  // NOTE: the list is embedded to avoid SharePoint/CORS/XLSX parsing issues in Grafana.
  const HIGH_RISK_LOGINS = new Set(["BURZYNSM", "JACHYMD", "SLOWIKG", "DADUND", "KROMAT", "HORYKA", "DURALM", "VASEVIK", "KICZML", "KOWALM", "ZUBAJ", "KARPAW", "WIKTOK", "ZIELINK", "TOKARCZL", "SLONOL", "POPIELM", "STOCHELB", "DIACHENA", "ARIFOA", "AITKUR", "GVALIM", "BOIKOR", "KOZIELM", "PUSTOVS", "JEDYNAM", "DUDCHET", "ROMANA", "ANASTASD", "BAHATI", "AKISIO", "HALAHAV", "OLENA", "KOWALSW", "SHVET", "SOLOKL", "VELMOA", "SWIATEKL", "ZALEPAM", "POBORM", "SERAFID", "PLAKSYVYIR", "BATAUU", "WOJCIA", "ZAJACA", "JUSZCZAKA", "PRUSZJ", "CAPAJAM", "SLABOUSR", "MALISZEP", "BARANOVB", "WASIKM", "BOKHIV", "MEDOVA", "VOROBV", "KHOKO", "OSHURI", "POLISOL", "DEMIAM", "ZARUBO", "SMOLIV", "PRIADKO", "HARMAH", "SHEVCK", "PAWLUP", "SUKHOY", "BARANA", "GRABOO", "GAVRIJ", "LUBASR", "NOWICKIA", "SZOSTA", "URBANEKK", "BUKOFAJK", "BEKSIAKV", "JACYNAP", "DIEMIENTIT", "WASZCZAK", "PIORKOP", "FORMENAN", "DIDYCHD", "USARM", "WRONAI", "GRZEJSZCZB", "KASZUBAD", "DRABIKP", "JAKUBCZYKD", "LESZCZUK", "RYCHLIK", "ROSADA", "HORBAJCI", "GREDZIP", "GAJDZIND", "GALUSE", "TYKHONIA", "OWCZARW", "BAUERK", "PEJASD", "NAPIER", "DEONIZIAKM", "ZABLOTR", "MOTYLW", "PANTILIM", "KOWALAG", "IVANOVAD", "BORYSKA", "ANTONEY", "PASAL", "BIDNOM", "PASLIU", "OSYPOVAH", "BUTKOY", "STUPALI", "OLIINYKO", "VORONK", "LUBET", "VARENI", "VASTRN", "PIETRAK", "PANTILIT", "LUKANO", "KOVBIU", "OTSALNAT", "DOLZHNA", "KOLESE", "ZHMUDV", "MELESK", "STRILEV", "SZYDLD", "NIECKULAM", "KOVALG", "KUZNETK", "MAZURAA", "ZIELINJ", "WILCZYK", "NALYVAD", "FORTUD", "BLATKIET", "WOZNIAKP", "MALIND", "WASINS", "SPASR", "ZABLOTY", "OWCZARJ", "POMALNO", "ADACHBA", "DREJKOP", "DYKN", "BROSP", "RYMARS", "LEBEDI", "MUNTE", "TSAPENO", "SMOLEK", "SHMATMA", "POPOVAO", "SHYNKA", "BUINA", "GAJOSM", "LITWIG", "VAKARN", "LUKIAR", "HRYBHOHA", "CHORNOT", "ZEMLIAY", "DENYSOVA", "CHEMYS", "KONOVO", "KOWALD", "LELETI", "KHARCA", "KUZNIM", "ANIKIIA", "GELLESD", "MROCZKOA", "YEREMN", "ZYKIND", "WOLBAA", "PESTKOMA", "KURPIK", "CHERNS", "ANTONOS", "SHCHERO", "BASIAS", "KOSTEV", "DZIVASAL", "SPIRIO", "STANIR", "ZAKARIAN", "HAWRYLM", "IVANIDI", "MASLOIN", "ALIMOY", "NAWROP", "SMILIV", "BOLTIANA", "MURSAT", "MUSHEN", "HOLSHR", "ZAKHARY", "DAMASKIH", "WATRASK", "WERESK", "ALEKSIV", "DEMKA", "DOMORI", "HAVRYLO", "PIECHA", "BRYJAE", "OBEREE", "RUSNAKA", "LEVENA", "SHYMANB", "KHOMENA", "VASYLVA", "BEREZV", "DEKOW", "KASACHK", "KREIDUL", "KRIACHL", "BAGINSKAI", "KONOVN", "CHERNA", "MOROZK", "SMIRNO", "TRAMBOVY", "VASILIAN", "KUSHT", "ZWIERZYR", "PIEKARW", "NOVIKOVP", "VOLKOSM", "BIELAK", "MALINI", "KOZAKKH", "RADCHYK", "POCIAM", "SACHU", "ZUIKOV", "IVANOLI", "TRETIA", "VOKHA", "KONOVAV", "BEKP", "VCHERASO", "BUCIORA", "BOHAJCA", "KOWALSM", "KOVALR", "SZOLTYSK", "KASPERM", "RADIONA", "SIRYKS", "KUCHAP", "KOZLOWSB", "KOPIWODAD", "KUCHARA", "HOSPODV", "JARSKIG", "MADEJJ", "ISHCHN", "PIATEA", "MENSH", "SHONIIAH", "HUSIED", "BOZHOS", "OSTROM", "TSYHAA", "RYZHEI", "CHIKIO", "KOLIEY", "NOWAAD", "MYKHALCHA", "NESTEV", "ZERKIT", "PAVLIY", "KASPA", "WOJDOS", "PLYSKAO", "LOBIVK", "LEBEM", "JAROSZA", "CZAJKOWM", "FUJARL", "KOMISA", "DUBOVO", "ILIKHM", "USARCZ", "MAREKM", "BACALO", "SOBCZUJ", "GODYNW", "SACHARM", "SAJEWIM", "ZAKRZEWSKP", "MELNYCHUKY", "MROCZEA", "LOBINP", "ANDROK", "KARPEY", "OBLIK", "DLUZNIAKE", "KIEDAJ", "ROZMUR", "HOFFMANNJ", "KONDRM", "MARCIK", "GOLECW", "OSOJCAT", "SENDOM", "MASIUKS", "KOSTO", "MARSZR", "WOJTCZAR", "URBAND", "KIRIUK", "BURENS"]);
  const SOURCE = 'High Risk permission.xlsx';

  const css = `
    td.plp-hr-login-cell {
      text-decoration-line: underline;
      text-decoration-style: double;
      text-decoration-color: #b10252;
      text-underline-offset: 2px;
      font-weight: 700;
    }
    td.plp-hr-login-cell .uph-badge,
    td.plp-hr-login-cell .eta-picker,
    td.plp-hr-login-cell .plp-task-badge,
    td.plp-hr-login-cell .plp-unpr-badge,
    td.plp-hr-login-cell .plp-idle-badge {
      text-decoration: none !important;
      font-weight: initial;
    }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const T = el => (el && (el.textContent || '').trim()) || '';
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cleanLogin = s => String(s || '')
    .split(';')[0]
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .trim();

  function plainLoginFromCell(td) {
    if (!td) return '';
    const clone = td.cloneNode(true);
    clone.querySelectorAll('.uph-badge,.eta-picker,.plp-task-badge,.plp-unpr-badge,.plp-idle-badge,.plp-hr-marker').forEach(x => x.remove());
    return cleanLogin(T(clone));
  }

  function applyHighRiskUnderline() {
    let marked = 0;
    document.querySelectorAll('.pt_zone table').forEach(tbl => {
      const hdr = tbl.querySelector('tr');
      if (!hdr) return;
      const headers = [...hdr.querySelectorAll('th')].map(th => norm(T(th)));
      const userIndexes = [];
      headers.forEach((h, i) => {
        if (h === 'user' || h === 'login' || h.startsWith('user ') || h.startsWith('login ')) userIndexes.push(i);
      });
      if (!userIndexes.length) return;
      [...tbl.querySelectorAll('tr')].slice(1).forEach(row => {
        userIndexes.forEach(i => {
          const td = row.children[i];
          if (!td) return;
          const login = plainLoginFromCell(td);
          const isHR = !!login && HIGH_RISK_LOGINS.has(login);
          td.classList.toggle('plp-hr-login-cell', isHR);
          if (isHR) {
            td.title = (td.title ? td.title + ' | ' : '') + 'High Risk access: YES (' + SOURCE + ')';
            marked++;
          }
        });
      });
    });
    return marked;
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { try { applyHighRiskUnderline(); } catch (_) {} }, 160);
  }

  function boot() {
    schedule();
    const mo = new MutationObserver(schedule);
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    setInterval(schedule, 3000);
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  window.PLP_HIGH_RISK_DIAG = function () {
    return {
      source: SOURCE,
      sourceUrl: 'https://cevalogisticsoffice365-my.sharepoint.com/personal/marcin_poborski_cevalogistics_com/Documents/High%20Risk%20permission.xlsx',
      embeddedLogins: HIGH_RISK_LOGINS.size,
      markedNow: applyHighRiskUnderline(),
      sample: [...HIGH_RISK_LOGINS].slice(0, 12)
    };
  };
})();

