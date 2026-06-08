// Aggregate server-load stress: spin up MANY rooms × players against a LOCAL
// server to find out whether the single-threaded event loop saturates under
// realistic concurrency — the "all players' ping spiked at once" symptom.
//
// Unlike netcode-load.ts (single room, netcode-quality focus), this drives
// server-wide load and measures round-trip ping the way the real client does
// (Date.now() - ts on pong). On localhost the network is ~0ms, so any RTT
// inflation here is PURELY server-side: time the ping/pong spent queued behind a
// busy event loop. The authoritative signal is the server's own NETCODE_DIAG
// log (tickHz / tickGapMaxMs) which is measured server-side and immune to any
// jank in this harness; the RTT below corroborates it from the client's view.
//
// Run the server first, e.g.:
//   DATABASE_PATH=/tmp/igload/db.sqlite DATA_DIR=/tmp/igload PORT=8799 \
//     NETCODE_DIAG=1 MAX_WS_TOTAL=5000 MAX_WS_PER_IP=5000 tsx server/index.ts
// then: tsx scripts/netcode-stress.ts --rooms 30 --per-room 8 --duration 15

import { WebSocket } from 'ws';
import { encodePos, decodeState, toView } from '../src/game/netcodec';

const numArg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
};
const strArg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const args = {
  url: strArg('url', 'ws://localhost:8799/ws/instagib'),
  rooms: Math.max(1, Math.round(numArg('rooms', 30))),
  perRoom: Math.max(2, Math.round(numArg('per-room', 8))),
  durationSec: Math.max(3, numArg('duration', 15)),
  warmupSec: Math.max(1, numArg('warmup', 4)),
  pingHz: Math.max(1, numArg('ping-hz', 4)),
  rampMs: Math.max(2, numArg('ramp-ms', 8)),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number): number => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

type Client = {
  ws: WebSocket;
  spawn: { x: number; y: number; z: number };
  phase: number;
  observer: boolean;
  posTimer?: ReturnType<typeof setInterval>;
  pingTimer?: ReturnType<typeof setInterval>;
};

const clients: Client[] = [];
let connected = 0;
let joined = 0;

// Measurement window state (shared; gated by measureStart/End).
let measureStart = Infinity;
let measureEnd = 0;
const rtt: number[] = []; // ms, all clients, during window
const snapGaps: number[] = []; // ms, observer clients only
const lastArrivalByClient = new Map<number, number>();

const connect = (index: number, observer: boolean): Promise<Client> =>
  new Promise((resolve, reject) => {
    // No Origin header → server treats us as a non-browser client (allowed in dev).
    const ws = new WebSocket(args.url);
    ws.binaryType = 'nodebuffer';
    const client: Client = {
      ws,
      spawn: { x: (index % 9) * 1.5 - 6, y: 0.05, z: Math.floor(index / 9) * 1.5 - 6 },
      phase: (index / args.perRoom) * Math.PI * 2,
      observer,
    };
    ws.once('open', () => {
      connected++;
      resolve(client);
    });
    ws.once('error', reject);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!observer) return; // non-observers just drain
        const now = performance.now();
        if (now < measureStart || now > measureEnd) return;
        const dec = decodeState(toView(raw as Buffer));
        if (!dec) return;
        const prev = lastArrivalByClient.get(index);
        if (prev !== undefined) {
          const gap = now - prev;
          if (gap > 0 && gap < 1000) snapGaps.push(gap);
        }
        lastArrivalByClient.set(index, now);
        return;
      }
      let msg: { type?: string; roomId?: string; ts?: number; spawn?: { x: number; y: number; z: number } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'created' && msg.roomId) pendingRoom?.(msg.roomId);
      if (msg.type === 'joined') {
        joined++;
        if (msg.spawn) client.spawn = msg.spawn;
      }
      if (msg.type === 'pong' && typeof msg.ts === 'number') {
        const now = performance.now();
        if (now >= measureStart && now <= measureEnd) rtt.push(Date.now() - msg.ts);
      }
    });
    clients.push(client);
  });

let pendingRoom: ((id: string) => void) | null = null;
const createRoom = async (creator: Client): Promise<string> => {
  const ready = new Promise<string>((res) => {
    pendingRoom = res;
  });
  creator.ws.send(
    JSON.stringify({
      type: 'create',
      name: 'Stress Host',
      mode: 'ffa',
      mapId: 'causeway',
      isPublic: false,
      capacity: args.perRoom,
    }),
  );
  const id = await ready;
  pendingRoom = null;
  return id;
};

const startTraffic = (client: Client) => {
  const t0 = performance.now();
  client.posTimer = setInterval(() => {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const t = (performance.now() - t0) / 1000;
    const a = client.phase + t * 0.6; // keep moving so AFK/idle dedup doesn't kick in
    client.ws.send(
      encodePos(client.spawn.x + Math.cos(a) * 2, client.spawn.y, client.spawn.z + Math.sin(a) * 2, -a, 0),
    );
  }, 1000 / 64);
  client.pingTimer = setInterval(() => {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify({ type: 'ping', ts: Date.now(), rtt: 0 }));
  }, 1000 / args.pingHz);
};

const main = async () => {
  const total = args.rooms * args.perRoom;
  console.log(
    `[stress] target ${args.rooms} rooms × ${args.perRoom} = ${total} clients → ${args.url}`,
  );
  let idx = 0;
  for (let r = 0; r < args.rooms; r++) {
    const host = await connect(idx++, r === 0); // one observer (room 0 host)
    const roomId = await createRoom(host);
    host.ws.send(JSON.stringify({ type: 'join', roomId, name: `Host ${r}` }));
    for (let p = 1; p < args.perRoom; p++) {
      const c = await connect(idx++, false);
      c.ws.send(JSON.stringify({ type: 'join', roomId, name: `Bot ${r}.${p}` }));
      await sleep(args.rampMs);
    }
  }
  console.log(`[stress] connected=${connected} joined=${joined}; warming up ${args.warmupSec}s`);
  for (const c of clients) startTraffic(c);

  await sleep(args.warmupSec * 1000);
  measureStart = performance.now();
  measureEnd = measureStart + args.durationSec * 1000;
  console.log(`[stress] MEASURING ${args.durationSec}s (watch the server's [netcode-diag] log now)`);
  await sleep(args.durationSec * 1000 + 200);

  for (const c of clients) {
    clearInterval(c.posTimer);
    clearInterval(c.pingTimer);
    c.ws.close();
  }
  const result = {
    targetClients: total,
    connected,
    joined,
    posSendHz: 64,
    inboundPosMsgsPerSec: connected * 64,
    rttSamples: rtt.length,
    rttP50Ms: Number(pct(rtt, 0.5).toFixed(1)),
    rttP95Ms: Number(pct(rtt, 0.95).toFixed(1)),
    rttP99Ms: Number(pct(rtt, 0.99).toFixed(1)),
    rttMaxMs: Number(Math.max(0, ...rtt).toFixed(1)),
    observerSnapHz: snapGaps.length ? Number((1000 / (snapGaps.reduce((s, n) => s + n, 0) / snapGaps.length)).toFixed(1)) : 0,
    observerSnapGapMaxMs: snapGaps.length ? Number(Math.max(...snapGaps).toFixed(1)) : 0,
  };
  console.log('[stress] RESULT', JSON.stringify(result, null, 2));
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
