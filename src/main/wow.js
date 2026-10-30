'use strict';
// Finding the game: the WoW folder, its game versions (folders such as _forever_ and _retail_, shown by name) and
// the accounts; and whether that game version is running. The app only reads these folders, never writes to them.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const USUAL = ['C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft', 'D:\\World of Warcraft'];
// Game versions by name, in the order the window lists them: Forever first.
const NAMES = {
  _forever_: 'WoW Forever', _retail_: 'Retail', _classic_era_: 'Classic Era', _anniversary_: 'Classic Anniversary',
  _classic_: 'Classic', _ptr_: 'Retail PTR', _xptr_: 'Retail PTR 2', _beta_: 'Beta', _classic_ptr_: 'Classic PTR',
  _classic_era_ptr_: 'Classic Era PTR', _classic_beta_: 'Classic Beta',
};
const ORDER = Object.keys(NAMES);
const PROGRAMS = ['Wow.exe', 'WowClassic.exe', 'WowT.exe', 'WowB.exe', 'WowClassicT.exe', 'WowClassicB.exe'];

function dirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return []; }
}

// A game version's name: "WoW Forever" for _forever_; an unknown folder by its words ("_new_one_" → "New One").
function flavorName(flavor) {
  if (NAMES[flavor]) return NAMES[flavor];
  return String(flavor).replace(/^_+|_+$/g, '').split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Game versions with saved data (folders like _retail_ that hold WTF\Account), Forever first.
function flavors(wowFolder) {
  const rank = (f) => (ORDER.includes(f) ? ORDER.indexOf(f) : ORDER.length);
  return dirs(wowFolder).filter((d) => /^_[a-z0-9_]+_$/.test(d) && fs.existsSync(path.join(wowFolder, d, 'WTF', 'Account')))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function accounts(wowFolder, flavor) {
  return dirs(path.join(wowFolder, flavor, 'WTF', 'Account')).filter((d) => d !== 'SavedVariables').sort();
}

// An account's SavedVariables file for an addon (the account-wide one): <name>.lua.
function svPath(wowFolder, flavor, account, name) {
  return path.join(wowFolder, flavor, 'WTF', 'Account', account, 'SavedVariables', name + '.lua');
}

// Whether this account of this game version has saved data for one of these addons (to tick it at first).
function hasSaved(wowFolder, flavor, account, names) {
  return (names || []).some((n) => { try { return fs.statSync(svPath(wowFolder, flavor, account, n)).isFile(); } catch (e) { return false; } });
}

// A game version's AddOns folder, where data plugins live (InterfaceAddOns<Addon>Webhooks).
function addonsFolder(wowFolder, flavor) {
  return path.join(wowFolder, flavor, 'Interface', 'AddOns');
}

// Every game version and account in the WoW folder: [{ flavor, account, name }], Forever first.
function games(wowFolder) {
  return flavors(wowFolder).flatMap((flavor) => accounts(wowFolder, flavor).map((account) => ({ flavor, account, name: flavorName(flavor) })));
}

// The first usual place that is a WoW folder, or null.
function find(candidates = USUAL) {
  return candidates.find((p) => flavors(p).length > 0) || null;
}

// Is one of these program paths the game of this version (Wow.exe or WowClassic.exe in its folder)?
function isGameOf(paths, wowFolder, flavor) {
  const dir = path.join(wowFolder, flavor).toLowerCase() + path.sep;
  const programs = PROGRAMS.map((x) => x.toLowerCase());
  return paths.some((p) => typeof p === 'string' && p.toLowerCase().startsWith(dir) && programs.includes(path.basename(p).toLowerCase()));
}

// The paths of running WoW programs (Windows). Calls back with [] when they cannot be read.
function runningGames(cb) {
  if (process.platform !== 'win32') return cb([]);
  const names = PROGRAMS.map((p) => `Name='${p}'`).join(' OR ');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "${names}" | ForEach-Object { $_.ExecutablePath }`],
  { windowsHide: true, timeout: 10000 }, (err, out) => cb(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
}

module.exports = { flavors, flavorName, accounts, games, svPath, hasSaved, addonsFolder, find, isGameOf, runningGames, USUAL };
