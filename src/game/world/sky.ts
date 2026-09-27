import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// Procedural sky dome, one shader with a compile-time mode per theme:
//   lab       clean vertical gradient (the old look)
//   dusk      horizon → mid → zenith gradient, sun disc + glow, streak clouds
//   space     black-violet void, fbm nebula with dust lanes, two star layers
//   night     navy gradient, sodium light-pollution glow on the horizon, stars
//   interior  flat colour (never seen behind a ceiling; costs nothing)
//
// Colours are DISPLAY values (what the canvas should show). The shader writes
// them raw; when the post chain is active (OutputPass re-applies ACES + sRGB)
// uInvTonemap=1 pre-applies the exact inverse so the dome lands on the same
// on-screen values either way. Everything is clamped ≤ 0.9 display so only
// the dusk sun disc reaches the bloom threshold — stars and nebula never do.
// uDetail=0 (low-spec) drops the fbm octaves (nebula, clouds).
// ─────────────────────────────────────────────────────────────────────────

export type SkyMode = 'lab' | 'dusk' | 'space' | 'night' | 'interior';

export type SkyParams = {
  mode: SkyMode;
  top: number; // zenith
  horizon: number;
  mid?: number; // dusk: band above the horizon
  ground?: number; // below the horizon
  sunColor?: number;
  sunSize?: number; // disc angular radius, radians
  sunGlow?: number;
  band?: number; // dusk: how high (sin elevation) the warm band reaches
  nebula?: [number, number, number];
  stars?: number; // 0..1 density/brightness
  glow?: number; // night: horizon light-pollution colour
};

const MODE_ID: Record<SkyMode, number> = { lab: 0, dusk: 1, space: 2, night: 3, interior: 4 };

// three.js ACESFilmicToneMapping fit matrices (tonemapping_pars_fragment),
// written row-major; Matrix3 uploads column-major exactly like the GLSL mat3
// constructors. Inverted once so the dome can undo the tone map.
const ACES_INPUT = new THREE.Matrix3().set(
  0.59719, 0.35458, 0.04823,
  0.07600, 0.90834, 0.01566,
  0.02840, 0.13383, 0.83777,
);
const ACES_OUTPUT = new THREE.Matrix3().set(
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
);
const ACES_INPUT_INV = ACES_INPUT.clone().invert();
const ACES_OUTPUT_INV = ACES_OUTPUT.clone().invert();

export type SkyUniforms = {
  uTop: { value: THREE.Color };
  uMid: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGround: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
  uGlow: { value: THREE.Color };
  uNebA: { value: THREE.Color };
  uNebB: { value: THREE.Color };
  uNebC: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunSize: { value: number };
  uSunGlow: { value: number };
  uBand: { value: number };
  uStars: { value: number };
  uDetail: { value: number };
  uInvTonemap: { value: number };
  uExposure: { value: number };
  uInvIn: { value: THREE.Matrix3 };
  uInvOut: { value: THREE.Matrix3 };
};

const display = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

const VERT = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uGlow;
uniform vec3 uNebA;
uniform vec3 uNebB;
uniform vec3 uNebC;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uSunGlow;
uniform float uBand;
uniform float uStars;
uniform float uDetail;
uniform float uInvTonemap;
uniform float uExposure;
uniform mat3 uInvIn;
uniform mat3 uInvOut;
varying vec3 vWorldPosition;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    if (float(i) >= 2.0 + uDetail * 3.0) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

vec3 starLayer(vec3 d, float scale, float density, float size) {
  vec3 p = d * scale;
  vec3 c = floor(p);
  float h = hash13(c);
  if (h < 1.0 - density) return vec3(0.0);
  vec3 j = vec3(hash13(c + 1.7), hash13(c + 4.3), hash13(c + 7.1)) - 0.5;
  float dist = length(p - (c + 0.5 + j * 0.5));
  float b = hash13(c + 9.1);
  float s = smoothstep(size, 0.0, dist) * (0.25 + 0.75 * b * b * b);
  vec3 col = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.88, 0.72), hash13(c + 3.3));
  return col * s;
}

