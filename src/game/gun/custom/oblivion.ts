import * as THREE from 'three';
import type { CustomGunBuild } from './types';
import {
  BARREL_Y, GunRig, PAL, Parts, addGrip, billboard, cached, chamferBox, cylZ, fxMesh, hull, lathe, motes, mountPad, rng, stations, strips,
  surfaceMaterial, taperTube, torusZ, type Lod, type PartOpts, type TrackerMount, type V3,
} from './kit';

// ─────────────────────────────────────────────────────────────────────────
// OBLIVION (unobtainable) — a rail forged around a captive black hole.
// Obsidian and void-metal, violet veins crawling toward the muzzle. On the
// receiver's back — where the first-person eye falls — two void-metal horns
// hold the singularity over a violet well: a true-black event horizon ringed
// by a photon ring, the far side of its accretion disc lensed up over the
// top and under the bottom, and a tilted accretion disc streaming round it
// (Keplerian: the inner edge whips, the outer drifts; one side Doppler-
// bright). Three containment gyres tumble around it on their own axes.
// VFX: motes spiralling down the disc into the horizon; matter streams
// drawn off the hole spiral down the barrel to the emitter (their lit length
// is the charge); on the SHOT the hole inhales — motes from all around fall
// in, the disc flares, a shock ring leaves the horizon. Streak: the disc runs
// hotter and faster, the gyres race, the streams thicken.
// The barrel is FRACTURED: obsidian chunks floating apart round a bare
// violet core (jolted apart by the shot); debris shards orbit the hole; a
// crown of obsidian spikes curls round the emitter; the stock is broken
// into floating chunks.
// Draws: body (+ gyres, chunks, shards, vertex-animated) · horizon · disc · lensing halo ·
// accretion motes · matter streams = 6.
// ─────────────────────────────────────────────────────────────────────────

const Z = { OBSIDIAN: 1, VEIN: 2, VOIDMETAL: 3, RING0: 4, EMIT: 8, SEG: 9, CORE: 10, SHARD: 11 } as const; // rings 4…6
const HC: V3 = [0, 0.112, -0.06]; // the singularity: over the receiver, where the eye falls
const RH = 0.024; // event-horizon radius
const DISC_TILT = 0.2; // disc plane: horizontal, tipped toward the viewer
// The fractured barrel: SEGS obsidian chunks, one per SEG_STEP of z from
// SEG_Z0, floating apart round a bare violet core.
const SEGS = 5;
const SEG_Z0 = -0.305;
const SEG_STEP = 0.091;
const SEG_LEN = 0.068;
// Tracked module seat: a void-metal plate low on the −X flank (face x −0.058,
// y −0.012, z −0.142 … +0.022), under the flank edge rail.
const MOUNT_FACE: V3 = [-0.058, -0.012, -0.06];

// A fractured rock chunk along Z: two jittered rings hulled (faceted).
function chunk(z0: number, z1: number, r: number, sides: number, seed: number): THREE.BufferGeometry {
  const rnd = rng(seed);
  const pts: V3[] = [];
  for (const [z, k] of [[z0, 1], [z1, 0.92], [(z0 + z1) / 2, 1.08]] as const) {
    for (let i = 0; i < sides; i++) {
      const a = ((i + (rnd() - 0.5) * 0.5) / sides) * Math.PI * 2;
      const rr = r * k * (0.86 + 0.24 * rnd());
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr, z + (rnd() - 0.5) * 0.012]);
    }
  }
  return hull(pts);
}

