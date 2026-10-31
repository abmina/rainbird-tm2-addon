'use strict';
// Owns the connection to the controller: polling, state, actions, schedule.
const { EventEmitter } = require('events');
const { LnkClient } = require('./lnk');
const { Tm2, NackError } = require('./tm2');
const { ScheduleManager, nextRun, describeProgram, PROGRAM_NAMES } = require('./schedule');
const { wallParts, wallToEpoch } = require('./time');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

class Controller extends EventEmitter {
  constructor(cfg, store, log) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.lnk = new LnkClient({ host: cfg.host, port: cfg.port || undefined, password: cfg.password, scheme: cfg.scheme || 'auto', minDelayMs: cfg.minDelayMs ?? 250, log });
    this.tm2 = new Tm2(this.lnk, log);
    this.schedule = null;
    this.combinedSupported = true;
    this.lastClockSync = 0;
    this.lastScheduleRead = 0;
    this.writing = false;
    this.state = {
      connection: { online: false, lastError: null },
      info: null,
      status: null,
      schedule: null,
      nextRun: null,
    };
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.running = true;
    this._loop();
  }
  stop() {
    this.running = false;
    clearTimeout(this._wake);
  }
  poke(ms = 1500) {
    clearTimeout(this._wake);
    if (this._sleepResolve) this._wake = setTimeout(this._sleepResolve, ms);
  }

  async _loop() {
    while (this.running) {
      try {
        if (!this.state.info) await this._identify();
        await this.pollStatus();
        this._setOnline(true);
        const idle = !this.state.status.watering;
        const due = Date.now() - this.lastScheduleRead > this.cfg.scheduleRefreshMinutes * 60000;
        if (!this.state.schedule || (idle && due)) await this.refreshSchedule();
        await this._maybeSyncClock();
        this._setOnline(true);
      } catch (e) {
        this._setOnline(false, e.message);
        if (e.auth) this.log.error(`${e.message}. Check the device password in the add-on configuration.`);
      }
      const wait = !this.state.connection.online
        ? Math.min(60, this.cfg.pollSeconds * 2) * 1000
        : (this.state.status && this.state.status.watering ? this.cfg.wateringPollSeconds : this.cfg.pollSeconds) * 1000;
      await new Promise((r) => {
        this._sleepResolve = r;
        this._wake = setTimeout(r, wait);
      });
      this._sleepResolve = null;
    }
  }

  _setOnline(online, err) {
    const c = this.state.connection;
    if (c.online !== online) this.log[online ? 'info' : 'warn'](online ? `Connected to controller at ${this.cfg.host}` : `Controller unreachable: ${err}`);
    c.online = online;
    c.scheme = this.lnk.scheme;
    c.lastError = online ? c.lastError : err;
    c.stats = this.lnk.stats;
    this._emit();
  }

  async _identify() {
    const model = await this.tm2.getModel();
    const info = { model: model.name, modelId: model.id, family: model.family, protocol: model.protocol };
    info.serial = await this.tm2.getSerial().catch(() => null);
    info.firmware = await this.tm2.getFirmware().catch(() => null);
    info.zones = await this.tm2.getStations();
    try { info.wifi = await this.tm2.getWifiParams(); } catch { info.wifi = null; }
    if (!['tm2', 'me'].includes(model.family)) this.log.warn(`${model.name} is not an ESP-TM2/ESP-Me family controller - schedule editing may not work`);
    const maxZone = Math.max(0, ...info.zones);
    this.schedule = new ScheduleManager(this.tm2, { log: this.log, maxZone: maxZone || model.stations });
    this.state.info = info;
    this.log.info(`Controller: ${info.model} (${info.modelId}), firmware ${info.firmware}, zones ${info.zones.join(', ')}, serial ${info.serial}`);
    this.emit('identified', info);
  }

  // ------------------------------------------------------------------ polling
  async pollStatus() {
    let st = null;
    if (this.combinedSupported) {
      st = await this.tm2.getCombinedState();
      if (!st) {
        this.combinedSupported = false;
        this.log.info('Controller does not support combined state (0x4C); using individual queries');
      }
    }
    if (!st) {
      const [time, date, rainDelay, rainSensor, active] = [await this.tm2.getTime(), await this.tm2.getDate(), await this.tm2.getRainDelay(), await this.tm2.getRainSensor(), await this.tm2.getActiveZones()];
      st = { time, date, rainDelay, rainSensor, activeZone: active[0] || 0, remainingSeconds: null, seasonal: null };
    } else if (st.activeZone === 0) {
      // Some firmware reports the zone only through 0x3F; double-check while the combined state says idle.
      const active = await this.tm2.getActiveZones().catch(() => []);
      if (active.length) st.activeZone = active[0];
    }
    const wall = { ...st.date, ...st.time };
    const ctrlEpoch = wallToEpoch(wall, this.cfg.timezone);
    const status = {
      watering: st.activeZone > 0,
      activeZone: st.activeZone,
      activeZoneName: st.activeZone ? this.store.zoneName(st.activeZone) : null,
      remainingSeconds: st.activeZone ? st.remainingSeconds : 0,
      rainDelay: st.rainDelay,
      rainSensor: st.rainSensor,
      controllerTime: `${st.date.year}-${pad(st.date.month)}-${pad(st.date.day)}T${pad(st.time.hour)}:${pad(st.time.minute)}:${pad(st.time.second)}`,
      clockDriftSeconds: Math.round((ctrlEpoch - Date.now()) / 1000),
      timezone: this.cfg.timezone,
      updatedAt: new Date().toISOString(),
    };
    const prev = this.state.status;
    if (prev && prev.activeZone !== status.activeZone) {
      this.log.info(status.activeZone ? `Watering ${status.activeZoneName}` : 'Watering finished');
    }
    this.state.status = status;
    this._ctrlWall = { utc: Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second), at: Date.now() };
    this._updateNextRun();
    this._emit();
    return status;
  }

  async refreshSchedule() {
    if (!this.schedule) return null;
    const s = await this.schedule.refresh();
    this.lastScheduleRead = Date.now();
    this._setSchedule(s);
    return this.state.schedule;
  }

  _setSchedule(s) {
    for (const p of s.programs) p.summary = describeProgram(p);
    this.state.schedule = s;
    this._updateNextRun();
    this._emit();
  }

  _updateNextRun() {
    const s = this.state.schedule;
    const st = this.state.status;
    if (!s || !st) return;
    // Work in the controller's own wall-clock time, then map back to a real instant:
    // the run happens (at - nowOnController) from now, whatever the controller's clock says.
    const elapsed = Date.now() - this._ctrlWall.at;
    const nowWall = new Date(this._ctrlWall.utc + elapsed);
    const nr = nextRun(s, nowWall, { rainDelay: st.rainDelay });
    this.state.nextRun = nr ? { program: nr.program, at: new Date(Date.now() + (nr.at - nowWall)).toISOString(), minutes: nr.minutes } : null;
  }

  async _maybeSyncClock() {
    if (!this.cfg.autoSyncClock || !this.state.status || this.cfg.timezoneSource === 'fallback') return;
    const drift = this.state.status.clockDriftSeconds;
    if (Math.abs(drift) < 90) return;
    if (Date.now() - this.lastClockSync < 6 * 3600 * 1000) return;
    // A difference of whole hours (or half hours) is far more likely a time zone mismatch than
    // clock drift. Never "fix" that automatically - ask the user to check and use Sync clock.
    const r = Math.abs(drift) % 1800;
    if (Math.abs(drift) >= 1700 && (r < 120 || r > 1680) && !this.cfg.timezoneExplicit) {
      if (!this._tzWarned) this.log.warn(`Controller clock differs by ${(drift / 3600).toFixed(1)} h from ${this.cfg.timezone} - looks like a time zone mismatch, so it was not synced automatically. Check the time on the controller; if it is wrong press "Sync clock", or set the "timezone" option.`);
      this._tzWarned = true;
      return;
    }
    this.log.info(`Controller clock is ${this.state.status.clockDriftSeconds}s off; syncing`);
    await this.syncClock();
  }

  _emit() {
    clearTimeout(this._emitT);
    this._emitT = setTimeout(() => this.emit('state', this.snapshot()), 50);
  }

  snapshot() {
    const zones = (this.state.info ? this.state.info.zones : []).map((z) => ({
      zone: z,
      name: this.store.zoneName(z),
      defaultMinutes: this.store.defaultMinutes(z, this.cfg.defaultRunMinutes),
      active: !!(this.state.status && this.state.status.activeZone === z),
    }));
    return { ...this.state, zones, programNames: PROGRAM_NAMES.slice(0, this.schedule && this.schedule.layout ? this.schedule.layout.programs : 3) };
  }

  // ------------------------------------------------------------------ actions
  _requireOnline() {
    if (!this.state.info) throw Object.assign(new Error('Controller not connected yet'), { status: 503 });
  }
  async _act(label, fn, { refresh = true } = {}) {
    this._requireOnline();
    this.log.info(label);
    try {
      const r = await fn();
      if (refresh) {
        await sleep(800);
        await this.pollStatus().catch(() => {});
      }
      return r;
    } catch (e) {
      if (e instanceof NackError) throw Object.assign(new Error(`Controller refused: ${label}`), { status: 409 });
      throw e;
    }
  }

  runZone(zone, minutes) {
    zone = Number(zone);
    minutes = Number(minutes) || this.store.defaultMinutes(zone, this.cfg.defaultRunMinutes);
    if (this.state.info && !this.state.info.zones.includes(zone)) throw Object.assign(new Error(`Zone ${zone} is not available`), { status: 400 });
    return this._act(`Run ${this.store.zoneName(zone)} for ${minutes} min`, () => this.tm2.runZone(zone, minutes));
  }
  runProgram(p) {
    const i = typeof p === 'string' ? PROGRAM_NAMES.indexOf(p.toUpperCase()) : Number(p);
    if (i < 0) throw Object.assign(new Error('Invalid program'), { status: 400 });
    return this._act(`Start program ${PROGRAM_NAMES[i]}`, () => this.tm2.runProgram(i));
  }
  stopAll() { return this._act('Stop all watering', () => this.tm2.stop()); }
  advance() { return this._act('Advance to next zone', () => this.tm2.advance()); }
  setRainDelay(days) { return this._act(`Set rain delay to ${days} day(s)`, () => this.tm2.setRainDelay(Number(days))); }
  async syncClock() {
    const w = wallParts(Date.now(), this.cfg.timezone);
    const label = `Set controller clock to ${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')} (${this.cfg.timezone})`;
    const r = await this._act(label, () => this.tm2.setDateTime(w));
    this._tzWarned = false;
    this.lastClockSync = Date.now();
    return r;
  }

  /** Schedule writes are queued so concurrent requests (UI + HA) run one after another. */
  _scheduleWrite(label, fn) {
    this._requireOnline();
    const run = () => this._doScheduleWrite(label, fn);
    const p = (this._writeQueue || Promise.resolve()).then(run, run);
    this._writeQueue = p.catch(() => {});
    return p;
  }

  async _doScheduleWrite(label, fn) {
    if (this.state.status && this.state.status.watering && !this.cfg.allowWritesWhileWatering) {
      throw Object.assign(new Error('Schedule changes are blocked while the controller is watering'), { status: 409 });
    }
    this.writing = true;
    this.log.info(label);
    try {
      const res = await fn();
      this.lastScheduleRead = Date.now();
      this._setSchedule(res.schedule);
      for (const l of res.log) this.log.info(`  ${l}`);
      return { log: res.log, schedule: this.state.schedule };
    } catch (e) {
      this.log.error(`${label} failed: ${e.message}`);
      if (e instanceof RangeError) e.status = 400;
      throw e;
    } finally {
      this.writing = false;
      this._emit();
    }
  }

  setProgram(p, prog) {
    const i = PROGRAM_NAMES.indexOf(String(p).toUpperCase());
    if (i < 0) throw Object.assign(new Error('Invalid program'), { status: 400 });
    return this._scheduleWrite(`Write program ${PROGRAM_NAMES[i]}`, () => this.schedule.setProgram(i, prog));
  }
  setSeasonal(p, percent) {
    return this.setProgram(p, { seasonal: Number(percent) });
  }
  setZoneRunTime(p, zone, minutes) {
    return this.setProgram(p, { runTimes: { [Number(zone)]: Number(minutes) } });
  }
  clearProgram(p) {
    const i = PROGRAM_NAMES.indexOf(String(p).toUpperCase());
    if (i < 0) throw Object.assign(new Error('Invalid program'), { status: 400 });
    return this._scheduleWrite(`Clear program ${PROGRAM_NAMES[i]}`, () => this.schedule.clearProgram(i));
  }
  setGlobal(g) { return this._scheduleWrite('Write controller settings', () => this.schedule.setGlobal(g)); }

  updateSettings(s) {
    this.store.update(s);
    if (this.state.status && this.state.status.activeZone) this.state.status.activeZoneName = this.store.zoneName(this.state.status.activeZone);
    this.emit('settings');
    this._emit();
  }

  async diagnostics({ scan = false } = {}) {
    this._requireOnline();
    const out = { info: this.state.info, connection: this.state.connection, combinedState: this.combinedSupported };
    if (scan) {
      const cmds = ['02', '03', '05', '0B', '10', '11', '12', '13', '20', '21', '30', '31', '36', '37', '38', '39', '3A', '3B', '3E', '3F', '40', '42', '48', '4A', '4B', '4C'];
      out.commandSupport = {};
      for (const c of cmds) {
        try { out.commandSupport[c] = await this.tm2.commandSupported(c); } catch (e) { out.commandSupport[c] = `? (${e.message})`; }
      }
    }
    out.schedulePages = this.schedule && this.schedule.pages
      ? Object.fromEntries(Object.entries(this.schedule.pages).map(([k, v]) => [Number(k).toString(16).padStart(4, '0').toUpperCase(), v]))
      : null;
    return out;
  }
}

module.exports = { Controller };
