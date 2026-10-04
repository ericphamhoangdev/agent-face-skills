'use strict';
// Size and frame count of an image file, read from its header. Lets `check`
// confirm that lip-sync frames line up with their state's image without
// pulling in an image library.

const fs = require('fs');
const path = require('path');

const MIME = Object.freeze({
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
});

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function png(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  let frames = 1;
  // Chunks: [length u32][type 4][data][crc u32]. An APNG announces its
  // frame count in an acTL chunk before the first IDAT.
  for (let off = 8; off + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'acTL' && off + 12 <= buf.length) frames = Math.max(1, buf.readUInt32BE(off + 8));
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + length;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), frames };
}

function gif(buf) {
  if (buf.length < 13 || buf.toString('latin1', 0, 3) !== 'GIF') return null;
  const tableSize = (packed) => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  const skipSubBlocks = (off) => {
    while (off < buf.length && buf[off] !== 0) off += buf[off] + 1;
    return off + 1;
  };
  let frames = 0;
  let off = 13 + tableSize(buf[10]);
  while (off < buf.length) {
    const block = buf[off];
    if (block === 0x2c) {
      // Image descriptor, optional local colour table, LZW code size, data.
      frames += 1;
      off = skipSubBlocks(off + 10 + tableSize(buf[off + 9]) + 1);
    } else if (block === 0x21) {
      off = skipSubBlocks(off + 2);
    } else {
      break; // 0x3b trailer, or something we don't understand
    }
  }
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames: Math.max(1, frames) };
}

function webp(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  let size = null;
  let frames = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const type = buf.toString('latin1', off, off + 4);
    const length = buf.readUInt32LE(off + 4);
    const data = off + 8;
    if (type === 'VP8X' && data + 10 <= buf.length) {
      size = { width: 1 + buf.readUIntLE(data + 4, 3), height: 1 + buf.readUIntLE(data + 7, 3) };
    } else if (type === 'ANMF') {
      frames += 1;
    } else if (type === 'VP8 ' && !size && data + 10 <= buf.length) {
      size = { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    } else if (type === 'VP8L' && !size && data + 5 <= buf.length) {
      const bits = buf.readUInt32LE(data + 1);
      size = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    off = data + length + (length & 1); // chunks are padded to even sizes
  }
  return size ? { ...size, frames: Math.max(1, frames) } : null;
}

function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let off = 2; off + 9 <= buf.length; ) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    // SOF0–SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5), frames: 1 };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

function svg(buf) {
  const tag = /<svg\b[^>]*>/i.exec(buf.toString('utf8', 0, Math.min(buf.length, 4096)));
  if (!tag) return null;
  const attr = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag[0]);
    return m ? Math.round(Number(m[1])) : null;
  };
  let width = attr('width');
  let height = attr('height');
  if (width === null || height === null) {
    const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag[0]);
    if (!box) return null;
    width = Math.round(Number(box[1]));
    height = Math.round(Number(box[2]));
  }
  return { width, height, frames: 1 };
}

const READERS = { '.png': png, '.apng': png, '.gif': gif, '.webp': webp, '.jpg': jpeg, '.jpeg': jpeg, '.svg': svg };

/**
 * `{ mime, bytes, width, height, frames }` for an image file. `width`,
 * `height` and `frames` are null when the header can't be read.
 */
function mediaInfo(file) {
  const buf = fs.readFileSync(file);
  const reader = READERS[path.extname(file).toLowerCase()];
  let info = null;
  try {
    info = reader ? reader(buf) : null;
  } catch {
    info = null; // truncated or malformed header
  }
  return { mime: mimeFor(file), bytes: buf.length, ...(info || { width: null, height: null, frames: null }) };
}

module.exports = { MIME, mimeFor, mediaInfo };
