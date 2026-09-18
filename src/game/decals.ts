import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// Rail impact decals: a fixed ring buffer of surface quads in ONE
// InstancedMesh + one tiny ShaderMaterial (one draw call for all of them).
//
// Each decal carries its birth time as an instanced attribute and the shader
// ages it from a `uTime` uniform, so placing a decal is the only CPU write —
// nothing is re-uploaded per frame. The texture packs three masks: R = glow
// ring, G = hot core, A = scorch. Output is premultiplied: rgb (the glow)
// ADDS while alpha (the scorch) DARKENS what's under it, so a fresh hit reads
// as a white-hot point inside a tinted ring that cools into a dark scorch mark
// over ~1.5 s, which then lingers and fades out.
//
// Quads sit a hair off the surface along its normal and use polygon offset,
// so they never z-fight with the map's box faces.
// ─────────────────────────────────────────────────────────────────────────

const MAX_DECALS = 24;
const TEX_SIZE = 128;
const SURFACE_OFFSET = 0.012; // metres off the face along its normal
const SCORCH_HOLD = 10; // seconds the scorch stays fully dark
const SCORCH_FADE = 6; // seconds it then takes to fade out

const VERT = /* glsl */ `
attribute float aBirth;
attribute vec3 aTint;
uniform float uTime;
varying vec2 vUv;
varying float vAge;
varying vec3 vTint;
void main() {
  vUv = uv;
  vAge = uTime - aBirth;
  vTint = aTint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uHold;
uniform float uFade;
varying vec2 vUv;
varying float vAge;
varying vec3 vTint;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float age = max(vAge, 0.0);
  float scorch = t.a * clamp(1.0 - (age - uHold) / uFade, 0.0, 1.0) * 0.6;
  float ring = t.r * exp(-age * 2.4);
  float hot = t.g * exp(-age * 9.0);
  if (scorch < 0.003 && ring + hot < 0.003) discard;
  vec3 glow = vTint * ring * 1.6 + mix(vTint, vec3(1.0), 0.7) * hot * 2.6;
  gl_FragColor = vec4(glow, scorch);
  #include <colorspace_fragment>
}
`;

let decalTex: THREE.DataTexture | null = null;

// Procedural mask texture (deterministic — fixed phases, no Math.random).
function decalTexture(): THREE.DataTexture {
  if (decalTex) return decalTex;
  const S = TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = ((x + 0.5) / S) * 2 - 1;
      const v = ((y + 0.5) / S) * 2 - 1;
      const r = Math.hypot(u, v);
      const theta = Math.atan2(v, u);
      // Scorch: a soft dark disk with a ragged, blotchy rim.
      const edge = 0.74 + 0.14 * (Math.sin(3 * theta + 0.7) * 0.5 + Math.sin(5 * theta + 2.1) * 0.3 + Math.sin(8 * theta + 4.4) * 0.2);
      let scorch = Math.min(1, Math.max(0, (edge - r) / 0.3));
      scorch = scorch * scorch * (3 - 2 * scorch) * (0.55 + 0.45 * Math.max(0, 1 - r));
      // Glow ring: a thin bright annulus with a softer halo.
      const d = (r - 0.58) / 0.055;
      const dh = (r - 0.58) / 0.16;
      const ring = Math.min(1, Math.exp(-d * d) + 0.35 * Math.exp(-dh * dh));
      // Hot core.
      const hot = Math.exp(-(r / 0.2) * (r / 0.2));
      const i = (y * S + x) * 4;
      data[i] = Math.round(ring * 255);
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
  private head = 0;
  private used = 0;
  private capacity = MAX_DECALS;
  private time = 0;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS), 1);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * 3), 3);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aBirth', this.birth);
    this.geometry.setAttribute('aTint', this.tint);
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
  // (unit length), tinted `hex`, `size` metres across. Overwrites the oldest
  // slot once the ring is full.
  place(point: THREE.Vector3, normal: THREE.Vector3, hex: number, size: number) {
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
    this.head = (i + 1) % this.capacity;
    this.used = Math.min(this.used + 1, this.capacity);
    this.mesh.count = this.used;
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.tint.needsUpdate = true;
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
