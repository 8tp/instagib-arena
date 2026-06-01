import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WornHat } from './hats';
import { loadSoldier, pickClip } from './podium';
import { applyEmote, buildEmoteRig, type EmoteRig } from './emotes';
import { EffectsManager } from './effects';
import { buildRailgun, type RailgunModel } from './weapon-model';
import { emoteById, railColorById, railgunFinishById, type KillEffectStyle } from './cosmetics';

// Live Locker preview, focused per tab so each slot is shown the best way:
//   character → the soldier wearing the equipped hat + unusual, zoomed in on the
//               head and slowly turning so you can read the hat from every angle.
//   emote     → the whole player model playing the equipped emote, framed head-
//               to-toe (emotes throw the arms overhead, so the body must be in
//               frame).
//   weapon    → NO soldier — just the actual railgun, slowly turning, firing a
//               beam (equipped colour) into a kill burst (equipped frag effect).
// One WebGL context, mounted fresh per tab (the `view` is fixed for its life).

export type PreviewView = 'character' | 'emote' | 'weapon';

export type PreviewCosmetics = {
  hatId: string;
  unusualId: string;
  emoteId: string;
  railColor: string; // rail cosmetic id
  railgunFinish: string; // railgun-finish cosmetic id
  killEffect: KillEffectStyle;
  view: PreviewView;
};

const FACE_CAMERA = Math.PI; // soldier faces -Z; turn it to face the +Z camera
const FIRE_PERIOD = 2.2; // seconds between showcase rail shots (weapon view)

