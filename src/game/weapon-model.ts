import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RailgunFinish } from './cosmetics';
import { flashTexture } from './fx-pool';
import { localRail, nowMs } from './fx/rail-state';

// ─────────────────────────────────────────────────────────────────────────
// Procedural railgun (no external asset — the game's art pipeline is all
// procedural). A Q3-inspired long gun: a machined receiver with an angled
// rubber grip and a skeletal carbon stock, a rear power capacitor, and a long
// slim accelerator — a barrel between twin conductor rails, wrapped by a row of
// six energy coils, ending in a finned emitter shroud.
//
// The coils ARE the ammo readout (first-person viewmodel): bright when ready;
// on a shot they flash white-hot, drop dark, and refill one by one front
// (muzzle) to back over the recharge, with a glint when the rail is ready. The
// capacitor fills with the charge too. See CoilDriver below.
//
// MODEL-SPACE CONVENTION (stable — third-person sockets depend on it):
//   • origin   = the grip / trigger point (the right hand's palm sits just
//                below and behind it, around (0, -0.12, 0.09));
//   • forward  = -Z (the barrel points down -Z, the camera's forward);
//   • up       = +Y; the gun is symmetric about X = 0;
//   • scale    = 1 unit ≈ 1 m at scale 1: ~1.33 long (butt +0.44 → tip -0.9),
//                muzzle marker at (0, 0.03, -0.9). Callers scale the group
//                (first person 0.8, the old soldier hand bone 60 → ~0.6 m).
//
// Parts are merged per material (≈ 12 draw calls first person, 7 third person)
// and every geometry/material here belongs to the returned group — the caller
// disposes it like any other mesh group. Only the flash texture is shared.
// ─────────────────────────────────────────────────────────────────────────

// Stock finish (the default railgun look). A `RailgunFinish` cosmetic overrides
// these per-build; see RAILGUN_FINISHES in cosmetics.ts.
const STOCK_BODY = 0x171b22; // near-black receiver
const STOCK_METAL = 0x2c333f; // gunmetal
const STOCK_METAL_LT = 0x515d6e; // lighter frame edges
const STOCK_ACCENT = 0x37a6ff; // rail blue (matches the beam)
const STOCK_ACCENT_HOT = 0x8af2ff; // bright cyan energy

const COIL_COUNT = 6;
const BARREL_Y = 0.03; // accelerator axis height

// Coil emissive levels (linear). REST stays under the bloom threshold (1.5) so
// a ready gun reads lit without glaring; the fire flash + ready glint bloom.
const COIL_REST = 1.15;
const COIL_DARK = 0.035;
const COIL_EDGE = 1.6; // leading-edge glint while a coil fills
const COIL_FLASH = 7;
const COIL_READY = 1.6;
const CAP_REST = 0.55;

export type RailgunLod = 'high' | 'low';

export type RailgunModel = {
  group: THREE.Group;
  muzzle: THREE.Object3D; // barrel-tip marker (beam origin)
  // Shared accent emissive (receiver status strips + emitter ring). The Game
  // pops its intensity on fire / kill and eases it back to 0.8.
  glow: THREE.MeshStandardMaterial;
  // Additive discharge flare seated on the muzzle, hidden at rest. The first-
  // person viewmodel drives it (visible + opacity 1→0 + scale 1→1.9) per shot.
  muzzleFlash: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  // Drive the coils explicitly: 0 = just fired … 1 = ready. Once called, the
  // gun ignores the shared local-rail state (fx/rail-state.ts). A first-person
  // viewmodel parented to the camera follows that state automatically.
  setCharge(charge: number): void;
  // Flash the coils for a shot (explicit drive only; pairs with setCharge).
  notifyFire(): void;
};

export type BuildRailgunOptions = {
  // 'high' (default): first-person / locker detail with per-coil materials.
  // 'low': third-person — fewer segments, no small detail, one coil material.
  lod?: RailgunLod;
};

// ── Geometry helpers ─────────────────────────────────────────────────────────

type V3 = [number, number, number];

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
    // Chamfered end: full section `c` inside, inset section on the face.
    const dir = Math.sign(stations[i === 0 ? 1 : i - 1][0] - z) || 1;
    ring(z + dir * c, w, h, yc);
    ring(z, w - 2 * c, h - 2 * c, yc);
  });
  return new ConvexGeometry(pts);
}

