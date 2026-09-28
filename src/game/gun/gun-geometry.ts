import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─────────────────────────────────────────────────────────────────────────
// Railgun geometry (procedural, no asset). A chunky Q3-style rail: a heavy
// receiver with heat-sink fins on top and a charge window in each flank, a
// rear capacitor in a strut cage, a skeletal stock, an angled rubber grip, and
// an accelerator — a glowing energy core running the whole barrel between four
// square conductor rails, ringed by four bold coils, ending in a pronged
// emitter.
//
// Every part is merged into ONE geometry per LOD (built once, module-cached,
// shared by every gun). A `gun` vec3 attribute tells the surface shader
// (gun-material.ts) what each triangle is:
//   x = part id (PART below)
//   y = edge flag, 1 on chamfer faces (machined edge highlight), else 0
//   z = pattern mapping: the lathe axis height (cylindrical UVs around the
//       barrel) or NO_AXIS for flat box-projected parts.
//
// MODEL SPACE (stable — third-person hand sockets depend on it):
//   origin = the grip / trigger point (the right palm sits just below and
//            behind it, around (0, -0.12, 0.09)); forward = -Z; up = +Y;
//   symmetric about X = 0; 1 unit = 1 m at scale 1, ~1.36 long (butt +0.45
//   → prong tips -0.92), muzzle marker at (0, BARREL_Y, MUZZLE_Z).
// ─────────────────────────────────────────────────────────────────────────

export const PART = {
  BODY: 0, // receiver shell — the finish pattern's main canvas
  METAL: 1, // gunmetal frame, rails, coil housings
  METAL_LT: 2, // bright machined bits: fins, prongs, bezels, struts
  RUBBER: 3, // grip, pads, dark recesses + apertures
  CARBON: 4, // stock bars + foregrip
  GLOW: 5, // accent status strips + emitter ring (the Game's glow knob)
  CORE: 6, // the energy core down the barrel
  WINDOW: 7, // side charge windows (a segmented charge gauge)
  CAP: 8, // rear capacitor core
  COIL0: 9, // coils: COIL0 + i, i = 0 front (muzzle) … COIL_COUNT-1 back
} as const;

export const COIL_COUNT = 4;
export const BARREL_Y = 0.03;
export const MUZZLE_Z = -0.9;
// Coil centres, index 0 = front (fills first on the recharge).
export const COIL_Z = [-0.655, -0.56, -0.465, -0.37] as const;
export const COIL_R = 0.071; // glowing band's outer radius
export const CORE_R = 0.016;
export const CORE_Y = BARREL_Y + 0.012; // rides high in the barrel channel
export const CORE_Z = [-0.862, -0.27] as const; // front, back
// Charge window (each flank), filling rear → front with the charge.
export const WINDOW_Z = [0.006, -0.136] as const; // rear, front
export const NO_AXIS = -10;

export type GunLod = 'high' | 'low';

type V3 = [number, number, number];
type EdgeMode = 'hull' | 'none' | 'all';

// A box with every edge chamfered by `c` (convex hull of the 24 cut corners):
// flat-shaded bevels that catch a highlight on each edge.
function chamferBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const x = w / 2, y = h / 2, z = d / 2;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(
          new THREE.Vector3(sx * x, sy * (y - c), sz * (z - c)),
          new THREE.Vector3(sx * (x - c), sy * y, sz * (z - c)),
          new THREE.Vector3(sx * (x - c), sy * (y - c), sz * z),
        );
      }
    }
  }
  return new ConvexGeometry(pts);
}

