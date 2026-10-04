'use strict';
// face.cjs without a window: everything here runs with no runtime installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'skills', 'agent-face', 'scripts', 'face.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-face-cli-'));
const repo = path.join(root, 'repo');
const env = { ...process.env, AGENT_FACE_HOME: path.join(root, 'home') };
delete env.AGENT_FACE_DIR;
fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // marks the repo root
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function face(args, cwd = repo) {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    // not JSON: the caller looks at stdout
  }
  return { code: run.status, json, stdout: run.stdout, stderr: run.stderr };
}

test('help is plain text', () => {
  const run = face(['help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Usage: node face\.cjs/);
});

test('without a face, commands say how to get one', () => {
  const run = face(['states']);
  assert.equal(run.code, 1);
  assert.match(run.json.error, /no face found.*init/);
});

test('init creates a starter face that passes check', () => {
  const made = face(['init', '--name', 'Test Face']);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.equal(made.json.face_dir, path.join(repo, 'agent-face'));
  assert.ok(made.json.created.includes('config.json'));
  assert.ok(made.json.created.includes('voice/hello.wav'));
  assert.ok(fs.statSync(path.join(repo, 'agent-face', 'voice', 'hello.wav')).size > 1000);

  const checked = face(['check']).json;
  assert.deepEqual([checked.ok, checked.errors, checked.warnings], [true, [], []]);
  assert.equal(checked.name, 'Test Face');
  assert.deepEqual(checked.states[0], {
    name: 'happy', file: 'happy.svg', width: 200, height: 200, frames: 1,
    bytes: checked.states[0].bytes, talk: ['mouth/happy-open.svg'],
  });
  assert.deepEqual(checked.clips.map((c) => [c.name, c.text]), [['hello', 'Hello!']]);
});

test('init refuses to overwrite a face', () => {
  const again = face(['init']);
  assert.equal(again.code, 1);
  assert.match(again.json.error, /already exists/);
});

test('states and clips are read straight from the folder', () => {
  assert.deepEqual(face(['states']).json, {
    ok: true,
    states: ['happy', 'thinking', 'working', 'laugh', 'sad'],
    default_state: 'happy',
  });
  assert.deepEqual(face(['clips']).json.clips, [{ name: 'hello', text: 'Hello!' }]);
});

test('the face is found from a subfolder of the repo', () => {
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(face(['states'], sub).json.default_state, 'happy');
});

test('check catches frames that will not line up, and sounds that do not exist', () => {
  const dir = path.join(repo, 'agent-face');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'mouth', 'small.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
  const broken = structuredClone(config);
  broken.states.sad.talk = 'mouth/small.svg';
  broken.states.laugh.sound = 'giggle';
  broken.states.working.file = 'gone.svg';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(broken));

  const checked = face(['check']);
  assert.equal(checked.code, 1);
  assert.equal(checked.json.ok, false);
  const errors = checked.json.errors.join('\n');
  assert.match(errors, /state 'sad': talk frame mouth\/small\.svg is 100x100 but sad\.svg is 200x200/);
  assert.match(errors, /state 'laugh': sound 'giggle' is not a clip/);
  assert.match(errors, /gone\.svg: file does not exist/);

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.rmSync(path.join(dir, 'mouth', 'small.svg'));
});

test('status works before anything is installed', () => {
  const s = face(['status']).json;
  assert.deepEqual(
    [s.ok, s.running, s.closed, s.state, s.muted, s.volume, s.runtime.installed],
    [true, false, false, 'happy', false, 0.7, false],
  );
  assert.equal(s.quiet_hours.start, '20:00');
  assert.match(s.version, /^\d+\.\d+\.\d+$/);
});

test('driving the face without the runtime says to run setup', () => {
  const run = face(['state', 'working']);
  assert.equal(run.code, 1);
  assert.equal(run.json.code, 'runtime_missing');
  assert.match(run.json.hint, /setup/);
});

test('a closed face stays closed, but remembers the state for next time', () => {
  assert.deepEqual(face(['stop']).json, { ok: true, face: 'closed' });
  const run = face(['state', 'working', '--caption', 'busy']);
  assert.equal(run.code, 0);
  assert.equal(run.json.shown, false);
  assert.equal(run.json.face, 'closed');
  const s = face(['status']).json;
  assert.deepEqual([s.closed, s.state], [true, 'working']);
  assert.equal(face(['state', 'nope']).code, 1, 'unknown states are still refused');
  assert.equal(face(['say', 'hello']).json.face, 'closed');
});

test('usage mistakes are explained', () => {
  assert.match(face(['state']).json.error, /needs a state name/);
  assert.match(face(['dance']).json.error, /unknown command 'dance'/);
});
