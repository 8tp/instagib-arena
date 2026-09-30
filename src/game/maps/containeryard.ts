import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, sym, symPoints, type MapBox } from './kit';

// "Container Yard" — 1v1 duel, a floodlit night container terminal.
//
// 68 × 58 m, rotationally symmetric (180° about the origin): each player owns
// a warehouse at one x end; the yard between them is container stacks in
// 2.6 m tiers (2.6 / 5.2 / 7.8 / 10.4) forming lanes, alleys and gangway-
// linked decks, and a gantry crane straddles the middle court — its girder
// ring and trolley deck (14 m, cab 15.6 m) are the contested apex, reached by
// boosting off the 10.4 m boost stacks or the 7.8 m lane walls.
//
// Zones (west half; the east half is its 180° twin):
//   Warehouse  x −33…−24, |z| < 12.5 — spawn hall (two yard doors + a north
//              side door), mezzanine at 3.9, walkable roof at 7.8.
//   Stair yard NW corner — a container staircase (1.3 → 2.6 → 5.2 → 7.8)
//              up to the warehouse roof.
//   Apron      in front of the warehouse doors: door screen, the 10.4 m boost
//              stack and its 7.8 landing, the gangway from the roof.
//   Lanes      the north/south quay lanes (≈ 50 m rail lanes, crates and
//              gangways break them; the block rows behind them are the flank),
//              and the inner lanes that skirt the crane court.
//   Crane court under the gantry: a crossed container "dropbox" in the middle.
//
// Tags drive the look: c-a / c-b / c-c are container paint slots (the look
// colours them by side), crate, shed, roof, deck, gangway, crane, bogie.

const T = 2.6; // container tier height

// A container stack over [x0,x1]×[z0,z1]: one box per tier (so every tier
// can take its own paint) from tier `from` up to `tiers` tiers tall.
function stack(x0: number, z0: number, x1: number, z1: number, paints: string[], from = 0): MapBox[] {
  return paints.map((p, k) => B(x0, (from + k) * T, z0, x1, (from + k + 1) * T, z1, p));
}
const crate = (x: number, z: number, w: number, d: number, h = 1.3): MapBox => C(x, z, w, d, 0, h, 'crate');

