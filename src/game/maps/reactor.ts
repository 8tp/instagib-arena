import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, steps, sym, symPoints, type MapBox } from './kit';

// "Reactor" — a power-plant interior, 96 × 72 m, closed roof at 30 m.
//
//   z −36 ┌──────────── N service corridor (enclosed, roof = N balcony @ 6) ─────────────┐
//         │ TURBINE HALL      ║        REACTOR HALL           ║       PUMP ROOM          │
//         │ (west)            ║  core 8×8 → apex deck @ 18    ║  (east)                  │
//         │ 2 turbine casings ║  L6 aprons (±z) · L12 (±x)    ║  tank tiers 3/6/9 m      │
//         │ @ 4.5 + gens 7.5  ║  bridges to the balconies @ 6 ║  pipe gallery @ 12 on    │
//         │ gallery @ 10 on   ║  gantries through the divider ║  the east wall, surge    │
//         │ the west wall,    ║  windows @ 12 into both wings ║  tower @ 15 on the pipe  │
//         │ catwalk @ 12, a   ║                               ║  bridge, service alley   │
//         │ crane girder @ 15 ║                               ║  behind the tanks        │
//   z +36 └──────────── S service corridor (enclosed, roof = S balcony @ 6) ─────────────┘
//
// Everything mirrors across z = 0 (north/south); the two wings differ in
// character but share the tier ladder 0 / 2–3 / 4.5–7.5 / 9–12 / 15 → apex 18.
// Long lanes: each wing along z (~60 m, broken by the machinery), the 12 m
// gantry line along x (east wall → core, broken by the surge tower), the
// balconies (32 m). Enclosed corridors with a chicane + the arcades under the
// wing mezzanines are the out-of-sight maintenance loop.
const HX = 48;
const HZ = 36;
const CAP = 30;

// Divider between the reactor hall and a wing, x ∈ [16, 16.75] (east side),
// z ≥ 0 half; the caller mirrors it to all four quadrants. Thin (0.75 m) so
// its top under the roof isn't a "surface"; the central gate / window pieces
// (crossing z = 0) are in the x-mirrored list.
const DX0 = 16;
const DX1 = 16.75;
function dividerQuarter(): MapBox[] {
  const t = 'divider';
  return [
    B(DX0, 0, 8.5, DX1, 23, 10, t), // pier between the gate and the side door
    B(DX0, 10, 10, DX1, 12, 22, t), // lintel between the side bay (y 0–10) and its window (12–22)
    B(DX0, 0, 22, DX1, CAP, 28.5, t),
    B(DX0, 6, 28.5, DX1, CAP, 35, t), // over the corridor mouth (corridor runs under)
  ];
}

