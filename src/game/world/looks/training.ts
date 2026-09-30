// Look for the 'training' arena: "Lab" — a bright, clean test facility.
//
// Identity: pale epoxy floor and white cladding under a clear sky, colour-
// coded by zone like a real proving ground. The hub is neutral white; the aim
// gallery is AMBER / ORANGE (sand berms, orange cover, amber decks, towers
// with amber bands, a dark slate backstop so targets pop); the movement
// course is CYAN / TEAL (ice-pale pit blocks, cyan jump-steps "climb here",
// a teal boost tower, cyan chimney). Floor paint does the wayfinding: pads,
// lane lines and 10 m bars in the gallery, take-off hazard lips and glowing
// cyan gate lines along the course, a chequered finish.
import {
  FACE_NORMAL, METAL, defaultSlot, norm, outline, prop, wallLamp,
  type Face, type Inlay, type LightDef, type SkyProp, type WorldTheme,
} from '../theme-kit';
import { R, bake, gratingField, panel, panelField } from '../../textures';
import { TRAINING, TRAINING_LAYOUT as L } from '../../maps/training';
import type { MapBox } from '../../maps/kit';
import type { AABB } from '../../types';

// ── surfaces ───────────────────────────────────────────────────────────────
const TEXTURES: WorldTheme['textures'] = {
  // Epoxy-coated slab: 4 m bays, hairline joints, light and quiet.
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 0.8, bevel: 1, depth: 1.2, inset: 0, rivets: 'none', wobble: 0.35, seed: 12 }),
    {
      base: 0x979da3, seamDark: 0.7, toneNoise: 0.025, grain: 0.012,
      rough: { base: 0.5, seam: 0.2, centre: 0.06, blotch: 0.06, grain: 0.02 },
      ao: 0.45, aoBlur: 3, seed: 13,
      stain: { color: 0x979ca2, amount: 0.18, cell: 80, bias: 0.12, rough: 0.05, seed: 14 },
    },
    8,
  ),
  // Facility cladding: tall pale panels (perimeter, north wall, backstop).
  wall: () => panel(0xc9cdd1, 4, {
    cols: 2, rows: 1, midSeam: 0.35, seamHalf: 1, bevel: 2, depth: 2, rivets: 'none',
    rough: 0.55, tone: 0.025, grain: 0.01, seed: 24,
  }),
  // Never drawn (open sky) → repurposed as the catwalk grating.
  ceiling: () => bake(
    gratingField({ size: R, pitch: 16, bar: 2.4, cross: 48, rod: 1.6, depth: 4, frame: 5, seed: 31 }),
    {
      base: 0xc4cad0, seamDark: 0.64, toneNoise: 0.02, grain: 0.015,
      rough: { base: 0.42, seam: 0.3, centre: 0, blotch: 0.05, grain: 0.03 },
      ao: 0.75, aoBlur: 3, seed: 32,
    },
    1.5,
  ),
  // Decks / pit blocks: 2 m plates with corner studs, near-white (tinted).
  platform: () => panel(0xd6d8da, 2, { rivets: 'corners', rivetInset: 16, rivetR: 2.2, rivetH: 1, rough: 0.45, seamDark: 0.62, tone: 0.02, seed: 42 }),
  // Painted plate (cover, berms, steps, stands, chimney): near-white, the tint is the paint.
  cover: () => panel(0xdcdcdc, 2, { cols: 1, rows: 1, bevel: 3, depth: 2.5, inset: 12, rough: 0.5, seamDark: 0.6, tone: 0.02, grain: 0.01, seed: 53 }),
  // Structural plate with riveted bands (spine, towers, boost tower).
  tower: () => panel(0xdadcde, 4, { cols: 1, rows: 2, seamHalf: 1, bevel: 1.5, depth: 1.5, rivets: 'bands', rivetInset: 8, rivetR: 1.8, rivetH: 0.8, rough: 0.48, seamDark: 0.7, tone: 0.02, seed: 68 }),
};

// ── palette ────────────────────────────────────────────────────────────────
const AMBER = 0xf2a93a;
const ORANGE = 0xe8803a;
const RUST = 0xd8643a;
const SAND = 0xe2c89c;
const SLATE = 0x7b838d;
const CYAN = 0x2ec6e0;
const TEAL = 0x62c4d6;
const ICE = 0x8fd4e4;
const WHITE = 0xeef0f2;

