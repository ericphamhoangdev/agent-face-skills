#!/usr/bin/env node
'use strict';
// repo-safety-scan: finds what must not be published from a repo: secrets,
// personal details, and files that don't belong in it.
//
//   node scan.cjs --staged [--message "…" | --message-file <file>]
//       the next commit: the staged files, the author and committer it would
//       carry, its message, and risky patterns in newly added code
//   node scan.cjs --tree
//       every file git would commit from the working tree
//   node scan.cjs --history [--all-refs]
//       every commit on branches, tags and remotes (--all-refs: every ref,
//       stash included): file contents, file names, authors, committers,
//       taggers and messages
//
// Other options: --json, --terms <file>, --repo <dir>.
// Exit code: 0 no blockers (there may be warnings), 1 blockers found,
// 2 the scan could not run.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TERMS = path.resolve(__dirname, '..', 'personal-terms.local.json');
/** On a line, with a reason, this accepts whatever the scan finds on that line. */
const ALLOW_MARKER = 'safety-scan: allow';
/** Blobs are read from git this many at a time. */
const BATCH = 400;
/** Text larger than this is reported rather than scanned line by line. */
const MAX_TEXT = 8 * 1024 * 1024;

// ------------------------------------------------------------------ rules

/** Credentials with a recognisable shape. Always blockers. */
const SECRETS = [
  ['private-key', 'a private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws-key', 'an AWS access key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
  ['github-token', 'a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['anthropic-key', 'an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', 'an OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]*|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}/g],
  ['slack-token', 'a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['webhook', 'a chat webhook URL', /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}|discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g],
  ['google-key', 'a Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['google-oauth', 'a Google OAuth token', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['stripe-key', 'a Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ['hf-token', 'a Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['gitlab-token', 'a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['npm-token', 'an npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['sendgrid-key', 'a SendGrid key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g],
  ['jwt', 'a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['azure-key', 'an Azure storage key', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g],
  ['npm-auth', 'an npm auth token', /_auth(?:Token)?\s*=\s*(?!\$\{)\S{8,}/g],
];

/** A password inside a URL: `scheme://user:password@host`. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@'"`<>]+):([^\s/@'"`<>]+)@/gi;
/** A quoted value assigned to a secret-sounding name. */
const SECRET_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi;
/** Long runs of token characters; reported only when they look random. */
const TOKEN_LIKE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** Values that stand in for a secret rather than being one. */
const PLACEHOLDER_VALUE =
  /^(?:<.*>|\$\{.*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|x{3,}|\*{3,}|\.{3,}|password|passwd|pass|pwd|secret|token|.*(?:example|placeholder|changeme|change-me|your[-_]|dummy|sample|redacted|fake|test).*)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
/** Addresses that are never a person's: documentation domains and no-reply senders. */
const SAFE_EMAIL =
  /@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$|@users\.noreply\.github\.com$|^noreply@(?:github|anthropic)\.com$|\.(?:test|example|invalid|localhost)$/i;
const WINDOWS_HOME = /(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)([^\\/\s"'`<>:*?|]+)/gi;
const UNIX_HOME = /(?<![\w.~])\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
/** Folder names that are examples or shared, not someone's account. */
const PLACEHOLDER_USER =
  /^(?:<.*|example|you|me|name|user|username|your-?name|public|default|runner|%username%|\$env:username|\$\{?user(?:name)?\}?)$/i;
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/(?!\/))[^\s"'`<>|]*/g;
/** Drive paths that say nothing about a person (home folders are their own rule). */
const SYSTEM_PATH = /^[A-Za-z]:(?:\\{1,2}|\/)+(?:Users|Windows|Program|ProgramData)\b/i;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
/** Loopback, private, link-local and documentation ranges. */
const NON_PUBLIC_IP = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.)/;

/** Media and other binaries this repo never ships. */
const MEDIA = new Set([
  '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tiff', '.heic',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus',
  '.mp4', '.webm', '.mov', '.mkv', '.avi',
]);

/** Files that hold secrets or personal data by their nature: [rule, what, pattern, severity]. */
const SENSITIVE_FILES = [
  ['env-file', 'an environment file', /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$)[^/]+)?$/i, 'blocker'],
  ['key-file', 'a key or certificate file', /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|ovpn|gpg)$/i, 'blocker'],
  ['ssh-key', 'an SSH private key', /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i, 'blocker'],
  ['credentials-file', 'a credentials file', /(?:^|\/)(?:\.netrc|_netrc|\.git-credentials|\.pypirc|\.htpasswd|credentials(?:\.[^/]*)?|[^/]*service[-_]?account[^/]*\.json|secrets?\.(?:json|ya?ml|toml|env|txt))$/i, 'blocker'],
  ['local-terms', 'the personal terms list', /(?:^|\/)personal-terms\.local\.json$/i, 'blocker'],
  ['local-file', 'a file named as local-only', /(?:^|\/)[^/]+\.local(?:\.[^/]+)?$/i, 'warning'],
  ['npmrc', 'an .npmrc (it can hold a registry token)', /(?:^|\/)\.npmrc$/i, 'warning'],
  ['ssh-public-key', 'an SSH public key (it names a user and machine)', /(?:^|\/)id_[a-z0-9]+\.pub$/i, 'warning'],
  ['database', 'a database file', /\.(?:sqlite3?|db|mdb|accdb)$/i, 'warning'],
  ['archive', "an archive (its contents aren't scanned)", /\.(?:zip|7z|rar|tar|tgz|gz|bz2|xz)$/i, 'warning'],
];

/** Files whose newly added lines are checked for risky code. */
const CODE = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.sh', '.ps1', '.cmd', '.bat']);
/** Patterns in new code that weaken this repo's security model (see references/security-checklist.md). */
const RISKY_CODE = [
  ['electron-node', 'Node.js turned on in a web page', /nodeIntegration(?:InWorker|InSubFrames)?\s*:\s*true/g],
  ['electron-isolation', 'context isolation turned off', /contextIsolation\s*:\s*false/g],
  ['electron-sandbox', 'the renderer sandbox turned off', /sandbox\s*:\s*false/g],
  ['electron-websecurity', 'web security turned off', /webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true/g],
  ['electron-webview', 'a <webview> enabled', /webviewTag\s*:\s*true/g],
  ['html-sink', 'HTML built from a string', /\.(?:inner|outer)HTML\s*=(?!=)|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(/g],
  ['code-from-string', 'code built from a string', /\beval\s*\(|\bnew\s+Function\s*\(/g],
  ['shell', 'a command run through the shell', /\bshell\s*:\s*true|\bexecSync\s*\(|\bexec\s*\(\s*[`'"]/g],
  ['open-external', 'a URL opened in the system browser', /\bopenExternal\s*\(/g],
  ['csp', 'a weakened Content-Security-Policy', /'unsafe-(?:inline|eval|hashes)'/g],
  ['tls', 'TLS certificate checks turned off', /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORI[Z]ED/g],
  ['pipe-to-shell', 'a download piped into a shell', /\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba|z)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*iex\b/gi],
  ['network-port', 'a network port opened', /\.listen\s*\(\s*(?:\d|\{\s*port)/g],
];

// ------------------------------------------------------------------ git

class ScanError extends Error {}

function git(ctx, args, { input, buffer = false, allowFail = false } = {}) {
  const run = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: ctx.repo,
    input,
    maxBuffer: 1 << 30,
    encoding: buffer ? undefined : 'utf8', // unset: output comes back as a Buffer
    windowsHide: true,
  });
  if (run.error) throw new ScanError(`git could not run: ${run.error.message}`);
  if (run.status !== 0) {
    if (allowFail) return null;
    throw new ScanError(`git ${args[0]} failed: ${String(run.stderr).trim()}`);
  }
  return run.stdout;
}

/** Contents of `shas` as a Map of sha → Buffer, read in one `cat-file --batch`. */
function readBlobs(ctx, shas) {
  const contents = new Map();
  if (!shas.length) return contents;
  const out = git(ctx, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, buffer: true });
  for (let off = 0; off < out.length; ) {
    const newline = out.indexOf(10, off);
    const [sha, type, size] = out.toString('utf8', off, newline).split(' ');
    off = newline + 1;
    if (type === 'missing') continue;
    contents.set(sha, out.subarray(off, off + Number(size)));
    off += Number(size) + 1;
  }
  return contents;
}

// ------------------------------------------------------------------ matching

/** True when [start, end) of `line` lies inside one of the `allow` strings (case-insensitive). */
function allowed(line, start, end, allow) {
  const lower = line.toLowerCase();
  for (const entry of allow) {
    const needle = entry.toLowerCase();
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
      if (i <= start && end <= i + needle.length) return true;
    }
  }
  return false;
}

function entropy(text) {
  const counts = new Map();
  for (const c of text) counts.set(c, (counts.get(c) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

function* occurrences(line, needle) {
  const lower = line.toLowerCase();
  const term = needle.toLowerCase();
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + term.length)) {
    yield { index: i, text: line.slice(i, i + term.length) };
  }
}

/**
 * Everything wrong with one line of text. `names` limits it to what can
 * identify someone in a file name: personal terms and home folders.
 */
function scanLine(ctx, line, { names = false } = {}) {
  const found = [];
  const add = (severity, kind, rule, what, match, index) => {
    if (!allowed(line, index, index + match.length, ctx.terms.allow)) found.push({ severity, kind, rule, what, match });
  };

  for (const term of ctx.terms.terms) {
    for (const m of occurrences(line, term)) add('blocker', 'personal', 'personal-term', 'a personal term', m.text, m.index);
  }
  for (const m of line.matchAll(WINDOWS_HOME)) {
    if (!PLACEHOLDER_USER.test(m[1])) add('blocker', 'personal', 'home-path', 'a home-folder path', m[0], m.index);
  }
  for (const m of line.matchAll(UNIX_HOME)) {
    if (!PLACEHOLDER_USER.test(m[1])) add('blocker', 'personal', 'home-path', 'a home-folder path', m[0], m.index);
  }
  if (names) return found;

  for (const [rule, what, re] of SECRETS) {
    for (const m of line.matchAll(re)) add('blocker', 'secret', rule, what, m[0], m.index);
  }
  for (const m of line.matchAll(URL_PASSWORD)) {
    if (!PLACEHOLDER_VALUE.test(m[2])) add('blocker', 'secret', 'url-password', 'a password in a URL', m[0], m.index);
  }
  for (const m of line.matchAll(SECRET_ASSIGNMENT)) {
    if (!PLACEHOLDER_VALUE.test(m[1])) add('warning', 'secret', 'secret-assignment', 'a value given to a secret-sounding name', m[1], m.index + m[0].lastIndexOf(m[1]));
  }
  for (const m of line.matchAll(TOKEN_LIKE)) {
    const t = m[0];
    const random = !/^[0-9a-f]+$/i.test(t) && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && entropy(t) >= 4.3;
    if (random && !found.some((f) => f.kind === 'secret' && f.match.includes(t))) {
      add('warning', 'secret', 'random-token', 'a long random-looking string', t, m.index);
    }
  }
  for (const m of line.matchAll(EMAIL)) {
    const sshRemote = /^git@/i.test(m[0]) && line[m.index + m[0].length] === ':';
    if (!sshRemote && !SAFE_EMAIL.test(m[0])) add('blocker', 'personal', 'email', 'an email address', m[0], m.index);
  }
  for (const m of line.matchAll(DRIVE_PATH)) {
    if (!SYSTEM_PATH.test(m[0])) add('warning', 'personal', 'local-path', 'an absolute local path (make sure it is an invented example)', m[0], m.index);
  }
  for (const m of line.matchAll(IPV4)) {
    if (!NON_PUBLIC_IP.test(m[0])) add('warning', 'personal', 'ip-address', 'a public IP address', m[0], m.index);
  }
  return found;
}

/** Findings with 1-based line numbers. A line holding ALLOW_MARKER is skipped. */
function scanText(ctx, text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const f of scanLine(ctx, line)) found.push({ ...f, line: i + 1 });
  });
  return found;
}

/** What a file's type says on its own, and (unless `names` is false) what its name says. */
function fileFindings(ctx, rel, { names = true } = {}) {
  const found = [];
  for (const [rule, what, re, severity] of SENSITIVE_FILES) {
    if (re.test(rel)) found.push({ severity, kind: 'file', rule, what, match: rel });
  }
  if (MEDIA.has(path.extname(rel).toLowerCase())) {
    found.push({ severity: 'blocker', kind: 'file', rule: 'media', what: 'a media file (this repo ships none; they can also carry location or generator metadata)', match: rel });
  }
  if (names) {
    for (const f of scanLine(ctx, rel, { names: true })) found.push({ ...f, what: `${f.what} in a file name` });
  }
  return found;
}

/** Findings for one file: its type, its name (see fileFindings) and, for text, every line. */
function scanContent(ctx, rel, buf, { names = true } = {}) {
  const found = fileFindings(ctx, rel, { names }).map((f) => ({ ...f, path: rel }));
  if (MEDIA.has(path.extname(rel).toLowerCase())) return found;
  if (buf.length > MAX_TEXT) {
    found.push({ severity: 'warning', kind: 'file', rule: 'large-file', what: "a very large file (not scanned; check it doesn't belong in git-ignored storage)", match: rel, path: rel });
    return found;
  }
  if (buf.subarray(0, 8000).includes(0)) {
    found.push({ severity: 'warning', kind: 'file', rule: 'binary', what: "a binary file (its contents aren't scanned)", match: rel, path: rel });
    return found;
  }
  for (const f of scanText(ctx, buf.toString('utf8'))) found.push({ ...f, path: rel });
  return found;
}

/** Findings for the name and email a commit carries. */
function identityFindings(ctx, role, name, email) {
  const found = [];
  const who = `${name} <${email}>`;
  const at = who.lastIndexOf(email);
  if (email && !SAFE_EMAIL.test(email) && !allowed(who, at, at + email.length, ctx.terms.allow)) {
    found.push({ severity: 'blocker', kind: 'identity', rule: 'identity-email', what: `${role} email`, match: email });
  }
  for (const term of ctx.terms.terms) {
    for (const m of occurrences(name, term)) {
      if (!allowed(name, m.index, m.index + m.text.length, ctx.terms.allow)) {
        found.push({ severity: 'blocker', kind: 'identity', rule: 'identity-name', what: `${role} name contains a personal term`, match: m.text });
      }
    }
  }
  return found;
}

/** The personal terms file must never be committed. */
function termsFileFindings(ctx) {
  if (ctx.terms.missing) {
    return [{ severity: 'warning', kind: 'setup', rule: 'no-terms', what: 'no personal terms file, so only generic checks ran: copy personal-terms.example.json to personal-terms.local.json and fill it in', match: '' }];
  }
  // Real paths on both sides: on Windows one can be a short 8.3 name and the other not.
  const rel = path.relative(fs.realpathSync.native(ctx.repo), fs.realpathSync.native(ctx.terms.file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
  const posix = rel.split(path.sep).join('/');
  const found = [];
  if (git(ctx, ['ls-files', '--error-unmatch', '--', posix], { allowFail: true }) !== null) {
    found.push({ severity: 'blocker', kind: 'file', rule: 'terms-tracked', what: 'the personal terms list is tracked by git: run git rm --cached on it', match: posix });
  } else if (git(ctx, ['check-ignore', '-q', '--', posix], { allowFail: true }) === null) {
    found.push({ severity: 'blocker', kind: 'file', rule: 'terms-not-ignored', what: 'the personal terms list is not git-ignored', match: posix });
  }
  return found;
}

// ------------------------------------------------------------------ scopes

function scanStaged(ctx) {
  const findings = termsFileFindings(ctx);
  const changed = new Set(git(ctx, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT']).split('\0').filter(Boolean));
  const entries = git(ctx, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, sha] = entry.slice(0, tab).split(' ');
      return { mode, sha, path: entry.slice(tab + 1) };
    })
    .filter((e) => changed.has(e.path) && e.mode !== '160000'); // not submodules

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const contents = readBlobs(ctx, batch.map((e) => e.sha));
    for (const e of batch) findings.push(...scanContent(ctx, e.path, contents.get(e.sha) || Buffer.alloc(0)));
  }

  for (const added of addedLines(ctx)) {
    if (!CODE.has(path.extname(added.path).toLowerCase()) || added.text.includes(ALLOW_MARKER)) continue;
    for (const [rule, what, re] of RISKY_CODE) {
      for (const m of added.text.matchAll(re)) {
        findings.push({ severity: 'warning', kind: 'security', rule, what: `${what}: review against the security checklist`, match: m[0], path: added.path, line: added.line });
      }
    }
  }

  for (const role of ['author', 'committer']) {
    const ident = git(ctx, ['var', `GIT_${role.toUpperCase()}_IDENT`], { allowFail: true });
    const m = ident && /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(ident.trim());
    if (m) findings.push(...identityFindings(ctx, role, m[1], m[2]));
    else findings.push({ severity: 'warning', kind: 'identity', rule: 'no-identity', what: `no ${role} identity is configured, so it couldn't be checked`, match: '' });
  }

  if (ctx.message !== null) {
    for (const f of scanText(ctx, ctx.message)) findings.push({ ...f, path: '(commit message)' });
  }
  return { findings, notes: [], counts: { files: entries.length } };
}

/** `{ path, line, text }` for every line the staged changes add. */
function addedLines(ctx) {
  const patch = git(ctx, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=ACMRT']);
  const lines = [];
  let file = null;
  let next = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
    } else if (!inHunk && raw.startsWith('+++ ')) {
      const name = raw.slice(4).replace(/^"(.*)"$/, '$1');
      file = name === '/dev/null' ? null : name.replace(/^b\//, '');
    } else if (raw.startsWith('@@')) {
      inHunk = true;
      next = Number((/\+(\d+)/.exec(raw) || [0, 0])[1]);
    } else if (inHunk && raw.startsWith('+') && file) {
      lines.push({ path: file, line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return lines;
}

function scanTree(ctx) {
  const findings = termsFileFindings(ctx);
  const files = [...new Set(git(ctx, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  let scanned = 0;
  for (const rel of files) {
    const full = path.join(ctx.repo, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile()) continue;
    scanned += 1;
    findings.push(...scanContent(ctx, rel, fs.readFileSync(full)));
  }
  return { findings, notes: [], counts: { files: scanned } };
}

function scanHistory(ctx) {
  const refs = ctx.allRefs ? ['--all'] : ['--branches', '--tags', '--remotes'];
  const findings = termsFileFindings(ctx);
  const notes = [];
  const listed = git(ctx, ['rev-list', '--objects', ...refs]);
  if (!listed.trim()) return { findings, notes: ['no commits yet'], counts: { commits: 0, blobs: 0 } };

  const typed = git(ctx, ['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)'], { input: listed });
  const blobs = [];
  const names = new Set();
  for (const line of typed.split('\n')) {
    if (!line) continue;
    const [type, sha, size, ...rest] = line.split(' ');
    const name = rest.join(' ');
    if (name) names.add(name);
    if (type === 'blob') blobs.push({ sha, size: Number(size), path: name });
  }

  // One finding per rule, file and match, however many versions of the file have it.
  const groups = new Map();
  const group = (f, extra) => {
    const key = [f.kind, f.rule, f.what, f.path || '', f.match.toLowerCase()].join('\0');
    if (!groups.has(key)) {
      // File findings list the commits that add, change or remove the file; others every commit they're in.
      const via = extra.commit ? 'in' : 'touched by';
      groups.set(key, { ...f, via, lines: new Set(), blobs: new Set(), commitSet: new Set(), paths: new Set() });
    }
    const g = groups.get(key);
    if (f.line) g.lines.add(f.line);
    if (extra.blob) g.blobs.add(extra.blob);
    if (extra.commit) g.commitSet.add(extra.commit);
    if (extra.name) g.paths.add(extra.name);
  };

  for (let i = 0; i < blobs.length; i += BATCH) {
    const batch = blobs.slice(i, i + BATCH);
    const contents = readBlobs(ctx, batch.map((b) => b.sha));
    for (const b of batch) {
      // Names are scanned once below, folders included.
      for (const f of scanContent(ctx, b.path, contents.get(b.sha) || Buffer.alloc(0), { names: false })) group(f, { blob: b.sha });
    }
  }
  // Folder and file names, wherever they appear (a whole folder can be named after something private).
  for (const name of names) {
    for (const f of scanLine(ctx, name, { names: true })) group({ ...f, what: `${f.what} in a file name` }, { name });
  }

  const log = git(ctx, ['log', ...refs, '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%ai%x1f%B%x1e']);
  const commits = log
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, an, ae, cn, ce, date, message] = record.split('\x1f');
      return { sha: sha.slice(0, 7), an, ae, cn, ce, date, message: message || '' };
    });
  const zones = new Set();
  for (const c of commits) {
    zones.add(c.date.slice(-5));
    for (const f of identityFindings(ctx, 'author', c.an, c.ae)) group(f, { commit: c.sha });
    for (const f of identityFindings(ctx, 'committer', c.cn, c.ce)) group(f, { commit: c.sha });
    for (const f of scanText(ctx, c.message)) group({ ...f, line: undefined, path: '(commit message)' }, { commit: c.sha });
  }

  const tags = git(ctx, ['for-each-ref', 'refs/tags', '--format=%(objecttype)%1f%(refname:short)%1f%(taggername)%1f%(taggeremail)%1f%(contents)%1e']);
  for (const record of tags.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean)) {
    const [type, tag, name, email, message] = record.split('\x1f');
    if (type !== 'tag') continue; // lightweight tags carry nothing of their own
    for (const f of identityFindings(ctx, 'tagger', name, email.replace(/^<|>$/g, ''))) group(f, { commit: `tag ${tag}` });
    for (const f of scanText(ctx, message || '')) group({ ...f, line: undefined, path: `(tag ${tag} message)` }, { commit: `tag ${tag}` });
  }

  // The commits behind each finding, newest first. For a file version, that's
  // the commits that add or remove it (git log --find-object).
  const holders = new Map();
  const commitsOf = (sha) => {
    if (!holders.has(sha)) holders.set(sha, git(ctx, ['log', ...refs, '--format=%h', `--find-object=${sha}`]).split('\n').filter(Boolean));
    return holders.get(sha);
  };
  for (const g of groups.values()) {
    const list = [...g.commitSet];
    for (const blob of g.blobs) list.push(...commitsOf(blob));
    for (const name of g.paths) list.push(...git(ctx, ['log', ...refs, '--format=%h', '--', name]).split('\n').filter(Boolean));
    const { lines, blobs: _b, commitSet: _c, paths, ...f } = g;
    findings.push({
      ...f,
      ...(lines.size ? { line: Math.min(...lines) } : {}),
      ...(paths.size ? { path: [...paths].sort((a, b) => a.length - b.length)[0], paths: paths.size } : {}),
      commits: [...new Set(list)],
    });
  }

  if (zones.size) {
    notes.push(`commit times carry the author's timezone offset (${[...zones].sort().join(', ')}), which hints at where they live`);
  }
  if (!ctx.allRefs) notes.push('stash, notes and other refs were not scanned (add --all-refs); unreachable objects never are');
  return { findings, notes, counts: { commits: commits.length, blobs: blobs.length } };
}

// ------------------------------------------------------------------ output

const redact = (text) => (text.length <= 8 ? '…' : `${text.slice(0, 4)}…(${text.length} chars)`);

/** A finding as it is printed or returned: secrets never appear in full. */
function publicFinding(f) {
  return { ...f, match: f.kind === 'secret' ? redact(f.match) : f.match };
}

function describe(f) {
  const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}${f.paths > 1 ? ` (+${f.paths - 1} more paths)` : ''}` : '';
  const shown = f.match && f.match !== f.path ? ` "${f.match}"` : '';
  let commits = '';
  if (f.commits && f.commits.length) {
    const list = f.commits.length > 4 ? `${f.commits.slice(0, 3).join(', ')} … ${f.commits[f.commits.length - 1]}` : f.commits.join(', ');
    commits = ` [${f.via || 'in'} ${f.commits.length} commit${f.commits.length === 1 ? '' : 's'}: ${list}]`;
  }
  return `${f.kind.padEnd(9)} ${where ? `${where} — ` : ''}${f.what}${shown}${commits}`;
}

function report(scope, result, json) {
  const findings = result.findings.map(publicFinding);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');
  if (json) {
    console.log(JSON.stringify({ scope, ok: blockers.length === 0, blockers: blockers.length, warnings: warnings.length, scanned: result.counts, findings: [...blockers, ...warnings], notes: result.notes }, null, 2));
  } else {
    const scanned = Object.entries(result.counts).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`repo-safety-scan --${scope}: ${scanned}`);
    for (const [title, list] of [['BLOCKERS', blockers], ['WARNINGS', warnings]]) {
      if (!list.length) continue;
      console.log(`\n${title} (${list.length})`);
      for (const f of list) console.log(`  ${describe(f)}`);
    }
    if (result.notes.length) {
      console.log('\nNOTES');
      for (const note of result.notes) console.log(`  ${note}`);
    }
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    console.log(`\n${blockers.length ? 'NOT SAFE' : 'OK'}: ${plural(blockers.length, 'blocker')}, ${plural(warnings.length, 'warning')}`);
  }
  return blockers.length ? 1 : 0;
}

// ------------------------------------------------------------------ main

const HELP = `Usage: node scan.cjs --staged | --tree | --history [options]

  --staged                 the next commit: staged files, author/committer, risky new code
    --message "<text>"     also check the commit message
    --message-file <file>  ...or read it from a file
  --tree                   every file git would commit from the working tree
  --history                every commit on branches, tags and remotes
    --all-refs             every ref instead (stash, notes, backups)
  --terms <file>           personal terms list (default: personal-terms.local.json next to scripts/)
  --repo <dir>             repo to scan (default: the one around the current folder)
  --json                   machine-readable output

Exit code: 0 no blockers, 1 blockers found, 2 the scan could not run.`;

function parseArgs(argv) {
  const opts = { scope: null, message: null, json: false, allRefs: false, terms: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new ScanError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--staged' || arg === '--tree' || arg === '--history') {
      if (opts.scope) throw new ScanError('pick one of --staged, --tree, --history');
      opts.scope = arg.slice(2);
    } else if (arg === '--message') opts.message = value();
    else if (arg === '--message-file') opts.message = fs.readFileSync(value(), 'utf8');
    else if (arg === '--terms') opts.terms = value();
    else if (arg === '--repo') opts.repo = value();
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all-refs') opts.allRefs = true;
    else if (arg === '--help' || arg === '-h') opts.scope = 'help';
    else throw new ScanError(`unknown option ${arg}`);
  }
  return opts;
}

function loadTerms(file, explicit) {
  if (!fs.existsSync(file)) {
    if (explicit) throw new ScanError(`no terms file at ${file}`);
    return { file, missing: true, terms: [], allow: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ScanError(`${file} is not valid JSON: ${e.message}`);
  }
  const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  return { file, missing: false, terms: list(parsed.terms), allow: list(parsed.allow) };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.scope || opts.scope === 'help') {
    console.log(HELP);
    return opts.scope ? 0 : 2;
  }
  const start = path.resolve(opts.repo || process.cwd());
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0) throw new ScanError(`not inside a git repo: ${start}`);
  const ctx = {
    repo: path.resolve(top.stdout.trim()),
    message: opts.message,
    allRefs: opts.allRefs,
    terms: loadTerms(path.resolve(opts.terms || DEFAULT_TERMS), Boolean(opts.terms)),
  };
  const scan = { staged: scanStaged, tree: scanTree, history: scanHistory }[opts.scope];
  return report(opts.scope, scan(ctx), opts.json);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`repo-safety-scan: ${e instanceof ScanError ? e.message : e.stack}`);
    process.exitCode = 2;
  }
}

module.exports = { scanLine, scanText, fileFindings, identityFindings, main };
