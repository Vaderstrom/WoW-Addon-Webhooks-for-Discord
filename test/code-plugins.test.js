'use strict';
// Code plugins (SPEC §3, §6; docs/PLUGINS.md §7): the .zip read and checked before the warning, installed and removed
// in the app's own folder, and their scripts' outboxes. The sandbox itself needs Electron: src/dev/check-scripts.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const { makeZip, folderFiles } = require('./make-zip');
const { readZip } = require('../src/main/zip');
const install = require('../src/main/install');
const plugins = require('../src/main/plugins');
const outbox = require('../src/main/outbox');
const { createScripts } = require('../src/main/scripts');

const SAMPLE = path.join(__dirname, 'fixtures', 'code', 'simple-scores');
const SV = path.join(__dirname, 'fixtures', 'SavedVariables', 'SimpleScores.lua');
const manifest = () => JSON.parse(fs.readFileSync(path.join(SAMPLE, 'webhooks.json'), 'utf8'));
function zipFile(dir, files, opts) {
  const f = path.join(dir, 'p' + Math.random().toString(36).slice(2) + '.zip');
  fs.writeFileSync(f, makeZip(files, opts));
  return f;
}

test('a zip is read whole: stored and deflated files, folders left out; a broken one is refused', () => {
  const files = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.js': 'x'.repeat(5000) }));
  assert.deepStrictEqual([...files.keys()], ['a.txt', 'dir/b.js']);
  assert.strictEqual(files.get('dir/b.js').length, 5000);
  assert.strictEqual(readZip(makeZip({ 'a.txt': 'hello' }, { store: true })).get('a.txt').toString(), 'hello');
  const good = makeZip({ 'a.txt': 'hello world' }, { store: true });
  const flipped = Buffer.from(good); flipped[30 + 5] ^= 1; // a byte of the file: its checksum no longer matches
  for (const bad of [Buffer.from('not a zip at all, not at all'), good.subarray(0, good.length - 30), flipped,
    makeZip({ 'a.txt': 'x' }, { flags: 1 })]) assert.throws(() => readZip(bad), /zip|bad|encrypted/);
  assert.throws(() => readZip(makeZip({ 'a': '1', 'b': '2', 'c': '3' }), { maxFiles: 2 }), /too many/);
  assert.throws(() => readZip(makeZip({ 'a': 'x'.repeat(2000) }), { maxTotal: 1000 }), /too big/);
});

test('a code plugin\'s manifest names its script and its addon; a data plugin may not have one', () => {
  const ok = plugins.checkManifest(manifest(), '/x', { code: true }).plugin;
  assert.strictEqual(ok.source, 'code');
  assert.strictEqual(ok.script, 'plugin.js');
  assert.strictEqual(ok.for, 'SimpleScores');
  assert.strictEqual(ok.outbox, null);
  assert.strictEqual(plugins.checkManifest(manifest(), '/x').problem, 'bad', 'found in an addon: a script is refused');
  const cases = [[{ script: undefined }, 'not-code'], [{ script: '../x.js' }, 'bad'], [{ script: 'plugin.lua' }, 'bad'],
    [{ for: undefined }, 'bad'], [{ for: '../WoW' }, 'bad'], [{ copies: {} }, 'bad'], [{ contract: 2 }, 'too-new']];
  for (const [change, problem] of cases) {
    assert.strictEqual(plugins.checkManifest({ ...manifest(), ...change }, '/x', { code: true }).problem, problem, JSON.stringify(change));
  }
});

test('a plugin .zip is checked before the warning: its manifest, its script, its file names', () => {
  const dir = tmpDir('awd-zip-');
  const files = folderFiles(SAMPLE);
  const looked = install.look(zipFile(dir, files));
  assert.strictEqual(looked.plugin.id, 'simple-scores');
  assert.deepStrictEqual([...looked.files.keys()].sort(), ['plugin.js', 'webhooks.json']);
  // A zipped folder (Windows' Send to → Compressed folder), with what a Mac adds.
  const folder = install.look(zipFile(dir, { ...folderFiles(SAMPLE, 'simple-scores/'), '__MACOSX/simple-scores/._plugin.js': 'x' }));
  assert.deepStrictEqual([...folder.files.keys()].sort(), ['plugin.js', 'webhooks.json']);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'AddOns', 'ExampleTracker', 'Webhooks', 'webhooks.json'), 'utf8'));
  const cases = [
    [{ 'readme.txt': 'hi' }, 'no-manifest'],
    [{ 'webhooks.json': JSON.stringify(data) }, 'not-code'],
    [{ 'webhooks.json': '{ nope' }, 'bad'],
    [{ 'webhooks.json': JSON.stringify(manifest()) }, 'bad'], // no plugin.js
    [{ ...files, '../evil.js': 'x' }, 'bad'],
    [{ ...files, 'C:/evil.js': 'x' }, 'bad'],
  ];
  for (const [f, problem] of cases) assert.strictEqual(install.look(zipFile(dir, f)).problem, problem, Object.keys(f).join());
  fs.writeFileSync(path.join(dir, 'x.zip'), 'not a zip');
  assert.strictEqual(install.look(path.join(dir, 'x.zip')).problem, 'not-zip');
  assert.strictEqual(install.look(path.join(dir, 'missing.zip')).problem, 'not-zip');
});

