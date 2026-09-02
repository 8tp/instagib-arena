import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { FOV_DEG } from './constants';
import type { ArenaMap } from './map';

// ─────────────────────────────────────────────────────────────────────────
// Tuning. All bloom numbers are in LINEAR scene radiance (the composer's
// HalfFloat buffer, before ACES). Reference points estimated from the scene's
// materials + lights (peak channel):
//   lit arena walls/floor            0.3–0.8  (worst case ~1.3: brightest
//                                             platform texels, map brightness
//                                             maxed, glancing sun)
//   sky dome                         ≤ 0.4    (pre-inverted, see createSky)
//   railgun glow at rest (1.3×)      ~1.5
//   enemy-highlight emissive         ~1.6–1.8
//   rail beam core (double-sided
//     additive cylinder over a wall)  ~2.0–2.5
//   railgun glow on fire (4.5–5.5×)  ~4+
//   kill-burst / muzzle additive
//     stacks                          2–6
// So nothing static crosses 1.5, everything meant to glow does, and the knee
// ramps 1.5 → 2.5 so borderline pixels get a whisper rather than a switch.
// ─────────────────────────────────────────────────────────────────────────
export const BLOOM_TUNING = {
  threshold: 1.5,
  knee: 1.0, // smoothstep width above threshold
  strength: 0.5,
  radius: 0.35, // 0 = tight halo, 1 = wide wash
};

export const SHADOW_TUNING = {
  boxSize: 56, // metres; ortho shadow frustum edge, centred ahead of the camera
  mapSize: 2048, // normal tier (→ 2.7 cm texels)
  mapSizeLow: 1024, // resolutionScale < 0.75
  lightDistance: 80, // sun sits this far up its own direction from the box centre
  forwardBias: 10, // box centre pushed this far along the view so cover is ahead
  bias: -0.0003,
  normalBias: 0.04, // world units; kills acne on the box-built maps' flat faces
  // With shadows on, the sun needs presence (lit vs shade) and the hemisphere
  // lifts the shaded side. Off (low-spec / ReplayViewer) keeps today's look.
  sunIntensity: 1.8,
  hemiIntensity: 0.5,
  sunIntensityUnshadowed: 1.5,
  hemiIntensityUnshadowed: 0.7,
};

export const VIGNETTE_TUNING = {
  offset: 0.65, // ~21% darker at the extreme corners, ~10% at the edge midpoints
  darkness: 0.6,
};

export const SUN_DIRECTION = new THREE.Vector3(20, 40, 12).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // powerPreference asks hybrid-graphics laptops for the discrete GPU instead of
  // the integrated one — a free win for a GPU-bound game on the machines a lot of
  // players are on.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Filmic tone mapping + a touch of exposure so the arena reads bright and
  // punchy instead of the old flat, murky look. With the post chain active the
  // same curve/exposure is applied once, by OutputPass, instead of per material.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  return renderer;
}

export function createCamera(canvas: HTMLCanvasElement): THREE.PerspectiveCamera {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const cam = new THREE.PerspectiveCamera(FOV_DEG, w / h, 0.1, 1000);
  return cam;
}

// three.js ACESFilmicToneMapping fit matrices (tonemapping_pars_fragment),
// written row-major here; Matrix3 uploads column-major exactly like the GLSL
// mat3 constructors in that chunk. Inverted once so the sky dome can undo the
// tone map (see createSky).
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

type SkyUniforms = {
  topColor: { value: THREE.Color };
  bottomColor: { value: THREE.Color };
  offset: { value: number };
  exponent: { value: number };
  uInvTonemap: { value: number };
  uExposure: { value: number };
  uInvIn: { value: THREE.Matrix3 };
  uInvOut: { value: THREE.Matrix3 };
};

