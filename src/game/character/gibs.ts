import * as THREE from 'three';
import { DEREZ_BANDS, getBodyGeometry, getBodySamples, SAMPLE_ARMOR, SAMPLE_GLOW } from './body';
import type { KillEffectStyle } from '../cosmetics';
import type { Character } from './character';
import { B, BONE_COUNT, REST_ABS } from './rig';
import { getFxQuality, peekFxContext, type FxContext, type FxParticle, type FxShape } from '../fx-pool';
import { FINISHER_TIMING, fxFlags, noteDeath, viewPos } from '../fx/fx-settings';

// ── Instagib death: the parts ARE the gibs ───────────────────────────────────
//
// Every body part is rigidly skinned to one bone, so bursting the body is just
// flinging the bones: each bone becomes a free rigid chunk (position, spin,
// shrink) written straight into its matrix. The skinned mesh keeps rendering
// as ONE draw call, and nothing is allocated per kill (all state is
// preallocated per character; particles come from the scene's shared pool).
//
// The KILLER's finisher picks how the body breaks apart (Ratz-Instagib
// style), each with its own chunk motion, a body-shader look (body.ts) and
// body-bound particles spawned from real surface samples, so they sit
// exactly where the armour was:
//   pulse / nova / starburst — chunk variants glowing in the VICTIM's colour
//   gibstorm   — violent hot-metal chunks, sparks and glowing debris
//   voxel      — the body breaks into glowing voxel cubes
//   ember      — a char front climbs the body, then it crumbles into embers
//   singularity— chunks spiral into a point, then pop white-hot
//   shatter    — the armour flash-freezes to glass and shatters into shards
//   confetti   — pops like a party cannon: confetti + streamers
//   derez      — sliced into glowing bands that slide apart and blink out
//   vaporize   — flash-burnt to an ash statue that blows away on the wind
//   overload   — arcs crawl over the twitching body, then a blue-white blast
//   prism      — rainbow-seamed chunks and a spray of prismatic shards
// The killer's burst (effects.spawnKillBurst) plays on top at the same spot.
//
// Quality: reducedEffects → calmer, shorter, fewer particles, no strobing,
// no flash; lowSpec → fewer chunks and particles. Set by the Game via
// setCharacterFxQuality() (shared with the worn unusuals through fxFlags).

export type GibFloor = { y: number } | null; // world-space floor height, null = none

export function setCharacterFxQuality(opts: { reducedEffects?: boolean; lowSpec?: boolean }): void {
  if (opts.reducedEffects !== undefined) fxFlags.reduced = opts.reducedEffects;
  if (opts.lowSpec !== undefined) fxFlags.low = opts.lowSpec;
}

// Optional world floor probe (the Game can install one built on the map's
// collision boxes) so remote players' gibs bounce on the real floor even when
// they die mid-air. Without it the animator guesses from the last ground height.
type FloorProbe = (x: number, y: number, z: number) => number | null;
let floorProbe: FloorProbe | null = null;
export function setGibFloorProbe(fn: FloorProbe | null): void {
  floorProbe = fn;
}
export function probeGibFloor(x: number, y: number, z: number): GibFloor {
  if (!floorProbe) return null;
  const f = floorProbe(x, y, z);
  return f === null || y - f > 6 ? null : { y: f };
}

// Highest box top at or just below (x, y, z) — a ready-made probe over AABBs.
export function floorBelow(
  boxes: ReadonlyArray<{ min: { x: number; z: number }; max: { x: number; y: number; z: number } }>,
  x: number,
  y: number,
  z: number,
): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    const top = b.max.y;
    if (top <= y + 0.05 && (best === null || top > best)) best = top;
  }
  return best;
}

// ── Per-style chunk motion ───────────────────────────────────────────────────

type Motion = {
  speed: number; speedR: number; // outward speed (base + random), m/s
  up: number; upR: number; // extra upward speed
  vert: number; // vertical share of the outward direction
  spin: number; spinR: number; // tumble rad/s
  gravity: number;
  drag: number; // horizontal damping 1/s
  shrinkAt: number; shrinkAtR: number; // seconds after death the chunk starts shrinking
  shrinkDur: number;
  bounce: number; // floor restitution (0 = stick)
  hold: number; // posed hold before chunks launch (Infinity = never)
  duration: number; // the body is fully gone by here
};

const BASE: Motion = {
  speed: 2.8, speedR: 3.6, up: 2.0, upR: 2.8, vert: 0.6, spin: 5, spinR: 11, gravity: 22, drag: 0.5,
  shrinkAt: 0.5, shrinkAtR: 0.35, shrinkDur: 0.42, bounce: 0.3, hold: 0, duration: 1.3,
};
const M = (o: Partial<Motion>): Motion => ({ ...BASE, ...o });

const MOTION: Record<KillEffectStyle, Motion> = {
  // A floor shockwave: chunks skim out low along the ground.
  pulse: M({ speed: 3.2, speedR: 3, up: 0.6, upR: 1.2, vert: 0.15, drag: 0.9, gravity: 20 }),
  // A pillar: chunks thrown straight up.
  nova: M({ speed: 0.5, speedR: 0.8, up: 5, upR: 3, vert: 0.2, spin: 3, spinR: 6, gravity: 16, drag: 0.4, shrinkAt: 0.4, shrinkAtR: 0.2 }),
  // Spikes: fired straight out, no tumble, stopping hard.
  starburst: M({ speed: 6.5, speedR: 3, up: 0.4, upR: 1.0, vert: 0.45, spin: 0, spinR: 0, gravity: 4, drag: 3.6, shrinkAt: 0.28, shrinkAtR: 0.22, shrinkDur: 0.3 }),
  gibstorm: M({ speed: 3.8, speedR: 4.2, up: 2.6, upR: 3, spin: 10, spinR: 14, gravity: 26, drag: 0.3, shrinkAt: 0.62, shrinkAtR: 0.35, bounce: 0.38 }),
  // The body IS the voxels: it hands over to the cubes at once.
  voxel: M({ speed: 1.2, speedR: 1.2, up: 0.8, upR: 0.8, shrinkAt: 0.0, shrinkAtR: 0.015, shrinkDur: 0.03, duration: 0.4 }),
  // Buckles and burns where it fell, then crumbles.
  ember: M({ hold: 0.24, speed: 0.3, speedR: 0.9, up: 0, upR: 0.7, vert: 0.2, spin: 1, spinR: 3, gravity: 12, drag: 0.8, shrinkAt: 0.62, shrinkAtR: 0.3, shrinkDur: 0.45, bounce: 0 }),
  // Custom motion (see update): spiral in, then the release.
  singularity: M({ speed: 6, speedR: 3, up: 1.5, upR: 1.5, spin: 8, spinR: 8, gravity: 12, drag: 0.6, shrinkAt: 0.45, shrinkAtR: 0.2, shrinkDur: 0.3 }),
  // Glass: freezes, cracks, then the pieces break into falling shards.
  shatter: M({ hold: 0.05, speed: 0.4, speedR: 0.8, up: 0, upR: 0.6, vert: 0.1, spin: 3, spinR: 5, gravity: 16, drag: 0.3, shrinkAt: 0.07, shrinkAtR: 0.06, shrinkDur: 0.12, duration: 0.6 }),
  // Pops: the body is gone in a blink, the confetti carries the moment.
  confetti: M({ speed: 1, speedR: 1, up: 1, upR: 1, shrinkAt: 0.02, shrinkAtR: 0.02, shrinkDur: 0.05, duration: 0.4 }),
  derez: M({ hold: Infinity, duration: 0.7 }),
  vaporize: M({ hold: Infinity, duration: 0.7 }),
  // Arcs over a collapsing body, then the blast drops the pieces (no launch).
  overload: M({ hold: FINISHER_TIMING.overloadBlast, speed: 3, speedR: 3, up: 0.2, upR: 1.0, vert: 0.3, spin: 6, spinR: 8, gravity: 24, shrinkAt: 0.55, shrinkAtR: 0.3, bounce: 0.25 }),
  prism: M({ speed: 3.5, speedR: 3, up: 2, upR: 2.5, spin: 6, spinR: 8, gravity: 18, shrinkAt: 0.45, shrinkAtR: 0.3 }),
};

