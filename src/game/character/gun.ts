import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildRailgun } from '../weapon-model';
import type { RailgunFinish } from '../cosmetics';
import type { Character } from './character';

// Third-person railgun: the railgun builder's model (grip at the origin,
// barrel down −Z) seated in the combatant's hand.R gun socket. The arm IK
// (see character-anim.ts) places that hand on the aim line, so the barrel
// follows the view pitch exactly.

// World size of the third-person gun (the builder's canonical model is ~0.95
// units long → ~0.6 m in hand).
export const GUN_SCALE = 0.62;
// Gun origin relative to the palm socket: the palm wraps the pistol grip, which
// hangs below/behind the gun origin.
const GUN_IN_SOCKET = new THREE.Vector3(0, 0.1, -0.06);

// Hold geometry in the AIM frame (offsets from the chest bone position; −Z =
// along the barrel). `grip` is the right palm; `support` is the left palm on
// the barrel's underside.
export const HOLD = {
  grip: new THREE.Vector3(0.12, -0.02, -0.21),
  support: new THREE.Vector3(0.11, 0.07, -0.47),
};

export function attachRailgun(ch: Character, finish?: RailgunFinish): THREE.Group {
  const model = buildRailgun(finish);
  const g = model.group;
  g.scale.setScalar(GUN_SCALE);
  g.position.copy(GUN_IN_SOCKET);
  g.name = 'railgun-3p';
  bakeGun(g);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  ch.sockets.gun.add(g);
  return g;
}

export function disposeRailgun(g: THREE.Object3D | null): void {
  if (!g) return;
  g.parent?.remove(g);
  const mats = new Set<THREE.Material>();
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
    else if (mat) mats.add(mat);
  });
  mats.forEach((m) => m.dispose());
}

// ── Third-person bake ────────────────────────────────────────────────────────
// Collapse the whole gun into TWO meshes: every lit part into one vertex-
// coloured MeshStandardMaterial, every glowing part into one unlit vertex-
// coloured mesh (HDR colours, so bloom still catches the rails). Texture maps
// are dropped — at third-person range they are sub-pixel. Falls back to the
// by-material merge if anything unexpected is in the tree.
const _bc = new THREE.Color();
function glowColor(m: THREE.Material, out: THREE.Color): boolean {
  const s = m as THREE.MeshStandardMaterial;
  if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    out.copy((m as THREE.MeshBasicMaterial).color);
    return true;
  }
  if (s.emissive && s.emissiveIntensity * Math.max(s.emissive.r, s.emissive.g, s.emissive.b) > 0.25) {
    out.copy(s.emissive).multiplyScalar(Math.max(1, s.emissiveIntensity) * 1.6);
    return true;
  }
  return false;
}

export function bakeGun(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const lit: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const victims: THREE.Mesh[] = [];
  let ok = true;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.visible || (m.material as THREE.Material).transparent) return; // muzzle flash etc.
    if (Array.isArray(m.material) || m.children.length > 0 || !m.geometry.getAttribute('normal')) {
      ok = false;
      return;
    }
    const mat = m.material as THREE.Material;
    const isGlow = glowColor(mat, _bc);
    if (!isGlow) {
      const c = (mat as THREE.MeshStandardMaterial).color;
      if (c) _bc.copy(c);
      else _bc.setRGB(0.3, 0.3, 0.3);
    }
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.morphAttributes = {};
    rel.multiplyMatrices(inv, m.matrixWorld);
    g = g.applyMatrix4(rel);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _bc.r;
      col[i * 3 + 1] = _bc.g;
      col[i * 3 + 2] = _bc.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (isGlow ? glow : lit).push(g);
    victims.push(m);
  });
  if (!ok || victims.length === 0) {
    lit.concat(glow).forEach((g) => g.dispose());
    mergeStaticMeshes(root);
    return;
  }
  const disposeMats = new Set<THREE.Material>();
  for (const m of victims) {
    m.parent?.remove(m);
    m.geometry.dispose();
    disposeMats.add(m.material as THREE.Material);
  }
  disposeMats.forEach((m) => m.dispose());
  if (lit.length) {
    const merged = mergeGeometries(lit, false);
    lit.forEach((g) => g.dispose());
    if (merged) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.82, roughness: 0.36 });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'railgun-body';
      root.add(mesh);
    }
  }
  if (glow.length) {
    const merged = mergeGeometries(glow, false);
    glow.forEach((g) => g.dispose());
    if (merged) {
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'railgun-glow';
      root.add(mesh);
    }
  }
}

