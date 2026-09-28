import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { KILL_EFFECTS, type KillEffectStyle } from '../cosmetics';
import { UNUSUAL_EFFECTS } from '../items/types';
import { UnusualEffect, unusualKindForEffect } from './unusuals';
import { TauntAura } from './taunt-aura';
import { KillstreakEyes } from './killstreak-eyes';
import { KS_EFFECTS } from '../items/types';
import { BLOOM_TUNING, createRenderer, createScene, getArenaLighting } from '../renderer';
import { CharacterAnimator } from '../character-anim';
import { Character, SKIN_PALETTE } from '../character/character';
import { setCharacterFxQuality } from '../character/gibs';
import { EffectsManager, prewarmFx } from '../effects';
import { WornHat } from '../hats';

// ── FX lab (dev only) ────────────────────────────────────────────────────────
// A tiled, game-accurate review harness for finishers and unusuals: the real
// renderer + ACES + the arena's peak-channel bloom, one combatant per tile,
// each tile its own camera. Tiles render into one HDR buffer so bloom is
// judged exactly as in a match.
//
//   /fxlab                         finishers: every style dying on a loop
//   /fxlab?t=0.25                  finishers frozen at t seconds after death
//   /fxlab?hs=1                    headshot variants
//   /fxlab?mode=unusuals&page=0    unusuals: rows = Locker (FOV 30) / 2 m /
//                                  10 m / 30 m (FOV 90, true pixel scale)
//   &fx=reduced|low  &bg=dark|bright  &hat=hat.cap  &styles=a,b  &kinds=a,b
//   &move=1 (unusuals: wearers strafe, to show the world-space trails)
//
// window.__ig.setPlayerView(t) re-freezes the finisher sheet at time t (so
// scripts/shot.mjs can take several moments in one run).

type Tile = {
  x: number; y: number; w: number; h: number; // CSS px, top-left origin
  cam: THREE.PerspectiveCamera;
  label: string;
  camX?: number; // unusuals + move: the camera tracks the wearer sideways
};

type Actor = {
  slot: THREE.Group;
  ch: Character;
  anim: CharacterAnimator;
  hat: WornHat | null;
  fx: UnusualEffect | null; // v3 unusual (any kind), parked on the hat anchor
  style: KillEffectStyle;
  // unusuals + move: strafe path
  base: THREE.Vector3;
  moving: boolean;
};

// The high-pass keys on the brightest channel (same as the arena's bloom).
class LabBloomPass extends UnrealBloomPass {
  constructor(res: THREE.Vector2) {
    super(res, BLOOM_TUNING.strength, BLOOM_TUNING.radius, BLOOM_TUNING.threshold);
    const hp = this.materialHighPassFilter;
    const stock = 'float v = luminance( texel.xyz );';
    if (hp.fragmentShader.includes(stock)) {
      hp.fragmentShader = hp.fragmentShader.replace(stock, 'float v = max( texel.r, max( texel.g, texel.b ) );');
      hp.needsUpdate = true;
    }
    const u = this.highPassUniforms as Record<string, { value: unknown }>;
    if (u.smoothWidth) u.smoothWidth.value = BLOOM_TUNING.knee;
  }
}

// Renders every tile (its own camera, viewport + scissor) into the HDR buffer.
class TiledRenderPass extends Pass {
  constructor(
    private readonly scene: THREE.Scene,
    private readonly tiles: () => Tile[],
    private readonly cssH: () => number,
  ) {
    super();
    this.needsSwap = false;
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    const pr = renderer.getPixelRatio();
    const H = this.cssH();
    renderer.setRenderTarget(read);
    read.scissorTest = false;
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    read.scissorTest = true;
    for (const t of this.tiles()) {
      const x = Math.round(t.x * pr);
      const y = Math.round((H - t.y - t.h) * pr);
      const w = Math.round(t.w * pr);
      const h = Math.round(t.h * pr);
      read.viewport.set(x, y, w, h);
      read.scissor.set(x, y, w, h);
      renderer.setRenderTarget(read);
      renderer.clear();
      renderer.render(this.scene, t.cam);
    }
    read.scissorTest = false;
    read.viewport.set(0, 0, read.width, read.height);
    read.scissor.set(0, 0, read.width, read.height);
  }
}

