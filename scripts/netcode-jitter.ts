// Uplink smoothness harness: how smooth does ONE moving player look to others?
//
// A simulated browser ("sender") runs the game's real loop shape: display-rate
// frames (60/144Hz, timer jitter, periodic main-thread hitches) stepping a 64Hz
// fixed sim with an accumulator (max 5 steps/frame), uploading its pose every
// step — several uploads flush together whenever a frame runs several steps.
// Uploads cross an emulated uplink (base delay + jitter, order-preserving like
// TCP). A second client ("viewer") records the sender's row from every state
// snapshot. The sender moves on a circle at constant speed, so any wobble in the
// snapshot stream's velocity is pure netcode error.
//
//   npx tsx scripts/netcode-jitter.ts                       # both modes, 60Hz
//   npx tsx scripts/netcode-jitter.ts --hz 144 --jitter 12 --hitch-every 1200 --hitch-ms 60
//   npx tsx scripts/netcode-jitter.ts --mode tick --url wss://instagib.win/ws/instagib --origin https://instagib.win
//
// Modes: `legacy` = BIN_POS (server stamps by arrival), `tick` = BIN_POS_TICK
// (server stamps by the sender's sim tick). Reported per mode:
//   velErrRms / velErrP95 (m/s) — snapshot-to-snapshot speed error vs truth
//   hitchPct — share of snapshot intervals whose speed is off by > 25%
//   holdPct  — share where the player barely moved (< 10% of true speed)
//   latencyMean / latencyP95 (ms) — snapshot time − wall time the pose was simulated
//     (uplink + server playout; excludes the viewer's own interpolation delay)

import { WebSocket } from 'ws';
import { decodeState, encodePos, encodePosTick, toView } from '../src/game/netcodec';

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

const URL_ = strArg('url', 'ws://localhost:8787/ws/instagib');
const ORIGIN = strArg('origin', 'http://localhost:5173');
const MODE = strArg('mode', 'both');
const HZ = numArg('hz', 60);
const SPEED = numArg('speed', 12); // m/s along the circle
const RADIUS = numArg('radius', 6);
const BASE_MS = numArg('base', 12); // uplink one-way delay
const JITTER_MS = numArg('jitter', 6); // uniform extra uplink delay
const HITCH_EVERY_MS = numArg('hitch-every', 2000);
const HITCH_MS = numArg('hitch-ms', 45);
const DURATION_S = numArg('duration', 10);
const WARMUP_S = numArg('warmup', 2);

const TICK_MS = 1000 / 64;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round = (n: number, d = 2) => Number(n.toFixed(d));

type Conn = { ws: WebSocket; id: string | null; spawn: { x: number; y: number; z: number } };

function connect(onBinary?: (b: Buffer) => void, onJson?: (m: Record<string, unknown>) => void): Promise<Conn> {
  const ws = new WebSocket(URL_, { origin: ORIGIN, headers: { Origin: ORIGIN } });
  const conn: Conn = { ws, id: null, spawn: { x: 0, y: 0.05, z: 0 } };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      onBinary?.(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer));
      return;
    }
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === 'welcome') conn.id = String(m.clientId);
    if (m.type === 'joined' && m.spawn) conn.spawn = m.spawn as Conn['spawn'];
    onJson?.(m);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(conn));
    ws.once('error', reject);
  });
}