const PAINT_WHITE = 0xe8eaec;
const PAINT_AMBER = 0xe8a236;
const PAINT_CYAN = 0x34bcd6;
const PIT = 0x59616b;

const PAD_COLOR: Record<keyof typeof L.pads, number> = {
  flick: 0xf08a24,
  strafers: 0xe85ad0, // matches the strafer targets + sign
  course: 0x2ec6e0,
  gauntlet: 0x2fd08c, // matches the gauntlet targets + sign
};

function slotFor(i: number, b: MapBox, k: Parameters<NonNullable<WorldTheme['slotFor']>>[2]) {
  switch (b.tag) {
    case 'perimeter':
    case 'backstop':
    case 'northwall':
      return 'wall';
    case 'catwalk':
      return 'ceiling';
    case 'gdeck':
    case 'pit':
    case 'bleacher':
      return 'platform';
    case 'berm':
    case 'cover':
    case 'step':
    case 'stand':
    case 'chimney':
      return 'cover';
    case 'gtower':
    case 'spine':
    case 'boost':
      return 'tower';
    default:
      return defaultSlot(i, b, k);
  }
}

function tintFor(_i: number, b: MapBox): number | null {
  switch (b.tag) {
    case 'backstop': return SLATE;
    case 'northwall': return 0xdfe4e8;
    case 'berm': return SAND;
    case 'cover': return RUST;
    case 'gdeck': return ORANGE;
    case 'gtower': return AMBER;
    case 'bleacher': return 0xd0d4d8;
    case 'spine': return WHITE;
    case 'pit': return ICE;
    case 'step': return CYAN;
    case 'stand': return CYAN;
    case 'boost': return TEAL;
    case 'chimney': return CYAN;
    case 'catwalk': return 0xe4ecf0;
    default: return null;
  }
}

// ── floor paint ────────────────────────────────────────────────────────────
type V = [number, number, number];
const rect = (x0: number, z0: number, x1: number, z1: number, color: number, y = 0, extra: Partial<Inlay> = {}): Inlay => ({
  min: [Math.min(x0, x1), y, Math.min(z0, z1)], max: [Math.max(x0, x1), y, Math.max(z0, z1)], color, ...extra,
});
const ringAt = (b: AABB, w: number, color: number, y = 0, extra: Partial<Inlay> = {}): Inlay[] =>
  outline(b, w, color).map((p) => ({ ...p, min: [p.min[0], y, p.min[2]] as V, max: [p.max[0], y, p.max[2]] as V, ...extra }));
const box2 = (x0: number, z0: number, x1: number, z1: number): AABB => ({ min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: 0, z: z1 } });

function hubPaint(): Inlay[] {
  const out: Inlay[] = [];
  const a = L.hub.area;
  // plaza border
  out.push(...ringAt(box2(a.min.x + 0.5, a.min.z + 0.5, a.max.x - 0.5, a.max.z - 1.5), 0.3, PAINT_WHITE));
  // challenge pads: a glowing rim, a paint fill, a start bar toward the facility
  for (const [id, pad] of Object.entries(L.pads) as Array<[keyof typeof L.pads, (typeof L.pads)[keyof typeof L.pads]]>) {
    const c = PAD_COLOR[id];
    const hx = pad.size[0] / 2;
    const hz = pad.size[1] / 2;
    const b = box2(pad.center.x - hx, pad.center.z - hz, pad.center.x + hx, pad.center.z + hz);
    out.push(...ringAt(b, 0.18, c, 0, { glow: 0.55 }));
    out.push(rect(b.min.x + 0.4, b.min.z + 0.4, b.max.x - 0.4, b.max.z - 0.4, c));
    out.push(rect(b.min.x, b.min.z - 0.7, b.max.x, b.min.z - 0.4, c)); // bar in front of the pad
  }
  // spawn square
  const s = L.hub.spawn;
  out.push(...ringAt(box2(s.x - 1, s.z - 1, s.x + 1, s.z + 1), 0.15, PAINT_WHITE));
  // wayfinding dashes: amber to the firing line, cyan to the course start
  for (let x = -12; x > -25; x -= 2.5) out.push(rect(x - 1.5, 22.3, x, 22.6, PAINT_AMBER));
  for (let x = 12; x < 21; x += 2.5) out.push(rect(x, 22.3, x + 1.5, 22.6, PAINT_CYAN));
  return out;
}

