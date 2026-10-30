'use strict';
// Pictures from plugin templates (SPEC §7, docs/PLUGINS.md §6). A template is untrusted: it is opened in a hidden,
// sandboxed window (no Node.js) whose only way to load anything is plugin://<plugin id>/<path>, which serves that
// plugin's own files (and "Media/..." from its addon's folder, TGA as PNG) and, by ctx.game(id), a picture from the
// game's own data (src/main/game-art.js). Every other request is refused: no network, no other files, no navigation.
// One picture at a time; a template that hangs is stopped.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session, protocol } = require('electron');
const { filePath, safeRel } = require('./plugins');
const { loadPicture } = require('./pictures');

const SCHEME = 'plugin';
const MAX_W = 1600, MAX_H = 2400;
const TIMEOUT = 15000;
const MAX_GAME = 40; // pictures from the game per picture
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.tga': 'image/png' };

// Before the app is ready: plugin:// behaves like a normal web origin (relative links, fetch), one per plugin.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

let current = null; // the plugin being drawn: the only one whose files are served
let art = null;     // and the game art it may ask for: { png(fileId) → PNG | null, asked: Set }
let ses = null, win = null, ready = null;

function answer(req) {
  const url = new URL(req.url);
  if (!current || url.host !== current.id) return new Response('', { status: 404 });
  // plugin://<id>/game:<file id>: no file of a plugin has a ":" in its name.
  const game = /^\/game:([1-9][0-9]{0,9})$/.exec(url.pathname);
  if (game) {
    const id = Number(game[1]);
    if (!art || (!art.asked.has(id) && art.asked.size >= MAX_GAME)) return new Response('', { status: 404 });
    art.asked.add(id);
    const data = art.png(id);
    return data ? new Response(data, { headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 });
  }
  const rel = safeRel(decodeURIComponent(url.pathname.slice(1)));
  const ext = rel ? path.extname(rel).toLowerCase() : '';
  if (!rel || !TYPES[ext]) return new Response('', { status: 404 });
  if (ext === '.tga') {
    const pic = loadPicture(current, rel);
    return pic ? new Response(pic.data, { headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 });
  }
  const file = filePath(current, rel);
  if (!file) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[ext] } });
}

// Never kept by the browser: a plugin installed again (or its addon updated) is read anew. (A newer code plugin ran its
// old script until a restart; 30 Oct 2026.)
function serve(req) {
  const res = answer(req);
  res.headers.set('cache-control', 'no-store');
  return res;
}

function sessionFor() {
  if (ses) return ses;
  ses = session.fromPartition('plugin-render');
  ses.protocol.handle(SCHEME, serve);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(SCHEME + '://') || d.url.startsWith('data:')) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // Behind the refusals, no way out that skips them (WebRTC, a preconnect): every connection goes to a proxy that
  // is not there.
  ready = ses.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9' }).catch(() => {});
  return ses;
}

function windowFor() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: 1100, height: 1400, useContentSize: true, transparent: true, backgroundColor: '#00000000',
    webPreferences: { session: sessionFor(), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true,
      javascript: true, webSecurity: true, spellcheck: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  win.webContents.setFrameRate(30);
  return win;
}
// After a failure: the window goes, and its page's process with it (a template stuck in a loop keeps it busy).
function dropWindow() {
  const w = win;
  win = null;
  if (!w || w.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); if (!w.isDestroyed()) w.destroy(); resolve(); };
    const t = setTimeout(done, 3000);
    w.webContents.once('render-process-gone', done);
    try { w.webContents.forcefullyCrashRenderer(); } catch (e) { done(); }
  });
}

// The next frames the window paints, after a forced repaint: the second one, or the first if no second comes soon.
// (capturePage right after a change returned the frame before it; 28 Oct 2026, in the Journey Together Companion.)
// No frame at all: ask again, three times 5 seconds. (A just-installed app's very first frame came after more than
// 5 seconds, and its first board had no picture; 30 Oct 2026.)
function nextFrame(w) {
  const wc = w.webContents;
  return new Promise((resolve) => {
    let last = null, count = 0, settle = null, asks = 0, giveUp = null;
    const done = () => { clearTimeout(settle); clearTimeout(giveUp); wc.off('paint', onPaint); resolve(last); };
    const onPaint = (_e, _dirty, image) => {
      last = image; count++;
      clearTimeout(settle);
      if (count >= 2) done(); else settle = setTimeout(done, 400);
    };
    const ask = () => {
      if (last || asks++ >= 3 || wc.isDestroyed()) return done();
      giveUp = setTimeout(ask, 5000);
      wc.invalidate();
    };
    wc.on('paint', onPaint);
    ask();
  });
}

