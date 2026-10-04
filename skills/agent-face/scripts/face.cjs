#!/usr/bin/env node
'use strict';
// face.cjs — the one command an agent uses to show and drive its face.
// Prints JSON; exits 0 when the command worked, 1 when it didn't.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const paths = require('../lib/paths.cjs');
const store = require('../lib/store.cjs');
const ipc = require('../lib/ipc.cjs');
const { loadTemplate, listTemplates, pickTemplate, resolveInside } = require('../lib/config.cjs');
const { mediaInfo } = require('../lib/media.cjs');
const { createStarterFace } = require('../lib/starter.cjs');

/** Major version of Electron, the window runtime that `setup` installs. */
const ELECTRON_MAJOR = '44';

const HELP = `Usage: node face.cjs <command> [options]

Show and drive the face whose templates live in ./.agent-face (or --face <dir>).
The face uses one template at a time; "use" switches it.

  setup                          install the window runtime (Electron, one-time download)
  init [--template <id>] [--name "Name"]
                                 create a starter template in ./.agent-face/<id>
  templates                      list the face templates, and which one is in use
  use <template>                 switch the face to another template
  start                          show the face
  stop                           close the face until "start"
  status                         running? template, state, mute and volume, versions
  current [--png <file.png>]     your face right now: template, state, caption, and a
                                 picture of it to show in the chat
  states [--template <id>]       list a template's states (default: the one in use)
  state <name> [--caption "…"]   switch state
  random [--caption "…"]         switch to a random other state
  caption ["text"]               short line under the face (no text = clear it)
  clips [--template <id>]        list a template's voice clips (default: the one in use)
  say <clip> [--state <name>] [--caption "…"]
                                 speak a clip; the face keeps its state unless --state
  sound-test                     play a short chirp and report what the audio output did
  check [--template <id>]        validate every template, or one
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

const VALUE_OPTIONS = new Set(['face', 'template', 'caption', 'state', 'name', 'png']);

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

const electronPackage = () => path.join(paths.runtimeDir(), 'node_modules', 'electron');

/**
 * `{ path, version }` of the installed window runtime, or null. Looks at
 * the files only: loading the electron package would start a download
 * (and print to stdout) when its binary isn't there yet.
 */
function electronInfo() {
  const dir = electronPackage();
  try {
    // path.txt names the binary inside dist/, e.g. "electron.exe".
    const binary = path.join(dir, 'dist', fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim());
    if (!fs.existsSync(binary)) return null;
    return { path: binary, version: store.readJson(path.join(dir, 'package.json'), {}).version || null };
  } catch {
    return null;
  }
}

/**
 * The template a command is about: the one named with --template, else the
 * one the face is using.
 */
function templateFor(faceFolder, opts = {}) {
  const local = store.loadLocal(paths.faceId(faceFolder));
  const wanted = typeof opts.template === 'string' ? opts.template : null;
  if (!listTemplates(faceFolder).length) {
    const legacy = paths.legacyFaceFolder(faceFolder);
    if (fs.existsSync(path.join(legacy, 'config.json'))) {
      throw new CliError(`no face templates in ${faceFolder}, but there is a face in the old location ${legacy}`, {
        code: 'old_layout',
        hint: `Templates now live in ${paths.FACE_FOLDER}/<template>/. Move the old folder: mkdir ${paths.FACE_FOLDER} && git mv agent-face ${paths.FACE_FOLDER}/<name> (plain "mv" if it isn't tracked), then run: face.cjs start`,
      });
    }
  }
  return loadTemplate(path.join(faceFolder, pickTemplate(faceFolder, wanted, local.template)));
}

/** Close a window still showing the single face that version 0.1 kept in `agent-face/`. */
async function closeLegacyWindow(faceFolder) {
  const endpoint = paths.endpoint(paths.faceId(paths.legacyFaceFolder(faceFolder)));
  if (await hello(endpoint)) await ipc.request(endpoint, { cmd: 'quit' }, 3000).catch(() => {});
}

