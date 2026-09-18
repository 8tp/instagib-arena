import * as THREE from 'three';
import { DecalManager } from './decals';

// ─────────────────────────────────────────────────────────────────────────
// Shared, pooled FX primitives — one FxContext per scene.
//
//  • One InstancedMesh per particle SHAPE (one geometry + one additive
//    material each). A burst only fills instance slots, so a kill effect costs
//    zero geometry/material allocations and draws in as many draw calls as it
//    touches shapes (2-3; the old per-particle meshes were 15-30 draw calls).
//  • Additive blending makes "opacity" and "scale the colour" identical, so the
//    per-instance fade is baked into instanceColor — no per-instance alpha.
//    Colours are linear and deliberately exceed 1.0 on hot cores so a
//    threshold bloom pass picks them out. All materials are toneMapped:false.
//  • Motion is evaluated in closed form each frame (p0 + v·t − ½g·t², s0·e^kt),
//    so the look is identical at any frame rate; dt is clamped.
//  • A small pool of camera-facing sprites (muzzle / impact flashes), two
//    PointLights that pulse (kept in the scene permanently while enabled so
//    toggling them never recompiles the lit materials), and the impact-decal
//    ring buffer live here too, so weapon.ts and effects.ts share one budget.
//
// Everything in the context is tagged `userData.shared` so Game.disposeScene()
// leaves it alone; `disposeFxContext(scene)` releases it explicitly.
// ─────────────────────────────────────────────────────────────────────────

export const FX_SHAPES = ['sphere', 'ico', 'torus', 'torusThin', 'box', 'column', 'cone', 'ring'] as const;
export type FxShape = (typeof FX_SHAPES)[number];

// Max simultaneous live instances per shape. Bursts that would overflow simply
// drop particles (never allocate), so a killstreak pile-up degrades gracefully.
const SHAPE_CAPACITY: Record<FxShape, number> = {
  sphere: 32,
  ico: 192,
  torus: 24,
  torusThin: 8,
  box: 160,
  column: 8,
  cone: 8,
  ring: 24,
};

const SHAPE_INDEX = Object.fromEntries(FX_SHAPES.map((s, i) => [s, i])) as Record<FxShape, number>;

const MAX_DT = 0.1;
const SPRITE_SLOTS = 6;

function buildShapeGeometry(shape: FxShape): THREE.BufferGeometry {
  switch (shape) {
    case 'sphere': return new THREE.SphereGeometry(1, 10, 8);
    case 'ico': return new THREE.IcosahedronGeometry(1, 0);
    // Torus tube is a fixed FRACTION of the ring radius; uniform scale keeps
    // the proportions, so one geometry serves every ring size.
    case 'torus': return new THREE.TorusGeometry(1, 0.25, 8, 24);
    case 'torusThin': return new THREE.TorusGeometry(1, 0.08, 8, 32);
    case 'box': return new THREE.BoxGeometry(1, 1, 1);
    // Open, tapered light columns (top radius as a fraction of the base).
    case 'column': return new THREE.CylinderGeometry(0.7, 1, 1, 12, 1, true);
    case 'cone': return new THREE.CylinderGeometry(0.4375, 1, 1, 10, 1, true);
    // Textured surface ring (+Z is the surface normal).
    case 'ring': return new THREE.PlaneGeometry(1, 1);
  }
}

function additiveMaterial(map: THREE.Texture | null, doubleSided: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// ── Procedural textures (module-cached, shared by every context) ───────────

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  draw(ctx, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let flashTex: THREE.Texture | null = null;
// Rail-discharge flash: a hard white core, six tapered streaks (alternating
// long/short), and a faint ring — crisp, readable, Diabotical-style.
export function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  flashTex = canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    ctx.globalCompositeOperation = 'lighter';
    // Streaks.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.35;
      const len = (i % 2 === 0 ? 0.48 : 0.3) * s;
      const w = (i % 2 === 0 ? 0.05 : 0.035) * s;
      const g = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a + Math.PI / 2) * w, c + Math.sin(a + Math.PI / 2) * w);
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      ctx.lineTo(c + Math.cos(a - Math.PI / 2) * w, c + Math.sin(a - Math.PI / 2) * w);
      ctx.closePath();
      ctx.fill();
    }
    // Ring.
    const ring = ctx.createRadialGradient(c, c, s * 0.3, c, c, s * 0.4);
    ring.addColorStop(0, 'rgba(255,255,255,0)');
    ring.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    ring.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, s, s);
    // Core.
    const core = ctx.createRadialGradient(c, c, 0, c, c, s * 0.28);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.3, 'rgba(255,255,255,0.9)');
    core.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, s, s);
  });
  return flashTex;
}

