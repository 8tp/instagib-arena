import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyWorldAtmosphere, type WorldAtmosphere } from './renderer';
import { getThemeTextures, type SurfaceKind, type SurfaceTextures } from './textures';
import type { AABB, Vec3 } from './types';
import { buildDressing } from './world/dressing';
import { bakeLightmap, faceUv, type LmFace, type LmLight, type Lightmap, type V3 } from './world/lightmap';
import { applyMapShading, createMapShading, type MapShading } from './world/map-material';
import { defaultSlot, FACE_NORMAL, themeForMapId, type SlotParams, type WorldTheme } from './world/themes';

export type ArenaMap = {
  name: string;
  boxes: AABB[];
  spawn: Vec3;
  bounds: AABB;
  // Open-air arena: the ceiling box (index 1) still collides but isn't drawn,
  // so the skybox shows. Use with tall perimeter walls + a high invisible cap.
  openTop?: boolean;
  // Emissive edge-light colour (trim bars on platforms + cover). Defaults to
  // the brand cyan.
  accent?: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Air-movement maps (ratz-inspired). Designed against this game's reachability:
// jump 1.6m, double-jump 3.2m, boost-up ~6-8m, BOOST_RANGE 4m, strafe gaps
// ~7-18m. Boost-only ledges sit at 4.5-6m; boostable walls flank travel lanes.
// ─────────────────────────────────────────────────────────────────────────

// "Lounge" — Ratz homage: giant-furniture maze floor, a boost-only bookshelf
// ring at 5m, a central coffee-table pad, and a floating light-fitting perch.
export const LOUNGE: ArenaMap = (() => {
  const boxes: AABB[] = [];
  boxes.push({ min: { x: -30, y: -1, z: -22 }, max: { x: 30, y: 0, z: 22 } });
  boxes.push({ min: { x: -30, y: 19, z: -22 }, max: { x: 30, y: 20, z: 22 } });
  boxes.push({ min: { x: -30, y: 0, z: -22 }, max: { x: -28, y: 19, z: 22 } });
  boxes.push({ min: { x: 28, y: 0, z: -22 }, max: { x: 30, y: 19, z: 22 } });
  boxes.push({ min: { x: -30, y: 0, z: -22 }, max: { x: 30, y: 19, z: -20 } });
  boxes.push({ min: { x: -30, y: 0, z: 20 }, max: { x: 30, y: 19, z: 22 } });
  // giant sofas (3m L-shapes) — maze cover with boostable faces
  boxes.push({ min: { x: -26, y: 0, z: -10 }, max: { x: -16, y: 3, z: -7 } });
  boxes.push({ min: { x: -26, y: 0, z: -7 }, max: { x: -23, y: 3, z: 2 } });
  boxes.push({ min: { x: 16, y: 0, z: 7 }, max: { x: 26, y: 3, z: 10 } });
  boxes.push({ min: { x: 23, y: 0, z: -2 }, max: { x: 26, y: 3, z: 7 } });
  // bookcases (5m slabs lining lanes to the shelf — boost off these)
  boxes.push({ min: { x: -10, y: 0, z: -18 }, max: { x: -7, y: 5, z: -12 } });
  boxes.push({ min: { x: 7, y: 0, z: 12 }, max: { x: 10, y: 5, z: 18 } });
  boxes.push({ min: { x: -4, y: 0, z: 12 }, max: { x: -1, y: 5, z: 18 } });
  boxes.push({ min: { x: 1, y: 0, z: -18 }, max: { x: 4, y: 5, z: -12 } });
  // boost-only perimeter shelf (catwalk at y=5)
  boxes.push({ min: { x: -28, y: 5, z: -22 }, max: { x: -24, y: 5.6, z: 22 } });
  boxes.push({ min: { x: 24, y: 5, z: -22 }, max: { x: 28, y: 5.6, z: 22 } });
  // coffee-table central pad
  boxes.push({ min: { x: -6, y: 0, z: -4 }, max: { x: 6, y: 1.2, z: 4 } });
  // light-fitting perch (elite overlook) + offset column to wall-boost up to it
  boxes.push({ min: { x: -2, y: 9.5, z: -2 }, max: { x: 2, y: 10.1, z: 2 } });
  boxes.push({ min: { x: -1, y: 1.2, z: 5 }, max: { x: 1, y: 8, z: 7 } });
  // scattered waist-high cover
  boxes.push({ min: { x: -16, y: 0, z: 6 }, max: { x: -12, y: 1.1, z: 10 } });
  boxes.push({ min: { x: 12, y: 0, z: -10 }, max: { x: 16, y: 1.1, z: -6 } });
  return {
    name: 'Lounge',
    boxes,
    spawn: { x: 0, y: 0.05, z: 16 },
    bounds: { min: { x: -30, y: -1, z: -22 }, max: { x: 30, y: 20, z: 22 } },
    accent: 0xffc46b,
  };
})();

// "Causeway" — open multi-platform arena. Strafe-jump 10-12m gaps between
// floating platforms; boost off the mid-gap lamp-post pillars to extend a leap
// or reach the central hub. Figure-8 flow. The air-strafe showcase.
export const CAUSEWAY: ArenaMap = (() => {
  const boxes: AABB[] = [];
  boxes.push({ min: { x: -35, y: -1, z: -25 }, max: { x: 35, y: 0, z: 25 } });
  boxes.push({ min: { x: -35, y: 21, z: -25 }, max: { x: 35, y: 22, z: 25 } });
  boxes.push({ min: { x: -35, y: 0, z: -25 }, max: { x: -33, y: 21, z: 25 } });
  boxes.push({ min: { x: 33, y: 0, z: -25 }, max: { x: 35, y: 21, z: 25 } });
  boxes.push({ min: { x: -35, y: 0, z: -25 }, max: { x: 35, y: 21, z: -23 } });
  boxes.push({ min: { x: -35, y: 0, z: 23 }, max: { x: 35, y: 21, z: 25 } });
  // four corner platforms at y=4 (10×9), ~10-12m gaps between
  boxes.push({ min: { x: -28, y: 4, z: -18 }, max: { x: -18, y: 4.6, z: -9 } });
  boxes.push({ min: { x: 18, y: 4, z: -18 }, max: { x: 28, y: 4.6, z: -9 } });
  boxes.push({ min: { x: -28, y: 4, z: 9 }, max: { x: -18, y: 4.6, z: 18 } });
  boxes.push({ min: { x: 18, y: 4, z: 9 }, max: { x: 28, y: 4.6, z: 18 } });
  // central high hub at y=8 (links the two lobes → figure-8)
  boxes.push({ min: { x: -7, y: 8, z: -6 }, max: { x: 7, y: 8.6, z: 6 } });
  // mid-gap "lamp-post" boost pillars (2×2, 12m) standing in the leap paths
  boxes.push({ min: { x: -3, y: 0, z: -16 }, max: { x: -1, y: 12, z: -14 } });
  boxes.push({ min: { x: 1, y: 0, z: 14 }, max: { x: 3, y: 12, z: 16 } });
  boxes.push({ min: { x: -15, y: 0, z: -1 }, max: { x: -13, y: 12, z: 1 } });
  boxes.push({ min: { x: 13, y: 0, z: -1 }, max: { x: 15, y: 12, z: 1 } });
  // step-ramps to two corner platforms (connectivity for non-boosters)
  boxes.push({ min: { x: -32, y: 0, z: -16 }, max: { x: -28, y: 1.3, z: -12 } });
  boxes.push({ min: { x: -32, y: 1.3, z: -16 }, max: { x: -30, y: 2.6, z: -12 } });
  boxes.push({ min: { x: -30, y: 2.6, z: -16 }, max: { x: -28, y: 4, z: -12 } });
  boxes.push({ min: { x: 28, y: 0, z: 12 }, max: { x: 32, y: 1.3, z: 16 } });
  boxes.push({ min: { x: 30, y: 1.3, z: 12 }, max: { x: 32, y: 2.6, z: 16 } });
  boxes.push({ min: { x: 28, y: 2.6, z: 12 }, max: { x: 30, y: 4, z: 16 } });
  // low-ground cover in the pit
  boxes.push({ min: { x: -6, y: 0, z: -20 }, max: { x: -2, y: 1.2, z: -17 } });
  boxes.push({ min: { x: 2, y: 0, z: 17 }, max: { x: 6, y: 1.2, z: 20 } });
  return {
    name: 'Causeway',
    boxes,
    spawn: { x: 0, y: 0.05, z: 19 },
    bounds: { min: { x: -35, y: -1, z: -25 }, max: { x: 35, y: 22, z: 25 } },
    accent: 0x5ce1ff,
    // Void theme: deep space overhead. The cap (boxes[1]) still collides;
    // it just isn't drawn, and rail impacts on it are suppressed (weapon.ts).
    openTop: true,
  };
})();

// "Reactor" — big tri-atrium (Lab homage). Two flat side lobes (long rail lanes
// broken by pillars) flank a tall central reactor shaft with boost-gated
// gantries climbing to a commanding top catwalk.
export const REACTOR: ArenaMap = (() => {
  const boxes: AABB[] = [];
  boxes.push({ min: { x: -40, y: -1, z: -28 }, max: { x: 40, y: 0, z: 28 } });
  boxes.push({ min: { x: -40, y: 23, z: -28 }, max: { x: 40, y: 24, z: 28 } });
  boxes.push({ min: { x: -40, y: 0, z: -28 }, max: { x: -38, y: 23, z: 28 } });
  boxes.push({ min: { x: 38, y: 0, z: -28 }, max: { x: 40, y: 23, z: 28 } });
  boxes.push({ min: { x: -40, y: 0, z: -28 }, max: { x: 40, y: 23, z: -26 } });
  boxes.push({ min: { x: -40, y: 0, z: 26 }, max: { x: 40, y: 23, z: 28 } });
  // partial divider walls → 3 chambers (gaps left for flow)
  boxes.push({ min: { x: -14, y: 0, z: -26 }, max: { x: -12, y: 14, z: -8 } });
  boxes.push({ min: { x: -14, y: 0, z: 8 }, max: { x: -12, y: 14, z: 26 } });
  boxes.push({ min: { x: 12, y: 0, z: -26 }, max: { x: 14, y: 14, z: -8 } });
  boxes.push({ min: { x: 12, y: 0, z: 8 }, max: { x: 14, y: 14, z: 26 } });
  // central reactor core 6×6, 14m (boostable faces)
  boxes.push({ min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 14, z: 3 } });
  // offset gantry ledges (boost opposite faces to climb)
  boxes.push({ min: { x: 3, y: 5, z: -3 }, max: { x: 10, y: 5.6, z: 1 } });
  boxes.push({ min: { x: -10, y: 9.5, z: -1 }, max: { x: -3, y: 10.1, z: 3 } });
  // reactor-top catwalk (elite overlook)
  boxes.push({ min: { x: -4, y: 14, z: -4 }, max: { x: 4, y: 14.6, z: 4 } });
  // side lobe platforms (y=3.5) + rail-lane-breaking pillars
  boxes.push({ min: { x: -34, y: 3.5, z: -8 }, max: { x: -22, y: 4.1, z: 8 } });
  boxes.push({ min: { x: 22, y: 3.5, z: -8 }, max: { x: 34, y: 4.1, z: 8 } });
  boxes.push({ min: { x: -30, y: 0, z: -20 }, max: { x: -28, y: 7, z: -18 } });
  boxes.push({ min: { x: -30, y: 0, z: 18 }, max: { x: -28, y: 7, z: 20 } });
  boxes.push({ min: { x: 28, y: 0, z: -20 }, max: { x: 30, y: 7, z: -18 } });
  boxes.push({ min: { x: 28, y: 0, z: 18 }, max: { x: 30, y: 7, z: 20 } });
  // step-ramps onto lobe platforms
  boxes.push({ min: { x: -22, y: 0, z: -2 }, max: { x: -20, y: 1.2, z: 2 } });
  boxes.push({ min: { x: -24, y: 1.2, z: -2 }, max: { x: -22, y: 2.4, z: 2 } });
  boxes.push({ min: { x: -26, y: 2.4, z: -2 }, max: { x: -24, y: 3.5, z: 2 } });
  boxes.push({ min: { x: 20, y: 0, z: -2 }, max: { x: 22, y: 1.2, z: 2 } });
  boxes.push({ min: { x: 22, y: 1.2, z: -2 }, max: { x: 24, y: 2.4, z: 2 } });
  boxes.push({ min: { x: 24, y: 2.4, z: -2 }, max: { x: 26, y: 3.5, z: 2 } });
  // low cover near spawns
  boxes.push({ min: { x: -34, y: 0, z: -22 }, max: { x: -30, y: 1.2, z: -19 } });
  boxes.push({ min: { x: 30, y: 0, z: 19 }, max: { x: 34, y: 1.2, z: 22 } });
  return {
    name: 'Reactor',
    boxes,
    spawn: { x: -30, y: 0.05, z: 0 },
    bounds: { min: { x: -40, y: -1, z: -28 }, max: { x: 40, y: 24, z: 28 } },
    accent: 0x7dffd0,
  };
})();

