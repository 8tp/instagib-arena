import * as THREE from 'three';

// Procedural railgun model (no external asset — matches the game's all-procedural
// art pipeline). Built pointing down -Z (the camera's forward), so it can be
// parented straight to the camera as a first-person viewmodel, or dropped onto a
// soldier (who also faces -Z) as a third-person weapon.

const COL_BODY = 0x20242e; // dark receiver
const COL_METAL = 0x39424f; // barrel / frame metal
const COL_ACCENT = 0x37a6ff; // rail blue (matches the beam)
const COL_ACCENT_HOT = 0x67e8f9; // bright cyan coils

function metal(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: 0.4 });
}
function accent(color: number, intensity = 1.2): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    metalness: 0.3,
    roughness: 0.3,
  });
}

// Builds the railgun centered roughly on its grip, barrel extending toward -Z.
// Returns the group plus a `muzzle` node parked at the barrel tip.
export function buildRailgun(): { group: THREE.Group; muzzle: THREE.Object3D } {
  const group = new THREE.Group();

  // Receiver / body block.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.55), metal(COL_BODY));
  body.position.set(0, 0, -0.05);
  group.add(body);

  // Barrel — long octagonal cylinder down -Z.
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.055, 0.95, 8),
    metal(COL_METAL),
  );
  barrel.rotation.x = Math.PI / 2; // cylinder default +Y → lay along Z
  barrel.position.set(0, 0.02, -0.62);
  group.add(barrel);

  // Energy coils around the barrel — emissive rings that read as "charged".
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.018, 8, 16),
      accent(i === 1 ? COL_ACCENT_HOT : COL_ACCENT, 1.4),
    );
    ring.position.set(0, 0.02, -0.4 - i * 0.22);
    group.add(ring);
  }

  // A glowing rail strip along the top of the receiver.
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.5), accent(COL_ACCENT_HOT, 1.6));
  strip.position.set(0, 0.12, -0.05);
  group.add(strip);

  // Muzzle ring + node at the tip.
  const muzzleRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.06, 0.02, 8, 16),
    accent(COL_ACCENT_HOT, 1.8),
  );
  muzzleRing.rotation.y = 0;
  muzzleRing.position.set(0, 0.02, -1.08);
  group.add(muzzleRing);

  // Grip angled down/back.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.26, 0.12), metal(COL_BODY));
  grip.position.set(0, -0.2, 0.12);
  grip.rotation.x = 0.32;
  group.add(grip);

  // Sight block.
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.1), metal(COL_METAL));
  sight.position.set(0, 0.16, 0.05);
  group.add(sight);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -1.12);
  group.add(muzzle);

  return { group, muzzle };
}

// Attach a third-person railgun to a soldier model root. The soldier faces -Z at
// identity, so a -Z gun points where they look. Parked at the right-hand area;
// scale tunes it to the model.
export function attachRailgunToSoldier(root: THREE.Object3D, height = 1.8): THREE.Group {
  const { group } = buildRailgun();
  const s = 0.42;
  group.scale.setScalar(s);
  // Right side, ~chest/hand height, a touch forward.
  group.position.set(0.26, height * 0.62, -0.2);
  root.add(group);
  return group;
}
