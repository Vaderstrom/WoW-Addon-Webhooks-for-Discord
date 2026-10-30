'use strict';
// Flows (SPEC §5.1, §5.2): what goes where, as lines from what an addon posts to where it goes in Discord. No
// Electron here, so it can be tested.
// - Kind boxes are the tree on the left: one per plugin, group and kind, never stored. Their id is
//   "k:<plugin>|<group>|<kind>", where the group "*" is Every {group} (every group, also ones saved later).
// - Places are on the right: a connected webhook's channel ("c:<channel id>") or a thread the player added to it
//   ("t:<channel id>:<thread id>").
// A line goes from a kind to a place; n is the order it was drawn in (the first drawn wins). Its rules: only (Only
// when), mention (Mention a role) and gather (into its place's daily post). A channel has its quiet hours and its
// daily post's time. On the way to Discord each of these is a step of the posting (src/main/poster.js), in the order
// Only when, the mention, the daily post, quiet hours, the thread.

const EVERY = '*';
const WEEKLY = 'weekly';
const DEFAULTS = {
  only: () => ({ field: '', op: 'is', value: '' }),
  mention: () => ({ role: '', name: '' }),
  digest: () => ({ every: 'day', at: '21:00' }),
  quiet: () => ({ from: '23:00', to: '08:00' }),
  thread: () => ({ thread: '' }),
};
// Only when's tests by the field's type (docs/PLUGINS.md §2): the first is where a new field starts.
const OPS = { number: ['is', 'not', 'min', 'max'], text: ['is', 'not'], names: ['has', 'lacks'] };

const kindBox = (pid, gid, kind) => `k:${pid}|${gid}|${kind}`;
const channelBox = (id) => `c:${id}`;
const threadBox = (channel, thread) => `t:${channel}:${thread}`;
function parseBox(box) {
  if (typeof box !== 'string') return null;
  if (box.startsWith('k:')) {
    const [pid, gid, kind] = box.slice(2).split('|');
    return pid && gid && kind ? { type: 'kind', pid, gid, kind } : null;
  }
  if (box.startsWith('c:') && box.length > 2) return { type: 'channel', channel: box.slice(2), thread: null };
  if (box.startsWith('t:')) {
    const [channel, thread] = box.slice(2).split(':');
    return channel && thread ? { type: 'thread', channel, thread } : null;
  }
  return null;
}
// Where a line ends: { channel, thread (null: the channel itself) }, or null when the box is no place.
function placeOf(box) {
  const b = parseBox(box);
  return b && (b.type === 'channel' || b.type === 'thread') ? { channel: b.channel, thread: b.thread } : null;
}

// A plugin's kinds as the tree shows them: its own, and the weekly summary when it has one (a news kind the app makes).
function pluginKinds(plugin) {
  const list = plugin.kinds.map((k) => ({ ...k }));
  if (plugin.weekly) list.push({ id: WEEKLY, type: 'news', name: plugin.weekly.name, help: plugin.weekly.help, default: false, mention: false, weekly: true });
  return list;
}

// Which rules a kind takes (SPEC §5.2): null when it takes the rule, else the reason.
function refuses(rule, kind) {
  if (rule === 'mention' && (kind.type !== 'news' || !kind.mention)) return 'mention';
  if (rule === 'gather' && (kind.type !== 'news' || kind.weekly)) return 'gather';
  if (rule === 'only' && (kind.type !== 'news' || !(kind.fields && kind.fields.length))) return 'only';
  return null;
}
const takes = (rule, kind) => !!kind && !refuses(rule, kind);

// Whether an item's fields pass Only when. An item without the field never does, nor does one not set yet. Text and
// names match whatever the case, and may name several values with commas: any of them ("does not include": none).
function passes(o, fields) {
  const v = fields && o && o.field ? fields[o.field] : undefined;
  if (v === undefined || o.value === '') return false;
  const n = Number(o.value);
  if (o.op === 'min' || o.op === 'max') return typeof v === 'number' && Number.isFinite(n) && (o.op === 'min' ? v >= n : v <= n);
  const want = o.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const same = (x) => (typeof x === 'number' ? x === n : want.includes(String(x).toLowerCase()));
  const hit = Array.isArray(v) ? v.some(same) : same(v);
  return o.op === 'not' || o.op === 'lacks' ? !hit : hit;
}

// ---------- Lines ----------

// Whether a line from → to may be drawn. ctx: { lines, kindOf(kindBox) → kind | null, hasPlace(box) }. Returns null,
// or { problem }: 'bad' (no such kind or place, or the wrong way round), 'twice'.
function check(ctx, from, to) {
  const f = parseBox(from);
  if (!f || f.type !== 'kind' || !ctx.kindOf(from) || !placeOf(to) || !ctx.hasPlace(to)) return { problem: 'bad' };
  if (ctx.lines.some((l) => l.from === from && l.to === to)) return { problem: 'twice' };
  return null;
}
// The places of tos a line from `from` may go to: what the kind's Send to… offers.
const allowed = (ctx, from, tos) => tos.filter((to) => !check(ctx, from, to));

