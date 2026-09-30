import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, bolts, cached, chamferBox, cylZ, extrude, fxMesh, hull, lathe, motes, mountPad, stations,
  surfaceMaterial, taperTube, torusZ, type Lod, type PartOpts, type TrackerMount, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// REAPER (relic) — a scythe-bladed rail wreathed in cold soulfire. Gothic
// black iron: a ribcage of iron bars over a soul-lit channel on the
// receiver's back, a caged soul lantern where the capacitor sits, a
// hexagonal barrel cut with runes that light rear → muzzle with the charge,
// and a crescent scythe blade slung beneath the barrel, edge down and back.
// VFX: soulfire wisps curling off the lantern, the ribs and the blade;
// cold flame running along the blade's edge; on the shot the wisps are
// dragged forward into the muzzle and the edge flares. Streak: the lantern
// burns white, the runes and the edge flame run high.
// Silhouette: a coffin receiver with a lancet arcade, a hooded cowl at the
// muzzle (a void face, two eyes), and a big scythe blade under the barrel —
// damascus body, bevelled concave edge, a soul-lit fuller.
// Draws: body · wisps · edge flame = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { IRON: 1, SOUL: 2, RUNE: 3, BLADE: 4, EDGE: 5, LANTERN: 6, VOID: 7, EYE: 8 } as const;
const BY = BARREL_Y;
const BLADE_Y = BY - 0.03; // the blade's root line (model y)

// The scythe blade hangs from the cowl and sweeps down and back under the
// barrel. Two quadratic curves in (u = −model z, v = y − BLADE_Y), root → tip:
// the SPINE (lower, convex, thick) and the cutting EDGE (upper, concave —
// a real scythe cuts on its inner curve), meeting at the point.
const SPINE: [number, number][] = [[0.885, 0.0], [0.845, -0.32], [0.3, -0.15]];
const EDGE: [number, number][] = [[0.765, 0.0], [0.72, -0.17], [0.3, -0.15]];
function q2(c: [number, number][], t: number): [number, number] {
  const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0], a * c[0][1] + b * c[1][1] + d * c[2][1]];
}
// A band of the blade between spine (k = 0) and edge (k = 1), t0 → t1, as a
// side-plane shape (shape x = u, y = v; extrude(..., 'side') maps x → −z).
function bladeBand(k0: number, k1: number, t0: number, t1: number, n: number): THREE.Shape {
  const at = (k: number, t: number) => {
    const s = q2(SPINE, t), e = q2(EDGE, t);
    return new THREE.Vector2(s[0] + (e[0] - s[0]) * k, s[1] + (e[1] - s[1]) * k);
  };
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) pts.push(at(k0, t0 + ((t1 - t0) * i) / n));
  for (let i = n; i >= 0; i--) pts.push(at(k1, t0 + ((t1 - t0) * i) / n));
  return new THREE.Shape(pts);
}
// A gothic lancet (pointed arch) window, base centred on the origin.
function lancet(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  const r = w * 0.95;
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h - r * 0.8);
  s.quadraticCurveTo(w / 2, h - r * 0.2, 0, h);
  s.quadraticCurveTo(-w / 2, h - r * 0.2, -w / 2, h - r * 0.8);
  s.closePath();
  return s;
}
// Receiver half-width at z (the coffin taper), for flush flank inlays.
const RECV: Array<[number, number, number, number]> = [
  [0.14, 0.078, 0.09, 0.02],
  [0.08, 0.1, 0.114, 0.024],
  [-0.05, 0.112, 0.118, 0.024],
  [-0.17, 0.096, 0.108, 0.024],
  [-0.25, 0.064, 0.078, 0.03],
];
function halfW(z: number): number {
  for (let i = 0; i < RECV.length - 1; i++) {
    const [z0, w0] = RECV[i], [z1, w1] = RECV[i + 1];
    if (z <= z0 && z >= z1) return (w0 + ((w1 - w0) * (z - z0)) / (z1 - z0)) / 2;
  }
  return RECV[RECV.length - 1][1] / 2;
}

// Tracked module seat: a bolted iron plaque low on the −X flank, under the
// lancet arcade (face x −0.064, y −0.012, z −0.142 … +0.022).
const MOUNT_FACE: V3 = [-0.064, -0.012, -0.06];

