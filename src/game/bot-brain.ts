// Bot brain — perception, aim, movement and tactics for one offline bot.
// THREE-free: bots.ts wraps it in a body, and scripts/bot-sim.ts runs it
// headless to QA the AI on every map.
//
// A frame of thinking:
//   perceive  — enemies inside the view cone with line of sight are *seen*
//               (noticed after a human reaction delay); gunfire, near misses
//               and close footsteps are *heard*; lost enemies are remembered
//               for a while; an enemy vanishing from the roster means they
//               died, which starts a spawn read.
//   decide    — fight the best noticed target (sticky, so aim doesn't flick
//               between enemies), else navigate toward a goal: hunt the last
//               known position, cover the spawn an enemy will likely use, or
//               patrol between power positions and hold them for a beat.
//   aim       — the crosshair is a yaw/pitch pair smoothed toward a *perceived*
//               target that trails the truth (trackLag, minus `lead`), with
//               slow wobble and flick over/undershoot that gets corrected. The
//               trigger is pulled when the crosshair covers where the bot
//               *believes* you are — so strafing genuinely beats it.
//   move      — nav-graph paths string-pulled into straight runs, jumps /
//               double jumps / boosts only where the map needs them,
//               acceleration-smoothed velocity (no instant direction flips),
//               strafing that probes for walls and ledges before it commits.
//
// All smoothing is frame-rate independent (exp / SmoothDamp on dt).

import type { ArenaMap } from './arena-map-data';
import { movePlayer, rayAabb } from './collision';
import {
  AIR_JUMPS,
  BOOST_FORWARD_BIAS,
  BOOST_IMPULSE,
  BOT_DIFFICULTY,
  BOT_EYE_FRAC,
  BOT_HEIGHT,
  BOT_RADIUS,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_SPEED,
  GRAVITY,
  JUMP_SPEED,
  MAX_HORIZONTAL_SPEED,
  PLAYER_RADIUS,
  type BotDifficulty,
  type BotSkill,
} from './constants';
import {
  LINK_BOOST,
  LINK_DOUBLE,
  LINK_JUMP,
  LINK_WALK,
  findPath,
  linkKey,
  linkKind,
  navFor,
  nearestNode,
  nodesNear,
  rankSpawns,
  walkable,
  type LinkKind,
  type NavGraph,
} from './bot-nav';
import type { Vec3 } from './types';

// An enemy a bot can target (the local player or another bot). `invuln` =
// spawn-protected: bots track but hold fire, like a person would.
export type BotTarget = { id: string; pos: Vec3; team?: number | null; invuln?: boolean };
// A shot the brain decided to take this tick (eye origin + unit direction).
export type BotShot = { origin: Vec3; dir: Vec3 };

// ── movement flavour ─────────────────────────────────────────────────────────
// How a bot moves in a fight: hops, dodges, dashes, boosts, air control. Rolled
// on a per-bot decision clock (a few times a second), never per frame.
type BotMove = {
  decideInterval: number; // seconds between movement re-decisions
  jumpChance: number; // P(rhythm-breaking hop) per decision while strafing
  dodgeReact: number; // P(dodge-jump) per decision when shot at / at fighting range
  airJumpChance: number; // P(spend the air jump) at the apex of a combat hop
  dashChance: number; // P(dash) per decision to close distance or juke
  boostChance: number; // P(rocket-boost) per decision in a fight
  boostCooldown: number; // min seconds between boosts
  airRate: number; // 1/s — how hard air movement steers toward the wish velocity
};
const BOT_MOVE: Record<BotDifficulty, BotMove> = {
  easy: { decideInterval: 0.5, jumpChance: 0.18, dodgeReact: 0.22, airJumpChance: 0.2, dashChance: 0.1, boostChance: 0.04, boostCooldown: 6, airRate: 2.5 },
  medium: { decideInterval: 0.38, jumpChance: 0.3, dodgeReact: 0.42, airJumpChance: 0.4, dashChance: 0.22, boostChance: 0.08, boostCooldown: 4, airRate: 4 },
  hard: { decideInterval: 0.3, jumpChance: 0.4, dodgeReact: 0.6, airJumpChance: 0.55, dashChance: 0.32, boostChance: 0.12, boostCooldown: 3, airRate: 6 },
};
// Path cost multipliers per link kind (walk, jump, double, boost, drop) — easy
// bots take the long way round rather than boost; hard bots use every route.
const KIND_COST: Record<BotDifficulty, readonly number[]> = {
  easy: [1, 1.6, 2.5, 3.5, 1.2],
  medium: [1, 1.2, 1.5, 1.8, 1],
  hard: [1, 1, 1.1, 1.2, 1],
};

const GROUND_RATE = 12; // 1/s — ground velocity response (≈ the player's snappy accel)
const TRAVERSE_AIR_RATE = 9; // 1/s — air steering while executing a planned jump
const RANGE_MIN = 8; // combat range band (m) with hysteresis
const RANGE_MAX = 20;
const PERCEIVE_DT = 0.05; // LOS/perception refresh (s) — 20 Hz, staggered per bot
const CHEST = BOT_HEIGHT * 0.62; // where bots aim on a body (upper chest)
const HEAD = BOT_HEIGHT * 0.9;
const EYE = BOT_HEIGHT * BOT_EYE_FRAC;
const TARGET_R = PLAYER_RADIUS;

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
function gauss(): number {
  // Irwin–Hall approximation (sum of 4 uniforms), unit variance.
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.732;
}
function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Critically damped smoothing (SmoothDamp, Game Programming Gems 4 §1.10):
// frame-rate independent, no overshoot, speed-capped. Returns the new value;
// the new velocity lands in sdVel.
let sdVel = 0;
function smoothDamp(cur: number, target: number, vel: number, time: number, maxSpeed: number, dt: number): number {
  const t = Math.max(1e-4, time);
  const omega = 2 / t;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = cur - target;
  const orig = target;
  const maxChange = maxSpeed * t;
  change = Math.max(-maxChange, Math.min(maxChange, change));
  const tgt = cur - change;
  const temp = (vel + omega * change) * dt;
  let v = (vel - omega * temp) * e;
  let out = tgt + (change + temp) * e;
  if (orig - cur > 0 === out > orig) {
    out = orig;
    v = dt > 0 ? (out - orig) / dt : 0;
  }
  sdVel = v;
  return out;
}

// What the bot knows about one enemy.
type Memory = {
  pos: Vec3; // last known position (feet)
  t: number; // brain clock when last seen/heard
  visible: boolean; // in sight right now
  noticeAt: number; // clock when a fresh sighting has been reacted to
  seen: boolean; // pos came from sight (vs. sound)
  checked: boolean; // we went to the last known spot and found nothing
};
// Every enemy's true motion, for velocity estimates and death detection.
type Track = { last: Vec3; vel: Vec3; frame: number };

type GoalKind = 'patrol' | 'hunt' | 'spawn' | 'local';
type Goal = { kind: GoalKind; node: number; look: Vec3 | null; hold: number; id?: string };

type Traverse = { kind: LinkKind; to: number; t: number; airJumped: boolean };

export type BrainStats = {
  shots: number;
  travOk: number;
  travFail: number;
  repaths: number;
  stuckSec: number;
  travFailKind: number[]; // per link kind (walk, jump, double, boost, drop)
  travOkKind: number[];
};

export class BotBrain {
  readonly id: string;
  readonly difficulty: BotDifficulty;
  readonly skill: BotSkill;
  private readonly mv: BotMove;
  team: number | null = null;

  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  onGround = false;
  // Crosshair / look direction. yaw = atan2(dx, dz) (0 looks down +z).
  yaw = 0;
  pitch = 0;
  private yawVel = 0;
  private pitchVel = 0;
  // Feed-forward: how fast the clean aim angles are moving (self-motion and
  // the perceived target's motion), so the smoothing adds no lag of its own.
  private ffYaw = NaN;
  private ffPitch = 0;
  private ffYawRate = 0;
  private ffPitchRate = 0;
  // The enemy currently being fought (null = navigating).
  engagedId: string | null = null;

