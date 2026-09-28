import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, cylZ, fxMesh, hull, lathe, motes, stations, surfaceMaterial, torusZ,
  type Lod, type PartOpts, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// SOVEREIGN REGALIA (staff) — the crown-gun. White enamel and gilded gold,
// fluted and filigreed: a jewelled crest on the receiver's back, gold
// fleur-de-lis prongs at the emitter, an orb-and-cross pommel on the stock.
// Around the barrel floats a CROWN — a gold circlet with alternating crosses
// and fleurons, set with rubies and sapphires — slowly turning and bobbing,
// with three cut gems orbiting inside it.
// VFX: royal light — a soft golden aura ring round the crown, glinting
// motes drifting up off the gold; on the shot the crown spins up and flares,
// the gems flash and a ring of light bursts outward. Streak: the crown lifts
// and burns brighter, the glints thicken into a shower.
// Draws: body (+ crown and gems, vertex-animated) · aura · glints = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { ENAMEL: 1, GOLD: 2, JEWEL: 3, CROWN: 4, CROWN_JEWEL: 5, ORBIT_GEM: 6, CREST: 7 } as const;
const CROWN_C: V3 = [0, 0.132, -0.025]; // floats over the crest
const CROWN_R = 0.036;

function gem(r: number): THREE.BufferGeometry {
  // A brilliant-ish cut: crown table + pavilion point (8 facets).
  const pts: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
    pts.push([Math.cos(a + Math.PI / 8) * r * 0.6, Math.sin(a + Math.PI / 8) * r * 0.6, r * 0.45]);
  }
  pts.push([0, 0, -r * 1.1]);
  return hull(pts);
}

