// Look for the 'derrick' arena: an oil-refinery yard at sunset.
//
// Palette (one screenshot should say "Derrick"): oxide-red derrick, cream
// tank shells, teal-clad control buildings, yellow pipe runs, galvanised
// grating decks, warm poured-concrete yard — all mid-value, lit by a low
// orange sun with a violet sky fill, against a skyline of refinery
// silhouettes. Sodium floods hang under the decks and on building faces.
import { band4, box, defaultSlot, downLight, hazardRing, norm, prop, wallLamp, type Face, type LightDef, type SkyProp, type WorldTheme } from '../theme-kit';
import type { V3 } from '../lightmap';
import { R, bake, corrugationField, gratingField, newField, noiseField, noiseField2, panelField, smoothstep, unusedCeiling, type Field, type SurfaceKind } from '../../textures';

// Derrick lattice: square bays with a frame and an X brace in each, the
// dark backing plate recessed behind (a truss read, still a solid face).
// Bays are half a tile, so with a 3 m tile the bars land on every 1.5 m —
// the derrick's 6 m / 3 m faces and its 6 m shoulder all start on a bar.
function trussField(size: number, seed: number): Field {
  const f = newField(size);
  const bay = size / 2;
  const frame = size * 0.03;
  const brace = size * 0.018;
  const wobble = noiseField(size, size / 4, seed);
  for (let y = 0; y < size; y++) {
    const ly = (y + 0.5) % bay;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lx = (x + 0.5) % bay;
      const edge = Math.min(lx, bay - lx, ly, bay - ly);
      const diag = Math.min(Math.abs(lx - ly), Math.abs(lx - (bay - ly))) * Math.SQRT1_2;
      const bar = 1 - smoothstep(frame, frame + 1.5, edge);
      const x2 = (1 - smoothstep(brace, brace + 1.5, diag)) * 0.85;
      const solid = Math.max(bar, x2);
      f.h[i] = solid * 5 + (wobble[i] - 0.5) * 0.4;
      f.seam[i] = 1 - solid;
      f.centre[i] = solid;
    }
  }
  return f;
}

// Welded steel plate: smooth 1.5 m courses with faint raised weld beads,
// butt welds staggered course to course, and soft vertical weather streaks —
// a tank shell / painted housing, no grid of box seams.
function weldedField(size: number, seed: number): Field {
  const f = newField(size);
  const course = size / 2;
  const plate = size / 2;
  const streak = noiseField2(size, 6, size / 2, seed);
  const wobble = noiseField(size, size / 4, seed + 1);
  f.tone = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = Math.floor((y + 0.5) / course);
    const ly = (y + 0.5) - row * course;
    const dy = Math.min(ly, course - ly);
    const off = row % 2 ? plate / 2 : 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lx = (x + 0.5 + off) % plate;
      const dx = Math.min(lx, plate - lx);
      const bead = Math.max(1 - smoothstep(0.6, 2.2, dy), (1 - smoothstep(0.6, 2.2, dx)) * 0.35);
      f.h[i] = bead * 1.4 + (wobble[i] - 0.5) * 0.5;
      f.seam[i] = bead * 0.35;
      f.centre[i] = 1 - bead;
      f.tone[i] = (streak[i] - 0.5) * 0.08;
    }
  }
  return f;
}

