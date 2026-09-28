import * as THREE from 'three';
import { DecalManager } from './decals';
import { RailBeams } from './fx/rail-beam';
import { lightningPath, RibbonBatch } from './fx/ribbon';

// ─────────────────────────────────────────────────────────────────────────
// Shared, pooled FX primitives — one FxContext per scene.
//
//  • One InstancedMesh per particle SHAPE (one geometry + one additive
//    material each). A burst only fills instance slots, so a kill effect costs
//    zero geometry/material allocations and draws in as many draw calls as it
//    touches shapes (2-3; the old per-particle meshes were 15-30 draw calls).
//  • Additive blending makes "opacity" and "scale the colour" identical, so the
//    per-instance fade is baked into instanceColor — no per-instance alpha.
//    Colours are linear and deliberately exceed 1.0 on hot cores so a
//    threshold bloom pass picks them out. All materials are toneMapped:false.
//  • Motion is evaluated in closed form each frame (p0 + v·t − ½g·t², s0·e^kt),
//    so the look is identical at any frame rate; dt is clamped.
//  • A pool of camera-facing sprites (energy flashes, shock rings, muzzle and
//    impact stars), two PointLights that pulse (kept in the scene permanently
//    while enabled so toggling them never recompiles the lit materials; slot 1
//    is shared by impacts + kills), the impact-decal ring buffer and the rail
//    trails (fx/rail-beam.ts) live here too, so weapon.ts and effects.ts share
//    one budget. Nothing is visible when idle: sprites/meshes hide at count 0
//    and the lights sit at intensity 0.
//
// Everything in the context is tagged `userData.shared` so Game.disposeScene()
// leaves it alone; `disposeFxContext(scene)` releases it explicitly.
// ─────────────────────────────────────────────────────────────────────────

// (Flashes are camera-facing glow sprites — see SpritePool — not solid spheres.)
//
// Finisher shapes (death animations): `cube` = solid lit voxel with glowing
// edges, `flake` = solid double-sided quad (confetti, ash), `shard` = glassy
// additive crystal with fresnel + facet glints, `mote` / `glint` = additive
// camera-facing billboards (soft glow / star) — one draw call each when used.
export const FX_SHAPES = [
  'ico', 'torus', 'torusThin', 'box', 'column', 'cone', 'ring',
  'cube', 'flake', 'shard', 'mote', 'glint',
] as const;
export type FxShape = (typeof FX_SHAPES)[number];

// Max simultaneous live instances per shape. Bursts that would overflow simply
// drop particles (never allocate), so a killstreak pile-up degrades gracefully.
const SHAPE_CAPACITY: Record<FxShape, number> = {
  ico: 192,
  torus: 32,
  torusThin: 24,
  box: 256,
  column: 8,
  cone: 8,
  ring: 32,
  cube: 192,
  flake: 320,
  shard: 128,
  mote: 256,
  glint: 64,
};

const BILLBOARD = new Set<FxShape>(['mote', 'glint']);

const SHAPE_INDEX = Object.fromEntries(FX_SHAPES.map((s, i) => [s, i])) as Record<FxShape, number>;

const MAX_DT = 0.1;
// Camera-facing flashes (muzzle, impact, kill + every style's energy flash).
// All busy → the most-faded one is recycled, so a pile-up never allocates.
const SPRITE_SLOTS = 32;

function buildShapeGeometry(shape: FxShape): THREE.BufferGeometry {
  switch (shape) {
    case 'ico': return new THREE.IcosahedronGeometry(1, 0);
    // Torus tube is a fixed FRACTION of the ring radius; uniform scale keeps
    // the proportions, so one geometry serves every ring size.
    case 'torus': return new THREE.TorusGeometry(1, 0.25, 8, 24);
    case 'torusThin': return new THREE.TorusGeometry(1, 0.08, 8, 32);
    case 'box': return new THREE.BoxGeometry(1, 1, 1);
    // Open, tapered light columns (top radius as a fraction of the base).
    case 'column': return new THREE.CylinderGeometry(0.7, 1, 1, 12, 1, true);
    case 'cone': return new THREE.CylinderGeometry(0.4375, 1, 1, 10, 1, true);
    // Textured surface ring (+Z is the surface normal).
    case 'ring': return new THREE.PlaneGeometry(1, 1);
    case 'cube': return new THREE.BoxGeometry(1, 1, 1);
    case 'flake': return new THREE.PlaneGeometry(1, 1);
    // A faceted crystal: a stretched octahedron (flat normals at detail 0).
    case 'shard': return new THREE.OctahedronGeometry(0.5, 0).scale(0.6, 1.5, 0.14);
    case 'mote':
    case 'glint': return new THREE.PlaneGeometry(1, 1);
  }
}

