import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RailgunFinish } from './cosmetics';
import { flashTexture } from './fx-pool';
import { localRail, nowMs } from './fx/rail-state';
import { BARREL_Y, COIL_COUNT, MUZZLE_Z, railgunGeometry, type GunLod } from './gun/gun-geometry';
import { GunMaterial, STOCK_FINISH, type GunUniforms } from './gun/gun-material';

// ─────────────────────────────────────────────────────────────────────────
// Procedural railgun (no external asset — the art pipeline is all procedural).
// A chunky Q3-style rail: heavy receiver with heat-sink fins and a charge
// window in each flank, rear capacitor, skeletal stock, and a long accelerator
// — a glowing energy core between four conductor rails, ringed by four bold
// coils, ending in a pronged emitter. Geometry: gun/gun-geometry.ts (built once
// per LOD, shared). Surface + finish patterns: gun/gun-material.ts (one
// material, one draw call for the whole gun).
//
// The coils ARE the ammo readout (first-person viewmodel): lit when ready; on
// a shot they flash white-hot, drop dark, and refill one by one front (muzzle)
// to back over the recharge, with a glint when the rail is ready. The core,
// the capacitor and the flank charge windows follow the same charge. See
// CoilDriver below.
//
// MODEL-SPACE CONVENTION (stable — third-person sockets depend on it):
//   • origin   = the grip / trigger point (the right hand's palm sits just
//                below and behind it, around (0, -0.12, 0.09));
//   • forward  = -Z (the barrel points down -Z, the camera's forward);
//   • up       = +Y; the gun is symmetric about X = 0;
//   • scale    = 1 unit ≈ 1 m at scale 1: ~1.36 long (butt +0.45 → prong tips
//                -0.92), muzzle marker at (0, 0.03, -0.9). Callers scale the
//                group (first person 0.8; the combatant hand socket ~0.6, see
//                character/gun.ts).
//
// Resources: the geometry is shared (userData.shared) — never dispose it; the
// material + flare material are per gun: free them with `model.dispose()`.
// ─────────────────────────────────────────────────────────────────────────

// Coil emissive levels (linear). REST is a restrained meter glow, well under
// the bloom threshold (1.5): a ready gun reads "charged", not as a lamp under
// the crosshair. The fire flash blooms; the fill edge + ready glint just lift.
const COIL_REST = 0.62;
const COIL_DARK = 0.03;
const COIL_EDGE = 1.25; // leading-edge glint while a coil fills
const COIL_FLASH = 7;
const COIL_READY = 1.1;
const CORE_REST = 0.95;
const CORE_DARK = 0.05;
const CORE_FLASH = 6;
const WIN_REST = 0.8;
const CAP_REST = 0.45;
const FLASH_LIGHT = 2.2; // discharge light thrown on the barrel
// An explicit drive (setCharge/notifyFire) lapses back to the shared local
// state after this long without a call (e.g. a spectator starts playing).
const EXTERNAL_LAPSE_MS = 600;

export type RailgunLod = GunLod;

export type RailgunModel = {
  group: THREE.Group;
  muzzle: THREE.Object3D; // barrel-tip marker (beam origin)
  // The gun's material. Its emissive (accent-hot × emissiveIntensity) lights
  // the status strips + emitter ring: the Game pops the intensity on fire /
  // kill and eases it back to 0.8.
  glow: THREE.MeshStandardMaterial;
  // Additive discharge flare seated on the muzzle, hidden at rest. The first-
  // person viewmodel drives it (visible + opacity 1→0 + scale 1→1.9) per shot.
  muzzleFlash: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  // Drive the coils explicitly: 0 = just fired … 1 = ready. Once called, the
  // gun ignores the shared local-rail state (fx/rail-state.ts). A first-person
  // viewmodel parented to a camera follows that state automatically.
  setCharge(charge: number): void;
  // Flash the coils for a shot (explicit drive only; pairs with setCharge).
  notifyFire(): void;
  // Swap the finish in place (uniforms; a pattern change swaps the shader
  // program) — no geometry rebuild. Same as recolorRailgun(model, finish).
  setFinish(finish?: RailgunFinish): void;
  // Low-spec tier: drop the per-pixel extras (pattern relief, bounce light).
  setLowSpec(low: boolean): void;
  // Free this gun's own resources (materials). The geometry is shared.
  dispose(): void;
};

export type BuildRailgunOptions = {
  // 'high' (default): first-person / locker detail (relief, bounce light).
  // 'low': third person — fewer segments, flat shading of the patterns.
  lod?: RailgunLod;
};