const STEP = 1 / 120;
const PERIOD = 2.6;
const DIE_AT = 0.35;
const RESPAWN_AT = 2.25;
const SPACING = 60;

export class FxLab {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly composer: EffectComposer;
  private readonly effects = new EffectsManager();
  private readonly mode: 'finishers' | 'unusuals' | 'taunts' | 'eyes';
  private readonly auras: TauntAura[] = [];
  private readonly eyes: KillstreakEyes[] = [];
  private readonly actors: Actor[] = [];
  private tiles: Tile[] = [];
  private raf: number | null = null;
  private last = 0;
  private clock = 0;
  private frozenAt: number | null = null;
  private disposed = false;
  private readonly floor: THREE.Mesh;
  private readonly hs: boolean;
  private readonly reduced: boolean;
  onLabels: ((tiles: { x: number; y: number; w: number; h: number; label: string }[]) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly params: URLSearchParams,
  ) {
    this.renderer = createRenderer(canvas);
    this.renderer.setPixelRatio(1);
    this.scene = createScene(this.renderer);
    const light = getArenaLighting(this.scene);
    if (light) light.sky.visible = false;
    const bg = params.get('bg') ?? 'dark';
    this.scene.background = new THREE.Color(bg === 'bright' ? 0x8da4bf : bg === 'mid' ? 0x3a4250 : 0x0e1219);
    this.scene.fog = null;
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 400),
      new THREE.MeshStandardMaterial({ color: bg === 'bright' ? 0x7d8795 : 0x252b34, roughness: 0.85, metalness: 0.05 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.x = 1500;
    this.scene.add(this.floor);

    const fx = params.get('fx');
    this.reduced = fx === 'reduced';
    setCharacterFxQuality({ reducedEffects: this.reduced, lowSpec: fx === 'low' });
    this.effects.setQuality(fx === 'low' ? 0.5 : 1);
    this.effects.warm(this.scene);
    // Mark the FX context as stepped before any freeze(): the death
    // animations only spawn their pooled debris (voxels, shards, confetti,
    // ash) into a context something steps.
    this.effects.step(0, this.scene);
    this.hs = params.get('hs') === '1';
    const m = params.get('mode');
    this.mode = m === 'unusuals' ? 'unusuals' : m === 'taunts' ? 'taunts' : m === 'eyes' ? 'eyes' : 'finishers';

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new TiledRenderPass(this.scene, () => this.tiles, () => this.cssSize().h));
    this.composer.addPass(new LabBloomPass(new THREE.Vector2(256, 256)));
    this.composer.addPass(new OutputPass());

    if (this.mode === 'finishers') this.buildFinishers();
    else if (this.mode === 'taunts') this.buildTaunts();
    else if (this.mode === 'eyes') this.buildEyes();
    else this.buildUnusuals();
    this.resize();
    // Smoke-test the shader prewarm the game calls at match load.
    if (this.tiles[0]) void prewarmFx(this.renderer, this.scene, this.tiles[0].cam);
    const t = params.get('t');
    if (t !== null && this.mode === 'finishers') this.freeze(Number(t));
    (window as unknown as { __fxlab?: FxLab }).__fxlab = this;
    // shot.mjs drives views through window.__ig.setPlayerView(yaw, …).
    (window as unknown as { __ig?: unknown }).__ig = { setPlayerView: (t: number) => this.freeze(t) };
  }

  private cssSize() {
    return { w: this.canvas.clientWidth || 1600, h: this.canvas.clientHeight || 900 };
  }

  private addActor(i: number, style: KillEffectStyle, hatId: string | null, unusualId: string | null): Actor {
    const slot = new THREE.Group();
    slot.position.set(i * SPACING, 0, 0);
    const colorHex = SKIN_PALETTE[i % SKIN_PALETTE.length];
    const ch = new Character({ colorHex });
    slot.add(ch.root);
    this.scene.add(slot);
    const anim = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
    anim.updateStatic(0);
    let hat: WornHat | null = null;
    let fx: UnusualEffect | null = null;
    if (hatId || unusualId) {
      hat = new WornHat(ch.sockets.headTop);
      if (hatId) void hat.setHat(hatId);
      const kind = unusualKindForEffect(unusualId);
      if (kind) {
        fx = new UnusualEffect(kind);
        (hat as unknown as { unusualAnchor: THREE.Group }).unusualAnchor.add(fx.group);
      }
    }
    const a: Actor = { slot, ch, anim, hat, fx, style, base: slot.position.clone(), moving: false };
    this.actors.push(a);
    return a;
  }

