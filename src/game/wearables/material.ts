import * as THREE from 'three';

// ── The wearables material ───────────────────────────────────────────────────
// One MeshStandardMaterial program for every hat / face / back item, driven by
// the per-vertex channels the Kit writes (see kit.ts): tint mode (fixed /
// wearer accent / admin-repaintable paint), roughness, metalness, emissive
// strength and an fx kind (festive twinkle, hard-light pulse). Flat shading
// (derivative normals) + double-sided: hard-surface facets everywhere and thin
// cloth/brims render from both sides with no normal bookkeeping.
//
// A material instance is per worn item (its accent/tint uniforms differ);
// they all hash to ONE compiled program (customProgramCacheKey).

export type WearUniforms = {
  uAccent: { value: THREE.Color }; // wearer colour (or the admin tint)
  uTint: { value: THREE.Color }; // admin tint for 'paint' surfaces
  uHasTint: { value: number };
  uTime: { value: number };
  uLift: { value: number }; // emissive lift on accent surfaces (matches the armour)
  uCalm: { value: number }; // reduced effects: no twinkle / shimmer
};

function inject(this: THREE.MeshStandardMaterial, shader: THREE.WebGLProgramParametersWithUniforms) {
  const u = (this.userData as { wearUniforms: WearUniforms }).wearUniforms;
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', ['#include <common>', 'attribute vec4 aMat;', 'varying vec4 vWMat;', 'varying vec3 vWObj;'].join('\n'))
    .replace('#include <begin_vertex>', ['#include <begin_vertex>', 'vWMat = aMat;', 'vWObj = position;'].join('\n'));
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      [
        '#include <common>',
        'varying vec4 vWMat;',
        'varying vec3 vWObj;',
        'uniform vec3 uAccent;',
        'uniform vec3 uTint;',
        'uniform float uHasTint;',
        'uniform float uTime;',
        'uniform float uLift;',
        'uniform float uCalm;',
      ].join('\n'),
    )
    .replace(
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        'float wFx = floor(vWMat.x * 0.25 + 0.01);',
        'float wT = vWMat.x - wFx * 4.0;',
        'float wAcc = 1.0 - step(0.5, abs(wT - 1.0));',
        'float wPaint = step(1.5, wT) * uHasTint;',
        'float wL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));',
        'diffuseColor.rgb = mix(diffuseColor.rgb, uTint * clamp(0.3 + 1.7 * wL, 0.3, 1.25), wPaint);',
        'diffuseColor.rgb *= mix(vec3(1.0), uAccent * 1.12, wAcc);',
      ].join('\n'),
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vWMat.y;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vWMat.z;')
    .replace(
      '#include <emissivemap_fragment>',
      [
        '#include <emissivemap_fragment>',
        'float wEm = vWMat.w;',
        'if (wFx > 0.5 && wFx < 1.5) {',
        // Festive bulbs: floor = strength, fract = phase.
        '  float wSt = floor(wEm);',
        '  float wTw = 0.5 + 0.5 * sin(uTime * mix(2.6, 0.7, uCalm) + fract(wEm) * 6.2831853);',
        '  wEm = wSt * (0.3 + 0.7 * wTw * wTw);',
        '} else if (wFx > 1.5) {',
        // Hard light: a slow breathe + a scan band sliding up the part.
        '  float wSc = 0.5 + 0.5 * sin(vWObj.y * 38.0 - uTime * 3.2);',
        '  wEm *= 0.8 + (0.16 * sin(uTime * 2.1) + 0.3 * wSc * wSc * wSc) * (1.0 - uCalm);',
        '}',
        'totalEmissiveRadiance += diffuseColor.rgb * wEm;',
        'totalEmissiveRadiance += uAccent * (uLift * wAcc);',
      ].join('\n'),
    );
}

export function createWearMaterial(): { material: THREE.MeshStandardMaterial; uniforms: WearUniforms } {
  const uniforms: WearUniforms = {
    uAccent: { value: new THREE.Color(1, 0.4, 0.2) },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uHasTint: { value: 0 },
    uTime: { value: 0 },
    uLift: { value: 0.18 },
    uCalm: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    flatShading: true,
    side: THREE.DoubleSide,
    envMapIntensity: 1.0,
  });
  material.name = 'wearable';
  material.userData.wearUniforms = uniforms;
  material.onBeforeCompile = inject;
  material.customProgramCacheKey = () => 'ig-wearable-v1';
  return { material, uniforms };
}
