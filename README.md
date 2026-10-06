# Agent Face skills

Give a coding agent a face: a small, transparent, always-on-top window on your desktop that shows what the agent is doing — working, thinking, happy, stuck — and can speak with a moving mouth.

These are [agent skills](https://github.com/vercel-labs/skills). The agent installs them, keeps its face templates in its own repo, and runs everything itself. There is no MCP server to configure and no network port.

```
your agent's repo                       your machine
┌───────────────────────────┐          ┌──────────────────────────────┐
│ .agent-face/              │  reads   │  face window (Electron)      │
│   robo/  robo-weekend/    │ ───────▶ │  transparent, always on top  │
│   (one folder per look)   │          └──────────────▲───────────────┘
│ .claude/skills/agent-face │  face.cjs state working │ local pipe
│   (installed skills)      │ ────────────────────────┘
└───────────────────────────┘
```

## Install

In the agent's project:

```bash
npx skills add ericphamhoangdev/agent-face-skills
```

Pick all three skills, and the agents you use. An agent installing them for itself can skip the prompts:

```bash
npx skills add ericphamhoangdev/agent-face-skills --skill '*' --agent claude-code --yes
```

If you reach the repo over SSH, the git address works the same way:

```bash
npx skills add git@github.com:ericphamhoangdev/agent-face-skills.git --skill '*' --agent claude-code --yes
```

Or install from a local clone, for example when you can't reach the repo from that machine:

```bash
npx skills add /path/to/agent-face-skills --skill '*' --agent claude-code --yes
```

`npx skills update` doesn't refresh a local install; run the same `add` command again after pulling the clone.

Then ask the agent to set up its face, or do it yourself:

```bash
node .claude/skills/agent-face/scripts/face.cjs setup   # one-time: downloads Electron (~100 MB) into ~/.agent-face
node .claude/skills/agent-face/scripts/face.cjs init    # a starter template in ./.agent-face/starter
node .claude/skills/agent-face/scripts/face.cjs start
```

(The path depends on where the skills CLI installed them for your agent; `.claude/skills/` is Claude Code's.)

The agent updates its face at least twice a turn. To avoid a permission prompt each time, allow that one command in your agent's settings. In Claude Code, for example, add `Bash(node .claude/skills/agent-face/scripts/face.cjs:*)` to `permissions.allow`.

Requirements: Node.js 18 or newer. Built and tested on Windows 11. macOS and Linux should work, since the window is plain Electron, but they haven't been tested yet.

## Update

Updates are delivered only through the skills CLI:

```bash
npx skills update -y
```

The next face command notices the window is running the old version and restarts it on the new one. What changed, and anything you need to move, is in [CHANGELOG.md](CHANGELOG.md).

## The skills

| Skill | What the agent uses it for |
| --- | --- |
| [`agent-face`](skills/agent-face/SKILL.md) | The window and the `face.cjs` command. Setting the state and caption every turn, switching templates, showing its face in the chat, first-time setup. |
| [`agent-face-voice`](skills/agent-face-voice/SKILL.md) | Speaking a voice clip with lip-sync, and the manners around sound. |
| [`agent-face-template`](skills/agent-face-template/SKILL.md) | Creating and changing templates: states, animation, mouth frames, voice clips. |

`agent-face` is the one that carries the code; the other two are instructions that use it.

## What you can do with the window

- **Move it:** drag the face.
- **Resize it:** drag any edge or corner, or scroll over it. It keeps the image's shape.
- **Switch template, mute, volume, close:** right-click it. The speaker button (top left on hover) mutes; × closes.

It stays above other windows, including other always-on-top ones. A face you close stays closed until you ask the agent to show it again.

**Sound is yours to control.** Each face has its own mute and volume. Agents can see them but are told never to change them, so a muted face stays silent until you unmute it. Captions still show while it's muted.

## The face folder

An agent's face lives in `.agent-face/` in its repo. Each sub-folder is a **template**: one complete look with its own states, images and voice clips. The face uses one template at a time.

```
.agent-face/
├── robo/                the folder name is the template's id
│   ├── config.json      states, default state, lip-sync tuning
│   ├── idle.webp        one image per state: PNG, WebP, GIF, SVG or JPEG; animated WebP/APNG/GIF loop
│   ├── mouth/           optional open-mouth frames, for lip-sync
│   └── voice/           optional clips (MP3/WAV) and index.json
└── robo-weekend/        another template
```

Edit a file and the window redraws within a second. The format is described in [template-format.md](skills/agent-face-template/references/template-format.md).

### Making the art

What has worked for a full talking, blinking face:

- **Edit, don't re-prompt.** Generate the first states together (for example four expressions in one 2×2 grid, with the character described in full), then make every later picture as an edit of an existing one: "keep everything identical, change one thing only". Separate generations drift, and a face that changes between states looks broken.
- **An image model that edits a reference and returns real transparency.** The Codex CLI signed in with ChatGPT does both from the command line (`codex exec -i <reference.png> …`). Ask for a "fully transparent background" every time.
- **One 1024 master per state, everything else made from it.** Crop to the figure, keep one figure height across states, bottom-align. The face shows 512 px copies.
- **Mouth frames:** edit the master to an open mouth, then copy *only the mouth* back onto the original through a soft mask, because the model redraws the whole picture slightly. Then resize the still and the open mouth identically, and `check` confirms they line up.
- **Animated states** can be made from one still with Pillow: about 25 frames of gentle breathing, tilt or bounce, with a blink pasted from one eyes-closed edit, saved as animated WebP.

The step-by-step guide, with commands and settings, is [making-art.md](skills/agent-face-template/references/making-art.md).

Because templates live in the agent's repo, **their art and voice are published wherever that repo is.** Keep the folder out of commits if that's not what you want.

## Commands

`node <skills>/agent-face/scripts/face.cjs <command>` — all output is JSON.

| Command | |
| --- | --- |
| `setup` | Install the window runtime (once). |
| `init [--template <id>] [--name "…"]` | Create a starter template in `./.agent-face/<id>` (`starter` by default). |
| `templates` | List the templates and which one is in use. |
| `use <template>` | Switch the face to another template. |
| `states [--template <id>]`, `clips [--template <id>]` | List the states, or the voice clips, of a template (the one in use by default). |
| `state <name>`, `random` | Switch to a state, or to a random other one. `--caption "…"` adds a line under the face. |
| `caption ["text"]` | Set or clear the caption. |
| `say <clip> [--state <name>] [--caption "…"]` | Speak a voice clip. |
| `current [--png <file.png>]` | The face right now (template, state, caption) and a PNG of it, for the agent to show in the chat. |
| `sound-test` | Play a short chirp and report which speakers it went to. |
| `start` / `stop` | Show the face / close it until `start`. |
| `status` | Running? template, state, mute and volume, versions. |
| `check [--template <id>]` | Validate every template, or one. |
| `snapshot <file.png>` | Save a picture of the whole window. |

## What's stored where

| Where | What |
| --- | --- |
| `.agent-face/` in the agent's repo | The templates: images, mouth frames, clips, `config.json`. |
| `.agent-face/` in your home folder | Per-user data: window position, which template is in use, mute and volume per face, the Electron runtime, logs. |

Nothing is sent anywhere. The only network access is the one-time Electron download from npm during `setup`. The window loads files only from its own skill folder and the template in use.

## Limits

- Each face is its own Electron process group, about 300 MB of memory.
- Lip-sync follows loudness, not speech sounds: the mouth opens and closes with the voice but doesn't form shapes.
- No fixed "control panel": everything is the right-click menu, the commands above, and the files.

How it's built and why: [docs/design.md](docs/design.md). Coming from the Agent Face MCP app: [docs/migrating-from-mcp.md](docs/migrating-from-mcp.md).

## Working on this repo

```bash
npm test        # unit tests, plus the repo guard
npm run e2e     # drives a real window end to end (installs Electron into a temp folder first)
```

This repo is public and must stay free of personal data and of media: no images, no audio. Starter art and test sounds are generated by code. `npm test` fails if an image or audio file, a home-folder path or an email address shows up anywhere in the tree.

Before every commit, the `repo-safety-scan` skill in `.claude/skills/` checks the staged files and commit message for secrets and personal details, and `--history` checks every commit before a push that rewrites history or a change of visibility. Contributor emails are allowed in Git author, committer and tagger identity fields, but emails in files and messages are still blocked. A rule in `.claude/rules/` has Claude Code run it; anyone can run it directly:

```bash
node .claude/skills/repo-safety-scan/scripts/scan.cjs --staged
node .claude/skills/repo-safety-scan/scripts/scan.cjs --history
```

Every pull request to `main` also runs the required `PR safety / Secrets and personal data` check. It runs the test suite, scans the proposed merged tree, and scans every commit introduced by the PR so a secret that was added and removed in a later commit is still rejected. CI uses strict mode, so warnings need to be removed or explicitly justified with `safety-scan: allow`. Configure that check as required in the `main` branch ruleset; the workflow alone reports failure but a required-check rule is what prevents merging.

## License

[MIT](LICENSE)
