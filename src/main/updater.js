'use strict';
// Updates (SPEC §10): the installed app checks this repository's GitHub Releases at start and once a day, downloads a
// newer version in the background and offers "Restart to update". Not while developing (npm start).
const { app } = require('electron');

const DAY_MS = 24 * 3600 * 1000;

function startUpdates({ onReady }) {
  if (!app.isPackaged) return null;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return null; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => onReady(info && info.version));
  autoUpdater.on('error', () => { /* no feed, offline: try again tomorrow */ });
  const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) { /* no feed */ } };
  check();
  setInterval(check, DAY_MS);
  return { install: () => autoUpdater.quitAndInstall() };
}

module.exports = { startUpdates };
