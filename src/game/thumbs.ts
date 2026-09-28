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
const STORE_PREFIX = 'ig-thumb:v3:';
// A neutral armour so every thumbnail reads on all four rarity backgrounds.
const THUMB_SKIN = '#c3ccda';
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

// Warm a batch (e.g. a Locker slot's grid) — same as calling getThumbnail on each.
export function prefetchThumbnails(ids: readonly string[]): void {
  for (const id of ids) void getThumbnail(id);
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
    } catch {
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
    studio = { renderer, scene, camera, env, effects, webp };
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

// A neutral combatant, facing the camera (optionally turned `turn` radians).
function combatant(turn = 0) {
  const holder = new THREE.Group();
  const ch = new Character({ colorHex: THUMB_SKIN, castShadow: false });
  holder.add(ch.root);
  holder.rotation.y = FACE_CAMERA + turn;
  const anim = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
  anim.playEmote('idle');
  anim.setEmoteTime(0.6, 1);
  anim.updateStatic(0);
  return { holder, ch, anim };
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
      const c = combatant(-0.42);
      const hat = new WornHat(c.ch.sockets.headTop);
      await hat.setHat(entry.id);
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.74, 0),
        dist: 1.62,
        elev: 0.16,
        dispose: () => {
          hat.dispose();
          disposeCombatant(c);
        },
      };
    }
    case 'unusual': {
      const c = combatant(-0.25);
      const hat = new WornHat(c.ch.sockets.headTop);
      hat.setUnusual(entry.id);
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.84, 0),
        dist: 1.78,
        elev: 0.1,
        settle: () => {
          for (let i = 0; i < 36; i++) hat.update(1 / 60); // ~0.6 s in
        },
        dispose: () => {
          hat.dispose();
          disposeCombatant(c);
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
        dist: 2.55,
        elev: 0.12,
        dispose: () => {
          const mats = new Set<THREE.Material>();
          gun.group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            m.geometry?.dispose();
            const mat = m.material;
            if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
            else if (mat) mats.add(mat);
          });
          mats.forEach((m) => m.dispose());
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
          getFxContext(s.scene).beams.spawn(a, b, rc.core, rc.helix, false);
          s.effects.spawnHitFlash(s.scene, b.clone().multiplyScalar(0.62), rc.helix);
          stepEffects(s, 0.09);
        },
        dispose: () => {},
      };
    }
    case 'killEffect': {
      const c = combatant(0.3);
      const style = entry.id as KillEffectStyle;
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.0, 0),
        dist: 5.2,
        elev: 0.1,
        settle: () => {
          c.anim.die({ y: 0 }, style);
          s.effects.spawnKillBurst(s.scene, new THREE.Vector3(0, 0.95, 0), false, style);
          stepEffects(s, 0.1, (dt) => c.anim.updateStatic(dt));
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
      const c = combatant(0.28);
      let gun: THREE.Group | null = null;
      if (kind === 'flourish') gun = attachRailgun(c.ch);
      c.anim.playEmote(kind, true);
      const dur = emoteClip(kind).duration;
      c.anim.setEmoteTime((EMOTE_FRAME[kind] ?? 0.4) * dur, 1);
      c.anim.updateStatic(0);
      return {
        root: c.holder,
        target: new THREE.Vector3(0, 1.08, 0),
        dist: 5.0,
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
    s.renderer.render(s.scene, cam);
    const url = s.webp
      ? s.renderer.domElement.toDataURL('image/webp', 0.9)
      : s.renderer.domElement.toDataURL('image/png');
    return url;
  } finally {
    s.scene.remove(subj.root);
    subj.dispose();
    peekFxContext(s.scene)?.clear();
  }
}
