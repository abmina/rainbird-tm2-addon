'use strict';
// Setup flow: add-on starts unconfigured, discovers the module, rejects a bad password, connects.
const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { MockTm2 } = require('./mock-tm2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function main() {
  const mock = new MockTm2({ password: 'secret' });
  const port = await mock.listen();
  const udpPort = await mock.listenDiscovery();
  const httpPort = 19000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsetup-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], {
    env: { ...process.env, DATA_DIR: dataDir, HTTP_PORT: String(httpPort), DISCOVERY_TARGETS: `127.0.0.1:${udpPort}`, POLL_SECONDS: '2', REQUEST_SPACING_MS: '5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: httpPort, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(data);
  });
  try {
    const s0 = await until(async () => (await req('GET', '/api/state')).body, 10000, 'server up');
    assert.equal(s0.setup.configured, false);
    assert.equal((await req('POST', '/api/stop')).status, 503);

    const d = await req('POST', '/api/setup/discover');
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.found, [{ ip: '127.0.0.1', mac: 'fc:b4:67:60:44:0c' }]);

    let r = await req('POST', '/api/setup/test', { host: '127.0.0.1', port, password: 'wrong' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /password is wrong/);
    r = await req('POST', '/api/setup', { host: 'not-an-ip', password: 'x' });
    assert.equal(r.status, 400);
    r = await req('POST', '/api/setup/test', { host: '127.0.0.1', port, password: 'secret' });
    assert.equal(r.body.modelId, '010A');
    r = await req('POST', '/api/setup', { host: '127.0.0.1', port, password: 'secret' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'connection.json'))).host, '127.0.0.1');

    const s1 = await until(async () => { const s = (await req('GET', '/api/state')).body; return s.schedule && s; }, 15000, 'connected');
    assert.equal(s1.setup.source, 'web');
    assert.equal(s1.connection.online, true);
    assert.equal((await req('POST', '/api/zones/1/run', { minutes: 2 })).status, 200);
    assert.equal(mock.active, 1);

    r = await req('DELETE', '/api/setup');
    assert.equal(r.body.setup.configured, false);
    console.log('setup flow tests passed');
  } catch (e) {
    console.error('--- add-on output ---\n' + out.slice(-3000));
    throw e;
  } finally {
    child.kill('SIGTERM');
    await sleep(600);
    await mock.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
