import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, extrude, fxMesh, lathe, motes, mountPad, stations, surfaceMaterial,
  taperTube, torusZ, type Lod, type PartOpts, type TrackerMount, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// SERAPH (relic) — white-gold wings folded along a hard-light barrel. White
// enamel and gold filigree; a sunburst medallion on the receiver's back; the
// barrel is a hexagonal blade of solid light held in gold rings (it fills
// rear → muzzle with the charge); a gold halo rides the emitter; two wings of
// five feathers lie folded along the barrel's flanks.
// VFX: on the shot the wings FLARE — they sweep open and lift, the light
// blade flashes white — then fold back; golden glints drift off the pinions;
// a burst of feather-light on the shot. Streak: the wings hold half-open and
// breathe, the halo burns. Reduced effects: the flare is small and slow.
// Draws: body (+ wings, vertex-animated) · light blade · glints = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { ENAMEL: 1, GOLD: 2, CORE: 3, HALO: 4, SUN: 5, FEATHER0: 8 } as const; // feathers 8 … 12
const FEATHERS = 5;
const ROOT = { x: 0.062, y: 0.056, z: -0.2 }; // wing root (the flare's pivot)
// Tracked module seat: an enamel cartouche framed in gold, low on the −X
// flank under the wing root (face x −0.062, y −0.012, z −0.142 … +0.022).
const MOUNT_FACE: V3 = [-0.062, -0.012, -0.06];

// A feather in the side plane: x = along the quill (→ −z, forward), y = the
// vane (wider on the leading side), root at the origin.
function vane(len: number, wid: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(len * 0.25, wid * 0.95, len * 0.78, wid * 0.6);
  s.quadraticCurveTo(len * 0.96, wid * 0.35, len, 0);
  s.quadraticCurveTo(len * 0.62, -wid * 0.3, len * 0.2, -wid * 0.36);
  s.quadraticCurveTo(len * 0.04, -wid * 0.2, 0, 0);
  return s;
}

function featherShape(len: number, wid: number): THREE.Shape {
  // Leaf/blade outline in the shape plane (x across, y along the feather).
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(wid * 0.9, len * 0.25, wid * 0.55, len * 0.8);
  s.quadraticCurveTo(wid * 0.3, len * 0.97, 0, len);
  s.quadraticCurveTo(-wid * 0.25, len * 0.6, -wid * 0.35, len * 0.2);
  s.quadraticCurveTo(-wid * 0.2, len * 0.04, 0, 0);
  return s;
}

