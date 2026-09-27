// ── Movement synthesis: footsteps, jumps, landings, dash, wall-kick, boost ───
// Same Voice contract as weapon-sfx.ts. Footsteps / landings / wall kicks take
// the map's SurfaceProfile, so Reactor's steel grates ring and Lounge's floor
// thuds. Body / scuff / whoosh layers are pink noise (low-mid weight); heel
// clicks and grit are white noise (top end).
import { clamp, glide, perc, rr, vary, type NoiseBank, type Voice } from './core';

export type SurfaceProfile = {
  /** Heel-thump pitch, Hz. */
  thump: number;
  /** Scuff low-pass, Hz (brighter = harder floor). */
  body: number;
  /** Heel-click band, Hz. */
  click: number;
  /** Click / grit amount 0..1 (grit, gravel, grating rattle). */
  grit: number;
  /** Resonant ring of the floor (metal), Hz — 0 for none. */
  ring: number;
  ringQ: number;
  ringAmt: number;
};

/** One footfall. `speed01` (0 walk … 1 full run) adds weight. */
export function footstep(v: Voice, bank: NoiseBank, s: SurfaceProfile, speed01: number) {
  const t = v.t;
  const p = v.noise(bank.pink, t, t + 0.2, vary(1, 0.1));
  const lp = v.filter('lowpass', vary(s.body, 0.18), 0.8);
  p.connect(lp);
  const g = v.gain(0, v.out);
  lp.connect(g);
  perc(g.gain, t + rr(0, 0.006), 1.0 + 0.35 * speed01, 0.003, vary(0.09, 0.2));
  const w = v.noise(bank.white, t, t + 0.04);
  const bp = v.filter('bandpass', vary(s.click, 0.2), 1.6);
  w.connect(bp);
  const cg = v.gain(0, v.out);
  bp.connect(cg);
  perc(cg.gain, t, 1.8 * s.grit, 0.0006, 0.025);
  const f = vary(s.thump, 0.1);
  const o = v.osc('sine', f, t, t + 0.1);
  glide(o.frequency, t, f, f * 0.6, 0.06);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.2 + 0.1 * speed01, 0.002, 0.07);
  if (s.ringAmt > 0) {
    const rb = v.filter('bandpass', vary(s.ring, 0.04), s.ringQ);
    p.connect(rb);
    const rg = v.gain(0, v.out);
    rb.connect(rg);
    perc(rg.gain, t, s.ringAmt * 4, 0.001, 0.15);
  }
}

/**
 * Ground jump: boot push-off scuff + a short air whoosh, plus (when `hup`)
 * a synthetic Q3-style "hup" — a glottal sawtooth through three vowel formants
 * with an aspirated "h" onset and a clipped "p" end.
 */
export function jump(v: Voice, bank: NoiseBank, s: SurfaceProfile, hup: boolean) {
  const t = v.t;
  const p = v.noise(bank.pink, t, t + 0.3);
  const lp = v.filter('lowpass', s.body * 1.2, 0.8);
  p.connect(lp);
  const g = v.gain(0, v.out);
  lp.connect(g);
  perc(g.gain, t, 0.8, 0.002, 0.06);
  const bp = v.filter('bandpass', 500, 0.9);
  glide(bp.frequency, t, 500, 1700, 0.18);
  p.connect(bp);
  const wg = v.gain(0, v.out);
  bp.connect(wg);
  perc(wg.gain, t + 0.01, 0.6, 0.03, 0.2);
  if (!hup) return;
  const f0 = vary(132, 0.08);
  const at = t + 0.015;
  const src = v.osc('sawtooth', f0, at, at + 0.2);
  src.frequency.linearRampToValueAtTime(f0 * 1.12, at + 0.04);
  src.frequency.linearRampToValueAtTime(f0 * 0.9, at + 0.13);
  const voiced = v.gain(0);
  src.connect(voiced);
  voiced.gain.setValueAtTime(0, at);
  voiced.gain.linearRampToValueAtTime(1, at + 0.014);
  voiced.gain.setTargetAtTime(0.55, at + 0.02, 0.05);
  voiced.gain.setTargetAtTime(0, at + 0.115, 0.008); // the clipped "p"
  // Aspiration: the "h" before the vowel, through the same formants.
  const w = v.noise(bank.white, t, t + 0.08);
  const asp = v.gain(0);
  w.connect(asp);
  perc(asp.gain, t, 0.6, 0.006, 0.05);
  const formants: ReadonlyArray<readonly [number, number, number]> = [
    [vary(640, 0.05), 6, 0.5],
    [vary(1150, 0.05), 8, 0.32],
    [2450, 9, 0.13],
  ];
  for (const [f, q, amp] of formants) {
    const fb = v.filter('bandpass', f, q);
    voiced.connect(fb);
    asp.connect(fb);
    const fg = v.gain(amp, v.out);
    fb.connect(fg);
  }
}

