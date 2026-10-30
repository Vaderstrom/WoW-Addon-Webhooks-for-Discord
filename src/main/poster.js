'use strict';
// What the app does each time saved data changes or a daily post or the end of quiet hours is due (SPEC §5). The lines
// the player drew become routes (src/main/flows.js): a kind of one group to a channel or one of its threads. Along each
// route kept kinds are posted once and then edited, news posted once each; no backlog. The line's rules and its
// channel's times are steps on the way: Only when lets through only the items whose fields match, Mention a role pings
// a role, the daily post gathers news into one post when it is due, quiet hours hold posts until they end, a thread
// takes the post instead of the channel. Posts a step holds are kept in the settings, so they survive the app
// closing. Every post goes out under the group's name and is logged. Each picture is drawn once per run; a news item
// that names a screenshot has the game's screenshot attached. No Electron here, so it can be tested.
const { WebhookError, escaped, MAX_CONTENT } = require('./discord');
const { key } = require('./settings');
const flows = require('./flows');
const { summary } = require('./weekly');

const PROBLEM = { 'not-found': 'webhook-refused', rejected: 'webhook-refused', 'bad-url': 'webhook-refused', thread: 'thread-refused',
  'rate-limited': 'rate-limited', network: 'offline' };
const READ_PROBLEM = { missing: 'no-file', unreadable: 'unreadable', 'too-big': 'unreadable', bad: 'unreadable', 'too-new': 'too-new', script: 'script-failed' };
const MAX_PICTURES = 10;          // Discord takes up to 10 files per message
const MAX_UPLOAD = 8 * 1024 * 1024; // and 10 MB in all on a server without boosts: pictures past 8 MB are left off
const KEEP_WEEKLY = 8 * 86400;    // the summaries made are kept a week and a day

// deps: { settings, plugins() → the plugins in use, read(plugin) → { groups, from } | { error }, webhook(channelId) →
//         { post, edit } | null, render(plugin, kindId, entry, group, flavor) → { name, data, type } | null (no
//         template), picture(plugin, picture) → { name, data, type } | null (a path, or { game, crop, aspect, flavor }:
//         from the game's data), screenshot({ flavor, time }) → { name, data, type } | null (not found), now() → Unix
//         seconds, onStatus(status) }. flavor: the game the group was saved in, for its screenshots and game art.
// A new message in channel ch. A forum channel takes only forum posts, each with a title, and only a forum channel
// takes a title: Discord says which the first time ('forum', 'not-forum'), the channel is remembered as such, and the
// message goes again the way it takes. A message into a thread of the channel (msg.threadId) is posted as it is.
// Returns { id, channelId, forum } (forum: it became a forum post; channelId is then that post's thread).
async function postIn(settings, hook, ch, msg, title) {
  if (msg.threadId) return { ...(await hook.post(msg)), forum: false };
  const as = async (forum) => ({ ...(await hook.post(forum ? { ...msg, threadName: title } : msg)), forum });
  try {
    return await as(!!ch.forum);
  } catch (e) {
    if (!(e instanceof WebhookError) || e.code !== (ch.forum ? 'not-forum' : 'forum')) throw e;
    settings.setForum(ch.id, !ch.forum);
    return as(!ch.forum);
  }
}

