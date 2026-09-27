import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// Pooled rail trails (Quake III CG_RailTrail, rebuilt for a bloom pipeline).
//
// Each trail is two draws, both evaluated entirely on the GPU from a handful of
// uniforms, so firing costs zero allocations and zero buffer uploads:
//
//  • CORE — one camera-facing ribbon from muzzle to impact. Its cross-section
//    is a white-hot, bloom-bright core line (≥ ~1 px wide at any range, so it
//    never breaks up or shimmers) inside a soft coloured glow sleeve. The core
//    flashes and cools into the rail colour within ~0.4 s; the sleeve loosens
//    and fades by ~0.6 s. The ribbon tapers out of the muzzle.
//  • SPIRAL — up to MAX_MOTES soft motes laid along a helix around the beam
//    (instanced; the vertex shader places mote i at s = s0 + i·spacing). Fresh,
//    they overlap into a continuous spiral; over the life the helix radius
//    eases outward and the motes shrink in brightness, so the spiral spreads
//    and dissipates (~0.85 s).
//
// Own beams (the local shooter's) clear their first few metres almost at once
// so the line from the gun to the crosshair never hangs in front of the aim.
// Distant pieces are clamped to a minimum pixel size with energy-conserving
// dimming, so far trails stay crisp instead of aliasing into dots.
//
// One pool per scene (owned by the scene's FxContext); the oldest trail is
// recycled when every slot is live.
// ─────────────────────────────────────────────────────────────────────────

const SLOTS = 16;
const CORE_SEGS = 44;
const MAX_MOTES = 2400;
const MOTE_SPACING = 0.035; // metres between spiral motes (full quality)
const SPIRAL_START = 0.3; // spiral begins this far past the muzzle

export const BEAM_LIFE = 0.85; // s — the spiral's life; core/glow fade sooner
const OWN_LIFE_SCALE = 0.8;
const HELIX_TURN = 0.75; // metres of beam per spiral turn
const HELIX_R0 = 0.11; // spiral radius when fresh…
const HELIX_R1 = 0.42; // …and fully spread
const GLOW_HALF_WIDTH = 0.16; // glow sleeve half-width (m)

// Shared: drawing-buffer height for the pixel clamp, refreshed right before
// any beam draws (onBeforeRender), so every material reads the live value.
const viewH = { value: 900 };
const tmpSize = new THREE.Vector2();
function syncViewH(renderer: THREE.WebGLRenderer) {
  const rt = renderer.getRenderTarget();
  viewH.value = rt ? rt.height : renderer.getDrawingBufferSize(tmpSize).y;
}

const COMMON = /* glsl */ `
uniform vec3 uStart;
uniform vec3 uEnd;
uniform float uAge;
uniform float uLife;
uniform float uOwn;
uniform float uViewH;
// World size of one pixel at view depth d.
float pixelSize(float d) { return 2.0 * max(d, 0.05) / (projectionMatrix[1][1] * uViewH); }
`;

const NEAR_FADE = /* glsl */ `
// Own beam: the first metres (gun → crosshair) clear almost immediately.
float nearFade(float s, float t) {
  return mix(1.0, exp(-t * 16.0), uOwn * (1.0 - smoothstep(1.5, 6.0, s)));
}
`;

const CORE_VERT = /* glsl */ `
${COMMON}
uniform float uWidth;
varying float vX;
varying float vS;
varying float vPx;
varying float vDim;
void main() {
  vec3 d = uEnd - uStart;
  float len = length(d);
  vec3 axis = len > 1e-5 ? d / len : vec3(0.0, 0.0, -1.0);
  float s = position.x * len;
  vec3 P = uStart + axis * s;
  vec3 side = cross(axis, cameraPosition - P);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);
  float px = pixelSize(-(viewMatrix * vec4(P, 1.0)).z);
  float k = clamp(uAge / uLife, 0.0, 1.0);
  float hw = uWidth * mix(0.22, 1.0, smoothstep(0.0, 1.4, s)) * (1.0 + 0.7 * k);
  float hwc = max(hw, px * 3.0);
  // Widened past its world size → dim to match; right beside the camera (a
  // trail passing your head) → fade instead of washing out the screen.
  vDim = mix(1.0, hw / hwc, 0.6) * smoothstep(0.35, 1.6, length(cameraPosition - P));
  vPx = hwc / px;
  vX = position.y;
  vS = s;
  gl_Position = projectionMatrix * viewMatrix * vec4(P + side * hwc * position.y, 1.0);
}
`;