/** Double jump: a thruster puff — rising band-passed burst + a "fwip" chirp. */
export function airJump(v: Voice, bank: NoiseBank) {
  const t = v.t;
  const n = v.noise(bank.pink, t, t + 0.3);
  const bp = v.filter('bandpass', 300, 1.4);
  glide(bp.frequency, t, 300, 2400, 0.22);
  n.connect(bp);
  const g = v.gain(0, v.out);
  bp.connect(g);
  perc(g.gain, t, 1.1, 0.01, 0.22);
  const o = v.osc('sine', 220, t, t + 0.18);
  glide(o.frequency, t, 220, 540, 0.14);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.12, 0.005, 0.15);
  const p = v.osc('sine', 92, t, t + 0.1);
  glide(p.frequency, t, 92, 58, 0.07);
  const pg = v.gain(0, v.out);
  p.connect(pg);
  perc(pg.gain, t, 0.25, 0.003, 0.08);
}

/**
 * Landing thud scaled by impact speed (m/s): a soft touchdown near 4 m/s, a
 * heavy body-slam + gear rattle at 20+ m/s (big falls, boost arcs).
 */
export function land(v: Voice, bank: NoiseBank, s: SurfaceProfile, impact: number) {
  const t = v.t;
  const k = clamp((impact - 3) / 17, 0, 1);
  const f = 78 - 22 * k;
  const o = v.osc('sine', f, t, t + 0.32);
  glide(o.frequency, t, f, 38, 0.1 + 0.1 * k);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.3 + 0.3 * k, 0.002, 0.08 + 0.14 * k);
  const p = v.noise(bank.pink, t, t + 0.35);
  const lp = v.filter('lowpass', s.body * (0.6 + 1.0 * k), 0.9);
  p.connect(lp);
  const ng = v.gain(0, v.out);
  lp.connect(ng);
  perc(ng.gain, t, 1.0 + 0.8 * k, 0.002, 0.07 + 0.13 * k);
  const w = v.noise(bank.white, t, t + 0.12);
  const bp = v.filter('bandpass', vary(s.click, 0.15), 1.6);
  w.connect(bp);
  const cg = v.gain(0, v.out);
  bp.connect(cg);
  perc(cg.gain, t, 1.2 * s.grit * (0.5 + 0.5 * k), 0.0006, 0.03);
  if (k > 0.3) {
    // Gear rattle: armour plates settling a beat after the slam.
    const rb = v.filter('bandpass', 2300, 3);
    w.connect(rb);
    const rg = v.gain(0, v.out);
    rb.connect(rg);
    perc(rg.gain, t + 0.022, 1.4 * k, 0.001, 0.07);
  }
  if (s.ringAmt > 0) {
    const rb = v.filter('bandpass', s.ring * 0.92, s.ringQ);
    p.connect(rb);
    const rg = v.gain(0, v.out);
    rb.connect(rg);
    perc(rg.gain, t, s.ringAmt * (3 + 3.5 * k), 0.001, 0.2 + 0.15 * k);
  }
}

/**
 * Dash: a band-passed whoosh swept up and back down that pans across you
 * (`lateral` -1 left … +1 right), a low thrust thump, and a faint energy buzz.
 */