function galleryPaint(): Inlay[] {
  const out: Inlay[] = [];
  const fl = L.gallery.firingLine;
  // firing line: amber rim + sand fill + the line itself (a bright bar at the front)
  out.push(...ringAt(box2(fl.min.x, fl.min.z, fl.max.x, fl.max.z), 0.2, PAINT_AMBER));
  // A faint warm tint: the amber rim marks the zone; a saturated fill filled the bottom of the screen.
  out.push(rect(fl.min.x + 0.3, fl.min.z + 0.3, fl.max.x - 0.3, fl.max.z - 0.3, 0xe9e4da));
  // The line itself: thin, flat paint. It sits ~2 m in front of the start mark, so a
  // wide glowing bar filled the bottom of the screen.
  out.push(rect(fl.min.x - 6, fl.min.z - 0.58, fl.max.x + 6, fl.min.z - 0.42, PAINT_AMBER));
  // 10 m bars across the range, lane lines between them
  const bars = L.gallery.markers.map((m) => m.at.z).sort((p, q) => q - p);
  const x0 = -58.5;
  const x1 = -9.5;
  for (const z of bars) {
    out.push(rect(x0, z - 0.2, x1, z + 0.2, PAINT_AMBER));
  }
  const edges = [fl.min.z - 1, ...bars, -37];
  for (const x of [-49, -39, -29, -19]) {
    for (let k = 0; k + 1 < edges.length; k++) {
      const za = edges[k] - 0.5;
      const zb = edges[k + 1] + 0.5;
      if (za - zb < 1) continue;
      out.push(rect(x - 0.08, zb, x + 0.08, za, PAINT_WHITE));
    }
  }
  return out;
}

function coursePaint(): Inlay[] {
  const out: Inlay[] = [];
  const PT = 2.4;
  // the pit: dark floor in every gap + the dash gap
  for (const [z0, z1] of [[3, 8], [-8.5, -2], [-20.5, -12.5], [-33, -24]]) out.push(rect(19, z0, 27, z1, PIT));
  out.push(rect(37, -40, 50, -33, PIT));
  // take-off lips (hazard) on every take-off edge
  for (const z of [8, -2, -12.5, -24]) out.push(rect(19, z, 27, z + 0.4, 0xc9a227, PT, { hazard: true }));
  out.push(rect(36.6, -40, 37, -33, 0xc9a227, PT, { hazard: true }));
  // track edges along the pit, and centre dashes along the catwalk + spine run
  out.push(rect(18.55, -33, 18.85, 22, PAINT_CYAN), rect(27.15, -33, 27.45, 22, PAINT_CYAN));
  const dashZ = (x: number, z0: number, z1: number, y: number) => {
    for (let z = z0; z + 1.5 <= z1; z += 3.5) out.push(rect(x - 0.12, z, x + 0.12, z + 1.5, PAINT_CYAN, y));
  };
  const dashX = (z: number, x0: number, x1: number, y: number) => {
    for (let x = x1; x - 1.5 >= x0; x -= 3.5) out.push(rect(x - 1.5, z - 0.12, x, z + 0.12, PAINT_CYAN, y));
  };
  dashX(-38.75, 33.5, 45.5, 15);
  dashX(-38.75, 15.5, 27.5, 14.4);
  dashX(-38.75, -0.5, 8.5, 13.8);
  dashZ(-7, -33.5, 1.8, 12);
  // infield jump ruler (defrag style): take-off bar, a tick every metre,
  // long ticks every 5 m — see how far a jump / double / dash-jump carries
  out.push(rect(34, 0, 35.2, 3, 0xc9a227, 0, { hazard: true }));
  out.push(rect(35.2, -0.3, 57, 0, PAINT_WHITE), rect(35.2, 3, 57, 3.3, PAINT_WHITE));
  for (let m = 1; m <= 21; m++) {
    const x = 35.2 + m;
    const long = m % 5 === 0;
    out.push(rect(x - 0.06, long ? 0 : 0.9, x + 0.06, long ? 3 : 2.1, long ? PAINT_CYAN : PAINT_WHITE));
  }
  // start: a dashed cyan lead-in to the jump-steps
  const s = L.course.start;
  for (let z = s.z - 1; z > 23; z -= 2) out.push(rect(s.x - 0.15, z - 1.2, s.x + 0.15, z, PAINT_CYAN));
  out.push(...ringAt(box2(s.x - 1, s.z - 1, s.x + 1, s.z + 1), 0.15, PAINT_CYAN));
  // gate lines: a glowing cyan bar across the route at each gate
  const G = L.course.gates;
  const bar = (x0: number, z0: number, x1: number, z1: number, y: number) => out.push(rect(x0, z0, x1, z1, CYAN, y, { glow: 0.6 }));
  bar(G[0].min.x, 11.35, G[0].max.x, 11.65, PT); // pit entry
  bar(19, -33.8, 27, -33.5, PT); // across the pit
  bar(50.4, -40, 50.7, -34, PT); // across the dash gap
  bar(53.8, -33.8, 59, -33.5, 8.9); // boost tower top
  bar(46, -34.9, 56, -34.6, 15); // chimney-top deck
  bar(-9, -34.9, -4, -34.6, 12); // spine head
  bar(-9, 2.35, -5, 2.65, 12); // spine end
  // finish: chequered band across the hub entrance
  const f = G[G.length - 1];
  for (let x = f.min.x, i = 0; x < f.max.x - 0.01; x += 1, i++) {
    for (let r = 0; r < 2; r++) out.push(rect(x, f.min.z + r, x + 1, f.min.z + r + 1, (i + r) % 2 ? 0x2a2d31 : 0xf2f4f6));
  }
  return out;
}

