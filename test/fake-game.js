'use strict';
// A tiny game install for tests: .build.info, a game folder's .flavor.info, the build's settings, and Blizzard's
// storage in Data\data (index files, one archive) holding a file list (root), a key table (encoding) and the files
// given. Laid out as the game lays its own out (src/main/casc.js).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const md5 = (b) => crypto.createHash('md5').update(b).digest();
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// BLTE: one plain chunk without a chunk table, or zlib chunks of at most 64 bytes with one.
function blte(data, { zip = false, encrypted = false } = {}) {
  if (encrypted) return Buffer.concat([Buffer.from('BLTE'), u32be(0), Buffer.from('E'), Buffer.alloc(16)]);
  if (!zip) return Buffer.concat([Buffer.from('BLTE'), u32be(0), Buffer.from('N'), data]);
  const parts = [];
  for (let i = 0; i < data.length || !parts.length; i += 64) parts.push(data.subarray(i, i + 64));
  const chunks = parts.map((p) => Buffer.concat([Buffer.from('Z'), zlib.deflateSync(p)]));
  const head = [Buffer.from('BLTE'), u32be(12 + 24 * chunks.length), Buffer.from([0x0f, 0, 0, chunks.length])];
  for (let i = 0; i < chunks.length; i++) head.push(u32be(chunks[i].length), u32be(parts[i].length), md5(chunks[i]));
  return Buffer.concat([...head, ...chunks]);
}

// The key table: content key → encoded key, two entries per 4 KB page.
function encodingTable(pairs) {
  const sorted = pairs.slice().sort((a, b) => Buffer.compare(a.ckey, b.ckey));
  const pages = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const page = Buffer.alloc(4096);
    let p = 0;
    for (const e of sorted.slice(i, i + 2)) {
      page[p] = 1; page.writeUIntBE(e.size, p + 1, 5); e.ckey.copy(page, p + 6); e.ekey.copy(page, p + 22);
      p += 38;
    }
    pages.push({ first: sorted[i].ckey, page });
  }
  const head = Buffer.alloc(22);
  head.write('EN', 0, 'latin1'); head[2] = 1; head[3] = 16; head[4] = 16;
  head.writeUInt16BE(4, 5); head.writeUInt16BE(4, 7); head.writeUInt32BE(pages.length, 9);
  return Buffer.concat([head, ...pages.map((p) => Buffer.concat([p.first, md5(p.page)])), ...pages.map((p) => p.page)]);
}

// The file list (MFST, version 2): blocks of { locale, content flags, files: [[id, ckey]] }.
function rootFile(blocks) {
  const total = blocks.reduce((n, b) => n + b.files.length, 0);
  const out = [Buffer.from('TSFM', 'latin1'), u32le(24), u32le(2), u32le(total), u32le(total), u32le(0)];
  for (const b of blocks) {
    const files = b.files.slice().sort((x, y) => x[0] - y[0]);
    out.push(u32le(files.length), u32le(b.locale), u32le(b.content), u32le(0), Buffer.from([0]));
    let prev = -1;
    for (const [id] of files) { out.push(u32le(id - prev - 1)); prev = id; }
    for (const [, ckey] of files) out.push(ckey);
    if (!(b.content & 0x10000000)) out.push(Buffer.alloc(8 * files.length));
  }
  return Buffer.concat(out);
}

