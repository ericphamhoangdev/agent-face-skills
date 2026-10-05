# Security checklist

Read a staged diff against this whenever it touches code. Each item describes how the repo is built today. A change that breaks one needs a reason the user agrees with, written down in `docs/design.md`.

## The face window (Electron)

- `webPreferences` keeps `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. No `webSecurity: false`, `allowRunningInsecureContent`, `webviewTag` or experimental features.
- The window loads only `agent-face://local/…`. Pop-ups and navigation stay denied (`setWindowOpenHandler` returns deny, `will-navigate` is prevented). Nothing is loaded from the network.
- The page's Content-Security-Policy in `runtime/page.cjs` stays `default-src 'none'` with only `'self'` sources: no `'unsafe-inline'`, `'unsafe-eval'` or remote hosts.
- The preload exposes a fixed list of channels each way. Never expose `ipcRenderer`, a generic send or invoke, or anything from Node.
- Text from a template or an agent (names, captions, clip text, state names, errors) reaches the page through `textContent`, never `innerHTML` or an HTML string.
- Main-process IPC handlers treat what the page sends as untrusted and check types and ranges before acting on it, as `resize-start` does with its edge.

## Files and paths

- Every path that comes from a template (`file`, `still`, `talk`, `sound`, clip files, and any new field) goes through `resolveInside` before it is read or served. It resolves links and refuses anything outside the template folder.
- The `agent-face://` handler serves only the fixed runtime files and files inside the template in use.
- Template ids, and any other name that becomes a folder name, are checked against the id pattern in `face.cjs init`.
- `shell.openPath` opens only the face's own folders. No `shell.openExternal`, and never a path or URL taken from a template.

## The control pipe

- The window listens only on the local pipe or socket from `lib/paths.cjs`: a named pipe on Windows, a socket inside the per-user folder elsewhere. Never a TCP port, and never a socket in a shared folder such as `/tmp`.
- Commands stay narrow. None runs programs, reads files back to the caller, evaluates code, or changes mute or volume (those belong to the user).
- Commands that write files (`snapshot`, `current`) take their path only from the local `face.cjs` caller.

## Processes and network

- Child processes are spawned with an argument array and no shell. The one shell call, `npm install electron@<major>` in `setup`, is a fixed string and must stay one: never put a variable into a command line run with `shell: true`.
- The only network access is that npm install during `setup`. No downloads at run time, no self-updater, no telemetry, nothing piped into a shell.
- No new npm dependencies in the skills without the user's agreement; the skills ship as plain source.

## Data

- Per-user state (window position, mute, volume, logs, the runtime) lives in the per-user folder from `lib/paths.cjs`, never in the agent's repo.
- Logs record what happened (states, clip names, the audio device), never secrets or environment variables.
- Tests use temporary folders and their own `AGENT_FACE_HOME`. They never touch the real per-user folder or write into the repo.

## Known, accepted risks

- On a Windows machine shared by several accounts, another account could create a face's pipe name before its window starts. The face then can't start, or talks to the impostor, until that process goes away. Once a face is running, the pipe's default permissions stop other accounts from sending it commands.
- The window sets no permission handler. Its pages are local and locked down by the CSP, so no foreign script is there to ask for permissions.
- `setup` installs the newest patch of a pinned Electron major from npm, and Electron's installer checks the download against the checksums in the npm package.
