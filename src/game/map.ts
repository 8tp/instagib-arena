import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyWorldAtmosphere, type WorldAtmosphere } from './renderer';
import { getHazardTexture, getThemeTextures, type SurfaceKind, type SurfaceTextures } from './textures';
import type { AABB } from './types';
import { buildDressing } from './world/dressing';
import { bakeLightmap, faceUv, type LmFace, type LmLight, type Lightmap, type V3 } from './world/lightmap';
import { applyMapShading, createMapShading, type MapShading } from './world/map-material';
import { defaultSlot, FACE_NORMAL, themeForMapId, type SlotParams, type WorldTheme } from './world/themes';

import { MAPS, type ArenaMap, type MapBox } from './arena-map-data';
export { LOUNGE, CAUSEWAY, REACTOR, CONTAINERYARD, DERRICK, TRAINING, NUKETOWN, MAPS, DEFAULT_MAP, mapById, type ArenaMap } from './arena-map-data';
export { movePlayer, rayAabb, rayAabbNormal, raySphere, type CollisionResult } from './collision';

// ─────────────────────────────────────────────────────────────────────────
// Rendering. Collision never touches these meshes (player/bots/weapon use the
// AABB arrays via movePlayer/rayAabb), so the render build is free to merge,
// cull hidden faces, and add flush decoration.
//
// Each map resolves to a world THEME (world/themes.ts): material set, baked
// light rig, sky, fog, exposure. The build:
//   1. extracts every visible box face, bakes a lightmap atlas for them
//      (world/lightmap.ts — cached per map id for the session),
//   2. merges faces per visual slot into one mesh each (world-space UVs for
//      the procedural textures, uv1 into the atlas, per-box vertex tint),
//   3. adds the accent edge trim + architectural dressing + light fixtures
//      (world/dressing.ts) — all render-only, ≤ 0.15 m proud,
//   4. stamps userData.theme / userData.atmosphere and, when the group is
//      added to a scene, applies the theme's sky/fog/lights/exposure to it
//      (renderer.ts applyWorldAtmosphere) — so Game, ReplayViewer and any
//      other createScene() user inherit the look with no extra call.
// ≈ 7–11 draw calls per map.
//
// Mesh tagging convention (for decal/impact raycasts, shadow setup, tint):
//   group.name = 'map', group.userData.mapRoot = true
//   every mesh: name = 'map:<kind>', userData.map = true, userData.surface =
//   'floor' | 'ceiling' | 'wall' | 'cover' | 'platform' | 'tower' | 'trim'
// Use isMapSurface(obj) to pick the solid surfaces and skip the trim bars,
// dressing and fixtures (all tagged 'trim').
//
// World tint contract (game.ts applyWorldStyle): every textured surface keeps
// emissiveMap === map and a white `color`, so the Ratz-style world colour /
// full-bright setting still drives color + emissive. Per-box tints ride in
// vertex colours (multiplying the albedo) and are NOT carried into full-bright
// emissive — full-bright shows the untinted albedo. Fixtures and floor paint
// have no emissiveMap, so they keep their colours under any world tint.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_ACCENT = 0x5ce1ff;

// Edge-light trim (metres): a thin bar wrapped around the side faces of
// platforms + cover just below their top edge. Low intensity so bloom only
// catches it lightly; never on floors, where it would compete with enemies.
const TRIM_HEIGHT = 0.06;
const TRIM_DEPTH = 0.03;
const TRIM_DROP = 0.16;

// Size heuristic that assigns each AABB a surface kind (unchanged from the
// original per-box build, so maps read the way they were authored). Themes
// may remap a box to a different visual slot (world/themes.ts).
export function surfaceKindFor(index: number, b: AABB): SurfaceKind {
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  if (index === 0) return 'floor';
  if (index === 1) return 'ceiling';
  if (sy < 1.3) return 'cover';
  if (sy >= 4 && sx <= 5 && sz <= 5) return 'tower';
  if (sy < 3) return 'platform';
  return 'wall';
}

// True for the solid arena surfaces — what a decal / impact raycast should
// test against. Excludes the emissive trim bars, dressing and fixtures.
export function isMapSurface(obj: THREE.Object3D): boolean {
  return obj.userData.map === true && obj.userData.surface !== 'trim';
}