  // ── Finishers ──

  private buildFinishers() {
    const pick = this.params.get('styles');
    const styles = (pick ? pick.split(',') : KILL_EFFECTS.map((k) => k.id)) as KillEffectStyle[];
    styles.forEach((s, i) => this.addActor(i, s, null, null));
  }

  private layoutFinishers() {
    const { w: W, h: H } = this.cssSize();
    const n = this.actors.length;
    const cols = Number(this.params.get('cols') ?? Math.min(n, 5));
    const rows = Math.ceil(n / cols);
    const tw = Math.floor(W / cols);
    const th = Math.floor(H / rows);
    const fov = Number(this.params.get('fov') ?? 70);
    const dist = Number(this.params.get('dist') ?? 4.6);
    this.tiles = this.actors.map((a, i) => {
      const cam = new THREE.PerspectiveCamera(fov, tw / th, 0.05, 400);
      const c = a.slot.position;
      if (this.params.get('side') === '1') cam.position.set(c.x + dist, 1.3, 0.4);
      else cam.position.set(c.x + dist * 0.28, 1.65, dist);
      cam.lookAt(c.x, 1.0, 0);
      const name = KILL_EFFECTS.find((k) => k.id === a.style)?.name ?? a.style;
      return { x: (i % cols) * tw, y: Math.floor(i / cols) * th, w: tw, h: th, cam, label: `${name} (${a.style})` };
    });
  }

  private kill(a: Actor) {
    const at = new THREE.Vector3(a.slot.position.x, 0.9, a.slot.position.z);
    const tint = a.ch.getColor(new THREE.Color());
    if (this.reduced) this.effects.spawnHitFlash(this.scene, at, this.hs ? 0xffd27a : 0x9be8ff);
    else this.effects.spawnKillBurst(this.scene, at, this.hs, a.style, tint);
    a.anim.die({ y: 0 }, a.style);
  }

  // Freeze the finisher sheet at `t` seconds after death (deterministic
  // fixed-step simulation from the moment of the kill).
  // Nothing advances while frozen (bodies, pool, sprites, arcs, lights all
  // stop at t), so a capture is faithful however long it settles.
  freeze(t: number) {
    if (this.mode !== 'finishers') return;
    this.effects.clear(this.scene);
    for (const a of this.actors) {
      a.anim.respawn();
      a.anim.updateStatic(0);
    }
    for (const a of this.actors) this.kill(a);
    let s = 0;
    while (s + STEP <= t + 1e-9) {
      s += STEP;
      for (const a of this.actors) a.anim.updateStatic(STEP);
      this.effects.step(STEP, this.scene);
    }
    this.frozenAt = t;
  }

  // ── Unusuals ──

  private readonly views = [
    { key: 'locker', label: 'Locker FOV30', fov: 30, dist: 1.95, fullH: 560, eye: 1.66 },
    { key: 'd2', label: '2 m FOV90', fov: 90, dist: 2, fullH: 900, eye: 1.6 },
    { key: 'd10', label: '10 m FOV90', fov: 90, dist: 10, fullH: 900, eye: 1.6 },
    { key: 'd30', label: '30 m FOV90', fov: 90, dist: 30, fullH: 900, eye: 1.6 },
  ] as const;
  private kinds: string[] = [];

