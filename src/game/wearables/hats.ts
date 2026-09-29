import * as THREE from 'three';
import {
  CHROME,
  DARK,
  GOLD,
  GOLD_DARK,
  GUNMETAL,
  HELM_Z0,
  HELM_ZS,
  Kit,
  STEEL,
  WHITE,
  accent,
  ball,
  cbox,
  cyl,
  domeProfile,
  deform,
  domeY,
  ellipsePath,
  extrude,
  faceOut,
  glow,
  hardLight,
  helmR,
  helmRadiusAt,
  hull,
  octa,
  onHelm,
  paint,
  plate,
  revolve,
  rot,
  shell,
  spiralPath,
  starShape,
  stringLights,
  surf,
  sweep,
  type Surf,
  type V3,
} from './kit';
import type { WearSpec } from './spec';

// ── Hats ─────────────────────────────────────────────────────────────────────
// Authored around the combatant's helmet (character/body.ts): dome equator
// y 1.68 (r 0.146, the ellipse is 1.13× deeper than wide, +0.006 back), crown
// 1.794, visor band 1.631–1.679 across the front ±70°, ear pods x ±0.128–0.165
// at y 1.585–1.679. Everything a hat puts on the helmet starts at y ≥ 1.683 so
// the visor stays clear; brims ride just above it.

const PI = Math.PI;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const sm = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// A conformal band ring (with thickness) around the helmet between y0..y1.
function band(y0: number, y1: number, off: number, thick: number, seg: number, o: { phi0?: number; phiLen?: number } = {}) {
  const r0 = helmR(y0) + off;
  const r1 = helmR(y1) + off;
  return shell(
    [
      [r0 - thick * 0.5, y0],
      [r0 + thick, y0],
      [r1 + thick, y1],
      [r1 - thick * 0.5, y1],
    ],
    seg,
    o,
  );
}

// A skull cap: the dome pushed out by `off`, from y0 to the crown, optionally
// stretched taller (`ys`) from its base.
function skullcap(off: number, y0: number, seg: number, ys = 1, o: Parameters<typeof shell>[2] = {}) {
  const prof = domeProfile(off, y0).map(([r, y]) => [r, y0 + (y - y0) * ys] as [number, number]);
  // Thick bottom lip.
  prof.unshift([Math.max(0, prof[0][0] - 0.006), prof[0][1]]);
  return shell(prof, seg, o);
}

function capTop(off: number, y0: number, ys: number): number {
  return y0 + (1.794 + off - y0) * ys;
}

// A curved cap brim in front: arc ±`arc` rad, length L (front) shrinking to
// the sides, drooping `droop` at the sides.
function brim(k: Kit, y: number, root: number, L: number, arc: number, droop: number, dip: number, top: Surf, under: Surf, thick = 0.007) {
  const nu = k.seg(10, 6);
  k.addPlate(
    plate(
      (u, v) => {
        const s = u * 2 - 1;
        const a = PI + s * arc;
        const len = L * (1 - 0.62 * s * s);
        const dx = Math.sin(a);
        const dz = Math.cos(a) * HELM_ZS;
        const n = Math.hypot(dx, dz);
        return [
          root * dx + (dx / n) * len * v,
          y - dip * v - droop * s * s * v,
          HELM_Z0 + root * dz + (dz / n) * len * v,
        ] as V3;
      },
      nu,
      3,
      thick,
    ),
    top,
    under,
    under,
  );
}

// Festive lights around a conformal band.
function festiveBand(k: Kit, y: number, off: number, bulbs = 12) {
  stringLights(k, ellipsePath(y, helmR(y) + off, 16), { bulbs });
}

// Spiral lights around an (elliptical) crown.
function festiveSpiral(k: Kit, y0: number, y1: number, r0: number, r1: number, turns: number, zs = 1.1, bulbs = 14, z0 = HELM_Z0) {
  const pts = spiralPath(y0, y1, r0, r1, turns, 30).map(([x, y, z]) => [x, y, z0 + z * zs] as V3);
  stringLights(k, pts, { closed: false, bulbs, droop: 0.006 });
}

// Pinch + crease for felt crowns (fedora / cowboy).
function feltCrown(profile: [number, number][], seg: number, pinch: number, crease: number, zs = 1.1) {
  const n = profile.length;
  return revolve(profile, seg, {
    zs,
    z0: HELM_Z0,
    rmul: (phi, t) => 1 - pinch * t * t * Math.max(0, -Math.cos(phi)) ** 2,
    ydel: (phi, t) => {
      if (t >= 1 - 0.5 / n) return 0;
      return -crease * sm(0.45, 0.85, t) * (1 - Math.abs(Math.sin(phi)));
    },
  });
}

const LEATHER_BAND = surf(0x2a1a10, 0.6, 0.1);

// The skull cap's (r, y) profile (as skullcap() builds it).
function skullProfile(off: number, y0: number, ys = 1): [number, number][] {
  return domeProfile(off, y0).map(([r, y]) => [r, y0 + (y - y0) * ys] as [number, number]);
}

// A path over a cap profile in the vertical plane x = x0 (front → over → back),
// lifted `lift` off the surface. For ridges, keels and straps.
function ridgePath(prof: [number, number][], x0: number, lift: number): V3[] {
  const ax = Math.abs(x0);
  const half: [number, number][] = []; // (horizontal depth, y) from the bottom up
  for (let i = 0; i < prof.length; i++) {
    const [r, y] = prof[i];
    if (r + lift >= ax) {
      half.push([Math.sqrt(Math.max(0, (r + lift) ** 2 - ax * ax)), y + (i === prof.length - 1 ? lift : 0)]);
    } else {
      const [rp, yp] = prof[i - 1];
      const f = (rp + lift - ax) / Math.max(1e-6, rp - r);
      half.push([0, yp + (y - yp) * f]);
      break;
    }
  }
  const out: V3[] = [];
  for (let i = 0; i < half.length; i++) out.push([x0, half[i][1], HELM_Z0 - HELM_ZS * half[i][0]]);
  for (let i = half.length - 2; i >= 0; i--) out.push([x0, half[i][1], HELM_Z0 + HELM_ZS * half[i][0]]);
  return out;
}

const M = new THREE.Matrix4();
const place = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  M.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

// ── Builders ────────────────────────────────────────────────────────────────

