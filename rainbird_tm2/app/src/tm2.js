'use strict';
// SIP command layer for the ESP-TM2 (and ESP-ME family) over the LNK tunnel.
// Command encodings follow pyrainbird's sipcommands.yaml / encode_command, and
// the ESP-TM2 quirks verified on model 010A fw 2.10 (Hubitat RainBird-LNK 1.0.2.9+).

const hex = (n, width) => n.toString(16).toUpperCase().padStart(width, '0');
const int = (s) => parseInt(s, 16);

class NackError extends Error {
  constructor(command, nakCode) {
    super(`Controller NACK for command ${command} (code ${nakCode})`);
    this.name = 'NackError';
    this.command = command;
    this.nakCode = nakCode;
  }
}

const MODELS = {
  '0003': { name: 'ESP-RZXe', programs: 0, starts: 6, stations: 8, family: 'lcr' },
  '0005': { name: 'ESP-TM2', programs: 3, starts: 4, stations: 12, family: 'tm2' },
  '0006': { name: 'ST8x-WiFi', programs: 0, starts: 6, stations: 8, family: 'lcr' },
  '0007': { name: 'ESP-Me', programs: 4, starts: 6, stations: 22, family: 'me' },
  '0008': { name: 'ST8x-WiFi2', programs: 0, starts: 6, stations: 8, family: 'lcr' },
  '0009': { name: 'ESP-ME3', programs: 4, starts: 6, stations: 22, family: 'me' },
  '000A': { name: 'ESP-TM2', programs: 3, starts: 4, stations: 12, family: 'tm2' },
  '010A': { name: 'ESP-TM2', programs: 3, starts: 4, stations: 12, family: 'tm2' },
  '0010': { name: 'ESP-Me2', programs: 4, starts: 6, stations: 22, family: 'me' },
  '0014': { name: 'TM2R', programs: 3, starts: 4, stations: 12, family: 'tm2' },
  '0015': { name: 'TRU', programs: 3, starts: 4, stations: 12, family: 'tm2' },
};

/** Bitmask string (as in BF / 83 responses) -> sorted list of 1-based zones. */
function maskToZones(mask) {
  const zones = [];
  for (let b = 0; b < mask.length / 2; b++) {
    const byte = int(mask.substr(b * 2, 2));
    for (let i = 0; i < 8; i++) if (byte & (1 << i)) zones.push(b * 8 + i + 1);
  }
  return zones;
}

class Tm2 {
  constructor(lnk, log) {
    this.lnk = lnk;
    this.log = log || { debug() {} };
    this.model = null;
  }

  /** Send a SIP frame; returns the response hex. Throws NackError on 00xx frames. */
  async sip(data, expect) {
    data = data.toUpperCase();
    const resp = await this.lnk.tunnelSip(data, data.length / 2);
    this.log.debug(`SIP ${data} -> ${resp}`);
    if (resp.startsWith('00') && resp.length >= 6) throw new NackError(data.substr(0, 2), resp.substr(4, 2));
    if (expect && !resp.startsWith(expect)) throw new Error(`Unexpected reply to ${data.substr(0, 2)}: ${resp}`);
    return resp;
  }

  // ---------------------------------------------------------------- identity
  async getModel() {
    const r = await this.sip('02', '82');
    const id = r.substr(2, 4);
    const info = MODELS[id] || { name: `Unknown (${id})`, programs: 3, starts: 4, stations: 12, family: 'unknown' };
    this.model = { id, ...info, protocol: `${int(r.substr(6, 2))}.${int(r.substr(8, 2))}` };
    return this.model;
  }
  async getSerial() {
    return (await this.sip('05', '85')).substr(2, 16);
  }
  async getFirmware() {
    const r = await this.sip('0B', '8B');
    return `${int(r.substr(2, 2))}.${int(r.substr(4, 2))}.${int(r.substr(6, 4))}`;
  }
  async getStations() {
    const r = await this.sip('0300', '83');
    return maskToZones(r.substr(4, 8));
  }
  async commandSupported(cmd) {
    const r = await this.sip('04' + cmd.toUpperCase(), '84');
    return int(r.substr(4, 2)) === 1;
  }
  getWifiParams() { return this.lnk.request('getWifiParams'); }
  getNetworkStatus() { return this.lnk.request('getNetworkStatus'); }

