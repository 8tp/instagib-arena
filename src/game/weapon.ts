import * as THREE from 'three';
import { RAIL_COOLDOWN, RAIL_CORE_COLOR, RAIL_HELIX_COLOR, RAIL_RANGE } from './constants';
import { spawnRailImpact } from './effects';
import { getFxContext, peekFxContext } from './fx-pool';
import { liveViewmodelMuzzle, localRail } from './fx/rail-state';
import { mapVisualTop, rayAabb, rayAabbNormal, type ArenaMap } from './map';
import type { AABB, Vec3 } from './types';

// Rail trails are pooled per scene (fx/rail-beam.ts, owned by the scene's
// FxContext): a white-hot core ribbon + glow sleeve and a spiral of motes that
// spreads and dissipates. Drawing a trail allocates nothing on the FX side.

const tmpNormal = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpMuzzle = new THREE.Vector3();
// The impact face's box clipped to its DRAWN top (sky-brush perimeter walls
// render lower than their collision), so a scorch never overhangs into the sky.
const tmpFaceBox: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
function drawnFaceBox(map: ArenaMap | undefined, idx: number, box: AABB): AABB {
  const top = map ? mapVisualTop(map, idx) : Infinity;
  if (!(top < box.max.y)) return box;
  tmpFaceBox.min.x = box.min.x; tmpFaceBox.min.y = box.min.y; tmpFaceBox.min.z = box.min.z;
  tmpFaceBox.max.x = box.max.x; tmpFaceBox.max.y = Math.max(box.min.y, top); tmpFaceBox.max.z = box.max.z;
  return tmpFaceBox;
}

// Which drawn map face (if any) does the visible beam origin→end stop on?
// Analytic: the map is a list of AABBs, so the entry face of the nearest box
// along the beam gives an exact normal — no scene raycast, no mesh tagging.
// Returns the face's box index (its normal left in tmpNormal), or -1 when the
// beam stopped short of the wall (it hit a player), ran out at max range, or
// ended on the undrawn ceiling of an open-top arena.
function resolveImpactFace(origin: THREE.Vector3, end: THREE.Vector3, map: ArenaMap): number {
  const o: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
  const d: Vec3 = { x: end.x - origin.x, y: end.y - origin.y, z: end.z - origin.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-4) return -1;
  let best = Infinity;
  let idx = -1;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < map.boxes.length; i++) {
    const hit = rayAabbNormal(o, d, map.boxes[i]);
    if (hit !== null && hit.t > 0 && hit.t < best) {
      best = hit.t;
      idx = i;
      nx = hit.normal.x; ny = hit.normal.y; nz = hit.normal.z;
    }
  }
  if (idx < 0) return -1;
  // `t` is in units of |d|, so t ≈ 1 means the beam ends exactly on the face.
  if (Math.abs(best - 1) * len > 0.08) return -1;
  // Not on a DRAWN surface: the undrawn ceiling of an open-sky arena, or the
  // invisible upper part of a sky-brush perimeter wall (see mapVisualTop).
  if (end.y > mapVisualTop(map, idx) + 0.02) return -1;
  tmpNormal.set(nx, ny, nz);
  return idx;
}

// Generic shootable target. Bot and RemotePlayer both build one of these at
// fire time so the weapon code stays oblivious to the entity type.
export type RailTarget = {
  kind: 'bot' | 'remote' | 'target';
  id: string;
  name: string;
  bounds: AABB;
  headshotY: number;
  centerY: number;
};

export type RailHit = {
  target: RailTarget;
  t: number;
  hitY: number;
  headshot: boolean;
  point: THREE.Vector3;
};

export type RailFireResult = {
  hits: RailHit[];
  end: THREE.Vector3;
};

export class Railgun {
  cooldown = 0;
  // The local player's equipped rail-beam colors (railColor cosmetic). Enemy
  // beams keep the defaults — spawnBeam's params fall back to the constants.
  private beamCore = RAIL_CORE_COLOR;
  private beamHelix = RAIL_HELIX_COLOR;

  setBeamColors(core: number, helix: number) {
    this.beamCore = core;
    this.beamHelix = helix;
  }

  // 0 = just fired … 1 = ready (the viewmodel's energy coils show it).
  get charge(): number {
    return 1 - Math.min(1, Math.max(0, this.cooldown / RAIL_COOLDOWN));
  }

