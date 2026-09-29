import * as THREE from 'three';
import { DEFAULT_KILL_EFFECT, type KillEffectStyle } from './cosmetics';
import { Character } from './character/character';
import { B } from './character/rig';
import { PoseSpec, SIDE_L, SIDE_R, solvePose } from './character/pose';
import { evalClip, type Clip } from './character/clip';
import { HOLD, PALM_OFFSET } from './character/gun';
import { GibBurst, type GibFloor } from './character/gibs';
import { Locomotion, type FootfallListener, type LocoInput } from './locomotion';
import { emoteClip, emoteStance, type AnyEmoteKind as EmoteKind } from './emotes';

// Third-person animation for the code-built arena combatant, shared by
// networked remote players, offline bots, replays, the podium and the Locker.
//
// Pipeline each frame:
//   motion tracking (from the entity's world position — the server owns it)
//   → Locomotion (procedural gait, air, land, dash, wall-kick) → PoseSpec
//   → aim layer (pitch through spine/neck/head; gun hold on the aim line)
//   → optional full-body emote clip, blended in/out
//   → solver (FK + two-bone IK for all four limbs) → bone matrices.
// Death is an instagib: the body's own rigid parts fly apart (see gibs.ts).
// Purely visual — hitboxes and positions are never written.

export type CharacterModel = {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
};

export type CharacterAnimInput = {
  dt: number;
  // Model-root yaw (three.js Y rotation, radians); forward is (-sin, -cos).
  yaw: number;
  // View/aim pitch, radians, positive = looking up.
  pitch: number;
  // World-space feet position of the entity this frame (read, never written).
  pos: THREE.Vector3;
};

const DEG = Math.PI / 180;
const MAX_DT = 0.1;
const TELEPORT_SPEED = 60;
const VERTICAL_SNAP_SPEED = 40;
const SPEED_SMOOTH_HZ = 10;
const PITCH_SMOOTH_HZ = 14;
const TAKEOFF_VY = 2.0;
const AIR_COMMIT_JUMP_SEC = 0.05;
const AIR_COMMIT_FALL_SEC = 0.22;
const GROUND_VY = 0.35;
const GROUND_COMMIT_SEC = 0.08;
const LAND_IMPACT_VY = -2.0;
const LAND_IMPACT_WINDOW_SEC = 0.05;
const AIM_PITCH_LIMIT = 70 * DEG;
const RIFLE_TWIST = 16 * DEG; // chest bladed to the right; head/gun stay on the aim
const EMOTE_BLEND_HZ = 7;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Enable shadow casting on every mesh under `root`.
export function enableShadows(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) obj.castShadow = true;
  });
}

export type AnimatorOptions = {
  // Rotate the character root by the input yaw (live entities). Podium/Locker
  // characters are placed by their own outer group instead.
  driveYaw?: boolean;
  // Hold the railgun (live) — off for podium/Locker unless an emote wants it.
  holdGun?: boolean;
};

export class CharacterAnimator {
  readonly loco = new Locomotion();
  private readonly spec = new PoseSpec();
  private readonly emoteSpec = new PoseSpec();
  private readonly driveYaw: boolean;
  private readonly holdGun: boolean;
  private readonly gibs: GibBurst;
  private time = Math.random() * 100;
  private readonly li: LocoInput = { dt: 0, vx: 0, vz: 0, speed: 0, vy: 0, grounded: true, yawRate: 0, time: 0 };

  // Motion tracking.
  private readonly prev = new THREE.Vector3();
  private hasPrev = false;
  private vx = 0;
  private vz = 0;
  private prevVx = 0;
  private prevVz = 0;
  private prevVy = 0;
  private vyNow = 0;
  private speed = 0;
  private airborne = false;
  private airTimer = 0;
  private groundTimer = 0;
  private minVy = 0;
  private sinceFastFall = Infinity;
  private prevYaw = 0;
  private hasYaw = false;
  private aimPitch = 0;

  // Emote override.
  private emote: Clip | null = null;
  private emoteKind: EmoteKind | null = null;
  private emoteT = 0;
  private emoteW = 0;
  private emoteTarget = 0;
  // Pending clip swap: blend out the old one first.
  private nextEmote: EmoteKind | null = null;

