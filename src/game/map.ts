import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getArenaTextures, type SurfaceKind, type SurfaceTextures } from './textures';
import type { AABB, Vec3 } from './types';

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
// AABB arrays via movePlayer/rayAabb), so the render build is free to merge.
//
// Mesh tagging convention (for decal/impact raycasts, shadow setup, tint):
//   group.name = 'map', group.userData.mapRoot = true
//   every mesh: name = 'map:<kind>', userData.map = true, userData.surface =
//   'floor' | 'ceiling' | 'wall' | 'cover' | 'platform' | 'tower' | 'trim'
// Use isMapSurface(obj) to pick the solid surfaces and skip the trim bars.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_ACCENT = 0x5ce1ff;

// Per-surface material tuning for the PMREM RoomEnvironment + warm key light.
// Roughness is baked into the ORM texture (material.roughness stays a ×1
// multiplier); metalness is scalar. normalScale tames the baked ~45° bevels.
const SURFACE_MATERIALS: Record<SurfaceKind, { metalness: number; normalScale: number; ao: number }> = {
  floor: { metalness: 0.15, normalScale: 0.75, ao: 0.6 },
  ceiling: { metalness: 0.1, normalScale: 0.5, ao: 0.5 },
  wall: { metalness: 0.2, normalScale: 0.85, ao: 0.65 },
  cover: { metalness: 0.25, normalScale: 1.0, ao: 0.7 },
  platform: { metalness: 0.3, normalScale: 0.7, ao: 0.6 },
  tower: { metalness: 0.3, normalScale: 0.85, ao: 0.65 },
};

const SURFACE_KINDS: SurfaceKind[] = ['floor', 'ceiling', 'wall', 'cover', 'platform', 'tower'];

// Edge-light trim (metres): a thin bar wrapped around the side faces of
// platforms + cover just below their top edge. Low intensity so bloom only
// catches it lightly; never on floors, where it would compete with enemies.
const TRIM_HEIGHT = 0.06;
const TRIM_DEPTH = 0.03;
const TRIM_DROP = 0.16;
const TRIM_EMISSIVE = 1.9;

// Size heuristic that assigns each AABB a surface kind (unchanged from the
// original per-box build, so maps read the way they were authored).
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
// test against. Excludes the emissive trim bars.
export function isMapSurface(obj: THREE.Object3D): boolean {
  return obj.userData.map === true && obj.userData.surface !== 'trim';
}

// One AABB → BoxGeometry in WORLD space with world-projected UVs: each face's
// u/v are the world coordinates spanning it divided by `tile`, so texture
// scale is identical on a 2 m crate and a 60 m wall, and seams run
// continuously across adjacent boxes (ramps, stacked steps, wall segments).
function boxGeometry(b: AABB, tile: number): THREE.BufferGeometry {
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(nrm.getX(i)) > 0.5) uv.setXY(i, z / tile, y / tile);
    else if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, x / tile, z / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  return g;
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

// Colour is baked into the albedo, so materials stay white and the world-tint
// / full-bright control (game.ts applyWorldStyle) can drive `color` +
// `emissive` at runtime: emissiveMap MUST stay === map for that contract.
function surfaceMaterial(kind: SurfaceKind, t: SurfaceTextures): THREE.MeshStandardMaterial {
  const p = SURFACE_MATERIALS[kind];
  return new THREE.MeshStandardMaterial({
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
  });
}

// No emissiveMap on purpose: applyWorldStyle only retints materials that have
// one, so the accent trim keeps its colour under any world tint.
function trimMaterial(accent: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: accent.clone().multiplyScalar(0.12),
    emissive: accent,
    emissiveIntensity: TRIM_EMISSIVE,
    roughness: 0.35,
    metalness: 0,
  });
}

// Builds the arena as ONE merged mesh per surface kind (+ one for the trim)
// instead of one mesh per AABB: ≤ 7 draw calls per map. Materials are created
// per build and disposed with the group on map switch; textures are cached.
export function buildMapMesh(map: ArenaMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  group.userData.mapRoot = true;
  const tex = getArenaTextures();
  const accent = new THREE.Color(map.accent ?? DEFAULT_ACCENT);

  const parts: Record<SurfaceKind, THREE.BufferGeometry[]> = {
    floor: [], ceiling: [], wall: [], cover: [], platform: [], tower: [],
  };
  const trims: THREE.BufferGeometry[] = [];
  // Open-air arenas keep the ceiling for collision but don't draw it, so the
  // skybox shows overhead. It hides nothing, so it's not a trim occluder.
  const drawn = (i: number) => !(i === 1 && map.openTop);
  const solids = map.boxes.filter((_, i) => drawn(i));
  for (let i = 0; i < map.boxes.length; i++) {
    if (!drawn(i)) continue;
    const b = map.boxes[i];
    const kind = surfaceKindFor(i, b);
    parts[kind].push(boxGeometry(b, tex[kind].tile));
    if (kind === 'platform' || kind === 'cover') addTrim(trims, b, solids, map.bounds);
  }

  for (const kind of SURFACE_KINDS) {
    const geoms = parts[kind];
    if (!geoms.length) continue;
    const merged = mergeGeometries(geoms, false);
    geoms.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, surfaceMaterial(kind, tex[kind]));
    mesh.name = `map:${kind}`;
    mesh.userData.map = true;
    mesh.userData.surface = kind;
    mesh.receiveShadow = true;
    // The giant floor/ceiling slabs only receive; everything else casts.
    mesh.castShadow = kind !== 'floor' && kind !== 'ceiling';
    group.add(mesh);
  }

  if (trims.length) {
    const merged = mergeGeometries(trims, false);
    trims.forEach((g) => g.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, trimMaterial(accent));
      mesh.name = 'map:trim';
      mesh.userData.map = true;
      mesh.userData.surface = 'trim';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }
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
