'use strict';
// Game art (SPEC §7.1, docs/PLUGINS.md §6): a file from the game's own data, found by its file id, for a plugin's
// picture. The game keeps its files in Blizzard's storage in its Data folder: index files and archives in Data\data,
// the build's settings in Data\config. This reads them and never writes; it reads only the files it is asked for and
// what it needs to find them. Encrypted files (content not out yet) are not read. Plain Node, no Electron, so it can
// be tested.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_SYSTEM = 512 * 1024 * 1024; // the build's file list and key table
const MAX_FILE = 32 * 1024 * 1024;    // a file asked for

class GameDataError extends Error {
  // code: 'no-build' | 'not-found' (not in this build, or not downloaded yet) | 'encrypted' | 'bad' | 'too-big'
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; }
}

// .build.info and .flavor.info: a header ("Name!TYPE:n|...") and rows, split by "|".
function table(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const head = lines[0].split('|').map((h) => h.split('!')[0]);
  return lines.slice(1).map((l) => Object.fromEntries(l.split('|').map((v, i) => [head[i], v])));
}

// The build a game version runs (its folder, "_retail_"): the product its .flavor.info names, that product's build in
// .build.info, and from the build's settings the keys of its file list (root) and key table (encoding).
function buildOf(wowFolder, flavor) {
  let product, row, config;
  try {
    product = (table(fs.readFileSync(path.join(wowFolder, flavor, '.flavor.info'), 'utf8'))[0] || {})['Product Flavor'];
    row = table(fs.readFileSync(path.join(wowFolder, '.build.info'), 'utf8')).find((r) => r.Product === product && r.Active !== '0');
  } catch (e) { throw new GameDataError('no-build', e.code || e.message); }
  const key = row && row['Build Key'];
  if (!/^[0-9a-f]{32}$/.test(key || '')) throw new GameDataError('no-build', 'no build for ' + product);
  try {
    config = {};
    const text = fs.readFileSync(path.join(wowFolder, 'Data', 'config', key.slice(0, 2), key.slice(2, 4), key), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^([a-z-]+) = (.*)$/.exec(line.trim());
      if (m) config[m[1]] = m[2].split(' ');
    }
  } catch (e) { throw new GameDataError('no-build', e.code || e.message); }
  const hex = (v) => /^[0-9a-f]{32}$/.test(v || '');
  if (!config.root || !hex(config.root[0]) || !config.encoding || !hex(config.encoding[1])) throw new GameDataError('no-build', 'build config');
  return { product, key, root: config.root[0], encoding: config.encoding[1] };
}

// Data\data\*.idx: the newest index file of each of the 16 buckets. Each entry is 18 bytes: the first 9 bytes of a
// file's encoded key, where it is (5 bytes: the archive, then the offset in it) and its size (4 bytes).
function readIndex(dataDir) {
  const newest = new Map();
  for (const name of fs.readdirSync(dataDir)) {
    const m = /^([0-9a-f]{2})([0-9a-f]{8})\.idx$/i.exec(name);
    if (!m) continue;
    const bucket = parseInt(m[1], 16), version = parseInt(m[2], 16);
    if (bucket < 16 && !(newest.get(bucket) && newest.get(bucket).version > version)) newest.set(bucket, { version, name });
  }
  const buckets = [];
  for (const [bucket, { name }] of newest) {
    const buf = fs.readFileSync(path.join(dataDir, name));
    if (buf.length < 40) continue;
    const head = 8, hashSize = buf.readUInt32LE(0);
    if (buf.readUInt16LE(head) !== 7 || buf[head + 4] !== 4 || buf[head + 5] !== 5 || buf[head + 6] !== 9) continue;
    const at = (8 + hashSize + 15) & ~15; // the entries' block, 16-byte aligned: its size and hash, then the entries
    const size = Math.min(buf.readUInt32LE(at), buf.length - at - 8);
    buckets[bucket] = { entries: buf.subarray(at + 8, at + 8 + size - (size % 18)), bits: buf[head + 7] };
  }
  return buckets;
}

