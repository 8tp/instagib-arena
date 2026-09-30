import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CharacterAnimator } from './character-anim';
import { DYE_TIME } from './character/body';
import { Character } from './character/character';
import { attachRailgun, disposeRailgun } from './character/gun';
import { EffectsManager } from './effects';
import { emoteClip } from './emotes';
import { dyeById } from './dyes';
import { disposeFxContext, getFxContext, peekFxContext } from './fx-pool';
import { WornHat } from './hats';
import { HAS_GEAR, WornGearCtor, wearLook, type GearSlot } from '../economy/gear';
import { legacyUnusualFor } from '../economy/display';
import { parseLookKey } from '../economy/look';
import { itemDef, type ItemDef } from './items/catalog';
import type { Look } from './items/types';
import { buildRailgun } from './weapon-model';
import {
  cosmeticById,
  emoteById,
  hatById,
  railColorById,
  railgunFinishById,
  spawnEffectById,
  unusualById,
  UNUSUALS,
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
//  • Requests queue; work runs in idle time (requestIdleCallback, with a
//    timeout) one thumbnail at a time, shaders compile async, and encoding is
//    async (toBlob → FileReader), so opening the Locker never hitches.
//    Subjects without additive FX render once and encode straight from the
//    WebGL canvas; only FX subjects pay for the two-pass alpha fix-up.
//  • Cache: an in-memory Map + de-duplicated pending promises, mirrored to
//    sessionStorage so a reload within the tab doesn't re-render. Only real
//    captures are cached: a failure (lost context, a hat model that didn't
//    load, a throw) is never cached, so a later request retries.
//  • Slots with no 3D subject (name colours, titles, cards, announcers) return
//    null: ItemTile draws a CSS treatment for those.
//  • Turntables (getTurntable): on demand only (a hover / focus), the subject
//    spun a full turn — or played through its clip / FX — as ONE horizontal
//    sprite strip, rendered by the same studio in a single job that jumps the
//    queue (at most one queued at a time) and yields between frame chunks.
//    Tiles play the strip with a CSS steps() animation; cached like thumbs.
// Transparent background — the tile's rarity gradient shows through.
// ─────────────────────────────────────────────────────────────────────────

const SIZE = 256;
const IDLE_RELEASE_MS = 30_000;
const STORE_PREFIX = 'ig-thumb:v16:';
// A neutral armour so every thumbnail reads on all four rarity backgrounds.
const THUMB_SKIN = '#c3ccda';
// Hats sit on a mid-slate helmet: white caps read lighter, black hats darker.
const HAT_SKIN = '#6f7888';
const FACE_CAMERA = Math.PI;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const failed = new Set<string>(); // failed this session (shown as no-thumbnail until re-requested)
type Job =
  | { kind: 'thumb'; id: string; resolve: (url: string | null) => void; tries: number }
  | { kind: 'turn'; id: string; resolve: (t: Turntable | null) => void; tries: number };

// A transient failure: never cached; the job may be retried.
class ThumbFailure extends Error {}
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

// A thumbnail request is a cosmetic id or a Look key (id|e=…|p=…, see
// economy/look.ts) — a rolled variant (unusual effect…) renders and caches on
// its own.
type Target = { id: string; look: Look; entry: CatalogEntry | undefined; def: ItemDef | undefined };
function targetOf(key: string): Target {
  const look = key.includes('|') ? parseLookKey(key) : { d: key };
  return { id: look.d, look, entry: cosmeticById(look.d), def: itemDef(look.d) };
}
const WEARABLE = new Set(['hat', 'face', 'back']);
function renderableTarget(t: Target): boolean {
  if (t.def && WEARABLE.has(t.def.slot) && !t.def.default && HAS_GEAR) return true;
  if (t.def?.slot === 'dye') return !!dyeById(t.id);
  return renderable(t.entry);
}
// Which get a turntable (the rail beam is one static shot: its FX is the item).
function turntableTarget(t: Target): boolean {
  return renderableTarget(t) && t.entry?.slot !== 'railColor';
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
  if (typeof document === 'undefined' || !renderableTarget(targetOf(id))) {
    cache.set(id, null); // no 3D subject: permanent, not a failure
    return Promise.resolve(null);
  }
  if (studioFailed) return Promise.resolve(null); // no WebGL at all
  let p = pending.get(id);
  if (!p) {
    failed.delete(id); // a fresh request retries an earlier failure
    p = new Promise<string | null>((resolve) => queue.push({ kind: 'thumb', id, resolve, tries: 0 }));
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
  // A queued turntable (the player is hovering it) stays at the very front.
  const turns = queue.filter((j) => j.kind === 'turn');
  const first = queue.filter((j) => j.kind === 'thumb' && want.has(j.id));
  const rest = queue.filter((j) => j.kind === 'thumb' && !want.has(j.id));
  queue.length = 0;
  queue.push(...turns, ...first, ...rest);
}

// True while a thumbnail is queued or rendering (tiles show a quiet
// placeholder instead of the no-thumbnail fallback).
export function thumbnailPending(id: string): boolean {
  if (pending.has(id)) return true;
  // Not asked for yet but it will be (a tile's first paint): also pending.
  return !cache.has(id) && !failed.has(id) && !studioFailed && typeof document !== 'undefined' && renderableTarget(targetOf(id));
}

// Wait for idle time (the preview's frames come first); a timeout keeps the
// queue moving on a page that never idles.
const idle = () =>
  new Promise<void>((r) => {
    const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }) : null;
    if (w?.requestIdleCallback) w.requestIdleCallback(() => r(), { timeout: 300 });
    else setTimeout(r, 32);
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
    if (job.kind === 'turn') {
      await runTurnJob(job);
      continue;
    }
    let url: string | null = null;
    try {
      url = await renderThumb(job.id);
    } catch (err) {
      // Lost context: the studio was dropped — retry once on a fresh one.
      if (err instanceof ThumbFailure && err.message === 'context-lost' && job.tries < 1) {
        job.tries++;
        queue.unshift(job);
        continue;
      }
      console.warn(`[thumbs] ${job.id} failed to render`, err);
      url = null;
    }
    if (url) {
      cache.set(job.id, url);
      storeSet(job.id, url);
    } else {
      failed.add(job.id);
    }
    pending.delete(job.id);
    job.resolve(url);
  }
  running = false;
  releaseTimer = setTimeout(release, IDLE_RELEASE_MS);
}

