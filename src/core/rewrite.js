'use strict';
// Turns one HTML page into a self-contained document for a sandboxed srcdoc frame. There is no web server and no
// network: every local file the page uses (stylesheets, @import, scripts, images, srcset, CSS url(), fonts, video,
// audio, local iframes) is read through the host's read() and put in as a data: URL. Remote URLs are counted and,
// unless the user allowed them for this file, replaced by inert values so the browser never asks for them.
// Pure module: no vscode import, so the unit tests run it under plain Node.

const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', svgz: 'image/svg+xml', ico: 'image/x-icon', cur: 'image/x-icon', bmp: 'image/bmp', apng: 'image/apng',
  tif: 'image/tiff', tiff: 'image/tiff',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', map: 'application/json',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', txt: 'text/plain', xml: 'application/xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  vtt: 'text/vtt', pdf: 'application/pdf',
};

function mimeOf(url) {
  const m = /\.([a-z0-9]+)$/i.exec(String(url).replace(/[?#].*$/, ''));
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', Tab: '\t', NewLine: '\n' };
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : all;
  });
}
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** What kind of reference this is: 'skip' (data:, #frag, mailto: ...), 'remote' (http, https, //) or 'local'. */
function classify(ref) {
  const r = String(ref || '').trim();
  if (!r || r[0] === '#') return 'skip';
  if (/^(https?:)?\/\//i.test(r)) return 'remote';
  if (/^file:/i.test(r)) return 'local';
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return 'skip';
  return 'local';
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function utf8(bytes) {
  let t = new TextDecoder('utf-8').decode(bytes);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}
const dataUrl = (mime, text) => `data:${mime};base64,` + (typeof Buffer !== 'undefined' ? Buffer.from(text, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(text))));
const INERT_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** Parse the attributes of a start tag. s = text between the tag name and '>'. */
function parseAttrs(s) {
  const out = [];
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    out.push({ name: m[1].toLowerCase(), raw: m[0], value: v === undefined ? null : decodeEntities(v) });
  }
  return out;
}

/** Find the end of a start tag (the '>' not inside quotes), from index i (just after the tag name). */
function tagEnd(text, i) {
  let q = 0;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (q) { if (c === q) q = 0; }
    else if (c === 34 || c === 39) {
      // a quote only opens a value right after '=' (ignoring spaces)
      let j = i - 1; while (j >= 0 && /\s/.test(text[j])) j--;
      if (text[j] === '=') q = c;
    } else if (c === 62) return i;
  }
  return -1;
}

const DEFAULTS = { maxResourceBytes: 25 * 1048576, maxTotalBytes: 120 * 1048576, maxDepth: 8, maxFrameDepth: 2 };

/**
 * ctx: {
 *   docUrl      URL string of the page (file:///..., vscode-remote://...)
 *   rootUrl     URL string of the site root for "/x" paths (workspace folder), ends with '/'
 *   read(url)   async -> Uint8Array; throws Error with .code 'ENOENT' | 'OUTSIDE' | 'TOOBIG' | other
 *   allowRemote boolean
 *   scripts     boolean (false: drop <script>, on* handlers, javascript: URLs)
 *   inject      string put at the start of <head> (bootstrap), or ''
 *   maxResourceBytes, maxTotalBytes
 * }
 * returns { html, deps: string[], remote: { count, urls, hosts }, notes: [{ level, text }], base }
 */
async function rewriteHtml(text, ctx, state) {
  const top = !state;
  const st = state || { deps: new Set(), remote: new Map(), notes: [], total: 0, memo: new Map(), noted: new Set(), opt: Object.assign({}, DEFAULTS, ctx) };
  const docUrl = ctx.docUrl;
  let base = docUrl;
  const parts = [];
  let injected = !top || !ctx.inject;
  const injectAt = () => { if (!injected) { injected = true; parts.push(ctx.inject); } };
  const scriptsOn = ctx.scripts !== false;
  let i = 0;
  const n = text.length;
  // Where the inject goes when the page has no <head>/<html>: after the doctype and leading comments.
  let lead = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { parts.push(text.slice(i)); break; }
    if (lt > i) parts.push(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      const end = e < 0 ? n : e + 3;
      parts.push(text.slice(i, end)); i = end; if (!lead) lead = parts.length; continue;
    }
    if (text[i + 1] === '!' || text[i + 1] === '?') {
      const e = text.indexOf('>', i);
      const end = e < 0 ? n : e + 1;
      parts.push(text.slice(i, end)); i = end; lead = parts.length; continue;
    }
    if (text[i + 1] === '/') {
      const e = text.indexOf('>', i);
      const end = e < 0 ? n : e + 1;
      const close = text.slice(i, end);
      if (!injected && /^<\/head/i.test(close)) injectAt();
      parts.push(close); i = end; continue;
    }
    const nm = /^<([a-zA-Z][^\s\/>]*)/.exec(text.slice(i, i + 64));
    if (!nm) { parts.push('<'); i++; continue; }
    const name = nm[1].toLowerCase();
    const te = tagEnd(text, i + nm[0].length);
    if (te < 0) { parts.push(text.slice(i)); break; }
    const inner = text.slice(i + nm[0].length, te);
    const selfClose = /\/\s*$/.test(inner);
    const attrs = parseAttrs(selfClose ? inner.replace(/\/\s*$/, '') : inner);
    i = te + 1;
    // Raw text body (script, style, textarea, title)
    let body = null, closeTag = '';
    if (RAW.has(name) && !selfClose) {
      const re = new RegExp('</' + name + '[\\s>/]', 'ig');
      re.lastIndex = i;
      const m = re.exec(text);
      const bEnd = m ? m.index : n;
      body = text.slice(i, bEnd);
      if (m) { const ce = text.indexOf('>', bEnd); closeTag = text.slice(bEnd, ce < 0 ? n : ce + 1); i = ce < 0 ? n : ce + 1; } else i = n;
    }
    if (!injected && name === 'head') { parts.push(rebuild(name, attrs, selfClose)); injectAt(); continue; }
    // No <head>: the inject goes before the first element other than <html>.
    if (!injected && name !== 'html') injectAt();
    parts.push(await element(name, attrs, selfClose, body, closeTag));
  }
  if (!injected) { parts.splice(lead, 0, ctx.inject); injected = true; }

  async function element(name, attrs, selfClose, body, closeTag) {
    const get = k => { const a = attrs.find(x => x.name === k); return a ? a.value : null; };
    const set = (k, v) => { const a = attrs.find(x => x.name === k); if (a) { a.value = v; a.changed = true; } else attrs.push({ name: k, value: v, changed: true }); };
    const del = k => { for (let j = attrs.length - 1; j >= 0; j--) if (attrs[j].name === k) attrs.splice(j, 1); };
    const tasks = [];
    // Under a remote <base>, a relative path is a web address too.
    const kindOf = r => { const k = classify(r); return k === 'local' && classify(base) === 'remote' && !/^\s*file:/i.test(r) ? 'remote' : k; };
    const urlAttr = (k, kind) => { const v = get(k); if (v != null && v.trim()) tasks.push(ref(v, kind, base).then(r => { if (r != null) set(k, r); })); };

    if (!scriptsOn) {
      for (let j = attrs.length - 1; j >= 0; j--) if (/^on/.test(attrs[j].name)) attrs.splice(j, 1);
      for (const a of attrs) if (a.value && /^\s*javascript:/i.test(a.value) && ['href', 'src', 'action', 'formaction', 'xlink:href', 'data'].includes(a.name)) { a.value = '#'; a.changed = true; }
    }
    // style="... url(x) ..."
    const style = get('style');
    if (style && /url\(|image-set\(/i.test(style)) tasks.push(css(style, base, 0, new Set(), true).then(s => set('style', s)));

    switch (name) {
      case 'base': {
        const h = get('href');
        if (h != null) {
          try { base = resolve(h.trim(), docUrl); } catch {}
          note('info', classify(h) === 'remote' ? `The page sets <base href="${h}">, so its relative links point to that web site.` : `The page sets <base href="${h}">; relative paths are read from there.`);
        }
        return '<!-- html-preview: <base> applied by the preview -->';
      }
      case 'meta': {
        const he = (get('http-equiv') || '').toLowerCase();
        if (he === 'refresh') { note('warn', `Removed <meta http-equiv="refresh" content="${(get('content') || '').slice(0, 120)}">: the preview does not redirect.`); return '<!-- html-preview: meta refresh removed -->'; }
        if (he === 'content-security-policy') { note('info', 'Removed the page\'s own Content-Security-Policy meta tag. The preview has a strict policy of its own.'); return '<!-- html-preview: page CSP removed -->'; }
        break;
      }
      case 'link': {
        const rel = (get('rel') || '').toLowerCase().split(/\s+/);
        const href = get('href');
        if (!href) break;
        if (rel.includes('stylesheet')) {
          const k = kindOf(href);
          if (k === 'local' || (k === 'remote' && st.opt.allowRemote)) {
            if (k === 'remote') { set('href', absRemote(href, base)); remember(href, base); break; }
            const u = safeResolve(href, base);
            if (!u) break;
            const t = await loadText(u, 'stylesheet');
            if (t == null) { del('href'); set('data-html-preview-missing', href); break; }
            const c = await css(t, u, 0, new Set([u]), false);
            set('href', dataUrl('text/css', c)); del('integrity'); del('crossorigin');
            break;
          }
          if (k === 'remote') { remember(href, base); return `<!-- html-preview: remote stylesheet not loaded: ${href.replace(/--/g, '- -')} -->`; }
          break;
        }
        if (rel.some(r => ['preconnect', 'dns-prefetch', 'prefetch', 'preload', 'modulepreload', 'prerender'].includes(r))) {
          if (kindOf(href) === 'remote' && !st.opt.allowRemote) return '<!-- html-preview: resource hint removed -->';
          if (kindOf(href) === 'local') return '<!-- html-preview: resource hint removed -->';
          break;
        }
        if (rel.some(r => /icon/.test(r))) { urlAttr('href', 'img'); break; }
        break;
      }
      case 'script': {
        if (!scriptsOn) return '<!-- html-preview: script off -->';
        const src = get('src');
        const isModule = (get('type') || '').toLowerCase() === 'module';
        if (src != null && src.trim()) {
          const k = kindOf(src);
          if (k === 'remote') {
            remember(src, base);
            if (st.opt.allowRemote) { set('src', absRemote(src, base)); break; }
            set('type', 'text/html-preview-blocked'); set('data-src', src); del('src');
            return rebuild(name, attrs, false) + '</script>';
          }
          if (k === 'local') {
            const u = safeResolve(src, base);
            const t = u ? await loadText(u, 'script') : null;
            if (t == null) { del('src'); set('data-html-preview-missing', src); return rebuild(name, attrs, false) + '</script>'; }
            const js = isModule ? await moduleJs(t, u, 0, new Set([u])) : t;
            set('src', dataUrl('text/javascript', js)); del('integrity'); del('crossorigin');
            return rebuild(name, attrs, false) + '</script>';
          }
          break;
        }
        if (isModule && body) { const b2 = await moduleJs(body, base, 0, new Set()); return rebuild(name, attrs, selfClose) + b2 + closeTag; }
        break;
      }
      case 'style': {
        if (body != null) { const c = await css(body, base, 0, new Set(), false); return rebuild(name, attrs, selfClose) + c.replace(/<\/style/gi, '<\\/style') + closeTag; }
        break;
      }
      case 'img': urlAttr('src', 'img'); srcset(); break;
      case 'source': {
        urlAttr('src', mediaKind(get('type'), get('src')));
        srcset(); break;
      }
      case 'video': urlAttr('src', 'media'); urlAttr('poster', 'img'); break;
      case 'audio': urlAttr('src', 'media'); break;
      case 'track': urlAttr('src', 'text'); break;
      case 'input': if ((get('type') || '').toLowerCase() === 'image') urlAttr('src', 'img'); break;
      case 'embed': urlAttr('src', 'img'); break;
      case 'object': urlAttr('data', 'img'); break;
      case 'image': case 'feimage': urlAttr('href', 'img'); urlAttr('xlink:href', 'img'); break;
      case 'body': case 'table': case 'td': case 'th': urlAttr('background', 'img'); break;
      case 'iframe': case 'frame': {
        if (!scriptsOn) set('sandbox', '');
        const src = get('src');
        if (src && kindOf(src) === 'local' && get('srcdoc') == null) {
          const u = safeResolve(src, base);
          const depth = (ctx.frameDepth || 0) + 1;
          if (u && depth <= st.opt.maxFrameDepth && /\.x?html?$/i.test(u)) {
            const t = await loadText(u, 'frame');
            if (t != null) {
              const sub = await rewriteHtml(t, Object.assign({}, ctx, { docUrl: u, inject: '', frameDepth: depth }), st);
              set('srcdoc', sub.html); del('src');
            }
          } else if (u) urlAttr('src', 'img');
        } else if (src && kindOf(src) === 'remote') {
          remember(src, base);
          if (!st.opt.allowRemote) { set('data-src', src); set('src', 'about:blank'); }
          else set('src', absRemote(src, base));
        }
        break;
      }
    }
    if (tasks.length) await Promise.all(tasks);
    let tag = rebuild(name, attrs, selfClose);
    if (body != null) tag += body + closeTag;
    return tag;

    function srcset() {
      for (const k of ['srcset', 'imagesrcset']) {
        const v = get(k);
        if (!v) continue;
        tasks.push(Promise.all(splitSrcset(v).map(async c => { const r = await ref(c.url, 'img', base); return (r != null ? r : c.url) + c.rest; })).then(list => set(k, list.join(', '))));
      }
    }
  }

  function rebuild(name, attrs, selfClose) {
    let s = '<' + name;
    for (const a of attrs) s += ' ' + (a.changed || a.raw === undefined ? (a.value == null ? a.name : `${a.name}="${escAttr(a.value)}"`) : a.raw);
    return s + (selfClose ? ' />' : '>');
  }

  function note(level, text) { if (st.noted.has(text) || st.notes.length >= 200) return; st.noted.add(text); st.notes.push({ level, text }); }

  function remember(r, from) {
    let u = r.trim();
    try { u = absRemote(u, from); } catch {}
    st.remote.set(u, (st.remote.get(u) || 0) + 1);
  }

  function absRemote(r, from) { const t = r.trim(); if (t.startsWith('//')) return 'https:' + t; try { return new URL(t, from).href; } catch { return t; } }

  function safeResolve(r, from) {
    try { return resolve(r, from); } catch { note('warn', `Could not read the path "${r.slice(0, 200)}".`); return null; }
  }

  function resolve(r, from) {
    const t = r.trim();
    let u;
    // "/css/a.css" means the site root, as a web server would read it: the workspace folder.
    if (t[0] === '/' && t[1] !== '/' && ctx.rootUrl && classify(from) !== 'remote') u = new URL('.' + t, ctx.rootUrl);
    else u = new URL(t, from);
    u.hash = ''; u.search = '';
    return u.href;
  }

  /** A local or remote reference in an attribute or CSS. Resolves to a data: URL, an inert value, or null (keep). */
  async function ref(r, kind, from) {
    const k = classify(r);
    if (k === 'skip') return null;
    if (k === 'remote') {
      remember(r, from);
      if (st.opt.allowRemote) return absRemote(r, from);
      return kind === 'img' ? INERT_IMG : 'data:,';
    }
    // a remote <base> makes relative paths remote too
    if (classify(from) === 'remote') {
      const abs = absRemote(r, from);
      remember(abs, from);
      return st.opt.allowRemote ? abs : kind === 'img' ? INERT_IMG : 'data:,';
    }
    const u = safeResolve(r, from);
    if (!u) return null;
    const key = kind + '|' + u;
    if (!st.memo.has(key)) st.memo.set(key, (async () => {
      const bytes = await load(u, kind);
      if (!bytes) return 'data:,'; // shows as a broken image with its alt text, as in a browser
      const mime = mimeOf(u);
      if (mime === 'text/css') return dataUrl('text/css', await css(utf8(bytes), u, 1, new Set([u]), false));
      return `data:${mime};base64,` + toBase64(bytes);
    })());
    return st.memo.get(key);
  }

  async function load(u, what) {
    st.deps.add(u);
    try {
      const b = await ctx.read(u);
      if (b.length > st.opt.maxResourceBytes) { note('warn', `Not shown: ${short(u)} is ${mb(b.length)} MB (limit ${mb(st.opt.maxResourceBytes)} MB per file, setting htmlPreview.maxResourceMB).`); return null; }
      if (st.total + b.length > st.opt.maxTotalBytes) { note('warn', `Not shown: ${short(u)}. The files of this page passed ${mb(st.opt.maxTotalBytes)} MB in all.`); return null; }
      st.total += b.length;
      return b;
    } catch (e) {
      const code = e && e.code;
      if (code === 'OUTSIDE') note('warn', `Not loaded: ${short(u)} is outside the workspace and the page's folder.`);
      else if (code === 'TOOBIG') note('warn', `Not shown: ${short(u)} is larger than the limit (setting htmlPreview.maxResourceMB).`);
      else note('warn', `Not found: ${short(u)}${what === 'stylesheet' || what === 'script' ? ' (' + what + ')' : ''}.`);
      return null;
    }
  }
  async function loadText(u, what) { const b = await load(u, what); return b ? utf8(b) : null; }

  /** Rewrite url() and @import in CSS. attr = true for a style="" attribute (no @import there). */
  async function css(text, from, depth, seen, attr) {
    const out = [];
    const hoist = [];
    const re = /\/\*[\s\S]*?\*\/|@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);?|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
    let last = 0, m;
    const jobs = [];
    while ((m = re.exec(text))) {
      out.push(text.slice(last, m.index)); last = re.lastIndex;
      if (m[0][0] === '/') { out.push(m[0]); continue; }
      if (m[0][0] === '@') {
        const target = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
        const media = (m[6] || '').trim();
        if (attr) { out.push(''); continue; }
        const k = classify(target);
        if (k === 'remote' || classify(from) === 'remote') {
          const abs = absRemote(target, from); remember(abs, from);
          if (st.opt.allowRemote) hoist.push(`@import url("${abs}")${media ? ' ' + media : ''};`);
          else out.push(`/* html-preview: remote @import not loaded: ${abs.replace(/\*\//g, '* /')} */`);
          continue;
        }
        if (k !== 'local') { out.push(m[0]); continue; }
        const u = safeResolve(target, from);
        if (!u || seen.has(u) || depth >= st.opt.maxDepth) { out.push(`/* html-preview: @import ${seen.has(u) ? 'loop' : 'skipped'}: ${target.replace(/\*\//g, '* /')} */`); continue; }
        const slot = out.length; out.push('');
        jobs.push((async () => {
          const t = await loadText(u, 'stylesheet');
          if (t == null) return;
          const inner = await css(t, u, depth + 1, new Set([...seen, u]), false);
          out[slot] = media && !/^\s*all\s*$/i.test(media) ? `@media ${media} {\n${inner}\n}` : inner;
        })());
        continue;
      }
      const target = m[7] ?? m[8] ?? m[9] ?? '';
      const slot = out.length; out.push(m[0]);
      jobs.push(ref(target, /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(target) ? 'font' : 'img', from).then(r => { if (r != null) out[slot] = `url("${r}")`; }));
    }
    out.push(text.slice(last));
    await Promise.all(jobs);
    let s = out.join('');
    if (depth > 0) s = s.replace(/@charset\s+["'][^"']*["']\s*;?/gi, '');
    return (hoist.length ? hoist.join('\n') + '\n' : '') + s;
  }

  /** Static relative imports in an ES module become data: URLs (depth-limited, loops left as they are). */
  async function moduleJs(text, from, depth, seen) {
    if (depth >= st.opt.maxDepth) return text;
    const re = /(\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;
    const out = []; let last = 0, m; const jobs = [];
    while ((m = re.exec(text))) {
      const spec = m[3];
      out.push(text.slice(last, m.index)); last = re.lastIndex;
      const slot = out.length; out.push(m[0]);
      if (!/^\.{0,2}\//.test(spec)) {
        if (classify(spec) === 'remote') { remember(spec, from); if (!st.opt.allowRemote) out[slot] = m[1] + m[2] + 'data:text/javascript,' + m[2]; }
        continue;
      }
      const u = safeResolve(spec, from);
      if (!u || seen.has(u)) continue;
      const head = m[1], q = m[2]; // m is reused by the next exec() before the job below finishes
      jobs.push((async () => {
        const t = await loadText(u, 'script');
        if (t == null) return;
        const js = await moduleJs(t, u, depth + 1, new Set([...seen, u]));
        out[slot] = head + q + dataUrl('text/javascript', js) + q;
      })());
    }
    out.push(text.slice(last));
    await Promise.all(jobs);
    return out.join('');
  }

  function mediaKind(type, src) {
    const t = (type || mimeOf(src || '')).toLowerCase();
    return /^(video|audio)\//.test(t) ? 'media' : 'img';
  }

  if (!top) return { html: parts.join('') };
  const remoteUrls = [...st.remote.keys()];
  const hosts = [...new Set(remoteUrls.map(u => { try { return new URL(u).host; } catch { return u.slice(0, 40); } }))];
  return {
    html: parts.join(''),
    deps: [...st.deps],
    remote: { count: [...st.remote.values()].reduce((a, b) => a + b, 0), unique: remoteUrls.length, urls: remoteUrls.slice(0, 200), hosts: hosts.slice(0, 50) },
    notes: st.notes,
    base,
    bytes: st.total,
  };
}

function splitSrcset(v) {
  const out = [];
  const re = /\s*([^\s,][^\s]*?)(?=[\s,]|$)([^,]*)(,|$)/g;
  let m;
  while ((m = re.exec(v)) && m[0]) {
    let url = m[1], rest = m[2];
    if (url.endsWith(',')) { url = url.slice(0, -1); }
    out.push({ url, rest: rest.replace(/\s+$/, '') ? ' ' + rest.trim() : '' });
    if (re.lastIndex >= v.length) break;
  }
  return out;
}

const mb = b => (b / 1048576).toFixed(1);
function short(u) {
  try { const x = new URL(u); const p = decodeURIComponent(x.pathname); return p.length > 120 ? '…' + p.slice(-118) : p; } catch { return String(u).slice(0, 120); }
}

/** Resolve a link the user clicked in the preview against the page base. Returns { kind, url } */
function resolveLink(href, base, rootUrl) {
  const h = String(href || '').replace(/[\t\n\r]/g, '').trim();
  if (!h) return { kind: 'none' };
  if (h[0] === '#') return { kind: 'fragment', url: h };
  if (/^javascript:/i.test(h)) return { kind: 'none' };
  if (/^(https?:)?\/\//i.test(h)) return { kind: 'external', url: h.startsWith('//') ? 'https:' + h : h };
  if (/^(mailto|tel|sms):/i.test(h)) return { kind: 'external', url: h };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^file:/i.test(h)) return { kind: 'blocked', url: h };
  let u;
  try {
    if (/^(https?:)?\/\//i.test(base)) { u = new URL(h, base); return { kind: 'external', url: u.href }; }
    u = h[0] === '/' && rootUrl ? new URL('.' + h, rootUrl) : new URL(h, base);
  } catch { return { kind: 'none' }; }
  const frag = u.hash; u.hash = ''; u.search = '';
  return { kind: 'local', url: u.href, fragment: frag };
}

module.exports = { rewriteHtml, resolveLink, classify, mimeOf, splitSrcset, parseAttrs, decodeEntities, INERT_IMG };
