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
import { applySky, createSkyMesh, setSkyDetail, type SkyParams, type SkyUniforms } from './world/sky';

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

export type ArenaLighting = {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  sky: THREE.Mesh;
  // Unit vector toward the sun (the world theme sets it; the shadow rig and
  // the baked map shading both follow it). `version` bumps on every change.
  sunDir: THREE.Vector3;
  version: number;
  // Theme-owned light levels (null → the SHADOW_TUNING defaults, which lift
  // the sun and dim the hemisphere when realtime shadows turn on).
  tuning: { sun: number; hemi: number } | null;
  lowDetail: boolean;
  shadowBox: number; // current ortho shadow box edge (metres)
};
const lightingByScene = new WeakMap<THREE.Scene, ArenaLighting>();
const rendererByScene = new WeakMap<THREE.Scene, THREE.WebGLRenderer>();

export function getArenaLighting(scene: THREE.Scene): ArenaLighting | undefined {
  return lightingByScene.get(scene);
}

// Per-map atmosphere: everything about a world theme that lives on the scene
// rather than on the map's materials. Produced by map.ts buildMapMesh
// (group.userData.atmosphere) and applied automatically when that group is
// added to a scene built by createScene().
export type WorldAtmosphere = {
  id: string;
  exposure: number;
  background: number;
  fog: { color: number; near: number; far: number };
  sky: SkyParams;
  sun: { dir: [number, number, number]; color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  fill: { dir: [number, number, number]; color: number; intensity: number };
  envIntensity: number;
  shadowBox?: number; // sun shadow box edge; small arenas + low suns want a tighter box (sharper texels)
};

// The pre-theme look (also what a scene shows before any map is added).
const DEFAULT_ATMOSPHERE: WorldAtmosphere = {
  id: 'default',
  exposure: 0.95,
  background: 0x9fc0dd,
  fog: { color: 0xb6cadb, near: 90, far: 280 },
  sky: { mode: 'lab', top: 0x2f6fb8, horizon: 0xc8dcec },
  sun: {
    dir: [SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z],
    color: 0xfff2d8,
    intensity: SHADOW_TUNING.sunIntensityUnshadowed,
  },
  hemi: { sky: 0xcfe2f2, ground: 0x7d8088, intensity: SHADOW_TUNING.hemiIntensityUnshadowed },
  fill: { dir: [-0.575, 0.69, -0.46], color: 0x88a6ff, intensity: 0.35 },
  envIntensity: 0.4,
};

export function createScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DEFAULT_ATMOSPHERE.background);
  scene.fog = new THREE.Fog(DEFAULT_ATMOSPHERE.fog.color, DEFAULT_ATMOSPHERE.fog.near, DEFAULT_ATMOSPHERE.fog.far);

  const sky = createSkyMesh();
  scene.add(sky);

  // Image-based fill for the PBR surfaces + players. The world's own share of
  // it is scaled per theme inside the lightmapped map material.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = DEFAULT_ATMOSPHERE.envIntensity;
  pmrem.dispose();

  // Sky/ground hemisphere + a key "sun" + a fill. The map's static lighting
  // is baked (world/lightmap.ts); these light players, bots and the
  // viewmodel, and add normal-mapped direct light to the world at a
  // per-theme fraction. Order matters: the map material treats directional
  // light 0 as the sun and 1 as the fill (add sun before fill).
  const hemi = new THREE.HemisphereLight(0xcfe2f2, 0x7d8088, SHADOW_TUNING.hemiIntensityUnshadowed);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, SHADOW_TUNING.sunIntensityUnshadowed);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(SHADOW_TUNING.lightDistance);
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

  lightingByScene.set(scene, {
    sun,
    hemi,
    fill,
    sky,
    sunDir: SUN_DIRECTION.clone(),
    version: 0,
    tuning: null,
    lowDetail: false,
    shadowBox: SHADOW_TUNING.boxSize,
  });
  rendererByScene.set(scene, renderer);
  applyWorldAtmosphere(scene, DEFAULT_ATMOSPHERE);
  return scene;
}

