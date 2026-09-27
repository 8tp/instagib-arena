import * as THREE from 'three';
import type { SurfaceKind } from '../textures';
import type { AABB } from '../types';
import { faceUv, type LmFace, type Lightmap, type V3 } from './lightmap';
import { FACE_NORMAL, type LightDef, type WorldTheme } from './themes';

// ─────────────────────────────────────────────────────────────────────────
// Architectural dressing generated from the AABBs — render-only, merged into
// a handful of buffers: trim metal, emissive fixtures, floor paint, hazard
// stripes, and (outside the play space) skyline silhouettes.
//
// SIGHT-LINE RULE: rails pass through anything that isn't an AABB, so every
// piece INSIDE the arena sits flush on a collision face and protrudes
// ≤ MAX_PROUD (clamped in onFace / the collar ring), or is painted onto the
// floor (4 mm). Free-standing props (flood masts, skyline) are only allowed
// outside the arena bounds. Pieces sample the lightmap of the face they're
// mounted on (uv1 = the vertex projected onto that face), so a baseboard in a
// dark corner is dark and a fixture housing sits in its own pool of light.
//
// Fixture levels are in LINEAR radiance before ACES: a lens core peaks at
// FIXTURE_CORE (just under the bloom threshold, ~0.8 on screen) and its
// diffuser ring at FIXTURE_RING (~0.6 on screen), both keeping the light's
// hue — lamps read as lamps, not white holes.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_PROUD = 0.15;
const FIXTURE_CORE = 1.35;
const FIXTURE_RING = 0.62;

type Piece = {
  min: V3;
  max: V3;
  parent: LmFace | null;
  color: THREE.Color; // linear
  color2?: THREE.Color; // linear colour at the top (max y) — vertical gradient
  mask: number; // bit per face to skip: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z
};

export type DressingBuild = {
  metal: THREE.BufferGeometry | null;
  fixtures: THREE.BufferGeometry | null;
  paint: THREE.BufferGeometry | null;
  hazard: THREE.BufferGeometry | null;
  skyline: THREE.BufferGeometry | null;
  pieces: number;
};

export type DressingInput = {
  boxes: AABB[]; // RENDER boxes (perimeter walls may be lowered to sky height)
  bounds: AABB;
  drawn: boolean[];
  slots: SurfaceKind[];
  perimeter: boolean[];
  lm: Lightmap;
  theme: WorldTheme;
  tile: number; // dress texture tile (metres per repeat)
  low: boolean; // low tier: skip the purely decorative ribs
};

const bit = (axis: number, sign: number) => 1 << (axis * 2 + (sign > 0 ? 0 : 1));

const lin = (hex: number) => new THREE.Color(hex);

// Light colour → fixture colour: saturation nudged up (a lamp shows its hue
// even when its light is near-white), then scaled so the PEAK channel is
// `level` — hue kept, never a blown white.
function lensColor(hex: number, level: number, sat = 1.25): THREE.Color {
  const c = new THREE.Color(hex);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.setRGB(
    Math.max(0, l + (c.r - l) * sat),
    Math.max(0, l + (c.g - l) * sat),
    Math.max(0, l + (c.b - l) * sat),
  );
  const peak = Math.max(c.r, c.g, c.b, 1e-4);
  return c.multiplyScalar(level / peak);
}

// A slab mounted on face f: spans [u0,u1] × [v0,v1] in the face's axes and
// `d` metres out along its normal. Its back (against the face) is skipped.
function onFace(f: LmFace, u0: number, u1: number, v0: number, v1: number, d: number, color: THREE.Color, extraMask = 0): Piece {
  const min: V3 = [0, 0, 0];
  const max: V3 = [0, 0, 0];
  min[f.ua] = Math.min(u0, u1);
  max[f.ua] = Math.max(u0, u1);
  min[f.va] = Math.min(v0, v1);
  max[f.va] = Math.max(v0, v1);
  const a = f.plane;
  const b = f.plane + f.sign * Math.min(d, MAX_PROUD);
  min[f.axis] = Math.min(a, b);
  max[f.axis] = Math.max(a, b);
  return { min, max, parent: f, color, mask: bit(f.axis, -f.sign) | extraMask };
}

