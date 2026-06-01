import * as THREE from 'three';
import type { ArenaMap } from './map';
import type { RailTarget } from './weapon';

// Training range: a real practice arena instead of an endless bot firefight. It
// places shootable hologram targets — a fixed set of STATIC targets (respawn
// shortly after you pop them) plus a few POP targets (appear at a free spot,
// fade if you don't hit them in time) for reaction/tracking — and tracks live
// accuracy / streak / time so a newcomer can drill aim and movement in safety.
// No return fire; misses just cost you a streak.

const STATIC_COUNT = 5;
const POP_COUNT = 3;
const POP_LIFETIME = 3.6; // seconds a pop target stays up before relocating
const RESPAWN_DELAY = 0.55; // seconds a popped static target stays down
const RADIUS = 0.42; // target sphere radius (head is the top third)

// Hand-validated anchor spots on the TRAINING map (clear of geometry, all
// visible from the spawn at (0,0,17) looking -Z), spread across distance/height.
const ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [-3, 1.7, 9], [4, 2.4, 6], [-8, 1.6, 1], [7, 3.1, -1], [-6, 2.9, -5],
  [1, 1.9, -7], [-11, 2.1, -10], [3, 3.6, -12], [-2, 1.4, -15], [9, 2.3, -8],
  [-14, 2.5, -3], [6, 1.6, 4], [-4, 3.2, -2], [10, 2.0, 2],
];

type Target = {
  id: string;
  group: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  anchorIndex: number;
  kind: 'static' | 'pop';
  alive: boolean;
  timer: number; // pop: time-left alive; static (dead): respawn countdown
  phase: number;
};

export type TrainingStats = {
  shots: number;
  hits: number;
  destroyed: number;
  streak: number;
  bestStreak: number;
  accuracy: number; // 0..1
  elapsed: number; // seconds
};

export class TrainingRange {
  private targets_: Target[] = [];
  private free = new Set<number>(); // anchor indices not currently occupied
  private geomCore: THREE.SphereGeometry;
  private geomRing: THREE.TorusGeometry;
  private mat: THREE.MeshBasicMaterial;
  private matHot: THREE.MeshBasicMaterial;
  private nextId = 0;
  private t = 0;
  private s: TrainingStats = {
    shots: 0, hits: 0, destroyed: 0, streak: 0, bestStreak: 0, accuracy: 0, elapsed: 0,
  };
  private readonly box = new THREE.Vector3();

  constructor(private scene: THREE.Scene, _map: ArenaMap) {
    this.geomCore = new THREE.SphereGeometry(RADIUS, 16, 12);
    this.geomRing = new THREE.TorusGeometry(RADIUS + 0.16, 0.045, 8, 28);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x37a6ff, transparent: true, opacity: 0.55 });
    this.matHot = new THREE.MeshBasicMaterial({
      color: 0x8af2ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < ANCHORS.length; i++) this.free.add(i);
    for (let i = 0; i < STATIC_COUNT; i++) this.spawn('static');
    for (let i = 0; i < POP_COUNT; i++) this.spawn('pop');
  }

  private spawn(kind: 'static' | 'pop') {
    if (this.free.size === 0) return;
    // Pick a random free anchor.
    const idxs = [...this.free];
    const anchorIndex = idxs[Math.floor(Math.random() * idxs.length)];
    this.free.delete(anchorIndex);
    const [x, y, z] = ANCHORS[anchorIndex];
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const core = new THREE.Mesh(this.geomCore, this.mat);
    const ring = new THREE.Mesh(this.geomRing, this.matHot);
    group.add(core, ring);
    group.userData.shared = true;
    group.traverse((o) => (o.userData.shared = true));
    this.scene.add(group);
    this.targets_.push({
      id: 't' + this.nextId++,
      group, core, ring, anchorIndex, kind,
      alive: true, timer: kind === 'pop' ? POP_LIFETIME : 0, phase: Math.random() * Math.PI * 2,
    });
  }

  // Active (alive) targets as RailTargets so the weapon raycast can hit them.
  targets(): RailTarget[] {
    const out: RailTarget[] = [];
    for (const t of this.targets_) {
      if (!t.alive) continue;
      const p = t.group.position;
      out.push({
        kind: 'target',
        id: t.id,
        name: 'Target',
        bounds: {
          min: { x: p.x - RADIUS, y: p.y - RADIUS, z: p.z - RADIUS },
          max: { x: p.x + RADIUS, y: p.y + RADIUS, z: p.z + RADIUS },
        },
        headshotY: p.y + RADIUS * 0.33, // upper third = head
        centerY: p.y,
      });
    }
    return out;
  }

  registerShot() {
    this.s.shots += 1;
    this.recalc();
  }

  // Called when a shot misses every target — breaks the streak.
  registerMiss() {
    this.s.streak = 0;
  }

  // Pop a hit target; returns its world position so the caller can spawn fx.
  onHit(id: string): THREE.Vector3 | null {
    const t = this.targets_.find((x) => x.id === id && x.alive);
    if (!t) return null;
    const pos = t.group.position.clone();
    this.s.hits += 1;
    this.s.destroyed += 1;
    this.s.streak += 1;
    if (this.s.streak > this.s.bestStreak) this.s.bestStreak = this.s.streak;
    this.recalc();
    if (t.kind === 'pop') {
      // Relocate the pop target to a fresh spot immediately.
      this.retire(t);
      this.spawn('pop');
    } else {
      // Static target goes down briefly, then respawns in place.
      t.alive = false;
      t.group.visible = false;
      t.timer = RESPAWN_DELAY;
    }
    return pos;
  }

  private retire(t: Target) {
    this.scene.remove(t.group);
    this.free.add(t.anchorIndex);
    this.targets_ = this.targets_.filter((x) => x !== t);
  }

  private recalc() {
    this.s.accuracy = this.s.shots > 0 ? this.s.hits / this.s.shots : 0;
  }

  update(dt: number) {
    this.t += dt;
    this.s.elapsed += dt;
    for (const t of this.targets_) {
      // Gentle bob + ring spin so targets read as "live".
      t.group.position.y = ANCHORS[t.anchorIndex][1] + Math.sin(this.t * 1.5 + t.phase) * 0.12;
      t.ring.rotation.z += dt * 1.4;
      t.ring.rotation.x = Math.PI / 2 + Math.sin(this.t + t.phase) * 0.25;
      if (!t.alive) {
        // Static target waiting to respawn.
        t.timer -= dt;
        if (t.timer <= 0) {
          t.alive = true;
          t.group.visible = true;
        }
        continue;
      }
      if (t.kind === 'pop') {
        t.timer -= dt;
        // Fade as it ages so the player sees it's about to relocate.
        const k = Math.max(0.25, Math.min(1, t.timer / 0.8));
        this.setOpacity(t, k);
        if (t.timer <= 0) {
          this.retire(t);
          this.spawn('pop');
        }
      }
    }
  }

  private setOpacity(t: Target, k: number) {
    (t.core.material as THREE.MeshBasicMaterial).opacity = 0.55 * k;
    (t.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * k;
  }

  stats(): TrainingStats {
    return this.s;
  }

  // Reset the run (stats + targets) without rebuilding the scene objects.
  reset() {
    this.s = { shots: 0, hits: 0, destroyed: 0, streak: 0, bestStreak: 0, accuracy: 0, elapsed: 0 };
  }

  dispose(scene: THREE.Scene) {
    for (const t of this.targets_) scene.remove(t.group);
    this.targets_ = [];
    this.geomCore.dispose();
    this.geomRing.dispose();
    this.mat.dispose();
    this.matHot.dispose();
  }
}
