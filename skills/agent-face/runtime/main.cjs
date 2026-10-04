'use strict';
// The face window: one small transparent, always-on-top window per face
// folder. It reads the face from that folder, and takes commands from
// scripts/face.cjs over a local pipe — there is no server and no TCP port.

const { app, BrowserWindow, Menu, ipcMain, protocol, screen, shell } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const paths = require('../lib/paths.cjs');
const store = require('../lib/store.cjs');
const { loadFace, resolveInside } = require('../lib/config.cjs');
const { mimeFor } = require('../lib/media.cjs');

const ORIGIN = 'agent-face://local';
const PAGE = require('./page.cjs');
const APP_FILES = new Set(['face.css', 'face.js', 'lipsync.js']);
const MAX_CAPTION = 60;
const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 80;
const MAX_WIDTH = 1600;

const faceArg = process.argv.indexOf('--face');
const faceDir = faceArg > 0 && process.argv[faceArg + 1] ? path.resolve(process.argv[faceArg + 1]) : null;
if (!faceDir) {
  console.error('usage: electron <runtime folder> --face <face folder>');
  app.exit(2);
}
const id = paths.faceId(faceDir || '.');
const endpoint = paths.endpoint(id);

// Each face gets its own browser profile, so several faces can run at once.
app.setPath('userData', paths.electronDataDir(id));
// Clips play without a click on the window first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([
  { scheme: 'agent-face', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
/** The loaded face, or null while the folder can't be read (see faceError). */
let face = null;
let faceError = null;
let local = store.loadLocal(id);
let caption = null;
/** Bumped on every redraw; a new image URL makes animations restart. */
let rev = 0;
/** True when we close the window ourselves rather than the user. */
let quitting = false;
let drag = null;
let playSeq = 0;
/** Clips waiting for the page to say they started. */
const pendingPlays = new Map();
/** The caption a playing clip put up, cleared when that clip ends. */
let clipCaption = null;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const persist = () => store.saveLocal(id, local);
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

function reload() {
  try {
    face = loadFace(faceDir);
    faceError = null;
    if (!face.states.some((s) => s.name === local.state)) local.state = face.default_state;
  } catch (e) {
    face = null;
    faceError = e.message;
  }
}

const faceUrl = (rel) => `${ORIGIN}/face/${rel.split(/[\\/]+/).map(encodeURIComponent).join('/')}`;

/** Everything the page needs to draw the current state. */
function view() {
  rev += 1;
  if (!face) return { rev, error: faceError };
  const state = face.states.find((s) => s.name === local.state);
  return {
    rev,
    name: face.name,
    state: state.name,
    src: faceUrl(state.file),
    still: state.still ? faceUrl(state.still) : null,
    talk: state.talk.map(faceUrl),
    caption,
    muted: local.muted,
  };
}

function redraw() {
  if (face && win && !win.isDestroyed()) win.setTitle(`${face.name} face`);
  send('view', view());
}

function setCaption(text) {
  const clean = typeof text === 'string' ? text.split(/\s+/).filter(Boolean).join(' ') : '';
  caption = clean ? (clean.length > MAX_CAPTION ? `${clean.slice(0, MAX_CAPTION - 1)}…` : clean) : null;
  clipCaption = null;
  send('caption', caption);
  return caption;
}

function setState(name, { sound = true } = {}) {
  const state = face.states.find((s) => s.name === name);
  if (!state) {
    throw new Error(`state '${name}' is not in this face (have: ${face.states.map((s) => s.name).join(', ')})`);
  }
  const changed = local.state !== name;
  local.state = name;
  persist();
  caption = null; // a caption belongs to the state it was set on
  clipCaption = null;
  redraw();
  if (changed && sound && state.sound) {
    playClip(state.sound).catch((e) => log(`sound for state '${name}':`, e.message));
  }
}

function setMuted(muted) {
  local.muted = muted;
  persist();
  if (muted) send('stop-audio');
  send('muted', muted);
}

/** Play a voice clip, unless the user muted this face. */
async function playClip(clipName) {
  const clip = face.clips.find((c) => c.name === clipName);
  if (!clip) {
    const have = face.clips.map((c) => c.name);
    throw new Error(
      have.length
        ? `no voice clip '${clipName}' (have: ${have.join(', ')})`
        : 'this face has no voice clips (add voice/index.json)',
    );
  }
  resolveInside(faceDir, path.join('voice', clip.file));
  if (local.muted) return { result: 'muted' };

  const playId = ++playSeq;
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPlays.delete(playId);
      reject(new Error('the face window did not start the clip'));
    }, 10000);
    pendingPlays.set(playId, { resolve, reject, timer });
  });
  send('play', { playId, url: faceUrl(`voice/${clip.file}`), volume: local.volume, lip_sync: face.lip_sync });
  const { duration_ms, lip_sync } = await started;
  return { result: 'played', duration_ms, lip_sync, playId };
}