// ─────────────────────────────────────────────────────────────────────────
// 1v1 duel maps (open-top so the skybox shows). Small, readable, symmetric,
// with boost-gated high ground that's strong-but-exposed. aim_rust-inspired.
// ─────────────────────────────────────────────────────────────────────────

// "Container Yard" — aim_rust homage: symmetric container yard, central dropbox
// stack you climb, and a boost-only crown perch that overlooks both spawns.
export const CONTAINERYARD: ArenaMap = (() => {
  const boxes: AABB[] = [];
  boxes.push({ min: { x: -13, y: -1, z: -11 }, max: { x: 13, y: 0, z: 11 } });
  boxes.push({ min: { x: -13, y: 12, z: -11 }, max: { x: 13, y: 13, z: 11 } }); // invisible cap
  boxes.push({ min: { x: -13, y: 0, z: -11 }, max: { x: -12, y: 12, z: 11 } });
  boxes.push({ min: { x: 12, y: 0, z: -11 }, max: { x: 13, y: 12, z: 11 } });
  boxes.push({ min: { x: -13, y: 0, z: -11 }, max: { x: 13, y: 12, z: -10 } });
  boxes.push({ min: { x: -13, y: 0, z: 10 }, max: { x: 13, y: 12, z: 11 } });
  // Central dropbox (2.6m base + 3.0m cap) and the boost-only crown perch.
  boxes.push({ min: { x: -3, y: 0, z: -2.5 }, max: { x: 3, y: 2.6, z: 2.5 } });
  boxes.push({ min: { x: -2, y: 2.6, z: -1.5 }, max: { x: 2, y: 3.0, z: 1.5 } });
  boxes.push({ min: { x: -1.5, y: 8.0, z: -1.5 }, max: { x: 1.5, y: 8.5, z: 1.5 } });
  // Mirrored mixed-height container cover.
  boxes.push({ min: { x: 4, y: 0, z: -8 }, max: { x: 8, y: 2.6, z: -5 } });
  boxes.push({ min: { x: 2.5, y: 0, z: -8 }, max: { x: 4, y: 1.5, z: -6 } });
  boxes.push({ min: { x: -8, y: 0, z: 5 }, max: { x: -4, y: 2.6, z: 8 } });
  boxes.push({ min: { x: -4, y: 0, z: 6 }, max: { x: -2.5, y: 1.5, z: 8 } });
  boxes.push({ min: { x: -8, y: 0, z: -8 }, max: { x: -4, y: 1.2, z: -5 } });
  boxes.push({ min: { x: 4, y: 0, z: 5 }, max: { x: 8, y: 1.2, z: 8 } });
  // Boostable lane pillars (within 4m of the lanes) for wall-boost flanks.
  boxes.push({ min: { x: -10, y: 0, z: -1 }, max: { x: -8, y: 4, z: 1 } });
  boxes.push({ min: { x: 8, y: 0, z: -1 }, max: { x: 10, y: 4, z: 1 } });
  // Spawn-protection crates.
  boxes.push({ min: { x: -11, y: 0, z: 4 }, max: { x: -9, y: 1.2, z: 7 } });
  boxes.push({ min: { x: 9, y: 0, z: -7 }, max: { x: 11, y: 1.2, z: -4 } });
  return {
    name: 'Container Yard',
    boxes,
    spawn: { x: -10.5, y: 0.05, z: 8.5 },
    bounds: { min: { x: -13, y: -1, z: -11 }, max: { x: 13, y: 13, z: 11 } },
    accent: 0x5ce1ff,
    openTop: true,
  };
})();

