import * as THREE from 'three';
import { DYE_MODE, createCharacterMaterial, getBodyGeometry, resetDeathLook, tickDyeClock, type CharacterUniforms } from './body';
import type { DyeDef } from '../dyes';
import { B, Rig, SOCKETS, type SocketName } from './rig';
import { viewPos } from '../fx/fx-settings';

// One arena combatant: a Rig (flat bones + FK/IK), ONE SkinnedMesh sharing the
// cached body geometry, a per-instance material (for the player colour), and
// named sockets (helmet crown, gun hand, chest) that ride their bones.
//
// `root` is the object callers place/yaw; bones + mesh are its children.
// Nothing here affects gameplay — it's all visual.

// Bright, saturated "skins" (Quake Live forced-bright style). A player's
// natural colour is a stable pick from this list keyed by their name, so the
// same player reads the same colour everywhere (match, killcam, podium).
// Luminance-banded (fairness): relative luminance kept within ~0.32–0.60 so no
// name hashes to a skin that is markedly darker (harder to see) than another —
// the raw palette spanned 0.25 (cobalt/crimson) to 0.75 (volt), a 3× spread.
export const SKIN_PALETTE: readonly string[] = [
  '#ff6b4e', // blaze
  '#ffb21e', // amber
  '#99df2c', // lime
  '#1fd6a0', // jade
  '#27b8ff', // sky
  '#8791ff', // cobalt
  '#c976ff', // violet
  '#ff5fa5', // magenta
  '#e7cb34', // volt
  '#ff6873', // crimson
];

export function skinColorFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SKIN_PALETTE[(h >>> 0) % SKIN_PALETTE.length];
}

export type LookMode = 'natural' | 'highlight';

// Socket → owning combatant (lets socket-based APIs like the legacy WornHat
// reach the whole character). Weak: no retention, nothing on userData.
const SOCKET_OWNER = new WeakMap<THREE.Object3D, Character>();
export function characterOfSocket(socket: THREE.Object3D): Character | undefined {
  return SOCKET_OWNER.get(socket);
}

const WHITE = new THREE.Color(1, 1, 1);

// Remember the viewer (finishers aim their debris away from them). Module
// scope: one shared function for every combatant.
function recordViewer(_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera): void {
  tickDyeClock();
  const e = cam.matrixWorld.elements;
  viewPos.x = e[12];
  viewPos.y = e[13];
  viewPos.z = e[14];
  viewPos.set = true;
}

export class Character {
  readonly root = new THREE.Group();
  readonly rig: Rig;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: CharacterUniforms;
  readonly sockets: Record<SocketName, THREE.Object3D>;
  private readonly color = new THREE.Color();
  private mode: LookMode = 'natural';
  private dye: DyeDef | null = null;

  constructor(opts: { castShadow?: boolean; colorHex?: string } = {}) {
    this.root.name = 'combatant';
    const body = getBodyGeometry();
    const { material, uniforms } = createCharacterMaterial();
    this.material = material;
    this.uniforms = uniforms;
    this.rig = new Rig(this.root);
    this.mesh = new THREE.SkinnedMesh(body.geometry, material);
    this.mesh.name = 'combatant-body';
    this.mesh.castShadow = opts.castShadow ?? true;
    this.mesh.receiveShadow = false;
    // SkinnedMesh caches a bounding sphere computed ONCE from whatever pose the
    // bones hold at the first cull test (stale bones → a misplaced sphere → the
    // body culled while its shadow and nameplate still show). Give it a fixed,
    // generous local sphere instead: every pose and emote stays inside it (gibs
    // disable culling while they fly).
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.75);
    this.mesh.frustumCulled = true;
    this.mesh.onBeforeRender = recordViewer;
    this.root.add(this.mesh);
    this.mesh.bind(this.rig.skeleton, new THREE.Matrix4());
    // The body geometry is a module-level cache shared by every character:
    // tag it so Game.disposeScene() never frees it.
    this.mesh.userData.shared = true;
    for (const b of this.rig.bones) b.userData.shared = true;

