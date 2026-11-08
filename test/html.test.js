'use strict';
// Tests for src/html.js (toolbar page, CSP, bootstrap tag) and static checks on media/preview.js and media/inner.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../src/html.js');

const MEDIA = path.join(__dirname, '..', 'media');
const directives = s => Object.fromEntries(s.split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('csp(false): default-src none, connect-src none, form-action none, no web sources', () => {
  const c = H.csp(false);
  const d = directives(c);
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['frame-src'], ["'none'"]);
  assert.deepEqual(d['worker-src'], ["'none'"]);
  assert.doesNotMatch(c, /https?:/);
  assert.doesNotMatch(c, /\*/);
  for (const k of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
    assert.ok(d[k], k);
    assert.ok(d[k].every(v => ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:'].includes(v)), `${k}: ${d[k]}`);
  }
});

test('csp(true): web sources only for content types; connect-src and form-action stay none', () => {
  const c = H.csp(true);
  const d = directives(c);
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['object-src'], ["'none'"]);
  for (const k of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) assert.ok(d[k].includes('https:'), k);
  for (const k of ['connect-src', 'form-action', 'worker-src', 'object-src', 'manifest-src', 'child-src', 'default-src']) assert.ok(!d[k].some(v => /^https?:/.test(v)), k);
  assert.doesNotMatch(c, /\*/);
});

const footerRe = /<div class="zovo-support[^"]*" id="zovo-support">[\s\S]*?<\/div>/;

