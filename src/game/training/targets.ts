import * as THREE from 'three';
import type { Vec3 } from '../types';
import type { RailTarget } from '../weapon';

// Hologram practice targets: a core sphere + a spinning ring, coloured by
// kind. They're rail targets only (no collision), raycast like bots.
//   static    free-practice targets; respawn in place shortly after a hit
//   flick     Flick challenge: pops up, shrinks away when its life runs out
//   gauntlet  course targets; stay up until hit or the run ends
// (Strafers are full player models — see strafers.ts; they share the lane
// motion below.) All motion is dt-driven; spawn-in / expiry are scale
// animations so the shared per-kind materials never need per-target opacity.

export const TARGET_RADIUS = 0.42;
const GRAVITY = 25;
const HOP_SPEED = 8.2; // ≈1.35 m hop, a strafing player's jump
const RESPAWN_STATIC = 0.55;

export type TargetKind = 'static' | 'flick' | 'gauntlet';

const KIND_COLOR: Record<TargetKind, { core: number; ring: number }> = {
  static: { core: 0x37a6ff, ring: 0x8af2ff },
  flick: { core: 0xff9f2e, ring: 0xffd27a },
  gauntlet: { core: 0x2fe39a, ring: 0xa6ffd8 },
};

// A body sliding along a straight lane a→b with ADAD jukes and the odd hop,
// like a strafing player. `hop` is the height above the lane.
export type Mover = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  len: number;
  s: number; // distance along the lane
  v: number; // signed speed along the lane (m/s)
  speed: number;
  jukeIn: number;
  hop: number; // height above the lane
  vy: number;
};

export function makeMover(a: Vec3, b: Vec3, speed: number): Mover {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const len = Math.max(0.1, va.distanceTo(vb));
  return {
    a: va, b: vb, len,
    s: Math.random() * len, // start anywhere along the lane
    v: (Math.random() < 0.5 ? -1 : 1) * speed,
    speed,
    jukeIn: 0.3 + Math.random() * 0.8,
    hop: 0,
    vy: 0,
  };
}

// Advance a mover by dt and write its position (lane point + hop) into `out`.
export function stepMover(m: Mover, dt: number, out: THREE.Vector3): THREE.Vector3 {
  m.jukeIn -= dt;
  if (m.jukeIn <= 0) {
    // ADAD: usually reverse, sometimes keep going at a new pace; the odd hop,
    // like a player jumping mid-strafe.
    m.jukeIn = 0.28 + Math.random() * 0.9;
    const dir = Math.random() < 0.72 ? -Math.sign(m.v) : Math.sign(m.v);
    m.v = dir * m.speed * (0.75 + Math.random() * 0.45);
    if (m.hop === 0 && Math.random() < 0.3) m.vy = HOP_SPEED;
  }
  m.s += m.v * dt;
  if (m.s < 0) {
    m.s = -m.s;
    m.v = Math.abs(m.v);
  } else if (m.s > m.len) {
    m.s = 2 * m.len - m.s;
    m.v = -Math.abs(m.v);
  }
  if (m.vy !== 0 || m.hop > 0) {
    m.vy -= GRAVITY * dt;
    m.hop += m.vy * dt;
    if (m.hop <= 0) {
      m.hop = 0;
      m.vy = 0;
    }
  }
  out.copy(m.a).lerp(m.b, m.s / m.len);
  out.y += m.hop;
  return out;
}

type Target = {
  id: string;
  kind: TargetKind;
  group: THREE.Group;
  ring: THREE.Mesh;
  home: THREE.Vector3; // rest position (static / flick / gauntlet)
  alive: boolean;
  respawnIn: number; // static: seconds until it's back after a hit
  life: number; // flick: seconds left (Infinity otherwise)
  lifeMax: number;
  grow: number; // 0 → 1 spawn-in
  age: number; // seconds since it (re)appeared
  phase: number;
};

// `age` = seconds the target had been up (Flick's reaction time).
export type TargetHit = { kind: TargetKind; pos: THREE.Vector3; age: number };

const smooth = (k: number, dt: number) => 1 - Math.exp(-k * dt);

export class TargetField {
  private list: Target[] = [];
  private nextId = 0;
  private t = 0;
  private readonly geoCore = new THREE.SphereGeometry(TARGET_RADIUS, 18, 12);
  private readonly geoRing = new THREE.TorusGeometry(TARGET_RADIUS + 0.16, 0.045, 8, 28);
  private readonly mats = new Map<TargetKind, { core: THREE.MeshBasicMaterial; ring: THREE.MeshBasicMaterial }>();

