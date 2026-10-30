'use strict';
// WoW Addon Webhooks for Discord (SPEC): a tray app that finds addons' plugins, watches their saved data in one or more
// games and posts it to Discord channels. Setup and status live in one small window.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, safeStorage, Notification } = require('electron');
const { createSettings, fromCompanion, key } = require('./settings');
const { createPoster, postIn } = require('./poster');
const flows = require('./flows');
const { createWebhook, parseUrl } = require('./discord');
const plugins = require('./plugins');
const outbox = require('./outbox');
const wow = require('./wow');
const { loadPicture, decodeTga, encodePng } = require('./pictures');
const screenshots = require('./screenshots');
const { registerScheme, renderCard } = require('./render');
const { createGameArt } = require('./game-art');
const { gamePicture } = require('./game-picture');
const check = require('./check');
const install = require('./install');
const { createScripts } = require('./scripts');
const { runScript } = require('./run-script');
const { startUpdates } = require('./updater');

const TEXTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'enUS.json'), 'utf8'));
// The icon (tools/make-icon.js): on Windows the .ico, drawn anew for each size, so the tray's 16 pixels stay sharp.
const ICON_PNG = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const ICON = process.platform === 'win32' ? path.join(__dirname, '..', '..', 'assets', 'icon.ico') : ICON_PNG;
const GAME_CHECK = 15000;      // how often the app looks whether a watched game is running, while its window is open
const PLUGIN_CHECK = 60000;    // how often it looks for new or changed plugins
const STEP_CHECK = 60000;      // how often it looks whether a step (Digest, Quiet hours) or the weekly summary is due
const SHOT_WIDTH = 1920;       // the game's screenshots go to Discord at most this wide, as JPEG
const SHOT_QUALITY = 85;
// Development, never in the installed app:
// - AWD_USER_DATA=<folder> keeps settings apart from the real ones (snapshots of a made-up setup);
// - AWD_DISCORD=http://127.0.0.1:<port> sends every webhook call to a fake Discord on this computer (only a local
//   address is taken);
// - AWD_CLOCK_OFFSET=<seconds> moves the app's clock, to try Digest, Quiet hours and the weekly summary;
// - AWD_PICK_ZIP=<file> is what Install a code plugin… picks (the warning is still shown);
// - AWD_UPDATE_FEED=http://127.0.0.1:<port> looks for updates in a fake feed on this computer (a latest.yml there).
const DEV = !app.isPackaged ? process.env : {};
const FAKE_DISCORD = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(DEV.AWD_DISCORD || '') ? DEV.AWD_DISCORD : null;
const CLOCK_OFFSET = Number(DEV.AWD_CLOCK_OFFSET) || 0;
const UPDATE_FEED = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(DEV.AWD_UPDATE_FEED || '') ? DEV.AWD_UPDATE_FEED : null;
const now = () => Math.floor(Date.now() / 1000) + CLOCK_OFFSET;

// The developer's check (src/main/check.js): a report instead of the app, beside a running one. (A CommonJS module
// may return from its top level: nothing below runs.)
const CHECK = check.args(process.argv);
if (CHECK) return check.run(CHECK);

if (DEV.AWD_USER_DATA) app.setPath('userData', DEV.AWD_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
// Windows takes the taskbar icon and the notices' name from the Start menu shortcut with the same id: the installer's
// carries build.appId (package.json; the packed app's package.json has no build section, so it is written here too, and
// a test checks the two match). A development run keeps an id of its own, so it never takes the installed app's.
const APP_ID = 'com.addonwebhooks.discord';
app.setAppUserModelId(app.isPackaged ? APP_ID : 'WoW Addon Webhooks for Discord');
registerScheme();

let settings, poster, tray, win, lastStatus = null, debounce = null, gameRunning = false, noticed = null, gameArt = null;
let updates = null, scripts = null;
let update = null; // a newer version: { version, state: 'found' | 'downloading' | 'failed', percent }
let askedUpdate = null; // the version the player was asked about in a box, once per run
let pluginsDir = null, stateDir = null; // code plugins the player installed, and what their scripts kept
let pendingInstall = null; // a code plugin's .zip read and checked, waiting for Install
const watched = new Set();

// The first start after the Journey Together Companion (SPEC §9): its game folder and choices, if it was set up.
function fromCompanionSettings() {
  const file = path.join(app.getPath('appData'), 'Journey Together Companion for Discord', 'settings.json');
  let old;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return; }
  const values = fromCompanion(old);
  if (values) settings.set(values);
}

