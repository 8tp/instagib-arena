// Live 3D menu backdrop: a slow cinematic orbit through a real arena, cycling
// maps with a crossfade. Also renders "levelshots" (one still frame per map)
// for the Q3-style loading screen.
//
// Everything visual comes from the game's own builders — createRenderer /
// createScene / PostFxPipeline (src/game/renderer.ts) and buildMapMesh /
// applyMapShadowFlags (src/game/map.ts) — imported, never modified, so any
// per-map theme, lighting or sky those builders gain shows up here for free.
//
// Budget: capped at 30 fps, rendered at a reduced resolution scale, paused
// while the tab is hidden or something covers it (setActive(false)), and a
// single still frame (no loop at all) under lowSpec / reducedEffects. The
// camera is a pure function of the shot clock, so motion is frame-rate
// independent by construction.

import * as THREE from 'three';
import { applyMapShadowFlags, createRenderer, createScene, PostFxPipeline } from '../game/renderer';
import { buildMapMesh, mapById, MAPS, rayAabb, type ArenaMap } from '../game/map';
import type { AABB, Vec3 } from '../game/types';
import { MenuHero, type HeroFrame, type HeroLoadout } from './menu-hero';

// The rotation (the practice range is the one bright, empty room — skip it).
export const BACKDROP_MAPS: readonly string[] = ['reactor', 'causeway', 'lounge', 'nuketown', 'containeryard', 'derrick'];

// The menu runs a calmer bloom than a match: the backdrop is mostly neon trims
// and glossy floors, and at full strength they glared behind the menu.
const MENU_BLOOM = 0.5;
const MENU_BLOOM_THRESHOLD = 2.4; // only real emissives bloom, not specular glints
const SHOT_SECONDS = 24; // one orbit segment per map before the crossfade
const CROSSFADE_MS = 1400;
const FOV = 58; // cinematic, not the 90° gameplay FOV

export type BackdropOptions = {
  maps?: readonly string[];
  // One still frame and no loop (lowSpec / reducedEffects / landing on a phone).
  still?: boolean;
  lowSpec?: boolean;
  fps?: number; // loop cap (default 30)
  scale?: number; // render-resolution multiplier on top of a 1.25 DPR cap
  startMap?: string;
  shift?: number; // lens shift toward the right (fraction of half-width), default 0.26
  onMap?: (id: string, name: string) => void;
  // Your combatant in the foreground (see menu-hero.ts); null = arena only.
  hero?: HeroLoadout | null;
};

/* ── Shot planning ──────────────────────────────────────────────────────── */

type Shot = {
  cx: number;
  cz: number;
  rx: number; // orbit radii
  rz: number;
  y: number;
  a0: number; // start angle
  span: number; // signed sweep over the shot (radians)
  target: Vec3;
};

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inside(p: Vec3, b: AABB, pad: number): boolean {
  return (
    p.x > b.min.x - pad && p.x < b.max.x + pad &&
    p.y > b.min.y - pad && p.y < b.max.y + pad &&
    p.z > b.min.z - pad && p.z < b.max.z + pad
  );
}

// Distance along `d` (normalized) to the first solid, capped at `max`.
function freeDistance(o: Vec3, d: Vec3, solids: AABB[], max: number): number {
  let best = max;
  for (const b of solids) {
    const t = rayAabb(o, d, b);
    if (t !== null && t < best) best = t;
  }
  return best;
}

function orbitPoint(s: Shot, a: number, out: Vec3): Vec3 {
  out.x = s.cx + Math.cos(a) * s.rx;
  out.z = s.cz + Math.sin(a) * s.rz;
  out.y = s.y;
  return out;
}

function ceilingOf(map: ArenaMap): number {
  return map.boxes[1]?.min.y ?? map.bounds.max.y;
}

