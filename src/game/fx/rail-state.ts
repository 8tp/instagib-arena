import type * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// The LOCAL player's rail state, shared between the weapon (weapon.ts, which
// owns the cooldown) and the first-person viewmodel (weapon-model.ts, whose
// energy coils show it). A tiny module-level link so the coils can express the
// recharge without the Game having to plumb a value through every frame.
//
//  • `charge` 0…1 (0 = just fired, 1 = ready) — written by the Railgun that
//    last fired a real shot (so a second, idle Railgun instance elsewhere can
//    never overwrite it).
//  • `shots` bumps on every real local shot — the coils flash on a change, even
//    when the training range zeroes the cooldown straight after the shot.
//  • `muzzle` — the first-person viewmodel's barrel-tip marker, registered each
//    frame it renders (`muzzleSeenMs`). The local beam + discharge leave from it
//    so the trail starts at the gun the player actually sees.
//
// A viewmodel whose owner drives it explicitly (RailgunModel.setCharge) ignores
// `charge`/`shots`; nothing else reads this.
// ─────────────────────────────────────────────────────────────────────────

export const localRail = {
  charge: 1,
  shots: 0,
  owner: null as object | null,
  muzzle: null as THREE.Object3D | null,
  muzzleSeenMs: -1e9,
};

// How long after its last render the registered viewmodel muzzle still counts
// as live (covers a dropped frame; a hidden viewmodel expires quickly).
const MUZZLE_FRESH_MS = 250;

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// World position of the live first-person muzzle into `out`, or false when no
// viewmodel has rendered recently (third person, killcam, hidden gun, tests).
export function liveViewmodelMuzzle(out: THREE.Vector3): boolean {
  const m = localRail.muzzle;
  if (!m || nowMs() - localRail.muzzleSeenMs > MUZZLE_FRESH_MS) return false;
  m.updateWorldMatrix(true, false);
  out.setFromMatrixPosition(m.matrixWorld);
  return true;
}
