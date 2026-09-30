import type { SurfaceKind, SurfaceTextures } from '../textures';
import type { MapBox } from '../maps/kit';
import type { AABB } from '../types';
import type { V3 } from './lightmap';
import type { SkyParams } from './sky';

// ─────────────────────────────────────────────────────────────────────────
// World theme kit (types + light/inlay helpers). Each map's look lives in
// world/looks/<mapId>.ts; world/themes.ts is the registry.
//
// World themes: every map is a PLACE. A theme owns the material set (slots in
// textures.ts), the baked light rig (coloured fixtures + their lights), the
// dynamic light tint for players, the sky, fog, exposure and dressing style.
//
// Lights are authored per map against the AABBs in map.ts: each one hangs off
// a real face (`at` sits ON that face plane, `face` is its outward normal) so
// its fixture is flush to a collision surface (≤ 0.1 m proud) and the light
// it "emits" sits `out` metres in front of it. `free` lamps (flood masts)
// stand OUTSIDE the arena bounds instead. A light with intensity 0 is
// fixture-only (a glowing band / window). Intensities are three.js
// candela-style (decay 2): E = I / d².
//
// perimeterTop (open-sky themes): the tall boundary walls are RENDERED only up
// to this height, like Quake 3 sky brushes — the collision box is unchanged,
// so the sky becomes the backdrop instead of a strip above a tiled wall.
// ─────────────────────────────────────────────────────────────────────────

export type ThemeId = string;

// A texture recipe: builds one surface slot (called once per session, cached).
export type Recipe = () => SurfaceTextures;
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export type LightDef = {
  at: V3; // fixture centre on the face plane
  face: Face;
  size: [number, number]; // fixture extent along the face's (u, v) axes
  color: number; // sRGB hex
  intensity: number; // 0 → fixture only
  range: number;
  out?: number; // light offset along the face normal (default 0.5)
  spot?: { dir: V3; angle: number; penumbra?: number };
  radius?: number; // soft-shadow jitter radius
  kind?: 'lamp' | 'strip' | 'window'; // fixture look (default: lamp if lit, else strip)
  level?: number; // fixture brightness multiplier (1 = the standard lens level)
  fixture?: boolean; // default true
  free?: boolean; // free-standing lamp head outside the arena (mast)
};

export type SlotParams = { metalness: number; normalScale: number; ao: number };

export type DressStyle = {
  slot: SurfaceKind; // texture slot the trim pieces borrow
  tint: number; // vertex tint for trim (sRGB hex; multiplies the slot albedo — keep near white)
  bright?: number; // extra multiplier on the tint (default 1.3: trim a touch lighter than the slot)
  baseboard?: { h: number; d: number };
  pilasters?: { spacing: number; w: number; d: number; top?: number };
  bands?: Array<{ y: number; h: number; d: number }>;
  crown?: { h: number; d: number }; // cap band along the top of perimeter walls
  beams?: { spacing: number; w: number; d: number }; // ceiling ribs (closed maps)
  collars?: { h: number; d: number }; // pillar base + capital
  edges?: { h: number; d: number; hazard?: boolean }; // band on platform / cover top edges
};

// Floor paint: min/max in world space (min[1] = the surface it sits on).
export type Inlay = { min: V3; max: V3; color: number; glow?: number; hazard?: boolean };

// Render-only silhouette outside the arena (skyline, masts, cranes).
export type SkyProp = { min: V3; max: V3; color?: number; beacon?: number };