function buildBody(lod: Lod): { geo: THREE.BufferGeometry; mount: TrackerMount } {
  const hi = lod === 'high';
  const SEG = hi ? 16 : 8;
  const p = new Parts();
  const IRON: PartOpts = { pal: PAL.BODY, rough: 0.5, metal: 0.8, zone: Z.IRON };
  const STEEL: PartOpts = { pal: PAL.METAL, rough: 0.35, metal: 0.9, zone: Z.IRON };
  const SILVER: PartOpts = { pal: PAL.METAL_LT, rough: 0.25, metal: 1 };
  const SOUL: PartOpts = { col: 0x020605, rough: 0.2, metal: 0, zone: Z.SOUL, glow: 1 };
  const BONE: PartOpts = { col: 0xcfc8b8, rough: 0.6, metal: 0 };

  // Receiver: a coffin — widest at the shoulder, sharp-chamfered.
  p.add(stations(RECV, 0.026), { ...IRON, flat: true });
  // Soul channel on top + an iron ribcage over it.
  p.add(chamferBox(0.036, 0.01, 0.26, 0.003), { ...SOUL, at: [0, 0.079, -0.04] });
  const ribs = hi ? 7 : 4;
  for (let i = 0; i < ribs; i++) {
    const z = 0.07 - i * (0.22 / (ribs - 1));
    p.add(hull([[-0.03, 0.078, z + 0.006], [0.03, 0.078, z + 0.006], [-0.03, 0.078, z - 0.006], [0.03, 0.078, z - 0.006],
      [-0.018, 0.092, z], [0.018, 0.092, z], [0, 0.094, z - 0.004]]), { ...BONE, flat: true });
  }
  p.add(chamferBox(0.008, 0.008, 0.26, 0.002), { ...SILVER, at: [0, 0.094, -0.04] });
  // Gothic lancet arcade along both upper flanks (soul light behind iron
  // tracery), and one tall lancet forward of it.
  const arcade = hi ? [0.06, 0.02, -0.02, -0.06, -0.1] : [0.02, -0.06];
  for (const sx of [-1, 1]) {
    for (const z of arcade) {
      const x = sx * (halfW(z) + 0.0008);
      p.add(extrude(lancet(0.022, 0.032), 0.003, 'side', 0, hi ? 4 : 2), { ...SOUL, at: [x, 0.02, z], rot: [0, 0, 0] });
      if (hi) p.add(chamferBox(0.004, 0.036, 0.004, 0.001), { ...STEEL, at: [x + sx * 0.001, 0.036, z + 0.02] });
    }
    const zf = -0.19;
    p.add(extrude(lancet(0.03, 0.05), 0.003, 'side', 0, hi ? 5 : 2), { ...SOUL, at: [sx * (halfW(zf) + 0.0008), 0.0, zf] });
    // Iron hood moulding over the arcade.
    p.add(chamferBox(0.006, 0.006, 0.2, 0.002), { ...STEEL, at: [sx * (halfW(-0.02) + 0.002), 0.058, -0.02] });
  }
  // Tracked module seat: an iron plaque with a silver lip.
  const mount = mountPad(p, { face: MOUNT_FACE, depth: 0.024, pad: { ...STEEL, flat: true }, rim: SILVER, hi });
  addGrip(p, { grip: { col: 0x141416, rough: 0.8, metal: 0 }, guard: STEEL, hi });

  // Stock: the scythe's snath — a curved iron spar and a lower bar meeting a
  // coffin-plate butt, the soul lantern caged between them.
  p.add(taperTube([[0, 0.056, 0.12], [0, 0.052, 0.24], [0, 0.03, 0.36], [0, -0.005, 0.43]], 0.015, 0.012, hi ? 12 : 6, hi ? 8 : 5), STEEL);
  p.add(taperTube([[0, -0.045, 0.14], [0, -0.07, 0.28], [0, -0.1, 0.42]], 0.011, 0.009, hi ? 10 : 5, hi ? 6 : 4), IRON);
  p.add(hull([[0, 0.05, 0.415], [0, -0.16, 0.415], [-0.021, 0.03, 0.448], [0.021, 0.03, 0.448], [-0.021, -0.13, 0.448], [0.021, -0.13, 0.448],
    [0, -0.19, 0.44], [-0.012, 0.06, 0.435], [0.012, 0.06, 0.435]]), { ...STEEL, flat: true });
  if (hi) bolts(p, [[-0.021, 0.0, 0.44], [-0.021, -0.1, 0.44], [0.021, 0.0, 0.44], [0.021, -0.1, 0.44]], 0.004, '-x', SILVER);
  // Soul lantern: glass orb in a cage.
  p.add(new THREE.SphereGeometry(0.03, hi ? 16 : 8, hi ? 12 : 6), { col: 0x000403, rough: 0.1, metal: 0, zone: Z.LANTERN, glow: 1, at: [0, 0.008, 0.215] });
  for (let i = 0; i < (hi ? 6 : 3); i++) {
    const a = (i / (hi ? 6 : 3)) * Math.PI * 2;
    p.add(chamferBox(0.006, 0.006, 0.09, 0.002), { ...SILVER, at: [Math.cos(a) * 0.034, 0.008 + Math.sin(a) * 0.034, 0.215] });
  }
  for (const z of [0.165, 0.265]) p.add(lathe([[0.02, z - 0.008], [0.04, z - 0.006], [0.04, z + 0.006], [0.02, z + 0.008]], SEG), { ...STEEL, at: [0, 0.008, 0] });
  // Foregrip.
  p.add(stations([[-0.19, 0.068, 0.054, -0.046], [-0.31, 0.058, 0.046, -0.043]], 0.014), IRON);

  // Barrel: hexagonal iron cut with rune bands (the charge meter), silver
  // bands between them.
  p.add(lathe([[0.028, -0.3], [0.056, -0.3], [0.062, -0.29], [0.062, -0.246], [0.054, -0.236], [0.022, -0.236]], 6, Math.PI / 6), { ...STEEL, at: [0, BY, 0], flat: true });
  p.add(cylZ(0.038, 0.033, 0.48, 6), { ...IRON, zone: Z.RUNE, glow: 1, at: [0, BY, -0.54], flat: true });
  for (const z of [-0.38, -0.56, -0.74]) {
    p.add(lathe([[0.036, z - 0.012], [0.046, z - 0.008], [0.046, z + 0.008], [0.036, z + 0.012]], 6, Math.PI / 6), { ...SILVER, at: [0, BY, 0], flat: true });
  }

  // ── Muzzle: the Reaper's cowl — a peaked hood, a void where the face should
  // be and two cold eyes; the beam leaves the dark. ──
  p.add(hull([
    [-0.036, BY - 0.028, -0.735], [0.036, BY - 0.028, -0.735], [-0.026, BY + 0.04, -0.735], [0.026, BY + 0.04, -0.735],
    [0, BY + 0.07, -0.77], [-0.02, BY + 0.078, -0.83], [0.02, BY + 0.078, -0.83], [0, BY + 0.088, -0.9],
    [-0.03, BY + 0.062, -0.9], [0.03, BY + 0.062, -0.9],
    [-0.055, BY + 0.0, -0.9], [0.055, BY + 0.0, -0.9], [-0.042, BY - 0.046, -0.885], [0.042, BY - 0.046, -0.885],
    [-0.05, BY - 0.02, -0.82], [0.05, BY - 0.02, -0.82],
  ]), { ...IRON, flat: true });
  // Cloth folds down the hood's back.
  if (hi) {
    for (const sx of [-1, 1]) {
      p.add(taperTube([[sx * 0.022, BY + 0.07, -0.86], [sx * 0.034, BY + 0.05, -0.8], [sx * 0.036, BY + 0.03, -0.745]], 0.006, 0.003, 8, 5), IRON);
    }
  }
  // Hood edge: a heavier rim round the face opening.
  p.add(torusZ(0.043, 0.0055, hi ? 5 : 3, hi ? 20 : 10), { ...STEEL, at: [0, BY + 0.008, -0.9], scale: [0.95, 1.12, 1] });
  // The void face (flattened, pure black) and the eyes in it.
  p.add(new THREE.SphereGeometry(0.036, hi ? 16 : 8, hi ? 10 : 6).scale(1, 1.15, 0.35), { col: 0x000000, rough: 1, metal: 0, zone: Z.VOID, at: [0, BY + 0.008, -0.897] });
  for (const sx of [-1, 1]) {
    p.add(new THREE.SphereGeometry(0.0055, 8, 6).scale(1.4, 0.7, 0.6), { col: 0x010403, rough: 0.3, metal: 0, zone: Z.EYE, glow: 1, at: [sx * 0.014, BY + 0.024, -0.905], rot: [0, 0, -sx * 0.25] });
  }

  // ── The scythe: spine (convex, thick) · body (damascus) · bevelled edge ·
  // a soul-lit fuller down its middle · the tang on the cowl ──
  const n = hi ? 16 : 7;
  p.add(extrude(bladeBand(0, 0.82, 0, 0.985, n), 0.005, 'side', 0.0012, 1), { ...STEEL, zone: Z.BLADE, at: [0, BLADE_Y, 0] });
  p.add(extrude(bladeBand(0.78, 1, 0, 1, n), 0.0028, 'side', 0.0008, 1), { ...SILVER, zone: Z.EDGE, at: [0, BLADE_Y, 0] });
  p.add(extrude(bladeBand(0.34, 0.46, 0.1, 0.8, n), 0.0086, 'side', 0, 1), { ...SOUL, at: [0, BLADE_Y, 0] });
  {
    const sp: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const [u, v] = q2(SPINE, (i / n) * 0.97);
      sp.push([0, BLADE_Y + v + 0.002, -u]);
    }
    p.add(taperTube(sp, 0.006, 0.0025, hi ? 20 : 8, hi ? 6 : 4), STEEL);
  }
  p.add(hull([[-0.009, BY - 0.02, -0.74], [0.009, BY - 0.02, -0.74], [-0.009, BY - 0.02, -0.89], [0.009, BY - 0.02, -0.89],
    [-0.007, BY - 0.052, -0.76], [0.007, BY - 0.052, -0.88]]), { ...STEEL, flat: true });
  if (hi) bolts(p, [[-0.009, BY - 0.035, -0.785], [-0.009, BY - 0.035, -0.845], [0.009, BY - 0.035, -0.785], [0.009, BY - 0.035, -0.845]], 0.0038, '-x', SILVER);
  return { geo: p.merge(`reaper-${lod}`), mount };
}

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  vec3 soul = mix(uA, uB, 0.25);
  if (zone == ${Z.IRON}) {
    float n = cgFbm(vOP * 70.0);
    diffuseColor.rgb *= 0.7 + 0.5 * n;
    roughnessFactor = clamp(roughnessFactor + (n - 0.5) * 0.3, 0.1, 1.0);
  } else if (zone == ${Z.SOUL}) {
    float n = cgNoise(vec3(vOP.z * 30.0 - uTime * 1.5, vOP.y * 40.0 + vOP.x * 60.0, uTime * 0.5));
    diffuseColor.rgb = vec3(0.01);
    glow += soul * gmask * (0.25 + (0.35 + 0.5 * n) * fill + 0.8 * uStreak + 2.5 * uFire);
  } else if (zone == ${Z.LANTERN}) {
    float n = cgFbm(vOP * 50.0 + vec3(0.0, -uTime * 1.2, 0.0));
    glow += mix(soul, uB, uStreak) * gmask * (0.4 + 0.5 * n + 0.5 * fill + 1.2 * uStreak + 3.0 * uFire) * (0.5 + fres);
  } else if (zone == ${Z.RUNE}) {
    // Rune bands between the silver rings: one glyph per hex face per cell,
    // carved strokes (a stave + branches) lit rear → muzzle with the charge.
    float ang = atan(vOP.y - ${BY.toFixed(3)}, vOP.x) + 3.14159;
    float face = floor(ang / 1.0472);
    float fx = fract(ang / 1.0472);
    float band = step(-0.545, vOP.z) * step(vOP.z, -0.395) + step(-0.725, vOP.z) * step(vOP.z, -0.575) + step(vOP.z, -0.305) * step(-0.365, vOP.z);
    float gz = vOP.z * 42.0;
    float cell = floor(gz);
    float fz = fract(gz);
    float h = cgH3(vec3(cell, face, 3.0));
    float h2 = cgH3(vec3(cell, face, 7.0));
    float inCell = step(0.14, fz) * step(fz, 0.86) * step(0.18, fx) * step(fx, 0.82);
    float stave = step(abs(fx - 0.5), 0.06);
    float br1 = step(abs((fx - 0.5) - (fz - 0.5) * (h < 0.5 ? 1.0 : -1.0) - 0.12), 0.055) * step(0.5, fz);
    float br2 = step(abs((fx - 0.5) + (fz - 0.3) * (h2 < 0.5 ? 1.0 : -1.0)), 0.055) * step(fz, 0.55) * step(0.3, h2);
    float rune = max(stave, max(br1, br2)) * inCell * band * step(0.12, h);
    float lit = cgFill(vOP.z, -0.3, -0.76);
    diffuseColor.rgb *= 1.0 - rune * 0.7;
    glow += soul * rune * (0.04 + (0.95 + 0.8 * uStreak) * lit + 3.0 * uFire);
  } else if (zone == ${Z.BLADE}) {
    // Damascus steel: folded-layer waves across the blade.
    float w = sin((vOP.z * 70.0 + vOP.y * 110.0) + cgNoise(vOP * 45.0) * 5.0);
    float layer = smoothstep(0.2, 0.9, w);
    diffuseColor.rgb *= mix(0.45, 0.95, layer);
    roughnessFactor = mix(0.42, 0.18, layer);
    glow += soul * fres * (0.03 + 0.2 * uStreak + 0.6 * uFire);
  } else if (zone == ${Z.EDGE}) {
    // The honed edge: mirror-bright, catching the soul light.
    roughnessFactor = 0.08;
    diffuseColor.rgb *= 1.25;
    glow += soul * (0.05 + 0.12 * fill + 0.35 * uStreak + 1.6 * uFire) * (0.4 + fres);
  } else if (zone == ${Z.VOID}) {
    diffuseColor.rgb = vec3(0.0);
    roughnessFactor = 1.0;
    glow += soul * 0.04 * fres * (1.0 + uStreak);
  } else if (zone == ${Z.EYE}) {
    float flick = 1.0 - (1.0 - uCalm) * 0.25 * step(0.93, cgH1(floor(uTime * 6.0)));
    glow += mix(soul, uB, 0.3 + 0.5 * uStreak) * flick * (0.7 + 0.35 * fill + 0.3 * uStreak + 2.0 * uFire);
  }
