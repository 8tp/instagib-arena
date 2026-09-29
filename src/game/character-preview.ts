import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { WornHat } from './hats';
import { WornGearCtor, type GearLike } from '../economy/gear';
import { lookKey } from '../economy/look';
import type { Loadout } from './items/types';
import { CharacterAnimator } from './character-anim';
import { Character, SKIN_PALETTE, skinColorFor } from './character/character';
import { attachRailgun, disposeRailgun, type AttachedRailgun } from './character/gun';
import { RAIL_COOLDOWN } from './constants';
import { dyeById } from './dyes';
import { EffectsManager } from './effects';
import { getFxContext } from './fx-pool';
import { buildRailgun, type RailgunModel } from './weapon-model';
import { customGun } from './gun/custom/registry';
import {
  emoteById,
  railColorById,
  railgunFinishById,
  spawnEffectById,
  type EmoteKind,
  type KillEffectStyle,
} from './cosmetics';

// ─────────────────────────────────────────────────────────────────────────
// Live Locker preview: ONE WebGL context for the whole Locker. The framing
// ("view") is switchable at runtime — the camera eases between framings — so
// picking a slot never remounts the renderer:
//   full      whole combatant idling (breathing), hat + unusual on
//   head      head-and-shoulders for hats (the window grows with a tall hat)
//   crown     head-and-shoulders with headroom for an unusual effect
//   character legacy alias of `head` with a slow turntable sway (/lockerlab)
//   identity  upper body, room above the head for the DOM nameplate anchor
//   emote     full body playing the emote (railgun in hand when it calls)
//   finisher  a dummy combatant idles ~1 s, is railed, dies with the finisher
//             (gibs + the kill burst), respawns — on a loop
//   spawn     the combatant materialising with the spawn effect, on a loop
//   weapon    the railgun close-up, coils charging, firing the real rail beam
// Every cosmetic id may be ANY catalog id (try-on of locked items is fine —
// the preview never equips anything). Drag the canvas to spin the subject
// (inertia); motion is frame-rate independent throughout.
// ─────────────────────────────────────────────────────────────────────────

export type PreviewView =
  | 'character'
  | 'emote'
  | 'weapon'
  | 'full'
  | 'head'
  | 'crown'
  | 'face' // close-up on the visor / mask
  | 'back' // rear three-quarter at the torso
  | 'identity'
  | 'finisher'
  | 'spawn';

export type PreviewCosmetics = {
  hatId: string;
  unusualId: string;
  emoteId: string;
  railColor: string; // rail cosmetic id
  railgunFinish: string; // railgun-finish cosmetic id
  killEffect: KillEffectStyle;
  view: PreviewView;
  // Seed for the armour colour (the player's name) so the preview wears the
  // same bright skin other players see. Falls back to the saved profile name.
  skinSeed?: string;
  spawnEffect?: string; // spawn-effect cosmetic id (spawn view)
  // Accessibility: slower loops, instant camera cuts, no celebration bursts.
  reducedEffects?: boolean;
  // Economy v3: the Looks to wear (hat / face / back go to the wearable
  // builders when present; the legacy hatId/unusualId fields are the fallback).
  looks?: Loadout;
};

export type PreviewOptions = {
  lowSpec?: boolean; // no MSAA, 1× pixel ratio
};

const FACE_CAMERA = Math.PI; // the combatant faces -Z; turn it to face the +Z camera
const FIRE_PERIOD = 2.4; // seconds between showcase rail shots (weapon view)
const FINISHER_IDLE = 1.05; // dummy stands this long before the shot
const FINISHER_DEAD = 1.75; // gibs fly (GibBurst lasts 1.3 s) before the respawn
const SPAWN_PERIOD = 2.8;
const CAM_EASE = 6.5; // camera framing ease rate (1/s)
const DRAG_RATE = 0.0115; // radians per dragged pixel
const SPIN_DECAY = 3.2; // inertia decay rate (1/s)
const IDLE_SWAY_AFTER = 4; // seconds without a drag before the gentle sway returns
const CHEST = new THREE.Vector3(0, 0.95, 0); // kill-burst centre (body centre, as in-game)

type Framing = { tx: number; ty: number; tz: number; dist: number; elev: number; fov: number };

