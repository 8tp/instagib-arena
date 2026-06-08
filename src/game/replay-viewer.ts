// ── Standalone full-run replay viewer ────────────────────────────────────────
//
// Plays back a downloaded weekly-challenge run end-to-end, first-person through
// the runner's eyes, with play/pause/scrub/speed controls. It is intentionally
// decoupled from `Game` (no net, no input, no match lifecycle): it builds its own
// renderer/scene/camera + map geometry + bot model and drives a full-run
// `ReplayPlayer`. Reuses the same scene/lighting/map builders the live game uses
// so the arena looks identical to playing it.

import * as THREE from 'three';
import { loadBotModel } from './bots';
import { buildMapMesh, mapById } from './map';
import { EffectsManager } from './effects';
import { ReplayPlayer, type ReplaySource } from './replay';
import { createCamera, createRenderer, createScene } from './renderer';
import type { ReplayData } from './replay-codec';
import type { Vec3 } from './types';

const BOT_MODEL_URL = '/models/instagib/soldier.glb';
const BEAM_LIFE = 0.14; // seconds a replayed rail trace lingers before fading
const STATE_EMIT_MS = 80; // throttle the progress callback (≈12.5 Hz) for React

export type ReplayViewerState = {
  t: number; // current match-time (seconds)
  duration: number; // full run length (seconds)
  playing: boolean;
  atEnd: boolean;
  speed: number;
  ready: boolean;
};

// Mirror the player's own graphics settings so the replay looks like the game.
export type ReplayViewerOptions = {
  fov?: number;
  resolutionScale?: number;
  lowSpec?: boolean;
};

type Beam = { mesh: THREE.Mesh; life: number };

