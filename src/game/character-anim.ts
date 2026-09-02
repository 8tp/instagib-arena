import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LocomotionBlender } from './locomotion';
import { WeaponHold } from './weapon-model';

// Third-person character animation shared by networked remote players and
// offline bots — ONE implementation of clip resolution, the speed-blended
// gait, the gun-carry arm pin, and the procedural layers that the rig lacks
// clips for. Everything here is purely visual: it reads the entity's world
// position each frame and only ever writes the cloned model's bones and its
// root transform inside the entity group. Hitboxes, positions and server
// state are untouched.
//
// What the shipped rigs actually contain (probed from the GLB JSON chunks):
//   soldier.glb (loaded by game/replay/podium for bots AND remotes):
//     clips  Idle 1.97s · Run 0.70s · TPose · Walk 1.03s   — NO jump, NO death
//     bones  mixamorig:Hips → Spine → Spine1 → Spine2 → Neck → Head,
//            mixamorig:{Left,Right}{UpLeg,Leg,Foot,ToeBase}, arms/hands
//   bot.glb (present on disk, currently unreferenced):
//     clips  Idle · Walking · Running · Jump · Death · WalkJump · emotes…
//     bones  RobotExpressive-style: Body/Hips/Abdomen/Torso/Neck/Head,
//            UpperLeg.L/LowerLeg.L …
// So: clips are used when a rig has them (jump/death one-shots), and the
// Soldier gets procedural equivalents — an airborne leg tuck + land settle,
// spine aim pitch, strafe lean, and a knee-buckle-then-topple death collapse.

export type CharacterModel = {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
};

export type CharacterAnimInput = {
  dt: number;
  // Model-root yaw to apply (three.js Y rotation, radians). The caller folds in
  // any rig-facing offset; at this yaw the model's forward is (-sin, -cos).
  yaw: number;
  // View/aim pitch, radians, positive = looking up (the camera convention).
  pitch: number;
  // World-space feet position of the entity this frame (read, never written).
  pos: THREE.Vector3;
};

const DEG = Math.PI / 180;
const MAX_DT = 0.1; // clamp long frames so envelopes/smoothing never jump

// ── Motion tracking ──────────────────────────────────────────────────────────
const TELEPORT_SPEED = 60; // horizontal m/s above which a frame is a respawn/seek snap
const VERTICAL_SNAP_SPEED = 40; // vertical m/s above which a frame is an auto-step/snap (ignore vertical)
const SPEED_SMOOTH_HZ = 10; // gait input smoothing (a fixed per-second rate → same feel at 60/144 Hz)
const LEAN_SMOOTH_HZ = 8;
const DIR_SMOOTH_HZ = 12; // run forward↔reverse crossover
const PITCH_SMOOTH_HZ = 14; // wire pitch steps at the snapshot rate; this hides the steps
const AIR_POSE_HZ = 16; // leg tuck in/out rate
// Ground/air state machine. Airborne is only committed after a short grace so
// stair steps (a few frames of vertical motion) never trigger a jump/land.
const TAKEOFF_VY = 2.0; // upward m/s that reads as a jump launch
const AIR_COMMIT_JUMP_SEC = 0.05;
const AIR_COMMIT_FALL_SEC = 0.22; // a mere step-down (< ~0.6 m) never becomes a "fall"
const GROUND_VY = 0.35; // |vy| below this looks grounded (an apex spends < 50 ms here)
const GROUND_COMMIT_SEC = 0.08;
// Touchdown shortcut: looking grounded within this long of a fast descent is an
// impact (an apex never follows a fast descent that closely), so a landing is
// recognised on the first still frame instead of after GROUND_COMMIT_SEC.
const LAND_IMPACT_VY = -2.0;
const LAND_IMPACT_WINDOW_SEC = 0.05;
// Landing settle: root sinks + spine dips, scaled by impact speed.
const LAND_IMPACT_MIN = 3;
const LAND_IMPACT_MAX = 12;
const LAND_MIN_AMP = 0.15;
const LAND_SEC = 0.24;
const LAND_SINK = 0.12;
const LAND_SPINE = 12 * DEG;
// Airborne pose (procedural, when the rig has no jump clip): lead leg tucked,
// trail leg trailing, slight forward lean. A fall (no launch) uses a lighter tuck.
const FALL_TUCK = 0.55;
const AIR_LEAD_THIGH = 38 * DEG;
const AIR_LEAD_SHIN = -55 * DEG;
const AIR_TRAIL_THIGH = -10 * DEG;
const AIR_TRAIL_SHIN = -28 * DEG;
const AIR_ROOT_PITCH = -4 * DEG;
const AIR_SPINE = -8 * DEG;
// Strafe/back-pedal lean (root, degrees at full run speed).
const LEAN_PITCH = 4 * DEG;
const LEAN_ROLL = 5 * DEG;
const LEAN_REF_SPEED = 8;
const REVERSE_FRAC = 0.35; // backward component (of speed) beyond which the run plays reversed
const IDLE_FLOOR = 0.4;
// Aim pitch on the spine chain.
const AIM_PITCH_LIMIT = 60 * DEG;
// Procedural death: knees buckle, then the body topples forward about the feet
// and lies flat; held there until the owner hides it.
const DEATH_BUCKLE_SEC = 0.18;
const DEATH_TOPPLE_DELAY = 0.1;
const DEATH_TOPPLE_SEC = 0.4;
const DEATH_COLLAPSE_SEC = DEATH_TOPPLE_DELAY + DEATH_TOPPLE_SEC;
const DEATH_HOLD_SEC = 0.5;
const DEATH_PITCH = 88 * DEG;
const DEATH_ROLL = 12 * DEG;
const DEATH_BUCKLE_SINK = 0.28;
const DEATH_FLAT_SINK = 0.06;
const DEATH_SPINE = 25 * DEG;
const DEATH_KNEE_THIGH = 35 * DEG;
const DEATH_KNEE_SHIN = 70 * DEG;
const ONESHOT_FADE_SEC = 0.1;

