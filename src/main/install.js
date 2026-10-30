'use strict';
// Installing code plugins by hand (SPEC §3, docs/PLUGINS.md §7): look() reads and checks the .zip the player picked,
// for the warning; only after Install does install() put it in the app's own plugins folder. remove() takes one out
// again, with what its script kept. Nothing here runs the plugin.
const fs = require('fs');
const path = require('path');
const { readZip, ZipError } = require('./zip');
const plugins = require('./plugins');

const MAX_ZIP = 20 * 1024 * 1024;
// What zip tools on a Mac add, and what Windows leaves in folders: never part of a plugin.
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

// { plugin, files } or { problem: 'not-zip' | 'too-big' | 'no-manifest' | 'not-code' | 'too-new' | 'bad', detail }.
// The files may sit in one folder inside the zip (a zipped folder).
function look(file) {
  let buf;
  try {
    if (fs.statSync(file).size > MAX_ZIP) return { problem: 'too-big' };
    buf = fs.readFileSync(file);
  } catch (e) { return { problem: 'not-zip' }; }
  let files;
  try { files = readZip(buf); } catch (e) {
    if (e instanceof ZipError) return { problem: e.message === 'too big' || e.message === 'too many files' ? 'too-big' : 'not-zip', detail: e.message };
    throw e;
  }
  files = new Map([...files].filter(([n]) => !JUNK.test(n)));
  if (!files.has(plugins.MANIFEST)) {
    const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0] : null;
    if (!top || !files.has(top + '/' + plugins.MANIFEST)) return { problem: 'no-manifest' };
    files = new Map([...files].map(([n, d]) => [n.slice(top.length + 1), d]));
  }
  for (const n of files.keys()) if (plugins.safeRel(n) !== n) return { problem: 'bad', detail: 'file name ' + n };
  let json;
  try { json = JSON.parse(files.get(plugins.MANIFEST).toString('utf8').replace(/^﻿/, '')); } catch (e) { return { problem: 'bad', detail: 'not JSON' }; }
  const res = plugins.checkManifest(json, null, { code: true });
  if (!res.plugin) return res;
  if (!files.has(res.plugin.script)) return { problem: 'bad', detail: 'no ' + res.plugin.script };
  for (const t of Object.values(res.plugin.templates)) if (!files.has(t.file)) return { problem: 'bad', detail: 'no ' + t.file };
  return { plugin: res.plugin, files };
}

// A folder of the app's, or a link someone put there: a link goes, never what it leads to.
function removeFolder(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return; }
  if (st.isSymbolicLink()) fs.unlinkSync(dir);
  else fs.rmSync(dir, { recursive: true, force: true });
}

// Puts a looked-at plugin in <dir>/<id>/, in place of an older copy of it: written to a new folder first, then
// swapped, so a failure leaves the old one as it was.
function install(dir, { plugin, files }) {
  fs.mkdirSync(dir, { recursive: true });
  const fresh = fs.mkdtempSync(path.join(dir, '.new-'));
  const dest = path.join(dir, plugin.id), old = path.join(dir, '.old-' + plugin.id);
  try {
    for (const [name, data] of files) {
      const f = path.join(fresh, ...name.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    }
    removeFolder(old);
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(fresh, dest);
  } catch (e) {
    removeFolder(fresh);
    if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest);
    throw e;
  }
  removeFolder(old);
}

// Takes an installed plugin out, and what its script kept (stateDir/<id>). False when there is no such plugin.
function remove(dir, stateDir, id) {
  if (typeof id !== 'string' || !plugins.ID.test(id)) return false;
  const dest = path.join(dir, id);
  if (!fs.existsSync(dest)) return false;
  removeFolder(dest);
  removeFolder(path.join(stateDir, id));
  return true;
}

module.exports = { look, install, remove };
