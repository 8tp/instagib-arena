// ── Offline SFX preview / loudness check (dev tooling — not imported by the game)
//
// Renders every procedural sound through the REAL master chain (buses, reverb,
// limiter, safety clip) in an OfflineAudioContext and reports peak dBFS, RMS
// dBFS and audible duration, optionally as a 16-bit WAV. Driven from headless
// Chrome by scripts/sfx-render.mjs (vite serves this module as-is):
//   node scripts/sfx-render.mjs --base http://localhost:5184
// Volumes mirror the game's call sites (e.g. play('fire', 0.55)); master = 1.
import { seedSfxRandom } from './core';
import { SfxEngine } from './engine';

type Case = {
  name: string;
  /** Render length, seconds. */
  dur: number;
  map?: string;
  /** Measure RMS over the steady state (skip the fade-in) rather than the active window. */
  steady?: boolean;
  run: (e: SfxEngine, ctx: OfflineAudioContext) => unknown;
};

const SR = 48000;
const T0 = 0.05;

// Positions: the listener sits at the origin facing -Z; "front" is (0,0,-d).
const front = (d: number) => [0, 0, -d] as const;
const right = (d: number) => [d, 0, 0] as const;

const MAPS = ['causeway', 'reactor', 'lounge', 'nuketown', 'containeryard', 'derrick', 'training'];

