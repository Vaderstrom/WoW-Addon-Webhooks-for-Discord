'use strict';
// Running a code plugin's script (SPEC §6, docs/PLUGINS.md §7): untrusted code. It runs in a hidden, sandboxed window
// (no Node.js) in a session of its own, on an empty page whose only way to load anything is plugin://<plugin id>/,
// which serves that plugin's own scripts. It gets the addon's saved data as plain data (never a file path), what it
// returned last time and { now }; its answer comes back as JSON text for the app to check. A request for anything
// else (the internet, this computer's files) is refused and stops the script, and so does taking longer than 5
// seconds. One script at a time.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const { filePath, safeRel } = require('./plugins');

const SCHEME = 'plugin';
const TIME = 5000;  // what a script may take (SPEC §6)
const LOAD = 15000; // opening its empty page
const MAX_JSON = 32 * 1024 * 1024;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const PAGE = '/run:'; // the empty page a script runs in: no file of a plugin has a ":" in its name
// The page's own rules, behind the session's: no frames, workers or embedded objects.
const CSP = "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
// A script that reaches for Node.js finds nothing there, and says so.
const NODE = /\b(require|process|module|Buffer|__dirname|__filename|global)\b is not defined/;

let current = null; // the script running: { plugin, stop(problem, detail), stopped }
let ses = null, win = null, ready = null;

function answer(req) {
  let url, rel;
  try { url = new URL(req.url); rel = safeRel(decodeURIComponent(url.pathname.slice(1))); } catch (e) { return new Response('', { status: 404 }); }
  if (!current || url.host !== current.plugin.id) return new Response('', { status: 404 });
  if (url.pathname === PAGE) {
    return new Response('<!doctype html><meta charset="utf-8"><title></title>', { headers: { 'content-type': 'text/html', 'content-security-policy': CSP } });
  }
  const ext = rel ? path.extname(rel).toLowerCase() : '';
  const file = rel && TYPES[ext] ? filePath(current.plugin, rel) : null;
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

function hostOf(u) {
  try { const x = new URL(u); return x.host || x.protocol; } catch (e) { return ''; }
}

function sessionFor() {
  if (ses) return ses;
  ses = session.fromPartition('plugin-script');
  ses.protocol.handle(SCHEME, serve);
  ses.webRequest.onBeforeRequest((d, cb) => {
    const u = d.url;
    if (u.startsWith(SCHEME + '://') || u.startsWith('data:') || u.startsWith('blob:')) return cb({ cancel: false });
    cb({ cancel: true });
    if (current) current.stop(/^(https?|wss?|ftp):/i.test(u) ? 'network' : 'files', hostOf(u));
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // Behind the refusals, no way out that skips them (WebRTC, a preconnect): every connection goes to a proxy that
  // is not there.
  ready = ses.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9' }).catch(() => {});
  return ses;
}

function windowFor() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: 200, height: 200,
    webPreferences: { session: sessionFor(), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true,
      javascript: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  win.webContents.setFrameRate(1);
  return win;
}

// After a script was stopped: the window goes, and its page's process with it (a script in a loop keeps it busy).
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

const after = (ms, value) => new Promise((res) => setTimeout(() => res(value), ms));

// input: { saved, last, ctx }. → { json } | { problem: 'slow' | 'network' | 'files' | 'node' | 'error' | 'bad', detail }.
async function runNow(plugin, input) {
  sessionFor();
  await ready;
  const run = { plugin, stopped: null };
  const stopped = new Promise((resolve) => {
    run.stop = (problem, detail) => { if (!run.stopped) run.stopped = { problem, detail: detail || null }; resolve(run.stopped); };
  });
  current = run;
  const w = windowFor();
  try {
    const opened = await Promise.race([w.loadURL(`${SCHEME}://${plugin.id}${PAGE}`).then(() => null, () => ({ problem: 'error', detail: 'its page did not open' })),
      stopped, after(LOAD, { problem: 'slow', detail: null })]);
    if (opened) { await dropWindow(); return opened; }
    const script = `${SCHEME}://${plugin.id}/` + plugin.script.split('/').map(encodeURIComponent).join('/');
    const code = `(async () => {
      try {
        const input = JSON.parse(${JSON.stringify(JSON.stringify(input))});
        const m = await import(${JSON.stringify(script)});
        if (typeof m.default !== 'function') return { error: 'the script has no default export' };
        const out = await m.default(input.saved, input.last, input.ctx);
        return { out: JSON.stringify(out === undefined ? null : out) };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    })()`;
    let res = await Promise.race([w.webContents.executeJavaScript(code).catch((e) => ({ error: String(e && e.message) })), stopped,
      after(TIME, { problem: 'slow', detail: null })]);
    // A request made just before it returned is refused all the same, and still stops it.
    if (!res.problem) { await after(50); if (run.stopped) res = run.stopped; }
    if (res.problem) { await dropWindow(); return res; }
    if (res.error != null) {
      const detail = String(res.error).slice(0, 200);
      return { problem: NODE.test(detail) ? 'node' : 'error', detail };
    }
    if (typeof res.out !== 'string' || res.out.length > MAX_JSON) return { problem: 'bad', detail: 'not JSON' };
    return { json: res.out };
  } finally {
    current = null;
  }
}

let queue = Promise.resolve();
function runScript(plugin, input) {
  const run = queue.then(() => runNow(plugin, input));
  queue = run.catch(() => {});
  return run;
}

module.exports = { runScript, TIME };
