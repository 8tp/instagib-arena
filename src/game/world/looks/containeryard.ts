// Look for the 'containeryard' arena: a floodlit night container terminal.
//
// Identity: painted container steel under sodium floods and a cool-white
// gantry crane. Colour-blocking tells the halves apart — the west yard is
// rust / orange / sand, the east yard is blue / green / steel — while the
// crane in the middle is terminal yellow. Concrete pavement with painted
// lane lines, timber crates, pale warehouse cladding. The key is the warm
// flood pools; the moon is a cool, readable fill (never a cave).
import {
  FACE_NORMAL, METAL, band4, defaultSlot, downLight, mast, norm, prop, sconce, wallLamp,
  type Inlay, type LightDef, type SkyProp, type WorldTheme,
} from '../theme-kit';
import { R, bake, corrugationField, gratingField, panel, panelField, planksField } from '../../textures';
import { B, type MapBox } from '../../maps/kit';
import type { SurfaceKind } from '../../textures';

const TEXTURES: WorldTheme['textures'] = {
  // Poured concrete pavement: 3 m slabs, quiet, mid-grey (the floor is where
  // enemies are read).
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 1, bevel: 1.5, depth: 2, rivets: 'none', wobble: 0.6, seed: 19 }),
    {
      base: 0x7e848c, seamDark: 0.6, toneNoise: 0.05, grain: 0.03,
      rough: { base: 0.78, seam: 0.15, centre: 0.04, blotch: 0.08, grain: 0.04 },
      ao: 0.6, aoBlur: 4, seed: 20,
      stain: { color: 0x656a72, amount: 0.25, cell: 90, bias: 0.14, rough: -0.2, seed: 21 },
    },
    6,
  ),
  // Warehouse cladding: tall 1 m standing-seam sheets, pale.
  wall: () => panel(0xa9aca8, 4, {
    cols: 4, rows: 1, seamHalf: 1.2, bevel: 2, depth: 2.5, rivets: 'none',
    rough: 0.6, tone: 0.04, grain: 0.015, seed: 31,
    stain: { color: 0x7d7b74, amount: 0.25, cell: 64, bias: 0.18, rough: 0.05, seed: 32 },
  }),
  // Never drawn (open sky) → repurposed as the timber-crate slot.
  ceiling: () => bake(
    planksField({ size: R, rows: 5, segs: 0, gap: 2, bevel: 2.5, depth: 3, grain: 1.0, tone: 0.07, seed: 41 }),
    {
      base: 0xa77f55, seamDark: 0.55, toneNoise: 0.04, grain: 0.02,
      rough: { base: 0.72, seam: 0.15, centre: 0, blotch: 0.06, grain: 0.03 },
      ao: 0.7, aoBlur: 3, seed: 42,
    },
    1.3,
  ),
  // Steel grating: gangways, mezzanine, crane deck.
  platform: () => bake(
    gratingField({ size: R, pitch: 16, bar: 2.2, cross: 48, rod: 1.6, depth: 5, frame: 5, seed: 48 }),
    {
      base: 0x8a9099, seamDark: 0.55, toneNoise: 0.03, grain: 0.02,
      rough: { base: 0.48, seam: 0.3, centre: 0, blotch: 0.06, grain: 0.03 },
      ao: 0.8, aoBlur: 3, seed: 49,
    },
    1.5,
  ),
  // Container skin: trapezoid corrugation, rails every 2.6 m so the frame
  // lines land on the tier joins. Near-white base — the box tint is the paint.
  cover: () => bake(
    corrugationField({ size: 512, ribs: 12, depth: 6, frame: 14, frameDepth: 8, wobble: 0.6, seed: 59 }),
    {
      base: 0xd2d0cc, seamDark: 0.74, toneNoise: 0.04, grain: 0.015,
      rough: { base: 0.55, seam: 0.1, centre: 0, blotch: 0.08, grain: 0.03 },
      ao: 0.55, aoBlur: 5, seed: 60,
      stain: { color: 0x6a5a50, amount: 0.1, cell: 40, bias: 0.22, rough: 0.15, seed: 61 },
    },
    2.6,
  ),
  // Crane steel: plates with riveted bands (tinted terminal yellow).
  tower: () => panel(0xdedcd8, 4, { cols: 1, rows: 1, seamHalf: 1, bevel: 1.5, depth: 1.5, rivets: 'bands', rivetInset: 8, rivetR: 2, rivetH: 1, rough: 0.45, seamDark: 0.7, seed: 73 }),
};

