import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, helix, lathe, motes, stations, strips, surfaceMaterial, torusZ,
  type Lod, type PartOpts,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// TESLA COILGUN (legendary) — exposed copper. Three hand-wound coils on a
// ceramic former down the barrel, ribbed insulators between them, copper bus
// bars, a toroidal top-load and a spark-gap fork at the muzzle, a brass
// pressure gauge on the receiver whose needle IS the charge readout, and
// horizontal valve tubes whose filaments warm up with the charge.
// VFX: live arcs — they jump coil to coil and across the spark gap, few and
// lazy after a shot, crawling and forking as the rail tops up; on the shot
// every gap strikes at once. Sparks spit off the strikes. Streak: the arcs
// never rest. Reduced effects: arcs re-strike slowly and hold (no strobe).
// Draws: body · arcs · sparks = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { COPPER: 1, COIL: 2, CERAMIC: 3, TUBE: 4, NEEDLE: 5, TORUS: 6, GAUGE: 7 } as const;
export const COILS_Z = [-0.33, -0.49, -0.65] as const; // coil centres, rear → front
const COIL_LEN = 0.11;
const COIL_R = 0.05;
const GAUGE = { y: 0.103, z: -0.02, r: 0.03 };

function buildBody(lod: Lod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 18 : 8;
  const p = new Parts();
  const STEEL: PartOpts = { pal: PAL.BODY, rough: 0.55, metal: 0.7 };
  const IRON: PartOpts = { col: 0x2a2d33, rough: 0.45, metal: 0.8 };
  const COPPER: PartOpts = { pal: PAL.METAL_LT, rough: 0.28, metal: 1, zone: Z.COPPER };
  const BRASS: PartOpts = { col: 0xc9a14a, rough: 0.3, metal: 1 };
  const CERAMIC: PartOpts = { col: 0xe9e4d8, rough: 0.25, metal: 0, zone: Z.CERAMIC };
  const RUBBER: PartOpts = { col: 0x17130f, rough: 0.8, metal: 0 };

  // Receiver: riveted steel box.
  p.add(stations([
    [0.14, 0.086, 0.1, 0.02],
    [0.08, 0.098, 0.116, 0.024],
    [-0.17, 0.098, 0.116, 0.024],
    [-0.25, 0.08, 0.09, 0.03],
  ], 0.012), STEEL);
  if (hi) {
    for (const sx of [-1, 1]) {
      for (const [ry, rz] of [[0.07, 0.11], [0.07, -0.2], [-0.02, 0.11], [-0.02, -0.2], [0.07, -0.045], [-0.02, -0.045]] as const) {
        p.add(new THREE.SphereGeometry(0.0045, 6, 4), { ...BRASS, at: [sx * 0.049, ry, rz] });
      }
    }
  }
  // Brass pressure gauge on top (the charge readout): bezel, face, needle.
  p.add(lathe([[0, -0.008], [GAUGE.r + 0.006, -0.008], [GAUGE.r + 0.006, 0.008], [GAUGE.r, 0.01], [0, 0.01]], hi ? 24 : 10), { ...BRASS, at: [0, GAUGE.y - 0.012, GAUGE.z], rot: [-Math.PI / 2, 0, 0] });
  p.add(new THREE.CircleGeometry(GAUGE.r, hi ? 24 : 10), { col: 0xefe6cf, rough: 0.4, metal: 0, zone: Z.GAUGE, at: [0, GAUGE.y - 0.001, GAUGE.z], rot: [-Math.PI / 2, 0, 0] });
  p.add(chamferBox(0.004, 0.003, GAUGE.r * 0.85, 0.001), { col: 0xb01818, rough: 0.4, metal: 0.2, zone: Z.NEEDLE, at: [0, GAUGE.y + 0.002, GAUGE.z - GAUGE.r * 0.38] });
  // Valve tubes along each flank: glass envelope + glowing filament.
  for (const sx of [-1, 1]) {
    p.add(cylZ(0.014, 0.014, 0.17, hi ? 12 : 6), { col: 0x2a3440, rough: 0.05, metal: 0.1, zone: Z.TUBE, glow: 0.4, at: [sx * 0.058, 0.03, -0.06] });
    p.add(cylZ(0.004, 0.004, 0.15, 4), { col: 0x100804, rough: 0.5, metal: 0, zone: Z.TUBE, glow: 1.4, at: [sx * 0.058, 0.03, -0.06] });
    for (const z of [0.03, -0.15]) p.add(cylZ(0.017, 0.017, 0.016, hi ? 12 : 6), { ...BRASS, at: [sx * 0.058, 0.03, z] });
  }
  addGrip(p, { grip: RUBBER, guard: BRASS, hi });
  // Stock: iron frame round a big copper-banded capacitor can.
  p.add(chamferBox(0.03, 0.026, 0.3, 0.006), { ...IRON, at: [0, 0.052, 0.29] });
  p.add(stations([[0.15, 0.03, 0.034, -0.058], [0.42, 0.03, 0.03, -0.09]], 0.007), IRON);
  p.add(chamferBox(0.046, 0.18, 0.01, 0.003), { ...BRASS, at: [0, -0.025, 0.425] });
  p.add(chamferBox(0.044, 0.17, 0.03, 0.01), { ...RUBBER, at: [0, -0.025, 0.442] });
  p.add(cylZ(0.036, 0.036, 0.15, SEG), { col: 0x1c2026, rough: 0.35, metal: 0.8, at: [0, 0.006, 0.23] });
  for (const z of [0.17, 0.23, 0.29]) p.add(cylZ(0.039, 0.039, 0.012, SEG), { ...COPPER, at: [0, 0.006, z] });
  // Foregrip.
  p.add(stations([[-0.19, 0.07, 0.056, -0.046], [-0.31, 0.062, 0.048, -0.043]], 0.01), { ...RUBBER, rough: 0.7 });

  // Barrel: ceramic former with coils, insulators between them.
  p.add(lathe([[0.03, -0.3], [0.056, -0.3], [0.062, -0.29], [0.062, -0.246], [0.054, -0.236], [0.022, -0.236]], SEG), { ...BRASS, at: [0, BARREL_Y, 0] });
  p.add(cylZ(0.03, 0.03, 0.58, hi ? 14 : 8), { ...CERAMIC, at: [0, BARREL_Y, -0.55] });
  for (let i = 0; i < 3; i++) {
    const c = COILS_Z[i];
    // Coil end cheeks (brass) + the winding.
    for (const s of [-1, 1]) p.add(cylZ(COIL_R + 0.012, COIL_R + 0.012, 0.008, SEG), { ...BRASS, at: [0, BARREL_Y, c + s * (COIL_LEN / 2 + 0.004)] });
    p.add(helix(COIL_R, hi ? 0.0065 : 0.009, c + COIL_LEN / 2, c - COIL_LEN / 2, hi ? 8 : 4, hi ? 5 : 3, hi ? 11 : 8), { ...COPPER, zone: Z.COIL, glow: 1, at: [0, BARREL_Y, 0] });
    p.add(cylZ(COIL_R - 0.004, COIL_R - 0.004, COIL_LEN, hi ? 14 : 6), { col: 0x3a2412, rough: 0.6, metal: 0.3, at: [0, BARREL_Y, c] });
  }
  // Ribbed ceramic insulators between the coils.
  for (const z of [-0.41, -0.57]) {
    const pr: Array<[number, number]> = [];
    for (let k = 0; k <= 4; k++) pr.push([k % 2 ? 0.036 : 0.044, z - 0.02 + k * 0.01]);
    p.add(lathe(pr, SEG), { ...CERAMIC, at: [0, BARREL_Y, 0] });
  }
  // Copper bus bars down each side.
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.008, 0.012, 0.5, 0.003), { ...COPPER, at: [sx * 0.068, BARREL_Y - 0.03, -0.49] });
  }
  // Muzzle: toroidal top-load + spark-gap fork with ball electrodes.
  p.add(lathe([[0.026, -0.8], [0.04, -0.8], [0.046, -0.79], [0.046, -0.735], [0.03, -0.72]], SEG), { ...IRON, at: [0, BARREL_Y, 0] });
  p.add(torusZ(0.043, 0.014, hi ? 10 : 6, hi ? 28 : 12), { ...COPPER, zone: Z.TORUS, glow: 1, at: [0, BARREL_Y, -0.76] });
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.008, 0.01, 0.13, 0.003), { ...BRASS, at: [sx * 0.03, BARREL_Y, -0.845], rot: [0, sx * 0.12, 0] });
    p.add(new THREE.SphereGeometry(0.011, hi ? 12 : 6, hi ? 8 : 4), { ...COPPER, zone: Z.TORUS, glow: 1, at: [sx * 0.022, BARREL_Y, -0.912] });
  }
  return p.merge(`tesla-${lod}`);
}

