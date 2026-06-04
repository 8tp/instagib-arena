import * as THREE from 'three';
import type { EmoteKind } from './cosmetics';

// Procedural emotes for the soldier (Mixamo) rig. The idle clip plays underneath;
// each frame we OVERRIDE a small set of arm bones from a mixer-sampled
// idle reference pose and move the whole outer group (bob/spin/sway). Kept here
// so the podium and the Locker preview share one tuned implementation.
//
// The rig faces -Z at identity; model-space +X is the soldier's right side.
// Explicit limb directions were tuned against the /lockerlab harness.

const BONES = [
  'mixamorigRightArm',
  'mixamorigLeftArm',
  'mixamorigRightForeArm',
  'mixamorigLeftForeArm',
] as const;
type BoneName = (typeof BONES)[number];

export type EmoteRig = {
  model: THREE.Object3D;
  bones: Partial<Record<BoneName, THREE.Bone>>;
  base: Partial<Record<BoneName, THREE.Quaternion>>;
  axes: Partial<Record<BoneName, THREE.Vector3>>;
  phase: number; // per-instance so two characters don't move in lockstep
};

export function buildEmoteRig(model: THREE.Object3D, phase = 0): EmoteRig {
  const bones: EmoteRig['bones'] = {};
  const axes: EmoteRig['axes'] = {};
  for (const name of BONES) {
    const b = model.getObjectByName(name) as THREE.Bone | undefined;
    if (!b) continue;
    bones[name] = b;
    const child = b.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
    if (child && child.position.lengthSq() > 1e-8) axes[name] = child.position.clone().normalize();
  }
  return { model, bones, base: {}, axes, phase };
}

const _modelWorldQ = new THREE.Quaternion();
const _parentWorldQ = new THREE.Quaternion();
const _deltaQ = new THREE.Quaternion();
const _desired = new THREE.Vector3();
const _reference = new THREE.Vector3();

// Aim a bone's child toward a direction expressed in soldier-model space. The
// delta is applied to the sampled idle quaternion, preserving the natural twist
// around the limb while avoiding brittle guesses about each Mixamo bone's local
// Euler axes.
function aimBone(rig: EmoteRig, name: BoneName, x: number, y: number, z: number) {
  const b = rig.bones[name];
  const base = rig.base[name];
  const axis = rig.axes[name];
  if (!b || !base || !axis || !b.parent) return;

  b.parent.updateWorldMatrix(true, false);
  rig.model.getWorldQuaternion(_modelWorldQ);
  b.parent.getWorldQuaternion(_parentWorldQ);

  _desired.set(x, y, z).normalize().applyQuaternion(_modelWorldQ);
  _desired.applyQuaternion(_parentWorldQ.invert());
  _reference.copy(axis).applyQuaternion(base);
  _deltaQ.setFromUnitVectors(_reference, _desired);
  b.quaternion.copy(base).premultiply(_deltaQ);
}

function arm(rig: EmoteRig, side: 'left' | 'right', x: number, y: number, z = 0) {
  const arm = (side === 'right' ? 'mixamorigRightArm' : 'mixamorigLeftArm') as BoneName;
  aimBone(rig, arm, x, y, z);
}

function foreArm(rig: EmoteRig, side: 'left' | 'right', x: number, y: number, z = 0) {
  const fa = (side === 'right' ? 'mixamorigRightForeArm' : 'mixamorigLeftForeArm') as BoneName;
  aimBone(rig, fa, x, y, z);
}

// Drive one emote frame. `group` is the outer follower (yaw/position); `baseYaw`
// is its resting facing; `baseY` its resting height; `t` seconds.
//
// INVARIANT: call this AFTER mixer.update() each frame. We only override the
// bones an emote explicitly poses; every other bone is reset to the idle clip by
// mixer.update, so switching emotes never strands a bone. The current set only
// poses arms/forearms, all keyed by idle. A future emote that poses an un-keyed
// bone (e.g. a finger) would need an explicit reset here.
export function applyEmote(
  rig: EmoteRig,
  group: THREE.Object3D,
  baseYaw: number,
  baseY: number,
  t: number,
  kind: EmoteKind,
) {
  const p = rig.phase;
  // buildEmoteRig runs before the first mixer tick. Capture the first
  // mixer-written idle pose here so arm overrides start from a natural stance,
  // not the GLB's bind T-pose or a different live arm swing every frame.
  for (const name of BONES) {
    const b = rig.bones[name];
    if (b && !rig.base[name]) rig.base[name] = b.quaternion.clone();
  }
  // Reset the group each frame (the mixer never touches it).
  group.position.y = baseY;
  group.rotation.set(0, baseYaw, 0);
  const bob = (amp: number, freq: number, off = 0) => baseY + Math.abs(Math.sin(t * freq + off)) * amp;

  switch (kind) {
    case 'cheer': {
      // Both arms up in a celebratory V, forearms straight, energetic jumps.
      group.position.y = bob(0.14, 6.5, p);
      const wiggle = Math.sin(t * 8 + p) * 0.15;
      arm(rig, 'right', 0.55 + wiggle * 0.1, 0.84, 0);
      arm(rig, 'left', -0.55 - wiggle * 0.1, 0.84, 0);
      foreArm(rig, 'right', 0.55, 0.84 + wiggle * 0.1, 0);
      foreArm(rig, 'left', -0.55, 0.84 - wiggle * 0.1, 0);
      break;
    }
    case 'wave': {
      // Right arm up to the side, forearm waving; left arm relaxed at idle.
      const wave = Math.sin(t * 7 + p);
      arm(rig, 'right', 0.78, 0.63, 0);
      foreArm(rig, 'right', 0.2 + wave * 0.22, 0.98, 0);
      group.rotation.z = Math.sin(t * 3 + p) * 0.02;
      break;
    }
    case 'flex': {
      // Double-biceps: upper arms out to the sides, forearms curled beside the
      // head, and a slow show-off turn.
      group.rotation.y = baseYaw + Math.sin(t * 0.9) * 0.5;
      arm(rig, 'right', 1, 0.08, 0);
      arm(rig, 'left', -1, 0.08, 0);
      foreArm(rig, 'right', 0.12, 1, 0);
      foreArm(rig, 'left', -0.12, 1, 0);
      break;
    }
    case 'spin': {
      // Full-body spin with a bouncing hop; arms flung out for flair.
      group.rotation.y = baseYaw + t * 3.2;
      group.position.y = bob(0.06, 6.4, p);
      arm(rig, 'right', 1, 0.08, 0);
      arm(rig, 'left', -1, 0.08, 0);
      foreArm(rig, 'right', 1, 0.08, 0);
      foreArm(rig, 'left', -1, 0.08, 0);
      break;
    }
    case 'dance': {
      // Hip sway + bob + alternating arm pumps (disco point).
      const sway = Math.sin(t * 5 + p);
      group.rotation.z = sway * 0.1;
      group.rotation.y = baseYaw + sway * 0.22;
      group.position.y = bob(0.07, 5, p);
      const pump = (sway + 1) * 0.5; // 0..1
      const rightY = 0.25 + pump * 0.75;
      const leftY = 0.25 + (1 - pump) * 0.75;
      arm(rig, 'right', 0.72, rightY, 0);
      arm(rig, 'left', -0.72, leftY, 0);
      foreArm(rig, 'right', 0.72, rightY, 0);
      foreArm(rig, 'left', -0.72, leftY, 0);
      break;
    }
    case 'idle':
    default:
      // Let the idle clip play; just a barely-there breathing bob.
      group.position.y = baseY + Math.sin(t * 1.6 + p) * 0.01;
      break;
  }
}
