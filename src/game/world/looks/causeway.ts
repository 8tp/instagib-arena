// Look for the 'causeway' arena: "Void" — a lit station complex floating in
// deep space (Longest Yard / Morpheus flavour).
//
// Identity: pale ceramic decks and violet-slate bastions under a strong,
// cool-white key from a nebula sky; black fluted obsidian monoliths with
// glowing collars are the landmarks. Colour-coding orients you in a
// symmetric map: the EAST lobe is lit cyan, the WEST lobe magenta; the NORTH
// gate is warm gold, the SOUTH gate ice-white; the Crown (apex) is gold.
// Jump-steps and crates are gunmetal with glowing nosing strips in the local
// colour — "climb here" reads from across the map.
import {
  FACE_NORMAL, band4, defaultSlot, downLight, norm, prop, wallLamp,
  type Face, type Inlay, type LightDef, type SkyProp, type WorldTheme,
} from '../theme-kit';
import { R, bake, corrugationField, panel, panelField, unusedCeiling } from '../../textures';
import { CAUSEWAY } from '../../maps/causeway';
import type { MapBox } from '../../maps/kit';

// ── surfaces ───────────────────────────────────────────────────────────────
const TEXTURES: WorldTheme['textures'] = {
  // Pit deck: cool slate 2 m plates with a hairline inset. Mid value, quiet.
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 1, bevel: 1.5, depth: 1.5, inset: 7, rivets: 'none', wobble: 0.4, seed: 211 }),
    {
      base: 0x5d6376, seamDark: 0.8, lineTint: 0.95, toneNoise: 0.03, grain: 0.01,
      rough: { base: 0.55, seam: 0.2, centre: 0.1, blotch: 0.05, grain: 0.02 },
      ao: 0.45, aoBlur: 4, seed: 212,
    },
    8,
  ),
  // Bastion hull (keeps, gates, pod hulls, rim): violet slate, 2 m-tall courses.
  wall: () => panel(0x74688e, 4, {
    cols: 1, rows: 2, seamHalf: 1.5, bevel: 2.5, depth: 3, inset: 10, rivets: 'none',
    rough: 0.55, tone: 0.03, grain: 0.01, seed: 223,
  }),
  ceiling: unusedCeiling,
  // Decks (islands, causeways, hub, Crown): pale ceramic 2 m plates, small
  // corner studs. The lightest surface in the map — landing zones read.
  platform: () => bake(
    panelField({
      size: R, cols: 2, rows: 2, seamHalf: 1, bevel: 1.8, depth: 1.8, inset: 13,
      rivets: 'corners', rivetInset: 22, rivetR: 2, rivetH: 0.8, wobble: 0.3, seed: 241,
    }),
    {
      base: 0xb8b6b4, seamDark: 0.62, lineTint: 0.9, rivetLight: 0.1, toneNoise: 0.025, grain: 0.01,
      rough: { base: 0.45, seam: 0.3, centre: 0.1, rivet: 0.1, blotch: 0.05, grain: 0.02 },
      ao: 0.7, aoBlur: 3, seed: 242,
    },
    4,
  ),
  // Jump-steps + crates: gunmetal plate (their glowing nosing strips, below,
  // are what reads as "climb here").
  cover: () => panel(0x5a5e72, 2, { cols: 1, rows: 1, bevel: 3, depth: 3, inset: 12, rough: 0.42, tone: 0.025, grain: 0.01, seed: 253 }),
  // Monoliths, pylons, spire: black fluted obsidian (glossy).
  tower: () => bake(
    corrugationField({ size: R, ribs: 4, depth: 5, frame: 0, frameDepth: 0, wobble: 0.3, seed: 267 }),
    {
      base: 0x3e3c56, seamDark: 0.8, toneNoise: 0.02, grain: 0.008,
      rough: { base: 0.3, seam: 0.12, centre: 0, blotch: 0.04, grain: 0.015 },
      ao: 0.45, aoBlur: 6, seed: 268,
    },
    2,
  ),
};

// ── palette ────────────────────────────────────────────────────────────────
const CYAN = 0x72d6ff; // east lobe
const MAGENTA = 0xd67cff; // west lobe
const GOLD = 0xffc47a; // north gate + Crown
const ICE = 0xcfe6ff; // south gate
const RIM = 0x6f86ff; // perimeter strips
const lobe = (sx: number) => (sx > 0 ? CYAN : MAGENTA);
const gate = (sz: number) => (sz < 0 ? GOLD : ICE); // −z is north (yaw 0 looks there)