// ---------- Plugins and their data ----------

// The game versions whose AddOns folders are searched: the watched ones, or all of them before any is chosen.
function addonsFolders() {
  const folder = settings.get('wowFolder');
  if (!folder) return [];
  const chosen = [...new Set(settings.get('sources').map((s) => s.flavor))];
  return (chosen.length ? chosen : wow.flavors(folder)).map((f) => wow.addonsFolder(folder, f));
}
// Every plugin found or installed: [{ id, addon, plugin } | { id: null, addon, problem }] (a code plugin's with its
// folder). A code plugin with the id of one found in an addon is not used: settings and lines go by id.
function found() {
  const data = plugins.findDataPlugins(addonsFolders());
  const ids = new Set(data.map((f) => f.id).filter(Boolean));
  const code = plugins.findCodePlugins(pluginsDir).map((f) => (f.id && ids.has(f.id) ? { id: null, addon: f.addon, folder: f.folder, problem: 'same-id' } : f));
  return [...data, ...code];
}
const used = () => found().filter((f) => f.plugin && settings.used(f.id) === true).map((f) => f.plugin);
// A plugin's groups from the watched games: an addon's outbox, or what a code plugin's script made of its saved data
// (run by runCode first).
function read(plugin) {
  const folder = settings.get('wowFolder');
  if (!folder || !settings.get('sources').length) return { error: 'missing' };
  return outbox.readSources(folder, settings.get('sources'), plugin, plugin.source === 'code' ? (_file, p, s) => scripts.result(p, s) : undefined);
}
// The scripts of the code plugins in use, on the saved data that changed since they last ran (src/main/scripts.js).
function runCode() {
  const folder = settings.get('wowFolder');
  const list = folder ? used().filter((p) => p.source === 'code') : [];
  return scripts.refresh(list, settings.get('sources'), (s, p) => wow.svPath(folder, s.flavor, s.account, p.savedVariables));
}
// A run of the poster, after the code plugins' scripts.
async function sync(reason) {
  await runCode();
  return poster.sync(reason);
}

// The saved data files of the plugins in use, in the watched games.
function svPaths() {
  const folder = settings.get('wowFolder');
  if (!folder) return [];
  const names = [...new Set(used().map((p) => p.savedVariables))];
  return settings.get('sources').flatMap((s) => names.map((n) => wow.svPath(folder, s.flavor, s.account, n)));
}

// Game art (src/main/game-art.js) from the game a group was saved in, or the first watched game when that is not
// known: (fileId) → PNG | null, for a template.
function gamePng(flavor) {
  const folder = settings.get('wowFolder');
  const game = flavor || (settings.get('sources')[0] || {}).flavor;
  return folder && game ? (id) => gameArt.png(folder, game, id) : null;
}
// A news item's picture: a plugin's file, or game art cut to its crop and shaped to its aspect, as Discord takes it (a
// JPEG at most 1920 pixels wide).
function picture(plugin, p) {
  if (typeof p === 'string') return loadPicture(plugin, p);
  return p ? gamePicture(gamePng(p.flavor), p) : null;
}

// The game's screenshot a news item names (src/main/screenshots.js), from the Screenshots folder of the game its group
// was saved in (or of each watched game), as Discord takes it: a JPEG at most 1920 pixels wide. A 4K screenshot is
// several megabytes, a TGA tens. Null when it is not there.
function screenshot(shot) {
  const folder = settings.get('wowFolder');
  if (!folder || !shot) return null;
  const flavors = shot.flavor ? [shot.flavor] : [...new Set(settings.get('sources').map((s) => s.flavor))];
  for (const flavor of flavors) {
    const file = screenshots.find(screenshots.folder(folder, flavor), shot.time);
    if (!file) continue;
    const ext = path.extname(file).toLowerCase();
    let img = ext === '.tga' ? nativeImage.createFromBuffer(encodePng(decodeTga(fs.readFileSync(file), 8192))) : nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    if (img.getSize().width > SHOT_WIDTH) img = img.resize({ width: SHOT_WIDTH, quality: 'best' });
    return { name: path.basename(file, path.extname(file)) + '.jpg', data: img.toJPEG(SHOT_QUALITY), type: 'image/jpeg' };
  }
  return null;
}

