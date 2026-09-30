// Map authoring kit — pure data helpers (no three.js, no DOM), safe to import
// on the game server. Every arena is a list of axis-aligned boxes; these
// helpers keep the hand-authored layouts short, symmetric and consistent.
//
// Box-list contract (map.ts, the lightmap bake and the bots rely on it):
//   boxes[0]  the floor slab, top at y = 0, covering the whole bounds.
//   boxes[1]  the ceiling / invisible cap, bottom at bounds.max.y - 1.
//   boxes[2…] everything else (perimeter walls first by convention).
// `shell()` emits the first six in that order.

import type { AABB, Vec3 } from '../types';

// A collision box with an optional tag the map's look can key materials,
// tints and lights off (instead of fragile box indices).
export type MapBox = AABB & { tag?: string };

// Box from two corners (any order).
export function B(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tag?: string): MapBox {
  const b: MapBox = {
    min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
    max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  };
  if (tag) b.tag = tag;
  return b;
}

// Box from a centre (x, z), a footprint (w along x, d along z) and a y range.
export function C(x: number, z: number, w: number, d: number, y0: number, y1: number, tag?: string): MapBox {
  return B(x - w / 2, y0, z - d / 2, x + w / 2, y1, z + d / 2, tag);
}

// A thin walkable slab whose TOP is at `top` (default 0.5 m thick).
export function slab(x0: number, z0: number, x1: number, z1: number, top: number, tag?: string, thick = 0.5): MapBox {
  return B(x0, top - thick, z0, x1, top, z1, tag);
}

export const retag = (b: MapBox, tag: string | undefined): MapBox => ({ min: { ...b.min }, max: { ...b.max }, ...(tag ? { tag } : {}) });

// ── symmetry ────────────────────────────────────────────────────────────────
// Point symmetry (rotate 180° about the y axis) is the duel default: both
// players get the same map, each spawn has a twin on the far side.
export const mirrorX = (b: MapBox): MapBox => B(-b.max.x, b.min.y, b.min.z, -b.min.x, b.max.y, b.max.z, b.tag);
export const mirrorZ = (b: MapBox): MapBox => B(b.min.x, b.min.y, -b.max.z, b.max.x, b.max.y, -b.min.z, b.tag);
export const rot180 = (b: MapBox): MapBox => B(-b.max.x, b.min.y, -b.max.z, -b.min.x, b.max.y, -b.min.z, b.tag);

export type Symmetry = 'x' | 'z' | 'rot' | 'quad';

// The boxes plus their symmetric twins. 'x' mirrors across x = 0, 'z' across
// z = 0, 'rot' rotates 180°, 'quad' mirrors across both axes (4 copies).
export function sym(boxes: MapBox[], mode: Symmetry): MapBox[] {
  switch (mode) {
    case 'x':
      return [...boxes, ...boxes.map(mirrorX)];
    case 'z':
      return [...boxes, ...boxes.map(mirrorZ)];
    case 'rot':
      return [...boxes, ...boxes.map(rot180)];
    case 'quad':
      return [...boxes, ...boxes.map(mirrorX), ...boxes.map(mirrorZ), ...boxes.map(rot180)];
  }
}

export function symPoints(points: Vec3[], mode: Symmetry): Vec3[] {
  const mx = (p: Vec3): Vec3 => ({ x: -p.x, y: p.y, z: p.z });
  const mz = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: -p.z });
  const r = (p: Vec3): Vec3 => ({ x: -p.x, y: p.y, z: -p.z });
  switch (mode) {
    case 'x':
      return [...points, ...points.map(mx)];
    case 'z':
      return [...points, ...points.map(mz)];
    case 'rot':
      return [...points, ...points.map(r)];
    case 'quad':
      return [...points, ...points.map(mx), ...points.map(mz), ...points.map(r)];
  }
}

// ── shell ───────────────────────────────────────────────────────────────────
// Floor + cap + four perimeter walls for a rectangular arena centred on the
// origin. `height` is the cap's underside (the play volume's ceiling).
export function shell(halfX: number, halfZ: number, height: number, wall = 1): { boxes: MapBox[]; bounds: AABB } {
  const x0 = -halfX;
  const x1 = halfX;
  const z0 = -halfZ;
  const z1 = halfZ;
  return {
    bounds: { min: { x: x0, y: -1, z: z0 }, max: { x: x1, y: height + 1, z: z1 } },
    boxes: [
      B(x0, -1, z0, x1, 0, z1, 'floor'),
      B(x0, height, z0, x1, height + 1, z1, 'cap'),
      B(x0, 0, z0, x0 + wall, height, z1, 'perimeter'),
      B(x1 - wall, 0, z0, x1, height, z1, 'perimeter'),
      B(x0, 0, z0, x1, height, z0 + wall, 'perimeter'),
      B(x0, 0, z1 - wall, x1, height, z1, 'perimeter'),
    ],
  };
}

// ── climbing ────────────────────────────────────────────────────────────────
// The player has no step-up: every rise is a jump. A single jump clears
// ~1.6 m, a double jump ~3.2 m, a boost (right mouse at a surface ≤ 4 m away)
// ~8 m. `steps` builds a jump-staircase of solid blocks rising from `fromY`
// to `toY` along `dir`, each riser ≤ `maxRise` (default 1.2 m — an easy hop).
// The footprint [a0, a1] runs along the travel axis; [b0, b1] is its width.
export function steps(
  dir: '+x' | '-x' | '+z' | '-z',
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  fromY: number,
  toY: number,
  opts: { maxRise?: number; tag?: string } = {},
): MapBox[] {
  const rise = toY - fromY;
  const n = Math.max(1, Math.ceil(rise / (opts.maxRise ?? 1.2)));
  const run = (a1 - a0) / n;
  const out: MapBox[] = [];
  for (let i = 0; i < n; i++) {
    const top = fromY + (rise * (i + 1)) / n;
    // Each block is solid down to fromY, so the stair has no gaps underneath.
    const forward = dir[0] === '+';
    const s0 = forward ? a0 + run * i : a1 - run * (i + 1);
    const s1 = forward ? a0 + run * (i + 1) : a1 - run * i;
    if (dir[1] === 'x') out.push(B(s0, fromY, b0, s1, top, b1, opts.tag));
    else out.push(B(b0, fromY, s0, b1, top, s1, opts.tag));
  }
  return out;
}

export const pt = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
// A spawn standing on the surface whose top is at `top` (default the floor).
export const spawnAt = (x: number, z: number, top = 0): Vec3 => ({ x, y: top + 0.05, z });
