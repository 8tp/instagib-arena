import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WornHat } from './hats';
import { loadSoldier, pickClip } from './podium';
import { applyEmote, buildEmoteRig, type EmoteRig } from './emotes';
import { EffectsManager } from './effects';
import { emoteById, railColorById, type KillEffectStyle } from './cosmetics';

// Live Locker preview: one soldier wearing the equipped hat + unusual, playing
// the equipped emote, and periodically firing a rail beam (equipped colour) into
// a kill burst (equipped frag effect) so every cosmetic slot is previewable.

export type PreviewCosmetics = {
  hatId: string;
  unusualId: string;
  emoteId: string;
  railColor: string; // rail cosmetic id
  killEffect: KillEffectStyle;
};

const FACE_CAMERA = Math.PI; // soldier faces -Z; turn it to face the +Z camera
const FIRE_PERIOD = 2.8; // seconds between showcase rail shots

export class CharacterPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private effects = new EffectsManager();
  private mixer: THREE.AnimationMixer | null = null;
  private rig: EmoteRig | null = null;
  private hat: WornHat | null = null;
  private group = new THREE.Group();
  private raf: number | null = null;
  private last = 0;
  private fireTimer = 1.0;
  private disposed = false;
  private cos: PreviewCosmetics;
  private beams: { mesh: THREE.Object3D; life: number; max: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    cos: PreviewCosmetics,
  ) {
    this.cos = cos;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 1.05, 4.7);
    this.camera.lookAt(0, 0.95, 0);
    this.resize();

    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x202028, 1.1));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.8);
    key.position.set(2.5, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9bb6ff, 1.0);
    rim.position.set(-3, 4, -4);
    this.scene.add(rim);

    // Disc the character stands on.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 40),
      new THREE.MeshStandardMaterial({ color: 0x161c26, roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.scene.add(this.group);

    void this.build();
  }

  private async build() {
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

  setCosmetics(cos: PreviewCosmetics) {
    const hatChanged = cos.hatId !== this.cos.hatId;
    const unusualChanged = cos.unusualId !== this.cos.unusualId;
    this.cos = cos;
    if (this.hat) {
      if (hatChanged) void this.hat.setHat(cos.hatId);
      if (unusualChanged) this.hat.setUnusual(cos.unusualId);
    }
  }

  private aspect() {
    return (this.canvas.clientWidth || 320) / (this.canvas.clientHeight || 360);
  }

  resize() {
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // A glowing twin-tone rail beam (core + helix sleeve) from a to b that fades.
  private fireBeam() {
    const rc = railColorById(this.cos.railColor).data;
    const a = new THREE.Vector3(-0.35, 1.25, 0.35);
    const b = new THREE.Vector3(1.7, 1.05, -0.6);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mid = a.clone().addScaledVector(dir, 0.5);
    const grp = new THREE.Group();
    const orient = (mesh: THREE.Mesh) => {
      mesh.position.copy(mid);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    };
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, len, 8),
      new THREE.MeshBasicMaterial({ color: rc.core, transparent: true, opacity: 1 }),
    );
    orient(core);
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, len, 10),
      new THREE.MeshBasicMaterial({
        color: rc.helix,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    orient(glow);
    grp.add(core, glow);
    this.scene.add(grp);
    this.beams.push({ mesh: grp, life: 0, max: 0.55 });
    // Kill burst (equipped frag style) at the far end.
    this.effects.spawnKillBurst(this.scene, b, false, this.cos.killEffect);
  }

  start() {
    if (this.raf !== null) return;
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.last ? Math.min(0.05, now - this.last) : 0;
      this.last = now;

      this.mixer?.update(dt);
      if (this.rig) applyEmote(this.rig, this.group, FACE_CAMERA, 0, now, emoteById(this.cos.emoteId).kind);
      this.hat?.update(dt);
      this.effects.step(dt, this.scene);

      // Showcase a rail shot + kill burst on a loop.
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.fireTimer = FIRE_PERIOD;
        this.fireBeam();
      }
      for (let i = this.beams.length - 1; i >= 0; i--) {
        const beam = this.beams[i];
        beam.life += dt;
        const k = 1 - beam.life / beam.max;
        beam.mesh.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (m && 'opacity' in m) m.opacity = Math.max(0, k) * (m.blending === THREE.AdditiveBlending ? 0.5 : 1);
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

      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
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
    this.renderer.dispose();
  }
}
