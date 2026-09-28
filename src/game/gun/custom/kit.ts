import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RailgunFinish } from '../../cosmetics';
import { BARREL_Y, MUZZLE_Z } from '../gun-geometry';
import type { CustomGunInstance, CustomGunState } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Shared kit for the CUSTOM railgun models (prism, dragon, tesla, reaper,
// seraph, oblivion, celestial, sovereign). Every model is:
//
//   • ONE lit body mesh — all solid parts merged (Parts) and drawn by a
//     MeshStandardMaterial whose per-vertex `surf` attribute carries
//     roughness / metalness / glow mask / zone + palette slot, and whose
//     emissive is a GLSL hook animated from a handful of uniforms (Drive);
//   • a few GPU-animated VFX meshes (motes = camera-facing quads, strips = camera-facing
//     ribbons/arcs, billboards) whose motion lives entirely in the vertex
//     shader — no per-frame attribute uploads, no per-frame allocation.
//
// Every animated value derives from the Drive uniforms advanced by dt, so the
// look is frame-rate independent. Model space = the standard gun's (grip /
// trigger at the origin, barrel down −Z, muzzle at (0, BARREL_Y, MUZZLE_Z) —
// see weapon-model.ts); callers scale the group.
//
// Sharing: geometry is built once per model + LOD and cached
// (userData.shared, never disposed); materials are per instance (each gun has
// its own charge/shot), compiled once per model (customProgramCacheKey).
// Anything tagged userData.vfx is effect (not silhouette) — the lab's
// coverage probe hides it.
// ─────────────────────────────────────────────────────────────────────────

export { BARREL_Y, MUZZLE_Z };
export type V3 = [number, number, number];
export type Lod = 'high' | 'low';

// Palette slots (the finish's colours, so a recolour is a uniform write).
export const PAL = { LIT: 0, BODY: 1, METAL: 2, METAL_LT: 3, ACCENT: 4, HOT: 5 } as const;

// ── Drive: the uniforms every material of one gun shares ───────────────────

export type Drive = {
  uTime: { value: number }; // seconds (slowed under reduced effects)
  uCharge: { value: number }; // 0 just fired … 1 ready
  uFire: { value: number }; // 1 at the shot → 0 (~0.25 s)
  uShot: { value: number }; // seconds since the last shot (large = long ago)
  uStreak: { value: number }; // 0 … 1 streak intensity (smoothed)
  uPhase: { value: number }; // continuous energy phase: runs faster on a shot / streak
  uCalm: { value: number }; // 1 = reduced effects
  uDensity: { value: number }; // particle density (1 high, lower on low spec / LOD)
  uPx: { value: number }; // point-size scale (px per unit at depth 1)
  uA: { value: THREE.Color }; // accent
  uB: { value: THREE.Color }; // accent hot
  uC: { value: THREE.Color }; // body
  uM: { value: THREE.Color }; // metal
  uL: { value: THREE.Color }; // metal light
};

export function makeDrive(f: RailgunFinish): Drive {
  const d: Drive = {
    uTime: { value: 0 },
    uCharge: { value: 1 },
    uFire: { value: 0 },
    uShot: { value: 99 },
    uStreak: { value: 0 },
    uPhase: { value: 0 },
    uCalm: { value: 0 },
    uDensity: { value: 1 },
    uPx: { value: 500 },
    uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() },
    uC: { value: new THREE.Color() },
    uM: { value: new THREE.Color() },
    uL: { value: new THREE.Color() },
  };
  applyFinish(d, f);
  return d;
}

export function applyFinish(d: Drive, f: RailgunFinish): void {
  d.uA.value.setHex(f.accent);
  d.uB.value.setHex(f.accentHot);
  d.uC.value.setHex(f.body);
  d.uM.value.setHex(f.metal);
  d.uL.value.setHex(f.metalLt);
}

const DRIVE_GLSL = /* glsl */ `
uniform float uTime;
uniform float uCharge;
uniform float uFire;
uniform float uShot;
uniform float uStreak;
uniform float uPhase;
uniform float uCalm;
uniform float uDensity;
uniform float uPx;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uM;
uniform vec3 uL;
`;

