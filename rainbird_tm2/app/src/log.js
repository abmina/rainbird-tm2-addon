'use strict';
const { EventEmitter } = require('events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger extends EventEmitter {
  constructor(level = 'info', size = 400) {
    super();
    this.level = LEVELS[level] ?? 20;
    this.size = size;
    this.lines = [];
  }
  _log(lvl, msg) {
    const entry = { ts: new Date().toISOString(), level: lvl, msg: String(msg) };
    if (LEVELS[lvl] >= 20 || this.level <= 10) {
      this.lines.push(entry);
      if (this.lines.length > this.size) this.lines.shift();
      this.emit('line', entry);
    }
    if (LEVELS[lvl] >= this.level) {
      const out = `${entry.ts.substr(11, 8)} ${lvl.toUpperCase().padEnd(5)} ${entry.msg}`;
      (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(out);
    }
  }
  debug(m) { this._log('debug', m); }
  info(m) { this._log('info', m); }
  warn(m) { this._log('warn', m); }
  error(m) { this._log('error', m); }
}

module.exports = { Logger };
