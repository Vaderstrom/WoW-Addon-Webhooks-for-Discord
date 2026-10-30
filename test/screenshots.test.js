'use strict';
// Finding the game's screenshot a news item names, by the second it was taken (this computer's clock).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const screenshots = require('../src/main/screenshots');

const at = (h, m, s) => Math.floor(new Date(2026, 9, 29, h, m, s).getTime() / 1000);

test('the file name is the game\'s: month, day, year, then the time', () => {
  assert.strictEqual(screenshots.baseName(at(14, 5, 9)), 'WoWScrnShot_102926_140509');
  assert.strictEqual(screenshots.folder('C:\\WoW', '_retail_'), path.join('C:\\WoW', '_retail_', 'Screenshots'));
});

test('found at that second or a little later, as JPG, PNG or TGA; nothing else, and no empty file', () => {
  const dir = tmpDir('awd-shots-');
  const put = (sec, ext, data = 'x') => fs.writeFileSync(path.join(dir, screenshots.baseName(sec) + ext), data);
  put(at(14, 0, 1), '.jpg');
  put(at(14, 10, 2), '.tga');
  put(at(14, 20, 0), '.png');
  put(at(14, 30, 0), '.bmp');
  put(at(14, 40, 0), '.jpg', '');
  put(at(14, 50, 10), '.jpg');
  assert.strictEqual(screenshots.find(dir, at(14, 0, 0)), path.join(dir, 'WoWScrnShot_102926_140001.jpg'), 'a second later');
  assert.strictEqual(screenshots.find(dir, at(14, 10, 0)), path.join(dir, 'WoWScrnShot_102926_141002.tga'));
  assert.strictEqual(screenshots.find(dir, at(14, 20, 0)), path.join(dir, 'WoWScrnShot_102926_142000.png'));
  assert.strictEqual(screenshots.find(dir, at(14, 30, 0)), null, 'not a picture the game makes');
  assert.strictEqual(screenshots.find(dir, at(14, 40, 0)), null, 'empty');
  assert.strictEqual(screenshots.find(dir, at(14, 50, 0)), null, 'too long after');
  assert.strictEqual(screenshots.find(path.join(dir, 'nope'), at(14, 0, 0)), null, 'no such folder');
  assert.strictEqual(screenshots.find(dir, NaN), null);
});
