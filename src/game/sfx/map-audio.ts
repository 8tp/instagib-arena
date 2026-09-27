// ── Per-map audio: room reverb, floor surface, ambience bed ──────────────────
// Keyed by the map registry id (map.ts MAPS). Unknown ids fall back to a
// neutral room. Ambience beds are fully procedural: looped noise through
// LFO-modulated filters (wind, air handling, water) plus quiet oscillator
// drones / hums and gated chirps — all scheduled once, zero per-frame work.
import type { AC, NoiseBank } from './core';
import type { RoomProfile } from './mixer';
import type { SurfaceProfile } from './movement-sfx';

type LfoSpec = { rate: number; depth: number };
type AmbLayer =
  | {
      k: 'noise';
      color: 'pink' | 'brown' | 'white';
      type: BiquadFilterType;
      f: number;
      q?: number;
      level: number;
      /** Level modulation (depth as a fraction of level) — gusts, swells. */
      gust?: LfoSpec;
      /** Filter-frequency modulation (depth in Hz) — the wind "moving". */
      sweep?: LfoSpec;
    }
  | {
      k: 'tone';
      type: OscillatorType;
      f: number[];
      amps?: number[];
      lp?: number;
      level: number;
      /** Slow amplitude throb (depth as a fraction of level). */
      throb?: LfoSpec;
    }
  | {
      /** Insect-like chirps: a sine carrier gated by a fast pulse train inside slower groups. */
      k: 'chirp';
      f: number;
      pulse: number;
      group: number;
      level: number;
    };

export type MapAudio = { room: RoomProfile; surface: SurfaceProfile; bed: AmbLayer[] };

const DEFAULT_AUDIO: MapAudio = {
  room: { seconds: 1.1, predelay: 0.015, damp: 0.45, wet: 0.22 },
  surface: { thump: 88, body: 1000, click: 3000, grit: 0.4, ring: 0, ringQ: 1, ringAmt: 0 },
  bed: [
    { k: 'noise', color: 'pink', type: 'lowpass', f: 900, level: 0.05, gust: { rate: 0.07, depth: 0.3 } },
    { k: 'noise', color: 'brown', type: 'lowpass', f: 160, level: 0.06 },
  ],
};