const TEXTURES: WorldTheme['textures'] = {
  // Poured concrete: 6 m slabs with saw-cut joints, oil blotches.
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 0.8, bevel: 1.2, depth: 2, rivets: 'none', wobble: 0.9, seed: 21 }),
    {
      base: 0x7c7e7c, seamDark: 0.74, toneNoise: 0.05, grain: 0.02,
      rough: { base: 0.86, seam: 0.08, centre: 0.03, blotch: 0.06, grain: 0.03 },
      ao: 0.5, aoBlur: 5, seed: 22,
      stain: { color: 0x5e615f, amount: 0.3, cell: 110, bias: 0.14, rough: -0.15, seed: 23 },
    },
    12,
  ),
  // Corrugated cladding, neutral light (tinted per building / tank).
  wall: () => bake(
    corrugationField({ size: R, ribs: 10, depth: 4, frame: 10, frameDepth: 5, wobble: 0.5, seed: 33 }),
    {
      base: 0xc8c6be, seamDark: 0.82, toneNoise: 0.04, grain: 0.015,
      rough: { base: 0.62, seam: 0.1, centre: 0, blotch: 0.06, grain: 0.02 },
      ao: 0.45, aoBlur: 4, seed: 34,
      stain: { color: 0xa09080, amount: 0.15, cell: 64, bias: 0.22, rough: 0.05, seed: 35 },
    },
    4,
  ),
  ceiling: unusedCeiling,
  // Galvanised bar grating (decks, racks, crown).
  platform: () => bake(
    gratingField({ size: R, pitch: 21, bar: 3.2, cross: 64, rod: 2.2, depth: 4, frame: 5, seed: 50 }),
    {
      base: 0xaaa8a0, seamDark: 0.55, toneNoise: 0.04, grain: 0.015,
      rough: { base: 0.55, seam: 0.2, centre: 0, blotch: 0.06, grain: 0.03 },
      ao: 0.55, aoBlur: 3, seed: 51,
    },
    2,
  ),
  // Painted welded steel (tank shells, valves, skids, stairs, pipes, columns) — tinted per tag.
  cover: () => bake(weldedField(R, 62), {
    base: 0xc8c6c0, seamDark: 0.8, toneNoise: 0.03, grain: 0.008,
    rough: { base: 0.48, seam: 0.12, centre: 0.04, blotch: 0.05, grain: 0.02 },
    ao: 0.5, aoBlur: 3, seed: 63,
  }, 3),
  // Derrick lattice — tinted oxide red.
  tower: () => bake(trussField(R, 74), {
    base: 0xc2bcb4, seamDark: 0.42, toneNoise: 0.04, grain: 0.012,
    rough: { base: 0.5, seam: 0.2, centre: 0.05, blotch: 0.06, grain: 0.02 },
    ao: 0.75, aoBlur: 4, seed: 75,
    stain: { color: 0x8a6454, amount: 0.15, cell: 48, bias: 0.24, rough: 0.08, seed: 76 },
  }, 3),
};

// ── slots + tints keyed off the map's box tags ─────────────────────────────
const SLOT: Record<string, SurfaceKind> = {
  derrick: 'tower', column: 'cover', tank: 'cover', tankband: 'cover', doghouse: 'wall',
  building: 'wall', lintel: 'wall', pumphouse: 'wall', perimeter: 'wall',
  rack: 'platform', gantry: 'platform', crown: 'platform',
  pipe: 'cover', stair: 'cover', valve: 'cover', jack: 'cover', jackpost: 'cover', jackbeam: 'cover', unit: 'cover', crownblock: 'cover', drum: 'cover', tankroof: 'cover',
};

const TINT: Record<string, number> = {
  derrick: 0xc8784e, // rust-orange oxide
  crownblock: 0xc8784e,
  column: 0xa4b0bc, // blue-grey steel
  tank: 0xfcf8f0, // cream shell
  tankband: 0x5e82b0, // steel-blue band
  doghouse: 0x86b8ae,
  building: 0x86b8ae, // teal cladding
  lintel: 0x86b8ae,
  pumphouse: 0xa6bccc, // pale blue cladding
  perimeter: 0xd6ccbe, // site fence, warm grey
  pipe: 0xf5b235, // gas-line yellow
  stair: 0xb4b8bc,
  valve: 0x6f92b8, // blue valve housings
  jack: 0x8a8c90,
  jackpost: 0x8a8c90,
  jackbeam: 0xe2b050, // horse-head ochre
  unit: 0xdadad6,
  drum: 0xe6dccb,
  tankroof: 0xdcd8d0,
};

// ── lights ─────────────────────────────────────────────────────────────────
const SODIUM = 0xffb468;
const FLOOD = 0xffd8a8;
const AVIATION = 0xff3a2a;

