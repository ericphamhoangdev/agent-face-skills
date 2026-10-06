'use strict';
// The repo-safety-scan skill's scanner (.claude/skills/repo-safety-scan).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCAN = path.join(__dirname, '..', '.claude', 'skills', 'repo-safety-scan', 'scripts', 'scan.cjs');
const { scanLine, scanText, fileFindings, identityFindings } = require(SCAN);

// Values the scan must catch, built at run time so that this file holds none of them.
const AWS_KEY = ['AKIA', 'Q7'.repeat(8)].join('');
const GITHUB_TOKEN = ['ghp', 'A1b2'.repeat(10)].join('_');
const PRIVATE_KEY = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
const URL_WITH_PASSWORD = ['https://bob', 'hunter2hunter2@example.com/app'].join(':');
const RANDOM = crypto.createHash('sha256').update('not a real secret').digest('base64');
const PERSONAL_EMAIL = ['jane.doe', 'mail-provider.com'].join('@');
const NOREPLY = ['123+jdoe-dev', 'users.noreply.github.com'].join('@');
const HOME_PATH = ['C:', 'Users', 'jdoe', 'code', 'app'].join('\\');
const DRIVE_PATH = ['D:', 'work', 'thing'].join('/');
const PUBLIC_IP = [8, 8, 4, 4].join('.');
const TERM = 'zanzibar-skunkworks';

const ctx = (terms = [], allow = []) => ({ terms: { terms, allow } });
const rules = (line, c = ctx()) => scanLine(c, line).map((f) => f.rule);

test('secrets with a known shape are blockers', () => {
  for (const [line, rule] of [
    [`key = ${AWS_KEY}`, 'aws-key'],
    [`token: ${GITHUB_TOKEN}`, 'github-token'],
    [PRIVATE_KEY, 'private-key'],
    [`DATABASE_URL=${URL_WITH_PASSWORD}`, 'url-password'],
  ]) {
    const found = scanLine(ctx(), line).find((f) => f.rule === rule);
    assert.ok(found, `${rule} in: ${line}`);
    assert.equal(found.severity, 'blocker');
  }
  assert.deepEqual(rules('see https://user:<token>@host/repo and https://user:password@host'), []);
  assert.deepEqual(rules(`seed = '${RANDOM}'`), ['random-token']);
});

test('personal details: emails, home paths and the personal terms list', () => {
  assert.deepEqual(rules(`mail ${PERSONAL_EMAIL}`), ['email']);
  assert.deepEqual(rules(`mail you@example.com, ${NOREPLY}, clone git@github.com:owner/repo.git`), []);
  assert.deepEqual(rules(`cd ${HOME_PATH}`), ['home-path']);
  assert.deepEqual(rules('cd C:\\Users\\<you>\\code or /home/example/code or ~/code'), []);
  assert.deepEqual(rules(`copy it to ${DRIVE_PATH}`), ['local-path']);
  assert.deepEqual(rules(`server at ${PUBLIC_IP}, not 127.0.0.1 or 192.168.1.20`), ['ip-address']);

  const mine = ctx(['zanzibar'], ['zanzibar-dev']);
  assert.deepEqual(rules('notes from the Zanzibar project', mine), ['personal-term']);
  assert.deepEqual(rules('npx skills add zanzibar-dev/tools', mine), []);
});

test('a line marked "safety-scan: allow" is skipped', () => {
  assert.deepEqual(scanText(ctx(), `const key = '${AWS_KEY}'; // safety-scan: allow (test fixture)\nnext line`), []);
  assert.equal(scanText(ctx(), `fine\nconst key = '${AWS_KEY}';`)[0].line, 2);
});

test('files judged by their names', () => {
  const found = (rel) => fileFindings(ctx([TERM]), rel).map((f) => `${f.severity}:${f.rule}`);
  assert.deepEqual(found('.env'), ['blocker:env-file']);
  assert.deepEqual(found('config/.env.production'), ['blocker:env-file']);
  assert.deepEqual(found('.env.example'), []);
  assert.deepEqual(found('keys/server.pem'), ['blocker:key-file']);
  assert.deepEqual(found('art/face.png'), ['blocker:media']);
  assert.deepEqual(found('examples/spark/idle.png'), []);
  assert.deepEqual(found('examples/spark/thinking.gif'), []);
  assert.deepEqual(found('examples/spark/happy.webp'), []);
  assert.deepEqual(found('x/personal-terms.local.json'), ['blocker:local-terms', 'warning:local-file']);
  assert.deepEqual(found(`docs/${TERM}.md`), ['blocker:personal-term']);
});

test('commit identities: personal emails are blockers, no-reply ones are not', () => {
  assert.equal(identityFindings(ctx(), 'author', 'Jane', PERSONAL_EMAIL)[0].rule, 'identity-email');
  assert.deepEqual(identityFindings(ctx(), 'author', 'jdoe-dev', NOREPLY), []);
  assert.deepEqual(identityFindings(ctx([], [PERSONAL_EMAIL]), 'author', 'Jane', PERSONAL_EMAIL), [], 'an allowed email');
  assert.equal(identityFindings(ctx(['Jane Doe']), 'committer', 'Jane Doe', NOREPLY)[0].rule, 'identity-name');
});

// ---------------------------------------------------------------- a real repo

const hasGit = spawnSync('git', ['--version']).status === 0;