// Hash + value noise + fbm (object space), shared by every hook.
export const NOISE_GLSL = /* glsl */ `
float cgH1(float n) { return fract(sin(n) * 43758.5453123); }
float cgH3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
vec3 cgH33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float cgNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(cgH3(i), cgH3(i + vec3(1, 0, 0)), f.x), mix(cgH3(i + vec3(0, 1, 0)), cgH3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(cgH3(i + vec3(0, 0, 1)), cgH3(i + vec3(1, 0, 1)), f.x), mix(cgH3(i + vec3(0, 1, 1)), cgH3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float cgFbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * cgNoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
vec3 cgHue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
// Charge meter along the barrel: 1 where the fill (rear z0 → front z1) has
// reached z, with a soft leading edge. The first ~10 % of the recharge stays
// dark so the discharge reads.
float cgFill(float z, float z0, float z1) {
  float f = clamp((uCharge - 0.1) / 0.88, 0.0, 1.0);
  float p = clamp((z - z0) / (z1 - z0), 0.0, 1.0);
  return smoothstep(p - 0.02, p + 0.06, f * 1.06);
}
mat3 cgRotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 cgRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 cgRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
`;

// ── Geometry primitives ─────────────────────────────────────────────────────

// Box with every edge chamfered by c (convex hull of the 24 cut corners).
export function chamferBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const x = w / 2, y = h / 2, z = d / 2;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(
          new THREE.Vector3(sx * x, sy * (y - c), sz * (z - c)),
          new THREE.Vector3(sx * (x - c), sy * y, sz * (z - c)),
          new THREE.Vector3(sx * (x - c), sy * (y - c), sz * z),
        );
      }
    }
  }
  return new ConvexGeometry(pts);
}

// Hull through chamfered rectangles along Z: [z, width, height, yCentre].
export function stations(st: Array<[number, number, number, number]>, c: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (const [z, w, h, yc] of st) {
    const x = w / 2, y = h / 2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * x, yc + sy * (y - c), z), new THREE.Vector3(sx * (x - c), yc + sy * y, z));
      }
    }
  }
  return new ConvexGeometry(pts);
}

// Convex hull of arbitrary points.
export function hull(pts: V3[]): THREE.BufferGeometry {
  return new ConvexGeometry(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
}

// Surface of revolution about the Z axis from [radius, z] pairs (z increasing
// for an outward-facing side), centred on (0, y).
export function lathe(profile: Array<[number, number]>, seg: number, phase = 0): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg, phase);
  g.rotateX(Math.PI / 2);
  return g;
}

// Cylinder whose axis is Z (length along Z).
export function cylZ(r0: number, r1: number, len: number, seg: number, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open);
  g.rotateX(-Math.PI / 2); // +Y (top, r1) → −Z
  return g;
}

// Torus around the Z axis.
export function torusZ(r: number, tube: number, radial: number, tubular: number, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, radial, tubular, arc);
}

// Flat profile (x = along the part, y = up) extruded by `depth` (along X in
// model space after `plane`): 'side' puts the shape in the YZ plane (a blade
// seen from the side, thickness across X); 'top' in the XZ plane.
export function extrude(
  shape: THREE.Shape,
  depth: number,
  plane: 'side' | 'top',
  bevel = 0,
  curveSegments = 8,
): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments,
  });
  g.translate(0, 0, -depth / 2);
  if (plane === 'side') g.rotateY(Math.PI / 2); // shape x → −z, extrusion → x
  else g.rotateX(-Math.PI / 2); // shape y → −z, extrusion → y
  return g;
}

// Tube along a CatmullRom through points.
export function tube(pts: V3[], r: number, seg: number, radial: number, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed);
  return new THREE.TubeGeometry(curve, seg, r, radial, closed);
}

// Helical coil (wire wound around the Z axis) from z0 to z1.
export function helix(radius: number, wire: number, z0: number, z1: number, turns: number, radial: number, perTurn = 12): THREE.BufferGeometry {
  const n = Math.max(8, Math.round(turns * perTurn));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, z0 + (z1 - z0) * t));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, wire, radial, false);
}

// ── Parts: merge solid pieces into one body geometry ───────────────────────

