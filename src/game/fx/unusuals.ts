import * as THREE from 'three';
import type { UnusualKind } from '../cosmetics';
import { UNUSUAL_EFFECTS } from '../items/types';
import { fxFlags } from './fx-settings';
import { lightningPath, RibbonBatch } from './ribbon';
import { CELL, unusualAtlas } from './unusual-atlas';
import { Field, GOLDEN, TAU, hash, hsv, mix, now, rnd, smooth, tmpVp, views, type SharedUniforms } from './unusual-core';

// ── Unusual effects (TF2-style particle crowns) ──────────────────────────────
//
// Each wearer owns ONE additive point cloud (plus, for storm, a normal-blended
// cloud body, and for halo / plasma / storm a ribbon batch for bands and
// arcs). Everything is simulated on the CPU in WORLD space: particles that
// are "attached" (rings, spirals, discs) are placed each frame through the
// hat anchor's world matrix; particles that are "free" (flames, embers,
// hearts, rain) are emitted at the anchor and then integrate on their own
// with world-up buoyancy, so they rise straight up and trail a moving head.
//
// Rendering rules that keep them fair and bloom-safe:
//  • Point size is FOV-correct (projectionMatrix[1][1] in the attenuation),
//    so the Locker's FOV 30 close-up, the in-game FOV 90 and the scope zoom
//    all show the same physical size.
//  • A per-render gain and per-particle HDR cap fall with projected size:
//    close up the cores go past the bloom threshold and glow; at 30 m the
//    whole crown stays below it, so a far head never turns into a blob.
//  • Points never shrink below ~1.5 px; below that their alpha scales down
//    instead (a faint sparkle at range, not aliasing flicker).
//  • LOD: fewer particles as the projected size falls; no simulation at all
//    while the effect isn't being rendered (culled, hidden, gibbed).
//  • reducedEffects → calmer motion, fewer particles, no flashes/strobing;
//    lowSpec → fewer particles.

// ── Recipes ─────────────────────────────────────────────────────────────────

type P = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  seed: number;
  rank: number; // LOD: visible while rank < the current fraction
  on: boolean;
  k: number; // role within the recipe
  a: number; b: number; // recipe scratch
};

// Every kind the engine renders: the v2 kinds (cosmetics.ts UnusualKind) plus
// the v3 additions (items/types.ts UNUSUAL_EFFECTS).
export type EffectKind =
  | Exclude<UnusualKind, 'none'>
  | 'sunbeams' | 'bubbles' | 'frostbite' | 'voidrift' | 'fireflies' | 'cosmic' | 'lightning' | 'sakura';

type Layout = { count: number; roles: [role: number, n: number][]; cloud?: number; ribbons?: [strips: number, points: number] };

// Particle budgets per kind (role → count). Roles index the recipe's parts.
const LAYOUTS: Record<EffectKind, Layout> = {
  embers: { count: 0, roles: [[0, 2], [1, 24], [2, 6], [3, 22]] }, // heat glow, fire blobs, tongues, sparks
  aura: { count: 0, roles: [[0, 10], [1, 8], [2, 5]], ribbons: [2, 61] }, // band glow, rising motes, tip stars; band + crown ribbons
  orbit: { count: 0, roles: [[0, 6], [1, 24], [2, 3], [3, 6]], ribbons: [8, 33] }, // comet heads, ring motes, core, head glows; comet tails + 2 guide rings
  halo: { count: 0, roles: [[0, 24], [1, 4], [2, 12]], ribbons: [1, 49] }, // band glow, glints, dust
  storm: { count: 0, roles: [[0, 18], [1, 3]], cloud: 13, ribbons: [2, 9] }, // rain, inner glow
  plasma: { count: 0, roles: [[0, 3], [1, 4], [2, 24]], ribbons: [10, 49] }, // core, arc ends, sparks; 4 arcs + 4 forks + 2 shells
  prism: { count: 0, roles: [[0, 16], [1, 8], [2, 2]], ribbons: [2, 28] }, // beads, glints, apex; helix ribbons
  galaxy: { count: 0, roles: [[0, 3], [1, 48], [2, 10]] }, // core, arm stars, dust
  ghostfire: { count: 0, roles: [[0, 2], [1, 10]], ribbons: [5, 16] }, // cold core, soul lights; curling tendrils
  hearts: { count: 0, roles: [[0, 8], [1, 28], [2, 6]] }, // hearts, pop sparkles, motes
  binary: { count: 0, roles: [[0, 42], [1, 6], [2, 20]], ribbons: [2, 33] }, // outer glyphs (6 × 7), crown motes, inner glyphs (4 × 5); scan line + rim ring
  sunbeams: { count: 0, roles: [[0, 3], [1, 14], [2, 4]], ribbons: [10, 6] }, // sun core, dust, ray-tip glints; rays
  bubbles: { count: 0, roles: [[0, 12], [1, 24], [2, 3]] }, // bubbles, pop droplets, foam glow
  frostbite: { count: 0, roles: [[0, 6], [1, 20], [2, 5], [3, 4]], ribbons: [2, 49] }, // shards, snow, mist, glints; crystal crown + band
  voidrift: { count: 0, roles: [[0, 26], [1, 8]], cloud: 4, ribbons: [4, 33] }, // inflow motes, rim glows; dark core; ring, halo, 2 tendrils
  fireflies: { count: 0, roles: [[0, 9], [1, 9], [2, 8]] }, // flies, glows, pollen
  cosmic: { count: 0, roles: [[0, 8], [1, 6], [2, 12], [3, 1]], ribbons: [2, 12] }, // stars, apex + nebula, dust, shooting star; constellation + trail
  lightning: { count: 0, roles: [[0, 3], [1, 4], [2, 14]], ribbons: [8, 9] }, // core, bolt tips, sparks; 4 bolts + 4 forks
  sakura: { count: 0, roles: [[0, 22], [1, 3], [2, 3]] }, // petals, haze, glints
};
for (const l of Object.values(LAYOUTS)) l.count = l.roles.reduce((s, [, n]) => s + n, 0);

type FirePalette = { c: readonly number[]; scale: number; tongue: number; waveK: number };
// hot (rgb), mid, cool — linear HDR.
const FIRE_EMBERS: FirePalette = { c: [2.1, 1.55, 0.6, 1.7, 0.55, 0.07, 0.5, 0.06, 0.0], scale: 1, tongue: 1, waveK: 6 };

// Fairness: kinds that sit right at the head are dimmed, and every crown fades
// to nothing with distance (near, far metres) so no wearer is a beacon; the
// bright "beacon" kinds fade earlier.
const KIND_GAIN: Partial<Record<EffectKind, number>> = { storm: 0.7, voidrift: 0.65, bubbles: 0.7, aura: 0.65, sunbeams: 0.75, cosmic: 0.75, halo: 0.9 };
const FAR_FADE: Partial<Record<EffectKind, readonly [number, number]>> = { sunbeams: [10, 24], aura: [10, 24], cosmic: [10, 24], voidrift: [14, 28], storm: [14, 28] };
// Extra lift (m) above the crown so the effect never sits on the face.
const KIND_LIFT: Partial<Record<EffectKind, number>> = { storm: 0.03, voidrift: 0.04, bubbles: 0.02, aura: 0.05 };

// How much each kind's particles dim what's behind them (0 = pure additive).
const OCCLUDE: Record<EffectKind, number> = {
  embers: 0.5, aura: 0.3, orbit: 0.4, halo: 0.2, storm: 0.25, plasma: 0.2,
  prism: 0.2, galaxy: 0.45, ghostfire: 0.5, hearts: 0.7, binary: 0.45,
  sunbeams: 0.15, bubbles: 0.3, frostbite: 0.35, voidrift: 0.4, fireflies: 0.35, cosmic: 0.3, lightning: 0.2, sakura: 0.6,
};

const HEART_COLS: readonly (readonly [number, number, number])[] = [
  [1.0, 0.26, 0.52],
  [1.0, 0.12, 0.3],
  [1.0, 0.5, 0.8],
];

// Tilted ring / disc frames (local): normal + two in-plane axes.
function frame(nx: number, ny: number, nz: number) {
  const n = new THREE.Vector3(nx, ny, nz).normalize();
  const u = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}
const ORBIT_FRAMES = [frame(0.4, 1, 0.2), frame(-0.36, 1, -0.28), frame(0.15, 1, -0.75)];
const ORBIT_W = [2.5, -2.1, 1.7]; // ring angular speeds (rad/s)
const ORBIT_R = [0.2, 0.16, 0.235]; // ring radii (m)

const IDENT = new THREE.Matrix4().elements;

export class UnusualEffect {
  readonly group = new THREE.Group();
  private readonly kind: EffectKind;
  private readonly f: Field;
  private readonly cloud: Field | null = null;
  private readonly rib: RibbonBatch | null = null;
  private readonly ps: P[] = [];
  private readonly cps: P[] = [];
  private readonly u: SharedUniforms & Record<string, THREE.IUniform>;
  private t = 0; // effect clock (slowed in calm mode)
  private e: ArrayLike<number> = IDENT; // anchor world matrix
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private evx = 0;
  private evy = 0;
  private evz = 0;
  private hasPrev = false;
  private stale = false; // parked while not rendered
  private lastSeen = 0;
  private ppm = 300; // projected px per metre at the last render (closest view)
  private ppmFrame = 0;
  // Ghostfire's cold flicker.
  private ghostNext = 0;
  private ghostFlick = 1;
  // Last viewing camera (galaxy leans toward it).
  private camX = 0;
  private camZ = 5;
  // Last world position written by lw().
  private wx = 0;
  private wy = 0;
  private wz = 0;
  // Storm.
  private boltAge = 9;
  private nextBolt = 0.6;
  private boltJag = 0;
  private boltFork = false;
  private readonly boltA = new Float32Array(9 * 3);
  private readonly boltB = new Float32Array(6 * 3);
  // Plasma: per arc target (local), time to retarget, jag timer, flicker.
  private readonly arcT = new Float32Array(4 * 3);
  private readonly arcTtl = new Float32Array(4);
  private readonly arcJag = new Float32Array(4);
  private readonly arcFlick = new Float32Array(4);
  private readonly arcPath = new Float32Array(4 * 10 * 3);
  private readonly arcBr = new Float32Array(4 * 6 * 3);
  private readonly arcS = new Float32Array(4 * 3);
  // Disc-facing recipes (sunbeams, voidrift): horizontal unit vector to the viewer.
  private fvx = 0;
  private fvz = 1;
  // Generic per-bolt scratch for lightning / voidrift / cosmic: paths, forks, timers.
  private readonly xs = new Float32Array(4 * 27);
  private readonly xf = new Float32Array(4 * 18);
  private readonly xt = new Float32Array(4);
  private readonly xl = new Float32Array(4);
  private readonly xa = new Float32Array(16);
  private readonly xsV = views(this.xs, 27);
  private readonly xfV = views(this.xf, 18);
  private readonly arcPathV = views(this.arcPath, 30);
  private readonly arcBrV = views(this.arcBr, 18);

