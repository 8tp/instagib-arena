// Look for the 'lounge' arena: a bright, daylit open-plan living room + kitchen
// at rat scale (the Ratz Instagib homage). Clean colour blocking on white:
// warm-white plaster, light oak, teal kitchen, coral sofa, mustard accents.
import { FACE_NORMAL, defaultSlot, norm, type Inlay, type LightDef, type WorldTheme } from '../theme-kit';
import type { MapBox } from '../../maps/kit';
import { bake, flatField, newField, noiseField, noiseField2, panelField, planksField, type Field } from '../../textures';

// ── local field generators ────────────────────────────────────────────────

// Woven upholstery: a fine basket weave (over/under pairs) + slub noise.
function weaveField(size: number, pitch: number, seed: number): Field {
  const f = newField(size);
  const slub = noiseField2(size, size / 2, 2, seed);
  const soft = noiseField(size, size / 4, seed + 7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cx = Math.floor(x / pitch);
      const cy = Math.floor(y / pitch);
      const lx = (x % pitch) / pitch - 0.5;
      const ly = (y % pitch) / pitch - 0.5;
      // Alternate warp / weft cells; each thread is a soft ridge.
      const warp = (cx + cy) % 2 === 0;
      const r = warp ? 1 - (2 * lx) ** 2 : 1 - (2 * ly) ** 2;
      f.h[i] = r * 0.5 + (slub[i] - 0.5) * 0.3 + (soft[i] - 0.5) * 0.35;
      f.seam[i] = (1 - r) * 0.25;
      f.centre[i] = r;
    }
  }
  return f;
}

// Satin oak veneer: long stretched grain, no joints (furniture boards).
function veneerField(size: number, seed: number): Field {
  const f = newField(size);
  const g1 = noiseField2(size, size / 2, 2, seed);
  const g2 = noiseField2(size, size / 6, 1, seed + 3);
  const tone = new Float32Array(size * size);
  f.tone = tone;
  for (let i = 0; i < size * size; i++) {
    const g = (g1[i] - 0.5) * 0.7 + (g2[i] - 0.5) * 0.3;
    f.h[i] = g * 0.5;
    f.centre[i] = 0.5 + g * 0.4;
    tone[i] = g * 0.07;
  }
  return f;
}

const TEXTURES: WorldTheme['textures'] = {
  // Light oak boards, 2 m wide at rat scale (real 20 cm).
  floor: () => bake(
    planksField({ size: 256, rows: 4, segs: 1, gap: 0.6, bevel: 1.0, depth: 1.6, grain: 0.7, tone: 0.05, seed: 14 }),
    {
      base: 0xc9a47a, seamDark: 0.55, toneNoise: 0.015, grain: 0.008,
      rough: { base: 0.46, seam: 0.25, centre: 0.08, blotch: 0.05, grain: 0.02 },
      ao: 0.6, aoBlur: 2, seed: 15,
    },
    8,
  ),
  // Warm-white plaster.
  wall: () => bake(flatField({ size: 128, wobble: 0.35, seed: 27 }), {
    base: 0xeeeae2, seamDark: 1, toneNoise: 0.012, grain: 0.006,
    rough: { base: 0.85, seam: 0, centre: 0, blotch: 0.03, grain: 0.02 },
    ao: 0.15, aoBlur: 3, seed: 28,
  }, 8),
  ceiling: () => bake(flatField({ size: 128, wobble: 0.4, seed: 38 }), {
    base: 0xf3f1ec, seamDark: 1, toneNoise: 0.01, grain: 0.005,
    rough: { base: 0.92, seam: 0, centre: 0, blotch: 0.02, grain: 0.01 },
    ao: 0.1, aoBlur: 3, seed: 39,
  }, 12),
  // Pale oak veneer — tinted per piece (oak, white, charcoal, book spines).
  platform: () => bake(veneerField(256, 44), {
    base: 0xeadcc6, seamDark: 1, toneNoise: 0.01, grain: 0.006,
    rough: { base: 0.5, seam: 0, centre: 0.06, blotch: 0.04, grain: 0.02 },
    ao: 0.2, aoBlur: 3, seed: 45,
  }, 8),
  // Woven fabric, near-white so the tints read true.
  cover: () => bake(weaveField(256, 4, 56), {
    base: 0xebe7e1, seamDark: 0.93, toneNoise: 0.015, grain: 0.01,
    rough: { base: 0.92, seam: 0.04, centre: 0, blotch: 0.03, grain: 0.03 },
    ao: 0.12, aoBlur: 2, seed: 57, normalStrength: 0.6,
  }, 4),
  // Handleless lacquer cabinet doors (6 × 6 m), near-white.
  tower: () => bake(
    panelField({ size: 256, cols: 2, rows: 2, seamHalf: 1.1, bevel: 1.4, depth: 2.2, rivets: 'none', wobble: 0.2, seed: 69 }),
    {
      base: 0xf0efeb, seamDark: 0.45, toneNoise: 0.008, grain: 0.004,
      rough: { base: 0.38, seam: 0.3, centre: 0.06, blotch: 0.03, grain: 0.01 },
      ao: 0.5, aoBlur: 2, seed: 70,
    },
    12,
  ),
};