// 180° rotation about the y axis (the map's symmetry): mirrors x and z.
const ROT_FACE: Record<Face, Face> = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z', '+y': '+y', '-y': '-y' };
function rotLight(l: LightDef): LightDef {
  const r = (v: V3): V3 => [-v[0], v[1], -v[2]];
  return { ...l, at: r(l.at), face: ROT_FACE[l.face], ...(l.spot ? { spot: { ...l.spot, dir: r(l.spot.dir) } } : {}) };
}

// East (+x) face plane of a tank's rectangle at `deg` (maps/derrick.ts
// builds each tank from rectangles whose corners sit on the circle).
const tankFace = (cx: number, r: number, deg: number) => cx + r * Math.cos((deg * Math.PI) / 180);
// Flush ladder stripe (emissive-free: a dim strip) from y0 to y1 on a +x face.
const ladder = (x: number, z: number, y0: number, y1: number): LightDef => ({
  at: [x, (y0 + y1) / 2, z], face: '+x', size: [0.45, y1 - y0], color: 0xe8b040, intensity: 0, range: 1, kind: 'strip', level: 0.28,
});

// One of each rotational pair (see maps/derrick.ts for the geometry).
const HALF_LIGHTS: LightDef[] = [
  // Floods under the derrick decks.
  downLight([6.5, 4.5, -1.2], SODIUM, 70, 13, { size: [1.2, 0.6] }),
  downLight([0, 9.5, 6.5], FLOOD, 110, 17, { size: [0.6, 1.2], angle: 1.2 }),
  wallLamp([0, 4.2, 3], '+z', FLOOD, 60, 14, { size: [1.0, 0.5], down: 0.6, angle: 1.1 }),
  // Under the east pipe rack.
  downLight([14, 5.5, 12], SODIUM, 55, 12, { size: [1.0, 0.5] }),
  downLight([14, 5.5, -12], SODIUM, 55, 12, { size: [1.0, 0.5] }),
  // NE control building: yard face, rack face, pass-through, back lane.
  wallLamp([19, 3.4, 12], '-z', SODIUM, 45, 12, { size: [0.9, 0.45], down: 0.7 }),
  wallLamp([17, 3.4, 16.5], '-x', SODIUM, 40, 11, { size: [0.9, 0.45], down: 0.7 }),
  downLight([22, 3.5, 14], FLOOD, 60, 8, { size: [0.5, 1.2], angle: 1.3 }),
  downLight([22, 3.5, 19.5], FLOOD, 60, 8, { size: [0.5, 1.2], angle: 1.3 }),
  wallLamp([22, 4.0, 21], '+z', SODIUM, 40, 12, { size: [0.9, 0.4], down: 0.8 }),
  // Pump houses.
  wallLamp([25, 2.4, 1], '-x', SODIUM, 32, 10, { size: [0.7, 0.35], down: 0.7 }),
  wallLamp([-4, 2.4, 16.5], '-z', SODIUM, 32, 10, { size: [0.7, 0.35], down: 0.7 }),
  // Tank farm: lamp on the big tank's rack side, a safety-yellow ladder
  // stripe up each tank's east face.
  wallLamp([tankFace(-22, 4.5, 27), 3.2, 13 - 1.37], '+x', SODIUM, 40, 11, { size: [0.8, 0.4], down: 0.7 }),
  ladder(tankFace(-22, 4.5, 9), 13, 0.4, 7.3),
  ladder(tankFace(-26, 3.5, 9), 23.5, 0.4, 5.3),
];

const LIGHTS: LightDef[] = [
  ...HALF_LIGHTS,
  ...HALF_LIGHTS.map(rotLight),
  // Aviation reds: crown lip, upper derrick band, a beacon on the crown block.
  ...band4(box(-4, 14, -4, 4, 14.5, 4), 14.25, 0.18, AVIATION, 0.7),
  ...band4(box(-1.5, 6, -1.5, 1.5, 14, 1.5), 12.2, 0.25, AVIATION, 0.6),
  { at: [0, 15.6, 0], face: '+y', size: [0.5, 0.5], color: AVIATION, intensity: 0, range: 1, kind: 'strip', level: 0.9 },
];

