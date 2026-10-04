# Design

Why Agent Face is a set of skills, how the pieces fit, and what was traded away.

## Where this came from

Agent Face started as a desktop app with a built-in MCP server. An agent connected to `http://127.0.0.1:<port>/mcp` and called tools such as `set_face_state`. It worked, but the shape caused recurring problems:

- **A port.** The server needed one. When another program (or a second copy of the app) held it, faces silently stopped responding, and every agent's config had the port number baked in.
- **Setup lived outside the agent.** A person had to install the app, start it, create a face in its control panel, paste a URL into each agent's MCP config, and tell the agent the face's name. An agent couldn't get itself a face.
- **The face lived in the app.** Images and clips sat in the app's data folder, far from the agent that owned them. Agents needed special tools just to look at their own face.
- **Updates meant a new installer**, built per platform.

Skills fix the shape rather than the symptoms: the agent installs the capability, owns its face as files in its repo, and runs the window itself.

## The pieces

```
skills/agent-face/
  SKILL.md          when and how to drive the face
  scripts/face.cjs  the command agents run
  lib/              shared: face folder loader, image headers, storage, pipe client
  runtime/          the window: Electron main process, preload, page, lip-sync maths
skills/agent-face-voice/SKILL.md      speaking, and sound manners
skills/agent-face-template/SKILL.md   authoring the face folder
```

**`face.cjs`** is a short-lived process. Read-only commands (`states`, `clips`, `check`, most of `status`) read the face folder directly. Everything else is one JSON line sent to the window over a local pipe, and one JSON line back.

**The window** is an Electron process per face folder. It is frameless, transparent, always on top and absent from the taskbar. It serves its own page and the face's files through a private `agent-face://` scheme that refuses any path outside those two folders. The page shows the state's image, the caption, and during speech swaps mouth frames on the audio clock.

**The face folder** (`agent-face/` in the agent's repo) is the single source of truth and is re-read on every command; a file watcher redraws the window when it changes.

**Per-user data** (`~/.agent-face/`) holds what isn't the agent's to decide or commit: window position, mute and volume per face, the Electron install, logs.

## Decisions

### Electron for the window

The window must be transparent with soft edges, stay on top, play animated WebP/APNG/GIF, play audio and be scriptable. Options considered:

| Option | Why not |
| --- | --- |
| Keep the native app, drop only MCP | Still needs a per-platform installer and a separately installed program. Shipping binaries from a public repo also means trusting whoever built them. |
| A browser window in app mode | Can't be transparent or always on top. |
| Native script per platform (e.g. PowerShell + WPF) | No animated WebP/APNG; one implementation per OS. |
| Python + a GUI toolkit | Per-pixel transparency needs native code; audio decoding and animation need extra packages. |

Electron gives all of it from plain JavaScript and HTML that live in the skill folder as readable source. Anyone who can run `npx skills` already has Node and npm, which is all `setup` needs to fetch it.

The cost is weight: a ~100 MB one-time download and roughly 300 MB of memory per face. If that becomes a problem, one shared process could host every face's window; the pipe protocol wouldn't change.

### A pipe, not a port

The window listens on a named pipe (Windows) or a Unix socket (elsewhere) whose name is derived from the face folder's path. Nothing to configure, nothing to collide with, nothing reachable from the network or from a web page. It also makes "is a window already showing this face?" a simple question: can I connect?

### The face is files in the agent's repo

It makes the agent the owner: it can read its own art with ordinary file tools, edit `config.json`, add a clip, and see the result immediately. Tools from the MCP version that existed only to peek into the app's folder (`get_face_image`, `get_face_template`, the contact sheet) are gone; `check` and `snapshot` cover what's left.

The trade-off is privacy: a face committed to a public repo is public. The template skill says so.

### Sound belongs to the user

Mute and volume are per face and live in `~/.agent-face/`, changed from the window's right-click menu and its speaker button. The CLI has no command to change them. An agent with file access could still edit that file, so this is a boundary of instructions and design rather than of enforcement; the voice skill is explicit that it must not.

### A closed face stays closed

Agents update the face at least twice a turn. If a state change reopened the window, a user who closed it would see it pop back every turn. So closing (the × button, the menu, `stop`) is remembered, and only an explicit `start` reopens it. State changes while closed are remembered and shown at the next `start`.

### Updates through the skills CLI only

The window and the command are versioned together by `skills/agent-face/VERSION`. After `npx skills update`, the next command finds the running window reporting an older version, asks it to quit, and starts it from the new files. There is no self-updater and no version check over the network.

### Lip-sync by loudness

Before a clip plays, the page decodes it and measures loudness in 40 ms steps. Each step becomes "closed" or one of the state's open-mouth frames, relative to the clip's own loud level, with a forced dip on long sounds so the mouth keeps moving. Playback and the mouth are both scheduled on the audio clock, corrected for output latency, so they stay together on slow or wireless speakers. It doesn't form mouth shapes for particular sounds; that needs phoneme data the clips don't carry.

## What isn't here yet

- macOS and Linux are untested.
- One process per face (see above).
- No signed releases or pinned Electron build: `setup` installs the newest patch of the pinned major version from npm.