export const CONTAINERYARD: ArenaMap = (() => {
  const HX = 34;
  const HZ = 29;
  const CAP = 26;
  const { boxes: base, bounds } = shell(HX, HZ, CAP);

  // Everything authored for the west half (x < 0, all z); sym 'rot' makes the east.
  const west: MapBox[] = [
    // ── warehouse ────────────────────────────────────────────────────────
    B(-33, 0, -12.5, -32.5, 7.2, 12.5, 'shed'), // back wall (inside the sky-brush perimeter)
    B(-32.5, 0, -12.5, -27.5, 7.2, -12, 'shed'), // north wall, side door x −27.5…−24.5
    B(-24.5, 0, -12.5, -24, 7.2, -12, 'shed'),
    B(-27.5, 4.2, -12.5, -24.5, 7.2, -12, 'shed'),
    B(-32.5, 0, 12, -28.5, 7.2, 12.5, 'shed'), // south wall, side door x −28.5…−25.5
    B(-25.5, 0, 12, -24, 7.2, 12.5, 'shed'),
    B(-28.5, 4.2, 12, -25.5, 7.2, 12.5, 'shed'),
    B(-24.5, 0, -12, -24, 7.2, -8, 'shed'), // front wall with two 6 m doors
    B(-24.5, 0, -1.5, -24, 7.2, 1.5, 'shed'),
    B(-24.5, 0, 8, -24, 7.2, 12, 'shed'),
    B(-24.5, 4.8, -8, -24, 7.2, -1.5, 'shed'),
    B(-24.5, 4.8, 1.5, -24, 7.2, 8, 'shed'),
    B(-33, 7.2, -12.5, -24, 7.8, 12.5, 'roof'),
    // mezzanine along the back wall + its jump-steps
    B(-32.5, 3.5, -12, -29.5, 3.9, -2, 'deck'),
    B(-32.5, 0, -2, -30.5, 2.6, 0.5, 'crate'),
    B(-32.5, 0, 0.5, -30.5, 1.3, 2.5, 'crate'),
    crate(-27.5, 5, 2, 2),
    crate(-27.5, -8, 2, 2),

    // ── stair yard (NW): container staircase up to the roof ──────────────
    ...stack(-33, -18.5, -30.5, -12.5, ['c-a', 'c-b', 'c-a']), // 7.8, flush with the roof
    ...stack(-30.5, -18.5, -28, -12.5, ['c-c', 'c-a']), // 5.2
    ...stack(-33, -21, -27, -18.5, ['c-b']), // 2.6
    crate(-26.25, -19.75, 1.5, 2.5),

    // ── north perimeter row (quay wall) ─────────────────────────────────
    ...stack(-33, -28, -21, -25.5, ['c-c', 'c-a']), // 5.2
    ...stack(-21, -28, -9, -25.5, ['c-b']), // 2.6
    ...stack(-15, -28, -9, -25.5, ['c-a'], 1), // 5.2 half
    ...stack(-9, -28, 3, -25.5, ['c-a', 'c-c', 'c-b']), // 7.8 (twin at x −3…9, z 25.5…28)
    // ── south perimeter row (west part) ────────────────────────────────
    ...stack(-33, 25.5, -27, 28, ['c-b']),
    ...stack(-27, 25.5, -15, 28, ['c-c', 'c-b']),
    ...stack(-15, 25.5, -3, 28, ['c-a']),

    // ── north lane cover + gangways ─────────────────────────────────────
    crate(-16, -22.5, 2, 2),
    crate(-6, -21, 2.5, 1.5),
    slab(-22.5, -25.5, -20.5, -19.5, 5.2, 'gangway', 0.4), // P1 ↔ NB1 upper
    slab(-4, -25.5, -2, -19.5, 7.8, 'gangway', 0.4), // P3 ↔ NB2
    // ── south lane cover ───────────────────────────────────────────────
    crate(-20, 22, 2, 2),
    crate(-9, 23.5, 2.5, 1.5),

    // ── north block row ─────────────────────────────────────────────────
    ...stack(-23, -19.5, -11, -17, ['c-b']),
    ...stack(-23, -19.5, -17, -17, ['c-c'], 1), // 5.2
    crate(-17, -15.6, 2.5, 1.6),
    ...stack(-7, -19.5, 5, -17, ['c-a', 'c-b', 'c-c']), // NB2 lane wall 7.8
    ...stack(-7, -17, -1, -14.5, ['c-c']),
    // ── south block row (west part) ───────────────────────────────────
    ...stack(-22, 14.5, -16, 17, ['c-c']),
    ...stack(-22, 17, -16, 19.5, ['c-a', 'c-b']), // 5.2
    ...stack(-12, 17, -9.5, 20, ['c-b']),
    crate(-10.75, 15.9, 2.5, 1.6),

    // ── apron ───────────────────────────────────────────────────────────
    ...stack(-20, -8, -17.5, -2, ['c-c']), // door screen
    crate(-16.75, -3.5, 1.5, 2),
    ...stack(-15.5, -8, -13, -2, ['c-b', 'c-a', 'c-c']), // landing 7.8
    ...stack(-13, -8, -10.5, -2, ['c-a', 'c-c', 'c-b', 'c-a']), // boost stack 10.4
    slab(-24, -6, -15.5, -4, 7.8, 'gangway', 0.4), // roof → landing
    ...stack(-21, 3, -9, 5.5, ['c-a']),
    ...stack(-18, 3, -12, 5.5, ['c-b'], 1), // 5.2
    crate(-9.75, 6.3, 1.5, 1.6),

    // ── gantry crane (west legs; the rot twin supplies the east pair) ──
    C(-6.5, -9, 1.2, 1.2, 0, 13.2, 'crane'),
    C(-6.5, 9, 1.2, 1.2, 0, 13.2, 'crane'),
    C(-6.5, -9, 2.2, 3.2, 0, 1.2, 'bogie'),
    C(-6.5, 9, 2.2, 3.2, 0, 1.2, 'bogie'),
    B(-7.2, 13.2, -9.6, -5.8, 14, 9.6, 'crane'), // west girder (walkable 14)
    B(-5.8, 13.2, -9.6, 5.8, 14, -8.4, 'crane'), // north cross girder (twin = south)
  ];

  // Self-symmetric centre pieces (added once).
  const centre: MapBox[] = [
    slab(-5.8, -2.5, 5.8, 2.5, 14, 'crane', 0.6), // trolley deck — the apex
    C(0, 0, 3, 1.6, 14, 15.6, 'cab'),
    B(-3, 0, -1.25, 3, T, 1.25, 'c-a'), // crossed dropbox
    B(-1.25, T, -3, 1.25, 2 * T, 3, 'c-b'),
  ];

  const boxes: MapBox[] = [...base, ...sym(west, 'rot'), ...centre];

  const spawns = symPoints(
    [
      spawnAt(-28, 9), // hall
      spawnAt(-31, -7, 3.9), // mezzanine
      spawnAt(-29, -24), // stair yard, lane end
      spawnAt(-15, 4.25, 5.2), // apron deck
      spawnAt(-28, 20), // SW yard
    ],
    'rot',
  );

  return {
    name: 'Container Yard',
    boxes,
    spawns,
    spawn: spawns[0],
    bounds,
    accent: 0x5ce1ff,
    openTop: true,
  };
})();
