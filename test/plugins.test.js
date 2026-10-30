'use strict';
// Finding data plugins and checking their manifests: untrusted input, refused with a reason, never half used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const plugins = require('../src/main/plugins');

const ADDONS = path.join(__dirname, 'fixtures', 'AddOns');
const good = () => JSON.parse(fs.readFileSync(path.join(ADDONS, 'ExampleTracker', 'Webhooks', 'webhooks.json'), 'utf8'));

test('finds the sample addon\'s plugin and reads its manifest', () => {
  const found = plugins.findDataPlugins([ADDONS]);
  assert.strictEqual(found.length, 1);
  const p = found[0].plugin;
  assert.strictEqual(found[0].addon, 'ExampleTracker');
  assert.strictEqual(p.id, 'example-tracker');
  assert.deepStrictEqual(p.outbox, ['ExampleTrackerDB', 'webhooks']);
  assert.deepStrictEqual(p.kinds.map((k) => [k.id, k.type, k.default, k.mention]),
    [['standings', 'kept', true, false], ['win', 'news', true, false], ['level', 'news', false, true]]);
  assert.deepStrictEqual(p.templates, { standings: { file: 'card.html', width: 1000 } });
  assert.strictEqual(p.source, 'data');
  assert.strictEqual(p.empty, null);
  assert.deepStrictEqual(p.kinds.map((k) => (k.fields || []).map((f) => f.id + ':' + f.type)), [[], ['opponent:text', 'who:names'], ['level:number']],
    'the fields Only if may test, on their kinds');
});

test('a manifest may say why its outbox is empty', () => {
  const dir = tmpDir('awd-empty-');
  const m = JSON.parse(fs.readFileSync(path.join(ADDONS, 'ExampleTracker', 'Webhooks', 'webhooks.json'), 'utf8'));
  m.empty = 'Join a team first.';
  fs.mkdirSync(path.join(dir, 'ExampleTracker', 'Webhooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ExampleTracker', 'Webhooks', 'webhooks.json'), JSON.stringify(m));
  assert.strictEqual(plugins.findDataPlugins([dir])[0].plugin.empty, 'Join a team first.');
  m.empty = 'x'.repeat(201);
  fs.writeFileSync(path.join(dir, 'ExampleTracker', 'Webhooks', 'webhooks.json'), JSON.stringify(m));
  assert.strictEqual(plugins.findDataPlugins([dir])[0].problem, 'bad');
});

test('a manifest from a newer contract, or broken, is refused with a reason', () => {
  const cases = [
    [{ contract: 2 }, 'too-new'],
    [{ id: 'Bad Id' }, 'bad'],
    [{ savedVariables: '../x' }, 'bad'],
    [{ outbox: 'os.execute()' }, 'bad'],
    [{ kinds: [] }, 'bad'],
    [{ kinds: [{ id: 'weekly', type: 'news', name: 'x' }] }, 'bad'],
    [{ kinds: [{ id: 'a', type: 'kept', name: 'x' }, { id: 'a', type: 'news', name: 'y' }] }, 'bad'],
    [{ templates: { standings: '../../evil.html' } }, 'bad'],
    [{ templates: { standings: 'Media/x.html' } }, 'bad'],
    [{ templates: { nope: 'card.html' } }, 'bad'],
    [{ script: 'plugin.js' }, 'bad'],
    [{ fields: { standings: [{ id: 'n', name: 'N', type: 'number' }] } }, 'bad'],
    [{ fields: { nope: [{ id: 'n', name: 'N', type: 'number' }] } }, 'bad'],
    [{ fields: { win: [{ id: 'n', name: 'N', type: 'date' }] } }, 'bad'],
    [{ fields: { win: [{ id: 'n', name: 'N', type: 'number' }, { id: 'n', name: 'M', type: 'text' }] } }, 'bad'],
    [{ fields: { win: [{ id: '1x', name: 'N', type: 'number' }] } }, 'bad'],
    [{ fields: { win: [{ id: 'n', type: 'number' }] } }, 'bad'],
    [{ fields: { win: Array.from({ length: 7 }, (_, i) => ({ id: 'f' + i, name: 'F', type: 'text' })) } }, 'bad'],
    [{ fields: [] }, 'bad'],
    [{ copies: { 'Example-Dev': { savedVariables: 'Example-Dev' } } }, 'bad'],
    [{ copies: { '../Evil': { savedVariables: 'Evil', outbox: 'EvilDB.webhooks' } } }, 'bad'],
    [{ copies: { 'Example-Dev': { savedVariables: '-x', outbox: 'ExampleDevDB.webhooks' } } }, 'bad'],
    [{ copies: ['Example-Dev'] }, 'bad'],
  ];
  for (const [patch, want] of cases) {
    const res = plugins.checkManifest({ ...good(), ...patch }, 'X');
    assert.strictEqual(res.problem, want, JSON.stringify(patch) + ' ' + res.detail);
    assert.ok(!res.plugin);
  }
  assert.ok(plugins.checkManifest(good(), 'X').plugin);
});

