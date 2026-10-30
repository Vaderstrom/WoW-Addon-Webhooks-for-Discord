'use strict';
// Reading a .zip (a code plugin, docs/PLUGINS.md §7): untrusted input, read whole from memory. Only stored and
// deflated files; no encryption, no zip64. Sizes are checked before anything is unpacked, and each file against its
// stated size and checksum.
const zlib = require('zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

class ZipError extends Error {}
const fail = (why) => { throw new ZipError(why); };

// The zip's files (folders left out): Map(name with forward slashes → Buffer).
function readZip(buf, { maxFiles = 200, maxTotal = 32 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('not a zip');
  // The end record: the last 22 bytes, or up to 64 KB before them when the zip has a comment.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) fail('not a zip');
  const count = buf.readUInt16LE(end + 10), size = buf.readUInt32LE(end + 12), start = buf.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff) fail('zip64');
  if (count > maxFiles) fail('too many files');
  if (start + size > end) fail('bad');
  const files = new Map();
  let p = start, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) fail('bad');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20), length = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength > end) fail('bad');
    // Names are UTF-8 when the zip says so (bit 11), else the old DOS code page: read as Latin-1, which keeps ASCII.
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength).replace(/\\/g, '/');
    p += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (flags & 1) fail('encrypted');
    if (method !== 0 && method !== 8) fail('compression');
    total += length;
    if (total > maxTotal) fail('too big');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) fail('bad');
    const at = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (at + packed > buf.length) fail('bad');
    const raw = buf.subarray(at, at + packed);
    let data;
    try { data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, length) }); } catch (e) { fail('bad'); }
    if (data.length !== length || (zlib.crc32 && zlib.crc32(data) !== crc)) fail('bad');
    if (files.has(name)) fail('a name twice');
    files.set(name, data);
  }
  return files;
}

module.exports = { readZip, ZipError };
