import * as THREE from 'three';
import {
  GOLD,
  GOLD_DARK,
  GUNMETAL,
  Kit,
  LEATHER,
  STEEL,
  accent,
  cbox,
  cyl,
  extrude,
  hardLight,
  hull,
  loft,
  octa,
  paint,
  revolve,
  surf,
  sweep,
  type Surf,
  type V3,
} from './kit';
import type { CapeSpec, WearSpec } from './spec';

// ── Back items ───────────────────────────────────────────────────────────────
// Worn on the `back` socket (chest bone, behind the built-in power pack). The
// cuirass's back is at z ≈ +0.124 (y 1.2–1.47); the power pack bulges to
// z 0.193 (x ±0.08, y 1.23–1.455) with two light slits; pauldrons ride the
// clavicles at x 0.12–0.36, y 1.39–1.54, z ±0.092. Back items mount over the
// pack (their front at z ≥ 0.196) and stay behind the pauldrons.

const PI = Math.PI;
const M = new THREE.Matrix4();
const place = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) =>
  M.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

// A strap from a point on the item up over the shoulder, into the collar.
function shoulderStrap(k: Kit, from: V3, s: Surf) {
  const sx = Math.sign(from[0]) || 1;
  k.add(sweep([from, [sx * 0.1, 1.478, 0.14], [sx * 0.104, 1.492, 0.07]], 0.016, 4, { sy: 0.25, up: [0, 0, 1], smooth: 2 }), s);
}

// The cape's collar yoke: a curved mantle round the back of the neck, kept
// behind the pauldrons (±1.0 rad).
function yoke(k: Kit, s: Surf, trim: Surf, clasp: Surf) {
  const o = { phi0: -1.0, phiLen: 2.0, z0: 0.02 };
  k.add(revolve([[0.118, 1.522], [0.158, 1.498], [0.196, 1.462], [0.2, 1.452], [0.19, 1.456]], k.seg(12, 8), o), s);
  k.add(revolve([[0.2, 1.4535], [0.203, 1.449], [0.198, 1.446]], k.seg(12, 8), o), trim);
  for (const sx of [1, -1]) {
    const a = sx * 0.95;
    const p: V3 = [Math.sin(a) * 0.19, 1.468, 0.02 + Math.cos(a) * 0.19];
    const g = cyl([0, 0, 0], [0, 0.008, 0], 0.017, 0.015, 10);
    g.rotateX(PI / 2);
    g.rotateY(a);
    g.translate(p[0], p[1], p[2]);
    k.add(g, clasp);
  }
}

const cape = (c: Partial<CapeSpec> & Pick<CapeSpec, 'bands'>): CapeSpec => ({
  width: 0.3,
  hemWidth: 0.5,
  length: 0.76,
  top: [0, 1.462, 0.19],
  ...c,
});

