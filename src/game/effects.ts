import * as THREE from 'three';
import type { KillEffectStyle, SpawnEffectStyle } from './cosmetics';
import {
  disposeFxContext,
  flashTexture,
  getFxContext,
  peekFxContext,
  getFxQuality,
  glowTexture,
  ringTexture,
  setFxQuality,
  type FxContext,
  type FxPool,
} from './fx-pool';
import { liveViewmodelMuzzle } from './fx/rail-state';
import { FINISHER_TIMING, findDeath } from './fx/fx-settings';
import type { AABB } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Burst recipes on top of the shared per-scene FX pool (see fx-pool.ts). No
// geometry or material is created here — every primitive claims an instance
// slot from the pool, so a burst is allocation-free and draws in 2-3 calls.
// The kill / spawn styles keep their original numbers; growth is expressed as
// a frame-rate-independent exponential that matches the old per-frame
// multiply at 60 fps, and the fades are baked into instance colour.
// ─────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
// Rings lie flat in the horizontal plane: the torus's +Z axis → world +Y.
const FLAT = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, UP);

// Brightness gains on top of the style colours — additive cores go well past
// 1.0 in linear space so a threshold bloom picks them out. Modest enough that
// the LDR look stays the same tint; only the first ~40 % of a flash's life
// saturates whiter.
const CORE_GAIN = 1.6;
const RING_GAIN = 1.25;
const MOTE_GAIN = 1.15;

// The old per-frame `scale *= 1 + g·dt` at 60 fps equals e^{k·t} with this k.
const growRate = (g: number) => 60 * Math.log(1 + g / 60);

const tmpQ = new THREE.Quaternion();
const tmpN = new THREE.Vector3();
const tmpDirV = new THREE.Vector3();

// ── Primitives ──────────────────────────────────────────────────────────────

// Energy flash: a soft camera-facing glow (not a solid ball) that grows as it
// fades. `radius`/`grow` keep the old sphere's numbers: the sprite covers the
// same footprint and ends at the same size the sphere grew to.
function flash(ctx: FxContext, x: number, y: number, z: number, color: number, radius: number, life: number, grow: number, fadePow: number) {
  const g = Math.exp(growRate(grow) * life);
  sprite(ctx, glowTexture(), x, y, z, radius * 3.2, 1 - g, life, fadePow, color, CORE_GAIN * 1.5, false);
}

function ring(pool: FxPool, x: number, y: number, z: number, color: number, r: number, tube: number, life: number, grow: number, fadePow: number, quat: THREE.Quaternion = FLAT) {
  const p = pool.alloc(tube / r < 0.15 ? 'torusThin' : 'torus');
  if (!p) return;
  p.x = x; p.y = y; p.z = z;
  p.setScale(r);
  p.setQuaternion(quat);
  p.life = life;
  p.grow = growRate(grow);
  p.fadePow = fadePow;
  p.setColor(color, RING_GAIN);
}

// A vertical light column rising from `y`, additive + tapered.
function column(pool: FxPool, x: number, y: number, z: number, color: number, radius: number, height: number, life: number, grow: number, fadePow: number) {
  const p = pool.alloc('column');
  if (!p) return;
  p.x = x; p.y = y + height / 2; p.z = z;
  p.setScale(radius, height, radius);
  p.life = life;
  p.grow = growRate(grow);
  p.fadePow = fadePow;
  p.setColor(color, RING_GAIN);
}

type SprayOpts = {
  count: number;
  y: number; // origin offset above `y`
  radial: [number, number]; // base + random horizontal speed
  up: [number, number]; // base + random vertical speed
  size: number;
  life: number;
  gravity: number;
  fadePow: number;
};

// Radial mote spray: `count` (thinned by quality) icosahedron motes flung out
// and up from a point above the origin.
function spray(pool: FxPool, x: number, y: number, z: number, color: number, o: SprayOpts) {
  const count = Math.max(2, Math.round(o.count * getFxQuality()));
  for (let i = 0; i < count; i++) {
    const p = pool.alloc('ico');
    if (!p) return;
    p.x = x; p.y = y + o.y; p.z = z;
    p.setScale(o.size);
    const theta = Math.random() * TWO_PI;
    const radial = o.radial[0] + Math.random() * o.radial[1];
    p.vx = Math.cos(theta) * radial;
    p.vy = o.up[0] + Math.random() * o.up[1];
    p.vz = Math.sin(theta) * radial;
    p.gravity = o.gravity;
    p.life = o.life;
    p.fadePow = o.fadePow;
    p.setColor(color, MOTE_GAIN);
  }
}

// ── Kill styles ─────────────────────────────────────────────────────────────
// A punchy pop at the kill that confirms the frag without blocking the view.
// The STYLE is the killer's finisher (cosmetics.ts) — Ratz-Instagib flavoured:
// vivid additive energy, and for the default-ish styles it's in the VICTIM's
// colour (`tint`). The victim's own death animation (character/gibs.ts)
// carries the body — chunks, voxels, shards, confetti, ash — so these add
// the flash, the shock fronts and the signature element on top. Headshots
// swap the accent to amber. Budget: the bright part is gone in ≤ 0.15 s and
// everything by ~0.6 s, so it never hangs over the crosshair line.

const AMBER = new THREE.Color(1.0, 0.62, 0.12);
const kTint = new THREE.Color(); // the burst's key colour (victim / style)
const pendingTint = new THREE.Color();
const kHot = new THREE.Color(); // key pushed toward white — flashes, cores
const kAcc = new THREE.Color(); // accent: key, or amber on a headshot
const kTmp = new THREE.Color();
const kTmp2 = new THREE.Color();
const kHsTmp = new THREE.Color();
const kDir = new THREE.Vector3();
let kIsHs = false; // the current burst is a headshot

