---
name: agent-face-template
description: Create or change the face itself, meaning the agent-face/ folder in your repo that holds the state images, lip-sync mouth frames and voice clips. Use when the user wants a new face, new or changed states or expressions, animated states, a talking mouth, voice clips added or lip-sync tuned; when moving a face over from the old Agent Face MCP app; and whenever face.cjs check reports problems. Needs the agent-face skill installed next to it.
metadata:
  version: "0.1.0"
---

# Agent Face — the face folder

A face is a folder of files in your own repo. There's nothing to install or register: edit the files and the window redraws within a second.

```
agent-face/
├── config.json          states, default state, lip-sync tuning
├── idle.webp            one image per state (still or animated)
├── happy.png
├── mouth/               optional: open-mouth frames for lip-sync
│   └── idle-open.png
└── voice/               optional: clips the face can speak
    ├── index.json
    └── hello.mp3
```

The command lives in the `agent-face` skill, installed next to this one:

```bash
node "<this skill's folder>/../agent-face/scripts/face.cjs" <command>
```

## The loop

1. Edit `agent-face/` (add an image, change `config.json`).
2. Run `face.cjs check`. It reads every file's size and frame count and lists `errors` and `warnings`. Fix errors before going on.
3. Look at the result. The open window has already redrawn. Read the image files directly to judge the art, or `face.cjs snapshot out.png` to see the window as the user does.

`face.cjs init` creates a small starter face if there's no folder yet. It's a working example of everything below, including a talking mouth and one clip.

## config.json

```json
{
  "name": "Robo",
  "description": "A friendly little robot.",
  "default_state": "idle",
  "states": {
    "idle":    { "file": "idle.webp", "still": "idle.png", "talk": "mouth/idle-open.png" },
    "working": { "file": "working.webp" },
    "happy":   { "file": "happy.png", "talk": ["mouth/happy-half.png", "mouth/happy-open.png"] },
    "done":    { "file": "done.png", "sound": "chime" }
  }
}
```

- **State names** are what you pass to `face.cjs state`. Keep them short and predictable: `idle`, `thinking`, `working`, `happy`, `sad`. Their order in the file is the order `states` lists them, and the first is the fallback default.
- **`file`** is the state's image: PNG, JPEG, WebP, GIF or SVG. Animated WebP, APNG and GIF play on a loop and restart whenever the state is shown. Prefer WebP or APNG for a character on a transparent background: GIF transparency is on/off per pixel, so edges look jagged.
- Paths are relative to `agent-face/` and can't point outside it.
- Keep each file to a few MB. A reasonable size for art is 512 px on the long side.

The full field reference, including lip-sync tuning, is in `references/template-format.md`.

## A talking mouth

While a clip plays, the window swaps between a closed-mouth image and one or more open-mouth images, following how loud the clip is. To give a state a mouth:

- **`talk`** — one open-mouth image, or a list from least to most open.
- **`still`** — the closed-mouth image. Needed for animated states (without it, the animation's first frame is used, which may not match your mouth frames). A state whose `file` is already a still image is its own closed mouth.

The one rule that matters: **every `talk` and `still` image must be the same pixel size as the state's `file`, with the character in exactly the same place.** Only the mouth should differ. `check` reports size mismatches as errors; alignment you have to judge by eye, so flip between the images.

A state without `talk` simply doesn't move its mouth. If the mouth feels sluggish or twitchy, tune `lip_sync` (see the reference).

## Voice clips

```json
{
  "clips": {
    "hello": { "file": "hello.mp3", "text": "Hi! I'm here if you need me." },
    "done":  { "file": "done.mp3",  "text": "All done!" }
  }
}
```

That's `agent-face/voice/index.json`. `file` is relative to `voice/` (MP3 or WAV; Ogg and FLAC also play). `text` is shown under the face while the clip plays, so keep it under 60 characters or it gets cut. Clips aren't tied to states. How and when to play them is the `agent-face-voice` skill.

## Privacy

The face is ordinary files in your repo. If the art or the voice is something the user wouldn't want published, and the repo is public (or might become so), add `agent-face/` to `.gitignore` or keep it out of commits. Ask the user if you're unsure.

## Coming from the Agent Face MCP app

The folder format is the same. Copy the template folder (from the app's `faceTemplates/<id>/`) into your repo as `agent-face/`, then run `check`. A `"state"` on each clip in an older `voice/index.json` is ignored; you can delete it.
