'use strict';
// Game art: a texture read from the game's own data by its file id (src/main/casc.js), decoded from BLP and kept as
// PNG per build (src/main/game-art.js). Against a tiny game install made for the test (test/fake-game.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./tmp');
const { makeGame, blp } = require('./fake-game');
const casc = require('../src/main/casc');
const { createGameArt } = require('../src/main/game-art');
const { decodeBlp } = require('../src/main/pictures');
const { readText } = require('../src/main/outbox');

const RED = [255, 0, 0, 255], CLEAR_BLUE = [0, 0, 255, 128];
const texture = blp({ width: 2, height: 1, pixels: [RED, CLEAR_BLUE] });

// The pixels of a PNG the app wrote (8-bit RGBA, no filter).
function pngPixels(png) {
  const idat = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const rows = zlib.inflateSync(Buffer.concat(idat));
  return [...rows.subarray(1)];
}

test('a file found by its id in the game\'s storage: the file list, the key table, the index and the archive', () => {
  const { dir } = makeGame(tmpDir('awd-game-'), [
    { id: 131833, data: texture },
    { id: 131833, data: Buffer.from('the low-violence copy'), lowViolence: true },
    { id: 200, data: Buffer.from('x'.repeat(500)), zip: true },
    { id: 300, data: Buffer.from('secret'), encrypted: true },
    { id: 400, data: Buffer.from('not downloaded'), missing: true },
  ]);
  const store = casc.open(dir, '_retail_');
  assert.strictEqual(store.build.product, 'wow');
  assert.ok(store.read(131833).equals(texture), 'the English copy, not the low-violence one');
  assert.strictEqual(store.read(200).toString(), 'x'.repeat(500), 'zlib in several chunks');
  const code = (id) => { try { store.read(id); return 'read'; } catch (e) { return e.code; } };
  assert.strictEqual(code(300), 'encrypted', 'content not out yet is not read');
  assert.strictEqual(code(400), 'not-found', 'in the list, not on this computer yet');
  assert.strictEqual(code(999), 'not-found', 'not in this build');
  assert.strictEqual(code(-1), 'not-found');
  assert.throws(() => casc.open(dir, '_classic_'), (e) => e.code === 'no-build', 'a game folder that is not there');
});

test('BLP textures: palette with alpha, and DXT1', () => {
  assert.deepStrictEqual([...decodeBlp(texture).rgba], [...RED, ...CLEAR_BLUE]);
  // One DXT1 block: colour 0 white, colour 1 black, every pixel colour 0 but the last (colour 1).
  const dxt = blp({ width: 4, height: 4, dxt1: [0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0x40] });
  const px = decodeBlp(dxt).rgba;
  assert.deepStrictEqual([...px.subarray(0, 4)], [255, 255, 255, 255]);
  assert.deepStrictEqual([...px.subarray(60, 64)], [0, 0, 0, 255]);
  assert.throws(() => decodeBlp(Buffer.from('BLP1')), /BLP2/);
});

test('game art comes as PNG, kept per build: read once, and a new build drops the old pictures', () => {
  const wowDir = tmpDir('awd-game-'), cache = tmpDir('awd-art-');
  makeGame(wowDir, [{ id: 131833, data: texture }]);
  const art = createGameArt(cache);
  const png = art.png(wowDir, '_retail_', 131833);
  assert.deepStrictEqual(pngPixels(png), [...RED, ...CLEAR_BLUE]);
  const kept = path.join(cache, 'wow-' + 'ab'.repeat(16), '131833.png');
  assert.ok(fs.existsSync(kept), 'kept in the app\'s folder');
  fs.rmSync(path.join(wowDir, 'Data', 'data'), { recursive: true });
  assert.ok(art.png(wowDir, '_retail_', 131833).equals(png), 'the kept one, without reading the game again');
  assert.strictEqual(art.png(wowDir, '_retail_', 5), null);
  assert.strictEqual(art.png(wowDir, '_retail_', 1.5), null);
  assert.strictEqual(art.png(null, '_retail_', 131833), null);
  // The game updated: a new build key.
  makeGame(wowDir, [{ id: 131833, data: blp({ width: 1, height: 1, pixels: [RED] }) }], { buildKey: 'cd'.repeat(16) });
  assert.deepStrictEqual(pngPixels(art.png(wowDir, '_retail_', 131833)), [...RED]);
  assert.deepStrictEqual(fs.readdirSync(cache), ['wow-' + 'cd'.repeat(16)], 'the older build\'s pictures are gone');
  assert.ok(!fs.readdirSync(wowDir).includes('game-art'), 'nothing written in the game\'s folder');
});

test('a news item\'s picture may come from the game: its file id, the part to show and its shape', () => {
  const plugin = { outbox: ['DB', 'webhooks'], kinds: [{ id: 'clear', type: 'news', name: 'Clear' }] };
  const lua = (picture) => `DB = { webhooks = { format = 1, groups = { g = { name = "G", saved = 1, news = {
    { id = "a", kind = "clear", time = 1, text = "t", picture = ${picture} } } } } } }`;
  const pic = (p) => readText(lua(p), plugin).groups.g.news[0].picture;
  assert.deepStrictEqual(pic('{ game = 131833, crop = { 0, 1, 0.21, 0.78 }, aspect = 2.34 }'),
    { game: 131833, crop: [0, 1, 0.21, 0.78], aspect: 2.34 });
  assert.deepStrictEqual(pic('{ game = 131833 }'), { game: 131833, crop: null, aspect: null });
  assert.deepStrictEqual(pic('{ game = 131833, crop = { 0, 2, 0.5, 0.4 }, aspect = 0 }'), { game: 131833, crop: null, aspect: null },
    'a crop or shape that makes no sense is left out');
  assert.strictEqual(pic('"Media/DungeonHot.tga"'), 'Media/DungeonHot.tga');
  assert.strictEqual(pic('{ game = "131833" }'), null);
  assert.strictEqual(pic('{ game = 1.5 }'), null);
});
