import * as THREE from 'three';
import type { EmoteKind } from './cosmetics';

// Procedural emotes for the soldier (Mixamo) rig. The idle clip plays underneath;
// each frame we OVERRIDE a small set of bones (arms/spine) on top of their rest
// pose and move the whole outer group (bob/spin/sway). Kept here so the podium
// and the Locker preview share one tuned implementation.
//
// The rig faces -Z at identity; in the bind (T-)pose the arms point along ±X.
// Bone-local axes were tuned against the /lockerlab harness, not guessed.

const BONES = [
  'mixamorigHips',
  'mixamorigSpine',
  'mixamorigSpine1',
  'mixamorigSpine2',
  'mixamorigHead',
  'mixamorigRightArm',
  'mixamorigLeftArm',
  'mixamorigRightForeArm',
  'mixamorigLeftForeArm',
] as const;
type BoneName = (typeof BONES)[number];

export type EmoteRig = {
  bones: Partial<Record<BoneName, THREE.Bone>>;
  rest: Partial<Record<BoneName, THREE.Quaternion>>;
  phase: number; // per-instance so two characters don't move in lockstep
};

export function buildEmoteRig(model: THREE.Object3D, phase = 0): EmoteRig {
  const bones: EmoteRig['bones'] = {};
  const rest: EmoteRig['rest'] = {};
  for (const name of BONES) {
    const b = model.getObjectByName(name) as THREE.Bone | undefined;
    if (b) {
      bones[name] = b;
      rest[name] = b.quaternion.clone();
    }
  }
  return { bones, rest, phase };
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

// Set a bone to rest * Euler(ex,ey,ez) (radians, in the bone's local frame).
function pose(rig: EmoteRig, name: BoneName, ex: number, ey: number, ez: number) {
  const b = rig.bones[name];
  const r = rig.rest[name];
  if (!b || !r) return;
  _e.set(ex, ey, ez, 'XYZ');
  _q.setFromEuler(_e);
  b.quaternion.copy(r).multiply(_q);
}

// Mirror-symmetric arm pose, tuned against /lockerlab. In the bone's local frame
// Z raises the arm (right needs −Z, left +Z), Y swings it away from the body,
// X twists. `up` ≈ 2.0 puts the arm roughly overhead.
function armPose(rig: EmoteRig, side: 'left' | 'right', up: number, out = 0, fwd = 0) {
  const arm = (side === 'right' ? 'mixamorigRightArm' : 'mixamorigLeftArm') as BoneName;
  // The two arm bones share a local frame (not mirrored), so −Z raises BOTH;
  // only the Y "swing out" flips sign to make a symmetric V.
  const sY = side === 'right' ? -1 : 1;
  pose(rig, arm, fwd, sY * out, -up);
}

// Bend the elbow. `bend` ≈ 1.6 is a tight biceps curl.
function foreArm(rig: EmoteRig, side: 'left' | 'right', bend: number) {
  const fa = (side === 'right' ? 'mixamorigRightForeArm' : 'mixamorigLeftForeArm') as BoneName;
  pose(rig, fa, 0, 0, -bend);
}

// Drive one emote frame. `group` is the outer follower (yaw/position); `baseYaw`
// is its resting facing; `baseY` its resting height; `t` seconds.
//
// INVARIANT: call this AFTER mixer.update() each frame. We only override the
// bones an emote explicitly poses; every other bone is reset to the idle clip by
// mixer.update, so switching emotes never strands a bone — PROVIDED the idle clip
// keys any bone an emote touches. The current set only poses arms/forearms +
// spine1, all keyed by idle. A future emote that poses an un-keyed bone (e.g. a
// finger) would need an explicit reset here.
export function applyEmote(
  rig: EmoteRig,
  group: THREE.Object3D,
  baseYaw: number,
  baseY: number,
  t: number,
  kind: EmoteKind,
) {
  const p = rig.phase;
  // Reset the group each frame (the mixer never touches it).
  group.position.y = baseY;
  group.rotation.set(0, baseYaw, 0);
  const bob = (amp: number, freq: number, off = 0) => baseY + Math.abs(Math.sin(t * freq + off)) * amp;

  switch (kind) {
    case 'cheer': {
      // Both arms up in a celebratory V, forearms straight, energetic jumps.
      group.position.y = bob(0.14, 6.5, p);
      const wiggle = Math.sin(t * 8 + p) * 0.15;
      armPose(rig, 'right', 1.45 + wiggle, 0.35);
      armPose(rig, 'left', 1.45 - wiggle, 0.35);
      foreArm(rig, 'right', 0.15);
      foreArm(rig, 'left', 0.15);
      break;
    }
    case 'wave': {
      // Right arm up to the side, forearm waving; left arm relaxed at idle.
      armPose(rig, 'right', 1.55, 0.3);
      foreArm(rig, 'right', 0.35 + (Math.sin(t * 7 + p) * 0.5 + 0.5) * 0.7);
      group.rotation.z = Math.sin(t * 3 + p) * 0.02;
      break;
    }
    case 'flex': {
      // Double-biceps: upper arms out to the SIDES (small `out` so the forearms
      // curl up beside the head, not across the face — the old out:0.7 swung them
      // forward and buried the face), forearms curled up tight; slow turn.
      group.rotation.y = baseYaw + Math.sin(t * 0.9) * 0.5;
      armPose(rig, 'right', 0.7, 0.25);
      armPose(rig, 'left', 0.7, 0.25);
      foreArm(rig, 'right', 1.8);
      foreArm(rig, 'left', 1.8);
      break;
    }
    case 'spin': {
      // Full-body spin with a bouncing hop; arms flung out for flair.
      group.rotation.y = baseYaw + t * 3.2;
      group.position.y = bob(0.06, 6.4, p);
      armPose(rig, 'right', 0.3, 0.9);
      armPose(rig, 'left', 0.3, 0.9);
      foreArm(rig, 'right', 0.2);
      foreArm(rig, 'left', 0.2);
      break;
    }
    case 'dance': {
      // Hip sway + bob + alternating arm pumps (disco point).
      const sway = Math.sin(t * 5 + p);
      group.rotation.z = sway * 0.1;
      group.rotation.y = baseYaw + sway * 0.22;
      group.position.y = bob(0.07, 5, p);
      const pump = (sway + 1) * 0.5; // 0..1
      armPose(rig, 'right', 0.5 + pump * 1.1, 0.25);
      armPose(rig, 'left', 0.5 + (1 - pump) * 1.1, 0.25);
      foreArm(rig, 'right', 0.9);
      foreArm(rig, 'left', 0.9);
      break;
    }
    case 'idle':
    default:
      // Let the idle clip play; just a barely-there breathing bob.
      group.position.y = baseY + Math.sin(t * 1.6 + p) * 0.01;
      break;
  }
}