test('a broken plugin is listed with its problem; the same plugin in two games is found once', () => {
  const root = tmpDir('awd-plugins-');
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  for (const dir of [a, b]) {
    fs.mkdirSync(path.join(dir, 'Good', 'Webhooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Good', 'Webhooks', 'webhooks.json'), JSON.stringify(good()));
  }
  fs.mkdirSync(path.join(a, 'Broken', 'Webhooks'), { recursive: true });
  fs.writeFileSync(path.join(a, 'Broken', 'Webhooks', 'webhooks.json'), '{ not json');
  fs.mkdirSync(path.join(a, 'NoPlugin'));
  const found = plugins.findDataPlugins([a, b]);
  assert.deepStrictEqual(found.map((f) => [f.addon, f.id, f.problem || null]), [['Broken', null, 'bad'], ['Good', 'example-tracker', null]]);
  assert.ok(found[1].plugin.dir.startsWith(a), 'the first game\'s copy');
});

test('a copy of the addon in another folder (a development copy) reads the saved data its manifest names for it', () => {
  const root = tmpDir('awd-plugins-');
  const m = { ...good(), copies: { 'ExampleTracker-Dev': { savedVariables: 'ExampleTracker-Dev', outbox: 'ExampleTrackerDevDB.webhooks' } } };
  for (const folder of ['ExampleTracker-Dev', 'Other']) {
    fs.mkdirSync(path.join(root, folder, 'Webhooks'), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'Webhooks', 'webhooks.json'), JSON.stringify(m));
  }
  const [dev] = plugins.findDataPlugins([root]);
  assert.deepStrictEqual([dev.addon, dev.plugin.savedVariables, dev.plugin.outbox], ['ExampleTracker-Dev', 'ExampleTracker-Dev', ['ExampleTrackerDevDB', 'webhooks']]);
  // In a folder it does not name, the manifest's own.
  fs.rmSync(path.join(root, 'ExampleTracker-Dev'), { recursive: true });
  const [other] = plugins.findDataPlugins([root]);
  assert.deepStrictEqual([other.addon, other.plugin.savedVariables, other.plugin.outbox], ['Other', 'ExampleTracker', ['ExampleTrackerDB', 'webhooks']]);
});

test('an addon folder that is a link (a junction, as developers link a repository) is found', () => {
  const root = tmpDir('awd-plugins-');
  fs.symlinkSync(path.join(ADDONS, 'ExampleTracker'), path.join(root, 'ExampleTracker'), 'junction');
  const found = plugins.findDataPlugins([root]);
  assert.deepStrictEqual(found.map((f) => [f.addon, f.id]), [['ExampleTracker', 'example-tracker']]);
  assert.ok(plugins.filePath(found[0].plugin, 'Media/Icon.tga'), 'its Media through the link');
});

test('a plugin\'s files: only inside its folder, or Media in its addon', () => {
  const p = plugins.findDataPlugins([ADDONS])[0].plugin;
  assert.ok(plugins.filePath(p, 'card.html').endsWith(path.join('Webhooks', 'card.html')));
  assert.ok(plugins.filePath(p, 'Media/Icon.tga').endsWith(path.join('ExampleTracker', 'Media', 'Icon.tga')));
  for (const bad of ['../webhooks.json', '../../ExampleTracker/Media/Icon.tga', 'C:/Windows/win.ini', '/etc/passwd', 'a//b', 'missing.png', 'Media/../Webhooks/card.html']) {
    assert.strictEqual(plugins.filePath(p, bad), null, bad);
  }
});
