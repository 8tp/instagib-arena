import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CharacterAnimator } from './character-anim';
import { Character } from './character/character';
import { attachRailgun, disposeRailgun } from './character/gun';
import { EffectsManager } from './effects';
import { emoteClip } from './emotes';
import { disposeFxContext, getFxContext, peekFxContext } from './fx-pool';
import { WornHat } from './hats';
import { buildRailgun } from './weapon-model';
import {
  cosmeticById,
  emoteById,
  railColorById,
  railgunFinishById,
  spawnEffectById,
  unusualById,
  type CatalogEntry,
  type EmoteKind,
  type KillEffectStyle,
} from './cosmetics';

// ─────────────────────────────────────────────────────────────────────────
// Cosmetic item thumbnails — a rendered still of each item (a hat on a head,
// a gun finish, a finisher mid-burst…) for the Locker grid, the end-of-match
// reward cards and the Career Road, cached as data URLs.
//
//  • ONE shared offscreen WebGLRenderer, created lazily on the first request
//    and released (context and all) after ~30 s without work.
//  • Requests queue; at most ONE thumbnail renders per animation frame (async
//    prep — a hat glTF load, a shader compile — happens between frames), so
//    opening the Locker never hitches.
//  • Cache: an in-memory Map + de-duplicated pending promises, mirrored to
//    sessionStorage so a reload within the tab doesn't re-render.
//  • Slots with no 3D subject (name colours, titles, cards, announcers) return
//    null: ItemTile draws a CSS treatment for those.
// Transparent background — the tile's rarity gradient shows through.
// ─────────────────────────────────────────────────────────────────────────

const SIZE = 256;
const IDLE_RELEASE_MS = 30_000;
const STORE_PREFIX = 'ig-thumb:v10:';
// A neutral armour so every thumbnail reads on all four rarity backgrounds.
const THUMB_SKIN = '#c3ccda';
// Hats sit on a mid-slate helmet: white caps read lighter, black hats darker.
const HAT_SKIN = '#6f7888';
const FACE_CAMERA = Math.PI;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
type Job = { id: string; resolve: (url: string | null) => void };
const queue: Job[] = [];
let running = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function storeGet(id: string): string | null {
  try {
    return sessionStorage.getItem(STORE_PREFIX + id);
  } catch {
    return null;
  }
}
function storeSet(id: string, url: string) {
  try {
    sessionStorage.setItem(STORE_PREFIX + id, url);
  } catch {
    /* quota / privacy mode — memory cache still works */
  }
}

// Which catalog items get a rendered thumbnail.
function renderable(c: CatalogEntry | undefined): boolean {
  if (!c) return false;
  switch (c.slot) {
    case 'hat':
    case 'unusual':
    case 'railgunFinish':
    case 'railColor':
    case 'killEffect':
    case 'spawnEffect':
    case 'emote':
      return true;
    default:
      return false;
  }
}

// Synchronous cache peek (null until getThumbnail has resolved once).
export function peekThumbnail(id: string): string | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const stored = storeGet(id);
  if (stored) {
    cache.set(id, stored);
    return stored;
  }
  return null;
}

// Rendered thumbnail for a cosmetic id, or null when it has no 3D subject (or
// rendering failed / WebGL is unavailable).
export function getThumbnail(id: string): Promise<string | null> {
  const hit = cache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const stored = storeGet(id);
  if (stored) {
    cache.set(id, stored);
    return Promise.resolve(stored);
  }
  if (typeof document === 'undefined' || !renderable(cosmeticById(id))) {
    cache.set(id, null);
    return Promise.resolve(null);
  }
  let p = pending.get(id);
  if (!p) {
    p = new Promise<string | null>((resolve) => queue.push({ id, resolve }));
    pending.set(id, p);
    void pump();
  }
  return p;
}