// "Derrick" — vertical tower duel: spiral-boost the central derrick's faces up
// through offset gantries to a skylined crown catwalk over the whole yard.
export const DERRICK: ArenaMap = (() => {
  const boxes: AABB[] = [];
  boxes.push({ min: { x: -12, y: -1, z: -12 }, max: { x: 12, y: 0, z: 12 } });
  boxes.push({ min: { x: -12, y: 22, z: -12 }, max: { x: 12, y: 23, z: 12 } });
  boxes.push({ min: { x: -12, y: 0, z: -12 }, max: { x: -11, y: 22, z: 12 } });
  boxes.push({ min: { x: 11, y: 0, z: -12 }, max: { x: 12, y: 22, z: 12 } });
  boxes.push({ min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 22, z: -11 } });
  boxes.push({ min: { x: -12, y: 0, z: 11 }, max: { x: 12, y: 22, z: 12 } });
  // Central derrick + crown catwalk.
  boxes.push({ min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 11, z: 2 } });
  boxes.push({ min: { x: -3, y: 11, z: -3 }, max: { x: 3, y: 11.5, z: 3 } });
  // Offset gantry ledges (boost opposite faces to spiral up).
  boxes.push({ min: { x: 2, y: 5.0, z: -2 }, max: { x: 7, y: 5.5, z: 2 } });
  boxes.push({ min: { x: -7, y: 5.0, z: -2 }, max: { x: -2, y: 5.5, z: 2 } });
  boxes.push({ min: { x: -2, y: 8.0, z: 2 }, max: { x: 2, y: 8.5, z: 7 } });
  boxes.push({ min: { x: -2, y: 8.0, z: -7 }, max: { x: 2, y: 8.5, z: -2 } });
  // Generator roofs near spawns (secondary high ground + cover).
  boxes.push({ min: { x: -10, y: 0, z: 5 }, max: { x: -6, y: 2.0, z: 9 } });
  boxes.push({ min: { x: 6, y: 0, z: -9 }, max: { x: 10, y: 2.0, z: -5 } });
  // Boostable flank pillars + waist cover.
  boxes.push({ min: { x: -9, y: 0, z: -7 }, max: { x: -7, y: 6, z: -5 } });
  boxes.push({ min: { x: 7, y: 0, z: 5 }, max: { x: 9, y: 6, z: 7 } });
  boxes.push({ min: { x: -6, y: 0, z: -2 }, max: { x: -3, y: 1.2, z: 2 } });
  boxes.push({ min: { x: 3, y: 0, z: -2 }, max: { x: 6, y: 1.2, z: 2 } });
  return {
    name: 'Derrick',
    boxes,
    // Open-floor NE corner — clear of the generator roofs (NW/SE corners),
    // the central derrick, and the flank pillars.
    spawn: { x: 9, y: 0.05, z: 9 },
    bounds: { min: { x: -12, y: -1, z: -12 }, max: { x: 12, y: 23, z: 12 } },
    accent: 0xff9a5c,
    openTop: true,
  };
})();