// Chunk leads for the reduced set (7 chunks): limbs stay whole.
const LEAD_REDUCED: readonly number[] = (() => {
  const lead = Array.from({ length: BONE_COUNT }, (_, i) => i);
  lead[B.spine] = B.chest;
  lead[B.neck] = B.head;
  lead[B.clavicleL] = B.chest;
  lead[B.clavicleR] = B.chest;
  lead[B.foreArmL] = B.upperArmL;
  lead[B.handL] = B.upperArmL;
  lead[B.foreArmR] = B.upperArmR;
  lead[B.handR] = B.upperArmR;
  lead[B.shinL] = B.thighL;
  lead[B.footL] = B.thighL;
  lead[B.shinR] = B.thighR;
  lead[B.footR] = B.thighR;
  lead[B.crest] = B.head;
  return lead;
})();
// Full set: every bone its own chunk, except the clavicles (pauldrons) which
// stay on the chest for a chunkier torso piece.
const LEAD_FULL: readonly number[] = (() => {
  const lead = Array.from({ length: BONE_COUNT }, (_, i) => i);
  lead[B.clavicleL] = B.chest;
  lead[B.clavicleR] = B.chest;
  lead[B.crest] = B.head;
  return lead;
})();

let flashTex: THREE.Texture | null = null;
function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  flashTex = new THREE.CanvasTexture(cv);
  return flashTex;
}

const TAU = Math.PI * 2;
const rnd = Math.random;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pp = new THREE.Vector3();
const _w = new THREE.Vector3();
const _H = new THREE.Vector3();
const _K = new THREE.Vector3();
const _K2 = new THREE.Vector3();
const _A = new THREE.Vector3();
const _X = new THREE.Vector3();
const _cA = new THREE.Matrix4();
const _cB = new THREE.Matrix4();
const _cU = new THREE.Matrix4();
// Bones that fold with the torso when a held body buckles.
const UPPER: readonly number[] = [
  B.hips, B.spine, B.chest, B.neck, B.head, B.crest,
  B.clavicleL, B.upperArmL, B.foreArmL, B.handL, B.clavicleR, B.upperArmR, B.foreArmR, B.handR,
];
const WHITE = new THREE.Color(1, 1, 1);
const _heat = new THREE.Color();
const _c = new THREE.Color();
// Black-body-ish cooling ramp for the gib seams (linear HDR).
const HEAT_KEYS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 3.4, 3.0, 2.4], // white-hot
  [0.18, 3.0, 1.35, 0.35], // yellow-orange
  [0.5, 1.9, 0.42, 0.06], // orange
  [1.1, 0.55, 0.06, 0.015], // deep red
];
function heatColor(t: number, out: THREE.Color): THREE.Color {
  for (let i = 1; i < HEAT_KEYS.length; i++) {
    const a = HEAT_KEYS[i - 1];
    const b = HEAT_KEYS[i];
    if (t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0]);
      return out.setRGB(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    }
  }
  const l = HEAT_KEYS[HEAT_KEYS.length - 1];
  return out.setRGB(l[1], l[2], l[3]);
}

// Confetti palette (linear-ish, vivid but not HDR — paper, not light).
const CONFETTI: readonly (readonly [number, number, number])[] = [
  [1.0, 0.12, 0.45], [1.0, 0.78, 0.05], [0.08, 0.8, 1.0], [0.4, 1.0, 0.12], [0.62, 0.25, 1.0], [1.0, 0.45, 0.08], [1, 1, 1],
];

function sceneOf(o: THREE.Object3D): THREE.Scene | null {
  let p: THREE.Object3D = o;
  while (p.parent) p = p.parent;
  return (p as THREE.Scene).isScene ? (p as THREE.Scene) : null;
}

const SAMPLE_N = 256;
// Derez: a few thick slabs (the shader's band arrays hold up to DEREZ_BANDS).
const DEREZ_SLABS = 7;

export class GibBurst {
  active = false;
  done = false;
  // The killer's finisher — which death animation this burst plays.
  style: KillEffectStyle = 'pulse';
  private t = 0;
  private lead: readonly number[] = LEAD_FULL;
  private floorY: number | null = null;
  private floorWorld = -Infinity;
  private mo: Motion = BASE;
  private calm = false;
  private q = 1; // particle budget multiplier (quality)
  // Per-bone chunk state (only leads are simulated).
  private readonly pos = new Float32Array(BONE_COUNT * 3);
  private readonly pos0 = new Float32Array(BONE_COUNT * 3);
  private readonly vel = new Float32Array(BONE_COUNT * 3);
  private readonly quat = new Float32Array(BONE_COUNT * 4);
  private readonly spinAxis = new Float32Array(BONE_COUNT * 3);
  private readonly spinRate = new Float32Array(BONE_COUNT);
  private readonly shrinkAt = new Float32Array(BONE_COUNT);
  private readonly baseS = new Float32Array(BONE_COUNT);
  private readonly comLocal = new Float32Array(BONE_COUNT * 3);
  private readonly rel: THREE.Matrix4[] = [];
  private readonly startM: THREE.Matrix4[] = [];
  private flash: THREE.Sprite | null = null;
  private flashDelay = 0;
  private flashSize = 1.2;
  private flashBase = 0.5; // current flash size before proximity scaling
  private readonly flashAt = new THREE.Vector3();
  private readonly glowCol = new THREE.Color(); // victim energy (flash tint)
  private readonly energy = new THREE.Color(); // the victim's colour, linear
  // Finisher particles (shared scene pool; null when nobody steps it).
  private fx: FxContext | null = null;
  private readonly parentM = new THREE.Matrix4();
  private readonly centerW = new THREE.Vector3(); // torso centre, world
  private readonly pullW = new THREE.Vector3(); // singularity point, world
  private readonly pullP = new THREE.Vector3(); // singularity point, parent space
  private popped = false;
  private events = 0; // one-shot event bits
  private emitAcc = 0;
  private arcT = 0;
  private readonly keys = new Float32Array(SAMPLE_N); // vaporize dissolve keys
  private readonly spawned = new Uint8Array(SAMPLE_N);
  private readonly bandT = new Float32Array(DEREZ_BANDS);
  private readonly bandDone = new Uint8Array(DEREZ_BANDS);
  private readonly wind = new THREE.Vector3();
  private castShadow0 = true;
  private readonly side = new THREE.Vector3(1, 0, 0); // the body's side axis, parent space
  private readonly back = new THREE.Vector3(0, 0, 1); // the body's back axis, parent space
  private rollSign = 1; // which way a buckling body keels over
  private launched = false;
  private feetWorldY = 0;

  constructor(private readonly ch: Character) {
    for (let i = 0; i < BONE_COUNT; i++) {
      this.rel.push(new THREE.Matrix4());
      this.startM.push(new THREE.Matrix4());
    }
    const body = getBodyGeometry();
    for (let i = 0; i < BONE_COUNT; i++) {
      for (let k = 0; k < 3; k++) this.comLocal[i * 3 + k] = body.com[i * 3 + k] - REST_ABS[i][k];
    }
  }

  // Burst now. (vx, vy, vz) = the victim's world velocity at death.
  start(vx: number, vy: number, vz: number, floor: GibFloor, style: KillEffectStyle = 'pulse'): void {
    this.style = MOTION[style] ? style : 'pulse';
    const mo = (this.mo = MOTION[this.style]);
    const ch = this.ch;
    const root = ch.root;
    const rig = ch.rig;
    const body = getBodyGeometry();
    this.active = true;
    this.done = false;
    this.t = 0;
    this.calm = fxFlags.reduced;
    this.q = getFxQuality() * (fxFlags.low ? 0.6 : 1) * (this.calm ? 0.5 : 1);
    const low = fxFlags.reduced || fxFlags.low;
    this.lead = low ? LEAD_REDUCED : LEAD_FULL;
    this.popped = false;
    this.events = 0;
    this.emitAcc = 0;
    this.arcT = 0;
    this.spawned.fill(0);
    this.bandDone.fill(0);

    // Collapse the root transform into the bone matrices so bones live in the
    // root's parent space (translation-only for live entities).
    root.updateMatrix();
    const R0 = _m2.copy(root.matrix);
    // The body's side axis (derez slides along it) in parent space.
    const sideX = R0.elements[0], sideZ = R0.elements[2];
    const feetX = R0.elements[12], feetY = R0.elements[13], feetZ = R0.elements[14];
    const backX = R0.elements[8], backZ = R0.elements[10]; // model +Z (the back)
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.updateMatrix();
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = rig.bones[i];
      b.matrix.premultiply(R0);
      b.matrixWorldNeedsUpdate = true;
      this.startM[i].copy(b.matrix);
    }
    rig.frozen = true;
    ch.mesh.frustumCulled = false;
    ch.sockets.gun.visible = false;
    // The hat rides the head bone, which shrinks to nothing — but point-sprite
    // size ignores object scale, so an unusual-effect cloud would collapse into
    // one full-size additive blob. Hide the whole hat socket while gibbed.
    ch.sockets.headTop.visible = false;
    // Styles that cut the body with discard would leave a whole-body shadow.
    this.castShadow0 = ch.mesh.castShadow;
    ch.mesh.castShadow = this.castShadow0 && !(this.style === 'derez' || this.style === 'vaporize' || this.style === 'ember');

