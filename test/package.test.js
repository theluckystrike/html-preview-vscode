'use strict';
// Checks on package.json, the packaged files and the source tree (no network modules, no editor takeover).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { ext: read('src/extension.js'), support: read('src/support.js'), rate: read('src/rate.js') };

test('displayName has every word of "html preview" and "html viewer" and is at most 70 characters', () => {
  const words = pkg.displayName.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of ['html', 'preview', 'viewer']) assert.ok(words.includes(w), w);
  assert.ok(pkg.displayName.length <= 70, `${pkg.displayName.length} chars`);
});

test('description says Free, No sign-in and offline', () => {
  for (const s of ['Free', 'No sign-in', 'offline']) assert.ok(pkg.description.includes(s), s);
});

test('engines.vscode is ^1.90.0 and main points at an existing file', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), pkg.main);
});

test('no customEditors contribution: the .html editor is never taken over', () => {
  assert.equal(pkg.contributes.customEditors, undefined);
  assert.ok(!(pkg.activationEvents || []).some(e => /^onCustomEditor:/.test(e)));
});

test('no ctrl+shift+v / cmd+shift+v keybinding (Markdown preview owns it)', () => {
  for (const k of pkg.contributes.keybindings || []) {
    for (const key of [k.key, k.mac, k.win, k.linux].filter(Boolean)) {
      const norm = key.toLowerCase().replace(/\s+/g, ' ').split(' ').map(ch => ch.split('+').sort().join('+'));
      assert.ok(!norm.some(ch => ch === 'ctrl+shift+v' || ch === 'cmd+shift+v'), key);
    }
  }
});

test('every contributed command is registered in src/extension.js or src/support.js', () => {
  const cmds = pkg.contributes.commands.map(c => c.command);
  assert.ok(cmds.includes('htmlPreview.showPreviewToSide') && cmds.includes('htmlPreview.showPreview'));
  for (const id of cmds) {
    const [prefix, suffix] = id.split(/\.(?=[^.]+$)/);
    const direct = SRC.ext.includes(`'${id}'`) || SRC.support.includes(`'${id}'`);
    // support.js builds ids as `${prefix}.<name>`; extension.js passes the prefix as SECTION
    const built = SRC.support.includes(`\${prefix}.${suffix}\``) && SRC.ext.includes(`SECTION = '${prefix}'`) && /registerSupport\(\{[^}]*prefix: SECTION/.test(SRC.ext);
    assert.ok(direct || built, id);
  }
});

test('every menu and keybinding command is a contributed command', () => {
  const cmds = new Set(pkg.contributes.commands.map(c => c.command));
  for (const k of pkg.contributes.keybindings || []) assert.ok(cmds.has(k.command), k.command);
  for (const [where, list] of Object.entries(pkg.contributes.menus || {})) for (const m of list) assert.ok(cmds.has(m.command), `${where}: ${m.command}`);
});

test('every configuration property is read in src/extension.js, src/rate.js or src/support.js', () => {
  const props = Object.keys(pkg.contributes.configuration.properties);
  assert.ok(props.length >= 5);
  for (const p of props) {
    assert.ok(p.startsWith('htmlPreview.'), p);
    const name = p.slice('htmlPreview.'.length);
    const q = new RegExp(`['"\`]${name}['"\`]`);
    assert.ok(q.test(SRC.ext) || q.test(SRC.rate) || q.test(SRC.support), name);
  }
});

test('configuration defaults are safe: remote resources off by default', () => {
  const P = pkg.contributes.configuration.properties;
  assert.equal(P['htmlPreview.loadRemoteResources'].default, false);
  for (const [k, v] of Object.entries(P)) if (v.type === 'number') assert.ok(v.default >= v.minimum && v.default <= v.maximum, k);
});

test('walkthrough media files exist', () => {
  const wts = pkg.contributes.walkthroughs;
  assert.ok(wts.length >= 1);
  for (const w of wts) for (const s of w.steps) {
    const m = s.media || {};
    for (const f of [m.markdown, m.image, m.svg].filter(Boolean)) {
      const files = typeof f === 'string' ? [f] : Object.values(f);
      for (const x of files) assert.ok(fs.existsSync(path.join(ROOT, x)), x);
    }
  }
});

test('icon.png exists and is a 128x128 PNG', () => {
  const b = fs.readFileSync(path.join(ROOT, pkg.icon));
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(b.toString('latin1', 12, 16), 'IHDR');
  assert.equal(b.readUInt32BE(16), 128, 'width');
  assert.equal(b.readUInt32BE(20), 128, 'height');
});

test('.vscodeignore excludes samples/, test/ and scripts/', () => {
  const lines = read('.vscodeignore').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const d of ['samples', 'test', 'scripts']) assert.ok(lines.some(l => new RegExp(`^${d}(/|/\\*\\*)?$`).test(l)), d);
  for (const keep of ['src', 'media']) assert.ok(!lines.some(l => new RegExp(`^${keep}(/|/\\*\\*)?$`).test(l)), `${keep} must be packaged`);
});

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no network module in src/ (http, https, http2, net, tls, dgram, dns)', () => {
  const files = walk(path.join(ROOT, 'src'));
  assert.ok(files.length >= 5);
  const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"`](?:node:)?(https?|http2|net|tls|dgram|dns)(?:\/[^'"`]*)?['"`]/;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), re, path.relative(ROOT, f));
});

test('src/core/rewrite.js does not import vscode (it is pure)', () => {
  assert.doesNotMatch(read('src/core/rewrite.js'), /require\(\s*['"]vscode['"]\s*\)/);
});
