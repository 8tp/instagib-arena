import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KS_SHEENS } from '../items/types';
import { nowMs } from '../fx/rail-state';
import { gunFx } from './gun-material';
import { BARREL_Y } from './gun-geometry';

// ─────────────────────────────────────────────────────────────────────────
// Item-quality visuals for the railgun (economy v3): everything here is a
// cosmetic overlay in gun MODEL space (grip at the origin, barrel −Z) and is
// drawn only when its quality is on:
//   • SheenOverlay  — Killstreak sheen: a coloured glow band sweeping along
//                     the gun while the owner is on a ≥ 5 streak;
//   • festiveKit    — string lights wrapped round the barrel + a small bow.
// (The Tracked kill counter is its own module: tracker.ts.)
// Fairness: none of it leaves the gun's own silhouette by more than a centimetre
// or two, none sits on the sight line, radiances stay under the bloom
// threshold (peak channel < ~1.4), and everything honours reducedEffects
// (calm = no sweeping / twinkling).
// ─────────────────────────────────────────────────────────────────────────

export const KS_STREAK_MIN = 5;
// Dev only (gun lab &sweep=): pin the sheen sweep phase 0…1 (−1 = live).
export const sheenDebug = { phase: -1 };

export function sheenColor(id: string | null | undefined): THREE.Color | null {
  if (!id) return null;
  const s = KS_SHEENS.find((x) => x.id === id);
  return s ? new THREE.Color(s.color) : null;
}

// ── Killstreak sheen ────────────────────────────────────────────────────────

