import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';

// ── Wearable authoring kit ───────────────────────────────────────────────────
//
// Every hat / face / back item is built in code, the same way the combatant's
// body is (character/body.ts): small hard-surface solids — convex hulls,
// lathes/revolves, swept tubes, parametric plates — authored in REST MODEL
// SPACE (metres; +Y up, the character faces −Z, its back is +Z), so each
// piece can be placed against the helmet / cuirass numbers directly. A Kit
// collects parts with a Surface each and merges them into ONE non-indexed
// geometry whose per-vertex channels carry the look (one draw call):
//   color  base colour (linear)
//   aMat   x = tint mode + 4·fx   (tint: 0 fixed · 1 accent · 2 paint;
//                                  fx: 0 none · 1 twinkle · 2 hard-light pulse)
//          y = roughness, z = metalness, w = emissive (× the surface colour;
//          twinkle: floor = strength, fract = phase)
// The shared material (material.ts) decodes them. Geometry is baked relative
// to the socket it rides (Kit.build(origin)).

export type V3 = readonly [number, number, number];

export type Surf = {
  c: number; // sRGB hex
  t?: 0 | 1 | 2; // 0 fixed · 1 accent (× wearer colour / admin tint) · 2 paint (admin tint repaints it)
  r: number; // roughness
  m: number; // metalness
  e?: number; // emissive strength (× colour)
  fx?: 0 | 1 | 2; // 1 twinkle (festive bulbs) · 2 hard-light pulse
};

// Surface helpers.
export const surf = (c: number, r: number, m: number, extra: Partial<Surf> = {}): Surf => ({ c, r, m, ...extra });
export const paint = (c: number, r = 0.55, m = 0.05, extra: Partial<Surf> = {}): Surf => ({ c, r, m, t: 2, ...extra });
export const accent = (c = 0xffffff, r = 0.45, m = 0.1, extra: Partial<Surf> = {}): Surf => ({ c, r, m, t: 1, ...extra });
export const glow = (c: number, e: number, extra: Partial<Surf> = {}): Surf => ({ c, r: 0.35, m: 0, e, ...extra });
export const hardLight = (c: number, e = 1.6, t: 0 | 1 = 0): Surf => ({ c, r: 0.3, m: 0, e, fx: 2, t });

// A few shared materials-as-surfaces.
export const GOLD = surf(0xe2b04a, 0.28, 1);
export const GOLD_DARK = surf(0xa8792c, 0.34, 1);
export const STEEL = surf(0xb4bcc6, 0.46, 0.3);
export const GUNMETAL = surf(0x3e4552, 0.3, 0.9);
export const DARK = surf(0x1b1e24, 0.55, 0.3);
export const LEATHER = surf(0x5a3a22, 0.72, 0.05);
export const WHITE = surf(0xf2efe8, 0.7, 0.02);
export const CHROME = surf(0xdfe4ea, 0.1, 1);

// ── The helmet (character/body.ts) — the surface hats and face items fit ─────
export const HELM_ZS = 1.13; // helmet is deeper than wide
export const HELM_Z0 = 0.006; // and sits a touch back
// Radius (x half-width) of the helmet shell by height: jaw below 1.68, dome above.
const HELM_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.09, 1.552],
  [0.113, 1.568],
  [0.129, 1.595],
  [0.137, 1.625],
  [0.139, 1.655],
  [0.146, 1.68],
  [0.143, 1.686],
  [0.137, 1.708],
  [0.125, 1.742],
  [0.1, 1.772],
  [0.06, 1.79],
  [0.0, 1.794],
];
export const HELM_TOP = 1.794;
export const CREST_TOP = 1.804;

export function helmR(y: number): number {
  const p = HELM_PROFILE;
  if (y <= p[0][1]) return p[0][0];
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i][1]) {
      const [r0, y0] = p[i - 1];
      const [r1, y1] = p[i];
      return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
  }
  return 0;
}

// Height of the dome surface at horizontal radius r (r ≤ 0.146), for the
// elliptical helmet use r = the normalised radius (x² + ((z−z0)/zs)²)^½.
export function domeY(r: number): number {
  const p = HELM_PROFILE;
  if (r >= 0.146) return 1.68;
  for (let i = p.length - 1; i > 5; i--) {
    const [r0, y0] = p[i];
    const [r1, y1] = p[i - 1];
    if (r <= r1) return y0 + ((y1 - y0) * (r - r0)) / (r1 - r0);
  }
  return 1.68;
}

// Normalised helmet radius of a model-space point (x, z).
export function helmRadiusAt(x: number, z: number): number {
  const zz = (z - HELM_Z0) / HELM_ZS;
  return Math.hypot(x, zz);
}

