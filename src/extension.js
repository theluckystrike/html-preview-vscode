'use strict';
// HTML Preview: a live preview of an HTML file beside its editor. No web server: the extension reads the page and
// every local file it links (through the VS Code file system API, so it also works over Remote-SSH, WSL and in
// containers), turns them into one document, and shows it in a sandboxed frame. Nothing is sent anywhere, and
// nothing is loaded from the web unless the user clicks "Load for this file". The .html editor is never replaced.
const vscode = require('vscode');
const path = require('path');
const { rewriteHtml, resolveLink } = require('./core/rewrite');
const { buildHtml, bootstrapTag } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const SECTION = 'htmlPreview';
const VIEW_TYPE = 'htmlPreview.preview';
const EXT_ID = 'zovo.zovo-html-preview';
const PREFS_KEY = 'htmlPreview.prefs';
const REMOTE_KEY = 'htmlPreview.remoteFiles';
const HARD_MAX_MB = 32;
const HTML_RE = /\.(html?|xhtml|shtml)$/i;
let rating = { success() {}, failure() {} };
let log = { info() {}, warn() {}, error() {} };

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  const num = (k, lo, hi, d) => { const n = Number(c.get(k, d)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return {
    follow: c.get('followActiveEditor', true) !== false,
    delay: num('updateDelayMs', 0, 5000, 300),
    scripts: c.get('runScripts', true) !== false,
    remote: c.get('loadRemoteResources', false) === true,
    bg: ['auto', 'light', 'dark'].includes(c.get('pageBackground', 'auto')) ? c.get('pageBackground', 'auto') : 'auto',
    sync: c.get('scrollSync', false) === true,
    maxFileMB: num('maxFileMB', 1, 200, 10),
    maxResourceMB: num('maxResourceMB', 1, 500, 25),
    stuckSeconds: num('stuckScriptSeconds', 2, 120, 5),
  };
}

const isHtmlDoc = d => !!d && (d.languageId === 'html' || HTML_RE.test(d.uri.path));
const WIDTHS = ['fill', '320', '375', '768', '1024', '1440', 'custom'];
const ZOOMS = ['fit', '0.5', '0.67', '0.75', '0.9', '1', '1.1', '1.25', '1.5', '2'];
/** Toolbar choices kept per workspace; checked so a bad stored value cannot reach the page. */
function cleanPrefs(p, s) {
  const o = p && typeof p === 'object' ? p : {};
  const cw = Math.round(Number(o.custom));
  return {
    width: WIDTHS.includes(String(o.width)) ? String(o.width) : 'fill',
    custom: cw >= 200 && cw <= 4000 ? cw : 390,
    zoom: ZOOMS.includes(String(o.zoom)) ? String(o.zoom) : 'fit',
    bg: ['auto', 'light', 'dark'].includes(o.bg) ? o.bg : s.bg,
    sync: typeof o.sync === 'boolean' ? o.sync : s.sync,
    console: o.console === true,
  };
}

/** Folder URL string ending with '/'. */
const dirUrl = u => { const s = u.toString(); return s.slice(0, s.lastIndexOf('/') + 1); };
const withSlash = s => (s.endsWith('/') ? s : s + '/');

class Preview {
  constructor(ext, panel) {
    this.ext = ext; this.panel = panel; this.uri = null; this.history = []; this.at = -1;
    this.timer = null; this.seq = 0; this.ready = false; this.disposed = false;
    this.cache = new Map(); this.watchers = new Map(); this.deps = new Set();
    this.scriptsOff = new Set(); this.forceLarge = new Set(); this.counted = new Set();
    this.base = ''; this.lastAlive = 0; this.renderedSeq = 0; this.notice = null;
    panel.iconPath = vscode.Uri.joinPath(ext.context.extensionUri, 'media', 'preview-icon.svg');
    this.subs = [
      panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => vscode.window.showErrorMessage('HTML Preview: ' + (err && err.message || err)))),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) this.lastAlive = Date.now(); }),
    ];
    this.load();
    // A page whose scripts froze the whole preview stops sending "alive". Then the panel is replaced.
    this.watch = setInterval(() => this.checkAlive(), 2000);
  }

  get remoteFiles() { return new Set(this.ext.context.workspaceState.get(REMOTE_KEY, [])); }

  remoteAllowed(uri) {
    if (settings().remote) return 'setting';
    return uri && this.remoteFiles.has(uri.toString()) ? 'file' : '';
  }

  /** (Re)build the toolbar page. The CSP depends on whether web resources are on for the file. */
  load() {
    const wv = this.panel.webview;
    this.ready = false; this.webOn = !!this.remoteAllowed(this.uri);
    wv.options = { enableScripts: true, localResourceRoots: [], enableCommandUris: commandUris(SECTION) };
    wv.html = buildHtml({ remote: this.webOn, showSupportLinks: showLinks(vscode, SECTION) });
    this.lastAlive = Date.now();
  }

  prefs() { return cleanPrefs(this.ext.context.workspaceState.get(PREFS_KEY), settings()); }
  post(m) { if (!this.disposed) return this.panel.webview.postMessage(m).then(undefined, () => false); return Promise.resolve(false); }

  /** Show a file. push = add to Back/Forward history. */
  async show(uri, push = true) {
    if (!uri) return;
    if (push) {
      if (this.uri && this.uri.toString() === uri.toString()) { this.schedule(0); return; }
      this.history = this.history.slice(0, this.at + 1); this.history.push(uri.toString()); this.at = this.history.length - 1;
      if (this.history.length > 100) { this.history.shift(); this.at--; }
    }
    this.uri = uri;
    this.notice = null;
    this.panel.title = 'Preview ' + path.posix.basename(uri.path);
    this.cache.clear();
    if (!!this.remoteAllowed(uri) !== this.webOn) { this.load(); return; } // render after "ready"
    this.schedule(0);
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render().catch(err => {
      log.error(`render failed: ${err && err.stack || err}`);
      vscode.window.showErrorMessage('HTML Preview: ' + (err && err.message || err));
    }), delay);
  }

  doc(uri) { const k = uri.toString(); return vscode.workspace.textDocuments.find(d => d.uri.toString() === k); }

  /** Folders the page may read from: the workspace folders, the page's folder and the folder above it. */
  roots(uri) {
    const out = (vscode.workspace.workspaceFolders || []).map(f => withSlash(f.uri.toString()));
    const d = dirUrl(uri);
    out.push(d);
    const up = d.slice(0, d.slice(0, -1).lastIndexOf('/') + 1);
    if (up.length > uri.scheme.length + 3 && /\/[^/]+\/$/.test(up)) out.push(up);
    return out;
  }

  async render() {
    if (this.disposed || !this.ready || !this.uri) return;
    if (!!this.remoteAllowed(this.uri) !== this.webOn) { this.load(); return; } // the page policy must match first
    const uri = this.uri, key = uri.toString(), s = settings(), name = path.posix.basename(uri.path);
    const seq = ++this.seq, t0 = Date.now();
    let text;
    const open = this.doc(uri);
    if (open) text = open.getText();
    if (open && text.length > s.maxFileMB * 1048576 && !this.forceLarge.has(key)) return this.tooLarge(uri, text.length, s);
    if (!open) {
      let size = -1;
      try { size = (await vscode.workspace.fs.stat(uri)).size; } catch (e) { return this.fail(uri, `HTML Preview could not read ${name}: ${e && e.message || e}`); }
      if (size > s.maxFileMB * 1048576 && !(this.forceLarge.has(key) && size <= HARD_MAX_MB * 1048576)) return this.tooLarge(uri, size, s);
      try { text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)); } catch (e) { return this.fail(uri, `HTML Preview could not read ${name}: ${e && e.message || e}`); }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const roots = this.roots(uri);
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    const remote = this.remoteAllowed(uri);
    const scripts = s.scripts && vscode.workspace.isTrusted !== false && !this.scriptsOff.has(key);
    const res = await rewriteHtml(text, {
      docUrl: key, rootUrl: wf ? withSlash(wf.uri.toString()) : dirUrl(uri), allowRemote: !!remote && this.webOn, scripts,
      inject: bootstrapTag(), maxResourceBytes: s.maxResourceMB * 1048576,
      read: u => this.read(u, roots, s),
    });
    if (seq !== this.seq || this.disposed || key !== this.uri.toString()) return;
    this.base = res.base;
    this.watchDeps(res.deps);
    const folder = vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), true);
    let notice = this.notice;
    if (!notice && !scripts && s.scripts && vscode.workspace.isTrusted === false) notice = { text: 'Restricted Mode: the page\'s JavaScript does not run until you trust this folder.' };
    else if (!notice && this.scriptsOff.has(key)) notice = { text: 'JavaScript is off for this page.', action: { id: 'scriptsOn', label: 'Run scripts again' } };
    await this.post({
      type: 'render', seq, html: res.html, uri: key, name, folder: folder === uri.toString() ? '' : folder, path: uri.scheme === 'file' ? uri.fsPath : key,
      canBack: this.at > 0, canForward: this.at < this.history.length - 1, remote: res.remote, remoteAllowed: remote, notes: res.notes,
      scripts, scriptsLocked: vscode.workspace.isTrusted === false || !s.scripts, notice, canOpenBrowser: uri.scheme === 'file' && !vscode.env.remoteName,
    });
    this.lastBytes = res.html.length;
    log.info(`${name}: ${(res.html.length / 1024).toFixed(0)} KB, ${res.deps.length} linked files, ${res.remote.unique} web resources ${remote ? 'loaded' : 'blocked'}, scripts ${scripts ? 'on' : 'off'}, ${Date.now() - t0} ms`);
  }

  /** Read a linked file. Open editors win (unsaved CSS shows at once); files outside the roots are refused. */
  async read(url, roots, s) {
    if (!roots.some(r => url.startsWith(r))) { const e = new Error('outside'); e.code = 'OUTSIDE'; throw e; }
    const uri = vscode.Uri.parse(url);
    const d = this.doc(uri);
    if (d) return Buffer.from(d.getText(), 'utf8');
    const hit = this.cache.get(url);
    if (hit) return hit;
    let st;
    try { st = await vscode.workspace.fs.stat(uri); } catch { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
    if (st.type & vscode.FileType.Directory) { const e = new Error('folder'); e.code = 'ENOENT'; throw e; }
    if (st.size > s.maxResourceMB * 1048576) { const e = new Error('too big'); e.code = 'TOOBIG'; throw e; }
    const b = await vscode.workspace.fs.readFile(uri);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(url, b);
    return b;
  }

  /** One watcher per linked file (and the page itself), so a saved CSS, JS or image change shows at once. */
  watchDeps(list) {
    const want = new Set(list.slice(0, 300));
    if (this.uri) want.add(this.uri.toString());
    this.deps = want;
    for (const [k, w] of this.watchers) if (!want.has(k)) { w.dispose(); this.watchers.delete(k); }
    for (const k of want) {
      if (this.watchers.has(k)) continue;
      try {
        const u = vscode.Uri.parse(k);
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(u, '..'), path.posix.basename(u.path)));
        const changed = () => { this.cache.delete(k); this.schedule(30); };
        w.onDidChange(changed); w.onDidCreate(changed); w.onDidDelete(changed);
        this.watchers.set(k, w);
      } catch {}
    }
  }

  tooLarge(uri, size, s) {
    const mb = (size / 1048576).toFixed(1);
    const canForce = size <= HARD_MAX_MB * 1048576;
    this.post({
      type: 'message', name: path.posix.basename(uri.path), heading: 'Large file',
      text: `${path.posix.basename(uri.path)} is ${mb} MB. HTML Preview shows HTML files up to ${s.maxFileMB} MB (setting htmlPreview.maxFileMB), so this file was not read.` + (canForce ? ' Showing it can make the preview slow.' : ` Files over ${HARD_MAX_MB} MB are never shown.`),
      action: canForce ? { id: 'showLarge', label: 'Show anyway' } : null,
    });
  }

  fail(uri, msg) {
    this.post({ type: 'message', name: path.posix.basename(uri.path), heading: 'Cannot show this file', text: msg });
    if (!this.counted.has(uri.toString())) { this.counted.add(uri.toString()); rating.failure(); }
  }

  checkAlive() {
    if (this.disposed || !this.ready || !this.panel.visible) return;
    const ms = Math.max(8000, settings().stuckSeconds * 1000 + 4000);
    if (Date.now() - this.lastAlive > ms && this.uri) {
      const key = this.uri.toString();
      this.scriptsOff.add(key);
      this.notice = { text: `The page's scripts froze the preview for ${Math.round(ms / 1000)} s, so HTML Preview restarted it without scripts.`, action: { id: 'scriptsOn', label: 'Run scripts again' } };
      this.ext.replacePanel(this);
    }
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type !== 'alive') log.trace && log.trace('webview: ' + m.type);
    switch (m.type) {
      case 'ready': {
        this.ready = true; this.lastAlive = Date.now();
        const s = settings();
        await this.post({ type: 'init', prefs: this.prefs(), stuckSeconds: s.stuckSeconds });
        if (!this.uri && typeof m.uri === 'string' && m.uri) { try { await this.show(vscode.Uri.parse(m.uri)); } catch {} }
        else this.schedule(0);
        break;
      }
      case 'alive': this.lastAlive = Date.now(); break;
      case 'rendered': {
        this.lastAlive = Date.now(); this.renderedSeq = m.seq | 0;
        const k = this.uri && this.uri.toString();
        if (k && !this.counted.has(k)) { this.counted.add(k); rating.success(); }
        break;
      }
      case 'prefs': await this.ext.context.workspaceState.update(PREFS_KEY, cleanPrefs(m.prefs, settings())); this.syncScroll(); break;
      case 'reload': this.cache.clear(); this.notice = null; this.schedule(0); break;
      case 'nav': {
        const to = this.at + (m.dir < 0 ? -1 : 1);
        if (to < 0 || to >= this.history.length) return;
        this.at = to;
        await this.show(vscode.Uri.parse(this.history[to]), false);
        break;
      }
      case 'scripts': {
        const k = this.uri && this.uri.toString(); if (!k) return;
        if (m.on) this.scriptsOff.delete(k); else this.scriptsOff.add(k);
        this.notice = null; this.schedule(0);
        break;
      }
      case 'stuck': {
        if ((m.seq | 0) !== this.seq) return; // an older frame
        const k = this.uri && this.uri.toString(); if (!k) return;
        this.scriptsOff.add(k);
        this.notice = { text: `The page's scripts did not answer for ${settings().stuckSeconds} s, so they were stopped. The page is shown without scripts.`, action: { id: 'scriptsOn', label: 'Run scripts again' } };
        this.schedule(0);
        break;
      }
      case 'leaving': {
        if ((m.seq | 0) !== this.seq) return; // an older frame
        const k = this.uri && this.uri.toString(); if (!k) return;
        this.scriptsOff.add(k);
        this.notice = { text: 'The page\'s script tried to open another address, so the preview shows this file without scripts.', action: { id: 'scriptsOn', label: 'Run scripts again' } };
        this.schedule(0);
        break;
      }
      case 'action':
        if (m.id === 'scriptsOn' && this.uri) { this.scriptsOff.delete(this.uri.toString()); this.notice = null; this.schedule(0); }
        else if (m.id === 'showLarge' && this.uri) { this.forceLarge.add(this.uri.toString()); this.schedule(0); }
        break;
      case 'remote': {
        if (!this.uri) return;
        if (m.mode === 'always') {
          const pick = await vscode.window.showInformationMessage('Load CSS, fonts, scripts and images from the web in every HTML preview? This turns on the setting htmlPreview.loadRemoteResources.', { modal: true }, 'Turn on');
          if (pick !== 'Turn on') return;
          await vscode.workspace.getConfiguration(SECTION).update('loadRemoteResources', true, vscode.ConfigurationTarget.Global);
          return; // the configuration event reloads
        }
        const set = this.remoteFiles;
        if (m.mode === 'file') set.add(this.uri.toString()); else set.delete(this.uri.toString());
        await this.ext.context.workspaceState.update(REMOTE_KEY, [...set].slice(-500));
        this.load();
        break;
      }
      case 'link': await this.openLink(String(m.href || ''), !!m.newTab); break;
      case 'copy': {
        if (typeof m.text !== 'string' || !m.text) return;
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`HTML Preview: copied ${m.text.length.toLocaleString('en-US')} characters`, 3000);
        break;
      }
      case 'openBrowser': if (this.uri && this.uri.scheme === 'file') await vscode.env.openExternal(this.uri); break;
    }
  }

  async openLink(href, newTab) {
    if (!this.uri) return;
    const r = resolveLink(href, this.base || this.uri.toString(), (() => { const wf = vscode.workspace.getWorkspaceFolder(this.uri); return wf ? withSlash(wf.uri.toString()) : dirUrl(this.uri); })());
    if (r.kind === 'external') {
      let u; try { u = vscode.Uri.parse(r.url, true); } catch { return; }
      const pick = await vscode.window.showInformationMessage(`Open this link in your web browser?\n\n${r.url.slice(0, 300)}`, { modal: true }, 'Open');
      if (pick === 'Open') await vscode.env.openExternal(u);
      return;
    }
    if (r.kind === 'blocked') { vscode.window.setStatusBarMessage(`HTML Preview: links of this kind are not opened (${r.url.slice(0, 60)})`, 4000); return; }
    if (r.kind !== 'local') return;
    const target = vscode.Uri.parse(r.url);
    let stat;
    try { stat = await vscode.workspace.fs.stat(target); } catch { vscode.window.showWarningMessage(`HTML Preview: ${decodeURIComponent(r.url.split('/').pop() || r.url)} was not found.`); return; }
    if (stat.type & vscode.FileType.Directory) {
      const idx = vscode.Uri.joinPath(target, 'index.html');
      try { await vscode.workspace.fs.stat(idx); await this.show(idx); } catch { vscode.window.showWarningMessage('HTML Preview: that folder has no index.html.'); }
      return;
    }
    if (HTML_RE.test(target.path) && !newTab) { await this.show(target); return; }
    if (HTML_RE.test(target.path) && newTab) { await this.show(target); return; }
    // Other local files (PDF, images, text) open in VS Code.
    await vscode.commands.executeCommand('vscode.open', target, { viewColumn: vscode.ViewColumn.Active, preview: true });
  }

  syncScroll(editor) {
    if (!this.uri || !this.prefs().sync) return;
    const ed = editor || vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this.uri.toString());
    if (!ed || !ed.visibleRanges.length) return;
    const top = ed.visibleRanges[0].start.line, span = ed.visibleRanges[0].end.line - top;
    const f = top / Math.max(1, ed.document.lineCount - span);
    this.post({ type: 'scrollTo', f: Math.max(0, Math.min(1, f)) });
  }

  onDocChange(doc) {
    if (!this.uri) return;
    const k = doc.uri.toString();
    if (k === this.uri.toString() || this.deps.has(k)) { this.cache.delete(k); this.schedule(settings().delay); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); clearInterval(this.watch);
    this.subs.forEach(s => s.dispose());
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    if (this.ext.preview === this) this.ext.preview = null;
  }
}

