import * as THREE from 'three';
import { DEREZ_BANDS, getBodyGeometry, getBodySamples, SAMPLE_ARMOR, SAMPLE_GLOW } from './body';
import type { KillEffectStyle } from '../cosmetics';
import type { Character } from './character';
import { B, BONE_COUNT, REST_ABS } from './rig';
import { getFxQuality, peekFxContext, type FxContext, type FxParticle, type FxShape } from '../fx-pool';
import { FINISHER_TIMING, fxFlags } from '../fx/fx-settings';

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
  pulse: BASE,
  // A bloom: chunks drift out level and hang (drag), barely tumbling.
  nova: M({ speed: 2.2, speedR: 2.0, up: 0.9, upR: 1.1, vert: 0.25, spin: 2, spinR: 4, gravity: 8, drag: 1.5, shrinkAt: 0.42, shrinkAtR: 0.3 }),
  // Spikes: fired straight out, no tumble, stopping hard.
  starburst: M({ speed: 6.5, speedR: 3, up: 0.4, upR: 1.0, vert: 0.45, spin: 0, spinR: 0, gravity: 4, drag: 3.6, shrinkAt: 0.28, shrinkAtR: 0.22, shrinkDur: 0.3 }),
  gibstorm: M({ speed: 4.5, speedR: 5, up: 3, upR: 3.5, spin: 10, spinR: 14, gravity: 26, drag: 0.3, shrinkAt: 0.62, shrinkAtR: 0.35, bounce: 0.38 }),
  // The body is replaced by voxels almost at once.
  voxel: M({ speed: 1.2, speedR: 1.2, up: 0.8, upR: 0.8, shrinkAt: 0.035, shrinkAtR: 0.02, shrinkDur: 0.06, duration: 0.5 }),
  // Burns standing, then crumbles where it stood.
  ember: M({ hold: 0.3, speed: 0.3, speedR: 0.9, up: 0, upR: 0.7, vert: 0.2, spin: 1, spinR: 3, gravity: 12, drag: 0.8, shrinkAt: 0.62, shrinkAtR: 0.3, shrinkDur: 0.45, bounce: 0 }),
  // Custom motion (see update): spiral in, pop out.
  singularity: M({ speed: 6, speedR: 3, up: 1.5, upR: 1.5, spin: 8, spinR: 8, gravity: 12, drag: 0.6, shrinkAt: 0.45, shrinkAtR: 0.2, shrinkDur: 0.3 }),
  // Freezes to glass for a beat, then shatters (chunks break up fast).
  shatter: M({ hold: 0.07, speed: 3, speedR: 2.5, up: 1.5, upR: 2, spin: 8, spinR: 10, gravity: 20, drag: 0.3, shrinkAt: 0.18, shrinkAtR: 0.18, shrinkDur: 0.25, duration: 1.0 }),
  // Pops: the body is gone in a blink, the confetti carries the moment.
  confetti: M({ speed: 1, speedR: 1, up: 1, upR: 1, shrinkAt: 0.02, shrinkAtR: 0.02, shrinkDur: 0.05, duration: 0.4 }),
  derez: M({ hold: Infinity, duration: 1.0 }),
  vaporize: M({ hold: Infinity, duration: 1.2 }),
  overload: M({ hold: FINISHER_TIMING.overloadBlast, speed: 5, speedR: 4, up: 2, upR: 3, spin: 10, spinR: 10, gravity: 20, shrinkAt: 0.6, shrinkAtR: 0.3 }),
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
  private flashSize = 2.3;
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
    this.glowCol.copy(this.energy).lerp(WHITE, 0.55);
    ch.resetDeathLook();
    const u = ch.uniforms;
    u.uFxCalm.value = this.calm ? 1 : 0;

    // Style set-up.
    this.flashDelay = 0;
    this.flashSize = 2.3;
    switch (this.style) {
      case 'singularity':
        this.flashDelay = FINISHER_TIMING.singularityPop;
        this.glowCol.setRGB(0.9, 0.85, 1.0);
        break;
      case 'overload':
        this.flashDelay = FINISHER_TIMING.overloadBlast;
        this.glowCol.setRGB(0.65, 0.82, 1.0);
        this.flashSize = 2.8;
        break;
      case 'vaporize':
        this.glowCol.setRGB(1, 0.95, 0.85);
        this.flashSize = 2.6;
        break;
      case 'derez':
        this.flashSize = 1.4;
        break;
      case 'shatter':
        this.glowCol.copy(this.energy).lerp(WHITE, 0.75);
        break;
      case 'confetti':
        this.glowCol.setRGB(1, 0.95, 0.9);
        this.flashSize = 1.8;
        break;
      default:
        break;
    }
    if (this.style === 'derez') {
      // Per-band blink-out times + slide distances (alternating sides).
      const bt = u.uBandT.value;
      const bo = u.uBandO.value;
      for (let b = 0; b < DEREZ_BANDS; b++) {
        bt[b] = this.bandT[b] = 0.22 + rnd() * (this.calm ? 0.4 : 0.58);
        bo[b] = (b % 2 === 0 ? 1 : -1) * (0.18 + rnd() * 0.5);
      }
      u.uBandDir.value.set(sideX, 0, sideZ).normalize();
    }
    if (this.style === 'vaporize') {
      // Dissolve keys (roughly matching the shader's top-first bias) and a wind.
      const smp = getBodySamples();
      for (let i = 0; i < SAMPLE_N; i++) {
        const h = Math.min(1, Math.max(0, smp.pos[i * 3 + 1] / 1.85));
        const r = rnd();
        this.keys[i] = r * 0.4 + ((1 - h) * 0.8 + r * 0.2) * 0.6;
      }
      const a = rnd() * TAU;
      this.wind.set(Math.cos(a), 0, Math.sin(a));
    }

    // Shared scene FX (particles, sprites, arcs) — only when something steps it.
    const scene = sceneOf(root);
    const ctx = scene ? peekFxContext(scene) : null;
    this.fx = ctx && ctx.managed ? ctx : null;

    if (!this.calm) this.showFlash();
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
    }
    const f = this.flash;
    f.position.copy(this.style === 'singularity' ? this.pullP : this.flashAt);
    f.material.color.copy(this.glowCol).multiplyScalar(2.2);
    f.visible = this.flashDelay <= 0;
    f.scale.set(0.5, 0.5, 0.5);
    f.material.opacity = 1;
    this.ch.root.add(f);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const mo = this.mo;
    if (t >= mo.hold) {
      if (this.style === 'singularity') this.singularity(dt);
      else this.integrate(dt, mo);
    } else if (this.style === 'overload' && !this.calm && dt > 0) {
      this.twitch();
    }
    this.look(dt);
    if (this.fx) this.particles(dt);
    if (this.flash && this.flash.parent) {
      const k = (t - this.flashDelay) / 0.2;
      if (k < 0) this.flash.visible = false;
      else if (k >= 1) this.flash.visible = false;
      else {
        this.flash.visible = true;
        const sz = 0.5 + this.flashSize * Math.sqrt(k);
        this.flash.scale.set(sz, sz, sz);
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
      const e = u * u;
      const px = this.pullP.x, py = this.pullP.y, pz = this.pullP.z;
      const ang = 4.2 * e;
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
        this.writeBone(i, 1 - 0.7 * e);
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

  // Overload: the posed body twitches as the current runs through it.
  private twitch() {
    const rig = this.ch.rig;
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = rig.bones[i];
      b.matrix.copy(this.startM[i]);
      const e = b.matrix.elements;
      const k = i === B.hips ? 0.008 : 0.018;
      e[12] += (rnd() - 0.5) * k;
      e[13] += (rnd() - 0.5) * k;
      e[14] += (rnd() - 0.5) * k;
      b.matrixWorldNeedsUpdate = true;
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
  private look(dt: number) {
    const t = this.t;
    const ch = this.ch;
    const u = ch.uniforms;
    const E = this.energy;
    const calm = this.calm;
    const gain = calm ? 0.45 : 1;
    u.uFxTime.value = t;
    u.uFlash.value.setRGB(0, 0, 0);
    switch (this.style) {
      case 'gibstorm': {
        // Hot metal: black-body seams.
        ch.setBurn(Math.min(1, t / 0.07));
        heatColor(t, _heat);
        ch.setGlow(gain * Math.exp(-t * 1.5), _heat);
        break;
      }
      case 'ember': {
        const hold = this.mo.hold;
        const k = Math.min(1, t / hold);
        u.uCharLine.value = -0.12 + k * 2.05;
        const cool = t < hold ? 1 : Math.exp(-(t - hold) * 2.2);
        u.uEdgeCol.value.setRGB(2.8 * cool * gain, 0.95 * cool * gain, 0.16 * cool * gain);
        _heat.setRGB(2.4, 0.8, 0.12);
        ch.setGlow(gain * (t < hold ? 0.35 + 0.65 * k : Math.exp(-(t - hold) * 2.5)), _heat);
        u.uDissolve.value = t < hold + 0.05 ? 0 : Math.min(1.05, (t - hold - 0.05) / 0.75);
        u.uDissolveH.value = 0;
        break;
      }
      case 'singularity': {
        const POP = FINISHER_TIMING.singularityPop;
        if (t < POP) {
          const k = t / POP;
          ch.setBurn(0.3 * k);
          _c.setRGB(0.45 + 0.55 * k, 0.35 + 0.6 * k, 1.0).multiplyScalar(1 + 2.5 * k);
          ch.setGlow(gain * (0.5 + 0.8 * k), _c);
        } else {
          const k = t - POP;
          ch.setBurn(1);
          _c.setRGB(3, 3, 3.2);
          ch.setGlow(gain * Math.exp(-k * 5), _c);
          if (k < 0.05 && !calm) u.uFlash.value.setRGB(1.5, 1.5, 1.7);
        }
        break;
      }
      case 'shatter': {
        u.uCrystal.value = Math.min(1, t / 0.05);
        u.uCrystalCol.value.copy(E).lerp(_c.setRGB(0.72, 0.88, 1.0), 0.55).multiplyScalar(1.3 * (0.6 + 0.4 * gain));
        ch.setGlow(0);
        if (t < 0.05 && !calm) u.uFlash.value.copy(u.uCrystalCol.value).multiplyScalar(0.5);
        break;
      }
      case 'derez': {
        u.uBands.value.set(1.9 / DEREZ_BANDS, smooth(0.08, calm ? 1.0 : 0.8, t));
        u.uEdgeCol.value.copy(E).lerp(WHITE, 0.15).multiplyScalar(2.3 * (0.6 + 0.4 * gain));
        ch.setGlow(gain * Math.exp(-t * 5), E);
        break;
      }
      case 'vaporize': {
        // White-hot flash → ash statue with glowing cracks → blows away.
        const flashK = 1 - smooth(0.0, 0.09, t);
        if (!calm) u.uFlash.value.setRGB(2.6 * flashK, 2.4 * flashK, 2.1 * flashK);
        u.uAsh.value = smooth(0.04, 0.2, t);
        const cool = Math.exp(-Math.max(0, t - 0.15) * 2.4);
        u.uEdgeCol.value.setRGB(2.6 * cool * gain, 0.85 * cool * gain, 0.16 * cool * gain);
        _c.setRGB(3, 2.8, 2.5);
        ch.setGlow(gain * flashK, _c);
        u.uDissolve.value = t < 0.22 ? 0 : Math.min(1.03, (t - 0.22) / 0.85);
        u.uDissolveH.value = 0.6;
        break;
      }
      case 'overload': {
        const blast = this.mo.hold;
        if (t < blast) {
          const fl = calm ? 0.55 : 0.65 + 0.35 * rnd();
          u.uArc.value = fl;
          u.uArcCol.value.setRGB(1.6, 2.2, 3.2);
          _c.setRGB(0.5, 0.72, 1.0);
          ch.setGlow(gain * 0.7 * fl, _c);
        } else {
          const k = t - blast;
          u.uArc.value = Math.max(0, 1 - k / 0.25);
          ch.setBurn(Math.min(1, k / 0.07));
          _c.setRGB(1.6, 2.2, 3.4);
          ch.setGlow(gain * Math.exp(-k * 2.2), _c);
          if (k < 0.05 && !calm) u.uFlash.value.setRGB(0.9, 1.2, 1.8);
        }
        break;
      }
      case 'prism': {
        ch.setBurn(Math.min(0.55, t / 0.1));
        u.uRainbow.value = 1;
        ch.setGlow(gain * (0.6 + 0.6 * Math.exp(-t * 1.2)), E);
        break;
      }
      case 'nova': {
        ch.setBurn(Math.min(0.6, t / 0.1));
        _c.copy(E).lerp(WHITE, Math.max(0, 1 - t / 0.12)).multiplyScalar(2.6);
        ch.setGlow(gain * Math.exp(-t * 1.1), _c);
        break;
      }
      case 'voxel':
      case 'confetti': {
        _c.copy(E).lerp(WHITE, 0.3).multiplyScalar(3);
        ch.setGlow(gain, _c);
        if (t < 0.04 && !calm) u.uFlash.value.copy(E).multiplyScalar(0.8);
        break;
      }
      default: {
        // pulse / starburst: plates char, seams flare white-hot then settle
        // into the victim's energy colour.
        ch.setBurn(Math.min(1, t / 0.07));
        const w = Math.max(0, 1 - t / (this.style === 'starburst' ? 0.08 : 0.12));
        _c.copy(E).lerp(WHITE, w).multiplyScalar(this.style === 'starburst' ? 2.8 : 2.4);
        ch.setGlow(gain * Math.exp(-t * (this.style === 'starburst' ? 2.0 : 1.5)), _c);
        if (t < 0.04 && !calm) u.uFlash.value.copy(E).multiplyScalar(0.5);
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
      case 'pulse':
      case 'nova':
      case 'starburst':
      case 'prism': {
        if (!this.once(1)) break;
        if (this.style === 'starburst') this.spikes();
        else if (this.style === 'prism') this.prismShards();
        else {
          // Energy wisps in the victim's colour (nova: a level ring).
          const nova = this.style === 'nova';
          const count = this.n(nova ? 18 : 12);
          for (let k = 0; k < count; k++) {
            const p = this.alloc('mote');
            if (!p) break;
            this.sampleW((k * 7) % SAMPLE_N, _w);
            p.x = _w.x; p.y = _w.y; p.z = _w.z;
            const a = nova ? (k / count) * TAU : rnd() * TAU;
            const sp = nova ? 3.2 + rnd() * 1.2 : 1.5 + rnd() * 2.5;
            p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp;
            p.vy = nova ? (rnd() - 0.3) * 0.8 : 1 + rnd() * 2;
            p.drag = nova ? 2.6 : 1.6;
            p.gravity = nova ? 0 : 2;
            p.setScale(nova ? 0.16 : 0.12);
            p.life = nova ? 0.55 : 0.45;
            p.fadePow = 1.3;
            p.setRGB(E.r * 2.2, E.g * 2.2, E.b * 2.2);
          }
        }
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
          p.life = 0.4 + rnd() * 0.3;
          p.fadePow = 1.2;
          p.setRGB(2.6, 1.3, 0.35);
        }
        const d = this.n(12);
        for (let k = 0; k < d; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          this.sampleW((k * 11) % SAMPLE_N, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          const a = rnd() * TAU, sp = 2 + rnd() * 3.5;
          p.vx = Math.cos(a) * sp; p.vy = 2 + rnd() * 4; p.vz = Math.sin(a) * sp;
          p.gravity = 22;
          p.floor = this.floorWorld;
          p.setScale(0.04 + rnd() * 0.04);
          p.randomOrientation();
          p.randomSpin(6 + rnd() * 10);
          p.life = 0.8 + rnd() * 0.4;
          p.scaleFade = true;
          p.setRGB(2.2, 0.75, 0.15);
          p.setRamp(0.05, 0.05, 0.06);
        }
        break;
      }
      case 'voxel': {
        if (t < 0.03 || !this.once(1)) break;
        const n = this.n(70);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          const i = k % SAMPLE_N;
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          let dx = _w.x - cw.x, dy = _w.y - cw.y, dz = _w.z - cw.z;
          const dl = Math.hypot(dx, dy, dz) || 1;
          dx /= dl; dy /= dl; dz /= dl;
          const sp = 1.2 + rnd() * 2.2;
          p.vx = dx * sp + (rnd() - 0.5) * 0.8;
          p.vy = dy * sp * 0.5 + 1.5 + rnd() * 2.2;
          p.vz = dz * sp + (rnd() - 0.5) * 0.8;
          p.gravity = 15;
          p.drag = 0.4;
          p.floor = this.floorWorld;
          p.setScale(0.065 + rnd() * 0.03);
          p.qx = 0; p.qy = 0; p.qz = 0; p.qw = 1; // start grid-aligned — a voxel body
          p.randomSpin(3 + rnd() * 8);
          p.life = 0.85 + rnd() * 0.4;
          p.scaleFade = true;
          const kind = smp.kind[i];
          const v = 0.8 + rnd() * 0.4;
          if (kind === SAMPLE_ARMOR) p.setRGB(E.r * v, E.g * v, E.b * v);
          else if (kind === SAMPLE_GLOW) p.setRGB(E.r * 2.5, E.g * 2.5, E.b * 2.5);
          else p.setRGB(0.05 * v, 0.055 * v, 0.07 * v);
        }
        // Pixel sparks.
        const s = this.n(14);
        for (let k = 0; k < s; k++) {
          const p = this.alloc('box');
          if (!p) break;
          p.x = cw.x; p.y = cw.y; p.z = cw.z;
          const a = rnd() * TAU, sp = 2.5 + rnd() * 3;
          p.vx = Math.cos(a) * sp; p.vy = 1 + rnd() * 3; p.vz = Math.sin(a) * sp;
          p.gravity = 8;
          p.setScale(0.035);
          p.life = 0.35 + rnd() * 0.2;
          p.setRGB(E.r * 2.4 + 0.4, E.g * 2.4 + 0.4, E.b * 2.4 + 0.4);
        }
        break;
      }
      case 'ember': {
        // Embers rise off the burning front, then off the crumbling pieces.
        const rate = t < this.mo.hold ? 90 : 60 * Math.exp(-(t - this.mo.hold) * 2.2);
        this.emitAcc += dt * rate * this.q;
        const line = -0.12 + Math.min(1, t / this.mo.hold) * 2.05;
        let guard = 0;
        while (this.emitAcc >= 1 && guard++ < 12) {
          this.emitAcc -= 1;
          const p = this.alloc('mote');
          if (!p) break;
          let i = Math.floor(rnd() * SAMPLE_N);
          if (t < this.mo.hold) {
            // Pick a sample near the char front.
            for (let tries = 0; tries < 6 && Math.abs(smp.pos[i * 3 + 1] - line) > 0.25; tries++) i = Math.floor(rnd() * SAMPLE_N);
          }
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          p.vx = (rnd() - 0.5) * 0.8; p.vz = (rnd() - 0.5) * 0.8;
          p.vy = 1.0 + rnd() * 1.6;
          p.gravity = -1.2;
          p.drag = 1.2;
          const big = rnd() < 0.25;
          p.setScale(big ? 0.13 : 0.05);
          p.life = big ? 0.35 : 0.6 + rnd() * 0.5;
          p.fadePow = 1.2;
          if (big) p.setRGB(1.3, 0.42, 0.06);
          else p.setRGB(2.6, 1.2, 0.3);
          p.setRamp(big ? 0.4 : 1.2, big ? 0.06 : 0.25, 0.02);
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
            // Straight-line infall that arrives at the pop (with a sideways swirl).
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
          const n = this.n(20);
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            p.x = pw.x; p.y = pw.y; p.z = pw.z;
            const uu = rnd() * 2 - 1, a = rnd() * TAU, sq = Math.sqrt(1 - uu * uu), sp = 6 + rnd() * 6;
            p.vx = Math.cos(a) * sq * sp; p.vy = uu * sp + 1; p.vz = Math.sin(a) * sq * sp;
            p.gravity = 8;
            p.align = true;
            p.setScale(0.022, 0.022, 0.3);
            p.life = 0.28 + rnd() * 0.2;
            p.fadePow = 1.3;
            if (k % 3 === 0) p.setRGB(1.2, 0.9, 3.0);
            else p.setRGB(2.8, 2.8, 3.0);
          }
          if (!this.calm) this.fx!.lights.pulse(1, pw.x, pw.y, pw.z, 0xd8d0ff, 10, 0.12, 7);
        }
        break;
      }
      case 'shatter': {
        if (t < this.mo.hold || !this.once(1)) break;
        const ice = _c.copy(E).lerp(WHITE, 0.6);
        const n = this.n(46);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('shard');
          if (!p) break;
          const i = (k * 5) % SAMPLE_N;
          this.sampleW(i, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          let dx = _w.x - cw.x, dz = _w.z - cw.z;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          const sp = 2 + rnd() * 3.5;
          p.vx = dx * sp + (rnd() - 0.5) * 1.5;
          p.vy = 1 + rnd() * 3;
          p.vz = dz * sp + (rnd() - 0.5) * 1.5;
          p.gravity = 16;
          p.floor = this.floorWorld;
          const sz = 0.06 + rnd() * 0.07;
          p.setScale(sz, sz * (0.8 + rnd() * 0.6), sz);
          p.randomOrientation();
          p.randomSpin(6 + rnd() * 12);
          p.life = 0.55 + rnd() * 0.4;
          p.fadePow = 1.4;
          const v = 1.1 + rnd() * 0.6;
          p.setRGB(ice.r * v, ice.g * v, ice.b * v);
        }
        const g = this.n(10);
        for (let k = 0; k < g; k++) {
          const p = this.alloc('glint');
          if (!p) break;
          this.sampleW((k * 23 + 3) % SAMPLE_N, _w);
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          const a = rnd() * TAU, sp = 1.5 + rnd() * 2.5;
          p.vx = Math.cos(a) * sp; p.vy = 1 + rnd() * 2; p.vz = Math.sin(a) * sp;
          p.gravity = 10;
          p.delay = rnd() * 0.3;
          p.setScale(0.3 + rnd() * 0.15);
          p.rot = rnd() * TAU;
          p.life = 0.12;
          p.fadePow = 1.5;
          p.setRGB(2.8, 2.9, 3.0);
        }
        break;
      }
      case 'confetti': {
        if (!this.once(1)) break;
        const n = this.n(96);
        for (let k = 0; k < n; k++) {
          const p = this.alloc('flake');
          if (!p) break;
          this.sampleW((k * 3) % SAMPLE_N, _w);
          // Burst from the torso, not the feet.
          p.x = cw.x + (_w.x - cw.x) * 0.35;
          p.y = cw.y + (_w.y - cw.y) * 0.35;
          p.z = cw.z + (_w.z - cw.z) * 0.35;
          const a = rnd() * TAU, rad = 1 + rnd() * 2.6;
          p.vx = Math.cos(a) * rad; p.vz = Math.sin(a) * rad;
          p.vy = 4.5 + rnd() * 4;
          p.drag = 2.4;
          p.gravity = 9;
          p.floor = this.floorWorld;
          p.setScale(0.045 + rnd() * 0.015, 0.03 + rnd() * 0.012, 1);
          p.randomOrientation();
          p.randomSpin(8 + rnd() * 14);
          p.life = 1.1 + rnd() * 0.35;
          p.scaleFade = true;
          const c = k % 8 === 0 ? null : CONFETTI[Math.floor(rnd() * CONFETTI.length)];
          if (c) p.setRGB(c[0], c[1], c[2]);
          else p.setRGB(Math.min(1, E.r * 1.3), Math.min(1, E.g * 1.3), Math.min(1, E.b * 1.3));
        }
        // Streamers: long thin ribbons of paper that stream along their flight.
        const st = this.n(12);
        for (let k = 0; k < st; k++) {
          const p = this.alloc('cube');
          if (!p) break;
          p.x = cw.x; p.y = cw.y + 0.1; p.z = cw.z;
          const a = rnd() * TAU, rad = 0.8 + rnd() * 2;
          p.vx = Math.cos(a) * rad; p.vz = Math.sin(a) * rad;
          p.vy = 5.5 + rnd() * 3.5;
          p.drag = 1.8;
          p.gravity = 9;
          p.align = true;
          p.setScale(0.014, 0.004, 0.26 + rnd() * 0.12);
          p.life = 0.9 + rnd() * 0.3;
          p.scaleFade = true;
          const c = CONFETTI[k % CONFETTI.length];
          p.setRGB(c[0], c[1], c[2]);
        }
        break;
      }
      case 'derez': {
        // Digital debris where each band blinks out.
        const bh = 1.9 / DEREZ_BANDS;
        const bo = this.ch.uniforms.uBandO.value;
        const prog = this.ch.uniforms.uBands.value.y;
        const dir = this.ch.uniforms.uBandDir.value;
        for (let b = 0; b < DEREZ_BANDS; b++) {
          if (this.bandDone[b] || t < this.bandT[b]) continue;
          this.bandDone[b] = 1;
          if (rnd() > this.q + 0.15) continue;
          const n = this.calm ? 1 : 3;
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            const off = bo[b] * prog;
            _w.set(this.flashAt.x + dir.x * off, (b + 0.5) * bh, this.flashAt.z + dir.z * off).applyMatrix4(this.parentM);
            p.x = _w.x + (rnd() - 0.5) * 0.35; p.y = _w.y; p.z = _w.z + (rnd() - 0.5) * 0.35;
            p.vx = (rnd() - 0.5) * 0.4; p.vy = 0.4 + rnd() * 0.6; p.vz = (rnd() - 0.5) * 0.4;
            p.drag = 1.5;
            p.setScale(0.028 + rnd() * 0.02);
            p.life = 0.3 + rnd() * 0.2;
            p.fadePow = 1.2;
            p.setRGB(E.r * 2.4 + 0.3, E.g * 2.4 + 0.3, E.b * 2.4 + 0.3);
          }
        }
        break;
      }
      case 'vaporize': {
        // Ash flakes + embers leave exactly as the dissolve front passes.
        const d = this.ch.uniforms.uDissolve.value;
        if (d <= 0) break;
        const n = Math.min(SAMPLE_N, Math.round(150 * this.q));
        const w = this.wind;
        for (let i = 0; i < n; i++) {
          if (this.spawned[i] || this.keys[i] >= d) continue;
          this.spawned[i] = 1;
          this.sampleW(i, _w);
          const ember = i % 4 === 0;
          const p = this.alloc(ember ? 'mote' : 'flake');
          if (!p) continue;
          p.x = _w.x; p.y = _w.y; p.z = _w.z;
          const gust = 0.6 + rnd() * 0.9;
          p.vx = w.x * gust + (rnd() - 0.5) * 0.4;
          p.vy = 0.3 + rnd() * 0.7;
          p.vz = w.z * gust + (rnd() - 0.5) * 0.4;
          p.drag = 1.1;
          p.gravity = -0.35;
          p.life = 0.6 + rnd() * 0.45;
          if (ember) {
            p.setScale(0.05);
            p.fadePow = 1.2;
            p.setRGB(2.4, 0.8, 0.15);
            p.setRamp(0.6, 0.08, 0.0);
          } else {
            const sz = 0.03 + rnd() * 0.025;
            p.setScale(sz, sz * (0.6 + rnd() * 0.5), 1);
            p.randomOrientation();
            p.randomSpin(3 + rnd() * 7);
            p.scaleFade = true;
            const hot = rnd() < 0.35;
            if (hot) p.setRGB(2.2, 0.7, 0.14);
            else p.setRGB(0.09, 0.085, 0.08);
            p.setRamp(0.045, 0.042, 0.04);
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
            this.arcT += 0.028;
            const a = Math.floor(rnd() * SAMPLE_N);
            const b = Math.floor(rnd() * SAMPLE_N);
            this.sampleW(a, _w);
            this.sampleW(b, _v2);
            // Keep arcs short (crawling, not spanning the whole body).
            _v2.sub(_w);
            const l = _v2.length();
            if (l > 0.55) _v2.multiplyScalar(0.55 / l);
            _v2.add(_w);
            arcs.spawn(_w.x, _w.y, _w.z, _v2.x, _v2.y, _v2.z, 1.4, 1.9, 3.0, 0.014, 0.07, 0.05);
          }
        } else if (this.once(1)) {
          const n = this.n(26);
          for (let k = 0; k < n; k++) {
            const p = this.alloc('box');
            if (!p) break;
            p.x = cw.x; p.y = cw.y; p.z = cw.z;
            const uu = rnd() * 2 - 0.8, a = rnd() * TAU, sq = Math.sqrt(Math.max(0, 1 - uu * uu)), sp = 6 + rnd() * 7;
            p.vx = Math.cos(a) * sq * sp; p.vy = uu * sp + 1.5; p.vz = Math.sin(a) * sq * sp;
            p.gravity = 12;
            p.align = true;
            p.setScale(0.02, 0.02, 0.28 + rnd() * 0.2);
            p.life = 0.3 + rnd() * 0.22;
            p.fadePow = 1.3;
            p.setRGB(k % 3 === 0 ? 1.2 : 2.4, k % 3 === 0 ? 1.8 : 2.7, 3.4);
          }
          if (!this.calm) this.fx!.lights.pulse(1, cw.x, cw.y, cw.z, 0x9fd0ff, 10, 0.12, 7);
        }
        break;
      }
    }
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
      p.vx = dx * sp; p.vy = dy * sp * 0.5 + 1.5 + rnd() * 2.5; p.vz = dz * sp;
      p.gravity = 14;
      p.floor = this.floorWorld;
      const sz = 0.06 + rnd() * 0.06;
      p.setScale(sz, sz * 1.3, sz);
      p.randomOrientation();
      p.randomSpin(6 + rnd() * 12);
      p.life = 0.6 + rnd() * 0.4;
      p.fadePow = 1.3;
      _c.setHSL(k / n, 1, 0.55);
      p.setRGB(_c.r * 2.4, _c.g * 2.4, _c.b * 2.4);
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
