'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadTemplate, listTemplates, pickTemplate, resolveInside } = require('../skills/agent-face/lib/config.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-face-config-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A template folder `<root>/<folder>/<id>` with the given config and files. */
function template(folder, id, config, files = {}) {
  const dir = path.join(root, folder, id);
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

const oneState = { states: { idle: { file: 'idle.png' } } };

test('states keep the order of config.json, and the first one is the fallback default', () => {
  const dir = template('order', 'robot', {
    name: 'Robot',
    default_state: 'nope',
    states: { working: { file: 'w.png' }, idle: { file: 'i.png' }, asleep: { file: 'a.png' } },
  });
  const loaded = loadTemplate(dir);
  assert.deepEqual(loaded.states.map((s) => s.name), ['working', 'idle', 'asleep']);
  assert.equal(loaded.default_state, 'working');
  assert.deepEqual([loaded.id, loaded.name], ['robot', 'Robot']);
  assert.deepEqual(loaded.clips, []);
  assert.equal(loadTemplate(template('order', 'unnamed', oneState)).name, 'unnamed', 'the folder name stands in for a missing name');
});

test('lip-sync fields: talk is one file or a list; tuning is filled in', () => {
  const dir = template('talk', 'robot', {
    lip_sync: { step_ms: 30 },
    states: {
      idle: { file: 'idle.webp', still: 'idle.png', talk: ['mouth/half.png', 'mouth/open.png'], sound: 'hi' },
      happy: { file: 'happy.png', talk: 'mouth/happy-open.png' },
      sad: { file: 'sad.png' },
    },
  });
  const [idle, happy, sad] = loadTemplate(dir).states;
  assert.deepEqual(idle.talk, ['mouth/half.png', 'mouth/open.png']);
  assert.equal(idle.still, 'idle.png');
  assert.equal(idle.sound, 'hi');
  assert.deepEqual(happy.talk, ['mouth/happy-open.png']);
  assert.deepEqual([sad.talk, sad.still, sad.sound], [[], null, null]);
  assert.deepEqual(loadTemplate(dir).lip_sync, { step_ms: 30, open_at: 0.1, wide_at: 0.45, hold_steps: 3 });
});

test('voice clips: name, file, text — a per-clip state from older faces is ignored', () => {
  const dir = template('voice', 'robot', oneState, {
    'voice/index.json': JSON.stringify({
      voice: 'whatever made the clips',
      clips: { hello: { file: 'hello.mp3', text: 'Hi there.', state: 'idle' }, hum: { file: 'hum.wav' } },
    }),
  });
  assert.deepEqual(loadTemplate(dir).clips, [
    { name: 'hello', file: 'hello.mp3', text: 'Hi there.' },
    { name: 'hum', file: 'hum.wav', text: null },
  ]);
});

test('a broken voice index is reported but does not break the template', () => {
  const loaded = loadTemplate(template('broken-voice', 'robot', oneState, { 'voice/index.json': '{ nope' }));
  assert.deepEqual(loaded.clips, []);
  assert.match(loaded.voice_error, /voice\/index\.json/);
});

test('problems name the template and say what is wrong', () => {
  assert.throws(() => loadTemplate(template('bad', 'missing')), /template 'missing' has no config\.json/);
  assert.throws(() => loadTemplate(template('bad', 'bad-json', '{ states: ')), /template 'bad-json': config\.json is not valid JSON/);
  assert.throws(() => loadTemplate(template('bad', 'empty', { states: {} })), /template 'empty': config\.json has no states/);
  assert.throws(() => loadTemplate(template('bad', 'no-file', { states: { idle: {} } })), /template 'no-file': state 'idle' has no "file"/);
});

test('a face folder holds several templates; only folders with a config.json count', () => {
  const folder = path.join(root, 'many');
  template('many', 'robot', oneState);
  template('many', 'cat', oneState);
  template('many', 'notes'); // a folder without config.json
  fs.writeFileSync(path.join(folder, 'README.txt'), 'x');
  assert.deepEqual(listTemplates(folder), ['cat', 'robot']);
  assert.deepEqual(listTemplates(path.join(root, 'does-not-exist')), []);
});

test('picking a template: the one asked for, else the remembered one, else the first', () => {
  const folder = path.join(root, 'many');
  assert.equal(pickTemplate(folder, 'robot', 'cat'), 'robot');
  assert.equal(pickTemplate(folder, null, 'robot'), 'robot');
  assert.equal(pickTemplate(folder, null, 'deleted-since'), 'cat');
  assert.equal(pickTemplate(folder, null, null), 'cat');
  assert.throws(() => pickTemplate(folder, 'dog'), /no template 'dog' \(have: cat, robot\)/);
  assert.throws(() => pickTemplate(path.join(root, 'does-not-exist')), /no face templates found.*init/);
});

test('files are only ever read from inside the template folder', () => {
  const dir = template('inside', 'robot', oneState, { 'idle.png': 'x', 'voice/a.wav': 'x' });
  template('inside', 'other', oneState, { 'idle.png': 'x' });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'x');
  assert.equal(resolveInside(dir, 'idle.png'), fs.realpathSync(path.join(dir, 'idle.png')));
  assert.equal(resolveInside(dir, 'voice/a.wav'), fs.realpathSync(path.join(dir, 'voice', 'a.wav')));
  assert.throws(() => resolveInside(dir, '../../outside.txt'), /outside the template folder/);
  assert.throws(() => resolveInside(dir, '../other/idle.png'), /outside the template folder/, 'not even a sibling template');
  assert.throws(() => resolveInside(dir, path.join(root, 'outside.txt')), /outside the template folder/);
  assert.throws(() => resolveInside(dir, 'nope.png'), /does not exist/);
});
