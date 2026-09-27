import * as THREE from 'three';
import { getBodyGeometry } from './body';
import type { Character } from './character';
import { B, BONE_COUNT, REST_ABS } from './rig';

// ── Instagib death: the parts ARE the gibs ───────────────────────────────────
//
// Every body part is rigidly skinned to one bone, so bursting the body is just
// flinging the bones: each bone becomes a free rigid chunk (position, spin,
// shrink) written straight into its matrix. The skinned mesh keeps rendering
// as ONE draw call, the hat/unusual ride the head chunk, and nothing is
// allocated per kill (all state is preallocated per character). A brief
// energy flash pops at the torso and the armour glows hot, cooling as the
// chunks fly. The killer's kill-effect cosmetic (effects.spawnKillBurst)
// plays on top — this is deliberately not a second big explosion.
//
// Quality: reducedEffects → fewer, slower chunks, no bounce, no flash;
// lowSpec → fewer chunks. Set by the Game via setCharacterFxQuality().

export type GibFloor = { y: number } | null; // world-space floor height, null = none

const quality = { reduced: false, low: false };
export function setCharacterFxQuality(opts: { reducedEffects?: boolean; lowSpec?: boolean }): void {
  if (opts.reducedEffects !== undefined) quality.reduced = opts.reducedEffects;
  if (opts.lowSpec !== undefined) quality.low = opts.lowSpec;
}

const GRAVITY = 22;
const DURATION = 1.3; // everything has shrunk away by here (< respawn delays)
const FLASH_SEC = 0.2;

// Chunk leads for the reduced set (7 chunks): limbs stay whole.
const LEAD_REDUCED: readonly number[] = (() => {
  const lead = Array.from({ length: BONE_COUNT }, (_, i) => i);
  lead[B.spine] = B.chest;
  lead[B.neck] = B.head;
  lead[B.clavicleL] = B.chest;
  lead[B.clavicleR] = B.chest;
  lead[B.foreArmL] = B.upperArmL;
  lead[B.handL] = B.upperArmL;
  lead[B.foreArmR] = B.upperArmR;
  lead[B.handR] = B.upperArmR;
  lead[B.shinL] = B.thighL;
  lead[B.footL] = B.thighL;
  lead[B.shinR] = B.thighR;
  lead[B.footR] = B.thighR;
  return lead;
})();
// Full set: every bone its own chunk, except the clavicles (pauldrons) which
// stay on the chest for a chunkier torso piece.
const LEAD_FULL: readonly number[] = (() => {
  const lead = Array.from({ length: BONE_COUNT }, (_, i) => i);
  lead[B.clavicleL] = B.chest;
  lead[B.clavicleR] = B.chest;
  return lead;
})();

let flashTex: THREE.Texture | null = null;
function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  flashTex = new THREE.CanvasTexture(cv);
  return flashTex;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pp = new THREE.Vector3();
