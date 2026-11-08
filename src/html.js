'use strict';
// Builds the preview toolbar page and the bootstrap that goes into each previewed page.
//
// Content-Security-Policy: the previewed page is a srcdoc frame, and a srcdoc frame inherits the policy of the page
// that holds it. So this one policy is the network rule for both: nothing may load from any host, only data: and
// blob: URLs (which is how the extension hands over local CSS, JS, images and fonts). Scripts and styles are inline
// because the user's page needs inline scripts, and a nonce would switch 'unsafe-inline' off. This toolbar page puts
// no file text into its own DOM (textContent only), and the page frame is sandboxed without allow-same-origin, so it
// cannot reach this page or VS Code. With "Load for this file", https: is added for images, styles, fonts, scripts
// and media only; connect-src stays 'none'.
const fs = require('fs');
const path = require('path');
const { footerHtml, FOOTER_CSS } = require('./support');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIA = path.join(__dirname, '..', 'media');
let cache = null;
function assets() {
  if (!cache) cache = { js: fs.readFileSync(path.join(MEDIA, 'preview.js'), 'utf8'), css: fs.readFileSync(path.join(MEDIA, 'preview.css'), 'utf8'), inner: fs.readFileSync(path.join(MEDIA, 'inner.js'), 'utf8') };
  return cache;
}

function csp(remote) {
  const web = remote ? ' https: http:' : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' data: blob:${web}`,
    `style-src 'unsafe-inline' data: blob:${web}`,
    `img-src data: blob:${web}`,
    `font-src data: blob:${web}`,
    `media-src data: blob:${web}`,
    "connect-src 'none'",
    remote ? `frame-src${web}` : "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

const WIDTHS = [['fill', 'Fill'], ['320', '320 phone S'], ['375', '375 phone'], ['768', '768 tablet'], ['1024', '1024 laptop'], ['1440', '1440 desktop'], ['custom', 'Custom…']];
const ZOOMS = [['fit', 'Fit'], ['0.5', '50%'], ['0.67', '67%'], ['0.75', '75%'], ['0.9', '90%'], ['1', '100%'], ['1.1', '110%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%']];
const BGS = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
const opts = list => list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

/** o: { remote, showSupportLinks } */
function buildHtml(o) {
  const a = assets();
  const footer = footerHtml('htmlPreview', o.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp(!!o.remote))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${a.css}\n${footer ? FOOTER_CSS : ''}</style>
<title>HTML Preview</title>
</head>
<body>
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="HTML preview">
    <span class="grp" id="nav"><button id="back" title="Back" aria-label="Back" disabled>◀</button><button id="forward" title="Forward" aria-label="Forward" disabled>▶</button><button id="reload" title="Reload (F5)" aria-label="Reload">⟳</button></span>
    <span id="file"></span>
    <span class="grp"><label class="lbl" for="width">Width</label><select id="width" aria-label="Page width">${opts(WIDTHS)}</select>
    <input id="custom" class="hidden" type="number" min="200" max="4000" step="1" aria-label="Custom width in pixels"></span>
    <span class="grp"><label class="lbl" for="zoom">Zoom</label><select id="zoom" aria-label="Zoom">${opts(ZOOMS)}</select><span id="size" aria-live="polite"></span></span>
    <span class="grp"><label class="lbl" for="bg">Page</label><select id="bg" aria-label="Background for pages that set none">${opts(BGS)}</select></span>
    <span class="grp"><button id="sync" title="Scroll the preview with the editor">Sync scroll</button>
    <button id="js" title="Run the page's JavaScript (sandboxed)">JS on</button>
    <button id="browser" class="hidden" title="Open this file in your web browser">Open in browser</button>
    <button id="consoleBtn" title="Console messages and script errors">Console<span id="consoleBadge" class="badge hidden"></span></button></span>
  </div>
  <div id="remoteBar" class="bar hidden" role="status">
    <span class="msg" id="remoteMsg"></span>
    <button id="remoteLoad" class="primary" title="Load the web resources of this file until VS Code closes">Load for this file</button>
    <button id="remoteAlways" title="Turn on the setting htmlPreview.loadRemoteResources">Always load</button>
    <button id="remoteBlock" class="hidden">Block again</button>
    <button id="remoteDetails">Details</button>
  </div>
  <ul id="remoteList" class="hidden"></ul>
  <div id="noticeBar" class="bar hidden" role="status"><span class="msg" id="noticeMsg"></span><button id="noticeAction" class="hidden"></button></div>
  <div id="stage"><div id="wrap"></div><div id="message" class="hidden" role="alert"></div></div>
  <div id="console" class="hidden" aria-label="Console">
    <div class="head"><span class="title">Console</span><button id="clearLog">Clear</button></div>
    <div id="log" tabindex="0"></div>
  </div>
  ${footer}
</div>
<script>${a.js}</script>
</body>
</html>`;
}

/** The script that goes first into every previewed page. */
function bootstrapTag() {
  if (!oneLine) {
    // One line, so the line numbers in the page's error messages match the user's file.
    oneLine = assets().inner.replace(/\/\*(?!HP_)[\s\S]*?\*\//g, '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).join(' ');
  }
  return '<script data-html-preview="bootstrap">' + oneLine.replace(/<\/script/gi, '<\\/script') + '</script>';
}
let oneLine = '';

module.exports = { buildHtml, bootstrapTag, csp, esc, WIDTHS, ZOOMS };
