#!/usr/bin/env node
'use strict';
// End-to-end: a real face window, driven the way an agent drives it.
// Needs a desktop session. Silent: the test face plays at volume 0.
//
//   npm run e2e
//
// Uses its own data folder so it never touches ~/.agent-face. Set
// AGENT_FACE_E2E_HOME to reuse one (and skip the Electron download).

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL = path.join(__dirname, '..', 'skills', 'agent-face');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-face-e2e-'));
const home = process.env.AGENT_FACE_E2E_HOME || path.join(root, 'home');
const repo = path.join(root, 'repo');
const faceFolder = path.join(repo, '.agent-face');
const starter = path.join(faceFolder, 'starter');
const env = { ...process.env, AGENT_FACE_HOME: home };
delete env.AGENT_FACE_DIR;

process.env.AGENT_FACE_HOME = home; // so the paths module agrees with the commands
const paths = require(path.join(SKILL, 'lib', 'paths.cjs'));
const store = require(path.join(SKILL, 'lib', 'store.cjs'));
const { wav } = require(path.join(SKILL, 'lib', 'starter.cjs'));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function face(args, { cli = path.join(SKILL, 'scripts', 'face.cjs'), inherit = false } = {}) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', inherit ? 'inherit' : 'pipe'],
  });
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`face.cjs ${args.join(' ')} printed:\n${run.stdout}\n${run.stderr || ''}`);
  }
}

let steps = 0;
function step(name, fn) {
  fn();
  steps += 1;
  console.log(`ok ${steps} - ${name}`);
}

