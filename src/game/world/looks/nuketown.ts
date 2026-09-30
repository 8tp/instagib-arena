// Look for the 'nuketown' arena: a cul-de-sac at golden hour. Mown lawns and
// warm asphalt, painted clapboard (mint west house, butter-yellow east house),
// white board fences, glossy vehicles, a pale water tower against a peach sky.
import { band4, dashes, downLight, mast, mastLamp, norm, prop, wallLamp, type Face, type Inlay, type LightDef, type SkyProp, type WorldTheme } from '../theme-kit';
import type { MapBox } from '../../maps/kit';
import { NUKETOWN } from '../../maps/nuketown';
import type { SurfaceKind } from '../../textures';
import type { V3 } from '../lightmap';
import { R, bake, flatField, panelField, planksField, type Field } from '../../textures';

// Swap u/v of a height-field recipe (vertical boards from planksField).
function transpose(f: Field): Field {
  const n = f.size;
  const t = (a: Float32Array) => {
    const o = new Float32Array(a.length);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) o[x * n + y] = a[y * n + x];
    return o;
  };
  return {
    size: n, h: t(f.h), seam: t(f.seam), rivet: t(f.rivet), line: t(f.line), centre: t(f.centre),
    ...(f.tone ? { tone: t(f.tone) } : {}), ...(f.mix ? { mix: t(f.mix) } : {}),
  };
}

// Slots: floor = mown lawn (streets/paths are painted on), wall = clapboard
// siding (tinted per house), ceiling (unused on an open-sky map) = white
// board fence, platform = deck boards, cover = vehicle paint, tower =
// painted steel / render (water tower, pump houses, billboard, roofs).
const TEXTURES: WorldTheme['textures'] = {
  floor: () => bake(flatField({ size: R, wobble: 0.8, stripes: 2, stripeWidth: 0.5, seed: 16 }), {
    base: 0x6f9a4c, base2: 0x7ea957, seamDark: 1, toneNoise: 0.05, grain: 0.05,
    rough: { base: 0.95, seam: 0, centre: 0, blotch: 0.03, grain: 0.03 },
    ao: 0.2, aoBlur: 2, seed: 17,
  }, 6),
  wall: () => bake(
    planksField({ size: R, rows: 16, segs: 0, gap: 0.7, bevel: 2.5, depth: 3, grain: 0.15, tone: 0.012, seed: 29 }),
    {
      base: 0xeeeae2, seamDark: 0.62, toneNoise: 0.02, grain: 0.008,
      rough: { base: 0.7, seam: 0.12, centre: 0.02, blotch: 0.03, grain: 0.02 },
      ao: 0.8, aoBlur: 4, seed: 30,
    },
    4,
  ),
  ceiling: () => bake(
    transpose(planksField({ size: R, rows: 8, segs: 0, gap: 1.0, bevel: 2, depth: 3, grain: 0.3, tone: 0.03, seed: 38 })),
    {
      base: 0xece6da, seamDark: 0.55, toneNoise: 0.02, grain: 0.012,
      rough: { base: 0.8, seam: 0.1, centre: 0.02, blotch: 0.04, grain: 0.02 },
      ao: 0.8, aoBlur: 3, seed: 39,
    },
    3,
  ),
  platform: () => bake(
    planksField({ size: R, rows: 10, segs: 2, gap: 0.9, bevel: 1.4, depth: 2, grain: 0.5, tone: 0.05, seed: 46 }),
    {
      base: 0xb48a62, seamDark: 0.55, toneNoise: 0.03, grain: 0.015,
      rough: { base: 0.72, seam: 0.2, centre: 0.05, blotch: 0.05, grain: 0.03 },
      ao: 0.7, aoBlur: 3, seed: 47,
    },
    4,
  ),
  cover: () => bake(flatField({ size: 128, wobble: 0.25, seed: 58 }), {
    base: 0xd6d4d0, seamDark: 1, toneNoise: 0.015, grain: 0.004,
    rough: { base: 0.5, seam: 0, centre: 0.04, blotch: 0.04, grain: 0.01 },
    ao: 0.1, aoBlur: 2, seed: 59,
  }, 4),
  tower: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 1, bevel: 2, depth: 2, rivets: 'none', wobble: 0.5, seed: 71 }),
    {
      base: 0xe2ddd4, seamDark: 0.7, lineTint: 0.95, toneNoise: 0.025, grain: 0.008,
      rough: { base: 0.6, seam: 0.15, centre: 0.05, blotch: 0.05, grain: 0.02 },
      ao: 0.6, aoBlur: 3, seed: 72,
    },
    4,
  ),
};