// ── palette (tints multiply the near-white slot albedos) ──────────────────
// Ratz-style blocking: calm white / oak architecture, bold red, cyan and
// purple on the furniture (satCap raised so they stay saturated), a deep
// navy bookcase back so players read against it.
const OAK = 0xe2c197;
const WHITE = 0xffffff;
const CHARCOAL = 0x5c5e66;
const CYAN = 0x17a9bd;
const RED = 0xe2362a;
const RED_LT = 0xee5244;
const YELLOW = 0xf2b322;
const PURPLE = 0x7a4bd6;
const TERRACOTTA = 0xc8603c;
const LEAF = 0x3fa050;
const NAVY = 0x2e3d68;
const GREEN = 0x36b85a;
const STEEL = 0xd4dade;

const COVER = new Set(['sofa', 'sofa-back', 'sofa-arm', 'cushion', 'pillow', 'armchair', 'armchair-back', 'armchair-arm', 'pouffe']);
const TOWER = new Set(['cabinet', 'pantry', 'console', 'bin']);
const WALL = new Set(['stair-core', 'case-back', 'case-top', 'case-side']);

const TINT: Record<string, number> = {
  // kitchen
  cabinet: CYAN, pantry: CYAN, plinth: CHARCOAL, worktop: OAK, fridge: STEEL, handle: CHARCOAL, shelf: OAK,
  bin: STEEL, stepstool: YELLOW, stool: OAK, 'stool-leg': CHARCOAL,
  // dining
  table: OAK, 'table-leg': CHARCOAL, chair: WHITE, 'chair-back': WHITE, 'chair-leg': CHARCOAL,
  // stairs + gallery
  stair: OAK, gallery: OAK, post: CHARCOAL, rail: CHARCOAL, 'stair-core': WHITE,
  // living
  sofa: RED, 'sofa-back': RED, 'sofa-arm': RED, cushion: RED_LT, pillow: CYAN,
  coffee: WHITE, 'coffee-leg': CHARCOAL, console: WHITE, tv: 0x26282c, pouffe: CYAN,
  armchair: PURPLE, 'armchair-back': PURPLE, 'armchair-arm': PURPLE,
  'block-a': RED, 'block-b': CYAN, 'block-c': PURPLE, carton: 0xc89a66, basket: 0xd8c49a, pot: TERRACOTTA, leaf: LEAF,
  // bookcase
  'case-side': WHITE, 'case-top': WHITE, 'case-back': NAVY, 'case-shelf': OAK,
  'book-a': RED, 'book-b': CYAN, 'book-c': GREEN, 'book-d': PURPLE,
};

const slotOf = (b: MapBox) => {
  const t = b.tag ?? '';
  if (COVER.has(t)) return 'cover' as const;
  if (TOWER.has(t)) return 'tower' as const;
  if (WALL.has(t)) return 'wall' as const;
  return t in TINT ? ('platform' as const) : null;
};

// ── light rig: daylight through big windows + soft ceiling fill ───────────
const DAY = 0xfff3e0; // window daylight
const SKY = 0x78b4ff; // window glass (sky seen through it)
const GARDEN = 0x3f9a52; // lower panes: the garden / tree line outside
const WARM = 0xffe2b8; // interior lamps

