// Release gate in a real VS Code. Installs the .vsix into an isolated profile, opens every sample page with real
// clicks and keys, checks what the page frame shows, edits linked files on disk and in the editor, checks the
// hostile pages and the 52 MB file, logs every network request of the webviews, and writes screenshots and JSON.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson> <hostile52mb.html> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [work0, port, vsix, samples0, shotDir, outJson, large, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const R = { theme: theme || 'Default Dark Modern', vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), install: null, steps: [], timings: {}, network: { outside: [], all: 0, blockedCsp: 0 }, consoleOuter: [], extHostMB: [] };
const tag = /Light/.test(R.theme) ? 'light' : 'dark';
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.cpSync(samples0, ws, { recursive: true });
const largeName = 'hostile-52mb.html';
fs.symlinkSync(path.resolve(large), path.join(ws, largeName));
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const hostileHashes = Object.fromEntries(['hostile-api.html', 'hostile-loop.html'].map(f => [f, hash(path.join(ws, f))]));
const clipBefore = (() => { try { return execFileSync('pbpaste', { encoding: 'utf8' }); } catch { return ''; } })();
const setClip = t => execFileSync('pbcopy', { input: t });
const getClip = () => execFileSync('pbpaste', { encoding: 'utf8' });

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true }); // only this build may be installed
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.editor.enablePreview': false,
  'html.autoClosingTags': false, 'editor.minimap.enabled': false, 'workbench.editorLargeFileConfirmation': 1024,
});

// Network: every request from a webview frame. Requests the CSP blocked never leave the machine.
const reqs = new Map();
const LOCAL = /^(vscode-webview|vscode-resource|vscode-file|data|blob|about|chrome-error|devtools):|^https:\/\/[^/]*\.vscode-(cdn|resource)\.net\//;
let phase = 'default';
vs.network = true;
vs.s.on(m => {
  const info = m.sessionId && vs.attached.get(m.sessionId);
  if (m.method === 'Network.requestWillBeSent' && info && m.sessionId !== vs.wb && !/^vscode-file:/.test(info.url || '')) {
    R.network.all++;
    const u = m.params.request.url;
    R.network.byType = R.network.byType || {}; R.network.byType[info.type] = (R.network.byType[info.type] || 0) + 1;
    if (!LOCAL.test(u)) reqs.set(m.sessionId + m.params.requestId, { url: u.slice(0, 200), phase, frame: (info.url || '').slice(0, 40), type: info.type });
  }
  if (m.method === 'Network.loadingFailed' && m.params.blockedReason) {
    const k = m.sessionId + m.params.requestId;
    if (reqs.has(k)) { reqs.get(k).blocked = m.params.blockedReason; }
    R.network.blockedCsp++;
  }
});
const webEntries = title => IE(`JSON.stringify(performance.getEntriesByType('resource').map(e => e.name).filter(n => /^https?:/.test(n)).map(n => new URL(n).host))`, title).then(JSON.parse);
const outside = ph => [...reqs.values()].filter(r => !r.blocked && (!ph || r.phase === ph));

const shots = [];
const NOSHOT = !!process.env.GATE_NOSHOT; // old Electron builds can time out on screenshots of a background window
const shot = async name => { if (NOSHOT) return name; const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(path.basename(f)); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 500)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const must = (c, msg) => { if (!c) throw new Error(msg); };