// The dome's profile (r, y) from `y0` up to the crown, pushed out along its
// normal by `off` — a conformal shell for skull caps, bands and hats.
export function domeProfile(off: number, y0 = 1.683, yTop = HELM_TOP, steps = 7): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((yTop - y0) * i) / steps;
    const r = helmR(y);
    // Normal of the profile (finite difference).
    const dy = 0.004;
    const dr = helmR(Math.min(yTop, y + dy)) - helmR(Math.max(y0, y - dy));
    const len = Math.hypot(dr, 2 * dy) || 1;
    const nr = (2 * dy) / len;
    const ny = -dr / len;
    out.push([Math.max(0, r + nr * off), y + ny * off]);
  }
  out[out.length - 1][0] = 0;
  return out;
}

// A point on the helmet at angle phi (0 = back, π = front) and height y,
// pushed out by `off`.
export function onHelm(phi: number, y: number, off: number): V3 {
  const r = helmR(y) + off;
  return [r * Math.sin(phi), y, HELM_Z0 + HELM_ZS * r * Math.cos(phi)];
}

// Turn a geometry authored facing −Z (at the origin) to face outward at helmet
// angle phi, then move it to `at`.
export function faceOut(g: THREE.BufferGeometry, phi: number, at: V3, tilt = 0): THREE.BufferGeometry {
  if (tilt) g.rotateX(tilt);
  g.rotateY(phi + Math.PI);
  g.translate(at[0], at[1], at[2]);
  return g;
}

// Front surface of the visor band (z at a given x, y≈1.655).
export function visorZ(x: number, y = 1.655): number {
  const r = helmR(y) + (y > 1.631 && y < 1.679 ? 0.006 : 0);
  const q = Math.max(0, r * r - x * x);
  return HELM_Z0 - HELM_ZS * Math.sqrt(q);
}

// ── Primitive builders (all return fresh geometries) ─────────────────────────

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

export function hull(pts: V3[]): THREE.BufferGeometry {
  return new ConvexGeometry(pts.map(v3));
}

// Chamfered-rectangle ring (an octagon) at height y, centred on (cx, cz).
export function ring(y: number, hx: number, hz: number, c: number, cx = 0, cz = 0): V3[] {
  const cc = Math.min(c, hx * 0.95, hz * 0.95);
  return [
    [cx - hx + cc, y, cz - hz],
    [cx + hx - cc, y, cz - hz],
    [cx + hx, y, cz - hz + cc],
    [cx + hx, y, cz + hz - cc],
    [cx + hx - cc, y, cz + hz],
    [cx - hx + cc, y, cz + hz],
    [cx - hx, y, cz + hz - cc],
    [cx - hx, y, cz - hz + cc],
  ];
}

export function loft(rings: ReadonlyArray<readonly number[]>, extra: V3[] = []): THREE.BufferGeometry {
  const pts: V3[] = [];
  for (const r of rings) pts.push(...ring(r[0], r[1], r[2], r[3], r[4] ?? 0, r[5] ?? 0));
  pts.push(...extra);
  return hull(pts);
}

// Fully chamfered box centred at (x, y, z).
export function cbox(x: number, y: number, z: number, w: number, h: number, d: number, c = 0.004): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const cc = Math.min(c, hy * 0.9, hx * 0.9, hz * 0.9);
  return loft([
    [y - hy, hx - cc, hz - cc, cc, x, z],
    [y - hy + cc, hx, hz, cc, x, z],
    [y + hy - cc, hx, hz, cc, x, z],
    [y + hy, hx - cc, hz - cc, cc, x, z],
  ]);
}

export function ball(x: number, y: number, z: number, r: number, detail = 1, sy = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
}

export function octa(x: number, y: number, z: number, r: number, sy = 1.4): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(r, 0);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
}

// Cylinder / cone between two points.
export function cyl(a: V3, b: V3, r0: number, r1: number, seg = 8, open = false): THREE.BufferGeometry {
  const A = v3(a);
  const Bv = v3(b);
  const d = new THREE.Vector3().subVectors(Bv, A);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}

