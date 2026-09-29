import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { B, BONE_COUNT, REST_ABS } from './rig';

// ── The arena combatant's body, built in code ────────────────────────────────
//
// Every piece is authored once, in model space at the rest pose (see rig.ts),
// as a small hard-surface solid: convex hulls of chamfered octagon "rings"
// (armour plates, boots, gauntlets), lathes (helmet, pauldrons, collar) and
// tapered tubes (the flexible under-suit). Each piece is rigidly skinned to ONE
// bone, and ALL pieces merge into ONE BufferGeometry shared by every
// character — so a combatant is a single SkinnedMesh (1 draw call, 1 shadow
// draw) with GPU skinning.
//
// Per-vertex attributes carry the look, so one material covers the suit,
// armour, trim and the emissive visor:
//   color  base colour (linear)
//   aMat   x = player-colour tint (0 → base colour, 1 → base × player colour)
//          y = roughness, z = metalness, w = emissive (× the visor colour)
// The material (see createCharacterMaterial) injects those into
// MeshStandardMaterial, plus a fresnel rim in the player colour so the
// silhouette pops against dark walls, and a gib "heat" glow.

type V3 = readonly [number, number, number];

// ── Surface kinds ────────────────────────────────────────────────────────────
type Surface = { color: number; tint: number; rough: number; metal: number; emit: number; edges: boolean };
const S = {
  // Dark flexible under-suit (fabric sheen in the material).
  suit: { color: 0x1a1d23, tint: 0, rough: 0.62, metal: 0.12, emit: 0, edges: false },
  suitDark: { color: 0x101217, tint: 0, rough: 0.5, metal: 0.35, emit: 0, edges: false },
  // Lacquered player-colour plates, and a darker lacquered secondary.
  armor: { color: 0xffffff, tint: 1, rough: 0.34, metal: 0.28, emit: 0, edges: true },
  armorDark: { color: 0x4d4d4d, tint: 1, rough: 0.4, metal: 0.4, emit: 0, edges: true },
  // Machined gunmetal joints/trims.
  trim: { color: 0x3e4552, tint: 0, rough: 0.26, metal: 0.92, emit: 0, edges: true },
  trimDark: { color: 0x1d2128, tint: 0, rough: 0.34, metal: 0.85, emit: 0, edges: true },
  trimLight: { color: 0xc9d0d8, tint: 0, rough: 0.24, metal: 0.7, emit: 0, edges: true },
  visor: { color: 0x0c0c0c, tint: 0, rough: 0.15, metal: 0.0, emit: 1, edges: false },
  light: { color: 0x0c0c0c, tint: 0, rough: 0.3, metal: 0.0, emit: 0.7, edges: false },
} satisfies Record<string, Surface>;

type Part = { bone: number; geo: THREE.BufferGeometry; s: Surface };

// ── Geometry helpers ─────────────────────────────────────────────────────────

// Chamfered-rectangle ring (an octagon) at height y, centred on (cx, cz).
function ring(y: number, hx: number, hz: number, c: number, cx = 0, cz = 0): V3[] {
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

// Vertical-axis ring as above but lying in an arbitrary plane isn't needed —
// limbs are built along Y at rest.

function hull(pts: V3[]): THREE.BufferGeometry {
  return new ConvexGeometry(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
}

// Lofted chamfered block through a list of rings [y, hx, hz, c, cx?, cz?].
function loft(rings: ReadonlyArray<readonly number[]>, extra: V3[] = []): THREE.BufferGeometry {
  const pts: V3[] = [];
  for (const r of rings) pts.push(...ring(r[0], r[1], r[2], r[3], r[4] ?? 0, r[5] ?? 0));
  pts.push(...extra);
  return hull(pts);
}

// Fully chamfered box centred at (x,y,z).
function cbox(x: number, y: number, z: number, w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const cc = Math.min(c, hy * 0.9);
  return loft([
    [y - hy, hx - cc, hz - cc, cc, x, z],
    [y - hy + cc, hx, hz, cc, x, z],
    [y + hy - cc, hx, hz, cc, x, z],
    [y + hy, hx - cc, hz - cc, cc, x, z],
  ]);
}

// Smooth tapered tube (under-suit limb), elliptical by zScale, from y0 down to y1.
function tube(x: number, z: number, y0: number, y1: number, r0: number, r1: number, zScale = 1, seg = 10): THREE.BufferGeometry {
  const h = Math.abs(y0 - y1);
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false);
  g.scale(1, 1, zScale);
  g.translate(x, (y0 + y1) / 2, z);
  return g;
}

function ball(x: number, y: number, z: number, r: number, sy = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 10, 7);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
}

// Lathe from [radius, y] pairs, around the Y axis. phi = 0 points at +Z (the
// character's back); the front (−Z) is phi = π.
function lathe(profile: ReadonlyArray<readonly [number, number]>, seg: number, phiStart = 0, phiLen = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
    phiStart,
    phiLen,
  );
}

// Facet a geometry (flat normals) — hard-surface armour reads crisper.
function facet(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('normal');
  n.computeVertexNormals();
  return n;
}

const mirrorX = new THREE.Matrix4().makeScale(-1, 1, 1);

// Mirror a right-side geometry to the left (flips winding back to CCW).
function mirror(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(mirrorX);
  const pos = m.getAttribute('position') as THREE.BufferAttribute;
  const nor = m.getAttribute('normal') as THREE.BufferAttribute | undefined;
  for (let i = 0; i < pos.count; i += 3) {
    // swap vertex 1 and 2 of each triangle
    for (const attr of [pos, nor]) {
      if (!attr) continue;
      const ax = attr.getX(i + 1);
      const ay = attr.getY(i + 1);
      const az = attr.getZ(i + 1);
      attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
      attr.setXYZ(i + 2, ax, ay, az);
    }
  }
  return m;
}

// ── The parts ────────────────────────────────────────────────────────────────