const FRAMES: Record<PreviewView, Framing> = {
  full: { tx: 0, ty: 1.0, tz: 0, dist: 4.7, elev: 0.3, fov: 30 },
  head: { tx: 0, ty: 1.52, tz: 0, dist: 2.05, elev: 0.1, fov: 30 },
  crown: { tx: 0, ty: 1.66, tz: 0, dist: 2.4, elev: 0.1, fov: 30 },
  face: { tx: 0, ty: 1.58, tz: 0, dist: 1.55, elev: 0.04, fov: 30 },
  back: { tx: 0, ty: 1.2, tz: 0, dist: 3.5, elev: 0.14, fov: 30 },
  character: { tx: 0, ty: 1.66, tz: 0, dist: 2.05, elev: 0.1, fov: 30 },
  identity: { tx: 0, ty: 1.3, tz: 0, dist: 4.4, elev: 0.1, fov: 30 },
  emote: { tx: 0, ty: 1.08, tz: 0, dist: 5.3, elev: 0.25, fov: 30 },
  finisher: { tx: 0, ty: 1.1, tz: 0, dist: 8.6, elev: 0.55, fov: 24 },
  spawn: { tx: 0, ty: 1.2, tz: 0, dist: 7.0, elev: 0.45, fov: 28 },
  weapon: { tx: 0, ty: 1.02, tz: 0, dist: 4.3, elev: 0.32, fov: 30 },
};

function savedName(): string {
  try {
    return localStorage.getItem('instagib-name') ?? '';
  } catch {
    return '';
  }
}