function launch(electron, faceFolder, id) {
  const log = paths.logFile(id);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.rmSync(log);
  const out = fs.openSync(log, 'a');
  const env = { ...process.env };
  // Set by some hosts that are themselves Electron apps; it would make the
  // runtime start as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(paths.SKILL_ROOT, 'runtime'), '--face', faceFolder], {
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
async function ensureRunning(faceFolder, { explicit = false } = {}) {
  const id = paths.faceId(faceFolder);
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

  templateFor(faceFolder); // a clear error now beats a blank window later
  const electron = electronInfo();
  if (!electron) {
    throw new CliError('the face window runtime is not installed yet', {
      code: 'runtime_missing',
      hint: 'Tell the user this downloads Electron once (about 100 MB), then run: face.cjs setup',
    });
  }
  if (local.closed) store.saveLocal(id, { ...local, closed: false });
  await closeLegacyWindow(faceFolder);
  launch(electron.path, faceFolder, id);
  if (!(await waitUntil(() => hello(endpoint), 25000))) {
    throw new CliError('the face window did not start', { hint: `see the log: ${paths.logFile(id)}` });
  }
  return { endpoint, started: true, updated };
}

/** Send one command to the face window, starting it first if needed. */
async function drive(faceFolder, message, options) {
  const run = await ensureRunning(faceFolder, options);
  if (run.closed) return { shown: false, face: 'closed', hint: CLOSED_HINT };
  const reply = await ipc.request(run.endpoint, message);
  if (!reply.ok) throw new CliError(reply.error);
  delete reply.ok;
  return { ...reply, ...(run.started ? { started: true } : {}), ...(run.updated ? { restarted_on: paths.VERSION } : {}) };
}

/** While the face is closed, remember a change so it shows on the next `start`. */
function remember(faceFolder, change) {
  const id = paths.faceId(faceFolder);
  store.saveLocal(id, { ...store.loadLocal(id), ...change });
}

function rememberState(faceFolder, name) {
  const template = templateFor(faceFolder);
  if (!template.states.some((s) => s.name === name)) {
    throw new CliError(`state '${name}' is not in this face (have: ${template.states.map((s) => s.name).join(', ')})`);
  }
  remember(faceFolder, { template: template.id, state: name });
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
  const toStderr = { cwd: dir, stdio: ['ignore', 2, 2] };
  const npm = spawnSync(`npm install electron@${ELECTRON_MAJOR} --no-audit --no-fund --loglevel=error`, { ...toStderr, shell: true });
  // The npm package is only a launcher; its own installer fetches the
  // binary (recent versions leave that until first use).
  const installer = path.join(electronPackage(), 'install.js');
  if (npm.status === 0 && !electronInfo() && fs.existsSync(installer)) {
    spawnSync(process.execPath, [installer], toStderr);
  }
  const electron = electronInfo();
  if (npm.status !== 0 || !electron) {
    throw new CliError('could not install the window runtime', { hint: `npm install electron@${ELECTRON_MAJOR} failed in ${dir}` });
  }
  return { runtime: { installed: true, electron: electron.version, dir } };
}

function init(faceFolder, opts) {
  const id = typeof opts.template === 'string' ? opts.template : 'starter';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new CliError(`'${id}' can't be a template id`, { hint: 'Use letters, digits, "-", "_" and "."; it becomes a folder name.' });
  }
  const dir = path.join(faceFolder, id);
  if (fs.existsSync(path.join(dir, 'config.json'))) {
    throw new CliError(`template '${id}' already exists in ${faceFolder}`, { hint: 'Edit that one, or pick another id with --template.' });
  }
  const created = createStarterFace(dir, typeof opts.name === 'string' ? opts.name : undefined);
  return { face_folder: faceFolder, template: id, created, next: 'face.cjs start' };
}

function templates(faceFolder) {
  const local = store.loadLocal(paths.faceId(faceFolder));
  const ids = listTemplates(faceFolder);
  if (!ids.length) return { face_folder: faceFolder, current: null, templates: [], hint: 'No templates yet. Create a starter one with: face.cjs init' };
  return {
    face_folder: faceFolder,
    current: pickTemplate(faceFolder, null, local.template),
    templates: ids.map((id) => {
      try {
        const t = loadTemplate(path.join(faceFolder, id));
        return { template: id, name: t.name, description: t.description, states: t.states.length, clips: t.clips.length };
      } catch (e) {
        return { template: id, error: e.message };
      }
    }),
  };
}

async function status(faceFolder) {
  const id = paths.faceId(faceFolder);
  const up = await hello(paths.endpoint(id));
  const local = store.loadLocal(id);
  const electron = electronInfo();
  let template = null;
  let faceError = null;
  try {
    template = templateFor(faceFolder);
  } catch (e) {
    faceError = e.message;
  }
  const remembered = template && template.states.some((s) => s.name === local.state) ? local.state : null;
  return {
    version: paths.VERSION,
    face_folder: faceFolder,
    template: template ? template.id : null,
    face: template ? template.name : null,
    ...(faceError ? { face_error: faceError } : {}),
    running: Boolean(up),
    closed: !up && local.closed,
    state: up ? up.state : remembered || (template ? template.default_state : null),
    caption: up ? up.caption : null,
    speaking: up ? Boolean(up.speaking) : false,
    ...(up && up.speaking ? { ms_left: up.ms_left } : {}),
    muted: local.muted,
    volume: local.volume,
    runtime: electron ? { installed: true, electron: electron.version } : { installed: false, hint: 'run: face.cjs setup' },
    ...(up && up.version !== paths.VERSION
      ? { window_version: up.version, note: 'The window is still on the previous version; the next state change restarts it.' }
      : {}),
  };
}

/**
 * The face as it is right now, with a PNG of it for the chat. Never opens
 * the window: without one there is no picture, only the state's own file.
 */
