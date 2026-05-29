import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  BOT_DIFFICULTY,
  BOT_EYE_FRAC,
  BOT_HEADSHOT_THRESHOLD,
  BOT_HEIGHT,
  BOT_MOVE_INTERVAL_MAX,
  BOT_MOVE_INTERVAL_MIN,
  BOT_RADIUS,
  BOT_RESPAWN_DELAY,
  DEFAULT_BOT_DIFFICULTY,
  GRAVITY,
  type BotDifficulty,
} from './constants';
import { movePlayer, rayAabb, type ArenaMap } from './map';
import { LocomotionBlender } from './locomotion';
import type { BotState, EntityId, Vec3 } from './types';

const BOT_NAMES = ['Vex', 'Razor', 'Strafe', 'Pyro', 'Vandal', 'Frost', 'Pulse', 'Echo'];
const BOT_FACING_LERP = 12;
// Preferred engagement distance band — bots back off when closer than MIN and
// close the gap when farther than MAX, otherwise circle-strafe.
const COMBAT_RANGE_MIN = 8;
const COMBAT_RANGE_MAX = 18;

// An enemy a bot can target (the local player or another bot).
export type BotTarget = { id: string; pos: Vec3 };
// A bot's decision to fire this tick — resolved by Game against the world.
export type BotFireIntent = { botId: string; botName: string; origin: Vec3; dir: Vec3 };
const MODEL_SCALE = 1.0;
// Soldier.glb actually faces -Z at identity (confirmed: when camera is at
// +Z we see the model's back). Movement direction comes back as
// atan2(dx, dz) which is 0 for wishdir +Z, so we add π to rotate the
// model's natural -Z forward around to match wishdir.
const MODEL_YAW_OFFSET = Math.PI;
const DEATH_ANIM_DURATION = 1.2;

export type BotModel = {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
};

// Module-level cache so React StrictMode's double-mount (and any future
// remount) doesn't trigger two concurrent GLTFLoader runs. Two concurrent
// loaders both create blob: URLs for the embedded textures; when the first
// loader's promise is abandoned (game disposed), GC eventually revokes
// those blobs while the second loader is still trying to Image.src them
// — that's what produces "GLTFLoader: Couldn't load texture blob:…".
let cachedModelPromise: Promise<BotModel | null> | null = null;
let cachedModelLoadCount = 0;

export async function loadBotModel(url: string): Promise<BotModel | null> {
  if (cachedModelPromise) {
    console.info('[instagib] bot model: reusing cached load');
    return cachedModelPromise;
  }
  // Three.js's own resource cache helps when blob URLs are re-fetched.
  THREE.Cache.enabled = true;
  cachedModelLoadCount += 1;
  const loadId = cachedModelLoadCount;
  console.info(`[instagib] bot model: starting fresh load #${loadId} (${url})`);
  cachedModelPromise = (async () => {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      console.info(
        `[instagib] bot model: load #${loadId} resolved (${gltf.animations.length} animations, ${gltf.scene.children.length} root children)`,
      );
      return { scene: gltf.scene, animations: gltf.animations };
    } catch (err) {
      console.warn(`[instagib] bot model: load #${loadId} failed`, err);
      cachedModelPromise = null; // permit retry next mount
      return null;
    }
  })();
  return cachedModelPromise;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

// Triangular noise in [-mag, mag], centered on 0 — a softer, more natural error
// distribution than a flat uniform (shots cluster near the aim point, with the
// occasional flier), for the bot aim cone.
function tri(mag: number): number {
  return (Math.random() + Math.random() - 1) * mag;
}

// Box test with the X/Z faces inflated by `r` (the entity's horizontal radius)
// so a candidate whose CENTER sits just outside a face — but whose capsule would
// overlap the box — is correctly rejected (#23). Y stays exact (vertical clamp).
function pointInsideAnyBox(p: Vec3, map: ArenaMap, r = 0): boolean {
  for (const b of map.boxes) {
    if (
      p.x > b.min.x - r && p.x < b.max.x + r &&
      p.y > b.min.y && p.y < b.max.y &&
      p.z > b.min.z - r && p.z < b.max.z + r
    ) return true;
  }
  return false;
}

