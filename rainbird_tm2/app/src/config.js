'use strict';
// Loads add-on options (/data/options.json) and the MQTT service from the Supervisor.
const fs = require('fs');
const http = require('http');
const { resolveTimezone } = require('./time');

const S6_ENV = '/run/s6/container_environment';
/** process.env, falling back to s6-overlay's saved container environment. */
function envVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const v = fs.readFileSync(`${S6_ENV}/${name}`, 'utf8').trim();
    if (v) process.env[name] = v;
    return v || undefined;
  } catch {
    return undefined;
  }
}

function readOptions(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(`${dataDir}/options.json`, 'utf8'));
  } catch {
    return {};
  }
}

function supervisorMqtt(log) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: 'supervisor', path: '/services/mqtt', headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const d = JSON.parse(body).data;
          if (!d || !d.host) return resolve(null);
          resolve({ host: d.host, port: d.port || 1883, username: d.username, password: d.password, ssl: !!d.ssl });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { log.warn(`Supervisor MQTT lookup failed: ${e.message}`); resolve(null); });
    req.on('response', (res) => { if (res.statusCode !== 200) log.warn(`Supervisor MQTT lookup: HTTP ${res.statusCode} (is the Mosquitto broker add-on installed?)`); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function loadConfig(log) {
  envVar('SUPERVISOR_TOKEN');
  envVar('TZ');
  if (!process.env.SUPERVISOR_TOKEN) log.warn('No Supervisor token - MQTT and time zone cannot be read from Home Assistant');
  const dataDir = process.env.DATA_DIR || '/data';
  const o = readOptions(dataDir);
  const env = process.env;
  const cfg = {
    dataDir,
    host: o.host || env.RAINBIRD_HOST,
    password: o.password || env.RAINBIRD_PASSWORD,
    port: Number(o.port || env.RAINBIRD_PORT) || 0,
    scheme: o.scheme || env.RAINBIRD_SCHEME || 'auto',
    pollSeconds: Number(o.poll_interval ?? env.POLL_SECONDS ?? 30),
    wateringPollSeconds: Number(o.watering_poll_interval ?? env.WATERING_POLL_SECONDS ?? 5),
    scheduleRefreshMinutes: Number(o.schedule_refresh_minutes ?? 30),
    defaultRunMinutes: Number(o.default_run_minutes ?? 10),
    autoSyncClock: o.auto_sync_clock ?? true,
    allowWritesWhileWatering: !!o.allow_writes_while_watering,
    minDelayMs: Number(o.request_spacing_ms ?? env.REQUEST_SPACING_MS ?? 250),
    deviceName: o.device_name || 'Rain Bird',
    baseTopic: o.mqtt_base_topic || 'rainbird_tm2',
    discoveryPrefix: o.discovery_prefix || 'homeassistant',
    logLevel: o.log_level || env.LOG_LEVEL || 'info',
    httpPort: Number(env.HTTP_PORT || 8099),
    ingressOnly: o.ingress_only ?? !!env.SUPERVISOR_TOKEN,
  };
  if (o.mqtt_host || env.MQTT_HOST) {
    cfg.mqtt = {
      host: o.mqtt_host || env.MQTT_HOST,
      port: Number(o.mqtt_port || env.MQTT_PORT || 1883),
      username: o.mqtt_username || env.MQTT_USERNAME,
      password: o.mqtt_password || env.MQTT_PASSWORD,
      ssl: !!o.mqtt_ssl,
    };
  } else {
    cfg.mqtt = await supervisorMqtt(log);
    if (cfg.mqtt) log.info(`Using MQTT broker from Home Assistant (${cfg.mqtt.host}:${cfg.mqtt.port})`);
  }
  const tz = await resolveTimezone(o.timezone || null, log);
  cfg.timezone = tz.tz;
  cfg.timezoneSource = tz.source;
  cfg.timezoneExplicit = tz.source === 'add-on option';
  log.info(`Controller time zone: ${tz.tz} (from ${tz.source})`);
  return cfg;
}

module.exports = { loadConfig };
