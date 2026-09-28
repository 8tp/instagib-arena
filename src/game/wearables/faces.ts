import * as THREE from 'three';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import {
  CHROME,
  GOLD,
  GOLD_DARK,
  GUNMETAL,
  HELM_Z0,
  HELM_ZS,
  LEATHER,
  accent,
  ball,
  cbox,
  cyl,
  extrude,
  faceOut,
  hardLight,
  helmR,
  hull,
  octa,
  paint,
  plate,
  revolve,
  shell,
  surf,
  sweep,
  visorZ,
  type Surf,
  type V3,
} from './kit';
import type { WearSpec } from './spec';

// ── Face items ───────────────────────────────────────────────────────────────
// Worn on the `face` socket (head bone, at the visor). The helmet front: the
// visor band (y 1.631–1.679) wraps ±70° with its surface at visorZ(x); the
// face guard below it is a wedge — front ridge z −0.172 (y 1.56–1.628),
// corners (±0.072, −0.14) and (±0.097, −0.086); ear pods sit at x ±0.128–0.165,
// y 1.585–1.679 (z −0.035…0.059). Straps go OVER the pods (y ≈ 1.69, on the
// dome) or UNDER them (y ≈ 1.565, on the jaw).
//
// Fairness: anything that sits over the visor glows in the wearer's colour
// (accent emissive), so a face item never hides the visor's read.

const PI = Math.PI;

// Facing angle (for faceOut) of the visor surface at x.
function visorPhi(x: number, y = 1.655): number {
  const r = helmR(y) + 0.006;
  const q = Math.sqrt(Math.max(1e-6, r * r - x * x));
  return PI - Math.atan((x * HELM_ZS) / q);
}

// Face-guard front z at x (y ≈ 1.56–1.628).
function guardZ(x: number): number {
  const ax = Math.abs(x);
  if (ax < 0.072) return -0.172 + 0.444 * ax;
  return -0.14 + ((ax - 0.072) / 0.025) * 0.054;
}

// A strap from a start point up over the ear pods and round the back.
function strapOver(from: V3, y = 1.69): V3[] {
  const s = Math.sign(from[0]);
  return [
    from,
    [s * 0.13, (from[1] + y) / 2 + 0.006, -0.085],
    [s * 0.153, y, -0.025],
    [s * 0.157, y + 0.002, 0.035],
    [s * 0.132, y + 0.002, 0.1],
    [s * 0.072, y, 0.158],
    [0, y, 0.176],
  ];
}

// A strap from a start point down under the pods, round the jaw.
function strapUnder(from: V3, y = 1.563): V3[] {
  const s = Math.sign(from[0]);
  return [
    from,
    [s * 0.118, y + 0.004, -0.03],
    [s * 0.122, y, 0.03],
    [s * 0.095, y, 0.098],
    [s * 0.05, y, 0.128],
    [0, y, 0.136],
  ];
}

// A mirror-lens surface: reflective, tinted + faintly lit in the wearer's colour.
const LENS = (base = 0xcfd6de, e = 0.35): Surf => ({ c: base, r: 0.06, m: 1, t: 1, e });

// Bend a flat (XY) plate onto the face: z follows a curved mask surface.
function bendMask(g: THREE.BufferGeometry, cy: number, dz = 0): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const zl = pos.getZ(i);
    pos.setXYZ(i, x, cy + y, -0.19 + 4.2 * x * x + 2.0 * y * y + zl + dz);
  }
  return g;
}

