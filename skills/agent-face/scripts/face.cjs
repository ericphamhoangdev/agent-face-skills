#!/usr/bin/env node
'use strict';
// face.cjs — the one command an agent uses to show and drive its face.
// Prints JSON; exits 0 when the command worked, 1 when it didn't.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const paths = require('../lib/paths.cjs');
const store = require('../lib/store.cjs');
const quiet = require('../lib/quiet.cjs');
const ipc = require('../lib/ipc.cjs');
const { loadFace, resolveInside } = require('../lib/config.cjs');
const { mediaInfo } = require('../lib/media.cjs');
const { createStarterFace } = require('../lib/starter.cjs');

/** Major version of Electron, the window runtime that `setup` installs. */
const ELECTRON_MAJOR = '44';

const HELP = `Usage: node face.cjs <command> [options]

Show and drive the face in ./agent-face (or --face <dir>).

  setup                          install the window runtime (Electron, one-time download)
  init [--name "Name"]           create a starter face in ./agent-face
  start                          show the face
  stop                           close the face until "start"
  status                         running? which state? sound settings, versions
  states                         list the face's states
  state <name> [--caption "…"]   switch state
  random [--caption "…"]         switch to a random other state
  caption ["text"]               short line under the face (no text = clear it)
  clips                          list voice clips
  say <clip> [--state <name>] [--caption "…"]
                                 speak a clip; the face keeps its state unless --state
  check                          validate the face folder
  snapshot <file.png>            save a picture of the face window
  version                        version of these skills`;

const CLOSED_HINT =
  'The face was closed on purpose (its × button or "stop"). Leave it closed; run "start" only when the user asks to see it again.';

/** A failure the agent can act on: message plus optional `hint` and friends. */
class CliError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

const VALUE_OPTIONS = new Set(['face', 'caption', 'state', 'name']);

function parse(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args.push(arg);
    } else if (VALUE_OPTIONS.has(arg.slice(2))) {
      opts[arg.slice(2)] = argv[++i];
    } else {
      opts[arg.slice(2)] = true;
    }
  }
  return { cmd: args.shift() || 'help', args, opts };
}

async function waitUntil(test, timeoutMs, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** The running window's status, or null when nothing is listening. */
async function hello(endpoint) {
  try {
    const reply = await ipc.request(endpoint, { cmd: 'hello' }, 2000);
    return reply.ok ? reply : null;
  } catch {
    return null;
  }
}

/** `{ path, version }` of the installed window runtime, or null. */
function electronInfo() {
  const dir = path.join(paths.runtimeDir(), 'node_modules', 'electron');
  try {
    const binary = require(dir); // the electron package exports the path of its binary
    if (typeof binary !== 'string' || !fs.existsSync(binary)) return null;
    return { path: binary, version: store.readJson(path.join(dir, 'package.json'), {}).version || null };
  } catch {
    return null;
  }
}

function launch(electron, faceDir, id) {
  const log = paths.logFile(id);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.rmSync(log);
  const out = fs.openSync(log, 'a');
  const env = { ...process.env };
  // Set by some hosts that are themselves Electron apps; it would make the
  // runtime start as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(paths.SKILL_ROOT, 'runtime'), '--face', faceDir], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.unref();
  fs.closeSync(out);
}

/**
 * Make sure the face window is up and running this version of the skill.
 * A face that was closed on purpose stays closed unless `explicit`.
 */
async function ensureRunning(faceDir, { explicit = false } = {}) {
  const id = paths.faceId(faceDir);
  const endpoint = paths.endpoint(id);
  let updated = false;

  let up = await hello(endpoint);
  if (up && up.version !== paths.VERSION) {
    // The skills were updated under a running window: restart it on the new files.
    await ipc.request(endpoint, { cmd: 'quit' }, 3000).catch(() => {});
    await waitUntil(async () => !(await hello(endpoint)), 6000);
    up = null;
    updated = true;
  }
  if (up) return { endpoint };

  const local = store.loadLocal(id);
  if (local.closed && !explicit) return { endpoint, closed: true };

  loadFace(faceDir); // a clear error now beats a blank window later
  const electron = electronInfo();
  if (!electron) {
    throw new CliError('the face window runtime is not installed yet', {
      code: 'runtime_missing',
      hint: 'Tell the user this downloads Electron once (about 100 MB), then run: face.cjs setup',
    });
  }
  if (local.closed) store.saveLocal(id, { ...local, closed: false });
  launch(electron.path, faceDir, id);
  if (!(await waitUntil(() => hello(endpoint), 25000))) {
    throw new CliError('the face window did not start', { hint: `see the log: ${paths.logFile(id)}` });
  }
  return { endpoint, started: true, updated };
}

/** Send one command to the face window, starting it first if needed. */
async function drive(faceDir, message, options) {
  const run = await ensureRunning(faceDir, options);
  if (run.closed) return { shown: false, face: 'closed', hint: CLOSED_HINT };
  const reply = await ipc.request(run.endpoint, message);
  if (!reply.ok) throw new CliError(reply.error);
  delete reply.ok;
  return { ...reply, ...(run.started ? { started: true } : {}), ...(run.updated ? { restarted_on: paths.VERSION } : {}) };
}

/** While the face is closed, remember the state so it shows on the next `start`. */
function rememberState(faceDir, name) {
  const face = loadFace(faceDir);
  if (!face.states.some((s) => s.name === name)) {
    throw new CliError(`state '${name}' is not in this face (have: ${face.states.map((s) => s.name).join(', ')})`);
  }
  const id = paths.faceId(faceDir);
  store.saveLocal(id, { ...store.loadLocal(id), state: name });
}

function setup() {
  const dir = paths.runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, `${JSON.stringify({ name: 'agent-face-window-runtime', private: true }, null, 2)}\n`);
  }
  // npm's own output goes to stderr so stdout stays one JSON document. A
  // fixed command line through the shell: on Windows npm is a .cmd file.
  const npm = spawnSync(`npm install electron@${ELECTRON_MAJOR} --no-audit --no-fund --loglevel=error`, {
    cwd: dir,
    stdio: ['ignore', 2, 2],
    shell: true,
  });
  const electron = electronInfo();
  if (npm.status !== 0 || !electron) {
    throw new CliError('could not install the window runtime', { hint: `npm install electron@${ELECTRON_MAJOR} failed in ${dir}` });
  }
  return { runtime: { installed: true, electron: electron.version, dir } };
}

