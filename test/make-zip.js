'use strict';
// Makes .zip files for tests and the sample code plugins: { name: content } → Buffer. Deflated, or stored.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makeZip(files, { store = false, flags = 0 } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8, crc = zlib.crc32(data), nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags | 0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags | 0x800, 8);
    entry.writeUInt16LE(method, 10); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, packed);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// A folder's files as makeZip takes them, under prefix ("simple-scores/" for a zipped folder).
function folderFiles(dir, prefix = '') {
  const out = {};
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) Object.assign(out, folderFiles(path.join(dir, d.name), prefix + d.name + '/'));
    else out[prefix + d.name] = fs.readFileSync(path.join(dir, d.name));
  }
  return out;
}

module.exports = { makeZip, folderFiles };
