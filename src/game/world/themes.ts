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
// its emissive fixture is flush to a collision surface (≤ 0.1 m proud) and
// the light that fixture "emits" sits `out` metres in front of it. A light
// with intensity 0 is fixture-only (a glowing band that justifies a nearby
// light). Intensities are three.js candela-style (decay 2): E = I / d².
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
  glow?: number; // fixture HDR multiplier (default 2.2 → blooms)
  fixture?: boolean; // default true
};

export type SlotParams = { metalness: number; normalScale: number; ao: number };

export type DressStyle = {
  slot: SurfaceKind; // texture slot the trim pieces borrow
  tint: number; // vertex tint for trim metal (sRGB hex, multiplies the slot albedo)
  baseboard?: { h: number; d: number };
  pilasters?: { spacing: number; w: number; d: number; top?: number };
  band?: { y: number; h: number; d: number };
  crown?: { h: number; d: number }; // cap band along the top of perimeter walls
  beams?: { spacing: number; w: number; d: number }; // ceiling ribs (closed maps)
  collars?: { h: number; d: number }; // pillar base + capital
  edges?: { h: number; d: number }; // machined band on platform / cover top edges
};

export type Inlay = { min: V3; max: V3; color: number; glow?: number };

export type WorldTheme = {
  id: ThemeId;
  openSky: boolean; // don't draw the ceiling (render-only; it still collides)
  slots: Record<SurfaceKind, SlotParams>;
  slotFor?: (index: number, box: AABB, fallback: SurfaceKind) => SurfaceKind;
  tintFor?: (index: number, box: AABB, slot: SurfaceKind) => number | null;
  trim: { color: number | null; intensity: number } | null; // accent edge light (null colour = map accent)
  dress: DressStyle;
  inlays?: Inlay[];
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

// Wall-mounted lamp aimed out and down (the classic Quake scallop below it).
function wallLamp(
  at: V3, face: Face, color: number, intensity: number, range: number,
  o: { size?: [number, number]; down?: number; angle?: number; out?: number; radius?: number; glow?: number } = {},
): LightDef {
  const n = FACE_NORMAL[face];
  const down = o.down ?? 1;
  return {
    at, face, color, intensity, range,
    size: o.size ?? [0.9, 0.5],
    out: o.out ?? 0.5,
    radius: o.radius ?? 0.35,
    glow: o.glow,
    spot: { dir: norm([n[0], n[1] - down, n[2]]), angle: o.angle ?? 1.0, penumbra: 0.55 },
  };
}

// Small wall lamp standing ~1 m off the wall with a wide cone: throws the
// round Quake scallop onto the wall around and below it.
function sconce(at: V3, face: Face, color: number, intensity: number, range: number, glow = 2.0): LightDef {
  const n = FACE_NORMAL[face];
  return {
    at, face, color, intensity, range,
    size: [0.5, 0.5],
    out: 0.9,
    radius: 0.25,
    glow,
    spot: { dir: norm([n[0] * 0.25, -1, n[2] * 0.25]), angle: 1.35, penumbra: 0.5 },
  };
}

// Fixture on an underside, shining straight down.
function downLight(
  at: V3, color: number, intensity: number, range: number,
  o: { size?: [number, number]; angle?: number; out?: number; radius?: number; glow?: number } = {},
): LightDef {
  return {
    at, face: '-y', color, intensity, range,
    size: o.size ?? [1.2, 1.2],
    out: o.out ?? 0.35,
    radius: o.radius ?? 0.3,
    glow: o.glow ?? 1.7,
    spot: { dir: [0, -1, 0], angle: o.angle ?? 1.1, penumbra: 0.6 },
  };
}

// Emissive band only (no light) on the four sides of a pillar at height y.
function pillarBand(b: AABB, y: number, h: number, color: number, glow = 2.4): LightDef[] {
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const sx = b.max.x - b.min.x;
  const sz = b.max.z - b.min.z;
  const f = (at: V3, face: Face, w: number): LightDef => ({
    at, face, size: [w, h], color, intensity: 0, range: 1, glow,
  });
  return [
    f([b.max.x, y, cz], '+x', sz),
    f([b.min.x, y, cz], '-x', sz),
    f([cx, y, b.max.z], '+z', sx),
    f([cx, y, b.min.z], '-z', sx),
  ];
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
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
  floor: { metalness: 0.2, normalScale: 0.8, ao: 0.7 },
  ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
  wall: { metalness: 0.25, normalScale: 0.85, ao: 0.7 },
  cover: { metalness: 0.3, normalScale: 1.0, ao: 0.7 },
  platform: { metalness: 0.35, normalScale: 0.8, ao: 0.75 },
  tower: { metalness: 0.35, normalScale: 0.85, ao: 0.7 },
};

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
  slots: METAL,
  trim: { color: 0x8f7dff, intensity: 2.2 },
  dress: {
    slot: 'tower', tint: 0x9aa3b8,
    baseboard: { h: 0.45, d: 0.08 },
    pilasters: { spacing: 10, w: 0.8, d: 0.12, top: 21 },
    crown: { h: 0.6, d: 0.12 },
    band: { y: 8, h: 0.35, d: 0.08 },
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
        ...pillarBand(b, 11.45, 0.5, color),
        ...pillarBand(b, 0.9, 0.18, color, 1.6),
      ];
    }),
    // corner platforms: downlights into the pit
    downLight([-23, 4, -13.5], VIOLET, 50, 13, { size: [3, 1.2] }),
    downLight([23, 4, -13.5], 0x7fa8ff, 50, 13, { size: [3, 1.2] }),
    downLight([-23, 4, 13.5], 0x7fa8ff, 50, 13, { size: [3, 1.2] }),
    downLight([23, 4, 13.5], VIOLET, 50, 13, { size: [3, 1.2] }),
    // central hub underside
    downLight([-3.5, 8, 0], CYAN, 80, 16, { size: [2.4, 1.2], angle: 1.0 }),
    downLight([3.5, 8, 0], CYAN, 80, 16, { size: [2.4, 1.2], angle: 1.0 }),
    // perimeter light strips (deep blue scallops)
    ...[-20, 0, 20].flatMap((x): LightDef[] => [
      { at: [x, 4.5, -23], face: '+z', size: [0.35, 6], color: 0x5c78ff, intensity: 34, range: 12, out: 0.7, radius: 0.4, glow: 2.0 },
      { at: [x, 4.5, 23], face: '-z', size: [0.35, 6], color: 0x5c78ff, intensity: 34, range: 12, out: 0.7, radius: 0.4, glow: 2.0 },
    ]),
    ...[-8, 8].flatMap((z): LightDef[] => [
      { at: [-33, 4.5, z], face: '+x', size: [0.35, 6], color: 0x5c78ff, intensity: 34, range: 12, out: 0.7, radius: 0.4, glow: 2.0 },
      { at: [33, 4.5, z], face: '-x', size: [0.35, 6], color: 0x5c78ff, intensity: 34, range: 12, out: 0.7, radius: 0.4, glow: 2.0 },
    ]),
  ],
  bake: {
    ambientUp: 0x3a3f66, ambientDown: 0x1c1e30, ambient: 0.14,
    sky: { color: 0x6a60c8, intensity: 0.32 },
    ao: { radius: 2.6, strength: 0.85 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.4,
  },
  sun: { dir: norm([-0.35, 0.85, 0.4]), color: 0xc4ccff, intensity: 1.5, mapScale: 0.45 },
  hemi: { sky: 0x8e8cd8, ground: 0x2a2438, intensity: 0.55, mapScale: 0.12 },
  fill: { dir: norm([0.6, 0.35, -0.7]), color: 0x6fd8ff, intensity: 0.45, mapScale: 0.25 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.85,
  exposure: 1.0,
  fog: { color: 0x120c24, near: 45, far: 240 },
  background: 0x05040c,
  sky: {
    mode: 'space', top: 0x03020a, horizon: 0x120a26, nebula: [0x5a2a9c, 0x1f4c9a, 0xb03c86], stars: 1,
  },
};

// ── Reactor → industrial tech ──────────────────────────────────────────────
const REACTOR_FLOOD = 0xffd6a4;
const REACTOR: WorldTheme = {
  id: 'reactor',
  openSky: false,
  slots: { ...METAL, platform: { metalness: 0.5, normalScale: 1.0, ao: 0.9 } },
  trim: { color: 0x3fe0ff, intensity: 2.0 },
  dress: {
    slot: 'tower', tint: 0xb4bcc8,
    baseboard: { h: 0.6, d: 0.1 },
    pilasters: { spacing: 13, w: 1.0, d: 0.14 },
    band: { y: 14, h: 0.5, d: 0.1 },
    beams: { spacing: 8, w: 0.9, d: 0.14 },
    collars: { h: 0.7, d: 0.12 },
    edges: { h: 0.14, d: 0.03 },
  },
  inlays: [
    // hazard ring around the core base (yellow/black dashes)
    ...hazardRing(box(-3, 0, -3, 3, 14, 3), 1.1, 0.5),
  ],
  lights: [
    // core: vertical cyan strips + a light off each face
    ...(['+x', '-x', '+z', '-z'] as Face[]).flatMap((face): LightDef[] => {
      const n = FACE_NORMAL[face];
      const c: V3 = [n[0] * 3, 7, n[2] * 3];
      const t: V3 = n[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
      const strip = (s: number): LightDef => ({
        at: [c[0] + t[0] * s, 7.25, c[2] + t[2] * s], face, size: [0.35, 11.5], color: 0x4fe8ff,
        intensity: 0, range: 1, glow: 2.6,
      });
      return [
        strip(1.7), strip(-1.7),
        { at: c, face, size: [0.01, 0.01], color: 0x3fdcff, intensity: 90, range: 24, out: 1.3, radius: 1.4, fixture: false },
      ];
    }),
    { at: [0, 14.6, 0], face: '+y', size: [2, 2], color: 0x3fdcff, intensity: 70, range: 16, out: 1.4, radius: 0.6, glow: 2.0 },
    // perimeter floodlights (tight, high pools) + low sconces between them
    ...[-26, 0, 26].flatMap((x) => [
      wallLamp([x, 9, -26], '+z', REACTOR_FLOOD, 320, 30, { size: [1.4, 0.7], down: 1.7, angle: 0.75, radius: 0.5 }),
      wallLamp([x, 9, 26], '-z', REACTOR_FLOOD, 320, 30, { size: [1.4, 0.7], down: 1.7, angle: 0.75, radius: 0.5 }),
    ]),
    ...[-14, 14].flatMap((z) => [
      wallLamp([-38, 9, z], '+x', REACTOR_FLOOD, 320, 30, { size: [1.4, 0.7], down: 1.7, angle: 0.75, radius: 0.5 }),
      wallLamp([38, 9, z], '-x', REACTOR_FLOOD, 320, 30, { size: [1.4, 0.7], down: 1.7, angle: 0.75, radius: 0.5 }),
    ]),
    ...[-33, -19, -6, 6, 19, 33].flatMap((x) => [
      sconce([x, 4.2, -26], '+z', 0xffcf98, 60, 11),
      sconce([x, 4.2, 26], '-z', 0xffcf98, 60, 11),
    ]),
    ...[-22, 0, 22].flatMap((z) => [
      sconce([-38, 4.2, z], '+x', 0xffcf98, 60, 11),
      sconce([38, 4.2, z], '-x', 0xffcf98, 60, 11),
    ]),
    // divider faces: cool scallops so the chamber walls aren't flat slabs
    ...[-17, 17].flatMap((z) => [
      sconce([-14, 5, z], '-x', 0xbfe4ff, 50, 10),
      sconce([-12, 5, z], '+x', 0xbfe4ff, 50, 10),
      sconce([12, 5, z], '-x', 0xbfe4ff, 50, 10),
      sconce([14, 5, z], '+x', 0xbfe4ff, 50, 10),
    ]),
    // red warning lamps on the divider ends
    wallLamp([-13, 12, -8], '+z', 0xff2a1a, 16, 8, { size: [1.2, 0.45], down: 0.4, angle: 1.2, out: 0.35, glow: 2.6 }),
    wallLamp([-13, 12, 8], '-z', 0xff2a1a, 16, 8, { size: [1.2, 0.45], down: 0.4, angle: 1.2, out: 0.35, glow: 2.6 }),
    wallLamp([13, 12, -8], '+z', 0xff2a1a, 16, 8, { size: [1.2, 0.45], down: 0.4, angle: 1.2, out: 0.35, glow: 2.6 }),
    wallLamp([13, 12, 8], '-z', 0xff2a1a, 16, 8, { size: [1.2, 0.45], down: 0.4, angle: 1.2, out: 0.35, glow: 2.6 }),
    // lobe-platform undersides
    downLight([-28, 3.5, -4], 0xd6ecff, 30, 10, { size: [1.4, 0.5], glow: 1.5 }),
    downLight([-28, 3.5, 4], 0xd6ecff, 30, 10, { size: [1.4, 0.5], glow: 1.5 }),
    downLight([28, 3.5, -4], 0xd6ecff, 30, 10, { size: [1.4, 0.5], glow: 1.5 }),
    downLight([28, 3.5, 4], 0xd6ecff, 30, 10, { size: [1.4, 0.5], glow: 1.5 }),
  ],
  bake: {
    ambientUp: 0x8a98ac, ambientDown: 0x4a505c, ambient: 0.16,
    sky: null,
    ao: { radius: 2.6, strength: 0.85 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: true,
    texel: 0.45,
  },
  sun: { dir: norm([0.3, 0.9, 0.3]), color: 0xfff0dc, intensity: 1.6, mapScale: 0.1 },
  hemi: { sky: 0xb8d0e8, ground: 0x3a3e46, intensity: 0.5, mapScale: 0.1 },
  fill: { dir: norm([-0.5, 0.3, -0.6]), color: 0x6fe0ff, intensity: 0.45, mapScale: 0.2 },
  env: { intensity: 0.35, mapScale: 0.55 },
  worldSaturation: 0.82,
  exposure: 1.05,
  fog: { color: 0x0a0e12, near: 40, far: 200 },
  background: 0x06080a,
  sky: { mode: 'interior', top: 0x06080a, horizon: 0x06080a },
};

// Yellow/black dashed ring on the floor around a box footprint.
function hazardRing(b: AABB, gap: number, w: number): Inlay[] {
  const out: Inlay[] = [];
  const x0 = b.min.x - gap - w;
  const x1 = b.max.x + gap + w;
  const z0 = b.min.z - gap - w;
  const z1 = b.max.z + gap + w;
  const dash = 0.6;
  const y0 = 0;
  const y1 = 0.004;
  let k = 0;
  for (let x = x0; x < x1 - 1e-3; x += dash, k++) {
    const e = Math.min(x + dash, x1);
    const color = k % 2 ? 0x1a1a1a : 0xc9a227;
    out.push({ min: [x, y0, z0], max: [e, y1, z0 + w], color });
    out.push({ min: [x, y0, z1 - w], max: [e, y1, z1], color });
  }
  k = 0;
  for (let z = z0 + w; z < z1 - w - 1e-3; z += dash, k++) {
    const e = Math.min(z + dash, z1 - w);
    const color = k % 2 ? 0xc9a227 : 0x1a1a1a;
    out.push({ min: [x0, y0, z], max: [x0 + w, y1, e], color });
    out.push({ min: [x1 - w, y0, z], max: [x1, y1, e], color });
  }
  return out;
}

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
    slot: 'platform', tint: 0x8a6a50,
    baseboard: { h: 0.9, d: 0.1 },
    band: { y: 3.2, h: 0.3, d: 0.1 },
    crown: { h: 0.8, d: 0.14 },
    pilasters: { spacing: 12, w: 0.9, d: 0.1 },
    edges: { h: 0.14, d: 0.03 },
  },
  lights: [
    // the giant lamp: shade glow + a big warm pool under the perch
    downLight([0, 9.5, 0], 0xffc27a, 420, 36, { size: [3.6, 3.6], angle: 1.25, radius: 1.0, glow: 2.4 }),
    { at: [0, 10.1, 0], face: '+y', size: [0.01, 0.01], color: 0xffb266, intensity: 90, range: 14, out: 1.2, fixture: false },
    ...pillarBand(box(-2, 9.5, -2, 2, 10.1, 2), 9.8, 0.4, 0xffc27a, 2.0),
    // sconces above the book shelf: warm scallops up and down the wallpaper
    ...[-12, 0, 12].flatMap((z) => [
      sconce([-28, 8.5, z], '+x', LAMP, 130, 18, 2.2),
      sconce([28, 8.5, z], '-x', LAMP, 130, 18, 2.2),
    ]),
    sconce([-16, 8.5, -20], '+z', LAMP, 130, 18, 2.2),
    sconce([16, 8.5, -20], '+z', LAMP, 130, 18, 2.2),
    ...[-14, 0, 14].map((x) => sconce([x, 8.5, 20], '-z', LAMP, 130, 18, 2.2)),
    // under-shelf downlights
    ...[-14, 0, 14].flatMap((z) => [
      downLight([-26, 5, z], 0xffa850, 26, 9, { size: [1.6, 0.6], glow: 1.8 }),
      downLight([26, 5, z], 0xffa850, 26, 9, { size: [1.6, 0.6], glow: 1.8 }),
    ]),
    // moonlit window on the north wall (3×2 panes in a frame): cool counter-light
    ...[-3, 0, 3].flatMap((x): LightDef[] => [10.5, 13.5].map((y): LightDef => ({
      at: [x, y, -20], face: '+z', size: [2.7, 2.7], color: 0x7c9ad8, intensity: 0, range: 1, glow: 1.25,
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
    ao: { radius: 2.8, strength: 0.85 },
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
const SODIUM = 0xffb050;
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
const DUSK: WorldTheme = {
  id: 'dusk',
  openSky: true,
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
    slot: 'wall', tint: 0x9a948a,
    crown: { h: 0.6, d: 0.14 },
    pilasters: { spacing: 8, w: 1.0, d: 0.14, top: 16 },
    baseboard: { h: 0.35, d: 0.08 },
  },
  inlays: [
    // road centre line + kerb lines
    ...dashes(0, -21, 21, 2.2, 1.4, 0.18, 0xd6b24a),
    { min: [-13.2, 0, -21], max: [-13, 0.004, 21], color: 0xcfcac0 },
    { min: [13, 0, -21], max: [13.2, 0.004, 21], color: 0xcfcac0 },
  ],
  lights: [
    // porch + balcony lights
    downLight([-22.5, 3.6, 2], 0xffc070, 45, 11, { size: [1, 1] }),
    downLight([22.5, 3.6, 2], 0xffc070, 45, 11, { size: [1, 1] }),
    downLight([-23, 6.5, 0], 0xffc070, 30, 9, { size: [0.8, 0.8] }),
    downLight([23, 6.5, 0], 0xffc070, 30, 9, { size: [0.8, 0.8] }),
    // sodium street lamps on the boundary wall
    ...[-10, 10].flatMap((x) => [
      wallLamp([x, 7, -21], '+z', SODIUM, 220, 26, { size: [0.9, 0.5], down: 1.0, angle: 1.0, radius: 0.4 }),
      wallLamp([x, 7, 21], '-z', SODIUM, 220, 26, { size: [0.9, 0.5], down: 1.0, angle: 1.0, radius: 0.4 }),
    ]),
  ],
  bake: {
    ambientUp: 0x8a7a88, ambientDown: 0x5a4a44, ambient: 0.2,
    sky: { color: 0x6f86c0, intensity: 0.55 },
    ao: { radius: 2.4, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.4,
  },
  sun: { dir: norm([-0.72, 0.42, 0.55]), color: 0xffa860, intensity: 2.7, mapScale: 1.0 },
  hemi: { sky: 0x8a9ad0, ground: 0x4a3a34, intensity: 0.55, mapScale: 0.15 },
  fill: { dir: norm([0.6, 0.35, -0.6]), color: 0x7f96d8, intensity: 0.4, mapScale: 0.3 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.86,
  exposure: 1.0,
  fog: { color: 0x5a4450, near: 50, far: 280 },
  background: 0x2a2440,
  sky: {
    mode: 'dusk', top: 0x1a2350, mid: 0x6a4c7c, horizon: 0xf0925a, ground: 0x2a2030,
    sunColor: 0xffd2a0, sunSize: 0.035, sunGlow: 1.0,
  },
};

function dashes(x: number, z0: number, z1: number, len: number, gap: number, w: number, color: number): Inlay[] {
  const out: Inlay[] = [];
  for (let z = z0 + gap / 2; z + len <= z1; z += len + gap) {
    out.push({ min: [x - w / 2, 0, z], max: [x + w / 2, 0.004, z + len], color });
  }
  return out;
}

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
const NIGHTPORT: WorldTheme = {
  id: 'nightport',
  openSky: true,
  slots: {
    ...METAL,
    floor: { metalness: 0.1, normalScale: 0.6, ao: 0.6 },
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
    slot: 'tower', tint: 0x8a8a8a,
    crown: { h: 0.5, d: 0.12 },
    pilasters: { spacing: 6.5, w: 0.6, d: 0.14, top: 12 },
    collars: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.4, d: 0.1 },
  },
  inlays: [
    // painted bay outline around the dropbox + lane lines
    ...outline(box(-4.2, 0, -3.7, 4.2, 0, 3.7), 0.18, 0xc9a227),
    { min: [-11.8, 0, -0.09], max: [-10.4, 0.004, 0.09], color: 0xc9a227 },
    { min: [10.4, 0, -0.09], max: [11.8, 0.004, 0.09], color: 0xc9a227 },
  ],
  lights: [
    // sodium floods
    ...[-7, 7].flatMap((x) => [
      wallLamp([x, 10, -10], '+z', 0xff9230, 340, 30, { size: [1.3, 0.7], down: 1.15, angle: 0.95, radius: 0.4 }),
      wallLamp([x, 10, 10], '-z', 0xff9230, 340, 30, { size: [1.3, 0.7], down: 1.15, angle: 0.95, radius: 0.4 }),
    ]),
    // cool work lights (contrast)
    wallLamp([-12, 8, 0], '+x', 0xcfe2ff, 150, 22, { size: [1.0, 0.6], down: 0.9, angle: 0.85 }),
    wallLamp([12, 8, 0], '-x', 0xcfe2ff, 150, 22, { size: [1.0, 0.6], down: 0.9, angle: 0.85 }),
    // red beacon under the crown perch
    downLight([0, 8, 0], 0xff3a2a, 14, 7, { size: [0.8, 0.8], glow: 2.6 }),
  ],
  bake: {
    ambientUp: 0x4a5270, ambientDown: 0x2a2a30, ambient: 0.14,
    sky: { color: 0x2a3a66, intensity: 0.22 },
    ao: { radius: 2.2, strength: 0.85 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.28,
  },
  sun: { dir: norm([0.3, 0.85, -0.4]), color: 0x8fa6ff, intensity: 1.0, mapScale: 0.3 },
  hemi: { sky: 0x6a7ab8, ground: 0x3a2a22, intensity: 0.55, mapScale: 0.12 },
  fill: { dir: norm([-0.5, 0.4, 0.7]), color: 0xffa050, intensity: 0.5, mapScale: 0.2 },
  env: { intensity: 0.3, mapScale: 0.5 },
  worldSaturation: 0.9,
  exposure: 1.1,
  fog: { color: 0x0e0b0c, near: 25, far: 140 },
  background: 0x05060a,
  sky: {
    mode: 'night', top: 0x02040a, horizon: 0x141220, glow: 0x3a2412, stars: 0.6,
  },
};

function outline(b: AABB, w: number, color: number): Inlay[] {
  const y1 = 0.004;
  return [
    { min: [b.min.x, 0, b.min.z], max: [b.max.x, y1, b.min.z + w], color },
    { min: [b.min.x, 0, b.max.z - w], max: [b.max.x, y1, b.max.z], color },
    { min: [b.min.x, 0, b.min.z + w], max: [b.min.x + w, y1, b.max.z - w], color },
    { min: [b.max.x - w, 0, b.min.z + w], max: [b.max.x, y1, b.max.z - w], color },
  ];
}

// ── Derrick → rust at dusk ─────────────────────────────────────────────────
const DERRICK_DECKS = new Set([7, 8, 9, 10, 11]);
const DERRICK_GENS = new Set([12, 13]);
const RUSTDUSK: WorldTheme = {
  id: 'rustdusk',
  openSky: true,
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
  trim: { color: 0xff8a3c, intensity: 1.7 },
  dress: {
    slot: 'tower', tint: 0x8a7a70,
    crown: { h: 0.6, d: 0.12 },
    collars: { h: 0.6, d: 0.12 },
    baseboard: { h: 0.45, d: 0.1 },
    band: { y: 11, h: 0.4, d: 0.1 },
    edges: { h: 0.12, d: 0.03 },
  },
  inlays: [...hazardRing(box(-2, 0, -2, 2, 11, 2), 0.9, 0.45)],
  lights: [
    downLight([5.5, 5, 0], 0xffb060, 50, 12, { size: [1.2, 0.8] }),
    downLight([-5.5, 5, 0], 0xffb060, 50, 12, { size: [1.2, 0.8] }),
    downLight([0, 8, 5.5], 0xffb060, 50, 12, { size: [0.8, 1.2] }),
    downLight([0, 8, -5.5], 0xffb060, 50, 12, { size: [0.8, 1.2] }),
    { at: [0, 11.5, 0], face: '+y', size: [0.01, 0.01], color: 0xff4030, intensity: 22, range: 9, out: 1.0, fixture: false },
    ...pillarBand(box(-3, 11, -3, 3, 11.5, 3), 11.25, 0.25, 0xff4030, 2.4),
    wallLamp([-8, 1.5, 5], '-z', 0xffa030, 12, 6, { size: [0.7, 0.35], down: 0.3, angle: 1.2, out: 0.3, glow: 2.4 }),
    wallLamp([8, 1.5, -5], '+z', 0xffa030, 12, 6, { size: [0.7, 0.35], down: 0.3, angle: 1.2, out: 0.3, glow: 2.4 }),
  ],
  bake: {
    ambientUp: 0x8a6a6a, ambientDown: 0x4a3430, ambient: 0.2,
    sky: { color: 0x9a7a9a, intensity: 0.5 },
    ao: { radius: 2.2, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.28,
  },
  sun: { dir: norm([0.45, 0.36, -0.82]), color: 0xff8a4a, intensity: 2.6, mapScale: 1.0 },
  hemi: { sky: 0xa08ab0, ground: 0x4a3028, intensity: 0.55, mapScale: 0.15 },
  fill: { dir: norm([-0.5, 0.4, 0.75]), color: 0x8a86c8, intensity: 0.4, mapScale: 0.3 },
  env: { intensity: 0.35, mapScale: 0.6 },
  worldSaturation: 0.85,
  exposure: 1.0,
  fog: { color: 0x4a3028, near: 30, far: 220 },
  background: 0x3a2020,
  sky: {
    mode: 'dusk', top: 0x3a2a4e, mid: 0xb8583e, horizon: 0xff8a40, ground: 0x2a1a18,
    sunColor: 0xffc080, sunSize: 0.045, sunGlow: 1.4, band: 0.5,
  },
};

// ── Training → Lab: clean, bright, neutral (the exception) ─────────────────
const LAB: WorldTheme = {
  id: 'lab',
  openSky: true,
  slots: METAL,
  trim: { color: null, intensity: 1.9 },
  dress: {
    slot: 'tower', tint: 0xd0d4da,
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
