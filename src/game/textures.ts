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
export const ARENA_TEXTURE_ANISOTROPY = 16;

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
  tone?: Float32Array; // optional ± albedo multiplier (per-plank / per-block variation)
  mix?: Float32Array; // optional 0..1 blend toward BakeSpec.base2 (stripes, paint bands)
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

// Anisotropic tiling value noise (separate lattice spacing along x and y) —
// wood grain, brushed metal, streaks. Same smoothstep bilinear as noiseField.
function noiseField2(size: number, cellX: number, cellY: number, seed: number): Float32Array {
  const nx = Math.max(1, Math.round(size / cellX));
  const ny = Math.max(1, Math.round(size / cellY));
  const lattice = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) lattice[y * nx + x] = hash(x, y, seed);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = ((y + 0.5) * ny) / size;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    const ra = (y0 % ny) * nx;
    const rb = ((y0 + 1) % ny) * nx;
    for (let x = 0; x < size; x++) {
      const gx = ((x + 0.5) * nx) / size;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const t = fx * fx * (3 - 2 * fx);
      const xa = x0 % nx;
      const xb = (x0 + 1) % nx;
      const a = lattice[ra + xa];
      const b = lattice[ra + xb];
      const c = lattice[rb + xa];
      const d = lattice[rb + xb];
      out[y * size + x] = (a + (b - a) * t) * (1 - sy) + (c + (d - c) * t) * sy;
    }
  }
  return out;
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

// Industrial floor grating: bearing bars along V every `pitch` texels, cross
// rods along U every `cross` texels, dark voids between (no alpha — it reads
// as grating through normal + albedo + cavity AO, and stays solid for decals).
function gratingField(s: {
  size: number; pitch: number; bar: number; cross: number; rod: number; depth: number; frame: number; seed: number;
}): Field {
  const f = newField(s.size);
  const { size } = s;
  const wobble = noiseField(size, size / 4, s.seed);
  for (let y = 0; y < size; y++) {
    const ly = (y + 0.5) % s.cross;
    const dy = Math.min(ly, s.cross - ly);
    const fy = Math.min(y + 0.5, size - (y + 0.5));
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lx = (x + 0.5) % s.pitch;
      const dx = Math.min(lx, s.pitch - lx);
      const fx = Math.min(x + 0.5, size - (x + 0.5));
      const bar = 1 - smoothstep(s.bar, s.bar + 1.2, dx);
      const rod = (1 - smoothstep(s.rod, s.rod + 1.2, dy)) * 0.8;
      const frame = 1 - smoothstep(s.frame, s.frame + 2, Math.min(fx, fy));
      const solid = Math.max(bar, rod, frame);
      f.h[i] = solid * s.depth + (wobble[i] - 0.5) * 0.6 + frame * 1.5;
      f.seam[i] = 1 - solid;
      f.centre[i] = frame;
    }
  }
  return f;
}

// Planks along U: `rows` boards per tile, `segs` butt joints per row at
// hashed offsets, bevelled gaps, per-board tone and a stretched grain.
function planksField(s: {
  size: number; rows: number; segs: number; gap: number; bevel: number; depth: number;
  grain: number; tone: number; seed: number;
}): Field {
  const f = newField(s.size);
  const { size } = s;
  const ph = size / s.rows;
  // segs 0 → continuous boards (siding): no butt joints.
  const seg = s.segs > 0 ? size / s.segs : Infinity;
  const grain = noiseField2(size, size / 3, 3, s.seed + 5);
  const grain2 = noiseField2(size, size / 10, 1.5, s.seed + 9);
  const tone = new Float32Array(size * size);
  f.tone = tone;
  for (let y = 0; y < size; y++) {
    const row = Math.floor((y + 0.5) / ph);
    const ly = (y + 0.5) - row * ph;
    const dy = Math.min(ly, ph - ly);
    const off = s.segs > 0 ? hash(row, 7, s.seed) * seg : 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const gx = (x + 0.5 + off) % size;
      const sidx = s.segs > 0 ? Math.floor(gx / seg) : 0;
      const lx = gx - sidx * seg;
      const dx = s.segs > 0 ? Math.min(lx, seg - lx) : Infinity;
      const d = Math.min(dx, dy);
      const plate = smoothstep(s.gap, s.gap + s.bevel, d);
      const g = (grain[i] - 0.5) * 0.7 + (grain2[i] - 0.5) * 0.3;
      f.h[i] = plate * s.depth + g * s.grain;
      f.seam[i] = 1 - plate;
      f.centre[i] = 0.3 + g * 0.4;
      tone[i] = (hash(row, sidx, s.seed + 3) - 0.5) * 2 * s.tone + g * s.tone * 1.2;
    }
  }
  return f;
}