// "Training Range" — single-player practice arena (open-top). Three zones laid
// out so all are visible from spawn: an aim gallery (varied-distance/height
// targets), a center movement gauntlet (gap-jumps at 7/10/13/16m + a strafe
// runway), and a boost-jump tower (boost-only ledges 4.5-6m apart + a
// wall-boost slalom). Use with the lobby's endless "Practice Range" mode.
export const TRAINING: ArenaMap = (() => {
  const boxes: AABB[] = [];
  // floor + invisible cap (openTop hides the ceiling so the sky shows)
  boxes.push({ min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 0, z: 20 } });
  boxes.push({ min: { x: -23, y: 24, z: -20 }, max: { x: 23, y: 25, z: 20 } });
  // perimeter walls (full height so boost-jumps can't escape over them)
  boxes.push({ min: { x: -23, y: 0, z: -20 }, max: { x: -22, y: 24, z: 20 } });
  boxes.push({ min: { x: 22, y: 0, z: -20 }, max: { x: 23, y: 24, z: 20 } });
  boxes.push({ min: { x: -23, y: 0, z: -20 }, max: { x: 23, y: 24, z: -19 } });
  boxes.push({ min: { x: -23, y: 0, z: 19 }, max: { x: 23, y: 24, z: 20 } });

  // ── Zone A: aim gallery (left lobe) — pedestals at varied height/distance
  // for bots to roam/perch on, plus waist-high cover to peek around.
  boxes.push({ min: { x: -18, y: 0, z: 5 }, max: { x: -16, y: 1.2, z: 7 } });
  boxes.push({ min: { x: -14, y: 0, z: -3 }, max: { x: -12, y: 2.5, z: -1 } });
  boxes.push({ min: { x: -10, y: 0, z: -14 }, max: { x: -8, y: 1.5, z: -12 } });
  boxes.push({ min: { x: -15, y: 0, z: 2 }, max: { x: -13, y: 1.2, z: 4 } });
  boxes.push({ min: { x: -9, y: 0, z: -6 }, max: { x: -7, y: 1.2, z: -4 } });

  // ── Zone B: movement gauntlet (center) — low pads with growing gaps
  // (7/10/13/16m). Misses just drop to the floor — no death, walk back.
  boxes.push({ min: { x: -2, y: 0, z: 16 }, max: { x: 2, y: 1, z: 18 } }); // start
  boxes.push({ min: { x: -2, y: 1, z: 8 }, max: { x: 2, y: 1.5, z: 10 } }); // +7m
  boxes.push({ min: { x: -2, y: 1, z: -2 }, max: { x: 2, y: 1.5, z: 0 } }); // +10m
  boxes.push({ min: { x: -2, y: 1, z: -15 }, max: { x: 2, y: 1.5, z: -13 } }); // +13m
  boxes.push({ min: { x: -3, y: 1, z: -18.8 }, max: { x: 3, y: 1.5, z: -17 } }); // +16m

  // ── Zone C: boost-jump tower (right lobe) — boost-only ledges (4.5-6m
  // apart, laterally offset to force chain+air-steer) + wall-boost slalom.
  boxes.push({ min: { x: 12, y: 0, z: -1 }, max: { x: 14, y: 12, z: 1 } }); // boost pillar
  boxes.push({ min: { x: 6, y: 4.5, z: -3 }, max: { x: 10, y: 5.1, z: 1 } }); // L1
  boxes.push({ min: { x: 15, y: 9, z: -2 }, max: { x: 19, y: 9.6, z: 2 } }); // L2
  boxes.push({ min: { x: 8, y: 13.5, z: 2 }, max: { x: 12, y: 14.1, z: 6 } }); // L3
  boxes.push({ min: { x: 13, y: 18, z: -2 }, max: { x: 17, y: 18.6, z: 2 } }); // crown
  // wall-boost slalom pillars (within BOOST_RANGE of each other, z-staggered)
  boxes.push({ min: { x: 5, y: 0, z: 8 }, max: { x: 7, y: 7, z: 10 } });
  boxes.push({ min: { x: 9, y: 0, z: 12 }, max: { x: 11, y: 7, z: 14 } });
  boxes.push({ min: { x: 13, y: 0, z: 8 }, max: { x: 15, y: 7, z: 10 } });
  boxes.push({ min: { x: 17, y: 0, z: 12 }, max: { x: 19, y: 7, z: 14 } });

  return {
    name: 'Training Range',
    boxes,
    spawn: { x: 0, y: 0.05, z: 17 },
    bounds: { min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 25, z: 20 } },
    accent: 0xffb34a,
    openTop: true,
  };
})();