// ---- helpers for the two frames ----
let outerWv = null;
const outer = async () => {
  if (outerWv) { try { await vs.wvEval(outerWv, '1'); return outerWv; } catch { outerWv = null; } }
  outerWv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'HTML Preview' && w.w > 0), 15000);
  if (!outerWv) throw new Error('preview panel not found');
  return outerWv;
};
const OE = async expr => vs.wvEval(await outer(), expr);
const P = async () => JSON.parse(await OE('JSON.stringify(window.htmlPreviewProbe())'));
async function innerCtx() {
  for (const [sid, info] of vs.attached) {
    for (const c of vs.ctx.get(sid) || []) {
      if (!c.auxData?.isDefault) continue;
      try {
        const r = await Promise.race([vs.s.send('Runtime.evaluate', { expression: `!!document.querySelector('script[data-html-preview=bootstrap]') && document.visibilityState + '|' + (window.innerWidth > 0) + '|' + document.title`, contextId: c.id, returnByValue: true, timeout: 800 }, sid), sleep(1000).then(() => { throw new Error('busy'); })]);
        if (r.result.value && r.result.value.split('|')[1] === 'true') {
          // the visible one: its frame element in the toolbar page has no 'loading' class
          return { sid, cid: c.id, title: r.result.value.split('|').slice(2).join('|') };
        }
      } catch {}
    }
  }
  return null;
}
const IE = async (expr, title) => {
  const ctx = await vs.waitFor(async () => { const c = await innerCtx(); return c && (!title || c.title === title) ? c : null; }, 15000, 150);
  if (!ctx) throw new Error('page frame not found' + (title ? ' for ' + title : ''));
  const r = await vs.s.send('Runtime.evaluate', { expression: expr, contextId: ctx.cid, returnByValue: true, awaitPromise: true }, ctx.sid);
  if (r.exceptionDetails) throw new Error('IE: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const waitSeq = async (after, ms = 15000) => vs.waitFor(async () => { const p = await P(); return p.seq > after && p.frames === 1 ? p : null; }, ms, 100);
// Real mouse click on an element of the page frame.
async function clickInner(selector, title) {
  const o = await outer();
  const off = await vs.wvOffset();
  const fr = JSON.parse(await vs.wvEval(o, `JSON.stringify((() => { const f = document.querySelector('#wrap iframe:not(.loading)'); const b = f.getBoundingClientRect(); const m = /scale\\(([\\d.]+)\\)/.exec(f.style.transform || ''); return { x: b.x, y: b.y, z: m ? Number(m[1]) : 1 }; })())`));
  const el = JSON.parse(await IE(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }; })())`, title));
  if (!el) throw new Error('no element ' + selector);
  await sleep(150);
  await vs.click(off.x + fr.x + el.x * fr.z, off.y + fr.y + el.y * fr.z);
}
async function clickOuter(selector) { await vs.wvClick(await outer(), `document.querySelector(${JSON.stringify(selector)})`); }
async function setSelect(id, value) { await OE(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`); await sleep(400); }
const dialog = () => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d && d.offsetParent !== null ? d.textContent.slice(0, 400) : ''; })()`);
// Real click in the text of the first editor group, so keys and newly opened files go there (not into the preview group).
async function focusEditor() {
  for (let i = 0; i < 3; i++) { try { return await focusEditor1(); } catch (e) { if (i === 2) throw e; await sleep(500); } }
}
async function focusEditor1() {
  await vs.key('Escape', 'Escape');
  // A real click on the active tab of the first editor group, then in its text below the sticky-scroll lines.
  const t = JSON.parse(await vs.wbEval(`(() => { const g = document.querySelector('.editor-group-container'); const tab = g && (g.querySelector('.tab.active') || g.querySelector('.tab')); if (!tab) return 'null'; const r = tab.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  if (t) await vs.click(t.x, t.y);
  const b = JSON.parse(await vs.wbEval(`(() => { const g = document.querySelector('.editor-group-container'); const v = g && g.querySelector('.monaco-editor .view-lines'); if (!v) return 'null'; const r = v.getBoundingClientRect(); return JSON.stringify({ x: r.x + Math.min(200, r.width / 2), y: r.y + Math.min(260, r.height / 2) }); })()`));
  if (b) await vs.click(b.x, b.y);
  await sleep(250);
  const first = await vs.wbEval(`(() => { const gs = [...document.querySelectorAll('.editor-group-container')]; return gs.length > 0 && gs[0].classList.contains('active'); })()`);
  if (!first) throw new Error('first editor group is not active');
}
async function openFile(rel) {
  await focusEditor();
  const before = (await P().catch(() => ({ seq: 0 }))).seq;
  const t0 = Date.now();
  vs.open(path.join(ws, rel));
  const p = await waitSeq(before, 30000);
  return { p, ms: Date.now() - t0 };
}
const extHostRss = () => {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let best = 0;
    for (const ln of out.split('\n')) if (ln.includes(vs.ud) && /extensionHost|Code Helper \(Plugin\)|utility-sub-type=node.mojom.NodeService/.test(ln)) best = Math.max(best, Number(ln.trim().split(/\s+/)[1]) || 0);
    return Math.round(best / 1024);
  } catch { return -1; }
};

