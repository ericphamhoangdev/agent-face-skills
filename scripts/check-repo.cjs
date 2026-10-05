#!/usr/bin/env node
'use strict';
// Guard for a public repo. Fails when:
//   - an image, audio or video file is present (faces and clips belong in
//     each agent's own repo; starter art and test audio are made by code);
//   - a file contains something that looks personal (a home-folder path or
//     an email address);
//   - a skill is malformed or the version numbers disagree.
// It checks every file git would commit (tracked, or untracked and not
// ignored), so git-ignored local files such as the safety scan's personal
// terms are never read. The deeper scan, history included, is the
// repo-safety-scan skill in .claude/skills/.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_ANYWHERE = new Set(['.git', 'node_modules']);
/** Git-ignored folders left at the top level by trying the skills here (used without git). */
const SKIP_AT_ROOT = new Set(['.agents', '.claude', '.agent-face']);
const MEDIA = new Set([
  '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tiff',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus',
  '.mp4', '.webm', '.mov', '.mkv',
]);
const PERSONAL = [
  [/[A-Za-z]:[\\/]+Users[\\/]+(?!example\b|you\b|me\b|name\b|<)[^\\/\s"'`]+/, 'a Windows home-folder path'],
  [/(?<![\w.])\/(?:Users|home)\/(?!example\b|you\b|me\b|name\b|<)[A-Za-z0-9._-]+\//, 'a home-folder path'],
  [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/, 'an email address'],
];
/** SSH remotes such as `git@host:owner/repo.git` are addresses of repos, not of people. */
const SSH_REMOTE = /\bgit@[A-Za-z0-9.-]+:/g;

/** Absolute paths of the files git would commit, or null outside a git checkout. */
function committable() {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) return null;
  return run.stdout
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.join(ROOT, rel))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile()); // not deleted, not a submodule
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skip = SKIP_ANYWHERE.has(entry.name) || (dir === ROOT && SKIP_AT_ROOT.has(entry.name));
      if (!skip) yield* walk(path.join(dir, entry.name));
    } else {
      yield path.join(dir, entry.name);
    }
  }
}

/** `{ name, description, version }` from a SKILL.md's frontmatter. */
function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  if (!block) return null;
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(block[1]);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  const version = /^\s+version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(block[1]);
  return { name: field('name'), description: field('description'), version: version ? version[1] : null };
}

function checkRepo() {
  const problems = [];
  const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

  for (const file of committable() || walk(ROOT)) {
    if (MEDIA.has(path.extname(file).toLowerCase())) {
      problems.push(`${rel(file)}: media files don't belong in this repo`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\u0000')) {
      problems.push(`${rel(file)}: binary files don't belong in this repo`);
      continue;
    }
    text.split('\n').forEach((raw, i) => {
      const line = raw.replace(SSH_REMOTE, '');
      for (const [pattern, what] of PERSONAL) {
        if (pattern.test(line)) problems.push(`${rel(file)}:${i + 1}: looks like ${what}`);
      }
    });
  }

  const version = fs.readFileSync(path.join(ROOT, 'skills', 'agent-face', 'VERSION'), 'utf8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== version) problems.push(`package.json version ${pkg.version} != skills/agent-face/VERSION ${version}`);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) {
    problems.push(`CHANGELOG.md has no "## ${version}" entry`);
  }

  const skillsDir = path.join(ROOT, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      problems.push(`skills/${name}: no SKILL.md`);
      continue;
    }
    const meta = frontmatter(fs.readFileSync(file, 'utf8'));
    if (!meta) problems.push(`skills/${name}/SKILL.md: no frontmatter`);
    else {
      if (meta.name !== name) problems.push(`skills/${name}/SKILL.md: name "${meta.name}" must match its folder`);
      if (!meta.description) problems.push(`skills/${name}/SKILL.md: no description`);
      else if (meta.description.length > 1024) problems.push(`skills/${name}/SKILL.md: description is over 1024 characters`);
      if (meta.version !== version) problems.push(`skills/${name}/SKILL.md: metadata.version ${meta.version} != ${version}`);
    }
  }
  return problems;
}

module.exports = { checkRepo, frontmatter };

if (require.main === module) {
  const problems = checkRepo();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('repo check passed');
}