export type WorldTheme = {
  id: ThemeId;
  // Procedural surface set, one recipe per slot (textures.ts builders).
  textures: Record<SurfaceKind, Recipe>;
  openSky: boolean; // don't draw the ceiling (render-only; it still collides)
  perimeterTop?: number; // render boundary walls only up to this height (sky brush)
  slots: Record<SurfaceKind, SlotParams>;
  // Per-box material slot / vertex tint. Prefer keying off `box.tag` (set in
  // the map module) over the index, so edits to the box list don't shift looks.
  slotFor?: (index: number, box: MapBox, fallback: SurfaceKind) => SurfaceKind;
  tintFor?: (index: number, box: MapBox, slot: SurfaceKind) => number | null;
  trim: { color: number | null; intensity: number } | null; // accent edge light (null colour = map accent)
  dress: DressStyle;
  inlays?: Inlay[];
  skyline?: SkyProp[];
  lights: LightDef[];
  bake: {
    ambientUp: number; ambientDown: number; ambient: number; // hex + irradiance
    sky: { color: number; intensity: number } | null; // open-sky irradiance
    ao: { radius: number; strength: number };
    sunShadow: boolean; // bake map-on-map sun shadows
    sunIgnorePerimeter: boolean; // tall boundary walls don't shadow the sun
    sunIgnoreCeiling: boolean; // interiors: the "sun" is a skylight key
    texel: number;
    maxTexels?: number; // atlas budget (default 120k); the texel grows until the bake fits
  };
  sun: { dir: V3; color: number; intensity: number; mapScale: number };
  hemi: { sky: number; ground: number; intensity: number; mapScale: number };
  fill: { dir: V3; color: number; intensity: number; mapScale: number };
  env: { intensity: number; mapScale: number };
  worldSaturation: number; // map-material-only desaturation (players keep theirs)
  // Chroma cap on map surfaces (linear (max-min)/max; default 0.6 ≈ 35 % HSV on
  // screen). Keeps players the most saturated thing in view — map.ts clamps it
  // to ≤ 0.8. Raise it only for colour-blocked looks (Ratz-style furniture).
  satCap?: number;
  shadowBox?: number; // realtime sun shadow box edge (default 56 m)
  shadowLift?: number; // share of baked light a player's realtime shadow removes (default 0.3 open / 0.55 closed)
  exposure: number;
  fog: { color: number; near: number; far: number };
  background: number;
  sky: SkyParams;
};

export const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export const FACE_NORMAL: Record<Face, V3> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
};

type LampOpts = {
  size?: [number, number]; down?: number; angle?: number; out?: number; radius?: number; level?: number;
};

// Wall-mounted lamp aimed out and down (the classic Quake scallop below it).
export function wallLamp(at: V3, face: Face, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
  const n = FACE_NORMAL[face];
  const down = o.down ?? 1;
  return {
    at, face, color, intensity, range,
    size: o.size ?? [0.9, 0.5],
    out: o.out ?? 0.5,
    radius: o.radius ?? 0.35,
    level: o.level,
    spot: { dir: norm([n[0], n[1] - down, n[2]]), angle: o.angle ?? 1.0, penumbra: 0.55 },
  };
}

// Free-standing flood head on a mast OUTSIDE the arena, aimed in and down.
export function mastLamp(at: V3, face: Face, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
  return { ...wallLamp(at, face, color, intensity, range, o), free: true, out: o.out ?? 0.7 };
}

// Small wall lamp standing ~1 m off the wall with a wide cone: throws the
// round Quake scallop onto the wall around and below it.
export function sconce(at: V3, face: Face, color: number, intensity: number, range: number, level = 1): LightDef {
  const n = FACE_NORMAL[face];
  return {
    at, face, color, intensity, range,
    size: [0.5, 0.5],
    out: 0.9,
    radius: 0.25,
    level,
    spot: { dir: norm([n[0] * 0.25, -1, n[2] * 0.25]), angle: 1.35, penumbra: 0.5 },
  };
}

// Fixture on an underside, shining straight down.
export function downLight(at: V3, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
  return {
    at, face: '-y', color, intensity, range,
    size: o.size ?? [1.2, 1.2],
    out: o.out ?? 0.35,
    radius: o.radius ?? 0.3,
    level: o.level,
    spot: { dir: [0, -1, 0], angle: o.angle ?? 1.1, penumbra: 0.6 },
  };
}