function status() {
  return {
    version: paths.VERSION,
    pid: process.pid,
    face_dir: faceDir,
    face: face ? face.name : null,
    state: face ? local.state : null,
    caption,
    muted: local.muted,
    volume: local.volume,
    ...(faceError ? { face_error: faceError } : {}),
  };
}

/** One command from face.cjs. Throws to report a failure. */
async function handle(req) {
  if (req.cmd === 'hello') return status();
  if (req.cmd === 'quit') {
    if (req.closed) {
      local.closed = true;
      persist();
    }
    setImmediate(quit);
    return {};
  }
  if (req.cmd === 'snapshot') {
    // Works even when the face can't be read: the picture shows the error.
    const image = await capture();
    fs.mkdirSync(path.dirname(req.path), { recursive: true });
    fs.writeFileSync(req.path, image.toPNG());
    return { path: req.path, ...image.getSize() };
  }

  reload(); // the face folder is read fresh for every command
  if (!face) throw new Error(faceError);

  switch (req.cmd) {
    case 'state':
      setState(req.state);
      if (req.caption !== undefined) setCaption(req.caption);
      return { state: local.state, caption };
    case 'random': {
      // Leave out the current state when there's another, so something always changes.
      const names = face.states.map((s) => s.name);
      const others = names.length > 1 ? names.filter((n) => n !== local.state) : names;
      setState(others[Math.floor(Math.random() * others.length)]);
      if (req.caption !== undefined) setCaption(req.caption);
      return { state: local.state, caption };
    }
    case 'caption':
      return { caption: setCaption(req.caption) };
    case 'say': {
      const clip = face.clips.find((c) => c.name === req.clip);
      // Check the clip before touching the face, so a typo changes nothing.
      if (!clip) await playClip(req.clip);
      // The clip is the sound here, not the state's own `sound`.
      if (req.state && req.state !== local.state) setState(req.state, { sound: false });
      const shown = setCaption(req.caption !== undefined ? req.caption : clip.text);
      const { playId, ...played } = await playClip(req.clip);
      if (playId && shown) clipCaption = { playId, text: shown };
      return { ...played, clip: clip.name, state: local.state, caption: shown };
    }
    default:
      throw new Error(`unknown command '${req.cmd}'`);
  }
}