// ── lights ─────────────────────────────────────────────────────────────────
const WARM = 0xffe2b8;
const COOL = 0xd6f0ff;
const inside = (x: number, y: number, z: number, b: AABB) =>
  x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z;

// A glowing band just under the top of each box with `tag` (fixture only),
// skipping faces buried in a neighbour.
function topBands(tag: string, color: number, drop = 0.35, h = 0.16, level = 0.8): LightDef[] {
  const out: LightDef[] = [];
  const boxes = TRAINING.boxes;
  for (const b of boxes) {
    if (b.tag !== tag) continue;
    const y = b.max.y - drop;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const faces: Array<[Face, number, number, number]> = [
      ['+x', b.max.x, cz, b.max.z - b.min.z], ['-x', b.min.x, cz, b.max.z - b.min.z],
      ['+z', cx, b.max.z, b.max.x - b.min.x], ['-z', cx, b.min.z, b.max.x - b.min.x],
    ];
    for (const [face, px, pz, len] of faces) {
      const n = FACE_NORMAL[face];
      if (boxes.some((o) => o !== b && inside(px + n[0] * 0.05, y, pz + n[2] * 0.05, o))) continue;
      out.push({ at: [px, y, pz], face, size: [Math.max(0.3, len - 0.3), h], color, intensity: 0, range: 1, kind: 'strip', level });
    }
  }
  return out;
}

