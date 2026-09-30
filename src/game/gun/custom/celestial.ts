import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, extrude, hull, lathe, motes, mountPad, stations, strips,
  surfaceMaterial, torusZ, type Lod, type PartOpts, type TrackerMount, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// CELESTIAL (unobtainable) — a living starfield in the shape of a railgun.
// Every body panel is a window onto deep space: a slow-drifting nebula with
// stars that twinkle in it, framed in pale star-metal. A ringed planet sits
// where the capacitor would be, two moons orbit the barrel, orbital rings
// hang round it, and a crescent moon cups the muzzle. Stars set into the
// back of the gun are joined by constellation lines that draw themselves
// in as the rail charges.
// VFX: star dust drifting round the barrel; constellation lines tracing;
// on the SHOT a comet leaves the receiver, spirals once round the barrel and
// flies off the muzzle trailing a dust tail and an ion tail. Streak: the
// nebula glows, the moons race, shooting stars cross the gun.
// Star-metal window frames on the flanks, an armillary sphere round the
// planet, a compass star round the barrel collar.
// Draws: body (+ moons, armillary, vertex-animated) · constellation · star dust ·
// comet = 4.
// ─────────────────────────────────────────────────────────────────────────

const Z = { NEBULA: 1, STARMETAL: 2, STAR: 3, MOON: 4, PLANET: 5, CRESCENT: 6, ARMILLARY: 7 } as const;
const PLANET_C: V3 = [0, 0.01, 0.215];
// Tracked module seat: a star-metal plate low on the −X flank, under the
// framed nebula window (face x −0.062, y −0.012, z −0.142 … +0.022).
const MOUNT_FACE: V3 = [-0.062, -0.012, -0.06];

// Constellation nodes (on the back of the receiver and along the barrel top).
const NODES: V3[] = [
  [0.02, 0.094, 0.1], [-0.018, 0.094, 0.04], [0.012, 0.096, -0.04], [-0.02, 0.094, -0.13],
  [0.0, 0.094, -0.2], [0.0, BARREL_Y + 0.036, -0.34], [0.008, BARREL_Y + 0.034, -0.5], [-0.006, BARREL_Y + 0.032, -0.66],
  [0.03, 0.088, -0.09],
];
const EDGES: Array<[number, number]> = [[0, 1], [1, 2], [2, 8], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]];

function crescent(r: number, inner: number, off: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, -Math.PI * 0.8, Math.PI * 0.8, false);
  s.absarc(off, 0, inner, Math.PI * 0.72, -Math.PI * 0.72, true);
  return s;
}