function buildBody(lod: Lod): { geo: THREE.BufferGeometry; mount: TrackerMount } {
  const hi = lod === 'high';
  const SEG = hi ? 16 : 8;
  const p = new Parts();
  const OBS: PartOpts = { pal: PAL.BODY, rough: 0.18, metal: 0.3, zone: Z.OBSIDIAN, glow: 1, flat: true };
  const VOID: PartOpts = { pal: PAL.METAL, rough: 0.35, metal: 0.9, zone: Z.VOIDMETAL };
  const EDGE: PartOpts = { pal: PAL.METAL_LT, rough: 0.25, metal: 1, zone: Z.VOIDMETAL };

  // Receiver: faceted obsidian, veined.
  p.add(stations([
    [0.14, 0.08, 0.094, 0.02],
    [0.09, 0.096, 0.114, 0.024],
    [-0.12, 0.1, 0.118, 0.024],
    [-0.25, 0.07, 0.08, 0.03],
  ], 0.03), OBS);
  // The cradle on the receiver's back: a violet-lit well under the
  // singularity, flanked by two void-metal horns that hold it.
  p.add(lathe([[0.0, -0.004], [0.036, -0.004], [0.04, 0.0], [0.036, 0.004], [0.0, 0.004]], hi ? 28 : 12), { ...OBS, zone: Z.VEIN, flat: false, at: [HC[0], 0.083, HC[2]], rot: [-Math.PI / 2, 0, 0] });
  for (const sx of [-1, 1]) {
    p.add(hull([[sx * 0.03, 0.078, HC[2] + 0.03], [sx * 0.05, 0.078, HC[2] + 0.03], [sx * 0.03, 0.078, HC[2] - 0.03], [sx * 0.05, 0.078, HC[2] - 0.03],
      [sx * 0.052, 0.12, HC[2] + 0.008], [sx * 0.052, 0.12, HC[2] - 0.008], [sx * 0.045, 0.135, HC[2]]]), { ...EDGE, flat: true });
  }
  // Spine ridges fore and aft of the cradle.
  p.add(hull([[0, 0.08, 0.12], [0, 0.096, 0.07], [0, 0.092, 0.02], [-0.01, 0.08, 0.09], [0.01, 0.08, 0.09], [-0.01, 0.08, 0.02], [0.01, 0.08, 0.02]]), { ...OBS, zone: Z.VEIN });
  p.add(hull([[0, 0.092, -0.14], [0, 0.09, -0.2], [0, 0.082, -0.245], [-0.01, 0.08, -0.14], [0.01, 0.08, -0.14], [-0.01, 0.08, -0.22], [0.01, 0.08, -0.22]]), { ...OBS, zone: Z.VEIN });
  for (const sx of [-1, 1]) p.add(chamferBox(0.008, 0.01, 0.34, 0.003), { ...EDGE, at: [sx * 0.05, 0.03, -0.06] });
  addGrip(p, { grip: { col: 0x0c0a12, rough: 0.7, metal: 0 }, guard: VOID, hi });
  // Stock: fractured — the spar and the lower bar broken into floating
  // obsidian chunks (gaps between them), a wedge butt.
  for (const [z0, z1, k] of [[0.13, 0.205, 0], [0.222, 0.3, 1], [0.318, 0.405, 2]] as const) {
    p.add(chunk(z0, z1, 0.017, 5, 31 + k), { ...OBS, at: [0, 0.05 - k * 0.006, 0] });
    p.add(chunk(z0, z1, 0.013, 5, 41 + k), { ...OBS, at: [0, -0.06 - k * 0.012, 0] });
  }
  p.add(hull([[0, 0.07, 0.41], [0, -0.14, 0.41], [-0.022, 0.05, 0.445], [0.022, 0.05, 0.445], [-0.022, -0.12, 0.445], [0.022, -0.12, 0.445], [0, -0.17, 0.43]]), OBS);
  // Tracked module seat.
  const mount = mountPad(p, { face: MOUNT_FACE, depth: 0.022, pad: { ...VOID, flat: true }, rim: EDGE, hi });
  // Rear: a violet crystal capacitor.
  p.add(hull([[0, 0.05, 0.22], [0, -0.035, 0.22], [0.03, 0.008, 0.22], [-0.03, 0.008, 0.22], [0, 0.008, 0.15], [0, 0.008, 0.29]]), { ...OBS, zone: Z.VEIN });
  // Foregrip.
  p.add(stations([[-0.19, 0.068, 0.054, -0.046], [-0.3, 0.06, 0.046, -0.043]], 0.012), OBS);

  // Barrel: a void-metal collar, then the FRACTURED barrel — obsidian chunks
  // floating apart round a bare violet core (the charge meter).
  p.add(lathe([[0.03, -0.3], [0.05, -0.3], [0.062, -0.285], [0.062, -0.25], [0.054, -0.236], [0.022, -0.236]], 6, Math.PI / 6), { ...VOID, flat: true, at: [0, BARREL_Y, 0] });
  p.add(cylZ(0.011, 0.011, 0.48, hi ? 10 : 6), { col: 0x06030c, rough: 0.2, metal: 0, zone: Z.CORE, glow: 1, at: [0, BARREL_Y, -0.535] });
  for (let i = 0; i < SEGS; i++) {
    const z0 = SEG_Z0 - i * SEG_STEP;
    p.add(chunk(z0, z0 - SEG_LEN, 0.04 - i * 0.0015, hi ? 7 : 5, 7 + i * 13), { ...OBS, zone: Z.SEG, at: [0, BARREL_Y, 0] });
  }
  p.add(lathe([[0.024, -0.84], [0.05, -0.84], [0.058, -0.82], [0.058, -0.78], [0.046, -0.765], [0.03, -0.765]], 6, Math.PI / 6), { ...VOID, flat: true, at: [0, BARREL_Y, 0] });
  // Debris: obsidian shards on Keplerian orbits round the singularity, in
  // the disc's plane (vertex-animated: inner ones whip round faster).
  {
    const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2 + DISC_TILT);
    const n = hi ? 6 : 3;
    const r = rng(99);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.6;
      const rad = 0.088 + 0.034 * (i / n);
      const c = new THREE.Vector3(Math.cos(a) * rad, Math.sin(a) * rad, (r() - 0.5) * 0.02).applyMatrix4(m);
      const sz = 0.007 + 0.004 * r();
      const g = hull([[-sz, 0, 0], [sz * 0.8, sz * 0.3, 0.002], [0, sz * 1.6, -sz * 0.4], [0.002, -sz * 0.9, sz * 0.6], [sz * 0.3, 0.2 * sz, sz * 1.1]]);
      p.add(g, { ...OBS, zone: Z.SHARD, at: [HC[0] + c.x, HC[1] + c.y, HC[2] + c.z], rot: [r() * 3, r() * 3, r() * 3] });
    }
  }
  // Containment gyres (animated about the singularity).
  const rr = [0.042, 0.049, 0.056];
  for (let i = 0; i < 3; i++) {
    p.add(torusZ(rr[i], 0.0026, hi ? 6 : 4, hi ? 44 : 16), { pal: PAL.METAL_LT, rough: 0.2, metal: 1, zone: Z.RING0 + i, glow: 1, at: HC });
  }
  // Emitter: a crown of obsidian spikes curling forward round a violet iris.
  const spikes = hi ? 6 : 4;
  for (let i = 0; i < spikes; i++) {
    const a = Math.PI / 2 + (i / spikes) * Math.PI * 2 + Math.PI / spikes;
    const c = Math.cos(a), sn = Math.sin(a);
    const at = (r: number, z: number): V3 => [c * r, BARREL_Y + sn * r, z];
    p.add(taperTube([at(0.05, -0.79), at(0.062, -0.84), at(0.056, -0.895), at(0.038, -0.93)], 0.0075, 0.0008, hi ? 8 : 3, hi ? 5 : 3), { ...OBS, zone: Z.VEIN });
  }
  p.add(torusZ(0.03, 0.005, 6, SEG * 2), { col: 0x100820, rough: 0.2, metal: 0, zone: Z.EMIT, glow: 1, at: [0, BARREL_Y, -0.845] });
  return { geo: p.merge(`oblivion-${lod}`), mount };
}

