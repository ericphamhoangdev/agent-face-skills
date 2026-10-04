'use strict';
// The face page: shows the current state's image, a caption, and — while a
// voice clip plays — swaps mouth frames in time with the audio.

const host = window.faceHost;
const lipSync = window.AgentFaceLipSync;
const byId = (id) => document.getElementById(id);
const stage = byId('stage');
const faceImg = byId('face');
const mouthBox = byId('mouth');
const errorBox = byId('error');
const captionBox = byId('caption');
const labelBox = byId('label');
const muteButton = byId('mute');

/** The view on screen (see view() in main.cjs). */
let current = null;
/** Decoded lip-sync images for `current`: [closed, ...open], or null. */
let mouth = null;
/** Settles once `current`'s mouth frames are loaded, or it turns out to have none. */
let mouthReady = Promise.resolve();
let mouthSettled = () => {};
/** Object URL of a closed-mouth frame made from an animation, to free later. */
let madeStill = null;
/**
 * The clip being spoken: { playId, context, source, clip, tuning, startAt, timer }.
 * It outlives redraws: a new state or an edited template changes the
 * picture, not the voice.
 */
let talking = null;

function setCaption(text) {
  captionBox.textContent = text || '';
  captionBox.hidden = !text;
}

function setMuted(muted) {
  muteButton.textContent = muted ? '🔇' : '🔊';
  muteButton.title = muted ? 'Unmute voice' : 'Mute voice';
  muteButton.classList.toggle('muted', muted);
}

function showError(message) {
  errorBox.textContent = `Face error: ${message}`;
  errorBox.hidden = false;
  faceImg.hidden = true;
}

function dropMouth() {
  mouth = null;
  mouthBox.replaceChildren();
  if (madeStill) URL.revokeObjectURL(madeStill);
  madeStill = null;
}

function show(view) {
  // Keep talking through a redraw: the mouth stops until the new state's
  // frames are ready, then carries on with them (see startMouth).
  stopMouth();
  dropMouth();
  mouthSettled(); // nobody should keep waiting for the previous view
  current = view;
  if (view.error) {
    showError(view.error);
    return;
  }
  mouthReady = new Promise((resolve) => {
    mouthSettled = resolve;
  });
  errorBox.hidden = true;
  faceImg.hidden = false;
  faceImg.alt = view.state;
  labelBox.textContent = `${view.name} · ${view.state}`;
  setCaption(view.caption);
  setMuted(view.muted);
  // A new URL each time: browsers share one animation timeline per URL, so
  // reusing it would resume mid-loop instead of restarting the animation.
  faceImg.src = `${view.src}?v=${view.rev}`;
}

/** The image's current frame as a still. Right after loading, that's frame one. */
function firstFrame(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png'));
}

// Decoded up front so swapping frames mid-sentence never flickers.
async function loadFrame(url) {
  const image = new Image();
  image.draggable = false;
  image.hidden = true;
  image.src = url;
  await image.decode().catch(() => {});
  return image;
}

faceImg.addEventListener('load', async () => {
  const view = current;
  const settled = mouthSettled;
  host.send('image-size', { width: faceImg.naturalWidth, height: faceImg.naturalHeight });
  try {
    if (!view || !view.talk || !view.talk.length) return;
    let still = view.still && `${view.still}?v=${view.rev}`;
    if (!still) {
      still = await firstFrame(faceImg);
      if (current !== view) {
        if (still) URL.revokeObjectURL(still);
        return;
      }
      madeStill = still;
    }
    if (!still) return;
    const frames = await Promise.all([still, ...view.talk.map((u) => `${u}?v=${view.rev}`)].map(loadFrame));
    if (current !== view) return; // the state changed while these were loading
    mouthBox.replaceChildren(...frames);
    mouth = frames;
    startMouth(); // mid-sentence: the new state's mouth takes over
  } finally {
    settled();
  }
});