await sleep(2500);

// 1. The .html file opens in the normal text editor after install.
await step('html file opens in the text editor', async () => {
  vs.open(path.join(ws, 'site/index.html'));
  const ok = await vs.waitFor(() => vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); const ed = document.querySelector('.editor-group-container.active .monaco-editor .view-lines'); return !!(t && /index\\.html/.test(t.textContent) && ed && ed.textContent.includes('DOCTYPE')); })()`), 15000);
  must(ok, 'index.html did not open as text');
  const webviews = (await vs.webviews()).length;
  must(webviews === 0, 'a webview opened by itself');
  return { textEditor: true, webviews };
});

// 2. Open the preview with the command; the 3-file site with CSS, @import, url(), defer JS and images.
await step('open preview: site/index.html', async () => {
  const t0 = Date.now();
  let o = null;
  for (let i = 0; i < 3 && !o; i++) { await vs.command('HTML Preview: Open HTML Preview to the Side'); o = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'HTML Preview'), 8000); }
  must(o, 'no preview panel');
  const p = await waitSeq(0);
  must(p, 'no render');
  const ms = Date.now() - t0;
  R.timings.firstPreviewMs = ms;
  const v = JSON.parse(await vs.waitFor(async () => { const s = await IE(`JSON.stringify({ title: document.title, app: document.body.dataset.app, h1: getComputedStyle(document.querySelector('h1')).color, bgImg: getComputedStyle(document.body).backgroundImage.slice(0, 30), hero: document.querySelector('.hero').naturalWidth, logo: document.getElementById('logo').naturalWidth, card: getComputedStyle(document.querySelector('.card')).borderRadius })`); const j = JSON.parse(s); return j.app === 'ok' && j.hero > 0 ? s : null; }, 10000));
  must(v.title === 'Small site, home', 'title ' + v.title);
  must(v.h1 === 'rgb(228, 77, 38)', '@import CSS not applied: ' + v.h1);
  must(v.bgImg.startsWith('url("data:image/svg'), 'CSS url() not applied: ' + v.bgImg);
  must(v.hero === 480 && v.logo === 96, 'images: ' + v.hero + ' ' + v.logo);
  must(v.card === '10px', 'site.css not applied');
  must((await P()).log.some(l => l.includes('app.js loaded')), 'console does not show app.js output');
  const ui = await OE(`JSON.stringify({ sponsor: !!document.querySelector('#zovo-support a[href^="command:htmlPreview.supportDeveloper"]'), more: /More free viewers/.test((document.getElementById('zovo-support') || {}).textContent || '') })`);
  await sleep(500);
  await shot('site-index');
  return { ms, ...v, footer: JSON.parse(ui) };
});

// 3. Save a change to a linked CSS file: the preview updates in under 1 s and keeps the scroll position.
await step('linked CSS saved on disk: update < 1 s, scroll kept', async () => {
  await IE(`window.scrollTo(0, 420), window.scrollY`);
  await sleep(600);
  const y0 = await IE('window.scrollY');
  const f = path.join(ws, 'site/css/base.css');
  const t0 = Date.now();
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('rgb(228, 77, 38)', 'rgb(0, 102, 204)'));
  const ok = await vs.waitFor(async () => (await IE(`getComputedStyle(document.querySelector('h1')).color`)) === 'rgb(0, 102, 204)', 5000, 25);
  const ms = Date.now() - t0;
  must(ok, 'CSS change not shown');
  await sleep(300);
  const y1 = await IE('window.scrollY');
  R.timings.cssSaveMs = ms;
  must(ms < 1000, `took ${ms} ms`);
  must(Math.abs(y1 - y0) <= 4, `scroll ${y0} -> ${y1}`);
  return { ms, scrollBefore: y0, scrollAfter: y1 };
});

// 4. Type in the HTML editor: the preview updates without saving.
await step('typing in the HTML updates the preview (unsaved)', async () => {
  await focusEditor();
  await vs.key('ArrowDown', 'ArrowDown', 4, 40); // Cmd+Down: end of the file
  const t0 = Date.now();
  await vs.type('\nTYPED-MARKER-7731');
  const ok = await vs.waitFor(async () => (await IE(`document.body.innerText.includes('TYPED-MARKER-7731')`)) === true, 8000, 50);
  must(ok, 'typed text not shown');
  const ms = Date.now() - t0;
  R.timings.typeMs = ms;
  const dirty = await vs.wbEval(`!!document.querySelector('.tabs-container .tab.active.dirty')`);
  return { ms, unsavedEditor: dirty };
});

// 5. Copy text from the preview with Cmd+C.
await step('copy text from the preview', async () => {
  setClip('before-copy');
  await clickInner('#copyme', 'Small site, home');
  await IE(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('copyme')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s); })()`);
  await vs.key('c', 'KeyC', 4, 67);
  const ok = await vs.waitFor(() => getClip() === 'The quick brown fox jumps over the lazy dog.', 4000, 100);
  must(ok, 'clipboard has: ' + JSON.stringify(getClip().slice(0, 80)));
  return { clipboard: getClip() };
});