// Apply a world theme's atmosphere to a createScene() scene: fog, sky dome,
// dynamic light colours/intensities/direction, IBL level and exposure.
export function applyWorldAtmosphere(scene: THREE.Scene, atm: WorldAtmosphere): void {
  if (scene.background instanceof THREE.Color) scene.background.setHex(atm.background);
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.setHex(atm.fog.color);
    scene.fog.near = atm.fog.near;
    scene.fog.far = atm.fog.far;
  }
  scene.environmentIntensity = atm.envIntensity;
  const renderer = rendererByScene.get(scene);
  if (renderer) renderer.toneMappingExposure = atm.exposure;
  const l = lightingByScene.get(scene);
  if (!l) return;
  l.tuning = atm.id === DEFAULT_ATMOSPHERE.id ? null : { sun: atm.sun.intensity, hemi: atm.hemi.intensity };
  l.sunDir.set(atm.sun.dir[0], atm.sun.dir[1], atm.sun.dir[2]).normalize();
  l.version++;
  l.sun.color.setHex(atm.sun.color);
  l.hemi.color.setHex(atm.hemi.sky);
  l.hemi.groundColor.setHex(atm.hemi.ground);
  applyLightLevels(l);
  l.sun.position.copy(l.sun.target.position).addScaledVector(l.sunDir, SHADOW_TUNING.lightDistance);
  l.fill.color.setHex(atm.fill.color);
  l.fill.intensity = atm.fill.intensity;
  l.fill.position.set(atm.fill.dir[0], atm.fill.dir[1], atm.fill.dir[2]).multiplyScalar(30);
  const box = atm.shadowBox ?? SHADOW_TUNING.boxSize;
  if (box !== l.shadowBox) {
    l.shadowBox = box;
    const sc = l.sun.shadow.camera;
    sc.left = -box / 2;
    sc.right = box / 2;
    sc.top = box / 2;
    sc.bottom = -box / 2;
    sc.updateProjectionMatrix();
  }
  applySky(l.sky, atm.sky, l.sunDir);
  setSkyDetail(l.sky, !l.lowDetail);
}

// Sun + hemisphere levels for the current shadow state: theme-owned when a
// world theme is active (the bake already carries the map's shadows, so the
// level doesn't change with realtime shadows), else the SHADOW_TUNING pair.
function applyLightLevels(l: ArenaLighting) {
  const on = l.sun.castShadow;
  if (l.tuning) {
    l.sun.intensity = l.tuning.sun;
    l.hemi.intensity = l.tuning.hemi;
  } else {
    l.sun.intensity = on ? SHADOW_TUNING.sunIntensity : SHADOW_TUNING.sunIntensityUnshadowed;
    l.hemi.intensity = on ? SHADOW_TUNING.hemiIntensity : SHADOW_TUNING.hemiIntensityUnshadowed;
  }
}

// Shadow flags for a freshly built arena group: every solid surface casts and
// receives, except a drawn ceiling (it sits between the sun and the whole
// arena and would black it out), the floor (nothing is under it), and
// anything the build tagged noShadow (boundary walls the bake treats as not
// blocking the sun, trim, dressing, fixtures).
export function applyMapShadowFlags(group: THREE.Object3D, _map?: ArenaMap): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const surface = mesh.userData.surface;
    mesh.castShadow = surface !== 'ceiling' && surface !== 'floor' && mesh.userData.noShadow !== true;
    mesh.receiveShadow = mesh.name !== 'map:fixtures' && mesh.name !== 'map:trim';
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
  private readonly basis = new THREE.Matrix4();
  private sunVersion = -1;
  private lowDetailExplicit: boolean | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    this.lighting = getArenaLighting(scene) ?? null;
    renderer.shadowMap.enabled = true; // inert until a light casts
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated in r184 (it fell back to PCF anyway)
    this.syncSunBasis();
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
    // Until the host says otherwise (setWorldQuality), "every post effect
    // off" is the low-spec tier: drop the sky's procedural detail.
    if (this.lowDetailExplicit === null) {
      const o = this.opts;
      this.applyWorldQuality(!o.bloom && !o.shadows && !o.aa && !o.vignette);
    }
  }

  // Low-spec world tier: the sky dome drops its fbm octaves (nebula, clouds).
  // Lightmaps stay (they cost nothing at runtime).
  setWorldQuality(low: boolean) {
    this.lowDetailExplicit = low;
    this.applyWorldQuality(low);
  }

  private applyWorldQuality(low: boolean) {
    const l = this.lighting;
    if (!l || l.lowDetail === low) return;
    l.lowDetail = low;
    setSkyDetail(l.sky, !low);
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
    applyLightLevels(l);
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
    if (l.version !== this.sunVersion) this.syncSunBasis();
    const cam = this.camera;
    cam.getWorldPosition(this.tmpCamPos);
    cam.getWorldDirection(this.tmpFwd);
    this.tmpFwd.y = 0;
    const fl = this.tmpFwd.length();
    const target = this.tmpTarget.copy(this.tmpCamPos);
    if (fl > 1e-4) target.addScaledVector(this.tmpFwd, SHADOW_TUNING.forwardBias / fl);
    const texel = l.shadowBox / this.shadowMapSize;
    const du = target.dot(this.lightU);
    const dv = target.dot(this.lightV);
    target.addScaledVector(this.lightU, Math.round(du / texel) * texel - du);
    target.addScaledVector(this.lightV, Math.round(dv / texel) * texel - dv);
    l.sun.target.position.copy(target);
    l.sun.position.copy(target).addScaledVector(l.sunDir, SHADOW_TUNING.lightDistance);
  }

  // Light-space basis for the texel snap; follows the theme's sun direction.
  private syncSunBasis() {
    const dir = this.lighting?.sunDir ?? SUN_DIRECTION;
    this.basis.lookAt(dir, ORIGIN, UP);
    this.basis.extractBasis(this.lightU, this.lightV, this.tmpFwd);
    this.sunVersion = this.lighting?.version ?? 0;
  }
}
