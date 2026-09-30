import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, steps, sym, symPoints, type MapBox } from './kit';

// "Causeway" — a Longest-Yard / Morpheus flavoured complex floating in deep
// space. Quad-symmetric (mirrored across both axes), 96 × 72 m.
//
// Tiers: pit deck 0 · dais / crates 2.4 · the ring 6 · keeps + hub 10.5 ·
// pylon tops 14 · apex 17.5 (the Crown, over the central spire).
//
// Figure-8: the 6 m ring (four corner islands, the N/S gates and their
// causeways, the stairs up to the E/W keeps) is split by the central hub —
// N/S spokes climb from the gates to the hub, the E/W spine bridges run from
// the keeps toward it and end at a strafe gap. Two lobes (east / west), one
// crossing in the middle. The pit underneath is a real floor: pods under the
// islands, a tunnel through each keep, monoliths and crates break it up.
//
// Routes to the Crown: boost off the hub deck (6.5 m) or from a pylon top
// (14 m, reached by boosting off the spine bridge or the pylon faces).
const HX = 48;
const HZ = 36;
const CAP = 28; // Crown 17.5 + 10.5 m headroom

// Ring / tier heights.
const RING = 6;
const HIGH = 10.5;
const DAIS = 2.4;
const CROWN = 17.5;

export const CAUSEWAY: ArenaMap = (() => {
  const { boxes: base, bounds } = shell(HX, HZ, CAP);

  // ── one quadrant (x > 0, z > 0), mirrored four ways ─────────────────────
  const quad: MapBox[] = [
    // Corner island, top 6 (a 1 m thick deck floating over its pod).
    slab(20, 18, 38, 30, RING, 'island', 1),
    // Pod hull under it: back wall with a door to the rim alley, outer side wall.
    B(20, 0, 29, 27, RING - 1, 30, 'hull'),
    B(31, 0, 29, 38, RING - 1, 30, 'hull'),
    B(37, 0, 22, 38, RING - 1, 29, 'hull'),
    // Jump-steps pit → island (south edge of the island, rising toward +z).
    ...steps('+z', 12, 18, 30, 34, 0, RING, { tag: 'steps' }),
    // Causeway bridge island ↔ gate.
    slab(5, 22, 20, 26, RING, 'causeway', 0.6),
    // Island → keep: landing at 6, then jump-steps up to 10.5.
    slab(35, 14, 40, 18, RING, 'causeway', 0.6),
    ...steps('-z', 7, 14, 35, 40, RING, HIGH, { tag: 'steps' }),
    // Pylons beside the spine gap: boost walls, tops at 14.
    C(12.5, 4.75, 2.5, 2.5, 0, 14, 'pylon'),
    // Lobe monolith: breaks the pit and the ring sightlines.
    C(24, 10, 2, 3, 0, 12, 'monolith'),
    // Crates (low tier) in the lobe pit.
    B(15, 0, 13.5, 19, DAIS, 16.5, 'crate'),
    B(27, 0, 4, 31, 1.2, 7, 'crate'),
    // Island cover: a waist-high amber block mid-deck (breaks the ring lanes).
    B(26, RING, 23, 29.5, RING + 1.4, 24.5, 'crate'),
  ];

  // ── on the x axis (mirrored across x = 0): the E / W keeps + spine ───────
  const xAxis: MapBox[] = [
    // Keep, top 10.5, with a tunnel through it at floor level (x-direction).
    B(34, 0, -7, 44, HIGH, -3, 'keep'),
    B(34, 0, 3, 44, HIGH, 7, 'keep'),
    B(34, 4.5, -3, 44, HIGH, 3, 'keep'),
    // Spine bridge keep → hub, ends at an 8 m strafe gap.
    slab(16, -1.5, 34, 1.5, HIGH, 'spine', 0.6),
    // Dais steps (low ledge onto the central dais).
    B(5, 0, -2, 7, 1.2, 2, 'crate'),
  ];

  // ── on the z axis (mirrored across z = 0): the N / S gates + spokes ──────
  const zAxis: MapBox[] = [
    // Gate, top 6: two legs and a lintel deck over a 4 m archway.
    B(-5, 0, 20, -2, RING, 28, 'gate'),
    B(2, 0, 20, 5, RING, 28, 'gate'),
    B(-2, 3.6, 20, 2, RING, 28, 'gate'),
    // Jump-steps from the rim alley up the gate's back, either side of the arch.
    ...steps('-z', 28, 33, -5, -2, 0, RING, { tag: 'steps' }),
    ...steps('-z', 28, 33, 2, 5, 0, RING, { tag: 'steps' }),
    // Spoke: bridge from the gate, then jump-steps up to the hub deck.
    slab(-2, 12, 2, 20, RING, 'spoke', 0.6),
    ...steps('-z', 6, 12, -2, 2, RING, HIGH, { tag: 'steps' }),
  ];

  // ── the centre: dais, hub deck, spire, Crown ──────────────────────────────
  const centre: MapBox[] = [
    B(-5, 0, -4, 5, DAIS, 4, 'dais'),
    B(-2, DAIS, -2, 2, HIGH - 1, 2, 'spire'),
    slab(-8, -6, 8, 6, HIGH, 'hub', 1),
    B(-2, HIGH, -2, 2, CROWN - 0.7, 2, 'spire'),
    slab(-4.5, -4.5, 4.5, 4.5, CROWN, 'crown', 0.7),
  ];

  const boxes: MapBox[] = [
    ...base,
    ...centre,
    ...sym(quad, 'quad'),
    ...sym(xAxis, 'x'),
    ...sym(zAxis, 'z'),
  ];

  const spawns = symPoints(
    [
      spawnAt(32, 21), // pod (under the island)
      spawnAt(22, 28, RING), // island top
      spawnAt(18, 8), // lobe pit
      spawnAt(45, 13), // rim alley
    ],
    'quad',
  );

  return {
    name: 'Causeway',
    boxes,
    spawns,
    spawn: spawnAt(32, 21),
    bounds,
    accent: 0x5ce1ff,
    // Void theme: deep space overhead. The cap (boxes[1]) still collides;
    // it just isn't drawn, and rail impacts on it are suppressed (weapon.ts).
    openTop: true,
  };
})();
