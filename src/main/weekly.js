'use strict';
// The weekly summary (SPEC §5.3, docs/PLUGINS.md §5): a news item the app makes for each group on Sunday at 20:00,
// in the plugin's own words. It goes where its kind's lines go, like any other news. No Electron here.
const { WEEKLY, dayKey } = require('./flows');

const WEEK = 7 * 86400;
const fill = (s, vals) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? String(vals[k]) : ''));

// The numbers of the last record on or before `day` ("YYYY-MM-DD"), else null.
function recordAt(records, day) {
  const days = Object.keys(records).filter((d) => d <= day).sort();
  return days.length ? records[days[days.length - 1]] : null;
}

// The summary of group g for the week that ended at `due` (Unix seconds), or null when nothing changed.
// records: the app's daily copies of the group's numbers ({ "YYYY-MM-DD": { name: number } }).
function summary(weekly, g, records, due) {
  const to = recordAt(records, dayKey(due));
  // A week ago, or the first record of the week when the app started keeping them during it.
  const from = recordAt(records, dayKey(due - WEEK)) || recordAt(records, Object.keys(records).filter((d) => d > dayKey(due - WEEK)).sort()[0] || '');
  const changed = to && from ? Object.keys(to).filter((n) => typeof from[n] === 'number' && from[n] !== to[n])
    .sort((a, b) => (to[b] - from[b]) - (to[a] - from[a]) || a.localeCompare(b)) : [];
  const numbers = weekly.number ? changed.map((n) => fill(weekly.number, { name: n, from: from[n], to: to[n] })).join(', ') : '';
  const news = [];
  for (const e of weekly.news) {
    const names = [...new Set(g.news.filter((n) => n.kind === e.kind && n.time > due - WEEK && n.time <= due && n.name).map((n) => n.name))];
    if (names.length) news.push(fill(e.text, { list: names.join(', '), group: g.name }));
  }
  if (!numbers && !news.length) return null;
  const head = fill(weekly.head, { group: g.name });
  return { id: `${WEEKLY}:${dayKey(due)}`, kind: WEEKLY, time: due, text: [numbers ? head + ' ' + numbers : head, ...news].join(weekly.separator),
    name: null, picture: null };
}

module.exports = { summary, WEEK };
