import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, extrude, fxMesh, hull, lathe, motes, stations, surfaceMaterial,
  type Lod, type PartOpts,
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
// Draws: body · wisps · edge flame = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { IRON: 1, SOUL: 2, RUNE: 3, BLADE: 4, EDGE: 5, LANTERN: 6 } as const;

// Blade crescent in the side plane (shape x = −model z, shape y = model y).
function bladeShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0.83, 0.0); // root, under the muzzle shroud
  s.quadraticCurveTo(0.78, -0.13, 0.5, -0.17); // outer (cutting) edge sweeps back
  s.quadraticCurveTo(0.43, -0.172, 0.37, -0.15); // the point, curling back
  s.quadraticCurveTo(0.48, -0.145, 0.6, -0.105);
  s.quadraticCurveTo(0.72, -0.07, 0.75, 0.0); // inner (spine) edge back to the barrel
  s.closePath();
  return s;
}
// Points along the cutting edge (model space z, y) for the edge flame.
function edgePoint(t: number): [number, number] {
  // Quadratic segments: root (0.83,0) ctl (0.78,-0.13) → (0.5,-0.17) ctl (0.43,-0.172) → (0.37,-0.15).
  const q = (a: number, b: number, c: number, u: number) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * b + u * u * c;
  if (t < 0.7) {
    const u = t / 0.7;
    return [-q(0.83, 0.78, 0.5, u), q(0.0, -0.13, -0.17, u)];
  }
  const u = (t - 0.7) / 0.3;
  return [-q(0.5, 0.43, 0.37, u), q(-0.17, -0.172, -0.15, u)];
}

