'use strict';
// Tiny MQTT 3.1.1 broker for tests: QoS0, retained messages, wildcards, LWT.
const net = require('net');
const { topicMatches } = require('../src/mqtt');

const encLen = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; o.push(b); } while (n); return Buffer.from(o); };
const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const pub = (t, p, r) => { const body = Buffer.concat([str(t), Buffer.from(p)]); return Buffer.concat([Buffer.from([0x30 | (r ? 1 : 0)]), encLen(body.length), body]); };

class MiniBroker {
  constructor() {
    this.clients = new Set();
    this.retained = new Map();
    this.log = []; // [topic, payload, retain]
    this.server = net.createServer((s) => this._client(s));
  }
  listen() { return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r(this.server.address().port))); }
  close() { for (const c of this.clients) c.sock.destroy(); return new Promise((r) => this.server.close(() => r())); }

  publish(topic, payload, retain = false) {
    this.log.push([topic, payload, retain]);
    if (retain) { if (payload === '') this.retained.delete(topic); else this.retained.set(topic, payload); }
    for (const c of this.clients) if ([...c.subs].some((f) => topicMatches(f, topic))) c.sock.write(pub(topic, payload, false));
  }

  _client(sock) {
    const c = { sock, subs: new Set(), buf: Buffer.alloc(0), will: null };
    this.clients.add(c);
    sock.on('data', (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      for (;;) {
        if (c.buf.length < 2) return;
        let m = 1, len = 0, i = 1, b;
        do { if (i >= c.buf.length) return; b = c.buf[i++]; len += (b & 127) * m; m *= 128; } while (b & 128);
        if (c.buf.length < i + len) return;
        const type = c.buf[0], body = c.buf.subarray(i, i + len);
        c.buf = c.buf.subarray(i + len);
        this._packet(c, type, body);
      }
    });
    const gone = () => { if (!this.clients.delete(c)) return; if (c.will) this.publish(c.will.topic, c.will.payload, c.will.retain); };
    sock.on('close', gone);
    sock.on('error', () => {});
  }

  _packet(c, type, body) {
    const kind = type >> 4;
    if (kind === 1) { // CONNECT
      let o = 2 + body.readUInt16BE(0); // protocol name
      o += 1; const flags = body[o++]; o += 2;
      const rd = () => { const l = body.readUInt16BE(o); const s = body.subarray(o + 2, o + 2 + l).toString(); o += 2 + l; return s; };
      c.id = rd();
      if (flags & 4) c.will = { topic: rd(), payload: rd(), retain: !!(flags & 0x20) };
      c.sock.write(Buffer.from([0x20, 2, 0, 0]));
    } else if (kind === 3) { // PUBLISH
      const tl = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + tl).toString();
      const qos = (type >> 1) & 3;
      const payload = body.subarray(2 + tl + (qos ? 2 : 0)).toString();
      this.publish(topic, payload, !!(type & 1));
    } else if (kind === 8) { // SUBSCRIBE
      const id = body.readUInt16BE(0);
      let o = 2; const granted = [];
      while (o < body.length) {
        const l = body.readUInt16BE(o); const f = body.subarray(o + 2, o + 2 + l).toString(); o += 3 + l;
        c.subs.add(f); granted.push(0);
        for (const [t, p] of this.retained) if (topicMatches(f, t)) c.sock.write(pub(t, p, true));
      }
      c.sock.write(Buffer.concat([Buffer.from([0x90, 2 + granted.length, id >> 8, id & 255]), Buffer.from(granted)]));
    } else if (kind === 12) {
      c.sock.write(Buffer.from([0xd0, 0]));
    } else if (kind === 14) {
      c.will = null; c.sock.end();
    }
  }
}

module.exports = { MiniBroker };