// Classic three.js vertical-gradient sky dome (sky-blue zenith → pale horizon).
//
// The shader writes its gradient raw — no tone map, no sRGB encode — which is
// what the arena's look was tuned against when rendering straight to the
// canvas. Under the post chain every pixel goes through OutputPass (ACES +
// sRGB) instead, which would lift this deep blue to a pale sky. With
// uInvTonemap=1 the shader pre-applies the exact inverse (sRGB EOTF → inverse
// ACES output matrix → inverse RRT/ODT fit → inverse input matrix → ÷ exposure)
// so the dome lands on the same on-screen values either way, and its
// pre-inverted radiance (≤ ~0.4) sits far below the bloom threshold.
function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(500, 32, 15);
  const uniforms: SkyUniforms = {
    topColor: { value: new THREE.Color(0x4a86c8) },
    bottomColor: { value: new THREE.Color(0xdce9f4) },
    offset: { value: 30 },
    exponent: { value: 0.7 },
    uInvTonemap: { value: 0 },
    uExposure: { value: 1.15 },
    uInvIn: { value: ACES_INPUT_INV },
    uInvOut: { value: ACES_OUTPUT_INV },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      uniform float uInvTonemap;
      uniform float uExposure;
      uniform mat3 uInvIn;
      uniform mat3 uInvOut;
      varying vec3 vWorldPosition;

      // Inverse of three's RRTAndODTFit: y = (x(x+a) - b) / (x(cx+d) + e)
      // → (1 - cy) x² + (a - dy) x - (b + ey) = 0, positive root.
      vec3 invRRTAndODTFit(vec3 y) {
        const float a = 0.0245786;
        const float b = 0.000090537;
        const float c = 0.983729;
        const float d = 0.4329510;
        const float e = 0.238081;
        vec3 A = 1.0 - c * y;
        vec3 B = a - d * y;
        vec3 C = -(b + e * y);
        return (-B + sqrt(max(B * B - 4.0 * A * C, vec3(0.0)))) / (2.0 * A);
      }

      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        vec3 col = mix(bottomColor, topColor, t);
        if (uInvTonemap > 0.5) {
          // sRGB EOTF (what the canvas shows for the raw write) ...
          vec3 lin = mix(
            pow(col * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
            col * 0.0773993808,
            vec3(lessThanEqual(col, vec3(0.04045))));
          // ... then undo ACESFilmicToneMapping so OutputPass re-creates it.
          vec3 y = clamp(uInvOut * lin, 0.0, 1.0);
          vec3 x = invRRTAndODTFit(y);
          col = max(uInvIn * x, vec3(0.0)) * (0.6 / uExposure);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  return sky;
}

export type ArenaLighting = {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  sky: THREE.Mesh;
};
const lightingByScene = new WeakMap<THREE.Scene, ArenaLighting>();

export function getArenaLighting(scene: THREE.Scene): ArenaLighting | undefined {
  return lightingByScene.get(scene);
}

export function createScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc0dd);
  // Light haze that fades distant geometry into the horizon colour. Far enough
  // not to murk up small duel maps.
  scene.fog = new THREE.Fog(0xb6cadb, 90, 280);

  const sky = createSky();
  scene.add(sky);

  // Soft image-based fill so PBR surfaces look lit-from-everywhere and bright.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // RoomEnvironment fill was ~equal to the sun; dim it so shadows read (critic r1).
  scene.environmentIntensity = 0.4;
  pmrem.dispose();

  // Sky/ground hemisphere + a warm key "sun" + a cool fill. Brighter than the
  // old setup so the arena isn't murky. Intensities here are the unshadowed
  // look; PostFxPipeline lifts sun/hemi when it turns shadows on.
  const hemi = new THREE.HemisphereLight(0xcfe2f2, 0x7d8088, SHADOW_TUNING.hemiIntensityUnshadowed);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, SHADOW_TUNING.sunIntensityUnshadowed);
  sun.position.set(20, 40, 12);
  scene.add(sun);
  // Shadow rig is configured but inert (castShadow=false) until the pipeline
  // arms it — ReplayViewer shares this scene builder and stays shadow-free.
  const half = SHADOW_TUNING.boxSize / 2;
  const sc = sun.shadow.camera;
  sc.left = -half;
  sc.right = half;
  sc.top = half;
  sc.bottom = -half;
  sc.near = 1;
  sc.far = SHADOW_TUNING.lightDistance * 2;
  sc.updateProjectionMatrix();
  sun.shadow.mapSize.set(SHADOW_TUNING.mapSize, SHADOW_TUNING.mapSize);
  sun.shadow.bias = SHADOW_TUNING.bias;
  sun.shadow.normalBias = SHADOW_TUNING.normalBias;
  // The target must live in the graph so its world matrix updates when the
  // pipeline slides it under the camera each frame.
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0x88a6ff, 0.35);
  fill.position.set(-15, 18, -12);
  scene.add(fill);

  lightingByScene.set(scene, { sun, hemi, fill, sky });
  return scene;
}