const hooks = new Map(); // channel id → { url, hook }
function webhook(channelId) {
  const url = settings.channelUrl(channelId);
  if (!url || !parseUrl(url)) return null;
  const known = hooks.get(channelId);
  if (known && known.url === url) return known.hook;
  const hook = createWebhook({ url, base: FAKE_DISCORD || undefined });
  hooks.set(channelId, { url, hook });
  return hook;
}

function syncSoon(ms) {
  clearTimeout(debounce);
  debounce = setTimeout(() => sync('file'), ms);
}

// Watch the saved data files: WoW rewrites them on logout, /reload and closing the game. Polling the file's time is
// the dependable way (the game replaces the file, which folder watchers often miss); a short wait lets it finish.
function watch() {
  const want = new Set(svPaths());
  for (const f of watched) if (!want.has(f)) { fs.unwatchFile(f); watched.delete(f); }
  for (const f of want) {
    if (watched.has(f)) continue;
    watched.add(f);
    fs.watchFile(f, { interval: 3000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) syncSoon(2000); });
  }
}

// Watch the games themselves while the window is open: it says when one runs, and when it closes the files are read
// once more. Not from the tray: each look starts PowerShell, and posting needs only the files' times (watch).
function watchGame() {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  const folder = settings.get('wowFolder');
  const flavors = [...new Set(settings.get('sources').map((s) => s.flavor))];
  if (!folder || !flavors.length) return;
  wow.runningGames((paths) => {
    const running = flavors.some((f) => wow.isGameOf(paths, folder, f));
    if (running === gameRunning) return;
    gameRunning = running;
    if (!running) syncSoon(5000);
    sendStatus();
  });
}

// A changed plugin (an addon updated): watch its files again.
let pluginStamp = '';
function checkPlugins() {
  const stamp = JSON.stringify(found().map((f) => [f.id, f.addon, f.plugin && f.plugin.version, f.problem]));
  if (stamp === pluginStamp) return;
  pluginStamp = stamp;
  migrateFlows();
  watch();
  sendStatus();
}

// The choices from before become lines (SPEC §5.1): W3–W4 step boxes at once, W1–W2 ticks once every plugin they named
// is found again (so a role becomes the mention of the kinds that allow one).
function migrateFlows() {
  if ((settings.get('flows') || 0) >= 2) return;
  const list = found().filter((f) => f.plugin);
  const named = new Set(settings.channels().flatMap((c) => Object.keys(c.follow || {})));
  if ([...named].some((pid) => !list.some((f) => f.id === pid))) return;
  settings.migrate((pid, kid) => {
    const f = list.find((x) => x.id === pid);
    return f ? flows.pluginKinds(f.plugin).find((k) => k.id === kid) || null : null;
  }, TEXTS.threadBox);
}

// The kind of a kind box, when its plugin is in use.
function kindOfBox(box, inUse) {
  const b = flows.parseBox(box);
  const p = b && b.type === 'kind' ? inUse.find((x) => x.id === b.pid) : null;
  return p ? flows.pluginKinds(p).find((k) => k.id === b.kind) || null : null;
}

// ---------- Status, window, tray ----------

function sendStatus() {
  if (tray) tray.setToolTip(TEXTS.trayTip + (lastStatus && lastStatus.problem ? ' · ' + TEXTS['problem.' + lastStatus.problem] : ''));
  if (win && !win.isDestroyed()) win.webContents.send('status', { ...(lastStatus || {}), gameRunning, update });
}

function showStatus(st) {
  lastStatus = { ...st, at: now() };
  if (st.problem && st.problem !== noticed && settings.get('notices') && Notification.isSupported()) {
    const where = [st.plugin, st.channel, st.group].filter(Boolean).join(' · ');
    const n = new Notification({ title: TEXTS.appName, icon: ICON_PNG, body: (where ? where + ': ' : '') + (TEXTS['problem.' + st.problem] || '') });
    n.on('click', openWindow);
    n.show();
  }
  noticed = st.problem || null;
  sendStatus();
}

