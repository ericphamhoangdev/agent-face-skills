# Agent Face skills

Give a coding agent a face: a small, transparent, always-on-top window on your desktop that shows what the agent is doing — working, thinking, happy, stuck — and can speak with a moving mouth.

These are [agent skills](https://github.com/vercel-labs/skills). The agent installs them, keeps its face in its own repo, and runs everything itself. There is no MCP server to configure and no network port.

```
your agent's repo                       your machine
┌───────────────────────────┐          ┌──────────────────────────────┐
│ agent-face/               │  reads   │  face window (Electron)      │
│   config.json, images,    │ ───────▶ │  transparent, always on top  │
│   mouth frames, voice/    │          └──────────────▲───────────────┘
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

Then ask the agent to set up its face, or do it yourself:

```bash
node .claude/skills/agent-face/scripts/face.cjs setup   # one-time: downloads Electron (~100 MB) into ~/.agent-face
node .claude/skills/agent-face/scripts/face.cjs init    # a starter face in ./agent-face
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

The next face command notices the window is running the old version and restarts it on the new one. What changed is in [CHANGELOG.md](CHANGELOG.md).

## The skills

| Skill | What the agent uses it for |
| --- | --- |
| [`agent-face`](skills/agent-face/SKILL.md) | The window and the `face.cjs` command. Setting the state and caption every turn, showing and hiding the face, first-time setup. |
| [`agent-face-voice`](skills/agent-face-voice/SKILL.md) | Speaking a voice clip with lip-sync, and the manners around sound. |
| [`agent-face-template`](skills/agent-face-template/SKILL.md) | Creating and changing the face: states, animation, mouth frames, voice clips. |

`agent-face` is the one that carries the code; the other two are instructions that use it.

## What you can do with the window

- **Move it:** drag the face.
- **Resize it:** scroll over it.
- **Mute, volume, close:** right-click it. The speaker button (top left on hover) mutes; × closes.

A face you close stays closed until you ask the agent to show it again.

**Sound is yours to control.** Each face has its own mute and volume. Agents can see them but are told never to change them, so a muted face stays silent until you unmute it. Captions still show while it's muted.

## The face folder

A face is a folder of ordinary files in the agent's repo:

```
agent-face/
├── config.json      states, default state, lip-sync tuning
├── idle.webp        one image per state: PNG, WebP, GIF, SVG or JPEG; animated WebP/APNG/GIF loop
├── mouth/           optional open-mouth frames, for lip-sync
└── voice/           optional clips (MP3/WAV) and index.json
```

Edit a file and the window redraws within a second. The format is described in [template-format.md](skills/agent-face-template/references/template-format.md).

Because the face lives in the agent's repo, **its art and voice are published wherever that repo is.** Keep the folder out of commits if that's not what you want.

## Commands

`node <skills>/agent-face/scripts/face.cjs <command>` — all output is JSON.

| Command | |
| --- | --- |
| `setup` | Install the window runtime (once). |
| `init [--name "…"]` | Create a starter face in `./agent-face`. |
| `start` / `stop` | Show the face / close it until `start`. |
| `status` | Running? state, mute and volume, versions. |
| `states`, `state <name>`, `random` | List states; switch to one; switch to a random other one. `--caption "…"` adds a line under the face. |
| `caption ["text"]` | Set or clear the caption. |
| `clips`, `say <clip> [--state <name>] [--caption "…"]` | List voice clips; speak one. |
| `check` | Validate the face folder. |
| `snapshot <file.png>` | Save a picture of the window. |

## What's stored where

| Where | What |
| --- | --- |
| `agent-face/` in the agent's repo | The face: images, mouth frames, clips, `config.json`. |
| `~/.agent-face/` | Per-user data: window position, mute and volume per face, the Electron runtime, logs. |

Nothing is sent anywhere. The only network access is the one-time Electron download from npm during `setup`. The window loads files only from its own skill folder and the face folder.

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

## License

[MIT](LICENSE)