// Shared kill punctuation: a short world-light pop at the burst so the frag
// lights up the surroundings for a beat (full-quality tier only).
function killLight(ctx: FxContext, at: THREE.Vector3, color: THREE.Color, peak = 8) {
  ctx.lights.pulse(1, at.x, at.y + 0.2, at.z, color.getHex(), peak, 0.12, 7);
}

// Camera-facing flash from the sprite pool. `shrink` < 0 grows over the life.
function sprite(
  ctx: FxContext, map: THREE.Texture, x: number, y: number, z: number,
  size: number, shrink: number, life: number, fadePow: number,
  color: number, gain: number, flicker: boolean,
) {
  tmpColor.setHex(color);
  spriteC(ctx, map, x, y, z, size, shrink, life, fadePow, tmpColor, gain, flicker);
}

function spriteC(
  ctx: FxContext, map: THREE.Texture, x: number, y: number, z: number,
  size: number, shrink: number, life: number, fadePow: number,
  c: THREE.Color, gain: number, flicker = false, delay = 0,
) {
  const s = ctx.sprites.alloc(map);
  s.sprite.position.set(x, y, z);
  s.base = size;
  s.shrink = shrink;
  s.life = life;
  s.fadePow = fadePow;
  s.flicker = flicker;
  s.delay = delay;
  s.r = c.r * gain;
  s.g = c.g * gain;
  s.b = c.b * gain;
  ctx.sprites.finish(s);
}

// Flat expanding ring (a torus in the horizontal plane). Seen from eye level
// it reads as a horizontal scan line; from above as a shockwave.
function ringC(pool: FxPool, x: number, y: number, z: number, c: THREE.Color, gain: number, r: number, thin: boolean, life: number, grow: number, fadePow: number, delay = 0) {
  const p = pool.alloc(thin ? 'torusThin' : 'torus');
  if (!p) return;
  p.x = x; p.y = y; p.z = z;
  p.setScale(r);
  p.setQuaternion(FLAT);
  p.life = life;
  p.grow = growRate(grow);
  p.fadePow = fadePow;
  p.delay = delay;
  p.setRGB(c.r * gain, c.g * gain, c.b * gain);
}

// Streaks flung from a point: `count` thin boxes aligned to their flight.
function streaks(pool: FxPool, x: number, y: number, z: number, count: number, speed: number, speedR: number, upBias: number, gravity: number, drag: number, len: number, life: number, a: THREE.Color, b: THREE.Color, gain: number, delay = 0) {
  const n = Math.max(3, Math.round(count * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    const u = Math.random() * 2 - 1 + upBias;
    const uc = Math.max(-1, Math.min(1, u));
    const phi = Math.random() * TWO_PI;
    const sq = Math.sqrt(Math.max(0, 1 - uc * uc));
    const sp = speed + Math.random() * speedR;
    p.x = x; p.y = y; p.z = z;
    p.setScale(0.024, 0.024, len * (0.7 + Math.random() * 0.6));
    p.align = true;
    p.vx = Math.cos(phi) * sq * sp;
    p.vy = uc * sp;
    p.vz = Math.sin(phi) * sq * sp;
    p.gravity = gravity;
    p.drag = drag;
    p.life = life * (0.75 + Math.random() * 0.5);
    p.fadePow = 1.4;
    p.delay = delay;
    const c = i % 3 === 0 ? b : a;
    p.setRGB(c.r * gain, c.g * gain, c.b * gain);
  }
}

// Soft billboard motes.
function motes(pool: FxPool, x: number, y: number, z: number, count: number, radial: number, radialR: number, up: number, upR: number, gravity: number, drag: number, size: number, life: number, c: THREE.Color, gain: number, delay = 0) {
  const n = Math.max(2, Math.round(count * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('mote');
    if (!p) break;
    const a = Math.random() * TWO_PI;
    const r = radial + Math.random() * radialR;
    p.x = x; p.y = y; p.z = z;
    p.vx = Math.cos(a) * r;
    p.vy = up + Math.random() * upR;
    p.vz = Math.sin(a) * r;
    p.gravity = gravity;
    p.drag = drag;
    p.setScale(size * (0.7 + Math.random() * 0.6));
    p.life = life * (0.8 + Math.random() * 0.4);
    p.fadePow = 1.2;
    p.delay = delay;
    p.setRGB(c.r * gain, c.g * gain, c.b * gain);
  }
}

// Star glints scattered around a point, popping in over `spread` seconds.
function glints(pool: FxPool, x: number, y: number, z: number, count: number, radius: number, spread: number, c: THREE.Color, gain: number, delay = 0) {
  const n = Math.max(1, Math.round(count * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('glint');
    if (!p) break;
    const u = Math.random() * 2 - 1, a = Math.random() * TWO_PI, sq = Math.sqrt(1 - u * u);
    const r = radius * (0.4 + Math.random() * 0.6);
    p.x = x + Math.cos(a) * sq * r; p.y = y + u * r * 0.8; p.z = z + Math.sin(a) * sq * r;
    p.setScale(0.26 + Math.random() * 0.14);
    p.rot = Math.random() * TWO_PI;
    p.spin = (Math.random() - 0.5) * 4;
    p.life = 0.13;
    p.fadePow = 1.4;
    p.delay = delay + Math.random() * spread;
    p.setRGB(c.r * gain, c.g * gain, c.b * gain);
  }
}

// Pulse (default): an instagib energy detonation in the victim's colour — a
// hot flash behind a crisp star, a spherical shock front, a shockwave across
// the floor, a hard spray of spark streaks and a few slow energy motes.
function killPulse(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.1;
  // Sized like the paid styles (fairness: the free default must not hide the
  // kill spot longer or wider than a cosmetic one).
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.1, -0.25, 0.13, 1.6, kHot, 1.9);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.8, 0.25, 0.09, 1.5, kHot, 2.3, true);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.4, -3.4, 0.28, 1.4, kAcc, 2.0);
  ringC(pool, at.x, at.y - 0.85, at.z, kAcc, RING_GAIN, 0.3, true, 0.36, 6.5, 1.3);
  streaks(pool, at.x, cy, at.z, 24, 5.5, 6.5, 0.2, 14, 0, 0.3, 0.42, kHot, kAcc, 2.0);
  motes(pool, at.x, cy, at.z, 8, 0.8, 1.6, 0.5, 2, 3, 0, 0.12, 0.55, kAcc, 1.6);
  killLight(ctx, at, kAcc, 9);
}