function buildBody(lod: Lod): { geo: THREE.BufferGeometry; mount: TrackerMount } {
  const hi = lod === 'high';
  const SEG = hi ? 20 : 8;
  const p = new Parts();
  const ENAMEL: PartOpts = { pal: PAL.BODY, rough: 0.22, metal: 0.05, zone: Z.ENAMEL };
  const GOLD: PartOpts = { pal: PAL.METAL, rough: 0.2, metal: 1, zone: Z.GOLD };
  const GOLD_LT: PartOpts = { pal: PAL.METAL_LT, rough: 0.16, metal: 1, zone: Z.GOLD };

  // Receiver: smooth enamel with gold rails.
  p.add(stations([
    [0.14, 0.078, 0.092, 0.02],
    [0.1, 0.094, 0.112, 0.024],
    [-0.16, 0.094, 0.112, 0.024],
    [-0.25, 0.07, 0.08, 0.03],
  ], 0.03), ENAMEL);
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.006, 0.008, 0.36, 0.002), { ...GOLD, at: [sx * 0.046, 0.062, -0.05] });
    p.add(chamferBox(0.006, 0.006, 0.34, 0.002), { ...GOLD, at: [sx * 0.046, -0.014, -0.05] });
  }
  // Sunburst medallion on the back (the view looks down on it).
  p.add(lathe([[0, -0.004], [0.026, -0.004], [0.03, 0.0], [0.026, 0.004], [0, 0.004]], hi ? 24 : 10), { ...GOLD_LT, at: [0, 0.086, -0.03], rot: [-Math.PI / 2, 0, 0] });
  p.add(new THREE.CircleGeometry(0.02, hi ? 24 : 10), { col: 0xfff3d0, rough: 0.3, metal: 0.4, zone: Z.SUN, glow: 1, at: [0, 0.0905, -0.03], rot: [-Math.PI / 2, 0, 0] });
  const rays = hi ? 12 : 6;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const r = i % 2 ? 0.036 : 0.044;
    p.add(chamferBox(0.004, 0.003, r - 0.03, 0.001), { ...GOLD_LT, at: [Math.sin(a) * (0.03 + (r - 0.03) / 2), 0.087, -0.03 + Math.cos(a) * (0.03 + (r - 0.03) / 2)], rot: [0, a, 0] });
  }
  addGrip(p, { grip: { col: 0xe8e0cc, rough: 0.5, metal: 0 }, guard: GOLD, hi });
  // Stock: enamel spar + a gold tail-feather butt.
  p.add(chamferBox(0.028, 0.024, 0.3, 0.008), { ...ENAMEL, at: [0, 0.048, 0.29] });
  p.add(stations([[0.15, 0.028, 0.03, -0.058], [0.42, 0.026, 0.026, -0.09]], 0.008), ENAMEL);
  p.add(extrude(featherShape(0.2, 0.06), 0.03, 'side', 0.004, hi ? 8 : 4), { ...GOLD, at: [0, 0.07, 0.43], rot: [0, 0, 0], scale: [1, -1, 1] });
  p.add(cylZ(0.03, 0.03, 0.12, SEG), { ...ENAMEL, at: [0, 0.008, 0.22] });
  for (const z of [0.165, 0.275]) p.add(cylZ(0.034, 0.034, 0.012, SEG), { ...GOLD, at: [0, 0.008, z] });
  // Foregrip.
  p.add(stations([[-0.19, 0.068, 0.054, -0.046], [-0.31, 0.06, 0.046, -0.043]], 0.018), ENAMEL);

  // Barrel: collar, gold rings holding the light blade, a thin gold core.
  p.add(lathe([[0.03, -0.3], [0.056, -0.3], [0.062, -0.29], [0.062, -0.246], [0.054, -0.236], [0.022, -0.236]], SEG), { ...GOLD, at: [0, BARREL_Y, 0] });
  p.add(cylZ(0.006, 0.006, 0.58, 8), { col: 0xfff6dc, rough: 0.2, metal: 0.2, zone: Z.CORE, glow: 1, at: [0, BARREL_Y, -0.58] });
  for (const z of [-0.42, -0.6, -0.78]) {
    p.add(lathe([[0.036, z - 0.01], [0.044, z - 0.012], [0.048, z], [0.044, z + 0.012], [0.036, z + 0.01]], SEG), { ...GOLD, at: [0, BARREL_Y, 0] });
  }
  // Emitter: gold ring + the halo floating ahead of it.
  p.add(lathe([[0.024, -0.9], [0.04, -0.9], [0.05, -0.885], [0.05, -0.85], [0.036, -0.84]], SEG), { ...GOLD, at: [0, BARREL_Y, 0] });
  p.add(torusZ(0.06, 0.004, 6, hi ? 40 : 14), { ...GOLD_LT, zone: Z.HALO, glow: 1, at: [0, BARREL_Y, -0.82] });

  // Wings folded along the barrel's flanks, tips forward: a gold wing arm,
  // five long primaries shingled down the flank (each rolled so its vane
  // faces up and out — it reads from the side AND from above), coverts over
  // their roots. Zone = feather group (the flare fans later groups further).
  for (const sx of [-1, 1]) {
    const FEATHER: PartOpts = { col: 0xffffff, pal: PAL.BODY, rough: 0.3, metal: 0.05, glow: 1 };
    for (let k = 0; k < FEATHERS; k++) {
      const len = 0.25 + 0.045 * k;
      const wid = 0.034 - 0.002 * k;
      const zone = Z.FEATHER0 + k;
      const at: V3 = [sx * (0.068 + 0.004 * k), 0.054 - 0.013 * k, -0.2 - 0.022 * k];
      const rot: V3 = [0.07 - 0.012 * k, -sx * (0.05 + 0.01 * k), sx * (0.55 - 0.05 * k)];
      p.add(extrude(vane(len, wid), 0.0026, 'side', hi ? 0.0008 : 0, hi ? 6 : 3), { ...FEATHER, zone, at, rot });
      // Gold quill down the feather.
      if (hi) p.add(chamferBox(0.004, 0.003, len * 0.86, 0.001).translate(0, 0.004, -len * 0.43), { ...GOLD_LT, zone, glow: 0, at, rot });
    }
    // Coverts: short feathers over the primaries' roots.
    for (let k = 0; k < (hi ? 4 : 2); k++) {
      const len = 0.12 + 0.012 * k;
      const at: V3 = [sx * (0.074 + 0.002 * k), 0.062 - 0.013 * k, -0.215 - 0.012 * k];
      p.add(extrude(vane(len, 0.03), 0.003, 'side', hi ? 0.0008 : 0, hi ? 5 : 2),
        { ...FEATHER, zone: Z.FEATHER0, at, rot: [0.06 - 0.02 * k, -sx * 0.04, sx * 0.7] });
    }
    // Wing arm: the gilded leading edge from the shoulder, with a jewel boss.
    p.add(taperTube([[sx * 0.054, 0.06, -0.17], [sx * 0.07, 0.068, -0.21], [sx * 0.078, 0.064, -0.29], [sx * 0.08, 0.052, -0.36]], 0.0075, 0.003, hi ? 10 : 4, hi ? 6 : 4),
      { ...GOLD, zone: Z.FEATHER0 });
    p.add(new THREE.SphereGeometry(0.009, hi ? 10 : 6, hi ? 8 : 4), { ...GOLD_LT, zone: Z.FEATHER0, at: [sx * 0.066, 0.066, -0.2] });
  }
  // Tracked module seat: enamel cartouche, gold lip + gold bolts.
  const mount = mountPad(p, { face: MOUNT_FACE, depth: 0.022, pad: ENAMEL, rim: GOLD_LT, hi });
  return { geo: p.merge(`seraph-${lod}`), mount };
}

