import * as THREE from 'three';
import { B, BONE_COUNT, REST_ABS, Rig } from './rig';

// ── PoseSpec: the animation layer's output, the solver's input ───────────────
//
// Both the procedural locomotion and the authored emote clips produce a
// PoseSpec — a small set of intuitive channels:
//   r[bone]      euler (radians, order YXZ) for the "central" bones: root,
//                hips, spine, chest, neck, head, clavicles; for hands it's the
//                wrist bend relative to the forearm; for FEET it's the foot's
//                orientation relative to the ROOT (flat on the ground at 0).
//   root/hips    translation offsets (m)
//   hand[L/R]    IK wrist targets. `handSpace` chest = rest-model coordinates
//                that ride the chest (authoring: "hand at brow height"),
//                model = absolute model space (the gun hold).
//   elbow[L/R]   elbow pole directions (chest frame)
//   foot[L/R]    IK ankle targets in root (ground) space
//   knee[L/R]    knee pole directions (hips frame)
// The solver blends two specs (live ↔ emote) and resolves FK + limb IK.

export const SIDE_L = 0;
export const SIDE_R = 1;

export class PoseSpec {
  readonly r = new Float32Array(BONE_COUNT * 3);
  readonly root = new THREE.Vector3();
  readonly hips = new THREE.Vector3();
  readonly hand = [new THREE.Vector3(), new THREE.Vector3()];
  readonly elbow = [new THREE.Vector3(), new THREE.Vector3()];
  readonly foot = [new THREE.Vector3(), new THREE.Vector3()];
  readonly knee = [new THREE.Vector3(), new THREE.Vector3()];
  // 'chest': hand targets are rest-model coords riding the chest bone.
  // 'aim':   hand targets are offsets from the chest bone POSITION in the aim
  //          frame (model axes pitched by `aimPitch`) — the gun hold, which
  //          must track the view exactly whatever the torso is doing.
  handSpace: 'chest' | 'aim' = 'chest';
  aimPitch = 0;
  // Optional hand orientation (overrides r[hand]); in the aim frame when
  // handSpace is 'aim', else model space.
  readonly handQ = [new THREE.Quaternion(), new THREE.Quaternion()];
  handQOn = [false, false];
  // Clip-authored hand orientation: euler (radians, YXZ) in the hand-space
  // frame (chest or aim). Wins over handQ / the local wrist bend.
  readonly handE = [new THREE.Vector3(), new THREE.Vector3()];
  handEOn = [false, false];

  constructor() {
    this.reset();
  }

  reset(): this {
    this.r.fill(0);
    this.root.set(0, 0, 0);
    this.hips.set(0, 0, 0);
    this.hand[SIDE_L].set(-0.27, 0.9, -0.03);
    this.hand[SIDE_R].set(0.27, 0.9, -0.03);
    this.elbow[SIDE_L].set(-0.4, -0.2, 1);
    this.elbow[SIDE_R].set(0.4, -0.2, 1);
    this.foot[SIDE_L].set(-0.12, REST_ABS[B.footL][1], 0);
    this.foot[SIDE_R].set(0.12, REST_ABS[B.footR][1], 0);
    this.knee[SIDE_L].set(0, 0, -1);
    this.knee[SIDE_R].set(0, 0, -1);
    this.handSpace = 'chest';
    this.aimPitch = 0;
    this.handQOn[0] = false;
    this.handQOn[1] = false;
    this.handEOn[0] = false;
    this.handEOn[1] = false;
    return this;
  }

  copy(o: PoseSpec): this {
    this.r.set(o.r);
    this.root.copy(o.root);
    this.hips.copy(o.hips);
    for (let s = 0; s < 2; s++) {
      this.hand[s].copy(o.hand[s]);
      this.elbow[s].copy(o.elbow[s]);
      this.foot[s].copy(o.foot[s]);
      this.knee[s].copy(o.knee[s]);
      this.handQ[s].copy(o.handQ[s]);
      this.handQOn[s] = o.handQOn[s];
      this.handE[s].copy(o.handE[s]);
      this.handEOn[s] = o.handEOn[s];
    }
    this.handSpace = o.handSpace;
    this.aimPitch = o.aimPitch;
    return this;
  }

