'use strict';
// The developer's check (docs/PLUGINS.md §8): reads one SavedVariables file and the plugin for it, and shows every
// group, kept message, news item and picture as the app would post them, in a report. It posts nothing, needs no
// Discord channel and never writes in the WoW folder: the report goes to a folder of its own and opens in a window.
//   "WoW Addon Webhooks for Discord.exe" --check "<SavedVariables file>" [--plugin "<plugin folder>"] [--out "<folder>"]
// (npm start -- --check … while developing.) Without --plugin, the plugin is the one in the addon of that name, in
// the same game version (Interface\AddOns\<file name>\Webhooks). A code plugin's script runs as in the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const plugins = require('./plugins');
const outbox = require('./outbox');
const wow = require('./wow');
const screenshots = require('./screenshots');
const { parse } = require('./lua-table');
const { loadPicture } = require('./pictures');
const { registerScheme, renderCard } = require('./render');
const { createGameArt } = require('./game-art');
const { gamePicture } = require('./game-picture');
const { runScript } = require('./run-script');

const TEXTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'enUS.json'), 'utf8'));
const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// { file, plugin, out } from the command line, or null when there is no --check.
function args(argv) {
  const i = argv.indexOf('--check');
  if (i < 0) return null;
  const val = (flag) => { const j = argv.indexOf(flag); return j >= 0 && argv[j + 1] && !argv[j + 1].startsWith('--') ? argv[j + 1] : null; };
  return { file: val('--check'), plugin: val('--plugin'), out: val('--out') };
}

// The game a SavedVariables file belongs to: <wow>\<flavor>\WTF\Account\<account>\SavedVariables\<name>.lua.
function gameOf(file) {
  const flavorDir = path.resolve(file, '..', '..', '..', '..', '..');
  const wowFolder = path.dirname(flavorDir), flavor = path.basename(flavorDir);
  return wow.flavors(wowFolder).includes(flavor) ? { wowFolder, flavor, flavorDir } : null;
}

// The plugin, as the app would find or install it: { plugin } | { problem, detail }.
function pluginFor(dir, svName, game) {
  const file = path.join(dir, plugins.MANIFEST);
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return { problem: 'bad', detail: fs.existsSync(file) ? 'not JSON' : 'no ' + file }; }
  const code = json && json.script != null;
  const res = plugins.checkManifest(json, dir, { code });
  if (!res.plugin) return res;
  if (code) return res;
  // A data plugin in an addon's folder, maybe a copy of it saving elsewhere (`copies`).
  const addon = path.basename(path.dirname(dir));
  return { plugin: { ...res.plugin, ...(res.plugin.copies[addon] || res.plugin.copies[svName] || {}), addonDir: path.dirname(dir) } };
}

