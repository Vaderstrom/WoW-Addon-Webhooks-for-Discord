'use strict';
// The SavedVariables reader and outboxes, against the sample addon's saved data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const { parse, LuaSyntaxError } = require('../src/main/lua-table');
const outbox = require('../src/main/outbox');
const plugins = require('../src/main/plugins');

const FIXTURES = path.join(__dirname, 'fixtures');
const plugin = plugins.findDataPlugins([path.join(FIXTURES, 'AddOns')])[0].plugin;
const sample = () => fs.readFileSync(path.join(FIXTURES, 'SavedVariables', 'ExampleTracker.lua'), 'latin1');

test('reads the sample outbox: groups, kept entries, news of known kinds, numbers', () => {
  const read = outbox.readText(sample(), plugin);
  assert.ok(!read.error, read.detail);
  const g = read.groups['team-1'];
  assert.strictEqual(g.name, 'The Lanterns');
  assert.strictEqual(g.color, '2FA4A9');
  assert.strictEqual(g.kept.standings.text, 'The Lanterns  ·  3 wins, 1 loss');
  assert.deepStrictEqual(g.kept.standings.data.rows.map((r) => r.name), ['Lea', 'Mira', 'Pata']);
  assert.deepStrictEqual(g.news.map((n) => n.id), ['win:3', 'lvl:lea:20'], 'a kind the plugin does not have is dropped');
  assert.strictEqual(g.news[0].picture, 'Media/Icon.tga');
  assert.strictEqual(g.news[0].screenshot, 1800000001);
  assert.deepStrictEqual(g.news[0].fields, { opponent: 'Gnomes', who: ['Lea', 'Mira'] }, 'only the fields the plugin names');
  assert.strictEqual(g.news[1].fields, null, 'a value of the wrong type is dropped');
  assert.strictEqual(g.news[1].screenshot, null);
  assert.deepStrictEqual(g.numbers, { Lea: 20, Mira: 18 });
  assert.ok(!('settings' in g), 'nothing outside the outbox');
});

test('no outbox yet is no groups; a newer format or a wrong shape is refused', () => {
  assert.deepStrictEqual(outbox.readText('ExampleTrackerDB = { settings = {} }', plugin), { groups: {} });
  assert.strictEqual(outbox.readText('ExampleTrackerDB = { webhooks = { format = 2, groups = {} } }', plugin).error, 'too-new');
  assert.strictEqual(outbox.readText('ExampleTrackerDB = { webhooks = "x" }', plugin).error, 'bad');
  assert.strictEqual(outbox.readText('ExampleTrackerDB = os.exit()', plugin).error, 'unreadable');
  const noName = outbox.readText('ExampleTrackerDB = { webhooks = { format = 1, groups = { g = { saved = 1 } } } }', plugin);
  assert.deepStrictEqual(noName.groups, {}, 'a group without a name is left out');
});

test('a group in two games takes the newer save', () => {
  const root = tmpDir('awd-sv-');
  const write = (flavor, saved, name) => {
    const dir = path.join(root, flavor, 'WTF', 'Account', 'ACC', 'SavedVariables');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ExampleTracker.lua'),
      `ExampleTrackerDB = { webhooks = { format = 1, groups = { g = { name = "${name}", saved = ${saved} } } } }`);
  };
  write('_retail_', 100, 'Old'); write('_forever_', 200, 'New');
  const read = outbox.readSources(root, [{ flavor: '_retail_', account: 'ACC' }, { flavor: '_forever_', account: 'ACC' }], plugin);
  assert.strictEqual(read.groups.g.name, 'New');
  assert.strictEqual(read.from.g.flavor, '_forever_');
  assert.strictEqual(outbox.readSources(root, [{ flavor: '_classic_', account: 'ACC' }], plugin).error, 'missing');
});

test('Lua values: strings, escapes, numbers, booleans, nil, comments, arrays and maps', () => {
  const g = parse([
    '-- a comment',
    'A = { "x", "y", -- [2]',
    '}',
    'B = { ["k"] = "a\\"b\\\\c\\n", n = -1.5e2, t = true, f = false, z = nil, [3] = 7 }',
    '--[[ a block',
    'comment ]]',
    'C = { [1] = "one", [2] = "two" }',
    'D = { [2] = "only two" }',
    'E = "\\195\\164"',
    'F = { news = {}, }',
  ].join('\n'));
  assert.deepStrictEqual(g.F.news, [], 'an empty table is an empty list');
  assert.deepStrictEqual(g.A, ['x', 'y']);
  assert.deepStrictEqual(g.B, { k: 'a"b\\c\n', n: -150, t: true, f: false, 3: 7 });
  assert.deepStrictEqual(g.C, ['one', 'two']);
  assert.deepStrictEqual(g.D, { 2: 'only two' });
  assert.strictEqual(g.E, 'ä');
});

test('UTF-8 names in a file read as bytes; nothing is ever run', () => {
  assert.strictEqual(parse(Buffer.from('X = { name = "Hjältar" }', 'utf8').toString('latin1')).X.name, 'Hjältar');
  for (const bad of ['A = os.execute("x")', 'A = 1 + 2', 'A = function() end', 'A = { b = c }', 'A = "open', 'A = { 1, 2']) {
    assert.throws(() => parse(bad), LuaSyntaxError, bad);
  }
});