function buildParts(): Part[] {
  const parts: Part[] = [];
  const add = (bone: number, geo: THREE.BufferGeometry, s: Surface) => parts.push({ bone, geo, s });
  // Right-side pieces are authored once and mirrored for the left.
  const addLR = (boneR: number, boneL: number, geo: THREE.BufferGeometry, s: Surface) => {
    add(boneR, geo, s);
    add(boneL, mirror(geo), s);
  };

  // ── Hips ───────────────────────────────────────────────────────────────────
  add(B.hips, loft([
    [0.84, 0.125, 0.088, 0.045],
    [0.93, 0.158, 0.108, 0.05],
    [1.03, 0.15, 0.102, 0.05],
  ]), S.suit);
  // Belt (gunmetal) with a player-colour buckle plate and a rear pouch.
  add(B.hips, loft([
    [0.962, 0.176, 0.124, 0.056],
    [0.99, 0.182, 0.13, 0.058],
    [1.04, 0.176, 0.124, 0.056],
  ]), S.trim);
  add(B.hips, cbox(0, 1.0, -0.131, 0.1, 0.06, 0.026, 0.012), S.armor);
  add(B.hips, cbox(0, 1.0, -0.145, 0.04, 0.016, 0.006, 0.003), S.light);
  add(B.hips, cbox(0, 0.985, 0.134, 0.16, 0.072, 0.05, 0.015), S.trimDark);
  // Groin guard: a tapered plate hanging off the belt.
  add(B.hips, hull([
    [-0.078, 0.975, -0.121], [0.078, 0.975, -0.121], [-0.078, 0.975, -0.088], [0.078, 0.975, -0.088],
    [-0.036, 0.855, -0.102], [0.036, 0.855, -0.102], [-0.036, 0.865, -0.072], [0.036, 0.865, -0.072],
  ]), S.armorDark);
  // Tassets (hip plates) flaring over the hip joints.
  const tasset = hull([
    ...ring(0.99, 0.032, 0.085, 0.02, 0.176, -0.008),
    ...ring(0.965, 0.036, 0.094, 0.022, 0.185, -0.008),
    ...ring(0.83, 0.028, 0.074, 0.02, 0.207, -0.014),
  ]);
  add(B.hips, tasset, S.armor);
  add(B.hips, mirror(tasset), S.armor);

  // ── Spine (abdomen) ────────────────────────────────────────────────────────
  add(B.spine, loft([
    [1.02, 0.138, 0.096, 0.05],
    [1.12, 0.142, 0.1, 0.05],
    [1.27, 0.16, 0.11, 0.054],
  ]), S.suit);
  // Segmented ab plates.
  add(B.spine, loft([
    [1.055, 0.082, 0.03, 0.015, 0, -0.097],
    [1.105, 0.092, 0.034, 0.016, 0, -0.099],
  ]), S.armorDark);
  add(B.spine, loft([
    [1.12, 0.098, 0.034, 0.016, 0, -0.101],
    [1.175, 0.108, 0.038, 0.018, 0, -0.105],
  ]), S.armorDark);
  // Side ribbing (dark flexible bands).
  add(B.spine, loft([
    [1.09, 0.15, 0.09, 0.04],
    [1.15, 0.156, 0.094, 0.042],
  ]), S.suitDark);

  // ── Chest: cuirass, collar, back pack, pauldron yokes ─────────────────────
  add(B.chest, loft([
    [1.19, 0.15, 0.1, 0.05],
    [1.45, 0.17, 0.11, 0.055],
  ]), S.suit);
  // Cuirass: broad at the shoulders, keel down the sternum (V from above),
  // tapering to the waist.
  add(B.chest, loft(
    [
      [1.2, 0.145, 0.11, 0.05, 0, -0.004],
      [1.29, 0.195, 0.136, 0.062, 0, -0.012],
      [1.39, 0.205, 0.134, 0.064, 0, -0.008],
      [1.466, 0.176, 0.114, 0.06, 0, 0.0],
    ],
    [
      [0, 1.395, -0.164],
      [0, 1.27, -0.16],
      [0, 1.21, -0.128],
    ],
  ), S.armor);
  // Sternum stripe riding the keel (light trim).
  add(B.chest, hull([
    [0, 1.43, -0.154], [0, 1.395, -0.17], [0, 1.27, -0.166], [0, 1.225, -0.14],
    [-0.024, 1.4, -0.162], [0.024, 1.4, -0.162], [-0.024, 1.27, -0.159], [0.024, 1.27, -0.159],
    [-0.02, 1.43, -0.148], [0.02, 1.43, -0.148], [-0.02, 1.23, -0.134], [0.02, 1.23, -0.134],
  ]), S.trimLight);
  // Pectoral lights (restrained emissive slits).
  const pec = hull([
    [0.06, 1.405, -0.153], [0.13, 1.395, -0.141], [0.06, 1.391, -0.154], [0.13, 1.381, -0.142],
    [0.06, 1.405, -0.144], [0.13, 1.395, -0.132], [0.06, 1.391, -0.145], [0.13, 1.381, -0.133],
  ]);
  add(B.chest, pec, S.light);
  add(B.chest, mirror(pec), S.light);
  // Lower cuirass band (dark) — separates chest from abs.
  add(B.chest, loft([
    [1.195, 0.15, 0.114, 0.05, 0, -0.004],
    [1.225, 0.16, 0.122, 0.054, 0, -0.008],
  ]), S.trimDark);
  // Collar / gorget.
  add(B.chest, loft([
    [1.435, 0.135, 0.108, 0.046],
    [1.49, 0.108, 0.092, 0.04],
    [1.52, 0.086, 0.078, 0.034],
  ]), S.trim);
  // Back power pack with two glowing slits.
  add(B.chest, loft([
    [1.23, 0.062, 0.035, 0.018, 0, 0.142],
    [1.27, 0.074, 0.045, 0.02, 0, 0.148],
    [1.42, 0.08, 0.045, 0.02, 0, 0.142],
    [1.455, 0.066, 0.034, 0.018, 0, 0.132],
  ]), S.trimDark);
  add(B.chest, cbox(0.03, 1.34, 0.19, 0.016, 0.13, 0.012, 0.004), S.light);
  add(B.chest, cbox(-0.03, 1.34, 0.19, 0.016, 0.13, 0.012, 0.004), S.light);

  // Pauldrons ride the CLAVICLES (which shrug with the arm), so they stay on
  // top of the shoulder even with the arms overhead. Angular armour caps.
  const paul = hull([
    [0.13, 1.476, -0.072], [0.13, 1.476, 0.072], [0.118, 1.458, 0],
    [0.205, 1.522, -0.086], [0.205, 1.522, 0.086], [0.215, 1.534, 0],
    [0.3, 1.49, -0.092], [0.3, 1.49, 0.092], [0.312, 1.502, 0],
    [0.345, 1.4, -0.086], [0.345, 1.4, 0.086], [0.356, 1.41, 0],
    [0.33, 1.385, -0.07], [0.33, 1.385, 0.07],
    [0.25, 1.44, -0.07], [0.25, 1.44, 0.07],
    [0.15, 1.442, -0.06], [0.15, 1.442, 0.06],
  ]);
  addLR(B.clavicleR, B.clavicleL, paul, S.armor);
  // Light edge stripe along the pauldron's crown.
  addLR(B.clavicleR, B.clavicleL, hull([
    [0.2, 1.527, -0.07], [0.2, 1.527, 0.07], [0.212, 1.54, 0],
    [0.236, 1.52, -0.075], [0.236, 1.52, 0.075], [0.246, 1.531, 0],
    [0.215, 1.515, -0.06], [0.23, 1.512, 0.06],
  ]), S.trimLight);

  // ── Neck ───────────────────────────────────────────────────────────────────
  add(B.neck, tube(0, 0.005, 1.59, 1.46, 0.056, 0.064, 1.05, 10), S.suitDark);

  // ── Head: helmet ───────────────────────────────────────────────────────────
  const zs = 1.13; // helmet is deeper than wide
  const dome = lathe(
    [
      [0.0, 1.794],
      [0.06, 1.79],
      [0.1, 1.772],
      [0.125, 1.742],
      [0.137, 1.708],
      [0.143, 1.686],
      [0.146, 1.68],
      [0.13, 1.677],
      [0.0, 1.677],
    ],
    14,
  );
  dome.scale(1, 1, zs);
  dome.translate(0, 0, 0.006);
  add(B.head, dome, S.armor);
  const jaw = lathe(
    [
      [0.0, 1.683],
      [0.134, 1.683],
      [0.139, 1.655],
      [0.137, 1.625],
      [0.129, 1.595],
      [0.113, 1.568],
      [0.09, 1.552],
      [0.0, 1.55],
    ],
    14,
  );
  jaw.scale(1, 1, zs);
  jaw.translate(0, 0, 0.006);
  add(B.head, jaw, S.trim);
  // Visor band wrapping the front.
  const visor = lathe(
    [
      [0.131, 1.631],
      [0.142, 1.633],
      [0.1462, 1.655],
      [0.143, 1.676],
      [0.131, 1.679],
    ],
    12,
    Math.PI - 1.22,
    2.44,
  );
  visor.scale(1, 1, zs);
  visor.translate(0, 0, 0.006);
  add(B.head, visor, S.visor);
  // Face guard: a chiselled muzzle over the mouth.
  add(B.head, hull([
    [-0.072, 1.628, -0.14], [0.072, 1.628, -0.14],
    [-0.046, 1.562, -0.133], [0.046, 1.562, -0.133],
    [0, 1.572, -0.168], [0, 1.624, -0.172],
    [-0.097, 1.626, -0.086], [0.097, 1.626, -0.086],
    [-0.077, 1.556, -0.07], [0.077, 1.556, -0.07],
  ]), S.armorDark);
  // Vent slits on the face guard.
  add(B.head, cbox(0, 1.6, -0.168, 0.05, 0.008, 0.01, 0.002), S.trimDark);
  add(B.head, cbox(0, 1.585, -0.164, 0.045, 0.008, 0.01, 0.002), S.trimDark);
  // Crest fin (light stripe over the crown).
  add(B.crest, hull([
    [-0.017, 1.77, -0.13], [0.017, 1.77, -0.13],
    [-0.017, 1.788, 0.1], [0.017, 1.788, 0.1],
    [0, 1.791, -0.1], [0, 1.804, -0.02], [0, 1.804, 0.07],
    [-0.017, 1.733, 0.155], [0.017, 1.733, 0.155],
  ]), S.trimLight);
  // Ear pods with a glowing core.
  const pod = new THREE.CylinderGeometry(0.043, 0.047, 0.03, 10);
  pod.rotateZ(Math.PI / 2);
  pod.translate(0.143, 1.632, 0.012);
  add(B.head, facet(pod), S.trim);
  add(B.head, facet(mirror(pod)), S.trim);
  const podLight = new THREE.CylinderGeometry(0.017, 0.017, 0.012, 8);
  podLight.rotateZ(Math.PI / 2);
  podLight.translate(0.159, 1.632, 0.012);
  add(B.head, podLight, S.light);
  add(B.head, mirror(podLight), S.light);

  // ── Arms (authored on the right, mirrored left) ────────────────────────────
  const sx = REST_ABS[B.upperArmR][0];
  addLR(B.upperArmR, B.upperArmL, ball(sx, 1.41, 0, 0.07), S.suitDark);
  addLR(B.upperArmR, B.upperArmL, tube(sx, 0, 1.4, 1.14, 0.064, 0.054, 1.05), S.suit);
  addLR(B.upperArmR, B.upperArmL, tube(sx, 0, 1.29, 1.225, 0.068, 0.065, 1.05), S.trim);
  // Upper-arm plate wrapping the outside + front (reads gestures at range).
  addLR(B.upperArmR, B.upperArmL, loft([
    [1.395, 0.058, 0.064, 0.024, sx + 0.014, -0.006],
    [1.31, 0.06, 0.062, 0.024, sx + 0.016, -0.008],
    [1.245, 0.052, 0.054, 0.02, sx + 0.012, -0.006],
  ]), S.armor);

  // Forearm: elbow ball, elbow guard, bracer, stripe, wrist cuff.
  addLR(B.foreArmR, B.foreArmL, ball(sx, 1.125, 0, 0.058), S.suitDark);
  addLR(B.foreArmR, B.foreArmL, hull([
    ...ring(1.16, 0.046, 0.02, 0.012, sx, 0.046),
    ...ring(1.085, 0.041, 0.018, 0.01, sx, 0.052),
    [sx, 1.12, 0.083],
  ]), S.trim);
  addLR(B.foreArmR, B.foreArmL, loft([
    [1.085, 0.062, 0.061, 0.025, sx, 0],
    [1.0, 0.061, 0.059, 0.025, sx + 0.002, -0.002],
    [0.915, 0.05, 0.05, 0.021, sx, 0],
  ]), S.armor);
  addLR(B.foreArmR, B.foreArmL, loft([
    [1.06, 0.016, 0.046, 0.008, sx + 0.058, -0.002],
    [0.94, 0.015, 0.04, 0.008, sx + 0.05, -0.002],
  ]), S.trimDark);
  addLR(B.foreArmR, B.foreArmL, loft([
    [0.93, 0.054, 0.054, 0.021, sx, 0],
    [0.89, 0.052, 0.052, 0.021, sx, 0],
  ]), S.trimDark);

  // Hand: an armoured mitten — flat palm, fingers curled toward the palm
  // (−X on the right hand), a thumb on the front edge, and a coloured plate
  // on the back of the hand. Reads as an open hand in gestures and still
  // wraps the railgun grip.
  addLR(B.handR, B.handL, loft([
    [0.878, 0.03, 0.04, 0.012, sx, -0.004],
    [0.84, 0.026, 0.05, 0.012, sx - 0.002, -0.008],
    [0.8, 0.022, 0.047, 0.01, sx - 0.004, -0.01],
  ]), S.trimDark);
  addLR(B.handR, B.handL, hull([
    ...ring(0.805, 0.02, 0.045, 0.008, sx - 0.005, -0.01),
    ...ring(0.765, 0.018, 0.042, 0.008, sx - 0.022, -0.012),
    ...ring(0.742, 0.015, 0.036, 0.007, sx - 0.042, -0.012),
  ]), S.trimDark);
  addLR(B.handR, B.handL, loft([
    [0.86, 0.013, 0.015, 0.006, sx - 0.018, -0.046],
    [0.82, 0.012, 0.014, 0.005, sx - 0.03, -0.062],
  ]), S.trimDark);
  addLR(B.handR, B.handL, loft([
    [0.862, 0.008, 0.036, 0.004, sx + 0.026, -0.006],
    [0.815, 0.008, 0.038, 0.004, sx + 0.022, -0.008],
  ]), S.armor);

  // ── Legs ───────────────────────────────────────────────────────────────────
  const hx = REST_ABS[B.thighR][0];
  addLR(B.thighR, B.thighL, ball(hx, 0.92, 0, 0.092), S.suit);
  addLR(B.thighR, B.thighL, tube(hx, 0, 0.93, 0.52, 0.097, 0.07, 1.08, 12), S.suit);
  // Thigh plate (front + outside).
  addLR(B.thighR, B.thighL, loft([
    [0.865, 0.084, 0.058, 0.028, hx + 0.012, -0.043],
    [0.745, 0.08, 0.056, 0.026, hx + 0.012, -0.04],
    [0.615, 0.064, 0.046, 0.022, hx + 0.008, -0.034],
  ]), S.armor);
  // Hamstring plate (back of the thigh) so legs read from behind.
  addLR(B.thighR, B.thighL, loft([
    [0.84, 0.07, 0.04, 0.02, hx + 0.004, 0.05],
    [0.72, 0.068, 0.04, 0.02, hx + 0.004, 0.052],
    [0.63, 0.056, 0.032, 0.016, hx + 0.002, 0.044],
  ]), S.armorDark);
  // Knee.
  addLR(B.shinR, B.shinL, ball(hx, 0.505, 0, 0.07), S.suitDark);
  addLR(B.shinR, B.shinL, hull([
    ...ring(0.578, 0.054, 0.022, 0.012, hx, -0.062),
    ...ring(0.44, 0.048, 0.02, 0.012, hx, -0.062),
    [hx, 0.515, -0.113],
    [hx - 0.032, 0.51, -0.102],
    [hx + 0.032, 0.51, -0.102],
  ]), S.trim);
  addLR(B.shinR, B.shinL, tube(hx, 0.008, 0.5, 0.14, 0.07, 0.054, 1.08, 12), S.suit);
  // Calf guard (back).
  addLR(B.shinR, B.shinL, loft([
    [0.45, 0.056, 0.03, 0.016, hx, 0.045],
    [0.33, 0.058, 0.036, 0.018, hx, 0.05],
    [0.22, 0.046, 0.026, 0.014, hx, 0.035],
  ]), S.armorDark);
  // Greave (shin guard) with a keel.
  addLR(B.shinR, B.shinL, loft(
    [
      [0.44, 0.066, 0.048, 0.024, hx, -0.03],
      [0.3, 0.062, 0.046, 0.022, hx, -0.03],
      [0.19, 0.054, 0.042, 0.02, hx, -0.026],
    ],
    [
      [hx, 0.42, -0.09],
      [hx, 0.22, -0.078],
    ],
  ), S.armor);
  // Heavy boot: wedge shell, toe cap, sole, ankle cuff.
  addLR(B.footR, B.footL, loft([
    [0.018, 0.07, 0.158, 0.032, hx, -0.052],
    [0.078, 0.072, 0.152, 0.036, hx, -0.048],
    [0.155, 0.064, 0.076, 0.03, hx, 0.006],
  ]), S.trim);
  addLR(B.footR, B.footL, loft([
    [0.02, 0.074, 0.064, 0.03, hx, -0.15],
    [0.07, 0.072, 0.056, 0.028, hx, -0.146],
    [0.104, 0.055, 0.032, 0.02, hx, -0.13],
  ]), S.armorDark);
  addLR(B.footR, B.footL, loft([
    [0.0, 0.072, 0.16, 0.032, hx, -0.052],
    [0.024, 0.074, 0.162, 0.032, hx, -0.052],
  ]), S.suitDark);
  addLR(B.footR, B.footL, loft([
    [0.12, 0.07, 0.07, 0.028, hx, 0.005],
    [0.205, 0.066, 0.066, 0.026, hx, 0.005],
  ]), S.trimDark);

  return parts;
}

