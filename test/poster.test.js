'use strict';
// What gets posted where and when (SPEC §5): along the lines the player drew, kept messages once per channel and then
// edited, news once per channel, no backlog; the lines' rules and the channels' times; plugins not in use post nothing.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpDir } = require('./tmp');
const { createPoster } = require('../src/main/poster');
const { createSettings } = require('../src/main/settings');
const { WebhookError } = require('../src/main/discord');
const plugins = require('../src/main/plugins');
const { kindBox, channelBox, threadBox } = require('../src/main/flows');

const BASE = plugins.findDataPlugins([path.join(__dirname, 'fixtures', 'AddOns')])[0].plugin;
const WEEKLY = { name: 'Weekly summary', help: null, head: '{group} this week:', number: '{name} {from} → {to}',
  news: [{ kind: 'win', text: 'Matches won: {list}' }], separator: ' · ' };
const fakeKeys = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
  decryptString: (b) => b.toString('utf8').split('').reverse().join(''),
};
const URL_A = 'https://discord.com/api/webhooks/111111111111111111/SECRETtokenAAAAAAAAAAAA';
const URL_B = 'https://discord.com/api/webhooks/222222222222222222/SECRETtokenBBBBBBBBBBBB';
const at = (d, h, m = 0) => Math.floor(new Date(2026, 9, d, h, m).getTime() / 1000); // October 2026; the 25th is a Sunday

function group(saved, news, extra) {
  return { id: 'T', name: 'The Lanterns', saved, kept: { standings: { text: 'The Lanterns  ·  3 wins', data: {} } }, news: news || [], numbers: {}, ...extra };
}
const news = (id, kind, time, extra) => ({ id, kind, time, text: `${kind} ${id}.`, name: id, picture: null, ...extra });

// A poster with fake Discord channels: calls[] records [channel, 'post'|'edit', content, extra].
function setup(groups, opts = {}) {
  const PLUGIN = opts.weekly ? { ...BASE, weekly: WEEKLY } : BASE;
  const settings = createSettings(opts.dir || tmpDir('awd-'), fakeKeys);
  settings.usePlugin(PLUGIN.id, true);
  const calls = [];
  const messages = new Set();
  let nextId = 1;
  // shots: the screenshots asked for; shotSize: how big each one found is (0: none is found).
  // pictures: the news pictures asked for; drawnIn: the game each template picture was drawn for (its game art).
  const env = { groups, from: {}, time: opts.time || 1000, rendered: 0, fail: {}, forums: new Set(), shots: [], shotSize: 0,
    pictures: [], drawnIn: [] };
  const hookFor = (name) => ({
    post: async (msg) => {
      if (env.fail[name]) throw new WebhookError(env.fail[name], 401);
      // A forum channel takes only forum posts (a title) or posts into one of its threads, as Discord.
      if (!msg.threadId && env.forums.has(name) !== !!msg.threadName) throw new WebhookError(msg.threadName ? 'not-forum' : 'forum', 400);
      const id = String(nextId++); messages.add(id);
      calls.push([name, 'post', msg.content, { username: msg.username, roles: msg.mentionRoles || [], files: (msg.files || []).length,
        fileNames: (msg.files || []).map((f) => f.name), threadId: msg.threadId, threadName: msg.threadName }]);
      return { id, channelId: msg.threadName ? 'forum' + id : undefined };
    },
    edit: async (id, msg) => {
      if (!messages.has(id)) throw new WebhookError('not-found', 404);
      calls.push([name, 'edit', msg.content, { threadId: msg.threadId }]);
      return { id };
    },
  });
  const hooks = {};
  const poster = createPoster({
    settings,
    plugins: () => (settings.used(PLUGIN.id) ? [PLUGIN] : []),
    read: () => ({ groups: env.groups, from: env.from }),
    webhook: (id) => { const ch = settings.channels().find((x) => x.id === id); return ch ? (hooks[id] = hooks[id] || hookFor(ch.name)) : null; },
    render: async (_p, _kind, _entry, _group, flavor) => {
      env.rendered++; env.drawnIn.push(flavor);
      return { name: 'standings.png', data: Buffer.from('PNG'), type: 'image/png' };
    },
    picture: (_p, pic) => { env.pictures.push(pic); return { name: 'p.png', data: Buffer.from('PNG'), type: 'image/png' }; },
    screenshot: (s) => { env.shots.push(s); return env.shotSize ? { name: `shot${s.time}.jpg`, data: Buffer.alloc(env.shotSize), type: 'image/jpeg' } : null; },
    now: () => env.time,
  });
  const K = (kind, gid = '*') => kindBox(PLUGIN.id, gid, kind);
  // A line, with its rules ({ only, mention, gather }) when given.
  const line = (from, to, rules) => {
    assert.ok(settings.addLine(from, to, env.time), from + ' → ' + to);
    if (rules) assert.ok(settings.setLine(from, to, rules, env.time));
  };
  const channel = (name, url) => channelBox(settings.addChannel(name, url, env.time));
  const idOf = (box) => box.slice(2);
  return { poster, settings, calls, messages, env, K, line, channel, idOf };
}

