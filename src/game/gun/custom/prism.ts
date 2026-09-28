import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, hull, lathe, motes, stations, strips, surfaceMaterial,
  type Lod, type PartOpts, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// SPECTRUM (legendary) — an iridescent crystal rail. A faceted chrome
// receiver with a thin-film sheen that slides through the spectrum with the
// view angle; a hexagonal crystal core between three chrome rails (the charge
// meter: it refills rear → muzzle in flowing rainbow light); a Pink-Floyd
// prism set in the skeletal stock; six crystal shards orbiting the barrel.
// VFX: spectral sparkles drifting round the barrel, and on the shot a
// dispersion fan — white light split into its seven colours — off the tip.
// Streak: the shards spin faster, the core and sparkles run hotter.
// Draws: body (+ orbiting shards, vertex-animated) · sparkles · fan = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { CHROME: 1, CRYSTAL: 3, CORE: 4, SHARD: 5, GAUGE: 6 } as const;

function bipyramid(r: number, len: number, sides: number): THREE.BufferGeometry {
  const pts: V3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  pts.push([0, 0, len * 0.4], [0, 0, -len * 0.6]);
  return hull(pts);
}

function buildBody(lod: Lod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 18 : 8;
  const p = new Parts();
  const CHROME: PartOpts = { pal: PAL.METAL, rough: 0.27, metal: 1, zone: Z.CHROME, flat: true };
  const DARK: PartOpts = { pal: PAL.BODY, rough: 0.5, metal: 0.4 };
  const RUBBER: PartOpts = { col: 0x121318, rough: 0.85, metal: 0 };
  const CRYSTAL: PartOpts = { col: 0x0a0c12, rough: 0.05, metal: 0.2, glow: 1, zone: Z.CRYSTAL, flat: true };

  // Receiver: a faceted chrome block (flat facets catch the thin-film sheen).
  p.add(stations([
    [0.14, 0.082, 0.098, 0.02],
    [0.09, 0.096, 0.116, 0.024],
    [-0.17, 0.096, 0.114, 0.024],
    [-0.25, 0.074, 0.086, 0.03],
  ], 0.024), CHROME);
  // Dark underframe + mag well.
  p.add(stations([[0.12, 0.09, 0.03, -0.035], [-0.2, 0.09, 0.03, -0.035]], 0.008), DARK);
  // Crystal spine along the top.
  p.add(hull([
    [0, 0.086, 0.12], [0.016, 0.098, 0.1], [-0.016, 0.098, 0.1], [0.016, 0.098, -0.18], [-0.016, 0.098, -0.18],
    [0, 0.112, 0.08], [0, 0.112, -0.16], [0.012, 0.086, 0.1], [-0.012, 0.086, 0.1], [0.012, 0.086, -0.18], [-0.012, 0.086, -0.18],
    [0, 0.09, -0.22],
  ]), CRYSTAL);
  // Flank charge windows (gauge) with chrome bezels.
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.006, 0.03, 0.15, 0.002), { col: 0x05060a, rough: 0.1, metal: 0.1, glow: 1, zone: Z.GAUGE, at: [sx * 0.048, 0.034, -0.065] });
    if (hi) {
      p.add(chamferBox(0.008, 0.007, 0.17, 0.002), { ...CHROME, at: [sx * 0.05, 0.053, -0.065] });
      p.add(chamferBox(0.008, 0.007, 0.17, 0.002), { ...CHROME, at: [sx * 0.05, 0.015, -0.065] });
    }
  }
  addGrip(p, { grip: RUBBER, guard: { ...CHROME, flat: false }, hi });

  // Skeletal chrome stock around a Pink-Floyd prism.
  p.add(chamferBox(0.03, 0.026, 0.3, 0.007), { ...CHROME, at: [0, 0.046, 0.29] });
  p.add(stations([[0.15, 0.03, 0.034, -0.058], [0.42, 0.03, 0.03, -0.09]], 0.007), CHROME);
  p.add(chamferBox(0.046, 0.18, 0.01, 0.003), { ...CHROME, at: [0, -0.025, 0.425] });
  p.add(chamferBox(0.044, 0.17, 0.03, 0.01), { ...RUBBER, at: [0, -0.025, 0.442] });
  // The prism: an equilateral triangle in the side plane, 0.034 thick.
  {
    const cz = 0.285, cy = -0.012, r = 0.068;
    const tri: V3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
      for (const sx of [-1, 1]) tri.push([sx * 0.017, cy + Math.sin(a) * r, cz + Math.cos(a) * r]);
    }
    p.add(hull(tri), { ...CRYSTAL, glow: 1.2 });
  }

  // Foregrip + barrel mount collar.
  p.add(stations([[-0.19, 0.07, 0.056, -0.046], [-0.33, 0.062, 0.048, -0.043]], 0.012), DARK);
  p.add(lathe([[0.03, -0.3], [0.058, -0.3], [0.064, -0.29], [0.064, -0.246], [0.056, -0.236], [0.022, -0.236]], SEG), { ...CHROME, flat: false, at: [0, BARREL_Y, 0] });

  // Barrel: three chrome rails round a hexagonal crystal core.
  for (let i = 0; i < 3; i++) {
    // Keel rail + two upper rails: the core shows between them from above.
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    p.add(chamferBox(0.014, 0.02, 0.6, 0.005), { ...CHROME, at: [Math.cos(a) * 0.046, BARREL_Y + Math.sin(a) * 0.046, -0.56], rot: [0, 0, a - Math.PI / 2] });
  }
  p.add(cylZ(0.026, 0.026, 0.58, 6), { col: 0x05060a, rough: 0.05, metal: 0.2, glow: 1, zone: Z.CORE, at: [0, BARREL_Y, -0.55], flat: true });
  // Clamp rings with crystal studs.
  for (const z of [-0.37, -0.56, -0.75]) {
    p.add(lathe([[0.05, z - 0.012], [0.062, z - 0.008], [0.062, z + 0.008], [0.05, z + 0.012]], hi ? 24 : 8, Math.PI / 6), { ...CHROME, at: [0, BARREL_Y, 0] });
    if (hi) {
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
        p.add(bipyramid(0.008, 0.02, 4), { ...CRYSTAL, at: [Math.cos(a) * 0.066, BARREL_Y + Math.sin(a) * 0.066, z], rot: [0, 0, a] });
      }
    }
  }
  // Emitter: chrome shroud, three blade prongs and a crystal tip.
  p.add(lathe([[0.024, -0.872], [0.044, -0.872], [0.056, -0.86], [0.056, -0.8], [0.046, -0.782], [0.03, -0.782]], SEG), { ...CHROME, flat: false, at: [0, BARREL_Y, 0] });
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    p.add(hull([
      [-0.006, 0, -0.78], [0.006, 0, -0.78], [-0.006, 0.02, -0.8], [0.006, 0.02, -0.8],
      [-0.004, 0.004, -0.925], [0.004, 0.004, -0.925], [0, 0.012, -0.91],
    ]), { ...CHROME, at: [Math.cos(a) * 0.05, BARREL_Y + Math.sin(a) * 0.05, 0], rot: [0, 0, a - Math.PI / 2] });
  }
  p.add(bipyramid(0.026, 0.1, 6), { ...CRYSTAL, zone: Z.CORE, glow: 1.3, at: [0, BARREL_Y, -0.885] });

  // Orbiting shards (vertex-animated about the barrel axis).
  const shards = hi ? 6 : 3;
  for (let i = 0; i < shards; i++) {
    const a = (i / shards) * Math.PI * 2 + 0.3;
    const z = -0.44 - (i % 3) * 0.12;
    p.add(bipyramid(0.009, 0.056, 4), { ...CRYSTAL, zone: Z.SHARD, glow: 1.1, at: [Math.cos(a) * 0.082, BARREL_Y + Math.sin(a) * 0.082, z], rot: [0, 0, a] });
  }
  return p.merge(`prism-${lod}`);
}