// Bone name candidates, Mixamo (colon and colon-less exports) first, then the
// RobotExpressive-style names bot.glb uses. Aim pitch is spread over the chain
// so the bend reads as a torso lean rather than a hinge.
const SPINE_CHAIN: ReadonlyArray<{ names: readonly string[]; share: number }> = [
  { names: ['mixamorig:Spine1', 'mixamorigSpine1', 'Spine1', 'Abdomen'], share: 0.45 },
  { names: ['mixamorig:Spine2', 'mixamorigSpine2', 'Spine2', 'Torso'], share: 0.4 },
  { names: ['mixamorig:Head', 'mixamorigHead', 'Head'], share: 0.15 },
];
const LEG_BONES = {
  leadThigh: ['mixamorig:LeftUpLeg', 'mixamorigLeftUpLeg', 'LeftUpLeg', 'UpperLeg.L'],
  leadShin: ['mixamorig:LeftLeg', 'mixamorigLeftLeg', 'LeftLeg', 'LowerLeg.L'],
  trailThigh: ['mixamorig:RightUpLeg', 'mixamorigRightUpLeg', 'RightUpLeg', 'UpperLeg.R'],
  trailShin: ['mixamorig:RightLeg', 'mixamorigRightLeg', 'RightLeg', 'LowerLeg.R'],
} as const;

// Clone a loaded character for one entity. Tags the subtree as shared (so the
// Game's scene disposal skips the cached source's geometry/materials/textures),
// forces a clean rest transform, and enables shadow casting on every mesh.
export function cloneCharacter(model: CharacterModel, scale = 1): THREE.Object3D {
  const cloned = SkeletonUtils.clone(model.scene);
  // Defensive: force a clean rest transform regardless of what the GLB's root
  // node had baked in — partial axis writes once left a residual lean.
  cloned.position.set(0, 0, 0);
  cloned.rotation.set(0, 0, 0);
  cloned.scale.setScalar(scale);
  cloned.traverse((obj) => {
    obj.userData.shared = true;
    if ((obj as THREE.Mesh).isMesh) obj.castShadow = true;
  });
  return cloned;
}

// Enable shadow casting on every mesh under `root` (attached gun, fallback capsule).
export function enableShadows(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) obj.castShadow = true;
  });
}

