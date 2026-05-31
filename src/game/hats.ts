import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hatById, unusualById, type UnusualKind } from './cosmetics';

// Hats: a glTF model worn on a player model's head. Attachment is a world-space
// follower — each frame we read the wearer's `mixamorigHead` world position and
// seat an auto-fit hat on the crown, facing the body's yaw. Auto-fit (scale to a
// target width from the model's own bounding box) was verified across hats whose
// source scales ranged from 3 to 300 units, so no per-hat tuning is needed.

const TARGET_WIDTH = 0.22; // metres — fits the soldier head
const CROWN_OFFSET = 0.22; // metres above the head bone where the hat sits

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

// An "unusual" particle effect worn above the hat. A small set of looping,
// additive emitters animated per frame. Geometry/materials are per-instance and
// disposed on dispose() (tagged `shared` so Game.disposeScene leaves them to us).
function additiveMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

class UnusualEffect {
  readonly group = new THREE.Group();
  private motes: THREE.Mesh[] = [];
  private phases: number[] = [];
  private extra: THREE.Mesh | null = null;
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private t = 0;

  constructor(private kind: UnusualKind) {
    this.group.position.y = 0.27; // sit just above the hat crown
    this.build();
    this.group.traverse((o) => {
      o.userData.shared = true;
    });
  }

  private mote(geom: THREE.BufferGeometry, color: number, opacity = 1): THREE.Mesh {
    const mat = additiveMat(color, opacity);
    this.mats.push(mat);
    const m = new THREE.Mesh(geom, mat);
    this.group.add(m);
    return m;
  }