// ── Turntables ───────────────────────────────────────────────────────────────

// A horizontal strip of `frames` square frames (TURN_PX each), looping every
// `ms`. `spin`: a full turn of the subject; otherwise a clip / FX sequence.
export type Turntable = { url: string; frames: number; ms: number; spin: boolean };

const TURN_FRAMES = 36;
const TURN_PX = 224;
const TURN_MS = 4200; // one full turn
const TURN_STORE = 'ig-turn:v2:';
const TURN_STORE_IDX = 'ig-turn:v2:#idx';
const TURN_STORE_MAX = 6; // a strip is ~120–250 KB: leave sessionStorage to the thumbs
const TURN_MEM_MAX = 48;

const turnCache = new Map<string, Turntable | null>(); // insertion order = LRU
const turnPending = new Map<string, { p: Promise<Turntable | null>; refs: number; started: boolean }>();

function turnStoreGet(key: string): Turntable | null {
  try {
    const raw = sessionStorage.getItem(TURN_STORE + key);
    if (!raw) return null;
    const t = JSON.parse(raw) as Turntable;
    return t && typeof t.url === 'string' && t.frames > 0 ? t : null;
  } catch {
    return null;
  }
}
function turnStoreSet(key: string, t: Turntable) {
  try {
    const idx = (JSON.parse(sessionStorage.getItem(TURN_STORE_IDX) ?? '[]') as string[]).filter((k) => k !== key);
    idx.push(key);
    while (idx.length > TURN_STORE_MAX) sessionStorage.removeItem(TURN_STORE + idx.shift()!);
    sessionStorage.setItem(TURN_STORE + key, JSON.stringify(t));
    sessionStorage.setItem(TURN_STORE_IDX, JSON.stringify(idx));
  } catch {
    /* quota / privacy mode — the memory cache still works */
  }
}
function turnRemember(key: string, t: Turntable) {
  turnCache.delete(key);
  turnCache.set(key, t);
  while (turnCache.size > TURN_MEM_MAX) turnCache.delete(turnCache.keys().next().value!);
}