function bucketOf(ekey) {
  let x = 0;
  for (let i = 0; i < 9; i++) x ^= ekey[i];
  return (x & 0xf) ^ (x >> 4);
}

// BLTE, how the game stores a file: chunks, each plain ("N"), zlib ("Z"), itself BLTE ("F") or encrypted ("E").
function blte(buf, max) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'BLTE') throw new GameDataError('bad', 'blte');
  const headerSize = buf.readUInt32BE(4);
  const chunks = [];
  if (headerSize === 0) chunks.push([8, buf.length]);
  else {
    if (buf.length < 12) throw new GameDataError('bad', 'blte');
    const count = buf.readUIntBE(9, 3);
    let total = 0;
    for (let i = 0, at = 12, pos = headerSize; i < count; i++, at += 24) {
      if (at + 24 > buf.length) throw new GameDataError('bad', 'blte');
      const size = buf.readUInt32BE(at);
      total += buf.readUInt32BE(at + 4);
      chunks.push([pos, pos + size]);
      pos += size;
    }
    if (total > max) throw new GameDataError('too-big');
  }
  const out = [];
  let length = 0;
  for (const [from, to] of chunks) {
    if (to > buf.length || from >= to) throw new GameDataError('bad', 'blte chunk');
    const c = buf.subarray(from + 1, to);
    const mode = String.fromCharCode(buf[from]);
    let part;
    if (mode === 'N') part = c;
    else if (mode === 'Z') part = zlib.inflateSync(c, { maxOutputLength: max });
    else if (mode === 'F') part = blte(c, max);
    else if (mode === 'E') throw new GameDataError('encrypted');
    else throw new GameDataError('bad', 'blte mode ' + mode);
    length += part.length;
    if (length > max) throw new GameDataError('too-big');
    out.push(part);
  }
  return Buffer.concat(out);
}