// Mirror a light authored for the +x/+z quadrant into (sx, sz).
function flip(face: Face, sx: number, sz: number): Face {
  if (face[1] === 'x' && sx < 0) return face[0] === '+' ? '-x' : '+x';
  if (face[1] === 'z' && sz < 0) return face[0] === '+' ? '-z' : '+z';
  return face;
}
function mirror(l: LightDef, sx: number, sz: number): LightDef {
  return {
    ...l,
    at: [l.at[0] * sx, l.at[1], l.at[2] * sz],
    face: flip(l.face, sx, sz),
    ...(l.spot ? { spot: { ...l.spot, dir: [l.spot.dir[0] * sx, l.spot.dir[1], l.spot.dir[2] * sz] } } : {}),
  };
}
const QUADS: Array<[number, number]> = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
const quad = (f: (sx: number, sz: number) => LightDef[]): LightDef[] =>
  QUADS.flatMap(([sx, sz]) => f(sx, sz).map((l) => mirror(l, sx, sz)));
const alongX = (f: (sx: number) => LightDef[]): LightDef[] => [1, -1].flatMap((sx) => f(sx).map((l) => mirror(l, sx, 1)));
const alongZ = (f: (sz: number) => LightDef[]): LightDef[] => [1, -1].flatMap((sz) => f(sz).map((l) => mirror(l, 1, sz)));

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({
  min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 },
});

const LIGHTS: LightDef[] = [
  // ── per quadrant ──
  ...quad((sx, sz) => [
    // pod under the island: two downlights + a lamp on the back hull
    downLight([28, 5, 23.5], lobe(sx), 90, 15, { size: [2.4, 0.8] }),
    // causeway underside → the pit below
    downLight([12.5, 5.4, 24], gate(sz), 45, 11, { size: [1.4, 0.6] }),
    // rim alley: lamp on the pod hull's outer face
    wallLamp([38, 3.6, 25.5], '+x', RIM, 60, 13, { size: [0.9, 0.5] }),
    // pylon: glowing collar under the top + a beacon on it
    ...band4(box(11.25, 0, 3.5, 13.75, 14, 6), 13.3, 0.45, lobe(sx)),
    ...band4(box(11.25, 0, 3.5, 13.75, 14, 6), 0.8, 0.16, lobe(sx), 0.6),
    { at: [12.5, 14, 4.75], face: '+y', size: [1.2, 1.2], color: lobe(sx), intensity: 150, range: 24, out: 0.9, radius: 0.5 },
    // lobe monolith: collar + beacon
    ...band4(box(23, 0, 8.5, 25, 12, 11.5), 11.3, 0.45, lobe(sx)),
    { at: [24, 12, 10], face: '+y', size: [1.0, 1.6], color: lobe(sx), intensity: 130, range: 22, out: 0.9, radius: 0.5 },
    // keep: flood lamp on the lobe face, over the tunnel mouth
    wallLamp([34, 8.6, 4.5], '-x', lobe(sx), 190, 28, { size: [1.4, 0.6], down: 0.8, angle: 1.05 }),
    // hub underside → dais
    downLight([5.5, 9.5, 3.8], lobe(sx), 60, 13, { size: [1.2, 1.2] }),
    // Crown underside → hub deck
    downLight([3.4, 16.8, 3.4], GOLD, 70, 13, { size: [1.0, 1.0] }),
  ]),
  // ── E / W keeps + spine ──
  ...alongX((sx) => [
    downLight([39, 4.5, 0], lobe(sx), 55, 11, { size: [2.4, 0.6] }), // tunnel
    downLight([25, 9.9, 0], lobe(sx), 70, 14, { size: [2.4, 0.8] }), // spine underside
  ]),
  // ── N / S gates ──
  ...alongZ((sz) => [
    downLight([0, 3.6, 24], gate(sz), 50, 10, { size: [0.8, 2.4] }), // archway
    wallLamp([3.5, 4.6, 20], '-z', gate(sz), 110, 20, { size: [1.2, 0.5] }),
    wallLamp([-3.5, 4.6, 20], '-z', gate(sz), 110, 20, { size: [1.2, 0.5] }),
    downLight([0, 5.4, 16], gate(sz), 40, 10, { size: [0.8, 1.6] }), // spoke underside
  ]),
  // ── spire bands ──
  ...band4(box(-2, 2.4, -2, 2, 9.5, 2), 8.9, 0.4, GOLD),
  ...band4(box(-2, 10.5, -2, 2, 16.8, 2), 16.2, 0.4, GOLD),
  ...band4(box(-2, 2.4, -2, 2, 9.5, 2), 3.0, 0.16, GOLD, 0.6),
  // ── rim strips on the perimeter walls (below the sky line) ──
  ...[-30, -10, 10, 30].flatMap((x): LightDef[] => [
    { at: [x, 1.3, -35], face: '+z', size: [3.0, 0.22], color: RIM, intensity: 22, range: 9, out: 0.6, radius: 0.4, kind: 'strip', level: 0.8 },
    { at: [x, 1.3, 35], face: '-z', size: [3.0, 0.22], color: RIM, intensity: 22, range: 9, out: 0.6, radius: 0.4, kind: 'strip', level: 0.8 },
  ]),
  ...[-20, 20].flatMap((z): LightDef[] => [
    { at: [-47, 1.3, z], face: '+x', size: [3.0, 0.22], color: RIM, intensity: 22, range: 9, out: 0.6, radius: 0.4, kind: 'strip', level: 0.8 },
    { at: [47, 1.3, z], face: '-x', size: [3.0, 0.22], color: RIM, intensity: 22, range: 9, out: 0.6, radius: 0.4, kind: 'strip', level: 0.8 },
  ]),
];