// A window as a grid of framed panes (fixture only) on an inner wall face:
// sky-gradient glass above, the garden's tree line in the bottom row.
function windowGrid(c: [number, number, number], face: LightDef['face'], w: number, h: number, cols: number, rows: number): LightDef[] {
  const out: LightDef[] = [];
  const ua = face[1] === 'x' ? 2 : 0;
  const pw = w / cols;
  const ph = h / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const at: [number, number, number] = [...c];
      at[ua] = c[ua] - w / 2 + pw * (i + 0.5);
      at[1] = c[1] - h / 2 + ph * (j + 0.5);
      const low = rows > 1 && j === 0;
      out.push({
        at, face, size: [pw - 0.36, ph - 0.36], color: low ? GARDEN : SKY, intensity: 0, range: 1,
        kind: 'window', level: low ? 0.8 : 1.3,
      });
    }
  }
  return out;
}
// Daylight shaft from a window: a soft spot aimed down into the room.
const shaft = (at: [number, number, number], face: LightDef['face'], dir: [number, number, number], intensity: number, range: number): LightDef => ({
  at, face, size: [0.01, 0.01], color: DAY, intensity, range, out: 1.5, radius: 0.8, fixture: false,
  spot: { dir: norm(dir), angle: 0.9, penumbra: 0.9 },
});
// Long flush light bar on the ceiling (the cap underside is at y = 30),
// between the beams; intensity 0 = fixture only (keeps the bake cheap).
const bar = (x: number, z: number, intensity: number): LightDef => ({
  at: [x, 30, z], face: '-y', size: [1.8, 16], color: WARM, intensity, range: 34, out: 0.6, radius: 0.8,
  kind: 'lamp', spot: { dir: [0, -1, 0], angle: 1.25, penumbra: 0.8 }, level: 0.85,
});
const LIT_BARS = new Set(['-18,-14', '18,-14', '-18,14', '18,14']);

// Wall-washer sconce throwing light up the wall onto the ceiling.
const uplight = (at: [number, number, number], face: LightDef['face']): LightDef => {
  const n = FACE_NORMAL[face];
  return {
    at, face, size: [1.6, 0.7], color: WARM, intensity: 600, range: 32, out: 0.8, radius: 0.5, level: 0.8,
    spot: { dir: norm([n[0] * 0.4, 1, n[2] * 0.4]), angle: 1.25, penumbra: 0.7 },
  };
};

const LIGHTS: LightDef[] = [
  // south wall: two tall living-room windows + one over the stairs
  ...windowGrid([-38, 16, 35], '-z', 9, 18, 2, 3),
  ...windowGrid([2, 16, 35], '-z', 12, 18, 2, 3),
  ...windowGrid([26, 21.5, 35], '-z', 16, 11, 3, 2),
  shaft([-38, 20, 35], '-z', [0.1, -0.8, -0.6], 1400, 50),
  shaft([2, 20, 35], '-z', [0, -0.8, -0.6], 1600, 50),
  // east wall over the gallery
  ...windowGrid([47, 20.5, -16], '-x', 11, 13, 2, 2),
  ...windowGrid([47, 20.5, 4], '-x', 11, 13, 2, 2),
  shaft([47, 22, -16], '-x', [-0.8, -0.55, 0], 1000, 50),
  shaft([47, 22, 4], '-x', [-0.8, -0.55, 0.1], 1000, 50),
  // kitchen window above the west shelf
  ...windowGrid([-24, 21.5, -35], '+z', 14, 9, 3, 1),
  shaft([-24, 22, -35], '+z', [0, -0.75, 0.66], 1100, 55),
  // ceiling light bars between the beams, four of them lit
  ...[-30, -18, -6, 6, 18, 30].flatMap((x) => [-14, 14].map((z) => bar(x, z, LIT_BARS.has(`${x},${z}`) ? 520 : 0))),
  // wall-washer uplights: wash the ceiling and the upper walls
  uplight([20, 24, -35], '+z'),
  uplight([-14, 24, 35], '-z'),
  uplight([47, 24, 22], '-x'),
  uplight([-43, 25, 0], '+x'),
  uplight([-40, 24, -35], '+z'),
  uplight([12, 24, 35], '-z'),
  // under-shelf kitchen strips (warm pools on the worktops)
  { at: [-24, 14.2, -33.2], face: '-y', size: [20, 0.5], color: WARM, intensity: 60, range: 10, out: 0.4, radius: 1.5, kind: 'strip', level: 0.7, spot: { dir: [0, -1, 0], angle: 1.3, penumbra: 0.8 } },
  { at: [20, 14.2, -33.2], face: '-y', size: [16, 0.5], color: WARM, intensity: 60, range: 10, out: 0.4, radius: 1.5, kind: 'strip', level: 0.7, spot: { dir: [0, -1, 0], angle: 1.3, penumbra: 0.8 } },
  // the TV screen: dim, cool, fixture only
  { at: [-24, 12.5, 34.4], face: '-z', size: [11.2, 6.2], color: 0x2a2e36, intensity: 0, range: 1, kind: 'strip', level: 0.1 },
];