`;

// The cutting edge in model space, t = 0 root … 1 point (GLSL).
const EDGE_GLSL = /* glsl */ `
  vec3 rpEdge(float t) {
    float a = (1.0 - t) * (1.0 - t), b = 2.0 * (1.0 - t) * t, d = t * t;
    vec2 e = a * vec2(${EDGE[0][0].toFixed(3)}, ${EDGE[0][1].toFixed(3)}) + b * vec2(${EDGE[1][0].toFixed(3)}, ${EDGE[1][1].toFixed(3)}) + d * vec2(${EDGE[2][0].toFixed(3)}, ${EDGE[2][1].toFixed(3)});
    return vec3(0.0, ${BLADE_Y.toFixed(3)} + e.y, -e.x);
  }
`;

// Soulfire wisps: slow curling ascent off the lantern, the ribcage and the
// blade; on the shot they are pulled forward into the muzzle.
const WISPS = /* glsl */ `
  float life = 2.2 + seed.y * 1.8;
  float t = uTime / life + seed.x * 9.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h1 = cgH1(cyc * 12.7 + seed.z * 57.0);
  float h2 = cgH1(cyc * 3.9 + seed.x * 23.0);
  vec3 o;
  if (seed.z < 0.35) o = vec3((h2 - 0.5) * 0.04, 0.01 + (h1 - 0.5) * 0.04, 0.215);
  else if (seed.z < 0.6) o = vec3((h2 - 0.5) * 0.05, 0.09, 0.06 - h1 * 0.24);
  else {
    // Off the blade's cutting edge, rising toward the barrel.
    o = rpEdge(0.15 + 0.8 * h1) + vec3((h2 - 0.5) * 0.008, 0.004, 0.0);
  }
  float curl = (1.0 - uCalm * 0.6);
  p = o + vec3(sin(ph * 6.0 + seed.x * 20.0) * 0.018 * curl, ph * (0.06 + 0.05 * h2), ph * 0.03 + cos(ph * 5.0 + seed.y * 9.0) * 0.01 * curl);
  size = 0.008 + 0.01 * h2 * (1.0 - ph * 0.5);
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  col = mix(uA, uB, (1.0 - ph) * 0.4 + 0.2 * uStreak) * (0.8 + 0.8 * uStreak);
  a = sin(ph * 3.14159) * (0.3 + 0.35 * fill + 0.6 * uStreak);
  // Shot: dragged forward and in toward the bore.
  if (uShot < 0.7) {
    float k = (1.0 - exp(-uShot * 6.0)) * step(seed.y, 0.6);
    p = mix(p, vec3(0.0, ${BARREL_Y.toFixed(3)}, -0.88 - 0.04 * seed.x), k);
    a = mix(a, 1.4 * exp(-uShot * 4.0), k);
  }
