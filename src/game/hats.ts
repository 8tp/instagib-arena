import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hatById, unusualById, type UnusualKind } from './cosmetics';

// Hats: a glTF model worn on a player model's head. Attachment is a world-space
// follower — each frame we read the wearer's `mixamorigHead` transform and seat
// an auto-fit hat on the crown. A bind-pose correction removes the Mixamo bone's
// odd local frame while preserving its animated pitch/roll/yaw, so hats move
// with the head instead of hovering upright above it. Auto-fit (scale to a target
// width from the model's own bounding box) was verified across hats whose source
// scales ranged from 3 to 300 units, so no per-hat tuning is needed.

const TARGET_WIDTH = 0.34; // metres — sits a bit wider than the head so it reads
// Metres above the head BONE where a hat's base seats. The Soldier's head bone
// sits ~0.25 m below the crown of the head mesh (measured), so the base lands
// just under the crown; per-hat `sink` then drops brimmed/skull-cap styles down.
const CROWN_OFFSET = 0.19;

const loader = new GLTFLoader();
const sourceCache = new Map<string, Promise<THREE.Object3D>>();

// Load (once, cached) a hat glTF scene. Clones are taken per-wearer.
function loadHatSource(path: string): Promise<THREE.Object3D> {
  let p = sourceCache.get(path);
  if (!p) {
    p = loader.loadAsync(path).then((g) => g.scene);
    sourceCache.set(path, p);
  }
  return p;
}

// An "unusual" particle effect worn above the hat. Rebuilt as soft, additive
// SPRITE-PARTICLE systems (was rigid icosahedron/torus geometry) so they read
// like real flames / energy / storms — TF2 "unusual" style. Each effect is one
// THREE.Points cloud (a single draw call) using a soft radial sprite, with a
// per-particle size (injected `aSize` attribute) and per-particle color that has
// the life-alpha baked in (additive blending ignores per-vertex alpha, so we
// premultiply rgb by it). Animated on the CPU each frame. Materials/geometry are
// per-instance and disposed; the soft sprite texture is module-shared + cached.
// All FX materials are `toneMapped: false` so the ACES tonemap doesn't wash out
// the additive glow.

// Soft round particle sprite (white radial falloff → transparent), built once.
let softTex: THREE.Texture | null = null;
function softSprite(): THREE.Texture {
  if (softTex) return softTex;
  if (typeof document === 'undefined') {
    softTex = new THREE.Texture();
    return softTex;
  }
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  softTex = t;
  return t;
}

// Inject a per-particle size attribute into the built-in PointsMaterial shader,
// keeping three's correct distance attenuation. Defined once so every instance
// hashes to the same compiled program.
const injectPerParticleSize = (shader: { vertexShader: string }) => {
  shader.vertexShader =
    'attribute float aSize;\n' +
    shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;');
};

function particleMaterial(): THREE.PointsMaterial {
  const m = new THREE.PointsMaterial({
    map: softSprite(),
    size: 1,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    toneMapped: false,
  });
  m.onBeforeCompile = injectPerParticleSize;
  return m;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

type Particle = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number; // max === 1 marks "uninitialized" (first frame)
  seed: number;
};

// A fixed-capacity additive point cloud. The owner mutates `ps[i]` then calls
// `set(i, r,g,b, alpha, sizeMetres)` to stage the GPU buffers, and `commit()` once.
class ParticleField {
  readonly points: THREE.Points;
  readonly ps: Particle[] = [];
  private geom = new THREE.BufferGeometry();
  private mat = particleMaterial();
  private pos: Float32Array;
  private col: Float32Array;
  private siz: Float32Array;

  constructor(readonly n: number) {
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.siz = new Float32Array(n);
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geom.setAttribute('aSize', new THREE.BufferAttribute(this.siz, 1));
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false; // tiny crown cloud; never cull at screen edges
    for (let i = 0; i < n; i++) {
      this.ps.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, seed: Math.random() });
    }
  }

  set(i: number, r: number, g: number, b: number, a: number, size: number) {
    const p = this.ps[i];
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    // Premultiply color by alpha — additive blending has no per-vertex alpha.
    this.col[i * 3] = r * a; this.col[i * 3 + 1] = g * a; this.col[i * 3 + 2] = b * a;
    this.siz[i] = size;
  }

  commit() {
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geom.dispose();
    this.mat.dispose();
  }
}

