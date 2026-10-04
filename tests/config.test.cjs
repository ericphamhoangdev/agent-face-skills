'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFace, resolveInside } = require('../skills/agent-face/lib/config.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-face-config-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function faceFolder(name, config, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('states keep the order of config.json, and the first one is the fallback default', () => {
  const dir = faceFolder('order', {
    name: 'Robot',
    default_state: 'nope',
    states: { working: { file: 'w.png' }, idle: { file: 'i.png' }, asleep: { file: 'a.png' } },
  });
  const face = loadFace(dir);
  assert.deepEqual(face.states.map((s) => s.name), ['working', 'idle', 'asleep']);
  assert.equal(face.default_state, 'working');
  assert.equal(face.name, 'Robot');
  assert.deepEqual(face.clips, []);
});

test('lip-sync fields: talk is one file or a list; tuning is filled in', () => {
  const dir = faceFolder('talk', {
    lip_sync: { step_ms: 30 },
    states: {
      idle: { file: 'idle.webp', still: 'idle.png', talk: ['mouth/half.png', 'mouth/open.png'], sound: 'hi' },
      happy: { file: 'happy.png', talk: 'mouth/happy-open.png' },
      sad: { file: 'sad.png' },
    },
  });
  const [idle, happy, sad] = loadFace(dir).states;
  assert.deepEqual(idle.talk, ['mouth/half.png', 'mouth/open.png']);
  assert.equal(idle.still, 'idle.png');
  assert.equal(idle.sound, 'hi');
  assert.deepEqual(happy.talk, ['mouth/happy-open.png']);
  assert.deepEqual([sad.talk, sad.still, sad.sound], [[], null, null]);
  assert.deepEqual(loadFace(dir).lip_sync, { step_ms: 30, open_at: 0.1, wide_at: 0.45, hold_steps: 3 });
});

test('voice clips: name, file, text — a per-clip state from older faces is ignored', () => {
  const dir = faceFolder(
    'voice',
    { states: { idle: { file: 'idle.png' } } },
    {
      'voice/index.json': JSON.stringify({
        voice: 'whatever made the clips',
        clips: { hello: { file: 'hello.mp3', text: 'Hi there.', state: 'idle' }, hum: { file: 'hum.wav' } },
      }),
    },
  );
  assert.deepEqual(loadFace(dir).clips, [
    { name: 'hello', file: 'hello.mp3', text: 'Hi there.' },
    { name: 'hum', file: 'hum.wav', text: null },
  ]);
});

test('a broken voice index is reported but does not break the face', () => {
  const dir = faceFolder('broken-voice', { states: { idle: { file: 'idle.png' } } }, { 'voice/index.json': '{ nope' });
  const face = loadFace(dir);
  assert.deepEqual(face.clips, []);
  assert.match(face.voice_error, /voice\/index\.json/);
});

test('problems come with messages a person can act on', () => {
  assert.throws(() => loadFace(faceFolder('missing')), /no face found.*init/);
  assert.throws(() => loadFace(faceFolder('bad-json', '{ states: ')), /not valid JSON/);
  assert.throws(() => loadFace(faceFolder('empty', { states: {} })), /no states/);
  assert.throws(() => loadFace(faceFolder('no-file', { states: { idle: {} } })), /state 'idle' has no "file"/);
});

test('files are only ever read from inside the face folder', () => {
  const dir = faceFolder('inside', { states: { idle: { file: 'idle.png' } } }, { 'idle.png': 'x', 'voice/a.wav': 'x' });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'x');
  assert.equal(resolveInside(dir, 'idle.png'), fs.realpathSync(path.join(dir, 'idle.png')));
  assert.equal(resolveInside(dir, 'voice/a.wav'), fs.realpathSync(path.join(dir, 'voice', 'a.wav')));
  assert.throws(() => resolveInside(dir, '../outside.txt'), /outside the face folder/);
  assert.throws(() => resolveInside(dir, path.join(root, 'outside.txt')), /outside the face folder/);
  assert.throws(() => resolveInside(dir, 'nope.png'), /does not exist/);
});