void main() {
  vec3 d = normalize(vWorldPosition);
  float h = d.y;
  vec3 col;

#if SKY_MODE == 0
  float t = pow(max(h + 0.06, 0.0) / 1.06, 0.7);
  col = mix(uHorizon, uTop, t);
#elif SKY_MODE == 1
  if (h < 0.0) {
    col = mix(uHorizon, uGround, smoothstep(0.0, -0.18, h));
  } else {
    col = mix(uHorizon, uMid, smoothstep(0.0, uBand, h));
    col = mix(col, uTop, smoothstep(uBand * 0.55, uBand * 3.4, h));
  }
  float sd = max(dot(d, uSunDir), 0.0);
  // wide warm scatter + tighter halo + the disc itself
  col += uSunColor * (pow(sd, 6.0) * 0.22 * uSunGlow + pow(sd, 48.0) * 0.35 * uSunGlow);
  float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.7), sd);
  col = mix(col, uSunColor, disc);
  if (uDetail > 0.5 && h > 0.0) {
    vec2 q = d.xz / (h + 0.12);
    float c = fbm(vec3(q.x * 0.35, q.y * 1.4, 0.0));
    float band = smoothstep(0.52, 0.78, c) * smoothstep(0.02, 0.16, h) * (1.0 - smoothstep(0.35, 0.7, h));
    vec3 cloud = mix(uMid * 0.55, uSunColor * 0.9, pow(sd, 3.0));
    col = mix(col, cloud, band * 0.6);
  }
#elif SKY_MODE == 2
  col = mix(uHorizon, uTop, smoothstep(-0.3, 0.9, h));
  if (uDetail > 0.5) {
    vec3 q = d * 1.6 + vec3(3.1, 0.0, 1.7);
    float n1 = fbm(q);
    float n2 = fbm(d * 3.4 + vec3(n1 * 1.8, 2.0, 5.0));
    float neb = smoothstep(0.42, 0.8, n1);
    vec3 nc = mix(uNebA, uNebB, smoothstep(0.3, 0.7, n2));
    col += nc * neb * 0.9;
    col += uNebC * pow(smoothstep(0.5, 0.85, n2), 2.0) * neb * 0.7;
    float dust = smoothstep(0.5, 0.75, fbm(d * 7.0 + 11.0));
    col *= 1.0 - 0.6 * dust * neb;
  } else {
    col += uNebA * 0.12 * smoothstep(0.2, 0.9, 1.0 - abs(h));
  }
  col += starLayer(d, 260.0, 0.06 * uStars, 0.45) * 0.85;
  col += starLayer(d, 90.0, 0.03 * uStars, 0.32) * 0.9;
#elif SKY_MODE == 3
  col = mix(uHorizon, uTop, smoothstep(-0.05, 0.6, h));
  col += uGlow * exp(-max(h, 0.0) * 9.0) * 0.9;
  if (h < 0.0) col = mix(col, uHorizon * 0.6, smoothstep(0.0, -0.2, h));
  col += starLayer(d, 240.0, 0.035 * uStars, 0.4) * 0.7 * smoothstep(0.05, 0.4, h);
#else
  col = uTop;
