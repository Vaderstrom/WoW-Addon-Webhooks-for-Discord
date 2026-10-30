'use strict';
// Game versions by name, Forever first, and spotting the chosen game's program.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const wow = require('../src/main/wow');

test('game versions are shown by name, Forever first', () => {
  assert.strictEqual(wow.flavorName('_forever_'), 'WoW Forever');
  assert.strictEqual(wow.flavorName('_retail_'), 'Retail');
  assert.strictEqual(wow.flavorName('_classic_era_'), 'Classic Era');
  assert.strictEqual(wow.flavorName('_some_new_one_'), 'Some New One', 'an unknown folder by its words');
  const root = tmpDir('jtc-wow-');
  for (const f of ['_retail_', '_classic_', '_forever_', '_anniversary_', 'Data']) fs.mkdirSync(path.join(root, f, 'WTF', 'Account', 'ACC'), { recursive: true });
  assert.deepStrictEqual(wow.flavors(root), ['_forever_', '_retail_', '_anniversary_', '_classic_']);
  assert.deepStrictEqual(wow.accounts(root, '_retail_'), ['ACC']);
});

test('the chosen game is running only when its own program in its own folder is', () => {
  const root = 'C:\\Games\\World of Warcraft';
  const retail = 'C:\\Games\\World of Warcraft\\_retail_\\Wow.exe';
  const forever = 'C:\\Games\\World of Warcraft\\_forever_\\Wow.exe';
  const era = 'C:\\Games\\World of Warcraft\\_classic_era_\\WowClassic.exe';
  if (process.platform !== 'win32') return; // paths are Windows paths
  assert.ok(wow.isGameOf([retail], root, '_retail_'));
  assert.ok(!wow.isGameOf([forever], root, '_retail_'), 'another game version');
  assert.ok(wow.isGameOf([era], root, '_classic_era_'));
  assert.ok(!wow.isGameOf(['C:\\Games\\World of Warcraft\\_retail_\\BlizzardError.exe'], root, '_retail_'), 'not the game');
  assert.ok(!wow.isGameOf([], root, '_retail_'));
});