const VERT = /* glsl */ `
  if (vZone == ${Z.NEEDLE}) {
    // Needle sweeps −120° … +120° with the charge (a little jitter when live).
    float jit = (1.0 - uCalm) * 0.05 * sin(uTime * 23.0) * uCharge;
    float ang = mix(2.1, -2.1, uCharge) + jit;
    cgPivot = vec3(0.0, ${GAUGE.y.toFixed(3)}, ${GAUGE.z.toFixed(3)});
    cgR = cgRotY(ang);
  }
`;

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  if (zone == ${Z.COPPER}) {
    diffuseColor.rgb *= 0.85 + 0.3 * cgFbm(vOP * 80.0);
  } else if (zone == ${Z.COIL}) {
    // Each coil fills rear → front; its winding glows along the wire.
    float f = cgFill(vOP.z, -0.27, -0.71);
    // A current pulse runs round the winding; the copper stays copper.
    float wire = pow(0.5 + 0.5 * sin(vOP.z * 90.0 - uTime * 7.0 * (1.0 - uCalm)), 6.0);
    glow += mix(uA, uB, 0.2 + 0.6 * uFire) * gmask * (f * (0.05 + 0.45 * wire * fres + 0.15 * fres) * (1.0 + 0.8 * uStreak) + 3.0 * uFire);
  } else if (zone == ${Z.TORUS}) {
    glow += mix(uA, uB, 0.5) * gmask * (0.06 + 0.25 * fill * fill + 0.5 * uStreak + 3.5 * uFire) * (0.4 + fres);
  } else if (zone == ${Z.TUBE}) {
    vec3 warm = vec3(1.0, 0.45, 0.15);
    glow += mix(warm, uA, 0.35) * gmask * (0.1 + 0.9 * fill + 0.8 * uStreak + 2.0 * uFire);
  } else if (zone == ${Z.GAUGE}) {
    vec2 q = vOP.xz - vec2(0.0, ${GAUGE.z.toFixed(3)});
    float r = length(q) / ${GAUGE.r.toFixed(3)};
    float a = atan(q.x, -q.y);
    float ticks = step(0.8, r) * step(r, 0.92) * step(0.85, fract(a * 3.0)) * step(abs(a), 2.2);
    float red = step(0.8, r) * step(r, 0.92) * step(1.7, -a) * step(-a, 2.2);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), ticks);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7, 0.05, 0.03), red);
    glow += vec3(0.9, 0.8, 0.55) * 0.1 * (1.0 - r);
  }
