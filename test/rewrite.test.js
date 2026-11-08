'use strict';
// Unit tests for src/core/rewrite.js: one HTML page -> one self-contained srcdoc document. A small in-memory file
// system stands in for the host's read(); nothing touches the disk or the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteHtml, resolveLink, INERT_IMG } = require('../src/core/rewrite.js');

const ROOT = 'file:///site/';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const b64 = b => Buffer.from(b).toString('base64');

/** files: { '/site/a.png': Buffer|string }. Mimics the host: only file: URLs under /site/ can be read. */
function fsCtx(files, over = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
  const reads = [];
  const ctx = {
    docUrl: ROOT + 'index.html',
    rootUrl: ROOT,
    allowRemote: false,
    scripts: true,
    inject: '',
    read: async url => {
      reads.push(url);
      const u = new URL(url);
      if (u.protocol !== 'file:' || !decodeURIComponent(u.pathname).startsWith('/site/')) { const e = new Error('outside'); e.code = 'OUTSIDE'; throw e; }
      const p = decodeURIComponent(u.pathname);
      if (over.errors && over.errors[p]) { const e = new Error(over.errors[p]); e.code = over.errors[p]; throw e; }
      if (!map.has(p)) { const e = new Error('nf'); e.code = 'ENOENT'; throw e; }
      return new Uint8Array(map.get(p));
    },
    ...over,
  };
  delete ctx.errors;
  return { ctx, reads };
}
const run = async (html, files = {}, over = {}) => { const { ctx, reads } = fsCtx(files, over); const r = await rewriteHtml(html, ctx); r.reads = reads; return r; };
const dataText = u => { const m = /^data:[^;,]*;base64,(.*)$/s.exec(u); assert.ok(m, 'expected a base64 data: URL, got ' + String(u).slice(0, 80)); return Buffer.from(m[1], 'base64').toString('utf8'); };
const attr = (html, tag, name) => { const m = new RegExp(`<${tag}\\b[^>]*?\\s${name}="([^"]*)"`, 'i').exec(html); return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null; };
const pngUrl = b => 'data:image/png;base64,' + b64(b);
const hasNote = (r, re) => r.notes.some(n => re.test(n.text));

// ---------- paths ----------

test('relative image becomes a data: URL with the right MIME type and is a dep', async () => {
  const r = await run('<p><img src="a.png" alt="x"></p>', { '/site/a.png': PNG });
  assert.equal(attr(r.html, 'img', 'src'), pngUrl(PNG));
  assert.match(r.html, /alt="x"/);
  assert.deepEqual(r.deps, ['file:///site/a.png']);
  assert.equal(r.remote.count, 0);
  assert.equal(r.bytes, PNG.length);
});

test('../ and ./ paths resolve against the page folder', async () => {
  const files = { '/site/img/up.png': PNG, '/site/pages/here.png': PNG2 };
  const r = await run('<img id=a src="../img/up.png"><img id=b src="./here.png">', files, { docUrl: ROOT + 'pages/index.html' });
  assert.ok(r.html.includes(pngUrl(PNG)), '../ path');
  assert.ok(r.html.includes(pngUrl(PNG2)), './ path');
  assert.deepEqual(r.deps.sort(), ['file:///site/img/up.png', 'file:///site/pages/here.png']);
});

test('paths with spaces: raw and %20 read the same file', async () => {
  const r = await run('<img src="my pic.png"><img src="my%20pic.png">', { '/site/my pic.png': PNG });
  assert.equal(r.html.split(pngUrl(PNG)).length - 1, 2);
  assert.equal(r.notes.length, 0);
  assert.deepEqual(r.deps, ['file:///site/my%20pic.png']);
});

test('non-ASCII file and folder names are read', async () => {
  const r = await run('<img src="café/ñandú.png"><link rel="stylesheet" href="стиль.css">', { '/site/café/ñandú.png': PNG, '/site/стиль.css': 'p{color:red}' });
  assert.ok(r.html.includes(pngUrl(PNG)));
  assert.equal(dataText(attr(r.html, 'link', 'href')), 'p{color:red}');
  assert.equal(r.notes.length, 0);
});

test('"/x" paths resolve against rootUrl, not the page folder', async () => {
  const r = await run('<img src="/img/r.png">', { '/site/img/r.png': PNG }, { docUrl: ROOT + 'deep/er/page.html' });
  assert.ok(r.html.includes(pngUrl(PNG)));
  assert.deepEqual(r.deps, ['file:///site/img/r.png']);
});

test('query and fragment on a local URL are dropped before reading', async () => {
  const r = await run('<img src="a.png?v=3#x">', { '/site/a.png': PNG });
  assert.ok(r.html.includes(pngUrl(PNG)));
  assert.deepEqual(r.reads, ['file:///site/a.png']);
});

// ---------- <base> ----------

test('<base href> local: later paths read from there, tag removed, note added, result.base set', async () => {
  const r = await run('<head><base href="assets/"></head><img src="a.png">', { '/site/assets/a.png': PNG });
  assert.ok(r.html.includes(pngUrl(PNG)));
  assert.doesNotMatch(r.html, /<base\s/i);
  assert.match(r.html, /<base> applied by the preview/);
  assert.equal(r.base, 'file:///site/assets/');
  assert.ok(hasNote(r, /relative paths are read from there/));
});

