// Look for the 'reactor' arena: a power-plant interior.
//
// Three halls, three light temperatures, one material family:
//   reactor hall  cool white high-bays + the cyan core (white plated core,
//                 grating aprons/gantries, safety-yellow apex)
//   turbine hall  warm sodium-white high-bays; jade-green turbine casings,
//                 orange exciters, a safety-yellow crane girder
//   pump room     cool daylight high-bays; blue tank tiers, orange pipework,
//                 a white surge tower with cyan level bands
//   corridors     pale-green fluorescent maintenance tubes
// Walls are pale warm concrete panels, the floor a light sealed-concrete slab:
// mid-value albedos so the space reads lit, with colour blocking on the
// machinery (vertex tints keyed off the map's box tags).
import type { MapBox } from '../../maps/kit';
import type { SurfaceKind } from '../../textures';
import {
  FACE_NORMAL, band4, box, dashes, defaultSlot, downLight, hazardRing, norm, wallLamp,
  type Face, type Inlay, type LightDef, type WorldTheme,
} from '../theme-kit';
import { R, bake, corrugationField, gratingField, panel, panelField, smoothstep, type Field } from '../../textures';

// ── textures ────────────────────────────────────────────────────────────────
const TEXTURES: WorldTheme['textures'] = {
  // Sealed concrete: 4 m pour slabs with thin saw cuts, very low contrast.
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 0.8, bevel: 1.0, depth: 1.2, rivets: 'none', wobble: 0.9, seed: 12 }),
    {
      base: 0x94918a, seamDark: 0.72, toneNoise: 0.05, grain: 0.02,
      rough: { base: 0.72, seam: 0.15, centre: 0.06, blotch: 0.08, grain: 0.03 },
      ao: 0.5, aoBlur: 3, seed: 13,
      stain: { color: 0x7c7a74, amount: 0.22, cell: 48, bias: 0.12, rough: 0.05, seed: 14 },
    },
    8,
  ),
  // Reactor-hall concrete: 4 × 8 m panels over a painted teal-grey dado
  // (0–2.4 m; the 16 m tile repeats it as a high band at 16 m).
  wall: () => bake(
    paintBand(panelField({ size: R, cols: 4, rows: 2, seamHalf: 0.8, bevel: 1.5, depth: 2, rivets: 'none', wobble: 0.5, seed: 24 }), 0.15),
    {
      base: 0xb4b0a6, base2: 0x6f98a0, seamDark: 0.72, toneNoise: 0.035, grain: 0.012,
      rough: { base: 0.7, seam: 0.15, centre: 0.06, blotch: 0.06, grain: 0.02 },
      ao: 0.6, aoBlur: 4, seed: 25,
      stain: { color: 0x9a968c, amount: 0.14, cell: 64, bias: 0.18, rough: 0.05, seed: 26 },
    },
    16,
  ),
  // Roof deck: pale ribbed steel decking (ribs run with the roof beams — no
  // tile grid overhead).
  ceiling: () => bake(
    corrugationField({ size: 128, ribs: 8, depth: 3, frame: 0, frameDepth: 0, wobble: 0.3, seed: 37 }),
    {
      base: 0xc2c8cc, seamDark: 0.82, toneNoise: 0.03, grain: 0.01,
      rough: { base: 0.6, seam: 0.1, centre: 0, blotch: 0.05, grain: 0.02 },
      ao: 0.4, aoBlur: 2, seed: 38,
    },
    4,
  ),
  // Bar grating on catwalks, aprons and bridges.
  platform: () => bake(
    gratingField({ size: R, pitch: 21, bar: 2.8, cross: 64, rod: 1.8, depth: 5, frame: 6, seed: 42 }),
    {
      base: 0xa8aeb4, seamDark: 0.6, toneNoise: 0.03, grain: 0.015,
      rough: { base: 0.45, seam: 0.35, centre: 0, blotch: 0.05, grain: 0.03 },
      ao: 0.6, aoBlur: 3, seed: 43,
    },
    3,
  ),
  // Painted machine steel (near-white: the tag tints carry the colour).
  cover: () => panel(0xcfcfca, 3, {
    cols: 1, rows: 1, seamHalf: 1.5, bevel: 3, depth: 3, rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5,
    rough: 0.5, seamDark: 0.6, tone: 0.025, seed: 54,
    stain: { color: 0xa9a8a2, amount: 0.12, cell: 64, bias: 0.2, rough: 0.08, seed: 55 },
  }),
  // Wing cladding: ribbed sheet steel with a rail every 4 m, near-white —
  // tinted warm cream (turbine hall) / pale blue (pump room) by tag.
  tower: () => bake(
    corrugationField({ size: R, ribs: 8, depth: 4, frame: 5, frameDepth: 5, wobble: 0.4, seed: 68 }),
    {
      base: 0xd4d2cc, seamDark: 0.8, toneNoise: 0.03, grain: 0.01,
      rough: { base: 0.5, seam: 0.1, centre: 0, blotch: 0.06, grain: 0.02 },
      ao: 0.5, aoBlur: 3, seed: 69,
      stain: { color: 0xb8b4aa, amount: 0.12, cell: 64, bias: 0.2, rough: 0.05, seed: 70 },
    },
    4,
  ),
};