class Ext {
  constructor(context) { this.context = context; this.preview = null; }
  panel(column) {
    return vscode.window.createWebviewPanel(VIEW_TYPE, 'HTML Preview', { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false, enableFindWidget: false, enableCommandUris: commandUris(SECTION), localResourceRoots: [] });
  }
  async open(uri, column) {
    if (this.preview) { this.preview.panel.reveal(column === vscode.ViewColumn.Active ? undefined : this.preview.panel.viewColumn, true); await this.preview.show(uri); return this.preview; }
    this.preview = new Preview(this, this.panel(column));
    await this.preview.show(uri);
    return this.preview;
  }
  /** Replace a frozen panel by a new one in the same place, with the same file and history. */
  replacePanel(old) {
    const col = old.panel.viewColumn || vscode.ViewColumn.Beside;
    const keep = { uri: old.uri, history: old.history, at: old.at, scriptsOff: old.scriptsOff, notice: old.notice, forceLarge: old.forceLarge, counted: old.counted };
    old.panel.dispose();
    const p = new Preview(this, this.panel(col));
    Object.assign(p, keep);
    if (p.uri) p.panel.title = 'Preview ' + path.posix.basename(p.uri.path);
    this.preview = p;
  }
  revive(panel, state) {
    if (this.preview) { panel.dispose(); return; }
    const p = new Preview(this, panel);
    this.preview = p;
    const u = state && typeof state.uri === 'string' ? state.uri : '';
    if (u) { p.uri = vscode.Uri.parse(u); p.history = [u]; p.at = 0; p.panel.title = 'Preview ' + path.posix.basename(p.uri.path); }
  }
  dispose() { if (this.preview) this.preview.panel.dispose(); }
}