// Hull through chamfered rectangles ("stations") along Z: tapered receivers,
// wedges and stocks. Each station is [z, width, height, yCentre]; the first and
// last get a chamfered end face.
function stationPrism(stations: Array<[number, number, number, number]>, c: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const ring = (z: number, w: number, h: number, yc: number) => {
    const x = w / 2, y = h / 2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * x, yc + sy * (y - c), z), new THREE.Vector3(sx * (x - c), yc + sy * y, z));
      }
    }
  };
  stations.forEach(([z, w, h, yc], i) => {
    const end = i === 0 ? 1 : i === stations.length - 1 ? -1 : 0;
    if (end === 0) {
      ring(z, w, h, yc);
      return;
    }
    const dir = Math.sign(stations[i === 0 ? 1 : i - 1][0] - z) || 1;
    ring(z + dir * c, w, h, yc);
    ring(z, w - 2 * c, h - 2 * c, yc);
  });
  return new ConvexGeometry(pts);
}

// Surface of revolution about the Z axis from a [radius, z] profile, one band
// per profile segment so each band keeps its own normal (smooth around the
// axis, crisp at every chamfer). List the profile with z increasing for an
// outward-facing side. Bands that change radius AND z are chamfers: they get
// the edge flag (a per-vertex `edge` attribute read by put()).
function latheZ(profile: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const bands: THREE.BufferGeometry[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const g = new THREE.LatheGeometry([new THREE.Vector2(a[0], a[1]), new THREE.Vector2(b[0], b[1])], seg);
    g.rotateX(Math.PI / 2); // lathe +Y → +Z
    const p = prep(g);
    const chamfer = a[0] !== b[0] && a[1] !== b[1] && a[0] > 0 && b[0] > 0 ? 1 : 0;
    p.setAttribute('edge', new THREE.BufferAttribute(new Float32Array(p.attributes.position.count).fill(chamfer), 1));
    bands.push(p);
  }
  const merged = mergeGeometries(bands, false);
  for (const g of bands) g.dispose();
  return merged ?? new THREE.BufferGeometry();
}

// Normalise to non-indexed position/normal (+ optional edge) so every part merges.
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g;
  if (g.index) {
    out = g.toNonIndexed();
    g.dispose();
  }
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'edge') out.deleteAttribute(name);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

// ── Builder ─────────────────────────────────────────────────────────────────

class GunBuilder {
  readonly parts: THREE.BufferGeometry[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  // Add a part in model space. `axisY` marks a lathe around (0, axisY) so the
  // finish pattern wraps it cylindrically.
  put(part: number, geo: THREE.BufferGeometry, pos: V3 = [0, 0, 0], rot?: V3, edge: EdgeMode = 'hull', axisY = NO_AXIS) {
    const g = prep(geo);
    const n = g.attributes.position.count;
    const nor = g.attributes.normal;
    const lathe = g.attributes.edge as THREE.BufferAttribute | undefined;
    const attr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let e = 0;
      if (lathe) e = lathe.getX(i);
      else if (edge === 'all') e = 1;
      else if (edge === 'hull') {
        // Chamfer faces are the ones whose (local, pre-rotation) normal is not
        // axis-aligned: the second-largest component is large.
        const a = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))].sort((u, v) => v - u);
        e = a[1] > 0.4 ? 1 : 0;
      }
      attr[i * 3] = part;
      attr[i * 3 + 1] = e;
      attr[i * 3 + 2] = axisY;
    }
    if (lathe) g.deleteAttribute('edge');
    g.setAttribute('gun', new THREE.BufferAttribute(attr, 3));
    this.q.setFromEuler(this.e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
    g.applyMatrix4(this.m.compose(this.p.set(...pos), this.q, this.one));
    this.parts.push(g);
  }

  lathe(part: number, profile: Array<[number, number]>, seg: number, y = BARREL_Y) {
    this.put(part, latheZ(profile, seg), [0, y, 0], undefined, 'none', y);
  }

  merge(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false) ?? new THREE.BufferGeometry();
    for (const g of this.parts) g.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

