import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, steps, sym, symPoints, type MapBox } from './kit';

// "Nuketown" — a cul-de-sac at golden hour, 96 × 72 m, open sky (cap 28 m).
// A LAYOUT homage to CoD's Nuketown, built from boxes (flat roofs only).
//
//   z −36 ┌───────────────────── DEAD END (cul-de-sac) ─────────────────────┐
//         │ RV   fence│ pump 5.5   WATER TOWER catwalk 11 / tank 16  pump  │
//         │  corner   │ crates      legs + riser pipe       truck 3.6       │
//         │───fence───┤ GARAGE (roof 4.5) ··· driveway ··· GARAGE          │
//         │ BACKYARD  │ HOUSE: ground rooms │  STREET  │ HOUSE (mirror)     │
//         │ shed 3    │ upper floor 4.5     │  cars    │                    │
//         │ boat 2.2  │ balcony 4.5, roof 9 │          │                    │
//         │───fence───┴─────────────────────┤  bus 3.5 │                    │
//         │ SOUTH GARDEN  treehouse 6, shed 3│ crates   │                    │
//   z +36 └──────────────── BILLBOARD catwalk 6 (road mouth) ───────────────┘
//
// Architecture mirrors across x = 0 (green house west, yellow house east);
// the street vehicles are point-symmetric (bus SW ↔ truck NE, crates SE ↔
// NW, car ↔ car). Tiers: 0 street/yards/rooms · 1.5–3.6 vehicles, sheds ·
// 4.5–6 upper floors, balconies, garage roofs, pump houses, treehouse,
// billboard · 9 roof decks · 11 tower catwalk · 16 tank top (apex).
// Lanes: the street (~60 m, tower ↔ billboard, broken by cars/bus/truck),
// the front-door cross-fire (house ↔ house), balcony ↔ balcony, roof ↔ roof,
// and the dead-end cross lane (RV ↔ RV) under the tower.
const HX = 48;
const HZ = 36;
const CAP = 28;
const T = 0.4; // wall thickness (thin → its top isn't a standing surface)

// An opening in a wall: [from, to] along the wall, [sill, head] in y.
type Hole = [number, number, number, number];

// Wall running along z (x span fixed), cut by openings.
function wallZ(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, holes: Hole[], tag: string): MapBox[] {
  const out: MapBox[] = [];
  let at = z0;
  for (const [a, b, sill, head] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (a > at) out.push(B(x0, y0, at, x1, y1, a, tag));
    if (sill > y0) out.push(B(x0, y0, a, x1, sill, b, tag));
    if (head < y1) out.push(B(x0, head, a, x1, y1, b, tag));
    at = b;
  }
  if (z1 > at) out.push(B(x0, y0, at, x1, y1, z1, tag));
  return out;
}

// Wall running along x (z span fixed), cut by openings.
function wallX(z0: number, z1: number, x0: number, x1: number, y0: number, y1: number, holes: Hole[], tag: string): MapBox[] {
  const out: MapBox[] = [];
  let at = x0;
  for (const [a, b, sill, head] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (a > at) out.push(B(at, y0, z0, a, y1, z1, tag));
    if (sill > y0) out.push(B(a, y0, z0, b, sill, z1, tag));
    if (head < y1) out.push(B(a, head, z0, b, y1, z1, tag));
    at = b;
  }
  if (x1 > at) out.push(B(at, y0, z0, x1, y1, z1, tag));
  return out;
}

// A sedan along z: body (1.0), narrower cabin (1.6), wheel blocks proud of
// the body sides (0.1 m, thin → not a standing surface). `front` = the
// windscreen end (±1 along z).
function car(x: number, z: number, tag: string, front = -1): MapBox[] {
  const W = 2.1;
  const L = 4.6;
  const out: MapBox[] = [
    C(x, z, W, L, 0, 1.0, tag),
    C(x, z - front * 0.35, W - 0.3, 2.3, 1.0, 1.65, tag),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const zc = z + sz * (L / 2 - 0.85);
      out.push(B(x + sx * (W / 2 - 0.3), 0, zc - 0.4, x + sx * (W / 2 + 0.1), 0.7, zc + 0.4, 'wheel'));
    }
  }
  return out;
}

// Wheel pairs proud of both sides of a vehicle (x span x0…x1) at axle z.
function wheels(x0: number, x1: number, axles: number[], r = 0.55): MapBox[] {
  return axles.flatMap((z) => [
    B(x0 - 0.1, 0, z - r, x0 + 0.3, r * 1.8, z + r, 'wheel'),
    B(x1 - 0.3, 0, z - r, x1 + 0.1, r * 1.8, z + r, 'wheel'),
  ]);
}