async function current(faceFolder, opts) {
  const id = paths.faceId(faceFolder);
  const endpoint = paths.endpoint(id);
  if (await hello(endpoint)) {
    const png = path.resolve(typeof opts.png === 'string' ? opts.png : paths.pictureFile(id));
    const reply = await ipc.request(endpoint, { cmd: 'current', path: png });
    if (!reply.ok) throw new CliError(reply.error);
    const { template, face, state, caption, image, picture, width, height } = reply;
    return { template, face, state, caption, running: true, image, picture, width, height };
  }
  const local = store.loadLocal(id);
  const template = templateFor(faceFolder);
  const state = template.states.find((s) => s.name === local.state) || template.states.find((s) => s.name === template.default_state);
  return {
    template: template.id,
    face: template.name,
    state: state.name,
    caption: null,
    running: false,
    closed: local.closed,
    image: path.join(template.dir, state.file),
    picture: null,
    note: 'The window is not open, so there is no picture of it. "image" is the file of the current state.',
  };
}

/** Everything wrong with one template, plus the size and frame count of each state. */
function checkTemplate(faceFolder, id) {
  const dir = path.join(faceFolder, id);
  let template;
  try {
    template = loadTemplate(dir);
  } catch (e) {
    return { template: id, errors: [e.message], warnings: [] };
  }
  const errors = template.voice_error ? [template.voice_error] : [];
  const warnings = [];
  const info = (rel) => {
    try {
      return mediaInfo(resolveInside(dir, rel));
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
      return null;
    }
  };

  const states = template.states.map((s) => {
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
    if (s.sound && !template.clips.some((c) => c.name === s.sound)) {
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

  for (const clip of template.clips) {
    try {
      resolveInside(dir, path.join('voice', clip.file));
    } catch (e) {
      errors.push(`clip '${clip.name}': ${e.message}`);
    }
  }

  return {
    template: id,
    name: template.name,
    default_state: template.default_state,
    lip_sync: template.lip_sync,
    states,
    clips: template.clips.length,
    errors,
    warnings,
  };
}

function check(faceFolder, opts) {
  const ids = typeof opts.template === 'string' ? [pickTemplate(faceFolder, opts.template)] : listTemplates(faceFolder);
  if (!ids.length) pickTemplate(faceFolder); // throws the "no templates" message
  const checked = ids.map((id) => checkTemplate(faceFolder, id));
  return { ok: checked.every((t) => t.errors.length === 0), face_folder: faceFolder, templates: checked };
}

async function main(argv) {
  const { cmd, args, opts } = parse(argv);
  if (cmd === 'help' || opts.help) return { help: HELP };
  if (cmd === 'version') return { version: paths.VERSION };
  if (cmd === 'setup') return setup();

  const faceFolder = paths.findFaceFolder(typeof opts.face === 'string' ? opts.face : undefined);
  const caption = typeof opts.caption === 'string' ? { caption: opts.caption } : {};
  const need = (value, what) => {
    if (!value) throw new CliError(`${cmd} needs ${what}`, { hint: 'run: face.cjs help' });
    return value;
  };

  switch (cmd) {
    case 'init':
      return init(faceFolder, opts);
    case 'templates':
      return templates(faceFolder);
    case 'status':
      return status(faceFolder);
    case 'current':
      return current(faceFolder, opts);
    case 'check':
      return check(faceFolder, opts);
    case 'states': {
      const template = templateFor(faceFolder, opts);
      return { template: template.id, states: template.states.map((s) => s.name), default_state: template.default_state };
    }
    case 'clips': {
      const template = templateFor(faceFolder, opts);
      if (template.voice_error) throw new CliError(template.voice_error);
      return { template: template.id, clips: template.clips.map((c) => ({ name: c.name, text: c.text })) };
    }
    case 'use': {
      const wanted = pickTemplate(faceFolder, need(args[0], 'a template id'));
      const result = await drive(faceFolder, { cmd: 'use', template: wanted });
      if (result.face === 'closed') {
        const template = loadTemplate(path.join(faceFolder, wanted));
        remember(faceFolder, { template: wanted, state: template.default_state });
      }
      return result;
    }
    case 'start':
      return drive(faceFolder, { cmd: 'hello' }, { explicit: true });
    case 'stop': {
      const id = paths.faceId(faceFolder);
      const endpoint = paths.endpoint(id);
      if (await hello(endpoint)) {
        await ipc.request(endpoint, { cmd: 'quit', closed: true }, 3000).catch(() => {});
        await waitUntil(async () => !(await hello(endpoint)), 6000);
      } else {
        remember(faceFolder, { closed: true });
      }
      return { face: 'closed' };
    }
    case 'state': {
      const name = need(args[0], 'a state name');
      const result = await drive(faceFolder, { cmd: 'state', state: name, ...caption });
      if (result.face === 'closed') rememberState(faceFolder, name);
      return result;
    }
    case 'random':
      return drive(faceFolder, { cmd: 'random', ...caption });
    case 'caption':
      return drive(faceFolder, { cmd: 'caption', caption: args.join(' ') || null });
    case 'say':
      return drive(faceFolder, {
        cmd: 'say',
        clip: need(args[0], 'a clip name'),
        ...(typeof opts.state === 'string' ? { state: opts.state } : {}),
        ...caption,
      });
    case 'snapshot':
      return drive(faceFolder, { cmd: 'snapshot', path: path.resolve(need(args[0], 'a .png path')) });
    case 'sound-test':
      return drive(faceFolder, { cmd: 'sound-test' });
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