function buildBody(lod: Lod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 20 : 8;
  const p = new Parts();
  const ENAMEL: PartOpts = { pal: PAL.BODY, rough: 0.18, metal: 0.05, zone: Z.ENAMEL };
  const GOLD: PartOpts = { pal: PAL.METAL, rough: 0.32, metal: 1, zone: Z.GOLD };
  const GOLD_LT: PartOpts = { pal: PAL.METAL_LT, rough: 0.24, metal: 1, zone: Z.GOLD };
  const RUBY: PartOpts = { col: 0xc0102a, rough: 0.05, metal: 0.1, zone: Z.JEWEL, glow: 1, flat: true };
  const SAPPHIRE: PartOpts = { col: 0x1840d0, rough: 0.05, metal: 0.1, zone: Z.JEWEL, glow: 1, flat: true };
  const EMERALD: PartOpts = { col: 0x10a050, rough: 0.05, metal: 0.1, zone: Z.JEWEL, glow: 1, flat: true };

  // Receiver: enamel body, gold bands and fluted gold cheeks.
  p.add(stations([
    [0.14, 0.08, 0.094, 0.02],
    [0.1, 0.096, 0.114, 0.024],
    [-0.16, 0.096, 0.114, 0.024],
    [-0.25, 0.07, 0.082, 0.03],
  ], 0.026), ENAMEL);
  for (const z of [0.1, -0.03, -0.16]) p.add(chamferBox(0.1, 0.12, 0.012, 0.004), { ...GOLD, at: [0, 0.024, z] });
  for (const sx of [-1, 1]) {
    for (let i = 0; i < (hi ? 4 : 2); i++) p.add(chamferBox(0.006, 0.006, 0.3, 0.002), { ...GOLD_LT, at: [sx * 0.049, 0.05 - i * 0.018, -0.05] });
  }
  // Crest on the back: a gold shield set with a ruby.
  p.add(hull([[-0.024, 0.088, 0.02], [0.024, 0.088, 0.02], [-0.024, 0.088, -0.02], [0.024, 0.088, -0.02], [0, 0.088, -0.05],
    [-0.02, 0.096, 0.016], [0.02, 0.096, 0.016], [-0.02, 0.096, -0.016], [0.02, 0.096, -0.016], [0, 0.096, -0.042]]), { ...GOLD_LT, zone: Z.CREST, flat: true });
  p.add(gem(0.011), { ...RUBY, at: [0, 0.098, -0.01], rot: [-Math.PI / 2, 0, 0] });
  addGrip(p, { grip: { col: 0x3a0a14, rough: 0.6, metal: 0 }, guard: GOLD, hi }); // royal velvet
  // Stock: a gilded sceptre ending in an orb and cross.
  p.add(cylZ(0.016, 0.02, 0.3, SEG), { ...GOLD, at: [0, 0.03, 0.29] });
  for (const z of [0.18, 0.26, 0.34]) p.add(lathe([[0.012, z - 0.01], [0.026, z - 0.004], [0.026, z + 0.004], [0.012, z + 0.01]], SEG), { ...GOLD_LT, at: [0, 0.03, 0] });
  p.add(stations([[0.15, 0.03, 0.03, -0.06], [0.4, 0.028, 0.028, -0.09]], 0.008), ENAMEL);
  p.add(chamferBox(0.042, 0.17, 0.028, 0.01), { ...ENAMEL, at: [0, -0.03, 0.43] });
  p.add(new THREE.SphereGeometry(0.03, hi ? 20 : 10, hi ? 14 : 8), { ...GOLD_LT, at: [0, 0.075, 0.43] });
  p.add(chamferBox(0.008, 0.04, 0.008, 0.002), { ...GOLD_LT, at: [0, 0.12, 0.43] });
  p.add(chamferBox(0.026, 0.008, 0.008, 0.002), { ...GOLD_LT, at: [0, 0.126, 0.43] });
  p.add(torusZ(0.031, 0.003, 4, SEG), { ...GOLD, at: [0, 0.075, 0.43], rot: [Math.PI / 2, 0, 0] });
  // Foregrip.
  p.add(stations([[-0.19, 0.068, 0.054, -0.046], [-0.31, 0.06, 0.046, -0.043]], 0.014), ENAMEL);

  // Barrel: fluted gold with enamel rings.
  p.add(lathe([[0.03, -0.3], [0.056, -0.3], [0.062, -0.29], [0.062, -0.246], [0.054, -0.236], [0.022, -0.236]], SEG), { ...GOLD, at: [0, BARREL_Y, 0] });
  const flutes = hi ? 12 : 6;
  p.add(cylZ(0.03, 0.026, 0.54, flutes * 2, false), { ...GOLD, at: [0, BARREL_Y, -0.56], flat: true });
  for (const z of [-0.36, -0.46, -0.68, -0.78]) {
    p.add(lathe([[0.028, z - 0.012], [0.038, z - 0.008], [0.038, z + 0.008], [0.028, z + 0.012]], SEG), { ...ENAMEL, at: [0, BARREL_Y, 0] });
  }
  // Emitter: gold bell + three fleur-de-lis prongs.
  p.add(lathe([[0.022, -0.87], [0.042, -0.87], [0.05, -0.855], [0.046, -0.82], [0.03, -0.8]], SEG), { ...GOLD_LT, at: [0, BARREL_Y, 0] });
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    const at: V3 = [Math.cos(a) * 0.046, BARREL_Y + Math.sin(a) * 0.046, 0];
    const rot: V3 = [0, 0, a - Math.PI / 2];
    p.add(hull([[-0.004, 0, -0.84], [0.004, 0, -0.84], [-0.003, 0.004, -0.92], [0.003, 0.004, -0.92], [0, 0.012, -0.9]]), { ...GOLD_LT, at, rot, flat: true });
    p.add(hull([[-0.003, 0, -0.86], [0.003, 0, -0.86], [-0.02, 0.016, -0.9], [-0.016, 0.02, -0.885]]), { ...GOLD_LT, at, rot, flat: true });
    p.add(hull([[-0.003, 0, -0.86], [0.003, 0, -0.86], [0.02, 0.016, -0.9], [0.016, 0.02, -0.885]]), { ...GOLD_LT, at, rot, flat: true });
  }

  // ── The floating crown over the receiver (zones CROWN / CROWN_JEWEL:
  // turns + bobs about its vertical axis) ──
  const CR: PartOpts = { ...GOLD_LT, zone: Z.CROWN };
  const [cx, cy, cz] = CROWN_C;
  // Band (lathe about Z, stood up so its axis is Y).
  p.add(lathe([[CROWN_R - 0.003, -0.007], [CROWN_R + 0.002, -0.008], [CROWN_R + 0.003, 0], [CROWN_R + 0.002, 0.008], [CROWN_R - 0.003, 0.007], [CROWN_R - 0.003, -0.007]], hi ? 40 : 14),
    { ...CR, at: [cx, cy, cz], rot: [-Math.PI / 2, 0, 0] });
  // Points: alternating crosses pattée and fleurons standing up off the band.
  const pts = hi ? 8 : 4;
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2 + Math.PI / 8;
    const c = Math.cos(a), s = Math.sin(a);
    const x = cx + c * CROWN_R, z = cz + s * CROWN_R;
    const rot: V3 = [0, -a + Math.PI / 2, 0];
    if (i % 2 === 0) {
      p.add(chamferBox(0.005, 0.02, 0.004, 0.001), { ...CR, at: [x, cy + 0.017, z], rot });
      p.add(chamferBox(0.014, 0.005, 0.004, 0.001), { ...CR, at: [x, cy + 0.022, z], rot });
    } else {
      p.add(hull([[-0.007, 0, 0], [0.007, 0, 0], [0, 0.02, 0], [-0.003, 0.009, 0.002], [0.003, 0.009, 0.002], [-0.003, 0.009, -0.002], [0.003, 0.009, -0.002]]),
        { ...CR, at: [x, cy + 0.007, z], rot, flat: true });
    }
  }
  // Jewels set round the band.
  for (let i = 0; i < (hi ? 8 : 4); i++) {
    const a = (i / (hi ? 8 : 4)) * Math.PI * 2;
    p.add(gem(0.005), { ...(i % 2 ? SAPPHIRE : RUBY), zone: Z.CROWN_JEWEL, at: [cx + Math.cos(a) * (CROWN_R + 0.004), cy, cz + Math.sin(a) * (CROWN_R + 0.004)], rot: [0, -a + Math.PI / 2, 0], scale: [1, 1, 0.7] });
  }
  // Orbiting gems round the barrel.
  const orbit = [RUBY, SAPPHIRE, EMERALD];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    p.add(gem(0.009), { ...orbit[i], zone: Z.ORBIT_GEM, at: [Math.cos(a) * 0.056, BARREL_Y + Math.sin(a) * 0.056, -0.5 + i * 0.04], rot: [0, Math.PI / 2, a] });
  }
  return p.merge(`sovereign-${lod}`);
}