const VERT = /* glsl */ `
  if (vZone == ${Z.SHARD}) {
    cgPivot = vec3(0.0, ${BARREL_Y.toFixed(3)}, 0.0);
    cgR = cgRotZ(uPhase * 0.9);
    vec2 rad = normalize(position.xy - vec2(0.0, ${BARREL_Y.toFixed(3)}) + 1e-5);
    cgOff = cgR * vec3(rad * (0.012 * uFire + 0.004 * uStreak), 0.0);
  }
`;

const FRAG = /* glsl */ `
  if (zone == ${Z.CHROME}) {
    vec3 film = cgHue(fres * 0.9 + vOP.z * 1.3 + vOP.y * 2.5 + uTime * 0.04);
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.6, 0.2 + 0.8 * film, 0.2 + 0.6 * fres);
    glow += film * fres * (0.1 + 0.2 * uStreak);
  } else if (zone == ${Z.CRYSTAL} || zone == ${Z.SHARD}) {
    vec3 c = cgHue(vOP.z * 3.0 + vOP.y * 5.0 - uTime * 0.3 + fres * 0.8);
    diffuseColor.rgb = vec3(0.03);
    float k = 0.18 + 0.4 * fres + 0.6 * uStreak + 2.2 * uFire;
    glow += mix(c, vec3(1.0), 0.25) * k * gmask;
  } else if (zone == ${Z.CORE}) {
    float f = cgFill(vOP.z, -0.26, -0.86);
    vec3 c = cgHue(vOP.z * 2.2 - uTime * 0.55);
    diffuseColor.rgb = vec3(0.02);
    float k = mix(0.05, 0.95 + 0.55 * uStreak, f) + 4.5 * uFire;
    glow += mix(c, vec3(1.0), 0.2 + 0.6 * uFire) * k * gmask;
  } else if (zone == ${Z.GAUGE}) {
    float f = cgFill(vOP.z, 0.01, -0.14);
    diffuseColor.rgb = vec3(0.02);
    glow += mix(cgHue(vOP.z * 4.0 - uTime * 0.4), vec3(1.0), 0.2) * (0.06 + 0.85 * f + 2.0 * uFire);
  }
`;