function pointInBox(x: number, y: number, z: number, b: AABB): boolean {
  return x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z;
}

// Four trim bars around a box's side faces. A face whose bar would sit inside
// a neighbouring solid (abutting a perimeter wall, the inner corner of an
// L-shape, a riser buried under the next step) or outside the arena bounds
// (a shelf flush with the outer wall) is skipped.
function addTrim(out: THREE.BufferGeometry[], b: AABB, solids: AABB[], bounds: AABB) {
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  if (sy < 0.3) return;
  const y = b.max.y - TRIM_DROP;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const half = TRIM_DEPTH / 2;
  const over = TRIM_DEPTH * 2; // extend past the corners so the four bars close
  const faces: Array<[number, number, number, number]> = [
    [b.max.x + half, cz, TRIM_DEPTH, sz + over],
    [b.min.x - half, cz, TRIM_DEPTH, sz + over],
    [cx, b.max.z + half, sx + over, TRIM_DEPTH],
    [cx, b.min.z - half, sx + over, TRIM_DEPTH],
  ];
  for (const [px, pz, w, d] of faces) {
    if (!pointInBox(px, y, pz, bounds)) continue;
    if (solids.some((s) => s !== b && pointInBox(px, y, pz, s))) continue;
    const g = new THREE.BoxGeometry(w, TRIM_HEIGHT, d);
    g.translate(px, y, pz);
    out.push(g);
  }
}

// No emissiveMap on purpose: applyWorldStyle only retints materials that have
// one, so the accent trim keeps its colour under any world tint.
function trimMaterial(accent: THREE.Color, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: accent.clone().multiplyScalar(0.12),
    emissive: accent,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0,
  });
}

// ── world bake (cached per map) ────────────────────────────────────────────

type WorldBake = {
  lm: Lightmap;
  boxes: MapBox[]; // RENDER boxes (perimeter walls lowered to the sky line)
  drawn: boolean[];
  slots: SurfaceKind[];
  tints: Array<THREE.Color | null>;
  perimeter: boolean[];
};

const bakeCache = new Map<string, WorldBake>();

function mapIdOf(map: ArenaMap): string | undefined {
  return MAPS.find((m) => m.map === map)?.id ?? MAPS.find((m) => m.map.name === map.name)?.id;
}

// Tall boundary walls (touching the arena bounds in x or z).
function isPerimeter(i: number, b: AABB, bounds: AABB): boolean {
  if (i < 2 || b.max.y - b.min.y < 4) return false;
  const e = 1e-3;
  return (
    b.min.x <= bounds.min.x + e || b.max.x >= bounds.max.x - e ||
    b.min.z <= bounds.min.z + e || b.max.z >= bounds.max.z - e
  );
}

const linear = (hex: number, k = 1): V3 => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};

// Colour scaled so its luminance is exactly `lum` (ambient/sky irradiance are
// authored as a hue + a brightness, independent of how saturated the hue is).
const byLuminance = (hex: number, lum: number): V3 => {
  const c = new THREE.Color(hex);
  const l = Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  return [(c.r / l) * lum, (c.g / l) * lum, (c.b / l) * lum];
};

function toBakeLights(theme: WorldTheme): LmLight[] {
  const out: LmLight[] = [];
  for (const d of theme.lights) {
    if (d.intensity <= 0) continue;
    const n = FACE_NORMAL[d.face];
    const o = d.out ?? 0.5;
    const light: LmLight = {
      p: [d.at[0] + n[0] * o, d.at[1] + n[1] * o, d.at[2] + n[2] * o],
      color: linear(d.color, d.intensity),
      range: d.range,
      radius: d.radius,
    };
    if (d.spot) {
      const pen = d.spot.penumbra ?? 0.5;
      light.spot = {
        dir: d.spot.dir,
        cosOuter: Math.cos(d.spot.angle),
        cosInner: Math.cos(d.spot.angle * (1 - pen)),
      };
    }
    out.push(light);
  }
  return out;
}

