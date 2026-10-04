'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const quiet = require('../skills/agent-face/lib/quiet.cjs');

const at = (h, m) => new Date(2024, 0, 15, h, m);

test('the default window wraps past midnight', () => {
  const q = { ...quiet.DEFAULTS }; // 20:00–08:00
  for (const [h, m] of [[20, 0], [23, 59], [0, 30], [7, 59]]) assert.ok(quiet.isQuiet(q, at(h, m)), `${h}:${m}`);
  for (const [h, m] of [[8, 0], [12, 0], [19, 59]]) assert.ok(!quiet.isQuiet(q, at(h, m)), `${h}:${m}`);
});

test('a window inside one day, and switching it off', () => {
  const q = { enabled: true, start: '13:00', end: '15:30' };
  assert.ok(quiet.isQuiet(q, at(14, 0)));
  assert.ok(!quiet.isQuiet(q, at(15, 30)));
  assert.ok(!quiet.isQuiet(q, at(9, 0)));
  assert.ok(!quiet.isQuiet({ ...q, enabled: false }, at(14, 0)));
});

test('times that make no sense never silence the face', () => {
  const q = { enabled: true, start: '25:00', end: '8' };
  assert.ok(!quiet.isValid(q));
  assert.ok(!quiet.isQuiet(q, at(1, 0)));
  assert.ok(!quiet.isQuiet({ enabled: true, start: '09:00', end: '09:00' }, at(9, 0)), 'an empty window');
});
