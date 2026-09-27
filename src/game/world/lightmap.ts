import * as THREE from 'three';
import type { AABB } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Baked lightmaps for the box-built arenas — computed at load, no assets.
//
// Every visible surface is an axis-aligned box face, so each face gets its own
// rectangle of texels in one atlas and every texel is lit analytically:
//   rgb  baked irradiance (linear, same units as a three.js light's
//        colour × intensity): theme ambient × short-range AO, open-sky
//        visibility (open-top maps), and the theme's coloured point/spot
//        lights with hard shadow rays against the map's AABBs (the light
//        position is jittered per texel, so after the blur the shadows get a
//        soft penumbra).
//   a    sun visibility (1 = lit). The sun itself stays a dynamic light so
//        normal maps respond to it and players keep their realtime shadow; the
//        map material multiplies it by this, so map-on-map sun shadows exist
//        even with realtime shadows off (low-spec).
// rgb is stored as sqrt(E / scale) in RGBA8 (more precision in the darks) —
// map-material.ts squares it back and multiplies by `scale`.
//
// Texel centres sit exactly on the face edges (sample 0 at u0, sample n-1 at
// u1, inset a hair), so bilinear filtering never reads outside a face's own
// rectangle; a 1-texel gutter duplicates the edges as extra insurance. The
// texture has no mipmaps.
// ─────────────────────────────────────────────────────────────────────────

export type V3 = [number, number, number];

export type LmLight = {
  p: V3; // position
  color: V3; // linear rgb × intensity (candela-ish, three's decay-2 convention)
  range: number; // hard cutoff, metres (three's `distance` window)
  spot?: { dir: V3; cosOuter: number; cosInner: number };
  radius?: number; // soft-shadow jitter radius, metres
};

export type LmSettings = {
  texel: number; // target texel size, metres
  maxTexels: number; // budget: the texel size grows until the atlas fits
  ambientUp: V3; // baked ambient irradiance for an up-facing texel (× AO)
  ambientDown: V3; // … and for a down-facing one (blended by normal.y)
  aoRadius: number;
  aoStrength: number; // 0..1
  aoRays: number;
  sky: { color: V3; rays: number; length: number } | null; // open-top sky irradiance
  sunDir: V3 | null; // unit vector TOWARD the sun
  sunIgnore: (boxIndex: number) => boolean; // boxes that don't block the sun
  lights: LmLight[];
  coarse: (boxIndex: number, axis: number, sign: number) => number; // texel multiplier per face
};

export type LmFace = {
  box: number;
  axis: 0 | 1 | 2; // normal axis
  sign: 1 | -1; // normal direction along it
  plane: number;
  ua: 0 | 1 | 2; // face u axis (matches the albedo UV convention in map.ts)
  va: 0 | 1 | 2;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  ax: number; // atlas texel of sample (0,0)
  ay: number;
  nu: number; // samples along u / v
  nv: number;
};

export type Lightmap = {
  texture: THREE.DataTexture;
  width: number;
  height: number;
  faces: LmFace[];
  byBox: Map<number, LmFace[]>;
  scale: number; // → material.lightMapIntensity
  texel: number; // texel size actually used
  texels: number; // baked (sampled) texels
  ms: number; // bake time
};

// Face axes: x-faces use (z, y), y-faces (x, z), z-faces (x, y) — the same
// world-projected UV convention the albedo textures use.
const UA: Array<0 | 1 | 2> = [2, 0, 0];
const VA: Array<0 | 1 | 2> = [1, 2, 1];

const EPS = 1e-6;
const OFFSET = 0.025; // sample lift off the face along its normal, metres
const CHUNK = 10; // texels per side of a candidate-gathering chunk

function lo(b: AABB, a: number): number {
  return a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z;
}
function hi(b: AABB, a: number): number {
  return a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z;
}