// Revolve a profile of [radius, y] pairs about the vertical axis. phi = 0
// points at +Z (the back), phi = π at the front (−Z). `rmul(phi, t)` and
// `ydel(phi, t, r)` shape it per angle (t = profile position 0..1), so one
// call makes pinched crowns, curled brims, tricorns and ribbed knits.
export type RevolveOpts = {
  phi0?: number;
  phiLen?: number;
  zs?: number;
  z0?: number;
  x0?: number;
  rmul?: (phi: number, t: number) => number;
  ydel?: (phi: number, t: number, r: number) => number;
};
export function revolve(profile: ReadonlyArray<readonly [number, number]>, seg: number, o: RevolveOpts = {}): THREE.BufferGeometry {
  const phi0 = o.phi0 ?? 0;
  const phiLen = o.phiLen ?? Math.PI * 2;
  const zs = o.zs ?? 1;
  const z0 = o.z0 ?? 0;
  const x0 = o.x0 ?? 0;
  const n = profile.length;
  const grid: THREE.Vector3[][] = [];
  for (let s = 0; s <= seg; s++) {
    const phi = phi0 + (phiLen * s) / seg;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const col: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const r = profile[i][0] * (o.rmul ? o.rmul(phi, t) : 1);
      const y = profile[i][1] + (o.ydel ? o.ydel(phi, t, profile[i][0]) : 0);
      col.push(new THREE.Vector3(x0 + r * sp, y, z0 + zs * r * cp));
    }
    grid.push(col);
  }
  const pos: number[] = [];
  const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z);
  for (let s = 0; s < seg; s++) {
    for (let i = 0; i < n - 1; i++) {
      const a = grid[s][i];
      const b = grid[s + 1][i];
      const c = grid[s + 1][i + 1];
      const d = grid[s][i + 1];
      if (a.distanceToSquared(b) > 1e-12) {
        push(a);
        push(b);
        push(c);
      }
      if (c.distanceToSquared(d) > 1e-12) {
        push(a);
        push(c);
        push(d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// A conformal helmet shell (the dome's own ellipse).
export function shell(profile: ReadonlyArray<readonly [number, number]>, seg: number, o: RevolveOpts = {}): THREE.BufferGeometry {
  return revolve(profile, seg, { zs: HELM_ZS, z0: HELM_Z0, ...o });
}

// Sweep a (optionally flattened) tube along a polyline. `rad` is a constant or
// a function of the path fraction t. `up` seeds the frame (the tube's
// flattening axis `sy` scales the binormal).
export function sweep(
  pts: V3[],
  rad: number | ((t: number) => number),
  sides: number,
  o: { sy?: number; caps?: boolean; up?: V3; smooth?: number } = {},
): THREE.BufferGeometry {
  let P = pts.map(v3);
  if (o.smooth && o.smooth > 1 && P.length > 2) {
    const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal');
    P = curve.getPoints((P.length - 1) * o.smooth);
  }
  const n = P.length;
  const sy = o.sy ?? 1;
  const T: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  let N = o.up ? v3(o.up) : new THREE.Vector3(0, 1, 0);
  if (Math.abs(N.dot(T[0])) > 0.95) N = new THREE.Vector3(1, 0, 0);
  N.addScaledVector(T[0], -N.dot(T[0])).normalize();
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      N.addScaledVector(T[i], -N.dot(T[i]));
      if (N.lengthSq() < 1e-10) N.set(1, 0, 0);
      N.normalize();
    }
    const Bn = new THREE.Vector3().crossVectors(T[i], N).normalize();
    const r = typeof rad === 'number' ? rad : rad(n > 1 ? i / (n - 1) : 0);
    const rr: THREE.Vector3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      rr.push(
        P[i]
          .clone()
          .addScaledVector(N, Math.cos(a) * r)
          .addScaledVector(Bn, Math.sin(a) * r * sy),
      );
    }
    rings.push(rr);
  }
  const pos: number[] = [];
  const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z);
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      push(rings[i][k]);
      push(rings[i + 1][k]);
      push(rings[i + 1][k2]);
      push(rings[i][k]);
      push(rings[i + 1][k2]);
      push(rings[i][k2]);
    }
  }
  if (o.caps !== false) {
    for (const [i, c] of [
      [0, P[0]],
      [n - 1, P[n - 1]],
    ] as const) {
      for (let k = 0; k < sides; k++) {
        push(c);
        push(rings[i][k]);
        push(rings[i][(k + 1) % sides]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// A parametric sheet P(u, v), u,v ∈ [0,1], optionally with thickness (offset
// along the sheet normal, plus the rim strips). Surfaces for the two faces
// and the rim can differ (a two-tone brim).
export function plate(
  fn: (u: number, v: number) => V3,
  nu: number,
  nv: number,
  thick = 0,
): { top: THREE.BufferGeometry; bottom: THREE.BufferGeometry | null; rim: THREE.BufferGeometry | null } {
  const G: THREE.Vector3[][] = [];
  for (let i = 0; i <= nu; i++) {
    const row: THREE.Vector3[] = [];
    for (let j = 0; j <= nv; j++) row.push(v3(fn(i / nu, j / nv)));
    G.push(row);
  }
  const tri = (grid: THREE.Vector3[][]) => {
    const pos: number[] = [];
    const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        push(grid[i][j]);
        push(grid[i + 1][j]);
        push(grid[i + 1][j + 1]);
        push(grid[i][j]);
        push(grid[i + 1][j + 1]);
        push(grid[i][j + 1]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  };
  const top = tri(G);
  if (thick <= 0) return { top, bottom: null, rim: null };
  // Per-vertex normals from the grid (central differences).
  const B: THREE.Vector3[][] = [];
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  for (let i = 0; i <= nu; i++) {
    const row: THREE.Vector3[] = [];
    for (let j = 0; j <= nv; j++) {
      du.subVectors(G[Math.min(nu, i + 1)][j], G[Math.max(0, i - 1)][j]);
      dv.subVectors(G[i][Math.min(nv, j + 1)], G[i][Math.max(0, j - 1)]);
      const nrm = new THREE.Vector3().crossVectors(du, dv).normalize();
      row.push(G[i][j].clone().addScaledVector(nrm, -thick));
    }
    B.push(row);
  }
  const bottom = tri(B);
  const pos: number[] = [];
  const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z);
  const edge = (a: THREE.Vector3, b: THREE.Vector3, a2: THREE.Vector3, b2: THREE.Vector3) => {
    push(a);
    push(b);
    push(b2);
    push(a);
    push(b2);
    push(a2);
  };
  for (let i = 0; i < nu; i++) {
    edge(G[i][0], G[i + 1][0], B[i][0], B[i + 1][0]);
    edge(G[i][nv], G[i + 1][nv], B[i][nv], B[i + 1][nv]);
  }
  for (let j = 0; j < nv; j++) {
    edge(G[0][j], G[0][j + 1], B[0][j], B[0][j + 1]);
    edge(G[nu][j], G[nu][j + 1], B[nu][j], B[nu][j + 1]);
  }
  const rim = new THREE.BufferGeometry();
  rim.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return { top, bottom, rim };
}

// Extrude a 2-D shape (in the XY plane) by `depth` along +Z, then
// optionally tessellate so a later bend stays smooth.
export function extrude(shape: THREE.Shape, depth: number, bevel = 0, curveSeg = 4, maxEdge = 0): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: curveSeg,
  });
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  if (maxEdge > 0) {
    const mod = new TessellateModifier(maxEdge, 4);
    const t = mod.modify(g);
    g.dispose();
    g = t;
  }
  g.translate(0, 0, -depth / 2);
  return g;
}

// Mutate every vertex (in place). Returns the geometry.
export function deform(g: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  return g;
}

// Rotate a geometry about a pivot (Euler XYZ).
export function rot(g: THREE.BufferGeometry, x: number, y: number, z: number, pivot: V3 = [0, 0, 0]): THREE.BufferGeometry {
  g.translate(-pivot[0], -pivot[1], -pivot[2]);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z)));
  g.translate(pivot[0], pivot[1], pivot[2]);
  return g;
}

