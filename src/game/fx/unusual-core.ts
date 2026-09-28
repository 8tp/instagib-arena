import * as THREE from 'three';

// Shared point-cloud engine for the unusual effects (unusuals.ts), the
// full-body taunt auras (taunt-aura.ts) and the professional-killstreak eyes
// (killstreak-eyes.ts): the math helpers, the FOV-correct additive point
// material and the fixed-capacity world-space Field.

export const TAU = Math.PI * 2;
export const rnd = Math.random;
export const GOLDEN = 0.6180339887;

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const hsvOut = [0, 0, 0];
export function hsv(h: number, s: number, v: number): number[] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: hsvOut[0] = v; hsvOut[1] = t; hsvOut[2] = p; break;
    case 1: hsvOut[0] = q; hsvOut[1] = v; hsvOut[2] = p; break;
    case 2: hsvOut[0] = p; hsvOut[1] = v; hsvOut[2] = t; break;
    case 3: hsvOut[0] = p; hsvOut[1] = q; hsvOut[2] = v; break;
    case 4: hsvOut[0] = t; hsvOut[1] = p; hsvOut[2] = v; break;
    default: hsvOut[0] = v; hsvOut[1] = p; hsvOut[2] = q;
  }
  return hsvOut;
}

// ── Point material ──────────────────────────────────────────────────────────

const POINT_VERT = /* glsl */ `
attribute vec4 aColor;   // linear rgb (may exceed 1) + alpha
attribute float aSize;   // diameter, metres
attribute vec2 aSprite;  // atlas cell, rotation (rad)
uniform float uViewH;    // current viewport height, physical px
uniform float uMinPx;
uniform float uGain;
uniform float uHdrCap;
uniform float uNear; // >0: fade out inside this distance (m) so a close camera is never blinded
uniform float uMinLum; // far away, dim particles are lifted to this peak so the effect still reads
varying vec4 vColor;
varying vec2 vCell;
varying vec2 vRot;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // FOV-correct: three's stock attenuation omits projectionMatrix[1][1].
  float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / max(-mvPosition.z, 0.01);
  float k = 1.0;
  if (px < uMinPx) { k = px / uMinPx; px = uMinPx; }
  gl_PointSize = min(px, 360.0);
  vec3 c = aColor.rgb * uGain;
  float peak = max(c.r, max(c.g, c.b));
  if (peak > uHdrCap) c *= uHdrCap / peak;
  else if (peak < uMinLum && peak > 0.015) c *= uMinLum / peak;
  if (uNear > 0.0) k *= smoothstep(uNear, uNear * 2.0, -mvPosition.z);
  vColor = vec4(c, aColor.a * k);
  vCell = vec2(mod(aSprite.x, 4.0), floor(aSprite.x / 4.0 + 0.001));
  vRot = vec2(cos(aSprite.y), sin(aSprite.y));
  if (aColor.a <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // parked
  #include <fog_vertex>
}
`;

const POINT_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uOcclude;
varying vec4 vColor;
varying vec2 vCell;
varying vec2 vRot;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  p = vec2(vRot.x * p.x - vRot.y * p.y, vRot.y * p.x + vRot.x * p.y) + 0.5;
  p = clamp(p, 0.02, 0.98);
  vec2 uv = vec2((vCell.x + p.x) * 0.25, 1.0 - (vCell.y + p.y) * 0.25);
  vec4 t = texture2D(uAtlas, uv);
  float a = t.a * vColor.a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (a < 0.004) discard;
  // Premultiplied: rgb adds light, alpha (× uOcclude) dims what's behind — so
  // a flame stays saturated against a bright sky yet reads as pure glow on
  // dark walls. The storm cloud (uOcclude 1) is plain alpha blending.
  gl_FragColor = vec4(vColor.rgb * t.rgb * a, a * uOcclude);
  #include <colorspace_fragment>
}
`;

export type SharedUniforms = {
  uAtlas: { value: THREE.Texture };
  uViewH: { value: number };
  uMinPx: { value: number };
  uGain: { value: number };
  uHdrCap: { value: number };
  uMinLum: { value: number };
  uOcclude: { value: number };
};

export function pointMaterial(u: SharedUniforms & Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  u.uNear ??= { value: 0 };
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    fog: true,
    toneMapped: false,
  });
}

// A fixed-capacity point cloud in world space (its matrixWorld is pinned to
// identity; the parent chain only decides visibility).
export class Field {
  readonly points: THREE.Points;
  readonly n: number;
  private readonly geom = new THREE.BufferGeometry();
  readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly siz: Float32Array;
  private readonly spr: Float32Array;

  constructor(n: number, u: SharedUniforms & Record<string, THREE.IUniform>, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.siz = new Float32Array(n);
    this.spr = new Float32Array(n * 2);
    const dyn = (arr: Float32Array, size: number) => {
      const a = new THREE.BufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geom.setAttribute('position', dyn(this.pos, 3));
    this.geom.setAttribute('aColor', dyn(this.col, 4));
    this.geom.setAttribute('aSize', dyn(this.siz, 1));
    this.geom.setAttribute('aSprite', dyn(this.spr, 2));
    this.geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.mat = pointMaterial(u);
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.matrixAutoUpdate = false;
    this.points.matrixWorldAutoUpdate = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  put(i: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number, size: number, cell: number, rot: number) {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.siz[i] = size;
    this.spr[i * 2] = cell; this.spr[i * 2 + 1] = rot;
  }

  hide(i: number) {
    this.col[i * 4 + 3] = 0;
  }

  hideAll() {
    for (let i = 0; i < this.n; i++) this.col[i * 4 + 3] = 0;
  }

  setBounds(x: number, y: number, z: number, r: number) {
    const s = this.geom.boundingSphere!;
    s.center.set(x, y, z);
    s.radius = r;
  }

  commit() {
    const a = this.geom.attributes;
    a.position.needsUpdate = true;
    a.aColor.needsUpdate = true;
    a.aSize.needsUpdate = true;
    a.aSprite.needsUpdate = true;
  }

  dispose() {
    this.points.removeFromParent();
    this.geom.dispose();
    this.mat.dispose();
  }
}

export const tmpVp = new THREE.Vector4();
export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
