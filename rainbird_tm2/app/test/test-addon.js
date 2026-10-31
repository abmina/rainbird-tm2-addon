'use strict';
// End-to-end: real add-on process + mock controller + test MQTT broker.
const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { MockTm2 } = require('./mock-tm2');
const { MiniBroker } = require('./mini-broker');

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
  const mock = new MockTm2({ password: 'secret', busyEvery: 11 });
  const mockPort = await mock.listen();
  const broker = new MiniBroker();
  const mqttPort = await broker.listen();
  const httpPort = 18000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbtm2-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ device_name: 'Back yard' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], {
    env: { ...process.env, DATA_DIR: dataDir, RAINBIRD_HOST: '127.0.0.1', RAINBIRD_PORT: String(mockPort), RAINBIRD_PASSWORD: 'secret', MQTT_HOST: '127.0.0.1', MQTT_PORT: String(mqttPort), HTTP_PORT: String(httpPort), POLL_SECONDS: '2', WATERING_POLL_SECONDS: '1', REQUEST_SPACING_MS: '5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: httpPort, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: b && (res.headers['content-type'] || '').includes('json') ? JSON.parse(b) : b }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end(data);
  });
  const state = async () => (await req('GET', '/api/state')).body;
  const retained = (t) => broker.retained.get(t);

  try {
    // controller identified, schedule read
    const s = await until(async () => { const st = await state(); return st.schedule && st.status && st; }, 20000, 'controller + schedule');
    assert.equal(s.info.modelId, '010A');
    assert.deepEqual(s.zones.map((z) => z.zone), [1, 2, 3, 4, 5, 6]);
    assert.equal(s.schedule.programs[0].summary, 'Mon, Wed, Fri at 06:00 · 53 min');
    assert.ok(s.nextRun && s.nextRun.program, 'next run computed');

    // static UI
    const page = await req('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Rain Bird<\/title>/);
    assert.equal((await req('GET', '/app.js')).status, 200);
    assert.equal((await req('GET', '/../src/main.js')).status, 404);

    // MQTT discovery
    const serial = s.info.serial;
    const zoneCfgTopic = `homeassistant/switch/rbtm2_${serial}/zone_2/config`;
    await until(() => retained(zoneCfgTopic), 10000, 'discovery');
    const zcfg = JSON.parse(retained(zoneCfgTopic));
    assert.equal(zcfg.name, 'Zone 2');
    assert.equal(zcfg.device.name, 'Back yard');
    assert.equal(zcfg.command_topic, `rainbird_tm2/${serial}/cmd/zone/2/set`);
    const configs = [...broker.retained.keys()].filter((t) => t.startsWith('homeassistant/') && t.endsWith('/config'));
    assert.ok(configs.length >= 30, `expected >=30 entities, got ${configs.length}`);
    assert.equal(retained('rainbird_tm2/bridge/state'), 'online');
    await until(() => retained(`rainbird_tm2/${serial}/availability`) === 'online', 10000, 'availability online');
    const st0 = await until(() => { const v = retained(`rainbird_tm2/${serial}/state`); const j = v && JSON.parse(v); return j && j.programs.A && j; }, 10000, 'state topic with programs');
    assert.equal(st0.watering, false);
    assert.equal(st0.programs.A.starts[0], '06:00');

    // MQTT command -> controller
    broker.publish(`rainbird_tm2/${serial}/cmd/zone/2/set`, 'ON');
    await until(() => mock.active === 2, 10000, 'zone 2 running');
    await until(() => JSON.parse(retained(`rainbird_tm2/${serial}/state`)).active_zone === 2, 10000, 'state shows zone 2');
    // schedule writes are refused while watering
    const blocked = await req('PUT', '/api/programs/C', { frequency: 'even' });
    assert.equal(blocked.status, 409);
    broker.publish(`rainbird_tm2/${serial}/cmd/stop`, 'PRESS');
    await until(() => mock.active === 0, 10000, 'stopped');

    // MQTT rain delay + json command
    broker.publish(`rainbird_tm2/${serial}/cmd/rain_delay/set`, '2');
    await until(() => mock.rainDelay === 2, 10000, 'rain delay');
    broker.publish(`rainbird_tm2/${serial}/cmd/json`, JSON.stringify({ action: 'run_zone', zone: 4, minutes: 3 }));
    await until(() => mock.active === 4, 10000, 'json run_zone');
    assert.equal(mock.queue[0].seconds <= 180, true);

    // REST
    let r = await req('POST', '/api/stop');
    assert.equal(r.status, 200);
    r = await req('POST', '/api/zones/9/run', { minutes: 5 });
    assert.equal(r.status, 400, 'unknown zone rejected');
    r = await req('POST', '/api/rain-delay', { days: 0 });
    assert.equal(mock.rainDelay, 0);

    // schedule write through the API
    r = await req('PUT', '/api/programs/C', { frequency: 'custom', days: [2, 4], starts: ['07:45'], seasonal: 90, runTimes: { 1: 4, 6: 6 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.schedule.programs[2].summary, 'Tue, Thu at 07:45 · 10 min');
    assert.equal(mock.pages[0x62].slice(0, 4), (465).toString(16).toUpperCase().padStart(4, '0'));
    r = await req('PUT', '/api/programs/C', { frequency: 'cyclic', cycleDays: 2, daysRemaining: 5 });
    assert.equal(r.status, 400);
    // seasonal via MQTT
    broker.publish(`rainbird_tm2/${serial}/cmd/program/A/seasonal/set`, '150');
    await until(() => mock.pages[0x10].slice(8, 10) === '96', 15000, 'seasonal written');

    // global: rain sensor bypass via MQTT
    broker.publish(`rainbird_tm2/${serial}/cmd/rain_sensor_bypass/set`, 'ON');
    await until(() => mock.pages[0x00].slice(6, 8) === '01', 15000, 'bypass');
    await until(async () => (await state()).schedule.global.rainSensorBypass === true, 10000, 'bypass in state');

    // zone names -> rediscovery
    r = await req('PUT', '/api/settings', { zoneNames: { 2: 'Front lawn' }, defaultMinutes: { 2: 12 } });
    assert.equal(r.status, 200);
    await until(() => JSON.parse(retained(zoneCfgTopic)).name === 'Front lawn', 10000, 'renamed entity');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'))).zoneNames['2'], 'Front lawn');
    broker.publish(`rainbird_tm2/${serial}/cmd/zone/2/set`, 'ON');
    await until(() => mock.active === 2 && mock.queue[0].seconds > 600, 10000, 'default 12 min used');
    await req('POST', '/api/stop');

    // clock sync
    mock.clockOffset = 2 * 3600 * 1000;
    r = await req('POST', '/api/clock/sync');
    assert.equal(r.status, 200);
    assert.ok(Math.abs(mock.clockOffset) < 3000, 'clock synced');

    // diagnostics
    r = await req('GET', '/api/diagnostics?scan=1');
    assert.equal(r.body.commandSupport['4C'], true);

    // SSE
    const sse = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: httpPort, path: '/api/events' }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; if (b.includes('\n\n')) { res.destroy(); resolve(b); } });
      }).on('error', reject);
    });
    assert.match(sse, /^event: state\ndata: \{/);

    // HA restart -> discovery republished
    const before = broker.log.length;
    broker.publish('homeassistant/status', 'online');
    await until(() => broker.log.slice(before).some(([t]) => t === zoneCfgTopic), 10000, 'republish on HA birth');

    // controller goes away -> availability offline
    await mock.close();
    await until(() => retained(`rainbird_tm2/${serial}/availability`) === 'offline', 30000, 'offline availability');

    console.log(`add-on end-to-end tests passed (${configs.length} HA entities, ${mock.requests} controller requests)`);
  } catch (e) {
    console.error('--- add-on output ---\n' + out.slice(-4000));
    throw e;
  } finally {
    child.kill('SIGTERM');
    await sleep(700);
    await broker.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
