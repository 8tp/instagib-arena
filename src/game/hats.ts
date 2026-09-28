import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hatById, unusualById, type UnusualKind } from './cosmetics';
import { UnusualEffect } from './fx/unusuals';

// Hats: a glTF model worn on the combatant's helmet. The hat container is a
// child of the character's `headTop` socket (see character/rig.ts), so it
// rides the head bone through every pose, emote and gib with no per-frame
// follow code. Auto-fit scales each hat to a target width from its own
// bounding box; per-hat `fit/sink/stretch/yaw` come from the catalog, with
// helmet-specific corrections in HELMET_FIT below.

// The helmet is ~0.29 m wide x 0.33 m deep; hats sit a touch wider.
const TARGET_WIDTH = 0.36;
// Seat corrections for the combatant's helmet (the catalog values were tuned
// on the old soldier's bare head): extra drop (m), size multiplier, and a
// forward/back nudge so brims clear the visor.
const HELMET_FIT: Record<string, { sink?: number; fit?: number; z?: number; tilt?: number }> = {
  'hat.cap': { sink: 0.11, fit: 1.0, z: 0.0, tilt: -0.06 },
  'hat.baseball': { sink: 0.135, fit: 0.98, z: 0.005, tilt: -0.06 },
  'hat.hardhat': { sink: 0.125, fit: 1.0 },
  'hat.graduation': { sink: 0.15, fit: 1.0 },
  'hat.tophat': { sink: 0.05, fit: 0.95 },
  'hat.propeller': { sink: 0.115, fit: 1.0 },
  'hat.wizard': { sink: 0.085, fit: 1.0 },
  'hat.crown': { sink: 0.055, fit: 1.05 },
};

const loader = new GLTFLoader();
const sourceCache = new Map<string, Promise<THREE.Object3D>>();

// Load (once, cached) a hat glTF scene. Clones are taken per-wearer.
function loadHatSource(path: string): Promise<THREE.Object3D> {
  let p = sourceCache.get(path);
  if (!p) {
    p = loader.loadAsync(path).then((g) => g.scene);
    sourceCache.set(path, p);
  }
  return p;
}

// Unusual particle effects (the crown worn above the hat) live in
// fx/unusuals.ts — one world-space point cloud per wearer, FOV-correct,
// distance-LOD'd and quality-aware.

// One worn hat instance, parented to the wearer's helmet-crown socket.
export class WornHat {
  private container = new THREE.Group();
  // Anchor the unusual effect rides in — its local Y tracks the top of the
  // equipped hat so the effect crowns the hat (not the head) regardless of height.
  private unusualAnchor = new THREE.Group();
  private current = ''; // equipped hat id
  private token = 0; // guards against a slow load finishing after a later setHat
  private unusual: UnusualEffect | null = null;
  private unusualKind: UnusualKind = 'none';
  private hatTop = 0.04; // top of the equipped hat in container-local metres

  constructor(private socket: THREE.Object3D) {
    this.container.name = 'hat';
    this.container.add(this.unusualAnchor);
    socket.add(this.container);
    this.layoutUnusual();
  }

  // Equip a hat by cosmetic id (e.g. 'hat.tophat'); 'hat.none' / unknown = bare.
  async setHat(id: string): Promise<void> {
    if (id === this.current) return;
    this.current = id;
    const my = ++this.token;
    this.clearMesh();
    const hat = hatById(id);
    this.hatTop = 0.04; // bare helmet: the crest
    this.notifyHat(false);
    if (!hat.model) {
      this.layoutUnusual();
      return; // bare-headed
    }
    let src: THREE.Object3D;
    try {
      src = await loadHatSource(hat.model);
    } catch {
      return; // missing/broken model → just stay bare
    }
    if (this.token !== my) return; // superseded by a later setHat

    const fix = HELMET_FIT[id] ?? {};
    const mesh = src.clone(true);
    // Center on X/Z and drop the bottom to Y=0 (at native scale), then uniformly
    // scale so the widest horizontal extent is TARGET_WIDTH.
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.set(-center.x, -box.min.y, -center.z);
    const holder = new THREE.Group();
    holder.add(mesh);
    const s = ((hat.fit ?? 1) * (fix.fit ?? 1) * TARGET_WIDTH) / Math.max(size.x, size.z, 1e-6);
    const stretch = hat.stretch ?? 1;
    holder.scale.set(s, s * stretch, s);
    // Per-hat yaw so the brim faces the wearer's front (catalog), then a small
    // forward tilt so brims ride the helmet's slope.
    holder.rotation.set(fix.tilt ?? 0, hat.yaw ?? 0, 0, 'XYZ');
    const sink = (hat.sink ?? 0) + (fix.sink ?? 0);
    holder.position.set(0, -sink, fix.z ?? 0);
    this.hatTop = size.y * s * stretch - sink;
    // Tag shared so Game.disposeScene() never disposes the cached geometry.
    holder.traverse((o) => {
      o.userData.shared = true;
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.container.add(holder);
    this.notifyHat(true);
    this.layoutUnusual();
  }

  // Tell the wearer (via the socket) whether a hat is on — the combatant hides
  // its helmet crest under hats.
  private notifyHat(on: boolean) {
    const cb = this.socket.userData.onHatChange as ((on: boolean) => void) | undefined;
    cb?.(on);
  }

  // Seat the unusual anchor just above the equipped hat's crown.
  private layoutUnusual() {
    this.unusualAnchor.position.y = Math.max(this.hatTop, 0.03) + 0.05;
  }

  // Equip an unusual particle effect (worn above the hat). 'unusual.none' = off.
  setUnusual(id: string): void {
    const kind = unusualById(id).kind;
    if (kind === this.unusualKind) return;
    this.unusualKind = kind;
    this.unusual?.dispose();
    this.unusual = null;
    if (kind !== 'none') {
      this.unusual = new UnusualEffect(kind);
      this.unusualAnchor.add(this.unusual.group);
    }
  }

  // Animate the unusual. (The hat itself rides the head socket — no follow.)
  update(dt: number): void {
    this.unusual?.update(dt);
  }

  setVisible(v: boolean): void {
    this.container.visible = v;
  }

  // Remove the hat holder(s) but KEEP the unusualAnchor (it carries the effect
  // and is re-seated by layoutUnusual on the next setHat).
  private clearMesh(): void {
    for (let i = this.container.children.length - 1; i >= 0; i--) {
      const c = this.container.children[i];
      if (c !== this.unusualAnchor) this.container.remove(c);
    }
  }

  dispose(): void {
    this.unusual?.dispose();
    this.unusual = null;
    this.clearMesh();
    this.socket.remove(this.container);
  }
}
