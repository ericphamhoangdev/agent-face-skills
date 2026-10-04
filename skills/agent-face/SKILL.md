---
name: agent-face
description: Give yourself a floating face on the user's desktop and keep it in step with what you are doing, with no MCP server. Use at the start and end of every turn to set the face's state (working, thinking, happy…) and an optional caption; whenever the user mentions your face, avatar or expression, or asks you to show, hide, move or fix it; and for first-time setup. The face's images live in your own repo (agent-face/); this skill ships the window and the face.cjs command that drives it.
metadata:
  version: "0.1.0"
---

# Agent Face

Your face is a small always-on-top window on the user's desktop. They glance at it to see what you're doing without reading the transcript. It only helps if it's current, so keeping it current is the whole job.

## The command

Everything goes through one script in this skill's folder:

```bash
node "<this skill's folder>/scripts/face.cjs" <command>
```

Run it from your repo. It finds the face in `agent-face/` in the current folder or a parent (or pass `--face <dir>`). Output is JSON; exit code 1 means the command failed and `error` (often with a `hint`) says why.

| Command | What it does |
| --- | --- |
| `random [--caption "…"]` | Switch to a random state other than the current one. |
| `state <name> [--caption "…"]` | Switch to a specific state. |
| `states` | List the states this face has. |
| `caption ["text"]` | Show a short line under the face. No text clears it. |
| `status` | Is it running, current state, mute and volume, versions. |
| `start` / `stop` | Show the face / close it until `start`. |
| `snapshot <file.png>` | Save a picture of the window as the user sees it. |
| `setup`, `init`, `check` | First-time setup (below) and checking the face folder. |

## Every turn

1. **When a prompt arrives**, before or alongside your first action, update the face: `random`, or `state <name>` when one clearly fits what you're about to do.
2. **Before you hand back to the user**, update it again to reflect how things ended. Don't leave it on a "busy" state such as `working`: the user reads that as "still going".

That's two updates per turn, including short chat-only turns.

- **Prefer `random`.** A face that changes feels alive; a face stuck on one expression gets ignored. Use `state` when the moment calls for it: `working` during a long tool run, a sad state when something failed, a happy one when tests pass. Run `states` once per session to learn what this face has.
- **Captions are optional.** Use one when it tells the user something the face can't, such as "running the test suite". Keep it to a few words (60 characters at most). A caption is cleared by the next state change.
- **Don't talk about the face in your replies.** It's a side channel. Mentioning it ("I've set my face to happy") is noise.

Face commands are fast, so run them alongside your other tool calls rather than as separate steps.

## When the face is closed

If a command returns `"face": "closed"`, the user closed the window on purpose (its × button, or they asked you to hide it). Leave it closed. Your state updates are still remembered and cost nothing. Run `start` only when the user asks to see the face again.

`stop` is how you hide it when the user asks.

## First-time setup

1. Run `status`.
2. If `runtime.installed` is `false`: the window runs on Electron, which `setup` downloads once (about 100 MB, into `~/.agent-face/`). Tell the user that, then run `setup`. It takes about a minute.
3. If `face_error` says no face was found: `init` creates a simple starter face in `agent-face/`, good enough to see everything working. To make a real one, use the `agent-face-template` skill.
4. Run `start`. The window appears near the middle of the screen; the user can drag it anywhere, scroll over it to resize, and right-click for a menu.

## Where things live

- **`agent-face/` in your repo** holds the face: `config.json`, the state images, mouth frames, voice clips. It's yours to edit (see `agent-face-template`). To see what a state looks like, read its image file directly.
- **`~/.agent-face/` on the user's machine** holds what belongs to the user: where the window sits, mute and volume, the window runtime and logs. Read it through `status`; don't edit it. In particular, never unmute the face or change its volume yourself.

## Updating

Updates to these skills arrive only through the skills CLI. When the user says there's an update (or asks you to check), run this where the skills are installed:

```bash
npx skills update -y
```

Nothing else is needed: the next face command notices the window is on the old version and restarts it. `status` shows the installed `version`.

## If something is wrong

- `error: the face window did not start` — the `hint` gives the log file; read its last lines.
- `face_error` in `status`, or a red message in the window — the face folder has a problem. Run `check`; it lists every problem and which file it's in.
- The window shows the wrong thing — `snapshot` shows you exactly what the user sees.

## Related skills

- `agent-face-voice` — speak clips aloud, with the mouth moving in time.
- `agent-face-template` — create or change the face: states, animation, mouth frames, voice clips.