// Orient a geometry authored along +Y (at the origin) to run from a→dir, placed at a.
export function aim(g: THREE.BufferGeometry, at: V3, dir: V3, roll = 0): THREE.BufferGeometry {
  if (roll) g.rotateY(roll);
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
  g.translate(at[0], at[1], at[2]);
  return g;
}

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // Winding doesn't matter: the wearables material is double-sided with
  // derivative (flat) normals.
  return (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(MIRROR_X);
}

// Star outline (for stars, sparkles, emblems).
export function starShape(points: number, rOut: number, rIn: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? rOut : rIn;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

// ── The Kit ─────────────────────────────────────────────────────────────────

type Part = { g: THREE.BufferGeometry; s: Surf };

export class Kit {
  readonly parts: Part[] = [];
  // Low-spec builds use fewer segments (see seg()).
  constructor(readonly low = false) {}

  // Segment count helper: full → n, low → ~60 % (min `min`).
  seg(n: number, min = 4): number {
    return this.low ? Math.max(min, Math.round(n * 0.6)) : n;
  }

  add(g: THREE.BufferGeometry | null | undefined, s: Surf): this {
    if (g) this.parts.push({ g, s });
    return this;
  }

  // Add a geometry and its X-mirror (left/right pairs).
  addLR(g: THREE.BufferGeometry, s: Surf): this {
    this.add(g, s);
    this.add(mirrorX(g), s);
    return this;
  }

  // Add a plate's faces.
  addPlate(p: ReturnType<typeof plate>, top: Surf, bottom: Surf = top, rim: Surf = bottom): this {
    this.add(p.top, top);
    this.add(p.bottom, bottom);
    this.add(p.rim, rim);
    return this;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  // Transform every part added since `mark()` (build a group in local
  // coordinates, then place it).
  mark(): number {
    return this.parts.length;
  }
  xf(from: number, m: THREE.Matrix4): this {
    for (let i = from; i < this.parts.length; i++) this.parts[i].g.applyMatrix4(m);
    return this;
  }
  // Mirror every part added since `from` to the other side (adds copies).
  mirrorFrom(from: number): this {
    const n = this.parts.length;
    for (let i = from; i < n; i++) this.add(mirrorX(this.parts[i].g), this.parts[i].s);
    return this;
  }

  // Merge into one geometry, translated by −origin (socket-local).
  build(origin: V3 = [0, 0, 0]): THREE.BufferGeometry {
    let total = 0;
    const flat: { pos: THREE.BufferAttribute; s: Surf }[] = [];
    for (const p of this.parts) {
      const g = p.g.index ? p.g.toNonIndexed() : p.g;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      flat.push({ pos, s: p.s });
      total += pos.count;
    }
    const position = new Float32Array(total * 3);
    const color = new Float32Array(total * 3);
    const mat = new Float32Array(total * 4);
    const c = new THREE.Color();
    let o = 0;
    for (const { pos, s } of flat) {
      c.setHex(s.c);
      const mx = (s.t ?? 0) + 4 * (s.fx ?? 0);
      for (let i = 0; i < pos.count; i++, o++) {
        position[o * 3] = pos.getX(i) - origin[0];
        position[o * 3 + 1] = pos.getY(i) - origin[1];
        position[o * 3 + 2] = pos.getZ(i) - origin[2];
        color[o * 3] = c.r;
        color[o * 3 + 1] = c.g;
        color[o * 3 + 2] = c.b;
        mat[o * 4] = mx;
        mat[o * 4 + 1] = s.r;
        mat[o * 4 + 2] = s.m;
        mat[o * 4 + 3] = s.e ?? 0;
      }
    }
    for (const p of this.parts) p.g.dispose();
    this.parts.length = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ── Festive string lights ────────────────────────────────────────────────────
// A drooping wire along a closed (or open) path with little twinkling bulbs.
const BULB_COLS = [0xff3b3b, 0x3bff6a, 0xffd23b, 0x3b9dff, 0xff5fd8];
const WIRE = surf(0x1d3b22, 0.6, 0.1);

export function stringLights(k: Kit, path: V3[], opts: { closed?: boolean; droop?: number; bulbs?: number; size?: number } = {}): void {
  const closed = opts.closed ?? true;
  const droop = opts.droop ?? 0.012;
  const size = opts.size ?? 0.0105;
  const P = path.map(v3);
  if (closed) P.push(P[0].clone());
  const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal');
  const nb = opts.bulbs ?? 12;
  const pts: V3[] = [];
  const SUB = 4;
  const N = nb * SUB;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = curve.getPoint(t);
    // Catenary-ish sag between bulbs.
    const f = (i % SUB) / SUB;
    p.y -= droop * Math.sin(f * Math.PI);
    pts.push([p.x, p.y, p.z]);
  }
  k.add(sweep(pts, 0.0022, 3, { caps: false }), WIRE);
  for (let b = 0; b < nb; b++) {
    const p = curve.getPoint(b / nb);
    const col = BULB_COLS[b % BULB_COLS.length];
    const phase = ((b * 0.618) % 1) * 0.98;
    k.add(octa(p.x, p.y - size * 0.6, p.z, size, 1.5), { c: col, r: 0.2, m: 0, e: 2 + phase, fx: 1 });
    k.add(cyl([p.x, p.y + size * 0.1, p.z], [p.x, p.y - size * 0.35, p.z], size * 0.45, size * 0.45, 4), WIRE);
  }
}

// An ellipse path conformal to the helmet ellipse at height y with radius r.
export function ellipsePath(y: number, r: number, n = 16, zs = HELM_ZS, z0 = HELM_Z0): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([r * Math.sin(a), y, z0 + zs * r * Math.cos(a)]);
  }
  return out;
}

// A rising spiral around a vertical axis (tall hats).
export function spiralPath(y0: number, y1: number, r0: number, r1: number, turns: number, n = 28, cx = 0, cz = 0): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    const r = r0 + (r1 - r0) * t;
    out.push([cx + r * Math.sin(a), y0 + (y1 - y0) * t, cz + r * Math.cos(a)]);
  }
  return out;
}