// ── Coil driver ─────────────────────────────────────────────────────────────

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

// Animates the coils, core, capacitor and charge windows from the rail charge.
// Time-based (performance.now) so the flash/glint look identical at any frame
// rate.
class CoilDriver {
  external = false;
  externalMs = -1e9;
  charge = 1;
  private shots = -1;
  private fireMs = -1e9;
  private readyMs = -1e9;
  private prevCharge = 1;

  constructor(private readonly u: GunUniforms) {}

  fire(now: number) {
    this.fireMs = now;
  }

  // `live` = follow the local rail (first-person viewmodel); otherwise the
  // explicit drive, or a full charge (locker / showcase).
  update(now: number, live: boolean) {
    if (this.external && now - this.externalMs > EXTERNAL_LAPSE_MS) this.external = false;
    if (!this.external) {
      if (live) {
        this.charge = localRail.charge;
        if (localRail.shots !== this.shots) {
          if (this.shots >= 0) this.fireMs = now;
          this.shots = localRail.shots;
        }
      } else {
        this.charge = 1;
      }
    }
    const u = this.u;
    const accent = u.uAccent.value;
    const hot = u.uAccentHot.value;
    const charge = Math.max(0, Math.min(1, this.charge));
    if (charge >= 1 && this.prevCharge < 1) this.readyMs = now;
    this.prevCharge = charge;

    const sinceFire = (now - this.fireMs) / 1000;
    const flash = sinceFire >= 0 && sinceFire < 0.4 ? Math.exp(-sinceFire * 26) : 0;
    const sinceReady = (now - this.readyMs) / 1000;
    const ready = sinceReady >= 0 && sinceReady < 0.6 ? Math.exp(-sinceReady * 8) : 0;
    // The first ~12 % of the recharge stays dark so the discharge reads, then
    // the coils refill one after another, front (muzzle) to back.
    const fill = Math.max(0, Math.min(1, (charge - 0.12) / 0.86));
    const t = (now / 1000) % 3600;
    for (let i = 0; i < COIL_COUNT; i++) {
      const p = Math.max(0, Math.min(1, fill * COIL_COUNT - i));
      const level = p * p * (3 - 2 * p);
      const edge = p > 0 && p < 1 ? 4 * p * (1 - p) : 0;
      // Charged coils carry a faint wave running back along the barrel, so a
      // ready gun reads as live energy rather than a static light.
      const hum = 1 + 0.1 * level * Math.sin(t * 5.2 - i * 1.1);
      const k = (COIL_DARK + (COIL_REST - COIL_DARK) * level) * hum + COIL_EDGE * edge + COIL_FLASH * flash + COIL_READY * ready;
      const h = Math.min(1, flash * 1.4 + edge * 0.7 + ready * 0.8);
      u.uCoil.value[i].copy(accent).lerp(hot, h).multiplyScalar(k);
    }
    // Core: powers down on the shot, refills with the charge.
    const coreK = CORE_DARK + (CORE_REST - CORE_DARK) * fill + CORE_FLASH * flash + 0.7 * ready;
    tmpA.copy(accent).lerp(hot, Math.min(1, 0.35 + flash * 1.5 + ready * 0.4));
    u.uCore.value.copy(tmpA).multiplyScalar(coreK);
    // Charge windows: a gauge (w = fill), brighter as it tops out.
    const winK = WIN_REST * (0.7 + 0.3 * charge) + 3 * flash + 0.8 * ready;
    tmpB.copy(accent).lerp(hot, Math.min(1, 0.3 + 0.6 * ready + flash)).multiplyScalar(winK);
    u.uWin.value.set(tmpB.r, tmpB.g, tmpB.b, charge);
    // Capacitor.
    const capK = 0.08 + CAP_REST * fill + 5 * flash + 0.8 * ready;
    u.uCap.value.copy(accent).lerp(hot, Math.min(1, flash + 0.35)).multiplyScalar(capK);
    // Discharge light on the barrel.
    u.uFlash.value.copy(hot).multiplyScalar(FLASH_LIGHT * flash);
    u.uTime.value = t;
  }
}

// ── Builder ─────────────────────────────────────────────────────────────────

let flareGeo: THREE.BufferGeometry | null = null;