// Warm a batch (e.g. a Locker slot's grid). `front`: these jump the queue
// (the grid the player is looking at renders first), keeping their order.
export function prefetchThumbnails(ids: readonly string[], front = false): void {
  for (const id of ids) void getThumbnail(id);
  if (!front) return;
  const want = new Set(ids);
  const first = queue.filter((j) => want.has(j.id));
  const rest = queue.filter((j) => !want.has(j.id));
  queue.length = 0;
  queue.push(...first, ...rest);
}

// True while a thumbnail is queued or rendering (tiles show a quiet
// placeholder instead of the no-thumbnail fallback).
export function thumbnailPending(id: string): boolean {
  if (pending.has(id)) return true;
  // Not asked for yet but it will be (a tile's first paint): also pending.
  return !cache.has(id) && !studioFailed && typeof document !== 'undefined' && renderable(cosmeticById(id));
}

const nextFrame = () =>
  new Promise<void>((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
    else setTimeout(r, 16);
  });

async function pump() {
  if (running) return;
  running = true;
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  while (queue.length) {
    const job = queue.shift()!;
    let url: string | null = null;
    try {
      url = await renderThumb(job.id);
    } catch (err) {
      console.warn(`[thumbs] ${job.id} failed to render`, err);
      url = null;
    }
    cache.set(job.id, url);
    if (url) storeSet(job.id, url);
    pending.delete(job.id);
    job.resolve(url);
  }
  running = false;
  releaseTimer = setTimeout(release, IDLE_RELEASE_MS);
}

// ── The shared studio ────────────────────────────────────────────────────────

type Studio = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  env: THREE.Texture;
  effects: EffectsManager;
  webp: boolean;
  out: HTMLCanvasElement; // 2D canvas the fixed-up pixels are encoded from
  px: Uint8Array;
  mask: Uint8Array;
};
let studio: Studio | null = null;
let studioFailed = false;

function getStudio(): Studio | null {
  if (studio) return studio;
  if (studioFailed) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xdbe8f5, 0x1c1c24, 1.15));
    const key = new THREE.DirectionalLight(0xfff2d8, 2.1);
    key.position.set(2.5, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9bb6ff, 1.5);
    rim.position.set(-3, 4, -4);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.55);
    fill.position.set(0, 1, 6);
    scene.add(fill);
    const effects = new EffectsManager();
    effects.warm(scene);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    // Does this browser encode WebP (smaller data URLs, keeps alpha)?
    let webp = false;
    try {
      const probe = document.createElement('canvas');
      probe.width = probe.height = 1;
      webp = probe.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webp = false;
    }
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    const n = SIZE * SIZE * 4;
    studio = { renderer, scene, camera, env, effects, webp, out, px: new Uint8Array(n), mask: new Uint8Array(n) };
    return studio;
  } catch {
    studioFailed = true;
    return null;
  }
}

// Free the renderer after an idle spell (a later request rebuilds it).
function release() {
  releaseTimer = null;
  if (running || !studio) return;
  const s = studio;
  studio = null;
  if (peekFxContext(s.scene)) disposeFxContext(s.scene);
  s.env.dispose();
  backdropTex?.dispose();
  backdropTex = null;
  s.renderer.dispose();
  s.renderer.forceContextLoss();
}

// ── Subjects ─────────────────────────────────────────────────────────────────

type Subject = {
  root: THREE.Object3D;
  // Camera: look at `target` from `dist` along a direction tilted `elev`
  // radians above the horizon (and `azim` radians around Y).
  target: THREE.Vector3;
  dist: number;
  elev?: number;
  azim?: number;
  fov?: number;
  // Advance any simulation before the shot (called once, after the subject
  // is in the scene).
  settle?: () => void;
  dispose: () => void;
};

// A neutral combatant, facing the camera (optionally turned `turn` radians),
// posed at `t` seconds into `clip` (the breathing idle by default).
function combatant(turn = 0, clip: EmoteKind = 'idle', t = 0.6, skin = THUMB_SKIN) {
  const holder = new THREE.Group();
  const ch = new Character({ colorHex: skin, castShadow: false });
  holder.add(ch.root);
  holder.rotation.y = FACE_CAMERA + turn;
  const anim = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
  anim.playEmote(clip); // fresh animator → the clip starts at once (no blend)
  anim.setEmoteTime(t, 1);
  anim.updateStatic(0);
  return { holder, ch, anim };
}