test('installed in the app\'s folder, found there with its folder, replaced by a newer file, and removed', () => {
  const dir = tmpDir('awd-inst-'), pluginsDir = path.join(dir, 'plugins'), stateDir = path.join(dir, 'plugin-data');
  install.install(pluginsDir, install.look(zipFile(dir, folderFiles(SAMPLE))));
  let found = plugins.findCodePlugins(pluginsDir);
  assert.deepStrictEqual(found.map((f) => [f.id, f.addon, f.folder, f.plugin.version]), [['simple-scores', 'SimpleScores', 'simple-scores', '1.0.0']]);
  assert.strictEqual(found[0].plugin.dir, path.join(pluginsDir, 'simple-scores'));
  // A newer file: the old one's files go.
  const next = { 'webhooks.json': JSON.stringify({ ...manifest(), version: '1.1.0', script: 'main.js' }), 'main.js': 'export default () => null;' };
  install.install(pluginsDir, install.look(zipFile(dir, next)));
  found = plugins.findCodePlugins(pluginsDir);
  assert.strictEqual(found[0].plugin.version, '1.1.0');
  assert.deepStrictEqual(fs.readdirSync(path.join(pluginsDir, 'simple-scores')).sort(), ['main.js', 'webhooks.json']);
  assert.deepStrictEqual(fs.readdirSync(pluginsDir), ['simple-scores'], 'nothing left over from the swap');
  // A folder someone changed by hand: listed with its problem, and Remove still takes it out.
  fs.writeFileSync(path.join(pluginsDir, 'simple-scores', 'webhooks.json'), JSON.stringify({ ...manifest(), id: 'other' }));
  assert.deepStrictEqual(plugins.findCodePlugins(pluginsDir).map((f) => [f.id, f.folder, f.problem]), [[null, 'simple-scores', 'bad']]);
  fs.mkdirSync(path.join(stateDir, 'simple-scores'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'simple-scores', 'last.json'), '{}');
  assert.strictEqual(install.remove(pluginsDir, stateDir, 'simple-scores'), true);
  assert.deepStrictEqual(fs.readdirSync(pluginsDir), []);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'simple-scores')), false, 'what its script kept goes too');
  assert.strictEqual(install.remove(pluginsDir, stateDir, 'simple-scores'), false);
  assert.strictEqual(install.remove(pluginsDir, stateDir, '../plugins'), false);
});

// The scripts' outboxes, with a stand-in for the sandbox that runs the sample in Node.
async function sample(input) {
  // (As data: Node would warn that the file is a module without a package.json saying so.)
  const { default: build } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(SAMPLE, 'plugin.js'), 'utf8')));
  return { json: JSON.stringify(build(input.saved, input.last, input.ctx)) };
}