export class CharacterPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private effects = new EffectsManager();
  private mixer: THREE.AnimationMixer | null = null;
  private rig: EmoteRig | null = null;
  private hat: WornHat | null = null;
  private group = new THREE.Group();
  private gun: RailgunModel | null = null;
  private raf: number | null = null;
  private last = 0;
  private t = 0;
  private fireTimer = 0.6;
  private gunFlash = 0; // 0..1 muzzle-glow pulse, decays after a shot
  private disposed = false;
  private cos: PreviewCosmetics;
  private readonly view: PreviewView;
  private floor: THREE.Mesh | null = null;
  private beams: { mesh: THREE.Object3D; life: number; max: number }[] = [];
  // Weapon view: a fixed impact point so the beam always connects the (slowly
  // turning) muzzle to a burst that stays in frame.
  private readonly impact = new THREE.Vector3(0.8, 0.95, 0.12);
  private readonly tmpV = new THREE.Vector3();

  constructor(
    private canvas: HTMLCanvasElement,
    cos: PreviewCosmetics,
  ) {
    this.cos = cos;
    this.view = cos.view;
    // preserveDrawingBuffer so the canvas reliably shows its first rendered frame
    // the instant the tab mounts (no transient blank before the rAF loop spins up).
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.frameCamera();
    this.resize();

    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x202028, 1.1));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.85);
    key.position.set(2.5, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9bb6ff, 1.0);
    rim.position.set(-3, 4, -4);
    this.scene.add(rim);
    if (this.view === 'weapon') {
      // A soft fill from the front so the gunmetal reads without a soldier to
      // bounce light around.
      const fill = new THREE.DirectionalLight(0xbcd2ff, 0.6);
      fill.position.set(0, 1, 6);
      this.scene.add(fill);
    }

    // Ground disc — only under a standing soldier (character/emote). The weapon
    // view floats the gun, so a disc beneath it would look wrong.
    if (this.view !== 'weapon') {
      this.floor = new THREE.Mesh(
        new THREE.CircleGeometry(1.4, 48),
        new THREE.MeshStandardMaterial({ color: 0x161c26, roughness: 0.85 }),
      );
      this.floor.rotation.x = -Math.PI / 2;
      this.scene.add(this.floor);
    }
    this.scene.add(this.group);

    void this.build();
  }

  // Per-view camera placement (re-applied on resize via aspect only).
  private frameCamera() {
    if (this.view === 'character') {
      // Zoomed in on the head so the hat (and any unusual above it) reads.
      this.camera.fov = 30;
      this.camera.position.set(0, 1.66, 1.95);
      this.camera.lookAt(0, 1.56, 0);
    } else if (this.view === 'emote') {
      // Whole player model, with headroom for overhead arms.
      this.camera.fov = 30;
      this.camera.position.set(0, 1.18, 5.0);
      this.camera.lookAt(0, 1.05, 0);
    } else {
      // The gun + its beam/burst, with headroom for the burst's upward spray.
      this.camera.fov = 35;
      this.camera.position.set(-0.05, 1.2, 2.95);
      this.camera.lookAt(0.2, 1.02, 0);
    }
    this.camera.updateProjectionMatrix();
  }

  private async build() {
    if (this.view === 'weapon') {
      this.buildGun();
      return;
    }
    const src = await loadSoldier().catch(() => null);
    if (this.disposed || !src) return;
    const model = SkeletonUtils.clone(src.scene);
    this.group.add(model);
    this.group.rotation.y = FACE_CAMERA;
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.clipAction(pickClip(src.animations, ['idle'], 0)).play();
    this.rig = buildEmoteRig(model, 0);
    this.hat = new WornHat(this.group, model);
    void this.hat.setHat(this.cos.hatId);
    this.hat.setUnusual(this.cos.unusualId);
  }

  private buildGun() {
    const g = buildRailgun(railgunFinishById(this.cos.railgunFinish).data);
    this.gun = g;
    g.group.scale.setScalar(1.18);
    // Seat the grip lower-left, barrel pointing toward the impact point (+X /
    // slightly toward the camera) so the rails show in 3/4.
    g.group.position.set(-0.42, 0.92, 0.1);
    g.group.rotation.set(0.06, -Math.PI / 2 + 0.42, 0.05);
    this.group.add(g.group);
  }

  setCosmetics(cos: PreviewCosmetics) {
    const hatChanged = cos.hatId !== this.cos.hatId;
    const unusualChanged = cos.unusualId !== this.cos.unusualId;
    this.cos = cos;
    if (this.hat) {
      if (hatChanged) void this.hat.setHat(cos.hatId);
      if (unusualChanged) this.hat.setUnusual(cos.unusualId);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 240;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // A glowing twin-tone rail beam (core + additive glow sleeve) from a to b that
  // fades out over `max` seconds (handled in the tick loop).
  private spawnBeam(a: THREE.Vector3, b: THREE.Vector3) {
    const rc = railColorById(this.cos.railColor).data;
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return;
    const mid = a.clone().addScaledVector(dir, 0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize(),
    );
    const grp = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, len, 8),
      new THREE.MeshBasicMaterial({ color: rc.core, transparent: true, opacity: 1 }),
    );
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, len, 10),
      new THREE.MeshBasicMaterial({
        color: rc.helix,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    for (const m of [core, glow]) {
      m.position.copy(mid);
      m.quaternion.copy(quat);
    }
    grp.add(core, glow);
    this.scene.add(grp);
    this.beams.push({ mesh: grp, life: 0, max: 0.5 });
  }

  // Weapon view: fire from the gun muzzle into the fixed impact point.
  private fire() {
    if (!this.gun) return;
    this.gun.muzzle.getWorldPosition(this.tmpV);
    this.spawnBeam(this.tmpV.clone(), this.impact);
    this.effects.spawnMuzzleFlash(this.scene, this.tmpV.clone(), railColorById(this.cos.railColor).data.core);
    this.effects.spawnKillBurst(this.scene, this.impact, false, this.cos.killEffect);
    this.gunFlash = 1;
  }

  start() {
    if (this.raf !== null) return;
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.last ? Math.min(0.05, now - this.last) : 0;
      this.last = now;
      this.t += dt;

      if (this.view === 'weapon') {
        this.stepWeapon(dt);
      } else {
        this.mixer?.update(dt);
        if (this.view === 'character') {
          // Gentle turntable sway so the hat reads from the front and both sides.
          this.group.rotation.y = FACE_CAMERA + Math.sin(this.t * 0.55) * 0.7;
          if (this.rig) applyEmote(this.rig, this.group, this.group.rotation.y, 0, now, 'idle');
        } else if (this.rig) {
          applyEmote(this.rig, this.group, FACE_CAMERA, 0, now, emoteById(this.cos.emoteId).kind);
        }
        this.hat?.update(dt);
      }

      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stepWeapon(dt: number) {
    this.effects.step(dt, this.scene);
    if (this.gun) {
      // Slow showcase turn + a tiny bob.
      this.gun.group.rotation.y = -Math.PI / 2 + 0.42 + Math.sin(this.t * 0.5) * 0.45;
      this.gun.group.position.y = 0.92 + Math.sin(this.t * 0.9) * 0.015;
      // Pulse the gun's emissive on fire, then ease back to its rest glow.
      this.gunFlash = Math.max(0, this.gunFlash - dt * 3);
      this.gun.glow.emissiveIntensity = 1.7 + this.gunFlash * 3.5;
    }
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = FIRE_PERIOD;
      this.fire();
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i];
      beam.life += dt;
      const k = Math.max(0, 1 - beam.life / beam.max);
      beam.mesh.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && 'opacity' in m) m.opacity = k * (m.blending === THREE.AdditiveBlending ? 0.5 : 1);
      });
      if (beam.life >= beam.max) {
        this.scene.remove(beam.mesh);
        beam.mesh.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose?.();
          const mat = mesh.material as THREE.Material | undefined;
          mat?.dispose?.();
        });
        this.beams.splice(i, 1);
      }
    }
  }

  dispose() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.hat?.dispose();
    this.mixer?.stopAllAction();
    this.effects.dispose(this.scene);
    for (const b of this.beams) this.scene.remove(b.mesh);
    this.beams = [];
    // Per-instance scenery (the soldier + hat clones share CACHED geometry, so we
    // must NOT dispose those). The gun is procedural and unique → dispose it.
    this.floor?.geometry.dispose();
    (this.floor?.material as THREE.Material | undefined)?.dispose();
    if (this.gun) {
      this.gun.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
    }
    // Release the WebGL context itself — the Locker preview remounts on every
    // tab open, and browsers cap live contexts (~16), after which it renders
    // blank. forceContextLoss frees this context + all its GPU uploads.
    this.renderer.forceContextLoss();
    this.renderer.dispose();
  }
}
