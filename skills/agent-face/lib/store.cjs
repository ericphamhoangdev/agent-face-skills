'use strict';
// Small JSON files in the per-user data folder: one per face (where its
// window sits, mute, volume, whether it was closed) and one for sound
// settings shared by every face.

const fs = require('fs');
const path = require('path');

const paths = require('./paths.cjs');
const quiet = require('./quiet.cjs');

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

function loadSettings() {
  const saved = readJson(paths.settingsFile(), {});
  return { quiet_hours: { ...quiet.DEFAULTS, ...(saved.quiet_hours || {}) } };
}

function saveSettings(settings) {
  writeJson(paths.settingsFile(), settings);
}

module.exports = { readJson, writeJson, loadLocal, saveLocal, loadSettings, saveSettings };