// Faces that can ever be seen: skips faces on the arena's outer shell facing
// out, and faces fully capped by a neighbouring (drawn) box.
export function extractFaces(boxes: AABB[], bounds: AABB, drawn: boolean[]): LmFace[] {
  const faces: LmFace[] = [];
  for (let i = 0; i < boxes.length; i++) {
    if (!drawn[i]) continue;
    const b = boxes[i];
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      const ua = UA[axis];
      const va = VA[axis];
      const u0 = lo(b, ua);
      const u1 = hi(b, ua);
      const v0 = lo(b, va);
      const v1 = hi(b, va);
      if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) continue;
      for (const sign of [1, -1] as const) {
        const plane = sign > 0 ? hi(b, axis) : lo(b, axis);
        if (sign > 0 && plane >= hi(bounds, axis) - EPS) continue;
        if (sign < 0 && plane <= lo(bounds, axis) + EPS) continue;
        let covered = false;
        for (let j = 0; j < boxes.length && !covered; j++) {
          if (j === i || !drawn[j]) continue;
          const c = boxes[j];
          const outward =
            sign > 0
              ? lo(c, axis) <= plane + EPS && hi(c, axis) > plane + 1e-3
              : hi(c, axis) >= plane - EPS && lo(c, axis) < plane - 1e-3;
          if (!outward) continue;
          if (lo(c, ua) <= u0 + EPS && hi(c, ua) >= u1 - EPS && lo(c, va) <= v0 + EPS && hi(c, va) >= v1 - EPS) {
            covered = true;
          }
        }
        if (covered) continue;
        faces.push({ box: i, axis, sign, plane, ua, va, u0, u1, v0, v1, ax: 0, ay: 0, nu: 0, nv: 0 });
      }
    }
  }
  return faces;
}

// Shelf-pack the face rectangles (+1 texel gutter each side).
function pack(faces: LmFace[]): { width: number; height: number } {
  const order = faces.map((_, i) => i).sort((a, b) => faces[b].nv - faces[a].nv || faces[b].nu - faces[a].nu);
  let area = 0;
  let widest = 0;
  for (const f of faces) {
    area += (f.nu + 2) * (f.nv + 2);
    widest = Math.max(widest, f.nu + 2);
  }
  const width = Math.max(widest, Math.ceil(Math.sqrt(area * 1.12) / 4) * 4);
  let x = 0;
  let y = 0;
  let row = 0;
  for (const i of order) {
    const f = faces[i];
    const w = f.nu + 2;
    const h = f.nv + 2;
    if (x + w > width) {
      x = 0;
      y += row;
      row = 0;
    }
    f.ax = x + 1;
    f.ay = y + 1;
    x += w;
    row = Math.max(row, h);
  }
  return { width, height: Math.ceil((y + row) / 4) * 4 };
}

// Atlas UV (0..1) of a world point projected onto a face (clamped to it).
export function faceUv(lm: { width: number; height: number }, f: LmFace, p: V3): [number, number] {
  const s = Math.min(1, Math.max(0, (p[f.ua] - f.u0) / (f.u1 - f.u0)));
  const t = Math.min(1, Math.max(0, (p[f.va] - f.v0) / (f.v1 - f.v0)));
  return [(f.ax + s * (f.nu - 1) + 0.5) / lm.width, (f.ay + t * (f.nv - 1) + 0.5) / lm.height];
}

// Deterministic per-texel hash → [0, 1).
function hash2(x: number, y: number, s: number): number {
  let n = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

// Cosine-weighted Fibonacci-spiral directions in a z-up local frame.
function cosineDirs(k: number): { x: Float64Array; y: Float64Array; z: Float64Array } {
  const x = new Float64Array(k);
  const y = new Float64Array(k);
  const z = new Float64Array(k);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < k; i++) {
    const r = (i + 0.5) / k;
    const phi = i * golden;
    const s = Math.sqrt(r);
    x[i] = Math.cos(phi) * s;
    y[i] = Math.sin(phi) * s;
    z[i] = Math.sqrt(1 - r);
  }
  return { x, y, z };
}