/** The HTML file in the active tab. Files over 50 MB have a tab but no text editor in the extension host. */
function activeTabUri() {
  try {
    const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
    const u = tab && tab.input && tab.input.uri;
    if (u instanceof vscode.Uri && HTML_RE.test(u.path)) return u;
  } catch {}
  return null;
}

function targetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const tab = activeTabUri();
  if (tab) return tab;
  const ed = vscode.window.activeTextEditor;
  return ed ? ed.document.uri : null;
}

function activate(context) {
  const ext = new Ext(context);
  context.subscriptions.push({ dispose: () => ext.dispose() });
  log = vscode.window.createOutputChannel('HTML Preview', { log: true });
  context.subscriptions.push(log);
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'HTML Preview' });

  const openCmd = side => async arg => {
    const uri = targetUri(arg);
    if (!uri) { vscode.window.showInformationMessage('Open an .html file first.'); return; }
    return ext.open(uri, side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('htmlPreview.showPreviewToSide', openCmd(true)),
    vscode.commands.registerCommand('htmlPreview.showPreview', openCmd(false)),
    vscode.commands.registerCommand('htmlPreview.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#htmlPreview.start`, false)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { async deserializeWebviewPanel(panel, state) { ext.revive(panel, state); } }),
    vscode.workspace.onDidChangeTextDocument(e => { if (ext.preview && e.contentChanges.length) ext.preview.onDocChange(e.document); }),
    vscode.workspace.onDidSaveTextDocument(doc => { if (ext.preview) ext.preview.onDocChange(doc); }),
    vscode.window.onDidChangeActiveTextEditor(ed => {
      const p = ext.preview;
      if (!p || !ed || !isHtmlDoc(ed.document) || !settings().follow) return;
      if (ed.document.uri.scheme === 'output' || (p.uri && p.uri.toString() === ed.document.uri.toString())) return;
      p.show(ed.document.uri);
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      const p = ext.preview, u = activeTabUri();
      if (!p || !u || !settings().follow || !p.panel.visible || (p.uri && p.uri.toString() === u.toString())) return;
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === u.toString()) return; // handled above
      p.show(u);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(e => { const p = ext.preview; if (p && p.uri && e.textEditor.document.uri.toString() === p.uri.toString()) p.syncScroll(e.textEditor); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { if (ext.preview) ext.preview.schedule(0); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(SECTION) || !ext.preview) return;
      if (e.affectsConfiguration(SECTION + '.pageBackground') || e.affectsConfiguration(SECTION + '.scrollSync')) {
        const s = settings(), cur = cleanPrefs(context.workspaceState.get(PREFS_KEY), s);
        if (e.affectsConfiguration(SECTION + '.pageBackground')) cur.bg = s.bg;
        if (e.affectsConfiguration(SECTION + '.scrollSync')) cur.sync = s.sync;
        context.workspaceState.update(PREFS_KEY, cur);
      }
      ext.preview.load();
    }),
  );
  return { _ext: ext };
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { cleanPrefs, isHtmlDoc, targetUri } };