async function loadClip(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

const CASES: Case[] = [
  { name: 'rail (local)', dur: 1.6, map: 'reactor', run: (e) => e.railShot(0.55, T0) },
  { name: 'rail remote @6m', dur: 1.4, map: 'reactor', run: (e) => e.railAt(...front(6), 0.5, T0) },
  { name: 'rail remote @25m', dur: 1.6, map: 'reactor', run: (e) => e.railAt(...right(25), 0.5, T0) },
  { name: 'charge hum (1.2s)', dur: 1.4, run: (e) => e.chargeStart(1.2, T0) },
  { name: 'ready cue', dur: 0.4, run: (e) => e.ready(0.6, T0) },
  { name: 'hit tick', dur: 0.3, run: (e) => e.hitTick(false, 0.5, T0) },
  { name: 'hit tick headshot', dur: 0.35, run: (e) => e.hitTick(true, 0.5, T0) },
  { name: 'kill confirm', dur: 0.9, run: (e) => e.kill(false, 0.7, T0) },
  { name: 'kill confirm headshot', dur: 0.9, run: (e) => e.kill(true, 0.7, T0) },
  {
    name: 'frag (tick+kill)',
    dur: 0.9,
    run: (e) => {
      e.kill(false, 0.7, T0);
      e.hitTick(false, 0.5, T0);
    },
  },
  { name: 'gib bystander @10m', dur: 1.0, run: (e) => e.gibAt(...front(10), 0.6, T0) },
  { name: 'death', dur: 1.2, run: (e) => e.death(0.6, T0) },
  { name: 'footstep (reactor)', dur: 0.4, map: 'reactor', run: (e) => e.localMove('step', 10, T0) },
  { name: 'footstep (lounge)', dur: 0.4, map: 'lounge', run: (e) => e.localMove('step', 10, T0) },
  { name: 'footstep (nuketown)', dur: 0.4, map: 'nuketown', run: (e) => e.localMove('step', 10, T0) },
  {
    name: 'run loop x10 (causeway)',
    dur: 3.6,
    map: 'causeway',
    run: (e) => {
      for (let i = 0; i < 10; i++) e.localMove('step', 10, T0 + i * 0.32);
    },
  },
  { name: 'remote step @4m', dur: 0.4, map: 'reactor', run: (e) => e.remoteMove('step', ...right(4), 10, T0) },
  { name: 'remote step @12m', dur: 0.4, map: 'reactor', run: (e) => e.remoteMove('step', ...front(12), 10, T0) },
  { name: 'jump (hup)', dur: 0.5, run: (e) => e.localMove('jump', 0, T0) },
  { name: 'double jump', dur: 0.5, run: (e) => e.localMove('airjump', 0, T0) },
  { name: 'land soft (5 m/s)', dur: 0.5, map: 'causeway', run: (e) => e.localMove('land', 5, T0) },
  { name: 'land normal (9 m/s)', dur: 0.6, map: 'causeway', run: (e) => e.localMove('land', 9, T0) },
  { name: 'land hard (20 m/s)', dur: 0.8, map: 'causeway', run: (e) => e.localMove('land', 20, T0) },
  { name: 'dash', dur: 0.6, run: (e) => e.localMove('dash', 0.8, T0) },
  { name: 'wall kick (derrick)', dur: 0.6, map: 'derrick', run: (e) => e.localMove('walljump', 0, T0) },
  { name: 'boost', dur: 0.9, run: (e) => e.localMove('boost', 0, T0) },
  { name: 'remote jump @6m', dur: 0.5, run: (e) => e.remoteMove('jump', ...right(6), 9, T0) },
  { name: 'remote land @6m', dur: 0.6, run: (e) => e.remoteMove('land', ...front(6), 12, T0) },
  { name: 'sting special', dur: 0.8, run: (e) => e.medalSting('special', 1, 1, T0) },
  { name: 'sting multi x3', dur: 0.8, run: (e) => e.medalSting('multi', 3, 1, T0) },
  { name: 'sting streak L3', dur: 1.2, run: (e) => e.medalSting('streak', 3, 1, T0) },
  ...MAPS.map(
    (m): Case => ({
      name: `ambience ${m}`,
      dur: 9,
      map: m,
      steady: true,
      run: (e) => e.startAmbience(),
    }),
  ),
  {
    name: 'announcer ref (first-blood.ogg)',
    dur: 2.2,
    run: async (e, ctx) => {
      const buf = await loadClip(ctx, '/sounds/instagib/first-blood.ogg');
      if (!buf) return;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(e.mixer.announcerBus);
      s.start(T0);
    },
  },
  {
    name: 'STRESS busy 8p FFA',
    dur: 2.5,
    map: 'reactor',
    run: (e) => {
      e.startAmbience();
      e.railShot(0.55, T0);
      e.chargeStart(1.2, T0);
      e.hitTick(true, 0.5, T0 + 0.01);
      e.kill(true, 0.7, T0 + 0.01);
      e.medalSting('multi', 4, 1, T0 + 0.02);
      for (let i = 0; i < 14; i++) {
        const a = i * 0.9;
        const d = 3 + i * 3;
        e.railAt(Math.cos(a) * d, 1, Math.sin(a) * d, i % 2 ? 0.5 : 0.4, T0 + i * 0.06);
      }
      for (let i = 0; i < 40; i++) {
        const a = i * 2.1;
        const d = 2 + (i % 9) * 2;
        e.remoteMove('step', Math.cos(a) * d, 0, Math.sin(a) * d, 10, T0 + i * 0.03);
      }
      for (let i = 0; i < 8; i++) {
        e.remoteMove(i % 2 ? 'land' : 'jump', 4 + i, 0, -3, 14, T0 + 0.1 + i * 0.12);
        e.gibAt(-3 - i, 1, 5, 0.6, T0 + 0.2 + i * 0.1);
      }
      e.localMove('boost', 0, T0 + 0.3);
      e.localMove('land', 22, T0 + 0.9);
    },
  },
];

export function listCases(): string[] {
  return CASES.map((c) => c.name);
}

export type CaseResult = {
  name: string;
  peakDb: number;
  rmsDb: number;
  /** Loudest 100 ms K-weighted window (≈ momentary loudness, LUFS-like). */
  shortDb: number;
  dur: number;
  peakVoices: number;
  /** RMS per 100 ms window over the first second of activity, dBFS. */
  env: number[];
  /** Energy share (%) per band: <150, 150-600, 600-2.5k, 2.5k-8k, >8k Hz. */
  bands: number[];
  wav?: string; // base64 16-bit PCM stereo
};

// In-place radix-2 FFT (re/im), n a power of two.
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Per-sample K-weighted power (L² + R²) — BS.1770 pre-filter + RLB high-pass.
function kWeightPower(L: Float32Array, R: Float32Array): Float64Array {
  const out = new Float64Array(L.length);
  const stage = (x: Float32Array | Float64Array, b: number[], a: number[]) => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1;
      x1 = x[i];
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    return y;
  };
  const shelfB = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const shelfA = [1, -1.69065929318241, 0.73248077421585];
  const hpB = [1, -2, 1];
  const hpA = [1, -1.99004745483398, 0.99007225036621];
  for (const ch of [L, R]) {
    const k = stage(stage(ch, shelfB, shelfA), hpB, hpA);
    for (let i = 0; i < k.length; i++) out[i] += k[i] * k[i];
  }
  return out;
}