try {
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

  step('init creates templates that pass check', () => {
    assert.equal(face(['init', '--name', 'E2E Face']).template, 'starter');
    assert.equal(face(['init', '--template', 'alt', '--name', 'Alt Face']).template, 'alt');
    assert.equal(face(['check']).ok, true);
    // The window shows `starter` first, whatever the name order.
    assert.equal(face(['stop']).face, 'closed');
    assert.equal(face(['use', 'starter']).face, 'closed');
  });

  step('setup installs the window runtime', () => {
    if (!face(['status']).runtime.installed) {
      console.log('   installing Electron (first run only)…');
      assert.equal(face(['setup'], { inherit: true }).ok, true);
    }
    assert.equal(face(['status']).runtime.installed, true);
  });

  // Silent run: this face plays at volume 0.
  const id = paths.faceId(faceFolder);
  store.saveLocal(id, { ...store.loadLocal(id), volume: 0 });
  // A clip long enough to photograph: a steady tone from 0.3 s to 2.3 s.
  const rate = 22050;
  const tone = new Int16Array(rate * 2.5);
  for (let i = Math.round(rate * 0.3); i < rate * 2.3; i++) tone[i] = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  fs.writeFileSync(path.join(starter, 'voice', 'tone.wav'), wav(tone, rate));
  const index = JSON.parse(fs.readFileSync(path.join(starter, 'voice', 'index.json'), 'utf8'));
  index.clips.tone = { file: 'tone.wav', text: 'A test tone.' };
  fs.writeFileSync(path.join(starter, 'voice', 'index.json'), JSON.stringify(index, null, 2));

  step('start opens the window', () => {
    const started = face(['start']);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.started, true);
    assert.deepEqual([started.template, started.state], ['starter', 'happy']);
    assert.equal(face(['start']).started, undefined, 'a second start reuses the window');
  });

  step('state, caption and random', () => {
    assert.deepEqual(face(['state', 'working', '--caption', '  running   the tests ']), {
      ok: true, state: 'working', caption: 'running the tests',
    });
    const other = face(['random']);
    assert.notEqual(other.state, 'working');
    assert.equal(other.caption, null, 'a state change clears the caption');
    assert.equal(face(['caption', 'x'.repeat(80)]).caption.length, 60);
    assert.equal(face(['caption']).caption, null);
    assert.match(face(['state', 'nope']).error, /state 'nope' is not in this face/);
  });

  step('say plays the clip with lip-sync and clears its caption afterwards', () => {
    const said = face(['say', 'hello']);
    assert.deepEqual([said.result, said.lip_sync, said.duration_ms, said.caption], ['played', true, 750, 'Hello!']);
    sleep(1500);
    assert.equal(face(['status']).caption, null);
  });

  step('say --state switches first, and the mouth is open mid-clip', () => {
    const said = face(['say', 'tone', '--state', 'sad', '--caption', 'testing']);
    assert.deepEqual([said.result, said.lip_sync, said.state, said.caption], ['played', true, 'sad', 'testing']);
    // The mouth dips shut one step in four, so look a few times.
    const during = [];
    for (let i = 0; i < 4; i++) {
      sleep(250);
      const shot = path.join(root, `during-${i}.png`);
      assert.equal(face(['snapshot', shot]).ok, true);
      during.push(fs.readFileSync(shot));
    }
    sleep(2200);
    assert.equal(face(['status']).caption, null, 'the caption went away with the clip');
    // Same caption as during the clip, so the mouth is the only difference.
    face(['caption', 'testing']);
    const after = path.join(root, 'after.png');
    assert.equal(face(['snapshot', after]).ok, true);
    const closed = fs.readFileSync(after);
    assert.equal(closed.toString('latin1', 1, 4), 'PNG');
    assert.ok(during.some((shot) => !shot.equals(closed)), 'the mouth was open at some point while speaking');
    assert.ok(face(['snapshot', after]).ok && fs.readFileSync(after).equals(closed), 'snapshots of a still face are identical');
  });

  step('current describes the face and makes a picture for the chat', () => {
    face(['state', 'happy', '--caption', 'hello there']);
    const png = path.join(root, 'current.png');
    const now = face(['current', '--png', png]);
    assert.deepEqual(
      [now.ok, now.template, now.face, now.state, now.caption, now.running],
      [true, 'starter', 'E2E Face', 'happy', 'hello there', true],
    );
    assert.equal(now.image, path.join(starter, 'happy.svg'));
    assert.deepEqual([now.picture, now.width, now.height], [png, 512, 512]);
    assert.equal(fs.readFileSync(png).toString('latin1', 1, 4), 'PNG');
    const byDefault = face(['current']);
    assert.equal(byDefault.picture, paths.pictureFile(id));
    assert.ok(fs.readFileSync(byDefault.picture).equals(fs.readFileSync(png)), 'the same face gives the same picture');
    face(['state', 'sad']);
    assert.ok(!fs.readFileSync(face(['current']).picture).equals(fs.readFileSync(png)), 'a different state gives a different picture');
  });

  step('use switches template, keeping the state when the new one has it', () => {
    const alt = path.join(faceFolder, 'alt');
    const config = JSON.parse(fs.readFileSync(path.join(alt, 'config.json'), 'utf8'));
    delete config.states.thinking; // alt has four states; starter has five
    fs.writeFileSync(path.join(alt, 'config.json'), JSON.stringify(config, null, 2));
    sleep(700);

    assert.deepEqual(face(['templates']).templates.map((t) => [t.template, t.states]), [['alt', 4], ['starter', 5]]);
    assert.deepEqual(face(['states', '--template', 'alt']).states, ['happy', 'working', 'laugh', 'sad']);
    face(['state', 'sad']);
    assert.deepEqual(face(['use', 'alt']), { ok: true, template: 'alt', state: 'sad', caption: null });
    assert.deepEqual([face(['status']).template, face(['status']).face], ['alt', 'Alt Face']);
    assert.equal(face(['current']).image, path.join(alt, 'sad.svg'));
    assert.match(face(['state', 'thinking']).error, /state 'thinking' is not in this face/);
    assert.match(face(['use', 'nope']).error, /no template 'nope' \(have: alt, starter\)/);

    face(['use', 'starter']);
    face(['state', 'thinking']);
    assert.equal(face(['use', 'alt']).state, 'happy', 'falls back to the default state');
    assert.equal(face(['use', 'starter']).template, 'starter');
  });

  step('mistakes change nothing', () => {
    const before = face(['status']).state;
    assert.match(face(['say', 'nope']).error, /no voice clip 'nope' \(have: hello, tone\)/);
    assert.match(face(['say', 'hello', '--state', 'nope']).error, /state 'nope'/);
    assert.equal(face(['status']).state, before);
  });

  step('edits to the folder show up without a command', () => {
    const file = path.join(starter, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, name: 'Renamed' }, null, 2));
    sleep(1500);
    assert.equal(face(['status']).face, 'Renamed');
    fs.writeFileSync(file, '{ broken');
    sleep(1000);
    assert.match(face(['state', 'happy']).error, /not valid JSON/);
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    sleep(1000);
    assert.equal(face(['state', 'happy']).ok, true);
  });

  step('a closed face stays closed until start', () => {
    assert.deepEqual(face(['stop']), { ok: true, face: 'closed' });
    const ignored = face(['state', 'thinking']);
    assert.deepEqual([ignored.ok, ignored.shown, ignored.face], [true, false, 'closed']);
    assert.equal(face(['status']).running, false);
    const back = face(['start']);
    assert.deepEqual([back.started, back.state], [true, 'thinking']);
  });

  step('after an update, the next command restarts the window on the new version', () => {
    const next = path.join(root, 'skill-next');
    fs.cpSync(SKILL, next, { recursive: true });
    fs.writeFileSync(path.join(next, 'VERSION'), '99.0.0\n');
    const cli = path.join(next, 'scripts', 'face.cjs');
    assert.equal(face(['status'], { cli }).window_version, paths.VERSION);
    assert.equal(face(['state', 'working'], { cli }).restarted_on, '99.0.0');
    assert.equal(face(['status'], { cli }).window_version, undefined);
    face(['stop'], { cli });
  });

  console.log(`\n${steps} steps passed`);
} finally {
  face(['stop']);
  sleep(800);
  if (process.env.AGENT_FACE_E2E_KEEP) console.log(`kept: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