// ── per-tag material + tint ──────────────────────────────────────────────
const west = (b: MapBox) => b.min.x + b.max.x < 0;
const SLOT: Record<string, SurfaceKind> = {
  house: 'wall', partition: 'wall', garage: 'wall', shed: 'wall', hut: 'wall',
  fence: 'ceiling', perimeter: 'ceiling',
  floor2: 'platform', roof2: 'platform', stair: 'platform', treehouse: 'platform', catwalk: 'platform',
  crate: 'ceiling', table: 'platform', trunk: 'ceiling',
  roof: 'tower', chimney: 'tower', pump: 'tower', leg: 'tower', tank: 'tower', post: 'tower', sign: 'tower',
  bus: 'cover', wheel: 'cover', truck: 'cover', truckcab: 'cover', carB: 'cover', carT: 'cover', carR: 'cover', boat: 'cover', rv: 'cover',
  hedge: 'floor',
};
function tint(b: MapBox): number | null {
  const w = west(b);
  switch (b.tag) {
    case 'house': return w ? 0x9fd6b6 : 0xf5d98e; // mint / butter yellow
    case 'garage': return w ? 0xbfe3cc : 0xf8e4b0;
    case 'partition': return 0xf4ecdc;
    case 'shed': return 0xc0584a; // barn red
    case 'hut': return 0x8fc0d8; // sky-blue clubhouse
    case 'fence': return null;
    case 'perimeter': return 0xe2dccf;
    case 'floor2': return 0xe8c8a0;
    case 'roof2': return 0xb9aea0;
    case 'roof': return 0xc9c2b8;
    case 'stair': return 0xc79a6c;
    case 'treehouse': return 0xa8784c;
    case 'trunk': return 0x8a6448;
    case 'crate': return 0xc89a5c;
    case 'table': return 0xc88a58;
    case 'chimney': return 0xb8674e;
    case 'pump': return 0xcfc6b6;
    case 'leg': return 0x8a4034; // oxide-red steel
    case 'tank': return 0xdfe8ea;
    case 'post': return 0x6e6a66;
    case 'sign': return 0xf2ead8;
    case 'bus': return 0xf2aa00; // school-bus yellow
    case 'wheel': return 0x2a2a2e; // school-bus yellow
    case 'truck': return 0xf2f0ea;
    case 'truckcab': return 0x2f5ea0;
    case 'carB': return 0xb83228; // red sedan
    case 'carT': return 0x2a8a88; // teal sedan
    case 'carR': return w ? 0x4a68b0 : 0xd06a20;
    case 'boat': return 0xf0f0ec;
    case 'rv': return 0xece2cc;
    case 'hedge': return 0x5e7e3c;
    default: return null;
  }
}

// ── lights ───────────────────────────────────────────────────────────────
const WARM = 0xffc27a; // interior tungsten
const PORCH = 0xffd08a;
const SODIUM = 0xffb060;