// Surface of revolution about the Z axis from a [radius, z] profile, built one
// band per profile segment so each band keeps its own normal: smooth around the
// axis, crisp at every chamfer. Walk the profile outward-then-back (e.g. rear
// cap → side → front cap) with z increasing for outward-facing sides.
function latheZ(profile: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const bands: THREE.BufferGeometry[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const g = new THREE.LatheGeometry([new THREE.Vector2(a[0], a[1]), new THREE.Vector2(b[0], b[1])], seg);
    g.rotateX(Math.PI / 2); // lathe +Y → +Z
    bands.push(prep(g));
  }
  const merged = mergeGeometries(bands, false);
  for (const g of bands) g.dispose();
  return merged ?? new THREE.BufferGeometry();
}

// Normalise to non-indexed position/normal/uv so every part merges per material.
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g;
  if (g.index) {
    out = g.toNonIndexed();
    g.dispose();
  }
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  }
  return out;
}

// Box-projected UVs in gun space (metres × scale): the carbon weave tiles at a
// constant size on every face regardless of the part's own UV layout.
function boxUv(g: THREE.BufferGeometry, scale: number) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (nx >= ny && nx >= nz) uv.setXY(i, z * scale, y * scale);
    else if (ny >= nz) uv.setXY(i, x * scale, z * scale);
    else uv.setXY(i, x * scale, y * scale);
  }
  uv.needsUpdate = true;
}

// ── Procedural textures (module-cached, shared by every gun) ────────────────

let carbonTex: THREE.Texture | null = null;
// 2×2 twill carbon weave: alternating light/dark tows with a soft sheen.
function carbonTexture(): THREE.Texture | null {
  if (carbonTex) return carbonTex;
  if (typeof document === 'undefined') return null;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const cell = S / 4;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const horiz = ((i + j) & 3) < 2;
      const g = horiz
        ? ctx.createLinearGradient(0, j * cell, 0, (j + 1) * cell)
        : ctx.createLinearGradient(i * cell, 0, (i + 1) * cell, 0);
      g.addColorStop(0, '#6d6d6d');
      g.addColorStop(0.5, horiz ? '#f2f2f2' : '#c4c4c4');
      g.addColorStop(1, '#6d6d6d');
      ctx.fillStyle = g;
      ctx.fillRect(i * cell, j * cell, cell, cell);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  carbonTex = t;
  return t;
}

// ── Coil driver ─────────────────────────────────────────────────────────────

const tmpHot = new THREE.Color();

// Animates the coil + capacitor emissives from the rail charge. Time-based
// (performance.now) so the flash/glint look identical at any frame rate.
class CoilDriver {
  external = false;
  charge = 1;
  private shots = -1;
  private fireMs = -1e9;
  private readyMs = -1e9;
  private prevCharge = 1;

  constructor(
    private readonly coils: THREE.MeshStandardMaterial[], // front (muzzle) → back
    private readonly cap: THREE.MeshStandardMaterial,
    private readonly accent: THREE.Color,
    private readonly hot: THREE.Color,
  ) {}

  fire(now: number) {
    this.fireMs = now;
  }