// Rugs + worktop details (painted, 4 mm).
const rug = (x0: number, z0: number, x1: number, z1: number, border: number, field: number, w = 1.2): Inlay[] => [
  { min: [x0, 0, z0], max: [x1, 0, z1], color: border },
  { min: [x0 + w, 0.001, z0 + w], max: [x1 - w, 0.001, z1 - w], color: field },
];
const INLAYS: Inlay[] = [
  ...rug(-38, 17, -10, 29.8, 0x6d7f8c, 0xe4ddd0),
  ...rug(5, -12.5, 37, 12.5, 0xc98a52, 0xe9dcc4, 1.5),
  ...rug(-30, -27.5, 30, -22.5, 0x2a9aa8, 0xdde8e6, 0.8),
  // hob (east worktop) and sink (west worktop)
  { min: [16, 9, -34.2], max: [26, 9, -30], color: 0x1d1f22 },
  { min: [-30, 9, -34.2], max: [-21, 9, -30.2], color: 0xa9b0b6 },
];

export const LOUNGE: WorldTheme = {
  id: 'lounge',
  textures: TEXTURES,
  openSky: false,
  slots: {
    floor: { metalness: 0, normalScale: 0.6, ao: 0.6 },
    ceiling: { metalness: 0, normalScale: 0.3, ao: 0.3 },
    wall: { metalness: 0, normalScale: 0.3, ao: 0.3 },
    cover: { metalness: 0, normalScale: 0.25, ao: 0.6 },
    platform: { metalness: 0, normalScale: 0.4, ao: 0.4 },
    tower: { metalness: 0, normalScale: 0.6, ao: 0.6 },
  },
  slotFor: (i, b, k) => slotOf(b) ?? defaultSlot(i, b, k),
  tintFor: (_i, b) => (b.tag ? TINT[b.tag] ?? null : null),
  trim: null,
  dress: {
    slot: 'wall', tint: 0xffffff, bright: 1.05,
    baseboard: { h: 1.0, d: 0.12 },
    crown: { h: 0.7, d: 0.14 },
    beams: { spacing: 12, w: 1.4, d: 0.15 },
  },
  inlays: INLAYS,
  lights: LIGHTS,
  bake: {
    ambientUp: 0xfff4e6, ambientDown: 0xf2e6d6, ambient: 0.7,
    sky: null,
    ao: { radius: 3.0, strength: 0.75 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: true,
    texel: 0.5,
    maxTexels: 150_000,
  },
  sun: { dir: norm([0.35, 0.78, 0.52]), color: 0xfff0d8, intensity: 2.2, mapScale: 0.7 },
  hemi: { sky: 0xfff6ea, ground: 0xe2d4c0, intensity: 0.6, mapScale: 0.35 },
  fill: { dir: norm([-0.4, 0.3, -0.85]), color: 0xdfe8ff, intensity: 0.5, mapScale: 0.3 },
  env: { intensity: 0.4, mapScale: 0.5 },
  worldSaturation: 1.0,
  satCap: 0.8,
  exposure: 1.08,
  fog: { color: 0xe6ded2, near: 70, far: 320 },
  background: 0xe6ded2,
  sky: { mode: 'interior', top: 0xe6ded2, horizon: 0xe6ded2 },
};