// Nova: a big soft bloom in the victim's colour with twin shock shells.
function killNova(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.3;
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.3, -0.55, 0.2, 1.5, kTint, 1.7);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.7, 0.3, 0.08, 1.5, kHot, 2.2, true);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.3, -5.5, 0.32, 1.3, kAcc, 1.9);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.25, -4.5, 0.36, 1.5, kHot, 1.3, false, 0.06);
  glints(pool, at.x, cy, at.z, 6, 1.1, 0.18, kHot, 2.4, 0.04);
  killLight(ctx, at, kAcc, 8);
}

// Starburst: a radial star of light spikes fired outward that stop dead,
// with glints popping at their tips.
function killStarburst(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.35;
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 1.25, 0.3, 0.1, 1.6, kHot, 2.5, true);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.8, -0.2, 0.12, 1.6, kTint, 1.6);
  const n = Math.max(8, Math.round(16 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    // Fibonacci-sphere directions, flattened a little: a star, not a fuzzball.
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.39996;
    kDir.set(Math.cos(th) * r, y * 0.6, Math.sin(th) * r).normalize();
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.035, 0.035, 0.62);
    p.align = true;
    const sp = 10;
    p.vx = kDir.x * sp; p.vy = kDir.y * sp; p.vz = kDir.z * sp;
    p.drag = 7;
    p.life = 0.3;
    p.fadePow = 1.6;
    const c = i % 2 === 0 ? kHot : kAcc;
    p.setRGB(c.r * 2.1, c.g * 2.1, c.b * 2.1);
    if (i % 2 === 0) {
      const g = pool.alloc('glint');
      if (g) {
        g.x = at.x + kDir.x * 1.35; g.y = cy + kDir.y * 1.35; g.z = at.z + kDir.z * 1.35;
        g.setScale(0.32);
        g.rot = Math.random() * TWO_PI;
        g.life = 0.12;
        g.delay = 0.1 + Math.random() * 0.06;
        g.fadePow = 1.4;
        g.setRGB(kHot.r * 2.6, kHot.g * 2.6, kHot.b * 2.6);
      }
    }
  }
  killLight(ctx, at, kAcc, 6);
}

// Voxel: a blocky flash and an expanding square ring of glowing pixels (the
// body itself breaks into voxel cubes — gibs.ts).
function killVoxel(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.3;
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.9, -0.2, 0.1, 1.7, kHot, 1.8);
  const n = Math.max(8, Math.round(20 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    const a = (i / n) * TWO_PI;
    // A square ring: push directions onto the unit square's edge.
    const cx = Math.cos(a), cz = Math.sin(a);
    const m = Math.max(Math.abs(cx), Math.abs(cz));
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.07);
    p.vx = (cx / m) * 4.2; p.vy = 0; p.vz = (cz / m) * 4.2;
    p.drag = 3;
    p.life = 0.34;
    p.fadePow = 1.3;
    const c = i % 4 === 0 ? kHot : kAcc;
    p.setRGB(c.r * 2, c.g * 2, c.b * 2);
  }
  motes(pool, at.x, cy, at.z, 6, 0.6, 1.2, 1, 2, 4, 0, 0.1, 0.4, kAcc, 1.4);
  killLight(ctx, at, kAcc, 6);
}

// Pyre: a rising column of fire, a ground fire ring and a spray of embers
// (the body burns and crumbles — gibs.ts).
function killEmber(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const core = kTmp.setRGB(1.0, 0.55, 0.16);
  spriteC(ctx, glowTexture(), at.x, at.y + 0.3, at.z, 1.0, -0.2, 0.15, 1.7, core, 1.8);
  const col = pool.alloc('cone');
  if (col) {
    col.x = at.x; col.y = at.y + 0.7; col.z = at.z;
    col.setScale(0.18, 1.0, 0.18);
    col.vy = 1.6;
    col.life = 0.32;
    col.grow = growRate(1.6);
    col.fadePow = 1.6;
    col.setRGB(core.r * 1.5, core.g * 1.5, core.b * 1.5);
  }
  ringC(pool, at.x, at.y - 0.85, at.z, kHs(core), 1.4, 0.25, true, 0.4, 5, 1.3);
  motes(pool, at.x, at.y - 0.3, at.z, 18, 0.3, 1.0, 3, 3.5, 1.5, 1.4, 0.09, 0.7, kTmp2.setRGB(2.2, 1.0, 0.25), 1);
  killLight(ctx, at, core, 8);
}

// Gibstorm: a heavier, more violent pulse — bigger flash, a shock shell and
// a dense spray of hot shards that rains down hard.
function killGibstorm(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.35;
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.3, -0.3, 0.14, 1.6, kHot, 2.0);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.9, 0.25, 0.09, 1.5, kHot, 2.4, true);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.4, -4.0, 0.3, 1.3, kAcc, 2.0);
  const n = Math.max(8, Math.round(26 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('ico');
    if (!p) break;
    const a = Math.random() * TWO_PI, rad = 2.2 + Math.random() * 2.4;
    p.x = at.x; p.y = cy + 0.2; p.z = at.z;
    p.setScale(0.05 + Math.random() * 0.03);
    p.vx = Math.cos(a) * rad; p.vy = 5 + Math.random() * 3.5; p.vz = Math.sin(a) * rad;
    p.gravity = 14;
    p.life = 0.7;
    p.fadePow = 1.0;
    if (i % 2 === 0) p.setRGB(kAcc.r * 1.4, kAcc.g * 1.4, kAcc.b * 1.4);
    else p.setRGB(2.2, 0.9, 0.25);
  }
  streaks(pool, at.x, cy, at.z, 14, 6, 6, 0.3, 16, 0, 0.3, 0.45, kHot, kAcc, 2.0);
  killLight(ctx, at, kAcc, 9);
}

