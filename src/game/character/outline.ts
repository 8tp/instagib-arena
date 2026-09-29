import * as THREE from 'three';
import { getBodyGeometry } from './body';
import type { Character } from './character';

// ── Enemy outline (viewer accessibility option) ──────────────────────────────
//
// An inverted-hull silhouette outline around a combatant's body, in a colour
// and screen-space pixel width the viewer picks. Available to everyone (like
// Bright enemies), so it's a readability option, not a cosmetic advantage.
//
// Technique: a second SkinnedMesh that shares the body's geometry buffers and
// skeleton (so it poses for free — no extra skinning work on the CPU), drawn
// BackSide, with every vertex pushed out in CLIP space along a smooth normal
// by a constant number of pixels. Thickness is therefore uniform with
// distance and tracks the drawing-buffer size (resolution scale / DPI).
//
// Silhouette only, never through walls:
//   • depthTest ON, depthWrite OFF — the hull is occluded by world geometry
//     exactly like the body is (anything in front of it hides it).
//   • The outline draws BEFORE the body (renderOrder OUTLINE_ORDER <
//     BODY_ORDER), and since it leaves the depth buffer untouched the body
//     then paints over every outline pixel that falls inside its own
//     silhouette. Only the rim around the visible body survives — no interior
//     contour lines where armour plates overlap.
//
// One extra draw per outlined combatant, no post pass, one shared program.

const OUTLINE_ORDER = 8;
const BODY_ORDER = 9;
// Peak linear radiance of the outline: just under the bloom threshold (1.5 on
// the peak channel, renderer.ts) so it stays a crisp line instead of a glow.
const OUTLINE_PEAK = 1.45;
export const OUTLINE_WIDTH_MIN = 1;
export const OUTLINE_WIDTH_MAX = 5;

// ── Smooth-normal hull geometry (built once, shared, never disposed) ─────────
//
// The body is flat-shaded and non-indexed: each facet has its own vertices, so
// pushing along the facet normals would split the hull into floating plates.
// Instead every vertex gets the angle-weighted average normal of all facets
// meeting at its position (per bone — separate pieces stay separate hulls).
// The geometry shares the body's position/skin attributes (same GL buffers);
// only `aOutlineN` is new. It must never be disposed: disposing a geometry
// frees the GL buffers of every attribute on it, including the body's.

let hullGeometry: THREE.BufferGeometry | null = null;

function getHullGeometry(): THREE.BufferGeometry {
  if (hullGeometry) return hullGeometry;
  const body = getBodyGeometry().geometry;
  const pos = body.getAttribute('position') as THREE.BufferAttribute;
  const skin = body.getAttribute('skinIndex') as THREE.BufferAttribute;
  const count = pos.count;
  const acc = new Float32Array(count * 3);
  // Group coincident vertices (same bone, same quantised position).
  const groupOf = new Int32Array(count);
  const keys = new Map<string, number>();
  const q = (v: number) => Math.round(v * 1e4);
  for (let i = 0; i < count; i++) {
    const k = `${skin.getX(i)}:${q(pos.getX(i))}:${q(pos.getY(i))}:${q(pos.getZ(i))}`;
    let g = keys.get(k);
    if (g === undefined) {
      g = i;
      keys.set(k, g);
    }
    groupOf[i] = g;
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const corner = [a, b, c];
  for (let t = 0; t + 2 < count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    n.subVectors(c, b).cross(e1.subVectors(a, b));
    if (n.lengthSq() < 1e-14) continue; // degenerate sliver
    n.normalize();
    for (let j = 0; j < 3; j++) {
      const p = corner[j];
      e1.subVectors(corner[(j + 1) % 3], p);
      e2.subVectors(corner[(j + 2) % 3], p);
      const l = e1.length() * e2.length();
      if (l < 1e-12) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(e1.dot(e2) / l, -1, 1));
      const g = groupOf[t + j] * 3;
      acc[g] += n.x * ang;
      acc[g + 1] += n.y * ang;
      acc[g + 2] += n.z * ang;
    }
  }
  const nor = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const g = groupOf[i] * 3;
    n.set(acc[g], acc[g + 1], acc[g + 2]);
    if (n.lengthSq() < 1e-12) n.set(0, 0, 0);
    else n.normalize();
    nor[i * 3] = n.x;
    nor[i * 3 + 1] = n.y;
    nor[i * 3 + 2] = n.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos);
  g.setAttribute('skinIndex', skin);
  g.setAttribute('skinWeight', body.getAttribute('skinWeight'));
  g.setAttribute('aOutlineN', new THREE.BufferAttribute(nor, 3));
  if (body.boundingSphere) g.boundingSphere = body.boundingSphere.clone();
  if (body.boundingBox) g.boundingBox = body.boundingBox.clone();
  hullGeometry = g;
  return g;
}

// ── Colour: undo the ACES tone map on the CPU ────────────────────────────────
// Both render paths apply three's ACESFilmic to the outline (in-shader when
// drawing straight to the canvas, OutputPass under the post chain), which
// desaturates picked colours (red reads orange). The colour is a constant, so
// pre-apply the exact inverse once per change: the line lands on the colour
// the viewer picked (up to the bloom-safe brightness cap).
// three.js ACES fit matrices (tonemapping_pars_fragment), row-major.
const ACES_INPUT_INV = new THREE.Matrix3()
  .set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777)
  .invert();
const ACES_OUTPUT_INV = new THREE.Matrix3()
  .set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602)
  .invert();