export type PartOpts = {
  at?: V3;
  rot?: V3;
  scale?: V3 | number;
  col?: number; // sRGB hex: the literal colour, or a multiplier on the palette slot
  pal?: number; // PAL slot (default LIT)
  rough?: number;
  metal?: number;
  glow?: number; // glow mask (the hook decides the colour per zone)
  zone?: number; // 0 … 15, read by the model's hook
  flat?: boolean; // faceted normals
  mirrorX?: boolean; // reflect across X = 0 after placing
};

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export class Parts {
  readonly list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, o: PartOpts = {}): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    if (o.flat || !g.attributes.normal) {
      g.deleteAttribute('normal');
      g.computeVertexNormals();
    }
    const n = g.attributes.position.count;
    tmpC.setHex(o.col ?? 0xffffff);
    const col = new Float32Array(n * 3);
    const surf = new Float32Array(n * 4);
    const w = (o.zone ?? 0) + 16 * (o.pal ?? PAL.LIT);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
      surf[i * 4] = o.rough ?? 0.5;
      surf[i * 4 + 1] = o.metal ?? 0.5;
      surf[i * 4 + 2] = o.glow ?? 0;
      surf[i * 4 + 3] = w;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
    const s = o.scale;
    if (typeof s === 'number') tmpS.setScalar(s);
    else if (s) tmpS.set(s[0], s[1], s[2]);
    else tmpS.set(1, 1, 1);
    tmpQ.setFromEuler(tmpE.set(o.rot?.[0] ?? 0, o.rot?.[1] ?? 0, o.rot?.[2] ?? 0));
    const at = o.at ?? [0, 0, 0];
    g.applyMatrix4(tmpM.compose(tmpP.set(at[0], at[1], at[2]), tmpQ, tmpS));
    if (o.mirrorX) g.scale(-1, 1, 1);
    // A mirroring transform flips the triangle winding: flip it back.
    if ((tmpS.x * tmpS.y * tmpS.z < 0) !== !!o.mirrorX) flipWinding(g);
    this.list.push(g);
    return this;
  }

  // Add a part and its mirror across X = 0 (`make` is called twice).
  mirror(make: () => THREE.BufferGeometry, o: PartOpts): this {
    this.add(make(), o);
    return this.add(make(), { ...o, mirrorX: true });
  }

  merge(name: string): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list, false) ?? new THREE.BufferGeometry();
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    merged.name = name;
    merged.userData.shared = true;
    return merged;
  }
}

function flipWinding(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(i + 1) * n + k];
        arr[(i + 1) * n + k] = arr[(i + 2) * n + k];
        arr[(i + 2) * n + k] = t;
      }
    }
  }
}

// Module cache for per-model shared geometry (built once per key).
const geoCache = new Map<string, unknown>();
export function cached<T>(key: string, build: () => T): T {
  let v = geoCache.get(key) as T | undefined;
  if (v === undefined) {
    v = build();
    geoCache.set(key, v);
  }
  return v;
}

// Deterministic RNG (mulberry32) for shared particle seeds.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Lit body material ───────────────────────────────────────────────────────

export type SurfaceOpts = {
  key: string;
  // Fragment GLSL, run after the base material is set up. In scope:
  //   vOP (object position), vON (object normal), vSurf, vColor, zone (int),
  //   gmask (float), fres (view fresnel 0…1), normal (view), diffuseColor,
  //   roughnessFactor, metalnessFactor; write `glow` (linear radiance).
  frag: string;
  fragPars?: string;
  // Vertex GLSL run at beginnormal_vertex: may set cgR (mat3), cgPivot, cgOff
  // (the vertex is rotated about the pivot, then offset). In scope: position,
  // normal, surf, vZone. Rest position (vOP) stays unanimated.
  vert?: string;
  vertPars?: string;
  envIntensity?: number;
  side?: THREE.Side;
};