  setR(bone: number, x: number, y: number, z: number): void {
    this.r[bone * 3] = x;
    this.r[bone * 3 + 1] = y;
    this.r[bone * 3 + 2] = z;
  }
  addR(bone: number, x: number, y: number, z: number): void {
    this.r[bone * 3] += x;
    this.r[bone * 3 + 1] += y;
    this.r[bone * 3 + 2] += z;
  }
}

// Bones whose r[] is a plain local euler (applied before the limb IK).
const CENTRAL = [B.root, B.hips, B.spine, B.chest, B.neck, B.head, B.clavicleL, B.clavicleR] as const;
const ARM = [
  { upper: B.upperArmL, lower: B.foreArmL, end: B.handL, clav: B.clavicleL },
  { upper: B.upperArmR, lower: B.foreArmR, end: B.handR, clav: B.clavicleR },
] as const;
const LEG = [
  { upper: B.thighL, lower: B.shinL, end: B.footL },
  { upper: B.thighR, lower: B.shinR, end: B.footR },
] as const;

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _chestP = new THREE.Vector3();
const _chestQ = new THREE.Quaternion();
const _hipsQ = new THREE.Quaternion();
const _rootQ = new THREE.Quaternion();
const CHEST_REST = new THREE.Vector3(...REST_ABS[B.chest]);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _qAim = new THREE.Quaternion();
const _chestQi = new THREE.Quaternion();
const _tgt = [new THREE.Vector3(), new THREE.Vector3()];

function eulerQ(r: Float32Array, bone: number, out: THREE.Quaternion): THREE.Quaternion {
  _e.set(r[bone * 3], r[bone * 3 + 1], r[bone * 3 + 2], 'YXZ');
  return out.setFromEuler(_e);
}

function lerpR(a: Float32Array, b: Float32Array | null, w: number, bone: number, out: THREE.Quaternion) {
  eulerQ(a, bone, out);
  if (b && w > 0) {
    eulerQ(b, bone, _qc);
    out.slerp(_qc, w);
  }
  return out;
}

// Resolve a spec's wrist target to model space (after the central FK).
function aimQ(spec: PoseSpec, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromAxisAngle(X_AXIS, spec.aimPitch);
}

function handTarget(spec: PoseSpec, side: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(spec.hand[side]);
  if (spec.handSpace === 'chest') {
    out.sub(CHEST_REST).applyQuaternion(_chestQ).add(_chestP);
  } else {
    out.applyQuaternion(aimQ(spec, _qAim)).add(_chestP);
  }
  return out;
}