// "Nuketown" — homage to CoD's Nuketown, scaled up for free-for-all (64×44,
// open-top outdoor). Two mirrored two-storey houses face each other across a
// central road broken up by vehicle cover (a bus, a van, two cars); backyards
// behind each house and the side lanes around them are the (well-spread) spawn
// zones. Each house has an open front, a ramped upper-floor balcony overlooking
// the road, and a boost-only roof perch. Built from our arena texture set — a
// LAYOUT homage, not an art reproduction (we have no custom Nuketown textures).
export const NUKETOWN: ArenaMap = (() => {
  const boxes: AABB[] = [];
  // floor + invisible cap (openTop → skybox shows overhead)
  boxes.push({ min: { x: -32, y: -1, z: -22 }, max: { x: 32, y: 0, z: 22 } });
  boxes.push({ min: { x: -32, y: 16, z: -22 }, max: { x: 32, y: 17, z: 22 } });
  // perimeter walls (full height so boost-jumps can't escape)
  boxes.push({ min: { x: -32, y: 0, z: -22 }, max: { x: -31, y: 16, z: 22 } });
  boxes.push({ min: { x: 31, y: 0, z: -22 }, max: { x: 32, y: 16, z: 22 } });
  boxes.push({ min: { x: -32, y: 0, z: 21 }, max: { x: 32, y: 16, z: 22 } });
  boxes.push({ min: { x: -32, y: 0, z: -22 }, max: { x: 32, y: 16, z: -21 } });

  // ── West house (open front faces east, toward the road) ──
  boxes.push({ min: { x: -27, y: 0, z: -9 }, max: { x: -26, y: 7, z: 9 } }); // back wall
  boxes.push({ min: { x: -27, y: 0, z: 8 }, max: { x: -20, y: 7, z: 9 } }); // north side (partial)
  boxes.push({ min: { x: -27, y: 0, z: -9 }, max: { x: -20, y: 7, z: -8 } }); // south side (partial)
  boxes.push({ min: { x: -26, y: 3.6, z: -9 }, max: { x: -19, y: 4.0, z: 9 } }); // upper-floor balcony
  // ramp up to the balcony (1.3m steps, climbing back from the open front)
  boxes.push({ min: { x: -21, y: 0, z: -8 }, max: { x: -19, y: 1.3, z: -5 } });
  boxes.push({ min: { x: -24, y: 1.3, z: -8 }, max: { x: -21, y: 2.6, z: -5 } });
  boxes.push({ min: { x: -26, y: 2.6, z: -8 }, max: { x: -24, y: 4.0, z: -5 } });
  boxes.push({ min: { x: -18, y: 0, z: -3 }, max: { x: -17, y: 1.3, z: 3 } }); // front porch cover
  boxes.push({ min: { x: -27, y: 6.5, z: -9 }, max: { x: -19, y: 7.0, z: 9 } }); // boost-only roof perch

  // ── East house (mirror of the west house across x=0) ──
  boxes.push({ min: { x: 26, y: 0, z: -9 }, max: { x: 27, y: 7, z: 9 } }); // back wall
  boxes.push({ min: { x: 20, y: 0, z: 8 }, max: { x: 27, y: 7, z: 9 } }); // north side (partial)
  boxes.push({ min: { x: 20, y: 0, z: -9 }, max: { x: 27, y: 7, z: -8 } }); // south side (partial)
  boxes.push({ min: { x: 19, y: 3.6, z: -9 }, max: { x: 26, y: 4.0, z: 9 } }); // upper-floor balcony
  boxes.push({ min: { x: 19, y: 0, z: -8 }, max: { x: 21, y: 1.3, z: -5 } });
  boxes.push({ min: { x: 21, y: 1.3, z: -8 }, max: { x: 24, y: 2.6, z: -5 } });
  boxes.push({ min: { x: 24, y: 2.6, z: -8 }, max: { x: 26, y: 4.0, z: -5 } });
  boxes.push({ min: { x: 17, y: 0, z: -3 }, max: { x: 18, y: 1.3, z: 3 } }); // front porch cover
  boxes.push({ min: { x: 19, y: 6.5, z: -9 }, max: { x: 27, y: 7.0, z: 9 } }); // boost-only roof perch

  // ── Central road: the iconic Nuketown vehicle cover ──
  boxes.push({ min: { x: -6, y: 0, z: 9 }, max: { x: 8, y: 2.9, z: 12 } }); // school bus (full cover)
  boxes.push({ min: { x: -8, y: 0, z: -12 }, max: { x: 2, y: 2.6, z: -9 } }); // moving van (full cover)
  boxes.push({ min: { x: 3, y: 0, z: -6 }, max: { x: 8, y: 1.4, z: -3 } }); // car (chest cover)
  boxes.push({ min: { x: -8, y: 0, z: 3 }, max: { x: -3, y: 1.4, z: 6 } }); // car (chest cover)
  boxes.push({ min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 1.2, z: 2 } }); // central planter (waist cover)
  boxes.push({ min: { x: -2, y: 0, z: 15 }, max: { x: 3, y: 1.3, z: 18 } }); // north-lane crate
  boxes.push({ min: { x: -3, y: 0, z: -18 }, max: { x: 2, y: 1.3, z: -15 } }); // south-lane crate
  return {
    name: 'Nuketown',
    boxes,
    spawn: { x: -29, y: 0.05, z: 0 },
    bounds: { min: { x: -32, y: -1, z: -22 }, max: { x: 32, y: 17, z: 22 } },
    accent: 0xffd85c,
    openTop: true,
  };
})();