// Score a candidate orbit: every sample along the arc must sit in open air and
// see the target through a clear cone (nothing parked in front of the lens).
// Returns -1 for an unusable shot.
function scoreShot(map: ArenaMap, s: Shot, solids: AABB[]): number {
  const b = map.bounds;
  const ceil = ceilingOf(map);
  const p = { x: 0, y: 0, z: 0 };
  const d = { x: 0, y: 0, z: 0 };
  let score = 0;
  const N = 9;
  for (let i = 0; i < N; i++) {
    orbitPoint(s, s.a0 + (s.span * i) / (N - 1), p);
    if (p.x < b.min.x + 1.5 || p.x > b.max.x - 1.5 || p.z < b.min.z + 1.5 || p.z > b.max.z - 1.5) return -1;
    if (p.y > ceil - 1.2) return -1;
    for (const box of solids) {
      if (inside(p, box, 0.9)) return -1;
      // A platform edge at lens height slices the frame into a flat line.
      const hx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
      const hz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
      if (Math.hypot(hx, hz) < 14 && (Math.abs(p.y - box.max.y) < 1.1 || Math.abs(p.y - box.min.y) < 1.1)) return -1;
    }
    const dx = s.target.x - p.x;
    const dy = s.target.y - p.y;
    const dz = s.target.z - p.z;
    const dist = Math.hypot(dx, dy, dz);
    // Five rays: centre + a small cone (±9° yaw, ±5° pitch).
    const yaw = Math.atan2(dz, dx);
    const pitch = Math.asin(dy / dist);
    let open = 0;
    for (const [oy, op] of [[0, 0], [0.16, 0], [-0.16, 0], [0, 0.09], [0, -0.09]] as const) {
      const cy = Math.cos(pitch + op);
      d.x = Math.cos(yaw + oy) * cy;
      d.z = Math.sin(yaw + oy) * cy;
      d.y = Math.sin(pitch + op);
      const free = freeDistance(p, d, solids, dist);
      if (oy === 0 && op === 0 && free < Math.min(7, dist * 0.45)) return -1; // wall in the lens
      open += free / dist;
    }
    score += open / 5;
    // Frame clutter: every third sample, sweep a grid across the frame
    // (±34° yaw, ±16° pitch). Nothing may sit right against the lens, and
    // near geometry anywhere in frame costs score — a slab sliced at eye level
    // across the wordmark is the look to avoid.
    if (i % 4 === 0) {
      let near = 0;
      for (const oy of [-0.6, -0.3, 0, 0.3, 0.6]) {
        for (const op of [-0.28, 0, 0.28]) {
          const cy = Math.cos(pitch + op);
          d.x = Math.cos(yaw + oy) * cy;
          d.z = Math.sin(yaw + oy) * cy;
          d.y = Math.sin(pitch + op);
          const free = freeDistance(p, d, solids, 12);
          if (free < 3.2) return -1;
          if (free < 8) near++;
        }
      }
      score -= near * 0.04;
    }
  }
  return score / N;
}

function planShot(map: ArenaMap, rand: () => number, best = false): Shot | null {
  const b = map.bounds;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const hx = (b.max.x - b.min.x) / 2;
  const hz = (b.max.z - b.min.z) / 2;
  const ceil = ceilingOf(map);
  const solids = map.boxes.slice(2);
  // Aim at the floor near the centre; lift it over any centrepiece.
  let ty = 0.6;
  for (const box of solids) {
    if (cx > box.min.x && cx < box.max.x && cz > box.min.z && cz < box.max.z) ty = Math.max(ty, box.max.y + 0.6);
  }
  ty = Math.min(ty, ceil * 0.45);
  const target = { x: cx, y: ty, z: cz };

  // An elevated "intermission camera": sit above most of the cover/platform
  // tops (perimeter walls excluded) so the arena reads as a layout instead of
  // a slab sliced at eye level.
  const edge = 0.6;
  const interior = solids.filter(
    (s) =>
      s.min.x > b.min.x + edge &&
      s.max.x < b.max.x - edge &&
      s.min.z > b.min.z + edge &&
      s.max.z < b.max.z - edge,
  );
  const tops = interior.map((s) => s.max.y).sort((p, q) => p - q);
  const coverTop = tops.length ? tops[Math.min(tops.length - 1, Math.floor(tops.length * 0.8))] : 2;
  const baseH = Math.min(ceil - 2.5, Math.max(3.6, coverTop + 2.4));
  const candidates: { s: Shot; score: number }[] = [];
  const heights = [baseH, baseH + 1.8, baseH - 1.3, baseH + 3.6].map((h) => Math.min(ceil - 1.6, Math.max(3.2, h)));
  for (const rf of [0.62, 0.5, 0.74, 0.4]) {
    for (const y of heights) {
      for (let k = 0; k < 16; k++) {
        const a0 = (k / 16) * Math.PI * 2;
        for (const dir of [1, -1]) {
          const s: Shot = { cx, cz, rx: hx * rf, rz: hz * rf, y, a0, span: dir * 0.62, target };
          const score = scoreShot(map, s, solids);
          if (score > 0) candidates.push({ s, score: score + (y === heights[0] ? 0.04 : 0) });
        }
      }
    }
    if (candidates.length >= 6) break;
  }
  if (candidates.length === 0) return null; // no clean shot: the rotation skips it
  candidates.sort((a, b2) => b2.score - a.score);
  if (best) return candidates[0].s;
  const top = candidates.slice(0, Math.min(4, candidates.length));
  return top[Math.floor(rand() * top.length)].s;
}