function createPoster(deps) {
  const { settings } = deps;
  let running = Promise.resolve();
  const quietWas = new Map(); // channel id → whether it was in its quiet hours at the last look

  function status(problemKey, extra) {
    settings.set({ problem: problemKey || null });
    const st = { problem: problemKey || null, ...extra };
    if (deps.onStatus) deps.onStatus(st);
    return st;
  }
  const log = (plugin, ch, group, kind, problemKey, via) => settings.addLog({ time: deps.now(), plugin: plugin ? plugin.name : null,
    channel: ch ? ch.name : null, group: group || null, kind: kind || null, via: via && via.length ? via : undefined, problem: problemKey || null });
  const kindOf = (plugin, id) => (plugin ? flows.pluginKinds(plugin).find((k) => k.id === id) || null : null);
  const weeklyItems = (pid, gid) => ((settings.get('weekly') || {}).items || {})[key(pid, gid)] || [];
  // Where a kept message lives: "" the channel itself, "t:<id>" a thread, "f" a forum post (in a forum channel).
  const targetOf = (t, ch) => (t && t.thread ? 't:' + t.thread : ch.forum ? 'f' : '');

  // ---------- One post along its route ----------

  // Walks a post through the steps from `pos` on, then posts it. Returns 'posted', 'edited', null (a kept message with
  // nothing new), 'held' or 'gathered' (a step keeps it for later).
  async function walk(ctx, channel, steps, pos, post) {
    for (let i = pos; i < steps.length; i++) {
      const s = ctx.steps.get(steps[i]);
      if (!s) continue; // removed since
      if (s.type === 'mention') {
        if (s.options.role && post.type === 'news') { post.roles = [s.options.role]; post.via.push('mention'); }
      } else if (s.type === 'thread') {
        post.thread = s.options; post.via.push('thread');
      } else if (s.type === 'only') {
        // A daily post's items were let through one by one when it gathered them.
        if (post.type === 'news' && !post.digest && !flows.passes(s.options, post.fields)) return 'filtered';
        if (!post.via.includes('only')) post.via.push('only');
      } else if (s.type === 'quiet' && flows.inQuiet(s.options, ctx.now)) {
        if (post.type === 'kept') return 'held'; // edited when the quiet hours end (isDue)
        post.via.push('quiet');
        ctx.pending.push({ type: 'held', due: flows.nextAt(ctx.now, s.options.to), channel, steps, pos: i + 1, post });
        settings.remember(channel, post.ids);
        return 'held';
      } else if (s.type === 'digest' && post.type === 'news') {
        // Every line that gathers into one place shares its daily post: one post per group.
        const k = [s.id, steps.slice(i + 1).join(','), channel, post.pid, post.gid].join('>');
        let d = ctx.pending.find((p) => p.type === 'digest' && p.key === k);
        if (!d) {
          d = { type: 'digest', key: k, due: flows.digestDue(s.options, ctx.now), channel, steps, pos: i + 1, pid: post.pid, gid: post.gid, group: post.group, posts: [] };
          ctx.pending.push(d);
        }
        d.posts.push(post);
        settings.remember(channel, post.ids);
        return 'gathered';
      }
    }
    return deliver(ctx, channel, post);
  }

  async function deliver(ctx, channel, post) {
    const ch = settings.channels().find((c) => c.id === channel);
    if (!ch) return null; // removed since
    const hook = deps.webhook(channel);
    if (!hook) throw new WebhookError('rejected');
    const plugin = ctx.byId.get(post.pid);
    const t = post.thread;
    if (post.type === 'kept') {
      let target = targetOf(t, ch);
      const mine = settings.message(channel, post.pid, post.gid, post.kind, target);
      if (!post.force && mine.messageId && mine.saved >= post.saved) return null;
      const pic = await post.picture();
      const msg = { content: post.text, username: post.group, files: pic ? [pic] : [] };
      if (mine.messageId) {
        try {
          await hook.edit(mine.messageId, { ...msg, threadId: mine.threadId });
          settings.setMessage(channel, post.pid, post.gid, post.kind, target, { saved: post.saved, name: post.group });
          log(plugin, ch, post.group, post.kindName, null, post.via);
          return 'edited';
        } catch (e) {
          if (!(e instanceof WebhookError) || e.code !== 'not-found') throw e;
          // Deleted in Discord: post a new one (the window asks again to pin it).
        }
      }
      const res = await postIn(settings, hook, ch, { ...msg, threadId: t && t.thread ? t.thread : undefined }, `${post.group} · ${post.kindName}`);
      if (!(t && t.thread)) target = res.forum ? 'f' : ''; // Discord may just have said what the channel is
      settings.setMessage(channel, post.pid, post.gid, post.kind, target, { messageId: res.id, saved: post.saved, name: post.group,
        threadId: res.forum ? res.channelId : t && t.thread ? t.thread : undefined });
      if (ctx.reason !== 'setup') settings.askPin({ channel: ch.name, group: post.group, kind: post.kindName }); // setup asks itself
      log(plugin, ch, post.group, post.kindName, null, post.via);
      return 'posted';
    }
    const files = await attachments(plugin, post);
    await postIn(settings, hook, ch, { content: post.content, username: post.group, files, mentionRoles: post.roles,
      threadId: t && t.thread ? t.thread : undefined }, post.title || post.content);
    settings.remember(channel, post.ids);
    settings.set({ lastPost: { time: deps.now() } });
    log(plugin, ch, post.group, post.kindName, null, post.via);
    return 'posted';
  }

  // A news post's files: the game's screenshots it names (the picture itself), then the plugin's pictures, at most 10
  // and 8 MB in all. One that cannot be found is left off, and the text goes without it.
  async function attachments(plugin, post) {
    const want = [...(post.shots || []).map((s) => () => (deps.screenshot ? deps.screenshot(s) : null)),
      ...(post.pictures || []).map((p) => () => (deps.picture && plugin ? deps.picture(plugin, p) : null))];
    const files = [];
    let bytes = 0;
    for (const get of want) {
      if (files.length >= MAX_PICTURES) break;
      let f = null;
      try { f = await get(); } catch (e) { f = null; }
      if (!f || bytes + f.data.length > MAX_UPLOAD) continue;
      bytes += f.data.length;
      files.push(f);
    }
    return files;
  }

  // A due digest as posts: the group's name, then one line per item, oldest first, each post at most 1900 characters,
  // with up to 10 of its items' screenshots and pictures.
  function digestPosts(d) {
    const items = d.posts.slice().sort((a, b) => a.time - b.time);
    const chunks = [];
    let cur = [];
    for (const it of items) {
      if (cur.length && escaped([d.group, ...cur.map((x) => x.content), it.content].join('\n')).length > MAX_CONTENT) { chunks.push(cur); cur = []; }
      cur.push(it);
    }
    if (cur.length) chunks.push(cur);
    return chunks.map((c) => ({
      type: 'news', pid: d.pid, gid: d.gid, group: d.group, kind: 'digest', kindName: [...new Set(c.map((x) => x.kindName))].join(', '),
      ids: c.flatMap((x) => x.ids), content: [d.group, ...c.map((x) => x.content)].join('\n'), digest: true,
      shots: c.flatMap((x) => x.shots || []).slice(0, MAX_PICTURES), pictures: c.flatMap((x) => x.pictures).slice(0, MAX_PICTURES),
      roles: [...new Set(c.flatMap((x) => x.roles))],
      thread: c[0].thread, title: d.group, time: c[c.length - 1].time, via: [...new Set([...c.flatMap((x) => x.via), 'digest'])],
    }));
  }

  // The posts steps held or gathered that are due now. One that fails waits for the next run.
  async function runPending(ctx, results) {
    const due = ctx.pending.filter((p) => p.due <= ctx.now);
    ctx.pending = ctx.pending.filter((p) => p.due > ctx.now);
    for (const p of due) {
      try {
        if (p.type === 'held') await walk(ctx, p.channel, p.steps, p.pos, p.post);
        else {
          const posts = digestPosts(p);
          for (let i = p.sent || 0; i < posts.length; i++) { await walk(ctx, p.channel, p.steps, p.pos, posts[i]); p.sent = i + 1; }
        }
      } catch (e) {
        ctx.pending.push(p);
        const ch = settings.channels().find((c) => c.id === p.channel);
        const problem = e instanceof WebhookError ? PROBLEM[e.code] || 'offline' : 'render-failed';
        results.push({ plugin: (ctx.byId.get(p.pid || (p.post && p.post.pid)) || {}).name || null, channel: ch ? ch.name : null,
          group: p.group || (p.post && p.post.group) || null, kept: null, news: 0, problem });
      }
    }
  }

  // ---------- The weekly summary ----------

  // On Sunday at 20:00 (or the first run after it), one summary per group of each plugin that has one. The first run
  // ever makes none for the week before (no backlog).
  function makeWeekly(used, read, now) {
    const w = settings.get('weekly') || {};
    const due = flows.weeklyDue(now);
    const items = { ...(w.items || {}) };
    let changed = due !== w.due;
    if (w.due && due > w.due) {
      for (const p of used.filter((x) => x.weekly)) {
        const r = read(p);
        if (r.error) continue;
        for (const g of Object.values(r.groups)) {
          const it = summary(p.weekly, g, settings.numbersOf(p.id, g.id), due);
          if (it) items[key(p.id, g.id)] = [...(items[key(p.id, g.id)] || []), it];
        }
      }
    }
    for (const [k, list] of Object.entries(items)) {
      const keep = list.filter((it) => it.time >= now - KEEP_WEEKLY);
      if (keep.length !== list.length) { changed = true; if (keep.length) items[k] = keep; else delete items[k]; }
    }
    if (changed) settings.set({ weekly: { due, items } });
  }

  // ---------- A run ----------

  // reason: 'file' (saved data changed), 'timer' (a step or the weekly summary is due), 'now' (Send to Discord now:
  // every kept message edited), 'setup' (the end of setup: kept messages posted, no backlog).
  async function sync(reason) {
    const now = deps.now();
    const channels = settings.channels();
    if (!channels.length) return status('not-set-up');
    const used = deps.plugins();
    const byId = new Map(used.map((p) => [p.id, p]));
    const reads = {};
    const read = (plugin) => (reads[plugin.id] = reads[plugin.id] || deps.read(plugin));

    // The groups saved now, and the numbers the weekly summary follows.
    for (const p of used) {
      const r = read(p);
      if (r.error) continue;
      for (const g of Object.values(r.groups)) {
        settings.seeGroup(p.id, g.id, now);
        if (Object.keys(g.numbers || {}).length) settings.recordNumbers(p.id, g.id, flows.dayKey(g.saved), g.numbers);
      }
    }
    makeWeekly(used, read, now);

    const lines = settings.lines();
    const chById = new Map(channels.map((c) => [c.id, c]));
    const kindOfBox = (box) => { const b = flows.parseBox(box); return b && b.type === 'kind' ? kindOf(byId.get(b.pid), b.kind) : null; };
    // The steps on each line's way: its rules, then its channel's times and thread. What a step holds finds its step
    // again by id, from any line.
    const stepsFor = (l) => flows.stepsOf(l, chById.get((flows.placeOf(l.to) || {}).channel), kindOfBox(l.from));
    const steps = new Map(lines.flatMap(stepsFor).map((s) => [s.id, s]));
    const toChannels = lines.filter((l) => chById.has((flows.placeOf(l.to) || {}).channel) && byId.has(flows.parseBox(l.from).pid));
    if (!toChannels.length) return status('nothing-followed');
    const routes = flows.routes(lines, (pid) => {
      const p = byId.get(pid);
      if (!p) return null;
      const r = read(p);
      return r.error ? [] : Object.keys(r.groups);
    }, kindOfBox).filter((r) => !r.shadowed && kindOf(byId.get(r.pid), r.kind));
    const newsOf = (r, g) => (r.kind === flows.WEEKLY ? weeklyItems(r.pid, r.gid) : g.news.filter((n) => n.kind === r.kind));

    if (reason === 'setup') {
      // Everything already in the outboxes counts as posted.
      for (const r of routes.filter((x) => !x.missing)) {
        const g = read(byId.get(r.pid)).groups[r.gid];
        settings.remember(r.channel, newsOf(r, g).map((n) => key(r.pid, r.gid, n.id)));
      }
      settings.restartAll(now);
      settings.set({ paused: false });
    }
    if (settings.get('paused') && reason !== 'now') return status(null, { paused: true });

    const ctx = { now, reason, byId, steps, pending: settings.pending(), pictures: {} };
    const results = [];
    const names = Object.fromEntries(settings.all().channels.map((c) => [c.id, c.names]));
    // A plugin whose saved data cannot be read: once, for the first channel it goes to.
    for (const p of used) {
      const r = read(p);
      const first = toChannels.find((x) => flows.parseBox(x.from).pid === p.id);
      if (r.error && first) results.push({ plugin: p.name, channel: chById.get(flows.placeOf(first.to).channel).name, group: null, kept: null, news: 0, problem: READ_PROBLEM[r.error] || 'unreadable' });
    }
    for (const r of routes) {
      const plugin = byId.get(r.pid);
      const kind = kindOf(plugin, r.kind);
      const ch = channels.find((c) => c.id === r.channel);
      if (!ch) continue;
      const base = { plugin: plugin.name, channel: ch.name, group: null, kept: null, news: 0, problem: null };
      if (r.missing) { results.push({ ...base, problem: 'no-group', group: (names[ch.id] || {})[key(r.pid, r.gid)] || null }); continue; }
      const g = read(plugin).groups[r.gid];
      const game = (read(plugin).from || {})[r.gid] || {}; // the game it was saved in: its Screenshots folder and art
      const way = stepsFor(r.line);
      const ids = way.map((s) => s.id);
      const res = { ...base, group: g.name };
      try {
        if (kind.type === 'kept') {
          const entry = g.kept[kind.id];
          if (entry) {
            const pk = key(r.pid, r.gid, kind.id);
            const post = { type: 'kept', pid: r.pid, gid: r.gid, group: g.name, kind: kind.id, kindName: kind.name, saved: g.saved, text: entry.text,
              via: [], force: reason === 'now' || reason === 'setup',
              picture: () => (ctx.pictures[pk] = ctx.pictures[pk] || Promise.resolve(deps.render(plugin, kind.id, entry, g, game.flavor || null))) };
            const done = await walk(ctx, r.channel, ids, 0, post);
            if (done === 'posted' || done === 'edited') { res.kept = done; settings.set({ lastPost: { time: deps.now() } }); }
          }
        } else {
          const posted = settings.posted(r.channel);
          const every = flows.parseBox(r.line.from).gid === flows.EVERY;
          // From when the line was drawn, the channel connected, the group first seen (Every) or its Only when last
          // changed: no backlog.
          const since = Math.max(r.line.since || 0, settings.since(r.channel), every ? settings.seeGroup(r.pid, r.gid, now) : 0,
            ...way.map((s) => s.since || 0));
          const items = newsOf(r, g).filter((n) => n.time >= since && !posted.has(key(r.pid, r.gid, n.id))).sort((a, b) => a.time - b.time);
          for (const n of items) {
            const post = { type: 'news', pid: r.pid, gid: r.gid, group: g.name, kind: kind.id, kindName: kind.name, ids: [key(r.pid, r.gid, n.id)],
              content: n.text, pictures: n.picture ? [typeof n.picture === 'string' ? n.picture : { ...n.picture, flavor: game.flavor || null }] : [], shots: n.screenshot ? [{ flavor: game.flavor || null, time: n.screenshot }] : [],
              fields: n.fields || null, roles: [], thread: null, title: n.name || n.text, time: n.time, via: [] };
            if (await walk(ctx, r.channel, ids, 0, post) === 'posted') res.news++;
          }
        }
      } catch (e) {
        res.problem = e instanceof WebhookError ? PROBLEM[e.code] || 'offline' : 'render-failed';
        if (!(e instanceof WebhookError)) res.detail = String(e && e.message);
        log(plugin, ch, g.name, kind.name, res.problem);
      }
      results.push(res);
    }
    await runPending(ctx, results);
    settings.setPending(ctx.pending);

    const bad = results.find((r) => r.problem);
    return status(bad ? bad.problem : null, {
      plugin: bad ? bad.plugin : null, channel: bad ? bad.channel : null, group: bad ? bad.group : null, results,
      kept: results.some((r) => r.kept === 'posted') ? 'posted' : results.some((r) => r.kept === 'edited') ? 'edited' : null,
      news: results.reduce((n, r) => n + r.news, 0),
    });
  }

  const serial = (fn) => {
    const run = running.then(fn);
    running = run.catch(() => {});
    return run;
  };

  return {
    // One run at a time: a save while posting waits for the run before it.
    sync: (reason) => serial(() => sync(reason)),
    // Whether a run is due without a save: a gathered or held post is due, the weekly summary is due, or a channel's
    // quiet hours just ended (kept messages wait for them). The app asks every minute.
    isDue(now) {
      if (settings.pending().some((p) => p.due <= now)) return true;
      const w = settings.get('weekly') || {};
      if (w.due && flows.weeklyDue(now) > w.due) return true;
      let ended = false;
      for (const c of settings.channels().filter((x) => x.quiet)) {
        const q = flows.inQuiet(c.quiet, now);
        if (quietWas.get(c.id) === true && !q) ended = true;
        quietWas.set(c.id, q);
      }
      return ended;
    },
    // Pause / resume. Resuming posts no backlog: news from now on only.
    setPaused(paused) {
      settings.set({ paused: !!paused });
      if (!paused) settings.restartAll(deps.now());
    },
  };
}

module.exports = { createPoster, postIn };
