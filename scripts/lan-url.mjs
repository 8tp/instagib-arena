// Print the URL(s) other devices on this WiFi/LAN should open to reach the game.
//
// Used by `npm run lan` (standalone) and printed at the top of `npm run dev:lan`
// so you can hand the address to a phone / second laptop without hunting for
// your IP. It picks the first non-internal IPv4 on an up interface — the address
// your router handed this machine — and prints both the dev (Vite, default 5173)
// and single-port (Node, default 8787) URLs.

import os from 'node:os';

const DEV_PORT = process.env.VITE_PORT || '5173';
const SERVER_PORT = process.env.PORT || process.env.SERVER_PORT || '8787';

function lanIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Skip common virtual / VPN ranges so we surface the real WiFi/LAN IP.
      if (/^(vmnet|vboxnet|utun|bridge|llw|awdl)/i.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}

const ips = lanIPv4s();
const mode = process.argv.includes('--server') ? 'server' : 'dev';
const port = mode === 'server' ? SERVER_PORT : DEV_PORT;

if (ips.length === 0) {
  console.log('[lan] No LAN IPv4 found — are you connected to WiFi/Ethernet?');
} else {
  const label = mode === 'server' ? 'single-port (built client + server)' : 'dev (Vite, hot reload)';
  console.log(`\n  Instagib on your LAN — ${label}`);
  console.log('  Open this on any device on the same WiFi:\n');
  for (const ip of ips) console.log(`    →  http://${ip}:${port}`);
  if (ips.length > 1) console.log('\n  (multiple addresses — try them in order if one fails)');
  console.log('\n  On macOS the first connection may prompt to allow incoming');
  console.log('  connections — click Allow. Same-subnet only; no internet exposure.\n');
}