// Whether this item (a cosmetic id or Look key) has a turntable at all.
export function hasTurntable(key: string): boolean {
  return typeof document !== 'undefined' && !studioFailed && turntableTarget(targetOf(key));
}

// Synchronous cache peek.
export function peekTurntable(key: string): Turntable | null {
  const hit = turnCache.get(key);
  if (hit) return hit;
  const stored = turnStoreGet(key);
  if (stored) turnRemember(key, stored);
  return stored;
}

// Ask for a turntable (a hover / focus intent). It jumps the thumbnail queue;
// `release()` when the intent ends: a job that hasn't started yet is dropped
// (resolving null) once nobody holds it, so sweeping the pointer across a grid
// never leaves a backlog of spins. Failures aren't cached (a later hover retries).
export function requestTurntable(key: string): { promise: Promise<Turntable | null>; release: () => void } {
  const hit = peekTurntable(key);
  if (hit) return { promise: Promise.resolve(hit), release: () => {} };
  if (!hasTurntable(key)) return { promise: Promise.resolve(null), release: () => {} };
  let entry = turnPending.get(key);
  if (!entry) {
    let resolve!: (t: Turntable | null) => void;
    const p = new Promise<Turntable | null>((r) => (resolve = r));
    entry = { p, refs: 0, started: false };
    turnPending.set(key, entry);
    // One spin queued at a time: an older, unstarted one nobody holds goes.
    for (let i = queue.length - 1; i >= 0; i--) {
      const j = queue[i];
      if (j.kind === 'turn' && (turnPending.get(j.id)?.refs ?? 0) <= 0) {
        queue.splice(i, 1);
        turnPending.delete(j.id);
        j.resolve(null);
      }
    }
    queue.unshift({ kind: 'turn', id: key, resolve, tries: 0 });
    void pump();
  }
  entry.refs++;
  const e = entry;
  let released = false;
  return {
    promise: e.p,
    release: () => {
      if (released) return;
      released = true;
      e.refs--;
      if (e.refs > 0 || e.started) return;
      const i = queue.findIndex((j) => j.kind === 'turn' && j.id === key);
      if (i < 0) return;
      const [j] = queue.splice(i, 1);
      turnPending.delete(key);
      j.resolve(null);
    },
  };
}

async function runTurnJob(job: Extract<Job, { kind: 'turn' }>) {
  const entry = turnPending.get(job.id);
  if (entry) entry.started = true;
  let t: Turntable | null = null;
  try {
    t = await renderTurntable(job.id);
  } catch (err) {
    if (err instanceof ThumbFailure && err.message === 'context-lost' && job.tries < 1) {
      job.tries++;
      queue.unshift(job);
      return;
    }
    console.warn(`[thumbs] turntable ${job.id} failed`, err);
  }
  if (t) {
    turnRemember(job.id, t);
    turnStoreSet(job.id, t);
  }
  turnPending.delete(job.id);
  job.resolve(t);
}

// A macrotask hop between frame chunks (keeps input and the live stage smooth).
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

// ── The shared studio ────────────────────────────────────────────────────────

type Studio = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  env: THREE.Texture;
  effects: EffectsManager;
  lost: boolean; // the WebGL context was lost: drop this studio
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
    // The studio steps its own effects before every capture, so body-bound
    // finisher particles (voxels, shards, confetti, ash) spawn into the pool —
    // unmanaged, GibBurst.start skips them and the thumbnail comes out empty.
    getFxContext(scene).managed = true;
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
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    const n = SIZE * SIZE * 4;
    const st: Studio = { renderer, scene, camera, env, effects, lost: false, out, px: new Uint8Array(n), mask: new Uint8Array(n) };
    canvas.addEventListener('webglcontextlost', () => {
      st.lost = true;
      if (studio === st) studio = null;
    });
    studio = st;
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
  dropStudio(studio);
}

