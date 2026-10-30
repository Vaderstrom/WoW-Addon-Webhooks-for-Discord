'use strict';
// Code plugins' outboxes (SPEC §6, docs/PLUGINS.md §7). A code plugin's script runs on each watched game's saved data
// of its addon when that file changed since its last run (or the plugin was installed again), one script at a time.
// What it returns is checked like any addon's outbox (src/main/outbox.js) and kept as that game's outbox; it is also
// what the script gets as `last` next time, kept on disk so a restart does not lose it. A script that fails posts
// nothing from that file until it runs well again, and problem() says why.
const fs = require('fs');
const path = require('path');
const { parse } = require('./lua-table');
const outbox = require('./outbox');

const MAX_LAST = 4 * 1024 * 1024; // a bigger result is used, but not kept for next time

// Where a plugin's last result for one game's saved data is kept: <stateDir>/<id>/<flavor>~<account>.json.
const lastPath = (stateDir, pid, s) => path.join(stateDir, pid, (s.flavor + '~' + s.account).replace(/[^A-Za-z0-9_.~-]/g, '_') + '.json');

// run(plugin, { saved, last, ctx }) → { json } (what the script returned, as JSON text) | { problem, detail }: the
// sandbox (src/main/run-script.js). stateDir: where each plugin's last results are kept, <stateDir>/<id>/.
function createScripts({ run, stateDir, now }) {
  const done = new Map(); // "<id>|<flavor>|<account>" → { stamp, groups } | { stamp, error, problem, detail }
  let queue = Promise.resolve();
  const keyOf = (pid, s) => [pid, s.flavor, s.account].join('|');

  const lastFile = (pid, s) => lastPath(stateDir, pid, s);
  function readLast(pid, s) {
    try { return JSON.parse(fs.readFileSync(lastFile(pid, s), 'utf8')); } catch (e) { return null; }
  }
  function keepLast(pid, s, json) {
    const f = lastFile(pid, s);
    try {
      if (json.length > MAX_LAST) { fs.rmSync(f, { force: true }); return; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, json);
    } catch (e) { /* not kept: the script gets null next time */ }
  }

  // What decides whether a script runs again: its saved data file, and its own script file (installed again).
  function stampOf(plugin, file) {
    try {
      const sv = fs.statSync(file), sc = fs.statSync(path.join(plugin.dir, ...plugin.script.split('/')));
      return [sv.mtimeMs, sv.size, plugin.version, sc.mtimeMs, sc.size].join('|');
    } catch (e) { return null; }
  }

  async function runOne(plugin, s, file, stamp) {
    const k = keyOf(plugin.id, s);
    const failed = (problem, detail) => done.set(k, { stamp, error: 'script', problem, detail: detail || null });
    let saved;
    try {
      if (fs.statSync(file).size > outbox.MAX_BYTES) { done.set(k, { stamp, error: 'too-big' }); return; }
      saved = parse(fs.readFileSync(file, 'latin1'));
    } catch (e) { done.set(k, { stamp, error: 'unreadable' }); return; }
    const res = await run(plugin, { saved, last: readLast(plugin.id, s), ctx: { now: now() } });
    if (res.problem) return failed(res.problem, res.detail);
    let box;
    try { box = JSON.parse(res.json); } catch (e) { return failed('bad', 'not JSON'); }
    const checked = outbox.readBox(box, plugin);
    if (checked.error) return failed('bad', checked.error === 'too-new' ? 'format' : 'not an outbox');
    keepLast(plugin.id, s, res.json);
    done.set(k, { stamp, groups: checked.groups });
  }

  // Runs what is due. list: the code plugins in use; sources: the watched games; fileOf(source, plugin): its saved
  // data file there.
  function refresh(list, sources, fileOf) {
    const job = queue.then(async () => {
      for (const p of list) {
        for (const s of sources) {
          const file = fileOf(s, p);
          const stamp = stampOf(p, file);
          if (!stamp) { done.delete(keyOf(p.id, s)); continue; }
          const d = done.get(keyOf(p.id, s));
          if (!d || d.stamp !== stamp) await runOne(p, s, file, stamp);
        }
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  // One game's outbox, as outbox.readSources takes it: { groups } | { error }.
  function result(plugin, s) {
    const d = done.get(keyOf(plugin.id, s));
    if (!d) return { error: 'missing' };
    return d.error ? { error: d.error } : { groups: d.groups };
  }
  // Why a plugin's script was stopped, in one of the games: { problem: 'slow' | 'network' | 'node' | 'error' | 'bad',
  // detail } | null.
  function problem(pid) {
    for (const [k, d] of done) if (k.startsWith(pid + '|') && d.problem) return { problem: d.problem, detail: d.detail };
    return null;
  }
  // Look again: scripts that failed run again. forget: a plugin removed or installed again.
  function retry() { for (const [k, d] of [...done]) if (d.error) done.delete(k); }
  function forget(pid) { for (const k of [...done.keys()]) if (k.startsWith(pid + '|')) done.delete(k); }

  return { refresh, result, problem, retry, forget };
}

module.exports = { createScripts, lastPath };
