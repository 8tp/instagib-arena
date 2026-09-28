// ── Menu / UI cue synthesis ───────────────────────────────────────────────────
// Every deck + rewards cue as a few oscillator / noise nodes — no assets, so the
// whole bank costs nothing to load and always plays instantly. Pure WebAudio on
// a BaseAudioContext, so the same code renders in an OfflineAudioContext for
// loudness checks. The live context, the bus level and the gesture rules live
// in src/game/audio.ts (UiSoundBank); this file only knows how each cue sounds.
//
// Mix intent: short and tasteful, well under gameplay. Single-voice ticks peak
// around -22 dBFS before the bus trim; the big moments (level up, legendary
// unlock) stay under about -12 dBFS. The bus runs through a soft compressor so
// a fast run of cues can never stack into a spike.

export type UiSoundName =
  // Deck chrome
  | 'uiHover'
  | 'uiClick'
  | 'uiConfirm'
  | 'uiBack'
  | 'uiError'
  | 'uiToggle' // detail: 1 = switched on (up), 0 = off (down)
  | 'tabSwitch'
  | 'modalOpen'
  | 'modalClose'
  // Economy / locker
  | 'equip'
  | 'purchase' // ka-ching
  | 'caseTick' // detail: 0..1 spin progress (slightly brightens toward the stop)
  | 'caseReveal'
  // Rewards
  | 'xpTick' // detail: the line index (pitch climbs a pentatonic ladder)
  | 'levelUp'
  | 'unlock' // detail: rarity index 0..3 → the matching variant below
  | 'unlockCommon'
  | 'unlockRare'
  | 'unlockEpic'
  | 'unlockLegendary'
  | 'countdownTick' // detail: seconds left (1 = the last, higher tick)
  | 'stamp'; // a heavy slam; detail > 0 victory colour, < 0 defeat colour

export const UI_SOUND_NAMES: readonly UiSoundName[] = [
  'uiHover',
  'uiClick',
  'uiConfirm',
  'uiBack',
  'uiError',
  'uiToggle',
  'tabSwitch',
  'modalOpen',
  'modalClose',
  'equip',
  'purchase',
  'caseTick',
  'caseReveal',
  'xpTick',
  'levelUp',
  'unlock',
  'unlockCommon',
  'unlockRare',
  'unlockEpic',
  'unlockLegendary',
  'countdownTick',
  'stamp',
];

// Cues that only ever answer a direct click / key press. Everything else can
// fire from a timer (the rewards reveal, a case spin, a modal mounted by the
// engine) and must never create or resume the AudioContext on its own.
const GESTURE_CUES: ReadonlySet<UiSoundName> = new Set<UiSoundName>([
  'uiClick',
  'uiConfirm',
  'uiBack',
  'uiError',
  'uiToggle',
  'tabSwitch',
  'equip',
]);
// ('purchase' is not here: it plays on the server's reply and from the rewards
// reveal's timers — never inside the click itself.)

export function isGestureUiSound(name: UiSoundName): boolean {
  return GESTURE_CUES.has(name);
}

export const RARITY_UNLOCK: readonly UiSoundName[] = ['unlockCommon', 'unlockRare', 'unlockEpic', 'unlockLegendary'];

/* ── Primitives ─────────────────────────────────────────────────────────── */

type Ctx = BaseAudioContext;
const FLOOR = 0.0001;

// ±amt random detune so a repeated cue never sounds machine-stamped.
function jit(f: number, amt: number): number {
  return f * (1 + (Math.random() * 2 - 1) * amt);
}