  constructor(kind: EffectKind) {
    this.kind = kind;
    this.group.name = 'unusual';
    // Origin a touch above the anchor (which WornHat seats over the hat crown).
    this.group.position.y = 0.04 + (KIND_LIFT[kind] ?? 0);
    this.u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as SharedUniforms & Record<string, THREE.IUniform>;
    this.u.uAtlas = { value: unusualAtlas() };
    this.u.uViewH = { value: 900 };
    this.u.uMinPx = { value: 1.5 };
    this.u.uGain = { value: 1 };
    this.u.uHdrCap = { value: 2.4 };
    this.u.uMinLum = { value: 0 };
    this.u.uOcclude = { value: OCCLUDE[kind] };
    const layout = LAYOUTS[kind];
    this.f = new Field(layout.count, this.u, true);
    let i = 0;
    for (const [role, n] of layout.roles) {
      for (let j = 0; j < n; j++, i++) {
        this.ps.push({
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: -1, life: 1, seed: rnd(),
          rank: (i * GOLDEN) % 1, on: false, k: role, a: j, b: 0,
        });
      }
    }
    this.assignRanks();
    if (layout.cloud) {
      // Same shared uniforms, but the cloud body fully occludes.
      this.cloud = new Field(layout.cloud, { ...this.u, uOcclude: { value: 1 } }, false);
      for (let j = 0; j < layout.cloud; j++) {
        this.cps.push({
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, seed: hash(j + 3.1),
          rank: (j * GOLDEN) % 1, on: true, k: 0, a: j, b: 0,
        });
      }
      this.group.add(this.cloud.points);
    }
    this.group.add(this.f.points);
    if (layout.ribbons) {
      this.rib = new RibbonBatch(layout.ribbons[0], layout.ribbons[1], 1.6);
      this.rib.mesh.matrixAutoUpdate = false;
      this.rib.mesh.matrixWorldAutoUpdate = false;
      this.group.add(this.rib.mesh);
    }
    this.lastSeen = now();
    // Per-render: viewport-correct point sizes and the distance gain/cap.
    const onRender = (renderer: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera, mat: THREE.ShaderMaterial) => {
      renderer.getCurrentViewport(tmpVp);
      const vh = Math.max(1, tmpVp.w);
      const ce = camera.matrixWorld.elements;
      const d = Math.max(0.1, Math.hypot(ce[12] - this.ox, ce[13] - this.oy, ce[14] - this.oz));
      const p11 = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
      this.camX = ce[12];
      this.camZ = ce[14];
      const ppm = (p11 * vh * 0.5) / d;
      this.u.uViewH.value = vh;
      const ff = FAR_FADE[this.kind] ?? [20, 32];
      const far = 1 - smooth(ff[0], ff[1], d);
      this.u.uGain.value = (0.5 + 0.5 * smooth(8, 60, ppm)) * (KIND_GAIN[this.kind] ?? 1) * far;
      this.u.uHdrCap.value = 1.0 + 1.4 * smooth(10, 80, ppm);
      this.u.uMinLum.value = 0.85 * (1 - smooth(25, 90, ppm)) * far;
      mat.uniformsNeedUpdate = true;
      this.lastSeen = now();
      // Keep the closest view's size for the LOD decision.
      if (this.ppmFrame !== frameTick) {
        this.ppmFrame = frameTick;
        this.ppm = ppm;
      } else if (ppm > this.ppm) this.ppm = ppm;
    };
    this.f.points.onBeforeRender = (r, s, c) => onRender(r, s, c, this.f.mat);
    if (this.cloud) {
      const cm = this.cloud.mat;
      this.cloud.points.onBeforeRender = (r, s, c) => onRender(r, s, c, cm);
    }
    this.group.traverse((o) => {
      o.userData.shared = true;
    });
  }

  // Structured recipes thin whole groups (a comet and its tail, a glyph
  // column), never single points inside one.
  private assignRanks() {
    const ps = this.ps;
    if (this.kind === 'orbit') {
      for (const p of ps) {
        if (p.k === 0 || p.k === 3) p.rank = ((Math.floor(p.a / 2) + 0.5) * GOLDEN) % 1;
        else if (p.k === 2) p.rank = 0;
      }
    } else if (this.kind === 'binary') {
      for (const p of ps) {
        if (p.k === 0) p.rank = ((Math.floor(p.a / 7) + 0.3) * GOLDEN) % 1;
        else if (p.k === 2) p.rank = ((Math.floor(p.a / 5) + 0.6) * GOLDEN) % 1;
      }
    } else if (this.kind === 'prism') {
      for (const p of ps) if (p.k === 0) p.rank = ((p.a % 22) * GOLDEN + 0.1) % 1;
    }
    if (this.kind === 'aura') {
      for (const p of ps) if (p.k === 2) p.rank = 0; // the five tip stars always show
    }
    // Cores / apexes are always on.
    for (const p of ps) {
      if (
        (this.kind === 'galaxy' && p.k === 0) ||
        (this.kind === 'plasma' && p.k <= 1) ||
        (this.kind === 'prism' && p.k === 2) ||
        (this.kind === 'sunbeams' && p.k === 0) ||
        (this.kind === 'voidrift' && p.k === 1) ||
        (this.kind === 'lightning' && (p.k === 0 || p.k === 1)) ||
        (this.kind === 'cosmic' && (p.k === 0 || p.k === 1 || p.k === 3)) ||
        (this.kind === 'frostbite' && p.k === 0) ||
        (this.kind === 'fireflies' && p.k <= 1)
      ) p.rank = 0;
    }
  }

  update(dt: number): void {
    dt = Math.max(0, Math.min(dt, 0.1));
    frameTick++;
    const calm = fxFlags.reduced;
    this.t += dt * (calm ? 0.6 : 1);
    // Anchor frame (bones were just posed; refresh the chain).
    this.group.updateWorldMatrix(true, false);
    const e = this.group.matrixWorld.elements;
    this.e = e;
    const nx = e[12], ny = e[13], nz = e[14];
    let teleport = false;
    if (this.hasPrev && dt > 0) {
      const dx = nx - this.ox, dy = ny - this.oy, dz = nz - this.oz;
      if (dx * dx + dy * dy + dz * dz > 2.5 * 2.5) teleport = true;
      else {
        const k = 1 - Math.exp(-12 * dt);
        this.evx += (dx / dt - this.evx) * k;
        this.evy += (dy / dt - this.evy) * k;
        this.evz += (dz / dt - this.evz) * k;
      }
    }
    this.ox = nx; this.oy = ny; this.oz = nz;
    if (!this.hasPrev || teleport) {
      this.evx = this.evy = this.evz = 0;
      for (const p of this.ps) p.on = false; // respawn around the new spot
    }
    this.hasPrev = true;
    this.f.setBounds(nx, ny + 0.15, nz, 1.2);
    this.cloud?.setBounds(nx, ny + 0.15, nz, 1.2);
    // Not rendered lately (culled, hidden, gibbed) → no simulation at all.
    // Park everything, so nothing stale (free particles left metres behind,
    // half-aged) can flash when it comes back; resuming re-emits like a
    // teleport.
    if (now() - this.lastSeen > 250) {
      if (!this.stale) {
        this.stale = true;
        this.f.hideAll();
        this.f.commit();
        if (this.cloud) {
          this.cloud.hideAll();
          this.cloud.commit();
        }
        if (this.rib) this.rib.mesh.visible = false;
      }
      return;
    }
    if (this.stale) {
      this.stale = false;
      for (const p of this.ps) p.on = false;
    }
    // LOD: particle fraction from projected size, trimmed by the quality tier.
    const ppm = this.ppm;
    let frac = ppm >= 70 ? 1 : ppm >= 30 ? mix(0.6, 1, (ppm - 30) / 40) : ppm >= 12 ? mix(0.4, 0.6, (ppm - 12) / 18) : 0.25;
    if (fxFlags.low) frac *= 0.55;
    if (calm) frac *= 0.7;
    frac = Math.max(0.2, frac);
    if (this.rib) this.rib.begin();
    switch (this.kind) {
      case 'embers': this.embers(dt, frac); break;
      case 'aura': this.aura(dt, frac); break;
      case 'orbit': this.orbit(frac, calm); break;
      case 'halo': this.halo(dt, frac); break;
      case 'storm': this.storm(dt, frac, calm); break;
      case 'plasma': this.plasma(dt, frac, calm); break;
      case 'prism': this.prism(frac); break;
      case 'galaxy': this.galaxy(frac); break;
      case 'ghostfire': this.ghostfire(dt, frac); break;
      case 'hearts': this.hearts(dt, frac, calm); break;
      case 'binary': this.binary(frac, calm); break;
      case 'sunbeams': this.sunbeams(dt, frac); break;
      case 'bubbles': this.bubbles(dt, frac, calm); break;
      case 'frostbite': this.frostbite(dt, frac); break;
      case 'voidrift': this.voidrift(dt, frac, calm); break;
      case 'fireflies': this.fireflies(dt, frac); break;
      case 'cosmic': this.cosmic(dt, frac, calm); break;
      case 'lightning': this.lightning(dt, frac, calm); break;
      case 'sakura': this.sakura(dt, frac); break;
    }
    this.f.commit();
    this.cloud?.commit();
    this.rib?.commit();
  }

  // ── helpers ──

  // Local (anchor frame) → world, into wx/wy/wz.
  private lw(x: number, y: number, z: number) {
    const e = this.e;
    this.wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.wz = e[2] * x + e[6] * y + e[10] * z + e[14];
  }

  // LOD gate: false → hidden this frame. A particle switching back on is
  // flagged (age < 0) so its recipe respawns it mid-life.
  private gate(p: P, i: number, frac: number): boolean {
    if (p.rank >= frac) {
      p.on = false;
      this.f.hide(i);
      return false;
    }
    if (!p.on) {
      p.on = true;
      p.age = -1;
    }
    return true;
  }

  // Emit a free particle from the crown: a horizontal disc around the anchor
  // (world up), inheriting part of the wearer's motion.
  private emit(p: P, radius: number, y0: number, vy: number, vyR: number, life: number, lifeR: number, inherit: number, stagger: boolean) {
    const a = rnd() * TAU;
    const r = Math.sqrt(rnd()) * radius;
    this.lw(0, y0, 0);
    p.x = this.wx + Math.cos(a) * r;
    p.y = this.wy;
    p.z = this.wz + Math.sin(a) * r;
    p.vx = Math.cos(a) * 0.03 + this.evx * inherit;
    p.vy = vy + rnd() * vyR + this.evy * inherit * 0.5;
    p.vz = Math.sin(a) * 0.03 + this.evz * inherit;
    p.life = life + rnd() * lifeR;
    p.seed = rnd();
    p.b = a;
    if (stagger) {
      p.age = rnd() * p.life;
      p.x += p.vx * p.age;
      p.y += p.vy * p.age;
      p.z += p.vz * p.age;
    } else p.age = 0;
  }