// The picture once its painting has settled: two frames in a row the same, at most five tries. (Big pictures can
// paint late: the first Journey Together board after a cold start came out without its art; 29 Oct 2026.)
async function settledFrame(w) {
  let last = await nextFrame(w);
  for (let i = 0; i < 4 && last && !last.isEmpty(); i++) {
    await new Promise((res) => setTimeout(res, 150));
    const next = await nextFrame(w);
    if (!next || next.isEmpty()) break;
    if (next.toBitmap().equals(last.toBitmap())) return next;
    last = next;
  }
  return last;
}

// The files a template may ask for by ctx.asset(path): the plugin's folder and its addon's Media folder.
function files(plugin) {
  const out = [];
  const walk = (dir, prefix, limit) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of items) {
      if (out.length >= limit) return;
      if (d.isDirectory()) walk(path.join(dir, d.name), prefix + d.name + '/', limit);
      else if (TYPES[path.extname(d.name).toLowerCase()]) out.push(prefix + d.name);
    }
  };
  walk(plugin.dir, '', 2000);
  if (plugin.addonDir) walk(path.join(plugin.addonDir, 'Media'), 'Media/', 8000);
  return out;
}

function withTimeout(p, ms) {
  let timer;
  p.catch(() => { /* answered by the timeout already */ });
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error('template: too slow')), ms); })])
    .finally(() => clearTimeout(timer));
}

// gamePng(fileId) → PNG | null: the game art of the game the entry was saved in (none: no game art).
async function draw(plugin, kindId, entry, group, now, gamePng) {
  const tpl = plugin.templates[kindId];
  if (!tpl) return null;
  current = plugin;
  art = gamePng ? { png: gamePng, asked: new Set() } : null;
  const w = windowFor();
  await ready;
  try {
    w.setContentSize(tpl.width, 1400);
    await withTimeout(w.loadURL(`${SCHEME}://${plugin.id}/${tpl.file.split('/').map(encodeURIComponent).join('/')}`), TIMEOUT);
    const ctx = { now, group: { id: group.id, name: group.name, color: group.color } };
    const rect = await withTimeout(w.webContents.executeJavaScript(`(async () => {
      const files = new Set(${JSON.stringify(files(plugin))});
      const ctx = Object.assign(${JSON.stringify(ctx)}, {
        asset: (p) => { p = String(p == null ? '' : p).replace(/\\\\/g, '/');
          return files.has(p) ? '${SCHEME}://${plugin.id}/' + p.split('/').map(encodeURIComponent).join('/') : null; },
        game: async (id) => {
          id = Number(id);
          if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return null;
          const url = '${SCHEME}://${plugin.id}/game:' + id;
          try { return (await fetch(url)).ok ? url : null; } catch (e) { return null; }
        },
      });
      const card = window.webhookCard;
      if (!card || typeof card.render !== 'function') throw new Error('the template has no webhookCard.render');
      const el = await card.render(${JSON.stringify(entry.data)}, ctx);
      if (!(el instanceof Element)) throw new Error('webhookCard.render gave no element');
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`), TIMEOUT);
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const r = { x: Math.max(0, Math.floor(n(rect.x))), y: Math.max(0, Math.floor(n(rect.y))) };
    r.width = Math.min(MAX_W, Math.ceil(n(rect.width)));
    r.height = Math.min(MAX_H, Math.ceil(n(rect.height)));
    if (r.width < 1 || r.height < 1) throw new Error('template: empty picture');
    const [cw, ch] = w.getContentSize();
    if (r.x + r.width > cw || r.y + r.height > ch) w.setContentSize(Math.max(cw, r.x + r.width), Math.max(ch, r.y + r.height));
    const frame = await settledFrame(w);
    if (!frame || frame.isEmpty()) throw new Error('template: no frame painted');
    // The frame is in device pixels; the rectangle in page pixels.
    const scale = frame.getSize().width / w.getContentSize()[0];
    const s = (v) => Math.round(v * scale);
    return { name: kindId + '.png', data: frame.crop({ x: s(r.x), y: s(r.y), width: s(r.width), height: s(r.height) }).toPNG(), type: 'image/png' };
  } catch (e) {
    // A template that hung or failed: start the next picture in a fresh window.
    await dropWindow();
    throw e;
  } finally {
    current = null;
    art = null;
  }
}

// One picture at a time: two at once would share the one window.
let queue = Promise.resolve();
function renderCard(plugin, kindId, entry, group, now, gamePng) {
  const run = queue.then(() => draw(plugin, kindId, entry, group, now, gamePng));
  queue = run.catch(() => {});
  return run;
}

module.exports = { registerScheme, renderCard };
