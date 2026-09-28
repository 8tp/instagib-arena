import * as THREE from 'three';
import type { RailgunFinish } from '../cosmetics';
import { RAIL_COOLDOWN } from '../constants';
import { nowMs } from '../fx/rail-state';
import { BARREL_Y, COIL_COUNT, MUZZLE_Z, PART, railgunGeometrySplit } from '../gun/gun-geometry';
import { GunMaterial, STOCK_FINISH, gunFx } from '../gun/gun-material';
import type { Character } from './character';

// Third-person railgun: the low-LOD model (grip/trigger at the origin, barrel
// down −Z, metres; ~1.36 long — see weapon-model.ts) seated in the combatant's
// hand.R gun socket. The arm IK (see character-anim.ts) places that hand on
// the aim line, so the barrel follows the view pitch exactly.
//
// Cheap by construction — 8+ of these are on screen:
//   • geometry is built ONCE (gun/gun-geometry.ts) and shared by every gun;
//   • the lit shell uses ONE material per finish, cached and shared;
//   • only the glowing parts (coils, core, windows, strips) have a per-gun
//     material, so each gun can pulse on its own shot and refill with its own
//     charge (notifyFire / setCharge). At rest the glow is calm (under the
//     bloom threshold); a shot flashes it white-hot and it refills over the
//     rail cooldown.
// Two draws per gun (+ the shell's shadow), plus a tiny claw flare for ~90 ms
// after each shot.

// World size of the third-person gun (~0.8 m in hand).
export const GUN_SCALE = 0.6;
// The model's palm point is ~(0, -0.12, 0.09) in gun space; seat it on the
// socket (the palm centre), i.e. the gun origin sits up/forward of the palm.
const GUN_IN_SOCKET = new THREE.Vector3(0, 0.12 * GUN_SCALE, -0.09 * GUN_SCALE);

// Hold geometry in the AIM frame (offsets from the chest bone position; −Z =
// along the barrel). These are PALM positions: `grip` is the right palm on the
// pistol grip, `support` the left palm under the foregrip battery. The
// animator converts them to wrist (IK) targets.
export const HOLD = {
  grip: new THREE.Vector3(0.125, 0.07, -0.24),
  support: new THREE.Vector3(0.118, 0.122, -0.44),
};
// Palm offset from the wrist in the hand bone's frame (= the gun socket).
export const PALM_OFFSET = new THREE.Vector3(0, -0.065, -0.012);

// Energy levels (linear radiance multipliers on the accent colour).
const IDLE = 1.0; // calm: peak channel ≤ 1 — under the bloom threshold
const FLASH = 0.6; // a shot lifts everything this much more (coils/core more, below)
const EXTERNAL_LAPSE_MS = 1500;

// ── Shared per-finish shell materials ───────────────────────────────────────
const shellCache = new Map<string, GunMaterial>();
function finishKey(f: RailgunFinish): string {
  return `${f.body}|${f.metal}|${f.metalLt}|${f.accent}|${f.accentHot}|${f.pattern ?? 'plain'}`;
}
function shellMaterial(f: RailgunFinish): GunMaterial {
  const key = finishKey(f);
  let m = shellCache.get(key);
  if (!m) {
    m = new GunMaterial(f, { lod: 'low' });
    m.name = `railgun-3p-${f.pattern ?? 'plain'}`;
    shellCache.set(key, m);
  }
  return m;
}

