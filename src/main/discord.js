'use strict';
// A Discord webhook: post a message (text and pictures), edit it, nothing else. A message may go into a thread of
// the webhook's channel (thread_id) or start a forum post (thread_name). Requests go one at a time and respect
// Discord's rate limits (429 retry_after, X-RateLimit-Remaining). The webhook URL is a secret: it never appears in an
// error, a log or a post. Mentions are switched off, so a name like "@everyone" pings nobody.

const HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const RETRIES = 3;
const MAX_CONTENT = 1900;   // Discord refuses more than 2000 characters
const SUPPRESS_EMBEDS = 4;  // message flag: no link previews
const FORUM_ONLY = 220001;  // Discord's code: a forum channel takes only forum posts (thread_name) or thread_id
const NOT_A_FORUM = 220003; // Discord's code: only a forum channel takes thread_name

// The text of a post as plain text: names and chapter names come from players, and Discord would read
// "[Click](http://...)" as a disguised link and "**" as bold. Markdown characters are escaped.
const escaped = (text) => String(text || '').replace(/[\\*_~`|>[\]()#-]/g, (c) => '\\' + c);
function plain(text) {
  const s = escaped(text);
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT - 1) + '…' : s;
}

class WebhookError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;     // 'bad-url', 'not-found', 'rejected', 'thread', 'forum', 'not-forum', 'rate-limited', 'network'
    this.status = status;
  }
}

// { id, token } of a webhook URL, or null.
function parseUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return null;
  const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_.-]{20,200})\/?$/.exec(u.pathname);
  return m ? { id: m[1], token: m[2] } : null;
}

// The name a post is sent under (the group's: a fellowship, a guild), as Discord allows it: 1-80 characters, without "@", "#", ":"
// or "```", and never containing "discord" or "clyde". Otherwise null: the webhook's own name is used.
function senderName(name) {
  const s = String(name || '').replace(/```|[@#:]/g, '').trim().slice(0, 80);
  if (!s || /discord|clyde/i.test(s)) return null;
  return s;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// opts: { url, base (tests: the API root instead of https://discord.com/api/v10), fetch, wait }
function createWebhook(opts) {
  const hook = parseUrl(opts.url);
  if (!hook && !opts.base) throw new WebhookError('bad-url');
  const root = (opts.base || 'https://discord.com/api/v10') + `/webhooks/${hook ? hook.id : 'test'}/${hook ? hook.token : 'test'}`;
  const doFetch = opts.fetch || fetch;
  const wait = opts.wait || sleep;
  let queue = Promise.resolve();
  let pauseUntil = 0;

  function body(msg, editing) {
    const files = msg.files || [];
    // Roles to mention go in front, outside the escaped text (escaping would break "<@&id>"); only those may ping.
    const roles = (msg.mentionRoles || []).filter((r) => /^\d{5,25}$/.test(r));
    const payload = {
      content: roles.map((r) => `<@&${r}> `).join('') + plain(msg.content),
      allowed_mentions: { parse: [], roles },
      flags: SUPPRESS_EMBEDS,
      attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    };
    const username = senderName(msg.username);
    if (!editing && username) payload.username = username;
    // A new forum post: its title (1-100 characters).
    if (!editing && msg.threadName) payload.thread_name = String(msg.threadName).replace(/\s+/g, ' ').trim().slice(0, 100) || '…';
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type || 'image/png' }), f.name));
    return form;
  }

  async function send(method, suffix, msg) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      if (pauseUntil > now) await wait(pauseUntil - now);
      let res;
      try {
        res = await doFetch(root + suffix, { method, body: body(msg, method === 'PATCH') });
      } catch (e) {
        throw new WebhookError('network');
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && resetAfter > 0) pauseUntil = Date.now() + resetAfter * 1000;
      if (res.status === 429) {
        let after = 1;
        try { after = Number((await res.json()).retry_after) || 1; } catch (e) { /* no body */ }
        if (attempt >= RETRIES) throw new WebhookError('rate-limited', 429);
        pauseUntil = Date.now() + Math.ceil(after * 1000);
        continue;
      }
      // A forum channel takes only new forum posts (a title, thread_name), and only a forum channel takes them: Discord
      // says which with a code, so the poster learns what the channel is ('forum', 'not-forum').
      const intoThread = method === 'POST' && suffix.includes('thread_id=');
      if (method === 'POST' && res.status === 400 && !intoThread) {
        const code = Number((await res.json().catch(() => ({}))).code);
        if (code === FORUM_ONLY) throw new WebhookError('forum', 400);
        if (code === NOT_A_FORUM) throw new WebhookError('not-forum', 400);
      }
      // A new post into a thread that is gone or in another channel: Discord answers 400 or 404 about the thread.
      if ((intoThread || (method === 'POST' && msg.threadName)) && (res.status === 400 || res.status === 404)) throw new WebhookError('thread', res.status);
      if (res.status === 404) throw new WebhookError('not-found', 404);
      if (res.status === 401 || res.status === 403) throw new WebhookError('rejected', res.status);
      if (!res.ok) {
        if (res.status >= 500 && attempt < RETRIES) { await wait(1000 * (attempt + 1)); continue; }
        throw new WebhookError('rejected', res.status);
      }
      const data = await res.json().catch(() => ({}));
      return { id: data.id, channelId: data.channel_id };
    }
  }

  const thread = (msg) => (msg.threadId && /^\d{5,25}$/.test(msg.threadId) ? 'thread_id=' + msg.threadId : '');

  function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  return {
    // New message: { content, files: [{ name, data: Buffer, type }], mentionRoles, threadId?, threadName? } →
    // { id, channelId } (channelId: the thread a forum post started).
    post: (msg) => enqueue(() => send('POST', '?wait=true' + (thread(msg) ? '&' + thread(msg) : ''), msg)),
    // Replace a message's text and pictures (threadId: the thread it is in). Throws WebhookError 'not-found' when it
    // was deleted.
    edit: (id, msg) => enqueue(() => send('PATCH', `/messages/${encodeURIComponent(id)}` + (thread(msg) ? '?' + thread(msg) : ''), msg)),
  };
}

module.exports = { createWebhook, parseUrl, plain, escaped, senderName, WebhookError, MAX_CONTENT };
