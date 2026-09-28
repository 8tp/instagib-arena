// ── Mixer: buses, reverb, master limiter, voice pool, 3D routing ─────────────
//
//   world (dry) ─┐
//   hud (dry)  ──┤                                  ┌─ announcerBus ─┐
//   reverb wet ──┼─ sfxBus (SFX vol) ───────────────┤                ├─ mix → limiter → safety clip → out (master vol) → destination
//   ambience → duck ┘                               └────────────────┘
//   sends (lo/mid/hi, per-voice for 3D) → reverbIn → convolver → wet
//
// The limiter + soft safety clip sit BEFORE the master volume, so the mix never
// exceeds -1 dBFS at any volume and the balance doesn't change with the slider.
// Every sound event is a Voice registered in a per-category pool; over the cap
// the oldest voice in that category is stolen (12 ms fade + stop), so a busy
// 8-player FFA can't pile up nodes.
import { clamp, rnd, type AC, type Voice, type VoiceCat } from './core';

// Max concurrent voices per category (worst case ≈ 30 voices, ~350 nodes).
const CAPS: Record<VoiceCat, number> = {
  // Your own shot / kill confirm / death — their own pool, so movement or
  // other players' frags can never steal them (oldest-first stealing would
  // otherwise pick your 1.2 s rail tail first).
  self: 3,
  local: 7, // own movement
  hud: 5, // hit tick, ready cue, charge hum, medal stings
  rail: 5, // other players' rail shots (3D)
  impact: 5, // kill confirm / gibs / death
  remote: 8, // other players' + bots' footsteps / jumps / landings (3D)
};
const CAPS_LOW: Record<VoiceCat, number> = { self: 2, local: 4, hud: 4, rail: 3, impact: 3, remote: 4 };

export type RoomProfile = {
  /** RT60 of the generated impulse response, seconds. */
  seconds: number;
  /** Pre-delay before the diffuse tail, seconds. */
  predelay: number;
  /** 0 = bright (metal/concrete) … 1 = dark (fabric/wood/open air). */
  damp: number;
  /** Wet return level. */
  wet: number;
};

export type SpatialOpts = {
  /** Distance (m) inside which the sound is at full level. */
  ref: number;
  rolloff: number;
  /** Culled beyond this distance (m). */
  max: number;
  /** Reverb send at the reference distance (the send falls off slower than the dry). */
  send: number;
};

export class Mixer {
  readonly out: GainNode; // master volume
  readonly sfxBus: GainNode;
  readonly announcerBus: GainNode;
  readonly world: GainNode; // dry world SFX (local + 3D)
  readonly hud: GainNode; // dry interface-like SFX (tick, ready, stings) — never reverbed
  readonly ambience: GainNode;
  readonly sendLo: GainNode;
  readonly sendMid: GainNode;
  readonly sendHi: GainNode;
  private readonly reverbIn: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly wet: GainNode;
  private readonly duckGain: GainNode;
  private readonly mix: GainNode;
  // Replay treatment (killcam / Play of the Match): SFX only (the announcer stays
  // clean) → a fade gain + a low-pass that is transparent (20 kHz) until a replay
  // begins, then closes to a slightly "played-back" tone.
  private readonly replayGain: GainNode;
  private readonly replayLP: BiquadFilterNode;
  private live: Voice[] = [];
  private room: RoomProfile | null = null;
  lowSpec = false;
  // Listener position (for distance low-pass + culling). Orientation lives on
  // ctx.listener, set by the SoundManager each frame.
  lx = 0;
  ly = 0;
  lz = 0;
  /** High-water mark of concurrent voices (diagnostics / preview). */
  peakVoices = 0;

