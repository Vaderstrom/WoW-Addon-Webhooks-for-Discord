'use strict';
// A news item's game picture (docs/PLUGINS.md §3, { game, crop, aspect }) as Discord takes it: game art cut to its
// crop, shaped to its aspect, a JPEG at most 1920 pixels wide. png(fileId) → PNG | null (src/main/game-art.js).
const { nativeImage } = require('electron');

const WIDTH = 1920;
const QUALITY = 85;

function gamePicture(png, p) {
  const data = png && p && png(p.game);
  let img = data ? nativeImage.createFromBuffer(data) : null;
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (p.crop) {
    const [l, r, t, b] = p.crop;
    const x = Math.round(l * width), y = Math.round(t * height);
    img = img.crop({ x, y, width: Math.max(1, Math.round(r * width) - x), height: Math.max(1, Math.round(b * height) - y) });
  }
  if (p.aspect) { const h = img.getSize().height; img = img.resize({ width: Math.round(h * p.aspect), height: h, quality: 'best' }); }
  if (img.getSize().width > WIDTH) img = img.resize({ width: WIDTH, quality: 'best' });
  return { name: 'game-' + p.game + '.jpg', data: img.toJPEG(QUALITY), type: 'image/jpeg' };
}

module.exports = { gamePicture };