// Look up an animation clip by friendly name (case-insensitive), falling back
// to an index (the three.js Soldier example's 0 idle / 1 run / 3 walk order).
function pickClip(
  animations: THREE.AnimationClip[],
  names: readonly string[],
  fallbackIndex?: number,
): THREE.AnimationClip | null {
  const lookup = new Map<string, THREE.AnimationClip>();
  for (const c of animations) lookup.set(c.name.toLowerCase(), c);
  for (const n of names) {
    const hit = lookup.get(n.toLowerCase());
    if (hit) return hit;
  }
  if (fallbackIndex !== undefined && animations[fallbackIndex]) return animations[fallbackIndex];
  return null;
}

// Find a bone by any of `names`, preferring real Bone nodes over same-named
// meshes (bot.glb has both a "Torso" bone and a "Torso" mesh).
function findBone(bones: Map<string, THREE.Object3D>, root: THREE.Object3D, names: readonly string[]) {
  for (const n of names) {
    const b = bones.get(n);
    if (b) return b;
  }
  for (const n of names) {
    const any = root.getObjectByName(n);
    if (any) return any;
  }
  return null;
}

// An additive rotation layer on one bone. `base`/`applied` bookkeeping lets the
// layer undo itself on rigs where the mixer doesn't rewrite that bone every
// frame (bot.glb's Idle drives 6 of 43 bones) — otherwise the additive rotation
// would accumulate frame over frame.
type BoneLayer = {
  bone: THREE.Object3D;
  base: THREE.Quaternion;
  applied: THREE.Quaternion;
  hasApplied: boolean;
};