// ── Per-gun energy material ─────────────────────────────────────────────────
// Unlit (MeshBasic + fog), coloured per part from the `gun` attribute: coils
// relight back → front with the charge like the first-person meter. A shot's
// pulse is anchored at the muzzle claw (it fades out toward the receiver) and
// is in the shooter's rail colour; the rear parts never flash.
const ENERGY_VERT_PARS = /* glsl */ `
attribute vec3 gun;
varying vec3 vGunE;
varying float vGunZ;
`;
const ENERGY_FRAG_PARS = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uHot;
uniform vec3 uRail;
uniform vec4 uDrive; // x = level, z = coil fill 0…1, w = shot pulse
varying vec3 vGunE;
varying float vGunZ;
`;
const ENERGY_FRAG = /* glsl */ `
  int part = int(vGunE.x + 0.5);
  float k = 0.9;
  float hot = 0.0;
  if (part >= ${PART.COIL0}) {
    float p = clamp(uDrive.z * ${COIL_COUNT}.0 - float(${COIL_COUNT - 1} - (part - ${PART.COIL0})), 0.0, 1.0);
    k = mix(0.08, 1.0, p * p * (3.0 - 2.0 * p));
  } else if (part == ${PART.CORE}) {
    k = mix(0.12, 0.9, uDrive.z);
  } else if (part == ${PART.WINDOW}) {
    k = 0.3 + 0.5 * uDrive.z;
  } else if (part == ${PART.CAP}) {
    k = 0.25 + 0.45 * uDrive.z;
  } else {
    hot = 0.25; // status strips + emitter ring
  }
  // 0 at the receiver … 1 at the claw: the pulse lives at the muzzle.
  float front = smoothstep(-0.5, -0.86, vGunZ);
  float pulse = uDrive.w * front * (part == ${PART.GLOW} ? 5.0 : 2.2);
  vec3 c = mix(uAccent, uHot, hot) * k * uDrive.x + uRail * pulse;
  vec4 diffuseColor = vec4(c, opacity);