function dropStudio(s: Studio) {
  if (studio === s) studio = null;
  try {
    if (peekFxContext(s.scene)) disposeFxContext(s.scene);
    s.env.dispose();
    s.renderer.dispose();
    if (!s.lost) s.renderer.forceContextLoss();
  } catch {
    /* already lost — nothing left to free */
  }
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
  // Optional: pull the camera in/out until this box fills `fill` of the frame
  // (its larger projected side), centred on the box.
  fitBox?: THREE.Box3;
  fill?: number;
  exposure?: number; // tone-mapping exposure for this shot (default 0.95)
  // Advance any simulation before the shot (called once, after the subject
  // is in the scene).
  settle?: () => void;
  // Turntable behaviour (turn mode): by default the root spins a full turn
  // about Y over TURN_MS. `pose(t, dt)` advances the subject to loop time t
  // (clips, FX, cloth) before each frame; `spin: false` keeps it still.
  turn?: { ms?: number; spin?: boolean; pose?: (t: number, dt: number) => void };
  dispose: () => void;
};

// thumb = the still for tiles; turn = a turntable, framed to show the item
// ON a combatant (no silhouette, a little more body) so it reads as worn.
type Mode = 'thumb' | 'turn';

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

// Swap a thumbnail combatant to a near-black silhouette so the item (hat,
// unusual) is the only thing that reads. Returns an undo.
function silhouette(ch: Character): () => void {
  const body = ch.mesh.material;
  const dark = new THREE.MeshStandardMaterial({ color: 0x07090d, roughness: 0.9, metalness: 0, envMapIntensity: 0.12 });
  ch.mesh.material = dark;
  return () => {
    ch.mesh.material = body;
    dark.dispose();
  };
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
  takethel: 0.33,
  tpose: 0.3,
  crab: 0.5,
  facepalm: 0.33,
  micdrop: 0.34,
  gg: 0.36,
  pushups: 0.5,
  teatime: 0.32,
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

// Head-and-shoulders window for worn headgear (turn mode): the head sits in a
// `win`-metre window whose top clears the hat by `pad` (an Unusual effect
// floats above the hat top and needs more room).
function headWindow(top: number, win: number, pad = 0.14): { target: THREE.Vector3; dist: number } {
  const t = Math.max(1.65 + 0.4 * win, top + pad);
  return { target: new THREE.Vector3(0, t - win / 2, 0), dist: win / 2 / Math.tan((30 * Math.PI) / 360) };
}

// A face / back / new-def hat via the shared wearable builders.
async function buildGearSubject(slot: GearSlot, look: Look, mode: Mode): Promise<Subject | null> {
  if (!WornGearCtor) return null;
  const turn = slot === 'back' ? Math.PI - 0.55 : slot === 'face' ? -0.28 : -0.42;
  const c = combatant(turn, 'idle', 0.6, HAT_SKIN);
  const gear = new WornGearCtor(c.ch);
  wearLook(gear, slot, look);
  // Cloth / plumes / unusual particles settle for a second before the shot.
  for (let i = 0; i < 60; i++) gear.update(1 / 60);
  const undo = mode === 'thumb' && slot === 'hat' && look.e ? silhouette(c.ch) : () => {};
  const top = gear.headTopY();
  const spin = mode === 'turn';
  const hatWin = spin && slot === 'hat' ? headWindow(top, look.e ? 1.25 : 0.95, look.e ? 0.45 : 0.14) : null;
  const target =
    slot === 'face'
      ? new THREE.Vector3(0, 1.6, 0)
      : slot === 'back'
        ? new THREE.Vector3(0, 1.2, 0)
        : (hatWin?.target ?? new THREE.Vector3(0, Math.max(1.7, Math.min(2.4, top - 0.1)), 0));
  return {
    root: c.holder,
    target,
    dist: hatWin?.dist ?? (slot === 'face' ? (spin ? 1.4 : 1.2) : slot === 'back' ? (spin ? 3.25 : 3.1) : look.e ? 1.5 : 1.35),
    elev: slot === 'back' ? 0.16 : 0.08,
    exposure: look.e ? 1.2 : 0.95,
    // Cloth, plumes and particles keep moving while it turns.
    turn: { pose: (_t, dt) => gear.update(dt) },
    dispose: () => {
      gear.dispose();
      undo();
      disposeCombatant(c);
    },
  };
}

// A combatant wearing a dye: full body, 3/4, idle. Animated dyes run off the
// shared wall clock (DYE_TIME); a turntable pins it per frame instead, so the
// strip plays the pattern at the speed it runs in-game.
function buildDyeSubject(id: string, mode: Mode): Subject | null {
  const dye = dyeById(id);
  if (!dye) return null;
  const c = combatant(-0.5, 'idle', 0.6, THUMB_SKIN);
  c.ch.wearDye(dye, THUMB_SKIN);
  let pinned: number | null = null;
  const mesh = c.ch.mesh;
  const before = mesh.onBeforeRender;
  mesh.onBeforeRender = function (this: THREE.Object3D, ...a: Parameters<THREE.Object3D['onBeforeRender']>) {
    before.apply(this, a);
    if (pinned !== null) DYE_TIME.value = pinned;
  };
  const t0 = 40 + Math.random() * 20;
  return {
    root: c.holder,
    target: new THREE.Vector3(0, mode === 'turn' ? 1.0 : 1.12, 0),
    dist: mode === 'turn' ? 4.05 : 4.25,
    elev: 0.1,
    turn: {
      pose: (t) => {
        pinned = t0 + t;
      },
    },
    dispose: () => {
      mesh.onBeforeRender = before;
      disposeCombatant(c);
    },
  };
}

async function buildSubject(s: Studio, t: Target, mode: Mode = 'thumb'): Promise<Subject | null> {
  const { look } = t;
  if (t.def && WEARABLE.has(t.def.slot) && !t.def.default && HAS_GEAR) return buildGearSubject(t.def.slot as GearSlot, look, mode);
  if (t.def?.slot === 'dye') return buildDyeSubject(t.id, mode);
  const entry = t.entry!;
  switch (entry.slot) {
    case 'hat': {
      const c = combatant(-0.42, 'idle', 0.6, HAT_SKIN);
      const hat = new WornHat(c.ch.sockets.headTop);
      await hat.setHat(entry.id);
      if (look.e) hat.setUnusual(legacyUnusualFor(look.e, UNUSUALS));
      // The hat is the subject: a dark silhouette head (no white mannequin
      // dome competing) and the camera fitted so the hat fills ~60%.
      const undo = mode === 'thumb' ? silhouette(c.ch) : () => {};
      c.holder.updateMatrixWorld(true);
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      const visit = (o: THREE.Object3D) => {
        if (o.name === 'unusual') return;
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          if (m.geometry.boundingBox) box.union(tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
        }
        for (const k of o.children) visit(k);
      };
      for (const child of c.ch.sockets.headTop.children) visit(child);
      const bare = box.isEmpty() || box.max.y - box.min.y < 0.02;
      if (bare && hatById(entry.id).model) {
        // WornHat swallows load errors (stays bare in-game) — here that would
        // cache a bare head under the hat's id. Fail instead; a later request retries.
        hat.dispose();
        undo();
        disposeCombatant(c);
        throw new ThumbFailure(`hat model did not load: ${entry.id}`);
      }
      if (bare) box.setFromCenterAndSize(new THREE.Vector3(0, 1.72, 0), new THREE.Vector3(0.34, 0.26, 0.34));
      // Aim a little below the hat so it sits above the tile's name band. The
      // fit uses the hat's world AABB, whose 3/4 projection is ~1.4× the
      // silhouette — hence the generous fill.
      const size = box.getSize(new THREE.Vector3());
      const aim = box.getCenter(new THREE.Vector3()).addScaledVector(new THREE.Vector3(0, 1, 0), -size.y * 0.3);
      if (mode === 'turn') {
        // Worn: head and shoulders, turning.
        const win = headWindow(bare ? 1.8 : box.max.y, look.e ? 1.25 : 0.95, look.e ? 0.45 : 0.14);
        return {
          root: c.holder,
          target: win.target,
          dist: win.dist,
          elev: 0.08,
          exposure: look.e ? 1.2 : undefined,
          settle: () => {
            for (let i = 0; i < 60; i++) hat.update(1 / 60);
          },
          turn: { pose: (_t, dt) => hat.update(dt) },
          dispose: () => {
            hat.dispose();
            disposeCombatant(c);
          },
        };
      }
      return {
        root: c.holder,
        target: aim,
        dist: 1.6,
        elev: 0.3,
        fitBox: box,
        fill: bare ? 0.6 : 0.88,
        exposure: look.e ? 1.2 : undefined,
        settle: look.e
          ? () => {
              for (let i = 0; i < 60; i++) hat.update(1 / 60);
            }
          : undefined,
        dispose: () => {
          hat.dispose();
          undo();
          disposeCombatant(c);
        },
      };
    }
    case 'unusual': {
      const c = combatant(0);
      const hat = new WornHat(c.ch.sockets.headTop);
      hat.setUnusual(entry.id);
      const none = unusualById(entry.id).kind === 'none';
      // Dark head silhouette; the tile itself is dark for unusuals (rarity
      // colour on the rim + name band only), so the effect reads in its own
      // colours and fills most of the frame.
      const undo = none ? () => {} : silhouette(c.ch);
      return {
        root: c.holder,
        target: new THREE.Vector3(0, none ? 1.74 : 1.98, 0),
        dist: none ? 1.9 : 0.86,
        elev: 0.12,
        exposure: none ? 0.95 : 1.25,
        settle: () => {
          // Unusuals only simulate while seeded — step ~1 s in.
          for (let i = 0; i < 60; i++) hat.update(1 / 60);
        },
        turn: { pose: (_t, dt) => hat.update(dt) },
        dispose: () => {
          hat.dispose();
          undo();
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
      // Turntable: spin a level gun about the vertical (the 3/4 tilt would
      // wobble), pulled back so the side-on barrel fits.
      if (mode === 'turn') pivot.rotation.set(0.12, -1.02, 0);
      const root = mode === 'turn' ? new THREE.Group().add(pivot) : pivot;
      return {
        root,
        target: new THREE.Vector3(0.02, 0.02, 0),
        dist: mode === 'turn' ? 2.7 : 2.25,
        elev: mode === 'turn' ? 0.3 : 0.12,
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
      if (mode === 'turn') {
        // The kill as a loop: a beat standing, the burst + death, the gibs
        // flying — stepped at 120 Hz between frames.
        let simT = 0;
        let fired = false;
        return {
          root: c.holder,
          target: new THREE.Vector3(0, 1.05, 0),
          dist: 5.6,
          elev: 0.12,
          turn: {
            ms: 1700,
            spin: false,
            pose: (t) => {
              const step = 1 / 120;
              while (simT + step <= t + 1e-9) {
                if (!fired && simT >= 0.3) {
                  s.effects.spawnKillBurst(s.scene, new THREE.Vector3(0, 0.95, 0), false, style, new THREE.Color(skin));
                  c.anim.die({ y: 0 }, style);
                  fired = true;
                }
                c.anim.updateStatic(step);
                s.effects.step(step, s.scene);
                simT += step;
              }
            },
          },
          dispose: () => disposeCombatant(c),
        };
      }
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
      if (mode === 'turn') {
        // Materialise on a loop (as the live preview's spawn view): the burst
        // flares, the body scales in inside it, then stands.
        let simT = 0;
        let fired = false;
        return {
          root: c.holder,
          target: new THREE.Vector3(0, 1.1, 0),
          dist: 5.1,
          elev: 0.12,
          turn: {
            ms: 1700,
            spin: false,
            pose: (t) => {
              const step = 1 / 120;
              while (simT + step <= t + 1e-9) {
                if (!fired && simT >= 0.06) {
                  s.effects.spawnInBurst(s.scene, new THREE.Vector3(0, 0, 0), style);
                  fired = true;
                }
                s.effects.step(step, s.scene);
                simT += step;
              }
              const u = Math.max(0, Math.min(1, (t - 0.14) / 0.22));
              c.ch.root.visible = u > 0;
              c.ch.root.scale.set(1, u >= 1 ? 1 : 0.15 + 0.85 * (u * u * (3 - 2 * u)), 1);
            },
          },
          dispose: () => disposeCombatant(c),
        };
      }
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
      const dur = emoteClip(kind).duration;
      return {
        root: c.holder,
        target: new THREE.Vector3(0, mode === 'turn' ? 1.05 : 1.12, 0),
        dist: mode === 'turn' ? 4.7 : 4.25,
        elev: 0.08,
        // Turntable: the whole clip at a fixed 3/4 (clips loop seamlessly).
        turn: {
          ms: Math.round(dur * 1000),
          spin: false,
          pose: (t) => {
            c.anim.setEmoteTime(t % dur, 1);
            c.anim.updateStatic(0);
          },
        },
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

// Materials that write colour without matching alpha (additive / custom
// blends): their subjects need the alpha fix-up below.
function hasGlowFx(scene: THREE.Scene): boolean {
  let found = false;
  scene.traverseVisible((o) => {
    if (found) return;
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    if (list.some((x) => x.blending === THREE.AdditiveBlending || x.blending === THREE.CustomBlending)) found = true;
  });
  return found;
}

function assertAlive(s: Studio) {
  if (s.lost || s.renderer.getContext().isContextLost()) {
    dropStudio(s);
    throw new ThumbFailure('context-lost');
  }
}

const toBlob = (cv: HTMLCanvasElement, quality = 0.9) =>
  new Promise<Blob>((resolve, reject) => {
    // WebP keeps alpha and is small; browsers without it hand back PNG.
    cv.toBlob((b) => (b ? resolve(b) : reject(new ThumbFailure('encode failed'))), 'image/webp', quality);
  });

const toDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ThumbFailure('read failed'));
    r.readAsDataURL(b);
  });

// Render and encode (async). Opaque subjects encode straight from the WebGL
// canvas (no readPixels stall). Additive FX (bursts, beams, unusual
// particles) write colour but little alpha into a transparent buffer, so they
// would wash out over the tile's backdrop: two passes — the full scene, then
// only the non-additive geometry (its coverage) — and final alpha = max(that
// coverage, the pixel's brightest channel), colour un-premultiplied by it.
async function capture(s: Studio, cam: THREE.Camera): Promise<string> {
  return toDataUrl(await toBlob(frameCanvas(s, cam)));
}

// Draw one frame; returns the canvas holding it with correct alpha — the
// WebGL canvas itself (preserveDrawingBuffer: toBlob / drawImage read the
// frame just drawn) or, for glow FX, the fixed-up 2D canvas.
function frameCanvas(s: Studio, cam: THREE.Camera): HTMLCanvasElement {
  const gl = s.renderer.getContext();
  if (!hasGlowFx(s.scene)) {
    s.renderer.render(s.scene, cam);
    assertAlive(s);
    return s.renderer.domElement;
  }
  s.px.fill(0);
  s.mask.fill(0);
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
  assertAlive(s); // a lost context leaves the buffers zeroed, never stale
  const ctx = s.out.getContext('2d');
  if (!ctx) throw new ThumbFailure('no 2d context');
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
  return s.out;
}

// Dolly the camera along its view line until the box's larger projected side
// fills `fill` of the (square) frame. A few fixed-point steps converge.
const _corner = new THREE.Vector3();
function fitCamera(cam: THREE.PerspectiveCamera, box: THREE.Box3, target: THREE.Vector3, fill: number) {
  for (let it = 0; it < 4; it++) {
    cam.updateMatrixWorld(true);
    let ext = 0;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      _corner.project(cam);
      ext = Math.max(ext, Math.abs(_corner.x), Math.abs(_corner.y));
    }
    if (ext <= 1e-4) return;
    const d = cam.position.distanceTo(target);
    const nd = d * (ext / fill);
    cam.position.sub(target).setLength(nd).add(target);
  }
}

async function renderThumb(id: string): Promise<string | null> {
  const target = targetOf(id);
  if (!renderableTarget(target)) return null;
  await idle();
  const s = getStudio();
  if (!s) return null;
  const subj = await buildSubject(s, target);
  if (!subj) return null;
  // The studio may have been released while an async load was in flight.
  if (studio !== s) {
    subj.dispose();
    return renderThumb(id);
  }
  try {
    s.scene.add(subj.root);
    const cam = placeCamera(s, subj);
    subj.root.updateMatrixWorld(true);
    subj.settle?.();
    // Compile off the main thread where the browser allows it, then render in
    // idle time (one thumbnail per idle slice).
    try {
      await s.renderer.compileAsync(s.scene, cam);
    } catch {
      /* compile inline on render */
    }
    await idle();
    if (studio !== s) throw new ThumbFailure('context-lost');
    return await capture(s, cam);
  } finally {
    s.scene.remove(subj.root);
    subj.dispose();
    peekFxContext(s.scene)?.clear();
  }
}

// Aim the studio camera at a subject (see Subject).
function placeCamera(s: Studio, subj: Subject): THREE.PerspectiveCamera {
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
  if (subj.fitBox) fitCamera(cam, subj.fitBox, subj.target, subj.fill ?? 0.6);
  s.renderer.toneMappingExposure = subj.exposure ?? 0.95;
  return cam;
}

// One strip: TURN_FRAMES frames of the subject turning (or its clip / FX),
// each drawn into its cell as soon as it renders, a macrotask hop every few
// frames. ~36 small renders + one encode: a few hundred ms, off the hot path.
async function renderTurntable(key: string): Promise<Turntable | null> {
  const target = targetOf(key);
  if (!turntableTarget(target)) return null;
  const s = getStudio();
  if (!s) return null;
  const subj = await buildSubject(s, target, 'turn');
  if (!subj) return null;
  if (studio !== s) {
    subj.dispose();
    throw new ThumbFailure('context-lost');
  }
  const n = TURN_FRAMES;
  const turn = subj.turn ?? {};
  const ms = turn.ms ?? TURN_MS;
  const spin = turn.spin !== false;
  try {
    s.scene.add(subj.root);
    const cam = placeCamera(s, subj);
    subj.root.updateMatrixWorld(true);
    subj.settle?.();
    try {
      await s.renderer.compileAsync(s.scene, cam);
    } catch {
      /* compile inline on render */
    }
    if (studio !== s) throw new ThumbFailure('context-lost');
    const sheet = document.createElement('canvas');
    sheet.width = TURN_PX * n;
    sheet.height = TURN_PX;
    const ctx = sheet.getContext('2d');
    if (!ctx) throw new ThumbFailure('no 2d context');
    ctx.imageSmoothingQuality = 'high';
    const baseYaw = subj.root.rotation.y;
    const dt = ms / 1000 / n;
    for (let i = 0; i < n; i++) {
      // Clockwise seen from above: the subject turns its right side to us first.
      if (spin) subj.root.rotation.y = baseYaw - (i / n) * Math.PI * 2;
      turn.pose?.(i * dt, dt);
      subj.root.updateMatrixWorld(true);
      ctx.drawImage(frameCanvas(s, cam), 0, 0, SIZE, SIZE, i * TURN_PX, 0, TURN_PX, TURN_PX);
      if (i % 6 === 5) {
        await nextTask();
        if (studio !== s) throw new ThumbFailure('context-lost');
      }
    }
    const url = await toDataUrl(await toBlob(sheet, 0.82));
    return { url, frames: n, ms, spin };
  } finally {
    s.scene.remove(subj.root);
    subj.dispose();
    peekFxContext(s.scene)?.clear();
  }
}
