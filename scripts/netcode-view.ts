// End-to-end remote-player smoothness, through the REAL client NetClient.
//
// A simulated browser sender (the game's loop shape: display-rate frames with
// hitches, a 64Hz accumulator sim, tick-stamped uploads) moves on a circle at
// constant speed. The viewer is the actual `NetClient` from src/game/net.ts,
// running in Node over an emulated downlink (base delay + jitter + optional
// periodic TCP-style stalls), polled at a display rate like the render loop.
// Reports how smoothly and how late the sender appears after interpolation.
//
//   npx tsx scripts/netcode-view.ts                   # adaptive (ping-aware) delay
//   npx tsx scripts/netcode-view.ts --fixed           # legacy fixed 110–170ms schedule
//   npx tsx scripts/netcode-view.ts --down-base 60 --down-jitter 20 --stall-every 3000 --stall-ms 90
//
//   renderVelErrRms/P95 (m/s) — frame-to-frame speed error of the rendered remote
//   extrapPct                — frames rendered past the newest snapshot
//   delayMs (mean/final)     — the client's applied interpolation delay
//   visualLagMs              — how far behind real time the remote is drawn

import { WebSocket as WsSocket } from 'ws';
import { encodePosTick } from '../src/game/netcodec';

const numArg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
};
const URL_ = 'ws://localhost:8787/ws/instagib';
const ORIGIN = 'http://localhost:5173';
const FIXED = process.argv.includes('--fixed');
const SPEED = numArg('speed', 12);
const RADIUS = 6;
const UP_BASE = numArg('up-base', 12);
const UP_JITTER = numArg('up-jitter', 6);
const DOWN_BASE = numArg('down-base', 12);
const DOWN_JITTER = numArg('down-jitter', 6);
const STALL_EVERY = numArg('stall-every', 0);
const STALL_MS = numArg('stall-ms', 0);
const DURATION_S = numArg('duration', 12);
const RENDER_HZ = numArg('render-hz', 144);
const TICK_MS = 1000 / 64;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const round = (n: number, d = 1) => Number(n.toFixed(d));