`;

// Arcs. Strips 0‥5 jump coil → coil (0‥2 over insulator A, 3‥5 over B),
// 6‥8 the spark gap, 9‥11 crawl torus → coil 3, 12‥13 strike forward off the
// fork on the shot. Each re-strikes in its own time slot.
const ARC_PARS = /* glsl */ `
  vec3 cgAxis(float a, float r, float z) { return vec3(cos(a) * r, ${BARREL_Y.toFixed(3)} + sin(a) * r, z); }
`;
const ARCS = /* glsl */ `
  float calm = uCalm;
  float rate = mix(mix(9.0, 16.0, uStreak), 1.6, calm);
  float slotT = uTime * rate + rnd.x * 7.0 + id * 1.37;
  float slot = floor(slotT);
  float sp = fract(slotT);
  float h = cgH1(slot * 3.1 + id * 11.7);
  float h2 = cgH1(slot * 7.3 + id * 5.1);
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float shot = exp(-uShot * 9.0) * step(uShot, 0.6);
  // How many arcs are live: a few lazy ones at low charge → all at full.
  float live = clamp(fill * 0.75 + uStreak * 0.5, 0.0, 1.0);
  float on = step(h, live * 0.85 + 0.05) * step(0.15, fill);
  vec3 A, B;
  float amp = 0.014;
  vec3 bowDir = vec3(0.0);
  float bow = 0.0;
  if (id < 6.0) {
    // Coil → next coil, leaping over the insulator between them.
    float from = mod(id, 2.0);
    float zA = from < 0.5 ? ${COILS_Z[0].toFixed(3)} : ${COILS_Z[1].toFixed(3)};
    float ang = 1.5708 + (h2 - 0.5) * 3.0;
    float ang2 = ang + (h - 0.5) * 1.2;
    A = cgAxis(ang, ${(COIL_R + 0.01).toFixed(3)}, zA - (h - 0.5) * ${(COIL_LEN * 0.8).toFixed(3)});
    B = cgAxis(ang2, ${(COIL_R + 0.01).toFixed(3)}, zA - 0.16 + (h2 - 0.5) * ${(COIL_LEN * 0.8).toFixed(3)});
    bowDir = vec3(cos((ang + ang2) * 0.5), sin((ang + ang2) * 0.5), 0.0);
    bow = 0.018 + 0.02 * h;
    amp = 0.016;
  } else if (id < 9.0) {
    A = vec3(-0.022, ${BARREL_Y.toFixed(3)} + (h - 0.5) * 0.01, -0.912);
    B = vec3(0.022, ${BARREL_Y.toFixed(3)} + (h2 - 0.5) * 0.01, -0.912);
    amp = 0.01;
    on = max(on, step(0.3, fill) * step(h, 0.5 + 0.5 * uStreak));
  } else if (id < 12.0) {
    float ang = 0.6 + h2 * 1.9;
    A = cgAxis(ang, 0.06, -0.76);
    bowDir = vec3(cos(ang), sin(ang), 0.0);
    bow = 0.015;
    B = cgAxis(ang + (h - 0.5), ${(COIL_R + 0.012).toFixed(3)}, ${(COILS_Z[2] - COIL_LEN / 2).toFixed(3)});
    amp = 0.016;
    on *= step(0.5, fill);
  } else {
    // Forward strike on the shot only (short: stays near the fork).
    float sx = id < 12.5 ? -1.0 : 1.0;
    A = vec3(sx * 0.022, ${BARREL_Y.toFixed(3)}, -0.915);
    B = vec3(sx * 0.02 + (h - 0.5) * 0.06, ${BARREL_Y.toFixed(3)} + (h2 - 0.5) * 0.06, -1.0);
    amp = 0.012;
    on = 0.0;
  }
  on = max(on, shot);
  // Jagged polyline: noise displacement per slot, pinned at both ends.
  vec3 d = B - A;
  vec3 n1 = normalize(cross(d, vec3(0.0, 1.0, 0.1)));
  vec3 n2 = normalize(cross(d, n1));
  float env = sin(t * 3.14159);
  float j1 = cgNoise(vec3(t * 7.0, slot * 1.7, id)) - 0.5;
  float j2 = cgNoise(vec3(t * 7.0, slot * 2.3 + 9.0, id)) - 0.5;
  float j3 = cgH1(floor(t * 9.0) + slot * 13.0 + id) - 0.5;
  p = A + d * t + (n1 * (j1 + 0.35 * j3) + n2 * j2) * amp * 2.2 * env * (1.0 + shot) + bowDir * bow * env;
  w = 0.005 + 0.003 * shot + 0.0015 * uStreak;
  float strike = calm > 0.5 ? 0.85 : exp(-sp * 5.0) * 0.8 + 0.35;
  col = mix(uA, uB, 0.55 + 0.4 * shot) * (2.2 * strike + 4.0 * shot) * (0.7 + 0.5 * uStreak);
  a = on;