// Emissive band only (no light) on the four sides of a box at height y.
export function band4(b: AABB, y: number, h: number, color: number, level = 1): LightDef[] {
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const sx = b.max.x - b.min.x;
  const sz = b.max.z - b.min.z;
  const f = (at: V3, face: Face, w: number): LightDef => ({
    at, face, size: [w, h], color, intensity: 0, range: 1, kind: 'strip', level,
  });
  return [
    f([b.max.x, y, cz], '+x', sz),
    f([b.min.x, y, cz], '-x', sz),
    f([cx, y, b.max.z], '+z', sx),
    f([cx, y, b.min.z], '-z', sx),
  ];
}

// A mast (pole) for a free lamp, just behind it.
export function mast(at: V3, face: Face): SkyProp {
  const n = FACE_NORMAL[face];
  const x = at[0] - n[0] * 0.75;
  const z = at[2] - n[2] * 0.75;
  return { min: [x - 0.16, 0, z - 0.16], max: [x + 0.16, at[1] + 0.3, z + 0.16], color: 0x0e0f12 };
}

export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

export const prop = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: number, beacon?: number): SkyProp => ({
  min: [x0, y0, z0], max: [x1, y1, z1], color, beacon,
});

// Visual slot defaults shared by all themes: elevated thin slabs read as
// platforms (they were bucketed with ground cover by height alone).
export function defaultSlot(index: number, b: AABB, kind: SurfaceKind): SurfaceKind {
  if (index === 0 || index === 1) return kind;
  const sy = b.max.y - b.min.y;
  if (sy < 1.3 && b.min.y >= 0.9) return 'platform';
  return kind;
}

export const METAL: Record<SurfaceKind, SlotParams> = {
  floor: { metalness: 0.2, normalScale: 0.7, ao: 0.7 },
  ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
  wall: { metalness: 0.25, normalScale: 0.85, ao: 0.7 },
  cover: { metalness: 0.3, normalScale: 1.0, ao: 0.7 },
  platform: { metalness: 0.35, normalScale: 0.8, ao: 0.75 },
  tower: { metalness: 0.35, normalScale: 0.85, ao: 0.7 },
};

// Continuous hazard band (a ring of four strips) around a footprint.
export function hazardRing(b: AABB, gap: number, w: number, y = 0): Inlay[] {
  const x0 = b.min.x - gap - w;
  const x1 = b.max.x + gap + w;
  const z0 = b.min.z - gap - w;
  const z1 = b.max.z + gap + w;
  const c = 0xc9a227;
  return [
    { min: [x0, y, z0], max: [x1, y, z0 + w], color: c, hazard: true },
    { min: [x0, y, z1 - w], max: [x1, y, z1], color: c, hazard: true },
    { min: [x0, y, z0 + w], max: [x0 + w, y, z1 - w], color: c, hazard: true },
    { min: [x1 - w, y, z0 + w], max: [x1, y, z1 - w], color: c, hazard: true },
  ];
}

export function outline(b: AABB, w: number, color: number): Inlay[] {
  return [
    { min: [b.min.x, 0, b.min.z], max: [b.max.x, 0, b.min.z + w], color },
    { min: [b.min.x, 0, b.max.z - w], max: [b.max.x, 0, b.max.z], color },
    { min: [b.min.x, 0, b.min.z + w], max: [b.min.x + w, 0, b.max.z - w], color },
    { min: [b.max.x - w, 0, b.min.z + w], max: [b.max.x, 0, b.max.z - w], color },
  ];
}

export function dashes(x: number, z0: number, z1: number, len: number, gap: number, w: number, color: number): Inlay[] {
  const out: Inlay[] = [];
  for (let z = z0 + gap / 2; z + len <= z1; z += len + gap) {
    out.push({ min: [x - w / 2, 0, z], max: [x + w / 2, 0, z + len], color });
  }
  return out;
}