  private build() {
    const moteGeom = new THREE.IcosahedronGeometry(0.022, 0);
    this.geoms.push(moteGeom);
    if (this.kind === 'embers') {
      for (let i = 0; i < 12; i++) {
        this.motes.push(this.mote(moteGeom, i % 3 === 0 ? 0xffd27a : 0xff6a1a));
        this.phases.push(Math.random());
      }
    } else if (this.kind === 'orbit') {
      for (let i = 0; i < 7; i++) {
        this.motes.push(this.mote(moteGeom, 0x7fe6ff));
        this.phases.push((i / 7) * Math.PI * 2);
      }
    } else if (this.kind === 'halo') {
      const torus = new THREE.TorusGeometry(0.16, 0.018, 8, 28);
      this.geoms.push(torus);
      this.extra = new THREE.Mesh(torus, additiveMat(0xfff2c0, 0.9));
      this.mats.push(this.extra.material as THREE.Material);
      this.extra.rotation.x = Math.PI / 2;
      this.group.add(this.extra);
      for (let i = 0; i < 5; i++) {
        this.motes.push(this.mote(moteGeom, 0xffe08a));
        this.phases.push((i / 5) * Math.PI * 2);
      }
    } else if (this.kind === 'storm') {
      // a little cloud (overlapping spheres) + spark motes below it
      const cloud = new THREE.SphereGeometry(0.07, 10, 8);
      this.geoms.push(cloud);
      for (const [dx, dy, dz, s] of [
        [0, 0.06, 0, 1],
        [-0.06, 0.04, 0.01, 0.8],
        [0.06, 0.04, -0.01, 0.8],
      ] as const) {
        const m = new THREE.Mesh(cloud, additiveMat(0x9fb4cc, 0.5));
        this.mats.push(m.material as THREE.Material);
        m.position.set(dx, dy + 0.06, dz);
        m.scale.setScalar(s);
        this.group.add(m);
      }
      for (let i = 0; i < 6; i++) {
        this.motes.push(this.mote(moteGeom, 0xa8d8ff));
        this.phases.push(Math.random());
      }
    }
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    if (this.kind === 'embers') {
      for (let i = 0; i < this.motes.length; i++) {
        const f = (t * 0.7 + this.phases[i]) % 1;
        const m = this.motes[i];
        const a = this.phases[i] * Math.PI * 2;
        m.position.set(Math.cos(a + t) * 0.05 * (1 - f), f * 0.5, Math.sin(a + t) * 0.05 * (1 - f));
        (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f) ** 1.3;
      }
    } else if (this.kind === 'orbit') {
      for (let i = 0; i < this.motes.length; i++) {
        const a = this.phases[i] + t * 2.2;
        this.motes[i].position.set(Math.cos(a) * 0.18, 0.04 + 0.03 * Math.sin(a * 2), Math.sin(a) * 0.18);
      }
    } else if (this.kind === 'halo') {
      if (this.extra) {
        this.extra.rotation.z = t * 0.8;
        (this.extra.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.25 * Math.sin(t * 3);
      }
      for (let i = 0; i < this.motes.length; i++) {
        const a = this.phases[i] + t * 1.4;
        this.motes[i].position.set(Math.cos(a) * 0.16, 0.0, Math.sin(a) * 0.16);
      }
    } else if (this.kind === 'storm') {
      this.group.position.y = 0.3 + 0.02 * Math.sin(t * 2);
      for (let i = 0; i < this.motes.length; i++) {
        const f = (t * 1.6 + this.phases[i]) % 1;
        const m = this.motes[i];
        m.position.set((this.phases[i] - 0.5) * 0.14, 0.06 - f * 0.16, 0);
        (m.material as THREE.MeshBasicMaterial).opacity = f < 0.15 || f > 0.85 ? 1 : 0.15;
      }
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// One worn hat instance. The container is parented to the wearer's top-level
// `group` (not the cm-scaled rig), so it inherits position/visibility — but it's
// re-seated each frame from the head bone's WORLD position, dodging the rig's
// distorted bone frame entirely.
export class WornHat {
  private container = new THREE.Group();
  private head: THREE.Object3D | null;
  private current = ''; // equipped hat id
  private token = 0; // guards against a slow load finishing after a later setHat
  private unusual: UnusualEffect | null = null;
  private unusualKind: UnusualKind = 'none';
  private readonly tmp = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private parent: THREE.Object3D,
    private modelRoot: THREE.Object3D,
  ) {
    this.head =
      modelRoot.getObjectByName('mixamorigHead') ??
      modelRoot.getObjectByName('mixamorig:Head') ??
      modelRoot.getObjectByName('Head') ??
      null;
    parent.add(this.container);
  }

  // Equip a hat by cosmetic id (e.g. 'hat.tophat'); 'hat.none' / unknown = bare.
  async setHat(id: string): Promise<void> {
    if (id === this.current) return;
    this.current = id;
    const my = ++this.token;
    this.clearMesh();
    const hat = hatById(id);
    if (!hat.model) return; // bare-headed
    let src: THREE.Object3D;
    try {
      src = await loadHatSource(hat.model);
    } catch {
      return; // missing/broken model → just stay bare
    }
    if (this.token !== my) return; // superseded by a later setHat

    const mesh = src.clone(true);
    // Center on X/Z and drop the bottom to Y=0 (at native scale), then uniformly
    // scale so the widest horizontal extent is TARGET_WIDTH.
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.set(-center.x, -box.min.y, -center.z);
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.scale.setScalar(TARGET_WIDTH / Math.max(size.x, size.z, 1e-6));
    // Tag shared so Game.disposeScene() never disposes the cached geometry.
    holder.traverse((o) => {
      o.userData.shared = true;
    });
    this.container.add(holder);
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
      this.container.add(this.unusual.group);
    }
  }

  // Seat the hat on the wearer's head each frame. Updates the bone's world matrix
  // first (the animation mixer only writes bone-LOCAL transforms), then converts
  // the head world position into the parent group's local frame.
  update(dt: number): void {
    this.unusual?.update(dt);
    if (!this.head) return;
    this.head.updateWorldMatrix(true, false); // refresh head + ancestors' world matrices
    this.head.getWorldPosition(this.tmp);
    this.parent.worldToLocal(this.tmp); // group has no rotation/scale → just an offset
    // The unusual effect rides above the head even when bare (no hat mesh).
    if (this.container.children.length === 0) return;
    this.container.position.set(this.tmp.x, this.tmp.y + CROWN_OFFSET, this.tmp.z);
    this.modelRoot.getWorldQuaternion(this.q);
    this.euler.setFromQuaternion(this.q, 'YXZ');
    this.container.rotation.y = this.euler.y;
  }

  setVisible(v: boolean): void {
    this.container.visible = v;
  }

  private clearMesh(): void {
    for (let i = this.container.children.length - 1; i >= 0; i--) {
      this.container.remove(this.container.children[i]);
    }
  }

  dispose(): void {
    this.unusual?.dispose();
    this.unusual = null;
    this.clearMesh();
    this.parent.remove(this.container);
    this.head = null;
  }
}
