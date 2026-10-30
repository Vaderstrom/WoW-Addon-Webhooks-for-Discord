// A sample code plugin (docs/PLUGINS.md §7). Simple Scores, a made-up addon, saves each character's level and kills
// and writes no outbox; this makes one: a kept "Scores" message for the account, and a news post when a character
// gains a level. It finds that out from what it returned last time (`last`): the app ignores the `levels` it keeps
// there, but gives them back.
export default function build(saved, last, ctx) {
  const db = saved.SimpleScoresDB;
  if (!db || typeof db.characters !== 'object') return null;
  const chars = Object.entries(db.characters).sort(([a], [b]) => a.localeCompare(b));
  const before = (last && last.groups && last.groups.scores) || {};
  const was = before.levels || {};
  const news = Array.isArray(before.news) ? before.news.slice() : [];
  const levels = {};
  for (const [name, c] of chars) {
    levels[name] = c.level;
    if (was[name] != null && c.level > was[name]) {
      const short = name.split('-')[0];
      news.push({ id: `level:${name}:${c.level}`, kind: 'level', time: db.saved || ctx.now,
        text: `${short} reached level ${c.level}!`, fields: { level: c.level, who: [short] } });
    }
  }
  return {
    format: 1,
    groups: {
      scores: {
        name: 'Simple Scores',
        sub: chars.length + ' characters',
        saved: db.saved || ctx.now,
        kept: { scores: { text: chars.map(([n, c]) => `${n.split('-')[0]}: level ${c.level}, ${c.kills} kills`).join('\n') } },
        news: news.slice(-20),
        levels,
      },
    },
  };
}