// Both houses: interior pools (visible through the windows), porch, balcony
// and garage lamps. `s` = −1 west, +1 east.
function houseLights(s: number): LightDef[] {
  const out: LightDef[] = [];
  const fx = (x: number) => s * x; // x given as a distance from the axis
  const front: Face = s < 0 ? '+x' : '-x';
  // ground floor (upper slab underside y 4), upper floor (roof underside 8.5)
  out.push(downLight([fx(21), 4, -3], WARM, 55, 10, { size: [0.8, 0.8] }));
  out.push(downLight([fx(29), 4, -5], WARM, 48, 9, { size: [0.8, 0.8] }));
  out.push(downLight([fx(27), 8.5, 2], WARM, 55, 10, { size: [0.8, 0.8] }));
  out.push(downLight([fx(27), 8.5, -6], WARM, 48, 9, { size: [0.8, 0.8] }));
  out.push(downLight([fx(25), 4, -16.5], WARM, 48, 9, { size: [1.0, 0.5] })); // garage
  // up-washers on the inner walls so the rooms read (ceiling bounce)
  const back: Face = s < 0 ? '-x' : '+x';
  const up = (at: V3, face: Face) => wallLamp(at, face, WARM, 22, 7, { size: [0.5, 0.3], down: -0.9, angle: 1.2, level: 0.8 });
  out.push(up([fx(24.8), 2.9, -4.5], front));
  out.push(up([fx(25.2), 2.9, 5], back));
  out.push(up([fx(32.6), 7.2, 6], front));
  out.push(up([fx(20.9), 7.2, -2.75], back));
  // porch lamps either side of the front door, balcony lamps
  out.push(wallLamp([fx(17), 3.0, -2.4], front, PORCH, 18, 7, { size: [0.35, 0.5], down: 0.8 }));
  out.push(wallLamp([fx(17), 3.0, 2.4], front, PORCH, 18, 7, { size: [0.35, 0.5], down: 0.8 }));
  out.push(wallLamp([fx(20.5), 7.4, -2.75], front, PORCH, 16, 7, { size: [0.35, 0.5], down: 0.8 }));
  out.push(wallLamp([fx(20.5), 7.4, 2.25], front, PORCH, 16, 7, { size: [0.35, 0.5], down: 0.8 }));
  // over the garage door
  out.push(wallLamp([fx(19), 3.7, -16.5], front, PORCH, 22, 9, { size: [0.9, 0.25], down: 1.2 }));
  return out;
}

// Vehicle glass + lamps (fixture only): bus side windows and windscreen,
// truck cab glass, and each sedan's cabin glass read off the map boxes.
const GLASS = 0x8fb4d8;
const glass = (at: V3, face: Face, w: number, h: number, level = 0.45): LightDef =>
  ({ at, face, size: [w, h], color: GLASS, intensity: 0, range: 1, kind: 'window', level });
// Plain tinted pane (no frame / mullions) for the small car + cab glass.
const pane = (at: V3, face: Face, w: number, h: number): LightDef =>
  ({ at, face, size: [w, h], color: 0x5a7aa8, intensity: 0, range: 1, kind: 'strip', level: 0.16 });
const lamp = (at: V3, face: Face, color: number, level: number): LightDef =>
  ({ at, face, size: [0.34, 0.16], color, intensity: 0, range: 1, kind: 'strip', level });
