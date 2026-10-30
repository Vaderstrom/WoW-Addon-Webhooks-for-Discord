'use strict';
// Plugins (docs/PLUGINS.md): data plugins found in addons' Webhooks folders, code plugins the player installed in the
// app's own folder, and their manifests checked. A manifest is untrusted input: anything that does not match the
// contract is refused with a reason, never half used.
const fs = require('fs');
const path = require('path');

const CONTRACT = 1;
const MANIFEST = 'webhooks.json';
const MAX_MANIFEST = 256 * 1024;
const MAX_KINDS = 12;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// A SavedVariables file is named after its addon's folder, which may have a "-" ("YourAddon-Dev").
const SV_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const FOLDER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const MAX_COPIES = 4;
const OUTBOX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+){0,7}$/;
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const FIELD_TYPES = ['number', 'text', 'names'];
const MAX_FIELDS = 6;

class ManifestError extends Error {}
const fail = (why) => { throw new ManifestError(why); };

function text(v, max, name, optional) {
  if (v == null && optional) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(name);
  return v.trim();
}

// A file path inside the plugin's folder ("card.html", "art/x.jpg"), or "Media/..." in the addon's own folder.
// Returns it with forward slashes, or null when it could point anywhere else.
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return null;
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || /[:*?"<>|]/.test(x))) return null;
  return parts.join('/');
}

function kinds(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_KINDS) fail('kinds');
  const seen = new Set();
  return list.map((k, i) => {
    if (!k || typeof k !== 'object') fail('kinds');
    const id = text(k.id, 32, 'kinds[' + i + '].id');
    if (!KIND_ID.test(id) || id === 'weekly' || seen.has(id)) fail('kinds[' + i + '].id');
    seen.add(id);
    if (k.type !== 'kept' && k.type !== 'news') fail('kinds[' + i + '].type');
    return { id, type: k.type, name: text(k.name, 60, 'kinds[' + i + '].name'), help: text(k.help, 200, 'kinds[' + i + '].help', true),
      default: k.default === true, mention: k.mention === true };
  });
}

function templates(map, kindIds) {
  if (map == null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) fail('templates');
  const out = {};
  for (const [kind, t] of Object.entries(map)) {
    if (!kindIds.includes(kind)) fail('templates.' + kind);
    const file = safeRel(typeof t === 'string' ? t : t && t.file);
    if (!file || !/\.html?$/i.test(file) || file.startsWith('Media/')) fail('templates.' + kind);
    const width = typeof t === 'object' && t.width != null ? Number(t.width) : 1000;
    if (!Number.isInteger(width) || width < 200 || width > 1600) fail('templates.' + kind + '.width');
    out[kind] = { file, width };
  }
  return out;
}

// What the Only if step may filter on (docs/PLUGINS.md §2): per news kind, at most 6 fields. Each kind gets its list as
// kind.fields.
function fields(map, ks) {
  if (map == null) return;
  if (typeof map !== 'object' || Array.isArray(map)) fail('fields');
  for (const [kind, list] of Object.entries(map)) {
    const k = ks.find((x) => x.id === kind);
    if (!k || k.type !== 'news' || !Array.isArray(list) || !list.length || list.length > MAX_FIELDS) fail('fields.' + kind);
    const seen = new Set();
    k.fields = list.map((f, i) => {
      const at = 'fields.' + kind + '[' + i + ']';
      if (!f || typeof f !== 'object') fail(at);
      const id = text(f.id, 32, at + '.id');
      if (!FIELD_ID.test(id) || seen.has(id)) fail(at + '.id');
      seen.add(id);
      if (!FIELD_TYPES.includes(f.type)) fail(at + '.type');
      return { id, name: text(f.name, 40, at + '.name'), type: f.type };
    });
  }
}

// The weekly summary's words (docs/PLUGINS.md §5).
function weekly(w, kindIds) {
  if (w == null) return null;
  if (typeof w !== 'object' || Array.isArray(w)) fail('weekly');
  const news = Array.isArray(w.news) ? w.news : [];
  return {
    name: text(w.name, 60, 'weekly.name'), help: text(w.help, 200, 'weekly.help', true),
    head: text(w.head, 200, 'weekly.head'), number: text(w.number, 200, 'weekly.number', true),
    news: news.slice(0, MAX_KINDS).map((n, i) => {
      if (!n || !kindIds.includes(n.kind)) fail('weekly.news[' + i + ']');
      return { kind: n.kind, text: text(n.text, 200, 'weekly.news[' + i + '].text') };
    }),
    separator: typeof w.separator === 'string' && w.separator.length <= 10 ? w.separator : ' · ',
  };
}

// Other folders the addon may be installed as (a development copy), each saving elsewhere (docs/PLUGINS.md §2):
// { folder: { savedVariables, outbox: [keys] } }.
function copies(map) {
  if (map == null) return {};
  if (typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > MAX_COPIES) fail('copies');
  const out = {};
  for (const [folder, c] of Object.entries(map)) {
    const at = 'copies.' + folder;
    if (!FOLDER.test(folder) || !c || typeof c !== 'object') fail(at);
    const sv = text(c.savedVariables, 64, at + '.savedVariables');
    if (!SV_NAME.test(sv)) fail(at + '.savedVariables');
    const outbox = text(c.outbox, 200, at + '.outbox');
    if (!OUTBOX.test(outbox)) fail(at + '.outbox');
    out[folder] = { savedVariables: sv, outbox: outbox.split('.') };
  }
  return out;
}

