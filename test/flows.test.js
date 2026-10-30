'use strict';
// The rules of flows (SPEC §5.1, §5.2): which lines may be drawn, the routes they make, a line's rules as steps, the
// clocks, and the step boxes of W3–W4 made into lines.
const test = require('node:test');
const assert = require('node:assert');
const flows = require('../src/main/flows');

const kinds = {
  board: { id: 'board', name: 'Progress board', type: 'kept' },
  chapter: { id: 'chapter', name: 'Chapter complete', type: 'news', mention: true, fields: [{ id: 'n', name: 'Chapter', type: 'number' }] },
  clear: { id: 'clear', name: 'Dungeon cleared', type: 'news', fields: [{ id: 'who', name: 'Who', type: 'names' }] },
  weekly: { id: 'weekly', name: 'Weekly summary', type: 'news', weekly: true },
};
const kindOf = (b) => kinds[flows.parseBox(b).kind] || null;
const K = (kind, gid = '*') => flows.kindBox('jt', gid, kind);
const C = (id) => flows.channelBox(id);
const T = (id, tid) => flows.threadBox(id, tid);
const line = (from, to, n, more) => ({ from, to, n, since: 0, only: null, onlySince: 0, mention: null, gather: false, ...more });
function ctx(lines) {
  const places = new Set([C('progress'), C('events'), T('events', '2222222222')]);
  return { lines: lines.map(([from, to], i) => line(from, to, i + 1)), kindOf, hasPlace: (b) => places.has(b) };
}

test('boxes: kinds, channels and threads, and nothing else', () => {
  assert.deepStrictEqual(flows.parseBox(K('chapter', 'g1')), { type: 'kind', pid: 'jt', gid: 'g1', kind: 'chapter' });
  assert.deepStrictEqual(flows.parseBox(C('progress')), { type: 'channel', channel: 'progress', thread: null });
  assert.deepStrictEqual(flows.parseBox(T('events', '2222222222')), { type: 'thread', channel: 'events', thread: '2222222222' });
  assert.deepStrictEqual(flows.placeOf(T('events', '2222222222')), { channel: 'events', thread: '2222222222' });
  for (const bad of ['s:abc', 'c:', 't:events', 'k:jt|g', 'x']) assert.strictEqual(flows.placeOf(bad), null, bad);
});

test('lines: from a kind to a place, once', () => {
  const c = ctx([[K('chapter'), C('progress')]]);
  assert.strictEqual(flows.check(c, K('clear'), C('events')), null);
  assert.strictEqual(flows.check(c, K('clear'), T('events', '2222222222')), null, 'to a thread');
  assert.strictEqual(flows.check(c, K('chapter'), C('progress')).problem, 'twice');
  assert.strictEqual(flows.check(c, C('progress'), C('events')).problem, 'bad', 'not out of a channel');
  assert.strictEqual(flows.check(c, C('events'), K('clear')).problem, 'bad', 'not into a kind');
  assert.strictEqual(flows.check(c, K('nope'), C('events')).problem, 'bad');
  assert.strictEqual(flows.check(c, K('clear'), C('gone')).problem, 'bad');
  assert.strictEqual(flows.check(c, K('clear'), T('events', '999999999')).problem, 'bad', 'a thread not added');
  // Send to… offers each place it has no line to yet.
  const tos = [C('progress'), C('events'), T('events', '2222222222')];
  assert.deepStrictEqual(flows.allowed(c, K('chapter'), tos), [C('events'), T('events', '2222222222')]);
  assert.deepStrictEqual(flows.allowed(c, K('board'), tos), tos, 'any kind may go anywhere: rules are on the line');
});

test('which rules a kind takes', () => {
  const t = (rule, k) => flows.takes(rule, kinds[k]);
  assert.ok(t('only', 'chapter') && t('only', 'clear') && !t('only', 'board') && !t('only', 'weekly'));
  assert.ok(t('mention', 'chapter') && !t('mention', 'clear') && !t('mention', 'board') && !t('mention', 'weekly'));
  assert.ok(t('gather', 'chapter') && t('gather', 'clear') && !t('gather', 'board') && !t('gather', 'weekly'));
  assert.ok(!flows.takes('only', null));
});

