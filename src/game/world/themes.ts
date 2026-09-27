import type { SurfaceKind, TextureThemeId } from '../textures';
import type { AABB } from '../types';
import type { V3 } from './lightmap';
import type { SkyParams } from './sky';

// ─────────────────────────────────────────────────────────────────────────
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

export type ThemeId = TextureThemeId;
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
  openSky: boolean; // don't draw the ceiling (render-only; it still collides)
  perimeterTop?: number; // render boundary walls only up to this height (sky brush)
  slots: Record<SurfaceKind, SlotParams>;
  slotFor?: (index: number, box: AABB, fallback: SurfaceKind) => SurfaceKind;
  tintFor?: (index: number, box: AABB, slot: SurfaceKind) => number | null;
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
  };
  sun: { dir: V3; color: number; intensity: number; mapScale: number };
  hemi: { sky: number; ground: number; intensity: number; mapScale: number };
  fill: { dir: V3; color: number; intensity: number; mapScale: number };
  env: { intensity: number; mapScale: number };
  worldSaturation: number; // map-material-only desaturation (players keep theirs)
  shadowBox?: number; // realtime sun shadow box edge (default 56 m)
  shadowLift?: number; // share of baked light a player's realtime shadow removes (default 0.3 open / 0.55 closed)
  exposure: number;
  fog: { color: number; near: number; far: number };
  background: number;
  sky: SkyParams;
};

