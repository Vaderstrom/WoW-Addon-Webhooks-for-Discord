'use strict';
// Updates (SPEC §10): the installed app looks at this repository's GitHub Releases at start and once a day. A newer
// version is only named (onFound): nothing is downloaded until the player says so. download() fetches it, telling
// onProgress how far it got, then installs it and starts the app again; onFailed when it could not. Not while
// developing (npm start), unless `feed` names a fake feed on this computer (AWD_UPDATE_FEED, src/main/main.js).
const { app } = require('electron');

const DAY_MS = 24 * 3600 * 1000;

function startUpdates({ onFound, onProgress, onFailed, feed = null }) {
  if (!app.isPackaged && !feed) return null;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return null; }
  if (feed) {
    // The settings an installed app has in its resources (app-update.yml), kept beside the made-up settings.
    const fs = require('fs'), path = require('path');
    const file = path.join(app.getPath('userData'), 'dev-app-update.yml');
    fs.writeFileSync(file, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: wow-addon-webhooks-for-discord-updater-dev\n`);
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = file;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let downloading = false;
  autoUpdater.on('update-available', (info) => { if (!downloading) onFound(info && info.version); });
  autoUpdater.on('download-progress', (p) => onProgress(Math.floor((p && p.percent) || 0)));
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall());
  autoUpdater.on('error', () => {
    // No feed or offline while looking: try again tomorrow. While downloading: the player is told.
    if (downloading) { downloading = false; onFailed(); }
  });
  const check = () => { if (!downloading) try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) { /* no feed */ } };
  check();
  setInterval(check, DAY_MS);
  return {
    download: () => {
      if (downloading) return;
      downloading = true;
      autoUpdater.downloadUpdate().catch(() => { if (downloading) { downloading = false; onFailed(); } });
    },
  };
}

module.exports = { startUpdates };
