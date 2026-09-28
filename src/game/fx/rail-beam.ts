import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// Pooled rail trails (Quake III CG_RailTrail, rebuilt for a bloom pipeline).
//
// Each trail is up to three draws, all evaluated on the GPU from a handful of
// uniforms, so firing costs zero allocations and zero buffer uploads:
//
//  • CORE — one camera-facing ribbon from muzzle to impact. Its cross-section
//    is a white-hot filament (≥ ~0.7 px either side of the axis, so it never
//    breaks up or shimmers) inside a coloured core line inside a soft glow
//    sleeve (≤ ~28 px wide however close it passes). The filament flashes and
//    burns out first, the core cools into the rail colour, the sleeve loosens
//    and fades. The ribbon tapers out of the muzzle.
//  • SPIRAL — one continuous thin ribbon wound round the beam as a helix (a
//    strip template; the vertex shader places vertex i at s = s0 + i·step and
//    faces it to the camera). Its width is clamped to ~2–5 px on screen at any
//    distance, so it never balloons near the camera. Over the life the helix
//    radius eases outward and the ribbon breaks into dashes that drop out, so
//    the spiral spreads and dissipates (~0.85 s). Bright glints sparkle along
//    it while it is fresh.
//  • FLARE — a brief (~0.12 s) white-hot star where the beam punches a wall
//    (only when the shot ended on a surface).
//
// Spectrum rails (railColor mode 'spectrum') cycle the hue along the helix and
// over time; the core stays white-hot with a hint of the passing hue.
//
// Everything within ~2 m of the camera fades out (a trail passing your head
// never fills the screen). Own beams (the local shooter's) also clear their
// first few metres almost at once so the line from the gun to the crosshair
// never hangs in front of the aim. Pieces widened past their world size by the
// pixel clamps dim to match, so far trails stay crisp instead of aliasing.
//
// One pool per scene (owned by the scene's FxContext); the oldest trail is
// recycled when every slot is live. Low-spec (setQuality < 1) coarsens the
// spiral.
// ─────────────────────────────────────────────────────────────────────────

const SLOTS = 16;
const CORE_SEGS = 44;
const HELIX_SEGS = 3200; // strip segments per trail (full quality)
const SPIRAL_START = 0.3; // spiral begins this far past the muzzle

export const BEAM_LIFE = 0.85; // s — the spiral's life; core/glow fade sooner
const OWN_LIFE_SCALE = 0.8;
const HELIX_TURN = 0.75; // metres of beam per spiral turn
const HELIX_STEP = HELIX_TURN / 16; // metres of beam per strip segment
const HELIX_R0 = 0.1; // spiral radius when fresh…
const HELIX_R1 = 0.34; // …and fully spread
const GLOW_HALF_WIDTH = 0.16; // glow sleeve half-width (m)
const FLARE_LIFE = 0.12; // s — the impact star

export type RailBeamMode = 'spectrum';