// Floor paint: glowing lane lines under the spokes/spine (point you at the
// centre), a ring around the dais.
const INLAYS: Inlay[] = [
  { min: [-0.15, 0, 8], max: [0.15, 0, 19.5], color: ICE, glow: 0.5 },
  { min: [-0.15, 0, -19.5], max: [0.15, 0, -8], color: GOLD, glow: 0.5 },
  { min: [8.5, 0, -0.15], max: [33.5, 0, 0.15], color: CYAN, glow: 0.5 },
  { min: [-33.5, 0, -0.15], max: [-8.5, 0, 0.15], color: MAGENTA, glow: 0.5 },
];

// Far debris: other decks floating out in the void (render-only, unlit):
// a dark hull, a paler lit top and a glowing rim in a lobe colour.
function debris(): SkyProp[] {
  const out: SkyProp[] = [];
  const bits: Array<[number, number, number, number, number, number, number]> = [
    // x, z, w, d, y0, y1, rim colour — far out and below the deck
    [-125, -80, 30, 16, -34, -31, CYAN],
    [140, 70, 34, 20, -28, -25, MAGENTA],
    [110, -130, 18, 18, -46, -43, GOLD],
    [-95, 135, 22, 14, -40, -37, MAGENTA],
    [-170, 30, 18, 36, -22, -20, CYAN],
    [175, -40, 16, 24, -18, -16, ICE],
    [30, 170, 40, 14, -30, -28, GOLD],
    [-40, -170, 24, 24, -24, -21, ICE],
  ];
  for (const [x, z, w, d, y0, y1, rim] of bits) {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const r = 0.35; // rim band
    out.push(prop(x0, y0, z0, x1, y1 - 0.4, z1, 0x34324c));
    out.push(prop(x0 + r, y1 - 0.4, z0 + r, x1 - r, y1, z1 - r, 0x8e8ca8, rim));
    out.push(prop(x0, y1 - 0.4, z0, x1, y1 - 0.05, z0 + r, rim));
    out.push(prop(x0, y1 - 0.4, z1 - r, x1, y1 - 0.05, z1, rim));
    out.push(prop(x0, y1 - 0.4, z0 + r, x0 + r, y1 - 0.05, z1 - r, rim));
    out.push(prop(x1 - r, y1 - 0.4, z0 + r, x1, y1 - 0.05, z1 - r, rim));
  }
  return out;
}