// Camera-facing dark radial disc (thumbnail backdrop for glow effects). The
// texture is cached for the studio's life.
let backdropTex: THREE.CanvasTexture | null = null;
function darkBackdrop(size = 1.25): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  if (!backdropTex) {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(6,8,14,0.92)');
    g.addColorStop(0.55, 'rgba(6,8,14,0.7)');
    g.addColorStop(1, 'rgba(6,8,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    backdropTex = new THREE.CanvasTexture(cv);
    backdropTex.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: backdropTex, transparent: true, depthWrite: false, toneMapped: false }),
  );
}

function disposeCombatant(c: { ch: Character; anim: CharacterAnimator }) {
  c.anim.dispose();
  c.ch.dispose();
}

// Characteristic frame (fraction of the clip) per emote.
const EMOTE_FRAME: Partial<Record<EmoteKind, number>> = {
  cheer: 0.3,
  wave: 0.42,
  flex: 0.45,
  spin: 0.22,
  dance: 0.3,
  salute: 0.42,
  beckon: 0.5,
  slowclap: 0.33,
  flourish: 0.72,
};
// Each finisher's signature moment (seconds after the kill): the frame that
// tells it apart — Nova's sphere, Singularity's pop, Derez's bands, Vaporize's
// ash. Re-tune with the FX lab (/fxlab?t=…) when a finisher changes.
const FINISHER_FRAME: Partial<Record<KillEffectStyle, number>> = {
  pulse: 0.12,
  nova: 0.14,
  starburst: 0.1,
  voxel: 0.22,
  ember: 0.3,
  gibstorm: 0.16,
  singularity: 0.36,
  prism: 0.14,
  derez: 0.3,
  shatter: 0.1,
  confetti: 0.2,
  overload: 0.32,
  vaporize: 0.42,
};
// Victim skin per tile rarity — a complement of the tile colour, so the burst
// (which takes the victim's colour) reads on its backdrop.
const FINISHER_SKIN: Record<string, string> = {
  common: '#27b8ff',
  rare: '#ffb21e',
  epic: '#1fd6a0',
  legendary: '#27b8ff',
};

function stepEffects(s: Studio, seconds: number, extra?: (dt: number) => void) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds - 1e-6; t += dt) {
    extra?.(dt);
    s.effects.step(dt, s.scene);
  }
}