  update(now: number) {
    if (!this.external) {
      this.charge = localRail.charge;
      if (localRail.shots !== this.shots) {
        if (this.shots >= 0) this.fireMs = now;
        this.shots = localRail.shots;
      }
    }
    const charge = Math.max(0, Math.min(1, this.charge));
    if (charge >= 1 && this.prevCharge < 1) this.readyMs = now;
    this.prevCharge = charge;

    const sinceFire = (now - this.fireMs) / 1000;
    const flash = sinceFire < 0.4 ? Math.exp(-sinceFire * 26) : 0;
    const sinceReady = (now - this.readyMs) / 1000;
    const ready = sinceReady < 0.6 ? Math.exp(-sinceReady * 8) : 0;
    // The first ~12 % of the recharge stays dark so the discharge reads, then
    // the coils refill one after another, front (muzzle) to back.
    const fill = Math.max(0, Math.min(1, (charge - 0.12) / 0.86));
    const n = this.coils.length;
    const t = now / 1000;
    for (let i = 0; i < n; i++) {
      const p = Math.max(0, Math.min(1, fill * n - i));
      const level = p * p * (3 - 2 * p);
      const edge = p > 0 && p < 1 ? 4 * p * (1 - p) : 0;
      // Charged coils carry a faint wave running back along the barrel, so a
      // ready gun reads as live energy rather than a static light.
      const hum = 1 + 0.09 * level * Math.sin(t * 5.2 - i * 0.9);
      const mat = this.coils[i];
      mat.emissiveIntensity =
        (COIL_DARK + (COIL_REST - COIL_DARK) * level) * hum + COIL_EDGE * edge + COIL_FLASH * flash + COIL_READY * ready;
      const h = Math.min(1, flash * 1.4 + edge * 0.7 + ready * 0.8);
      mat.emissive.copy(this.accent).lerp(this.hot, h);
    }
    this.cap.emissiveIntensity = 0.08 + CAP_REST * fill + 5 * flash + 0.8 * ready;
    tmpHot.copy(this.accent).lerp(this.hot, Math.min(1, flash + 0.35));
    this.cap.emissive.copy(tmpHot);
  }
}

// ── Builder ─────────────────────────────────────────────────────────────────

type Bucket = 'body' | 'metal' | 'metalLt' | 'rubber' | 'carbon' | 'glow' | 'cap' | 'coil' | `coil${number}`;

