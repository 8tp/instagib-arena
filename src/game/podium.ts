import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { WornHat } from './hats';
import { emoteById } from './cosmetics';
import { CharacterAnimator } from './character-anim';
import { Character, skinColorFor } from './character/character';
import { attachRailgun, disposeRailgun } from './character/gun';
import { WornGearCtor, type GearLike } from '../economy/gear';
import type { Loadout } from './items/types';
import { PODIUM_FONT, arenaWall, brushedMetal, darkMarble, namePlate, numeralPlate, radialGlow, stageFloor } from './podium-textures';

// End-of-match podium: the top-3 players on plinths (1st tallest, center),
// wearing their full look (hat / face / back + unusual) and playing their
// equipped emote/taunt — authored full-body clips on the code-built combatant.
// A self-contained Three.js scene mounted on a results-screen canvas, separate
// from the match scene. Everything is procedural (canvas textures + shaders).

const MEDAL = [0xffd24a, 0xcdd6e0, 0xd08a4a]; // gold / silver / bronze (place 1/2/3)
const MEDAL_BASE = ['#b98a22', '#8d97a6', '#94592b']; // brushed cap tints
const STEP_H = 0.14; // the shared base step the plinths stand on
// (x position, plinth height above the step) for places 1, 2, 3.
const SLOTS: ReadonlyArray<{ x: number; h: number }> = [
  { x: 0, h: 1.05 },
  { x: -1.95, h: 0.72 },
  { x: 1.95, h: 0.52 },
];
// Stagger the three performers so they never move in lockstep.
const TIME_OFFSET = [0, 0.55, 1.15];
// Rise-in order: bronze, silver, then the champion.
const RISE_DELAY = [0.75, 0.45, 0.15];
const LOOK_SLOTS = ['hat', 'face', 'back'] as const;

export type PodiumWinner = {
  place: number; // 1-based
  name: string;
  score: number;
  hatId: string;
  emoteId: string;
  you?: boolean; // the local player — their nameplate is marked
  looks?: Loadout; // full equipped looks (hat / face / back + unusual) when known
};

export type PodiumOptions = { lowSpec?: boolean; reducedEffects?: boolean };

type Performer = {
  group: THREE.Group; // outer group on the plinth (position + facing)
  character: Character;
  anim: CharacterAnimator;
  hat: WornHat | null;
  gear: GearLike | null;
  gun: THREE.Group | null;
  plate: THREE.Sprite;
  plateA: number; // eased 0..1 fade-in
  plateAt: number; // seconds after which the plate fades in
  x: number; // world x of the plinth
};

type Stage = { group: THREE.Group; y: number; delay: number; used: boolean };