test('a script runs when its saved data changed, gets what it returned last, and its outbox is checked', async () => {
  const dir = tmpDir('awd-scripts-');
  const sv = path.join(dir, 'SimpleScores.lua');
  fs.copyFileSync(SV, sv);
  const runs = [];
  const run = (plugin, input) => { runs.push(input); return sample(input); };
  const p = plugins.checkManifest(manifest(), SAMPLE, { code: true }).plugin;
  const s = { flavor: '_retail_', account: 'ACC' };
  let scripts = createScripts({ run, stateDir: path.join(dir, 'state'), now: () => 1800000100 });
  assert.deepStrictEqual(scripts.result(p, s), { error: 'missing' }, 'before it ran');
  await scripts.refresh([p], [s], () => sv);
  await scripts.refresh([p], [s], () => sv);
  assert.strictEqual(runs.length, 1, 'the file did not change: not run again');
  assert.strictEqual(runs[0].last, null);
  assert.deepStrictEqual(runs[0].ctx, { now: 1800000100 });
  assert.strictEqual(runs[0].saved.SimpleScoresDB.characters['Lea-Firemaw'].level, 20, 'the whole saved file, parsed');
  let r = outbox.readSources('/wow', [s], p, (_f, pl, src) => scripts.result(pl, src));
  assert.deepStrictEqual(Object.keys(r.groups), ['scores']);
  assert.strictEqual(r.groups.scores.kept.scores.text, 'Lea: level 20, 152 kills\nMira: level 18, 97 kills');
  assert.deepStrictEqual(r.groups.scores.news, []);
  assert.strictEqual(r.groups.scores.levels, undefined, 'what the app does not know is not used');

  // Lea gains a level: the script sees the levels it kept last time (from disk, after a restart) and posts it.
  fs.writeFileSync(sv, fs.readFileSync(SV, 'utf8').replace('["level"] = 20', '["level"] = 21'));
  fs.utimesSync(sv, new Date(), new Date(Date.now() + 5000));
  scripts = createScripts({ run, stateDir: path.join(dir, 'state'), now: () => 1800000200 });
  await scripts.refresh([p], [s], () => sv);
  assert.strictEqual(runs.length, 2);
  assert.deepStrictEqual(runs[1].last.groups.scores.levels, { 'Lea-Firemaw': 20, 'Mira-Firemaw': 18 });
  r = outbox.readSources('/wow', [s], p, (_f, pl, src) => scripts.result(pl, src));
  assert.deepStrictEqual(r.groups.scores.news.map((n) => [n.id, n.kind, n.text, n.fields]),
    [['level:Lea-Firemaw:21', 'level', 'Lea reached level 21!', { level: 21, who: ['Lea'] }]]);
  assert.strictEqual(scripts.problem(p.id), null);
});

test('a script that is stopped or gives back no outbox posts nothing from that file, and says why', async () => {
  const dir = tmpDir('awd-scripts-');
  const sv = path.join(dir, 'SimpleScores.lua');
  fs.copyFileSync(SV, sv);
  const p = plugins.checkManifest(manifest(), SAMPLE, { code: true }).plugin;
  const s = { flavor: '_retail_', account: 'ACC' };
  let answer = { problem: 'network', detail: 'example.com' };
  const scripts = createScripts({ run: async () => answer, stateDir: path.join(dir, 'state'), now: () => 0 });
  await scripts.refresh([p], [s], () => sv);
  assert.deepStrictEqual(scripts.result(p, s), { error: 'script' });
  assert.deepStrictEqual(scripts.problem(p.id), { problem: 'network', detail: 'example.com' });
  assert.deepStrictEqual(outbox.readSources('/wow', [s], p, (_f, pl, src) => scripts.result(pl, src)), { error: 'script' });
  // Look again runs it again; an answer that is not an outbox is refused like a broken addon's.
  for (const [json, detail] of [['{ nope', 'not JSON'], ['{"format":"one"}', 'not an outbox'], ['{"format":9,"groups":{}}', 'format']]) {
    answer = { json };
    scripts.retry();
    await scripts.refresh([p], [s], () => sv);
    assert.deepStrictEqual(scripts.problem(p.id), { problem: 'bad', detail }, json);
  }
  answer = { json: 'null' };
  scripts.retry();
  await scripts.refresh([p], [s], () => sv);
  assert.deepStrictEqual(scripts.result(p, s), { groups: {} }, 'null: nothing to post');
  assert.strictEqual(scripts.problem(p.id), null);
  // The saved data gone (the game version unticked, the file deleted): nothing kept for it.
  fs.rmSync(sv);
  await scripts.refresh([p], [s], () => sv);
  assert.deepStrictEqual(scripts.result(p, s), { error: 'missing' });
  // A file that is not saved data is never handed to the script.
  fs.writeFileSync(sv, 'os.execute("calc")');
  let ran = false;
  const strict = createScripts({ run: async () => { ran = true; return { json: 'null' }; }, stateDir: path.join(dir, 'state'), now: () => 0 });
  await strict.refresh([p], [s], () => sv);
  assert.strictEqual(ran, false);
  assert.deepStrictEqual(strict.result(p, s), { error: 'unreadable' });
});
