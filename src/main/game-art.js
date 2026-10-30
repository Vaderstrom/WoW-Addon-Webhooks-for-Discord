'use strict';
// Game art for plugins' pictures (SPEC §7.1, docs/PLUGINS.md §3, §6): a texture from the game's own data
// (src/main/casc.js), by its file id, as PNG. Each picture is kept in the app's folder per game build, so the game's
// data is read once per picture and build; a new build of a game drops that game's older ones. Nothing is written in
// the game's folder. Plain Node, no Electron, so it can be tested.
const fs = require('fs');
const path = require('path');
const casc = require('./casc');
const { decodeBlp, encodePng } = require('./pictures');

const IDLE = 120 * 1000; // a game's file list and key table are let go two minutes after the last picture

function createGameArt(cacheDir, open = casc.open, buildOf = casc.buildOf) {
  const stores = new Map(); // "<wow folder>|<flavor>" → { store, timer }
  const missing = new Set(); // "<build>/<id>" found missing this run

  function storeFor(wowFolder, flavor, build) {
    const key = wowFolder + '|' + flavor;
    let s = stores.get(key);
    if (s && s.store.build.key !== build.key) { s.store.drop(); clearTimeout(s.timer); s = null; }
    if (!s) { s = { store: open(wowFolder, flavor), timer: null }; stores.set(key, s); }
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.store.drop(); stores.delete(key); }, IDLE);
    if (s.timer.unref) s.timer.unref();
    return s.store;
  }

  // A new build's folder: the same game's folders for older builds go.
  function folderFor(build) {
    const dir = path.join(cacheDir, build.product.replace(/[^\w-]/g, '_') + '-' + build.key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const d of fs.readdirSync(cacheDir)) {
        if (d.startsWith(build.product + '-') && d !== path.basename(dir)) fs.rmSync(path.join(cacheDir, d), { recursive: true, force: true });
      }
    }
    return dir;
  }

  // The PNG of file fileId in that game's data, or null: no such game or build, not in it, not downloaded yet,
  // encrypted, or not a picture.
  function png(wowFolder, flavor, fileId) {
    if (!wowFolder || !flavor || !Number.isInteger(fileId) || fileId <= 0 || fileId > 0x7fffffff) return null;
    let build;
    try { build = buildOf(wowFolder, flavor); } catch (e) { return null; }
    const id = build.key + '/' + fileId;
    if (missing.has(id)) return null;
    let file = null;
    try { file = path.join(folderFor(build), fileId + '.png'); return fs.readFileSync(file); } catch (e) { /* not kept yet */ }
    let data;
    try {
      data = encodePng(decodeBlp(storeFor(wowFolder, flavor, build).read(fileId)));
    } catch (e) {
      missing.add(id);
      return null;
    }
    try { if (file) fs.writeFileSync(file, data); } catch (e) { /* kept next time */ }
    return data;
  }

  return { png };
}

module.exports = { createGameArt };