// Canonical railgun (see the convention above). `finish` (a railgun-finish
// cosmetic's colours) recolours it; omitted = stock.
export function buildRailgun(finish?: RailgunFinish, opts: BuildRailgunOptions = {}): RailgunModel {
  const lod: RailgunLod = opts.lod ?? 'high';
  const hi = lod === 'high';
  const SEG = hi ? 20 : 10; // radial segments for round parts

  const COL_BODY = finish?.body ?? STOCK_BODY;
  const COL_METAL = finish?.metal ?? STOCK_METAL;
  const COL_METAL_LT = finish?.metalLt ?? STOCK_METAL_LT;
  const COL_ACCENT = finish?.accent ?? STOCK_ACCENT;
  const COL_ACCENT_HOT = finish?.accentHot ?? STOCK_ACCENT_HOT;

  const group = new THREE.Group();
  const parts = new Map<Bucket, THREE.BufferGeometry[]>();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const tmpP = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);
  const put = (bucket: Bucket, geo: THREE.BufferGeometry, pos: V3 = [0, 0, 0], rot?: V3) => {
    const g = prep(geo);
    tmpQ.setFromEuler(tmpE.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
    g.applyMatrix4(tmpM.compose(tmpP.set(...pos), tmpQ, ONE));
    let list = parts.get(bucket);
    if (!list) parts.set(bucket, (list = []));
    list.push(g);
  };

  // ── Receiver: a tapered, chamfered body with a separate top cover ─────────
  put('body', stationPrism([
    [0.135, 0.1, 0.112, 0.018],
    [-0.12, 0.1, 0.112, 0.018],
    [-0.205, 0.088, 0.094, 0.026],
  ], 0.014));
  put('metal', stationPrism([
    [0.12, 0.078, 0.03, 0.088],
    [-0.19, 0.078, 0.03, 0.088],
    [-0.215, 0.066, 0.022, 0.084],
  ], 0.008));
  // Low top rail (picatinny-style) — gives the top a machined read.
  put('metalLt', chamferBox(0.03, 0.012, 0.26, 0.003), [0, 0.108, -0.045]);
  // Side plates, each carrying a thin accent status strip (the pulsed `glow`).
  for (const sx of [-1, 1]) {
    put('metal', chamferBox(0.008, 0.066, 0.22, 0.003), [sx * 0.051, 0.022, -0.04]);
    put('glow', new THREE.BoxGeometry(0.004, 0.005, 0.15), [sx * 0.0556, 0.004, -0.045]);
  }
  if (hi) {
    // Top-rail cross slots + side vents (rubber = near-black recesses).
    for (let i = 0; i < 7; i++) put('metal', new THREE.BoxGeometry(0.034, 0.006, 0.01), [0, 0.113, 0.06 - i * 0.034]);
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        put('rubber', chamferBox(0.004, 0.016, 0.032, 0.0015), [sx * 0.0555, 0.036, -0.0 - i * 0.046]);
      }
    }
  }

  // ── Power capacitor behind the receiver: a charge core in a strut cage ────
  // Sits below the receiver's top line so the first-person view looks over it.
  const capZ0 = 0.13;
  const capZ1 = 0.27;
  const capY = 0.012;
  put('cap', latheZ([[0, capZ0], [0.028, capZ0], [0.028, capZ1], [0, capZ1]], SEG), [0, capY, 0]);
  for (const [z0, z1] of [[capZ0 - 0.006, capZ0 + 0.022], [capZ1 - 0.022, capZ1 + 0.006]] as const) {
    put('metal', latheZ([[0, z0], [0.04, z0], [0.047, z0 + 0.007], [0.047, z1 - 0.007], [0.04, z1], [0, z1]], SEG), [0, capY, 0]);
  }
  if (hi) put('metal', latheZ([[0.029, 0.193], [0.038, 0.193], [0.038, 0.207], [0.029, 0.207]], SEG), [0, capY, 0]);
  const struts = hi ? 6 : 3;
  for (let i = 0; i < struts; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / struts;
    put('metalLt', chamferBox(0.012, 0.01, capZ1 - capZ0 - 0.03, 0.003),
      [Math.cos(a) * 0.034, capY + Math.sin(a) * 0.034, (capZ0 + capZ1) / 2], [0, 0, a - Math.PI / 2]);
  }

  // ── Accelerator: barrel between twin conductor rails, wrapped by coils ────
  // Coil housing where the accelerator leaves the receiver.
  put('metal', latheZ([[0.02, -0.262], [0.052, -0.262], [0.062, -0.25], [0.062, -0.205], [0.05, -0.198]], SEG), [0, BARREL_Y, 0]);
  put('metalLt', latheZ([[0, -0.87], [0.019, -0.87], [0.019, -0.26], [0, -0.26]], hi ? 12 : 8), [0, BARREL_Y, 0]);
  for (const sx of [-1, 1]) {
    put('metal', chamferBox(0.012, 0.03, 0.52, 0.003), [sx * 0.031, BARREL_Y, -0.505]);
  }
  // Lower spine tying the coil housing to the emitter shroud.
  put('metal', chamferBox(0.022, 0.016, 0.52, 0.004), [0, BARREL_Y - 0.064, -0.505]);

  const COIL_PITCH = 0.084;
  const coilZ = (i: number) => -0.3 - i * COIL_PITCH; // i = 0 nearest the receiver
  for (let i = 0; i < COIL_COUNT; i++) {
    const z = coilZ(i);
    // Front-most coil is index 0 in the driver (fills first).
    const bucket: Bucket = hi ? `coil${COIL_COUNT - 1 - i}` : 'coil';
    // Third person gets a fatter ring so the coils still read as bands at range.
    put(bucket, new THREE.TorusGeometry(0.046, hi ? 0.0095 : 0.0135, hi ? 8 : 5, hi ? 28 : 14), [0, BARREL_Y, z]);
    // A dark machined collar midway to the next coil separates the rings, so
    // the row reads as six discrete coils (not a spring) and frames the glow.
    const c = z - COIL_PITCH / 2;
    put('metal', latheZ([
      [0.03, c - 0.009], [0.046, c - 0.009], [0.051, c - 0.005], [0.051, c + 0.005], [0.046, c + 0.009], [0.03, c + 0.009],
    ], SEG), [0, BARREL_Y, 0]);
  }

  // ── Emitter shroud + fins at the tip ──────────────────────────────────────
  put('metal', latheZ([
    [0.024, -0.878], [0.04, -0.878], [0.05, -0.868], [0.05, -0.77], [0.043, -0.758], [0.024, -0.758],
  ], SEG), [0, BARREL_Y, 0]);
  put('rubber', latheZ([[0, -0.874], [0.026, -0.874]], SEG), [0, BARREL_Y, 0]); // dark aperture
  put('glow', new THREE.TorusGeometry(0.031, 0.0055, 6, hi ? 24 : 12), [0, BARREL_Y, -0.879]);
  const fins = hi ? 3 : 2;
  for (let i = 0; i < fins; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    put('metalLt', chamferBox(0.01, 0.018, 0.1, 0.003),
      [Math.cos(a) * 0.052, BARREL_Y + Math.sin(a) * 0.052, -0.845], [0, 0, a - Math.PI / 2]);
  }

  // ── Foregrip block under the coil housing ─────────────────────────────────
  put('carbon', stationPrism([
    [-0.19, 0.07, 0.05, -0.045],
    [-0.3, 0.064, 0.044, -0.042],
  ], 0.01));

  // ── Grip, guard, trigger ───────────────────────────────────────────────────
  put('rubber', stationPrism([
    [0.13, 0.064, 0.05, -0.06],
    [0.04, 0.064, 0.05, -0.06],
  ], 0.012));
  put('rubber', chamferBox(0.06, 0.2, 0.082, 0.014), [0, -0.15, 0.1], [0.32, 0, 0]);
  put('metal', chamferBox(0.066, 0.016, 0.09, 0.005), [0, -0.245, 0.132], [0.32, 0, 0]);
  put('metal', chamferBox(0.014, 0.01, 0.11, 0.003), [0, -0.093, -0.002]);
  put('metal', chamferBox(0.014, 0.056, 0.012, 0.003), [0, -0.066, -0.055]);
  if (hi) put('metalLt', chamferBox(0.009, 0.034, 0.011, 0.002), [0, -0.058, 0.004], [0.3, 0, 0]);

  // ── Skeletal stock: upper bar off the capacitor, lower strut, butt pad ────
  put('carbon', chamferBox(0.03, 0.028, 0.16, 0.006), [0, 0.035, 0.355]);
  put('carbon', stationPrism([
    [0.16, 0.03, 0.036, -0.055],
    [0.42, 0.03, 0.03, -0.085],
  ], 0.006));
  put('rubber', chamferBox(0.04, 0.16, 0.03, 0.009), [0, -0.025, 0.43]);

  // ── Materials ──────────────────────────────────────────────────────────────
  const accent = new THREE.Color(COL_ACCENT);
  const accentHot = new THREE.Color(COL_ACCENT_HOT);
  const glow = new THREE.MeshStandardMaterial({
    color: COL_ACCENT_HOT,
    emissive: accentHot.clone(),
    emissiveIntensity: 0.8,
    metalness: 0.2,
    roughness: 0.25,
  });
  // Dark when spent: a near-black coated winding, so the refill reads.
  const coilBase = new THREE.Color(COL_BODY).lerp(accent, 0.05);
  const coilMat = () =>
    new THREE.MeshStandardMaterial({
      color: coilBase,
      emissive: accent.clone(),
      emissiveIntensity: COIL_REST,
      metalness: 0.45,
      roughness: 0.42,
    });
  const mats: Partial<Record<Bucket, THREE.Material>> = {
    body: new THREE.MeshStandardMaterial({ color: COL_BODY, metalness: 0.55, roughness: 0.42 }),
    metal: new THREE.MeshStandardMaterial({ color: COL_METAL, metalness: 0.9, roughness: 0.34 }),
    metalLt: new THREE.MeshStandardMaterial({ color: COL_METAL_LT, metalness: 0.95, roughness: 0.24 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0f1114, metalness: 0.0, roughness: 0.88 }),
    carbon: new THREE.MeshStandardMaterial({
      color: new THREE.Color(COL_BODY).multiplyScalar(1.25),
      map: carbonTexture(),
      metalness: 0.35,
      roughness: 0.36,
    }),
    glow,
    cap: new THREE.MeshStandardMaterial({
      color: new THREE.Color(COL_ACCENT).multiplyScalar(0.35),
      emissive: accent.clone(),
      emissiveIntensity: 0.08 + CAP_REST,
      metalness: 0.1,
      roughness: 0.2,
    }),
  };
  const coilMats: THREE.MeshStandardMaterial[] = [];
  if (hi) {
    for (let i = 0; i < COIL_COUNT; i++) {
      const m = coilMat();
      coilMats.push(m);
      mats[`coil${i}`] = m;
    }
  } else {
    const m = coilMat();
    m.emissiveIntensity = 1.35; // a touch hotter so the band reads at range
    mats.coil = m;
  }

  // ── Merge per material ─────────────────────────────────────────────────────
  let anchor: THREE.Mesh | null = null;
  for (const [bucket, list] of parts) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    if (bucket === 'carbon') boxUv(merged, 1 / 0.024);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mats[bucket]!);
    mesh.name = `railgun-${bucket}`;
    group.add(mesh);
    if (bucket === 'body') anchor = mesh;
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, BARREL_Y, -0.9);
  group.add(muzzle);

  // Discharge flare: a camera-facing-ish star (disc across the bore) plus two
  // crossed streak planes blown forward along the barrel. Additive, unlit, no
  // depth write — reads as a burst of energy, never as a solid ball.
  const flareGeo = buildFlareGeometry();
  const muzzleFlash = new THREE.Mesh(
    flareGeo,
    new THREE.MeshBasicMaterial({
      // Bright enough to bloom hard on the first frames; the Game fades the
      // opacity to 0 over ~100 ms.
      color: new THREE.Color(COL_ACCENT_HOT).lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(2.4),
      map: flashTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Drawn over the shroud (the flare engulfs the muzzle, never hides
      // behind it); it lives ~100 ms.
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  muzzleFlash.position.set(0, 0, -0.01);
  muzzleFlash.visible = false;
  muzzleFlash.renderOrder = 2;
  muzzle.add(muzzleFlash);

  // ── Coil drive ─────────────────────────────────────────────────────────────
  // First person: animate every frame the viewmodel renders (onBeforeRender on
  // the always-visible receiver), register the muzzle for the local beam, and
  // follow the shared local-rail charge unless driven explicitly.
  const driver = hi ? new CoilDriver(coilMats, mats.cap as THREE.MeshStandardMaterial, accent, accentHot) : null;
  if (driver && anchor) {
    anchor.frustumCulled = false; // the hook must run even if the body is off-frame
    anchor.onBeforeRender = () => {
      const parent = group.parent as (THREE.Object3D & { isCamera?: boolean }) | null;
      const isViewmodel = !!parent?.isCamera;
      if (!isViewmodel && !driver.external) return;
      const now = nowMs();
      if (isViewmodel) {
        localRail.muzzle = muzzle;
        localRail.muzzleSeenMs = now;
      }
      driver.update(now);
    };
  }

  return {
    group,
    muzzle,
    glow,
    muzzleFlash,
    setCharge(charge: number) {
      if (!driver) return;
      driver.external = true;
      driver.charge = Number.isFinite(charge) ? charge : 1;
    },
    notifyFire() {
      if (!driver) return;
      driver.external = true;
      driver.fire(nowMs());
    },
  };
}

// Third-person gun for a character's hand socket: the low-detail build in the
// same model space (grip at the origin, barrel down -Z, metres — see the
// convention at the top). Parent `.group` to the socket and scale it there.
export function buildThirdPersonRailgun(finish?: RailgunFinish): RailgunModel {
  return buildRailgun(finish, { lod: 'low' });
}

// Discharge flare mesh: one disc facing along the bore (the star) + two crossed
// planes stretched forward (the streaks). All share the flash texture's UVs.
function buildFlareGeometry(): THREE.BufferGeometry {
  const disc = new THREE.PlaneGeometry(0.3, 0.3);
  const jetA = new THREE.PlaneGeometry(0.09, 0.42);
  jetA.rotateX(-Math.PI / 2); // lie along Z
  jetA.translate(0, 0, -0.16);
  const jetB = jetA.clone();
  jetB.rotateZ(Math.PI / 2);
  const g = mergeGeometries([disc, jetA, jetB], false) ?? disc;
  if (g !== disc) disc.dispose();
  jetA.dispose();
  jetB.dispose();
  return g;
}

// Third-person attach. Seats the railgun in the soldier's right hand so it
// tracks the hand through idle/walk/run instead of floating at the hip. The
// hand bone's local frame is offset/rotated, so the constants below were tuned
// to point the barrel down the soldier's forward (-Z) in the idle pose. Falls
// back to a fixed body offset if the rig has no recognisable hand bone. Uses
// the low-detail build (third person); the model-space convention is the one
// documented at the top of this file.
const HAND_BONE_CANDIDATES = ['mixamorig:RightHand', 'RightHand', 'Hand.R', 'mixamorigRightHand'];

export function attachRailgunToSoldier(
  root: THREE.Object3D,
  height = 1.8,
  finish?: RailgunFinish,
): THREE.Group {
  const model = buildThirdPersonRailgun(finish);
  const { group } = model;
  group.userData.railgun = model;

  let hand: THREE.Object3D | null = null;
  for (const name of HAND_BONE_CANDIDATES) {
    hand = root.getObjectByName(name) ?? null;
    if (hand) break;
  }

  if (hand) {
    // soldier.glb's right-hand bone lives in a cm-scaled, rotated local frame
    // (world scale ~0.01). These constants — tuned in that bone space — seat the
    // grip in the palm with the barrel pointing forward and slightly down, a
    // relaxed "railgun at the ready" carry. The gun then tracks the hand through
    // idle/walk/run instead of floating beside the body. localScale 60 → ~0.6
    // world units → a ~0.57 m gun on the 1.8 m soldier.
    group.scale.setScalar(60);
    group.position.set(-2.317, -4.008, 10.329);
    group.rotation.set(2.469, 0.423, -0.021);
    hand.add(group);
  } else {
    // Fallback: park it at the right-hand area on the body root.
    group.scale.setScalar(0.42);
    group.position.set(0.26, height * 0.62, -0.2);
    root.add(group);
  }
  return group;
}

// The soldier's idle/walk/run clips swing the arms freely, so a hand-attached
// gun flails. soldier.glb has no weapon-carry animation, so we pin the arm
// chains to a fixed two-handed "rifle at the ready" pose every frame AFTER the
// mixer runs. The legs + torso keep animating (the locomotion still reads), but
// the upper body holds the gun steady. The RIGHT arm is the model's own
// idle-arm pose — which is what attachRailgunToSoldier's gun transform was
// tuned against, so the barrel keeps pointing forward — and the LEFT arm was
// solved (numeric IK) to bring the support hand onto the gun's foregrip. Skip
// this while the death clip is playing so the ragdoll-ish death still flails.
const HOLD_POSE: ReadonlyArray<{
  names: readonly string[];
  e: [number, number, number];
}> = [
  { names: ['mixamorigRightShoulder', 'mixamorig:RightShoulder', 'RightShoulder', 'Shoulder.R'], e: [0.031, 0.125, 1.679] },
  { names: ['mixamorigRightArm', 'mixamorig:RightArm', 'RightArm', 'Arm.R'], e: [-0.392, -0.069, 1.103] },
  { names: ['mixamorigRightForeArm', 'mixamorig:RightForeArm', 'RightForeArm', 'ForeArm.R'], e: [0.746, 0.042, 0.121] },
  { names: ['mixamorigRightHand', 'mixamorig:RightHand', 'RightHand', 'Hand.R'], e: [0.197, -0.071, 0.241] },
  // Left arm: support hand on the foregrip (solved IK, residual ~3 mm).
  { names: ['mixamorigLeftShoulder', 'mixamorig:LeftShoulder', 'LeftShoulder', 'Shoulder.L'], e: [-3.113, -0.025, -0.198] },
  { names: ['mixamorigLeftArm', 'mixamorig:LeftArm', 'LeftArm', 'Arm.L'], e: [0.263, -0.796, 1.428] },
  { names: ['mixamorigLeftForeArm', 'mixamorig:LeftForeArm', 'LeftForeArm', 'ForeArm.L'], e: [-0.022, 0.123, 0.045] },
  { names: ['mixamorigLeftHand', 'mixamorig:LeftHand', 'LeftHand', 'Hand.L'], e: [0.005, 0.273, -0.202] },
];

function findBone(root: THREE.Object3D, names: readonly string[]): THREE.Object3D | null {
  for (const name of names) {
    const obj = root.getObjectByName(name);
    if (obj) return obj;
  }
  return null;
}

export class WeaponHold {
  private readonly bones: Array<{ obj: THREE.Object3D; e: [number, number, number] }> = [];

  constructor(root: THREE.Object3D) {
    for (const { names, e } of HOLD_POSE) {
      const obj = findBone(root, names);
      if (obj) this.bones.push({ obj, e });
    }
  }

  // Call once per frame, AFTER mixer.update(dt), while the entity is alive.
  apply(): void {
    for (const { obj, e } of this.bones) obj.rotation.set(e[0], e[1], e[2]);
  }
}