// ── Merge into one skinned geometry (cached, shared by every character) ─────

export type BodyGeometry = {
  geometry: THREE.BufferGeometry;
  // Per-bone centre of mass of its rigid chunk, in rest model space (gibs spin
  // each chunk about this point). NaN-free: bones without geometry get the
  // bone's rest position.
  com: Float32Array;
  // Per-bone rough chunk radius (floor bounce / flash sizing).
  radius: Float32Array;
  // Which bones carry geometry (i.e. become gib chunks).
  hasGeo: boolean[];
  triangles: number;
};

let cached: BodyGeometry | null = null;

// Hard-edge mask for one flat part (non-indexed). For every triangle, flags
// which of its three edges is a HARD crease (neighbour face bends > ~18°, or
// no neighbour). Component j marks the edge opposite vertex j. Coplanar
// splits and smooth-shaded surfaces stay soft, so the bevel highlight traces
// the machined plate edges only — never the triangulation.
const HARD_COS = Math.cos((18 * Math.PI) / 180);
function hardEdges(pos: THREE.BufferAttribute, nor: THREE.BufferAttribute, out: Float32Array, o: number): void {
  const tris = pos.count / 3;
  const key = (i: number) =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const fn: THREE.Vector3[] = [];
  const smooth: boolean[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    const n = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    fn.push(n);
    // A triangle whose vertex normals disagree is smooth-shaded: no creases.
    const n0 = new THREE.Vector3().fromBufferAttribute(nor, t * 3);
    const n1 = new THREE.Vector3().fromBufferAttribute(nor, t * 3 + 1);
    const n2 = new THREE.Vector3().fromBufferAttribute(nor, t * 3 + 2);
    smooth.push(n0.dot(n1) < 0.999 || n0.dot(n2) < 0.999);
  }
  const edgeMap = new Map<string, number[]>();
  const ek = (i: number, j: number) => {
    const ka = key(i);
    const kb = key(j);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let t = 0; t < tris; t++) {
    for (let j = 0; j < 3; j++) {
      const k = ek(t * 3 + ((j + 1) % 3), t * 3 + ((j + 2) % 3));
      const list = edgeMap.get(k);
      if (list) list.push(t);
      else edgeMap.set(k, [t]);
    }
  }
  for (let t = 0; t < tris; t++) {
    for (let j = 0; j < 3; j++) {
      let hard = 0;
      if (!smooth[t]) {
        const list = edgeMap.get(ek(t * 3 + ((j + 1) % 3), t * 3 + ((j + 2) % 3))) ?? [];
        let neighbour = -1;
        for (const u of list) if (u !== t) neighbour = u;
        hard = neighbour < 0 || fn[t].dot(fn[neighbour]) < HARD_COS ? 1 : 0;
      }
      for (let v = 0; v < 3; v++) out[(o + t * 3 + v) * 3 + j] = hard;
    }
  }
}