  constructor(readonly ctx: AC, dest: AudioNode = ctx.destination) {
    const g = (v: number) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.out = g(0.7);
    this.mix = g(1);
    this.sfxBus = g(1);
    this.announcerBus = g(1);
    this.world = g(1);
    this.hud = g(1);
    this.ambience = g(1);
    this.duckGain = g(1);
    this.reverbIn = g(1);
    this.wet = g(0.25);
    this.sendLo = g(0.08);
    this.sendMid = g(0.2);
    this.sendHi = g(0.38);
    this.convolver = ctx.createConvolver();
    this.replayGain = g(1);
    this.replayLP = ctx.createBiquadFilter();
    this.replayLP.type = 'lowpass';
    this.replayLP.frequency.value = 20000;
    this.replayLP.Q.value = 0.5;

    // Limiter: fast, high ratio. (Chrome's compressor applies its own makeup
    // gain of ~+3 dB with these settings — the preview measures through it.)
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 3;
    lim.ratio.value = 16;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    // Safety clip: linear below 0.7, soft-knees to a hard ceiling of 0.89
    // (-1 dBFS) — catches any transient the limiter's attack lets through.
    const clip = ctx.createWaveShaper();
    clip.curve = safetyCurve();
    clip.oversample = 'none';

    this.world.connect(this.sfxBus);
    this.hud.connect(this.sfxBus);
    this.ambience.connect(this.duckGain).connect(this.sfxBus);
    this.sendLo.connect(this.reverbIn);
    this.sendMid.connect(this.reverbIn);
    this.sendHi.connect(this.reverbIn);
    this.reverbIn.connect(this.convolver).connect(this.wet).connect(this.sfxBus);
    this.sfxBus.connect(this.replayGain).connect(this.replayLP).connect(this.mix);
    this.announcerBus.connect(this.mix);
    this.mix.connect(lim).connect(clip).connect(this.out).connect(dest);
  }

  // ── Voice pool ─────────────────────────────────────────────────────────────

