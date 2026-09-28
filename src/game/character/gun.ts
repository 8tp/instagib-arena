import * as THREE from 'three';
import type { RailgunFinish } from '../cosmetics';
import { RAIL_COOLDOWN } from '../constants';
import { nowMs } from '../fx/rail-state';
import { COIL_COUNT, PART, railgunGeometrySplit } from '../gun/gun-geometry';
import { GunMaterial, STOCK_FINISH } from '../gun/gun-material';
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
// Two draws per gun (+ the shell's shadow).

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
// fill front → back with the charge like the first-person meter.
const ENERGY_VERT_PARS = /* glsl */ `
attribute vec3 gun;
varying vec3 vGunE;
`;
const ENERGY_FRAG_PARS = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uHot;
uniform vec4 uDrive; // x = level, y = hot mix, z = coil fill 0…1, w = flash
varying vec3 vGunE;
`;
const ENERGY_FRAG = /* glsl */ `
  int part = int(vGunE.x + 0.5);
  float k = 1.0;
  float hot = uDrive.y;
  if (part >= ${PART.COIL0}) {
    float p = clamp(uDrive.z * ${COIL_COUNT}.0 - float(part - ${PART.COIL0}), 0.0, 1.0);
    k = mix(0.08, 1.0, p * p * (3.0 - 2.0 * p)) + uDrive.w * 2.5;
  } else if (part == ${PART.CORE}) {
    k = mix(0.1, 0.95, uDrive.z) + uDrive.w * 3.0;
  } else if (part == ${PART.WINDOW}) {
    k = 0.8;
  } else if (part == ${PART.CAP}) {
    k = 0.7;
  } else {
    hot = min(1.0, hot + 0.55); // status strips + emitter ring
  }
  vec4 diffuseColor = vec4(mix(uAccent, uHot, hot) * k * uDrive.x, opacity);
`;

type EnergyUniforms = {
  uAccent: { value: THREE.Color };
  uHot: { value: THREE.Color };
  uDrive: { value: THREE.Vector4 };
};

function energyMaterial(u: EnergyUniforms): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  m.name = 'railgun-3p-energy';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ENERGY_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunE = gun;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ENERGY_FRAG_PARS}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', ENERGY_FRAG);
  };
  m.customProgramCacheKey = () => 'railgun-3p-energy-1';
  return m;
}

// The gun attached to a combatant. A THREE.Group (callers that just hold it
// keep working) with drive hooks for remotes/bots.
export class AttachedRailgun extends THREE.Group {
  private readonly shell: THREE.Mesh<THREE.BufferGeometry, GunMaterial>;
  private readonly energy: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly u: EnergyUniforms = {
    uAccent: { value: new THREE.Color() },
    uHot: { value: new THREE.Color() },
    uDrive: { value: new THREE.Vector4(IDLE, 0, 1, 0) },
  };
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
      this.shell.material.gun.uTime.value = (nowMs() / 1000) % 3600;
    };
    this.energy = new THREE.Mesh(geo.energy, energyMaterial(this.u));
    this.energy.name = 'railgun-3p-energy';
    this.energy.onBeforeRender = () => this.drive(nowMs());
    this.add(this.shell, this.energy);
    this.setFinish(f);
  }

  // Swap the finish: shared shell material + this gun's glow colours.
  setFinish(finish?: RailgunFinish) {
    const f = finish ?? STOCK_FINISH;
    this.shell.material = shellMaterial(f);
    this.u.uAccent.value.setHex(f.accent);
    this.u.uHot.value.setHex(f.accentHot);
  }

  // A shot: flash, drop dark, refill over the rail cooldown (unless setCharge
  // drives the refill explicitly).
  notifyFire() {
    this.fireMs = nowMs();
  }

  // 0 = just fired … 1 = ready.
  setCharge(charge: number) {
    this.charge = Number.isFinite(charge) ? Math.max(0, Math.min(1, charge)) : 1;
    this.chargeMs = nowMs();
  }

  private drive(now: number) {
    const since = (now - this.fireMs) / 1000;
    const flash = since >= 0 && since < 0.5 ? Math.exp(-since * 18) : 0;
    const charge =
      now - this.chargeMs < EXTERNAL_LAPSE_MS ? this.charge : Math.max(0, Math.min(1, since / RAIL_COOLDOWN));
    const fill = Math.max(0, Math.min(1, (charge - 0.1) / 0.88));
    const d = this.u.uDrive.value;
    d.x = IDLE * (1 + FLASH * flash);
    d.y = Math.min(1, flash * 1.5);
    d.z = fill;
    d.w = flash;
  }

  dispose() {
    this.removeFromParent();
    this.energy.material.dispose(); // the shell + geometry are shared caches
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
