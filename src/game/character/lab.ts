import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Character, SKIN_PALETTE } from './character';

// ── Pose lab (dev only) ──────────────────────────────────────────────────────
// Mounted by /lockerlab when the URL carries lab params. Renders one or many
// combatants under game-like lighting so every clip can be screenshotted at
// fixed timestamps from fixed views. Deterministic: the animation clock is
// the `t` param, not wall time (unless `play=1`).
//
//   ?lab=1&view=front|back|side|3q|top&zoom=full|head|far
//   ?lab=1&pose=run&t=0.25          one locomotion state at time t
//   ?lab=1&emote=cheer&t=1.2        one emote at time t
//   ?lab=1&grid=loco|emotes|<kind>  contact sheet (columns = states/times)
//   &bg=dark|light|mid  &color=#hex  &hl=1 (highlight look)  &play=1

export type LabDriver = {
  // Called once per character per frame with the lab clock.
  drive(ch: Character, t: number, dt: number, index: number, slot: THREE.Object3D): void;
  label?(index: number): string;
  count: number;
};

export class CharacterLab {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private chars: Character[] = [];
  private slots: THREE.Group[] = [];
  private labels: THREE.Sprite[] = [];
  private raf: number | null = null;
  private last = 0;
  private clock = 0;
  private disposed = false;
  private readonly params: URLSearchParams;
  private floor: THREE.Mesh;
  private driver: LabDriver | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    params: URLSearchParams,
  ) {
    this.params = params;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);

    const bg = params.get('bg') ?? 'dark';
    const bgCol = bg === 'light' ? 0xc9ced6 : bg === 'mid' ? 0x59606b : 0x14181f;
    this.scene.background = new THREE.Color(bgCol);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xcfe2f2, 0x7d8088, 0.5));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.8);
    sun.position.set(20, 40, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -8;
    sc.right = 8;
    sc.top = 8;
    sc.bottom = -8;
    sc.near = 1;
    sc.far = 120;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88a6ff, 0.35);
    fill.position.set(-15, 18, 12);
    this.scene.add(fill);

    const floorCol = bg === 'light' ? 0xaab0b8 : 0x2a3039;
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: floorCol, roughness: 0.85, metalness: 0.05 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.clock = Number(params.get('t') ?? 0);
    this.resize();
    (window as unknown as { __lab?: CharacterLab }).__lab = this;
  }

  // Dev: inspect a character (lab automation).
  debugChar(i = 0): Character | undefined {
    return this.chars[i];
  }

  setDriver(driver: LabDriver): void {
    this.driver = driver;
    this.clearChars();
    const n = driver.count;
    const grid = n > 1;
    const cols = grid ? Math.min(n, Number(this.params.get('cols') ?? 6)) : 1;
    const spacing = Number(this.params.get('spacing') ?? 1.35);
    const hl = this.params.get('hl') === '1';
    const colorParam = this.params.get('color');
    for (let i = 0; i < n; i++) {
      const color = colorParam ? `#${colorParam.replace('#', '')}` : SKIN_PALETTE[grid ? i % SKIN_PALETTE.length : 4];
      const ch = new Character({ colorHex: color });
      ch.setLook(color, hl ? 'highlight' : 'natural');
      const col = i % cols;
      const row = Math.floor(i / cols);
      const slot = new THREE.Group();
      // Lay the sheet out across the screen for the chosen view (reading
      // order left → right), rows receding away from the camera.
      const d = this.viewDir();
      const right = new THREE.Vector3(0, 1, 0).cross(d).normalize();
      const away = new THREE.Vector3(-d.x, 0, -d.z).normalize();
      slot.position
        .copy(right)
        .multiplyScalar((col - (cols - 1) / 2) * spacing)
        .addScaledVector(away, row * spacing * 1.6);
      slot.add(ch.root);
      this.scene.add(slot);
      this.slots.push(slot);
      this.chars.push(ch);
      const text = driver.label?.(i);
      if (text) {
        const spr = makeLabel(text);
        spr.position.set(slot.position.x, 0.02, slot.position.z);
        spr.center.set(0.5, 1.6);
        this.scene.add(spr);
        this.labels.push(spr);
      }
    }
    this.frame(grid, cols, Math.ceil(n / cols), spacing);
  }

  private frame(grid: boolean, cols: number, rows: number, spacing: number) {
    const zoom = this.params.get('zoom') ?? 'full';
    let target = new THREE.Vector3(0, 0.95, 0);
    let dist = 5.2;
    if (zoom === 'head') {
      target = new THREE.Vector3(0, 1.62, 0);
      dist = 1.5;
    } else if (zoom === 'upper') {
      target = new THREE.Vector3(0, 1.3, 0);
      dist = 2.6;
    } else if (zoom === 'far') {
      dist = Number(this.params.get('dist') ?? 30);
    }
    if (grid && zoom === 'head') {
      // Head sheets: frame just the helmets.
      const w = cols * spacing;
      const vfov = (this.camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
      dist = Math.max(w / 2 / Math.tan(hfov / 2), 0.7 / Math.tan(vfov / 2)) * 1.05;
    } else if (grid) {
      const w = cols * spacing;
      const vfov = (this.camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
      const fitW = w / 2 / Math.tan(hfov / 2);
      const fitH = (rows * 2.3) / 2 / Math.tan(vfov / 2);
      dist = Math.max(fitW, fitH) * 1.08 + (rows - 1) * spacing * 0.8;
    }
    const dir = this.viewDir();
    if (grid && rows > 1) dir.y = 0.35;
    dir.normalize();
    if (grid && rows > 1) {
      // Aim at the middle row.
      const mid = ((rows - 1) * spacing * 1.6) / 2;
      const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      target.addScaledVector(flat, -mid);
    }
    if (zoom === 'far') this.camera.fov = Number(this.params.get('fov') ?? 70);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
  }

  private viewDir(): THREE.Vector3 {
    const dir = new THREE.Vector3();
    switch (this.params.get('view') ?? 'front') {
      case 'back': dir.set(0, 0.12, 1); break;
      case 'side': dir.set(1, 0.12, 0); break;
      case 'left': dir.set(-1, 0.12, 0); break;
      case '3q': dir.set(0.72, 0.18, -0.7); break;
      case '3qb': dir.set(0.72, 0.18, 0.7); break;
      case 'top': dir.set(0, 1, -0.2); break;
      case 'low': dir.set(0.3, -0.05, -1); break;
      default: dir.set(0, 0.12, -1);
    }
    return dir;
  }

  resize(): void {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    const play = this.params.get('play') === '1';
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.last ? Math.min(0.05, now - this.last) : 0;
      this.last = now;
      if (play) this.clock += dt;
      if (this.driver) {
        for (let i = 0; i < this.chars.length; i++) this.driver.drive(this.chars[i], this.clock, play ? dt : 0, i, this.slots[i]);
      }
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private clearChars() {
    for (const c of this.chars) c.dispose();
    this.chars = [];
    for (const s of this.slots) this.scene.remove(s);
    this.slots = [];
    for (const l of this.labels) {
      this.scene.remove(l);
      l.material.map?.dispose();
      l.material.dispose();
    }
    this.labels = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.clearChars();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    (this.scene.environment as THREE.Texture | null)?.dispose();
    this.renderer.dispose();
  }
}

function makeLabel(text: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 48;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 256, 48);
  ctx.fillStyle = '#e8eef7';
  ctx.font = 'bold 26px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 25);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(0.9, 0.17, 1);
  return spr;
}
