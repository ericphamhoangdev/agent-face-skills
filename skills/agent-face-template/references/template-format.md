# Template format

Everything the window reads from one template, `.agent-face/<template>/`. The folder's name is the template's id. Paths are relative to that folder and may not leave it.

## config.json

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Display name (window title, hover label). Defaults to the template's id. |
| `description` | string | Optional note for people and agents. Not shown in the window. |
| `default_state` | string | State shown the first time the face opens. Falls back to the first state. |
| `states` | object | Required. State name → state (below). Order is kept. |
| `lip_sync` | object | Optional tuning (below). |

### A state

| Field | Type | Meaning |
| --- | --- | --- |
| `file` | string | Required. The state's image. |
| `talk` | string or string[] | Open-mouth frames, least to most open. Same pixel size and alignment as `file`. |
| `still` | string | Closed-mouth frame shown between `talk` frames. Same size as `file`. Set it for animated states. |
| `sound` | string | Name of a voice clip to play once whenever the face switches into this state. |

### Image formats

| Format | Still | Animated | Notes |
| --- | --- | --- | --- |
| WebP | yes | yes | Full transparency. Best default. |
| PNG / APNG | yes | yes | Full transparency. Larger files. |
| GIF | yes | yes | On/off transparency only: jagged edges on a transparent background. |
| SVG | yes | no | Needs `width`/`height` or a `viewBox`. Text depends on installed fonts. |
| JPEG | yes | no | No transparency. |

The window takes the shape of the image, so states can have different aspect ratios; the window keeps its width and changes height.

### lip_sync

The mouth follows loudness. The clip is measured in steps; each step maps to "closed" or one of the `talk` frames. Thresholds are fractions of the clip's own loud level, so quiet and loud recordings behave alike.

| Field | Default | Range | Meaning |
| --- | --- | --- | --- |
| `step_ms` | 40 | 20–250 | How often the mouth can change. Lower is faster. |
| `open_at` | 0.10 | 0–1 | Loudness that opens the mouth to the first `talk` frame. Lower opens more easily. |
| `wide_at` | 0.45 | `open_at`–1 | Loudness that opens it to the last (widest) frame. |
| `hold_steps` | 3 | 0+ | Steps in a row on one open frame before it dips a notch, so long vowels still move. 0 never dips. |

- Mouth looks slow or stuck open: lower `step_ms` (try 30) or `hold_steps` (try 2).
- Mouth barely opens: lower `open_at` (try 0.06).
- Mouth chatters on background noise: raise `open_at`.

Changes apply from the next clip.

## voice/index.json

```json
{ "clips": { "<name>": { "file": "<file in voice/>", "text": "<what it says>" } } }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `file` | string | Required. Audio file relative to `voice/`. MP3 and WAV are the safe choices. |
| `text` | string | Shown under the face while the clip plays (cut at 60 characters). |

Other keys at the top level or on a clip are ignored, so you can keep your own notes there (which voice made the clips, for example).

## What `check` verifies

- `config.json` and `voice/index.json` parse, and every state has a `file`.
- Every referenced file exists and is inside the folder.
- `talk` and `still` frames have the same pixel size as their state's `file` (error).
- An animated state with `talk` frames has a `still` (warning if not).
- Every `sound` names a clip that exists.

It also reports each image's `width`, `height`, `frames` (more than 1 means animated) and `bytes`.
