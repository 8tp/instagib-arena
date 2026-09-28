import type * as THREE from 'three';
import type { RailgunFinish } from '../../cosmetics';

// Contract for CUSTOM gun models (high-tier finishes carry `finish.model`).
// Built in src/game/gun/custom/<key>.ts; registered via registry.ts (owned by
// the weapon track) and used by buildRailgun (viewmodel, lod 'high') and
// AttachedRailgun (third person, lod 'low').
//
// Model space matches the standard gun (see weapon-model.ts header): the grip
// point at the origin, barrel along −Z, the muzzle Object3D at the barrel tip.
// Keep the silhouette's screen coverage ≈ the standard gun (fairness).

export type CustomGunState = {
  charge: number; // 0 = just fired … 1 = ready
  firing: number; // 1 at the shot, decays to 0 (~0.25 s)
  streak: number; // current killstreak (for streak-reactive VFX)
  reduced: boolean; // reduced effects: calm, no strobing
  lowSpec: boolean;
};

export type CustomGunInstance = {
  group: THREE.Group;
  muzzle: THREE.Object3D; // beam origin + flash anchor
  // Advance animation/VFX (frame-rate independent). Called every frame the gun is drawn.
  update(dt: number, state: CustomGunState): void;
  // Recolour for a finish that shares this model (e.g. an admin tint).
  setFinish?(finish: RailgunFinish): void;
  dispose(): void;
};

export type CustomGunBuild = (opts: { lod: 'high' | 'low'; finish: RailgunFinish }) => CustomGunInstance;
