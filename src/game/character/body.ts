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
type Surface = { color: number; tint: number; rough: number; metal: number; emit: number };
const S = {
  suit: { color: 0x262a31, tint: 0, rough: 0.78, metal: 0.05, emit: 0 },
  suitDark: { color: 0x16181d, tint: 0, rough: 0.7, metal: 0.1, emit: 0 },
  armor: { color: 0xffffff, tint: 1, rough: 0.36, metal: 0.18, emit: 0 },
  armorDark: { color: 0x575757, tint: 1, rough: 0.44, metal: 0.25, emit: 0 },
  trim: { color: 0x3a414c, tint: 0, rough: 0.34, metal: 0.82, emit: 0 },
  trimDark: { color: 0x22272e, tint: 0, rough: 0.4, metal: 0.7, emit: 0 },
  trimLight: { color: 0xd9dee5, tint: 0, rough: 0.38, metal: 0.25, emit: 0 },
  visor: { color: 0x101010, tint: 0, rough: 0.2, metal: 0.0, emit: 1 },
  light: { color: 0x101010, tint: 0, rough: 0.3, metal: 0.0, emit: 0.7 },
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
  add(B.head, hull([
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
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const comSum = new Float64Array(BONE_COUNT * 3);
  const comN = new Float64Array(BONE_COUNT);
  const c = new THREE.Color();
  let o = 0;
  for (const { p, pos, nor } of flat) {
    c.setHex(p.s.color); // sRGB hex → linear working colour
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

export type CharacterUniforms = {
  uPlayer: { value: THREE.Color };
  uVisor: { value: THREE.Color };
  uRim: { value: THREE.Color };
  uLift: { value: number };
  uRimStr: { value: number };
  uGlow: { value: number };
  uGlowCol: { value: THREE.Color };
};

// Defined once at module scope so every character material hashes to the same
// compiled program (three keys custom programs on onBeforeCompile's source).
function injectCharacterShader(this: THREE.MeshStandardMaterial, shader: THREE.WebGLProgramParametersWithUniforms) {
  const u = (this.userData as { charUniforms: CharacterUniforms }).charUniforms;
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec4 vMat;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      [
        '#include <common>',
        'varying vec4 vMat;',
        'uniform vec3 uPlayer;',
        'uniform vec3 uVisor;',
        'uniform vec3 uRim;',
        'uniform float uLift;',
        'uniform float uRimStr;',
        'uniform float uGlow;',
        'uniform vec3 uGlowCol;',
      ].join('\n'),
    )
    .replace(
      '#include <color_fragment>',
      '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), uPlayer, vMat.x);',
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.y;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.z;')
    .replace(
      '#include <emissivemap_fragment>',
      [
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance += uVisor * vMat.w;',
        'totalEmissiveRadiance += uPlayer * (vMat.x * uLift);',
        'float igFres = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);',
        'igFres = igFres * igFres * igFres;',
        'totalEmissiveRadiance += uRim * (igFres * uRimStr * (0.35 + 0.65 * vMat.x));',
        'totalEmissiveRadiance += uGlowCol * (uGlow * (0.4 + 0.6 * vMat.x));',
      ].join('\n'),
    );
}

export function createCharacterMaterial(): { material: THREE.MeshStandardMaterial; uniforms: CharacterUniforms } {
  const uniforms: CharacterUniforms = {
    uPlayer: { value: new THREE.Color(1, 0.4, 0.2) },
    uVisor: { value: new THREE.Color(1, 0.8, 0.6) },
    uRim: { value: new THREE.Color(1, 0.5, 0.3) },
    uLift: { value: 0.1 },
    uRimStr: { value: 0.5 },
    uGlow: { value: 0 },
    uGlowCol: { value: new THREE.Color(1, 1, 1) },
  };
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 0.9,
  });
  material.userData.charUniforms = uniforms;
  material.onBeforeCompile = injectCharacterShader;
  return { material, uniforms };
}
