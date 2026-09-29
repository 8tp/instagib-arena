import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, cached, chamferBox, fxMesh, hull, lathe, motes, stations, surfaceMaterial, tube,
  type Lod, type PartOpts, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// WYRMFANG (legendary) — a scaled dragon-bone rail. The receiver is plated
// in dark scales with ember light burning in the seams (hotter as the rail
// charges); a row of bone spines runs down the back; the barrel is a
// vertebral column caged in ribs with a molten core (the charge meter); the
// muzzle is a dragon skull, jaws open, the beam leaving between its teeth.
// VFX: embers rising off the seams and the jaws; a smoulder licking out of
// the mouth that ROARS into a short breath cone on the shot. Streak: the
// seams and eyes burn white-hot, the smoulder never goes out.
// Draws: body · embers · breath = 3.
// ─────────────────────────────────────────────────────────────────────────

const Z = { SCALE: 1, BONE: 2, CORE: 3, EYE: 4, TOOTH: 5, LEATHER: 6 } as const;
const MOUTH_Z = -0.905;
const BONE = 0xb9a888;

function spike(len: number, base: number, lean: number): THREE.BufferGeometry {
  // A backward-leaning bone spike standing on +Y.
  return hull([
    [-base / 2, 0, base / 2], [base / 2, 0, base / 2], [-base / 2, 0, -base / 2], [base / 2, 0, -base / 2],
    [0, len, lean],
  ]);
}