test('setup posts the kept message and no backlog; a new save edits it; the same save does nothing', async () => {
  const t = setup({ T: group(950, [news('old', 'win', 900)]) });
  const all = t.channel('#all', URL_A);
  t.line(t.K('standings'), all); t.line(t.K('win'), all);
  let res = await t.poster.sync('setup');
  assert.strictEqual(res.kept, 'posted');
  assert.strictEqual(res.news, 0, 'no backlog');
  assert.deepStrictEqual(t.calls.map((c) => c.slice(0, 3)), [['#all', 'post', 'The Lanterns  ·  3 wins']]);
  assert.strictEqual(t.calls[0][3].username, 'The Lanterns', 'sent under the group\'s name');
  assert.strictEqual(t.calls[0][3].files, 1, 'with the template\'s picture');

  res = await t.poster.sync('file');
  assert.strictEqual(res.kept, null, 'nothing new: no edit');
  t.env.time = 1100;
  t.env.groups = { T: group(1100, [news('old', 'win', 900), news('w1', 'win', 1090)]) };
  res = await t.poster.sync('file');
  assert.strictEqual(res.kept, 'edited');
  assert.strictEqual(res.news, 1);
  assert.deepStrictEqual(t.calls.slice(1).map((c) => c.slice(0, 3)), [['#all', 'edit', 'The Lanterns  ·  3 wins'], ['#all', 'post', 'win w1.']]);
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 3, 'each news item once');
  assert.strictEqual(t.env.rendered, 2, 'drawn once per run that posts');
});

test('each channel gets what its lines bring; one kind to two channels; a line drawn later starts from then', async () => {
  const t = setup({ T: group(1000), U: group(1000, [], { id: 'U', name: 'The Owls' }) });
  const board = t.channel('#board', URL_A), feed = t.channel('#news', URL_B);
  t.line(t.K('standings'), board);
  t.line(t.K('win', 'T'), feed);
  t.line(t.K('win', 'T'), board);
  await t.poster.sync('setup');
  assert.deepStrictEqual(t.calls.map((c) => [c[0], c[3].username]), [['#board', 'The Lanterns'], ['#board', 'The Owls']], 'Every: both groups');
  t.env.time = 1200;
  t.env.groups.T = group(1200, [news('w1', 'win', 1150), news('l1', 'level', 1160)]);
  t.env.groups.U = group(1000, [news('w2', 'win', 1150)], { id: 'U', name: 'The Owls' });
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.slice(2).map((c) => c.slice(0, 3)).sort(), [['#board', 'edit', 'The Lanterns  ·  3 wins'], ['#board', 'post', 'win w1.'], ['#news', 'post', 'win w1.']]);
  // Level up drawn to #board at 1300: the level news from 1160 is not posted, a later one is.
  t.env.time = 1300;
  t.line(t.K('level'), board);
  t.env.groups.T = group(1400, [news('w1', 'win', 1150), news('l1', 'level', 1160), news('l2', 'level', 1350)]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.slice(5).map((c) => c.slice(0, 3)), [['#board', 'edit', 'The Lanterns  ·  3 wins'], ['#board', 'post', 'level l2.']]);
});

