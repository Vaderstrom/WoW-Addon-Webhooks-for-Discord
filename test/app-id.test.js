'use strict';
// The installed app's id must be the installer's (build.appId), or Windows shows another program's icon on the
// taskbar and names notices after it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the app id in main.js is the installer\'s build.appId', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const m = main.match(/const APP_ID = '([^']+)'/);
  assert.ok(m, 'main.js names APP_ID');
  assert.strictEqual(m[1], pkg.build.appId);
});