function buildBody(lod: Lod): THREE.BufferGeometry {
  const hi = lod === 'high';
  const SEG = hi ? 14 : 7;
  const p = new Parts();
  const SCALE: PartOpts = { pal: PAL.BODY, rough: 0.42, metal: 0.35, zone: Z.SCALE, glow: 1 };
  const BONE_P: PartOpts = { col: BONE, rough: 0.62, metal: 0.02, zone: Z.BONE };
  const LEATHER: PartOpts = { col: 0x2a170e, rough: 0.8, metal: 0, zone: Z.LEATHER };

  // Receiver: a scaled, slightly rounded body.
  p.add(stations([
    [0.14, 0.078, 0.09, 0.02],
    [0.1, 0.094, 0.112, 0.022],
    [0.0, 0.1, 0.12, 0.024],
    [-0.17, 0.094, 0.112, 0.026],
    [-0.25, 0.072, 0.084, 0.03],
  ], 0.03), SCALE);
  // Dorsal bone spines down the back (receiver → skull), leaning back.
  const spines = hi ? 9 : 5;
  for (let i = 0; i < spines; i++) {
    const t = i / (spines - 1);
    const z = 0.1 - t * 0.78;
    const onBarrel = z < -0.25;
    const y = onBarrel ? BARREL_Y + 0.05 : 0.082;
    const len = (onBarrel ? 0.034 : 0.05) * (1 - 0.3 * Math.abs(t - 0.3));
    p.add(spike(len, 0.02, 0.035), { ...BONE_P, at: [0, y, z], flat: true });
  }
  // Flank ridges (bone plates) on the receiver.
  for (const sx of [-1, 1]) {
    p.add(chamferBox(0.008, 0.016, 0.26, 0.004), { ...BONE_P, at: [sx * 0.05, 0.05, -0.05], rot: [0.05, 0, 0] });
  }
  addGrip(p, { grip: LEATHER, guard: { ...BONE_P }, hi });
  // Bone stock: a tail — curved spine ending in a spade.
  p.add(tube([[0, 0.045, 0.13], [0, 0.04, 0.24], [0, 0.0, 0.34], [0, -0.05, 0.42]], 0.017, hi ? 12 : 6, hi ? 7 : 5), BONE_P);
  p.add(tube([[0, -0.05, 0.14], [0, -0.07, 0.28], [0, -0.09, 0.4]], 0.014, hi ? 8 : 4, hi ? 6 : 4), BONE_P);
  p.add(hull([[0, 0.08, 0.41], [0, -0.13, 0.41], [-0.022, -0.02, 0.44], [0.022, -0.02, 0.44], [0, -0.03, 0.47], [-0.02, -0.06, 0.4], [0.02, -0.06, 0.4]]), { ...BONE_P, flat: true });
  // Rear capacitor → a scaled egg in the tail cage.
  p.add(new THREE.SphereGeometry(0.036, hi ? 14 : 8, hi ? 10 : 6).scale(1, 1, 1.5), { ...SCALE, at: [0, 0.008, 0.22] });

  // Foregrip: scaled belly plate.
  p.add(stations([[-0.19, 0.07, 0.056, -0.046], [-0.33, 0.06, 0.046, -0.043]], 0.016), SCALE);

  // Barrel: vertebrae on a molten core, caged in ribs.
  p.add(lathe([[0.012, -0.83], [0.018, -0.83], [0.018, -0.25], [0.012, -0.25]], hi ? 10 : 6), { col: 0x1a0a04, rough: 0.3, metal: 0, zone: Z.CORE, glow: 1, at: [0, BARREL_Y, 0] });
  const verts = hi ? 7 : 5;
  for (let i = 0; i < verts; i++) {
    const z = -0.28 - i * (0.5 / (verts - 1));
    p.add(lathe([[0.02, z - 0.018], [0.042, z - 0.014], [0.046, z], [0.042, z + 0.014], [0.02, z + 0.018]], SEG), { ...BONE_P, at: [0, BARREL_Y, 0] });
    if (hi) {
      // Transverse processes.
      for (const sx of [-1, 1]) p.add(spike(0.022, 0.012, 0.012), { ...BONE_P, at: [sx * 0.04, BARREL_Y, z], rot: [0, 0, -sx * Math.PI / 2], flat: true });
    }
  }
  // Ribs: arcs from the top down each side of the column.
  const ribs = hi ? 4 : 2;
  for (let i = 0; i < ribs; i++) {
    const z = -0.33 - i * (0.36 / Math.max(1, ribs - 1));
    for (const sx of [-1, 1]) {
      const pts: V3[] = [];
      for (let k = 0; k <= 6; k++) {
        const a = Math.PI / 2 - (k / 6) * Math.PI * 0.95;
        pts.push([sx * Math.cos(a) * 0.058, BARREL_Y + Math.sin(a) * 0.058 - 0.004, z + 0.02 * (k / 6)]);
      }
      p.add(tube(pts, 0.0055, hi ? 10 : 5, hi ? 5 : 3), BONE_P);
    }
  }
  // ── Skull at the muzzle ──
  // Cranium + upper jaw (snout).
  p.add(hull([
    [-0.05, BARREL_Y + 0.03, -0.74], [0.05, BARREL_Y + 0.03, -0.74], [-0.042, BARREL_Y + 0.07, -0.76], [0.042, BARREL_Y + 0.07, -0.76],
    [-0.046, BARREL_Y + 0.005, -0.8], [0.046, BARREL_Y + 0.005, -0.8], [-0.03, BARREL_Y + 0.055, -0.86], [0.03, BARREL_Y + 0.055, -0.86],
    [-0.024, BARREL_Y + 0.02, -0.935], [0.024, BARREL_Y + 0.02, -0.935], [-0.018, BARREL_Y + 0.036, -0.93], [0.018, BARREL_Y + 0.036, -0.93],
    [-0.036, BARREL_Y + 0.012, -0.86], [0.036, BARREL_Y + 0.012, -0.86],
  ]), { ...BONE_P, flat: true });
  // Lower jaw (open, below the bore).
  p.add(hull([
    [-0.04, BARREL_Y - 0.03, -0.77], [0.04, BARREL_Y - 0.03, -0.77], [-0.036, BARREL_Y - 0.05, -0.78], [0.036, BARREL_Y - 0.05, -0.78],
    [-0.018, BARREL_Y - 0.036, -0.925], [0.018, BARREL_Y - 0.036, -0.925], [-0.014, BARREL_Y - 0.05, -0.915], [0.014, BARREL_Y - 0.05, -0.915],
  ]), { ...BONE_P, flat: true });
  // Teeth: fangs down from the upper jaw and up from the lower.
  const teeth = hi ? 4 : 2;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < teeth; i++) {
      const z = -0.92 + i * 0.03;
      const w = 0.014 + i * 0.006;
      const big = i === 0 ? 1.5 : 1;
      p.add(hull([[sx * w - 0.004, 0, z - 0.004], [sx * w + 0.004, 0, z - 0.004], [sx * w, 0, z + 0.005], [sx * w * 0.9, -0.018 * big, z]]),
        { col: 0xf2ead8, rough: 0.3, metal: 0, zone: Z.TOOTH, at: [0, BARREL_Y + 0.016, 0], flat: true });
      p.add(hull([[sx * w - 0.004, 0, z - 0.004], [sx * w + 0.004, 0, z - 0.004], [sx * w, 0, z + 0.005], [sx * w * 0.9, 0.014, z]]),
        { col: 0xf2ead8, rough: 0.3, metal: 0, zone: Z.TOOTH, at: [0, BARREL_Y - 0.03, 0], flat: true });
    }
  }
  // Eyes (glowing) and brow horns sweeping back along the barrel.
  for (const sx of [-1, 1]) {
    p.add(new THREE.SphereGeometry(0.009, 8, 6).scale(1, 0.6, 1.4), { col: 0x200800, rough: 0.2, metal: 0, zone: Z.EYE, glow: 1, at: [sx * 0.036, BARREL_Y + 0.046, -0.82] });
    p.add(tube([[sx * 0.036, BARREL_Y + 0.062, -0.78], [sx * 0.05, BARREL_Y + 0.07, -0.7], [sx * 0.058, BARREL_Y + 0.064, -0.6], [sx * 0.056, BARREL_Y + 0.05, -0.52]], 0.008, hi ? 10 : 5, hi ? 6 : 4), { ...BONE_P, zone: Z.BONE });
    p.add(spike(0.03, 0.01, 0.03), { ...BONE_P, at: [sx * 0.044, BARREL_Y + 0.02, -0.79], rot: [0, 0, -sx * 1.2], flat: true });
  }
  return p.merge(`dragon-${lod}`);
}

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float flick = 1.0 - (1.0 - uCalm) * 0.35 * cgNoise(vOP * 30.0 + vec3(0.0, uTime * 3.0, uTime * 1.3));
  float heat = (0.25 + 0.6 * fill + 0.9 * uStreak) * flick + 2.5 * uFire;
  vec3 ember = mix(uA, uB, clamp(heat * 0.35, 0.0, 1.0));
  if (zone == ${Z.SCALE}) {
    // Cellular scales: dark domed plates, ember light in the seams.
    // Project on the dominant face: the back (seen in first person) maps z×x.
    vec2 uv = abs(vON.y) > 0.6 ? vec2(vOP.z * 58.0, vOP.x * 62.0) : vec2(vOP.z * 58.0, (vOP.y + abs(vOP.x) * 0.9) * 62.0);
    vec2 ip = floor(uv);
    vec2 fp = fract(uv);
    float d1 = 8.0, d2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = cgH33(vec3(ip + g, 1.0)).xy * 0.7 + 0.15;
        vec2 r = g + o - fp;
        r.y *= 1.35;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
    float edge = sqrt(d2) - sqrt(d1);
    float seam = 1.0 - smoothstep(0.02, 0.11, edge);
    float dome = smoothstep(0.0, 0.75, sqrt(d1));
    diffuseColor.rgb *= mix(1.6, 0.45, dome) * (1.0 - 0.7 * seam);
    roughnessFactor = mix(0.28, 0.75, max(dome, seam));
    glow += ember * seam * heat * 0.6 * gmask;
  } else if (zone == ${Z.BONE}) {
    float n = cgFbm(vOP * 60.0);
    diffuseColor.rgb *= 0.45 + 0.75 * n;
    roughnessFactor = 0.55 + 0.3 * n;
    // Scorch toward the jaws.
    diffuseColor.rgb *= mix(1.0, 0.45, smoothstep(-0.8, -0.93, vOP.z));
  } else if (zone == ${Z.CORE}) {
    float f = cgFill(vOP.z, -0.25, -0.83);
    float n = cgNoise(vec3(vOP.z * 40.0 + uTime * 2.0, 0.0, 0.0));
    glow += mix(uA, uB, 0.3 + 0.4 * n) * (mix(0.05, 1.1 + 0.6 * uStreak, f) + 4.0 * uFire) * gmask;
  } else if (zone == ${Z.EYE}) {
    glow += mix(uA, uB, 0.5 + 0.5 * uStreak) * (1.1 + 1.6 * uStreak + 3.0 * uFire);
  } else if (zone == ${Z.TOOTH}) {
    glow += uA * smoothstep(-0.85, -0.93, vOP.z) * (0.08 + 0.4 * uFire);
  }
