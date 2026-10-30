'use strict';
// The settings: what is taken from the Journey Together Companion (SPEC §9), the choices from before as lines (§5.1),
// and lines, rules and channels as the window sets them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp');
const { createSettings, fromCompanion } = require('../src/main/settings');

const keys = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };

test('the Companion\'s game folder and choices are taken; its channels are not', () => {
  // The oldest Companion settings: one game.
  assert.deepStrictEqual(fromCompanion({ wowFolder: 'C:\\WoW', flavor: '_retail_', account: 'ACC', webhook: null, startWithWindows: true }),
    { wowFolder: 'C:\\WoW', sources: [{ flavor: '_retail_', account: 'ACC' }], startWithWindows: true, notices: true });
  // Later ones: several games, channels with encrypted URLs (left behind).
  const later = fromCompanion({ wowFolder: 'D:\\Games\\WoW', sources: [{ flavor: '_forever_', account: 'A' }, { flavor: 1 }],
    notices: false, startWithWindows: false, channels: [{ webhook: 'djEw...' }] });
  assert.deepStrictEqual(later, { wowFolder: 'D:\\Games\\WoW', sources: [{ flavor: '_forever_', account: 'A' }], startWithWindows: false, notices: false });
  assert.ok(!('channels' in later));
  for (const nothing of [null, [], 'x', {}, { wowFolder: '' }]) assert.strictEqual(fromCompanion(nothing), null);
});

test('settings know when they are new', () => {
  const dir = tmpDir('awd-settings-');
  const s = createSettings(dir, keys);
  assert.strictEqual(s.isNew, true);
  s.set({ wowFolder: 'C:\\WoW' });
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.strictEqual(createSettings(dir, keys).isNew, false);
});

const kindsOf = { board: { type: 'kept' }, chapter: { type: 'news', mention: true }, clear: { type: 'news' } };
function withFile(json) {
  const dir = tmpDir('awd-settings-');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(json));
  return createSettings(dir, keys);
}

test('the channels\' ticks from before flows (W1–W2) become lines once, with the role as the mention', () => {
  const s = withFile({ channels: [{
    id: 'c1', name: '#all', webhook: 'x', since: 100, posted: ['p|g|n1'], groupSince: { 'p|g': 150 },
    messages: { 'p|g|board': { messageId: '9', saved: 120, name: 'Iron Oath' } },
    follow: { p: { kinds: { board: true, chapter: true, clear: true }, groups: ['g'], role: '123456789012', since: { clear: 200 } } },
  }] });
  assert.ok(s.migrate((pid, k) => kindsOf[k]));
  assert.deepStrictEqual(s.lines().map((l) => [l.from, l.to, l.since, l.mention, l.only, l.gather]), [
    ['k:p|g|board', 'c:c1', 150, null, null, false],
    ['k:p|g|chapter', 'c:c1', 150, { role: '123456789012', name: '' }, null, false],
    ['k:p|g|clear', 'c:c1', 200, null, null, false],
  ]);
  assert.deepStrictEqual(s.message('c1', 'p', 'g', 'board', ''), { messageId: '9', saved: 120, name: 'Iron Oath' }, 'its kept message stays');
  const c = s.channels()[0];
  assert.ok(!('follow' in c));
  assert.deepStrictEqual([c.quiet, c.digest, c.threads], [null, { every: 'day', at: '21:00' }, []]);
  assert.strictEqual(s.migrate(() => null), false, 'once');
  assert.strictEqual(s.lines().length, 3);
});

test('the step boxes of W3–W4 become lines once; the channel takes their times and threads', () => {
  const s = withFile({ flows: 1, nextLine: 9, channels: [{ id: 'c1', name: '#all', webhook: 'x', since: 100, posted: [], messages: {} }],
    steps: [{ id: 'm', type: 'mention', options: { role: '123456789012' } }, { id: 'q', type: 'quiet', options: { from: '22:00', to: '07:00' } },
      { id: 't', type: 'thread', options: { thread: '2222222222' } }, { id: 'd', type: 'digest', options: { every: 'hour', at: '21:00' } }],
    lines: [{ from: 'k:p|*|chapter', to: 's:m', n: 1, since: 10 }, { from: 's:m', to: 's:q', n: 2, since: 0 }, { from: 's:q', to: 'c:c1', n: 3, since: 0 },
      { from: 'k:p|*|clear', to: 's:d', n: 4, since: 20 }, { from: 's:d', to: 's:t', n: 5, since: 0 }, { from: 's:t', to: 'c:c1', n: 6, since: 0 }],
    places: { 's:m': { x: 1, y: 2 } }, quietWas: { q: true } });
  assert.ok(s.migrate((pid, k) => kindsOf[k], 'Tråd'));
  assert.deepStrictEqual(s.lines().map((l) => [l.from, l.to, l.n, l.since, l.mention && l.mention.role, l.gather]), [
    ['k:p|*|chapter', 'c:c1', 9, 10, '123456789012', false],
    ['k:p|*|clear', 't:c1:2222222222', 10, 20, null, true],
  ]);
  const c = s.channels()[0];
  assert.deepStrictEqual([c.quiet, c.digest, c.threads], [{ from: '22:00', to: '07:00' }, { every: 'hour', at: '21:00' }, [{ id: '2222222222', name: 'Tråd' }]]);
  assert.strictEqual(s.get('steps'), undefined);
  assert.strictEqual(s.get('places'), undefined);
  assert.strictEqual(s.get('flows'), 2);
  assert.strictEqual(s.migrate(() => null), false, 'once');
});

