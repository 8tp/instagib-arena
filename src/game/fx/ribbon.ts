import * as THREE from 'three';

// ── Screen-space energy ribbons ──────────────────────────────────────────────
//
// Thin additive strips (lightning bolts, plasma arcs, a halo band) expanded to
// camera-facing quads in the vertex shader, so they read as crisp lines from
// any angle. The width is in METRES but never narrower than `minPx` pixels —
// a 1px GL line vanishes at range, a ribbon doesn't. When the clamp kicks in
// the colour is scaled down by the same factor, so a far bolt stays a thin
// visible line instead of blooming into a smear.
//
// One RibbonBatch = one draw call for up to `strips` strips of up to `points`
// points each. The owner writes points (world or local space — the mesh's own
// matrix applies), then commit() rebuilds tangents and uploads only what's
// used. Nothing allocates after construction.

const RIBBON_VERT = /* glsl */ `
attribute vec3 aTan;
attribute vec3 aColor;
attribute float aWidth;
attribute float aSide;
uniform vec2 uViewport; // current viewport, physical px
uniform float uMinPx;
varying vec3 vColor;
varying float vSide;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec4 mv2 = modelViewMatrix * vec4(position + aTan * 0.05, 1.0);
  vec4 c1 = projectionMatrix * mvPosition;
  vec4 c2 = projectionMatrix * mv2;
  vec2 hv = uViewport * 0.5;
  vec2 dpx = (c2.xy / max(c2.w, 1e-4) - c1.xy / max(c1.w, 1e-4)) * hv;
  float dl = length(dpx);
  vec2 n = dl > 1e-5 ? vec2(-dpx.y, dpx.x) / dl : vec2(0.0, 1.0);
  // Half-width in px: world width projected, clamped to the minimum.
  float px = 0.5 * aWidth * projectionMatrix[1][1] * hv.y / max(-mvPosition.z, 0.01);
  float k = 1.0;
  float minHalf = 0.5 * uMinPx;
  if (px < minHalf && aWidth > 0.0) { k = max(px / minHalf, 0.3); px = minHalf; }
  c1.xy += n * (px * aSide) / hv * c1.w;
  gl_Position = c1;
  vColor = aColor * k;
  vSide = aSide;
  #include <fog_vertex>
}
`;

const RIBBON_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vSide;
#include <fog_pars_fragment>
void main() {
  float v = abs(vSide);
  float glow = pow(max(1.0 - v, 0.0), 1.6);
  float core = 1.0 - smoothstep(0.0, 0.32, v);
  float peak = max(vColor.r, max(vColor.g, vColor.b));
  vec3 col = vColor * glow + vec3(core * min(peak, 1.6) * 0.55);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col *= 1.0 - fogF;
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const tmpVp = new THREE.Vector4();

function ribbonMaterial(minPx: number): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uViewport: { value: new THREE.Vector2(1, 1) }, uMinPx: { value: minPx } },
    ]),
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: false,
  });
  return m;
}

export class RibbonBatch {
  readonly mesh: THREE.Mesh;
  readonly strips: number;
  readonly points: number;
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  // Per-point staging (one entry per point, expanded ×2 on commit).
  private readonly px: Float32Array;
  private readonly col: Float32Array;
  private readonly wid: Float32Array;
  private readonly len: Int32Array; // points used per strip
  // GPU buffers (2 vertices per point).
  private readonly aPos: Float32Array;
  private readonly aTan: Float32Array;
  private readonly aCol: Float32Array;
  private readonly aWid: Float32Array;
  private active = 0;