`;

// Embers: off the seams (receiver + barrel) drifting up, and out of the jaws;
// on the shot a spray of them rides the breath.
const EMBERS = /* glsl */ `
  float life = 1.1 + seed.y * 1.4;
  float t = uTime / life + seed.x * 7.0;
  float ph = fract(t);
  float cyc = floor(t);
  float h1 = cgH1(cyc * 17.3 + seed.z * 71.0);
  float h2 = cgH1(cyc * 5.7 + seed.x * 33.0);
  vec3 origin;
  if (seed.z < 0.45) origin = vec3((h2 - 0.5) * 0.09, 0.07, 0.1 - h1 * 0.35);
  else if (seed.z < 0.75) origin = vec3((h2 - 0.5) * 0.06, ${BARREL_Y.toFixed(3)} + 0.03, -0.3 - h1 * 0.45);
  else origin = vec3((h2 - 0.5) * 0.03, ${BARREL_Y.toFixed(3)}, ${MOUTH_Z.toFixed(3)} + h1 * 0.03);
  float sway = sin(uTime * 3.0 + seed.x * 30.0) * 0.012 * (1.0 - uCalm * 0.6);
  p = origin + vec3(sway, ph * (0.08 + 0.06 * h1), ph * 0.05);
  if (seed.z >= 0.75) p.z -= ph * 0.03;
  size = 0.004 + 0.005 * h2;
  float fade = sin(ph * 3.14159);
  float heat = 0.35 + 0.65 * uCharge + uStreak;
  col = mix(uA, uB, (1.0 - ph) * 0.8) * (1.4 + 1.2 * uStreak);
  a = fade * heat * (0.6 + 0.4 * sin(uTime * 14.0 + seed.y * 50.0) * (1.0 - uCalm));
  // Breath spray on the shot.
  if (seed.y < 0.4 && uShot < 0.8) {
    float k = 1.0 - exp(-uShot * 7.0);
    vec3 dir = normalize(vec3((seed.x - 0.5) * 0.9, (seed.z - 0.4) * 0.7, -1.0));
    p = vec3(0.0, ${BARREL_Y.toFixed(3)}, ${MOUTH_Z.toFixed(3)}) + dir * k * (0.06 + 0.08 * seed.z) + vec3(0.0, uShot * uShot * 0.08, 0.0);
    col = mix(uB, uA, uShot * 1.5) * 2.4;
    size = 0.006 + 0.004 * seed.x;
    a = exp(-uShot * 4.5);
  }