// Camera pose at shot time t (seconds). Eased so each segment starts and ends
// slow; a gentle vertical breath and a drifting look target keep it alive.
function poseAt(s: Shot, t: number, cam: THREE.PerspectiveCamera, look: THREE.Vector3) {
  const u = Math.min(1, Math.max(0, t / SHOT_SECONDS));
  const e = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // mostly linear, soft ends
  const a = s.a0 + s.span * e;
  cam.position.set(s.cx + Math.cos(a) * s.rx, s.y + Math.sin(t * 0.21) * 0.22, s.cz + Math.sin(a) * s.rz);
  look.set(
    s.target.x + Math.sin(t * 0.09) * 1.6,
    s.target.y + Math.sin(t * 0.13) * 0.25,
    s.target.z + Math.cos(t * 0.07) * 1.6,
  );
  cam.lookAt(look);
}

/* ── Stage: one renderer + scene + post chain + the current arena ──────── */

function disposeObject(root: THREE.Object3D) {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (obj.userData.shared) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.Line).isLine && !(obj as THREE.Sprite).isSprite) return;
    if (mesh.geometry) geoms.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => mats.add(m));
    else if (mat) mats.add(mat);
  });
  geoms.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
}

class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly postFx: PostFxPipeline;
  map: ArenaMap | null = null;
  mapId = '';
  // Second pass drawn into the same frame right after the arena (before
  // bloom/vignette): the menu hero. Off while a levelshot is captured.
  overlay: ((renderer: THREE.WebGLRenderer) => void) | null = null;
  overlayEnabled = true;
  private mapMesh: THREE.Group | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: { shadows: boolean; bloom: boolean },
  ) {
    this.renderer = createRenderer(canvas);
    this.scene = createScene(this.renderer);
    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 1000);
    this.postFx = new PostFxPipeline(this.renderer, this.scene, this.camera);
    this.postFx.setShadowMapSize(1024);
    this.postFx.setOptions({ bloom: opts.bloom, shadows: opts.shadows, aa: false, vignette: true });
    // The arena's RenderPass renders this scene into the composer's HDR
    // buffer; hooking its onAfterRender puts the overlay in that same buffer.
    this.scene.onAfterRender = (renderer) => {
      if (this.overlayEnabled) this.overlay?.(renderer);
    };
  }

  // `shift` is a horizontal lens shift as a fraction of the half-width: the
  // subject lands right of centre, clear of the menu column on the left.
  setSize(w: number, h: number, pixelRatio: number, shift = 0) {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.postFx.setPixelRatio(pixelRatio);
    this.postFx.setSize(w, h);
    const cam = this.camera;
    cam.aspect = w / Math.max(1, h);
    const s = cam.aspect >= 1.3 ? shift : 0;
    cam.filmOffset = -s * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect * cam.getFilmWidth();
    cam.updateProjectionMatrix();
  }

  loadMap(id: string) {
    if (id === this.mapId && this.mapMesh) return;
    if (this.mapMesh) {
      this.scene.remove(this.mapMesh);
      disposeObject(this.mapMesh);
      this.mapMesh = null;
    }
    const map = mapById(id);
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.scene.add(mesh);
    this.mapMesh = mesh;
    this.map = map;
    this.mapId = id;
  }

  render() {
    this.postFx.render();
  }

  dispose() {
    if (this.mapMesh) {
      this.scene.remove(this.mapMesh);
      disposeObject(this.mapMesh);
      this.mapMesh = null;
    }
    // The PMREM environment isn't a scene child — free it explicitly.
    (this.scene.environment as THREE.Texture | null)?.dispose();
    this.scene.environment = null;
    disposeObject(this.scene);
    this.postFx.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/* ── Levelshots ─────────────────────────────────────────────────────────── */

const levelshots = new Map<string, string>();
// The arena the last backdrop showed, so landing → menu (a remount) carries on
// in the same place instead of cutting to a random map.
let lastMapId: string | null = null;
const pendingShots = new Map<string, Promise<string | null>>();

export function cachedLevelshot(mapId: string): string | null {
  return levelshots.get(mapId) ?? null;
}

// Last resort when no orbit is clean: the spawn, raised, looking across.
function spawnShot(map: ArenaMap): Shot {
  const b = map.bounds;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const sp = map.spawn;
  const r = Math.max(0.5, Math.hypot(sp.x - cx, sp.z - cz));
  return {
    cx,
    cz,
    rx: r,
    rz: r,
    y: sp.y + 2.6,
    a0: Math.atan2(sp.z - cz, sp.x - cx),
    span: 0.001,
    target: { x: cx, y: 1, z: cz },
  };
}

function captureLevelshot(stage: Stage): string | null {
  if (!stage.map) return null;
  const shot = planShot(stage.map, () => 0, true) ?? spawnShot(stage.map);
  const look = new THREE.Vector3();
  const cam = stage.camera;
  const film = cam.filmOffset;
  cam.filmOffset = 0; // levelshots are centred
  cam.updateProjectionMatrix();
  poseAt(shot, SHOT_SECONDS * 0.3, cam, look);
  stage.overlayEnabled = false; // the arena only — no menu hero in a levelshot
  stage.render();
  stage.overlayEnabled = true;
  let url: string | null = null;
  try {
    // Read back in the same task as the render (no preserveDrawingBuffer).
    url = stage.canvas.toDataURL('image/jpeg', 0.84);
  } catch {
    url = null;
  }
  cam.filmOffset = film;
  cam.updateProjectionMatrix();
  return url;
}

// Render one still of `mapId` for the loading screen. Cached per map; the
// menu backdrop pre-fills the cache for every map it visits, so this usually
// resolves instantly. On a miss it spins up a short-lived offscreen renderer,
// renders one frame, reads it back and frees the context.
export function renderLevelshot(mapId: string, opts: { lowSpec?: boolean } = {}): Promise<string | null> {
  const hit = levelshots.get(mapId);
  if (hit) return Promise.resolve(hit);
  const pending = pendingShots.get(mapId);
  if (pending) return pending;
  const job = new Promise<string | null>((resolve) => {
    // Let the loading screen paint before we block on shader compilation.
    window.setTimeout(() => {
      let stage: Stage | null = null;
      try {
        const canvas = document.createElement('canvas');
        const w = opts.lowSpec ? 800 : 1280;
        const h = Math.round((w * 9) / 16);
        canvas.width = w;
        canvas.height = h;
        stage = new Stage(canvas, { shadows: !opts.lowSpec, bloom: true });
        stage.setSize(w, h, 1);
        stage.loadMap(mapId);
        const url = captureLevelshot(stage);
        if (url) levelshots.set(mapId, url);
        resolve(url);
      } catch {
        resolve(null);
      } finally {
        stage?.dispose();
        pendingShots.delete(mapId);
      }
    }, 60);
  });
  pendingShots.set(mapId, job);
  return job;
}

/* ── Menu backdrop ─────────────────────────────────────────────────────── */

export class MenuBackdrop {
  private stage: Stage;
  private readonly maps: readonly string[];
  private readonly still: boolean;
  private readonly frameMs: number;
  private readonly scale: number;
  private readonly onMap?: (id: string, name: string) => void;
  private readonly shift: number;
  private shot: Shot | null = null;
  private shotT = 0;
  private mapIndex = 0;
  private active = true;
  private hidden = typeof document !== 'undefined' ? document.hidden : false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private disposed = false;
  private fadeTimer = 0;
  private readonly look = new THREE.Vector3();
  private hero: MenuHero | null = null;
  private heroLoadout: HeroLoadout | null = null;
  private heroFrame: HeroFrame | null = null;
  private heroHover = false;
  private readonly rand = mulberry((Date.now() & 0xffff) ^ 0x9e37);
  private readonly resizeObs: ResizeObserver | null = null;
  private readonly onVisibility = () => {
    this.hidden = document.hidden;
    this.syncLoop();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fadeCanvas: HTMLCanvasElement | null,
    opts: BackdropOptions = {},
  ) {
    const pool = (opts.maps ?? BACKDROP_MAPS).filter((id) => MAPS.some((m) => m.id === id));
    // Only arenas with a clean orbit make the rotation (cramped duel maps can
    // fail it; they still get a spawn-view levelshot for the loading screen).
    const clean = pool.filter((id) => planShot(mapById(id), () => 0, true) !== null);
    this.maps = clean.length ? clean : pool.length ? pool : ['reactor'];
    this.still = !!opts.still;
    this.frameMs = 1000 / Math.max(10, opts.fps ?? 30);
    this.scale = opts.scale ?? (opts.lowSpec ? 0.55 : 0.75);
    this.onMap = opts.onMap;
    this.shift = opts.shift ?? 0.26;
    this.stage = new Stage(canvas, { shadows: !opts.lowSpec, bloom: true });
    this.stage.postFx.setBloomScale(MENU_BLOOM);
    this.stage.postFx.setBloomThreshold(MENU_BLOOM_THRESHOLD);
    const want = opts.startMap ?? lastMapId;
    const start = want ? this.maps.indexOf(want) : -1;
    this.mapIndex = start >= 0 ? start : Math.floor(this.rand() * this.maps.length);
    this.stage.overlay = (renderer) => this.hero?.render(renderer);
    this.heroLoadout = opts.hero ?? null;
    this.resize();
    this.enterMap(this.maps[this.mapIndex]);
    // Start part-way into the shot so the first frame is already mid-move.
    this.shotT = this.still ? SHOT_SECONDS * 0.35 : SHOT_SECONDS * 0.08;
    this.renderFrame();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => {
        this.resize();
        if (this.still || !this.running) this.renderFrame();
      });
      this.resizeObs.observe(canvas);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.syncLoop();
  }

  // Pause while something covers the backdrop (a modal, a match) and resume
  // after. The last frame stays on the canvas while paused.
  setActive(active: boolean) {
    this.active = active;
    this.syncLoop();
  }

  // The player's Bloom intensity setting (0..1.5), on top of the menu's own
  // calmer baseline — the backdrop's neon trims + reflections were glaring.
  setBloomScale(k: number) {
    this.stage.postFx.setBloomScale(MENU_BLOOM * k);
    this.redrawIfIdle();
  }

  get currentMap(): string {
    return this.stage.mapId;
  }

  /* ── Hero (your combatant, composited over the arena) ──────────────── */

  // Loadout to wear; null removes the hero. Built lazily once there is also a
  // frame to stand in, so a narrow layout never pays for it.
  setHero(loadout: HeroLoadout | null) {
    this.heroLoadout = loadout;
    if (!loadout) {
      this.dropHero();
    } else if (this.hero) {
      this.hero.setLoadout(loadout);
    } else {
      this.ensureHero();
    }
    this.redrawIfIdle();
  }

  // Where the hero stands (canvas CSS px); null or tiny = hidden.
  setHeroFrame(frame: HeroFrame | null) {
    this.heroFrame = frame;
    this.ensureHero();
    this.hero?.setFrame(frame);
    this.redrawIfIdle();
  }

  setHeroHover(on: boolean) {
    this.heroHover = on;
    this.hero?.setHover(on);
    this.redrawIfIdle();
  }

  heroEmote() {
    this.hero?.emoteNow();
  }

  private ensureHero() {
    if (this.hero || this.disposed || !this.heroLoadout) return;
    const f = this.heroFrame;
    if (!f || f.w < 2 || f.h < 2) return;
    const env = (this.stage.scene.environment as THREE.Texture | null) ?? null;
    const hero = new MenuHero(this.heroLoadout, env, { still: this.still });
    hero.onDirty = () => this.redrawIfIdle();
    hero.setFrame(f);
    hero.setHover(this.heroHover);
    this.hero = hero;
  }

  private dropHero() {
    this.hero?.dispose();
    this.hero = null;
  }

  // A paused or still backdrop redraws one frame so hero changes show.
  private redrawIfIdle() {
    if (this.disposed || this.running) return;
    this.hero?.update(0);
    this.renderFrame();
  }

  // Dev probe (critique harness): mean ms per backdrop frame over n renders.
  benchmark(n = 30): number {
    const gl = this.stage.renderer.getContext();
    const t0 = performance.now();
    const px = new Uint8Array(4);
    for (let i = 0; i < n; i++) {
      this.renderFrame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // force GPU sync per frame
    }
    return (performance.now() - t0) / n;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.fadeTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObs?.disconnect();
    this.stage.overlay = null;
    this.dropHero();
    this.stage.dispose();
  }

  private get running(): boolean {
    return this.raf !== 0;
  }

  private syncLoop() {
    const want = !this.disposed && !this.still && this.active && !this.hidden;
    if (want && !this.running) {
      this.last = performance.now();
      this.acc = this.frameMs; // draw on the first tick
      this.raf = requestAnimationFrame(this.tick);
    } else if (!want && this.running) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt * 1000;
    if (this.acc < this.frameMs - 1) return;
    // Advance by the real elapsed time, not a fixed step: frame-rate independent.
    const step = Math.min(0.25, this.acc / 1000);
    this.acc = 0;
    this.shotT += step;
    if (this.shotT >= SHOT_SECONDS) this.nextMap();
    this.hero?.update(step);
    this.renderFrame();
  };

  private resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 1.25) * this.scale;
    this.stage.setSize(w, h, pr, this.shift);
  }

  private enterMap(id: string) {
    this.stage.loadMap(id);
    lastMapId = id;
    const map = this.stage.map;
    if (!map) return;
    this.shot = planShot(map, this.rand) ?? spawnShot(map);
    this.shotT = 0;
    // Pre-fill the loading screen's levelshot for this map while we're here
    // (landscape canvases only — a portrait phone frame would crop badly).
    if (!levelshots.has(id) && this.stage.camera.aspect >= 1.3) {
      const url = captureLevelshot(this.stage);
      if (url) levelshots.set(id, url);
    }
    this.onMap?.(id, map.name);
  }

  // Crossfade: freeze the outgoing frame on the 2D overlay, swap the arena
  // underneath, then fade the overlay away.
  private nextMap() {
    const fade = this.fadeCanvas;
    if (fade) {
      const ctx = fade.getContext('2d');
      if (ctx) {
        this.renderFrame(); // outgoing frame, read back in this same task
        fade.width = this.canvas.width;
        fade.height = this.canvas.height;
        ctx.drawImage(this.canvas, 0, 0);
        fade.style.transition = 'none';
        fade.style.opacity = '1';
      }
    }
    this.mapIndex = (this.mapIndex + 1) % this.maps.length;
    this.enterMap(this.maps[this.mapIndex]);
    if (fade) {
      window.clearTimeout(this.fadeTimer);
      // Two frames later so the new arena has drawn before the reveal starts.
      this.fadeTimer = window.setTimeout(() => {
        fade.style.transition = `opacity ${CROSSFADE_MS}ms ease-in-out`;
        fade.style.opacity = '0';
      }, 70);
    }
  }

  private renderFrame() {
    if (!this.shot) return;
    poseAt(this.shot, this.shotT, this.stage.camera, this.look);
    this.stage.render();
  }
}
