'use strict';
// ESP-TM2 / ESP-ME program schedule: page layout, decode, encode, verified writes.
//
// Pages (RetrieveSchedule 0x20 -> A0, SetSchedule 0x21 writes the same layout):
//   0x0000          global:  stationDelay(2B, s) rainDelay(1B) rainSensor(1B: 00 on, 01 bypassed)
//   0x0010 + p      program: daysMask, cycleDays, daysRemaining, daysOffMask, seasonal%, frequency
//   0x0060 + p      start times: N x 2B minutes since midnight, FFFF = off
//   0x0080 + n      run times for zones 2n+1 and 2n+2: [zoneA: P1..Pk][zoneB: P1..Pk], 2B minutes
const { hex } = require('./tm2');

const FREQUENCIES = ['custom', 'cyclic', 'odd', 'even'];
const PROGRAM_NAMES = ['A', 'B', 'C', 'D'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const bytes = (h, w = 2) => {
  const out = [];
  for (let i = 0; i + w <= h.length; i += w) out.push(parseInt(h.substr(i, w), 16));
  return out;
};
const maskToDays = (m) => [0, 1, 2, 3, 4, 5, 6].filter((d) => m & (1 << d));
const daysToMask = (days) => days.reduce((m, d) => m | (1 << d), 0);
const fmtTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const parseTime = (s) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s).trim());
  if (!m) throw new RangeError(`Invalid start time "${s}" (use 24h HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

class ScheduleManager {
  constructor(tm2, { log, maxZone = 6 } = {}) {
    this.tm2 = tm2;
    this.log = log || { info() {}, warn() {}, debug() {} };
    this.maxZone = maxZone;
    this.layout = null; // { programs, pages[] }
    this.pages = null; // { [page]: dataHex }
    this.readAt = null;
  }

  async discoverLayout(expectedPrograms) {
    let programs = 0;
    for (let p = 0; p < 4; p++) {
      try {
        await this.tm2.readPage(0x10 | p);
        programs++;
      } catch (e) {
        break;
      }
      if (expectedPrograms && programs >= expectedPrograms) break;
    }
    if (!programs) throw new Error('Controller does not answer schedule page reads (0x20)');
    const pages = [0x00];
    for (let p = 0; p < programs; p++) pages.push(0x10 | p);
    for (let p = 0; p < programs; p++) pages.push(0x60 | p);
    for (let n = 0; n < Math.ceil(this.maxZone / 2); n++) pages.push(0x80 | n);
    this.layout = { programs, pages };
    return this.layout;
  }

  async readPages(pages = this.layout.pages) {
    const out = {};
    for (const p of pages) out[p] = await this.tm2.readPage(p);
    return out;
  }

  async refresh() {
    if (!this.layout) await this.discoverLayout(this.tm2.model && this.tm2.model.programs);
    this.pages = await this.readPages();
    this.readAt = new Date();
    return this.decode();
  }

  decode(pages = this.pages) {
    const { programs: np } = this.layout;
    const g = pages[0x00] || '';
    const global = g.length >= 8
      ? { stationDelaySeconds: parseInt(g.substr(0, 4), 16), rainDelay: parseInt(g.substr(4, 2), 16), rainSensorBypass: parseInt(g.substr(6, 2), 16) === 1 }
      : {};
    const programs = [];
    for (let p = 0; p < np; p++) {
      const f = bytes(pages[0x10 | p] || '');
      const starts = bytes(pages[0x60 | p] || '', 4).filter((v) => v < 1440).sort((a, b) => a - b);
      const slots = (pages[0x60 | p] || '').length / 4;
      const runTimes = {};
      for (let n = 0; n < Math.ceil(this.maxZone / 2); n++) {
        const v = bytes(pages[0x80 | n] || '', 4);
        const k = v.length / 2;
        for (let s = 0; s < 2; s++) {
          const zone = n * 2 + s + 1;
          if (zone <= this.maxZone && p < k) runTimes[zone] = v[s * k + p];
        }
      }
      programs.push({
        index: p,
        name: PROGRAM_NAMES[p],
        frequency: FREQUENCIES[f[5]] || `unknown(${f[5]})`,
        days: maskToDays(f[0] || 0),
        cycleDays: f[1] || 0,
        daysRemaining: f[2] || 0,
        daysOff: maskToDays(f[3] || 0),
        seasonal: f[4] ?? 100,
        starts: starts.map(fmtTime),
        startSlots: slots,
        runTimes,
      });
    }
    return { global, programs, zones: this.maxZone, readAt: this.readAt && this.readAt.toISOString() };
  }

  // ------------------------------------------------------------------ encode
  encodeProgram(p, prog, pages = this.pages) {
    const changes = {};
    const np = this.layout.programs;
    // Program info page: keep any trailing bytes we don't model.
    const infoPage = 0x10 | p;
    const old = pages[infoPage];
    const f = bytes(old.substr(0, 12));
    const freq = prog.frequency === undefined ? f[5] : FREQUENCIES.indexOf(prog.frequency);
    if (freq < 0 || freq > 3) throw new RangeError(`Frequency must be one of ${FREQUENCIES.join(', ')}`);
    f[5] = freq;
    if (prog.days !== undefined) f[0] = daysToMask(validDays(prog.days));
    if (freq === 1 && (prog.cycleDays !== undefined || prog.frequency !== undefined)) {
      const c = Number(prog.cycleDays ?? f[1]);
      const r = Number(prog.daysRemaining ?? 0);
      if (!(Number.isInteger(c) && c >= 1 && c <= 14)) throw new RangeError('Cycle must be 1-14 days');
      if (!(Number.isInteger(r) && r >= 0 && r < c)) throw new RangeError(`Days until next watering must be 0-${c - 1}`);
      f[1] = c;
      f[2] = r;
    }
    if (prog.daysOff !== undefined) f[3] = daysToMask(validDays(prog.daysOff));
    if (prog.seasonal !== undefined) {
      const s = Number(prog.seasonal);
      if (!(Number.isInteger(s) && s >= 0 && s <= 200)) throw new RangeError('Seasonal adjust must be 0-200%');
      f[4] = s;
    }
    changes[infoPage] = f.map((b) => hex(b, 2)).join('') + old.substr(12);

    // Start times page
    if (prog.starts !== undefined) {
      const startPage = 0x60 | p;
      const slots = pages[startPage].length / 4;
      const mins = [...new Set(prog.starts.filter((s) => s !== '' && s != null).map(parseTime))].sort((a, b) => a - b);
      if (mins.length > slots) throw new RangeError(`This controller allows at most ${slots} start times per program`);
      changes[startPage] = mins.concat(Array(slots - mins.length).fill(0xffff)).map((m) => hex(m, 4)).join('');
    }

    // Run time pages
    if (prog.runTimes) {
      for (let n = 0; n < Math.ceil(this.maxZone / 2); n++) {
        const page = 0x80 | n;
        const v = bytes(pages[page], 4);
        if (v.length !== 2 * np) throw new Error(`Unexpected run time page layout ${hex(page, 4)}: ${pages[page]}`);
        for (let s = 0; s < 2; s++) {
          const zone = n * 2 + s + 1;
          if (prog.runTimes[zone] === undefined) continue;
          const m = Number(prog.runTimes[zone]);
          if (!(Number.isInteger(m) && m >= 0 && m <= 360)) throw new RangeError(`Zone ${zone} run time must be 0-360 minutes`);
          v[s * np + p] = m;
        }
        changes[page] = v.map((m) => hex(m, 4)).join('');
      }
    }
    // Drop pages that do not actually change.
    for (const k of Object.keys(changes)) if (changes[k] === pages[k]) delete changes[k];
    return changes;
  }

  encodeGlobal(global, pages = this.pages) {
    const old = pages[0x00];
    let delay = parseInt(old.substr(0, 4), 16);
    let bypass = parseInt(old.substr(6, 2), 16);
    if (global.stationDelaySeconds !== undefined) {
      const d = Number(global.stationDelaySeconds);
      if (!(Number.isInteger(d) && d >= 0 && d <= 3600)) throw new RangeError('Station delay must be 0-3600 seconds');
      delay = d;
    }
    if (global.rainSensorBypass !== undefined) bypass = global.rainSensorBypass ? 1 : 0;
    const page = hex(delay, 4) + old.substr(4, 2) + hex(bypass, 2) + old.substr(8);
    return page === old ? {} : { 0: page };
  }

  // ------------------------------------------------------------------ verified writes
  /**
   * Write changed pages one at a time, reading each one back right after writing it.
   * Then read every schedule page once and check that the written pages kept their new value
   * and nothing else moved. On any mismatch all written pages are restored and an error is thrown.
   * Cost: one full read before, 2 requests per changed page, one full read after.
   */
  async apply(changes, label = 'schedule') {
    const log = [];
    const keys = Object.keys(changes).map(Number);
    if (!keys.length) return { log: [`${label}: no changes`], schedule: this.decode() };
    const fresh = this.pages && this.readAt && Date.now() - this.readAt.getTime() < 5000;
    const before = fresh ? { ...this.pages } : await this.readPages();
    const written = [];
    const rollback = async (why) => {
      this.log.warn(`${label}: ${why}; restoring ${written.map((p) => hex(p, 4)).join(', ') || 'nothing'}`);
      for (const p of written.slice().reverse()) {
        try { await this.tm2.writePage(p, before[p]); } catch (e) { this.log.warn(`Restore of ${hex(p, 4)} failed: ${e.message}`); }
      }
      this.pages = await this.readPages();
      this.readAt = new Date();
    };
    for (const page of keys) {
      const body = changes[page];
      if (before[page] === body) continue;
      if (body.length !== before[page].length) throw new Error(`Encoded page ${hex(page, 4)} has the wrong length`);
      await this.tm2.writePage(page, body);
      written.push(page);
      const back = await this.tm2.readPage(page);
      if (back !== body) {
        await rollback(`page ${hex(page, 4)} read back as ${back}, expected ${body}`);
        throw new Error(`Write verification failed for page ${hex(page, 4)} - change was rolled back`);
      }
      log.push(`page ${hex(page, 4)} written and verified`);
    }
    const after = await this.readPages();
    const expected = { ...before, ...Object.fromEntries(written.map((p) => [p, changes[p]])) };
    const bad = this.layout.pages.filter((p) => after[p] !== expected[p]);
    if (bad.length) {
      await rollback(`final check found unexpected content on page(s) ${bad.map((p) => hex(p, 4)).join(', ')}`);
      throw new Error(`Write verification failed (page ${bad.map((p) => hex(p, 4)).join(', ')}) - change was rolled back`);
    }
    this.pages = after;
    this.readAt = new Date();
    this.log.info(`${label}: ${log.length} page(s) written and verified`);
    return { log, schedule: this.decode() };
  }

  async setProgram(p, prog) {
    await this.refresh(); // always encode against fresh pages
    if (!(p >= 0 && p < this.layout.programs)) throw new RangeError('Invalid program');
    return this.apply(this.encodeProgram(p, prog), `Program ${PROGRAM_NAMES[p]}`);
  }

  async setGlobal(global) {
    await this.refresh();
    return this.apply(this.encodeGlobal(global), 'Controller settings');
  }

  async clearProgram(p) {
    await this.refresh();
    const runTimes = {};
    for (let z = 1; z <= this.maxZone; z++) runTimes[z] = 0;
    return this.apply(this.encodeProgram(p, { frequency: 'custom', days: [], starts: [], runTimes }), `Program ${PROGRAM_NAMES[p]} clear`);
  }
}

function validDays(days) {
  if (!Array.isArray(days)) throw new RangeError('days must be a list of 0-6 (Sun-Sat)');
  for (const d of days) if (!(Number.isInteger(d) && d >= 0 && d <= 6)) throw new RangeError(`Invalid day ${d}`);
  return days;
}

/**
 * Best-effort "next watering" from the decoded schedule.
 * now = the controller's wall-clock time encoded as a UTC Date (use getUTC*), so the
 * result does not depend on any time zone. Returns { program, at (same encoding), minutes }.
 */
function nextRun(schedule, now, { rainDelay = 0 } = {}) {
  let best = null;
  for (const prog of schedule.programs) {
    const total = Object.values(prog.runTimes).reduce((a, b) => a + b, 0);
    if (!total || !prog.starts.length) continue;
    const starts = prog.starts.map(parseTime);
    for (let d = 0; d < 60; d++) {
      if (d < rainDelay) continue;
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
      if (!runsOn(prog, day, d)) continue;
      for (const m of starts) {
        const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Math.floor(m / 60), m % 60));
        if (at <= now) continue;
        if (!best || at < best.at) best = { program: prog.name, at, minutes: Math.round((total * prog.seasonal) / 100) };
        break;
      }
      if (best && best.program === prog.name) break;
    }
  }
  return best;
}

function runsOn(prog, day, offset) {
  const dow = day.getUTCDay();
  const dom = day.getUTCDate();
  if (prog.daysOff.includes(dow)) return false;
  switch (prog.frequency) {
    case 'custom': return prog.days.includes(dow);
    case 'odd': return dom % 2 === 1 && dom !== 31 && !(day.getUTCMonth() === 1 && dom === 29);
    case 'even': return dom % 2 === 0;
    case 'cyclic': return prog.cycleDays > 0 && offset >= prog.daysRemaining && (offset - prog.daysRemaining) % prog.cycleDays === 0;
    default: return false;
  }
}

function describeProgram(prog) {
  const total = Object.values(prog.runTimes).reduce((a, b) => a + b, 0);
  if (!prog.starts.length || !total) return 'Not scheduled';
  let days;
  switch (prog.frequency) {
    case 'custom': days = prog.days.length === 7 ? 'Every day' : prog.days.map((d) => DAY_NAMES[d]).join(', ') || 'No days'; break;
    case 'cyclic': days = `Every ${prog.cycleDays} day${prog.cycleDays === 1 ? '' : 's'}`; break;
    case 'odd': days = 'Odd days'; break;
    case 'even': days = 'Even days'; break;
    default: days = prog.frequency;
  }
  return `${days} at ${prog.starts.join(', ')} · ${total} min`;
}

module.exports = { ScheduleManager, nextRun, describeProgram, FREQUENCIES, PROGRAM_NAMES, DAY_NAMES, parseTime, fmtTime };