// ── skyline: a working refinery around the yard ───────────────────────────
// Render-only silhouettes outside the bounds, standing on a dark apron (the
// plant's ground plane). The sun side (+x) stays a backlit silhouette wall;
// faces turned to the sun get a warm lit skin; rows of lit windows, ring
// lamps on the columns and red beacons make it a plant at work, not boxes.
// Tall stacks sit ≥ 90 m out and thick, so they don't smear at the frame
// edge of a wide FOV.
const DARK = 0x2a1d1a;
const HAZE = 0x33241f;
const LIT = 0x6e4e3e; // sun-facing skin (+x faces)
const WINDOW = 0xffc47a;
const RING = 0xffa050;
const BEACON = 0xff4a2a;

type Skyline = { props: SkyProp[]; lamps: LightDef[] };

function refinery(): Skyline {
  const props: SkyProp[] = [];
  const lamps: LightDef[] = [];
  // Fixture-only lamp on a skyline face (free: outside the bounds, no bake).
  const lamp = (at: V3, face: Face, size: [number, number], color: number): void => {
    lamps.push({ at, face, size, color, intensity: 0, range: 1, free: true });
  };

  // Ground. Concentric bands around the yard (non-overlapping, one level)
  // step from a dark strip at the fence toward the fog colour with distance;
  // pads, roads, trenches and lane dashes sit on them at rising levels (≥ 4 cm
  // apart so they never z-fight, all below the arena floor).
  const G = -0.15; // apron top
  const PAD = -0.1;
  const ROAD = -0.06;
  const MARK = -0.02;
  const frame = (d0: number, d1: number, y: number, color: number) => {
    const ix = 34 + d0, iz = 29 + d0, ox = 34 + d1, oz = 29 + d1;
    props.push(
      prop(-ox, y - 0.3, -oz, ox, y, -iz, color),
      prop(-ox, y - 0.3, iz, ox, y, oz, color),
      prop(-ox, y - 0.3, -iz, -ix, y, iz, color),
      prop(ix, y - 0.3, -iz, ox, y, iz, color),
    );
  };
  frame(0, 4, G, 0x241b18); // fence strip
  frame(4, 40, G, 0x3a2c26);
  frame(40, 100, G, 0x4a382e);
  frame(100, 240, G, 0x5e4436);
  // Access roads (7 m asphalt), a pipe trench on the yard side of each, and
  // dashed centre lines out to ~160 m.
  const ASPHALT = 0x2c2524;
  const TRENCH = 0x1a1412;
  const DASH = 0x9a8866;
  for (const z of [-44, 44]) {
    props.push(prop(-230, G, z - 3.5, 230, ROAD, z + 3.5, ASPHALT));
    const t = z > 0 ? z - 5.5 : z + 4.3;
    props.push(prop(-230, G, t, 230, ROAD, t + 1.2, TRENCH));
    for (let x = -160; x < 160; x += 12) props.push(prop(x, ROAD, z - 0.15, x + 4, MARK, z + 0.15, DASH));
  }
  for (const x of [-64, 64]) {
    for (const [z0, z1] of [[-230, -47.5], [-40.5, 40.5], [47.5, 230]]) {
      props.push(prop(x - 3.5, G, z0, x + 3.5, ROAD, z1, ASPHALT));
      for (let z = z0 + 4; z + 4 < z1 && Math.abs(z) < 160; z += 12) props.push(prop(x - 0.15, ROAD, z, x + 0.15, MARK, z + 4, DASH));
    }
    const t = x > 0 ? x - 5.5 : x + 4.3;
    props.push(prop(t, G, -230, t + 1.2, ROAD, 230, TRENCH));
  }

  // Plant blocks stand on a concrete pad and a plinth; big ones get a
  // cornice under the roof line. Its +x face gets the lit skin when `sunlit`.
  const block = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color = DARK, sunlit = false, beacon?: number) => {
    props.push(prop(x0, y0, z0, x1, y1, z1, color, beacon));
    if (sunlit) props.push(prop(x1, y0, z0, x1 + 0.08, y1, z1, LIT));
    if (y0 > 0 || y1 < 6) return;
    props.push(prop(x0 - 4, G, z0 - 4, x1 + 4, PAD, z1 + 4, 0x55453b));
    props.push(prop(x0 - 0.7, 0, z0 - 0.7, x1 + 0.7, 1.2, z1 + 0.7, sunlit ? 0x5a4236 : 0x3a2a24));
    if (Math.min(x1 - x0, z1 - z0) >= 10) props.push(prop(x0 - 0.5, y1 - 1.2, z0 - 0.5, x1 + 0.5, y1 - 0.85, z1 + 0.5, sunlit ? 0x5a4236 : 0x3a2a24));
  };
  // Elevated pipe run: two pipes on T-posts every ~12 m, along x or z.
  const pipeRun = (axis: 'x' | 'z', a0: number, a1: number, c: number, y = 4.5) => {
    const n = Math.max(1, Math.round((a1 - a0) / 12));
    const P = 0x2e2220;
    const seg = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number) =>
      props.push(axis === 'x' ? prop(u0, y0, v0, u1, y1, v1, P) : prop(v0, y0, u0, v1, y1, u1, P));
    seg(a0, a1, c - 1.1, c - 0.4, y, y + 0.7);
    seg(a0, a1, c + 0.2, c + 0.8, y + 0.1, y + 0.7);
    for (let k = 0; k <= n; k++) {
      const u = a0 + ((a1 - a0) * k) / n;
      seg(u - 0.2, u + 0.2, c - 0.2, c + 0.2, 0, y);
      seg(u - 0.25, u + 0.25, c - 1.4, c + 1.1, y - 0.3, y);
    }
  };
  pipeRun('x', 38, 118, 22);
  pipeRun('x', -96, 38 - 76, -14, 5);
  pipeRun('z', 36, 80, 30, 4);
  pipeRun('z', -80, -36, -40, 4.5);
  pipeRun('x', -70, 40, 60, 5.5);
  pipeRun('x', -44, 60, -62, 5);
  // Grid of lit windows on one face of a block (a hashed third stay dark).
  const windows = (face: Face, plane: number, u0: number, u1: number, y0: number, y1: number, cols: number, rows: number) => {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if ((i * 7 + j * 13 + cols) % 3 === 0) continue;
        const u = u0 + ((i + 0.5) * (u1 - u0)) / cols;
        const y = y0 + ((j + 0.5) * (y1 - y0)) / rows;
        const at: V3 = face[1] === 'x' ? [plane, y, u] : [u, y, plane];
        lamp(at, face, [1.6, 0.9], WINDOW);
      }
    }
  };
  // Distillation column: thick shaft, platform rings with lamps facing the
  // yard (`face` = the side toward the arena), a beacon on top.
  const column = (x: number, z: number, w: number, h: number, face: Face, sunlit = false) => {
    block(x - w / 2, 0, z - w / 2, x + w / 2, h, z + w / 2, DARK, sunlit, BEACON);
    for (const f of [0.35, 0.62, 0.86]) {
      const y = h * f;
      const e = w / 2 + 1.2;
      block(x - e, y, z - e, x + e, y + 0.6, z + e, DARK);
      const n = face === '-x' ? [-e, 0] : face === '+x' ? [e, 0] : face === '-z' ? [0, -e] : [0, e];
      lamp([x + n[0], y + 0.3, z + n[1]], face, [0.9, 0.35], RING);
    }
  };
  // Stepped storage tank (three crossed boxes).
  const tankProp = (x: number, z: number, r: number, h: number, sunlit = false) => {
    block(x - r, 0, z - r * 0.42, x + r, h, z + r * 0.42, HAZE, sunlit);
    block(x - r * 0.42, 0, z - r, x + r * 0.42, h, z + r, HAZE, sunlit);
    block(x - r * 0.72, 0, z - r * 0.72, x + r * 0.72, h, z + r * 0.72, HAZE, sunlit);
  };

  // East, the sun side: backlit silhouette wall.
  column(100, 10, 6, 48, '-x');
  column(112, 28, 5, 38, '-x');
  column(96, -20, 7, 34, '-x');
  block(118, 0, -14, 144, 24, 12);
  windows('-x', 118, -12, 10, 3, 21, 7, 4);
  block(128, 24, -4, 132, 44, 0, DARK, false, BEACON);
  block(150, 0, -50, 155, 74, -45, DARK, false, BEACON); // flare stack
  block(86, 0, 36, 106, 12, 50);
  windows('-x', 86, 38, 48, 3, 10, 4, 2);
  tankProp(92, -56, 11, 14);
  tankProp(124, 54, 12, 15);
  // South.
  block(-24, 0, -104, 10, 16, -90, HAZE, true);
  windows('+z', -90, -22, 8, 2, 14, 9, 3);
  tankProp(-44, -80, 10, 12, true);
  tankProp(28, -84, 9, 11, true);
  column(-62, -96, 6, 42, '+z', true);
  block(46, 0, -118, 51, 72, -113, DARK, true, BEACON); // flare stack
  // North.
  tankProp(14, 92, 12, 14, true);
  tankProp(-28, 98, 9, 11, true);
  column(46, 96, 6, 44, '-z', true);
  block(-66, 0, 80, -42, 20, 96, HAZE, true);
  windows('-z', 80, -64, -44, 3, 18, 7, 4);
  // West, facing the sun: lit skins, lower blocks.
  block(-124, 0, -26, -96, 16, 2, HAZE, true);
  windows('+x', -95.92, -24, 0, 2, 14, 8, 3);
  column(-104, 22, 6, 32, '+x', true);
  tankProp(-100, 50, 10, 12, true);
  block(-136, 0, -76, -131, 64, -71, DARK, true, BEACON); // flare stack
  return { props, lamps };
}