function makeLayer(bone: THREE.Object3D): BoneLayer {
  return { bone, base: new THREE.Quaternion(), applied: new THREE.Quaternion(), hasApplied: false };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a: number, b: number, t: number) => {
  const u = clamp((t - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

export class CharacterAnimator {
  private readonly root: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly loco: LocomotionBlender;
  private readonly hold: WeaponHold;
  private readonly jumpAction: THREE.AnimationAction | null;
  private readonly deathAction: THREE.AnimationAction | null;
  private readonly spine: Array<{ layer: BoneLayer; share: number }> = [];
  private readonly legs: {
    leadThigh: BoneLayer;
    leadShin: BoneLayer;
    trailThigh: BoneLayer;
    trailShin: BoneLayer;
  } | null;

  // Motion tracking (from the entity's world position).
  private readonly prev = new THREE.Vector3();
  private hasPrev = false;
  private vx = 0;
  private vz = 0;
  private prevVy = 0;
  private speed = 0; // smoothed horizontal speed (m/s)
  private airborne = false; // committed airborne state
  private airTimer = 0;
  private groundTimer = 0;
  private minVy = 0; // fastest descent this airtime → landing impact
  private sinceFastFall = Infinity; // seconds since vy was last below LAND_IMPACT_VY
  // Procedural layer state.
  private air = 0; // leg-tuck amount 0..1 (smoothed)
  private airTarget = 0;
  private landT = -1; // landing envelope clock, <0 = idle
  private landAmp = 0;
  private leanFwd = 0;
  private leanSide = 0;
  private runDir = 1;
  private aimPitch = 0;
  // Death.
  private dying = false;
  private deathT = 0;
  private deathDuration = DEATH_COLLAPSE_SEC;
  private deathRollSign = 1;
  // Scratch.
  private readonly qRoot = new THREE.Quaternion();
  private readonly qParent = new THREE.Quaternion();
  private readonly qTmp = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor(root: THREE.Object3D, animations: THREE.AnimationClip[]) {
    this.root = root;
    // Yaw first, then lean/topple about the yawed body's own axes.
    root.rotation.order = 'YXZ';
    this.mixer = new THREE.AnimationMixer(root);
    this.hold = new WeaponHold(root);

    const idleClip = pickClip(animations, ['idle'], 0);
    const walkClip = pickClip(animations, ['walk', 'walking'], 3);
    const runClip = pickClip(animations, ['run', 'running'], 1);
    const jumpClip = pickClip(animations, ['jump']);
    const deathClip = pickClip(animations, ['death', 'die', 'dying']);
    this.loco = new LocomotionBlender({
      idle: idleClip ? this.mixer.clipAction(idleClip) : null,
      walk: walkClip ? this.mixer.clipAction(walkClip) : null,
      run: runClip ? this.mixer.clipAction(runClip) : null,
    });
    this.jumpAction = jumpClip ? this.mixer.clipAction(jumpClip) : null;
    this.deathAction = deathClip ? this.mixer.clipAction(deathClip) : null;

    const bones = new Map<string, THREE.Object3D>();
    root.traverse((obj) => {
      if ((obj as THREE.Bone).isBone && !bones.has(obj.name)) bones.set(obj.name, obj);
    });
    for (const { names, share } of SPINE_CHAIN) {
      const bone = findBone(bones, root, names);
      if (bone) this.spine.push({ layer: makeLayer(bone), share });
    }
    const lt = findBone(bones, root, LEG_BONES.leadThigh);
    const ls = findBone(bones, root, LEG_BONES.leadShin);
    const rt = findBone(bones, root, LEG_BONES.trailThigh);
    const rs = findBone(bones, root, LEG_BONES.trailShin);
    this.legs =
      lt && ls && rt && rs
        ? { leadThigh: makeLayer(lt), leadShin: makeLayer(ls), trailThigh: makeLayer(rt), trailShin: makeLayer(rs) }
        : null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // Start dying: play the rig's death clip if it has one (clamped on its last
  // frame), else freeze the gait and run the procedural collapse. The owner
  // keeps calling update() with the position frozen at the death spot and
  // hides the body once deathDone().
  //
  // Returns false — and does nothing — when the body wasn't on the ground at
  // the moment of death: the position freezes where the server left it and
  // the client has no floor to drop a corpse onto, so a mid-air kill should
  // vanish instantly (the kill burst covers it) rather than collapse in the air.
  die(): boolean {
    if (this.dying) return true;
    if (this.airborne || this.airTimer > 0) return false;
    this.dying = true;
    this.deathT = 0;
    this.deathRollSign = Math.random() < 0.5 ? -1 : 1;
    this.landT = -1;
    this.airTarget = 0;
    if (this.deathAction) {
      this.deathDuration = this.deathAction.getClip().duration;
      this.jumpAction?.fadeOut(ONESHOT_FADE_SEC);
      this.loco.fadeOut(ONESHOT_FADE_SEC);
      this.playOneShot(this.deathAction);
    } else {
      this.deathDuration = DEATH_COLLAPSE_SEC;
      this.loco.freeze();
    }
    return true;
  }

  isDying(): boolean {
    return this.dying;
  }

  // True once the death clip/collapse has played AND the last frame has been
  // held for its beat — the owner hides the body at this point.
  deathDone(): boolean {
    return this.dying && this.deathT >= this.deathDuration + DEATH_HOLD_SEC;
  }

  // Back to a clean standing pose at a new position (respawn / replay reappear).
  respawn(pos?: THREE.Vector3): void {
    this.dying = false;
    this.deathT = 0;
    this.deathAction?.stop();
    this.jumpAction?.stop();
    this.loco.start();
    this.air = 0;
    this.airTarget = 0;
    this.landT = -1;
    this.leanFwd = 0;
    this.leanSide = 0;
    this.runDir = 1;
    this.aimPitch = 0;
    this.root.position.y = 0;
    this.resetMotion(pos);
  }

  // Forget the motion history (the next frame's displacement is not a move).
  // Call when the entity is placed somewhere discontinuously while visible.
  resetMotion(pos?: THREE.Vector3): void {
    if (pos) {
      this.prev.copy(pos);
      this.hasPrev = true;
    } else {
      this.hasPrev = false;
    }
    this.vx = 0;
    this.vz = 0;
    this.prevVy = 0;
    this.speed = 0;
    this.airborne = false;
    this.airTimer = 0;
    this.groundTimer = 0;
    this.minVy = 0;
    this.sinceFastFall = Infinity;
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  // Advance everything one frame. Order: measure motion → gait blend → mixer →
  // gun-carry arm pin → root yaw/lean/sink → additive bone layers. The caller
  // re-seats its hat AFTER this (the hat follows the head bone's world matrix).
  update(inp: CharacterAnimInput): void {
    const dt = inp.dt > 0 ? Math.min(inp.dt, MAX_DT) : 0;
    this.trackMotion(inp.pos, dt);

    // Movement relative to facing. Model forward at `yaw` is (-sin, -cos) and
    // its right is (cos, -sin) — see remote-player.ts for the convention.
    const sy = Math.sin(inp.yaw);
    const cy = Math.cos(inp.yaw);
    const fwd = -(this.vx * sy + this.vz * cy);
    const side = this.vx * cy - this.vz * sy;
    const kLean = 1 - Math.exp(-LEAN_SMOOTH_HZ * dt);
    this.leanFwd += (clamp(fwd / LEAN_REF_SPEED, -1, 1) - this.leanFwd) * kLean;
    this.leanSide += (clamp(side / LEAN_REF_SPEED, -1, 1) - this.leanSide) * kLean;
    const dirTarget = this.speed > IDLE_FLOOR && fwd < -REVERSE_FRAC * this.speed ? -1 : 1;
    this.runDir += (dirTarget - this.runDir) * (1 - Math.exp(-DIR_SMOOTH_HZ * dt));

    // Aim pitch — frozen at death so the corpse keeps its last aim.
    if (!this.dying) {
      const target = clamp(inp.pitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
      this.aimPitch += (target - this.aimPitch) * (1 - Math.exp(-PITCH_SMOOTH_HZ * dt));
    }

    // Airborne tuck + landing settle envelopes.
    this.air += (this.airTarget - this.air) * (1 - Math.exp(-AIR_POSE_HZ * dt));
    let land = 0;
    if (this.landT >= 0) {
      this.landT += dt;
      const u = this.landT / LAND_SEC;
      if (u >= 1) this.landT = -1;
      else land = Math.sin(Math.PI * u) * this.landAmp;
    }

    // Death envelopes (procedural path only; a death clip animates itself).
    let deathPitch = 0;
    let deathRoll = 0;
    let deathSink = 0;
    let deathSpine = 0;
    let deathKnee = 0;
    if (this.dying) {
      this.deathT += dt;
      if (!this.deathAction) {
        const t = this.deathT;
        const buckle = smoothstep(0, DEATH_BUCKLE_SEC, t);
        const tp = clamp((t - DEATH_TOPPLE_DELAY) / DEATH_TOPPLE_SEC, 0, 1);
        const topple = tp * tp; // gravity-like: accelerates into the floor
        deathPitch = -DEATH_PITCH * topple;
        deathRoll = this.deathRollSign * DEATH_ROLL * topple;
        deathSink = DEATH_BUCKLE_SINK * buckle * (1 - topple) + DEATH_FLAT_SINK * topple;
        deathSpine = -DEATH_SPINE * buckle;
        deathKnee = buckle * (1 - 0.5 * topple);
      }
    }

    // Clips: gait blend (idle while airborne — the tuck/jump clip is the pose),
    // then the mixer, then the gun-carry pin over the animated arms (skipped
    // while dead so the death pose is free).
    this.loco.update(this.airborne ? 0 : this.speed, dt, this.runDir);
    this.mixer.update(dt);
    if (!this.dying) this.hold.apply();

    // Root: yaw, lean into the movement, forward pitch in the air, death
    // topple; sink for the land settle and collapse. Rotation order is YXZ so
    // X/Z act about the yawed body's own axes. Negative X = lean forward.
    const rootPitch = -LEAN_PITCH * this.leanFwd + AIR_ROOT_PITCH * this.air + deathPitch;
    const rootRoll = -LEAN_ROLL * this.leanSide + deathRoll;
    this.root.rotation.set(rootPitch, inp.yaw, rootRoll);
    this.root.position.y = -(LAND_SINK * land + deathSink);
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.qRoot);

    // Additive bone layers, all about the model's right axis (+ = tilt back /
    // look up, − = bend forward). Applied after the mixer so the clips still
    // play underneath; the hat and gun ride the rotated bones.
    const spineTotal = this.aimPitch + AIR_SPINE * this.air - LAND_SPINE * land + deathSpine;
    for (const s of this.spine) this.applyLayer(s.layer, spineTotal * s.share);
    if (this.legs) {
      const tuck = this.jumpAction ? 0 : this.air; // a jump clip owns the legs
      this.applyLayer(this.legs.leadThigh, AIR_LEAD_THIGH * tuck + DEATH_KNEE_THIGH * deathKnee);
      this.applyLayer(this.legs.leadShin, AIR_LEAD_SHIN * tuck - DEATH_KNEE_SHIN * deathKnee);
      this.applyLayer(this.legs.trailThigh, AIR_TRAIL_THIGH * tuck + DEATH_KNEE_THIGH * deathKnee);
      this.applyLayer(this.legs.trailShin, AIR_TRAIL_SHIN * tuck - DEATH_KNEE_SHIN * deathKnee);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  // Derive velocity + ground/air state from the entity's world position. The
  // server owns the position; we only watch it. Teleports (respawn, replay
  // seek) are rejected; single-frame vertical pops (auto-step) are ignored.
  private trackMotion(pos: THREE.Vector3, dt: number): void {
    if (dt <= 0) return;
    if (!this.hasPrev) {
      this.prev.copy(pos);
      this.hasPrev = true;
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
    this.vx = dx / dt;
    this.vz = dz / dt;
    this.speed += (hs - this.speed) * (1 - Math.exp(-SPEED_SMOOTH_HZ * dt));
    const vy = Math.abs(vyRaw) > VERTICAL_SNAP_SPEED ? this.prevVy : vyRaw;
    this.sinceFastFall = vy < LAND_IMPACT_VY ? 0 : this.sinceFastFall + dt;

    const still = Math.abs(vy) < GROUND_VY;
    if (!this.airborne) {
      if (still) {
        this.airTimer = 0;
      } else {
        this.airTimer += dt;
        const launch = vy > TAKEOFF_VY;
        if (this.airTimer >= (launch ? AIR_COMMIT_JUMP_SEC : AIR_COMMIT_FALL_SEC)) {
          this.airborne = true;
          this.groundTimer = 0;
          this.minVy = Math.min(0, vy);
          this.onTakeoff(launch);
        }
      }
    } else {
      if (vy < this.minVy) this.minVy = vy;
      const impact = still && this.sinceFastFall <= LAND_IMPACT_WINDOW_SEC;
      this.groundTimer = still ? this.groundTimer + dt : 0;
      if (impact || this.groundTimer >= GROUND_COMMIT_SEC) {
        this.airborne = false;
        this.airTimer = 0;
        this.onLand(-this.minVy);
      } else if (vy > TAKEOFF_VY && vy - this.prevVy > TAKEOFF_VY) {
        this.onTakeoff(true); // mid-air re-launch: double jump / boost
      }
    }
    this.prevVy = vy;
  }

  private onTakeoff(launch: boolean): void {
    if (this.dying) return;
    this.landT = -1;
    if (this.jumpAction) {
      this.loco.fadeOut(ONESHOT_FADE_SEC);
      this.playOneShot(this.jumpAction);
    } else {
      this.airTarget = launch ? 1 : FALL_TUCK;
    }
  }

  private onLand(impactSpeed: number): void {
    if (this.dying) return;
    this.airTarget = 0;
    this.landAmp = clamp((impactSpeed - LAND_IMPACT_MIN) / (LAND_IMPACT_MAX - LAND_IMPACT_MIN), LAND_MIN_AMP, 1);
    this.landT = 0;
    if (this.jumpAction) {
      this.jumpAction.fadeOut(ONESHOT_FADE_SEC);
      this.loco.start();
    }
  }

  private playOneShot(a: THREE.AnimationAction): void {
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.setEffectiveWeight(1);
    a.play();
  }

  // Rotate `layer.bone` by `angle` about the model's right axis, in place, on
  // top of whatever the mixer wrote this frame.
  private applyLayer(layer: BoneLayer, angle: number): void {
    const q = layer.bone.quaternion;
    // If the mixer didn't rewrite this bone since last frame, our previous
    // additive rotation is still in it — peel it off before re-applying.
    if (layer.hasApplied && q.equals(layer.applied)) q.copy(layer.base);
    layer.base.copy(q);
    if (angle !== 0) {
      const parent = layer.bone.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.getWorldQuaternion(this.qParent);
        // Model-right in world space → expressed in the bone's parent frame.
        this.axis.set(1, 0, 0).applyQuaternion(this.qRoot).applyQuaternion(this.qParent.invert());
        this.qTmp.setFromAxisAngle(this.axis, angle);
        q.premultiply(this.qTmp);
      }
    }
    layer.applied.copy(q);
    layer.hasApplied = true;
  }
}
