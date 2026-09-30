import * as THREE from 'three';
import {
  AIR_JUMPS,
  BOOST_FORWARD_BIAS,
  BOOST_IMPULSE,
  BOT_DIFFICULTY,
  BOT_EYE_FRAC,
  BOT_HEADSHOT_THRESHOLD,
  BOT_HEIGHT,
  BOT_MOVE_INTERVAL_MAX,
  BOT_MOVE_INTERVAL_MIN,
  BOT_RADIUS,
  BOT_RESPAWN_DELAY,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_SPEED,
  DEFAULT_BOT_DIFFICULTY,
  GRAVITY,
  JUMP_SPEED,
  MAX_HORIZONTAL_SPEED,
  WALK_SPEED,
  type BotDifficulty,
} from './constants';
import { movePlayer, rayAabb, type ArenaMap } from './map';
import { CharacterAnimator, type CharacterAnimInput } from './character-anim';
import { Character, skinColorFor } from './character/character';
import { dyeById } from './dyes';
import { attachRailgun, disposeRailgun, type AttachedRailgun } from './character/gun';
import { floorBelow, type GibFloor } from './character/gibs';
import type { FootfallListener } from './locomotion';
import {
  BodyGear,
  applyFinishLook,
  asV3,
  createTauntAura,
  emoteKindOfLook,
  randomBotLoadout,
  resolveCosmetics,
  vfxHooks,
  type EyesLike,
  type TauntAuraLike,
} from './look-runtime';
import { emoteClip } from './emotes';
import { railgunFinishById, type KillEffectStyle } from './cosmetics';
import type { Loadout } from './items/types';
import type { BotState, EntityId, Vec3 } from './types';

const BOT_NAMES = ['Vex', 'Razor', 'Strafe', 'Pyro', 'Vandal', 'Frost', 'Pulse', 'Echo'];
const BOT_FACING_LERP = 12;
// Preferred engagement distance band — bots back off when closer than MIN and
// close the gap when farther than MAX, otherwise circle-strafe.
const COMBAT_RANGE_MIN = 8;
const COMBAT_RANGE_MAX = 18;

// ── Bot MOVEMENT difficulty table ────────────────────────────────────────────
// Local (NOT in constants.ts) per-difficulty tuning for the human-like movement
// layer: jumping, double-jumping, dashing, boosting, dodging and air control.
// This is purely about HOW a bot moves; aim/combat danger still comes from
// BOT_DIFFICULTY in constants.ts. Easy bots are clumsy and earthbound; hard bots
// are slippery — they double-jump, dash to close/juke, and rocket-boost to high
// ground. All probabilities are evaluated against a per-bot decision clock that
// ticks a few times a second so behaviour isn't re-rolled every 64Hz frame.
type BotMove = {
  decideInterval: number; // seconds between movement re-decisions (lower = twitchier)
  jumpChance: number;     // P(rhythm-breaking hop) when grounded & strafing in combat
  dodgeReact: number;     // P(dodge-jump) per decision when engaged at mid range / shot-at
  airJumpChance: number;  // P(spend an air jump) at the apex of a combat hop
  dashChance: number;     // P(dash) per decision to close distance or juke sideways
  boostChance: number;    // P(rocket-boost) per decision when it would gain height/escape
  boostCooldown: number;  // min seconds between boosts (slower than the player's)
  airControl: number;     // 0..1 how strongly air movement steers toward the wish dir
  jumpGapReach: number;   // P(hop) when roaming toward a higher/farther wander point
};
const BOT_MOVE: Record<BotDifficulty, BotMove> = {
  // Even Easy bots now visibly hop, dash, and rocket-boost around — just less
  // often and with looser air control so they're easier to read/punish.
  easy:   { decideInterval: 0.45, jumpChance: 0.30, dodgeReact: 0.30, airJumpChance: 0.25, dashChance: 0.18, boostChance: 0.10, boostCooldown: 5.0, airControl: 0.30, jumpGapReach: 0.45 },
  // Medium: bouncy and aggressive — hops/dashes constantly, regular double-jumps
  // and rocket-boosts for traversal and dodging.
  medium: { decideInterval: 0.34, jumpChance: 0.50, dodgeReact: 0.55, airJumpChance: 0.50, dashChance: 0.35, boostChance: 0.20, boostCooldown: 3.5, airControl: 0.55, jumpGapReach: 0.65 },
  // Hard: extremely slippery — near-constant air game: dodge-jumps, double-jumps,
  // dashes to juke, frequent boosts to high ground, strong air control to carve.
  hard:   { decideInterval: 0.26, jumpChance: 0.68, dodgeReact: 0.78, airJumpChance: 0.72, dashChance: 0.50, boostChance: 0.34, boostCooldown: 2.4, airControl: 0.82, jumpGapReach: 0.85 },
};