let ringTex: THREE.Texture | null = null;
// Thin soft annulus — the expanding shock ring on a surface / at the muzzle.
export function ringTexture(): THREE.Texture {
  if (ringTex) return ringTex;
  ringTex = canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, s * 0.3, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
    g.addColorStop(0.62, 'rgba(255,255,255,1)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  return ringTex;
}

// ── Particles ───────────────────────────────────────────────────────────────

const tmpColor = new THREE.Color();

// One pooled particle. Recipes fill the public fields right after alloc(); the
// pool evaluates position/scale/fade from them each frame.
export class FxParticle {
  shape = 0; // index into FX_SHAPES
  x = 0; y = 0; z = 0; // start position
  vx = 0; vy = 0; vz = 0; // velocity (m/s)
  gravity = 0; // m/s², pulls -Y
  age = 0;
  life = 0.2;
  fadePow = 1; // brightness = lifeFrac^fadePow
  sx = 1; sy = 1; sz = 1; // base scale (metres)
  grow = 0; // exponential scale rate per second (negative shrinks)
  qx = 0; qy = 0; qz = 0; qw = 1; // orientation (ignored when `align`)
  align = false; // orient +Z along the current velocity (streaks / spikes)
  r = 1; g = 1; b = 1; // linear colour, may exceed 1 for bloom

  reset(shape: number) {
    this.shape = shape;
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.gravity = 0;
    this.age = 0;
    this.life = 0.2;
    this.fadePow = 1;
    this.sx = this.sy = this.sz = 1;
    this.grow = 0;
    this.qx = this.qy = this.qz = 0;
    this.qw = 1;
    this.align = false;
    this.r = this.g = this.b = 1;
  }

  setColor(hex: number, intensity = 1) {
    tmpColor.setHex(hex);
    this.r = tmpColor.r * intensity;
    this.g = tmpColor.g * intensity;
    this.b = tmpColor.b * intensity;
  }

  setQuaternion(q: THREE.Quaternion) {
    this.qx = q.x;
    this.qy = q.y;
    this.qz = q.z;
    this.qw = q.w;
  }

  setScale(s: number, sy = s, sz = s) {
    this.sx = s;
    this.sy = sy;
    this.sz = sz;
  }
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();

export class FxPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly capacity: number[] = [];
  private readonly live: FxParticle[] = [];
  private readonly free: FxParticle[] = [];
  private readonly liveByShape: Int32Array;

  constructor() {
    this.group.userData.shared = true;
    let total = 0;
    for (const shape of FX_SHAPES) {
      const cap = SHAPE_CAPACITY[shape];
      const doubleSided = shape === 'column' || shape === 'cone' || shape === 'ring';
      const mat = additiveMaterial(shape === 'ring' ? ringTexture() : null, doubleSided);
      const mesh = new THREE.InstancedMesh(buildShapeGeometry(shape), mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.shared = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.capacity.push(cap);
      total += cap;
    }
    this.liveByShape = new Int32Array(FX_SHAPES.length);
    for (let i = 0; i < total; i++) this.free.push(new FxParticle());
  }

  // Claim a particle of `shape`, already live with default fields. Returns
  // null (drops the particle) when the shape's instance budget is full.
  alloc(shape: FxShape): FxParticle | null {
    const si = SHAPE_INDEX[shape];
    if (this.liveByShape[si] >= this.capacity[si]) return null;
    const p = this.free.pop();
    if (!p) return null;
    p.reset(si);
    this.live.push(p);
    this.liveByShape[si]++;
    return p;
  }

  step(dt: number) {
    const counts = this.liveByShape;
    counts.fill(0);
    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.age += dt;
      if (p.age >= p.life) {
        live[i] = live[live.length - 1];
        live.pop();
        this.free.push(p);
        continue;
      }
      const t = p.age;
      const lifeFrac = 1 - t / p.life;
      const fade = p.fadePow === 1 ? lifeFrac : Math.pow(lifeFrac, p.fadePow);
      const s = p.grow !== 0 ? Math.exp(p.grow * t) : 1;

      tmpPos.set(p.x + p.vx * t, p.y + p.vy * t - 0.5 * p.gravity * t * t, p.z + p.vz * t);
      if (p.align) {
        const vy = p.vy - p.gravity * t;
        const l = Math.hypot(p.vx, vy, p.vz);
        if (l > 1e-6) {
          tmpDir.set(p.vx / l, vy / l, p.vz / l);
          tmpQuat.setFromUnitVectors(Z_AXIS, tmpDir);
        } else {
          tmpQuat.identity();
        }
      } else {
        tmpQuat.set(p.qx, p.qy, p.qz, p.qw);
      }
      tmpScale.set(p.sx * s, p.sy * s, p.sz * s);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);

      const si = p.shape;
      const idx = counts[si];
      if (idx >= this.capacity[si]) continue; // over budget: keep alive, skip draw
      counts[si] = idx + 1;
      const mesh = this.meshes[si];
      tmpMat.toArray(mesh.instanceMatrix.array as unknown as number[], idx * 16);
      const col = mesh.instanceColor!.array as Float32Array;
      col[idx * 3] = p.r * fade;
      col[idx * 3 + 1] = p.g * fade;
      col[idx * 3 + 2] = p.b * fade;
    }
    for (let si = 0; si < this.meshes.length; si++) {
      const mesh = this.meshes[si];
      const n = counts[si];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) continue;
      const im = mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      const ic = mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
    }
  }

  clear() {
    for (const p of this.live) this.free.push(p);
    this.live.length = 0;
    this.liveByShape.fill(0);
    for (const mesh of this.meshes) {
      mesh.count = 0;
      mesh.visible = false;
    }
  }

  dispose() {
    this.clear();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.clear();
  }
}