const FIELD_COUNTS: Record<Exclude<UnusualKind, 'none'>, number> = {
  embers: 48, aura: 42, orbit: 46, halo: 60, storm: 26,
};

class UnusualEffect {
  readonly group = new THREE.Group();
  private field: ParticleField | null = null;
  // Storm only: a jagged additive lightning bolt that flashes intermittently.
  private boltGeom: THREE.BufferGeometry | null = null;
  private boltMat: THREE.LineBasicMaterial | null = null;
  private nextBolt = 0;
  private t = 0;

  constructor(private kind: UnusualKind) {
    // Small lift within the unusualAnchor, which WornHat already seats just above
    // the equipped hat's crown (so the effect tracks hat height, not the head).
    this.group.position.y = 0.06;
    this.build();
    this.group.traverse((o) => {
      o.userData.shared = true;
    });
  }

  private build() {
    const n = this.kind === 'none' ? 0 : FIELD_COUNTS[this.kind] ?? 0;
    if (n <= 0) return;
    this.field = new ParticleField(n);
    this.group.add(this.field.points);
    if (this.kind === 'storm') {
      const SEGS = 7;
      this.boltGeom = new THREE.BufferGeometry();
      this.boltGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEGS * 3), 3));
      this.boltMat = new THREE.LineBasicMaterial({
        color: 0xdcefff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      this.group.add(new THREE.Line(this.boltGeom, this.boltMat));
    }
  }

  update(dt: number) {
    this.t += dt;
    const f = this.field;
    if (!f) return;
    switch (this.kind) {
      // hot-core, mid-flame, cool-tip color ramp + base radius + rise speed.
      case 'embers': this.flame(dt, f, [1.0, 0.96, 0.62], [1.0, 0.46, 0.08], [0.55, 0.05, 0.0], 0.05, 0.34); break;
      case 'aura':   this.flame(dt, f, [1.0, 0.92, 0.55], [0.98, 0.66, 0.16], [0.55, 0.34, 0.04], 0.06, 0.24); break;
      case 'orbit':  this.orbit(f); break;
      case 'halo':   this.halo(f); break;
      case 'storm':  this.storm(dt, f); break;
    }
    f.commit();
  }

  // Rising, flickering flames — the TF2-style "burning" look. Particles respawn
  // at the crown base and lick upward through a hot→mid→cool color ramp, shrinking
  // and fading as they rise, with per-particle turbulence so the fire wavers.
  private flame(dt: number, f: ParticleField, hot: number[], mid: number[], cool: number[], radius: number, rise: number) {
    const t = this.t;
    for (let i = 0; i < f.n; i++) {
      const p = f.ps[i];
      if (p.max === 1) this.spawnFlame(p, radius, rise, true); // first frame: staggered
      p.life += dt;
      if (p.life >= p.max) this.spawnFlame(p, radius, rise, false); // recycle at base
      // Buoyancy + sideways turbulence that grows with height (a licking flame).
      p.vy += 0.25 * dt;
      p.x += (p.vx + Math.sin(t * 7 + p.seed * 31) * 0.06 * p.y) * dt;
      p.z += (p.vz + Math.cos(t * 6 + p.seed * 27) * 0.06 * p.y) * dt;
      p.y += p.vy * dt;
      const fr = Math.min(1, p.life / p.max);
      let r, g, b;
      if (fr < 0.5) { const k = fr / 0.5; r = mix(hot[0], mid[0], k); g = mix(hot[1], mid[1], k); b = mix(hot[2], mid[2], k); }
      else { const k = (fr - 0.5) / 0.5; r = mix(mid[0], cool[0], k); g = mix(mid[1], cool[1], k); b = mix(mid[2], cool[2], k); }
      const flicker = 0.82 + 0.18 * Math.sin(t * 26 + p.seed * 50);
      const alpha = Math.min(1, fr * 5) * (1 - fr) * flicker; // fade in fast, out slow
      f.set(i, r, g, b, alpha, mix(0.09, 0.02, fr));
    }
  }

  private spawnFlame(p: Particle, radius: number, rise: number, stagger: boolean) {
    p.max = 0.5 + Math.random() * 0.45;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * radius;
    p.x = Math.cos(a) * rr;
    p.z = Math.sin(a) * rr;
    p.vx = Math.cos(a) * 0.02;
    p.vz = Math.sin(a) * 0.02;
    p.vy = rise * (0.7 + Math.random() * 0.6);
    p.seed = Math.random();
    if (stagger) {
      // Spread initial particles across their lifecycle (and up the column) so the
      // flame doesn't puff in all at once when first equipped / previewed.
      p.life = Math.random() * p.max;
      p.y = p.life * p.vy;
    } else {
      p.life = p.life >= p.max ? p.life - p.max : 0;
      p.y = 0;
    }
  }

  // Two interleaved counter-rotating rings of glowing energy motes, pulsing.
  private orbit(f: ParticleField) {
    const t = this.t;
    for (let i = 0; i < f.n; i++) {
      const p = f.ps[i];
      const ring = i % 2;
      const a = p.seed * Math.PI * 2 + t * (ring ? -1.5 : 2.0);
      const rad = ring ? 0.13 : 0.185;
      p.x = Math.cos(a) * rad;
      p.z = Math.sin(a) * rad;
      p.y = 0.03 + 0.03 * Math.sin(a * 2 + t);
      const pulse = 0.5 + 0.5 * Math.sin(t * 4 + p.seed * 12);
      f.set(i, mix(0.35, 0.8, pulse), mix(0.82, 0.98, pulse), 1.0, 0.5 + 0.5 * pulse, 0.03 + 0.022 * pulse);
    }
  }

  // A luminous golden ring with a bright crest travelling around it.
  private halo(f: ParticleField) {
    const t = this.t;
    for (let i = 0; i < f.n; i++) {
      const p = f.ps[i];
      const a = (i / f.n) * Math.PI * 2 + t * 0.6;
      p.x = Math.cos(a) * 0.165;
      p.z = Math.sin(a) * 0.165;
      p.y = 0.012 * Math.sin(a * 3 + t * 2);
      const crest = 0.5 + 0.5 * Math.pow(Math.max(0, Math.sin(a - t * 2)), 6);
      f.set(i, 1.0, 0.93, mix(0.62, 0.9, crest), 0.4 + 0.6 * crest, 0.028 + 0.024 * crest);
    }
  }

  // A small thundercloud (soft puffs) with falling rain sparks and a jagged
  // lightning bolt that flashes at random intervals.
  private storm(dt: number, f: ParticleField) {
    const t = this.t;
    const CLOUD = 9;
    for (let i = 0; i < f.n; i++) {
      const p = f.ps[i];
      if (i < CLOUD) {
        const a = (i / CLOUD) * Math.PI * 2;
        p.x = Math.cos(a) * 0.06 + Math.sin(t * 0.6 + i) * 0.012;
        p.z = Math.sin(a) * 0.05 + Math.cos(t * 0.5 + i) * 0.012;
        p.y = 0.13 + 0.015 * Math.sin(t + i);
        f.set(i, 0.55, 0.63, 0.78, 0.5, 0.12);
      } else {
        if (p.max === 1) { p.max = 0.4 + Math.random() * 0.3; p.life = Math.random() * p.max; }
        p.life += dt;
        if (p.life >= p.max) {
          p.max = 0.4 + Math.random() * 0.3;
          p.life = 0;
          p.x = (Math.random() - 0.5) * 0.12;
          p.z = (Math.random() - 0.5) * 0.10;
          p.y = 0.12;
        }
        p.y -= 0.5 * dt;
        f.set(i, 0.62, 0.82, 1.0, (1 - p.life / p.max) * 0.9, 0.022);
      }
    }
    this.nextBolt -= dt;
    if (this.boltMat && this.boltGeom) {
      let op = this.boltMat.opacity - dt * 6; // decay the previous flash
      if (this.nextBolt <= 0) {
        this.nextBolt = 0.7 + Math.random() * 1.7;
        const attr = this.boltGeom.getAttribute('position') as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        const segs = arr.length / 3;
        for (let s = 0; s < segs; s++) {
          const k = s / (segs - 1);
          arr[s * 3] = (Math.random() - 0.5) * 0.05;
          arr[s * 3 + 1] = 0.12 - k * 0.17;
          arr[s * 3 + 2] = (Math.random() - 0.5) * 0.03;
        }
        attr.needsUpdate = true;
        op = 1;
      }
      this.boltMat.opacity = Math.max(0, op);
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.field?.dispose();
    this.boltGeom?.dispose();
    this.boltMat?.dispose();
  }
}