const VERT = /* glsl */ `
  if (vZone >= ${Z.RING0} && vZone <= ${Z.RING0 + 2}) {
    float i = float(vZone - ${Z.RING0});
    float sp = uPhase * (1.2 + 0.5 * i) * (i == 1.0 ? -1.0 : 1.0);
    cgPivot = vec3(${HC[0].toFixed(3)}, ${HC[1].toFixed(3)}, ${HC[2].toFixed(3)});
    // Each gyre tumbles on its own axis (a gimbal): ring 0 about Y, ring 1
    // about X, ring 2 about a diagonal.
    mat3 base = i == 0.0 ? cgRotX(0.5) : (i == 1.0 ? cgRotY(0.9) : cgRotZ(0.8) * cgRotX(-0.7));
    mat3 tumble = i == 0.0 ? cgRotY(sp) : (i == 1.0 ? cgRotX(sp) : cgRotZ(0.785) * cgRotY(sp) * cgRotZ(-0.785));
    cgR = tumble * base;
  } else if (vZone == ${Z.SEG}) {
    // Barrel chunks: each floats on its own slow bob and roll; the shot
    // jolts them apart, then they settle back into line.
    float i = floor((${(-SEG_Z0).toFixed(3)} - position.z) / ${SEG_STEP.toFixed(3)});
    float kick = exp(-uShot * 6.0) * step(uShot, 1.2) * (1.0 - uCalm * 0.6);
    float live = 1.0 - uCalm * 0.7;
    cgPivot = vec3(0.0, ${BARREL_Y.toFixed(3)}, ${(SEG_Z0 - SEG_LEN / 2).toFixed(3)} - i * ${SEG_STEP.toFixed(3)});
    cgR = cgRotZ(0.12 * sin(uTime * 0.6 + i * 1.9) * live + uPhase * 0.05 * (mod(i, 2.0) * 2.0 - 1.0));
    vec2 dir = vec2(cos(i * 2.4 + 0.5), sin(i * 2.4 + 0.5));
    cgOff = vec3(dir * (0.0022 * sin(uTime * 1.1 + i * 2.3) * live + 0.007 * kick), 0.004 * kick * (i - 2.0));
  } else if (vZone == ${Z.SHARD}) {
    vec3 hc = vec3(${HC.map((v) => v.toFixed(3)).join(', ')});
    mat3 dm = cgRotX(${(-Math.PI / 2 + DISC_TILT).toFixed(4)});
    vec3 lp = transpose(dm) * (position - hc);
    float r = length(lp.xy);
    float w = 0.55 * pow(0.1 / max(r, 0.05), 1.5);
    cgPivot = hc;
    cgR = dm * cgRotZ(-(uPhase * 0.8 + uTime * 0.25) * w) * transpose(dm);
  }
`;

