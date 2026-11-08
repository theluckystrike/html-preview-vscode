/* HTML Preview: runs first inside the previewed page (a sandboxed frame with no origin of its own). It reports
   console messages, link clicks, scroll position and copies to the preview toolbar frame, and answers its pings so
   a page stuck in a loop can be found. It can only talk to its parent frame; it has no access to VS Code. */
(function () {
  'use strict';
  var C = { scroll: /*HP_SCROLL*/null, bg: /*HP_BG*/'light', seq: /*HP_SEQ*/0 };
  var P = window.parent;
  if (!P || P === window) return;
  var post = function (m) { try { m.hp = 1; m.seq = C.seq; P.postMessage(m, '*'); } catch (e) {} };
  var str = function (v) {
    try {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message;
      if (v && typeof v === 'object') { var s = JSON.stringify(v); return s && s.length > 2000 ? s.slice(0, 2000) + '…' : s; }
      return String(v);
    } catch (e) { return Object.prototype.toString.call(v); }
  };
  var sent = 0;
  var log = function (level, args, where) {
    if (sent++ > 2000) return;
    var parts = []; for (var i = 0; i < args.length; i++) parts.push(str(args[i]));
    post({ t: 'console', level: level, text: parts.join(' ').slice(0, 4000), where: where || '' });
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () { log(k, arguments); if (orig) return orig.apply(console, arguments); };
  });
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) { log('error', ['Could not load <' + t.tagName.toLowerCase() + '> ' + (t.getAttribute('data-html-preview-missing') || t.getAttribute('src') || t.getAttribute('href') || '').slice(0, 300)]); return; }
    log('error', [e.message || 'Script error'], e.lineno ? 'line ' + e.lineno + (e.colno ? ':' + e.colno : '') : '');
  }, true);
  window.addEventListener('unhandledrejection', function (e) { log('error', ['Unhandled promise rejection:', e.reason]); });

  // Dialogs do not open inside VS Code webviews: show them in the console instead.
  window.alert = function (m) { log('info', ['alert(): ' + str(m)]); };
  window.confirm = function (m) { log('info', ['confirm(): ' + str(m) + ' (answered Cancel)']); return false; };
  window.prompt = function (m) { log('info', ['prompt(): ' + str(m) + ' (answered with nothing)']); return null; };
  window.open = function (u) { if (u) post({ t: 'link', href: String(u), newTab: true }); return null; };

  // A frame without an origin cannot use localStorage or sessionStorage. Give the page an in-memory stand-in.
  var memStore = function () {
    var d = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return k in d ? d[k] : null; },
      setItem: function (k, v) { d[String(k)] = String(v); },
      removeItem: function (k) { delete d[String(k)]; },
      clear: function () { d = Object.create(null); },
      key: function (i) { return Object.keys(d)[i] || null; },
      get length() { return Object.keys(d).length; },
    };
  };
  ['localStorage', 'sessionStorage'].forEach(function (k) {
    var ok = false; try { ok = !!window[k]; } catch (e) {}
    if (!ok) try { Object.defineProperty(window, k, { value: memStore(), configurable: true }); } catch (e) {}
  });
  try { var ck = ''; Object.defineProperty(document, 'cookie', { get: function () { return ck; }, set: function (v) { ck = String(v).split(';')[0]; }, configurable: true }); } catch (e) {}

  // Links: same-page anchors scroll here; every other link goes to VS Code, which decides what to do.
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button > 1) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') {
      e.preventDefault();
      var id = decodeURIComponent(href.slice(1));
      var el = id ? (document.getElementById(id) || document.getElementsByName(id)[0]) : document.documentElement;
      if (el && el.scrollIntoView) el.scrollIntoView();
      return;
    }
    e.preventDefault();
    post({ t: 'link', href: href, newTab: a.getAttribute('target') === '_blank' || e.button === 1 || e.ctrlKey || e.metaKey });
  }, false);
  window.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    e.preventDefault();
    var f = e.target;
    var n = 0; try { n = new FormData(f).getAll ? Array.from(new FormData(f).keys()).length : 0; } catch (x) {}
    log('info', ['Form submit (not sent by the preview): ' + ((f.getAttribute && f.getAttribute('method')) || 'get').toUpperCase() + ' ' + ((f.getAttribute && f.getAttribute('action')) || '(this page)') + ', ' + n + ' field(s)']);
  }, false);

  // Copy: the frame copies itself, and also hands the text to VS Code, which puts it on the clipboard.
  var sendCopy = function () { var s = ''; try { s = String(window.getSelection()); } catch (e) {} if (s) post({ t: 'copy', text: s.slice(0, 5000000) }); };
  window.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) { if (e.key === 'F5') { e.preventDefault(); post({ t: 'reload' }); } return; }
    var k = (e.key || '').toLowerCase();
    if (k === 'c' || k === 'insert') { sendCopy(); return; }
    if (k === 'a' || k === 'x' || k === 'v' || k === 'z' || k === 'y' || k === 'f') return;
    // Other shortcuts (Cmd+P, Cmd+W ...) belong to VS Code.
    post({ t: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey });
  }, true);

  // Scroll position: kept by the toolbar frame and given back on the next update.
  var restore = function () { if (C.scroll && (C.scroll.x || C.scroll.y)) window.scrollTo(C.scroll.x || 0, C.scroll.y || 0); };
  var timer = 0;
  window.addEventListener('scroll', function () {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      var h = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      post({ t: 'scroll', x: window.scrollX, y: window.scrollY, f: Math.min(1, window.scrollY / h) });
    }, 80);
  }, { passive: true });

  window.addEventListener('message', function (e) {
    if (e.source !== P) return;
    var m = e.data;
    if (!m || m.hp !== 1) return;
    if (m.t === 'ping') post({ t: 'pong', n: m.n });
    else if (m.t === 'scrollTo') {
      var h = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(window.scrollX, Math.round(h * Math.max(0, Math.min(1, Number(m.f) || 0))));
    }
  });

  var hasBg = function () {
    var see = function (el) {
      if (!el) return false;
      var cs = getComputedStyle(el);
      var c = cs.backgroundColor || '';
      var transparent = c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
      return !transparent || (cs.backgroundImage && cs.backgroundImage !== 'none');
    };
    return see(document.documentElement) || see(document.body);
  };
  var themed = false;
  var applyBg = function () {
    var own = hasBg();
    if (!own && C.bg === 'dark' && !themed) {
      themed = true;
      var s = document.createElement('style');
      s.setAttribute('data-html-preview', 'dark-default');
      s.textContent = ':where(html){color:#d4d4d4;color-scheme:dark}:where(a:link){color:#4daafc}:where(a:visited){color:#c586c0}';
      (document.head || document.documentElement).appendChild(s);
    }
    return own;
  };
  var ready = function () {
    restore();
    var own = applyBg();
    post({ t: 'loaded', hasBg: own, title: document.title || '', elements: document.getElementsByTagName('*').length });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else setTimeout(ready, 0);
  window.addEventListener('load', function () { restore(); post({ t: 'load' }); });
  // A script that sets location (or a form the page submits itself) would replace this page. The preview stays on
  // the file instead and tells the toolbar, which shows the page again without scripts.
  window.addEventListener('beforeunload', function () { post({ t: 'leaving' }); });
  post({ t: 'boot' });
})();