function invRrtOdt(y: number): number {
  // Positive root of RRTAndODTFit(x) = y.
  const A = 1 - 0.983729 * y;
  const B = 0.0245786 - 0.432951 * y;
  const C = -(0.000090537 + 0.238081 * y);
  return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
}

const tmpV = new THREE.Vector3();
// `target`: the display colour (linear-sRGB, as THREE.Color.set(hex) gives).
function toneMapInput(target: THREE.Color, exposure: number, out: THREE.Color): THREE.Color {
  tmpV.set(target.r, target.g, target.b).applyMatrix3(ACES_OUTPUT_INV);
  tmpV.set(
    invRrtOdt(THREE.MathUtils.clamp(tmpV.x, 0, 0.98)),
    invRrtOdt(THREE.MathUtils.clamp(tmpV.y, 0, 0.98)),
    invRrtOdt(THREE.MathUtils.clamp(tmpV.z, 0, 0.98)),
  );
  tmpV.applyMatrix3(ACES_INPUT_INV).multiplyScalar(0.6 / Math.max(0.05, exposure));
  tmpV.set(Math.max(0, tmpV.x), Math.max(0, tmpV.y), Math.max(0, tmpV.z));
  const peak = Math.max(tmpV.x, tmpV.y, tmpV.z, 1e-6);
  if (peak > OUTLINE_PEAK) tmpV.multiplyScalar(OUTLINE_PEAK / peak);
  return out.setRGB(tmpV.x, tmpV.y, tmpV.z);
}

const VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aOutlineN;
uniform vec2 uRes;   // drawing-buffer size (device px)
uniform float uWidth; // outline width (device px)
void main() {
  vec3 objectNormal = aOutlineN;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  // Push out along the normal's screen-space direction by uWidth pixels
  // (× w so the offset survives the perspective divide unchanged).
  vec2 d = (projectionMatrix * vec4(normalMatrix * objectNormal, 0.0)).xy * uRes;
  float l = length(d);
  if (l > 1e-6) gl_Position.xy += (d / l) * (2.0 * uWidth / uRes) * gl_Position.w;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// The viewer's outline look: one material (one program) shared by every
// outlined combatant. Colour / width are global viewer settings.
export class OutlineStyle {
  readonly material: THREE.ShaderMaterial;
  private readonly uniforms: {
    uColor: { value: THREE.Color };
    uRes: { value: THREE.Vector2 };
    uWidth: { value: number };
  };
  private widthCss = 2;
  private readonly buf = new THREE.Vector2();
  private readonly target = new THREE.Color(1, 1, 1);
  private exposure = -1; // tone-map exposure the colour was solved for

  constructor() {
    this.uniforms = {
      uColor: { value: new THREE.Color(OUTLINE_PEAK, OUTLINE_PEAK, OUTLINE_PEAK) },
      uRes: { value: new THREE.Vector2(1920, 1080) },
      uWidth: { value: 2 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'enemy-outline',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: false,
      fog: true,
    });
    // Keep our uniform objects (merge() clones), so setters stay live.
    Object.assign(this.material.uniforms, this.uniforms);
  }

  setColor(hex: string): void {
    this.target.set(hex);
    this.exposure = -1; // re-solve on the next syncViewport()
  }

  // Width in CSS pixels (clamped to the settings range).
  setWidth(px: number): void {
    const w = Number.isFinite(px) ? px : 2;
    this.widthCss = THREE.MathUtils.clamp(w, OUTLINE_WIDTH_MIN, OUTLINE_WIDTH_MAX);
  }

  // Track the renderer's drawing-buffer size + pixel ratio (resize, DPI,
  // resolution scale). Cheap; call once per frame before drawing.
  syncViewport(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.buf);
    this.uniforms.uRes.value.set(Math.max(1, this.buf.x), Math.max(1, this.buf.y));
    // CSS px → device px; never thinner than one device pixel (no shimmer at
    // low resolution scale).
    this.uniforms.uWidth.value = Math.max(1, this.widthCss * renderer.getPixelRatio());
    const exposure = renderer.toneMappingExposure;
    if (exposure !== this.exposure) {
      this.exposure = exposure;
      toneMapInput(this.target, exposure, this.uniforms.uColor.value);
    }
  }

  dispose(): void {
    this.material.dispose();
  }
}

// One combatant's outline hull. Child of the body mesh, so it inherits every
// visibility reason the body already has (death hide, first-person spectate,
// replay hide) on top of setVisible().
export class CharacterOutline {
  readonly mesh: THREE.SkinnedMesh;
  // Frame stamp for the owner's prune pass.
  seen = 0;
  private readonly body: THREE.SkinnedMesh;
  private readonly prevBodyOrder: number;

  constructor(character: Character, style: OutlineStyle) {
    this.body = character.mesh;
    const mesh = new THREE.SkinnedMesh(getHullGeometry(), style.material);
    mesh.name = 'combatant-outline';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = OUTLINE_ORDER;
    // Same generous static bounds as the body (every pose stays inside).
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.8);
    mesh.frustumCulled = true;
    mesh.raycast = () => {}; // never a pick / hit target
    // Geometry + material are shared (the geometry with the body's buffers):
    // Game.disposeScene() must skip this mesh.
    mesh.userData.shared = true;
    this.body.add(mesh);
    mesh.bind(character.rig.skeleton, new THREE.Matrix4());
    this.mesh = mesh;
    // The body must draw after the outline so it paints over the inner part.
    this.prevBodyOrder = this.body.renderOrder;
    this.body.renderOrder = BODY_ORDER;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    if (this.body.renderOrder === BODY_ORDER) this.body.renderOrder = this.prevBodyOrder;
  }
}