// One worn hat instance. The container is parented to the wearer's top-level
// `group` (not the cm-scaled rig), so it inherits position/visibility — but it's
// re-seated each frame from the head bone's WORLD transform.
export class WornHat {
  private container = new THREE.Group();
  // Anchor the unusual effect rides in — its local Y tracks the top of the
  // equipped hat so the effect crowns the hat (not the head) regardless of height.
  private unusualAnchor = new THREE.Group();
  private head: THREE.Object3D | null;
  private current = ''; // equipped hat id
  private token = 0; // guards against a slow load finishing after a later setHat
  private unusual: UnusualEffect | null = null;
  private unusualKind: UnusualKind = 'none';
  private sink = 0; // per-hat downward seat offset (metres), set on setHat
  private hatTop = 0.12; // top of the equipped hat in container-local metres
  private readonly tmp = new THREE.Vector3();
  private readonly crown = new THREE.Vector3();
  private readonly headWorldQ = new THREE.Quaternion();
  private readonly parentWorldQ = new THREE.Quaternion();
  private readonly headToHatQ = new THREE.Quaternion();

  constructor(
    private parent: THREE.Object3D,
    private modelRoot: THREE.Object3D,
  ) {
    this.head =
      modelRoot.getObjectByName('mixamorigHead') ??
      modelRoot.getObjectByName('mixamorig:Head') ??
      modelRoot.getObjectByName('Head') ??
      null;
    if (this.head) {
      // At bind pose, hats should share the model root's orientation, not the
      // Mixamo head bone's rotated local frame. Preserve that correction and
      // apply it to the animated head transform each frame.
      this.head.updateWorldMatrix(true, false);
      this.head.getWorldQuaternion(this.headWorldQ);
      this.modelRoot.getWorldQuaternion(this.headToHatQ);
      this.headToHatQ.premultiply(this.headWorldQ.clone().invert());
    }
    this.container.add(this.unusualAnchor);
    parent.add(this.container);
  }