const SKYLINE = refinery();

export const RUSTDUSK: WorldTheme = {
  id: 'rustdusk',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 3.2,
  slots: {
    floor: { metalness: 0.0, normalScale: 0.6, ao: 0.6 },
    ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
    wall: { metalness: 0.2, normalScale: 0.8, ao: 0.6 },
    cover: { metalness: 0.25, normalScale: 0.8, ao: 0.7 },
    platform: { metalness: 0.4, normalScale: 1.0, ao: 0.85 },
    tower: { metalness: 0.25, normalScale: 0.8, ao: 0.7 },
  },
  slotFor: (i, b, k) => (b.tag && SLOT[b.tag]) || defaultSlot(i, b, k),
  tintFor: (_i, b) => (b.tag ? TINT[b.tag] ?? null : null),
  trim: null,
  dress: {
    slot: 'cover', tint: 0xbab6b0, bright: 1.0,
    crown: { h: 0.3, d: 0.1 },
    collars: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.35, d: 0.08 },
    edges: { h: 0.2, d: 0.03, hazard: false },
  },
  inlays: [
    ...hazardRing(box(-3, 0, -3, 3, 6, 3), 0.6, 0.4),
  ],
  skyline: SKYLINE.props,
  lights: [...LIGHTS, ...SKYLINE.lamps],
  bake: {
    ambientUp: 0xb0a0b4, ambientDown: 0x7a6258, ambient: 0.36,
    sky: { color: 0xa8aad0, intensity: 0.6 },
    ao: { radius: 2.4, strength: 0.75 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.45,
    maxTexels: 240_000,
  },
  sun: { dir: norm([0.86, 0.42, -0.28]), color: 0xffb070, intensity: 2.6, mapScale: 1.0 },
  hemi: { sky: 0xa89ac0, ground: 0x6a4a3a, intensity: 0.6, mapScale: 0.2 },
  fill: { dir: norm([-0.7, 0.45, 0.4]), color: 0x8c90d0, intensity: 0.45, mapScale: 0.35 },
  env: { intensity: 0.4, mapScale: 0.6 },
  worldSaturation: 0.85,
  satCap: 0.68,
  shadowBox: 60,
  exposure: 1.05,
  fog: { color: 0xb07050, near: 40, far: 210 },
  background: 0x4a2c26,
  sky: {
    mode: 'dusk', top: 0x2c3462, mid: 0xc8683e, horizon: 0xffa050, ground: 0x5a3a2c,
    sunColor: 0xffd49a, sunSize: 0.045, sunGlow: 1.3, band: 0.5,
  },
};