function vehicleGlass(): LightDef[] {
  const out: LightDef[] = [];
  for (let z = 15.4; z <= 24.4; z += 1.5) {
    out.push(glass([-8, 2.55, z], '-x', 1.15, 0.8), glass([-4.8, 2.55, z], '+x', 1.15, 0.8));
  }
  out.push(glass([-6.4, 2.65, 14], '-z', 2.5, 1.0));
  for (const dx of [-0.95, 0.95]) out.push(lamp([-6.4 + dx, 1.25, 12.8], '-z', 0xfff0d0, 0.5));
  // truck cab
  out.push(pane([6.4, 1.75, -14], '+z', 2.4, 0.7));
  out.push(pane([4.9, 1.75, -15.3], '-x', 1.2, 0.6), pane([7.9, 1.75, -15.3], '+x', 1.2, 0.6));
  for (const dx of [-1.0, 1.0]) out.push(lamp([6.4 + dx, 0.8, -14], '+z', 0xfff0d0, 0.5));
  // sedans: cabin (raised box) + body (floor box with the same tag)
  const boxes = NUKETOWN.boxes;
  for (const cab of boxes) {
    if (!cab.tag?.startsWith('car') || cab.min.y < 0.9) continue;
    const body = boxes.find((b) => b.tag === cab.tag && b.min.y === 0 && b.max.y <= cab.min.y + 1e-3 &&
      b.min.x <= cab.min.x && b.max.x >= cab.max.x && b.min.z <= cab.min.z && b.max.z >= cab.max.z);
    if (!body) continue;
    const cx = (cab.min.x + cab.max.x) / 2;
    const cz = (cab.min.z + cab.max.z) / 2;
    const bz = (body.min.z + body.max.z) / 2;
    const y = (cab.min.y + cab.max.y) / 2 + 0.04;
    const len = cab.max.z - cab.min.z;
    const wid = cab.max.x - cab.min.x;
    out.push(pane([cab.min.x, y, cz], '-x', len * 0.82, 0.4), pane([cab.max.x, y, cz], '+x', len * 0.82, 0.4));
    out.push(pane([cx, y, cab.min.z], '-z', wid * 0.8, 0.4), pane([cx, y, cab.max.z], '+z', wid * 0.8, 0.4));
    const frontIsMax = bz > cz;
    const fz = frontIsMax ? body.max.z : body.min.z;
    const rz = frontIsMax ? body.min.z : body.max.z;
    const ff: Face = frontIsMax ? '+z' : '-z';
    const rf: Face = frontIsMax ? '-z' : '+z';
    for (const dx of [-0.68, 0.68]) {
      out.push(lamp([cx + dx, 0.72, fz], ff, 0xfff0d0, 0.45));
      out.push(lamp([cx + dx, 0.72, rz], rf, 0xff4030, 0.35));
    }
  }
  return out;
}

// Billboard: painted art on the sign face (−z), lit by three floods on the
// catwalk deck aimed up at it.
function billboardLights(): LightDef[] {
  const strip = (x: number, y: number, w: number, h: number, color: number, level: number): LightDef => ({
    at: [x, y, 32], face: '-z', size: [w, h], color, intensity: 0, range: 1, kind: 'strip', level,
  });
  const out: LightDef[] = [
    strip(0, 9.9, 18.4, 1.3, 0xd05a40, 0.12), // red title band
    strip(-5.2, 7.9, 6.6, 1.6, 0x4a8aa8, 0.1),
    strip(2.6, 7.9, 6.6, 1.6, 0xe8b040, 0.12),
    strip(7.8, 7.9, 2.6, 1.6, 0x5a9a60, 0.11),
  ];
  for (const x of [-6, 0, 6]) {
    out.push({
      at: [x, 6, 30.2], face: '+y', size: [0.8, 0.35], color: 0xffe0b0, intensity: 40, range: 9, out: 0.3, radius: 0.2,
      spot: { dir: norm([0, 1, 0.55]), angle: 0.9, penumbra: 0.5 },
    });
  }
  return out;
}

function towerLights(): LightDef[] {
  const tank = { min: { x: -3.5, y: 11, z: -33 }, max: { x: 3.5, y: 16, z: -26 } };
  return [
    ...band4(tank, 15.4, 0.35, 0xff6a3a, 0.35), // painted rim stripe
    downLight([-4.2, 10.5, -25.6], SODIUM, 40, 12, { size: [0.7, 0.4] }),
    downLight([4.2, 10.5, -25.6], SODIUM, 40, 12, { size: [0.7, 0.4] }),
    // lit windows on the pump houses
    ...[-1, 1].map((s): LightDef => ({ at: [s * 8, 3, -31.7], face: s < 0 ? '+x' : '-x', size: [1.6, 1.0], color: WARM, intensity: 0, range: 1, kind: 'window', level: 0.8 })),
  ];
}