const _col = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export class GibBurst {
  active = false;
  done = false;
  private t = 0;
  private lead: readonly number[] = LEAD_FULL;
  private floorY: number | null = null;
  private bounce = true;
  // Per-bone chunk state (only leads are simulated).
  private readonly pos = new Float32Array(BONE_COUNT * 3);
  private readonly vel = new Float32Array(BONE_COUNT * 3);
  private readonly quat = new Float32Array(BONE_COUNT * 4);
  private readonly spinAxis = new Float32Array(BONE_COUNT * 3);
  private readonly spinRate = new Float32Array(BONE_COUNT);
  private readonly shrinkAt = new Float32Array(BONE_COUNT);
  private readonly comLocal = new Float32Array(BONE_COUNT * 3);
  private readonly rel: THREE.Matrix4[] = [];
  private flash: THREE.Sprite | null = null;
  private readonly flashAt = new THREE.Vector3();
  private readonly glowCol = new THREE.Color();

  constructor(private readonly ch: Character) {
    for (let i = 0; i < BONE_COUNT; i++) this.rel.push(new THREE.Matrix4());
    const body = getBodyGeometry();
    for (let i = 0; i < BONE_COUNT; i++) {
      for (let k = 0; k < 3; k++) this.comLocal[i * 3 + k] = body.com[i * 3 + k] - REST_ABS[i][k];
    }
  }

  // Burst now. (vx, vy, vz) = the victim's world velocity at death.
  start(vx: number, vy: number, vz: number, floor: GibFloor): void {
    const ch = this.ch;
    const root = ch.root;
    const rig = ch.rig;
    const body = getBodyGeometry();
    this.active = true;
    this.done = false;
    this.t = 0;
    const low = quality.reduced || quality.low;
    this.lead = low ? LEAD_REDUCED : LEAD_FULL;
    this.bounce = !quality.reduced;

    // Collapse the root transform into the bone matrices so bones live in the
    // root's parent space (translation-only for live entities).
    root.updateMatrix();
    const R0 = _m2.copy(root.matrix);
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.updateMatrix();
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = rig.bones[i];
      b.matrix.premultiply(R0);
      b.matrixWorldNeedsUpdate = true;
    }
    rig.frozen = true;
    ch.mesh.frustumCulled = false;
    ch.sockets.gun.visible = false;

    // Parent-space frame: floor height + velocity rotation.
    const parent = root.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(_pp, _pq, _s);
    } else {
      _pp.set(0, 0, 0);
      _pq.identity();
    }
    this.floorY = floor ? floor.y - _pp.y : null;
    const inv = _q2.copy(_pq).invert();
    _v2.set(vx, vy, vz).applyQuaternion(inv).multiplyScalar(0.35);

    // Torso centre (chest chunk COM) for outward directions.
    const chestB = rig.bones[B.chest].matrix;
    const cx = chestB.elements[12];
    const cy = chestB.elements[13] - 0.05;
    const cz = chestB.elements[14];
    this.flashAt.set(cx, cy + 0.05, cz);

    const speedMul = quality.reduced ? 0.55 : 1;
    for (let i = 0; i < BONE_COUNT; i++) {
      const l = this.lead[i];
      if (l !== i) {
        // Follower: remember its transform relative to the lead.
        this.rel[i].copy(rig.bones[l].matrix).invert().multiply(rig.bones[i].matrix);
        continue;
      }
      if (!body.hasGeo[i] && i !== B.chest) continue;
      const bm = rig.bones[i].matrix;
      bm.decompose(_v, _q, _s);
      // Chunk COM in parent space.
      _v.set(this.comLocal[i * 3], this.comLocal[i * 3 + 1], this.comLocal[i * 3 + 2]).applyMatrix4(bm);
      this.pos[i * 3] = _v.x;
      this.pos[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = _v.z;
      this.quat[i * 4] = _q.x;
      this.quat[i * 4 + 1] = _q.y;
      this.quat[i * 4 + 2] = _q.z;
      this.quat[i * 4 + 3] = _q.w;
      // Outward from the torso, biased up; the torso itself mostly pops up.
      let dx = _v.x - cx;
      let dy = _v.y - cy;
      let dz = _v.z - cz;
      let dl = Math.hypot(dx, dy, dz);
      if (dl < 0.12) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a) * 0.3;
        dz = Math.sin(a) * 0.3;
        dy = 1;
        dl = Math.hypot(dx, dy, dz);
      }
      const sp = (3.2 + Math.random() * 4.2) * speedMul;
      const up = (2.2 + Math.random() * 3.2 + (i === B.head ? 1.5 : 0)) * speedMul;
      this.vel[i * 3] = (dx / dl) * sp + _v2.x + (Math.random() - 0.5) * 1.2;
      this.vel[i * 3 + 1] = (dy / dl) * sp * 0.6 + up + _v2.y;
      this.vel[i * 3 + 2] = (dz / dl) * sp + _v2.z + (Math.random() - 0.5) * 1.2;
      // Random tumble.
      const ax = Math.random() - 0.5;
      const ay = Math.random() - 0.5;
      const az = Math.random() - 0.5;
      const al = Math.hypot(ax, ay, az) || 1;
      this.spinAxis[i * 3] = ax / al;
      this.spinAxis[i * 3 + 1] = ay / al;
      this.spinAxis[i * 3 + 2] = az / al;
      this.spinRate[i] = (5 + Math.random() * 11) * speedMul;
      this.shrinkAt[i] = 0.5 + Math.random() * 0.35;
    }

    // Heat glow in a hot version of the armour colour.
    ch.getColor(this.glowCol).lerp(WHITE, 0.55);
    ch.setGlow(quality.reduced ? 0.5 : 1.6, this.glowCol);
    if (!quality.reduced) this.showFlash();
    this.update(0);
  }

  private showFlash() {
    if (!this.flash) {
      const mat = new THREE.SpriteMaterial({
        map: flashTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      this.flash = new THREE.Sprite(mat);
      this.flash.name = 'gib-flash';
      this.flash.renderOrder = 5;
    }
    const f = this.flash;
    f.position.copy(this.flashAt);
    f.material.color.copy(this.glowCol).multiplyScalar(2.2);
    f.visible = true;
    this.ch.root.add(f);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const rig = this.ch.rig;
    const drag = Math.exp(-0.5 * dt);
    const body = getBodyGeometry();
    for (let i = 0; i < BONE_COUNT; i++) {
      if (this.lead[i] !== i || (!body.hasGeo[i] && i !== B.chest)) continue;
      const o3 = i * 3;
      // Integrate.
      this.vel[o3 + 1] -= GRAVITY * dt;
      this.vel[o3] *= drag;
      this.vel[o3 + 2] *= drag;
      this.pos[o3] += this.vel[o3] * dt;
      this.pos[o3 + 1] += this.vel[o3 + 1] * dt;
      this.pos[o3 + 2] += this.vel[o3 + 2] * dt;
      // Spin.
      _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
      if (dt > 0 && this.spinRate[i] > 0) {
        _v.set(this.spinAxis[o3], this.spinAxis[o3 + 1], this.spinAxis[o3 + 2]);
        _q2.setFromAxisAngle(_v, this.spinRate[i] * dt);
        _q.premultiply(_q2);
        this.quat[i * 4] = _q.x;
        this.quat[i * 4 + 1] = _q.y;
        this.quat[i * 4 + 2] = _q.z;
        this.quat[i * 4 + 3] = _q.w;
      }
      // Shrink away.
      const u = (t - this.shrinkAt[i]) / 0.42;
      const s = u <= 0 ? 1 : u >= 1 ? 0.0001 : 1 - u * u * (3 - 2 * u);
      // Floor.
      if (this.floorY !== null) {
        const r = body.radius[i] * 0.45 * s;
        if (this.pos[o3 + 1] - r < this.floorY) {
          this.pos[o3 + 1] = this.floorY + r;
          if (this.vel[o3 + 1] < 0) {
            if (this.bounce) {
              this.vel[o3 + 1] *= -0.3;
              this.vel[o3] *= 0.55;
              this.vel[o3 + 2] *= 0.55;
              this.spinRate[i] *= 0.55;
            } else {
              this.vel[o3] = this.vel[o3 + 1] = this.vel[o3 + 2] = 0;
              this.spinRate[i] = 0;
            }
          }
        }
      }
      // bone = T(pos) · R(q) · S(s) · T(−comLocal)
      _s.set(s, s, s);
      _v.set(this.pos[o3], this.pos[o3 + 1], this.pos[o3 + 2]);
      _m.compose(_v, _q, _s);
      _m2.makeTranslation(-this.comLocal[o3], -this.comLocal[o3 + 1], -this.comLocal[o3 + 2]);
      rig.bones[i].matrix.multiplyMatrices(_m, _m2);
      rig.bones[i].matrixWorldNeedsUpdate = true;
    }
    for (let i = 0; i < BONE_COUNT; i++) {
      const l = this.lead[i];
      if (l === i) continue;
      rig.bones[i].matrix.multiplyMatrices(rig.bones[l].matrix, this.rel[i]);
      rig.bones[i].matrixWorldNeedsUpdate = true;
    }
    // Heat cools; flash pops and fades.
    const glow0 = quality.reduced ? 0.5 : 1.6;
    this.ch.setGlow(glow0 * Math.exp(-t * 4.5));
    if (this.flash) {
      const k = t / FLASH_SEC;
      if (k >= 1) this.flash.visible = false;
      else {
        const sz = 0.5 + 2.3 * Math.sqrt(k);
        this.flash.scale.set(sz, sz, sz);
        this.flash.material.opacity = (1 - k) * (1 - k);
      }
    }
    if (t >= DURATION) this.done = true;
  }

  // Back to a whole body (respawn). The animator re-poses the bones next update.
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.done = false;
    const ch = this.ch;
    ch.rig.frozen = false;
    ch.mesh.frustumCulled = true;
    ch.sockets.gun.visible = true;
    ch.setGlow(0);
    if (this.flash) {
      this.flash.visible = false;
      this.flash.parent?.remove(this.flash);
    }
  }

  dispose(): void {
    this.stop();
    if (this.flash) {
      this.flash.material.dispose();
      this.flash = null;
    }
  }
}

// Silence unused-import lint for the colour scratch (kept for future tints).
void _col;