test('a mention pings its role only on its line; an item two lines bring to one channel is posted once, as the first drawn', async () => {
  const t = setup({ T: group(1000) });
  const all = t.channel('#all', URL_A), other = t.channel('#other', URL_B);
  t.line(t.K('win'), all, { mention: { role: '123456789012345678' } }); // Match won takes no mention: none
  t.line(t.K('level'), all, { mention: { role: '123456789012345678', name: 'Fellowship' } });
  t.line(t.K('level', 'T'), other);
  t.line(t.K('level', 'T'), all); // drawn after the line with the mention: shadowed
  await t.poster.sync('setup');
  t.env.time = 1100;
  t.env.groups.T = group(1100, [news('w1', 'win', 1050), news('l1', 'level', 1060)]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.map((c) => [c[0], c[2], c[3].roles]).sort(),
    [['#all', 'level l1.', ['123456789012345678']], ['#all', 'win w1.', []], ['#other', 'level l1.', []]]);
});

test('a deleted kept message is posted again; one failing channel does not stop the others', async () => {
  const t = setup({ T: group(1000) });
  t.line(t.K('standings'), t.channel('#a', URL_A));
  t.line(t.K('standings'), t.channel('#b', URL_B));
  await t.poster.sync('setup');
  assert.deepStrictEqual(t.settings.get('pinAsks'), [], 'the setup asks to pin by itself');
  t.messages.clear();
  t.env.fail['#a'] = 'rejected';
  t.env.groups.T = group(1100);
  const res = await t.poster.sync('file');
  assert.strictEqual(res.problem, 'webhook-refused');
  assert.strictEqual(res.channel, '#a');
  assert.deepStrictEqual(t.calls.slice(2).map((c) => c.slice(0, 2)), [['#b', 'post']], 'deleted: posted anew in #b');
  assert.deepStrictEqual(t.settings.get('pinAsks'), [{ channel: '#b', group: 'The Lanterns', kind: 'Standings' }], 'and the window asks to pin it');
  assert.ok(t.settings.get('log').some((e) => e.channel === '#a' && e.problem === 'webhook-refused'));
});

test('a plugin not in use posts nothing; a group no longer saved is named; paused posts nothing; no lines: nothing followed', async () => {
  const t = setup({ T: group(1000) });
  const all = t.channel('#all', URL_A);
  assert.strictEqual((await t.poster.sync('setup')).problem, 'nothing-followed');
  t.line(t.K('standings', 'T'), all);
  await t.poster.sync('setup');
  t.env.groups = {};
  let res = await t.poster.sync('now');
  assert.strictEqual(res.problem, 'no-group');
  assert.strictEqual(res.group, 'The Lanterns', 'its last known name');
  t.env.groups = { T: group(2000) };
  t.poster.setPaused(true);
  res = await t.poster.sync('file');
  assert.ok(res.paused);
  t.settings.usePlugin(BASE.id, false);
  res = await t.poster.sync('now');
  assert.strictEqual(res.problem, 'nothing-followed');
  assert.strictEqual(t.calls.length, 1);
});

test('Every {group} takes a group saved later, without its older news', async () => {
  const t = setup({ T: group(1000) });
  t.line(t.K('win'), t.channel('#all', URL_A));
  await t.poster.sync('setup');
  t.env.time = 2000;
  t.env.groups.U = group(2000, [news('u-old', 'win', 1500), news('u-new', 'win', 2000)], { id: 'U', name: 'The Owls' });
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.map((c) => c[2]), ['win u-new.']);
});

