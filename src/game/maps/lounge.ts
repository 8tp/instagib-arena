import type { ArenaMap } from '../arena-map-data';
import { B, C, shell, slab, spawnAt, steps, type MapBox } from './kit';

// "Lounge" — the Ratz Instagib homage: you are a rat in a bright open-plan
// living room + kitchen at 10× scale (1 real cm ≈ 10 cm here), 96 × 72 m,
// ceiling at 30 m. Furniture is terrain; every piece is a step to the next.
//
// Zones: KITCHEN along the north wall (counters 9, open shelves 15, the tall
// fridge in the middle = the apex 19.5, pantry tower 16 in the NE corner),
// the ISLAND (9) with bar stools (6.2), DINING east of centre (table 7.5,
// chairs 4.5 with 9.5 backs), LIVING in the south-west (sofa seat 4.5 / back
// cushions 7 / back 9, coffee table 4, armchair, TV console 5), the staggered
// BOOKCASE on the west wall (shelves 4 / 8 / 12 / 16, climbed by book piles),
// the STAIRS along the south wall up to the east GALLERY (mezzanine, 12).
//
// Apex (fridge top, 19.5): boost from either kitchen shelf (15), which are
// fed by the pantry (16, boost from the gallery), the bookcase top tier (16)
// and the counters (9, boost). Lanes: the W corridor (bookcase ↔ sofa), the
// kitchen aisle, the centre lane between island and sofa (toy blocks), the
// covered walk under the gallery.
const HX = 48;
const HZ = 36;
const CAP = 30; // apex 19.5 + 10.5 m headroom

const COUNTER = 9;
const SHELF = 15;
const FRIDGE = 19.5;
const PANTRY = 16;
const GALLERY = 12;
const TABLE = 7.5;
const SEAT = 4.5;

// A dining chair pulled out from the table. `side` is where the chair sits
// relative to the table; the back panel is on the far side.
function chair(cx: number, cz: number, side: 'n' | 's' | 'e' | 'w'): MapBox[] {
  const s = 4.5;
  const h = s / 2;
  const t = 0.7; // back thickness
  const leg = 0.6;
  const out: MapBox[] = [];
  const x0 = cx - h;
  const x1 = cx + h;
  const z0 = cz - h;
  const z1 = cz + h;
  out.push(B(x0, SEAT - 0.6, z0, x1, SEAT, z1, 'chair'));
  if (side === 'n') {
    out.push(B(x0, 0, z0 - t, x1, 9.5, z0, 'chair-back'));
    out.push(B(x0, 0, z1 - leg, x0 + leg, SEAT - 0.6, z1, 'chair-leg'), B(x1 - leg, 0, z1 - leg, x1, SEAT - 0.6, z1, 'chair-leg'));
  } else if (side === 's') {
    out.push(B(x0, 0, z1, x1, 9.5, z1 + t, 'chair-back'));
    out.push(B(x0, 0, z0, x0 + leg, SEAT - 0.6, z0 + leg, 'chair-leg'), B(x1 - leg, 0, z0, x1, SEAT - 0.6, z0 + leg, 'chair-leg'));
  } else if (side === 'e') {
    out.push(B(x1, 0, z0, x1 + t, 9.5, z1, 'chair-back'));
    out.push(B(x0, 0, z0, x0 + leg, SEAT - 0.6, z0 + leg, 'chair-leg'), B(x0, 0, z1 - leg, x0 + leg, SEAT - 0.6, z1, 'chair-leg'));
  } else {
    out.push(B(x0 - t, 0, z0, x0, 9.5, z1, 'chair-back'));
    out.push(B(x1 - leg, 0, z0, x1, SEAT - 0.6, z0 + leg, 'chair-leg'), B(x1 - leg, 0, z1 - leg, x1, SEAT - 0.6, z1, 'chair-leg'));
  }
  return out;
}

// Bar stool: square seat on a single post.
function stool(cx: number, cz: number): MapBox[] {
  return [C(cx, cz, 3.2, 3.2, 5.6, 6.2, 'stool'), C(cx, cz, 0.8, 0.8, 0, 5.6, 'stool-leg')];
}