export function pickFreeSpot(map: ArenaMap, avoid: Vec3 | null = null, radius = BOT_RADIUS): Vec3 {
  // Inset the sample box by the radius too, so we never sample flush to a wall.
  const xExt = (map.bounds.max.x - map.bounds.min.x) / 2 - 1.5 - radius;
  const zExt = (map.bounds.max.z - map.bounds.min.z) / 2 - 1.5 - radius;
  const cx = (map.bounds.min.x + map.bounds.max.x) / 2;
  const cz = (map.bounds.min.z + map.bounds.max.z) / 2;
  let fallback: Vec3 | null = null;
  for (let i = 0; i < 48; i++) {
    const x = cx + (Math.random() - 0.5) * 2 * xExt;
    const z = cz + (Math.random() - 0.5) * 2 * zExt;
    const y = 0.05;
    if (
      !pointInsideAnyBox({ x, y: y + 0.5, z }, map, radius) &&
      !pointInsideAnyBox({ x, y: y + BOT_HEIGHT - 0.1, z }, map, radius)
    ) {
      // First clear spot is a safe fallback; keep searching for one far from
      // `avoid` so we don't telefrag/stack on the thing we're avoiding.
      if (!fallback) fallback = { x, y, z };
      if (!avoid || Math.hypot(x - avoid.x, z - avoid.z) > 5) {
        return { x, y, z };
      }
    }
  }
  // A clear-but-near spot beats the old {0,0,0} fallback, which could land
  // inside a central monolith on Stadium/Hangar/Spire/Reactor/Crucible.
  if (fallback) return fallback;
  return { x: map.spawn.x, y: 0.05, z: map.spawn.z };
}