    // Parent-space frame: floor height + velocity rotation.
    const parent = root.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(_pp, _pq, _s);
      this.parentM.copy(parent.matrixWorld);
    } else {
      _pp.set(0, 0, 0);
      _pq.identity();
      this.parentM.identity();
    }
    this.floorY = floor ? floor.y - _pp.y : null;
    this.floorWorld = floor ? floor.y : -Infinity;
    const inv = _q2.copy(_pq).invert();
    _v2.set(vx, vy, vz).applyQuaternion(inv).multiplyScalar(0.35);

    // Torso centre (chest chunk COM) for outward directions.
    const chestB = rig.bones[B.chest].matrix;
    const cx = chestB.elements[12];
    const cy = chestB.elements[13] - 0.05;
    const cz = chestB.elements[14];
    this.flashAt.set(cx, cy + 0.05, cz);
    this.centerW.copy(this.flashAt).applyMatrix4(this.parentM);
    this.pullP.set(cx, cy + 0.12, cz);
    this.pullW.copy(this.pullP).applyMatrix4(this.parentM);

    const speedMul = this.calm ? 0.55 : 1;
    for (let i = 0; i < BONE_COUNT; i++) {
      const l = this.lead[i];
      if (l !== i) {
        // Follower: remember its transform relative to the lead.
        this.rel[i].copy(rig.bones[l].matrix).invert().multiply(rig.bones[i].matrix);
        continue;
      }
      if (!body.hasGeo[i] && i !== B.chest) continue;
      const bm = rig.bones[i].matrix;
      bm.decompose(_v, _q, _s);
      // Chunk COM in parent space.
      _v.set(this.comLocal[i * 3], this.comLocal[i * 3 + 1], this.comLocal[i * 3 + 2]).applyMatrix4(bm);
      this.pos[i * 3] = this.pos0[i * 3] = _v.x;
      this.pos[i * 3 + 1] = this.pos0[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = this.pos0[i * 3 + 2] = _v.z;
      this.quat[i * 4] = _q.x;
      this.quat[i * 4 + 1] = _q.y;
      this.quat[i * 4 + 2] = _q.z;
      this.quat[i * 4 + 3] = _q.w;
      this.baseS[i] = 1;
      // Outward from the torso, biased up; the torso itself mostly pops up.
      let dx = _v.x - cx;
      let dy = _v.y - cy;
      let dz = _v.z - cz;
      let dl = Math.hypot(dx, dy, dz);
      if (dl < 0.12) {
        const a = rnd() * TAU;
        dx = Math.cos(a) * 0.3;
        dz = Math.sin(a) * 0.3;
        dy = 1;
        dl = Math.hypot(dx, dy, dz);
      }
      const sp = (mo.speed + rnd() * mo.speedR) * speedMul;
      const up = (mo.up + rnd() * mo.upR + (i === B.head ? 0.9 : 0)) * speedMul;
      this.vel[i * 3] = (dx / dl) * sp + _v2.x + (rnd() - 0.5) * 1.2 * speedMul;
      this.vel[i * 3 + 1] = (dy / dl) * sp * mo.vert + up + _v2.y;
      this.vel[i * 3 + 2] = (dz / dl) * sp + _v2.z + (rnd() - 0.5) * 1.2 * speedMul;
      // Random tumble.
      const ax = rnd() - 0.5;
      const ay = rnd() - 0.5;
      const az = rnd() - 0.5;
      const al = Math.hypot(ax, ay, az) || 1;
      this.spinAxis[i * 3] = ax / al;
      this.spinAxis[i * 3 + 1] = ay / al;
      this.spinAxis[i * 3 + 2] = az / al;
      this.spinRate[i] = (mo.spin + rnd() * mo.spinR) * speedMul;
      this.shrinkAt[i] = mo.shrinkAt + rnd() * mo.shrinkAtR;
    }

    // Colours: the victim's energy tints the default-ish styles.
    ch.getColor(this.energy);
    // Tell a pending kill burst where this body really is, and its colour.
    _w.set(feetX, feetY, feetZ).applyMatrix4(this.parentM);
    noteDeath(_w.x, _w.y + 0.9, _w.z, this.energy.r, this.energy.g, this.energy.b);
    this.feetWorldY = _w.y;
    const feetWX = _w.x, feetWZ = _w.z;
    this.side.set(sideX, 0, sideZ).normalize();
    this.back.set(backX, 0, backZ).normalize();
    this.rollSign = rnd() < 0.5 ? -1 : 1;
    this.launched = false;
    this.glowCol.copy(this.energy).lerp(WHITE, 0.15);
    ch.resetDeathLook();
    const u = ch.uniforms;
    u.uFxCalm.value = this.calm ? 1 : 0;
    u.uKneeY.value = (Number.isFinite(this.floorWorld) ? this.floorWorld : this.feetWorldY) + 0.5;

    // Style set-up.
    // The flash: the victim's colour, ≤ ~1.5 body widths, 80 ms.
    this.flashDelay = 0;
    this.flashSize = 0.42;
    switch (this.style) {
      case 'singularity':
        this.flashDelay = FINISHER_TIMING.singularityPop;
        this.glowCol.setRGB(0.75, 0.62, 1.0);
        break;
      case 'overload':
        this.flashDelay = FINISHER_TIMING.overloadBlast;
        this.glowCol.setRGB(0.55, 0.75, 1.0);
        break;
      case 'shatter':
        this.glowCol.copy(this.energy).lerp(WHITE, 0.5);
        break;
      default:
        break;
    }
    if (this.style === 'derez') {
      // Per-band blink-out times + slide distances (alternating sides).
      const bt = u.uBandT.value;
      const bo = u.uBandO.value;
      for (let b = 0; b < DEREZ_BANDS; b++) {
        if (b >= DEREZ_SLABS) {
          bt[b] = this.bandT[b] = 9;
          bo[b] = 0;
          continue;
        }
        // Top slab first, then down the body.
        const order = DEREZ_SLABS - 1 - b;
        bt[b] = this.bandT[b] = (this.calm ? 0.2 : 0.16) + order * (this.calm ? 0.05 : 0.045) + rnd() * 0.02;
        bo[b] = (b % 2 === 0 ? 1 : -1) * (0.3 + rnd() * 0.2);
      }
      u.uBandDir.value.set(sideX, 0, sideZ).normalize();
    }
    if (this.style === 'vaporize') {
      // Wind: away from the viewer (the killer — "in the shot direction").
      let wx = feetWX - viewPos.x, wz = feetWZ - viewPos.z;
      let wl = Math.hypot(wx, wz);
      if (!viewPos.set || wl < 0.3) {
        const a = rnd() * TAU;
        wx = Math.cos(a); wz = Math.sin(a); wl = 1;
      }
      wx /= wl; wz /= wl;
      this.wind.set(wx, 0, wz);
      // The same wind in the body's rest model space drives the shader's
      // sheet dissolve (upwind side first); the CPU keys mirror it so ash
      // leaves exactly at the front.
      const sl = Math.hypot(sideX, sideZ) || 1;
      const bl = Math.hypot(backX, backZ) || 1;
      const mx = (wx * sideX + wz * sideZ) / sl;
      const mz = (wx * backX + wz * backZ) / bl;
      u.uDissolveDir.value.set(mx, 0, mz, 0.85);
      const smp = getBodySamples();
      for (let i = 0; i < SAMPLE_N; i++) {
        const px = smp.pos[i * 3], py = smp.pos[i * 3 + 1] - 1, pz = smp.pos[i * 3 + 2];
        const nz = rnd();
        const dirTerm = Math.min(1, Math.max(0, 0.5 + (px * mx + pz * mz) / 0.7)) * 0.85 + nz * 0.15;
        this.keys[i] = nz + (dirTerm - nz) * 0.85;
        void py;
      }
    }

    // Shared scene FX (particles, sprites, arcs) — only when something steps it.
    const scene = sceneOf(root);
    const ctx = scene ? peekFxContext(scene) : null;
    this.fx = ctx && ctx.managed ? ctx : null;

    // Our own flash only when no burst will play (no stepped FX context);
    // otherwise the killer's burst owns the flash (never double it).
    if (!this.calm && !this.fx) this.showFlash();
    ch.setBurn(0);
    this.update(0);
  }

  private showFlash() {
    if (!this.flash) {
      const mat = new THREE.SpriteMaterial({
        map: flashTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      this.flash = new THREE.Sprite(mat);
      this.flash.name = 'gib-flash';
      this.flash.renderOrder = 5;
      // Close to the camera the flash shrinks and dims (it must never swamp
      // the view on a point-blank frag).
      const f0 = this.flash;
      f0.onBeforeRender = (_r, _s, cam) => {
        f0.getWorldPosition(_pp);
        const d = _pp.distanceTo(_v2.setFromMatrixPosition(cam.matrixWorld));
        const k = Math.max(0.35, Math.min(1, (d - 0.6) / 3.4));
        f0.scale.set(this.flashBase * k, this.flashBase * k, 1);
        f0.updateMatrixWorld();
        mat.color.copy(this.glowCol).multiplyScalar(1.6 * Math.sqrt(k));
      };
    }
    const f = this.flash;
    f.position.copy(this.style === 'singularity' ? this.pullP : this.flashAt);
    f.material.color.copy(this.glowCol).multiplyScalar(1.6);
    f.visible = this.flashDelay <= 0;
    this.flashBase = 0.5;
    f.scale.set(0.5, 0.5, 0.5);
    f.material.opacity = 1;
    this.ch.root.add(f);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const mo = this.mo;
    // Held bodies buckle within 80 ms (never a standing, lit "live" player).
    const buckle = Math.min(1, t / 0.08) * 0.75 + 0.25 * smooth(0.08, 0.3, t);
    if (this.style === 'vaporize') {
      this.crumple(buckle, false);
    } else if (t >= mo.hold) {
      if (!this.launched) this.relaunch();
      if (this.style === 'singularity') this.singularity(dt);
      else this.integrate(dt, mo);
    } else if (this.style === 'ember' || this.style === 'overload' || this.style === 'shatter') {
      this.crumple(this.style === 'shatter' ? buckle * 0.4 : buckle, this.style === 'overload' && !this.calm && dt > 0);
    }
    this.look(dt);
    if (this.fx) this.particles(dt);
    if (this.flash && this.flash.parent) {
      const k = (t - this.flashDelay) / 0.08;
      if (k < 0) this.flash.visible = false;
      else if (k >= 1) this.flash.visible = false;
      else {
        this.flash.visible = true;
        this.flashBase = 0.35 + this.flashSize * Math.sqrt(k);
        this.flash.scale.set(this.flashBase, this.flashBase, 1);
        this.flash.material.opacity = (1 - k) * (1 - k);
      }
    }
    if (t >= mo.duration) this.done = true;
  }

  // Rigid chunks: ballistic + drag + tumble + shrink, bouncing on the floor.
  private integrate(dt: number, mo: Motion) {
    const t = this.t;
    const body = getBodyGeometry();
    const drag = Math.exp(-mo.drag * dt);
    const floorBounce = this.calm ? 0 : mo.bounce;
    for (let i = 0; i < BONE_COUNT; i++) {
      if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
      const o3 = i * 3;
      this.vel[o3 + 1] -= mo.gravity * dt;
      this.vel[o3] *= drag;
      this.vel[o3 + 2] *= drag;
      if (this.style === 'starburst' || this.style === 'nova') this.vel[o3 + 1] *= drag;
      this.pos[o3] += this.vel[o3] * dt;
      this.pos[o3 + 1] += this.vel[o3 + 1] * dt;
      this.pos[o3 + 2] += this.vel[o3 + 2] * dt;
      _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
      if (dt > 0 && this.spinRate[i] > 0) {
        _v.set(this.spinAxis[o3], this.spinAxis[o3 + 1], this.spinAxis[o3 + 2]);
        _q2.setFromAxisAngle(_v, this.spinRate[i] * dt);
        _q.premultiply(_q2);
        this.quat[i * 4] = _q.x;
        this.quat[i * 4 + 1] = _q.y;
        this.quat[i * 4 + 2] = _q.z;
        this.quat[i * 4 + 3] = _q.w;
      }
      const u = (t - this.shrinkAt[i]) / mo.shrinkDur;
      let s = this.baseS[i] * (u <= 0 ? 1 : u >= 1 ? 0.0001 : 1 - u * u * (3 - 2 * u));
      // Nova swells for a beat before it lets go.
      if (this.style === 'nova' && t < 0.1) s *= 1 + 0.14 * Math.sin((t / 0.1) * Math.PI);
      if (this.floorY !== null) {
        const r = body.radius[i] * 0.45 * s;
        if (this.pos[o3 + 1] - r < this.floorY) {
          this.pos[o3 + 1] = this.floorY + r;
          if (this.vel[o3 + 1] < 0) {
            if (floorBounce > 0) {
              this.vel[o3 + 1] *= -floorBounce;
              this.vel[o3] *= 0.55;
              this.vel[o3 + 2] *= 0.55;
              this.spinRate[i] *= 0.55;
            } else {
              this.vel[o3] = this.vel[o3 + 1] = this.vel[o3 + 2] = 0;
              this.spinRate[i] = 0;
            }
          }
        }
      }
      this.writeBone(i, s);
    }
    this.writeFollowers();
  }

  // Singularity: chunks spiral into a point (accelerating, shrinking), then
  // pop outward white-hot as small shards.
  private singularity(dt: number) {
    const t = this.t;
    const POP = FINISHER_TIMING.singularityPop;
    if (t < POP) {
      const body = getBodyGeometry();
      const u = t / POP;
      const e = Math.pow(u, 1.25);
      const px = this.pullP.x, py = this.pullP.y, pz = this.pullP.z;
      const ang = 5.5 * e;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let i = 0; i < BONE_COUNT; i++) {
        if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
        const o3 = i * 3;
        const rx = this.pos0[o3] - px, ry = this.pos0[o3 + 1] - py, rz = this.pos0[o3 + 2] - pz;
        const k = 1 - e * 0.96;
        this.pos[o3] = px + (rx * ca - rz * sa) * k;
        this.pos[o3 + 1] = py + ry * k;
        this.pos[o3 + 2] = pz + (rx * sa + rz * ca) * k;
        if (dt > 0) {
          _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
          _v.set(this.spinAxis[o3], this.spinAxis[o3 + 1], this.spinAxis[o3 + 2]);
          _q2.setFromAxisAngle(_v, this.spinRate[i] * (1 + 5 * u) * dt);
          _q.premultiply(_q2);
          this.quat[i * 4] = _q.x; this.quat[i * 4 + 1] = _q.y; this.quat[i * 4 + 2] = _q.z; this.quat[i * 4 + 3] = _q.w;
        }
        this.writeBone(i, 1 - 0.75 * e);
      }
      this.writeFollowers();
      return;
    }
    if (!this.popped) {
      this.popped = true;
      const body = getBodyGeometry();
      const sp = this.calm ? 0.55 : 1;
      for (let i = 0; i < BONE_COUNT; i++) {
        if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
        const o3 = i * 3;
        let dx = this.pos0[o3] - this.pullP.x, dy = this.pos0[o3 + 1] - this.pullP.y, dz = this.pos0[o3 + 2] - this.pullP.z;
        let dl = Math.hypot(dx, dy, dz);
        if (dl < 0.05) { dx = rnd() - 0.5; dy = rnd(); dz = rnd() - 0.5; dl = Math.hypot(dx, dy, dz); }
        const v = (6 + rnd() * 4) * sp;
        this.pos[o3] = this.pullP.x + (dx / dl) * 0.05;
        this.pos[o3 + 1] = this.pullP.y + (dy / dl) * 0.05;
        this.pos[o3 + 2] = this.pullP.z + (dz / dl) * 0.05;
        this.vel[o3] = (dx / dl) * v;
        this.vel[o3 + 1] = (dy / dl) * v + 1.5 * sp;
        this.vel[o3 + 2] = (dz / dl) * v;
        this.baseS[i] = 0.3;
        this.shrinkAt[i] = POP + 0.1 + rnd() * 0.2;
        this.spinRate[i] *= 2;
      }
    }
    this.integrate(dt, this.mo);
  }

  // A held body buckles (k 0..1): knees swing forward, the pelvis drops and
  // the torso folds forward over them; the shins pivot at the ankles to keep
  // the knees joined; feet stay planted. Overload also twitches.
  private crumple(k: number, twitch: boolean) {
    const rig = this.ch.rig;
    const sAx = this.side;
    const d = 0.46 * k;
    _H.setFromMatrixPosition(this.startM[B.hips]);
    // Upper body: fold forward about the hips and keel over to one side,
    // dropping with the pelvis.
    _cA.makeTranslation(-_H.x, -_H.y, -_H.z);
    _cB.makeRotationAxis(sAx, -0.85 * k).multiply(_cA);
    _cA.makeRotationAxis(this.back, 0.35 * k * this.rollSign);
    _cB.premultiply(_cA);
    _cA.makeTranslation(_H.x, _H.y - d, _H.z);
    _cU.multiplyMatrices(_cA, _cB);
    for (const i of UPPER) {
      rig.bones[i].matrix.multiplyMatrices(_cU, this.startM[i]);
      rig.bones[i].matrixWorldNeedsUpdate = true;
    }
    for (let side = 0; side < 2; side++) {
      const th = side === 0 ? B.thighL : B.thighR;
      const sh = side === 0 ? B.shinL : B.shinR;
      const ft = side === 0 ? B.footL : B.footR;
      _H.setFromMatrixPosition(this.startM[th]);
      _K.setFromMatrixPosition(this.startM[sh]);
      _A.setFromMatrixPosition(this.startM[ft]);
      _cA.makeTranslation(-_H.x, -_H.y, -_H.z);
      _cB.makeRotationAxis(sAx, 1.25 * k).multiply(_cA);
      _cA.makeTranslation(_H.x, _H.y - d, _H.z);
      _cU.multiplyMatrices(_cA, _cB);
      rig.bones[th].matrix.multiplyMatrices(_cU, this.startM[th]);
      _K2.copy(_K).applyMatrix4(_cU);
      _K.sub(_A);
      _K2.sub(_A);
      _X.crossVectors(_K, _K2);
      const phi = Math.atan2(_X.dot(sAx), _K.dot(_K2));
      _cA.makeTranslation(-_A.x, -_A.y, -_A.z);
      _cB.makeRotationAxis(sAx, phi).multiply(_cA);
      _cA.makeTranslation(_A.x, _A.y, _A.z);
      _cU.multiplyMatrices(_cA, _cB);
      rig.bones[sh].matrix.multiplyMatrices(_cU, this.startM[sh]);
      rig.bones[ft].matrix.copy(this.startM[ft]);
      rig.bones[th].matrixWorldNeedsUpdate = true;
      rig.bones[sh].matrixWorldNeedsUpdate = true;
      rig.bones[ft].matrixWorldNeedsUpdate = true;
    }
    if (twitch) {
      for (let i = 0; i < BONE_COUNT; i++) {
        const e = rig.bones[i].matrix.elements;
        const j = i === B.hips ? 0.008 : 0.018;
        e[12] += (rnd() - 0.5) * j;
        e[13] += (rnd() - 0.5) * j;
        e[14] += (rnd() - 0.5) * j;
      }
    }
  }

  // Chunks launch from wherever the (buckled) body is now, not the pose at
  // the moment of death.
  private relaunch() {
    this.launched = true;
    const rig = this.ch.rig;
    const body = getBodyGeometry();
    for (let i = 0; i < BONE_COUNT; i++) {
      if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
      const bm = rig.bones[i].matrix;
      bm.decompose(_v, _q, _s);
      _v.set(this.comLocal[i * 3], this.comLocal[i * 3 + 1], this.comLocal[i * 3 + 2]).applyMatrix4(bm);
      this.pos[i * 3] = _v.x;
      this.pos[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = _v.z;
      this.quat[i * 4] = _q.x;
      this.quat[i * 4 + 1] = _q.y;
      this.quat[i * 4 + 2] = _q.z;
      this.quat[i * 4 + 3] = _q.w;
    }
    // Followers keep their offsets relative to the (moved) leads.
    for (let i = 0; i < BONE_COUNT; i++) {
      const l = this.lead[i];
      if (l !== i) this.rel[i].copy(rig.bones[l].matrix).invert().multiply(rig.bones[i].matrix);
    }
  }

  // bone = T(pos) · R(q) · S(s) · T(−comLocal)
  private writeBone(i: number, s: number) {
    const o3 = i * 3;
    _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
    _s.set(s, s, s);
    _v.set(this.pos[o3], this.pos[o3 + 1], this.pos[o3 + 2]);
    _m.compose(_v, _q, _s);
    _m2.makeTranslation(-this.comLocal[o3], -this.comLocal[o3 + 1], -this.comLocal[o3 + 2]);
    const b = this.ch.rig.bones[i];
    b.matrix.multiplyMatrices(_m, _m2);
    b.matrixWorldNeedsUpdate = true;
  }

  private writeFollowers() {
    const rig = this.ch.rig;
    for (let i = 0; i < BONE_COUNT; i++) {
      const l = this.lead[i];
      if (l === i) continue;
      rig.bones[i].matrix.multiplyMatrices(rig.bones[l].matrix, this.rel[i]);
      rig.bones[i].matrixWorldNeedsUpdate = true;
    }
  }

  // ── Body-shader look per style ─────────────────────────────────────────────
  // Rules (fairness): the flash is the victim's colour and brief; the visor
  // and rim die at once (burn → igAlive); after 0.5 s the shader drops every
  // finisher emissive above the victim's knee (uKneeY).
  private look(dt: number) {
    const t = this.t;
    const ch = this.ch;
    const u = ch.uniforms;
    const E = this.energy;
    const calm = this.calm;
    const gain = calm ? 0.45 : 1;
    u.uFxTime.value = t;
    u.uFlash.value.setRGB(0, 0, 0);
    // Every style chars at once: the visor/lights/rim go dark (a corpse, not
    // a live player), plates scorch.
    const char0 = Math.min(1, t / 0.05);
    switch (this.style) {
      case 'gibstorm': {
        // Hot metal: black-body seams (starting orange, never white).
        ch.setBurn(char0);
        heatColor(t + 0.3, _heat);
        ch.setGlow(gain * 0.45 * Math.exp(-t * 2.5), _heat);
        break;
      }
      case 'ember': {
        const hold = this.mo.hold;
        const k = Math.min(1, t / hold);
        ch.setBurn(char0);
        u.uCharLine.value = -0.12 + k * 2.05;
        const cool = t < hold ? 1 : Math.exp(-(t - hold) * 3);
        u.uEdgeCol.value.setRGB(2.2 * cool * gain, 0.72 * cool * gain, 0.12 * cool * gain);
        _heat.setRGB(2.2, 0.7, 0.1);
        ch.setGlow(gain * (t < hold ? 0.15 + 0.3 * k : 0.45 * Math.exp(-(t - hold) * 4)), _heat);
        u.uDissolve.value = t < hold + 0.04 ? 0 : Math.min(1.05, (t - hold - 0.04) / 0.5);
        u.uDissolveH.value = 0;
        break;
      }
      case 'singularity': {
        const POP = FINISHER_TIMING.singularityPop;
        ch.setBurn(char0);
        if (t < POP) {
          const k = t / POP;
          _c.setRGB(0.55, 0.4, 1.0).multiplyScalar(1 + 0.8 * k);
          ch.setGlow(gain * (0.5 + 0.4 * k), _c);
        } else {
          _c.setRGB(1.6, 1.3, 2.4);
          ch.setGlow(gain * Math.exp(-(t - POP) * 7), _c);
        }
        break;
      }
      case 'shatter': {
        // t0: the armour flash-freezes to glass and white crack lines race
        // over it; then it breaks.
        ch.setBurn(char0 * 0.6);
        u.uCrystal.value = Math.min(1, t / 0.03);
        u.uCrystalCol.value.copy(E).lerp(_c.setRGB(0.72, 0.88, 1.0), 0.6).multiplyScalar(0.55 * (0.6 + 0.4 * gain));
        u.uArc.value = t < 0.1 ? 1 - t / 0.1 : 0;
        u.uArcCol.value.setRGB(3.2 * gain, 3.3 * gain, 3.5 * gain);
        ch.setGlow(0);
        break;
      }
      case 'derez': {
        ch.setBurn(char0);
        u.uBands.value.set(1.9 / DEREZ_SLABS, smooth(0, calm ? 0.3 : 0.16, t));
        u.uEdgeCol.value.copy(E).lerp(WHITE, 0.2).multiplyScalar(1.15 * (0.6 + 0.4 * gain));
        ch.setGlow(gain * 0.35 * Math.exp(-t * 10), E);
        break;
      }
      case 'vaporize': {
        // A victim-coloured flash-burn → a charcoal statue with cooling
        // cracks, crumpling → peeled off by the wind as a sheet of ash.
        ch.setBurn(char0);
        u.uAsh.value = smooth(0.0, 0.06, t);
        const cool = Math.exp(-Math.max(0, t - 0.04) * 7);
        u.uEdgeCol.value.setRGB(1.8 * cool * gain, 0.5 * cool * gain, 0.1 * cool * gain);
        ch.setGlow(gain * 0.5 * Math.max(0, 1 - t / 0.06), E);
        u.uDissolve.value = t < 0.08 ? 0 : Math.min(1.03, (t - 0.08) / 0.4);
        u.uDissolveH.value = 0;
        break;
      }
      case 'overload': {
        const blast = this.mo.hold;
        ch.setBurn(char0);
        if (t < blast) {
          const fl = calm ? 0.55 : 0.7 + 0.3 * rnd();
          u.uArc.value = fl;
          u.uArcCol.value.setRGB(1.3, 1.9, 3.0);
          _c.setRGB(0.4, 0.62, 1.0);
          ch.setGlow(gain * 0.45 * fl, _c);
        } else {
          const k = t - blast;
          u.uArc.value = Math.max(0, 1 - k / 0.15);
          _c.setRGB(0.5, 0.75, 1.6);
          ch.setGlow(gain * 0.6 * Math.exp(-k * 8), _c);
        }
        break;
      }
      case 'prism': {
        ch.setBurn(Math.min(0.6, t / 0.05));
        u.uRainbow.value = 1;
        ch.setGlow(gain * (0.3 + 0.4 * Math.exp(-t * 3)), E);
        break;
      }
      case 'voxel':
      case 'confetti': {
        ch.setBurn(char0);
        ch.setGlow(gain * 0.6, E);
        break;
      }
      default: {
        // pulse / nova / starburst: plates char at once, seams glow in the
        // victim's colour (no white-hot mannequin).
        ch.setBurn(char0);
        _c.copy(E).multiplyScalar(this.style === 'starburst' ? 2.0 : 1.8);
        ch.setGlow(gain * 0.6 * Math.exp(-t * 3), _c);
        break;
      }
    }
    void dt;
  }

  // ── Body-bound particles (shared scene pool) ───────────────────────────────

  // World position of surface sample i under the current bone matrices.
  private sampleW(i: number, out: THREE.Vector3): THREE.Vector3 {
    const s = getBodySamples();
    const b = s.bone[i];
    const r = REST_ABS[b];
    out.set(s.pos[i * 3] - r[0], s.pos[i * 3 + 1] - r[1], s.pos[i * 3 + 2] - r[2]);
    out.applyMatrix4(this.ch.rig.bones[b].matrix).applyMatrix4(this.parentM);
    return out;
  }

  private alloc(shape: FxShape): FxParticle | null {
    return this.fx!.pool.alloc(shape);
  }

  // Fairness: glowing debris is gone by 0.5 s after the death (it would hang
  // on the crosshair line otherwise).
  private cap(p: FxParticle): void {
    const rem = 0.5 - this.t - p.delay;
    if (p.life > rem) p.life = Math.max(0.04, rem);
  }

  private once(bit: number): boolean {
    if (this.events & bit) return false;
    this.events |= bit;
    return true;
  }

  private n(count: number): number {
    return Math.max(1, Math.round(count * this.q));
  }

  private particles(dt: number) {
    const t = this.t;
    const E = this.energy;
    const smp = getBodySamples();
    const cw = this.centerW;
    switch (this.style) {
      case 'pulse': {
        if (!this.once(1)) break;
        // Energy skims out along the floor with the chunks.
        const count = this.n(14);
        for (let k = 0; k < count; k++) {
          const p = this.alloc('mote');
          if (!p) break;
          const a = (k / count) * TAU + rnd() * 0.3;
          p.x = cw.x; p.y = this.floorBase() + 0.12; p.z = cw.z;
          const sp = 3.5 + rnd() * 2;
          p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 0;
          p.drag = 3;
          p.setScale(0.14);
          p.life = 0.4;
          p.fadePow = 1.3;
          p.setRGB(E.r * 2.2, E.g * 2.2, E.b * 2.2);
        }
        break;
      }
      case 'nova': {
        if (!this.once(1)) break;
        // Motes shoot straight up the pillar.
        const count = this.n(16);
        for (let k = 0; k < count; k++) {
          const p = this.alloc('mote');
          if (!p) break;
          const a = rnd() * TAU, r = rnd() * 0.22;
          p.x = cw.x + Math.cos(a) * r; p.y = this.floorBase() + 0.2 + rnd() * 0.8; p.z = cw.z + Math.sin(a) * r;
          p.vx = 0; p.vz = 0; p.vy = 5 + rnd() * 4;
          p.drag = 2;
          p.setScale(0.12);
          p.life = 0.35;
          p.fadePow = 1.2;
          p.setRGB(E.r * 2.2, E.g * 2.2, E.b * 2.2);
          this.cap(p);
        }
        break;
      }
      case 'starburst': {
        if (this.once(1)) this.spikes();
        break;
      }
      case 'prism': {
        if (this.once(1)) this.prismShards();
        break;
      }
      case 'gibstorm': {
        if (!this.once(1)) break;
        const n = this.n(24);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('box');
          if (!p) break;
          p.x = cw.x; p.y = cw.y; p.z = cw.z;
          const a = rnd() * TAU, uu = rnd() * 1.6 - 0.5, sq = Math.sqrt(Math.max(0, 1 - uu * uu)), sp = 5 + rnd() * 6;
          p.vx = Math.cos(a) * sq * sp; p.vy = uu * sp + 2; p.vz = Math.sin(a) * sq * sp;
          p.gravity = 16;
          p.align = true;
          p.setScale(0.02, 0.02, 0.2 + rnd() * 0.15);
          p.life = 0.3 + rnd() * 0.2;
          p.fadePow = 1.2;
          p.setRGB(2.6, 1.3, 0.35);
          this.cap(p);
        }
        // Hot debris that bounces and cools on the floor.
        const d = this.n(14);
        for (let k = 0; k < d; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          this.sampleW((k * 11) % SAMPLE_N, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          const a = rnd() * TAU, sp = 2 + rnd() * 3.5;
          p.vx = Math.cos(a) * sp; p.vy = 1.5 + rnd() * 3; p.vz = Math.sin(a) * sp;
          p.gravity = 24;
          p.floor = this.floorBase();
          p.bounce = 0.35;
          p.setScale(0.04 + rnd() * 0.04);
          p.randomOrientation();
          p.randomSpin(6 + rnd() * 10);
          p.life = 1.0 + rnd() * 0.3;
          p.scaleFade = true;
          p.setRGB(1.8, 0.6, 0.12);
          p.setRamp(0.05, 0.05, 0.06);
        }
        break;
      }
      case 'voxel': {
        if (!this.once(1)) break;
        // The body becomes its own volume of cubes (grid-aligned at t0, so
        // the first frame is a voxel statue), which drop, bounce and pile.
        const n = this.n(96);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          const i = (k * 5 + 3) % SAMPLE_N;
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          let dx = _w.x - cw.x, dz = _w.z - cw.z;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          const sp = 0.3 + rnd() * 1.4;
          p.vx = dx * sp + (rnd() - 0.5) * 0.6;
          p.vy = rnd() * 1.6;
          p.vz = dz * sp + (rnd() - 0.5) * 0.6;
          p.gravity = 18;
          p.floor = this.floorBase();
          p.bounce = 0.38;
          p.setScale(0.08 + rnd() * 0.03);
          p.qx = 0; p.qy = 0; p.qz = 0; p.qw = 1;
          p.randomSpin(2 + rnd() * 7);
          p.life = 1.25 + rnd() * 0.3;
          p.scaleFade = true;
          const kind = smp.kind[i];
          const v = 0.8 + rnd() * 0.4;
          if (kind === SAMPLE_ARMOR) { p.setRGB(E.r * v, E.g * v, E.b * v); p.setRamp(E.r * 0.3, E.g * 0.3, E.b * 0.3); }
          else if (kind === SAMPLE_GLOW) { p.setRGB(E.r * 1.6, E.g * 1.6, E.b * 1.6); p.setRamp(E.r * 0.3, E.g * 0.3, E.b * 0.3); }
          else p.setRGB(0.05 * v, 0.055 * v, 0.07 * v);
        }
        break;
      }
      case 'ember': {
        // Embers peel off the climbing char front (short-lived: nothing
        // glowing hangs at head height past 0.5 s).
        if (t > 0.4) break;
        const rate = 110;
        this.emitAcc += dt * rate * this.q;
        const line = -0.12 + Math.min(1, t / this.mo.hold) * 2.05;
        let guard = 0;
        while (this.emitAcc >= 1 && guard++ < 12) {
          this.emitAcc -= 1;
          const p = this.alloc('mote');
          if (!p) break;
          let i = Math.floor(rnd() * SAMPLE_N);
          for (let tries = 0; tries < 6 && Math.abs(smp.pos[i * 3 + 1] - line) > 0.25; tries++) i = Math.floor(rnd() * SAMPLE_N);
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          p.vx = (rnd() - 0.5) * 0.8; p.vz = (rnd() - 0.5) * 0.8;
          p.vy = 1.0 + rnd() * 1.6;
          p.gravity = -1.2;
          p.drag = 1.2;
          const big = rnd() < 0.25;
          p.setScale(big ? 0.13 : 0.05);
          p.life = big ? 0.25 : 0.3 + rnd() * 0.15;
          p.fadePow = 1.2;
          if (big) p.setRGB(1.3, 0.42, 0.06);
          else p.setRGB(2.6, 1.2, 0.3);
          p.setRamp(big ? 0.4 : 1.2, big ? 0.06 : 0.25, 0.02);
          this.cap(p);
        }
        break;
      }
      case 'singularity': {
        const POP = FINISHER_TIMING.singularityPop;
        const pw = this.pullW;
        if (this.once(1)) {
          // Infalling motes spiralling into the point.
          const n = this.n(14);
          for (let k = 0; k < n; k++) {
            const p = this.alloc('mote');
            if (!p) break;
            const a = (k / n) * TAU;
            const r = 0.7 + rnd() * 0.4;
            const y = (rnd() - 0.5) * 1.1;
            p.x = pw.x + Math.cos(a) * r; p.y = pw.y + y; p.z = pw.z + Math.sin(a) * r;
            const tt = POP * (0.85 + rnd() * 0.15);
            p.vx = (pw.x - p.x) / tt - Math.sin(a) * 0.6;
            p.vy = (pw.y - p.y) / tt;
            p.vz = (pw.z - p.z) / tt + Math.cos(a) * 0.6;
            p.setScale(0.11);
            p.life = tt;
            p.fadePow = 0.4;
            p.setRGB(0.7, 0.55, 2.2);
          }
        }
        if (t >= POP && this.once(2)) {
          // The release: a hard outward spray of violet-white debris.
          const n = this.n(24);
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            p.x = pw.x; p.y = pw.y; p.z = pw.z;
            const uu = rnd() * 1.4 - 0.7, a = rnd() * TAU, sq = Math.sqrt(1 - uu * uu), sp = 7 + rnd() * 6;
            p.vx = Math.cos(a) * sq * sp; p.vy = uu * sp; p.vz = Math.sin(a) * sq * sp;
            p.drag = 2.5;
            p.align = true;
            p.setScale(0.024, 0.024, 0.34);
            p.life = 0.26;
            p.fadePow = 1.3;
            if (k % 3 === 0) p.setRGB(2.4, 2.3, 2.8);
            else p.setRGB(1.0, 0.6, 2.4);
            this.cap(p);
          }
          if (!this.calm) this.fx!.lights.pulse(1, pw.x, pw.y, pw.z, 0xb8a0ff, 9, 0.1, 7);
        }
        break;
      }
      case 'shatter': {
        if (t < this.mo.hold || !this.once(1)) break;
        // Thin glass shards drop straight down, bounce once and lie there.
        const ice = _c.copy(E).lerp(WHITE, 0.6);
        const n = this.n(48);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('shard');
          if (!p) break;
          const i = (k * 5) % SAMPLE_N;
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          let dx = _w.x - cw.x, dz = _w.z - cw.z;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          const sp = 0.3 + rnd() * 1.1;
          p.vx = dx * sp; p.vy = -0.3 + rnd() * 1.0; p.vz = dz * sp;
          p.gravity = 16;
          p.floor = this.floorBase();
          p.bounce = 0.25;
          const sz = 0.07 + rnd() * 0.07;
          p.setScale(sz, sz * (0.9 + rnd() * 0.6), sz);
          p.randomOrientation();
          p.randomSpin(4 + rnd() * 8);
          p.life = 0.5;
          p.fadePow = 1.5;
          const v = 1.6 + rnd() * 0.6;
          p.setRGB(ice.r * v, ice.g * v, ice.b * v);
          this.cap(p);
        }
        // They break on the floor: glints right at floor level.
        const g = this.n(10);
        for (let k = 0; k < g; k++) {
          const p = this.alloc('glint');
          if (!p) break;
          this.sampleW((k * 23 + 3) % SAMPLE_N, _w);
          const a = rnd() * TAU, r = 0.1 + rnd() * 0.5;
          p.x = cw.x + Math.cos(a) * r; p.y = this.floorBase() + 0.04; p.z = cw.z + Math.sin(a) * r;
          p.delay = 0.28 + rnd() * 0.2;
          p.setScale(0.22 + rnd() * 0.12);
          p.rot = rnd() * TAU;
          p.life = 0.12;
          p.fadePow = 1.5;
          p.setRGB(2.6, 2.8, 3.0);
        }
        break;
      }
      case 'confetti': {
        if (!this.once(1)) break;
        // A party cannon BLAST: paper fired outward hard from the chest,
        // braking on air drag, then fluttering down.
        const n = this.n(130);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('flake');
          if (!p) break;
          p.x = cw.x + (rnd() - 0.5) * 0.25; p.y = cw.y + (rnd() - 0.3) * 0.3; p.z = cw.z + (rnd() - 0.5) * 0.25;
          const uu = -0.25 + rnd() * 1.15, a = rnd() * TAU, sq = Math.sqrt(Math.max(0, 1 - Math.min(1, uu) ** 2));
          const sp = 5 + rnd() * 6;
          p.vx = Math.cos(a) * sq * sp; p.vy = Math.min(1, uu) * sp; p.vz = Math.sin(a) * sq * sp;
          p.drag = 3.4;
          p.gravity = 12;
          p.floor = this.floorBase();
          p.setScale(0.07 + rnd() * 0.02, 0.045 + rnd() * 0.015, 1);
          p.randomOrientation();
          p.randomSpin(10 + rnd() * 14);
          p.life = 1.0 + rnd() * 0.35;
          p.scaleFade = true;
          const c = k % 8 === 0 ? null : CONFETTI[Math.floor(rnd() * CONFETTI.length)];
          if (c) p.setRGB(c[0], c[1], c[2]);
          else p.setRGB(Math.min(1, E.r * 1.3), Math.min(1, E.g * 1.3), Math.min(1, E.b * 1.3));
        }
        // Three streamers whipping out.
        const st = this.calm ? 1 : 3;
        for (let k = 0; k < st; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          p.x = cw.x; p.y = cw.y + 0.1; p.z = cw.z;
          const a = (k / st) * TAU + rnd() * 0.8;
          p.vx = Math.cos(a) * 4; p.vz = Math.sin(a) * 4;
          p.vy = 5 + rnd() * 2;
          p.drag = 2.2;
          p.gravity = 12;
          p.align = true;
          p.setScale(0.03, 0.006, 0.55);
          p.life = 0.8;
          p.scaleFade = true;
          this.cap(p);
          const c = CONFETTI[(k * 2) % CONFETTI.length];
          p.setRGB(c[0], c[1], c[2]);
        }
        break;
      }
      case 'derez': {
        // Digital debris where each slab blinks out.
        const bh = 1.9 / DEREZ_SLABS;
        const bo = this.ch.uniforms.uBandO.value;
        const prog = this.ch.uniforms.uBands.value.y;
        const dir = this.ch.uniforms.uBandDir.value;
        for (let b = 0; b < DEREZ_SLABS; b++) {
          if (this.bandDone[b] || t < this.bandT[b]) continue;
          this.bandDone[b] = 1;
          if (rnd() > this.q + 0.15) continue;
          const n = this.calm ? 2 : 7;
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            const off = bo[b] * prog;
            _w.set(this.flashAt.x + dir.x * off, (b + 0.2 + rnd() * 0.6) * bh, this.flashAt.z + dir.z * off).applyMatrix4(this.parentM);
            p.x = _w.x + (rnd() - 0.5) * 0.4; p.y = _w.y; p.z = _w.z + (rnd() - 0.5) * 0.4;
            p.vx = (rnd() - 0.5) * 0.4; p.vy = -0.2 - rnd() * 0.6; p.vz = (rnd() - 0.5) * 0.4;
            p.drag = 1.5;
            p.setScale(0.028 + rnd() * 0.02);
            p.life = 0.16 + rnd() * 0.1;
            p.fadePow = 1.2;
            p.setRGB(E.r * 2.4 + 0.3, E.g * 2.4 + 0.3, E.b * 2.4 + 0.3);
            this.cap(p);
          }
        }
        break;
      }
      case 'vaporize': {
        // The ash peels off as a sheet exactly where the dissolve front is,
        // streaming away from the viewer on the wind.
        const d = this.ch.uniforms.uDissolve.value;
        if (d <= 0) break;
        const n = Math.min(SAMPLE_N, Math.round(180 * this.q));
        const w = this.wind;
        for (let i = 0; i < n; i++) {
          if (this.spawned[i] || this.keys[i] >= d) continue;
          this.spawned[i] = 1;
          this.sampleW(i, _w);
          const ember = i % 6 === 0;
          const p = this.alloc(ember ? 'mote' : 'flake');
          if (!p) continue;
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          const gust = 1.8 + rnd() * 1.6;
          p.vx = w.x * gust + (rnd() - 0.5) * 0.35;
          p.vy = 0.1 + rnd() * 0.45;
          p.vz = w.z * gust + (rnd() - 0.5) * 0.35;
          p.drag = 1.0;
          p.gravity = -0.2;
          if (ember) {
            p.life = 0.25;
            p.setScale(0.05);
            p.fadePow = 1.2;
            p.setRGB(2.0, 0.6, 0.12);
            p.setRamp(0.5, 0.06, 0.0);
            this.cap(p);
          } else {
            p.life = 0.7 + rnd() * 0.35;
            const sz = 0.05 + rnd() * 0.035;
            p.setScale(sz, sz * (0.6 + rnd() * 0.5), 1);
            p.randomOrientation();
            p.randomSpin(3 + rnd() * 7);
            p.scaleFade = true;
            p.setRGB(0.2, 0.19, 0.18);
            p.setRamp(0.09, 0.085, 0.08);
          }
        }
        break;
      }
      case 'overload': {
        const blast = this.mo.hold;
        if (t < blast) {
          if (this.calm) break;
          // A stream of short arcs jumping between points on the body.
          this.arcT -= dt;
          const arcs = this.fx!.arcs;
          while (this.arcT <= 0) {
            this.arcT += 0.024;
            const a = Math.floor(rnd() * SAMPLE_N);
            const b = Math.floor(rnd() * SAMPLE_N);
            this.sampleW(a, _w);
            this.sampleW(b, _v2);
            _v2.sub(_w);
            const l = _v2.length();
            if (l > 0.55) _v2.multiplyScalar(0.55 / l);
            _v2.add(_w);
            arcs.spawn(_w.x, _w.y, _w.z, _v2.x, _v2.y, _v2.z, 1.9, 2.5, 3.6, 0.028, 0.07, 0.06);
          }
        } else if (this.once(1)) {
          const n = this.n(16);
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            p.x = cw.x + (rnd() - 0.5) * 0.3; p.y = cw.y - 0.2 + (rnd() - 0.5) * 0.3; p.z = cw.z + (rnd() - 0.5) * 0.3;
            const uu = rnd() * 1.6 - 0.9, a = rnd() * TAU, sq = Math.sqrt(Math.max(0, 1 - uu * uu)), sp = 6 + rnd() * 7;
            p.vx = Math.cos(a) * sq * sp; p.vy = uu * sp; p.vz = Math.sin(a) * sq * sp;
            p.gravity = 12;
            p.align = true;
            p.setScale(0.02, 0.02, 0.28 + rnd() * 0.2);
            p.life = 0.25 + rnd() * 0.08;
            p.fadePow = 1.3;
            p.setRGB(k % 3 === 0 ? 0.8 : 1.5, k % 3 === 0 ? 1.2 : 1.8, 2.4);
            this.cap(p);
          }
          if (!this.calm) this.fx!.lights.pulse(1, cw.x, cw.y, cw.z, 0x9fd0ff, 9, 0.1, 7);
        }
        break;
      }
    }
  }

  // Floor height (world) under the body — its feet if there is no floor.
  private floorBase(): number {
    return Number.isFinite(this.floorWorld) ? this.floorWorld : this.feetWorldY;
  }

  // Starburst: a light spike fired along each chunk's flight line.
  private spikes() {
    const body = getBodyGeometry();
    const E = this.energy;
    for (let i = 0; i < BONE_COUNT; i++) {
      if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
      const p = this.alloc('box');
      if (!p) break;
      const o3 = i * 3;
      _w.set(this.pos[o3], this.pos[o3 + 1], this.pos[o3 + 2]).applyMatrix4(this.parentM);
      p.x = _w.x; p.y = _w.y; p.z = _w.z;
      _v.set(this.vel[o3], this.vel[o3 + 1], this.vel[o3 + 2]).normalize();
      const sp = 11 + rnd() * 4;
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.drag = 5;
      p.align = true;
      p.setScale(0.03, 0.03, 0.55);
      p.life = 0.24;
      p.fadePow = 1.5;
      p.setRGB(E.r * 1.8 + 0.8, E.g * 1.8 + 0.8, E.b * 1.8 + 0.8);
    }
  }

  // Prism: rainbow glass shards and glints.
  private prismShards() {
    const cw = this.centerW;
    const n = this.n(36);
    for (let k = 0; k < n; k++) {
      const p = this.alloc('shard');
      if (!p) break;
      this.sampleW((k * 7 + 1) % SAMPLE_N, _w);
      p.x = _w.x; p.y = _w.y; p.z = _w.z;
      let dx = _w.x - cw.x, dy = _w.y - cw.y, dz = _w.z - cw.z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const sp = 3 + rnd() * 4;
      p.vx = dx * sp; p.vy = dy * sp * 0.5 + 1 + rnd() * 2; p.vz = dz * sp;
      p.gravity = 16;
      p.floor = this.floorBase();
      p.bounce = 0.3;
      const sz = 0.06 + rnd() * 0.06;
      p.setScale(sz, sz * 1.3, sz);
      p.randomOrientation();
      p.randomSpin(6 + rnd() * 12);
      p.life = 0.48;
      p.fadePow = 1.3;
      _c.setHSL(k / n, 1, 0.55);
      p.setRGB(_c.r * 2.4, _c.g * 2.4, _c.b * 2.4);
      this.cap(p);
    }
    const g = this.n(8);
    for (let k = 0; k < g; k++) {
      const p = this.alloc('glint');
      if (!p) break;
      this.sampleW((k * 31 + 9) % SAMPLE_N, _w);
      p.x = _w.x; p.y = _w.y; p.z = _w.z;
      p.vx = (rnd() - 0.5) * 3; p.vy = 1 + rnd() * 2; p.vz = (rnd() - 0.5) * 3;
      p.gravity = 6;
      p.delay = rnd() * 0.25;
      p.setScale(0.28);
      p.rot = rnd() * TAU;
      p.life = 0.14;
      _c.setHSL(rnd(), 1, 0.7);
      p.setRGB(_c.r * 3, _c.g * 3, _c.b * 3);
      this.cap(p);
    }
  }

  // Back to a whole body (respawn). The animator re-poses the bones next update.
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.done = false;
    const ch = this.ch;
    ch.rig.frozen = false;
    ch.mesh.frustumCulled = true;
    ch.mesh.castShadow = this.castShadow0;
    ch.sockets.gun.visible = true;
    ch.sockets.headTop.visible = true;
    ch.resetDeathLook();
    this.fx = null;
    if (this.flash) {
      this.flash.visible = false;
      this.flash.parent?.remove(this.flash);
    }
  }

  dispose(): void {
    this.stop();
    if (this.flash) {
      this.flash.material.dispose();
      this.flash = null;
    }
  }
}