  constructor(
    readonly character: Character,
    opts: AnimatorOptions = {},
  ) {
    this.driveYaw = opts.driveYaw ?? true;
    this.holdGun = opts.holdGun ?? true;
    this.gibs = new GibBurst(character);
    this.character.root.rotation.order = 'YXZ';
    this.solve(0);
  }

  // ── Footfalls (for synced footstep audio) ─────────────────────────────────
  get footfalls(): number {
    return this.loco.footfalls;
  }
  set onFootfall(fn: FootfallListener | null) {
    this.loco.onFootfall = fn;
  }
  get isAirborne(): boolean {
    return this.airborne;
  }

  // ── Emotes ─────────────────────────────────────────────────────────────────
  // Play a full-body emote (null = back to the live/idle pose). Blends in/out.
  playEmote(kind: EmoteKind | null, restart = false): void {
    if (kind === this.emoteKind && !restart) return;
    if (kind === null) {
      this.emoteTarget = 0;
      this.nextEmote = null;
      return;
    }
    if (this.emote && this.emoteW > 0.05 && kind !== this.emoteKind) {
      // Blend the current clip out, then start the new one.
      this.nextEmote = kind;
      this.emoteTarget = 0;
      return;
    }
    this.startEmote(kind);
  }

  // Jump an active emote to time t (lab / deterministic previews).
  setEmoteTime(t: number, weight = 1): void {
    this.emoteT = t;
    this.emoteW = weight;
    this.emoteTarget = weight;
  }

  get currentEmote(): EmoteKind | null {
    return this.emoteKind;
  }

  get emoteShowsGun(): boolean {
    return !!this.emote?.gun && this.emoteW > 0.5;
  }