// One oscillator with a fast attack and an exponential release, optionally
// swept f0 → f1 over its length.
function tone(
  ctx: Ctx,
  dest: AudioNode,
  t0: number,
  o: { type?: OscillatorType; f0: number; f1?: number; dur: number; peak: number; attack?: number; detune?: number },
) {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, t0);
  if (o.f1 !== undefined && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  const a = o.attack ?? 0.003;
  g.gain.setValueAtTime(FLOOR, t0);
  g.gain.exponentialRampToValueAtTime(o.peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(FLOOR, t0 + Math.max(a + 0.005, o.dur));
  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

// A 1 s white-noise buffer per context, reused by every noise voice (started at
// a random offset so consecutive ticks don't share a grain).
const noiseCache = new WeakMap<Ctx, AudioBuffer>();
function noiseBuffer(ctx: Ctx): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

// Filtered noise: a click, a whoosh (swept band) or a shimmer (highpass).
function noise(
  ctx: Ctx,
  dest: AudioNode,
  t0: number,
  o: { type?: BiquadFilterType; f0: number; f1?: number; q?: number; dur: number; peak: number; attack?: number },
) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.f0, t0);
  if (o.f1 !== undefined && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const a = o.attack ?? 0.001;
  g.gain.setValueAtTime(FLOOR, t0);
  g.gain.exponentialRampToValueAtTime(o.peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(FLOOR, t0 + Math.max(a + 0.004, o.dur));
  src.connect(f).connect(g).connect(dest);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + o.dur + 0.02);
}

// A bell-ish partial stack: fundamental + a couple of slightly inharmonic
// overtones that die faster (coins, chimes, sparkles).
function bell(ctx: Ctx, dest: AudioNode, t0: number, f: number, dur: number, peak: number) {
  tone(ctx, dest, t0, { f0: f, dur, peak, attack: 0.002 });
  tone(ctx, dest, t0, { f0: f * 2.01, dur: dur * 0.6, peak: peak * 0.4, attack: 0.002 });
  tone(ctx, dest, t0, { f0: f * 3.02, dur: dur * 0.35, peak: peak * 0.18, attack: 0.002 });
}

// A soft brassy note: triangle body + a lowpassed square edge.
function brass(ctx: Ctx, dest: AudioNode, t0: number, f: number, dur: number, peak: number, cutoff = 2400) {
  tone(ctx, dest, t0, { type: 'triangle', f0: f, dur, peak, attack: 0.006 });
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.connect(dest);
  tone(ctx, lp, t0, { type: 'square', f0: f, dur: dur * 0.8, peak: peak * 0.3, attack: 0.01 });
}

// A held chord that swells in and decays (the "arrival" under a fanfare).
function pad(ctx: Ctx, dest: AudioNode, t0: number, freqs: readonly number[], dur: number, peak: number, attack = 0.02) {
  for (const f of freqs) tone(ctx, dest, t0, { f0: f, dur, peak, attack });
}

// Descending sparkle blips (the glitter on unlocks).
function sparkle(ctx: Ctx, dest: AudioNode, t0: number, count: number, hi: number, lo: number, step: number, peak: number) {
  for (let i = 0; i < count; i++) {
    const f = hi * Math.pow(lo / hi, count > 1 ? i / (count - 1) : 0);
    tone(ctx, dest, t0 + i * step, { f0: jit(f, 0.01), dur: 0.06, peak, attack: 0.002 });
  }
}

// Semitone ladder the XP ticks climb (a major pentatonic, so any run of ticks
// is musical rather than a chromatic whine).
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
const semi = (base: number, n: number) => base * Math.pow(2, n / 12);

/* ── Cues ───────────────────────────────────────────────────────────────── */

// Schedule `name` on `dest` starting at `t0` (seconds, ctx time). `detail` is a
// per-cue parameter (see UiSoundName). Returns nothing; nodes clean themselves
// up when they stop.
export function playUiCue(ctx: Ctx, dest: AudioNode, name: UiSoundName, t0: number, detail = 0): void {
  switch (name) {
    case 'uiHover':
      tone(ctx, dest, t0, { f0: jit(1850, 0.015), f1: 1700, dur: 0.028, peak: 0.04 });
      break;
    case 'uiClick':
      tone(ctx, dest, t0, { type: 'triangle', f0: jit(1400, 0.02), f1: 900, dur: 0.034, peak: 0.12 });
      noise(ctx, dest, t0, { f0: 2600, q: 1.2, dur: 0.01, peak: 0.06 });
      break;
    case 'uiConfirm':
      tone(ctx, dest, t0, { f0: 784, dur: 0.07, peak: 0.1 });
      tone(ctx, dest, t0 + 0.045, { f0: 1175, dur: 0.12, peak: 0.1 });
      tone(ctx, dest, t0 + 0.045, { type: 'triangle', f0: 2350, dur: 0.05, peak: 0.02 });
      break;
    case 'uiBack':
      tone(ctx, dest, t0, { f0: 880, f1: 587, dur: 0.08, peak: 0.1 });
      noise(ctx, dest, t0, { f0: 1800, q: 1, dur: 0.008, peak: 0.03 });
      break;
    case 'uiError':
      for (const [dt, f] of [
        [0, 185],
        [0.09, 165],
      ] as const) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        lp.connect(dest);
        tone(ctx, lp, t0 + dt, { type: 'square', f0: f, dur: 0.06, peak: 0.11, attack: 0.004 });
      }
      break;
    case 'uiToggle':
      noise(ctx, dest, t0, { f0: 3000, q: 1.2, dur: 0.012, peak: 0.09 });
      tone(ctx, dest, t0, { f0: detail > 0 ? 1760 : 1320, dur: 0.022, peak: 0.08 });
      break;
    case 'tabSwitch':
      noise(ctx, dest, t0, { f0: 3400, q: 2, dur: 0.012, peak: 0.07 });
      tone(ctx, dest, t0 + 0.004, { f0: jit(1180, 0.01), f1: 1340, dur: 0.032, peak: 0.06 });
      break;
    case 'modalOpen':
      noise(ctx, dest, t0, { f0: 700, f1: 2600, q: 1.4, dur: 0.14, peak: 0.03, attack: 0.05 });
      tone(ctx, dest, t0 + 0.02, { f0: 520, f1: 700, dur: 0.07, peak: 0.028, attack: 0.01 });
      break;
    case 'modalClose':
      noise(ctx, dest, t0, { f0: 2200, f1: 600, q: 1.4, dur: 0.11, peak: 0.028, attack: 0.012 });
      tone(ctx, dest, t0, { f0: 640, f1: 460, dur: 0.06, peak: 0.026, attack: 0.006 });
      break;
    case 'equip':
      // Snap-on: a low chunk + a latch click, then a small bright ping.
      tone(ctx, dest, t0, { type: 'triangle', f0: 260, f1: 150, dur: 0.07, peak: 0.14 });
      noise(ctx, dest, t0, { f0: 1600, q: 1.5, dur: 0.03, peak: 0.09 });
      tone(ctx, dest, t0 + 0.035, { f0: 1568, dur: 0.12, peak: 0.05 });
      tone(ctx, dest, t0 + 0.06, { f0: 2093, dur: 0.1, peak: 0.03 });
      break;
    case 'purchase': {
      // "Ka" (drawer) → "ching" (bell) → a few coins.
      noise(ctx, dest, t0, { f0: 3000, q: 0.8, dur: 0.035, peak: 0.1 });
      tone(ctx, dest, t0, { type: 'triangle', f0: 190, f1: 120, dur: 0.05, peak: 0.08 });
      bell(ctx, dest, t0 + 0.05, 2637, 0.45, 0.06);
      bell(ctx, dest, t0 + 0.05, 3951, 0.32, 0.03);
      for (let i = 0; i < 3; i++) tone(ctx, dest, t0 + 0.1 + i * 0.045, { f0: jit(4600, 0.08), dur: 0.035, peak: 0.022 });
      break;
    }
    case 'caseTick': {
      const p = Math.max(0, Math.min(1, detail));
      noise(ctx, dest, t0, { f0: 2200 * (1 + p * 0.35), q: 5, dur: 0.014, peak: 0.11 });
      tone(ctx, dest, t0, { f0: jit(1500 + p * 500, 0.02), dur: 0.012, peak: 0.035 });
      break;
    }
    case 'caseReveal':
      noise(ctx, dest, t0, { f0: 1500, q: 0.9, dur: 0.03, peak: 0.1 });
      noise(ctx, dest, t0, { type: 'highpass', f0: 5500, dur: 0.4, peak: 0.018, attack: 0.03 });
      brass(ctx, dest, t0 + 0.01, 784, 0.1, 0.08);
      brass(ctx, dest, t0 + 0.08, 1175, 0.34, 0.08);
      tone(ctx, dest, t0 + 0.08, { f0: 1568, dur: 0.3, peak: 0.03, attack: 0.01 });
      break;
    case 'xpTick': {
      const i = Math.max(0, Math.min(PENTA.length - 1, Math.round(detail)));
      const f = semi(587, PENTA[i]);
      tone(ctx, dest, t0, { type: 'triangle', f0: f, dur: 0.055, peak: 0.08 });
      tone(ctx, dest, t0, { f0: f * 2, dur: 0.035, peak: 0.025 });
      noise(ctx, dest, t0, { f0: 4200, q: 1.5, dur: 0.006, peak: 0.03 });
      break;
    }
    case 'levelUp': {
      // Arpeggio C5 E5 G5 C6 → a held C major (add 9) with a shimmer.
      const arp = [523.25, 659.25, 783.99, 1046.5];
      arp.forEach((f, k) => brass(ctx, dest, t0 + k * 0.065, f, 0.16, 0.075));
      const tHold = t0 + 0.26;
      pad(ctx, dest, tHold, [523.25, 659.25, 783.99, 1046.5, 1174.66], 0.75, 0.03, 0.025);
      brass(ctx, dest, tHold, 1046.5, 0.5, 0.05, 3200);
      noise(ctx, dest, tHold, { type: 'highpass', f0: 6000, dur: 0.55, peak: 0.018, attack: 0.05 });
      sparkle(ctx, dest, tHold + 0.05, 4, 4186, 2637, 0.05, 0.02);
      break;
    }
    case 'unlock':
      playUiCue(ctx, dest, RARITY_UNLOCK[Math.max(0, Math.min(3, Math.round(detail)))], t0);
      break;
    case 'unlockCommon':
      noise(ctx, dest, t0, { f0: 2000, q: 1, dur: 0.015, peak: 0.06 });
      tone(ctx, dest, t0, { f0: 1047, dur: 0.08, peak: 0.08 });
      bell(ctx, dest, t0 + 0.055, 1568, 0.26, 0.06);
      break;
    case 'unlockRare': {
      const arp = [659.25, 830.61, 987.77];
      arp.forEach((f, k) => tone(ctx, dest, t0 + k * 0.05, { type: 'triangle', f0: f, dur: 0.14, peak: 0.07 }));
      bell(ctx, dest, t0 + 0.15, 1318.5, 0.38, 0.055);
      sparkle(ctx, dest, t0 + 0.2, 3, 3951, 2637, 0.05, 0.022);
      break;
    }
    case 'unlockEpic': {
      noise(ctx, dest, t0, { f0: 500, f1: 2600, q: 1.2, dur: 0.24, peak: 0.045, attack: 0.18 });
      const arp = [440, 554.37, 659.25, 880, 1108.73];
      arp.forEach((f, k) => brass(ctx, dest, t0 + 0.14 + k * 0.05, f, 0.18, 0.06));
      pad(ctx, dest, t0 + 0.4, [440, 659.25, 880, 1108.73], 0.65, 0.028);
      sparkle(ctx, dest, t0 + 0.42, 4, 4435, 2637, 0.05, 0.022);
      break;
    }
    case 'unlockLegendary': {
      // Riser → sub impact → a bright D major 7 blast with a sweeping filter →
      // a sparkle cascade. The one cue allowed to be big.
      noise(ctx, dest, t0, { f0: 300, f1: 3600, q: 1.1, dur: 0.36, peak: 0.055, attack: 0.3 });
      const tHit = t0 + 0.34;
      tone(ctx, dest, tHit, { f0: 110, f1: 52, dur: 0.38, peak: 0.2, attack: 0.004 });
      noise(ctx, dest, tHit, { type: 'lowpass', f0: 1400, dur: 0.09, peak: 0.1 });
      const chord = [587.33, 739.99, 880, 1108.73, 1174.66];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(700, tHit);
      lp.frequency.exponentialRampToValueAtTime(4200, tHit + 0.28);
      lp.frequency.exponentialRampToValueAtTime(1200, tHit + 1.1);
      lp.connect(dest);
      for (const f of chord) {
        tone(ctx, lp, tHit, { type: 'sawtooth', f0: f, dur: 1.05, peak: 0.016, attack: 0.01, detune: -6 });
        tone(ctx, lp, tHit, { type: 'sawtooth', f0: f, dur: 1.05, peak: 0.016, attack: 0.01, detune: 6 });
      }
      pad(ctx, dest, tHit, chord, 1.15, 0.03, 0.01);
      sparkle(ctx, dest, tHit + 0.08, 6, 5274, 2637, 0.06, 0.022);
      noise(ctx, dest, tHit, { type: 'highpass', f0: 6500, dur: 0.8, peak: 0.02, attack: 0.04 });
      break;
    }
    case 'countdownTick': {
      const last = Math.round(detail) <= 1;
      tone(ctx, dest, t0, { f0: last ? 1320 : 990, dur: last ? 0.08 : 0.045, peak: 0.065 });
      noise(ctx, dest, t0, { f0: 3500, q: 1.5, dur: 0.008, peak: 0.04 });
      break;
    }
    case 'stamp': {
      // Heavy slam: a sub drop + a body thud + a short metallic ring, coloured
      // major for a win and a low minor for a loss.
      tone(ctx, dest, t0, { f0: 120, f1: 45, dur: 0.34, peak: 0.22, attack: 0.003 });
      noise(ctx, dest, t0, { type: 'lowpass', f0: 900, dur: 0.09, peak: 0.13 });
      noise(ctx, dest, t0, { f0: 2400, q: 6, dur: 0.16, peak: 0.03 });
      if (detail > 0) {
        pad(ctx, dest, t0 + 0.03, [523.25, 659.25, 783.99], 0.6, 0.035, 0.012);
        brass(ctx, dest, t0 + 0.03, 1046.5, 0.45, 0.04, 3000);
      } else if (detail < 0) {
        pad(ctx, dest, t0 + 0.03, [196, 233.08, 293.66], 0.7, 0.045, 0.015);
      }
      break;
    }
  }
}
