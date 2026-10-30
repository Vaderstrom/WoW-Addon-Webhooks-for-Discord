'use strict';
// Outboxes (docs/PLUGINS.md §3): what an addon wrote for the app, read from its account-wide SavedVariables file.
// Only the table the plugin names is read, and only the fields of the contract; anything else is dropped.
const fs = require('fs');
const { parse } = require('./lua-table');
const wow = require('./wow');

const FORMAT = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_NEWS = 100;
const MAX_NUMBERS = 100;
const MAX_NAMES = 40;
const MAX_VALUE = 100;

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : isMap(v) ? Object.values(v) : []);
function at(globals, keys) {
  let v = globals;
  for (const k of keys) { if (!isMap(v)) return undefined; v = v[k]; }
  return v;
}

// A news item's values for Only if (docs/PLUGINS.md §2): only the fields its kind names, each of its type. Null when
// none is there.
function cleanFields(v, defs) {
  if (!isMap(v) || !defs) return null;
  const out = {};
  for (const f of defs) {
    const x = v[f.id];
    if (f.type === 'number' && typeof x === 'number' && Number.isFinite(x)) out[f.id] = x;
    else if (f.type === 'text' && typeof x === 'string' && x.trim()) out[f.id] = x.trim().slice(0, MAX_VALUE);
    else if (f.type === 'names') {
      const names = list(x).filter((s) => typeof s === 'string' && s.trim()).slice(0, MAX_NAMES).map((s) => s.trim().slice(0, MAX_VALUE));
      if (names.length) out[f.id] = names;
    }
  }
  return Object.keys(out).length ? out : null;
}

// A news item's picture (docs/PLUGINS.md §3): a path, or one from the game's data, { game = file id, crop = { left,
// right, top, bottom } (parts of the file, 0 to 1), aspect = the width / height that part is shown at }. Null when
// it is neither.
function cleanPicture(p) {
  if (typeof p === 'string') return p;
  if (!isMap(p) || !Number.isInteger(p.game) || p.game <= 0 || p.game > 0x7fffffff) return null;
  const out = { game: p.game, crop: null, aspect: null };
  const c = list(p.crop);
  if (c.length === 4 && c.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && c[0] < c[1] && c[2] < c[3]) out.crop = c;
  if (typeof p.aspect === 'number' && p.aspect >= 0.1 && p.aspect <= 10) out.aspect = p.aspect;
  return out;
}

// One group as the app uses it, or null when it lacks what every post needs (a name and a save time).
function cleanGroup(id, g, plugin) {
  if (!isMap(g) || typeof g.name !== 'string' || !g.name.trim() || typeof g.saved !== 'number') return null;
  const kept = {};
  for (const k of plugin.kinds.filter((x) => x.type === 'kept')) {
    const e = isMap(g.kept) ? g.kept[k.id] : null;
    if (isMap(e) && typeof e.text === 'string') kept[k.id] = { text: e.text, data: e.data === undefined ? null : e.data };
  }
  const newsKinds = new Map(plugin.kinds.filter((x) => x.type === 'news').map((x) => [x.id, x]));
  const news = list(g.news).filter((n) => isMap(n) && typeof n.id === 'string' && n.id.length <= 200 && newsKinds.has(n.kind)
      && typeof n.time === 'number' && typeof n.text === 'string')
    .slice(0, MAX_NEWS)
    .map((n) => ({ id: n.id, kind: n.kind, time: n.time, text: n.text,
      name: typeof n.name === 'string' ? n.name : null, picture: cleanPicture(n.picture),
      screenshot: typeof n.screenshot === 'number' && Number.isFinite(n.screenshot) && n.screenshot > 0 ? Math.floor(n.screenshot) : null,
      fields: cleanFields(n.fields, newsKinds.get(n.kind).fields) }));
  const numbers = {};
  if (isMap(g.numbers)) {
    for (const [k, v] of Object.entries(g.numbers).slice(0, MAX_NUMBERS)) if (typeof v === 'number' && Number.isFinite(v)) numbers[k] = v;
  }
  return {
    id, name: g.name.trim().slice(0, 80), sub: typeof g.sub === 'string' ? g.sub.slice(0, 200) : null, saved: g.saved,
    by: typeof g.by === 'string' ? g.by : null, color: /^[0-9A-Fa-f]{6}$/.test(g.color || '') ? g.color : null,
    kept, news, numbers,
  };
}

// { groups: { id: group } } from the file's text, or { error: 'unreadable' | 'too-new' | 'bad' }. No outbox at all
// (the addon has not written one yet): no groups.
function readText(text, plugin) {
  let globals;
  try { globals = parse(text); } catch (e) { return { error: 'unreadable', detail: e.message }; }
  return readBox(at(globals, plugin.outbox), plugin);
}

// An outbox as the app uses it, from an addon's saved data or what a code plugin's script returned (null: nothing).
function readBox(box, plugin) {
  if (box == null) return { groups: {} };
  if (!isMap(box) || typeof box.format !== 'number') return { error: 'bad' };
  if (box.format > FORMAT) return { error: 'too-new' };
  const groups = {};
  if (isMap(box.groups)) {
    for (const [id, g] of Object.entries(box.groups)) {
      const clean = cleanGroup(id, g, plugin);
      if (clean) groups[id] = clean;
    }
  }
  return { groups };
}

function readFile(file, plugin) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return { error: 'missing' }; }
  if (stat.size > MAX_BYTES) return { error: 'too-big' };
  return { ...readText(fs.readFileSync(file, 'latin1'), plugin), mtime: stat.mtimeMs };
}

// A plugin's groups from every watched game: sources = [{ flavor, account }]. A group saved in two of them takes the
// newer save. { groups, from: { id: source } } or { error } — an error only when no file could be read. readOne: how
// one game's outbox is had (a code plugin's comes from its script, src/main/scripts.js).
function readSources(wowFolder, sources, plugin, readOne = readFile) {
  const groups = {}, from = {};
  let read = 0, error = null;
  for (const s of sources || []) {
    const r = readOne(wow.svPath(wowFolder, s.flavor, s.account, plugin.savedVariables), plugin, s);
    if (r.error === 'missing') continue;
    if (r.error) { error = error === 'too-new' ? error : r.error; continue; }
    read++;
    for (const [id, g] of Object.entries(r.groups)) {
      if (!groups[id] || g.saved > groups[id].saved) { groups[id] = g; from[id] = s; }
    }
  }
  if (!read) return { error: error || 'missing' };
  return { groups, from };
}

module.exports = { FORMAT, MAX_BYTES, readText, readBox, readFile, readSources, cleanGroup };