// ── paint ──────────────────────────────────────────────────────────────────
// Colour-blocking by ZONE (gameplay is 180° symmetric, the paint doesn't have
// to be): the north quay lane is red, the south quay lane blue, the west
// apron orange, the east apron green; the crane in the middle is safety
// yellow. c-a is the zone colour, c-b its darker shade, c-c a white accent.
type Family = Record<'c-a' | 'c-b' | 'c-c', number>;
const ACCENT = 0xd8d6d0;
const RED: Family = { 'c-a': 0xdc3222, 'c-b': 0xa42018, 'c-c': ACCENT };
const BLUE: Family = { 'c-a': 0x2a6ee0, 'c-b': 0x1c4ca8, 'c-c': ACCENT };
const ORANGE: Family = { 'c-a': 0xee6a0e, 'c-b': 0xb0460a, 'c-c': ACCENT };
const GREEN: Family = { 'c-a': 0x22b454, 'c-b': 0x168044, 'c-c': ACCENT };
const CRANE = 0xffc000;

const cxOf = (b: MapBox) => (b.min.x + b.max.x) / 2;
const czOf = (b: MapBox) => (b.min.z + b.max.z) / 2;
function familyOf(b: MapBox): Family {
  const z = czOf(b);
  if (z < -12) return RED;
  if (z > 12) return BLUE;
  return cxOf(b) < 0 ? ORANGE : GREEN;
}

function slotFor(i: number, b: MapBox, k: SurfaceKind): SurfaceKind {
  switch (b.tag) {
    case 'c-a':
    case 'c-b':
    case 'c-c':
    case 'cab':
      return 'cover';
    case 'crate':
      return 'ceiling';
    case 'shed':
    case 'roof':
      return 'wall';
    case 'deck':
    case 'gangway':
      return 'platform';
    case 'crane':
    case 'bogie':
      return 'tower';
    default:
      return defaultSlot(i, b, k);
  }
}

function tintFor(_i: number, b: MapBox): number | null {
  const t = b.tag;
  if (!t) return null;
  if (t === 'c-a' || t === 'c-b' || t === 'c-c') {
    // the crossed dropbox under the crane (self-symmetric): white + yellow
    if (Math.abs(cxOf(b)) < 0.5 && Math.abs(czOf(b)) < 0.5) return t === 'c-a' ? ACCENT : 0xe0a000;
    return familyOf(b)[t];
  }
  if (t === 'crane') return CRANE;
  if (t === 'cab') return 0x50565e; // corrugated machine house
  if (t === 'bogie') return 0x3c4046;
  if (t === 'shed') return cxOf(b) < 0 ? 0xe6dccc : 0xd4dce6;
  if (t === 'roof') return 0x8a8e94;
  return null;
}

// ── lights (west half authored; the 180° twin is generated) ────────────────
const SODIUM = 0xff9838; // yard floods: warm pools
const LED = 0xd8e6ff; // crane + stack work lights: cool
const HALL = 0xffd9a8;

const ROT_FACE: Record<LightDef['face'], LightDef['face']> = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z', '+y': '+y', '-y': '-y' };
function twin(l: LightDef): LightDef {
  return {
    ...l,
    at: [-l.at[0], l.at[1], -l.at[2]],
    face: ROT_FACE[l.face],
    spot: l.spot ? { ...l.spot, dir: [-l.spot.dir[0], l.spot.dir[1], -l.spot.dir[2]] } : undefined,
  };
}
const both = (ls: LightDef[]): LightDef[] => [...ls, ...ls.map(twin)];