// ── Sprites (camera-facing flashes) ────────────────────────────────────────

export type SpriteSlot = {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  busy: boolean;
  age: number;
  life: number;
  fadePow: number;
  base: number; // starting size (metres)
  shrink: number; // fraction of `base` lost over the life (negative grows)
  flicker: boolean; // alternate-frame 0.78× for the first 2 frames
  r: number; g: number; b: number;
};

class SpritePool {
  readonly slots: SpriteSlot[] = [];

  constructor(parent: THREE.Object3D) {
    for (let i = 0; i < SPRITE_SLOTS; i++) {
      const mat = new THREE.SpriteMaterial({
        map: flashTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        color: 0xffffff,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.userData.shared = true;
      parent.add(sprite);
      this.slots.push({
        sprite, mat, busy: false, age: 0, life: 0.1, fadePow: 1, base: 0.2, shrink: 0, flicker: false, r: 1, g: 1, b: 1,
      });
    }
  }

  // Claim a slot (the oldest live one is recycled when all are busy). The
  // caller sets position / colour / timing on the returned slot.
  alloc(map: THREE.Texture): SpriteSlot {
    let pick: SpriteSlot | null = null;
    for (const s of this.slots) {
      if (!s.busy) { pick = s; break; }
      if (!pick || s.age / s.life > pick.age / pick.life) pick = s;
    }
    const s = pick!;
    s.busy = true;
    s.age = 0;
    s.life = 0.1;
    s.fadePow = 1;
    s.base = 0.2;
    s.shrink = 0;
    s.flicker = false;
    s.r = s.g = s.b = 1;
    s.mat.map = map;
    s.mat.rotation = Math.random() * Math.PI * 2;
    s.sprite.visible = true;
    return s;
  }

  // Apply the caller's size / colour right away so the sprite is correct on
  // the very first frame it's drawn (before the first step()).
  finish(s: SpriteSlot) {
    s.sprite.scale.set(s.base, s.base, 1);
    s.mat.color.setRGB(s.r, s.g, s.b);
  }

  step(dt: number, frame: number) {
    for (const s of this.slots) {
      if (!s.busy) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.busy = false;
        s.sprite.visible = false;
        continue;
      }
      const f = 1 - s.age / s.life;
      const fade = s.fadePow === 1 ? f : Math.pow(f, s.fadePow);
      let size = s.base * (1 - s.shrink * (s.age / s.life));
      if (s.flicker && s.age < 0.034 && (frame & 1) === 1) size *= 0.78;
      s.sprite.scale.set(size, size, 1);
      s.mat.color.setRGB(s.r * fade, s.g * fade, s.b * fade);
    }
  }

  clear() {
    for (const s of this.slots) {
      s.busy = false;
      s.sprite.visible = false;
    }
  }

  dispose() {
    for (const s of this.slots) {
      s.mat.dispose();
      s.sprite.removeFromParent();
    }
    this.slots.length = 0;
  }
}

// ── Point-light pulses ─────────────────────────────────────────────────────

type Pulse = { light: THREE.PointLight; age: number; life: number; peak: number };

// Two lights (muzzle + impact) that live in the scene permanently while
// enabled — adding/removing lights per shot would re-key every lit material's
// shader — and simply sit at intensity 0 between pulses.
class LightPulses {
  readonly pulses: Pulse[] = [];
  private attached = false;

