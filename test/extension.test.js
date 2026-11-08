'use strict';
// Runs src/extension.js against a small fake of the VS Code API (same approach as mermaid-viewer-vscode):
// command registration, the exported helpers, and one preview render driven through the fake webview.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function makeVscode(opts = {}) {
  const ev = () => { const ls = []; const f = l => { ls.push(l); return { dispose() { const i = ls.indexOf(l); if (i >= 0) ls.splice(i, 1); } }; }; f.fire = x => ls.forEach(l => l(x)); return f; };
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.authority = ''; this.path = p; this.fsPath = p; }
    toString() { return `${this.scheme}://${this.path.split('/').map(encodeURIComponent).join('/')}`; }
    static file(p) { return new Uri('file', p); }
    static parse(s) { const u = new URL(s); return new Uri(u.protocol.slice(0, -1), decodeURIComponent(u.pathname)); }
    static joinPath(u, ...ps) { return new Uri(u.scheme, path.posix.join(u.path, ...ps)); }
  }
  class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
  const files = new Map(Object.entries(opts.files || {}).map(([k, v]) => [k, Buffer.from(v)]));
  const S = { panels: [], info: [], warn: [], err: [], config: Object.assign({}, opts.config || {}), ws: new Map(), watchers: 0 };
  const commands = new Map();
  const folders = (opts.folders || ['/w']).map(p => ({ uri: Uri.file(p), name: path.posix.basename(p), index: 0 }));
  const vscode = {
    Uri, RelativePattern,
    ViewColumn: { Active: -1, Beside: -2, One: 1 }, ConfigurationTarget: { Global: 1 }, FileType: { File: 1, Directory: 2 },
    QuickPickItemKind: { Separator: -1 },
    env: { remoteName: undefined, openExternal: async () => true },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    extensions: { getExtension: () => undefined },
    workspace: {
      textDocuments: opts.docs || [],
      workspaceFolders: folders,
      isTrusted: true,
      getWorkspaceFolder: u => folders.find(f => u.path.startsWith(f.uri.path + '/')),
      asRelativePath: u => u.path.replace(/^\/w\/?/, ''),
      getConfiguration: () => ({ get: (k, d) => (k in S.config ? S.config[k] : d), update: async (k, v) => { S.config[k] = v; } }),
      createFileSystemWatcher: () => { S.watchers++; return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() { S.watchers--; } }; },
      fs: {
        stat: async u => { const b = files.get(u.path); if (!b) throw new Error('nf'); return { type: 1, size: b.length }; },
        readFile: async u => { const b = files.get(u.path); if (!b) throw new Error('nf'); return new Uint8Array(b); },
      },
      onDidChangeTextDocument: ev(), onDidSaveTextDocument: ev(), onDidGrantWorkspaceTrust: ev(), onDidChangeConfiguration: ev(),
    },
    window: {
      state: { focused: true },
      activeTextEditor: opts.activeTextEditor,
      tabGroups: { activeTabGroup: { activeTab: opts.activeTab }, onDidChangeTabs: () => ({ dispose() {} }) },
      onDidChangeActiveTextEditor: ev(), onDidChangeTextEditorVisibleRanges: ev(),
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, trace() {}, dispose() {} }),
      registerWebviewPanelSerializer: () => ({ dispose() {} }),
      setStatusBarMessage: m => { S.info.push(m); return { dispose() {} }; },
      showInformationMessage: async m => { S.info.push(m); }, showWarningMessage: async m => { S.warn.push(m); }, showErrorMessage: async m => { S.err.push(m); },
      showQuickPick: async () => undefined,
      createWebviewPanel: (type, title, col, o) => {
        const recv = ev(), disp = ev(), view = ev();
        const p = { type, title, col, visible: true, posted: [], iconPath: null,
          webview: { options: o, html: '', onDidReceiveMessage: recv, postMessage: async m => { p.posted.push(m); return true; } },
          onDidDispose: disp, onDidChangeViewState: view, reveal() {}, dispose() { disp.fire(); },
          send: m => recv.fire(m), last: t => [...p.posted].reverse().find(m => m.type === t) };
        S.panels.push(p); return p;
      },
    },
  };
  const ctx = { extensionUri: Uri.file('/ext'), subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: (k, d) => (S.ws.has(k) ? S.ws.get(k) : d), update: async (k, v) => { S.ws.set(k, v); } } };
  return { vscode, S, ctx, commands, Uri };
}