  /** Register a fully-built voice; steals the oldest in its category if over cap. */
  add(v: Voice, cat: VoiceCat) {
    const now = this.ctx.currentTime;
    const cap = (this.lowSpec ? CAPS_LOW : CAPS)[cat];
    let n = 0;
    let oldest: Voice | null = null;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const x = this.live[i];
      if (x.end < now) {
        // Finished — swap-remove (order doesn't matter).
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        continue;
      }
      if (x.cat === cat) {
        n++;
        if (!oldest || x.t < oldest.t) oldest = x;
      }
    }
    if (n >= cap && oldest) {
      this.stop(oldest);
      const j = this.live.indexOf(oldest);
      if (j >= 0) {
        this.live[j] = this.live[this.live.length - 1];
        this.live.pop();
      }
    }
    v.cat = cat;
    this.live.push(v);
    if (this.live.length > this.peakVoices) this.peakVoices = this.live.length;
  }

  /** Fade a voice out over ~12 ms and stop its sources (steal / cancel). */
  stop(v: Voice) {
    const now = this.ctx.currentTime;
    const p = v.out.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(0, now + 0.012);
    for (const s of v.srcs) {
      try {
        s.stop(now + 0.015);
      } catch {
        // already stopped
      }
    }
    v.end = Math.min(v.end, now + 0.015);
  }

  get voiceCount(): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.live) if (v.end >= now) n++;
    return n;
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** Non-positional world sound (your own gun / body): dry + a reverb send. */
  toWorld(v: Voice, send: GainNode | null) {
    v.out.connect(this.world);
    if (send) v.out.connect(send);
  }

  /** Distance from the listener, or -1 when beyond `max` (cull — build nothing). */
  audible(x: number, y: number, z: number, max: number): number {
    const d = Math.hypot(x - this.lx, y - this.ly, z - this.lz);
    return d <= max ? d : -1; // NaN (a bad position) is culled, never routed

  }

  /**
   * 3D sound at (x,y,z), `dist` metres away: air-absorption low-pass (darker
   * with distance) → HRTF panner (equal-power on low-spec) → world, plus a
   * reverb send that falls off slower than the dry signal, so far sounds read
   * as more reverberant.
   */
  spatial(v: Voice, x: number, y: number, z: number, dist: number, o: SpatialOpts) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(19000 * Math.exp(-dist / 24), 1100, 19000);
    lp.Q.value = 0.5;
    const p = ctx.createPanner();
    p.panningModel = this.lowSpec ? 'equalpower' : 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = o.ref;
    p.rolloffFactor = o.rolloff;
    p.maxDistance = Math.max(o.max, o.ref + 1);
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      (p as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(x, y, z);
    }
    v.out.connect(lp).connect(p).connect(this.world);
    if (o.send > 0) {
      const s = ctx.createGain();
      s.gain.value = o.send * clamp(Math.sqrt(o.ref / Math.max(dist, o.ref)), 0.3, 1);
      v.out.connect(s).connect(this.reverbIn);
    }
  }

  // ── Room / ducking ─────────────────────────────────────────────────────────

  /** Swap the reverb for a map's room (regenerates the impulse response once). */
  setRoom(room: RoomProfile) {
    this.room = room;
    const secs = this.lowSpec ? Math.min(room.seconds, 0.7) : room.seconds;
    this.convolver.buffer = makeImpulse(this.ctx, secs, room.predelay, room.damp);
    this.wet.gain.value = room.wet;
  }

  setLowSpec(on: boolean) {
    if (on === this.lowSpec) return;
    this.lowSpec = on;
    if (this.room) this.setRoom(this.room); // shorter IR on low-spec
  }

  /**
   * Replay treatment on/off. On: the SFX bus fades in through a gentle low-pass
   * and a touch more room; off: fades out, then the chain returns to fully
   * transparent. `fade` is the boundary fade in seconds. Cosmetic only.
   */
  setReplay(on: boolean, fade = 0.4) {
    const now = this.ctx.currentTime;
    const gp = this.replayGain.gain;
    const fp = this.replayLP.frequency;
    const wp = this.wet.gain;
    for (const p of [gp, fp, wp]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
    }
    const wet = this.room?.wet ?? 0.25;
    if (on) {
      gp.setValueAtTime(0, now);
      gp.linearRampToValueAtTime(1, now + fade);
      fp.setTargetAtTime(6800, now, 0.15);
      wp.setTargetAtTime(wet * 1.35, now, 0.2);
    } else {
      gp.linearRampToValueAtTime(0, now + fade);
      // Once silent, snap everything back to the transparent live chain.
      const done = now + fade + 0.05;
      gp.setValueAtTime(1, done);
      fp.setValueAtTime(20000, done);
      wp.setValueAtTime(wet, done);
    }
  }

  /** Duck the ambience under an announcer line for `sec` seconds. */
  duck(sec: number) {
    const now = this.ctx.currentTime;
    const p = this.duckGain.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.setTargetAtTime(0.3, now, 0.05);
    p.setTargetAtTime(1, now + sec, 0.35);
  }
}

function safetyCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const knee = 0.7;
  const room = 0.19; // knee + room = 0.89 = -1.01 dBFS
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

// Stereo impulse response: sparse early reflections (different per ear →
// width) then an exponentially decaying noise tail whose high end dies faster
// than its low end (a one-pole low-pass that closes over the decay).
function makeImpulse(ctx: AC, seconds: number, predelay: number, damp: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * (predelay + seconds)));
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * predelay);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Early reflections within the first ~45 ms of the tail.
    for (let k = 0; k < 7; k++) {
      const at = pre + Math.floor(sr * (0.004 + rnd() * 0.04));
      if (at < len) d[at] += (rnd() < 0.5 ? -1 : 1) * (0.7 - k * 0.08);
    }
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9 * t) / seconds);
      // Low-pass coefficient: bright at the onset, darker as it decays.
      const a = clamp(0.9 - damp * 0.55 - (t / seconds) * (0.35 + damp * 0.3), 0.04, 0.95);
      y += a * (rnd() * 2 - 1 - y);
      d[i] += y * env;
    }
  }
  return buf;
}
