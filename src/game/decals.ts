import * as THREE from 'three';
import type { AABB } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Rail impact decals: a fixed ring buffer of surface quads in ONE
// InstancedMesh + one tiny ShaderMaterial (one draw call for all of them).
//
// Each decal carries its birth time as an instanced attribute and the shader
// ages it from a `uTime` uniform, so placing a decal is the only CPU write —
// nothing is re-uploaded per frame. The texture packs three masks: R = molten
// rim (+ faint blast spokes), G = hot core, A = scorch. Output is
// premultiplied: rgb (the glow) ADDS while alpha (the scorch) DARKENS what's
// under it. A fresh hit reads as a white-hot pinhole inside a glowing rim that
// cools through the rail tint to a dark burn over ~1 s; the burn lingers, then
// fades out.
//
// Each decal also carries the struck box's bounds and the fragment shader
// clips to them, so a ~1 m scorch near a corner or ledge never hangs off the
// face into the air. Quads sit a hair off the surface along its normal and use
// polygon offset, so they never z-fight with the map's box faces.
// ─────────────────────────────────────────────────────────────────────────

const MAX_DECALS = 32;
const TEX_SIZE = 256;
const SURFACE_OFFSET = 0.012; // metres off the face along its normal
const CLIP_PAD = 0.03; // box-clip slack (covers the surface offset)
const SCORCH_HOLD = 10; // seconds the scorch stays fully dark
const SCORCH_FADE = 6; // seconds it then takes to fade out
const NO_CLIP = 1e6;

const VERT = /* glsl */ `
attribute float aBirth;
attribute vec3 aTint;
attribute vec3 aBoxMin;
attribute vec3 aBoxMax;
uniform float uTime;
varying vec2 vUv;
varying float vAge;
varying vec3 vTint;
varying vec3 vWorld;
varying vec3 vBoxMin;
varying vec3 vBoxMax;
void main() {
  vUv = uv;
  vAge = uTime - aBirth;
  vTint = aTint;
  vBoxMin = aBoxMin;
  vBoxMax = aBoxMax;
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uHold;
uniform float uFade;
varying vec2 vUv;
varying float vAge;
varying vec3 vTint;
varying vec3 vWorld;
varying vec3 vBoxMin;
varying vec3 vBoxMax;
void main() {
  if (any(lessThan(vWorld, vBoxMin)) || any(greaterThan(vWorld, vBoxMax))) discard;
  vec4 t = texture2D(uMap, vUv);
  float age = max(vAge, 0.0);
  // The mask is authored perceptually; blending happens in linear light, where
  // a partial darken reads weaker, so lift it a little (1 − (1 − a)^1.6) and
  // cap it well short of black so it reads as a burn on any surface.
  float scorch = t.a * clamp(1.0 - (age - uHold) / uFade, 0.0, 1.0);
  scorch = (1.0 - pow(1.0 - scorch, 1.6)) * 0.72;
  float rim = t.r * (exp(-age * 2.6) * 3.2 + exp(-age * 1.4) * 0.35);
  float hot = t.g * exp(-age * 9.0);
  if (scorch < 0.003 && rim + hot < 0.003) discard;
  vec3 rimCol = mix(vTint, vec3(1.0), 0.65 * exp(-age * 4.0));
  vec3 glow = rimCol * rim + mix(vTint, vec3(1.0), 0.8) * hot * 3.2;
  gl_FragColor = vec4(glow, scorch);
  #include <colorspace_fragment>
}
`;

let decalTex: THREE.DataTexture | null = null;

// Deterministic 1D value noise over the angle (fixed seed, no Math.random).
function angularNoise(theta: number, octaves: Array<[number, number, number]>): number {
  let v = 0;
  for (const [freq, amp, phase] of octaves) v += Math.sin(theta * freq + phase) * amp;
  return v;
}

