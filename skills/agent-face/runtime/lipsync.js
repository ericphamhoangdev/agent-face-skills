// Lip-sync maths, shared by the face window (loaded as a plain script) and
// by Node (the config loader and the tests). No DOM, no Node APIs.
//
// The mouth follows how loud the clip is, not which sound is being made:
// loudness is measured in short steps and mapped to "closed" or one of the
// state's open-mouth frames.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentFaceLipSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Thresholds are fractions of the clip's own loud level, so a quiet
  // recording moves the mouth as much as a loud one.
  const DEFAULTS = Object.freeze({
    /** How often the mouth can change, in ms. */
    step_ms: 40,
    /** Loudness that opens the mouth to the first talk frame. */
    open_at: 0.1,
    /** Loudness that opens it to the last (widest) frame. */
    wide_at: 0.45,
    /** Steps in a row on one open frame before it dips a notch. 0 = never dip. */
    hold_steps: 3,
  });

  /** About -46 dBFS: breaths and room noise don't open the mouth. */
  const SILENCE = 0.005;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

  /** Tuning with defaults filled in and out-of-range values pulled back. */
  function sane(tuning) {
    const t = tuning || {};
    const openAt = clamp(num(t.open_at, DEFAULTS.open_at), 0, 1);
    return {
      step_ms: Math.round(clamp(num(t.step_ms, DEFAULTS.step_ms), 20, 250)),
      open_at: openAt,
      wide_at: clamp(num(t.wide_at, DEFAULTS.wide_at), openAt, 1),
      hold_steps: Math.max(0, Math.round(num(t.hold_steps, DEFAULTS.hold_steps))),
    };
  }

  /** Loudness (RMS over every channel) of each `stepMs` slice of the audio. */
  function rmsPerStep(channels, sampleRate, stepMs) {
    const length = channels.length ? channels[0].length : 0;
    const perStep = Math.max(1, Math.floor((sampleRate * stepMs) / 1000));
    const out = [];
    for (let start = 0; start < length; start += perStep) {
      const end = Math.min(length, start + perStep);
      let sum = 0;
      for (const data of channels) {
        for (let i = start; i < end; i++) sum += data[i] * data[i];
      }
      out.push(Math.sqrt(sum / ((end - start) * channels.length)));
    }
    return out;
  }

  /**
   * Mouth openness per step: 0 = closed, 1..frames = increasingly open.
   * "Loud" is the clip's 90th-percentile step, so one spike doesn't flatten
   * the rest; thresholds spread from open_at to wide_at of that.
   */
  function levelsFromRms(rms, frames, tuning) {
    if (!frames || !rms.length) return rms.map(() => 0);
    const sorted = rms.slice().sort((a, b) => a - b);
    const loud = Math.max(sorted[Math.floor(((sorted.length - 1) * 9) / 10)], SILENCE);
    const span = tuning.wide_at - tuning.open_at;
    const threshold = (i) => tuning.open_at + (span * (i - 1)) / (Math.max(frames, 2) - 1);
    return rms.map((r) => {
      if (r < SILENCE) return 0;
      let level = 0;
      for (let i = 1; i <= frames; i++) if (r / loud >= threshold(i)) level++;
      return level;
    });
  }

  /**
   * A real mouth doesn't freeze open on a long vowel: after `hold` steps in
   * a row on the same open frame, close one notch for a step. In place.
   */
  function keepMoving(levels, hold) {
    if (!hold) return levels;
    let run = 0;
    for (let i = 1; i < levels.length; i++) {
      run = levels[i] !== 0 && levels[i] === levels[i - 1] ? run + 1 : 0;
      if (run >= hold) {
        levels[i] -= 1;
        run = 0;
      }
    }
    return levels;
  }

  /** The whole pipeline: decoded audio in, `{ step_ms, levels }` out. */
  function mouthLevels(channels, sampleRate, frames, tuning) {
    const t = sane(tuning);
    const levels = levelsFromRms(rmsPerStep(channels, sampleRate, t.step_ms), frames, t);
    return { step_ms: t.step_ms, levels: keepMoving(levels, t.hold_steps) };
  }

  return { DEFAULTS, SILENCE, sane, rmsPerStep, levelsFromRms, keepMoving, mouthLevels };
});