// Singularity: a ring collapses inward to a point over the pull (the body
// spirals in — gibs.ts), then a white-hot core detonates with twin shells.
function killSingularity(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const POP = FINISHER_TIMING.singularityPop;
  const cy = at.y + 0.38;
  const halo = kTmp.setRGB(0.45, 0.35, 1.0);
  if (kIsHs) halo.copy(AMBER);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 2.0, 0.92, POP, 0.5, halo, 1.7);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.2, -2.5, POP, 0.3, halo, 1.4);
  // The pop.
  const white = kTmp2.setRGB(1, 0.97, 1);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.0, -0.35, 0.12, 1.7, white, 2.0, false, POP);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 1.0, 0.25, 0.09, 1.5, white, 2.5, true, POP);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.3, -5.5, 0.3, 1.3, white, 1.8, false, POP);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.25, -4.2, 0.34, 1.5, halo, 1.8, false, POP + 0.04);
  motes(pool, at.x, cy, at.z, 10, 2.4, 1.6, 1.5, 2.5, 6, 0, 0.1, 0.4, white, 2.0, POP);
}

// Prism: a white flash split into chromatic (R/G/B) shock rings, rainbow
// spikes and rainbow motes.
function killPrism(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.35;
  const white = kTmp.setRGB(1, 1, 1);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.1, -0.3, 0.12, 1.7, white, 1.9);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.9, 0.25, 0.08, 1.5, white, 2.4, true);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.34, -3.6, 0.3, 1.4, kTmp2.setRGB(1, 0.12, 0.2), 2.2);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.38, -3.35, 0.3, 1.4, kTmp2.setRGB(0.15, 1, 0.25), 2.0, false, 0.02);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.42, -3.1, 0.3, 1.4, kTmp2.setRGB(0.2, 0.35, 1), 2.4, false, 0.04);
  const n = Math.max(6, Math.round(14 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.39996;
    kDir.set(Math.cos(th) * r, y * 0.7, Math.sin(th) * r).normalize();
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.03, 0.03, 0.45);
    p.align = true;
    p.vx = kDir.x * 8; p.vy = kDir.y * 8; p.vz = kDir.z * 8;
    p.drag = 4;
    p.life = 0.34;
    p.fadePow = 1.5;
    kTmp2.setHSL(i / n, 1, 0.55);
    p.setRGB(kTmp2.r * 2.3, kTmp2.g * 2.3, kTmp2.b * 2.3);
  }
  killLight(ctx, at, white, 8);
}

// Derez: three horizontal scan rings sweep out from the body (at eye level
// they read as bright scan lines) plus a short pixel spray.
function killDerez(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  spriteC(ctx, glowTexture(), at.x, at.y + 0.3, at.z, 0.8, -0.2, 0.09, 1.7, kHot, 1.6);
  for (let k = 0; k < 3; k++) {
    ringC(pool, at.x, at.y - 0.55 + k * 0.6, at.z, kAcc, 1.7, 0.3, true, 0.3, 5.5, 1.4, k * 0.05);
  }
  const n = Math.max(4, Math.round(10 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    const a = Math.random() * TWO_PI, r = 1.5 + Math.random() * 2;
    p.x = at.x; p.y = at.y + (Math.random() - 0.3) * 1.2; p.z = at.z;
    p.setScale(0.04);
    p.vx = Math.cos(a) * r; p.vy = 0; p.vz = Math.sin(a) * r;
    p.drag = 3;
    p.life = 0.35;
    p.setRGB(kAcc.r * 2, kAcc.g * 2, kAcc.b * 2);
  }
  killLight(ctx, at, kAcc, 6);
}

// Glass Jaw: an icy star flash, a crisp shock ring and glints popping in the
// air (the body freezes to glass and shatters — gibs.ts).
function killShatter(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.35;
  const ice = kTmp.copy(kTint).lerp(kTmp2.setRGB(0.75, 0.9, 1), 0.6);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 1.0, 0.3, 0.08, 1.5, kTmp2.setRGB(1, 1, 1), 2.4, true);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.8, -0.2, 0.1, 1.7, ice, 1.5);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.35, -3.2, 0.24, 1.6, kIsHs ? AMBER : ice, 2.0, false, 0.05);
  glints(pool, at.x, cy, at.z, 8, 1.0, 0.3, kTmp2.setRGB(1, 1, 1), 2.6, 0.06);
  killLight(ctx, at, ice, 6);
}

// Party Foul: a pop, two candy-coloured rings and sparkles (the confetti
// itself comes out of the body — gibs.ts).
function killConfetti(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.4;
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.9, -0.25, 0.09, 1.7, kTmp.setRGB(1, 0.95, 0.9), 1.9);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.6, 0.3, 0.07, 1.5, kTmp, 2.2, true);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.3, -3.6, 0.26, 1.4, kIsHs ? AMBER : kTmp2.setRGB(1, 0.2, 0.6), 1.9);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.25, -3.0, 0.28, 1.4, kTmp2.setRGB(0.15, 0.85, 1), 1.9, false, 0.05);
  const n = Math.max(4, Math.round(10 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('glint');
    if (!p) break;
    const a = Math.random() * TWO_PI, u = Math.random();
    p.x = at.x + Math.cos(a) * (0.4 + u); p.y = cy + 0.2 + Math.random() * 1.2; p.z = at.z + Math.sin(a) * (0.4 + u);
    p.setScale(0.24);
    p.rot = Math.random() * TWO_PI;
    p.life = 0.14;
    p.delay = 0.05 + Math.random() * 0.3;
    kTmp2.setHSL(Math.random(), 1, 0.65);
    p.setRGB(kTmp2.r * 2.6, kTmp2.g * 2.6, kTmp2.b * 2.6);
  }
  killLight(ctx, at, kTmp.setRGB(1, 0.6, 0.85), 6);
}