export class ReplayViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private mapMesh: THREE.Object3D | null = null;
  private effects = new EffectsManager();
  private player: ReplayPlayer | null = null;
  private beams: Beam[] = [];
  private beamGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
  private beamMat = new THREE.MeshBasicMaterial({
    color: 0x7ff0ff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private raf = 0;
  private prevNow = 0;
  private endT = 0;
  private disposed = false;
  private ready = false;
  private lastEmit = -1;
  private resizeHandler: () => void;
  private up = new THREE.Vector3(0, 1, 0);

  constructor(
    private canvas: HTMLCanvasElement,
    private data: ReplayData,
    private onState?: (s: ReplayViewerState) => void,
    opts: ReplayViewerOptions = {},
  ) {
    this.renderer = createRenderer(canvas);
    this.scene = createScene(this.renderer);
    this.camera = createCamera(canvas);
    // Match the player's own FOV + render quality so the rewatch looks like the game.
    if (typeof opts.fov === 'number' && Number.isFinite(opts.fov)) {
      this.camera.fov = Math.max(60, Math.min(130, opts.fov));
      this.camera.updateProjectionMatrix();
    }
    this.applyQuality(opts.resolutionScale ?? 1, opts.lowSpec ?? false);
    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
  }

  // Render-resolution pixel ratio, mirroring Game.setQuality/applyPixelRatio.
  private applyQuality(resolutionScale: number, lowSpec: boolean) {
    const scale = Number.isFinite(resolutionScale) ? Math.max(0.4, Math.min(2, resolutionScale)) : 1;
    const dpr = window.devicePixelRatio || 1;
    const cap = lowSpec ? 1 : 2;
    this.renderer.setPixelRatio(Math.min(Math.min(dpr, cap) * scale, lowSpec ? 1.5 : 3));
    this.effects.setQuality(lowSpec ? 0.5 : 1);
  }

  // Async because the bot GLB loads over the network. Safe to call once.
  async start() {
    const arena = mapById(this.data.mapId);
    this.mapMesh = buildMapMesh(arena);
    this.scene.add(this.mapMesh);

    const botModel = await loadBotModel(BOT_MODEL_URL).catch(() => null);
    if (this.disposed) return;

    const frames = this.data.frames;
    this.endT = frames.length ? frames[frames.length - 1].t : this.data.durationMs / 1000;

    const source: ReplaySource = {
      profiles: new Map(this.data.profiles.map((p) => [p.id, p])),
      frames,
      kills: this.data.kills,
      shots: this.data.shots,
    };
    const localName = source.profiles.get(this.data.localId)?.name ?? 'Runner';

    const player = new ReplayPlayer({
      scene: this.scene,
      camera: this.camera,
      botModel,
      spawnBeam: (o, e) => this.spawnBeam(o, e),
      spawnMuzzleFlash: (at) =>
        this.effects.spawnMuzzleFlash(this.scene, new THREE.Vector3(at.x, at.y, at.z)),
      spawnKillEffect: (at, headshot) => this.effects.spawnKillBurst(this.scene, at, headshot),
      reducedEffects: () => false,
    });
    player.start(
      {
        starId: this.data.localId,
        starName: localName,
        label: '',
        startT: 0,
        endT: this.endT,
        kills: this.data.kills,
      },
      source,
      { holdAtEnd: true },
    );
    // Start paused on the first frame so the user presses play deliberately.
    player.pause();
    this.player = player;
    this.ready = true;
    this.handleResize();
    this.loop();
    this.emit(true);
  }

  // ── Controls (the React overlay drives these) ──
  play() { this.player?.resume(); this.emit(true); }
  pause() { this.player?.pause(); this.emit(true); }
  togglePlay() { this.player?.togglePause(); this.emit(true); }
  seek(t: number) { this.player?.seek(t); this.emit(true); }
  setSpeed(s: number) { this.player?.setSpeed(s); this.emit(true); }
  get duration(): number { return this.endT; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resizeHandler);
    this.player?.dispose();
    this.player = null;
    for (const b of this.beams) this.scene.remove(b.mesh);
    this.beams.length = 0;
    this.effects.dispose(this.scene);
    if (this.mapMesh) {
      this.scene.remove(this.mapMesh);
      disposeObject(this.mapMesh);
    }
    this.beamGeo.dispose();
    this.beamMat.dispose();
    this.renderer.dispose();
  }

  // ── internals ──

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = this.prevNow ? Math.min(0.1, (now - this.prevNow) / 1000) : 1 / 60;
    this.prevNow = now;

    this.player?.update(dt);
    this.effects.step(dt, this.scene);
    this.stepBeams(dt);
    this.renderer.render(this.scene, this.camera);

    // Throttle the progress callback so React isn't re-rendered every frame.
    if (now - this.lastEmit >= STATE_EMIT_MS) this.emit(false);
  };

  private emit(force: boolean) {
    if (!this.onState || (!force && this.disposed)) return;
    this.lastEmit = performance.now();
    const p = this.player;
    this.onState({
      t: p ? p.currentT : 0,
      duration: this.endT,
      playing: p ? !p.isPaused : false,
      atEnd: p ? p.reachedEnd : false,
      speed: p ? p.speed : 1,
      ready: this.ready,
    });
  }

  // A short-lived additive cylinder along the rail path (a lightweight stand-in
  // for the live weapon's beam — the viewer doesn't own a Weapon).
  private spawnBeam(origin: Vec3, end: Vec3) {
    const a = new THREE.Vector3(origin.x, origin.y, origin.z);
    const b = new THREE.Vector3(end.x, end.y, end.z);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-3) return;
    const mesh = new THREE.Mesh(this.beamGeo, this.beamMat.clone());
    mesh.scale.set(1, len, 1);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(this.up, dir.normalize());
    this.scene.add(mesh);
    this.beams.push({ mesh, life: BEAM_LIFE });
  }

  private stepBeams(dt: number) {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i];
      beam.life -= dt;
      if (beam.life <= 0) {
        this.scene.remove(beam.mesh);
        (beam.mesh.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
        continue;
      }
      (beam.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, beam.life / BEAM_LIFE);
    }
  }

  private handleResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// Recursively free a built map mesh's geometries + materials.
function disposeObject(obj: THREE.Object3D) {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}
