import * as THREE from 'three';

// Procedural PBR arena surfaces — synthesised once (no asset downloads), cached
// at module scope and shared across every map build + rebuild. Each surface
// kind is authored as a HEIGHT FIELD (panel grooves, bevels, rivets, container
// corrugation) from which we derive:
//   map        albedo, sRGB — colour is baked here so materials stay white and
//              the world-tint / full-bright control (emissiveMap = map) works.
//   normalMap  tangent-space normals, Sobel of the height field (OpenGL +Y).
//   orm        packed data texture: R = ambient occlusion (cavity baked from the
//              height field), G = roughness (panel centres smoother, grooves and
//              rivets rougher, plus soft blotches + fine grain), B = 1.
//              Bind it as BOTH aoMap (reads .r) and roughnessMap (reads .g).
// All three maps of a kind share one layout so they line up texel-for-texel,
// and every one is a DataTexture (flipY = false) so their V axes agree.
//
// UVs are NOT 0..1 per box: map.ts bakes world-space coordinates / `tile`
// (metres per repeat) into each box, so texture scale is constant across box
// sizes and seams run continuously across adjacent boxes.
//
// Everything here is deterministic (hash noise, no Math.random) and touches no
// DOM API, so the module is safe to import anywhere.

export type SurfaceKind = 'floor' | 'wall' | 'ceiling' | 'platform' | 'cover' | 'tower';

export type SurfaceTextures = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture;
  tile: number; // metres per texture repeat
};

export type ArenaTextures = Record<SurfaceKind, SurfaceTextures>;

// Anisotropic filtering level. three clamps it to the device maximum at upload
// time, so a value above the hardware limit is safe.
export const ARENA_TEXTURE_ANISOTROPY = 8;

let cache: ArenaTextures | null = null;

// ── deterministic noise ────────────────────────────────────────────────────

function hash(ix: number, iy: number, seed: number): number {
  let n = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

// Tiling value noise as a full-size field (lattice precomputed, bilinear with
// smoothstep). `cell` is the lattice spacing in texels.
function noiseField(size: number, cell: number, seed: number): Float32Array {
  const n = Math.max(1, Math.round(size / cell));
  const lattice = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) lattice[y * n + x] = hash(x, y, seed);
  // Per-column lattice indices + blend weight, hoisted out of the row loop.
  const scale = n / size;
  const xa = new Int32Array(size);
  const xb = new Int32Array(size);
  const sx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const gx = (x + 0.5) * scale;
    const x0 = Math.floor(gx);
    const fx = gx - x0;
    sx[x] = fx * fx * (3 - 2 * fx);
    xa[x] = x0 % n;
    xb[x] = (x0 + 1) % n;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = (y + 0.5) * scale;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    const ra = (y0 % n) * n;
    const rb = ((y0 + 1) % n) * n;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = lattice[ra + xa[x]];
      const b = lattice[ra + xb[x]];
      const c = lattice[rb + xa[x]];
      const d = lattice[rb + xb[x]];
      const t = sx[x];
      out[row + x] = (a + (b - a) * t) * (1 - sy) + (c + (d - c) * t) * sy;
    }
  }
  return out;
}

// Two-octave blotch noise centred on 0 (range ≈ -0.5..0.5).
function blotchField(size: number, cell: number, seed: number): Float32Array {
  const a = noiseField(size, cell, seed);
  const b = noiseField(size, cell / 2, seed + 101);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] - 0.5) * 0.65 + (b[i] - 0.5) * 0.35;
  return out;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Separable wrapping box blur (running sums) — used to bake cavity AO.