// Overload: blue-white arcs lash out from the body while it's held, then a
// delayed blast — flash, star and twin shells (the twitching + armour arcs
// are the body's — gibs.ts).
function killOverload(ctx: FxContext, at: THREE.Vector3) {
  const T = FINISHER_TIMING.overloadBlast;
  const cy = at.y + 0.3;
  const blue = kTmp.setRGB(0.55, 0.75, 1.0);
  if (kIsHs) blue.copy(AMBER);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 0.6, 0, 0.07, 1.6, blue, 1.6);
  const arcs = ctx.arcs;
  const n = Math.max(3, Math.round(8 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TWO_PI;
    const y0 = at.y - 0.5 + Math.random() * 1.3;
    const r = 0.6 + Math.random() * 0.5;
    arcs.spawn(
      at.x + Math.cos(a) * 0.15, y0, at.z + Math.sin(a) * 0.15,
      at.x + Math.cos(a) * r, y0 + (Math.random() - 0.3) * 0.5, at.z + Math.sin(a) * r,
      blue.r * 3, blue.g * 3, blue.b * 3, 0.03, 0.08, 0.14, (i / n) * (T - 0.06), 30,
    );
  }
  const white = kTmp2.setRGB(0.85, 0.93, 1);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.1, -0.3, 0.13, 1.6, white, 1.9, false, T);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 1.0, 0.25, 0.09, 1.5, white, 2.5, true, T);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.4, -4.4, 0.3, 1.3, blue, 2.2, false, T);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.3, -3.4, 0.34, 1.5, white, 1.4, false, T + 0.05);
}

// Vaporize: a white-hot flash and a heat shell (the body flash-burns to ash
// and blows away — gibs.ts).
function killVaporize(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const cy = at.y + 0.3;
  const warm = kTmp.setRGB(1, 0.92, 0.78);
  spriteC(ctx, glowTexture(), at.x, cy, at.z, 1.3, -0.3, 0.12, 1.7, warm, 2.1);
  spriteC(ctx, flashTexture(), at.x, cy, at.z, 0.9, 0.3, 0.08, 1.5, warm, 2.4, true);
  const heat = kTmp2.setRGB(1, 0.42, 0.1);
  spriteC(ctx, ringTexture(), at.x, cy, at.z, 0.35, -3.6, 0.3, 1.4, kIsHs ? AMBER : heat, 1.8, false, 0.03);
  motes(pool, at.x, cy, at.z, 10, 0.3, 0.9, 0.8, 1.6, -0.5, 1.2, 0.08, 0.7, heat, 2.0, 0.05);
  killLight(ctx, at, warm, 9);
}

// Amber on a headshot, else `c`.
function kHs(c: THREE.Color): THREE.Color {
  return kIsHs ? kHsTmp.copy(AMBER) : c;
}

// Style key colours used when no victim tint is given.
const STYLE_KEY: Partial<Record<KillEffectStyle, number>> = {
  pulse: 0x3fb4ff, nova: 0x9fdcff, starburst: 0x8ad8ff, voxel: 0x7fe6ff, gibstorm: 0xff7a55,
  derez: 0x39d8ff, shatter: 0xbfe6ff,
};

function setKillPalette(style: KillEffectStyle, headshot: boolean, tint: THREE.Color | number | null | undefined) {
  kIsHs = headshot;
  if (tint instanceof THREE.Color) kTint.copy(tint);
  else if (typeof tint === 'number') kTint.setHex(tint);
  else kTint.setHex(STYLE_KEY[style] ?? 0x3fb4ff);
  // Keep the key saturated but never too dark to glow: lift its peak to 1.
  const peak = Math.max(kTint.r, kTint.g, kTint.b, 1e-3);
  kTint.multiplyScalar(1 / peak);
  kHot.copy(kTint).lerp(kTmp.setRGB(1, 1, 1), 0.6);
  if (headshot) {
    kAcc.copy(AMBER);
    kHot.setRGB(1, 0.94, 0.78);
  } else kAcc.copy(kTint);
}

// ── Spawn-in styles ─────────────────────────────────────────────────────────
// A materialize burst at a (re)spawn point. `at` is the player's FEET.

// Teleport: a tall light column + an expanding ground ring + rising motes.
function spawnBeamIn(ctx: FxContext, at: THREE.Vector3, fp: boolean) {
  const pool = ctx.pool;
  const hot = 0xa8f0ff;
  const col = 0x37a6ff;
  ring(pool, at.x, at.y + 0.05, at.z, col, 0.2, 0.045, 0.42, 7, 1.3);
  if (fp) return; // first person: rising column/flash/motes would pass through the camera
  column(pool, at.x, at.y, at.z, hot, 0.16, 2.2, 0.4, 1.0, 1.6);
  flash(ctx, at.x, at.y + 0.9, at.z, hot, 0.22, 0.22, 4, 1.8);
  spray(pool, at.x, at.y, at.z, hot, { count: 12, y: 0.1, radial: [0.5, 0.6], up: [4.5, 2.5], size: 0.05, life: 0.5, gravity: 5, fadePow: 1.2 });
}

