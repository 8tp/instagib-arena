import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { WornHat } from './hats';
import { emoteById } from './cosmetics';
import { CharacterAnimator } from './character-anim';
import { Character, skinColorFor } from './character/character';
import { attachRailgun, disposeRailgun } from './character/gun';

// End-of-match podium: the top-3 players on pedestals (1st tallest, center),
// wearing their hats and playing their equipped emote/taunt — authored full-
// body clips on the code-built combatant. A self-contained Three.js scene
// mounted on a results-screen canvas, separate from the match scene.

const MEDAL = [0xffd24a, 0xcdd6e0, 0xd08a4a]; // gold / silver / bronze (place 1/2/3)
// (x position, pedestal height) for places 1, 2, 3.
const SLOTS: ReadonlyArray<{ x: number; h: number }> = [
  { x: 0, h: 0.95 },
  { x: -1.7, h: 0.62 },
  { x: 1.7, h: 0.42 },
];
// Stagger the three performers so they never move in lockstep.
const TIME_OFFSET = [0, 0.55, 1.15];

export type PodiumWinner = {
  place: number; // 1-based
  name: string;
  score: number;
  hatId: string;
  emoteId: string;
};

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
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false }));
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

type Performer = {
  group: THREE.Group; // outer group on the pedestal (position + facing)
  character: Character;
  anim: CharacterAnimator;
  hat: WornHat;
  gun: THREE.Group | null;
  label: THREE.Sprite;
};

export class PodiumScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private chars: Performer[] = [];
  private raf: number | null = null;
  private clock = { last: 0 };
  private disposed = false;
  private readonly owned: Array<{ dispose(): void }> = [];
  // Per place: the pedestal's meshes (an unused place — a duel's 3rd — hides).
  private readonly pedestals: THREE.Object3D[][] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.resize();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(38, this.aspect(), 0.1, 100);
    this.camera.position.set(0, 2.45, 6.9);
    this.camera.lookAt(0, 1.86, 0);

    // Image-based fill so the painted armour and gunmetal read as materials.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();
    this.owned.push(env);

    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x202028, 0.7));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.6);
    key.position.set(2.5, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -4;
    sc.right = 4;
    sc.top = 4;
    sc.bottom = -1;
    sc.near = 1;
    sc.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88a6ff, 0.8);
    rim.position.set(-4, 4, -3);
    this.scene.add(rim);
    // A spotlight on the champion.
    const spot = new THREE.SpotLight(0xfff4d0, 5.5, 14, Math.PI / 7, 0.6, 1.2);
    spot.position.set(0, 6.5, 3);
    spot.target.position.set(0, 1.6, 0);
    this.scene.add(spot, spot.target);
    // A back-rim light so dark hats/silhouettes pop against the backdrop.
    const back = new THREE.DirectionalLight(0xa9c4ff, 1.3);
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
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(26, 12);
    const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: false, toneMapped: false });
    const plane = new THREE.Mesh(geo, mat);
    plane.position.set(0, 3, -4.5);
    this.scene.add(plane);
    this.owned.push(tex, geo, mat);
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
      const medal = new THREE.Color(MEDAL[i]);
      // Gunmetal block with a medal-coloured cap trim.
      const geo = new RoundedBoxGeometry(1.25, h, 1.25, 2, 0.035);
      const mat = new THREE.MeshStandardMaterial({ color: 0x1d232c, roughness: 0.45, metalness: 0.6 });
      const ped = new THREE.Mesh(geo, mat);
      ped.position.set(x, h / 2, 0);
      ped.receiveShadow = true;
      ped.castShadow = true;
      this.scene.add(ped);
      const capGeo = new RoundedBoxGeometry(1.29, 0.05, 1.29, 2, 0.015);
      const capMat = new THREE.MeshStandardMaterial({
        color: medal,
        emissive: medal.clone().multiplyScalar(0.25),
        roughness: 0.3,
        metalness: 0.8,
      });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(x, h - 0.02, 0);
      cap.receiveShadow = true;
      this.scene.add(cap);
      // Glowing place numeral + accent strip on the front face.
      const cv = document.createElement('canvas');
      cv.width = 128;
      cv.height = 128;
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#' + medal.getHexString();
      ctx.font = 'bold 108px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), 64, 70);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Same numeral size on every pedestal (the short bronze one included).
      const size = Math.min(0.3, (h - 0.09) * 0.9);
      const nGeo = new THREE.PlaneGeometry(size, size);
      const nMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, color: 0xffffff });
      const num = new THREE.Mesh(nGeo, nMat);
      num.position.set(x, (h - 0.09) / 2 - 0.01, 0.628);
      this.scene.add(num);
      const sGeo = new THREE.PlaneGeometry(1.0, 0.035);
      const sMat = new THREE.MeshBasicMaterial({ color: medal.clone().multiplyScalar(1.6), toneMapped: false });
      const strip = new THREE.Mesh(sGeo, sMat);
      strip.position.set(x, h - 0.09, 0.628);
      this.scene.add(strip);
      this.owned.push(geo, mat, capGeo, capMat, tex, nGeo, nMat, sGeo, sMat);
      this.pedestals.push([ped, cap, num, strip]);
    }
    // floor
    const fGeo = new THREE.CircleGeometry(6, 48);
    const fMat = new THREE.MeshStandardMaterial({ color: 0x10151d, roughness: 0.9 });
    const floor = new THREE.Mesh(fGeo, fMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.owned.push(fGeo, fMat);
  }

  async setWinners(winners: PodiumWinner[]): Promise<void> {
    if (this.disposed) return;
    this.clearChars();
    const used = new Set(winners.slice(0, 3).map((w) => Math.max(0, Math.min(2, w.place - 1))));
    this.pedestals.forEach((meshes, i) => meshes.forEach((m) => (m.visible = used.has(i))));
    for (const w of winners.slice(0, 3)) {
      const idx = Math.max(0, Math.min(2, w.place - 1));
      const slot = SLOTS[idx];
      const group = new THREE.Group();
      group.position.set(slot.x, slot.h, 0);
      group.rotation.y = Math.PI; // the combatant faces -Z; turn to face the camera (+Z)
      this.scene.add(group);

      const character = new Character({ colorHex: skinColorFor(w.name) });
      group.add(character.root);
      const anim = new CharacterAnimator(character, { driveYaw: false, holdGun: false });
      const kind = emoteById(w.emoteId).kind;
      anim.playEmote(kind);
      anim.setEmoteTime(TIME_OFFSET[idx], 1);
      const gun = kind === 'flourish' ? attachRailgun(character) : null;

      const hat = new WornHat(character.sockets.headTop);
      void hat.setHat(w.hatId);

      const accent = '#' + new THREE.Color(MEDAL[idx]).getHexString();
      const label = makeLabel(w.name, `#${w.place} · ${w.score}`, accent);
      // Clear of overhead arms and hops (cheer jumps ~0.3 m with arms up).
      label.position.set(0, 2.82, 0);
      group.add(label);

      this.chars.push({ group, character, anim, hat, gun, label });
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
        c.anim.updateStatic(dt);
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
      disposeRailgun(c.gun);
      c.anim.dispose();
      c.character.dispose();
      c.label.material.map?.dispose();
      c.label.material.dispose();
      this.scene.remove(c.group);
    }
    this.chars = [];
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.clearChars();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    // Dispose resources without forcing the canvas into a context-lost state;
    // dev labs can remount a new scene on the same canvas immediately.
    this.renderer.dispose();
  }
}