function load(env) {
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { return req === 'vscode' ? env.vscode : orig.call(this, req, parent, isMain); };
  try {
    const src = path.join(__dirname, '..', 'src') + path.sep;
    for (const k of Object.keys(require.cache)) if (k.startsWith(src)) delete require.cache[k];
    return require('../src/extension.js');
  } finally { Module._load = orig; }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const doc = (uri, languageId, text = '') => ({ uri, languageId, getText: () => text });

test('activate registers the preview commands (and the support commands)', () => {
  const env = makeVscode();
  const ext = load(env);
  const api = ext.activate(env.ctx);
  for (const id of ['htmlPreview.showPreviewToSide', 'htmlPreview.showPreview', 'htmlPreview.openWalkthrough', 'htmlPreview.supportDeveloper', 'htmlPreview.moreViewers']) assert.ok(env.commands.has(id), id);
  assert.ok(api && api._ext);
  assert.ok(env.ctx.subscriptions.length >= 5);
});

test('cleanPrefs keeps good values and replaces bad ones', () => {
  const { cleanPrefs } = load(makeVscode())._test;
  const s = { bg: 'dark', sync: true };
  assert.deepEqual(cleanPrefs({ width: '768', custom: 1234.4, zoom: '1.25', bg: 'light', sync: false, console: true }, s), { width: '768', custom: 1234, zoom: '1.25', bg: 'light', sync: false, console: true });
  assert.deepEqual(cleanPrefs({ width: 375, zoom: 2 }, s).width, '375', 'numbers are accepted as strings');
  const bad = cleanPrefs({ width: '"><img src=x onerror=alert(1)>', custom: 99999, zoom: '7', bg: 'neon', sync: 'yes', console: 'true' }, s);
  assert.deepEqual(bad, { width: 'fill', custom: 390, zoom: 'fit', bg: 'dark', sync: true, console: false });
  assert.equal(cleanPrefs({ custom: 199 }, s).custom, 390);
  assert.equal(cleanPrefs({ custom: 200 }, s).custom, 200);
  assert.equal(cleanPrefs({ custom: 4000 }, s).custom, 4000);
  assert.equal(cleanPrefs({ custom: 'abc' }, s).custom, 390);
  for (const p of [undefined, null, 'x', 42, []]) assert.deepEqual(cleanPrefs(p, s), { width: 'fill', custom: 390, zoom: 'fit', bg: 'dark', sync: true, console: false }, String(p));
});

test('isHtmlDoc: languageId html, or an .html/.htm/.xhtml/.shtml path', () => {
  const { isHtmlDoc } = load(makeVscode())._test;
  const u = p => ({ path: p });
  assert.equal(isHtmlDoc(doc(u('/a/notes.txt'), 'html')), true);
  for (const p of ['/a/x.htm', '/a/x.HTML', '/a/x.xhtml', '/a/x.shtml', '/a/x.html']) assert.equal(isHtmlDoc(doc(u(p), 'plaintext')), true, p);
  for (const p of ['/a/x.md', '/a/x.html.bak', '/a/htm', '/a/x.php']) assert.equal(isHtmlDoc(doc(u(p), 'plaintext')), false, p);
  assert.equal(isHtmlDoc(undefined), false);
  assert.equal(isHtmlDoc(null), false);
});

test('targetUri: explicit Uri, then active HTML editor, then active .html tab, then any active editor', () => {
  const base = makeVscode();
  const { Uri } = base;
  let env = base;
  let t = load(env)._test;
  const given = Uri.file('/w/given.html');
  assert.equal(t.targetUri(given), given);
  assert.equal(t.targetUri(undefined), null);

  const ed = Uri.file('/w/page.htm');
  env = makeVscode({ activeTextEditor: { document: doc(ed, 'plaintext') } });
  t = load(env)._test;
  assert.equal(t.targetUri(undefined).path, '/w/page.htm');

  env = makeVscode({ activeTextEditor: { document: doc(Uri.file('/w/a.css'), 'css') } });
  // the tab's Uri must be an instance of the fake's Uri class
  env.vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: env.Uri.file('/w/tab.xhtml') } };
  t = load(env)._test;
  assert.equal(t.targetUri(undefined).path, '/w/tab.xhtml');

  env = makeVscode({ activeTextEditor: { document: doc(Uri.file('/w/a.css'), 'css') } });
  t = load(env)._test;
  assert.equal(t.targetUri(undefined).path, '/w/a.css', 'falls back to the active editor');

  // A file over 50 MB has a tab but no text editor: the old editor is still "active" in the extension host.
  env = makeVscode({ activeTextEditor: { document: doc(Uri.file('/w/old.html'), 'html') } });
  env.vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: env.Uri.file('/w/huge.html') } };
  t = load(env)._test;
  assert.equal(t.targetUri(undefined).path, '/w/huge.html', 'the active tab wins over a stale editor');
});

test('showPreview with nothing open asks for an .html file', async () => {
  const env = makeVscode();
  load(env).activate(env.ctx);
  await env.commands.get('htmlPreview.showPreview')();
  assert.deepEqual(env.S.info, ['Open an .html file first.']);
  assert.equal(env.S.panels.length, 0);
});

