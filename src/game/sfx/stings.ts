// ── Medal stings ─────────────────────────────────────────────────────────────
// Short procedural cues, one family per medal tier (no voice lines). Played in
// place of the announcer when the headline medal can't be voiced (announcer
// off / no clip or TTS available), so no medal ever lands silently.
import { glide, perc, type Voice } from './core';

export type StingKind = 'special' | 'multi' | 'streak';

// E-minor pentatonic, ascending — the multi-kill arpeggio climbs one note per kill.
const ARP = [659.3, 784, 987.8, 1174.7, 1318.5];

export function medalSting(v: Voice, kind: StingKind, level: number) {
  const t = v.t;
  if (kind === 'special') {
    // Bright bell fifth: two chorused triangle pairs.
    const note = (at: number, f: number, amp: number) => {
      for (const d of [0, 2.4]) {
        const o = v.osc('triangle', f + d, at, at + 0.5);
        const g = v.gain(0, v.out);
        o.connect(g);
        perc(g.gain, at, amp, 0.003, 0.45);
      }
    };
    note(t, 880, 0.12);
    note(t + 0.075, 1318.5, 0.1);
    return;
  }
  if (kind === 'multi') {
    // Rapid ascending arpeggio, one note per kill in the chain (2..5).
    const count = Math.max(2, Math.min(5, level));
    const lp = v.filter('lowpass', 3400, 0.8);
    lp.connect(v.out);
    for (let i = 0; i < count; i++) {
      const at = t + i * 0.055;
      const o = v.osc('square', ARP[i], at, at + 0.26);
      const g = v.gain(0, lp);
      o.connect(g);
      perc(g.gain, at, 0.17, 0.002, i === count - 1 ? 0.24 : 0.12);
    }
    return;
  }
  // Streak: a power-chord swell (root, fifth, octave) through an opening
  // low-pass; higher streaks sit higher and brighter.
  const lvl = Math.max(1, Math.min(5, level));
  const root = 110 * Math.pow(2, (lvl - 1) * (2 / 12));
  const lp = v.filter('lowpass', 500, 2);
  glide(lp.frequency, t, 500, 2600 + 500 * lvl, 0.25);
  const g = v.gain(0, v.out);
  lp.connect(g);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.06);
  g.gain.setTargetAtTime(0, t + 0.12, 0.14);
  for (const r of [1, 1.4983, 2, 2.004]) {
    const o = v.osc('sawtooth', root * r, t, t + 0.9);
    o.connect(lp);
  }
}