// Additive light-shaft material: brightest toward the apex, soft edges via a
// view-angle falloff. Cheap stand-in for volumetric god rays.
function rayMaterial(color: number, strength: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uK: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vH;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vH = uv.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uK;
      varying vec3 vN; varying vec3 vV; varying float vH;
      void main() {
        float f = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float h = pow(clamp(vH, 0.0, 1.0), 1.4);
        gl_FragColor = vec4(uColor * uK * f * h, 1.0);
      }`,
  });
}

export class PodiumScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private chars: Performer[] = [];
  private raf: number | null = null;
  private clock = { last: 0 };
  private t = 0; // scene time (seconds since start)
  private disposed = false;
  private gen = 0; // setWinners generation (a slow font load must not clobber a newer call)
  private readonly owned: Array<{ dispose(): void }> = [];
  private readonly low: boolean;
  private readonly reduced: boolean;
  // Per place: the plinth stage group (rises into place; unused places hide).
  private readonly stages: Stage[] = [];
  private readonly numerals: Array<{ mat: THREE.MeshStandardMaterial }> = [];
  private readonly rays: THREE.Mesh[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private motes: { pts: THREE.Points; seeds: Float32Array } | null = null;
  private confetti: {
    mesh: THREE.InstancedMesh;
    pos: Float32Array;
    vel: Float32Array;
    rot: Float32Array;
    spin: Float32Array;
    at: Float32Array; // launch time; the piece is inactive before it
    life: Float32Array; // seconds since launch; -2 = waiting, -1 = finished
    n: number;
  } | null = null;
  private readonly dummy = new THREE.Object3D();
  private readonly lookAt = new THREE.Vector3(0, 2.14, 0);

  constructor(
    private canvas: HTMLCanvasElement,
    opts: PodiumOptions = {},
  ) {
    this.low = !!opts.lowSpec;
    this.reduced = !!opts.reducedEffects;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.low, alpha: true });
    this.renderer.setPixelRatio(this.low ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Plinths rise out of the step: clip anything below it (skipped when motion is off).
    if (!this.reduced) this.renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.02)];
    this.camera = new THREE.PerspectiveCamera(38, this.aspect(), 0.1, 100);
    this.resize();
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(0x0a101c, 0.05);

    // Image-based fill so brushed metal and painted armour read as materials.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
    this.owned.push(env);

    this.buildLights();
    this.buildBackdrop();
    this.buildStage();
    this.buildPlinths();
    this.buildAtmosphere();
    this.placeCamera(0);
    // Numerals use the display face: redraw once it has loaded.
    this.applyNumerals();
    void this.fontsReady().then(() => {
      if (!this.disposed) this.applyNumerals();
    });
  }

  private fontsReady(): Promise<void> {
    const f = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!f) return Promise.resolve();
    return Promise.all([f.load(`700 40px ${PODIUM_FONT}`), f.load(`600 30px ${PODIUM_FONT}`)]).then(
      () => undefined,
      () => undefined,
    );
  }

  private aspect() {
    return (this.canvas.clientWidth || 800) / (this.canvas.clientHeight || 460);
  }

  // ── Lighting ───────────────────────────────────────────────────────────────
  private buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xa9bddc, 0x141822, 0.5));
    const key = new THREE.DirectionalLight(0xfff0d8, 1.5);
    key.position.set(2.5, 6, 5);
    key.castShadow = true;
    const ms = this.low ? 512 : 1024;
    key.shadow.mapSize.set(ms, ms);
    const sc = key.shadow.camera;
    sc.left = -5;
    sc.right = 5;
    sc.top = 5;
    sc.bottom = -1;
    sc.near = 1;
    sc.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key);
    // Cool cyan rim from back-left, violet from back-right: edge separation.
    const rimL = new THREE.DirectionalLight(0x38bdf8, 1.5);
    rimL.position.set(-5, 4, -3);
    s.add(rimL);
    const rimR = new THREE.DirectionalLight(0xa78bfa, 1.0);
    rimR.position.set(5, 3, -3);
    s.add(rimR);
    // Soft champion spot + a lighter per-winner spot in each medal colour.
    const mk = (color: number, intensity: number, x: number, h: number, angle: number) => {
      const spot = new THREE.SpotLight(color, intensity, 16, angle, 0.85, 1.2);
      spot.position.set(x * 0.6, 7, 3.2);
      spot.target.position.set(x, h + 1.4, 0);
      s.add(spot, spot.target);
    };
    mk(0xfff1c9, 6.5, SLOTS[0].x, SLOTS[0].h, Math.PI / 7.5);
    if (!this.low) {
      mk(0xdbe6f6, 2.4, SLOTS[1].x, SLOTS[1].h, Math.PI / 9);
      mk(0xffc79a, 2.4, SLOTS[2].x, SLOTS[2].h, Math.PI / 9);
    }
    // A back-rim so dark hats / silhouettes pop against the wall.
    const back = new THREE.DirectionalLight(0xa9c4ff, 1.1);
    back.position.set(0, 5, -6);
    s.add(back);
  }

  // ── Backdrop: arena wall, light bars, slow arcs, halo ─────────────────────
  private buildBackdrop() {
    const s = this.scene;
    const wallTex = arenaWall(7);
    const wallGeo = new THREE.PlaneGeometry(34, 12.75);
    const wallMat = new THREE.MeshBasicMaterial({ map: wallTex, fog: false, toneMapped: false });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, 4.6, -7);
    s.add(wall);
    this.owned.push(wallTex, wallGeo, wallMat);

    // Vertical light bars on a shallow arc: parallax depth when the camera drifts.
    const barGeo = new THREE.BoxGeometry(0.1, 1, 0.1);
    const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x38bdf8).multiplyScalar(0.34), fog: false });
    const violet = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xa78bfa).multiplyScalar(0.3), fog: false });
    const gold = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd24a).multiplyScalar(0.55), fog: false });
    this.owned.push(barGeo, cyan, violet, gold);
    const xs = [-9.5, -7.6, -5.9, -4.3, 4.3, 5.9, 7.6, 9.5];
    xs.forEach((x, i) => {
      const hgt = [5.6, 4.2, 6.4, 3.4][i % 4];
      const bar = new THREE.Mesh(barGeo, i % 3 === 2 ? violet : cyan);
      bar.scale.y = hgt;
      bar.position.set(x, hgt / 2 + 0.1, -5.6 - Math.abs(x) * 0.06);
      s.add(bar);
    });
    // Slow rotating arcs behind the champion: a halo that reads as depth.
    const arcs: Array<[number, number, number, THREE.Material, number, number]> = [
      [2.9, 0.022, Math.PI * 1.25, gold, 0.11, 0],
      [3.3, 0.014, Math.PI * 0.9, cyan, -0.08, 2.1],
      [3.7, 0.01, Math.PI * 0.6, violet, 0.05, 4.2],
    ];
    for (const [r, tube, arc, mat, spd, rot0] of arcs) {
      const g = new THREE.TorusGeometry(r, tube, 6, 96, arc);
      this.owned.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.set(0, 2.55, -4.6);
      m.rotation.z = rot0;
      m.userData.spd = spd;
      s.add(m);
      this.rings.push(m);
    }
    // Warm glow behind the champion.
    const glowTex = radialGlow(256, [
      [0, 'rgba(255,214,120,0.9)'],
      [0.4, 'rgba(255,190,90,0.22)'],
      [1, 'rgba(255,170,60,0)'],
    ]);
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.32,
      fog: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(8.5, 6.5, 1);
    glow.position.set(0, 2.5, -4.2);
    s.add(glow);
    this.owned.push(glowTex, glowMat);
  }

  // ── Floor, base step ──────────────────────────────────────────────────────
  private buildStage() {
    const s = this.scene;
    const floorTex = stageFloor(11);
    floorTex.repeat.set(4, 4);
    const floorGeo = new THREE.CircleGeometry(14, 72);
    this.owned.push(floorTex, floorGeo);
    if (!this.low) {
      // Mirror pass under a translucent glossy tile layer = soft, glossy reflection.
      const w = Math.max(256, Math.round((this.canvas.clientWidth || 800) * 0.6));
      const h = Math.max(128, Math.round((this.canvas.clientHeight || 460) * 0.6));
      const refl = new Reflector(floorGeo, {
        textureWidth: w,
        textureHeight: h,
        color: new THREE.Color(0x9aa4b5),
        clipBias: 0.003,
      });
      refl.rotation.x = -Math.PI / 2;
      refl.position.y = -0.004;
      s.add(refl);
      this.owned.push(refl.material as THREE.Material, refl.getRenderTarget());
      const tiles = new THREE.MeshStandardMaterial({
        map: floorTex,
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.35,
        transparent: true,
        opacity: 0.78,
        fog: true,
      });
      const floor = new THREE.Mesh(floorGeo, tiles);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      s.add(floor);
      this.owned.push(tiles);
    } else {
      const mat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.32, metalness: 0.55 });
      const floor = new THREE.Mesh(floorGeo, mat);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      s.add(floor);
      this.owned.push(mat);
    }

    // Base step under all three plinths: dark marble, lit front lip.
    const marble = darkMarble(3);
    marble.repeat.set(3, 1);
    const stepGeo = new RoundedBoxGeometry(6.8, STEP_H, 2.45, 3, 0.05);
    const stepMat = new THREE.MeshStandardMaterial({ map: marble, roughness: 0.28, metalness: 0.35 });
    const step = new THREE.Mesh(stepGeo, stepMat);
    step.position.set(0, STEP_H / 2, 0);
    step.receiveShadow = true;
    step.castShadow = true;
    s.add(step);
    const lipGeo = new THREE.BoxGeometry(6.6, 0.018, 0.02);
    const lipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x38bdf8).multiplyScalar(0.9), toneMapped: false });
    const lip = new THREE.Mesh(lipGeo, lipMat);
    lip.position.set(0, STEP_H * 0.55, 1.232);
    s.add(lip);
    this.owned.push(marble, stepGeo, stepMat, lipGeo, lipMat);
  }

  // ── Plinths ───────────────────────────────────────────────────────────────
  private buildPlinths() {
    const bodyTex = brushedMetal('#262f3d', 21, { frame: true });
    const bodyMat = new THREE.MeshStandardMaterial({
      map: bodyTex,
      bumpMap: bodyTex,
      bumpScale: 0.7,
      roughness: 0.42,
      metalness: 0.6,
    });
    this.owned.push(bodyTex, bodyMat);
    const glowTex = radialGlow(128);
    this.owned.push(glowTex);
    const stageIdx = [0, 1, 2];
    for (const i of stageIdx) {
      const { x, h } = SLOTS[i];
      const medal = new THREE.Color(MEDAL[i]);
      const group = new THREE.Group();
      group.position.set(x, STEP_H, 0);
      this.scene.add(group);

      const bodyGeo = new RoundedBoxGeometry(1.3, h - 0.03, 1.3, 3, 0.045);
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = (h - 0.03) / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      // Brushed medal-metal cap, slightly proud of the body.
      const capTex = brushedMetal(MEDAL_BASE[i], 40 + i, { streak: 0.16 });
      const capMat = new THREE.MeshStandardMaterial({
        map: capTex,
        bumpMap: capTex,
        bumpScale: 0.5,
        emissive: medal.clone().multiplyScalar(0.06),
        roughness: 0.3,
        metalness: 0.92,
      });
      const capGeo = new RoundedBoxGeometry(1.38, 0.07, 1.38, 3, 0.03);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = h - 0.035;
      cap.castShadow = true;
      cap.receiveShadow = true;
      group.add(cap);

      // Emissive trim rings: under the cap, and a low collar.
      const trimMat = new THREE.MeshBasicMaterial({ color: medal.clone().multiplyScalar(1.05), toneMapped: false });
      const trimGeo = new THREE.BoxGeometry(1.325, 0.022, 1.325);
      const trim = new THREE.Mesh(trimGeo, trimMat);
      trim.position.y = h - 0.1;
      group.add(trim);
      const collarMat = new THREE.MeshBasicMaterial({ color: medal.clone().multiplyScalar(0.4), toneMapped: false });
      const collar = new THREE.Mesh(trimGeo, collarMat);
      collar.position.y = 0.09;
      group.add(collar);

      // Engraved, glowing place numeral on the front face.
      const nMat = new THREE.MeshStandardMaterial({
        transparent: true,
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.85,
        roughness: 0.6,
        metalness: 0.2,
        fog: false,
      });
      const nSize = 0.34;
      const nGeo = new THREE.PlaneGeometry(nSize, nSize);
      const num = new THREE.Mesh(nGeo, nMat);
      num.position.set(0, (h - 0.14 + 0.1) / 2 - 0.02, 0.652);
      group.add(num);
      this.numerals[i] = { mat: nMat };

      // Coloured under-glow pool on the step around the plinth.
      const poolMat = new THREE.MeshBasicMaterial({
        map: glowTex,
        color: medal.clone().multiplyScalar(i === 0 ? 1 : 0.7),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      });
      const poolGeo = new THREE.PlaneGeometry(3.3, 3.3);
      const pool = new THREE.Mesh(poolGeo, poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.006;
      group.add(pool);

      this.owned.push(bodyGeo, capTex, capMat, capGeo, trimMat, trimGeo, collarMat, nMat, nGeo, poolMat, poolGeo);
      this.stages.push({ group, y: this.reduced ? 0 : -(h + 0.3), delay: RISE_DELAY[i], used: true });
      group.position.y = STEP_H + this.stages[i].y;
    }
  }

  private applyNumerals() {
    this.numerals.forEach((n, i) => {
      const old = [n.mat.map, n.mat.emissiveMap];
      const t = numeralPlate(i + 1, '#' + new THREE.Color(MEDAL[i]).getHexString());
      n.mat.map = t.map;
      n.mat.emissiveMap = t.emissive;
      n.mat.needsUpdate = true;
      for (const o of old) o?.dispose();
      this.owned.push(t.map, t.emissive);
    });
  }

  // ── Atmosphere: god rays, dust motes, confetti ────────────────────────────
  private buildAtmosphere() {
    const s = this.scene;
    // Light shafts on each winner (soft; the champion's is the strongest).
    const rayDefs: Array<[number, number, number]> = [
      [0xffe2a0, 1.9, 0.17],
      [0xcfe0f5, 1.15, 0.09],
      [0xffc79a, 1.1, 0.09],
    ];
    if (!this.low) {
      rayDefs.forEach(([col, r, k], i) => {
        const g = new THREE.ConeGeometry(r, 7, 40, 1, true);
        const m = rayMaterial(col, k * 3.2);
        const cone = new THREE.Mesh(g, m);
        cone.position.set(SLOTS[i].x, 3.5 + STEP_H, 0);
        s.add(cone);
        this.owned.push(g, m);
        this.rays.push(cone);
      });
    }
    // Drifting dust motes catching the light.
    const n = this.low ? 24 : 70;
    const pos = new Float32Array(n * 3);
    const seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 6;
      pos[i * 3 + 1] = Math.random() * 4.2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3 + 0.4;
      seeds[i * 3] = Math.random() * 6.28;
      seeds[i * 3 + 1] = 0.05 + Math.random() * 0.12;
      seeds[i * 3 + 2] = 0.2 + Math.random() * 0.4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dotTex = radialGlow(64);
    const mat = new THREE.PointsMaterial({
      map: dotTex,
      color: 0xffe9b8,
      size: 0.075,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    s.add(pts);
    this.motes = { pts, seeds };
    this.owned.push(geo, dotTex, mat);

    // Confetti: two volleys, instanced flat pieces with tumbling physics.
    if (!this.reduced) {
      const cn = this.low ? 60 : 170;
      const cg = new THREE.PlaneGeometry(0.07, 0.11);
      const cm = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false, fog: false });
      const mesh = new THREE.InstancedMesh(cg, cm, cn);
      mesh.frustumCulled = false;
      const palette = [0xffd24a, 0xfff2b8, 0x38bdf8, 0xa78bfa, 0xf472b6, 0xffffff, 0x34d399].map((c) => new THREE.Color(c));
      const c = new THREE.Color();
      for (let i = 0; i < cn; i++) mesh.setColorAt(i, c.copy(palette[i % palette.length]).multiplyScalar(0.85));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      for (let i = 0; i < cn; i++) mesh.setMatrixAt(i, this.dummy.matrix);
      this.dummy.scale.setScalar(1);
      s.add(mesh);
      this.confetti = {
        mesh,
        pos: new Float32Array(cn * 3),
        vel: new Float32Array(cn * 3),
        rot: new Float32Array(cn * 3),
        spin: new Float32Array(cn * 3),
        at: new Float32Array(cn),
        life: new Float32Array(cn).fill(-2),
        n: cn,
      };
      // Volley schedule + launch state set up front (positions are (re)seeded on launch).
      for (let i = 0; i < cn; i++) this.confetti.at[i] = i < cn * 0.6 ? 1.05 + Math.random() * 0.25 : 2.6 + Math.random() * 0.6;
      this.owned.push(cg, cm, mesh);
    }
  }

  private launchConfetti(i: number) {
    const f = this.confetti!;
    const fromSide = i < f.n * 0.6;
    const b = i * 3;
    if (fromSide) {
      // Side cannons, angled in and up over the champion.
      const dir = i % 2 === 0 ? -1 : 1;
      f.pos[b] = dir * 3.2;
      f.pos[b + 1] = 0.3;
      f.pos[b + 2] = 0.6 + Math.random() * 0.5;
      f.vel[b] = -dir * (2.2 + Math.random() * 2.4);
      f.vel[b + 1] = 6.5 + Math.random() * 3.5;
      f.vel[b + 2] = -0.3 + Math.random() * 0.8;
    } else {
      // A slow shower from overhead.
      f.pos[b] = (Math.random() - 0.5) * 5.2;
      f.pos[b + 1] = 5.6 + Math.random() * 0.8;
      f.pos[b + 2] = (Math.random() - 0.5) * 2;
      f.vel[b] = (Math.random() - 0.5) * 0.8;
      f.vel[b + 1] = -0.4 - Math.random() * 0.6;
      f.vel[b + 2] = (Math.random() - 0.5) * 0.6;
    }
    for (let k = 0; k < 3; k++) {
      f.rot[b + k] = Math.random() * 6.28;
      f.spin[b + k] = (Math.random() - 0.5) * 9;
    }
    f.life[i] = 0;
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  // Distance that fits the whole staging (plinths + name plates) at any aspect.
  private fitDistance(): number {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const a = this.camera.aspect;
    const halfH = 2.34; // ~ floor to the top of the champion's plate
    const halfW = 3.2;
    return Math.max(halfH / tanHalf, halfW / (tanHalf * a));
  }

  private placeCamera(dt: number) {
    void dt;
    const d = this.fitDistance();
    // Slow push-in that eases out (exp of scene time — frame-rate independent),
    // then a gentle orbit sway. Reduced effects: static.
    const push = this.reduced ? 0 : 0.16 * Math.exp(-this.t * 0.85);
    const yaw = this.reduced ? 0 : 0.11 * Math.sin(this.t * 0.21);
    const bob = this.reduced ? 0 : 0.05 * Math.sin(this.t * 0.33);
    const r = d * (1 + push);
    this.camera.position.set(Math.sin(yaw) * r, 2.5 + bob + push * 0.6, Math.cos(yaw) * r);
    this.camera.lookAt(this.lookAt);
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

  // ── Winners ───────────────────────────────────────────────────────────────
  async setWinners(winners: PodiumWinner[]): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.gen;
    this.clearChars();
    await this.fontsReady();
    if (this.disposed || gen !== this.gen) return;
    const used = new Set(winners.slice(0, 3).map((w) => Math.max(0, Math.min(2, w.place - 1))));
    this.stages.forEach((st, i) => {
      st.used = used.has(i);
      st.group.visible = st.used;
    });
    for (const w of winners.slice(0, 3)) {
      const idx = Math.max(0, Math.min(2, w.place - 1));
      const slot = SLOTS[idx];
      const group = new THREE.Group();
      group.position.set(0, slot.h, 0);
      group.rotation.y = Math.PI; // the combatant faces -Z; turn to face the camera (+Z)
      this.stages[idx].group.add(group);

      const character = new Character({ colorHex: skinColorFor(w.name) });
      group.add(character.root);
      const anim = new CharacterAnimator(character, { driveYaw: false, holdGun: false });
      const kind = emoteById(w.emoteId).kind;
      anim.playEmote(kind);
      anim.setEmoteTime(TIME_OFFSET[idx], 1);
      const gun = kind === 'flourish' ? attachRailgun(character) : null;

      // Full loadout via the wearable builders (hat / face / back + unusual);
      // falls back to the legacy hat when the module or the looks are absent.
      let gear: GearLike | null = null;
      let hat: WornHat | null = null;
      if (WornGearCtor && w.looks) {
        gear = new WornGearCtor(character);
        for (const sl of LOOK_SLOTS) gear.setLook(sl, w.looks[sl] ?? null);
      } else if (WornGearCtor) {
        gear = new WornGearCtor(character);
        gear.setLook('hat', w.hatId && !w.hatId.endsWith('.none') ? { d: w.hatId } : null);
      } else {
        hat = new WornHat(character.sockets.headTop);
        void hat.setHat(w.hatId);
      }

      const accent = '#' + new THREE.Color(MEDAL[idx]).getHexString();
      const plateTex = namePlate({ name: w.name, place: w.place, score: w.score, accent, you: !!w.you });
      const plate = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: plateTex, transparent: true, toneMapped: false, fog: false, opacity: this.reduced ? 1 : 0 }),
      );
      plate.scale.set(1.7, 0.53, 1);
      // Clear of overhead arms and hops (cheer jumps ~0.3 m with arms up).
      plate.position.set(0, 2.74, 0);
      // Always over the scene (confetti, shafts, motes) and never depth-hidden by a raised arm.
      plate.renderOrder = 20;
      plate.material.depthTest = false;
      plate.material.depthWrite = false;
      group.add(plate);

      this.chars.push({ group, character, anim, hat, gear, gun, plate, plateA: this.reduced ? 1 : 0, plateAt: RISE_DELAY[idx] + 0.9, x: slot.x });
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────
  start() {
    if (this.raf !== null) return;
    const tick = (nowMs: number) => {
      if (this.disposed) return;
      const now = nowMs / 1000;
      const dt = this.clock.last ? Math.min(0.05, now - this.clock.last) : 0;
      this.clock.last = now;
      this.t += dt;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private update(dt: number) {
    // Plinths rise into place, bronze first.
    const kRise = 1 - Math.exp(-6.5 * dt);
    this.stages.forEach((st, i) => {
      if (this.t > st.delay) st.y += (0 - st.y) * kRise;
      if (Math.abs(st.y) < 0.002) st.y = 0;
      st.group.position.y = STEP_H + st.y;
      void i;
    });
    const kPlate = 1 - Math.exp(-7 * dt);
    for (const c of this.chars) {
      c.anim.updateStatic(dt);
      c.hat?.update(dt);
      c.gear?.update(dt);
      if (this.t > c.plateAt) c.plateA += (1 - c.plateA) * kPlate;
      const m = c.plate.material as THREE.SpriteMaterial;
      m.opacity = c.plateA;
      c.plate.position.y = 2.74 + (1 - c.plateA) * -0.25;
      // Layout-aware: plates shrink in small frames so neighbours never touch
      // (plinths are 1.95 apart), grow a little when the frame is very narrow,
      // and are clamped inside the visible width.
      const asp = this.camera.aspect;
      const base = asp < 2.6 ? 1.5 : 1.7;
      const pk = THREE.MathUtils.clamp(1 + (1.7 - asp) * 0.35, 1, 1.25);
      const w = base * pk;
      c.plate.scale.set(w, w * 0.312, 1);
      const vw = this.camera.position.length() * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * asp - 0.08;
      const wx = THREE.MathUtils.clamp(c.x, -vw + w / 2, vw - w / 2) - c.x; // desired world offset
      c.plate.position.x = -wx; // the performer group is turned 180 degrees
    }
    this.placeCamera(dt);
    if (!this.reduced) {
      for (const r of this.rings) r.rotation.z += (r.userData.spd as number) * dt;
      this.rays.forEach((r, i) => {
        r.rotation.z = Math.sin(this.t * 0.35 + i * 1.7) * 0.012;
        r.rotation.x = Math.cos(this.t * 0.27 + i) * 0.01;
      });
      this.updateMotes(dt);
      this.updateConfetti(dt);
    }
  }

  private updateMotes(dt: number) {
    const m = this.motes;
    if (!m) return;
    const attr = m.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const p = attr.array as Float32Array;
    const n = p.length / 3;
    for (let i = 0; i < n; i++) {
      const ph = m.seeds[i * 3];
      p[i * 3] += Math.sin(this.t * m.seeds[i * 3 + 2] + ph) * 0.06 * dt;
      p[i * 3 + 1] += m.seeds[i * 3 + 1] * dt;
      if (p[i * 3 + 1] > 4.6) p[i * 3 + 1] = 0.15;
    }
    attr.needsUpdate = true;
  }

  private updateConfetti(dt: number) {
    const f = this.confetti;
    if (!f) return;
    const drag = Math.exp(-1.3 * dt);
    let dirty = false;
    for (let i = 0; i < f.n; i++) {
      if (f.life[i] === -2 && this.t >= f.at[i]) this.launchConfetti(i);
      const life = f.life[i];
      const d = this.dummy;
      if (life < 0) continue;
      const b = i * 3;
      f.life[i] = life + dt;
      const landed = f.pos[b + 1] <= STEP_H + 0.01 && life > 0.4;
      if (!landed) {
        f.vel[b + 1] -= 3.4 * dt;
        f.vel[b] *= drag;
        f.vel[b + 2] *= drag;
        if (f.vel[b + 1] < -1.1) f.vel[b + 1] += (-1.1 - f.vel[b + 1]) * (1 - Math.exp(-3 * dt)); // flutter: terminal velocity
        f.pos[b] += f.vel[b] * dt;
        f.pos[b + 1] += f.vel[b + 1] * dt;
        f.pos[b + 2] += f.vel[b + 2] * dt;
        f.rot[b] += f.spin[b] * dt;
        f.rot[b + 1] += f.spin[b + 1] * dt;
        f.rot[b + 2] += f.spin[b + 2] * dt;
      } else {
        f.pos[b + 1] = STEP_H + 0.005;
      }
      // Fade out ~6 s after launch (landed pieces shrink away).
      const age = f.life[i];
      const fade = age > 5 ? Math.max(0, 1 - (age - 5) / 1.2) : 1;
      if (fade <= 0) {
        f.life[i] = -1;
        d.scale.setScalar(0);
        d.position.set(0, -10, 0);
      } else d.scale.setScalar(fade);
      if (f.life[i] >= 0) d.position.set(f.pos[b], f.pos[b + 1], f.pos[b + 2]);
      d.rotation.set(landed ? -Math.PI / 2 : f.rot[b], landed ? 0 : f.rot[b + 1], f.rot[b + 2]);
      d.updateMatrix();
      f.mesh.setMatrixAt(i, d.matrix);
      dirty = true;
    }
    if (dirty) f.mesh.instanceMatrix.needsUpdate = true;
  }

  private clearChars() {
    for (const c of this.chars) {
      c.hat?.dispose();
      c.gear?.dispose();
      disposeRailgun(c.gun);
      c.anim.dispose();
      c.character.dispose();
      c.plate.material.map?.dispose();
      c.plate.material.dispose();
      c.group.parent?.remove(c.group);
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
    this.confetti?.mesh.dispose();
    // Dispose resources without forcing the canvas into a context-lost state;
    // dev labs can remount a new scene on the same canvas immediately.
    this.renderer.dispose();
  }
}