faceImg.addEventListener('error', () => {
  mouthSettled();
  if (current && !current.error) showError(`can't show the image for state '${current.state}'`);
});

/** Show mouth frame `level` (0 = closed), or the normal image when null. */
function setMouth(level) {
  faceImg.classList.toggle('behind-mouth', level !== null);
  if (mouth) mouth.forEach((frame, i) => (frame.hidden = i !== level));
}

/** Stop moving the mouth and show the state's normal image. The voice carries on. */
function stopMouth() {
  if (talking) clearTimeout(talking.timer);
  setMouth(null);
}

/**
 * Move the mouth with the clip being spoken, using the frames of the state
 * on screen. The whole clip is measured up front, so the mouth follows a
 * plan rather than chasing the sound; the audio clock keeps them in step.
 */
function startMouth() {
  if (!talking || !mouth) return false;
  const t = talking;
  clearTimeout(t.timer);
  const frames = mouth.length - 1;
  const channels = Array.from({ length: t.clip.numberOfChannels }, (_, c) => t.clip.getChannelData(c));
  const plan = lipSync.mouthLevels(channels, t.clip.sampleRate, frames, t.tuning);
  const frameSet = mouth;
  const tick = () => {
    if (talking !== t || mouth !== frameSet) return;
    // Output latency: how long a sample takes to reach the speakers (large on wireless ones).
    const heardMs = (t.context.currentTime - t.startAt - (t.context.outputLatency || 0)) * 1000;
    const step = Math.floor(heardMs / plan.step_ms);
    setMouth(step < 0 || step >= plan.levels.length ? 0 : Math.min(plan.levels[step], frames));
    const untilNext = plan.step_ms - (((heardMs % plan.step_ms) + plan.step_ms) % plan.step_ms);
    t.timer = setTimeout(tick, Math.max(4, untilNext));
  };
  tick();
  return true;
}

/** Stop the clip being spoken: a new clip, or muting. */
function stopTalking() {
  if (!talking) return;
  const { playId, context, source, timer } = talking;
  talking = null;
  host.send('play-ended', { playId, cut: true });
  clearTimeout(timer);
  source.onended = null;
  try {
    source.stop();
  } catch {
    // already finished
  }
  context.close().catch(() => {});
  setMouth(null);
}

/**
 * A new audio context, running on the speakers the system uses right now.
 * One per clip, closed when it ends: a context kept between clips can end
 * up on a device that went away (a USB or Bluetooth speaker that slept or
 * was swapped), where Chromium keeps its clock ticking but nothing is heard.
 */
async function openAudio() {
  const context = new AudioContext();
  if (context.state !== 'running') {
    await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  if (context.state !== 'running') {
    const state = context.state;
    context.close().catch(() => {});
    throw new Error(`the audio output did not start (state: ${state})`);
  }
  return context;
}

/** What the audio output is doing, for the reply and the log. */
async function describeAudio(context) {
  let device = null;
  try {
    const sink = context.sinkId || 'default';
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const match = outputs.find((d) => d.deviceId === sink);
    device = (match && match.label) || null;
  } catch {
    // labels aren't always available
  }
  return {
    state: context.state,
    device: device || 'system default',
    sample_rate: context.sampleRate,
    output_latency_ms: Math.round((context.outputLatency || 0) * 1000),
  };
}

/** A short three-note chirp, for the sound test. */
function chirp(context) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.round(rate * 0.75), rate);
  const data = buffer.getChannelData(0);
  for (const [start, length, hz] of [[0, 0.16, 520], [0.22, 0.14, 660], [0.42, 0.24, 590]]) {
    const first = Math.round(start * rate);
    const count = Math.round(length * rate);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const envelope = Math.sin((Math.PI * i) / count);
      data[first + i] = 0.3 * envelope * (Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(4 * Math.PI * hz * t));
    }
  }
  return buffer;
}