  private buildUnusuals() {
    const all = UNUSUAL_EFFECTS.map((u) => u.id);
    const pick = this.params.get('kinds');
    // `kinds=` takes effect ids (fx.storm) or bare kinds (storm).
    let kinds = pick ? pick.split(',').map((k) => (k.startsWith('fx.') ? k : `fx.${k}`)) : all;
    if (!pick) {
      const page = Number(this.params.get('page') ?? 0);
      kinds = all.slice(page * 5, page * 5 + 5);
    }
    this.kinds = kinds;
    const hat = this.params.get('hat') ?? 'hat.cap';
    const move = this.params.get('move') === '1';
    let i = 0;
    for (let v = 0; v < this.views.length; v++) {
      for (const k of kinds) {
        const a = this.addActor(i++, 'pulse', hat === 'none' ? null : hat, k);
        a.moving = move;
        a.slot.rotation.y = 0.35;
      }
    }
  }

  private layoutUnusuals() {
    const { w: W, h: H } = this.cssSize();
    const cols = this.kinds.length;
    const rows = this.views.length;
    const tw = Math.floor(W / cols);
    const th = Math.floor(H / rows);
    this.tiles = [];
    let i = 0;
    for (let v = 0; v < rows; v++) {
      const view = this.views[v];
      for (let c = 0; c < cols; c++, i++) {
        const a = this.actors[i];
        const fullH = view.fullH;
        const fullW = Math.round(fullH * (16 / 9));
        const cam = new THREE.PerspectiveCamera(view.fov, fullW / fullH, 0.05, 500);
        const p = a.base;
        cam.position.set(p.x, view.eye, view.dist);
        cam.lookAt(p.x, view.key === 'locker' ? 1.56 : view.eye, 0);
        // Crop a tile-sized window around the crown at true pixel scale.
        cam.updateMatrixWorld();
        const crown = new THREE.Vector3(p.x, view.key === 'locker' ? 2.04 : 1.95, 0).project(cam);
        const cx = (crown.x * 0.5 + 0.5) * fullW;
        const cy = (1 - (crown.y * 0.5 + 0.5)) * fullH;
        cam.setViewOffset(fullW, fullH, cx - tw / 2, cy - th / 2, tw, th);
        const name = UNUSUAL_EFFECTS.find((u) => u.id === this.kinds[c])?.name ?? this.kinds[c];
        this.tiles.push({ x: c * tw, y: v * th, w: tw, h: th, cam, label: `${name} · ${view.label}`, camX: cam.position.x });
      }
    }
  }

  // ── Taunt auras: full body, camera 5 m back (FOV 50); `dist=` overrides. ──

  private buildTaunts() {
    const all = UNUSUAL_EFFECTS.map((u) => u.id);
    const pick = this.params.get('kinds');
    let kinds = pick ? pick.split(',').map((k) => (k.startsWith('fx.') ? k : `fx.${k}`)) : all;
    if (!pick) {
      const page = Number(this.params.get('page') ?? 0);
      kinds = all.slice(page * 5, page * 5 + 5);
    }
    this.kinds = kinds;
    kinds.forEach((k, i) => {
      const a = this.addActor(i, 'pulse', null, null);
      a.slot.rotation.y = 0.3;
      const kind = unusualKindForEffect(k);
      if (kind) {
        const aura = new TauntAura(kind);
        a.ch.root.add(aura.group);
        this.auras.push(aura);
      }
    });
  }

  // ── Professional killstreak eyes: 7 effects, head close-up over a 4 m view. ──

  private buildEyes() {
    this.kinds = KS_EFFECTS.map((k) => k.id);
    const streak = Number(this.params.get('streak') ?? 10);
    const fp = this.params.get('fp') === '1';
    this.kinds.forEach((id, i) => {
      const a = this.addActor(i, 'pulse', null, null);
      a.slot.rotation.y = 0.35;
      const e = new KillstreakEyes();
      a.ch.sockets.headTop.add(e.group);
      e.setEffect(id);
      e.setStreak(streak);
      e.setFirstPerson(fp);
      this.eyes.push(e);
    });
  }

  private layoutEyes() {
    const { w: W, h: H } = this.cssSize();
    const n = this.actors.length;
    const tw = Math.floor(W / n);
    const th = Math.floor(H / 2);
    this.tiles = [];
    for (let row = 0; row < 2; row++) {
      this.actors.forEach((a, i) => {
        const cam = new THREE.PerspectiveCamera(row === 0 ? 30 : 50, tw / th, 0.05, 200);
        const c = a.slot.position;
        if (row === 0) { cam.position.set(c.x + 0.5, 1.68, 1.05); cam.lookAt(c.x, 1.64, 0); }
        else { cam.position.set(c.x, 1.5, 4.5); cam.lookAt(c.x, 1.5, 0); }
        const name = KS_EFFECTS.find((k) => k.id === this.kinds[i])?.name ?? this.kinds[i];
        this.tiles.push({ x: i * tw, y: row * th, w: tw, h: th, cam, label: `${name} · ${row === 0 ? 'close' : '4.5 m'}` });
      });
    }
  }

