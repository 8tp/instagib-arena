// ── Weapon + combat feedback synthesis ───────────────────────────────────────
// Each function writes one sound into a Voice (all layers end at `v.out`); the
// engine decides the routing (HUD / world + reverb / 3D) and pools the voice.
// Body / splat layers use pink noise (real low-mid energy); crack / hiss /
// click layers use white noise (real top end).
import { glide, perc, rr, vary, type NoiseBank, type Voice } from './core';

/**
 * Railgun discharge — five layers:
 *  1. thump + body (the weight): pitch-dropped sub sine, an upper-bass
 *     triangle punch, and a band-passed pink "whump" in the low mids
 *  2. crack + sizzle: broadband transient, then band-passed hiss chopped by a
 *     mains-like square (the electrical "bzzt")
 *  3. zap: FM sawtooth sweeping down (the discharge)
 *  4. ring / whine tail: beating metallic partials gliding down; on the local
 *     shot the near-unison pair is hard-panned → width + slow stereo shimmer
 *  5. slug air: a band-passed whoosh sweeping down (local only)
 * `wide` = local first-person shot; `detail` < 1 thins layers for remote (3D)
 * shots, which also keeps their node count low.
 */
export function railShot(v: Voice, bank: NoiseBank, wide: boolean, detail: number) {
  const t = v.t;
  const out = v.out;
  const full = detail >= 1;

  // 1. Thump + body.
  {
    const o = v.osc('sine', 120, t, t + 0.4);
    glide(o.frequency, t, 120, 36, 0.17);
    const g = v.gain(0, out);
    o.connect(g);
    perc(g.gain, t, full ? 0.7 : 0.3, 0.002, 0.3);
    const o2 = v.osc('triangle', 230, t, t + 0.2);
    glide(o2.frequency, t, 230, 72, 0.09);
    const g2 = v.gain(0, out);
    o2.connect(g2);
    perc(g2.gain, t, full ? 0.6 : 0.3, 0.001, 0.16);
    const n = v.noise(bank.pink, t, t + 0.25);
    const bp = v.filter('bandpass', 280, 0.9);
    n.connect(bp);
    const bg = v.gain(0, out);
    bp.connect(bg);
    perc(bg.gain, t, full ? 2.2 : 1.0, 0.002, 0.17);
  }

  // 2. Crack + sizzle (one white source feeds both bands).
  {
    const n = v.noise(bank.white, t, t + (full ? 0.7 : 0.35));
    const hp = v.filter('highpass', 1900);
    n.connect(hp);
    const g = v.gain(0, out);
    hp.connect(g);
    perc(g.gain, t, full ? 1.5 : 1.9, 0.0008, 0.085);
    const bp = v.filter('bandpass', 5400, 1.2);
    n.connect(bp);
    const sz = v.gain(0, out);
    bp.connect(sz);
    const szAmp = full ? 1.3 : 1.1;
    perc(sz.gain, t + 0.003, szAmp, 0.004, full ? 0.6 : 0.3);
    if (full) {
      const buzz = v.osc('square', 96, t, t + 0.65);
      const depth = v.gain(0);
      buzz.connect(depth);
      depth.connect(sz.gain);
      perc(depth.gain, t + 0.003, szAmp * 0.8, 0.004, 0.52);
    }
  }

  // 3. Zap.
  {
    const o = v.osc('sawtooth', 2700, t, t + 0.26);
    glide(o.frequency, t, 2700, 170, 0.17);
    const lp = v.filter('lowpass', 6500, 0.9);
    o.connect(lp);
    const g = v.gain(0, out);
    lp.connect(g);
    perc(g.gain, t, 0.3, 0.001, 0.2);
    if (full) {
      const m = v.osc('sine', 463, t, t + 0.22);
      const md = v.gain(0);
      m.connect(md);
      md.connect(o.frequency);
      perc(md.gain, t, 900, 0.001, 0.16);
    }
  }

  // 4. Ring / whine tail.
  {
    const base = vary(1760, 0.012);
    // [ratio, amplitude, decay seconds]
    const partials: ReadonlyArray<readonly [number, number, number]> = full
      ? [[1, 0.16, 1.15], [1.0036, 0.16, 1.15], [2.76, 0.07, 0.5], [5.4, 0.03, 0.26], [0.5, 0.08, 0.7]]
      : [[1, 0.17, 0.85], [2.76, 0.05, 0.35]];
    let i = 0;
    for (const [ratio, amp, decay] of partials) {
      const f = base * ratio;
      const o = v.osc('sine', f, t, t + decay + 0.08);
      glide(o.frequency, t, f, f * 0.955, decay);
      const g = v.gain(0);
      o.connect(g);
      perc(g.gain, t + 0.004, amp, 0.012, decay);
      if (wide && i < 2) g.connect(v.pan(i === 0 ? -0.6 : 0.6)).connect(out);
      else g.connect(out);
      i++;
    }
  }

  // 5. Slug air.
  if (full) {
    const n = v.noise(bank.white, t, t + 0.45);
    const bp = v.filter('bandpass', 5000, 1.1);
    glide(bp.frequency, t, 5000, 650, 0.34);
    n.connect(bp);
    const g = v.gain(0, out);
    bp.connect(g);
    perc(g.gain, t + 0.01, 0.35, 0.02, 0.36);
  }
}