async function buildSubject(s: Studio, entry: CatalogEntry): Promise<Subject | null> {
  switch (entry.slot) {
    case 'hat': {
      const c = combatant(-0.42, 'idle', 0.6, HAT_SKIN);
      const hat = new WornHat(c.ch.sockets.headTop);
      await hat.setHat(entry.id);
      // Frame on the hat itself so it fills ~60% of the tile (cropped just
      // above the visor), rather than a bust with a small hat on top.
      c.holder.updateMatrixWorld(true);
      const box = new THREE.Box3();
      for (const child of c.ch.sockets.headTop.children) box.expandByObject(child);
      let target = new THREE.Vector3(0, 1.74, 0);
      let win = 0.5; // bare helmet
      if (!box.isEmpty() && box.max.y - box.min.y > 0.02) {
        const size = box.getSize(new THREE.Vector3());
        win = Math.max(size.y, size.x, size.z) / 0.6;
        const centre = box.getCenter(new THREE.Vector3());
        target = new THREE.Vector3(centre.x, centre.y - win * 0.06, centre.z);
      }
      return {
        root: c.holder,
        target,
        dist: win / 2 / Math.tan((15 * Math.PI) / 180),
        elev: 0.34, // from a little above: brims and crowns read
        dispose: () => {
          hat.dispose();
          disposeCombatant(c);
        },
      };
    }
    case 'unusual': {
      const c = combatant(0);
      const hat = new WornHat(c.ch.sockets.headTop);
      hat.setUnusual(entry.id);
      const none = unusualById(entry.id).kind === 'none';
      // The head is a dark silhouette so it never competes with the effect;
      // a soft dark halo behind keeps warm effects readable on the gold tile.
      const body = c.ch.mesh.material;
      const shadow = new THREE.MeshStandardMaterial({ color: 0x07090d, roughness: 0.9, metalness: 0, envMapIntensity: 0.12 });
      if (!none) c.ch.mesh.material = shadow;
      const backdrop = darkBackdrop(1.5);
      backdrop.position.set(0, 2.0, -0.5);
      backdrop.visible = !none;
      const root = new THREE.Group();
      root.add(c.holder, backdrop);
      return {
        root,
        target: new THREE.Vector3(0, none ? 1.74 : 1.98, 0),
        dist: none ? 1.9 : 1.45,
        elev: 0.1,
        settle: () => {
          // Unusuals only simulate while seeded — step ~1 s in.
          for (let i = 0; i < 60; i++) hat.update(1 / 60);
        },
        dispose: () => {
          hat.dispose();
          c.ch.mesh.material = body;
          shadow.dispose();
          disposeCombatant(c);
          backdrop.geometry.dispose();
          backdrop.material.dispose();
        },
      };
    }
    case 'railgunFinish': {
      const gun = buildRailgun(railgunFinishById(entry.id).data);
      const pivot = new THREE.Group();
      gun.group.position.set(0, 0, 0.23);
      pivot.add(gun.group);
      // 3/4: barrel toward screen-right and a little away, top edge visible.
      pivot.rotation.set(0.32, -1.02, 0.18);
      pivot.position.set(0, 0, 0);
      gun.setCharge(1);
      return {
        root: pivot,
        target: new THREE.Vector3(0.02, 0.02, 0),
        dist: 2.25,
        elev: 0.12,
        dispose: () => {
          // Shared geometry cache: free only this gun's materials.
          gun.dispose();
          gun.group.removeFromParent();
        },
      };
    }
    case 'railColor': {
      const rc = railColorById(entry.id).data;
      const root = new THREE.Group();
      return {
        root,
        target: new THREE.Vector3(0, 0, 0),
        dist: 4.2,
        elev: 0,
        settle: () => {
          const a = new THREE.Vector3(-2.3, -1.25, 0.6);
          const b = new THREE.Vector3(2.3, 1.25, -0.6);
          getFxContext(s.scene).beams.spawn(a, b, rc.core, rc.helix, false, { mode: railColorById(entry.id).mode });
          s.effects.spawnHitFlash(s.scene, b.clone().multiplyScalar(0.62), rc.helix);
          stepEffects(s, 0.09);
        },
        dispose: () => {},
      };
    }
    case 'killEffect': {
      const style = entry.id as KillEffectStyle;
      const skin = FINISHER_SKIN[entry.rarity] ?? '#27b8ff';
      const c = combatant(0.3, 'idle', 0.6, skin);
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.05, 0),
        dist: 5.0,
        elev: 0.1,
        settle: () => {
          // As in-game: the burst (in the victim's colour), then the death.
          s.effects.spawnKillBurst(s.scene, new THREE.Vector3(0, 0.95, 0), false, style, new THREE.Color(skin));
          c.anim.die({ y: 0 }, style);
          const step = 1 / 120;
          for (let t = 0; t + step <= (FINISHER_FRAME[style] ?? 0.2) + 1e-9; t += step) {
            c.anim.updateStatic(step);
            s.effects.step(step, s.scene);
          }
        },
        dispose: () => disposeCombatant(c),
      };
    }
    case 'spawnEffect': {
      const c = combatant(0.2);
      const style = spawnEffectById(entry.id).style;
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.05, 0),
        dist: 5.3,
        elev: 0.12,
        settle: () => {
          s.effects.spawnInBurst(s.scene, new THREE.Vector3(0, 0, 0), style);
          stepEffects(s, 0.22);
        },
        dispose: () => disposeCombatant(c),
      };
    }
    case 'emote': {
      const kind = emoteById(entry.id).kind;
      const c = combatant(0.28, kind, (EMOTE_FRAME[kind] ?? 0.4) * emoteClip(kind).duration);
      const gun = kind === 'flourish' ? attachRailgun(c.ch) : null;
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.12, 0),
        dist: 4.25,
        elev: 0.08,
        dispose: () => {
          disposeRailgun(gun);
          disposeCombatant(c);
        },
      };
    }
    default:
      return null;
  }
}

