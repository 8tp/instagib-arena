import * as THREE from 'three';
import { CharacterAnimator, type CharacterAnimInput } from '../character-anim';
import { Character } from '../character/character';
import { attachRailgun, disposeRailgun, type AttachedRailgun } from '../character/gun';
import { BOT_HEADSHOT_THRESHOLD, BOT_HEIGHT, BOT_RADIUS } from '../constants';
import { DEFAULT_RAILGUN_FINISH, railgunFinishById, type KillEffectStyle } from '../cosmetics';
import type { Vec3 } from '../types';
import type { RailTarget } from '../weapon';
import { makeMover, stepMover, type Mover } from './targets';

// Strafers: full player models (the same combatant, rig and animator the bots
// use) ADAD-strafing and hopping along the gallery's lanes, facing you with
// their rail up. The hitbox is a player's (BOT_RADIUS × BOT_HEIGHT AABB from
// the feet, headshots above BOT_HEADSHOT_THRESHOLD), so the drill matches
// real fights. A kill gibs the body with your finisher.
//
// Bodies are pooled: built on the first Strafers run, reused for every spawn,
// freed on dispose. The pool covers the bodies on the lanes plus the ones
// still gibbing.

const POOL = 6;
const ARMOUR = '#ff4fd8'; // the Strafers accent (pad, sign, HUD)
const GROW_HZ = 16;
const MODEL_YAW_OFFSET = Math.PI; // camera yaw → model-root yaw (as bots.ts)

type Body = {
  character: Character;
  anim: CharacterAnimator;
  gun: AttachedRailgun | null;
  group: THREE.Group;
  id: string;
  state: 'free' | 'live' | 'dying';
  mover: Mover | null;
  tag: string | null; // the lane key
  grow: number; // 0 → 1 spawn-in
};

const _look = new THREE.Vector3();

export class StraferSquad {
  private bodies: Body[] = [];
  private nextId = 0;
  private readonly animIn: CharacterAnimInput = { dt: 0, yaw: 0, pitch: 0, pos: new THREE.Vector3() };

  constructor(private scene: THREE.Scene) {}

  private build() {
    for (let i = 0; i < POOL; i++) {
      const character = new Character({ colorHex: ARMOUR });
      character.setLook(ARMOUR, 'highlight');
      const gun = attachRailgun(character, railgunFinishById(DEFAULT_RAILGUN_FINISH).data);
      const anim = new CharacterAnimator(character, { driveYaw: true, holdGun: true });
      const group = new THREE.Group();
      group.add(character.root);
      group.visible = false;
      this.scene.add(group);
      this.bodies.push({ character, anim, gun, group, id: '', state: 'free', mover: null, tag: null, grow: 0 });
    }
  }

  // A strafer on the lane a→b (FEET positions), starting at a random point.
  // Returns false when every body is busy (the caller retries next tick).
  spawn(a: Vec3, b: Vec3, speed: number, tag: string): boolean {
    if (!this.bodies.length) this.build();
    const body = this.bodies.find((x) => x.state === 'free');
    if (!body) return false;
    body.id = `st${this.nextId++}`;
    body.state = 'live';
    body.tag = tag;
    body.mover = makeMover(a, b, speed);
    body.grow = 0;
    stepMover(body.mover, 0, body.group.position);
    body.group.scale.setScalar(0.01);
    body.group.visible = true;
    body.anim.respawn(body.group.position);
    return true;
  }

  count(): number {
    return this.bodies.reduce((n, b) => n + (b.state === 'live' ? 1 : 0), 0);
  }

  // Lane keys of the live strafers.
  tags(): string[] {
    return this.bodies.filter((b) => b.state === 'live' && b.tag !== null).map((b) => b.tag as string);
  }

  owns(id: string): boolean {
    return this.bodies.some((b) => b.state === 'live' && b.id === id);
  }

  clear() {
    for (const b of this.bodies) this.release(b);
  }

  private release(b: Body) {
    b.state = 'free';
    b.mover = null;
    b.tag = null;
    b.group.visible = false;
  }

  railTargets(): RailTarget[] {
    const out: RailTarget[] = [];
    for (const b of this.bodies) {
      if (b.state !== 'live' || b.grow < 0.35) continue; // not shootable until it has popped in
      const p = b.group.position;
      out.push({
        kind: 'target',
        id: b.id,
        name: 'Strafer',
        bounds: {
          min: { x: p.x - BOT_RADIUS, y: p.y, z: p.z - BOT_RADIUS },
          max: { x: p.x + BOT_RADIUS, y: p.y + BOT_HEIGHT, z: p.z + BOT_RADIUS },
        },
        headshotY: p.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD,
        centerY: p.y + BOT_HEIGHT * 0.5,
      });
    }
    return out;
  }

  // A rail kill: the body bursts (with the shooter's finisher) where it stood.
  // Returns its centre for the kill effect.
  hit(id: string, style?: KillEffectStyle): THREE.Vector3 | null {
    const b = this.bodies.find((x) => x.state === 'live' && x.id === id);
    if (!b || !b.mover) return null;
    const floor = { y: b.mover.a.y + (b.mover.b.y - b.mover.a.y) * (b.mover.s / b.mover.len) };
    b.state = 'dying';
    b.group.scale.setScalar(1);
    b.anim.die(floor, style);
    return b.group.position.clone().setY(b.group.position.y + BOT_HEIGHT * 0.5);
  }

  // Moves the live strafers and keeps them facing `eye` (the player's eye).
  update(dt: number, eye: Vec3) {
    const ai = this.animIn;
    ai.dt = dt;
    for (const b of this.bodies) {
      if (b.state === 'free') continue;
      if (b.state === 'dying') {
        if (b.anim.deathDone()) {
          this.release(b);
          continue;
        }
      } else if (b.mover) {
        stepMover(b.mover, dt, b.group.position);
        b.grow += (1 - b.grow) * (1 - Math.exp(-GROW_HZ * dt));
        b.group.scale.setScalar(Math.max(0.01, b.grow));
      }
      const p = b.group.position;
      _look.set(eye.x - p.x, eye.y - (p.y + BOT_HEIGHT * 0.85), eye.z - p.z);
      const flat = Math.hypot(_look.x, _look.z) || 1;
      ai.yaw = Math.atan2(_look.x, _look.z) + MODEL_YAW_OFFSET; // brain-style yaw (0 looks down +z)
      ai.pitch = b.state === 'live' ? Math.atan2(_look.y, flat) : 0;
      ai.pos = p;
      b.anim.update(ai);
    }
  }

  dispose() {
    for (const b of this.bodies) {
      this.scene.remove(b.group);
      if (b.gun) disposeRailgun(b.gun);
      b.gun = null;
      b.anim.dispose();
      b.character.dispose();
    }
    this.bodies.length = 0;
  }
}
