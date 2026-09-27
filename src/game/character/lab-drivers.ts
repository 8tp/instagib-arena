import * as THREE from 'three';
import { HATS, type EmoteKind } from '../cosmetics';
import { WornHat } from '../hats';
import { CharacterAnimator } from '../character-anim';
import { EMOTE_KINDS } from '../emotes';
import { attachRailgun } from './gun';
import { setCharacterFxQuality } from './gibs';
import type { Character } from './character';
import type { LabDriver } from './lab';

// Lab drivers: deterministic scenarios → poses. A scenario is an analytic
// entity trajectory (position/yaw/pitch over time) fed through the REAL
// animator at a fixed 120 Hz step, so the lab shows exactly what the game
// would. The character runs on a treadmill (horizontal motion is measured,
// not displayed); vertical motion is shown via the slot's height.

type Sample = { x: number; y: number; z: number; yaw: number; pitch: number };
type Scenario = { dur: number; at(t: number, out: Sample): void; death?: number };

const G = 25;
function ballistic(t: number, t0: number, vy0: number): number {
  const u = t - t0;
  if (u <= 0) return 0;
  const y = vy0 * u - 0.5 * G * u * u;
  return y > 0 ? y : 0;
}

const SCEN: Record<string, Scenario> = {
  idle: { dur: 6, at: (_t, o) => set(o, 0, 0, 0) },
  walk: { dur: 4, at: (t, o) => set(o, 0, 0, -3 * t) },
  jog: { dur: 4, at: (t, o) => set(o, 0, 0, -6 * t) },
  run: { dur: 4, at: (t, o) => set(o, 0, 0, -10 * t) },
  sprint: { dur: 4, at: (t, o) => set(o, 0, 0, -12 * t) },
  strafeR: { dur: 4, at: (t, o) => set(o, 10 * t, 0, 0) },
  strafeL: { dur: 4, at: (t, o) => set(o, -10 * t, 0, 0) },
  back: { dur: 4, at: (t, o) => set(o, 0, 0, 8 * t) },
  diag: { dur: 4, at: (t, o) => set(o, 7 * t, 0, -7 * t) },
  backdiag: { dur: 4, at: (t, o) => set(o, 6 * t, 0, 6 * t) },
  // run, jump at 1.0 s (vy 9), land ~1.72 s
  jump: { dur: 3, at: (t, o) => set(o, 0, ballistic(t, 1, 9), -10 * t) },
  // standing jump
  hop: { dur: 3, at: (t, o) => set(o, 0, ballistic(t, 1, 9), 0) },
  // run off a 3 m ledge at 1.0 s (landing hard)
  fall: { dur: 3, at: (t, o) => set(o, 0, t < 1 ? 3 : Math.max(0, 3 - 0.5 * G * (t - 1) ** 2), -9 * t) },
  // dash burst at 1.0 s for 0.15 s
  dash: {
    dur: 3,
    at: (t, o) => {
      const d = t < 1 ? 10 * t : t < 1.15 ? 10 + 22 * (t - 1) : 13.3 + 10 * (t - 1.15);
      set(o, 0, 0, -d);
    },
  },
  // jump toward a wall on the right, kick off it at 1.35 s (away = −X, up)
  walljump: {
    dur: 3,
    at: (t, o) => {
      if (t < 1) return set(o, 6 * t, 0, -6 * t);
      if (t < 1.35) return set(o, 6 * t, ballistic(t, 1, 9), -6 * t);
      const y1 = ballistic(1.35, 1, 9);
      const u = t - 1.35;
      const y = Math.max(0, y1 + 7 * u - 0.5 * G * u * u);
      set(o, 6 * 1.35 - 8 * u, y, -6 * t);
    },
  },
  // aim yaw sweeps 100° while standing still
  turn: { dur: 4, at: (t, o) => set(o, 0, 0, 0, t < 1 ? 0 : Math.min(1, (t - 1) / 0.6) * 1.75) },
  // aim pitch sweep while standing
  aim: { dur: 4, at: (t, o) => set(o, 0, 0, 0, 0, Math.sin(t * 1.2) * 1.1) },
  // idle, then gibbed at 1.0 s
  gib: { dur: 3, death: 1.0, at: (t, o) => set(o, 0, 0, t < 1 ? -10 * t : -10) },
};

function set(o: Sample, x: number, y: number, z: number, yaw = 0, pitch = 0): void {
  o.x = x;
  o.y = y;
  o.z = z;
  o.yaw = yaw;
  o.pitch = pitch;
}

const STEP = 1 / 120;

class Sim {
  anim: CharacterAnimator;
  private t = 0;
  private readonly pos = new THREE.Vector3();
  private readonly s: Sample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private dead = false;
  constructor(
    private ch: Character,
    private scen: Scenario,
    private slot: THREE.Object3D,
  ) {
    this.anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
    attachRailgun(ch);
  }
  advanceBy(dt: number) {
    this.advanceTo(this.t + dt);
  }
  // Advance to absolute time T (from the current time).
  advanceTo(T: number) {
    while (this.t + STEP <= T + 1e-9) {
      this.t += STEP;
      this.scen.at(this.t, this.s);
      this.pos.set(this.s.x, this.s.y, this.s.z);
      if (this.scen.death !== undefined && !this.dead && this.t >= this.scen.death) {
        this.dead = true;
        this.anim.die({ y: 0 });
      }
      this.anim.update({ dt: STEP, yaw: this.s.yaw, pitch: this.s.pitch, pos: this.pos });
      this.slot.position.y = this.dead ? 0 : this.s.y;
    }
  }
}