export function getBodyGeometry(): BodyGeometry {
  if (cached) return cached;
  const parts = buildParts();
  let total = 0;
  const flat: { p: Part; pos: THREE.BufferAttribute; nor: THREE.BufferAttribute }[] = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    flat.push({ p, pos, nor });
    total += pos.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const mat = new Float32Array(total * 4);
  const edge = new Float32Array(total * 3);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const comSum = new Float64Array(BONE_COUNT * 3);
  const comN = new Float64Array(BONE_COUNT);
  const c = new THREE.Color();
  let o = 0;
  for (const { p, pos, nor } of flat) {
    c.setHex(p.s.color); // sRGB hex → linear working colour
    // Creases only on hard-surface kinds (armour, trim) — not the suit/visor.
    if (p.s.edges) hardEdges(pos, nor, edge, o);
    for (let i = 0; i < pos.count; i++, o++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      position[o * 3] = x;
      position[o * 3 + 1] = y;
      position[o * 3 + 2] = z;
      normal[o * 3] = nor.getX(i);
      normal[o * 3 + 1] = nor.getY(i);
      normal[o * 3 + 2] = nor.getZ(i);
      color[o * 3] = c.r;
      color[o * 3 + 1] = c.g;
      color[o * 3 + 2] = c.b;
      mat[o * 4] = p.s.tint;
      mat[o * 4 + 1] = p.s.rough;
      mat[o * 4 + 2] = p.s.metal;
      mat[o * 4 + 3] = p.s.emit;
      skinIndex[o * 4] = p.bone;
      skinWeight[o * 4] = 1;
      comSum[p.bone * 3] += x;
      comSum[p.bone * 3 + 1] += y;
      comSum[p.bone * 3 + 2] += z;
      comN[p.bone] += 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  // Generous static bounds (animation + emotes stay well inside).
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 1.6);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1.2, -0.2, -1.2), new THREE.Vector3(1.2, 2.6, 1.2));

  const com = new Float32Array(BONE_COUNT * 3);
  const radius = new Float32Array(BONE_COUNT);
  const hasGeo: boolean[] = [];
  for (let b = 0; b < BONE_COUNT; b++) {
    hasGeo.push(comN[b] > 0);
    for (let k = 0; k < 3; k++) com[b * 3 + k] = comN[b] > 0 ? comSum[b * 3 + k] / comN[b] : REST_ABS[b][k];
  }
  // Radius: max vertex distance from the chunk COM (cheap, once).
  for (let i = 0; i < total; i++) {
    const b = skinIndex[i * 4];
    const dx = position[i * 3] - com[b * 3];
    const dy = position[i * 3 + 1] - com[b * 3 + 1];
    const dz = position[i * 3 + 2] - com[b * 3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > radius[b]) radius[b] = d;
  }
  for (const f of flat) f.p.geo.dispose();
  cached = { geometry, com, radius, hasGeo, triangles: total / 3 };
  return cached;
}

// ── Material ────────────────────────────────────────────────────────────────
//
// One MeshPhysicalMaterial per character, driven by the per-vertex channels:
//   • painted armour (aMat.x = tint): player colour, clear-coat lacquer over
//     a semi-metallic paint → sharp highlights per plate;
//   • gunmetal trim: high metalness, no coat;
//   • under-suit: dark, rough, with a fabric sheen;
//   • hard plate edges (aEdge + barycentrics derived from gl_VertexID): a thin
//     bright bevel catch-light up close, so facets read as machined plates;
//   • visor (aMat.w = 1): a hot white core fading to a saturated player-colour
//     edge across the band; light slits glow in the player colour;
//   • a player-colour fresnel rim + an emissive lift for readability — the
//     same treatment for everyone;
//   • gib state: charred albedo (uBurn) and hot glowing seams (uGlow/uGlowCol);
//   • finisher looks (death animations only, all behind uniform branches so
//     a living body pays nothing): noise dissolve with a glowing front, ash,
//     a rising char line, glassy crystal, derez bands that slide + blink out,
//     crawling overload veins and per-chunk rainbow seams.