function buildBody(lod: Lod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 16 : 8;
  const p = new Parts();
  const IRON: PartOpts = { pal: PAL.BODY, rough: 0.5, metal: 0.8, zone: Z.IRON };
  const STEEL: PartOpts = { pal: PAL.METAL, rough: 0.35, metal: 0.9, zone: Z.IRON };
  const SILVER: PartOpts = { pal: PAL.METAL_LT, rough: 0.25, metal: 1 };
  const SOUL: PartOpts = { col: 0x020605, rough: 0.2, metal: 0, zone: Z.SOUL, glow: 1 };
  const BONE: PartOpts = { col: 0xcfc8b8, rough: 0.6, metal: 0 };

  // Receiver: a sharp-chamfered gothic block with a pointed brow.
  p.add(stations([
    [0.14, 0.08, 0.094, 0.02],
    [0.09, 0.096, 0.114, 0.022],
    [-0.16, 0.096, 0.114, 0.022],
    [-0.25, 0.066, 0.08, 0.03],
  ], 0.026), { ...IRON, flat: true });
  // Soul channel on top + an iron ribcage over it.
  p.add(chamferBox(0.036, 0.01, 0.26, 0.003), { ...SOUL, at: [0, 0.079, -0.04] });
  const ribs = hi ? 7 : 4;
  for (let i = 0; i < ribs; i++) {
    const z = 0.07 - i * (0.22 / (ribs - 1));
    p.add(hull([[-0.03, 0.078, z + 0.006], [0.03, 0.078, z + 0.006], [-0.03, 0.078, z - 0.006], [0.03, 0.078, z - 0.006],
      [-0.018, 0.092, z], [0.018, 0.092, z], [0, 0.094, z - 0.004]]), { ...BONE, flat: true });
  }
  // Spine bar through the ribs.
  p.add(chamferBox(0.008, 0.008, 0.26, 0.002), { ...SILVER, at: [0, 0.094, -0.04] });
  // Side blades (fins) on the receiver flanks.
  for (const sx of [-1, 1]) {
    p.add(hull([[sx * 0.048, 0.06, 0.08], [sx * 0.048, 0.0, 0.08], [sx * 0.048, 0.04, -0.2], [sx * 0.056, 0.035, -0.02], [sx * 0.056, 0.02, 0.05]]), { ...STEEL, flat: true });
  }
  addGrip(p, { grip: { col: 0x141416, rough: 0.8, metal: 0 }, guard: STEEL, hi });
  // Stock: two iron bars and a hooked butt.
  p.add(chamferBox(0.028, 0.024, 0.3, 0.006), { ...IRON, at: [0, 0.05, 0.29] });
  p.add(stations([[0.15, 0.03, 0.03, -0.06], [0.42, 0.028, 0.028, -0.095]], 0.007), IRON);
  p.add(hull([[0, 0.07, 0.41], [0, -0.14, 0.41], [-0.02, 0.05, 0.445], [0.02, 0.05, 0.445], [-0.02, -0.12, 0.445], [0.02, -0.12, 0.445], [0, -0.17, 0.43]]), { ...STEEL, flat: true });
  // Soul lantern: glass orb in a cage (capacitor spot).
  p.add(new THREE.SphereGeometry(0.03, hi ? 16 : 8, hi ? 12 : 6), { col: 0x000403, rough: 0.1, metal: 0, zone: Z.LANTERN, glow: 1, at: [0, 0.008, 0.215] });
  for (let i = 0; i < (hi ? 6 : 3); i++) {
    const a = (i / (hi ? 6 : 3)) * Math.PI * 2;
    p.add(chamferBox(0.006, 0.006, 0.09, 0.002), { ...SILVER, at: [Math.cos(a) * 0.034, 0.008 + Math.sin(a) * 0.034, 0.215] });
  }
  for (const z of [0.165, 0.265]) p.add(lathe([[0.02, z - 0.008], [0.04, z - 0.006], [0.04, z + 0.006], [0.02, z + 0.008]], SEG), { ...STEEL, at: [0, 0.008, 0] });
  // Foregrip.
  p.add(stations([[-0.19, 0.068, 0.054, -0.046], [-0.31, 0.058, 0.046, -0.043]], 0.014), IRON);

  // Barrel: hexagonal iron with rune bands (the charge meter).
  p.add(lathe([[0.028, -0.3], [0.056, -0.3], [0.062, -0.29], [0.062, -0.246], [0.054, -0.236], [0.022, -0.236]], 6, Math.PI / 6), { ...STEEL, at: [0, BARREL_Y, 0], flat: true });
  p.add(cylZ(0.038, 0.034, 0.48, 6), { ...IRON, zone: Z.RUNE, glow: 1, at: [0, BARREL_Y, -0.54], flat: true });
  for (const z of [-0.38, -0.56, -0.74]) {
    p.add(lathe([[0.036, z - 0.012], [0.046, z - 0.008], [0.046, z + 0.008], [0.036, z + 0.012]], 6, Math.PI / 6), { ...SILVER, at: [0, BARREL_Y, 0], flat: true });
  }
  // Muzzle shroud: a pointed hood.
  p.add(hull([
    [-0.042, BARREL_Y - 0.03, -0.77], [0.042, BARREL_Y - 0.03, -0.77], [-0.042, BARREL_Y + 0.04, -0.77], [0.042, BARREL_Y + 0.04, -0.77],
    [-0.03, BARREL_Y - 0.03, -0.9], [0.03, BARREL_Y - 0.03, -0.9], [0, BARREL_Y + 0.052, -0.83], [0, BARREL_Y + 0.02, -0.93],
  ]), { ...STEEL, flat: true });
  // The scythe blade (4 mm thick) + its tang on the barrel.
  p.add(extrude(bladeShape(), 0.004, 'side', 0.0015, hi ? 14 : 6), { ...SILVER, zone: Z.BLADE, at: [0, BARREL_Y - 0.03, 0] });
  p.add(hull([[-0.008, BARREL_Y - 0.02, -0.72], [0.008, BARREL_Y - 0.02, -0.72], [-0.008, BARREL_Y - 0.02, -0.86], [0.008, BARREL_Y - 0.02, -0.86],
    [-0.006, BARREL_Y - 0.05, -0.76], [0.006, BARREL_Y - 0.05, -0.84]]), { ...STEEL, flat: true });
  return p.merge(`reaper-${lod}`);
}

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  vec3 soul = mix(uA, uB, 0.25);
  if (zone == ${Z.IRON}) {
    float n = cgFbm(vOP * 70.0);
    diffuseColor.rgb *= 0.7 + 0.5 * n;
    roughnessFactor = clamp(roughnessFactor + (n - 0.5) * 0.3, 0.1, 1.0);
  } else if (zone == ${Z.SOUL}) {
    float n = cgNoise(vec3(vOP.z * 30.0 - uTime * 1.5, vOP.x * 60.0, uTime * 0.5));
    glow += soul * gmask * (0.25 + 0.6 * fill * n + 0.8 * uStreak + 2.5 * uFire);
  } else if (zone == ${Z.LANTERN}) {
    float n = cgFbm(vOP * 50.0 + vec3(0.0, -uTime * 1.2, 0.0));
    glow += mix(soul, uB, uStreak) * gmask * (0.4 + 0.5 * n + 0.5 * fill + 1.2 * uStreak + 3.0 * uFire) * (0.5 + fres);
  } else if (zone == ${Z.RUNE}) {
    // Runes: carved glyph cells on each face of the hex barrel.
    float ang = atan(vOP.y - ${BARREL_Y.toFixed(3)}, vOP.x);
    vec2 g = vec2(vOP.z * 55.0, ang * 3.0);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float h = cgH3(vec3(cell, 3.0));
    float strokeA = step(abs(f.x - 0.5), 0.07) * step(0.15, f.y) * step(f.y, 0.85);
    float strokeB = step(abs(f.y - (0.3 + 0.4 * h)), 0.07) * step(0.2, f.x) * step(f.x, 0.8);
    float strokeC = step(abs(f.x - f.y), 0.08) * step(0.5, h);
    float rune = max(strokeA * step(0.25, h), max(strokeB, strokeC)) * step(0.35, cgH3(vec3(cell, 9.0))) * step(fract(g.y), 0.99);
    float lit = cgFill(vOP.z, -0.3, -0.78);
    diffuseColor.rgb *= 1.0 - rune * 0.6;
    glow += soul * rune * (0.05 + (0.9 + 0.8 * uStreak) * lit + 3.0 * uFire);
  } else if (zone == ${Z.BLADE}) {
    // Polished steel with a bright bevel toward the cutting edge (low y).
    float edge = smoothstep(-0.13, -0.2, vOP.y) + smoothstep(-0.75, -0.83, vOP.z) * smoothstep(-0.06, -0.1, vOP.y);
    roughnessFactor = mix(0.3, 0.12, edge);
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.55, diffuseColor.rgb * 1.2, edge);
    float etch = step(0.6, cgNoise(vec3(vOP.z * 90.0, vOP.y * 90.0, 1.0))) * (1.0 - edge);
    glow += soul * etch * (0.1 + 0.3 * fill + 0.5 * uStreak + 1.5 * uFire);
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
    // Along the blade's cutting edge.
    float e = h1;
    float z = mix(-0.83, -0.4, e);
    float y = ${BARREL_Y.toFixed(3)} - 0.03 - 0.17 * sin(e * 3.14159 * 0.55 + 0.25) ;
    o = vec3((h2 - 0.5) * 0.01, y, z);
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