  private layoutTaunts() {
    const { w: W, h: H } = this.cssSize();
    const n = this.actors.length;
    const tw = Math.floor(W / n);
    const dist = Number(this.params.get('dist') ?? 5);
    this.tiles = this.actors.map((a, i) => {
      const cam = new THREE.PerspectiveCamera(50, tw / H, 0.05, 200);
      const c = a.slot.position;
      cam.position.set(c.x, 1.3, dist);
      cam.lookAt(c.x, 1.05, 0);
      const name = UNUSUAL_EFFECTS.find((u) => u.id === this.kinds[i])?.name ?? this.kinds[i];
      return { x: i * tw, y: 0, w: tw, h: H, cam, label: `${name} · taunt aura` };
    });
  }

  resize() {
    const { w, h } = this.cssSize();
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);
    if (this.mode === 'finishers') this.layoutFinishers();
    else if (this.mode === 'taunts') this.layoutTaunts();
    else if (this.mode === 'eyes') this.layoutEyes();
    else this.layoutUnusuals();
    this.onLabels?.(this.tiles.map(({ x, y, w: tw, h: th, label }) => ({ x, y, w: tw, h: th, label })));
  }

  start() {
    const tick = (ms: number) => {
      if (this.disposed) return;
      const now = ms / 1000;
      const dt = this.last ? Math.min(0.05, now - this.last) : 0;
      this.last = now;
      if (this.frozenAt === null) this.advance(dt);
      this.composer.render();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private advance(dt: number) {
    const prev = this.clock;
    this.clock += dt;
    if (this.mode === 'finishers') {
      const p0 = prev % PERIOD;
      const p1 = this.clock % PERIOD;
      const wrapped = p1 < p0;
      for (const a of this.actors) {
        if ((p0 < DIE_AT && p1 >= DIE_AT) || (wrapped && p1 >= DIE_AT)) this.kill(a);
        if ((p0 < RESPAWN_AT && p1 >= RESPAWN_AT) || (wrapped && p0 < RESPAWN_AT)) {
          a.anim.respawn();
        }
        a.anim.updateStatic(dt);
      }
    } else if (this.mode === 'eyes') {
      for (const a of this.actors) a.anim.updateStatic(dt);
      for (const e of this.eyes) e.update(dt);
    } else if (this.mode === 'taunts') {
      // Replay each aura every 3.6 s (start(3): fades in, runs, fades out).
      const p0 = prev % 3.6, p1 = this.clock % 3.6;
      for (const au of this.auras) {
        if (p1 < p0 || prev === 0) au.start(3);
        au.update(dt);
      }
      for (const a of this.actors) a.anim.updateStatic(dt);
    } else {
      for (const a of this.actors) {
        if (a.moving) {
          // Strafe back and forth (±1.6 m, ~7 m/s peak) to show trails.
          a.slot.position.x = a.base.x + Math.sin(this.clock * 2.2) * 1.6;
          // Track the wearer so the trail reads (the camera slides, never turns).
          const tile = this.tiles[this.actors.indexOf(a)];
          if (tile?.camX !== undefined) {
            tile.cam.position.x = tile.camX + (a.slot.position.x - a.base.x);
            tile.cam.updateMatrixWorld();
          }
        }
        a.anim.updateStatic(dt);
        a.hat?.update(dt);
        a.fx?.update(dt);
      }
    }
    this.effects.step(dt, this.scene);
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    for (const au of this.auras) au.dispose();
    for (const e of this.eyes) e.dispose();
    for (const a of this.actors) {
      a.fx?.dispose();
      a.hat?.dispose();
      a.anim.dispose();
      a.ch.dispose();
    }
    this.effects.dispose(this.scene);
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