type V = [number, number, number];
// Flood head on a mast outside the fence, aimed at a floor point with a tight
// cone: a real pool with falloff instead of an even wash.
function flood(at: V, face: LightDef['face'], target: V, intensity: number, angle = 0.36): LightDef {
  const n = FACE_NORMAL[face];
  const out = 0.7;
  const p: V = [at[0] + n[0] * out, at[1] + n[1] * out, at[2] + n[2] * out];
  const range = Math.hypot(target[0] - p[0], target[1] - p[1], target[2] - p[2]) + 14;
  return {
    at, face, size: [1.6, 0.8], color: SODIUM, intensity, range, out, radius: 0.5, free: true, level: 1.1,
    spot: { dir: norm([target[0] - p[0], target[1] - p[1], target[2] - p[2]]), angle, penumbra: 0.45 },
  };
}
// Up-light on a bogie top grazing the crane leg (the crane reads lit).
function upLight(at: V, lean: V, intensity: number): LightDef {
  return {
    at, face: '+y', size: [0.5, 0.5], color: LED, intensity, range: 16, out: 0.25, radius: 0.15,
    spot: { dir: norm(lean), angle: 0.32, penumbra: 0.5 },
  };
}

// Mast heads (west-authored) and the floor spot each one pools on.
const MASTS: Array<{ at: V; face: LightDef['face']; target: V; i: number }> = [
  { at: [-18, 18, -29.8], face: '+z', target: [-16, 0, -22.5], i: 950 }, // north lane, west end
  { at: [-2, 18, -29.8], face: '+z', target: [-9, 0, -21.5], i: 950 }, // north lane, by the cross alley
  { at: [-20, 18, 29.8], face: '-z', target: [-20, 0, 22.5], i: 950 }, // south lane, west end
  { at: [-6, 18, 29.8], face: '-z', target: [-8, 0, 12.5], i: 1300 }, // south inner lane
  { at: [-35, 21, 0], face: '+x', target: [-14.5, 0, 0], i: 1500 }, // apron, over the roof
  { at: [-35, 17, -21], face: '+x', target: [-28, 0, -23.5], i: 700 }, // stair yard
];

const WEST_LIGHTS: LightDef[] = [
  ...MASTS.map((m) => flood(m.at, m.face, m.target, m.i)),
  // gantry: cool floods under the west girder + up-lights grazing its legs
  downLight([-6.5, 13.2, -5], LED, 380, 20, { size: [1.0, 0.6], angle: 0.5 }),
  downLight([-6.5, 13.2, 5], LED, 380, 20, { size: [1.0, 0.6], angle: 0.5 }),
  upLight([-6.5, 1.2, -10.35], [0, 1, 0.1], 140),
  upLight([-6.5, 1.2, 10.35], [0, 1, -0.1], 140),
  // amber marker bands high on the legs (fixture only)
  ...band4(B(-7.1, 0, -9.6, -5.9, 13.2, -8.4), 12.4, 0.16, 0xffa020, 1.0),
  ...band4(B(-7.1, 0, 8.4, -5.9, 13.2, 9.6), 12.4, 0.16, 0xffa020, 1.0),
  // warehouse hall
  downLight([-28, 7.2, -7], HALL, 170, 15, { size: [1.6, 0.5], angle: 1.2 }),
  downLight([-28, 7.2, 0], HALL, 170, 15, { size: [1.6, 0.5], angle: 1.2 }),
  downLight([-28, 7.2, 7], HALL, 170, 15, { size: [1.6, 0.5], angle: 1.2 }),
  // hall sconces: wash the upper walls so the spawn hall isn't a black box
  sconce([-24.5, 5.6, 0], '-x', HALL, 70, 11),
  sconce([-32.5, 5.8, 7], '+x', HALL, 70, 11),
  sconce([-32.5, 6.2, -7], '+x', HALL, 60, 10),
  // wall packs over the yard doors and the side doors
  wallLamp([-24, 6.1, -4.5], '+x', SODIUM, 70, 14, { size: [0.9, 0.5], down: 1.4, angle: 0.8 }),
  wallLamp([-24, 6.1, 4.5], '+x', SODIUM, 70, 14, { size: [0.9, 0.5], down: 1.4, angle: 0.8 }),
  wallLamp([-26, 5.8, -12.5], '-z', SODIUM, 70, 13, { size: [0.9, 0.5], down: 1.4, angle: 0.8 }),
  wallLamp([-27, 5.8, 12.5], '+z', SODIUM, 70, 13, { size: [0.9, 0.5], down: 1.4, angle: 0.8 }),
  // cool work lamp on the north lane wall (NB2)
  wallLamp([-1, 6.6, -19.5], '-z', LED, 150, 16, { size: [0.9, 0.45], down: 1.3, angle: 0.7 }),
];

