import * as THREE from 'three';
import { createCharacterMaterial, getBodyGeometry, type CharacterUniforms } from './body';
import { B, Rig, SOCKETS, type SocketName } from './rig';

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

const WHITE = new THREE.Color(1, 1, 1);

export class Character {
  readonly root = new THREE.Group();
  readonly rig: Rig;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: CharacterUniforms;
  readonly sockets: Record<SocketName, THREE.Object3D>;
  private readonly color = new THREE.Color();
  private mode: LookMode = 'natural';

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

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.material.dispose();
    this.rig.skeleton.dispose();
  }
}
