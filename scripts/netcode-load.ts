import { WebSocket } from 'ws';
import { decodeState, encodePos, toView } from '../src/game/netcodec';

type Args = {
  url: string;
  players: number;
  durationSec: number;
  warmupSec: number;
  interpDelayMs: number;
  linkKbps: number;
  stallEveryMs: number;
  stallMs: number;
};

type Client = {
  ws: WebSocket;
  spawn: { x: number; y: number; z: number };
  phase: number;
  posTimer: ReturnType<typeof setInterval> | null;
};

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

const args: Args = {
  url: strArg('url', 'ws://localhost:8799/ws/instagib'),
  players: Math.max(2, Math.min(8, Math.round(numArg('players', 8)))),
  durationSec: Math.max(2, numArg('duration', 12)),
  warmupSec: Math.max(0, numArg('warmup', 2)),
  interpDelayMs: 0,
  linkKbps: Math.max(0, numArg('link-kbps', 0)),
  stallEveryMs: Math.max(0, numArg('stall-every-ms', 0)),
  stallMs: Math.max(0, numArg('stall-ms', 0)),
};
args.interpDelayMs = Math.max(0, numArg('interp', 110 + Math.max(0, args.players - 2) * 10));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const clients: Client[] = [];
let roomId = '';
let roomResolve: ((id: string) => void) | null = null;
const roomReady = new Promise<string>((resolve) => {
  roomResolve = resolve;
});

let measureStart = 0;
let measureEnd = 0;
let newestSnapshotT = 0;
let lastArrival = 0;
let nextDeliveryAt = 0;
let frameBytes = 0;
let frameCount = 0;
let extrapSamples = 0;
let renderSamples = 0;
const arrivalGaps: number[] = [];
const bufferSamples: number[] = [];
const harnessStart = performance.now();

const afterStall = (t: number): number => {
  if (args.stallEveryMs <= 0 || args.stallMs <= 0) return t;
  const elapsed = t - harnessStart;
  const phase = ((elapsed % args.stallEveryMs) + args.stallEveryMs) % args.stallEveryMs;
  return phase < args.stallMs ? t + (args.stallMs - phase) : t;
};

const handleViewerState = (data: Buffer) => {
  const dec = decodeState(toView(data));
  if (!dec) return;
  const now = performance.now();
  newestSnapshotT = dec.t;
  if (now < measureStart || now > measureEnd) {
    lastArrival = now;
    return;
  }
  frameBytes += data.byteLength;
  frameCount += 1;
  if (lastArrival > 0) arrivalGaps.push(now - lastArrival);
  lastArrival = now;
};

const deliverViewerState = (data: Buffer) => {
  const now = performance.now();
  const bytesPerMs = args.linkKbps > 0 ? (args.linkKbps * 1000) / 8 / 1000 : Infinity;
  let at = Math.max(now, nextDeliveryAt);
  at = afterStall(at);
  if (Number.isFinite(bytesPerMs)) at += data.byteLength / bytesPerMs;
  at = afterStall(at);
  nextDeliveryAt = at;
  if (at <= now + 0.1) handleViewerState(data);
  else setTimeout(() => handleViewerState(data), at - now);
};

const connectClient = async (index: number): Promise<Client> => {
  const ws = new WebSocket(args.url, { headers: { Origin: 'http://localhost:5173' } });
  const client: Client = {
    ws,
    spawn: { x: 0, y: 0.05, z: 0 },
    phase: (index / args.players) * Math.PI * 2,
    posTimer: null,
  };
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (index === 0) {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        deliverViewerState(data);
      }
      return;
    }
    let msg: { type?: string; roomId?: string; spawn?: { x: number; y: number; z: number } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'created' && msg.roomId) {
      roomId = msg.roomId;
      roomResolve?.(roomId);
    }
    if (msg.type === 'joined' && msg.spawn) client.spawn = msg.spawn;
  });

  return client;
};

const startMovement = (client: Client) => {
  const started = performance.now();
  client.posTimer = setInterval(() => {
    const t = (performance.now() - started) / 1000;
    const a = client.phase + t * 0.35;
    const x = client.spawn.x + Math.cos(a) * 2;
    const z = client.spawn.z + Math.sin(a) * 2;
    const yaw = -a;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(encodePos(x, client.spawn.y, z, yaw, 0));
    }
  }, 1000 / 64);
};

const main = async () => {
  const viewer = await connectClient(0);
  viewer.ws.send(JSON.stringify({
    type: 'create',
    name: 'Load Viewer',
    mode: 'ffa',
    mapId: 'causeway',
    isPublic: false,
    capacity: args.players,
  }));
  const id = await roomReady;
  viewer.ws.send(JSON.stringify({ type: 'join', roomId: id, name: 'Load Viewer' }));

  for (let i = 1; i < args.players; i++) {
    const client = await connectClient(i);
    client.ws.send(JSON.stringify({ type: 'join', roomId: id, name: `Load Bot ${i}` }));
  }
  for (const client of clients) startMovement(client);

  await sleep(args.warmupSec * 1000);
  measureStart = performance.now();
  measureEnd = measureStart + args.durationSec * 1000;
  lastArrival = 0;

  const renderTimer = setInterval(() => {
    const now = performance.now();
    if (now < measureStart || now > measureEnd || newestSnapshotT === 0) return;
    const renderT = Date.now() - args.interpDelayMs;
    const bufferMs = newestSnapshotT - renderT;
    bufferSamples.push(bufferMs);
    renderSamples += 1;
    if (bufferMs < 0) extrapSamples += 1;
  }, 1000 / 120);

  await sleep(args.durationSec * 1000);
  clearInterval(renderTimer);
  for (const client of clients) {
    if (client.posTimer) clearInterval(client.posTimer);
    client.ws.close();
  }

  const meanGap = arrivalGaps.reduce((sum, n) => sum + n, 0) / Math.max(1, arrivalGaps.length);
  const meanBuffer = bufferSamples.reduce((sum, n) => sum + n, 0) / Math.max(1, bufferSamples.length);
  const jitter =
    arrivalGaps.reduce((sum, n) => sum + Math.abs(n - meanGap), 0) / Math.max(1, arrivalGaps.length);
  const result = {
    players: args.players,
    interpDelayMs: args.interpDelayMs,
    linkKbps: args.linkKbps || null,
    stallEveryMs: args.stallEveryMs || null,
    stallMs: args.stallMs || null,
    snapshots: frameCount,
    frameBytesAvg: Math.round(frameBytes / Math.max(1, frameCount)),
    downstreamKbps: Number(((frameBytes * 8) / Math.max(1, args.durationSec * 1000)).toFixed(1)),
    snapHz: Number((1000 / meanGap).toFixed(1)),
    snapJitterMs: Number(jitter.toFixed(1)),
    snapGapP95Ms: Number(percentile(arrivalGaps, 0.95).toFixed(1)),
    snapGapMaxMs: Number(Math.max(0, ...arrivalGaps).toFixed(1)),
    extrapPct: Number(((extrapSamples / Math.max(1, renderSamples)) * 100).toFixed(1)),
    bufferMsMean: Number(meanBuffer.toFixed(1)),
    bufferMsP05: Number(percentile(bufferSamples, 0.05).toFixed(1)),
  };
  console.log(JSON.stringify(result, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