function bandShares(L: Float32Array, R: Float32Array, i0: number, i1: number): number[] {
  const n = 1 << 16;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(n, i1 - i0);
  // Rectangular with 3 ms cosine tapers — a full Hann window would suppress
  // the onset, where transients (thump, crack, click) live.
  const tap = Math.min(Math.floor(SR * 0.003), Math.floor(len / 2));
  for (let i = 0; i < len; i++) {
    const edge = Math.min(i, len - 1 - i);
    const w = edge >= tap ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / Math.max(1, tap));
    re[i] = ((L[i0 + i] + R[i0 + i]) / 2) * w;
  }
  fft(re, im);
  const edges = [150, 600, 2500, 8000];
  const e = [0, 0, 0, 0, 0];
  for (let k = 1; k < n / 2; k++) {
    const f = (k * SR) / n;
    const p = re[k] * re[k] + im[k] * im[k];
    let b = 0;
    while (b < edges.length && f >= edges[b]) b++;
    e[b] += p;
  }
  const tot = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => Math.round((100 * x) / tot));
}

export async function renderCase(name: string, wantWav: boolean): Promise<CaseResult> {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  seedSfxRandom(0x5eed + name.length * 7919);
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * c.dur), SR);
  const e = new SfxEngine(ctx);
  e.setMasterVolume(1);
  e.setListenerPos(0, 0, 0);
  e.setMap(c.map ?? 'causeway');
  await c.run(e, ctx);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let peak = 0;
  let first = -1;
  let last = -1;
  const floor = 0.001; // -60 dBFS
  for (let i = 0; i < L.length; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    if (a > floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  let i0 = Math.max(0, first);
  let i1 = Math.max(i0 + 1, last);
  if (c.steady) {
    i0 = Math.floor(SR * 3); // past the 2.5 s fade-in
    i1 = L.length;
  }
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += (L[i] * L[i] + R[i] * R[i]) / 2;
  const rms = Math.sqrt(sum / Math.max(1, i1 - i0));
  const db = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -120);
  const winRms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += (L[i] * L[i] + R[i] * R[i]) / 2;
    return Math.sqrt(s / Math.max(1, b - a));
  };
  // Momentary loudness: BS.1770 K-weighting (48 kHz coefficients), loudest
  // 100 ms window (hop 10 ms), channels summed — an LUFS-like number that
  // doesn't flatter sub-heavy sounds. Short sounds use their whole window.
  const kw = kWeightPower(L, R);
  const w100k = Math.min(Math.floor(SR * 0.1), Math.max(1, i1 - i0));
  let kMax = 0;
  for (let a = i0; a + w100k <= i1; a += Math.floor(SR * 0.01)) {
    let s = 0;
    for (let i = a; i < a + w100k; i++) s += kw[i];
    kMax = Math.max(kMax, s / w100k);
  }
  const short = kMax > 0 ? Math.pow(10, (-0.691 + 10 * Math.log10(kMax)) / 20) : 0;
  const env: number[] = [];
  const w100 = Math.floor(SR * 0.1);
  for (let k = 0; k < 10; k++) {
    const a = Math.max(0, first) + k * w100;
    if (a + w100 > L.length) break;
    env.push(db(winRms(a, a + w100)));
  }
  return {
    name,
    peakDb: db(peak),
    rmsDb: db(rms),
    shortDb: db(short),
    dur: first < 0 ? 0 : Math.round(((last - first) / SR) * 100) / 100,
    peakVoices: e.mixer.peakVoices,
    env,
    bands: first < 0 ? [0, 0, 0, 0, 0] : bandShares(L, R, i0, i1),
    wav: wantWav ? toWavBase64(L, R) : undefined,
  };
}

function toWavBase64(L: Float32Array, R: Float32Array): string {
  const n = L.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 2, true); // stereo
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    dv.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    o += 4;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