  // ── Searing Embers: a hot bed of overlapping fire blobs with licking
  // tongues, a heat glow at the root and ember sparks that ride the heat up
  // and drift, trailing a moving head. ──
  private embers(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        this.lw(0, -0.02 + p.a * 0.035, 0);
        const fl = 0.85 + 0.15 * Math.sin(t * 17 + p.a * 3);
        f.put(i, this.wx, this.wy, this.wz, 0.75 * fl, 0.26 * fl, 0.04 * fl, 1, 0.2 - p.a * 0.07, CELL.glow, 0);
      } else if (p.k === 1 || p.k === 2) {
        this.fire(p, i, dt, FIRE_EMBERS, p.k === 2, 0.6, 0.07, 0.22);
      } else {
        if (p.age < 0) this.emit(p, 0.09, -0.02, 0.42, 0.36, 0.7, 0.6, 0.5, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.09, -0.02, 0.42, 0.36, 0.7, 0.6, 0.5, false);
        const drag = Math.exp(-1.4 * dt);
        p.vx = p.vx * drag + Math.sin(t * 4.3 + p.seed * 40) * 0.9 * dt;
        p.vz = p.vz * drag + Math.cos(t * 3.7 + p.seed * 33) * 0.9 * dt;
        p.vy += 0.08 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        const tw = 0.6 + 0.4 * Math.sin(t * 31 + p.seed * 70);
        const al = Math.min(1, fr * 10) * (1 - fr) * tw;
        f.put(i, p.x, p.y, p.z, mix(2.3, 1.3, fr), mix(1.6, 0.4, fr), mix(0.7, 0.05, fr), al, 0.026, CELL.dot, 0);
      }
    }
  }

  // One fire particle: a soft blob (or, `tongue`, a licking flame sprite)
  // born at the crown, rising on buoyancy with height-scaled turbulence and
  // cooling through the palette's hot → mid → cool ramp.
  private fire(p: P, i: number, dt: number, pal: FirePalette, tongue: boolean, inherit: number, radius: number, sway: number) {
    const t = this.t;
    const vy = tongue ? 0.36 : 0.3;
    const life = tongue ? 0.26 * pal.tongue : 0.32;
    const rad = radius * (tongue ? 0.7 : 1);
    if (p.age < 0) this.emit(p, rad, -0.035, vy, 0.16, life, 0.2, inherit, true);
    p.age += dt;
    if (p.age >= p.life) this.emit(p, rad, -0.035, vy, 0.16, life, 0.2, inherit, false);
    const h = Math.max(0, p.y - this.oy + 0.05);
    p.vy += 0.35 * dt;
    const wave = Math.sin(t * 7 + p.seed * 31 + h * pal.waveK);
    p.x += (p.vx + wave * sway * h * 4) * dt;
    p.z += (p.vz + Math.cos(t * 6 + p.seed * 27 + h * pal.waveK) * sway * h * 4) * dt;
    p.y += p.vy * dt;
    const fr = p.age / p.life;
    const c = pal.c;
    let r, g, b;
    if (fr < 0.4) { const k = fr / 0.4; r = mix(c[0], c[3], k); g = mix(c[1], c[4], k); b = mix(c[2], c[5], k); }
    else { const k = (fr - 0.4) / 0.6; r = mix(c[3], c[6], k); g = mix(c[4], c[7], k); b = mix(c[5], c[8], k); }
    const flick = 0.85 + 0.15 * Math.sin(t * 29 + p.seed * 50);
    const al = Math.min(1, fr * 6) * Math.pow(1 - fr, 1.3) * flick * (tongue ? 0.9 : 0.72);
    if (tongue) this.f.put(i, p.x, p.y, p.z, r, g, b, al, mix(0.14, 0.08, fr) * pal.tongue, CELL.flame, wave * 0.18);
    else this.f.put(i, p.x, p.y, p.z, r, g, b, al, mix(0.09, 0.028, fr) * pal.scale, CELL.glow, 0);
  }

  // ── Sovereign Aura: a floating CROWN of light — a gold ribbon band whose
  // top edge rises into five points, slowly turning, a star on each tip and
  // a few motes lifting off it. ──
  private aura(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const R = 0.17;
    const spin = t * 0.45;
    const P = rib.points;
    // Band (strip 0) and the pointed crown outline (strip 1).
    for (let j = 0; j < P; j++) {
      const a = (j / (P - 1)) * TAU + spin;
      this.lw(Math.cos(a) * R, -0.04, Math.sin(a) * R);
      rib.push(0, this.wx, this.wy, this.wz, 1.5, 1.1, 0.4, 0.014);
      // Triangle wave: 5 points, peaks 0.12 m above the band.
      const ph = ((j / (P - 1)) * 5) % 1;
      const tri = 1 - Math.abs(ph * 2 - 1);
      const h = -0.04 + 0.02 + tri * 0.12;
      const r = R * (1 - 0.1 * tri);
      this.lw(Math.cos(a) * r, h, Math.sin(a) * r);
      const k = 1.3 + 0.9 * tri;
      rib.push(1, this.wx, this.wy, this.wz, 1.2 * k, 0.9 * k, 0.32 * k, 0.012);
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        // Soft gold glow under the band.
        const a = (p.a / 10) * TAU + spin;
        this.lw(Math.cos(a) * R, -0.02, Math.sin(a) * R);
        f.put(i, this.wx, this.wy, this.wz, 0.34, 0.24, 0.07, 0.9, 0.1, CELL.glow, 0);
      } else if (p.k === 2) {
        // A star on each of the five tips.
        const a = ((p.a + 0.5) / 5) * TAU + spin;
        const r = R * 0.9;
        this.lw(Math.cos(a) * r, 0.1, Math.sin(a) * r);
        const fl = 0.55 + 0.45 * Math.pow(Math.max(0, Math.sin(t * 2.6 + p.a * 1.9)), 6);
        f.put(i, this.wx, this.wy, this.wz, 2.4, 2.1, 1.4, fl, 0.075 * fl, CELL.star, t * 1.2 + p.a);
      } else {
        if (p.age < 0) this.emitRing(p, R, 0.02, 0.1, 0.18, 0.08, 0.9, 0.4, 0.7, true);
        p.age += dt;
        if (p.age >= p.life) this.emitRing(p, R, 0.02, 0.1, 0.18, 0.08, 0.9, 0.4, 0.7, false);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 1.9, 1.6, 0.9, Math.min(1, fr * 6) * (1 - fr), mix(0.028, 0.012, fr), CELL.dot, 0);
      }
    }
  }

  // Emit a free particle from a point on a crown ring of radius R (local y
  // `ly`): a tangential swirl `swirl`, rising at `vy` (+ random `vyR`) —
  // negative for falling dust.
  private emitRing(p: P, R: number, ly: number, swirl: number, vy: number, vyR: number, life: number, lifeR: number, inherit: number, stagger: boolean) {
    const a = rnd() * TAU;
    this.lw(Math.cos(a) * R, ly, Math.sin(a) * R);
    p.x = this.wx; p.y = this.wy; p.z = this.wz;
    p.vx = -Math.sin(a) * swirl + this.evx * inherit;
    p.vz = Math.cos(a) * swirl + this.evz * inherit;
    p.vy = vy + rnd() * vyR + this.evy * inherit * 0.5;
    p.life = life + rnd() * lifeR;
    p.seed = rnd();
    p.age = stagger ? rnd() * p.life : 0;
    if (stagger) { p.x += p.vx * p.age; p.y += p.vy * p.age; p.z += p.vz * p.age; }
  }

  // Storm rain: a streak from under the cloud, falling with the cloud.
  private emitRain(p: P, stagger: boolean) {
    this.lw((rnd() - 0.5) * 0.19, 0.11, (rnd() - 0.5) * 0.14);
    p.x = this.wx; p.y = this.wy; p.z = this.wz;
    p.vx = this.evx * 0.9; p.vz = this.evz * 0.9;
    p.vy = -1.3 - rnd() * 0.3 + this.evy * 0.9;
    p.life = 0.16 + rnd() * 0.12;
    p.age = stagger ? rnd() * p.life : 0;
    if (stagger) { p.x += p.vx * p.age; p.y += p.vy * p.age; p.z += p.vz * p.age; }
  }

  // ── Orbiting Energy: three tilted, counter-rotating rings, each carrying two
  // comets with smooth ribbon tails, faint guide rings, a mote belt and a
  // humming energy core at the centre that beats every couple of seconds. ──
  private orbit(frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const w = ORBIT_W;
    const R = ORBIT_R;
    const beat = calm ? 0 : Math.exp(-(t % 2.4) * 6);
    // Guide rings (the first two).
    for (let s = 0; s < 2; s++) {
      const fr = ORBIT_FRAMES[s];
      for (let j = 0; j < rib.points; j++) {
        const a = (j / (rib.points - 1)) * TAU;
        const ca = Math.cos(a) * R[s], sa = Math.sin(a) * R[s];
        this.lw(fr.u.x * ca + fr.v.x * sa, 0.02 + fr.u.y * ca + fr.v.y * sa, fr.u.z * ca + fr.v.z * sa);
        const g = 0.25 + 0.2 * Math.pow(0.5 + 0.5 * Math.sin(a * 2 - t * w[s]), 2);
        rib.push(6 + s, this.wx, this.wy, this.wz, 0.08 * g * 3, 0.4 * g * 3, 1.2 * g * 3, 0.004);
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0 || p.k === 3) {
        const ring = Math.floor(p.a / 2);
        const fr = ORBIT_FRAMES[ring];
        const head = t * w[ring] + (p.a % 2) * Math.PI + ring * 1.3;
        if (p.k === 0) {
          const ca = Math.cos(head) * R[ring], sa = Math.sin(head) * R[ring];
          this.lw(fr.u.x * ca + fr.v.x * sa, 0.02 + fr.u.y * ca + fr.v.y * sa, fr.u.z * ca + fr.v.z * sa);
          const k = 1 + 0.7 * beat;
          f.put(i, this.wx, this.wy, this.wz, 1.7 * k, 2.2 * k, 2.4 * k, 1, 0.058, CELL.dot, 0);
          // Tail: a smooth ribbon trailing back along the ring.
          for (let j = 0; j < 14; j++) {
            const u = j / 13;
            const ang = head - Math.sign(w[ring]) * u * 1.0;
            const c2 = Math.cos(ang) * R[ring], s2 = Math.sin(ang) * R[ring];
            this.lw(fr.u.x * c2 + fr.v.x * s2, 0.02 + fr.u.y * c2 + fr.v.y * s2, fr.u.z * c2 + fr.v.z * s2);
            const g = Math.pow(1 - u, 1.4) * 1.5 * k;
            rib.push(p.a, this.wx, this.wy, this.wz, 0.3 * g, 1.1 * g, 1.9 * g, 0.015 * (1 - u) + 0.002);
          }
        } else {
          const h = p.a;
          const ring2 = Math.floor(h / 2);
          const fr2 = ORBIT_FRAMES[ring2];
          const hd = t * w[ring2] + (h % 2) * Math.PI + ring2 * 1.3;
          const ca = Math.cos(hd) * R[ring2], sa = Math.sin(hd) * R[ring2];
          this.lw(fr2.u.x * ca + fr2.v.x * sa, 0.02 + fr2.u.y * ca + fr2.v.y * sa, fr2.u.z * ca + fr2.v.z * sa);
          f.put(i, this.wx, this.wy, this.wz, 0.15, 0.6, 1.5, 0.9, 0.12, CELL.glow, 0);
        }
      } else if (p.k === 1) {
        const ring = Math.floor(p.a / 8);
        const ang = ((p.a % 8) / 8) * TAU - t * w[ring] * 0.2 + ring;
        const fr = ORBIT_FRAMES[ring];
        const ca = Math.cos(ang) * R[ring], sa = Math.sin(ang) * R[ring];
        this.lw(fr.u.x * ca + fr.v.x * sa, 0.02 + fr.u.y * ca + fr.v.y * sa, fr.u.z * ca + fr.v.z * sa);
        const tw = 0.6 + 0.4 * Math.sin(t * 5 + p.a * 2);
        f.put(i, this.wx, this.wy, this.wz, 0.18, 0.6, 1.3, 0.9 * tw, 0.028, CELL.glow, 0);
      } else {
        this.lw(0, 0.02, 0);
        const pulse = 0.8 + 0.2 * Math.sin(t * 9) + beat * 0.5;
        if (p.a === 0) f.put(i, this.wx, this.wy, this.wz, 0.06 * pulse, 0.28 * pulse, 0.75 * pulse, 1, 0.17, CELL.glow, 0);
        else if (p.a === 1) f.put(i, this.wx, this.wy, this.wz, 1.2 * pulse, 1.9 * pulse, 2.4 * pulse, 1, 0.07, CELL.star, t * 1.1);
        else f.put(i, this.wx, this.wy, this.wz, 0.4, 1.0, 2.0, 0.7, 0.12 + 0.03 * beat, CELL.ring, -t * 0.8);
      }
    }
  }

  // ── Radiant Halo: a crisp, perfectly circular golden ring floating level
  // above the head, leaned ~15° toward whoever is looking — a thin bright
  // core ribbon, a soft glow under it, a travelling crest, the odd glint and
  // a little falling gold dust. ──
  private halo(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    const R = 0.16;
    const rib = this.rib!;
    const P = rib.points;
    // World-level frame (not the head's pitch), leaned toward the viewer.
    this.lw(0, 0, 0);
    const cx = this.wx, cy = this.wy, cz = this.wz;
    let hx = this.camX - cx, hz = this.camZ - cz;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    const lean = 0.27; // tan(15°)
    let nx = hx * lean, ny = 1, nz = hz * lean;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    let ux = -hz, uz = hx; // horizontal, ⊥ the lean
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const vx = ny * uz, vy = nz * ux - nx * uz, vz = -ny * ux;
    for (let j = 0; j < P; j++) {
      const a = (j / (P - 1)) * TAU;
      const ca = Math.cos(a) * R, sa = Math.sin(a) * R;
      const crest = Math.pow(Math.max(0, Math.cos(a - t * 2.0)), 10);
      const k = 1.25 + 1.2 * crest;
      rib.push(0, cx + ux * ca + vx * sa, cy + vy * sa, cz + uz * ca + vz * sa, 1.0 * k, 0.78 * k, 0.34 * k, 0.013);
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        const a = (p.a / 24) * TAU + t * 0.3;
        const ca = Math.cos(a) * R, sa = Math.sin(a) * R;
        f.put(i, cx + ux * ca + vx * sa, cy + vy * sa, cz + uz * ca + vz * sa, 0.3, 0.22, 0.08, 0.9, 0.075, CELL.glow, 0);
      } else if (p.k === 1) {
        const sn = Math.sin(t * 1.7 + p.seed * 20);
        if (sn <= 0) { p.b = -1; f.hide(i); continue; }
        if (p.b < 0) p.b = rnd() * TAU;
        const fl = Math.pow(sn, 14);
        const a = p.b + t * 0.4;
        const ca = Math.cos(a) * R, sa = Math.sin(a) * R;
        f.put(i, cx + ux * ca + vx * sa, cy + vy * sa, cz + uz * ca + vz * sa, 2.4, 2.2, 1.8, fl, 0.1 * (0.3 + 0.7 * fl), CELL.star, t + p.seed * 5);
      } else {
        if (p.age < 0) this.emitRing(p, R, 0, 0.02, -0.05, 0.05, 1.0, 0.6, 0.8, true);
        p.age += dt;
        if (p.age >= p.life) this.emitRing(p, R, 0, 0.02, -0.05, 0.05, 1.0, 0.6, 0.8, false);
        const d = Math.exp(-1.5 * dt);
        p.vx *= d; p.vz *= d;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        const tw = 0.6 + 0.4 * Math.sin(t * 17 + p.seed * 40);
        f.put(i, p.x, p.y, p.z, 1.6, 1.3, 0.6, Math.min(1, fr * 5) * (1 - fr) * tw, 0.014, CELL.dot, 0);
      }
    }
  }

  // ── Storm Cloud: a dark churning cloud (normal blending — it can read
  // dark against a bright sky), rain, and a lightning bolt drawn as a ribbon
  // so it still reads at range; the cloud lights up from inside on a strike.
  // Calm mode: no strikes, just a slow inner glow. ──
  private storm(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const cloud = this.cloud!;
    const rib = this.rib!;
    // Strike timing.
    let flash = 0;
    if (!calm) {
      this.boltAge += dt;
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 0.8 + rnd() * 1.8;
        this.boltAge = 0;
        this.boltJag = 0;
        this.boltFork = rnd() < 0.6;
        this.rejagBolt();
      }
      const ba = this.boltAge;
      if (ba < 0.18) {
        flash = ba < 0.045 ? 1 : ba < 0.075 ? 0.12 : 0.9 * (1 - (ba - 0.075) / 0.105);
        // Re-jag on the second stroke.
        if (ba >= 0.075 && this.boltJag === 0) { this.boltJag = 1; this.rejagBolt(); }
      }
    }
    const glowK = Math.max(calm ? 0.12 + 0.08 * Math.sin(t * 1.4) : flash, 0.1);
    // Cloud body.
    for (let j = 0; j < this.cps.length; j++) {
      const p = this.cps[j];
      const s = p.seed;
      const ang = j * 2.39996 + s;
      const rr = 0.03 + 0.085 * Math.sqrt((j + 0.5) / this.cps.length);
      const top = hash(j + 9.7);
      const lx = Math.cos(ang) * rr * 1.15 + Math.sin(t * 0.7 + j) * 0.012;
      const lz = Math.sin(ang) * rr * 0.9 + Math.cos(t * 0.6 + j * 1.7) * 0.01;
      const ly = 0.14 + (top - 0.5) * 0.045 + Math.sin(t * 0.9 + j * 2.1) * 0.006;
      this.lw(lx, ly, lz);
      const shade = 0.55 + 0.45 * top; // tops catch more light
      const lit = glowK * (0.55 + 0.45 * (1 - top));
      const l = lit * 0.7;
      const r = mix(0.12 * shade + 0.04, 0.55, l);
      const g = mix(0.13 * shade + 0.045, 0.62, l);
      const b = mix(0.17 * shade + 0.06, 0.88, l);
      cloud.put(j, this.wx, this.wy, this.wz, r, g, b, 0.94, 0.085 + 0.035 * hash(j + 1.3), CELL.puff, s * TAU + t * 0.12);
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        if (p.age < 0) this.emitRain(p, true);
        p.age += dt;
        if (p.age >= p.life) this.emitRain(p, false);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 0.55, 0.75, 1.1, 0.8 * (1 - fr), 0.07, CELL.streak, 0);
      } else {
        this.lw((p.a - 1) * 0.05, 0.13, 0);
        const k = glowK;
        f.put(i, this.wx, this.wy, this.wz, 0.5 * k * 2.2, 0.62 * k * 2.2, 1.0 * k * 2.2, k > 0.01 ? 1 : 0, 0.17, CELL.glow, 0);
      }
    }
    // The bolt.
    if (!calm && this.boltAge < 0.18 && flash > 0.05) {
      const k = flash * 2.6;
      for (let j = 0; j < 9; j++) {
        this.lw(this.boltA[j * 3], this.boltA[j * 3 + 1], this.boltA[j * 3 + 2]);
        rib.push(0, this.wx, this.wy, this.wz, 0.8 * k, 0.88 * k, 1.0 * k, 0.011 * (1 - j * 0.05));
      }
      if (this.boltFork) {
        for (let j = 0; j < 6; j++) {
          this.lw(this.boltB[j * 3], this.boltB[j * 3 + 1], this.boltB[j * 3 + 2]);
          rib.push(1, this.wx, this.wy, this.wz, 0.7 * k * 0.7, 0.8 * k * 0.7, 1.0 * k * 0.7, 0.007);
        }
      }
    }
  }

  private rejagBolt() {
    const sx = (rnd() - 0.5) * 0.1, sz = (rnd() - 0.5) * 0.08;
    const side = rnd() < 0.35;
    const ex = side ? (rnd() < 0.5 ? -1 : 1) * (0.14 + rnd() * 0.06) : (rnd() - 0.5) * 0.06;
    const ez = side ? (rnd() - 0.5) * 0.2 : (rnd() - 0.5) * 0.06;
    lightningPath(this.boltA, 9, sx, 0.11, sz, ex, -0.06, ez, 0.035);
    const m = 3 + Math.floor(rnd() * 3);
    const fx = this.boltA[m * 3], fy = this.boltA[m * 3 + 1], fz = this.boltA[m * 3 + 2];
    lightningPath(this.boltB, 6, fx, fy, fz, fx + (rnd() - 0.5) * 0.22, fy - 0.07, fz + (rnd() - 0.5) * 0.16, 0.02);
  }

  // ── Plasma Arcs: a plasma globe over the crown — a pulsing violet-white
  // core inside two spinning, jittering electric shells, four forking arcs
  // leaping from the globe to random points around the head, and sparks where
  // they land. ──
  private plasma(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const cy = 0.05;
    const RS = 0.075;
    const arcs = Math.max(2, Math.round(4 * Math.min(1, frac + 0.2)));
    let sparkIdx = 0;
    for (let k = 0; k < 4; k++) {
      this.arcTtl[k] -= dt;
      this.arcJag[k] -= dt;
      if (this.arcTtl[k] <= 0) {
        // New target on a shell around the core, mostly level / a bit below.
        const th = rnd() * TAU;
        const y = -0.5 + rnd() * 1.05;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const rad = 0.19 + rnd() * 0.08;
        const dx = Math.cos(th) * rr, dy = y, dz = Math.sin(th) * rr;
        this.arcT[k * 3] = dx * rad;
        this.arcT[k * 3 + 1] = cy + dy * rad;
        this.arcT[k * 3 + 2] = dz * rad;
        this.arcS[k * 3] = dx * RS;
        this.arcS[k * 3 + 1] = cy + dy * RS;
        this.arcS[k * 3 + 2] = dz * RS;
        this.arcTtl[k] = calm ? 0.45 + rnd() * 0.4 : 0.1 + rnd() * 0.2;
        this.arcJag[k] = 0;
        // Sparks where it lands.
        if (!calm && k < arcs) {
          this.lw(this.arcT[k * 3], this.arcT[k * 3 + 1], this.arcT[k * 3 + 2]);
          for (let n = 0; n < 4; n++) {
            for (; sparkIdx < this.ps.length; sparkIdx++) {
              const p = this.ps[sparkIdx];
              if (p.k === 2 && p.on && p.age >= p.life) break;
            }
            if (sparkIdx >= this.ps.length) break;
            const p = this.ps[sparkIdx++];
            const u = rnd() * 2 - 1, ph = rnd() * TAU, s = Math.sqrt(1 - u * u), sp = 0.5 + rnd() * 0.6;
            p.x = this.wx; p.y = this.wy; p.z = this.wz;
            p.vx = Math.cos(ph) * s * sp + this.evx; p.vy = u * sp + 0.2 + this.evy; p.vz = Math.sin(ph) * s * sp + this.evz;
            p.age = 0;
            p.life = 0.15 + rnd() * 0.15;
          }
        }
      }
      if (this.arcJag[k] <= 0) {
        this.arcJag[k] = calm ? 0.12 : 1 / 28;
        this.arcFlick[k] = calm ? 0.8 : 0.7 + rnd() * 0.3;
        const path = this.arcPathV[k];
        lightningPath(path, 10, this.arcS[k * 3], this.arcS[k * 3 + 1], this.arcS[k * 3 + 2], this.arcT[k * 3], this.arcT[k * 3 + 1], this.arcT[k * 3 + 2], 0.034);
        // A short fork off the middle of the arc.
        const m = 4 + Math.floor(rnd() * 3);
        const mx = path[m * 3], my = path[m * 3 + 1], mz = path[m * 3 + 2];
        lightningPath(this.arcBrV[k], 6, mx, my, mz, mx + (rnd() - 0.5) * 0.15, my + (rnd() - 0.5) * 0.15, mz + (rnd() - 0.5) * 0.15, 0.02);
      }
      if (k >= arcs) continue;
      const fl = this.arcFlick[k];
      for (let j = 0; j < 10; j++) {
        const o = k * 30 + j * 3;
        this.lw(this.arcPath[o], this.arcPath[o + 1], this.arcPath[o + 2]);
        const u = j / 9;
        rib.push(k, this.wx, this.wy, this.wz, 0.6 * 2.4 * fl, 0.3 * 2.4 * fl, 1.0 * 2.4 * fl, mix(0.017, 0.007, u));
      }
      for (let j = 0; j < 6; j++) {
        const o = k * 18 + j * 3;
        this.lw(this.arcBr[o], this.arcBr[o + 1], this.arcBr[o + 2]);
        const u = j / 5;
        rib.push(4 + k, this.wx, this.wy, this.wz, 0.5 * 1.8 * fl * (1 - u * 0.5), 0.25 * 1.8 * fl * (1 - u * 0.5), 1.0 * 1.8 * fl * (1 - u * 0.5), mix(0.009, 0.004, u));
      }
    }
    // Two great-circle shells, spinning on different axes, jittering.
    for (let s = 0; s < 2; s++) {
      const thn = 0.9 + 0.5 * s, phn = t * (s === 0 ? 2.3 : -1.7);
      const nx = Math.sin(thn) * Math.cos(phn), ny = Math.cos(thn), nz = Math.sin(thn) * Math.sin(phn);
      let ux = -nz, uz = nx;
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      const vx = ny * uz, vy = nz * ux - nx * uz, vz = -ny * ux;
      const fl = calm ? 0.7 : 0.6 + 0.4 * Math.sin(t * 31 + s * 2);
      for (let j = 0; j < rib.points; j++) {
        const a = (j / (rib.points - 1)) * TAU;
        const r = RS * (1 + (calm ? 0.05 : 0.14) * Math.sin(a * 6 + t * 11 + s));
        const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        this.lw(ux * ca + vx * sa, cy + vy * sa, uz * ca + vz * sa);
        rib.push(8 + s, this.wx, this.wy, this.wz, 0.55 * 1.8 * fl, 0.3 * 1.8 * fl, 1.0 * 1.8 * fl, 0.006);
      }
    }
    const pulse = 0.8 + 0.2 * Math.sin(t * 23) * (calm ? 0.2 : 1);
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        this.lw(0, cy, 0);
        if (p.a === 0) f.put(i, this.wx, this.wy, this.wz, 0.55 * pulse, 0.3 * pulse, 1.0 * pulse, 1, 0.19, CELL.glow, 0);
        else if (p.a === 1) f.put(i, this.wx, this.wy, this.wz, 2.0, 1.8, 2.4, pulse, 0.06, CELL.dot, 0);
        else f.put(i, this.wx, this.wy, this.wz, 1.3, 0.8, 2.2, 0.8 * pulse, 0.12, CELL.star, t * 1.3);
      } else if (p.k === 1) {
        const k = p.a;
        if (k >= arcs) { f.hide(i); continue; }
        this.lw(this.arcT[k * 3], this.arcT[k * 3 + 1], this.arcT[k * 3 + 2]);
        f.put(i, this.wx, this.wy, this.wz, 1.2, 0.9, 1.9, this.arcFlick[k], 0.06, CELL.glow, 0);
      } else {
        if (p.age < 0) { p.age = 1; p.life = 0; }
        p.age += dt;
        if (p.age >= p.life) { f.hide(i); continue; }
        p.vy -= 2.0 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 1.9, 1.6, 2.4, 1 - fr, 0.018, CELL.dot, 0);
      }
    }
  }

  // ── Prismatic: a rainbow double helix (two ribbons) climbing into a cone,
  // hues cycling along it, bright beads riding the strands, prismatic glints
  // and a white apex star. ──
  private prism(frac: number) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const P = rib.points;
    for (let s = 0; s < 2; s++) {
      for (let j = 0; j < P; j++) {
        const u = j / (P - 1);
        const ang = u * 10 + t * 1.7 + s * Math.PI;
        const r = 0.2 * (1 - u * 0.62);
        this.lw(Math.cos(ang) * r, -0.05 + u * 0.3, Math.sin(ang) * r);
        const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.8);
        const c = hsv((u * 1.1 + t * 0.2 + s * 0.5) % 1, 0.9, 1.7 * env);
        rib.push(s, this.wx, this.wy, this.wz, c[0], c[1], c[2], 0.014 * (1 - 0.45 * u));
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        const strand = p.a < 8 ? 0 : 1;
        const u = ((p.a % 8) / 8 + t * 0.3) % 1;
        const ang = u * 10 + t * 1.7 + strand * Math.PI;
        const r = 0.2 * (1 - u * 0.62);
        this.lw(Math.cos(ang) * r, -0.05 + u * 0.3, Math.sin(ang) * r);
        const c = hsv((u * 1.1 + t * 0.2 + strand * 0.5) % 1, 0.35, 2.3);
        f.put(i, this.wx, this.wy, this.wz, c[0], c[1], c[2], Math.pow(Math.sin(Math.PI * u), 0.6), 0.036 * (1 - 0.35 * u), CELL.dot, 0);
      } else if (p.k === 1) {
        const sn = Math.sin(t * 2.1 + p.seed * 20);
        if (sn <= 0) { p.b = -1; f.hide(i); continue; }
        if (p.b < 0) p.b = rnd();
        const u = (p.b + t * 0.3) % 1;
        const ang = u * 10 + t * 1.7 + (p.a % 2) * Math.PI;
        const r = 0.2 * (1 - u * 0.62);
        this.lw(Math.cos(ang) * r, -0.05 + u * 0.3, Math.sin(ang) * r);
        const fl = Math.pow(sn, 10);
        const c = hsv((p.seed + t * 0.2) % 1, 0.45, 2.6);
        f.put(i, this.wx, this.wy, this.wz, c[0], c[1], c[2], fl, 0.1 * (0.3 + 0.7 * fl), CELL.star, t * 2 + p.seed * 6);
      } else {
        this.lw(0, 0.27, 0);
        const pulse = 0.75 + 0.25 * Math.sin(t * 5);
        if (p.a === 0) f.put(i, this.wx, this.wy, this.wz, 2.3, 2.3, 2.3, pulse, 0.08, CELL.star, t * 1.5);
        else f.put(i, this.wx, this.wy, this.wz, 0.5, 0.5, 0.6, pulse, 0.13, CELL.glow, 0);
      }
    }
  }

  // ── Galaxy: a spiral disc that leans ~40° toward whoever is looking (so
  // it always reads as a galaxy, never an edge-on smear) — a warm white core,
  // two arms of blue / pink stars turning with differential rotation, violet
  // dust lanes. ──
  private galaxy(frac: number) {
    const t = this.t;
    const f = this.f;
    this.lw(0, 0.08, 0);
    const gx = this.wx, gy = this.wy, gz = this.wz;
    let hx = this.camX - gx, hz = this.camZ - gz;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    // Disc normal: up, leaned toward the viewer, with a slow precession.
    const wob = 0.12 * Math.sin(t * 0.6);
    let nx = hx * 0.85 + wob;
    const ny0 = 1;
    let nz = hz * 0.85;
    const nl = Math.hypot(nx, ny0, nz);
    nx /= nl; nz /= nl;
    const ny = ny0 / nl;
    // In-plane axes: u horizontal (⊥ the lean), v = n × u.
    let ux = -nz, uz = nx;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const vx = ny * uz, vy = nz * ux - nx * uz, vz = -ny * ux;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        if (p.a === 0) f.put(i, gx, gy, gz, 0.8, 0.66, 0.48, 1, 0.11, CELL.glow, 0);
        else if (p.a === 1) f.put(i, gx, gy, gz, 2.0, 1.85, 1.6, 1, 0.042, CELL.dot, 0);
        else f.put(i, gx, gy, gz, 0.22, 0.16, 0.5, 1, 0.26, CELL.glow, 0);
        continue;
      }
      let s: number, arm: number, spread: number;
      if (p.k === 1) {
        arm = p.a < 24 ? 0 : 1;
        s = ((p.a % 24) + 0.5) / 24;
        spread = 0.35;
      } else {
        arm = p.a % 2;
        s = (Math.floor(p.a / 2) + 0.6) / 5.2;
        spread = 0.15;
      }
      const r = 0.022 + s * 0.2 + (p.seed - 0.5) * 0.02;
      const th = arm * Math.PI + s * 3.6 + (p.seed - 0.5) * spread - t * (0.7 + (1 - s) * 0.9);
      const ct = Math.cos(th) * r, st = Math.sin(th) * r;
      const lift = (hash(p.a + 17 * p.k) - 0.5) * 0.014;
      const x = gx + ux * ct + vx * st + nx * lift;
      const y = gy + vy * st + ny * lift;
      const z = gz + uz * ct + vz * st + nz * lift;
      if (p.k === 1) {
        const tw = 0.7 + 0.3 * Math.sin(t * 6 + p.seed * 50);
        const br = (1.7 - s * 0.6) * tw;
        let cr: number, cg: number, cb: number;
        if (s < 0.25) { cr = 1.0; cg = 0.88; cb = 0.7; }
        else if (p.seed < 0.55) { cr = 0.5; cg = 0.7; cb = 1.0; }
        else { cr = 1.0; cg = 0.52; cb = 0.9; }
        const crisp = p.seed > 0.55;
        f.put(i, x, y, z, cr * br, cg * br, cb * br, 1, (crisp ? 0.024 : 0.034) + (1 - s) * 0.012, crisp ? CELL.dot : CELL.glow, 0);
      } else {
        const pink = p.a % 3 === 0;
        f.put(i, x, y, z, pink ? 0.45 : 0.3, pink ? 0.15 : 0.2, pink ? 0.4 : 0.75, 0.9, 0.085, CELL.glow, 0);
      }
    }
  }

  // ── Ghostfire: spectral tendrils — five pale-teal ribbons well up out of a
  // cold core, curl OVER and down around the crown (an inverted, curling cold
  // flame), light pulses flowing up them, a cold stepped flicker, and a few
  // soul lights that stream behind a running wearer. ──
  private ghostfire(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const P = rib.points;
    // Cold flicker: a stepped random dimming (not fire's warm shimmer).
    if (t >= this.ghostNext) {
      this.ghostNext = t + 0.05 + rnd() * 0.12;
      this.ghostFlick = rnd() < 0.18 ? 0.5 + rnd() * 0.2 : 0.85 + rnd() * 0.15;
    }
    const fl = this.ghostFlick;
    const tendrils = Math.max(3, Math.round(rib.strips * Math.min(1, frac + 0.3)));
    for (let k = 0; k < tendrils; k++) {
      const th0 = (k / rib.strips) * TAU + t * 0.35 + Math.sin(t * 0.7 + k * 2.1) * 0.25;
      const reach = 0.85 + 0.15 * Math.sin(t * 0.9 + k * 1.3);
      for (let j = 0; j < P; j++) {
        const s = j / (P - 1);
        const ang = th0 + s * 1.7;
        const r = 0.025 + 0.19 * s * reach;
        // Rises to ~0.26 m, then curls over and down.
        const h = 0.3 * Math.sin(Math.PI * 0.9 * s) * reach - 0.04 * s * s;
        const wob = 0.018 * Math.sin(t * 2.3 + s * 6 + k * 1.7);
        this.lw(Math.cos(ang) * (r + wob), h, Math.sin(ang) * (r + wob));
        const flow = 0.55 + 0.45 * Math.sin(s * 9 - t * 4.5 + k);
        const fade = Math.pow(1 - s, 0.8) * fl * flow;
        rib.push(k, this.wx, this.wy, this.wz, 0.35 * fade * 1.9, 1.35 * fade * 1.9, 1.2 * fade * 1.9, 0.004 + 0.02 * Math.pow(1 - s, 0.7));
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        this.lw(0, 0.0 + p.a * 0.03, 0);
        f.put(i, this.wx, this.wy, this.wz, 0.05 * fl, 0.55 * fl, 0.5 * fl, 1, 0.15 - p.a * 0.07, CELL.glow, 0);
      } else {
        if (p.age < 0) this.emit(p, 0.1, 0.05, 0.14, 0.1, 0.8, 0.5, 0.25, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.1, 0.05, 0.14, 0.1, 0.8, 0.5, 0.25, false);
        p.x += (p.vx + Math.sin(t * 3 + p.seed * 60) * 0.05) * dt;
        p.z += (p.vz + Math.cos(t * 2.6 + p.seed * 50) * 0.05) * dt;
        p.y += p.vy * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 0.8 * fl, 1.8 * fl, 1.6 * fl, Math.min(1, fr * 6) * (1 - fr), 0.022, CELL.dot, 0);
      }
    }
  }

  // ── Lovestruck: neon hearts float up, wobble, beat — and pop into little
  // sparkles (calm mode: they just fade). ──
  private hearts(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const ps = this.ps;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        if (p.age < 0) { this.emit(p, 0.1, 0.0, 0.17, 0.08, 0.95, 0.35, 0.95, true); p.b = Math.floor(rnd() * 3); }
        p.age += dt;
        if (p.age >= p.life) {
          if (!calm) this.popHeart(p.x, p.y, p.z, p.b);
          this.emit(p, 0.1, 0.0, 0.17, 0.08, 0.95, 0.35, 0.95, false);
          p.b = Math.floor(rnd() * 3);
        }
        p.x += (p.vx + Math.sin(p.age * 3 + p.seed * 6) * 0.06) * dt;
        p.z += (p.vz + Math.cos(p.age * 2.6 + p.seed * 5) * 0.04) * dt;
        const d = Math.exp(-0.25 * dt);
        p.vx *= d; p.vz *= d;
        p.y += p.vy * dt;
        const fr = p.age / p.life;
        const grow = smooth(0, 0.18, p.age);
        const beat = 1 + 0.14 * Math.pow(Math.max(0, Math.sin(p.age * 8 + p.seed * 3)), 6);
        const popK = calm ? 0 : smooth(0.9, 1, fr);
        const size = 0.075 * grow * beat * (1 + popK * 0.45);
        const al = calm ? 1 - smooth(0.7, 1, fr) : 1 - popK * popK;
        const c = HEART_COLS[p.b % 3];
        f.put(i, p.x, p.y, p.z, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, al, size, CELL.heart, Math.sin(p.age * 2.2 + p.seed * 5) * 0.3);
      } else if (p.k === 1) {
        if (p.age < 0) { p.age = 1; p.life = 0; }
        p.age += dt;
        if (p.age >= p.life) { f.hide(i); continue; }
        const d = Math.exp(-3 * dt);
        p.vx *= d; p.vy *= d; p.vz *= d;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 2.3, 1.4, 1.9, 1 - fr, 0.05 * (1 - 0.6 * fr), CELL.star, p.seed * 6 + t * 3);
      } else {
        if (p.age < 0) this.emit(p, 0.12, 0.02, 0.1, 0.08, 1.0, 0.5, 0.95, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.12, 0.02, 0.1, 0.08, 1.0, 0.5, 0.95, false);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 1.2, 0.35, 0.7, Math.min(1, fr * 5) * (1 - fr) * 0.8, 0.04, CELL.glow, 0);
      }
    }
  }

  private popHeart(x: number, y: number, z: number, col: number) {
    let n = 0;
    for (const p of this.ps) {
      if (n >= 5) break;
      if (p.k !== 1 || !p.on || p.age < p.life) continue;
      const a = (n / 5) * TAU + rnd() * 0.5;
      const sp = 0.45 + rnd() * 0.25;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * sp + this.evx * 0.5;
      p.vy = Math.sin(a) * sp * 0.8 + 0.1;
      p.vz = (rnd() - 0.5) * 0.3 + this.evz * 0.5;
      p.age = 0;
      p.life = 0.24 + rnd() * 0.1;
      p.b = col;
      n++;
    }
  }

  // ── Overclocked: two counter-turning cylinders of glowing 0/1 glyphs raining
  // down around the crown (white-hot lead glyph, fading green trail), a scan
  // line sweeping down through them that lights the digits it crosses, and a
  // faint rim ring at the top. Kept above the brow so it never curtains the
  // face. ──
  private binary(frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const far = this.ppm < 70;
    const sy = 0.28 - ((t * 0.55) % 1) * 0.42;
    const sfade = smooth(-0.14, -0.08, sy) * (1 - smooth(0.24, 0.28, sy));
    for (let j = 0; j < rib.points; j++) {
      const a = (j / (rib.points - 1)) * TAU;
      this.lw(Math.cos(a) * 0.2, sy, Math.sin(a) * 0.2);
      rib.push(0, this.wx, this.wy, this.wz, 0.12 * sfade, 0.9 * sfade, 0.3 * sfade, 0.004);
      this.lw(Math.cos(a) * 0.19, 0.285, Math.sin(a) * 0.19);
      const seg = 0.5 + 0.5 * Math.sin(a * 12 - t * 2);
      rib.push(1, this.wx, this.wy, this.wz, 0.03 * (0.5 + seg), 0.3 * (0.5 + seg), 0.1 * (0.5 + seg), 0.004);
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0 || p.k === 2) {
        const inner = p.k === 2;
        const per = inner ? 5 : 7;
        const cols = inner ? 4 : 6;
        const c = Math.floor(p.a / per);
        const k = p.a % per;
        const th = inner ? (c / cols) * TAU + 0.6 - t * 0.3 : (c / cols) * TAU + (c % 2) * 0.3 + t * 0.22;
        const speed = (inner ? 0.32 : 0.42) + 0.14 * hash(c + (inner ? 11.7 : 1.7));
        const yh = 0.28 - ((((t * speed) / 0.8 + hash(c + (inner ? 17.3 : 7.3))) % 1) * 0.8);
        const y = yh + k * 0.052;
        const vis = smooth(-0.13, -0.05, y) * (1 - smooth(0.22, 0.29, y));
        if (vis <= 0.01) { f.hide(i); continue; }
        const r = inner ? 0.125 : 0.19;
        this.lw(Math.cos(th) * r, y, Math.sin(th) * r);
        const bit = hash(Math.floor(t * 3 + p.seed * 10) + p.a * 7.1) > 0.5;
        const cell = far ? CELL.dot : bit ? CELL.one : CELL.zero;
        const zz = y - sy;
        const boost = 1 + (calm ? 0.4 : 1.2) * Math.exp(-(zz * zz) / 0.0009);
        const sz = inner ? 0.04 : 0.05;
        if (k === 0) f.put(i, this.wx, this.wy, this.wz, 1.6 * boost, 2.2 * boost, 1.75 * boost, vis, sz + 0.002, cell, 0);
        else {
          const br = (far ? 3.0 : 2.1) * (1 - k / (per + 1.5)) * (inner ? 0.65 : 1) * boost;
          f.put(i, this.wx, this.wy, this.wz, 0.14 * br, 1.0 * br, 0.38 * br, vis, sz, cell, 0);
        }
      } else {
        const a = (p.a / 6) * TAU - t * 0.5;
        this.lw(Math.cos(a) * 0.12, -0.04, Math.sin(a) * 0.12);
        const pulse = 0.6 + 0.4 * Math.sin(t * 4 + p.a);
        f.put(i, this.wx, this.wy, this.wz, 0.08 * pulse, 0.8 * pulse, 0.3 * pulse, 0.9, 0.06, CELL.glow, 0);
      }
    }
  }

  // Horizontal unit vector from (x, z) toward the viewer, into fvx / fvz.
  private faceCam(x: number, z: number) {
    const hx = this.camX - x, hz = this.camZ - z;
    const l = Math.hypot(hx, hz) || 1;
    this.fvx = hx / l;
    this.fvz = hz / l;
  }

  // ── Sunbeams: a small sun over the crown — a white-hot core in a corona
  // ring, ten tapering rays (long / short alternating, breathing) fanned in a
  // vertical disc that always faces the viewer, gold dust drifting up through
  // the light and glints riding the long ray tips. ──
  private sunbeams(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const P = rib.points;
    const N = rib.strips;
    this.lw(0, 0.16, 0);
    const cx = this.wx, cy = this.wy, cz = this.wz;
    this.faceCam(cx, cz);
    const rx = this.fvz, rz = -this.fvx;
    const breath = 0.88 + 0.12 * Math.sin(t * 1.7);
    for (let k = 0; k < N; k++) {
      const long = k % 2 === 0;
      if (!long && frac < 0.5) continue;
      const th = (k / N) * TAU + t * 0.22;
      const L = (long ? 0.27 : 0.16) * (0.85 + 0.15 * Math.sin(t * 2.1 + k * 2.3)) * breath;
      const dx = Math.cos(th), dy = Math.sin(th);
      const dim = 0.3 + 0.7 * smooth(-0.95, 0.15, dy); // rays pointing into the hat fade
      for (let j = 0; j < P; j++) {
        const u = j / (P - 1);
        const r = 0.05 + u * (L - 0.05);
        const fade = Math.pow(1 - u, 1.25) * dim * (long ? 1.5 : 1.05);
        rib.push(k, cx + rx * dx * r, cy + dy * r, cz + rz * dx * r,
          mix(2.0, 1.6, u) * fade, mix(1.6, 0.75, u) * fade, mix(0.9, 0.14, u) * fade, 0.018 * (1 - 0.78 * u));
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        const pulse = 0.85 + 0.15 * Math.sin(t * 2.6);
        if (p.a === 0) f.put(i, cx, cy, cz, 0.55 * pulse, 0.34 * pulse, 0.08 * pulse, 1, 0.3, CELL.glow, 0);
        else if (p.a === 1) f.put(i, cx, cy, cz, 1.9, 1.2, 0.35, 0.85, 0.16 + 0.012 * Math.sin(t * 3), CELL.ring, t * 0.4);
        else f.put(i, cx, cy, cz, 2.4, 2.1, 1.5, 1, 0.1 * pulse, CELL.star, t * 0.5);
      } else if (p.k === 1) {
        if (p.age < 0) this.emit(p, 0.15, 0.03, 0.06, 0.08, 1.2, 0.7, 0.8, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.15, 0.03, 0.06, 0.08, 1.2, 0.7, 0.8, false);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        const tw = 0.6 + 0.4 * Math.sin(t * 9 + p.seed * 40);
        f.put(i, p.x, p.y, p.z, 1.9, 1.45, 0.55, Math.min(1, fr * 6) * (1 - fr) * tw, 0.02, CELL.dot, 0);
      } else {
        // Glints riding the long ray tips.
        const k = (p.a * 2 + 2) % N;
        const th = (k / N) * TAU + t * 0.22;
        const r = 0.27 * (0.85 + 0.15 * Math.sin(t * 2.1 + k * 2.3)) * breath;
        const dx = Math.cos(th), dy = Math.sin(th);
        const sn = Math.pow(Math.max(0, Math.sin(t * 2.2 + p.seed * 20)), 6);
        f.put(i, cx + rx * dx * r, cy + dy * r, cz + rz * dx * r, 2.4, 2.0, 1.2, sn, 0.09 * (0.3 + 0.7 * sn), CELL.star, t + p.seed * 5);
      }
    }
  }

  // ── Bubbling: iridescent soap bubbles lift off the crown, wobble, breathe
  // and pop into a spray of droplets (calm mode: they just fade). ──
  private bubbles(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        if (p.age < 0) this.emit(p, 0.11, 0.0, 0.14, 0.08, 1.5, 0.9, 0.9, true);
        p.age += dt;
        if (p.age >= p.life) {
          if (!calm) this.popBubble(p.x, p.y, p.z, p.seed);
          this.emit(p, 0.11, 0.0, 0.14, 0.08, 1.5, 0.9, 0.9, false);
        }
        const d = Math.exp(-0.6 * dt);
        p.vx *= d; p.vz *= d;
        p.x += (p.vx + Math.sin(p.age * 2.6 + p.seed * 30) * 0.05) * dt;
        p.z += (p.vz + Math.cos(p.age * 2.2 + p.seed * 25) * 0.05) * dt;
        p.y += p.vy * dt;
        const fr = p.age / p.life;
        const popK = calm ? 0 : smooth(0.9, 1, fr);
        const size = (0.04 + 0.035 * p.seed) * smooth(0, 0.25, p.age) * (1 + 0.06 * Math.sin(p.age * 9 + p.seed * 20)) * (1 + popK * 0.4);
        const al = calm ? 1 - smooth(0.75, 1, fr) : 1 - popK;
        const c = hsv((p.seed + p.age * 0.3) % 1, 0.42, 1.3);
        f.put(i, p.x, p.y, p.z, c[0], c[1], c[2], al * 0.95, size, CELL.bubble, 0);
      } else if (p.k === 1) {
        if (p.age < 0) { p.age = 1; p.life = 0; }
        p.age += dt;
        if (p.age >= p.life) { f.hide(i); continue; }
        const d = Math.exp(-3 * dt);
        p.vx *= d; p.vy *= d; p.vz *= d;
        p.vy -= 1.2 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        const c = hsv(p.b, 0.35, 2.0);
        f.put(i, p.x, p.y, p.z, c[0], c[1], c[2], 1 - fr, 0.022 * (1 - 0.5 * fr), CELL.dot, 0);
      } else {
        const a = (p.a / 3) * TAU + t * 0.5;
        this.lw(Math.cos(a) * 0.08, 0.02, Math.sin(a) * 0.08);
        const pulse = 0.7 + 0.3 * Math.sin(t * 2.3 + p.a * 2);
        f.put(i, this.wx, this.wy, this.wz, 0.08 * pulse, 0.34 * pulse, 0.5 * pulse, 0.9, 0.13, CELL.glow, 0);
      }
    }
  }

  private popBubble(x: number, y: number, z: number, hue: number) {
    let n = 0;
    for (const p of this.ps) {
      if (n >= 5) break;
      if (p.k !== 1 || !p.on || p.age < p.life) continue;
      const a = (n / 5) * TAU + rnd() * 0.6;
      const sp = 0.3 + rnd() * 0.3;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * sp + this.evx * 0.5;
      p.vy = 0.1 + rnd() * 0.25;
      p.vz = Math.sin(a) * sp + this.evz * 0.5;
      p.age = 0;
      p.life = 0.3 + rnd() * 0.15;
      p.b = hue;
      n++;
    }
  }

  // ── Frostbite: a crown of irregular ice spikes on a frost band, shards of
  // ice orbiting on a tilted ring, cold mist at the root, snowflakes turning as
  // they drift down and glints along the spikes. ──
  private frostbite(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const P = rib.points;
    const R = 0.17;
    const spin = t * 0.15;
    const SP = 7;
    for (let j = 0; j < P; j++) {
      const u = j / (P - 1);
      const a = u * TAU + spin;
      const si = Math.min(SP - 1, Math.floor(u * SP));
      const ph = (u * SP) % 1;
      const tri = 1 - Math.abs(ph * 2 - 1);
      const h = -0.03 + Math.pow(tri, 1.1) * (0.06 + 0.12 * hash(si + 3.3));
      const r = R * (1 - 0.12 * tri);
      this.lw(Math.cos(a) * r, h, Math.sin(a) * r);
      const k = 0.9 + 1.0 * tri;
      rib.push(0, this.wx, this.wy, this.wz, 0.5 * k, 1.15 * k, 1.9 * k, 0.012 - 0.005 * tri);
      this.lw(Math.cos(a) * R, -0.035, Math.sin(a) * R);
      rib.push(1, this.wx, this.wy, this.wz, 0.35, 0.8, 1.3, 0.011);
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        const a = (p.a / 6) * TAU + t * 0.9;
        this.lw(Math.cos(a) * 0.22, 0.1 + 0.05 * Math.sin(a * 2 + t), Math.sin(a) * 0.22);
        const sp = 0.6 + 0.4 * Math.sin(a + t * 2);
        f.put(i, this.wx, this.wy, this.wz, 0.9 * sp + 0.5, 1.5 * sp + 0.5, 2.1 * sp + 0.4, 1, 0.075, CELL.diamond, a * 0.5 + Math.sin(t + p.a));
      } else if (p.k === 1) {
        if (p.age < 0) this.emit(p, 0.15, 0.3, -0.1, -0.05, 2.0, 0.8, 0.7, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.15, 0.3, -0.1, -0.05, 2.0, 0.8, 0.7, false);
        p.x += (p.vx + Math.sin(p.age * 1.8 + p.seed * 30) * 0.04) * dt;
        p.z += (p.vz + Math.cos(p.age * 1.5 + p.seed * 20) * 0.04) * dt;
        p.y += p.vy * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 1.2, 1.55, 2.0, Math.min(1, fr * 5) * (1 - smooth(0.7, 1, fr)), 0.035, CELL.snow, p.age * 1.3 + p.seed * 6);
      } else if (p.k === 2) {
        const a = (p.a / 5) * TAU - t * 0.25;
        this.lw(Math.cos(a) * 0.1, 0.0, Math.sin(a) * 0.1);
        f.put(i, this.wx, this.wy, this.wz, 0.14, 0.32, 0.55, 0.9, 0.16, CELL.glow, 0);
      } else {
        const sn = Math.sin(t * 1.9 + p.seed * 20);
        if (sn <= 0) { p.b = -1; f.hide(i); continue; }
        if (p.b < 0) p.b = rnd();
        const fl = Math.pow(sn, 12);
        const a = p.b * TAU + spin;
        this.lw(Math.cos(a) * R * 0.95, 0.05 + 0.08 * hash(p.a + 4), Math.sin(a) * R * 0.95);
        f.put(i, this.wx, this.wy, this.wz, 1.6, 2.2, 2.6, fl, 0.1 * (0.3 + 0.7 * fl), CELL.star, t + p.seed * 5);
      }
    }
  }

  // ── Void Rift: a dark tear in the air over the crown ringed by a fiery
  // accretion loop (facing the viewer), a wide violet halo, violet tendrils
  // cracking off the rim and motes spiralling in to be swallowed. ──
  private voidrift(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const cloud = this.cloud!;
    const P = rib.points;
    this.lw(0, 0.16, 0);
    const cx = this.wx, cy = this.wy, cz = this.wz;
    this.faceCam(cx, cz);
    const rx = this.fvz, rz = -this.fvx;
    const nx = this.fvx, nz = this.fvz;
    const R = 0.085 * (1 + 0.04 * Math.sin(t * 3.1));
    // The dark core: a few near-black puffs (normal blending: reads as a hole).
    for (let j = 0; j < this.cps.length; j++) {
      const a = j * 2.1 + t * 0.6;
      const o = j === 0 ? 0 : 0.025;
      cloud.put(j, cx + rx * Math.cos(a) * o, cy + Math.sin(a) * o, cz + rz * Math.cos(a) * o, 0.004, 0.002, 0.012, 0.97, 0.16 - j * 0.01, CELL.puff, a);
    }
    for (let j = 0; j < P; j++) {
      const a = (j / (P - 1)) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const hot = Math.pow(Math.max(0, Math.cos(a - t * 1.6)), 3);
      const w = 0.5 + 0.5 * Math.sin(a * 2 + t);
      const depth = 0.012 * Math.sin(a * 3 + t * 2);
      const k = 1 + 1.2 * hot;
      rib.push(0, cx + rx * ca * R + nx * depth, cy + sa * R, cz + rz * ca * R + nz * depth,
        mix(1.7, 0.75, w) * k, mix(0.55, 0.2, w) * k, mix(0.1, 1.7, w) * k, 0.014 * (0.8 + 0.5 * hot));
      const R2 = R * (1.5 + 0.06 * Math.sin(a * 4 - t * 1.5));
      const g = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(a * 3 - t * 2), 2);
      rib.push(1, cx + rx * ca * R2, cy + sa * R2, cz + rz * ca * R2, 0.4 * g, 0.12 * g, 0.9 * g, 0.006);
    }
    // Tendrils cracking off the rim (disc-frame path, re-jagged on a timer).
    for (let k = 0; k < 2; k++) {
      this.xt[k] -= dt;
      if (this.xt[k] <= 0) {
        this.xt[k] = calm ? 0.35 : 0.06 + rnd() * 0.06;
        if (this.xl[k] <= 0) {
          this.xl[k] = 0.5 + rnd() * 0.5;
          this.xa[k] = rnd() * TAU;
        }
        const a = this.xa[k];
        const ex = Math.cos(a) * R * (2.0 + rnd() * 0.5), ey = Math.sin(a) * R * (2.0 + rnd() * 0.5);
        lightningPath(this.xsV[k], 9, Math.cos(a) * R, Math.sin(a) * R, 0, ex, ey, (rnd() - 0.5) * 0.05, 0.03);
      }
      this.xl[k] -= dt;
      if (this.xl[k] < 0.12) continue; // gap between cracks
      const fl = calm ? 0.7 : 0.6 + rnd() * 0.5;
      for (let j = 0; j < 9; j++) {
        const o = k * 27 + j * 3;
        const u = j / 8;
        rib.push(2 + k, cx + rx * this.xs[o] + nx * this.xs[o + 2], cy + this.xs[o + 1], cz + rz * this.xs[o] + nz * this.xs[o + 2],
          1.1 * fl * (1 - u * 0.5), 0.3 * fl * (1 - u * 0.5), 2.0 * fl * (1 - u * 0.5), mix(0.012, 0.004, u));
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        // Motes spiralling in.
        const fr = (t * 0.32 + hash(p.a * 1.7)) % 1;
        const r = mix(0.22, 0.015, Math.pow(fr, 1.4));
        const th = hash(p.a * 3.1) * TAU + fr * fr * 6 - t * 0.4;
        const dp = (hash(p.a * 5.3) - 0.5) * 0.05 * (1 - fr);
        const al = smooth(0, 0.12, fr) * (1 - smooth(0.85, 1, fr));
        const k = 1 - fr;
        f.put(i, cx + rx * Math.cos(th) * r + nx * dp, cy + Math.sin(th) * r, cz + rz * Math.cos(th) * r + nz * dp,
          mix(1.5, 1.0, fr) * (0.6 + k), mix(0.6, 0.6, fr) * (0.5 + k * 0.6), mix(0.2, 1.9, fr), al, 0.022 - 0.008 * fr, CELL.dot, 0);
      } else {
        const a = (p.a / 8) * TAU + t * 0.9;
        const hot = Math.pow(Math.max(0, Math.cos(a - t * 1.6)), 3);
        f.put(i, cx + rx * Math.cos(a) * R, cy + Math.sin(a) * R, cz + rz * Math.cos(a) * R,
          0.5 + 0.9 * hot, 0.15 + 0.4 * hot, 0.55 + 0.4 * hot, 0.9, 0.07, CELL.glow, 0);
      }
    }
  }

  // ── Fireflies: warm green-gold lights drifting in lazy loops around the
  // head, each blinking in its own rhythm with a soft glow and a lagging
  // afterglow, a little pollen in between. ──
  private fireflies(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 2) {
        const a = (p.a / 8) * TAU + t * 0.15 * (1 + hash(p.a));
        this.lw(Math.cos(a) * (0.1 + 0.1 * hash(p.a + 2)), 0.0 + 0.2 * hash(p.a + 5) + 0.02 * Math.sin(t + p.a), Math.sin(a) * (0.1 + 0.1 * hash(p.a + 2)));
        const tw = 0.5 + 0.5 * Math.sin(t * 2 + p.a * 3);
        f.put(i, this.wx, this.wy, this.wz, 0.9, 1.1, 0.25, 0.5 * tw, 0.016, CELL.dot, 0);
        continue;
      }
      const j = p.a;
      const w = 0.35 + 0.25 * hash(j + 1.1);
      const ph = hash(j + 9.7) * TAU;
      const a = t * w + ph;
      const R = 0.12 + 0.11 * hash(j + 3.3);
      const lx = Math.cos(a) * R + 0.04 * Math.sin(t * 1.3 + ph * 2);
      const lz = Math.sin(a * 0.83 + ph) * R;
      const ly = 0.05 + 0.13 * (0.5 + 0.5 * Math.sin(t * 0.55 * (1 + hash(j)) + ph)) + 0.03 * Math.sin(t * 2.1 + j);
      // Blink: on for ~55 % of a per-fly cycle, with a smooth swell.
      const cyc = (t * (0.42 + 0.2 * hash(j + 6.6)) + hash(j + 2.2)) % 1;
      const on = cyc < 0.7 ? Math.pow(Math.sin((cyc / 0.7) * Math.PI), 1.1) : 0;
      if (p.k === 0) {
        this.lw(lx, ly, lz);
        f.put(i, this.wx, this.wy, this.wz, 1.6 * (0.2 + on), 2.2 * (0.2 + on), 0.4 * (0.2 + on), 0.4 + 0.6 * on, 0.026 + 0.012 * on, CELL.dot, 0);
      } else {
        // Glow, lagging a little behind on the path.
        const a2 = a - 0.25 * w;
        this.lw(Math.cos(a2) * R + 0.04 * Math.sin(t * 1.3 + ph * 2), ly, Math.sin(a2 * 0.83 + ph) * R);
        f.put(i, this.wx, this.wy, this.wz, 0.5 * on + 0.03, 0.8 * on + 0.05, 0.1 * on, 1, 0.075 * (0.4 + 0.6 * on), CELL.glow, 0);
      }
    }
  }

  // ── Cosmic Crown: a tiara of constellations — a zig-zag loop of bright
  // stars joined by thin lines, a big apex star, nebula haze behind it,
  // twinkling star dust and the odd shooting star. ──
  private cosmic(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    const NS = 8;
    const spin = t * 0.14;
    // Constellation loop.
    for (let j = 0; j <= NS; j++) {
      const k = j % NS;
      const a = (k / NS) * TAU + spin;
      const r = 0.17 + 0.03 * hash(k + 1.7);
      const h = (k % 2 === 0 ? 0.13 : 0.03) + 0.05 * hash(k + 8.1);
      this.lw(Math.cos(a) * r, h, Math.sin(a) * r);
      rib.push(0, this.wx, this.wy, this.wz, 0.35, 0.7, 1.5, 0.005);
    }
    // Shooting star.
    let shot = 0;
    if (!calm) {
      this.boltAge += dt;
      if (this.boltAge > this.nextBolt) { this.boltAge = 0; this.nextBolt = 2 + rnd() * 2; this.boltFork = true; this.boltJag = rnd() * TAU; }
      if (this.boltFork) {
        shot = this.boltAge / 0.55;
        if (shot >= 1) { this.boltFork = false; shot = 0; }
      }
    }
    const sa = this.boltJag;
    if (shot > 0) {
      for (let j = 0; j < 8; j++) {
        this.shootAt(sa, Math.max(0, shot - j * 0.035));
        const k = 1 - j / 8;
        rib.push(1, this.wx, this.wy, this.wz, 1.6 * k, 1.8 * k, 2.4 * k, 0.012 * k);
      }
    }
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        const a = (p.a / NS) * TAU + spin;
        const r = 0.17 + 0.03 * hash(p.a + 1.7);
        const hi = p.a % 2 === 0;
        const h = (hi ? 0.13 : 0.03) + 0.05 * hash(p.a + 8.1);
        this.lw(Math.cos(a) * r, h, Math.sin(a) * r);
        const tw = 0.7 + 0.3 * Math.sin(t * 3 + p.a * 2.1);
        f.put(i, this.wx, this.wy, this.wz, 1.8 * tw, 2.0 * tw, 2.6 * tw, 1, hi ? 0.085 : 0.055, CELL.star, t * 0.3 + p.a);
      } else if (p.k === 1) {
        if (p.a === 0) {
          this.lw(0, 0.26, 0);
          const tw = 0.75 + 0.25 * Math.sin(t * 2.4);
          f.put(i, this.wx, this.wy, this.wz, 2.4 * tw, 2.3 * tw, 2.6 * tw, 1, 0.13, CELL.star, t * 0.2);
        } else {
          const a = ((p.a - 1) / 5) * TAU + spin * 0.6 + hash(p.a) * 2;
          this.lw(Math.cos(a) * 0.1, 0.06 + 0.06 * Math.sin(t * 0.5 + p.a), Math.sin(a) * 0.1);
          const hue = 0.5 + 0.28 * Math.sin(t * 0.4 + p.a * 1.3);
          const c = hsv(hue % 1, 0.6, 0.3);
          f.put(i, this.wx, this.wy, this.wz, c[0], c[1], c[2], 1, 0.15, CELL.glow, 0);
        }
      } else if (p.k === 2) {
        const a = hash(p.a * 2.3) * TAU + t * 0.1;
        const yy = hash(p.a * 4.1) * 0.3 - 0.02;
        this.lw(Math.cos(a) * 0.2, yy, Math.sin(a) * 0.2);
        const tw = Math.pow(0.5 + 0.5 * Math.sin(t * 4 + p.a * 5), 3);
        f.put(i, this.wx, this.wy, this.wz, 1.3, 1.5, 2.0, 0.25 + 0.75 * tw, 0.02, CELL.dot, 0);
      } else {
        if (shot <= 0) { f.hide(i); continue; }
        this.shootAt(sa, shot);
        f.put(i, this.wx, this.wy, this.wz, 2.4, 2.5, 2.8, 1 - shot * 0.5, 0.05, CELL.star, shot * 8);
      }
    }
  }

  // Cosmic's shooting star path: from high on one side down across the crown.
  private shootAt(sa: number, u: number) {
    this.lw(Math.cos(sa) * (0.32 - 0.64 * u), 0.34 - 0.3 * u, Math.sin(sa) * (0.32 - 0.64 * u));
  }

  // ── Thunderhead: a crackling electric crown — four forking yellow-white
  // bolts leap up and out from the crown in bursts, hot tips and sparks, and
  // every couple of seconds a big flash lights the whole crown (calm: no
  // flash, slower crackle). ──
  private lightning(dt: number, frac: number, calm: boolean) {
    const t = this.t;
    const f = this.f;
    const rib = this.rib!;
    let flash = 0;
    if (!calm) {
      this.boltAge += dt;
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) { this.nextBolt = 1.6 + rnd() * 2; this.boltAge = 0; }
      const ba = this.boltAge;
      if (ba < 0.16) flash = ba < 0.04 ? 1 : ba < 0.07 ? 0.25 : 0.85 * (1 - (ba - 0.07) / 0.09);
    }
    const bolts = Math.max(2, Math.round(4 * Math.min(1, frac + 0.3)));
    for (let k = 0; k < 4; k++) {
      this.xt[k] -= dt;
      this.xl[k] -= dt;
      if (this.xl[k] <= 0) {
        // New bolt: a direction, a duty (on for a while, then a short gap).
        this.xl[k] = calm ? 0.6 + rnd() * 0.4 : 0.25 + rnd() * 0.45;
        this.xa[k] = (k / 4) * TAU + rnd() * 1.2 - 0.6 + t * 0.2;
        this.xa[4 + k] = 0.35 + rnd() * 0.9;
        this.xa[8 + k] = rnd() < 0.12 ? 1 : 0; // 1 = gap
      }
      if (this.xt[k] <= 0) {
        this.xt[k] = calm ? 0.14 : 0.035 + rnd() * 0.04;
        const az = this.xa[k], el = this.xa[4 + k];
        const L = 0.3 + rnd() * 0.1 + flash * 0.1;
        const ex = Math.cos(az) * Math.cos(el) * L, ey = 0.02 + Math.sin(el) * L, ez = Math.sin(az) * Math.cos(el) * L;
        lightningPath(this.xsV[k], 9, 0, 0.02, 0, ex, ey, ez, 0.035);
        const m = 3 + Math.floor(rnd() * 3);
        const mx = this.xs[k * 27 + m * 3], my = this.xs[k * 27 + m * 3 + 1], mz = this.xs[k * 27 + m * 3 + 2];
        lightningPath(this.xfV[k], 6, mx, my, mz, mx + (rnd() - 0.5) * 0.26, my + 0.04 + rnd() * 0.08, mz + (rnd() - 0.5) * 0.26, 0.025);
        this.xa[12 + k] = calm ? 0.8 : 0.7 + rnd() * 0.3;
      }
      if (k >= bolts || this.xa[8 + k] > 0) continue;
      const fl = this.xa[12 + k] * (1 + flash * 0.6);
      for (let j = 0; j < 9; j++) {
        const o = k * 27 + j * 3;
        this.lw(this.xs[o], this.xs[o + 1], this.xs[o + 2]);
        const u = j / 8;
        rib.push(k, this.wx, this.wy, this.wz, 2.4 * fl, 2.1 * fl, 1.1 * fl * (1 - 0.3 * u) + 0.4 * u, mix(0.024, 0.008, u));
      }
      for (let j = 0; j < 6; j++) {
        const o = k * 18 + j * 3;
        this.lw(this.xf[o], this.xf[o + 1], this.xf[o + 2]);
        const u = j / 5;
        rib.push(4 + k, this.wx, this.wy, this.wz, 1.7 * fl * (1 - u * 0.4), 1.6 * fl * (1 - u * 0.4), 1.1 * fl, mix(0.009, 0.004, u));
      }
    }
    const pulse = 0.85 + 0.15 * Math.sin(t * 24) * (calm ? 0.2 : 1);
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        this.lw(0, 0.02, 0);
        if (p.a === 0) f.put(i, this.wx, this.wy, this.wz, 0.55 * pulse, 0.45 * pulse, 0.12 * pulse, 1, 0.15 + 0.06 * flash, CELL.glow, 0);
        else if (p.a === 1) f.put(i, this.wx, this.wy, this.wz, 2.4, 2.2, 1.5, pulse, 0.05, CELL.dot, 0);
        else f.put(i, this.wx, this.wy, this.wz, 0.4 * flash * 2, 0.55 * flash * 2, 1.1 * flash * 2, flash > 0.01 ? 1 : 0, 0.34, CELL.glow, 0);
      } else if (p.k === 1) {
        const k = p.a;
        if (k >= bolts || this.xa[8 + k] > 0) { f.hide(i); continue; }
        const o = k * 27 + 8 * 3;
        this.lw(this.xs[o], this.xs[o + 1], this.xs[o + 2]);
        f.put(i, this.wx, this.wy, this.wz, 1.2, 1.1, 0.6, this.xa[12 + k] * 0.8, 0.035, CELL.glow, 0);
      } else {
        if (p.age < 0) { p.age = 1; p.life = 0; }
        p.age += dt;
        if (p.age >= p.life) {
          if (calm || rnd() > dt * 9) { f.hide(i); continue; }
          const k = Math.floor(rnd() * Math.min(bolts, 4));
          const o = k * 27 + 8 * 3;
          this.lw(this.xs[o], this.xs[o + 1], this.xs[o + 2]);
          const u = rnd() * 2 - 1, ph = rnd() * TAU, s = Math.sqrt(1 - u * u), sp = 0.4 + rnd() * 0.5;
          p.x = this.wx; p.y = this.wy; p.z = this.wz;
          p.vx = Math.cos(ph) * s * sp + this.evx; p.vy = u * sp + 0.2 + this.evy; p.vz = Math.sin(ph) * s * sp + this.evz;
          p.age = 0;
          p.life = 0.15 + rnd() * 0.15;
        }
        p.vy -= 2.0 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fr = p.age / p.life;
        f.put(i, p.x, p.y, p.z, 2.2, 1.9, 1.0, 1 - fr, 0.018, CELL.dot, 0);
      }
    }
  }

  // ── Sakura Drift: cherry-blossom petals shed from over the crown, fluttering
  // (tilt squashes them) and turning as they sway down, a soft pink haze and
  // a few sparkles. They fade before they reach the face. ──
  private sakura(dt: number, frac: number) {
    const t = this.t;
    const f = this.f;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!this.gate(p, i, frac)) continue;
      if (p.k === 0) {
        if (p.age < 0) this.emit(p, 0.15, 0.3, -0.13, -0.05, 1.6, 0.6, 0.7, true);
        p.age += dt;
        if (p.age >= p.life) this.emit(p, 0.15, 0.3, -0.13, -0.05, 1.6, 0.6, 0.7, false);
        const sway = Math.sin(p.age * 2.4 + p.seed * 30);
        p.x += (p.vx * 1.6 + sway * 0.07) * dt;
        p.z += (p.vz * 1.6 + Math.cos(p.age * 2.0 + p.seed * 20) * 0.07) * dt;
        p.y += (p.vy + 0.03 * sway) * dt;
        const fr = p.age / p.life;
        const flutter = 0.55 + 0.45 * Math.abs(Math.cos(p.age * 3.3 + p.seed * 9));
        const pk = hash(p.a * 1.9);
        f.put(i, p.x, p.y, p.z, mix(1.35, 1.6, pk), mix(0.5, 0.85, pk), mix(0.7, 0.95, pk),
          Math.min(1, fr * 6) * (1 - smooth(0.6, 1, fr)), 0.072 * flutter, CELL.petal, p.age * 2.2 + p.seed * 6);
      } else if (p.k === 1) {
        const a = (p.a / 3) * TAU + t * 0.3;
        this.lw(Math.cos(a) * 0.07, 0.17, Math.sin(a) * 0.07);
        const pulse = 0.75 + 0.25 * Math.sin(t * 1.4 + p.a * 2);
        f.put(i, this.wx, this.wy, this.wz, 0.3 * pulse, 0.09 * pulse, 0.16 * pulse, 1, 0.15, CELL.glow, 0);
      } else {
        const sn = Math.sin(t * 1.8 + p.seed * 20);
        if (sn <= 0) { p.b = -1; f.hide(i); continue; }
        if (p.b < 0) p.b = rnd() * TAU;
        const fl = Math.pow(sn, 10);
        this.lw(Math.cos(p.b) * 0.13, 0.08 + 0.15 * hash(p.a + 2), Math.sin(p.b) * 0.13);
        f.put(i, this.wx, this.wy, this.wz, 2.2, 1.5, 1.8, fl, 0.08 * (0.3 + 0.7 * fl), CELL.star, t + p.seed * 5);
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.f.dispose();
    this.cloud?.dispose();
    this.rib?.dispose();
  }
}

// A monotonically increasing update tick (one per UnusualEffect.update call —
// used only to group per-frame render callbacks) and a wall clock.
let frameTick = 0;


// Map an economy effect id (items/types.ts UNUSUAL_EFFECTS, e.g. 'fx.storm') to
// the renderer kind for `new UnusualEffect(kind)`; null when the id is unknown
// or has no renderer.
export function unusualKindForEffect(effectId: string | null | undefined): EffectKind | null {
  if (!effectId) return null;
  const e = UNUSUAL_EFFECTS.find((u) => u.id === effectId);
  if (!e) return null;
  return e.kind in LAYOUTS ? (e.kind as EffectKind) : null;
}

// Whether the effect id may be worn on an emote (UnusualEffect taunt variant).
export function isTauntEffect(effectId: string | null | undefined): boolean {
  return !!UNUSUAL_EFFECTS.find((u) => u.id === effectId)?.taunt;
}
