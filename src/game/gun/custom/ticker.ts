import * as THREE from 'three';

// A per-frame hook for a group of meshes we don't own (custom gun models): a
// degenerate one-triangle mesh that writes nothing, whose onBeforeRender fires
// every frame the gun is drawn. Shared geometry + material.

let geo: THREE.BufferGeometry | null = null;
let mat: THREE.Material | null = null;

export function makeTicker(onTick: () => void): THREE.Mesh {
  geo ??= new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  mat ??= new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
  geo.boundingSphere ??= new THREE.Sphere(new THREE.Vector3(), 1);
  const m = new THREE.Mesh(geo, mat);
  m.name = 'gun-ticker';
  m.frustumCulled = false;
  m.userData.shared = true;
  m.onBeforeRender = onTick;
  return m;
}