export const REACTOR: ArenaMap = (() => {
  // Floor + cap from the kit; the perimeter walls are rebuilt in per-hall
  // runs so each hall's outer walls can carry their own material.
  const { boxes: shellBoxes, bounds } = shell(HX, HZ, CAP);
  const boxes: MapBox[] = [shellBoxes[0], shellBoxes[1]];
  const W = HX - 1;
  const D = HZ - 1;
  boxes.push(
    B(-HX, 0, -HZ, -W, CAP, HZ, 'wall-turbine'),
    B(W, 0, -HZ, HX, CAP, HZ, 'wall-pump'),
    ...[-1, 1].flatMap((s) => {
      const z0 = s < 0 ? -HZ : D;
      const z1 = s < 0 ? -D : HZ;
      return [
        B(-W, 0, z0, -DX0, CAP, z1, 'wall-turbine'),
        B(-DX0, 0, z0, DX0, CAP, z1, 'wall-hall'),
        B(DX0, 0, z0, W, CAP, z1, 'wall-pump'),
      ];
    }),
  );

  // ── reactor hall frame ────────────────────────────────────────────────
  const quad: MapBox[] = [...dividerQuarter()];
  // corridor inner wall (z 28.5–29.5) with two doorways (|x| 6–12)
  quad.push(B(0, 0, 28.5, 6, 5.5, 29.5, 'corridor'));
  quad.push(B(12, 0, 28.5, 16, 5.5, 29.5, 'corridor'));
  // L12 gantry bridge from the core ring to the divider window
  quad.push(slab(9, 0, 16, 1.5, 12, 'bridge', 0.6));
  // coolant pump housings in the hall (double-jump / cover)
  quad.push(C(8, 20, 3, 3, 0, 2.4, 'pump'));
  // low parapets along the balcony front
  quad.push(B(5, 6, 28.5, 11, 7.1, 29.2, 'parapet'));

  const xs: MapBox[] = [
    // central gate (floor, y 0–6) and the clerestory windows (y 12–22): the beam
    // between them carries the 12 m gantry threshold
    B(DX0, 6, -8.5, DX1, 12, 8.5, 'divider'),
    B(DX0, 23, -22, DX1, CAP, 22, 'divider'),
    // L12 gantry on the core's ±x faces
    slab(4, -4, 9, 4, 12, 'ring', 0.6),
  ];

  const zs: MapBox[] = [
    // balcony / corridor roof @ 6 (x −16.75 … 16.75 — sits in the divider notch)
    slab(-16.75, 28.5, 16.75, 35, 6, 'deck', 0.5),
    // corridor chicane: two staggered blocks break the 94 m corridor line
    B(-4, 0, 29.5, -1, 5.5, 32.5, 'corridor'),
    B(1, 0, 32, 4, 5.5, 35, 'corridor'),
    // L6 apron on the core's ±z faces
    slab(-9, 4, 9, 8, 6, 'ring', 0.6),
    // bridge apron → balcony
    slab(-1.5, 8, 1.5, 28.5, 6, 'bridge', 0.6),
    // bridge support column
    C(0, 18, 1.2, 1.2, 0, 5.4, 'column'),
    // stairs hall floor → balcony (against both dividers)
    ...steps('+z', 22, 28.5, -16, -12, 0, 6, { tag: 'stairs' }),
    ...steps('+z', 22, 28.5, 12, 16, 0, 6, { tag: 'stairs' }),
  ];

  const hall: MapBox[] = [
    // the core — its top is the apex deck @ 18
    B(-4, 0, -4, 4, 18, 4, 'core'),
    C(0, 0, 2, 2, 18, 19.2, 'apex'),
    // stairs floor → L6 aprons (south apron from +x, north apron from −x)
    ...steps('-x', 9, 15, 4, 8, 0, 6, { tag: 'stairs' }),
    ...steps('+x', -15, -9, -8, -4, 0, 6, { tag: 'stairs' }),
  ];

  // ── turbine hall (west wing, x −47 … −16.75), z ≥ 0 half ───────────────
  const turbine: MapBox[] = [
    // turbine casing and generator stator (a 3 m cross-gap between them),
    // the orange exciter housing on top of the stator
    B(-37, 0, 6, -29, 4.5, 16, 'turbine'),
    B(-37, 0, 19, -29, 4.5, 26, 'turbine'),
    B(-36, 4.5, 20, -30, 7.5, 26, 'generator'),
    // jump-steps from the cross passage up onto the casing
    ...steps('+z', 2.5, 6, -35, -31, 0, 4.5, { tag: 'stairs' }),
    // bearing pedestal beside the casing (double-jump up) + lane cover
    C(-38.5, 12, 3, 3, 0, 2.2, 'pump'),
    C(-43, 20, 3, 3, 0, 2.2, 'pump'),
    C(-22.5, 17, 3, 3, 0, 2.2, 'pump'),
    C(-24, 4, 2, 2, 0, 1.2, 'crate'),
    // west-wall gallery @ 10 (strafe gap at the middle)
    slab(-47, 5, -43.5, 22, 10, 'rail', 0.6),
    // divider-side catwalk @ 12 (meets the gantry window)
    slab(-20.5, 0, -16.75, 20, 12, 'rail', 0.6),
    // lube-oil tank in the corner (+ jump-steps): the boost pad to the gallery
    B(-47, 0, 28, -41, 4.5, 35, 'tank'),
    ...steps('-x', -41, -37, 29.5, 33.5, 0, 4.5, { tag: 'stairs' }),
  ];
  const turbineMid: MapBox[] = [
    // goliath crane: girder @ 15 from the west wall to a leg in the inner
    // lane (the leg is also the inner lane's mid cover), hoist trolley on top
    B(-47, 13.5, -3, -24, 15, 3, 'crane'),
    B(-25.5, 0, -3, -24, 13.5, 3, 'crane'),
    C(-33, 0, 3.5, 4.5, 15, 16.3, 'crane'),
  ];

  // ── pump room (east wing, x 16.75 … 47), z ≥ 0 half ────────────────────
  const pump: MapBox[] = [
    // tank tiers stepping up to the east wall: 3 → 6 → 9 → gallery 12
    B(29, 0, 12, 33, 3, 17, 'tank'),
    B(33, 0, 10, 38, 6, 19, 'tank'),
    B(38, 0, 7, 43.5, 9, 21, 'tank'),
    // east-wall pipe gallery @ 12 (service alley under it, behind the tanks)
    slab(43.5, 0, 47, 28.5, 12, 'rail', 0.6),
    C(46, 12, 2, 2, 12, 13.3, 'pipe'),
    // floor pumps / manifolds
    C(23, 4.5, 3, 3, 0, 1.2, 'crate'),
    C(34, 25, 4, 3, 0, 2.2, 'pump'),
    C(22, 24, 3, 3, 0, 2.2, 'pump'),
    // heat exchanger shell in front of the side door (cover)
    C(21.5, 16.5, 2.5, 3, 0, 2.2, 'pump'),
  ];
  const pumpMid: MapBox[] = [
    // pipe bridge @ 12 from the divider window to the east gallery, broken
    // by the surge tower (top 15, the wing's high perch)
    slab(16.75, -1.5, 29, 1.5, 12, 'bridge', 0.6),
    B(29, 0, -3, 35, 15, 3, 'surge'),
    slab(35, -1.5, 43.5, 1.5, 12, 'bridge', 0.6),
  ];

  boxes.push(
    ...hall,
    ...sym(quad, 'quad'),
    ...sym(xs, 'x'),
    ...sym(zs, 'z'),
    ...sym(turbine, 'z'),
    ...turbineMid,
    ...sym(pump, 'z'),
    ...pumpMid,
  );

  const spawns = symPoints(
    [
      spawnAt(-42, 27), // turbine west lane, by the oil-tank steps
      spawnAt(-23, 9), // turbine inner lane
      spawnAt(-33, 14, 4.5), // on a turbine casing
      spawnAt(25, 23), // pump room floor
      spawnAt(34.5, 14, 6), // pump tank tier
      spawnAt(45.2, 20), // service alley behind the tanks
      spawnAt(-10, 32), // corridor
      spawnAt(9.5, 25), // reactor hall floor, beside the balcony stairs
    ],
    'z',
  );

  return {
    name: 'Reactor',
    boxes,
    spawns,
    spawn: spawnAt(-23, 9),
    bounds,
    accent: 0x7dffd0,
  };
})();