// ── paint: street, pavements, driveways, interior floors ────────────────
function paint(): Inlay[] {
  const ASPHALT = 0x5c5a60;
  const CONCRETE = 0xb3ab9e;
  const out: Inlay[] = [
    { min: [-10, 0, -21], max: [10, 0, 35], color: ASPHALT },
    { min: [-19, 0, -35], max: [19, 0, -21], color: ASPHALT },
  ];
  for (const s of [-1, 1]) {
    const X = (a: number, b: number): [number, number] => (s < 0 ? [a, b] : [-b, -a]);
    const iz = (x0: number, x1: number, z0: number, z1: number, color: number): Inlay => {
      const [a, b] = X(x0, x1);
      return { min: [a, 0, z0], max: [b, 0, z1], color };
    };
    out.push(iz(-11.8, -10, -21, 35, CONCRETE)); // pavement
    out.push(iz(-19, -11.8, -20.6, -12.6, 0x9e978c)); // driveway
    out.push(iz(-17, -11.8, -1.1, 1.1, CONCRETE)); // front path
    out.push(iz(-37.5, -33, 1, 6.5, CONCRETE)); // back patio
    out.push(iz(-32.6, -17.4, -11.6, 9.6, 0x9c7654)); // house floorboards (flat)
    out.push(iz(-30.6, -19, -20.6, -12, 0x8f8a82)); // garage slab
    // kerb line
    out.push({ ...iz(-10.15, -10, -21, 35, 0xe6e0d4), min: [X(-10.15, -10)[0], 0.006, -21] });
  }
  // centre line + cul-de-sac turning circle marks (raised a hair over the asphalt)
  for (const d of dashes(0, -20, 28, 2.4, 1.6, 0.2, 0xe8c24a)) out.push({ ...d, min: [d.min[0], 0.006, d.min[2]] });
  out.push({ min: [-10, 0.006, 26.2], max: [10, 0.006, 26.6], color: 0xeae6de }); // stop line
  return out;
}

