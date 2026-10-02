import type { ArenaMap } from '../arena-map-data';
import type { TrainingLayout } from '../training/layout';
import type { AABB, Vec3 } from '../types';
import { B, pt, shell, slab, spawnAt, steps, type MapBox } from './kit';

// "Training Range" — single-player practice facility (open sky), after
// Titanfall 2's Gauntlet, Valorant's Range, Apex's Firing Range, CS aim maps
// and Quake defrag courses. 120 × 84 m, cap 34 m.
//
//            north (−z)
//   ┌──────────── backstop ──────────┬SH┬───── C2 20 ──── C1 15 ════╦deck═╗
//   │  T3        SP2       T4        │  │ P4 runway ──── dash gap ── D  15  │
//   │                                │S │  P3                  ┌─────────┐ │
//   │  T1   AIM GALLERY    T2         │P │  P2   (pit)          │ BT 8.9  │ │
//   │  C1  (55 m deep)     SP1        │I │  P1                  │ chimney │ │
//   │ berm                  berm      │N │  P0        infield   └─────────┘ │
//   │        ═══ firing line ═══      │E │  steps                           │
//   │ bleachers        [F][S] HUB [C][G]          course start           │
//   └─────────────────────────── south (+z) ──────────────────────────────┘
//
// Zones:
//   Hub         x −16…16, z 24…41: spawn plaza, four challenge pads (flush
//               floor paint) in a row facing the spawn. Aim pads west, course
//               pads east.
//   Gallery     x −59…−9, z −41…20: firing line (painted, floor level) at
//               z 17…20 looking −z; lane lines, 10 m bars, berms, cover
//               blocks, raised strafe decks (3 / 6 m) and target towers
//               (6 / 7 / 10 / 12.5 m) in front of an 18 m backstop.
//   Spine       x −9…−5: the 12 m wall between the gallery and the course
//               (two ground portals); its top is the course's final run.
//   Course      the east half, run clockwise from the hub:
//     1 pit     jump-step onto P0 (2.4 m) and strafe-jump the pit north:
//               gaps 5 / 6.5 / 8 / 9 m. A fall lands in the pit; a 1.2 m
//               jump-step at the foot of every take-off face leads back up.
//     2 dash    turn east along the P4 runway: a 13 m gap to deck D — more
//               than a walk-speed double jump (≈ 12.3 m); dash-jump it.
//     3 boost   the tower BT rises 6.5 m above D: floor-boost off D.
//     4 chimney on BT, a 3 m-wide three-sided shaft climbs 6.1 m to the
//               15 m deck: wall-jump side to side (each wall-jump refunds
//               the air jump).
//     5 sky     west off the deck along C1 (15 m), floor-boost (rocket
//               jump) up 5 m across a 12 m gap onto the sky island C2, then
//               boost again 4.5 m up across 18 m onto the spine-head tower SH
//               (24.5 m; a backboard catches an overshoot). A jump + double
//               jump peaks at ~3.4 m: both climbs need the boost. A fall from
//               C1/C2 lands on the P4 runway: go again.
//     6 spine   drop 12.5 m south off SH onto the spine top and sprint it; the
//               5 m hurdle on it (teal = boost, like BT and SH) is a
//               boost-over at full speed.
//     7 finish  run off the spine's end (12 m drop) and sprint into the hub.

const HX = 60;
const HZ = 42;
const CAP = 34;

// ── the course ──────────────────────────────────────────────────────────────
const PIT_X0 = 19;
const PIT_X1 = 27;
const PT = 2.4; // pit platform top
const BT_TOP = 8.9; // boost tower top (6.5 m above deck D)
const DECK = 15; // chimney-top deck + catwalk
const C2_TOP = DECK + 5; // sky island (above a jump + double jump's reach)
const SH_TOP = C2_TOP + 4.5; // spine-head tower
const SPINE = 12; // spine top
const HURDLE = SPINE + 5; // the spine hurdle's top