// A checked manifest: { plugin } or { problem: 'too-new' | 'not-code' | 'bad', detail }. dir: the plugin's folder.
// code: a code plugin's (docs/PLUGINS.md §7), which names its script and the addon it is for instead of an outbox.
function checkManifest(json, dir, { code = false } = {}) {
  try {
    if (!json || typeof json !== 'object' || Array.isArray(json)) fail('not an object');
    if (typeof json.contract !== 'number' || !Number.isInteger(json.contract) || json.contract < 1) fail('contract');
    if (json.contract > CONTRACT) return { problem: 'too-new', detail: 'contract ' + json.contract };
    const id = text(json.id, 64, 'id');
    if (!ID.test(id)) fail('id');
    const sv = text(json.savedVariables, 64, 'savedVariables');
    if (!SV_NAME.test(sv)) fail('savedVariables');
    let outbox = null, script = null, forAddon = null;
    if (code) {
      if (json.script == null) return { problem: 'not-code' };
      script = safeRel(json.script);
      if (!script || !/\.m?js$/i.test(script) || script.startsWith('Media/')) fail('script');
      forAddon = text(json.for, 64, 'for');
      if (!FOLDER.test(forAddon)) fail('for');
      if (json.copies != null) fail('copies (data plugins only)');
    } else {
      // A data plugin never runs code: a script in an addon's folder is refused (code plugins are installed by hand).
      if (json.script != null) fail('script (code plugins are installed in the app, not found in addons)');
      outbox = text(json.outbox, 200, 'outbox');
      if (!OUTBOX.test(outbox)) fail('outbox');
    }
    const ks = kinds(json.kinds);
    const ids = ks.map((k) => k.id);
    fields(json.fields, ks);
    return { plugin: {
      id, contract: json.contract, name: text(json.name, 60, 'name'), author: text(json.author, 60, 'author', true),
      version: text(json.version, 30, 'version', true), savedVariables: sv, outbox: outbox ? outbox.split('.') : null,
      group: text(json.group, 30, 'group', true) || 'group', kinds: ks, templates: templates(json.templates, ids),
      weekly: weekly(json.weekly, ids), empty: text(json.empty, 200, 'empty', true), copies: copies(json.copies), dir,
      source: code ? 'code' : 'data', script, for: forAddon,
    } };
  } catch (e) {
    if (e instanceof ManifestError) return { problem: 'bad', detail: e.message };
    throw e;
  }
}

function readManifest(file, opts) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_MANIFEST) return { problem: 'bad', detail: 'too big' };
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return { problem: 'bad', detail: 'not JSON' }; }
  return checkManifest(json, path.dirname(file), opts);
}

// Every data plugin in these AddOns folders (one per watched game version, Forever first):
// [{ id, addon, plugin } | { id: null, addon, problem, detail }]. The same plugin in two games, or in two folders (the
// addon and a copy of it): the first one found. A plugin found in a folder its manifest names under `copies` reads
// that copy's saved data.
function findDataPlugins(addonsFolders) {
  const found = [], ids = new Set();
  for (const folder of addonsFolders || []) {
    let addons;
    // (An addon folder may be a link, a junction on Windows: developers link their repository into AddOns. The
    // manifest is then read through it.)
    try { addons = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort(); } catch (e) { continue; }
    for (const addon of addons) {
      const res = readManifest(path.join(folder, addon, 'Webhooks', MANIFEST));
      if (!res) continue;
      if (res.plugin) {
        if (ids.has(res.plugin.id)) continue;
        ids.add(res.plugin.id);
        found.push({ id: res.plugin.id, addon, plugin: { ...res.plugin, ...(res.plugin.copies[addon] || {}), addonDir: path.join(folder, addon) } });
      } else if (!found.some((f) => !f.id && f.addon === addon)) {
        found.push({ id: null, addon, problem: res.problem, detail: res.detail });
      }
    }
  }
  return found;
}

// The code plugins the player installed: one folder each, named by the plugin's id, in the app's own plugins folder
// (SPEC §3). [{ id, addon, folder, plugin } | { id: null, addon, folder, problem, detail }]; addon: the one it is
// for, folder: for Remove. Links are not followed: the app made every folder here.
function findCodePlugins(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ID.test(d.name)).map((d) => d.name).sort(); } catch (e) { return []; }
  return names.map((folder) => {
    const res = readManifest(path.join(dir, folder, MANIFEST), { code: true }) || { problem: 'bad', detail: 'no manifest' };
    if (res.plugin && res.plugin.id === folder) return { id: folder, addon: res.plugin.for, folder, plugin: res.plugin };
    return { id: null, addon: folder, folder, problem: res.problem === 'too-new' ? 'too-new' : 'bad', detail: res.detail || 'id' };
  });
}

// Where a plugin's file is on disk: "Media/..." in the addon's folder, anything else in the plugin's own. Null when
// the path is not safe or the file is missing.
function filePath(plugin, rel) {
  const safe = safeRel(rel);
  if (!safe) return null;
  const base = safe.startsWith('Media/') && plugin.addonDir ? plugin.addonDir : plugin.dir;
  const file = path.join(base, ...safe.split('/'));
  try {
    if (!fs.statSync(file).isFile()) return null;
    // A link inside the folder must not lead out of it. (The addon's folder itself may be a link: developers link
    // their repository into AddOns.)
    const root = fs.realpathSync(base), real = fs.realpathSync(file);
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch (e) { return null; }
}

module.exports = { CONTRACT, MANIFEST, ID, checkManifest, readManifest, findDataPlugins, findCodePlugins, filePath, safeRel };