export function dash(v: Voice, bank: NoiseBank, lateral: number, wide: boolean) {
  const t = v.t;
  const n = v.noise(bank.pink, t, t + 0.4);
  const bp = v.filter('bandpass', 700, 1.3);
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.exponentialRampToValueAtTime(3200, t + 0.09);
  bp.frequency.exponentialRampToValueAtTime(850, t + 0.32);
  n.connect(bp);
  const g = v.gain(0);
  bp.connect(g);
  perc(g.gain, t, 1.2, 0.02, 0.3);
  if (wide) {
    const p = v.pan(0.5 * lateral);
    p.pan.setValueAtTime(0.5 * lateral, t);
    p.pan.linearRampToValueAtTime(-0.5 * lateral, t + 0.3);
    g.connect(p).connect(v.out);
  } else {
    g.connect(v.out);
  }
  const o = v.osc('sine', 115, t, t + 0.18);
  glide(o.frequency, t, 115, 62, 0.12);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.35, 0.004, 0.13);
  const b = v.osc('sawtooth', 180, t, t + 0.26);
  glide(b.frequency, t, 180, 88, 0.22);
  const bl = v.filter('lowpass', 900);
  b.connect(bl);
  const bg = v.gain(0, v.out);
  bl.connect(bg);
  perc(bg.gain, t, 0.08, 0.005, 0.22);
}

/** Wall-jump kick: a solid boot "tok" on the wall + the surface ring + a short whoosh. */
export function wallKick(v: Voice, bank: NoiseBank, s: SurfaceProfile) {
  const t = v.t;
  const n = v.noise(bank.pink, t, t + 0.3);
  const bp = v.filter('bandpass', vary(650, 0.08), 2.5);
  n.connect(bp);
  const g = v.gain(0, v.out);
  bp.connect(g);
  perc(g.gain, t, 2.2, 0.0008, 0.05);
  const o = v.osc('sine', 165, t, t + 0.12);
  glide(o.frequency, t, 165, 88, 0.07);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.45, 0.001, 0.08);
  if (s.ringAmt > 0) {
    const rb = v.filter('bandpass', s.ring * 1.08, s.ringQ);
    n.connect(rb);
    const rg = v.gain(0, v.out);
    rb.connect(rg);
    perc(rg.gain, t, s.ringAmt * 5, 0.001, 0.22);
  }
  const wb = v.filter('bandpass', 600, 1);
  glide(wb.frequency, t, 600, 1800, 0.16);
  n.connect(wb);
  const wg = v.gain(0, v.out);
  wb.connect(wg);
  perc(wg.gain, t + 0.02, 0.45, 0.03, 0.18);
}

/**
 * Boost jump: a damage-free rocket-jump — sub "vwoomp", a low-pass-swept blast,
 * a rising whoosh, and a cyan energy crackle.
 */
export function boost(v: Voice, bank: NoiseBank, detail: number) {
  const t = v.t;
  const o = v.osc('sine', 96, t, t + 0.45);
  glide(o.frequency, t, 96, 32, 0.3);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.6, 0.002, 0.36);
  const n = v.noise(bank.pink, t, t + 0.5);
  const lp = v.filter('lowpass', 2600, 0.9);
  glide(lp.frequency, t, 2600, 380, 0.3);
  n.connect(lp);
  const g = v.gain(0, v.out);
  lp.connect(g);
  perc(g.gain, t, 1.1, 0.002, 0.3);
  const bp = v.filter('bandpass', 300, 1.2);
  glide(bp.frequency, t, 300, 2600, 0.34);
  n.connect(bp);
  const wg = v.gain(0, v.out);
  bp.connect(wg);
  perc(wg.gain, t + 0.02, 0.8, 0.04, 0.34);
  if (detail >= 1) {
    const s = v.osc('sawtooth', 70, t, t + 0.32);
    const sl = v.filter('lowpass', 800, 3);
    glide(sl.frequency, t, 800, 3000, 0.25);
    s.connect(sl);
    const sg = v.gain(0, v.out);
    sl.connect(sg);
    perc(sg.gain, t, 0.13, 0.005, 0.26);
  }
}