const LIGHTS: LightDef[] = [
  ...both(WEST_LIGHTS),
  // trolley deck flood (centre, once) + red aviation beacon on the cab
  downLight([0, 13.4, 0], LED, 260, 20, { size: [1.2, 0.8], angle: 0.6 }),
  { at: [0, 15.6, 0], face: '+y', size: [0.4, 0.4], color: 0xff2a1a, intensity: 0, range: 1, kind: 'lamp', level: 1.2 },
];

// ── floor paint ────────────────────────────────────────────────────────────
const YELLOW = 0xd8b23a;
const WHITE = 0xd8d8d0;
function line(x0: number, z0: number, x1: number, z1: number, color: number): Inlay {
  return { min: [Math.min(x0, x1), 0, Math.min(z0, z1)], max: [Math.max(x0, x1), 0, Math.max(z0, z1)], color };
}
function rotInlay(l: Inlay): Inlay {
  return { ...l, min: [-l.max[0], l.min[1], -l.max[2]], max: [-l.min[0], l.max[1], -l.min[2]] };
}
const WEST_INLAYS: Inlay[] = [
  // lane edge lines (north + south quay lanes)
  line(-24, -25.1, -9, -24.95, YELLOW),
  line(-24, 19.95, -9, 20.1, YELLOW),
  // centre dashes in the inner lanes
  ...[-22, -17, -12].map((x) => line(x, -12.35, x + 3, -12.2, WHITE)),
  ...[-22, -17, -12].map((x) => line(x, 12.2, x + 3, 12.35, WHITE)),
  // hazard banding along the crane girder walkways (apex readability)
  { min: [-7.2, 14, -9.6], max: [-6.95, 14, 9.6], color: YELLOW, hazard: true },
  { min: [-5.8, 14, -9.6], max: [5.8, 14, -9.35], color: YELLOW, hazard: true },
  { min: [-5.8, 14, -2.5], max: [5.8, 14, -2.3], color: YELLOW, hazard: true },
  // door aprons: hazard bands in front of the warehouse doors
  { min: [-23.8, 0, -7], max: [-23.2, 0, -2], color: YELLOW, hazard: true },
  { min: [-23.8, 0, 2], max: [-23.2, 0, 7], color: YELLOW, hazard: true },
];
const INLAYS: Inlay[] = [
  ...WEST_INLAYS,
  ...WEST_INLAYS.map(rotInlay),
  // crane rails: two steel strips under the gantry legs
  line(-6.65, -12, -6.35, 12, 0x9ea4aa),
  line(6.35, -12, 6.65, 12, 0x9ea4aa),
  // court box around the dropbox
  line(-4, -4, 4, -3.8, YELLOW),
  line(-4, 3.8, 4, 4, YELLOW),
  line(-4, -3.8, -3.8, 3.8, YELLOW),
  line(3.8, -3.8, 4, 3.8, YELLOW),
];

// ── skyline: the rest of the terminal beyond the fence ─────────────────────
// Unlit, fogged silhouettes (MeshBasic): everything stands on the dark quay
// ground plane or on another prop — nothing floats. Container blocks start
// ≥ 13 m beyond the fence, one prop per container with a near-black seam
// band between tiers and a gap between boxes, in low night values.
const SKY_PAINT = [0x2a1714, 0x141d2a, 0x14221a, 0x2a1e14, 0x1d1f23, 0x26282a];
const SEAM = 0x07080a;
const QUAY = 0x17191d;
const STEEL = 0x1c2026;
const WINDOW = 0x6e5230;

