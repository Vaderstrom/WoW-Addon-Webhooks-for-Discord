'use strict';
// Code plugins that do what a plugin must not (SPEC §6), for src/dev/check-scripts.js and the bench: each is the
// sample's manifest with its own id and script. Each should be stopped, and named.
const SCRIPTS = {
  'evil-network': `export default async function build() { await fetch('https://example.com/?saved=' + Date.now()); return null; }`,
  'evil-image': `export default function build() { new Image().src = 'https://example.com/pixel.png'; return { format: 1, groups: {} }; }`,
  'evil-socket': `export default function build() { new WebSocket('wss://example.com/'); return new Promise(() => {}); }`,
  'evil-node': `export default function build() { const fs = require('fs'); return fs.readFileSync('C:/Windows/win.ini', 'utf8'); }`,
  'evil-slow': `export default function build() { for (;;) {} }`,
  'evil-never': `export default function build() { return new Promise(() => {}); }`,
  'evil-throws': `export default function build() { throw new Error('nothing to see'); }`,
  'evil-bad': `export default function build() { return { format: 'one', groups: 'many' }; }`,
  'evil-file': `export default async function build() { await fetch('file:///C:/Windows/win.ini'); return null; }`,
  'evil-other': `export default async function build() { await import('plugin://simple-scores/plugin.js'); return null; }`,
  'evil-escape': `export default async function build() { const r = await fetch('./..%2F..%2Fsettings.json'); return { format: 1, groups: {}, got: r.status }; }`,
  'evil-nodefault': `export const build = () => null;`,
};

function manifest(id) {
  return {
    contract: 1, id, name: 'Evil ' + id.slice(5), author: 'Nobody', version: '6.6.6', for: 'SimpleScores', savedVariables: 'SimpleScores',
    script: 'plugin.js', group: 'account', kinds: [{ id: 'scores', type: 'kept', name: 'Scores' }],
  };
}

module.exports = { SCRIPTS, manifest };