// Apply spec A (blended toward B by w) to the rig: FK, leg IK, arm IK, hands,
// feet. Leaves rig.mp/mq current; the caller writes bones.
export function solvePose(rig: Rig, A: PoseSpec, Bspec: PoseSpec | null = null, w = 0): void {
  const pose = rig.pose;
  const bw = Bspec ? Math.max(0, Math.min(1, w)) : 0;
  const Bs = bw > 0 ? Bspec : null;
  pose.reset();

  // 1. Central bones + translations.
  for (const bone of CENTRAL) pose.setQ(bone, lerpR(A.r, Bs ? Bs.r : null, bw, bone, _q));
  _va.copy(A.root);
  _vb.copy(A.hips);
  if (Bs) {
    _va.lerp(Bs.root, bw);
    _vb.lerp(Bs.hips, bw);
  }
  pose.setT(B.root, _va.x, _va.y, _va.z);
  pose.setT(B.hips, _vb.x, _vb.y, _vb.z);
  rig.solveFK();
  rig.modelPos(B.chest, _chestP);
  rig.modelQuat(B.chest, _chestQ);
  rig.modelQuat(B.hips, _hipsQ);
  rig.modelQuat(B.root, _rootQ);

  // 2. Legs: IK the ankle to the foot target (root space → model space).
  for (let s = 0; s < 2; s++) {
    const leg = LEG[s];
    _va.copy(A.foot[s]);
    if (Bs) _va.lerp(Bs.foot[s], bw);
    _va.applyQuaternion(_rootQ).add(rig.modelPos(B.root, _v));
    _pole.copy(A.knee[s]);
    if (Bs) _pole.lerp(Bs.knee[s], bw);
    _pole.applyQuaternion(_hipsQ);
    rig.solveTwoBone(leg.upper, leg.lower, leg.end, _va, _pole, 1);
    // Foot orientation relative to the root (flat at zero).
    lerpR(A.r, Bs ? Bs.r : null, bw, leg.end, _qa);
    _qa.premultiply(_rootQ);
    rig.setModelQuat(leg.end, _qa);
    rig.solveFK(leg.end);
  }

  // 3. Arms: resolve the wrist targets, shrug the clavicles toward raised
  //    arms (the pauldrons ride them), then IK each arm.
  for (let s = 0; s < 2; s++) {
    handTarget(A, s, _tgt[s]);
    if (Bs) _tgt[s].lerp(handTarget(Bs, s, _vb), bw);
  }
  _chestQi.copy(_chestQ).invert();
  for (let s = 0; s < 2; s++) {
    const arm = ARM[s];
    _v.subVectors(_tgt[s], rig.modelPos(arm.upper, _va)).applyQuaternion(_chestQi);
    const len = _v.length();
    if (len < 1e-4) continue;
    const elev = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
    const fwd = -_v.z / len;
    const shrug = Math.min(0.62, Math.max(0, (elev + 0.35) * 0.45));
    const pro = Math.min(0.22, Math.max(0, fwd * 0.2));
    if (shrug === 0 && pro === 0) continue;
    const sgn = s === SIDE_L ? -1 : 1;
    pose.getQ(arm.clav, _q);
    _e.set(0, sgn * pro, sgn * shrug, 'YXZ');
    _qa.setFromEuler(_e);
    _q.multiply(_qa);
    pose.setQ(arm.clav, _q);
  }
  rig.solveFK(B.clavicleL);
  for (let s = 0; s < 2; s++) {
    const arm = ARM[s];
    _pole.copy(A.elbow[s]);
    if (Bs) _pole.lerp(Bs.elbow[s], bw);
    _pole.applyQuaternion(_chestQ);
    rig.solveTwoBone(arm.upper, arm.lower, arm.end, _tgt[s], _pole, -1);
    // Wrist: either an explicit orientation (gun) or a local bend.
    handOrientation(rig, A, s, arm.lower, _qa);
    if (Bs) {
      handOrientation(rig, Bs, s, arm.lower, _qb);
      _qa.slerp(_qb, bw);
    }
    rig.setModelQuat(arm.end, _qa);
    rig.solveFK(arm.end);
  }
}

function handOrientation(rig: Rig, spec: PoseSpec, side: number, forearm: number, out: THREE.Quaternion) {
  // Explicit orientations are expressed in the hand-space frame.
  const frame = spec.handSpace === 'aim' ? aimQ(spec, _qAim) : _chestQ;
  if (spec.handEOn[side]) {
    const e = spec.handE[side];
    _e.set(e.x, e.y, e.z, 'YXZ');
    return out.setFromEuler(_e).premultiply(frame);
  }
  if (spec.handQOn[side]) return out.copy(spec.handQ[side]).premultiply(frame);
  eulerQ(spec.r, side === SIDE_L ? B.handL : B.handR, _q);
  return rig.modelQuat(forearm, out).multiply(_q);
}