  constructor(private scene: THREE.Scene) {
    for (const kind of Object.keys(KIND_COLOR) as TargetKind[]) {
      const c = KIND_COLOR[kind];
      this.mats.set(kind, {
        core: new THREE.MeshBasicMaterial({ color: c.core, transparent: true, opacity: 0.62 }),
        ring: new THREE.MeshBasicMaterial({
          color: c.ring, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      });
    }
  }

  private make(kind: TargetKind, at: Vec3): Target {
    const m = this.mats.get(kind)!;
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.geoCore, m.core);
    const ring = new THREE.Mesh(this.geoRing, m.ring);
    group.add(core, ring);
    group.traverse((o) => (o.userData.shared = true));
    group.position.set(at.x, at.y, at.z);
    group.scale.setScalar(0.01);
    this.scene.add(group);
    const t: Target = {
      id: `tg${this.nextId++}`,
      kind,
      group,
      ring,
      home: new THREE.Vector3(at.x, at.y, at.z),
      alive: true,
      respawnIn: 0,
      life: Infinity,
      lifeMax: Infinity,
      grow: 0,
      age: 0,
      phase: Math.random() * Math.PI * 2,
    };
    this.list.push(t);
    return t;
  }

  spawnStatic(at: Vec3): string {
    return this.make('static', at).id;
  }

  spawnFlick(at: Vec3, life: number): string {
    const t = this.make('flick', at);
    t.life = life;
    t.lifeMax = life;
    return t.id;
  }

  spawnGauntlet(at: Vec3): string {
    return this.make('gauntlet', at).id;
  }

  // Positions currently occupied by live (or respawning) targets of a kind.
  occupied(kind: TargetKind): THREE.Vector3[] {
    return this.list.filter((t) => t.kind === kind).map((t) => t.home);
  }

  count(kind: TargetKind): number {
    return this.list.reduce((n, t) => n + (t.kind === kind && t.alive ? 1 : 0), 0);
  }

  // Remove every target of the given kinds (all when omitted).
  clear(kinds?: TargetKind[]) {
    const keep: Target[] = [];
    for (const t of this.list) {
      if (!kinds || kinds.includes(t.kind)) this.scene.remove(t.group);
      else keep.push(t);
    }
    this.list = keep;
  }

  private remove(t: Target) {
    this.scene.remove(t.group);
    this.list = this.list.filter((x) => x !== t);
  }

  railTargets(): RailTarget[] {
    const out: RailTarget[] = [];
    for (const t of this.list) {
      if (!t.alive || t.grow < 0.35) continue; // not shootable until it has popped in
      const p = t.group.position;
      out.push({
        kind: 'target',
        id: t.id,
        name: 'Target',
        bounds: {
          min: { x: p.x - TARGET_RADIUS, y: p.y - TARGET_RADIUS, z: p.z - TARGET_RADIUS },
          max: { x: p.x + TARGET_RADIUS, y: p.y + TARGET_RADIUS, z: p.z + TARGET_RADIUS },
        },
        headshotY: p.y + TARGET_RADIUS * 0.33,
        centerY: p.y,
      });
    }
    return out;
  }

  // A rail hit: statics drop and respawn in place; everything else is removed.
  hit(id: string): TargetHit | null {
    const t = this.list.find((x) => x.id === id && x.alive);
    if (!t) return null;
    const res = { kind: t.kind, pos: t.group.position.clone(), age: t.age };
    if (t.kind === 'static') {
      t.alive = false;
      t.group.visible = false;
      t.respawnIn = RESPAWN_STATIC;
    } else {
      this.remove(t);
    }
    return res;
  }

  // Steps motion; flick targets whose life runs out are removed. Returns how
  // many timed out this step.
  update(dt: number): number {
    this.t += dt;
    let expired = 0;
    for (const t of [...this.list]) {
      if (!t.alive) {
        t.respawnIn -= dt;
        if (t.respawnIn <= 0) {
          t.alive = true;
          t.group.visible = true;
          t.grow = 0;
          t.age = 0;
          t.group.scale.setScalar(0.01);
        }
        continue;
      }
      t.age += dt;
      t.grow += (1 - t.grow) * smooth(14, dt);
      let scale = t.grow;
      if (t.life !== Infinity) {
        t.life -= dt;
        if (t.life <= 0) {
          this.remove(t);
          expired += 1;
          continue;
        }
        // Shrink over the last 0.5 s so an expiring target reads as leaving.
        scale *= Math.min(1, 0.35 + (t.life / 0.5) * 0.65);
      }
      t.group.scale.setScalar(Math.max(0.01, scale));
      t.ring.rotation.z += dt * 1.6;
      t.ring.rotation.x = Math.PI / 2 + Math.sin(this.t + t.phase) * 0.3;
      // Gentle bob so still targets read as live.
      t.group.position.y = t.home.y + Math.sin(this.t * 1.5 + t.phase) * 0.1;
    }
    return expired;
  }

  dispose() {
    this.clear();
    this.geoCore.dispose();
    this.geoRing.dispose();
    for (const m of this.mats.values()) {
      m.core.dispose();
      m.ring.dispose();
    }
    this.mats.clear();
  }
}