#endif

  col = clamp(col, 0.0, 0.9);
  if (uInvTonemap > 0.5) {
    vec3 lin = mix(
      pow(col * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
      col * 0.0773993808,
      vec3(lessThanEqual(col, vec3(0.04045))));
    vec3 y = clamp(uInvOut * lin, 0.0, 0.999);
    // inverse of three's RRTAndODTFit (positive root)
    const float a = 0.0245786;
    const float b = 0.000090537;
    const float c = 0.983729;
    const float dd = 0.4329510;
    const float e = 0.238081;
    vec3 A = 1.0 - c * y;
    vec3 B = a - dd * y;
    vec3 C = -(b + e * y);
    vec3 x = (-B + sqrt(max(B * B - 4.0 * A * C, vec3(0.0)))) / (2.0 * A);
    col = max(uInvIn * x, vec3(0.0)) * (0.6 / uExposure);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSkyMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(500, 32, 15);
  const uniforms: SkyUniforms = {
    uTop: { value: display(0x2f6fb8) },
    uMid: { value: display(0x6a8ab8) },
    uHorizon: { value: display(0xc8dcec) },
    uGround: { value: display(0x606870) },
    uSunColor: { value: display(0xfff0d0) },
    uGlow: { value: display(0x000000) },
    uNebA: { value: display(0x5a2a9c) },
    uNebB: { value: display(0x1f4c9a) },
    uNebC: { value: display(0xb03c86) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uSunSize: { value: 0.035 },
    uSunGlow: { value: 1 },
    uBand: { value: 0.22 },
    uStars: { value: 0 },
    uDetail: { value: 1 },
    uInvTonemap: { value: 0 },
    uExposure: { value: 1 },
    uInvIn: { value: ACES_INPUT_INV },
    uInvOut: { value: ACES_OUTPUT_INV },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    defines: { SKY_MODE: 0 },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  // Directions are taken from the camera, so the dome reads as infinitely
  // far; it always covers part of the view, so skip the cull test.
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

export function applySky(sky: THREE.Mesh, p: SkyParams, sunDir: THREE.Vector3): void {
  const mat = sky.material as THREE.ShaderMaterial;
  const u = mat.uniforms as SkyUniforms;
  const mode = MODE_ID[p.mode];
  if (mat.defines.SKY_MODE !== mode) {
    mat.defines.SKY_MODE = mode;
    mat.needsUpdate = true;
  }
  u.uTop.value.setHex(p.top, THREE.LinearSRGBColorSpace);
  u.uHorizon.value.setHex(p.horizon, THREE.LinearSRGBColorSpace);
  u.uMid.value.setHex(p.mid ?? p.horizon, THREE.LinearSRGBColorSpace);
  u.uGround.value.setHex(p.ground ?? p.horizon, THREE.LinearSRGBColorSpace);
  u.uSunColor.value.setHex(p.sunColor ?? 0xfff0d0, THREE.LinearSRGBColorSpace);
  u.uGlow.value.setHex(p.glow ?? 0, THREE.LinearSRGBColorSpace);
  const neb = p.nebula ?? [0, 0, 0];
  u.uNebA.value.setHex(neb[0], THREE.LinearSRGBColorSpace);
  u.uNebB.value.setHex(neb[1], THREE.LinearSRGBColorSpace);
  u.uNebC.value.setHex(neb[2], THREE.LinearSRGBColorSpace);
  u.uSunDir.value.copy(sunDir).normalize();
  u.uSunSize.value = p.sunSize ?? 0.035;
  u.uSunGlow.value = p.sunGlow ?? 1;
  u.uBand.value = p.band ?? 0.22;
  u.uStars.value = p.stars ?? 0;
}

export function setSkyDetail(sky: THREE.Mesh, high: boolean): void {
  const u = (sky.material as THREE.ShaderMaterial).uniforms as SkyUniforms;
  u.uDetail.value = high ? 1 : 0;
}

// Display colour (sRGB hex) → the linear scene radiance that ACES + exposure
// maps back onto it — so fog can fade distant walls into the sky's horizon.
export function displayToScene(hex: number, exposure: number, out: THREE.Color): THREE.Color {
  const srgb = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((v) => Math.min(v, 0.9));
  const lin = srgb.map((v) => (v <= 0.04045 ? v * 0.0773993808 : Math.pow(v * 0.9478672986 + 0.0521327014, 2.4)));
  const vo = new THREE.Vector3(lin[0], lin[1], lin[2]).applyMatrix3(ACES_OUTPUT_INV);
  const inv = (y: number) => {
    const yc = Math.min(0.999, Math.max(0, y));
    const A = 1 - 0.983729 * yc;
    const B = 0.0245786 - 0.432951 * yc;
    const C = -(0.000090537 + 0.238081 * yc);
    return (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A);
  };
  const x = new THREE.Vector3(inv(vo.x), inv(vo.y), inv(vo.z)).applyMatrix3(ACES_INPUT_INV);
  const k = 0.6 / exposure;
  return out.setRGB(Math.max(0, x.x) * k, Math.max(0, x.y) * k, Math.max(0, x.z) * k, THREE.LinearSRGBColorSpace);
}