  // Equip a hat by cosmetic id (e.g. 'hat.tophat'); 'hat.none' / unknown = bare.
  async setHat(id: string): Promise<void> {
    if (id === this.current) return;
    this.current = id;
    const my = ++this.token;
    this.clearMesh();
    const hat = hatById(id);
    this.sink = 0;
    this.hatTop = 0.12; // bare-head baseline for the unusual anchor
    if (!hat.model) {
      this.layoutUnusual();
      return; // bare-headed
    }
    let src: THREE.Object3D;
    try {
      src = await loadHatSource(hat.model);
    } catch {
      return; // missing/broken model → just stay bare
    }
    if (this.token !== my) return; // superseded by a later setHat

    const mesh = src.clone(true);
    // Center on X/Z and drop the bottom to Y=0 (at native scale), then uniformly
    // scale so the widest horizontal extent is TARGET_WIDTH. (The catalog only
    // ships hats with clean geometry — two malformed CC0 assets whose vertices
    // were scattered across ~500k units were dropped rather than special-cased.)
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.set(-center.x, -box.min.y, -center.z);
    const holder = new THREE.Group();
    holder.add(mesh);
    // Uniform fit by the widest horizontal extent (brim/blade span), then an
    // optional vertical `stretch` so silhouette-by-height hats (top hat) aren't
    // crushed flat by a wide brim, and a `sink` that drops brim/skull-cap style
    // hats down around the head instead of perching on its bounding-box floor.
    const s = ((hat.fit ?? 1) * TARGET_WIDTH) / Math.max(size.x, size.z, 1e-6);
    holder.scale.set(s, s * (hat.stretch ?? 1), s);
    // Per-hat yaw so the brim faces the wearer's front — the catalog's models
    // don't agree on a forward axis (the ballcap's brim runs down −Z, the plain
    // cap's down its own X), so each hat declares the spin that points it forward.
    holder.rotation.y = hat.yaw ?? 0;
    this.sink = hat.sink ?? 0;
    this.hatTop = size.y * s * (hat.stretch ?? 1) - this.sink;
    // Tag shared so Game.disposeScene() never disposes the cached geometry.
    holder.traverse((o) => {
      o.userData.shared = true;
    });
    this.container.add(holder);
    this.layoutUnusual();
  }