// The steps a post meets on its way along line l, for its kind (a rule the kind cannot take is left out). channel: the
// settings of the line's channel ({ id, quiet, digest }). Ids are stable, so what a step holds finds it again: a line's
// own rules by its n; the daily post by its place (every line that gathers there shares it); quiet hours by channel.
function stepsOf(l, channel, kind) {
  const p = placeOf(l.to);
  if (!p || !channel || !kind) return [];
  const out = [];
  if (l.only && takes('only', kind)) out.push({ id: 'o' + l.n, type: 'only', options: l.only, since: l.onlySince || 0 });
  if (l.mention && l.mention.role && takes('mention', kind)) out.push({ id: 'm' + l.n, type: 'mention', options: l.mention });
  if (l.gather && takes('gather', kind)) out.push({ id: 'd' + l.to, type: 'digest', options: channel.digest || DEFAULTS.digest() });
  if (channel.quiet) out.push({ id: 'q' + channel.id, type: 'quiet', options: channel.quiet });
  if (p.thread) out.push({ id: 'th' + p.thread, type: 'thread', options: { thread: p.thread } });
  return out;
}

// The routes to post along, in the order the lines were drawn: each line for each group it covers (Every: every group
// saved now), with duplicates marked. groupsOf(pid) → [group ids] | null (the plugin's saved data could not be read);
// kindOf(kindBox) → kind | null. A route: { line, pid, gid, kind, channel, thread, filtered, missing, shadowed }.
function routes(lines, groupsOf, kindOf) {
  const out = [];
  for (const l of lines.slice().sort((a, b) => a.n - b.n)) {
    const k = parseBox(l.from), p = placeOf(l.to);
    if (!k || k.type !== 'kind' || !p) continue;
    const saved = groupsOf(k.pid);
    if (!saved) continue;
    const filtered = !!l.only && (!kindOf || takes('only', kindOf(l.from)));
    for (const g of k.gid === EVERY ? saved : [k.gid]) {
      out.push({ line: l, pid: k.pid, gid: g, kind: k.kind, channel: p.channel, thread: p.thread, filtered, missing: k.gid !== EVERY && !saved.includes(g), shadowed: false });
    }
  }
  // Posted once per channel: of two routes bringing the same group's kind to one channel (or a thread of it), the one
  // drawn first counts. A route with Only when brings only some items, so it never stands in for a later one: each item
  // then goes the first way that lets it through (news is remembered per channel).
  const best = new Map();
  for (const r of out) {
    const k = [r.channel, r.pid, r.gid, r.kind].join('|');
    if (r.missing) continue;
    if (best.has(k)) r.shadowed = true;
    else if (!r.filtered) best.set(k, r);
  }
  return out;
}