// Render copies of the AABBs. Open-sky themes draw their tall boundary walls
// only up to `perimeterTop` (Quake 3 sky-brush style): the collision boxes in
// map.boxes are untouched — only what's drawn, baked and shadowed is lower.
function renderBoxes(map: ArenaMap, theme: WorldTheme, perimeter: boolean[]): MapBox[] {
  const top = theme.perimeterTop;
  return map.boxes.map((b, i) =>
    top !== undefined && perimeter[i] && b.max.y > top
      ? { ...b, min: { ...b.min }, max: { x: b.max.x, y: Math.max(b.min.y + 0.5, top), z: b.max.z } }
      : b,
  );
}

// Visual top of box `index` — above it the box still collides but nothing is
// drawn (sky-brush perimeter walls on open-sky maps). Impact FX should be
// suppressed for hits above this height, like hits on an openTop cap.
export function mapVisualTop(map: ArenaMap, index: number): number {
  const b = map.boxes[index];
  if (!b) return Infinity;
  const theme = themeForMapId(mapIdOf(map));
  if (index === 1 && (map.openTop || theme.openSky)) return -Infinity;
  if (theme.perimeterTop !== undefined && isPerimeter(index, b, map.bounds)) return Math.min(b.max.y, theme.perimeterTop);
  return b.max.y;
}

function bakeWorld(map: ArenaMap, key: string, theme: WorldTheme): WorldBake {
  const hit = bakeCache.get(key);
  if (hit) return hit;
  const openTop = !!map.openTop || theme.openSky;
  const perimeter = map.boxes.map((b, i) => isPerimeter(i, b, map.bounds));
  const boxes = renderBoxes(map, theme, perimeter);
  const drawn = boxes.map((_, i) => !(i === 1 && openTop));
  const slots = boxes.map((b, i) => {
    const kind = surfaceKindFor(i, b);
    return theme.slotFor ? theme.slotFor(i, b, kind) : defaultSlot(i, b, kind);
  });
  const tints = boxes.map((b, i) => {
    const t = theme.tintFor?.(i, b, slots[i]);
    return t === null || t === undefined ? null : new THREE.Color(t);
  });
  const bk = theme.bake;
  const lm = bakeLightmap(boxes, map.bounds, drawn, {
    texel: bk.texel,
    maxTexels: bk.maxTexels ?? 120_000,
    ambientUp: byLuminance(bk.ambientUp, bk.ambient),
    ambientDown: byLuminance(bk.ambientDown, bk.ambient * 0.55),
    aoRadius: bk.ao.radius,
    aoStrength: bk.ao.strength,
    aoRays: 10,
    sky: openTop && bk.sky ? { color: byLuminance(bk.sky.color, bk.sky.intensity), rays: 8, length: 40 } : null,
    sunDir: bk.sunShadow ? theme.sun.dir : null,
    sunIgnore: (i) => (bk.sunIgnorePerimeter && perimeter[i]) || (bk.sunIgnoreCeiling && i === 1),
    lights: toBakeLights(theme),
    // The ceiling is big, flat and far: half the texel density.
    coarse: (i) => (i === 1 ? 2 : 1),
  });
  const bake: WorldBake = { lm, boxes, drawn, slots, tints, perimeter };
  bakeCache.set(key, bake);
  if (import.meta.env?.DEV) {
    console.info(
      `[world] ${key}: baked ${lm.texels} texels @ ${lm.texel.toFixed(2)} m, atlas ${lm.width}×${lm.height}, ${lm.faces.length} faces, ${lm.ms.toFixed(0)} ms`,
    );
  }
  return bake;
}