// Shockwave: a hard double ground ring + a bright ground flash. Low + wide.
function spawnRing(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const hot = 0xbfeaff;
  const by = at.y + 0.06;
  ring(pool, at.x, by, at.z, hot, 0.18, 0.05, 0.36, 13, 1.3);
  ring(pool, at.x, by, at.z, hot, 0.1, 0.03, 0.46, 9, 1.5);
  flash(ctx, at.x, by, at.z, hot, 0.2, 0.2, 6, 1.8);
  spray(pool, at.x, at.y, at.z, 0x8ad8ff, { count: 10, y: 0.08, radial: [2.2, 1.4], up: [1.5, 1.5], size: 0.05, life: 0.4, gravity: 7, fadePow: 1.2 });
}

// Cinder: a warm column + a dense cone of rising embers.
function spawnEmberIn(ctx: FxContext, at: THREE.Vector3, fp: boolean) {
  const pool = ctx.pool;
  const core = 0xffb15a;
  const spark = 0xff7b3a;
  if (fp) {
    ring(pool, at.x, at.y + 0.05, at.z, spark, 0.18, 0.04, 0.4, 7, 1.3);
    return; // first person: no column / rising embers through the camera
  }
  column(pool, at.x, at.y, at.z, core, 0.13, 1.8, 0.36, 0.8, 1.7);
  flash(ctx, at.x, at.y + 0.2, at.z, core, 0.2, 0.2, 4, 1.8);
  spray(pool, at.x, at.y, at.z, spark, { count: 18, y: 0.1, radial: [0.3, 0.9], up: [3.5, 3.5], size: 0.045, life: 0.7, gravity: 7, fadePow: 1.1 });
}

// Rift: a violet vertical tear that flares, with motes drawn inward then out.
function spawnRift(ctx: FxContext, at: THREE.Vector3, fp: boolean) {
  const pool = ctx.pool;
  const core = 0xe9d5ff;
  const halo = 0xa855f7;
  // A thin tall slab (the tear) that widens and fades.
  const slab = fp ? null : pool.alloc('box');
  if (fp) {
    ring(pool, at.x, at.y + 0.05, at.z, halo, 0.16, 0.04, 0.4, 8, 1.3);
    return; // first person: no tear slab / motes through the camera
  }
  if (slab) {
    slab.x = at.x; slab.y = at.y + 1.05; slab.z = at.z;
    slab.setScale(0.08, 2.1, 0.08);
    slab.life = 0.34;
    slab.grow = growRate(2.2);
    slab.fadePow = 1.7;
    slab.setColor(core, CORE_GAIN);
  }
  ring(pool, at.x, at.y + 0.05, at.z, halo, 0.16, 0.04, 0.4, 8, 1.3);
  // Infalling motes converging on the tear, then released upward by the flare.
  const n = 9;
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('ico');
    if (!p) break;
    const theta = (i / n) * TWO_PI;
    const dx = Math.cos(theta);
    const dz = Math.sin(theta);
    p.x = at.x + dx * 0.7; p.y = at.y + 0.9; p.z = at.z + dz * 0.7;
    p.setScale(0.05);
    p.vx = dx * -2.0; p.vy = 1.5; p.vz = dz * -2.0;
    p.gravity = -2;
    p.life = 0.4;
    p.fadePow = 1.0;
    p.setColor(halo, MOTE_GAIN);
  }
  flash(ctx, at.x, at.y + 0.95, at.z, core, 0.18, 0.28, 6, 2.0);
}

// ── Weapon flashes ──────────────────────────────────────────────────────────

const tmpMuzzle = new THREE.Vector3();

// Muzzle discharge: a rail DISCHARGE, not a firearm — a crisp star flare that
// flickers for two frames, a thin shock ring blown out along the beam, a few
// short energy streaks jetting down the bore line, and a ≤ 60 ms light pulse.
// For the local shot the first-person viewmodel carries its own flare on the
// barrel, so here the world part moves to that real muzzle and stays small.
function muzzleFlash(ctx: FxContext, at: THREE.Vector3, color: number, dir: THREE.Vector3 | undefined, ownShot: boolean) {
  let x = at.x, y = at.y, z = at.z;
  // Only the local player's own shot snaps to the viewmodel barrel (an enemy
  // firing from 1–2 m away used to have its flash drawn on your gun).
  const own = ownShot && liveViewmodelMuzzle(tmpMuzzle);
  if (own) {
    x = tmpMuzzle.x; y = tmpMuzzle.y; z = tmpMuzzle.z;
  }
  sprite(ctx, flashTexture(), x, y, z, own ? 0.14 : 0.3, 0.35, 0.075, 1.6, color, 2.0, true);
  const hasDir = !!dir && dir.lengthSq() > 1e-6;
  if (hasDir) {
    tmpN.copy(dir!).normalize();
    // Shock ring perpendicular to the beam, punched a little way out.
    const p = ctx.pool.alloc('ring');
    if (p) {
      p.x = x + tmpN.x * 0.06; p.y = y + tmpN.y * 0.06; p.z = z + tmpN.z * 0.06;
      tmpQ.setFromUnitVectors(Z_AXIS, tmpN);
      p.setQuaternion(tmpQ);
      p.setScale(own ? 0.06 : 0.08);
      p.grow = 12;
      p.life = 0.11;
      p.fadePow = 1.4;
      p.setColor(color, 1.3);
    }
    // Short streaks jetting forward in a tight cone.
    const n = Math.max(2, Math.round(5 * getFxQuality()));
    for (let i = 0; i < n; i++) {
      const s = ctx.pool.alloc('box');
      if (!s) break;
      const sx = (Math.random() - 0.5) * 0.5, sy = (Math.random() - 0.5) * 0.5, sz = (Math.random() - 0.5) * 0.5;
      tmpDirV.set(tmpN.x + sx, tmpN.y + sy, tmpN.z + sz).normalize();
      const speed = 7 + Math.random() * 6;
      s.x = x; s.y = y; s.z = z;
      s.setScale(0.008, 0.008, 0.16 + Math.random() * 0.1);
      s.align = true;
      s.vx = tmpDirV.x * speed; s.vy = tmpDirV.y * speed; s.vz = tmpDirV.z * speed;
      s.life = 0.06 + Math.random() * 0.04;
      s.fadePow = 1.2;
      s.setColor(color, 2.0);
    }
  } else {
    // No beam direction known (replay / preview): a camera-facing ring instead.
    sprite(ctx, ringTexture(), x, y, z, 0.08, -2.8, 0.11, 1.4, color, 1.3, false);
  }
  ctx.lights.pulse(0, x, y, z, color, 3, 0.06, 4);
}