function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(name);
    const padding = 16;
    const boxW = Math.min(canvas.width - 4, metrics.width + padding * 2);
    const boxH = 40;
    ctx.fillStyle = 'rgba(8,10,14,0.7)';
    roundRect(ctx, (canvas.width - boxW) / 2, (canvas.height - boxH) / 2, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,209,216,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffd1d8';
    ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    // Respect the depth buffer so nameplates are hidden when the bot is
    // behind a wall — depthTest: true is the WebGL way to do simple
    // occlusion without per-frame raycasts.
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.0, 0.5, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Emissive-only enemy highlight, shared by Bot + RemotePlayer. Reversible:
// null clears the glow without touching base colours/textures.
export function applyHighlight(
  mat: THREE.Material | THREE.Material[] | undefined,
  color: THREE.Color | null,
) {
  const one = (m: THREE.Material) => {
    const sm = m as THREE.MeshStandardMaterial;
    if (!sm.isMeshStandardMaterial) return;
    if (color) {
      sm.emissive.copy(color);
      sm.emissiveIntensity = 1.4;
    } else {
      sm.emissive.setRGB(0, 0, 0);
      sm.emissiveIntensity = 1;
    }
  };
  if (Array.isArray(mat)) mat.forEach(one);
  else if (mat) one(mat);
}

// Look up an animation clip by friendly name. Falls back to indexed
// access (matches Three.js's Soldier example which uses indices 0/1/3).
function pickClip(
  animations: THREE.AnimationClip[],
  names: string[],
  fallbackIndex?: number,
): THREE.AnimationClip | null {
  const lookup = new Map<string, THREE.AnimationClip>();
  for (const c of animations) lookup.set(c.name.toLowerCase(), c);
  for (const n of names) {
    const hit = lookup.get(n.toLowerCase());
    if (hit) return hit;
  }
  if (fallbackIndex !== undefined && animations[fallbackIndex]) {
    return animations[fallbackIndex];
  }
  return null;
}

type ActionKey = 'idle' | 'walk' | 'run' | 'jump' | 'death';

export class Bot {
  state: BotState;
  group: THREE.Group;
  private modelRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Partial<Record<ActionKey, THREE.AnimationAction>> = {};
  private loco: LocomotionBlender | null = null;
  private fallbackBody: THREE.Mesh | null = null;
  private fallbackHead: THREE.Mesh | null = null;
  private nameSprite: THREE.Sprite;
  private target: Vec3;
  private facing = 0;
  private dyingTimer = 0;
  // Vertical physics so bots obey gravity (fall off ledges) and auto-step up
  // ramps/cover instead of being glued to the ground plane (#7).
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private onGround = false;
  // Combat state
  private diff: (typeof BOT_DIFFICULTY)[BotDifficulty];
  private engagedId: string | null = null; // current target id, null = roaming
  private seenForSec = 0; // how long the current target has been visible (reaction gate)
  private shootCooldown = 0;
  private strafeSign = Math.random() < 0.5 ? -1 : 1;
  private strafeFlipTimer = rand(1.2, 3); // randomly reverse strafe so juking isn't metronomic
  // Human-like aim: a smoothed point that chases the target. A laggy chase
  // mis-leads a juking target; error also scales with the target's lateral speed.
  private aimPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private aimSeeded = false;
  private lastTargetId: string | null = null;
  private lastTargetPos: Vec3 = { x: 0, y: 0, z: 0 };
  private lastLateralSpeed = 0;

  constructor(
    id: EntityId,
    name: string,
    spawn: Vec3,
    scene: THREE.Scene,
    model: BotModel | null,
    difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  ) {
    this.diff = BOT_DIFFICULTY[difficulty];
    this.state = {
      id,
      name,
      pos: { ...spawn },
      alive: true,
      respawnTimer: 0,
      moveTimer: rand(BOT_MOVE_INTERVAL_MIN, BOT_MOVE_INTERVAL_MAX),
    };
    this.target = { ...spawn };
    this.group = new THREE.Group();

    if (model) {
      this.installModel(model);
    } else {
      this.installFallback();
    }

    this.nameSprite = makeNameSprite(name);
    this.nameSprite.position.y = BOT_HEIGHT + 0.35;
    this.group.add(this.nameSprite);
    this.group.position.set(spawn.x, spawn.y, spawn.z);
    scene.add(this.group);
    // LocomotionBlender (created in installModel) already starts in idle.
  }

  // Returns a fire intent when the bot decides to shoot this tick, else null.
  // `enemies` is every targetable entity (player + other bots); the bot filters
  // itself out by id.
  step(dt: number, map: ArenaMap, enemies: BotTarget[]): BotFireIntent | null {
    if (this.mixer) this.mixer.update(dt);
    if (this.shootCooldown > 0) this.shootCooldown = Math.max(0, this.shootCooldown - dt);

    if (!this.state.alive) {
      if (this.dyingTimer > 0) {
        this.dyingTimer -= dt;
        if (this.dyingTimer <= 0) this.group.visible = false;
        return null;
      }
      this.state.respawnTimer -= dt;
      if (this.state.respawnTimer <= 0) {
        const spot = pickFreeSpot(map, null);
        this.state.pos = spot;
        this.target = { ...spot };
        this.vel = { x: 0, y: 0, z: 0 };
        this.onGround = false;
        this.group.position.set(spot.x, spot.y, spot.z);
        this.state.alive = true;
        this.group.visible = true;
        this.state.moveTimer = rand(BOT_MOVE_INTERVAL_MIN, BOT_MOVE_INTERVAL_MAX);
        this.engagedId = null;
        this.seenForSec = 0;
        this.aimSeeded = false;
        this.lastTargetId = null;
        this.actions.death?.stop(); // clear the clamped death pose
        this.loco?.start();
      }
      return null;
    }

    // ── Acquire the nearest enemy that's in range AND in line of sight ──
    const eye = this.eyePos();
    let best: BotTarget | null = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      if (e.id === this.state.id) continue;
      const d = Math.hypot(e.pos.x - this.state.pos.x, e.pos.z - this.state.pos.z);
      if (d > this.diff.sightRange || d >= bestDist) continue;
      if (this.hasLineOfSight(eye, e.pos, map)) {
        best = e;
        bestDist = d;
      }
    }

    if (best) {
      this.seenForSec = this.engagedId === best.id ? this.seenForSec + dt : 0;
      this.engagedId = best.id;
      const px = this.state.pos.x;
      const pz = this.state.pos.z;
      // Track the target with human-like lag + measure its lateral speed.
      this.updateAim(eye, best, dt);
      // Randomly reverse strafe direction so circling isn't perfectly periodic.
      this.strafeFlipTimer -= dt;
      if (this.strafeFlipTimer <= 0) {
        this.strafeSign *= -1;
        this.strafeFlipTimer = rand(1.2, 3);
      }
      const desired = this.combatMove(dt, best.pos, bestDist);
      const { blocked } = this.integrate(dt, map, desired);
      if (blocked) this.strafeSign *= -1; // bounce off walls
      this.updateLoco(px, pz, dt);
      // Face the target.
      const desiredFacing = Math.atan2(best.pos.x - this.state.pos.x, best.pos.z - this.state.pos.z);
      const lerpT = 1 - Math.exp(-BOT_FACING_LERP * dt);
      this.facing = lerpAngle(this.facing, desiredFacing, lerpT);
      this.applyFacing();
      // Fire once reaction time has elapsed and the weapon is off cooldown.
      if (this.seenForSec >= this.diff.reaction && this.shootCooldown <= 0) {
        // Jitter the cadence ±15% so bots don't fire on a metronome.
        this.shootCooldown = this.diff.fireCooldown * (0.85 + Math.random() * 0.3);
        return this.buildFireIntent(eye);
      }
      return null;
    }

    // ── No target: roam toward a wander point ──
    this.engagedId = null;
    this.seenForSec = 0;
    this.aimSeeded = false; // re-acquire aim from scratch on the next target
    this.lastTargetId = null;
    const px = this.state.pos.x;
    const pz = this.state.pos.z;
    this.roam(dt, map);
    this.updateLoco(px, pz, dt);
    return null;
  }

  // Chase a smoothed aim point toward the target (low aimTrack = laggy = misses
  // jukes) and estimate the target's lateral speed for the fire-time error cone.
  private updateAim(eye: Vec3, target: BotTarget, dt: number) {
    const tc = { x: target.pos.x, y: target.pos.y + BOT_HEIGHT * 0.5, z: target.pos.z };
    let lateral = 0;
    if (this.lastTargetId === target.id && dt > 1e-4) {
      const tvx = (target.pos.x - this.lastTargetPos.x) / dt;
      const tvz = (target.pos.z - this.lastTargetPos.z) / dt;
      // Lateral = the part of the target's velocity perpendicular to our aim
      // line (radial movement toward/away is trivial to hit with hitscan).
      const hx = tc.x - eye.x;
      const hz = tc.z - eye.z;
      const hlen = Math.hypot(hx, hz) || 1;
      const nx = hx / hlen;
      const nz = hz / hlen;
      const radial = tvx * nx + tvz * nz;
      lateral = Math.hypot(tvx - radial * nx, tvz - radial * nz);
    }
    this.lastTargetId = target.id;
    this.lastTargetPos = { x: target.pos.x, y: target.pos.y, z: target.pos.z };
    if (!this.aimSeeded) {
      this.aimPoint = { ...tc };
      this.aimSeeded = true;
    } else {
      const k = 1 - Math.exp(-this.diff.aimTrack * dt);
      this.aimPoint.x += (tc.x - this.aimPoint.x) * k;
      this.aimPoint.y += (tc.y - this.aimPoint.y) * k;
      this.aimPoint.z += (tc.z - this.aimPoint.z) * k;
    }
    this.lastLateralSpeed = this.lastLateralSpeed * 0.6 + lateral * 0.4; // light smoothing
  }

  // Integrate a desired horizontal displacement with gravity + auto-step. One
  // movePlayer pass resolves X/Z/Y; if a wall blocks us while grounded we retry
  // lifted by a step height so bots can climb ramps/cover instead of stalling.
  private integrate(dt: number, map: ArenaMap, desired: { x: number; z: number }): { blocked: boolean } {
    const size: Vec3 = { x: BOT_RADIUS * 2, y: BOT_HEIGHT, z: BOT_RADIUS * 2 };
    this.vel.y -= GRAVITY * dt;
    let r = movePlayer(this.state.pos, size, { x: desired.x, y: this.vel.y * dt, z: desired.z }, map.boxes);
    let blocked = r.blocked.x || r.blocked.z;
    if (blocked && this.onGround) {
      const STEP = 1.7; // clears the maps' 1.2–1.5m step-ramps + waist cover
      const up = movePlayer(this.state.pos, size, { x: 0, y: STEP, z: 0 }, map.boxes);
      const over = movePlayer(up.position, size, { x: desired.x, y: 0, z: desired.z }, map.boxes);
      if (!over.blocked.x && !over.blocked.z) {
        // Cleared at the raised height — settle back down onto the step top.
        r = movePlayer(over.position, size, { x: 0, y: -STEP, z: 0 }, map.boxes);
        blocked = false;
      }
    }
    this.state.pos = r.position;
    if (r.groundContact) {
      this.vel.y = 0;
      this.onGround = true;
    } else {
      if (r.blocked.y && this.vel.y > 0) this.vel.y = 0; // bonked a ceiling
      this.onGround = false;
    }
    this.group.position.set(this.state.pos.x, this.state.pos.y, this.state.pos.z);
    return { blocked };
  }

  // Drive the locomotion blend from how far the bot actually moved this tick.
  private updateLoco(prevX: number, prevZ: number, dt: number) {
    const moved = Math.hypot(this.state.pos.x - prevX, this.state.pos.z - prevZ);
    this.loco?.update(dt > 0 ? moved / dt : 0, dt);
  }

  private eyePos(): Vec3 {
    return {
      x: this.state.pos.x,
      y: this.state.pos.y + BOT_HEIGHT * BOT_EYE_FRAC,
      z: this.state.pos.z,
    };
  }

  // Raycast eye → target center against the map; blocked if a box is hit before
  // reaching the target.
  private hasLineOfSight(eye: Vec3, targetPos: Vec3, map: ArenaMap): boolean {
    const tc = { x: targetPos.x, y: targetPos.y + BOT_HEIGHT * 0.5, z: targetPos.z };
    const dx = tc.x - eye.x;
    const dy = tc.y - eye.y;
    const dz = tc.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    for (const b of map.boxes) {
      const t = rayAabb(eye, dir, b);
      if (t !== null && t > 0.05 && t < dist - 0.3) return false;
    }
    return true;
  }

  // Circle-strafe around the target; returns the desired horizontal displacement
  // for this tick (integrate() applies it with gravity + collision).
  private combatMove(dt: number, targetPos: Vec3, dist: number): { x: number; z: number } {
    const toX = targetPos.x - this.state.pos.x;
    const toZ = targetPos.z - this.state.pos.z;
    const len = Math.hypot(toX, toZ) || 1;
    const rx = toX / len; // unit vector toward target
    const rz = toZ / len;
    // radial component: + approach, - retreat, 0 hold
    let radial = 0;
    if (dist > COMBAT_RANGE_MAX) radial = 1;
    else if (dist < COMBAT_RANGE_MIN) radial = -1;
    // perpendicular (strafe) component
    const px = -rz * this.strafeSign;
    const pz = rx * this.strafeSign;
    const strafe = this.diff.combatStrafe;
    let mx = rx * radial * (1 - strafe) + px * strafe;
    let mz = rz * radial * (1 - strafe) + pz * strafe;
    const mlen = Math.hypot(mx, mz);
    if (mlen < 1e-3) {
      // Holding range with no strafe — drift sideways anyway.
      mx = px;
      mz = pz;
    } else {
      mx /= mlen;
      mz /= mlen;
    }
    const step = this.diff.moveSpeed * dt;
    return { x: mx * step, z: mz * step };
  }

  private roam(dt: number, map: ArenaMap) {
    const dx = this.target.x - this.state.pos.x;
    const dz = this.target.z - this.state.pos.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > 0.36) {
      const dist = Math.sqrt(distSq);
      const step = Math.min(dist, this.diff.moveSpeed * 0.7 * dt);
      const { blocked } = this.integrate(dt, map, { x: (dx / dist) * step, z: (dz / dist) * step });
      const desiredFacing = Math.atan2(dx, dz);
      const lerpT = 1 - Math.exp(-BOT_FACING_LERP * dt);
      this.facing = lerpAngle(this.facing, desiredFacing, lerpT);
      this.applyFacing();
      if (blocked) this.target = pickFreeSpot(map, null);
    } else {
      // Standing still: still integrate (gravity) so a bot left on a ledge settles.
      this.integrate(dt, map, { x: 0, z: 0 });
      this.state.moveTimer -= dt;
      if (this.state.moveTimer <= 0) {
        this.target = pickFreeSpot(map, null);
        this.state.moveTimer = rand(BOT_MOVE_INTERVAL_MIN, BOT_MOVE_INTERVAL_MAX);
      }
    }
  }

  // Fire at the SMOOTHED aim point (not the true target), so a laggy tracker
  // mis-leads a juking target. The error cone grows with the target's lateral
  // speed and occasionally whiffs entirely — moving targets are hard, and even
  // good bots flub a shot now and then.
  private buildFireIntent(eye: Vec3): BotFireIntent {
    let dx = this.aimPoint.x - eye.x;
    let dy = this.aimPoint.y - eye.y;
    let dz = this.aimPoint.z - eye.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    let e = this.diff.aimError + this.diff.moveErr * this.lastLateralSpeed;
    if (Math.random() < this.diff.whiffChance) e *= 4.5; // flubbed shot
    dx += tri(e);
    dy += tri(e);
    dz += tri(e);
    const l2 = Math.hypot(dx, dy, dz) || 1;
    return {
      botId: this.state.id,
      botName: this.state.name,
      origin: { ...eye },
      dir: { x: dx / l2, y: dy / l2, z: dz / l2 },
    };
  }

  kill() {
    if (!this.state.alive) return;
    this.state.alive = false;
    this.state.respawnTimer = BOT_RESPAWN_DELAY;
    if (this.mixer && this.actions.death) {
      this.dyingTimer = DEATH_ANIM_DURATION;
      this.loco?.stop(); // let the death clip play un-blended
      this.playOneShot('death');
    } else {
      this.dyingTimer = 0;
      this.group.visible = false;
    }
  }

  isHeadshot(hitY: number): boolean {
    return hitY >= this.state.pos.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD;
  }

  centerY(): number {
    return this.state.pos.y + BOT_HEIGHT * 0.5;
  }

  bounds(): { min: Vec3; max: Vec3 } {
    return {
      min: {
        x: this.state.pos.x - BOT_RADIUS,
        y: this.state.pos.y,
        z: this.state.pos.z - BOT_RADIUS,
      },
      max: {
        x: this.state.pos.x + BOT_RADIUS,
        y: this.state.pos.y + BOT_HEIGHT,
        z: this.state.pos.z + BOT_RADIUS,
      },
    };
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    if (this.fallbackBody) {
      this.fallbackBody.geometry.dispose();
      (this.fallbackBody.material as THREE.Material).dispose();
    }
    if (this.fallbackHead) {
      this.fallbackHead.geometry.dispose();
      (this.fallbackHead.material as THREE.Material).dispose();
    }
    const smMat = this.nameSprite.material as THREE.SpriteMaterial;
    smMat.map?.dispose();
    smMat.dispose();
    if (this.mixer) this.mixer.stopAllAction();
  }

  private installModel(model: BotModel) {
    const cloned = SkeletonUtils.clone(model.scene);
    // Defensive: force a clean rest transform regardless of what the
    // GLB's root node had baked in. The lean-back bug we saw was
    // partial axis writes leaving residual X/Z rotation in place.
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.setScalar(MODEL_SCALE);
    // Tag the whole subtree so Game.disposeScene() skips disposing the
    // shared geometry / materials / textures from the cached source.
    cloned.traverse((obj) => {
      obj.userData.shared = true;
    });
    this.group.add(cloned);
    this.modelRoot = cloned;
    this.mixer = new THREE.AnimationMixer(cloned);

    const idleClip = pickClip(model.animations, ['idle'], 0);
    const walkClip = pickClip(model.animations, ['walk', 'walking'], 3);
    const runClip = pickClip(model.animations, ['run', 'running'], 1);
    const jumpClip = pickClip(model.animations, ['jump']);
    const deathClip = pickClip(model.animations, ['death', 'die']);

    if (idleClip)  this.actions.idle  = this.mixer.clipAction(idleClip);
    if (walkClip)  this.actions.walk  = this.mixer.clipAction(walkClip);
    if (runClip)   this.actions.run   = this.mixer.clipAction(runClip);
    if (jumpClip)  this.actions.jump  = this.mixer.clipAction(jumpClip);
    if (deathClip) this.actions.death = this.mixer.clipAction(deathClip);

    this.loco = new LocomotionBlender({
      idle: this.actions.idle ?? null,
      walk: this.actions.walk ?? null,
      run: this.actions.run ?? null,
    });
  }

  private installFallback() {
    const bodyGeom = new THREE.CapsuleGeometry(
      BOT_RADIUS,
      BOT_HEIGHT - BOT_RADIUS * 2 - 0.35,
      4,
      16,
    );
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xff4d6d,
      emissive: 0x4a0e1c,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      metalness: 0.1,
    });
    this.fallbackBody = new THREE.Mesh(bodyGeom, bodyMat);
    this.fallbackBody.position.y = (BOT_HEIGHT - 0.35) / 2;
    this.group.add(this.fallbackBody);
    const headGeom = new THREE.SphereGeometry(BOT_RADIUS * 0.78, 16, 12);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffe3e8,
      emissive: 0x5a1226,
      emissiveIntensity: 0.4,
      roughness: 0.35,
    });
    this.fallbackHead = new THREE.Mesh(headGeom, headMat);
    this.fallbackHead.position.y = BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD + 0.12;
    this.group.add(this.fallbackHead);
  }

  private applyFacing() {
    if (this.modelRoot) {
      // Always set ALL axes — don't leave .x / .z dangling.
      this.modelRoot.rotation.set(0, this.facing + MODEL_YAW_OFFSET, 0);
    }
  }

  // Bright-enemy highlight: emissive glow only (reversible, leaves base colour
  // and textures intact). null = natural.
  setHighlight(color: THREE.Color | null) {
    this.group.traverse((obj) => {
      const m = (obj as THREE.Mesh).material;
      applyHighlight(m, color);
    });
  }

  private playOneShot(key: ActionKey) {
    if (!this.mixer) return;
    const a = this.actions[key];
    if (!a) return;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
  }
}

export class BotManager {
  bots: Bot[] = [];

  constructor(
    scene: THREE.Scene,
    map: ArenaMap,
    count: number,
    playerSpawn: Vec3,
    model: BotModel | null,
    difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  ) {
    const names = pickN(BOT_NAMES, count);
    for (let i = 0; i < count; i++) {
      const spawn = pickFreeSpot(map, playerSpawn);
      const bot = new Bot(`bot-${i}`, names[i] ?? `Bot${i}`, spawn, scene, model, difficulty);
      this.bots.push(bot);
    }
  }

  // Steps every bot and returns the fire intents they produced this tick.
  // `enemies` should include the local player and all bots (each bot skips
  // itself); Game resolves the returned shots against the world.
  step(dt: number, map: ArenaMap, enemies: BotTarget[]): BotFireIntent[] {
    const intents: BotFireIntent[] = [];
    for (const b of this.bots) {
      const intent = b.step(dt, map, enemies);
      if (intent) intents.push(intent);
    }
    return intents;
  }

  dispose(scene: THREE.Scene) {
    for (const b of this.bots) b.dispose(scene);
    this.bots.length = 0;
  }
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}