export type CharacterUniforms = {
  uPlayer: { value: THREE.Color };
  uVisorCore: { value: THREE.Color };
  uVisorEdge: { value: THREE.Color };
  uRim: { value: THREE.Color };
  uLift: { value: number };
  uRimStr: { value: number };
  uGlow: { value: number };
  uGlowCol: { value: THREE.Color };
  uBurn: { value: number };
  // ── Finisher looks (death animations, gibs.ts). All zero / off when alive. ──
  uFxTime: { value: number }; // seconds since the death began (animated noise)
  uFxCalm: { value: number }; // 1 = reduced effects: no blinking / strobing
  // Noise dissolve: fragments whose key < uDissolve are gone; a glowing rim
  // (uEdgeCol) runs along the front. uDissolveH biases the key by height
  // (+ top first, − bottom first; 0 = pure noise).
  uDissolve: { value: number };
  uDissolveH: { value: number };
  uEdgeCol: { value: THREE.Color };
  uAsh: { value: number }; // flash-burnt ash: near-black, cracks glow uEdgeCol
  uCharLine: { value: number }; // pyre: char front height (m, rest space); < −1 = off
  uCrystal: { value: number }; // glassy crystal armour (shatter)
  uCrystalCol: { value: THREE.Color };
  // Derez: x = band height (0 = off), y = slide progress 0..1.
  uBands: { value: THREE.Vector2 };
  uBandDir: { value: THREE.Vector3 }; // slide axis (mesh-local = the body's parent space)
  uBandT: { value: Float32Array }; // per-band blink-out time (s)
  uBandO: { value: Float32Array }; // per-band signed slide distance (m)
  uArc: { value: number }; // overload: crawling surface lightning
  uArcCol: { value: THREE.Color };
  uRainbow: { value: number }; // prism: per-chunk rainbow seam glow
  uFlash: { value: THREE.Color }; // whole-body emissive flash (the frag's white-hot beat)
  // Fairness: after 0.5 s nothing on a dying body glows above this world
  // height (the victim's knee), so no emissive debris hangs on the crosshair line.
  uKneeY: { value: number };
  // Directional dissolve (vaporize's ash sheet): xyz = wind in rest model
  // space, w = weight of the directional term vs noise (0 = off).
  uDissolveDir: { value: THREE.Vector4 };
  // ── Dye (dyes.ts). x = pattern (0 = plain uPlayer tint), y = speed, z = scale.
  uDyeP: { value: THREE.Vector4 };
  uDyeF: { value: THREE.Vector2 }; // finish override (roughness, metalness); −1 = keep
  uDyeA: { value: THREE.Color };
  uDyeB: { value: THREE.Color };
  uDyeC: { value: THREE.Color };
  uDyeTime: { value: number }; // SHARED by every character (DYE_TIME)
  uDyeCalm: { value: number }; // SHARED (DYE_CALM): 1 = reduced effects — slow, no flicker
};

// Dye pattern → shader mode (0 = the plain tint path; solids never branch).
export const DYE_MODE = {
  solid: 0,
  gradient: 1,
  stripes: 2,
  chrome: 3,
  pearl: 4,
  chroma: 5,
  magma: 6,
  hologram: 7,
  aurora: 8,
  circuit: 9,
  spectre: 10,
  void: 11,
  nebula: 12,
  horizon: 13,
} as const;

// One clock for every animated dye, advanced as bodies render (wall time, so
// it is frame-rate independent and identical for everyone on screen).
export const DYE_TIME = { value: 0 };
export const DYE_CALM = { value: 0 };
export function setDyeCalm(on: boolean): void {
  DYE_CALM.value = on ? 1 : 0;
}
let dyeClockAt = -1;
export function tickDyeClock(): void {
  const now = performance.now();
  if (now === dyeClockAt) return;
  dyeClockAt = now;
  DYE_TIME.value = (now / 1000) % 3600;
}

export const DEREZ_BANDS = 24;
const VISOR_Y = 1.656; // rest-space centre of the visor band
const VISOR_HALF = 0.023;