// files: [{ id, data, zip, encrypted, lowViolence, missing (in the list but not on disk) }]. Returns the folder and the
// build key.
function makeGame(dir, files, { product = 'wow', flavor = '_retail_', buildKey = 'ab'.repeat(16) } = {}) {
  const stored = []; // { ekey, body }
  const pairs = [];
  const store = (data, opts = {}) => {
    const body = blte(data, opts), ckey = md5(data), ekey = md5(body);
    pairs.push({ ckey, ekey, size: data.length });
    if (!opts.missing) stored.push({ ekey, body });
    return ckey;
  };
  const english = [], low = [];
  for (const f of files) (f.lowViolence ? low : english).push([f.id, store(f.data, f)]);
  const root = rootFile([{ locale: 0x2, content: 0, files: english }, { locale: 0xffffffff, content: 0x10000080, files: low }]);
  const rootKey = store(root, { zip: true });
  // The key table is not in itself: its encoded key comes from the build's settings.
  const enc = blte(encodingTable(pairs), { zip: true }), encEkey = md5(enc);
  stored.push({ ekey: encEkey, body: enc });

  // One archive; each file with a 30-byte header in front.
  const data = path.join(dir, 'Data', 'data');
  fs.mkdirSync(data, { recursive: true });
  const archive = [], buckets = new Map();
  let offset = 0;
  for (const s of stored) {
    const head = Buffer.alloc(30);
    Buffer.from(s.ekey).reverse().copy(head, 0);
    head.writeUInt32LE(30 + s.body.length, 16);
    archive.push(head, s.body);
    let x = 0;
    for (let i = 0; i < 9; i++) x ^= s.ekey[i];
    const bucket = (x & 0xf) ^ (x >> 4);
    const entry = Buffer.alloc(18);
    s.ekey.copy(entry, 0, 0, 9);
    entry[9] = 0; entry.writeUInt32BE(offset, 10); // archive 0
    entry.writeUInt32LE(30 + s.body.length, 14);
    buckets.set(bucket, [...(buckets.get(bucket) || []), entry]);
    offset += 30 + s.body.length;
  }
  fs.writeFileSync(path.join(data, 'data.000'), Buffer.concat(archive));
  for (let b = 0; b < 16; b++) {
    const entries = Buffer.concat(buckets.get(b) || []);
    const head = Buffer.alloc(40);
    head.writeUInt32LE(16, 0); head.writeUInt16LE(7, 8); head[10] = b; head[12] = 4; head[13] = 5; head[14] = 9; head[15] = 30;
    head.writeUInt32LE(entries.length, 32);
    const name = b.toString(16).padStart(2, '0');
    fs.writeFileSync(path.join(data, name + '00000002.idx'), Buffer.concat([head, entries]));
    fs.writeFileSync(path.join(data, name + '00000001.idx'), Buffer.alloc(40)); // an older one, not read
  }

  const cfg = path.join(dir, 'Data', 'config', buildKey.slice(0, 2), buildKey.slice(2, 4));
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, buildKey), `# Build Configuration\n\nroot = ${rootKey.toString('hex')}\n`
    + `encoding = ${md5(Buffer.from('x')).toString('hex')} ${encEkey.toString('hex')}\nbuild-name = WOW-1test\n`);
  fs.writeFileSync(path.join(dir, '.build.info'), 'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|Version!STRING:0|Product!STRING:0\n'
    + `eu|1|${buildKey}|1.0.0.1|${product}\n`);
  fs.mkdirSync(path.join(dir, flavor), { recursive: true });
  fs.writeFileSync(path.join(dir, flavor, '.flavor.info'), `Product Flavor!STRING:0\n${product}\n`);
  return { dir, buildKey };
}

// A BLP2 texture: palette (encoding 1, rgba given per pixel, 8-bit alpha) or DXT1 (blocks given).
function blp({ width, height, pixels, dxt1 }) {
  const head = Buffer.alloc(148 + 1024);
  head.write('BLP2', 0, 'latin1'); head.writeUInt32LE(1, 4);
  let data;
  if (dxt1) {
    head[8] = 2; head[9] = 0; head[10] = 0;
    data = Buffer.from(dxt1);
  } else {
    head[8] = 1; head[9] = 8;
    const index = Buffer.alloc(width * height), alpha = Buffer.alloc(width * height);
    pixels.forEach(([r, g, b, a], i) => {
      head[148 + i * 4] = b; head[148 + i * 4 + 1] = g; head[148 + i * 4 + 2] = r;
      index[i] = i; alpha[i] = a;
    });
    data = Buffer.concat([index, alpha]);
  }
  head.writeUInt32LE(width, 12); head.writeUInt32LE(height, 16);
  head.writeUInt32LE(head.length, 20); head.writeUInt32LE(data.length, 84);
  return Buffer.concat([head, data]);
}

module.exports = { makeGame, blp, blte };
