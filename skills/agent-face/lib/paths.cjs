'use strict';
// Where things live: this skill's files, the per-user data folder, and the
// ids that tie a face folder to its window process.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const VERSION = fs.readFileSync(path.join(SKILL_ROOT, 'VERSION'), 'utf8').trim();

/** Name of the folder, in the agent's own repo, that holds its face. */
const FACE_FOLDER = 'agent-face';

/**
 * Per-user data: window layout, mute and volume per face, the window
 * runtime and logs. Never inside a repo, so none of it can be committed.
 */
function home() {
  return path.resolve(process.env.AGENT_FACE_HOME || path.join(os.homedir(), '.agent-face'));
}

/**
 * The face folder to use: an explicit path, $AGENT_FACE_DIR, or the nearest
 * `agent-face/config.json` walking up from `cwd` (not past the repo root).
 * Falls back to `<cwd>/agent-face`, which is where `init` creates one.
 */
function findFaceDir(explicit, cwd = process.cwd()) {
  const given = explicit || process.env.AGENT_FACE_DIR;
  if (given) return path.resolve(cwd, given);
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, FACE_FOLDER);
    if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, '.git')) || parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(cwd), FACE_FOLDER);
}

/** Stable id for a face folder (per data folder, so test homes never collide). */
function faceId(faceDir) {
  let real = path.resolve(faceDir);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // Not created yet: the resolved path is the best name we have.
  }
  if (process.platform === 'win32') real = real.toLowerCase();
  return crypto.createHash('sha1').update(`${home()}|${real}`).digest('hex').slice(0, 12);
}

/** Local pipe (Windows) or socket (elsewhere) the face window listens on. No TCP port. */
function endpoint(id) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-face-${id}`
    : path.join(home(), 'run', `${id}.sock`);
}

const localFile = (id) => path.join(home(), 'faces', `${id}.json`);
const logFile = (id) => path.join(home(), 'logs', `${id}.log`);
const electronDataDir = (id) => path.join(home(), 'electron', id);
const runtimeDir = () => path.join(home(), 'runtime');

module.exports = {
  SKILL_ROOT,
  VERSION,
  FACE_FOLDER,
  home,
  findFaceDir,
  faceId,
  endpoint,
  localFile,
  logFile,
  electronDataDir,
  runtimeDir,
};
