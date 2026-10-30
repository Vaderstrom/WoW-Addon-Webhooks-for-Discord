'use strict';
// The developer's check (docs/PLUGINS.md §8): its command line and how it finds the game of a SavedVariables file.
// The report itself needs Electron (npm start -- --check <file>).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const check = require('../src/main/check');

test('--check takes a file, and --plugin and --out may follow', () => {
  assert.strictEqual(check.args(['app.exe']), null);
  assert.deepStrictEqual(check.args(['app.exe', '--check', 'C:/x/A.lua', '--plugin', 'C:/p', '--out', 'C:/o']), { file: 'C:/x/A.lua', plugin: 'C:/p', out: 'C:/o' });
  assert.deepStrictEqual(check.args(['app.exe', '--check', '--quit']), { file: null, plugin: null, out: null });
});

test('the game of a SavedVariables file is the WoW folder and version it sits in, or none', () => {
  const wow = tmpDir('awd-check-');
  const sv = path.join(wow, '_retail_', 'WTF', 'Account', 'ACC', 'SavedVariables');
  fs.mkdirSync(sv, { recursive: true });
  fs.mkdirSync(path.join(wow, '_retail_', 'Interface', 'AddOns'), { recursive: true });
  const game = check.gameOf(path.join(sv, 'Addon.lua'));
  assert.strictEqual(game && game.flavor, '_retail_');
  assert.strictEqual(game.wowFolder, wow);
  assert.strictEqual(check.gameOf(path.join(wow, 'Addon.lua')), null);
});
