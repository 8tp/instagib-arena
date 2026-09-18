import * as THREE from 'three';
import type { KillEffectStyle, SpawnEffectStyle } from './cosmetics';
import {
  disposeFxContext,
  flashTexture,
  getFxContext,
  getFxQuality,
  ringTexture,
  setFxQuality,
  type FxContext,
  type FxPool,
} from './fx-pool';

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
const tmpE = new THREE.Euler();
const tmpN = new THREE.Vector3();

// ── Primitives ──────────────────────────────────────────────────────────────

function flash(pool: FxPool, x: number, y: number, z: number, color: number, radius: number, life: number, grow: number, fadePow: number) {
  const p = pool.alloc('sphere');
  if (!p) return;
  p.x = x; p.y = y; p.z = z;
  p.setScale(radius);
  p.life = life;
  p.grow = growRate(grow);
  p.fadePow = fadePow;
  p.setColor(color, CORE_GAIN);
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
// The STYLE is a cosmetic (see cosmetics.ts) modelled on Ratz Instagib's
// selectable death animations + Quakecraft's firework "barrels" — pure visual,
// never a gameplay advantage. Headshots tint amber. Every style is additive +
// brief; `pulse` is the free default and keeps the original three-part burst.

// The original: bright flash + expanding shockwave ring + upward gib spray.
function killPulse(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const hot = headshot ? 0xffe08a : 0xa8f0ff;
  const spark = headshot ? 0xffc24d : 0xff6b8a;
  const cy = at.y + 0.3;
  flash(pool, at.x, cy, at.z, hot, 0.22, 0.16, 7, 1.8);
  ring(pool, at.x, cy, at.z, hot, 0.18, 0.04, 0.3, 9, 1.4);
  spray(pool, at.x, at.y, at.z, spark, { count: 14, y: 0.6, radial: [1.6, 1.8], up: [4.5, 3], size: 0.06, life: 0.5, gravity: 11, fadePow: 1.2 });
}

// Nova: a big energy bloom with twin shockwave rings and a light spray.
function killNova(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const hot = headshot ? 0xffe6a0 : 0x9fdcff;
  const cy = at.y + 0.4;
  flash(pool, at.x, cy, at.z, hot, 0.28, 0.2, 9, 1.6);
  ring(pool, at.x, cy, at.z, hot, 0.16, 0.05, 0.34, 14, 1.3);
  ring(pool, at.x, cy, at.z, hot, 0.1, 0.03, 0.44, 9, 1.5);
  spray(pool, at.x, at.y, at.z, hot, { count: 8, y: 0.5, radial: [1.2, 1.2], up: [2.5, 2], size: 0.05, life: 0.4, gravity: 9, fadePow: 1.2 });
}

// Starburst: a flat-ish radial star of light spikes that fire outward.
function killStarburst(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const hot = headshot ? 0xffd27a : 0x8ad8ff;
  const cy = at.y + 0.4;
  flash(pool, at.x, cy, at.z, hot, 0.18, 0.14, 6, 1.8);
  const count = 12;
  for (let i = 0; i < count; i++) {
    const p = pool.alloc('box');
    if (!p) return;
    const theta = (i / count) * TWO_PI;
    const tilt = (Math.random() - 0.5) * 0.5;
    tmpN.set(Math.cos(theta), tilt, Math.sin(theta)).normalize();
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.04, 0.04, 0.42);
    p.align = true; // the box's long (+Z) axis follows its velocity outward
    p.vx = tmpN.x * 3.6; p.vy = tmpN.y * 3.6; p.vz = tmpN.z * 3.6;
    p.life = 0.28;
    p.fadePow = 1.6;
    p.setColor(hot, RING_GAIN);
  }
}

// Voxel: shatters the target into a burst of glowing cubes (Quake/Minecraft
// homage), tumbling out and raining down.
function killVoxel(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const hot = headshot ? 0xffe08a : 0x9fe8ff;
  const tints = headshot ? [0xffd27a, 0xffba5a] : [0x7fe6ff, 0xff6b8a];
  const cy = at.y + 0.5;
  flash(pool, at.x, cy, at.z, hot, 0.2, 0.14, 6, 1.8);
  const count = Math.max(4, Math.round(16 * getFxQuality()));
  for (let i = 0; i < count; i++) {
    const p = pool.alloc('box');
    if (!p) return;
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.09);
    tmpQ.setFromEuler(tmpE.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI));
    p.setQuaternion(tmpQ);
    const theta = Math.random() * TWO_PI;
    const radial = 1.8 + Math.random() * 1.6;
    p.vx = Math.cos(theta) * radial;
    p.vy = 3.5 + Math.random() * 3;
    p.vz = Math.sin(theta) * radial;
    p.gravity = 13;
    p.life = 0.6;
    p.fadePow = 1.0;
    p.setColor(tints[i % tints.length], MOTE_GAIN);
  }
}

