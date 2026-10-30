'use strict';
// The game's screenshots (docs/PLUGINS.md §3): a news item with `screenshot` names the second the game took one. The
// game saves it in the game version's Screenshots folder as WoWScrnShot_MMDDYY_HHMMSS.jpg (or .tga, .png, as the
// player set it), by this computer's clock, at that second or a little later. Only that one file is looked for and
// read; nothing in the folder is listed or written. Plain Node, no Electron, so it can be tested.
const fs = require('fs');
const path = require('path');

const EXTS = ['.jpg', '.jpeg', '.png', '.tga'];
const LATER = [0, 1, 2, 3, -1];      // seconds after the time the addon wrote, in the order they are tried
const MAX_FILE = 128 * 1024 * 1024;  // a TGA of an 8K screen

const two = (n) => String(n).padStart(2, '0');
// The file's name without its extension, for a time in Unix seconds: WoWScrnShot_102926_141500.
function baseName(sec) {
  const d = new Date(sec * 1000);
  return `WoWScrnShot_${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getFullYear() % 100)}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function folder(wowFolder, flavor) {
  return path.join(wowFolder, flavor, 'Screenshots');
}

// The screenshot taken at `sec` in this folder: its path, or null.
function find(dir, sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  for (const d of LATER) {
    for (const ext of EXTS) {
      const file = path.join(dir, baseName(sec + d) + ext);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0 && st.size <= MAX_FILE) return file;
      } catch (e) { /* not this one */ }
    }
  }
  return null;
}

module.exports = { baseName, folder, find, EXTS };