// ---------- Times (the player's computer's clock) ----------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => { const m = HHMM.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minuteOfDay = (sec) => { const d = new Date(sec * 1000); return d.getHours() * 60 + d.getMinutes(); };
// The first time after `sec` (Unix seconds) the clock shows hh:mm.
function nextAt(sec, hhmm) {
  const want = minutesOf(hhmm);
  const d = new Date(sec * 1000);
  d.setHours(Math.floor(want / 60), want % 60, 0, 0);
  if (d.getTime() / 1000 <= sec) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
function inQuiet(o, sec) {
  const from = minutesOf(o.from), to = minutesOf(o.to), m = minuteOfDay(sec);
  if (from == null || to == null || from === to) return false;
  return from < to ? m >= from && m < to : m >= from || m < to;
}
// When a daily post gathered from `sec` on is due: the next full hour, or the next "at".
function digestDue(o, sec) {
  if (o.every === 'hour') { const d = new Date(sec * 1000); d.setMinutes(60, 0, 0); return Math.floor(d.getTime() / 1000); }
  return nextAt(sec, o.at);
}
// The last Sunday 20:00 at or before `sec`: when the weekly summary was due.
function weeklyDue(sec) {
  const d = new Date(sec * 1000);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(20, 0, 0, 0);
  if (d.getTime() / 1000 > sec) d.setDate(d.getDate() - 7);
  return Math.floor(d.getTime() / 1000);
}
function dayKey(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- What the player sets, checked ----------

// A rule's or a channel setting's options: anything wrong falls back to the defaults.
function cleanOptions(type, o) {
  const d = DEFAULTS[type]();
  o = o && typeof o === 'object' ? o : {};
  if (type === 'mention') {
    // A role ID, and a name the app shows for it ("Fellowship" for @Fellowship; Discord never tells a webhook).
    return { role: /^\d{5,25}$/.test(String(o.role || '').trim()) ? String(o.role).trim() : '',
      name: String(typeof o.name === 'string' ? o.name : '').trim().replace(/^@+/, '').slice(0, 40) };
  }
  if (type === 'digest') return { every: o.every === 'hour' ? 'hour' : 'day', at: HHMM.test(o.at || '') ? o.at : d.at };
  if (type === 'quiet') return { from: HHMM.test(o.from || '') ? o.from : d.from, to: HHMM.test(o.to || '') ? o.to : d.to };
  if (type === 'thread') {
    // A thread's link (https://discord.com/channels/<server>/<thread>) or its ID.
    const m = /(\d{5,25})\/?$/.exec(String(o.thread || '').trim());
    return { thread: m ? m[1] : '' };
  }
  if (type === 'only') {
    // A field the plugin names (which kinds have it is the window's to say), a test, and the value to test against.
    const field = /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(o.field || '') ? o.field : '';
    const op = Object.values(OPS).flat().includes(o.op) ? o.op : d.op;
    return { field, op, value: typeof o.value === 'string' || typeof o.value === 'number' ? String(o.value).trim().slice(0, 100) : '' };
  }
  return d;
}
// A line's rules: null for a rule that is off.
const cleanRules = (r) => ({
  only: r && r.only ? cleanOptions('only', r.only) : null,
  mention: r && r.mention ? cleanOptions('mention', r.mention) : null,
  gather: !!(r && r.gather),
});

// ---------- From the step boxes of W3–W4 ----------

// Every path of the old lines from a kind box, through step boxes ("s:<id>"), to a channel, in the order drawn.
function stepPaths(lines) {
  const out = new Map();
  for (const l of lines) { if (!out.has(l.from)) out.set(l.from, []); out.get(l.from).push(l); }
  for (const list of out.values()) list.sort((a, b) => a.n - b.n);
  const list = [];
  for (const start of [...new Set(lines.map((l) => l.from))].filter((b) => b.startsWith('k:'))) {
    (function walk(box, steps, rank, since, seen) {
      for (const l of (out.get(box) || []).filter((x) => !seen.has(x.to))) {
        const s = Math.max(since, l.since || 0);
        if (l.to.startsWith('c:')) list.push({ from: start, steps, channel: l.to.slice(2), rank: [...rank, l.n], since: s });
        else if (l.to.startsWith('s:')) walk(l.to, [...steps, l.to.slice(2)], [...rank, l.n], s, new Set([...seen, l.to]));
      }
    })(start, [], [], 0, new Set([start]));
  }
  const before = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
  return list.sort((a, b) => before(a.rank, b.rank));
}
// The flows of W3–W4 as lines (SPEC §5.1, Choices from before): each path to a channel becomes one line from its kind
// to that channel, or to the thread its Into a thread named, with its Only if, Mention a role and Digest as the line's
// rules. The first Digest and the first Quiet hours on the way to a channel become that channel's; paths that went
// nowhere are dropped. Returns { lines, channels: { id: { quiet, digest, threads: [thread ids] } } }.
function fromSteps(oldLines, oldSteps) {
  const stepOf = new Map((oldSteps || []).map((s) => [s.id, s]));
  const lines = [], channels = {};
  for (const p of stepPaths(oldLines || [])) {
    const ss = p.steps.map((id) => stepOf.get(id)).filter(Boolean);
    const first = (type) => ss.find((s) => s.type === type);
    const only = first('only'), mention = first('mention'), digest = first('digest'), quiet = first('quiet'), thread = first('thread');
    const ch = channels[p.channel] = channels[p.channel] || { quiet: null, digest: null, threads: [] };
    if (digest && !ch.digest) ch.digest = cleanOptions('digest', digest.options);
    if (quiet && !ch.quiet) ch.quiet = cleanOptions('quiet', quiet.options);
    const tid = thread ? cleanOptions('thread', thread.options).thread : '';
    if (tid && !ch.threads.includes(tid)) ch.threads.push(tid);
    const to = tid ? threadBox(p.channel, tid) : channelBox(p.channel);
    if (lines.some((l) => l.from === p.from && l.to === to)) continue;
    const role = mention ? cleanOptions('mention', mention.options) : null;
    lines.push({ from: p.from, to, since: p.since, n: lines.length + 1, only: only ? cleanOptions('only', only.options) : null,
      onlySince: only ? only.since || 0 : 0, mention: role && role.role ? role : null, gather: !!digest });
  }
  return { lines, channels };
}

module.exports = { EVERY, WEEKLY, DEFAULTS, OPS, kindBox, channelBox, threadBox, parseBox, placeOf, pluginKinds, refuses, takes,
  passes, check, allowed, stepsOf, routes, inQuiet, nextAt, digestDue, weeklyDue, dayKey, minutesOf, cleanOptions, cleanRules, fromSteps };