// The key table (encoding): a content key → the encoded key the file is stored under. Pages sorted by key, with the
// first key of each page in front.
function encodedKey(enc, ckey) {
  if (enc.length < 22 || enc.toString('latin1', 0, 2) !== 'EN') throw new GameDataError('bad', 'encoding');
  const cSize = enc[3], eSize = enc[4], pageSize = enc.readUInt16BE(5) * 1024, pages = enc.readUInt32BE(9);
  const index = 22 + enc.readUInt32BE(18), first = index + pages * (cSize + 16);
  let lo = 0, hi = pages - 1, page = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, k = index + mid * (cSize + 16);
    if (enc.compare(ckey, 0, cSize, k, k + cSize) <= 0) { page = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (page < 0) return null;
  const end = Math.min(first + (page + 1) * pageSize, enc.length);
  for (let p = first + page * pageSize; p + 6 + cSize <= end;) {
    const n = enc[p];
    if (!n) break;
    const k = p + 6;
    if (enc.compare(ckey, 0, cSize, k, k + cSize) === 0) return enc.subarray(k + cSize, k + cSize + eSize);
    p = k + cSize + n * eSize;
  }
  return null;
}

// The file list (root): file id → content key, in blocks by locale and content flags. Found for the ids asked for:
// an English (or every-locale) copy first, not the low-violence one.
const EN_US = 0x2, LOW_VIOLENCE = 0x80, NO_NAMES = 0x10000000;
function contentKeys(root, ids) {
  const want = new Set(ids), best = new Map();
  let at, version = 1, mfst = root.length >= 12 && root.toString('latin1', 0, 4) === 'TSFM';
  if (mfst) {
    const a = root.readUInt32LE(4), b = root.readUInt32LE(8);
    if (a === 24 && b <= 2) { version = b; at = a; } else at = 12; // since 10.1.7 a header size and version come first
  } else at = 0;
  while (at + 12 <= root.length) {
    const count = root.readUInt32LE(at);
    let content, locale;
    if (version === 2) {
      locale = root.readUInt32LE(at + 4);
      content = root.readUInt32LE(at + 8) | root.readUInt32LE(at + 12) | (root[at + 16] << 17);
      at += 17;
    } else {
      content = root.readUInt32LE(at + 4); locale = root.readUInt32LE(at + 8);
      at += 12;
    }
    const ids = at, keys = at + count * 4;
    const named = !mfst || !(content & NO_NAMES);
    const stride = mfst ? 16 : 24; // before MFST each key is followed by its name hash
    const next = keys + count * stride + (mfst && named ? count * 8 : 0);
    if (next > root.length) throw new GameDataError('bad', 'root');
    const score = ((locale & EN_US) ? 2 : 0) + ((content & LOW_VIOLENCE) ? 0 : 1);
    let id = -1;
    for (let i = 0; i < count; i++) {
      id += 1 + root.readInt32LE(ids + i * 4);
      if (want.has(id) && !(best.get(id) && best.get(id).score >= score)) {
        best.set(id, { score, ckey: root.subarray(keys + i * stride, keys + i * stride + 16) });
      }
    }
    at = next;
  }
  return new Map([...best].map(([id, v]) => [id, v.ckey]));
}

// One game's storage: open(wowFolder, flavor) reads the build's settings and the index; read(fileId) → the file's
// bytes. The file list and key table are read on first use and kept until drop().
function open(wowFolder, flavor) {
  const build = buildOf(wowFolder, flavor);
  const dataDir = path.join(wowFolder, 'Data', 'data');
  let buckets = null, encoding = null, root = null;

  function readEncoded(ekey, max) {
    buckets = buckets || readIndex(dataDir);
    const b = buckets[bucketOf(ekey)];
    if (!b) throw new GameDataError('not-found');
    const e = b.entries;
    for (let i = 0; i + 18 <= e.length; i += 18) {
      if (e[i] !== ekey[0] || e.compare(ekey, 0, 9, i, i + 9) !== 0) continue;
      const where = e[i + 9] * 2 ** 32 + e.readUInt32BE(i + 10), size = e.readUInt32LE(i + 14);
      const archive = Math.floor(where / 2 ** b.bits), offset = where % 2 ** b.bits;
      if (size < 30 || size - 30 > max * 2 + 1024) throw new GameDataError('too-big');
      const fd = fs.openSync(path.join(dataDir, 'data.' + String(archive).padStart(3, '0')), 'r');
      try {
        const buf = Buffer.alloc(size);
        if (fs.readSync(fd, buf, 0, size, offset) !== size) throw new GameDataError('bad', 'short archive');
        return blte(buf.subarray(30), max); // each file in an archive has a 30-byte header first
      } finally { fs.closeSync(fd); }
    }
    throw new GameDataError('not-found');
  }
  const hexKey = (h) => Buffer.from(h, 'hex');

  function read(fileId) {
    if (!Number.isInteger(fileId) || fileId <= 0 || fileId > 0x7fffffff) throw new GameDataError('not-found');
    encoding = encoding || readEncoded(hexKey(build.encoding), MAX_SYSTEM);
    if (!root) {
      const ekey = encodedKey(encoding, hexKey(build.root));
      if (!ekey) throw new GameDataError('bad', 'no root');
      root = readEncoded(ekey, MAX_SYSTEM);
    }
    const ckey = contentKeys(root, [fileId]).get(fileId);
    const ekey = ckey && encodedKey(encoding, ckey);
    if (!ekey) throw new GameDataError('not-found');
    return readEncoded(ekey, MAX_FILE);
  }

  return { build, read, drop() { buckets = encoding = root = null; } };
}

module.exports = { open, buildOf, blte, encodedKey, contentKeys, readIndex, bucketOf, GameDataError };