// ── west house (the east one is its mirror) ─────────────────────────────
const F = -17; // ground-floor front face (street side)
const UF = -20.5; // upper-storey front face (balcony in front of it)
const BK = -33; // back face
const ZN = -12; // north face
const ZS = 10; // south face
const H1 = 4; // ground walls top = upper slab underside
const L2 = 4.5; // upper floor
const H2 = 8.5; // upper walls top = roof slab underside
const RF = 9; // roof deck
const DOOR = 3.2;

function house(): MapBox[] {
  const w = 'house';
  const out: MapBox[] = [];
  // ground floor
  out.push(...wallZ(F - T, F, ZN, ZS, 0, H1, [[-10, -4.5, 1, 3.1], [-1.5, 1.5, 0, DOOR], [3.5, 8.5, 1, 3.1]], w)); // front
  out.push(...wallZ(BK, BK + T, ZN, ZS, 0, H1, [[-8, -4, 1, 3], [2, 5, 0, DOOR]], w)); // back
  out.push(...wallX(ZN, ZN + T, BK, F, 0, H1, [[-30, -27, 1, 3], [-24, -21.5, 0, DOOR]], w)); // north (garage side)
  out.push(...wallX(ZS - T, ZS, BK, F, 0, H1, [[-31.5, -28.5, 1.2, 3], [-23, -20.5, 0, DOOR]], w)); // south
  out.push(...wallZ(-25.2, -24.8, ZN + T, ZS - T, 0, H1, [[-10.5, -7.5, 0, DOOR], [-1.5, 2.5, 0, DOOR]], 'partition'));
  // stairs to the upper floor along the south wall (rising toward +x)
  out.push(...steps('+x', -32.6, -26.6, 7.4, ZS - T, 0, L2, { tag: 'stair' }));
  // upper floor slab (stairwell hole over x −32.6…−28.1, z 7.4…9.6)
  out.push(B(BK, H1, ZN, F, L2, 7.4, 'floor2'));
  out.push(B(-28.1, H1, 7.4, F, L2, ZS, 'floor2'));
  out.push(B(BK, H1, 7.4, BK + T, L2, ZS, 'floor2'));
  out.push(B(BK + T, H1, ZS - T, -28.1, L2, ZS, 'floor2'));
  // upper storey (set back → balcony x UF…F at 4.5)
  out.push(...wallZ(UF - T, UF, ZN, ZS, L2, H2, [[-10, -4, 5.4, 7.8], [-1.5, 1.5, L2, L2 + DOOR], [3, 9, 5.4, 7.8]], w));
  out.push(...wallZ(BK, BK + T, ZN, ZS, L2, H2, [[-8, -4, 5.5, 7.5], [-1, 3, 5.5, 7.5]], w));
  out.push(...wallX(ZN, ZN + T, BK, UF, L2, H2, [[-27, -24, L2, L2 + DOOR]], w)); // door onto the garage roof
  out.push(...wallX(ZS - T, ZS, BK, UF, L2, H2, [[-25, -22, 5.5, 7.5]], w));
  // roof stairs along the north wall (rising toward −x); hatch over them
  out.push(...steps('-x', -32.6, -27, ZN + T, -9.4, L2, RF, { tag: 'stair' }));
  // roof deck slab (hatch x −31.2…−27, z −11.6…−9.4)
  out.push(B(BK, H2, -9.4, UF, RF, ZS, 'roof'));
  out.push(B(-27, H2, ZN, UF, RF, -9.4, 'roof'));
  out.push(B(BK, H2, ZN, -31.2, RF, ZN + T, 'roof'));
  out.push(B(-31.2, H2, ZN, -27, RF, ZN + T, 'roof'));
  // chimney on the roof deck (cover up top)
  out.push(C(-24, 6, 1.6, 2.4, RF, RF + 2.2, 'chimney'));
  return out;
}

// Garage north of the house: open door to the driveway, roof flush with the
// upper floor (4.5) so it's a terrace off the upper-storey door.
function garage(): MapBox[] {
  const g = 'garage';
  const x0 = -31;
  const x1 = -19;
  const z0 = -21;
  return [
    ...wallZ(x0, x0 + T, z0, ZN, 0, H1, [[-18, -15.5, 0, DOOR]], g), // back → backyard gate
    ...wallX(z0, z0 + T, x0, x1, 0, H1, [[-27, -24.5, 0, DOOR]], g), // north → dead end
    B(x1 - T, 0, z0, x1, H1, z0 + 0.8, g), // door jambs
    B(x1 - T, 3.4, z0 + 0.8, x1, H1, ZN, g), // header over the garage door
    B(x0, H1, z0, x1, L2, ZN, 'roof2'),
  ];
}

