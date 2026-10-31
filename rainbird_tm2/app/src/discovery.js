'use strict';
// LAN discovery of Rain Bird LNK modules (same mechanism as the Rain Bird app, per pyrainbird):
// broadcast "RBD-ANDROID" to UDP 33667; modules answer to the sender port or to UDP 33668
// with their MAC (short reply) or a 36-char device UUID.
// Requires the add-on to run with host_network so broadcasts reach the LAN.
const dgram = require('dgram');
const os = require('os');

const PAYLOAD = Buffer.from('RBD-ANDROID');
const BROADCAST_PORT = 33667;
const LISTEN_PORT = 33668;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function discover({ timeoutMs = 4000, log } = {}) {
  return new Promise((resolve) => {
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
    const socks = [];
    const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socks.push(tx);
    tx.on('message', onMsg);
    tx.on('error', (e) => log && log.warn(`Discovery: ${e.message}`));
    tx.bind(0, () => {
      tx.setBroadcast(true);
      // DISCOVERY_TARGETS="host:port,..." overrides the broadcast (used by the tests).
      const targets = process.env.DISCOVERY_TARGETS
        ? process.env.DISCOVERY_TARGETS.split(',').map((t) => t.split(':')).map(([h, p]) => [h, Number(p) || BROADCAST_PORT])
        : broadcastAddresses().map((a) => [a, BROADCAST_PORT]);
      for (const [addr, port] of targets) {
        for (let i = 0; i < 2; i++) tx.send(PAYLOAD, port, addr, () => {});
      }
    });
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socks.push(rx);
    rx.on('message', onMsg);
    rx.on('error', () => {}); // port busy - replies to the sender port still work
    rx.bind(LISTEN_PORT);
    setTimeout(() => {
      for (const s of socks) { try { s.close(); } catch {} }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

module.exports = { discover, broadcastAddresses };