// Solid FX surface (voxels, confetti, ash): a cheap two-light shade plus an
// emissive term from the instance colour (colours above 1 glow through the
// bloom) and, on cubes, glowing edges. Not scene-lit, so it never re-keys on
// the level's lights and compiles in a blink.
const SOLID_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  mat4 m = modelMatrix * instanceMatrix;
  vN = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * (m * vec4(position, 1.0));
}
`;

const SOLID_FRAG = /* glsl */ `
uniform float uEmit;
uniform float uEdge;
varying vec3 vN;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float diff = max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 base = min(vColor, vec3(1.0));
  vec3 col = base * (0.22 + 0.4 * hemi + 0.55 * diff);
  vec2 e = abs(vUv - 0.5) * 2.0;
  float edge = pow(max(e.x, e.y), 9.0);
  col += vColor * (uEmit + uEdge * edge);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function solidMaterial(emit: number, edge: number, doubleSided: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uEmit: { value: emit }, uEdge: { value: edge } },
    vertexShader: SOLID_VERT,
    fragmentShader: SOLID_FRAG,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// Glass shard: see-through body, a bright fresnel rim and a hot glint on any
// facet that swings toward the camera. Additive.
const SHARD_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
void main() {
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vN = mat3(m) * normal;
  vView = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHARD_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float glint = pow(facing, 28.0);
  float peak = max(vColor.r, max(vColor.g, vColor.b));
  vec3 col = vColor * (0.06 + rim * 1.3) + vec3(glint * peak * 0.9);
  col *= smoothstep(0.15, 0.6, length(vView)); // never swamp the camera
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

function shardMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SHARD_VERT,
    fragmentShader: SHARD_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

// Camera-facing billboard: the instance matrix carries position (column 3)
// and a 2-D scale+rotation in the x/y of columns 0 and 1 (see FxPool.step).
const BILLBOARD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  vec4 c = viewMatrix * (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0));
  c.xy += mat2(instanceMatrix[0].xy, instanceMatrix[1].xy) * position.xy;
  vColor *= smoothstep(0.15, 0.6, -c.z); // never swamp the camera
  gl_Position = projectionMatrix * c;
}
`;

const BILLBOARD_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor * t.rgb * t.a, 1.0);
  #include <colorspace_fragment>
}
`;

function billboardMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: BILLBOARD_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

// Additive FX fade out within ~0.6 m of the camera (a spark or ring passing
// through the eye must not white-out the view). Module scope so every
// instance shares one program.
const injectNearFade = (shader: THREE.WebGLProgramParametersWithUniforms) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vIgDepth;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvIgDepth = -mvPosition.z;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vIgDepth;')
    .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb *= smoothstep(0.15, 0.6, vIgDepth);');
};

function additiveMaterial(map: THREE.Texture | null, doubleSided: boolean): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  m.onBeforeCompile = injectNearFade;
  return m;
}