// ── the gallery ─────────────────────────────────────────────────────────────
// Firing line centre (−34, 18.5); a target d metres down-range sits at z = 18.5 − d.
const FL: AABB = { min: { x: -42, y: 0, z: 17 }, max: { x: -26, y: 3, z: 20 } };
const FLZ = 18.5;
const FLX = -34;

const gate = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => B(x0, y0, z0, x1, y1, z1);

export const TRAINING: ArenaMap = (() => {
  const { boxes: base, bounds } = shell(HX, HZ, CAP);

  const gallery: MapBox[] = [
    // 18 m backstop across the gallery's far end; the north wall continues it
    // across the course (the catwalk hangs on it). Both stand inside the
    // perimeter so they render full height under the sky-brush perimeter.
    B(-59, 0, -41, -9, 18, -37, 'backstop'),
    B(-9, 0, -41, 59, 18, -40, 'northwall'),
    // berms at ~15 m, either side
    B(-58, 0, 2, -48, 1.2, 4, 'berm'),
    B(-20, 0, 2, -9, 1.2, 4, 'berm'),
    // cover block, left, ~24 m
    B(-53, 0, -7, -49, 2.8, -4, 'cover'),
    // SP1: 3 m strafe deck, right, ~28 m
    B(-22, 0, -11, -10, 3, -8, 'gdeck'),
    // T1: 6 m tower, left, ~31 m
    B(-58, 0, -15, -54, 6, -11, 'gtower'),
    // T2: 10 m tower + its 5 m shoulder, right, ~42 m
    B(-18, 0, -25, -14, 10, -21, 'gtower'),
    B(-14, 0, -25, -9, 5, -21, 'gdeck'),
    // SP2: 6 m strafe deck, left, ~45 m
    B(-51, 0, -28, -37, 6, -25, 'gdeck'),
    // T3: 12.5 m tower on the backstop, left, ~54 m
    B(-48, 0, -37, -42, 12.5, -33, 'gtower'),
    // T4: 7 m tower on the backstop, right, ~52 m
    B(-22, 0, -37, -16, 7, -32, 'gtower'),
    // bleachers behind the firing line (two jump-steps)
    B(-56, 0, 35, -22, 1.2, 38, 'bleacher'),
    B(-56, 0, 38, -22, 2.4, 41, 'bleacher'),
  ];

  const spine: MapBox[] = [
    // spine head (the sky run lands on it) + the 12 m spine with two
    // ground-level portals (z −22…−18 and −6…−2, 4.5 m tall)
    B(-9, 0, -40, -4, SPINE, -34, 'spine'),
    // …raised into the boost tower SH that ends the sky run, with a backboard
    // on its gallery edge to catch a boost that carries too far
    B(-9, SPINE, -40, -4, SH_TOP, -34, 'boost'),
    B(-9, SH_TOP, -40, -8.4, SH_TOP + 3, -34, 'chimney'),
    B(-9, 0, -34, -5, 4.5, -22, 'spine'),
    B(-9, 0, -18, -5, 4.5, -6, 'spine'),
    B(-9, 0, -2, -5, 4.5, 6, 'spine'),
    B(-9, 4.5, -34, -5, SPINE, 6, 'spine'),
    // the hurdle across the spine run: boost over it (teal = boost, as BT)
    B(-9, SPINE, -16, -5, HURDLE, -14, 'boost'),
    // recovery block on the course side: boost up (6 m), boost again to the top
    B(-5, 0, -15, -1, 6, -11, 'stand'),
  ];

  const course: MapBox[] = [
    // 1 — the pit. Jump-steps up from the hub, then platforms with growing gaps.
    ...steps('-z', 18, 22, PIT_X0, PIT_X1, 0, PT, { tag: 'step' }),
    B(PIT_X0, 0, 8, PIT_X1, PT, 18, 'pit'), // P0
    B(PIT_X0, 0, -2, PIT_X1, PT, 3, 'pit'), // P1   (gap 5)
    B(PIT_X0, 0, -12.5, PIT_X1, PT, -8.5, 'pit'), // P2 (gap 6.5)
    B(PIT_X0, 0, -24, PIT_X1, PT, -20.5, 'pit'), // P3 (gap 8)
    B(PIT_X0, 0, -40, 37, PT, -33, 'pit'), // P4 + the dash runway (gap 9)
    // recovery jump-steps at the foot of each take-off face
    B(21, 0, 6, 25, 1.2, 8, 'step'),
    B(21, 0, -4, 25, 1.2, -2, 'step'),
    B(21, 0, -14.5, 25, 1.2, -12.5, 'step'),
    B(21, 0, -26, 25, 1.2, -24, 'step'),
    B(37, 0, -39, 39, 1.2, -35, 'step'),
    // 2 — dash gap (13 m) to deck D
    B(50, 0, -40, 59, PT, -34, 'pit'),
    // 3 — the boost tower BT (6.5 m above D)
    B(48, 0, -34, 59, BT_TOP, -22, 'boost'),
    // 4 — the chimney on BT: two side walls + a back wall up to the deck
    B(48.5, BT_TOP, -33.5, 49.5, DECK, -29, 'chimney'),
    B(52.5, BT_TOP, -33.5, 53.5, DECK, -29, 'chimney'),
    B(48.5, BT_TOP, -34, 53.5, DECK, -33.5, 'chimney'),
    // 5 — the 15 m deck over D, the catwalk west along the north wall, then
    // the sky island (stood off the wall: no wall-jump shortcut) and SH
    slab(46, -40, 56, -34, DECK, 'catwalk'),
    slab(36, -40, 46, -37.5, DECK, 'catwalk'), // C1
    slab(14, -38.5, 24, -34, C2_TOP, 'catwalk'), // C2: gap 12, 5 m up; then gap 18, 4.5 m up to SH
    // infield target stands
    B(33, 0, 10, 36, 2.4, 13, 'stand'),
    B(40, 0, -14, 43, 3.6, -11, 'stand'),
  ];

  const boxes: MapBox[] = [...base, ...gallery, ...spine, ...course];

  const spawns: Vec3[] = [
    spawnAt(0, 38), // hub (the offline start)
    spawnAt(-12, 36),
    spawnAt(12, 36),
    spawnAt(-38, 28), // behind the firing line
    spawnAt(34, 28), // course side of the hub
    spawnAt(44, 2), // infield
    spawnAt(8, -18), // between the spine and the pit
    spawnAt(-50, 26), // gallery rear, west
    spawnAt(50, 20), // course side, south-east
    spawnAt(-30, 36.5, 1.2), // on the bleachers' first step
  ];

  return {
    name: 'Training Range',
    boxes,
    spawns,
    spawn: spawns[0],
    bounds,
    accent: 0xffb34a,
    openTop: true,
  };
})();