// The face (axis, sign) whose plane passes through p and contains it.
function findFace(lm: Lightmap, axis: number, sign: number, p: V3): LmFace | null {
  let best: LmFace | null = null;
  let bestD = Infinity;
  for (const f of lm.faces) {
    if (f.axis !== axis || f.sign !== sign) continue;
    const dp = Math.abs(f.plane - p[axis]);
    if (dp > 0.02) continue;
    const du = Math.max(f.u0 - p[f.ua], 0, p[f.ua] - f.u1);
    const dv = Math.max(f.v0 - p[f.va], 0, p[f.va] - f.v1);
    const d = du + dv;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return bestD < 0.05 ? best : null;
}

const faceAxis = (face: string) => (face[1] === 'x' ? 0 : face[1] === 'y' ? 1 : 2);
const faceSign = (face: string) => (face[0] === '+' ? 1 : -1);

function insideBounds(b: { min: V3; max: V3 }, bounds: AABB): boolean {
  return (
    b.max[0] > bounds.min.x && b.min[0] < bounds.max.x &&
    b.max[1] > bounds.min.y && b.min[1] < bounds.max.y &&
    b.max[2] > bounds.min.z && b.min[2] < bounds.max.z
  );
}

export function buildDressing(inp: DressingInput): DressingBuild {
  const { boxes, bounds, drawn, slots, perimeter, lm, theme, low } = inp;
  const st = theme.dress;
  const metal: Piece[] = [];
  const fixtures: Piece[] = [];
  const paint: Piece[] = [];
  const hazard: Piece[] = [];
  const skyline: Piece[] = [];
  const floorY = boxes[0].max.y;
  // Trim reads a touch LIGHTER than the surface it's on (vertex colour may
  // exceed 1: it multiplies the slot albedo).
  const trimColor = lin(st.tint).multiplyScalar(st.bright ?? 1.3);
  const housing = trimColor.clone().multiplyScalar(0.45);
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const ceilY = theme.openSky ? Infinity : boxes[1].min.y;

  // Fixture footprints per face, so ribs don't run through a lamp.
  const fixtureSpans = new Map<LmFace, Array<[number, number]>>();
  const fixtureFaces: Array<{ def: LightDef; face: LmFace }> = [];
  for (const def of theme.lights) {
    if (def.fixture === false || def.size[0] < 0.05 || def.free) continue;
    const f = findFace(lm, faceAxis(def.face), faceSign(def.face), def.at);
    if (!f) {
      // A fixture must hang on a real, visible face (flush-mount rule).
      if (import.meta.env?.DEV) console.warn(`[world] ${theme.id}: no ${def.face} face at`, def.at);
      continue;
    }
    fixtureFaces.push({ def, face: f });
    const span: [number, number] = [def.at[f.ua] - def.size[0] / 2 - 0.3, def.at[f.ua] + def.size[0] / 2 + 0.3];
    const list = fixtureSpans.get(f);
    if (list) list.push(span);
    else fixtureSpans.set(f, [span]);
  }
  const clearOfFixtures = (f: LmFace, u0: number, u1: number) =>
    !(fixtureSpans.get(f) ?? []).some(([a, b]) => u1 > a && u0 < b);

  for (const f of lm.faces) {
    const i = f.box;
    if (i < 2) continue;
    const b = boxes[i];
    const vertical = f.axis !== 1;
    const slot = slots[i];
    const top = b.max.y;
    const height = b.max.y - b.min.y;
    // x-faces run a slab-depth past both ends so outside corners close
    // without the z-face pieces overlapping them.
    const ext = (d: number) => (f.axis === 0 ? d : 0);

    // Baseboards / kick plates where walls and pillars meet the floor.
    if (st.baseboard && vertical && b.min.y <= floorY + 1e-3 && height >= 1.8 && (slot === 'wall' || slot === 'tower')) {
      const { h, d } = st.baseboard;
      metal.push(onFace(f, f.u0 - ext(d), f.u1 + ext(d), floorY, floorY + Math.min(h, height * 0.4), d, trimColor, bit(1, -1)));
    }

    // Machined (or hazard-striped) band on the top edge of platforms / cover.
    if (st.edges && vertical && (slot === 'platform' || slot === 'cover') && height >= 0.3 && !perimeter[i]) {
      const { h, d } = st.edges;
      const hz = st.edges.hazard && b.min.y > 0.5;
      (hz ? hazard : metal).push(onFace(f, f.u0 - ext(d), f.u1 + ext(d), top - Math.min(h, height), top, d, trimColor));
    }

    if (!perimeter[i] || !vertical) continue;
    // ── perimeter walls ──
    const wallTop = Math.min(top, ceilY);
    if (st.crown) {
      const { h, d } = st.crown;
      metal.push(onFace(f, f.u0, f.u1, wallTop - h, wallTop, d, trimColor));
    }
    if (low) continue;
    for (const band of st.bands ?? []) {
      if (band.y + band.h / 2 > wallTop - 0.8) continue;
      metal.push(onFace(f, f.u0, f.u1, band.y - band.h / 2, band.y + band.h / 2, band.d, trimColor));
    }
    if (st.pilasters) {
      const { spacing, w, d } = st.pilasters;
      // Stop under the crown so the two never share a face (z-fight).
      const ptop = Math.min(wallTop - (st.crown?.h ?? 0), st.pilasters.top ?? wallTop);
      const centre = f.ua === 0 ? cx : cz;
      const n = Math.ceil((f.u1 - f.u0) / spacing) + 1;
      for (let k = -n; k <= n; k++) {
        const uc = centre + k * spacing;
        const u0 = uc - w / 2;
        const u1 = uc + w / 2;
        if (u0 < f.u0 + 0.5 || u1 > f.u1 - 0.5) continue;
        // Keep to the room interior (not buried in a side wall).
        const perpLo = f.ua === 0 ? bounds.min.x : bounds.min.z;
        const perpHi = f.ua === 0 ? bounds.max.x : bounds.max.z;
        if (u0 < perpLo + 2.2 || u1 > perpHi - 2.2) continue;
        if (!clearOfFixtures(f, u0, u1)) continue;
        metal.push(onFace(f, u0, u1, floorY, ptop, d, trimColor, bit(1, -1)));
      }
    }
  }

  // Ceiling ribs (closed rooms).
  if (st.beams && !theme.openSky && !low) {
    const { spacing, w, d } = st.beams;
    const ceil = lm.faces.find((f) => f.box === 1 && f.axis === 1 && f.sign < 0);
    if (ceil) {
      const n = Math.ceil((bounds.max.x - bounds.min.x) / spacing);
      for (let k = -n; k <= n; k++) {
        const xc = cx + k * spacing;
        if (xc - w / 2 < bounds.min.x + 2.5 || xc + w / 2 > bounds.max.x - 2.5) continue;
        metal.push(onFace(ceil, xc - w / 2, xc + w / 2, bounds.min.z, bounds.max.z, d, trimColor));
      }
    }
  }

  // Pillar bases + capitals.
  if (st.collars) {
    const { h } = st.collars;
    const d = Math.min(st.collars.d, MAX_PROUD);
    for (let i = 2; i < boxes.length; i++) {
      if (!drawn[i] || slots[i] !== 'tower') continue;
      const b = boxes[i];
      const sx = b.max.x - b.min.x;
      const sz = b.max.z - b.min.z;
      if (sx > 2.6 || sz > 2.6 || b.max.y - b.min.y < 3) continue;
      const parent = (lm.byBox.get(i) ?? []).find((f) => f.axis === 0 && f.sign > 0) ?? null;
      const ring = (y0: number, y1: number, mask: number): Piece => ({
        min: [b.min.x - d, y0, b.min.z - d],
        max: [b.max.x + d, y1, b.max.z + d],
        parent,
        color: trimColor,
        mask,
      });
      metal.push(ring(b.min.y, b.min.y + h, b.min.y <= floorY + 1e-3 ? bit(1, -1) : 0));
      if (b.max.y < ceilY - 0.01) metal.push(ring(b.max.y - h, b.max.y, 0));
    }
  }

  // Light fixtures mounted on faces.
  for (const { def, face } of fixtureFaces) {
    const [w, h] = def.size;
    const uc = def.at[face.ua];
    const vc = def.at[face.va];
    const kind = def.kind ?? (def.intensity > 0 ? 'lamp' : 'strip');
    const level = def.level ?? 1;
    if (kind === 'strip') {
      // Emissive band (reactor core strips, pillar rings): flat, saturated.
      fixtures.push(onFace(face, uc - w / 2, uc + w / 2, vc - h / 2, vc + h / 2, 0.05, lensColor(def.color, 1.9 * level, 1.4)));
    } else if (kind === 'window') {
      // Framed glass with a warm interior glow (brighter low, dimmer high)
      // and a mullion cross over it.
      const fr = 0.12;
      metal.push(onFace(face, uc - w / 2 - fr, uc + w / 2 + fr, vc - h / 2 - fr, vc + h / 2 + fr, 0.05, trimColor));
      const glass = onFace(face, uc - w / 2, uc + w / 2, vc - h / 2, vc + h / 2, 0.065, lensColor(def.color, 0.95 * level, 1.3));
      glass.color2 = lensColor(def.color, 0.38 * level, 1.1).lerp(new THREE.Color(0x3a4a6a), 0.25);
      fixtures.push(glass);
      const m = 0.045;
      metal.push(onFace(face, uc - m, uc + m, vc - h / 2, vc + h / 2, 0.085, trimColor));
      metal.push(onFace(face, uc - w / 2, uc + w / 2, vc - m, vc + m, 0.085, trimColor));
    } else {
      // Lamp: dark housing frame, diffuser ring, brighter core lens.
      const fr = Math.max(0.08, Math.min(w, h) * 0.12);
      metal.push(onFace(face, uc - w / 2 - fr, uc + w / 2 + fr, vc - h / 2 - fr, vc + h / 2 + fr, 0.04, housing));
      fixtures.push(onFace(face, uc - w / 2, uc + w / 2, vc - h / 2, vc + h / 2, 0.055, lensColor(def.color, FIXTURE_RING * level)));
      const ci = 0.22;
      fixtures.push(onFace(face, uc - w / 2 + w * ci, uc + w / 2 - w * ci, vc - h / 2 + h * ci, vc + h / 2 - h * ci, 0.065, lensColor(def.color, FIXTURE_CORE * level)));
    }
  }

  // Free-standing lamp heads (flood masts) — only outside the play space.
  for (const def of theme.lights) {
    if (!def.free || def.fixture === false) continue;
    const n = FACE_NORMAL[def.face];
    const a = faceAxis(def.face);
    const ua = a === 0 ? 2 : 0;
    const va = a === 1 ? 2 : 1;
    const [w, h] = def.size;
    const head: Piece = { min: [0, 0, 0], max: [0, 0, 0], parent: null, color: lin(0x15161a), mask: 0 };
    head.min[ua] = def.at[ua] - w / 2 - 0.12;
    head.max[ua] = def.at[ua] + w / 2 + 0.12;
    head.min[va] = def.at[va] - h / 2 - 0.12;
    head.max[va] = def.at[va] + h / 2 + 0.12;
    head.min[a] = Math.min(def.at[a], def.at[a] - n[a] * 0.5);
    head.max[a] = Math.max(def.at[a], def.at[a] - n[a] * 0.5);
    const lens: Piece = { min: [...head.min] as V3, max: [...head.max] as V3, parent: null, color: lensColor(def.color, FIXTURE_CORE), mask: 63 & ~bit(a, n[a]) };
    lens.min[ua] = def.at[ua] - w / 2;
    lens.max[ua] = def.at[ua] + w / 2;
    lens.min[va] = def.at[va] - h / 2;
    lens.max[va] = def.at[va] + h / 2;
    lens.min[a] = Math.min(def.at[a], def.at[a] + n[a] * 0.02);
    lens.max[a] = Math.max(def.at[a], def.at[a] + n[a] * 0.02);
    if (insideBounds(head, bounds)) {
      if (import.meta.env?.DEV) console.warn(`[world] ${theme.id}: free lamp inside the arena`, def.at);
      continue;
    }
    skyline.push(head);
    fixtures.push(lens);
  }

  // Skyline / masts: dark silhouettes outside the arena.
  for (const s of theme.skyline ?? []) {
    const p: Piece = { min: s.min, max: s.max, parent: null, color: lin(s.color ?? 0x0c0d10), mask: bit(1, -1) };
    if (insideBounds(p, bounds)) continue;
    skyline.push(p);
    if (s.beacon) {
      const bx = (s.min[0] + s.max[0]) / 2;
      const bz = (s.min[2] + s.max[2]) / 2;
      fixtures.push({
        min: [bx - 0.25, s.max[1], bz - 0.25],
        max: [bx + 0.25, s.max[1] + 0.35, bz + 0.25],
        parent: null,
        color: lensColor(s.beacon, 1.7),
        mask: 0,
      });
    }
  }

  // Floor paint, hazard bands, glowing floor strips.
  const floorFace = lm.faces.find((f) => f.box === 0 && f.axis === 1 && f.sign > 0) ?? null;
  for (const inl of theme.inlays ?? []) {
    const p: Piece = {
      min: [inl.min[0], inl.min[1] + floorY, inl.min[2]],
      max: [inl.max[0], inl.min[1] + floorY + 0.004, inl.max[2]],
      parent: floorFace,
      color: inl.glow ? lensColor(inl.color, inl.glow) : lin(inl.color),
      mask: ~bit(1, 1) & 63,
    };
    if (inl.min[1] > 0.01) {
      // Painted on a raised top (a step / platform): parent = that top face.
      p.min[1] = inl.min[1];
      p.max[1] = inl.min[1] + 0.004;
      p.parent = findFace(lm, 1, 1, [(inl.min[0] + inl.max[0]) / 2, inl.min[1], (inl.min[2] + inl.max[2]) / 2]) ?? floorFace;
    }
    if (inl.glow) fixtures.push(p);
    else if (inl.hazard) hazard.push(p);
    else paint.push(p);
  }

  return {
    metal: metal.length ? toGeometry(metal, lm, inp.tile) : null,
    fixtures: fixtures.length ? toGeometry(fixtures, lm, inp.tile) : null,
    paint: paint.length ? toGeometry(paint, lm, inp.tile) : null,
    hazard: hazard.length ? toGeometry(hazard, lm, 1) : null,
    skyline: skyline.length ? toGeometry(skyline, lm, 4) : null,
    pieces: metal.length + fixtures.length + paint.length + hazard.length + skyline.length,
  };
}

// Face tables for a box: axis, sign, u axis, v axis (same UV convention as
// the surfaces: x-faces (z,y), y-faces (x,z), z-faces (x,y)).
const FACES: Array<[number, number, number, number]> = [
  [0, 1, 2, 1], [0, -1, 2, 1], [1, 1, 0, 2], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 0, 1],
];

