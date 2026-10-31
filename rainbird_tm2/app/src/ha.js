'use strict';
// Home Assistant bridge: MQTT discovery, state publishing and command handling.
const { MqttClient, topicMatches } = require('./mqtt');

const VERSION = require('../package.json').version;

class HaBridge {
  constructor(cfg, controller, store, log) {
    this.cfg = cfg;
    this.ctl = controller;
    this.store = store;
    this.log = log;
    this.prefix = cfg.discoveryPrefix || 'homeassistant';
    this.root = cfg.baseTopic || 'rainbird_tm2';
    this.published = new Set();
  }

  start() {
    if (!this.cfg.mqtt || !this.cfg.mqtt.host) {
      this.log.warn('No MQTT broker configured - Home Assistant entities are disabled (the web UI still works)');
      return;
    }
    const m = this.cfg.mqtt;
    // The bridge LWT topic is fixed so it is known before the serial number is.
    this.bridgeTopic = `${this.root}/bridge/state`;
    this.client = new MqttClient({
      host: m.host, port: m.port, username: m.username, password: m.password, ssl: m.ssl,
      clientId: `rainbird-tm2-${Math.random().toString(16).slice(2, 8)}`,
      will: { topic: this.bridgeTopic, payload: 'offline', retain: true },
      log: this.log,
    }).start();
    this.client.on('connect', () => {
      this.client.publish(this.bridgeTopic, 'online', { retain: true });
      this.client.subscribe(`${this.prefix}/status`);
      if (this.base) this._subscribeCommands();
      this.publishDiscovery();
      this.publishState(this.ctl.snapshot());
    });
    this.client.on('message', (t, p) => this._onMessage(t, p).catch((e) => this.log.warn(`MQTT command ${t} failed: ${e.message}`)));
    this.ctl.on('identified', (info) => {
      this.base = `${this.root}/${info.serial || 'controller'}`;
      if (this.client.connected) this._subscribeCommands();
      this.publishDiscovery();
    });
    this.ctl.on('state', (s) => this.publishState(s));
    this.ctl.on('settings', () => this.publishDiscovery());
  }

  stop() {
    if (this.client) {
      this.client.publish(this.bridgeTopic, 'offline', { retain: true });
      this.client.end();
    }
  }

  _subscribeCommands() {
    this.client.subscribe(`${this.base}/cmd/#`);
  }

  // ------------------------------------------------------------------ discovery
  _device() {
    const i = this.ctl.state.info;
    return {
      identifiers: [`rainbird_tm2_${i.serial || 'controller'}`],
      name: this.cfg.deviceName || 'Rain Bird',
      manufacturer: 'Rain Bird',
      model: `${i.model} (${i.modelId})`,
      sw_version: i.firmware || undefined,
      serial_number: i.serial || undefined,
    };
  }