function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); watchGame(); return; }
  // Development: AWD_SNAPSHOT=<file.png> saves the window as a picture and quits; AWD_SNAPSHOT_VIEW opens a given step
  // or tab ("step=3", "tab=flows"); AWD_SNAPSHOT_WIDTH and _HEIGHT size it. Drawn offscreen, so it works while the screen
  // is locked.
  const snapshot = process.env.AWD_SNAPSHOT && !app.isPackaged;
  win = new BrowserWindow({
    width: 800, height: 920, minWidth: 620, minHeight: 600, title: TEXTS.appName, backgroundColor: '#120D09',
    icon: fs.existsSync(ICON) ? ICON : undefined, autoHideMenuBar: true,
    show: !snapshot,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: !!snapshot },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const view = snapshot && process.env.AWD_SNAPSHOT_VIEW ? Object.fromEntries(new URLSearchParams(process.env.AWD_SNAPSHOT_VIEW)) : {};
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: view });
  if (snapshot) {
    win.setContentSize(Number(process.env.AWD_SNAPSHOT_WIDTH) || 800, Number(process.env.AWD_SNAPSHOT_HEIGHT) || 920);
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(process.env.AWD_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
      app.isQuitting = true; app.quit();
    }, Number(process.env.AWD_SNAPSHOT_DELAY) || 1500));
  }
  // Closing the window keeps the app in the tray.
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('restore', () => watchGame());
  watchGame();
}

function trayMenu() {
  const paused = settings.get('paused');
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(update && update.state !== 'downloading' ? [{ label: fill(TEXTS['update.tray'], { version: update.version }), click: downloadUpdate }, { type: 'separator' }] : []),
    { label: TEXTS.trayOpen, click: openWindow },
    { label: paused ? TEXTS.resume : TEXTS.pause, click: () => { poster.setPaused(!paused); trayMenu(); sendStatus(); } },
    { type: 'separator' },
    { label: TEXTS.trayQuit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------- Updates (SPEC §10): asked first, downloaded only on the player's word ----------

const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ''));

function updateFound(version) {
  if (!version || (update && update.version === version && update.state !== 'failed')) return;
  update = { version, state: 'found', percent: 0 };
  trayMenu(); sendStatus();
  if (win && !win.isDestroyed() && win.isVisible()) askUpdate();
  else if (Notification.isSupported()) {
    // In the tray: a Windows notice; clicking it opens the window and asks there.
    const n = new Notification({ title: TEXTS.appName, icon: ICON_PNG, body: fill(TEXTS['update.notice'], { version }) });
    n.on('click', () => { openWindow(); askUpdate(); });
    n.show();
  }
}

// The box: "Version x is out. Download and update?" Once per version and run; the window's banner stays after Later.
async function askUpdate() {
  if (!update || update.state !== 'found' || askedUpdate === update.version || !win || win.isDestroyed()) return;
  askedUpdate = update.version;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', title: TEXTS.appName, noLink: true, defaultId: 0, cancelId: 1,
    message: fill(TEXTS['update.askMessage'], { version: update.version }),
    detail: fill(TEXTS['update.askDetail'], { current: app.getVersion() }),
    buttons: [TEXTS['update.download'], TEXTS['update.later']],
  });
  if (response === 0) downloadUpdate();
}

function downloadUpdate() {
  if (!updates || !update || update.state === 'downloading') return;
  update = { ...update, state: 'downloading', percent: 0 };
  trayMenu(); sendStatus();
  updates.download(); // installs and starts the app again when it has it
}

function updateProgress(percent) {
  if (!update || update.state !== 'downloading' || percent < update.percent + 5) return;
  update = { ...update, percent };
  sendStatus();
}

function updateFailed() {
  if (!update) return;
  update = { ...update, state: 'failed' };
  trayMenu(); sendStatus();
}

function setStartWithWindows(on) {
  settings.set({ startWithWindows: !!on });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
}

// ---------- What the window asks ----------

function str(v, max = 2048) { return typeof v === 'string' && v.length <= max ? v : null; }

// The plugin switched on is the only one used for its addon: others reading the same saved data are switched off.
function useOnly(list, plugin) {
  for (const x of list) if (x.plugin && x.id !== plugin.id && x.plugin.savedVariables === plugin.savedVariables && settings.used(x.id)) settings.usePlugin(x.id, false);
}

// Every game and account in the WoW folder, ticked when watched. With nothing watched yet, the ones where a plugin
// finds saved data are ticked (and saved).
function games(list) {
  const folder = settings.get('wowFolder');
  if (!folder) return [];
  const all = wow.games(folder);
  if (!settings.get('sources').length && all.length) {
    const names = list.filter((f) => f.plugin).map((f) => f.plugin.savedVariables);
    settings.setSources(all.filter((g) => wow.hasSaved(folder, g.flavor, g.account, names)));
    watch();
  }
  const on = settings.get('sources');
  return all.map((g) => ({ ...g, watched: on.some((s) => s.flavor === g.flavor && s.account === g.account) }));
}