// Soft pool of light under the combatant (radial alpha falloff + a faint rim).
function floorTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(120,150,190,0.55)');
  g.addColorStop(0.45, 'rgba(60,80,110,0.32)');
  g.addColorStop(0.86, 'rgba(30,40,58,0.12)');
  g.addColorStop(0.93, 'rgba(140,200,255,0.22)');
  g.addColorStop(0.955, 'rgba(30,40,58,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BG_BOTTOM = 0x06080b;

// White radial falloff (the rarity tint's shape).
function radialTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Faint floor grid (0.5 m cells) fading out radially.
function gridTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 1024;
  const cells = 36; // 18 m across the 9 m-radius disc → 0.5 m cells
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.strokeStyle = 'rgba(140,180,230,0.16)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * S;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, S);
    ctx.moveTo(0, p);
    ctx.lineTo(S, p);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'destination-in';
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class CharacterPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private effects = new EffectsManager();
  private envTex: THREE.Texture | null = null;
  // Subject turntable (orbit + sway rotate this, lights stay put).
  private subject = new THREE.Group();
  private floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private floorTex: THREE.CanvasTexture | null = null;
  // Backdrop (drawn in WebGL — see the constructor): a gradient + slot
  // watermark canvas as the scene background, a screen-space rarity tint
  // that eases between colours, and a receding floor grid.
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgTex: THREE.CanvasTexture | null = null;
  private bgLabel = '';
  private bgW = 0;
  private bgH = 0;
  private tint: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private tintTex: THREE.CanvasTexture | null = null;
  private readonly tintTarget = new THREE.Color(0x9ca3af);
  private grid: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private gridTex: THREE.CanvasTexture | null = null;

  // The player's combatant.
  private character: Character | null = null;
  private anim: CharacterAnimator | null = null;
  private hat: WornHat | null = null;
  private gear: GearLike | null = null;
  private baseYaw = 0; // view-dependent turn (back view shows the rear 3/4)
  private baseYawTarget = 0;
  private emoteGun: AttachedRailgun | null = null;
  private emoteGunFinish = '';
  // Finisher dummy (lazy).
  private dummy: Character | null = null;
  private dummyAnim: CharacterAnimator | null = null;
  // Weapon close-up (lazy).
  private gunPivot = new THREE.Group();
  private gun: RailgunModel | null = null;
  private gunFinish = '';

  private raf: number | null = null;
  private last = 0;
  private t = 0;
  private disposed = false;
  private readonly lowSpec: boolean;
  private cos: PreviewCosmetics;
  private view: PreviewView;

  // Camera framing state (eased toward FRAMES[view]).
  private cam: Framing;
  private readonly frameTmp: Framing = { tx: 0, ty: 0, tz: 0, dist: 1, elev: 0, fov: 30 };
  private hatTopY = 1.8;
  private offsetX = 0; // fractional screen-space shift of the subject (+ = right)
  private offsetY = 0;

  // Orbit.
  private yaw = 0;
  private yawVel = 0;
  private dragging = false;
  private dragX = 0;
  private dragT = 0;
  private sinceDrag = 99;
  private swayW = 1; // idle-sway blend weight
  private orbitOff: (() => void) | null = null;

  // Loops.
  private loopT = 0;
  private finisherPhase: 'idle' | 'dead' = 'idle';
  private spawnFired = false;
  private fireTimer = 0.7;
  private lastShot = -99;
  private gunKick = 0;

  // DOM anchor (nameplate) positioned above the head each frame.
  private anchorEl: HTMLElement | null = null;
  private anchorVisible = false;

  constructor(
    private canvas: HTMLCanvasElement,
    cos: PreviewCosmetics,
    opts: PreviewOptions = {},
  ) {
    this.cos = cos;
    this.view = cos.view;
    this.lowSpec = !!opts.lowSpec;
    this.cam = { ...FRAMES[cos.view] };
    // OPAQUE on purpose: the game's FX (additive beams, pooled glow sprites,
    // unusual particles) write alpha across their whole quads. On a
    // transparent canvas those dark quad corners composite as opaque black
    // squares over the page, so the backdrop (gradient, rarity tint, floor
    // grid, slot watermark) is drawn here in WebGL instead of in CSS.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !opts.lowSpec,
      alpha: false,
    });
    this.renderer.setPixelRatio(opts.lowSpec ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(BG_BOTTOM, 1);
    // The combatant's PBR armour wants tone mapping + an environment to reflect.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.scene.add(this.camera); // hosts the screen-space rarity tint
    this.buildBackdrop();

    // Studio lighting: warm key, cool rim from behind, soft front fill.
    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x202028, 1.05));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.9);
    key.position.set(2.5, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9bb6ff, 1.35);
    rim.position.set(-3, 4, -4);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.45);
    fill.position.set(0, 1.2, 6);
    this.scene.add(fill);

    this.floorTex = floorTexture();
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 48),
      new THREE.MeshBasicMaterial({
        map: this.floorTex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0.002;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    this.subject.rotation.y = FACE_CAMERA;
    this.scene.add(this.subject);
    this.gunPivot.position.set(0, 1.02, 0);
    this.scene.add(this.gunPivot);
    this.effects.warm(this.scene);

    this.buildCharacter();
    this.applyView(true);
    this.resize();
  }

  // ── Backdrop ───────────────────────────────────────────────────────────────

  private buildBackdrop() {
    if (typeof document === 'undefined') return;
    this.bgCanvas = document.createElement('canvas');
    this.bgTex = new THREE.CanvasTexture(this.bgCanvas);
    this.bgTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.bgTex;
    // Rarity tint: a soft radial pool, camera-attached so it follows the
    // framing (and the screen offset) — eased colour, no texture uploads.
    this.tintTex = radialTexture();
    this.tint = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.tintTex,
        color: this.tintTarget.clone(),
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.tint.renderOrder = -10;
    this.tint.frustumCulled = false;
    this.tint.position.z = -40;
    this.camera.add(this.tint);
    // Floor grid receding to the horizon (was a CSS perspective fake).
    this.gridTex = gridTexture();
    if (this.gridTex) {
      this.grid = new THREE.Mesh(
        new THREE.CircleGeometry(9, 64),
        new THREE.MeshBasicMaterial({ map: this.gridTex, transparent: true, depthWrite: false, toneMapped: false }),
      );
      this.grid.rotation.x = -Math.PI / 2;
      this.grid.renderOrder = -2;
      this.scene.add(this.grid);
    }
    // The watermark font may still be loading; redraw once it lands.
    try {
      void document.fonts?.load('700 100px "Chakra Petch"').then(() => this.drawBackdrop(true));
    } catch {
      /* no font loading API */
    }
  }

  // Rarity tint colour + the giant outlined slot name behind the subject.
  setBackdrop(opts: { tint?: string; label?: string | null }) {
    if (opts.tint) this.tintTarget.set(opts.tint);
    if (opts.label !== undefined && (opts.label ?? '') !== this.bgLabel) {
      this.bgLabel = opts.label ?? '';
      this.drawBackdrop(true);
    }
  }

  private drawBackdrop(force = false) {
    const cv = this.bgCanvas;
    if (!cv || !this.bgTex) return;
    const dpr = Math.min(2, this.renderer.getPixelRatio());
    const cw = this.canvas.clientWidth || 320;
    const ch = this.canvas.clientHeight || 240;
    const W = Math.max(2, Math.round(cw * dpr));
    const H = Math.max(2, Math.round(ch * dpr));
    if (!force && W === this.bgW && H === this.bgH) return;
    if (W !== this.bgW || H !== this.bgH) {
      // A texture's GPU storage is immutable once uploaded: a new size needs a
      // new texture (re-uploading a resized canvas into the old storage
      // garbles it — the old watermark bleeding through).
      this.bgTex.dispose();
      this.bgTex = new THREE.CanvasTexture(cv);
      this.bgTex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = this.bgTex;
    }
    this.bgW = W;
    this.bgH = H;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0c1119');
    g.addColorStop(0.62, '#080b10');
    g.addColorStop(1, '#06080b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Pool of cool light where the subject stands.
    const r = ctx.createRadialGradient(W * 0.58, H * 0.88, 0, W * 0.58, H * 0.88, Math.max(W, H) * 0.55);
    r.addColorStop(0, 'rgba(120,160,210,0.12)');
    r.addColorStop(1, 'rgba(120,160,210,0)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, W, H);
    if (this.bgLabel) {
      const label = this.bgLabel.toUpperCase();
      const narrow = cw < 600;
      const size = Math.min(140, (0.88 * cw) / (Math.max(4, label.length) * 0.66)) * dpr;
      ctx.font = `700 ${size.toFixed(1)}px "Chakra Petch", "Geist", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.strokeText(label, 18 * dpr, (narrow ? 16 : 44) * dpr);
    }
    this.bgTex.needsUpdate = true;
  }

  private fitTint() {
    if (!this.tint) return;
    // Cover ~90% × 100% of the view at the tint's depth.
    const h = 2 * 40 * Math.tan((this.camera.fov * Math.PI) / 360);
    this.tint.scale.set(h * (this.camera.aspect || 1) * 0.95, h * 1.05, 1);
    this.tint.position.y = -h * 0.04;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  // The armour: your name-keyed skin, or the worn dye over it. The preview is
  // always the natural look (no team colour / enemy highlight here).
  private skinKey = '';
  private applySkin() {
    const ch = this.character;
    if (!ch) return;
    const skin = skinColorFor(this.cos.skinSeed || savedName() || 'you');
    const dyeId = this.cos.looks?.dye?.d ?? '';
    const key = `${skin}|${dyeId}`;
    if (key === this.skinKey) return;
    this.skinKey = key;
    ch.wearDye(dyeById(dyeId), skin);
  }

  private buildCharacter() {
    const ch = new Character({ colorHex: skinColorFor(this.cos.skinSeed || savedName() || 'you') });
    this.character = ch;
    this.applySkin();
    this.subject.add(ch.root);
    this.anim = new CharacterAnimator(ch, { driveYaw: false, holdGun: false });
    this.hat = new WornHat(ch.sockets.headTop);
    if (WornGearCtor) {
      // Wearable builders own hat / face / back (and the unusual on the hat).
      this.gear = new WornGearCtor(ch);
      this.syncGear(undefined);
    } else {
      void this.hat.setHat(this.cos.hatId).then(() => this.measureHat());
      this.hat.setUnusual(this.cos.unusualId);
    }
  }

  private syncGear(prev: PreviewCosmetics | undefined) {
    const g = this.gear;
    if (!g) return;
    for (const slot of ['hat', 'face', 'back'] as const) {
      const now = this.cos.looks?.[slot];
      const before = prev?.looks?.[slot];
      if (prev && (now ? lookKey(now) : '') === (before ? lookKey(before) : '')) continue;
      g.setLook(slot, now ?? null);
    }
    this.measureHat();
  }

  private ensureDummy() {
    if (this.dummy) return;
    const mine = skinColorFor(this.cos.skinSeed || savedName() || 'you');
    // A contrasting "training bot" skin.
    const skin = mine === '#ff6873' || mine === '#ff6b4e' ? SKIN_PALETTE[4] : '#ff6873';
    const d = new Character({ colorHex: skin });
    this.dummy = d;
    this.subject.add(d.root);
    this.dummyAnim = new CharacterAnimator(d, { driveYaw: false, holdGun: false });
    this.dummyAnim.playEmote('idle');
  }

  private ensureGun() {
    const finish = railgunFinishById(this.cos.railgunFinish).data;
    if (this.gun) {
      if (this.gunFinish === this.cos.railgunFinish) return;
      // Same model → recolour in place (uniforms). A different custom model
      // (Wyrmfang, Reaper… — finish.model) changes the gun's SHAPE, which
      // setFinish can't do: rebuild it.
      if ((this.gun.modelKey ?? null) === (customGun(finish.model) ? (finish.model ?? null) : null)) {
        this.gun.setFinish(finish);
        this.gunFinish = this.cos.railgunFinish;
        return;
      }
      const visible = this.gunPivot.visible;
      this.disposeGun();
      this.gunPivot.visible = visible;
    }
    const g = buildRailgun(finish);
    this.gun = g;
    this.gunFinish = this.cos.railgunFinish;
    g.setLowSpec(this.lowSpec);
    // Centre the ~1.33 m gun on the pivot (grip origin sits ~0.23 m behind centre).
    g.group.position.set(0, 0, 0.23);
    this.gunPivot.add(g.group);
    g.setCharge(1);
  }

  private disposeGun() {
    if (!this.gun) return;
    // The gun's geometry is a shared cache: dispose() frees only its own
    // materials — never traverse-and-dispose it.
    this.gun.dispose();
    this.gun.group.removeFromParent();
    this.gun = null;
    this.gunFinish = '';
  }

  // The emote wants the railgun in hand (flourish) → attach/detach/reskin it.
  private syncEmoteGun(kind: EmoteKind | null) {
    if (!this.character) return;
    const wants = kind === 'flourish';
    if (wants && !this.emoteGun) {
      this.emoteGun = attachRailgun(this.character, railgunFinishById(this.cos.railgunFinish).data);
      this.emoteGunFinish = this.cos.railgunFinish;
    } else if (wants && this.emoteGun && this.emoteGunFinish !== this.cos.railgunFinish) {
      this.emoteGun.setFinish(railgunFinishById(this.cos.railgunFinish).data);
      this.emoteGunFinish = this.cos.railgunFinish;
    } else if (!wants && this.emoteGun) {
      disposeRailgun(this.emoteGun);
      this.emoteGun = null;
      this.emoteGunFinish = '';
    }
  }

  // ── View switching ─────────────────────────────────────────────────────────

  private applyView(first = false) {
    const v = this.view;
    const weapon = v === 'weapon';
    const finisher = v === 'finisher';
    if (this.character) this.character.root.visible = !weapon && !finisher;
    if (this.floor) this.floor.visible = !weapon;
    if (this.grid) this.grid.visible = !weapon;
    if (finisher) {
      this.ensureDummy();
      this.dummy!.root.visible = true;
      this.dummyAnim!.respawn();
      this.dummyAnim!.playEmote('idle', true);
      this.finisherPhase = 'idle';
    } else if (this.dummy) {
      this.dummyAnim?.respawn();
      this.dummy.root.visible = false;
    }
    if (weapon) {
      this.ensureGun();
      this.gunPivot.visible = true;
      this.fireTimer = 0.45;
    } else {
      this.gunPivot.visible = false;
    }
    // Character animation for the view.
    const kind: EmoteKind = v === 'emote' ? emoteById(this.cos.emoteId).kind : 'idle';
    this.anim?.playEmote(kind, v === 'emote');
    this.syncEmoteGun(v === 'emote' ? kind : null);
    if (this.character && !finisher && !weapon) {
      // Leaving the spawn loop mid-burst must never strand a hidden body.
      this.character.root.visible = true;
      this.character.root.scale.setScalar(1);
    }
    this.loopT = 0;
    this.spawnFired = false;
    this.baseYawTarget = v === 'back' ? -2.55 : 0; // rear 3/4 (subject faces +Z after FACE_CAMERA)
    if (first) this.baseYaw = this.baseYawTarget;
    // Each new framing starts facing the camera; the subject spin resets.
    if (!first) {
      this.yaw = 0;
      this.yawVel = 0;
      this.sinceDrag = 99;
    }
    if (first || this.cos.reducedEffects) this.cam = { ...this.framing() };
    this.setAnchorVisible(this.anchorVisible);
  }

  setCosmetics(cos: PreviewCosmetics) {
    const prev = this.cos;
    this.cos = cos;
    if (cos.view !== this.view) {
      this.view = cos.view;
      // Changing the finish while switching → the view build picks it up.
      this.applyView();
    }
    this.applySkin();
    if (this.gear) this.syncGear(prev);
    else if (this.hat) {
      if (cos.hatId !== prev.hatId) void this.hat.setHat(cos.hatId).then(() => this.measureHat());
      if (cos.unusualId !== prev.unusualId) this.hat.setUnusual(cos.unusualId);
    }
    if (cos.emoteId !== prev.emoteId && this.view === 'emote') {
      const kind = emoteById(cos.emoteId).kind;
      this.anim?.playEmote(kind, true);
      this.syncEmoteGun(kind);
    }
    if (cos.railgunFinish !== prev.railgunFinish) {
      // The bug this fixes: a finish change used to leave the old gun on show.
      if (this.gun) this.ensureGun(); // recolour in place (kept while hidden)
      if (this.view === 'weapon') this.fireTimer = Math.min(this.fireTimer, 0.35); // show it off right away
      if (this.view === 'emote') this.syncEmoteGun(emoteById(cos.emoteId).kind);
    }
    if (this.view === 'finisher' && cos.killEffect !== prev.killEffect) {
      // Replay the loop so the new finisher shows right away.
      this.dummyAnim?.respawn();
      this.dummyAnim?.playEmote('idle', true);
      this.finisherPhase = 'idle';
      this.loopT = FINISHER_IDLE * 0.55;
    }
    if (this.view === 'spawn' && cos.spawnEffect !== prev.spawnEffect) {
      this.loopT = SPAWN_PERIOD;
    }
    if (this.view === 'weapon' && cos.railColor !== prev.railColor) this.fireTimer = Math.min(this.fireTimer, 0.25);
  }

  // Shift the subject in screen space (fractions of the canvas size; +x moves
  // it right, +y down) — used to clear room for overlaid UI.
  setScreenOffset(fx: number, fy = 0) {
    this.offsetX = fx;
    this.offsetY = fy;
    this.updateProjection();
  }

  // A DOM element (the nameplate) kept above the combatant's head. Only shown
  // in the full / identity / head framings.
  setAnchor(el: HTMLElement | null) {
    this.anchorEl = el;
    this.setAnchorVisible(this.anchorVisible);
  }

  setAnchorVisible(on: boolean) {
    this.anchorVisible = on;
    if (this.anchorEl) this.anchorEl.style.visibility = on && this.anchorAllowed() ? 'visible' : 'hidden';
  }

  private anchorAllowed() {
    return this.view === 'identity' || this.view === 'full' || this.view === 'head' || this.view === 'crown' || this.view === 'character' || this.view === 'face';
  }

  // Equip / unlock flourish: a spawn ring at the combatant's feet.
  celebrate() {
    if (this.cos.reducedEffects || this.disposed) return;
    if (this.view === 'weapon') {
      this.fireTimer = 0;
      return;
    }
    this.effects.spawnInBurst(this.scene, _v.set(0, 0, 0), 'ring');
  }

  // Restart the current loop (finisher / spawn / emote / weapon shot).
  replay() {
    if (this.view === 'finisher') {
      this.dummyAnim?.respawn();
      this.dummyAnim?.playEmote('idle', true);
      this.finisherPhase = 'idle';
      this.loopT = FINISHER_IDLE * 0.6;
    } else if (this.view === 'spawn') this.loopT = SPAWN_PERIOD;
    else if (this.view === 'emote') this.anim?.playEmote(emoteById(this.cos.emoteId).kind, true);
    else if (this.view === 'weapon') this.fireTimer = 0;
  }

  // ── Orbit (drag to spin, with inertia) ─────────────────────────────────────

  enableOrbit(el: HTMLElement = this.canvas) {
    this.orbitOff?.();
    el.style.touchAction = 'pan-y';
    el.style.cursor = 'grab';
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragX = e.clientX;
      this.dragT = performance.now();
      this.yawVel = 0;
      el.style.cursor = 'grabbing';
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported */
      }
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      const now = performance.now();
      const dx = e.clientX - this.dragX;
      const dt = Math.max(1, now - this.dragT) / 1000;
      this.dragX = e.clientX;
      this.dragT = now;
      const d = dx * DRAG_RATE;
      this.yaw += d;
      // Release velocity, smoothed so a jittery last sample can't fling it.
      const k = 1 - Math.exp(-18 * dt);
      this.yawVel += (d / dt - this.yawVel) * k;
      this.sinceDrag = 0;
    };
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      el.style.cursor = 'grab';
      // A pause before letting go kills the fling.
      if (performance.now() - this.dragT > 90) this.yawVel = 0;
      this.yawVel = Math.max(-9, Math.min(9, this.yawVel));
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.orbitOff = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.style.cursor = '';
    };
  }

  // Nudge the spin (keyboard: ← / → on the stage).
  spin(radians: number) {
    this.yawVel += radians * SPIN_DECAY;
    this.sinceDrag = 0;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  resize() {
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 240;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.updateProjection();
    this.drawBackdrop();
  }

  private updateProjection() {
    this.fitTint();
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 240;
    if (this.offsetX || this.offsetY) {
      this.camera.setViewOffset(w, h, -this.offsetX * w, -this.offsetY * h, w, h);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  // Head framings follow the worn hat: the head sits ~38% from the top of a
  // head-and-shoulders window; a tall hat (or an unusual's plume) pushes the
  // window's top up instead of being cropped.
  private framing(): Framing {
    const f = FRAMES[this.view];
    if (this.view !== 'head' && this.view !== 'crown') return f;
    const tan = Math.tan((f.fov * Math.PI) / 360);
    const win = this.view === 'head' ? 1.1 : 1.3;
    const head = 1.65;
    const top = this.view === 'head' ? Math.max(head + 0.38 * win, this.hatTopY + 0.1) : Math.max(head + 0.5 * win, this.hatTopY + 0.42);
    this.frameTmp.tx = f.tx;
    this.frameTmp.tz = f.tz;
    this.frameTmp.ty = top - win / 2;
    this.frameTmp.dist = win / 2 / tan;
    this.frameTmp.elev = f.elev;
    this.frameTmp.fov = f.fov;
    return this.frameTmp;
  }

  // World height of the worn hat's top (bare helmet: the crest).
  private measureHat() {
    if (this.gear) {
      const y = this.gear.headTopY();
      this.hatTopY = y > 1.5 ? Math.min(2.6, y) : 1.8;
      return;
    }
    const socket = this.character?.sockets.headTop;
    if (!socket || this.disposed) return;
    socket.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    // Hat meshes only — the unusual (world-space particles, ribbons) is skipped.
    const visit = (o: THREE.Object3D) => {
      if (o.name === 'unusual') return;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        if (m.geometry.boundingBox) box.union(tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
      }
      for (const c of o.children) visit(c);
    };
    for (const child of socket.children) visit(child);
    this.hatTopY = !box.isEmpty() && box.max.y > 1.5 ? Math.min(2.6, box.max.y) : 1.8;
  }

  private stepCamera(dt: number) {
    const f = this.framing();
    const c = this.cam;
    const k = this.cos.reducedEffects ? 1 : 1 - Math.exp(-CAM_EASE * dt);
    c.tx += (f.tx - c.tx) * k;
    c.ty += (f.ty - c.ty) * k;
    c.tz += (f.tz - c.tz) * k;
    c.dist += (f.dist - c.dist) * k;
    c.elev += (f.elev - c.elev) * k;
    c.fov += (f.fov - c.fov) * k;
    // Tall, narrow stages (phones) widen the vertical FOV a touch so the
    // full-body framings never clip at the shoulders.
    const aspect = this.camera.aspect || 1;
    const fov = aspect < 0.62 ? c.fov * (1 + (0.62 - aspect) * 0.6) : c.fov;
    this.camera.position.set(c.tx, c.ty + c.elev, c.tz + c.dist);
    this.camera.lookAt(c.tx, c.ty, c.tz);
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.updateProjection();
    }
  }

  private stepOrbit(dt: number) {
    this.sinceDrag += dt;
    if (!this.dragging) {
      this.yaw += this.yawVel * dt;
      this.yawVel *= Math.exp(-SPIN_DECAY * dt);
      if (Math.abs(this.yawVel) < 0.01) this.yawVel = 0;
    }
    // A gentle showcase sway returns once the player leaves it alone.
    const swayTarget = this.dragging || this.sinceDrag < IDLE_SWAY_AFTER ? 0 : 1;
    this.swayW += (swayTarget - this.swayW) * (1 - Math.exp(-1.2 * dt));
    const amp = this.view === 'character' ? 0.7 : this.view === 'head' || this.view === 'crown' ? 0.42 : this.view === 'weapon' ? 0.3 : 0.2;
    const sway = this.cos.reducedEffects ? 0 : Math.sin(this.t * 0.5) * amp * this.swayW;
    this.baseYaw += (this.baseYawTarget - this.baseYaw) * (this.cos.reducedEffects ? 1 : 1 - Math.exp(-5 * dt));
    this.subject.rotation.y = FACE_CAMERA + this.baseYaw + this.yaw + sway;
    // The gun points its barrel to screen-right and a little into depth.
    this.gunPivot.rotation.set(0.06, -0.58 + this.yaw + sway, 0.03);
  }

  // Pause the render loop (the canvas stays mounted, e.g. hidden behind a 2D
  // reward in the Career Road); start() resumes it.
  stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.last = 0;
  }

  start() {
    if (this.raf !== null) return;
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.last ? Math.min(0.05, now - this.last) : 0;
      this.last = now;
      this.t += dt;
      this.step(dt);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private step(dt: number) {
    this.stepCamera(dt);
    if (this.tint) {
      const k = this.cos.reducedEffects ? 1 : 1 - Math.exp(-5 * dt);
      this.tint.material.color.lerp(this.tintTarget, k);
    }
    this.stepOrbit(dt);
    this.loopT += dt;
    const slow = this.cos.reducedEffects ? 1.6 : 1;
    if (this.view === 'finisher') this.stepFinisher(dt, slow);
    else if (this.view === 'spawn') this.stepSpawn(slow);
    else if (this.view === 'weapon') this.stepWeapon(dt, slow);
    if (this.view !== 'weapon' && this.view !== 'finisher') this.anim?.updateStatic(dt);
    this.hat?.update(dt);
    this.gear?.update(dt);
    if (this.dummy?.root.visible) this.dummyAnim?.updateStatic(dt);
    this.effects.step(dt, this.scene);
    this.placeAnchor();
  }

  private stepFinisher(_dt: number, slow: number) {
    if (!this.dummyAnim) return;
    if (this.finisherPhase === 'idle' && this.loopT >= FINISHER_IDLE * slow) {
      // The killing rail: from off-screen front-left into the dummy's chest,
      // angled into depth so the helix reads as a helix (side-on it
      // flattens into a sine wave).
      const rc = railColorById(this.cos.railColor).data;
      const start = _v.set(-6.5, 1.75, 4.8);
      const hit = _v2.set(0, 1.22, 0);
      getFxContext(this.scene).beams.spawn(start, hit, rc.core, rc.helix, false, { mode: railColorById(this.cos.railColor).mode, impact: true });
      // As in-game: the burst (in the victim's colour), then the death.
      if (this.cos.reducedEffects) this.effects.spawnHitFlash(this.scene, CHEST, 0x9be8ff);
      else this.effects.spawnKillBurst(this.scene, CHEST, false, this.cos.killEffect, this.dummy?.getColor(new THREE.Color()) ?? null);
      this.dummyAnim.die({ y: 0 }, this.cos.killEffect);
      this.finisherPhase = 'dead';
      this.loopT = 0;
    } else if (this.finisherPhase === 'dead' && this.loopT >= FINISHER_DEAD * slow) {
      this.dummyAnim.respawn();
      this.dummyAnim.playEmote('idle', true);
      this.finisherPhase = 'idle';
      this.loopT = 0;
    }
  }

  private stepSpawn(slow: number) {
    const ch = this.character;
    if (!ch) return;
    if (this.loopT >= SPAWN_PERIOD * slow) {
      this.loopT = 0;
      this.spawnFired = false;
    }
    // Gone at the top of the loop; the burst flares, then the body
    // materialises (a quick vertical scale-in) inside it.
    if (!this.spawnFired && this.loopT >= 0.12) {
      this.effects.spawnInBurst(this.scene, _v.set(0, 0, 0), spawnEffectById(this.cos.spawnEffect ?? 'spawn.beam').style);
      this.spawnFired = true;
    }
    const u = Math.max(0, Math.min(1, (this.loopT - 0.2) / 0.22));
    ch.root.visible = u > 0;
    ch.root.scale.set(1, u >= 1 ? 1 : 0.15 + 0.85 * (u * u * (3 - 2 * u)), 1);
  }

  private stepWeapon(dt: number, slow: number) {
    const g = this.gun;
    if (!g) return;
    this.fireTimer -= dt;
    // Coils: dark after the shot, refilling front to back over the cooldown.
    g.setCharge(Math.min(1, (this.t - this.lastShot) / RAIL_COOLDOWN));
    if (this.fireTimer <= 0) {
      this.fireTimer = FIRE_PERIOD * slow;
      this.lastShot = this.t;
      g.notifyFire();
      g.setCharge(0);
      this.gunKick = 1;
      const rc = railColorById(this.cos.railColor).data;
      this.gunPivot.updateMatrixWorld(true);
      const muzzle = g.muzzle.getWorldPosition(new THREE.Vector3());
      const dir = _v.set(0, 0, -1).applyQuaternion(g.muzzle.getWorldQuaternion(_q)).normalize();
      const end = _v2.copy(muzzle).addScaledVector(dir, 16);
      getFxContext(this.scene).beams.spawn(muzzle, end, rc.core, rc.helix, false, { mode: railColorById(this.cos.railColor).mode });
      this.effects.spawnMuzzleFlash(this.scene, muzzle, rc.core, dir);
      g.glow.emissiveIntensity = 4;
    }
    // Recoil + glow ease back (frame-rate independent).
    this.gunKick *= Math.exp(-9 * dt);
    g.group.position.z = 0.23 + this.gunKick * 0.06;
    g.group.rotation.x = this.gunKick * 0.05;
    g.glow.emissiveIntensity += (0.8 - g.glow.emissiveIntensity) * (1 - Math.exp(-5 * dt));
    g.group.position.y = Math.sin(this.t * 0.9) * 0.012;
  }

  // Project the head (plus clearance for a hat/unusual) to canvas pixels.
  private placeAnchor() {
    const el = this.anchorEl;
    const ch = this.character;
    if (!el || !this.anchorVisible || !ch || !this.anchorAllowed()) return;
    ch.sockets.headTop.getWorldPosition(_v);
    _v.y += 0.36;
    _v.project(this.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const x = (_v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.orbitOff?.();
    this.orbitOff = null;
    this.hat?.dispose();
    this.gear?.dispose();
    disposeRailgun(this.emoteGun);
    this.emoteGun = null;
    this.anim?.dispose();
    this.character?.dispose();
    this.dummyAnim?.dispose();
    this.dummy?.dispose();
    this.disposeGun();
    this.effects.dispose(this.scene);
    this.envTex?.dispose();
    this.floor?.geometry.dispose();
    this.floor?.material.dispose();
    this.floorTex?.dispose();
    this.grid?.geometry.dispose();
    this.grid?.material.dispose();
    this.gridTex?.dispose();
    this.tint?.geometry.dispose();
    this.tint?.material.dispose();
    this.tintTex?.dispose();
    this.bgTex?.dispose();
    this.scene.background = null;
    // The combatant + hat clones share CACHED geometry, so those are not freed
    // here (see Character.dispose / WornHat). The shared caches hold a
    // 'dispose' listener per renderer that drew them, which keeps this
    // context (and its GPU memory) reachable — so in production force the
    // context loss, like Game.dispose (dev Fast Refresh reuses the canvas, and
    // a force-lost context can't be re-acquired).
    this.renderer.dispose();
    if (import.meta.env.PROD) this.renderer.forceContextLoss();
    this.anchorEl = null;
  }
}