function buildGeometry(lod: GunLod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 24 : 10;
  const b = new GunBuilder();
  const P = PART;

  // ── Receiver: a heavy chamfered block tapering into the barrel mount ──────
  b.put(P.BODY, stationPrism([
    [0.14, 0.092, 0.11, 0.018],
    [0.09, 0.104, 0.128, 0.022],
    [-0.17, 0.104, 0.128, 0.022],
    [-0.245, 0.088, 0.102, 0.03],
  ], 0.016));
  // Top cover: a raised spine plate.
  b.put(P.METAL, stationPrism([
    [0.125, 0.074, 0.024, 0.094],
    [-0.2, 0.074, 0.024, 0.094],
    [-0.238, 0.058, 0.018, 0.088],
  ], 0.007));
  // Heat-sink fins across the top cover (the view looks straight down on them).
  if (hi) {
    for (let i = 0; i < 7; i++) b.put(P.METAL_LT, new THREE.BoxGeometry(0.062, 0.018, 0.006), [0, 0.115, 0.086 - i * 0.026], undefined, 'none');
  } else {
    b.put(P.METAL_LT, new THREE.BoxGeometry(0.062, 0.014, 0.16), [0, 0.112, 0.008], undefined, 'none');
  }
  // Flanks: charge window + bezel, accent status strip, vents.
  for (const sx of [-1, 1]) {
    const wz = (WINDOW_Z[0] + WINDOW_Z[1]) / 2;
    const wl = WINDOW_Z[0] - WINDOW_Z[1];
    b.put(P.WINDOW, new THREE.BoxGeometry(0.006, 0.03, wl), [sx * 0.0505, 0.036, wz], undefined, 'none');
    b.put(P.GLOW, new THREE.BoxGeometry(0.004, 0.005, 0.2), [sx * 0.0525, -0.006, -0.06], undefined, 'none');
    if (hi) {
      b.put(P.METAL_LT, chamferBox(0.008, 0.008, wl + 0.02, 0.0025), [sx * 0.0525, 0.055, wz]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.008, wl + 0.02, 0.0025), [sx * 0.0525, 0.017, wz]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.03, 0.008, 0.0025), [sx * 0.0525, 0.036, WINDOW_Z[0] + 0.006]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.03, 0.008, 0.0025), [sx * 0.0525, 0.036, WINDOW_Z[1] - 0.006]);
      for (let i = 0; i < 3; i++) {
        b.put(P.RUBBER, chamferBox(0.004, 0.04, 0.009, 0.0015), [sx * 0.0525, 0.034, -0.168 - i * 0.022], [0.25, 0, 0]);
      }
      // Hex-head bolts pinning the side plate.
      for (const [by, bz] of [[0.068, 0.07], [0.068, -0.2], [-0.028, 0.07], [-0.028, -0.2]] as const) {
        b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0048, 0.0048, 0.004, 6), [sx * 0.0525, by, bz], [0, 0, Math.PI / 2], 'none');
      }
    }
  }

  // ── Rear capacitor in a strut cage ────────────────────────────────────────
  const capZ0 = 0.14;
  const capZ1 = 0.27;
  const capY = 0.014;
  b.lathe(P.CAP, [[0, capZ0], [0.03, capZ0], [0.03, capZ1], [0, capZ1]], SEG, capY);
  for (const [z0, z1] of [[capZ0 - 0.006, capZ0 + 0.024], [capZ1 - 0.024, capZ1 + 0.006]] as const) {
    b.lathe(P.METAL, [[0, z0], [0.042, z0], [0.05, z0 + 0.008], [0.05, z1 - 0.008], [0.042, z1], [0, z1]], SEG, capY);
  }
  const struts = hi ? 6 : 3;
  for (let i = 0; i < struts; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / struts;
    b.put(P.METAL_LT, chamferBox(0.012, 0.01, capZ1 - capZ0 - 0.034, 0.003),
      [Math.cos(a) * 0.037, capY + Math.sin(a) * 0.037, (capZ0 + capZ1) / 2], [0, 0, a - Math.PI / 2]);
  }

  // ── Skeletal stock ─────────────────────────────────────────────────────────
  b.put(P.CARBON, chamferBox(0.032, 0.03, 0.17, 0.006), [0, 0.042, 0.358]);
  b.put(P.CARBON, stationPrism([
    [0.16, 0.032, 0.038, -0.058],
    [0.42, 0.032, 0.032, -0.088],
  ], 0.006));
  b.put(P.METAL, chamferBox(0.048, 0.18, 0.008, 0.003), [0, -0.025, 0.419]);
  b.put(P.RUBBER, chamferBox(0.044, 0.17, 0.032, 0.01), [0, -0.025, 0.438]);

  // ── Grip, guard, trigger (unchanged hold point for the hand IK) ───────────
  b.put(P.RUBBER, stationPrism([
    [0.13, 0.066, 0.05, -0.06],
    [0.04, 0.066, 0.05, -0.06],
  ], 0.012));
  b.put(P.RUBBER, chamferBox(0.06, 0.2, 0.082, 0.014), [0, -0.15, 0.1], [0.32, 0, 0]);
  b.put(P.METAL, chamferBox(0.066, 0.016, 0.09, 0.005), [0, -0.245, 0.132], [0.32, 0, 0]);
  b.put(P.METAL, chamferBox(0.014, 0.01, 0.11, 0.003), [0, -0.093, -0.002]);
  b.put(P.METAL, chamferBox(0.014, 0.056, 0.012, 0.003), [0, -0.066, -0.055]);
  if (hi) b.put(P.METAL_LT, chamferBox(0.009, 0.034, 0.011, 0.002), [0, -0.058, 0.004], [0.3, 0, 0]);

  // ── Foregrip battery under the barrel mount (the support hand's grip) ─────
  b.put(P.CARBON, stationPrism([
    [-0.19, 0.074, 0.058, -0.046],
    [-0.33, 0.066, 0.05, -0.043],
  ], 0.012));
  b.put(P.METAL, chamferBox(0.07, 0.046, 0.012, 0.004), [0, -0.043, -0.335]);

  // ── Accelerator ────────────────────────────────────────────────────────────
  // Mount collar where the barrel leaves the receiver.
  b.lathe(P.METAL, [[0.03, -0.3], [0.062, -0.3], [0.07, -0.29], [0.07, -0.246], [0.06, -0.236], [0.022, -0.236]], SEG);
  // The energy core, running the whole way to the emitter…
  b.lathe(P.CORE, [[0, CORE_Z[0]], [CORE_R, CORE_Z[0]], [CORE_R, CORE_Z[1]], [0, CORE_Z[1]]], hi ? 14 : 8, CORE_Y);
  // …in an open-top channel: two heavy side walls on a keel. From the side the
  // barrel reads as a solid housing; from the shoulder (the viewmodel's
  // angle) the core glows down the slot between the coils.
  const sz0 = -0.246;
  const sz1 = -0.772;
  const sl = sz0 - sz1;
  const sc = (sz0 + sz1) / 2;
  for (const sx of [-1, 1]) {
    b.put(P.METAL, chamferBox(0.016, 0.07, sl, 0.004), [sx * 0.028, BARREL_Y, sc]);
    if (hi) {
      // Vent slots between the coils.
      for (let i = 0; i < COIL_COUNT; i++) {
        const z = COIL_Z[i] - 0.0475;
        b.put(P.RUBBER, chamferBox(0.004, 0.03, 0.03, 0.0015), [sx * 0.0362, BARREL_Y - 0.002, z]);
      }
    }
  }
  b.put(P.METAL, chamferBox(0.058, 0.018, sl, 0.005), [0, BARREL_Y - 0.032, sc]);
  // Coils: a dark machined housing with a proud glowing band — the recharge
  // meter (see CoilDriver in weapon-model.ts).
  for (let i = 0; i < COIL_COUNT; i++) {
    const c = COIL_Z[i];
    const ring = hi ? 30 : 12;
    b.lathe(P.METAL, [
      [0.056, c - 0.026], [0.062, c - 0.026], [0.068, c - 0.02], [0.068, c - 0.016], [0.064, c - 0.016],
      [0.064, c + 0.016], [0.068, c + 0.016], [0.068, c + 0.02], [0.062, c + 0.026], [0.056, c + 0.026],
      [0.056, c - 0.026],
    ], ring);
    b.lathe(P.COIL0 + i, [[0.064, c - 0.016], [COIL_R, c - 0.012], [COIL_R, c + 0.012], [0.064, c + 0.016]], ring);
  }

  // ── Emitter: a heavy shroud, a glowing aperture ring, three prongs ────────
  b.lathe(P.METAL, [
    [0.026, -0.872], [0.05, -0.872], [0.064, -0.86], [0.064, -0.795], [0.056, -0.776], [0.042, -0.766], [0.03, -0.766],
  ], SEG);
  b.put(P.RUBBER, latheZ([[0, -0.868], [0.027, -0.868]], SEG), [0, BARREL_Y, 0], undefined, 'none');
  b.put(P.GLOW, new THREE.TorusGeometry(0.036, 0.006, 6, hi ? 28 : 12), [0, BARREL_Y, -0.873], undefined, 'none');
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    b.put(P.METAL_LT, chamferBox(0.014, 0.022, 0.13, 0.004),
      [Math.cos(a) * 0.058, BARREL_Y + Math.sin(a) * 0.058, -0.855], [0, 0, a - Math.PI / 2]);
  }
  if (hi) {
    // Vent slots round the shroud.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      b.put(P.RUBBER, chamferBox(0.004, 0.012, 0.05, 0.0015),
        [Math.cos(a) * 0.0625, BARREL_Y + Math.sin(a) * 0.0625, -0.82], [0, 0, a]);
    }
  }
  return b.merge();
}