export const FACE_SPECS: Record<string, WearSpec> = {
  // Aviators — teardrop mirror lenses, thin gold frame, temples to the pods.
  'face.aviators': {
    build(k) {
      const m0 = k.mark();
      const lens = new THREE.Shape();
      lens.moveTo(-0.029, 0.016);
      lens.quadraticCurveTo(0.0, 0.022, 0.031, 0.018);
      lens.quadraticCurveTo(0.037, 0.004, 0.028, -0.012);
      lens.quadraticCurveTo(0.012, -0.027, -0.006, -0.022);
      lens.quadraticCurveTo(-0.03, -0.012, -0.029, 0.016);
      const cx = 0.05;
      const cy = 1.654;
      const phi = visorPhi(cx);
      const cz = visorZ(cx) - 0.017;
      k.add(faceOut(extrude(lens, 0.004, 0, 4), phi, [cx, cy, cz]), LENS());
      const rim = lens.getPoints(5).map((p) => [p.x, p.y, -0.0025] as V3);
      const rg = sweep(rim, 0.0022, 4, { caps: false });
      k.add(faceOut(rg, phi, [cx, cy, cz]), GOLD);
      // Temple arm.
      k.add(
        sweep(
          [
            [0.08, 1.67, cz + 0.012],
            [0.118, 1.672, -0.112],
            [0.148, 1.668, -0.06],
            [0.155, 1.662, -0.012],
          ],
          0.0026,
          4,
          { smooth: 2 },
        ),
        GOLD,
      );
      k.mirrorFrom(m0);
      // Double bridge.
      const bz = visorZ(0) - 0.019;
      k.add(sweep([[-0.022, 1.669, bz + 0.003], [0, 1.671, bz], [0.022, 1.669, bz + 0.003]], 0.0022, 4, { smooth: 2 }), GOLD);
      k.add(sweep([[-0.02, 1.661, bz + 0.003], [0, 1.66, bz], [0.02, 1.661, bz + 0.003]], 0.0018, 4, { smooth: 2 }), GOLD);
    },
  },

  // Handlebar moustache — waxed and curled, on the face guard.
  'face.moustache': {
    build(k) {
      const m0 = k.mark();
      const path: V3[] = [
        [0, 1.608, -0.184],
        [0.024, 1.605, -0.177],
        [0.048, 1.601, -0.165],
        [0.07, 1.604, -0.15],
        [0.086, 1.618, -0.139],
        [0.09, 1.634, -0.137],
        [0.08, 1.643, -0.141],
      ];
      k.add(sweep(path, (t) => 0.0035 + 0.0115 * (1 - t) ** 1.3, k.seg(8, 6), { smooth: k.low ? 2 : 3, sy: 0.6, up: [0, 1, 0] }), paint(0x3a2417, 0.85, 0.05));
      k.mirrorFrom(m0);
    },
  },

  // Shutter Shades — slatted frame in your colour; the visor glows between.
  'face.shades': {
    build(k) {
      const frame = accent(0xf0f0f0, 0.38, 0.12);
      const off = 0.022;
      const X = 0.128;
      const zAt = (x: number) => visorZ(Math.min(Math.abs(x), 0.136)) - off;
      const loop: V3[] = [];
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const x = -X + (2 * X * i) / n;
        loop.push([x, 1.686, zAt(x)]);
      }
      loop.push([X + 0.004, 1.672, zAt(X)]);
      loop.push([X + 0.004, 1.64, zAt(X)]);
      for (let i = n; i >= 0; i--) {
        const x = -X + (2 * X * i) / n;
        loop.push([x, 1.629, zAt(x) - (Math.abs(x) < 0.03 ? 0.004 : 0)]);
      }
      loop.push([-X - 0.004, 1.64, zAt(X)]);
      loop.push([-X - 0.004, 1.672, zAt(X)]);
      loop.push(loop[0]);
      k.add(sweep(loop, 0.0045, 4, { caps: false, up: [0, 0, 1] }), frame);
      for (let s = 1; s <= 4; s++) {
        const y = 1.629 + (s * (1.686 - 1.629)) / 5;
        const pts: V3[] = [];
        for (let i = 0; i <= n; i++) {
          const x = -X + (2 * X * i) / n;
          pts.push([x, y, zAt(x)]);
        }
        k.add(sweep(pts, 0.0048, 4, { sy: 0.35, up: [0, 1, 0], caps: false }), frame);
      }
      k.add(cbox(0, 1.657, visorZ(0) - off, 0.008, 0.056, 0.008, 0.002), frame);
      const m0 = k.mark();
      k.add(sweep([[X, 1.676, zAt(X)], [0.14, 1.675, -0.1], [0.152, 1.67, -0.05], [0.156, 1.664, -0.012]], 0.003, 4, { smooth: 2 }), frame);
      k.mirrorFrom(m0);
    },
  },

  // Flight Goggles — brass cups, amber lenses, a leather strap over the pods.
  'face.goggles': {
    build(k) {
      const brass = surf(0xc8923a, 0.3, 0.9);
      const m0 = k.mark();
      const cx = 0.05;
      const phi = visorPhi(cx);
      const base = visorZ(cx) - 0.004;
      const at: V3 = [cx, 1.655, base];
      // (cyl is along +Y; rotate it onto −Z, the facing axis.)
      const tube = cyl([0, 0, 0], [0, 0.026, 0], 0.035, 0.032, k.seg(14, 10));
      tube.rotateX(-PI / 2);
      k.add(faceOut(tube, phi, at), brass);
      const lensG = cyl([0, 0, 0], [0, 0.004, 0], 0.027, 0.027, k.seg(14, 10));
      lensG.rotateX(-PI / 2);
      lensG.translate(0, 0, -0.0245);
      k.add(faceOut(lensG, phi, at), { c: 0xffa531, r: 0.08, m: 0.2, e: 0.55 });
      const ringG = revolve([[0.026, 0], [0.036, 0], [0.036, 0.005], [0.026, 0.005]], k.seg(14, 10));
      ringG.rotateX(-PI / 2);
      ringG.translate(0, 0, -0.023);
      k.add(faceOut(ringG, phi, at), brass);
      // Leather strap over the pods, round the back.
      // Leather strap back to a brass clip on the ear pod.
      k.add(sweep([[0.083, 1.657, base - 0.01], [0.112, 1.655, -0.105], [0.136, 1.648, -0.06], [0.15, 1.642, -0.036]], 0.011, 4, { sy: 0.28, up: [0, 1, 0], smooth: 2 }), LEATHER);
      k.add(cbox(0.152, 1.642, -0.034, 0.014, 0.024, 0.012, 0.003), brass);
      k.mirrorFrom(m0);
      k.add(sweep([[-0.016, 1.662, visorZ(0.016) - 0.018], [0, 1.664, visorZ(0) - 0.022], [0.016, 1.662, visorZ(0.016) - 0.018]], 0.004, 5, { smooth: 2 }), brass);
    },
  },

  // Bandit Mask — a kerchief over the lower face, knotted behind.
  'face.bandit': {
    build(k) {
      const cloth = paint(0x24262d, 0.9, 0.02);
      const off = 0.01;
      const A = 1.2; // half-angle of the cloth round the face
      k.add(
        plate(
          (u, v) => {
            const s = u * 2 - 1;
            const phi = PI + s * A;
            const yTop = 1.628 - 0.004 * s * s;
            const yBot = 1.584 - 0.05 * (1 - Math.abs(s) ** 1.4);
            const y = yTop + (yBot - yTop) * v;
            const r = helmR(Math.max(1.556, y)) + off;
            const x = r * Math.sin(phi);
            const zH = HELM_Z0 + HELM_ZS * r * Math.cos(phi);
            const zG = guardZ(x) - off;
            // Below the guard's chin it drapes back toward the neck.
            const hang = y < 1.558 ? 1.558 - y : 0;
            return [x * (1 - hang * 2), y, Math.min(zH, zG) + hang * 1.6] as V3;
          },
          k.seg(12, 8),
          5,
        ).top,
        cloth,
      );
      // Tie band round the jaw (under the pods) + knot and tails.
      const m0 = k.mark();
      const bx = (helmR(1.585) + off) * Math.sin(PI + A);
      const bz = HELM_Z0 + HELM_ZS * (helmR(1.585) + off) * Math.cos(PI + A);
      k.add(sweep(strapUnder([-bx, 1.585, bz], 1.568), 0.009, 4, { sy: 0.3, up: [0, 1, 0], smooth: 2 }), cloth);
      k.mirrorFrom(m0);
      k.add(ball(0, 1.57, 0.14, 0.017, 0, 0.9), cloth);
      for (const s of [1, -1]) {
        k.add(plate((u, v) => [s * (0.006 + 0.03 * v) + (u - 0.5) * 0.024 * (1 - 0.4 * v), 1.566 - 0.07 * v, 0.148 + 0.03 * v] as V3, 1, 3).top, cloth);
      }
      // A thin hem in your colour.
      const hem: V3[] = [];
      for (let i = 0; i <= 12; i++) {
        const s = (i / 12) * 2 - 1;
        const phi = PI + s * A;
        const y = 1.584 - 0.05 * (1 - Math.abs(s) ** 1.4);
        const r = helmR(Math.max(1.556, y)) + off;
        const x = r * Math.sin(phi);
        const zH = HELM_Z0 + HELM_ZS * r * Math.cos(phi);
        const hang = y < 1.558 ? 1.558 - y : 0;
        hem.push([x * (1 - hang * 2), y + 0.004, Math.min(zH, guardZ(x) - off) + hang * 1.6 - 0.002]);
      }
      k.add(sweep(hem, 0.0035, 4, { caps: false }), accent(0xdddddd, 0.7, 0.02));
    },
  },

  // Monocle — a gold ring over the right eye, a chain to the ear pod.
  'face.monocle': {
    build(k) {
      const cx = 0.05;
      const phi = visorPhi(cx);
      const at: V3 = [cx, 1.657, visorZ(cx) - 0.012];
      const ringG = revolve(
        [
          [0.027, -0.003],
          [0.034, -0.003],
          [0.034, 0.003],
          [0.027, 0.003],
          [0.027, -0.003],
        ],
        k.seg(20, 12),
      );
      ringG.rotateX(-PI / 2);
      k.add(faceOut(ringG, phi, at), GOLD);
      const lensG = cyl([0, -0.001, 0], [0, 0.001, 0], 0.028, 0.028, k.seg(20, 12));
      lensG.rotateX(-PI / 2);
      k.add(faceOut(lensG, phi, at), LENS(0xe8f2ff, 0.3));
      const chain: V3[] = [
        [0.078, 1.645, at[2] + 0.006],
        [0.09, 1.61, -0.14],
        [0.108, 1.588, -0.112],
        [0.13, 1.592, -0.07],
        [0.146, 1.605, -0.03],
      ];
      k.add(sweep(chain, 0.0016, 3, { smooth: 3 }), GOLD_DARK);
      for (let i = 1; i < 4; i++) k.add(ball(chain[i][0], chain[i][1], chain[i][2], 0.003, 0), GOLD);
    },
  },

  // Gas Mask — rubber snout over the face guard, twin filters, a sealed
  // gasket round the visor, straps over and under the pods.
  'face.gasmask': {
    build(k) {
      const rubber = paint(0x3d4432, 0.86, 0.05);
      const rubberDark = surf(0x1e2119, 0.8, 0.05);
      const pts: V3[] = [
        [0, 1.627, -0.186],
        [0.058, 1.627, -0.164],
        [0.098, 1.625, -0.118],
        [0.116, 1.618, -0.072],
        [0, 1.59, -0.204],
        [0.07, 1.585, -0.176],
        [0.113, 1.58, -0.106],
        [0.119, 1.585, -0.062],
        [0, 1.536, -0.172],
        [0.058, 1.533, -0.142],
        [0.098, 1.543, -0.092],
        [0.108, 1.558, -0.052],
      ];
      k.add(hull([...pts, ...pts.filter((p) => p[0] > 0).map(([x, y, z]) => [-x, y, z] as V3)]), rubber);
      // Gasket round the visor.
      const loop: V3[] = [];
      const X = 0.132;
      const n = 8;
      const zAt = (x: number, y: number) => visorZ(Math.min(Math.abs(x), 0.134), y) - 0.006;
      for (let i = 0; i <= n; i++) {
        const x = -X + (2 * X * i) / n;
        loop.push([x, 1.685, zAt(x, 1.683)]);
      }
      for (let i = n; i >= 0; i--) {
        const x = -X + (2 * X * i) / n;
        loop.push([x, 1.627, zAt(x, 1.631) - (Math.abs(x) < 0.06 ? 0.004 : 0)]);
      }
      loop.push(loop[0]);
      k.add(sweep(loop, 0.0055, 4, { caps: false }), rubberDark);
      // Filters.
      const m0 = k.mark();
      const d = new THREE.Vector3(0.55, -0.42, -0.72).normalize();
      const c = new THREE.Vector3(0.088, 1.566, -0.158);
      const p0 = c.clone().addScaledVector(d, -0.012);
      const p1 = c.clone().addScaledVector(d, 0.04);
      const p2 = c.clone().addScaledVector(d, 0.05);
      const seg = k.seg(12, 8);
      k.add(cyl([p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], 0.03, 0.034, seg), surf(0x5b6147, 0.45, 0.5));
      k.add(cyl([p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], 0.036, 0.033, seg), GUNMETAL);
      const p3 = c.clone().addScaledVector(d, 0.052);
      k.add(cyl([p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z], 0.024, 0.024, seg), rubberDark);
      const ribs = c.clone().addScaledVector(d, 0.016);
      const ribs2 = c.clone().addScaledVector(d, 0.026);
      k.add(cyl([ribs.x, ribs.y, ribs.z], [ribs2.x, ribs2.y, ribs2.z], 0.036, 0.036, seg), GUNMETAL);
      k.add(sweep(strapOver([0.112, 1.622, -0.074], 1.69), 0.009, 4, { sy: 0.3, up: [0, 1, 0], smooth: 2 }), rubberDark);
      k.add(sweep(strapUnder([0.108, 1.56, -0.05], 1.562), 0.009, 4, { sy: 0.3, up: [0, 1, 0], smooth: 2 }), rubberDark);
      k.mirrorFrom(m0);
      // Exhale valve.
      k.add(cyl([0, 1.572, -0.198], [0, 1.566, -0.222], 0.024, 0.02, seg), GUNMETAL);
      for (let i = 0; i < 3; i++) k.add(cbox(0, 1.562 + i * 0.0075, -0.2225, 0.03, 0.003, 0.003, 0.001), rubberDark);
    },
  },

  // Hockey Mask — a pale shell with eye cut-outs over the visor, breathing
  // holes and red chevrons.
  'face.hockey': {
    build(k) {
      const shellS = paint(0xe9e3d1, 0.55, 0.05);
      const red = surf(0xc2262e, 0.55, 0.05);
      const s = new THREE.Shape();
      s.moveTo(0, 0.1);
      s.bezierCurveTo(0.07, 0.1, 0.104, 0.06, 0.102, 0.0);
      s.bezierCurveTo(0.1, -0.06, 0.07, -0.098, 0.0, -0.098);
      s.bezierCurveTo(-0.07, -0.098, -0.1, -0.06, -0.102, 0.0);
      s.bezierCurveTo(-0.104, 0.06, -0.07, 0.1, 0, 0.1);
      const eye = (cx: number) => {
        const h = new THREE.Path();
        h.absellipse(cx, 0.026, 0.029, 0.0155, 0, PI * 2, cx > 0, 0);
        return h;
      };
      s.holes.push(eye(0.045), eye(-0.045));
      const holes: [number, number][] = [
        [0.02, -0.03],
        [-0.02, -0.03],
        [0.046, -0.022],
        [-0.046, -0.022],
        [0.032, -0.052],
        [-0.032, -0.052],
        [0, -0.066],
        [0.02, 0.066],
        [-0.02, 0.066],
        [0, 0.078],
      ];
      for (const [x, y] of holes) {
        const h = new THREE.Path();
        h.absarc(x, y, 0.0048, 0, PI * 2, true);
        s.holes.push(h);
      }
      let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: false, curveSegments: k.low ? 4 : 5 });
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      const t = new TessellateModifier(k.low ? 0.06 : 0.042, 3).modify(g);
      g.dispose();
      g = t;
      g.translate(0, 0, -0.004);
      k.add(bendMask(g, 1.63), shellS);
      // Red chevrons (forehead + cheeks).
      const chev = (x: number, y: number, flip: number) => {
        const c = new THREE.Shape();
        c.moveTo(x - 0.018, y + 0.008 * flip);
        c.lineTo(x, y - 0.006 * flip);
        c.lineTo(x + 0.018, y + 0.008 * flip);
        c.lineTo(x + 0.018, y + 0.002 * flip);
        c.lineTo(x, y - 0.012 * flip);
        c.lineTo(x - 0.018, y + 0.002 * flip);
        c.closePath();
        k.add(bendMask(new THREE.ExtrudeGeometry(c, { depth: 0.002, bevelEnabled: false }), 1.63, -0.006), red);
      };
      chev(0.034, 0.058, 1);
      chev(-0.034, 0.058, 1);
      chev(0.066, -0.04, -1);
      chev(-0.066, -0.04, -1);
      // Straps.
      const m0 = k.mark();
      k.add(sweep(strapOver([0.098, 1.69, -0.15], 1.692), 0.007, 4, { sy: 0.3, up: [0, 1, 0], smooth: 2 }), surf(0x16171b, 0.7, 0.05));
      k.add(sweep(strapUnder([0.1, 1.575, -0.148], 1.563), 0.007, 4, { sy: 0.3, up: [0, 1, 0], smooth: 2 }), surf(0x16171b, 0.7, 0.05));
      k.mirrorFrom(m0);
    },
  },

  // Cyber HUD — an ear-pod emitter, an arm to a holographic eyepiece with a
  // reticle, and a scan line across the visor (all hard light).
  'face.cyber': {
    build(k) {
      const holo = (e: number): Surf => hardLight(0xffffff, e, 1);
      k.add(cbox(0.172, 1.664, 0.0, 0.024, 0.06, 0.074, 0.006), GUNMETAL);
      k.add(cbox(0.185, 1.664, 0.0, 0.004, 0.042, 0.054, 0.001), holo(1.6));
      k.add(hull([[0.168, 1.694, 0.02], [0.176, 1.694, 0.02], [0.168, 1.694, -0.02], [0.176, 1.694, -0.02], [0.172, 1.74, 0.03]]), GUNMETAL);
      k.add(cyl([0.172, 1.738, 0.03], [0.172, 1.744, 0.031], 0.004, 0.004, 5), holo(2.4));
      k.add(sweep([[0.172, 1.674, -0.03], [0.158, 1.676, -0.098], [0.118, 1.676, -0.148], [0.086, 1.674, -0.168]], 0.0035, 4, { smooth: 2 }), GUNMETAL);
      const cx = 0.05;
      const phi = visorPhi(cx);
      const at: V3 = [cx + 0.004, 1.656, visorZ(cx) - 0.024];
      const m0 = k.mark();
      // Eyepiece frame (4 bars) + corner brackets.
      const W = 0.034;
      const H = 0.021;
      k.add(cbox(0, H, 0, W * 2, 0.0026, 0.002, 0.0005), holo(2.2));
      k.add(cbox(0, -H, 0, W * 2, 0.0026, 0.002, 0.0005), holo(2.2));
      k.add(cbox(W, 0, 0, 0.0026, H * 2, 0.002, 0.0005), holo(2.2));
      k.add(cbox(-W, 0, 0, 0.0026, H * 2, 0.002, 0.0005), holo(2.2));
      // Reticle.
      const ringG = revolve([[0.009, 0], [0.0115, 0]], 16);
      ringG.rotateX(PI / 2);
      k.add(ringG, holo(2.6));
      for (const [x, y, w, h] of [
        [0.017, 0, 0.008, 0.0016],
        [-0.017, 0, 0.008, 0.0016],
        [0, 0.014, 0.0016, 0.007],
        [0, -0.014, 0.0016, 0.007],
      ]) {
        k.add(cbox(x, y, 0, w, h, 0.0015, 0.0003), holo(2.6));
      }
      // Data glyphs.
      for (let i = 0; i < 3; i++) k.add(cbox(-0.02 + i * 0.004, -0.013 + 0.0, -0.0005, 0.0025, 0.004 + i * 0.002, 0.001, 0.0002), holo(1.6));
      k.add(plate((u, v) => [(u - 0.5) * W * 2, (v - 0.5) * H * 2, 0.0012] as V3, 1, 1).top, hardLight(0xffffff, 0.35, 1));
      k.xf(m0, new THREE.Matrix4().makeRotationY(phi + PI).multiply(new THREE.Matrix4().makeScale(1.3, 1.3, 1)).setPosition(at[0], at[1], at[2]));
      // Scan line across the visor.
      const pts: V3[] = [];
      for (let i = 0; i <= 10; i++) {
        const x = -0.118 + (0.236 * i) / 10;
        pts.push([x, 1.644, visorZ(x) - 0.011]);
      }
      k.add(sweep(pts, 0.0016, 4, { caps: true }), holo(2.0));
    },
  },

  // Death's Head (Relic) — a chrome skull: brow ridge, eye sockets that frame
  // the visor, a nose cavity, cheekbones and grinning teeth over the guard,
  // with a hard-light glow in the bite.
  'face.skull': {
    build(k) {
      const chrome = CHROME;
      const dark = surf(0x24272d, 0.3, 0.9);
      // Brow ridge.
      k.add(
        shell(
          [
            [helmR(1.68) + 0.002, 1.681],
            [helmR(1.684) + 0.018, 1.684],
            [helmR(1.698) + 0.02, 1.698],
            [helmR(1.71) + 0.006, 1.711],
          ],
          k.seg(14, 10),
          { phi0: PI - 1.25, phiLen: 2.5, ydel: (phi, t) => (t > 0.3 && t < 0.9 ? 0.005 * Math.cos((phi - PI) * 2.6) ** 2 : 0) },
        ),
        chrome,
      );
      // Eye-socket rims (each frames half the visor).
      const m0 = k.mark();
      const rimPts: V3[] = [];
      const x0 = 0.02;
      const x1 = 0.126;
      for (let i = 0; i <= 6; i++) {
        const x = x0 + ((x1 - x0) * i) / 6;
        rimPts.push([x, 1.683, visorZ(x, 1.68) - 0.006]);
      }
      rimPts.push([x1 + 0.006, 1.655, visorZ(x1) - 0.004]);
      for (let i = 6; i >= 0; i--) {
        const x = x0 + ((x1 - x0) * i) / 6;
        rimPts.push([x, 1.628 - 0.006 * Math.sin((i / 6) * PI), visorZ(x, 1.63) - 0.006]);
      }
      rimPts.push([x0 - 0.004, 1.655, visorZ(x0) - 0.01]);
      rimPts.push(rimPts[0]);
      k.add(sweep(rimPts, 0.0048, 4, { caps: false, smooth: 2 }), chrome);
      // Cheekbone.
      k.add(
        hull([
          [0.07, 1.626, -0.156],
          [0.122, 1.626, -0.098],
          [0.112, 1.598, -0.098],
          [0.078, 1.603, -0.146],
          [0.072, 1.62, -0.146],
          [0.114, 1.62, -0.09],
        ]),
        chrome,
      );
      // Upper teeth.
      for (const x of [0.012, 0.034, 0.056]) {
        const z = guardZ(x) - 0.006;
        const g = cbox(0, 0, 0, 0.018, 0.018, 0.008, 0.003);
        g.rotateY(-Math.atan(0.444));
        g.translate(x, 1.609, z);
        k.add(g, surf(0xeeeae0, 0.2, 0.6));
      }
      k.mirrorFrom(m0);
      // Nose cavity.
      k.add(hull([[0, 1.672, -0.17], [0.014, 1.63, -0.168], [-0.014, 1.63, -0.168], [0, 1.672, -0.182], [0.014, 1.63, -0.18], [-0.014, 1.63, -0.18]]), dark);
      k.add(hull([[0, 1.662, -0.183], [0.008, 1.636, -0.182], [-0.008, 1.636, -0.182], [0, 1.662, -0.185], [0.008, 1.636, -0.185], [-0.008, 1.636, -0.185]]), hardLight(0xffffff, 0.9, 1));
      // Lower jaw with teeth + the glowing bite line.
      k.add(hull([[0.075, 1.588, -0.146], [0, 1.588, -0.182], [-0.075, 1.588, -0.146], [0.05, 1.552, -0.14], [0, 1.553, -0.168], [-0.05, 1.552, -0.14], [0.075, 1.58, -0.13], [-0.075, 1.58, -0.13]]), chrome);
      for (const x of [-0.045, -0.022, 0, 0.022, 0.045]) {
        const z = guardZ(x) - 0.012;
        const g = cbox(0, 0, 0, 0.017, 0.012, 0.006, 0.002);
        g.rotateY(Math.sign(x) * -Math.atan(0.444));
        g.translate(x, 1.594, z);
        k.add(g, surf(0xeeeae0, 0.2, 0.6));
      }
      k.add(sweep([[-0.068, 1.6, -0.143], [0, 1.6, -0.18], [0.068, 1.6, -0.143]], 0.0022, 4), hardLight(0xff3030, 1.6));
    },
  },

  // Sovereign Visor (staff) — a gilded faceplate: crowned brow, gold cheek
  // guards, white enamel over the guard, a hard-light line under the visor.
  'face.sovereign': {
    build(k) {
      const enamel = surf(0xf6f3ec, 0.22, 0.1);
      const gold = GOLD;
      // Brow band.
      k.add(
        shell(
          [
            [helmR(1.681) + 0.004, 1.681],
            [helmR(1.683) + 0.014, 1.683],
            [helmR(1.7) + 0.014, 1.7],
            [helmR(1.702) + 0.004, 1.702],
          ],
          k.seg(14, 10),
          { phi0: PI - 1.3, phiLen: 2.6 },
        ),
        gold,
      );
      // Crown motif at the brow: three points + a white-light gem.
      const zf = (y: number, x = 0) => visorZ(x, y) - 0.012;
      const pt = (x: number, y: number, d = 0): V3 => [x, y, zf(Math.min(1.72, y), x) - d];
      k.add(hull([pt(-0.034, 1.7), pt(0.034, 1.7), pt(-0.034, 1.7, 0.006), pt(0.034, 1.7, 0.006), pt(0, 1.736, 0.002), pt(0, 1.736, -0.004), pt(-0.026, 1.724), pt(0.026, 1.724)]), gold);
      k.add(octa(0, 1.716, zf(1.716) - 0.008, 0.008, 1.4), hardLight(0xffffff, 2.6));
      for (const x of [-0.03, 0.03]) k.add(octa(x, 1.727, zf(1.72, x) - 0.004, 0.005, 1.3), hardLight(0xfff4d6, 2.2));
      // Enamel faceplate over the guard + gold keel and edge.
      k.add(
        hull([
          [0, 1.628, -0.184],
          [0.074, 1.628, -0.151],
          [-0.074, 1.628, -0.151],
          [0.1, 1.622, -0.094],
          [-0.1, 1.622, -0.094],
          [0, 1.562, -0.18],
          [0.05, 1.556, -0.146],
          [-0.05, 1.556, -0.146],
          [0.08, 1.556, -0.078],
          [-0.08, 1.556, -0.078],
        ]),
        enamel,
      );
      k.add(sweep([[0, 1.626, -0.187], [0, 1.595, -0.188], [0, 1.563, -0.183]], 0.0035, 4), gold);
      k.add(sweep([[-0.1, 1.624, -0.095], [-0.074, 1.63, -0.153], [0, 1.63, -0.187], [0.074, 1.63, -0.153], [0.1, 1.624, -0.095]], 0.003, 4, { smooth: 2 }), gold);
      // Cheek guards.
      const m0 = k.mark();
      k.add(
        hull([
          [0.078, 1.626, -0.157],
          [0.126, 1.626, -0.096],
          [0.118, 1.572, -0.09],
          [0.066, 1.566, -0.146],
          [0.072, 1.62, -0.146],
          [0.118, 1.62, -0.088],
        ]),
        gold,
      );
      k.mirrorFrom(m0);
      // Hard-light line under the visor.
      const pts: V3[] = [];
      for (let i = 0; i <= 10; i++) {
        const x = -0.1 + (0.2 * i) / 10;
        pts.push([x, 1.6335, visorZ(x, 1.632) - 0.01]);
      }
      k.add(sweep(pts, 0.0021, 4), hardLight(0xfff1c8, 2.4));
    },
  },
};