  step(dt: number, scene: THREE.Scene) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    // Publish the recharge for the first-person coils. The gun that fired last
    // owns the shared state (an idle second instance can't overwrite it); an
    // unowned state (fresh page, or the previous match's gun was disposed) is
    // claimed by the first gun that steps.
    if (localRail.owner === null) localRail.owner = this;
    if (localRail.owner === this) localRail.charge = this.charge;
    // Trails + impact sparks live in the shared FX context, normally stepped by
    // the scene's EffectsManager; step it here only when nobody else does.
    const fx = peekFxContext(scene);
    if (fx && !fx.managed) fx.step(dt);
  }

  // Returns null when the shot was blocked by cooldown (no side effects, no
  // SFX should fire). When it returns a result, it's a "real" shot — the
  // hits array contains every target between the muzzle and the nearest
  // wall, sorted by distance so collateral is in order.
  fire(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    scene: THREE.Scene,
    boxes: AABB[],
    targets: RailTarget[],
    // Where the VISIBLE beam starts (the gun muzzle). Hit detection still uses
    // `origin` (the eye), so aim stays exact while the trail comes from the gun.
    // While a first-person viewmodel is on screen its real barrel tip wins, so
    // the trail leaves the gun the player sees (see fx/rail-state.ts).
    beamOrigin?: THREE.Vector3,
    // The arena (surface hint): lets the beam skip its impact effect on the
    // invisible collision ceiling of open-top maps. Pass `boxes`' owner.
    surface?: ArenaMap,
  ): RailFireResult | null {
    if (this.cooldown > 0) return null;
    this.cooldown = RAIL_COOLDOWN;
    localRail.owner = this;
    localRail.charge = 0;
    localRail.shots++;

    const o: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
    const d: Vec3 = { x: dir.x, y: dir.y, z: dir.z };

    // 1) Find the nearest wall — that's where the visible beam ends. Its face
    //    normal (exact, from the AABB) orients the impact sparks + decal.
    let wallT = RAIL_RANGE;
    let wallIdx = -1;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < boxes.length; i++) {
      const hit = rayAabbNormal(o, d, boxes[i]);
      if (hit !== null && hit.t > 0 && hit.t < wallT) {
        wallT = hit.t;
        wallIdx = i;
        nx = hit.normal.x; ny = hit.normal.y; nz = hit.normal.z;
      }
    }

    // 2) Every target whose entry point is closer than the nearest wall is
    //    hit (collateral). Sort by distance so kill order matches travel.
    const hits: RailHit[] = [];
    for (const target of targets) {
      const t = rayAabb(o, d, target.bounds);
      if (t === null || t <= 0 || t >= wallT) continue;
      const hitY = origin.y + dir.y * t;
      const point = origin.clone().addScaledVector(dir, t);
      hits.push({
        target,
        t,
        hitY,
        headshot: hitY >= target.headshotY,
        point,
      });
    }
    hits.sort((a, b) => a.t - b.t);

    const end = origin.clone().addScaledVector(dir, wallT);
    // The player's OWN beam uses their equipped rail colors. The impact only
    // plays on a real, drawn wall — not at max range, and not on the
    // invisible ceiling that caps open-top arenas.
    const drawnWall =
      wallIdx >= 0 &&
      (surface ? end.y <= mapVisualTop(surface, wallIdx) + 0.02 : true); // not sky / sky-brush wall
    const start = liveViewmodelMuzzle(tmpMuzzle) ? tmpMuzzle : (beamOrigin ?? origin);
    this.spawnBeamAt(
      start,
      end,
      scene,
      this.beamCore,
      this.beamHelix,
      drawnWall ? tmpNormal.set(nx, ny, nz) : null,
      dir,
      drawnWall ? drawnFaceBox(surface, wallIdx, boxes[wallIdx]) : undefined,
      true,
    );

    return { hits, end };
  }

  // Draw a standalone rail trail (no cooldown / hit logic). Used for bot shots
  // so enemy fire is visible without going through the player's weapon state.
  // Colors default to the stock rail (enemy beams), or the player's equipped
  // colors when fire() passes them.
  // `surface` (the arena) is an optional hint: with it, a beam that ends on a
  // drawn map face also plays the rail impact (sparks + flash + scorch) there.
  spawnBeam(
    origin: THREE.Vector3,
    end: THREE.Vector3,
    scene: THREE.Scene,
    core: number = RAIL_CORE_COLOR,
    helix: number = RAIL_HELIX_COLOR,
    surface?: ArenaMap,
  ) {
    const face = surface ? resolveImpactFace(origin, end, surface) : -1;
    const box = surface && face >= 0 ? drawnFaceBox(surface, face, surface.boxes[face]) : undefined;
    this.spawnBeamAt(origin, end, scene, core, helix, box ? tmpNormal : null, null, box, false);
  }

  private spawnBeamAt(
    origin: THREE.Vector3,
    end: THREE.Vector3,
    scene: THREE.Scene,
    core: number,
    helix: number,
    impactNormal: THREE.Vector3 | null,
    dir: THREE.Vector3 | null,
    faceBox: AABB | undefined,
    own: boolean,
  ) {
    getFxContext(scene).beams.spawn(origin, end, core, helix, own);
    if (impactNormal) {
      const d = dir ?? tmpDir.subVectors(end, origin).normalize();
      spawnRailImpact(scene, end, impactNormal, d, core, helix, faceBox);
    }
  }

  // Clears every live trail in the scene (map switch / teardown) and releases
  // the shared coil state so the next gun starts from a full charge.
  disposeAll(scene: THREE.Scene) {
    peekFxContext(scene)?.clearBeams();
    if (localRail.owner === this) {
      localRail.owner = null;
      localRail.charge = 1;
    }
  }
}
