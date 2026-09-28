import * as THREE from 'three';
import { createCamera, createRenderer, createScene, applyMapShadowFlags, PostFxPipeline } from '../renderer';
import { buildMapMesh, mapById, rayAabb, type ArenaMap } from '../map';
import { buildRailgun, type RailgunModel } from '../weapon-model';
import { ViewmodelMotion } from '../viewmodel-motion';
import { EYE_HEIGHT, RAIL_COOLDOWN, VIEWMODEL_BASE, VIEWMODEL_SCALE } from '../constants';
import { RAILGUN_FINISHES, RAIL_COLORS, railColorById, railgunFinishById } from '../cosmetics';
import { localRail } from '../fx/rail-state';
import { Railgun } from '../weapon';
import { getFxContext } from '../fx-pool';
import { RailBeams } from '../fx/rail-beam';
import { Character, skinColorFor } from '../character/character';
import { CharacterAnimator } from '../character-anim';
import { attachRailgun, type AttachedRailgun } from '../character/gun';
import { railgunGeometry, railgunGeometrySplit } from './gun-geometry';
import { prewarmGuns } from './prewarm';
import { sheenDebug } from './gun-extras';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// ─────────────────────────────────────────────────────────────────────────
// Gun lab (dev only, /gunlab). Deterministic frames for the railgun track:
// a virtual clock replaces performance.now so a frame "60 ms after a shot" is
// the same every capture.
//
//   ?view=vm      first-person viewmodel in a real arena (default)
//     &map=reactor &pos=x,y,z &yaw=&pitch= &fov=90 &zoom=1
//     &finish=gun.stock  &fire=<s after a shot>  &beam=<rail colour id>
//     &wall=side:0.3|front:0.6   test slab for the clipping check
//     &overlay=0   old path: gun parented to the world camera (clips)
//     &post=0      every post pass off (the direct-render path)
//   ?view=sheet   contact sheet of every finish (&lod=low, &fire=…)
//   ?view=beams   every rail colour as a row (&age=0.12 &top=1.5 &bottom=-1.1), or one
//                 shot across the arena into a wall (&only=rail.spectrum)
//   ?view=tp      third-person guns on combatants (&far=1 &from=6 &count=6
//                 &fireidx=1 &fire=<s since that gun's shot>)
//   &off=x,y,z    viewmodel offset (the user setting) for coverage trials
// window.__gunlab.coverage() → fraction of the screen the viewmodel covers.
// ─────────────────────────────────────────────────────────────────────────

// anchor 'below' (default): centred under the point; 'left': to the left of
// the point, vertically centred on it (row labels).
type Label = { x: number; y: number; text: string; anchor?: 'below' | 'left' };
type LabelSink = (labels: Label[], caption: string) => void;

const T0 = 10_000; // virtual ms at the start of every timeline
const STEP = 1 / 120;

