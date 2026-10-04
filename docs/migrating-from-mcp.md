# Moving from the Agent Face MCP app

The skills replace the app completely. Once an agent's face runs from the skills, that agent no longer needs the MCP server, and once every agent has moved, the app can be uninstalled.

## Move one agent

1. **Install the skills** in the agent's project: `npx skills add ericphamhoangdev/agent-face-skills`.
2. **Copy the templates into the repo.** The template format is unchanged, and the app's `faceTemplates/` folder maps one-to-one onto `.agent-face/`: copy each template folder you want into `.agent-face/`, keeping its name as the template id.

   | OS | App data folder |
   | --- | --- |
   | Windows | `%APPDATA%\dev.agentface.app\faceTemplates\` |
   | macOS | `~/Library/Application Support/dev.agentface.app/faceTemplates/` |
   | Linux | `~/.config/dev.agentface.app/faceTemplates/` |

3. **Check them:** `face.cjs check`. Fix anything under `errors`. `face.cjs templates` shows what you have, and `face.cjs use <id>` picks the one the face shows.
4. **Install the window runtime and start:** `face.cjs setup`, then `face.cjs start`.
5. **Close the old face** in the app's control panel, or quit the app, so there aren't two.
6. **Remove the old wiring:** the `agent-face` entry in the agent's MCP config, and any rule file that told the agent to call the MCP tools. The `agent-face` skill now carries those instructions.

Decide whether `.agent-face/` should be committed. In the app, the art and clips were private to your machine; in a repo they go wherever the repo goes.

## What maps to what

| MCP tool | Now |
| --- | --- |
| `get_face_states` | `face.cjs states [--template <id>]` |
| `get_face_state` | `face.cjs status` (`state`) |
| `set_face_state` | `face.cjs state <name> [--caption "…"]` |
| `set_random_face_state` | `face.cjs random [--caption "…"]` |
| `set_face_caption` | `face.cjs caption ["text"]` |
| `say` | `face.cjs say <clip> [--state <name>] [--caption "…"]` |
| `get_face_image` | `face.cjs current` (a PNG of the face as it is now, plus the state's own file). |
| `get_face_template_preview` | Read the image files in `.agent-face/<template>/`. |
| `get_face_template` | `face.cjs states`, `face.cjs clips` and `face.cjs check`, each with `--template <id>`. |
| `get_health` | `face.cjs status` |
| HTTP routes (`/health`, `/faces/…`) | Gone. There is no server. |

Faces no longer have names to address them by: the face is the one in the repo the command runs from. Choosing a template, which was the user's job in the control panel, is now `face.cjs use <id>` or the window's right-click menu.

## What changes for the user

- **No control panel.** Create a template with `face.cjs init` or by adding files; hide and show the face with the × button and `face.cjs start`; everything else is the right-click menu.
- **Sound settings start fresh.** Mute and volume are per face and default to unmuted at 70%. Change them from the right-click menu. There are no quiet hours: mute a face when you want it silent.
- **Window position starts fresh.** Drag the face where you want it once.
- **No port.** Nothing listens on the network.