const CORE_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uAge;
uniform float uLife;
uniform float uOwn;
${NEAR_FADE}
varying float vX;
varying float vS;
varying float vPx;
varying float vDim;
void main() {
  float x = abs(vX);
  float t = uAge;
  float cw = max(0.12, 1.2 / vPx); // core ≥ ~1 px either side of the axis
  float core = exp(-(x * x) / (cw * cw));
  float glow = exp(-x * x * 3.0) * (1.0 - x);
  float coreLife = uLife * 0.7;
  float glowLife = uLife * 0.85;
  float coreI = 3.0 * exp(-t * 10.0) + 1.6 * pow(max(0.0, 1.0 - t / coreLife), 1.6);
  float glowI = 1.3 * pow(max(0.0, 1.0 - t / glowLife), 1.4);
  vec3 coreCol = mix(vec3(1.0), uCore, smoothstep(0.0, 0.1, t));
  coreCol = mix(coreCol, uGlow, 0.55 * smoothstep(0.1, coreLife, t));
  float head = smoothstep(0.0, 0.2, vS);
  vec3 col = (coreCol * core * coreI + uGlow * glow * glowI) * head * nearFade(vS, t) * vDim;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const SPIRAL_VERT = /* glsl */ `
${COMMON}
attribute float aIdx;
uniform vec3 uU;
uniform vec3 uV;
uniform float uS0;
uniform float uSpacing;
uniform float uPhase;
varying vec2 vUv;
varying float vS;
varying float vFade;
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec3 d = uEnd - uStart;
  float len = length(d);
  float s = uS0 + aIdx * uSpacing;
  if (s > len - 0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; } // past the end: clipped
  vec3 axis = d / max(len, 1e-5);
  float k = clamp(uAge / uLife, 0.0, 1.0);
  float h = hash(aIdx + 1.0);
  float spread = 1.0 - (1.0 - k) * (1.0 - k);
  float r = ${HELIX_R0.toFixed(3)} + ${(HELIX_R1 - HELIX_R0).toFixed(3)} * spread * (0.6 + 0.8 * h);
  float th = s / ${HELIX_TURN.toFixed(3)} * 6.2831853 + uPhase;
  vec3 C = uStart + axis * s + (cos(th) * uU + sin(th) * uV) * r;
  vec4 mv = viewMatrix * vec4(C, 1.0);
  float size = mix(0.04, 0.07, spread);
  float sizec = max(size, pixelSize(-mv.z) * 1.6);
  mv.xy += position.xy * sizec;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vS = s;
  float area = size / sizec;
  // Motes right beside the camera (a trail whizzing past your head) fade out
  // instead of ballooning into screen-filling blobs.
  float camNear = smoothstep(0.5, 1.8, length(cameraPosition - C));
  vFade = pow(1.0 - k, 1.3) * (0.7 + 0.6 * h) * area * area * camNear;
}
`;

const SPIRAL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAge;
uniform float uOwn;
${NEAR_FADE}
varying vec2 vUv;
varying float vS;
varying float vFade;
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 4.0) - 0.0183; // gaussian, zero at the quad edge
  vec3 c = mix(vec3(1.0), uColor, smoothstep(0.0, 0.14, uAge));
  float head = smoothstep(0.3, 0.7, vS);
  gl_FragColor = vec4(c * (1.35 * a * vFade * head * nearFade(vS, uAge)), 1.0);
  #include <colorspace_fragment>
}
`;

type Uniforms = {
  uStart: { value: THREE.Vector3 };
  uEnd: { value: THREE.Vector3 };
  uAge: { value: number };
  uLife: { value: number };
  uOwn: { value: number };
  uViewH: { value: number };
};

type Slot = {
  core: THREE.Mesh;
  spiral: THREE.Mesh;
  spiralGeo: THREE.InstancedBufferGeometry;
  coreMat: THREE.ShaderMaterial;
  spiralMat: THREE.ShaderMaterial;
  u: Uniforms;
  uU: { value: THREE.Vector3 };
  uV: { value: THREE.Vector3 };
  uSpacing: { value: number };
  uPhase: { value: number };
  uCore: { value: THREE.Color };
  uGlow: { value: THREE.Color };
  age: number;
  life: number;
  active: boolean;
};

// Ribbon: x = warped 0…1 along the beam (dense near the muzzle for the taper +
// own-beam fade), y = ±1 across.
function buildCoreGeometry(): THREE.BufferGeometry {
  const n = CORE_SEGS + 1;
  const pos = new Float32Array(n * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.pow(i / CORE_SEGS, 2.2);
    pos.set([f, -1, 0, f, 1, 0], i * 6);
    if (i < CORE_SEGS) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpAxis = new THREE.Vector3();

export class RailBeams {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly coreGeo = buildCoreGeometry();
  private readonly quadPos: THREE.BufferAttribute;
  private readonly quadIndex: THREE.BufferAttribute;
  private readonly moteIdx: THREE.InstancedBufferAttribute;
  private quality = 1;

  constructor() {
    this.group.name = 'rail-beams';
    this.group.userData.shared = true;
    this.quadPos = new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3);
    this.quadIndex = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    const ids = new Float32Array(MAX_MOTES);
    for (let i = 0; i < MAX_MOTES; i++) ids[i] = i;
    this.moteIdx = new THREE.InstancedBufferAttribute(ids, 1);
    for (let i = 0; i < SLOTS; i++) this.slots.push(this.buildSlot());
  }

  private buildSlot(): Slot {
    const u: Uniforms = {
      uStart: { value: new THREE.Vector3() },
      uEnd: { value: new THREE.Vector3() },
      uAge: { value: 0 },
      uLife: { value: BEAM_LIFE },
      uOwn: { value: 0 },
      uViewH: viewH,
    };
    const uCore = { value: new THREE.Color() };
    const uGlow = { value: new THREE.Color() };
    const uU = { value: new THREE.Vector3() };
    const uV = { value: new THREE.Vector3() };
    const uSpacing = { value: MOTE_SPACING };
    const uPhase = { value: 0 };
    const additive = {
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    } as const;
    const coreMat = new THREE.ShaderMaterial({
      ...additive,
      uniforms: { ...u, uWidth: { value: GLOW_HALF_WIDTH }, uCore, uGlow },
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
    });
    const spiralMat = new THREE.ShaderMaterial({
      ...additive,
      uniforms: { ...u, uU, uV, uS0: { value: SPIRAL_START }, uSpacing, uPhase, uColor: uGlow },
      vertexShader: SPIRAL_VERT,
      fragmentShader: SPIRAL_FRAG,
    });
    const spiralGeo = new THREE.InstancedBufferGeometry();
    spiralGeo.setAttribute('position', this.quadPos);
    spiralGeo.setIndex(this.quadIndex);
    spiralGeo.setAttribute('aIdx', this.moteIdx);
    spiralGeo.instanceCount = 0;

    const core = new THREE.Mesh(this.coreGeo, coreMat);
    const spiral = new THREE.Mesh(spiralGeo, spiralMat);
    for (const m of [core, spiral]) {
      m.frustumCulled = false;
      m.visible = false;
      m.matrixAutoUpdate = false;
      m.userData.shared = true;
      m.renderOrder = 3;
      this.group.add(m);
    }
    core.onBeforeRender = (renderer) => syncViewH(renderer);
    spiral.onBeforeRender = (renderer) => syncViewH(renderer);
    return {
      core, spiral, spiralGeo, coreMat, spiralMat, u, uU, uV, uSpacing, uPhase, uCore, uGlow,
      age: 0, life: BEAM_LIFE, active: false,
    };
  }

  // 1 = full; < 1 thins the spiral (low-spec).
  setQuality(q: number) {
    this.quality = q;
  }

  // Start a trail. `own` = the local shooter's beam (fast near-eye clear).
  spawn(origin: THREE.Vector3, end: THREE.Vector3, core: number, glow: number, own: boolean) {
    let slot: Slot | null = null;
    for (const s of this.slots) {
      if (!s.active) { slot = s; break; }
      if (!slot || s.age / s.life > slot.age / slot.life) slot = s;
    }
    const s = slot!;
    const len = origin.distanceTo(end);
    s.active = true;
    s.age = 0;
    s.life = own ? BEAM_LIFE * OWN_LIFE_SCALE : BEAM_LIFE;
    s.u.uStart.value.copy(origin);
    s.u.uEnd.value.copy(end);
    s.u.uAge.value = 0;
    s.u.uLife.value = s.life;
    s.u.uOwn.value = own ? 1 : 0;
    s.uCore.value.setHex(core);
    s.uGlow.value.setHex(glow);
    // Perpendicular basis for the helix.
    tmpAxis.subVectors(end, origin);
    if (len > 1e-5) tmpAxis.multiplyScalar(1 / len);
    else tmpAxis.set(0, 0, -1);
    if (Math.abs(tmpAxis.y) < 0.99) s.uU.value.crossVectors(tmpAxis, UP).normalize();
    else s.uU.value.set(1, 0, 0);
    s.uV.value.crossVectors(tmpAxis, s.uU.value).normalize();
    s.uPhase.value = Math.random() * Math.PI * 2;
    const span = Math.max(0, len - SPIRAL_START);
    const spacing = Math.max(MOTE_SPACING / Math.max(0.35, this.quality), span / MAX_MOTES);
    s.uSpacing.value = spacing;
    s.spiralGeo.instanceCount = Math.min(MAX_MOTES, Math.ceil(span / spacing));
    s.core.visible = len > 1e-3;
    s.spiral.visible = s.spiralGeo.instanceCount > 0;
  }

  step(dt: number) {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        s.core.visible = false;
        s.spiral.visible = false;
        continue;
      }
      s.u.uAge.value = s.age;
    }
  }

  clear() {
    for (const s of this.slots) {
      s.active = false;
      s.core.visible = false;
      s.spiral.visible = false;
    }
  }

  dispose() {
    this.clear();
    for (const s of this.slots) {
      s.coreMat.dispose();
      s.spiralMat.dispose();
      s.spiralGeo.dispose();
    }
    this.coreGeo.dispose();
    this.group.removeFromParent();
    this.group.clear();
    this.slots.length = 0;
  }
}
