'use strict';
// The app's settings, in one JSON file in its user data folder. Webhook URLs are stored encrypted with the system's
// key store (Electron safeStorage: DPAPI on Windows), never as plain text.
// - sources: the games watched, [{ flavor, account }] in the WoW folder.
// - plugins: per plugin id, { use } (a plugin found for the first time is not used until the player says so).
// - channels: each has a name and a webhook, its quiet hours (or null), its daily post's time (digest) and the
//   threads the player added ([{ id, name }]). It keeps its kept messages (messages["plugin|group|kind|target"] =
//   { messageId, threadId, saved, name }; target: "" the channel itself, "t:<id>" a thread, "f" a forum post) and the
//   news ids it posted ("plugin|group|newsId").
// - flows (SPEC §5.1): lines [{ from, to, since, n, only, onlySince (when Only when last changed), mention, gather }]
//   from a kind to a place (src/main/flows.js). Before, a channel had follow[pluginId] = { kinds, groups, role, since }
//   (W1–W2), then lines ran through step boxes (W3–W4, steps [{ id, type, options }]); migrate() makes lines of
//   either, once (flows: 2).
// - seen["plugin|group"]: when the app first saw a group (Every {group} takes its news from then on).
// - pending: posts a Digest gathers or Quiet hours hold, kept here so they survive the app closing.
// - numbers["plugin|group"] = { "YYYY-MM-DD": numbers } (15 days) and weekly = { due, items: { "plugin|group": [item] } }:
//   the weekly summary's record and the summaries made.
// - log: the last posts and failures.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const flows = require('./flows');

const LOG_KEEP = 50;
const POSTED_KEEP = 2000;
const MAX_LINES = 300;
const MAX_THREADS = 20;
const NUMBER_DAYS = 15;

const DEFAULTS = {
  wowFolder: null, sources: [], plugins: {}, channels: [],
  lines: [], nextLine: 1, seen: {}, pending: [], numbers: {}, weekly: { due: 0, items: {} },
  flows: 0,               // 2 once the choices from before (W1–W2 ticks, W3–W4 steps) became lines
  paused: false, startWithWindows: true, notices: true, setupDone: false,
  lastPost: null,         // { time }
  pinAsks: [],            // kept messages posted anew after setup, for the player to pin: [{ channel, group, kind }]
  problem: null,          // the last problem's key, or null
  log: [],
};

const cleanIds = (list, max = 200) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.length <= max))];
// A Discord role ID (digits), or '' for none.
const cleanRole = (r) => (/^\d{5,25}$/.test(String(r || '').trim()) ? String(r).trim() : '');
const key = (...parts) => parts.join('|');
const copy = (v) => JSON.parse(JSON.stringify(v));