export const BACK_SPECS: Record<string, WearSpec> = {
  // Field Pack — canvas rucksack, flap + buckles, side pockets, bedroll.
  'back.pack': {
    build(k) {
      const canvas = paint(0x5d6b3e, 0.9, 0.02);
      const canvasDark = paint(0x46512e, 0.9, 0.02);
      k.add(
        loft([
          [1.12, 0.12, 0.058, 0.03, 0, 0.272],
          [1.16, 0.14, 0.074, 0.04, 0, 0.272],
          [1.38, 0.14, 0.074, 0.04, 0, 0.272],
          [1.43, 0.122, 0.064, 0.035, 0, 0.268],
        ]),
        canvas,
      );
      k.add(
        hull([
          ...([
            [-0.126, 1.448, 0.2],
            [0.126, 1.448, 0.2],
            [-0.132, 1.448, 0.336],
            [0.132, 1.448, 0.336],
            [-0.146, 1.4, 0.204],
            [0.146, 1.4, 0.204],
            [-0.146, 1.4, 0.35],
            [0.146, 1.4, 0.35],
            [-0.11, 1.29, 0.352],
            [0.11, 1.29, 0.352],
            [-0.11, 1.29, 0.344],
            [0.11, 1.29, 0.344],
          ] as V3[]),
        ]),
        canvasDark,
      );
      for (const sx of [1, -1]) {
        k.add(cbox(sx * 0.06, 1.25, 0.349, 0.022, 0.2, 0.006, 0.002), LEATHER);
        k.add(cbox(sx * 0.06, 1.3, 0.354, 0.03, 0.022, 0.006, 0.002), STEEL);
        k.add(cbox(sx * 0.158, 1.22, 0.268, 0.036, 0.11, 0.1, 0.012), canvasDark);
        shoulderStrap(k, [sx * 0.09, 1.43, 0.205], LEATHER);
        k.add(sweep([[sx * 0.12, 1.16, 0.205], [sx * 0.155, 1.15, 0.13], [sx * 0.158, 1.15, 0.07]], 0.014, 4, { sy: 0.25, up: [0, 1, 0], smooth: 2 }), LEATHER);
      }
      // Bedroll (your colour) with straps.
      k.add(cyl([-0.165, 1.49, 0.268], [0.165, 1.49, 0.268], 0.045, 0.045, k.seg(12, 8)), accent(0x9a9a9a, 0.88, 0));
      for (const x of [-0.09, 0.09]) k.add(cyl([x - 0.009, 1.49, 0.268], [x + 0.009, 1.49, 0.268], 0.048, 0.048, k.seg(12, 8)), LEATHER);
    },
  },

  // Quiver — a leather tube over the pack; rail slugs glowing at the top.
  'back.quiver': {
    build(k) {
      const leather = paint(0x6b4424, 0.72, 0.05);
      const A = new THREE.Vector3(-0.13, 1.08, 0.258);
      const B = new THREE.Vector3(0.12, 1.56, 0.264);
      const d = B.clone().sub(A).normalize();
      const at = (t: number) => A.clone().lerp(B, t);
      const v = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
      const seg = k.seg(12, 8);
      k.add(cyl(v(A), v(B), 0.046, 0.052, seg), leather);
      k.add(cyl(v(at(-0.02)), v(at(0.05)), 0.05, 0.05, seg), GUNMETAL);
      k.add(cyl(v(at(0.94)), v(at(1.01)), 0.057, 0.057, seg), GUNMETAL);
      k.add(cyl(v(at(0.45)), v(at(0.52)), 0.05, 0.051, seg), LEATHER);
      // Clamps to the pack.
      k.add(cbox(-0.02, 1.28, 0.205, 0.05, 0.03, 0.03, 0.006), GUNMETAL);
      k.add(cbox(0.04, 1.4, 0.205, 0.05, 0.03, 0.03, 0.006), GUNMETAL);
      // Slugs.
      const side = new THREE.Vector3(-d.y, d.x, 0).normalize();
      const back = new THREE.Vector3(0, 0, 1);
      const offs: [number, number][] = [
        [0, 0],
        [0.022, 0.01],
        [-0.022, 0.01],
        [0.012, -0.018],
        [-0.012, -0.018],
      ];
      offs.forEach(([a, b], i) => {
        const base = at(0.9).addScaledVector(side, a).addScaledVector(back, b);
        const tip = base.clone().addScaledVector(d, 0.1 + (i % 2) * 0.02);
        k.add(cyl(v(base), v(tip), 0.0065, 0.0065, 6), STEEL);
        const g = octa(0, 0, 0, 0.011, 1.8);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
        g.translate(tip.x + d.x * 0.012, tip.y + d.y * 0.012, tip.z + d.z * 0.012);
        k.add(g, hardLight(0xffffff, 1.8, 1));
      });
    },
  },

  // Field Radio — olive set with dials, a grille, handset, and a whip
  // antenna that sways.
  'back.radio': {
    build(k) {
      const olive = paint(0x4f5a3a, 0.7, 0.2);
      const dark = surf(0x22261c, 0.6, 0.3);
      k.add(cbox(0, 1.29, 0.262, 0.23, 0.3, 0.13, 0.012), olive);
      k.add(cbox(0, 1.31, 0.328, 0.19, 0.22, 0.008, 0.003), dark);
      for (const x of [-0.055, 0, 0.055]) {
        k.add(cyl([x, 1.37, 0.332], [x, 1.37, 0.345], 0.015, 0.013, 10), surf(0x14161a, 0.5, 0.4));
        k.add(cbox(x, 1.378, 0.345, 0.003, 0.009, 0.002, 0.0005), surf(0xeeeeee, 0.5, 0));
      }
      for (let i = 0; i < 5; i++) k.add(cbox(-0.03, 1.215 + i * 0.013, 0.334, 0.1, 0.005, 0.006, 0.002), surf(0x14161a, 0.5, 0.4));
      k.add(cbox(0.07, 1.25, 0.335, 0.028, 0.02, 0.006, 0.002), surf(0x14161a, 0.5, 0.4));
      k.add(cbox(0.07, 1.41, 0.334, 0.012, 0.008, 0.004, 0.001), { c: 0x5bff7a, r: 0.3, m: 0, e: 1.8, fx: 2 });
      k.add(sweep([[-0.08, 1.44, 0.26], [-0.06, 1.475, 0.262], [0.06, 1.475, 0.262], [0.08, 1.44, 0.26]], 0.006, 5, { smooth: 2 }), GUNMETAL);
      // Handset on the right + coiled cord.
      k.add(hull([[0.128, 1.2, 0.24], [0.128, 1.36, 0.25], [0.15, 1.2, 0.24], [0.15, 1.36, 0.25], [0.128, 1.2, 0.285], [0.15, 1.36, 0.29], [0.128, 1.36, 0.29], [0.15, 1.2, 0.285]]), dark);
      const coil: V3[] = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const a = t * PI * 2 * 7;
        coil.push([0.14 + Math.cos(a) * 0.008, 1.2 - 0.07 * Math.sin(t * PI) - t * 0.01, 0.3 - t * 0.04 + Math.sin(a) * 0.008]);
      }
      k.add(sweep(coil, 0.0022, 3, { caps: false }), dark);
      k.add(cyl([-0.085, 1.435, 0.29], [-0.085, 1.455, 0.29], 0.012, 0.01, 8), GUNMETAL);
    },
    subs: [
      {
        pivot: [-0.085, 1.455, 0.29],
        anim: { kind: 'swing', dir: [0, 1, 0.1], len: 0.45, stiff: 26, damp: 2.6, grav: 0.08 },
        build(k) {
          const p: V3 = [-0.085, 1.455, 0.29];
          const tip: V3 = [p[0], p[1] + 0.55, p[2] + 0.055];
          k.add(cyl(p, tip, 0.0062, 0.003, 6), surf(0x2a2e36, 0.4, 0.6));
          k.add(octa(tip[0], tip[1] + 0.006, tip[2], 0.01, 1), { c: 0xff4040, r: 0.3, m: 0, e: 1.2, fx: 2 });
        },
      },
    ],
  },

  // Crimson Cape — the classic; a gold yoke, spring-simulated cloth.
  'back.cape.crimson': {
    build(k) {
      yoke(k, paint(0x8c1220, 0.72, 0.04), GOLD, GOLD);
    },
    cape: cape({
      bands: [
        [0, paint(0xa0131f, 0.75, 0.03)],
        [0.94, GOLD_DARK],
      ],
    }),
  },

  // Jetpack — twin tanks with accent stripes, fins, hot nozzles.
  'back.jetpack': {
    build(k) {
      const tankS = surf(0xc4ccd6, 0.28, 0.85);
      const seg = k.seg(14, 9);
      for (const sx of [1, -1]) {
        const o = { x0: sx * 0.078, z0: 0.264 };
        k.add(revolve([[0, 1.15], [0.03, 1.152], [0.052, 1.17], [0.056, 1.2], [0.056, 1.4], [0.05, 1.44], [0.03, 1.458], [0, 1.46]], seg, o), tankS);
        k.add(revolve([[0.0575, 1.37], [0.0575, 1.398]], seg, o), accent(0xdddddd, 0.35, 0.3));
        k.add(revolve([[0.0575, 1.215], [0.0575, 1.23]], seg, o), accent(0xdddddd, 0.35, 0.3));
        k.add(revolve([[0.03, 1.152], [0.036, 1.13], [0.046, 1.09], [0.042, 1.087], [0.03, 1.105]], seg, o), GUNMETAL);
        k.add(revolve([[0, 1.1], [0.034, 1.092]], seg, o), { c: 0xff8a2a, r: 0.3, m: 0, e: 1.8, fx: 2 });
        k.add(cyl([sx * 0.078, 1.458, 0.264], [sx * 0.078, 1.482, 0.264], 0.012, 0.01, 8), GUNMETAL);
        k.add(hull([[sx * 0.13, 1.19, 0.26], [sx * 0.13, 1.32, 0.26], [sx * 0.178, 1.16, 0.266], [sx * 0.13, 1.19, 0.27], [sx * 0.13, 1.32, 0.27], [sx * 0.178, 1.16, 0.274]]), accent(0xbbbbbb, 0.4, 0.3));
        shoulderStrap(k, [sx * 0.07, 1.44, 0.21], surf(0x1c1f25, 0.6, 0.2));
      }
      k.add(cbox(0, 1.3, 0.232, 0.062, 0.26, 0.06, 0.012), GUNMETAL);
      k.add(cbox(0, 1.34, 0.263, 0.03, 0.05, 0.004, 0.001), hardLight(0xffffff, 1.1, 1));
    },
  },

  // Katana — sheathed diagonally, hilt over the right shoulder.
  'back.katana': {
    build(k) {
      const m0 = k.mark();
      const lac = surf(0x121216, 0.18, 0.35);
      const seg = k.seg(8, 6);
      const saya = (a: number, b: number, s: Surf, r = 0.02) => k.add(sweep([[0, a, 0], [0, b, 0]], r, seg, { sy: 0.62, up: [1, 0, 0] }), s);
      saya(0, 0.69, lac);
      saya(-0.004, 0.035, GOLD, 0.0215);
      saya(0.66, 0.695, GOLD, 0.0215);
      saya(0.6, 0.615, accent(0xdddddd, 0.7, 0), 0.0212);
      saya(0.575, 0.59, accent(0xdddddd, 0.7, 0), 0.0212);
      // Tsuba + habaki.
      k.add(sweep([[0, 0.695, 0], [0, 0.705, 0]], 0.042, k.seg(12, 8), { sy: 0.8, up: [1, 0, 0] }), GOLD_DARK);
      // Tsuka: alternating wrap.
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = 0.705 + (i * 0.2) / n;
        const b = 0.705 + ((i + 1) * 0.2) / n;
        saya(a, b, i % 2 ? surf(0xe8e2d0, 0.7, 0) : surf(0x1a1a22, 0.8, 0), i % 2 ? 0.0165 : 0.0175);
      }
      saya(0.905, 0.93, GOLD, 0.0178);
      // Sageo cord loop.
      k.add(sweep([[0.02, 0.6, 0], [0.05, 0.55, 0.006], [0.045, 0.49, 0.01], [0.022, 0.5, 0.004]], 0.004, 4, { smooth: 2 }), accent(0xdddddd, 0.7, 0));
      const d = new THREE.Vector3(0.56, 0.826, 0.03).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      k.xf(m0, M.compose(new THREE.Vector3(-0.2, 1.02, 0.232), q, new THREE.Vector3(1, 1, 1)));
      // Straps to the pack.
      k.add(cbox(0, 0, 0, 0.026, 0.1, 0.008, 0.002).rotateZ(0.6).translate(-0.032, 1.268, 0.25), LEATHER);
      k.add(cbox(0, 0, 0, 0.026, 0.1, 0.008, 0.002).rotateZ(0.6).translate(0.075, 1.425, 0.25), LEATHER);
    },
  },

  // Kite Shield — emblazoned in your colour: steel rim, cream chevron, boss.
  'back.shield': {
    build(k) {
      const s = new THREE.Shape();
      s.moveTo(-0.17, 0.22);
      s.quadraticCurveTo(0, 0.25, 0.17, 0.22);
      s.quadraticCurveTo(0.17, 0.05, 0.13, -0.08);
      s.quadraticCurveTo(0.07, -0.22, 0, -0.29);
      s.quadraticCurveTo(-0.07, -0.22, -0.13, -0.08);
      s.quadraticCurveTo(-0.17, 0.05, -0.17, 0.22);
      const bend = (g: THREE.BufferGeometry, dz = 0) => {
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          pos.setXYZ(i, x, pos.getY(i) + 1.24, pos.getZ(i) + 0.248 - 2.2 * x * x + dz);
        }
        return g;
      };
      k.add(bend(extrude(s, 0.018, 0.005, k.low ? 4 : 6, 0.05)), accent(0xd8d8d8, 0.38, 0.15));
      const rim = s.getPoints(k.low ? 4 : 6).map((p) => [p.x, p.y, 0.0145] as V3);
      k.add(bend(sweep(rim, 0.0075, 4, { caps: false })), STEEL);
      const chev = new THREE.Shape();
      chev.moveTo(-0.15, -0.04);
      chev.lineTo(0, 0.1);
      chev.lineTo(0.15, -0.04);
      chev.lineTo(0.15, -0.1);
      chev.lineTo(0, 0.04);
      chev.lineTo(-0.15, -0.1);
      chev.closePath();
      k.add(bend(extrude(chev, 0.004, 0, 2, 0.05), 0.013), surf(0xefe6cf, 0.45, 0.1));
      const boss = revolve([[0.034, 0], [0.03, 0.012], [0.016, 0.022], [0, 0.025]], k.seg(12, 8));
      boss.rotateX(PI / 2);
      boss.translate(0, 0.12, 0.012);
      k.add(bend(boss), STEEL);
    },
  },

  // Bat Wings — leathery, folded: scalloped membranes between finger bones.
  'back.wings.bat': {
    build(k) {
      const m0 = k.mark();
      const mem = surf(0x4a1624, 0.75, 0.05);
      const boneS = surf(0x1f1418, 0.5, 0.2);
      const R0: V3 = [0.05, 1.37, 0.212];
      const E: V3 = [0.2, 1.52, 0.25];
      const W: V3 = [0.305, 1.69, 0.272];
      const F: V3[] = [
        [0.47, 1.53, 0.292],
        [0.41, 1.3, 0.284],
        [0.26, 1.13, 0.262],
      ];
      const R1: V3 = [0.07, 1.22, 0.214];
      const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const scallop = (a: V3, b: V3): V3 => lerp(lerp(a, b, 0.5), W, 0.3);
      const rimPts: V3[] = [E, W, F[0], scallop(F[0], F[1]), F[1], scallop(F[1], F[2]), F[2], lerp(lerp(F[2], R1, 0.5), W, 0.2), R1, R0];
      const C: V3 = [0.25, 1.42, 0.285];
      const pos: number[] = [];
      for (let i = 0; i < rimPts.length; i++) {
        const a = rimPts[i];
        const b = rimPts[(i + 1) % rimPts.length];
        pos.push(...C, ...a, ...b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      k.add(g, mem);
      k.add(sweep([R0, E, W], (t) => 0.016 - 0.006 * t, 6, { smooth: 2 }), boneS);
      for (const f of F) k.add(sweep([W, lerp(W, f, 0.5), f], (t) => 0.008 - 0.005 * t, 5), boneS);
      k.add(cyl(W, [W[0] + 0.012, W[1] + 0.05, W[2]], 0.011, 0.001, 6), surf(0xe6dcc6, 0.4, 0.1));
      k.mirrorFrom(m0);
      k.add(cbox(0, 1.37, 0.205, 0.1, 0.06, 0.03, 0.01), boneS);
    },
  },

  // Axe of Rock — a flying-V in your colour, slung diagonally.
  'back.guitar': {
    build(k) {
      const m0 = k.mark();
      const body = new THREE.Shape();
      body.moveTo(-0.03, 0.02);
      body.lineTo(-0.2, -0.29);
      body.lineTo(-0.14, -0.32);
      body.lineTo(0, -0.1);
      body.lineTo(0.14, -0.32);
      body.lineTo(0.2, -0.29);
      body.lineTo(0.03, 0.02);
      body.closePath();
      k.add(extrude(body, 0.032, 0.004, 2), accent(0xe2e2e2, 0.22, 0.25));
      const guard = new THREE.Shape();
      guard.moveTo(-0.028, 0.0);
      guard.lineTo(-0.12, -0.18);
      guard.lineTo(-0.08, -0.19);
      guard.lineTo(0, -0.05);
      guard.lineTo(0.03, -0.02);
      guard.closePath();
      const gg = extrude(guard, 0.002);
      gg.translate(0, 0, 0.0195);
      k.add(gg, surf(0xf2efe8, 0.4, 0.05));
      k.add(cbox(0, 0.2, 0.0, 0.042, 0.42, 0.02, 0.004), surf(0x6a4428, 0.6, 0.05));
      k.add(cbox(0, 0.22, 0.011, 0.038, 0.38, 0.004, 0.001), surf(0x1c140e, 0.6, 0.05));
      const head = new THREE.Shape();
      head.moveTo(-0.024, 0);
      head.lineTo(-0.045, 0.1);
      head.lineTo(0, 0.08);
      head.lineTo(0.045, 0.12);
      head.lineTo(0.024, 0);
      head.closePath();
      const hg = extrude(head, 0.018);
      hg.translate(0, 0.41, 0);
      k.add(hg, surf(0x16161a, 0.3, 0.3));
      k.add(cbox(0, -0.04, 0.019, 0.05, 0.02, 0.008, 0.002), surf(0x15151a, 0.4, 0.5));
      k.add(cbox(0, -0.1, 0.019, 0.05, 0.02, 0.008, 0.002), surf(0x15151a, 0.4, 0.5));
      k.add(cbox(0, -0.15, 0.019, 0.05, 0.012, 0.006, 0.002), STEEL);
      for (let i = 0; i < 6; i++) k.add(cbox(-0.0125 + i * 0.005, 0.12, 0.0145, 0.0011, 0.54, 0.0011, 0.0003), surf(0xe8e8e8, 0.2, 1, { e: 0.15 }));
      for (const [x, y] of [[0.1, -0.2], [0.13, -0.24], [0.08, -0.25]] as [number, number][]) k.add(cyl([x, y, 0.016], [x, y, 0.028], 0.008, 0.007, 8), GOLD);
      k.xf(m0, place(-0.05, 1.13, 0.254, 0, 0, -0.4, 0.92));
      shoulderStrap(k, [0.08, 1.44, 0.23], surf(0x1c1f25, 0.7, 0.05));
    },
  },

  // Royal Cape — velvet in deep purple, ermine collar + hem, gold piping.
  'back.cape.royal': {
    build(k) {
      const ermine = surf(0xf4f1ea, 0.9, 0.02);
      yoke(k, ermine, GOLD, GOLD);
      // Ermine spots.
      for (let i = 0; i < 9; i++) {
        const a = -0.85 + (1.7 * i) / 8;
        const r = 0.176 + (i % 2) * 0.012;
        const y = 1.482 - (i % 2) * 0.018;
        k.add(cbox(Math.sin(a) * r, y, 0.02 + Math.cos(a) * r, 0.008, 0.016, 0.006, 0.002).rotateY(0), surf(0x121214, 0.8, 0));
      }
    },
    cape: cape({
      width: 0.32,
      hemWidth: 0.56,
      length: 0.8,
      bands: [
        [0, paint(0x4b1a78, 0.78, 0.05)],
        [0.86, GOLD],
        [0.885, surf(0xf4f1ea, 0.9, 0.02)],
      ],
      edge: { s: GOLD, w: 0.05 },
    }),
  },

  // Seraph Wings — layered, overlapping feathers on a gilded arm (folded,
  // tips down), faintly glowing.
  'back.wings.angel': {
    build(k) {
      const m0 = k.mark();
      const feather = surf(0xf6f2ea, 0.62, 0.02, { e: 0.16 });
      const featherB = surf(0xe4ddcf, 0.64, 0.02, { e: 0.1 });
      const arm = new THREE.CatmullRomCurve3(
        [new THREE.Vector3(0.05, 1.38, 0.214), new THREE.Vector3(0.17, 1.55, 0.25), new THREE.Vector3(0.3, 1.66, 0.29), new THREE.Vector3(0.43, 1.64, 0.31)],
        false,
        'centripetal',
      );
      k.add(sweep(arm.getPoints(10).map((p) => [p.x, p.y, p.z] as V3), (t) => 0.024 - 0.012 * t, 6), feather);
      k.add(sweep(arm.getPoints(10).map((p) => [p.x, p.y + 0.012, p.z + 0.012] as V3), (t) => 0.007 - 0.003 * t, 4), GOLD);
      // A broad feather: rounded tip, raised quill.
      const addFeather = (root: THREE.Vector3, dir: THREE.Vector3, L: number, w: number, dz: number, s: Surf) => {
        const side = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
        const p = (f: number, sw: number, z: number): V3 => {
          const q = root.clone().addScaledVector(dir, L * f).addScaledVector(side, sw);
          return [q.x, q.y, q.z + dz + z];
        };
        k.add(hull([p(0, -w * 0.5, 0), p(0, w * 0.5, 0), p(0.55, -w, 0), p(0.55, w, 0), p(0.88, -w * 0.7, 0), p(0.88, w * 0.7, 0), p(1, 0, 0), p(0.5, 0, 0.006)]), s);
      };
      // Primaries (long, outer) → secondaries (shorter, inner), overlapping.
      const n = k.low ? 7 : 11;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.88 * i) / (n - 1);
        const root = arm.getPoint(t);
        const a = 0.05 + 0.75 * t * t;
        const dir = new THREE.Vector3(Math.sin(a), -Math.cos(a), 0);
        const L = 0.2 + 0.24 * Math.sin(Math.min(1, t * 1.15) * PI * 0.6);
        addFeather(root, dir, L, 0.034, 0.004 + i * 0.0018, i % 2 ? featherB : feather);
      }
      // Coverts: short broad row over the arm.
      const nc = k.low ? 4 : 7;
      for (let i = 0; i < nc; i++) {
        const t = 0.15 + (0.8 * i) / (nc - 1);
        const root = arm.getPoint(t);
        const dir = new THREE.Vector3(0.25 + 0.4 * t, -1, 0).normalize();
        addFeather(root, dir, 0.1, 0.03, 0.028, feather);
      }
      k.mirrorFrom(m0);
      k.add(cbox(0, 1.38, 0.207, 0.1, 0.07, 0.03, 0.012), GOLD_DARK);
      k.add(octa(0, 1.38, 0.226, 0.014, 1.3), hardLight(0xfff4d6, 1.8));
    },
  },

  // Hardlight Wings (Relic) — five blades of light a side, fanned from a
  // floating emitter, in your colour.
  'back.wings.energy': {
    build(k) {
      k.add(cbox(0, 1.35, 0.214, 0.11, 0.13, 0.04, 0.012), GUNMETAL);
      k.add(cbox(0, 1.35, 0.235, 0.07, 0.09, 0.004, 0.002), hardLight(0xffffff, 1.6, 1));
      const m0 = k.mark();
      k.add(cbox(0.062, 1.38, 0.23, 0.012, 0.05, 0.02, 0.004), GUNMETAL);
      const angles = [0.95, 1.2, 1.45, 1.7, 1.95];
      const lens = [0.5, 0.46, 0.4, 0.33, 0.25];
      angles.forEach((a, i) => {
        const base = new THREE.Vector3(0.1 + i * 0.012, 1.44 - i * 0.03, 0.25);
        const dir = new THREE.Vector3(Math.sin(a), Math.cos(a) + 0.25, 0.1).normalize();
        const side = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
        const r0 = base.clone().addScaledVector(dir, 0.04);
        const L = lens[i];
        const w0 = 0.045;
        const pt = (f: number, s: number, z: number): V3 => {
          const q = r0.clone().addScaledVector(dir, L * f).addScaledVector(side, s * (w0 * (1 - f * 0.8) + 0.004));
          return [q.x, q.y, q.z + z + i * 0.006];
        };
        k.add(hull([pt(0, -1, 0), pt(0, 1, 0), pt(1, -0.2, 0), pt(0, -1, 0.004), pt(0, 1, 0.004), pt(1, -0.2, 0.004), pt(0.6, 1, 0.002)]), hardLight(0xffffff, 1.1, 1));
        k.add(sweep([pt(0, 1, 0.006), pt(0.6, 1, 0.006), pt(1, -0.2, 0.006)], 0.0032, 4), hardLight(0xffffff, 2.4, 1));
      });
      k.mirrorFrom(m0);
    },
  },

  // Sovereign Mantle (staff) — a white-and-gold cloak and a hard-light halo
  // ring turning behind the shoulders.
  'back.sovereign': {
    build(k) {
      yoke(k, surf(0xf6f3ec, 0.4, 0.1), GOLD, hardLight(0xfff4d6, 2.2));
      k.add(revolve([[0.155, 1.504], [0.158, 1.51]], k.seg(12, 8), { phi0: -1.0, phiLen: 2.0, z0: 0.02 }), GOLD);
    },
    cape: cape({
      width: 0.3,
      hemWidth: 0.52,
      length: 0.8,
      bands: [
        [0, surf(0xf6f3ec, 0.55, 0.05)],
        [0.9, GOLD],
        [0.94, hardLight(0xfff1c8, 1.4)],
      ],
      edge: { s: GOLD, w: 0.06 },
    }),
    subs: [
      {
        pivot: [0, 1.6, 0.27],
        anim: { kind: 'spin', axis: [0, 0, 1], rate: 0.35 },
        build(k) {
          const c: V3 = [0, 1.6, 0.27];
          const seg = k.seg(40, 24);
          const ring = revolve([[0.19, -0.005], [0.206, -0.005], [0.206, 0.005], [0.19, 0.005], [0.19, -0.005]], seg);
          ring.rotateX(PI / 2);
          ring.translate(c[0], c[1], c[2]);
          k.add(ring, hardLight(0xffe7a8, 1.6));
          const inner = revolve([[0.17, 0], [0.176, 0]], seg);
          inner.rotateX(PI / 2);
          inner.translate(c[0], c[1], c[2] + 0.002);
          k.add(inner, hardLight(0xffffff, 2.4));
          const n = 12;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * PI * 2;
            const long = i % 2 === 0;
            const g = octa(0, 0, 0, 0.008, long ? 4.5 : 2.6);
            g.rotateZ(-a);
            const r = 0.206 + (long ? 0.036 : 0.021);
            g.translate(c[0] + Math.sin(a) * r, c[1] + Math.cos(a) * r, c[2]);
            k.add(g, hardLight(long ? 0xffffff : 0xffd98a, 2.2));
          }
        },
      },
    ],
  },
};
