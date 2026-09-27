import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────
// Lightmapped arena material: a MeshStandardMaterial whose lighting is split
// between the BAKE and the scene's dynamic rig, so the same lights can keep
// players readable while the world gets pools, falloff and dark corners.
//
//   lightmap rgb  sqrt-encoded baked irradiance (× lightMapIntensity after
//                 squaring) — the ambient/AO/coloured-light pools.
//   lightmap a    baked sun visibility; directional light 0 (the sun) is
//                 scaled by uSunScale × a on map surfaces, so map-on-map sun
//                 shadows exist without realtime shadows and the realtime
//                 shadow map still darkens it where players stand.
//   realtime      where the sun's realtime shadow map darkens a spot the bake
//   shadow        calls sunlit (i.e. a player's shadow), the baked irradiance
//                 is darkened too (× uShadowLift) — so players stay grounded
//                 in interiors where the sun is only a small share of the light.
//   dir light 1   the fill → × uFillScale.
//   hemisphere    × uHemiScale (kept low: it's what made the world flat).
//   IBL           × uIblScale × (baked brightness) — dark corners stop
//                 reflecting a bright studio.
//   world grade   outgoingLight desaturated toward luma by uWorldSat, on map
//                 surfaces only, so bright players pop against the world.
// The uniforms are shared objects, so one theme change updates every map
// material. One program for all of them (customProgramCacheKey).
// ─────────────────────────────────────────────────────────────────────────

export type MapShading = {
  uShadowLift: { value: number };
  uIblClamp: { value: number };
  uSunScale: { value: number };
  uFillScale: { value: number };
  uHemiScale: { value: number };
  uIblScale: { value: number };
  uIblRef: { value: number };
  uWorldSat: { value: number };
};

export function createMapShading(): MapShading {
  return {
    uShadowLift: { value: 0.4 },
    uIblClamp: { value: 1.5 },
    uSunScale: { value: 1 },
    uFillScale: { value: 1 },
    uHemiScale: { value: 1 },
    uIblScale: { value: 1 },
    uIblRef: { value: 1.2 },
    uWorldSat: { value: 1 },
  };
}

const DECLS = /* glsl */ `
uniform float uShadowLift;
uniform float uIblClamp;
uniform float uSunScale;
uniform float uFillScale;
uniform float uHemiScale;
uniform float uIblScale;
uniform float uIblRef;
uniform float uWorldSat;
`;

function patchedBegin(): string {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const dirInfo = 'getDirectionalLightInfo( directionalLight, directLight );';
  const hemi = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';
  const dirBlock = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const reDirect = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const at = src.indexOf(dirBlock);
  if (!src.includes(dirInfo) || !src.includes(hemi) || at < 0 || src.indexOf(reDirect, at) < 0) {
    console.warn('[world] lights_fragment_begin changed — map lighting split disabled');
    return src;
  }
  // Only the directional loop's RE_Direct gets the shadow capture.
  const head = src.slice(0, at);
  let tail = src.slice(at);
  tail = tail.replace(
    reDirect,
    `#if ( UNROLLED_LOOP_INDEX == 0 )
		{
			float arenaPre = arenaPreShadow.r + arenaPreShadow.g + arenaPreShadow.b;
			if ( arenaPre > 1e-5 ) arenaShadow = ( directLight.color.r + directLight.color.g + directLight.color.b ) / arenaPre;
		}
		#endif
		${reDirect}`,
  );
  return (
    /* glsl */ `
#ifdef USE_LIGHTMAP
  vec4 arenaLm = texture2D( lightMap, vLightMapUv );
#else
  vec4 arenaLm = vec4( 1.0 );
#endif
float arenaShadow = 1.0;
vec3 arenaPreShadow = vec3( 0.0 );
` +
    (head + tail)
      .replace(
        dirInfo,
        `${dirInfo}
		#if ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= uSunScale * arenaLm.a;
		arenaPreShadow = directLight.color;
		#elif ( UNROLLED_LOOP_INDEX == 1 )
		directLight.color *= uFillScale;
		#endif`,
      )
      .replace(hemi, 'irradiance += uHemiScale * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );')
  );
}

function patchedMaps(): string {
  const src = THREE.ShaderChunk.lights_fragment_maps;
  const sample = 'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );';
  const decode = 'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;';
  if (!src.includes(sample) || !src.includes(decode)) {
    console.warn('[world] lights_fragment_maps changed — lightmap decode disabled');
    return src;
  }
  return (
    src
      .replace(sample, 'vec4 lightMapTexel = arenaLm;')
      .replace(
        decode,
        'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapTexel.rgb * lightMapIntensity * mix( 1.0, clamp( arenaShadow, 0.0, 1.0 ), uShadowLift );',
      ) +
    /* glsl */ `
#if defined( USE_LIGHTMAP ) && defined( RE_IndirectDiffuse )
  {
    // The IBL is a neutral studio (it's tuned for the players): on the world
    // it's scaled by how lit the spot is, tinted toward the local baked light
    // colour, and its hot spots clamped — so a sodium pool reflects orange
    // and a dark corner reflects nothing, instead of white studio panels.
    float arenaLum = dot( lightMapIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 arenaTint = min( lightMapIrradiance / max( arenaLum, 1e-3 ), vec3( 3.0 ) );
    vec3 arenaIbl = uIblScale * mix( 0.05, 1.0, clamp( arenaLum / uIblRef, 0.0, 1.0 ) ) * mix( vec3( 1.0 ), arenaTint, 0.8 );
    iblIrradiance *= arenaIbl;
    #if defined( RE_IndirectSpecular )
    radiance = min( radiance, vec3( uIblClamp ) ) * arenaIbl;
    #endif
  }
#endif
`
  );
}

let beginSrc: string | null = null;
let mapsSrc: string | null = null;

// Patch a standard material in place. Its lightMap (channel 1, uv1) must be
// the baked atlas; lightMapIntensity = the bake's encode scale.
export function applyMapShading(mat: THREE.MeshStandardMaterial, shading: MapShading): void {
  beginSrc ??= patchedBegin();
  mapsSrc ??= patchedMaps();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shading);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLS}`)
      .replace('#include <lights_fragment_begin>', beginSrc as string)
      .replace('#include <lights_fragment_maps>', mapsSrc as string)
      .replace(
        '#include <opaque_fragment>',
        'outgoingLight = mix( vec3( dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) ) ), outgoingLight, uWorldSat );\n#include <opaque_fragment>',
      );
  };
  mat.customProgramCacheKey = () => 'arena-lightmapped-v2';
}