function buildBody(lod: Lod): { geo: THREE.BufferGeometry; mount: TrackerMount } {
  const hi = lod === 'high';
  const SEG = hi ? 22 : 8;
  const p = new Parts();
  const NEB: PartOpts = { col: 0x04050c, rough: 0.2, metal: 0.25, zone: Z.NEBULA, glow: 1 };
  const METAL: PartOpts = { pal: PAL.METAL_LT, rough: 0.18, metal: 1, zone: Z.STARMETAL };
  const DARK: PartOpts = { pal: PAL.METAL, rough: 0.3, metal: 0.8 };

  // Receiver: sleek, well-rounded.
  p.add(stations([
    [0.14, 0.074, 0.09, 0.02],
    [0.1, 0.092, 0.112, 0.024],
    [-0.16, 0.092, 0.112, 0.024],
    [-0.25, 0.066, 0.078, 0.03],
  ], 0.034), NEB);
  // Star-metal framing: edge rails + keel.
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.005, 0.006, 0.36, 0.002), { ...METAL, at: [sx * 0.045, 0.07, -0.05] });
    p.add(chamferBox(0.005, 0.005, 0.34, 0.002), { ...METAL, at: [sx * 0.046, -0.018, -0.05] });
  }
  // Star-metal window frames on the flanks: the nebula reads as a view
  // through the gun, not a paint job.
  for (const sx of [-1, 1]) {
    const x = sx * 0.057;
    p.add(chamferBox(0.004, 0.004, 0.27, 0.0012), { ...METAL, at: [x, 0.02, -0.045] });
    if (hi) {
      for (const z of [0.09, -0.18]) p.add(chamferBox(0.004, 0.05, 0.004, 0.0012), { ...METAL, at: [x, 0.044, z] });
      // Tiny rivet-stars at the frame corners.
      for (const z of [0.09, -0.18]) {
        for (const y of [0.02, 0.068]) p.add(new THREE.OctahedronGeometry(0.004, 0), { ...METAL, at: [x + sx * 0.002, y, z], flat: true });
      }
    }
  }
  // Tracked module seat.
  const mount = mountPad(p, { face: MOUNT_FACE, depth: 0.022, pad: DARK, rim: METAL, hi });
  // Stars set into the back (constellation nodes).
  for (const n of NODES) p.add(new THREE.OctahedronGeometry(hi ? 0.0055 : 0.007, 0), { col: 0xffffff, rough: 0.1, metal: 0, zone: Z.STAR, glow: 1, at: n, flat: true });
  addGrip(p, { grip: NEB, guard: METAL, hi });
  // Stock: a sweeping spar + crescent butt.
  p.add(chamferBox(0.026, 0.022, 0.3, 0.008), { ...NEB, at: [0, 0.05, 0.29] });
  p.add(stations([[0.15, 0.026, 0.028, -0.06], [0.4, 0.024, 0.024, -0.09]], 0.008), NEB);
  p.add(extrude(crescent(0.1, 0.085, 0.035), 0.026, 'side', 0.003, hi ? 18 : 8), { ...METAL, at: [0, -0.02, 0.43], rot: [0, 0, 0] });
  // A ringed planet where the capacitor sits.
  p.add(new THREE.SphereGeometry(0.034, hi ? 20 : 10, hi ? 14 : 8), { ...NEB, zone: Z.PLANET, at: [0, 0.01, 0.215] });
  p.add(torusZ(0.052, 0.0025, 4, hi ? 36 : 14), { ...METAL, at: [0, 0.01, 0.215], rot: [1.25, 0.35, 0], scale: [1, 1, 0.35] });
  // An armillary sphere round it: three gimballed star-metal rings (turning).
  const arm: V3[] = [[0, 0, 0], [0, Math.PI / 2, 0], [Math.PI / 2, 0, 0.5]];
  for (let i = 0; i < (hi ? 3 : 2); i++) {
    p.add(torusZ(0.047 + i * 0.003, 0.0018, 4, hi ? 36 : 14), { ...METAL, zone: Z.ARMILLARY, at: PLANET_C, rot: arm[i] });
  }
  // Foregrip.
  p.add(stations([[-0.19, 0.066, 0.052, -0.046], [-0.3, 0.056, 0.044, -0.043]], 0.02), NEB);

  // Barrel: a slender nebula column with star-metal bands + orbital rings.
  p.add(lathe([[0.03, -0.3], [0.052, -0.3], [0.058, -0.29], [0.058, -0.246], [0.05, -0.236], [0.022, -0.236]], SEG), { ...METAL, at: [0, BARREL_Y, 0] });
  p.add(cylZ(0.034, 0.028, 0.54, SEG), { ...NEB, at: [0, BARREL_Y, -0.56] });
  for (const z of [-0.36, -0.58, -0.8]) p.add(cylZ(0.036, 0.036, 0.008, SEG), { ...METAL, at: [0, BARREL_Y, z] });
  const orbits: Array<[number, number, number]> = [[-0.44, 0.055, 0.35], [-0.62, 0.062, -0.3]];
  for (const [z, r, tilt] of orbits) p.add(torusZ(r, 0.0018, 4, hi ? 40 : 14), { ...METAL, at: [0, BARREL_Y, z], rot: [tilt, 0, 0] });
  // A compass star round the barrel collar: four long diagonal points and
  // four short cardinal ones, star-metal, faceted.
  const pts = hi ? 8 : 4;
  for (let i = 0; i < pts; i++) {
    const a = Math.PI / 4 + (i / pts) * Math.PI * 2;
    const len = i % 2 === 0 ? 0.088 : 0.066;
    const c = Math.cos(a), s = Math.sin(a);
    const w = 0.012;
    p.add(hull([[c * 0.05 - s * w, BARREL_Y + s * 0.05 + c * w, -0.3], [c * 0.05 + s * w, BARREL_Y + s * 0.05 - c * w, -0.3],
      [c * 0.05, BARREL_Y + s * 0.05, -0.286], [c * 0.05, BARREL_Y + s * 0.05, -0.314], [c * len, BARREL_Y + s * len, -0.3]]),
    { ...METAL, zone: Z.CRESCENT, glow: 0.6, flat: true });
  }
  // Moons (orbit the barrel).
  p.add(new THREE.SphereGeometry(0.009, hi ? 12 : 6, hi ? 8 : 4), { col: 0xd8def0, rough: 0.8, metal: 0, zone: Z.MOON, at: [0.058, BARREL_Y, -0.46] });
  p.add(new THREE.SphereGeometry(0.0065, hi ? 10 : 5, hi ? 6 : 4), { col: 0xf0d8c8, rough: 0.8, metal: 0, zone: Z.MOON, at: [-0.064, BARREL_Y, -0.64] });
  // Muzzle: a crescent moon cupping the bore + a star-metal lip.
  p.add(lathe([[0.022, -0.86], [0.036, -0.86], [0.04, -0.85], [0.04, -0.82], [0.03, -0.815]], SEG), { ...DARK, at: [0, BARREL_Y, 0] });
  p.add(extrude(crescent(0.058, 0.05, 0.022), 0.012, 'top', 0.002, hi ? 22 : 10), { ...METAL, zone: Z.CRESCENT, glow: 1, at: [0, BARREL_Y, -0.875], rot: [Math.PI / 2, 0, Math.PI / 2] });
  return { geo: p.merge(`celestial-${lod}`), mount };
}