const LIGHTS: LightDef[] = [
  // backstop work lights: wash the far targets and tower faces
  wallLamp([-50, 16.5, -37], '+z', WARM, 900, 45, { size: [1.4, 0.6], down: 1.1, angle: 0.55 }),
  wallLamp([-32, 16.5, -37], '+z', WARM, 900, 45, { size: [1.4, 0.6], down: 1.1, angle: 0.55 }),
  wallLamp([-16, 16.5, -37], '+z', WARM, 900, 45, { size: [1.4, 0.6], down: 1.1, angle: 0.55 }),
  // north wall over the course: cool floods above the catwalk
  wallLamp([4, 17.2, -40], '+z', COOL, 700, 40, { size: [1.2, 0.5], down: 1.2, angle: 0.6 }),
  wallLamp([24, 17.2, -40], '+z', COOL, 700, 40, { size: [1.2, 0.5], down: 1.2, angle: 0.6 }),
  wallLamp([42, 17.2, -40], '+z', COOL, 700, 40, { size: [1.2, 0.5], down: 1.2, angle: 0.6 }),
  // under the chimney-top deck: light the boost face of BT and deck D
  wallLamp([53, 11.5, -40], '+z', COOL, 380, 22, { size: [1.2, 0.5], down: 0.7, angle: 0.75 }),
  // spine: cyan work lights on the course face, amber on the gallery face
  wallLamp([-5, 9.5, -24], '+x', COOL, 420, 30, { size: [0.9, 0.45], down: 0.9, angle: 0.7 }),
  wallLamp([-5, 9.5, -4], '+x', COOL, 420, 30, { size: [0.9, 0.45], down: 0.9, angle: 0.7 }),
  wallLamp([-9, 9.5, -14], '-x', WARM, 420, 30, { size: [0.9, 0.45], down: 0.9, angle: 0.7 }),
  // hub: lamps on the south wall over the pads
  wallLamp([-9, 3.6, 41], '-z', WARM, 160, 18, { size: [0.9, 0.4], down: 1.4, angle: 0.9 }),
  wallLamp([9, 3.6, 41], '-z', COOL, 160, 18, { size: [0.9, 0.4], down: 1.4, angle: 0.9 }),
];

const SPINE_TOP = TRAINING.boxes.filter((b) => b.tag === 'spine').reduce((m, b) => Math.max(m, b.max.y), 0);
const strip = (at: V, face: Face, w: number, h: number, color: number, level: number): LightDef => ({
  at, face, size: [w, h], color, intensity: 0, range: 1, kind: 'strip', level,
});

const STRIPS: LightDef[] = [
  // the spine's top edge: amber toward the gallery, cyan toward the course
  strip([-9, SPINE_TOP - 0.4, -14], '-x', 39.4, 0.14, AMBER, 0.75),
  strip([-5, SPINE_TOP - 0.4, -14], '+x', 39.4, 0.14, CYAN, 0.75),
  ...topBands('gtower', AMBER),
  ...topBands('boost', CYAN),
  ...topBands('chimney', CYAN, 0.3, 0.14, 0.7),
  // backstop band (reads the far end at a glance)
  strip([-34, 14.5, -37], '+z', 49.4, 0.2, AMBER, 0.7),
  // BT: a "boost here" band on the launch face just above deck D
  strip([54.5, 2.9, -34], '-z', 8.6, 0.12, CYAN, 0.8),
];