const hash01 = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

// A row of containers along x (12 m boxes, 0.4 m gaps), `z0…z0+2.5`.
function containerRow(out: SkyProp[], x0: number, x1: number, z0: number, seed: number, maxTiers: number) {
  for (let x = x0, k = 0; x + 12 <= x1; x += 12.4, k++) {
    const tiers = 1 + Math.floor(hash01(k, seed) * maxTiers);
    for (let t = 0; t < tiers; t++) {
      const y = t * 2.6;
      const c = SKY_PAINT[Math.floor(hash01(k * 7 + t, seed + 3) * SKY_PAINT.length)];
      out.push(prop(x, y, z0, x + 12, y + 2.45, z0 + 2.5, c));
      // seam band (sits on this container, carries the next one)
      out.push(prop(x + 0.1, y + 2.45, z0 + 0.1, x + 11.9, y + 2.6, z0 + 2.4, SEAM));
    }
    if (tiers >= 3 && hash01(k, seed + 9) > 0.7) {
      const top = tiers * 2.6;
      out.push(prop(x + 5.8, top, z0 + 1, x + 6.2, top + 0.3, z0 + 1.5, SEAM, 0xff2a1a));
    }
  }
}

// Ship-to-shore crane on the quay, every piece resting on the one below.
function stsCrane(out: SkyProp[], xs: number, z0: number, s: number) {
  const xa = xs; // landside legs
  const xb = xs - s * 12; // waterside legs
  for (const x of [xa, xb]) {
    for (const z of [z0, z0 + 14]) out.push(prop(x - 0.6, 0, z - 0.6, x + 0.6, 30, z + 0.6, STEEL));
  }
  const lo = Math.min(xa, xb) - 0.6;
  const hi = Math.max(xa, xb) + 0.6;
  out.push(prop(lo, 30, z0 - 0.6, hi, 31.2, z0 + 14.6, STEEL)); // portal deck on the legs
  const bx0 = s > 0 ? xb - 34 : xa - 8;
  const bx1 = s > 0 ? xa + 8 : xb + 34;
  out.push(prop(bx0, 31.2, z0 + 6, bx1, 33, z0 + 8.6, STEEL)); // boom on the deck
  const mx = (xa + xb) / 2;
  out.push(prop(mx - 3, 33, z0 + 5.4, mx + 3, 36, z0 + 9.2, 0x23272e)); // machinery house
  out.push(prop(mx - 0.5, 36, z0 + 6.8, mx + 0.5, 44, z0 + 7.8, STEEL, 0xff2a1a)); // apex post
}

// West half of the backdrop (the east is its 180° twin).
function backdropHalf(): SkyProp[] {
  const out: SkyProp[] = [];
  // quay ground outside the fence (the arena floor covers the inside)
  out.push(prop(-170, -0.5, -170, 0, 0, -29, QUAY));
  out.push(prop(-170, -0.5, -29, -34, 0, 29, QUAY));
  out.push(prop(-170, -0.5, 29, 0, 0, 170, QUAY));
  // north container blocks: 2-row blocks with aisles, ≥ 13 m past the fence
  containerRow(out, -62, 0, -44.5, 11, 3);
  containerRow(out, -62, 0, -47, 12, 4);
  containerRow(out, -62, 0, -53.5, 13, 4);
  containerRow(out, -62, 0, -56, 14, 3);
  containerRow(out, -62, 0, -63, 15, 4);
  // south blocks around the terminal office
  containerRow(out, -62, -42, 44.5, 21, 3);
  containerRow(out, -62, -42, 47, 22, 2);
  containerRow(out, -62, -42, 58, 23, 4);
  containerRow(out, -62, 0, 74, 24, 3);
  // west quay: two STS cranes and a moored ship
  stsCrane(out, -50, -30, 1);
  stsCrane(out, -50, 8, 1);
  out.push(prop(-100, 0, -62, -66, 10, 40, 0x121418)); // hull
  for (let z = -56; z + 12 <= 20; z += 12.4) {
    for (let t = 0; t < 2; t++) {
      const y = 10 + t * 2.6;
      out.push(prop(-96, y, z, -70, y + 2.45, z + 12, SKY_PAINT[(Math.floor(z) + t + 60) % SKY_PAINT.length]));
      out.push(prop(-95.9, y + 2.45, z + 0.1, -70.1, y + 2.6, z + 11.9, SEAM));
    }
  }
  out.push(prop(-94, 10, 24, -72, 24, 36, 0x1a1d22, 0xff2a1a)); // bridge house on the hull
  for (const y of [14, 17.5, 21]) for (let z = 25.5; z + 1.2 <= 34.6; z += 2) out.push(prop(-72, y, z, -71.9, y + 1.1, z + 1.2, WINDOW)); // lit bridge windows
  // terminal office beyond the south blocks, a row of lit windows
  out.push(prop(-40, 0, 60, -14, 8, 70, 0x1b1e23));
  for (const y of [2.2, 5.6]) for (let x = -38; x + 1.4 <= -16; x += 2.4) if (hash01(x, y) > 0.35) out.push(prop(x, y, 59.9, x + 1.4, y + 1.1, 60, WINDOW));
  return out;
}