// Candidate occluders whose AABB intersects [min, max] (exclusive of `skip`).
function gather(B: Float64Array, n: number, mn: V3, mx: V3, skip: number, ignore?: (i: number) => boolean): Int32Array {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (k === skip || (ignore && ignore(k))) continue;
    const o = k * 6;
    if (B[o] > mx[0] || B[o + 3] < mn[0] || B[o + 1] > mx[1] || B[o + 4] < mn[1] || B[o + 2] > mx[2] || B[o + 5] < mn[2]) {
      continue;
    }
    out.push(k);
  }
  // Big boxes first: they block the most rays, so visibility tests exit early.
  out.sort((a, b) => vol(B, b) - vol(B, a));
  return Int32Array.from(out);
}
function vol(B: Float64Array, k: number): number {
  const o = k * 6;
  return (B[o + 3] - B[o]) * (B[o + 4] - B[o + 1]) * (B[o + 5] - B[o + 2]);
}

// Nearest hit distance along the ray within tmax, or Infinity.
function nearest(
  ox: number, oy: number, oz: number, ix: number, iy: number, iz: number,
  tmax: number, list: Int32Array, B: Float64Array,
): number {
  let best = tmax;
  let hit = false;
  for (let q = 0; q < list.length; q++) {
    const o = list[q] * 6;
    let t0 = (B[o] - ox) * ix;
    let t1 = (B[o + 3] - ox) * ix;
    let tn = t0 < t1 ? t0 : t1;
    let tf = t0 < t1 ? t1 : t0;
    t0 = (B[o + 1] - oy) * iy;
    t1 = (B[o + 4] - oy) * iy;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    if (tn > tf) continue;
    t0 = (B[o + 2] - oz) * iz;
    t1 = (B[o + 5] - oz) * iz;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    if (tn > tf || tf < 0 || tn >= best) continue;
    best = tn < 0 ? 0 : tn;
    hit = true;
  }
  return hit ? best : Infinity;
}

// Any hit within tmax.
function blocked(
  ox: number, oy: number, oz: number, ix: number, iy: number, iz: number,
  tmax: number, list: Int32Array, B: Float64Array,
): boolean {
  for (let q = 0; q < list.length; q++) {
    const o = list[q] * 6;
    let t0 = (B[o] - ox) * ix;
    let t1 = (B[o + 3] - ox) * ix;
    let tn = t0 < t1 ? t0 : t1;
    let tf = t0 < t1 ? t1 : t0;
    t0 = (B[o + 1] - oy) * iy;
    t1 = (B[o + 4] - oy) * iy;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    if (tn > tf) continue;
    t0 = (B[o + 2] - oz) * iz;
    t1 = (B[o + 5] - oz) * iz;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    if (tn > tf || tf < 0 || tn > tmax) continue;
    return true;
  }
  return false;
}

const inv = (d: number) => 1 / (Math.abs(d) < 1e-9 ? (d < 0 ? -1e-9 : 1e-9) : d);