  constructor(private readonly parent: THREE.Object3D) {
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 5, 2);
      light.userData.shared = true;
      this.pulses.push({ light, age: 0, life: 0, peak: 0 });
    }
  }

  get enabled() {
    return this.attached;
  }

  setEnabled(on: boolean) {
    if (on === this.attached) return;
    this.attached = on;
    for (const p of this.pulses) {
      if (on) this.parent.add(p.light);
      else this.parent.remove(p.light);
      p.light.intensity = 0;
      p.life = 0;
    }
  }

  // slot 0 = muzzle, 1 = impact. Peak intensity in candela; ≤ 0.08 s.
  pulse(slot: 0 | 1, x: number, y: number, z: number, hex: number, peak: number, life: number, distance: number) {
    if (!this.attached) return;
    const p = this.pulses[slot];
    p.light.position.set(x, y, z);
    p.light.color.setHex(hex);
    p.light.distance = distance;
    p.light.intensity = peak;
    p.peak = peak;
    p.age = 0;
    p.life = Math.min(life, 0.08);
  }

  step(dt: number) {
    for (const p of this.pulses) {
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.life = 0;
        p.light.intensity = 0;
        continue;
      }
      const f = 1 - p.age / p.life;
      p.light.intensity = p.peak * f * f;
    }
  }

  clear() {
    for (const p of this.pulses) {
      p.life = 0;
      p.light.intensity = 0;
    }
  }

  dispose() {
    this.setEnabled(false);
    for (const p of this.pulses) p.light.dispose();
  }
}

// ── Context ────────────────────────────────────────────────────────────────

// Device-level quality shared by every context (1 = full; 0.5 = low-spec:
// thinner sprays, no decals, no light pulses).
let fxQuality = 1;

export function setFxQuality(q: number) {
  fxQuality = Math.max(0.25, Math.min(1, q));
}

export function getFxQuality(): number {
  return fxQuality;
}

export class FxContext {
  readonly group = new THREE.Group();
  readonly pool = new FxPool();
  readonly sprites: SpritePool;
  readonly lights: LightPulses;
  readonly decals = new DecalManager();
  time = 0; // seconds since creation (drives decal ageing on the GPU)
  frame = 0;
  quality = -1;
  // Set by EffectsManager.step; Railgun.step only steps a context nobody
  // else is stepping (e.g. a scene with a weapon but no EffectsManager).
  managed = false;

  constructor(readonly scene: THREE.Scene) {
    this.group.name = 'fx';
    this.group.userData.shared = true;
    this.group.userData.fx = true;
    this.group.add(this.pool.group);
    this.sprites = new SpritePool(this.group);
    this.lights = new LightPulses(this.group);
    this.group.add(this.decals.mesh);
    scene.add(this.group);
    this.applyQuality(fxQuality);
  }

  step(dt: number) {
    dt = Math.max(0, Math.min(MAX_DT, dt));
    if (this.quality !== fxQuality) this.applyQuality(fxQuality);
    this.time += dt;
    this.frame++;
    this.pool.step(dt);
    this.sprites.step(dt, this.frame);
    this.lights.step(dt);
    this.decals.setTime(this.time);
  }

  private applyQuality(q: number) {
    this.quality = q;
    this.decals.setQuality(q);
    this.lights.setEnabled(q >= 0.99);
  }

  clear() {
    this.pool.clear();
    this.sprites.clear();
    this.lights.clear();
    this.decals.clear();
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.lights.dispose();
    this.sprites.dispose();
    this.pool.dispose();
    this.decals.dispose();
  }
}

const contexts = new Map<THREE.Scene, FxContext>();

export function getFxContext(scene: THREE.Scene): FxContext {
  let ctx = contexts.get(scene);
  if (!ctx) {
    ctx = new FxContext(scene);
    contexts.set(scene, ctx);
  }
  return ctx;
}

export function peekFxContext(scene: THREE.Scene): FxContext | null {
  return contexts.get(scene) ?? null;
}

export function disposeFxContext(scene: THREE.Scene) {
  const ctx = contexts.get(scene);
  if (!ctx) return;
  ctx.dispose();
  contexts.delete(scene);
}