function port(): SkyProp[] {
  const half = backdropHalf();
  const rot = (p: SkyProp): SkyProp => ({ ...p, min: [-p.max[0], p.min[1], -p.max[2]], max: [-p.min[0], p.max[1], -p.min[2]] });
  return [...half, ...half.map(rot)];
}

export const NIGHTPORT: WorldTheme = {
  id: 'nightport',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 3.2,
  slots: {
    ...METAL,
    floor: { metalness: 0.05, normalScale: 0.6, ao: 0.6 },
    wall: { metalness: 0.2, normalScale: 0.7, ao: 0.6 },
    ceiling: { metalness: 0, normalScale: 0.8, ao: 0.7 },
    cover: { metalness: 0.12, normalScale: 1.0, ao: 0.7 },
    platform: { metalness: 0.4, normalScale: 0.9, ao: 0.75 },
    tower: { metalness: 0.15, normalScale: 0.8, ao: 0.7 },
  },
  slotFor,
  tintFor,
  trim: null,
  dress: {
    slot: 'tower', tint: 0xd8d8d8, bright: 1.0,
    crown: { h: 0.3, d: 0.12 },
    pilasters: { spacing: 6, w: 0.5, d: 0.14 },
    collars: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.3, d: 0.08 },
  },
  inlays: INLAYS,
  skyline: [
    ...port(),
    ...[...MASTS, ...MASTS.map((m) => ({ at: [-m.at[0], m.at[1], -m.at[2]] as V, face: ROT_FACE[m.face] }))].map((m) => ({ ...mast(m.at, m.face), color: 0x262a31 })),
  ],
  lights: LIGHTS,
  bake: {
    ambientUp: 0x55648c, ambientDown: 0x30343c, ambient: 0.15,
    sky: { color: 0x33456e, intensity: 0.2 },
    ao: { radius: 2.2, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.4,
    maxTexels: 200_000,
  },
  sun: { dir: norm([0.35, 0.8, -0.45]), color: 0xa8baf0, intensity: 0.8, mapScale: 0.28 },
  hemi: { sky: 0x7a88b8, ground: 0x3a3c44, intensity: 0.45, mapScale: 0.13 },
  fill: { dir: norm([-0.5, 0.4, 0.7]), color: 0xc8d0e0, intensity: 0.4, mapScale: 0.05 },
  env: { intensity: 0.22, mapScale: 0.8 },
  worldSaturation: 1,
  satCap: 0.76,
  shadowBox: 60,
  exposure: 1.12,
  fog: { color: 0x141824, near: 45, far: 190 },
  background: 0x06080e,
  sky: {
    mode: 'night', top: 0x03060e, horizon: 0x1c1a28, glow: 0x6a3a18, stars: 0.8,
  },
};