// keys: { isEncryptionAvailable(), encryptString(s) → Buffer, decryptString(Buffer) → string }
function createSettings(dir, keys) {
  const file = path.join(dir, 'settings.json');
  const fresh = () => copy(DEFAULTS);
  let data = fresh(), isNew = false;
  // (A file edited by hand may start with a byte-order mark: JSON.parse refuses it.)
  try { data = { ...fresh(), ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) }; } catch (e) { isNew = !fs.existsSync(file); }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  const find = (id) => data.channels.find((c) => c.id === id);
  const lineOf = (from, to) => data.lines.find((l) => l.from === from && l.to === to);
  // A channel's times, as set or as they start (a channel from before W5 has none stored).
  const times = (c) => ({ quiet: c.quiet ? flows.cleanOptions('quiet', c.quiet) : null, digest: flows.cleanOptions('digest', c.digest),
    threads: (Array.isArray(c.threads) ? c.threads : []).map((t) => ({ id: t.id, name: t.name })) });
  // A channel as the window may see it: never its URL.
  const view = (c) => ({
    id: c.id, name: c.name, forum: !!c.forum, ...times(c),
    // Last known group names, for a group no longer saved: { "plugin|group": name }.
    names: Object.fromEntries(Object.entries(c.messages || {}).filter(([, m]) => m && m.name).map(([k, m]) => [k.split('|').slice(0, 2).join('|'), m.name])),
    posted: Object.values(c.messages || {}).some((m) => m && m.messageId),
  });

  return {
    get: (k) => data[k],
    set(values) { Object.assign(data, values); save(); },
    // What the window sees: no webhook URLs, and not the app's own records.
    all: () => ({ ...copy(data), channels: data.channels.map(view), pending: undefined, numbers: undefined, seen: undefined }),
    channels: () => data.channels.map((c) => ({ ...copy(c), ...times(c) })),
    file,
    isNew, // no settings file yet: the first start

    setSources(list) {
      data.sources = (Array.isArray(list) ? list : []).filter((s) => s && typeof s.flavor === 'string' && typeof s.account === 'string')
        .map((s) => ({ flavor: s.flavor, account: s.account }));
      save();
    },

    // Plugins: undefined (never asked), true or false.
    used: (pid) => (data.plugins[pid] ? data.plugins[pid].use : undefined),
    usePlugin(pid, on) { data.plugins[pid] = { ...(data.plugins[pid] || {}), use: !!on }; save(); },

    // A new channel. Returns its id, or null when the URL cannot be stored safely.
    addChannel(name, url, now) {
      if (!keys.isEncryptionAvailable()) return null;
      const c = { id: crypto.randomBytes(6).toString('hex'), name: String(name || '').trim().slice(0, 60) || 'Discord',
        webhook: keys.encryptString(url).toString('base64'), since: now || 0, messages: {}, posted: [],
        quiet: null, digest: flows.DEFAULTS.digest(), threads: [] };
      data.channels.push(c);
      save();
      return c.id;
    },
    // What Discord said the channel is: a forum channel takes only forum posts (docs/SPEC.md §5.3).
    setForum(id, on) { const c = find(id); if (c && !!c.forum !== !!on) { c.forum = !!on; save(); } },
    rename(id, name) { const c = find(id); if (c && String(name || '').trim()) { c.name = String(name).trim().slice(0, 60); save(); } return !!c; },
    // A channel goes with its threads and every line to them.
    removeChannel(id) {
      const before = data.channels.length;
      data.channels = data.channels.filter((c) => c.id !== id);
      data.lines = data.lines.filter((l) => (flows.placeOf(l.to) || {}).channel !== id);
      save();
      return data.channels.length < before;
    },
    // Quiet hours (null: off) and the daily post's time. A daily post set to another time posts what it gathered at
    // the new time.
    setChannel(id, values, now) {
      const c = find(id);
      if (!c || !values || typeof values !== 'object') return false;
      const t = times(c);
      if ('quiet' in values) c.quiet = values.quiet ? flows.cleanOptions('quiet', { ...(t.quiet || {}), ...values.quiet }) : null;
      if ('digest' in values) {
        c.digest = flows.cleanOptions('digest', { ...t.digest, ...(values.digest || {}) });
        if (JSON.stringify(c.digest) !== JSON.stringify(t.digest)) {
          for (const p of data.pending) if (p.type === 'digest' && p.channel === id) p.due = flows.digestDue(c.digest, now || 0);
        }
      }
      save();
      return true;
    },
    // A thread of the channel, from its link or ID, with a name for the app. Returns its ID, or null.
    addThread(id, link, name) {
      const c = find(id);
      const tid = flows.cleanOptions('thread', { thread: link }).thread;
      if (!c || !tid) return null;
      c.threads = Array.isArray(c.threads) ? c.threads : [];
      if (c.threads.some((t) => t.id === tid) || c.threads.length >= MAX_THREADS) return null;
      c.threads.push({ id: tid, name: String(name || '').trim().slice(0, 60) || 'Thread' });
      save();
      return tid;
    },
    renameThread(id, tid, name) {
      const t = ((find(id) || {}).threads || []).find((x) => x.id === tid);
      if (!t || !String(name || '').trim()) return false;
      t.name = String(name).trim().slice(0, 60);
      save();
      return true;
    },
    // A thread goes with its lines.
    removeThread(id, tid) {
      const c = find(id);
      if (!c || !(c.threads || []).some((t) => t.id === tid)) return false;
      c.threads = c.threads.filter((t) => t.id !== tid);
      const box = flows.threadBox(id, tid);
      data.lines = data.lines.filter((l) => l.to !== box);
      save();
      return true;
    },
    channelUrl(id) {
      const c = find(id);
      if (!c || !c.webhook) return null;
      try { return keys.decryptString(Buffer.from(c.webhook, 'base64')); } catch (e) { return null; }
    },

    // ---------- Flows ----------
    lines: () => copy(data.lines),
    // A line drawn now brings no news from before now (no backlog). The caller checks it first (flows.check).
    addLine(from, to, now) {
      if (data.lines.length >= MAX_LINES || lineOf(from, to)) return false;
      data.lines.push({ from, to, since: now || 0, n: data.nextLine++, ...flows.cleanRules(null), onlySince: 0 });
      save();
      return true;
    },
    removeLine(from, to) {
      const before = data.lines.length;
      data.lines = data.lines.filter((l) => !(l.from === from && l.to === to));
      save();
      return data.lines.length < before;
    },
    // A line's rules (only, mention, gather; one left out stays as it is, null turns it off). An Only when that changes
    // starts from then: what it held back before is not posted now (no backlog).
    setLine(from, to, rules, now) {
      const l = lineOf(from, to);
      if (!l || !rules || typeof rules !== 'object') return false;
      const next = flows.cleanRules({ only: l.only, mention: l.mention, gather: l.gather, ...rules });
      if (JSON.stringify(next.only) !== JSON.stringify(l.only || null)) l.onlySince = now || 0;
      Object.assign(l, next);
      save();
      return true;
    },

    // When the app first saw a group: Every {group} takes its news from then on.
    seeGroup(pid, gid, now) {
      const k = key(pid, gid);
      if (data.seen[k] == null) { data.seen[k] = now || 0; save(); }
      return data.seen[k];
    },
    pending: () => copy(data.pending),
    setPending(list) { data.pending = list; save(); },
    // The weekly summary's daily record of a group's numbers.
    recordNumbers(pid, gid, day, numbers) {
      const k = key(pid, gid);
      const rec = data.numbers[k] = data.numbers[k] || {};
      if (JSON.stringify(rec[day]) === JSON.stringify(numbers)) return;
      rec[day] = numbers;
      for (const d of Object.keys(rec).sort().slice(0, -NUMBER_DAYS)) delete rec[d];
      save();
    },
    numbersOf: (pid, gid) => copy(data.numbers[key(pid, gid)] || {}),

    // The choices from before as lines, once (SPEC §5.1). W1–W2: each ticked kind of each ticked group to its channel,
    // the channel's role as the mention of the kinds that allow one (kindOf(pid, kindId) → kind | null). W3–W4: each
    // path through step boxes as one line (flows.fromSteps). Posts a step box still held are posted at their time.
    migrate(kindOf, threadName = 'Thread') {
      if (data.flows >= 2) return false;
      const line = (from, to, since, mention) => ({ from, to, since, n: data.nextLine++, ...flows.cleanRules({ mention }), onlySince: 0 });
      if (data.flows === 1) {
        const res = flows.fromSteps(data.lines, data.steps);
        data.lines = res.lines.map((l) => ({ ...l, n: data.nextLine++ }));
        for (const c of data.channels) {
          const m = res.channels[c.id] || { quiet: null, digest: null, threads: [] };
          c.quiet = m.quiet; c.digest = m.digest || flows.DEFAULTS.digest();
          c.threads = m.threads.map((id, i) => ({ id, name: m.threads.length > 1 ? `${threadName} ${i + 1}` : threadName }));
        }
      }
      for (const c of data.channels) {
        for (const [pid, f] of Object.entries(c.follow || {})) {
          if (!f || typeof f !== 'object') continue;
          const role = cleanRole(f.role);
          for (const gid of cleanIds(f.groups)) {
            for (const kid of Object.keys(f.kinds || {})) {
              const from = flows.kindBox(pid, gid, kid), to = flows.channelBox(c.id);
              if (lineOf(from, to)) continue;
              const since = Math.max(c.since || 0, (f.since && f.since[kid]) || 0, (c.groupSince && c.groupSince[key(pid, gid)]) || 0);
              const kind = kindOf(pid, kid);
              data.lines.push(line(from, to, since, role && kind && flows.takes('mention', kind) ? { role } : null));
            }
          }
        }
        // Kept messages are kept per target now: "" is the channel itself.
        c.messages = Object.fromEntries(Object.entries(c.messages || {}).map(([k, m]) => [k.split('|').length === 3 ? k + '|' : k, m]));
        delete c.follow; delete c.groupSince;
        if (!('digest' in c)) { c.quiet = null; c.digest = flows.DEFAULTS.digest(); c.threads = []; }
      }
      delete data.steps; delete data.places; delete data.quietWas;
      data.flows = 2;
      save();
      return true;
    },

    // Kept messages: message(channel, plugin, group, kind, target) → { messageId, threadId, saved, name } or {}.
    message: (id, pid, gid, kind, target) => { const c = find(id); return (c && c.messages[key(pid, gid, kind, target || '')]) || {}; },
    setMessage(id, pid, gid, kind, target, values) {
      const c = find(id);
      if (!c) return;
      const k = key(pid, gid, kind, target || '');
      c.messages[k] = { ...(c.messages[k] || {}), ...values };
      save();
    },
    // News: the ids each channel posted (or a step took on its way there), and from when a channel takes news.
    posted: (id) => new Set((find(id) || {}).posted || []),
    remember(id, ids) {
      const c = find(id);
      if (!c || !ids.length) return;
      const set = new Set(c.posted);
      for (const x of ids) { set.delete(x); set.add(x); }
      c.posted = [...set].slice(-POSTED_KEEP);
      save();
    },
    since: (id) => { const c = find(id); return c ? c.since || 0 : Infinity; },
    // From now on for every channel (a pause ended): no backlog.
    restartAll(now) { for (const c of data.channels) c.since = now || 0; save(); },

    // Recent posts: { time, plugin, channel, group, kind, via, problem }, newest first.
    // A kept message posted anew (deleted in Discord, or a new line): the window asks to pin it (SPEC §5.3).
    askPin(entry) {
      const same = (x) => x.channel === entry.channel && x.group === entry.group && x.kind === entry.kind;
      data.pinAsks = [...(data.pinAsks || []).filter((x) => !same(x)), entry].slice(-10);
      save();
    },
    clearPinAsks() { data.pinAsks = []; save(); },
    addLog(entry) { data.log = [entry, ...(data.log || [])].slice(0, LOG_KEEP); save(); },
  };
}

// What the first start takes from the Journey Together Companion's settings (SPEC §9): where the game is, the game
// versions watched and the two options. Its channels stay behind: their webhook URLs are encrypted with the
// Companion's own key, which this app cannot read. Null when there is nothing to take.
function fromCompanion(old) {
  if (!old || typeof old !== 'object' || Array.isArray(old)) return null;
  const sources = Array.isArray(old.sources) ? old.sources
    : (typeof old.flavor === 'string' && typeof old.account === 'string' ? [{ flavor: old.flavor, account: old.account }] : []);
  const out = {
    wowFolder: typeof old.wowFolder === 'string' && old.wowFolder ? old.wowFolder : null,
    sources: sources.filter((s) => s && typeof s.flavor === 'string' && typeof s.account === 'string')
      .map((s) => ({ flavor: s.flavor, account: s.account })),
    startWithWindows: old.startWithWindows !== false,
    notices: old.notices !== false,
  };
  return out.wowFolder ? out : null;
}

module.exports = { createSettings, fromCompanion, DEFAULTS, key };
