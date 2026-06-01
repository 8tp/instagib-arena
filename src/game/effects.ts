import * as THREE from 'three';
import type { KillEffectStyle, SpawnEffectStyle } from './cosmetics';

type Burst = {
  group: THREE.Group;
  remaining: number;
  total: number;
  velocities: THREE.Vector3[];
  gravity: number;
  grow?: number; // uniform scale growth per second (shockwave rings / flashes)
  fadePow?: number; // opacity = lifeFrac^fadePow ( >1 = snappier fade-out )
};

export class EffectsManager {
  private bursts: Burst[] = [];
  private quality = 1; // 1 = full particle counts; <1 thins sprays (low-spec)

  setQuality(q: number) {
    this.quality = Math.max(0.25, Math.min(1, q));
  }

  // Tiny sparkle at impact point. Particles fade fast and don't spread far,
  // so they never obscure the view.
  spawnHitFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x99ddff) {
    const count = 4;
    const group = new THREE.Group();
    const vels: THREE.Vector3[] = [];
    const geom = new THREE.SphereGeometry(0.03, 5, 4);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const m = new THREE.Mesh(geom, mat);
      m.position.copy(at);
      group.add(m);
      const theta = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 0.8;
      vels.push(
        new THREE.Vector3(
          Math.cos(theta) * speed * 0.4,
          1.2 + Math.random() * 0.8,
          Math.sin(theta) * speed * 0.4,
        ),
      );
    }
    scene.add(group);
    this.bursts.push({
      group,
      remaining: 0.22,
      total: 0.22,
      velocities: vels,
      gravity: 6,
    });
  }

  // Muzzle flash: a brief bright additive burst at the gun muzzle on fire.
  spawnMuzzleFlash(scene: THREE.Scene, at: THREE.Vector3, color = 0x9fe8ff) {
    const group = new THREE.Group();
    const geom = new THREE.SphereGeometry(0.14, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geom, mat);
    m.position.copy(at);
    group.add(m);
    scene.add(group);
    this.bursts.push({
      group,
      remaining: 0.07,
      total: 0.07,
      velocities: [new THREE.Vector3(0, 0, 0)],
      gravity: 0,
    });
  }

  // Kill effect: a punchy pop at the kill that confirms the frag without
  // blocking the view. The STYLE is a cosmetic (see cosmetics.ts) modelled on
  // Ratz Instagib's selectable death animations + Quakecraft's firework
  // "barrels" — pure visual, never a gameplay advantage. Headshots tint amber.
  // Every style is additive + brief; `pulse` is the free default and is
  // byte-for-byte the original three-part burst.
  spawnKillBurst(
    scene: THREE.Scene,
    at: THREE.Vector3,
    headshot = false,
    style: KillEffectStyle = 'pulse',
  ) {
    switch (style) {
      case 'nova': return this.killNova(scene, at, headshot);
      case 'starburst': return this.killStarburst(scene, at, headshot);
      case 'voxel': return this.killVoxel(scene, at, headshot);
      case 'ember': return this.killEmber(scene, at, headshot);
      case 'gibstorm': return this.killGibstorm(scene, at, headshot);
      case 'singularity': return this.killSingularity(scene, at, headshot);
      case 'pulse':
      default:
        return this.killPulse(scene, at, headshot);
    }
  }

  // ── Shared burst primitives ────────────────────────────────────────────────
  private additive(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  // Push one group of meshes as a burst. `velocities` index-aligns with the
  // meshes in `meshes` order (a mesh with no matching velocity simply holds).
  private emit(
    scene: THREE.Scene,
    meshes: THREE.Mesh[],
    life: number,
    opts: { velocities?: THREE.Vector3[]; gravity?: number; grow?: number; fadePow?: number } = {},
  ) {
    const group = new THREE.Group();
    for (const m of meshes) group.add(m);
    scene.add(group);
    this.bursts.push({
      group,
      remaining: life,
      total: life,
      velocities: opts.velocities ?? [],
      gravity: opts.gravity ?? 0,
      grow: opts.grow,
      fadePow: opts.fadePow,
    });
  }

  private flash(at: THREE.Vector3, color: number, radius: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), this.additive(color));
    m.position.copy(at);
    return m;
  }

  private ring(at: THREE.Vector3, color: number, r: number, tube: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 24), this.additive(color));
    m.position.copy(at);
    m.rotation.x = Math.PI / 2; // lie flat in the horizontal plane
    return m;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  // The original: bright flash + expanding shockwave ring + upward gib spray.
  private killPulse(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const hot = headshot ? 0xffe08a : 0xa8f0ff;
    const spark = headshot ? 0xffc24d : 0xff6b8a;
    const center = new THREE.Vector3(at.x, at.y + 0.3, at.z);
    this.emit(scene, [this.flash(center, hot, 0.22)], 0.16, { grow: 7, fadePow: 1.8 });
    this.emit(scene, [this.ring(center, hot, 0.18, 0.04)], 0.3, { grow: 9, fadePow: 1.4 });
    const [m, v] = this.spray(at, spark, { count: 14, y: 0.6, radial: [1.6, 1.8], up: [4.5, 3], size: 0.06 });
    this.emit(scene, m, 0.5, { velocities: v, gravity: 11, fadePow: 1.2 });
  }

  // Nova: a big energy bloom with twin shockwave rings and a light spray.
  private killNova(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const hot = headshot ? 0xffe6a0 : 0x9fdcff;
    const center = new THREE.Vector3(at.x, at.y + 0.4, at.z);
    this.emit(scene, [this.flash(center, hot, 0.28)], 0.2, { grow: 9, fadePow: 1.6 });
    this.emit(scene, [this.ring(center, hot, 0.16, 0.05)], 0.34, { grow: 14, fadePow: 1.3 });
    this.emit(scene, [this.ring(center, hot, 0.1, 0.03)], 0.44, { grow: 9, fadePow: 1.5 });
    const [m, v] = this.spray(at, hot, { count: 8, y: 0.5, radial: [1.2, 1.2], up: [2.5, 2], size: 0.05 });
    this.emit(scene, m, 0.4, { velocities: v, gravity: 9, fadePow: 1.2 });
  }

  // Starburst: a flat-ish radial star of light spikes that fire outward.
  private killStarburst(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const hot = headshot ? 0xffd27a : 0x8ad8ff;
    const center = new THREE.Vector3(at.x, at.y + 0.4, at.z);
    this.emit(scene, [this.flash(center, hot, 0.18)], 0.14, { grow: 6, fadePow: 1.8 });
    const spikes: THREE.Mesh[] = [];
    const vels: THREE.Vector3[] = [];
    const count = 12;
    const geom = new THREE.BoxGeometry(0.04, 0.04, 0.42);
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2;
      const tilt = (Math.random() - 0.5) * 0.5;
      const dir = new THREE.Vector3(Math.cos(theta), tilt, Math.sin(theta)).normalize();
      const m = new THREE.Mesh(geom, this.additive(hot));
      m.position.copy(center);
      m.rotation.y = Math.atan2(dir.x, dir.z); // align the box's long (+Z) axis outward
      m.rotation.x = -Math.asin(dir.y);
      spikes.push(m);
      vels.push(dir.multiplyScalar(3.6));
    }
    this.emit(scene, spikes, 0.28, { velocities: vels, fadePow: 1.6 });
  }

  // Voxel: shatters the target into a burst of glowing cubes (Quake/Minecraft
  // homage), tumbling out and raining down.
  private killVoxel(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const hot = headshot ? 0xffe08a : 0x9fe8ff;
    const tints = headshot ? [0xffd27a, 0xffba5a] : [0x7fe6ff, 0xff6b8a];
    const center = new THREE.Vector3(at.x, at.y + 0.5, at.z);
    this.emit(scene, [this.flash(center, hot, 0.2)], 0.14, { grow: 6, fadePow: 1.8 });
    const cubes: THREE.Mesh[] = [];
    const vels: THREE.Vector3[] = [];
    const count = 16;
    const geom = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geom, this.additive(tints[i % tints.length]));
      m.position.copy(center);
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      cubes.push(m);
      const theta = Math.random() * Math.PI * 2;
      const radial = 1.8 + Math.random() * 1.6;
      vels.push(new THREE.Vector3(Math.cos(theta) * radial, 3.5 + Math.random() * 3, Math.sin(theta) * radial));
    }
    this.emit(scene, cubes, 0.6, { velocities: vels, gravity: 13, fadePow: 1.0 });
  }

  // Pyre: a rising column of fire with drifting embers.
  private killEmber(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const core = headshot ? 0xffd27a : 0xffb15a;
    const spark = headshot ? 0xffc24d : 0xff7b3a;
    const base = new THREE.Vector3(at.x, at.y + 0.3, at.z);
    this.emit(scene, [this.flash(base, core, 0.2)], 0.14, { grow: 5, fadePow: 1.8 });
    // Column: a tapered cylinder that rises and widens slightly.
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 0.9, 10, 1, true), this.additive(core));
    col.position.set(at.x, at.y + 0.7, at.z);
    this.emit(scene, [col], 0.26, { velocities: [new THREE.Vector3(0, 1.4, 0)], grow: 1.6, fadePow: 1.7 });
    // Embers: narrow cone of sparks biased strongly upward.
    const embers: THREE.Mesh[] = [];
    const vels: THREE.Vector3[] = [];
    const count = 16;
    const geom = new THREE.IcosahedronGeometry(0.05, 0);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geom, this.additive(spark));
      m.position.set(at.x, at.y + 0.3, at.z);
      embers.push(m);
      const theta = Math.random() * Math.PI * 2;
      const radial = 0.5 + Math.random() * 1.0;
      vels.push(new THREE.Vector3(Math.cos(theta) * radial, 4 + Math.random() * 4, Math.sin(theta) * radial));
    }
    this.emit(scene, embers, 0.7, { velocities: vels, gravity: 8, fadePow: 1.1 });
  }

  // Gibstorm: a heavier, more violent version of pulse — bigger flash, a ring,
  // and a dense spray of shards that rains down hard.
  private killGibstorm(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const hot = headshot ? 0xffe08a : 0xb8f2ff;
    const spark = headshot ? 0xffc24d : 0xff5577;
    const center = new THREE.Vector3(at.x, at.y + 0.4, at.z);
    this.emit(scene, [this.flash(center, hot, 0.24)], 0.16, { grow: 8, fadePow: 1.7 });
    this.emit(scene, [this.ring(center, hot, 0.2, 0.05)], 0.3, { grow: 11, fadePow: 1.3 });
    const [m, v] = this.spray(at, spark, { count: 26, y: 0.6, radial: [2.2, 2.4], up: [5, 3.5], size: 0.07 });
    this.emit(scene, m, 0.7, { velocities: v, gravity: 14, fadePow: 1.0 });
  }

  // Singularity: a ring collapses inward to a point, then a white-hot core
  // detonates with an outward spark spray.
  private killSingularity(scene: THREE.Scene, at: THREE.Vector3, headshot: boolean) {
    const core = headshot ? 0xfff0c0 : 0xffffff;
    const halo = headshot ? 0xffc24d : 0x4aa8ff;
    const center = new THREE.Vector3(at.x, at.y + 0.5, at.z);
    // Collapsing ring: negative grow shrinks it toward the center.
    this.emit(scene, [this.ring(center, halo, 0.5, 0.04)], 0.26, { grow: -3.2, fadePow: 0.6 });
    // Infalling motes converging on the point.
    const motes: THREE.Mesh[] = [];
    const inVels: THREE.Vector3[] = [];
    const ringN = 10;
    const moteGeom = new THREE.IcosahedronGeometry(0.045, 0);
    for (let i = 0; i < ringN; i++) {
      const theta = (i / ringN) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
      const m = new THREE.Mesh(moteGeom, this.additive(halo));
      m.position.copy(center).addScaledVector(dir, 0.5);
      motes.push(m);
      inVels.push(dir.multiplyScalar(-2.2));
    }
    this.emit(scene, motes, 0.22, { velocities: inVels, fadePow: 0.8 });
    // Detonation core + outward spray.
    this.emit(scene, [this.flash(center, core, 0.16)], 0.3, { grow: 7, fadePow: 2.2 });
    const [m, v] = this.spray(at, core, { count: 10, y: 0.5, radial: [2.4, 1.6], up: [1.5, 2.5], size: 0.05 });
    this.emit(scene, m, 0.4, { velocities: v, gravity: 6, fadePow: 1.4 });
  }

  // ── Spawn-in effects ────────────────────────────────────────────────────────
  // A materialize burst at a (re)spawn point. `at` is the player's FEET (ground).
  // Cosmetic-only; each style is a self-contained recipe. `beam` is the default.
  spawnInBurst(scene: THREE.Scene, at: THREE.Vector3, style: SpawnEffectStyle = 'beam') {
    switch (style) {
      case 'ring': return this.spawnRing(scene, at);
      case 'ember': return this.spawnEmberIn(scene, at);
      case 'rift': return this.spawnRift(scene, at);
      case 'beam':
      default: return this.spawnBeamIn(scene, at);
    }
  }

  // A vertical light column rising from the feet, additive + tapered.
  private column(at: THREE.Vector3, color: number, radius: number, height: number): THREE.Mesh {
    const geom = new THREE.CylinderGeometry(radius * 0.7, radius, height, 12, 1, true);
    const m = new THREE.Mesh(geom, this.additive(color));
    m.position.set(at.x, at.y + height / 2, at.z);
    return m;
  }

  // Teleport: a tall light column + an expanding ground ring + rising motes.
  private spawnBeamIn(scene: THREE.Scene, at: THREE.Vector3) {
    const hot = 0xa8f0ff;
    const col = 0x37a6ff;
    this.emit(scene, [this.column(at, hot, 0.16, 2.2)], 0.4, { grow: 1.0, fadePow: 1.6 });
    this.emit(scene, [this.ring(new THREE.Vector3(at.x, at.y + 0.05, at.z), col, 0.2, 0.045)], 0.42, { grow: 7, fadePow: 1.3 });
    this.emit(scene, [this.flash(new THREE.Vector3(at.x, at.y + 0.9, at.z), hot, 0.22)], 0.22, { grow: 4, fadePow: 1.8 });
    const [m, v] = this.spray(at, hot, { count: 12, y: 0.1, radial: [0.5, 0.6], up: [4.5, 2.5], size: 0.05 });
    this.emit(scene, m, 0.5, { velocities: v, gravity: 5, fadePow: 1.2 });
  }

  // Shockwave: a hard double ground ring + a bright ground flash. Low + wide.
  private spawnRing(scene: THREE.Scene, at: THREE.Vector3) {
    const hot = 0xbfeaff;
    const base = new THREE.Vector3(at.x, at.y + 0.06, at.z);
    this.emit(scene, [this.ring(base, hot, 0.18, 0.05)], 0.36, { grow: 13, fadePow: 1.3 });
    this.emit(scene, [this.ring(base, hot, 0.1, 0.03)], 0.46, { grow: 9, fadePow: 1.5 });
    this.emit(scene, [this.flash(base, hot, 0.2)], 0.2, { grow: 6, fadePow: 1.8 });
    const [m, v] = this.spray(at, 0x8ad8ff, { count: 10, y: 0.08, radial: [2.2, 1.4], up: [1.5, 1.5], size: 0.05 });
    this.emit(scene, m, 0.4, { velocities: v, gravity: 7, fadePow: 1.2 });
  }

  // Cinder: a warm column + a dense cone of rising embers.
  private spawnEmberIn(scene: THREE.Scene, at: THREE.Vector3) {
    const core = 0xffb15a;
    const spark = 0xff7b3a;
    this.emit(scene, [this.column(at, core, 0.13, 1.8)], 0.36, { grow: 0.8, fadePow: 1.7 });
    this.emit(scene, [this.flash(new THREE.Vector3(at.x, at.y + 0.2, at.z), core, 0.2)], 0.2, { grow: 4, fadePow: 1.8 });
    const embers: THREE.Mesh[] = [];
    const vels: THREE.Vector3[] = [];
    const geom = new THREE.IcosahedronGeometry(0.045, 0);
    for (let i = 0; i < 18; i++) {
      const mm = new THREE.Mesh(geom, this.additive(spark));
      mm.position.set(at.x, at.y + 0.1, at.z);
      embers.push(mm);
      const theta = Math.random() * Math.PI * 2;
      const radial = 0.3 + Math.random() * 0.9;
      vels.push(new THREE.Vector3(Math.cos(theta) * radial, 3.5 + Math.random() * 3.5, Math.sin(theta) * radial));
    }
    this.emit(scene, embers, 0.7, { velocities: vels, gravity: 7, fadePow: 1.1 });
  }

  // Rift: a violet vertical tear that flares, with motes drawn inward then out.
  private spawnRift(scene: THREE.Scene, at: THREE.Vector3) {
    const core = 0xe9d5ff;
    const halo = 0xa855f7;
    // A thin tall slab (the tear) that widens and fades.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.1, 0.08), this.additive(core));
    slab.position.set(at.x, at.y + 1.05, at.z);
    this.emit(scene, [slab], 0.34, { grow: 2.2, fadePow: 1.7 });
    this.emit(scene, [this.ring(new THREE.Vector3(at.x, at.y + 0.05, at.z), halo, 0.16, 0.04)], 0.4, { grow: 8, fadePow: 1.3 });
    // Infalling motes converging on the tear, then released upward by the flare.
    const motes: THREE.Mesh[] = [];
    const vels: THREE.Vector3[] = [];
    const geom = new THREE.IcosahedronGeometry(0.05, 0);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
      const mm = new THREE.Mesh(geom, this.additive(halo));
      mm.position.copy(at).addScaledVector(dir, 0.7).setY(at.y + 0.9);
      motes.push(mm);
      vels.push(dir.multiplyScalar(-2.0).setY(1.5));
    }
    this.emit(scene, motes, 0.4, { velocities: vels, gravity: -2, fadePow: 1.0 });
    this.emit(scene, [this.flash(new THREE.Vector3(at.x, at.y + 0.95, at.z), core, 0.18)], 0.28, { grow: 6, fadePow: 2.0 });
  }

  // Build a radial spark spray: `count` icosahedron motes from a point above the
  // kill, each flung out + up. Returns the meshes and their index-aligned
  // velocities to hand to emit().
  private spray(
    at: THREE.Vector3,
    color: number,
    o: { count: number; y: number; radial: [number, number]; up: [number, number]; size: number },
  ): [THREE.Mesh[], THREE.Vector3[]] {
    const meshes: THREE.Mesh[] = [];
    const velocities: THREE.Vector3[] = [];
    const geom = new THREE.IcosahedronGeometry(o.size, 0);
    const origin = new THREE.Vector3(at.x, at.y + o.y, at.z);
    const count = Math.max(2, Math.round(o.count * this.quality));
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geom, this.additive(color));
      m.position.copy(origin);
      meshes.push(m);
      const theta = Math.random() * Math.PI * 2;
      const radial = o.radial[0] + Math.random() * o.radial[1];
      velocities.push(
        new THREE.Vector3(Math.cos(theta) * radial, o.up[0] + Math.random() * o.up[1], Math.sin(theta) * radial),
      );
    }
    return [meshes, velocities];
  }

  step(dt: number, scene: THREE.Scene) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.remaining -= dt;
      const lifeFrac = Math.max(0, b.remaining / b.total);
      const opacity = b.fadePow ? Math.pow(lifeFrac, b.fadePow) : lifeFrac;
      const growStep = b.grow ? 1 + b.grow * dt : 1;
      let idx = 0;
      b.group.children.forEach((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh) return;
        const v = b.velocities[idx++];
        if (v) {
          m.position.addScaledVector(v, dt);
          v.y -= b.gravity * dt;
        }
        if (growStep !== 1) m.scale.multiplyScalar(growStep);
        (m.material as THREE.MeshBasicMaterial).opacity = opacity;
      });
      if (b.remaining <= 0) {
        this.disposeBurst(scene, b);
        this.bursts.splice(i, 1);
      }
    }
  }

  dispose(scene: THREE.Scene) {
    for (const b of this.bursts) this.disposeBurst(scene, b);
    this.bursts.length = 0;
  }

  private disposeBurst(scene: THREE.Scene, b: Burst) {
    scene.remove(b.group);
    b.group.children.forEach((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else (mat as THREE.Material).dispose();
    });
  }
}
