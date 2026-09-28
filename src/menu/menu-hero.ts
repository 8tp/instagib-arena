// The menu hero: YOUR combatant, standing on a spawn pad beside the menu
// column in your loadout (hat + unusual, railgun finish in hand, skin colour
// from your name), idling at the low ready with the equipped emote every
// 20–30 s. The Fortnite / Valorant lobby pattern.
//
// Not a renderer of its own: MenuBackdrop draws this scene as a second pass
// into the SAME frame as the arena (depth cleared, before bloom/vignette), so
// the visor and pad glow bloom like everything else and there is one WebGL
// context. The camera frames the character into a DOM rect the lobby lays
// out (setFrame), via a view offset — the layout decides where the hero
// stands, the 3D just fills it.
//
// Built from the game's own pieces (Character / CharacterAnimator / WornHat /
// attachRailgun). Motion is dt-based (frame-rate independent); a still frame
// is just update(0) + one render. Everything created here is disposed here —
// the body geometry and hat sources are shared caches and are left alone.

import * as THREE from 'three';
import { CharacterAnimator } from '../game/character-anim';
import { Character, skinColorFor } from '../game/character/character';
import { attachRailgun, disposeRailgun } from '../game/character/gun';
import { emoteById, railgunFinishById } from '../game/cosmetics';
import { emoteClip } from '../game/emotes';
import { WornHat } from '../game/hats';
import { B } from '../game/character/rig';
import { unusualKindOf } from '../game/wearables';
import type { Loadout } from '../game/items/types';

export type HeroLoadout = {
  seed: string; // player name → armour colour (same pick every other view makes)
  hat: string;
  unusual: string;
  railgunFinish: string;
  emote: string;
  looks?: Loadout; // v3: hat/face/back + unusual + tint/festive (overrides hat/unusual)
};

// Where the hero stands: a rect in canvas CSS pixels plus the canvas size.
export type HeroFrame = { x: number; y: number; w: number; h: number; vw: number; vh: number };

export function sameLoadout(a: HeroLoadout | null, b: HeroLoadout | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.seed === b.seed &&
    a.hat === b.hat &&
    a.unusual === b.unusual &&
    a.railgunFinish === b.railgunFinish &&
    a.emote === b.emote &&
    JSON.stringify(a.looks ?? null) === JSON.stringify(b.looks ?? null)
  );
}

const FACE_CAMERA = Math.PI; // the combatant faces −Z; turn it to the +Z camera
const REST_YAW = -0.36; // 3/4 turn toward the menu column
const AIM_PITCH = -0.5; // low ready: the muzzle rests toward the floor ahead
const SPAN_BOTTOM = -0.2; // metres framed below the feet (the pad's lip)
const SPAN_TOP = 2.62; // …and above them (hat, unusual and emote headroom)
const FOV = 19; // long lens: flattering, little perspective stretch
const SPAWN_SECONDS = 1.1; // materialise-in on first show
const FIRST_EMOTE_S = 5.5;
const EMOTE_GAP_MIN = 20;
const EMOTE_GAP_MAX = 30;
const RIM = 2.4;
const HERO_HEIGHT = 0.7; // the combatant stands ~70% of the viewport tall
const BODY_M = 1.9; // helmet-crown height in metres (what HERO_HEIGHT measures)
const FOOT_REST_Y = 0.095; // planted ankle height (rig rest)
const HOVER_HZ = 7;

const ORIGIN = new THREE.Vector3();
const RIM_COLOR = new THREE.Color(0xc9f4ff);