// Selectable map registry — the trimmed competitive pool plus the
// single-player practice range. Larger maps (Causeway/Reactor/Lounge) carry
// FFA/TDM; the tight symmetric maps (Container Yard/Derrick) carry 1v1 duels.
export const MAPS: ReadonlyArray<{ id: string; label: string; map: ArenaMap }> = [
  // larger FFA / TDM maps
  { id: 'causeway', label: 'Causeway (FFA/TDM)', map: CAUSEWAY },
  { id: 'reactor', label: 'Reactor (FFA/TDM)', map: REACTOR },
  { id: 'lounge', label: 'Lounge (FFA/TDM)', map: LOUNGE },
  { id: 'nuketown', label: 'Nuketown (FFA/TDM)', map: NUKETOWN },
  // 1v1 duel maps
  { id: 'containeryard', label: 'Container Yard (1v1)', map: CONTAINERYARD },
  { id: 'derrick', label: 'Derrick (1v1)', map: DERRICK },
  // practice
  { id: 'training', label: 'Training Range', map: TRAINING },
];

export const DEFAULT_MAP: ArenaMap = CAUSEWAY;

export function mapById(id: string): ArenaMap {
  return MAPS.find((m) => m.id === id)?.map ?? DEFAULT_MAP;
}

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

function bakeWorld(map: ArenaMap, key: string, theme: WorldTheme): WorldBake {
  const hit = bakeCache.get(key);
  if (hit) return hit;
  const openTop = !!map.openTop || theme.openSky;
  const boxes = map.boxes;
  const drawn = boxes.map((_, i) => !(i === 1 && openTop));
  const perimeter = boxes.map((b, i) => isPerimeter(i, b, map.bounds));
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
    maxTexels: 120_000,
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
  const bake: WorldBake = { lm, drawn, slots, tints, perimeter };
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
  };
}

