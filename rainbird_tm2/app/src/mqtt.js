'use strict';
// Minimal MQTT 3.1.1 client (no dependencies): connect/auth, last will,
// QoS 0 publish (retained), QoS 0 subscribe with wildcards, keepalive,
// automatic reconnect with backoff. Enough for Home Assistant discovery.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const encLen = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const packet = (type, body) => Buffer.concat([Buffer.from([type]), encLen(body.length), body]);

function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

class MqttClient extends EventEmitter {
  constructor({ host, port = 1883, username, password, clientId, ssl = false, keepalive = 30, will, log }) {
    super();
    Object.assign(this, { host, port, username, password, ssl, keepalive, will });
    this.clientId = clientId || `rainbird-tm2-${Math.random().toString(16).slice(2, 8)}`;
    this.log = log || { info() {}, warn() {}, debug() {} };
    this.connected = false;
    this.subs = new Set();
    this.pid = 1;
    this.backoff = 1000;
    this.closed = false;
  }

  start() {
    this._connect();
    return this;
  }

  _connect() {
    if (this.closed) return;
    const opts = { host: this.host, port: this.port };
    const sock = this.ssl ? tls.connect({ ...opts, rejectUnauthorized: false }) : net.connect(opts);
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on(this.ssl ? 'secureConnect' : 'connect', () => sock.write(this._connectPacket()));
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this.log.warn(`MQTT ${this.host}:${this.port}: ${e.message}`));
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this.pinger);
      if (was) this.emit('offline');
      if (this.closed) return;
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  _connectPacket() {
    let flags = 0x02; // clean session
    const payload = [str(this.clientId)];
    if (this.will) {
      flags |= 0x04 | (this.will.retain ? 0x20 : 0);
      payload.push(str(this.will.topic), str(this.will.payload));
    }
    if (this.username) {
      flags |= 0x80;
      payload.push(str(this.username));
      if (this.password) {
        flags |= 0x40;
        payload.push(str(this.password));
      }
    }
    const ka = Buffer.alloc(2);
    ka.writeUInt16BE(this.keepalive);
    return packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, ...payload]));
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        b = this.buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128);
      if (this.buf.length < i + len) return;
      const type = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this._onPacket(type, body);
    }
  }

  _onPacket(type, body) {
    switch (type >> 4) {
      case 2: // CONNACK
        if (body[1] !== 0) {
          this.log.warn(`MQTT connection refused (code ${body[1]}${body[1] === 5 ? ': not authorised' : ''})`);
          this.sock.destroy();
          return;
        }
        this.connected = true;
        this.backoff = 1000;
        this.pinger = setInterval(() => this.sock.write(Buffer.from([0xc0, 0])), (this.keepalive * 1000) / 2);
        for (const t of this.subs) this._sendSubscribe(t);
        this.log.info(`MQTT connected to ${this.host}:${this.port}`);
        this.emit('connect');
        break;
      case 3: { // PUBLISH
        const qos = (type >> 1) & 3;
        const tl = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tl).toString('utf8');
        let off = 2 + tl;
        if (qos > 0) {
          const id = body.readUInt16BE(off);
          off += 2;
          this.sock.write(Buffer.from([0x40, 2, id >> 8, id & 0xff])); // PUBACK
        }
        this.emit('message', topic, body.subarray(off).toString('utf8'));
        break;
      }
      default: // SUBACK, PINGRESP, PUBACK
        break;
    }
  }

  _sendSubscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.pid = (this.pid % 65535) + 1);
    this.sock.write(packet(0x82, Buffer.concat([id, str(topic), Buffer.from([0])])));
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.connected) this._sendSubscribe(topic);
  }

  publish(topic, payload, { retain = false } = {}) {
    if (!this.connected) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    this.sock.write(packet(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), data])));
    return true;
  }

  end() {
    this.closed = true;
    clearInterval(this.pinger);
    if (this.sock) {
      if (this.connected) this.sock.write(Buffer.from([0xe0, 0]));
      this.sock.end();
    }
  }
}

module.exports = { MqttClient, topicMatches };