const FRAG = /* glsl */ `
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  vec3 violet = mix(uA, uB, 0.2);
  if (zone == ${Z.OBSIDIAN} || zone == ${Z.VEIN} || zone == ${Z.SEG} || zone == ${Z.SHARD}) {
    // Glossy obsidian; fine violet veins (sparse, thin) crawling toward the
    // singularity; conchoidal sheen on the facets.
    vec3 q = vOP * 34.0 + vec3(0.0, 0.0, uTime * 0.9);
    float n = cgFbm(q);
    float vein = (1.0 - smoothstep(0.0, 0.016, abs(n - 0.5))) * smoothstep(0.42, 0.6, cgNoise(vOP * 13.0 + 4.0));
    float k = zone == ${Z.VEIN} ? 0.8 : vein;
    diffuseColor.rgb *= 0.55 + 0.25 * cgNoise(vOP * 60.0);
    roughnessFactor = 0.24 + 0.12 * cgNoise(vOP * 90.0); // glossy, but no highlight hot enough to bloom
    float pulse = 0.6 + 0.4 * sin(vOP.z * 40.0 + uTime * 4.0) * (1.0 - uCalm);
    glow += violet * k * gmask * (0.1 + 0.6 * fill * pulse + 0.9 * uStreak + 2.5 * uFire);
    // Chunk and shard edges catch the violet light.
    if (zone == ${Z.SEG} || zone == ${Z.SHARD}) glow += violet * fres * (0.12 + 0.25 * fill + 0.5 * uStreak + 1.5 * uFire);
  } else if (zone == ${Z.CORE}) {
    float f = cgFill(vOP.z, -0.3, -0.77);
    float fl = 0.7 + 0.3 * sin(vOP.z * 90.0 - uTime * 9.0 * (1.0 - uCalm * 0.7));
    diffuseColor.rgb = vec3(0.01);
    glow += mix(violet, uB, 0.25 + 0.3 * uFire) * gmask * (mix(0.04, 1.0 + 0.4 * uStreak, f) * fl + 4.0 * uFire);
  } else if (zone >= ${Z.RING0} && zone <= ${Z.RING0 + 2}) {
    glow += violet * gmask * (0.2 + 0.3 * fill + 0.8 * uStreak + 2.5 * uFire) * (0.3 + fres);
  } else if (zone == ${Z.EMIT}) {
    glow += mix(uA, uB, 0.5) * (0.1 + 0.35 * fill + 0.5 * uStreak + 4.0 * uFire);
  } else if (zone == ${Z.VOIDMETAL}) {
    glow += violet * fres * (0.05 + 0.15 * uStreak);
  }
`;

