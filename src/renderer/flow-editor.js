'use strict';
// The flow editor (SPEC §5.1, §5.2, §8): what the addons post, as a tree on the left (plugin → Every {group} and the
// groups → kinds), and where it goes in Discord on the right (each channel, with its threads under it), joined by
// lines dragged from a kind's dot to a place. A line's rules show as a tag on it. Clicking a box, a line or a tag opens
// its settings beside the canvas; a kind's settings have Send to…, so dragging is never the only way, and every box
// takes the keyboard. Used by the Flows tab and by the setup's step 3. Box ids are as in src/main/flows.js.
window.createFlowEditor = function (deps) {
  const { api, T, el, button, fill, refresh, problemText, preview } = deps;
  const EVERY = '*';
  const OPS = { number: ['is', 'not', 'min', 'max'], text: ['is', 'not'], names: ['has', 'lacks'] }; // as src/main/flows.js
  const NUMBER_OP = { is: '=', not: '≠', min: '≥', max: '≤' };
  const kindBox = (pid, gid, kind) => `k:${pid}|${gid}|${kind}`;
  const parse = (box) => {
    if (box.startsWith('k:')) { const [pid, gid, kind] = box.slice(2).split('|'); return { type: 'kind', pid, gid, kind }; }
    if (box.startsWith('t:')) { const [channel, thread] = box.slice(2).split(':'); return { type: 'thread', channel, thread }; }
    return { type: 'channel', channel: box.slice(2), thread: null };
  };
  const keyOf = (l) => l.from + '>' + l.to;
  // What the editor remembers between draws (each refresh draws it anew).
  const ui = { selected: null, open: {}, sure: null, msg: null, adding: false, form: null, drag: null, dragged: false, focus: null, reveal: false,
    thread: { link: '', name: '', problem: null } };
  // Development snapshots may open the editor with a box or a line selected (deps.start: { box, line: "from>to" }).
  if (deps.start && deps.start.box) ui.selected = { box: deps.start.box };
  if (deps.start && deps.start.line) ui.selected = { line: deps.start.line.split('>') };
  let st = null, layout = null, canvas = null, svg = null, root = null, opts = {};
  // The settings sit beside the canvas on a wide page (style.css: body.wide, 900 pixels and more), else under it.
  const PANEL = 320 + 14;
  const beside = () => document.body.classList.contains('wide') && window.matchMedia('(min-width: 900px)').matches;

  // ---------- Names ----------

  const inUse = () => st.plugins.filter((p) => p.id && p.used === true);
  const pluginOf = (pid) => inUse().find((p) => p.id === pid);
  const channelOf = (id) => st.settings.channels.find((c) => c.id === id);
  const kindOf = (box) => { const b = parse(box); const p = pluginOf(b.pid); return p ? p.kinds.find((k) => k.id === b.kind) || null : null; };
  const lineOf = (from, to) => st.settings.lines.find((l) => l.from === from && l.to === to);
  const infoOf = (l) => (st.flows.info || {})[keyOf(l)] || { fields: [], sample: null, seen: 0, passed: 0 };
  const places = () => st.settings.channels.flatMap((c) => ['c:' + c.id, ...c.threads.map((t) => `t:${c.id}:${t.id}`)]);
  // The rules a kind takes (as src/main/flows.js, refuses).
  const takes = (rule, k) => !!k && k.type === 'news' && (rule === 'mention' ? !!k.mention : rule === 'gather' ? !k.weekly : !!(k.fields && k.fields.length));
  function groupLabel(p, gid) {
    if (gid === EVERY) return fill(T.everyGroup, { group: p.group });
    const g = p.groups.find((x) => x.id === gid);
    if (g) return g.name;
    const known = st.settings.channels.map((c) => c.names[`${p.id}|${gid}`]).find(Boolean);
    return known ? fill(T.groupMissing, { name: known }) : T.groupUnknown;
  }
  function placeName(box) {
    const b = parse(box);
    const c = channelOf(b.channel);
    if (!c) return '';
    if (!b.thread) return c.name;
    const t = c.threads.find((x) => x.id === b.thread);
    return c.name + ' › ' + (t ? t.name : T.threadBox);
  }
  // A box in words, as the flows list and the settings name it.
  function label(box) {
    const b = parse(box);
    if (b.type !== 'kind') return placeName(box);
    const p = pluginOf(b.pid);
    if (!p) return '';
    const k = p.kinds.find((x) => x.id === b.kind);
    const name = (k ? k.name : b.kind) + ' · ' + groupLabel(p, b.gid);
    return inUse().length > 1 ? p.name + ': ' + name : name;
  }
  const whenOf = (c) => (c.digest.every === 'hour' ? T.whenHourly : fill(T.whenDaily, { at: c.digest.at }));
  // A line's mention, short for its tag or in words; a role without a name for it is "a role".
  function roleName(m, short) {
    if (!m.role) return short ? T.tagNoRole : T.wordNoRole;
    if (m.name) return short ? '@' + m.name : fill(T.wordMention, { role: '@' + m.name });
    return short ? T.tagRole : fill(T.wordMention, { role: T.wordRole });
  }
  // A line's rules, short for its tag or in words for the flows list.
  function rulesOf(l, short) {
    const k = kindOf(l.from);
    if (!k) return [];
    const out = [];
    if (l.only && takes('only', k)) {
      const o = l.only;
      const f = (k.fields || []).find((x) => x.id === o.field);
      if (!f || o.value === '') out.push(short ? T.tagUnset : T.wordUnset);
      else out.push(fill(short ? T.tagOnly : T.wordOnly, { field: f.name, op: short && f.type === 'number' ? NUMBER_OP[o.op] : T['op.' + o.op], value: o.value }));
    }
    if (l.mention && takes('mention', k)) out.push(roleName(l.mention, short));
    if (l.gather && takes('gather', k)) {
      const c = channelOf(parse(l.to).channel);
      out.push(short ? T.tagGather : fill(T.wordGather, { when: c ? whenOf(c) : '' }));
    }
    return out;
  }
  const lineProblem = (res) => T['flow.' + res.problem] || T['flow.bad'];

  // ---------- Layout ----------

  function place() {
    const W = Math.max(520, ((root && root.clientWidth) || 680) - (beside() ? PANEL : 0) - 2);
    const treeW = Math.min(230, Math.floor(W * 0.36));
    const boxW = Math.min(230, Math.floor(W * 0.34));
    const chanX = W - boxW - 10;
    const boxes = [], heads = [];
    const lines = st.settings.lines;
    const hasLines = (pid, gid) => lines.some((l) => l.from.startsWith(`k:${pid}|${gid}|`));
    heads.push({ kind: 'col', text: T.colLeft, x: 4, y: 8 }, { kind: 'col', text: T.colRight, x: chanX, y: 8 });
    let y = 34;
    for (const p of inUse()) {
      heads.push({ kind: 'plugin', text: p.name, x: 4, y }); y += 24;
      const gids = [EVERY, ...p.groups.slice().sort((a, b) => a.name.localeCompare(b.name)).map((g) => g.id)];
      for (const l of lines) { const b = parse(l.from); if (b.type === 'kind' && b.pid === p.id && !gids.includes(b.gid)) gids.push(b.gid); }
      for (const gid of gids) {
        const k = `${p.id}|${gid}`;
        const open = ui.open[k] != null ? ui.open[k] : gid === EVERY || hasLines(p.id, gid);
        heads.push({ kind: 'group', key: k, pid: p.id, gid, text: groupLabel(p, gid), open, x: 4, y, w: treeW - 4 });
        y += 28;
        if (!open) continue;
        for (const kind of p.kinds) {
          boxes.push({ id: kindBox(p.id, gid, kind.id), type: 'kind', x: 16, y, w: treeW - 16, title: kind.name,
            sub: kind.type === 'kept' ? T.kept : kind.weekly ? T.weeklyMade : null, help: kind.help });
          y += 50;
        }
      }
      y += 6;
    }
    // Each channel, its times as badges, then its threads.
    let ry = 34;
    for (const c of st.settings.channels) {
      const badges = [];
      if (c.quiet) badges.push(fill(T.quietBadge, c.quiet));
      if (lines.some((l) => l.gather && parse(l.to).channel === c.id)) badges.push(c.digest.every === 'hour' ? T.hourlyBadge : fill(T.dailyBadge, { at: c.digest.at }));
      boxes.push({ id: 'c:' + c.id, type: 'channel', x: chanX, y: ry, w: boxW, title: c.name,
        sub: badges.length ? badges.join(' · ') : c.forum ? T.forumBox : T.channelBox });
      ry += 52;
      for (const t of c.threads) {
        boxes.push({ id: `t:${c.id}:${t.id}`, type: 'thread', x: chanX + 22, y: ry, w: boxW - 22, title: t.name, sub: T.threadSub });
        ry += 50;
      }
      ry += 10;
    }
    if (!st.settings.channels.length) heads.push({ kind: 'empty', text: T.noChannelYet, x: chanX, y: 34, w: boxW });
    return { W, width: root ? root.clientWidth : 0, boxes, heads, height: Math.max(200, Math.max(y, ry) + 16) };
  }
  const boxAt = (id) => layout.boxes.find((b) => b.id === id);
  // Where a line ends on a box; a kind box in a folded group starts its lines at the group's name.
  function portOf(id, side) {
    const b = boxAt(id);
    if (b) { const e = canvas.querySelector(`[data-box="${CSS.escape(id)}"]`); const h = e ? e.offsetHeight : 40; return { x: side === 'out' ? b.x + b.w : b.x, y: b.y + h / 2 }; }
    const p = parse(id);
    if (p.type !== 'kind') return null;
    const h = layout.heads.find((x) => x.kind === 'group' && x.pid === p.pid && x.gid === p.gid);
    return h ? { x: h.x + h.w, y: h.y + 11 } : null;
  }
  const bend = (a, b) => Math.max(36, Math.abs(b.x - a.x) / 2);
  const curve = (a, b) => { const dx = bend(a, b); return `M${a.x} ${a.y} C${a.x + dx} ${a.y},${b.x - dx} ${b.y},${b.x} ${b.y}`; };
  // The point at t (0 to 1) along the curve from a to b.
  function along(a, b, t) {
    const dx = bend(a, b), u = 1 - t;
    const x = u * u * u * a.x + 3 * u * u * t * (a.x + dx) + 3 * u * t * t * (b.x - dx) + t * t * t * b.x;
    const y = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y;
    return { x, y };
  }

  // ---------- Drawing ----------

  function drawWires(temp) {
    const NS = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    for (const l of st.settings.lines) {
      const a = portOf(l.from, 'out'), b = portOf(l.to, 'in');
      if (!a || !b) continue;
      const sel = ui.selected && ui.selected.line && ui.selected.line[0] === l.from && ui.selected.line[1] === l.to;
      const lit = ui.selected && (ui.selected.box === l.from || ui.selected.box === l.to);
      const d = curve(a, b);
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d); p.setAttribute('class', 'wire' + (sel ? ' selected' : lit ? ' lit' : ''));
      p.dataset.from = l.from; p.dataset.to = l.to;
      const hit = document.createElementNS(NS, 'path');
      hit.setAttribute('d', d); hit.setAttribute('class', 'wire-hit');
      const tip = document.createElementNS(NS, 'title');
      tip.textContent = label(l.from) + ' → ' + label(l.to) + ' · ' + T.lineHint;
      hit.append(tip);
      hit.addEventListener('click', (e) => { e.stopPropagation(); select({ line: [l.from, l.to] }); });
      svg.append(p, hit);
    }
    if (temp) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', curve(temp[0], temp[1])); p.setAttribute('class', 'wire temp');
      svg.append(p);
    }
  }

  // The tags on the lines: the rules of each, near its middle, moved along it when another tag is there already.
  function drawTags() {
    const placed = [];
    const clear = (r) => !placed.some((q) => r.x < q.x + q.w + 4 && q.x < r.x + r.w + 4 && r.y < q.y + q.h + 2 && q.y < r.y + r.h + 2);
    for (const l of st.settings.lines.slice().sort((a, b) => a.n - b.n)) {
      const text = rulesOf(l, true).join(' · ');
      const a = portOf(l.from, 'out'), b = portOf(l.to, 'in');
      if (!text || !a || !b) continue;
      const w = Math.min(190, text.length * 6.3 + 20), h = 20;
      let spot = null;
      for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75]) {
        const p = along(a, b, t);
        const r = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        if (clear(r)) { spot = r; break; }
      }
      if (!spot) { const p = along(a, b, 0.5); spot = { x: p.x - w / 2, y: p.y - h / 2, w, h }; }
      placed.push(spot);
      const sel = ui.selected && ui.selected.line && ui.selected.line[0] === l.from && ui.selected.line[1] === l.to;
      const tag = button(text, (ev) => { ev.stopPropagation(); select({ line: [l.from, l.to] }); }, 'ftag' + (sel ? ' selected' : ''));
      tag.style.left = spot.x + 'px'; tag.style.top = spot.y + 'px'; tag.style.maxWidth = w + 'px';
      tag.title = text;
      tag.setAttribute('aria-label', fill(T.lineRules, { line: label(l.from) + ' → ' + label(l.to), rules: text }));
      canvas.append(tag);
    }
  }

  function boxEl(b) {
    const e = el('div', `fbox ${b.type}` + (ui.selected && ui.selected.box === b.id ? ' selected' : ''));
    e.dataset.box = b.id; e.tabIndex = 0;
    e.style.left = b.x + 'px'; e.style.top = b.y + 'px'; e.style.width = b.w + 'px';
    if (b.help) e.title = b.help;
    e.setAttribute('role', 'button');
    e.setAttribute('aria-label', label(b.id));
    e.append(el('div', 'fbox-title', b.title));
    if (b.sub) e.append(el('div', 'fbox-sub', b.sub));
    if (b.type === 'kind') { const o = el('span', 'port out'); o.title = T.dragHint; e.append(o); } else e.append(el('span', 'port in'));
    e.addEventListener('keydown', (ev) => {
      if (ev.target !== e) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select({ box: b.id }); }
    });
    // Its own lines light up, so they can be told from the others.
    const light = (on) => { for (const w of svg.querySelectorAll('path.wire')) if (w.dataset.from === b.id || w.dataset.to === b.id) w.classList.toggle('hover', on); };
    e.addEventListener('pointerenter', () => { if (!ui.drag) light(true); });
    e.addEventListener('pointerleave', () => light(false));
    if (ui.msg && ui.msg.box === b.id) e.append(el('div', 'fbox-msg', ui.msg.text));
    return e;
  }

  function drawCanvas() {
    const wrap = el('div', 'canvas-wrap');
    canvas = el('div', 'canvas');
    canvas.style.height = layout.height + 'px';
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'wires');
    canvas.append(svg);
    for (const h of layout.heads) {
      if (h.kind === 'col') { const e = el('div', 'col-head', h.text); e.style.top = h.y + 'px'; e.style.left = h.x + 'px'; canvas.append(e); continue; }
      if (h.kind === 'plugin') { const e = el('div', 'tree-plugin', h.text); e.style.top = h.y + 'px'; canvas.append(e); continue; }
      if (h.kind === 'empty') { const e = el('div', 'fempty hint', h.text); e.style.top = h.y + 'px'; e.style.left = h.x + 'px'; e.style.width = h.w + 'px'; canvas.append(e); continue; }
      const g = button((h.open ? '▾ ' : '▸ ') + h.text, () => { ui.open[h.key] = !h.open; refresh(); }, 'tree-group');
      g.style.top = h.y + 'px'; g.style.left = h.x + 'px'; g.style.width = h.w + 'px';
      g.setAttribute('aria-expanded', String(h.open));
      canvas.append(g);
    }
    for (const b of layout.boxes) canvas.append(boxEl(b));
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('click', (ev) => {
      if (ui.dragged) { ui.dragged = false; return; } // the click that ends a drag
      const e = ev.target.closest('.fbox');
      if (e) select({ box: e.dataset.box });
      else if (!ev.target.closest('button') && ui.selected) { ui.selected = null; refresh(); }
    });
    wrap.append(canvas);
    return wrap;
  }

  // ---------- Dragging a line ----------

  const point = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const placeUnder = (ev) => { const u = document.elementFromPoint(ev.clientX, ev.clientY); const t = u && u.closest('.fbox'); return t && !t.dataset.box.startsWith('k:') ? t : null; };
  function down(ev) {
    if (ev.button !== 0 || !ev.target.closest('.port.out')) return;
    ui.drag = { from: ev.target.closest('.fbox').dataset.box };
    ev.preventDefault();
    // Listened to on the window, not captured: a click on a box must still reach the box.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }
  function move(ev) {
    if (!ui.drag) return;
    for (const t of canvas.querySelectorAll('.fbox.target')) t.classList.remove('target');
    const t = placeUnder(ev);
    if (t) t.classList.add('target');
    drawWires([portOf(ui.drag.from, 'out'), point(ev)]);
  }
  async function up(ev) {
    const d = ui.drag;
    window.removeEventListener('pointermove', move);
    ui.drag = null;
    if (!d) return;
    endDrag();
    const t = placeUnder(ev);
    if (t) await connect(d.from, t.dataset.box);
    else drawWires();
  }
  // The click that ends a drag selects nothing. When the drag ended outside the canvas no click comes, so it is
  // forgotten once the click had its chance.
  function endDrag() { ui.dragged = true; setTimeout(() => { ui.dragged = false; }, 0); }

  // ---------- Actions ----------

  // What is selected opens its settings; under the canvas (a narrow window) they are brought into view.
  function select(sel) { ui.selected = sel; ui.msg = null; ui.sure = null; ui.focus = sel.box || null; ui.reveal = true; refresh(); }
  // A new line opens its settings, so its rules are one click away.
  async function connect(from, to) {
    const res = await api.addLine(from, to);
    ui.msg = res.ok ? null : { box: to, text: lineProblem(res) };
    if (ui.msg) setTimeout(() => { if (ui.msg && ui.msg.box === to) { ui.msg = null; refresh(); } }, 6000);
    if (res.ok) { ui.selected = { line: [from, to] }; ui.reveal = true; }
    refresh();
  }

  // ---------- Controls ----------

  // Each change saves and draws the panel anew: the control in use keeps the focus (draw, data-keep), so the arrow keys
  // go on working in a list or a time.
  const keep = (e, id) => { e.dataset.keep = id; return e; };
  function tick(text, on, onchange, id) {
    const l = el('label', 'tick');
    const c = keep(el('input'), id); c.type = 'checkbox'; c.checked = !!on; c.onchange = () => onchange(c.checked);
    l.append(c, el('span', 'tick-label', text));
    return l;
  }
  function timeInput(value, onchange, id) {
    const i = keep(el('input'), id); i.type = 'time'; i.value = value; i.className = 'time';
    i.onchange = () => { if (/^\d\d:\d\d$/.test(i.value)) onchange(i.value); };
    return i;
  }
  function radio(name, checked, text, onchange, id) {
    const l = el('label', 'tick');
    const r = keep(el('input'), id); r.type = 'radio'; r.name = name; r.checked = checked; r.onchange = () => { if (r.checked) onchange(); };
    l.append(r, el('span', 'tick-label', text));
    return l;
  }
  function option(value, text, selected) {
    const o = el('option', null, text); o.value = value; o.selected = !!selected;
    return o;
  }
  function textInput(value, placeholder, onchange, id, max) {
    const i = keep(el('input'), id); i.value = value || ''; i.placeholder = placeholder || ''; i.spellcheck = false;
    if (max) i.maxLength = max;
    i.onchange = () => onchange(i.value);
    return i;
  }
  function field(text, input) { const l = el('label', 'field'); l.append(el('span', null, text), input); return l; }
  // Lines from or to a box, each with its rules, Rules and Remove.
  function lineList(list, other) {
    if (!list.length) return el('p', 'hint', T.boxNoLines);
    const ul = el('ul', 'lines');
    for (const l of list.slice().sort((a, b) => a.n - b.n)) {
      const li = el('li');
      const text = el('span', 'grow', other(l));
      const r = rulesOf(l, true);
      if (r.length) text.append(el('span', 'line-rules', r.join(' · ')));
      li.append(text, button(T.rules, () => select({ line: [l.from, l.to] }), 'small'),
        button(T.removeLine, async () => { await api.removeLine(l.from, l.to); refresh(); }, 'small'));
      ul.append(li);
    }
    return ul;
  }
  // A button pressed twice: the first press asks.
  function twice(id, text, action) {
    const sure = ui.sure === id;
    return button(sure ? T.removeSure : text, async () => {
      if (!sure) { ui.sure = id; refresh(); return; }
      ui.sure = null;
      await action();
      refresh();
    }, sure ? 'danger' : 'danger-text');
  }

  // ---------- The settings of what is selected ----------

  function kindForm(box) {
    const form = el('div');
    const b = parse(box);
    const p = pluginOf(b.pid);
    const k = kindOf(box);
    if (!k) return form;
    if (k.help) form.append(el('p', null, k.help));
    if (k.type === 'kept' && p.templates.includes(k.id)) {
      const groups = b.gid === EVERY ? p.groups.slice(0, 3) : p.groups.filter((g) => g.id === b.gid);
      for (const g of groups.filter((x) => x.kept.includes(k.id))) form.append(preview(p, g, k));
    }
    const mine = st.settings.lines.filter((l) => l.from === box);
    form.append(el('div', 'label', T.boxLines), lineList(mine, (l) => '→ ' + placeName(l.to)));
    form.append(el('div', 'label', T.sendTo));
    const free = places().filter((x) => !mine.some((l) => l.to === x));
    if (!st.settings.channels.length) form.append(el('p', 'hint', T.sendToNone));
    else if (!free.length) form.append(el('p', 'hint', T.sendToAll));
    const row = el('div', 'row sendto');
    for (const to of free) row.append(button(placeName(to), () => connect(box, to)));
    form.append(row);
    return form;
  }

  // Only when: a field of the kind, a test that fits its type, and a value (for text and names, the values seen so far
  // are offered; several with commas). Ticked on a kind with one field, that field is chosen.
  function onlyRule(l, k, set, id) {
    const sec = el('div', 'rule');
    const info = infoOf(l);
    const fields = info.fields.length ? info.fields : (k.fields || []).map((f) => ({ ...f, values: [] }));
    const one = fields.length === 1 ? fields[0] : null;
    sec.append(tick(T['rule.only'], !!l.only, (on) => set({ only: on ? { field: one ? one.id : '', op: one ? OPS[one.type][0] : 'is', value: '' } : null }), id + 'only'));
    if (!l.only) { sec.append(el('p', 'hint indent', T.onlyHelp)); return sec; }
    const o = l.only;
    const f = fields.find((x) => x.id === o.field);
    const row = el('div', 'row onlyrow indent');
    const pick = keep(el('select'), id + 'field');
    pick.setAttribute('aria-label', T.onlyField);
    if (!f) pick.append(option('', T.onlyPick, true));
    for (const x of fields) pick.append(option(x.id, x.name, x === f));
    pick.onchange = () => { const x = fields.find((y) => y.id === pick.value); if (x) set({ only: { field: x.id, op: OPS[x.type][0], value: '' } }); };
    row.append(pick);
    if (f) {
      const op = keep(el('select'), id + 'op');
      op.setAttribute('aria-label', T.onlyTest);
      for (const x of OPS[f.type]) op.append(option(x, T['op.' + x], x === o.op));
      op.onchange = () => set({ only: { ...o, op: op.value } });
      const v = textInput(o.value, f.type === 'number' ? '' : T.onlyValue, (value) => set({ only: { ...o, value } }), id + 'value', 100);
      v.setAttribute('aria-label', T.onlyValue);
      if (f.type === 'number') { v.type = 'number'; v.className = 'num'; }
      if (f.values.length) {
        const list = el('datalist'); list.id = 'only-' + l.n;
        for (const x of f.values) list.append(option(x, x));
        v.setAttribute('list', list.id);
        row.append(list);
      }
      row.append(op, v);
    }
    sec.append(row);
    if (!f || o.value === '') sec.append(el('p', 'hint indent', T.onlyUnset));
    else sec.append(el('p', 'hint indent', info.seen ? fill(T.onlyCount, { passed: info.passed, seen: info.seen }) : fill(T.onlyCountNone, { kind: k.name })));
    if (f && f.type !== 'number') sec.append(el('p', 'hint indent', T.onlyMany));
    return sec;
  }
  function mentionRule(l, set, id) {
    const sec = el('div', 'rule');
    const m = l.mention;
    sec.append(tick(T['rule.mention'], !!m, (on) => set({ mention: on ? { role: '', name: '' } : null }), id + 'mention'));
    if (!m) { sec.append(el('p', 'hint indent', T.mentionHelp)); return sec; }
    const role = textInput(m.role, T.rolePlaceholder, (v) => set({ mention: { ...m, role: v } }), id + 'role', 25);
    role.inputMode = 'numeric';
    const name = textInput(m.name, T.roleNamePlaceholder, (v) => set({ mention: { ...m, name: v } }), id + 'rolename', 40);
    const box = el('div', 'indent');
    box.append(field(T.roleIdLabel, role), field(T.roleName, name), el('p', 'hint', T.roleHelp));
    if (!m.role) box.append(el('p', 'hint', T.roleUnset));
    sec.append(box);
    return sec;
  }
  function gatherRule(l, set, id) {
    const sec = el('div', 'rule');
    const c = channelOf(parse(l.to).channel);
    sec.append(tick(T['rule.gather'], !!l.gather, (on) => set({ gather: on }), id + 'gather'));
    sec.append(el('p', 'hint indent', fill(T.gatherHelp, { place: placeName(l.to), when: c ? whenOf(c) : '' })));
    return sec;
  }
  // What Discord shows: the newest saved item, as it would be posted along this line.
  function sample(l, k, p) {
    const sec = el('div', 'sample');
    sec.append(el('div', 'label', T.previewTitle));
    const b = parse(l.from);
    if (k.type === 'kept') {
      const groups = b.gid === EVERY ? p.groups.slice(0, 1) : p.groups.filter((g) => g.id === b.gid);
      const g = groups.find((x) => x.kept.includes(k.id));
      if (g && p.templates.includes(k.id)) sec.append(preview(p, g, k));
      else sec.append(el('p', 'hint', fill(T.sampleNone, { kind: k.name })));
      return sec;
    }
    if (k.weekly) { sec.append(el('p', 'hint', T.sampleWeekly)); return sec; }
    const info = infoOf(l);
    if (!info.sample) {
      sec.append(el('p', 'hint', l.only && info.seen ? fill(T.sampleNonePass, { kind: k.name }) : fill(T.sampleNone, { kind: k.name })));
      return sec;
    }
    const msg = el('div', 'dmsg');
    const body = el('div', 'dmsg-body');
    body.append(el('div', 'dmsg-who', info.sample.group));
    const text = el('div', 'dmsg-text');
    if (l.mention && l.mention.role && takes('mention', k)) text.append(el('span', 'dmsg-mention', '@' + (l.mention.name || T.sampleRole)), ' ');
    if (l.gather && takes('gather', k)) { text.append(info.sample.group); text.append(el('br')); }
    text.append(info.sample.text);
    body.append(text);
    msg.append(el('div', 'dmsg-av'), body);
    sec.append(msg);
    if (l.gather && takes('gather', k)) sec.append(el('p', 'hint', T.sampleGathered));
    return sec;
  }
  function lineForm(l) {
    const form = el('div');
    const k = kindOf(l.from);
    const p = pluginOf(parse(l.from).pid);
    if (!k || !p) return form;
    const set = async (rules) => { await api.setLine(l.from, l.to, rules); refresh(); };
    const id = 'l' + l.n + ':';
    form.append(el('p', 'hint', groupLabel(p, parse(l.from).gid)));
    if (k.type === 'kept') form.append(el('p', 'hint', fill(T.lineKept, { kind: k.name })));
    else {
      const rules = [takes('only', k) && onlyRule(l, k, set, id), takes('mention', k) && mentionRule(l, set, id), takes('gather', k) && gatherRule(l, set, id)].filter(Boolean);
      if (rules.length) form.append(...rules);
      else form.append(el('p', 'hint', fill(k.weekly ? T.lineWeekly : T.lineNoRules, { kind: k.name })));
    }
    form.append(sample(l, k, p));
    const row = el('div', 'row');
    row.append(button(T.removeLine, async () => { await api.removeLine(l.from, l.to); ui.selected = { box: l.from }; refresh(); }, 'danger-text'));
    form.append(row);
    return form;
  }
  function channelForm(c) {
    const form = el('div');
    const id = 'c' + c.id + ':';
    form.append(field(T.channelName, textInput(c.name, '', async (v) => { await api.renameChannel(c.id, v); refresh(); }, id + 'name', 60)));
    if (c.forum) form.append(el('p', 'hint', T.forumHint));
    const msg = el('p'); msg.hidden = true;
    const test = el('div', 'row');
    test.append(button(T.testPost, async () => {
      const res = await api.testChannel(c.id);
      msg.textContent = res.ok ? T.testSent : problemText(res.problem); msg.className = res.ok ? 'ok' : 'problem'; msg.hidden = false;
    }));
    form.append(test, msg);
    const setC = async (values) => { await api.setChannel(c.id, values); refresh(); };

    // Quiet hours, and the daily post's time.
    const quiet = el('div', 'rule');
    quiet.append(tick(T.quietTitle, !!c.quiet, (on) => setC({ quiet: on ? {} : null }), id + 'quiet'));
    if (c.quiet) {
      const row = el('div', 'row indent times');
      row.append(el('span', null, T.quietFrom), timeInput(c.quiet.from, (v) => setC({ quiet: { from: v } }), id + 'qfrom'),
        el('span', null, T.quietTo), timeInput(c.quiet.to, (v) => setC({ quiet: { to: v } }), id + 'qto'));
      quiet.append(row);
    }
    quiet.append(el('p', 'hint indent', T.quietHelp));
    const daily = el('div', 'rule');
    daily.append(el('div', 'rule-head', T.dailyTitle));
    const at = el('div', 'row indent');
    at.append(radio(id + 'every', c.digest.every === 'day', T.digestDailyAt, () => setC({ digest: { every: 'day' } }), id + 'day'),
      timeInput(c.digest.at, (v) => setC({ digest: { every: 'day', at: v } }), id + 'at'));
    const hourly = el('div', 'indent');
    hourly.append(radio(id + 'every', c.digest.every === 'hour', T.digestHourly, () => setC({ digest: { every: 'hour' } }), id + 'hour'));
    daily.append(at, hourly, el('p', 'hint indent', T.dailyHelp));
    form.append(quiet, daily);

    // Threads: each a place of its own; added from its link, with a name for the app.
    const threads = el('div', 'rule');
    threads.append(el('div', 'rule-head', T.threadsTitle), el('p', 'hint indent', T.threadsHelp));
    const ul = el('ul', 'lines indent');
    for (const t of c.threads) {
      const li = el('li');
      li.append(el('span', 'grow', t.name), button(T.open, () => select({ box: `t:${c.id}:${t.id}` }), 'small'));
      ul.append(li);
    }
    if (c.threads.length) threads.append(ul);
    const draft = ui.thread;
    const link = textInput(draft.link, T.threadPlaceholder, () => {}, id + 'tlink', 300);
    link.oninput = () => { draft.link = link.value; };
    const name = textInput(draft.name, T.threadNamePlaceholder, () => {}, id + 'tname', 60);
    name.oninput = () => { draft.name = name.value; };
    const add = el('div', 'indent');
    add.append(field(T.threadLink, link), field(T.threadName, name));
    const row = el('div', 'row');
    row.append(button(T.addThread, async () => {
      const res = await api.addThread(c.id, draft.link, draft.name);
      if (res.ok) { ui.thread = { link: '', name: '', problem: null }; ui.selected = { box: res.box }; }
      else draft.problem = res.problem;
      refresh();
    }));
    add.append(row, el('p', 'hint', T.threadHelp));
    if (draft.problem) add.append(el('p', 'problem', T[draft.problem]));
    threads.append(add);
    form.append(threads);

    form.append(el('div', 'label', T.boxLines), lineList(st.settings.lines.filter((l) => l.to === 'c:' + c.id), (l) => label(l.from)));
    const end = el('div', 'row');
    end.append(twice('c:' + c.id, T.removeChannel, async () => { await api.removeChannel(c.id); ui.selected = null; }));
    form.append(end);
    return form;
  }
  function threadForm(c, t) {
    const form = el('div');
    const box = `t:${c.id}:${t.id}`;
    form.append(el('p', 'hint', fill(T.threadOf, { channel: c.name })));
    form.append(field(T.threadName, textInput(t.name, '', async (v) => { await api.renameThread(c.id, t.id, v); refresh(); }, box + ':name', 60)));
    form.append(el('div', 'label', T.boxLines), lineList(st.settings.lines.filter((l) => l.to === box), (l) => label(l.from)));
    const end = el('div', 'row');
    end.append(twice(box, T.removeThread, async () => { await api.removeThread(c.id, t.id); ui.selected = { box: 'c:' + c.id }; }));
    form.append(end);
    return form;
  }
  function panel() {
    const box = el('div', 'card panel');
    const sel = ui.selected;
    if (sel && sel.line) {
      const l = lineOf(sel.line[0], sel.line[1]);
      if (!l) { ui.selected = null; return panel(); }
      const k = kindOf(l.from);
      box.append(el('h3', null, (k ? k.name : '') + ' → ' + placeName(l.to)), lineForm(l));
      return box;
    }
    if (!sel || !sel.box) { box.append(el('p', 'hint', T.panelHint)); return box; }
    const b = parse(sel.box);
    if (b.type === 'kind') {
      if (!kindOf(sel.box)) { ui.selected = null; return panel(); }
      box.append(el('h3', null, label(sel.box)), kindForm(sel.box));
      return box;
    }
    const c = channelOf(b.channel);
    const t = c && b.thread ? c.threads.find((x) => x.id === b.thread) : null;
    if (!c || (b.thread && !t)) { ui.selected = null; return panel(); }
    box.append(el('h3', null, t ? t.name : c.name), t ? threadForm(c, t) : channelForm(c));
    return box;
  }

  // ---------- The flows in words ----------

  function rows() {
    const box = el('div', 'flowrows');
    box.append(el('div', 'label', T.flowsInWords));
    const ul = el('ul');
    for (const r of st.flows.rows) {
      const l = lineOf(r.from, r.to);
      if (!l) continue;
      const li = el('li', r.already || r.missing ? 'warn' : null);
      const rules = rulesOf(l, false);
      li.append(el('span', null, label(r.from) + ' → ' + label(r.to) + (rules.length ? ': ' + rules.join(', ') : '')));
      if (r.already) li.append(el('span', 'note', fill(T.flowAlready, { channel: placeName('c:' + parse(r.to).channel) })));
      else if (r.missing) li.append(el('span', 'note', T.flowMissing));
      ul.append(li);
    }
    if (!st.flows.rows.length) ul.append(el('li', 'hint', T.flowsEmpty));
    const not = st.flows.notPosted.map((x) => {
      const p = pluginOf(x.pid);
      const k = p && p.kinds.find((y) => y.id === x.kind);
      return k ? (inUse().length > 1 ? p.name + ': ' : '') + k.name : null;
    }).filter(Boolean);
    if (not.length) ul.append(el('li', 'hint', fill(T.notPostedList, { kinds: not.join(', ') })));
    box.append(ul);
    return box;
  }

  // ---------- The toolbar ----------

  function toolbar() {
    const wrap = el('div');
    const bar = el('div', 'row toolbar');
    bar.append(button(T.addChannel, () => { ui.adding = !ui.adding; refresh(); }));
    wrap.append(bar);
    // The connect form is made once and kept while it is open, so a redraw never loses what the player typed.
    if (ui.adding) {
      if (!ui.form) {
        ui.form = el('div', 'card');
        ui.form.append(el('h3', null, T.addChannel), deps.connectForm((res) => { ui.adding = false; ui.form = null; ui.selected = { box: 'c:' + res.id }; refresh(); },
          () => { ui.adding = false; ui.form = null; refresh(); }));
      }
      wrap.append(ui.form);
    } else ui.form = null;
    return wrap;
  }

  // ---------- Drawing it all ----------

  function draw(container, state, options) {
    if (root !== container) { if (root) watcher.unobserve(root); watcher.observe(container); }
    root = container; st = state; opts = options || {};
    const focused = document.activeElement && ui.form && ui.form.contains(document.activeElement) ? document.activeElement : null;
    const kept = document.activeElement && container.contains(document.activeElement) ? document.activeElement.dataset.keep : null;
    layout = place();
    const grid = el('div', 'flowgrid');
    grid.append(drawCanvas(), panel());
    container.replaceChildren(toolbar(), grid, rows());
    // A scrollbar that came with what was just drawn narrows the editor: place the canvas again at its new width.
    if (container.clientWidth !== layout.width) { layout = place(); grid.firstChild.replaceWith(drawCanvas()); }
    if (focused) focused.focus({ preventScroll: true });
    else if (kept) { const e = container.querySelector(`[data-keep="${CSS.escape(kept)}"]`); if (e) e.focus({ preventScroll: true }); }
    if (opts.extra) container.append(opts.extra);
    drawWires();
    drawTags();
    if (ui.focus) { const e = canvas.querySelector(`[data-box="${CSS.escape(ui.focus)}"]`); if (e && document.activeElement === document.body) e.focus({ preventScroll: true }); }
    if (ui.reveal) {
      ui.reveal = false;
      const p = container.querySelector('.panel');
      const top = p ? p.getBoundingClientRect().top : 0;
      if (p && !beside() && (top < 0 || top > window.innerHeight - 120)) p.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // The columns follow the editor's width: the window's, and a scrollbar that comes or goes after a draw.
  let resized = null;
  const watcher = new ResizeObserver(() => {
    clearTimeout(resized);
    resized = setTimeout(() => {
      if (root && root.isConnected && root.offsetParent && st && !ui.drag && layout && root.clientWidth !== layout.width) draw(root, st, opts);
    }, 100);
  });

  return { draw, busy: () => !!ui.drag };
};