function yards(): MapBox[] {
  const f = 'fence';
  const FH = 3.2;
  return [
    // backyard fences (≥ 3 m, sight breakers) with gates
    B(-47, 0, -21.15, -39, FH, -20.85, f),
    B(-47, 0, 11.85, -40, FH, 12.15, f),
    B(-36, 0, 11.85, BK, FH, 12.15, f),
    // south garden fence along the street, wide gate z 18…27
    B(-12.15, 0, 14, -11.85, FH, 18, f),
    B(-12.15, 0, 27, -11.85, FH, 35, f),
    // backyard: playhouse shed, picnic table, boat on a trailer
    C(-43, -5, 4, 6, 0, 3, 'shed'),
    C(-38, -15, 2, 3, 0, 1.1, 'table'),
    C(-41, 5.5, 3, 6.5, 0, 2.2, 'boat'),
    // dead-end corner: camper
    C(-42, -29, 4, 8, 0, 3, 'rv'),
    // south garden: treehouse (trunk + deck), garden shed as the step up
    C(-29, 23, 1.6, 1.6, 0, 5.5, 'trunk'),
    slab(-32, 20, -26, 26, 6, 'treehouse'),
    B(-32, 6, 23.5, -29.5, 8.6, 26, 'hut'),
    C(-22.5, 21, 3.5, 4, 0, 3, 'shed'),
    // front lawn hedge + driveway car
    C(-12, 5, 1.2, 7, 0, 1.1, 'hedge'),
    ...car(-14.5, -17.5, 'carR', 1),
    // pump house beside the water tower (boost launch to the catwalk)
    B(-12.5, 0, -35, -8, 5.5, -28.5, 'pump'),
  ];
}

// Water tower on the dead-end axis: legs + riser, catwalk 11, tank top 16.
function tower(): MapBox[] {
  const cz = -29.5;
  const out: MapBox[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(C(sx * 3.5, cz + sz * 3.5, 1, 1, 0, 10.5, 'leg'));
  out.push(C(0, cz, 1.6, 1.6, 0, 10.5, 'leg'));
  out.push(slab(-5, cz - 4.5, 5, cz + 4.5, 11, 'catwalk'));
  out.push(C(0, cz, 7, 7, 11, 16, 'tank'));
  return out;
}

// Billboard across the road mouth: catwalk 6 on two posts, the sign above.
function billboard(): MapBox[] {
  return [
    C(-7, 31.5, 1, 1, 0, 5.5, 'post'),
    C(7, 31.5, 1, 1, 0, 5.5, 'post'),
    slab(-9, 29.5, 9, 32, 6, 'catwalk'),
    B(-10, 6, 32, 10, 12, 32.4, 'sign'),
  ];
}

// Street vehicles, point-symmetric about the origin.
function street(): MapBox[] {
  const one: MapBox[] = [
    C(-6.4, 19.7, 3.2, 11.4, 0, 3.5, 'bus'),
    C(-6.4, 13.4, 2.8, 1.2, 0, 1.8, 'bus'), // hood
    ...wheels(-8, -4.8, [15.8, 23.4]),
    ...car(-0.5, -5, 'carB', -1),
    C(8.5, 23.5, 3, 3, 0, 1.5, 'crate'),
    C(6.5, 27.2, 3, 2.8, 0, 3, 'crate'),
  ];
  const other: MapBox[] = [
    // moving truck (the bus's twin): cargo box + cab
    B(4.8, 0, -25.4, 8, 3.6, -17.4, 'truck'),
    B(4.9, 0, -17.4, 7.9, 2.4, -14, 'truckcab'),
    ...wheels(4.8, 8, [-24, -19.2, -15.6]),
    ...car(0.5, 5, 'carT', 1),
    C(-8.5, -23.5, 3, 3, 0, 1.5, 'crate'),
    C(-6.5, -27.2, 3, 2.8, 0, 3, 'crate'),
  ];
  return [...one, ...other];
}

export const NUKETOWN: ArenaMap = (() => {
  const { boxes, bounds } = shell(HX, HZ, CAP);
  boxes.push(...sym([...house(), ...garage(), ...yards()], 'x'));
  boxes.push(...tower(), ...billboard(), ...street());

  const S = spawnAt;
  const spawns = symPoints([
    S(-42, -15), // backyard north
    S(-37, 1), // backyard by the back door
    S(-29, -6), // kitchen
    S(-26, 3, L2), // upper floor
    S(-25, -16.5), // garage
    S(-27.6, 21.6, 6), // treehouse deck
    S(-40, 28), // south garden
    S(-36, -29), // dead-end corner
  ], 'x');
  return {
    name: 'Nuketown',
    boxes,
    spawns,
    spawn: spawns[0],
    bounds,
    accent: 0xffd85c,
    openTop: true,
  };
})();