// Energy shell for the light columns / cones (spawn-in beams, the pyre): a
// hollow, fresnel-edged cylinder with fine vertical streaks that fades toward
// its top — bright only at the silhouette, see-through in the middle, so it
// reads as light, never as a solid capsule. Instanced like the rest (per-
// instance matrix + colour; the fade is baked into the colour).
const SHELL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vN = mat3(m) * normal;
  vView = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vView)));
  float rim = pow(1.0 - facing, 2.2);
  float streak = pow(0.5 + 0.5 * sin(vUv.x * 6.2831853 * 11.0 + vUv.y * 3.0), 8.0);
  float v = vUv.y; // 0 at the base, 1 at the top
  float height = smoothstep(0.0, 0.06, v) * pow(1.0 - v, 1.4);
  float a = (rim * 0.85 + streak * 0.3 * (1.0 - facing * 0.5)) * height;
  a *= smoothstep(0.15, 0.6, length(vView)); // never swamp the camera
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <colorspace_fragment>
}
`;

function shellMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

// ── Procedural textures (module-cached, shared by every context) ───────────

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  draw(ctx, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let flashTex: THREE.Texture | null = null;
// Rail-discharge flash: a hard white core, six tapered streaks (alternating
// long/short), and a faint ring — crisp, readable, Diabotical-style.
export function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  flashTex = canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    ctx.globalCompositeOperation = 'lighter';
    // Streaks.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.35;
      const len = (i % 2 === 0 ? 0.48 : 0.3) * s;
      const w = (i % 2 === 0 ? 0.05 : 0.035) * s;
      const g = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a + Math.PI / 2) * w, c + Math.sin(a + Math.PI / 2) * w);
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      ctx.lineTo(c + Math.cos(a - Math.PI / 2) * w, c + Math.sin(a - Math.PI / 2) * w);
      ctx.closePath();
      ctx.fill();
    }
    // Ring.
    const ring = ctx.createRadialGradient(c, c, s * 0.3, c, c, s * 0.4);
    ring.addColorStop(0, 'rgba(255,255,255,0)');
    ring.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    ring.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, s, s);
    // Core.
    const core = ctx.createRadialGradient(c, c, 0, c, c, s * 0.28);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.3, 'rgba(255,255,255,0.9)');
    core.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, s, s);
  });
  return flashTex;
}

let glowTex: THREE.Texture | null = null;
// Soft radial glow (hot centre, long smooth falloff) — energy flashes.
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  glowTex = canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  return glowTex;
}

let starTex: THREE.Texture | null = null;
// Four-point sparkle with a hot centre — glints on glass, prism sparkles.
export function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  starTex = canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const len = s * 0.48;
      const w = s * 0.05;
      const g = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a + Math.PI / 2) * w, c + Math.sin(a + Math.PI / 2) * w);
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      ctx.lineTo(c + Math.cos(a - Math.PI / 2) * w, c + Math.sin(a - Math.PI / 2) * w);
      ctx.closePath();
      ctx.fill();
    }
    const core = ctx.createRadialGradient(c, c, 0, c, c, s * 0.2);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, s, s);
  });
  return starTex;
}

let ringTex: THREE.Texture | null = null;
// Thin soft annulus — the expanding shock ring on a surface / at the muzzle.
export function ringTexture(): THREE.Texture {
  if (ringTex) return ringTex;
  ringTex = canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, s * 0.3, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
    g.addColorStop(0.62, 'rgba(255,255,255,1)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  return ringTex;
}

// ── Particles ───────────────────────────────────────────────────────────────

const tmpColor = new THREE.Color();

// One pooled particle. Recipes fill the public fields right after alloc(); the
// pool evaluates position/scale/fade from them each frame.
export class FxParticle {
  shape = 0; // index into FX_SHAPES
  x = 0; y = 0; z = 0; // start position
  vx = 0; vy = 0; vz = 0; // velocity (m/s)
  gravity = 0; // m/s², pulls -Y
  age = 0;
  life = 0.2;
  fadePow = 1; // brightness = lifeFrac^fadePow
  sx = 1; sy = 1; sz = 1; // base scale (metres)
  grow = 0; // exponential scale rate per second (negative shrinks)
  qx = 0; qy = 0; qz = 0; qw = 1; // orientation (ignored when `align`)
  align = false; // orient +Z along the current velocity (streaks / spikes)
  r = 1; g = 1; b = 1; // linear colour, may exceed 1 for bloom
  // ── Finisher extras (all closed-form, frame-rate independent) ──
  delay = 0; // seconds before it appears (life starts after the delay)
  drag = 0; // 1/s exponential velocity damping (flutter, hang)
  sax = 0; say = 1; saz = 0; spin = 0; // tumble axis (unit) + rate rad/s
  floor = -Infinity; // world y it can't sink below (settles on the ground)
  r2 = 0; g2 = 0; b2 = 0; ramp = false; // colour → (r2,g2,b2) over the life
  scaleFade = false; // solid shapes: shrink out at the end instead of dimming
  rot = 0; // billboard in-plane angle

  reset(shape: number) {
    this.shape = shape;
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.gravity = 0;
    this.age = 0;
    this.life = 0.2;
    this.fadePow = 1;
    this.sx = this.sy = this.sz = 1;
    this.grow = 0;
    this.qx = this.qy = this.qz = 0;
    this.qw = 1;
    this.align = false;
    this.r = this.g = this.b = 1;
    this.delay = 0;
    this.drag = 0;
    this.sax = 0; this.say = 1; this.saz = 0; this.spin = 0;
    this.floor = -Infinity;
    this.r2 = this.g2 = this.b2 = 0;
    this.ramp = false;
    this.scaleFade = false;
    this.rot = 0;
  }

  setColor(hex: number, intensity = 1) {
    tmpColor.setHex(hex);
    this.r = tmpColor.r * intensity;
    this.g = tmpColor.g * intensity;
    this.b = tmpColor.b * intensity;
  }

  setRGB(r: number, g: number, b: number) {
    this.r = r;
    this.g = g;
    this.b = b;
  }

  // Colour ramp end (linear); the colour lerps toward it over the life.
  setRamp(r: number, g: number, b: number) {
    this.r2 = r;
    this.g2 = g;
    this.b2 = b;
    this.ramp = true;
  }

  // Tumble about a random axis at `rate` rad/s.
  randomSpin(rate: number) {
    const x = Math.random() - 0.5, y = Math.random() - 0.5, z = Math.random() - 0.5;
    const l = Math.hypot(x, y, z) || 1;
    this.sax = x / l;
    this.say = y / l;
    this.saz = z / l;
    this.spin = rate;
  }

  // Random starting orientation.
  randomOrientation() {
    tmpE2.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
    tmpQ2.setFromEuler(tmpE2);
    this.qx = tmpQ2.x; this.qy = tmpQ2.y; this.qz = tmpQ2.z; this.qw = tmpQ2.w;
  }

  setQuaternion(q: THREE.Quaternion) {
    this.qx = q.x;
    this.qy = q.y;
    this.qz = q.z;
    this.qw = q.w;
  }

  setScale(s: number, sy = s, sz = s) {
    this.sx = s;
    this.sy = sy;
    this.sz = sz;
  }
}

const tmpE2 = new THREE.Euler();
const tmpQ2 = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();

export class FxPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly capacity: number[] = [];
  private readonly live: FxParticle[] = [];
  private readonly free: FxParticle[] = [];
  private readonly liveByShape: Int32Array;
  private readonly billboard: boolean[] = FX_SHAPES.map((s) => BILLBOARD.has(s));

  constructor() {
    this.group.userData.shared = true;
    let total = 0;
    for (const shape of FX_SHAPES) {
      const cap = SHAPE_CAPACITY[shape];
      const shell = shape === 'column' || shape === 'cone';
      let mat: THREE.Material;
      if (shell) mat = shellMaterial();
      else if (shape === 'cube') mat = solidMaterial(0.45, 1.4, false);
      else if (shape === 'flake') mat = solidMaterial(0.32, 0, true);
      else if (shape === 'shard') mat = shardMaterial();
      else if (shape === 'mote') mat = billboardMaterial(glowTexture());
      else if (shape === 'glint') mat = billboardMaterial(starTexture());
      else mat = additiveMaterial(shape === 'ring' ? ringTexture() : null, shape === 'ring');
      const mesh = new THREE.InstancedMesh(buildShapeGeometry(shape), mat, cap);
      if (shape === 'cube' || shape === 'flake') mesh.renderOrder = -1; // solids before the additive glow
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.shared = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.capacity.push(cap);
      total += cap;
    }
    this.liveByShape = new Int32Array(FX_SHAPES.length);
    for (let i = 0; i < total; i++) this.free.push(new FxParticle());
  }

  // Claim a particle of `shape`, already live with default fields. Returns
  // null (drops the particle) when the shape's instance budget is full.
  alloc(shape: FxShape): FxParticle | null {
    const si = SHAPE_INDEX[shape];
    if (this.liveByShape[si] >= this.capacity[si]) return null;
    const p = this.free.pop();
    if (!p) return null;
    p.reset(si);
    this.live.push(p);
    this.liveByShape[si]++;
    return p;
  }

  step(dt: number) {
    const counts = this.liveByShape;
    counts.fill(0);
    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.age += dt;
      if (p.age >= p.delay + p.life) {
        live[i] = live[live.length - 1];
        live.pop();
        this.free.push(p);
        continue;
      }
      const t = p.age - p.delay;
      if (t < 0) continue; // still waiting to appear
      const u = t / p.life;
      const lifeFrac = 1 - u;
      const fade = p.fadePow === 1 ? lifeFrac : Math.pow(lifeFrac, p.fadePow);
      let s = p.grow !== 0 ? Math.exp(p.grow * t) : 1;
      if (p.scaleFade) {
        const k = Math.min(1, lifeFrac / 0.35);
        s *= k * k * (3 - 2 * k);
      }

      // Ballistic (optionally with linear drag) in closed form.
      let vxT = p.vx, vyT = p.vy - p.gravity * t, vzT = p.vz;
      if (p.drag > 0) {
        const k = p.drag;
        const e = Math.exp(-k * t);
        const f = (1 - e) / k;
        const gk = p.gravity / k;
        tmpPos.set(p.x + p.vx * f, p.y + (p.vy + gk) * f - gk * t, p.z + p.vz * f);
        vxT = p.vx * e; vyT = (p.vy + gk) * e - gk; vzT = p.vz * e;
      } else {
        tmpPos.set(p.x + p.vx * t, p.y + p.vy * t - 0.5 * p.gravity * t * t, p.z + p.vz * t);
      }
      if (tmpPos.y < p.floor) tmpPos.y = p.floor + 0.5 * p.sy * s;

      const si = p.shape;
      const idx = counts[si];
      if (idx >= this.capacity[si]) continue; // over budget: keep alive, skip draw
      counts[si] = idx + 1;
      const mesh = this.meshes[si];
      const arr = mesh.instanceMatrix.array as Float32Array;
      if (this.billboard[si]) {
        // Camera-facing: 2-D scale + rotation in columns 0/1, position in 3.
        const a = p.rot + p.spin * t;
        const c = Math.cos(a) * p.sx * s, sn = Math.sin(a) * p.sx * s;
        const o = idx * 16;
        arr[o] = c; arr[o + 1] = sn; arr[o + 2] = 0; arr[o + 3] = 0;
        arr[o + 4] = -sn; arr[o + 5] = c; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = 1; arr[o + 11] = 0;
        arr[o + 12] = tmpPos.x; arr[o + 13] = tmpPos.y; arr[o + 14] = tmpPos.z; arr[o + 15] = 1;
      } else {
        if (p.align) {
          const l = Math.hypot(vxT, vyT, vzT);
          if (l > 1e-6) {
            tmpDir.set(vxT / l, vyT / l, vzT / l);
            tmpQuat.setFromUnitVectors(Z_AXIS, tmpDir);
          } else {
            tmpQuat.identity();
          }
        } else {
          tmpQuat.set(p.qx, p.qy, p.qz, p.qw);
          if (p.spin !== 0) {
            tmpQ2.setFromAxisAngle(tmpAxis.set(p.sax, p.say, p.saz), p.spin * t);
            tmpQuat.premultiply(tmpQ2);
          }
        }
        tmpScale.set(p.sx * s, p.sy * s, p.sz * s);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        tmpMat.toArray(arr as unknown as number[], idx * 16);
      }
      const col = mesh.instanceColor!.array as Float32Array;
      let r = p.r, g = p.g, b = p.b;
      if (p.ramp) {
        r += (p.r2 - r) * u;
        g += (p.g2 - g) * u;
        b += (p.b2 - b) * u;
      }
      const cf = p.scaleFade ? 1 : fade;
      col[idx * 3] = r * cf;
      col[idx * 3 + 1] = g * cf;
      col[idx * 3 + 2] = b * cf;
    }
    for (let si = 0; si < this.meshes.length; si++) {
      const mesh = this.meshes[si];
      const n = counts[si];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) continue;
      const im = mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      const ic = mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
    }
  }

  clear() {
    for (const p of this.live) this.free.push(p);
    this.live.length = 0;
    this.liveByShape.fill(0);
    for (const mesh of this.meshes) {
      mesh.count = 0;
      mesh.visible = false;
    }
  }

  dispose() {
    this.clear();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.clear();
  }
}

// ── Sprites (camera-facing flashes) ────────────────────────────────────────

export type SpriteSlot = {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  busy: boolean;
  age: number;
  life: number;
  fadePow: number;
  base: number; // starting size (metres)
  shrink: number; // fraction of `base` lost over the life (negative grows)
  flicker: boolean; // alternate-frame 0.78× for the first 2 frames
  delay: number; // seconds before it appears (the life starts after it)
  r: number; g: number; b: number;
  size: number; // this frame's size before proximity scaling
  fade: number; // this frame's brightness factor
  noProx: boolean; // exempt from proximity scaling (the local viewmodel muzzle)
};

const tmpCam = new THREE.Vector3();

class SpritePool {
  readonly slots: SpriteSlot[] = [];

  constructor(parent: THREE.Object3D) {
    for (let i = 0; i < SPRITE_SLOTS; i++) {
      const mat = new THREE.SpriteMaterial({
        map: flashTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        color: 0xffffff,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.userData.shared = true;
      parent.add(sprite);
      const slot: SpriteSlot = {
        sprite, mat, busy: false, age: 0, life: 0.1, fadePow: 1, base: 0.2, shrink: 0, flicker: false, delay: 0, r: 1, g: 1, b: 1,
        size: 0.2, fade: 1, noProx: false,
      };
      // Close to the camera a flash shrinks and dims (a point-blank frag or
      // an impact on a wall at your face must never white-out the view).
      sprite.onBeforeRender = (_r, _s, cam) => {
        const d = sprite.position.distanceTo(tmpCam.setFromMatrixPosition(cam.matrixWorld));
        const k = slot.noProx ? 1 : Math.max(0.3, Math.min(1, (d - 0.5) / 3.5));
        sprite.scale.set(slot.size * k, slot.size * k, 1);
        sprite.updateMatrixWorld();
        const f = slot.fade * Math.sqrt(k);
        mat.color.setRGB(slot.r * f, slot.g * f, slot.b * f);
      };
      this.slots.push(slot);
    }
  }

  // Claim a slot (the oldest live one is recycled when all are busy). The
  // caller sets position / colour / timing on the returned slot.
  alloc(map: THREE.Texture): SpriteSlot {
    let pick: SpriteSlot | null = null;
    for (const s of this.slots) {
      if (!s.busy) { pick = s; break; }
      if (!pick || (s.age - s.delay) / s.life > (pick.age - pick.delay) / pick.life) pick = s;
    }
    const s = pick!;
    s.busy = true;
    s.age = 0;
    s.life = 0.1;
    s.fadePow = 1;
    s.base = 0.2;
    s.shrink = 0;
    s.flicker = false;
    s.delay = 0;
    s.noProx = false;
    s.r = s.g = s.b = 1;
    s.mat.map = map;
    s.mat.rotation = Math.random() * Math.PI * 2;
    s.sprite.visible = true;
    return s;
  }

  // Apply the caller's size / colour right away so the sprite is correct on
  // the very first frame it's drawn (before the first step()).
  finish(s: SpriteSlot) {
    s.size = s.base;
    s.fade = 1;
    s.sprite.scale.set(s.base, s.base, 1);
    s.mat.color.setRGB(s.r, s.g, s.b);
    s.sprite.visible = s.delay <= 0;
  }

  step(dt: number, frame: number) {
    for (const s of this.slots) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age - s.delay;
      if (t < 0) continue; // waiting to appear
      if (t >= s.life) {
        s.busy = false;
        s.sprite.visible = false;
        continue;
      }
      s.sprite.visible = true;
      const f = 1 - t / s.life;
      const fade = s.fadePow === 1 ? f : Math.pow(f, s.fadePow);
      let size = s.base * (1 - s.shrink * (t / s.life));
      if (s.flicker && t < 0.034 && (frame & 1) === 1) size *= 0.78;
      s.size = size;
      s.fade = fade;
      s.sprite.scale.set(size, size, 1);
      s.mat.color.setRGB(s.r * fade, s.g * fade, s.b * fade);
    }
  }

  clear() {
    for (const s of this.slots) {
      s.busy = false;
      s.sprite.visible = false;
    }
  }

  dispose() {
    for (const s of this.slots) {
      s.mat.dispose();
      s.sprite.removeFromParent();
    }
    this.slots.length = 0;
  }
}

// ── Arcs (lightning ribbons) ───────────────────────────────────────────────
//
// Short-lived jagged energy arcs between two world points (overload's arcs
// crawling over a body, the blast's tendrils). One ribbon batch, re-jagged
// at `rate` Hz with a random flicker, fading over the life. Built on first
// use (scenes that never arc never pay).

const ARC_SLOTS = 20;
const ARC_POINTS = 10;

type ArcSlot = {
  busy: boolean;
  age: number;
  delay: number;
  life: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  jag: number;
  r: number; g: number; b: number;
  width: number;
  rate: number;
  next: number; // time to the next re-jag
  flick: number;
};

export class ArcPool {
  readonly batch = new RibbonBatch(ARC_SLOTS, ARC_POINTS, 1.4);
  private readonly slots: ArcSlot[] = [];
  private readonly path = new Float32Array(ARC_SLOTS * ARC_POINTS * 3);

  constructor() {
    for (let i = 0; i < ARC_SLOTS; i++) {
      this.slots.push({
        busy: false, age: 0, delay: 0, life: 0.1, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0,
        jag: 0.05, r: 1, g: 1, b: 1, width: 0.02, rate: 30, next: 0, flick: 1,
      });
    }
  }

  // Colour is linear (may exceed 1). Drops the arc when every slot is busy.
  spawn(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r: number, g: number, b: number, width: number, life: number, jag: number, delay = 0, rate = 30,
  ): void {
    let s: ArcSlot | null = null;
    for (const q of this.slots) {
      if (!q.busy) { s = q; break; }
    }
    if (!s) return;
    s.busy = true;
    s.age = 0;
    s.delay = delay;
    s.life = life;
    s.ax = ax; s.ay = ay; s.az = az;
    s.bx = bx; s.by = by; s.bz = bz;
    s.r = r; s.g = g; s.b = b;
    s.width = width;
    s.jag = jag;
    s.rate = rate;
    s.next = 0;
    s.flick = 1;
  }

  step(dt: number) {
    const batch = this.batch;
    batch.begin();
    for (let i = 0; i < ARC_SLOTS; i++) {
      const s = this.slots[i];
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age - s.delay;
      if (t < 0) continue;
      if (t >= s.life) {
        s.busy = false;
        continue;
      }
      const o = i * ARC_POINTS * 3;
      s.next -= dt;
      if (s.next <= 0) {
        s.next = 1 / s.rate;
        s.flick = 0.55 + Math.random() * 0.45;
        lightningPath(this.path.subarray(o, o + ARC_POINTS * 3), ARC_POINTS, s.ax, s.ay, s.az, s.bx, s.by, s.bz, s.jag);
      }
      const k = (1 - t / s.life) * s.flick;
      for (let j = 0; j < ARC_POINTS; j++) {
        const q = o + j * 3;
        const w = s.width * (1 - 0.5 * Math.abs(j / (ARC_POINTS - 1) - 0.5));
        batch.push(i, this.path[q], this.path[q + 1], this.path[q + 2], s.r * k, s.g * k, s.b * k, w);
      }
    }
    batch.commit();
  }

  clear() {
    for (const s of this.slots) s.busy = false;
    this.batch.begin();
    this.batch.commit();
  }

  dispose() {
    this.batch.dispose();
  }
}

// ── Point-light pulses ─────────────────────────────────────────────────────

type Pulse = { light: THREE.PointLight; age: number; life: number; peak: number };

// Two lights (muzzle + impact) that live in the scene permanently while
// enabled — adding/removing lights per shot would re-key every lit material's
// shader — and simply sit at intensity 0 between pulses.
class LightPulses {
  readonly pulses: Pulse[] = [];
  private attached = false;

  constructor(private readonly parent: THREE.Object3D) {
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 5, 2);
      light.userData.shared = true;
      this.pulses.push({ light, age: 0, life: 0, peak: 0 });
    }
  }

  get enabled() {
    return this.attached;
  }

  setEnabled(on: boolean) {
    if (on === this.attached) return;
    this.attached = on;
    for (const p of this.pulses) {
      if (on) this.parent.add(p.light);
      else this.parent.remove(p.light);
      p.light.intensity = 0;
      p.life = 0;
    }
  }

  // slot 0 = muzzle, 1 = world (rail impact / kill burst — a new pulse only
  // takes the slot over from a dimmer one). Peak intensity in candela; ≤ 0.14 s.
  pulse(slot: 0 | 1, x: number, y: number, z: number, hex: number, peak: number, life: number, distance: number) {
    if (!this.attached) return;
    const p = this.pulses[slot];
    if (p.life > 0 && p.light.intensity > peak) return;
    p.light.position.set(x, y, z);
    p.light.color.setHex(hex);
    p.light.distance = distance;
    p.light.intensity = peak;
    p.peak = peak;
    p.age = 0;
    p.life = Math.min(life, 0.14);
  }

  step(dt: number) {
    for (const p of this.pulses) {
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.life = 0;
        p.light.intensity = 0;
        continue;
      }
      const f = 1 - p.age / p.life;
      p.light.intensity = p.peak * f * f;
    }
  }

  clear() {
    for (const p of this.pulses) {
      p.life = 0;
      p.light.intensity = 0;
    }
  }

  dispose() {
    this.setEnabled(false);
    for (const p of this.pulses) p.light.dispose();
  }
}

// ── Context ────────────────────────────────────────────────────────────────

// Device-level quality shared by every context (1 = full; 0.5 = low-spec:
// thinner sprays, no decals, no light pulses).
let fxQuality = 1;

export function setFxQuality(q: number) {
  fxQuality = Math.max(0.25, Math.min(1, q));
}

export function getFxQuality(): number {
  return fxQuality;
}

export class FxContext {
  readonly group = new THREE.Group();
  readonly pool = new FxPool();
  readonly sprites: SpritePool;
  readonly lights: LightPulses;
  readonly decals = new DecalManager();
  // Rail trails, built on the first beam (scenes without a railgun never pay).
  private railBeams: RailBeams | null = null;
  private arcPool: ArcPool | null = null;
  time = 0; // seconds since creation (drives decal ageing on the GPU)
  frame = 0;
  quality = -1;
  // Set by EffectsManager.step; Railgun.step only steps a context nobody
  // else is stepping (e.g. a scene with a weapon but no EffectsManager).
  managed = false;

  constructor(readonly scene: THREE.Scene) {
    this.group.name = 'fx';
    this.group.userData.shared = true;
    this.group.userData.fx = true;
    this.group.add(this.pool.group);
    this.sprites = new SpritePool(this.group);
    this.lights = new LightPulses(this.group);
    this.group.add(this.decals.mesh);
    scene.add(this.group);
    this.applyQuality(fxQuality);
  }

  get beams(): RailBeams {
    if (!this.railBeams) {
      this.railBeams = new RailBeams();
      this.railBeams.setQuality(this.quality < 0 ? fxQuality : this.quality);
      this.group.add(this.railBeams.group);
    }
    return this.railBeams;
  }

  clearBeams() {
    this.railBeams?.clear();
  }

  // Lightning arcs, built on first use.
  get arcs(): ArcPool {
    if (!this.arcPool) {
      this.arcPool = new ArcPool();
      this.group.add(this.arcPool.batch.mesh);
    }
    return this.arcPool;
  }

  step(dt: number) {
    dt = Math.max(0, Math.min(MAX_DT, dt));
    if (this.quality !== fxQuality) this.applyQuality(fxQuality);
    this.time += dt;
    this.frame++;
    this.pool.step(dt);
    this.sprites.step(dt, this.frame);
    this.lights.step(dt);
    this.railBeams?.step(dt);
    this.arcPool?.step(dt);
    this.decals.setTime(this.time);
  }

  private applyQuality(q: number) {
    this.quality = q;
    this.decals.setQuality(q);
    this.lights.setEnabled(q >= 0.99);
    this.railBeams?.setQuality(q);
  }

  clear() {
    this.pool.clear();
    this.sprites.clear();
    this.lights.clear();
    this.decals.clear();
    this.railBeams?.clear();
    this.arcPool?.clear();
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.lights.dispose();
    this.sprites.dispose();
    this.pool.dispose();
    this.decals.dispose();
    this.railBeams?.dispose();
    this.railBeams = null;
    this.arcPool?.dispose();
    this.arcPool = null;
  }
}

const contexts = new Map<THREE.Scene, FxContext>();

export function getFxContext(scene: THREE.Scene): FxContext {
  let ctx = contexts.get(scene);
  if (!ctx) {
    ctx = new FxContext(scene);
    contexts.set(scene, ctx);
  }
  return ctx;
}

export function peekFxContext(scene: THREE.Scene): FxContext | null {
  return contexts.get(scene) ?? null;
}

export function disposeFxContext(scene: THREE.Scene) {
  const ctx = contexts.get(scene);
  if (!ctx) return;
  ctx.dispose();
  contexts.delete(scene);
}
