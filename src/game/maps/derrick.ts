import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, steps, sym, symPoints, type MapBox } from './kit';

// "Derrick" — 1v1 duel in an oil-refinery yard at dusk (68 × 58 m, rotational
// symmetry about the drill centre).
//
//   Tiers   0 yard · 1.2–3 pump houses, drums, skids · 4.5–7.5 control
//           roofs, pipe racks (6), tank tops (5.5 / 7.5), low gantries (5) ·
//           8–10 doghouse roofs + high gantries · 14.5 crown (apex).
//   Centre  the derrick: a stepped 6×6 → 3×3 lattice tower. Low gantries (5 m)
//           on its ±x faces, high gantries (10 m) on its ±z faces, joined by
//           the driller's doghouse (roof 8 m) on each low deck — a
//           double-jump spiral. The crown (14.5 m) is boost-only.
//   Racks   two N–S pipe racks at 6 m (x = ±14) cross the whole yard; each
//           links one side's control building to the other side's tank farm
//           and meets a low gantry mid-way — elevated lanes with a pipe bundle
//           for cover on their outer edge.
//   Sides   north: tank farm (NW) + control building with a T-shaped
//           ground-floor pass-through and a 4.5 m roof deck (NE); south is the 180° twin.
//   Lanes   back lanes along x (z ≈ ±25), side corridors along z (x ≈ ±30),
//           the racks, the ground under the racks — each broken by pump jacks,
//           valve clusters and rack bents.
export const DERRICK: ArenaMap = (() => {
  const HX = 34;
  const HZ = 29;
  const CAP = 26;
  const { boxes: base, bounds } = shell(HX, HZ, CAP);

  // Round tank: five overlapping rectangles whose corners sit on the circle
  // (a 20-sided outline, steps ≤ 1.3 m) in three courses — shell, a painted
  // band, and a rim course whose tops form one flush roof (no lips).
  const TANK_ANGLES = [9, 27, 45, 63, 81].map((d) => (d * Math.PI) / 180);
  const tank = (cx: number, cz: number, d: number, top: number): MapBox[] => {
    const r = d / 2;
    const courses: Array<[number, number, string]> = [
      [0, top - 1.8, 'tank'],
      [top - 1.8, top - 0.7, 'tankband'],
      [top - 0.7, top, 'tankroof'],
    ];
    return courses.flatMap(([y0, y1, tag]) =>
      TANK_ANGLES.map((t) => C(cx, cz, 2 * r * Math.cos(t), 2 * r * Math.sin(t), y0, y1, tag)),
    );
  };

  // Pump jack: skid, samson post and walking beam (reads as a silhouette,
  // gives waist cover).
  const pumpJack = (x: number, z: number): MapBox[] => [
    C(x, z, 4, 1.4, 0, 1.0, 'jack'),
    C(x + 0.4, z, 0.6, 0.6, 1.0, 3.4, 'jackpost'),
    C(x, z, 5.2, 0.5, 3.4, 3.9, 'jackbeam'),
  ];

  // ── the derrick (self-symmetric) ──
  const centre: MapBox[] = [
    C(0, 0, 6, 6, 0, 6, 'derrick'),
    C(0, 0, 3, 3, 6, 14, 'derrick'),
    slab(-4, -4, 4, 4, 14.5, 'crown'),
    C(0, 0, 1.6, 1.6, 14.5, 15.6, 'crownblock'),
  ];

  // ── one of each rotational pair ──
  const half: MapBox[] = [
    // Gantry spiral: east low deck (5) → driller's doghouse roof (8) → north
    // high deck (10), each a double jump; the crown is boost-only.
    slab(3, -2.5, 10, 2.5, 5, 'gantry'),
    B(5.5, 5, 0, 8.5, 8, 2.5, 'doghouse'),
    slab(-2.5, 1.5, 2.5, 9, 10, 'gantry'),
    // Jump-steps up to the east low deck from the south yard.
    ...steps('+z', -9, -2.5, 6.5, 9.5, 0, 3.6, { tag: 'stair' }),

    // East pipe rack (6 m) with its pipe bundle and bents.
    slab(12.5, -20, 15.5, 20, 6, 'rack'),
    B(15.0, 6, -20, 15.5, 6.9, 20, 'pipe'),
    ...[-18, -6, 6, 18].flatMap((z) => [C(12.8, z, 0.5, 0.5, 0, 5.5, 'column'), C(15.2, z, 0.5, 0.5, 0, 5.5, 'column')]),

    // NE control building: two blocks, a lintel over the N–S pass-through,
    // a rooftop unit, jump-steps from the yard to the roof deck.
    B(17, 0, 12, 20.5, 4.5, 21, 'building'),
    B(23.5, 0, 12, 27, 4.5, 15, 'building'),
    B(23.5, 0, 18, 27, 4.5, 21, 'building'),
    B(20.5, 3.5, 12, 23.5, 4.5, 21, 'lintel'),
    B(23.5, 3.5, 15, 27, 4.5, 18, 'lintel'),
    C(18.75, 17, 2.5, 6, 4.5, 6.3, 'unit'),
    ...steps('+z', 8, 12, 24, 27, 0, 3.6, { tag: 'stair' }),

    // NW tank farm: big tank (7.5), small tank (5.5), a stair to the small one.
    ...tank(-22, 13, 9, 7.5),
    ...tank(-26, 23.5, 7, 5.5),
    ...steps('+z', 14, 20, -33, -31, 0, 4.8, { tag: 'stair' }),

    // East-court pump house (leaves a 2 m alley along the wall).
    C(28, 1, 6, 4, 0, 3, 'pumphouse'),
    // North-yard pump house.
    C(-4, 19, 8, 5, 0, 3, 'pumphouse'),

    // Pump jacks and valve clusters (waist cover along the lanes).
    ...pumpJack(6, 24),
    ...pumpJack(24, 25),
    C(8, 15.5, 2.4, 6, 0, 2.4, 'drum'), // separator drum on its saddles
    C(-9, 10, 1.5, 2.5, 0, 1.1, 'valve'),
    C(-28, 3, 3, 1.5, 0, 1.2, 'valve'),
  ];

  const boxes: MapBox[] = [...base, ...centre, ...sym(half, 'rot')];

  const spawns = symPoints(
    [
      spawnAt(-29.5, 6),
      spawnAt(-2, 25),
      spawnAt(22, 19.5, 4.5),
      spawnAt(30, 8),
    ],
    'rot',
  );

  return {
    name: 'Derrick',
    boxes,
    spawns,
    spawn: spawnAt(-2, 25),
    bounds,
    accent: 0xff9a5c,
    openTop: true,
  };
})();