test('<base href> remote: relative images become remote (inert, counted), nothing local is read', async () => {
  const r = await run('<base href="https://example.com/app/"><img src="a.png"><img src="/b.png">', { '/site/a.png': PNG });
  assert.equal(r.reads.length, 0);
  const srcs = [...r.html.matchAll(/<img src="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(srcs, [INERT_IMG, INERT_IMG]);
  assert.deepEqual(r.remote.urls.sort(), ['https://example.com/app/a.png', 'https://example.com/b.png']);
  assert.deepEqual(r.remote.hosts, ['example.com']);
  assert.ok(hasNote(r, /relative links point to that web site/));
  assert.equal(r.base, 'https://example.com/app/');
});

test('<base href> remote: relative <link stylesheet> and <script src> are treated as remote, not read', async () => {
  const r = await run('<base href="https://example.com/"><link rel="stylesheet" href="s.css"><script src="app.js"></script>', {});
  assert.equal(r.reads.length, 0, 'read() was called with ' + r.reads.join(', '));
  assert.ok(r.remote.urls.includes('https://example.com/s.css'));
  assert.ok(r.remote.urls.includes('https://example.com/app.js'));
  assert.ok(!hasNote(r, /outside the workspace/));
});

// ---------- srcset / picture ----------

test('srcset with 1x/2x descriptors keeps the descriptors', async () => {
  const r = await run('<img src="a.png" srcset="a.png 1x, b.png 2x">', { '/site/a.png': PNG, '/site/b.png': PNG2 });
  assert.equal(attr(r.html, 'img', 'srcset'), `${pngUrl(PNG)} 1x, ${pngUrl(PNG2)} 2x`);
});

test('srcset with w descriptors and sizes', async () => {
  const r = await run('<img srcset="s.png 320w,l.png 1024w" sizes="(max-width: 600px) 320px, 1024px">', { '/site/s.png': PNG, '/site/l.png': PNG2 });
  assert.equal(attr(r.html, 'img', 'srcset'), `${pngUrl(PNG)} 320w, ${pngUrl(PNG2)} 1024w`);
  assert.equal(attr(r.html, 'img', 'sizes'), '(max-width: 600px) 320px, 1024px');
});

test('srcset with a remote candidate: local inlined, remote inert and counted', async () => {
  const r = await run('<img srcset="a.png 1x, https://cdn.example.com/b.png 2x">', { '/site/a.png': PNG });
  assert.equal(attr(r.html, 'img', 'srcset'), `${pngUrl(PNG)} 1x, ${INERT_IMG} 2x`);
  assert.equal(r.remote.count, 1);
});

test('<picture><source srcset> and fallback <img>', async () => {
  const html = '<picture><source srcset="w.webp" type="image/webp"><source media="(min-width:800px)" srcset="big.png 2x"><img src="a.png"></picture>';
  const r = await run(html, { '/site/w.webp': PNG2, '/site/big.png': PNG, '/site/a.png': PNG });
  assert.ok(r.html.includes('srcset="data:image/webp;base64,' + b64(PNG2) + '"'));
  assert.ok(r.html.includes(`srcset="${pngUrl(PNG)} 2x"`));
  assert.ok(r.html.includes(`<img src="${pngUrl(PNG)}">`));
  assert.match(r.html, /<\/picture>$/);
});

test('<video>, <audio>, <source> media, <track> and poster', async () => {
  const html = '<video src="v.mp4" poster="p.png"><track src="c.vtt"></video><audio><source src="s.mp3" type="audio/mpeg"></audio>';
  const r = await run(html, { '/site/v.mp4': 'V', '/site/p.png': PNG, '/site/c.vtt': 'WEBVTT', '/site/s.mp3': 'M' });
  assert.ok(r.html.includes('src="data:video/mp4;base64,' + b64('V') + '"'));
  assert.ok(r.html.includes(`poster="${pngUrl(PNG)}"`));
  assert.ok(r.html.includes('src="data:text/vtt;base64,' + b64('WEBVTT') + '"'));
  assert.ok(r.html.includes('src="data:audio/mpeg;base64,' + b64('M') + '"'));
});

// ---------- CSS ----------

test('CSS url() quoted and unquoted in <style>', async () => {
  const css = '.a{background:url(a.png)} .b{background:url("b.png")} .c{background:url( \'a.png\' )} .d{background:url(data:image/gif;base64,R0)}';
  const r = await run(`<style>${css}</style>`, { '/site/a.png': PNG, '/site/b.png': PNG2 });
  assert.ok(r.html.includes(`.a{background:url("${pngUrl(PNG)}")}`));
  assert.ok(r.html.includes(`.b{background:url("${pngUrl(PNG2)}")}`));
  assert.ok(r.html.includes(`.c{background:url("${pngUrl(PNG)}")}`));
  assert.ok(r.html.includes('url(data:image/gif;base64,R0)'), 'data: URLs are left alone');
});

test('CSS comments are kept and url() inside them is not read', async () => {
  const r = await run('<style>/* url(x.png) */ p{}</style>', {});
  assert.ok(r.html.includes('/* url(x.png) */ p{}'));
  assert.equal(r.reads.length, 0);
});

test('</style inside CSS cannot close the style element early', async () => {
  const r = await run('<link rel="stylesheet" href="a.css"><style>p{} </style ><p>after</p>', { '/site/a.css': 'p::after{content:"</style>"}' });
  assert.equal(dataText(attr(r.html, 'link', 'href')), 'p::after{content:"</style>"}');
  assert.match(r.html, /<p>after<\/p>$/);
});

test('@import "x.css" and @import url(x.css) with a media query (wrapped in @media)', async () => {
  const files = { '/site/main.css': '@import "x.css";\n@import url(y.css) screen and (min-width: 600px);\n@import url("z.css") all;\nbody{}', '/site/x.css': '.x{}', '/site/y.css': '.y{}', '/site/z.css': '.z{}' };
  const r = await run('<link rel="stylesheet" href="main.css">', files);
  const css = dataText(attr(r.html, 'link', 'href'));
  assert.ok(css.startsWith('.x{}\n'), css);
  assert.ok(css.includes('@media screen and (min-width: 600px) {\n.y{}\n}'), css);
  assert.ok(css.includes('.z{}') && !css.includes('@media all'), css);
  assert.doesNotMatch(css, /@import/);
  assert.deepEqual(r.deps.sort(), ['file:///site/main.css', 'file:///site/x.css', 'file:///site/y.css', 'file:///site/z.css']);
});

test('@import in an inline <style> and @import with single quotes', async () => {
  const r = await run("<style>@import 'x.css' print; p{}</style>", { '/site/x.css': '.x{}' });
  assert.ok(r.html.includes('<style>@media print {\n.x{}\n} p{}</style>'));
});

test('@import loop is cut with a comment, not followed forever', async () => {
  const files = { '/site/a.css': '@import "b.css"; .a{}', '/site/b.css': '@import "a.css"; .b{}', '/site/self.css': '@import "self.css"; .s{}' };
  const r = await run('<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="self.css">', files);
  const [a, s] = [...r.html.matchAll(/href="([^"]*)"/g)].map(m => dataText(m[1]));
  assert.ok(a.includes('/* html-preview: @import loop: a.css */ .b{}'), a);
  assert.ok(a.includes('.a{}'));
  assert.ok(s.includes('@import loop: self.css'), s);
});

test('nested CSS url() resolves relative to the CSS file, not the page', async () => {
  const files = {
    '/site/css/site.css': '@import "parts/btn.css"; body{background:url(../img/bg.png)}',
    '/site/css/parts/btn.css': '.btn{background:url(icon.png)}',
    '/site/img/bg.png': PNG, '/site/css/parts/icon.png': PNG2,
    '/site/bg.png': Buffer.from('wrong'), '/site/icon.png': Buffer.from('wrong'),
  };
  const r = await run('<link rel="stylesheet" href="css/site.css">', files);
  const css = dataText(attr(r.html, 'link', 'href'));
  assert.ok(css.includes(`body{background:url("${pngUrl(PNG)}")}`), css);
  assert.ok(css.includes(`.btn{background:url("${pngUrl(PNG2)}")}`), css);
  assert.equal(r.notes.length, 0);
});

test('fonts in @font-face get font MIME types', async () => {
  const css = '@font-face{font-family:F;src:url(f/a.woff2?v=1) format("woff2"),url("f/a.woff") format("woff"),url(f/a.ttf)}';
  const r = await run(`<style>${css}</style>`, { '/site/f/a.woff2': 'W2', '/site/f/a.woff': 'W1', '/site/f/a.ttf': 'T' });
  assert.ok(r.html.includes('url("data:font/woff2;base64,' + b64('W2') + '") format("woff2")'));
  assert.ok(r.html.includes('url("data:font/woff;base64,' + b64('W1') + '")'));
  assert.ok(r.html.includes('url("data:font/ttf;base64,' + b64('T') + '")'));
});

test('style="" attribute url() is rewritten; @import is not allowed there', async () => {
  const r = await run('<div style="background: url(\'a.png\') no-repeat">x</div><td style="background:url(&quot;b.png&quot;)"></td>', { '/site/a.png': PNG, '/site/b.png': PNG2 });
  assert.equal(attr(r.html, 'div', 'style'), `background: url("${pngUrl(PNG)}") no-repeat`);
  assert.equal(attr(r.html, 'td', 'style'), `background:url("${pngUrl(PNG2)}")`);
});

test('a .css url() in CSS (not @import) is itself rewritten', async () => {
  const r = await run('<img src="x.svg">', { '/site/x.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  assert.ok(attr(r.html, 'img', 'src').startsWith('data:image/svg+xml;base64,'));
});

// ---------- scripts ----------

test('<script src> keeps defer, async and type=module; integrity/crossorigin removed', async () => {
  const files = { '/site/a.js': 'var a=1;', '/site/b.js': 'var b=2;', '/site/m.js': 'export const m=3;' };
  const r = await run('<script defer src="a.js" integrity="sha384-x" crossorigin="anonymous"></script><script async src="b.js"></script><script type="module" src="m.js"></script>', files);
  const tags = r.html.match(/<script[^>]*>/g);
  assert.equal(tags.length, 3);
  assert.match(tags[0], /^<script defer src="data:text\/javascript;base64,/);
  assert.doesNotMatch(tags[0], /integrity|crossorigin/);
  assert.match(tags[1], /^<script async src="data:/);
  assert.match(tags[2], /^<script type="module" src="data:/);
  assert.equal(dataText(attr(tags[0], 'script', 'src')), 'var a=1;');
  assert.equal(dataText(attr(tags[2], 'script', 'src')), 'export const m=3;');
});

test('ES module relative imports become data: URLs (nested, from, side-effect, dynamic, export from)', async () => {
  const files = {
    '/site/js/main.js': "import { a } from './lib/a.js';\nimport './side.js';\nexport * from \"./lib/a.js\";\nconst d = import('./dyn.js');\nimport x from 'bare-pkg';",
    '/site/js/lib/a.js': "import b from '../b.js'; export const a = b;",
    '/site/js/b.js': 'export default 2;',
    '/site/js/side.js': 'window.s=1;',
    '/site/js/dyn.js': 'export const d=1;',
  };
  const r = await run('<script type="module" src="js/main.js"></script>', files);
  const main = dataText(attr(r.html, 'script', 'src'));
  const specs = [...main.matchAll(/(["'])(data:[^"']+)\1/g)].map(m => m[2]);
  assert.equal(specs.length, 4, main);
  const a = dataText(specs[0]);
  assert.match(a, /^import b from 'data:text\/javascript;base64,/);
  assert.equal(dataText(/'(data:[^']+)'/.exec(a)[1]), 'export default 2;');
  assert.equal(dataText(specs[1]), 'window.s=1;');
  assert.equal(dataText(specs[3]), 'export const d=1;');
  assert.ok(main.includes("import x from 'bare-pkg'"), 'bare specifiers are left alone');
  assert.ok(r.deps.includes('file:///site/js/b.js'));
});

test('inline module script: relative imports resolve against the page', async () => {
  const r = await run('<script type="module">import {v} from "./js/v.js"; console.log(v)</script>', { '/site/js/v.js': 'export const v=1' });
  const m = /from "(data:[^"]+)"/.exec(r.html);
  assert.ok(m, r.html);
  assert.equal(dataText(m[1]), 'export const v=1');
});

test('module import loop is left as is, not followed forever', async () => {
  const files = { '/site/a.js': "import './b.js'; export const a=1;", '/site/b.js': "import './a.js'; export const b=1;" };
  const r = await run('<script type="module" src="a.js"></script>', files);
  const a = dataText(attr(r.html, 'script', 'src'));
  const b = dataText(/'(data:[^']+)'/.exec(a)[1]);
  assert.ok(b.includes("import './a.js'"), b);
});

test('a module script with one relative import does not make rewriteHtml reject', async () => {
  await assert.doesNotReject(run('<script type="module">import "./a.js";</script>', { '/site/a.js': '' }));
});

test('</script> inside a JS file does not break the page', async () => {
  const js = 'var s = "</script><script>alert(1)</script>"; document.write(s);';
  const r = await run('<script src="evil.js"></script><p id="after">ok</p>', { '/site/evil.js': js });
  assert.equal(dataText(attr(r.html, 'script', 'src')), js);
  assert.equal((r.html.match(/<script/g) || []).length, 1);
  assert.equal((r.html.match(/<\/script>/g) || []).length, 1);
  assert.match(r.html, /<p id="after">ok<\/p>$/);
});

test('inline script body is kept byte for byte (including "<img src=x.png>" text)', async () => {
  const body = 'var t = "<img src=\'a.png\'>"; if (a < b && c > d) {}';
  const r = await run(`<script>${body}</script><img src="a.png">`, { '/site/a.png': PNG });
  assert.ok(r.html.startsWith(`<script>${body}</script>`));
  assert.deepEqual(r.deps, ['file:///site/a.png']);
});

// ---------- errors / limits ----------

test('missing files give a "Not found" note and the page is kept', async () => {
  const r = await run('<h1>Title</h1><img src="gone.png"><link rel="stylesheet" href="gone.css"><script src="gone.js"></script><p>end</p>', {});
  assert.match(r.html, /^<h1>Title<\/h1>/);
  assert.match(r.html, /<p>end<\/p>$/);
  assert.equal(attr(r.html, 'img', 'src'), 'data:,');
  assert.equal(attr(r.html, 'link', 'data-html-preview-missing'), 'gone.css');
  assert.doesNotMatch(r.html, /<link[^>]*href=/);
  assert.equal(attr(r.html, 'script', 'data-html-preview-missing'), 'gone.js');
  assert.ok(hasNote(r, /^Not found: \/site\/gone\.png\.$/));
  assert.ok(hasNote(r, /^Not found: \/site\/gone\.css \(stylesheet\)\.$/));
  assert.ok(hasNote(r, /^Not found: \/site\/gone\.js \(script\)\.$/));
  assert.ok(r.notes.every(n => n.level === 'warn'));
});

test('missing @import and missing CSS url() do not break the stylesheet', async () => {
  const r = await run('<link rel="stylesheet" href="a.css">', { '/site/a.css': '@import "nope.css"; .a{background:url(nope.png)} .b{}' });
  const css = dataText(attr(r.html, 'link', 'href'));
  assert.ok(css.includes(`.a{background:url("data:,")} .b{}`), css);
  assert.ok(hasNote(r, /Not found: \/site\/nope\.css/));
});

test('same missing file twice gives one note', async () => {
  const r = await run('<img src="x.png"><img src="x.png"><div style="background:url(x.png)"></div>', {});
  assert.equal(r.notes.filter(n => /x\.png/.test(n.text)).length, 1);
});

test('OUTSIDE: a file outside the workspace gives an "outside" note', async () => {
  const r = await run('<img src="../../etc/secret.png">', {});
  assert.equal(attr(r.html, 'img', 'src'), 'data:,');
  assert.ok(hasNote(r, /^Not loaded: \/etc\/secret\.png is outside the workspace/));
});

test('TOOBIG from read() gives a limit note', async () => {
  const r = await run('<video src="huge.mp4"></video>', {}, { errors: { '/site/huge.mp4': 'TOOBIG' } });
  assert.equal(attr(r.html, 'video', 'src'), 'data:,');
  assert.ok(hasNote(r, /^Not shown: \/site\/huge\.mp4 is larger than the limit \(setting htmlPreview\.maxResourceMB\)/));
});

test('maxResourceBytes: a file over the per-file limit is not inlined', async () => {
  const big = Buffer.alloc(3 * 1048576, 1);
  const r = await run('<img src="big.png"><img src="a.png">', { '/site/big.png': big, '/site/a.png': PNG }, { maxResourceBytes: 2 * 1048576 });
  const srcs = [...r.html.matchAll(/src="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(srcs, ['data:,', pngUrl(PNG)]);
  assert.ok(hasNote(r, /^Not shown: \/site\/big\.png is 3\.0 MB \(limit 2\.0 MB per file, setting htmlPreview\.maxResourceMB\)/));
  assert.equal(r.bytes, PNG.length);
});

test('maxTotalBytes: files past the total budget are skipped with a note', async () => {
  const kb = Buffer.alloc(600 * 1024, 2);
  const files = { '/site/1.png': kb, '/site/2.png': kb, '/site/3.png': kb };
  const r = await run('<img src="1.png"><img src="2.png"><img src="3.png">', files, { maxTotalBytes: 1048576 });
  const inlined = [...r.html.matchAll(/src="([^"]*)"/g)].filter(m => m[1] !== 'data:,').length;
  assert.equal(inlined, 1);
  assert.ok(r.bytes <= 1048576);
  assert.ok(hasNote(r, /passed 1\.0 MB in all/));
});

test('a path that cannot be parsed gives a note and keeps the attribute', async () => {
  const r = await run('<img src="http://[bad">', {});
  assert.ok(r.html.includes('<img'));
});

// ---------- remote ----------

test('remote URLs are counted (total, unique, hosts) and replaced by inert values', async () => {
  const html = [
    '<link rel="stylesheet" href="https://cdn.a.com/x.css">',
    '<script src="https://cdn.b.com/lib.js" defer></script>',
    '<img src="https://img.c.com/1.png"><img src="https://img.c.com/1.png">',
    '<video src="//media.d.com/v.mp4"></video>',
    '<iframe src="https://e.com/embed"></iframe>',
    '<style>@import url("https://fonts.f.com/css"); p{background:url(https://img.c.com/bg.png)}</style>',
  ].join('\n');
  const r = await run(html, {});
  assert.equal(r.reads.length, 0);
  assert.equal(r.remote.count, 8);
  assert.equal(r.remote.unique, 7);
  assert.deepEqual(r.remote.hosts.sort(), ['cdn.a.com', 'cdn.b.com', 'e.com', 'fonts.f.com', 'img.c.com', 'media.d.com']);
  assert.ok(r.remote.urls.includes('https://media.d.com/v.mp4'), '//x counted as https');
  assert.match(r.html, /<!-- html-preview: remote stylesheet not loaded: https:\/\/cdn\.a\.com\/x\.css -->/);
  assert.match(r.html, /<script defer type="text\/html-preview-blocked" data-src="https:\/\/cdn\.b\.com\/lib\.js"><\/script>/);
  assert.doesNotMatch(r.html, /<script[^>]*\ssrc=/);
  assert.equal([...r.html.matchAll(/<img src="([^"]*)"/g)].filter(m => m[1] === INERT_IMG).length, 2);
  assert.equal(attr(r.html, 'video', 'src'), 'data:,');
  assert.equal(attr(r.html, 'iframe', 'src'), 'about:blank');
  assert.equal(attr(r.html, 'iframe', 'data-src'), 'https://e.com/embed');
  assert.match(r.html, /\/\* html-preview: remote @import not loaded: https:\/\/fonts\.f\.com\/css \*\//);
  assert.ok(r.html.includes(`url("${INERT_IMG}")`));
  // no live http(s) reference left in any URL attribute
  assert.doesNotMatch(r.html, /\s(src|href|poster|srcset)="(https?:)?\/\//);
});

test('remote import in a module script is replaced when remote is off', async () => {
  const r = await run('<script type="module">import confetti from "https://esm.sh/confetti"; confetti()</script>', {});
  assert.ok(r.html.includes('import confetti from "data:text/javascript,"'));
  assert.equal(r.remote.count, 1);
});

test('allowRemote keeps https URLs and turns //cdn into https://cdn', async () => {
  const html = '<link rel="stylesheet" href="//cdn.a.com/x.css"><script src="//cdn.b.com/l.js"></script><img src="https://i.com/a.png"><img src="//i.com/b.png"><iframe src="//e.com/f"></iframe>';
  const r = await run(html, {}, { allowRemote: true });
  assert.equal(attr(r.html, 'link', 'href'), 'https://cdn.a.com/x.css');
  assert.equal(attr(r.html, 'script', 'src'), 'https://cdn.b.com/l.js');
  assert.deepEqual([...r.html.matchAll(/<img src="([^"]*)"/g)].map(m => m[1]), ['https://i.com/a.png', 'https://i.com/b.png']);
  assert.equal(attr(r.html, 'iframe', 'src'), 'https://e.com/f');
  assert.equal(r.remote.count, 5);
  assert.equal(r.reads.length, 0);
});

test('allowRemote: remote @import is hoisted to the top of the CSS', async () => {
  const r = await run('<style>p{} @import url(//fonts.x.com/css) screen;</style>', {}, { allowRemote: true });
  assert.ok(r.html.includes('<style>@import url("https://fonts.x.com/css") screen;\np{} </style>'), r.html);
});

test('resource hints are removed (remote ones kept when allowRemote)', async () => {
  const html = '<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="dns-prefetch" href="//x.com"><link rel="preload" href="a.woff2" as="font"><link rel="modulepreload" href="m.js">';
  const r = await run(html, {});
  assert.equal((r.html.match(/resource hint removed/g) || []).length, 4);
  assert.doesNotMatch(r.html, /<link/);
  assert.equal(r.reads.length, 0);
  const r2 = await run(html, {}, { allowRemote: true });
  assert.match(r2.html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com">/);
  assert.equal((r2.html.match(/resource hint removed/g) || []).length, 2, 'local hints are still removed');
});

test('link rel=icon is inlined', async () => {
  const r = await run('<link rel="shortcut icon" href="fav.ico">', { '/site/fav.ico': 'I' });
  assert.equal(attr(r.html, 'link', 'href'), 'data:image/x-icon;base64,' + b64('I'));
});

// ---------- meta ----------

test('meta refresh is removed with a note; page CSP meta removed with a note', async () => {
  const r = await run('<head><meta charset="utf-8"><META HTTP-EQUIV="Refresh" content="0;url=https://evil.example/"><meta http-equiv="Content-Security-Policy" content="default-src *"></head>', {});
  assert.match(r.html, /<meta charset="utf-8">/);
  assert.match(r.html, /meta refresh removed/);
  assert.match(r.html, /page CSP removed/);
  assert.doesNotMatch(r.html, /http-equiv/i);
  assert.ok(hasNote(r, /Removed <meta http-equiv="refresh" content="0;url=https:\/\/evil\.example\/">/));
  assert.ok(hasNote(r, /Content-Security-Policy meta tag/));
});

// ---------- scripts: false ----------

test('scripts:false drops <script>, on* handlers, javascript: URLs and sandboxes iframes', async () => {
  const html = '<script>alert(1)</script><SCRIPT src="a.js"></SCRIPT><body onload="x()"><a href="javascript:alert(1)" onclick="y()">l</a><a href=" JavaScript:void(0)">m</a><button ONMOUSEOVER="z()">b</button><iframe src="https://e.com"></iframe><iframe srcdoc="<p>x</p>" sandbox="allow-scripts"></iframe><form action="javascript:go()"></form>';
  const r = await run(html, { '/site/a.js': 'x' }, { scripts: false });
  assert.doesNotMatch(r.html, /<script/i);
  assert.equal((r.html.match(/script off/g) || []).length, 2);
  assert.doesNotMatch(r.html, /\son[a-z]+=/i);
  assert.doesNotMatch(r.html, /javascript:/i);
  assert.equal((r.html.match(/href="#"/g) || []).length, 2);
  assert.match(r.html, /<form action="#">/);
  assert.match(r.html, /<iframe src="about:blank" sandbox="" data-src="https:\/\/e\.com">/);
  assert.match(r.html, /<iframe srcdoc="<p>x<\/p>" sandbox="">/, 'an existing sandbox="allow-scripts" is replaced');
  assert.equal(r.reads.length, 0);
});

test('scripts:true keeps inline scripts and handlers as they are', async () => {
  const html = '<script>alert(1)</script><a href="javascript:void(0)" onclick="y()">l</a>';
  const r = await run(html, {});
  assert.equal(r.html, html);
});

test('local iframe becomes srcdoc with its own resources inlined', async () => {
  const files = { '/site/sub/frame.html': '<img src="i.png"><p>frame</p>', '/site/sub/i.png': PNG };
  const r = await run('<iframe src="sub/frame.html" width="300"></iframe>', files);
  const doc = attr(r.html, 'iframe', 'srcdoc');
  assert.ok(doc.includes(pngUrl(PNG)) && doc.includes('<p>frame</p>'), doc);
  assert.equal(attr(r.html, 'iframe', 'src'), null);
  assert.equal(attr(r.html, 'iframe', 'width'), '300');
});

// ---------- inject position ----------

const INJ = '<script data-html-preview="bootstrap">B</script>';
const inj = async (html, over = {}) => (await run(html, {}, { inject: INJ, ...over })).html;

test('inject: doctype + html + head -> right after <head>', async () => {
  const out = await inj('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8"><title>T</title></head><body>x</body></html>');
  assert.ok(out.startsWith(`<!DOCTYPE html>\n<html lang="en">\n<head>${INJ}\n<meta charset="utf-8">`), out);
  assert.equal(out.split(INJ).length, 2);
});

test('inject: head with attributes and uppercase tags', async () => {
  const out = await inj('<!doctype html><HTML><HEAD PROFILE="x"><TITLE>T</TITLE></HEAD><BODY>x</BODY></HTML>');
  assert.ok(out.startsWith(`<!doctype html><html><head PROFILE="x">${INJ}<title>T</TITLE></HEAD>`), out);
  assert.equal(out.split(INJ).length, 2);
});

test('inject: no head -> before the first element, after the doctype', async () => {
  const out = await inj('<!DOCTYPE html>\n<html>\n<body><p>x</p></body></html>');
  assert.equal(out, `<!DOCTYPE html>\n<html>\n${INJ}<body><p>x</p></body></html>`);
  const out2 = await inj('<!DOCTYPE html><p>only a paragraph</p>');
  assert.equal(out2, `<!DOCTYPE html>${INJ}<p>only a paragraph</p>`);
});

test('inject: no tags at all -> at the start', async () => {
  assert.equal(await inj('just text, no tags'), INJ + 'just text, no tags');
  assert.equal(await inj(''), INJ);
});

test('inject: comments before the doctype stay first', async () => {
  const out = await inj('<!-- generated -->\n<!DOCTYPE html>\n<html><head></head></html>');
  assert.equal(out, `<!-- generated -->\n<!DOCTYPE html>\n<html><head>${INJ}</head></html>`);
  const out2 = await inj('<!-- a --><!DOCTYPE html>text only');
  assert.equal(out2, `<!-- a --><!DOCTYPE html>${INJ}text only`);
});

test('inject: a "<head>" inside a comment or a script string is not the head', async () => {
  const out = await inj('<!DOCTYPE html><!-- <head> --><html><head></head></html>');
  assert.equal(out, `<!DOCTYPE html><!-- <head> --><html><head>${INJ}</head></html>`);
});

test('inject is only added once and never into local iframes', async () => {
  const r = await run('<html><head></head><body><iframe src="f.html"></iframe></body></html>', { '/site/f.html': '<html><head></head><body>f</body></html>' }, { inject: INJ });
  assert.equal(r.html.split('data-html-preview=').length, 2);
});

// ---------- tag parsing ----------

test('attributes with > inside quotes do not end the tag', async () => {
  const r = await run('<img alt="a > b" title=\'c>d\' src="a.png"><p data-x="1>2">t</p>', { '/site/a.png': PNG });
  assert.ok(r.html.startsWith(`<img alt="a > b" title='c>d' src="${pngUrl(PNG)}">`), r.html);
  assert.ok(r.html.endsWith('<p data-x="1>2">t</p>'));
});

test('unquoted, entity-encoded and self-closing attributes', async () => {
  const r = await run('<img src=a.png /><img src="a&amp;b.png"/>', { '/site/a.png': PNG, '/site/a&b.png': PNG2 });
  assert.ok(r.html.includes(`<img src="${pngUrl(PNG)}" />`), r.html);
  assert.ok(r.html.includes(`<img src="${pngUrl(PNG2)}" />`), r.html);
});

test('text that is not a tag is kept ("a < b", stray "<")', async () => {
  const html = '<p>1 < 2 and 3 <> 4 <3</p>';
  assert.equal((await run(html)).html, html);
});

test('<textarea> and <title> bodies are not parsed as tags', async () => {
  const html = '<title><img src="x.png"></title><textarea><img src="y.png"></textarea>';
  const r = await run(html, {});
  assert.equal(r.html, html);
  assert.equal(r.reads.length, 0);
});

test('a page with nothing to rewrite comes back byte for byte', async () => {
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>T</title></head>\n<body class="a" data-x=\'1\'>\n<!-- c --><a href="#top">top</a> &amp; <b>bold</b>\n</body>\n</html>\n';
  assert.equal((await run(html, {})).html, html);
});

// ---------- performance ----------

test('a 2 MB page with a 10,000-row table is processed in under 1.5 s', async () => {
  const rows = [];
  for (let i = 0; i < 10000; i++) rows.push(`<tr class="r${i % 2}"><td>${i}</td><td title="row ${i}">Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ${i}</td><td><a href="#r${i}">link</a></td></tr>`);
  const html = `<!DOCTYPE html><html><head><title>Big</title></head><body><table>${rows.join('\n')}</table></body></html>`;
  assert.ok(html.length >= 2 * 1000 * 1000, 'page is ' + html.length + ' chars');
  const t0 = process.hrtime.bigint();
  const r = await run(html, {}, { inject: INJ });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.equal(r.html.length, html.length + INJ.length);
});

// ---------- deps ----------

test('deps lists every local file read once (missing ones too), not remote ones', async () => {
  const files = { '/site/a.css': '@import "b.css"; p{background:url(i.png)}', '/site/b.css': '', '/site/i.png': PNG, '/site/s.js': '' };
  const r = await run('<link rel="stylesheet" href="a.css"><img src="i.png"><img src="i.png"><script src="s.js"></script><img src="gone.png"><img src="https://x.com/r.png">', files);
  assert.deepEqual(r.deps.sort(), ['file:///site/a.css', 'file:///site/b.css', 'file:///site/gone.png', 'file:///site/i.png', 'file:///site/s.js']);
});

// ---------- resolveLink ----------

test('resolveLink: fragment, empty and javascript:', () => {
  const base = 'file:///site/pages/index.html';
  assert.deepEqual(resolveLink('#sec', base, ROOT), { kind: 'fragment', url: '#sec' });
  assert.deepEqual(resolveLink('', base, ROOT), { kind: 'none' });
  assert.deepEqual(resolveLink('   ', base, ROOT), { kind: 'none' });
  assert.deepEqual(resolveLink('javascript:alert(1)', base, ROOT), { kind: 'none' });
  assert.deepEqual(resolveLink(' JavaScript:void(0)', base, ROOT), { kind: 'none' });
});

test('resolveLink: external http, https, //, mailto, tel', () => {
  const base = 'file:///site/index.html';
  assert.deepEqual(resolveLink('https://a.com/x?y#z', base, ROOT), { kind: 'external', url: 'https://a.com/x?y#z' });
  assert.deepEqual(resolveLink('http://a.com', base, ROOT), { kind: 'external', url: 'http://a.com' });
  assert.deepEqual(resolveLink('//cdn.com/p', base, ROOT), { kind: 'external', url: 'https://cdn.com/p' });
  assert.deepEqual(resolveLink('mailto:a@b.c', base, ROOT), { kind: 'external', url: 'mailto:a@b.c' });
  assert.deepEqual(resolveLink('tel:+123', base, ROOT), { kind: 'external', url: 'tel:+123' });
});

test('resolveLink: local relative with fragment and query', () => {
  const r = resolveLink('../about.html?x=1#team', 'file:///site/pages/index.html', ROOT);
  assert.deepEqual(r, { kind: 'local', url: 'file:///site/about.html', fragment: '#team' });
  assert.deepEqual(resolveLink('page two.html', 'file:///site/index.html', ROOT), { kind: 'local', url: 'file:///site/page%20two.html', fragment: '' });
});

test('resolveLink: root-relative uses rootUrl', () => {
  assert.deepEqual(resolveLink('/docs/a.html', 'file:///site/deep/x/index.html', ROOT), { kind: 'local', url: 'file:///site/docs/a.html', fragment: '' });
  assert.deepEqual(resolveLink('/a.html', 'vscode-remote://ssh-remote+h/w/p/index.html', 'vscode-remote://ssh-remote+h/w/'), { kind: 'local', url: 'vscode-remote://ssh-remote+h/w/a.html', fragment: '' });
});

test('resolveLink: links under a remote base become external', () => {
  assert.deepEqual(resolveLink('about.html', 'https://example.com/app/', ROOT), { kind: 'external', url: 'https://example.com/app/about.html' });
  assert.deepEqual(resolveLink('/x', 'https://example.com/app/', ROOT), { kind: 'external', url: 'https://example.com/x' });
});

test('resolveLink: unknown schemes are blocked; file: is local', () => {
  for (const h of ['vscode://settings', 'data:text/html,<b>x</b>', 'ftp://h/f', 'foo:bar', 'vbscript:msgbox']) assert.equal(resolveLink(h, 'file:///site/index.html', ROOT).kind, 'blocked', h);
  assert.deepEqual(resolveLink('file:///site/b.html#q', 'file:///site/index.html', ROOT), { kind: 'local', url: 'file:///site/b.html', fragment: '#q' });
});

test('resolveLink: "java\\tscript:" (tab inside the scheme) is not treated as a local file', () => {
  const r = resolveLink('java\tscript:alert(1)', 'file:///site/index.html', ROOT);
  assert.notEqual(r.kind, 'local');
});

test('hostile text stays linear: module imports, CSS url(, unclosed comments, srcset spaces (VER11)', async () => {
  const big = 200000;
  for (const [name, html] of [
    ['import + spaces', '<script type="module">import' + ' '.repeat(big) + '</script>'],
    ['export { unclosed', '<script type="module">' + 'export {a '.repeat(big / 10) + '</script>'],
    ['css url( + spaces', '<style>url(' + ' '.repeat(big) + '</style>'],
    ['css @import + spaces', '<style>@import' + ' '.repeat(big) + '</style>'],
    ['css unclosed comments', '<style>' + '/*a'.repeat(big / 3) + '</style>'],
    ['srcset spaces', '<img srcset="a' + ' '.repeat(big) + 'b">'],
  ]) {
    const t0 = Date.now();
    await run(html);
    assert.ok(Date.now() - t0 < 1500, `${name}: ${Date.now() - t0} ms`);
  }
});