// Render + encode with an alpha fix-up. Additive FX (bursts, beams, unusual
// particles) write colour but little alpha into a transparent buffer, so they
// would wash out over the tile's rarity backdrop. Two passes: the full scene,
// then only the non-additive geometry (its coverage). Final alpha = max(that
// coverage, the pixel's brightest channel); colour is un-premultiplied by it.
function encode(s: Studio, cam: THREE.Camera): string | null {
  const gl = s.renderer.getContext();
  s.renderer.render(s.scene, cam);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, s.px);
  const hidden: THREE.Object3D[] = [];
  s.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!o.visible || !m) return;
    const additive = Array.isArray(m) ? m.some((x) => x.blending === THREE.AdditiveBlending) : m.blending === THREE.AdditiveBlending;
    if (additive) {
      o.visible = false;
      hidden.push(o);
    }
  });
  s.renderer.render(s.scene, cam);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, s.mask);
  for (const o of hidden) o.visible = true;
  const ctx = s.out.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  const px = s.px;
  const mask = s.mask;
  for (let y = 0; y < SIZE; y++) {
    const src = (SIZE - 1 - y) * SIZE * 4; // GL rows run bottom-up
    const dst = y * SIZE * 4;
    for (let x = 0; x < SIZE * 4; x += 4) {
      const i = src + x;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const a = Math.max(mask[i + 3], r, g, b);
      const o = dst + x;
      if (a === 0) {
        d[o + 3] = 0;
        continue;
      }
      const k = 255 / a;
      d[o] = r * k;
      d[o + 1] = g * k;
      d[o + 2] = b * k;
      d[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return s.webp ? s.out.toDataURL('image/webp', 0.9) : s.out.toDataURL('image/png');
}

async function renderThumb(id: string): Promise<string | null> {
  const entry = cosmeticById(id);
  if (!renderable(entry)) return null;
  const s = getStudio();
  if (!s) return null;
  const subj = await buildSubject(s, entry!);
  if (!subj) return null;
  // The studio may have been released while an async load was in flight.
  if (studio !== s) {
    subj.dispose();
    return renderThumb(id);
  }
  try {
    s.scene.add(subj.root);
    const cam = s.camera;
    const elev = subj.elev ?? 0.1;
    const azim = subj.azim ?? 0;
    cam.fov = subj.fov ?? 30;
    cam.position.set(
      subj.target.x + Math.sin(azim) * Math.cos(elev) * subj.dist,
      subj.target.y + Math.sin(elev) * subj.dist,
      subj.target.z + Math.cos(azim) * Math.cos(elev) * subj.dist,
    );
    cam.lookAt(subj.target);
    cam.updateProjectionMatrix();
    subj.root.updateMatrixWorld(true);
    subj.settle?.();
    // Compile off the main thread where the browser allows it, then render in
    // its own animation frame (≤ 1 thumbnail per frame).
    try {
      await s.renderer.compileAsync(s.scene, cam);
    } catch {
      /* compile inline on render */
    }
    await nextFrame();
    if (studio !== s) return null;
    return encode(s, cam);
  } finally {
    s.scene.remove(subj.root);
    subj.dispose();
    peekFxContext(s.scene)?.clear();
  }
}