export const MAP_AUDIO: Record<string, MapAudio> = {
  // Void (Longest Yard homage): vast, dark, open — moaning void wind, a low
  // eerie fifth underneath, and a thin whistle riding the gusts.
  causeway: {
    room: { seconds: 2.0, predelay: 0.03, damp: 0.6, wet: 0.2 },
    surface: { thump: 88, body: 950, click: 3000, grit: 0.35, ring: 2100, ringQ: 16, ringAmt: 0.05 },
    bed: [
      { k: 'noise', color: 'pink', type: 'bandpass', f: 380, q: 0.8, level: 0.14, gust: { rate: 0.06, depth: 0.6 }, sweep: { rate: 0.045, depth: 180 } },
      { k: 'noise', color: 'pink', type: 'bandpass', f: 1500, q: 7, level: 0.05, gust: { rate: 0.11, depth: 0.8 }, sweep: { rate: 0.08, depth: 500 } },
      { k: 'tone', type: 'sine', f: [43.65, 65.4, 87.3], amps: [1, 0.6, 0.25], level: 0.02, throb: { rate: 0.07, depth: 0.4 } },
    ],
  },
  // Industrial reactor: mains hum + harmonics throbbing like a turbine, air
  // handling, a sub rumble and a faint electrical whine. Bright steel room.
  reactor: {
    room: { seconds: 1.6, predelay: 0.018, damp: 0.25, wet: 0.32 },
    surface: { thump: 92, body: 1150, click: 3400, grit: 0.6, ring: 1650, ringQ: 12, ringAmt: 0.08 },
    bed: [
      { k: 'tone', type: 'sawtooth', f: [60], lp: 420, level: 0.03, throb: { rate: 0.55, depth: 0.35 } },
      { k: 'tone', type: 'sine', f: [120, 180, 240], amps: [1, 0.5, 0.3], level: 0.012 },
      { k: 'noise', color: 'pink', type: 'bandpass', f: 900, q: 1.2, level: 0.06, gust: { rate: 0.09, depth: 0.3 } },
      { k: 'noise', color: 'brown', type: 'lowpass', f: 120, level: 0.125 },
      { k: 'tone', type: 'sine', f: [3150], level: 0.0015 },
    ],
  },
  // Giant-scale lounge (Ratz homage): warm, close room tone and a fridge hum.
  lounge: {
    room: { seconds: 1.0, predelay: 0.012, damp: 0.8, wet: 0.24 },
    surface: { thump: 80, body: 700, click: 1900, grit: 0.3, ring: 420, ringQ: 5, ringAmt: 0.05 },
    bed: [
      { k: 'noise', color: 'brown', type: 'lowpass', f: 260, level: 0.1 },
      { k: 'noise', color: 'pink', type: 'lowpass', f: 1500, level: 0.03, gust: { rate: 0.05, depth: 0.3 } },
      { k: 'tone', type: 'sine', f: [100, 200], amps: [1, 0.3], level: 0.004 },
    ],
  },
  // Dusk suburb: an evening breeze, crickets, and distant traffic rumble.
  nuketown: {
    room: { seconds: 0.75, predelay: 0.025, damp: 0.55, wet: 0.16 },
    surface: { thump: 85, body: 1400, click: 4200, grit: 0.7, ring: 0, ringQ: 1, ringAmt: 0 },
    bed: [
      { k: 'noise', color: 'pink', type: 'bandpass', f: 650, q: 0.7, level: 0.08, gust: { rate: 0.08, depth: 0.7 }, sweep: { rate: 0.05, depth: 250 } },
      { k: 'chirp', f: 4400, pulse: 28, group: 1.35, level: 0.01 },
      { k: 'chirp', f: 4950, pulse: 24, group: 0.95, level: 0.0065 },
      { k: 'noise', color: 'brown', type: 'lowpass', f: 140, level: 0.06 },
    ],
  },
  // Night port: a distant ship engine drone, water lapping, sodium-lamp buzz.
  containeryard: {
    room: { seconds: 1.25, predelay: 0.02, damp: 0.4, wet: 0.26 },
    surface: { thump: 84, body: 1250, click: 3600, grit: 0.55, ring: 1250, ringQ: 8, ringAmt: 0.03 },
    bed: [
      { k: 'tone', type: 'sawtooth', f: [38.9, 39.2], lp: 150, level: 0.03, throb: { rate: 0.18, depth: 0.4 } },
      { k: 'noise', color: 'brown', type: 'lowpass', f: 320, level: 0.05, gust: { rate: 0.21, depth: 0.6 } },
      { k: 'tone', type: 'sawtooth', f: [120], lp: 700, level: 0.004 },
      { k: 'noise', color: 'pink', type: 'bandpass', f: 500, q: 0.7, level: 0.04, gust: { rate: 0.07, depth: 0.5 } },
    ],
  },
  // Rust at dusk: gusting industrial wind, a resonant whistle off the steel
  // structure, and a low rumble.
  derrick: {
    room: { seconds: 1.4, predelay: 0.022, damp: 0.45, wet: 0.24 },
    surface: { thump: 86, body: 1000, click: 3000, grit: 0.5, ring: 1400, ringQ: 10, ringAmt: 0.07 },
    bed: [
      { k: 'noise', color: 'pink', type: 'bandpass', f: 520, q: 0.9, level: 0.16, gust: { rate: 0.1, depth: 0.75 }, sweep: { rate: 0.06, depth: 260 } },
      { k: 'noise', color: 'pink', type: 'bandpass', f: 740, q: 14, level: 0.06, gust: { rate: 0.15, depth: 0.85 }, sweep: { rate: 0.23, depth: 60 } },
      { k: 'noise', color: 'brown', type: 'lowpass', f: 90, level: 0.11 },
    ],
  },
  // Lab: clean HVAC air, a faint mains hum, and a barely-there electronic whine.
  training: {
    room: { seconds: 0.85, predelay: 0.01, damp: 0.35, wet: 0.2 },
    surface: { thump: 90, body: 900, click: 2600, grit: 0.35, ring: 0, ringQ: 1, ringAmt: 0 },
    bed: [
      { k: 'noise', color: 'pink', type: 'lowpass', f: 1100, level: 0.07 },
      { k: 'tone', type: 'sine', f: [60, 120], amps: [1, 0.4], level: 0.006 },
      { k: 'tone', type: 'sine', f: [7800], level: 0.0006 },
    ],
  },
};

// Master level of every bed — ambience sits far under the action (≈ -44 dBFS RMS).
const AMB_LEVEL = 0.14;

export function mapAudio(id: string): MapAudio {
  return MAP_AUDIO[id] ?? DEFAULT_AUDIO;
}

// Gate curves for the chirp layer: map a ±1 LFO to a 0/1 gate.
function gateCurve(threshold: number, soft: number): Float32Array<ArrayBuffer> {
  const n = 512;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.max(0, Math.min(1, (x - threshold) / soft));
  }
  return c;
}