function boxBlurWrap(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const win = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + ((k + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + ((x + radius + 1) % size)] - src[row + ((x - radius + size) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[((k + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum / win;
      sum += tmp[((y + radius + 1) % size) * size + x] - tmp[((y - radius + size) % size) * size + x];
    }
  }
  return out;
}

// ── height-field recipes ───────────────────────────────────────────────────

// Per-texel authoring masks. `h` is in TEXEL units (1 unit of height per texel
// of run = a 45° slope), everything else is 0..1.
type Field = {
  size: number;
  h: Float32Array; // height, positive = raised
  seam: Float32Array; // groove + bevel (darker, rougher)
  rivet: Float32Array; // rivet cap dome
  line: Float32Array; // hairline inset detail (albedo only)
  centre: Float32Array; // 1 at panel centre → 0 at the panel edge (smoother middles)
};

function newField(size: number): Field {
  const n = size * size;
  return {
    size,
    h: new Float32Array(n),
    seam: new Float32Array(n),
    rivet: new Float32Array(n),
    line: new Float32Array(n),
    centre: new Float32Array(n),
  };
}

type PanelSpec = {
  size: number;
  cols: number;
  rows: number;
  seamHalf: number; // groove half-width, texels
  bevel: number; // chamfer width, texels
  depth: number; // groove depth, texel units
  midSeam?: number; // shallower horizontal seam at each panel's half height (depth factor)
  inset?: number; // hairline inset from the seam centre, texels (0 = none)
  rivets: 'none' | 'corners' | 'bands';
  rivetInset?: number; // rivet centre distance from the seam centre, texels
  rivetR?: number; // rivet radius, texels
  rivetH?: number; // rivet dome height, texel units
  wobble: number; // low-frequency surface unevenness amplitude, texel units
  seed: number;
};

// Flat plates separated by bevelled grooves, optional rivets + hairline inset.
function panelField(s: PanelSpec): Field {
  const f = newField(s.size);
  const { size } = s;
  const px = size / s.cols;
  const py = size / s.rows;
  const wobble = noiseField(size, size / 8, s.seed);
  const rivetR = s.rivetR ?? 5;
  const rivetH = s.rivetH ?? 2.5;
  const rm = s.rivetInset ?? s.seamHalf + s.bevel + rivetR * 2.5;
  for (let y = 0; y < size; y++) {
    const ly = (y + 0.5) % py;
    const dy = Math.min(ly, py - ly);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lx = (x + 0.5) % px;
      const dx = Math.min(lx, px - lx);
      const d = Math.min(dx, dy);
      const plate = smoothstep(s.seamHalf, s.seamHalf + s.bevel, d);
      let h = plate * s.depth;
      let seam = 1 - plate;
      if (s.midSeam) {
        const dm = Math.abs(ly - py / 2);
        const mid = smoothstep(s.seamHalf * 0.6, s.seamHalf * 0.6 + s.bevel * 0.6, dm);
        h -= (1 - mid) * s.depth * s.midSeam * plate;
        seam = Math.max(seam, (1 - mid) * 0.45); // lighter than the main grooves
      }
      if (s.rivets !== 'none') {
        let rx: number;
        let ry: number;
        if (s.rivets === 'corners') {
          rx = Math.min(Math.abs(lx - rm), Math.abs(lx - (px - rm)));
          ry = Math.min(Math.abs(ly - rm), Math.abs(ly - (py - rm)));
        } else {
          rx = Math.min(Math.abs(lx - px * 0.25), Math.abs(lx - px * 0.75));
          ry = Math.min(Math.abs(ly - rm), Math.abs(ly - (py - rm)));
        }
        const r = Math.sqrt(rx * rx + ry * ry) / rivetR;
        if (r < 1) {
          const dome = Math.sqrt(1 - r * r);
          h += rivetH * dome;
          f.rivet[i] = dome;
        }
      }
      if (s.inset) {
        const dl = Math.abs(d - s.inset);
        f.line[i] = 1 - smoothstep(0.6, 1.6, dl);
      }
      h += (wobble[i] - 0.5) * s.wobble;
      f.h[i] = h;
      f.seam[i] = seam;
      const cx = Math.abs(lx - px / 2) / (px / 2);
      const cy = Math.abs(ly - py / 2) / (py / 2);
      f.centre[i] = 1 - Math.max(cx, cy);
    }
  }
  return f;
}

type CorrugationSpec = {
  size: number;
  ribs: number; // ribs per tile
  depth: number; // rib depth, texel units
  frame: number; // raised rail band at the tile's top/bottom edge, texels (0 = none)
  frameDepth: number; // rail height, texel units
  wobble: number;
  seed: number;
};

// Shipping-container skin: trapezoid vertical ribs + horizontal frame rails.
function corrugationField(s: CorrugationSpec): Field {
  const f = newField(s.size);
  const { size } = s;
  const pitch = size / s.ribs;
  const wobble = noiseField(size, size / 8, s.seed);
  const bevel = Math.max(2, s.frame * 0.25);
  for (let y = 0; y < size; y++) {
    const fy = Math.min(y + 0.5, size - (y + 0.5)); // distance to the tile's horizontal edge
    const rail = s.frame > 0 ? 1 - smoothstep(s.frame - bevel, s.frame + bevel, fy) : 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = ((x + 0.5) % pitch) / pitch;
      let profile: number;
      if (t < 0.32) profile = 1;
      else if (t < 0.5) profile = 1 - smoothstep(0, 1, (t - 0.32) / 0.18);
      else if (t < 0.82) profile = 0;
      else profile = smoothstep(0, 1, (t - 0.82) / 0.18);
      const ribH = profile * s.depth;
      const h = ribH * (1 - rail) + s.frameDepth * rail;
      f.h[i] = h + (wobble[i] - 0.5) * s.wobble;
      // valleys read as seams; the rail edge gets a thin darker line
      const railEdge = 1 - smoothstep(0, bevel * 1.5, Math.abs(fy - s.frame));
      f.seam[i] = Math.max((1 - profile) * 0.6 * (1 - rail), railEdge * 0.5);
      f.centre[i] = 0;
    }
  }
  return f;
}

// ── baking ─────────────────────────────────────────────────────────────────

type BakeSpec = {
  base: number; // sRGB hex
  seamDark: number; // albedo multiplier in grooves
  lineTint?: number; // albedo multiplier on the hairline inset
  rivetLight?: number; // albedo boost on rivet caps
  toneNoise: number; // ± albedo blotch amplitude
  grain: number; // ± per-texel albedo grain
  rough: {
    base: number;
    seam: number; // added in grooves
    centre: number; // subtracted at panel centres
    rivet?: number; // added on rivet caps
    blotch: number; // ± soft variation
    grain: number; // ± fine grain
  };
  ao: number; // cavity strength 0..1
  aoBlur: number; // cavity blur radius, texels
  normalStrength?: number; // multiplier on the height gradient (default 1)
  seed: number;
};

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = ARENA_TEXTURE_ANISOTROPY;
  tex.needsUpdate = true;
  return tex;
}

// 0..1 → 0..255 with clamping (integer rounding, hot loop).
const byte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

function bake(f: Field, s: BakeSpec, tile: number): SurfaceTextures {
  const { size } = f;
  const n = size * size;
  const blotch = blotchField(size, size / 6, s.seed);
  const br = ((s.base >> 16) & 255) / 255;
  const bg = ((s.base >> 8) & 255) / 255;
  const bb = (s.base & 255) / 255;
  const seamDarken = 1 - s.seamDark;
  const lineDarken = 1 - (s.lineTint ?? 1);
  const rivetLight = s.rivetLight ?? 0;
  const rivetRough = s.rough.rivet ?? 0;
  const toneAmp = 2 * s.toneNoise;
  const grainAmp = 2 * s.grain;
  const roughBlotch = 2 * s.rough.blotch;
  const roughGrain = 2 * s.rough.grain;
  const h = f.h;

  // ── normal (Sobel on the height field, wrapping). Data rows run +V, so
  // green = -dh/drow. OpenGL convention, which is what three expects.
  const normal = new Uint8Array(n * 4);
  const ns = s.normalStrength ?? 1;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size;
    const y0 = y * size;
    const yp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const gx =
        (h[ym + xp] + 2 * h[y0 + xp] + h[yp + xp] - h[ym + xm] - 2 * h[y0 + xm] - h[yp + xm]) / 8;
      const gy =
        (h[yp + xm] + 2 * h[yp + x] + h[yp + xp] - h[ym + xm] - 2 * h[ym + x] - h[ym + xp]) / 8;
      let nx = -gx * ns;
      let ny = -gy * ns;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const i = (y0 + x) * 4;
      normal[i] = byte(nx * 0.5 + 0.5);
      normal[i + 1] = byte(ny * 0.5 + 0.5);
      normal[i + 2] = byte(inv * 0.5 + 0.5);
      normal[i + 3] = 255;
    }
  }

  // ── albedo + ORM (R = cavity AO, G = roughness, B = 1) in one pass.
  const blurred = boxBlurWrap(h, size, s.aoBlur);
  // Normalise cavity by the field's dynamic range so recipes with different
  // depths get comparable occlusion.
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (h[i] < hMin) hMin = h[i];
    if (h[i] > hMax) hMax = h[i];
  }
  const range = Math.max(1e-3, hMax - hMin);
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const g1 = hash(x, y, s.seed + 7) - 0.5; // albedo grain
      const g2 = (((g1 + 0.5) * 61.7) % 1) - 0.5; // decorrelated roughness grain
      let shade = 1 - seamDarken * f.seam[i];
      shade *= 1 + blotch[i] * toneAmp;
      shade *= 1 + g1 * grainAmp;
      shade *= 1 - lineDarken * f.line[i];
      shade *= 1 + rivetLight * f.rivet[i];
      const o = i * 4;
      albedo[o] = byte(br * shade);
      albedo[o + 1] = byte(bg * shade);
      albedo[o + 2] = byte(bb * shade);
      albedo[o + 3] = 255;
      const cavity = Math.max(0, blurred[i] - h[i]) / range;
      const ao = 1 - s.ao * Math.min(1, cavity * 1.6);
      const c = f.centre[i];
      const r =
        s.rough.base +
        s.rough.seam * f.seam[i] -
        s.rough.centre * c * c +
        rivetRough * f.rivet[i] +
        blotch[i] * roughBlotch +
        g2 * roughGrain;
      orm[o] = byte(ao);
      orm[o + 1] = byte(r < 0.12 ? 0.12 : r);
      orm[o + 2] = 255;
      orm[o + 3] = 255;
    }
  }

  return {
    map: dataTexture(albedo, size, true),
    normalMap: dataTexture(normal, size, false),
    orm: dataTexture(orm, size, false),
    tile,
  };
}