test('a line\'s rules become its steps, in order, with ids that find what they hold again', () => {
  const ch = { id: 'events', quiet: { from: '23:00', to: '08:00' }, digest: { every: 'day', at: '21:00' } };
  const all = line(K('chapter'), T('events', '2222222222'), 7, {
    only: { field: 'n', op: 'min', value: '5' }, onlySince: 50, mention: { role: '123456789012', name: 'Fellowship' }, gather: true });
  assert.deepStrictEqual(flows.stepsOf(all, ch, kinds.chapter).map((s) => [s.id, s.type]), [
    ['o7', 'only'], ['m7', 'mention'], ['dt:events:2222222222', 'digest'], ['qevents', 'quiet'], ['th2222222222', 'thread'],
  ]);
  assert.strictEqual(flows.stepsOf(all, ch, kinds.chapter)[0].since, 50, 'Only when counts from when it was set');
  assert.deepStrictEqual(flows.stepsOf(all, ch, kinds.chapter)[2].options, ch.digest, 'the daily post at the channel\'s time');
  // A rule its kind cannot take is left out; a mention with no role yet does nothing.
  const kept = line(K('board'), C('events'), 8, { only: { field: 'n', op: 'min', value: '5' }, mention: { role: '123456789012' }, gather: true });
  assert.deepStrictEqual(flows.stepsOf(kept, ch, kinds.board).map((s) => s.type), ['quiet']);
  const noRole = line(K('chapter'), C('progress'), 9, { mention: { role: '', name: 'x' } });
  assert.deepStrictEqual(flows.stepsOf(noRole, { id: 'progress', quiet: null, digest: ch.digest }, kinds.chapter), []);
  assert.deepStrictEqual(flows.stepsOf(all, null, kinds.chapter), [], 'no channel');
  // Two lines that gather into one place share its daily post; into the channel itself it is another.
  const other = line(K('clear'), T('events', '2222222222'), 10, { gather: true });
  assert.strictEqual(flows.stepsOf(other, ch, kinds.clear)[0].id, 'dt:events:2222222222');
  assert.strictEqual(flows.stepsOf(line(K('clear'), C('events'), 11, { gather: true }), ch, kinds.clear)[0].id, 'dc:events');
});

test('routes: Every covers each group, the line drawn first wins per channel, a thread counts as its channel', () => {
  const lines = [
    line(K('chapter'), C('progress'), 1, { since: 10 }),
    line(K('chapter', 'g1'), C('progress'), 2, { mention: { role: '123456789012' } }),
    line(K('clear'), T('progress', '2222222222'), 3),
    line(K('clear', 'g2'), C('progress'), 4),
    line(K('board', 'gone'), C('events'), 5),
  ];
  const rs = flows.routes(lines, () => ['g1', 'g2'], kindOf);
  assert.deepStrictEqual(rs.map((r) => [r.kind, r.gid, r.channel, r.thread, r.shadowed, r.missing]), [
    ['chapter', 'g1', 'progress', null, false, false],
    ['chapter', 'g2', 'progress', null, false, false],
    ['chapter', 'g1', 'progress', null, true, false],
    ['clear', 'g1', 'progress', '2222222222', false, false],
    ['clear', 'g2', 'progress', '2222222222', false, false],
    ['clear', 'g2', 'progress', null, true, false],
    ['board', 'gone', 'events', null, false, true],
  ]);
  assert.deepStrictEqual(flows.routes(lines, () => null, kindOf), [], 'a plugin whose data could not be read has no routes');
});

