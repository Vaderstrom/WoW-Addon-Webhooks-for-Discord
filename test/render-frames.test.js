'use strict';
// A fresh offscreen window paints one empty frame before its real first one; the empty one must not stand in for it
// (a cold check-mode run's first board: "template: no frame painted", 30 Oct 2026).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { nextFrame } = require('../src/main/render');

const image = (name, empty = false) => ({ name, isEmpty: () => empty });
function fakeWindow(paints) {
  const wc = new EventEmitter();
  wc.isDestroyed = () => false;
  let asked = false;
  wc.invalidate = () => {
    if (asked) return;
    asked = true;
    for (const [ms, img] of paints) setTimeout(() => wc.emit('paint', {}, {}, img), ms);
  };
  return { webContents: wc };
}

test('an empty first paint does not count: the real frame that comes later does', async () => {
  // The empty frame, then the real one more than 400 ms later (a slow cold start).
  const frame = await nextFrame(fakeWindow([[10, image('empty', true)], [650, image('real')], [700, image('real 2')]]));
  assert.ok(frame && !frame.isEmpty(), 'got a real frame');
  assert.strictEqual(frame.name, 'real 2');
});

test('the second of two real frames is taken', async () => {
  const frame = await nextFrame(fakeWindow([[5, image('first')], [30, image('second')]]));
  assert.strictEqual(frame.name, 'second');
});
