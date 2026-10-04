'use strict';
// Quiet hours: a daily window (local time) when faces stay silent. Captions
// still show. The user owns this setting; agents only read it.

const DEFAULTS = Object.freeze({ enabled: true, start: '20:00', end: '08:00' });

/** Minutes since midnight for "HH:MM" (24-hour), or null if it isn't one. */
function minutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isValid(q) {
  return minutes(q.start) !== null && minutes(q.end) !== null;
}

/** True when `date` falls inside the window. `end` may be earlier than `start` (wraps past midnight). */
function isQuiet(q, date = new Date()) {
  const start = minutes(q.start);
  const end = minutes(q.end);
  if (!q.enabled || start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

module.exports = { DEFAULTS, minutes, isValid, isQuiet };