const SHEEN_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  vW = wp.xyz;
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SHEEN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uK;       // strength (already streak-ramped)
uniform float uT;       // sweep phase 0…1
uniform vec3 uOrigin;   // gun origin, world
uniform vec3 uFwd;      // gun barrel direction, world (unit)
uniform float uScale;   // gun world scale
uniform float uWide;    // band half-width, model metres
uniform float uCalm;    // 1 = held still
varying vec3 vW;
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_fragment>
void main() {
  // Model-space distance along the barrel: −0.45 (butt) … +0.92 (muzzle).
  float s = dot(vW - uOrigin, uFwd) / uScale;
  float c = mix(-0.75, 1.2, uT);
  c = mix(c, 0.3, uCalm);
  float d = (s - c) / uWide;
  float band = exp(-d * d);
  float d2 = (s - (c - 0.6)) / (uWide * 1.7);
  float band2 = exp(-d2 * d2) * 0.3;
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  // A faint constant tint (the glow lives on the whole gun) + the sweep.
  float k = uK * (band * (0.55 + 0.7 * fres) + band2 * 0.6 + 0.25 * (0.4 + fres));
  // Tint, not just add: mix toward the sheen hue so it reads on any finish
  // (premultiplied: rgb = hue × alpha; peak stays under the bloom knee).
  float a = clamp(k * 1.15, 0.0, 0.8);
  vec3 col = uColor * a * 1.05;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      col *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

export class SheenOverlay {
  private readonly mat: THREE.ShaderMaterial;
  private readonly meshes: THREE.Mesh[] = [];
  private streak = 0;
  private hasColor = false;
  private pro = false;
  private k = 0; // eased strength
  private lastMs = 0;
  private lastSeen0 = false;
  private readonly u: Record<string, THREE.IUniform>;

  // `root` = the gun's model-space group (origin + barrel axis come from its
  // world matrix); `sources` = the meshes to glow (each gets a child overlay
  // sharing its geometry). `strength` scales the peak (third person is dimmer).
  constructor(
    private readonly root: THREE.Object3D,
    sources: readonly THREE.Mesh[],
    private readonly strength = 1,
  ) {
    this.u = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uK: { value: 0 },
        uT: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uFwd: { value: new THREE.Vector3(0, 0, -1) },
        uScale: { value: 1 },
        uWide: { value: 0.16 },
        uCalm: { value: 0 },
      },
    ]);
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: SHEEN_VERT,
      fragmentShader: SHEEN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // The overlay reuses the body's geometry: pull it a hair toward the camera.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      fog: true,
      toneMapped: false,
    });
    this.mat.name = 'railgun-sheen';
    this.mat.customProgramCacheKey = () => 'railgun-sheen-1';
    let first = true;
    for (const src of sources) {
      if ((src as THREE.SkinnedMesh).isSkinnedMesh || (src as THREE.InstancedMesh).isInstancedMesh) continue;
      const o = new THREE.Mesh(src.geometry, this.mat);
      o.name = 'railgun-sheen-overlay';
      o.userData.shared = true; // geometry is the body's; the material is freed by dispose()
      o.frustumCulled = src.frustumCulled;
      o.renderOrder = src.renderOrder + 1;
      o.visible = false;
      if (first) {
        o.onBeforeRender = () => this.frame();
        first = false;
      }
      src.add(o);
      this.meshes.push(o);
    }
  }

  // `id` = KS_SHEENS id (null = no sheen); `professional` = a stronger glow.
  set(id: string | null | undefined, professional = false) {
    const c = sheenColor(id);
    this.hasColor = !!c;
    if (c) (this.u.uColor.value as THREE.Color).copy(c);
    this.pro = professional;
    this.sync();
  }

  setStreak(n: number) {
    this.streak = Number.isFinite(n) ? n : 0;
    this.sync();
  }

  private get target(): number {
    if (!this.hasColor || this.streak < KS_STREAK_MIN) return 0;
    // 5 → 0.5, 10 → 0.72, 15+ → 0.85 (peak radiance stays under the bloom knee).
    const r = Math.min(1, Math.max(0, (this.streak - KS_STREAK_MIN) / 10));
    return (0.5 + 0.35 * r) * (this.pro ? 1.15 : 1) * this.strength;
  }

  private sync() {
    const on = this.target > 0 || this.k > 0.004;
    for (const m of this.meshes) m.visible = on;
  }

  // Once per drawn frame (first overlay's onBeforeRender): ease the strength,
  // advance the sweep, refresh the gun's world axis.
  private frame() {
    const now = nowMs();
    this.lastSeen0 = this.lastMs === 0;
    const dt = this.lastMs > 0 ? Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000)) : 0;
    this.lastMs = now;
    const tg = this.target;
    if (this.lastSeen0) this.k = tg;
    else this.k += (tg - this.k) * (1 - Math.exp(-6 * dt));
    if (tg === 0 && this.k < 0.004) {
      this.k = 0;
      for (const m of this.meshes) m.visible = false;
    }
    const u = this.u;
    u.uK.value = this.k;
    const calm = gunFx.reduced;
    u.uCalm.value = calm ? 1 : 0;
    // One sweep every ~2.3 s with a pause while it is off the muzzle.
    u.uT.value = sheenDebug.phase >= 0 ? sheenDebug.phase : calm ? 0.3 : ((now / 1000) * 0.43) % 1;
    u.uWide.value = this.pro ? 0.13 : 0.1;
    const e = this.root.matrixWorld.elements;
    (u.uOrigin.value as THREE.Vector3).set(e[12], e[13], e[14]);
    const sc = Math.hypot(e[8], e[9], e[10]) || 1;
    (u.uFwd.value as THREE.Vector3).set(-e[8] / sc, -e[9] / sc, -e[10] / sc);
    u.uScale.value = sc;
  }

  dispose() {
    for (const m of this.meshes) m.removeFromParent();
    this.meshes.length = 0;
    this.mat.dispose();
  }
}

// ── Festive: string lights + bow ────────────────────────────────────────────

const FESTIVE_VERT = /* glsl */ `
attribute vec3 aCol;
attribute float aPhase; // ≥ 0: a bulb (blink phase); −1: wire; −2: bow
varying vec3 vCol;
varying float vPhase;
varying float vLit;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vCol = aCol;
  vPhase = aPhase;
  // Fake shading for the bow: a key light from above-left.
  vLit = 0.45 + 0.55 * max(dot(normalize(normalMatrix * normal), normalize(vec3(-0.4, 0.8, 0.5))), 0.0);
  #include <fog_vertex>
}
`;