async function report(opts) {
  const lines = [];
  const say = (s) => lines.push(s);
  const file = opts.file && path.resolve(opts.file);
  if (!file || !fs.existsSync(file)) return { lines: [fill(TEXTS['check.noFile'], { file: opts.file || '' })], html: null };
  const svName = path.basename(file, path.extname(file));
  const game = gameOf(file);
  const dir = path.resolve(opts.plugin || (game ? path.join(wow.addonsFolder(game.wowFolder, game.flavor), svName, 'Webhooks') : path.join(path.dirname(file), 'Webhooks')));
  const found = pluginFor(dir, svName, game);
  const parts = [`<h1>${esc(TEXTS['check.title'])}</h1>`, `<p class="hint">${esc(fill(TEXTS['check.what'], { file, dir }))}</p>`];
  if (!found.plugin) {
    const why = found.problem === 'too-new' ? TEXTS['plugin.too-new'] : fill(TEXTS['check.badPlugin'], { detail: found.detail || found.problem });
    say(why);
    parts.push(`<p class="problem">${esc(why)}</p>`);
    return { lines, html: page(parts) };
  }
  const p = found.plugin;
  say(`${p.name} ${p.version || ''} (${p.source === 'code' ? TEXTS.containsCode : TEXTS.dataPlugin})`);
  parts.push(`<h2>${esc(p.name)} <span class="hint">${esc([p.version, p.author && fill(TEXTS.pluginBy, { author: p.author }), p.source === 'code' ? TEXTS.containsCode : TEXTS.dataPlugin].filter(Boolean).join(' · '))}</span></h2>`);
  if (game) parts.push(`<p class="hint">${esc(fill(TEXTS['check.game'], { game: wow.flavorName(game.flavor) }))}</p>`);
  else parts.push(`<p class="hint">${esc(TEXTS['check.noGame'])}</p>`);

  // The outbox: the addon's, or what the code plugin's script makes of the saved data (run as in the app).
  let r;
  if (p.source === 'code') {
    let saved;
    try { saved = parse(fs.readFileSync(file, 'latin1')); } catch (e) { r = { error: 'unreadable', detail: e.message }; }
    if (saved) {
      const res = await runScript(p, { saved, last: null, ctx: { now: Math.floor(Date.now() / 1000) } });
      if (res.problem) r = { error: 'script', detail: fill(TEXTS['script.' + res.problem], { detail: res.detail || '?' }) };
      else { let box; try { box = JSON.parse(res.json); } catch (e) { box = undefined; } r = outbox.readBox(box, p); }
    }
  } else r = outbox.readFile(file, p);
  if (r.error) {
    const why = r.error === 'script' ? r.detail : (TEXTS['problem.' + r.error] || r.error) + (r.detail ? ' (' + r.detail + ')' : '');
    say(why);
    parts.push(`<p class="problem">${esc(why)}</p>`);
    return { lines, html: page(parts) };
  }
  const groups = Object.values(r.groups);
  if (!groups.length) { say(p.empty || TEXTS['check.noGroups']); parts.push(`<p>${esc(p.empty || TEXTS['check.noGroups'])}</p>`); }

  const art = game ? createGameArt(path.join(app.getPath('userData'), 'game-art')) : null;
  const png = game ? (id) => art.png(game.wowFolder, game.flavor, id) : null;
  let n = 0;
  const keep = (pic) => { const name = String(++n).padStart(3, '0') + '-' + pic.name.replace(/[^\w.-]/g, '_'); return { name, data: pic.data }; };
  const files = [];
  const img = (pic) => { if (!pic) return ''; const f = keep(pic); files.push(f); return `<img src="${esc(f.name)}" alt="">`; };
  for (const g of groups) {
    say(`· ${g.name}`);
    parts.push(`<section><h3>${esc(g.name)}</h3><p class="hint">${esc([g.sub, g.by && fill(TEXTS['check.by'], { by: g.by }), new Date(g.saved * 1000).toLocaleString()].filter(Boolean).join(' · '))}</p>`);
    for (const k of p.kinds) {
      if (k.type === 'kept') {
        const e = g.kept[k.id];
        if (!e) { parts.push(`<h4>${esc(k.name)}</h4><p class="hint">${esc(TEXTS['check.none'])}</p>`); continue; }
        let pic = null, why = null;
        if (p.templates[k.id]) {
          try { pic = await renderCard(p, k.id, e, g, Math.floor(Date.now() / 1000), png); } catch (err) { why = TEXTS['problem.render-failed'] + ' (' + err.message + ')'; }
        }
        say(`  ${k.name}: ${e.text.split('\n')[0]}${why ? ' — ' + why : ''}`);
        parts.push(`<h4>${esc(k.name)}</h4><div class="post"><pre>${esc(e.text)}</pre>${img(pic)}${why ? `<p class="problem">${esc(why)}</p>` : ''}</div>`);
      } else {
        const items = g.news.filter((x) => x.kind === k.id).sort((a, b) => b.time - a.time);
        parts.push(`<h4>${esc(k.name)} <span class="hint">${items.length}</span></h4>`);
        if (!items.length) parts.push(`<p class="hint">${esc(TEXTS['check.none'])}</p>`);
        for (const it of items) {
          const pic = typeof it.picture === 'string' ? loadPicture(p, it.picture) : it.picture ? gamePicture(png, it.picture) : null;
          const notes = [];
          if (it.picture && !pic) notes.push(fill(TEXTS['check.noPicture'], { picture: typeof it.picture === 'string' ? it.picture : 'game ' + it.picture.game }));
          if (it.screenshot) {
            const shot = game && screenshots.find(screenshots.folder(game.wowFolder, game.flavor), it.screenshot);
            notes.push(shot ? fill(TEXTS['check.shot'], { file: path.basename(shot) }) : TEXTS['check.noShot']);
          }
          if (it.fields) notes.push(Object.entries(it.fields).map(([f, v]) => f + ' = ' + [].concat(v).join(', ')).join(' · '));
          say(`  ${k.name}: ${it.text.split('\n')[0]}`);
          parts.push(`<div class="post"><p class="hint">${esc(it.id)} · ${esc(new Date(it.time * 1000).toLocaleString())}</p><pre>${esc(it.text)}</pre>${img(pic)}${notes.map((x) => `<p class="hint">${esc(x)}</p>`).join('')}</div>`);
        }
      }
    }
    if (p.weekly && Object.keys(g.numbers).length) {
      parts.push(`<h4>${esc(p.weekly.name)}</h4><p class="hint">${esc(Object.entries(g.numbers).map(([k, v]) => k + ' = ' + v).join(' · '))}</p>`);
    }
    parts.push('</section>');
  }
  return { lines, html: page(parts), files };
}