// Builds the themed, lightmapped arena. Materials + geometry are created per
// build and disposed with the group on map switch (game.ts disposeGroup);
// textures and the lightmap atlas are cached for the session.
export function buildMapMesh(map: ArenaMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  group.userData.mapRoot = true;
  const id = mapIdOf(map);
  const theme = themeForMapId(id);
  const tex = getThemeTextures(theme.id);
  const world = bakeWorld(map, id ?? `anon:${map.name}`, theme);
  const { lm, slots, tints, perimeter, drawn } = world;

  const shading = createMapShading();
  shading.uSunScale.value = theme.sun.mapScale;
  shading.uFillScale.value = theme.fill.mapScale;
  shading.uHemiScale.value = theme.hemi.mapScale;
  shading.uIblScale.value = theme.env.mapScale;
  shading.uWorldSat.value = theme.worldSaturation;
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
    const solids = map.boxes.filter((_, i) => drawn[i]);
    for (let i = 0; i < map.boxes.length; i++) {
      if (!drawn[i]) continue;
      const b = map.boxes[i];
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
    boxes: map.boxes, bounds: map.bounds, drawn, slots, perimeter, lm, theme, tile: dressTex.tile, low: false,
  });
  if (dress.metal) {
    const p = theme.slots[theme.dress.slot];
    const mat = lightmappedMaterial(dressTex, { ...p, metalness: Math.min(1, p.metalness + 0.2) }, lm, shading);
    mat.roughness = 0.8;
    const mesh = new THREE.Mesh(dress.metal, mat);
    mesh.name = 'map:dress';
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (dress.paint) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.75,
      metalness: 0,
      lightMap: lm.texture,
      lightMapIntensity: lm.scale,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    applyMapShading(mat, shading);
    const mesh = new THREE.Mesh(dress.paint, mat);
    mesh.name = 'map:paint';
    mesh.userData.map = true;
    mesh.userData.surface = 'trim';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
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

export type CollisionResult = {
  position: Vec3;
  blocked: { x: boolean; y: boolean; z: boolean };
  groundContact: boolean;
  wallNormal: Vec3 | null;
};

export function movePlayer(
  pos: Vec3,
  size: Vec3,
  delta: Vec3,
  boxes: AABB[],
): CollisionResult {
  let nx = pos.x;
  let ny = pos.y;
  let nz = pos.z;
  const hx = size.x / 2;
  const hz = size.z / 2;
  const blocked = { x: false, y: false, z: false };
  let groundContact = false;
  let wallNormal: Vec3 | null = null;
  const EPS = 1e-4;

  nx += delta.x;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.x > 0) {
      nx = b.min.x - hx - EPS;
      wallNormal = { x: -1, y: 0, z: 0 };
    } else if (delta.x < 0) {
      nx = b.max.x + hx + EPS;
      wallNormal = { x: 1, y: 0, z: 0 };
    }
    blocked.x = true;
  }

  nz += delta.z;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.z > 0) {
      nz = b.min.z - hz - EPS;
      wallNormal = { x: 0, y: 0, z: -1 };
    } else if (delta.z < 0) {
      nz = b.max.z + hz + EPS;
      wallNormal = { x: 0, y: 0, z: 1 };
    }
    blocked.z = true;
  }

  ny += delta.y;
  for (const b of boxes) {
    if (!overlap(nx - hx, ny, nz - hz, nx + hx, ny + size.y, nz + hz, b)) continue;
    if (delta.y > 0) {
      ny = b.min.y - size.y - EPS;
    } else if (delta.y < 0) {
      ny = b.max.y + EPS;
      groundContact = true;
    }
    blocked.y = true;
  }

  return { position: { x: nx, y: ny, z: nz }, blocked, groundContact, wallNormal };
}