  publishDiscovery() {
    if (!this.client || !this.client.connected || !this.ctl.state.info || !this.base) return;
    const info = this.ctl.state.info;
    const b = this.base;
    const id = (k) => `rbtm2_${info.serial || 'ctl'}_${k}`;
    const common = {
      device: this._device(),
      origin: { name: 'Rain Bird ESP-TM2 add-on', sw_version: VERSION },
      availability: [{ topic: this.bridgeTopic }, { topic: `${b}/availability` }],
      availability_mode: 'all',
      state_topic: `${b}/state`,
    };
    const entities = [];
    const add = (component, key, cfg) => entities.push([component, key, { ...common, unique_id: id(key), ...cfg }]);

    for (const z of info.zones) {
      const name = this.store.zoneName(z);
      add('switch', `zone_${z}`, {
        name, icon: 'mdi:sprinkler-variant',
        command_topic: `${b}/cmd/zone/${z}/set`,
        value_template: `{{ 'ON' if value_json.active_zone == ${z} else 'OFF' }}`,
      });
      add('number', `zone_${z}_duration`, {
        name: `${name} run time`, icon: 'mdi:timer-outline', entity_category: 'config',
        command_topic: `${b}/cmd/zone/${z}/duration/set`,
        value_template: `{{ value_json.durations['${z}'] }}`,
        min: 1, max: 255, step: 1, mode: 'box', unit_of_measurement: 'min',
      });
    }
    const programs = this.ctl.snapshot().programNames;
    for (const p of programs) {
      add('button', `program_${p}_run`, { name: `Start program ${p}`, icon: 'mdi:play-circle-outline', command_topic: `${b}/cmd/program/${p}/run`, state_topic: undefined });
      add('sensor', `program_${p}`, {
        name: `Program ${p}`, icon: 'mdi:calendar-clock',
        value_template: `{{ value_json.programs['${p}'].summary if value_json.programs and value_json.programs['${p}'] else None }}`,
        json_attributes_topic: `${b}/state`,
        json_attributes_template: `{{ (value_json.programs['${p}'] if value_json.programs else {}) | tojson }}`,
      });
      add('number', `program_${p}_seasonal`, {
        name: `Program ${p} seasonal adjust`, icon: 'mdi:percent', entity_category: 'config',
        command_topic: `${b}/cmd/program/${p}/seasonal/set`,
        value_template: `{{ value_json.programs['${p}'].seasonal if value_json.programs and value_json.programs['${p}'] else None }}`,
        min: 0, max: 200, step: 1, mode: 'box', unit_of_measurement: '%',
      });
    }
    add('button', 'stop', { name: 'Stop watering', icon: 'mdi:stop-circle-outline', command_topic: `${b}/cmd/stop`, state_topic: undefined });
    add('button', 'advance', { name: 'Next zone', icon: 'mdi:skip-next-circle-outline', command_topic: `${b}/cmd/advance`, state_topic: undefined });
    add('button', 'sync_clock', { name: 'Sync clock', icon: 'mdi:clock-check-outline', entity_category: 'config', command_topic: `${b}/cmd/sync_clock`, state_topic: undefined });
    add('button', 'refresh', { name: 'Refresh', icon: 'mdi:refresh', entity_category: 'diagnostic', command_topic: `${b}/cmd/refresh`, state_topic: undefined });
    add('number', 'rain_delay', {
      name: 'Rain delay', icon: 'mdi:weather-pouring', command_topic: `${b}/cmd/rain_delay/set`,
      value_template: '{{ value_json.rain_delay }}', min: 0, max: 14, step: 1, mode: 'box', unit_of_measurement: 'd',
    });
    add('switch', 'rain_sensor_bypass', {
      name: 'Rain sensor bypass', icon: 'mdi:weather-rainy', entity_category: 'config', command_topic: `${b}/cmd/rain_sensor_bypass/set`,
      value_template: "{{ 'ON' if value_json.rain_sensor_bypass else 'OFF' }}",
    });
    add('binary_sensor', 'rain_sensor', { name: 'Rain sensor', device_class: 'moisture', value_template: "{{ 'ON' if value_json.rain_sensor else 'OFF' }}" });
    add('binary_sensor', 'watering', { name: 'Watering', device_class: 'running', value_template: "{{ 'ON' if value_json.watering else 'OFF' }}" });
    add('sensor', 'active_zone', { name: 'Active zone', icon: 'mdi:sprinkler', value_template: "{{ value_json.active_zone_name or 'Idle' }}" });
    add('sensor', 'remaining', { name: 'Remaining time', device_class: 'duration', unit_of_measurement: 's', value_template: '{{ value_json.remaining_s }}' });
    add('sensor', 'next_run', { name: 'Next scheduled run', device_class: 'timestamp', value_template: '{{ value_json.next_run }}', json_attributes_topic: `${b}/state`, json_attributes_template: '{{ {"program": value_json.next_run_program, "minutes": value_json.next_run_minutes} | tojson }}' });
    add('sensor', 'clock_drift', { name: 'Clock drift', icon: 'mdi:clock-alert-outline', entity_category: 'diagnostic', device_class: 'duration', unit_of_measurement: 's', value_template: '{{ value_json.clock_drift_s }}' });
    add('binary_sensor', 'connected', {
      name: 'Controller connected', device_class: 'connectivity', entity_category: 'diagnostic',
      availability: [{ topic: this.bridgeTopic }], state_topic: `${b}/availability`, payload_on: 'online', payload_off: 'offline',
    });

    const now = new Set();
    for (const [component, key, cfg] of entities) {
      const topic = `${this.prefix}/${component}/rbtm2_${info.serial || 'ctl'}/${key}/config`;
      for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
      this.client.publish(topic, JSON.stringify(cfg), { retain: true });
      now.add(topic);
    }
    for (const t of this.published) if (!now.has(t)) this.client.publish(t, '', { retain: true }); // remove stale
    this.published = now;
    this.log.debug(`Published ${entities.length} discovery configs`);
  }