  readonly stats: BrainStats = { shots: 0, travOk: 0, travFail: 0, repaths: 0, stuckSec: 0, travFailKind: [0, 0, 0, 0, 0], travOkKind: [0, 0, 0, 0, 0] };

  private clock = 0;
  private frame = 0;
  private nav: NavGraph | null = null;

  // Movement actions.
  private airJumpsLeft = AIR_JUMPS;
  private decideTimer: number;
  private dashTimer = 0;
  private dashCooldown = 0;
  private dashDir = { x: 0, z: 0 };
  private boostCooldown = 0;
  private lastBoostAt = -Infinity;
  private pendingAirJump = false; // a two-stage hop over an obstacle
  private brakeAir = false; // kill horizontal drift this tick (climbing past an overhang)
  private wasOnGround = true;

  // Perception.
  private perceiveTimer: number;
  private readonly mem = new Map<string, Memory>();
  private readonly track = new Map<string, Track>();
  private shotAtTimer = 0;
  private spawnReadAt = -Infinity; // clock of the last enemy death we noticed
  private deadAt = new Map<string, Vec3>(); // where enemies died (spawn-read avoid list)

  // Aim.
  private percId: string | null = null;
  private percIdFF: string | null = null;
  private perc: Vec3 = { x: 0, y: 0, z: 0 };
  private percVel: Vec3 = { x: 0, y: 0, z: 0 };
  private noiseYaw = 0;
  private noisePitch = 0;
  private flickYaw = 0;
  private flickPitch = 0;
  private clickT = -1;
  private offTargetT = 0;
  private shootCooldown = 0;
  private lookPoint: Vec3 | null = null; // where to look while not fighting
  private glanceT = 0;

  // Navigation.
  private goal: Goal | null = null;
  private path: number[] = [];
  private pathIdx = 0;
  private steerIdx = 0;
  private steerT = 0;
  private holdT = 0;
  private trav: Traverse | null = null;
  private travFails = 0;
  private readonly banned = new Map<number, number>(); // link key → clock expiry
  private bannedSet = new Set<number>();
  private progressBest = Infinity;
  private progressT = 0;
  private recentGoals: Vec3[] = [];
  private goalFails = 0;

  // Combat movement.
  private strafeSign = Math.random() < 0.5 ? -1 : 1;
  private jukeT: number;
  private flipCd = 0;
  private rangeMode: -1 | 0 | 1 = 0;
  private repositionT = rand(1.5, 3.5);
  private combatPath = false;

  private readonly scratchNear: number[] = [];

  constructor(id: string, spawn: Vec3, difficulty: BotDifficulty) {
    this.id = id;
    this.difficulty = difficulty;
    this.skill = BOT_DIFFICULTY[difficulty];
    this.mv = BOT_MOVE[difficulty];
    this.pos = { ...spawn };
    this.decideTimer = rand(0, this.mv.decideInterval);
    this.perceiveTimer = rand(0, PERCEIVE_DT);
    this.jukeT = rand(this.skill.juke[0], this.skill.juke[1]);
  }

  eye(): Vec3 {
    return { x: this.pos.x, y: this.pos.y + EYE, z: this.pos.z };
  }

  // Back to life at `spot`, knowing nothing, facing into the map.
  respawn(spot: Vec3, map: ArenaMap) {
    this.pos = { ...spot };
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.wasOnGround = true;
    this.airJumpsLeft = AIR_JUMPS;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.boostCooldown = 0;
    this.pendingAirJump = false;
    this.shotAtTimer = 0;
    this.decideTimer = rand(0, this.mv.decideInterval);
    this.mem.clear();
    this.track.clear();
    this.deadAt.clear();
    this.spawnReadAt = -Infinity;
    this.engagedId = null;
    this.percId = null;
    this.clickT = -1;
    this.offTargetT = 0;
    this.shootCooldown = 0;
    this.goal = null;
    this.path = [];
    this.trav = null;
    this.holdT = 0;
    this.combatPath = false;
    this.lookPoint = null;
    const c = map.bounds;
    this.yaw = Math.atan2((c.min.x + c.max.x) / 2 - spot.x, (c.min.z + c.max.z) / 2 - spot.z) + rand(-0.6, 0.6);
    this.pitch = 0;
    this.yawVel = 0;
    this.pitchVel = 0;
  }

  // Countdown freeze: stand still, keep nothing moving.
  freeze() {
    this.vel = { x: 0, y: 0, z: 0 };
  }

  // Gunfire from `origin` to `end` by `shooterId`: heard within hearing range;
  // a round that passes close is a near miss (the bot flinches toward it).
  hearShot(origin: Vec3, end: Vec3, shooterId: string, shooterTeam: number | null) {
    if (shooterId === this.id) return;
    if (this.team != null && shooterTeam != null && shooterTeam === this.team) return;
    const d = Math.hypot(origin.x - this.pos.x, origin.y - this.pos.y, origin.z - this.pos.z);
    // Near miss: distance from our chest to the beam segment.
    const c = { x: this.pos.x, y: this.pos.y + BOT_HEIGHT * 0.5, z: this.pos.z };
    const sx = end.x - origin.x;
    const sy = end.y - origin.y;
    const sz = end.z - origin.z;
    const l2 = sx * sx + sy * sy + sz * sz || 1;
    const t = Math.max(0, Math.min(1, ((c.x - origin.x) * sx + (c.y - origin.y) * sy + (c.z - origin.z) * sz) / l2));
    const miss = Math.hypot(origin.x + sx * t - c.x, origin.y + sy * t - c.y, origin.z + sz * t - c.z);
    const nearMiss = miss < 2.5 && d > 1;
    if (!nearMiss && d > this.skill.hearing) return;
    if (nearMiss) this.shotAtTimer = 1.2;
    // A heard shot is only roughly placed (better map sense = better guess).
    const fuzz = (1 - this.skill.tactics) * Math.min(6, d * 0.08);
    this.remember(shooterId, { x: origin.x + rand(-fuzz, fuzz), y: origin.y - EYE, z: origin.z + rand(-fuzz, fuzz) }, false);
    if (!this.engagedId && (nearMiss || Math.random() < 0.3 + this.skill.tactics * 0.6)) {
      // Glance toward it — and drop a lazy patrol to go look.
      this.lookPoint = { x: origin.x, y: origin.y, z: origin.z };
      this.glanceT = rand(0.8, 1.6);
      if (this.goal && (this.goal.kind === 'patrol' || this.goal.kind === 'local')) this.goal = null;
    }
  }

  private remember(id: string, pos: Vec3, seen: boolean) {
    let m = this.mem.get(id);
    if (!m) {
      m = { pos: { ...pos }, t: this.clock, visible: false, noticeAt: Infinity, seen, checked: false };
      this.mem.set(id, m);
      return;
    }
    if (m.visible) return;
    m.pos = { ...pos };
    m.t = this.clock;
    m.seen = seen;
    m.checked = false;
  }

  // ── main step ──────────────────────────────────────────────────────────────
  step(dt: number, map: ArenaMap, enemies: readonly BotTarget[]): BotShot | null {
    if (dt <= 0) return null;
    this.clock += dt;
    this.frame++;
    const nav = (this.nav = navFor(map));
    if (this.shootCooldown > 0) this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.boostCooldown > 0) this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    if (this.shotAtTimer > 0) this.shotAtTimer = Math.max(0, this.shotAtTimer - dt);
    if (this.flipCd > 0) this.flipCd -= dt;
    if (this.decideTimer > 0) this.decideTimer -= dt;
    if (this.banned.size) {
      for (const [k, exp] of this.banned) if (exp < this.clock) this.banned.delete(k);
      if (this.banned.size !== this.bannedSet.size) this.bannedSet = new Set(this.banned.keys());
    }

