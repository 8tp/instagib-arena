import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createCamera, createRenderer, createScene, applyMapShadowFlags, PostFxPipeline } from '../../renderer';
import { buildMapMesh, mapById } from '../../map';
import { buildRailgun, setRailgunReducedEffects, type RailgunModel } from '../../weapon-model';
import { EYE_HEIGHT, RAIL_COOLDOWN, VIEWMODEL_BASE, VIEWMODEL_SCALE } from '../../constants';
import { RAILGUN_FINISHES, type RailgunFinish } from '../../cosmetics';
import { Character, skinColorFor } from '../../character/character';
import { CharacterAnimator } from '../../character-anim';
import { GUN_SCALE } from '../../character/gun';
import { ViewmodelMotion } from '../../viewmodel-motion';
import { CUSTOM_GUN_BUILDS, CUSTOM_GUN_KEYS } from './index';
import type { CustomGunState } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Custom gun lab (dev only). Renders every custom railgun model into a
// contact sheet on a 2D canvas, deterministic (every model is advanced by
// fixed dt steps; a virtual clock stands in for performance.now so the stock
// reference gun is deterministic too).
//
//   ?sheet=model&model=prism   idle / fired / recharging / streak (first
//                              person, FOV 90, arena) + 3/4 turntable +
//                              third-person-size view
//   ?sheet=all&state=idle      every model (+ stock) in first person
//   ?sheet=tp                  third-person lineup (low LOD on combatants)
//   ?sheet=turn&model=prism    turntable: 6 angles in the studio
//   &reduced=1 &low=1          reduced effects / low spec
//   &tracker=1                 show the real Tracked module (setStrangeKills)
//   &tracker=plate             a stand-in 136 × 46 × 12 mm block at each
//                              model's trackerMount (tracker.ts's frame)
//   &map=reactor &yaw= &pitch= &cell=WxH
//
// Each first-person cell is captioned with the body's tris / draw calls /
// silhouette coverage (the gunlab probe: the viewmodel layer in flat white,
// VFX hidden) and the "clear" radius: the distance from the crosshair to the
// nearest lit gun/VFX pixel, in screen half-heights.
// window.__cgl.stats → the numbers as JSON.
// ─────────────────────────────────────────────────────────────────────────

const STEP = 1 / 120;
const T0 = 10_000;
const FIRE_LIFE = 0.25; // firing: 1 → 0 over this (matches the weapon track)
const GUN_IN_SOCKET = new THREE.Vector3(0, 0.12 * GUN_SCALE, -0.09 * GUN_SCALE);

type StateName = 'idle' | 'fired' | 'recharging' | 'streak';
const STATES: StateName[] = ['idle', 'fired', 'recharging', 'streak'];

type Cell = { label: string; sub?: string };
export type LabStats = Record<string, Record<string, number | string>>;

function finishFor(key: string): RailgunFinish {
  if (key === 'stock') return RAILGUN_FINISHES[0].data;
  const f = RAILGUN_FINISHES.find((r) => r.data.model === key);
  return f ? f.data : RAILGUN_FINISHES[0].data;
}
function nameFor(key: string): string {
  if (key === 'stock') return 'Standard Issue';
  return RAILGUN_FINISHES.find((r) => r.data.model === key)?.name ?? key;
}

// A gun under test: a custom instance, or the stock railgun for reference.
type Subject = {
  key: string;
  group: THREE.Object3D;
  update(dt: number, s: CustomGunState): void;
  fire(): void;
  dispose(): void;
  stock: RailgunModel;
};

export class CustomGunLab {
  private readonly gl: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly post: PostFxPipeline;
  private studioScene: THREE.Scene | null = null;
  private studioPost: PostFxPipeline | null = null;
  private readonly studioCam = new THREE.PerspectiveCamera(26, 16 / 9, 0.05, 20);
  private virtualMs = T0;
  private readonly realNow = performance.now.bind(performance);
  private readonly cw: number;
  private readonly ch: number;
  private readonly reduced: boolean;
  private readonly low: boolean;
  private readonly subjects: Subject[] = [];
  private readonly extra: THREE.Object3D[] = [];
  // The game's viewmodel pose (resting PLACEMENT: lower right, toed in) —
  // motion intensity 0, so only placement + the fire kick apply.
  private readonly motion = new ViewmodelMotion();
  private posed: Subject | null = null;
  readonly stats: LabStats = {};
  caption = '';