// Soft radial falloff (white → transparent) for the pad glow + contact shadow.
function radialTexture(stops: [number, number][]): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class MenuHero {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  // Called when something changed outside the update loop (a hat finished
  // loading) so a paused / still backdrop can redraw one frame.
  onDirty: (() => void) | null = null;

  private readonly holder = new THREE.Group(); // yaw + entrance lift
  private readonly character: Character;
  private readonly anim: CharacterAnimator;
  private readonly hat: WornHat;
  private gun: THREE.Group | null = null;
  private loadout: HeroLoadout;
  private readonly color = new THREE.Color();
  private readonly rim: THREE.DirectionalLight;
  private readonly back: THREE.DirectionalLight;
  private readonly shadow: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly owned: { geo: THREE.BufferGeometry[]; mat: THREE.Material[]; tex: THREE.Texture[] } = {
    geo: [],
    mat: [],
    tex: [],
  };
  private frame: HeroFrame | null = null;
  private t = 0;
  private spawn = 0; // 0 → 1 materialise
  private hover = 0;
  private hoverTarget = 0;
  private emoteTimer = FIRST_EMOTE_S;
  private emoteLeft = 0;
  private emoteGun = false; // the playing clip carries the railgun itself
  private gunVisibleIn = -1; // seconds until the gun toggles (−1 = idle)
  private gunVisibleTo = true;
  private disposed = false;

  constructor(loadout: HeroLoadout, env: THREE.Texture | null, opts: { still?: boolean } = {}) {
    this.loadout = { ...loadout };
    this.color.set(skinColorFor(loadout.seed || 'you'));
    const scene = this.scene;
    scene.environment = env; // the arena's PMREM room (owned + freed by the stage)
    scene.environmentIntensity = 0.16;

    // Lighting: a warm key from camera-left, a cool fill, and a hard rim in
    // YOUR colour from behind — the silhouette reads against any arena.
    scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x15171c, 0.22));
    const key = new THREE.DirectionalLight(0xfff0dc, 1.0);
    key.position.set(-4.6, 3.8, 2.6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb0ff, 0.14);
    fill.position.set(3.5, 1.2, 3);
    scene.add(fill);
    this.rim = new THREE.DirectionalLight(this.color, RIM);
    this.rim.position.set(2.8, 1.3, -5);
    scene.add(this.rim);
    this.back = new THREE.DirectionalLight(this.color, RIM * 0.6);
    this.back.position.set(-3, 1.6, -5);
    scene.add(this.back);

    // A dark vignette behind the body (camera-facing, in the scene — not the
    // turning holder): quiets the arena right behind the hero (neon trims,
    // bright floors) so the silhouette cuts out, Valorant-style.
    const haloTex = radialTexture([
      [0, 0.92],
      [0.5, 0.7],
      [0.82, 0.22],
      [1, 0],
    ]);
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x02040a,
      map: haloTex,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    const haloGeo = new THREE.PlaneGeometry(5.6, 5.2);
    const halo = new THREE.Mesh(haloGeo, this.haloMat);
    halo.position.set(0, 1.05, -1.4);
    halo.renderOrder = -2;
    scene.add(halo);

    // The spawn pad: a dark machined disc, a glowing lip in your colour, and a
    // light pool + contact shadow under the boots.
    const padGeo = new THREE.CylinderGeometry(0.66, 0.72, 0.08, 72, 1);
    const padMat = new THREE.MeshStandardMaterial({ color: 0x0c0f15, metalness: 0.6, roughness: 0.55 });
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.y = -0.04;
    scene.add(pad);
    const ringGeo = new THREE.RingGeometry(0.6, 0.64, 96);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    scene.add(ring);
    const poolTex = radialTexture([
      [0, 0.0],
      [0.55, 0.12],
      [0.86, 0.55],
      [1, 0],
    ]);
    this.poolMat = new THREE.MeshBasicMaterial({
      color: this.color,
      map: poolTex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const poolGeo = new THREE.CircleGeometry(0.62, 64);
    const pool = new THREE.Mesh(poolGeo, this.poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.003;
    scene.add(pool);
    const shadowTex = radialTexture([
      [0, 0.75],
      [0.5, 0.4],
      [1, 0],
    ]);
    const shadowMat = (this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: shadowTex,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }));
    const shadowGeo = new THREE.CircleGeometry(0.46, 48);
    const shadow = (this.shadow = new THREE.Mesh(shadowGeo, shadowMat));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.004;
    scene.add(shadow);
    this.owned.geo.push(haloGeo, padGeo, ringGeo, poolGeo, shadowGeo);
    this.owned.mat.push(this.haloMat, padMat, this.ringMat, this.poolMat, shadowMat);
    for (const t of [haloTex, poolTex, shadowTex]) if (t) this.owned.tex.push(t);

    // The combatant.
    this.character = new Character({ colorHex: `#${this.color.getHexString()}`, castShadow: false });
    this.holder.add(this.character.root);
    this.holder.rotation.y = FACE_CAMERA + REST_YAW;
    scene.add(this.holder);
    this.anim = new CharacterAnimator(this.character, { driveYaw: false, holdGun: true });
    this.hat = new WornHat(this.character.sockets.headTop);
    if (!this.applyLooks(loadout.looks)) {
      void this.hat.setHat(loadout.hat).then(() => this.onDirty?.());
      this.hat.setUnusual(loadout.unusual);
    }
    this.gun = attachRailgun(this.character, railgunFinishById(loadout.railgunFinish).data);
    this.applyColor();

    if (opts.still) {
      // One settled idle pose: no entrance, no emote.
      this.spawn = 1;
      this.emoteTimer = Infinity;
      for (let i = 0; i < 8; i++) this.anim.update({ dt: 0.1, yaw: 0, pitch: AIM_PITCH, pos: ORIGIN });
    } else {
      this.character.setGlow(1.4, this.color);
    }
  }

  get visible(): boolean {
    const f = this.frame;
    return !!f && f.w > 1 && f.h > 1;
  }

  // v3 looks → the gear (hat + face + back + unusual). False = no looks/gear.
  private applyLooks(looks: Loadout | undefined): boolean {
    const gear = this.hat.gear;
    if (!looks || !gear) return false;
    gear.setLook('hat', looks.hat ?? null);
    gear.setLook('face', looks.face ?? null);
    gear.setLook('back', looks.back ?? null);
    gear.setUnusual(unusualKindOf(looks.hat ?? null));
    return true;
  }

  setLoadout(l: HeroLoadout) {
    if (this.disposed || sameLoadout(this.loadout, l)) return;
    const prev = this.loadout;
    this.loadout = { ...l };
    if (l.seed !== prev.seed) {
      this.color.set(skinColorFor(l.seed || 'you'));
      this.character.setLook(this.color);
      this.applyColor();
    }
    if (l.looks) {
      if (JSON.stringify(l.looks) !== JSON.stringify(prev.looks ?? null)) {
        this.applyLooks(l.looks);
        this.onDirty?.();
      }
    } else {
      if (l.hat !== prev.hat) void this.hat.setHat(l.hat).then(() => this.onDirty?.());
      if (l.unusual !== prev.unusual) this.hat.setUnusual(l.unusual);
    }
    if (l.railgunFinish !== prev.railgunFinish) {
      const vis = this.gun?.visible ?? true;
      disposeRailgun(this.gun);
      this.gun = attachRailgun(this.character, railgunFinishById(l.railgunFinish).data);
      this.gun.visible = vis;
    }
    // Show off the new look: the emote comes round again soon after.
    if (Number.isFinite(this.emoteTimer) && this.emoteLeft <= 0) this.emoteTimer = Math.min(this.emoteTimer, 1.2);
  }

  setFrame(frame: HeroFrame | null) {
    this.frame = frame;
    if (!frame || frame.w < 2 || frame.h < 2) return;
    // Scale: the body stands HERO_HEIGHT of the viewport tall (never wider
    // than its slot allows); centred in the slot, the pad's lip on its floor.
    const ppm = Math.min((frame.vh * HERO_HEIGHT) / BODY_M, frame.w / 1.15, frame.h / (BODY_M + 0.45));
    const span = SPAN_TOP - SPAN_BOTTOM;
    const h = span * ppm;
    const w = h * 0.8;
    const floor = frame.y + frame.h; // pad lip (SPAN_BOTTOM) sits here
    const f = { x: frame.x + frame.w / 2 - w / 2, y: floor - h, w, h };
    const cam = this.camera;
    const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const midY = (SPAN_TOP + SPAN_BOTTOM) / 2;
    cam.fov = FOV;
    cam.aspect = f.w / f.h;
    cam.position.set(0, midY, dist);
    cam.lookAt(0, midY, 0);
    // The frame is the camera's "full" image; the canvas is a window onto it.
    cam.setViewOffset(f.w, f.h, -f.x, -f.y, Math.max(1, frame.vw), Math.max(1, frame.vh));
    cam.updateMatrixWorld();
  }

  setHover(on: boolean) {
    this.hoverTarget = on ? 1 : 0;
  }

  // Play the equipped emote now (click / a loadout change).
  emoteNow() {
    if (this.emoteLeft <= 0) this.emoteTimer = 0;
  }

  update(dt: number) {
    if (this.disposed) return;
    this.t += dt;
    const k = (hz: number) => 1 - Math.exp(-hz * dt);

    // Hover: square up to the camera, rim + pad brighten, seams glow.
    this.hover += (this.hoverTarget - this.hover) * k(HOVER_HZ);

    // Materialise: hot seams in your colour cooling off, a small rise.
    let glow = 0.4 * this.hover;
    if (this.spawn < 1) {
      this.spawn = Math.min(1, this.spawn + dt / SPAWN_SECONDS);
      const e = 1 - this.spawn;
      glow = Math.max(glow, 1.4 * e * e);
      this.holder.position.y = -0.07 * e * e * e;
    }
    this.character.setGlow(glow, this.color);
    this.holder.rotation.y = FACE_CAMERA + REST_YAW * (1 - 0.8 * this.hover) + Math.sin(this.t * 0.19) * 0.035;
    this.rim.intensity = RIM * (1 + 0.5 * this.hover);
    this.back.intensity = RIM * 0.6 * (1 + 0.5 * this.hover);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.7);
    this.ringMat.color.copy(this.color).multiplyScalar(1.5 + 0.25 * pulse + 0.9 * this.hover);
    this.poolMat.opacity = 0.32 + 0.06 * pulse + 0.18 * this.hover;

    // Emote cadence: idle at the ready, the equipped emote every 20–30 s.
    if (this.emoteLeft > 0) {
      this.emoteLeft -= dt;
      if (this.emoteLeft <= 0) {
        this.anim.playEmote(null);
        this.emoteTimer = EMOTE_GAP_MIN + Math.random() * (EMOTE_GAP_MAX - EMOTE_GAP_MIN);
        if (!this.emoteGun) this.queueGun(true, 0.14);
      }
    } else if (Number.isFinite(this.emoteTimer)) {
      this.emoteTimer -= dt;
      if (this.emoteTimer <= 0) this.startEmote();
    }
    if (this.gunVisibleIn >= 0) {
      this.gunVisibleIn -= dt;
      if (this.gunVisibleIn < 0 && this.gun) this.gun.visible = this.gunVisibleTo;
    }

    this.anim.update({ dt, yaw: 0, pitch: AIM_PITCH, pos: ORIGIN });
    this.hat.update(dt);
    this.trackShadow();
  }

  private trackShadow() {
    const mp = this.character.rig.mp;
    const lift = Math.max(0, Math.min(mp[B.footL * 3 + 1], mp[B.footR * 3 + 1]) - FOOT_REST_Y + this.holder.position.y);
    const k = Math.min(1, lift / 0.4);
    this.shadow.scale.setScalar(1 - 0.35 * k);
    this.shadowMat.opacity = 0.85 * (1 - 0.45 * k);
  }

  // Second pass: composite over whatever the renderer just drew (the arena),
  // depth cleared so the hero always sits in front. Runs inside the arena's
  // render (scene.onAfterRender) so it lands in the same HDR buffer.
  render(renderer: THREE.WebGLRenderer) {
    if (this.disposed || !this.visible) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.onDirty = null;
    this.hat.dispose();
    disposeRailgun(this.gun);
    this.gun = null;
    this.anim.dispose();
    this.character.dispose();
    this.owned.geo.forEach((g) => g.dispose());
    this.owned.mat.forEach((m) => m.dispose());
    this.owned.tex.forEach((t) => t.dispose());
    this.scene.environment = null; // the stage owns it
    this.scene.clear();
  }

  private startEmote() {
    const kind = emoteById(this.loadout.emote).kind;
    const clip = emoteClip(kind);
    this.anim.playEmote(kind, true);
    // Short clips run twice so the move lands; long ones once.
    this.emoteLeft = clip.duration * (clip.duration < 2.8 ? 2 : 1);
    this.emoteGun = clip.gun;
    // Hands-free emotes holster the gun for their length (flourish twirls it).
    if (!clip.gun) this.queueGun(false, 0.09);
    else if (this.gun) this.gun.visible = true;
  }

  private queueGun(visible: boolean, delay: number) {
    this.gunVisibleTo = visible;
    this.gunVisibleIn = delay;
  }

  private applyColor() {
    // Contrast, not tint: an icy rim cuts any armour colour out of any map.
    this.rim.color.copy(RIM_COLOR);
    this.back.color.copy(this.color).lerp(RIM_COLOR, 0.65);
    this.poolMat.color.copy(this.color);
    this.ringMat.color.copy(this.color).multiplyScalar(1.5);
  }
}
