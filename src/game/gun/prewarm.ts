import * as THREE from 'three';
import type { PostFxPipeline } from '../renderer';
import { buildRailgun } from '../weapon-model';
import { AttachedRailgun } from '../character/gun';
import { RailBeams } from '../fx/rail-beam';

// ─────────────────────────────────────────────────────────────────────────
// Shader warm-up for the railgun track. Every finish pattern is a uniform
// branch (gun-material.ts), so the whole set of gun programs is small:
//   • viewmodel: the high-LOD surface (+ its discharge flare), compiled
//     against the viewmodel layer's lights;
//   • third person: the low-LOD surface, the per-gun energy material, the
//     claw flare, and the rail-beam core / spiral / impact-flare materials,
//     compiled against the world's lights.
// Call once at match load (after the map is in the scene, so the lights and
// IBL match); the first bot shot, the first remote with a new finish and the
// first rail impact then draw without a compile hitch.
//
// The warm-up objects are kept alive for the pipeline's life: a WebGL
// program is freed when the last material using it is disposed.
// ─────────────────────────────────────────────────────────────────────────

const kept = new WeakMap<PostFxPipeline, THREE.Object3D[]>();

export async function prewarmGuns(postFx: PostFxPipeline, opts: { lowSpec?: boolean } = {}): Promise<void> {
  if (kept.has(postFx)) return;
  const vm = buildRailgun(undefined, { lod: 'high' });
  vm.setLowSpec(!!opts.lowSpec);
  // Item-quality overlays (killstreak sheen, festive lights, strange counter)
  // are drawn only when on, so switch them on for the warm-up: their programs
  // (sheen, festive, counter) then compile here, not mid-match. Unusuals,
  // taunt auras and killstreak eyes share the unusual point/ribbon programs,
  // which prewarmFx (effects.ts) compiles.
  vm.setKillstreak('sheen.team', 'ks.fire');
  vm.setStreak(10);
  vm.setFestive(true);
  vm.setStrangeKills(1);
  const tp = new THREE.Group();
  const tpGun = new AttachedRailgun();
  tpGun.setKillstreak('sheen.team', 'ks.fire');
  tpGun.setStreak(10);
  tpGun.setFestive(true);
  tp.add(tpGun, new RailBeams(1).group);
  kept.set(postFx, [vm.group, tp]);
  await Promise.all([postFx.prewarm(vm.group, 'viewmodel'), postFx.prewarm(tp, 'world')]);
}