function toGeometry(pieces: Piece[], lm: Lightmap, tile: number): THREE.BufferGeometry {
  let quads = 0;
  for (const p of pieces) for (let k = 0; k < 6; k++) if (!(p.mask & (1 << k))) quads++;
  const pos = new Float32Array(quads * 12);
  const nrm = new Float32Array(quads * 12);
  const uv = new Float32Array(quads * 8);
  const uv1 = new Float32Array(quads * 8);
  const col = new Float32Array(quads * 12);
  const index = new Uint32Array(quads * 6);
  let q = 0;
  const v: V3 = [0, 0, 0];
  // Unparented pieces (outside the arena) sample the atlas's first gutter
  // texel; their materials don't use the lightmap anyway.
  const fallback: [number, number] = [0.5 / lm.width, 0.5 / lm.height];
  for (const p of pieces) {
    const h = p.max[1] - p.min[1];
    for (let k = 0; k < 6; k++) {
      if (p.mask & (1 << k)) continue;
      const [axis, sign, ua, va] = FACES[k];
      const plane = sign > 0 ? p.max[axis] : p.min[axis];
      const us = [p.min[ua], p.max[ua], p.max[ua], p.min[ua]];
      const vs = [p.min[va], p.min[va], p.max[va], p.max[va]];
      // (u × v) · n: x-faces and y-faces are left-handed in (u, v).
      const flip = (axis === 2 ? 1 : -1) * sign < 0;
      const n = FACE_NORMAL[`${sign > 0 ? '+' : '-'}${'xyz'[axis]}` as keyof typeof FACE_NORMAL];
      for (let c = 0; c < 4; c++) {
        const o = q * 4 + c;
        v[axis] = plane;
        v[ua] = us[c];
        v[va] = vs[c];
        pos[o * 3] = v[0];
        pos[o * 3 + 1] = v[1];
        pos[o * 3 + 2] = v[2];
        nrm[o * 3] = n[0];
        nrm[o * 3 + 1] = n[1];
        nrm[o * 3 + 2] = n[2];
        uv[o * 2] = v[ua] / tile;
        uv[o * 2 + 1] = v[va] / tile;
        const t = p.parent ? faceUv(lm, p.parent, v) : fallback;
        uv1[o * 2] = t[0];
        uv1[o * 2 + 1] = t[1];
        let r = p.color.r;
        let g = p.color.g;
        let b = p.color.b;
        if (p.color2 && h > 1e-4) {
          const f = (v[1] - p.min[1]) / h;
          r += (p.color2.r - r) * f;
          g += (p.color2.g - g) * f;
          b += (p.color2.b - b) * f;
        }
        col[o * 3] = r;
        col[o * 3 + 1] = g;
        col[o * 3 + 2] = b;
      }
      const base = q * 4;
      const ix = q * 6;
      if (flip) {
        index.set([base, base + 2, base + 1, base, base + 3, base + 2], ix);
      } else {
        index.set([base, base + 1, base + 2, base, base + 2, base + 3], ix);
      }
      q++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