async function play({ playId, url, tone, volume, lip_sync: tuning }) {
  stopTalking();
  let audio = null;
  try {
    audio = await openAudio();
    let clip;
    if (tone) {
      clip = chirp(audio);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`clip not found (${response.status})`);
      clip = await audio.decodeAudioData(await response.arrayBuffer());
    }
    // A clip often arrives right behind a state change: give that state's
    // mouth frames a moment to finish loading rather than speak without them.
    await Promise.race([mouthReady, new Promise((resolve) => setTimeout(resolve, 2000))]);

    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = clip;
    gain.gain.value = volume;
    source.connect(gain).connect(audio.destination);
    const startAt = audio.currentTime + 0.05;
    source.start(startAt);
    const context = audio;
    talking = { playId, context, source, clip, tuning, startAt, timer: undefined };
    source.onended = () => {
      if (talking && talking.playId === playId) {
        clearTimeout(talking.timer);
        talking = null;
        setMouth(null);
      }
      context.close().catch(() => {});
      host.send('play-ended', { playId });
    };
    const moving = startMouth();
    host.send('play-started', {
      playId,
      duration_ms: Math.round(clip.duration * 1000),
      lip_sync: moving,
      audio: await describeAudio(audio),
    });
  } catch (e) {
    if (audio && !(talking && talking.context === audio)) audio.close().catch(() => {});
    host.send('play-started', { playId, error: e.message || String(e) });
  }
}

host.on('view', show);
host.on('caption', setCaption);
host.on('muted', setMuted);
host.on('play', play);
host.on('picture', async ({ pictureId, max }) => {
  try {
    // Whatever is on screen: the open or closed mouth mid-speech, else the state's image.
    const shown = (talking && mouth && mouth.find((frame) => !frame.hidden)) || faceImg;
    const longest = Math.max(shown.naturalWidth, shown.naturalHeight);
    if (!longest) throw new Error('no image is showing');
    // Shrink big art to fit; only vector art is worth enlarging.
    const vector = /\.svg(\?|$)/i.test(shown.currentSrc || shown.src);
    const scale = vector ? max / longest : Math.min(1, max / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(shown.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(shown.naturalHeight * scale));
    canvas.getContext('2d').drawImage(shown, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new Uint8Array(await blob.arrayBuffer());
    host.send('picture-result', { pictureId, width: canvas.width, height: canvas.height, data });
  } catch (e) {
    host.send('picture-result', { pictureId, error: e.message || String(e) });
  }
});
host.on('stop-audio', stopTalking);

// Drag anywhere on the face to move it.
let dragging = false;
let frameRequest = 0;
stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  dragging = true;
  stage.classList.add('dragging');
  stage.setPointerCapture(event.pointerId);
  host.send('drag-start');
});
stage.addEventListener('pointermove', () => {
  if (!dragging || frameRequest) return;
  frameRequest = requestAnimationFrame(() => {
    frameRequest = 0;
    if (dragging) host.send('drag-move');
  });
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  stage.classList.remove('dragging');
  host.send('drag-end');
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// Drag an edge or corner to resize. The window process follows the cursor.
let resizing = false;
for (const handle of document.querySelectorAll('.resize')) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation(); // a resize, not a move
    resizing = true;
    handle.setPointerCapture(event.pointerId);
    host.send('resize-start', handle.dataset.edge);
  });
  handle.addEventListener('pointermove', () => {
    if (!resizing || frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (resizing) host.send('resize-move');
    });
  });
  const endResize = () => {
    if (!resizing) return;
    resizing = false;
    host.send('resize-end');
  };
  handle.addEventListener('pointerup', endResize);
  handle.addEventListener('pointercancel', endResize);
}

// Scrolling over the face resizes it too; right-click for the menu.
stage.addEventListener('wheel', (event) => host.send('resize-by', event.deltaY < 0 ? 1.1 : 1 / 1.1), { passive: true });
stage.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  host.send('menu');
});
byId('close').addEventListener('click', () => host.send('close'));
muteButton.addEventListener('click', () => host.send('toggle-mute'));

host.init().then(show);
