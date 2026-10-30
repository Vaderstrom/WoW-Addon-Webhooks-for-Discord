'use strict';
// Temporary folders for tests, removed when the test run ends.
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

module.exports = { tmpDir };