  private startEmote(kind: EmoteKind) {
    this.emote = emoteClip(kind);
    this.emoteKind = kind;
    this.emoteT = 0;
    this.emoteTarget = 1;
    this.nextEmote = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // Instagib: burst the body into its rigid parts. Always succeeds (even in
  // mid-air — chunks just fall and shrink without a floor to bounce on).
  // `style` = the killer's finisher: it picks how the body breaks apart.
  die(floor?: GibFloor, style: KillEffectStyle = DEFAULT_KILL_EFFECT): boolean {
    if (this.gibs.active) return true;
    this.gibs.start(this.vx, this.vyNow, this.vz, floor ?? this.guessFloor(), style);
    return true;
  }

  isDying(): boolean {
    return this.gibs.active;
  }

  deathDone(): boolean {
    return this.gibs.active && this.gibs.done;
  }

  respawn(pos?: THREE.Vector3): void {
    this.gibs.stop();
    this.loco.reset();
    this.aimPitch = 0;
    this.hasYaw = false;
    this.character.root.position.set(0, 0, 0);
    this.resetMotion(pos);
    this.solve(0);
  }

  resetMotion(pos?: THREE.Vector3): void {
    if (pos) {
      this.prev.copy(pos);
      this.hasPrev = true;
    } else {
      this.hasPrev = false;
    }
    this.vx = this.vz = this.prevVx = this.prevVz = 0;
    this.prevVy = 0;
    this.vyNow = 0;
    this.speed = 0;
    this.airborne = false;
    this.airTimer = 0;
    this.groundTimer = 0;
    this.minVy = 0;
    this.sinceFastFall = Infinity;
    this.lastGroundY = pos ? pos.y : this.lastGroundY;
  }

  dispose(): void {
    this.gibs.dispose();
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  update(inp: CharacterAnimInput): void {
    const dt = inp.dt > 0 ? Math.min(inp.dt, MAX_DT) : 0;
    this.time += dt;
    if (this.gibs.active) {
      this.gibs.update(dt);
      return;
    }
    this.trackMotion(inp.pos, dt);

    // Aim yaw rate (for turn-in-place steps); the root carries the aim yaw.
    let yawRate = 0;
    if (this.hasYaw && dt > 0) yawRate = wrapPi(inp.yaw - this.prevYaw) / dt;
    this.prevYaw = inp.yaw;
    this.hasYaw = true;
    if (this.driveYaw) this.character.root.rotation.set(0, inp.yaw, 0);

    // World velocity → model space.
    const cy = Math.cos(inp.yaw);
    const sy = Math.sin(inp.yaw);
    const mvx = this.vx * cy - this.vz * sy;
    const mvz = this.vx * sy + this.vz * cy;

    const target = clamp(inp.pitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
    this.aimPitch += (target - this.aimPitch) * (1 - Math.exp(-PITCH_SMOOTH_HZ * dt));

    const spec = this.spec;
    spec.reset();
    const li = this.li;
    li.dt = dt;
    li.vx = mvx;
    li.vz = mvz;
    li.speed = this.speed;
    li.vy = this.vyNow;
    li.grounded = !this.airborne;
    li.yawRate = clamp(yawRate, -30, 30);
    li.time = this.time;
    this.loco.update(li, spec);
    if (this.holdGun) this.applyAim(spec, this.aimPitch);
    this.solve(dt);
  }

  // Emote-only update for podium/Locker characters (no motion tracking).
  updateStatic(dt: number): void {
    dt = Math.max(0, Math.min(dt, MAX_DT));
    this.time += dt;
    if (this.gibs.active) {
      this.gibs.update(dt);
      return;
    }
    const spec = this.spec;
    spec.reset();
    const li = this.li;
    li.dt = dt;
    li.vx = li.vz = li.speed = li.vy = li.yawRate = 0;
    li.grounded = true;
    li.time = this.time;
    this.loco.update(li, spec);
    if (this.holdGun) this.applyAim(spec, 0);
    else this.relaxedArms(spec);
    this.solve(dt);
  }

  // Aim layer: pitch spread through the spine, rifle-bladed chest, gun hold.
  private applyAim(spec: PoseSpec, pitch: number) {
    spec.addR(B.spine, pitch * 0.2, 0, 0);
    spec.addR(B.chest, pitch * 0.3, -RIFLE_TWIST, 0);
    spec.addR(B.neck, pitch * 0.15, RIFLE_TWIST * 0.4, 0);
    spec.addR(B.head, pitch * 0.35, RIFLE_TWIST * 0.6, 0);
    spec.handSpace = 'aim';
    spec.aimPitch = pitch;
    // Hand orientations in the aim frame: right = the gun's own frame (the
    // socket has no rotation), left = palm up under the barrel, fingers
    // wrapping toward the right.
    spec.handQOn[SIDE_R] = true;
    spec.handQ[SIDE_R].identity();
    _e.set(0, 0, 90 * DEG, 'YXZ');
    spec.handQ[SIDE_L].setFromEuler(_e);
    const air = this.loco.air;
    spec.handQOn[SIDE_L] = air < 0.5;
    // Wrist targets = palm targets − handQ·palmOffset.
    _v.copy(PALM_OFFSET).applyQuaternion(spec.handQ[SIDE_R]);
    spec.hand[SIDE_R].copy(HOLD.grip).sub(_v);
    _v.copy(PALM_OFFSET).applyQuaternion(spec.handQ[SIDE_L]);
    spec.hand[SIDE_L].copy(HOLD.support).sub(_v);
    // Air: the support hand lets go for balance, the gun stays on the aim.
    if (air > 0.01) {
      const k = air * 0.85;
      const h = spec.hand[SIDE_L];
      h.x += (-0.36 - h.x) * k;
      h.y += (-0.02 - h.y) * k;
      h.z += (0.02 - h.z) * k;
    }
    // Landing: the gun dips with the body.
    spec.hand[SIDE_R].y -= 0.05 * this.loco.land;
    spec.hand[SIDE_L].y -= 0.05 * this.loco.land;
    spec.elbow[SIDE_R].set(0.55, -1, 0.35);
    spec.elbow[SIDE_L].set(-0.7, -1, -0.1);
  }

  private relaxedArms(spec: PoseSpec) {
    spec.hand[SIDE_L].set(-0.27, 0.9, -0.02);
    spec.hand[SIDE_R].set(0.27, 0.9, -0.02);
    spec.elbow[SIDE_L].set(-0.3, 0, 1);
    spec.elbow[SIDE_R].set(0.3, 0, 1);
    spec.setR(B.handL, 0, 0, -6 * DEG);
    spec.setR(B.handR, 0, 0, 6 * DEG);
  }

  private solve(dt: number) {
    // Emote blend.
    if (this.emote) {
      this.emoteW += (this.emoteTarget - this.emoteW) * (1 - Math.exp(-EMOTE_BLEND_HZ * dt));
      if (this.emoteTarget === 0 && this.emoteW < 0.02) {
        if (this.nextEmote) this.startEmote(this.nextEmote);
        else {
          this.emote = null;
          this.emoteKind = null;
          this.emoteW = 0;
        }
      }
    }
    const rig = this.character.rig;
    if (this.emote && this.emoteW > 0.001) {
      this.emoteT += dt;
      emoteStance(this.emoteSpec);
      evalClip(this.emote, this.emoteT, this.emoteSpec);
      solvePose(rig, this.spec, this.emoteSpec, this.emoteW);
    } else {
      solvePose(rig, this.spec);
    }
    rig.writeBones();
  }

  // ── Motion tracking ────────────────────────────────────────────────────────
  private lastGroundY = 0;
  private sinceGround = 0;

  private guessFloor(): GibFloor {
    // Grounded (or just left the ground a moment ago, not far above it) → the
    // victim's last standing height is a good floor for the chunks to bounce on.
    const y = this.prev.y;
    if (!this.airborne) return { y };
    if (this.sinceGround < 0.7 && y - this.lastGroundY < 2.5 && y >= this.lastGroundY - 0.1) return { y: this.lastGroundY };
    return null;
  }

  private trackMotion(pos: THREE.Vector3, dt: number): void {
    if (dt <= 0) return;
    if (!this.hasPrev) {
      this.prev.copy(pos);
      this.hasPrev = true;
      this.lastGroundY = pos.y;
      return;
    }
    const dx = pos.x - this.prev.x;
    const dy = pos.y - this.prev.y;
    const dz = pos.z - this.prev.z;
    this.prev.copy(pos);
    const hs = Math.hypot(dx, dz) / dt;
    const vyRaw = dy / dt;
    if (hs > TELEPORT_SPEED || Math.abs(vyRaw) > TELEPORT_SPEED) {
      this.resetMotion(pos);
      return;
    }
    this.prevVx = this.vx;
    this.prevVz = this.vz;
    this.vx = dx / dt;
    this.vz = dz / dt;
    this.speed += (hs - this.speed) * (1 - Math.exp(-SPEED_SMOOTH_HZ * dt));
    const vy = Math.abs(vyRaw) > VERTICAL_SNAP_SPEED ? this.prevVy : vyRaw;
    this.vyNow = vy;
    this.sinceFastFall = vy < LAND_IMPACT_VY ? 0 : this.sinceFastFall + dt;

    const still = Math.abs(vy) < GROUND_VY;
    if (!this.airborne) {
      this.sinceGround = 0;
      this.lastGroundY = pos.y;
      if (still) {
        this.airTimer = 0;
      } else {
        this.airTimer += dt;
        const launch = vy > TAKEOFF_VY;
        if (this.airTimer >= (launch ? AIR_COMMIT_JUMP_SEC : AIR_COMMIT_FALL_SEC)) {
          this.airborne = true;
          this.groundTimer = 0;
          this.minVy = Math.min(0, vy);
          this.loco.takeoff(launch);
        }
      }
    } else {
      this.sinceGround += dt;
      if (vy < this.minVy) this.minVy = vy;
      const impact = still && this.sinceFastFall <= LAND_IMPACT_WINDOW_SEC;
      this.groundTimer = still ? this.groundTimer + dt : 0;
      if (impact || this.groundTimer >= GROUND_COMMIT_SEC) {
        this.airborne = false;
        this.airTimer = 0;
        this.loco.landed(-this.minVy);
        this.minVy = 0;
      } else if (vy > TAKEOFF_VY && vy - this.prevVy > TAKEOFF_VY) {
        // Mid-air relaunch: double jump / boost / wall jump. A sharp
        // horizontal redirect at the same instant means a wall kicked us.
        const dvx = this.vx - this.prevVx;
        const dvz = this.vz - this.prevVz;
        const wall = Math.hypot(dvx, dvz) > 4.5;
        const yaw = this.character.root.rotation.y;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        this.loco.relaunch(dvx * c - dvz * s, dvx * s + dvz * c, wall);
        this.minVy = 0;
      }
    }
    this.prevVy = vy;
  }
}

const _e = new THREE.Euler();
const _v = new THREE.Vector3();

// Build a character + animator pair (the common case for live entities).
export function createCombatant(opts: { colorHex?: string; castShadow?: boolean } & AnimatorOptions = {}) {
  const character = new Character({ colorHex: opts.colorHex, castShadow: opts.castShadow });
  const anim = new CharacterAnimator(character, opts);
  return { character, anim };
}