const VERT = /* glsl */ `
  float spinUp = exp(-uShot * 2.2) * step(uShot, 3.0);
  if (vZone == ${Z.CROWN} || vZone == ${Z.CROWN_JEWEL}) {
    cgPivot = vec3(${CROWN_C.map((v) => v.toFixed(3)).join(', ')});
    cgR = cgRotY(uPhase * 0.35 + spinUp * 1.4);
    // Float: a slow bob; a streak lifts it a little higher.
    cgOff = vec3(0.0, 0.003 * sin(uTime * 1.4) * (1.0 - uCalm) + 0.006 * uStreak + 0.004 * spinUp, 0.0);
  } else if (vZone == ${Z.ORBIT_GEM}) {
    cgPivot = vec3(0.0, ${BARREL_Y.toFixed(3)}, 0.0);
    cgR = cgRotZ(-uPhase * 0.9);
  }
`;

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float flare = exp(-uShot * 4.0) * step(uShot, 2.0);
  vec3 royal = mix(uA, uB, 0.35);
  if (zone == ${Z.ENAMEL}) {
    // Gold filigree scrolls in the white enamel.
    float n = cgNoise(vOP * 110.0);
    float n2 = cgNoise(vOP * 45.0 + 3.0);
    float line = (1.0 - smoothstep(0.0, 0.045, abs(n - 0.5))) * smoothstep(0.35, 0.6, n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, uL, line);
    metalnessFactor = mix(metalnessFactor, 1.0, line);
    roughnessFactor = mix(roughnessFactor, 0.15, line);
    glow += royal * line * (0.04 + 0.2 * uStreak + 0.8 * flare);
  } else if (zone == ${Z.GOLD} || zone == ${Z.CREST}) {
    glow += royal * fres * (0.06 + 0.25 * uStreak + 0.8 * flare);
  } else if (zone == ${Z.CROWN}) {
    diffuseColor.rgb *= 1.1;
    glow += royal * (0.12 + 0.35 * fres + 0.25 * fill + 0.8 * uStreak + 2.2 * flare);
  } else if (zone == ${Z.JEWEL} || zone == ${Z.CROWN_JEWEL} || zone == ${Z.ORBIT_GEM}) {
    // Facet sparkle: bright where a facet catches the view.
    float spark = pow(1.0 - fres, 24.0) * (0.6 + 0.4 * sin(uTime * 3.0 + vOP.x * 300.0) * (1.0 - uCalm));
    glow += vColor.rgb * (0.35 + 1.4 * spark + 0.6 * uStreak + 3.0 * flare) + vec3(1.0) * spark * 0.4;
  }
