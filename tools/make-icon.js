'use strict';
// Draws assets/icon.png (256 × 256): three linked nodes on a rounded teal square, a plain sign for "posts go out".
// Run: node tools/make-icon.js
const fs = require('fs');
const path = require('path');
const { encodePng } = require('../src/main/pictures');

const S = 256;
const rgba = Buffer.alloc(S * S * 4);
const nodes = [[128, 70], [70, 176], [186, 176]];
function segDist(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // Rounded square, radius 56, with a soft edge.
    const r = 56, cx = Math.min(Math.max(x + 0.5, r), S - r), cy = Math.min(Math.max(y + 0.5, r), S - r);
    const inside = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
    let c = [0x2F, 0xA4, 0xA9];
    const line = Math.min(segDist(x, y, nodes[0], nodes[1]), segDist(x, y, nodes[0], nodes[2]), segDist(x, y, nodes[1], nodes[2]));
    const node = Math.min(...nodes.map(([nx, ny]) => Math.hypot(x - nx, y - ny)));
    const white = Math.max(Math.max(0, Math.min(1, 9 - line)), Math.max(0, Math.min(1, 30 - node)));
    const hole = Math.max(0, Math.min(1, 14 - node));
    const w = white * (1 - hole);
    c = c.map((v, i) => Math.round(v * (1 - w) + [0xFF, 0xFF, 0xFF][i] * w));
    const i = (y * S + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = Math.round(255 * inside);
  }
}
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), encodePng({ width: S, height: S, rgba }));
