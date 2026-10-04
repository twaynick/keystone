'use strict';

const os = require('os');

// Picks the PC's address on the home network for the pairing QR code.
// Windows machines often have several adapters (Hyper-V, WSL, VPNs,
// VirtualBox) whose addresses a phone can't reach, so those rank last.

const VIRTUAL = /(vethernet|virtualbox|vmware|hyper-v|wsl|loopback|docker|tailscale|zerotier|vpn|tap|tun|bluetooth)/i;

function privateRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
  return 5; // public or link-local: unlikely to be what the phone sees
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, adapter: name, virtual: VIRTUAL.test(name) });
    }
  }
  out.sort((a, b) => (a.virtual - b.virtual) || (privateRank(a.address) - privateRank(b.address)));
  return out;
}

module.exports = { lanAddresses };