// Shadow flags for a freshly built arena mesh: every box casts and receives,
// except a drawn ceiling (closed maps, boxes[1]) — it sits between the sun and
// the whole arena and would black it out.
export function applyMapShadowFlags(group: THREE.Object3D, map: ArenaMap): void {
  const ceil = map.openTop ? null : map.boxes[1];
  const cx = ceil ? (ceil.min.x + ceil.max.x) / 2 : 0;
  const cy = ceil ? (ceil.min.y + ceil.max.y) / 2 : 0;
  const cz = ceil ? (ceil.min.z + ceil.max.z) / 2 : 0;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const p = mesh.position;
    const isCeiling =
      !!ceil &&
      Math.abs(p.x - cx) < 1e-3 &&
      Math.abs(p.y - cy) < 1e-3 &&
      Math.abs(p.z - cz) < 1e-3;
    mesh.castShadow = !isCeiling;
    mesh.receiveShadow = true;
  });
}

export type PostFxOptions = {
  bloom: boolean;
  shadows: boolean;
  aa: boolean;
  vignette: boolean;
};

// UnrealBloomPass with the high-pass keyed on the brightest channel instead of
// luminance. Luminance under-weights saturated reds/blues (a red rail core at
// linear 2.4 has luminance ~0.6 and would never glow while a cyan one does);
// the peak channel makes the glow colour-neutral. The knee is widened so the
// transition is a ramp rather than a hard switch.
class ArenaBloomPass extends UnrealBloomPass {
  constructor(
    resolution: THREE.Vector2,
    strength: number,
    radius: number,
    threshold: number,
    knee: number,
  ) {
    super(resolution, strength, radius, threshold);
    const hp = this.materialHighPassFilter;
    const stock = 'float v = luminance( texel.xyz );';
    if (hp.fragmentShader.includes(stock)) {
      hp.fragmentShader = hp.fragmentShader.replace(
        stock,
        'float v = max( texel.r, max( texel.g, texel.b ) );',
      );
      hp.needsUpdate = true;
    }
    const uniforms = this.highPassUniforms as Record<string, { value: unknown }>;
    if (uniforms.smoothWidth) uniforms.smoothWidth.value = knee;
  }
}

