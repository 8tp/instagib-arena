import * as THREE from 'three';

// Procedural railgun (no external asset — matches the game's all-procedural art
// pipeline). Built pointing down -Z (the camera's forward), so it can be
// parented straight to the camera as a first-person viewmodel, or dropped onto a
// soldier (who also faces -Z) as a third-person weapon.

const COL_BODY = 0x1b1f27; // near-black receiver
const COL_METAL = 0x2f3744; // gunmetal
const COL_METAL_LT = 0x4a5566; // lighter frame edges
const COL_ACCENT = 0x37a6ff; // rail blue (matches the beam)
const COL_ACCENT_HOT = 0x67e8f9; // bright cyan energy

function metal(color: number, rough = 0.42): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: rough });
}

export type RailgunModel = {
  group: THREE.Group;
  muzzle: THREE.Object3D; // barrel-tip marker
  glow: THREE.MeshStandardMaterial; // shared emissive (pulse this for feedback)
};

// Canonical railgun, ~1.25 units long, grip near origin, barrel down -Z.
export function buildRailgun(): RailgunModel {
  const group = new THREE.Group();

  // One shared emissive material for every glowing part, so callers can pulse
  // the whole gun's energy on fire by animating a single material.
  const glow = new THREE.MeshStandardMaterial({
    color: COL_ACCENT_HOT,
    emissive: new THREE.Color(COL_ACCENT_HOT),
    emissiveIntensity: 1.3,
    metalness: 0.2,
    roughness: 0.3,
  });
  const glowDim = new THREE.MeshStandardMaterial({
    color: COL_ACCENT,
    emissive: new THREE.Color(COL_ACCENT),
    emissiveIntensity: 0.9,
    metalness: 0.3,
    roughness: 0.35,
  });

  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos: [number, number, number],
    rot?: [number, number, number],
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    group.add(m);
    return m;
  };

  // ── Receiver: a chunky beveled body + a raised spine ───────────────────
  add(new THREE.BoxGeometry(0.17, 0.19, 0.6), metal(COL_BODY), [0, 0, 0]);
  add(new THREE.BoxGeometry(0.2, 0.06, 0.5), metal(COL_METAL_LT, 0.3), [0, 0.11, -0.02]); // top plate
  add(new THREE.BoxGeometry(0.19, 0.1, 0.18), metal(COL_METAL), [0, -0.02, 0.24]); // rear block

  // Energy core slot down the spine — the brightest piece (pulses on fire).
  add(new THREE.BoxGeometry(0.05, 0.05, 0.46), glow, [0, 0.12, -0.04]);

  // ── Barrel: stepped — heavy shroud, then a thinner rifled barrel ───────
  add(new THREE.CylinderGeometry(0.07, 0.075, 0.3, 12), metal(COL_METAL), [0, 0.02, -0.42], [Math.PI / 2, 0, 0]); // shroud
  add(new THREE.CylinderGeometry(0.045, 0.048, 0.62, 10), metal(COL_METAL_LT, 0.3), [0, 0.02, -0.82], [Math.PI / 2, 0, 0]); // barrel

  // Coil housing + energy rings around the shroud.
  for (let i = 0; i < 4; i++) {
    add(
      new THREE.TorusGeometry(0.082, 0.016, 8, 18),
      i % 2 === 0 ? glow : glowDim,
      [0, 0.02, -0.32 - i * 0.085],
      [0, 0, 0],
    );
  }
  // Two side fins on the shroud for a heavier silhouette.
  add(new THREE.BoxGeometry(0.02, 0.13, 0.26), metal(COL_METAL), [0.085, 0.02, -0.42]);
  add(new THREE.BoxGeometry(0.02, 0.13, 0.26), metal(COL_METAL), [-0.085, 0.02, -0.42]);

  // ── Muzzle brake: a forked tip + a bright ring, plus the muzzle marker ──
  add(new THREE.CylinderGeometry(0.06, 0.055, 0.12, 10), metal(COL_METAL), [0, 0.02, -1.13], [Math.PI / 2, 0, 0]);
  add(new THREE.TorusGeometry(0.058, 0.018, 8, 18), glow, [0, 0.02, -1.18]);
  add(new THREE.BoxGeometry(0.13, 0.02, 0.1), metal(COL_METAL_LT), [0, 0.06, -1.14]); // top prong
  add(new THREE.BoxGeometry(0.13, 0.02, 0.1), metal(COL_METAL_LT), [0, -0.02, -1.14]); // bottom prong

  // ── Grip + trigger guard ───────────────────────────────────────────────
  add(new THREE.BoxGeometry(0.09, 0.28, 0.13), metal(COL_BODY), [0, -0.22, 0.13], [0.34, 0, 0]);
  add(new THREE.TorusGeometry(0.06, 0.012, 6, 14), metal(COL_METAL), [0, -0.12, 0.06], [Math.PI / 2, 0, 0]); // guard

  // ── Top sight ───────────────────────────────────────────────────────────
  add(new THREE.BoxGeometry(0.04, 0.06, 0.12), metal(COL_METAL_LT), [0, 0.18, 0.06]);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -1.22);
  group.add(muzzle);

  return { group, muzzle, glow };
}

// Attach a third-person railgun to a soldier model root. The soldier faces -Z at
// identity, so a -Z gun points where they look. Parked at the right-hand area.
export function attachRailgunToSoldier(root: THREE.Object3D, height = 1.8): THREE.Group {
  const { group } = buildRailgun();
  group.scale.setScalar(0.42);
  group.position.set(0.26, height * 0.62, -0.2);
  root.add(group);
  return group;
}
