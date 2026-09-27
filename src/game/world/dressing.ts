import * as THREE from 'three';
import type { SurfaceKind } from '../textures';
import type { AABB } from '../types';
import { faceUv, type LmFace, type Lightmap, type V3 } from './lightmap';
import { FACE_NORMAL, type LightDef, type WorldTheme } from './themes';

// ─────────────────────────────────────────────────────────────────────────
// Architectural dressing generated from the AABBs — render-only, merged into
// three buffers (trim metal, emissive fixtures, floor paint).
//
// SIGHT-LINE RULE: rails pass through anything that isn't an AABB, so every
// piece here sits flush on a collision face and protrudes ≤ MAX_PROUD (clamped
// in onFace / the collar ring), or is painted onto the floor (4 mm). Nothing hangs into the play
// space. Pieces sample the lightmap of the face they're mounted on (uv1 =
// the vertex projected onto that face), so a baseboard in a dark corner is
// dark and a fixture housing sits in its own pool of light.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_PROUD = 0.15;

type Piece = {
  min: V3;
  max: V3;
  parent: LmFace | null;
  color: THREE.Color; // linear
  mask: number; // bit per face to skip: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z
};

export type DressingBuild = {
  metal: THREE.BufferGeometry | null;
  fixtures: THREE.BufferGeometry | null;
  paint: THREE.BufferGeometry | null;
  pieces: number;
};

export type DressingInput = {
  boxes: AABB[];
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

export function buildDressing(inp: DressingInput): DressingBuild {
  const { boxes, bounds, drawn, slots, perimeter, lm, theme, low } = inp;
  const st = theme.dress;
  const metal: Piece[] = [];
  const fixtures: Piece[] = [];
  const paint: Piece[] = [];
  const floorY = boxes[0].max.y;
  const trimColor = lin(st.tint);
  const housing = lin(0x2a2c31);
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const ceilY = theme.openSky ? Infinity : boxes[1].min.y;

  // Fixture footprints per face, so ribs don't run through a lamp.
  const fixtureSpans = new Map<LmFace, Array<[number, number]>>();
  const fixtureFaces: Array<{ def: LightDef; face: LmFace }> = [];
  for (const def of theme.lights) {
    if (def.fixture === false || def.size[0] < 0.05) continue;
    const f = findFace(lm, faceAxis(def.face), faceSign(def.face), def.at);
    if (!f) {
      // A fixture must hang on a real, visible face (flush-mount rule).
      if (import.meta.env?.DEV) console.warn(`[world] ${theme.id}: no ${def.face} face at`, def.at);
      continue;
    }
    fixtureFaces.push({ def, face: f });
    const span: [number, number] = [def.at[f.ua] - def.size[0] / 2 - 0.25, def.at[f.ua] + def.size[0] / 2 + 0.25];
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
      metal.push(onFace(f, f.u0 - ext(d), f.u1 + ext(d), floorY, floorY + h, d, trimColor, bit(1, -1)));
    }

    // Machined band on the top edge of platforms / cover.
    if (st.edges && vertical && (slot === 'platform' || slot === 'cover') && height >= 0.3 && !perimeter[i]) {
      const { h, d } = st.edges;
      metal.push(onFace(f, f.u0 - ext(d), f.u1 + ext(d), top - h, top, d, trimColor));
    }

    if (!perimeter[i] || !vertical) continue;
    // ── perimeter walls ──
    const wallTop = Math.min(top, ceilY);
    if (st.crown) {
      const { h, d } = st.crown;
      metal.push(onFace(f, f.u0, f.u1, wallTop - h, wallTop, d, trimColor));
    }
    if (low) continue;
    if (st.band && st.band.y < wallTop - 1) {
      const { y, h, d } = st.band;
      metal.push(onFace(f, f.u0, f.u1, y - h / 2, y + h / 2, d, trimColor));
    }
    if (st.pilasters) {
      const { spacing, w, d } = st.pilasters;
      const ptop = Math.min(wallTop, st.pilasters.top ?? wallTop);
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

  // Light fixtures: emissive panel in a dark housing.
  for (const { def, face } of fixtureFaces) {
    const [w, h] = def.size;
    const uc = def.at[face.ua];
    const vc = def.at[face.va];
    const glow = new THREE.Color(def.color).multiplyScalar(def.glow ?? 2.2);
    metal.push(onFace(face, uc - w / 2 - 0.09, uc + w / 2 + 0.09, vc - h / 2 - 0.09, vc + h / 2 + 0.09, 0.035, housing));
    fixtures.push(onFace(face, uc - w / 2, uc + w / 2, vc - h / 2, vc + h / 2, 0.05, glow));
  }

  // Floor paint (and glowing floor strips).
  const floorFace = lm.faces.find((f) => f.box === 0 && f.axis === 1 && f.sign > 0) ?? null;
  for (const inl of theme.inlays ?? []) {
    const p: Piece = {
      min: [inl.min[0], floorY, inl.min[2]],
      max: [inl.max[0], floorY + 0.004, inl.max[2]],
      parent: floorFace,
      color: inl.glow ? new THREE.Color(inl.color).multiplyScalar(inl.glow) : lin(inl.color),
      mask: ~bit(1, 1) & 63,
    };
    (inl.glow ? fixtures : paint).push(p);
  }

  return {
    metal: metal.length ? toGeometry(metal, lm, inp.tile) : null,
    fixtures: fixtures.length ? toGeometry(fixtures, lm, inp.tile) : null,
    paint: paint.length ? toGeometry(paint, lm, inp.tile) : null,
    pieces: metal.length + fixtures.length + paint.length,
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
  const fallback: [number, number] = [0.5 / lm.width, 0.5 / lm.height];
  for (const p of pieces) {
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
        col[o * 3] = p.color.r;
        col[o * 3 + 1] = p.color.g;
        col[o * 3 + 2] = p.color.b;
      }
      const b = q * 4;
      const ix = q * 6;
      if (flip) {
        index.set([b, b + 2, b + 1, b, b + 3, b + 2], ix);
      } else {
        index.set([b, b + 1, b + 2, b, b + 2, b + 3], ix);
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
