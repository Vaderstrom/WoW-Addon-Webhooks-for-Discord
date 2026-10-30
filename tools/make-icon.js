'use strict';
// Draws the app's icon: the Forever crest (the bronze rune ring with eight studs around a blue disc, as in Journey
// Together Forever's logo) with a webhook sign in it, three nodes joined by curved arms (one post going out to
// several places). Drawn anew for each size: at 32 pixels and less the studs and runes go and the lines thicken, so
// the tray icon stays readable.
//   assets/icon.ico  16, 24, 32, 48, 64, 128 and 256 pixels: the program, installer, window and tray
//   assets/icon.png  256 pixels: notices, the README
// Run: npx electron tools/make-icon.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const C = 128;
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pt = (a, r) => [C + Math.sin(a) * r, C - Math.cos(a) * r];
const f = (p) => p.map((v) => v.toFixed(1)).join(',');

// A stud: a four-sided pyramid pointing out at angle a, lit from the top left.
function stud(a, r0, r1, w) {
  const tip = pt(a, r1), base = pt(a, r0), l = pt(a - w, r0 + 6), r = pt(a + w, r0 + 6), mid = pt(a, r0 + (r1 - r0) * 0.35);
  const lit = Math.cos(a + Math.PI / 4) > 0;
  return `<path d="M${f(l)} L${f(tip)} L${f(mid)} Z" fill="${lit ? '#E9C48A' : '#8A5A2B'}"/>
    <path d="M${f(r)} L${f(tip)} L${f(mid)} Z" fill="${lit ? '#B7854A' : '#5E3B1C'}"/>
    <path d="M${f(l)} L${f(mid)} L${f(r)} L${f(base)} Z" fill="#7A4E26"/>`;
}

function svg(size) {
  const small = size <= 32, mid = size <= 48;
  const studs = small ? '' : [0, 1, 2, 3, 4, 5, 6, 7].map((i) => stud(i * Math.PI / 4, 92, 124, 0.22)).join('');
  const ringR = small ? 124 : 100, discR = small ? 92 : 82;
  const runes = mid ? '' : Array.from({ length: 24 }, (_, i) => {
    const a = (i + 0.5) / 24 * Math.PI * 2, [x, y] = pt(a, 93), d = (i % 3) - 1;
    return `<path d="M0,-5 L0,5 M-3,${-2 + d * 2} L3,${2 - d * 2}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(a * 180 / Math.PI).toFixed(0)})"/>`;
  }).join('');
  // The sign: three nodes, each joined to the next by an arm that bows outward.
  const s = small ? 54 : 44, lw = small ? 22 : 12, r = small ? 23 : 15;
  const p = [0, 1, 2].map((i) => pt(i * 2 * Math.PI / 3, s));
  const arm = (a, b) => {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    return `M${f(a)} Q${f([mx + (mx - C) * 0.55, my + (my - C) * 0.55])} ${f(b)}`;
  };
  const arms = [arm(p[0], p[1]), arm(p[1], p[2]), arm(p[2], p[0])].join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <radialGradient id="disc" cx="0.42" cy="0.36" r="0.7"><stop offset="0" stop-color="#5FD0F0"/><stop offset="0.55" stop-color="#1F86B8"/><stop offset="1" stop-color="#0B3E63"/></radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#D8AE72"/><stop offset="0.5" stop-color="#9C6B37"/><stop offset="1" stop-color="#5A3819"/></linearGradient>
    <linearGradient id="sign" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF8E6"/><stop offset="1" stop-color="#D9CBA8"/></linearGradient>
  </defs>
  ${studs}
  <circle cx="128" cy="128" r="${ringR - 3}" fill="url(#ring)" stroke="#3E2610" stroke-width="${small ? 6 : 4}"/>
  <g stroke="#3E2610" stroke-opacity="0.75" stroke-width="2.5" fill="none" stroke-linecap="round">${runes}</g>
  <circle cx="128" cy="128" r="${discR}" fill="url(#disc)" stroke="#3E2610" stroke-width="${small ? 6 : 4}"/>
  <path d="${arms}" fill="none" stroke="#0B2E47" stroke-width="${lw + 7}" stroke-linecap="round"/>
  <path d="${arms}" fill="none" stroke="url(#sign)" stroke-width="${lw}" stroke-linecap="round"/>
  ${p.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r + 3.5}" fill="#0B2E47"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#sign)"/>${small ? '' : `<circle cx="${x}" cy="${y}" r="5.5" fill="#16618F"/>`}`).join('')}
</svg>`;
}

// An ICO file: 256 pixels as PNG, every other size as a 32-bit bitmap (older Windows parts read PNG only at 256).
function ico(images) {
  const parts = images.map(({ size, rgba, png }) => {
    if (size >= 256) return png;
    const head = Buffer.alloc(40);
    head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8);
    head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4, o = ((size - 1 - y) * size + x) * 4; // bottom-up, BGRA
        pixels[o] = rgba[i + 2]; pixels[o + 1] = rgba[i + 1]; pixels[o + 2] = rgba[i]; pixels[o + 3] = rgba[i + 3];
      }
    }
    const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all shown: the alpha channel does the rest
    return Buffer.concat([head, pixels, mask]);
  });
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size }, i) => {
    const e = 6 + 16 * i;
    dir[e] = size >= 256 ? 0 : size; dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(parts[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += parts[i].length;
  });
  return Buffer.concat([dir, ...parts]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<!doctype html><canvas></canvas>');
  const images = [];
  for (const size of SIZES) {
    // Drawn on a canvas of exactly that size: no screen scaling in between.
    const out = await w.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg(size)).toString('base64')}';
      await img.decode();
      const c = document.querySelector('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.clearRect(0, 0, ${size}, ${size}); g.drawImage(img, 0, 0, ${size}, ${size});
      const d = g.getImageData(0, 0, ${size}, ${size}).data;
      let s = ''; for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
      return { rgba: btoa(s), png: c.toDataURL('image/png').split(',')[1] };
    })()`);
    images.push({ size, rgba: Buffer.from(out.rgba, 'base64'), png: Buffer.from(out.png, 'base64') });
  }
  const assets = path.join(__dirname, '..', 'assets');
  fs.writeFileSync(path.join(assets, 'icon.ico'), ico(images));
  fs.writeFileSync(path.join(assets, 'icon.png'), images.find((i) => i.size === 256).png);
  console.log('assets/icon.ico (' + SIZES.join(', ') + ') and assets/icon.png');
  app.quit();
});
