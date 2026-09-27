import * as THREE from 'three';

// ── The arena combatant's skeleton ───────────────────────────────────────────
//
// A small, clean, code-defined rig. Every bone's REST orientation is identity
// and limbs hang straight down (-Y), so a pose is just a per-bone local
// rotation in the model's own axes:
//   model space: +Y up, the character faces -Z, its RIGHT side is +X.
//   limbs:  +X rotation swings a hanging limb FORWARD; ±Z abducts; Y twists.
//   elbow:  forearm +X flexes forward; knee: shin −X flexes back.
//
// The bones are FLAT children of the character root (not a THREE hierarchy):
// this module runs its own forward kinematics and writes each bone's
// model-space matrix. That keeps IK trivial (every joint position is at hand)
// and lets the gib system fling each bone independently (see gibs.ts).

export const BONE_NAMES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'clavicle.L',
  'upperArm.L',
  'foreArm.L',
  'hand.L',
  'clavicle.R',
  'upperArm.R',
  'foreArm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
  'crest', // helmet crest fin — its own bone so it can hide under a hat
] as const;
export type BoneName = (typeof BONE_NAMES)[number];
export const BONE_COUNT = BONE_NAMES.length;

export const B = {
  root: 0,
  hips: 1,
  spine: 2,
  chest: 3,
  neck: 4,
  head: 5,
  clavicleL: 6,
  upperArmL: 7,
  foreArmL: 8,
  handL: 9,
  clavicleR: 10,
  upperArmR: 11,
  foreArmR: 12,
  handR: 13,
  thighL: 14,
  shinL: 15,
  footL: 16,
  thighR: 17,
  shinR: 18,
  footR: 19,
  crest: 20,
} as const;

export const BONE_INDEX: Record<BoneName, number> = Object.fromEntries(
  BONE_NAMES.map((n, i) => [n, i]),
) as Record<BoneName, number>;

// Parent of each bone (topological order: parents always precede children).
export const PARENT: readonly number[] = [
  -1, // root
  B.root, // hips
  B.hips, // spine
  B.spine, // chest
  B.chest, // neck
  B.neck, // head
  B.chest, // clavicle.L
  B.clavicleL, // upperArm.L
  B.upperArmL, // foreArm.L
  B.foreArmL, // hand.L
  B.chest, // clavicle.R
  B.clavicleR, // upperArm.R
  B.upperArmR, // foreArm.R
  B.foreArmR, // hand.R
  B.hips, // thigh.L
  B.thighL, // shin.L
  B.shinL, // foot.L
  B.hips, // thigh.R
  B.thighR, // shin.R
  B.shinR, // foot.R
  B.head, // crest
];

// Absolute rest positions (model space, metres). 1.8 m athlete: hip 0.915,
// shoulder 1.415, eye ≈ 1.64, helmet crown 1.80. Headshots count above
// 0.72·1.8 = 1.296 m, so the whole head + helmet sits in that band.
const SHOULDER_X = 0.235;
const HIP_X = 0.1;
export const REST_ABS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], // root (feet)
  [0, 0.97, 0], // hips
  [0, 1.07, 0], // spine
  [0, 1.22, 0], // chest
  [0, 1.48, 0], // neck
  [0, 1.565, 0], // head
  [-0.05, 1.43, -0.005], // clavicle.L
  [-SHOULDER_X, 1.415, 0], // upperArm.L
  [-SHOULDER_X, 1.125, 0], // foreArm.L
  [-SHOULDER_X, 0.87, 0], // hand.L
  [0.05, 1.43, -0.005], // clavicle.R
  [SHOULDER_X, 1.415, 0], // upperArm.R
  [SHOULDER_X, 1.125, 0], // foreArm.R
  [SHOULDER_X, 0.87, 0], // hand.R
  [-HIP_X, 0.915, 0], // thigh.L
  [-HIP_X, 0.505, 0], // shin.L
  [-HIP_X, 0.095, 0], // foot.L
  [HIP_X, 0.915, 0], // thigh.R
  [HIP_X, 0.505, 0], // shin.R
  [HIP_X, 0.095, 0], // foot.R
  [0, 1.78, 0], // crest
];

