'use strict';
// The webhook client against a local fake Discord (never the real one).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createWebhook, parseUrl, plain, WebhookError } = require('../src/main/discord');

// A fake webhook API: replies from `script` in order (status, body, headers); records every request.
function fakeDiscord(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      const r = script.shift() || { status: 200, body: { id: '1' } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.body || {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() });
  }));
}

const noWait = () => Promise.resolve();

test('webhook URLs: only Discord\'s', () => {
  assert.deepStrictEqual(parseUrl('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-.'),
    { id: '123456789012345678', token: 'abcdefghijklmnopqrstuvwxyz_-.' });
  assert.ok(parseUrl('https://discordapp.com/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'));
  assert.strictEqual(parseUrl('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), null, 'not https');
  assert.strictEqual(parseUrl('https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), null);
  assert.strictEqual(parseUrl('not a url'), null);
  assert.throws(() => createWebhook({ url: 'https://example.com' }), WebhookError);
});

test('posts with a picture and no mentions, then edits the same message', async () => {
  const d = await fakeDiscord([{ status: 200, body: { id: '42' } }, { status: 200, body: { id: '42' } }]);
  try {
    const hook = createWebhook({ base: d.base, wait: noWait });
    const res = await hook.post({ content: '@everyone Iron Oath', files: [{ name: 'board.png', data: Buffer.from('PNG') }] });
    assert.strictEqual(res.id, '42');
    assert.strictEqual(d.requests[0].method, 'POST');
    assert.ok(d.requests[0].url.endsWith('?wait=true'), 'waits for the message id');
    assert.ok(d.requests[0].body.includes('"allowed_mentions":{"parse":[],"roles":[]}'), 'mentions off');
    assert.ok(d.requests[0].body.includes('"flags":4'), 'no link previews');
    assert.ok(d.requests[0].body.includes('filename="board.png"'), 'the picture');
    await hook.edit('42', { content: 'x', files: [{ name: 'board.png', data: Buffer.from('PNG2') }] });
    assert.strictEqual(d.requests[1].method, 'PATCH');
    assert.ok(d.requests[1].url.endsWith('/messages/42'));
    assert.ok(d.requests[1].body.includes('"attachments":[{"id":0,"filename":"board.png"}]'), 'replaces the picture');
  } finally { d.close(); }
});

test('player text stays plain text: no disguised links or formatting, and within Discord\'s length', () => {
  assert.strictEqual(plain('[Click](http://x.example) **Iron** Oath'), '\\[Click\\]\\(http://x.example\\) \\*\\*Iron\\*\\* Oath');
  assert.strictEqual(plain('Iron Oath  ·  Chapter 2'), 'Iron Oath  ·  Chapter 2', 'ordinary text unchanged');
  assert.ok(plain('x'.repeat(5000)).length <= 1900);
});

test('rate limits: waits for retry_after, then tries again', async () => {
  const d = await fakeDiscord([{ status: 429, body: { retry_after: 0.01 } }, { status: 200, body: { id: '7' } }]);
  try {
    const waits = [];
    const hook = createWebhook({ base: d.base, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
    assert.strictEqual((await hook.post({ content: 'a' })).id, '7');
    assert.strictEqual(d.requests.length, 2);
    assert.ok(waits.length >= 1, 'waited before trying again');
  } finally { d.close(); }
});

test('a deleted message is not-found; a refused webhook is rejected; the token never shows', async () => {
  const d = await fakeDiscord([{ status: 404, body: { message: 'Unknown Message' } }, { status: 401, body: {} }]);
  try {
    const hook = createWebhook({ base: d.base, wait: noWait });
    await assert.rejects(hook.edit('1', { content: 'x' }), (e) => e.code === 'not-found' && !String(e.message).includes('test'));
    await assert.rejects(hook.post({ content: 'x' }), (e) => e.code === 'rejected');
  } finally { d.close(); }
});

test('no network: a plain error without the URL', async () => {
  const hook = createWebhook({ url: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzSECRET',
    fetch: () => Promise.reject(new Error('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzSECRET')) });
  await assert.rejects(hook.post({ content: 'x' }), (e) => e.code === 'network' && !e.message.includes('SECRET'));
});

test('posts go out under the group\'s name; a role is mentioned only when chosen', async () => {
  const { senderName } = require('../src/main/discord');
  assert.strictEqual(senderName('Iron Oath'), 'Iron Oath');
  assert.strictEqual(senderName('My Discord crew'), null, 'Discord refuses names with "discord"');
  assert.strictEqual(senderName('@Iron #Oath:'), 'Iron Oath');
  const d = await fakeDiscord([{ status: 200, body: { id: '1' } }, { status: 200, body: { id: '2' } }]);
  try {
    const hook = createWebhook({ base: d.base, wait: noWait });
    await hook.post({ content: 'Iron Oath completed Chapter 3.', mentionRoles: ['123456789012345678'], username: 'Iron Oath' });
    const body = d.requests[0].body;
    assert.ok(body.includes('"content":"<@&123456789012345678> Iron Oath completed Chapter 3."'), 'the mention in front, unescaped');
    assert.ok(body.includes('"allowed_mentions":{"parse":[],"roles":["123456789012345678"]}'), 'only that role may ping');
    assert.ok(body.includes('"username":"Iron Oath"'));
    await hook.post({ content: 'x', mentionRoles: ['not-a-role'] });
    assert.ok(d.requests[1].body.includes('"allowed_mentions":{"parse":[],"roles":[]}'), 'a bad role ID mentions nobody');
  } finally { d.close(); }
});

test('Discord says whether a channel is a forum', async () => {
  const d = await fakeDiscord([{ status: 400, body: { code: 220001, message: 'Webhooks posted to forum channels must have a thread_name or thread_id' } },
    { status: 400, body: { code: 220003, message: 'Webhooks can only create threads in forum channels' } }, { status: 400, body: { code: 50035 } }]);
  const hook = createWebhook({ url: 'x', base: d.base, wait: noWait });
  await assert.rejects(hook.post({ content: 'a' }), (e) => e.code === 'forum');
  await assert.rejects(hook.post({ content: 'b', threadName: 'B' }), (e) => e.code === 'not-forum');
  await assert.rejects(hook.post({ content: 'c' }), (e) => e.code === 'rejected');
  d.close();
});

test('into a thread, a new forum post, and edits in a thread; a refused thread is named', async () => {
  const d = await fakeDiscord([{ status: 200, body: { id: '1', channel_id: '555555' } }, { status: 200, body: { id: '2' } }, { status: 200, body: { id: '1' } },
    { status: 400, body: { code: 220001, message: 'Webhooks posted to forum channels must have a thread_name or thread_id' } }]);
  const hook = createWebhook({ url: 'x', base: d.base, wait: noWait });
  assert.deepStrictEqual(await hook.post({ content: 'a', threadName: '  Iron   Oath · Progress board ' }), { id: '1', channelId: '555555' });
  await hook.post({ content: 'b', threadId: '987654321' });
  await hook.edit('1', { content: 'c', threadId: '555555' });
  await assert.rejects(hook.post({ content: 'd', threadId: '987654321' }), (e) => e.code === 'thread');
  d.close();
  assert.match(d.requests[0].url, /\?wait=true$/);
  assert.match(Buffer.from(d.requests[0].body, "latin1").toString("utf8"), /"thread_name":"Iron Oath · Progress board"/);
  assert.match(d.requests[1].url, /\?wait=true&thread_id=987654321$/);
  assert.match(d.requests[2].url, /\/messages\/1\?thread_id=555555$/);
  assert.ok(!/thread_name/.test(d.requests[2].body), 'an edit keeps its title');
});
