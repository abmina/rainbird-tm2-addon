'use strict';
// Persistent add-on settings (zone names, default run times) in /data.
const fs = require('fs');
const path = require('path');

const DEFAULTS = { zoneNames: {}, defaultMinutes: {} };

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  zoneName(z) { return this.data.zoneNames[z] || `Zone ${z}`; }
  defaultMinutes(z, fallback = 10) { return Number(this.data.defaultMinutes[z]) || fallback; }
  update({ zoneNames, defaultMinutes }) {
    if (zoneNames) {
      for (const [z, n] of Object.entries(zoneNames)) {
        const name = String(n ?? '').trim().slice(0, 40);
        if (name) this.data.zoneNames[z] = name; else delete this.data.zoneNames[z];
      }
    }
    if (defaultMinutes) {
      for (const [z, m] of Object.entries(defaultMinutes)) {
        const v = Number(m);
        if (!(Number.isInteger(v) && v >= 1 && v <= 255)) throw new RangeError(`Zone ${z}: run time must be 1-255 minutes`);
        this.data.defaultMinutes[z] = v;
      }
    }
    this.save();
  }
}

module.exports = { Store };