export const HAT_SPECS: Record<string, WearSpec> = {
  // Field Cap — the wearer's colour, soft six-panel crown, curved bill.
  'hat.cap': {
    // A patrol cap: straight sides, a flat top raked forward, short bill —
    // boxy where the Ballcap Pro is domed and the Beanie is slouched.
    build(k) {
      const cloth = accent(0xdadada, 0.7, 0.03);
      k.add(
        shell(
          [
            [0.146, 1.684],
            [0.158, 1.687],
            [0.16, 1.75],
            [0.157, 1.808],
            [0.12, 1.812],
            [0, 1.814],
          ],
          k.seg(12),
          { ydel: (phi, t) => (t > 0.5 ? -0.014 * Math.cos(phi) * (t - 0.5) * 2 : 0) },
        ),
        cloth,
      );
      k.add(band(1.684, 1.706, 0.016, 0.004, k.seg(12)), surf(0x2a2e25, 0.75, 0.05));
      brim(k, 1.694, helmR(1.694) + 0.016, 0.09, 1.1, 0.02, 0.012, accent(0x8a8a8a, 0.6, 0.04), surf(0x2b3326, 0.8, 0.02));
      // Front badge: a light hexagon with an accent core.
      const p: V3 = [0, 1.752, HELM_Z0 - HELM_ZS * 0.162];
      k.add(faceOut(cyl([0, 0, 0], [0, 0, -0.004], 0.02, 0.02, 6), PI, p), surf(0xe9e5d8, 0.7, 0));
      k.add(faceOut(cyl([0, 0, -0.002], [0, 0, -0.006], 0.011, 0.011, 6), PI, p), accent(0x777777, 0.5, 0.1));
    },
    festive: (k) => festiveBand(k, 1.705, 0.022),
  },

  // Beanie — ribbed knit, rolled cuff, white pom-pom.
  'hat.beanie': {
    build(k) {
      const seg = k.seg(32, 16);
      const ribs = (amt: number) => (phi: number) => 1 + amt * Math.cos(16 * phi);
      k.add(
        shell(
          [
            [0.144, 1.683],
            [0.17, 1.686],
            [0.175, 1.705],
            [0.171, 1.727],
            [0.15, 1.731],
          ],
          seg,
          { rmul: ribs(0.02) },
        ),
        accent(0x8c8c8c, 0.85, 0),
      );
      const YS = 1.6;
      const prof = domeProfile(0.022, 1.725, 1.794, 7).map(([r, y]) => [r, 1.725 + (y - 1.725) * YS] as [number, number]);
      // Slouch: the crown folds back and down.
      const slouch = (v: THREE.Vector3) => {
        const t = clamp01((v.y - 1.76) / 0.11);
        v.z += 0.055 * t * t;
        v.y -= 0.022 * t * t;
      };
      k.add(
        deform(
          shell(prof, seg, {
            rmul: (phi, t) => 1 + 0.012 * Math.cos(16 * phi) * (1 - t),
          }),
          slouch,
        ),
        accent(0xd8d8d8, 0.88, 0),
      );
      // A contrast stripe.
      k.add(deform(shell([[helmR(1.755) + 0.0245, 1.752], [helmR(1.766) + 0.0245, 1.763]].map(([r, y]) => [r, 1.725 + (y - 1.725) * YS] as [number, number]), seg), slouch), surf(0xf1eee6, 0.88, 0));
      const top = new THREE.Vector3(0, 1.725 + (1.794 + 0.022 - 1.725) * YS, HELM_Z0);
      slouch(top);
      k.add(ball(top.x, top.y + 0.02, top.z + 0.02, 0.05, k.low ? 0 : 1), surf(0xf4f1ea, 0.95, 0));
    },
    festive: (k) => festiveBand(k, 1.708, 0.034),
  },

  // Bandana — a do-rag tied at the back, tails hanging, white dots.
  'hat.bandana': {
    build(k) {
      const red = paint(0xb3202a, 0.78, 0.02);
      k.add(skullcap(0.009, 1.684, k.seg(14)), red);
      // Knot + tails at the back.
      const kz = HELM_Z0 + HELM_ZS * (helmR(1.705) + 0.012);
      k.add(ball(0, 1.705, kz + 0.006, 0.02, 0, 0.85), red);
      k.add(ball(0.022, 1.706, kz, 0.017, 0, 0.8), red);
      k.add(ball(-0.022, 1.706, kz, 0.017, 0, 0.8), red);
      for (const sx of [1, -1]) {
        k.add(
          plate(
            (u, v) => {
              const w = 0.03 * (1 - 0.45 * v);
              return [sx * (0.006 + 0.045 * v) + (u - 0.5) * w, 1.702 - 0.1 * v, kz + 0.012 + 0.05 * v + 0.012 * Math.sin(v * PI)] as V3;
            },
            1,
            3,
          ).top,
          red,
        );
      }
      // Polka dots.
      const dot = surf(0xf2eee4, 0.8, 0);
      for (let i = 0; i < 16; i++) {
        const phi = (i * 2.39996) % (2 * PI);
        const y = 1.698 + ((i * 0.618) % 1) * 0.075;
        if (Math.cos(phi) > 0.8 && y < 1.72) continue; // not under the knot
        const p = onHelm(phi, y, 0.0105);
        k.add(faceOut(cyl([0, 0, 0.001], [0, 0, -0.0015], 0.0075, 0.0075, 6), phi, p, -(y - 1.69) * 5), dot);
      }
    },
    festive: (k) => festiveBand(k, 1.7, 0.02),
  },

  // Party Hat — a jaunty striped cone with a tinsel pom and a ruffle.
  'hat.party': {
    build(k) {
      const m0 = k.mark();
      const seg = k.seg(16, 10);
      const H = 0.17;
      const R = 0.084;
      const bands: Surf[] = [accent(0xe0e0e0, 0.4, 0.1), surf(0xf6f3ec, 0.45, 0.05)];
      const N = 5;
      for (let i = 0; i < N; i++) {
        const f0 = i / N;
        const f1 = (i + 1) / N;
        k.add(
          revolve(
            [
              [R * (1 - f0), H * f0],
              [R * (1 - f1), H * f1],
            ],
            seg,
          ),
          bands[i % 2],
        );
      }
      // Ruffle.
      k.add(
        revolve(
          [
            [R * 0.95, 0.018],
            [R + 0.028, 0.006],
            [R * 0.95, -0.004],
          ],
          k.seg(36, 18),
          { rmul: (phi, t) => (t > 0.3 && t < 0.7 ? 1 + 0.1 * Math.abs(Math.sin(9 * phi)) : 1) },
        ),
        surf(0xffd23b, 0.45, 0.2),
      );
      k.add(ball(0, H + 0.018, 0, 0.03, 0), surf(0xffd23b, 0.3, 0.7));
      k.xf(m0, place(0.012, 1.772, 0.01, 0.1, 0, -0.2));
    },
    festive(k) {
      const m0 = k.mark();
      stringLights(k, spiralPath(0.02, 0.14, 0.082, 0.03, 1.8, 22), { closed: false, bulbs: 10, droop: 0.005, size: 0.009 });
      k.xf(m0, place(0.012, 1.772, 0.01, 0.1, 0, -0.2));
    },
  },

  // Ballcap Pro — a structured high crown, dead-flat brim, gold sticker.
  'hat.baseball': {
    build(k) {
      const navy = paint(0x1f2d52, 0.62, 0.04);
      k.add(
        skullcap(0.012, 1.684, k.seg(12), 1.14, {
          ydel: (phi, t) => (t > 0.3 ? 0.012 * Math.max(0, -Math.cos(phi)) * t : 0),
        }),
        navy,
      );
      brim(k, 1.692, helmR(1.692) + 0.01, 0.135, 1.15, 0.006, 0.008, navy, surf(0x2d5a33, 0.8, 0.02), 0.006);
      const ct = capTop(0.012, 1.684, 1.14);
      k.add(cyl([0, ct - 0.004, HELM_Z0], [0, ct + 0.007, HELM_Z0], 0.014, 0.011, 8), navy);
      // Sticker on the brim.
      k.add(cyl([0.05, 1.6865, -0.25], [0.05, 1.6885, -0.25], 0.013, 0.013, 10), glow(0xf2c14a, 0.25, { r: 0.25, m: 0.8 }));
      // Front logo: white roundel + accent star.
      const p = onHelm(PI, 1.748, 0.016);
      k.add(faceOut(cyl([0, 0, 0.002], [0, 0, -0.003], 0.027, 0.027, 12), PI, [p[0], p[1] + 0.004, p[2]], -0.45), WHITE);
      k.add(faceOut(extrude(starShape(5, 0.018, 0.008), 0.003), PI, [p[0], p[1] + 0.004, p[2] - 0.004], -0.45), accent(0xffffff, 0.4, 0.1));
    },
    festive: (k) => festiveBand(k, 1.708, 0.022),
  },

  // Hard Hat — yellow shell, ridges, a full brim with a peak, and a lamp.
  'hat.hardhat': {
    build(k) {
      const yel = paint(0xf2b705, 0.42, 0.08);
      k.add(skullcap(0.022, 1.69, k.seg(16), 1.1), yel);
      k.add(
        shell(
          [
            [0.16, 1.694],
            [0.192, 1.69],
            [0.196, 1.683],
            [0.188, 1.681],
            [0.158, 1.686],
          ],
          k.seg(24, 14),
          { rmul: (phi, t) => (t > 0.1 && t < 0.9 ? 1 + 0.2 * Math.max(0, -Math.cos(phi)) ** 3 : 1) },
        ),
        yel,
      );
      // Ridges over the crown (front → back).
      const prof = skullProfile(0.022, 1.69, 1.1);
      for (const x of [0, -0.045, 0.045]) k.add(sweep(ridgePath(prof, x, 0.004), 0.008, 4, { sy: 1.5, up: [1, 0, 0], smooth: 2 }), yel);
      // Lamp.
      const lz = HELM_Z0 - HELM_ZS * (helmR(1.74) + 0.022);
      k.add(cbox(0, 1.744, lz + 0.004, 0.05, 0.03, 0.02, 0.006), DARK);
      k.add(cyl([0, 1.748, lz - 0.004], [0, 1.748, lz - 0.03], 0.02, 0.024, 10), GUNMETAL);
      k.add(cyl([0, 1.748, lz - 0.03], [0, 1.748, lz - 0.033], 0.02, 0.02, 10), glow(0xfff1c0, 1.6));
    },
    festive: (k) => festiveBand(k, 1.71, 0.03),
  },

  // Studio Cans — big padded cups over the ear pods, an arched band.
  'hat.headphones': {
    keepCrest: true,
    build(k) {
      const Rx = 0.192;
      const Ry = 0.182;
      const cy = 1.642;
      const cz = 0.012;
      const pts: V3[] = [];
      for (let i = 0; i <= 14; i++) {
        const th = -1.42 + (2.84 * i) / 14;
        pts.push([Math.sin(th) * Rx, cy + Math.cos(th) * Ry, cz]);
      }
      k.add(sweep(pts, 0.017, 6, { sy: 0.42, up: [0, 0, 1] }), GUNMETAL);
      const pad: V3[] = [];
      for (let i = 0; i <= 8; i++) {
        const th = -0.62 + (1.24 * i) / 8;
        pad.push([Math.sin(th) * (Rx - 0.011), cy + Math.cos(th) * (Ry - 0.011), cz]);
      }
      k.add(sweep(pad, 0.016, 6, { sy: 0.5, up: [0, 0, 1] }), surf(0x22252b, 0.85, 0.05));
      // Cups (right; mirrored).
      const m0 = k.mark();
      k.add(cbox(0.19, 1.678, cz, 0.014, 0.03, 0.05, 0.004), GUNMETAL);
      k.add(cyl([0.168, 1.632, cz], [0.176, 1.632, cz], 0.064, 0.064, 14), surf(0x191b20, 0.9, 0));
      k.add(cyl([0.176, 1.632, cz], [0.214, 1.632, cz], 0.066, 0.06, 14), surf(0x2a2e36, 0.4, 0.6));
      k.add(cyl([0.212, 1.632, cz], [0.219, 1.632, cz], 0.057, 0.055, 14), accent(0xffffff, 0.3, 0.1, { e: 0.9 }));
      k.add(cyl([0.214, 1.632, cz], [0.223, 1.632, cz], 0.049, 0.046, 14), accent(0xbbbbbb, 0.35, 0.2));
      k.mirrorFrom(m0);
    },
    festive(k) {
      const pts: V3[] = [];
      for (let i = 0; i <= 12; i++) {
        const th = -1.3 + (2.6 * i) / 12;
        pts.push([Math.sin(th) * 0.205, 1.642 + Math.cos(th) * 0.195, 0.012]);
      }
      stringLights(k, pts, { closed: false, bulbs: 9, droop: 0.004 });
    },
  },

  // Beret — a soft felt disc slouched to one side, badge on the band.
  'hat.beret': {
    build(k) {
      const felt = paint(0x7b1f2c, 0.88, 0.02);
      const g = shell(
        [
          [0.146, 1.683],
          [0.153, 1.69],
          [0.158, 1.712],
          [0.19, 1.742],
          [0.204, 1.762],
          [0.176, 1.786],
          [0.1, 1.803],
          [0, 1.807],
        ],
        k.seg(18, 12),
      );
      const slouch = (v: THREE.Vector3) => {
        const t = clamp01((v.y - 1.715) / 0.09);
        v.x += 0.045 * t;
        v.z += 0.012 * t;
        v.y -= 0.24 * Math.max(0, v.x) * t;
      };
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i);
        slouch(tmp);
        pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
      k.add(g, felt);
      k.add(band(1.684, 1.698, 0.006, 0.004, k.seg(18, 12)), surf(0x15151a, 0.6, 0.1));
      const top = new THREE.Vector3(0, 1.807, HELM_Z0);
      slouch(top);
      k.add(cyl([top.x, top.y - 0.004, top.z], [top.x + 0.004, top.y + 0.014, top.z], 0.005, 0.003, 5), felt);
      // Badge (front-left).
      const phi = PI + 0.42;
      const p = onHelm(phi, 1.708, 0.016);
      const sh = new THREE.Shape();
      sh.moveTo(-0.017, 0.018);
      sh.lineTo(0.017, 0.018);
      sh.lineTo(0.017, -0.002);
      sh.lineTo(0, -0.02);
      sh.lineTo(-0.017, -0.002);
      sh.closePath();
      k.add(faceOut(extrude(sh, 0.004, 0.0015, 2), phi, p, -0.15), GOLD);
      k.add(faceOut(extrude(starShape(5, 0.009, 0.004), 0.003), phi, [p[0] + Math.sin(phi) * 0.004, p[1] + 0.002, p[2] + Math.cos(phi) * 0.004], -0.15), accent(0xffffff, 0.4, 0.2));
    },
    festive: (k) => festiveBand(k, 1.7, 0.022),
  },

  // Traffic Cone — orange, reflective bands, a square base that hugs the dome.
  'hat.cone': {
    build(k) {
      const or = paint(0xff6a13, 0.55, 0.02);
      const refl = surf(0xf4f4f4, 0.3, 0.3, { e: 0.12 });
      const W = 0.2;
      k.addPlate(
        plate(
          (u, v) => {
            const x = (u - 0.5) * W;
            const z = HELM_Z0 + (v - 0.5) * W;
            return [x, domeY(helmRadiusAt(x, z)) + 0.012, z] as V3;
          },
          k.seg(6, 4),
          k.seg(6, 4),
          0.012,
        ),
        or,
      );
      const seg = k.seg(16, 10);
      const y0 = 1.8;
      const sect = (a: number, b: number, s: Surf) => {
        const r = (f: number) => 0.08 - 0.062 * f;
        k.add(revolve([[r(a), y0 + 0.185 * a], [r(b), y0 + 0.185 * b]], seg, { z0: HELM_Z0 }), s);
      };
      sect(0, 0.3, or);
      sect(0.3, 0.44, refl);
      sect(0.44, 0.62, or);
      sect(0.62, 0.72, refl);
      sect(0.72, 1, or);
      k.add(revolve([[0.018, y0 + 0.185], [0.009, y0 + 0.18]], seg, { z0: HELM_Z0 }), surf(0x2a1a10, 0.8, 0));
    },
    festive(k) {
      stringLights(k, spiralPath(1.82, 1.97, 0.08, 0.034, 1.6, 22, 0, HELM_Z0), { closed: false, bulbs: 10, droop: 0.004, size: 0.009 });
    },
  },

  // Chef's Toque — pleated tall crown, puffed top, crisp band.
  'hat.chef': {
    build(k) {
      const white = surf(0xf3f1ea, 0.86, 0.02);
      k.add(band(1.684, 1.744, 0.008, 0.004, k.seg(18, 12)), surf(0xe4e8ee, 0.7, 0.02));
      k.add(
        revolve(
          [
            [0.146, 1.744],
            [0.156, 1.79],
            [0.168, 1.84],
            [0.178, 1.878],
          ],
          k.seg(28, 16),
          { zs: 1.08, z0: HELM_Z0, rmul: (phi) => 1 + 0.045 * Math.abs(Math.cos(7 * phi)) },
        ),
        white,
      );
      k.add(
        revolve(
          [
            [0.178, 1.878],
            [0.205, 1.9],
            [0.198, 1.94],
            [0.14, 1.968],
            [0, 1.976],
          ],
          k.seg(21, 14),
          { zs: 1.08, z0: HELM_Z0, rmul: (phi, t) => 1 + 0.05 * Math.cos(7 * phi + 0.6) * Math.sin(t * PI) },
        ),
        white,
      );
    },
    festive: (k) => festiveSpiral(k, 1.76, 1.87, 0.162, 0.185, 1.3, 1.08),
  },

  // Graduate — skull cap + mortarboard, a gold tassel that swings.
  'hat.graduation': {
    build(k) {
      const blk = paint(0x16171b, 0.55, 0.1);
      k.add(skullcap(0.01, 1.684, k.seg(14)), blk);
      k.add(cyl([0, 1.79, HELM_Z0], [0, 1.808, HELM_Z0], 0.07, 0.06, 8), blk);
      const m0 = k.mark();
      k.add(cbox(0, 0, 0, 0.34, 0.012, 0.34, 0.002), blk);
      k.xf(m0, place(0, 1.813, HELM_Z0, 0.03, 0.12, 0));
      k.add(cyl([0, 1.818, HELM_Z0], [0, 1.826, HELM_Z0], 0.012, 0.01, 8), GOLD);
      k.add(sweep([[0, 1.824, HELM_Z0], [0.07, 1.822, HELM_Z0 - 0.06], [0.132, 1.82, HELM_Z0 - 0.118]], 0.003, 4), GOLD);
    },
    subs: [
      {
        pivot: [0.132, 1.818, HELM_Z0 - 0.118],
        anim: { kind: 'swing', dir: [0, -1, 0], len: 0.08, stiff: 6, damp: 2.2, grav: 1 },
        build(k) {
          const p: V3 = [0.132, 1.818, HELM_Z0 - 0.118];
          k.add(sweep([p, [p[0], p[1] - 0.05, p[2]]], 0.003, 4), GOLD);
          k.add(cyl([p[0], p[1] - 0.05, p[2]], [p[0], p[1] - 0.056, p[2]], 0.006, 0.008, 6), GOLD);
          k.add(cyl([p[0], p[1] - 0.056, p[2]], [p[0], p[1] - 0.1, p[2]], 0.009, 0.014, 8), surf(0xf0c24a, 0.6, 0.4));
        },
      },
    ],
    festive(k) {
      const m0 = k.mark();
      stringLights(k, [[-0.17, 0.01, -0.17], [0.17, 0.01, -0.17], [0.17, 0.01, 0.17], [-0.17, 0.01, 0.17]], { bulbs: 12, droop: 0.01 });
      k.xf(m0, place(0, 1.813, HELM_Z0, 0.03, 0.12, 0));
    },
  },

  // Top Hat — tall silk crown, curled brim, a band in your colour.
  'hat.tophat': {
    build(k) {
      const silk = paint(0x16161b, 0.32, 0.15);
      k.add(
        shell(
          [
            [0.141, 1.69],
            [0.2, 1.692],
            [0.215, 1.702],
            [0.208, 1.709],
            [0.141, 1.701],
          ],
          k.seg(24, 14),
          { ydel: (phi, _t, r) => 0.03 * Math.sin(phi) ** 2 * clamp01((r - 0.15) / 0.065) ** 1.5 },
        ),
        silk,
      );
      const zs = 1.1;
      k.add(
        revolve(
          [
            [0.14, 1.695],
            [0.137, 1.75],
            [0.14, 1.86],
            [0.152, 1.985],
            [0.148, 1.992],
            [0, 1.992],
          ],
          k.seg(18, 12),
          { zs, z0: HELM_Z0 },
        ),
        silk,
      );
      k.add(revolve([[0.1405, 1.703], [0.1385, 1.752]], k.seg(18, 12), { zs, z0: HELM_Z0 }), accent(0xc8c8c8, 0.45, 0.1));
      // A bow on the band (left side).
      k.add(hull([[-0.14, 1.713, 0.0], [-0.14, 1.742, 0.0], [-0.152, 1.72, -0.02], [-0.152, 1.736, -0.02], [-0.152, 1.72, 0.02], [-0.152, 1.736, 0.02]]), accent(0xa0a0a0, 0.45, 0.1));
    },
    festive: (k) => festiveSpiral(k, 1.72, 1.97, 0.148, 0.158, 1.8, 1.1),
  },

  // Ten-Gallon — tall pinched crown, wide brim curled at the sides.
  'hat.cowboy': {
    build(k) {
      const felt = paint(0x7c4f2b, 0.78, 0.02);
      k.add(
        feltCrown(
          [
            [0.146, 1.69],
            [0.149, 1.75],
            [0.146, 1.82],
            [0.133, 1.874],
            [0.09, 1.886],
            [0.03, 1.874],
            [0, 1.852],
          ],
          k.seg(20, 12),
          0.2,
          0.022,
        ),
        felt,
      );
      k.add(
        revolve(
          [
            [0.145, 1.692],
            [0.22, 1.695],
            [0.285, 1.704],
            [0.298, 1.712],
            [0.286, 1.714],
            [0.22, 1.704],
            [0.145, 1.701],
          ],
          k.seg(28, 16),
          {
            zs: 1.08,
            z0: HELM_Z0,
            ydel: (phi, _t, r) => {
              const f = clamp01((r - 0.165) / 0.13);
              return 0.078 * Math.sin(phi) ** 2 * f * f - 0.014 * Math.cos(phi) ** 2 * f;
            },
          },
        ),
        felt,
      );
      k.add(revolve([[0.1505, 1.702], [0.1495, 1.736]], k.seg(20, 12), { zs: 1.1, z0: HELM_Z0 }), LEATHER_BAND);
      const p: V3 = [-0.153, 1.719, HELM_Z0 - 0.02];
      k.add(faceOut(cyl([0, 0, 0.002], [0, 0, -0.004], 0.014, 0.012, 8), -PI / 2 - 0.12, p), CHROME);
    },
    festive: (k) => festiveSpiral(k, 1.72, 1.85, 0.155, 0.14, 1.3, 1.1, 12),
  },

  // Fedora — centre crease, front pinch, brim snapped down in front.
  'hat.fedora': {
    build(k) {
      const felt = paint(0x62646c, 0.8, 0.02);
      k.add(
        feltCrown(
          [
            [0.145, 1.69],
            [0.147, 1.745],
            [0.141, 1.8],
            [0.126, 1.84],
            [0.08, 1.852],
            [0, 1.834],
          ],
          k.seg(20, 12),
          0.24,
          0.02,
        ),
        felt,
      );
      k.add(
        revolve(
          [
            [0.145, 1.692],
            [0.2, 1.698],
            [0.232, 1.705],
            [0.228, 1.711],
            [0.145, 1.702],
          ],
          k.seg(24, 14),
          {
            zs: 1.08,
            z0: HELM_Z0,
            ydel: (phi, _t, r) => {
              const f = clamp01((r - 0.15) / 0.08);
              return -0.036 * Math.max(0, -Math.cos(phi)) ** 2 * f + 0.022 * Math.max(0, Math.cos(phi)) ** 2 * f;
            },
          },
        ),
        felt,
      );
      k.add(revolve([[0.1495, 1.702], [0.148, 1.736]], k.seg(20, 12), { zs: 1.1, z0: HELM_Z0 }), surf(0x141418, 0.5, 0.1));
      // Feather tucked in the band (accent).
      k.add(
        plate(
          (u, v) => {
            const w = 0.016 * Math.sin(v * PI) * (u - 0.5);
            return [-0.152 - 0.006 * v, 1.715 + 0.075 * v, 0.03 + 0.02 * v + w * 1.2] as V3;
          },
          2,
          5,
        ).top,
        accent(0xffffff, 0.7, 0),
      );
    },
    festive: (k) => festiveSpiral(k, 1.72, 1.82, 0.152, 0.13, 1.2, 1.1, 11),
  },

  // Cat Ears — bolted to the helmet either side of the crest.
  'hat.catears': {
    keepCrest: true,
    build(k) {
      const m0 = k.mark();
      const A: V3 = [0.05, 1.783, -0.036];
      const B: V3 = [0.136, 1.738, -0.026];
      const C: V3 = [0.096, 1.762, 0.044];
      const D: V3 = [0.124, 1.9, -0.014];
      k.add(hull([A, B, C, D]), accent(0xe6e6e6, 0.55, 0.05));
      // Inner (pink) — a thin inset on the front face.
      const cen = [(A[0] + B[0] + D[0]) / 3, (A[1] + B[1] + D[1]) / 3, (A[2] + B[2] + D[2]) / 3];
      const sh = (p: V3, f: number, dz: number): V3 => [cen[0] + (p[0] - cen[0]) * f, cen[1] + (p[1] - cen[1]) * f - 0.008, cen[2] + (p[2] - cen[2]) * f + dz];
      k.add(hull([sh(A, 0.62, -0.006), sh(B, 0.62, -0.006), sh(D, 0.62, -0.006), sh(A, 0.62, 0.004), sh(B, 0.62, 0.004), sh(D, 0.62, 0.004)]), surf(0xff9ec4, 0.7, 0));
      // Mount: a low gunmetal base plate hugging the dome.
      const base = (p: V3, f: number): V3 => [p[0] + (p[0] - 0.093) * f, p[1] - 0.012, p[2] + (p[2] + 0.005) * f];
      k.add(hull([base(A, 0.08), base(B, 0.08), base(C, 0.08), [A[0], A[1] - 0.002, A[2]], [B[0], B[1] - 0.002, B[2]], [C[0], C[1] - 0.002, C[2]]]), accent(0x6a6a6a, 0.5, 0.2));
      k.mirrorFrom(m0);
    },
    festive(k) {
      stringLights(k, ellipsePath(1.705, helmR(1.705) + 0.02, 16), { bulbs: 12 });
    },
  },

  // Propeller Cap — four-panel beanie, a rotor that actually spins.
  'hat.propeller': {
    build(k) {
      const cols = [0xe03a3a, 0xf5c518, 0x2f6fe0, 0x2fae4f];
      const seg = k.seg(4, 2);
      for (let q = 0; q < 4; q++) {
        k.add(skullcap(0.012, 1.684, seg, 1.02, { phi0: PI + PI / 4 + (q * PI) / 2, phiLen: PI / 2 }), paint(cols[q], 0.55, 0.05));
      }
      brim(k, 1.69, helmR(1.69) + 0.01, 0.06, 0.9, 0.01, 0.01, paint(0xe03a3a, 0.55, 0.05), surf(0x2b2b30, 0.7, 0));
      const top = capTop(0.012, 1.684, 1.02);
      k.add(cyl([0, top - 0.003, HELM_Z0], [0, top + 0.004, HELM_Z0], 0.016, 0.012, 8), paint(0xf5c518, 0.4, 0.3));
      k.add(cyl([0, top, HELM_Z0], [0, top + 0.05, HELM_Z0], 0.0065, 0.0055, 6), STEEL);
    },
    subs: [
      {
        pivot: [0, 1.858, HELM_Z0],
        anim: { kind: 'spin', axis: [0, 1, 0], rate: 7, move: 2.2 },
        build(k) {
          const c: V3 = [0, 1.858, HELM_Z0];
          k.add(cyl([c[0], c[1] - 0.006, c[2]], [c[0], c[1] + 0.008, c[2]], 0.014, 0.01, 8), paint(0xe03a3a, 0.4, 0.2));
          for (const s of [1, -1]) {
            k.addPlate(
              plate(
                (u, v) => {
                  const x = s * (0.012 + 0.15 * u);
                  const w = (0.04 - 0.01 * u) * (v - 0.5);
                  const tw = 0.42 - 0.2 * u;
                  return [x, c[1] + w * Math.sin(tw) * s, c[2] + w * Math.cos(tw)] as V3;
                },
                4,
                1,
                0.003,
              ),
              paint(s > 0 ? 0xf5c518 : 0x2f6fe0, 0.4, 0.2),
            );
          }
        },
      },
    ],
    festive: (k) => festiveBand(k, 1.705, 0.022),
  },

  // Wizard Hat — a tall bent cone, droopy brim, stars and a crescent moon.
  'hat.wizard': {
    build(k) {
      const cloth = paint(0x2e2a8f, 0.72, 0.03);
      k.add(
        revolve(
          [
            [0.144, 1.69],
            [0.21, 1.7],
            [0.265, 1.692],
            [0.26, 1.699],
            [0.144, 1.703],
          ],
          k.seg(28, 16),
          { zs: 1.08, z0: HELM_Z0, ydel: (phi, _t, r) => -0.02 * clamp01((r - 0.16) / 0.1) * (1 + 0.6 * Math.sin(3 * phi + 0.5)) },
        ),
        cloth,
      );
      const spine = new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(0, 1.69, HELM_Z0),
          new THREE.Vector3(0, 1.79, HELM_Z0 + 0.006),
          new THREE.Vector3(0, 1.88, HELM_Z0 + 0.03),
          new THREE.Vector3(0.012, 1.945, HELM_Z0 + 0.09),
          new THREE.Vector3(0.022, 1.965, HELM_Z0 + 0.16),
          new THREE.Vector3(0.03, 1.93, HELM_Z0 + 0.22),
        ],
        false,
        'centripetal',
      );
      const n = k.low ? 10 : 16;
      const pts: V3[] = spine.getPoints(n).map((p) => [p.x, p.y, p.z]);
      const rad = (t: number) => 0.004 + 0.15 * (1 - t) ** 1.25;
      k.add(sweep(pts, rad, k.seg(12, 8), { sy: 1.1, up: [1, 0, 0] }), cloth);
      k.add(revolve([[0.155, 1.699], [0.149, 1.726]], k.seg(18, 12), { zs: 1.12, z0: HELM_Z0 }), GOLD_DARK);
      // Stars + moon on the crown.
      const starS = glow(0xf2c14a, 0.6, { r: 0.3, m: 0.8 });
      const stars: [number, number, number][] = [
        [0.3, PI - 0.9, 0.018],
        [0.42, PI + 0.8, 0.014],
        [0.5, 0.6, 0.016],
        [0.18, -1.4, 0.013],
        [0.62, PI + 0.1, 0.012],
      ];
      for (const [t, phi, s] of stars) {
        const p = spine.getPoint(t);
        const r = rad(t) * 0.98;
        k.add(faceOut(extrude(starShape(5, s, s * 0.42), 0.004), phi, [p.x + Math.sin(phi) * r, p.y, p.z + Math.cos(phi) * r * 1.1]), starS);
      }
      const moon = new THREE.Shape();
      moon.absarc(0, 0, 0.03, 0, PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0.014, 0.008, 0.026, 0, PI * 2, true);
      moon.holes.push(hole);
      const mp = spine.getPoint(0.2);
      k.add(faceOut(extrude(moon, 0.005, 0, 10), PI, [mp.x, mp.y, mp.z - rad(0.2) * 1.1 + 0.002]), starS);
    },
    festive: (k) => festiveSpiral(k, 1.72, 1.9, 0.14, 0.08, 1.5, 1.1, 12),
  },

  // Viking Helm — steel cap, bronze bands and rivets, big curved horns.
  'hat.viking': {
    build(k) {
      const bronze = surf(0xb07a3a, 0.36, 0.9);
      k.add(skullcap(0.02, 1.684, k.seg(16)), STEEL);
      k.add(band(1.684, 1.714, 0.02, 0.006, k.seg(24, 14)), bronze);
      const nr = k.low ? 8 : 10;
      for (let i = 0; i < nr; i++) {
        const phi = (i / nr) * PI * 2;
        const p = onHelm(phi, 1.699, 0.029);
        k.add(ball(p[0], p[1], p[2], 0.0055, 0), bronze);
      }
      // Cross straps over the crown.
      const vp = skullProfile(0.02, 1.684);
      const fb = ridgePath(vp, 0, 0.003);
      k.add(sweep(fb, 0.014, 4, { sy: 0.3, up: [1, 0, 0], smooth: 2 }), bronze);
      // Side to side: the same path turned 90° (x ↔ z about the helmet centre).
      const ss = fb.map(([, y, z]) => [(z - HELM_Z0) / HELM_ZS, y, HELM_Z0] as V3);
      k.add(sweep(ss, 0.014, 4, { sy: 0.3, up: [0, 0, 1], smooth: 2 }), bronze);
      // Horns.
      const m0 = k.mark();
      const horn: V3[] = [
        [0.148, 1.735, 0.0],
        [0.205, 1.76, -0.018],
        [0.25, 1.82, -0.038],
        [0.268, 1.89, -0.055],
        [0.256, 1.95, -0.06],
      ];
      k.add(sweep(horn, (t) => 0.036 * (1 - t) ** 0.85 + 0.003, k.seg(9, 6), { smooth: 2 }), surf(0xeadcbc, 0.55, 0.05));
      k.add(cyl([0.14, 1.732, 0.002], [0.166, 1.744, -0.004], 0.04, 0.038, 10), bronze);
      k.add(cyl([0.232, 1.79, -0.03], [0.24, 1.803, -0.034], 0.03, 0.028, 10), bronze);
      k.mirrorFrom(m0);
    },
    festive: (k) => festiveBand(k, 1.72, 0.032),
  },

  // Captain's Tricorn — brim turned up into three walls, gold trim, skull.
  'hat.pirate': {
    build(k) {
      const felt = paint(0x2a2830, 0.7, 0.05);
      k.add(skullcap(0.014, 1.684, k.seg(14), 1.06), felt);
      const tri = (phi: number) => {
        const d = (((phi - PI + PI / 3) % ((2 * PI) / 3)) + (2 * PI) / 3) % ((2 * PI) / 3) - PI / 3;
        const f = Math.cos(PI / 3) / Math.cos(PI / 3 - Math.abs(d));
        return 0.86 + 0.58 * (f - 0.5);
      };
      const cornerDip = (phi: number) => {
        const d = (((phi - PI + PI / 3) % ((2 * PI) / 3)) + (2 * PI) / 3) % ((2 * PI) / 3) - PI / 3;
        return 1 - Math.abs(d) / (PI / 3);
      };
      const seg = k.seg(36, 21);
      const wall: [number, number][] = [
        [0.15, 1.69],
        [0.232, 1.694],
        [0.24, 1.702],
        [0.217, 1.786],
        [0.207, 1.786],
        [0.222, 1.702],
        [0.15, 1.699],
      ];
      const opts = {
        zs: 1.05,
        z0: HELM_Z0,
        rmul: (phi: number, t: number) => (t > 0.1 && t < 0.95 ? tri(phi) : 1),
        ydel: (phi: number, t: number, r: number) => (t > 0.2 && t < 0.9 && r > 0.2 ? -0.045 * cornerDip(phi) ** 2 * clamp01((r - 0.2) / 0.02) : 0),
      };
      const mb = k.mark();
      k.add(revolve(wall, seg, opts), felt);
      // Gold trim along the wall's top edge.
      k.add(
        revolve(
          [
            [0.2215, 1.779],
            [0.2215, 1.794],
            [0.2035, 1.794],
            [0.2035, 1.779],
          ],
          seg,
          { zs: 1.05, z0: HELM_Z0, rmul: (phi) => tri(phi), ydel: (phi) => -0.045 * cornerDip(phi) ** 2 },
        ),
        GOLD,
      );
      // Tilted back ~7° and lifted so the front corner never shades the visor.
      k.xf(mb, new THREE.Matrix4().makeTranslation(0, 1.69, HELM_Z0).multiply(new THREE.Matrix4().makeRotationX(-0.12)).multiply(new THREE.Matrix4().makeTranslation(0, -1.69 + 0.008, -HELM_Z0)));
      // Skull & crossbones on the front crown.
      const bone = surf(0xeee8d8, 0.6, 0.05);
      const z = -0.142;
      k.add(ball(0, 1.768, z, 0.017, 0, 1.05), bone);
      k.add(cbox(0, 1.749, z + 0.002, 0.018, 0.01, 0.014, 0.003), bone);
      k.add(cyl([-0.03, 1.735, z + 0.006], [0.03, 1.795, z + 0.006], 0.004, 0.004, 5), bone);
      k.add(cyl([0.03, 1.735, z + 0.006], [-0.03, 1.795, z + 0.006], 0.004, 0.004, 5), bone);
      k.add(cbox(-0.006, 1.77, z - 0.015, 0.008, 0.008, 0.004, 0.002), surf(0x111111, 0.8, 0));
      k.add(cbox(0.006, 1.77, z - 0.015, 0.008, 0.008, 0.004, 0.002), surf(0x111111, 0.8, 0));
    },
    festive(k) {
      const pts: V3[] = [];
      for (let i = 0; i < 18; i++) {
        const phi = (i / 18) * PI * 2;
        const d = (((phi - PI + PI / 3) % ((2 * PI) / 3)) + (2 * PI) / 3) % ((2 * PI) / 3) - PI / 3;
        const f = Math.cos(PI / 3) / Math.cos(PI / 3 - Math.abs(d));
        const r = 0.225 * (0.86 + 0.58 * (f - 0.5));
        pts.push([r * Math.sin(phi), 1.75 - 0.03 * (1 - Math.abs(d) / (PI / 3)) ** 2, HELM_Z0 + 1.05 * r * Math.cos(phi)]);
      }
      stringLights(k, pts, { bulbs: 12 });
    },
  },

  // Devil Horns — two short glowing horns on the brow.
  'hat.devil': {
    keepCrest: true,
    build(k) {
      const m0 = k.mark();
      const horn: V3[] = [
        [0.062, 1.772, -0.07],
        [0.078, 1.83, -0.086],
        [0.103, 1.876, -0.07],
        [0.124, 1.905, -0.036],
        [0.13, 1.915, 0.0],
      ];
      k.add(sweep(horn, (t) => 0.026 * (1 - t) ** 0.9 + 0.0025, k.seg(9, 6), { smooth: k.low ? 2 : 3 }), { c: 0xd4202c, r: 0.35, m: 0.1, e: 0.75, fx: 2 });
      k.add(cyl([0.058, 1.765, -0.066], [0.066, 1.786, -0.074], 0.031, 0.029, 9), surf(0x2a1216, 0.4, 0.6));
      k.mirrorFrom(m0);
    },
    festive(k) {
      stringLights(k, ellipsePath(1.705, helmR(1.705) + 0.02, 16), { bulbs: 12 });
    },
  },

  // Kabuto — ribbed lacquer bowl, flared neck guard with lacing, gold crest.
  'hat.samurai': {
    build(k) {
      const lac = surf(0x3a0d12, 0.32, 0.12);
      const lame = surf(0x16141a, 0.36, 0.2);
      const lace = accent(0xd0d0d0, 0.7, 0.02);
      k.add(skullcap(0.022, 1.684, k.seg(16, 12), 1.04), lac);
      // Suji-bachi ribs: raised lines running up the bowl to the crown knob.
      const rib = ridgePath(skullProfile(0.022, 1.684, 1.04), 0, 0.003);
      const half = rib.slice(0, Math.ceil(rib.length / 2));
      const nRib = k.low ? 6 : 10;
      for (let i = 0; i < nRib; i++) {
        const a = (i / nRib) * PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Rotate the front half-path about the helmet axis (ellipse-aware).
        const pts = half.slice(0, -1).map(([, y, z]) => {
          const d = (HELM_Z0 - z) / HELM_ZS;
          return [d * sa, y, HELM_Z0 - d * ca * HELM_ZS] as V3;
        });
        k.add(sweep(pts, 0.0035, 3, { smooth: 2, caps: false }), surf(0x5a1a20, 0.3, 0.2));
      }
      const top = capTop(0.022, 1.684, 1.04);
      k.add(cyl([0, top - 0.006, HELM_Z0], [0, top + 0.01, HELM_Z0], 0.024, 0.018, 10), GOLD);
      brim(k, 1.692, helmR(1.692) + 0.02, 0.05, 1.05, 0.004, 0.018, lac, lame, 0.006);
      // Shikoro — three flared lames round the back and sides.
      const open = 1.32;
      const o = { zs: 1.1, z0: HELM_Z0, phi0: PI + open, phiLen: 2 * PI - 2 * open };
      const seg = k.seg(20, 12);
      const lames: [number, number, number, number][] = [
        [0.168, 1.694, 0.202, 1.646],
        [0.192, 1.656, 0.23, 1.606],
        [0.22, 1.616, 0.258, 1.568],
      ];
      for (const [r0, y0, r1, y1] of lames) {
        k.add(revolve([[r0, y0], [r1, y1], [r1 + 0.004, y1 + 0.006]], seg, o), lame);
        k.add(revolve([[r1 - 0.0045, y1 + 0.0075], [r1 + 0.0015, y1 - 0.0015]], seg, { ...o, zs: 1.1 }), lace);
      }
      // Fukigaeshi — the turned-back wings at the front of the neck guard.
      for (const s of [1, -1]) {
        const phi = PI + s * open;
        const a = [Math.sin(phi), Math.cos(phi) * 1.1];
        const t = [Math.cos(phi), -Math.sin(phi) * 1.1];
        k.addPlate(
          plate(
            (u, v) => {
              const r = 0.17 + 0.06 * v;
              const y = 1.698 - 0.1 * v;
              const out = 0.045 * u;
              return [a[0] * r + a[0] * out + s * t[0] * out * 0.8, y + 0.012 * u, HELM_Z0 + a[1] * r + a[1] * out + s * t[1] * out * 0.8] as V3;
            },
            1,
            2,
            0.005,
          ),
          lac,
          lame,
          GOLD,
        );
      }
      // Kuwagata — two tall gold blades + the maedate disc.
      const blade = new THREE.Shape();
      blade.moveTo(0.006, 0);
      blade.quadraticCurveTo(0.085, 0.06, 0.14, 0.235);
      blade.lineTo(0.098, 0.25);
      blade.quadraticCurveTo(0.05, 0.1, 0, 0.034);
      blade.closePath();
      const gold = { ...GOLD, e: 0.22 };
      const m0 = k.mark();
      k.add(extrude(blade, 0.006, 0, 5), gold);
      k.mirrorFrom(m0);
      k.xf(m0, place(0, 1.724, -0.186, -0.22, 0, 0));
      k.add(cyl([0, 1.734, -0.172], [0, 1.734, -0.19], 0.028, 0.028, 12), gold);
      k.add(faceOut(extrude(starShape(6, 0.018, 0.009), 0.004), PI, [0, 1.734, -0.192]), accent(0xffffff, 0.35, 0.3));
    },
    festive: (k) => festiveBand(k, 1.72, 0.034),
  },

  // Plumed Great Helm — steel helm with a keel, brow band, neck guard, and a
  // big plume in your colour that sways.
  'hat.knight': {
    build(k) {
      k.add(skullcap(0.02, 1.684, k.seg(16)), STEEL);
      // Keel ridge.
      k.add(sweep(ridgePath(skullProfile(0.02, 1.684), 0, 0.006), 0.01, 4, { sy: 0.4, up: [0, 1, 0], smooth: 2 }), STEEL);
      // Brow band (front) with a gilded edge.
      k.add(band(1.684, 1.708, 0.022, 0.006, k.seg(16, 10), { phi0: PI - 1.5, phiLen: 3.0 }), STEEL);
      k.add(band(1.704, 1.71, 0.028, 0.002, k.seg(16, 10), { phi0: PI - 1.5, phiLen: 3.0 }), GOLD_DARK);
      // Sallet tail (neck guard).
      k.add(revolve([[0.162, 1.694], [0.19, 1.645], [0.214, 1.605], [0.218, 1.61]], k.seg(14, 8), { zs: 1.1, z0: HELM_Z0, phi0: -1.25, phiLen: 2.5 }), STEEL);
      k.add(cyl([0, 1.796, 0.07], [0, 1.83, 0.092], 0.013, 0.011, 8), GOLD_DARK);
    },
    subs: [
      {
        pivot: [0, 1.83, 0.092],
        anim: { kind: 'swing', dir: [0, 0.45, 1], len: 0.2, stiff: 55, damp: 7, grav: 0.25 },
        build(k) {
          const P: V3 = [0, 1.83, 0.092];
          const plume = (dx: number, s: Surf, sc: number) => {
            const pts: V3[] = [
              [P[0] + dx * 0.3, P[1], P[2]],
              [P[0] + dx, P[1] + 0.07 * sc, P[2] + 0.03],
              [P[0] + dx * 1.2, P[1] + 0.105 * sc, P[2] + 0.11],
              [P[0] + dx * 1.3, P[1] + 0.08 * sc, P[2] + 0.2],
              [P[0] + dx * 1.2, P[1] + 0.02 * sc, P[2] + 0.265],
              [P[0] + dx, P[1] - 0.05 * sc, P[2] + 0.29],
            ];
            k.add(sweep(pts, (t) => 0.034 * Math.sin(PI * (0.12 + 0.88 * t)) + 0.005, k.seg(7, 5), { smooth: k.low ? 2 : 3, sy: 0.8 }), s);
          };
          plume(0.022, accent(0xe0e0e0, 0.85, 0), 1);
          plume(-0.022, accent(0xe0e0e0, 0.85, 0), 1);
          plume(0, surf(0xf2efe8, 0.85, 0), 1.12);
        },
      },
    ],
    festive: (k) => festiveBand(k, 1.72, 0.034),
  },

  // Jester's Cap — motley halves, three floppy points, bells that swing.
  'hat.jester': {
    build(k) {
      const a = accent(0xe0e0e0, 0.7, 0.02);
      const b = paint(0x3b1d5e, 0.72, 0.02);
      const g = paint(0xe8b73a, 0.5, 0.3);
      k.add(skullcap(0.014, 1.716, k.seg(8, 5), 1, { phi0: 0, phiLen: PI }), a);
      k.add(skullcap(0.014, 1.716, k.seg(8, 5), 1, { phi0: PI, phiLen: PI }), b);
      // Diamond band.
      const n = k.low ? 10 : 16;
      for (let i = 0; i < n; i++) {
        k.add(band(1.684, 1.72, 0.012, 0.005, 1, { phi0: (i / n) * PI * 2, phiLen: (PI * 2) / n }), i % 2 ? g : surf(0x1a1a20, 0.6, 0.1));
      }
      const sides = k.seg(8, 6);
      const prong = (pts: V3[], s: Surf) => k.add(sweep(pts, (t) => 0.05 * (1 - t) ** 1.1 + 0.01, sides, { smooth: k.low ? 2 : 3 }), s);
      prong(
        [
          [0.05, 1.79, 0.0],
          [0.14, 1.855, -0.005],
          [0.23, 1.868, 0.015],
          [0.29, 1.82, 0.03],
          [0.305, 1.755, 0.035],
        ],
        a,
      );
      prong(
        [
          [-0.05, 1.79, 0.0],
          [-0.14, 1.855, -0.005],
          [-0.23, 1.868, 0.015],
          [-0.29, 1.82, 0.03],
          [-0.305, 1.755, 0.035],
        ],
        b,
      );
      prong(
        [
          [0, 1.79, 0.05],
          [0, 1.875, 0.1],
          [0, 1.905, 0.19],
          [0, 1.86, 0.265],
          [0, 1.79, 0.285],
        ],
        g,
      );
    },
    subs: ([
      [0.305, 1.745, 0.035],
      [-0.305, 1.745, 0.035],
      [0, 1.78, 0.29],
    ] as V3[]).map((p) => ({
      pivot: p,
      anim: { kind: 'swing' as const, dir: [0, -1, 0] as V3, len: 0.03, stiff: 3, damp: 1.6, grav: 1 },
      build(k: Kit) {
        k.add(ball(p[0], p[1] - 0.026, p[2], 0.021, k.low ? 0 : 1), surf(0xf0c24a, 0.22, 1));
        k.add(cbox(p[0], p[1] - 0.036, p[2], 0.03, 0.004, 0.006, 0.001), surf(0x1a1206, 0.6, 0.3));
        k.add(cyl([p[0], p[1] + 0.004, p[2]], [p[0], p[1] - 0.008, p[2]], 0.005, 0.005, 5), GOLD_DARK);
      },
    })),
    festive: (k) => festiveBand(k, 1.702, 0.03),
  },

  // Crown — gold band, alternating points with pearls, a velvet cap in your
  // colour, jewels, and a subtle hard-light trim (Relic).
  'hat.crown': {
    build(k) {
      const gold = GOLD;
      const seg = k.seg(24, 16);
      k.add(band(1.69, 1.752, 0.012, 0.006, seg), gold);
      k.add(band(1.69, 1.695, 0.019, 0.002, seg), hardLight(0xffd98a, 1.1));
      const prof = domeProfile(0.006, 1.748, 1.794, 5).map(([r, y]) => [r, 1.748 + (y - 1.748) * 1.5] as [number, number]);
      k.add(shell(prof, k.seg(16, 10)), paint(0x8a1025, 0.85, 0.02));
      const N = 8;
      for (let i = 0; i < N; i++) {
        const phi = (i / N) * PI * 2;
        const tall = i % 2 === 0;
        const h = tall ? 0.085 : 0.05;
        const w = 0.33;
        const a0 = onHelm(phi - w, 1.748, 0.017);
        const a1 = onHelm(phi + w, 1.748, 0.017);
        const i0 = onHelm(phi - w, 1.748, 0.008);
        const i1 = onHelm(phi + w, 1.748, 0.008);
        const ap = onHelm(phi, 1.748, 0.024);
        const tip: V3 = [ap[0], 1.748 + h, ap[2]];
        k.add(hull([a0, a1, i0, i1, tip, [tip[0] * 0.95, tip[1] - 0.004, tip[2] * 0.95]]), gold);
        k.add(ball(tip[0], tip[1] + 0.008, tip[2], tall ? 0.011 : 0.008, 0), surf(0xf6f1e6, 0.25, 0.2));
        // Jewel on the band below each point.
        const jp = onHelm(phi, 1.721, 0.02);
        const jc = [0xd11a3a, 0x2a5bd7, 0x1fae5a, 0xd11a3a][i % 4];
        k.add(faceOut(octa(0, 0, 0, 0.012, 1.2), phi, jp), glow(jc, 0.45, { r: 0.1, m: 0.3 }));
      }
      // Arches + orb + cross.
      for (const side of [0, 1]) {
        const pts: V3[] = [];
        for (let i = 0; i <= 10; i++) {
          const a = -PI / 2 + (PI * i) / 10;
          const r = 0.15 * Math.sin(a);
          const y = 1.75 + 0.13 * Math.cos(a);
          pts.push(side ? [r, y, HELM_Z0] : [0, y, HELM_Z0 + r * 1.12]);
        }
        k.add(sweep(pts, 0.0065, 5, { smooth: 2 }), gold);
      }
      k.add(ball(0, 1.895, HELM_Z0, 0.021, 1), gold);
      k.add(cbox(0, 1.94, HELM_Z0, 0.012, 0.05, 0.012, 0.002), gold);
      k.add(cbox(0, 1.945, HELM_Z0, 0.036, 0.012, 0.012, 0.002), gold);
    },
    festive: (k) => festiveBand(k, 1.72, 0.03, 14),
  },

  // Seraph Circlet — a slim gold circlet and a floating ring of hard light.
  'hat.halo.relic': {
    keepCrest: true,
    build(k) {
      const seg = k.seg(24, 16);
      k.add(band(1.698, 1.712, 0.012, 0.004, seg), GOLD);
      // Winged gem at the brow.
      const p = onHelm(PI, 1.708, 0.02);
      k.add(faceOut(octa(0, 0, 0, 0.012, 1.3), PI, p), hardLight(0xfff0c8, 1.6));
      for (const s of [1, -1]) {
        const pts: V3[] = [
          [s * 0.012, 1.706, p[2] + 0.004],
          [s * 0.04, 1.722, p[2] + 0.012],
          [s * 0.058, 1.738, p[2] + 0.026],
        ];
        k.add(sweep(pts, (t) => 0.007 * (1 - t) + 0.002, 4, { sy: 0.35, up: [0, 0, 1] }), GOLD);
      }
    },
    subs: [
      {
        pivot: [0, 1.87, HELM_Z0 + 0.02],
        anim: { kind: 'bob', amp: 0.008, freq: 0.55 },
        build(k) {
          const y = 1.87;
          const seg = k.seg(40, 24);
          const m0 = k.mark();
          // A chunky band (reads at match distance) with a bright white core
          // on both faces; emissive kept moderate so bloom stays tidy.
          k.add(revolve([[0.108, -0.012], [0.152, -0.012], [0.158, 0], [0.152, 0.012], [0.108, 0.012], [0.102, 0], [0.108, -0.012]], seg), hardLight(0xffd98a, 1.4));
          k.add(revolve([[0.118, 0.0125], [0.142, 0.0125]], seg), hardLight(0xffffff, 2.1));
          k.add(revolve([[0.118, -0.0125], [0.142, -0.0125]], seg), hardLight(0xffffff, 2.1));
          // Tilted back a touch so it reads as a ring from the front.
          k.xf(m0, place(0, y, HELM_Z0 + 0.02, -0.28, 0, 0));
        },
      },
    ],
    festive: (k) => festiveBand(k, 1.705, 0.024),
  },

  // Voidcrown — jagged obsidian spikes with violet seams, flecks of starlight,
  // and shards that orbit.
  'hat.void': {
    build(k) {
      const obs = surf(0x0d0b14, 0.14, 0.7);
      const seam = hardLight(0xa855f7, 2.2);
      const seg = k.seg(24, 16);
      k.add(band(1.69, 1.738, 0.012, 0.006, seg), obs);
      k.add(band(1.736, 1.741, 0.018, 0.002, seg), seam);
      k.add(band(1.69, 1.694, 0.019, 0.002, seg), seam);
      const N = 7;
      for (let i = 0; i < N; i++) {
        const phi = PI + ((i - 3) / N) * PI * 2 * 0.98;
        const h = [0.1, 0.13, 0.17, 0.21, 0.17, 0.13, 0.1][i];
        const w = 0.3;
        const lean = 0.035;
        const a0 = onHelm(phi - w, 1.735, 0.018);
        const a1 = onHelm(phi + w, 1.735, 0.018);
        const i0 = onHelm(phi - w * 0.8, 1.735, 0.006);
        const i1 = onHelm(phi + w * 0.8, 1.735, 0.006);
        const out = onHelm(phi, 1.735, 0.018 + lean);
        const mid = onHelm(phi + 0.12, 1.735, 0.02 + lean * 0.5);
        const tip: V3 = [out[0], 1.735 + h, out[2]];
        const kink: V3 = [mid[0], 1.735 + h * 0.5, mid[2]];
        k.add(hull([a0, a1, i0, i1, kink, tip]), obs);
        k.add(sweep([onHelm(phi, 1.738, 0.021), [kink[0] * 1.02, kink[1], kink[2] * 1.02], [tip[0], tip[1] - 0.004, tip[2]]], (t) => 0.0035 * (1 - t) + 0.001, 3), seam);
      }
      // Starlight flecks.
      for (let i = 0; i < 14; i++) {
        const phi = (i * 2.39996) % (PI * 2);
        const p = onHelm(phi, 1.698 + ((i * 0.618) % 1) * 0.034, 0.0195);
        k.add(octa(p[0], p[1], p[2], 0.0035, 1), glow(0xffffff, 2.2));
      }
    },
    subs: [
      {
        pivot: [0, 1.86, HELM_Z0],
        anim: { kind: 'spin', axis: [0, 1, 0], rate: 0.9 },
        build(k) {
          const n = 4;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * PI * 2;
            const r = 0.205;
            const y = 1.86 + [0.02, -0.03, 0.035, -0.015][i];
            const g = octa(0, 0, 0, 0.026, 2.0);
            rot(g, 0.3 * i, a, 0.25);
            g.translate(Math.sin(a) * r, y, HELM_Z0 + Math.cos(a) * r);
            k.add(g, { c: 0x5a22a0, r: 0.2, m: 0.4, e: 1.6, fx: 2 });
          }
        },
      },
    ],
    festive: (k) => festiveBand(k, 1.71, 0.03),
  },

  // Sovereign Crown (staff) — a hard-light crown that hovers over the helmet,
  // gold filigree + white light, three jewels in orbit. Compact: it hugs the
  // head's silhouette.
  'hat.sovereign': {
    keepCrest: true,
    build() {
      /* everything floats — see subs */
    },
    subs: [
      {
        pivot: [0, 1.75, HELM_Z0],
        anim: { kind: 'bob', amp: 0.006, freq: 0.45 },
        build(k) {
          const zo = { zs: HELM_ZS, z0: HELM_Z0 };
          const seg = k.seg(40, 24);
          const R = 0.152;
          k.add(revolve([[R, 1.728], [R + 0.007, 1.73], [R + 0.008, 1.764], [R + 0.001, 1.766], [R, 1.728]], seg, zo), GOLD);
          k.add(revolve([[R + 0.0085, 1.737], [R + 0.0085, 1.757]], seg, zo), hardLight(0xfff4d6, 2.0));
          k.add(revolve([[R + 0.009, 1.727], [R + 0.013, 1.729], [R + 0.013, 1.733], [R + 0.009, 1.735]], seg, zo), GOLD_DARK);
          // Hard-light arches meeting over the crown, with a white orb.
          for (const side of [0, 1]) {
            const pts: V3[] = [];
            for (let i = 0; i <= 10; i++) {
              const a = -PI / 2 + (PI * i) / 10;
              const r = (R + 0.004) * Math.sin(a);
              const y = 1.764 + 0.078 * Math.cos(a);
              pts.push(side ? [r, y, HELM_Z0] : [0, y, HELM_Z0 + r * HELM_ZS]);
            }
            k.add(sweep(pts, 0.0045, 5, { smooth: 2 }), hardLight(0xffe7a8, 1.8));
          }
          k.add(octa(0, 1.858, HELM_Z0, 0.016, 1.3), hardLight(0xffffff, 2.8));
          // Front jewel on the band.
          k.add(faceOut(octa(0, 0, 0, 0.013, 1.3), PI, [0, 1.747, HELM_Z0 - HELM_ZS * (R + 0.013)]), hardLight(0xffffff, 2.8));
          const N = 5;
          for (let i = 0; i < N; i++) {
            const phi = PI + (i / N) * PI * 2;
            const p = [Math.sin(phi), Math.cos(phi) * HELM_ZS];
            const pt = (r: number, y: number): V3 => [p[0] * r, y, HELM_Z0 + p[1] * r];
            const w = 0.24;
            const side = (s: number, r: number, y: number): V3 => {
              const a = phi + s * w;
              return [Math.sin(a) * r, y, HELM_Z0 + Math.cos(a) * HELM_ZS * r];
            };
            // Fleur point: a gold frame around a hard-light blade.
            const H = i === 0 ? 1.872 : 1.848;
            k.add(hull([side(-1, R + 0.008, 1.764), side(1, R + 0.008, 1.764), side(-1, R + 0.001, 1.764), side(1, R + 0.001, 1.764), pt(R + 0.014, H), pt(R + 0.006, H)]), GOLD);
            k.add(hull([side(-0.55, R + 0.0095, 1.77), side(0.55, R + 0.0095, 1.77), pt(R + 0.0145, H - 0.02), pt(R + 0.0135, H - 0.02), side(-0.55, R + 0.009, 1.77), side(0.55, R + 0.009, 1.77)]), hardLight(0xffffff, 2.2));
            const tp = pt(R + 0.013, H + 0.009);
            k.add(octa(tp[0], tp[1], tp[2], i === 0 ? 0.014 : 0.01, 1.5), hardLight(0xfff4d6, 2.6));
            // Hard-light arcs between the points.
            const a0 = phi + w;
            const a1 = phi + (PI * 2) / N - w;
            k.add(
              revolve([[R + 0.004, 1.764], [R + 0.004, 1.79]], 4, {
                ...zo,
                phi0: a0,
                phiLen: a1 - a0,
                ydel: (ph, t) => (t > 0.5 ? -0.018 * Math.sin(((ph - a0) / (a1 - a0)) * PI) : 0),
              }),
              hardLight(0xffe7a8, 1.3),
            );
          }
        },
      },
      {
        pivot: [0, 1.79, HELM_Z0],
        anim: { kind: 'spin', axis: [0, 1, 0], rate: 0.8 },
        build(k) {
          const cols = [0xffffff, 0xffd98a, 0xfff4d6];
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * PI * 2;
            const r = 0.188;
            const g = octa(0, 0, 0, 0.012, 1.6);
            g.translate(Math.sin(a) * r, 1.79 + (i - 1) * 0.018, HELM_Z0 + Math.cos(a) * r * HELM_ZS);
            k.add(g, hardLight(cols[i], 2.4));
          }
        },
      },
    ],
    festive: (k) => festiveBand(k, 1.705, 0.024),
  },
};