// 6. A button handler and a same-page anchor.
await step('page JS click handler and #fragment link', async () => {
  await clickInner('#more', 'Small site, home');
  await clickInner('#more', 'Small site, home');
  const n = await IE(`document.getElementById('counter').textContent`);
  must(n === '2', 'counter ' + n);
  await IE('window.scrollTo(0, 0)');
  const seq = (await P()).seq;
  await clickInner('a[href="#end"]', 'Small site, home');
  await sleep(500);
  const y = await IE('window.scrollY');
  must(y > 200, 'fragment did not scroll: ' + y);
  must((await P()).seq === seq, 'fragment link re-rendered the page');
  return { counter: n, scrolled: y };
});

// 7. Local links switch the preview; Back and Forward.
await step('local link, Back and Forward', async () => {
  let seq = (await P()).seq;
  const ua0 = (await P()).ua;
  await clickInner('#toAbout', 'Small site, home');
  let p = await waitSeq(seq);
  must(p && p.file.startsWith('about.html'), 'not on about: ' + (p && p.file) + ' ua before ' + JSON.stringify(ua0) + ' after ' + JSON.stringify((await P()).ua));
  must(await IE('document.title', 'Small site, About') === 'Small site, About', 'about title');
  must(p.back && !p.forward, 'history buttons ' + p.back + ' ' + p.forward);
  seq = p.seq; await clickOuter('#back'); p = await waitSeq(seq);
  must(p.file.startsWith('index.html') && p.forward, 'back failed: ' + p.file);
  seq = p.seq; await clickOuter('#forward'); p = await waitSeq(seq);
  must(p.file.startsWith('about.html'), 'forward failed: ' + p.file);
  seq = p.seq; await clickInner('a[href="docs/guide.html"]', 'Small site, About'); p = await waitSeq(seq);
  must(p.file.startsWith('guide.html'), 'guide: ' + p.file);
  const h1 = await IE(`getComputedStyle(document.querySelector('header')).backgroundColor`, 'Small site, Guide');
  must(h1 === 'rgb(29, 39, 51)', '../css not applied in docs/guide.html: ' + h1);
  seq = p.seq; await clickOuter('#back'); p = await waitSeq(seq);
  seq = p.seq; await clickOuter('#back'); p = await waitSeq(seq);
  must(p.file.startsWith('index.html'), 'back to index: ' + p.file);
  return { ok: true };
});

// 8. An external link asks first, and Cancel opens nothing.
await step('external link asks before opening', async () => {
  // A web link needs a click made after the page appeared; the Back click above is less than 5 s old.
  await clickInner('#external', 'Small site, home');
  await sleep(300);
  const hintShown = (await P()).notice;
  await sleep(5200);
  await clickInner('#external', 'Small site, home');
  const d = await vs.waitFor(dialog, 5000, 100);
  must(d && d.includes('example.com'), 'no confirm dialog: ' + d);
  await shot('external-link-confirm');
  await vs.key('Escape', 'Escape');
  await sleep(500);
  must(!(await dialog()), 'dialog still open');
  return { dialog: d.slice(0, 120), firstClickHint: hintShown };
});