const cache = new Map<GunLod, THREE.BufferGeometry>();

// The whole gun as one geometry for a LOD. Shared: never dispose it.
export function railgunGeometry(lod: GunLod): THREE.BufferGeometry {
  let g = cache.get(lod);
  if (!g) {
    g = buildGeometry(lod);
    g.name = `railgun-${lod}`;
    g.userData.shared = true;
    cache.set(lod, g);
  }
  return g;
}

// Glowing parts (drawn by a per-gun material in third person) vs the rest.
export function isEnergyPart(part: number): boolean {
  return part >= PART.GLOW && part !== PART.CARBON;
}

const splitCache = new Map<GunLod, { lit: THREE.BufferGeometry; energy: THREE.BufferGeometry }>();

// The LOD split into its lit shell and its glowing parts (third person: the
// shell shares a per-finish material, the glow is per gun). Shared + cached.
export function railgunGeometrySplit(lod: GunLod): { lit: THREE.BufferGeometry; energy: THREE.BufferGeometry } {
  let s = splitCache.get(lod);
  if (s) return s;
  const src = railgunGeometry(lod);
  const pos = src.attributes.position;
  const nor = src.attributes.normal;
  const gun = src.attributes.gun;
  const pick = (energy: boolean) => {
    const idx: number[] = [];
    for (let t = 0; t < pos.count; t += 3) {
      if (isEnergyPart(Math.round(gun.getX(t))) === energy) idx.push(t, t + 1, t + 2);
    }
    const g = new THREE.BufferGeometry();
    const copy = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number) => {
      const out = new Float32Array(idx.length * size);
      idx.forEach((v, j) => {
        for (let k = 0; k < size; k++) out[j * size + k] = a.getComponent(v, k);
      });
      return new THREE.BufferAttribute(out, size);
    };
    g.setAttribute('position', copy(pos, 3));
    g.setAttribute('normal', copy(nor, 3));
    g.setAttribute('gun', copy(gun, 3));
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  };
  s = { lit: pick(false), energy: pick(true) };
  s.lit.name = `railgun-${lod}-lit`;
  s.energy.name = `railgun-${lod}-energy`;
  splitCache.set(lod, s);
  return s;
}