// One quad per face: world position, world-projected UV (/tile), atlas uv1,
// per-box tint.
function facesGeometry(faces: LmFace[], lm: Lightmap, tile: number, tints: Array<THREE.Color | null>): THREE.BufferGeometry {
  const n = faces.length;
  const pos = new Float32Array(n * 12);
  const nrm = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const uv1 = new Float32Array(n * 8);
  const col = new Float32Array(n * 12);
  const index = new Uint32Array(n * 6);
  const p: V3 = [0, 0, 0];
  for (let q = 0; q < n; q++) {
    const f = faces[q];
    const us = [f.u0, f.u1, f.u1, f.u0];
    const vs = [f.v0, f.v0, f.v1, f.v1];
    const tint = tints[f.box];
    for (let c = 0; c < 4; c++) {
      const o = q * 4 + c;
      p[f.axis] = f.plane;
      p[f.ua] = us[c];
      p[f.va] = vs[c];
      pos.set(p, o * 3);
      nrm[o * 3 + f.axis] = f.sign;
      uv[o * 2] = p[f.ua] / tile;
      uv[o * 2 + 1] = p[f.va] / tile;
      const t = faceUv(lm, f, p);
      uv1[o * 2] = t[0];
      uv1[o * 2 + 1] = t[1];
      col[o * 3] = tint ? tint.r : 1;
      col[o * 3 + 1] = tint ? tint.g : 1;
      col[o * 3 + 2] = tint ? tint.b : 1;
    }
    // (u × v) · n is negative for x- and y-faces with this UV convention.
    const flip = (f.axis === 2 ? 1 : -1) * f.sign < 0;
    const b = q * 4;
    if (flip) index.set([b, b + 2, b + 1, b, b + 3, b + 2], q * 6);
    else index.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function lightmappedMaterial(
  t: SurfaceTextures, p: SlotParams, lm: Lightmap, shading: MapShading,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: t.map,
    emissiveMap: t.map,
    emissive: 0x000000,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(p.normalScale, p.normalScale),
    roughnessMap: t.orm,
    roughness: 1,
    aoMap: t.orm,
    aoMapIntensity: p.ao,
    metalness: p.metalness,
    lightMap: lm.texture,
    lightMapIntensity: lm.scale,
    vertexColors: true,
  });
  applyMapShading(m, shading);
  return m;
}

function atmosphereFor(theme: WorldTheme): WorldAtmosphere {
  return {
    id: theme.id,
    exposure: theme.exposure,
    background: theme.background,
    fog: theme.fog,
    sky: theme.sky,
    sun: { dir: theme.sun.dir, color: theme.sun.color, intensity: theme.sun.intensity },
    hemi: { sky: theme.hemi.sky, ground: theme.hemi.ground, intensity: theme.hemi.intensity },
    fill: { dir: theme.fill.dir, color: theme.fill.color, intensity: theme.fill.intensity },
    envIntensity: theme.env.intensity,
    shadowBox: theme.shadowBox,
  };
}

// Builds the themed, lightmapped arena. Materials + geometry are created per
// build and disposed with the group on map switch (game.ts disposeGroup);
// textures and the lightmap atlas are cached for the session.
// Low-spec build tier: set by the Game's quality setting; applies from the
// next build (map switch) — the dressing skips its purely decorative ribs.
let lowBuild = false;
export function setMapBuildQuality(low: boolean): void {
  lowBuild = low;
}