/**
 * Recharge hum (local only, deliberately quiet): a detuned sawtooth pair
 * rising an octave through a resonant low-pass that opens as the coils
 * charge, plus a faint whine. Cut off when the rail is ready — the ready cue
 * takes over.
 */
export function chargeHum(v: Voice, dur: number) {
  const t = v.t;
  const end = t + dur;
  const lp = v.filter('lowpass', 240, 4.5);
  glide(lp.frequency, t, 240, 1900, dur);
  for (const f of [55, 55.8]) {
    const o = v.osc('sawtooth', f, t, end + 0.06);
    glide(o.frequency, t, f, f * 2, dur);
    o.connect(lp);
  }
  const g = v.gain(0, v.out);
  lp.connect(g);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.0033, t + 0.25);
  g.gain.linearRampToValueAtTime(0.0066, end - 0.05);
  g.gain.linearRampToValueAtTime(0, end + 0.03);
  const w = v.osc('sine', 820, t, end + 0.06);
  glide(w.frequency, t, 820, 1640, dur);
  const wg = v.gain(0, v.out);
  w.connect(wg);
  wg.gain.setValueAtTime(0, t);
  wg.gain.linearRampToValueAtTime(0.0014, end - 0.05);
  wg.gain.linearRampToValueAtTime(0, end + 0.02);
}

/** Rail ready: a mechanical latch (click + low clunk) then two quick bright pips. */
export function readyCue(v: Voice, bank: NoiseBank) {
  const t = v.t;
  const n = v.noise(bank.white, t, t + 0.03);
  const bp = v.filter('bandpass', 3600, 2);
  n.connect(bp);
  const cg = v.gain(0, v.out);
  bp.connect(cg);
  perc(cg.gain, t, 0.7, 0.0005, 0.02);
  const k = v.osc('sine', 190, t, t + 0.08);
  const kg = v.gain(0, v.out);
  k.connect(kg);
  perc(kg.gain, t, 0.2, 0.002, 0.06);
  const pip = (at: number, f: number, amp: number, d: number) => {
    const o = v.osc('triangle', f, at, at + d + 0.02);
    const g = v.gain(0, v.out);
    o.connect(g);
    perc(g.gain, at, amp, 0.002, d);
  };
  pip(t + 0.012, 1480, 0.2, 0.08);
  pip(t + 0.068, 2220, 0.17, 0.13);
}

/**
 * Hit tick — the Q3-style "tink": a short square blip (bright, pitched, with a
 * 3% downward flick) + its octave + a tiny contact click. Headshot is a higher
 * double tick ("ti-tink"), unmistakably different.
 */
export function hitTick(v: Voice, bank: NoiseBank, headshot: boolean) {
  const t = v.t;
  const tick = (at: number, f: number, amp: number) => {
    const o = v.osc('square', f, at, at + 0.11);
    glide(o.frequency, at, f, f * 0.97, 0.07);
    const lp = v.filter('lowpass', 7500, 0.7);
    o.connect(lp);
    const g = v.gain(0, v.out);
    lp.connect(g);
    perc(g.gain, at, amp, 0.0008, 0.085);
    const s = v.osc('sine', f * 2, at, at + 0.07);
    const sg = v.gain(0, v.out);
    s.connect(sg);
    perc(sg.gain, at, amp * 0.5, 0.0005, 0.05);
  };
  const n = v.noise(bank.white, t, t + 0.02);
  const hp = v.filter('highpass', 3500);
  n.connect(hp);
  const cg = v.gain(0, v.out);
  hp.connect(cg);
  perc(cg.gain, t, 0.8, 0.0003, 0.012);
  if (headshot) {
    tick(t, 2350, 0.6);
    tick(t + 0.052, 3140, 0.5);
  } else {
    tick(t, 1780, 0.72);
  }
}

