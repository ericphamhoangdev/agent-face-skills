---
name: repo-safety-scan
description: Scan this repo for secrets, security problems and personal details, in the staged changes, the working tree, or every commit in its history (file contents, file names, author and committer emails, messages), and fix what it finds. Use before every git commit, before pushing or making the repo public, when the user asks whether the repo is safe to share or publish, and whenever a secret or personal detail may have been committed.
metadata:
  internal: true
---

# Repo safety scan

No secret, and nothing that identifies the user, may reach a commit in this repo. This skill finds them and says how to get rid of them. `scripts/scan.cjs` does the pattern matching; reviewing code changes for security is your job, with the checklist below.

## Scopes

```bash
node .claude/skills/repo-safety-scan/scripts/scan.cjs --staged --message "<commit message>"   # before a commit
node .claude/skills/repo-safety-scan/scripts/scan.cjs --tree                                   # the working tree, as git would commit it
node .claude/skills/repo-safety-scan/scripts/scan.cjs --history                                # every commit on branches, tags and remotes
```

- `--staged` checks the staged files, the author and committer email the commit would carry, the message (`--message` or `--message-file`), and risky patterns in newly added code.
- `--history` checks every version of every file, every file and folder name, every author, committer and tagger, and every commit and tag message. `--all-refs` adds stash, notes and backup refs.
- `--json` gives machine-readable output. Exit code 0 means no blockers, 1 means blockers, 2 means the scan couldn't run: say so, and never treat it as a pass.

| Severity | What |
| --- | --- |
| Blocker | Credentials with a known shape: private keys; AWS, GitHub, Anthropic, OpenAI, Google, Slack, Stripe, npm, Hugging Face and GitLab keys and tokens; JWTs; passwords in URLs. Email addresses (except `example.com` and no-reply ones) in files, messages or commit identities. Home-folder paths. Anything on the personal terms list. Key, certificate, `.env` and credentials files. Media files outside the explicitly reviewed Spark example. |
| Warning | Values given to secret-sounding names, long random-looking strings, other absolute local paths, public IP addresses, binary and archive files. In `--staged`, new code that weakens the security model: shell commands, `innerHTML`, `eval`, Electron isolation turned off, a weakened CSP, an open port, and so on. |

Secrets are never printed in full.

## The personal terms list

Generic patterns can't know the user's name, machine or private projects. Those go in `personal-terms.local.json` next to this file, which is git-ignored:

```json
{ "terms": ["Jane Example", "JANE-LAPTOP", "my-private-project"], "allow": ["jane-example-dev"] }
```

- Terms match anywhere, ignoring case.
- `allow` lists text that may appear although it contains a term, such as the user's public handle in the repo's own URL. It also takes an email address the user has decided is public.
- If the file is missing, the scan says so and runs the generic checks only. Copy `personal-terms.example.json` and ask the user what belongs in it.
- When you notice something personal the list doesn't cover (a new project, another machine or account), suggest adding it.
- The scan blocks if the list itself is tracked by git or not ignored.

## Before every commit

1. Stage exactly what the commit should hold, then run `--staged` with the message you're going to use.
2. If the staged changes touch code (`git diff --cached --stat`), read the diff against [references/security-checklist.md](references/security-checklist.md). The patterns only point at suspects; the checklist is the review.
3. Run `npm test`. It includes the repo guard: only approved example media, no home paths, no emails, well-formed skills.
4. Commit only with 0 blockers. Look at every warning, and fix it or, if it's a genuine false positive, mark it (see below). Never commit something "for now" to fix later: once it's pushed, it's in the history.

If a blocker can't be fixed without the user (their identity, or a value only they know is public), stop. Tell them what is where (file, line, commit) and wait.

## Before pushing a rewrite or making the repo public

Run `--history` and `--tree`. Every blocker in the history must be gone before the repo goes public: the whole history is published with it, not just the latest files. Tell the user what you checked and what you couldn't (see Limits).

## Fixing

**In the working tree or the staged changes**

- Replace real values with invented ones: `my-app`, `C:/code/my-app`, `Acme Ltd`, `you@example.com`, `<token>`. Never use the user's own projects, paths or data as examples. <!-- safety-scan: allow (invented examples) -->
- Values the code needs at run time come from an environment variable or a git-ignored local file. Commit an `.example` copy with placeholders.
- A file that shouldn't be committed at all: `git restore --staged <file>`, then add it to `.gitignore`.
- Media: only the reviewed files in `examples/spark/` are allowed. Generate what tests need in code, as `skills/agent-face/lib/starter.cjs` does.

**The commit identity.** If the author or committer email is personal, every commit publishes it. Ask the user before changing anything. The usual fix is GitHub's no-reply address in this repo's config:

```bash
gh api users/<github-user> --jq .id      # the account's numeric id
git config user.email "<id>+<github-user>@users.noreply.github.com"
```

**Already in the history.** Stop and tell the user what is where: the rule, `file:line`, and the commits the scan lists. Then:

1. **For a secret, revoke or rotate it first.** Rewriting history doesn't un-leak a credential that was ever pushed.
2. Propose the rewrite, and do it only after the user says yes. Make a backup first: `git bundle create ../<repo>-backup.bundle --all`.
3. Rewrite with `git filter-repo`. Outside a fresh clone it needs `--force`, and it removes the `origin` remote afterwards, so note the URL and add it back.

   | To fix | Command |
   | --- | --- |
   | An email or name in commit identities | a mailmap file with `New Name <new@email> <old@email>`, then `git filter-repo --mailmap <file>` |
   | Text inside files | a file with one `literal text==>replacement` per line, then `git filter-repo --replace-text <file>` |
   | Text in commit messages | the same kind of file, with `--replace-message <file>` |
   | A whole file | `git filter-repo --invert-paths --path <file>` |

4. Run `--history` again until it's clean, then `npm test`.
5. **Pushing needs its own yes**, because it overwrites the remote: `git push --force-with-lease origin <branch>` for each rewritten branch, and the tags. Tell the user that anyone who already cloned or forked keeps the old history, that the host can keep old commits reachable by hash for a while, and that if the repo was ever public, GitHub support can purge cached views.

**False positives.** Put `safety-scan: allow` with a reason on the line, in a comment. For text specific to the user, add it to `allow` in the terms list instead. Never weaken the patterns in `scan.cjs` to make a finding go away.

## Limits

- Patterns find shapes, not meaning. A secret in an unusual format, a person's name, or a private detail written in prose gets through unless it's on the terms list. Read what you commit.
- Binary files, archives and files over 8 MB aren't read.
- Only this clone is scanned. Branches on other machines, forks, and objects that are no longer reachable aren't.
