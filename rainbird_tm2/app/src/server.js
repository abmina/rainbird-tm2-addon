'use strict';
// Web UI + REST API, served through Home Assistant ingress (port 8099).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LnkClient } = require('./lnk');
const { Tm2 } = require('./tm2');
const { discover } = require('./discovery');

const WWW = path.join(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const INGRESS_IP = '172.30.32.2';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Connect once to a module and read its identity - used by the setup screen. */
async function probe(host, password, log, port) {
  const lnk = new LnkClient({ host, password, port, attempts: 2, timeoutMs: 6000, log });
  const tm2 = new Tm2(lnk, log);
  const model = await tm2.getModel();
  const zones = await tm2.getStations().catch(() => []);
  const serial = await tm2.getSerial().catch(() => null);
  return { host, scheme: lnk.scheme, model: model.name, modelId: model.id, family: model.family, zones, serial };
}

function createServer(cfg, app, log) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  app.hub.on('state', (s) => broadcast('state', s));
  log.on('line', (l) => broadcast('log', l));
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
  const ctl = () => {
    if (!app.ctl) throw Object.assign(new Error('No controller configured yet'), { status: 503 });
    return app.ctl;
  };
  const checkConn = (b) => {
    const host = String(b.host || '').trim();
    if (!IPV4.test(host)) throw Object.assign(new Error('Enter the controller IP address, e.g. 192.168.1.50'), { status: 400 });
    if (!b.password) throw Object.assign(new Error('Enter the device password from the Rain Bird app'), { status: 400 });
    return { host, password: String(b.password), port: Number(b.port) || undefined };
  };

  const routes = [
    ['GET', /^\/api\/state$/, () => app.snapshot()],
    ['GET', /^\/api\/log$/, () => log.lines],
    // setup
    ['POST', /^\/api\/setup\/discover$/, async () => {
      log.info('Scanning the network for Rain Bird WiFi modules');
      const found = await discover({ log });
      log.info(found.length ? `Found ${found.length} module(s): ${found.map((d) => d.ip).join(', ')}` : 'No modules answered the discovery broadcast');
      return { found };
    }],
    ['POST', /^\/api\/setup\/test$/, async (m, b) => {
      const c = checkConn(b);
      try {
        return await probe(c.host, c.password, log, c.port);
      } catch (e) {
        throw Object.assign(new Error(e.auth ? 'The module answered, but the password is wrong' : `Could not reach a Rain Bird module at ${c.host} (${e.message})`), { status: 400 });
      }
    }],
    ['POST', /^\/api\/setup$/, async (m, b) => {
      const c = checkConn(b);
      let found;
      try {
        found = await probe(c.host, c.password, log, c.port);
      } catch (e) {
        throw Object.assign(new Error(e.auth ? 'The module answered, but the password is wrong' : `Could not reach a Rain Bird module at ${c.host} (${e.message})`), { status: 400 });
      }
      app.saveConnection({ host: c.host, password: c.password, scheme: found.scheme, port: c.port });
      return found;
    }],
    ['DELETE', /^\/api\/setup$/, () => { app.saveConnection(null); return app.snapshot(); }],
    // controller
    ['POST', /^\/api\/zones\/(\d+)\/run$/, (m, b) => ctl().runZone(Number(m[1]), b.minutes)],
    ['POST', /^\/api\/stop$/, () => ctl().stopAll()],
    ['POST', /^\/api\/advance$/, () => ctl().advance()],
    ['POST', /^\/api\/programs\/([A-Da-d])\/run$/, (m) => ctl().runProgram(m[1])],
    ['PUT', /^\/api\/programs\/([A-Da-d])$/, (m, b) => ctl().setProgram(m[1], b)],
    ['POST', /^\/api\/programs\/([A-Da-d])\/clear$/, (m) => ctl().clearProgram(m[1])],
    ['POST', /^\/api\/rain-delay$/, (m, b) => ctl().setRainDelay(b.days)],
    ['PUT', /^\/api\/global$/, (m, b) => ctl().setGlobal(b)],
    ['POST', /^\/api\/clock\/sync$/, () => ctl().syncClock()],
    ['POST', /^\/api\/refresh$/, async () => { await ctl().refreshSchedule(); await ctl().pollStatus(); return app.snapshot(); }],
    ['PUT', /^\/api\/settings$/, (m, b) => { ctl().updateSettings(b); return app.snapshot(); }],
    ['GET', /^\/api\/diagnostics$/, (m, b, q) => ctl().diagnostics({ scan: q.get('scan') === '1' })],
  ];

  const server = http.createServer(async (req, res) => {
    const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (cfg.ingressOnly && remote !== INGRESS_IP && remote !== '127.0.0.1') {
      res.writeHead(403);
      return res.end('Only accessible through Home Assistant ingress');
    }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(app.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p.startsWith('/api/')) {
      const route = routes.find(([m, re]) => m === req.method && re.test(p));
      if (!route) return json(res, 404, { error: 'Not found' });
      try {
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const result = await route[2](route[1].exec(p), body, url.searchParams);
        return json(res, 200, result === undefined ? { ok: true } : result);
      } catch (e) {
        const code = e.status || (e instanceof RangeError ? 400 : e.auth ? 401 : 502);
        if (code >= 500 && code !== 503) log.warn(`${req.method} ${p}: ${e.message}`);
        return json(res, code, { error: e.message });
      }
    }

    // static files
    const file = path.normalize(path.join(WWW, p === '/' ? 'index.html' : p));
    if (!file.startsWith(WWW)) { res.writeHead(400); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  return server;
}

module.exports = { createServer };
