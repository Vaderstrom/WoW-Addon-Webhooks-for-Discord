'use strict';
// Checks that a code plugin's script is locked away (SPEC §6): the sample runs and gives back its outbox; scripts that
// reach for the internet, Node.js or files, take too long, or give back no outbox are stopped and named; WebRTC finds
// no way out either (a local STUN server hears nothing, while an ordinary window reaches it).
// Run: npx electron src/dev/check-scripts.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { app, BrowserWindow } = require('electron');
const { checkManifest } = require('../main/plugins');
const { registerScheme } = require('../main/render');
const { runScript } = require('../main/run-script');
const { parse } = require('../main/lua-table');
const { SCRIPTS, manifest } = require('../../test/fixtures/code/evil/plugins');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const STUN_PORT = 34780;
// This computer's own address on its network (Chromium sends no STUN to 127.0.0.1); nothing leaves the computer.
const HOST = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const STUN_AT = HOST ? HOST.address : '127.0.0.1';
const WEBRTC = `const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${STUN_AT}:${STUN_PORT}' }] });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 1500));`;
const MORE = {
  'evil-webrtc': `export default async function build() { ${WEBRTC} return { format: 1, groups: {} }; }`,
  // A fresh frame has its own RTCPeerConnection: the same, from inside one.
  'evil-frame': `export default async function build() {
    const f = document.createElement('iframe'); document.body.append(f);
    const RTCPeerConnection = f.contentWindow.RTCPeerConnection;
    ${WEBRTC} return { format: 1, groups: {} }; }`,
};

registerScheme();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const saved = parse(fs.readFileSync(path.join(FIXTURES, 'SavedVariables', 'SimpleScores.lua'), 'latin1'));
  const input = { saved, last: null, ctx: { now: 1800000100 } };
  const heard = [];
  const stun = dgram.createSocket('udp4');
  stun.on('message', (_m, from) => heard.push(from.address));
  await new Promise((r) => stun.bind(STUN_PORT, STUN_AT, r));

  const dir = path.join(FIXTURES, 'code', 'simple-scores');
  const sample = checkManifest(JSON.parse(fs.readFileSync(path.join(dir, 'webhooks.json'), 'utf8')), dir, { code: true }).plugin;
  const res = await runScript(sample, input);
  const out = res.json ? JSON.parse(res.json) : res;
  console.log('sample:', res.json ? 'kept text ' + JSON.stringify(out.groups.scores.kept.scores.text) : JSON.stringify(res));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awd-evil-'));
  for (const [id, code] of Object.entries({ ...SCRIPTS, ...MORE })) {
    const d = path.join(tmp, id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'plugin.js'), code);
    const p = checkManifest(manifest(id), d, { code: true }).plugin;
    const t0 = Date.now();
    const r = await runScript(p, input);
    const before = heard.length;
    console.log(id.padEnd(15), (((Date.now() - t0) / 1000).toFixed(1) + ' s').padStart(6), r.problem ? 'STOPPED: ' + r.problem + (r.detail ? ' (' + r.detail + ')' : '') : 'returned ' + r.json.slice(0, 80),
      /webrtc|frame/.test(id) ? '· STUN heard: ' + (heard.length - before) : '');
  }
  const again = await runScript(sample, input);
  console.log('after them all, the sample again:', again.json ? 'ok' : JSON.stringify(again));
  // Installed again with a changed script: the new one runs, not one the browser kept.
  const copy = path.join(tmp, 'simple-scores');
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
  const copied = { ...sample, dir: copy };
  await runScript(copied, input);
  fs.writeFileSync(path.join(copy, 'plugin.js'), fs.readFileSync(path.join(copy, 'plugin.js'), 'utf8').replace("name: 'Simple Scores'", "name: 'Simple Scores, newer'"));
  const newer = await runScript(copied, input);
  console.log('installed again, changed:', newer.json && JSON.parse(newer.json).groups.scores.name);

  // The control: an ordinary window, outside the sandbox, does reach the local STUN server.
  const before = heard.length;
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<p>control</p>');
  await w.webContents.executeJavaScript(`(async () => { ${WEBRTC} })()`);
  console.log('control (an ordinary window): STUN heard', heard.length - before);
  w.destroy();
  stun.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
});