// Running-bond blocks (stone, concrete block, brick-at-giant-scale) with
// mortar grooves and per-block tone.
function blocksField(s: {
  size: number; cols: number; rows: number; mortar: number; bevel: number; depth: number;
  tone: number; wobble: number; seed: number;
}): Field {
  const f = newField(s.size);
  const { size } = s;
  const bw = size / s.cols;
  const bh = size / s.rows;
  const wobble = noiseField(size, size / 6, s.seed);
  const tone = new Float32Array(size * size);
  f.tone = tone;
  for (let y = 0; y < size; y++) {
    const row = Math.floor((y + 0.5) / bh);
    const ly = (y + 0.5) - row * bh;
    const dy = Math.min(ly, bh - ly);
    const off = row % 2 ? bw / 2 : 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const gx = (x + 0.5 + off) % size;
      const col = Math.floor(gx / bw);
      const lx = gx - col * bw;
      const dx = Math.min(lx, bw - lx);
      const d = Math.min(dx, dy);
      const plate = smoothstep(s.mortar, s.mortar + s.bevel, d);
      f.h[i] = plate * s.depth + (wobble[i] - 0.5) * s.wobble;
      f.seam[i] = 1 - plate;
      const cx = Math.abs(lx - bw / 2) / (bw / 2);
      const cy = Math.abs(ly - bh / 2) / (bh / 2);
      f.centre[i] = 1 - Math.max(cx, cy);
      tone[i] = (hash(row, col, s.seed + 1) - 0.5) * 2 * s.tone;
    }
  }
  return f;
}

// Tufted upholstery: soft pillows between buttons on a diamond lattice.
function tuftField(s: { size: number; cells: number; depth: number; seed: number }): Field {
  const f = newField(s.size);
  const { size } = s;
  const c = size / s.cells;
  const weave = noiseField2(size, 2, 2, s.seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Two offset square lattices → buttons on a diamond pattern.
      const ax = ((x + 0.5) % c) - c / 2;
      const ay = ((y + 0.5) % c) - c / 2;
      const bx = ((x + 0.5 + c / 2) % c) - c / 2;
      const by = ((y + 0.5 + c / 2) % c) - c / 2;
      const d = Math.min(Math.hypot(ax, ay), Math.hypot(bx, by)) / (c * 0.7071);
      const pillow = smoothstep(0.02, 0.75, d);
      f.h[i] = pillow * s.depth + (weave[i] - 0.5) * 0.35;
      f.seam[i] = 1 - smoothstep(0.0, 0.14, d);
      f.centre[i] = pillow;
    }
  }
  return f;
}

// Nearly flat surface with only low-frequency unevenness: plaster, asphalt,
// poured concrete. Optional vertical stripes via `mix` (wallpaper).
function flatField(s: {
  size: number; wobble: number; stripes?: number; stripeWidth?: number; seed: number;
}): Field {
  const f = newField(s.size);
  const { size } = s;
  const wobble = noiseField(size, size / 6, s.seed);
  const fine = noiseField(size, 3, s.seed + 1);
  if (s.stripes) f.mix = new Float32Array(size * size);
  const pitch = s.stripes ? size / s.stripes : 1;
  const sw = (s.stripeWidth ?? 0.3) * pitch;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      f.h[i] = (wobble[i] - 0.5) * s.wobble + (fine[i] - 0.5) * 0.25;
      f.centre[i] = wobble[i];
      if (f.mix) {
        const lx = (x + 0.5) % pitch;
        const d = Math.abs(lx - pitch / 2);
        f.mix[i] = 1 - smoothstep(sw / 2 - 1, sw / 2 + 1, d);
      }
    }
  }
  return f;
}

