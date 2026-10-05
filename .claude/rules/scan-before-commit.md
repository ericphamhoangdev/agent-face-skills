# Scan before every commit

Before every `git commit` in this repo, run the `repo-safety-scan` skill on what is staged. That includes amends, merge commits, and commits a skill or script makes.

```bash
node .claude/skills/repo-safety-scan/scripts/scan.cjs --staged --message "<the commit message>"
```

- Commit only when it reports 0 blockers. If it reports any, stop, tell the user what is where, and fix it the way the skill says. Never commit it "for now".
- Look at every warning. Fix it, or mark a genuine false positive the way the skill describes.
- When the staged changes touch code, also review them against the skill's security checklist.
- Exit code 2 means the scan didn't run. That is not a pass: fix the cause and run it again.
- Before making the repo public, and before any push that rewrites history, also run it with `--history`.