test('Only when: a route with it never stands in for another', () => {
  const lea = { field: 'who', op: 'has', value: 'Lea' };
  // Clears with Lea to #events (drawn first), with Pata (drawn second, for one group), then all clears: each counts.
  const lines = [line(K('clear'), C('events'), 1, { only: lea }), line(K('clear', 'g'), C('events'), 2, { only: { ...lea, value: 'Pata' } }),
    line(K('clear', 'g'), T('events', '2222222222'), 3), line(K('clear'), C('progress'), 4)];
  assert.deepStrictEqual(flows.routes(lines, () => ['g'], kindOf).map((r) => [r.line.n, r.filtered, r.shadowed]),
    [[1, true, false], [2, true, false], [3, false, false], [4, false, false]], 'in the order drawn');
  // All clears drawn first: an Only when line after it adds nothing.
  const first = [line(K('clear'), C('events'), 1), line(K('clear', 'g'), C('events'), 2, { only: lea })];
  assert.deepStrictEqual(flows.routes(first, () => ['g'], kindOf).map((r) => r.shadowed), [false, true]);
  // On a kind that takes no Only when, it filters nothing.
  assert.deepStrictEqual(flows.routes([line(K('board'), C('events'), 1, { only: lea })], () => ['g'], kindOf).map((r) => r.filtered), [false]);
});

test('Only when: the tests by type, values with commas; an item without the field, or a rule not set yet, lets nothing through', () => {
  const f = { n: 5, dungeon: 'The Deadmines', who: ['Lea', 'Pata'] };
  const p = (field, op, value) => flows.passes({ field, op, value }, f);
  assert.ok(p('n', 'min', '5') && !p('n', 'min', '6') && p('n', 'max', '5') && p('n', 'is', '5') && p('n', 'not', '4'));
  assert.ok(p('dungeon', 'is', 'the deadmines') && !p('dungeon', 'is', 'Deadmines') && p('dungeon', 'not', 'Wailing Caverns'));
  assert.ok(p('who', 'has', 'lea') && !p('who', 'has', 'Mira') && p('who', 'lacks', 'Mira') && !p('who', 'lacks', 'Pata'));
  // Several values: any of them; "does not include" none of them.
  assert.ok(p('who', 'has', 'Mira, pata') && !p('who', 'has', 'Mira, Tom') && p('dungeon', 'is', 'Wailing Caverns,The Deadmines'));
  assert.ok(!p('who', 'lacks', 'Mira, Lea') && p('who', 'lacks', 'Mira, Tom') && !p('dungeon', 'not', 'x, the deadmines'));
  assert.ok(!p('n', 'min', 'five'), 'a number test needs a number');
  assert.ok(!p('dungeon', 'min', '3'), 'and a number field');
  assert.ok(!p('chapter', 'not', 'x'), 'no such field: not even "is not" lets it through');
  assert.ok(!p('n', 'is', ''), 'no value yet');
  assert.ok(!flows.passes({ field: 'n', op: 'min', value: '1' }, null), 'an item without fields');
});

test('the clocks: quiet hours over midnight, the daily post, the weekly summary', () => {
  const at = (d, h, m) => Math.floor(new Date(2026, 9, d, h, m).getTime() / 1000);
  const q = { from: '23:00', to: '08:00' };
  assert.ok(flows.inQuiet(q, at(28, 23, 30)));
  assert.ok(flows.inQuiet(q, at(29, 7, 59)));
  assert.ok(!flows.inQuiet(q, at(29, 8, 0)));
  assert.ok(!flows.inQuiet({ from: '09:00', to: '17:00' }, at(29, 18, 0)));
  assert.strictEqual(flows.nextAt(at(28, 23, 30), '08:00'), at(29, 8, 0));
  assert.strictEqual(flows.digestDue({ every: 'day', at: '21:00' }, at(29, 10, 0)), at(29, 21, 0));
  assert.strictEqual(flows.digestDue({ every: 'day', at: '21:00' }, at(29, 21, 0)), at(30, 21, 0));
  assert.strictEqual(flows.digestDue({ every: 'hour' }, at(29, 10, 15)), at(29, 11, 0));
  // 25 Oct 2026 is a Sunday.
  assert.strictEqual(flows.weeklyDue(at(29, 10, 0)), at(25, 20, 0));
  assert.strictEqual(flows.weeklyDue(at(25, 19, 59)), at(18, 20, 0));
  assert.strictEqual(flows.dayKey(at(29, 10, 0)), '2026-10-29');
});