function init(faceDir, opts) {
  if (fs.existsSync(path.join(faceDir, 'config.json'))) {
    throw new CliError(`a face already exists in ${faceDir}`, { hint: 'Edit that one, or use --face <dir> to create another.' });
  }
  const created = createStarterFace(faceDir, typeof opts.name === 'string' ? opts.name : undefined);
  return { face_dir: faceDir, created, next: 'face.cjs start' };
}

async function status(faceDir) {
  const id = paths.faceId(faceDir);
  const up = await hello(paths.endpoint(id));
  const local = store.loadLocal(id);
  const settings = store.loadSettings();
  const electron = electronInfo();
  let face = null;
  let faceError = null;
  try {
    face = loadFace(faceDir);
  } catch (e) {
    faceError = e.message;
  }
  return {
    version: paths.VERSION,
    face_dir: faceDir,
    face: face ? face.name : null,
    ...(faceError ? { face_error: faceError } : {}),
    running: Boolean(up),
    closed: !up && local.closed,
    state: up ? up.state : local.state || (face ? face.default_state : null),
    caption: up ? up.caption : null,
    muted: local.muted,
    volume: local.volume,
    quiet_now: quiet.isQuiet(settings.quiet_hours),
    quiet_hours: settings.quiet_hours,
    runtime: electron ? { installed: true, electron: electron.version } : { installed: false, hint: 'run: face.cjs setup' },
    ...(up && up.version !== paths.VERSION
      ? { window_version: up.version, note: 'The window is still on the previous version; the next state change restarts it.' }
      : {}),
  };
}