  constructor(
    private readonly out: HTMLCanvasElement,
    private readonly params: URLSearchParams,
  ) {
    performance.now = () => this.virtualMs;
    const [w, h] = (params.get('cell') ?? '800x450').split('x').map(Number);
    this.cw = w || 800;
    this.ch = h || 450;
    this.reduced = params.get('reduced') === '1';
    this.low = params.get('low') === '1';
    setRailgunReducedEffects(this.reduced);
    this.gl = document.createElement('canvas');
    this.gl.width = this.cw;
    this.gl.height = this.ch;
    this.renderer = createRenderer(this.gl);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.cw, this.ch, false);
    this.world = createScene(this.renderer);
    this.camera = createCamera(this.gl);
    const map = mapById(params.get('map') ?? 'reactor');
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.world.add(mesh);
    this.camera.position.set(map.spawn.x, map.spawn.y + EYE_HEIGHT, map.spawn.z);
    this.camera.rotation.set(this.num('pitch', -0.05), this.num('yaw', 0), 0, 'YXZ');
    this.camera.fov = 90;
    this.camera.aspect = this.cw / this.ch;
    this.camera.updateProjectionMatrix();
    this.world.add(this.camera);
    this.post = new PostFxPipeline(this.renderer, this.world, this.camera);
    this.post.setOptions({ bloom: true, shadows: true, aa: true, vignette: true });
    this.post.setSize(this.cw, this.ch);
  }

  private num(name: string, def: number): number {
    const v = this.params.get(name);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  }

  // Every gun goes through the game's own buildRailgun (custom models via the
  // registry: same group, muzzle flare, killstreak extras and ticker as in a
  // match). The custom ticker runs on render; the lab calls it per step.
  private make(key: string, lod: 'high' | 'low'): Subject {
    const f = finishFor(key);
    const rail = buildRailgun(f, { lod });
    rail.setLowSpec(this.low);
    const ticker = rail.group.getObjectByName('gun-ticker');
    const tick = ticker ? (ticker.onBeforeRender as unknown as () => void) : null;
    // &hide=motes,strips: hide VFX parts by name (debugging).
    if (this.params.get('tracker') === '1') rail.setStrangeKills(1337);
    if (this.params.get('tracker') === 'plate') this.trackerPlate(key, f, lod, rail.group);
    const hide = (this.params.get('hide') ?? '').split(',').filter(Boolean);
    if (hide.length) rail.group.traverse((o) => { if (hide.some((h) => o.name.includes(h))) o.visible = false; });
    return {
      key,
      group: rail.group,
      stock: rail,
      update: (_dt, s) => {
        rail.setCharge(s.charge);
        rail.setStreak(s.streak);
        tick?.();
      },
      fire: () => rail.notifyFire(),
      dispose: () => rail.dispose(),
    };
  }

  // QA: a stand-in for the Tracked module in tracker.ts's local frame (x = 0
  // is its back on the flank, it stands off toward −X, +Z toward the butt).
  private trackerPlate(key: string, f: RailgunFinish, lod: 'high' | 'low', group: THREE.Group) {
    let mount: { position: [number, number, number]; rotationY?: number; scale?: number } = { position: [-0.049, -0.013, -0.035] };
    const build = CUSTOM_GUN_BUILDS[key];
    if (build) {
      const inst = build({ lod, finish: f });
      if (inst.trackerMount) mount = inst.trackerMount;
      inst.dispose();
    }
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.046, 0.136),
      new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.4, metalness: 0.6 }),
    );
    block.position.x = -0.006;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.112, 0.033),
      new THREE.MeshBasicMaterial({ color: 0xff9a3c, toneMapped: false }),
    );
    face.rotation.y = -Math.PI / 2;
    face.position.x = -0.0121;
    const holder = new THREE.Group();
    holder.position.set(...mount.position);
    holder.rotation.y = mount.rotationY ?? 0;
    holder.scale.setScalar(mount.scale ?? 1);
    holder.add(block, face);
    group.add(holder);
    this.extra.push(block, face);
  }

  // Advance a subject through a named state (deterministic).
  private simulate(sub: Subject, state: StateName, onStep?: (dt: number) => void) {
    const streak = state === 'streak' ? 10 : 0;
    const s: CustomGunState = { charge: 1, firing: 0, streak, reduced: this.reduced, lowSpec: this.low };
    // Settle 2.5 s at full charge.
    for (let t = 0; t < 2.5; t += STEP) {
      this.virtualMs += STEP * 1000;
      sub.update(STEP, s);
      onStep?.(STEP);
      if (this.posed === sub) this.stepPose(STEP);
    }
    if (state === 'idle' || state === 'streak') return;
    const after = state === 'fired' ? this.num('fire', 0.06) : RAIL_COOLDOWN * this.num('rc', 0.55);
    sub.fire();
    if (this.posed === sub) this.motion.onFire();
    for (let t = 0; t < after; t += STEP) {
      this.virtualMs += STEP * 1000;
      s.charge = Math.min(1, (t + STEP) / RAIL_COOLDOWN);
      s.firing = Math.max(0, 1 - t / FIRE_LIFE);
      sub.update(STEP, s);
      onStep?.(STEP);
      if (this.posed === sub) this.stepPose(STEP);
    }
  }

  private setViewmodel(sub: Subject | null) {
    const cam = this.post.viewmodel.camera;
    for (const s of this.subjects) if (s.group.parent === cam) cam.remove(s.group);
    this.posed = sub;
    if (!sub) return;
    sub.group.scale.setScalar(VIEWMODEL_SCALE);
    cam.add(sub.group);
    this.motion.setIntensity(0);
    this.stepPose(0);
  }

  // Exactly the game's transform: VIEWMODEL_BASE + ViewmodelMotion pose.
  private stepPose(dt: number) {
    const sub = this.posed;
    if (!sub) return;
    const pose = this.motion.update({
      dt, yaw: 0, pitch: 0, groundSpeed: 0, lateralSpeed: 0, grounded: true, zoom: 0, reducedEffects: this.reduced,
    });
    sub.group.position.set(VIEWMODEL_BASE.x + pose.x, VIEWMODEL_BASE.y + pose.y, VIEWMODEL_BASE.z + pose.z);
    sub.group.rotation.set(pose.rx, pose.ry, pose.rz);
    const flare = sub.stock.muzzleFlash;
    if (flare) {
      flare.visible = pose.muzzle > 0;
      flare.material.opacity = pose.muzzle;
      flare.scale.setScalar(1 + (1 - pose.muzzle) * 0.9);
    }
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  private readPixels(fn: () => void, override: boolean): Uint8Array {
    const w = 400;
    const h = Math.round(w / this.camera.aspect);
    const rt = new THREE.WebGLRenderTarget(w, h);
    const layer = this.post.viewmodel;
    layer.sync();
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bg = layer.scene.background;
    layer.scene.background = new THREE.Color(0x000000);
    if (override) layer.scene.overrideMaterial = white;
    fn();
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(layer.scene, layer.camera);
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    this.renderer.setRenderTarget(null);
    layer.scene.overrideMaterial = null;
    layer.scene.background = bg;
    white.dispose();
    rt.dispose();
    return px;
  }

  // Silhouette coverage (VFX hidden) of the current viewmodel.
  private coverage(sub: Subject): number {
    const hidden: THREE.Object3D[] = [];
    const px = this.readPixels(() => {
      sub.group.traverse((o) => {
        if ((o.userData.vfx || o.name === 'railgun-flare') && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
      });
    }, true);
    for (const o of hidden) o.visible = true;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
    return n / (px.length / 4);
  }

  // Distance from the crosshair to the nearest lit pixel (gun + VFX, as
  // drawn), in half-heights of the screen.
  private clearRadius(): number {
    const w = 400;
    const h = Math.round(w / this.camera.aspect);
    const px = this.readPixels(() => {}, false);
    let best = 1e9;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i] + px[i + 1] + px[i + 2] > 24) {
          const d = Math.hypot(x - w / 2, y - h / 2);
          if (d < best) best = d;
        }
      }
    }
    return best / (h / 2);
  }

  private counts(sub: Subject): { tris: number; draws: number; points: number } {
    let tris = 0, draws = 0, points = 0;
    sub.group.traverse((o) => {
      if (!o.visible) return;
      if (!(o as THREE.Mesh).isMesh || o.name === 'railgun-flare' || o.name === 'gun-ticker') return; // flare: hidden between shots; ticker writes nothing
      const g = (o as THREE.Mesh).geometry;
      const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (o.name.endsWith('-motes')) points += g.attributes.position.count / 4;
      tris += t; // everything drawn, VFX included
      draws++;
    });
    return { tris: Math.round(tris), draws, points };
  }

  // ── Cells ─────────────────────────────────────────────────────────────────

  private ctx(): CanvasRenderingContext2D {
    return this.out.getContext('2d')!;
  }

  private blit(col: number, row: number, cell: Cell) {
    const c = this.ctx();
    const x = col * this.cw;
    const y = row * this.ch;
    c.drawImage(this.gl, x, y, this.cw, this.ch);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(x, y, this.cw, 26);
    c.fillStyle = '#e6edf7';
    c.font = 'bold 15px monospace';
    c.fillText(cell.label, x + 8, y + 18);
    if (cell.sub) {
      c.font = '12px monospace';
      c.fillStyle = '#9fb3cc';
      const tw = c.measureText(cell.sub).width;
      c.fillText(cell.sub, x + this.cw - tw - 8, y + 18);
    }
    c.strokeStyle = '#000';
    c.strokeRect(x + 0.5, y + 0.5, this.cw - 1, this.ch - 1);
  }

  private firstPerson(key: string, state: StateName, col: number, row: number) {
    const sub = this.make(key, 'high');
    this.subjects.push(sub);
    this.setViewmodel(sub);
    // Settle + advance the state.
    this.simulate(sub, state);
    this.post.render();
    this.blit(col, row, { label: `${nameFor(key)} · ${state}` });
    const st = this.stats[key] ?? (this.stats[key] = {});
    const clear = this.clearRadius();
    if (state === 'idle') {
      const c = this.counts(sub);
      st.tris = c.tris;
      st.draws = c.draws;
      st.points = c.points;
      st.coverage = +(this.coverage(sub) * 100).toFixed(2);
      // Third-person LOD budget.
      const low = this.make(key, 'low');
      const lc = this.counts(low);
      st.lowTris = lc.tris;
      st.lowDraws = lc.draws;
      st.lowPoints = lc.points;
      low.dispose();
    }
    st[`clear_${state}`] = +clear.toFixed(3);
    // Caption with the numbers (after measuring).
    const c = this.ctx();
    c.font = '12px monospace';
    c.fillStyle = '#9fb3cc';
    const text =
      state === 'idle'
        ? `hi ${st.tris}t/${st.draws}d/${st.points}p · lo ${st.lowTris}t/${st.lowDraws}d/${st.lowPoints}p · cov ${st.coverage}% · clear ${clear.toFixed(2)}`
        : `clear ${clear.toFixed(2)}`;
    const tw = c.measureText(text).width;
    c.fillText(text, col * this.cw + this.cw - tw - 8, row * this.ch + 18);
    this.setViewmodel(null);
  }

  private studio(): { scene: THREE.Scene; post: PostFxPipeline } {
    if (this.studioScene && this.studioPost) return { scene: this.studioScene, post: this.studioPost };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.22;
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xb8d0e8, 0x1a1c22, 0.4));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.6);
    key.position.set(-3, 5, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88a6ff, 0.6);
    rim.position.set(2, 2, -4);
    scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.3;
    scene.add(floor);
    this.extra.push(floor);
    scene.add(this.studioCam);
    const post = new PostFxPipeline(this.renderer, scene, this.studioCam);
    post.setOptions({ bloom: true, shadows: false, aa: true, vignette: false });
    post.setSize(this.cw, this.ch);
    this.studioScene = scene;
    this.studioPost = post;
    return { scene, post };
  }

  private turntable(key: string, angle: number, col: number, row: number, state: StateName = 'idle') {
    const { scene, post } = this.studio();
    const sub = this.make(key, 'high');
    this.subjects.push(sub);
    this.simulate(sub, state);
    scene.add(sub.group);
    const dist = this.num('dist', 2.0);
    this.studioCam.aspect = this.cw / this.ch;
    this.studioCam.position.set(-dist * Math.cos(angle), dist * 0.34, -0.24 - dist * Math.sin(angle));
    this.studioCam.lookAt(0, -0.02, -0.24);
    this.studioCam.updateProjectionMatrix();
    post.render();
    this.blit(col, row, { label: `${nameFor(key)} · 3/4 · ${Math.round((angle * 180) / Math.PI)}°` });
    scene.remove(sub.group);
  }

  private thirdPerson(keys: string[], col: number, row: number, far = false) {
    const map = mapById(this.params.get('map') ?? 'reactor');
    const base = new THREE.Vector3(map.spawn.x, map.spawn.y, map.spawn.z - 4);
    const rows: Array<{ anim: CharacterAnimator; slot: THREE.Group; sub: Subject; ch: Character }> = [];
    keys.forEach((key, i) => {
      const slot = new THREE.Group();
      slot.position.set(base.x + (i - (keys.length - 1) / 2) * 1.25, base.y, base.z);
      this.world.add(slot);
      const ch = new Character({ colorHex: skinColorFor(`bot${i}`) });
      slot.add(ch.root);
      const anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
      const sub = this.make(key, 'low');
      sub.group.scale.setScalar(GUN_SCALE);
      sub.group.position.copy(GUN_IN_SOCKET);
      ch.sockets.gun.add(sub.group);
      this.subjects.push(sub);
      rows.push({ anim, slot, sub, ch });
    });
    const yaw = this.num('cyaw', -2.4);
    for (let t = 0; t < 1.5; t += STEP) {
      this.virtualMs += STEP * 1000;
      for (const r of rows) {
        r.anim.update({ dt: STEP, yaw, pitch: 0, pos: r.slot.position });
        r.sub.update(STEP, { charge: 1, firing: 0, streak: 0, reduced: this.reduced, lowSpec: this.low });
      }
    }
    const saved = { p: this.camera.position.clone(), q: this.camera.quaternion.clone(), fov: this.camera.fov };
    const d = far ? 11 : keys.length > 1 ? 5.4 : 3.2;
    this.camera.position.set(base.x - d * 0.55, base.y + (far ? 2.0 : 1.5), base.z + d * 0.84);
    this.camera.lookAt(base.x, base.y + 1.15, base.z);
    this.camera.fov = far ? 40 : 55;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.post.render();
    const label = keys.length > 1 ? `third person · ${far ? 'far' : 'near'}` : `${nameFor(keys[0])} · third person`;
    this.blit(col, row, { label });
    if (keys.length > 1) {
      const c = this.ctx();
      c.font = '12px monospace';
      c.fillStyle = '#e6edf7';
      rows.forEach((r, i) => {
        const l = r.slot.position.clone().add(new THREE.Vector3(0, 2.1, 0)).project(this.camera);
        const tx = nameFor(keys[i]);
        const tw = c.measureText(tx).width;
        c.fillText(tx, col * this.cw + ((l.x + 1) / 2) * this.cw - tw / 2, row * this.ch + ((1 - l.y) / 2) * this.ch);
      });
    }
    for (const r of rows) {
      r.sub.group.removeFromParent();
      this.world.remove(r.slot);
    }
    this.camera.position.copy(saved.p);
    this.camera.quaternion.copy(saved.q);
    this.camera.fov = saved.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  // ── Sheets ────────────────────────────────────────────────────────────────

  run() {
    const sheet = this.params.get('sheet') ?? 'model';
    const model = this.params.get('model') ?? 'prism';
    const c = this.ctx();
    const size = (cols: number, rows: number) => {
      this.out.width = cols * this.cw;
      this.out.height = rows * this.ch;
      c.fillStyle = '#05070b';
      c.fillRect(0, 0, this.out.width, this.out.height);
    };
    const flags = `${this.reduced ? ' · reduced' : ''}${this.low ? ' · low spec' : ''}`;
    if (sheet === 'model') {
      size(3, 2);
      STATES.forEach((s, i) => this.firstPerson(model, s, i % 3, Math.floor(i / 3)));
      this.turntable(model, this.num('angle', 0.55), 1, 1, this.params.get('tstate') === 'streak' ? 'streak' : 'idle');
      this.thirdPerson([model], 2, 1);
      this.caption = `${nameFor(model)}${flags}`;
    } else if (sheet === 'all') {
      const state = (this.params.get('state') ?? 'idle') as StateName;
      const keys = ['stock', ...CUSTOM_GUN_KEYS];
      size(3, 3);
      keys.forEach((k, i) => this.firstPerson(k, state, i % 3, Math.floor(i / 3)));
      this.caption = `all · ${state}${flags}`;
    } else if (sheet === 'tp') {
      size(1, 2);
      const keys = ['stock', ...CUSTOM_GUN_KEYS];
      this.thirdPerson(keys, 0, 0, false);
      this.thirdPerson(keys, 0, 1, true);
      this.caption = `third person${flags}`;
    } else if (sheet === 'turn') {
      size(3, 2);
      const angles = [0.15, 0.55, 1.1, 1.8, 2.6, 3.4];
      angles.forEach((a, i) => this.turntable(model, a, i % 3, Math.floor(i / 3), i % 2 ? 'streak' : 'idle'));
      this.caption = `${nameFor(model)} turntable${flags}`;
    } else if (sheet === 'single') {
      size(1, 1);
      this.firstPerson(model, (this.params.get('state') ?? 'idle') as StateName, 0, 0);
      this.caption = `${nameFor(model)}${flags}`;
    }
  }

  dispose() {
    performance.now = this.realNow;
    for (const s of this.subjects) s.dispose();
    for (const o of this.extra) {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.post.dispose();
    this.studioPost?.dispose();
    this.renderer.dispose();
  }
}