export function buildMapMesh(map: ArenaMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  group.userData.mapRoot = true;
  const id = mapIdOf(map);
  const theme = themeForMapId(id);
  const tex = getThemeTextures(theme.id, theme.textures);
  const world = bakeWorld(map, id ?? `anon:${map.name}`, theme);
  const { lm, slots, tints, perimeter, drawn } = world;
  const rboxes = world.boxes;

  const shading = createMapShading();
  shading.uSunScale.value = theme.sun.mapScale;
  shading.uFillScale.value = theme.fill.mapScale;
  shading.uHemiScale.value = theme.hemi.mapScale;
  shading.uIblScale.value = theme.env.mapScale;
  shading.uWorldSat.value = theme.worldSaturation;
  shading.uSatCap.value = Math.min(0.8, theme.satCap ?? 0.6);
  shading.uShadowLift.value = theme.shadowLift ?? (theme.openSky ? 0.3 : 0.55);

  // Surfaces: one mesh per visual slot. Tall boundary walls that the bake
  // treats as not shadowing the sun get their own mesh that doesn't cast a
  // realtime shadow either, so the two agree.
  const splitPerimeter = theme.bake.sunIgnorePerimeter;
  const buckets = new Map<string, LmFace[]>();
  for (const f of lm.faces) {
    const slot = slots[f.box];
    const key = splitPerimeter && perimeter[f.box] ? `${slot}|perimeter` : slot;
    const list = buckets.get(key);
    if (list) list.push(f);
    else buckets.set(key, [f]);
  }
  const materials = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
  for (const [key, faces] of buckets) {
    const [slot, tag] = key.split('|') as [SurfaceKind, string | undefined];
    let mat = materials.get(slot);
    if (!mat) {
      mat = lightmappedMaterial(tex[slot], theme.slots[slot], lm, shading);
      materials.set(slot, mat);
    }
    const mesh = new THREE.Mesh(facesGeometry(faces, lm, tex[slot].tile, tints), mat);
    mesh.name = `map:${slot}`;
    mesh.userData.map = true;
    mesh.userData.surface = slot;
    mesh.receiveShadow = true;
    mesh.castShadow = slot !== 'floor' && slot !== 'ceiling' && tag !== 'perimeter';
    if (tag === 'perimeter') mesh.userData.noShadow = true;
    group.add(mesh);
  }

  // Accent edge-light trim on platforms + cover (by collision kind, as
  // authored), for themes that use it.
  if (theme.trim) {
    const trims: THREE.BufferGeometry[] = [];
    const solids = rboxes.filter((_, i) => drawn[i]);
    for (let i = 0; i < rboxes.length; i++) {
      if (!drawn[i]) continue;
      const b = rboxes[i];
      const kind = surfaceKindFor(i, b);
      if (kind === 'platform' || kind === 'cover') addTrim(trims, b, solids, map.bounds);
    }
    if (trims.length) {
      const merged = mergeGeometries(trims, false);
      trims.forEach((g) => g.dispose());
      if (merged) {
        const accent = new THREE.Color(theme.trim.color ?? map.accent ?? DEFAULT_ACCENT);
        const mesh = new THREE.Mesh(merged, trimMaterial(accent, theme.trim.intensity));
        mesh.name = 'map:trim';
        mesh.userData.map = true;
        mesh.userData.surface = 'trim';
        mesh.userData.noShadow = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        group.add(mesh);
      }
    }
  }

  // Architectural dressing + light fixtures + floor paint.
  const dressTex = tex[theme.dress.slot];
  const dress = buildDressing({
    boxes: rboxes, bounds: map.bounds, drawn, slots, perimeter, lm, theme, tile: dressTex.tile, low: lowBuild,
  });
  if (dress.metal) {
    const p = theme.slots[theme.dress.slot];
    const mat = lightmappedMaterial(dressTex, p, lm, shading);
    mat.roughness = 0.85;
    const mesh = new THREE.Mesh(dress.metal, mat);
    mesh.name = 'map:dress';
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  // Paint + hazard stripes keep their colour (no world saturation cap): they
  // are small, and the safety yellow is the point.
  const paintShading = createMapShading();
  for (const k of Object.keys(shading) as Array<keyof MapShading>) paintShading[k].value = shading[k].value;
  paintShading.uSatCap.value = 1;
  paintShading.uWorldSat.value = 0.92;
  const paintMesh = (geo: THREE.BufferGeometry, name: string, map?: THREE.Texture) => {
    const mat = new THREE.MeshStandardMaterial({
      map: map ?? null,
      vertexColors: !map,
      roughness: 0.75,
      metalness: 0,
      lightMap: lm.texture,
      lightMapIntensity: lm.scale,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    applyMapShading(mat, paintShading);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  if (dress.paint) paintMesh(dress.paint, 'map:paint');
  if (dress.hazard) paintMesh(dress.hazard, 'map:hazard', getHazardTexture());
  if (dress.skyline) {
    // Outside the arena: unlit dark silhouettes, fogged into the sky.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(dress.skyline, mat);
    mesh.name = 'map:skyline';
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  if (dress.fixtures) {
    // Unlit HDR vertex colours: the fixtures are the visible light sources
    // (the only static things meant to cross the bloom threshold).
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(dress.fixtures, mat);
    mesh.name = 'map:fixtures';
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  const atmosphere = atmosphereFor(theme);
  group.userData.theme = theme.id;
  group.userData.atmosphere = atmosphere;
  group.userData.lightmap = { ms: lm.ms, texels: lm.texels, width: lm.width, height: lm.height };
  group.addEventListener('added', () => {
    let root: THREE.Object3D = group;
    while (root.parent) root = root.parent;
    if ((root as THREE.Scene).isScene) applyWorldAtmosphere(root as THREE.Scene, atmosphere);
  });
  return group;
}