// Event horizon: true black (premultiplied a = 1), writes depth so the disc's
// far half hides behind it.
function horizonGeo(): THREE.BufferGeometry {
  return cached('oblivion-horizon', () => {
    const g = new THREE.SphereGeometry(RH, 24, 16);
    g.translate(HC[0], HC[1], HC[2]);
    g.userData.shared = true;
    return g;
  });
}

// Accretion disc: a ring in its own plane (mesh-local XY, r = 0.034 … 0.11).
const DISC_R0 = 0.032;
const DISC_R1 = 0.1;
function discGeo(lod: Lod): THREE.BufferGeometry {
  return cached(`oblivion-disc-${lod}`, () => {
    const g = new THREE.RingGeometry(DISC_R0, DISC_R1, lod === 'high' ? 64 : 24, 3);
    g.userData.shared = true;
    return g;
  });
}
const DISC_FRAG = /* glsl */ `
  float r = length(vP.xy);
  float u = clamp((r - ${DISC_R0.toFixed(3)}) / ${(DISC_R1 - DISC_R0).toFixed(3)}, 0.0, 1.0);
  float th = atan(vP.y, vP.x);
  // Differential rotation: the inner edge whips round, the outer drifts.
  float spin = (uTime * (1.0 - uCalm * 0.6) + uPhase * 0.4) * (2.4 / (0.25 + u));
  float a1 = th - spin;
  vec2 cs = vec2(cos(a1), sin(a1)) * (1.5 + u * 5.0);
  float n = cgFbm(vec3(cs * 1.4, u * 9.0));
  float streak = 0.55 + 0.9 * n * n;
  float dopp = 1.0 + 0.7 * sin(th);
  float fall = pow(1.0 - u, 1.6) * smoothstep(0.0, 0.08, u);
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float flare = exp(-uShot * 5.0) * step(uShot, 1.0);
  vec3 c = mix(vec3(1.0, 0.92, 1.0), uA, smoothstep(0.0, 0.45, u));
  c = mix(c, vec3(0.35, 0.02, 0.35) * uA * 2.0, smoothstep(0.5, 1.0, u));
  col = c * fall * streak * dopp * (0.8 + 0.4 * fill + 1.0 * uStreak + 2.5 * flare);
  a = 1.0;
`;