`;

// Aura: a soft ring of golden light round the crown (camera-independent, in
// the crown's plane) that breathes, and a ring of light that bursts outward
// on the shot.
function auraGeo(): THREE.BufferGeometry {
  return cached('sovereign-aura', () => {
    const g = new THREE.RingGeometry(0.02, 0.14, 48, 2);
    g.rotateX(-Math.PI / 2);
    g.translate(CROWN_C[0], CROWN_C[1] - 0.004, CROWN_C[2]);
    g.userData.shared = true;
    return g;
  });
}
const AURA_FRAG = /* glsl */ `
  float r = length(vP.xz - vec2(${CROWN_C[0].toFixed(3)}, ${CROWN_C[2].toFixed(3)}));
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float breathe = 0.8 + 0.2 * sin(uTime * 1.6) * (1.0 - uCalm);
  float ring = exp(-pow((r - ${(CROWN_R + 0.006).toFixed(3)}) / 0.01, 2.0)) * breathe;
  float sr = ${CROWN_R.toFixed(3)} + uShot * 0.25;
  float burst = exp(-pow((r - sr) / (0.006 + uShot * 0.02), 2.0)) * exp(-uShot * 6.0) * step(uShot, 0.9) * smoothstep(0.14, 0.09, r);
  float face = 0.35 + 0.65 * abs(dot(vN, vV));
  vec3 gold = mix(uA, uB, 0.3);
  col = gold * (ring * (0.12 + 0.12 * fill + 0.35 * uStreak) + burst * 1.6 * (1.0 - uCalm * 0.5)) * face;
  a = 1.0;
`;

// Glints: golden sparkles drifting up off the gold; a shower on a streak;
// a starburst of them off the crown on the shot.
const GLINTS = /* glsl */ `
  float life = 1.8 + seed.y * 1.8;
  float t = uTime / life + seed.x * 8.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h1 = cgH1(cyc * 9.7 + seed.z * 29.0);
  float h2 = cgH1(cyc * 3.1 + seed.x * 71.0);
  float ang = h1 * 6.283;
  vec3 o = seed.z < 0.6
    ? vec3(${CROWN_C[0].toFixed(3)} + cos(ang) * ${(CROWN_R + 0.004).toFixed(3)}, ${CROWN_C[1].toFixed(3)} + (h2 - 0.2) * 0.02, ${CROWN_C[2].toFixed(3)} + sin(ang) * ${(CROWN_R + 0.004).toFixed(3)})
    : vec3((h2 - 0.5) * 0.09, 0.09, 0.1 - h1 * 0.3);
  p = o + vec3(sin(ph * 5.0 + seed.x * 9.0) * 0.006, ph * 0.045, ph * 0.02);
  size = 0.006 + 0.007 * seed.y;
  float tw = 0.5 + 0.5 * sin(uTime * 9.0 + seed.x * 70.0) * (1.0 - uCalm);
  col = mix(uA, uB, 0.6) * (1.3 + 1.0 * uStreak);
  a = sin(ph * 3.14159) * tw * (0.3 + 0.25 * clamp((uCharge - 0.1) / 0.88, 0.0, 1.0) + 0.6 * uStreak);
  if (seed.y < 0.4 && uShot < 1.0) {
    float k = 1.0 - exp(-uShot * 6.0);
    float aa = seed.z * 6.283;
    vec3 dir = vec3(cos(aa), 0.15 + 0.3 * seed.x, sin(aa));
    p = vec3(${CROWN_C.map((v) => v.toFixed(3)).join(', ')}) + vec3(cos(aa), 0.0, sin(aa)) * ${CROWN_R.toFixed(3)} + dir * k * 0.07;
    col = mix(uA, uB, 0.8) * 2.4;
    size = 0.008;
    a = exp(-uShot * 3.5);
  }
`;

export const buildSovereign: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('sovereign', lod, finish);
  const d = rig.drive;
  rig.body(cached(`sovereign-body-${lod}`, () => buildBody(lod)), surfaceMaterial(d, { key: 'sovereign', vert: VERT, frag: FRAG }));
  rig.add(fxMesh(d, auraGeo(), { key: 'sovereign-aura', frag: AURA_FRAG }));
  rig.add(motes(d, { key: 'sovereign', count: lod === 'high' ? 70 : 24, motion: GLINTS, star: true }));
  return rig.instance();
};