export function surfaceMaterial(drive: Drive, o: SurfaceOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, side: o.side ?? THREE.FrontSide });
  m.name = `customgun-${o.key}`;
  m.envMapIntensity = o.envIntensity ?? 1;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, drive);
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${DRIVE_GLSL}\n${NOISE_GLSL}\nattribute vec4 surf;\nvarying vec4 vSurf;\nvarying vec3 vOP;\nvarying vec3 vON;\n${o.vertPars ?? ''}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\nmat3 cgR = mat3(1.0); vec3 cgPivot = vec3(0.0); vec3 cgOff = vec3(0.0);\nint vZone = int(mod(surf.w, 16.0) + 0.5);\n${o.vert ?? ''}\nobjectNormal = cgR * objectNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvSurf = surf; vOP = position; vON = normal;\ntransformed = cgR * (transformed - cgPivot) + cgPivot + cgOff;`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${DRIVE_GLSL}\n${NOISE_GLSL}\nvarying vec4 vSurf;\nvarying vec3 vOP;\nvarying vec3 vON;\n${o.fragPars ?? ''}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          roughnessFactor = vSurf.x;
          metalnessFactor = vSurf.y;
          int zone = int(mod(vSurf.w, 16.0) + 0.5);
          int pal = int(floor(vSurf.w / 16.0 + 0.01));
          if (pal == 1) diffuseColor.rgb = uC * vColor.rgb;
          else if (pal == 2) diffuseColor.rgb = uM * vColor.rgb;
          else if (pal == 3) diffuseColor.rgb = uL * vColor.rgb;
          else if (pal == 4) diffuseColor.rgb = uA * vColor.rgb;
          else if (pal == 5) diffuseColor.rgb = uB * vColor.rgb;
          float gmask = vSurf.z;
          float fres = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.0);
          vec3 glow = vec3(0.0);
          ${o.frag}
          totalEmissiveRadiance += glow;
        }`,
      );
  };
  m.customProgramCacheKey = () => `customgun-${o.key}`;
  return m;
}

// ── VFX: GPU-animated points ────────────────────────────────────────────────

const pxSize = new THREE.Vector2();
// Motes are sized in model units: keep uPx = px per unit at depth 1.
export function pxHook(drive: Drive) {
  return (renderer: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera) => {
    renderer.getDrawingBufferSize(pxSize);
    const cam = camera as THREE.PerspectiveCamera;
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : pxSize.y;
    drive.uPx.value = h * cam.projectionMatrix.elements[5] * 0.5;
  };
}

export type MotesOpts = {
  key: string;
  count: number;
  // Vertex GLSL: from `seed` (vec4, 0…1 per particle; seed.w = density rank)
  // set `p` (model-space position), `size` (model units), `col` (linear
  // radiance), `a` (0…1). Particles with seed.w > uDensity are culled.
  motion: string;
  pars?: string;
  soft?: number; // falloff (higher = tighter core)
  star?: boolean; // four-point glint instead of a round mote
  blending?: THREE.Blending;
};