  // ------------------------------------------------------------------ state
  publishState(s) {
    if (!this.client || !this.client.connected || !this.base) return;
    const online = !!s.connection.online;
    this.client.publish(`${this.base}/availability`, online ? 'online' : 'offline', { retain: true });
    if (!s.status) return;
    const programs = {};
    if (s.schedule) {
      for (const p of s.schedule.programs) {
        programs[p.name] = { summary: p.summary, frequency: p.frequency, days: p.days, cycle_days: p.cycleDays, days_off: p.daysOff, seasonal: p.seasonal, starts: p.starts, run_times: p.runTimes };
      }
    }
    const payload = {
      online,
      watering: s.status.watering,
      active_zone: s.status.activeZone,
      active_zone_name: s.status.activeZoneName,
      remaining_s: s.status.remainingSeconds,
      rain_delay: s.status.rainDelay,
      rain_sensor: s.status.rainSensor,
      rain_sensor_bypass: s.schedule ? !!s.schedule.global.rainSensorBypass : null,
      controller_time: s.status.controllerTime,
      clock_drift_s: s.status.clockDriftSeconds,
      next_run: s.nextRun ? s.nextRun.at : null,
      next_run_program: s.nextRun ? s.nextRun.program : null,
      next_run_minutes: s.nextRun ? s.nextRun.minutes : null,
      durations: Object.fromEntries(s.zones.map((z) => [z.zone, z.defaultMinutes])),
      programs,
    };
    const json = JSON.stringify(payload);
    if (json === this._lastState) return;
    this._lastState = json;
    this.client.publish(`${this.base}/state`, json, { retain: true });
  }

  // ------------------------------------------------------------------ commands
  async _onMessage(topic, payload) {
    if (topic === `${this.prefix}/status`) {
      if (payload === 'online') {
        this.log.info('Home Assistant restarted - republishing discovery');
        setTimeout(() => { this.publishDiscovery(); this._lastState = null; this.publishState(this.ctl.snapshot()); }, 2000 + Math.random() * 3000);
      }
      return;
    }
    if (!this.base || !topic.startsWith(`${this.base}/cmd/`)) return;
    const cmd = topic.slice(this.base.length + 5);
    const p = payload.trim();
    let m;
    if ((m = /^zone\/(\d+)\/set$/.exec(cmd))) {
      if (p.toUpperCase() === 'ON') return this.ctl.runZone(Number(m[1]));
      if (p.toUpperCase() === 'OFF') {
        if (this.ctl.state.status && this.ctl.state.status.activeZone === Number(m[1])) return this.ctl.stopAll();
        return;
      }
      if (/^\d+$/.test(p)) return this.ctl.runZone(Number(m[1]), Number(p)); // payload = minutes
      return;
    }
    if ((m = /^zone\/(\d+)\/duration\/set$/.exec(cmd))) {
      this.ctl.updateSettings({ defaultMinutes: { [m[1]]: Math.round(Number(p)) } });
      return;
    }
    if ((m = /^program\/([A-D])\/run$/.exec(cmd))) return this.ctl.runProgram(m[1]);
    if ((m = /^program\/([A-D])\/seasonal\/set$/.exec(cmd))) return this.ctl.setSeasonal(m[1], Math.round(Number(p)));
    if (cmd === 'stop') return this.ctl.stopAll();
    if (cmd === 'advance') return this.ctl.advance();
    if (cmd === 'sync_clock') return this.ctl.syncClock();
    if (cmd === 'refresh') { await this.ctl.refreshSchedule(); return this.ctl.pollStatus(); }
    if (cmd === 'rain_delay/set') return this.ctl.setRainDelay(Math.round(Number(p)));
    if (cmd === 'rain_sensor_bypass/set') return this.ctl.setGlobal({ rainSensorBypass: p.toUpperCase() === 'ON' });
    if (cmd === 'json') return this._json(JSON.parse(p));
    this.log.debug(`Ignoring unknown command topic ${topic}`);
  }

  /** {"action": "run_zone", "zone": 2, "minutes": 5} etc. - handy from HA automations. */
  _json(c) {
    switch (c.action) {
      case 'run_zone': return this.ctl.runZone(Number(c.zone), Number(c.minutes) || undefined);
      case 'run_program': return this.ctl.runProgram(c.program);
      case 'stop': return this.ctl.stopAll();
      case 'advance': return this.ctl.advance();
      case 'rain_delay': return this.ctl.setRainDelay(Number(c.days));
      case 'set_program': return this.ctl.setProgram(c.program, c.schedule || {});
      case 'sync_clock': return this.ctl.syncClock();
      default: throw new Error(`Unknown action ${c.action}`);
    }
  }
}

module.exports = { HaBridge, topicMatches };