// 9. Device widths and zoom.
await step('device widths and zoom', async () => {
  const out = {};
  for (const w of ['320', '375', '768', '1024', '1440']) {
    await setSelect('width', w);
    out[w] = await IE('window.innerWidth');
    must(out[w] === Number(w), `width ${w} -> ${out[w]}`);
    if (w === '375') await shot('width-375');
  }
  const p = await P();
  must(p.zoom < 1, '1440 should fit by zooming out: ' + p.zoom);
  await setSelect('zoom', '0.5');
  must(Math.abs((await P()).zoom - 0.5) < 0.001, 'zoom 50%');
  await setSelect('width', 'custom');
  await OE(`(() => { const c = document.getElementById('custom'); c.value = '600'; c.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  out.custom = await IE('window.innerWidth');
  must(out.custom === 600, 'custom ' + out.custom);
  await setSelect('zoom', 'fit'); await setSelect('width', 'fill');
  return out;
});

// 10. Editor-to-preview scroll sync.
await step('scroll sync from the editor', async () => {
  await clickOuter('#sync');
  must((await P()).prefs.sync, 'sync not on');
  await focusEditor();
  await vs.key('ArrowUp', 'ArrowUp', 4, 38); // Cmd+Up: top of the file on macOS
  await sleep(1200);
  const yTop = await IE('window.scrollY');
  await vs.key('ArrowDown', 'ArrowDown', 4, 40); // Cmd+Down: end of the file on macOS
  await sleep(1200);
  const yEnd = await IE('window.scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)');
  const synced = (await P()).synced;
  await clickOuter('#sync');
  must(yEnd > 0.7, 'did not follow to the end: ' + yEnd);
  must(yTop < 50, 'did not follow to the top: ' + yTop);
  return { yEnd, yTop, synced };
});

// 11. Remote resources: blocked by default, then loaded for this file only after a click.
await step('bootstrap CDN page: web resources blocked, then loaded on click', async () => {
  phase = 'bootstrap-blocked';
  const { p } = await openFile('bootstrap-cdn.html');
  must(p && p.remoteBar, 'no remote bar');
  must(/asks for [3-9] web resources/.test(p.remoteMsg), p.remoteMsg);
  const pad = await IE(`getComputedStyle(document.getElementById('btn')).paddingTop`, 'Bootstrap from a CDN');
  await sleep(1500);
  await shot('remote-blocked');
  const webBlocked = await webEntries('Bootstrap from a CDN');
  must(webBlocked.length === 0, 'page loaded from the web while blocked: ' + webBlocked);
  must(outside('bootstrap-blocked').length === 0, 'network while blocked: ' + JSON.stringify(outside('bootstrap-blocked')));
  phase = 'bootstrap-loaded';
  const seq = (await P()).seq;
  await clickOuter('#remoteLoad');
  const p2 = await waitSeq(seq, 20000);
  must(p2 && /on for this page/.test(p2.remoteMsg), 'not on: ' + (p2 && p2.remoteMsg));
  const pad2 = await vs.waitFor(async () => { const v = await IE(`getComputedStyle(document.getElementById('btn')).paddingTop`, 'Bootstrap from a CDN'); return v !== pad ? v : null; }, 15000, 250);
  const hosts = [...new Set([...outside('bootstrap-loaded').map(r => new URL(r.url).host), ...(await webEntries('Bootstrap from a CDN'))])];
  await shot('remote-loaded');
  phase = 'after-block';
  const seq2 = (await P()).seq;
  await clickOuter('#remoteBlock');
  const p3 = await waitSeq(seq2, 20000);
  must(p3 && /Nothing was loaded/.test(p3.remoteMsg), 'block again failed');
  must(pad2, 'Bootstrap CSS did not apply after Load');
  must(hosts.includes('cdn.jsdelivr.net'), 'no CDN request after Load: ' + hosts);
  return { blockedPadding: pad, loadedPadding: pad2, hostsAfterLoad: hosts, webEntriesWhileBlocked: webBlocked.length };
});
phase = 'default';

// 12. The other sample pages.
const pages = [
  ['picture-srcset.html', 'srcset and picture', `JSON.stringify({ a: [document.getElementById('srcsetImg').currentSrc.slice(0, 15), document.getElementById('srcsetImg').naturalWidth], b: document.getElementById('sizesImg').naturalWidth, c: [document.getElementById('pictureImg').currentSrc.slice(0, 19), document.getElementById('pictureImg').naturalWidth] })`,
    v => v.a[0] === 'data:image/png;' && v.a[1] > 0 && v.b > 0 && v.c[1] > 0 && v.c[0].startsWith('data:image/')],
  ['inline-svg.html', 'Inline SVG', `JSON.stringify({ href: document.getElementById('svgImage').getAttribute('href').slice(0, 15), w: document.getElementById('svgImage').getBBox().width })`, v => v.href === 'data:image/png;' && v.w === 96],
  ['base-href.html', 'Base href', `JSON.stringify({ img: document.getElementById('baseImg').naturalWidth, h1: getComputedStyle(document.querySelector('h1')).letterSpacing })`, v => v.img === 96 && v.h1 === '0.5px'],
  ['Résumé ü/页面 ünïcødé.html', 'Non-ASCII names', `JSON.stringify({ h1: getComputedStyle(document.getElementById('h')).color, u: document.getElementById('u').naturalWidth, up: document.getElementById('u2').naturalWidth })`, v => v.h1 === 'rgb(0, 128, 0)' && v.u === 64 && v.up === 120],
  ['js-console.html', 'Console and JS', `new Promise(r => setTimeout(() => r(JSON.stringify({ out: document.getElementById('out').textContent, mod: document.getElementById('mod').textContent })), 400))`, v => v.out === 'storage: stored' && v.mod === 'module: 42'],
  ['no-background.html', 'No background', `JSON.stringify({ color: getComputedStyle(document.getElementById('t')).color })`, v => (tag === 'dark' ? v.color === 'rgb(212, 212, 212)' : v.color === 'rgb(0, 0, 0)')],
];
for (const [file, title, expr, ok] of pages) {
  await step('page: ' + file, async () => {
    const { p, ms } = await openFile(file);
    must(p, 'no render');
    const v = JSON.parse(await vs.waitFor(async () => { const s = await IE(expr, title); return ok(JSON.parse(s)) ? s : null; }, 8000, 200) || await IE(expr, title));
    must(ok(v), JSON.stringify(v));
    if (file === 'js-console.html') {
      if (!(await P()).prefs.console) await clickOuter('#consoleBtn');
      await sleep(600);
      const q = await P();
      must(q.log.some(l => l.includes('hello from the page')), 'console.log missing');
      must(q.log.some(l => /undefinedFunction is not defined\s*line 9:20/.test(l)), 'error or its line number (9:20) missing: ' + q.log.filter(l => /undefined/.test(l)));
      must(q.log.some(l => l.includes('alert(): alerts show in the console')), 'alert missing');
      must(q.counts.error >= 1 && q.counts.warn >= 1, 'badge counts ' + JSON.stringify(q.counts));
      await shot('console');
      await clickOuter('#consoleBtn');
      v.console = q.log.length;
    }
    if (file === 'no-background.html') {
      await shot('no-background-auto');
      const other = tag === 'dark' ? 'light' : 'dark';
      const seq = (await P()).seq;
      await setSelect('bg', other);
      const c = await vs.waitFor(async () => { const x = await IE(`getComputedStyle(document.getElementById('t')).color`, title); return (other === 'light' ? x === 'rgb(0, 0, 0)' : x === 'rgb(212, 212, 212)') ? x : null; }, 5000, 150);
      must(c, 'page background toggle did not change the text color');
      await setSelect('bg', 'auto');
      v.toggled = c; v.seq = seq;
    }
    if (file === 'picture-srcset.html' || file.startsWith('Résumé')) await shot(file.startsWith('R') ? 'non-ascii' : 'srcset');
    return { ms, ...v };
  });
}

await step('form submit stays in the preview', async () => {
  const { p } = await openFile('form.html');
  must(p, 'no render');
  await clickInner('#submit', 'Form');
  await sleep(600);
  const q = await P();
  must(q.log.some(l => l.includes('Form submit (not sent by the preview): POST https://example.com/signup')), 'no form note: ' + q.log.slice(-3));
  must(await IE('document.title', 'Form') === 'Form', 'navigated away');
  return { note: true };
});

// 13. Large normal file: 2 MB, 10,000 rows.
await step('large page: 2 MB table with 10,000 rows', async () => {
  const before = extHostRss();
  const { p, ms } = await openFile('large-table.html');
  must(p, 'no render');
  const rows = await vs.waitFor(async () => { const n = await IE(`document.querySelectorAll('#big tr').length`, '10,000 rows'); return n === 10000 ? n : null; }, 20000, 100);
  const total = Date.now() - (Date.now() - ms);
  must(rows === 10000, 'rows ' + rows);
  R.timings.largeTableMs = ms;
  await IE('window.scrollTo(0, 99999)', '10,000 rows');
  const after = extHostRss();
  R.extHostMB.push({ at: 'large-table', before, after });
  must(ms < 5000, `took ${ms} ms`);
  return { ms, rows, bytes: fs.statSync(path.join(ws, 'large-table.html')).size, extHostMB: after, total };
});

// 14. Hostile page: no command runs, nothing leaves the machine, no navigation away.
await step('hostile: page tries to reach VS Code, the clipboard and the web', async () => {
  phase = 'hostile-api';
  setClip('before-hostile');
  const userSettings = path.join(work, 'ud', 'User', 'settings.json');
  const settingsBefore = fs.readFileSync(userSettings, 'utf8');
  const tabsBefore = await vs.wbEval(`document.querySelectorAll('.tabs-container .tab').length`);
  // A click in the page shown before, just before the hostile page opens (the user activation is still fresh).
  await openFile('form.html');
  await clickInner('label', 'Form');
  const { p } = await openFile('hostile-api.html');
  must(p, 'no render');
  // The page writes what it tried into #log at once; 300 ms later it tries to leave.
  const log = await vs.waitFor(async () => { const t = await IE(`document.getElementById('log').textContent`, 'Hostile API'); return /acquireVsCodeApi/.test(t) ? t : null; }, 5000, 30) || '';
  await sleep(4500); // past the 3 s meta refresh and the location change
  const q = await P();
  const webHostile = await webEntries('Hostile API');
  must(webHostile.length === 0, 'hostile page loaded from the web: ' + webHostile);
  must(/tried to open another address/.test(q.notice) && q.js === 'JS off', 'no notice after the location change: ' + q.notice);
  must(await IE('document.title', 'Hostile API') === 'Hostile API', 'page not shown again');
  const passwd = await IE(`document.getElementById('passwd').naturalWidth + document.getElementById('abs').naturalWidth + (document.getElementById('passwd').getAttribute('src') === 'data:,' ? 0 : 100)`, 'Hostile API');
  const d = await dialog();
  must(q.file.startsWith('hostile-api.html'), 'preview left the page: ' + q.file);
  must(/acquireVsCodeApi: not defined/.test(log), 'acquireVsCodeApi: ' + log.split('\n')[0]);
  must(/parent\.document: blocked/.test(log) && /top\.document: blocked/.test(log), 'parent/top reachable');
  must(!/PWNED/.test(getClip()), 'clipboard changed: ' + getClip());
  must(fs.readFileSync(userSettings, 'utf8') === settingsBefore, 'settings changed');
  must(!/on for this page/.test(q.remoteMsg), 'web resources turned on by the page');
  must(!d, 'a dialog opened: ' + d);
  must(passwd === 0, 'local file outside the workspace loaded');
  must(q.log.some(l => /outside the workspace/.test(l)), 'no note for /etc/passwd');
  must(q.log.some(l => /meta http-equiv="refresh"/.test(l)), 'no note for meta refresh');
  must(outside('hostile-api').length === 0, 'network: ' + JSON.stringify(outside('hostile-api')));
  const tabsAfter = await vs.wbEval(`document.querySelectorAll('.tabs-container .tab').length`);
  must(tabsAfter <= tabsBefore + 2, `tabs ${tabsBefore} -> ${tabsAfter}`);
  await shot('hostile-api');
  return { log: log.split('\n').slice(0, 8), csBlocked: [...reqs.values()].filter(r => r.phase === 'hostile-api' && r.blocked).length };
});
phase = 'default';

// 15. Hostile page: endless loop. VS Code stays responsive and the page comes back without scripts.
await step('hostile: endless loop is stopped, VS Code stays responsive', async () => {
  await focusEditor();
  const t0 = Date.now();
  vs.open(path.join(ws, 'hostile-loop.html'));
  const lat = [];
  let p = null;
  for (let i = 0; i < 40 && !p; i++) {
    const a = Date.now(); await vs.wbEval('1+1'); lat.push(Date.now() - a);
    try { const q = await P(); if (q.notice && /did not answer|froze/.test(q.notice) && q.js === 'JS off' && q.frames === 1) p = q; } catch {}
    await sleep(500);
  }
  must(p, 'loop was not stopped');
  const ms = Date.now() - t0;
  const h = await IE(`document.getElementById('h').textContent`, 'Endless loop');
  must(h === 'This page never stops', 'page not shown without scripts');
  must(Math.max(...lat) < 1500, 'workbench blocked: ' + Math.max(...lat) + ' ms');
  await shot('hostile-loop');
  R.timings.loopStoppedMs = ms;
  return { stoppedAfterMs: ms, workbenchMaxLatencyMs: Math.max(...lat), notice: p.notice };
});

// 16. Hostile size: 52 MB of HTML gets a message and is not read.
await step('hostile: 52 MB HTML shows a message, file not read', async () => {
  const before = extHostRss();
  await focusEditor();
  vs.open(path.join(ws, largeName));
  await sleep(4000);
  await vs.command('HTML Preview: Open HTML Preview to the Side');
  const msg = await vs.waitFor(async () => { const q = await P(); return /Large file/.test(q.message) ? q.message : null; }, 20000, 200);
  must(msg, 'no large-file message');
  must(/MB/.test(msg) && /never shown|Show anyway/.test(msg), msg);
  const after = extHostRss();
  R.extHostMB.push({ at: '52mb', before, after });
  await shot('hostile-52mb');
  must(!/Show anyway/.test(msg), 'a 52 MB file should not offer Show anyway');
  return { message: msg.slice(0, 220), extHostMB: { before, after } };
});

// 17. Hashes of the hostile samples did not change, and the toolbar page logged no errors of its own.
await step('samples unchanged, no toolbar errors', async () => {
  for (const [f, h] of Object.entries(hostileHashes)) must(hash(path.join(ws, f)) === h, f + ' changed');
  const own = vs.console.filter(c => /vscode-webview/.test(c.where) && c.type === 'exception');
  R.consoleOuter = own.slice(0, 20);
  must(own.length === 0, 'toolbar exceptions: ' + JSON.stringify(own.slice(0, 3)));
  return { exceptions: own.length };
});

R.network.outside = outside();
R.network.outsideByPhase = R.network.outside.reduce((a, r) => ((a[r.phase] = (a[r.phase] || 0) + 1), a), {});
R.extHostFinalMB = extHostRss();
R.shots = shots;
const logs = vs.extHostLogs().filter(f => /HTML Preview\.log$/.test(f));
R.extensionLog = logs.length ? fs.readFileSync(logs[0], 'utf8').split('\n').slice(-40) : [];
await vs.close();
try { setClip(clipBefore); } catch {}
R.passed = R.steps.filter(s => s.ok).length; R.total = R.steps.length;
R.unexpectedNetwork = R.network.outside.filter(r => r.phase !== 'bootstrap-loaded').length;
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`${R.passed}/${R.total} passed; outside requests: ${R.network.outside.length} (${JSON.stringify(R.network.outsideByPhase)}), unexpected ${R.unexpectedNetwork}`);
process.exit(R.passed === R.total && R.unexpectedNetwork === 0 ? 0 : 1);
