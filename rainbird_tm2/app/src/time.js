'use strict';
// Time zone handling. The controller keeps local wall-clock time with no zone, so we
// must know the Home Assistant time zone explicitly - never rely on the container's TZ.
const http = require('http');

function isValidZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. */
function wallParts(epochMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

/** UTC offset of a time zone at an instant, in ms (e.g. -5h for CDT). */
function offsetMs(epochMs, tz) {
  const w = wallParts(epochMs, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(epochMs / 1000) * 1000;
}

/** Instant for a wall-clock time in a time zone (handles DST by iterating). */
function wallToEpoch({ year, month, day, hour, minute, second = 0 }, tz) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = target - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function supervisorTimezone() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: 'supervisor', path: '/info', headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(b).data.timezone || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

/** option -> Home Assistant (Supervisor) -> TZ env -> UTC. Returns { tz, source }. */
async function resolveTimezone(option, log) {
  const candidates = [
    [option, 'add-on option'],
    [await supervisorTimezone(), 'Home Assistant'],
    [process.env.TZ, 'TZ environment'],
  ];
  for (const [tz, source] of candidates) {
    if (!tz) continue;
    if (isValidZone(tz)) return { tz, source };
    log.warn(`Ignoring unknown time zone "${tz}" from ${source}`);
  }
  log.warn('Could not determine the Home Assistant time zone - assuming UTC and disabling automatic clock sync. Set the "timezone" option (e.g. America/Chicago).');
  return { tz: 'UTC', source: 'fallback' };
}

module.exports = { wallParts, wallToEpoch, offsetMs, resolveTimezone, isValidZone };