// ── skyline: the rest of the proving ground beyond the fence ───────────────
// Hazy blue-grey facility blocks on a concrete apron, pushed well past the
// fence so the fog softens them. Unlit props are flat, so each building gets
// a darker plinth, a roof cap and window bands on the face that looks at the
// arena — enough structure to read as architecture, not placeholders.
const APRON = 0x969ca2;
const GLASS = 0x6d86a0;
function building(out: SkyProp[], x0: number, z0: number, x1: number, z1: number, h: number, color: number, windows = 0) {
  out.push(prop(x0, 0, z0, x1, 1.2, z1, 0x7c8690)); // plinth
  out.push(prop(x0 + 0.2, 1.2, z0 + 0.2, x1 - 0.2, h, z1 - 0.2, color));
  out.push(prop(x0, h, z0, x1, h + 0.6, z1, 0x8c97a3)); // roof cap
  if (!windows) return;
  // window bands on the face toward the arena centre
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const alongX = Math.abs(cz) > Math.abs(cx);
  for (let k = 0; k < windows; k++) {
    const y = 3.2 + k * 3.6;
    if (y + 1.4 > h - 0.8) break;
    if (alongX) {
      const zf = cz > 0 ? z0 + 0.1 : z1 - 0.2; // 0.1 m proud of the body face toward the arena
      out.push(prop(x0 + 1.5, y, zf, x1 - 1.5, y + 1.4, zf + 0.1, GLASS));
    } else {
      const xf = cx > 0 ? x0 + 0.1 : x1 - 0.2;
      out.push(prop(xf, y, z0 + 1.5, xf + 0.1, y + 1.4, z1 - 1.5, GLASS));
    }
  }
}
function facility(): SkyProp[] {
  const out: SkyProp[] = [];
  // apron around the arena
  out.push(prop(-260, -0.5, -260, 260, 0, -42, APRON));
  out.push(prop(-260, -0.5, 42, 260, 0, 260, APRON));
  out.push(prop(-260, -0.5, -42, -60, 0, 42, APRON));
  out.push(prop(60, -0.5, -42, 260, 0, 42, APRON));
  // west: a hangar and an office wing
  building(out, -160, -50, -120, 6, 16, 0xa6b2be, 3);
  building(out, -125, 18, -98, 52, 10, 0xb2bdc8, 2);
  // south: the long lab block + the control tower
  building(out, -80, 96, 6, 114, 11, 0xaebac6, 2);
  building(out, 34, 88, 44, 98, 26, 0xa2aebb);
  out.push(prop(31, 26.6, 85, 47, 29.4, 101, GLASS)); // tower cab glazing
  out.push(prop(30.5, 29.4, 84.5, 47.5, 30.2, 101.5, 0x8c97a3));
  out.push(prop(38.8, 30.2, 92.8, 39.2, 38, 93.2, 0x70767c, 0xff3a2a));
  // east: tank farm and a drop-test tower
  for (const [x, z] of [[112, -34], [112, -16], [128, -25]]) building(out, x - 6, z - 6, x + 6, z + 6, 13, 0xb6c0ca);
  building(out, 108, 20, 118, 30, 38, 0x9eaab6);
  out.push(prop(112.8, 38.6, 24.8, 113.2, 46, 25.2, 0x70767c, 0xff3a2a));
  // north: service blocks behind the backstop
  building(out, -70, -120, -12, -92, 13, 0xaab5c0, 2);
  building(out, 8, -112, 76, -90, 9, 0xb2bcc6, 1);
  return out;
}

export const LAB: WorldTheme = {
  id: 'lab',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 4.5,
  slots: {
    ...METAL,
    floor: { metalness: 0.05, normalScale: 0.5, ao: 0.6 },
    wall: { metalness: 0.1, normalScale: 0.6, ao: 0.6 },
    ceiling: { metalness: 0.45, normalScale: 0.9, ao: 0.75 },
    platform: { metalness: 0.15, normalScale: 0.7, ao: 0.7 },
    cover: { metalness: 0.08, normalScale: 0.7, ao: 0.65 },
    tower: { metalness: 0.2, normalScale: 0.7, ao: 0.65 },
  },
  slotFor,
  tintFor,
  trim: null,
  dress: {
    slot: 'tower', tint: 0xf2f2f2, bright: 1.05,
    crown: { h: 0.35, d: 0.1 },
    baseboard: { h: 0.3, d: 0.06 },
    collars: { h: 0.4, d: 0.08 },
    edges: { h: 0.12, d: 0.03 },
  },
  inlays: [...hubPaint(), ...galleryPaint(), ...coursePaint()],
  skyline: facility(),
  lights: [...LIGHTS, ...STRIPS],
  bake: {
    ambientUp: 0xd8e0ea, ambientDown: 0xa0a6ae, ambient: 0.36,
    sky: { color: 0xb8d0ec, intensity: 0.8 },
    ao: { radius: 2.2, strength: 0.7 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.55,
    maxTexels: 200_000,
  },
  sun: { dir: norm([0.5, 0.68, 0.5]), color: 0xfff2e0, intensity: 2.3, mapScale: 1.0 },
  hemi: { sky: 0xcfe2f2, ground: 0x80848c, intensity: 0.6, mapScale: 0.2 },
  fill: { dir: norm([-0.6, 0.35, -0.5]), color: 0x9ab4ff, intensity: 0.35, mapScale: 0.4 },
  env: { intensity: 0.4, mapScale: 0.8 },
  worldSaturation: 1.0,
  satCap: 0.7,
  shadowBox: 90,
  exposure: 0.95,
  fog: { color: 0xc2d6e6, near: 110, far: 380 },
  background: 0xa8c8e4,
  sky: { mode: 'lab', top: 0x3274c0, horizon: 0xcfe0ee },
};