`;

// Sparks spat off the strikes: short ballistic arcs with gravity.
const SPARKS = /* glsl */ `
  float life = 0.35 + seed.y * 0.35;
  float t = uTime / life + seed.x * 11.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h = cgH1(cyc * 9.1 + seed.z * 41.0);
  float h2 = cgH1(cyc * 4.3 + seed.x * 17.0);
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float z0 = h < 0.33 ? -0.41 : (h < 0.66 ? -0.57 : -0.912);
  float ang = h2 * 6.283;
  vec3 o = vec3(cos(ang) * 0.05, ${BARREL_Y.toFixed(3)} + sin(ang) * 0.05, z0);
  vec3 v = vec3(cos(ang) * 0.25, 0.15 + sin(ang) * 0.2, (seed.z - 0.5) * 0.3);
  p = o + v * ph * life - vec3(0.0, 0.9 * ph * ph * life * life, 0.0);
  size = 0.0035;
  col = mix(uA, uB, 0.7) * 2.5;
  float moteOn = step(cgH1(cyc * 2.7 + seed.y * 13.0), fill * 0.45 + uStreak * 0.5) * step(0.2, fill);
  float shot = exp(-uShot * 5.0) * step(uShot, 0.8);
  if (seed.y < 0.5 && shot > 0.01) {
    float k = uShot;
    vec3 dir = normalize(vec3((seed.x - 0.5) * 1.6, (seed.z - 0.3) * 1.2, -0.6));
    p = vec3(0.0, ${BARREL_Y.toFixed(3)}, -0.91) + dir * k * 0.5 - vec3(0.0, 0.5 * k * k, 0.0);
    moteOn = 1.0;
    ph = min(1.0, uShot * 2.0);
  }
  a = moteOn * (1.0 - ph) * (1.0 - uCalm * 0.5);
`;

export const buildTesla: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('tesla', lod, finish);
  const d = rig.drive;
  rig.body(cached(`tesla-body-${lod}`, () => buildBody(lod)), surfaceMaterial(d, { key: 'tesla', vert: VERT, frag: FRAG }));
  rig.add(strips(d, { key: 'tesla-arcs', count: lod === 'high' ? 14 : 8, segs: lod === 'high' ? 14 : 8, path: ARCS, pars: ARC_PARS, core: 2.2 }));
  rig.add(motes(d, { key: 'tesla', count: lod === 'high' ? 56 : 16, motion: SPARKS, soft: 6 }));
  return rig.instance();
};
