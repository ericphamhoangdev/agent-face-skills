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
const faceFolder = path.join(repo, '.agent-face');
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

const STARTER_STATES = ['happy', 'thinking', 'working', 'laugh', 'sad'];

test('help is plain text', () => {
  const run = face(['help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Usage: node face\.cjs/);
});

test('without any template, commands say how to get one', () => {
  const run = face(['states']);
  assert.equal(run.code, 1);
  assert.match(run.json.error, /no face templates found.*init/);
  const listed = face(['templates']).json;
  assert.deepEqual([listed.ok, listed.current, listed.templates], [true, null, []]);
  assert.match(listed.hint, /init/);
});

test('init creates a starter template in .agent-face that passes check', () => {
  const made = face(['init', '--name', 'Test Face']);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.deepEqual([made.json.face_folder, made.json.template], [faceFolder, 'starter']);
  assert.ok(made.json.created.includes('config.json'));
  assert.ok(fs.statSync(path.join(faceFolder, 'starter', 'voice', 'hello.wav')).size > 1000);

  const checked = face(['check']).json;
  assert.equal(checked.ok, true);
  const [starter] = checked.templates;
  assert.deepEqual([starter.template, starter.name, starter.clips, starter.errors, starter.warnings], ['starter', 'Test Face', 1, [], []]);
  assert.deepEqual(starter.states[0], {
    name: 'happy', file: 'happy.svg', width: 200, height: 200, frames: 1,
    bytes: starter.states[0].bytes, talk: ['mouth/happy-open.svg'],
  });
});

test('init refuses to overwrite a template, and rejects ids that are not folder names', () => {
  const again = face(['init']);
  assert.equal(again.code, 1);
  assert.match(again.json.error, /template 'starter' already exists/);
  assert.match(face(['init', '--template', '../escape']).json.error, /can't be a template id/);
});

test('a second template lives beside the first', () => {
  const made = face(['init', '--template', 'robo', '--name', 'Robo']);
  assert.equal(made.json.template, 'robo');
  // Give it different states and clips, so the two can be told apart.
  const dir = path.join(faceFolder, 'robo');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  config.states = { idle: config.states.happy, busy: config.states.working };
  config.default_state = 'idle';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(
    path.join(dir, 'voice', 'index.json'),
    JSON.stringify({ clips: { beep: { file: 'hello.wav', text: 'Beep.' }, boop: { file: 'hello.wav' } } }),
  );

  assert.deepEqual(face(['templates']).json, {
    ok: true,
    face_folder: faceFolder,
    current: 'robo', // nothing chosen yet: the first in name order
    templates: [
      { template: 'robo', name: 'Robo', description: config.description, states: 2, clips: 2 },
      { template: 'starter', name: 'Test Face', description: config.description, states: 5, clips: 1 },
    ],
  });
});

test('states and clips list any template, or the one in use', () => {
  assert.deepEqual(face(['states', '--template', 'starter']).json, {
    ok: true, template: 'starter', states: STARTER_STATES, default_state: 'happy',
  });
  assert.deepEqual(face(['states']).json, { ok: true, template: 'robo', states: ['idle', 'busy'], default_state: 'idle' });
  assert.deepEqual(face(['clips', '--template', 'starter']).json, {
    ok: true, template: 'starter', clips: [{ name: 'hello', text: 'Hello!' }],
  });
  assert.deepEqual(face(['clips']).json.clips, [{ name: 'beep', text: 'Beep.' }, { name: 'boop', text: null }]);
  assert.match(face(['states', '--template', 'nope']).json.error, /no template 'nope' \(have: robo, starter\)/);
});

test('the face folder is found from a subfolder of the repo', () => {
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(face(['states'], sub).json.template, 'robo');
});

test('check covers every template, or one, and catches what will not work', () => {
  const dir = path.join(faceFolder, 'starter');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'mouth', 'small.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
  const broken = structuredClone(config);
  broken.states.sad.talk = 'mouth/small.svg';
  broken.states.laugh.sound = 'giggle';
  broken.states.working.file = 'gone.svg';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(broken));

  const all = face(['check']);
  assert.equal(all.code, 1);
  assert.deepEqual(all.json.templates.map((t) => [t.template, t.errors.length > 0]), [['robo', false], ['starter', true]]);
  const errors = all.json.templates[1].errors.join('\n');
  assert.match(errors, /state 'sad': talk frame mouth\/small\.svg is 100x100 but sad\.svg is 200x200/);
  assert.match(errors, /state 'laugh': sound 'giggle' is not a clip/);
  assert.match(errors, /gone\.svg: file does not exist/);

  const one = face(['check', '--template', 'robo']);
  assert.deepEqual([one.code, one.json.ok, one.json.templates.length], [0, true, 1]);

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.rmSync(path.join(dir, 'mouth', 'small.svg'));
  assert.equal(face(['check']).json.ok, true);
});

test('status and current work before anything is installed', () => {
  const s = face(['status']).json;
  assert.deepEqual(
    [s.ok, s.template, s.face, s.running, s.closed, s.state, s.muted, s.volume, s.runtime.installed],
    [true, 'robo', 'Robo', false, false, 'idle', false, 0.7, false],
  );
  assert.match(s.version, /^\d+\.\d+\.\d+$/);

  const now = face(['current']).json;
  assert.deepEqual([now.ok, now.template, now.state, now.running, now.picture], [true, 'robo', 'idle', false, null]);
  assert.equal(now.image, path.join(faceFolder, 'robo', 'happy.svg'), "the state's own file");
});

test('driving the face without the runtime says to run setup', () => {
  const run = face(['state', 'busy']);
  assert.equal(run.code, 1);
  assert.equal(run.json.code, 'runtime_missing');
  assert.match(run.json.hint, /setup/);
});

test('a closed face stays closed, but remembers state and template for next time', () => {
  assert.deepEqual(face(['stop']).json, { ok: true, face: 'closed' });
  const run = face(['state', 'busy', '--caption', 'busy']);
  assert.deepEqual([run.code, run.json.shown, run.json.face], [0, false, 'closed']);
  assert.deepEqual([face(['status']).json.closed, face(['status']).json.state], [true, 'busy']);
  assert.equal(face(['state', 'nope']).code, 1, 'unknown states are still refused');
  assert.equal(face(['say', 'beep']).json.face, 'closed');

  assert.equal(face(['use', 'starter']).json.face, 'closed');
  const s = face(['status']).json;
  assert.deepEqual([s.template, s.state], ['starter', 'happy']);
  assert.equal(face(['templates']).json.current, 'starter');
  assert.match(face(['use', 'nope']).json.error, /no template 'nope'/);
});

test('a face left in the 0.1 location gets a pointer to the move', () => {
  const old = path.join(root, 'old-repo');
  fs.mkdirSync(path.join(old, '.git'), { recursive: true });
  fs.mkdirSync(path.join(old, 'agent-face'));
  fs.writeFileSync(path.join(old, 'agent-face', 'config.json'), JSON.stringify({ states: { idle: { file: 'idle.png' } } }));
  const run = face(['states'], old);
  assert.equal(run.code, 1);
  assert.equal(run.json.code, 'old_layout');
  assert.match(run.json.hint, /git mv agent-face \.agent-face\/<name>/);
});

test("the per-user data folder is never mistaken for a repo's face folder", () => {
  // Outside any repo, with the data folder one level up from where we stand.
  const parent = path.join(root, 'no-repo');
  const here = path.join(parent, 'work');
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true }); // stops the walk before the real home folder
  fs.mkdirSync(path.join(parent, '.agent-face', 'faces'), { recursive: true });
  fs.mkdirSync(here);
  const run = spawnSync(process.execPath, [CLI, 'templates'], {
    cwd: here,
    env: { ...env, AGENT_FACE_HOME: path.join(parent, '.agent-face') },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(run.stdout).face_folder, path.join(here, '.agent-face'));
});

test('usage mistakes are explained', () => {
  assert.match(face(['state']).json.error, /needs a state name/);
  assert.match(face(['use']).json.error, /needs a template id/);
  assert.match(face(['dance']).json.error, /unknown command 'dance'/);
});