  constructor(strips: number, points: number, minPx = 1.6) {
    this.strips = strips;
    this.points = points;
    const n = strips * points;
    this.px = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.wid = new Float32Array(n);
    this.len = new Int32Array(strips);
    this.aPos = new Float32Array(n * 2 * 3);
    this.aTan = new Float32Array(n * 2 * 3);
    this.aCol = new Float32Array(n * 2 * 3);
    this.aWid = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const idx: number[] = [];
    for (let s = 0; s < strips; s++) {
      for (let j = 0; j < points - 1; j++) {
        const v0 = (s * points + j) * 2;
        idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
      }
    }
    this.geom.setIndex(idx);
    const dyn = (arr: Float32Array, size: number) => {
      const a = new THREE.BufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geom.setAttribute('position', dyn(this.aPos, 3));
    this.geom.setAttribute('aTan', dyn(this.aTan, 3));
    this.geom.setAttribute('aColor', dyn(this.aCol, 3));
    this.geom.setAttribute('aWidth', dyn(this.aWid, 1));
    this.geom.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.geom.setDrawRange(0, 0);
    this.mat = ribbonMaterial(minPx);
    this.mesh = new THREE.Mesh(this.geom, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.userData.shared = true;
    const u = this.mat.uniforms;
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(tmpVp);
      (u.uViewport.value as THREE.Vector2).set(Math.max(1, tmpVp.z), Math.max(1, tmpVp.w));
      this.mat.uniformsNeedUpdate = true;
    };
  }

  set minPx(v: number) {
    this.mat.uniforms.uMinPx.value = v;
  }

  // Start a new frame: every strip empty.
  begin(): void {
    this.len.fill(0);
    this.active = 0;
  }

  // Append a point to strip `s` (in order). `width` in metres; colour is
  // linear and may exceed 1 (additive, bloom picks the hot core).
  push(s: number, x: number, y: number, z: number, r: number, g: number, b: number, width: number): void {
    const j = this.len[s];
    if (j >= this.points) return;
    const i = s * this.points + j;
    this.px[i * 3] = x;
    this.px[i * 3 + 1] = y;
    this.px[i * 3 + 2] = z;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.wid[i] = width;
    this.len[s] = j + 1;
    if (s + 1 > this.active) this.active = s + 1;
  }

  // Expand staged points into the GPU buffers and upload the used range.
  commit(): void {
    const P = this.points;
    const used = this.active;
    for (let s = 0; s < used; s++) {
      const n = this.len[s];
      for (let j = 0; j < P; j++) {
        const i = s * P + j;
        // Unused tail points collapse onto the last point with zero width.
        const src = n === 0 ? i : s * P + Math.min(j, n - 1);
        const x = this.px[src * 3], y = this.px[src * 3 + 1], z = this.px[src * 3 + 2];
        let tx = 0, ty = 1, tz = 0;
        if (n >= 2) {
          const jj = Math.min(j, n - 1);
          const a = s * P + Math.max(0, jj - 1);
          const b = s * P + Math.min(n - 1, jj + 1);
          tx = this.px[b * 3] - this.px[a * 3];
          ty = this.px[b * 3 + 1] - this.px[a * 3 + 1];
          tz = this.px[b * 3 + 2] - this.px[a * 3 + 2];
          const l = Math.hypot(tx, ty, tz) || 1;
          tx /= l; ty /= l; tz /= l;
        }
        const w = n === 0 || j >= n ? 0 : this.wid[i];
        const r = w > 0 ? this.col[src * 3] : 0;
        const g = w > 0 ? this.col[src * 3 + 1] : 0;
        const bb = w > 0 ? this.col[src * 3 + 2] : 0;
        for (let k = 0; k < 2; k++) {
          const v = i * 2 + k;
          this.aPos[v * 3] = x; this.aPos[v * 3 + 1] = y; this.aPos[v * 3 + 2] = z;
          this.aTan[v * 3] = tx; this.aTan[v * 3 + 1] = ty; this.aTan[v * 3 + 2] = tz;
          this.aCol[v * 3] = r; this.aCol[v * 3 + 1] = g; this.aCol[v * 3 + 2] = bb;
          this.aWid[v] = w;
        }
      }
    }
    const verts = used * P * 2;
    const at = this.geom.attributes;
    for (let q = 0; q < 4; q++) {
      const a = (q === 0 ? at.position : q === 1 ? at.aTan : q === 2 ? at.aColor : at.aWidth) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      if (verts > 0) {
        a.addUpdateRange(0, verts * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.geom.setDrawRange(0, used * (P - 1) * 6);
    this.mesh.visible = used > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geom.dispose();
    this.mat.dispose();
  }
}

// Jagged lightning between two points: midpoint-displaced polyline written
// into `out` (x,y,z triples, `n` points). `jag` = max sideways kick in metres
// (scaled down toward the ends). `rand` lets callers pass a seeded source.
export function lightningPath(
  out: Float32Array,
  n: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  jag: number,
  rand: () => number = Math.random,
): void {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1;
  // Two perpendicular axes to the segment.
  let px = -dz, py = 0, pz = dx;
  if (Math.abs(dy) > 0.9 * len) { px = 1; py = 0; pz = 0; }
  let pl = Math.hypot(px, py, pz) || 1;
  px /= pl; py /= pl; pz /= pl;
  let qx = (dy * pz - dz * py) / len, qy = (dz * px - dx * pz) / len, qz = (dx * py - dy * px) / len;
  pl = Math.hypot(qx, qy, qz) || 1;
  qx /= pl; qy /= pl; qz /= pl;
  let ox = 0, oy = 0;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const env = Math.sin(Math.PI * t); // pinned at both ends
    // Random walk, pulled back toward the line so it jitters, not drifts.
    ox = ox * 0.45 + (rand() - 0.5) * 2;
    oy = oy * 0.45 + (rand() - 0.5) * 2;
    const k = jag * env;
    out[i * 3] = ax + dx * t + (px * ox + qx * oy) * k;
    out[i * 3 + 1] = ay + dy * t + (py * ox + qy * oy) * k;
    out[i * 3 + 2] = az + dz * t + (pz * ox + qz * oy) * k;
  }
}