function page(parts) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(TEXTS['check.title'])}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<style>
  body { margin: 0; padding: 20px 28px; background: #1E1F24; color: #E6E7EA; font: 14px/1.5 'Segoe UI', Arial, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 17px; } h3 { font-size: 16px; margin: 18px 0 0; color: #45C2C7; }
  h4 { font-size: 14px; margin: 14px 0 6px; } section { border-top: 1px solid #3C3F48; margin-top: 14px; }
  .hint { color: #A3A6AE; font-size: 12.5px; font-weight: normal; margin: 2px 0; } .problem { color: #E5584F; }
  .post { background: #2A2C33; border: 1px solid #3C3F48; border-radius: 8px; padding: 10px 12px; margin: 6px 0 10px; }
  pre { white-space: pre-wrap; font: inherit; margin: 0 0 6px; } img { max-width: 100%; display: block; margin: 6px 0; border-radius: 4px; }
</style></head><body>${parts.join('\n')}</body></html>`;
}

async function run(opts) {
  // Its own folder: a check runs beside the app (two at once may not share one).
  app.setPath('userData', path.join(app.getPath('appData'), 'WoW Addon Webhooks for Discord', 'check'));
  registerScheme();
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  let res;
  try { res = await report(opts); } catch (e) { res = { lines: [String(e && e.stack || e)], html: null }; }
  const game = opts.file ? gameOf(path.resolve(opts.file)) : null;
  let out = path.resolve(opts.out || path.join(os.tmpdir(), 'WoW Addon Webhooks check'));
  if (game && (out + path.sep).toLowerCase().startsWith((game.wowFolder + path.sep).toLowerCase())) out = path.join(os.tmpdir(), 'WoW Addon Webhooks check');
  for (const l of res.lines) console.log(l);
  if (!res.html) { app.exit(1); return; }
  // Only its own files from an earlier report go: --out may name a folder with other things in it.
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^(\d{3}-.+\.(png|jpg)|report\.(html|txt))$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
  for (const f of res.files || []) fs.writeFileSync(path.join(out, f.name), f.data);
  fs.writeFileSync(path.join(out, 'report.txt'), res.lines.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'report.html'), res.html);
  console.log(fill(TEXTS['check.written'], { folder: out }));
  if (process.argv.includes('--quit')) { app.quit(); return; }
  const w = new BrowserWindow({ width: 1100, height: 900, title: TEXTS['check.title'], backgroundColor: '#1E1F24', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadFile(path.join(out, 'report.html'));
}

module.exports = { args, run, report, gameOf };
