'use strict';
// The app's window (SPEC §8). The first time: three steps, one at a time (find your addons, connect a Discord channel,
// choose what goes where). After that: four tabs (Home, Flows, Addons, Settings). The flow editor is in flow-editor.js. Window texts come from
// src/locales/enUS.json; plugin texts (kinds, help lines) from the plugins, as they are.
(async function () {
  const api = window.awd;
  const T = await api.texts();
  const $ = (id) => document.getElementById(id);
  const fill = (s, vals) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : ''));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const shortName = (n) => String(n || '').split('-')[0];
  const pkey = (...parts) => parts.join('|');
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = T[e.dataset.t] || '';

  function ago(sec) {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (d < 60) return T['ago.now'];
    if (d < 3600) { const n = Math.floor(d / 60); return n === 1 ? T['ago.minute'] : fill(T['ago.minutes'], { n }); }
    if (d < 86400) { const n = Math.floor(d / 3600); return n === 1 ? T['ago.hour'] : fill(T['ago.hours'], { n }); }
    const n = Math.floor(d / 86400); return n === 1 ? T['ago.day'] : fill(T['ago.days'], { n });
  }
  function say(e, text, cls) { e.textContent = text || ''; e.hidden = !text; e.className = cls || ''; }
  // A problem in one plain sentence, naming the addon, channel and group when it is about them.
  function problemText(key, ...where) {
    const p = T['problem.' + key] || '';
    const w = where.filter(Boolean).join(' · ');
    return w ? fill(T.problemIn, { where: w, problem: p }) : p;
  }
  // Why a plugin in use shows no groups: the file could not be read, the addon has saved nothing yet, or it saved an
  // outbox with nothing in it (the plugin's own text says why, when it has one).
  function noGroupsText(p) {
    if (p.readProblem) return problemText(p.readProblem);
    if (p.saved) return p.empty || fill(T.s1Empty, { addon: p.name });
    return T.s1NoGroups;
  }
  function checkbox(label, checked, onchange, help, tag) {
    const box = el('label', 'tick');
    const cb = el('input');
    cb.type = 'checkbox'; cb.checked = !!checked; cb.onchange = () => onchange(cb.checked);
    const text = el('span', 'tick-text');
    const line = el('span', 'tick-label', label);
    if (tag) line.append(el('span', 'tag', tag));
    text.append(line);
    if (help) text.append(el('span', 'tick-help', help));
    box.append(cb, text);
    return box;
  }
  function button(text, onclick, cls) { const b = el('button', cls || null, text); b.type = 'button'; b.onclick = onclick; return b; }

  // Development snapshots open a given step or tab (?step=3, ?tab=flows&box=<box>, ?tab=flows&line=<from>><to>).
  const dev = new URLSearchParams(location.search);
  let state = null, running = null, again = false;
  let step = Number(dev.get('step')) || 1, tab = dev.get('tab') || 'home';
  let justPosted = false; // the setup just posted: Home asks to pin the kept messages
  const previews = {}; // "plugin|group|kind" → { saved, src } or { saved, failed } or { saved } while drawing

  // One refresh at a time: a status update arriving during a refresh runs one more after it. (Two at once each
  // cleared a list, then both filled it: an entry showed twice; 29 Oct 2026, in the Journey Together Companion.)
  function refresh() {
    if (editor && editor.busy()) return Promise.resolve(); // a box is being dragged: it draws again when dropped
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await draw(); } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  const plugins = () => state.plugins.filter((p) => p.id);
  const inUse = () => plugins().filter((p) => p.used === true);

  async function draw() {
    state = await api.state();
    const s = state.settings;
    $('update').hidden = !state.updateReady;
    const setUp = s.setupDone || s.channels.some((c) => c.posted);
    $('wizard').hidden = setUp;
    $('home').hidden = !setUp;
    if (setUp) drawHome(); else drawWizard();
  }

  // ---------- Pieces shared by the setup and the tabs ----------

  function groupLine(g) {
    const saved = g.saved ? (g.by ? fill(T.groupSaved, { when: ago(g.saved), by: shortName(g.by) }) : fill(T.groupSavedNoBy, { when: ago(g.saved) })) : '';
    return [g.sub, saved, g.game].filter(Boolean).join(' · ');
  }
  function groupItem(g) {
    const li = el('li', 'item');
    const sw = el('span', 'swatch');
    if (g.color) sw.style.background = '#' + g.color;
    const text = el('div', 'grow');
    text.append(el('div', 'name', g.name), el('div', 'sub', groupLine(g)));
    li.append(sw, text);
    return li;
  }
  function pluginHead(p) {
    const head = el('div', 'plugin-head');
    head.append(el('span', 'plugin-name', p.name || p.addon));
    if (p.code) head.append(el('span', 'tag', T.containsCode));
    const meta = [p.version, p.author ? fill(T.pluginBy, { author: p.author }) : null].filter(Boolean).join(' · ');
    if (meta) head.append(el('span', 'hint', meta));
    return head;
  }

  // A kept kind's picture as Discord shows it, drawn again when the group is saved again.
  function preview(p, g, kind) {
    const box = el('figure', 'preview');
    const k = pkey(p.id, g.id, kind.id);
    let v = previews[k];
    if (!v || v.saved !== g.saved) {
      v = previews[k] = { saved: g.saved };
      api.preview(p.id, g.id, kind.id).then((res) => {
        previews[k] = res.ok ? { saved: g.saved, src: res.src } : { saved: g.saved, failed: true };
        refresh();
      });
    }
    box.append(el('figcaption', null, T.previewTitle + ' · ' + kind.name + ' · ' + g.name));
    if (v.src) { const img = el('img'); img.src = v.src; img.alt = g.name; box.append(img); }
    else box.append(el('p', v.failed ? 'problem' : 'hint wait', v.failed ? T.previewFailed : T.previewBusy));
    return box;
  }

  // Where the app looks: the WoW folder and the games in it.
  function gamesBox() {
    const box = el('div');
    const row = el('div', 'row');
    const msg = el('p', 'problem'); msg.hidden = true;
    row.append(el('span', 'path', state.wowFolder || T.folderNone), button(T.pickFolder, async () => {
      const res = await api.pickFolder();
      say(msg, res.problem ? T[res.problem] : '', 'problem');
      refresh();
    }));
    const ticks = el('div', 'ticks');
    for (const g of state.games || []) {
      ticks.append(checkbox(fill(T.gameLine, { name: g.name, account: g.account }), g.watched,
        async (on) => { await api.setGame(g.flavor, g.account, on); refresh(); }));
    }
    if (!(state.games || []).length && state.wowFolder) ticks.append(el('span', 'hint', T.noGames));
    box.append(el('div', 'label', T.folderLabel), row, msg, el('div', 'label', T.gamesLabel), ticks, el('p', 'hint', T.gamesHint));
    return box;
  }

  // Connecting a channel: how to get a webhook URL, the URL, a name, Connect (which sends a test message).
  function connectForm(onDone, onCancel) {
    const box = el('div', 'connect');
    const how = el('ol', 'how');
    for (const k of ['how1', 'how2', 'how3']) how.append(el('li', null, T[k]));
    const url = el('input'); url.type = 'password'; url.placeholder = T.webhookPlaceholder; url.autocomplete = 'off'; url.spellcheck = false;
    const name = el('input'); name.placeholder = T.channelNamePlaceholder; name.maxLength = 60; name.autocomplete = 'off'; name.spellcheck = false;
    const urlLabel = el('label', 'field'); urlLabel.append(el('span', null, T.webhookLabel), url);
    const nameLabel = el('label', 'field'); nameLabel.append(el('span', null, T.channelName), name);
    const msg = el('p'); msg.hidden = true;
    const go = button(T.connect, async () => {
      go.disabled = true; go.textContent = T.connecting;
      const n = name.value.trim() || fill(T.channelDefault, { n: state.settings.channels.length + 1 });
      const res = await api.connect(n, url.value);
      go.disabled = false; go.textContent = T.connect;
      if (!res.ok) return say(msg, T[res.problem] || '', 'problem');
      url.value = ''; name.value = '';
      onDone(res);
    }, 'primary');
    const row = el('div', 'row');
    row.append(go);
    if (onCancel) row.append(button(T.cancel, onCancel));
    box.append(how, urlLabel, nameLabel, row, msg, el('p', 'hint', T.webhookSecret));
    return box;
  }

  // Previews of the kept kinds that reach a channel, per group (setup's step 3 and Home).
  function reachedPreviews(p) {
    const out = [];
    for (const g of p.groups) {
      const reach = state.flows.reach[pkey(p.id, g.id)] || [];
      for (const k of p.kinds.filter((x) => x.type === 'kept' && p.templates.includes(x.id) && g.kept.includes(x.id) && reach.includes(x.id))) out.push(preview(p, g, k));
    }
    return out;
  }

  const editor = window.createFlowEditor({ api, T, el, button, fill, refresh, problemText, preview, connectForm,
    start: { box: dev.get('box'), line: dev.get('line') } });

  // ---------- The first time: three steps ----------

  function drawWizard() {
    const ch = state.settings.channels[0] || null;
    const ready = inUse().some((p) => p.groups.length);
    if (step > 1 && !ready) step = 1;
    if (step > 2 && !ch) step = 2;
    for (const sec of document.querySelectorAll('.step')) sec.hidden = Number(sec.dataset.step) !== step;
    [...$('progress').children].forEach((li, i) => { li.className = i + 1 < step ? 'done' : i + 1 === step ? 'current' : ''; });

    // 1. The addons found, each with Use and its groups; and where the app looks (open by itself when nothing is found).
    $('s1Plugins').replaceChildren(...state.plugins.map((p) => {
      const card = el('div', 'item plugin');
      if (!p.id) {
        card.append(el('div', 'plugin-head', p.addon), el('p', 'problem', T['plugin.' + p.problem]));
        return card;
      }
      card.append(checkbox(p.name, p.used === true, async (on) => { await api.usePlugin(p.id, on); refresh(); }, [p.version, p.author && fill(T.pluginBy, { author: p.author })].filter(Boolean).join(' · ')));
      if (p.used === true) {
        if (p.groups.length) { const ul = el('ul', 'list inner'); ul.append(...p.groups.map(groupItem)); card.append(ul); }
        else card.append(el('p', 'hint', noGroupsText(p)));
      }
      return card;
    }));
    $('s1None').hidden = state.plugins.length > 0;
    if (!state.plugins.length || !state.wowFolder) $('s1More').open = true;
    $('s1Games').replaceChildren(gamesBox());
    $('s1Next').disabled = !ready;

    // 2. Connect a channel, or the one connected.
    $('s2Connected').hidden = !ch;
    $('s2Form').hidden = !!ch;
    if (ch) $('s2ConnectedText').textContent = fill(T.connected, { name: ch.name });
    else if (!$('s2Form').firstChild) $('s2Form').replaceChildren(connectForm(() => { step = 3; refresh(); }));
    $('s2Next').disabled = !ch;

    // 3. What goes where: the flow editor, and the pictures Discord will show.
    if (ch && step === 3) {
      const pics = el('div');
      pics.append(...inUse().flatMap(reachedPreviews));
      editor.draw($('s3Editor'), state, { extra: pics });
      $('finish').disabled = !state.flows.anyRoute;
    }
  }

  $('s1Look').onclick = async () => { await api.reload(); refresh(); };
  $('s1Next').onclick = () => { step = 2; refresh(); };
  $('s2Back').onclick = () => { step = 1; refresh(); };
  $('s2Next').onclick = () => { step = 3; refresh(); };
  $('s2Other').onclick = async () => { const ch = state.settings.channels[0]; if (ch) await api.removeChannel(ch.id); refresh(); };
  $('s3Back').onclick = () => { step = 2; refresh(); };
  $('finish').onclick = async () => {
    const btn = $('finish');
    btn.disabled = true; btn.textContent = T.posting;
    const res = await api.finishSetup();
    btn.disabled = false; btn.textContent = T.finish;
    if (res.problem) return say($('s3Msg'), problemText(res.problem, res.plugin, res.channel, res.group), 'problem');
    tab = 'home'; justPosted = !!res.kept;
    refresh();
  };

  // ---------- After setup: the tabs ----------

  function drawHome() {
    for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const sec of document.querySelectorAll('section.tab')) sec.hidden = sec.dataset.tab !== tab;
    drawNewPlugins();
    drawStatus();
    drawHomePlugins();
    document.body.classList.toggle('wide', tab === 'flows'); // before drawing: the editor measures the page
    if (tab === 'flows') editor.draw($('flowEditor'), state);
    drawAddons();
    $('setGames').replaceChildren(gamesBox());
    drawOptions();
    drawLog();
  }
  for (const b of $('tabs').children) b.onclick = () => { tab = b.dataset.tab; refresh(); };

  // A plugin found after setup is not used until the player says so.
  function drawNewPlugins() {
    $('newPlugins').replaceChildren(...plugins().filter((p) => p.used === undefined).map((p) => {
      const card = el('div', 'card found');
      const row = el('div', 'row');
      row.append(el('span', 'grow', fill(T.newPlugin, { name: p.name })),
        button(T.use, async () => { await api.usePlugin(p.id, true); tab = 'flows'; refresh(); }, 'primary'),
        button(T.notNow, async () => { await api.usePlugin(p.id, false); refresh(); }));
      card.append(row);
      return card;
    }));
  }

  function drawStatus() {
    const s = state.settings, st = state.status;
    let text, cls;
    if (st && st.problem) { text = problemText(st.problem, st.plugin, st.channel, st.group); cls = 'problem'; }
    else if (s.paused) { text = T.statusPaused; cls = 'paused'; }
    else if (s.problem) { text = problemText(s.problem); cls = 'problem'; }
    else if (s.lastPost) { text = T.statusOk; cls = 'ok'; }
    else { text = T.statusWaiting; cls = ''; }
    $('statusMain').textContent = text;
    $('statusMain').className = 'big ' + cls;
    $('statusCard').className = 'card status ' + cls;
    const lines = [];
    if (justPosted) lines.push(T.pinIt);
    // Kept messages posted anew since (deleted in Discord, or a new line): pin them too.
    const pins = s.pinAsks || [];
    if (pins.length) {
      const line = el('div', 'pin-ask');
      line.append(el('span', null, fill(T.pinAgain, { what: pins.map((x) => fill(T.pinWhat, x)).join('; ') })),
        button(T.pinDone, async () => { await api.clearPinAsks(); refresh(); }, 'small'));
      lines.push(line);
    }
    if (s.lastPost) lines.push(fill(T.statusLast, { when: ago(s.lastPost.time) }));
    if (state.gameRunning) lines.push(T.statusGame);
    $('statusLines').replaceChildren(...lines.map((l) => (typeof l === 'string' ? el('div', null, l) : l)));
    $('pause').textContent = s.paused ? T.resume : T.pause;
  }

  // Each plugin in use with its groups, and the kept pictures that reach a channel.
  function drawHomePlugins() {
    $('homePlugins').replaceChildren(...inUse().map((p) => {
      const card = el('div', 'card');
      card.append(pluginHead(p));
      for (const g of p.groups) {
        const ul = el('ul', 'list bare'); ul.append(groupItem(g)); card.append(ul);
        if (!(state.flows.reach[pkey(p.id, g.id)] || []).length) { card.append(el('p', 'hint', T.notPosted)); continue; }
        card.append(...reachedPreviews({ ...p, groups: [g] }));
      }
      if (!p.groups.length) card.append(el('p', 'hint', noGroupsText(p)));
      return card;
    }));
  }

  // Every plugin found or installed; a code plugin with why its script was stopped, and Remove (pressed twice).
  let removing = null;
  function drawAddons() {
    $('addons').replaceChildren(...(state.plugins.length ? state.plugins.map((p) => {
      const li = el('li', 'item plugin');
      if (!p.id) {
        li.append(el('div', 'plugin-head', p.addon), el('p', 'problem', T['plugin.' + p.problem]));
        if (p.folder) li.append(removeButton(p.folder));
        return li;
      }
      li.append(pluginHead(p), el('div', 'sub', p.code ? fill(T.codePlugin, { addon: p.addon }) : T.dataPlugin + ' · ' + p.addon),
        checkbox(T.inUse, p.used === true, async (on) => { await api.usePlugin(p.id, on); refresh(); }));
      if (p.same && p.same.length) li.append(el('p', 'hint', fill(T.sameAddon, { names: p.same.join(', ') })));
      if (p.script) li.append(el('p', 'problem', fill(T['script.' + p.script.problem], { detail: p.script.detail || '?' })));
      if (p.readProblem) li.append(el('p', 'problem', problemText(p.readProblem)));
      if (p.folder) li.append(removeButton(p.folder));
      return li;
    }) : [el('li', 'hint', T.noPlugins)]));
  }
  function removeButton(folder) {
    const sure = removing === folder;
    const row = el('div', 'row');
    row.append(button(sure ? T.removeSure : T.removePlugin, async () => {
      if (!sure) { removing = folder; refresh(); return; }
      removing = null;
      await api.removeCode(folder);
      say($('addonsMsg'), '');
      refresh();
    }, sure ? 'danger' : 'danger-text'));
    return row;
  }

  function drawOptions() {
    const s = state.settings;
    $('options').replaceChildren(
      checkbox(T.optNotices, s.notices, async (on) => { await api.setOption('notices', on); refresh(); }),
      checkbox(T.optStart, s.startWithWindows, async (on) => { await api.setOption('startWithWindows', on); refresh(); }));
  }

  function drawLog() {
    const log = state.settings.log || [];
    $('log').replaceChildren(...(log.length ? log.map((e) => {
      const via = (e.via || []).map((v) => T['step.' + v]).filter(Boolean);
      const what = e.problem ? T['problem.' + e.problem] : [e.kind, T.logPosted].filter(Boolean).join(' ') + (via.length ? ' ' + fill(T.logVia, { steps: via.join(', ') }) : '');
      return el('li', e.problem ? 'bad' : null, [ago(e.time), e.plugin, e.channel, e.group].filter(Boolean).join(' · ') + ': ' + (what || ''));
    }) : [el('li', null, T.logEmpty)]));
  }

  $('postNow').onclick = async () => {
    $('postNow').disabled = true;
    await api.postNow();
    $('postNow').disabled = false;
    refresh();
  };
  $('pause').onclick = async () => { await api.setPaused(!state.settings.paused); refresh(); };
  $('addonsLook').onclick = async () => { await api.reload(); refresh(); };
  // Install a code plugin…: the .zip picked and checked, then the warning naming it (SPEC §3); only Install puts it in.
  function drawWarning(w) {
    const box = $('addonsWarn');
    box.hidden = !w;
    if (!w) { box.replaceChildren(); return; }
    const parts = [el('h2', null, T.installHead),
      ...fill(T.installWarning, { name: w.name, author: w.author || T.installNoAuthor, addon: w.addon }).split('\n\n').map((t) => el('p', null, t))];
    if (w.replaces) parts.push(el('p', null, fill(T.installReplaces, { version: w.replaces, next: w.version || '?' })));
    if (w.instead.length) parts.push(el('p', null, fill(T.installInstead, { names: w.instead.join(', ') })));
    const row = el('div', 'row');
    row.append(button(T.installYes, async () => {
      drawWarning(null);
      const res = await api.installCode();
      say($('addonsMsg'), res.ok ? fill(T.installed, { name: res.name }) : T['install.' + res.problem] || '', res.ok ? 'ok' : 'problem');
      refresh();
    }, 'primary'), button(T.cancel, async () => { await api.cancelInstall(); drawWarning(null); }));
    box.replaceChildren(...parts, row);
  }
  $('addonsInstall').onclick = async () => {
    say($('addonsMsg'), '');
    drawWarning(null);
    const res = await api.lookCode();
    if (res.ok) drawWarning(res);
    else if (res.problem) say($('addonsMsg'), T['install.' + res.problem], 'problem');
  };
  $('restartUpdate').onclick = () => api.restartUpdate();
  api.onStatus(() => refresh());
  await refresh();
})();