const norm = (v: V3): V3 => {
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
function wallLamp(at: V3, face: Face, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
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
function mastLamp(at: V3, face: Face, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
  return { ...wallLamp(at, face, color, intensity, range, o), free: true, out: o.out ?? 0.7 };
}

// Small wall lamp standing ~1 m off the wall with a wide cone: throws the
// round Quake scallop onto the wall around and below it.
function sconce(at: V3, face: Face, color: number, intensity: number, range: number, level = 1): LightDef {
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
function downLight(at: V3, color: number, intensity: number, range: number, o: LampOpts = {}): LightDef {
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
function band4(b: AABB, y: number, h: number, color: number, level = 1): LightDef[] {
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
function mast(at: V3, face: Face): SkyProp {
  const n = FACE_NORMAL[face];
  const x = at[0] - n[0] * 0.75;
  const z = at[2] - n[2] * 0.75;
  return { min: [x - 0.16, 0, z - 0.16], max: [x + 0.16, at[1] + 0.3, z + 0.16], color: 0x0e0f12 };
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

const prop = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: number, beacon?: number): SkyProp => ({
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

const METAL: Record<SurfaceKind, SlotParams> = {
  floor: { metalness: 0.2, normalScale: 0.7, ao: 0.7 },
  ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
  wall: { metalness: 0.25, normalScale: 0.85, ao: 0.7 },
  cover: { metalness: 0.3, normalScale: 1.0, ao: 0.7 },
  platform: { metalness: 0.35, normalScale: 0.8, ao: 0.75 },
  tower: { metalness: 0.35, normalScale: 0.85, ao: 0.7 },
};

// Continuous hazard band (a ring of four strips) around a footprint.
function hazardRing(b: AABB, gap: number, w: number, y = 0): Inlay[] {
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

function outline(b: AABB, w: number, color: number): Inlay[] {
  return [
    { min: [b.min.x, 0, b.min.z], max: [b.max.x, 0, b.min.z + w], color },
    { min: [b.min.x, 0, b.max.z - w], max: [b.max.x, 0, b.max.z], color },
    { min: [b.min.x, 0, b.min.z + w], max: [b.min.x + w, 0, b.max.z - w], color },
    { min: [b.max.x - w, 0, b.min.z + w], max: [b.max.x, 0, b.max.z - w], color },
  ];
}

function dashes(x: number, z0: number, z1: number, len: number, gap: number, w: number, color: number): Inlay[] {
  const out: Inlay[] = [];
  for (let z = z0 + gap / 2; z + len <= z1; z += len + gap) {
    out.push({ min: [x - w / 2, 0, z], max: [x + w / 2, 0, z + len], color });
  }
  return out;
}

// ── Causeway → Void (Longest Yard homage) ──────────────────────────────────
const VOID_PILLARS = [
  box(-3, 0, -16, -1, 12, -14),
  box(1, 0, 14, 3, 12, 16),
  box(-15, 0, -1, -13, 12, 1),
  box(13, 0, -1, 15, 12, 1),
];
const VIOLET = 0xa58bff;
const CYAN = 0x6fd8ff;
const VOID: WorldTheme = {
  id: 'void',
  openSky: true,
  perimeterTop: 4.6,
  slots: METAL,
  trim: { color: 0x8f7dff, intensity: 2.0 },
  dress: {
    slot: 'platform', tint: 0xf0f0f0,
    baseboard: { h: 0.4, d: 0.08 },
    pilasters: { spacing: 10, w: 0.8, d: 0.12 },
    crown: { h: 0.45, d: 0.14 },
    collars: { h: 0.6, d: 0.1 },
    edges: { h: 0.12, d: 0.03 },
  },
  lights: [
    // lamp-post pillars: a light pod above each + a glowing band under the top
    ...VOID_PILLARS.flatMap((b, i) => {
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const color = i % 2 ? CYAN : VIOLET;
      return [
        { at: [cx, 12, cz] as V3, face: '+y' as Face, size: [1.4, 1.4] as [number, number], color, intensity: 200, range: 28, out: 0.9, radius: 0.5 },
        ...band4(b, 11.45, 0.5, color),
        ...band4(b, 0.9, 0.18, color, 0.6),
      ];
    }),
    // corner platforms: downlights into the pit
    downLight([-23, 4, -13.5], VIOLET, 50, 13, { size: [2.4, 0.8] }),
    downLight([23, 4, -13.5], 0x7fa8ff, 50, 13, { size: [2.4, 0.8] }),
    downLight([-23, 4, 13.5], 0x7fa8ff, 50, 13, { size: [2.4, 0.8] }),
    downLight([23, 4, 13.5], VIOLET, 50, 13, { size: [2.4, 0.8] }),
    // central hub underside
    downLight([-3.5, 8, 0], CYAN, 80, 16, { size: [2.0, 0.9], angle: 1.0 }),
    downLight([3.5, 8, 0], CYAN, 80, 16, { size: [2.0, 0.9], angle: 1.0 }),
    // perimeter light strips (deep blue scallops) on the low rim walls
    ...[-20, 0, 20].flatMap((x): LightDef[] => [
      { at: [x, 2.4, -23], face: '+z', size: [0.3, 3.0], color: 0x5c78ff, intensity: 26, range: 11, out: 0.7, radius: 0.4, kind: 'strip', level: 0.8 },
      { at: [x, 2.4, 23], face: '-z', size: [0.3, 3.0], color: 0x5c78ff, intensity: 26, range: 11, out: 0.7, radius: 0.4, kind: 'strip', level: 0.8 },
    ]),
    ...[-8, 8].flatMap((z): LightDef[] => [
      { at: [-33, 2.4, z], face: '+x', size: [0.3, 3.0], color: 0x5c78ff, intensity: 26, range: 11, out: 0.7, radius: 0.4, kind: 'strip', level: 0.8 },
      { at: [33, 2.4, z], face: '-x', size: [0.3, 3.0], color: 0x5c78ff, intensity: 26, range: 11, out: 0.7, radius: 0.4, kind: 'strip', level: 0.8 },
    ]),
  ],
  bake: {
    ambientUp: 0x484c66, ambientDown: 0x24252e, ambient: 0.13,
    sky: { color: 0x6a66a8, intensity: 0.3 },
    ao: { radius: 2.6, strength: 0.85 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: false,
    texel: 0.4,
  },
  sun: { dir: norm([-0.35, 0.85, 0.4]), color: 0xc4ccff, intensity: 1.5, mapScale: 0.45 },
  hemi: { sky: 0x9a98c8, ground: 0x2a2833, intensity: 0.55, mapScale: 0.12 },
  fill: { dir: norm([0.6, 0.35, -0.7]), color: 0x8fd8ff, intensity: 0.45, mapScale: 0.25 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.8,
  exposure: 1.0,
  fog: { color: 0x0c0a16, near: 60, far: 260 },
  background: 0x05040c,
  sky: {
    mode: 'space', top: 0x03020a, horizon: 0x100a22, nebula: [0x5a2a9c, 0x1f4c9a, 0xb03c86], stars: 1,
  },
};

// ── Reactor → industrial tech ──────────────────────────────────────────────
const REACTOR_FLOOD = 0xffd2a0;
const RED = 0xff2a1a;
const CORE = box(-3, 0, -3, 3, 14, 3);
const REACTOR: WorldTheme = {
  id: 'reactor',
  openSky: false,
  slots: {
    ...METAL,
    floor: { metalness: 0.25, normalScale: 0.5, ao: 0.6 },
    platform: { metalness: 0.5, normalScale: 0.9, ao: 0.85 },
  },
  trim: { color: 0x3fe0ff, intensity: 1.8 },
  dress: {
    slot: 'wall', tint: 0xf4f4f4,
    baseboard: { h: 0.5, d: 0.1 },
    pilasters: { spacing: 13, w: 1.0, d: 0.14 },
    bands: [{ y: 3.4, h: 0.3, d: 0.1 }, { y: 14, h: 0.5, d: 0.1 }],
    beams: { spacing: 8, w: 0.9, d: 0.14 },
    collars: { h: 0.7, d: 0.12 },
    edges: { h: 0.3, d: 0.03, hazard: true },
  },
  inlays: [
    // containment: a hazard band around the core and a cyan glow line at its foot
    ...hazardRing(CORE, 1.0, 0.6),
    ...hazardRing(CORE, 0.15, 0.2).map((i): Inlay => ({ ...i, hazard: false, color: 0x4fe8ff, glow: 0.9 })),
    // doorway thresholds through the chamber dividers
    { min: [-13.3, 0, -8], max: [-12.7, 0, 8], color: 0xc9a227, hazard: true },
    { min: [12.7, 0, -8], max: [13.3, 0, 8], color: 0xc9a227, hazard: true },
    // in front of the lobe step-ramps
    { min: [-20, 0, -2.2], max: [-19.4, 0, 2.2], color: 0xc9a227, hazard: true },
    { min: [19.4, 0, -2.2], max: [20, 0, 2.2], color: 0xc9a227, hazard: true },
    // painted walkway lines down the long side-lobe rail lanes
    ...[-12.5, 12.5].flatMap((z): Inlay[] => [
      { min: [-37, 0, z - 0.09], max: [-15, 0, z + 0.09], color: 0xb8961f },
      { min: [15, 0, z - 0.09], max: [37, 0, z + 0.09], color: 0xb8961f },
    ]),
  ],
  lights: [
    // core: vertical cyan strips + rings + a light off each face
    ...(['+x', '-x', '+z', '-z'] as Face[]).flatMap((face): LightDef[] => {
      const n = FACE_NORMAL[face];
      const c: V3 = [n[0] * 3, 7, n[2] * 3];
      const t: V3 = n[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
      const strip = (s: number): LightDef => ({
        at: [c[0] + t[0] * s, 7.25, c[2] + t[2] * s], face, size: [0.3, 10.5], color: 0x4fe8ff,
        intensity: 0, range: 1, kind: 'strip',
      });
      return [
        strip(1.2), strip(-1.2),
        { at: c, face, size: [0.01, 0.01], color: 0x3fdcff, intensity: 90, range: 24, out: 1.3, radius: 1.4, fixture: false },
        // red warning lamp high on each core face
        wallLamp([c[0], 13.2, c[2]], face, RED, 10, 7, { size: [0.7, 0.3], down: 0.3, angle: 1.2, out: 0.3 }),
      ];
    }),
    ...band4(CORE, 1.3, 0.22, 0x4fe8ff, 0.9),
    ...band4(CORE, 12.5, 0.22, 0x4fe8ff, 0.9),
    { at: [0, 14.6, 0], face: '+y', size: [1.6, 1.6], color: 0x3fdcff, intensity: 70, range: 16, out: 1.4, radius: 0.6 },
    // perimeter wall-washers: steep cones, so the pool lands on the wall
    ...[-26, 0, 26].flatMap((x) => [
      wallLamp([x, 9, -26], '+z', REACTOR_FLOOD, 220, 26, { size: [1.2, 0.5], down: 3.2, angle: 0.5, radius: 0.5 }),
      wallLamp([x, 9, 26], '-z', REACTOR_FLOOD, 220, 26, { size: [1.2, 0.5], down: 3.2, angle: 0.5, radius: 0.5 }),
    ]),
    ...[-14, 14].flatMap((z) => [
      wallLamp([-38, 9, z], '+x', REACTOR_FLOOD, 220, 26, { size: [1.2, 0.5], down: 3.2, angle: 0.5, radius: 0.5 }),
      wallLamp([38, 9, z], '-x', REACTOR_FLOOD, 220, 26, { size: [1.2, 0.5], down: 3.2, angle: 0.5, radius: 0.5 }),
    ]),
    ...[-33, -19, -6, 6, 19, 33].flatMap((x) => [
      sconce([x, 4.2, -26], '+z', 0xffcf98, 55, 11),
      sconce([x, 4.2, 26], '-z', 0xffcf98, 55, 11),
    ]),
    ...[-22, 0, 22].flatMap((z) => [
      sconce([-38, 4.2, z], '+x', 0xffcf98, 55, 11),
      sconce([38, 4.2, z], '-x', 0xffcf98, 55, 11),
    ]),
    // divider faces: cool scallops so the chamber walls aren't flat slabs
    ...[-17, 17].flatMap((z) => [
      sconce([-14, 5, z], '-x', 0xbfe4ff, 45, 10),
      sconce([-12, 5, z], '+x', 0xbfe4ff, 45, 10),
      sconce([12, 5, z], '-x', 0xbfe4ff, 45, 10),
      sconce([14, 5, z], '+x', 0xbfe4ff, 45, 10),
    ]),
    // red warning lamps framing every doorway (high + eye level)
    ...[-13, 13].flatMap((x) => [8, -8].flatMap((z) => {
      const face: Face = z > 0 ? '-z' : '+z';
      return [
        wallLamp([x, 12, z], face, RED, 14, 8, { size: [1.0, 0.35], down: 0.4, angle: 1.2, out: 0.35 }),
        wallLamp([x, 3.0, z], face, RED, 10, 6, { size: [0.6, 0.3], down: 0.6, angle: 1.2, out: 0.3 }),
      ];
    })),
    // lobe-platform undersides (clear of the spawn points)
    downLight([-25, 3.5, -5], 0x8cc4ff, 24, 9, { size: [0.9, 0.35], level: 0.6 }),
    downLight([-25, 3.5, 5], 0x8cc4ff, 24, 9, { size: [0.9, 0.35], level: 0.6 }),
    downLight([25, 3.5, -5], 0x8cc4ff, 24, 9, { size: [0.9, 0.35], level: 0.6 }),
    downLight([25, 3.5, 5], 0x8cc4ff, 24, 9, { size: [0.9, 0.35], level: 0.6 }),
  ],
  bake: {
    ambientUp: 0x8a98ac, ambientDown: 0x4a505c, ambient: 0.16,
    sky: null,
    ao: { radius: 2.6, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: true,
    texel: 0.45,
  },
  sun: { dir: norm([0.3, 0.9, 0.3]), color: 0xfff0dc, intensity: 1.6, mapScale: 0.1 },
  hemi: { sky: 0xb8d0e8, ground: 0x3a3e46, intensity: 0.5, mapScale: 0.1 },
  fill: { dir: norm([-0.5, 0.3, -0.6]), color: 0x6fe0ff, intensity: 0.45, mapScale: 0.2 },
  env: { intensity: 0.35, mapScale: 0.5 },
  worldSaturation: 0.85,
  exposure: 1.05,
  fog: { color: 0x0a0e12, near: 40, far: 200 },
  background: 0x06080a,
  sky: { mode: 'interior', top: 0x06080a, horizon: 0x06080a },
};

// ── Lounge → Ratz homage: warm interior at giant scale ─────────────────────
const LAMP = 0xffb766;
const LOUNGE_SOFAS = new Set([6, 7, 8, 9]);
const LOUNGE_CASES = new Set([10, 11, 12, 13]);
const LOUNGE: WorldTheme = {
  id: 'lounge',
  openSky: false,
  slots: {
    floor: { metalness: 0, normalScale: 0.7, ao: 0.7 },
    ceiling: { metalness: 0, normalScale: 0.4, ao: 0.4 },
    wall: { metalness: 0, normalScale: 0.4, ao: 0.4 },
    cover: { metalness: 0, normalScale: 0.9, ao: 0.9 },
    platform: { metalness: 0, normalScale: 0.7, ao: 0.7 },
    tower: { metalness: 0, normalScale: 0.7, ao: 0.7 },
  },
  slotFor: (i, b, k) => {
    if (LOUNGE_SOFAS.has(i)) return 'cover';
    if (LOUNGE_CASES.has(i)) return 'tower';
    if (i === 18) return 'tower'; // the column: cabinet wood, with a base + capital
    if (i >= 14) return 'platform'; // shelves, table, perch, low cover
    return defaultSlot(i, b, k);
  },
  trim: null,
  dress: {
    slot: 'platform', tint: 0xe8e0d8,
    baseboard: { h: 0.55, d: 0.1 },
    bands: [{ y: 3.2, h: 0.25, d: 0.1 }],
    crown: { h: 0.8, d: 0.14 },
    pilasters: { spacing: 12, w: 0.9, d: 0.1 },
    edges: { h: 0.14, d: 0.03 },
  },
  lights: [
    // the giant lamp: a fabric shade glowing softly, a diffuser underneath
    // and a big warm pool under the perch
    downLight([0, 9.5, 0], 0xffc27a, 420, 36, { size: [2.2, 2.2], angle: 1.25, radius: 1.0, level: 0.85 }),
    { at: [0, 10.1, 0], face: '+y', size: [0.01, 0.01], color: 0xffb266, intensity: 90, range: 14, out: 1.2, fixture: false },
    ...band4(box(-2, 9.5, -2, 2, 10.1, 2), 9.8, 0.36, 0xffb870, 0.38),
    // sconces above the book shelf: warm scallops up and down the wallpaper
    ...[-12, 0, 12].flatMap((z) => [
      sconce([-28, 8.5, z], '+x', LAMP, 130, 18),
      sconce([28, 8.5, z], '-x', LAMP, 130, 18),
    ]),
    sconce([-16, 8.5, -20], '+z', LAMP, 130, 18),
    sconce([16, 8.5, -20], '+z', LAMP, 130, 18),
    ...[-14, 0, 14].map((x) => sconce([x, 8.5, 20], '-z', LAMP, 130, 18)),
    // under-shelf downlights
    ...[-14, 0, 14].flatMap((z) => [
      downLight([-26, 5, z], 0xffa850, 26, 9, { size: [1.2, 0.4] }),
      downLight([26, 5, z], 0xffa850, 26, 9, { size: [1.2, 0.4] }),
    ]),
    // moonlit window on the north wall (3×2 framed panes): cool counter-light
    ...[-3, 0, 3].flatMap((x): LightDef[] => [10.5, 13.5].map((y): LightDef => ({
      at: [x, y, -20], face: '+z', size: [2.5, 2.5], color: 0x7c9ad8, intensity: 0, range: 1, kind: 'window', level: 0.75,
    }))),
    {
      at: [-3, 12, -20], face: '+z', size: [0.01, 0.01], color: 0x8fb0ff, intensity: 300, range: 38, out: 0.8,
      radius: 1.2, fixture: false, spot: { dir: norm([0, -0.6, 1]), angle: 0.7, penumbra: 0.7 },
    },
    {
      at: [3, 12, -20], face: '+z', size: [0.01, 0.01], color: 0x8fb0ff, intensity: 300, range: 38, out: 0.8,
      radius: 1.2, fixture: false, spot: { dir: norm([0, -0.6, 1]), angle: 0.7, penumbra: 0.7 },
    },
  ],
  bake: {
    ambientUp: 0xb08a6a, ambientDown: 0x5a4432, ambient: 0.16,
    sky: null,
    ao: { radius: 2.8, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: true,
    texel: 0.4,
  },
  sun: { dir: norm([0.25, 0.85, 0.45]), color: 0xffe0bc, intensity: 1.4, mapScale: 0.1 },
  hemi: { sky: 0xffe2c4, ground: 0x4a3526, intensity: 0.5, mapScale: 0.1 },
  fill: { dir: norm([-0.2, 0.3, -0.9]), color: 0x8fb0ff, intensity: 0.5, mapScale: 0.2 },
  env: { intensity: 0.3, mapScale: 0.5 },
  worldSaturation: 0.88,
  exposure: 1.05,
  fog: { color: 0x120c08, near: 40, far: 200 },
  background: 0x0a0806,
  sky: { mode: 'interior', top: 0x0a0806, horizon: 0x0a0806 },
};

// ── Nuketown → dusk suburb ─────────────────────────────────────────────────
const SODIUM = 0xffa040;
const NUKE_HOUSE_W = new Set([6, 7, 8]);
const NUKE_HOUSE_E = new Set([15, 16, 17]);
const NUKE_DECKS = new Set([9, 10, 11, 12, 14, 18, 19, 20, 21, 23]);
const NUKE_TINT: Record<number, number> = {
  13: 0xd8d4c8, // porch W
  22: 0xd8d4c8, // porch E
  24: 0xd9a21e, // school bus
  25: 0xc9c7c0, // moving van
  26: 0x9c2f28, // car
  27: 0x2f5486, // car
  28: 0x8a8378, // planter
  29: 0x8a6a48, // crate
  30: 0x8a6a48, // crate
};

// Framed, glazed windows with a warm interior glow (+ a spill light below the
// ground-floor ones on the yard side).
function windows(face: Face, plane: number, spans: number[], light: boolean): LightDef[] {
  const out: LightDef[] = [];
  for (const u of spans) {
    for (const y of [1.9, 5.3]) {
      const at: V3 = face[1] === 'x' ? [plane, y, u] : [u, y, plane];
      out.push({ at, face, size: [1.3, 1.1], color: 0xffb870, intensity: 0, range: 1, kind: 'window' });
      if (light && y < 3) {
        out.push({
          at, face, size: [0.01, 0.01], color: 0xffb060, intensity: 14, range: 7, out: 0.7, fixture: false,
          spot: { dir: norm([FACE_NORMAL[face][0], -0.7, FACE_NORMAL[face][2]]), angle: 1.1, penumbra: 0.6 },
        });
      }
    }
  }
  return out;
}

// Neighbouring houses + trees beyond the garden wall (silhouettes).
function suburb(): SkyProp[] {
  const out: SkyProp[] = [];
  const house = (x: number, z: number, w: number, d: number, h: number) => {
    out.push(prop(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, 0x16131a));
    out.push(prop(x - w / 2 + 0.8, h, z - d / 2 + 0.8, x + w / 2 - 0.8, h + 1.6, z + d / 2 - 0.8, 0x120f16));
  };
  for (const s of [-1, 1]) {
    house(-22, s * 33, 12, 8, 6);
    house(-4, s * 35, 10, 8, 5.5);
    house(14, s * 33, 12, 9, 6.5);
    house(28, s * 36, 9, 8, 5);
    out.push(prop(-12, 0, s * 29 - 1, -10, 9, s * 29 + 1, 0x0e1210));
    out.push(prop(6, 0, s * 30 - 1.2, 8.4, 11, s * 30 + 1.2, 0x0e1210));
  }
  for (const s of [-1, 1]) {
    house(s * 41, -10, 8, 12, 6);
    house(s * 42, 12, 8, 10, 5.5);
    out.push(prop(s * 38 - 1, 0, -1, s * 38 + 1, 10, 1, 0x0e1210));
  }
  return out;
}

const DUSK: WorldTheme = {
  id: 'dusk',
  openSky: true,
  perimeterTop: 3.0,
  slots: {
    floor: { metalness: 0, normalScale: 0.6, ao: 0.5 },
    ceiling: { metalness: 0, normalScale: 0.5, ao: 0.5 },
    wall: { metalness: 0, normalScale: 0.8, ao: 0.7 },
    cover: { metalness: 0.2, normalScale: 0.6, ao: 0.6 },
    platform: { metalness: 0, normalScale: 0.7, ao: 0.7 },
    tower: { metalness: 0, normalScale: 0.8, ao: 0.8 },
  },
  slotFor: (i, b, k) => {
    if (NUKE_HOUSE_W.has(i) || NUKE_HOUSE_E.has(i)) return 'tower';
    if (NUKE_DECKS.has(i)) return 'platform';
    if (i in NUKE_TINT) return 'cover';
    return defaultSlot(i, b, k);
  },
  tintFor: (i) => {
    if (NUKE_HOUSE_W.has(i)) return 0xa8cdb8; // mint siding
    if (NUKE_HOUSE_E.has(i)) return 0xe6d49a; // butter-yellow siding
    return NUKE_TINT[i] ?? null;
  },
  trim: null,
  dress: {
    slot: 'wall', tint: 0xf2f2f2,
    crown: { h: 0.3, d: 0.14 },
    pilasters: { spacing: 8, w: 0.8, d: 0.14 },
  },
  inlays: [
    // road centre line + kerb lines
    ...dashes(0, -21, 21, 2.2, 1.4, 0.18, 0xd6b24a),
    { min: [-13.2, 0, -21], max: [-13, 0, 21], color: 0xcfcac0 },
    { min: [13, 0, -21], max: [13.2, 0, 21], color: 0xcfcac0 },
  ],
  skyline: [
    ...suburb(),
    ...[-10, 10].flatMap((x) => [mast([x, 7, -22.3], '+z'), mast([x, 7, 22.3], '-z')]),
  ],
  lights: [
    // lit windows on both houses (back walls face the spawn yards)
    ...windows('-x', -27, [-4.5, 4.5], true),
    ...windows('+x', 27, [-4.5, 4.5], true),
    ...windows('+z', 9, [-23.5, 23.5], false),
    ...windows('-z', -9, [-23.5, 23.5], false),
    // porch + balcony lights
    downLight([-22.5, 3.6, 2], 0xffc070, 45, 11, { size: [0.8, 0.8] }),
    downLight([22.5, 3.6, 2], 0xffc070, 45, 11, { size: [0.8, 0.8] }),
    downLight([-23, 6.5, 0], 0xffc070, 30, 9, { size: [0.6, 0.6] }),
    downLight([23, 6.5, 0], 0xffc070, 30, 9, { size: [0.6, 0.6] }),
    // sodium street lamps on masts just outside the garden wall
    ...[-10, 10].flatMap((x) => [
      mastLamp([x, 7, -22.3], '+z', SODIUM, 240, 26, { size: [0.9, 0.4], down: 1.0, angle: 1.0, radius: 0.4 }),
      mastLamp([x, 7, 22.3], '-z', SODIUM, 240, 26, { size: [0.9, 0.4], down: 1.0, angle: 1.0, radius: 0.4 }),
    ]),
  ],
  bake: {
    ambientUp: 0x8a7a88, ambientDown: 0x5a4a44, ambient: 0.16,
    sky: { color: 0x6f86c0, intensity: 0.5 },
    ao: { radius: 2.4, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: false,
    texel: 0.4,
  },
  sun: { dir: norm([-0.72, 0.42, 0.55]), color: 0xffa860, intensity: 2.6, mapScale: 1.0 },
  hemi: { sky: 0x8a9ad0, ground: 0x4a3a34, intensity: 0.55, mapScale: 0.15 },
  fill: { dir: norm([0.6, 0.35, -0.6]), color: 0x7f96d8, intensity: 0.4, mapScale: 0.3 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.86,
  exposure: 1.0,
  fog: { color: 0x4a3a4a, near: 40, far: 240 },
  background: 0x2a2440,
  sky: {
    mode: 'dusk', top: 0x1a2350, mid: 0x6a4c7c, horizon: 0xf0925a, ground: 0x2a2030,
    sunColor: 0xffd2a0, sunSize: 0.035, sunGlow: 1.0, band: 0.28,
  },
};

// ── Container Yard → night port ────────────────────────────────────────────
const CONTAINER_TINT: Record<number, number> = {
  6: 0x8c3a2a, // dropbox (rust red)
  7: 0x8c3a2a,
  9: 0x2f5a7a, // blue
  10: 0xa65a2a, // orange
  11: 0x2f5a7a,
  12: 0xa65a2a,
  13: 0x3f6a4a, // green
  14: 0x3f6a4a,
  17: 0x8a8378, // crates
  18: 0x8a8378,
};
const PORT_SODIUM = 0xff9a3c;

// Container stacks + a gantry crane beyond the yard walls (silhouettes).
function port(): SkyProp[] {
  const out: SkyProp[] = [];
  const stack = (x0: number, z0: number, x1: number, z1: number, tiers: number, c: number) => {
    for (let t = 0; t < tiers; t++) out.push(prop(x0, t * 2.6, z0, x1, t * 2.6 + 2.55, z1, c));
  };
  stack(-24, 15, -12, 17.5, 3, 0x1a1110);
  stack(-10, 15.5, 2, 18, 2, 0x10151a);
  stack(4, 15, 16, 17.5, 4, 0x12160f);
  stack(-20, -18.5, -8, -16, 2, 0x10151a);
  stack(-6, -18, 6, -15.5, 3, 0x1a1110);
  stack(8, -18.5, 20, -16, 2, 0x161616);
  stack(18, -6, 20.5, 6, 3, 0x1a1110);
  stack(-20.5, -4, -18, 8, 2, 0x12160f);
  // gantry crane north-east
  out.push(prop(6, 0, 24, 7.2, 24, 25.2, 0x0b0c0f));
  out.push(prop(18, 0, 24, 19.2, 24, 25.2, 0x0b0c0f));
  out.push(prop(2, 22, 23.6, 24, 24, 25.6, 0x0b0c0f, 0xff2a1a));
  out.push(prop(-2, 22.5, 24.1, 2, 23.5, 25.1, 0x0b0c0f, 0xff2a1a));
  // light towers further out
  out.push(prop(-30, 0, -2, -29.4, 16, -1.4, 0x0b0c0f, 0xff2a1a));
  out.push(prop(30, 0, 4, 30.6, 14, 4.6, 0x0b0c0f, 0xff2a1a));
  return out;
}

const NIGHTPORT: WorldTheme = {
  id: 'nightport',
  openSky: true,
  perimeterTop: 3.4,
  slots: {
    ...METAL,
    floor: { metalness: 0.15, normalScale: 0.5, ao: 0.6 },
    wall: { metalness: 0, normalScale: 0.7, ao: 0.6 },
    cover: { metalness: 0.4, normalScale: 1.0, ao: 0.7 },
  },
  slotFor: (i, b, k) => {
    if (i in CONTAINER_TINT) return 'cover';
    if (i === 8) return 'platform'; // crown perch
    return defaultSlot(i, b, k);
  },
  tintFor: (i) => CONTAINER_TINT[i] ?? null,
  trim: null,
  dress: {
    slot: 'tower', tint: 0xf0f0f0,
    crown: { h: 0.35, d: 0.12 },
    pilasters: { spacing: 6.5, w: 0.6, d: 0.14 },
    collars: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.35, d: 0.1 },
  },
  inlays: [
    // painted bay outline around the dropbox + lane lines
    ...outline(box(-4.2, 0, -3.7, 4.2, 0, 3.7), 0.18, 0xc9a227),
    { min: [-11.8, 0, -0.09], max: [-10.4, 0, 0.09], color: 0xc9a227 },
    { min: [10.4, 0, -0.09], max: [11.8, 0, 0.09], color: 0xc9a227 },
  ],
  skyline: [
    ...port(),
    ...[-7, 7].flatMap((x) => [mast([x, 9, -11.35], '+z'), mast([x, 9, 11.35], '-z')]),
    mast([-13.35, 6.5, 0], '+x'),
    mast([13.35, 6.5, 0], '-x'),
  ],
  lights: [
    // sodium floods on masts over the yard walls
    ...[-7, 7].flatMap((x) => [
      mastLamp([x, 9, -11.35], '+z', PORT_SODIUM, 360, 30, { size: [1.2, 0.6], down: 1.25, angle: 0.95, radius: 0.4 }),
      mastLamp([x, 9, 11.35], '-z', PORT_SODIUM, 360, 30, { size: [1.2, 0.6], down: 1.25, angle: 0.95, radius: 0.4 }),
    ]),
    // cool work lights (contrast) on the side masts
    mastLamp([-13.35, 6.5, 0], '+x', 0xcfe2ff, 130, 22, { size: [0.8, 0.45], down: 0.9, angle: 0.85 }),
    mastLamp([13.35, 6.5, 0], '-x', 0xcfe2ff, 130, 22, { size: [0.8, 0.45], down: 0.9, angle: 0.85 }),
    // red beacon under the crown perch
    downLight([0, 8, 0], 0xff3a2a, 14, 7, { size: [0.6, 0.6] }),
  ],
  bake: {
    ambientUp: 0x4a5270, ambientDown: 0x2a2a30, ambient: 0.12,
    sky: { color: 0x2a3a66, intensity: 0.2 },
    ao: { radius: 2.2, strength: 0.85 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: false,
    texel: 0.26,
  },
  sun: { dir: norm([0.3, 0.85, -0.4]), color: 0x8fa6ff, intensity: 1.0, mapScale: 0.3 },
  hemi: { sky: 0x6a7ab8, ground: 0x3a2a22, intensity: 0.55, mapScale: 0.12 },
  fill: { dir: norm([-0.5, 0.4, 0.7]), color: 0xffa050, intensity: 0.5, mapScale: 0.2 },
  env: { intensity: 0.3, mapScale: 0.8 },
  worldSaturation: 0.9,
  shadowBox: 34,
  exposure: 1.1,
  fog: { color: 0x120d0c, near: 30, far: 160 },
  background: 0x05060a,
  sky: {
    mode: 'night', top: 0x02040a, horizon: 0x16121e, glow: 0x5a3212, stars: 0.85,
  },
};

// ── Derrick → rust at dusk ─────────────────────────────────────────────────
const DERRICK_DECKS = new Set([7, 8, 9, 10, 11]);
const DERRICK_GENS = new Set([12, 13]);

// Refinery skyline against the low sun (-z / +x side) + a sparser ring.
function refinery(): SkyProp[] {
  const c = 0x140d0b;
  const out: SkyProp[] = [
    prop(4, 0, -30, 6, 34, -28, c, 0xff2a1a), // flare stack
    prop(-10, 0, -34, -8.6, 26, -32.6, c),
    prop(-4, 0, -26, 4, 9, -20, c), // tank
    prop(-20, 0, -28, -12, 7, -20, c),
    prop(12, 0, -34, 20, 14, -28, c), // cracking tower block
    prop(14.5, 14, -32, 17.5, 22, -30, c, 0xff2a1a),
    prop(24, 0, -22, 30, 10, -16, c),
    prop(22, 0, -4, 28, 6, 4, c),
    prop(26, 0, 10, 27.4, 20, 11.4, c, 0xff2a1a),
    prop(-30, 0, 6, -22, 8, 14, c),
    prop(-26, 0, -10, -24.6, 18, -8.6, c),
    prop(-6, 0, 22, 6, 5, 28, c),
    prop(10, 0, 24, 11.2, 16, 25.2, c),
  ];
  return out;
}

const RUSTDUSK: WorldTheme = {
  id: 'rustdusk',
  openSky: true,
  perimeterTop: 4.2,
  slots: {
    ...METAL,
    floor: { metalness: 0.05, normalScale: 0.6, ao: 0.6 },
    wall: { metalness: 0.4, normalScale: 0.9, ao: 0.6 },
    platform: { metalness: 0.5, normalScale: 1.0, ao: 0.9 },
  },
  slotFor: (i, b, k) => {
    if (DERRICK_DECKS.has(i)) return 'platform';
    if (DERRICK_GENS.has(i)) return 'cover';
    return defaultSlot(i, b, k);
  },
  trim: { color: 0xff8a3c, intensity: 1.6 },
  dress: {
    slot: 'tower', tint: 0xf0f0f0,
    crown: { h: 0.4, d: 0.12 },
    collars: { h: 0.6, d: 0.12 },
    baseboard: { h: 0.4, d: 0.1 },
    edges: { h: 0.25, d: 0.03, hazard: true },
  },
  inlays: [...hazardRing(box(-2, 0, -2, 2, 11, 2), 0.9, 0.45)],
  skyline: refinery(),
  lights: [
    downLight([5.5, 5, 0], 0xffb060, 50, 12, { size: [1.0, 0.6] }),
    downLight([-5.5, 5, 0], 0xffb060, 50, 12, { size: [1.0, 0.6] }),
    downLight([0, 8, 5.5], 0xffb060, 50, 12, { size: [0.6, 1.0] }),
    downLight([0, 8, -5.5], 0xffb060, 50, 12, { size: [0.6, 1.0] }),
    { at: [0, 11.5, 0], face: '+y', size: [0.01, 0.01], color: 0xff4030, intensity: 22, range: 9, out: 1.0, fixture: false },
    ...band4(box(-3, 11, -3, 3, 11.5, 3), 11.25, 0.22, 0xff4030, 0.6),
    wallLamp([-8, 1.5, 5], '-z', 0xffa030, 12, 6, { size: [0.6, 0.3], down: 0.3, angle: 1.2, out: 0.3 }),
    wallLamp([8, 1.5, -5], '+z', 0xffa030, 12, 6, { size: [0.6, 0.3], down: 0.3, angle: 1.2, out: 0.3 }),
  ],
  bake: {
    ambientUp: 0x8a6a6a, ambientDown: 0x4a3430, ambient: 0.16,
    sky: { color: 0x9a7a9a, intensity: 0.45 },
    ao: { radius: 2.2, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: false,
    texel: 0.22,
  },
  sun: { dir: norm([0.45, 0.5, -0.82]), color: 0xff8a4a, intensity: 2.6, mapScale: 1.0 },
  hemi: { sky: 0xa08ab0, ground: 0x4a3028, intensity: 0.55, mapScale: 0.15 },
  fill: { dir: norm([-0.5, 0.4, 0.75]), color: 0x8a86c8, intensity: 0.4, mapScale: 0.3 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.8,
  shadowBox: 34,
  exposure: 1.0,
  fog: { color: 0x5a3426, near: 30, far: 200 },
  background: 0x3a2020,
  sky: {
    mode: 'dusk', top: 0x3a2a4e, mid: 0xc0603e, horizon: 0xff8a40, ground: 0x2a1a18,
    sunColor: 0xffc080, sunSize: 0.05, sunGlow: 1.5, band: 0.45,
  },
};

// ── Training → Lab: clean, bright, neutral (the exception) ─────────────────
const LAB: WorldTheme = {
  id: 'lab',
  openSky: true,
  slots: METAL,
  trim: { color: null, intensity: 1.9 },
  dress: {
    slot: 'tower', tint: 0xf4f4f4,
    crown: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.35, d: 0.08 },
    collars: { h: 0.5, d: 0.1 },
    edges: { h: 0.12, d: 0.03 },
  },
  lights: [],
  bake: {
    ambientUp: 0xd8e0ea, ambientDown: 0x9aa0a8, ambient: 0.45,
    sky: { color: 0xb8d0ec, intensity: 1.0 },
    ao: { radius: 2.2, strength: 0.7 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.45,
  },
  sun: { dir: norm([0.35, 0.85, 0.4]), color: 0xfff4e4, intensity: 2.0, mapScale: 1.0 },
  hemi: { sky: 0xcfe2f2, ground: 0x7d8088, intensity: 0.6, mapScale: 0.2 },
  fill: { dir: norm([-0.6, 0.35, -0.5]), color: 0x88a6ff, intensity: 0.35, mapScale: 0.4 },
  env: { intensity: 0.4, mapScale: 0.8 },
  worldSaturation: 1.0,
  exposure: 0.95,
  fog: { color: 0xb6cadb, near: 90, far: 280 },
  background: 0x9fc0dd,
  sky: { mode: 'lab', top: 0x2f6fb8, horizon: 0xc8dcec },
};

const BY_MAP: Record<string, WorldTheme> = {
  causeway: VOID,
  reactor: REACTOR,
  lounge: LOUNGE,
  nuketown: DUSK,
  containeryard: NIGHTPORT,
  derrick: RUSTDUSK,
  training: LAB,
};

// Theme for a map id (unknown maps get the neutral lab look).
export function themeForMapId(id: string | undefined): WorldTheme {
  return (id && BY_MAP[id]) || LAB;
}