export function motes(drive: Drive, o: MotesOpts): THREE.Mesh {
  // Camera-facing quads (4 vertices per mote, one draw). Quads rather than
  // THREE.Points: point sprites drawn after triangles in the same pass hit a
  // driver bug on ANGLE/Metal (a stray HDR pixel that bloom smears into a
  // white block), and quads have no point-size limits.
  const geo = cached(`motes:${o.key}:${o.count}`, () => {
    const r = rng(o.count * 7919 + o.key.length * 131 + o.key.charCodeAt(0));
    const g = new THREE.BufferGeometry();
    const n = o.count * 4;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const seed = new Float32Array(n * 4);
    const corner = new Float32Array(n * 2);
    const idx: number[] = [];
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < o.count; i++) {
      const sd = [r(), r(), r(), (i + 0.5) / o.count]; // w = density rank
      for (let k = 0; k < 4; k++) {
        seed.set(sd, (i * 4 + k) * 4);
        corner[(i * 4 + k) * 2] = C[k * 2];
        corner[(i * 4 + k) * 2 + 1] = C[k * 2 + 1];
      }
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.3), 1.2);
    g.userData.shared = true;
    return g;
  });
  const m = new THREE.ShaderMaterial({
    uniforms: { ...drive },
    vertexShader: /* glsl */ `
      ${DRIVE_GLSL}
      ${NOISE_GLSL}
      attribute vec4 seed;
      attribute vec2 corner;
      varying vec3 vCol;
      varying vec2 vQ;
      ${o.pars ?? ''}
      void main() {
        vec3 p = vec3(0.0);
        float size = 0.01;
        vec3 col = uA;
        float a = 1.0;
        ${o.motion}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float sc = length(modelViewMatrix[0].xyz);
        // Half-extent in view units; sub-pixel motes grow to ~1 px and fade
        // by area instead (no shimmer).
        float depth = max(-mv.z, 0.01);
        float px = size * sc * uPx / depth;
        float h = max(px, 1.2) * depth / uPx * 0.5;
        mv.xy += corner * h;
        gl_Position = projectionMatrix * mv;
        vCol = col * max(a, 0.0) * min(1.0, (px * px) / 1.44);
        vQ = corner;
        if (a <= 0.002 || seed.w > uDensity) gl_Position = vec4(-9.0, -9.0, -9.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying vec2 vQ;
      void main() {
        vec2 q = vQ;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        float f = exp(-r2 * ${(o.soft ?? 4).toFixed(2)}) * (1.0 - r2);
        ${o.star ? 'f = max(f * 0.7, (exp(-abs(q.x) * 14.0) * exp(-q.y * q.y * 2.0) + exp(-abs(q.y) * 14.0) * exp(-q.x * q.x * 2.0)) * (1.0 - r2));' : ''}
        gl_FragColor = vec4(vCol * f, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: o.blending ?? THREE.AdditiveBlending,
    toneMapped: false,
  });
  m.name = `customgun-${o.key}-motes`;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = `${o.key}-motes`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.vfx = true;
  mesh.userData.shared = true; // geometry shared; material freed by the instance
  mesh.onBeforeRender = pxHook(drive);
  return mesh;
}

// ── VFX: camera-facing strips (arcs, ribbons, trails, lines) ───────────────

export type StripsOpts = {
  key: string;
  count: number; // strips
  segs: number; // segments per strip
  // GLSL body of `void cgPath(float id, float t, vec4 rnd, out vec3 p, out
  // float w, out vec3 col, out float a)`: the strip's centre line at t ∈ 0…1
  // (model units), its half-width, colour (linear radiance) and alpha.
  path: string;
  pars?: string;
  // Fragment cross-section falloff (higher = thinner core).
  core?: number;
  blending?: THREE.Blending;
};

export function strips(drive: Drive, o: StripsOpts): THREE.Mesh {
  const geo = cached(`strips:${o.key}:${o.count}:${o.segs}`, () => {
    const r = rng(o.count * 31 + o.segs * 17 + o.key.charCodeAt(0));
    const verts = o.count * (o.segs + 1) * 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const arc = new Float32Array(verts * 3);
    const rnd = new Float32Array(verts * 4);
    const idx: number[] = [];
    let v = 0;
    for (let s = 0; s < o.count; s++) {
      const rs = [r(), r(), r(), (s + 0.5) / o.count];
      for (let i = 0; i <= o.segs; i++) {
        for (const side of [-1, 1]) {
          arc[v * 3] = s;
          arc[v * 3 + 1] = i / o.segs;
          arc[v * 3 + 2] = side;
          rnd.set(rs, v * 4);
          v++;
        }
        if (i < o.segs) {
          const b = v - 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }
    g.setAttribute('arc', new THREE.BufferAttribute(arc, 3));
    g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 4));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.3), 1.2);
    g.userData.shared = true;
    return g;
  });
  const m = new THREE.ShaderMaterial({
    uniforms: { ...drive },
    vertexShader: /* glsl */ `
      ${DRIVE_GLSL}
      ${NOISE_GLSL}
      attribute vec3 arc;
      attribute vec4 rnd;
      varying vec3 vCol;
      varying float vSide;
      ${o.pars ?? ''}
      void cgPath(float id, float t, vec4 rnd, out vec3 p, out float w, out vec3 col, out float a) {
        p = vec3(0.0); w = 0.004; col = uA; a = 1.0;
        ${o.path}
      }
      void main() {
        vec3 p0, p1, c, c1; float w, w1, a, a1;
        float t = arc.y;
        cgPath(arc.x, t, rnd, p0, w, c, a);
        float dt = t < 0.999 ? 0.01 : -0.01;
        cgPath(arc.x, t + dt, rnd, p1, w1, c1, a1);
        vec4 v0 = modelViewMatrix * vec4(p0, 1.0);
        vec4 v1 = modelViewMatrix * vec4(p1, 1.0);
        vec3 tg = (v1.xyz - v0.xyz) * sign(dt);
        vec3 side = cross(normalize(tg + vec3(0.0, 0.0, 1e-5)), normalize(-v0.xyz));
        float sc = length(modelViewMatrix[0].xyz);
        v0.xyz += normalize(side + vec3(1e-6)) * arc.z * w * sc;
        gl_Position = projectionMatrix * v0;
        vCol = c * max(a, 0.0);
        vSide = arc.z;
        // Cull whole strips only (per-vertex culling would stretch triangles).
        if (rnd.w > uDensity) gl_Position = vec4(-9.0, -9.0, -9.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vSide;
      void main() {
        float f = exp(-vSide * vSide * ${(o.core ?? 3).toFixed(2)}) * (1.0 - vSide * vSide);
        if (dot(vCol, vec3(1.0)) < 0.002 || any(isnan(vCol))) discard;
        gl_FragColor = vec4(vCol * f, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: o.blending ?? THREE.AdditiveBlending,
    toneMapped: false,
  });
  m.name = `customgun-${o.key}-strips`;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = `${o.key}-strips`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.vfx = true;
  mesh.userData.shared = true;
  return mesh;
}

// ── VFX: billboards and shaded effect meshes ───────────────────────────────

let quadGeo: THREE.PlaneGeometry | null = null;
function quad(): THREE.PlaneGeometry {
  if (!quadGeo) {
    quadGeo = new THREE.PlaneGeometry(2, 2);
    quadGeo.userData.shared = true;
  }
  return quadGeo;
}

export type BillboardOpts = {
  key: string;
  at: V3;
  size: number; // half-extent in model units
  // Fragment GLSL: from vQ (−1…1) write `col` (linear radiance) and `a`
  // (coverage 0…1; with premultiplied blending a darkens what is behind).
  frag: string;
  pars?: string;
  premultiplied?: boolean; // over-blend (can occlude) instead of additive
  depthTest?: boolean;
};

export function billboard(drive: Drive, o: BillboardOpts): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...drive, uSize: { value: o.size } },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vQ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float sc = length(modelViewMatrix[0].xyz);
        vQ = position.xy;
        mv.xy += position.xy * uSize * sc;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${DRIVE_GLSL}
      ${NOISE_GLSL}
      varying vec2 vQ;
      ${o.pars ?? ''}
      void main() {
        vec3 col = vec3(0.0);
        float a = 1.0;
        ${o.frag}
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: o.depthTest ?? true,
    toneMapped: false,
    ...(o.premultiplied
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }
      : { blending: THREE.AdditiveBlending }),
  });
  m.name = `customgun-${o.key}-bb`;
  const mesh = new THREE.Mesh(quad(), m);
  mesh.name = `${o.key}-billboard`;
  mesh.position.set(o.at[0], o.at[1], o.at[2]);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.userData.vfx = true;
  mesh.userData.shared = true;
  return mesh;
}

export type FxMeshOpts = {
  key: string;
  // Vertex GLSL may displace `p` (model-space position, starts = position);
  // `uvw` = the geometry's uv (xy) for the fragment.
  vert?: string;
  frag: string; // writes col (linear) + a; in scope vUv, vP (rest object pos), vV (view dir), vN (view normal)
  pars?: string;
  premultiplied?: boolean;
  side?: THREE.Side;
  depthWrite?: boolean;
};

// An effect-shaded mesh (discs, flames, hard light, auras) on given geometry.
export function fxMesh(drive: Drive, geo: THREE.BufferGeometry, o: FxMeshOpts): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...drive },
    vertexShader: /* glsl */ `
      ${DRIVE_GLSL}
      ${NOISE_GLSL}
      varying vec2 vUv;
      varying vec3 vP;
      varying vec3 vV;
      varying vec3 vN;
      ${o.pars ?? ''}
      void main() {
        vUv = uv;
        vP = position;
        vec3 p = position;
        ${o.vert ?? ''}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vV = normalize(-mv.xyz);
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${DRIVE_GLSL}
      ${NOISE_GLSL}
      varying vec2 vUv;
      varying vec3 vP;
      varying vec3 vV;
      varying vec3 vN;
      ${o.pars ?? ''}
      void main() {
        vec3 col = vec3(0.0);
        float a = 1.0;
        ${o.frag}
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: o.depthWrite ?? false,
    side: o.side ?? THREE.DoubleSide,
    toneMapped: false,
    ...(o.premultiplied
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }
      : { blending: THREE.AdditiveBlending }),
  });
  m.name = `customgun-${o.key}-fx`;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = `${o.key}-fx`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.vfx = true;
  mesh.userData.shared = true;
  return mesh;
}

// ── Rig: the instance plumbing every model shares ───────────────────────────

const STREAK_FULL = 10; // a 10-streak = full streak intensity

export class GunRig {
  readonly group = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly drive: Drive;
  private readonly materials: THREE.Material[] = [];
  private prevFiring = 0;
  // Density at full quality for this LOD (low LOD = third person: fewer).
  constructor(
    readonly key: string,
    readonly lod: Lod,
    finish: RailgunFinish,
    private readonly baseDensity = lod === 'high' ? 1 : 0.45,
  ) {
    this.group.name = `customgun-${key}`;
    this.muzzle.name = `${key}-muzzle`;
    this.muzzle.position.set(0, BARREL_Y, MUZZLE_Z);
    this.group.add(this.muzzle);
    this.drive = makeDrive(finish);
  }

  // Add a mesh/points and own its material (freed on dispose).
  add<T extends THREE.Mesh | THREE.Points>(obj: T): T {
    const mat = obj.material;
    if (Array.isArray(mat)) this.materials.push(...mat);
    else this.materials.push(mat);
    obj.userData.shared = true; // geometry is a shared cache
    // Third person: let off-screen guns cull (bounds cover the animation).
    // First person keeps drawing (the viewmodel is always in view).
    obj.frustumCulled = this.lod === 'low';
    this.group.add(obj);
    return obj;
  }

  // Body mesh (lit, the silhouette): shared geometry, per-gun material.
  body(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    const mesh = this.add(new THREE.Mesh(geo, mat));
    mesh.name = `${this.key}-body`;
    mesh.frustumCulled = this.lod === 'low';
    mesh.castShadow = this.lod === 'low';
    return mesh;
  }

  // Advance the shared uniforms (frame-rate independent).
  step(dt: number, s: CustomGunState): void {
    const d = this.drive;
    const calm = s.reduced;
    d.uCalm.value = calm ? 1 : 0;
    d.uTime.value = (d.uTime.value + dt * (calm ? 0.35 : 1)) % 3600;
    d.uCharge.value = Math.max(0, Math.min(1, Number.isFinite(s.charge) ? s.charge : 1));
    const firing = Math.max(0, Math.min(1, s.firing || 0));
    if (firing > this.prevFiring + 0.05) d.uShot.value = 0;
    else d.uShot.value = Math.min(99, d.uShot.value + dt);
    this.prevFiring = firing;
    d.uFire.value = firing * firing * (calm ? 0.6 : 1);
    const target = Math.max(0, Math.min(1, ((s.streak || 0) - 2) / (STREAK_FULL - 2)));
    d.uStreak.value += (target - d.uStreak.value) * (1 - Math.exp(-3 * dt));
    const rate = (1 + 4 * d.uFire.value + 1.2 * d.uStreak.value) * (calm ? 0.35 : 1);
    d.uPhase.value = (d.uPhase.value + dt * rate) % 3600;
    d.uDensity.value = this.baseDensity * (s.lowSpec ? 0.4 : 1) * (calm ? 0.6 : 1);
  }

  setFinish(f: RailgunFinish): void {
    applyFinish(this.drive, f);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }

  // Standard instance surface; `extra` runs after step (object-level motion).
  instance(extra?: (dt: number, s: CustomGunState) => void): CustomGunInstance {
    return {
      group: this.group,
      muzzle: this.muzzle,
      update: (dt, s) => {
        this.step(dt, s);
        extra?.(dt, s);
      },
      setFinish: (f) => this.setFinish(f),
      dispose: () => this.dispose(),
    };
  }
}

// ── Common parts (hold geometry matches the standard gun) ──────────────────

// Grip block + trigger guard + trigger, in the standard gun's place so the
// right hand (palm ≈ (0, −0.12, 0.09)) sits right.
export function addGrip(p: Parts, o: { grip: PartOpts; guard: PartOpts; hi: boolean }): void {
  p.add(chamferBox(0.058, 0.2, 0.08, 0.014), { ...o.grip, at: [0, -0.15, 0.1], rot: [0.32, 0, 0] });
  p.add(chamferBox(0.064, 0.016, 0.088, 0.005), { ...o.guard, at: [0, -0.245, 0.132], rot: [0.32, 0, 0] });
  p.add(chamferBox(0.014, 0.01, 0.11, 0.003), { ...o.guard, at: [0, -0.093, -0.002] });
  p.add(chamferBox(0.014, 0.056, 0.012, 0.003), { ...o.guard, at: [0, -0.066, -0.055] });
  if (o.hi) p.add(chamferBox(0.009, 0.034, 0.011, 0.002), { ...o.guard, at: [0, -0.058, 0.004], rot: [0.3, 0, 0] });
}

// Triangle count of a geometry (indexed or not).
export function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