export type RailBeamOptions = {
  // 'spectrum': the hue cycles along the helix and over time.
  mode?: RailBeamMode;
  // The shot ended on a drawn surface: punch a flare there.
  impact?: boolean;
};

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
// The whole trail fades out within ~2 m of the camera.
float camFade(vec3 p) { return smoothstep(0.9, 2.1, length(cameraPosition - p)); }
`;

const HUE = /* glsl */ `
// Fully saturated hue ramp (0…1 wraps).
vec3 railHue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
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
  // ≥ 3 px either side (crisp at range), ≤ 14 px (never a screen-wide wash).
  float hwc = clamp(hw, px * 3.0, px * 14.0);
  // Widened past its world size → dim to match; near the camera → fade.
  vDim = mix(1.0, min(1.0, hw / hwc), 0.6) * camFade(P);
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
uniform float uMode;
uniform float uSeed;
${NEAR_FADE}
${HUE}
varying float vX;
varying float vS;
varying float vPx;
varying float vDim;
void main() {
  float x = abs(vX);
  float t = uAge;
  // White-hot filament (≥ ~0.7 px) inside the coloured core (≥ ~1.4 px)
  // inside the glow sleeve.
  float fw = max(0.05, 0.75 / vPx);
  float cw = max(0.12, 1.5 / vPx);
  float fil = exp(-(x * x) / (fw * fw));
  float core = exp(-(x * x) / (cw * cw));
  float glow = exp(-x * x * 3.0) * (1.0 - x);
  float coreLife = uLife * 0.7;
  float glowLife = uLife * 0.85;
  float filI = 2.2 * exp(-t * 22.0) + 1.1 * pow(max(0.0, 1.0 - t / (uLife * 0.45)), 2.0);
  float coreI = 1.8 * exp(-t * 10.0) + 1.3 * pow(max(0.0, 1.0 - t / coreLife), 1.6);
  float glowI = 1.3 * pow(max(0.0, 1.0 - t / glowLife), 1.4);
  vec3 glowCol = uGlow;
  vec3 coreCol = uCore;
  if (uMode > 0.5) {
    glowCol = railHue(vS * 0.09 - t * 1.3 + uSeed) * 1.1;
    coreCol = mix(vec3(1.0), glowCol, 0.3);
  }
  coreCol = mix(coreCol, glowCol, 0.55 * smoothstep(0.1, coreLife, t));
  float head = smoothstep(0.0, 0.2, vS);
  vec3 col = (vec3(fil * filI) + coreCol * core * coreI + glowCol * glow * glowI) * head * nearFade(vS, t) * vDim;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const SPIRAL_VERT = /* glsl */ `
${COMMON}
uniform vec3 uU;
uniform vec3 uV;
uniform float uS0;
uniform float uStep;
uniform float uPhase;
varying float vX;
varying float vS;
varying float vFade;
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec3 d = uEnd - uStart;
  float len = length(d);
  vec3 axis = d / max(len, 1e-5);
  float s = min(uS0 + position.x * uStep, len);
  float k = clamp(uAge / uLife, 0.0, 1.0);
  float spread = 1.0 - (1.0 - k) * (1.0 - k);
  float r = ${HELIX_R0.toFixed(3)} + ${(HELIX_R1 - HELIX_R0).toFixed(3)} * spread;
  float w = 6.2831853 / ${HELIX_TURN.toFixed(3)};
  float th = s * w + uPhase;
  vec3 radial = cos(th) * uU + sin(th) * uV;
  vec3 C = uStart + axis * s + radial * r;
  vec3 tangent = normalize(axis + (-sin(th) * uU + cos(th) * uV) * (r * w));
  vec3 side = cross(tangent, cameraPosition - C);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : radial;
  float px = pixelSize(-(viewMatrix * vec4(C, 1.0)).z);
  // A thin ribbon: ~1.8–5 px wide on screen whatever the distance.
  float hwWorld = mix(0.008, 0.016, spread);
  float hw = clamp(hwWorld, px * 0.9, px * 2.5);
  float dim = max(0.3, min(1.0, hwWorld / hw));
  // Dissipation: the helix breaks into dashes that drop out as it ages.
  float n = hash(floor(s * 4.0) + uPhase * 13.0);
  float keep = 1.0 - smoothstep(n - 0.12, n + 0.12, k * 1.3 - 0.2);
  vX = position.y;
  vS = s;
  vFade = pow(1.0 - k, 1.2) * dim * keep * camFade(C);
  gl_Position = projectionMatrix * viewMatrix * vec4(C + side * hw * position.y, 1.0);
}
`;

const SPIRAL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAge;
uniform float uLife;
uniform float uOwn;
uniform float uMode;
uniform float uPhase;
${NEAR_FADE}
${HUE}
varying float vX;
varying float vS;
varying float vFade;
float sparkHash(float n) { return fract(sin(n * 78.233) * 43758.5453); }
void main() {
  float a = 1.0 - vX * vX; // soft edges across the ribbon
  vec3 base = uColor;
  if (uMode > 0.5) base = railHue(vS * 0.26 - uAge * 2.0 + uPhase * 0.159) * 1.15;
  vec3 c = mix(vec3(1.0), base, smoothstep(0.0, 0.14, uAge));
  // Sparkle: short glints scattered along the helix, twinkling while fresh.
  float cell = floor(vS * 2.5);
  float h = sparkHash(cell + uPhase * 17.0);
  float f = fract(vS * 2.5) - 0.5;
  float spot = exp(-f * f * 45.0) * step(0.55, h);
  float tw = 0.5 + 0.5 * sin(uAge * 36.0 + h * 50.0);
  float spark = spot * tw * tw * (1.0 - smoothstep(0.05, 0.6, uAge / uLife));
  float head = smoothstep(0.3, 0.8, vS);
  vec3 col = (c * 1.7 + mix(vec3(1.0), base, 0.25) * spark * 2.6) * a * vFade * head * nearFade(vS, uAge);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const FLARE_VERT = /* glsl */ `
${COMMON}
varying vec2 vQ;
varying float vDim;
void main() {
  vec3 back = uStart - uEnd;
  float bl = length(back);
  vec3 P = uEnd + (bl > 1e-4 ? back / bl : vec3(0.0)) * min(0.12, bl * 0.5);
  vec4 mv = viewMatrix * vec4(P, 1.0);
  float px = pixelSize(-mv.z);
  float k = clamp(uAge / ${FLARE_LIFE.toFixed(3)}, 0.0, 1.0);
  float size = 0.24 * (0.75 + 0.6 * k);
  float sc = clamp(size, px * 7.0, px * 60.0);
  vDim = mix(1.0, min(1.0, size / sc), 0.5) * camFade(P);
  vQ = position.xy;
  mv.xy += position.xy * sc;
  gl_Position = projectionMatrix * mv;
}
`;

const FLARE_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uAge;
uniform float uMode;
uniform float uSeed;
${HUE}
varying vec2 vQ;
varying float vDim;
void main() {
  float k = uAge / ${FLARE_LIFE.toFixed(3)};
  if (k >= 1.0) discard;
  float fade = (1.0 - k) * (1.0 - k);
  float c = cos(uSeed);
  float s = sin(uSeed);
  vec2 q = mat2(c, -s, s, c) * vQ;
  float r = length(vQ);
  // A four-point star, a white-hot disc and a coloured halo.
  float star = exp(-abs(q.x) * 38.0) * exp(-abs(q.y) * 3.0) + exp(-abs(q.y) * 38.0) * exp(-abs(q.x) * 3.0);
  float disc = exp(-r * r * 22.0);
  float halo = max(0.0, 1.0 - r) * exp(-r * r * 4.0);
  vec3 glow = uMode > 0.5 ? railHue(uSeed * 0.159 + uAge * 3.0) : uGlow;
  vec3 col = vec3(disc * 2.6) + mix(uCore, vec3(1.0), 0.5) * star * 1.5 + glow * halo * 0.8;
  gl_FragColor = vec4(col * fade * vDim, 1.0);
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
  uMode: { value: number };
  uSeed: { value: number };
};

type Slot = {
  core: THREE.Mesh;
  spiral: THREE.Mesh;
  flare: THREE.Mesh;
  spiralGeo: THREE.BufferGeometry;
  coreMat: THREE.ShaderMaterial;
  spiralMat: THREE.ShaderMaterial;
  flareMat: THREE.ShaderMaterial;
  u: Uniforms;
  uU: { value: THREE.Vector3 };
  uV: { value: THREE.Vector3 };
  uStep: { value: number };
  uPhase: { value: number };
  uCore: { value: THREE.Color };
  uGlow: { value: THREE.Color };
  age: number;
  life: number;
  active: boolean;
  impact: boolean;
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

// Helix strip template: x = segment index 0…HELIX_SEGS, y = ±1 across.
function buildHelixAttributes(): { pos: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const n = HELIX_SEGS + 1;
  const pos = new Float32Array(n * 2 * 3);
  const idx = new Uint16Array(HELIX_SEGS * 6); // 6402 verts < 65536
  for (let i = 0; i < n; i++) {
    pos.set([i, -1, 0, i, 1, 0], i * 6);
    if (i < HELIX_SEGS) {
      const a = i * 2;
      idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6);
    }
  }
  return { pos: new THREE.BufferAttribute(pos, 3), index: new THREE.BufferAttribute(idx, 1) };
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpAxis = new THREE.Vector3();

export class RailBeams {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly coreGeo = buildCoreGeometry();
  private readonly flareGeo = new THREE.PlaneGeometry(2, 2);
  private readonly helix = buildHelixAttributes();
  private quality = 1;

  constructor() {
    this.group.name = 'rail-beams';
    this.group.userData.shared = true;
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
      uMode: { value: 0 },
      uSeed: { value: 0 },
    };
    const uCore = { value: new THREE.Color() };
    const uGlow = { value: new THREE.Color() };
    const uU = { value: new THREE.Vector3() };
    const uV = { value: new THREE.Vector3() };
    const uStep = { value: HELIX_STEP };
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
      uniforms: { ...u, uU, uV, uS0: { value: SPIRAL_START }, uStep, uPhase, uColor: uGlow },
      vertexShader: SPIRAL_VERT,
      fragmentShader: SPIRAL_FRAG,
    });
    const flareMat = new THREE.ShaderMaterial({
      ...additive,
      uniforms: { ...u, uCore, uGlow },
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
    });
    // Per-slot geometry sharing the strip template; drawRange = trail length.
    const spiralGeo = new THREE.BufferGeometry();
    spiralGeo.setAttribute('position', this.helix.pos);
    spiralGeo.setIndex(this.helix.index);
    spiralGeo.setDrawRange(0, 0);

    const core = new THREE.Mesh(this.coreGeo, coreMat);
    const spiral = new THREE.Mesh(spiralGeo, spiralMat);
    const flare = new THREE.Mesh(this.flareGeo, flareMat);
    for (const m of [core, spiral, flare]) {
      m.frustumCulled = false;
      m.visible = false;
      m.matrixAutoUpdate = false;
      m.userData.shared = true;
      m.renderOrder = 3;
      m.onBeforeRender = (renderer) => syncViewH(renderer);
      this.group.add(m);
    }
    return {
      core, spiral, flare, spiralGeo, coreMat, spiralMat, flareMat, u, uU, uV, uStep, uPhase, uCore, uGlow,
      age: 0, life: BEAM_LIFE, active: false, impact: false,
    };
  }

  // 1 = full; < 1 coarsens the spiral (low-spec).
  setQuality(q: number) {
    this.quality = q;
  }

  // Start a trail. `own` = the local shooter's beam (fast near-eye clear).
  spawn(origin: THREE.Vector3, end: THREE.Vector3, core: number, glow: number, own: boolean, opts: RailBeamOptions = {}) {
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
    s.impact = !!opts.impact && len > 0.5;
    s.u.uStart.value.copy(origin);
    s.u.uEnd.value.copy(end);
    s.u.uAge.value = 0;
    s.u.uLife.value = s.life;
    s.u.uOwn.value = own ? 1 : 0;
    s.u.uMode.value = opts.mode === 'spectrum' ? 1 : 0;
    s.u.uSeed.value = Math.random() * Math.PI * 2;
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
    const step = Math.max(HELIX_STEP / Math.max(0.35, this.quality), span / HELIX_SEGS);
    const segs = Math.min(HELIX_SEGS, Math.ceil(span / step));
    s.uStep.value = step;
    s.spiralGeo.setDrawRange(0, segs * 6);
    s.core.visible = len > 1e-3;
    s.spiral.visible = segs > 0;
    s.flare.visible = s.impact;
  }

  step(dt: number) {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        s.core.visible = false;
        s.spiral.visible = false;
        s.flare.visible = false;
        continue;
      }
      if (s.flare.visible && s.age >= FLARE_LIFE) s.flare.visible = false;
      s.u.uAge.value = s.age;
    }
  }

  clear() {
    for (const s of this.slots) {
      s.active = false;
      s.core.visible = false;
      s.spiral.visible = false;
      s.flare.visible = false;
    }
  }

  dispose() {
    this.clear();
    for (const s of this.slots) {
      s.coreMat.dispose();
      s.spiralMat.dispose();
      s.flareMat.dispose();
      s.spiralGeo.dispose();
    }
    this.coreGeo.dispose();
    this.flareGeo.dispose();
    this.group.removeFromParent();
    this.group.clear();
    this.slots.length = 0;
  }
}