const tmpColor = new THREE.Color();

// World impact of a rail beam at `point` on a face with unit `normal`, the beam
// travelling along unit `dir`: a white-hot star + soft bloom off the face, a
// fast shock ring on the surface plane, a hard spray of spark streaks flung
// back off the face under gravity, a few falling embers, a ~1 m scorch decal
// (glowing rim that cools to a dark burn; clipped to `faceBox`, the struck
// box, when given) and a short light pulse. Called by weapon.ts for every
// beam that ends on the map (never for beams that stop on a player).
export function spawnRailImpact(
  scene: THREE.Scene,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  dir: THREE.Vector3,
  core: number,
  helix: number,
  faceBox?: AABB,
) {
  const ctx = getFxContext(scene);
  const pool = ctx.pool;
  const nx = normal.x, ny = normal.y, nz = normal.z;
  const px = point.x + nx * 0.02, py = point.y + ny * 0.02, pz = point.z + nz * 0.02;

  // Flash: the star sits just off the face, the soft bloom further out so the
  // wall doesn't cut it in half.
  sprite(ctx, flashTexture(), point.x + nx * 0.12, point.y + ny * 0.12, point.z + nz * 0.12, 0.6, 0.3, 0.09, 1.5, core, 2.6, true);
  sprite(ctx, glowTexture(), point.x + nx * 0.3, point.y + ny * 0.3, point.z + nz * 0.3, 1.0, -0.2, 0.15, 1.6, helix, 1.5, false);

  const rq = pool.alloc('ring');
  if (rq) {
    rq.x = point.x + nx * 0.015; rq.y = point.y + ny * 0.015; rq.z = point.z + nz * 0.015;
    tmpQ.setFromUnitVectors(Z_AXIS, normal);
    rq.setQuaternion(tmpQ);
    rq.setScale(0.16);
    rq.grow = 11;
    rq.life = 0.2;
    rq.fadePow = 1.6;
    rq.setColor(helix, 1.6);
  }

  // Sparks leave along the face normal blended with the beam's reflection, so
  // a glancing hit skids sideways while a square hit sprays straight back.
  const dn = dir.x * nx + dir.y * ny + dir.z * nz;
  const rx = dir.x - 2 * dn * nx, ry = dir.y - 2 * dn * ny, rz = dir.z - 2 * dn * nz;
  const count = Math.max(5, Math.round(16 * getFxQuality()));
  for (let i = 0; i < count; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    p.x = px; p.y = py; p.z = pz;
    p.setScale(0.014, 0.014, 0.1 + Math.random() * 0.1);
    p.align = true;
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * TWO_PI;
    const sq = Math.sqrt(1 - u * u);
    let vx = nx + rx * 0.5 + Math.cos(phi) * sq * 0.9;
    let vy = ny + ry * 0.5 + u * 0.9 + 0.3;
    let vz = nz + rz * 0.5 + Math.sin(phi) * sq * 0.9;
    const out = vx * nx + vy * ny + vz * nz;
    if (out < 0.2) { // never fire a spark into the wall
      vx += nx * (0.2 - out); vy += ny * (0.2 - out); vz += nz * (0.2 - out);
    }
    const l = Math.hypot(vx, vy, vz) || 1;
    const speed = 3 + Math.random() * 4.5;
    p.vx = (vx / l) * speed; p.vy = (vy / l) * speed; p.vz = (vz / l) * speed;
    p.gravity = 11;
    p.life = 0.28 + Math.random() * 0.25;
    p.fadePow = 1.3;
    p.setColor(i % 3 === 0 ? helix : core, 2.0);
  }
  // Embers: a few slow, heavy motes that drop off the face.
  const embers = Math.max(1, Math.round(5 * getFxQuality()));
  for (let i = 0; i < embers; i++) {
    const p = pool.alloc('ico');
    if (!p) break;
    p.x = px; p.y = py; p.z = pz;
    p.setScale(0.018);
    const k = 0.6 + Math.random() * 1.2;
    p.vx = nx * k + (Math.random() - 0.5) * 1.2;
    p.vy = ny * k + Math.random() * 1.4;
    p.vz = nz * k + (Math.random() - 0.5) * 1.2;
    p.gravity = 9;
    p.life = 0.5 + Math.random() * 0.3;
    p.fadePow = 1.1;
    p.setColor(helix, 1.6);
  }

  if (ctx.decals.enabled) ctx.decals.place(point, normal, helix, 0.85 + Math.random() * 0.3, faceBox);
  ctx.lights.pulse(1, point.x + nx * 0.35, point.y + ny * 0.35, point.z + nz * 0.35, helix, 7, 0.11, 5);
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class EffectsManager {
  // 1 = full particle counts + decals + light pulses; 0.5 (low-spec) thins
  // sprays and turns decals / light pulses off. Shared across scenes.
  setQuality(q: number) {
    setFxQuality(q);
  }

  // Tinted sparkle at a hit on a PLAYER (or a boost-jump contact): a handful
  // of fast motes plus a small flash. Optional `normal` biases the spray off
  // the surface. Fades fast and stays small so it never obscures the view.
  spawnHitFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x99ddff, normal?: THREE.Vector3) {
    const ctx = getFxContext(scene);
    const pool = ctx.pool;
    const count = Math.max(3, Math.round(6 * getFxQuality()));
    for (let i = 0; i < count; i++) {
      const p = pool.alloc('ico');
      if (!p) break;
      p.x = at.x; p.y = at.y; p.z = at.z;
      p.setScale(0.04);
      const theta = Math.random() * TWO_PI;
      const speed = 1.8 + Math.random() * 1.2;
      p.vx = Math.cos(theta) * speed * 0.5;
      p.vy = 1.8 + Math.random() * 1.2;
      p.vz = Math.sin(theta) * speed * 0.5;
      if (normal) {
        const k = 2.2 + Math.random();
        p.vx += normal.x * k; p.vy += normal.y * k; p.vz += normal.z * k;
      }
      p.gravity = 7;
      p.life = 0.22;
      p.fadePow = 1.2;
      p.setColor(color, 1.3);
    }
    flash(ctx, at.x, at.y, at.z, color, 0.06, 0.08, 8, 2.0);
  }

  // Muzzle flash at the gun muzzle on fire. `dir` (the beam direction, any
  // length) orients the discharge ring; without it the ring faces the camera.
  spawnMuzzleFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x9fe8ff, dir?: THREE.Vector3, own = false) {
    muzzleFlash(getFxContext(scene), at, color, dir, own);
  }

  // The killer's finisher burst at `at` (the victim's body centre). `tint` =
  // the victim's colour (Character.getColor) — the default-ish styles
  // explode in it. Without a tint the burst waits one frame for the body that
  // bursts this frame near `at` (GibBurst.start → noteDeath) and adopts its
  // colour AND its rendered position (remote bodies are interpolation-
  // delayed, the kill event's victimPos is not); no body → the style's own
  // key colour at `at`.
  spawnKillBurst(
    scene: THREE.Scene,
    at: THREE.Vector3,
    headshot = false,
    style: KillEffectStyle = 'pulse',
    tint?: THREE.Color | number | null,
  ) {
    if (tint === undefined || tint === null) {
      // No victim colour given: resolve next step() against the body that
      // bursts this frame (its colour + rendered position — fx-settings).
      const q = this.pending.find((b) => !b.busy);
      if (q) {
        q.busy = true;
        q.scene = scene;
        q.at.copy(at);
        q.headshot = headshot;
        q.style = style;
        return;
      }
    }
    this.burstNow(scene, at, headshot, style, tint);
  }

  private burstNow(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean, style: KillEffectStyle, tint?: THREE.Color | number | null) {
    const ctx = getFxContext(scene);
    setKillPalette(style, headshot, tint);
    switch (style) {
      case 'nova': return killNova(ctx, at);
      case 'starburst': return killStarburst(ctx, at);
      case 'voxel': return killVoxel(ctx, at);
      case 'ember': return killEmber(ctx, at);
      case 'gibstorm': return killGibstorm(ctx, at);
      case 'singularity': return killSingularity(ctx, at);
      case 'prism': return killPrism(ctx, at);
      case 'derez': return killDerez(ctx, at);
      case 'shatter': return killShatter(ctx, at);
      case 'confetti': return killConfetti(ctx, at);
      case 'overload': return killOverload(ctx, at);
      case 'vaporize': return killVaporize(ctx, at);
      case 'pulse':
      default:
        return killPulse(ctx, at);
    }
  }

  // Bursts waiting one frame for their victim's body (see spawnKillBurst).
  private readonly pending = Array.from({ length: 8 }, () => ({
    busy: false,
    scene: null as THREE.Scene | null,
    at: new THREE.Vector3(),
    headshot: false,
    style: 'pulse' as KillEffectStyle,
  }));

  private flushPending(scene: THREE.Scene) {
    for (const q of this.pending) {
      if (!q.busy || q.scene !== scene) continue;
      q.busy = false;
      q.scene = null;
      const d = findDeath(q.at.x, q.at.y, q.at.z, 3, 250);
      if (d) {
        q.at.set(d.x, d.y, d.z);
        pendingTint.setRGB(d.r, d.g, d.b);
        this.burstNow(scene, q.at, q.headshot, q.style, pendingTint);
      } else this.burstNow(scene, q.at, q.headshot, q.style, null);
    }
  }

  // Cosmetic-only materialize burst at a (re)spawn point; `beam` is the default.
  // `firstPerson`: the LOCAL player's own spawn, seen from eye height inside
  // it — only the ground ring. The column/slab, torso flash and rising motes
  // all pass through the camera and fill the screen with translucent shapes.
  spawnInBurst(scene: THREE.Scene, at: THREE.Vector3, style: SpawnEffectStyle = 'beam', firstPerson = false) {
    const ctx = getFxContext(scene);
    switch (style) {
      case 'ring': return spawnRing(ctx, at);
      case 'ember': return spawnEmberIn(ctx, at, firstPerson);
      case 'rift': return spawnRift(ctx, at, firstPerson);
      case 'beam':
      default: return spawnBeamIn(ctx, at, firstPerson);
    }
  }

  step(dt: number, scene: THREE.Scene) {
    this.flushPending(scene);
    const ctx = getFxContext(scene);
    ctx.managed = true;
    ctx.step(dt);
  }

  // Create the scene's FX context up front (its two permanent point lights
  // included), so the first frames compile every lit material with the final
  // light count instead of re-keying them all when the first effect appears.
  warm(scene: THREE.Scene) {
    getFxContext(scene);
  }

  // Clears every live effect (map switch) but KEEPS the pooled GPU resources
  // and the point lights — removing the lights re-keys (recompiles) every lit
  // material on the next frame.
  clear(scene: THREE.Scene) {
    for (const q of this.pending) if (q.scene === scene) { q.busy = false; q.scene = null; }
    peekFxContext(scene)?.clear();
  }

  // Clears every live effect and releases the scene's pooled GPU resources
  // (teardown).
  dispose(scene: THREE.Scene) {
    for (const q of this.pending) if (q.scene === scene) { q.busy = false; q.scene = null; }
    disposeFxContext(scene);
  }
}