const VERT = /* glsl */ `
  if (vZone == ${Z.MOON}) {
    cgPivot = vec3(0.0, ${BARREL_Y.toFixed(3)}, 0.0);
    cgR = cgRotZ(uPhase * (0.5 + 0.4 * sign(position.x)));
  } else if (vZone == ${Z.ARMILLARY}) {
    cgPivot = vec3(${PLANET_C.map((v) => v.toFixed(3)).join(', ')});
    cgR = cgRotY(uPhase * 0.3) * cgRotX(0.35);
  }
`;

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  if (zone == ${Z.NEBULA} || zone == ${Z.PLANET}) {
    // Deep space: drifting nebula + twinkling stars (object-space 3D cells).
    vec3 q = vOP * (zone == ${Z.PLANET} ? 26.0 : 11.0) + vec3(uTime * 0.03, 0.0, uTime * 0.06);
    float n1 = cgFbm(q);
    float n2 = cgFbm(q * 1.9 + 7.3);
    // Saturated nebula: cyan clouds over violet deep space, magenta knots.
    vec3 neb = mix(vec3(0.03, 0.015, 0.1), uA * 0.6, smoothstep(0.34, 0.74, n1));
    neb = mix(neb, vec3(0.85, 0.2, 0.7) * 0.55, smoothstep(0.5, 0.82, n2) * 0.85);
    vec3 sp = vOP * 115.0;
    vec3 ci = floor(sp);
    vec3 h = cgH33(ci);
    float d = length(fract(sp) - (0.25 + 0.5 * h));
    float big = step(0.9, h.x);
    float star = smoothstep(0.13 + 0.12 * big, 0.0, d) * step(0.5, h.y);
    float tw = 0.55 + 0.45 * sin(uTime * (2.0 + 4.0 * h.z) + h.x * 40.0) * (1.0 - uCalm * 0.8);
    diffuseColor.rgb = vec3(0.012, 0.012, 0.03);
    glow += neb * (0.7 + 0.35 * fill + 0.7 * uStreak + 1.6 * uFire) * gmask;
    glow += mix(vec3(0.8, 0.9, 1.0), uB, h.z) * star * tw * (0.9 + 0.8 * big + 0.8 * uStreak + 2.0 * uFire);
    if (zone == ${Z.PLANET}) glow *= 0.6 + 0.8 * fres;
  } else if (zone == ${Z.STARMETAL} || zone == ${Z.ARMILLARY}) {
    glow += uA * fres * (0.05 + 0.2 * uStreak);
  } else if (zone == ${Z.STAR}) {
    glow += mix(uB, uA, 0.2) * (0.9 + 1.0 * fill + 1.2 * uStreak + 3.0 * uFire);
  } else if (zone == ${Z.CRESCENT}) {
    glow += mix(uA, uB, 0.5) * gmask * (0.15 + 0.35 * fill + 0.8 * uStreak + 3.5 * uFire) * (0.4 + fres);
  } else if (zone == ${Z.MOON}) {
    glow += vec3(0.9, 0.95, 1.0) * (0.06 + 0.3 * uStreak + 1.0 * uFire);
  }
`;

// Constellation: each edge is a strip; they draw themselves in with the
// charge (edge i appears once the fill passes it) and carry a travelling
// pulse.
function edgesGlsl(): string {
  const v = (n: V3) => `vec3(${n[0].toFixed(4)}, ${(n[1] + 0.004).toFixed(4)}, ${n[2].toFixed(4)})`;
  return EDGES.map(([a, b], i) => `${i ? 'else ' : ''}if (id < ${i}.5) { A = ${v(NODES[a])}; B = ${v(NODES[b])}; }`).join('\n  ');
}
const LINES = /* glsl */ `
  vec3 A = vec3(0.0), B = vec3(0.0);
  ${edgesGlsl()}
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float k = id / ${EDGES.length.toFixed(1)};
  float drawn = smoothstep(k, k + 0.12, fill * 1.1);
  float along = step(t, clamp((fill * 1.1 - k) / 0.12, 0.0, 1.0));
  p = mix(A, B, t);
  w = 0.0016 + 0.0008 * uStreak;
  float pulse = exp(-pow(fract(uTime * 0.35 + id * 0.17) * 1.6 - 0.3 - t, 2.0) * 60.0) * (1.0 - uCalm * 0.7);
  col = mix(uA, uB, 0.5) * (0.35 * drawn + 1.2 * pulse * drawn + 0.6 * uStreak + 2.5 * uFire);
  a = max(along * drawn, step(0.01, uFire));