// Lensing halo round the horizon (camera-facing): photon ring, the disc's
// far side lensed over the top and under the bottom, and the shock ring.
const HALO_SIZE = 0.17;
const HALO_FRAG = /* glsl */ `
  float r = length(vQ) * ${HALO_SIZE.toFixed(3)};
  float rh = ${RH.toFixed(4)} * (1.0 + 0.35 * exp(-uShot * 4.0) * step(uShot, 1.5) + 0.08 * uStreak);
  if (r < rh * 0.98) discard;
  float ang = atan(vQ.y, vQ.x);
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float flare = exp(-uShot * 5.0) * step(uShot, 1.0);
  // Photon ring hugging the horizon.
  float ring = exp(-pow((r - rh * 1.08) / (rh * 0.07), 2.0));
  // Lensed far-side disc: an arc band over the top + a thinner one under.
  float band = exp(-pow((r - rh * 1.45) / (rh * 0.2), 2.0));
  float top = smoothstep(0.1, 0.9, sin(ang));
  float bot = smoothstep(0.3, 1.0, -sin(ang)) * 0.45;
  float flow = 0.6 + 0.4 * cgNoise(vec3(ang * 3.0 - uTime * 3.0, r * 200.0, 0.0));
  float lens = band * (top + bot) * flow;
  // Shock ring off the horizon on the shot.
  // Two shock rings leave the horizon on the shot (the second lags), their
  // light bent into a swirl — brightness capped (bloom-safe), size is the
  // spectacle.
  float swirl = 0.5 + 0.5 * sin(ang * 3.0 + r * 160.0 - uShot * 30.0);
  float sr = rh + (1.0 - exp(-uShot * 5.0)) * 0.13;
  float sr2 = rh + (1.0 - exp(-max(0.0, uShot - 0.08) * 5.0)) * 0.1;
  float shock = (exp(-pow((r - sr) / 0.007, 2.0)) + 0.6 * exp(-pow((r - sr2) / 0.005, 2.0)) * step(0.08, uShot))
    * exp(-uShot * 3.5) * step(uShot, 1.0) * (0.55 + 0.45 * swirl);
  // Soft glow falling off outward.
  float glow = exp(-(r - rh) / 0.012) * 0.25;
  vec3 hot = mix(vec3(1.0, 0.95, 1.0), uA, 0.3);
  col = hot * ring * (1.2 + 0.6 * fill + 1.0 * uStreak + 3.0 * flare)
      + mix(hot, uA, 0.4) * lens * (0.7 + 0.4 * fill + 0.8 * uStreak + 2.0 * flare)
      + uA * glow * (0.4 + uStreak + 2.0 * flare)
      + mix(uB, uA, 0.35) * shock * 1.3 * (1.0 - uCalm * 0.6);
  col *= smoothstep(1.0, 0.8, length(vQ));
  a = 1.0;
`;

// Accretion motes: spiral down the disc into the horizon; on the shot, a
// shell of motes round the gun is pulled in.
const DISC_MAT = `cgRotX(${(-Math.PI / 2 + DISC_TILT).toFixed(4)})`;
const MOTES = /* glsl */ `
  vec3 hc = vec3(${HC[0].toFixed(3)}, ${HC[1].toFixed(3)}, ${HC[2].toFixed(3)});
  float life = 1.4 + seed.y * 1.6;
  float t = uTime * (1.0 + 0.6 * uStreak) / life + seed.x * 5.0;
  float ph = fract(t);
  float r = mix(${DISC_R1.toFixed(3)} * 1.05, ${RH.toFixed(4)}, pow(ph, 1.6));
  float ang = seed.z * 6.283 + ph * (3.0 + 5.0 * ph) + uPhase * 0.3;
  vec3 lp = vec3(cos(ang) * r, sin(ang) * r, (seed.y - 0.5) * 0.006);
  p = hc + ${DISC_MAT} * lp;
  size = 0.003 + 0.004 * seed.y * (1.0 - ph);
  col = mix(uA, vec3(1.0, 0.9, 1.0), ph) * (1.2 + 1.2 * uStreak);
  a = smoothstep(0.0, 0.15, ph) * smoothstep(1.0, 0.85, ph);
  if (seed.y < 0.5 && uShot < 0.9) {
    // Inhale: from a shell (biased low / sideways) straight into the hole.
    // Shell biased right and low: away from the crosshair side of the gun.
    vec3 dir = normalize(vec3(0.35 + abs(cos(seed.z * 6.283)), -abs(sin(seed.z * 6.283)) * 0.7 + 0.2 * seed.x, (seed.x - 0.5) * 1.2));
    float k = pow(min(1.0, uShot / 0.8), 2.2);
    float sw = k * 4.0;
    vec3 off = dir * (0.09 + 0.04 * seed.y) * (1.0 - k);
    off.xz = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * off.xz;
    p = hc + off;
    col = mix(uA, vec3(1.0), k) * 2.2;
    size = 0.005;
    a = smoothstep(0.0, 0.1, uShot) * (1.0 - k);
  }
`;

