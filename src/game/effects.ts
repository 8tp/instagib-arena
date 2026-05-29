import * as THREE from 'three';

type Burst = {
  group: THREE.Group;
  remaining: number;
  total: number;
  velocities: THREE.Vector3[];
  gravity: number;
};

export class EffectsManager {
  private bursts: Burst[] = [];

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

  // Kill effect: short vertical column of sparks rising above the bot.
  // Stays well above the player's eye-line so it never blocks the view,
  // even on point-blank kills.
  spawnKillBurst(scene: THREE.Scene, at: THREE.Vector3) {
    const count = 8;
    const group = new THREE.Group();
    const vels: THREE.Vector3[] = [];
    const geom = new THREE.IcosahedronGeometry(0.06, 0);
    // Spawn slightly above the bot's head so the column starts above eye level.
    const origin = new THREE.Vector3(at.x, at.y + 0.8, at.z);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(
          0.95 + Math.random() * 0.06,
          1,
          0.6 + Math.random() * 0.1,
        ),
        transparent: true,
      });
      const m = new THREE.Mesh(geom, mat);
      m.position.copy(origin);
      group.add(m);
      // Strongly vertical, tiny horizontal jitter
      const jitter = 0.6;
      const upSpeed = 5 + Math.random() * 2;
      vels.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * jitter,
          upSpeed,
          (Math.random() - 0.5) * jitter,
        ),
      );
    }
    scene.add(group);
    this.bursts.push({
      group,
      remaining: 0.45,
      total: 0.45,
      velocities: vels,
      gravity: 10,
    });
  }

  step(dt: number, scene: THREE.Scene) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.remaining -= dt;
      const lifeFrac = Math.max(0, b.remaining / b.total);
      let idx = 0;
      b.group.children.forEach((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh) return;
        const v = b.velocities[idx++];
        if (v) {
          m.position.addScaledVector(v, dt);
          v.y -= b.gravity * dt;
        }
        (m.material as THREE.MeshBasicMaterial).opacity = lifeFrac;
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