// ── surface set ────────────────────────────────────────────────────────────
// Reference: Diabotical / Quake Champions — clean plates with real edge
// definition, subtle roughness variation, nothing noisy enough to hide a
// player. Tile sizes are metres per repeat; texel pitch ≈ tile / size.

function makeFloor(): SurfaceTextures {
  // 4 m tile → 2×2 plates of 2 m, bevelled grooves + a hairline inset. No
  // rivets: the floor is where enemies are read, keep it quiet.
  return bake(
    panelField({
      size: 512, cols: 2, rows: 2, seamHalf: 3, bevel: 5, depth: 5,
      inset: 22, rivets: 'none', wobble: 1.2, seed: 11,
    }),
    {
      base: 0x646c77, seamDark: 0.5, lineTint: 0.9, toneNoise: 0.035, grain: 0.02,
      rough: { base: 0.62, seam: 0.25, centre: 0.1, blotch: 0.06, grain: 0.025 },
      ao: 0.75, aoBlur: 8, seed: 11,
    },
    4,
  );
}

function makeWall(): SurfaceTextures {
  // 4 m tile → two 2 m-wide × 4 m-tall plates, a shallower band at half
  // height, rivet pairs along the top/bottom seams.
  return bake(
    panelField({
      size: 512, cols: 2, rows: 1, seamHalf: 3, bevel: 6, depth: 6, midSeam: 0.45,
      rivets: 'bands', rivetInset: 26, rivetR: 5, rivetH: 2.5, wobble: 1.5, seed: 23,
    }),
    {
      base: 0x77808e, seamDark: 0.5, rivetLight: 0.15, toneNoise: 0.04, grain: 0.02,
      rough: { base: 0.6, seam: 0.25, centre: 0.08, rivet: 0.12, blotch: 0.07, grain: 0.03 },
      ao: 0.75, aoBlur: 8, seed: 23,
    },
    4,
  );
}

