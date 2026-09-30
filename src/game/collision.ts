// Shared collision math (no renderer or browser dependencies).
import type { AABB, Vec3 } from './types';

export type CollisionResult = {
  position: Vec3;
  blocked: { x: boolean; y: boolean; z: boolean };
  groundContact: boolean;
  wallNormal: Vec3 | null;
};

export function movePlayer(
  pos: Vec3,
  size: Vec3,
  delta: Vec3,
  boxes: AABB[],
): CollisionResult {
  let nx = pos.x;
  let ny = pos.y;
  let nz = pos.z;
  const hx = size.x / 2;
  const hz = size.z / 2;
  const blocked = { x: false, y: false, z: false };
  let groundContact = false;
  let wallNormal: Vec3 | null = null;
  const EPS = 1e-4;

  nx += delta.x;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.x > 0) {
      nx = b.min.x - hx - EPS;
      wallNormal = { x: -1, y: 0, z: 0 };
    } else if (delta.x < 0) {
      nx = b.max.x + hx + EPS;
      wallNormal = { x: 1, y: 0, z: 0 };
    }
    blocked.x = true;
  }

  nz += delta.z;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.z > 0) {
      nz = b.min.z - hz - EPS;
      wallNormal = { x: 0, y: 0, z: -1 };
    } else if (delta.z < 0) {
      nz = b.max.z + hz + EPS;
      wallNormal = { x: 0, y: 0, z: 1 };
    }
    blocked.z = true;
  }

  ny += delta.y;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.y > 0) {
      ny = b.min.y - size.y - EPS;
    } else if (delta.y < 0) {
      ny = b.max.y + EPS;
      groundContact = true;
    }
    blocked.y = true;
  }

  return { position: { x: nx, y: ny, z: nz }, blocked, groundContact, wallNormal };
}

function overlap(
  ax0: number, ay0: number, az0: number,
  ax1: number, ay1: number, az1: number,
  b: AABB,
): boolean {
  return (
    ax0 < b.max.x && ax1 > b.min.x &&
    ay0 < b.max.y && ay1 > b.min.y &&
    az0 < b.max.z && az1 > b.min.z
  );
}

export function rayAabb(o: Vec3, d: Vec3, b: AABB): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const dv = d[axis];
    const oa = o[axis];
    const lo = b.min[axis];
    const hi = b.max[axis];
    if (Math.abs(dv) < 1e-9) {
      if (oa < lo || oa > hi) return null;
    } else {
      let t1 = (lo - oa) / dv;
      let t2 = (hi - oa) / dv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin < 0 ? 0 : tmin;
}

// Like rayAabb but also returns the outward normal of the entry face — the
// direction to repel a boost-jumping player away from the surface. `d` need
// not be normalized; `t` is in units of |d|.
export function rayAabbNormal(
  o: Vec3,
  d: Vec3,
  b: AABB,
): { t: number; normal: Vec3 } | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis: 'x' | 'y' | 'z' = 'x';
  let sign = 0;
  for (const a of ['x', 'y', 'z'] as const) {
    const dv = d[a];
    const oa = o[a];
    const lo = b.min[a];
    const hi = b.max[a];
    if (Math.abs(dv) < 1e-9) {
      if (oa < lo || oa > hi) return null;
    } else {
      const inv = 1 / dv;
      let tNear = (lo - oa) * inv;
      let tFar = (hi - oa) * inv;
      if (tNear > tFar) {
        const tmp = tNear;
        tNear = tFar;
        tFar = tmp;
      }
      if (tNear > tmin) {
        tmin = tNear;
        axis = a;
        // Entry face normal points back toward the ray origin: -axis when
        // travelling +axis (hit the min face), +axis when travelling -axis.
        sign = dv > 0 ? -1 : 1;
      }
      if (tFar < tmax) tmax = tFar;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  const normal: Vec3 = { x: 0, y: 0, z: 0 };
  normal[axis] = sign;
  return { t, normal };
}

export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = 2 * (ox * d.x + oy * d.y + oz * d.z);
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / 2;
  const t2 = (-b + s) / 2;
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}
