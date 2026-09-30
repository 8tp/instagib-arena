import * as THREE from 'three';
import type { AABB } from '../types';
import type { GhostRecord } from './best';
import { Label } from './signs';

// Course visuals: checkpoint gate frames (hologram, no collision) with their
// numbers, and the ghost of your best run. Render-only.

export type GateState = 'idle' | 'next' | 'passed' | 'upcoming';

const GATE_COLOR: Record<GateState, number> = {
  idle: 0x6fd8ff,
  upcoming: 0x9aa4b2,
  next: 0x5cf2ff,
  passed: 0x3fe08f,
};
const GATE_OPACITY: Record<GateState, number> = { idle: 0.4, upcoming: 0.28, next: 1, passed: 0.55 };
const POST = 0.14;

export class GateFrames {
  private readonly geo = new THREE.BoxGeometry(1, 1, 1);
  private readonly gates: Array<{ group: THREE.Group; mat: THREE.MeshBasicMaterial; label: Label; state: GateState | null; finish: boolean }> = [];

  constructor(private scene: THREE.Scene, boxes: AABB[]) {
    boxes.forEach((b, i) => {
      const finish = i === boxes.length - 1;
      const mat = new THREE.MeshBasicMaterial({ color: GATE_COLOR.idle, transparent: true, opacity: 0.4, depthWrite: false });
      const group = new THREE.Group();
      const sx = b.max.x - b.min.x;
      const sz = b.max.z - b.min.z;
      const h = b.max.y - b.min.y;
      const alongX = sx >= sz; // the frame spans the wider axis
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const span = alongX ? sx : sz;
      const bar = (x: number, y: number, z: number, w: number, hh: number, d: number) => {
        const m = new THREE.Mesh(this.geo, mat);
        m.position.set(x, y, z);
        m.scale.set(w, hh, d);
        m.userData.shared = true;
        group.add(m);
      };
      const post = (off: number) =>
        alongX ? bar(cx + off, b.min.y + h / 2, cz, POST, h, POST) : bar(cx, b.min.y + h / 2, cz + off, POST, h, POST);
      post(-span / 2);
      post(span / 2);
      if (alongX) bar(cx, b.max.y, cz, span + POST, POST, POST);
      else bar(cx, b.max.y, cz, POST, POST, span + POST);
      scene.add(group);
      const label = new Label(scene, { x: cx, y: b.max.y + 0.75, z: cz }, finish ? 'FINISH' : String(i + 1), '#8af2ff', finish ? 2.4 : 1.1);
      this.gates.push({ group, mat, label, state: null, finish });
    });
    this.setAll('idle');
  }

  setAll(state: GateState) {
    this.gates.forEach((_, i) => this.set(i, state));
  }

  // During a run: passed gates green, the next one bright, the rest dim.
  progress(next: number) {
    this.gates.forEach((_, i) => this.set(i, i < next ? 'passed' : i === next ? 'next' : 'upcoming'));
  }

  private set(i: number, state: GateState) {
    const g = this.gates[i];
    if (g.state === state) return;
    g.state = state;
    const color = g.finish && state !== 'passed' ? 0xffd166 : GATE_COLOR[state];
    g.mat.color.setHex(color);
    g.mat.opacity = GATE_OPACITY[state];
    const css = `#${new THREE.Color(color).getHexString()}`;
    g.label.setText(g.finish ? 'FINISH' : String(i + 1), css);
    g.label.sprite.visible = state !== 'upcoming' || g.finish;
  }

  dispose() {
    for (const g of this.gates) {
      this.scene.remove(g.group);
      g.mat.dispose();
      g.label.dispose(this.scene);
    }
    this.gates.length = 0;
    this.geo.dispose();
  }
}

// Ghost of the best run: a translucent capsule following recorded feet
// positions (linear interpolation between samples).
export class Ghost {
  private readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.CapsuleGeometry(0.36, 1.05, 4, 10);
  private readonly mat = new THREE.MeshBasicMaterial({
    color: 0x9be8ff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  private rec: GhostRecord | null = null;

  constructor(private scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  play(rec: GhostRecord | undefined) {
    this.rec = rec ?? null;
    this.mesh.visible = !!this.rec;
  }

  stop() {
    this.rec = null;
    this.mesh.visible = false;
  }

  // Place the ghost at `t` seconds into its run; hide it once it has finished.
  // It fades out within a few metres of the player (`near`), so racing it
  // shoulder to shoulder never fills the screen.
  at(t: number, near?: { x: number; y: number; z: number }) {
    const r = this.rec;
    if (!r) return;
    const n = r.xyz.length / 3;
    const f = t / r.step;
    const i = Math.floor(f);
    if (i >= n - 1) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const k = f - i;
    const a = i * 3;
    const b = a + 3;
    this.mesh.position.set(
      r.xyz[a] + (r.xyz[b] - r.xyz[a]) * k,
      r.xyz[a + 1] + (r.xyz[b + 1] - r.xyz[a + 1]) * k + 0.9,
      r.xyz[a + 2] + (r.xyz[b + 2] - r.xyz[a + 2]) * k,
    );
    if (near) {
      const p = this.mesh.position;
      const d = Math.hypot(p.x - near.x, p.y - 0.9 - near.y, p.z - near.z);
      const f = Math.min(1, Math.max(0, (d - 1.5) / 3));
      this.mat.opacity = 0.32 * f;
      this.mesh.visible = f > 0.01;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