    this.perceive(dt, nav, enemies);
    const target = this.pickTarget(enemies);

    let wishX = 0;
    let wishZ = 0;
    let airRate = this.mv.airRate;
    if (target) {
      if (this.engagedId !== target.id) this.onEngage();
      this.engagedId = target.id;
      this.trackPerceived(dt, target);
      const w = this.combatWish(dt, nav, target);
      wishX = w.x;
      wishZ = w.z;
      if (this.combatPath && this.trav) airRate = TRAVERSE_AIR_RATE;
    } else {
      if (this.engagedId) this.onDisengage();
      this.engagedId = null;
      this.percId = null;
      const w = this.navigate(dt, nav);
      wishX = w.x;
      wishZ = w.z;
      if (this.trav) airRate = TRAVERSE_AIR_RATE;
    }

    this.updateAim(dt, target);
    this.integrate(dt, map, nav, wishX, wishZ, airRate);
    return target ? this.maybeFire(dt, nav, target) : null;
  }

  // ── perception ─────────────────────────────────────────────────────────────
  private perceive(dt: number, nav: NavGraph, enemies: readonly BotTarget[]) {
    const s = this.skill;
    this.perceiveTimer -= dt;
    const doLos = this.perceiveTimer <= 0;
    if (doLos) this.perceiveTimer = Math.max(0, this.perceiveTimer + PERCEIVE_DT);
    const eye = this.eye();
    const k = 1 - Math.exp(-12 * dt);
    for (const e of enemies) {
      if (e.id === this.id) continue;
      if (this.team != null && e.team != null && e.team === this.team) continue;
      // True motion (velocity estimate; only *used* through perception).
      let tr = this.track.get(e.id);
      if (!tr) {
        tr = { last: { ...e.pos }, vel: { x: 0, y: 0, z: 0 }, frame: this.frame };
        this.track.set(e.id, tr);
      } else {
        const jump = Math.hypot(e.pos.x - tr.last.x, e.pos.z - tr.last.z);
        if (jump > 6) {
          tr.vel.x = tr.vel.y = tr.vel.z = 0; // a respawn/teleport, not motion
        } else {
          tr.vel.x += ((e.pos.x - tr.last.x) / dt - tr.vel.x) * k;
          tr.vel.y += ((e.pos.y - tr.last.y) / dt - tr.vel.y) * k;
          tr.vel.z += ((e.pos.z - tr.last.z) / dt - tr.vel.z) * k;
        }
        tr.last.x = e.pos.x;
        tr.last.y = e.pos.y;
        tr.last.z = e.pos.z;
        tr.frame = this.frame;
      }
      const m = this.mem.get(e.id);
      if (m?.visible) {
        m.pos.x = e.pos.x;
        m.pos.y = e.pos.y;
        m.pos.z = e.pos.z;
        m.t = this.clock;
      }
      if (!doLos) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, e.pos.y - this.pos.y, dz);
      let vis = false;
      let central = true;
      if (dist <= s.sightRange) {
        const off = Math.abs(wrap(Math.atan2(dx, dz) - this.yaw));
        central = off <= s.fov * 0.5;
        const inView = off <= s.fov || dist <= s.nearSense || (m?.visible ?? false);
        if (inView) {
          vis =
            nav.index.segmentClear(eye, { x: e.pos.x, y: e.pos.y + CHEST, z: e.pos.z }, 0.3) ||
            nav.index.segmentClear(eye, { x: e.pos.x, y: e.pos.y + HEAD, z: e.pos.z }, 0.2);
        }
      }
      if (vis) {
        let mm = m;
        if (!mm) {
          mm = { pos: { ...e.pos }, t: this.clock, visible: false, noticeAt: Infinity, seen: true, checked: false };
          this.mem.set(e.id, mm);
        }
        if (!mm.visible) {
          // Fresh sighting → a human reaction beat. Faster when we were already
          // expecting them (heard/seen them moments ago), slower in the corner
          // of the eye.
          const expecting = m !== undefined && this.clock - m.t < 1.5;
          let r = s.reaction * rand(0.8, 1.25);
          if (expecting) r *= 0.65;
          if (!central) r *= 1.35;
          mm.noticeAt = this.clock + r;
        }
        mm.visible = true;
        mm.seen = true;
        mm.checked = false;
        mm.pos = { ...e.pos };
        mm.t = this.clock;
      } else {
        if (m) m.visible = false;
        // Footsteps: a running enemy close by is heard through walls.
        const speed = Math.hypot(tr.vel.x, tr.vel.z);
        if (dist < s.nearSense * 2 && speed > 4 && Math.abs(tr.vel.y) < 2) this.remember(e.id, e.pos, false);
      }
    }
    // Enemies gone from the roster died (or left): forget them, and note it for
    // a spawn read.
    for (const [id, tr] of this.track) {
      if (tr.frame === this.frame) continue;
      this.track.delete(id);
      // (The killfeed tells everyone, so every death is known.)
      this.mem.delete(id);
      this.spawnReadAt = this.clock;
      this.deadAt.set(id, { ...tr.last });
      if (!this.engagedId && this.goal && (this.goal.kind === 'patrol' || this.goal.kind === 'local')) this.goal = null;
    }
    // Forget stale memories.
    for (const [id, m] of this.mem) {
      if (!m.visible && this.clock - m.t > s.memory) this.mem.delete(id);
    }
  }

  private pickTarget(enemies: readonly BotTarget[]): BotTarget | null {
    let best: BotTarget | null = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      const m = this.mem.get(e.id);
      if (!m || !m.visible || this.clock < m.noticeAt) continue;
      if (this.team != null && e.team != null && e.team === this.team) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, e.pos.y - this.pos.y, dz);
      const off = Math.abs(wrap(Math.atan2(dx, dz) - this.yaw));
      let score = dist + off * 10;
      if (e.id === this.engagedId) score -= 12; // stick with the current fight
      if (e.invuln) score += 25;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  private onEngage() {
    this.clickT = -1;
    this.offTargetT = 0;
    this.combatPath = false;
    this.repositionT = rand(1.2, 3);
    this.holdT = 0;
  }

  private onDisengage() {
    // Lost the target: go hunt where it was (navigate() picks it up), and keep
    // aiming there for a moment — you'd keep your crosshair on the corner.
    this.goal = null;
    this.combatPath = false;
    this.path = [];
    this.trav = null;
  }

  // ── aim ────────────────────────────────────────────────────────────────────
  // The bot's belief about where its target is: an exponential trail of the
  // truth (trackLag) plus a lead on the trailing velocity estimate.
  private trackPerceived(dt: number, target: BotTarget) {
    const tr = this.track.get(target.id);
    const v = tr?.vel ?? { x: 0, y: 0, z: 0 };
    if (this.percId !== target.id) {
      this.percId = target.id;
      this.perc = { ...target.pos };
      this.percVel = { x: v.x * 0.5, y: 0, z: v.z * 0.5 };
      // Flick: a fast move that lands a bit off (usually short), then corrects.
      const eye = this.eye();
      const dy = wrap(Math.atan2(target.pos.x - eye.x, target.pos.z - eye.z) - this.yaw);
      const h = Math.hypot(target.pos.x - eye.x, target.pos.z - eye.z);
      const dp = Math.atan2(target.pos.y + CHEST - eye.y, h) - this.pitch;
      const fe = this.skill.flickErr;
      this.flickYaw = -dy * fe * rand(-0.4, 1) + tri(0.01);
      this.flickPitch = -dp * fe * rand(-0.5, 1) + tri(0.008);
      return;
    }
    const k = 1 - Math.exp(-dt / this.skill.trackLag);
    this.perc.x += (target.pos.x - this.perc.x) * k;
    this.perc.y += (target.pos.y - this.perc.y) * k;
    this.perc.z += (target.pos.z - this.perc.z) * k;
    this.percVel.x += (v.x - this.percVel.x) * k;
    this.percVel.y += (v.y - this.percVel.y) * k;
    this.percVel.z += (v.z - this.percVel.z) * k;
  }

  private aimPoint(): Vec3 {
    const lead = this.skill.trackLag * this.skill.lead;
    return {
      x: this.perc.x + this.percVel.x * lead,
      y: this.perc.y + CHEST + Math.max(-2, Math.min(2, this.percVel.y * lead * 0.5)),
      z: this.perc.z + this.percVel.z * lead,
    };
  }

  private updateAim(dt: number, target: BotTarget | null) {
    const s = this.skill;
    const eye = this.eye();
    // Slow wobble (Ornstein–Uhlenbeck): worse on the move and in the air.
    const selfSpeed = Math.hypot(this.vel.x, this.vel.z);
    const shake = 1 + Math.min(1, selfSpeed / 9) * 0.35 + (this.onGround ? 0 : 0.5) + (this.shotAtTimer > 0 ? 0.25 : 0);
    const theta = 3;
    const sigma = s.aimNoise * shake * Math.sqrt(2 * theta);
    const sq = Math.sqrt(dt);
    this.noiseYaw += -theta * this.noiseYaw * dt + sigma * sq * gauss();
    this.noisePitch += -theta * this.noisePitch * dt + sigma * 0.7 * sq * gauss();
    const settle = Math.exp((-0.7 / s.aimTime) * dt);
    this.flickYaw *= settle;
    this.flickPitch *= settle;

    let wantYaw = this.yaw;
    let wantPitch = 0;
    let time = s.aimTime;
    let maxSpeed = s.aimSpeed;
    let ffY = 0;
    let ffP = 0;
    if (target && this.clock >= (this.mem.get(target.id)?.noticeAt ?? Infinity)) {
      const p = this.aimPoint();
      const h = Math.hypot(p.x - eye.x, p.z - eye.z);
      const cleanYaw = Math.atan2(p.x - eye.x, p.z - eye.z);
      const cleanPitch = Math.atan2(p.y - eye.y, h);
      // Track the clean angles' rate (people compensate their own movement and
      // follow a smooth target without trailing it; the trailing is modelled
      // by the perceived target instead).
      if (Number.isNaN(this.ffYaw) || this.percIdFF !== target.id) {
        this.ffYawRate = 0;
        this.ffPitchRate = 0;
        this.percIdFF = target.id;
      } else {
        const k = 1 - Math.exp(-20 * dt);
        this.ffYawRate += (wrap(cleanYaw - this.ffYaw) / dt - this.ffYawRate) * k;
        this.ffPitchRate += ((cleanPitch - this.ffPitch) / dt - this.ffPitchRate) * k;
      }
      this.ffYaw = cleanYaw;
      this.ffPitch = cleanPitch;
      ffY = Math.max(-4, Math.min(4, this.ffYawRate)) * time;
      ffP = Math.max(-4, Math.min(4, this.ffPitchRate)) * time;
      wantYaw = cleanYaw + this.noiseYaw + this.flickYaw;
      wantPitch = cleanPitch + this.noisePitch + this.flickPitch;
    } else {
      this.ffYaw = NaN;
      // Casual look: at a point of interest, else along the way we're moving.
      time = Math.max(0.22, s.aimTime * 2);
      maxSpeed = s.aimSpeed * 0.6;
      if (this.glanceT > 0) this.glanceT -= dt;
      const lp = this.lookPoint;
      if (lp && (this.glanceT > 0 || this.goal?.look === lp || this.holdT > 0)) {
        const h = Math.hypot(lp.x - eye.x, lp.z - eye.z);
        if (h > 0.5) {
          wantYaw = Math.atan2(lp.x - eye.x, lp.z - eye.z) + this.noiseYaw;
          wantPitch = Math.atan2(lp.y - eye.y, h) * 0.8;
        }
      } else {
        const sp = Math.hypot(this.vel.x, this.vel.z);
        const steer = this.steerPoint();
        if (steer) {
          const h = Math.hypot(steer.x - eye.x, steer.z - eye.z);
          if (h > 1) {
            wantYaw = Math.atan2(steer.x - eye.x, steer.z - eye.z);
            wantPitch = Math.max(-0.35, Math.min(0.35, Math.atan2(steer.y + EYE - eye.y, Math.max(h, 6)))) * 0.6;
          }
        } else if (sp > 1.5) {
          wantYaw = Math.atan2(this.vel.x, this.vel.z);
        }
      }
    }
    const targetYaw = this.yaw + wrap(wantYaw + ffY - this.yaw);
    this.yaw = smoothDamp(this.yaw, targetYaw, this.yawVel, time, maxSpeed, dt);
    this.yawVel = sdVel;
    this.yaw = wrap(this.yaw);
    wantPitch = Math.max(-1.3, Math.min(1.3, wantPitch + ffP));
    this.pitch = smoothDamp(this.pitch, wantPitch, this.pitchVel, time, maxSpeed, dt);
    this.pitchVel = sdVel;
  }

  private aimDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return { x: Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: Math.cos(this.yaw) * cp };
  }

  // Pull the trigger when the crosshair covers where we *believe* the target
  // is (after a human click delay), or — past our patience — take a hopeful
  // shot if we're at least close.
  private maybeFire(dt: number, nav: NavGraph, target: BotTarget): BotShot | null {
    const m = this.mem.get(target.id);
    if (!m || this.clock < m.noticeAt) return null;
    if (this.shootCooldown > 0 || target.invuln) {
      this.clickT = -1;
      this.offTargetT = 0;
      return null;
    }
    const s = this.skill;
    const eye = this.eye();
    const dir = this.aimDir();
    let fire = false;
    if (this.clickT >= 0) {
      this.clickT -= dt;
      if (this.clickT <= 0) fire = true;
    } else {
      const tol = s.fireTol;
      const c = this.perc;
      const box = {
        min: { x: c.x - TARGET_R - tol, y: c.y - tol * 0.5, z: c.z - TARGET_R - tol },
        max: { x: c.x + TARGET_R + tol, y: c.y + BOT_HEIGHT + tol * 0.5, z: c.z + TARGET_R + tol },
      };
      const onTarget = rayAabb(eye, dir, box) !== null;
      if (onTarget) {
        this.clickT = rand(s.clickDelay[0], s.clickDelay[1]);
      } else {
        this.offTargetT += dt;
        if (this.offTargetT > s.patience) {
          // Close enough to be worth a try?
          const p = this.aimPoint();
          const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) || 1;
          const cosErr = ((p.x - eye.x) * dir.x + (p.y - eye.y) * dir.y + (p.z - eye.z) * dir.z) / d;
          const err = Math.acos(Math.max(-1, Math.min(1, cosErr)));
          if (err < Math.atan((TARGET_R + tol) / d) * 3 + 0.01) fire = true;
        }
      }
    }
    if (!fire) return null;
    // Don't waste the shot into a wall that sprang up between us.
    if (!nav.index.segmentClear(eye, { x: eye.x + dir.x * 2, y: eye.y + dir.y * 2, z: eye.z + dir.z * 2 })) {
      this.clickT = -1;
      return null;
    }
    this.clickT = -1;
    this.offTargetT = 0;
    this.shootCooldown = s.fireCooldown * rand(0.92, 1.12);
    this.stats.shots++;
    return { origin: eye, dir };
  }

  // ── combat movement ────────────────────────────────────────────────────────
  private combatWish(dt: number, nav: NavGraph, target: BotTarget): { x: number; z: number } {
    const s = this.skill;
    const toX = target.pos.x - this.pos.x;
    const toZ = target.pos.z - this.pos.z;
    const dist = Math.hypot(toX, toZ) || 1;
    const rx = toX / dist;
    const rz = toZ / dist;

    // Tactical reposition: take higher ground that still sees the target.
    this.repositionT -= dt;
    if (this.combatPath) {
      if (this.pathIdx >= this.path.length) this.combatPath = false;
      else {
        const w = this.followPath(dt, nav, s.strafeSpeed + 1);
        if (this.combatPath) return w;
      }
    } else if (this.repositionT <= 0 && this.onGround) {
      this.repositionT = rand(2.5, 4.5);
      if (Math.random() < s.tactics * 0.6 && this.planReposition(nav, target)) {
        return this.followPath(dt, nav, s.strafeSpeed + 1);
      }
    }

    // Range band with hysteresis (no dithering at the edges).
    if (this.rangeMode === 0) {
      if (dist > RANGE_MAX + 3) this.rangeMode = 1;
      else if (dist < RANGE_MIN - 1.5) this.rangeMode = -1;
    } else if (this.rangeMode === 1 && dist < RANGE_MAX - 1) this.rangeMode = 0;
    else if (this.rangeMode === -1 && dist > RANGE_MIN + 1.5) this.rangeMode = 0;

    // ADAD rhythm: reverse the strafe on a jittered timer.
    this.jukeT -= dt;
    if (this.jukeT <= 0) {
      this.strafeSign = -this.strafeSign as 1 | -1;
      this.jukeT = rand(s.juke[0], s.juke[1]);
    }

    const dirFor = (sign: number) => {
      let x = -rz * sign * 0.85 + rx * this.rangeMode * 0.75;
      let z = rx * sign * 0.85 + rz * this.rangeMode * 0.75;
      const l = Math.hypot(x, z) || 1;
      x /= l;
      z /= l;
      return { x, z };
    };
    let d = dirFor(this.strafeSign);
    if (!this.moveSafe(nav, d.x, d.z)) {
      const flipped = dirFor(-this.strafeSign);
      if (this.flipCd <= 0 && this.moveSafe(nav, flipped.x, flipped.z)) {
        this.strafeSign = -this.strafeSign as 1 | -1;
        this.jukeT = rand(s.juke[0], s.juke[1]);
        this.flipCd = 0.4;
        d = flipped;
      } else if (this.rangeMode !== 0 && this.moveSafe(nav, rx * this.rangeMode, rz * this.rangeMode)) {
        d = { x: rx * this.rangeMode, z: rz * this.rangeMode };
      } else {
        d = { x: 0, z: 0 };
      }
    }
    this.decideCombatMove(nav, dist, rx, rz, d.x, d.z);
    return { x: d.x * s.strafeSpeed, z: d.z * s.strafeSpeed };
  }

  // A short path to a better spot: higher, still sighting the target, at a
  // sane range, not far from here.
  private planReposition(nav: NavGraph, target: BotTarget): boolean {
    const here = nearestNode(nav, this.pos, 4);
    if (here < 0) return false;
    const heightNow = this.pos.y - target.pos.y;
    const near = nodesNear(nav, this.pos.x, this.pos.z, 12, this.scratchNear);
    let best = -1;
    let bestScore = Math.max(0, heightNow) * 1.2 + 1.5; // must beat staying put
    const tc = { x: target.pos.x, y: target.pos.y + CHEST, z: target.pos.z };
    for (let k = 0; k < 14 && near.length; k++) {
      const id = near[Math.floor(Math.random() * near.length)];
      const n = nav.nodes[id];
      if (!n.core) continue;
      const dy = n.y - target.pos.y;
      const r = Math.hypot(n.x - target.pos.x, n.z - target.pos.z);
      if (r < RANGE_MIN || r > RANGE_MAX + 10) continue;
      const score = Math.max(0, Math.min(6, dy)) * 1.2 + n.vis * 1.5 - Math.abs(r - 15) * 0.05;
      if (score <= bestScore) continue;
      if (!nav.index.segmentClear({ x: n.x, y: n.y + EYE, z: n.z }, tc, 0.3)) continue;
      best = id;
      bestScore = score;
    }
    if (best < 0) return false;
    const path = findPath(nav, here, best, { kindCost: KIND_COST[this.difficulty], banned: this.bannedSet, maxExpand: 600 });
    if (!path || path.length < 2) return false;
    this.setPath(path);
    this.combatPath = true;
    return true;
  }

  // Would a step in (dx, dz) keep us on solid, unobstructed ground?
  private moveSafe(nav: NavGraph, dx: number, dz: number): boolean {
    if (!this.onGround) return true;
    if (dx === 0 && dz === 0) return true;
    const px = this.pos.x + dx * 1.3;
    const pz = this.pos.z + dz * 1.3;
    if (!nav.index.capsuleFree(px, this.pos.y + 0.05, pz, BOT_RADIUS * 0.9, BOT_HEIGHT - 0.1)) return false;
    const g = nav.index.groundBelow(px, pz, this.pos.y + 0.05, BOT_RADIUS * 0.4);
    return this.pos.y - g < 1.2;
  }

  // Combat hops / dodges / dashes / boosts on top of the strafe.
  private decideCombatMove(nav: NavGraph, dist: number, rx: number, rz: number, mx: number, mz: number) {
    const mv = this.mv;
    const threatened = (dist > RANGE_MIN && dist < RANGE_MAX * 1.4) || this.shotAtTimer > 0;
    if (!this.onGround) {
      if (this.decideTimer <= 0 && this.vel.y < JUMP_SPEED * 0.45 && this.airJumpsLeft > 0 && Math.random() < mv.airJumpChance) {
        this.decideTimer = mv.decideInterval * rand(0.7, 1.3);
        this.doAirJump(mx, mz);
      }
      return;
    }
    if (this.decideTimer > 0) return;
    this.decideTimer = mv.decideInterval * rand(0.7, 1.3);
    const moving = mx !== 0 || mz !== 0;
    const dodge = this.shotAtTimer > 0 ? mv.dodgeReact : mv.dodgeReact * 0.5;
    if (threatened && moving && Math.random() < dodge) {
      this.doJump();
      return;
    }
    if (this.dashCooldown <= 0 && this.dashTimer <= 0 && Math.random() < mv.dashChance) {
      const far = dist > RANGE_MAX;
      const ddx = far ? rx : mx;
      const ddz = far ? rz : mz;
      if ((ddx !== 0 || ddz !== 0) && this.dashSafe(nav, ddx, ddz)) {
        this.doDash(ddx, ddz);
        return;
      }
    }
    if (this.boostCooldown <= 0 && Math.random() < mv.boostChance) {
      // Boost off the floor over the fight (away when too close).
      const away = dist < RANGE_MIN;
      const bx = moving ? mx : away ? -rx : rx;
      const bz = moving ? mz : away ? -rz : rz;
      if (nav.index.capsuleFree(this.pos.x, this.pos.y + 0.05, this.pos.z, BOT_RADIUS, BOT_HEIGHT + 6)) {
        this.doBoost(bx, bz);
        return;
      }
    }
    if (moving && Math.random() < mv.jumpChance) this.doJump();
  }

  private dashSafe(nav: NavGraph, dx: number, dz: number): boolean {
    const l = Math.hypot(dx, dz) || 1;
    const reach = DASH_SPEED * DASH_DURATION + 0.6;
    for (const f of [0.5, 1]) {
      const px = this.pos.x + (dx / l) * reach * f;
      const pz = this.pos.z + (dz / l) * reach * f;
      if (!nav.index.capsuleFree(px, this.pos.y + 0.05, pz, BOT_RADIUS * 0.9, BOT_HEIGHT - 0.1)) return false;
      if (this.pos.y - nav.index.groundBelow(px, pz, this.pos.y + 0.05, BOT_RADIUS * 0.4) > 1.2) return false;
    }
    return true;
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  private navigate(dt: number, nav: NavGraph): { x: number; z: number } {
    // Holding a spot: scan, then move on.
    if (this.holdT > 0) {
      this.holdT -= dt;
      this.glanceT -= dt;
      if (this.glanceT <= 0) this.pickGlance(nav);
      if (this.holdT > 0) return { x: 0, z: 0 };
      this.goal = null;
    }
    if (!this.goal || this.pathIdx >= this.path.length) {
      if (this.goal && this.pathIdx >= this.path.length) this.arrive(nav);
      if (this.holdT > 0) return { x: 0, z: 0 };
      this.chooseGoal(nav);
      if (!this.goal) return { x: 0, z: 0 };
    }
    // A hunt whose quarry has moved on (fresh info): re-plan toward it.
    const g = this.goal;
    if (g.kind === 'hunt' && g.id) {
      const m = this.mem.get(g.id);
      if (!m) {
        this.goal = null;
        return { x: 0, z: 0 };
      }
      const gn = nav.nodes[g.node];
      if (Math.hypot(m.pos.x - gn.x, m.pos.z - gn.z) > 6 && this.onGround) {
        this.goal = null;
        return { x: 0, z: 0 };
      }
      if (this.skill.tactics >= 0.35 && g.look) {
        g.look.x = m.pos.x;
        g.look.y = m.pos.y + CHEST;
        g.look.z = m.pos.z;
      }
    }
    // Pre-aim: look at where we expect trouble once it's roughly ahead.
    if (g.look && this.skill.tactics >= 0.35) {
      const dx = g.look.x - this.pos.x;
      const dz = g.look.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const mvYaw = Math.hypot(this.vel.x, this.vel.z) > 1 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw;
      const ahead = Math.abs(wrap(Math.atan2(dx, dz) - mvYaw)) < 1.6;
      this.lookPoint = ahead && d < 45 ? g.look : this.glanceT > 0 ? this.lookPoint : null;
    } else if (this.glanceT <= 0) {
      this.lookPoint = null;
    }
    const speed = g.kind === 'patrol' || g.kind === 'local' ? this.skill.moveSpeed * 0.9 : this.skill.moveSpeed;
    return this.followPath(dt, nav, speed);
  }

  private chooseGoal(nav: NavGraph) {
    const s = this.skill;
    const here = nearestNode(nav, this.pos, 5);
    if (here < 0) {
      // Off the graph (mid-air, wedged): drift toward the nearest node.
      const near = nearestNode(nav, this.pos, 14);
      if (near >= 0) this.setGoal({ kind: 'local', node: near, look: null, hold: 0 }, [near]);
      return;
    }
    // 1) Hunt the freshest unchecked memory.
    let best: [string, Memory] | null = null;
    for (const e of this.mem) {
      const m = e[1];
      if (m.visible || m.checked) continue;
      if (!best || m.t > best[1].t) best = e;
    }
    if (best) {
      const [id, m] = best;
      const node = nearestNode(nav, m.pos, 6, true);
      if (node >= 0 && this.planTo(nav, here, node, { kind: 'hunt', node, look: { x: m.pos.x, y: m.pos.y + CHEST, z: m.pos.z }, hold: rand(0.4, 1.2), id })) return;
      m.checked = true;
    }
    // 2) Spawn read: an enemy just died — cover where they'll reappear.
    if (this.clock - this.spawnReadAt < 5 && Math.random() < s.tactics * 0.75) {
      this.spawnReadAt = -Infinity;
      if (this.planSpawnWatch(nav, here)) return;
    }
    // 3) Patrol: power positions for thinkers, anywhere for the rest.
    for (let tries = 0; tries < 3; tries++) {
      const node = this.pickPatrol(nav);
      if (node < 0) break;
      const n = nav.nodes[node];
      const hold = rand(0.2, 0.7) + s.tactics * n.vis * rand(0.8, 2.4);
      if (this.planTo(nav, here, node, { kind: 'patrol', node, look: null, hold })) return;
    }
    // Nothing plannable: a short local wander.
    const near = nodesNear(nav, this.pos.x, this.pos.z, 10, this.scratchNear).filter((i) => nav.nodes[i].core);
    if (near.length) {
      const node = near[Math.floor(Math.random() * near.length)];
      this.planTo(nav, here, node, { kind: 'local', node, look: null, hold: 0.3 });
    }
  }

  private planTo(nav: NavGraph, from: number, to: number, goal: Goal): boolean {
    const path = findPath(nav, from, to, { kindCost: KIND_COST[this.difficulty], banned: this.bannedSet });
    this.stats.repaths++;
    if (!path) {
      this.goalFails++;
      return false;
    }
    this.goalFails = 0;
    this.setGoal(goal, path);
    return true;
  }

  private setGoal(goal: Goal, path: number[]) {
    this.goal = goal;
    this.setPath(path);
    if (goal.kind === 'patrol' || goal.kind === 'spawn') {
      const n = this.nav?.nodes[goal.node];
      if (n) {
        this.recentGoals.push({ x: n.x, y: n.y, z: n.z });
        if (this.recentGoals.length > 5) this.recentGoals.shift();
      }
    }
  }

  private setPath(path: number[]) {
    this.path = path;
    // Skip the first node when we're already standing by it.
    const nav = this.nav;
    this.pathIdx = 0;
    if (nav && path.length > 1) {
      const n0 = nav.nodes[path[0]];
      if (Math.hypot(n0.x - this.pos.x, n0.z - this.pos.z) < 1.6 && Math.abs(n0.y - this.pos.y) < 0.5) this.pathIdx = 1;
    }
    this.steerIdx = this.pathIdx;
    this.steerT = 0;
    this.trav = null;
    this.travFails = 0;
    this.progressBest = Infinity;
    this.progressT = 0;
  }

  private arrive(nav: NavGraph) {
    const g = this.goal;
    this.goal = null;
    this.path = [];
    if (!g) return;
    if (g.kind === 'hunt' && g.id) {
      const m = this.mem.get(g.id);
      if (m) m.checked = true;
    }
    this.holdT = g.hold;
    if (g.kind === 'spawn' && g.look) {
      this.lookPoint = g.look;
      this.glanceT = g.hold;
    } else if (g.hold > 0.3) {
      this.pickGlance(nav);
    }
  }

  // While holding: look down a long sightline (a far, visible node).
  private pickGlance(nav: NavGraph) {
    const eye = this.eye();
    for (let k = 0; k < 8; k++) {
      const id = nav.power[Math.floor(Math.random() * Math.min(nav.power.length, 200))];
      if (id === undefined) break;
      const n = nav.nodes[id];
      const d = Math.hypot(n.x - eye.x, n.z - eye.z);
      if (d < 8 || d > 55) continue;
      const p = { x: n.x, y: n.y + CHEST, z: n.z };
      if (!nav.index.segmentClear(eye, p, 0.3)) continue;
      this.lookPoint = p;
      this.glanceT = rand(0.7, 1.8);
      return;
    }
    // Nothing found: a look over the shoulder.
    const a = this.yaw + rand(-2, 2);
    this.lookPoint = { x: eye.x + Math.sin(a) * 10, y: eye.y, z: eye.z + Math.cos(a) * 10 };
    this.glanceT = rand(0.6, 1.4);
  }

  private pickPatrol(nav: NavGraph): number {
    const s = this.skill;
    if (!nav.core.length) return -1;
    let best = -1;
    let bestScore = -Infinity;
    const pool = s.tactics > 0.3 && Math.random() < s.tactics ? nav.power.slice(0, Math.max(40, Math.floor(nav.power.length * 0.15))) : nav.core;
    for (let k = 0; k < 14; k++) {
      const id = pool[Math.floor(Math.random() * pool.length)];
      const n = nav.nodes[id];
      const d = Math.hypot(n.x - this.pos.x, n.z - this.pos.z);
      let score = Math.random() * 1.5 + s.tactics * (n.vis * 2.5 + Math.min(1, (n.y - nav.index.floorY) / 8));
      if (d < 10) score -= 2.5;
      if (d > 55) score -= (d - 55) * 0.06;
      for (const r of this.recentGoals) if (Math.hypot(r.x - n.x, r.z - n.z) < 12) score -= 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  // Cover the spawn an enemy most likely reappears at: the spawn logic picks
  // among the few farthest from every live combatant, so do the same sums,
  // then find a vantage that sees it from a sensible range.
  private planSpawnWatch(nav: NavGraph, here: number): boolean {
    // Sharp bots reckon with where everyone is; the rest with what they know.
    const avoid: Vec3[] = [this.pos];
    if (this.skill.tactics >= 0.8) for (const tr of this.track.values()) avoid.push(tr.last);
    else for (const m of this.mem.values()) avoid.push(m.pos);
    for (const p of this.deadAt.values()) avoid.push(p);
    this.deadAt.clear();
    const likely = rankSpawns(nav.map, avoid).slice(0, 3);
    if (!likely.length) return false;
    // The likely spawn nearest us is the one worth covering.
    likely.sort((a, b) => Math.hypot(a.x - this.pos.x, a.z - this.pos.z) - Math.hypot(b.x - this.pos.x, b.z - this.pos.z));
    const sp = likely[0];
    const sc = { x: sp.x, y: sp.y + CHEST, z: sp.z };
    const near = nodesNear(nav, sp.x, sp.z, 24, this.scratchNear);
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 40 && near.length; k++) {
      const id = near[Math.floor(Math.random() * near.length)];
      const n = nav.nodes[id];
      if (!n.core) continue;
      const r = Math.hypot(n.x - sp.x, n.z - sp.z);
      if (r < 9) continue;
      const score = n.vis * 1.5 + Math.min(4, Math.max(0, n.y - sp.y)) * 0.3 - Math.abs(r - 15) * 0.1 - Math.hypot(n.x - this.pos.x, n.z - this.pos.z) * 0.02;
      if (score <= bestScore) continue;
      if (!nav.index.segmentClear({ x: n.x, y: n.y + EYE, z: n.z }, sc, 0.3)) continue;
      best = id;
      bestScore = score;
    }
    if (best < 0) return false;
    return this.planTo(nav, here, best, { kind: 'spawn', node: best, look: sc, hold: rand(1.5, 3.5) });
  }

  // Where the path follower is heading (for the casual look).
  private steerPoint(): Vec3 | null {
    const nav = this.nav;
    if (!nav || this.steerIdx >= this.path.length) return null;
    return nav.nodes[this.path[this.steerIdx]];
  }

  // Follow the current path; returns the wish velocity. Runs of walk links are
  // string-pulled (steer straight at the farthest node we can walk to), and
  // jump/double/boost links are executed as real jumps at the take-off.
  private followPath(dt: number, nav: NavGraph, speed: number): { x: number; z: number } {
    const nodes = nav.nodes;
    if (this.pathIdx >= this.path.length) return { x: 0, z: 0 };
    let kind = this.pathIdx > 0 ? linkKind(nav, this.path[this.pathIdx - 1], this.path[this.pathIdx]) : LINK_WALK;

    // String-pull a few times a second (and whenever we advance).
    this.steerT -= dt;
    if (this.steerT <= 0 || this.steerIdx < this.pathIdx) {
      this.steerT = 0.2;
      this.steerIdx = this.pathIdx;
      if (kind === LINK_WALK && this.onGround && !this.trav) {
        for (let j = this.pathIdx + 1; j < this.path.length && j <= this.pathIdx + 6; j++) {
          if (linkKind(nav, this.path[j - 1], this.path[j]) !== LINK_WALK) break;
          if (!walkable(nav, this.pos, nodes[this.path[j]])) break;
          this.steerIdx = j;
        }
      }
    }
    let target = nodes[this.path[this.steerIdx]];

    // Arrival → advance.
    let dx = target.x - this.pos.x;
    let dz = target.z - this.pos.z;
    let dist = Math.hypot(dx, dz);
    const last = this.steerIdx === this.path.length - 1;
    const arriveR = last ? 0.7 : 1.1;
    const dyT = this.pos.y - target.y;
    if (dist < arriveR && dyT > -0.35 && dyT < 1.2 && (this.onGround || dyT < 0.4)) {
      if (this.trav) this.endTraverse(true);
      this.pathIdx = this.steerIdx + 1;
      this.steerIdx = this.pathIdx;
      this.steerT = 0;
      this.progressBest = Infinity;
      this.progressT = 0;
      if (this.pathIdx >= this.path.length) {
        if (this.combatPath) this.combatPath = false;
        return { x: 0, z: 0 };
      }
      kind = linkKind(nav, this.path[this.pathIdx - 1], this.path[this.pathIdx]);
      target = nodes[this.path[this.pathIdx]];
      dx = target.x - this.pos.x;
      dz = target.z - this.pos.z;
      dist = Math.hypot(dx, dz);
    }

    // Execute vertical links.
    const rise = target.y - this.pos.y;
    if (this.trav) {
      this.trav.t += dt;
      const tv = this.trav;
      if (!this.onGround) {
        // Second stage: the air jump near the apex.
        const needAir = (tv.kind === LINK_DOUBLE || tv.kind === LINK_BOOST) && !tv.airJumped;
        if (needAir && this.vel.y < 1.5 && this.pos.y < target.y + 0.3 && this.airJumpsLeft > 0) {
          this.doAirJump();
          tv.airJumped = true;
        }
        // Still below the landing: don't drift in under a deck or lip —
        // climb first, then cross over.
        if (rise > -0.05 && dist > 1e-3) {
          const look = 0.5 + Math.hypot(this.vel.x, this.vel.z) * 0.15;
          const px = this.pos.x + (dx / dist) * look;
          const pz = this.pos.z + (dz / dist) * look;
          if (!nav.index.capsuleFree(px, this.pos.y + 0.02, pz, BOT_RADIUS * 1.15, rise + BOT_HEIGHT + 0.1)) {
            this.brakeAir = true;
            return { x: 0, z: 0 };
          }
        }
      } else if (tv.t > 0.2) {
        // Landed without reaching the target level → failed attempt.
        if (rise > 0.3) this.endTraverse(false);
        else this.endTraverse(true);
      }
    } else if ((kind === LINK_DOUBLE || kind === LINK_BOOST || kind === LINK_JUMP) && this.onGround) {
      let go = false;
      if (kind === LINK_JUMP && rise <= 0.3) {
        // Flat gap: jump at the lip (ground ahead drops away), or late if we
        // can't find it.
        const l = dist || 1;
        const ahead = nav.index.groundBelow(this.pos.x + (dx / l) * 0.7, this.pos.z + (dz / l) * 0.7, this.pos.y + 0.05, 0);
        go = this.pos.y - ahead > 0.3 || dist < 1.2;
      } else if (rise > 0.3) {
        const a = this.pathIdx > 0 ? nodes[this.path[this.pathIdx - 1]] : null;
        const atA = a !== null && Math.hypot(a.x - this.pos.x, a.z - this.pos.z) < 0.6;
        go = atA || dist < (kind === LINK_BOOST ? 3.2 : kind === LINK_DOUBLE ? 2.6 : 2.2);
        if (go && !atA && a && !nav.index.capsuleFree(this.pos.x, this.pos.y + 0.02, this.pos.z, BOT_RADIUS * 0.9, rise + BOT_HEIGHT + 0.1)) {
          // Something overhead here: take off from the link's own start node.
          const ax = a.x - this.pos.x;
          const az = a.z - this.pos.z;
          const al = Math.hypot(ax, az) || 1;
          return { x: (ax / al) * speed * 0.6, z: (az / al) * speed * 0.6 };
        }
      }
      if (go && kind === LINK_BOOST && this.clock - this.lastBoostAt < 0.6) {
        // The boost's recharging — wait at the take-off.
        return { x: 0, z: 0 };
      }
      if (go) {
        // An overhang between here and the landing: launch straight up, then
        // cross over once above it.
        const l = dist || 1;
        const clearAhead = nav.index.capsuleFree(this.pos.x + (dx / l) * 1.2, this.pos.y + 0.02, this.pos.z + (dz / l) * 1.2, BOT_RADIUS * 1.1, rise + BOT_HEIGHT);
        if (kind === LINK_BOOST) this.doBoost(clearAhead ? dx : 0, clearAhead ? dz : 0);
        else this.doJump();
        this.trav = { kind, to: this.path[this.pathIdx], t: 0, airJumped: false };
      }
    }

    // Progress watchdog: hop, then re-plan, then give up on this goal.
    const d3 = dist + Math.max(0, rise) * 0.5;
    if (d3 < this.progressBest - 0.4) {
      this.progressBest = d3;
      this.progressT = 0;
    } else {
      this.progressT += dt;
      if (this.progressT > 0.6) this.stats.stuckSec += dt;
      if (this.progressT > 0.9 && this.onGround && !this.trav && Math.random() < dt * 4) this.doJump();
      if (this.progressT > 2.2) {
        this.progressT = 0;
        this.progressBest = Infinity;
        if (this.pathIdx > 0) this.ban(this.path[this.pathIdx - 1], this.path[this.pathIdx]);
        const here = nearestNode(nav, this.pos, 5);
        const goalNode = this.path[this.path.length - 1];
        const path = here >= 0 ? findPath(nav, here, goalNode, { kindCost: KIND_COST[this.difficulty], banned: this.bannedSet }) : null;
        this.stats.repaths++;
        if (path && path.length > 1 && this.goalFails < 2) {
          this.goalFails++;
          this.setPath(path);
        } else {
          this.goalFails = 0;
          this.goal = null;
          this.path = [];
          this.combatPath = false;
          return { x: 0, z: 0 };
        }
      }
    }
    // Knocked far off the route (fell, got boosted): re-plan.
    if (dist > 9 || (kind === LINK_WALK && Math.abs(rise) > 2.5)) {
      if (this.onGround && !this.trav) {
        this.goal = null;
        this.path = [];
        this.combatPath = false;
        return { x: 0, z: 0 };
      }
    }

    if (dist < 1e-3) return { x: 0, z: 0 };
    // Ease into the final node; otherwise full speed.
    const sp = last ? speed * Math.min(1, 0.35 + dist / 2.5) : speed;
    return { x: (dx / dist) * sp, z: (dz / dist) * sp };
  }

  private endTraverse(ok: boolean) {
    const tv = this.trav;
    this.trav = null;
    if (!tv) return;
    if (ok) {
      this.stats.travOk++;
      this.stats.travOkKind[tv.kind]++;
      this.travFails = 0;
      return;
    }
    this.stats.travFail++;
    this.stats.travFailKind[tv.kind]++;
    this.travFails++;
    if (this.travFails >= 2 && this.pathIdx > 0) {
      this.ban(this.path[this.pathIdx - 1], this.path[this.pathIdx]);
      this.travFails = 0;
      this.goal = null;
      this.path = [];
      this.combatPath = false;
    }
  }

  private ban(from: number, to: number) {
    this.banned.set(linkKey(from, to), this.clock + 20);
    this.bannedSet = new Set(this.banned.keys());
  }

  // ── physics ────────────────────────────────────────────────────────────────
  private integrate(dt: number, map: ArenaMap, nav: NavGraph, wishX: number, wishZ: number, airRate: number) {
    if (this.dashTimer > 0) {
      this.vel.x = this.dashDir.x * DASH_SPEED;
      this.vel.z = this.dashDir.z * DASH_SPEED;
    } else if (this.onGround) {
      const k = 1 - Math.exp(-GROUND_RATE * dt);
      this.vel.x += (wishX - this.vel.x) * k;
      this.vel.z += (wishZ - this.vel.z) * k;
    } else if (this.brakeAir) {
      const k = 1 - Math.exp(-25 * dt);
      this.vel.x -= this.vel.x * k;
      this.vel.z -= this.vel.z * k;
    } else if (wishX !== 0 || wishZ !== 0) {
      const k = 1 - Math.exp(-airRate * dt);
      this.vel.x += (wishX - this.vel.x) * k;
      this.vel.z += (wishZ - this.vel.z) * k;
    }
    this.brakeAir = false;
    const horiz = Math.hypot(this.vel.x, this.vel.z);
    if (horiz > MAX_HORIZONTAL_SPEED) {
      this.vel.x *= MAX_HORIZONTAL_SPEED / horiz;
      this.vel.z *= MAX_HORIZONTAL_SPEED / horiz;
    }
    if (this.dashTimer > 0) this.vel.y = 0;
    else this.vel.y -= GRAVITY * dt;

    const size = { x: BOT_RADIUS * 2, y: BOT_HEIGHT, z: BOT_RADIUS * 2 };
    const r = movePlayer(this.pos, size, { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt }, map.boxes);
    const blocked = r.blocked.x || r.blocked.z;
    if (r.blocked.x) this.vel.x = 0;
    if (r.blocked.z) this.vel.z = 0;
    this.pos = r.position;
    if (r.groundContact) {
      this.vel.y = 0;
      this.onGround = true;
    } else {
      if (r.blocked.y && this.vel.y > 0) this.vel.y = 0;
      this.onGround = false;
    }
    const landed = this.onGround && !this.wasOnGround;
    if (landed) {
      this.airJumpsLeft = AIR_JUMPS;
      this.pendingAirJump = false;
    }
    this.wasOnGround = this.onGround;

    // Walked into something low: hop it like a player would (no step-up).
    const wl = Math.hypot(wishX, wishZ);
    if (blocked && this.onGround && wl > 0.5 && !this.trav) {
      const fx = this.pos.x + (wishX / wl) * (BOT_RADIUS + 0.4);
      const fz = this.pos.z + (wishZ / wl) * (BOT_RADIUS + 0.4);
      const top = nav.index.groundBelow(fx, fz, this.pos.y + 3.2);
      const rise = top - this.pos.y;
      if (rise > 0.05 && rise <= 1.45) this.doJump();
      else if (rise > 1.45 && rise <= 3.0) {
        this.doJump();
        this.pendingAirJump = true;
      }
    }
    if (this.pendingAirJump && !this.onGround && this.vel.y < 1.5) {
      this.pendingAirJump = false;
      this.doAirJump();
    }
  }

  private doJump() {
    this.vel.y = JUMP_SPEED;
    this.onGround = false;
  }

  // Mid-air second hop, optionally redirecting momentum (a sideways dodge).
  private doAirJump(dirX = 0, dirZ = 0) {
    if (this.airJumpsLeft <= 0) return;
    this.airJumpsLeft -= 1;
    this.vel.y = JUMP_SPEED;
    if (dirX !== 0 || dirZ !== 0) {
      const len = Math.hypot(dirX, dirZ) || 1;
      const sp = Math.max(this.skill.strafeSpeed * 0.8, Math.hypot(this.vel.x, this.vel.z));
      this.vel.x = (dirX / len) * sp;
      this.vel.z = (dirZ / len) * sp;
    }
  }

  private doDash(dx: number, dz: number) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    this.dashDir = { x: dx / len, z: dz / len };
    this.dashTimer = DASH_DURATION;
    this.dashCooldown = DASH_COOLDOWN;
  }

  // Damage-free floor boost: up + forward like the player's, refreshing the
  // air jump.
  private doBoost(hx: number, hz: number) {
    if (this.vel.y < 0) this.vel.y = 0;
    const len = Math.hypot(hx, hz) || 1;
    let dx = BOOST_FORWARD_BIAS * (hx / len);
    let dy = 1;
    let dz = BOOST_FORWARD_BIAS * (hz / len);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    this.vel.x = this.vel.x * 0.4 + dx * BOOST_IMPULSE;
    this.vel.y += dy * BOOST_IMPULSE;
    this.vel.z = this.vel.z * 0.4 + dz * BOOST_IMPULSE;
    this.onGround = false;
    this.airJumpsLeft = AIR_JUMPS;
    this.boostCooldown = this.mv.boostCooldown;
    this.lastBoostAt = this.clock;
  }
}

function tri(mag: number): number {
  return (Math.random() + Math.random() - 1) * mag;
}
