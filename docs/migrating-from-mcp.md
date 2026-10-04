# Moving from the Agent Face MCP app

The skills replace the app completely. Once an agent's face runs from the skills, that agent no longer needs the MCP server, and once every agent has moved, the app can be uninstalled.

## Move one agent

1. **Install the skills** in the agent's project: `npx skills add ericphamhoangdev/agent-face-skills`.
2. **Copy the face into the repo.** The folder format is unchanged. Copy the template folder from the app's data folder into the repo root as `agent-face/`:

   | OS | App data folder |
   | --- | --- |
   | Windows | `%APPDATA%\dev.agentface.app\faceTemplates\<template id>\` |
   | macOS | `~/Library/Application Support/dev.agentface.app/faceTemplates/<template id>/` |
   | Linux | `~/.config/dev.agentface.app/faceTemplates/<template id>/` |

3. **Check it:** `face.cjs check`. Fix anything under `errors`.
4. **Install the window runtime and start:** `face.cjs setup`, then `face.cjs start`.
5. **Close the old face** in the app's control panel, or quit the app, so there aren't two.
6. **Remove the old wiring:** the `agent-face` entry in the agent's MCP config, and any rule file that told the agent to call the MCP tools. The `agent-face` skill now carries those instructions.

Decide whether `agent-face/` should be committed. In the app, the art and clips were private to your machine; in a repo they go wherever the repo goes.

## What maps to what

| MCP tool | Now |
| --- | --- |
| `get_face_states` | `face.cjs states` |
| `get_face_state` | `face.cjs status` (`state`) |
| `set_face_state` | `face.cjs state <name> [--caption "…"]` |
| `set_random_face_state` | `face.cjs random [--caption "…"]` |
| `set_face_caption` | `face.cjs caption ["text"]` |
| `say` | `face.cjs say <clip> [--state <name>] [--caption "…"]` |
| `get_face_image` | Read the image file in `agent-face/`, or `face.cjs snapshot <file.png>` for the window as shown. |
| `get_face_template_preview` | Read the image files in `agent-face/`. |
| `get_face_template` | `face.cjs check` (sizes, frame counts, clips, problems). |
| `get_health` | `face.cjs status` |
| HTTP routes (`/health`, `/faces/…`) | Gone. There is no server. |

Faces no longer have names to address them by: the face is the one in the repo the command runs from.

## What changes for the user

- **No control panel.** Create a face with `face.cjs init` or by adding files; hide and show it with the × button and `face.cjs start`; everything else is the right-click menu.
- **Sound settings start fresh.** Mute and volume are per face and default to unmuted at 70%. Quiet hours default to on, 20:00–08:00, whatever the app's setting was. Change them from the right-click menu.
- **Window position starts fresh.** Drag the face where you want it once.
- **No port.** Nothing listens on the network.