// ── neighbourhood beyond the fence ───────────────────────────────────────
function suburb(): SkyProp[] {
  const out: SkyProp[] = [];
  const BODY = [0x6a5670, 0x5e5c76, 0x705a54, 0x5a6a66];
  const lift = (hex: number, k: number) => {
    const c = (sh: number) => Math.min(255, Math.round(((hex >> sh) & 255) * k));
    return (c(16) << 16) | (c(8) << 8) | c(0);
  };
  let n = 0;
  // Body + lighter facade toward the arena, eaves, a stepped roof to a ridge,
  // and a few windows (some lit, some dark glass).
  const house = (x: number, z: number, w: number, d: number, h: number) => {
    const body = BODY[n++ % BODY.length];
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    out.push(prop(x0, 0, z0, x1, h, z1, body));
    out.push(prop(x0 - 0.6, h, z0 - 0.6, x1 + 0.6, h + 0.3, z1 + 0.6, 0x3a2e3e)); // eaves
    const alongX = w >= d; // ridge runs along the longer side
    for (let k = 0; k < 3; k++) {
      const inset = 0.9 + k * (alongX ? d : w) * 0.14;
      const ix = alongX ? 0.9 + k * 0.4 : inset;
      const iz = alongX ? inset : 0.9 + k * 0.4;
      out.push(prop(x0 + ix, h + 0.3 + k * 0.8, z0 + iz, x1 - ix, h + 1.1 + k * 0.8, z1 - iz, k === 2 ? 0x3a2c3c : 0x46384a));
    }
    // facade: the side facing the arena centre
    const xFace = Math.abs(x) / 48 > Math.abs(z) / 36;
    const sgn = xFace ? -Math.sign(x) : -Math.sign(z);
    const plane = xFace ? (sgn < 0 ? x0 : x1) : sgn < 0 ? z0 : z1;
    const span = xFace ? d : w;
    const c0 = xFace ? z : x;
    const slabAt = (u0: number, u1: number, y0: number, y1: number, depth: number, color: number) => {
      const a = plane;
      const b = plane + sgn * depth;
      if (xFace) out.push(prop(Math.min(a, b), y0, u0, Math.max(a, b), y1, u1, color));
      else out.push(prop(u0, y0, Math.min(a, b), u1, y1, Math.max(a, b), color));
    };
    slabAt(c0 - span / 2, c0 + span / 2, 0, h, 0.05, lift(body, 1.12));
    // driveway from the facade to the ring road
    const road = -sgn * (xFace ? 52.5 : 43);
    const du = c0 + span * 0.3;
    if (xFace) out.push(prop(Math.min(plane, road), -0.2, du - 1.5, Math.max(plane, road), -0.012, du + 1.5, 0x6e675f));
    else out.push(prop(du - 1.5, -0.2, Math.min(plane, road), du + 1.5, -0.012, Math.max(plane, road), 0x6e675f));
    const cols = span > 11 ? [-0.3, 0, 0.3] : [-0.25, 0.25];
    cols.forEach((f, i) => {
      for (const [y, lit] of [[1.6, (n + i) % 3 !== 0], [h - 2.2, (n + i) % 2 === 0]] as const) {
        const u = c0 + f * span;
        slabAt(u - 0.7, u + 0.7, y - 0.55, y + 0.55, 0.1, lit ? 0xe0a058 : 0x3a364c);
      }
    });
  };
  // Trunk + three stacked, offset, tapering canopy blocks.
  const tree = (x: number, z: number, h: number, r: number) => {
    out.push(prop(x - 0.35, 0, z - 0.35, x + 0.35, h * 0.55, z + 0.35, 0x3a2e2a));
    out.push(prop(x - r, h * 0.32, z - r, x + r, h * 0.66, z + r, 0x3a4838));
    const o = r * 0.18;
    out.push(prop(x - r * 0.76 + o, h * 0.6, z - r * 0.76 - o, x + r * 0.76 + o, h * 0.86, z + r * 0.76 - o, 0x44563f));
    out.push(prop(x - r * 0.46 - o, h * 0.82, z - r * 0.46, x + r * 0.46 - o, h, z + r * 0.46, 0x506642));
  };
  for (const s of [-1, 1]) {
    house(s * 60, -18, 12, 14, 7);
    house(s * 62, 8, 12, 12, 6.5);
    house(s * 58, 30, 10, 12, 6);
    tree(s * 56, -30, 11, 3);
    tree(s * 56, 18, 12, 3.5);
    house(-28 * s, 48, 14, 10, 6.5);
    house(-8 * s, 50, 10, 9, 5.5);
    tree(18 * s, 44, 10, 3);
    house(-26 * s, -48, 14, 10, 7);
    tree(-12 * s, -42, 12, 3.5);
    house(24 * s, -50, 12, 10, 6);
  }
  return out;
}

// Ground beyond the fence (a ring around the arena footprint, just under
// y = 0 so nothing overlaps the arena): dusk lawns, a pavement band hugging
// the fence, a ring road the street tees into, faded centre dashes.
function outskirts(): SkyProp[] {
  const out: SkyProp[] = [];
  const FAR = 420;
  const ring = (inX: number, inZ: number, outX: number, outZ: number, top: number, color: number) => {
    const y0 = top - 0.2;
    out.push(prop(-outX, y0, -outZ, outX, top, -inZ, color)); // north
    out.push(prop(-outX, y0, inZ, outX, top, outZ, color)); // south
    out.push(prop(-outX, y0, -inZ, -inX, top, inZ, color)); // west
    out.push(prop(inX, y0, -inZ, outX, top, inZ, color)); // east
  };
  ring(48, 36, FAR, FAR, -0.03, 0x44583a); // lawns
  ring(48, 36, 50, 38, -0.02, 0x7c746c); // pavement along the fence
  // ring road: north/south lanes, side lanes, and the street's stub into it
  const ASPH = 0x3c3a42;
  for (const s of [-1, 1]) {
    out.push(prop(-FAR, -0.215, Math.min(s * 38, s * 43), FAR, -0.015, Math.max(s * 38, s * 43), ASPH));
    out.push(prop(Math.min(s * 50, s * 52.5), -0.215, -43, Math.max(s * 50, s * 52.5), -0.015, 43, ASPH));
    for (let x = -120; x < 120; x += 5) {
      out.push(prop(x, -0.21, s * 40.4, x + 2.6, -0.01, s * 40.6, 0x8a7c4c));
    }
  }
  out.push(prop(-10, -0.215, 36, 10, -0.015, 38, ASPH));
  return out;
}