`;

// Star dust round the barrel (+ a spray on the shot).
const DUST = /* glsl */ `
  float ang = seed.z * 6.283 + uPhase * (0.15 + 0.2 * seed.y);
  float rad = 0.045 + 0.05 * seed.y;
  float z = -0.28 - 0.6 * seed.x;
  p = vec3(cos(ang) * rad, ${BARREL_Y.toFixed(3)} + sin(ang) * rad * 0.8, z + 0.01 * sin(uTime * 0.7 + seed.x * 20.0));
  size = 0.0025 + 0.004 * seed.y * seed.y;
  float tw = 0.5 + 0.5 * sin(uTime * (1.5 + 5.0 * seed.x) + seed.z * 60.0) * (1.0 - uCalm * 0.8);
  col = mix(vec3(0.8, 0.9, 1.0), mix(uA, vec3(0.9, 0.4, 0.9), seed.x), seed.z) * (1.2 + 1.0 * uStreak);
  a = tw * (0.35 + 0.35 * clamp((uCharge - 0.1) / 0.88, 0.0, 1.0) + 0.5 * uStreak);
`;

// Comet (strip 0 = dust tail, 1‥2 = ion tails, 3 = a shooting star on a
// streak). t = 0 at the head, 1 at the tail's end.
const COMET = /* glsl */ `
  float travel = smoothstep(0.0, 0.3, uShot);
  float life = exp(-max(0.0, uShot - 0.3) * 4.0) * step(uShot, 1.4);
  if (id < 2.5) {
    float hz = mix(-0.31, -0.95, travel);
    float tl = (id < 0.5 ? 0.3 : 0.4) * (0.3 + 0.7 * travel);
    float z = min(-0.31, hz + t * tl);
    float s = (z + 0.31) / -0.64; // 0 at the barrel collar … 1 at the muzzle
    float spin = s * 6.283 + (id < 0.5 ? 0.0 : (id - 1.5) * 0.25 * t);
    float rad = 0.062 * (1.0 - smoothstep(0.8, 1.0, s)) + (id < 0.5 ? 0.012 * t : 0.0);
    p = vec3(cos(spin + 1.57) * rad, ${BARREL_Y.toFixed(3)} + sin(spin + 1.57) * rad, z);
    w = (id < 0.5 ? 0.011 : 0.004) * (1.0 - 0.75 * t) + 0.0015;
    vec3 head = vec3(0.9, 0.97, 1.0);
    vec3 tail = id < 0.5 ? mix(uA, vec3(0.95, 0.5, 0.9), t) : uA;
    col = mix(head, tail, smoothstep(0.0, 0.35, t)) * (id < 0.5 ? 4.0 : 2.4) * (1.0 - t) * life;
    a = step(0.001, life) * step(uShot, 1.4);
  } else {
    // Shooting star crossing the gun during a streak.
    float cyc = floor(uTime / 1.7);
    float ph = fract(uTime / 1.7);
    float h = cgH1(cyc * 7.7);
    vec3 A = vec3(-0.12 + 0.05 * h, 0.12, -0.3 - 0.4 * h);
    vec3 B = A + vec3(0.2, -0.13, -0.05);
    vec3 hp = mix(A, B, ph * 1.4);
    p = mix(hp, hp - (B - A) * 0.35, t);
    w = 0.002 * (1.0 - t);
    col = vec3(0.9, 0.95, 1.0) * 2.2 * (1.0 - t) * sin(clamp(ph * 1.4, 0.0, 1.0) * 3.14159);
    a = step(0.3, uStreak) * step(ph, 0.71) * (1.0 - uCalm);
  }
`;

export const buildCelestial: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('celestial', lod, finish);
  const d = rig.drive;
  const hi = lod === 'high';
  const body = cached(`celestial-body-${lod}`, () => buildBody(lod));
  rig.trackerMount = body.mount;
  rig.body(body.geo, surfaceMaterial(d, { key: 'celestial', vert: VERT, frag: FRAG, side: THREE.DoubleSide }));
  rig.add(strips(d, { key: 'celestial-lines', count: EDGES.length, segs: 4, path: LINES, core: 2 }));
  rig.add(motes(d, { key: 'celestial', count: hi ? 90 : 30, motion: DUST, star: true }));
  rig.add(strips(d, { key: 'celestial-comet', count: hi ? 4 : 2, segs: hi ? 28 : 12, path: COMET, core: 2 }));
  return rig.instance();
};