function check(faceDir) {
  const face = loadFace(faceDir);
  const errors = face.voice_error ? [face.voice_error] : [];
  const warnings = [];
  const info = (rel) => {
    try {
      return mediaInfo(resolveInside(faceDir, rel));
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
      return null;
    }
  };

  const states = face.states.map((s) => {
    const base = info(s.file);
    const frames = [...(s.still ? [['still', s.still]] : []), ...s.talk.map((f) => ['talk', f])];
    for (const [kind, rel] of frames) {
      const frame = info(rel);
      if (frame && base && base.width && frame.width && (frame.width !== base.width || frame.height !== base.height)) {
        errors.push(
          `state '${s.name}': ${kind} frame ${rel} is ${frame.width}x${frame.height} but ${s.file} is ${base.width}x${base.height}, so the mouth won't line up`,
        );
      }
    }
    if (s.talk.length && !s.still && base && base.frames > 1) {
      warnings.push(`state '${s.name}' is animated and has talk frames but no "still": its first frame is used as the closed mouth`);
    }
    if (s.sound && !face.clips.some((c) => c.name === s.sound)) {
      errors.push(`state '${s.name}': sound '${s.sound}' is not a clip in voice/index.json`);
    }
    return {
      name: s.name,
      file: s.file,
      ...(base ? { width: base.width, height: base.height, frames: base.frames, bytes: base.bytes } : {}),
      ...(s.still ? { still: s.still } : {}),
      ...(s.talk.length ? { talk: s.talk } : {}),
      ...(s.sound ? { sound: s.sound } : {}),
    };
  });

  const clips = face.clips.map((c) => {
    let bytes = null;
    try {
      bytes = fs.statSync(resolveInside(faceDir, path.join('voice', c.file))).size;
    } catch (e) {
      errors.push(`clip '${c.name}': ${e.message}`);
    }
    return { name: c.name, file: `voice/${c.file}`, text: c.text, bytes };
  });

  return {
    ok: errors.length === 0,
    face_dir: faceDir,
    name: face.name,
    default_state: face.default_state,
    lip_sync: face.lip_sync,
    states,
    clips,
    errors,
    warnings,
  };
}

async function main(argv) {
  const { cmd, args, opts } = parse(argv);
  if (cmd === 'help' || opts.help) return { help: HELP };
  if (cmd === 'version') return { version: paths.VERSION };
  if (cmd === 'setup') return setup();

  const faceDir = paths.findFaceDir(typeof opts.face === 'string' ? opts.face : undefined);
  const caption = typeof opts.caption === 'string' ? { caption: opts.caption } : {};
  const need = (value, what) => {
    if (!value) throw new CliError(`${cmd} needs ${what}`, { hint: 'run: face.cjs help' });
    return value;
  };

  switch (cmd) {
    case 'init':
      return init(faceDir, opts);
    case 'status':
      return status(faceDir);
    case 'check':
      return check(faceDir);
    case 'states': {
      const face = loadFace(faceDir);
      return { states: face.states.map((s) => s.name), default_state: face.default_state };
    }
    case 'clips': {
      const face = loadFace(faceDir);
      if (face.voice_error) throw new CliError(face.voice_error);
      return { clips: face.clips.map((c) => ({ name: c.name, text: c.text })) };
    }
    case 'start':
      return drive(faceDir, { cmd: 'hello' }, { explicit: true });
    case 'stop': {
      const id = paths.faceId(faceDir);
      const endpoint = paths.endpoint(id);
      if (await hello(endpoint)) {
        await ipc.request(endpoint, { cmd: 'quit', closed: true }, 3000).catch(() => {});
        await waitUntil(async () => !(await hello(endpoint)), 6000);
      } else {
        store.saveLocal(id, { ...store.loadLocal(id), closed: true });
      }
      return { face: 'closed' };
    }
    case 'state': {
      const name = need(args[0], 'a state name');
      const result = await drive(faceDir, { cmd: 'state', state: name, ...caption });
      if (result.face === 'closed') rememberState(faceDir, name);
      return result;
    }
    case 'random':
      return drive(faceDir, { cmd: 'random', ...caption });
    case 'caption':
      return drive(faceDir, { cmd: 'caption', caption: args.join(' ') || null });
    case 'say':
      return drive(faceDir, {
        cmd: 'say',
        clip: need(args[0], 'a clip name'),
        ...(typeof opts.state === 'string' ? { state: opts.state } : {}),
        ...caption,
      });
    case 'snapshot':
      return drive(faceDir, { cmd: 'snapshot', path: path.resolve(need(args[0], 'a .png path')) });
    default:
      throw new CliError(`unknown command '${cmd}'`, { hint: 'run: face.cjs help' });
  }
}

function print(result) {
  if (result.help) console.log(result.help);
  else console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).then(
  (result) => {
    const ok = result.ok !== false;
    print({ ok, ...result });
    if (!ok) process.exitCode = 1;
  },
  (error) => {
    print({ ok: false, error: error.message, ...(error.extra || {}) });
    process.exitCode = 1;
  },
);