// Rest offset of each bone from its parent.
export const REST_LOCAL: readonly (readonly [number, number, number])[] = REST_ABS.map((p, i) => {
  const par = PARENT[i];
  if (par < 0) return p;
  const pp = REST_ABS[par];
  return [p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]] as const;
});

export const UPPER_ARM_LEN = REST_ABS[B.upperArmL][1] - REST_ABS[B.foreArmL][1];
export const FORE_ARM_LEN = REST_ABS[B.foreArmL][1] - REST_ABS[B.handL][1];
export const THIGH_LEN = REST_ABS[B.thighL][1] - REST_ABS[B.shinL][1];
export const SHIN_LEN = REST_ABS[B.shinL][1] - REST_ABS[B.footL][1];
export const ANKLE_H = REST_ABS[B.footL][1];

// Socket attachment points, in the owning bone's local frame.
export const SOCKETS = {
  headTop: { bone: B.head, pos: [0, 0.232, 0.012] as const }, // helmet crown (hats)
  gun: { bone: B.handR, pos: [0, -0.065, -0.012] as const }, // palm centre (railgun grip)
  chest: { bone: B.chest, pos: [0, 0.12, -0.12] as const }, // sternum (particles)
} as const;
export type SocketName = keyof typeof SOCKETS;

// ── Pose: local rotation + translation offset per bone ──────────────────────
export class Pose {
  readonly q = new Float32Array(BONE_COUNT * 4);
  readonly t = new Float32Array(BONE_COUNT * 3);
  constructor() {
    this.reset();
  }
  reset(): this {
    this.q.fill(0);
    this.t.fill(0);
    for (let i = 0; i < BONE_COUNT; i++) this.q[i * 4 + 3] = 1;
    return this;
  }
  copy(o: Pose): this {
    this.q.set(o.q);
    this.t.set(o.t);
    return this;
  }
  setQ(i: number, q: THREE.Quaternion): void {
    const o = i * 4;
    this.q[o] = q.x;
    this.q[o + 1] = q.y;
    this.q[o + 2] = q.z;
    this.q[o + 3] = q.w;
  }
  getQ(i: number, out: THREE.Quaternion): THREE.Quaternion {
    const o = i * 4;
    return out.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
  }
  setEuler(i: number, x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ'): void {
    _e.set(x, y, z, order);
    _q.setFromEuler(_e);
    this.setQ(i, _q);
  }
  // Rotate bone i's local rotation by an extra euler (pre-multiplied in the
  // bone's own frame: q = q · e). Used for additive layers.
  addEuler(i: number, x: number, y: number, z: number): void {
    if (x === 0 && y === 0 && z === 0) return;
    this.getQ(i, _q);
    _e.set(x, y, z, 'XYZ');
    _q2.setFromEuler(_e);
    _q.multiply(_q2);
    this.setQ(i, _q);
  }
  // Rotate in the PARENT's frame (q = e · q) — e.g. yaw a limb about model up.
  preEuler(i: number, x: number, y: number, z: number): void {
    if (x === 0 && y === 0 && z === 0) return;
    this.getQ(i, _q);
    _e.set(x, y, z, 'XYZ');
    _q2.setFromEuler(_e);
    _q.premultiply(_q2);
    this.setQ(i, _q);
  }
  setT(i: number, x: number, y: number, z: number): void {
    const o = i * 3;
    this.t[o] = x;
    this.t[o + 1] = y;
    this.t[o + 2] = z;
  }
  addT(i: number, x: number, y: number, z: number): void {
    const o = i * 3;
    this.t[o] += x;
    this.t[o + 1] += y;
    this.t[o + 2] += z;
  }
  // this = lerp(this, o, w) (slerp rotations, lerp translations).
  blend(o: Pose, w: number): this {
    if (w <= 0) return this;
    if (w >= 1) return this.copy(o);
    for (let i = 0; i < BONE_COUNT; i++) {
      this.getQ(i, _q);
      o.getQ(i, _q2);
      _q.slerp(_q2, w);
      this.setQ(i, _q);
    }
    for (let k = 0; k < this.t.length; k++) this.t[k] += (o.t[k] - this.t[k]) * w;
    return this;
  }
  // Blend only the given bones.
  blendBones(o: Pose, w: number, bones: readonly number[]): this {
    if (w <= 0) return this;
    for (const i of bones) {
      this.getQ(i, _q);
      o.getQ(i, _q2);
      _q.slerp(_q2, Math.min(1, w));
      this.setQ(i, _q);
      for (let k = i * 3; k < i * 3 + 3; k++) this.t[k] += (o.t[k] - this.t[k]) * Math.min(1, w);
    }
    return this;
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s1 = new THREE.Vector3(1, 1, 1);
const _sv = new THREE.Vector3();

// ── Rig instance: bones + skeleton + FK/IK ──────────────────────────────────
export class Rig {
  readonly bones: THREE.Bone[] = [];
  readonly skeleton: THREE.Skeleton;
  readonly pose = new Pose();
  // Model-space results of the last FK pass.
  readonly mp = new Float32Array(BONE_COUNT * 3);
  readonly mq = new Float32Array(BONE_COUNT * 4);
  // Gib/override mode: when set, writeBones() leaves these bones' matrices alone.
  frozen = false;
  // Per-bone display scale (e.g. the crest shrinks to nothing under a hat).
  readonly boneScale = new Float32Array(BONE_COUNT).fill(1);

  constructor(parent: THREE.Object3D) {
    const inverses: THREE.Matrix4[] = [];
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.name = BONE_NAMES[i];
      b.matrixAutoUpdate = false;
      parent.add(b);
      this.bones.push(b);
      const r = REST_ABS[i];
      inverses.push(new THREE.Matrix4().makeTranslation(-r[0], -r[1], -r[2]));
    }
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.solveFK();
    this.writeBones();
  }

  // Forward kinematics from bone `from` onward (bones are topologically sorted,
  // so recomputing a suffix after changing one bone's local transform is safe
  // as long as every bone ≥ from only depends on bones < from or recomputed ones).
  solveFK(from = 0): void {
    const { mp, mq, pose } = this;
    for (let i = from; i < BONE_COUNT; i++) {
      const par = PARENT[i];
      const rl = REST_LOCAL[i];
      const tx = rl[0] + pose.t[i * 3];
      const ty = rl[1] + pose.t[i * 3 + 1];
      const tz = rl[2] + pose.t[i * 3 + 2];
      pose.getQ(i, _q);
      if (par < 0) {
        mp[0] = tx;
        mp[1] = ty;
        mp[2] = tz;
        mq[0] = _q.x;
        mq[1] = _q.y;
        mq[2] = _q.z;
        mq[3] = _q.w;
        continue;
      }
      _q2.set(mq[par * 4], mq[par * 4 + 1], mq[par * 4 + 2], mq[par * 4 + 3]);
      _v.set(tx, ty, tz).applyQuaternion(_q2);
      mp[i * 3] = mp[par * 3] + _v.x;
      mp[i * 3 + 1] = mp[par * 3 + 1] + _v.y;
      mp[i * 3 + 2] = mp[par * 3 + 2] + _v.z;
      _q2.multiply(_q);
      mq[i * 4] = _q2.x;
      mq[i * 4 + 1] = _q2.y;
      mq[i * 4 + 2] = _q2.z;
      mq[i * 4 + 3] = _q2.w;
    }
  }

  // Recompute FK only for bone i and its descendants (cheap enough to just run
  // the suffix — the rig is 20 bones).
  refresh(i: number): void {
    this.solveFK(i);
  }

  writeBones(): void {
    if (this.frozen) return;
    for (let i = 0; i < BONE_COUNT; i++) {
      _v.set(this.mp[i * 3], this.mp[i * 3 + 1], this.mp[i * 3 + 2]);
      _q.set(this.mq[i * 4], this.mq[i * 4 + 1], this.mq[i * 4 + 2], this.mq[i * 4 + 3]);
      const sc = this.boneScale[i];
      this.bones[i].matrix.compose(_v, _q, sc === 1 ? _s1 : _sv.set(sc, sc, sc));
      this.bones[i].matrixWorldNeedsUpdate = true;
    }
  }

  modelPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.mp[i * 3], this.mp[i * 3 + 1], this.mp[i * 3 + 2]);
  }
  modelQuat(i: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.set(this.mq[i * 4], this.mq[i * 4 + 1], this.mq[i * 4 + 2], this.mq[i * 4 + 3]);
  }

  // Give bone i the MODEL-space orientation `q` by solving its local rotation
  // against the parent's current model rotation (FK of the parent must be
  // current). Does not refresh descendants — call refresh() after.
  setModelQuat(i: number, q: THREE.Quaternion): void {
    const par = PARENT[i];
    if (par < 0) {
      this.pose.setQ(i, q);
      return;
    }
    this.modelQuat(par, _q2).invert().multiply(q);
    this.pose.setQ(i, _q2);
  }

  // Analytic two-bone IK. Places `upper`→`lower`→`end` so `end` reaches
  // `target` (model space), bending toward `pole` (a model-space direction
  // the middle joint should point toward). `flexSign` is the side of the
  // upper bone's local Z the lower bone folds to: −1 for arms (elbow flexes
  // forward/−Z), +1 for legs (knee folds back/+Z). Solves the two local
  // rotations; the caller refreshes FK. Returns the reach ratio (≤1 reached).
  solveTwoBone(
    upper: number,
    lower: number,
    end: number,
    target: THREE.Vector3,
    pole: THREE.Vector3,
    flexSign: number,
  ): number {
    const a = Math.abs(REST_LOCAL[lower][1]); // upper length (rest along -Y)
    const b = Math.abs(REST_LOCAL[end][1]);
    const S = this.modelPos(upper, _ikS);
    _ikD.subVectors(target, S);
    let d = _ikD.length();
    const reach = d / (a + b);
    const dMin = Math.abs(a - b) + 1e-3;
    const dMax = a + b - 1e-4;
    if (d < 1e-5) _ikD.set(0, -1, 0);
    else _ikD.divideScalar(d);
    d = Math.min(dMax, Math.max(dMin, d));
    // Angle at the upper joint between S→T and S→E.
    const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    // Pole direction orthogonal to the reach axis.
    _ikN.copy(pole).addScaledVector(_ikD, -pole.dot(_ikD));
    if (_ikN.lengthSq() < 1e-8) {
      _ikN.set(0, 0, -flexSign).addScaledVector(_ikD, -_ikD.z * -flexSign);
      if (_ikN.lengthSq() < 1e-8) _ikN.set(1, 0, 0);
    }
    _ikN.normalize();
    // Elbow/knee position and the two bone directions.
    _ikE.copy(S).addScaledVector(_ikD, a * cosA).addScaledVector(_ikN, a * sinA);
    const T = _ikT.copy(S).addScaledVector(_ikD, d);
    _ikU.subVectors(_ikE, S).normalize(); // upper bone direction
    _ikF.subVectors(T, _ikE).normalize(); // lower bone direction
    // Bend direction (component of the lower dir ⟂ upper dir); straight → -pole.
    _ikW.copy(_ikF).addScaledVector(_ikU, -_ikF.dot(_ikU));
    if (_ikW.lengthSq() < 1e-6) _ikW.copy(_ikN).negate().addScaledVector(_ikU, _ikN.dot(_ikU));
    _ikW.normalize();
    // Upper basis: Y = -dir (rest bone points down), Z = flexSign·W, X = Y×Z.
    _ikY.copy(_ikU).negate();
    _ikZ.copy(_ikW).multiplyScalar(flexSign);
    _ikX.crossVectors(_ikY, _ikZ).normalize();
    _ikZ.crossVectors(_ikX, _ikY).normalize();
    _m.makeBasis(_ikX, _ikY, _ikZ);
    _ikQ.setFromRotationMatrix(_m);
    this.setModelQuat(upper, _ikQ);
    this.solveFK(upper);
    // Lower basis: shares the hinge axis X.
    _ikY.copy(_ikF).negate();
    _ikZ.crossVectors(_ikX, _ikY).normalize();
    _m.makeBasis(_ikX, _ikY, _ikZ);
    _ikQ.setFromRotationMatrix(_m);
    this.setModelQuat(lower, _ikQ);
    this.solveFK(lower);
    return reach;
  }
}

const _ikS = new THREE.Vector3();
const _ikD = new THREE.Vector3();
const _ikN = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikU = new THREE.Vector3();
const _ikF = new THREE.Vector3();
const _ikW = new THREE.Vector3();
const _ikX = new THREE.Vector3();
const _ikY = new THREE.Vector3();
const _ikZ = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();

// Scratch exports for other character modules (avoid per-frame allocation).
export const scratch = { v: _v2, v2: _v3 };
