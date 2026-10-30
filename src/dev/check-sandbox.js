'use strict';
// Checks that a template is locked away (SPEC §7): no Node.js, no network, no files but its own, and that one that
// hangs is stopped. Run: npx electron src/dev/check-sandbox.js
const path = require('path');
const { app } = require('electron');
const { checkManifest } = require('../main/plugins');
const { registerScheme, renderCard } = require('../main/render');

registerScheme();
// Stay running when the picture window closes after a failure (the app does: it lives in the tray).
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const dir = path.join(__dirname, 'evil');
  const { plugin } = checkManifest(require(path.join(dir, 'webhooks.json')), dir);
  const group = { id: 'g', name: 'Probe', color: null };
  const pic = await renderCard(plugin, 'probe', { data: {} }, group, 0);
  console.log('probe picture:', pic && pic.data.length, 'bytes');
  const { webContents } = require('electron');
  const title = webContents.getAllWebContents().map((w) => w.getTitle()).find((t) => t.startsWith('{'));
  console.log('probe:', title);
  const t0 = Date.now();
  try { await renderCard(plugin, 'hang', { data: {} }, group, 0); console.log('hang: NOT STOPPED'); } catch (e) {
    console.log('hang: stopped after', Math.round((Date.now() - t0) / 1000), 's:', e.message);
  }
  const again = await renderCard(plugin, 'probe', { data: {} }, group, 0);
  console.log('after a hang, the next picture:', again && again.data.length, 'bytes');
  app.quit();
});
