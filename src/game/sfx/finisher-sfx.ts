// ── Finisher accents ─────────────────────────────────────────────────────────
//
// A short, style-specific layer that rides on top of the base gib (weapon-sfx
// `gib`) so each equipped Finisher is audible, not just visible: shatter = glass,
// confetti = pop + sparkle, overload = zap, voxel = digital crunch, and so on.
// Pure synthesis on the shared Voice/NoiseBank — no assets. Cosmetic only.
import { glide, perc, rr, rnd, type NoiseBank, type Voice } from './core';

// A pitched blip/ping into the voice.
function tone(v: Voice, type: OscillatorType, at: number, f: number, amp: number, d: number, f1?: number) {
  const o = v.osc(type, f, at, at + d + 0.05);
  if (f1) glide(o.frequency, at, f, f1, d);
  const g = v.gain(0, v.out);
  o.connect(g);
  perc(g.gain, at, amp, 0.001, d);
}

// A filtered noise burst into the voice.
function puff(v: Voice, bank: NoiseBank, kind: BiquadFilterType, at: number, f: number, q: number, amp: number, d: number) {
  const n = v.noise(bank.white, at, at + d + 0.08);
  const fl = v.filter(kind, f, q);
  n.connect(fl);
  const g = v.gain(0, v.out);
  fl.connect(g);
  perc(g.gain, at, amp, 0.0006, d);
}

/** A rail striking a wall/floor: a dry crack, a fizzing spark tail and a short ricochet ping. */
export function wallImpact(v: Voice, bank: NoiseBank) {
  const t = v.t;
  puff(v, bank, 'highpass', t, 3000, 0.8, 0.7, 0.03);
  puff(v, bank, 'bandpass', t + 0.01, rr(1800, 3200), 3, 0.5, 0.12);
  tone(v, 'sine', t, rr(1400, 2000), 0.1, 0.16, 700);
  tone(v, 'sine', t, 150, 0.22, 0.08, 70);
}

export function finisherAccent(v: Voice, bank: NoiseBank, style: string) {
  const t = v.t;
  switch (style) {
    case 'nova':
      // Rising shimmer into a low boom.
      tone(v, 'sawtooth', t, 220, 0.12, 0.28, 1500);
      tone(v, 'sine', t + 0.12, 96, 0.45, 0.4, 34);
      puff(v, bank, 'highpass', t + 0.1, 5000, 0.7, 0.35, 0.22);
      return;
    case 'starburst':
      for (let i = 0; i < 6; i++) tone(v, 'sine', t + i * 0.035 + rr(0, 0.02), rr(2400, 5200), 0.16, rr(0.12, 0.28));
      return;
    case 'voxel':
      // Digital crunch: stepped square blips (a coarse "bitcrush").
      for (let i = 0; i < 7; i++) tone(v, 'square', t + i * 0.024, 180 + Math.floor(rnd() * 8) * 130, 0.1, 0.03);
      puff(v, bank, 'bandpass', t, 2400, 1.2, 0.5, 0.05);
      return;
    case 'ember':
      // Fire crackle over a low whoosh.
      for (let i = 0; i < 9; i++) puff(v, bank, 'highpass', t + rr(0.02, 0.4), rr(2500, 6000), 0.9, rr(0.3, 0.7), 0.012);
      puff(v, bank, 'lowpass', t, 900, 0.7, 0.4, 0.4);
      return;
    case 'gibstorm':
      // Extra wet chunks flying.
      for (let i = 0; i < 6; i++) puff(v, bank, 'bandpass', t + rr(0.02, 0.35), rr(300, 1200), 4, rr(1.2, 2), 0.06);
      tone(v, 'sine', t, 70, 0.4, 0.3, 32);
      return;
    case 'singularity':
      // Inward suck (rising), then a deep thud as it collapses.
      puff(v, bank, 'lowpass', t, 300, 1.4, 0.5, 0.28);
      tone(v, 'sine', t, 90, 0.25, 0.26, 700);
      tone(v, 'sine', t + 0.26, 62, 0.6, 0.45, 26);
      return;
    case 'prism':
      // A crystalline chime arpeggio.
      [1568, 2093, 2637, 3136].forEach((f, i) => tone(v, 'sine', t + i * 0.045, f, 0.16, 0.34));
      return;
    case 'derez':
      // Glitchy descending stutter.
      for (let i = 0; i < 5; i++) tone(v, 'sawtooth', t + i * 0.05, 1400 - i * 230, 0.09, 0.04, 900 - i * 170);
      puff(v, bank, 'highpass', t, 6000, 0.7, 0.3, 0.07);
      return;
    case 'shatter':
      // Glass: a bright crack, scattered pings.
      puff(v, bank, 'highpass', t, 5200, 0.8, 0.8, 0.06);
      for (let i = 0; i < 7; i++) tone(v, 'triangle', t + rr(0.01, 0.3), rr(3200, 7000), rr(0.1, 0.22), rr(0.05, 0.14));
      return;
    case 'confetti':
      // Party pop + sparkle.
      puff(v, bank, 'bandpass', t, 1300, 1.5, 1.3, 0.035);
      tone(v, 'sine', t, 320, 0.4, 0.09, 110);
      for (let i = 0; i < 5; i++) tone(v, 'sine', t + 0.05 + i * 0.04, rr(2600, 4200), 0.1, 0.12);
      return;
    case 'overload': {
      // Electrical zap: a buzzing saw with a fast wobble + crackle.
      const o = v.osc('sawtooth', 130, t, t + 0.34);
      const lfo = v.osc('square', 58, t, t + 0.34);
      const dep = v.gain(70);
      lfo.connect(dep);
      dep.connect(o.frequency);
      glide(o.frequency, t, 130, 60, 0.3);
      const lp = v.filter('lowpass', 2600, 1.2);
      o.connect(lp);
      const g = v.gain(0, v.out);
      lp.connect(g);
      perc(g.gain, t, 0.28, 0.002, 0.3);
      for (let i = 0; i < 6; i++) puff(v, bank, 'highpass', t + rr(0, 0.25), rr(3500, 7000), 1, rr(0.4, 0.9), 0.01);
      return;
    }
    case 'vaporize':
      // A long hiss as the body boils away.
      puff(v, bank, 'highpass', t, 4200, 0.6, 0.55, 0.42);
      tone(v, 'sine', t, 1800, 0.08, 0.35, 500);
      return;
    case 'pulse':
    default:
      return; // the base gib is the default finisher's whole sound
  }
}