// An enemy a bot can target (the local player or another bot).
export type BotTarget = { id: string; pos: Vec3; team?: number | null };
// A bot's decision to fire this tick — resolved by Game against the world.
export type BotFireIntent = { botId: string; botName: string; origin: Vec3; dir: Vec3; team: number | null };
// The combatant faces -Z at identity. Movement direction comes back as
// atan2(dx, dz) which is 0 for wishdir +Z, so we add π to rotate the
// model's natural -Z forward around to match wishdir.
const MODEL_YAW_OFFSET = Math.PI;

// The character "model" is now built in code (see character/): there is no
// asset to load. BotModel stays as an opaque token so callers (Game, replays,
// the replay viewer) keep their load-then-spawn flow unchanged.
export type BotModel = { readonly kind: 'combatant' };
const COMBATANT_MODEL: BotModel = Object.freeze({ kind: 'combatant' as const });

// Resolves immediately. The URL (the old soldier.glb path) is ignored.
export async function loadBotModel(_url?: string): Promise<BotModel | null> {
  return COMBATANT_MODEL;
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

export function pickFreeSpot(
  map: ArenaMap,
  avoid: Vec3 | Vec3[] | null = null,
  radius = BOT_RADIUS,
): Vec3 {
  // Accept one point or many — spawn clear of EVERY live opponent, not just one,
  // so you don't drop into someone's crosshair.
  const avoidList = avoid == null ? [] : Array.isArray(avoid) ? avoid : [avoid];
  // Inset the sample box by the radius too, so we never sample flush to a wall.
  const xExt = (map.bounds.max.x - map.bounds.min.x) / 2 - 1.5 - radius;
  const zExt = (map.bounds.max.z - map.bounds.min.z) / 2 - 1.5 - radius;
  const cx = (map.bounds.min.x + map.bounds.max.x) / 2;
  const cz = (map.bounds.min.z + map.bounds.max.z) / 2;
  // Probe the WHOLE standing capsule, not just two ends — a box whose vertical
  // span sat between the old 0.5m / 1.7m samples would slip through and spawn the
  // player clipped inside cover. These heights span foot→head.
  const PROBE_YS = [0.15, 0.55, 0.95, 1.35, BOT_HEIGHT - 0.1];
  const clearAt = (x: number, z: number, y: number) =>
    PROBE_YS.every((dy) => !pointInsideAnyBox({ x, y: y + dy, z }, map, radius));
  let fallback: Vec3 | null = null;
  for (let i = 0; i < 48; i++) {
    const x = cx + (Math.random() - 0.5) * 2 * xExt;
    const z = cz + (Math.random() - 0.5) * 2 * zExt;
    const y = 0.05;
    if (clearAt(x, z, y)) {
      // First clear spot is a safe fallback; keep searching for one far from
      // every avoid point so we don't telefrag/stack on a live opponent.
      if (!fallback) fallback = { x, y, z };
      if (avoidList.every((a) => Math.hypot(x - a.x, z - a.z) > 5)) {
        return { x, y, z };
      }
    }
  }
  // A clear-but-near spot beats the old {0,0,0} fallback, which could land
  // inside a central monolith on Stadium/Hangar/Spire/Reactor/Crucible.
  if (fallback) return fallback;
  return { x: map.spawn.x, y: 0.05, z: map.spawn.z };
}

function makeNameSprite(name: string, color = '#ffd1d8'): THREE.Sprite {
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
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
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

// Emissive-only highlight for plain MeshStandardMaterials (the capsule
// fallback). The combatant recolours its armour via Character.setLook().
// Reversible: null clears the glow without touching base colours/textures.
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

export class Bot {
  state: BotState;
  group: THREE.Group;
  private gear: BodyGear | null = null;
  readonly loadout: Loadout = randomBotLoadout(); // random cosmetics for variety (solo)
  private tauntLeft = 0;
  private streak = 0;
  private tauntAura: TauntAuraLike | null = null; // an Unusual emote's aura while it plays
  private eyes: EyesLike | null = null; // Professional Killstreak eyes while on a streak
  private gun: AttachedRailgun | null = null; // third-person railgun (disposed with the bot)
  // Reused animator input (no per-frame allocation).
  private readonly animIn: CharacterAnimInput = { dt: 0, yaw: 0, pitch: 0, pos: new THREE.Vector3() };
  // Shared third-person animator (gait, aim, jump/land, gibs) — the same
  // implementation remote players use. Null on the capsule fallback.
  private anim: CharacterAnimator | null = null;
  private character: Character | null = null;
  // The combatant body (null on the capsule fallback) — for viewer-side
  // overlays such as the enemy outline.
  get body(): Character | null {
    return this.character;
  }
  private highlight: THREE.Color | null = null; // viewer's enemy-highlight colour
  private teamLook: string | null = null; // TDM team colour (overrides highlight)
  private lastMap: ArenaMap | null = null; // for the gib floor probe (visual only)
  private fallbackBody: THREE.Mesh | null = null;
  private fallbackHead: THREE.Mesh | null = null;
  private nameSprite: THREE.Sprite;
  private target: Vec3;
  private roamStuckTimer = 0; // accrues while a roaming bot makes no progress → forces an unstick
  private team: number | null = null; // TDM team (0/1); null in FFA/Duel — drives targeting + nameplate color
  private nameColor = '#ffd1d8'; // current nameplate color (team-tinted in TDM)
  private facing = 0;
  // Vertical physics so bots obey gravity (fall off ledges) and auto-step up
  // ramps/cover instead of being glued to the ground plane (#7).
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private onGround = false;
  // ── Human-like movement state (jump / double-jump / dash / boost) ──
  private mv: BotMove;
  private airJumpsLeft = AIR_JUMPS;     // reset to AIR_JUMPS on ground contact
  private decideTimer = 0;              // movement re-decision clock
  private dashTimer = 0;                // >0 while a dash burst is active
  private dashCooldown = 0;
  private dashDir: Vec3 = { x: 0, y: 0, z: 0 };
  private boostCooldown = 0;
  private wasOnGround = true;           // for landing-edge detection
  private shotAtTimer = 0;              // counts down after the bot is recently shot near; raises dodge reactivity
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
    this.mv = BOT_MOVE[difficulty];
    this.decideTimer = rand(0, this.mv.decideInterval); // desync decision clocks across bots
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
  step(dt: number, map: ArenaMap, enemies: BotTarget[], frozen = false): BotFireIntent | null {
    this.lastMap = map;
    const intent = this.stepLogic(dt, map, enemies, frozen);
    // Animate AFTER the body's transform is final for this tick (the animator
    // measures motion from the group position). The manager re-seats the hat
    // afterwards via updateHat().
    this.animate(dt);
    return intent;
  }

  private stepLogic(dt: number, map: ArenaMap, enemies: BotTarget[], frozen: boolean): BotFireIntent | null {
    // Countdown freeze: keep animating (idle, via animate()) but stay put — no
    // movement, decisions, or fire until the match goes live.
    if (frozen) {
      this.vel = { x: 0, y: 0, z: 0 };
      return null;
    }
    if (this.shootCooldown > 0) this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    // Movement timers (run while alive; harmless while dead since velocity is zeroed).
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.boostCooldown > 0) this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    if (this.shotAtTimer > 0) this.shotAtTimer = Math.max(0, this.shotAtTimer - dt);
    if (this.decideTimer > 0) this.decideTimer -= dt;

    if (!this.state.alive) {
      // Corpse phase: the gibs fly where the body burst, then the body hides
      // for the rest of the respawn delay (the delay itself is unchanged — it
      // keeps ticking through the corpse phase).
      if (this.group.visible && !(this.anim?.isDying() && !this.anim.deathDone())) {
        this.group.visible = false;
      }
      this.state.respawnTimer -= dt;
      if (this.state.respawnTimer <= 0) {
        const spot = pickFreeSpot(map, null);
        this.state.pos = spot;
        this.target = { ...spot };
        this.vel = { x: 0, y: 0, z: 0 };
        this.onGround = false;
        this.airJumpsLeft = AIR_JUMPS;
        this.dashTimer = 0;
        this.dashCooldown = 0;
        this.boostCooldown = 0;
        this.wasOnGround = true;
        this.shotAtTimer = 0;
        this.decideTimer = rand(0, this.mv.decideInterval);
        this.group.position.set(spot.x, spot.y, spot.z);
        this.state.alive = true;
        this.group.visible = true;
        this.state.moveTimer = rand(BOT_MOVE_INTERVAL_MIN, BOT_MOVE_INTERVAL_MAX);
        this.engagedId = null;
        this.seenForSec = 0;
        this.aimSeeded = false;
        this.lastTargetId = null;
        this.anim?.respawn(this.group.position); // clear the gibs, back to idle
        this.nameSprite.visible = !this.plateSuppressed;
      }
      return null;
    }

    // ── Acquire the nearest enemy that's in range AND in line of sight ──
    const eye = this.eyePos();
    let best: BotTarget | null = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      if (e.id === this.state.id) continue;
      // TDM: never acquire a teammate (friendly fire is off).
      if (this.team != null && e.team != null && e.team === this.team) continue;
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
      // Threat proxy: in a firefight at fighting range with reciprocal LOS, the
      // bot treats itself as "being shot at" — this keeps dodge reactivity high
      // for ~1s after the duel breaks (no external shot-at signal is available
      // without changing the public API / game.ts).
      if (bestDist < COMBAT_RANGE_MAX * 1.4) this.shotAtTimer = 1.0;
      // Track the target with human-like lag + measure its lateral speed.
      this.updateAim(eye, best, dt);
      // Randomly reverse strafe direction so circling isn't perfectly periodic.
      this.strafeFlipTimer -= dt;
      if (this.strafeFlipTimer <= 0) {
        this.strafeSign *= -1;
        this.strafeFlipTimer = rand(1.2, 3);
      }
      // Decide jumps/dashes/boosts BEFORE integrate so they fold into this tick.
      const toX = best.pos.x - this.state.pos.x;
      const toZ = best.pos.z - this.state.pos.z;
      const tlen = Math.hypot(toX, toZ) || 1;
      const perpX = (-toZ / tlen) * this.strafeSign;
      const perpZ = (toX / tlen) * this.strafeSign;
      this.decideCombatMove(bestDist, toX, toZ, perpX, perpZ);
      const desired = this.combatMove(dt, best.pos, bestDist);
      const { blocked } = this.integrate(dt, map, desired);
      if (blocked) this.strafeSign *= -1; // bounce off walls
      // Face the target (applied to the model by animate()).
      const desiredFacing = Math.atan2(best.pos.x - this.state.pos.x, best.pos.z - this.state.pos.z);
      const lerpT = 1 - Math.exp(-BOT_FACING_LERP * dt);
      this.facing = lerpAngle(this.facing, desiredFacing, lerpT);
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
    this.roam(dt, map);
    return null;
  }

  // Drive the shared third-person animator: gait from the measured motion, aim
  // pitch toward the (smoothed) aim point while engaged, jump/land/death
  // layers. Purely visual — the hitbox is the state.pos AABB.
  private animate(dt: number) {
    if (!this.anim || !this.group.visible) return;
    // Safety net: a finished gib burst never lingers (e.g. a death right
    // before a countdown freeze skips the corpse branch in stepLogic).
    if (!this.state.alive && this.anim.deathDone()) {
      this.group.visible = false;
      return;
    }
    let pitch = 0;
    if (this.state.alive && this.engagedId !== null && this.aimSeeded) {
      const eye = this.eyePos();
      const h = Math.hypot(this.aimPoint.x - eye.x, this.aimPoint.z - eye.z);
      pitch = Math.atan2(this.aimPoint.y - eye.y, h);
    }
    const ai = this.animIn;
    ai.dt = dt; ai.yaw = this.facing + MODEL_YAW_OFFSET; ai.pitch = pitch; ai.pos = this.group.position;
    this.anim.update(ai);
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
  //
  // `desired` is the AI's wished horizontal displacement for this tick (already
  // scaled by dt). On top of that this method now layers the human-like air
  // game: an active dash overrides horizontal travel with a flat burst; while
  // airborne the bot keeps a horizontal momentum vector and only partially
  // steers it toward the wish dir (air control), so jumps/boosts carry instead
  // of stopping dead; and a positive vel.y (from a jump/double-jump/boost) lofts
  // the bot up before gravity reclaims it. Landing resets the air-jump budget
  // (the jump/land pose is inferred from the motion by the shared animator).
  private integrate(dt: number, map: ArenaMap, desired: { x: number; z: number }): { blocked: boolean } {
    const size: Vec3 = { x: BOT_RADIUS * 2, y: BOT_HEIGHT, z: BOT_RADIUS * 2 };

    // Resolve the horizontal displacement to actually apply this tick.
    let hx: number;
    let hz: number;
    if (this.dashTimer > 0) {
      // Dash: a flat burst along the locked dash dir, independent of wishspeed.
      hx = this.dashDir.x * DASH_SPEED * dt;
      hz = this.dashDir.z * DASH_SPEED * dt;
    } else if (this.onGround) {
      // Grounded: move exactly as the AI wished; remember it as our momentum so
      // a subsequent jump launches with the speed we left the ground at.
      hx = desired.x;
      hz = desired.z;
      this.vel.x = dt > 1e-5 ? hx / dt : 0;
      this.vel.z = dt > 1e-5 ? hz / dt : 0;
    } else {
      // Airborne: carry horizontal momentum, steering it toward the wish dir by
      // the difficulty's air-control amount (partial, so jumps aren't free to
      // pivot but also aren't fully committed).
      const wishLen = Math.hypot(desired.x, desired.z);
      if (wishLen > 1e-5) {
        const wishVx = desired.x / dt;
        const wishVz = desired.z / dt;
        const k = this.mv.airControl;
        this.vel.x += (wishVx - this.vel.x) * k;
        this.vel.z += (wishVz - this.vel.z) * k;
      }
      const horiz = Math.hypot(this.vel.x, this.vel.z);
      if (horiz > MAX_HORIZONTAL_SPEED) {
        const scale = MAX_HORIZONTAL_SPEED / horiz;
        this.vel.x *= scale;
        this.vel.z *= scale;
      }
      hx = this.vel.x * dt;
      hz = this.vel.z * dt;
    }

    // Dash holds you on the ground plane (no fall during the burst), exactly
    // like the player's ground dash; otherwise gravity pulls vel.y down.
    if (this.dashTimer > 0) {
      this.vel.y = 0;
    } else {
      this.vel.y -= GRAVITY * dt;
    }

    let r = movePlayer(this.state.pos, size, { x: hx, y: this.vel.y * dt, z: hz }, map.boxes);
    let blocked = r.blocked.x || r.blocked.z;
    if (blocked && this.onGround) {
      const STEP = 1.7; // clears the maps' 1.2–1.5m step-ramps + waist cover
      const up = movePlayer(this.state.pos, size, { x: 0, y: STEP, z: 0 }, map.boxes);
      const over = movePlayer(up.position, size, { x: hx, y: 0, z: hz }, map.boxes);
      if (!over.blocked.x && !over.blocked.z) {
        // Cleared at the raised height — settle back down onto the step top.
        r = movePlayer(over.position, size, { x: 0, y: -STEP, z: 0 }, map.boxes);
        blocked = false;
      }
    }
    // Kill horizontal momentum into a wall so a bot doesn't smear along it.
    if (r.blocked.x) this.vel.x = 0;
    if (r.blocked.z) this.vel.z = 0;
    this.state.pos = r.position;
    if (r.groundContact) {
      this.vel.y = 0;
      this.onGround = true;
    } else {
      if (r.blocked.y && this.vel.y > 0) this.vel.y = 0; // bonked a ceiling
      this.onGround = false;
    }
    // Landing edge: refill the air-jump budget.
    if (this.onGround && !this.wasOnGround) this.airJumpsLeft = AIR_JUMPS;
    this.wasOnGround = this.onGround;
    this.group.position.set(this.state.pos.x, this.state.pos.y, this.state.pos.z);
    return { blocked };
  }

  // ── Movement actions ───────────────────────────────────────────────────────
  // Each sets velocity directly; integrate() applies it with collision next.

  // Ground jump (or wall-clearing hop). Launches straight up at JUMP_SPEED; the
  // animator picks the takeoff up from the motion.
  private doJump() {
    this.vel.y = JUMP_SPEED;
    this.onGround = false;
  }

  // Mid-air second hop — spends an air jump. Optionally redirect horizontal
  // momentum toward `dir` so a double-jump can also be a sideways dodge.
  private doAirJump(dir?: { x: number; z: number }) {
    if (this.airJumpsLeft <= 0) return false;
    this.airJumpsLeft -= 1;
    this.vel.y = JUMP_SPEED;
    if (dir) {
      const len = Math.hypot(dir.x, dir.z) || 1;
      const speed = Math.max(WALK_SPEED * 0.6, Math.hypot(this.vel.x, this.vel.z));
      this.vel.x = (dir.x / len) * speed;
      this.vel.z = (dir.z / len) * speed;
    }
    return true;
  }

  // Start a ground dash burst in the given horizontal direction.
  private doDash(dirX: number, dirZ: number) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return;
    this.dashDir = { x: dirX / len, y: 0, z: dirZ / len };
    this.dashTimer = DASH_DURATION;
    this.dashCooldown = DASH_COOLDOWN;
  }

  // Damage-free rocket-boost: a strong up+forward impulse along (toward target /
  // current heading) like the player's floor-boost, used to gain height or bail.
  // Bots take NO self-damage. Cancels downward velocity first so a falling bot
  // still gets the full launch.
  private doBoost(headX: number, headZ: number) {
    if (this.vel.y < 0) this.vel.y = 0;
    const len = Math.hypot(headX, headZ) || 1;
    const fx = headX / len;
    const fz = headZ / len;
    // Launch dir = straight up blended with the forward bias (mirrors the
    // player's floor boost: up AND forward for an arcing traversal).
    let dx = BOOST_FORWARD_BIAS * fx;
    let dy = 1;
    let dz = BOOST_FORWARD_BIAS * fz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    this.vel.x += dx * BOOST_IMPULSE;
    this.vel.y += dy * BOOST_IMPULSE;
    this.vel.z += dz * BOOST_IMPULSE;
    this.onGround = false;
    this.airJumpsLeft = AIR_JUMPS; // a boost refreshes the air jump, like the player's
    this.boostCooldown = this.mv.boostCooldown;
  }

  // Combat movement brain: pick + execute the per-tick jump/dash/boost on top of
  // the circle-strafe. Called once per combat tick BEFORE integrate so the
  // chosen impulses are folded into this tick's physics.
  private decideCombatMove(dist: number, toX: number, toZ: number, perpX: number, perpZ: number) {
    const len = Math.hypot(toX, toZ) || 1;
    const dirX = toX / len; // unit toward target
    const dirZ = toZ / len;
    // Threat is highest at mid range with a clear sightline (LOS is reciprocal —
    // if we see them, they see us) and ramps up further if we were recently
    // shot near. This gates the dodge reactivity.
    const midRange = dist > COMBAT_RANGE_MIN && dist < COMBAT_RANGE_MAX * 1.4;
    const threatened = midRange || this.shotAtTimer > 0;

    // The double-jump is checked EVERY tick (not on the decision clock) so a hop
    // can be followed by a second hop within its brief apex window — but it still
    // burns the per-decision roll budget so it isn't spammed.
    if (!this.onGround) {
      if (
        this.decideTimer <= 0 &&
        this.vel.y < JUMP_SPEED * 0.45 &&
        this.airJumpsLeft > 0 &&
        Math.random() < this.mv.airJumpChance
      ) {
        this.decideTimer = this.mv.decideInterval * (0.7 + Math.random() * 0.6);
        this.doAirJump({ x: perpX, z: perpZ });
      }
      return;
    }

    // Ground decisions: re-rolled only a few times per second so behaviour isn't
    // re-decided every frame (and so one roll governs a coherent movement burst).
    if (this.decideTimer > 0) return;
    this.decideTimer = this.mv.decideInterval * (0.7 + Math.random() * 0.6);

    // 1) Dodge-jump: when threatened, hop while strafing to throw off aim,
    //    redirecting momentum sideways (the dodge direction is the strafe perp).
    if (threatened && Math.random() < this.mv.dodgeReact) {
      this.vel.x = perpX * (WALK_SPEED * 0.9);
      this.vel.z = perpZ * (WALK_SPEED * 0.9);
      this.doJump();
      return;
    }
    // 2) Dash: close the gap when far, or juke sideways when in the band.
    if (this.dashCooldown <= 0 && this.dashTimer <= 0 && Math.random() < this.mv.dashChance) {
      if (dist > COMBAT_RANGE_MAX) this.doDash(dirX, dirZ);
      else this.doDash(perpX, perpZ);
      return;
    }
    // 3) Boost to high ground / dramatic reposition — sparingly.
    if (this.boostCooldown <= 0 && Math.random() < this.mv.boostChance) {
      // Boost away from the target (escape) at close range, toward otherwise.
      const bx = dist < COMBAT_RANGE_MIN ? -dirX : dirX;
      const bz = dist < COMBAT_RANGE_MIN ? -dirZ : dirZ;
      this.doBoost(bx, bz);
      return;
    }
    // 4) Plain rhythm-breaking hop while strafing.
    if (Math.random() < this.mv.jumpChance) {
      this.vel.x = perpX * (WALK_SPEED * 0.7);
      this.vel.z = perpZ * (WALK_SPEED * 0.7);
      this.doJump();
    }
  }

  // Roam movement brain: bots bounce, dash, and rocket-boost around the map even
  // with no target, so the movement reads as alive (not a ground shuffle).
  private decideRoamMove(dx: number, dz: number) {
    // Air: chain a double-jump near the apex for extra bounce.
    if (!this.onGround) {
      if (
        this.decideTimer <= 0 &&
        this.vel.y < JUMP_SPEED * 0.45 &&
        this.airJumpsLeft > 0 &&
        Math.random() < this.mv.airJumpChance * 0.8
      ) {
        this.decideTimer = this.mv.decideInterval * (0.7 + Math.random() * 0.6);
        this.doAirJump();
      }
      return;
    }
    if (this.decideTimer > 0) return;
    this.decideTimer = this.mv.decideInterval * (0.7 + Math.random() * 0.6);
    const dist = Math.hypot(dx, dz);
    const len = dist || 1;
    const higher = this.target.y - this.state.pos.y > 0.6; // wander point is up a ledge
    // Rocket-boost for traversal / to mount high ground — frequent enough to see.
    if (this.boostCooldown <= 0 && Math.random() < this.mv.boostChance * (higher ? 1.8 : 1.0)) {
      this.doBoost(dx / len, dz / len);
      return;
    }
    // Dash to cover ground.
    if (this.dashCooldown <= 0 && this.dashTimer <= 0 && dist > 2.5 && Math.random() < this.mv.dashChance) {
      this.doDash(dx / len, dz / len);
      return;
    }
    // Hop often while moving — strafe-jump feel, not just for ledges/gaps.
    if ((higher || dist > 1.5) && Math.random() < this.mv.jumpGapReach) {
      this.doJump();
    }
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
      // Maybe hop/boost to clear a gap or mount higher ground before moving.
      this.decideRoamMove(dx, dz);
      const step = Math.min(dist, this.diff.moveSpeed * 0.7 * dt);
      const beforeX = this.state.pos.x;
      const beforeZ = this.state.pos.z;
      const { blocked } = this.integrate(dt, map, { x: (dx / dist) * step, z: (dz / dist) * step });
      const desiredFacing = Math.atan2(dx, dz);
      const lerpT = 1 - Math.exp(-BOT_FACING_LERP * dt);
      this.facing = lerpAngle(this.facing, desiredFacing, lerpT);
      // Stuck recovery (anti stand-still glitch): if we INTENDED to move but barely
      // did (wedged on geometry, or aiming at an unreachable spot), accrue stuck
      // time; once it crosses the threshold, hop to clear the lip and pick a brand-
      // new target far from where we're jammed. Picking from `this.state.pos` (not
      // null) guarantees the new point is ≥5m away, so a bot can never re-pick its
      // own position and freeze. Re-picking only on `blocked` (old behavior) missed
      // the oscillate-in-place case, which is what left bots standing still.
      const moved = Math.hypot(this.state.pos.x - beforeX, this.state.pos.z - beforeZ);
      if (moved < step * 0.3) this.roamStuckTimer += dt;
      else this.roamStuckTimer = 0;
      if (this.roamStuckTimer > 0.5) {
        this.roamStuckTimer = 0;
        this.target = pickFreeSpot(map, this.state.pos);
        if (this.onGround) this.doJump(); // pop over whatever's blocking us
      } else if (blocked && this.onGround) {
        this.target = pickFreeSpot(map, this.state.pos);
      }
    } else {
      // Reached the wander point: settle briefly (gravity still applies so a bot on
      // a ledge falls), then pick the next one. The pause is short (see
      // BOT_MOVE_INTERVAL_*) so bots keep roaming instead of looking frozen.
      this.integrate(dt, map, { x: 0, z: 0 });
      this.roamStuckTimer = 0;
      this.state.moveTimer -= dt;
      if (this.state.moveTimer <= 0) {
        this.target = pickFreeSpot(map, this.state.pos);
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
      team: this.team,
    };
  }

  // TDM team assignment (null = FFA/Duel). `color` tints the nameplate so the
  // player can tell allies (green) from foes (team color) — required since
  // friendly fire is off. Rebuilds the name sprite with the new color.
  setTeam(team: number | null, color = '#ffd1d8') {
    this.team = team;
    // TDM: the armour wears the team colour too (identification > highlight).
    const look = team != null ? color : null;
    if (look !== this.teamLook) {
      this.teamLook = look;
      this.resolveLook();
    }
    if (color === this.nameColor) return;
    this.nameColor = color;
    const next = makeNameSprite(this.state.name, color);
    next.position.copy(this.nameSprite.position);
    this.group.remove(this.nameSprite);
    this.nameSprite.material.map?.dispose();
    this.nameSprite.material.dispose();
    this.nameSprite = next;
    this.group.add(this.nameSprite);
  }
  getTeam(): number | null {
    return this.team;
  }

  // The bot fired: its 3rd-person gun's claw flashes (in `railColor`) and the
  // coils recharge.
  notifyFire(railColor?: number) {
    this.gun?.notifyFire(railColor);
  }

  // World position of the 3rd-person gun's muzzle into `out` (null without a
  // gun) — where this bot's visible beam + discharge should start.
  gunMuzzle(out: THREE.Vector3): THREE.Vector3 | null {
    return this.gun && this.state.alive ? this.gun.muzzleWorld(out) : null;
  }

  // `style` = the killer's finisher (how this body breaks apart).
  kill(style?: KillEffectStyle) {
    if (!this.state.alive) return;
    this.state.alive = false;
    this.state.respawnTimer = BOT_RESPAWN_DELAY;
    // Instagib: the body bursts into its armour chunks where it stood; step()
    // hides it once they've shrunk away. Capsule fallback: vanish at once.
    let floor: GibFloor = null;
    if (this.onGround) floor = { y: this.state.pos.y };
    else if (this.lastMap) {
      const y = floorBelow(this.lastMap.boxes, this.state.pos.x, this.state.pos.y, this.state.pos.z);
      if (y !== null && this.state.pos.y - y < 4) floor = { y };
    }
    if (!this.anim?.die(floor, style)) this.group.visible = false;
    this.nameSprite.visible = false; // no floating name over the gibs
  }

  isHeadshot(hitY: number): boolean {
    return hitY >= this.state.pos.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD;
  }

  centerY(): number {
    return this.state.pos.y + BOT_HEIGHT * 0.5;
  }

  // Current smoothed look/aim yaw (radians) — sampled by the match recorder so
  // the Play-of-the-Match replay can re-orient a bot actor faithfully.
  getFacing(): number {
    return this.facing;
  }

  // Current aim pitch (radians, + up) toward the smoothed aim point while
  // engaged, else level — the same angle the body's aim layer uses. Sampled by
  // the match recorder so a killcam through this bot's eyes looks where it aimed.
  getAimPitch(): number {
    if (!this.state.alive || this.engagedId === null || !this.aimSeeded) return 0;
    const eye = this.eyePos();
    const h = Math.hypot(this.aimPoint.x - eye.x, this.aimPoint.z - eye.z);
    return Math.atan2(this.aimPoint.y - eye.y, h);
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

  // Animate the hat's unusual effect (the hat itself rides the head socket).
  updateHat(dt: number) {
    this.gear?.update(dt);
    this.eyes?.update?.(dt);
    this.tauntAura?.update(dt);
    if (this.tauntLeft > 0) {
      this.tauntLeft -= dt;
      const over = this.tauntLeft <= 0 || !this.state.alive;
      if (over) {
        this.anim?.playEmote(null);
        this.clearTauntAura();
      }
      // A non-gun emote hides the held railgun (it would ride the raised hand).
      if (this.gun && this.anim) this.gun.visible = over || this.anim.emoteShowsGun;
    }
  }

  // Killcam showcase: the nameplate stays off while this bot is on camera (a
  // respawn inside that window doesn't bring it back).
  private plateSuppressed = false;
  setPlateSuppressed(off: boolean) {
    this.plateSuppressed = off;
    this.nameSprite.visible = !off && this.state.alive;
  }

  get isTaunting(): boolean {
    return this.tauntLeft > 0 && this.state.alive;
  }

  // Play this bot's equipped emote (a brief victory taunt). Grounded only — a
  // taunting bot stands still (and stays a normal target).
  taunt(): boolean {
    if (!this.anim || !this.state.alive || !this.onGround || this.tauntLeft > 0) return false;
    const look = this.loadout.emote;
    const kind = emoteKindOfLook(look);
    this.anim.playEmote(kind, true);
    const dur = Math.min(emoteClip(kind).duration, 2.6);
    this.tauntLeft = dur;
    // An Unusual emote's aura (whole-body, on the character root).
    this.clearTauntAura();
    const aura = createTauntAura(look?.e);
    if (aura?.start && this.character) {
      this.character.root.add(aura.group);
      aura.start(dur);
      this.tauntAura = aura;
    } else {
      aura?.dispose();
    }
    return true;
  }

  private clearTauntAura() {
    if (!this.tauntAura) return;
    this.tauntAura.group.removeFromParent();
    this.tauntAura.dispose();
    this.tauntAura = null;
  }

  // Killstreak on the gun (sheen) — bots roll a random finish, some are killstreak-capable.
  setStreak(n: number) {
    if (n === this.streak) return;
    this.streak = n;
    if (this.gun) asV3(this.gun).setStreak?.(n);
    // Professional Killstreak: the eyes light from a 5-kill streak.
    const ks = this.loadout.finish?.k;
    const on = !!ks && n >= 5;
    if (on && !this.eyes && this.character) {
      this.eyes = vfxHooks.createKillstreakEyes?.(this.character.sockets.headTop, ks) ?? null;
    } else if (!on && this.eyes) {
      this.eyes.dispose();
      this.eyes = null;
    }
    this.eyes?.setStreak?.(n);
  }

  // Footfall events for synced footstep audio (see RemotePlayer).
  get footfalls(): number {
    return this.anim?.footfalls ?? 0;
  }
  set onFootfall(fn: FootfallListener | null) {
    if (this.anim) this.anim.onFootfall = fn;
  }

  dispose(scene: THREE.Scene) {
    this.gear?.dispose();
    this.eyes?.dispose();
    this.eyes = null;
    this.clearTauntAura();
    if (this.gun) disposeRailgun(this.gun); // per-bot gun geometry/materials
    this.gun = null;
    this.character?.dispose();
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
    this.anim?.dispose();
  }

  private installModel(_model: BotModel) {
    // The code-built combatant: one skinned mesh on a clean rig, the hat on
    // the helmet socket, the railgun in the right-hand socket.
    const ch = new Character({ colorHex: skinColorFor(this.state.name) });
    this.group.add(ch.root);
    this.character = ch;
    this.gear = new BodyGear(ch.sockets.headTop);
    this.gear.setLooks(this.loadout);
    const cos = resolveCosmetics(this.loadout);
    this.gun = attachRailgun(ch, railgunFinishById(cos.railgunFinish).data);
    applyFinishLook(this.gun, this.loadout.finish);
    // Gait, aim, gun hold, jumps/landings and gibs live in the animator — the
    // same one remote players use.
    this.anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
    this.resolveLook();
  }

  // Armour colour: TDM team colour > the viewer's enemy highlight > own dye / skin.
  private resolveLook() {
    const ch = this.character;
    if (!ch) return;
    if (this.teamLook) ch.setLook(this.teamLook, 'natural');
    else if (this.highlight) ch.setLook(this.highlight, 'highlight');
    else ch.wearDye(dyeById(this.loadout.dye?.d), skinColorFor(this.state.name));
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
    this.fallbackBody.castShadow = true;
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
    this.fallbackHead.castShadow = true;
    this.group.add(this.fallbackHead);
  }

  // Bright-enemy highlight (the viewer's chosen colour, full-bright armour).
  // null = the bot's natural skin. The capsule fallback keeps the old glow.
  setHighlight(color: THREE.Color | null) {
    if (color) (this.highlight ??= new THREE.Color()).copy(color);
    else this.highlight = null;
    if (this.fallbackBody) applyHighlight(this.fallbackBody.material, color);
    if (this.fallbackHead) applyHighlight(this.fallbackHead.material, color);
    this.resolveLook();
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
  step(dt: number, map: ArenaMap, enemies: BotTarget[], frozen = false): BotFireIntent[] {
    const intents: BotFireIntent[] = [];
    for (const b of this.bots) {
      const intent = b.step(dt, map, enemies, frozen);
      if (intent) intents.push(intent);
      b.updateHat(dt);
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