// ── gameplay layout (the challenge system's contract) ──────────────────────
const d = (metres: number) => FLZ - metres; // z of a line `metres` down-range

export const TRAINING_LAYOUT: TrainingLayout = {
  hub: {
    spawn: pt(0, 0.05, 38),
    yaw: 0,
    area: gate(-16, 0, 24, 16, 6, 41),
  },
  pads: {
    // signs face the spawn (0, 38): yaw = atan2(dx, dz) toward it
    flick: { center: pt(-9, 0, 29.5), size: [3, 3], signYaw: Math.atan2(9, 8.5) },
    strafers: { center: pt(-3, 0, 29.5), size: [3, 3], signYaw: Math.atan2(3, 8.5) },
    course: { center: pt(3, 0, 29.5), size: [3, 3], signYaw: Math.atan2(-3, 8.5) },
    gauntlet: { center: pt(9, 0, 29.5), size: [3, 3], signYaw: Math.atan2(-9, 8.5) },
  },
  gallery: {
    firingLine: FL,
    start: pt(FLX, 0.05, FLZ),
    startYaw: 0,
    anchors: [
      // near (8–20 m)
      pt(-37, 1.3, 10.5),
      pt(-29, 2.4, 8),
      pt(-47.2, 1.9, 3), // berm edge, left
      pt(-20.8, 2.0, 3), // berm edge, right
      pt(-34, 0.8, 0),
      pt(-26, 3.6, 11),
      // mid (20–35 m)
      pt(-51, 3.5, -5.5), // on the cover block
      pt(-48.2, 1.4, -5.5), // cover edge
      pt(-40, 9, -6), // high left
      pt(-16, 4.3, -9.5), // on SP1
      pt(-23, 1.3, -7), // SP1 edge
      pt(-56, 7.2, -13), // on T1
      pt(-53.2, 4.2, -12), // T1 edge
      pt(-34, 1.2, -14),
      // far (35–55 m)
      pt(-16, 11.2, -23), // on T2
      pt(-11.5, 6.2, -23), // on T2's shoulder
      pt(-18.8, 5, -23), // T2 edge
      pt(-44, 7.2, -26.5), // on SP2
      pt(-36.2, 1.4, -26.5), // SP2 edge
      pt(-34, 12, -20), // high centre
      pt(-45, 13.7, -35), // on T3
      pt(-19, 8.2, -34.5), // on T4
      pt(-28, 1.2, -30),
      pt(-30, 4.5, -36.2), // on the backstop face
    ],
    // feet on the floor / deck top (player-sized strafers stand on the lane)
    strafeLanes: [
      { a: pt(-40, 0, d(12)), b: pt(-30, 0, d(12)) },
      { a: pt(-48, 0, d(20)), b: pt(-36, 0, d(20)) },
      { a: pt(-21, 3, d(28)), b: pt(-11, 3, d(28)) }, // on SP1 (3 m)
      { a: pt(-51, 0, d(36)), b: pt(-39, 0, d(36)) },
      { a: pt(-50, 6, d(45)), b: pt(-38, 6, d(45)) }, // on SP2 (6 m)
      { a: pt(-35, 0, d(52)), b: pt(-23, 0, d(52)) },
    ],
    markers: [10, 20, 30, 40, 50].map((m) => ({ at: pt(FLX, 0, d(m)), metres: m })),
  },
  course: {
    start: pt(23, 0.05, 30),
    startYaw: 0,
    gates: [
      gate(PIT_X0, PT, 10, PIT_X1, PT + 3, 13), // G0 onto the pit (P0)
      gate(PIT_X0, PT, -40, PIT_X1 + 2, PT + 3, -33), // G1 across the pit (P4)
      gate(50, PT, -40, 59, PT + 3, -34), // G2 across the dash gap (D)
      gate(47.5, BT_TOP, -34, 59, BT_TOP + 3, -22), // G3 boosted onto BT
      gate(46, DECK, -40, 56, DECK + 3, -34), // G4 up the chimney (deck)
      gate(14, C2_TOP, -38.5, 24, C2_TOP + 3, -34), // G5 boosted onto the sky island (C2)
      gate(-9, SH_TOP, -40, -4, SH_TOP + 3, -34), // G6 boosted onto the spine-head tower
      gate(-11, SPINE, 0, -3, SPINE + 3, 5), // G7 the spine's end, past the hurdle
      gate(-7, 0, 21, 7, 4, 23), // G8 finish, in front of the hub
    ],
    targets: [
      pt(33, 4, 17), // start run
      pt(10, 4, -4), // pit, left
      pt(36, 5, -16), // pit, right
      pt(0, 8, -26), // pit, by the spine
      pt(43, 7, -29), // over the dash gap
      pt(40, 14, -22), // boost
      pt(44, 20, -18), // chimney top
      pt(30, 9, -30), // catwalk
      pt(19, 27, -30), // over the sky island, at the top of the boost
      pt(-22, 15, -14), // spine run, over the gallery
      pt(8, 10, -6), // spine run, over the course
      pt(12, 3, 14), // finish sprint
      pt(-16, 5, 12), // finish sprint
    ],
    // ≈258 m at run speed is ~26 s before the climbs; four boosts and the
    // chimney make 34 s a clean, fast run.
    par: 34,
  },
};
