import type { ArenaMap } from '../arena-map-data';
import { spawnAt, type MapBox } from './kit';

const p = (x: number, z: number) => spawnAt(x, z);

// "Training Range" — single-player practice arena (open-top). Three zones laid
// out so all are visible from spawn: an aim gallery (varied-distance/height
// targets), a center movement gauntlet (gap-jumps at 7/10/13/16m + a strafe
// runway), and a boost-jump tower (boost-only ledges 4.5-6m apart + a
// wall-boost slalom). Use with the lobby's endless "Practice Range" mode.
export const TRAINING: ArenaMap = (() => {
  const boxes: MapBox[] = [];
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
    spawns: [p(0, 17), p(-18, -10), p(18, -10), p(-18, 10), p(18, 10), p(0, 0)],
    spawn: { x: 0, y: 0.05, z: 17 },
    bounds: { min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 25, z: 20 } },
    accent: 0xffb34a,
    openTop: true,
  };
})();