// A painted band over the bottom `frac` of the tile (Field.mix → base2).
function paintBand(f: Field, frac: number): Field {
  const { size } = f;
  const mix = new Float32Array(size * size);
  const edge = frac * size;
  for (let y = 0; y < size; y++) {
    const m = 1 - smoothstep(edge - 0.8, edge + 0.8, y + 0.5);
    if (m <= 0) continue;
    mix.fill(m, y * size, (y + 1) * size);
  }
  f.mix = mix;
  return f;
}

// ── slots + tints by tag ────────────────────────────────────────────────────
const SLOT: Record<string, SurfaceKind> = {
  divider: 'wall', corridor: 'wall', 'wall-hall': 'wall',
  'wall-turbine': 'tower', 'wall-pump': 'tower',
  core: 'cover', column: 'cover', surge: 'cover', deck: 'cover',
  turbine: 'cover', generator: 'cover', tank: 'cover', pump: 'cover', crate: 'cover', pipe: 'cover',
  crane: 'cover', apex: 'cover', parapet: 'cover', stairs: 'cover',
  ring: 'platform', bridge: 'platform', rail: 'platform',
};

const YELLOW = 0xffcc33;
const TINT: Record<string, number> = {
  divider: 0xe4e6e8,
  'wall-turbine': 0xf6e4c6, // warm cream cladding
  'wall-pump': 0xc6dcee, // pale blue cladding
  deck: 0xd6dadc,
  corridor: 0xd4e6d6, // maintenance green-grey
  core: 0x9aaab6, // dark brushed steel: the cyan bands carry the glow
  column: 0xd8dde2,
  surge: 0xf0f3f4,
  turbine: 0x92d2b0, // jade machine green
  generator: 0xff9a3c, // orange exciter housings
  tank: 0x9cc2ec, // pump-room blue
  pipe: 0xff9a3c,
  crate: YELLOW,
  crane: YELLOW,
  apex: YELLOW,
  parapet: YELLOW,
  stairs: 0xc4c9ce,
};

function tintOf(b: MapBox): number | null {
  const t = b.tag;
  if (!t) return null;
  if (t === 'pump') return (b.min.x + b.max.x) / 2 < -16 ? 0x9cc8b4 : 0xa8bcd4; // green west, blue east
  if (t === 'rail' || t === 'bridge' || t === 'ring') return null;
  return TINT[t] ?? null;
}

// ── lights ──────────────────────────────────────────────────────────────────
const HALL_WHITE = 0xe6f0ff;
const CYAN = 0x4fe8ff;
const SODIUM = 0xffd6a4; // turbine hall
const DAY = 0xd2e8ff; // pump room
const TUBE = 0xd8ffe4; // corridors
const RED = 0xff3a22;
const AMBER = 0xffb040;

// Ceiling high-bay: a long lens on the roof deck, shining down 30 m.
const highBay = (x: number, z: number, color: number, intensity = 520, range = 40): LightDef =>
  downLight([x, 30, z], color, intensity, range, { size: [0.9, 2.6], angle: 1.0, out: 0.6, radius: 0.6, level: 0.9 });

const CORE = box(-4, 0, -4, 4, 18, 4);
const APEX = box(-1, 18, -1, 1, 19.2, 1);
const SURGE = box(29, 0, -3, 35, 15, 3);