// Matter streams: ribbons dragged off the receiver into the singularity,
// the light flowing along them toward the hole.
const STREAMS = /* glsl */ `
  // t = 0 at the singularity … 1 at the emitter: power drawn off the hole
  // spirals down the barrel. The lit length follows the charge.
  vec3 hc = vec3(${HC[0].toFixed(3)}, ${HC[1].toFixed(3)}, ${HC[2].toFixed(3)});
  float ang = rnd.x * 6.283 + id * 2.1;
  float z = mix(-0.24, -0.8, smoothstep(0.1, 1.0, t));
  float spin = ang + t * 9.0 - uPhase * 1.2;
  float rad = 0.046;
  vec3 onBarrel = vec3(cos(spin) * rad, ${BARREL_Y.toFixed(3)} + sin(spin) * rad, z);
  // First stretch: dragged out of the disc down onto the barrel.
  vec3 fromHole = hc + vec3(cos(ang) * ${RH.toFixed(4)} * 1.3, -0.01, -0.02);
  p = mix(fromHole, onBarrel, smoothstep(0.0, 0.16, t));
  float fill = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float reach = smoothstep(t - 0.04, t + 0.04, fill * 1.05);
  float flow = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * 26.0 - uTime * 7.0 * (1.0 - uCalm * 0.7) + rnd.y * 6.0), 3.0);
  w = 0.0024 * (1.0 + 0.8 * uStreak) * (1.0 + 1.5 * uFire);
  col = mix(vec3(1.0, 0.9, 1.0), uA, smoothstep(0.0, 0.3, t)) * (0.9 * reach * flow + 0.9 * uStreak * flow + 3.0 * uFire);
  a = smoothstep(0.0, 0.03, t) * smoothstep(1.0, 0.9, t);
`;

export const buildOblivion: CustomGunBuild = ({ lod, finish }) => {
  const rig = new GunRig('oblivion', lod, finish);
  const d = rig.drive;
  const hi = lod === 'high';
  const body = cached(`oblivion-body-${lod}`, () => buildBody(lod));
  rig.trackerMount = body.mount;
  rig.body(body.geo, surfaceMaterial(d, { key: 'oblivion', vert: VERT, frag: FRAG }));
  const horizon = rig.add(fxMesh(d, horizonGeo(), {
    key: 'oblivion-horizon',
    // The horizon swells as it swallows the shot, then settles.
    vert: `p = vec3(${HC.map((v) => v.toFixed(3)).join(', ')}) + (position - vec3(${HC.map((v) => v.toFixed(3)).join(', ')})) * (1.0 + 0.35 * exp(-uShot * 4.0) * step(uShot, 1.5) + 0.08 * uStreak);`,
    frag: 'col = vec3(0.0); a = 1.0;',
    premultiplied: true,
    side: THREE.FrontSide,
    depthWrite: true,
  }));
  horizon.renderOrder = 2;
  horizon.userData.vfx = false; // solid: part of the silhouette
  const disc = rig.add(fxMesh(d, discGeo(lod), { key: 'oblivion-disc', frag: DISC_FRAG }));
  disc.position.set(HC[0], HC[1], HC[2]);
  disc.rotation.x = -Math.PI / 2 + DISC_TILT;
  rig.add(billboard(d, { key: 'oblivion-halo', at: HC, size: HALO_SIZE, frag: HALO_FRAG }));
  rig.add(motes(d, { key: 'oblivion', count: hi ? 120 : 36, motion: MOTES, soft: 5 }));
  rig.add(strips(d, { key: 'oblivion-streams', count: hi ? 3 : 2, segs: hi ? 40 : 16, path: STREAMS, core: 2 }));
  return rig.instance();
};