// Glowing nosing strips on every exposed vertical face of the jump-steps and
// crates, just under the top edge (fixture-only, no baked light): lobe colour
// in the lobes, gate colour on the gate/spoke stairs.
function nosing(): LightDef[] {
  const boxes = CAUSEWAY.boxes;
  const out: LightDef[] = [];
  const inside = (x: number, y: number, z: number, self: MapBox) =>
    boxes.some((o) => o !== self && x > o.min.x && x < o.max.x && y > o.min.y && y < o.max.y && z > o.min.z && z < o.max.z);
  for (const b of boxes) {
    if (b.tag !== 'steps' && b.tag !== 'crate') continue;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    const y = b.max.y - 0.3;
    const color = Math.abs(cx) < 6 && Math.abs(cz) > 5 ? gate(Math.sign(cz)) : lobe(Math.sign(cx));
    const faces: Array<[Face, number, number, number]> = [
      ['+x', b.max.x, cz, sz], ['-x', b.min.x, cz, sz], ['+z', cx, b.max.z, sx], ['-z', cx, b.min.z, sx],
    ];
    for (const [face, px, pz, len] of faces) {
      const n = FACE_NORMAL[face];
      if (inside(px + n[0] * 0.05, y, pz + n[2] * 0.05, b)) continue;
      out.push({ at: [px, y, pz], face, size: [Math.max(0.3, len - 0.3), 0.12], color, intensity: 0, range: 1, kind: 'strip', level: 0.75 });
    }
  }
  return out;
}

// Tags → slots.
const DECK = new Set(['island', 'causeway', 'spoke', 'spine', 'hub', 'crown', 'dais']);
const HULL = new Set(['keep', 'gate', 'hull', 'baffle']);
const STONE = new Set(['pylon', 'monolith', 'spire']);
const STEP = new Set(['steps', 'crate']);

export const VOID: WorldTheme = {
  id: 'void',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 2.4,
  slots: {
    floor: { metalness: 0.15, normalScale: 0.7, ao: 0.7 },
    ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
    wall: { metalness: 0.15, normalScale: 0.8, ao: 0.7 },
    cover: { metalness: 0.2, normalScale: 0.8, ao: 0.7 },
    platform: { metalness: 0.1, normalScale: 0.75, ao: 0.75 },
    tower: { metalness: 0.45, normalScale: 0.9, ao: 0.6 },
  },
  slotFor: (i, b, k) => {
    const t = b.tag ?? '';
    if (DECK.has(t)) return 'platform';
    if (HULL.has(t)) return 'wall';
    if (STONE.has(t)) return 'tower';
    if (STEP.has(t)) return 'cover';
    return defaultSlot(i, b, k);
  },
  tintFor: (_i, b) => {
    const cx = (b.min.x + b.max.x) / 2;
    switch (b.tag) {
      case 'crown': return 0xfff4e2;
      case 'keep': return cx > 0 ? 0xdcecff : 0xf6e2ff;
      case 'island': return cx > 0 ? 0xeef6ff : 0xfaf0ff;
      default: return null;
    }
  },
  trim: { color: 0x9c8cff, intensity: 1.2 },
  dress: {
    slot: 'platform', tint: 0xe6e4ee,
    baseboard: { h: 0.35, d: 0.08 },
    crown: { h: 0.3, d: 0.12 },
    collars: { h: 0.5, d: 0.1 },
    edges: { h: 0.14, d: 0.03 },
  },
  inlays: INLAYS,
  skyline: debris(),
  lights: [...LIGHTS, ...nosing()],
  bake: {
    ambientUp: 0x9a9cb8, ambientDown: 0x7a7490, ambient: 0.32,
    sky: { color: 0x9a98d0, intensity: 0.5 },
    ao: { radius: 2.6, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.5,
    maxTexels: 120_000,
  },
  sun: { dir: norm([-0.4, 0.8, 0.45]), color: 0xfff6ee, intensity: 2.5, mapScale: 0.9 },
  hemi: { sky: 0xb0b2d8, ground: 0x3e3a48, intensity: 0.6, mapScale: 0.2 },
  fill: { dir: norm([0.6, 0.3, -0.7]), color: 0x9fd8ff, intensity: 0.5, mapScale: 0.35 },
  env: { intensity: 0.4, mapScale: 0.6 },
  worldSaturation: 0.85,
  shadowBox: 90,
  exposure: 1.05,
  fog: { color: 0x1a1430, near: 90, far: 360 },
  background: 0x07061a,
  sky: {
    mode: 'space', top: 0x05041a, horizon: 0x1c1440, nebula: [0x6a36c4, 0x2a62c8, 0xd0508e], stars: 1,
  },
};
