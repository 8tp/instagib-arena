import * as THREE from 'three';
import type { UnusualKind } from '../cosmetics';
import { UnusualEffect } from '../fx/unusuals';
import { fxFlags } from '../fx/fx-settings';
import { UNUSUAL_EFFECTS, type Look } from '../items/types';
import { B, REST_ABS, SOCKETS } from '../character/rig';
import type { Character } from '../character/character';
import { CapeSim, type Wind } from './cape';
import { CREST_TOP, Kit, type V3 } from './kit';
import { createWearMaterial, type WearUniforms } from './material';
import type { SubAnim, WearSpec } from './spec';
import { HAT_SPECS } from './hats';
import { FACE_SPECS } from './faces';
import { BACK_SPECS } from './backs';

// ── Worn gear: code-built hats / face items / back items ─────────────────────
//
//   const gear = new WornGear(character);
//   gear.setLook('hat', { d: 'hat.tophat', f: 1 });   // festive top hat
//   gear.setLook('back', { d: 'back.cape.crimson' });
//   gear.setUnusual('embers');                        // effect kind (or null)
//   …each frame: gear.update(dt);                     // capes, bells, rotors
//   gear.dispose();
//
// Each slot's item rides its socket (hat → headTop, face → face, back → back),
// so it follows every pose, emote and gib with no follow code; update() only
// drives the secondary motion (cape cloth, swinging bells/tassels/antenna,
// spinning rotors, hovering hard light). Geometry is built once per item (and
// quality tier) and shared by every wearer; each worn item has its own small
// material (accent = the wearer's armour colour, or the admin tint Look.t).

export type GearSlot = 'hat' | 'face' | 'back';
// The wearer's world velocity, only needed when the rig moves IN PLACE (labs,
// previews, a treadmill) — in the world the gear measures its own motion.
export type GearMotion = { vx: number; vy: number; vz: number };

const SPECS: Record<GearSlot, Record<string, WearSpec>> = { hat: HAT_SPECS, face: FACE_SPECS, back: BACK_SPECS };
const SOCKET_OF: Record<GearSlot, 'headTop' | 'face' | 'back'> = { hat: 'headTop', face: 'face', back: 'back' };

// Rest model-space origin of a socket.
function socketOrigin(name: 'headTop' | 'face' | 'back'): V3 {
  const s = SOCKETS[name];
  const b = REST_ABS[s.bone];
  return [b[0] + s.pos[0], b[1] + s.pos[1], b[2] + s.pos[2]];
}
const ORIGIN: Record<GearSlot, V3> = { hat: socketOrigin('headTop'), face: socketOrigin('face'), back: socketOrigin('back') };

// Every buildable wearable id (the catalog's hat/face/back defs).
export function wearableIds(slot?: GearSlot): string[] {
  const out: string[] = [];
  for (const s of SLOTS) if (!slot || s === slot) out.push(...Object.keys(SPECS[s]));
  return out;
}
export function hasWearable(id: string): boolean {
  return id in HAT_SPECS || id in FACE_SPECS || id in BACK_SPECS;
}
function slotOfId(id: string): GearSlot | null {
  if (id in HAT_SPECS) return 'hat';
  if (id in FACE_SPECS) return 'face';
  if (id in BACK_SPECS) return 'back';
  return null;
}

// The unusual effect KIND for a Look's `e` (an effect id like 'fx.embers').
export function unusualKindOf(look: Look | null | undefined): string | null {
  if (!look?.e) return null;
  return UNUSUAL_EFFECTS.find((u) => u.id === look.e)?.kind ?? null;
}

// ── Shared geometry cache (per item × quality tier) ──────────────────────────

type BuiltSub = { geo: THREE.BufferGeometry; pivot: THREE.Vector3; anim: SubAnim };
type Built = {
  main: THREE.BufferGeometry | null;
  subs: BuiltSub[];
  festive: THREE.BufferGeometry | null | undefined; // undefined = not built yet
  top: number; // rest model-space top (hats: the unusual anchor)
  tris: number;
};
const CACHE = new Map<string, Built>();