test('open a preview: strict CSP page, then a render with local CSS/images inlined and remote blocked', async () => {
  const files = {
    '/w/index.html': '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/s.css"><script src="https://cdn.x.com/a.js"></script></head><body><img src="img/a.png"></body></html>',
    '/w/css/s.css': 'body{background:url(../img/a.png)}',
    '/w/img/a.png': 'PNG',
  };
  const env = makeVscode({ files });
  const ext = load(env);
  ext.activate(env.ctx);
  await env.commands.get('htmlPreview.showPreviewToSide')(env.Uri.file('/w/index.html'));
  const p = env.S.panels[0];
  try {
    assert.ok(p, 'panel created');
    assert.equal(p.type, 'htmlPreview.preview');
    assert.equal(p.title, 'Preview index.html');
    assert.equal(p.webview.options.enableScripts, true);
    assert.deepEqual(p.webview.options.localResourceRoots, []);
    assert.match(p.webview.html, /default-src &#39;none&#39;/);
    assert.match(p.webview.html, /connect-src &#39;none&#39;/);
    assert.doesNotMatch(/content="([^"]*)"/.exec(p.webview.html)[1], /https?:/);

    p.send({ type: 'ready' }); await tick(40);
    assert.equal(p.last('init').prefs.width, 'fill');
    const r = p.last('render');
    assert.ok(r, 'render posted: ' + JSON.stringify(env.S.err));
    assert.equal(r.uri, 'file:///w/index.html');
    assert.match(r.html, /<head><script data-html-preview="bootstrap">/);
    assert.match(r.html, /<link rel="stylesheet" href="data:text\/css;base64,/);
    assert.ok(r.html.includes('src="data:image/png;base64,' + Buffer.from('PNG').toString('base64') + '"'));
    assert.match(r.html, /type="text\/html-preview-blocked" data-src="https:\/\/cdn\.x\.com\/a\.js"/);
    assert.equal(r.remote.unique, 1);
    assert.deepEqual(r.remote.hosts, ['cdn.x.com']);
    assert.equal(r.scripts, true);
    assert.deepEqual(r.notes, []);
    assert.equal(env.S.err.length, 0);

    // a bad prefs message from the webview is cleaned before it is stored
    p.send({ type: 'prefs', prefs: { width: 'evil', zoom: '2', bg: 'light' } }); await tick();
    const stored = env.S.ws.get('htmlPreview.prefs');
    assert.equal(stored.width, 'fill'); assert.equal(stored.zoom, '2'); assert.equal(stored.bg, 'light');
  } finally {
    if (p) p.dispose();
  }
  assert.equal(env.S.watchers, 0, 'watchers disposed with the panel');
});

test('runScripts=false: the render has no page <script> and says scripts are off', async () => {
  const env = makeVscode({ files: { '/w/a.html': '<head></head><script>alert(1)</script><a onclick="x()" href="javascript:y()">l</a>' }, config: { runScripts: false } });
  load(env).activate(env.ctx);
  await env.commands.get('htmlPreview.showPreview')(env.Uri.file('/w/a.html'));
  const p = env.S.panels[0];
  try {
    p.send({ type: 'ready' }); await tick(40);
    const r = p.last('render');
    assert.equal(r.scripts, false);
    assert.equal(r.scriptsLocked, true);
    const page = r.html.replace(/<script data-html-preview="bootstrap">[\s\S]*?<\/script>/, '');
    assert.doesNotMatch(page, /<script|onclick|javascript:/i);
  } finally { p.dispose(); }
});

test('a page outside the workspace reads only its own folder: not the folder above, never .ssh (VER11)', async () => {
  const files = {
    '/h/u/Downloads/x.html': '<html><body><img id=a src="../.ssh/id_rsa"><img id=b src="../notes.png"><img id=c src="ok.png"><img id=d src=".ssh/id_rsa"></body></html>',
    '/h/u/.ssh/id_rsa': 'PRIVATE KEY', '/h/u/notes.png': 'UP', '/h/u/Downloads/ok.png': 'OK', '/h/u/Downloads/.ssh/id_rsa': 'KEY2',
  };
  const env = makeVscode({ files });
  const ext = load(env);
  ext.activate(env.ctx);
  await env.commands.get('htmlPreview.showPreviewToSide')(env.Uri.file('/h/u/Downloads/x.html'));
  const p = env.S.panels[0];
  try {
    p.send({ type: 'ready' }); await tick(60);
    const r = p.last('render');
    assert.ok(r, 'render posted: ' + JSON.stringify(env.S.err));
    for (const secret of ['PRIVATE KEY', 'UP', 'KEY2']) assert.ok(!r.html.includes(Buffer.from(secret).toString('base64')), secret + ' must not be read');
    assert.ok(r.html.includes(Buffer.from('OK').toString('base64')), 'a file in the page folder is read');
  } finally { p.dispose(); }
});

test('a page script cannot reload the preview more than once a second (VER11)', async () => {
  const files = { '/w/a.html': '<p>x</p>' };
  const env = makeVscode({ files });
  const ext = load(env);
  ext.activate(env.ctx);
  await env.commands.get('htmlPreview.showPreviewToSide')(env.Uri.file('/w/a.html'));
  const p = env.S.panels[0];
  try {
    p.send({ type: 'ready' }); await tick(60);
    const n0 = p.posted.filter(m => m.type === 'render').length;
    for (let i = 0; i < 20; i++) p.send({ type: 'reload' });
    await tick(80);
    const n1 = p.posted.filter(m => m.type === 'render').length;
    assert.ok(n1 - n0 <= 1, `renders after 20 reloads: ${n1 - n0}`);
  } finally { p.dispose(); }
});