/** A throwaway repo, isolated from the user's git config, committing as a no-reply identity. */
function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-scan-repo-'));
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-scan-aside-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(aside, { recursive: true, force: true });
  });
  const emptyConfig = path.join(aside, 'gitconfig');
  const terms = path.join(aside, 'terms.json');
  fs.writeFileSync(emptyConfig, '');
  fs.writeFileSync(terms, JSON.stringify({ terms: [TERM], allow: [] }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: NOREPLY,
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: NOREPLY,
  };
  const git = (args, extraEnv = {}) => {
    const run = spawnSync('git', args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const scan = (args, extraEnv = {}) => {
    const run = spawnSync(process.execPath, [SCAN, '--json', '--terms', terms, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return { code: run.status, out: run.stdout ? JSON.parse(run.stdout) : null, stderr: run.stderr };
  };
  git(['init', '-q', '-b', 'main']);
  return { dir, git, write, scan };
}

const has = (result, rule, extra = {}) =>
  result.out.findings.some((f) => f.rule === rule && Object.entries(extra).every(([k, v]) => f[k] === v));

test('history: a secret removed later is still found, with the commits that added and removed it', { skip: !hasGit }, (t) => {
  const repo = makeRepo(t);
  repo.write('config.js', `module.exports = { key: '${AWS_KEY}' };\n`);
  repo.git(['add', '.']);
  repo.git(['commit', '-q', '-m', 'add config']);
  const added = repo.git(['rev-parse', '--short=7', 'HEAD']);
  repo.write('config.js', 'module.exports = { key: process.env.KEY };\n');
  repo.git(['commit', '-q', '-am', 'read the key from the environment']);
  const removed = repo.git(['rev-parse', '--short=7', 'HEAD']);

  assert.equal(repo.scan(['--tree']).code, 0, 'the working tree is clean');
  const history = repo.scan(['--history']);
  assert.equal(history.code, 1);
  const found = history.out.findings.find((f) => f.rule === 'aws-key');
  assert.equal(found.path, 'config.js');
  assert.equal(found.line, 1);
  assert.deepEqual(found.commits, [removed, added]);
  assert.ok(!JSON.stringify(history.out).includes(AWS_KEY), 'a secret is never printed in full');
});

test('history: commit identities, messages and folder names are checked', { skip: !hasGit }, (t) => {
  const repo = makeRepo(t);
  repo.write(`${TERM}/notes.md`, 'hello\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-q', '-m', `notes\n\nAsk ${PERSONAL_EMAIL}`], { GIT_AUTHOR_EMAIL: PERSONAL_EMAIL });

  const history = repo.scan(['--history']);
  assert.equal(history.code, 1);
  assert.ok(has(history, 'identity-email', { what: 'author email', match: PERSONAL_EMAIL }));
  assert.ok(!has(history, 'identity-email', { what: 'committer email' }), 'the committer used a no-reply address');
  assert.ok(has(history, 'email', { path: '(commit message)' }));
  assert.ok(has(history, 'personal-term', { path: TERM }), 'reported once, at the folder');
  assert.equal(history.out.findings.filter((f) => f.rule === 'personal-term').length, 1);
  assert.match(history.out.notes.join('\n'), /timezone offset/);
});

test('staged: a clean commit passes; personal data, identity and risky code are caught', { skip: !hasGit }, (t) => {
  const repo = makeRepo(t);
  repo.write('README.md', 'Install with npm.\n');
  repo.git(['add', '.']);
  const clean = repo.scan(['--staged', '--message', 'docs: install']);
  assert.equal(clean.code, 0, JSON.stringify(clean.out));

  assert.ok(has(repo.scan(['--staged'], { GIT_AUTHOR_EMAIL: PERSONAL_EMAIL }), 'identity-email', { what: 'author email' }));
  const message = repo.scan(['--staged', '--message', `thanks ${PERSONAL_EMAIL}`]);
  assert.equal(message.code, 1);
  assert.ok(has(message, 'email', { path: '(commit message)' }));

  repo.write('notes.md', `Ported from ${TERM}, see ${HOME_PATH}\n`);
  repo.git(['add', 'notes.md']);
  const notes = repo.scan(['--staged']);
  assert.equal(notes.code, 1);
  assert.ok(has(notes, 'personal-term', { path: 'notes.md', line: 1 }));
  assert.ok(has(notes, 'home-path', { path: 'notes.md', line: 1 }));
  repo.git(['rm', '-q', '--cached', 'notes.md']);

  repo.write('page.js', `const a = 1;\nel.${'inner'}HTML = text;\n`);
  repo.git(['add', 'page.js']);
  const risky = repo.scan(['--staged']);
  assert.equal(risky.code, 0, 'risky code is a warning to review, not a blocker');
  assert.ok(has(risky, 'html-sink', { severity: 'warning', path: 'page.js', line: 2 }));
});

test('the personal terms list itself can never be committed', { skip: !hasGit }, (t) => {
  const repo = makeRepo(t);
  repo.write('personal-terms.local.json', JSON.stringify({ terms: [TERM] }));
  repo.git(['add', '.']);
  const result = repo.scan(['--staged', '--terms', path.join(repo.dir, 'personal-terms.local.json')]);
  assert.equal(result.code, 1);
  for (const rule of ['terms-tracked', 'local-terms', 'personal-term']) assert.ok(has(result, rule), rule);
});

test('outside a git repo the scan fails with exit code 2, never a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-scan-nogit-'));
  try {
    const run = spawnSync(process.execPath, [SCAN, '--tree'], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) }, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not inside a git repo/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