const mz = (l: LightDef): LightDef => {
  const face = (l.face === '+z' ? '-z' : l.face === '-z' ? '+z' : l.face) as Face;
  const spot = l.spot ? { ...l.spot, dir: [l.spot.dir[0], l.spot.dir[1], -l.spot.dir[2]] as [number, number, number] } : undefined;
  return { ...l, at: [l.at[0], l.at[1], -l.at[2]], face, ...(spot ? { spot } : {}) };
};
const both = (ls: LightDef[]): LightDef[] => [...ls, ...ls.map(mz)];

// Vertical glow band on a core face.
function coreStrip(face: Face, s: number, y0: number, y1: number): LightDef {
  const n = FACE_NORMAL[face];
  const t = n[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
  return {
    at: [n[0] * 4 + t[0] * s, (y0 + y1) / 2, n[2] * 4 + t[2] * s], face, size: [0.6, y1 - y0], color: CYAN,
    intensity: 0, range: 1, kind: 'strip', level: 1.0,
  };
}

// Cyan pool thrown from a core face: a spot aimed out and down, so the core
// lights the floor / apron / gantry around it rather than washing itself.
function corePool(face: Face, y: number, s: number, intensity: number, range: number): LightDef {
  const n = FACE_NORMAL[face];
  const t = n[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
  return {
    at: [n[0] * 4 + t[0] * s, y, n[2] * 4 + t[2] * s], face, size: [0.01, 0.01], color: CYAN, intensity, range,
    out: 0.5, radius: 0.6, fixture: false,
    spot: { dir: norm([n[0] * 0.9, -1, n[2] * 0.9]), angle: 0.95, penumbra: 0.6 },
  };
}

// Short-range uplight on a wall under a catwalk: lifts the grating underside
// out of black (a small pool on the wall above it, no fixture glare).
const upLight = (at: [number, number, number], face: Face, color: number): LightDef => ({
  ...wallLamp(at, face, color, 22, 7, { size: [0.8, 0.3], down: -2.2, angle: 0.9, out: 0.4, level: 0.6 }),
});

// Fixture-only lamp (no baked light): warning beacons, underside panels.
const redLamp = (at: [number, number, number], face: Face, w = 0.5, h = 0.35): LightDef => ({
  at, face, size: [w, h], color: RED, intensity: 0, range: 1, kind: 'lamp', level: 1.1,
});
const panelLamp = (at: [number, number, number], color: number, w: number, d: number): LightDef => ({
  at, face: '-y', size: [w, d], color, intensity: 0, range: 1, kind: 'lamp', level: 0.8,
});

const X4: Face[] = ['+x', '-x'];
const Z4: Face[] = ['+z', '-z'];

const LIGHTS: LightDef[] = [
  // ── reactor hall ──
  // (roof ribs run every 8 m in x from x = 0: the high-bays sit between them)
  ...[-12, 12].flatMap((x) => [highBay(x, 0, HALL_WHITE, 480, 34), highBay(x, -19, HALL_WHITE, 480, 34), highBay(x, 19, HALL_WHITE, 480, 34)]),
  ...[-4, 4].map((x) => downLight([x, 30, 0], HALL_WHITE, 180, 30, { size: [1.6, 2.6], angle: 0.6, out: 0.6, radius: 0.8, level: 0.9 })),
  // the core as a light source: pools on the floor (under the aprons on ±z),
  // on the L6 aprons and on the L12 gantries
  ...X4.map((f) => corePool(f, 4.5, 0, 40, 12)),
  ...Z4.map((f) => corePool(f, 4.6, 0, 26, 9)),
  ...Z4.map((f) => corePool(f, 9.5, 0, 30, 10)),
  ...X4.map((f) => corePool(f, 15.5, 0, 30, 10)),
  // glow bands: vertical pairs on every face, wide rings at the foot, under
  // the aprons and at the top rim
  ...Z4.flatMap((f) => [coreStrip(f, -2.4, 6.4, 17.0), coreStrip(f, 2.4, 6.4, 17.0), coreStrip(f, -2.4, 1.8, 5.0), coreStrip(f, 2.4, 1.8, 5.0)]),
  ...X4.flatMap((f) => [coreStrip(f, -2.4, 12.4, 17.0), coreStrip(f, 2.4, 12.4, 17.0), coreStrip(f, -2.4, 1.8, 10.8), coreStrip(f, 2.4, 1.8, 10.8)]),
  ...band4(CORE, 0.9, 0.7, CYAN, 1.0),
  ...band4(CORE, 17.35, 0.7, CYAN, 1.0),
  ...band4(APEX, 18.6, 0.2, YELLOW, 0.8),
  // red beacons on the core's top corners (the apex reads as the hot spot)
  ...X4.flatMap((f) => [-3.4, 3.4].map((z) => redLamp([FACE_NORMAL[f][0] * 4, 16.4, z], f, 0.45, 0.45))),
  ...Z4.flatMap((f) => [-3.4, 3.4].map((x) => redLamp([x, 16.4, FACE_NORMAL[f][2] * 4], f, 0.45, 0.45))),
  // undersides: L6 aprons, L12 gantries, the apron → balcony bridges and the
  // gantry bridges to the windows
  ...[-6, 6].flatMap((x) => [downLight([x, 5.4, 6], 0xbfeaff, 40, 10, { size: [1.2, 0.4] }), downLight([x, 5.4, -6], 0xbfeaff, 40, 10, { size: [1.2, 0.4] })]),
  ...[-6.5, 6.5].map((x) => downLight([x, 11.4, 0], 0xbfeaff, 50, 12, { size: [0.4, 1.4] })),
  ...both([downLight([0, 5.4, 13], HALL_WHITE, 36, 9, { size: [0.4, 1.4] }), downLight([0, 5.4, 24], HALL_WHITE, 36, 9, { size: [0.4, 1.4] })]),
  ...[-12.5, 12.5].map((x) => panelLamp([x, 11.4, 0], HALL_WHITE, 1.4, 0.4)),
  // divider hall faces: lamps beside the balcony stairs + red gate lamps
  ...both([
    wallLamp([16, 10, 25], '-x', HALL_WHITE, 120, 18, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    wallLamp([-16, 10, 25], '+x', HALL_WHITE, 120, 18, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    wallLamp([16, 7.2, 6], '-x', RED, 16, 7, { size: [1.0, 0.4], down: 0.4, angle: 1.2, out: 0.3, level: 1.2 }),
    wallLamp([-16, 7.2, 6], '+x', RED, 16, 7, { size: [1.0, 0.4], down: 0.4, angle: 1.2, out: 0.3, level: 1.2 }),
    // red beacons over the side doors, both faces of the lintel
    redLamp([16, 11, 16], '-x', 0.8, 0.4), redLamp([-16, 11, 16], '+x', 0.8, 0.4),
    redLamp([16.75, 11, 16], '+x', 0.8, 0.4), redLamp([-16.75, 11, 16], '-x', 0.8, 0.4),
  ]),
  // floods on the end walls above the balconies
  ...both([-9, 9].map((x) => wallLamp([x, 15, 35], '-z', HALL_WHITE, 200, 26, { size: [1.4, 0.5], down: 1.6, angle: 0.8, radius: 0.5 }))),
  // service corridors: fluorescent tubes on the balcony underside + red
  // beacons at the corridor mouths
  ...both([-11, 0, 11].map((x) => downLight([x, 5.5, 32.2], TUBE, 55, 11, { size: [0.3, 2.0], angle: 1.25 }))),
  ...both([redLamp([-16, 4.6, 29.5], '+z', 0.6, 0.35), redLamp([16, 4.6, 29.5], '+z', 0.6, 0.35)]),

  // ── turbine hall (west) ──
  ...[-44, -28].flatMap((x) => [highBay(x, -20, SODIUM, 480, 34), highBay(x, 20, SODIUM, 480, 34)]),
  highBay(-36, -8, SODIUM, 400, 34), highBay(-36, 8, SODIUM, 400, 34),
  // under the west gallery, the divider catwalk and the crane
  ...both([10, 18].map((z) => downLight([-45.25, 9.4, z], SODIUM, 50, 11, { size: [1.2, 0.4] }))),
  ...both([7, 16].map((z) => downLight([-18.6, 11.4, z], SODIUM, 55, 13, { size: [0.4, 1.2] }))),
  ...both([panelLamp([-45.25, 9.4, 14], SODIUM, 1.2, 0.4), panelLamp([-18.6, 11.4, 11.5], SODIUM, 0.4, 1.2)]),
  ...both([upLight([-47, 6.5, 9], '+x', SODIUM), upLight([-47, 6.5, 18], '+x', SODIUM), upLight([-16.75, 8.2, 4], '-x', SODIUM)]),
  ...[-40, -30].map((x) => downLight([x, 13.5, 0], SODIUM, 80, 16, { size: [1.2, 0.5] })),
  // crane girder: amber running lights, red beacons on the leg
  { at: [-35.5, 14.25, 3], face: '+z', size: [22.5, 0.3], color: AMBER, intensity: 0, range: 1, kind: 'strip', level: 0.9 },
  { at: [-35.5, 14.25, -3], face: '-z', size: [22.5, 0.3], color: AMBER, intensity: 0, range: 1, kind: 'strip', level: 0.9 },
  redLamp([-24, 12.8, 0], '+x', 0.6, 0.4), redLamp([-25.5, 12.8, 0], '-x', 0.6, 0.4),
  ...both([
    // west wall beside the oil tanks, divider wing face, end walls
    wallLamp([-47, 8, 25.5], '+x', SODIUM, 110, 18, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    wallLamp([-16.75, 9, 25], '-x', SODIUM, 110, 18, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    wallLamp([-31, 9, 35], '-z', SODIUM, 140, 20, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    // red beacons on the exciter housings
    redLamp([-33, 7.0, 26], '+z', 0.6, 0.35),
  ]),

  // ── pump room (east) ──
  ...[28, 44].flatMap((x) => [highBay(x, -20, DAY, 480, 34), highBay(x, 20, DAY, 480, 34)]),
  highBay(20, -8, DAY, 380, 34), highBay(20, 8, DAY, 380, 34),
  // service alley under the east gallery, the pipe bridges
  ...both([6, 24].map((z) => downLight([45.25, 11.4, z], DAY, 55, 12, { size: [1.2, 0.4] }))),
  ...both([panelLamp([45.25, 11.4, 15], DAY, 1.2, 0.4)]),
  ...both([upLight([47, 8.5, 10], '-x', DAY), upLight([47, 8.5, 22], '-x', DAY)]),
  downLight([22.5, 11.4, 0], DAY, 45, 11, { size: [1.4, 0.4] }),
  downLight([39.5, 11.4, 0], DAY, 45, 11, { size: [1.4, 0.4] }),
  // surge tower: cyan level bands, a lamp on each long face, red beacons up top
  ...band4(SURGE, 4, 0.4, CYAN, 0.9),
  ...band4(SURGE, 14.4, 0.4, CYAN, 0.9),
  ...both([wallLamp([32, 8, 3], '+z', DAY, 55, 11, { size: [1.0, 0.4], down: 1.2, angle: 1.0 })]),
  redLamp([29, 13.2, -2.2], '-x', 0.45, 0.45), redLamp([29, 13.2, 2.2], '-x', 0.45, 0.45),
  redLamp([35, 13.2, -2.2], '+x', 0.45, 0.45), redLamp([35, 13.2, 2.2], '+x', 0.45, 0.45),
  ...both([
    wallLamp([47, 18, 14], '-x', DAY, 160, 24, { size: [1.4, 0.5], down: 1.6, angle: 0.8, radius: 0.5 }),
    wallLamp([16.75, 9, 25], '+x', DAY, 110, 18, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    wallLamp([31, 9, 35], '-z', DAY, 140, 20, { size: [1.2, 0.5], down: 1.4, angle: 0.9 }),
    // tank level gauges (fixture only) + a beacon on the top tank
    { at: [38, 7.4, 14], face: '-x', size: [0.3, 2.6], color: CYAN, intensity: 0, range: 1, kind: 'strip', level: 0.9 } as LightDef,
    redLamp([38, 8.6, 9], '-x', 0.45, 0.35),
  ]),
];

// ── floor paint ─────────────────────────────────────────────────────────────
const WALK = 0xd2b24a;
const INLAYS: Inlay[] = [
  // containment ring + a cyan glow line at the core's foot
  ...hazardRing(CORE, 2.4, 0.6),
  ...hazardRing(CORE, 0.1, 0.5).map((i): Inlay => ({ ...i, hazard: false, color: CYAN, glow: 1.0 })),
  ...hazardRing(CORE, 1.3, 0.25).map((i): Inlay => ({ ...i, hazard: false, color: CYAN, glow: 0.7 })),
  // glow lines along the outer lips of the L6 aprons and L12 gantries
  ...[-1, 1].flatMap((s): Inlay[] => [
    { min: [-9, 6, s > 0 ? 7.55 : -7.85], max: [9, 6, s > 0 ? 7.85 : -7.55], color: CYAN, glow: 0.8 },
    { min: [s > 0 ? 8.55 : -8.85, 12, -4], max: [s > 0 ? 8.85 : -8.55, 12, 4], color: CYAN, glow: 0.8 },
  ]),
  // hazard thresholds in the central gates and side doors
  ...[-16.4, 16.4].flatMap((x): Inlay[] => [
    { min: [x - 0.9, 0, -8.5], max: [x - 0.35, 0, 8.5], color: 0xc9a227, hazard: true },
    { min: [x + 0.35, 0, -8.5], max: [x + 0.9, 0, 8.5], color: 0xc9a227, hazard: true },
  ]),
  // turbine hall walkway lines (both lanes)
  ...[-41.5, -24.5].flatMap((x): Inlay[] => [
    { min: [x - 0.08, 0, -27], max: [x + 0.08, 0, 27], color: WALK },
  ]),
  // pump room: blue pipe-route lines
  ...[-5.5, 5.5].map((z): Inlay => ({ min: [18, 0, z - 0.08], max: [28, 0, z + 0.08], color: 0x6a9ad0 })),
  // corridor centre dashes (green)
  ...[-32.2, 32.2].flatMap((z): Inlay[] =>
    dashes(0, -15, 15, 1.6, 1.2, 0.14, 0x7ac890).map((d) => ({ min: [d.min[2], 0, z - 0.07], max: [d.max[2], 0, z + 0.07], color: d.color })),
  ),
];

export const REACTOR: WorldTheme = {
  id: 'reactor',
  textures: TEXTURES,
  openSky: false,
  slots: {
    floor: { metalness: 0.05, normalScale: 0.5, ao: 0.55 },
    ceiling: { metalness: 0.3, normalScale: 0.6, ao: 0.5 },
    wall: { metalness: 0.05, normalScale: 0.6, ao: 0.6 },
    cover: { metalness: 0.2, normalScale: 0.8, ao: 0.65 },
    platform: { metalness: 0.45, normalScale: 0.9, ao: 0.8 },
    tower: { metalness: 0.25, normalScale: 0.8, ao: 0.65 },
  },
  slotFor: (i, b, k) => (b.tag && SLOT[b.tag]) || defaultSlot(i, b, k),
  tintFor: (_i, b) => tintOf(b),
  trim: { color: 0x3fe0ff, intensity: 1.4 },
  dress: {
    slot: 'wall', tint: 0xf2f2f0, bright: 1.15,
    baseboard: { h: 0.6, d: 0.1 },
    pilasters: { spacing: 12, w: 1.0, d: 0.14 },
    bands: [{ y: 6, h: 0.35, d: 0.1 }, { y: 22, h: 0.5, d: 0.1 }],
    beams: { spacing: 8, w: 0.9, d: 0.14 },
    collars: { h: 0.6, d: 0.12 },
    edges: { h: 0.25, d: 0.03, hazard: true },
  },
  inlays: INLAYS,
  lights: LIGHTS,
  bake: {
    ambientUp: 0x9aa6b4, ambientDown: 0x8a9098, ambient: 0.3,
    sky: null,
    ao: { radius: 2.6, strength: 0.75 },
    sunShadow: true, sunIgnorePerimeter: false, sunIgnoreCeiling: true,
    texel: 0.55,
    maxTexels: 120_000,
  },
  sun: { dir: norm([0.35, 0.9, 0.25]), color: 0xfff2e0, intensity: 1.5, mapScale: 0.25 },
  hemi: { sky: 0xc0d4e8, ground: 0x4a4e56, intensity: 0.5, mapScale: 0.15 },
  fill: { dir: norm([-0.5, 0.3, -0.6]), color: 0x9fe8ff, intensity: 0.4, mapScale: 0.25 },
  env: { intensity: 0.4, mapScale: 0.5 },
  worldSaturation: 0.9,
  satCap: 0.72,
  exposure: 1.1,
  fog: { color: 0x1e252c, near: 60, far: 240 },
  background: 0x14181c,
  sky: { mode: 'interior', top: 0x14181c, horizon: 0x14181c },
};
