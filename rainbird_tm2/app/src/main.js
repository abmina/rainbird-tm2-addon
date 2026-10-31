'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Logger } = require('./log');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Controller } = require('./controller');
const { HaBridge } = require('./ha');
const { createServer } = require('./server');

/**
 * App holds the active controller + HA bridge and can swap them when the
 * connection is (re)configured from the web UI. The server listens on `hub`.
 */
class App {
  constructor(cfg, store, log) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.hub = new EventEmitter();
    this.ctl = null;
    this.ha = null;
    this.connFile = path.join(cfg.dataDir, 'connection.json');
  }

  /** Connection from the web setup (connection.json) wins over the add-on options. */
  connection() {
    try {
      const c = JSON.parse(fs.readFileSync(this.connFile, 'utf8'));
      if (c.host && c.password) return { ...c, source: 'web' };
    } catch {}
    if (this.cfg.host && this.cfg.password) return { host: this.cfg.host, password: this.cfg.password, scheme: this.cfg.scheme, port: this.cfg.port, source: 'options' };
    return null;
  }

  start() {
    const conn = this.connection();
    if (!conn) {
      this.log.warn('No controller configured yet - open the add-on web UI to find and set it up');
      this.hub.emit('state', this.setupState());
      return;
    }
    const cfg = { ...this.cfg, host: conn.host, password: conn.password, scheme: conn.scheme || this.cfg.scheme, port: conn.port || this.cfg.port };
    this.ctl = new Controller(cfg, this.store, this.log);
    this.ctl.source = conn.source;
    this.ctl.on('state', (s) => this.hub.emit('state', { ...s, setup: { configured: true, host: conn.host, source: conn.source } }));
    this.ha = new HaBridge(cfg, this.ctl, this.store, this.log);
    this.ha.start();
    this.ctl.start();
  }

  stop() {
    if (this.ctl) this.ctl.stop();
    if (this.ha) this.ha.stop();
    this.ctl = null;
    this.ha = null;
  }

  saveConnection(conn) {
    if (conn) fs.writeFileSync(this.connFile, JSON.stringify({ host: conn.host, password: conn.password, scheme: conn.scheme || 'auto', port: conn.port || undefined }, null, 2), { mode: 0o600 });
    else fs.rmSync(this.connFile, { force: true });
    this.log.info(conn ? `Controller set to ${conn.host} from the web UI` : 'Web setup cleared - using the add-on configuration');
    this.stop();
    this.start();
  }

  setupState() {
    const conn = this.connection();
    return { setup: { configured: !!conn, host: conn && conn.host, source: conn && conn.source }, connection: { online: false }, info: null, status: null, schedule: null, zones: [] };
  }

  snapshot() {
    if (!this.ctl) return this.setupState();
    return { ...this.ctl.snapshot(), setup: { configured: true, host: this.ctl.cfg.host, source: this.ctl.source } };
  }
}

async function main() {
  const log = new Logger(process.env.LOG_LEVEL || 'info');
  const cfg = await loadConfig(log);
  log.level = { debug: 10, info: 20, warn: 30, error: 40 }[cfg.logLevel] ?? 20;
  log.info(`Rain Bird ESP-TM2 add-on v${require('../package.json').version}`);

  const store = new Store(cfg.dataDir);
  const app = new App(cfg, store, log);
  const server = createServer(cfg, app, log);
  server.listen(cfg.httpPort, () => log.info(`Web UI listening on port ${cfg.httpPort}`));
  app.start();

  const shutdown = () => {
    log.info('Shutting down');
    app.stop();
    server.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