function makeCeiling(): SurfaceTextures {
  // Dark, coarse 4 m plates (8 m tile) — mostly seen at distance overhead.
  return bake(
    panelField({
      size: 256, cols: 2, rows: 2, seamHalf: 2, bevel: 3, depth: 3,
      rivets: 'none', wobble: 0.8, seed: 37,
    }),
    {
      base: 0x2f3540, seamDark: 0.6, toneNoise: 0.03, grain: 0.015,
      rough: { base: 0.85, seam: 0.1, centre: 0.05, blotch: 0.04, grain: 0.02 },
      ao: 0.6, aoBlur: 4, seed: 37,
    },
    8,
  );
}

function makePlatform(): SurfaceTextures {
  // 2 m tile → 1 m deck plates with a hairline inset and small corner bolts.
  // Lighter + cleaner than the floor so ledges read as landing surfaces.
  return bake(
    panelField({
      size: 512, cols: 2, rows: 2, seamHalf: 3, bevel: 5, depth: 4, inset: 26,
      rivets: 'corners', rivetInset: 40, rivetR: 5, rivetH: 2, wobble: 1.0, seed: 41,
    }),
    {
      base: 0x8b94a3, seamDark: 0.5, lineTint: 0.9, rivetLight: 0.12, toneNoise: 0.03, grain: 0.02,
      rough: { base: 0.5, seam: 0.3, centre: 0.1, rivet: 0.1, blotch: 0.06, grain: 0.03 },
      ao: 0.7, aoBlur: 8, seed: 41,
    },
    2,
  );
}