test('lines that gather into one place share its daily post, posted when due, also after the app restarts', async () => {
  const dir = tmpDir('awd-');
  const t = setup({ T: group(at(29, 9)) }, { dir, time: at(29, 9) });
  const all = t.channel('#all', URL_A);
  t.line(t.K('win'), all, { gather: true }); t.line(t.K('level'), all, { gather: true });
  await t.poster.sync('setup');
  t.env.time = at(29, 12);
  t.env.groups.T = group(at(29, 12), [news('w1', 'win', at(29, 10), { picture: 'a.png' }), news('l1', 'level', at(29, 11))]);
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 0, 'gathered, not posted');
  assert.ok(!t.poster.isDue(at(29, 20, 59)));
  assert.ok(t.poster.isDue(at(29, 21)));
  // The app restarts: the gathered posts are in the settings.
  const t2 = setup(t.env.groups, { dir, time: at(29, 21, 1) });
  await t2.poster.sync('timer');
  assert.deepStrictEqual(t2.calls.map((c) => [c[0], c[2], c[3].files]), [['#all', 'The Lanterns\nwin w1.\nlevel l1.', 1]]);
  await t2.poster.sync('timer');
  assert.strictEqual(t2.calls.length, 1, 'posted once');
});

test('a daily post set to another time posts what it gathered at the new time', async () => {
  const t = setup({ T: group(at(29, 9)) }, { time: at(29, 9) });
  const all = t.channel('#all', URL_A);
  t.line(t.K('win'), all, { gather: true });
  await t.poster.sync('setup');
  t.env.time = at(29, 12);
  t.env.groups.T = group(at(29, 12), [news('w1', 'win', at(29, 11))]);
  await t.poster.sync('file');
  assert.ok(!t.poster.isDue(at(29, 13)));
  t.settings.setChannel(t.idOf(all), { digest: { at: '13:00' } }, at(29, 12, 30));
  assert.ok(t.poster.isDue(at(29, 13)), 'due at 13:00 now, not at 21:00');
  t.env.time = at(29, 13);
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.map((c) => c[2]), ['The Lanterns\nwin w1.']);
});

test('a channel\'s quiet hours hold news until they end; a kept message is edited then', async () => {
  const t = setup({ T: group(at(28, 22)) }, { time: at(28, 22) });
  const all = t.channel('#all', URL_A);
  t.settings.setChannel(t.idOf(all), { quiet: { from: '23:00', to: '08:00' } });
  t.line(t.K('win'), all); t.line(t.K('standings'), all);
  await t.poster.sync('setup');
  assert.strictEqual(t.calls.length, 1, 'the board, before the quiet hours');
  t.env.time = at(28, 23, 30);
  t.env.groups.T = group(at(28, 23, 30), [news('w1', 'win', at(28, 23, 20))]);
  t.poster.isDue(t.env.time);
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 1, 'held');
  assert.ok(!t.poster.isDue(at(29, 7)));
  t.env.time = at(29, 8);
  assert.ok(t.poster.isDue(t.env.time));
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.slice(1).map((c) => c.slice(0, 3)).sort(), [['#all', 'edit', 'The Lanterns  ·  3 wins'], ['#all', 'post', 'win w1.']]);
});

test('a line to a thread posts in it; a forum channel, learned from Discord, gets a post per item and one kept post', async () => {
  const t = setup({ T: group(1000) });
  const a = t.channel('#a', URL_A), f = t.channel('#forum', URL_B);
  const tid = t.settings.addThread(t.idOf(a), 'https://discord.com/channels/123456789/987654321', 'Wins');
  t.env.forums.add('#forum');
  t.line(t.K('win'), threadBox(t.idOf(a), tid));
  t.line(t.K('win'), f); t.line(t.K('standings'), f);
  await t.poster.sync('setup');
  assert.deepStrictEqual(t.calls.map((c) => [c[0], c[1], c[3].threadName]), [['#forum', 'post', 'The Lanterns · Standings']], 'refused once, then a forum post');
  assert.strictEqual(t.settings.channels().find((c) => c.name === '#forum').forum, true, 'remembered as a forum');
  t.env.time = 1100;
  t.env.groups.T = group(1100, [news('w1', 'win', 1050)]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.slice(1).map((c) => [c[0], c[1], c[3].threadId, c[3].threadName]).sort(), [
    ['#a', 'post', '987654321', undefined],
    ['#forum', 'edit', 'forum1', undefined],
    ['#forum', 'post', undefined, 'w1'],
  ]);
});