// Cold flame along the cutting edge: a ribbon hanging off the edge (uv.x
// along the edge, uv.y outward), flowing back along the blade.
function edgeFlameGeo(lod: Lod): THREE.BufferGeometry {
  return cached(`reaper-edge-${lod}`, () => {
    const n = lod === 'high' ? 24 : 10;
    const pos: number[] = [];
    const uv: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [z, y] = edgePoint(t);
      const [z2, y2] = edgePoint(Math.min(1, t + 0.01));
      const [z1, y1] = edgePoint(Math.max(0, t - 0.01));
      // Outward normal of the edge in the side plane.
      let nz = -(y2 - y1), ny = z2 - z1;
      const l = Math.hypot(nz, ny) || 1;
      nz /= l; ny /= l;
      if (ny > 0) { nz = -nz; ny = -ny; }
      for (const k of [0, 1]) {
        pos.push(0, BARREL_Y - 0.03 + y + ny * 0.05 * k, z + nz * 0.05 * k);
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
  p.z += uv.y * (0.012 + 0.03 * flare);
`;
const EDGE_FRAG = /* glsl */ `
  float flare = exp(-uShot * 4.0) * step(uShot, 1.5);
  float hgt = 0.3 + 0.25 * uStreak + 0.7 * flare;
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float n = cgFbm(vec3(vUv.x * 9.0 + uTime * 1.6, vUv.y * 2.5 - uTime * 2.2, 0.0));
  float body = smoothstep(hgt, 0.0, vUv.y + (n - 0.5) * 0.6 * hgt);
  float ends = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
  col = mix(uB, uA, clamp(vUv.y * 2.0 + n * 0.3, 0.0, 1.0)) * body * ends * (0.35 + 0.35 * fill + 0.6 * uStreak + 2.2 * flare);
  a = 1.0;
`;

export const buildReaper: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('reaper', lod, finish);
  const d = rig.drive;
  rig.body(cached(`reaper-body-${lod}`, () => buildBody(lod)), surfaceMaterial(d, { key: 'reaper', frag: FRAG }));
  rig.add(motes(d, { key: 'reaper', count: lod === 'high' ? 64 : 22, motion: WISPS, soft: 3 }));
  rig.add(fxMesh(d, edgeFlameGeo(lod), { key: 'reaper-edge', vert: EDGE_VERT, frag: EDGE_FRAG }));
  return rig.instance();
};