export function bakeLightmap(boxes: AABB[], bounds: AABB, drawn: boolean[], cfg: LmSettings): Lightmap {
  const t0 = performance.now();
  const n = boxes.length;
  const B = new Float64Array(n * 6);
  let m = 0;
  const index: number[] = []; // occluder slot → box index
  for (let i = 0; i < n; i++) {
    if (!drawn[i]) continue;
    const b = boxes[i];
    B.set([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], m * 6);
    index.push(i);
    m++;
  }
  const slotOf = new Map(index.map((box, slot) => [box, slot]));
  const ignoreSun = (slot: number) => cfg.sunIgnore(index[slot]);

  const faces = extractFaces(boxes, bounds, drawn);

  // Texel size: grow until the budget fits.
  let texel = cfg.texel;
  const count = (t: number) => {
    let total = 0;
    for (const f of faces) {
      const tf = t * cfg.coarse(f.box, f.axis, f.sign);
      f.nu = Math.max(2, Math.ceil((f.u1 - f.u0) / tf) + 1);
      f.nv = Math.max(2, Math.ceil((f.v1 - f.v0) / tf) + 1);
      total += f.nu * f.nv;
    }
    return total;
  };
  let texels = count(texel);
  for (let guard = 0; texels > cfg.maxTexels && guard < 8; guard++) {
    texel *= Math.sqrt(texels / cfg.maxTexels) * 1.02;
    texels = count(texel);
  }
  const { width, height } = pack(faces);

  const W = width;
  const H = height;
  const R = new Float32Array(W * H);
  const G = new Float32Array(W * H);
  const Bl = new Float32Array(W * H);
  const A = new Float32Array(W * H);
  const valid = new Uint8Array(W * H);

  const ao = cosineDirs(cfg.aoRays);
  const sky = cfg.sky ? cosineDirs(cfg.sky.rays) : null;
  const lights = cfg.lights;
  const sun = cfg.sunDir;
  const sunInv: V3 | null = sun ? [inv(sun[0]), inv(sun[1]), inv(sun[2])] : null;
  const P: V3 = [0, 0, 0];
  const mn: V3 = [0, 0, 0];
  const mx: V3 = [0, 0, 0];

  // Per-texel light-position jitter (soft shadows), a fixed table instead of
  // hashing per texel/light.
  const JIT = 64;
  const jitter = new Float64Array(JIT * 3);
  for (let k = 0; k < JIT * 3; k++) jitter[k] = hash2(k, 7, 91) - 0.5;
  const d: V3 = [0, 0, 0];

  for (const f of faces) {
    const a = f.axis;
    const s = f.sign;
    const own = slotOf.get(f.box) ?? -1;
    const eu = Math.min(0.02, (f.u1 - f.u0) * 0.25);
    const ev = Math.min(0.02, (f.v1 - f.v0) * 0.25);
    const up = a === 1 ? (s > 0 ? 1 : 0) : 0.5;
    const ambR = cfg.ambientDown[0] + (cfg.ambientUp[0] - cfg.ambientDown[0]) * up;
    const ambG = cfg.ambientDown[1] + (cfg.ambientUp[1] - cfg.ambientDown[1]) * up;
    const ambB = cfg.ambientDown[2] + (cfg.ambientUp[2] - cfg.ambientDown[2]) * up;
    const ua = f.ua;
    const va = f.va;
    const uAt = (i: number) => Math.min(f.u1 - eu, Math.max(f.u0 + eu, f.u0 + (i / (f.nu - 1)) * (f.u1 - f.u0)));
    const vAt = (j: number) => Math.min(f.v1 - ev, Math.max(f.v0 + ev, f.v0 + (j / (f.nv - 1)) * (f.v1 - f.v0)));
    const sunOn = !!sun && sun[a] * s > 0;

    // Candidate occluder lists are gathered per CHUNK of texels (not per
    // face), so a 70 m floor doesn't test every box on the map for every ray.
    for (let cj0 = 0; cj0 < f.nv; cj0 += CHUNK) {
      const cj1 = Math.min(f.nv, cj0 + CHUNK);
      for (let ci0 = 0; ci0 < f.nu; ci0 += CHUNK) {
        const ci1 = Math.min(f.nu, ci0 + CHUNK);
        const cu0 = uAt(ci0) - 0.01;
        const cu1 = uAt(ci1 - 1) + 0.01;
        const cv0 = vAt(cj0) - 0.01;
        const cv1 = vAt(cj1 - 1) + 0.01;
        const region = (reach: number) => {
          mn[ua] = cu0 - reach;
          mx[ua] = cu1 + reach;
          mn[va] = cv0 - reach;
          mx[va] = cv1 + reach;
          mn[a] = s > 0 ? f.plane - 0.01 : f.plane - reach;
          mx[a] = s > 0 ? f.plane + reach : f.plane + 0.01;
        };
        region(cfg.aoRadius);
        const near = gather(B, m, mn, mx, own);
        let skyList: Int32Array | null = null;
        if (sky && cfg.sky) {
          region(cfg.sky.length);
          skyList = gather(B, m, mn, mx, own);
        }
        let sunList: Int32Array | null = null;
        if (sun && sunOn) {
          region(0);
          const reach = 90;
          for (let k = 0; k < 3; k++) {
            const dd = sun[k] * reach;
            const l0 = mn[k];
            const h0 = mx[k];
            mn[k] = Math.min(l0, l0 + dd);
            mx[k] = Math.max(h0, h0 + dd);
          }
          sunList = gather(B, m, mn, mx, own, ignoreSun);
        }
        // Lights in front of this chunk and in range of it.
        const lightIdx: number[] = [];
        const lightLists: Int32Array[] = [];
        for (let li = 0; li < lights.length; li++) {
          const L = lights[li];
          if ((L.p[a] - f.plane) * s <= 0.01) continue;
          const du = Math.max(cu0 - L.p[ua], 0, L.p[ua] - cu1);
          const dv = Math.max(cv0 - L.p[va], 0, L.p[va] - cv1);
          const dn = L.p[a] - f.plane;
          const rr = L.range + (L.radius ?? 0);
          if (du * du + dv * dv + dn * dn >= rr * rr) continue;
          region(0);
          const r = L.radius ?? 0;
          for (let k = 0; k < 3; k++) {
            mn[k] = Math.min(mn[k], L.p[k] - r);
            mx[k] = Math.max(mx[k], L.p[k] + r);
          }
          lightIdx.push(li);
          lightLists.push(gather(B, m, mn, mx, own));
        }

        for (let j = cj0; j < cj1; j++) {
          const v = vAt(j);
          for (let i = ci0; i < ci1; i++) {
            const u = uAt(i);
            P[a] = f.plane + s * OFFSET;
            P[ua] = u;
            P[va] = v;
            const px = P[0];
            const py = P[1];
            const pz = P[2];
            const ti = (f.ay + j) * W + f.ax + i;

            // Buried under a neighbouring solid → filled by dilation later.
            let inside = false;
            for (let q = 0; q < near.length; q++) {
              const o = near[q] * 6;
              if (px > B[o] + 1e-4 && px < B[o + 3] - 1e-4 && py > B[o + 1] + 1e-4 && py < B[o + 4] - 1e-4 && pz > B[o + 2] + 1e-4 && pz < B[o + 5] - 1e-4) {
                inside = true;
                break;
              }
            }
            if (inside) continue;
            valid[ti] = 1;

            const rot = hash2(f.ax + i, f.ay + j, 17) * Math.PI * 2;
            const cr = Math.cos(rot);
            const sr = Math.sin(rot);

            // Short-range AO (distance-weighted, cosine-weighted).
            let occ = 0;
            if (near.length) {
              for (let k = 0; k < ao.x.length; k++) {
                d[a] = s * ao.z[k];
                d[ua] = ao.x[k] * cr - ao.y[k] * sr;
                d[va] = ao.x[k] * sr + ao.y[k] * cr;
                const t = nearest(px, py, pz, inv(d[0]), inv(d[1]), inv(d[2]), cfg.aoRadius, near, B);
                if (t !== Infinity) occ += 1 - t / cfg.aoRadius;
              }
              occ /= ao.x.length;
            }
            const aoF = 1 - cfg.aoStrength * Math.min(1, occ * 1.3);
            let r = ambR * aoF;
            let g = ambG * aoF;
            let bb = ambB * aoF;

            // Open sky.
            if (sky && cfg.sky && skyList) {
              let vis = 0;
              for (let k = 0; k < sky.x.length; k++) {
                d[a] = s * sky.z[k];
                d[ua] = sky.x[k] * cr - sky.y[k] * sr;
                d[va] = sky.x[k] * sr + sky.y[k] * cr;
                if (d[1] <= 0.02) continue; // below the horizon: ground, not sky
                if (!blocked(px, py, pz, inv(d[0]), inv(d[1]), inv(d[2]), cfg.sky.length, skyList, B)) vis++;
              }
              vis /= sky.x.length;
              r += cfg.sky.color[0] * vis;
              g += cfg.sky.color[1] * vis;
              bb += cfg.sky.color[2] * vis;
            }

            // Sun visibility (alpha).
            let sunVis = 1;
            if (sunInv && sunList && sunList.length) {
              sunVis = blocked(px, py, pz, sunInv[0], sunInv[1], sunInv[2], 1e5, sunList, B) ? 0 : 1;
            }

            // Point / spot lights.
            const jb = ((i * 7 + j * 13) & (JIT - 1)) * 3;
            for (let q = 0; q < lightIdx.length; q++) {
              const L = lights[lightIdx[q]];
              const rad = (L.radius ?? 0) * 2;
              const jo = (jb + q * 9) % (JIT * 3);
              let dx = L.p[0] + jitter[jo] * rad - px;
              let dy = L.p[1] + jitter[(jo + 1) % (JIT * 3)] * rad - py;
              let dz = L.p[2] + jitter[(jo + 2) % (JIT * 3)] * rad - pz;
              const d2 = dx * dx + dy * dy + dz * dz;
              const r2 = L.range * L.range;
              if (d2 >= r2) continue;
              const dist = Math.sqrt(d2);
              dx /= dist;
              dy /= dist;
              dz /= dist;
              const ndl = (a === 0 ? dx : a === 1 ? dy : dz) * s;
              if (ndl <= 0) continue;
              let spotF = 1;
              if (L.spot) {
                const cd = -(dx * L.spot.dir[0] + dy * L.spot.dir[1] + dz * L.spot.dir[2]);
                if (cd <= L.spot.cosOuter) continue;
                const tt = Math.min(1, (cd - L.spot.cosOuter) / Math.max(1e-4, L.spot.cosInner - L.spot.cosOuter));
                spotF = tt * tt * (3 - 2 * tt);
              }
              const x2 = d2 / r2;
              const win = (1 - x2 * x2) * (1 - x2 * x2);
              const fall = (win / Math.max(d2, 0.36)) * ndl * spotF;
              if (fall < 1e-4) continue;
              if (blocked(px, py, pz, inv(dx), inv(dy), inv(dz), dist - 0.05, lightLists[q], B)) continue;
              r += L.color[0] * fall;
              g += L.color[1] * fall;
              bb += L.color[2] * fall;
            }

            R[ti] = r;
            G[ti] = g;
            Bl[ti] = bb;
            A[ti] = sunVis;
          }
        }
      }
    }
  }

  // ── dilate buried texels, blur, gutter ─────────────────────────────────
  const tmpR = new Float32Array(W * H);
  const tmpG = new Float32Array(W * H);
  const tmpB = new Float32Array(W * H);
  const tmpA = new Float32Array(W * H);
  for (const f of faces) {
    dilate(f, W, R, G, Bl, A, valid);
    blurFace(f, W, R, tmpR);
    blurFace(f, W, G, tmpG);
    blurFace(f, W, Bl, tmpB);
    blurFace(f, W, A, tmpA);
  }

  // Encode scale: a high percentile of the lit texels, so a single hot texel
  // next to a fixture doesn't squash the rest of the range.
  const peaks: number[] = [];
  for (const f of faces) {
    for (let j = 0; j < f.nv; j += 2) {
      for (let i = 0; i < f.nu; i += 2) {
        const ti = (f.ay + j) * W + f.ax + i;
        peaks.push(Math.max(R[ti], G[ti], Bl[ti]));
      }
    }
  }
  peaks.sort((x, y) => x - y);
  const scale = Math.max(1, peaks[Math.floor(peaks.length * 0.995)] ?? 1) * 1.1;

  const data = new Uint8Array(W * H * 4);
  const enc = (e: number) => {
    const t = Math.sqrt(Math.max(0, e) / scale);
    return t >= 1 ? 255 : (t * 255 + 0.5) | 0;
  };
  for (const f of faces) {
    for (let j = -1; j <= f.nv; j++) {
      const jj = Math.min(f.nv - 1, Math.max(0, j));
      for (let i = -1; i <= f.nu; i++) {
        const ii = Math.min(f.nu - 1, Math.max(0, i));
        const src = (f.ay + jj) * W + f.ax + ii;
        const dst = ((f.ay + j) * W + f.ax + i) * 4;
        data[dst] = enc(R[src]);
        data[dst + 1] = enc(G[src]);
        data[dst + 2] = enc(Bl[src]);
        const av = A[src];
        data[dst + 3] = av >= 1 ? 255 : av <= 0 ? 0 : (av * 255 + 0.5) | 0;
      }
    }
  }

  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.channel = 1;
  texture.needsUpdate = true;

  const byBox = new Map<number, LmFace[]>();
  for (const f of faces) {
    const list = byBox.get(f.box);
    if (list) list.push(f);
    else byBox.set(f.box, [f]);
  }
  return {
    texture,
    width: W,
    height: H,
    faces,
    byBox,
    scale,
    texel,
    texels,
    ms: performance.now() - t0,
  };
}