const FESTIVE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uCalm;
varying vec3 vCol;
varying float vPhase;
varying float vLit;
#include <fog_pars_fragment>
void main() {
  vec3 c;
  if (vPhase >= 0.0) {
    // Chase: each bulb swells and dims in turn along the string.
    float tw = 0.5 + 0.5 * sin(uTime * 2.6 + vPhase * 6.2831);
    tw = mix(tw * tw, 0.7, uCalm);
    c = vCol * (0.35 + 1.0 * tw);
  } else if (vPhase > -1.5) {
    c = vCol; // wire
  } else {
    c = vCol * vLit; // bow
  }
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      c *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      c *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const BULB_COLS = [
  [1.0, 0.08, 0.06],
  [1.0, 0.62, 0.08],
  [0.1, 0.9, 0.2],
  [0.15, 0.4, 1.0],
  [1.0, 0.25, 0.7],
];

let festiveGeo: THREE.BufferGeometry | null = null;
let festiveMat: THREE.ShaderMaterial | null = null;

function tag(g: THREE.BufferGeometry, r: number, gg: number, b: number, phase: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3);
  const ph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
    ph[i] = phase;
  }
  ng.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'aCol' && k !== 'aPhase') ng.deleteAttribute(k);
  return ng;
}

function buildFestiveGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // The string: a helix round the barrel.
  const R = 0.078;
  const z0 = -0.3, z1 = -0.8;
  const turns = 3.2;
  const pts: THREE.Vector3[] = [];
  const at = (u: number) => {
    const a = u * turns * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * R, BARREL_Y + Math.sin(a) * R, z0 + (z1 - z0) * u);
  };
  for (let i = 0; i <= 64; i++) pts.push(at(i / 64));
  const wire = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.0028, 4, false);
  parts.push(tag(wire, 0.02, 0.09, 0.03, -1));
  // Bulbs: 13 along the string, cycling colours.
  const NB = 13;
  for (let i = 0; i < NB; i++) {
    const u = (i + 0.5) / NB;
    const p = at(u);
    const s = new THREE.SphereGeometry(0.0095, 6, 5);
    s.translate(p.x, p.y, p.z);
    const c = BULB_COLS[i % BULB_COLS.length];
    parts.push(tag(s, c[0], c[1], c[2], (i / NB) * 1.0));
  }
  // The bow, seated on the left flank ahead of the charge window (−X face, z −0.26).
  const bow = (make: () => THREE.BufferGeometry, r: number, g: number, b: number) => parts.push(tag(make(), r, g, b, -2));
  const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0) => {
    geo.rotateZ(rz);
    geo.translate(x, y, z);
    return geo;
  };
  // Built in a local frame (x = across the bow, y = up, z = out of the flank),
  // then turned so +z faces −X.
  const local: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const loop = new THREE.SphereGeometry(0.018, 8, 6);
    loop.scale(1.25, 0.85, 0.42);
    local.push(place(loop, sx * 0.02, 0, 0.004));
  }
  const knot = new THREE.SphereGeometry(0.0085, 6, 5);
  knot.scale(1, 1, 0.9);
  local.push(place(knot, 0, 0, 0.006));
  const tails: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const t = new THREE.BoxGeometry(0.0085, 0.03, 0.0018);
    t.translate(0, -0.015, 0);
    tails.push(place(t, sx * 0.007, -0.006, 0.002, sx * 0.4));
  }
  const align = (g: THREE.BufferGeometry) => {
    g.rotateY(-Math.PI / 2); // +z → −X
    g.translate(-0.053, 0.043, -0.27);
    return g;
  };
  for (const g of local.slice(0, 2)) bow(() => align(g), 0.85, 0.03, 0.04);
  bow(() => align(local[2]), 1.0, 0.7, 0.15);
  for (const g of tails) bow(() => align(g), 0.7, 0.02, 0.03);
  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) if (p !== merged) p.dispose();
  merged.userData.shared = true;
  return merged;
}

// A shared festive mesh (geometry + material are process-wide; add it to a gun
// group). onBeforeRender drives the twinkle from the wall clock.
export function festiveKit(): THREE.Mesh {
  festiveGeo ??= buildFestiveGeometry();
  festiveMat ??= new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCalm: { value: 0 } }]),
    vertexShader: FESTIVE_VERT,
    fragmentShader: FESTIVE_FRAG,
    fog: true,
    toneMapped: false,
  });
  const m = new THREE.Mesh(festiveGeo, festiveMat);
  m.name = 'railgun-festive';
  m.userData.shared = true;
  m.frustumCulled = false;
  m.onBeforeRender = () => {
    const u = festiveMat!.uniforms;
    u.uTime.value = gunFx.reduced ? 0 : (nowMs() / 1000) % 3600;
    u.uCalm.value = gunFx.reduced ? 1 : 0;
    festiveMat!.uniformsNeedUpdate = true;
  };
  return m;
}