// ── baking ─────────────────────────────────────────────────────────────────

type BakeSpec = {
  base: number; // sRGB hex
  base2?: number; // sRGB hex blended in by Field.mix
  stain?: { color: number; amount: number; cell: number; bias: number; rough: number; seed: number };
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
  const b2 = s.base2 ?? s.base;
  const br2 = ((b2 >> 16) & 255) / 255;
  const bg2 = ((b2 >> 8) & 255) / 255;
  const bb2 = (b2 & 255) / 255;
  const st = s.stain;
  const stainField = st ? blotchField(size, st.cell, st.seed) : null;
  const sr = st ? ((st.color >> 16) & 255) / 255 : 0;
  const sg = st ? ((st.color >> 8) & 255) / 255 : 0;
  const sb = st ? (st.color & 255) / 255 : 0;
  const tone = f.tone;
  const mixF = f.mix;
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
      if (tone) shade *= 1 + tone[i];
      let cr = br;
      let cg = bg;
      let cb = bb;
      if (mixF) {
        const t = mixF[i];
        cr += (br2 - cr) * t;
        cg += (bg2 - cg) * t;
        cb += (bb2 - cb) * t;
      }
      let stainT = 0;
      if (st && stainField) {
        stainT = smoothstep(st.bias, st.bias + 0.22, stainField[i] + (f.seam[i] * 0.12)) * st.amount;
        cr += (sr - cr) * stainT;
        cg += (sg - cg) * stainT;
        cb += (sb - cb) * stainT;
      }
      const o = i * 4;
      albedo[o] = byte(cr * shade);
      albedo[o + 1] = byte(cg * shade);
      albedo[o + 2] = byte(cb * shade);
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
        g2 * roughGrain +
        (st ? st.rough * stainT : 0);
      orm[o] = byte(ao);
      orm[o + 1] = byte(r < 0.08 ? 0.08 : r);
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

// ── per-theme surface sets ─────────────────────────────────────────────────
// Each world theme (see world/themes.ts) gets its own six slots. Generated
// lazily the first time a map of that theme is built, then cached for the
// session. 256² keeps generation ~10 ms per slot; everything here is
// LOW-FREQUENCY at player height (panels ≥ 1 m, no busy patterns on walls)
// so bright players stay the most readable thing on screen. Albedos are dark
// and desaturated; the colour comes from the baked lights.

export type TextureThemeId = 'void' | 'reactor' | 'lounge' | 'dusk' | 'nightport' | 'rustdusk' | 'lab';

type Recipe = () => SurfaceTextures;

const R = 256; // default recipe resolution

const panel = (
  base: number,
  tile: number,
  o: Partial<PanelSpec> & { rough?: number; seamDark?: number; stain?: BakeSpec['stain']; tone?: number; grain?: number; normal?: number } = {},
): SurfaceTextures =>
  bake(
    panelField({
      size: R, cols: 2, rows: 2, seamHalf: 1.5, bevel: 2.5, depth: 3, rivets: 'none', wobble: 0.6, seed: 101,
      ...o,
    }),
    {
      base, seamDark: o.seamDark ?? 0.5, lineTint: 0.9, rivetLight: 0.12, toneNoise: o.tone ?? 0.035, grain: o.grain ?? 0.015,
      rough: { base: o.rough ?? 0.55, seam: 0.25, centre: 0.08, rivet: 0.1, blotch: 0.06, grain: 0.025 },
      ao: 0.7, aoBlur: 4, seed: (o.seed ?? 101) + 1, stain: o.stain, normalStrength: o.normal,
    },
    tile,
  );

let flatCeilingCache: SurfaceTextures | null = null;
// Open-top maps never draw their ceiling: share one tiny set.
function unusedCeiling(): SurfaceTextures {
  if (!flatCeilingCache) {
    flatCeilingCache = bake(flatField({ size: 32, wobble: 0.2, seed: 3 }), {
      base: 0x202226, seamDark: 1, toneNoise: 0, grain: 0,
      rough: { base: 0.9, seam: 0, centre: 0, blotch: 0, grain: 0 }, ao: 0, aoBlur: 1, seed: 3,
    }, 8);
  }
  return flatCeilingCache;
}

const THEME_RECIPES: Record<TextureThemeId, Record<SurfaceKind, Recipe>> = {
  // Void: dark gunmetal plate, big quiet panels; the colour is all light.
  void: {
    floor: () => panel(0x3a404b, 4, { inset: 11, rough: 0.42, seed: 11 }),
    wall: () => panel(0x454c5c, 4, { cols: 1, rows: 2, bevel: 3, depth: 3.5, inset: 12, rough: 0.5, seed: 23 }),
    ceiling: unusedCeiling,
    platform: () => panel(0x5a6272, 2, { rivets: 'corners', rivetInset: 16, rivetR: 2.5, rivetH: 1.2, rough: 0.38, seed: 41 }),
    cover: () => panel(0x4c5362, 2, { cols: 1, rows: 1, bevel: 3, depth: 4, inset: 14, rough: 0.45, seed: 53 }),
    tower: () => panel(0x353a44, 4, { cols: 1, rows: 4, rivets: 'bands', rivetInset: 10, rivetR: 2.5, rivetH: 1.2, rough: 0.4, seed: 67 }),
  },
  // Reactor: industrial steel plate + grating, worn safety-yellow cover.
  reactor: {
    // Big 3 m deck plates, low-contrast grout: the floor must not out-shout
    // the walls or the players standing on it.
    floor: () => panel(0x4a4f56, 6, {
      seamHalf: 1, bevel: 2, depth: 2, seamDark: 0.78, rough: 0.55, tone: 0.03, seed: 12,
      stain: { color: 0x3a3c40, amount: 0.2, cell: 56, bias: 0.14, rough: -0.12, seed: 13 },
    }),
    // Tall 3 × 6 m bulkhead plates with a shallow mid seam — no rivet grid.
    wall: () => bake(
      panelField({ size: R, cols: 2, rows: 1, seamHalf: 1.2, bevel: 2.5, depth: 3, midSeam: 0.35, rivets: 'none', wobble: 0.7, seed: 24 }),
      {
        base: 0x646b74, seamDark: 0.6, toneNoise: 0.05, grain: 0.015,
        rough: { base: 0.6, seam: 0.2, centre: 0.08, blotch: 0.07, grain: 0.03 },
        ao: 0.7, aoBlur: 4, seed: 25,
        stain: { color: 0x44474c, amount: 0.18, cell: 64, bias: 0.16, rough: 0.08, seed: 26 },
      },
      6,
    ),
    ceiling: () => panel(0x33373e, 8, { rough: 0.85, seed: 37 }),
    platform: () => bake(
      gratingField({ size: R, pitch: 21, bar: 2.6, cross: 64, rod: 1.8, depth: 5, frame: 5, seed: 42 }),
      {
        base: 0x737a84, seamDark: 0.3, toneNoise: 0.03, grain: 0.02,
        rough: { base: 0.45, seam: 0.4, centre: 0, blotch: 0.06, grain: 0.03 },
        ao: 0.7, aoBlur: 3, seed: 43,
      },
      3,
    ),
    cover: () => panel(0x9c8646, 2, {
      cols: 1, rows: 1, bevel: 3, depth: 4, rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5, rough: 0.6, seed: 54,
      stain: { color: 0x4a4230, amount: 0.2, cell: 48, bias: 0.16, rough: 0.12, seed: 55 },
    }),
    tower: () => panel(0x4b5058, 4, { cols: 1, rows: 2, rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5, rough: 0.5, seed: 68 }),
  },
  // Lounge: giant-scale wood, teal wallpaper, oxblood tufted sofas.
  lounge: {
    floor: () => bake(
      planksField({ size: R, rows: 6, segs: 1, gap: 0.8, bevel: 1.4, depth: 2.5, grain: 0.9, tone: 0.07, seed: 14 }),
      {
        base: 0x6e4a30, seamDark: 0.35, toneNoise: 0.02, grain: 0.01,
        rough: { base: 0.42, seam: 0.3, centre: 0.1, blotch: 0.05, grain: 0.02 },
        ao: 0.7, aoBlur: 3, seed: 15,
      },
      8,
    ),
    wall: () => bake(flatField({ size: R, wobble: 0.5, stripes: 8, stripeWidth: 0.34, seed: 27 }), {
      base: 0x4d665e, base2: 0x587268, seamDark: 1, toneNoise: 0.03, grain: 0.012,
      rough: { base: 0.82, seam: 0, centre: 0, blotch: 0.04, grain: 0.02 },
      ao: 0.2, aoBlur: 3, seed: 28,
    }, 4),
    ceiling: () => bake(flatField({ size: 128, wobble: 1.0, seed: 38 }), {
      base: 0x9e968a, seamDark: 1, toneNoise: 0.04, grain: 0.01,
      rough: { base: 0.92, seam: 0, centre: 0, blotch: 0.03, grain: 0.01 },
      ao: 0.2, aoBlur: 3, seed: 39,
    }, 8),
    platform: () => bake(
      planksField({ size: R, rows: 4, segs: 2, gap: 0.8, bevel: 1.4, depth: 2.5, grain: 0.9, tone: 0.06, seed: 44 }),
      {
        base: 0x7a5233, seamDark: 0.4, toneNoise: 0.02, grain: 0.01,
        rough: { base: 0.38, seam: 0.3, centre: 0.1, blotch: 0.05, grain: 0.02 },
        ao: 0.7, aoBlur: 3, seed: 45,
      },
      4,
    ),
    cover: () => bake(tuftField({ size: R, cells: 4, depth: 6, seed: 56 }), {
      base: 0x6e2a2f, seamDark: 0.55, toneNoise: 0.03, grain: 0.02,
      rough: { base: 0.9, seam: 0.05, centre: 0, blotch: 0.03, grain: 0.03 },
      ao: 0.8, aoBlur: 6, seed: 57, normalStrength: 0.8,
    }, 4),
    tower: () => bake(
      planksField({ size: R, rows: 3, segs: 1, gap: 1, bevel: 2, depth: 3, grain: 0.7, tone: 0.05, seed: 69 }),
      {
        base: 0x4a3423, seamDark: 0.4, toneNoise: 0.02, grain: 0.01,
        rough: { base: 0.4, seam: 0.3, centre: 0.08, blotch: 0.05, grain: 0.02 },
        ao: 0.7, aoBlur: 3, seed: 70,
      },
      4,
    ),
  },
  // Dusk suburb: asphalt, block fence, painted clapboard, deck boards, and a
  // neutral painted-metal skin the vehicles tint per box.
  dusk: {
    floor: () => bake(flatField({ size: R, wobble: 0.6, seed: 16 }), {
      base: 0x404147, seamDark: 1, toneNoise: 0.05, grain: 0.07,
      rough: { base: 0.85, seam: 0, centre: 0, blotch: 0.05, grain: 0.04 },
      ao: 0.3, aoBlur: 3, seed: 17,
      stain: { color: 0x27282c, amount: 0.45, cell: 36, bias: 0.1, rough: -0.1, seed: 18 },
    }, 4),
    wall: () => bake(
      blocksField({ size: R, cols: 4, rows: 8, mortar: 1.2, bevel: 1.8, depth: 3, tone: 0.05, wobble: 0.8, seed: 29 }),
      {
        base: 0x8a847b, seamDark: 0.6, toneNoise: 0.04, grain: 0.03,
        rough: { base: 0.85, seam: 0.1, centre: 0.02, blotch: 0.04, grain: 0.03 },
        ao: 0.7, aoBlur: 3, seed: 30,
      },
      4,
    ),
    ceiling: unusedCeiling,
    platform: () => bake(
      planksField({ size: R, rows: 8, segs: 2, gap: 0.8, bevel: 1.2, depth: 2, grain: 0.6, tone: 0.06, seed: 46 }),
      {
        base: 0x75604c, seamDark: 0.45, toneNoise: 0.03, grain: 0.02,
        rough: { base: 0.75, seam: 0.2, centre: 0.05, blotch: 0.05, grain: 0.03 },
        ao: 0.7, aoBlur: 3, seed: 47,
      },
      4,
    ),
    cover: () => panel(0xbcbcbc, 2, { cols: 2, rows: 1, bevel: 3, depth: 3, rough: 0.5, tone: 0.02, grain: 0.008, seed: 58 }),
    tower: () => bake(
      planksField({ size: R, rows: 16, segs: 0, gap: 0.6, bevel: 2.2, depth: 3, grain: 0.1, tone: 0.015, seed: 71 }),
      {
        base: 0xc4beb0, seamDark: 0.6, toneNoise: 0.03, grain: 0.01,
        rough: { base: 0.7, seam: 0.1, centre: 0.02, blotch: 0.05, grain: 0.02 },
        ao: 0.8, aoBlur: 3, seed: 72,
      },
      4,
    ),
  },
  // Night port: wet concrete, streaked retaining walls, rusted container skin.
  nightport: {
    floor: () => panel(0x55565a, 4, {
      seamHalf: 1, bevel: 1.5, depth: 2, rough: 0.42, tone: 0.07, grain: 0.03, seed: 19,
      stain: { color: 0x2e2f32, amount: 0.45, cell: 72, bias: 0.06, rough: -0.32, seed: 20 },
    }),
    wall: () => panel(0x6a6862, 4, {
      cols: 1, rows: 1, seamHalf: 1, bevel: 1.5, depth: 1.5, rivets: 'corners', rivetInset: 24, rivetR: 3, rivetH: -1.5,
      rough: 0.88, tone: 0.06, seed: 31,
      stain: { color: 0x44423d, amount: 0.2, cell: 56, bias: 0.16, rough: 0.05, seed: 32 },
    }),
    ceiling: unusedCeiling,
    platform: () => bake(
      gratingField({ size: R, pitch: 21, bar: 2.6, cross: 64, rod: 1.8, depth: 5, frame: 5, seed: 48 }),
      {
        base: 0x5d6168, seamDark: 0.12, toneNoise: 0.03, grain: 0.02,
        rough: { base: 0.5, seam: 0.4, centre: 0, blotch: 0.06, grain: 0.03 },
        ao: 0.85, aoBlur: 3, seed: 49,
      },
      2,
    ),
    cover: () => bake(
      corrugationField({ size: R, ribs: 8, depth: 5, frame: 14, frameDepth: 6, wobble: 0.5, seed: 59 }),
      {
        base: 0xa3a3a3, seamDark: 0.8, toneNoise: 0.05, grain: 0.02,
        rough: { base: 0.62, seam: 0.12, centre: 0, blotch: 0.08, grain: 0.03 },
        ao: 0.5, aoBlur: 5, seed: 60,
        stain: { color: 0x5b3020, amount: 0.5, cell: 26, bias: 0.1, rough: 0.2, seed: 61 },
      },
      2,
    ),
    tower: () => panel(0x5d6168, 4, { cols: 1, rows: 4, rivets: 'bands', rivetInset: 10, rivetR: 2.5, rivetH: 1.2, rough: 0.55, seed: 73 }),
  },
  // Rust at dusk: oxidised steel everywhere, oily concrete underfoot.
  rustdusk: {
    floor: () => panel(0x625c56, 4, {
      cols: 1, rows: 1, seamHalf: 1, bevel: 1.5, depth: 2, rough: 0.8, tone: 0.05, grain: 0.03, seed: 21,
      stain: { color: 0x3a3430, amount: 0.3, cell: 72, bias: 0.1, rough: -0.2, seed: 22 },
    }),
    wall: () => bake(
      corrugationField({ size: R, ribs: 6, depth: 6, frame: 0, frameDepth: 0, wobble: 0.6, seed: 33 }),
      {
        base: 0x70513f, seamDark: 0.78, toneNoise: 0.06, grain: 0.02,
        rough: { base: 0.8, seam: 0.08, centre: 0, blotch: 0.06, grain: 0.03 },
        ao: 0.5, aoBlur: 5, seed: 34,
        stain: { color: 0x4a2c1e, amount: 0.3, cell: 60, bias: 0.08, rough: 0.05, seed: 35 },
      },
      4,
    ),
    ceiling: unusedCeiling,
    platform: () => bake(
      gratingField({ size: R, pitch: 21, bar: 2.6, cross: 64, rod: 1.8, depth: 5, frame: 5, seed: 50 }),
      {
        base: 0x6a584a, seamDark: 0.12, toneNoise: 0.04, grain: 0.02,
        rough: { base: 0.6, seam: 0.3, centre: 0, blotch: 0.06, grain: 0.03 },
        ao: 0.85, aoBlur: 3, seed: 51,
      },
      2,
    ),
    cover: () => panel(0x75704f, 2, {
      cols: 1, rows: 1, bevel: 3, depth: 4, rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5, rough: 0.7, seed: 62,
      stain: { color: 0x6a3a20, amount: 0.25, cell: 48, bias: 0.14, rough: 0.1, seed: 63 },
    }),
    tower: () => panel(0x5e4434, 4, {
      rivets: 'corners', rivetInset: 12, rivetR: 2.5, rivetH: 1.2, rough: 0.7, seed: 74,
      stain: { color: 0x7a4020, amount: 0.25, cell: 48, bias: 0.16, rough: 0.1, seed: 75 },
    }),
  },
  // Lab: clean and bright — the exception to the moody rule.
  lab: {
    floor: () => panel(0x868c94, 4, { inset: 11, rough: 0.5, seed: 12 }),
    wall: () => panel(0xa9aeb5, 4, { cols: 2, rows: 1, midSeam: 0.4, rough: 0.55, seed: 24 }),
    ceiling: unusedCeiling,
    platform: () => panel(0x9aa0a8, 2, { rivets: 'corners', rivetInset: 16, rivetR: 2.5, rivetH: 1.2, rough: 0.45, seed: 42 }),
    cover: () => bake(
      corrugationField({ size: R, ribs: 8, depth: 5, frame: 14, frameDepth: 6, wobble: 0.5, seed: 53 }),
      {
        base: 0xa8683a, seamDark: 0.82, toneNoise: 0.04, grain: 0.02,
        rough: { base: 0.6, seam: 0.15, centre: 0, blotch: 0.08, grain: 0.03 },
        ao: 0.5, aoBlur: 5, seed: 54,
      },
      2,
    ),
    tower: () => panel(0x646b75, 4, { rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5, seed: 68 }),
  },
};

let hazardCache: THREE.DataTexture | null = null;

// Safety stripes: 45° yellow/black bands, lightly worn at the edges. Tiles in
// world space (1 m per repeat, two stripe pairs), used on floor bands and
// platform lips.
export function getHazardTexture(): THREE.DataTexture {
  if (hazardCache) return hazardCache;
  const size = 128;
  const wear = blotchField(size, 16, 991);
  const data = new Uint8Array(size * size * 4);
  const period = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = ((x + y) % period) / period;
      const edge = Math.min(Math.abs(t - 0.5), t, 1 - t);
      const yellow = smoothstep(0.235, 0.265, Math.abs(t - 0.5)) < 0.5 ? 1 : 0;
      const soft = smoothstep(0, 0.02, edge);
      const w = 1 + wear[i] * 0.35 + (hash(x, y, 993) - 0.5) * 0.06;
      const r = yellow ? 0.79 : 0.1;
      const g = yellow ? 0.62 : 0.1;
      const b = yellow ? 0.14 : 0.1;
      const o = i * 4;
      data[o] = byte(r * w * (0.85 + 0.15 * soft));
      data[o + 1] = byte(g * w * (0.85 + 0.15 * soft));
      data[o + 2] = byte(b * w * (0.85 + 0.15 * soft));
      data[o + 3] = 255;
    }
  }
  hazardCache = dataTexture(data, size, true);
  return hazardCache;
}

const themeCache = new Map<TextureThemeId, ArenaTextures>();
let themeGenMs = 0;

// Surface set for a world theme (cached per theme for the session).
export function getThemeTextures(id: TextureThemeId): ArenaTextures {
  const hit = themeCache.get(id);
  if (hit) return hit;
  const t0 = performance.now();
  const r = THEME_RECIPES[id];
  const set: ArenaTextures = {
    floor: r.floor(),
    wall: r.wall(),
    ceiling: r.ceiling(),
    platform: r.platform(),
    cover: r.cover(),
    tower: r.tower(),
  };
  const ms = performance.now() - t0;
  themeGenMs += ms;
  themeCache.set(id, set);
  if (import.meta.env?.DEV) console.info(`[world] ${id} textures ${ms.toFixed(0)} ms (session ${themeGenMs.toFixed(0)} ms)`);
  return set;
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