async function run(mode: 'legacy' | 'tick') {
  // Viewer: creates a private room and records the sender's snapshot rows.
  let roomResolve: (id: string) => void = () => {};
  const roomReady = new Promise<string>((r) => (roomResolve = r));
  let senderId = '';
  let measuring = false;
  const rows: { t: number; x: number; z: number }[] = [];
  const viewer = await connect(
    (buf) => {
      if (!measuring || !senderId) return;
      const dec = decodeState(toView(buf));
      const row = dec?.players.find((p) => p.id === senderId);
      if (dec && row) rows.push({ t: dec.t, x: row.x, z: row.z });
    },
    (m) => {
      if (m.type === 'created' && m.roomId) roomResolve(String(m.roomId));
    },
  );
  viewer.ws.send(JSON.stringify({ type: 'create', name: 'Jitter Viewer', mode: 'ffa', mapId: 'causeway', isPublic: false, capacity: 4 }));
  const roomId = await roomReady;
  viewer.ws.send(JSON.stringify({ type: 'join', roomId, name: 'Jitter Viewer' }));

  const sender = await connect();
  sender.ws.send(JSON.stringify({ type: 'join', roomId, name: 'Jitter Sender' }));
  await sleep(400);
  senderId = sender.id ?? '';
  const cx = sender.spawn.x;
  const cz = sender.spawn.z;
  const y = sender.spawn.y;
  const omega = SPEED / RADIUS; // rad/s

  // Emulated uplink: order-preserving delayed delivery (TCP semantics).
  let nextDeliver = 0;
  const upload = (frame: Uint8Array) => {
    const now = performance.now();
    const at = Math.max(nextDeliver, now + BASE_MS + Math.random() * JITTER_MS);
    nextDeliver = at;
    setTimeout(() => {
      if (sender.ws.readyState === WebSocket.OPEN) sender.ws.send(frame);
    }, at - now);
  };

  // Sender: the game's loop shape. `steps` drives the pose (the player only
  // moves when the sim steps); `tick` is the stamped sim clock (re-synced
  // forward like game.ts when time is dropped).
  const sim = { acc: 0, steps: 0, tick: 0, lastSentTick: -1, epoch: performance.now(), last: performance.now() };
  const stepWall: number[] = []; // wall ms (Date.now) when each step was simulated
  let nextHitchAt = performance.now() + HITCH_EVERY_MS;
  let running = true;
  const frame = () => {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(100, now - sim.last);
    sim.last = now;
    sim.acc += dt;
    let n = 0;
    while (sim.acc >= TICK_MS && n < 5) {
      sim.tick += 1;
      const wallTick = Math.floor((now - sim.epoch) / TICK_MS);
      if (wallTick - sim.tick > 2) sim.tick = wallTick;
      sim.steps += 1;
      const a = sim.steps * (TICK_MS / 1000) * omega;
      const x = cx + Math.cos(a) * RADIUS;
      const z = cz + Math.sin(a) * RADIUS;
      stepWall[sim.steps] = Date.now();
      if (mode === 'tick') {
        const flags = sim.lastSentTick >= 0 && sim.tick - sim.lastSentTick > 1 ? 1 : 0;
        upload(encodePosTick(x, y, z, -a, 0, sim.tick, flags));
        sim.lastSentTick = sim.tick;
      } else {
        upload(encodePos(x, y, z, -a, 0));
      }
      sim.acc -= TICK_MS;
      n += 1;
    }
    if (n === 5) sim.acc = 0;
    let delay = 1000 / HZ + (Math.random() - 0.5) * 1.5; // vsync-ish timer jitter
    if (HITCH_EVERY_MS > 0 && now >= nextHitchAt) {
      delay += HITCH_MS; // main-thread stall (GC / React commit / tab work)
      nextHitchAt = now + HITCH_EVERY_MS * (0.7 + Math.random() * 0.6);
    }
    setTimeout(frame, Math.max(0, delay));
  };
  frame();

  await sleep(WARMUP_S * 1000);
  measuring = true;
  await sleep(DURATION_S * 1000);
  measuring = false;
  running = false;
  sender.ws.close();
  viewer.ws.close();

  // Analysis. Map each snapshot pose back to the sim step it came from (angle on
  // the circle, unwrapped near the previous one) for latency; speed error from
  // consecutive snapshot pairs.
  const velErr: number[] = [];
  const latency: number[] = [];
  let hitches = 0;
  let holds = 0;
  const period = (2 * Math.PI) / omega / (TICK_MS / 1000); // steps per revolution
  // Step being simulated at wall time `t` (binary search over stepWall).
  const stepAt = (t: number): number => {
    let lo = 1;
    let hi = sim.steps;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((stepWall[mid] ?? Infinity) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ang = Math.atan2(r.z - cz, r.x - cx);
    // Unwrap the circle angle to the revolution nearest the step that was being
    // simulated at the snapshot's time (latency ≪ half a revolution).
    let stepsEst = ang / omega / (TICK_MS / 1000);
    stepsEst += Math.round((stepAt(r.t) - stepsEst) / period) * period;
    const sLo = Math.floor(stepsEst);
    const f = stepsEst - sLo;
    if (stepWall[sLo] && stepWall[sLo + 1]) {
      latency.push(r.t - (stepWall[sLo] + (stepWall[sLo + 1] - stepWall[sLo]) * f));
    }
    if (i === 0) continue;
    const p = rows[i - 1];
    const dtS = (r.t - p.t) / 1000;
    if (dtS <= 0) continue;
    const v = Math.hypot(r.x - p.x, r.z - p.z) / dtS;
    const e = v - SPEED;
    velErr.push(Math.abs(e));
    if (Math.abs(e) > SPEED * 0.25) hitches += 1;
    if (v < SPEED * 0.1) holds += 1;
  }
  const n = Math.max(1, velErr.length);
  return {
    mode,
    snapshots: rows.length,
    velErrRms: round(Math.sqrt(velErr.reduce((s, e) => s + e * e, 0) / n)),
    velErrP95: round(pct(velErr, 0.95)),
    hitchPct: round((hitches / n) * 100, 1),
    holdPct: round((holds / n) * 100, 1),
    latencyMean: round(latency.reduce((s, x) => s + x, 0) / Math.max(1, latency.length), 1),
    latencyP95: round(pct(latency, 0.95), 1),
  };
}

async function main() {
  console.log(
    `[netcode-jitter] ${URL_} display=${HZ}Hz speed=${SPEED}m/s uplink=${BASE_MS}+U(0,${JITTER_MS})ms ` +
      `hitch=${HITCH_MS}ms/${HITCH_EVERY_MS}ms duration=${DURATION_S}s`,
  );
  const modes: Array<'legacy' | 'tick'> = MODE === 'both' ? ['legacy', 'tick'] : [MODE as 'legacy' | 'tick'];
  const results = [];
  for (const m of modes) results.push(await run(m));
  console.table(results);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
