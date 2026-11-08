/* HTML Preview toolbar frame. It holds the page in a sandboxed srcdoc frame (no origin, no access to this frame,
   to VS Code or to the network), swaps in a new frame on each update with the old scroll position, and watches
   that the page answers. Messages from the page frame are data only; they are checked before anything is done. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const st = vscode.getState() || {};
  st.scroll = st.scroll || {};
  let prefs = { width: 'fill', custom: 390, zoom: 'fit', bg: 'auto', sync: false, console: false };
  let stuckMs = 5000;
  let cur = null, loading = null, last = null, seqShown = 0;
  let counts = { warn: 0, error: 0 };
  let saveTimer = 0, synced = 0, refused = 0;

  const post = m => vscode.postMessage(m);
  // When did the user last start interacting (click or key) with this panel? A page may ask for a copy or open a
  // link only after the user did something *after* that page appeared; an older click does not count.
  let wasActive = false, activatedAt = 0;
  const UA = navigator.userActivation;
  const sawActivation = () => { const a = !!(UA && UA.isActive); if (a && !wasActive) activatedAt = Date.now(); wasActive = a; return a; };
  setInterval(sawActivation, 50);
  const userActedOn = r => (UA ? sawActivation() && r.shownAt && activatedAt >= r.shownAt : true);
  const SANDBOX = 'allow-scripts allow-forms allow-modals';
  const stage = $('stage'), wrap = $('wrap');

  // ---------- layout: device width and zoom ----------
  function dims() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (prefs.width === 'fill') {
      const z = prefs.zoom === 'fit' ? 1 : Number(prefs.zoom) || 1;
      return { fill: true, z, W: sw / z, H: sh / z, ww: sw, wh: sh };
    }
    const W = prefs.width === 'custom' ? clampW(prefs.custom) : Number(prefs.width);
    const z = prefs.zoom === 'fit' ? Math.min(1, (sw - 24) / W) : Number(prefs.zoom) || 1;
    const H = Math.max(100, (sh - 24) / z);
    return { fill: false, z, W, H, ww: W * z, wh: H * z };
  }
  const clampW = v => Math.max(200, Math.min(4000, Math.round(Number(v) || 390)));
  function layout() {
    const d = dims();
    stage.classList.toggle('fill', d.fill);
    wrap.style.width = d.ww + 'px';
    wrap.style.height = d.wh + 'px';
    for (const f of wrap.querySelectorAll('iframe')) sizeFrame(f, d);
    $('size').textContent = `${Math.round(d.W)} × ${Math.round(d.H)}` + (Math.abs(d.z - 1) > 0.001 ? ` · ${Math.round(d.z * 100)}%` : '');
  }
  function sizeFrame(f, d) {
    f.style.width = d.W + 'px';
    f.style.height = d.H + 'px';
    f.style.transform = Math.abs(d.z - 1) > 0.001 ? `scale(${d.z})` : '';
  }
  new ResizeObserver(layout).observe(stage);

  function themeBg() {
    const c = document.body.classList;
    return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
  }
  const bgNow = () => (prefs.bg === 'auto' ? themeBg() : prefs.bg);
  // Redraw only when the theme kind really changes (VS Code also changes body classes for other reasons).
  let kind = themeBg();
  new MutationObserver(() => { const k = themeBg(); if (k === kind) return; kind = k; if (prefs.bg === 'auto' && last) show(last, true); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---------- frames ----------
  function show(m, keep) {
    if (loading) { loading.frame.remove(); loading = null; }
    $('message').classList.add('hidden');
    const sc = st.scroll[m.uri] || null;
    const bg = bgNow();
    const html = m.html.replace('/*HP_SCROLL*/null', JSON.stringify(sc && { x: sc.x | 0, y: sc.y | 0 }))
      .replace("/*HP_BG*/'light'", JSON.stringify(bg)).replace('/*HP_SEQ*/0', String(m.seq | 0));
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('title', 'Preview of ' + (m.name || 'the page'));
    f.className = 'loading' + (bg === 'dark' ? ' bg-dark' : '');
    sizeFrame(f, dims());
    f.srcdoc = html;
    const rec = { frame: f, seq: m.seq, uri: m.uri, created: Date.now(), pong: 0, booted: false, swapped: false, keep: !!keep, logs: [] };
    loading = rec;
    // The first load is the page itself. Another load means the page went to a different address (a script set
    // location, or the browser blocked that and shows its error page): stay on the file instead.
    f.addEventListener('load', () => { rec.loads = (rec.loads || 0) + 1; if (rec.loads > 1) leaving(rec); });
    wrap.appendChild(f);
    rec.timer = setTimeout(() => swap(rec), 2500);
  }
  function swap(rec) {
    if (rec.swapped || loading !== rec) return;
    rec.swapped = true; clearTimeout(rec.timer); rec.shownAt = Date.now();
    if (cur) cur.frame.remove();
    rec.frame.classList.remove('loading');
    cur = rec; loading = null;
    clearLog(); addNotes(last && last.notes);
    for (const l of rec.logs) addLog(l[0], l[1], l[2]);
    rec.logs = null;
    seqShown = rec.seq;
  }
  function frameOf(src) {
    if (cur && cur.frame.contentWindow === src) return cur;
    if (loading && loading.frame.contentWindow === src) return loading;
    return null;
  }

  // ---------- watchdog: a page that never answers is stopped ----------
  let pingN = 0;
  setInterval(() => {
    const now = Date.now();
    for (const r of [cur, loading]) {
      if (!r) continue;
      try { r.frame.contentWindow.postMessage({ hp: 1, t: 'ping', n: ++pingN }, '*'); } catch {}
      const since = r.pong || r.created;
      if (!r.left && now - since > stuckMs) { stuck(r); return; } // from creation: a page that loops at once never even says "boot"
    }
  }, 1000);
  setInterval(() => post({ type: 'alive', seq: seqShown }), 2000);

  function stuck(r) {
    for (const x of [cur, loading]) if (x) x.frame.remove();
    cur = null; loading = null;
    message('Scripts stopped', `The page's scripts kept the preview busy for ${Math.round(stuckMs / 1000)} s (an endless loop, perhaps). HTML Preview stopped them and shows the page without scripts.`);
    post({ type: 'stuck', seq: r.seq });
  }

  function leaving(r) {
    if (r.left || (r !== cur && r !== loading)) return;
    r.left = true;
    for (const x of [cur, loading]) if (x) x.frame.remove();
    cur = null; loading = null;
    message('Page left', 'The page tried to open another address. The preview stays on this file and shows it without scripts.');
    post({ type: 'leaving', seq: r.seq });
  }

  let hintTimer = 0;
  function hint(text) {
    const n = $('noticeBar');
    if (!n.classList.contains('hidden') && !n.dataset.hint) return; // a real notice stays
    $('noticeMsg').textContent = text; $('noticeAction').classList.add('hidden'); n.dataset.hint = '1'; n.classList.remove('hidden');
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { if (n.dataset.hint) { n.classList.add('hidden'); delete n.dataset.hint; } }, 4000);
  }

  function message(h, text, action) {
    const box = $('message');
    box.textContent = '';
    const d = document.createElement('div'); d.className = 'box';
    const h3 = document.createElement('h3'); h3.textContent = h; d.appendChild(h3);
    const p = document.createElement('p'); p.textContent = text; d.appendChild(p);
    if (action) {
      const b = document.createElement('button'); b.className = 'primary'; b.textContent = action.label;
      b.addEventListener('click', () => post({ type: 'action', id: action.id }));
      d.appendChild(b);
    }
    box.appendChild(d);
    box.classList.remove('hidden');
  }

  // ---------- console ----------
  function clearLog() { $('log').textContent = ''; counts = { warn: 0, error: 0 }; badge(); }
  function addLog(level, text, where) {
    const log = $('log');
    if (log.childElementCount > 1000) log.firstElementChild.remove();
    const d = document.createElement('div');
    d.className = level === 'warn' || level === 'error' ? level : level === 'note' ? 'note' : '';
    d.textContent = text;
    if (where) { const w = document.createElement('span'); w.className = 'where'; w.textContent = where; d.appendChild(w); }
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.appendChild(d);
    if (atEnd) log.scrollTop = log.scrollHeight;
    if (level === 'warn' || level === 'error') { counts[level]++; badge(); }
  }
  function addNotes(notes) { for (const n of notes || []) addLog(n.level === 'warn' ? 'warn' : 'note', 'HTML Preview: ' + n.text); }
  function badge() {
    const n = counts.warn + counts.error;
    const b = $('consoleBadge');
    b.textContent = n ? String(n) : '';
    b.classList.toggle('hidden', !n);
    b.classList.toggle('err', counts.error > 0);
  }
  function setConsole(open) { prefs.console = open; $('console').classList.toggle('hidden', !open); $('consoleBtn').classList.toggle('on', open); layout(); }

  // ---------- messages ----------
  // VS Code's messages come from this webview's own origin. The page frame and anything inside it have no origin
  // ("null"), so they can never pass as VS Code; their messages are taken only from the frame this script made.
  const OWN = location.origin;
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (e.origin === 'null') {
      const r = frameOf(e.source);
      if (r && d.hp === 1) fromPage(r, d);
      return;
    }
    if (OWN && OWN !== 'null' ? e.origin === OWN : true) fromExtension(d);
  });

  function fromPage(r, d) {
    r.pong = Date.now();
    switch (d.t) {
      case 'boot': r.booted = true; break;
      case 'pong': break;
      case 'loaded':
        if (r === loading) swap(r);
        $('bg').title = d.hasBg ? 'This page sets its own background' : 'Background for pages that set none';
        if (r === cur) post({ type: 'rendered', seq: r.seq, title: String(d.title || '').slice(0, 200), elements: d.elements | 0, hasBg: !!d.hasBg });
        break;
      case 'load': break;
      case 'console': {
        const l = [String(d.level), String(d.text || '').slice(0, 4000), String(d.where || '').slice(0, 40)];
        if (r === cur && !r.logs) addLog(l[0], l[1], l[2]);
        else if (r.logs && r.logs.length < 1000) r.logs.push(l); // shown when this frame is swapped in
        break;
      }
      case 'leaving': leaving(r); break;
      case 'scroll':
        if (r !== cur) break;
        st.scroll[r.uri] = { x: Number(d.x) || 0, y: Number(d.y) || 0 };
        clearTimeout(saveTimer); saveTimer = setTimeout(() => vscode.setState(st), 300);
        break;
      case 'link':
        // Only a real click opens a link. Web and mail links (they open a dialog) need a click made after this page
        // appeared; a link to another local page only needs the user to be active now.
        if (r === cur && typeof d.href === 'string' && (/^\s*([a-z][a-z0-9+.-]*:|\/\/)/i.test(d.href) ? userActedOn(r) : (UA ? sawActivation() : true))) post({ type: 'link', href: d.href.slice(0, 4000), newTab: !!d.newTab });
        else { refused++; if (r === cur && UA && UA.isActive) hint('Click the link once more to open it.'); }
        break;
      case 'copy':
        // Only after the user pressed a key or clicked since this page appeared.
        if (r === cur && typeof d.text === 'string' && d.text && userActedOn(r)) post({ type: 'copy', text: d.text });
        else refused++;
        break;
      case 'reload':
        // F5 inside the page: only a real key press, never a script (a script could reload the page forever)
        if (r === cur && userActedOn(r)) post({ type: 'reload' }); else refused++;
        break;
      case 'key':
        try { window.dispatchEvent(new KeyboardEvent('keydown', { key: String(d.key), code: String(d.code), ctrlKey: !!d.ctrlKey, metaKey: !!d.metaKey, shiftKey: !!d.shiftKey, altKey: !!d.altKey, bubbles: true, cancelable: true })); } catch {}
        break;
    }
  }

  function fromExtension(m) {
    switch (m.type) {
      case 'init':
        prefs = Object.assign(prefs, m.prefs || {});
        stuckMs = Math.max(2000, (Number(m.stuckSeconds) || 5) * 1000);
        applyPrefsToUi();
        break;
      case 'render': {
        last = m;
        st.uri = m.uri; vscode.setState(st);
        $('file').textContent = '';
        const b = document.createElement('b'); b.textContent = m.name || ''; $('file').appendChild(b);
        if (m.folder) $('file').appendChild(document.createTextNode('  ' + m.folder));
        $('file').title = m.path || '';
        $('back').disabled = !m.canBack; $('forward').disabled = !m.canForward;
        $('js').classList.toggle('on', !!m.scripts); $('js').textContent = m.scripts ? 'JS on' : 'JS off';
        $('js').disabled = !!m.scriptsLocked;
        $('browser').classList.toggle('hidden', !m.canOpenBrowser);
        remoteBar(m);
        notice(m.notice);
        show(m, m.keep);
        break;
      }
      case 'message':
        if (loading) { loading.frame.remove(); loading = null; }
        if (cur) { cur.frame.remove(); cur = null; }
        last = null;
        $('remoteBar').classList.add('hidden'); $('remoteList').classList.add('hidden'); notice(null);
        if (m.name) { $('file').textContent = ''; const b = document.createElement('b'); b.textContent = m.name; $('file').appendChild(b); }
        message(m.heading || 'HTML Preview', m.text || '', m.action);
        break;
      case 'scrollTo':
        synced++;
        if (cur) try { cur.frame.contentWindow.postMessage({ hp: 1, t: 'scrollTo', f: Number(m.f) || 0 }, '*'); } catch {}
        break;
    }
  }

  function remoteBar(m) {
    const r = m.remote || { count: 0 };
    const bar = $('remoteBar'), list = $('remoteList');
    if (!r.count) { bar.classList.add('hidden'); list.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const hosts = (r.hosts || []).slice(0, 3).join(', ') + ((r.hosts || []).length > 3 ? ', …' : '');
    if (m.remoteAllowed) {
      $('remoteMsg').textContent = `Web resources are on for this page (${r.unique} from ${hosts}).` + (m.remoteAllowed === 'setting' ? ' Setting: htmlPreview.loadRemoteResources.' : '');
      $('remoteLoad').classList.add('hidden'); $('remoteAlways').classList.add('hidden');
      $('remoteBlock').classList.toggle('hidden', m.remoteAllowed === 'setting');
    } else {
      $('remoteMsg').textContent = `This page asks for ${r.unique} web resource${r.unique === 1 ? '' : 's'} (${hosts}). Nothing was loaded from the web.`;
      $('remoteLoad').classList.remove('hidden'); $('remoteAlways').classList.remove('hidden'); $('remoteBlock').classList.add('hidden');
    }
    list.textContent = '';
    for (const u of r.urls || []) { const li = document.createElement('li'); li.textContent = u; list.appendChild(li); }
  }
  function notice(n) {
    const bar = $('noticeBar');
    delete bar.dataset.hint;
    if (!n) { bar.classList.add('hidden'); return; }
    $('noticeMsg').textContent = n.text;
    const b = $('noticeAction');
    if (n.action) { b.textContent = n.action.label; b.dataset.id = n.action.id; b.classList.remove('hidden'); } else b.classList.add('hidden');
    bar.classList.remove('hidden');
  }

  // ---------- toolbar ----------
  function applyPrefsToUi() {
    $('width').value = String(prefs.width);
    $('custom').value = String(clampW(prefs.custom));
    $('custom').classList.toggle('hidden', prefs.width !== 'custom');
    $('zoom').value = String(prefs.zoom);
    $('bg').value = prefs.bg;
    $('sync').classList.toggle('on', !!prefs.sync);
    setConsole(!!prefs.console);
    layout();
  }
  const savePrefs = () => post({ type: 'prefs', prefs });
  $('width').addEventListener('change', e => { prefs.width = e.target.value; applyPrefsToUi(); savePrefs(); });
  $('custom').addEventListener('change', e => { prefs.custom = clampW(e.target.value); applyPrefsToUi(); savePrefs(); });
  $('zoom').addEventListener('change', e => { prefs.zoom = e.target.value; layout(); savePrefs(); });
  $('bg').addEventListener('change', e => { prefs.bg = e.target.value; savePrefs(); if (last) show(last, true); });
  $('sync').addEventListener('click', () => { prefs.sync = !prefs.sync; applyPrefsToUi(); savePrefs(); });
  $('consoleBtn').addEventListener('click', () => { setConsole(!prefs.console); savePrefs(); });
  $('clearLog').addEventListener('click', clearLog);
  $('back').addEventListener('click', () => post({ type: 'nav', dir: -1 }));
  $('forward').addEventListener('click', () => post({ type: 'nav', dir: 1 }));
  $('reload').addEventListener('click', () => post({ type: 'reload' }));
  $('js').addEventListener('click', () => post({ type: 'scripts', on: !(last && last.scripts) }));
  $('browser').addEventListener('click', () => post({ type: 'openBrowser' }));
  $('remoteLoad').addEventListener('click', () => post({ type: 'remote', mode: 'file' }));
  $('remoteAlways').addEventListener('click', () => post({ type: 'remote', mode: 'always' }));
  $('remoteBlock').addEventListener('click', () => post({ type: 'remote', mode: 'block' }));
  $('remoteDetails').addEventListener('click', () => $('remoteList').classList.toggle('hidden'));
  $('noticeAction').addEventListener('click', e => post({ type: 'action', id: e.target.dataset.id }));
  document.addEventListener('keydown', e => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.shiftKey)) { e.preventDefault(); post({ type: 'reload' }); }
  });

  // State for the real-app gate and for bug reports (no page content, only what the toolbar shows).
  function probe() {
    return {
      seq: seqShown, frames: wrap.querySelectorAll('iframe').length, sandbox: cur ? cur.frame.getAttribute('sandbox') : null,
      width: dims().W, zoom: dims().z, prefs, counts, remoteBar: !$('remoteBar').classList.contains('hidden'), remoteMsg: $('remoteMsg').textContent,
      notice: $('noticeBar').classList.contains('hidden') ? '' : $('noticeMsg').textContent,
      message: $('message').classList.contains('hidden') ? '' : $('message').textContent,
      log: [...$('log').children].slice(-50).map(x => x.textContent), back: !$('back').disabled, forward: !$('forward').disabled,
      file: $('file').textContent, js: $('js').textContent, bg: bgNow(), synced, refused, ua: { active: !!(UA && UA.isActive), wasActive, activatedAt, shownAt: cur ? cur.shownAt : 0, now: Date.now() },
    };
  }
  window.htmlPreviewProbe = probe;

  post({ type: 'ready', uri: st.uri || '' });
})();