// Canonical railgun (see the convention above). `finish` (a railgun-finish
// cosmetic's colours + pattern) recolours it; omitted = stock.
export function buildRailgun(finish?: RailgunFinish, opts: BuildRailgunOptions = {}): RailgunModel {
  const lod: RailgunLod = opts.lod ?? 'high';
  const f = finish ?? STOCK_FINISH;
  const group = new THREE.Group();
  group.name = 'railgun';

  const material = new GunMaterial(f, { lod });
  const mesh = new THREE.Mesh(railgunGeometry(lod), material);
  mesh.name = 'railgun-body';
  group.add(mesh);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, BARREL_Y, MUZZLE_Z);
  group.add(muzzle);

  // Discharge flare: a camera-facing-ish star (disc across the bore) plus two
  // crossed streak planes blown forward along the barrel. Additive, unlit, no
  // depth write — reads as a burst of energy, never as a solid ball.
  flareGeo ??= buildFlareGeometry();
  const muzzleFlash = new THREE.Mesh(
    flareGeo,
    new THREE.MeshBasicMaterial({
      // Bright enough to bloom hard on the first frames; the Game fades the
      // opacity to 0 over ~100 ms.
      color: flareColor(f.accentHot),
      map: flashTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Drawn over the shroud (the flare engulfs the muzzle, never hides
      // behind it); it lives ~100 ms.
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  muzzleFlash.name = 'railgun-flare';
  muzzleFlash.position.set(0, 0, -0.01);
  muzzleFlash.visible = false;
  muzzleFlash.renderOrder = 2;
  muzzle.add(muzzleFlash);

  // ── Coil drive ─────────────────────────────────────────────────────────────
  // Every frame the gun renders (onBeforeRender): a viewmodel (parented to a
  // camera) registers its muzzle for the local beam and follows the shared
  // local-rail charge unless driven explicitly; anything else shows a full
  // charge (locker) or its explicit drive.
  const driver = new CoilDriver(material.gun);
  driver.update(nowMs(), false);
  mesh.frustumCulled = lod === 'low'; // the hook must run even when off-frame
  mesh.onBeforeRender = () => {
    const parent = group.parent as (THREE.Object3D & { isCamera?: boolean }) | null;
    const isViewmodel = !!parent?.isCamera;
    const now = nowMs();
    if (isViewmodel) {
      localRail.muzzle = muzzle;
      localRail.muzzleSeenMs = now;
    }
    driver.update(now, isViewmodel);
  };

  const model: RailgunModel = {
    group,
    muzzle,
    glow: material,
    muzzleFlash,
    setCharge(charge: number) {
      driver.external = true;
      driver.externalMs = nowMs();
      driver.charge = Number.isFinite(charge) ? charge : 1;
    },
    notifyFire() {
      driver.external = true;
      driver.externalMs = nowMs();
      driver.fire(nowMs());
    },
    setFinish(next?: RailgunFinish) {
      const nf = next ?? STOCK_FINISH;
      material.setFinish(nf);
      muzzleFlash.material.color.copy(flareColor(nf.accentHot));
    },
    setLowSpec(low: boolean) {
      if (lod === 'high') material.setHighDetail(!low);
    },
    dispose() {
      material.dispose();
      muzzleFlash.material.dispose();
    },
  };
  return model;
}

// Recolour a built railgun in place (no geometry rebuild): the finish's
// palette + pattern, the coil/core accent and the discharge flare.
export function recolorRailgun(model: RailgunModel, finish?: RailgunFinish): void {
  model.setFinish(finish);
}

// Third-person gun for a character's hand socket: the low-detail build in the
// same model space. character/gun.ts attachRailgun is the cached, shared-
// material version combatants use.
export function buildThirdPersonRailgun(finish?: RailgunFinish): RailgunModel {
  return buildRailgun(finish, { lod: 'low' });
}

function flareColor(accentHot: number): THREE.Color {
  return new THREE.Color(accentHot).lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(2.4);
}

// Discharge flare mesh: one disc facing along the bore (the star) + two crossed
// planes stretched forward (the streaks). All share the flash texture's UVs.
// Shared by every gun (userData.shared).
function buildFlareGeometry(): THREE.BufferGeometry {
  const disc = new THREE.PlaneGeometry(0.3, 0.3);
  const jetA = new THREE.PlaneGeometry(0.09, 0.42);
  jetA.rotateX(-Math.PI / 2); // lie along Z
  jetA.translate(0, 0, -0.16);
  const jetB = jetA.clone();
  jetB.rotateZ(Math.PI / 2);
  const g = mergeGeometries([disc, jetA, jetB], false) ?? disc;
  if (g !== disc) disc.dispose();
  jetA.dispose();
  jetB.dispose();
  g.userData.shared = true;
  return g;
}