`;

// Cold flame along the cutting edge: a ribbon standing off the concave edge
// toward the barrel (uv.x along the edge, uv.y outward), flowing back.
function edgeFlameGeo(lod: Lod): THREE.BufferGeometry {
  return cached(`reaper-edge-${lod}`, () => {
    const n = lod === 'high' ? 24 : 10;
    const pos: number[] = [];
    const uv: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [u, v] = q2(EDGE, t);
      const [u2, v2] = q2(EDGE, Math.min(1, t + 0.01));
      const [u1, v1] = q2(EDGE, Math.max(0, t - 0.01));
      // Normal of the edge in the side plane, pointing up (off the edge).
      let nu = -(v2 - v1), nv = u2 - u1;
      const l = Math.hypot(nu, nv) || 1;
      nu /= l; nv /= l;
      if (nv < 0) { nu = -nu; nv = -nv; }
      for (const k of [0, 1]) {
        pos.push(0, BLADE_Y + v + nv * 0.045 * k, -(u + nu * 0.045 * k));
        uv.push(t, k);
        nor.push(1, 0, 0);
      }
      if (i < n) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.userData.shared = true;
    return g;
  });
}

const EDGE_VERT = /* glsl */ `
  // The flame leans back along the blade as it burns (more on the shot).
  float flare = exp(-uShot * 4.0) * step(uShot, 1.5);
  p.z += uv.y * (0.015 + 0.03 * flare);