// Spectral sparkles: drift in a loose helix round the barrel; on the shot a
// burst of them sprays out of the tip.
const MOTES = /* glsl */ `
  float life = 1.8 + seed.y * 1.6;
  float t = uTime / life + seed.x * 5.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h1 = cgH1(cyc * 13.1 + seed.z * 91.0);
  float ang = seed.z * 6.283 + uPhase * 1.1 + ph * 1.5;
  float rad = 0.058 + 0.04 * h1 + 0.015 * ph;
  float z = -0.3 - 0.56 * fract(seed.x * 7.0 + h1) - ph * 0.06;
  p = vec3(cos(ang) * rad, ${BARREL_Y.toFixed(3)} + sin(ang) * rad, z);
  size = 0.007 + 0.007 * h1;
  float tw = 1.0 - uCalm * 0.7;
  col = mix(cgHue(seed.z + uTime * 0.15 + ph * 0.3), vec3(1.0), 0.35) * (0.9 + 1.2 * uStreak);
  a = sin(ph * 3.14159) * (0.35 + 0.65 * uStreak) * (1.0 - tw * 0.4 + tw * 0.4 * sin(uTime * 9.0 + seed.x * 40.0));
  // Shot burst: a third of them spray from the tip.
  if (seed.y < 0.34 && uShot < 0.7) {
    float k = 1.0 - exp(-uShot * 9.0);
    vec3 dir = normalize(vec3(cos(seed.z * 6.283) * 0.9, sin(seed.z * 6.283) * 0.9, -0.7 - seed.x * 0.4));
    p = vec3(0.0, ${BARREL_Y.toFixed(3)}, -0.9) + dir * k * (0.08 + 0.12 * seed.x);
    col = mix(cgHue(seed.z), vec3(1.0), 0.3) * 2.2;
    size = 0.009;
    a = exp(-uShot * 6.0);
  }
`;

// Dispersion fan off the tip on the shot (ROYGBIV, index 0 … 6).
const FAN = /* glsl */ `
  float k = id / 6.0;
  float grow = 1.0 - exp(-uShot * 14.0);
  float life = exp(-uShot * 6.5) * step(uShot, 0.9);
  float idle = 0.22 * uStreak * (1.0 - uCalm * 0.5);
  float len = mix(0.07, 0.19 * grow, step(0.001, life));
  vec3 dir = normalize(vec3((k - 0.5) * 0.55, (k - 0.5) * 0.18 - 0.05, -1.0));
  p = vec3(0.0, ${BARREL_Y.toFixed(3)}, -0.925) + dir * t * len;
  w = 0.0035 + 0.005 * t;
  col = cgHue(k * 0.8) * (3.0 * life + idle);
  a = pow(sin(t * 3.14159), 0.6) * (1.0 - t * 0.5) * step(0.001, life + idle);
`;

export const buildPrism: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('prism', lod, finish);
  const d = rig.drive;
  rig.body(cached(`prism-body-${lod}`, () => buildBody(lod)), surfaceMaterial(d, { key: 'prism', vert: VERT, frag: FRAG, envIntensity: 1.3 }));
  rig.add(motes(d, { key: 'prism', count: lod === 'high' ? 72 : 24, motion: MOTES }));
  rig.add(strips(d, { key: 'prism-fan', count: 7, segs: 6, path: FAN, core: 2.5 }));
  return rig.instance();
};