/** One running ambience bed. Fades in on creation; `stop()` fades out + ends it. */
export class AmbienceBed {
  readonly out: GainNode;
  private srcs: AudioScheduledSourceNode[] = [];

  constructor(
    private ctx: AC,
    bank: NoiseBank,
    layers: AmbLayer[],
    dest: AudioNode,
    fadeIn: number,
  ) {
    const t = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(AMB_LEVEL, t + fadeIn);
    this.out.connect(dest);
    let i = 0;
    for (const layer of layers) this.build(layer, bank, t, i++);
  }

  private src<T extends AudioScheduledSourceNode>(s: T, t: number): T {
    s.start(t);
    this.srcs.push(s);
    return s;
  }

  // Two incommensurate sine LFOs summed onto `param` (total depth `depth`),
  // so gusts and sweeps never settle into an audible loop.
  private lfo(param: AudioParam, spec: LfoSpec, depth: number, t: number, phase: number) {
    const ctx = this.ctx;
    const rates = [spec.rate, spec.rate * 2.618];
    const share = [0.62, 0.38];
    for (let k = 0; k < 2; k++) {
      const o = this.src(ctx.createOscillator(), t + phase * (k + 1));
      o.frequency.value = rates[k];
      const g = ctx.createGain();
      g.gain.value = depth * share[k];
      o.connect(g).connect(param);
    }
  }

  private build(layer: AmbLayer, bank: NoiseBank, t: number, idx: number) {
    const ctx = this.ctx;
    const phase = 0.37 * (idx + 1); // desync LFOs between layers
    if (layer.k === 'noise') {
      const s = ctx.createBufferSource();
      s.buffer = layer.color === 'pink' ? bank.pink : layer.color === 'brown' ? bank.brown : bank.white;
      s.loop = true;
      s.playbackRate.value = 0.97 + 0.02 * idx;
      s.start(t, (0.61 * (idx + 1)) % Math.max(0.1, s.buffer.duration - 0.1));
      this.srcs.push(s);
      const f = ctx.createBiquadFilter();
      f.type = layer.type;
      f.frequency.value = layer.f;
      f.Q.value = layer.q ?? 0.7071;
      const g = ctx.createGain();
      g.gain.value = layer.level;
      s.connect(f).connect(g).connect(this.out);
      if (layer.gust) this.lfo(g.gain, layer.gust, layer.level * layer.gust.depth, t, phase);
      if (layer.sweep) this.lfo(f.frequency, layer.sweep, layer.sweep.depth, t, phase * 1.7);
      return;
    }
    if (layer.k === 'tone') {
      const g = ctx.createGain();
      g.gain.value = layer.level;
      let head: AudioNode = g;
      if (layer.lp) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = layer.lp;
        f.connect(g);
        head = f;
      }
      layer.f.forEach((freq, i) => {
        const o = this.src(ctx.createOscillator(), t);
        o.type = layer.type;
        o.frequency.value = freq;
        const a = ctx.createGain();
        a.gain.value = layer.amps?.[i] ?? 1;
        o.connect(a).connect(head);
      });
      g.connect(this.out);
      if (layer.throb) this.lfo(g.gain, layer.throb, layer.level * layer.throb.depth, t, phase);
      return;
    }
    // chirp: carrier × fast pulse gate × slow group gate
    const car = this.src(ctx.createOscillator(), t);
    car.frequency.value = layer.f;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0;
    const groupGain = ctx.createGain();
    groupGain.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = layer.level;
    car.connect(pulseGain).connect(groupGain).connect(out).connect(this.out);
    const pulse = this.src(ctx.createOscillator(), t);
    pulse.frequency.value = layer.pulse;
    const ps = ctx.createWaveShaper();
    ps.curve = gateCurve(0.2, 0.4);
    pulse.connect(ps).connect(pulseGain.gain);
    const group = this.src(ctx.createOscillator(), t + phase);
    group.frequency.value = layer.group;
    const gs = ctx.createWaveShaper();
    gs.curve = gateCurve(0.62, 0.2);
    group.connect(gs).connect(groupGain.gain);
  }

  /** Fade out over `fade` seconds, then stop every source. */
  stop(fade: number) {
    const now = this.ctx.currentTime;
    const p = this.out.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(0, now + fade);
    for (const s of this.srcs) {
      try {
        s.stop(now + fade + 0.05);
      } catch {
        // already stopped
      }
    }
    this.srcs = [];
  }
}