/** A picture of the window. Capturing can fail while a new frame is being drawn, so try again. */
async function capture() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await win.webContents.capturePage();
    } catch (e) {
      if (attempt === 5) throw new Error(`could not capture the face window: ${e.message}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/** Listen for face.cjs. Resolves false when another window already serves this face. */
function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', async (chunk) => {
        buffer += chunk;
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let reply;
          try {
            reply = { ok: true, ...(await handle(JSON.parse(line))) };
          } catch (e) {
            reply = { ok: false, error: e.message };
          }
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        }
      });
    });
    server.once('listening', () => resolve(true));
    server.once('error', (e) => {
      if (e.code !== 'EADDRINUSE' || process.platform === 'win32') return resolve(false);
      // A socket file is left behind by a crash; only a live one answers.
      net
        .connect(endpoint)
        .once('connect', () => resolve(false))
        .once('error', () => {
          fs.rmSync(endpoint, { force: true });
          server.once('error', () => resolve(false));
          server.listen(endpoint);
        });
    });
    if (process.platform !== 'win32') fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    server.listen(endpoint);
  });
}

function serveFile(request) {
  const rel = decodeURIComponent(new URL(request.url).pathname);
  if (rel === '/app/face.html') {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  let file = null;
  try {
    if (rel.startsWith('/app/') && APP_FILES.has(rel.slice(5))) file = path.join(__dirname, rel.slice(5));
    else if (rel.startsWith('/face/')) file = resolveInside(faceDir, rel.slice(6));
  } catch {
    file = null; // missing, or outside the face folder
  }
  if (!file) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { 'content-type': mimeFor(file), 'cache-control': 'no-store' },
  });
}

/** Saved position, unless the screen it was on is gone. */
function savedBounds() {
  const b = local.bounds;
  if (!b || !b.width || !b.height) return { width: DEFAULT_WIDTH, height: DEFAULT_WIDTH };
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y + 40;
  });
  return visible ? b : { width: b.width, height: b.height };
}

let saveTimer = null;
function saveBoundsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    local.bounds = win.getBounds();
    persist();
  }, 300);
}

/** Keep the window the shape of the image it shows. */
function fitTo(imageWidth, imageHeight) {
  if (!win || win.isDestroyed() || !imageWidth || !imageHeight) return;
  const b = win.getBounds();
  const height = Math.max(1, Math.round((b.width * imageHeight) / imageWidth));
  if (Math.abs(height - b.height) > 1) win.setBounds({ ...b, height });
}

function resizeBy(factor) {
  if (!win || win.isDestroyed() || !(factor > 0)) return;
  const b = win.getBounds();
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, b.width * factor)));
  win.setBounds({ ...b, width, height: Math.max(1, Math.round((b.height * width) / b.width)) });
}

function quit() {
  quitting = true;
  app.quit();
}

function closeByUser() {
  local.closed = true;
  persist();
  quit();
}

function popupMenu() {
  const volume = (v) => ({
    label: `${Math.round(v * 100)}%`,
    type: 'radio',
    checked: Math.abs(local.volume - v) < 0.01,
    click: () => {
      local.volume = v;
      persist();
    },
  });
  Menu.buildFromTemplate([
    { label: face ? `${face.name} · ${local.state}` : 'Agent Face', enabled: false },
    { type: 'separator' },
    { label: 'Mute voice', type: 'checkbox', checked: local.muted, click: () => setMuted(!local.muted) },
    { label: 'Volume', submenu: [0.25, 0.5, 0.7, 1].map(volume) },
    { type: 'separator' },
    { label: 'Open face folder', click: () => shell.openPath(faceDir) },
    { label: 'Close face', click: closeByUser },
  ]).popup({ window: win });
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(),
    title: face ? `${face.name} face` : 'Agent Face',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Transparent windows can't use the system resize border; the page
    // sends wheel and drag gestures instead.
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep the mouth and animations running when another window covers the face.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.once('ready-to-show', () => win.showInactive()); // never steal focus from the user's work
  win.on('move', saveBoundsSoon);
  win.on('resize', saveBoundsSoon);
  win.on('close', () => {
    if (!quitting) {
      local.closed = true; // closed by the user (Alt+F4, the × button)
      persist();
    }
  });
  win.on('page-title-updated', (event) => event.preventDefault()); // keep "<name> face"
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadURL(`${ORIGIN}/app/face.html`);
}

ipcMain.handle('init', () => view());
ipcMain.on('image-size', (_event, size) => fitTo(size.width, size.height));
ipcMain.on('resize-by', (_event, factor) => resizeBy(factor));
ipcMain.on('menu', popupMenu);
ipcMain.on('close', closeByUser);
ipcMain.on('toggle-mute', () => setMuted(!local.muted));
ipcMain.on('drag-start', () => {
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  drag = { dx: cursor.x - b.x, dy: cursor.y - b.y, width: b.width, height: b.height };
});
ipcMain.on('drag-move', () => {
  if (!drag || !win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  // Size is passed every time: moving alone can make it creep on scaled displays.
  win.setBounds({ x: cursor.x - drag.dx, y: cursor.y - drag.dy, width: drag.width, height: drag.height });
});
ipcMain.on('drag-end', () => {
  drag = null;
});
ipcMain.on('play-started', (_event, message) => {
  const pending = pendingPlays.get(message.playId);
  if (!pending) return;
  pendingPlays.delete(message.playId);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(`could not play the clip: ${message.error}`));
  else pending.resolve(message);
});
ipcMain.on('play-ended', (_event, { playId }) => {
  if (clipCaption && clipCaption.playId === playId && caption === clipCaption.text) setCaption(null);
});

app.on('window-all-closed', quit);
app.on('will-quit', () => {
  if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
});

app.whenReady().then(async () => {
  if (!faceDir) return;
  if (!(await listen())) {
    log('another window already shows this face; exiting');
    quitting = true;
    app.exit(0);
    return;
  }
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  protocol.handle('agent-face', serveFile);
  reload();
  persist();
  createWindow();
  watchFace();
  log(`face window ${paths.VERSION} for ${faceDir}`);
});

/**
 * Redraw when the face folder changes, so edits show without a restart.
 * If the folder goes away (renamed, deleted and recreated), keep trying.
 */
function watchFace(retrying = false) {
  const retry = (reason) => {
    if (!retrying) log('face folder watch stopped:', reason);
    setTimeout(() => watchFace(true), 1000);
  };
  let timer = null;
  try {
    const watcher = fs.watch(faceDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        reload();
        redraw();
      }, 300);
    });
    watcher.on('error', (e) => {
      watcher.close();
      retry(e.message);
    });
    if (retrying) {
      log('watching the face folder again');
      reload();
      redraw();
    }
  } catch (e) {
    retry(e.message);
  }
}