// Pyre: a rising column of fire with drifting embers.
function killEmber(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const core = headshot ? 0xffd27a : 0xffb15a;
  const spark = headshot ? 0xffc24d : 0xff7b3a;
  flash(pool, at.x, at.y + 0.3, at.z, core, 0.2, 0.14, 5, 1.8);
  // Column: a tapered cone that rises and widens slightly.
  const col = pool.alloc('cone');
  if (col) {
    col.x = at.x; col.y = at.y + 0.7; col.z = at.z;
    col.setScale(0.16, 0.9, 0.16);
    col.vy = 1.4;
    col.life = 0.26;
    col.grow = growRate(1.6);
    col.fadePow = 1.7;
    col.setColor(core, RING_GAIN);
  }
  // Embers: narrow cone of sparks biased strongly upward.
  spray(pool, at.x, at.y, at.z, spark, { count: 16, y: 0.3, radial: [0.5, 1.0], up: [4, 4], size: 0.05, life: 0.7, gravity: 8, fadePow: 1.1 });
}

// Gibstorm: a heavier, more violent version of pulse — bigger flash, a ring,
// and a dense spray of shards that rains down hard.
function killGibstorm(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const hot = headshot ? 0xffe08a : 0xb8f2ff;
  const spark = headshot ? 0xffc24d : 0xff5577;
  const cy = at.y + 0.4;
  flash(pool, at.x, cy, at.z, hot, 0.24, 0.16, 8, 1.7);
  ring(pool, at.x, cy, at.z, hot, 0.2, 0.05, 0.3, 11, 1.3);
  spray(pool, at.x, at.y, at.z, spark, { count: 26, y: 0.6, radial: [2.2, 2.4], up: [5, 3.5], size: 0.07, life: 0.7, gravity: 14, fadePow: 1.0 });
}

// Singularity: a ring collapses inward to a point, then a white-hot core
// detonates with an outward spark spray.
function killSingularity(pool: FxPool, at: THREE.Vector3, headshot: boolean) {
  const core = headshot ? 0xfff0c0 : 0xffffff;
  const halo = headshot ? 0xffc24d : 0x4aa8ff;
  const cy = at.y + 0.5;
  // Collapsing ring: negative grow shrinks it toward the center.
  ring(pool, at.x, cy, at.z, halo, 0.5, 0.04, 0.26, -3.2, 0.6);
  // Infalling motes converging on the point.
  const ringN = 10;
  for (let i = 0; i < ringN; i++) {
    const p = pool.alloc('ico');
    if (!p) break;
    const theta = (i / ringN) * TWO_PI;
    const dx = Math.cos(theta);
    const dz = Math.sin(theta);
    p.x = at.x + dx * 0.5; p.y = cy; p.z = at.z + dz * 0.5;
    p.setScale(0.045);
    p.vx = dx * -2.2; p.vz = dz * -2.2;
    p.life = 0.22;
    p.fadePow = 0.8;
    p.setColor(halo, MOTE_GAIN);
  }
  // Detonation core + outward spray.
  flash(pool, at.x, cy, at.z, core, 0.16, 0.3, 7, 2.2);
  spray(pool, at.x, at.y, at.z, core, { count: 10, y: 0.5, radial: [2.4, 1.6], up: [1.5, 2.5], size: 0.05, life: 0.4, gravity: 6, fadePow: 1.4 });
}

// ── Spawn-in styles ─────────────────────────────────────────────────────────
// A materialize burst at a (re)spawn point. `at` is the player's FEET.

// Teleport: a tall light column + an expanding ground ring + rising motes.
function spawnBeamIn(pool: FxPool, at: THREE.Vector3) {
  const hot = 0xa8f0ff;
  const col = 0x37a6ff;
  column(pool, at.x, at.y, at.z, hot, 0.16, 2.2, 0.4, 1.0, 1.6);
  ring(pool, at.x, at.y + 0.05, at.z, col, 0.2, 0.045, 0.42, 7, 1.3);
  flash(pool, at.x, at.y + 0.9, at.z, hot, 0.22, 0.22, 4, 1.8);
  spray(pool, at.x, at.y, at.z, hot, { count: 12, y: 0.1, radial: [0.5, 0.6], up: [4.5, 2.5], size: 0.05, life: 0.5, gravity: 5, fadePow: 1.2 });
}