test('what the player sets is checked', () => {
  assert.deepStrictEqual(flows.cleanOptions('mention', { role: ' 123456789012 ', name: ' @@Fellowship ' }), { role: '123456789012', name: 'Fellowship' });
  assert.deepStrictEqual(flows.cleanOptions('mention', { role: '@everyone', name: 5 }), { role: '', name: '' });
  assert.deepStrictEqual(flows.cleanOptions('digest', { every: 'hour', at: '25:00' }), { every: 'hour', at: '21:00' });
  assert.deepStrictEqual(flows.cleanOptions('quiet', { from: '22:30' }), { from: '22:30', to: '08:00' });
  assert.deepStrictEqual(flows.cleanOptions('thread', { thread: 'https://discord.com/channels/111111111/2222222222/' }), { thread: '2222222222' });
  assert.deepStrictEqual(flows.cleanOptions('thread', { mode: 'forum', thread: 'x' }), { thread: '' });
  assert.deepStrictEqual(flows.cleanOptions('only', { field: 'n', op: 'min', value: 5 }), { field: 'n', op: 'min', value: '5' });
  assert.deepStrictEqual(flows.cleanOptions('only', { field: 'a.b', op: 'eval', value: {} }), { field: '', op: 'is', value: '' });
  assert.deepStrictEqual(flows.cleanRules({ only: { field: 'n', op: 'max', value: '3' }, mention: false, gather: 'yes', run: 'x' }),
    { only: { field: 'n', op: 'max', value: '3' }, mention: null, gather: true });
  assert.deepStrictEqual(flows.cleanRules(null), { only: null, mention: null, gather: false });
});

test('the step boxes of W3–W4 become lines with rules; the channel gets the first Digest and Quiet hours', () => {
  const S = (id) => 's:' + id;
  const oldSteps = [
    { id: 'o', type: 'only', options: { field: 'n', op: 'min', value: '5' }, since: 40 },
    { id: 'm', type: 'mention', options: { role: '123456789012' } },
    { id: 'd', type: 'digest', options: { every: 'day', at: '19:30' } },
    { id: 'q', type: 'quiet', options: { from: '22:00', to: '07:00' } },
    { id: 't', type: 'thread', options: { thread: '2222222222' } },
    { id: 'm2', type: 'mention', options: { role: '' } },
  ];
  const oldLines = [
    [K('chapter'), S('o'), 30], [S('o'), S('m'), 0], [S('m'), C('events'), 0], // Only if, then a mention
    [K('clear'), S('d'), 20], [S('d'), S('q'), 0], [S('q'), S('t'), 0], [S('t'), C('events'), 0], // Digest, quiet, thread
    [K('board'), C('progress'), 10], // straight
    [K('chapter', 'g1'), S('m2'), 0], [S('m2'), C('progress'), 0], // a mention with no role
    [K('board', 'g1'), S('q'), 5], // into the quiet hours, so along their way to the thread
    [K('clear', 'g1'), S('m'), 0], // into the middle of a path: on from there
    [K('weekly'), S('nowhere'), 0], // nowhere
  ].map(([from, to, since], i) => ({ from, to, since, n: i + 1 }));
  const res = flows.fromSteps(oldLines, oldSteps);
  assert.deepStrictEqual(res.lines.map((l) => [l.from, l.to, l.since, !!l.only, l.mention && l.mention.role, l.gather]), [
    [K('chapter'), C('events'), 30, true, '123456789012', false],
    [K('clear'), T('events', '2222222222'), 20, false, null, true],
    [K('board'), C('progress'), 10, false, null, false],
    [K('chapter', 'g1'), C('progress'), 0, false, null, false],
    [K('board', 'g1'), T('events', '2222222222'), 5, false, null, false],
    [K('clear', 'g1'), C('events'), 0, false, '123456789012', false],
  ]);
  assert.deepStrictEqual(res.lines[0].only, { field: 'n', op: 'min', value: '5' });
  assert.strictEqual(res.lines[0].onlySince, 40);
  assert.deepStrictEqual(res.channels.events, { quiet: { from: '22:00', to: '07:00' }, digest: { every: 'day', at: '19:30' }, threads: ['2222222222'] });
  assert.deepStrictEqual(res.channels.progress, { quiet: null, digest: null, threads: [] });
  assert.deepStrictEqual(flows.fromSteps(null, null), { lines: [], channels: {} });
});
