'use strict';
// A starter face, drawn by code: five simple states with a talking mouth
// and one chirp so `say hello` works straight away. Everything is generated
// when `init` runs — this repo ships no image or audio files.

const fs = require('fs');
const path = require('path');

const escapeXml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function faceSvg({ bg, fg, mouth }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs>
    <radialGradient id="shine" cx="50%" cy="35%" r="65%">
      <stop offset="0%" stop-color="white" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <polygon points="26,70 44,10 92,34" fill="${bg}" stroke="${fg}" stroke-width="4" stroke-linejoin="round"/>
  <polygon points="174,70 156,10 108,34" fill="${bg}" stroke="${fg}" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="100" cy="110" r="84" fill="${bg}" stroke="${fg}" stroke-width="4"/>
  <circle cx="100" cy="110" r="82" fill="url(#shine)"/>
  <text x="100" y="128" text-anchor="middle" font-family="monospace" font-size="44" font-weight="bold" fill="${fg}">${escapeXml(mouth)}</text>
</svg>
`;
}

// name, background, ink, closed mouth, open mouth
const STATES = [
  ['happy', '#ffd166', '#222222', '^_^', '^o^'],
  ['thinking', '#c1aaff', '#2b2055', '?_?', '?o?'],
  ['working', '#86efac', '#0f2b1a', '@_@', '@o@'],
  ['laugh', '#ffb4a2', '#3d1a1a', '>w<', '>O<'],
  ['sad', '#7ec4ff', '#0b2545', 'T_T', 'ToT'],
];

/** A short three-syllable chirp as 16-bit mono WAV bytes. */
function chirpWav() {
  const rate = 22050;
  const syllables = [
    [0.0, 0.16, 520],
    [0.22, 0.14, 660],
    [0.42, 0.24, 590],
  ];
  const samples = new Int16Array(Math.round(rate * 0.75));
  for (const [start, length, hz] of syllables) {
    const first = Math.round(start * rate);
    const count = Math.round(length * rate);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const envelope = Math.sin((Math.PI * i) / count); // fade in and out
      const tone = Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(2 * Math.PI * hz * 2 * t);
      samples[first + i] = Math.round(9000 * envelope * tone);
    }
  }
  return wav(samples, rate);
}

/** Wrap 16-bit mono samples in a WAV container. */
function wav(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Write the starter face into `faceDir`. Returns the files created. */
function createStarterFace(faceDir, name = 'My Face') {
  const created = [];
  const write = (rel, content) => {
    const file = path.join(faceDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    created.push(rel);
  };

  const states = {};
  for (const [state, bg, fg, closed, open] of STATES) {
    write(`${state}.svg`, faceSvg({ bg, fg, mouth: closed }));
    write(`mouth/${state}-open.svg`, faceSvg({ bg, fg, mouth: open }));
    states[state] = { file: `${state}.svg`, talk: `mouth/${state}-open.svg` };
  }
  write(
    'config.json',
    `${JSON.stringify(
      {
        name,
        description: 'Starter face: five simple states with a talking mouth. Replace it with your own art.',
        default_state: 'happy',
        states,
      },
      null,
      2,
    )}\n`,
  );
  write('voice/hello.wav', chirpWav());
  write(
    'voice/index.json',
    `${JSON.stringify({ clips: { hello: { file: 'hello.wav', text: 'Hello!' } } }, null, 2)}\n`,
  );
  return created;
}

module.exports = { createStarterFace, chirpWav, wav };