// Deterministic 2D value noise (hashed lattice, smooth interpolation).
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Procedural mask texture. r is normalised to the quad half-size (1 = edge).
function decalTexture(): THREE.DataTexture {
  if (decalTex) return decalTex;
  const S = TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const edgeOct: Array<[number, number, number]> = [[3, 0.5, 0.7], [5, 0.3, 2.1], [9, 0.18, 4.4], [14, 0.1, 1.3]];
  const rimOct: Array<[number, number, number]> = [[2, 0.2, 0.9], [3, 0.3, 0.3], [5, 0.22, 2.6], [8, 0.25, 1.1], [13, 0.18, 4.0], [21, 0.1, 5.2]];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = ((x + 0.5) / S) * 2 - 1;
      const v = ((y + 0.5) / S) * 2 - 1;
      const r = Math.hypot(u, v);
      const theta = Math.atan2(v, u);
      // Blast spokes: narrow radial streaks at fixed pseudo-random angles.
      const spokeRaw = Math.max(0, Math.sin(theta * 11 + 0.6) * Math.sin(theta * 7 + 2.3));
      const spoke = Math.pow(spokeRaw, 6);
      // Scorch: a charred RING just outside the molten rim (the burn), a paler
      // seared centre inside it, and a soft, ragged soot haze that feathers out
      // to ~0.85 with a long gradient — no hard-edged solid disc — mottled by
      // value noise, plus faint blast spokes.
      const edge = 0.82 + 0.08 * angularNoise(theta, edgeOct);
      const out = Math.max(0, r - 0.37) / ((edge - 0.37) * 0.55);
      const inner = 0.35 + 0.65 * Math.min(1, Math.max(0, (r - 0.1) / 0.27));
      const haze = Math.exp(-out * out) * inner;
      const mottle = 0.65 + 0.35 * valueNoise(u * 7 + 3.1, v * 7 + 1.7);
      const dChar = (r - 0.37) / 0.11;
      const charRing = Math.exp(-dChar * dChar);
      const seared = 0.2 * Math.exp(-Math.pow(r / 0.3, 2));
      const streak = spoke * Math.max(0, 1 - r / 0.95) * Math.min(1, r / 0.3);
      // Union of the layers (1 − Π(1 − a)) so overlaps never clip to black.
      const scorch = 1 - (1 - charRing * 0.55 * (0.8 + 0.2 * mottle)) * (1 - haze * 0.5 * mottle) * (1 - seared) * (1 - streak * 0.22);
      // Molten rim: a bright ragged (non-periodic-looking) annulus + faint spokes.
      const rr = 0.31 + 0.03 * angularNoise(theta, rimOct);
      const dRim = (r - rr) / 0.055;
      const rim = Math.min(1, Math.exp(-dRim * dRim) + 0.35 * streak * Math.max(0, 1 - r / 0.6));
      // Hot core.
      const hot = Math.exp(-(r / 0.15) * (r / 0.15));
      const i = (y * S + x) * 4;
      data[i] = Math.round(rim * 255);
      data[i + 1] = Math.round(hot * 255);
      data[i + 2] = 0;
      data[i + 3] = Math.round(scorch * 255);
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  decalTex = t;
  return t;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpQuat = new THREE.Quaternion();
const tmpRoll = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpColor = new THREE.Color();

export class DecalManager {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly birth: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly boxMin: THREE.InstancedBufferAttribute;
  private readonly boxMax: THREE.InstancedBufferAttribute;
  private head = 0;
  private used = 0;
  private capacity = MAX_DECALS;
  private time = 0;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    const inst = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.birth = inst(1);
    this.tint = inst(3);
    this.boxMin = inst(3);
    this.boxMax = inst(3);
    this.geometry.setAttribute('aBirth', this.birth);
    this.geometry.setAttribute('aTint', this.tint);
    this.geometry.setAttribute('aBoxMin', this.boxMin);
    this.geometry.setAttribute('aBoxMax', this.boxMax);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: decalTexture() },
        uTime: { value: 0 },
        uHold: { value: SCORCH_HOLD },
        uFade: { value: SCORCH_FADE },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_DECALS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1; // under the additive FX, over the opaque map
    this.mesh.userData.shared = true;
  }

  get enabled(): boolean {
    return this.capacity > 0;
  }

  // Low-spec (≤ 0.5) turns decals off entirely; in between scales the ring.
  setQuality(q: number) {
    const cap = q <= 0.5 ? 0 : Math.max(1, Math.round(MAX_DECALS * Math.min(1, q)));
    if (cap === this.capacity) return;
    this.capacity = cap;
    this.clear();
  }

  setTime(t: number) {
    this.time = t;
    this.material.uniforms.uTime.value = t;
  }

  // Stamp a decal centred on `point`, facing along the surface `normal`
  // (unit length), tinted `hex`, `size` metres across. `clip` (the struck
  // box) keeps it on that box's faces. Overwrites the oldest slot once full.
  place(point: THREE.Vector3, normal: THREE.Vector3, hex: number, size: number, clip?: AABB) {
    if (this.capacity <= 0) return;
    const i = this.head;
    tmpQuat.setFromUnitVectors(Z_AXIS, normal);
    tmpRoll.setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    tmpQuat.premultiply(tmpRoll);
    tmpPos.copy(point).addScaledVector(normal, SURFACE_OFFSET);
    tmpScale.set(size, size, 1);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    tmpMat.toArray(this.mesh.instanceMatrix.array as unknown as number[], i * 16);
    (this.birth.array as Float32Array)[i] = this.time;
    tmpColor.setHex(hex);
    const ta = this.tint.array as Float32Array;
    ta[i * 3] = tmpColor.r;
    ta[i * 3 + 1] = tmpColor.g;
    ta[i * 3 + 2] = tmpColor.b;
    const lo = this.boxMin.array as Float32Array;
    const hi = this.boxMax.array as Float32Array;
    if (clip) {
      lo[i * 3] = clip.min.x - CLIP_PAD;
      lo[i * 3 + 1] = clip.min.y - CLIP_PAD;
      lo[i * 3 + 2] = clip.min.z - CLIP_PAD;
      hi[i * 3] = clip.max.x + CLIP_PAD;
      hi[i * 3 + 1] = clip.max.y + CLIP_PAD;
      hi[i * 3 + 2] = clip.max.z + CLIP_PAD;
    } else {
      lo[i * 3] = lo[i * 3 + 1] = lo[i * 3 + 2] = -NO_CLIP;
      hi[i * 3] = hi[i * 3 + 1] = hi[i * 3 + 2] = NO_CLIP;
    }
    this.head = (i + 1) % this.capacity;
    this.used = Math.min(this.used + 1, this.capacity);
    this.mesh.count = this.used;
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.boxMin.needsUpdate = true;
    this.boxMax.needsUpdate = true;
  }

  clear() {
    this.head = 0;
    this.used = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
