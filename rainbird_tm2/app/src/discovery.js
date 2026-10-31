'use strict';
// LAN discovery of Rain Bird LNK modules (same mechanism as the Rain Bird app, per pyrainbird):
// send "RBD-ANDROID" to UDP 33667; modules answer to the sender port (or UDP 33668) with their
// MAC (short reply) or a 36-char device UUID.
//
// The add-on runs on Home Assistant's internal network (no host networking), where broadcasts
// can't reach the LAN. So besides broadcasting, it sends the ping directly (unicast) to every
// address of the LAN subnet Home Assistant is on - replies come back through NAT.
const dgram = require('dgram');
const http = require('http');
const os = require('os');

const PAYLOAD = Buffer.from('RBD-ANDROID');
const BROADCAST_PORT = 33667;
const LISTEN_PORT = 33668;
const MAX_SWEEP = 1024; // never ping more than this many addresses per subnet

const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** Addresses to sweep for one "a.b.c.d/prefix" interface address. Large subnets: the /24 around it. */
function sweepRange(cidr) {
  const [ip, p] = cidr.split('/');
  let prefix = Number(p);
  if (!ip || !(prefix >= 8 && prefix <= 30)) return null;
  if (2 ** (32 - prefix) > MAX_SWEEP) prefix = 24;
  const size = 2 ** (32 - prefix);
  const net = (ipToInt(ip) & (0xffffffff << (32 - prefix))) >>> 0;
  const hosts = [];
  for (let i = 1; i < size - 1; i++) hosts.push(intToIp(net + i));
  return { label: `${intToIp(net)}/${prefix}`, hosts, self: ip };
}

/** LAN subnets of the Home Assistant host, from the Supervisor (falls back to local interfaces). */
function hostSubnets(log) {
  const token = process.env.SUPERVISOR_TOKEN;
  const local = () => {
    const out = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
        if (a.address.startsWith('172.30.')) continue; // Home Assistant's internal add-on network
        out.push(a.cidr);
      }
    }
    return out;
  };
  if (!token) return Promise.resolve(local());
  return new Promise((resolve) => {
    const req = http.get({ host: 'supervisor', path: '/network/info', headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const ifaces = JSON.parse(b).data.interfaces || [];
          const cidrs = ifaces.filter((i) => i.enabled !== false && i.ipv4 && i.ipv4.address)
            .sort((a, b2) => (b2.primary ? 1 : 0) - (a.primary ? 1 : 0))
            .flatMap((i) => i.ipv4.address);
          resolve(cidrs.length ? cidrs : local());
        } catch (e) {
          if (log) log.warn(`Could not read the network from Home Assistant (HTTP ${res.statusCode})`);
          resolve(local());
        }
      });
    });
    req.on('error', () => resolve(local()));
    req.on('timeout', () => req.destroy());
  });
}

async function discover({ timeoutMs = 4000, log } = {}) {
  // DISCOVERY_TARGETS="host:port,..." replaces everything (used by the tests).
  let targets;
  let scanned = [];
  if (process.env.DISCOVERY_TARGETS) {
    targets = process.env.DISCOVERY_TARGETS.split(',').map((t) => t.split(':')).map(([h, p]) => [h, Number(p) || BROADCAST_PORT]);
  } else {
    targets = [['255.255.255.255', BROADCAST_PORT]];
    for (const cidr of await hostSubnets(log)) {
      const r = sweepRange(cidr);
      if (!r) continue;
      scanned.push(r.label);
      for (const h of r.hosts) if (h !== r.self) targets.push([h, BROADCAST_PORT]);
    }
    scanned = [...new Set(scanned)];
  }

  const found = new Map();
  const onMsg = (msg, rinfo) => {
    if (!msg.length || msg.equals(PAYLOAD)) return;
    const d = found.get(rinfo.address) || { ip: rinfo.address };
    const text = msg.toString('utf8').replace(/\0/g, '').trim();
    if (msg.length === 6) d.mac = [...msg].map((b) => b.toString(16).padStart(2, '0')).join(':');
    else if (msg.length <= 18) d.mac = text;
    else d.uuid = text.slice(0, 36);
    found.set(rinfo.address, d);
  };

  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  tx.on('message', onMsg);
  rx.on('message', onMsg);
  tx.on('error', (e) => log && log.debug(`Discovery: ${e.message}`));
  rx.on('error', () => {}); // port unavailable - replies to the sender port still work
  rx.bind(LISTEN_PORT);
  await new Promise((r) => tx.bind(0, r));
  try { tx.setBroadcast(true); } catch {}

  // Send in small batches so a /22 sweep doesn't flood the network.
  for (let i = 0; i < targets.length; i += 64) {
    for (const [addr, port] of targets.slice(i, i + 64)) tx.send(PAYLOAD, port, addr, () => {});
    await new Promise((r) => setTimeout(r, 20));
  }
  // second round for the few addresses that might have dropped the first ping
  await new Promise((r) => setTimeout(r, 500));
  for (const [addr, port] of targets) if (!found.has(addr) && targets.length <= 300) tx.send(PAYLOAD, port, addr, () => {});

  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const s of [tx, rx]) { try { s.close(); } catch {} }
  return { found: [...found.values()], scanned };
}

module.exports = { discover, sweepRange };
