'use strict';
// Reads the face folder (`.agent-face/` in the agent's repo). Each
// sub-folder with a config.json is a face template: its states, lip-sync
// tuning and optional voice/index.json (clips). Read fresh on every use, so
// edits take effect without restarting anything.

const fs = require('fs');
const path = require('path');

const lipSync = require('../runtime/lipsync.js');

/**
 * Absolute path of an existing file inside a template folder. Refuses paths
 * that escape it (`..`, absolute paths, links), so a template can never
 * make the window read files from elsewhere on the machine.
 */
function resolveInside(templateDir, rel) {
  const target = path.resolve(templateDir, rel);
  if (!fs.existsSync(target)) throw new Error(`file does not exist: ${rel}`);
  const root = fs.realpathSync(templateDir);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`${rel} is outside the template folder`);
  }
  return real;
}

/** Ids (folder names) of the templates in the face folder, in name order. */
function listTemplates(faceFolder) {
  let entries;
  try {
    entries = fs.readdirSync(faceFolder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(faceFolder, e.name, 'config.json')))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The template to use: `wanted` if given, else `remembered` if it still
 * exists, else the first one. Throws when `wanted` isn't a template or the
 * folder has none.
 */
function pickTemplate(faceFolder, wanted, remembered) {
  const have = listTemplates(faceFolder);
  if (!have.length) {
    throw new Error(`no face templates found in ${faceFolder} (run "init" to create a starter face)`);
  }
  if (wanted) {
    if (!have.includes(wanted)) throw new Error(`no template '${wanted}' (have: ${have.join(', ')})`);
    return wanted;
  }
  return have.includes(remembered) ? remembered : have[0];
}

const optionalString = (v) => (typeof v === 'string' && v ? v : null);

/** `"talk": "open.png"` or `"talk": ["half.png", "open.png"]`. */
function oneOrMany(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((f) => typeof f === 'string' && f);
}

function loadVoice(templateDir) {
  const index = path.join(templateDir, 'voice', 'index.json');
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
    // A broken index must not take the template down with it.
    return { clips: [], error: `voice/index.json: ${e.message}` };
  }
}

/** The template in `templateDir`. Throws with a message a person can act on. */
function loadTemplate(templateDir) {
  const file = path.join(templateDir, 'config.json');
  const id = path.basename(path.resolve(templateDir));
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`template '${id}' has no config.json`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`template '${id}': config.json is not valid JSON: ${e.message}`);
  }
  const entries = cfg && cfg.states && typeof cfg.states === 'object' ? Object.entries(cfg.states) : [];
  if (!entries.length) throw new Error(`template '${id}': config.json has no states`);

  // Kept in file order: it's the order agents see, and the first state is
  // the fallback default.
  const states = entries.map(([name, s]) => {
    if (!s || typeof s.file !== 'string' || !s.file) {
      throw new Error(`template '${id}': state '${name}' has no "file"`);
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
  const voice = loadVoice(templateDir);
  return {
    /** The template's folder name: what commands call it. */
    id,
    dir: templateDir,
    name: optionalString(cfg.name) || id,
    description: optionalString(cfg.description),
    default_state: states.some((s) => s.name === wanted) ? wanted : states[0].name,
    states,
    lip_sync: lipSync.sane(cfg.lip_sync),
    clips: voice.clips,
    voice_error: voice.error,
  };
}

module.exports = { loadTemplate, listTemplates, pickTemplate, resolveInside };