/**
 * Kill confirm / gib — the body bursting: a wet splat (low-pass-swept pink
 * noise), a squelch (wobbling band-pass), a body thump, and a few flying
 * chunks. The headshot variant adds a bright skull crack + ping. `detail` < 1
 * (bystander gibs heard in 3D) keeps just the splat, thump and one chunk.
 */
export function gib(v: Voice, bank: NoiseBank, headshot: boolean, detail: number) {
  const t = v.t;
  const full = detail >= 1;
  const n = v.noise(bank.pink, t, t + 0.6);
  const lp = v.filter('lowpass', 2600, 1.3);
  glide(lp.frequency, t, 2600, 180, 0.36);
  n.connect(lp);
  const g = v.gain(0, v.out);
  lp.connect(g);
  perc(g.gain, t, 0.8, 0.002, 0.4);
  if (full) {
    const bp = v.filter('bandpass', 850, 4);
    n.connect(bp);
    const lfo = v.osc('sine', 27, t, t + 0.4);
    const dep = v.gain(380);
    lfo.connect(dep);
    dep.connect(bp.frequency);
    const sg = v.gain(0, v.out);
    bp.connect(sg);
    perc(sg.gain, t + 0.01, 1.3, 0.004, 0.26);
  }
  const o = v.osc('sine', 104, t, t + 0.4);
  glide(o.frequency, t, 104, 40, 0.2);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.35, 0.002, 0.26);
  const chunks = full ? 3 : 1;
  for (let i = 0; i < chunks; i++) {
    const at = t + rr(0.03, 0.2);
    const cb = v.filter('bandpass', rr(500, 1600), 5);
    n.connect(cb);
    const cg = v.gain(0, v.out);
    cb.connect(cg);
    perc(cg.gain, at, rr(1.5, 2.2), 0.001, 0.05);
  }
  if (headshot) {
    const w = v.noise(bank.white, t, t + 0.06);
    const hp = v.filter('highpass', 4000);
    w.connect(hp);
    const hg = v.gain(0, v.out);
    hp.connect(hg);
    perc(hg.gain, t, 0.7, 0.0005, 0.035);
    const p = v.osc('sine', 2640, t, t + 0.34);
    const pg = v.gain(0, v.out);
    p.connect(pg);
    perc(pg.gain, t + 0.002, 0.14, 0.001, 0.3);
  }
}

/** You got railed: a muffled boom + rumble, a mid crunch, and a falling power-down tone. */
export function death(v: Voice, bank: NoiseBank) {
  const t = v.t;
  const o = v.osc('sine', 74, t, t + 0.7);
  glide(o.frequency, t, 74, 28, 0.5);
  const og = v.gain(0, v.out);
  o.connect(og);
  perc(og.gain, t, 0.42, 0.003, 0.6);
  const n = v.noise(bank.pink, t, t + 0.8);
  const lp = v.filter('lowpass', 700, 0.9);
  glide(lp.frequency, t, 700, 110, 0.6);
  n.connect(lp);
  const ng = v.gain(0, v.out);
  lp.connect(ng);
  perc(ng.gain, t, 0.75, 0.004, 0.7);
  const bp = v.filter('bandpass', 900, 1);
  n.connect(bp);
  const bg = v.gain(0, v.out);
  bp.connect(bg);
  perc(bg.gain, t, 1.2, 0.002, 0.18);
  const s = v.osc('sawtooth', 520, t, t + 0.7);
  glide(s.frequency, t, 520, 90, 0.55);
  const sl = v.filter('lowpass', 1400);
  s.connect(sl);
  const sg = v.gain(0, v.out);
  sl.connect(sg);
  perc(sg.gain, t, 0.3, 0.01, 0.6);
}