function overlap(
  ax0: number, ay0: number, az0: number,
  ax1: number, ay1: number, az1: number,
  b: AABB,
): boolean {
  return (
    ax0 < b.max.x && ax1 > b.min.x &&
    ay0 < b.max.y && ay1 > b.min.y &&
    az0 < b.max.z && az1 > b.min.z
  );
}

export function rayAabb(o: Vec3, d: Vec3, b: AABB): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const dv = d[axis];
    const oa = o[axis];
    const lo = b.min[axis];
    const hi = b.max[axis];
    if (Math.abs(dv) < 1e-9) {
      if (oa < lo || oa > hi) return null;
    } else {
      let t1 = (lo - oa) / dv;
      let t2 = (hi - oa) / dv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin < 0 ? 0 : tmin;
}

// Like rayAabb but also returns the outward normal of the entry face — the
// direction to repel a boost-jumping player away from the surface. `d` need
// not be normalized; `t` is in units of |d|.
export function rayAabbNormal(
  o: Vec3,
  d: Vec3,
  b: AABB,
): { t: number; normal: Vec3 } | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis: 'x' | 'y' | 'z' = 'x';
  let sign = 0;
  for (const a of ['x', 'y', 'z'] as const) {
    const dv = d[a];
    const oa = o[a];
    const lo = b.min[a];
    const hi = b.max[a];
    if (Math.abs(dv) < 1e-9) {
      if (oa < lo || oa > hi) return null;
    } else {
      const inv = 1 / dv;
      let tNear = (lo - oa) * inv;
      let tFar = (hi - oa) * inv;
      if (tNear > tFar) {
        const tmp = tNear;
        tNear = tFar;
        tFar = tmp;
      }
      if (tNear > tmin) {
        tmin = tNear;
        axis = a;
        // Entry face normal points back toward the ray origin: -axis when
        // travelling +axis (hit the min face), +axis when travelling -axis.
        sign = dv > 0 ? -1 : 1;
      }
      if (tFar < tmax) tmax = tFar;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  const normal: Vec3 = { x: 0, y: 0, z: 0 };
  normal[axis] = sign;
  return { t, normal };
}

export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = 2 * (ox * d.x + oy * d.y + oz * d.z);
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / 2;
  const t2 = (-b + s) / 2;
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}
