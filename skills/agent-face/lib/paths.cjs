'use strict';
// Where things live: this skill's files, the face folder in the agent's
// repo, the per-user data folder, and the ids that tie a face folder to its
// window process.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const VERSION = fs.readFileSync(path.join(SKILL_ROOT, 'VERSION'), 'utf8').trim();

/**
 * Name of the folder, in the agent's own repo, that holds its face
 * templates: one sub-folder per template.
 */
const FACE_FOLDER = '.agent-face';

/**
 * Per-user data, in the user's home folder: window layout, mute and volume
 * per face, the window runtime and logs. Never inside a repo, so none of it
 * can be committed. It shares its name with the face folder but is never
 * used as one (see findFaceFolder).
 */
function home() {
  return path.resolve(process.env.AGENT_FACE_HOME || path.join(os.homedir(), '.agent-face'));
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The face folder to use: an explicit path, $AGENT_FACE_DIR, or the nearest
 * `.agent-face/` walking up from `cwd` (not past the repo root). Falls back
 * to `<cwd>/.agent-face`, which is where `init` creates one.
 */
function findFaceFolder(explicit, cwd = process.cwd()) {
  const given = explicit || process.env.AGENT_FACE_DIR;
  if (given) return path.resolve(cwd, given);
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, FACE_FOLDER);
    // Outside a repo the walk can reach the home folder, whose `.agent-face`
    // is the per-user data folder, not a face.
    const isData = samePath(candidate, home());
    if (!isData && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, '.git')) || parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(cwd), FACE_FOLDER);
}

/**
 * Where version 0.1 kept a single face: `agent-face/` beside the face
 * folder. Used to point people at the move, and to close a window that is
 * still showing it.
 */
function legacyFaceFolder(faceFolder) {
  return path.join(path.dirname(path.resolve(faceFolder)), 'agent-face');
}

/**
 * The canonical form of a path that may not exist (yet, or any more): the
 * real path of its nearest existing ancestor, plus the rest. Keeps a
 * folder's id the same before it is created and after it is moved away.
 */
function canonical(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(canonical(parent), path.basename(target));
  }
}

/** Stable id for a face folder (per data folder, so test homes never collide). */
function faceId(faceFolder) {
  let real = canonical(path.resolve(faceFolder));
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
/** Where `current` puts the picture of a face when the agent doesn't name a file. */
const pictureFile = (id) => path.join(home(), 'pictures', `${id}.png`);
const runtimeDir = () => path.join(home(), 'runtime');

module.exports = {
  SKILL_ROOT,
  VERSION,
  FACE_FOLDER,
  home,
  legacyFaceFolder,
  findFaceFolder,
  faceId,
  endpoint,
  localFile,
  logFile,
  electronDataDir,
  pictureFile,
  runtimeDir,
};
