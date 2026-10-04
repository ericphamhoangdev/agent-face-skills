'use strict';
// Image headers are built by hand here: this repo holds no image files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mediaInfo, mimeFor } = require('../skills/agent-face/lib/media.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-face-media-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function info(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return mediaInfo(file);
}

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u24le = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

const pngChunk = (type, data) => Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const pngFile = (width, height, ...chunks) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])])),
    ...chunks,
    pngChunk('IDAT', Buffer.alloc(10)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

const riffChunk = (type, data) => Buffer.concat([Buffer.from(type, 'latin1'), u32le(data.length), data, Buffer.alloc(data.length & 1)]);
const webpFile = (...chunks) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length), body]);
};

test('PNG: size, one frame', () => {
  const i = info('still.png', pngFile(512, 300));
  assert.deepEqual([i.width, i.height, i.frames, i.mime], [512, 300, 1, 'image/png']);
});

test('APNG: frame count comes from acTL', () => {
  const i = info('anim.png', pngFile(64, 64, pngChunk('acTL', Buffer.concat([u32be(12), u32be(0)]))));
  assert.deepEqual([i.width, i.height, i.frames], [64, 64, 12]);
});

test('GIF: counts image blocks', () => {
  const frame = Buffer.concat([
    Buffer.from([0x21, 0xf9, 0x04, 0, 5, 0, 0, 0]), // graphic control extension
    Buffer.from([0x2c]), u16le(0), u16le(0), u16le(16), u16le(8), Buffer.from([0]), // image descriptor
    Buffer.from([2, 2, 0x4c, 0x01, 0]), // LZW code size, one data block, end
  ]);
  const file = Buffer.concat([Buffer.from('GIF89a', 'latin1'), u16le(16), u16le(8), Buffer.from([0, 0, 0]), frame, frame, frame, Buffer.from([0x3b])]);
  const i = info('anim.gif', file);
  assert.deepEqual([i.width, i.height, i.frames], [16, 8, 3]);
});

test('WebP: animated (VP8X + ANMF) and lossless (VP8L)', () => {
  const vp8x = riffChunk('VP8X', Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24le(511), u24le(255)]));
  const frame = riffChunk('ANMF', Buffer.alloc(17)); // odd length: checks chunk padding
  const animated = info('anim.webp', webpFile(vp8x, riffChunk('ANIM', Buffer.alloc(6)), frame, frame, frame, frame));
  assert.deepEqual([animated.width, animated.height, animated.frames], [512, 256, 4]);

  const bits = (100 - 1) | ((50 - 1) << 14);
  const lossless = info('still.webp', webpFile(riffChunk('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le(bits)]))));
  assert.deepEqual([lossless.width, lossless.height, lossless.frames], [100, 50, 1]);
});

test('JPEG: size from the start-of-frame marker', () => {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0x2c, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const i = info('photo.jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]));
  assert.deepEqual([i.width, i.height, i.frames], [640, 300, 1]);
});

test('SVG: width/height attributes, else the viewBox', () => {
  const sized = info('a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"></svg>');
  assert.deepEqual([sized.width, sized.height, sized.mime], [200, 120, 'image/svg+xml']);
  const boxed = info('b.svg', '<?xml version="1.0"?>\n<svg viewBox="0 0 48 24"></svg>');
  assert.deepEqual([boxed.width, boxed.height], [48, 24]);
});

test('unreadable headers give nulls, not a crash', () => {
  const i = info('broken.png', Buffer.from('not a png'));
  assert.deepEqual([i.width, i.height, i.frames, i.bytes], [null, null, null, 9]);
  assert.equal(mimeFor('clip.MP3'), 'audio/mpeg');
});