`;
const EDGE_FRAG = /* glsl */ `
  float flare = exp(-uShot * 4.0) * step(uShot, 1.5);
  float hgt = 0.3 + 0.25 * uStreak + 0.7 * flare;
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float n = cgFbm(vec3(vUv.x * 9.0 + uTime * 1.6, vUv.y * 2.5 - uTime * 2.2, 0.0));
  float body = smoothstep(hgt, 0.0, vUv.y + (n - 0.5) * 0.6 * hgt);
  float ends = smoothstep(0.12, 0.3, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
  col = mix(uB, uA, clamp(vUv.y * 2.0 + n * 0.3, 0.0, 1.0)) * body * ends * (0.35 + 0.35 * fill + 0.6 * uStreak + 2.2 * flare);
  a = 1.0;
`;

export const buildReaper: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('reaper', lod, finish);
  const d = rig.drive;
  const body = cached(`reaper-body-${lod}`, () => buildBody(lod));
  rig.trackerMount = body.mount;
  rig.body(body.geo, surfaceMaterial(d, { key: 'reaper', frag: FRAG }));
  rig.add(motes(d, { key: 'reaper', count: lod === 'high' ? 64 : 22, motion: WISPS, pars: EDGE_GLSL, soft: 3 }));
  rig.add(fxMesh(d, edgeFlameGeo(lod), { key: 'reaper-edge', vert: EDGE_VERT, frag: EDGE_FRAG }));
  return rig.instance();
};
