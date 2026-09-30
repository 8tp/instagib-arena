import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─────────────────────────────────────────────────────────────────────────
// Railgun geometry (procedural, no asset). A chunky Q3-style rail: a heavy
// receiver with heat-sink fins on top and a charge window in each flank, a
// rear capacitor in a strut cage, a skeletal stock, an angled rubber grip, and
// an accelerator — a glowing energy core running the whole barrel in an
// open-top channel (vented side walls on a keel), ringed by four bold coils,
// ending in a pronged emitter.
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
  COIL0: 9, // coils: COIL0 + i, i = 0 front (muzzle) … COIL_COUNT-1 back (lights first)
} as const;

export const COIL_COUNT = 4;
export const BARREL_Y = 0.03;
export const MUZZLE_Z = -0.9;
// Coil centres, index 0 = front (relights last on the recharge).
export const COIL_Z = [-0.655, -0.56, -0.465, -0.37] as const;
export const COIL_R = 0.066; // glowing band's outer radius
export const CORE_R = 0.016;
export const CORE_Y = BARREL_Y + 0.012; // rides high in the barrel channel
export const CORE_Z = [-0.862, -0.27] as const; // front, back
// Charge window (each flank), filling rear → front with the charge.
export const WINDOW_Z = [0.006, -0.136] as const; // rear, front
export const NO_AXIS = -10;

export type GunLod = 'high' | 'low';

// Where the Tracked kill counter (tracker.ts) seats on the standard gun: the
// lower −X flank of the receiver, under the charge window (the flank the
// first-person view sees). Model space; the module's local x = 0 is the flank.
export type TrackerMount = { position: [number, number, number]; rotationY?: number; scale?: number };
export const TRACKER_MOUNT: TrackerMount = { position: [-0.049, -0.013, -0.035] };

type V3 = [number, number, number];
type EdgeMode = 'hull' | 'none' | 'all';

