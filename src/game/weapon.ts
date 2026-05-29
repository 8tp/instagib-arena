import * as THREE from 'three';
import {
  RAIL_BEAM_DURATION,
  RAIL_COOLDOWN,
  RAIL_CORE_COLOR,
  RAIL_CORE_RADIUS,
  RAIL_GLOW_RADIUS,
  RAIL_HELIX_COLOR,
  RAIL_HELIX_RADIUS,
  RAIL_HELIX_TURN_LEN,
  RAIL_RANGE,
} from './constants';
import { rayAabb } from './map';
import type { AABB, Vec3 } from './types';

// A fading rail trail: a Group of meshes/lines plus the materials to fade and
// their starting opacities (each part dims proportionally as the trail dies).
type Beam = {
  group: THREE.Group;
  parts: Array<{ mat: THREE.Material & { opacity: number }; base: number }>;
  remaining: number;
};

const UP = new THREE.Vector3(0, 1, 0);

// Quake-III CG_RailTrail look: a bright solid core cylinder, a soft additive
// glow sleeve, and a helix spiralling around the axis. All additive so trails
// read as light against the dark arena and stack nicely where they cross.
function buildRailBeam(origin: THREE.Vector3, end: THREE.Vector3): Beam {
  const group = new THREE.Group();
  const parts: Beam['parts'] = [];

  const dir = new THREE.Vector3().subVectors(end, origin);
  const len = dir.length();
  if (len < 1e-4) {
    return { group, parts, remaining: RAIL_BEAM_DURATION };
  }
  const axis = dir.clone().multiplyScalar(1 / len);
  const mid = origin.clone().addScaledVector(dir, 0.5);
  const quat = new THREE.Quaternion().setFromUnitVectors(UP, axis);

  const addCylinder = (radius: number, color: number, opacity: number) => {
    const geom = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(mid);
    mesh.quaternion.copy(quat);
    group.add(mesh);
    parts.push({ mat, base: opacity });
  };

  addCylinder(RAIL_GLOW_RADIUS, RAIL_HELIX_COLOR, 0.28); // outer glow
  addCylinder(RAIL_CORE_RADIUS, RAIL_CORE_COLOR, 1); // solid core

  // Helix: perpendicular basis (u, v) about the axis, points stepped along it.
  const u = new THREE.Vector3();
  if (Math.abs(axis.y) < 0.99) u.crossVectors(axis, UP).normalize();
  else u.set(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const segs = Math.min(600, Math.max(8, Math.ceil((len / RAIL_HELIX_TURN_LEN) * 12)));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const theta = (len * f) / RAIL_HELIX_TURN_LEN * Math.PI * 2;
    const ox = (Math.cos(theta) * u.x + Math.sin(theta) * v.x) * RAIL_HELIX_RADIUS;
    const oy = (Math.cos(theta) * u.y + Math.sin(theta) * v.y) * RAIL_HELIX_RADIUS;
    const oz = (Math.cos(theta) * u.z + Math.sin(theta) * v.z) * RAIL_HELIX_RADIUS;
    pts.push(new THREE.Vector3(
      origin.x + dir.x * f + ox,
      origin.y + dir.y * f + oy,
      origin.z + dir.z * f + oz,
    ));
  }
  const helixGeom = new THREE.BufferGeometry().setFromPoints(pts);
  const helixMat = new THREE.LineBasicMaterial({
    color: RAIL_HELIX_COLOR,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  group.add(new THREE.Line(helixGeom, helixMat));
  parts.push({ mat: helixMat, base: 0.85 });

  return { group, parts, remaining: RAIL_BEAM_DURATION };
}

// Generic shootable target. Bot and RemotePlayer both build one of these at
// fire time so the weapon code stays oblivious to the entity type.
export type RailTarget = {
  kind: 'bot' | 'remote';
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
  private beams: Beam[] = [];

  step(dt: number, scene: THREE.Scene) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.remaining -= dt;
      const alpha = Math.max(0, b.remaining / RAIL_BEAM_DURATION);
      for (const p of b.parts) p.mat.opacity = p.base * alpha;
      if (b.remaining <= 0) {
        disposeBeam(scene, b);
        this.beams.splice(i, 1);
      }
    }
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
  ): RailFireResult | null {
    if (this.cooldown > 0) return null;
    this.cooldown = RAIL_COOLDOWN;

    const o: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
    const d: Vec3 = { x: dir.x, y: dir.y, z: dir.z };

    // 1) Find the nearest wall — that's where the visible beam ends.
    let wallT = RAIL_RANGE;
    for (const b of boxes) {
      const t = rayAabb(o, d, b);
      if (t !== null && t > 0 && t < wallT) wallT = t;
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
    this.spawnBeam(origin.clone(), end, scene);

    return { hits, end };
  }

  // Draw a standalone rail trail (no cooldown / hit logic). Used for bot shots
  // so enemy fire is visible without going through the player's weapon state.
  spawnBeam(origin: THREE.Vector3, end: THREE.Vector3, scene: THREE.Scene) {
    const beam = buildRailBeam(origin.clone(), end.clone());
    scene.add(beam.group);
    this.beams.push(beam);
  }

  disposeAll(scene: THREE.Scene) {
    for (const b of this.beams) disposeBeam(scene, b);
    this.beams.length = 0;
  }
}

function disposeBeam(scene: THREE.Scene, b: Beam) {
  scene.remove(b.group);
  b.group.traverse((obj) => {
    const m = obj as THREE.Mesh & THREE.Line;
    const geom = (m as unknown as { geometry?: THREE.BufferGeometry }).geometry;
    if (geom) geom.dispose();
    const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}