export class GunLab {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private post: PostFxPipeline | null = null;
  private raf: number | null = null;
  private disposed = false;
  private virtualMs = T0;
  private readonly realNow = performance.now.bind(performance);
  private readonly view: string;
  private map: ArenaMap | null = null;
  private gun: RailgunModel | null = null;
  private readonly guns: RailgunModel[] = [];
  private readonly motion = new ViewmodelMotion();
  private readonly railgun = new Railgun();
  private frame: (() => void) | null = null;
  prewarmMs = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly params: URLSearchParams,
    private readonly sink: LabelSink,
  ) {
    performance.now = () => this.virtualMs;
    this.renderer = createRenderer(canvas);
    this.scene = createScene(this.renderer);
    this.camera = createCamera(canvas);
    this.view = params.get('view') ?? 'vm';
    this.resize();
    if (this.view === 'vm') this.setupViewmodel();
    else if (this.view === 'sheet') this.setupSheet();
    else if (this.view === 'beams') this.setupBeams();
    else if (this.view === 'tp') this.setupThirdPerson();
  }

  private num(name: string, def: number): number {
    const v = this.params.get(name);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  }

  // Item qualities from the URL: &streak=10 &sheen=sheen.violet &ks=ks.fire
  // (professional) &festive=1 &strange=137.
  private applyQualities(g: {
    setStreak(n: number): void;
    setKillstreak(s: string | null, k: string | null): void;
    setFestive(on: boolean): void;
    setStrangeKills?(n: number | null): void;
  }) {
    const p = this.params;
    if (p.has('sweep')) sheenDebug.phase = this.num('sweep', 0.5);
    g.setStreak(this.num('streak', 0));
    g.setKillstreak(p.get('sheen'), p.get('ks'));
    g.setFestive(p.get('festive') === '1');
    if (p.has('strange')) g.setStrangeKills?.(this.num('strange', 0));
  }

  // ── First-person view ─────────────────────────────────────────────────────
  private setupViewmodel() {
    const p = this.params;
    const map = mapById(p.get('map') ?? 'reactor');
    this.map = map;
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.scene.add(mesh);
    const pos = (p.get('pos') ?? '').split(',').map(Number);
    if (pos.length === 3 && pos.every(Number.isFinite)) this.camera.position.set(pos[0], pos[1], pos[2]);
    else this.camera.position.set(map.spawn.x, map.spawn.y + EYE_HEIGHT, map.spawn.z);
    this.camera.rotation.set(this.num('pitch', 0), this.num('yaw', 0), 0, 'YXZ');
    const zoom = this.num('zoom', 0);
    this.camera.fov = zoom > 0 ? 55 : this.num('fov', 90);
    this.camera.updateProjectionMatrix();
    this.scene.add(this.camera);
    this.camera.updateMatrixWorld(true);

    const postOn = p.get('post') !== '0';
    this.post = new PostFxPipeline(this.renderer, this.scene, this.camera);
    this.post.setOptions({ bloom: postOn, shadows: postOn, aa: postOn, vignette: postOn });
    // &prewarm=1: time the shader warm-up (window.__gunlab.prewarmMs).
    if (p.get('prewarm') === '1') {
      const t0 = this.realNow();
      void prewarmGuns(this.post).then(() => {
        this.prewarmMs = this.realNow() - t0;
      });
    }

    const finish = railgunFinishById(p.get('finish') ?? 'gun.stock').data;
    const gun = buildRailgun(finish);
    this.gun = gun;
    gun.group.scale.setScalar(VIEWMODEL_SCALE);
    this.applyQualities(gun);
    if (p.get('overlay') === '0') this.camera.add(gun.group);
    else this.post.viewmodel.camera.add(gun.group);

    const wall = p.get('wall');
    if (wall) this.addTestWall(wall);

    this.motion.setIntensity(0);
    const fireT = p.has('fire') ? this.num('fire', 0) : -1;
    const beam = p.get('beam');
    const rc = beam ? railColorById(beam) : null;
    if (rc) this.railgun.setBeamColors(rc.data.core, rc.data.helix, rc.mode);
    // Settle the pose (zoom tuck etc.) for 2 s, then run the shot timeline.
    for (let t = 0; t < 2; t += STEP) this.stepPose(STEP, zoom);
    localRail.charge = 1;
    this.renderOnce(); // registers the live muzzle (fx/rail-state.ts)
    if (fireT >= 0) {
      localRail.owner = this.railgun;
      if (rc) {
        const eye = this.camera.getWorldPosition(new THREE.Vector3());
        const dir = this.camera.getWorldDirection(new THREE.Vector3());
        this.railgun.fire(eye, dir, this.scene, map.boxes, [], undefined, map);
      } else {
        localRail.shots++;
      }
      localRail.charge = 0;
      this.motion.onFire();
      if (gun.glow) gun.glow.emissiveIntensity = 4.5;
      this.renderOnce(); // the coil driver latches the shot at T0
      const fx = getFxContext(this.scene);
      for (let t = 0; t < fireT; t += STEP) {
        this.virtualMs = T0 + (t + STEP) * 1000;
        localRail.charge = Math.min(1, (t + STEP) / RAIL_COOLDOWN);
        this.stepPose(STEP, zoom);
        fx.step(STEP);
        gun.glow.emissiveIntensity += (0.8 - gun.glow.emissiveIntensity) * (1 - Math.exp(-11.9 * STEP));
      }
    } else {
      gun.glow.emissiveIntensity = 0.8;
    }
    this.frame = () => this.post?.render();
    this.sink(
      [],
      `vm · ${p.get('finish') ?? 'gun.stock'} · fov ${this.camera.fov} · fire ${fireT >= 0 ? fireT : '—'} · overlay ${p.get('overlay') === '0' ? 'off' : 'on'}`,
    );
  }

  private stepPose(dt: number, zoom: number) {
    const gun = this.gun;
    if (!gun) return;
    const pose = this.motion.update({
      dt,
      yaw: 0,
      pitch: 0,
      groundSpeed: 0,
      lateralSpeed: 0,
      grounded: true,
      zoom,
      reducedEffects: false,
    });
    // &off=x,y,z: the user's viewmodel offset setting (or a placement trial).
    const off = (this.params.get('off') ?? '0,0,0').split(',').map((v) => Number(v) || 0);
    gun.group.position.set(
      VIEWMODEL_BASE.x + pose.x + (off[0] ?? 0),
      VIEWMODEL_BASE.y + pose.y + (off[1] ?? 0),
      VIEWMODEL_BASE.z + pose.z + (off[2] ?? 0),
    );
    gun.group.rotation.set(pose.rx, pose.ry, pose.rz);
    const m = pose.muzzle;
    gun.muzzleFlash.visible = m > 0;
    if (m > 0) {
      gun.muzzleFlash.material.opacity = m;
      gun.muzzleFlash.scale.setScalar(1 + (1 - m) * 0.9);
    }
  }

  private addTestWall(spec: string) {
    const [kind, dStr] = spec.split(':');
    const d = Number(dStr) || 0.4;
    const geo = new THREE.BoxGeometry(kind === 'front' ? 8 : 0.05, 6, kind === 'front' ? 0.05 : 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x59606b, roughness: 0.8, metalness: 0.1 });
    const slab = new THREE.Mesh(geo, mat);
    // Camera-local placement: a side wall hugging the right, or a wall ahead.
    if (kind === 'front') slab.position.set(0, 0, -d);
    else slab.position.set(d, 0, -3.8);
    slab.position.applyMatrix4(this.camera.matrixWorld);
    slab.quaternion.copy(this.camera.quaternion);
    this.scene.add(slab);
  }

  // ── Contact sheet: every finish, same framing ────────────────────────────
  private studio(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141b);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xb8d0e8, 0x3a3e46, 0.55));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.6);
    key.position.set(-3, 5, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88a6ff, 0.6);
    rim.position.set(2, 2, -4);
    scene.add(rim);
    return scene;
  }

  private setupSheet() {
    const p = this.params;
    const lod = p.get('lod') === 'low' ? 'low' : 'high';
    const scene = this.studio();
    const list = RAILGUN_FINISHES;
    const cols = this.num('cols', 4);
    const rows = Math.ceil(list.length / cols);
    for (const f of list) {
      const g = buildRailgun(f.data, { lod });
      g.group.visible = false;
      scene.add(g.group);
      this.guns.push(g);
    }
    const cam = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
    // From the gun's left, a little above (the side the viewmodel shows);
    // `angle` swings the camera toward the muzzle, `dist` pulls back.
    const angle = this.num('angle', 0.35);
    const dist = this.num('dist', 2.15);
    cam.position.set(-dist * Math.cos(angle), dist * 0.38, -0.24 - dist * Math.sin(angle));
    cam.lookAt(0, -0.02, -0.24);
    const labels: Label[] = list.map((f, i) => ({
      x: ((i % cols) + 0.5) / cols,
      y: (Math.floor(i / cols) + 0.86) / rows,
      text: `${f.name} · ${f.data.pattern ?? 'plain'}`,
    }));
    this.sink(labels, `sheet · lod ${lod} · ${list.length} finishes`);
    const size = new THREE.Vector2();
    this.frame = () => {
      this.renderer.getSize(size);
      const cw = size.x / cols;
      const ch = size.y / rows;
      cam.aspect = cw / ch;
      cam.updateProjectionMatrix();
      this.renderer.setScissorTest(true);
      this.guns.forEach((g, i) => {
        const x = (i % cols) * cw;
        const y = size.y - (Math.floor(i / cols) + 1) * ch;
        this.renderer.setViewport(x, y, cw, ch);
        this.renderer.setScissor(x, y, cw, ch);
        for (const o of this.guns) o.group.visible = o === g;
        this.renderer.render(scene, cam);
      });
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, size.x, size.y);
    };
  }

  // ── Every rail colour, side by side ───────────────────────────────────────
  private setupBeams() {
    const p = this.params;
    const map = mapById(p.get('map') ?? 'reactor');
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.scene.add(mesh);
    this.camera.position.set(map.spawn.x, map.spawn.y + EYE_HEIGHT, map.spawn.z);
    this.camera.rotation.set(this.num('pitch', 0), this.num('yaw', 0), 0, 'YXZ');
    this.camera.fov = this.num('fov', 70);
    this.camera.updateProjectionMatrix();
    this.scene.add(this.camera);
    this.camera.updateMatrixWorld(true);
    this.post = new PostFxPipeline(this.renderer, this.scene, this.camera);
    const postOn = p.get('post') !== '0';
    this.post.setOptions({ bloom: postOn, shadows: postOn, aa: postOn, vignette: postOn });
    const beams = new RailBeams();
    if (p.get('low') === '1') beams.setQuality(0.5);
    this.scene.add(beams.group);
    const only = p.get('only');
    const list = only ? RAIL_COLORS.filter((c) => c.id === only) : RAIL_COLORS;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const eye = this.camera.position.clone();
    const dist = this.num('dist', only ? 7 : 8);
    const labels: Label[] = [];
    if (only && list[0]) {
      // One beam, the way you see someone else's shot: from beside you, out
      // across the arena into a wall (the flare lands there).
      const c = list[0];
      // &near=1: an enemy rail from 25 m out that skims ~0.7 m past your head.
      const nearPass = p.get('near') === '1';
      const a = nearPass
        ? eye.clone().addScaledVector(fwd, 25).addScaledVector(right, -3).addScaledVector(up, -0.2)
        : eye.clone().addScaledVector(right, 1.4).addScaledVector(up, -0.35).addScaledVector(fwd, 1.2);
      const dir = nearPass
        ? eye.clone().addScaledVector(right, 0.7).addScaledVector(up, -0.3).sub(a).normalize()
        : fwd.clone().multiplyScalar(1).addScaledVector(right, -0.55).addScaledVector(up, 0.02).normalize();
      let t = 60;
      for (const box of map.boxes) {
        const h = rayAabb({ x: a.x, y: a.y, z: a.z }, { x: dir.x, y: dir.y, z: dir.z }, box);
        if (h !== null && h > 0 && h < t) t = h;
      }
      beams.spawn(a, a.clone().addScaledVector(dir, t), c.data.core, c.data.helix, false, { mode: c.mode, impact: true });
      labels.push({ x: 0.5, y: 0.04, text: c.name });
    } else {
      // Every colour as a row: top 1.5 m above the eye … bottom 0.5 m off the
      // floor, each label centred on its own beam's left end.
      const top = this.num('top', 1.5);
      const bottom = this.num('bottom', -1.1);
      const gap = list.length > 1 ? (top - bottom) / (list.length - 1) : 0;
      list.forEach((c, i) => {
        const yOff = top - i * gap;
        const a = eye.clone().addScaledVector(fwd, dist).addScaledVector(right, -4.5).addScaledVector(up, yOff);
        const b = eye.clone().addScaledVector(fwd, dist + 4).addScaledVector(right, 6).addScaledVector(up, yOff);
        beams.spawn(a, b, c.data.core, c.data.helix, false, { mode: c.mode, impact: true });
        const l = a.clone().project(this.camera);
        labels.push({ x: (l.x + 1) / 2, y: (1 - l.y) / 2, text: c.name, anchor: 'left' });
      });
    }
    const age = this.num('age', 0.12);
    for (let t = 0; t < age; t += STEP) {
      this.virtualMs = T0 + (t + STEP) * 1000;
      beams.step(STEP);
    }
    this.sink(labels, `beams · age ${age}s`);
    this.frame = () => this.post?.render();
  }

  // ── Third person: combatants holding the gun ──────────────────────────────
  private setupThirdPerson() {
    const p = this.params;
    const map = mapById(p.get('map') ?? 'reactor');
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.scene.add(mesh);
    const far = p.get('far') === '1';
    const list = RAILGUN_FINISHES.slice(this.num('from', 0), this.num('from', 0) + this.num('count', 6));
    const base = new THREE.Vector3(map.spawn.x, map.spawn.y, map.spawn.z);
    const rows: Array<{ anim: CharacterAnimator; slot: THREE.Group; gun: AttachedRailgun }> = [];
    list.forEach((f, i) => {
      const slot = new THREE.Group();
      slot.position.set(base.x + (i - (list.length - 1) / 2) * 1.3, base.y, base.z - 4);
      this.scene.add(slot);
      const ch = new Character({ colorHex: skinColorFor(`bot${i}`) });
      slot.add(ch.root);
      const anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
      const gun = attachRailgun(ch, f.data);
      this.applyQualities(gun);
      rows.push({ anim, slot, gun });
    });
    const yaw = this.num('cyaw', -2.4);
    const fireIdx = this.num('fireidx', 1);
    const fireAgo = this.num('fire', 0.05);
    const total = 1.5;
    let fired = false;
    for (let t = 0; t < total; t += STEP) {
      this.virtualMs = T0 + t * 1000;
      if (!fired && t >= total - fireAgo) {
        fired = true;
        rows[fireIdx]?.gun.notifyFire();
      }
      for (const r of rows) r.anim.update({ dt: STEP, yaw, pitch: this.num('apitch', 0), pos: r.slot.position });
    }
    const d = far ? 14 : 4.2;
    this.camera.position.set(base.x - d * 0.55, base.y + (far ? 2.2 : 1.55), base.z - 4 + d * 0.84);
    this.camera.lookAt(base.x, base.y + 1.2, base.z - 4);
    this.camera.fov = far ? 40 : 55;
    this.camera.updateProjectionMatrix();
    this.scene.add(this.camera);
    this.camera.updateMatrixWorld(true);
    this.post = new PostFxPipeline(this.renderer, this.scene, this.camera);
    this.post.setOptions({ bloom: true, shadows: true, aa: true, vignette: false });
    const labels: Label[] = [];
    rows.forEach((r, i) => {
      const l = r.slot.position.clone().add(new THREE.Vector3(0, 2.15, 0)).project(this.camera);
      labels.push({ x: (l.x + 1) / 2, y: (1 - l.y) / 2, text: list[i].name });
    });
    this.sink(labels, `tp · ${far ? 'far' : 'near'} · fired: ${list[fireIdx]?.name ?? '—'}`);
    this.frame = () => this.post?.render();
  }

  private renderOnce() {
    this.post?.render();
  }

  // Fraction of the frame the viewmodel covers (its own layer, flat white on
  // black, flare hidden), at the current pose.
  coverage(): number {
    const post = this.post;
    const gun = this.gun;
    if (!post || !gun) return 0;
    const w = 800;
    const h = Math.round(w / this.camera.aspect);
    const rt = new THREE.WebGLRenderTarget(w, h);
    const layer = post.viewmodel;
    layer.sync();
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const flash = gun.muzzleFlash.visible;
    gun.muzzleFlash.visible = false;
    const prevParent = gun.group.parent;
    if (prevParent !== layer.camera) layer.camera.add(gun.group);
    layer.scene.overrideMaterial = white;
    const bg = layer.scene.background;
    layer.scene.background = new THREE.Color(0x000000);
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(layer.scene, layer.camera);
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    this.renderer.setRenderTarget(null);
    layer.scene.overrideMaterial = null;
    layer.scene.background = bg;
    if (prevParent && prevParent !== layer.camera) prevParent.add(gun.group);
    gun.muzzleFlash.visible = flash;
    white.dispose();
    rt.dispose();
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
    return n / (w * h);
  }

  // Triangle counts per LOD (the budget check) — every LOD is one draw call
  // (+ the hidden flare in first person; + the energy mesh in third person).
  stats(): Record<string, number> {
    const tris = (g: THREE.BufferGeometry) => g.attributes.position.count / 3;
    const split = railgunGeometrySplit('low');
    return {
      high: tris(railgunGeometry('high')),
      low: tris(railgunGeometry('low')),
      lowShell: tris(split.lit),
      lowEnergy: tris(split.energy),
    };
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    const tick = () => {
      if (this.disposed) return;
      this.frame?.();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    performance.now = this.realNow;
    this.post?.dispose();
    this.renderer.dispose();
    for (const g of this.guns) g.dispose();
  }
}
