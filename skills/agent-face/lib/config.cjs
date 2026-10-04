'use strict';
// Reads a face folder: config.json (states, lip-sync tuning) and the
// optional voice/index.json (clips). Read fresh on every use, so edits to
// the folder take effect without restarting anything.

const fs = require('fs');
const path = require('path');

const lipSync = require('../runtime/lipsync.js');

/**
 * Absolute path of an existing file inside the face folder. Refuses paths
 * that escape it (`..`, absolute paths, links), so a face can never make
 * the window read files from elsewhere on the machine.
 */
function resolveInside(faceDir, rel) {
  const target = path.resolve(faceDir, rel);
  if (!fs.existsSync(target)) throw new Error(`file does not exist: ${rel}`);
  const root = fs.realpathSync(faceDir);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`${rel} is outside the face folder`);
  }
  return real;
}

const optionalString = (v) => (typeof v === 'string' && v ? v : null);

/** `"talk": "open.png"` or `"talk": ["half.png", "open.png"]`. */
function oneOrMany(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((f) => typeof f === 'string' && f);
}

function loadVoice(faceDir) {
  const index = path.join(faceDir, 'voice', 'index.json');
  if (!fs.existsSync(index)) return { clips: [], error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(index, 'utf8'));
    const entries = parsed && typeof parsed.clips === 'object' && parsed.clips ? parsed.clips : {};
    const clips = Object.entries(entries)
      .filter(([, c]) => c && typeof c.file === 'string')
      // A clip isn't tied to a state: the same line can be said in any mood.
      .map(([name, c]) => ({ name, file: c.file, text: optionalString(c.text) }));
    return { clips, error: null };
  } catch (e) {
    // A broken index must not take the face down with it.
    return { clips: [], error: `voice/index.json: ${e.message}` };
  }
}

/** The face in `faceDir`. Throws with a message a person can act on. */
function loadFace(faceDir) {
  const file = path.join(faceDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no face found: ${file} does not exist (run "init" to create a starter face)`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  const entries = cfg && cfg.states && typeof cfg.states === 'object' ? Object.entries(cfg.states) : [];
  if (!entries.length) throw new Error('config.json has no states');

  // Kept in file order: it's the order agents see, and the first state is
  // the fallback default.
  const states = entries.map(([name, s]) => {
    if (!s || typeof s.file !== 'string' || !s.file) {
      throw new Error(`state '${name}' has no "file"`);
    }
    return {
      name,
      file: s.file,
      /** Voice clip played once whenever the face switches to this state. */
      sound: optionalString(s.sound),
      /** Closed-mouth still shown between mouth frames while talking. */
      still: optionalString(s.still),
      /** Mouth frames, least to most open. Empty = the mouth doesn't move. */
      talk: oneOrMany(s.talk),
    };
  });

  const wanted = optionalString(cfg.default_state);
  const voice = loadVoice(faceDir);
  // Unnamed faces take the repo's name: `my-agent/agent-face` is "my-agent".
  const folder = path.basename(path.resolve(faceDir));
  const fallbackName = folder === 'agent-face' ? path.basename(path.dirname(path.resolve(faceDir))) : folder;
  return {
    dir: faceDir,
    name: optionalString(cfg.name) || fallbackName,
    description: optionalString(cfg.description),
    default_state: states.some((s) => s.name === wanted) ? wanted : states[0].name,
    states,
    lip_sync: lipSync.sane(cfg.lip_sync),
    clips: voice.clips,
    voice_error: voice.error,
  };
}

module.exports = { loadFace, resolveInside };