test('lines and their rules; a channel\'s quiet hours, daily post and threads', () => {
  const s = createSettings(tmpDir('awd-settings-'), keys);
  const id = s.addChannel('#events', 'https://discord.com/api/webhooks/1/x', 100);
  assert.deepStrictEqual(s.channels()[0].digest, { every: 'day', at: '21:00' });
  assert.ok(s.addLine('k:p|*|chapter', 'c:' + id, 200));
  assert.ok(!s.addLine('k:p|*|chapter', 'c:' + id, 300), 'not twice');
  // Rules: a rule left out stays; null turns it off; an Only when that changes starts from then.
  assert.ok(s.setLine('k:p|*|chapter', 'c:' + id, { only: { field: 'n', op: 'min', value: '5' } }, 400));
  assert.ok(s.setLine('k:p|*|chapter', 'c:' + id, { mention: { role: '123456789012', name: '@Fellowship' }, gather: true }, 500));
  let l = s.lines()[0];
  assert.deepStrictEqual([l.only, l.onlySince, l.mention, l.gather], [{ field: 'n', op: 'min', value: '5' }, 400, { role: '123456789012', name: 'Fellowship' }, true]);
  s.setLine('k:p|*|chapter', 'c:' + id, { only: null }, 600);
  l = s.lines()[0];
  assert.deepStrictEqual([l.only, l.onlySince, l.gather], [null, 600, true]);
  assert.ok(!s.setLine('k:p|*|clear', 'c:' + id, { gather: true }, 0), 'no such line');

  // Quiet hours start at 23:00 to 08:00; a new daily time moves what was gathered.
  s.setPending([{ type: 'digest', channel: id, due: 1 }, { type: 'digest', channel: 'other', due: 1 }]);
  s.setChannel(id, { quiet: {} });
  assert.deepStrictEqual(s.channels()[0].quiet, { from: '23:00', to: '08:00' });
  s.setChannel(id, { quiet: { to: '09:30' } });
  assert.deepStrictEqual(s.channels()[0].quiet, { from: '23:00', to: '09:30' });
  const at = Math.floor(new Date(2026, 9, 29, 10, 0).getTime() / 1000);
  s.setChannel(id, { digest: { at: '18:00' } }, at);
  assert.deepStrictEqual(s.channels()[0].digest, { every: 'day', at: '18:00' });
  assert.deepStrictEqual(s.pending().map((p) => p.due), [Math.floor(new Date(2026, 9, 29, 18, 0).getTime() / 1000), 1]);
  s.setChannel(id, { quiet: null });
  assert.strictEqual(s.channels()[0].quiet, null);

  // Threads: from a link, once each, and they go with their lines.
  assert.strictEqual(s.addThread(id, 'https://discord.com/channels/111111111/2222222222', ' Raid nights '), '2222222222');
  assert.strictEqual(s.addThread(id, '2222222222', 'Again'), null, 'not twice');
  assert.strictEqual(s.addThread(id, 'not a link', 'x'), null);
  assert.ok(s.renameThread(id, '2222222222', 'Raids'));
  assert.deepStrictEqual(s.channels()[0].threads, [{ id: '2222222222', name: 'Raids' }]);
  assert.deepStrictEqual(s.all().channels[0].threads, [{ id: '2222222222', name: 'Raids' }], 'the window sees them');
  s.addLine('k:p|*|clear', 't:' + id + ':2222222222', 700);
  assert.ok(s.removeThread(id, '2222222222'));
  assert.deepStrictEqual(s.lines().map((x) => x.to), ['c:' + id]);
  // A channel goes with its threads and lines.
  s.addThread(id, '3333333333', 'x');
  s.addLine('k:p|*|clear', 't:' + id + ':3333333333', 800);
  assert.ok(s.removeChannel(id));
  assert.deepStrictEqual(s.lines(), []);
});