// Buried texels take the mean of their valid neighbours, ring by ring; any
// left after a few rings are never seen, so they take the face mean.
function dilate(
  f: LmFace, W: number,
  R: Float32Array, G: Float32Array, B: Float32Array, A: Float32Array, valid: Uint8Array,
) {
  let missing = 0;
  let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
  for (let j = 0; j < f.nv; j++) {
    for (let i = 0; i < f.nu; i++) {
      const ti = (f.ay + j) * W + f.ax + i;
      if (!valid[ti]) missing++;
      else {
        sr += R[ti]; sg += G[ti]; sb += B[ti]; sa += A[ti]; cnt++;
      }
    }
  }
  if (!missing) return;
  const fill: number[] = [];
  for (let ring = 0; ring < 3 && missing > 0; ring++) {
    fill.length = 0;
    for (let j = 0; j < f.nv; j++) {
      for (let i = 0; i < f.nu; i++) {
        const ti = (f.ay + j) * W + f.ax + i;
        if (valid[ti]) continue;
        let r = 0, g = 0, b = 0, al = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const y = j + dj;
          if (y < 0 || y >= f.nv) continue;
          for (let di = -1; di <= 1; di++) {
            const x = i + di;
            if (x < 0 || x >= f.nu || (di === 0 && dj === 0)) continue;
            const ni = (f.ay + y) * W + f.ax + x;
            if (valid[ni] !== 1) continue;
            r += R[ni]; g += G[ni]; b += B[ni]; al += A[ni]; c++;
          }
        }
        if (!c) continue;
        R[ti] = r / c; G[ti] = g / c; B[ti] = b / c; A[ti] = al / c;
        fill.push(ti);
      }
    }
    for (const ti of fill) valid[ti] = 1;
    missing -= fill.length;
  }
  if (missing > 0) {
    const mr = cnt ? sr / cnt : 0;
    const mg = cnt ? sg / cnt : 0;
    const mb = cnt ? sb / cnt : 0;
    const ma = cnt ? sa / cnt : 1;
    for (let j = 0; j < f.nv; j++) {
      for (let i = 0; i < f.nu; i++) {
        const ti = (f.ay + j) * W + f.ax + i;
        if (valid[ti]) continue;
        R[ti] = mr; G[ti] = mg; B[ti] = mb; A[ti] = ma;
        valid[ti] = 1;
      }
    }
  }
}

// Separable [1 2 1] blur clamped to the face rectangle.
function blurFace(f: LmFace, W: number, C: Float32Array, tmp: Float32Array) {
  const { nu, nv, ax, ay } = f;
  for (let j = 0; j < nv; j++) {
    const row = (ay + j) * W + ax;
    for (let i = 0; i < nu; i++) {
      const l = C[row + (i > 0 ? i - 1 : i)];
      const r = C[row + (i < nu - 1 ? i + 1 : i)];
      tmp[row + i] = (l + 2 * C[row + i] + r) * 0.25;
    }
  }
  for (let j = 0; j < nv; j++) {
    const up = (ay + (j > 0 ? j - 1 : j)) * W + ax;
    const row = (ay + j) * W + ax;
    const dn = (ay + (j < nv - 1 ? j + 1 : j)) * W + ax;
    for (let i = 0; i < nu; i++) C[row + i] = (tmp[up + i] + 2 * tmp[row + i] + tmp[dn + i]) * 0.25;
  }
}