// ── Draw-call reduction ──────────────────────────────────────────────────────
// The procedural gun is ~25 small meshes with ~20 separately-created (but
// visually identical) materials. For the third-person copy — 8 on screen —
// merge every visible leaf mesh by material VALUE into one mesh per look.
// Non-mesh nodes (the muzzle marker) and hidden meshes (muzzle flash) are kept.
function materialKey(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  const col = (c?: THREE.Color) => (c ? c.getHexString() : '-');
  return [
    m.type,
    col(s.color),
    col(s.emissive),
    s.emissiveIntensity ?? '-',
    s.metalness ?? '-',
    s.roughness ?? '-',
    m.transparent,
    m.opacity,
    m.blending,
    m.side,
    s.map?.uuid ?? '-',
    s.normalMap?.uuid ?? '-',
    m.vertexColors,
  ].join('|');
}

function requiredAttributes(m: THREE.Material): string[] {
  const s = m as THREE.MeshStandardMaterial;
  const attrs = ['position', 'normal'];
  if (s.map || s.normalMap || s.roughnessMap || s.metalnessMap || s.emissiveMap || s.aoMap) attrs.push('uv');
  if (m.vertexColors) attrs.push('color');
  return attrs;
}

export function mergeStaticMeshes(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; meshes: THREE.Mesh[] }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || Array.isArray(m.material) || m.children.length > 0) return;
    if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    const key = materialKey(m.material);
    let b = buckets.get(key);
    if (!b) {
      b = { mat: m.material, meshes: [] };
      buckets.set(key, b);
    }
    b.meshes.push(m);
  });
  const rel = new THREE.Matrix4();
  const removed: THREE.Mesh[] = [];
  for (const { mat, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;
    const need = requiredAttributes(mat);
    const geos: THREE.BufferGeometry[] = [];
    let ok = true;
    for (const m of meshes) {
      const src = m.geometry;
      if (!need.every((a) => src.getAttribute(a))) {
        ok = false;
        break;
      }
      let g = src.index ? src.toNonIndexed() : src.clone();
      for (const name of Object.keys(g.attributes)) if (!need.includes(name)) g.deleteAttribute(name);
      g.morphAttributes = {};
      rel.multiplyMatrices(inv, m.matrixWorld);
      g = g.applyMatrix4(rel);
      geos.push(g);
    }
    if (!ok) {
      geos.forEach((g) => g.dispose());
      continue;
    }
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'merged';
    // Parent at the root; `rel` already bakes each part into root space.
    root.add(mesh);
    for (const m of meshes) {
      m.parent?.remove(m);
      removed.push(m);
    }
  }
  // Free what no remaining mesh references (the builder may share resources).
  const liveGeo = new Set<THREE.BufferGeometry>();
  const liveMat = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    liveGeo.add(m.geometry);
    if (Array.isArray(m.material)) m.material.forEach((x) => liveMat.add(x));
    else liveMat.add(m.material);
  });
  for (const m of removed) {
    if (!liveGeo.has(m.geometry)) {
      liveGeo.add(m.geometry); // dispose once
      m.geometry.dispose();
    }
    const mat = m.material as THREE.Material;
    if (!liveMat.has(mat)) {
      liveMat.add(mat);
      mat.dispose();
    }
  }
}