// The plugins as the window shows them, each with its groups (from every watched game).
function pluginsView(list) {
  const multi = settings.get('sources').length > 1;
  return list.map((f) => {
    if (!f.plugin) return { id: null, addon: f.addon, problem: f.problem, folder: f.folder || null };
    const p = f.plugin;
    const r = read(p);
    const script = p.source === 'code' ? scripts.problem(p.id) : null;
    const groups = r.error ? [] : Object.values(r.groups).map((g) => ({
      id: g.id, name: g.name, sub: g.sub, saved: g.saved, by: g.by, color: g.color, kept: Object.keys(g.kept),
      game: multi ? `${wow.flavorName(r.from[g.id].flavor)} · ${r.from[g.id].account}` : null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { id: p.id, addon: f.addon, name: p.name, author: p.author, version: p.version, group: p.group,
      code: p.source === 'code', folder: f.folder || null, script,
      // The other plugins for the same addon: only one of them is used at a time (SPEC §3).
      same: list.filter((x) => x.plugin && x.id !== p.id && x.plugin.savedVariables === p.savedVariables).map((x) => x.plugin.name),
      kinds: flows.pluginKinds(p), templates: Object.keys(p.templates), used: settings.used(p.id), groups,
      // saved: the outbox was read, so no groups means the addon has nothing to post (its own empty text says why).
      saved: !r.error, empty: p.empty || null,
      readProblem: r.error && r.error !== 'missing' && !(r.error === 'script' && script) ? r.error : null };
  });
}

// The places a line may end at: each channel and its threads.
const placesNow = () => settings.channels().flatMap((c) => [flows.channelBox(c.id), ...c.threads.map((t) => flows.threadBox(c.id, t.id))]);
// What flows.check needs to know about the boxes.
function lineCtx(inUse) {
  const places = new Set(placesNow());
  return { lines: settings.lines(), kindOf: (b) => kindOfBox(b, inUse), hasPlace: (box) => places.has(box) };
}

// The flows as the window shows them (SPEC §5.1): each line with what is wrong with it, the kinds no line starts
// from, which kinds of each group reach a channel, and what each line's settings show.
function flowsView(list) {
  const inUse = list.filter((f) => f.plugin && settings.used(f.id) === true).map((f) => f.plugin);
  const byId = new Map(inUse.map((p) => [p.id, p]));
  const reads = new Map();
  const groupsOf = (pid) => {
    const p = byId.get(pid);
    if (!p) return null;
    if (!reads.has(pid)) reads.set(pid, read(p));
    const r = reads.get(pid);
    return r.error ? [] : Object.keys(r.groups);
  };
  const lines = settings.lines();
  const places = new Set(placesNow());
  const kindOf = (b) => kindOfBox(b, inUse);
  const routes = flows.routes(lines.filter((l) => places.has(l.to)), groupsOf, kindOf);
  const rows = lines.filter((l) => places.has(l.to) && byId.has(flows.parseBox(l.from).pid)).sort((a, b) => a.n - b.n).map((l) => {
    const mine = routes.filter((r) => r.line.n === l.n);
    const live = mine.filter((r) => !r.missing);
    return { from: l.from, to: l.to, already: live.length > 0 && live.every((r) => r.shadowed), missing: mine.some((r) => r.missing) };
  });
  const reach = {};
  for (const r of routes.filter((x) => !x.missing && !x.shadowed)) {
    const k = key(r.pid, r.gid);
    reach[k] = [...new Set([...(reach[k] || []), r.kind])];
  }
  const starts = lines.map((l) => flows.parseBox(l.from)).filter((b) => b && b.type === 'kind');
  const notPosted = inUse.flatMap((p) => flows.pluginKinds(p).filter((k) => !starts.some((b) => b.pid === p.id && b.kind === k.id))
    .map((k) => ({ pid: p.id, kind: k.id })));
  return { rows, reach, notPosted, info: linesInfo(lines, byId, groupsOf, (pid) => reads.get(pid)),
    anyRoute: routes.some((r) => !r.missing && !r.shadowed) };
}

// What each line's settings show (SPEC §5.2), keyed "from>to": the fields its kind may be tested on, with the values
// seen so far for text and names; What Discord shows: the newest saved item that its Only when lets through (sample:
// { text, group }); and how many of the newest 12 it lets through (passed of seen).
const SAMPLE_OF = 12;
function linesInfo(lines, byId, groupsOf, readOf) {
  const out = {};
  for (const l of lines) {
    const b = flows.parseBox(l.from);
    const p = b && byId.get(b.pid);
    const k = p && flows.pluginKinds(p).find((x) => x.id === b.kind);
    if (!k) continue;
    const r = readOf(p.id);
    const gids = (groupsOf(p.id) || []).filter((g) => b.gid === flows.EVERY || g === b.gid);
    const items = r && !r.error && !k.weekly ? gids.flatMap((g) => r.groups[g].news.filter((n) => n.kind === k.id).map((n) => ({ n, group: r.groups[g].name }))) : [];
    items.sort((x, y) => y.n.time - x.n.time);
    const fields = (k.fields || []).map((f) => ({ id: f.id, name: f.name, type: f.type, values: f.type === 'number' ? []
      : [...new Set(items.flatMap((x) => [].concat((x.n.fields || {})[f.id] || []).map(String)))].sort((x, y) => x.localeCompare(y)).slice(0, 50) }));
    const only = l.only && flows.takes('only', k) ? l.only : null;
    const pass = (x) => !only || flows.passes(only, x.n.fields);
    const hit = items.find(pass);
    const recent = items.slice(0, SAMPLE_OF);
    out[l.from + '>' + l.to] = { fields, sample: hit ? { text: hit.n.text, group: hit.group } : null, seen: recent.length, passed: recent.filter(pass).length };
  }
  return out;
}

function ipc() {
  ipcMain.handle('texts', () => TEXTS);
  ipcMain.handle('state', async () => {
    if (!settings.get('wowFolder')) { const f = wow.find(); if (f) settings.set({ wowFolder: f }); }
    await runCode();
    const list = found();
    // While setting up, a plugin found for the first time is used unless the player unticks it.
    if (!settings.get('setupDone')) for (const f of list) if (f.plugin && settings.used(f.id) === undefined) settings.usePlugin(f.id, true);
    const g = games(list);
    return { settings: settings.all(), status: lastStatus, gameRunning, update, version: app.getVersion(), wowFolder: settings.get('wowFolder'),
      games: g, plugins: pluginsView(list), flows: flowsView(list) };
  });
  ipcMain.handle('pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.get('wowFolder') || wow.find() || undefined });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const folder = res.filePaths[0];
    if (!wow.flavors(folder).length) return { ok: false, problem: 'folderNotWow' };
    settings.set({ wowFolder: folder });
    settings.setSources([]);
    watch();
    return { ok: true };
  });
  ipcMain.handle('setGame', (_e, flavor, account, on) => {
    const folder = settings.get('wowFolder');
    if (!folder || !wow.games(folder).some((g) => g.flavor === flavor && g.account === account)) return { ok: false };
    const rest = settings.get('sources').filter((s) => !(s.flavor === flavor && s.account === account));
    settings.setSources(on ? [...rest, { flavor, account }] : rest);
    gameRunning = false;
    watch();
    watchGame();
    return { ok: true };
  });
  ipcMain.handle('usePlugin', (_e, id, on) => {
    const list = found();
    const f = list.find((x) => x.id === id);
    if (!f) return { ok: false };
    settings.usePlugin(id, !!on);
    // A data plugin and a code plugin for the same addon: the one switched on is used (SPEC §3).
    if (on) useOnly(list, f.plugin);
    watch();
    return { ok: true };
  });
  // Install a code plugin… (SPEC §3): the player picks a .zip, it is read and checked, and the window shows the warning
  // naming it. Only Install puts it in place; it is used at once, instead of any other plugin for its addon.
  ipcMain.handle('lookCode', async () => {
    pendingInstall = null;
    let file = DEV.AWD_PICK_ZIP || null; // development: the file the picker would give, to try the warning by hand
    if (!file) {
      const pick = await dialog.showOpenDialog(win, { title: TEXTS.installTitle, properties: ['openFile'], filters: [{ name: TEXTS.installFilter, extensions: ['zip'] }] });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false };
      file = pick.filePaths[0];
    }
    const looked = install.look(file);
    if (!looked.plugin) return { ok: false, problem: looked.problem };
    const p = looked.plugin;
    const list = found();
    if (list.some((x) => x.id === p.id && !x.folder)) return { ok: false, problem: 'same-id' };
    const old = list.find((x) => x.folder === p.id && x.plugin);
    pendingInstall = looked;
    return { ok: true, name: p.name, author: p.author, addon: p.for, version: p.version,
      replaces: old ? old.plugin.version || '?' : null,
      instead: list.filter((x) => x.plugin && x.id !== p.id && x.plugin.savedVariables === p.savedVariables && settings.used(x.id)).map((x) => x.plugin.name) };
  });
  ipcMain.handle('installCode', () => {
    const looked = pendingInstall;
    pendingInstall = null;
    if (!looked) return { ok: false };
    const p = looked.plugin;
    try { install.install(pluginsDir, looked); } catch (e) { return { ok: false, problem: 'not-installed' }; }
    scripts.forget(p.id);
    settings.usePlugin(p.id, true);
    useOnly(found(), p);
    checkPlugins();
    if (settings.get('setupDone')) syncSoon(500);
    return { ok: true, name: p.name };
  });
  ipcMain.handle('cancelInstall', () => { pendingInstall = null; return { ok: true }; });
  // Remove (code plugins only): its folder and what its script kept. Its lines stay, and come back with it.
  ipcMain.handle('removeCode', (_e, folder) => {
    folder = str(folder, 64);
    if (!folder || !found().some((x) => x.folder === folder)) return { ok: false };
    const ok = install.remove(pluginsDir, stateDir, folder);
    scripts.forget(folder);
    checkPlugins();
    return { ok };
  });
  // A kept kind's picture as it would be posted, for the window.
  ipcMain.handle('preview', async (_e, pid, gid, kind) => {
    const p = used().find((x) => x.id === str(pid, 64));
    const r = p ? read(p) : { error: 'missing' };
    const g = !r.error && r.groups[str(gid, 200)];
    if (!g || !g.kept[kind] || !p.templates[kind]) return { ok: false };
    try {
      const pic = await renderCard(p, kind, g.kept[kind], g, now(), gamePng(((r.from || {})[g.id] || {}).flavor));
      return { ok: true, src: 'data:image/png;base64,' + pic.data.toString('base64'), text: g.kept[kind].text };
    } catch (e) { return { ok: false }; }
  });
  // Connect a channel: add it and send a test message. Discord refusing the test: the channel is not kept.
  ipcMain.handle('connect', async (_e, name, url) => {
    name = str(name, 200); url = str(url);
    if (!url || !parseUrl(url.trim())) return { ok: false, problem: 'webhookBad' };
    if (settings.channels().some((c) => settings.channelUrl(c.id) === url.trim())) return { ok: false, problem: 'webhookTwice' };
    const id = settings.addChannel(name, url.trim(), now());
    if (!id) return { ok: false, problem: 'webhookNoCrypto' };
    try { await postIn(settings, webhook(id), settings.channels().find((c) => c.id === id), { content: TEXTS.testText }, TEXTS.appName); } catch (e) {
      settings.removeChannel(id); hooks.delete(id);
      return { ok: false, problem: e.code === 'network' ? 'connectOffline' : 'connectRefused' };
    }
    return { ok: true, id, name: settings.channels().find((c) => c.id === id).name };
  });
  ipcMain.handle('renameChannel', (_e, id, name) => ({ ok: settings.rename(str(id, 64), str(name, 200)) }));
  ipcMain.handle('removeChannel', (_e, id) => { hooks.delete(id); return { ok: settings.removeChannel(str(id, 64)) }; });

  // Flows: lines are checked first (flows.check) and refused with a reason. A line drawn after setup posts what it
  // brings that is not in Discord yet (a kept message), so the player sees it arrive.
  ipcMain.handle('addLine', (_e, from, to) => {
    from = str(from, 300); to = str(to, 300);
    const no = flows.check(lineCtx(used()), from, to);
    if (no) return { ok: false, problem: no.problem };
    if (!settings.addLine(from, to, now())) return { ok: false, problem: 'bad' };
    if (settings.get('setupDone')) sync('file');
    return { ok: true };
  });
  ipcMain.handle('removeLine', (_e, from, to) => ({ ok: settings.removeLine(str(from, 300), str(to, 300)) }));
  ipcMain.handle('setLine', (_e, from, to, rules) => ({ ok: settings.setLine(str(from, 300), str(to, 300), rules, now()) }));
  ipcMain.handle('setChannel', (_e, id, values) => ({ ok: settings.setChannel(str(id, 64), values, now()) }));
  ipcMain.handle('addThread', (_e, id, link, name) => {
    id = str(id, 64); link = str(link, 300);
    const c = settings.channels().find((x) => x.id === id);
    const want = flows.cleanOptions('thread', { thread: link }).thread;
    if (!c || !want) return { ok: false, problem: 'threadBad' };
    if (c.threads.some((t) => t.id === want)) return { ok: false, problem: 'threadTwice' };
    const tid = settings.addThread(id, link, (str(name, 200) || '').trim() || TEXTS.threadBox);
    return tid ? { ok: true, box: flows.threadBox(id, tid) } : { ok: false, problem: 'threadMany' };
  });
  ipcMain.handle('renameThread', (_e, id, tid, name) => ({ ok: settings.renameThread(str(id, 64), str(tid, 64), str(name, 200)) }));
  ipcMain.handle('removeThread', (_e, id, tid) => ({ ok: settings.removeThread(str(id, 64), str(tid, 64)) }));
  ipcMain.handle('testChannel', async (_e, id) => {
    id = str(id, 64);
    const hook = webhook(id);
    const ch = settings.channels().find((c) => c.id === id);
    if (!hook || !ch) return { ok: false, problem: 'webhook-refused' };
    try { await postIn(settings, hook, ch, { content: TEXTS.testText }, TEXTS.appName); return { ok: true }; } catch (e) {
      return { ok: false, problem: e.code === 'network' ? 'offline' : 'webhook-refused' };
    }
  });
  // The end of the setup: kept messages posted, no backlog. Once posted, the window shows its tabs.
  ipcMain.handle('finishSetup', async () => {
    const res = await sync('setup');
    if (res.kept || !res.problem) settings.set({ setupDone: true });
    return res;
  });
  ipcMain.handle('postNow', () => sync('now'));
  ipcMain.handle('clearPinAsks', () => { settings.clearPinAsks(); return { ok: true }; });
  // Look again: plugins and saved data read anew.
  ipcMain.handle('reload', () => { scripts.retry(); checkPlugins(); return { ok: true }; });
  ipcMain.handle('setPaused', (_e, paused) => { poster.setPaused(!!paused); trayMenu(); return { ok: true }; });
  ipcMain.handle('setOption', (_e, k, on) => {
    if (k === 'notices') settings.set({ notices: !!on });
    else if (k === 'startWithWindows') setStartWithWindows(on);
    else return { ok: false };
    return { ok: true };
  });
  ipcMain.handle('downloadUpdate', () => { const ok = !!(update && update.state !== 'downloading'); downloadUpdate(); return { ok }; });
}

app.on('second-instance', openWindow);
app.on('window-all-closed', () => { /* stays in the tray */ });
// Quitting for real (Windows shutting down, an update): the window's close must not hide it to the tray then.
app.on('before-quit', () => { app.isQuitting = true; });

app.whenReady().then(() => {
  settings = createSettings(app.getPath('userData'), safeStorage);
  gameArt = createGameArt(path.join(app.getPath('userData'), 'game-art'));
  pluginsDir = path.join(app.getPath('userData'), 'plugins');
  stateDir = path.join(app.getPath('userData'), 'plugin-data');
  scripts = createScripts({ run: runScript, stateDir, now });
  if (settings.isNew && !process.env.AWD_USER_DATA) fromCompanionSettings();
  poster = createPoster({ settings, plugins: used, read, webhook, now, onStatus: showStatus,
    render: (p, kind, entry, group, flavor) => (p.templates[kind] ? renderCard(p, kind, entry, group, now(), gamePng(flavor)) : null),
    picture, screenshot });
  ipc();
  tray = new Tray(fs.existsSync(ICON) ? ICON : nativeImage.createEmpty());
  tray.setToolTip(TEXTS.trayTip);
  tray.on('click', openWindow);
  updates = startUpdates({ onFound: updateFound, onProgress: updateProgress, onFailed: updateFailed, feed: UPDATE_FEED });
  trayMenu();
  checkPlugins();
  setInterval(watchGame, GAME_CHECK);
  setInterval(checkPlugins, PLUGIN_CHECK);
  // Steps and the weekly summary keep their own times; a start catches up on what was due while the app was closed.
  setInterval(() => { if (settings.get('setupDone') && poster.isDue(now())) sync('timer'); }, STEP_CHECK);
  if (settings.get('setupDone')) setTimeout(() => sync('timer'), 3000);
  if (!settings.get('setupDone') || !process.argv.includes('--hidden')) openWindow();
});