  // Seat the unusual anchor just above the equipped hat's crown.
  private layoutUnusual() {
    this.unusualAnchor.position.y = Math.max(this.hatTop, 0.04) + 0.05;
  }

  // Equip an unusual particle effect (worn above the hat). 'unusual.none' = off.
  setUnusual(id: string): void {
    const kind = unusualById(id).kind;
    if (kind === this.unusualKind) return;
    this.unusualKind = kind;
    this.unusual?.dispose();
    this.unusual = null;
    if (kind !== 'none') {
      this.unusual = new UnusualEffect(kind);
      this.unusualAnchor.add(this.unusual.group);
    }
  }

  // Seat the hat on the wearer's head each frame. Updates the bone's world matrix
  // first (the animation mixer only writes bone-LOCAL transforms), then converts
  // the corrected head world transform into the parent group's local frame.
  update(dt: number): void {
    this.unusual?.update(dt);
    if (!this.head) return;
    this.head.updateWorldMatrix(true, false); // refresh head + ancestors' world matrices
    this.head.getWorldPosition(this.tmp);
    this.head.getWorldQuaternion(this.headWorldQ);
    this.headWorldQ.multiply(this.headToHatQ);
    // Move from the head bone to the crown along the animated hat-up direction.
    // A global-Y offset is what made hats hover separately as the head tilted.
    this.crown.set(0, CROWN_OFFSET - this.sink, 0).applyQuaternion(this.headWorldQ);
    this.tmp.add(this.crown);
    // worldToLocal inverts the parent's full matrixWorld, so this stays correct
    // even when the parent group is rotated/animated (e.g. the podium + Locker
    // preview spin/sway the group) — do NOT replace it with a raw subtraction.
    this.parent.worldToLocal(this.tmp);
    this.container.position.copy(this.tmp);
    // Express the corrected world orientation in the container parent's frame.
    // This keeps podium/Locker outer-group spins from being counted twice.
    this.parent.getWorldQuaternion(this.parentWorldQ);
    this.container.quaternion.copy(this.parentWorldQ).invert().multiply(this.headWorldQ);
  }

  setVisible(v: boolean): void {
    this.container.visible = v;
  }

  // Remove the hat holder(s) but KEEP the unusualAnchor (it carries the effect
  // and is re-seated by layoutUnusual on the next setHat).
  private clearMesh(): void {
    for (let i = this.container.children.length - 1; i >= 0; i--) {
      const c = this.container.children[i];
      if (c !== this.unusualAnchor) this.container.remove(c);
    }
  }

  dispose(): void {
    this.unusual?.dispose();
    this.unusual = null;
    this.clearMesh();
    this.parent.remove(this.container);
    this.head = null;
  }
}