// Post chain + shadow rig for the arena renderer.
//
//   RenderPass (HalfFloat, linear HDR) → bloom → OutputPass (ACES 1.15 + sRGB)
//   → vignette → SMAA → canvas
//
// Any pass off = pass disabled; all off = the composer is skipped entirely and
// the frame renders straight to the canvas exactly as before this existed. If
// the composer fails to build, the same direct path is used. Shadows are
// independent of the composer: shadowMap is armed once, and on/off is the sun's
// castShadow (which re-keys the lights hash, so materials recompile on their
// own — no needsUpdate sweep).
export class PostFxPipeline {
  private composer: EffectComposer | null = null;
  private bloomPass: ArenaBloomPass | null = null;
  private vignettePass: ShaderPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private opts: PostFxOptions = { bloom: false, shadows: false, aa: false, vignette: false };
  private vignetteMuted = false;
  private readonly lighting: ArenaLighting | null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private shadowMapSize = SHADOW_TUNING.mapSize;
  // Light-space basis (matches the shadow camera's lookAt) for texel snapping.
  private readonly lightU = new THREE.Vector3();
  private readonly lightV = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly tmpTarget = new THREE.Vector3();
  private readonly tmpCamPos = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    this.lighting = getArenaLighting(scene) ?? null;
    renderer.shadowMap.enabled = true; // inert until a light casts
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const basis = new THREE.Matrix4().lookAt(SUN_DIRECTION, ORIGIN, UP);
    basis.extractBasis(this.lightU, this.lightV, this.tmpFwd);
    const size = renderer.getSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    this.pixelRatio = renderer.getPixelRatio();
    try {
      this.buildComposer();
    } catch (err) {
      console.warn('[postfx] composer init failed — rendering direct', err);
      this.disposeComposer();
    }
  }

  private buildComposer() {
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new ArenaBloomPass(
      new THREE.Vector2(this.width * this.pixelRatio, this.height * this.pixelRatio),
      BLOOM_TUNING.strength,
      BLOOM_TUNING.radius,
      BLOOM_TUNING.threshold,
      BLOOM_TUNING.knee,
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    const vignette = new ShaderPass(VignetteShader);
    vignette.uniforms.offset.value = VIGNETTE_TUNING.offset;
    vignette.uniforms.darkness.value = VIGNETTE_TUNING.darkness;
    composer.addPass(vignette);
    const smaa = new SMAAPass();
    composer.addPass(smaa);
    this.composer = composer;
    this.bloomPass = bloom;
    this.vignettePass = vignette;
    this.smaaPass = smaa;
    this.applyPassFlags();
  }

  get options(): Readonly<PostFxOptions> {
    return this.opts;
  }

  setOptions(opts: Partial<PostFxOptions>) {
    this.opts = { ...this.opts, ...opts };
    this.applyPassFlags();
    this.applyShadows();
  }

  // Accessibility hook: reduced-effects drops the vignette (a static screen-edge
  // darkening some players find fatiguing) without touching the stored prefs.
  muteVignette(muted: boolean) {
    if (muted === this.vignetteMuted) return;
    this.vignetteMuted = muted;
    this.applyPassFlags();
  }

  setShadowMapSize(size: number) {
    if (size === this.shadowMapSize) return;
    this.shadowMapSize = size;
    const sun = this.lighting?.sun;
    if (!sun) return;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }

  // CSS-pixel size + device pixel ratio, mirrored from the renderer so the
  // composer's buffers track resolution scale / DPI / window exactly.
  setSize(width: number, height: number) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.composer?.setSize(w, h);
  }

  setPixelRatio(pr: number) {
    if (pr === this.pixelRatio) return;
    this.pixelRatio = pr;
    this.composer?.setPixelRatio(pr);
  }

  private get usingComposer(): boolean {
    return (
      this.composer !== null &&
      (this.opts.bloom || this.opts.aa || (this.opts.vignette && !this.vignetteMuted))
    );
  }

  render() {
    this.updateShadowFollow();
    const sky = this.lighting?.sky;
    const composed = this.usingComposer;
    if (sky) {
      const u = (sky.material as THREE.ShaderMaterial).uniforms as SkyUniforms;
      u.uInvTonemap.value = composed ? 1 : 0;
      u.uExposure.value = this.renderer.toneMappingExposure;
    }
    if (composed && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposeComposer();
    const sun = this.lighting?.sun;
    if (sun) {
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }

  private disposeComposer() {
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.vignettePass = null;
    this.smaaPass = null;
  }

  private applyPassFlags() {
    if (this.bloomPass) this.bloomPass.enabled = this.opts.bloom;
    if (this.smaaPass) this.smaaPass.enabled = this.opts.aa;
    if (this.vignettePass) this.vignettePass.enabled = this.opts.vignette && !this.vignetteMuted;
  }

  private applyShadows() {
    const l = this.lighting;
    if (!l) return;
    const on = this.opts.shadows;
    if (l.sun.castShadow === on) return;
    l.sun.castShadow = on;
    l.sun.intensity = on ? SHADOW_TUNING.sunIntensity : SHADOW_TUNING.sunIntensityUnshadowed;
    l.hemi.intensity = on ? SHADOW_TUNING.hemiIntensity : SHADOW_TUNING.hemiIntensityUnshadowed;
    if (!on) {
      l.sun.shadow.map?.dispose();
      l.sun.shadow.map = null;
    }
  }

  // Slide the sun's ortho shadow box with the camera (biased ahead along the
  // view), snapping the centre to whole shadow texels in light space so the
  // shadow edges don't shimmer as the player moves. Moving the light and its
  // target together keeps the sun DIRECTION fixed, so lighting is unchanged.
  private updateShadowFollow() {
    const l = this.lighting;
    if (!l || !l.sun.castShadow) return;
    const cam = this.camera;
    cam.getWorldPosition(this.tmpCamPos);
    cam.getWorldDirection(this.tmpFwd);
    this.tmpFwd.y = 0;
    const fl = this.tmpFwd.length();
    const target = this.tmpTarget.copy(this.tmpCamPos);
    if (fl > 1e-4) target.addScaledVector(this.tmpFwd, SHADOW_TUNING.forwardBias / fl);
    const texel = SHADOW_TUNING.boxSize / this.shadowMapSize;
    const du = target.dot(this.lightU);
    const dv = target.dot(this.lightV);
    target.addScaledVector(this.lightU, Math.round(du / texel) * texel - du);
    target.addScaledVector(this.lightV, Math.round(dv / texel) * texel - dv);
    l.sun.target.position.copy(target);
    l.sun.position.copy(target).addScaledVector(SUN_DIRECTION, SHADOW_TUNING.lightDistance);
  }
}