function build(slot: GearSlot, id: string, low: boolean): Built | null {
  const spec = SPECS[slot][id];
  if (!spec) return null;
  const key = `${id}|${low ? 1 : 0}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const o = ORIGIN[slot];
  const k = new Kit(low);
  spec.build(k);
  let top = -Infinity;
  let tris = 0;
  const main = k.empty ? null : k.build(o);
  if (main) {
    top = Math.max(top, main.boundingBox!.max.y + o[1]);
    tris += main.getAttribute('position').count / 3;
  }
  const subs: BuiltSub[] = [];
  for (const s of spec.subs ?? []) {
    const sk = new Kit(low);
    s.build(sk);
    const geo = sk.build(s.pivot);
    top = Math.max(top, geo.boundingBox!.max.y + s.pivot[1]);
    tris += geo.getAttribute('position').count / 3;
    subs.push({ geo, pivot: new THREE.Vector3(s.pivot[0] - o[0], s.pivot[1] - o[1], s.pivot[2] - o[2]), anim: s.anim });
  }
  const b: Built = { main, subs, festive: spec.festive ? undefined : null, top: Number.isFinite(top) ? top : CREST_TOP, tris };
  CACHE.set(key, b);
  return b;
}

function festiveGeo(slot: GearSlot, id: string, low: boolean, b: Built): THREE.BufferGeometry | null {
  if (b.festive !== undefined) return b.festive;
  const spec = SPECS[slot][id];
  const k = new Kit(low);
  spec?.festive?.(k);
  b.festive = k.empty ? null : k.build(ORIGIN[slot]);
  return b.festive;
}

// Dev/lab: triangle count of an item (all parts, full quality).
export function wearableTris(id: string, low = false): number {
  const slot = slotOfId(id);
  if (!slot) return 0;
  return build(slot, id, low)?.tris ?? 0;
}

// ── Runtime ─────────────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const TIME0 = typeof performance !== 'undefined' ? performance.now() : 0;
const nowSec = () => ((typeof performance !== 'undefined' ? performance.now() : 0) - TIME0) / 1000;
const MAX_H = 1 / 60;

type SubRt = {
  mesh: THREE.Mesh;
  anim: SubAnim;
  base: THREE.Vector3; // socket-local rest position
  angle: number;
  t: number;
  // swing
  dirL: THREE.Vector3; // rest direction (socket-local, unit)
  tip: THREE.Vector3; // world
  vel: THREE.Vector3; // world m/s
  pivPrev: THREE.Vector3;
  fresh: boolean;
};

type SlotRt = {
  id: string;
  look: Look;
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  uniforms: WearUniforms;
  mesh: THREE.Mesh | null;
  festive: THREE.Mesh | null;
  subs: SubRt[];
  cape: CapeSim | null;
  top: number;
};

const WIND0: Wind = { x: 0, y: 0, z: 0 };
const SLOTS: readonly GearSlot[] = ['hat', 'face', 'back'];
const LEGS: readonly (readonly [number, number, number])[] = [
  [B.thighL, B.shinL, B.footL],
  [B.thighR, B.shinR, B.footR],
];

export class WornGear {
  private readonly ch: Character;
  private readonly slots: Record<GearSlot, SlotRt | null> = { hat: null, face: null, back: null };
  private readonly unusualAnchor = new THREE.Group();
  private unusual: UnusualEffect | null = null;
  private unusualKind: string | null = null;
  private visible = true;
  private readonly castShadow: boolean;
  // Motion measurement (socket world position → speed for rotors).
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;
  private speed = 0;
  private readonly spheres = new Float32Array(8 * 4);
  private readonly wind: Wind = { x: 0, y: 0, z: 0 };
  private disposed = false;

  constructor(character: Character, opts: { castShadow?: boolean } = {}) {
    this.ch = character;
    this.castShadow = opts.castShadow ?? true;
    this.unusualAnchor.name = 'unusual-anchor';
    character.sockets.headTop.add(this.unusualAnchor);
    this.layoutUnusual();
  }

  get character(): Character {
    return this.ch;
  }

  // Equip `look` in a slot; null (or '*.none' / an unknown id) = bare.
  setLook(slot: GearSlot, look: Look | null): void {
    if (this.disposed) return;
    const id = look && SPECS[slot][look.d] ? look.d : null;
    const cur = this.slots[slot];
    if (cur && id === cur.id && look) {
      // Same item: only the look's attributes may have changed.
      cur.look = { ...look };
      this.applyAttrs(slot, cur);
      return;
    }
    if (cur) this.clearSlot(slot);
    if (!id || !look) {
      if (slot === 'hat') {
        this.ch.setCrestHidden(false);
        this.layoutUnusual();
      }
      return;
    }
    const low = fxFlags.low;
    const built = build(slot, id, low);
    if (!built) return;
    const socket = this.ch.sockets[SOCKET_OF[slot]];
    const { material, uniforms } = createWearMaterial();
    const group = new THREE.Group();
    group.name = `gear.${slot}`;
    group.userData.shared = true;
    socket.add(group);
    const rt: SlotRt = { id, look: { ...look }, group, material, uniforms, mesh: null, festive: null, subs: [], cape: null, top: built.top };
    const sync = this.syncFn(rt);
    const mk = (geo: THREE.BufferGeometry, name: string) => {
      const m = new THREE.Mesh(geo, material);
      m.name = name;
      m.castShadow = this.castShadow;
      m.receiveShadow = false;
      m.userData.shared = true; // cached geometry: never freed by Game.disposeScene()
      m.onBeforeRender = sync;
      return m;
    };
    if (built.main) {
      rt.mesh = mk(built.main, id);
      group.add(rt.mesh);
    }
    for (const s of built.subs) {
      const m = mk(s.geo, `${id}.sub`);
      m.position.copy(s.pivot);
      group.add(m);
      const dirL = new THREE.Vector3();
      if (s.anim.kind === 'swing') dirL.set(s.anim.dir[0], s.anim.dir[1], s.anim.dir[2]).normalize();
      rt.subs.push({ mesh: m, anim: s.anim, base: s.pivot.clone(), angle: 0, t: Math.random() * 10, dirL, tip: new THREE.Vector3(), vel: new THREE.Vector3(), pivPrev: new THREE.Vector3(), fresh: true });
    }
    const spec = SPECS[slot][id];
    if (spec.cape) {
      rt.cape = new CapeSim(spec.cape, ORIGIN[slot], low, material);
      rt.cape.mesh.castShadow = this.castShadow;
      rt.cape.mesh.onBeforeRender = sync;
      group.add(rt.cape.mesh);
    }
    this.slots[slot] = rt;
    this.applyAttrs(slot, rt);
    if (slot === 'hat') {
      this.ch.setCrestHidden(!spec.keepCrest);
      this.layoutUnusual();
    }
    group.visible = this.visible;
  }

  getLook(slot: GearSlot): Look | null {
    return this.slots[slot]?.look ?? null;
  }

  // Look attributes: admin tint, festive lights.
  private applyAttrs(slot: GearSlot, rt: SlotRt): void {
    const u = rt.uniforms;
    if (rt.look.t && /^#?[0-9a-f]{6}$/i.test(rt.look.t)) {
      u.uHasTint.value = 1;
      u.uTint.value.set(rt.look.t.startsWith('#') ? rt.look.t : `#${rt.look.t}`);
    } else u.uHasTint.value = 0;
    const wantFestive = rt.look.f === 1;
    if (wantFestive && !rt.festive) {
      const built = build(slot, rt.id, fxFlags.low);
      const g = built ? festiveGeo(slot, rt.id, fxFlags.low, built) : null;
      if (g) {
        const m = new THREE.Mesh(g, rt.material);
        m.name = `${rt.id}.festive`;
        m.castShadow = false;
        m.userData.shared = true;
        m.onBeforeRender = this.syncFn(rt);
        rt.festive = m;
        rt.group.add(m);
      }
    }
    if (rt.festive) rt.festive.visible = wantFestive;
  }

  // Per-draw uniform sync: the accent follows the wearer's armour colour
  // (team / highlight changes land without an update() call), the clock
  // drives twinkle + hard light everywhere (previews included).
  private syncFn(rt: SlotRt): () => void {
    const ch = this.ch;
    return () => {
      const u = rt.uniforms;
      if (u.uHasTint.value > 0) u.uAccent.value.copy(u.uTint.value);
      else u.uAccent.value.copy(ch.uniforms.uPlayer.value);
      u.uLift.value = ch.uniforms.uLift.value * 0.8;
      u.uTime.value = nowSec();
      u.uCalm.value = fxFlags.reduced ? 1 : 0;
    };
  }

  // Equip an unusual effect by KIND ('embers', 'halo', …) — seated above the
  // hat top / helmet crown. null = off. Unknown kinds are ignored.
  setUnusual(kind: string | null): void {
    if (this.disposed) return;
    const k = kind && kind !== 'none' ? kind : null;
    if (k === this.unusualKind) return;
    this.unusualKind = k;
    this.unusual?.dispose();
    this.unusual = null;
    if (!k) return;
    try {
      this.unusual = new UnusualEffect(k as Exclude<UnusualKind, 'none'>);
      this.unusualAnchor.add(this.unusual.group);
    } catch {
      this.unusual = null; // renderer doesn't know this kind (yet)
    }
  }

  // Rest model-space height of the top of the worn hat (bare: the crest).
  headTopY(): number {
    const h = this.slots.hat;
    return h ? Math.max(h.top, CREST_TOP) : CREST_TOP;
  }

  private layoutUnusual(): void {
    const socketY = ORIGIN.hat[1];
    const top = this.slots.hat ? this.slots.hat.top - socketY : 0.04;
    this.unusualAnchor.position.y = Math.max(top, 0.03) + 0.05;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const s of SLOTS) {
      const rt = this.slots[s];
      if (rt) rt.group.visible = v;
    }
    this.unusualAnchor.visible = v;
  }

  // Snap secondary motion back to rest (respawn / teleport).
  resetMotion(): void {
    this.hasLast = false;
    for (const s of SLOTS) {
      const rt = this.slots[s];
      if (!rt) continue;
      rt.cape?.invalidate();
      for (const sub of rt.subs) sub.fresh = true;
    }
  }

  // Animate: unusual particles, cape cloth, swinging / spinning parts.
  update(dt: number, motion?: GearMotion): void {
    if (this.disposed) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.unusual?.update(dt);
    const any = this.slots.hat?.subs.length || this.slots.face?.subs.length || this.slots.back?.subs.length || this.slots.back?.cape;
    if (!any) return;
    const w = this.wind;
    w.x = motion?.vx ?? 0;
    w.y = motion?.vy ?? 0;
    w.z = motion?.vz ?? 0;
    // Wearer speed (rotors): measured from the chest socket + in-place motion.
    const back = this.ch.sockets.back;
    back.updateWorldMatrix(true, false);
    _p.setFromMatrixPosition(back.matrixWorld);
    if (this.hasLast && dt > 0) {
      const d = _p.distanceTo(this.lastPos);
      const inst = d > 2 ? 0 : d / dt + Math.hypot(w.x, w.y, w.z);
      this.speed += (inst - this.speed) * (1 - Math.exp(-6 * dt));
    }
    this.lastPos.copy(_p);
    this.hasLast = true;
    for (const s of SLOTS) {
      const rt = this.slots[s];
      if (!rt || (!rt.subs.length && !rt.cape)) continue;
      const socket = this.ch.sockets[SOCKET_OF[s]];
      socket.updateWorldMatrix(true, false);
      const active = this.visible && socket.visible && this.ch.root.visible;
      if (rt.cape) {
        const n = active ? this.legSpheres() : 0;
        rt.cape.update(dt, socket, active ? w : WIND0, this.spheres, n, active);
      }
      if (rt.subs.length) this.animateSubs(rt, socket, dt, active);
    }
  }

  // World-space leg colliders for capes (thigh, knee, shin per leg).
  private legSpheres(): number {
    const bones = this.ch.rig.bones;
    let n = 0;
    for (const [th, sh, ft] of LEGS) {
      bones[th].updateWorldMatrix(false, false);
      bones[sh].updateWorldMatrix(false, false);
      bones[ft].updateWorldMatrix(false, false);
      _v.setFromMatrixPosition(bones[th].matrixWorld);
      _v2.setFromMatrixPosition(bones[sh].matrixWorld);
      n = this.sphere(n, (_v.x + _v2.x) / 2, (_v.y + _v2.y) / 2, (_v.z + _v2.z) / 2, 0.13);
      n = this.sphere(n, _v2.x, _v2.y, _v2.z, 0.105);
      _v.setFromMatrixPosition(bones[ft].matrixWorld);
      n = this.sphere(n, (_v.x + _v2.x) / 2, (_v.y + _v2.y) / 2, (_v.z + _v2.z) / 2, 0.075);
      n = this.sphere(n, _v.x, _v.y + 0.05, _v.z, 0.07);
    }
    return n;
  }

  private sphere(n: number, x: number, y: number, z: number, r: number): number {
    const o = n * 4;
    this.spheres[o] = x;
    this.spheres[o + 1] = y;
    this.spheres[o + 2] = z;
    this.spheres[o + 3] = r;
    return n + 1;
  }

  private animateSubs(rt: SlotRt, socket: THREE.Object3D, dt: number, active: boolean): void {
    const calm = fxFlags.reduced ? 0.5 : 1;
    socket.matrixWorld.decompose(_v, _q, _s);
    const sockQ = _q;
    for (const sub of rt.subs) {
      const a = sub.anim;
      if (a.kind === 'spin') {
        sub.angle += (a.rate + (a.move ?? 0) * Math.min(this.speed, 14)) * dt * calm;
        _axis.set(a.axis[0], a.axis[1], a.axis[2]).normalize();
        sub.mesh.quaternion.setFromAxisAngle(_axis, sub.angle);
      } else if (a.kind === 'bob') {
        sub.t += dt * calm;
        sub.mesh.position.y = sub.base.y + a.amp * Math.sin(sub.t * Math.PI * 2 * a.freq);
        if (a.spin) {
          sub.angle += a.spin * dt * calm;
          sub.mesh.quaternion.setFromAxisAngle(_axis.set(0, 1, 0), sub.angle);
        }
      } else {
        this.swing(sub, a, socket, sockQ, dt, active);
      }
    }
  }

  // Damped spring/pendulum on a world-space tip point; the part is turned
  // from its rest direction to the tip direction. Fixed ≤1/60 s sub-steps.
  private swing(sub: SubRt, a: Extract<SubAnim, { kind: 'swing' }>, socket: THREE.Object3D, sockQ: THREE.Quaternion, dt: number, active: boolean): void {
    const piv = _p.copy(sub.base).applyMatrix4(socket.matrixWorld);
    const restDir = _v.copy(sub.dirL).applyQuaternion(sockQ);
    if (!active) {
      sub.fresh = true;
      return;
    }
    if (sub.fresh || piv.distanceToSquared(sub.pivPrev) > 4) {
      sub.fresh = false;
      sub.tip.copy(piv).addScaledVector(restDir, a.len);
      sub.vel.set(0, 0, 0);
      sub.pivPrev.copy(piv);
    }
    if (dt > 0) {
      const steps = Math.max(1, Math.ceil(dt / MAX_H - 1e-6));
      const h = dt / steps;
      // Pivot velocity (for relative damping).
      const pvx = (piv.x - sub.pivPrev.x) / dt;
      const pvy = (piv.y - sub.pivPrev.y) / dt;
      const pvz = (piv.z - sub.pivPrev.z) / dt;
      const w = this.wind;
      for (let i = 0; i < steps; i++) {
        const f = (i + 1) / steps;
        const px = sub.pivPrev.x + (piv.x - sub.pivPrev.x) * f;
        const py = sub.pivPrev.y + (piv.y - sub.pivPrev.y) * f;
        const pz = sub.pivPrev.z + (piv.z - sub.pivPrev.z) * f;
        const rx = px + restDir.x * a.len;
        const ry = py + restDir.y * a.len;
        const rz = pz + restDir.z * a.len;
        const v = sub.vel;
        const ax = a.stiff * (rx - sub.tip.x) - a.damp * (v.x - pvx) - 0.8 * (v.x + w.x);
        const ay = a.stiff * (ry - sub.tip.y) - a.damp * (v.y - pvy) - 0.8 * (v.y + w.y) - 9.8 * a.grav;
        const az = a.stiff * (rz - sub.tip.z) - a.damp * (v.z - pvz) - 0.8 * (v.z + w.z);
        v.x += ax * h;
        v.y += ay * h;
        v.z += az * h;
        sub.tip.x += v.x * h;
        sub.tip.y += v.y * h;
        sub.tip.z += v.z * h;
        // Keep the lever length; drop the radial velocity.
        _v2.set(sub.tip.x - px, sub.tip.y - py, sub.tip.z - pz);
        const len = _v2.length() || 1e-6;
        _v2.multiplyScalar(1 / len);
        sub.tip.set(px + _v2.x * a.len, py + _v2.y * a.len, pz + _v2.z * a.len);
        const radial = v.x * _v2.x + v.y * _v2.y + v.z * _v2.z;
        v.x -= radial * _v2.x;
        v.y -= radial * _v2.y;
        v.z -= radial * _v2.z;
      }
      sub.pivPrev.copy(piv);
    }
    _v2.subVectors(sub.tip, piv).normalize();
    _q2.setFromUnitVectors(restDir, _v2);
    // Local = sockQ⁻¹ · R · sockQ
    sub.mesh.quaternion.copy(sockQ).invert().multiply(_q2).multiply(sockQ);
  }

  private clearSlot(slot: GearSlot): void {
    const rt = this.slots[slot];
    if (!rt) return;
    rt.cape?.dispose();
    rt.group.parent?.remove(rt.group);
    rt.material.dispose();
    this.slots[slot] = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.unusual?.dispose();
    this.unusual = null;
    for (const s of SLOTS) this.clearSlot(s);
    this.ch.setCrestHidden(false);
    this.unusualAnchor.parent?.remove(this.unusualAnchor);
    this.disposed = true;
  }
}