export const LOUNGE: ArenaMap = (() => {
  const { boxes, bounds } = shell(HX, HZ, CAP);

  // ── KITCHEN (north wall) ────────────────────────────────────────────────
  // Base cabinets: recessed plinth, cabinet body, worktop with a lip.
  const counter = (x0: number, x1: number) => [
    B(x0, 0, -35, x1, 1, -29.8, 'plinth'),
    B(x0, 1, -35, x1, COUNTER - 0.6, -29, 'cabinet'),
    B(x0, COUNTER - 0.6, -35, x1, COUNTER, -28.6, 'worktop'),
  ];
  boxes.push(...counter(-47, -5), ...counter(5, 35));
  // The fridge (apex) and the pantry tower in the NE corner.
  boxes.push(B(-5, 0, -35, 5, FRIDGE, -27, 'fridge'));
  // French-door handles + the freezer-drawer pull.
  boxes.push(B(-1.1, 8, -27, -0.5, 15, -26.5, 'handle'), B(0.5, 8, -27, 1.1, 15, -26.5, 'handle'));
  boxes.push(B(-3, 6.1, -27, 3, 6.6, -26.5, 'handle'));
  boxes.push(B(35, 0, -35, 47, PANTRY, -28, 'pantry'));
  // Open oak shelves over the counters.
  boxes.push(slab(-40, -35, -8, -31.5, SHELF, 'shelf', 0.8));
  boxes.push(slab(8, -35, 32, -31.5, SHELF, 'shelf', 0.8));
  // Kitchen helpers: pedal bin (6) + step stool (3) → counter.
  boxes.push(C(-37, -26.7, 3.6, 3.6, 0, 6, 'bin'));
  boxes.push(C(-37, -21.6, 4, 3.4, 0, 3, 'stepstool'));
  // Island: plinth, body, worktop with a breakfast-bar overhang to the south.
  boxes.push(B(-12, 0, -20.5, 12, 1, -13.8, 'plinth'));
  boxes.push(B(-12, 1, -20.8, 12, COUNTER - 0.6, -13, 'cabinet'));
  boxes.push(B(-12.4, COUNTER - 0.6, -21.2, 12.4, COUNTER, -11, 'worktop'));
  boxes.push(...stool(-7, -8.2), ...stool(0, -8.2), ...stool(7, -8.2));

  // ── DINING (east of centre) ─────────────────────────────────────────────
  const tx0 = 12;
  const tx1 = 30;
  boxes.push(B(tx0, TABLE - 0.6, -6, tx1, TABLE, 6, 'table'));
  for (const [lx, lz] of [[tx0 + 0.8, -5.2], [tx1 - 0.8, -5.2], [tx0 + 0.8, 5.2], [tx1 - 0.8, 5.2]]) {
    boxes.push(C(lx, lz, 1.2, 1.2, 0, TABLE - 0.6, 'table-leg'));
  }
  boxes.push(...chair(16.5, -8.25, 'n'), ...chair(25.5, -8.25, 'n'));
  boxes.push(...chair(16.5, 8.25, 's'), ...chair(25.5, 8.25, 's'));
  boxes.push(...chair(32.25, 0, 'e'), ...chair(9.75, 0, 'w'));

  // ── GALLERY + STAIRS (east / south walls) ───────────────────────────────
  boxes.push(...steps('+x', 14, 38, 27, 35, 0, GALLERY, { maxRise: 1.5, tag: 'stair' }));
  boxes.push(B(38, 0, 20, 47, GALLERY, 35, 'stair-core'));
  boxes.push(slab(39, -28, 47, 20, GALLERY, 'gallery', 0.6));
  for (const z of [-17, -4, 9]) boxes.push(C(39.6, z, 1.2, 1.2, 0, GALLERY - 0.6, 'post'));
  // Low balustrade with gaps (cover up there, hop-over anywhere).
  boxes.push(B(39, GALLERY, -24, 39.4, GALLERY + 1.1, -12, 'rail'));
  boxes.push(B(39, GALLERY, -2, 39.4, GALLERY + 1.1, 12, 'rail'));

  // ── LIVING (south-west) ─────────────────────────────────────────────────
  boxes.push(B(-37, 0, 5, -11, COUNTER, 8, 'sofa-back'));
  boxes.push(B(-37, 0, 8, -11, SEAT, 16, 'sofa'));
  boxes.push(B(-40, 0, 5, -37, 6.5, 16, 'sofa-arm'), B(-11, 0, 5, -8, 6.5, 16, 'sofa-arm'));
  boxes.push(B(-37, SEAT, 8, -24.2, 7, 10.5, 'cushion'), B(-23.8, SEAT, 8, -11, 7, 10.5, 'cushion'));
  boxes.push(B(-36.5, SEAT, 11, -33.5, 6.4, 13.6, 'pillow'), B(-14.5, SEAT, 11, -11.5, 6.4, 13.6, 'pillow'));
  // Coffee table on two panel legs (you can run under it).
  boxes.push(B(-31, 3.4, 20, -17, 4, 26, 'coffee'));
  boxes.push(B(-31, 0, 20, -30.2, 3.4, 26, 'coffee-leg'), B(-17.8, 0, 20, -17, 3.4, 26, 'coffee-leg'));
  // TV console + wall TV.
  boxes.push(B(-35, 0, 30.5, -13, 5, 35, 'console'));
  boxes.push(B(-30, 9, 34.4, -18, 16, 35, 'tv'));
  // Pouffe and the armchair (faces west, back on the east side).
  boxes.push(C(-8, 29, 4.5, 4.5, 0, 3, 'pouffe'));
  boxes.push(B(-2, 0, 17.5, 4.5, SEAT, 22.5, 'armchair'));
  boxes.push(B(4.5, 0, 15.5, 7, 8.5, 24.5, 'armchair-back'));
  boxes.push(B(-2, 0, 15.5, 4.5, 6.5, 17.5, 'armchair-arm'), B(-2, 0, 22.5, 4.5, 6.5, 24.5, 'armchair-arm'));
  // Toy blocks in the middle of the room (low tier, break the centre lane).
  boxes.push(C(-3, 0, 3, 3, 0, 3, 'block-a'), C(0.4, 0.8, 3, 3, 0, 3, 'block-b'), C(-1.3, 0.4, 3, 3, 3, 6, 'block-c'));
  // Snake plants: tall leaf blades in terracotta pots (sight breakers).
  const plant = (cx: number, cz: number) => {
    boxes.push(C(cx, cz, 5, 5, 0, 4.5, 'pot'));
    boxes.push(C(cx - 1, cz - 0.6, 2.2, 0.7, 4.5, 14, 'leaf'), C(cx + 0.9, cz + 0.4, 0.7, 2.4, 4.5, 11.5, 'leaf'));
    boxes.push(C(cx + 0.2, cz - 1.2, 2.0, 0.7, 4.5, 9.5, 'leaf'), C(cx - 0.9, cz + 1.3, 1.8, 0.7, 4.5, 12.5, 'leaf'));
  };
  plant(31, -21);
  plant(7, 30.5);
  // Laundry basket behind the sofa (cover in the open west floor).
  boxes.push(C(-26, -5, 5.5, 4.5, 0, 4.5, 'basket'));
  // A delivery box by the stairs.
  boxes.push(C(22, 19, 7, 6, 0, 4.5, 'carton'));

  // ── BOOKCASE (west wall): staggered columns ─────────────────────────────
  // Column k spans Z0 + k·W; even columns have shelves at 4 / 12, odd at
  // 8 / 16, so each column's shelf sits 4 m above its neighbour's — a
  // zig-zag you climb with lying book piles (+2.5 then a 1.5 hop) or skip
  // with boosts. A coloured back panel makes it read as one piece.
  const X0 = -46.6;
  const X1 = -43;
  const Z0 = -26;
  const W = 6.5;
  const N = 8;
  const ZN = Z0 + N * W;
  const colZ = (k: number): [number, number] => [Z0 + k * W, Z0 + (k + 1) * W];
  boxes.push(B(-47, 0, Z0, X0, 20, ZN, 'case-back'));
  boxes.push(B(-47, 0, Z0 - 0.6, X1, 20, Z0, 'case-side'), B(-47, 0, ZN, X1, 20, ZN + 0.6, 'case-side'));
  // Closed cupboards above, built into the wall up to the ceiling.
  boxes.push(B(-HX, 20, Z0 - 0.6, X1, CAP, ZN + 0.6, 'case-top'));
  for (let k = 0; k < N; k++) {
    const [z0, z1] = colZ(k);
    const tops = k % 2 === 0 ? [4, 12] : [8, 16];
    for (const t of tops) boxes.push(slab(X0, z0, X1, z1, t, 'case-shelf', 0.6));
    // Low dividers under the 4 m shelves (the case's feet).
    if (k > 0) boxes.push(B(X0, 0, z0 - 0.3, X1, 3.4, z0 + 0.3, 'case-side'));
  }
  // Two books lying flat (2.5 m) at one end of a column's shelf.
  const lying = (x0: number, x1: number, za: number, zb: number, base: number, a: string, b: string) => {
    boxes.push(B(x0, base, za, x1, base + 1.3, zb, a));
    boxes.push(B(x0 + 0.25, base + 1.3, za + 0.3, x1 - 0.2, base + 2.5, zb - 0.3, b));
  };
  const pile = (k: number, dir: -1 | 1, base: number, a: string, b: string) => {
    const [z0, z1] = colZ(k);
    const za = dir > 0 ? z1 - 2.8 : z0 + 0.3;
    const zb = dir > 0 ? z1 - 0.3 : z0 + 2.8;
    lying(X0 + 0.2, X1 - 0.3, za, zb, base, a, b);
  };
  // Upright spines standing against the back panel (decor + cover).
  const SPINES: Array<[number, number]> = [[1.1, 2.9], [0.8, 2.4], [1.3, 3.2], [0.9, 2.6]];
  const row = (k: number, base: number, from: number, n: number, seed: number) => {
    let z = colZ(k)[0] + from;
    for (let i = 0; i < n; i++) {
      const [w, h] = SPINES[(i + seed) % SPINES.length];
      boxes.push(B(X0, base, z, X0 + 2.4, base + h, z + w, `book-${'abcd'[(i + seed) % 4]}`));
      z += w + 0.05;
    }
  };
  // North climb (+z): floor pile → A0 4 → B1 8 → A2 12 → B3 16.
  lying(-43, -40.4, -25, -22, 0, 'book-b', 'book-d');
  pile(0, 1, 4, 'book-a', 'book-c');
  pile(1, 1, 8, 'book-d', 'book-b');
  pile(2, 1, 12, 'book-c', 'book-a');
  // South climb (−z): floor pile → A6 4 → B5 8 → A4 12 → B3 16.
  lying(-43, -40.4, 15.8, 18.8, 0, 'book-c', 'book-a');
  pile(6, -1, 4, 'book-b', 'book-d');
  pile(5, -1, 8, 'book-a', 'book-c');
  pile(4, -1, 12, 'book-d', 'book-b');
  // Spines where they don't sit on a climbing line.
  row(0, 12, 1.5, 3, 0);
  row(1, 0, 2, 3, 1);
  row(1, 16, 1.2, 3, 2);
  row(2, 4, 2.2, 3, 3);
  row(3, 0, 1.5, 3, 0);
  row(3, 8, 2.6, 3, 2);
  row(4, 4, 1.4, 3, 1);
  row(5, 0, 2.4, 3, 3);
  row(5, 16, 1.5, 3, 0);
  row(6, 12, 2.2, 3, 2);
  row(7, 0, 1.8, 3, 1);
  row(7, 8, 2.8, 3, 3);
  row(7, 16, 1.2, 3, 0);

  const spawns = [
    spawnAt(-22, -24), // kitchen aisle W
    spawnAt(20, -24), // kitchen aisle E
    spawnAt(-40, -12), // bookcase corridor N
    spawnAt(-40, 22), // bookcase corridor S
    spawnAt(-24, 29), // living, by the TV
    spawnAt(1.5, 28), // by the armchair / stair foot
    spawnAt(22, 13), // south of the dining table
    spawnAt(43, -6), // under the gallery
    spawnAt(-24, 1), // behind the sofa
    spawnAt(4, -2), // centre, by the blocks
    spawnAt(21, 0), // under the dining table
    spawnAt(43, -2, GALLERY), // on the gallery
    spawnAt(-24, 12.5, SEAT), // on the sofa seat
    spawnAt(-45, -11, 12), // bookcase shelf A12 (column 2)
    spawnAt(-22, -32, COUNTER), // on the west counter
    spawnAt(22, -32, COUNTER), // on the east counter
  ];

  return {
    name: 'Lounge',
    boxes,
    spawns,
    spawn: spawnAt(-24, 29),
    bounds,
    accent: 0xff6a4d,
  };
})();
