const assert = require('node:assert/strict');
const test = require('node:test');
const { fitFrame, animationFrame, planPlayback } = require('../app/playback.js');

test('rectangular art is centered in the canvas at its original ratio', () => {
  const wide = fitFrame(160, 96, 384, 384);
  const tall = fitFrame(96, 160, 384, 384);
  assert.ok(Math.abs(wide.w / wide.h - 160 / 96) < 0.00001);
  assert.ok(Math.abs(tall.w / tall.h - 96 / 160) < 0.00001);
  assert.equal(wide.x, 0);
  assert.equal(tall.y, 0);
  assert.equal(2 * wide.y + wide.h, 384);
  assert.equal(2 * tall.x + tall.w, 384);
});

test('a run always completes the last stride, then the main process can return it to idle', () => {
  const cycle = 560;
  const item = { cycle, frameDurationsMs: [100,90,90,100,90,90], loop: true };
  const plan = planPlayback('tiny-steps', item);
  assert.deepEqual(plan, { duration: 2240, repeatFrames: true });
  assert.equal(animationFrame(item, plan.duration - 1, true), item.frameDurationsMs.length - 1);
  assert.equal(animationFrame(item, plan.duration, true), 0);
});

test('a glide stays on its final frame until the window lands', () => {
  const item = { cycle: 3000, frameDurationsMs: Array(12).fill(250), loop: true };
  assert.deepEqual(planPlayback('glide', item), { duration: 3000, repeatFrames: false });
  assert.equal(animationFrame(item, 3500, false), 11);
});