const VERT = /* glsl */ `
  if (vZone >= ${Z.FEATHER0} && vZone < ${Z.FEATHER0 + FEATHERS}) {
    float k = float(vZone - ${Z.FEATHER0});
    float sx = sign(position.x);
    float open = exp(-uShot * 3.2) * (1.0 - exp(-uShot * 28.0)) * step(uShot, 3.0);
    float spread = mix(open, open * 0.4, uCalm) + 0.32 * uStreak + 0.02 * sin(uTime * 1.3 + k) * (1.0 - uCalm);
    cgPivot = vec3(sx * ${ROOT.x.toFixed(3)}, ${ROOT.y.toFixed(3)}, ${ROOT.z.toFixed(3)});
    // Tips swing out (yaw) and the wing lifts (roll), later groups further:
    // the wing fans open.
    cgR = cgRotY(-sx * spread * (0.16 + 0.05 * k)) * cgRotZ(sx * spread * (0.14 + 0.035 * k));
  }
`;

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  if (zone == ${Z.ENAMEL}) {
    // Gold filigree: thin curling lines in the enamel.
    float n = cgNoise(vOP * 90.0);
    float line = 1.0 - smoothstep(0.0, 0.05, abs(n - 0.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, uM * 1.1, line * 0.85);
    metalnessFactor = mix(metalnessFactor, 1.0, line);
    roughnessFactor = mix(roughnessFactor, 0.2, line);
    glow += uA * line * (0.03 + 0.4 * uFire);
  } else if (zone == ${Z.GOLD}) {
    glow += uA * fres * (0.04 + 0.2 * uStreak);
  } else if (zone == ${Z.CORE}) {
    float f = cgFill(vOP.z, -0.29, -0.87);
    glow += mix(uA, uB, 0.6) * (mix(0.1, 1.2, f) + 0.4 * uStreak + 4.0 * uFire);
  } else if (zone == ${Z.HALO}) {
    glow += mix(uA, uB, 0.4) * gmask * (0.35 + 0.5 * fill + 1.2 * uStreak + 3.0 * uFire);
  } else if (zone == ${Z.SUN}) {
    vec2 q = vOP.xz - vec2(0.0, -0.03);
    float r = length(q) / 0.02;
    float ray = 0.5 + 0.5 * cos(atan(q.x, q.y) * 12.0 + uTime * 0.6);
    glow += mix(uA, uB, 0.5) * (0.25 + 0.35 * fill * (1.0 - r) + 0.25 * ray * r + 0.8 * uStreak + 2.0 * uFire);
  } else if (zone >= ${Z.FEATHER0} && zone < ${Z.FEATHER0 + FEATHERS}) {
    // Feathers: barbs along the vane, gilded toward the tips; glowing edges
    // when the wings flare.
    float open = exp(-uShot * 3.2) * step(uShot, 3.0);
    float barb = 0.5 + 0.5 * sin((vOP.z * 1.0 + vOP.y * 1.6) * 300.0);
    float tip = smoothstep(-0.42, -0.66, vOP.z);
    diffuseColor.rgb = mix(diffuseColor.rgb * (0.9 + 0.1 * barb), uL, tip * 0.8);
    metalnessFactor = mix(0.05, 0.9, tip);
    glow += mix(uA, uB, 0.5) * (fres * (0.1 + 0.4 * uStreak) + tip * 0.15 * fill + (0.3 + fres) * 0.7 * open * (1.0 - uCalm * 0.5)) * gmask;
  }
`;

// The light blade: a hexagonal prism of hard light (additive), cross-hatched
// with drifting scan lines; fills with the charge, flashes on the shot.
function bladeGeo(lod: Lod): THREE.BufferGeometry {
  return cached(`seraph-blade-${lod}`, () => {
    const g = new THREE.CylinderGeometry(0.03, 0.036, 0.6, 6, lod === 'high' ? 12 : 4, false);
    g.rotateX(-Math.PI / 2);
    g.rotateZ(Math.PI / 6);
    g.translate(0, BARREL_Y, -0.57);
    g.userData.shared = true;
    return g;
  });
}
const BLADE_FRAG = /* glsl */ `
  float f = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float p = clamp((vP.z + 0.27) / -0.6, 0.0, 1.0);
  float lit = smoothstep(p - 0.03, p + 0.05, f * 1.06);
  float scan = 0.5 + 0.5 * sin(vP.z * 160.0 + uTime * 5.0 * (1.0 - uCalm));
  float edge = pow(1.0 - abs(dot(vN, vV)), 2.0);
  vec3 c = mix(uA, uB, 0.35 + 0.4 * edge);
  col = c * ((0.05 + 0.4 * lit) * (0.35 + 0.65 * edge) * (0.75 + 0.25 * scan) + 0.25 * uStreak * edge + 1.2 * uFire * (0.4 + edge));
  a = 1.0;
`;

// Golden glints drifting off the pinions; on the shot a burst of feather-light.
const GLINTS = /* glsl */ `
  float life = 2.0 + seed.y * 2.0;
  float t = uTime / life + seed.x * 6.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h1 = cgH1(cyc * 11.3 + seed.z * 37.0);
  float sx = seed.z < 0.5 ? -1.0 : 1.0;
  vec3 o = vec3(sx * (0.07 + 0.03 * h1), 0.02 - 0.05 * h1, -0.3 - 0.4 * fract(h1 * 7.0));
  p = o + vec3(sx * ph * 0.02, ph * 0.03 - ph * ph * 0.05, ph * 0.04);
  size = 0.006 + 0.006 * seed.y;
  col = mix(uA, uB, 0.5) * (1.1 + 1.2 * uStreak);
  float tw = 0.6 + 0.4 * sin(uTime * 7.0 + seed.x * 50.0) * (1.0 - uCalm);
  a = sin(ph * 3.14159) * tw * (0.35 + 0.65 * uStreak);
  if (seed.y < 0.45 && uShot < 1.2) {
    float k = 1.0 - exp(-uShot * 4.0);
    vec3 dir = normalize(vec3(sx * (0.6 + seed.x), 0.2 + seed.z * 0.4, 0.3 - seed.x * 0.6));
    p = vec3(sx * 0.08, 0.0, -0.35 - 0.3 * seed.x) + dir * k * 0.09 - vec3(0.0, uShot * uShot * 0.03, 0.0);
    col = mix(uA, uB, 0.7) * 2.0;
    size = 0.008;
    a = exp(-uShot * 2.5);
  }
`;

export const buildSeraph: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('seraph', lod, finish);
  const d = rig.drive;
  const body = cached(`seraph-body-${lod}`, () => buildBody(lod));
  rig.trackerMount = body.mount;
  rig.body(body.geo, surfaceMaterial(d, { key: 'seraph', vert: VERT, frag: FRAG, side: THREE.DoubleSide }));
  rig.add(fxMesh(d, bladeGeo(lod), { key: 'seraph-blade', frag: BLADE_FRAG, side: THREE.FrontSide }));
  rig.add(motes(d, { key: 'seraph', count: lod === 'high' ? 60 : 20, motion: GLINTS, star: true }));
  return rig.instance();
};
