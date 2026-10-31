'use strict';
// A simulated ESP-TM2 (model 010A) behind an LNK module, speaking the same
// encrypted JSON-RPC / tunnelSip protocol. Used by the test suite and for
// trying the add-on UI without real hardware:  node test/mock-tm2.js [port]
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encrypt, decrypt } = require('../src/crypto');

const h = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocktm2-'));
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'crt.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=fw-cc20.rainbird.com'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

class MockTm2 {
  constructor({ password = 'secret', zones = 6, tls = true, busyEvery = 0, combined = true } = {}) {
    this.password = password;
    this.tls = tls;
    this.busyEvery = busyEvery; // return HTTP 503 every Nth request
    this.combined = combined; // answer 0x4C
    this.requests = 0;
    this.sipLog = [];
    this.clockOffset = 0;
    this.rainDelay = 0;
    this.rainSensor = false;
    this.mask = (1 << zones) - 1;
    this.queue = []; // [{zone, seconds, program}]
    this.pages = {
      0x00: '0000' + '00' + '00',
      0x10: '2A' + '00' + '00' + '00' + '64' + '00', // A: Mon/Wed/Fri, 100%
      0x11: '00' + '03' + '01' + '00' + '50' + '01', // B: every 3 days, next in 1, 80%
      0x12: '00' + '00' + '00' + '00' + '64' + '00', // C: empty
      0x60: h(360, 4) + 'FFFF' + 'FFFF' + 'FFFF', // A starts 06:00
      0x61: h(1290, 4) + 'FFFF' + 'FFFF' + 'FFFF', // B starts 21:30
      0x62: 'FFFF'.repeat(4),
    };
    // run times: page 0x80+n = [zone 2n+1: A B C][zone 2n+2: A B C]
    const rt = { 1: [10, 0, 0], 2: [15, 0, 0], 3: [8, 5, 0], 4: [8, 5, 0], 5: [0, 20, 0], 6: [12, 0, 0] };
    for (let n = 0; n < 6; n++) {
      const a = rt[n * 2 + 1] || [0, 0, 0];
      const b = rt[n * 2 + 2] || [0, 0, 0];
      this.pages[0x80 | n] = a.concat(b).map((v) => h(v, 4)).join('');
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  now() { return new Date(Date.now() + this.clockOffset); }
  tick() {
    if (!this.queue.length) return;
    this.queue[0].seconds--;
    if (this.queue[0].seconds <= 0) this.queue.shift();
  }
  get active() { return this.queue.length ? this.queue[0].zone : 0; }

  sip(d) {
    const cmd = d.substr(0, 2);
    const ack = '01' + cmd;
    const nack = (code = '02') => '00' + cmd + code;
    const n = this.now();
    switch (cmd) {
      case '02': return '82010A020A';
      case '05': return '85' + '30C8A1F2E0040000';
      case '0B': return '8B020A0000';
      case '03': return '8300' + h(this.mask, 2) + '000000';
      case '04': return '84' + d.substr(2, 2) + (['4C', '20', '21', '39', '38', '40', '42', '36', '37', '3E', '3F', '48'].includes(d.substr(2, 2)) ? '01' : '00');
      case '10': return '90' + h(n.getHours(), 2) + h(n.getMinutes(), 2) + h(n.getSeconds(), 2);
      case '12': return '92' + h(n.getDate(), 2) + h(n.getMonth() + 1, 1) + h(n.getFullYear(), 3);
      case '11': {
        const t = new Date(n); t.setHours(parseInt(d.substr(2, 2), 16), parseInt(d.substr(4, 2), 16), parseInt(d.substr(6, 2), 16));
        this.clockOffset += t - n; return ack;
      }
      case '13': {
        const t = new Date(n); t.setFullYear(parseInt(d.substr(5, 3), 16), parseInt(d.substr(4, 1), 16) - 1, parseInt(d.substr(2, 2), 16));
        this.clockOffset += t - n; return ack;
      }
      case '36': return 'B6' + h(this.rainDelay, 4);
      case '37': { const v = parseInt(d.substr(2, 4), 16); if (v > 14) return nack(); this.rainDelay = v; return ack; }
      case '3E': return 'BE' + (this.rainSensor ? '01' : '00');
      case '3F': return 'BF00' + h(this.active ? 1 << (this.active - 1) : 0, 2) + '000000';
      case '48': return 'C801';
      case '4C': {
        if (!this.combined) return nack('00');
        const rem = this.queue.length ? this.queue[0].seconds : 0;
        return 'CC' + h(n.getHours(), 2) + h(n.getMinutes(), 2) + h(n.getSeconds(), 2) + h(n.getDate(), 2) + h(n.getMonth() + 1, 1) + h(n.getFullYear(), 3)
          + h(this.rainDelay, 4) + (this.rainSensor ? '01' : '00') + '01' + h(100, 4) + h(rem, 4) + h(this.active, 2);
      }
      case '39': {
        const zone = parseInt(d.substr(2, 4), 16); const min = parseInt(d.substr(6, 2), 16);
        if (!(this.mask & (1 << (zone - 1))) || !min) return nack();
        this.queue = [{ zone, seconds: min * 60 }]; return ack;
      }
      case '38': {
        const p = parseInt(d.substr(2, 2), 16);
        const q = [];
        for (let z = 1; z <= 6; z++) {
          const v = this.pages[0x80 | ((z - 1) >> 1)];
          const m = parseInt(v.substr((((z - 1) % 2) * 3 + p) * 4, 4), 16);
          if (m) q.push({ zone: z, seconds: m * 60, program: p });
        }
        if (!q.length) return nack('04');
        this.queue = q; return ack;
      }
      case '40': this.queue = []; return ack;
      case '42': if (this.queue.length) this.queue.shift(); return ack;
      case '20': {
        const page = parseInt(d.substr(2, 4), 16);
        if (this.pages[page] === undefined) return nack();
        return 'A0' + h(page, 4) + this.pages[page];
      }
      case '21': {
        const page = parseInt(d.substr(2, 4), 16); const body = d.substr(6);
        if (this.pages[page] === undefined || body.length !== this.pages[page].length) return nack();
        this.pages[page] = body; return ack;
      }
      default: return nack('00');
    }
  }

  handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      this.requests++;
      if (req.method !== 'POST' || req.url !== '/stick') { res.writeHead(405); return res.end(); }
      if (this.busyEvery && this.requests % this.busyEvery === 0) { res.writeHead(503); return res.end(); }
      let msg;
      try { msg = JSON.parse(decrypt(Buffer.concat(chunks), this.password)); } catch (e) { res.writeHead(403); return res.end(); }
      let result;
      if (msg.method === 'tunnelSip') {
        const data = String(msg.params.data).toUpperCase();
        result = { data: this.sip(data) };
        this.sipLog.push([data, result.data]);
      } else if (msg.method === 'getWifiParams') {
        result = { macAddress: 'FC:B4:67:00:00:01', localIpAddress: '127.0.0.1', rssi: -55, wifiSsid: 'Mock', stickVersion: 'Rain Bird LNK3-0.3.97.0/3.97' };
      } else {
        const out = encrypt(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }), this.password);
        res.writeHead(200); return res.end(out);
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(encrypt(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), this.password));
    });
  }

  listen(port = 0) {
    this.server = this.tls ? https.createServer(selfSignedCert(), (q, s) => this.handle(q, s)) : http.createServer((q, s) => this.handle(q, s));
    return new Promise((r) => this.server.listen(port, '127.0.0.1', () => r(this.server.address().port)));
  }
  /** Answer "RBD-ANDROID" discovery pings with a 6-byte MAC, like the real module. */
  listenDiscovery(port = 0) {
    this.udp = require('dgram').createSocket('udp4');
    this.udp.on('message', (msg, rinfo) => {
      if (msg.toString() === 'RBD-ANDROID') this.udp.send(Buffer.from([0xfc, 0xb4, 0x67, 0x60, 0x44, 0x0c]), rinfo.port, rinfo.address);
    });
    return new Promise((r) => this.udp.bind(port, '127.0.0.1', () => r(this.udp.address().port)));
  }
  close() {
    clearInterval(this.timer);
    if (this.udp) this.udp.close();
    return new Promise((r) => this.server.close(() => r()));
  }
}

module.exports = { MockTm2 };

if (require.main === module) {
  const m = new MockTm2({ password: process.env.MOCK_PASSWORD || 'secret' });
  m.listen(Number(process.argv[2] || 8443)).then((p) => console.log(`Mock ESP-TM2 on https://127.0.0.1:${p}/stick (password "${m.password}")`));
}