// Shockwave: a hard double ground ring + a bright ground flash. Low + wide.
function spawnRing(pool: FxPool, at: THREE.Vector3) {
  const hot = 0xbfeaff;
  const by = at.y + 0.06;
  ring(pool, at.x, by, at.z, hot, 0.18, 0.05, 0.36, 13, 1.3);
  ring(pool, at.x, by, at.z, hot, 0.1, 0.03, 0.46, 9, 1.5);
  flash(pool, at.x, by, at.z, hot, 0.2, 0.2, 6, 1.8);
  spray(pool, at.x, at.y, at.z, 0x8ad8ff, { count: 10, y: 0.08, radial: [2.2, 1.4], up: [1.5, 1.5], size: 0.05, life: 0.4, gravity: 7, fadePow: 1.2 });
}

// Cinder: a warm column + a dense cone of rising embers.
function spawnEmberIn(pool: FxPool, at: THREE.Vector3) {
  const core = 0xffb15a;
  const spark = 0xff7b3a;
  column(pool, at.x, at.y, at.z, core, 0.13, 1.8, 0.36, 0.8, 1.7);
  flash(pool, at.x, at.y + 0.2, at.z, core, 0.2, 0.2, 4, 1.8);
  spray(pool, at.x, at.y, at.z, spark, { count: 18, y: 0.1, radial: [0.3, 0.9], up: [3.5, 3.5], size: 0.045, life: 0.7, gravity: 7, fadePow: 1.1 });
}

// Rift: a violet vertical tear that flares, with motes drawn inward then out.
function spawnRift(pool: FxPool, at: THREE.Vector3) {
  const core = 0xe9d5ff;
  const halo = 0xa855f7;
  // A thin tall slab (the tear) that widens and fades.
  const slab = pool.alloc('box');
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
  flash(pool, at.x, at.y + 0.95, at.z, core, 0.18, 0.28, 6, 2.0);
}

// ── Weapon flashes ──────────────────────────────────────────────────────────

// Muzzle flash: a rail DISCHARGE, not a firearm — a crisp camera-facing
// electric core (bright core + streaks) that flickers for two frames, a
// thin ring blown out along the beam, and a ≤ 60 ms light pulse. Capped small
// and short so it never blinds: 0.26 m, 75 ms.
function muzzleFlash(ctx: FxContext, at: THREE.Vector3, color: number, dir?: THREE.Vector3) {
  const s = ctx.sprites.alloc(flashTexture());
  s.sprite.position.copy(at);
  s.base = 0.26;
  s.shrink = 0.35;
  s.life = 0.075;
  s.fadePow = 1.6;
  s.flicker = true;
  tmpColorFromHex(color, 2.0, s);
  ctx.sprites.finish(s);
  if (dir && dir.lengthSq() > 1e-6) {
    // Ring perpendicular to the beam, punched a little way out of the muzzle.
    const p = ctx.pool.alloc('ring');
    if (p) {
      tmpN.copy(dir).normalize();
      p.x = at.x + tmpN.x * 0.05; p.y = at.y + tmpN.y * 0.05; p.z = at.z + tmpN.z * 0.05;
      tmpQ.setFromUnitVectors(Z_AXIS, tmpN);
      p.setQuaternion(tmpQ);
      p.setScale(0.08);
      p.grow = 12;
      p.life = 0.11;
      p.fadePow = 1.4;
      p.setColor(color, 1.3);
    }
  } else {
    // No beam direction known (replay / preview): a camera-facing ring instead.
    const r = ctx.sprites.alloc(ringTexture());
    r.sprite.position.copy(at);
    r.base = 0.08;
    r.shrink = -2.8; // grows to ~0.3 m
    r.life = 0.11;
    r.fadePow = 1.4;
    tmpColorFromHex(color, 1.3, r);
    ctx.sprites.finish(r);
  }
  ctx.lights.pulse(0, at.x, at.y, at.z, color, 3, 0.06, 4);
}

const tmpColor = new THREE.Color();
function tmpColorFromHex(hex: number, gain: number, out: { r: number; g: number; b: number }) {
  tmpColor.setHex(hex);
  out.r = tmpColor.r * gain;
  out.g = tmpColor.g * gain;
  out.b = tmpColor.b * gain;
}