    const sockets = {} as Record<SocketName, THREE.Object3D>;
    for (const name of Object.keys(SOCKETS) as SocketName[]) {
      const def = SOCKETS[name];
      const o = new THREE.Object3D();
      o.name = `socket.${name}`;
      o.position.set(def.pos[0], def.pos[1], def.pos[2]);
      this.rig.bones[def.bone].add(o);
      sockets[name] = o;
      SOCKET_OWNER.set(o, this);
    }
    this.sockets = sockets;
    // Hats report equip changes through the crown socket: hide the crest fin
    // under a hat so it never pokes through the brim.
    sockets.headTop.userData.onHatChange = (hasHat: boolean) => this.setCrestHidden(hasHat);
    this.setLook(opts.colorHex ?? SKIN_PALETTE[0], 'natural');
  }

  // Recolour the armour. `natural` = the player's own bright skin with a
  // subtle rim; `highlight` = the viewer's enemy-highlight / team colour,
  // pushed toward full-bright (Quake Live bright skins).
  setLook(color: THREE.Color | string, mode: LookMode = 'natural'): void {
    if (typeof color === 'string') this.color.set(color);
    else this.color.copy(color);
    this.mode = mode;
    const u = this.uniforms;
    u.uPlayer.value.copy(this.color);
    // Visor: a hot near-white core (blooms) fading to a saturated player-
    // colour edge; the light slits use the edge colour.
    u.uVisorCore.value.copy(this.color).lerp(WHITE, 0.8).multiplyScalar(mode === 'highlight' ? 3.0 : 2.6);
    u.uVisorEdge.value.copy(this.color).multiplyScalar(mode === 'highlight' ? 2.4 : 2.0);
    // Readability rim: a light tint of the skin colour, strong enough to read
    // as a thin outline at 30 m on same-hue walls. Same for every player.
    u.uRim.value.copy(this.color).lerp(WHITE, 0.15).multiplyScalar(1.15);
    u.uLift.value = mode === 'highlight' ? 0.55 : 0.22;
    u.uRimStr.value = mode === 'highlight' ? 1.6 : 1.15;
    // A plain look carries no dye pattern (highlight / team colours win).
    u.uDyeP.value.x = 0;
    u.uDyeF.value.set(-1, -1);
    this.dye = null;
  }

  // The natural look with a dye (dyes.ts): `null` = the name-keyed skin
  // `skinHex`. Callers only use this when neither a TDM team colour nor the
  // viewer's enemy highlight applies — those go through setLook and clear it.
  wearDye(dye: DyeDef | null, skinHex: string): void {
    if (!dye) {
      this.setLook(skinHex, 'natural');
      return;
    }
    this.setLook(dye.a, 'natural');
    this.dye = dye;
    const u = this.uniforms;
    u.uDyeP.value.set(DYE_MODE[dye.pattern], dye.speed ?? 1, dye.scale ?? 1, 0);
    u.uDyeA.value.set(dye.a);
    u.uDyeB.value.set(dye.b ?? dye.a);
    u.uDyeC.value.set(dye.c ?? dye.b ?? dye.a);
    if (dye.finish === 'matte') u.uDyeF.value.set(0.8, 0.04);
    else if (dye.finish === 'metal') u.uDyeF.value.set(0.26, 0.92);
    // Dark / glowing patterns: a stronger, lighter rim + visor so the
    // silhouette reads at least as well as a natural skin.
    switch (dye.pattern) {
      case 'void':
      case 'horizon':
        u.uRim.value.set(dye.b ?? '#e8f0ff').lerp(WHITE, 0.5).multiplyScalar(1.5);
        u.uRimStr.value = 1.9;
        u.uVisorEdge.value.set(dye.b ?? '#e8f0ff').multiplyScalar(2.2);
        break;
      case 'spectre':
      case 'hologram':
        u.uRim.value.set(dye.a).multiplyScalar(1.4);
        u.uRimStr.value = 1.7;
        break;
      case 'magma':
      case 'circuit':
      case 'nebula':
        u.uRim.value.set(dye.b ?? dye.a).lerp(WHITE, 0.2).multiplyScalar(1.3);
        u.uRimStr.value = 1.6;
        u.uVisorEdge.value.set(dye.b ?? dye.a).multiplyScalar(2.2);
        break;
      case 'chroma':
        u.uRim.value.set('#ffffff').multiplyScalar(1.1);
        break;
    }
  }

  get dyeId(): string | null {
    return this.dye?.id ?? null;
  }

  setCrestHidden(hidden: boolean): void {
    this.rig.boneScale[B.crest] = hidden ? 0.0001 : 1;
    this.rig.writeBones();
  }

  getColor(out: THREE.Color): THREE.Color {
    return out.copy(this.color);
  }

  get lookMode(): LookMode {
    return this.mode;
  }

  // Gib heat: glowing seams/silhouette in `color` (energy discharge on death).
  setGlow(v: number, color?: THREE.Color): void {
    this.uniforms.uGlow.value = v;
    if (color) this.uniforms.uGlowCol.value.copy(color);
  }

  // Gib char: 0 = clean paint … 1 = scorched plates.
  setBurn(v: number): void {
    this.uniforms.uBurn.value = v;
  }

  // Back to a living body: clears every death-animation look (glow, char,
  // dissolve, ash, crystal, derez bands, overload veins, rainbow).
  resetDeathLook(): void {
    resetDeathLook(this.uniforms);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.material.dispose();
    this.rig.skeleton.dispose();
  }
}
