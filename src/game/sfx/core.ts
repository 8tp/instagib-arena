// ── Procedural SFX core ─────────────────────────────────────────────────────
//
// Shared building blocks for the procedural sound engine: a seedable PRNG,
// pre-rendered noise buffers, the Voice (the node set of ONE sound event), and
// envelope helpers. Everything here works on any BaseAudioContext, so the exact
// same synthesis renders live (AudioContext) and offline (OfflineAudioContext —
// see preview.ts, which measures peak/RMS through the real master chain).

export type AC = BaseAudioContext;

// xorshift32 — cheap and seedable, so offline previews are reproducible. Live
// play seeds from the clock.
let seed = (Date.now() ^ 0x9e3779b9) >>> 0 || 1;

export function seedSfxRandom(s: number) {
  seed = s >>> 0 || 1;
}

export function rnd(): number {
  let x = seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  seed = x >>> 0;
  return seed / 4294967296;
}

/** Uniform in [a, b). */
export const rr = (a: number, b: number) => a + (b - a) * rnd();
/** `x` randomly varied by ±`frac` (0.1 = ±10%). */
export const vary = (x: number, frac: number) => x * (1 + (rnd() * 2 - 1) * frac);
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ── Noise bank ───────────────────────────────────────────────────────────────
// Rendered ONCE per AudioContext. One-shots play a random slice of `white`
// (random start offset, so no two bursts are identical); ambience beds loop the
// long pink/brown buffers, whose ends are crossfaded so the loop is seamless and
// whose odd lengths keep two beds from phasing into an audible pattern.
export class NoiseBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;

  constructor(ctx: AC) {
    this.white = makeNoise(ctx, 2.1, 'white');
    this.pink = makeNoise(ctx, 6.3, 'pink');
    this.brown = makeNoise(ctx, 7.1, 'brown');
  }
}

// All three colours are RMS-normalized to the same level so a layer's gain
// means the same loudness whichever noise feeds it.
const NOISE_RMS = 0.35;

function makeNoise(ctx: AC, seconds: number, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.08);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let brown = 0;
  let dc = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = rnd() * 2 - 1;
    if (kind === 'white') {
      raw[i] = w;
    } else if (kind === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      // Leaky integrator (brown) with a slow DC tracker so it can't drift.
      brown = (brown + 0.02 * w) / 1.02;
      dc += (brown - dc) * 0.0005;
      raw[i] = brown - dc;
    }
  }
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i];
  // Seamless loop: blend the overhang past the end into the start, so sample
  // n-1 flows straight into sample 0.
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    d[i] = raw[i] * w + raw[n + i] * (1 - w);
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += d[i] * d[i];
  const k = NOISE_RMS / Math.sqrt(sum / n || 1);
  for (let i = 0; i < n; i++) d[i] *= k;
  return buf;
}

// ── Voice ────────────────────────────────────────────────────────────────────
// One sound event: every node it creates hangs off `out` (the voice's master
// gain), and every scheduled source is tracked so the pool can steal the voice
// (fast fade + stop) when a category is over its concurrency cap.
export type VoiceCat = 'self' | 'local' | 'hud' | 'rail' | 'impact' | 'remote';

export class Voice {
  readonly out: GainNode;
  readonly srcs: AudioScheduledSourceNode[] = [];
  /** Context time the last source stops. */
  end: number;
  cat: VoiceCat = 'local';

  constructor(
    readonly ctx: AC,
    /** Start time (context seconds). */
    readonly t: number,
    gain = 1,
  ) {
    this.out = ctx.createGain();
    // A non-finite AudioParam value throws — never let a bad input reach one.
    this.out.gain.value = Number.isFinite(gain) ? gain : 0;
    this.end = t;
  }

  gain(v = 0, dest?: AudioNode): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, f: number, q = 0.7071): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  pan(p: number): StereoPannerNode {
    const s = this.ctx.createStereoPanner();
    s.pan.value = p;
    return s;
  }

  osc(type: OscillatorType, f: number, start: number, stop: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, start);
    this.sched(o, start, stop);
    return o;
  }

  /** A slice of a (looping) noise buffer starting at a random offset. */
  noise(buf: AudioBuffer, start: number, stop: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(start, rnd() * Math.max(0, buf.duration - 0.1));
    s.stop(stop);
    this.track(s, stop);
    return s;
  }

  private sched(src: AudioScheduledSourceNode, start: number, stop: number) {
    src.start(start);
    src.stop(stop);
    this.track(src, stop);
  }

  private track(src: AudioScheduledSourceNode, stop: number) {
    this.srcs.push(src);
    if (stop > this.end) this.end = stop;
  }
}

// ── Envelopes ────────────────────────────────────────────────────────────────

/**
 * Percussive envelope on `p`: 0 → `peak` over `a` seconds (linear), then an
 * exponential decay that reaches -60 dB `d` seconds later.
 */
export function perc(p: AudioParam, t: number, peak: number, a: number, d: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(0, t + a, d / 6.9);
}

/** Exponential glide f0 → f1 over `dur` starting at `t` (both > 0). */
export function glide(p: AudioParam, t: number, f0: number, f1: number, dur: number) {
  p.setValueAtTime(f0, t);
  p.exponentialRampToValueAtTime(f1, t + dur);
}
