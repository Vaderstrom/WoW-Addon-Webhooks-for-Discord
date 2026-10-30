'use strict';
// TGA pictures (addons keep their art in Media as TGA) read and written as PNG.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { decodeTga, encodePng, loadPicture } = require('../src/main/pictures');
const plugins = require('../src/main/plugins');

function tga({ type, depth, top, w, h, body }) {
  const head = Buffer.alloc(18);
  head[2] = type; head.writeUInt16LE(w, 12); head.writeUInt16LE(h, 14); head[16] = depth; head[17] = top ? 0x20 : 0;
  return Buffer.concat([head, Buffer.from(body)]);
}

test('plain 24-bit, rows from the bottom: pixels come out top first, as RGBA', () => {
  // 2 x 2: bottom row red, green; top row blue, white (stored BGR).
  const img = decodeTga(tga({ type: 2, depth: 24, w: 2, h: 2, body: [0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255] }));
  assert.deepStrictEqual([...img.rgba], [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
});

test('run-length 32-bit, rows from the top, with alpha', () => {
  // 3 x 1: a run of two half-clear red pixels, then one raw opaque blue.
  const img = decodeTga(tga({ type: 10, depth: 32, top: true, w: 3, h: 1, body: [0x81, 0, 0, 255, 128, 0x00, 255, 0, 0, 255] }));
  assert.deepStrictEqual([...img.rgba], [255, 0, 0, 128, 255, 0, 0, 128, 0, 0, 255, 255]);
});

test('broken files are refused', () => {
  assert.throws(() => decodeTga(Buffer.alloc(5)));
  assert.throws(() => decodeTga(tga({ type: 1, depth: 8, w: 1, h: 1, body: [0] })), /type/);
  assert.throws(() => decodeTga(tga({ type: 2, depth: 24, w: 2, h: 2, body: [1, 2, 3] })), /short/);
  assert.throws(() => decodeTga(tga({ type: 10, depth: 24, w: 1, h: 1, body: [0x85, 1, 2, 3] })), /run/);
});

test('PNG out: the right size and the same pixels', () => {
  const rgba = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const png = encodePng({ width: 2, height: 1, rgba });
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(png.readUInt32BE(16), 2);
  assert.strictEqual(png.readUInt32BE(20), 1);
  const idatAt = png.indexOf('IDAT');
  const rows = zlib.inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)));
  assert.deepStrictEqual([...rows], [0, ...rgba]);
});

test('a plugin\'s picture: the addon\'s TGA as PNG; nothing outside the plugin', () => {
  const p = plugins.findDataPlugins([path.join(__dirname, 'fixtures', 'AddOns')])[0].plugin;
  const pic = loadPicture(p, 'Media/Icon.tga');
  assert.strictEqual(pic.name, 'Icon.png');
  assert.strictEqual(pic.type, 'image/png');
  assert.strictEqual(pic.data.readUInt32BE(16), 32);
  assert.strictEqual(loadPicture(p, '../../ExampleTracker/Media/Icon.tga'), null);
  assert.strictEqual(loadPicture(p, 'card.html'), null, 'not a picture');
});