`;

type EnergyUniforms = {
  uAccent: { value: THREE.Color };
  uHot: { value: THREE.Color };
  uRail: { value: THREE.Color };
  uDrive: { value: THREE.Vector4 };
};

function energyMaterial(u: EnergyUniforms): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  m.name = 'railgun-3p-energy';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ENERGY_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunE = gun;\nvGunZ = position.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ENERGY_FRAG_PARS}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', ENERGY_FRAG);
  };
  m.customProgramCacheKey = () => 'railgun-3p-energy-2';
  return m;
}

// ── Claw flare ──────────────────────────────────────────────────────────────
// The shot cue on a third-person gun: a small camera-facing ring on the muzzle
// claw in the shooter's rail colour — ≤ 0.2 m across its radius, gone in
// ~90 ms, bright enough to catch the eye but too small to bloom over the
// shooter. Hidden (not drawn) between shots.
const CLAW_RADIUS = 0.2; // m
const CLAW_LIFE = 0.09; // s
let clawGeo: THREE.PlaneGeometry | null = null;
const CLAW_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vQ;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vQ = position.xy;
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;
const CLAW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uK;
varying vec2 vQ;
void main() {
  float r = length(vQ);
  if (r > 1.0 || uK <= 0.0) discard;
  float ring = exp(-pow((r - 0.55) / 0.14, 2.0));
  float core = exp(-r * r * 16.0);
  vec3 c = uColor * (ring * 1.5 + core * 2.0) * uK * (1.0 - r);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

// The gun attached to a combatant. A THREE.Group (callers that just hold it
// keep working) with drive hooks for remotes/bots.
export class AttachedRailgun extends THREE.Group {
  private readonly shell: THREE.Mesh<THREE.BufferGeometry, GunMaterial>;
  private readonly energy: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly claw: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly clawK = { value: 0 };
  private readonly u: EnergyUniforms = {
    uAccent: { value: new THREE.Color() },
    uHot: { value: new THREE.Color() },
    uRail: { value: new THREE.Color() },
    uDrive: { value: new THREE.Vector4(IDLE, 0, 1, 0) },
  };
  private hasRail = false;
  private fireMs = -1e9;
  private charge = 1;
  private chargeMs = -1e9; // last explicit setCharge

  constructor(finish?: RailgunFinish) {
    super();
    this.name = 'railgun-3p';
    const geo = railgunGeometrySplit('low');
    const f = finish ?? STOCK_FINISH;
    this.shell = new THREE.Mesh(geo.lit, shellMaterial(f));
    this.shell.name = 'railgun-3p-shell';
    this.shell.castShadow = true;
    // Geometry + material are shared caches: scene teardown must skip them.
    this.shell.userData.shared = true;
    this.shell.onBeforeRender = () => {
      const u = this.shell.material.gun;
      u.uTime.value = gunFx.reduced ? 0 : (nowMs() / 1000) % 3600;
      u.uCalm.value = gunFx.reduced ? 1 : 0;
    };
    this.energy = new THREE.Mesh(geo.energy, energyMaterial(this.u));
    this.energy.name = 'railgun-3p-energy';
    // Shared cached geometry: scene teardown must skip it (the per-gun
    // material is freed by dispose()).
    this.energy.userData.shared = true;
    this.energy.onBeforeRender = () => this.drive(nowMs());
    clawGeo ??= new THREE.PlaneGeometry(2, 2);
    this.claw = new THREE.Mesh(
      clawGeo,
      new THREE.ShaderMaterial({
        uniforms: { uColor: this.u.uRail, uK: this.clawK, uSize: { value: CLAW_RADIUS } },
        vertexShader: CLAW_VERT,
        fragmentShader: CLAW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.claw.name = 'railgun-3p-claw';
    this.claw.userData.shared = true; // shared quad; material freed by dispose()
    this.claw.position.set(0, BARREL_Y, MUZZLE_Z - 0.02);
    this.claw.frustumCulled = false;
    this.claw.visible = false;
    this.claw.renderOrder = 2;
    this.claw.onBeforeRender = () => this.drive(nowMs());
    this.add(this.shell, this.energy, this.claw);
    this.setFinish(f);
  }

  // Swap the finish: shared shell material + this gun's glow colours.
  setFinish(finish?: RailgunFinish) {
    const f = finish ?? STOCK_FINISH;
    this.shell.material = shellMaterial(f);
    this.u.uAccent.value.setHex(f.accent);
    this.u.uHot.value.setHex(f.accentHot);
    if (!this.hasRail) this.u.uRail.value.setHex(f.accentHot);
  }

  // A shot: the muzzle claw flashes (in `railColor`, the shooter's rail
  // colour, when given), the coils drop dark and relight over the rail
  // cooldown (unless setCharge drives the refill explicitly).
  notifyFire(railColor?: number) {
    this.fireMs = nowMs();
    this.clawK.value = 1;
    this.claw.visible = true;
    if (railColor !== undefined) {
      this.hasRail = true;
      this.u.uRail.value.setHex(railColor);
    }
  }

  // World position of the muzzle (the claw tip) into `out` — where a visible
  // beam / discharge from this gun should start.
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.updateWorldMatrix(true, false);
    return this.localToWorld(out.set(0, BARREL_Y, MUZZLE_Z));
  }

  // 0 = just fired … 1 = ready.
  setCharge(charge: number) {
    this.charge = Number.isFinite(charge) ? Math.max(0, Math.min(1, charge)) : 1;
    this.chargeMs = nowMs();
  }

  private drive(now: number) {
    const since = (now - this.fireMs) / 1000;
    // A short pulse (~100 ms) at the claw.
    const flash = since >= 0 && since < 0.3 ? Math.exp(-since * 24) : 0;
    const charge =
      now - this.chargeMs < EXTERNAL_LAPSE_MS ? this.charge : Math.max(0, Math.min(1, since / RAIL_COOLDOWN));
    const fill = Math.max(0, Math.min(1, (charge - 0.1) / 0.88));
    const d = this.u.uDrive.value;
    d.x = IDLE * (1 + FLASH * flash * 0.5);
    d.y = 0;
    d.z = fill;
    d.w = flash;
    // Claw flare: ≤ 90 ms. Visibility takes effect from the next frame (the
    // render list is already built), so it never lingers more than a frame.
    const k = since >= 0 && since < CLAW_LIFE ? Math.exp(-since * 22) : 0;
    this.clawK.value = k;
    if (k <= 0) this.claw.visible = false;
  }

  dispose() {
    this.removeFromParent();
    this.energy.material.dispose(); // the shell + geometry are shared caches
    this.claw.material.dispose();
  }
}

export function attachRailgun(ch: Character, finish?: RailgunFinish): AttachedRailgun {
  const g = new AttachedRailgun(finish);
  g.scale.setScalar(GUN_SCALE);
  g.position.copy(GUN_IN_SOCKET);
  ch.sockets.gun.add(g);
  return g;
}

export function disposeRailgun(g: THREE.Object3D | null): void {
  if (!g) return;
  if (g instanceof AttachedRailgun) {
    g.dispose();
    return;
  }
  g.parent?.remove(g);
}