for (const remote of [false, true]) {
  test(`buildHtml(remote=${remote}): CSP meta, no <script src=, no web URL outside the support footer`, () => {
    const html = H.buildHtml({ remote, showSupportLinks: true });
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    assert.ok(meta, 'CSP meta present');
    assert.equal(meta[1], H.esc(H.csp(remote)));
    assert.ok(html.indexOf(meta[0]) < html.indexOf('<script'), 'CSP comes before any script');
    assert.doesNotMatch(html, /<script[^>]*\ssrc\s*=/i);
    assert.doesNotMatch(html, /<link[^>]*\shref\s*=\s*"https?:/i);
    assert.ok(footerRe.test(html), 'footer present');
    const rest = html.replace(footerRe, '');
    assert.doesNotMatch(rest, /https?:\/\//);
    assert.doesNotMatch(rest, /["'(]\/\/[a-z0-9]/i, 'no protocol-relative URLs');
  });
}

test('buildHtml without support links has no footer and no web URL at all', () => {
  const html = H.buildHtml({ remote: false, showSupportLinks: false });
  assert.doesNotMatch(html, /zovo-support"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('buildHtml: footer links are command: links or https Marketplace/sponsor links only', () => {
  const html = H.buildHtml({ remote: false, showSupportLinks: true });
  const hrefs = [...footerRe.exec(html)[0].matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  assert.ok(hrefs.length >= 2);
  for (const h of hrefs) assert.match(h, /^(command:htmlPreview\.|command:workbench\.action\.openSettings\?|https:\/\/)/, h);
});

test('buildHtml: exactly one inline <script> (the toolbar) and it holds media/preview.js', () => {
  const html = H.buildHtml({ remote: false });
  assert.equal((html.match(/<script/gi) || []).length, 1);
  const js = fs.readFileSync(path.join(MEDIA, 'preview.js'), 'utf8');
  assert.ok(html.includes('<script>' + js + '</script>'));
  assert.doesNotMatch(js, /<\/script/i, 'preview.js cannot end its own script tag');
});

test('bootstrapTag wraps media/inner.js in one data-html-preview script', () => {
  const tag = H.bootstrapTag();
  assert.ok(tag.startsWith('<script data-html-preview="bootstrap">'));
  assert.ok(tag.endsWith('</script>'));
  assert.equal((tag.match(/<\/script/gi) || []).length, 1);
  const body = tag.slice('<script data-html-preview="bootstrap">'.length, -'</script>'.length);
  // one line, so error line numbers in the page match the user's file; still valid JavaScript
  assert.equal(body.split('\n').length, 1);
  assert.doesNotThrow(() => new (require('vm').Script)(body));
  for (const k of ['/*HP_SCROLL*/null', "/*HP_BG*/'light'", '/*HP_SEQ*/0']) assert.ok(body.includes(k), 'placeholder ' + k + ' is gone');
  for (const k of ['acquire', "t: 'boot'", "t: 'pong'", "t: 'leaving'", 'beforeunload']) if (k !== 'acquire') assert.ok(body.includes(k), k);
});

test('bootstrapTag escapes </script in the bootstrap source (any case)', () => {
  const htmlPath = require.resolve('../src/html.js');
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...a) {
    if (String(p).endsWith(path.join('media', 'inner.js'))) return 'var a = "</script>"; var b = "</SCRIPT >"; var c = "<\\/script>";';
    return realRead.call(this, p, ...a);
  };
  const saved = require.cache[htmlPath];
  delete require.cache[htmlPath];
  try {
    const fresh = require('../src/html.js');
    const tag = fresh.bootstrapTag();
    assert.equal((tag.match(/<\/script/gi) || []).length, 1, tag);
    assert.match(tag, /var a = "<\\\/script>"; var b = "<\\\/script >"; var c = "<\\\/script>";/i);
  } finally {
    fs.readFileSync = realRead;
    require.cache[htmlPath] = saved;
  }
});

test('esc escapes the five HTML characters', () => {
  assert.equal(H.esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

// ---------- static checks on the webview scripts ----------

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

for (const f of ['inner.js', 'preview.js']) {
  test(`media/${f} has no network API (fetch, XMLHttpRequest, WebSocket, sendBeacon, importScripts, EventSource)`, () => {
    const src = stripComments(fs.readFileSync(path.join(MEDIA, f), 'utf8'));
    for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /importScripts/, /EventSource/, /RTCPeerConnection/]) assert.doesNotMatch(src, re, `${f}: ${re}`);
  });
}

test('media/preview.js takes page messages only from origin "null" and from its own frame', () => {
  const src = fs.readFileSync(path.join(MEDIA, 'preview.js'), 'utf8');
  const listeners = [...src.matchAll(/addEventListener\(\s*['"]message['"]/g)];
  assert.equal(listeners.length, 1, 'one message listener');
  const start = listeners[0].index;
  const body = src.slice(start, src.indexOf('\n  });', start));
  // the page branch: origin must be the opaque "null", the source must be a frame this script made, and hp === 1
  const branch = /if \(e\.origin === 'null'\) \{([\s\S]*?)return;\s*\}/.exec(body);
  assert.ok(branch, 'origin === "null" branch');
  assert.match(branch[1], /const r = frameOf\(e\.source\)/);
  assert.match(branch[1], /if \(r && d\.hp === 1\) fromPage\(r, d\)/);
  // fromPage is never called outside that branch
  assert.equal((src.match(/fromPage\(/g) || []).length, 2, 'one definition, one call');
  // frameOf compares contentWindow identity with the current/loading frame only
  const fo = /function frameOf\(src\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(fo);
  assert.match(fo[1], /cur\.frame\.contentWindow === src/);
  assert.match(fo[1], /loading\.frame\.contentWindow === src/);
  assert.match(fo[1], /return null;/);
  // extension messages: same origin as the webview itself
  assert.match(body, /e\.origin === OWN/);
  assert.match(src, /const OWN = location\.origin;/);
});

test('media/inner.js takes messages only from its parent', () => {
  const src = fs.readFileSync(path.join(MEDIA, 'inner.js'), 'utf8');
  const listeners = [...src.matchAll(/addEventListener\(\s*['"]message['"]/g)];
  assert.equal(listeners.length, 1);
  assert.match(src.slice(listeners[0].index, listeners[0].index + 200), /if \(e\.source !== P\) return;/);
});