// World impact of a rail beam at `point` on a face with unit `normal`, the beam
// travelling along unit `dir`: a hot flash, a fast thin ring on the surface
// plane, 8-12 spark streaks flung back off the face under gravity, a scorch /
// glow decal, and a ≤ 80 ms light pulse. Called by weapon.ts for every beam
// that ends on the map (never for beams that stop on a player).
export function spawnRailImpact(
  scene: THREE.Scene,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  dir: THREE.Vector3,
  core: number,
  helix: number,
) {
  const ctx = getFxContext(scene);
  const pool = ctx.pool;
  const nx = normal.x, ny = normal.y, nz = normal.z;
  const px = point.x + nx * 0.02, py = point.y + ny * 0.02, pz = point.z + nz * 0.02;

  flash(pool, px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02, core, 0.1, 0.1, 8, 2.0);

  const rq = pool.alloc('ring');
  if (rq) {
    rq.x = point.x + nx * 0.015; rq.y = point.y + ny * 0.015; rq.z = point.z + nz * 0.015;
    tmpQ.setFromUnitVectors(Z_AXIS, normal);
    rq.setQuaternion(tmpQ);
    rq.setScale(0.14);
    rq.grow = 11;
    rq.life = 0.2;
    rq.fadePow = 1.6;
    rq.setColor(helix, 1.4);
  }

  // Sparks leave along the face normal blended with the beam's reflection, so
  // a glancing hit skids sideways while a square hit sprays straight back.
  const dn = dir.x * nx + dir.y * ny + dir.z * nz;
  const rx = dir.x - 2 * dn * nx, ry = dir.y - 2 * dn * ny, rz = dir.z - 2 * dn * nz;
  const count = Math.max(4, Math.round(10 * getFxQuality()));
  for (let i = 0; i < count; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    p.x = px; p.y = py; p.z = pz;
    p.setScale(0.018, 0.018, 0.12);
    p.align = true;
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * TWO_PI;
    const sq = Math.sqrt(1 - u * u);
    let vx = nx + rx * 0.5 + Math.cos(phi) * sq * 0.8;
    let vy = ny + ry * 0.5 + u * 0.8 + 0.25;
    let vz = nz + rz * 0.5 + Math.sin(phi) * sq * 0.8;
    const out = vx * nx + vy * ny + vz * nz;
    if (out < 0.2) { // never fire a spark into the wall
      vx += nx * (0.2 - out); vy += ny * (0.2 - out); vz += nz * (0.2 - out);
    }
    const l = Math.hypot(vx, vy, vz) || 1;
    const speed = 2.5 + Math.random() * 2.5;
    p.vx = (vx / l) * speed; p.vy = (vy / l) * speed; p.vz = (vz / l) * speed;
    p.gravity = 9;
    p.life = 0.25 + Math.random() * 0.15;
    p.fadePow = 1.3;
    p.setColor(i % 3 === 0 ? helix : core, 1.4);
  }

  if (ctx.decals.enabled) ctx.decals.place(point, normal, helix, 0.36 + Math.random() * 0.12);
  ctx.lights.pulse(1, point.x + nx * 0.3, point.y + ny * 0.3, point.z + nz * 0.3, core, 5, 0.08, 4);
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
    const pool = getFxContext(scene).pool;
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
    flash(pool, at.x, at.y, at.z, color, 0.06, 0.08, 8, 2.0);
  }

  // Muzzle flash at the gun muzzle on fire. `dir` (the beam direction, any
  // length) orients the discharge ring; without it the ring faces the camera.
  spawnMuzzleFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x9fe8ff, dir?: THREE.Vector3) {
    muzzleFlash(getFxContext(scene), at, color, dir);
  }

  spawnKillBurst(
    scene: THREE.Scene,
    at: THREE.Vector3,
    headshot = false,
    style: KillEffectStyle = 'pulse',
  ) {
    const pool = getFxContext(scene).pool;
    switch (style) {
      case 'nova': return killNova(pool, at, headshot);
      case 'starburst': return killStarburst(pool, at, headshot);
      case 'voxel': return killVoxel(pool, at, headshot);
      case 'ember': return killEmber(pool, at, headshot);
      case 'gibstorm': return killGibstorm(pool, at, headshot);
      case 'singularity': return killSingularity(pool, at, headshot);
      case 'pulse':
      default:
        return killPulse(pool, at, headshot);
    }
  }

  // Cosmetic-only materialize burst at a (re)spawn point; `beam` is the default.
  spawnInBurst(scene: THREE.Scene, at: THREE.Vector3, style: SpawnEffectStyle = 'beam') {
    const pool = getFxContext(scene).pool;
    switch (style) {
      case 'ring': return spawnRing(pool, at);
      case 'ember': return spawnEmberIn(pool, at);
      case 'rift': return spawnRift(pool, at);
      case 'beam':
      default: return spawnBeamIn(pool, at);
    }
  }

  step(dt: number, scene: THREE.Scene) {
    const ctx = getFxContext(scene);
    ctx.managed = true;
    ctx.step(dt);
  }

  // Clears every live effect and releases the scene's pooled GPU resources
  // (they're rebuilt lazily on the next spawn/step, e.g. after a map switch).
  dispose(scene: THREE.Scene) {
    disposeFxContext(scene);
  }
}