`;

// The breath: an open cone out of the jaws (uv.y 0 at the mouth → 1 at the
// tip). A smoulder at rest; a short roaring cone on the shot.
function breathGeo(): THREE.BufferGeometry {
  return cached('dragon-breath', () => {
    // Unit-length cone (uv.y 0 → 1); the vertex shader sets the real length.
    const g = new THREE.CylinderGeometry(0.055, 0.016, 1, 12, 8, true);
    g.translate(0, 0.5, 0);
    g.rotateX(-Math.PI / 2);
    g.translate(0, BARREL_Y, MOUTH_Z + 0.01);
    g.userData.shared = true;
    return g;
  });
}

const BREATH_VERT = /* glsl */ `
  float roar = exp(-uShot * 7.0) * step(uShot, 0.8);
  // Short: ≤ ~0.16 model units (~13 cm at viewmodel scale) past the jaws —
  // never a stream down the aim line.
  float len = 0.03 + 0.015 * uStreak + 0.11 * roar * (1.0 - exp(-uShot * 25.0));
  float t = uv.y;
  p.z = ${(MOUTH_Z + 0.01).toFixed(3)} - t * len;
  float wob = 1.0 + 0.25 * sin(uTime * 17.0 + t * 9.0) * (1.0 - uCalm);
  p.xy = vec2(0.0, ${BARREL_Y.toFixed(3)}) + (p.xy - vec2(0.0, ${BARREL_Y.toFixed(3)})) * (0.6 + 1.1 * roar) * wob;
`;
const BREATH_FRAG = /* glsl */ `
  float roar = exp(-uShot * 7.0) * step(uShot, 0.8);
  float t = vUv.y;
  float n = cgFbm(vec3(vUv.x * 6.0, t * 3.0 - uTime * 4.0, uTime * 0.7));
  float body = smoothstep(1.0, 0.1, t + n * 0.5) * (0.45 + 0.55 * n);
  float base = 0.4 + 0.3 * uStreak + 0.25 * uCharge;
  vec3 c = mix(uB, uA, clamp(t * 1.4 + n * 0.3, 0.0, 1.0));
  col = c * body * (base + 3.2 * roar);
  a = 1.0;
`;

export const buildDragon: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('dragon', lod, finish);
  const d = rig.drive;
  rig.body(cached(`dragon-body-${lod}`, () => buildBody(lod)), surfaceMaterial(d, { key: 'dragon', frag: FRAG }));
  rig.add(motes(d, { key: 'dragon', count: lod === 'high' ? 80 : 26, motion: EMBERS, soft: 5 }));
  const breath = rig.add(fxMesh(d, breathGeo(), { key: 'dragon-breath', vert: BREATH_VERT, frag: BREATH_FRAG }));
  // The roar engulfs the skull for its first instants (drawn over it, like
  // the standard discharge flare); the smoulder sits behind the jaws.
  return rig.instance(() => {
    breath.material.depthTest = d.uShot.value > 0.2;
  });
};
