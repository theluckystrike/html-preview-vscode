// Writes the sample pages used by the tests and the real VS Code gate.
// usage: node scripts/make-samples.mjs <outDir> [--large <path to a 52 MB hostile file>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(process.argv[2] || 'samples');
const li = process.argv.indexOf('--large');
const largePath = li > 0 ? process.argv[li + 1] : null;
const w = (rel, data) => { const p = path.join(out, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

// A real PNG: a w x h gradient with a colored band.
function png(wd, ht, rgb) {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((wd * 3 + 1) * ht);
  for (let y = 0; y < ht; y++) { raw[y * (wd * 3 + 1)] = 0; for (let x = 0; x < wd; x++) { const o = y * (wd * 3 + 1) + 1 + x * 3; const t = x / wd; raw[o] = Math.round(rgb[0] * (1 - t) + 255 * t); raw[o + 1] = Math.round(rgb[1] * (1 - t) + 200 * t * (y / ht)); raw[o + 2] = rgb[2]; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(wd, 0); ihdr.writeUInt32BE(ht, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const svg = (label, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200"><rect width="480" height="200" rx="16" fill="${color}"/><text x="240" y="115" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#fff" text-anchor="middle">${label}</text></svg>`;

fs.rmSync(out, { recursive: true, force: true });

// 1. A small site: 4 pages that link to each other, CSS with @import and url(), JS, images with spaces in the name.
const nav = `<nav><a href="index.html">Home</a> <a href="about.html" id="toAbout">About</a> <a href="contact.html">Contact</a> <a href="docs/guide.html">Guide</a> <a href="https://example.com/" id="external">example.com</a></nav>`;
w('site/css/base.css', `:root { --brand: #e44d26; --ink: #1d2733; }\nh1 { color: rgb(228, 77, 38); letter-spacing: .5px; }\nbody { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); }\n`);
w('site/css/site.css', `@import "base.css";\n@import url("print.css") print;\nbody { margin: 0; background: #fbfaf7 url("../img/paper dots.svg") repeat; }\nheader { background: var(--ink); color: #fff; padding: 18px 28px; }\nheader h1 { margin: 0; font-size: 26px; }\nnav a { color: #ffd2c4; margin-right: 14px; }\nmain { max-width: 860px; margin: 0 auto; padding: 18px 28px 60px; }\n.card { background: #fff; border: 1px solid #e6e1d8; border-radius: 10px; padding: 16px 20px; margin: 14px 0; box-shadow: 0 1px 3px rgba(0,0,0,.06); }\n.hero { width: 100%; max-width: 480px; display: block; border-radius: 12px; }\n#counter { font-weight: 700; color: var(--brand); }\n.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }\n`);
w('site/css/print.css', `nav { display: none; }\n`);
w('site/js/app.js', `document.addEventListener('DOMContentLoaded', () => {\n  const b = document.getElementById('more');\n  const c = document.getElementById('counter');\n  let n = 0;\n  b.addEventListener('click', () => { n++; c.textContent = String(n); console.log('clicked', n); });\n  document.body.dataset.app = 'ok';\n  console.log('app.js loaded');\n});\n`);
w('site/img/hero photo.svg', svg('hero photo.svg', '#2965f1'));
w('site/img/paper dots.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="2" cy="2" r="1" fill="#e6e1d8"/></svg>`);
w('site/img/logo.png', png(96, 96, [228, 77, 38]));
const tail = '\n'.repeat(1) + Array.from({ length: 24 }, (_, i) => `    <p>Paragraph ${i + 1}. Scroll down, then save a CSS change: the preview keeps this place.</p>`).join('\n');
w('site/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Small site, home</title>
  <link rel="stylesheet" href="css/site.css">
  <script src="js/app.js" defer></script>
</head>
<body>
  <header><h1>Small site</h1>${nav}</header>
  <main>
    <div class="card">
      <img class="hero" src="img/hero photo.svg" alt="Hero">
      <p>Linked CSS (with <code>@import</code> and <code>url()</code>), a deferred script and two images, one with a space in its name.</p>
      <p><img id="logo" src="./img/logo.png" width="48" height="48" alt="Logo"> <button id="more">Click me</button> clicked <span id="counter">0</span> times.</p>
    </div>
    <div class="grid">
      <div class="card"><b>Copy me</b><p id="copyme">The quick brown fox jumps over the lazy dog.</p></div>
      <div class="card"><b>Fragment link</b><p><a href="#end">Jump to the end</a></p></div>
      <div class="card"><b>PDF link</b><p>Local files that are not HTML open in VS Code.</p></div>
    </div>${tail}
    <p id="end">The end.</p>
  </main>
</body>
</html>
`);
for (const [f, t, body] of [['about.html', 'About', '<p id="aboutText">This is the About page. Use Back to go home.</p>'], ['contact.html', 'Contact', '<form action="https://example.com/send" method="post"><label>Email <input name="email" value="a@b.c"></label> <button id="send">Send</button></form>'], ['docs/guide.html', 'Guide', '<p>A page one folder down. Its CSS path starts with ../</p>']]) {
  const up = f.includes('/') ? '../' : '';
  w('site/' + f, `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Small site, ${t}</title><link rel="stylesheet" href="${up}css/site.css"></head>\n<body><header><h1>${t}</h1>${nav.replace(/href="(?!https)([^"]+)"/g, (a, h) => `href="${up}${h}"`)}</header><main><div class="card">${body}</div></main></body></html>\n`);
}

// 2. Bootstrap from a CDN (remote resources).
w('bootstrap-cdn.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bootstrap from a CDN</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
</head>
<body class="p-4">
  <h1 class="display-6">Bootstrap page</h1>
  <p class="lead">Its CSS, font and script come from the web. The preview loads none of them until you click "Load for this file".</p>
  <button id="btn" class="btn btn-primary">Primary button</button>
  <img src="https://picsum.photos/200/100" alt="remote image" id="remoteImg">
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
`);

// 3. srcset and <picture>.
w('img/one.png', png(120, 60, [41, 101, 241]));
w('img/two.png', png(240, 120, [20, 160, 90]));
w('img/wide.svg', svg('wide.svg via picture', '#8a2be2'));
w('picture-srcset.html', `<!doctype html><html><head><meta charset="utf-8"><title>srcset and picture</title></head><body>
<h2>srcset</h2><img id="srcsetImg" src="img/one.png" srcset="img/one.png 1x, img/two.png 2x" alt="srcset">
<h2>sizes</h2><img id="sizesImg" srcset="img/one.png 120w, img/two.png 240w" sizes="(max-width: 600px) 120px, 240px" src="img/one.png" alt="sizes">
<h2>picture</h2><picture><source id="wideSource" media="(min-width: 500px)" srcset="img/wide.svg"><img id="pictureImg" src="img/one.png" alt="picture"></picture>
</body></html>
`);

// 4. Inline SVG.
w('inline-svg.html', `<!doctype html><html><head><meta charset="utf-8"><title>Inline SVG</title><style>svg{max-width:100%}</style></head><body>
<h2>Inline SVG with a gradient and an image</h2>
<svg id="chart" width="420" height="220" viewBox="0 0 420 220" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#e44d26"/><stop offset="1" stop-color="#2965f1"/></linearGradient></defs>
<rect x="10" y="10" width="400" height="200" rx="12" fill="url(#g)"/>
<image id="svgImage" x="300" y="20" width="96" height="96" href="img/one.png"/>
<text x="30" y="120" font-size="28" fill="#fff">Inline SVG</text></svg>
</body></html>
`);

// 5. A form.
w('form.html', `<!doctype html><html><head><meta charset="utf-8"><title>Form</title><style>label{display:block;margin:8px 0}</style></head><body>
<h2>Sign up</h2>
<form id="f" action="https://example.com/signup" method="post">
<label>Name <input name="name" value="Ada"></label>
<label>Plan <select name="plan"><option>Free</option><option>Pro</option></select></label>
<label><input type="checkbox" name="terms" checked> I agree</label>
<button id="submit" type="submit">Create account</button>
</form></body></html>
`);

// 6. <base href>.
w('base-href.html', `<!doctype html><html><head><meta charset="utf-8"><base href="site/"><title>Base href</title><link rel="stylesheet" href="css/site.css"></head>
<body><main><h1>Base href</h1><p>The base is site/, so css/site.css and img/logo.png come from the site folder.</p><img id="baseImg" src="img/logo.png" alt="logo"><p><a id="baseLink" href="about.html">About (in site/)</a></p></main></body></html>
`);

// 7. 2 MB table with 10,000 rows (the large normal file).
{
  const rows = [];
  for (let i = 1; i <= 10000; i++) rows.push(`<tr><td>${i}</td><td>Item ${i}</td><td>${(i * 7.31 % 1000).toFixed(2)}</td><td>${['north', 'south', 'east', 'west'][i % 4]}</td><td>2026-${String(1 + i % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}</td><td>${'lorem ipsum dolor sit amet '.repeat(3).trim()}</td></tr>`);
  w('large-table.html', `<!doctype html><html><head><meta charset="utf-8"><title>10,000 rows</title><style>table{border-collapse:collapse;font:12px system-ui}td{border:1px solid #ccc;padding:2px 6px}</style></head><body><h2>10,000 rows</h2><table id="big"><tbody>\n${rows.join('\n')}\n</tbody></table></body></html>\n`);
}

// 8. Non-ASCII folder and file names.
w('Résumé ü/页面 ünïcødé.html', `<!doctype html><html><head><meta charset="utf-8"><title>Non-ASCII names</title><link rel="stylesheet" href="stil é.css"></head><body><h1 id="h">Grüße, 你好, привет</h1><img id="u" src="bild ö.png" alt="ö"><img id="u2" src="../img/one.png" alt="up"></body></html>\n`);
w('Résumé ü/stil é.css', `h1 { color: rgb(0, 128, 0); }\n`);
w('Résumé ü/bild ö.png', png(64, 32, [200, 40, 160]));

// 9. Console, errors, storage and an ES module.
w('js/util.mjs', `export const twice = n => n * 2;\n`);
w('js-console.html', `<!doctype html><html><head><meta charset="utf-8"><title>Console and JS</title></head><body>
<h2>Console and JS</h2><p id="out">waiting</p><p id="mod">module waiting</p>
<script>
console.log('hello from the page', { a: 1 });
console.warn('a warning');
localStorage.setItem('k', 'stored');
document.getElementById('out').textContent = 'storage: ' + localStorage.getItem('k');
alert('alerts show in the console');
setTimeout(() => { undefinedFunction(); }, 50);
</script>
<script type="module">import { twice } from './js/util.mjs'; document.getElementById('mod').textContent = 'module: ' + twice(21);</script>
</body></html>
`);

// 10. A page without a background (dark/light toggle).
w('no-background.html', `<!doctype html><html><head><meta charset="utf-8"><title>No background</title></head><body><h2>No background set</h2><p id="t">This page sets no colors, so the Page toggle (Auto, Light, Dark) decides them.</p><p><a href="#x">A link</a></p></body></html>\n`);

// Hostile 1: tries to reach VS Code and the network.
w('hostile-api.html', `<!doctype html><html><head><meta charset="utf-8"><title>Hostile API</title>
<meta http-equiv="refresh" content="3;url=https://example.com/refresh">
</head><body><h2 id="h">Hostile page</h2><pre id="log"></pre>
<img id="passwd" src="file:///etc/passwd" alt="passwd">
<img id="abs" src="/../../../../../etc/hosts" alt="hosts">
<iframe id="remoteFrame" src="https://example.com/frame"></iframe>
<script>
const out = [];
const t = (name, f) => { try { out.push(name + ': ' + f()); } catch (e) { out.push(name + ': blocked (' + e.name + ')'); } };
t('acquireVsCodeApi', () => typeof acquireVsCodeApi === 'function' ? (acquireVsCodeApi().postMessage({ type: 'openBrowser' }), 'CALLED') : 'not defined');
t('parent.acquireVsCodeApi', () => typeof parent.acquireVsCodeApi);
t('parent.document', () => parent.document.title);
t('top.document', () => top.document.title);
t('cookie', () => JSON.stringify(document.cookie));
for (const m of [{ type: 'openBrowser' }, { type: 'remote', mode: 'always' }, { type: 'remote', mode: 'file' }, { type: 'copy', text: 'PWNED-CLIPBOARD' }, { type: 'scripts', on: false }, { type: 'action', id: 'showLarge' },
  { hp: 1, t: 'link', href: 'https://example.com/evil' }, { hp: 1, t: 'copy', text: 'PWNED-CLIPBOARD-2' }, { hp: 1, t: 'link', href: '../../../../etc/passwd' }])
  t('postMessage ' + JSON.stringify(m), () => { parent.postMessage(m, '*'); top.postMessage(m, '*'); return 'sent'; });
t('fetch', () => { fetch('https://example.com/fetch').then(() => out.push('fetch OK'), e => out.push('fetch failed')); return 'started'; });
t('image', () => { const i = new Image(); i.src = 'https://example.com/pixel.png'; return 'started'; });
t('beacon', () => navigator.sendBeacon('https://example.com/beacon', 'x'));
t('websocket', () => { new WebSocket('wss://example.com/ws'); return 'started'; });
t('window.open', () => String(window.open('https://example.com/popup')));
setTimeout(() => { t('top.location', () => { top.location = 'https://example.com/top'; return 'set'; }); t('location', () => { location.href = 'https://example.com/self'; return 'set'; }); document.getElementById('log').textContent = out.join('\\n'); console.log(out.join(' | ')); }, 300);
document.getElementById('log').textContent = out.join('\\n');
</script></body></html>
`);

// Hostile 2: an endless loop.
w('hostile-loop.html', `<!doctype html><html><head><meta charset="utf-8"><title>Endless loop</title></head><body><h2 id="h">This page never stops</h2><p>Its script loops forever.</p>
<script>let i = 0; while (true) { i++; }</script></body></html>
`);

// Hostile 3 (optional, outside the repo): about 52 MB of HTML (54 million bytes).
if (largePath) {
  const fd = fs.openSync(largePath, 'w');
  fs.writeSync(fd, '<!doctype html><html><head><title>52 MB</title></head><body><table>\n');
  const row = '<tr><td>row</td><td>' + 'x'.repeat(1004) + '</td></tr>\n';
  const chunk = row.repeat(1000);
  for (let i = 0; i < 53; i++) fs.writeSync(fd, chunk);
  fs.writeSync(fd, '</table></body></html>\n');
  fs.closeSync(fd);
}
console.log('samples written to', out);