  // ---------------------------------------------------------------- clock
  async getTime() {
    const r = await this.sip('10', '90');
    return { hour: int(r.substr(2, 2)), minute: int(r.substr(4, 2)), second: int(r.substr(6, 2)) };
  }
  async getDate() {
    const r = await this.sip('12', '92');
    let year = int(r.substr(5, 3));
    if (year < 100) year += 2000;
    return { day: int(r.substr(2, 2)), month: int(r.substr(4, 1)), year };
  }
  /** w = wall-clock parts { year, month, day, hour, minute, second } in the controller's time zone. */
  async setDateTime(w) {
    await this.sip('11' + hex(w.hour, 2) + hex(w.minute, 2) + hex(w.second, 2), '01');
    await this.sip('13' + hex(w.day, 2) + hex(w.month, 1) + hex(w.year, 3), '01');
  }

  // ---------------------------------------------------------------- state
  async getRainDelay() { return int((await this.sip('36', 'B6')).substr(2, 4)); }
  async setRainDelay(days) {
    if (!(days >= 0 && days <= 14)) throw new RangeError('Rain delay must be 0-14 days');
    await this.sip('37' + hex(days, 4), '01');
  }
  async getRainSensor() { return int((await this.sip('3E', 'BE')).substr(2, 2)) !== 0; }
  async getActiveZones() { return maskToZones((await this.sip('3F00', 'BF')).substr(4, 8)); }
  async getIrrigationState() { return int((await this.sip('48', 'C8')).substr(2, 2)); }

  /** Combined state (0x4C). Returns null if the controller NACKs it. */
  async getCombinedState() {
    let r;
    try {
      r = await this.sip('4C', 'CC');
    } catch (e) {
      if (e instanceof NackError) return null;
      throw e;
    }
    if (r.length < 32) return null;
    let year = int(r.substr(11, 3));
    if (year < 100) year += 2000;
    let seasonal = int(r.substr(22, 4));
    if (seasonal === 0xffff || seasonal > 300) seasonal = null;
    return {
      time: { hour: int(r.substr(2, 2)), minute: int(r.substr(4, 2)), second: int(r.substr(6, 2)) },
      date: { day: int(r.substr(8, 2)), month: int(r.substr(10, 1)), year },
      rainDelay: int(r.substr(14, 4)),
      rainSensor: int(r.substr(18, 2)) !== 0,
      irrigationState: int(r.substr(20, 2)),
      seasonal,
      remainingSeconds: int(r.substr(26, 4)),
      activeZone: int(r.substr(30, 2)),
    };
  }

  // ---------------------------------------------------------------- control
  async runZone(zone, minutes) {
    if (!(Number.isInteger(zone) && zone >= 1 && zone <= 32)) throw new RangeError('Invalid zone');
    if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 255)) throw new RangeError('Manual run time must be 1-255 minutes');
    await this.sip('39' + hex(zone, 4) + hex(minutes, 2), '01');
  }
  async runProgram(index) {
    if (!(index >= 0 && index <= 3)) throw new RangeError('Invalid program');
    await this.sip('38' + hex(index, 2), '01');
  }
  async stop() { await this.sip('40', '01'); }
  async advance() { await this.sip('4200', '01'); }

  // ---------------------------------------------------------------- schedule pages
  /** Read one RetrieveSchedule (0x20) page; returns its data hex (after A0 PPPP). */
  async readPage(page) {
    const r = await this.sip('20' + hex(page, 4), 'A0' + hex(page, 4));
    return r.substr(6);
  }
  /** Write one page with SetSchedule (0x21); the layout is identical to what 0x20 returns. */
  async writePage(page, data) {
    data = data.toUpperCase();
    const r = await this.sip('21' + hex(page, 4) + data, '01');
    if (r.substr(0, 4) !== '0121') throw new Error(`Page ${hex(page, 4)} write not acknowledged (${r})`);
  }
}

module.exports = { Tm2, NackError, MODELS, maskToZones, hex };