function emoteDriver(kinds: EmoteKind[], times: number[], label: (i: number) => string): LabDriver {
  const anims = new Map<Character, CharacterAnimator>();
  const n = Math.max(kinds.length, times.length);
  return {
    count: n,
    label,
    drive(ch, t, dt, i) {
      let a = anims.get(ch);
      const kind = kinds[Math.min(i, kinds.length - 1)];
      const time = (times[Math.min(i, times.length - 1)] ?? 0) + t;
      if (!a) {
        a = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
        a.playEmote(kind);
        anims.set(ch, a);
        if (kind === 'flourish') attachRailgun(ch);
      }
      a.setEmoteTime(time);
      a.updateStatic(0);
    },
  };
}

export function labDriverFromParams(params: URLSearchParams): LabDriver {
  const t = Number(params.get('t') ?? 0);
  // ?fx=reduced|low → the gib quality tiers.
  const fx = params.get('fx');
  setCharacterFxQuality({ reducedEffects: fx === 'reduced', lowSpec: fx === 'low' });
  const grid = params.get('grid');
  const emote = params.get('emote') as EmoteKind | null;
  const play = params.get('play') === '1';

  if (grid === 'hats') {
    // Every hat on the helmet (idle pose), for fit review.
    const anims = new Map<Character, CharacterAnimator>();
    const yaw = Number(params.get('yaw') ?? 0.5);
    const from = Number(params.get('from') ?? 0);
    const list = HATS.slice(from, from + Number(params.get('n') ?? HATS.length));
    return {
      count: list.length,
      label: (i) => list[i].name,
      drive(ch, _clock, _dt, j, slot) {
        const i = HATS.indexOf(list[j]);
        if (anims.has(ch)) return;
        slot.rotation.y = yaw;
        const a = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
        a.playEmote('idle');
        a.setEmoteTime(0.5);
        a.updateStatic(0);
        anims.set(ch, a);
        const hat = new WornHat(ch.sockets.headTop);
        void hat.setHat(HATS[i].id);
      },
    };
  }
  if (grid === 'views') {
    // One pose from four sides: front, right side, back, 3/4.
    const yaws = [0, -Math.PI / 2, Math.PI, -Math.PI / 4];
    const names = ['front', 'side', 'back', '3/4'];
    const inner = emote ? emoteDriver([emote], [t], () => '') : null;
    const sims = new Map<Character, Sim>();
    return {
      count: 4,
      label: (i) => names[i],
      drive(ch, clock, dt, i, slot) {
        slot.rotation.y = yaws[i];
        if (inner) return inner.drive(ch, clock - t, dt, 0, slot);
        let sim = sims.get(ch);
        if (!sim) {
          sim = new Sim(ch, SCEN[params.get('pose') ?? 'idle'] ?? SCEN.idle, slot);
          sims.set(ch, sim);
          sim.advanceTo(t || 2);
        }
      },
    };
  }
  if (emote && !grid) return emoteDriver([emote], [0], () => '');
  if (grid === 'emotes') {
    return emoteDriver(EMOTE_KINDS, [t], (i) => EMOTE_KINDS[i]);
  }
  if (grid?.startsWith('emote:')) {
    const kind = grid.slice(6) as EmoteKind;
    const n = Number(params.get('n') ?? 6);
    const dur = Number(params.get('dur') ?? 3);
    const times = Array.from({ length: n }, (_, i) => (i * dur) / n);
    return emoteDriver([kind], times, (i) => `${kind} ${times[i].toFixed(2)}s`);
  }

  // Locomotion.
  let names: string[];
  let times: number[];
  if (grid === 'loco') {
    names = ['idle', 'walk', 'run', 'strafeR', 'strafeL', 'back', 'diag', 'jump', 'jump', 'jump', 'fall', 'dash'];
    times = [2, 2, 2, 2, 2, 2, 2, 1.12, 1.35, 1.66, 1.62, 1.08];
  } else if (grid?.startsWith('cycle:')) {
    const scen = grid.slice(6);
    const n = Number(params.get('n') ?? 8);
    const period = Number(params.get('period') ?? 0.377);
    names = Array.from({ length: n }, () => scen);
    times = Array.from({ length: n }, (_, i) => 2 + (i * period) / n);
  } else if (grid?.startsWith('seq:')) {
    const scen = grid.slice(4);
    const n = Number(params.get('n') ?? 8);
    const t0 = Number(params.get('t0') ?? 0.9);
    const t1 = Number(params.get('t1') ?? 1.9);
    names = Array.from({ length: n }, () => scen);
    times = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / Math.max(1, n - 1));
  } else {
    names = [params.get('pose') ?? 'idle'];
    times = [t];
  }
  const sims = new Map<Character, Sim>();
  return {
    count: names.length,
    label: (i) => (names.length > 1 ? `${names[i]} ${times[i].toFixed(2)}` : ''),
    drive(ch, _clock, dt, i, slot) {
      let sim = sims.get(ch);
      if (!sim) {
        sim = new Sim(ch, SCEN[names[i]] ?? SCEN.idle, slot);
        sims.set(ch, sim);
        sim.advanceTo(times[i]);
        return;
      }
      if (play && dt > 0) sim.advanceBy(dt);
    },
  };
}