// Browser-shaped WebSocket for NetClient, backed by `ws` (sets Origin) with an
// emulated, order-preserving downlink: every inbound message is delivered at
// max(previous delivery, now + base + U(0, jitter)), and during a periodic stall
// window nothing is delivered until it ends (TCP head-of-line behaviour).
const started = performance.now();
class ShimSocket extends WsSocket {
  private nextAt = 0;
  private handler: ((e: { data: unknown }) => void) | null = null;
  constructor(url: string) {
    super(url, { origin: ORIGIN, headers: { Origin: ORIGIN } });
    this.binaryType = 'arraybuffer';
    this.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
      const payload = isBinary ? data : data.toString();
      const now = performance.now();
      let at = Math.max(this.nextAt, now + DOWN_BASE + Math.random() * DOWN_JITTER);
      if (STALL_EVERY > 0) {
        const phase = (at - started) % STALL_EVERY;
        if (phase < STALL_MS) at += STALL_MS - phase;
      }
      this.nextAt = at;
      setTimeout(() => this.handler?.({ data: payload }), at - now);
    });
  }
  // NetClient assigns ws.onmessage; route it through the delayed pipe.
  // @ts-expect-error — narrowing the ws event-handler property for the shim
  set onmessage(fn: ((e: { data: unknown }) => void) | null) {
    this.handler = fn;
  }
  get onmessage() {
    return this.handler;
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = ShimSocket;
if (FIXED) (globalThis as unknown as { window: unknown }).window = { location: { search: '?interp=fixed' } };

async function main() {
  const { NetClient } = await import('../src/game/net');

  // Room + sender over a plain socket.
  const lobby = new WsSocket(URL_, { origin: ORIGIN, headers: { Origin: ORIGIN } });
  await new Promise((r) => lobby.once('open', r));
  const roomId: string = await new Promise((resolve) => {
    lobby.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw.toString());
      if (m.type === 'created') resolve(m.roomId);
    });
    lobby.send(JSON.stringify({ type: 'create', name: 'View Host', mode: 'ffa', mapId: 'causeway', isPublic: false, capacity: 4 }));
  });
  lobby.send(JSON.stringify({ type: 'join', roomId, name: 'View Host' }));

  const sender = new WsSocket(URL_, { origin: ORIGIN, headers: { Origin: ORIGIN } });
  let senderId = '';
  let spawn = { x: 0, y: 0.05, z: 0 };
  sender.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(raw.toString());
    if (m.type === 'welcome') senderId = m.clientId;
    if (m.type === 'joined') spawn = m.spawn;
  });
  await new Promise((r) => sender.once('open', r));
  sender.send(JSON.stringify({ type: 'join', roomId, name: 'View Sender' }));
  await sleep(300);

  const net = new NetClient({ url: URL_, name: 'Viewer', roomId, events: { onKill: () => {} } });
  net.connect();

  // Sender loop (60Hz frames + a 40ms hitch every ~2s), tick-stamped uploads
  // over an order-preserving jittery uplink. stepWall[] = when each step ran.
  const omega = SPEED / RADIUS;
  const stepWall: number[] = [];
  const sim = { acc: 0, steps: 0, tick: 0, epoch: performance.now(), last: performance.now() };
  let upNext = 0;
  let nextHitch = performance.now() + 2000;
  let running = true;
  const frame = () => {
    if (!running) return;
    const now = performance.now();
    sim.acc += Math.min(100, now - sim.last);
    sim.last = now;
    let n = 0;
    while (sim.acc >= TICK_MS && n < 5) {
      sim.tick += 1;
      const wallTick = Math.floor((now - sim.epoch) / TICK_MS);
      if (wallTick - sim.tick > 2) sim.tick = wallTick;
      sim.steps += 1;
      const a = sim.steps * (TICK_MS / 1000) * omega;
      stepWall[sim.steps] = Date.now();
      const f = encodePosTick(spawn.x + Math.cos(a) * RADIUS, spawn.y, spawn.z + Math.sin(a) * RADIUS, -a, 0, sim.tick, 0);
      const at = Math.max(upNext, now + UP_BASE + Math.random() * UP_JITTER);
      upNext = at;
      setTimeout(() => sender.readyState === WsSocket.OPEN && sender.send(f), at - now);
      sim.acc -= TICK_MS;
      n += 1;
    }
    if (n === 5) sim.acc = 0;
    let delay = 1000 / 60 + (Math.random() - 0.5) * 1.5;
    if (now >= nextHitch) {
      delay += 40;
      nextHitch = now + 2000 * (0.7 + Math.random() * 0.6);
    }
    setTimeout(frame, Math.max(0, delay));
  };
  frame();

  // Viewer render loop.
  await sleep(3000); // warmup: clock sync + delay settle
  const vErr: number[] = [];
  const delays: number[] = [];
  const lag: number[] = [];
  let frames = 0;
  let extrap = 0;
  let prev: { x: number; z: number; t: number } | null = null;
  let lastT = performance.now();
  const end = performance.now() + DURATION_S * 1000;
  while (performance.now() < end) {
    await sleep(1000 / RENDER_HZ);
    const t = performance.now();
    net.interpolate((t - lastT) / 1000);
    lastT = t;
    const r = net.remotes.get(senderId);
    if (!r) continue;
    frames += 1;
    if (net.extrapolating) extrap += 1;
    delays.push(net.getDebugStats().interpDelayMs);
    if (prev) {
      const dt = (t - prev.t) / 1000;
      if (dt > 0) vErr.push(Math.abs(Math.hypot(r.pos.x - prev.x, r.pos.z - prev.z) / dt - SPEED));
    }
    prev = { x: r.pos.x, z: r.pos.z, t };
    // Visual lag: which sim step is drawn vs the step being simulated now.
    const ang = Math.atan2(r.pos.z - spawn.z, r.pos.x - spawn.x);
    const period = (2 * Math.PI) / omega / (TICK_MS / 1000);
    let s = ang / omega / (TICK_MS / 1000);
    s += Math.round((sim.steps - s) / period) * period;
    while (s > sim.steps) s -= period;
    const si = Math.floor(s);
    if (stepWall[si]) lag.push(Date.now() - stepWall[si]);
  }
  running = false;
  net.dispose();
  sender.close();
  lobby.close();
  const rms = Math.sqrt(vErr.reduce((a, e) => a + e * e, 0) / Math.max(1, vErr.length));
  console.table([{
    mode: FIXED ? 'fixed' : 'adaptive',
    frames,
    renderVelErrRms: round(rms, 2),
    renderVelErrP95: round(pct(vErr, 0.95), 2),
    extrapPct: round((extrap / Math.max(1, frames)) * 100),
    delayMean: round(delays.reduce((a, d) => a + d, 0) / Math.max(1, delays.length)),
    delayFinal: delays[delays.length - 1] ?? 0,
    visualLagMean: round(lag.reduce((a, d) => a + d, 0) / Math.max(1, lag.length)),
    visualLagP95: round(pct(lag, 0.95)),
  }]);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
