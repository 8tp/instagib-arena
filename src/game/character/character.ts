import * as THREE from 'three';
import { createCharacterMaterial, getBodyGeometry, type CharacterUniforms } from './body';
import { Rig, SOCKETS, type SocketName } from './rig';

// One arena combatant: a Rig (flat bones + FK/IK), ONE SkinnedMesh sharing the
// cached body geometry, a per-instance material (for the player colour), and
// named sockets (helmet crown, gun hand, chest) that ride their bones.
//
// `root` is the object callers place/yaw; bones + mesh are its children.
// Nothing here affects gameplay — it's all visual.

// Bright, saturated "skins" (Quake Live forced-bright style). A player's
// natural colour is a stable pick from this list keyed by their name, so the
// same player reads the same colour everywhere (match, killcam, podium).
export const SKIN_PALETTE: readonly string[] = [
  '#ff5a2e', // blaze
  '#ffb21e', // amber
  '#9be22d', // lime
  '#1fd6a0', // jade
  '#27b8ff', // sky
  '#6f7cff', // cobalt
  '#c565ff', // violet
  '#ff4fa0', // magenta
  '#ffe03a', // volt
  '#ff3b4f', // crimson
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
    // Visor: a hot, pale version of the skin colour (reads as "the face").
    u.uVisor.value.copy(this.color).lerp(WHITE, 0.55).multiplyScalar(mode === 'highlight' ? 2.6 : 2.2);
    u.uRim.value.copy(this.color).lerp(WHITE, 0.3);
    u.uLift.value = mode === 'highlight' ? 0.55 : 0.14;
    u.uRimStr.value = mode === 'highlight' ? 1.1 : 0.6;
  }

  getColor(out: THREE.Color): THREE.Color {
    return out.copy(this.color);
  }

  get lookMode(): LookMode {
    return this.mode;
  }

  // Gib heat: 0..1 glow over the whole body (energy discharge on death).
  setGlow(v: number, color?: THREE.Color): void {
    this.uniforms.uGlow.value = v;
    if (color) this.uniforms.uGlowCol.value.copy(color);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.material.dispose();
    this.rig.skeleton.dispose();
  }
}
