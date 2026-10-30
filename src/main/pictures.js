'use strict';
// Pictures for posts and templates (docs/PLUGINS.md §3, §6): JPG and PNG as they are; TGA (addons keep their art in
// Media as TGA) read here and written as PNG. Plain Node, no Electron, so it can be tested.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { filePath } = require('./plugins');

const MAX_SIDE = 4096;
const MAX_FILE = 16 * 1024 * 1024;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tga': 'image/png' };

// A TGA file → { width, height, rgba }. Truecolour (24 or 32 bits) and greyscale, plain or run-length encoded.
// maxSide: the widest it may be (the game's screenshots are larger than an addon's art).
function decodeTga(buf, maxSide = MAX_SIDE) {
  if (buf.length < 18) throw new Error('tga: too short');
  const idLength = buf[0], mapType = buf[1], type = buf[2];
  const mapLength = buf.readUInt16LE(5), mapDepth = buf[7];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14), depth = buf[16], desc = buf[17];
  const grey = type === 3 || type === 11, rle = type === 10 || type === 11;
  if (![2, 3, 10, 11].includes(type)) throw new Error('tga: type ' + type);
  if (!width || !height || width > maxSide || height > maxSide) throw new Error('tga: size');
  const bpp = depth / 8;
  if (grey ? bpp !== 1 : bpp !== 3 && bpp !== 4) throw new Error('tga: depth ' + depth);
  let pos = 18 + idLength + (mapType ? mapLength * Math.ceil(mapDepth / 8) : 0);
  const count = width * height;
  const raw = Buffer.alloc(count * bpp);
  if (!rle) {
    if (pos + raw.length > buf.length) throw new Error('tga: short data');
    buf.copy(raw, 0, pos, pos + raw.length);
  } else {
    let n = 0;
    while (n < count) {
      if (pos >= buf.length) throw new Error('tga: short data');
      const head = buf[pos++], run = (head & 0x7f) + 1;
      if (n + run > count) throw new Error('tga: bad run');
      if (head & 0x80) {
        if (pos + bpp > buf.length) throw new Error('tga: short data');
        for (let i = 0; i < run; i++) buf.copy(raw, (n + i) * bpp, pos, pos + bpp);
        pos += bpp;
      } else {
        if (pos + run * bpp > buf.length) throw new Error('tga: short data');
        buf.copy(raw, n * bpp, pos, pos + run * bpp);
        pos += run * bpp;
      }
      n += run;
    }
  }
  // Rows run bottom to top unless bit 5 says top first; pixels are BGR(A).
  const top = (desc & 0x20) !== 0;
  const rgba = Buffer.alloc(count * 4);
  for (let y = 0; y < height; y++) {
    const src = (top ? y : height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const s = (src + x) * bpp, d = (y * width + x) * 4;
      if (grey) { rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s]; rgba[d + 3] = 255; continue; }
      rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = bpp === 4 ? raw[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}

// The game's own textures (BLP2, read from its data by src/main/casc.js) → { width, height, rgba }: the largest
// picture in the file, palette, DXT1/3/5 or plain BGRA.
function decodeBlp(buf, maxSide = MAX_SIDE) {
  if (buf.length < 148 || buf.toString('latin1', 0, 4) !== 'BLP2') throw new Error('blp: not BLP2');
  const encoding = buf[8], alphaDepth = buf[9], alphaType = buf[10];
  const width = buf.readUInt32LE(12), height = buf.readUInt32LE(16);
  const offset = buf.readUInt32LE(20), size = buf.readUInt32LE(84);
  if (!width || !height || width > maxSide || height > maxSide) throw new Error('blp: size');
  if (offset + size > buf.length || !size) throw new Error('blp: short data');
  const data = buf.subarray(offset, offset + size);
  const count = width * height, rgba = Buffer.alloc(count * 4);
  if (encoding === 1) {
    // A palette of 256 BGRA colours (148), an index per pixel, then the alpha at alphaDepth bits per pixel.
    if (buf.length < 1172 || data.length < count + Math.ceil(count * alphaDepth / 8)) throw new Error('blp: short data');
    for (let i = 0; i < count; i++) {
      const c = 148 + data[i] * 4, d = i * 4;
      rgba[d] = buf[c + 2]; rgba[d + 1] = buf[c + 1]; rgba[d + 2] = buf[c];
      if (alphaDepth === 8) rgba[d + 3] = data[count + i];
      else if (alphaDepth === 4) rgba[d + 3] = ((data[count + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
      else if (alphaDepth === 1) rgba[d + 3] = (data[count + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      else rgba[d + 3] = 255;
    }
  } else if (encoding === 3) {
    if (data.length < count * 4) throw new Error('blp: short data');
    for (let i = 0; i < count * 4; i += 4) { rgba[i] = data[i + 2]; rgba[i + 1] = data[i + 1]; rgba[i + 2] = data[i]; rgba[i + 3] = data[i + 3]; }
  } else if (encoding === 2) {
    const dxt = alphaDepth === 0 || alphaType === 0 ? 1 : alphaType === 1 ? 3 : alphaType === 7 ? 5 : 0;
    if (!dxt) throw new Error('blp: alpha type ' + alphaType);
    const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4), blockSize = dxt === 1 ? 8 : 16;
    if (data.length < bw * bh * blockSize) throw new Error('blp: short data');
    const colours = new Uint8Array(16), alpha = new Uint8Array(16);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let p = (by * bw + bx) * blockSize;
        if (dxt === 3) { for (let i = 0; i < 16; i++) alpha[i] = ((data[p + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17; p += 8; }
        else if (dxt === 5) { dxt5Alpha(data, p, alpha); p += 8; }
        else alpha.fill(255);
        const c = dxtColours(data, p, dxt === 1, alphaDepth > 0, colours);
        const bits = data.readUInt32LE(p + 4);
        for (let i = 0; i < 16; i++) {
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          if (x >= width || y >= height) continue;
          const k = (bits >> (i * 2)) & 3, d = (y * width + x) * 4;
          rgba[d] = c[k * 4]; rgba[d + 1] = c[k * 4 + 1]; rgba[d + 2] = c[k * 4 + 2];
          rgba[d + 3] = dxt === 1 ? c[k * 4 + 3] : alpha[i];
        }
      }
    }
  } else throw new Error('blp: encoding ' + encoding);
  return { width, height, rgba };
}
// A DXT colour block's four colours (RGBA each). DXT1 blocks whose first colour is not the larger have three colours
// and black, transparent when the texture has alpha; DXT3 and DXT5 always have four.
function dxtColours(data, p, dxt1, alpha, out) {
  const c0 = data.readUInt16LE(p), c1 = data.readUInt16LE(p + 2);
  const rgb = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const a = rgb(c0), b = rgb(c1);
  const set = (k, v, op) => { out[k * 4] = v[0]; out[k * 4 + 1] = v[1]; out[k * 4 + 2] = v[2]; out[k * 4 + 3] = op; };
  const mix = (wa, wb, sum) => a.map((v, i) => (v * wa + b[i] * wb) / sum);
  set(0, a, 255); set(1, b, 255);
  if (!dxt1 || c0 > c1) { set(2, mix(2, 1, 3), 255); set(3, mix(1, 2, 3), 255); }
  else { set(2, mix(1, 1, 2), 255); set(3, [0, 0, 0], alpha ? 0 : 255); }
  return out;
}
// A DXT5 alpha block: two alphas, then a 3-bit index per pixel (16 in 6 bytes) into the eight values between them.
function dxt5Alpha(data, p, out) {
  const a0 = data[p], a1 = data[p + 1], v = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) v.push(((7 - i) * a0 + i * a1) / 7);
  else { for (let i = 1; i < 5; i++) v.push(((5 - i) * a0 + i * a1) / 5); v.push(0, 255); }
  for (let half = 0; half < 2; half++) {
    const q = p + 2 + half * 3, bits = data[q] | (data[q + 1] << 8) | (data[q + 2] << 16);
    for (let i = 0; i < 8; i++) out[half * 8 + i] = v[(bits >> (3 * i)) & 7];
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// { width, height, rgba } → a PNG file.
function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// A plugin's picture by its path in the outbox or template ("art/x.jpg", "Media/x.tga"): { name, data, type } or null
// when the path is not allowed, the file is missing, too big or not a picture.
function loadPicture(plugin, rel) {
  const file = filePath(plugin, rel);
  const ext = file ? path.extname(file).toLowerCase() : '';
  if (!file || !TYPES[ext]) return null;
  try {
    if (fs.statSync(file).size > MAX_FILE) return null;
    const data = fs.readFileSync(file);
    const base = path.basename(file, path.extname(file)).replace(/[^\w-]/g, '_') || 'picture';
    if (ext === '.tga') return { name: base + '.png', data: encodePng(decodeTga(data)), type: 'image/png' };
    return { name: base + ext, data, type: TYPES[ext] };
  } catch (e) { return null; }
}

module.exports = { decodeTga, decodeBlp, encodePng, loadPicture };
