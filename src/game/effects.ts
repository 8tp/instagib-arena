import * as THREE from 'three';
import type { KillEffectStyle, SpawnEffectStyle } from './cosmetics';
import {
  disposeFxContext,
  flashTexture,
  getFxContext,
  getFxQuality,
  glowTexture,
  ringTexture,
  setFxQuality,
  type FxContext,
  type FxPool,
} from './fx-pool';
import { liveViewmodelMuzzle } from './fx/rail-state';
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
const tmpE = new THREE.Euler();
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

// A spherical shock front at body height: a camera-facing ring sprite, so it
// reads as an expanding shell from every angle (a flat torus at chest height is
// seen edge-on from eye level as a bright bar). Same radius/growth numbers as
// ring(); the ring texture's bright annulus sits at ~0.62 of the half-size.
function shockRing(ctx: FxContext, x: number, y: number, z: number, color: number, r: number, life: number, grow: number, fadePow: number) {
  const g = Math.exp(growRate(grow) * life);
  sprite(ctx, ringTexture(), x, y, z, r * 3.2, 1 - g, life, fadePow, color, RING_GAIN * 1.6, false);
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
// brief; `pulse` is the free default.

// Shared kill punctuation: a short world-light pop at the burst so the frag
// lights up the surroundings for a beat (full-quality tier only).
function killLight(ctx: FxContext, at: THREE.Vector3, color: number, peak = 8) {
  ctx.lights.pulse(1, at.x, at.y + 0.2, at.z, color, peak, 0.12, 7);
}

// Pulse (default): an instagib energy detonation — a white-hot flash, a
// spherical shock front (camera-facing ring), a shockwave racing out across
// the floor, a hard spray of spark streaks, a few slow energy motes, and a
// light pop. Everything is gone in ~0.5 s and the bright part in ~0.12 s, so
// it confirms the frag without hanging over the crosshair line. Body chunks
// are the victim's own gibs (combatant code), not drawn here. `at` = the
// victim's body centre.
function killPulse(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const hot = headshot ? 0xfff0c8 : 0xe2f8ff;
  const accent = headshot ? 0xffb030 : 0x3fb4ff;
  const cy = at.y + 0.1;
  // Flash: a soft energy bloom behind a crisp star.
  sprite(ctx, glowTexture(), at.x, cy, at.z, 1.9, -0.25, 0.14, 1.6, hot, 2.4, false);
  sprite(ctx, flashTexture(), at.x, cy, at.z, 1.15, 0.25, 0.09, 1.5, hot, 2.8, true);
  // Spherical shock front: a camera-facing ring blown out to ~2.6 m.
  sprite(ctx, ringTexture(), at.x, cy, at.z, 0.4, -5.5, 0.28, 1.4, accent, 2.4, false);
  // Shockwave across the floor at the victim's feet (seen from above, never
  // edge-on at eye height).
  ring(pool, at.x, at.y - 0.85, at.z, accent, 0.3, 0.02, 0.36, 6.5, 1.3);
  // Spark streaks flung in every direction (biased up), under gravity.
  const n = Math.max(6, Math.round(24 * getFxQuality()));
  for (let i = 0; i < n; i++) {
    const p = pool.alloc('box');
    if (!p) break;
    const u = Math.random() * 1.6 - 0.6; // cos(polar), biased upward
    const phi = Math.random() * TWO_PI;
    const sq = Math.sqrt(Math.max(0, 1 - u * u));
    const speed = 5.5 + Math.random() * 6.5;
    p.x = at.x; p.y = cy; p.z = at.z;
    p.setScale(0.024, 0.024, 0.24 + Math.random() * 0.16);
    p.align = true;
    p.vx = Math.cos(phi) * sq * speed;
    p.vy = u * speed + 1.5;
    p.vz = Math.sin(phi) * sq * speed;
    p.gravity = 14;
    p.life = 0.3 + Math.random() * 0.22;
    p.fadePow = 1.4;
    p.setColor(i % 3 === 0 ? accent : hot, 2.0);
  }
  // A few slow energy motes that hang for a beat.
  spray(pool, at.x, cy, at.z, accent, { count: 8, y: 0, radial: [0.8, 1.6], up: [0.5, 2], size: 0.045, life: 0.55, gravity: 3, fadePow: 1.2 });
  killLight(ctx, at, accent, 9);
}

// Camera-facing flash from the sprite pool. `shrink` < 0 grows over the life.
function sprite(
  ctx: FxContext, map: THREE.Texture, x: number, y: number, z: number,
  size: number, shrink: number, life: number, fadePow: number,
  color: number, gain: number, flicker: boolean,
) {
  const s = ctx.sprites.alloc(map);
  s.sprite.position.set(x, y, z);
  s.base = size;
  s.shrink = shrink;
  s.life = life;
  s.fadePow = fadePow;
  s.flicker = flicker;
  tmpColorFromHex(color, gain, s);
  ctx.sprites.finish(s);
}

// Nova: a big energy bloom with twin shockwave rings and a light spray.
function killNova(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const hot = headshot ? 0xffe6a0 : 0x9fdcff;
  const cy = at.y + 0.4;
  flash(ctx, at.x, cy, at.z, hot, 0.28, 0.2, 9, 1.6);
  shockRing(ctx, at.x, cy, at.z, hot, 0.16, 0.34, 14, 1.3);
  shockRing(ctx, at.x, cy, at.z, hot, 0.1, 0.44, 9, 1.5);
  spray(pool, at.x, at.y, at.z, hot, { count: 8, y: 0.5, radial: [1.2, 1.2], up: [2.5, 2], size: 0.05, life: 0.4, gravity: 9, fadePow: 1.2 });
}

// Starburst: a flat-ish radial star of light spikes that fire outward.
function killStarburst(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const hot = headshot ? 0xffd27a : 0x8ad8ff;
  const cy = at.y + 0.4;
  flash(ctx, at.x, cy, at.z, hot, 0.18, 0.14, 6, 1.8);
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
function killVoxel(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const hot = headshot ? 0xffe08a : 0x9fe8ff;
  const tints = headshot ? [0xffd27a, 0xffba5a] : [0x7fe6ff, 0xff6b8a];
  const cy = at.y + 0.5;
  flash(ctx, at.x, cy, at.z, hot, 0.2, 0.14, 6, 1.8);
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
function killEmber(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const core = headshot ? 0xffd27a : 0xffb15a;
  const spark = headshot ? 0xffc24d : 0xff7b3a;
  flash(ctx, at.x, at.y + 0.3, at.z, core, 0.2, 0.14, 5, 1.8);
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
function killGibstorm(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const hot = headshot ? 0xffe08a : 0xb8f2ff;
  const spark = headshot ? 0xffc24d : 0xff5577;
  const cy = at.y + 0.4;
  flash(ctx, at.x, cy, at.z, hot, 0.24, 0.16, 8, 1.7);
  shockRing(ctx, at.x, cy, at.z, hot, 0.2, 0.3, 11, 1.3);
  spray(pool, at.x, at.y, at.z, spark, { count: 26, y: 0.6, radial: [2.2, 2.4], up: [5, 3.5], size: 0.07, life: 0.7, gravity: 14, fadePow: 1.0 });
}

// Singularity: a ring collapses inward to a point, then a white-hot core
// detonates with an outward spark spray.
function killSingularity(ctx: FxContext, at: THREE.Vector3, headshot: boolean) {
  const pool = ctx.pool;
  const core = headshot ? 0xfff0c0 : 0xffffff;
  const halo = headshot ? 0xffc24d : 0x4aa8ff;
  const cy = at.y + 0.5;
  // Collapsing ring: negative grow shrinks it toward the center.
  shockRing(ctx, at.x, cy, at.z, halo, 0.5, 0.26, -3.2, 0.6);
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
  flash(ctx, at.x, cy, at.z, core, 0.16, 0.3, 7, 2.2);
  spray(pool, at.x, at.y, at.z, core, { count: 10, y: 0.5, radial: [2.4, 1.6], up: [1.5, 2.5], size: 0.05, life: 0.4, gravity: 6, fadePow: 1.4 });
}

// ── Spawn-in styles ─────────────────────────────────────────────────────────
// A materialize burst at a (re)spawn point. `at` is the player's FEET.

// Teleport: a tall light column + an expanding ground ring + rising motes.
function spawnBeamIn(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const hot = 0xa8f0ff;
  const col = 0x37a6ff;
  column(pool, at.x, at.y, at.z, hot, 0.16, 2.2, 0.4, 1.0, 1.6);
  ring(pool, at.x, at.y + 0.05, at.z, col, 0.2, 0.045, 0.42, 7, 1.3);
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
function spawnEmberIn(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
  const core = 0xffb15a;
  const spark = 0xff7b3a;
  column(pool, at.x, at.y, at.z, core, 0.13, 1.8, 0.36, 0.8, 1.7);
  flash(ctx, at.x, at.y + 0.2, at.z, core, 0.2, 0.2, 4, 1.8);
  spray(pool, at.x, at.y, at.z, spark, { count: 18, y: 0.1, radial: [0.3, 0.9], up: [3.5, 3.5], size: 0.045, life: 0.7, gravity: 7, fadePow: 1.1 });
}

// Rift: a violet vertical tear that flares, with motes drawn inward then out.
function spawnRift(ctx: FxContext, at: THREE.Vector3) {
  const pool = ctx.pool;
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
  flash(ctx, at.x, at.y + 0.95, at.z, core, 0.18, 0.28, 6, 2.0);
}

// ── Weapon flashes ──────────────────────────────────────────────────────────

const tmpMuzzle = new THREE.Vector3();

// Muzzle discharge: a rail DISCHARGE, not a firearm — a crisp star flare that
// flickers for two frames, a thin shock ring blown out along the beam, a few
// short energy streaks jetting down the bore line, and a ≤ 60 ms light pulse.
// For the local shot the first-person viewmodel carries its own flare on the
// barrel, so here the world part moves to that real muzzle and stays small.
function muzzleFlash(ctx: FxContext, at: THREE.Vector3, color: number, dir?: THREE.Vector3) {
  let x = at.x, y = at.y, z = at.z;
  const own = liveViewmodelMuzzle(tmpMuzzle) && tmpMuzzle.distanceToSquared(at) < 1.44;
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
function tmpColorFromHex(hex: number, gain: number, out: { r: number; g: number; b: number }) {
  tmpColor.setHex(hex);
  out.r = tmpColor.r * gain;
  out.g = tmpColor.g * gain;
  out.b = tmpColor.b * gain;
}

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
  spawnMuzzleFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x9fe8ff, dir?: THREE.Vector3) {
    muzzleFlash(getFxContext(scene), at, color, dir);
  }

  spawnKillBurst(
    scene: THREE.Scene,
    at: THREE.Vector3,
    headshot = false,
    style: KillEffectStyle = 'pulse',
  ) {
    const ctx = getFxContext(scene);
    // Every style gets the same brief light pop in its own key colour.
    const amber = 0xffc24d;
    switch (style) {
      case 'nova': killLight(ctx, at, headshot ? amber : 0x9fdcff); return killNova(ctx, at, headshot);
      case 'starburst': killLight(ctx, at, headshot ? amber : 0x8ad8ff, 6); return killStarburst(ctx, at, headshot);
      case 'voxel': killLight(ctx, at, headshot ? amber : 0x9fe8ff, 6); return killVoxel(ctx, at, headshot);
      case 'ember': killLight(ctx, at, headshot ? amber : 0xff9a40); return killEmber(ctx, at, headshot);
      case 'gibstorm': killLight(ctx, at, headshot ? amber : 0xb8f2ff, 9); return killGibstorm(ctx, at, headshot);
      case 'singularity': killLight(ctx, at, headshot ? amber : 0x4aa8ff); return killSingularity(ctx, at, headshot);
      case 'pulse':
      default:
        return killPulse(ctx, at, headshot);
    }
  }

  // Cosmetic-only materialize burst at a (re)spawn point; `beam` is the default.
  spawnInBurst(scene: THREE.Scene, at: THREE.Vector3, style: SpawnEffectStyle = 'beam') {
    const ctx = getFxContext(scene);
    switch (style) {
      case 'ring': return spawnRing(ctx, at);
      case 'ember': return spawnEmberIn(ctx, at);
      case 'rift': return spawnRift(ctx, at);
      case 'beam':
      default: return spawnBeamIn(ctx, at);
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
