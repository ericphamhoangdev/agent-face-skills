'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const lipSync = require('../skills/agent-face/runtime/lipsync.js');

const tuning = lipSync.sane(); // opens at 10%, wide at 45%, dips after 3 steps

test('the mouth follows loudness', () => {
  // silence, a breath, a murmur (7.5%), soft (20%), medium (50%), loud (the reference) x5, a spike
  const rms = [0, 0.004, 0.015, 0.04, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.9];
  assert.deepEqual(lipSync.levelsFromRms(rms, 1, tuning), [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
  // two frames: soft is half open, medium and louder fully open
  assert.deepEqual(lipSync.levelsFromRms(rms, 2, tuning), [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(lipSync.levelsFromRms(rms, 0, tuning), new Array(11).fill(0));
  assert.deepEqual(lipSync.levelsFromRms([], 2, tuning), []);
});

test('long sounds keep the mouth moving', () => {
  assert.deepEqual(
    lipSync.keepMoving([0, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2, 2, 2], 3),
    [0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 1],
  );
  assert.deepEqual(lipSync.keepMoving([2, 2, 2, 2, 2], 0), [2, 2, 2, 2, 2], 'hold_steps 0 never dips');
});

test('a whole clip: silence, then a steady tone', () => {
  const rate = 8000;
  const samples = new Float32Array(rate * 0.6);
  for (let i = rate * 0.3; i < samples.length; i++) samples[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / rate);
  const { step_ms, levels } = lipSync.mouthLevels([samples], rate, 2, {});
  assert.equal(step_ms, 40);
  assert.equal(levels.length, 15, '0.6 s in 40 ms steps');
  assert.ok(levels.slice(0, 7).every((l) => l === 0), String(levels));
  // Step 7 straddles the start of the tone. A steady tone would hold the
  // mouth wide open; instead it dips every fourth step.
  assert.deepEqual(levels.slice(7), [2, 2, 2, 1, 2, 2, 2, 1]);
});

test('stereo is measured across both channels', () => {
  const loud = new Float32Array(400).fill(0.5);
  const silent = new Float32Array(400);
  const [mono] = lipSync.rmsPerStep([loud], 8000, 50);
  const [stereo] = lipSync.rmsPerStep([loud, silent], 8000, 50);
  assert.ok(Math.abs(mono - 0.5) < 1e-6);
  assert.ok(Math.abs(stereo - Math.sqrt(0.125)) < 1e-6);
});

test('tuning is filled in and clamped', () => {
  assert.deepEqual(lipSync.sane(undefined), { ...lipSync.DEFAULTS });
  const wild = lipSync.sane({ step_ms: 5, open_at: 0.8, wide_at: 0.2, hold_steps: -2 });
  assert.equal(wild.step_ms, 20);
  assert.equal(wild.wide_at, 0.8, 'wide_at never below open_at');
  assert.equal(wild.hold_steps, 0);
  assert.equal(lipSync.sane({ step_ms: 'fast' }).step_ms, 40, 'non-numbers fall back to the default');
});
