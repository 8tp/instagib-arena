import * as THREE from 'three';

// Procedural railgun (no external asset — matches the game's all-procedural art
// pipeline). Built pointing down -Z (the camera's forward), grip near the
// origin, so it can be parented straight to the camera as a first-person
// viewmodel, or seated in a soldier's right hand (the soldier also faces -Z) as
// a third-person weapon.
//
// Silhouette: a compact gunmetal receiver, an angled grip, and a twin-rail
// accelerator — two glowing energy rails running the length of the barrel with
// a slug channel between them and focusing coils around it. The rails read as
// "railgun" instantly and, because the bright mass sits in two thin side rails
// (not a fat centre block), it stays out of the player's line of sight as a
// viewmodel.

const COL_BODY = 0x171b22; // near-black receiver
const COL_METAL = 0x2c333f; // gunmetal
const COL_METAL_LT = 0x515d6e; // lighter frame edges
const COL_ACCENT = 0x37a6ff; // rail blue (matches the beam)
const COL_ACCENT_HOT = 0x8af2ff; // bright cyan energy

function metal(color: number, rough = 0.4): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.88, roughness: rough });
}

export type RailgunModel = {
  group: THREE.Group;
  muzzle: THREE.Object3D; // barrel-tip marker (beam origin for third-person)
  glow: THREE.MeshStandardMaterial; // shared emissive (pulse this on fire)
};