test('the weekly summary: a kind of its own, made on Sunday at 20:00 from the numbers of the week', async () => {
  const t = setup({ T: group(at(19, 12), [], { numbers: { Lea: 20, Mira: 18 } }) }, { weekly: true, time: at(19, 12) });
  t.line(t.K('weekly'), t.channel('#all', URL_A));
  await t.poster.sync('setup');
  t.env.time = at(23, 12);
  t.env.groups.T = group(at(23, 12), [news('w1', 'win', at(22, 10)), news('w2', 'win', at(23, 10), { name: 'Cup final' })], { numbers: { Lea: 23, Mira: 18, Pata: 5 } });
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 0);
  t.env.time = at(25, 20);
  assert.ok(t.poster.isDue(t.env.time));
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.map((c) => c.slice(0, 3)), [['#all', 'post', 'The Lanterns this week: Lea 20 → 23 · Matches won: w1, Cup final']]);
  await t.poster.sync('timer');
  assert.strictEqual(t.calls.length, 1, 'once');
});

test('Only when lets through the items whose fields match; changed, it posts none it held back before', async () => {
  const t = setup({ T: group(1000) });
  const levels = t.channel('#levels', URL_A);
  t.line(t.K('level'), levels, { only: { field: 'level', op: 'min', value: '20' } });
  await t.poster.sync('setup');
  t.env.time = 1100;
  t.env.groups.T = group(1100, [news('l1', 'level', 1050, { fields: { level: 19 } }), news('l2', 'level', 1060, { fields: { level: 20 } }),
    news('l3', 'level', 1070)]);
  const res = await t.poster.sync('file');
  assert.strictEqual(res.news, 1);
  assert.deepStrictEqual(t.calls.map((c) => c[2]), ['level l2.'], 'level 19 held back; an item without the field too');
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 1);
  // At least 19 now: level 19 from before the change is not posted, a later one is.
  t.env.time = 1200;
  assert.ok(t.settings.setLine(t.K('level'), levels, { only: { field: 'level', op: 'min', value: '19' } }, 1200));
  await t.poster.sync('file');
  assert.strictEqual(t.calls.length, 1, 'no backlog');
  t.env.time = 1300;
  t.env.groups.T = group(1300, [...t.env.groups.T.news, news('l4', 'level', 1250, { fields: { level: 19 } })]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.map((c) => c[2]), ['level l2.', 'level l4.']);
  const log = t.settings.all().log;
  assert.deepStrictEqual(log[0].via, ['only'], 'the log says it went through Only when');
});

test('Only when: two lines into one channel each bring theirs, an item both let through once; gathered, each item is tested', async () => {
  const t = setup({ T: group(at(29, 9)) }, { time: at(29, 9) });
  const events = t.channel('#events', URL_A), daily = t.channel('#daily', URL_B);
  t.line(t.K('win'), events, { only: { field: 'who', op: 'has', value: 'Lea' } });
  t.line(t.K('win', 'T'), events, { only: { field: 'who', op: 'has', value: 'pata' } });
  t.line(t.K('win'), daily, { only: { field: 'opponent', op: 'is', value: 'Gnomes, Ogres' }, gather: true });
  await t.poster.sync('setup');
  t.env.time = at(29, 12);
  const win = (id, who, opponent, h) => news(id, 'win', at(29, h), { fields: { who, opponent } });
  t.env.groups.T = group(at(29, 12), [win('w1', ['Lea'], 'Gnomes', 10), win('w2', ['Pata'], 'Owls', 10), win('w3', ['Lea', 'Pata'], 'Gnomes', 11),
    win('w4', ['Mira'], 'Owls', 11)]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.map((c) => [c[0], c[2]]), [['#events', 'win w1.'], ['#events', 'win w3.'], ['#events', 'win w2.']]);
  t.env.time = at(29, 21, 1);
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.slice(3).map((c) => [c[0], c[2]]), [['#daily', 'The Lanterns\nwin w1.\nwin w3.']], 'only the Gnomes wins in the daily post');
});