// Cheap 3-D value noise (fragment only, behind uniform branches).
const NOISE_GLSL = `
float igHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float igNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(igHash(i), igHash(i + vec3(1, 0, 0)), f.x), mix(igHash(i + vec3(0, 1, 0)), igHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(igHash(i + vec3(0, 0, 1)), igHash(i + vec3(1, 0, 1)), f.x), mix(igHash(i + vec3(0, 1, 1)), igHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

// Defined once at module scope so every character material hashes to the same
// compiled program (three keys custom programs on onBeforeCompile's source).
function injectCharacterShader(this: THREE.MeshPhysicalMaterial, shader: THREE.WebGLProgramParametersWithUniforms) {
  const u = (this.userData as { charUniforms: CharacterUniforms }).charUniforms;
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      [
        '#include <common>',
        'attribute vec4 aMat;',
        'attribute vec3 aEdge;',
        'varying vec4 vMat;',
        'varying vec3 vEdge;',
        'varying vec3 vBary;',
        'varying vec3 vRest;',
        'varying float vBone;',
        'varying float vIgWorldY;',
        'uniform vec2 uBands;',
        'uniform vec3 uBandDir;',
        `uniform float uBandO[${DEREZ_BANDS}];`,
      ].join('\n'),
    )
    .replace(
      '#include <begin_vertex>',
      [
        '#include <begin_vertex>',
        'vMat = aMat;',
        'vEdge = aEdge;',
        'vRest = position;',
        'vBone = skinIndex.x;',
        'int igK = gl_VertexID % 3;',
        'vBary = vec3(igK == 0 ? 1.0 : 0.0, igK == 1 ? 1.0 : 0.0, igK == 2 ? 1.0 : 0.0);',
      ].join('\n'),
    )
    .replace(
      '#include <skinning_vertex>',
      [
        '#include <skinning_vertex>',
        // Derez: horizontal bands slide apart along the body's side axis.
        'if (uBands.x > 0.0) {',
        `  int igB = clamp(int(floor(vRest.y / uBands.x)), 0, ${DEREZ_BANDS - 1});`,
        '  transformed += uBandDir * uBandO[igB] * uBands.y;',
        '}',
        'vIgWorldY = (modelMatrix * vec4(transformed, 1.0)).y;',
      ].join('\n'),
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      [
        '#include <common>',
        'varying vec4 vMat;',
        'varying vec3 vEdge;',
        'varying vec3 vBary;',
        'varying vec3 vRest;',
        'varying float vBone;',
        'varying float vIgWorldY;',
        'uniform float uKneeY;',
        'uniform vec4 uDissolveDir;',
        'uniform vec3 uPlayer;',
        'uniform vec3 uVisorCore;',
        'uniform vec3 uVisorEdge;',
        'uniform vec3 uRim;',
        'uniform float uLift;',
        'uniform float uRimStr;',
        'uniform float uGlow;',
        'uniform vec3 uGlowCol;',
        'uniform float uBurn;',
        'uniform float uFxTime;',
        'uniform float uFxCalm;',
        'uniform float uDissolve;',
        'uniform float uDissolveH;',
        'uniform vec3 uEdgeCol;',
        'uniform float uAsh;',
        'uniform float uCharLine;',
        'uniform float uCrystal;',
        'uniform vec3 uCrystalCol;',
        'uniform vec2 uBands;',
        `uniform float uBandT[${DEREZ_BANDS}];`,
        'uniform float uArc;',
        'uniform vec3 uArcCol;',
        'uniform float uRainbow;',
        'uniform vec3 uFlash;',
        'uniform vec4 uDyeP;',
        'uniform vec2 uDyeF;',
        'uniform vec3 uDyeA;',
        'uniform vec3 uDyeB;',
        'uniform vec3 uDyeC;',
        'uniform float uDyeTime;',
        'uniform float uDyeCalm;',
        NOISE_GLSL,
        'vec3 igHue3(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }',
      ].join('\n'),
    )
    .replace(
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        // ── Finisher: dissolve / derez blink (discard first, cheap exit) ──
        'float igCut = 0.0;',
        'if (uDissolve > 0.0) {',
        '  float igN = igNoise(vRest * 9.0) * 0.65 + igNoise(vRest * 23.0) * 0.35;',
        '  float igH = clamp(vRest.y / 1.85, 0.0, 1.0);',
        '  float igHb = uDissolveH >= 0.0 ? 1.0 - igH : igH;',
        '  float igKey = mix(igN, igHb * 0.8 + igN * 0.2, abs(uDissolveH));',
        // Wind sheet: the upwind side goes first, the front sweeps downwind.
        '  if (uDissolveDir.w > 0.0) igKey = mix(igKey, clamp(0.5 + dot(vRest - vec3(0.0, 1.0, 0.0), uDissolveDir.xyz) / 0.7, 0.0, 1.0) * 0.85 + igN * 0.15, uDissolveDir.w);',
        '  if (igKey < uDissolve) discard;',
        '  igCut = 1.0 - smoothstep(0.0, 0.07, igKey - uDissolve);',
        '}',
        'float igBandGlow = 0.0;',
        'if (uBands.x > 0.0) {',
        `  int igB = clamp(int(floor(vRest.y / uBands.x)), 0, ${DEREZ_BANDS - 1});`,
        '  float igTt = uFxTime - uBandT[igB];',
        '  if (igTt > 0.1) discard;',
        '  if (igTt > 0.0 && uFxCalm < 0.5 && fract(igTt * 30.0) < 0.5) discard;',
        '  float igBy = fract(vRest.y / uBands.x);',
        '  igBandGlow = 1.0 - smoothstep(0.0, 0.035, min(igBy, 1.0 - igBy));',
        '  if (igTt > 0.0) igBandGlow += 0.4;',
        '}',
        // Pyre char front / vaporize ash → one local "ash" amount.
        'float igAsh = uAsh;',
        'float igFront = 0.0;',
        'if (uCharLine > -1.0) {',
        '  float igL = vRest.y + (igNoise(vRest * 11.0) - 0.5) * 0.14;',
        '  igAsh = max(igAsh, 1.0 - smoothstep(uCharLine - 0.05, uCharLine + 0.02, igL));',
        '  igFront = 1.0 - smoothstep(0.0, 0.07, abs(igL - uCharLine));',
        '}',
        // Crease distance: only hard edges count (soft edges → 1).
        'vec3 igD = mix(vec3(1.0), vBary, vEdge);',
        'float igM = min(min(igD.x, igD.y), igD.z);',
        'float igW = max(fwidth(igM), 1e-4);',
        'float igEdgeRaw = 1.0 - smoothstep(igW * 0.6, igW * 1.8, igM);',
        // Bevel catch-light fades out with distance (sub-pixel noise at range).
        'float igEdge = igEdgeRaw * (1.0 - smoothstep(6.0, 14.0, length(vViewPosition)));',
        // ── Dye: the armour tint (uPlayer for plain skins / solid dyes), or a
        // pattern keyed by uDyeP.x. Patterns ride rest space, so they stick to
        // the plates like a texture. igDyeBody > 0 spreads the look over the
        // under-suit too (void / spectre / magma / nebula / horizon).
        'vec3 igTint = uPlayer * 1.12;',
        'float igDM = uDyeP.x;',
        'float igDT = uDyeTime * uDyeP.y * (1.0 - 0.85 * uDyeCalm);',
        'float igDY = clamp(vRest.y / 1.85, 0.0, 1.0);',
        'float igDyeRough = uDyeF.x;',
        'float igDyeMetal = uDyeF.y;',
        'float igDyeBody = 0.0;',
        'float igDN = 0.0;',
        'if (igDM > 0.5) {',
        '  if (igDM < 1.5) igTint = mix(uDyeA, uDyeB, smoothstep(0.12, 0.92, igDY)) * 1.08;',
        '  else if (igDM < 2.5) igTint = mix(uDyeA, uDyeB, step(0.5, fract((vRest.y + vRest.x * 0.8 + vRest.z * 0.3) * uDyeP.z))) * 1.08;',
        '  else if (igDM < 3.5) { igTint = uDyeA; igDyeRough = 0.07; igDyeMetal = 1.0; }',
        '  else if (igDM < 4.5) { igTint = uDyeA; igDyeRough = 0.2; igDyeMetal = 0.3; }',
        '  else if (igDM < 5.5) igTint = igHue3(fract(igDY * 0.9 - igDT * 0.3 + vRest.x * 0.25)) * 1.05 + 0.05;',
        '  else if (igDM < 6.5) {',
        '    float igMn = igNoise(vRest * 7.0 + vec3(0.0, -igDT * 0.35, igDT * 0.1)) * 0.7 + igNoise(vRest * 15.0 - vec3(igDT * 0.2, 0.0, 0.0)) * 0.3;',
        '    igDN = 1.0 - smoothstep(0.0, 0.08, abs(igMn - 0.5));',
        '    igTint = mix(vec3(0.075, 0.05, 0.04), uDyeA * 0.7, igDN);',
        '    igDyeRough = 0.8; igDyeMetal = 0.0; igDyeBody = 0.7;',
        '  }',
        '  else if (igDM < 7.5) { igTint = uDyeA * 0.14; igDyeRough = 0.18; igDyeMetal = 0.0; }',
        '  else if (igDM < 8.5) {',
        '    float igAn = igNoise(vRest * 2.2 + vec3(igDT * 0.15, 0.0, igDT * 0.1));',
        '    igDN = 0.5 + 0.5 * sin(vRest.y * 5.0 + igAn * 5.0 - igDT * 0.9 + vRest.x * 2.0);',
        '    igTint = mix(mix(uDyeB, uDyeA, igDN), uDyeC, smoothstep(0.58, 0.95, igAn));',
        '  }',
        '  else if (igDM < 9.5) {',
        '    vec3 igG = abs(fract(vRest * 13.0) - 0.5);',
        '    float igLine = 1.0 - smoothstep(0.035, 0.07, min(min(igG.x, igG.y), igG.z));',
        '    float igPulse = fract(vRest.y * 1.3 - igDT * 0.55 + igHash(floor(vRest * 13.0)));',
        '    igDN = igLine * (0.3 + 0.7 * smoothstep(0.8, 1.0, igPulse));',
        '    igTint = mix(uDyeA, uDyeB * 0.8, igLine * 0.5);',
        '    igDyeRough = 0.3; igDyeMetal = 0.5;',
        '  }',
        '  else if (igDM < 10.5) { igTint = uDyeA * 0.1; igDyeBody = 1.0; igDyeRough = 0.5; igDyeMetal = 0.0; }',
        '  else if (igDM < 11.5) { igTint = vec3(0.012); igDyeBody = 1.0; igDyeRough = 0.95; igDyeMetal = 0.0; }',
        '  else if (igDM < 12.5) {',
        '    float igN1 = igNoise(vRest * 3.0 + vec3(igDT * 0.05, igDT * 0.03, 0.0));',
        '    float igN2 = igNoise(vRest * 5.0 - vec3(0.0, igDT * 0.04, igDT * 0.05));',
        '    igTint = uDyeA + uDyeB * smoothstep(0.45, 0.85, igN1) * 0.8 + uDyeC * smoothstep(0.5, 0.9, igN2) * 0.7;',
        '    igDyeBody = 0.6; igDyeRough = 0.45; igDyeMetal = 0.1;',
        '  }',
        '  else { igTint = vec3(0.015); igDyeBody = 1.0; igDyeRough = 0.9; igDyeMetal = 0.0; }',
        '}',
        'diffuseColor.rgb *= mix(vec3(1.0), igTint, vMat.x);',
        'if (igDyeBody > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, igTint, igDyeBody * (1.0 - vMat.x) * (1.0 - step(0.01, vMat.w)));',
        'float igDyeW = max(vMat.x, igDyeBody * (1.0 - step(0.01, vMat.w)));',
        'float igRough0 = igDyeRough >= 0.0 ? mix(vMat.y, igDyeRough, igDyeW) : vMat.y;',
        'float igMetal0 = igDyeMetal >= 0.0 ? mix(vMat.z, igDyeMetal, igDyeW) : vMat.z;',
        'diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * 1.7 + 0.1, vec3(1.0)), igEdge * 0.65);',
        // Gibs: the plates char as they burst.
        'diffuseColor.rgb *= 1.0 - 0.72 * uBurn;',
        // Finisher albedo: ash, crystal, derez (Tron-dark).
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.032, 0.03), igAsh);',
        'diffuseColor.rgb = mix(diffuseColor.rgb, uCrystalCol * 0.18, uCrystal);',
        'if (uBands.x > 0.0) diffuseColor.rgb *= 0.12;',
      ].join('\n'),
    )
    .replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = clamp(mix(igRough0 - igEdge * 0.15 + uBurn * 0.3 + igAsh * 0.6, 0.06, uCrystal), 0.05, 1.0);',
    )
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = igMetal0 * (1.0 - 0.5 * uBurn) * (1.0 - igAsh) * (1.0 - uCrystal);')
    .replace(
      '#include <lights_physical_fragment>',
      [
        '#include <lights_physical_fragment>',
        // Lacquer only on the painted plates; fabric sheen only on the suit.
        '#ifdef USE_CLEARCOAT',
        // Matte dyes (and the void) drop the lacquer.
        'material.clearcoat = max(material.clearcoat * vMat.x * (1.0 - uBurn) * (1.0 - igAsh) * (1.0 - step(0.7, igRough0) * igDyeW), uCrystal);',
        '#endif',
        '#ifdef USE_SHEEN',
        'material.sheenColor *= (1.0 - vMat.x) * (1.0 - step(0.5, vMat.z)) * (1.0 - step(0.01, vMat.w)) * (1.0 - igAsh) * (1.0 - igDyeBody);',
        '#endif',
      ].join('\n'),
    )
    .replace(
      '#include <lights_fragment_end>',
      [
        '#include <lights_fragment_end>',
        // Cap direct specular: flat-shaded facets mirror a grazing sun / rim
        // light across the whole face at once, and that peak bloomed into white
        // blobs on the armour. Emissive (visor, lights) is unaffected.
        'reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(0.9));',
        '#ifdef USE_CLEARCOAT',
        'clearcoatSpecularDirect = min(clearcoatSpecularDirect, vec3(0.6));',
        '#endif',
      ].join('\n'),
    )
    .replace(
      '#include <emissivemap_fragment>',
      [
        '#include <emissivemap_fragment>',
        // Visor: hot core → coloured edge across the band; slits: player colour.
        `float igVy = clamp(abs(vRest.y - ${VISOR_Y.toFixed(3)}) / ${VISOR_HALF.toFixed(3)}, 0.0, 1.0);`,
        'float igCore = 1.0 - smoothstep(0.08, 0.6, igVy);',
        'vec3 igVisor = mix(uVisorEdge * (1.0 - 0.45 * igVy * igVy), uVisorCore, igCore);',
        'float igIsVisor = step(0.95, vMat.w);',
        'float igAlive = (1.0 - igAsh) * (1.0 - 0.7 * uCrystal) * (1.0 - 0.85 * uBurn);',
        'totalEmissiveRadiance += (igIsVisor * igVisor + (1.0 - igIsVisor) * uVisorEdge * vMat.w * 0.8) * igAlive;',
        'totalEmissiveRadiance += min(igTint * 0.893, vec3(1.0)) * (vMat.x * uLift) * igAlive;',
        'float igFres = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);',
        'float igRim = igFres * igFres * (0.4 + 0.6 * igFres);',
        'totalEmissiveRadiance += uRim * (igRim * uRimStr * (0.55 + 0.45 * igDyeW) * (1.0 - uBurn) * igAlive);',
        // Dye glow. The dark patterns carry their own bright silhouette here
        // (fairness: a dye may never be harder to see than a natural skin).
        'if (igDM > 2.5) {',
        '  vec3 igDE = vec3(0.0);',
        '  float igFr2 = igFres * igFres;',
        '  if (igDM < 3.5) igDE = uDyeA * (smoothstep(0.05, 0.55, normal.y) * 0.32 + smoothstep(-0.2, -0.7, normal.y) * 0.05 + pow(igFres, 3.0) * 0.5) * vMat.x;',
        '  else if (igDM < 4.5) igDE = igHue3(fract(igFres * 1.6 + vRest.y * 0.35 + normal.y * 0.3)) * (0.12 + igFres * 0.9) * vMat.x;',
        '  else if (igDM < 5.5) igDE = igTint * 0.3 * vMat.x;',
        '  else if (igDM < 6.5) igDE = (mix(uDyeA, uDyeB, igDN * (0.6 + 0.4 * sin(igDT * 2.6 + vRest.y * 4.0))) * igDN * 2.0 + uDyeA * (0.05 + igFr2 * 0.9)) * igDyeW;',
        '  else if (igDM < 7.5) {',
        '    float igScan = pow(0.5 + 0.5 * sin(vRest.y * 150.0 - igDT * 7.0), 6.0);',
        '    float igFlick = uDyeCalm > 0.5 ? 1.0 : 0.9 + 0.1 * step(0.35, fract(sin(floor(igDT * 11.0)) * 43758.5453));',
        '    igDE = uDyeA * (igFres * 1.5 + igScan * 0.55 + 0.2) * igFlick * vMat.x;',
        '  }',
        '  else if (igDM < 8.5) igDE = igTint * (0.16 + 0.22 * igDN) * vMat.x;',
        '  else if (igDM < 9.5) igDE = uDyeB * (igDN * 1.7 + 0.06 + igFr2 * 0.6) * vMat.x;',
        '  else if (igDM < 10.5) {',
        '    float igWisp = igNoise(vRest * vec3(6.0, 3.0, 6.0) - vec3(0.0, igDT * 0.9, 0.0));',
        '    igDE = uDyeA * (pow(igFres, 3.0) * 2.4 + smoothstep(0.5, 0.85, igWisp) * 0.6 + 0.07) * igDyeW;',
        '  }',
        '  else if (igDM < 11.5) igDE = uDyeB * (igFr2 * igFr2 * 1.8 + igEdgeRaw * 0.3) * igDyeW;',
        '  else if (igDM < 12.5) {',
        '    vec3 igSc = floor(vRest * 55.0);',
        '    float igStar = step(0.972, igHash(igSc)) * (0.5 + 0.5 * sin(igDT * 3.0 + igHash(igSc + 7.0) * 40.0));',
        '    igDE = (vec3(1.4) * igStar + igTint * 0.24 + (uDyeB + uDyeC) * 0.5 * igFr2 * 1.2) * igDyeW;',
        '  }',
        '  else {',
        '    float igAng = atan(vRest.x, vRest.z);',
        '    float igRing = smoothstep(0.55, 1.0, sin(igAng * 2.0 + vRest.y * 7.0 - igDT * 2.2));',
        '    vec3 igPr = igHue3(fract(igAng * 0.159 + vRest.y * 0.4 - igDT * 0.25));',
        '    igDE = (igPr * igRing * 1.2 + igPr * igFr2 * igFr2 * 1.8 + uDyeA * igEdgeRaw * 0.15) * igDyeW;',
        '  }',
        '  totalEmissiveRadiance += igDE * igAlive;',
        '}',
        // Gib heat: glowing seams + silhouette, suit (the inside) smoulders.
        // Prism swaps the glow colour for a per-chunk rainbow.
        'vec3 igGlowCol = uGlowCol;',
        'if (uRainbow > 0.0) {',
        '  vec3 igHue = 0.5 + 0.5 * cos(6.2831853 * (vBone * 0.137 + uFxTime * 0.9 + vec3(0.0, 0.33, 0.67)));',
        '  igGlowCol = mix(uGlowCol, igHue * 1.8, uRainbow);',
        '}',
        'float igKneeCut = uFxTime > 0.0 ? 1.0 - smoothstep(0.34, 0.5, uFxTime) * smoothstep(uKneeY - 0.05, uKneeY + 0.12, vIgWorldY) : 1.0;',
        'totalEmissiveRadiance += igGlowCol * uGlow * igKneeCut * (igEdgeRaw * 1.1 + igFres * igFres * 1.6 + 0.22 * (1.0 - vMat.x));',
        // Finisher emission — above the knee it is all gone after 0.5 s.
        'vec3 igFinEm = uFlash;',
        'if (igCut > 0.0) igFinEm += uEdgeCol * igCut * 2.2;',
        'if (igAsh > 0.0) {',
        '  float igCr = 1.0 - smoothstep(0.0, 0.035, abs(igNoise(vRest * 17.0) - 0.5));',
        '  igFinEm += uEdgeCol * igAsh * (igCr * 1.1 + igEdgeRaw * 0.2);',
        '}',
        'igFinEm += uEdgeCol * igFront * 2.6;',
        'if (uCrystal > 0.0) igFinEm += uCrystalCol * uCrystal * (igFres * igFres * 1.9 + igEdgeRaw * 1.7 + 0.05);',
        'if (uBands.x > 0.0) {',
        '  float igScan = pow(0.5 + 0.5 * sin(vRest.y * 190.0), 14.0);',
        '  igFinEm += uEdgeCol * (igEdgeRaw * 0.6 + igBandGlow * 1.6 + igScan * 0.15 + igFres * 0.3 + 0.06);',
        '}',
        // A dying body close to the camera: its glow backs off (a point-blank
        // frag must never swamp the view).
        'if (uFxTime > 0.0) totalEmissiveRadiance *= 0.3 + 0.7 * smoothstep(0.5, 2.2, length(vViewPosition));',
        'if (uArc > 0.0) {',
        '  float igA = igNoise(vRest * 7.0 + vec3(0.0, uFxTime * 6.0, uFxTime * 2.0));',
        '  float igA2 = igNoise(vRest * 13.0 - vec3(uFxTime * 5.0, 0.0, 0.0));',
        // uArc > 1 widens the lines (glass cracks), intensity caps at 1.
        '  float igVw = max(1.0, uArc);',
        '  float igVein = (1.0 - smoothstep(0.0, 0.045 * igVw, abs(igA - 0.5))) + 0.6 * (1.0 - smoothstep(0.0, 0.03 * igVw, abs(igA2 - 0.5)));',
        '  igFinEm += uArcCol * igVein * min(uArc, 1.0);',
        '}',
        'if (uFxTime > 0.0) {',
        '  float igLate = smoothstep(0.34, 0.5, uFxTime);',
        '  float igHigh = smoothstep(uKneeY - 0.05, uKneeY + 0.12, vIgWorldY);',
        '  igFinEm *= 1.0 - igLate * igHigh;',
        '}',
        'totalEmissiveRadiance += igFinEm;',
      ].join('\n'),
    );
}

export function createCharacterMaterial(): { material: THREE.MeshPhysicalMaterial; uniforms: CharacterUniforms } {
  const uniforms: CharacterUniforms = {
    uPlayer: { value: new THREE.Color(1, 0.4, 0.2) },
    uVisorCore: { value: new THREE.Color(1, 0.9, 0.8) },
    uVisorEdge: { value: new THREE.Color(1, 0.5, 0.3) },
    uRim: { value: new THREE.Color(1, 0.5, 0.3) },
    uLift: { value: 0.2 },
    uRimStr: { value: 1 },
    uGlow: { value: 0 },
    uGlowCol: { value: new THREE.Color(1, 1, 1) },
    uBurn: { value: 0 },
    uFxTime: { value: 0 },
    uFxCalm: { value: 0 },
    uDissolve: { value: 0 },
    uDissolveH: { value: 0 },
    uEdgeCol: { value: new THREE.Color(0, 0, 0) },
    uAsh: { value: 0 },
    uCharLine: { value: -2 },
    uCrystal: { value: 0 },
    uCrystalCol: { value: new THREE.Color(0.8, 0.9, 1) },
    uBands: { value: new THREE.Vector2(0, 0) },
    uBandDir: { value: new THREE.Vector3(1, 0, 0) },
    uBandT: { value: new Float32Array(DEREZ_BANDS) },
    uBandO: { value: new Float32Array(DEREZ_BANDS) },
    uArc: { value: 0 },
    uArcCol: { value: new THREE.Color(0.6, 0.8, 1) },
    uRainbow: { value: 0 },
    uFlash: { value: new THREE.Color(0, 0, 0) },
    uKneeY: { value: -1e4 },
    uDissolveDir: { value: new THREE.Vector4(0, 0, 0, 0) },
    uDyeP: { value: new THREE.Vector4(0, 1, 1, 0) },
    uDyeF: { value: new THREE.Vector2(-1, -1) },
    uDyeA: { value: new THREE.Color(1, 1, 1) },
    uDyeB: { value: new THREE.Color(1, 1, 1) },
    uDyeC: { value: new THREE.Color(1, 1, 1) },
    uDyeTime: DYE_TIME,
    uDyeCalm: DYE_CALM,
  };
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.1,
    clearcoat: 0.55,
    // Satin lacquer: at 0.2 the clearcoat peak bloomed into white blobs under a
    // grazing sun / rim light (the "flash on the chest" on players).
    clearcoatRoughness: 0.38,
    sheen: 1,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(0x5a6272),
  });
  material.userData.charUniforms = uniforms;
  material.onBeforeCompile = injectCharacterShader;
  return { material, uniforms };
}

// Reset every finisher uniform to "alive".
export function resetDeathLook(u: CharacterUniforms): void {
  u.uGlow.value = 0;
  u.uBurn.value = 0;
  u.uFxTime.value = 0;
  u.uFxCalm.value = 0;
  u.uDissolve.value = 0;
  u.uDissolveH.value = 0;
  u.uEdgeCol.value.setRGB(0, 0, 0);
  u.uAsh.value = 0;
  u.uCharLine.value = -2;
  u.uCrystal.value = 0;
  u.uBands.value.set(0, 0);
  u.uArc.value = 0;
  u.uRainbow.value = 0;
  u.uFlash.value.setRGB(0, 0, 0);
  u.uKneeY.value = -1e4;
  u.uDissolveDir.value.set(0, 0, 0, 0);
}

// ── Surface samples (finisher particles) ─────────────────────────────────────
// Area-weighted random points on the body's surface in REST model space, with
// the owning bone and a surface class, so a death can spawn voxels / shards /
// ash exactly where the armour was. Deterministic (seeded), built once.

export const SAMPLE_ARMOR = 0; // painted plate (player colour)
export const SAMPLE_SUIT = 1; // dark under-suit / gunmetal
export const SAMPLE_GLOW = 2; // visor / light slits

export type BodySamples = {
  count: number;
  pos: Float32Array; // xyz, rest model space
  bone: Uint8Array;
  kind: Uint8Array;
};

let samples: BodySamples | null = null;

export function getBodySamples(): BodySamples {
  if (samples) return samples;
  const g = getBodyGeometry().geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const skin = g.getAttribute('skinIndex') as THREE.BufferAttribute;
  const mat = g.getAttribute('aMat') as THREE.BufferAttribute;
  const tris = pos.count / 3;
  const cum = new Float64Array(tris);
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    total += b.sub(a).cross(c.sub(a)).length() * 0.5;
    cum[t] = total;
  }
  const N = 256;
  const out: BodySamples = { count: N, pos: new Float32Array(N * 3), bone: new Uint8Array(N), kind: new Uint8Array(N) };
  let seed = 1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < N; i++) {
    // Stratified pick along the cumulative area.
    const r = ((i + rand()) / N) * total;
    let lo = 0, hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    for (let k = 0; k < 3; k++) {
      out.pos[i * 3 + k] =
        pos.getComponent(lo * 3, k) * w + pos.getComponent(lo * 3 + 1, k) * u + pos.getComponent(lo * 3 + 2, k) * v;
    }
    out.bone[i] = skin.getX(lo * 3);
    const emit = mat.getW(lo * 3);
    out.kind[i] = emit > 0.5 ? SAMPLE_GLOW : mat.getX(lo * 3) > 0.5 ? SAMPLE_ARMOR : SAMPLE_SUIT;
  }
  // Shuffle (deterministic) so any prefix is spread over the whole body.
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    for (let k = 0; k < 3; k++) {
      const tmp = out.pos[i * 3 + k];
      out.pos[i * 3 + k] = out.pos[j * 3 + k];
      out.pos[j * 3 + k] = tmp;
    }
    const tb = out.bone[i]; out.bone[i] = out.bone[j]; out.bone[j] = tb;
    const tk = out.kind[i]; out.kind[i] = out.kind[j]; out.kind[j] = tk;
  }
  samples = out;
  return out;
}