// A box with every edge chamfered by `c` (convex hull of the 24 cut corners):
// flat-shaded bevels that catch a highlight on each edge.
export function chamferBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
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
export function stationPrism(stations: Array<[number, number, number, number]>, c: number): THREE.BufferGeometry {
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

export class GunBuilder {
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

// Rotate a model-space offset by an Euler (for parts placed along a tilted
// member, e.g. the grip's finger ridges).
function along(origin: V3, rot: V3, local: V3): V3 {
  const v = new THREE.Vector3(...local).applyEuler(new THREE.Euler(...rot));
  return [origin[0] + v.x, origin[1] + v.y, origin[2] + v.z];
}

function hexBolt(b: GunBuilder, pos: V3, r: number, axis: 'x' | 'y' | 'z', sign = 1) {
  // A hex head on a thin washer, facing along ±axis.
  const rot: V3 = axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  const off = (d: number): V3 =>
    axis === 'x' ? [pos[0] + sign * d, pos[1], pos[2]] : axis === 'y' ? [pos[0], pos[1] + sign * d, pos[2]] : [pos[0], pos[1], pos[2] + sign * d];
  b.put(PART.METAL, new THREE.CylinderGeometry(r * 1.3, r * 1.3, 0.0012, 10), off(0), rot, 'none');
  b.put(PART.METAL_LT, new THREE.CylinderGeometry(r * 0.92, r, 0.0032, 6), off(0.0018), rot, 'none');
}

function buildGeometry(lod: GunLod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 32 : 10;
  const b = new GunBuilder();
  const P = PART;

  // ── Receiver: a heavy chamfered block tapering into the barrel mount ──────
  b.put(P.BODY, stationPrism([
    [0.14, 0.088, 0.104, 0.02],
    [0.09, 0.098, 0.118, 0.024],
    [-0.17, 0.098, 0.118, 0.024],
    [-0.245, 0.084, 0.096, 0.03],
  ], 0.015));
  // Top cover: a raised spine plate.
  b.put(P.METAL, stationPrism([
    [0.125, 0.07, 0.022, 0.09],
    [-0.2, 0.07, 0.022, 0.09],
    [-0.238, 0.056, 0.016, 0.085],
  ], 0.007));
  // Heat-sink fins across the top cover (the view looks straight down on
  // them), between two machined side rails; a low notch sight at the rear.
  if (hi) {
    for (let i = 0; i < 9; i++) {
      b.put(P.METAL_LT, chamferBox(0.054, 0.013, 0.0052, 0.0014), [0, 0.1065, 0.09 - i * 0.02]);
    }
    for (const sx of [-1, 1]) {
      b.put(P.METAL, chamferBox(0.006, 0.01, 0.178, 0.0018), [sx * 0.03, 0.105, 0.01]);
    }
    b.put(P.METAL, chamferBox(0.036, 0.006, 0.016, 0.0018), [0, 0.103, 0.114]);
    for (const sx of [-1, 1]) b.put(P.METAL_LT, chamferBox(0.009, 0.014, 0.012, 0.002), [sx * 0.0105, 0.11, 0.114]);
  } else {
    b.put(P.METAL_LT, new THREE.BoxGeometry(0.056, 0.01, 0.18), [0, 0.105, 0.0], undefined, 'none');
  }
  // Flanks: charge window + bezel, accent status strip under the top cover,
  // vents, a bolted access plate low on the flank (the Tracked counter's seat
  // on the −X side — see TRACKER_MOUNT).
  for (const sx of [-1, 1]) {
    const wz = (WINDOW_Z[0] + WINDOW_Z[1]) / 2;
    const wl = WINDOW_Z[0] - WINDOW_Z[1];
    b.put(P.WINDOW, new THREE.BoxGeometry(0.006, 0.03, wl), [sx * 0.0475, 0.036, wz], undefined, 'none');
    b.put(P.GLOW, new THREE.BoxGeometry(0.004, 0.004, 0.23), [sx * 0.0495, 0.0665, -0.065], undefined, 'none');
    if (hi) {
      b.put(P.METAL_LT, chamferBox(0.008, 0.008, wl + 0.02, 0.0025), [sx * 0.0495, 0.055, wz]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.008, wl + 0.02, 0.0025), [sx * 0.0495, 0.017, wz]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.03, 0.008, 0.0025), [sx * 0.0495, 0.036, WINDOW_Z[0] + 0.006]);
      b.put(P.METAL_LT, chamferBox(0.008, 0.03, 0.008, 0.0025), [sx * 0.0495, 0.036, WINDOW_Z[1] - 0.006]);
      // Strip channel: a dark slot the accent strip sits in.
      b.put(P.RUBBER, new THREE.BoxGeometry(0.003, 0.008, 0.236), [sx * 0.0483, 0.0665, -0.065], undefined, 'none');
      for (let i = 0; i < 3; i++) {
        b.put(P.RUBBER, chamferBox(0.004, 0.04, 0.009, 0.0015), [sx * 0.0495, 0.034, -0.168 - i * 0.022], [0.25, 0, 0]);
      }
      // Access plate + its four screws.
      b.put(P.METAL, chamferBox(0.003, 0.026, 0.13, 0.0012), [sx * 0.0495, -0.006, -0.035]);
      for (const [py, pz] of [[0.002, 0.024], [0.002, -0.094], [-0.014, 0.024], [-0.014, -0.094]] as const) {
        b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0022, 0.0022, 0.0026, 6), [sx * 0.051, py, pz], [0, 0, Math.PI / 2], 'none');
      }
      // Hex-head bolts pinning the side plate.
      for (const [by, bz] of [[0.058, 0.074], [0.058, -0.204], [-0.014, 0.074], [-0.014, -0.204]] as const) {
        hexBolt(b, [sx * 0.049, by, bz], 0.0042, 'x', sx);
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
    // A bright machined lip on each end ring.
    if (hi) b.lathe(P.METAL_LT, [[0.0495, z0 + 0.011], [0.052, z0 + 0.013], [0.052, z1 - 0.013], [0.0495, z1 - 0.011]], SEG, capY);
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
  if (hi) {
    // Cheek riser on the top bar, and cross pins where the bars meet the plate.
    b.put(P.BODY, stationPrism([
      [0.3, 0.036, 0.016, 0.063],
      [0.33, 0.038, 0.02, 0.065],
      [0.4, 0.038, 0.02, 0.065],
      [0.412, 0.034, 0.016, 0.063],
    ], 0.005));
    for (const [py, pz] of [[0.042, 0.405], [-0.084, 0.405]] as const) {
      b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0045, 0.0045, 0.038, 8), [0, py, pz], [0, 0, Math.PI / 2], 'none');
    }
  }

  // ── Grip, guard, trigger (unchanged hold point for the hand IK) ───────────
  b.put(P.RUBBER, stationPrism([
    [0.13, 0.066, 0.05, -0.06],
    [0.04, 0.066, 0.05, -0.06],
  ], 0.012));
  const gripRot: V3 = [0.32, 0, 0];
  const gripAt: V3 = [0, -0.15, 0.1];
  if (hi) {
    // Contoured grip: a palm swell, a flared base; built along Z, stood up.
    const grip = stationPrism([
      [-0.1, 0.058, 0.08, 0.002],
      [-0.084, 0.062, 0.084, 0.0],
      [-0.02, 0.064, 0.086, -0.002],
      [0.05, 0.061, 0.082, 0.0],
      [0.1, 0.058, 0.078, 0.0],
    ], 0.013);
    grip.rotateX(-Math.PI / 2); // local +Z → +Y (up the grip); local y → −Z
    b.put(P.RUBBER, grip, gripAt, gripRot);
    // A metal backstrap and a screw each side (the stipple is in the shader).
    b.put(P.METAL, chamferBox(0.04, 0.17, 0.006, 0.002), along(gripAt, gripRot, [0, 0.0, 0.042]), gripRot);
    for (const sx of [-1, 1]) {
      b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0034, 0.0034, 0.003, 6), along(gripAt, gripRot, [sx * 0.031, 0.045, 0.01]), [0, 0, Math.PI / 2], 'none');
    }
  } else {
    b.put(P.RUBBER, chamferBox(0.06, 0.2, 0.082, 0.014), gripAt, gripRot);
  }
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
  if (hi) {
    // Contact bands round the cell and a release latch on each side.
    b.put(P.METAL_LT, chamferBox(0.077, 0.061, 0.007, 0.0025), [0, -0.0455, -0.212]);
    b.put(P.METAL_LT, chamferBox(0.07, 0.054, 0.007, 0.0025), [0, -0.0435, -0.308]);
    for (const sx of [-1, 1]) {
      b.put(P.METAL, chamferBox(0.004, 0.016, 0.03, 0.0012), [sx * 0.0365, -0.043, -0.26]);
    }
  }

  // ── Accelerator ────────────────────────────────────────────────────────────
  // Mount collar where the barrel leaves the receiver.
  b.lathe(P.METAL, [[0.03, -0.3], [0.058, -0.3], [0.065, -0.29], [0.065, -0.246], [0.056, -0.236], [0.022, -0.236]], SEG);
  if (hi) {
    // A bright machined band round the collar + a low front sight post on top.
    b.lathe(P.METAL_LT, [[0.064, -0.281], [0.067, -0.278], [0.067, -0.258], [0.064, -0.255]], SEG);
    b.put(P.METAL, chamferBox(0.016, 0.008, 0.022, 0.002), [0, BARREL_Y + 0.068, -0.268]);
    b.put(P.METAL_LT, chamferBox(0.004, 0.012, 0.006, 0.0012), [0, BARREL_Y + 0.077, -0.268]);
  }
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
    b.put(P.METAL, chamferBox(0.015, 0.064, sl, 0.004), [sx * 0.027, BARREL_Y, sc]);
    if (hi) {
      // Conductor rails capping the walls.
      b.put(P.METAL_LT, chamferBox(0.008, 0.004, sl - 0.012, 0.0014), [sx * 0.027, BARREL_Y + 0.0335, sc]);
      // Vent slots between the coils.
      for (let i = 0; i < COIL_COUNT; i++) {
        const z = COIL_Z[i] - 0.0475;
        b.put(P.RUBBER, chamferBox(0.004, 0.028, 0.03, 0.0015), [sx * 0.0347, BARREL_Y - 0.002, z]);
      }
    }
  }
  b.put(P.METAL, chamferBox(0.054, 0.016, sl, 0.005), [0, BARREL_Y - 0.03, sc]);
  // Coils: a dark machined housing with a proud glowing band — the recharge
  // meter (see CoilDriver in weapon-model.ts).
  for (let i = 0; i < COIL_COUNT; i++) {
    const c = COIL_Z[i];
    const ring = hi ? 48 : 12;
    b.lathe(P.METAL, hi ? [
      [0.052, c - 0.025], [0.057, c - 0.025], [0.063, c - 0.019], [0.063, c - 0.015], [0.059, c - 0.015],
      [0.059, c + 0.015], [0.063, c + 0.015], [0.063, c + 0.019], [0.057, c + 0.025], [0.052, c + 0.025],
      [0.052, c - 0.025],
    ] : [
      // Third person: a plain sleeve (the inside never shows at range).
      [0.052, c - 0.025], [0.063, c - 0.025], [0.063, c - 0.015], [0.059, c - 0.015],
      [0.059, c + 0.015], [0.063, c + 0.015], [0.063, c + 0.025], [0.052, c + 0.025],
    ], ring);
    b.lathe(P.COIL0 + i, [[0.059, c - 0.015], [COIL_R, c - 0.011], [COIL_R, c + 0.011], [0.059, c + 0.015]], ring);
  }

  // ── Emitter: a heavy shroud, a glowing aperture ring, three prongs ────────
  b.lathe(P.METAL, [
    [0.026, -0.872], [0.047, -0.872], [0.059, -0.861], [0.059, -0.795], [0.052, -0.777], [0.04, -0.766], [0.03, -0.766],
  ], SEG);
  if (hi) b.lathe(P.METAL_LT, [[0.058, -0.812], [0.061, -0.809], [0.061, -0.797], [0.058, -0.794]], SEG);
  b.put(P.RUBBER, latheZ([[0, -0.868], [0.027, -0.868]], SEG), [0, BARREL_Y, 0], undefined, 'none');
  b.put(P.GLOW, new THREE.TorusGeometry(0.036, 0.006, 6, hi ? 40 : 12), [0, BARREL_Y, -0.873], undefined, 'none');
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    b.put(P.METAL_LT, chamferBox(0.014, 0.022, 0.13, 0.004),
      [Math.cos(a) * 0.054, BARREL_Y + Math.sin(a) * 0.054, -0.855], [0, 0, a - Math.PI / 2]);
  }
  if (hi) {
    // Vent slots round the shroud.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      b.put(P.RUBBER, chamferBox(0.004, 0.012, 0.04, 0.0015),
        [Math.cos(a) * 0.0575, BARREL_Y + Math.sin(a) * 0.0575, -0.836], [0, 0, a]);
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
  return part >= PART.GLOW;
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