test('a news item that names a screenshot has the game\'s screenshot attached, also in a daily post; past 8 MB the rest is left off', async () => {
  const t = setup({ T: group(at(29, 9)) }, { time: at(29, 9) });
  t.env.from = { T: { flavor: '_retail_', account: 'ACC' } };
  const shots = t.channel('#shots', URL_A), daily = t.channel('#daily', URL_B);
  t.line(t.K('win'), shots); t.line(t.K('level'), daily, { gather: true });
  await t.poster.sync('setup');
  t.env.time = at(29, 12);
  t.env.shotSize = 1000;
  t.env.groups.T = group(at(29, 12), [news('w1', 'win', at(29, 10), { screenshot: at(29, 10), picture: 'Media/Icon.tga' })]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.map((c) => c[3].fileNames), [[`shot${at(29, 10)}.jpg`, 'p.png']], 'the screenshot first, then the plugin\'s picture');
  assert.deepStrictEqual(t.env.shots, [{ flavor: '_retail_', time: at(29, 10) }], 'from the game the group was saved in');
  // Not found (moved or deleted): the text goes without it.
  t.env.shotSize = 0;
  t.env.groups.T = group(at(29, 12), [...t.env.groups.T.news, news('w2', 'win', at(29, 11), { screenshot: at(29, 11) })]);
  await t.poster.sync('file');
  assert.deepStrictEqual(t.calls.slice(1).map((c) => [c[2], c[3].files]), [['win w2.', 0]]);
  // Three 3 MB screenshots in one daily post: two fit.
  t.env.shotSize = 3 * 1024 * 1024;
  t.env.groups.T = group(at(29, 12), [...t.env.groups.T.news, ...[1, 2, 3].map((i) => news('l' + i, 'level', at(29, 11, i), { screenshot: at(29, 11, i) }))]);
  await t.poster.sync('file');
  t.env.time = at(29, 21, 1);
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.slice(2).map((c) => [c[0], c[3].fileNames]), [['#daily', [`shot${at(29, 11, 1)}.jpg`, `shot${at(29, 11, 2)}.jpg`]]]);
});

test('game art comes from the game the group was saved in: a template\'s, and a news picture\'s, also in a daily post', async () => {
  const t = setup({ T: group(at(29, 9)) }, { time: at(29, 9) });
  t.env.from = { T: { flavor: '_forever_', account: 'ACC' } };
  const all = t.channel('#all', URL_A), daily = t.channel('#daily', URL_B);
  t.line(t.K('standings'), all); t.line(t.K('win'), all); t.line(t.K('level'), daily, { gather: true });
  await t.poster.sync('setup');
  assert.deepStrictEqual(t.env.drawnIn, ['_forever_'], 'the board, with that game\'s art');
  t.env.time = at(29, 12);
  const screen = { game: 131833, crop: [0, 1, 0.21, 0.78], aspect: 2.34 };
  t.env.groups.T = group(at(29, 9), [news('w1', 'win', at(29, 10), { picture: screen }), news('l1', 'level', at(29, 11), { picture: screen })]);
  await t.poster.sync('file');
  t.env.time = at(29, 21, 1);
  await t.poster.sync('timer');
  assert.deepStrictEqual(t.calls.slice(1).map((c) => [c[0], c[3].files]), [['#all', 1], ['#daily', 1]]);
  assert.deepStrictEqual(t.env.pictures, [{ ...screen, flavor: '_forever_' }, { ...screen, flavor: '_forever_' }]);
});

test('settings never hold a webhook URL in plain text', () => {
  const dir = tmpDir('awd-');
  const s = createSettings(dir, fakeKeys);
  const id = s.addChannel('#a', URL_A, 1);
  const text = require('fs').readFileSync(s.file, 'utf8');
  assert.ok(!text.includes('SECRETtoken'));
  assert.strictEqual(s.channelUrl(id), URL_A);
  assert.ok(!JSON.stringify(s.all()).includes('SECRETtoken'), 'not in what the window sees');
  const noKeys = createSettings(tmpDir('awd-'), { ...fakeKeys, isEncryptionAvailable: () => false });
  assert.strictEqual(noKeys.addChannel('#a', URL_A, 1), null);
});