function makeCover(): SurfaceTextures {
  // 2 m tile → 8 corrugation ribs (25 cm pitch) + frame rails at the tile's
  // top/bottom edge. Warm painted steel — the arena's warm accent.
  return bake(
    corrugationField({ size: 512, ribs: 8, depth: 10, frame: 28, frameDepth: 12, wobble: 1.0, seed: 53 }),
    {
      base: 0xb0683a, seamDark: 0.82, toneNoise: 0.05, grain: 0.03,
      rough: { base: 0.6, seam: 0.15, centre: 0, blotch: 0.08, grain: 0.03 },
      ao: 0.5, aoBlur: 10, seed: 53,
    },
    2,
  );
}

function makeTower(): SurfaceTextures {
  // 4 m tile → 2 m square plates with corner rivets; darker than the walls so
  // pillars read as distinct verticals.
  return bake(
    panelField({
      size: 512, cols: 2, rows: 2, seamHalf: 3, bevel: 6, depth: 6,
      rivets: 'corners', rivetInset: 30, rivetR: 5, rivetH: 2.5, wobble: 1.5, seed: 67,
    }),
    {
      base: 0x5b6370, seamDark: 0.5, rivetLight: 0.18, toneNoise: 0.04, grain: 0.02,
      rough: { base: 0.58, seam: 0.25, centre: 0.08, rivet: 0.12, blotch: 0.07, grain: 0.03 },
      ao: 0.75, aoBlur: 8, seed: 67,
    },
    4,
  );
}

export function getArenaTextures(): ArenaTextures {
  if (cache) return cache;
  cache = {
    floor: makeFloor(),
    wall: makeWall(),
    ceiling: makeCeiling(),
    platform: makePlatform(),
    cover: makeCover(),
    tower: makeTower(),
  };
  return cache;
}
