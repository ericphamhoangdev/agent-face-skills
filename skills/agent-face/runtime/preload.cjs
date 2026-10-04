'use strict';
// The only bridge between the face page and the window process: a fixed
// list of messages each way, nothing else.

const { contextBridge, ipcRenderer } = require('electron');

const FROM_WINDOW = new Set(['view', 'caption', 'muted', 'play', 'stop-audio']);
const TO_WINDOW = new Set([
  'image-size',
  'resize-by',
  'menu',
  'close',
  'toggle-mute',
  'drag-start',
  'drag-move',
  'drag-end',
  'play-started',
  'play-ended',
]);

contextBridge.exposeInMainWorld('faceHost', {
  init: () => ipcRenderer.invoke('init'),
  on: (channel, listener) => {
    if (FROM_WINDOW.has(channel)) ipcRenderer.on(channel, (_event, data) => listener(data));
  },
  send: (channel, data) => {
    if (TO_WINDOW.has(channel)) ipcRenderer.send(channel, data);
  },
});
