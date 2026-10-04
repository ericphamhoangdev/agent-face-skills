'use strict';
// One small JSON file per face in the per-user data folder: where its
// window sits, mute, volume, and whether it was closed.

const fs = require('fs');
const path = require('path');

const paths = require('./paths.cjs');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const LOCAL_DEFAULTS = Object.freeze({
  /** Template the face is using; null until one is first shown or chosen. */
  template: null,
  /** Current state name; null until the face is first shown. */
  state: null,
  /** Window position and size in screen pixels. */
  bounds: null,
  muted: false,
  /** 0–1 of the clip's recorded level. */
  volume: 0.7,
  /** Closed on purpose (the × button or `stop`): only `start` reopens it. */
  closed: false,
});

function loadLocal(id) {
  return { ...LOCAL_DEFAULTS, ...readJson(paths.localFile(id), {}) };
}

function saveLocal(id, local) {
  writeJson(paths.localFile(id), local);
}

module.exports = { readJson, writeJson, loadLocal, saveLocal };