const MASTS: Array<[V3, Face]> = [
  [[-13, 8, 36.4], '-z'], [[13, 8, 36.4], '-z'],
  [[-22, 8, -36.4], '+z'], [[22, 8, -36.4], '+z'],
  [[-48.4, 7, -6], '+x'], [[48.4, 7, -6], '-x'],
  [[-48.4, 7, 24], '+x'], [[48.4, 7, 24], '-x'],
];

export const DUSK: WorldTheme = {
  id: 'dusk',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 3.2,
  slots: {
    floor: { metalness: 0, normalScale: 0.5, ao: 0.4 },
    ceiling: { metalness: 0, normalScale: 0.7, ao: 0.6 },
    wall: { metalness: 0, normalScale: 0.9, ao: 0.7 },
    cover: { metalness: 0.08, normalScale: 0.3, ao: 0.3 },
    platform: { metalness: 0, normalScale: 0.7, ao: 0.6 },
    tower: { metalness: 0.1, normalScale: 0.6, ao: 0.5 },
  },
  slotFor: (_i, b, k) => (b.tag && SLOT[b.tag]) || k,
  tintFor: (_i, b) => tint(b),
  trim: null,
  dress: {
    slot: 'ceiling', tint: 0xf6f2ea, bright: 1.15,
    crown: { h: 0.22, d: 0.12 },
    pilasters: { spacing: 4, w: 0.3, d: 0.12 },
  },
  inlays: paint(),
  skyline: [...outskirts(), ...suburb(), ...MASTS.map(([at, f]) => mast(at, f))],
  lights: [
    ...houseLights(-1),
    ...houseLights(1),
    ...vehicleGlass(),
    ...billboardLights(),
    ...towerLights(),
    ...MASTS.map(([at, f]) => mastLamp(at, f, SODIUM, 160, 26, { size: [0.9, 0.4], down: 1.1, angle: 1.0, radius: 0.4 })),
  ],
  bake: {
    ambientUp: 0xc0b0c0, ambientDown: 0xb8a088, ambient: 0.36,
    sky: { color: 0x9ab0e0, intensity: 0.85 },
    ao: { radius: 2.4, strength: 0.75 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.55,
    maxTexels: 170_000,
  },
  sun: { dir: norm([-0.5, 0.4, 0.77]), color: 0xffc080, intensity: 3.0, mapScale: 1.0 },
  hemi: { sky: 0xa8b4e0, ground: 0x6a5a48, intensity: 0.6, mapScale: 0.15 },
  fill: { dir: norm([0.6, 0.35, -0.6]), color: 0x9aaee0, intensity: 0.45, mapScale: 0.3 },
  env: { intensity: 0.4, mapScale: 0.6 },
  worldSaturation: 0.9,
  satCap: 0.72,
  exposure: 1.1,
  fog: { color: 0xc89a8a, near: 70, far: 320 },
  background: 0x6a5a80,
  sky: {
    mode: 'dusk', top: 0x3c5aa0, mid: 0xb07a98, horizon: 0xffb27a, ground: 0x5a4658,
    sunColor: 0xffd8a8, sunSize: 0.028, sunGlow: 0.7, band: 0.3,
  },
};

