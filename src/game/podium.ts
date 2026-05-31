import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WornHat } from './hats';
import { emoteById, type EmoteKind } from './cosmetics';
import { applyEmote, buildEmoteRig, type EmoteRig } from './emotes';

// End-of-match podium: the top-3 players on pedestals (1st tallest, center),
// wearing their hats and playing their equipped emote. A self-contained Three.js
// scene mounted on a results-screen canvas — separate from the match scene.

const SOLDIER_URL = '/models/instagib/soldier.glb';
const MEDAL = [0xffd24a, 0xcdd6e0, 0xd08a4a]; // gold / silver / bronze (place 1/2/3)
// (x position, pedestal height, model facing yaw) for places 1, 2, 3.
const SLOTS: ReadonlyArray<{ x: number; h: number }> = [
  { x: 0, h: 0.95 },
  { x: -1.7, h: 0.62 },
  { x: 1.7, h: 0.36 },
];

export type PodiumWinner = {
  place: number; // 1-based
  name: string;
  score: number;
  hatId: string;
  emoteId: string;
};

let soldierPromise: Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> | null =
  null;
export function loadSoldier() {
  if (!soldierPromise) {
    soldierPromise = new GLTFLoader()
      .loadAsync(SOLDIER_URL)
      .then((g) => ({ scene: g.scene, animations: g.animations }));
  }
  return soldierPromise;
}

export function pickClip(clips: THREE.AnimationClip[], names: string[], fallback = 0): THREE.AnimationClip {
  for (const n of names) {
    const c = clips.find((cl) => cl.name.toLowerCase().includes(n));
    if (c) return c;
  }
  return clips[fallback] ?? clips[0];
}

// A floating label sprite (name + score) drawn on a canvas.
function makeLabel(name: string, sub: string, accent: string): THREE.Sprite {
  const w = 320;
  const h = 100;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,12,20,0.78)';
  roundRect(ctx, 4, 4, w - 8, h - 8, 14);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 4, 4, w - 8, h - 8, 14);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px "JetBrains Mono", monospace';
  ctx.fillText(name.slice(0, 12), w / 2, 48);
  ctx.fillStyle = accent;
  ctx.font = 'bold 30px "JetBrains Mono", monospace';
  ctx.fillText(sub, w / 2, 84);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.scale.set(1.4, 0.44, 1);
  return spr;
}
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

type Character = {
  group: THREE.Group; // outer group on the pedestal (position + facing + bob)
  baseY: number;
  mixer: THREE.AnimationMixer;
  hat: WornHat;
  kind: EmoteKind;
  rig: EmoteRig;
};

export class PodiumScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private chars: Character[] = [];
  private raf: number | null = null;
  private clock = { last: 0 };
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.resize();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(38, this.aspect(), 0.1, 100);
    this.camera.position.set(0, 2.2, 6.4);
    this.camera.lookAt(0, 1.55, 0);

    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x202028, 1.0));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.7);
    key.position.set(2.5, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88a6ff, 0.7);
    rim.position.set(-4, 4, -3);
    this.scene.add(rim);
    // A spotlight on the champion.
    const spot = new THREE.SpotLight(0xfff4d0, 8, 14, Math.PI / 7, 0.6, 1.2);
    spot.position.set(0, 6.5, 3);
    spot.target.position.set(0, 1.6, 0);
    this.scene.add(spot, spot.target);
    // A back-rim light so dark hats/silhouettes pop against the backdrop.
    const back = new THREE.DirectionalLight(0xa9c4ff, 1.1);
    back.position.set(0, 5, -6);
    this.scene.add(back);

    this.buildBackdrop();
    this.buildPedestals();
  }

  // A large vertical-gradient plane behind the podium — lighter up top so dark
  // hats (top hat, wizard) read as silhouettes instead of vanishing into black.
  private buildBackdrop() {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#33425f');
    g.addColorStop(0.55, '#1a2334');
    g.addColorStop(1, '#0a0d13');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(cv);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 12),
      new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }),
    );
    plane.position.set(0, 3, -4.5);
    this.scene.add(plane);
  }

  private aspect() {
    return (this.canvas.clientWidth || 800) / (this.canvas.clientHeight || 460);
  }

  resize() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 460;
    this.renderer.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  private buildPedestals() {
    for (let i = 0; i < 3; i++) {
      const { x, h } = SLOTS[i];
      const geo = new THREE.BoxGeometry(1.25, h, 1.25);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x222a36,
        emissive: new THREE.Color(MEDAL[i]).multiplyScalar(0.12),
        roughness: 0.6,
        metalness: 0.2,
      });
      const ped = new THREE.Mesh(geo, mat);
      ped.position.set(x, h / 2, 0);
      this.scene.add(ped);
      // a glowing accent strip on the front face
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.12),
        new THREE.MeshBasicMaterial({ color: MEDAL[i] }),
      );
      strip.position.set(x, h * 0.7, 0.631);
      this.scene.add(strip);
    }
    // floor
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x10151d, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
  }

  async setWinners(winners: PodiumWinner[]): Promise<void> {
    const src = await loadSoldier().catch(() => null);
    if (this.disposed || !src) return;
    this.clearChars();
    for (const w of winners.slice(0, 3)) {
      const slot = SLOTS[w.place - 1] ?? SLOTS[0];
      const group = new THREE.Group();
      group.position.set(slot.x, slot.h, 0);
      group.rotation.y = Math.PI; // soldier faces -Z; turn to face the camera (+Z)
      this.scene.add(group);

      const model = SkeletonUtils.clone(src.scene);
      model.scale.setScalar(1);
      group.add(model);

      const mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(pickClip(src.animations, ['idle'], 0)).play();
      const rig = buildEmoteRig(model, (w.place - 1) * 1.7);

      const hat = new WornHat(group, model);
      void hat.setHat(w.hatId);

      const accent = '#' + new THREE.Color(MEDAL[w.place - 1] ?? MEDAL[0]).getHexString();
      const label = makeLabel(w.name, `#${w.place} · ${w.score}`, accent);
      label.position.set(0, 2.35, 0);
      group.add(label);

      this.chars.push({
        group,
        baseY: slot.h,
        mixer,
        hat,
        kind: emoteById(w.emoteId).kind,
        rig,
      });
    }
  }

  start() {
    if (this.raf !== null) return;
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.clock.last ? Math.min(0.05, now - this.clock.last) : 0;
      this.clock.last = now;
      for (const c of this.chars) {
        c.mixer.update(dt);
        applyEmote(c.rig, c.group, Math.PI, c.baseY, now, c.kind);
        c.hat.update(dt);
      }
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private clearChars() {
    for (const c of this.chars) {
      c.hat.dispose();
      c.mixer.stopAllAction();
      this.scene.remove(c.group);
    }
    this.chars = [];
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.clearChars();
    // Free the WebGL context (the podium remounts every match-end; browsers cap
    // live contexts ~16, after which it renders blank).
    this.renderer.forceContextLoss();
    this.renderer.dispose();
  }
}