// Canonical railgun, ~0.95 units long, grip at the origin, barrel down -Z.
export function buildRailgun(): RailgunModel {
  const group = new THREE.Group();

  // One shared emissive material for the energy parts so a caller can pulse the
  // whole gun's glow on fire by animating a single material.
  const glow = new THREE.MeshStandardMaterial({
    color: COL_ACCENT_HOT,
    emissive: new THREE.Color(COL_ACCENT_HOT),
    emissiveIntensity: 1.7,
    metalness: 0.2,
    roughness: 0.25,
  });
  const glowDim = new THREE.MeshStandardMaterial({
    color: COL_ACCENT,
    emissive: new THREE.Color(COL_ACCENT),
    emissiveIntensity: 1.0,
    metalness: 0.3,
    roughness: 0.3,
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

  // ── Receiver: a compact body, chamfered top cover, sloped rear ──────────
  add(new THREE.BoxGeometry(0.14, 0.13, 0.42), metal(COL_BODY), [0, 0.02, 0.04]);
  add(new THREE.BoxGeometry(0.12, 0.045, 0.4), metal(COL_METAL_LT, 0.3), [0, 0.095, 0.02]); // top cover
  add(new THREE.BoxGeometry(0.13, 0.14, 0.1), metal(COL_METAL), [0, 0.0, 0.25], [-0.32, 0, 0]); // sloped rear/stock
  // Side cheeks for a heavier, machined look.
  add(new THREE.BoxGeometry(0.02, 0.1, 0.34), metal(COL_METAL), [0.072, 0.01, 0.04]);
  add(new THREE.BoxGeometry(0.02, 0.1, 0.34), metal(COL_METAL), [-0.072, 0.01, 0.04]);

  // Glowing charge cell tucked into the receiver side (the battery).
  add(new THREE.BoxGeometry(0.025, 0.07, 0.2), glow, [0.083, 0.0, 0.06]);
  add(new THREE.BoxGeometry(0.025, 0.07, 0.2), glow, [-0.083, 0.0, 0.06]);

  // ── Accelerator: central slug channel + twin energy rails ───────────────
  // Central barrel (octagonal) — the slug channel.
  add(new THREE.CylinderGeometry(0.032, 0.032, 0.66, 8), metal(COL_METAL_LT, 0.25), [0, 0.03, -0.42], [Math.PI / 2, 0, Math.PI / 8]);
  // Twin rails: two bright bars flanking the channel — the signature feature.
  add(new THREE.BoxGeometry(0.022, 0.05, 0.6), glow, [0.06, 0.055, -0.4]);
  add(new THREE.BoxGeometry(0.022, 0.05, 0.6), glow, [-0.06, 0.055, -0.4]);
  // Rail spine running between them along the top.
  add(new THREE.BoxGeometry(0.03, 0.022, 0.58), glowDim, [0, 0.085, -0.4]);
  // Rail bridges: machined ribs that tie the rails to the channel.
  for (let i = 0; i < 4; i++) {
    add(new THREE.BoxGeometry(0.16, 0.018, 0.03), metal(COL_METAL), [0, 0.05, -0.18 - i * 0.16]);
  }
  // Focusing coils around the channel, alternating bright/blue.
  for (let i = 0; i < 3; i++) {
    add(
      new THREE.TorusGeometry(0.05, 0.013, 8, 18),
      i % 2 === 0 ? glow : glowDim,
      [0, 0.03, -0.26 - i * 0.2],
    );
  }

  // ── Muzzle: a focusing aperture + bright ring + the muzzle marker ───────
  add(new THREE.CylinderGeometry(0.05, 0.045, 0.1, 10), metal(COL_METAL), [0, 0.03, -0.78], [Math.PI / 2, 0, 0]);
  add(new THREE.TorusGeometry(0.045, 0.016, 10, 20), glow, [0, 0.03, -0.84]);
  // Two short prongs framing the aperture (top/bottom) for a heavier tip.
  add(new THREE.BoxGeometry(0.03, 0.018, 0.1), metal(COL_METAL_LT), [0, 0.075, -0.8]);
  add(new THREE.BoxGeometry(0.03, 0.018, 0.1), metal(COL_METAL_LT), [0, -0.015, -0.8]);

  // ── Grip + trigger guard ────────────────────────────────────────────────
  add(new THREE.BoxGeometry(0.08, 0.26, 0.11), metal(COL_BODY), [0, -0.18, 0.12], [0.36, 0, 0]);
  add(new THREE.TorusGeometry(0.055, 0.011, 6, 14), metal(COL_METAL), [0, -0.08, 0.04], [Math.PI / 2, 0, 0]);

  // ── Low-profile sight rib on the rear cover ──────────────────────────────
  add(new THREE.BoxGeometry(0.03, 0.035, 0.05), metal(COL_METAL_LT), [0, 0.14, 0.12]);
  add(new THREE.BoxGeometry(0.012, 0.012, 0.012), glow, [0, 0.155, 0.12]); // sight dot

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -0.9);
  group.add(muzzle);

  return { group, muzzle, glow };
}

// Third-person attach. Seats the railgun in the soldier's right hand so it
// tracks the hand through idle/walk/run instead of floating at the hip. The
// hand bone's local frame is offset/rotated, so the constants below were tuned
// to point the barrel down the soldier's forward (-Z) in the idle pose. Falls
// back to a fixed body offset if the rig has no recognisable hand bone.
const HAND_BONE_CANDIDATES = ['mixamorig:RightHand', 'RightHand', 'Hand.R', 'mixamorigRightHand'];

export function attachRailgunToSoldier(root: THREE.Object3D, height = 1.8): THREE.Group {
  const { group } = buildRailgun();

  let hand: THREE.Object3D | null = null;
  for (const name of HAND_BONE_CANDIDATES) {
    hand = root.getObjectByName(name) ?? null;
    if (hand) break;
  }

  if (hand) {
    // soldier.glb's right-hand bone lives in a cm-scaled, rotated local frame
    // (world scale ~0.01). These constants — tuned in that bone space — seat the
    // grip in the palm with the barrel pointing forward and slightly down, a
    // relaxed "railgun at the ready" carry. The gun then tracks the hand through
    // idle/walk/run instead of floating beside the body. localScale 60 → ~0.6
    // world units → a ~0.57 m gun on the 1.8 m soldier.
    group.scale.setScalar(60);
    group.position.set(-2.317, -4.008, 10.329);
    group.rotation.set(2.469, 0.423, -0.021);
    hand.add(group);
  } else {
    // Fallback: park it at the right-hand area on the body root.
    group.scale.setScalar(0.42);
    group.position.set(0.26, height * 0.62, -0.2);
    root.add(group);
  }
  return group;
}
