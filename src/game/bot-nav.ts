// Bot navigation — THREE-free (the headless bot sim imports it too).
//
// Every arena is a list of axis-aligned boxes, so the nav graph is built
// straight from them the first time bots play a map (cached per map):
//
//   • nodes  — standing spots sampled on a 2 m lattice over the floor and over
//              every walkable box top, each with a full standing capsule of
//              clearance;
//   • links  — how a bot gets from one node to a neighbour, classified by the
//              same movement rules the player has (there is no step-up — every
//              rise is a jump): walk, jump (≤ 1.45 m up or a short flat gap),
//              double jump (≤ 3 m), boost (≤ 6.6 m) and drop;
//   • core   — the nodes you can both reach from and return to the spawns, so
//              bots never pick a goal they'd strand themselves on;
//   • vis    — per node, the share of the map it sees (sampled). High-vis,
//              high-ground nodes are the map's power positions.
//
// A* runs over the links (per-difficulty kind costs: easy bots avoid boosts),
// and the path follower string-pulls through runs of walk links so bots move
// in straight lines instead of zig-zagging along the lattice.
//
// Also home to the spawn helpers (pickFreeSpot / pickSpawnPoint) the game
// uses for the local player and bots.

import type { ArenaMap } from './arena-map-data';
import { rayAabb } from './collision';
import { BOT_HEIGHT, BOT_RADIUS } from './constants';
import type { AABB, Vec3 } from './types';

export const LINK_WALK = 0;
export const LINK_JUMP = 1;
export const LINK_DOUBLE = 2;
export const LINK_BOOST = 3;
export const LINK_DROP = 4;
export type LinkKind = 0 | 1 | 2 | 3 | 4;
export const LINK_NAMES = ['walk', 'jump', 'double', 'boost', 'drop'] as const;

// Movement envelope (matches constants: JUMP_SPEED 9 / GRAVITY 25 → 1.62 m
// apex, ×2 with the air jump; a boost is ~6.4 m + the air jump). Kept a
// little under the physical limits so the bots make every link they plan.
const JUMP_RISE = 1.45;
const DOUBLE_RISE = 3.0;
const BOOST_RISE = 6.6;
const MAX_DROP = 16;
const REACH: Record<LinkKind, number> = { 0: 2.95, 1: 3.0, 2: 3.4, 3: 4.6, 4: 3.0 };
const KIND_PENALTY: Record<LinkKind, number> = { 0: 0, 1: 0.8, 2: 2.0, 3: 4.0, 4: 0.4 };

const NAV_CELL = 2; // lattice spacing (m)
const HASH_CELL = 2; // node spatial-hash cell (m)
const IDX_CELL = 4; // box index cell (m)
const STAND_H = BOT_HEIGHT - 0.05;
const EYE_UP = BOT_HEIGHT * 0.85;

export type NavLink = { to: number; kind: LinkKind; cost: number };
export type NavNode = {
  id: number;
  x: number;
  y: number;
  z: number;
  links: NavLink[];
  core: boolean; // reachable from AND back to the spawns
  vis: number; // 0..1 sampled share of the map this spot sees
};

// ── box index ────────────────────────────────────────────────────────────────
// A uniform XZ grid over the solid boxes (the floor slab and the cap are
// handled as the y range instead), so capsule / segment queries only test the
// handful of boxes near them.
export class BoxIndex {
  readonly floorY: number;
  readonly ceilY: number;
  private readonly boxes: AABB[];
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cells: number[][];
  private readonly stamp: Uint32Array;
  private mark = 0;

  constructor(map: ArenaMap) {
    const b = map.bounds;
    this.floorY = map.boxes[0]?.max.y ?? 0;
    this.ceilY = map.boxes[1]?.min.y ?? b.max.y;
    this.boxes = map.boxes.slice(2);
    this.x0 = b.min.x;
    this.z0 = b.min.z;
    this.nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / IDX_CELL));
    this.nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / IDX_CELL));
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    this.stamp = new Uint32Array(this.boxes.length);
    this.boxes.forEach((box, i) => {
      const [cx0, cx1] = this.span(box.min.x, box.max.x, this.x0, this.nx);
      const [cz0, cz1] = this.span(box.min.z, box.max.z, this.z0, this.nz);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cz * this.nx + cx].push(i);
    });
  }

  private span(lo: number, hi: number, o: number, n: number): [number, number] {
    const a = Math.max(0, Math.min(n - 1, Math.floor((lo - o) / IDX_CELL)));
    const b = Math.max(0, Math.min(n - 1, Math.floor((hi - o) / IDX_CELL)));
    return [a, b];
  }

  private nextMark(): number {
    this.mark = (this.mark + 1) >>> 0;
    if (this.mark === 0) {
      this.stamp.fill(0);
      this.mark = 1;
    }
    return this.mark;
  }

  // Visit every box overlapping the XZ rect once; `fn` returning true stops
  // the walk (and query returns true).
  query(ax0: number, az0: number, ax1: number, az1: number, fn: (b: AABB) => boolean | void): boolean {
    const m = this.nextMark();
    const [cx0, cx1] = this.span(ax0, ax1, this.x0, this.nx);
    const [cz0, cz1] = this.span(az0, az1, this.z0, this.nz);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const i of this.cells[cz * this.nx + cx]) {
          if (this.stamp[i] === m) continue;
          this.stamp[i] = m;
          if (fn(this.boxes[i])) return true;
        }
      }
    }
    return false;
  }

  // A standing capsule (square footprint of half-width r, height h, feet at y)
  // overlaps nothing solid.
  capsuleFree(x: number, y: number, z: number, r: number, h: number): boolean {
    if (y < this.floorY - 1e-3 || y + h > this.ceilY) return false;
    const x0 = x - r;
    const x1 = x + r;
    const z0 = z - r;
    const z1 = z + r;
    const y1 = y + h;
    return !this.query(x0, z0, x1, z1, (b) =>
      x0 < b.max.x && x1 > b.min.x && z0 < b.max.z && z1 > b.min.z && y < b.max.y && y1 > b.min.y,
    );
  }

  // Highest surface at or below `y` under the point (x, z) — the floor if
  // nothing else. `r` widens the footprint test (a capsule overhanging an edge
  // still stands on it).
  groundBelow(x: number, z: number, y: number, r = 0): number {
    let best = this.floorY;
    this.query(x - r, z - r, x + r, z + r, (b) => {
      if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) return;
      if (b.max.y <= y + 0.02 && b.max.y > best) best = b.max.y;
    });
    return best;
  }

  // Nothing solid on the segment a → b (2D DDA over the index cells). The
  // last `endPad` metres are ignored (so a sightline to a target standing
  // against a wall isn't blocked by that wall).
  segmentClear(a: Vec3, b: Vec3, endPad = 0): boolean {
    const lo = this.floorY - 1e-3;
    if (a.y < lo || b.y < lo || a.y > this.ceilY || b.y > this.ceilY) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const limit = len - endPad;
    const m = this.nextMark();
    let cx = Math.floor((a.x - this.x0) / IDX_CELL);
    let cz = Math.floor((a.z - this.z0) / IDX_CELL);
    const ex = Math.floor((b.x - this.x0) / IDX_CELL);
    const ez = Math.floor((b.z - this.z0) / IDX_CELL);
    const sx = dx > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-9 ? IDX_CELL / Math.abs(dx) : Infinity;
    const tdz = Math.abs(dz) > 1e-9 ? IDX_CELL / Math.abs(dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-9 ? ((cx + (sx > 0 ? 1 : 0)) * IDX_CELL + this.x0 - a.x) / dx : Infinity;
    let tmz = Math.abs(dz) > 1e-9 ? ((cz + (sz > 0 ? 1 : 0)) * IDX_CELL + this.z0 - a.z) / dz : Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      if (cx >= 0 && cx < this.nx && cz >= 0 && cz < this.nz) {
        for (const i of this.cells[cz * this.nx + cx]) {
          if (this.stamp[i] === m) continue;
          this.stamp[i] = m;
          const t = rayAabb(a, dir, this.boxes[i]);
          if (t !== null && t < limit) return false;
        }
      }
      if (cx === ex && cz === ez) break;
      if (tmx < tmz) {
        if (tmx > 1) break;
        cx += sx;
        tmx += tdx;
      } else {
        if (tmz > 1) break;
        cz += sz;
        tmz += tdz;
      }
    }
    return true;
  }
}

// ── graph ────────────────────────────────────────────────────────────────────
export type NavGraph = {
  map: ArenaMap;
  index: BoxIndex;
  nodes: NavNode[];
  core: number[]; // ids of the core nodes
  power: number[]; // core ids sorted by power (vis + height), best first
  spawnNodes: number[]; // nearest node per map.spawns entry (-1 = none)
  hash: Map<number, number[]>;
  buildMs: number;
};

const hkey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

// Deterministic PRNG so the vis sampling (and the sim) are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Even samples across [lo, hi] at ~NAV_CELL spacing, inset so a bot centred
// on one is well supported.
function axisSamples(lo: number, hi: number): number[] {
  const w = hi - lo;
  const inset = Math.min(0.5, w / 2);
  const span = w - inset * 2;
  const n = Math.max(1, Math.round(span / NAV_CELL) + 1);
  if (n === 1) return [(lo + hi) / 2];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + inset + (span * i) / (n - 1));
  return out;
}

function isPerimeter(map: ArenaMap, b: AABB): boolean {
  const e = 1e-3;
  const o = map.bounds;
  return b.max.y - b.min.y >= 4 && (b.min.x <= o.min.x + e || b.max.x >= o.max.x - e || b.min.z <= o.min.z + e || b.max.z >= o.max.z - e);
}

const graphCache = new WeakMap<ArenaMap, NavGraph>();

export function navFor(map: ArenaMap): NavGraph {
  let g = graphCache.get(map);
  if (!g) {
    g = buildNav(map);
    graphCache.set(map, g);
  }
  return g;
}

export function buildNav(map: ArenaMap): NavGraph {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const index = new BoxIndex(map);
  const nodes: NavNode[] = [];
  const hash = new Map<number, number[]>();
  const R = BOT_RADIUS;

  const addNode = (x: number, y: number, z: number) => {
    const id = nodes.length;
    nodes.push({ id, x, y, z, links: [], core: false, vis: 0 });
    const k = hkey(Math.floor(x / HASH_CELL), Math.floor(z / HASH_CELL));
    const list = hash.get(k);
    if (list) list.push(id);
    else hash.set(k, [id]);
  };
  // Try the sample and a few nudges around it (catches a narrow passage the
  // lattice point itself misses).
  const NUDGE = [
    [0, 0],
    [0.6, 0],
    [-0.6, 0],
    [0, 0.6],
    [0, -0.6],
  ];
  const tryPlace = (x: number, z: number, top: number, lo: AABB | null) => {
    for (const [ox, oz] of NUDGE) {
      const px = x + ox;
      const pz = z + oz;
      if (lo && (px < lo.min.x || px > lo.max.x || pz < lo.min.z || pz > lo.max.z)) continue;
      if (!index.capsuleFree(px, top + 0.02, pz, R, STAND_H)) continue;
      if (Math.abs(index.groundBelow(px, pz, top + 0.05) - top) > 0.03) continue;
      addNode(px, top, pz);
      return;
    }
  };

  // Floor lattice (inside the perimeter).
  const b = map.bounds;
  const fx0 = Math.ceil((b.min.x + 1) / NAV_CELL);
  const fx1 = Math.floor((b.max.x - 1) / NAV_CELL);
  const fz0 = Math.ceil((b.min.z + 1) / NAV_CELL);
  const fz1 = Math.floor((b.max.z - 1) / NAV_CELL);
  for (let iz = fz0; iz < fz1; iz++) {
    for (let ix = fx0; ix < fx1; ix++) tryPlace((ix + 0.5) * NAV_CELL, (iz + 0.5) * NAV_CELL, index.floorY, null);
  }
  // Box tops.
  for (let i = 2; i < map.boxes.length; i++) {
    const box = map.boxes[i];
    const w = box.max.x - box.min.x;
    const d = box.max.z - box.min.z;
    if (w < 0.9 || d < 0.9) continue;
    if (box.max.y + STAND_H > index.ceilY - 0.05) continue;
    if (isPerimeter(map, box)) continue;
    for (const z of axisSamples(box.min.z, box.max.z)) {
      for (const x of axisSamples(box.min.x, box.max.x)) tryPlace(x, z, box.max.y, box);
    }
  }

  // ── links ──
  const r9 = R * 0.9;
  const sweep = (ax: number, az: number, bx: number, bz: number, y: number, h: number, needY: number | null) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 0.4));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      if (!index.capsuleFree(px, y, pz, r9, h)) return false;
      if (needY !== null && Math.abs(index.groundBelow(px, pz, needY + 0.05, R * 0.5) - needY) > 0.06) return false;
    }
    return true;
  };
  const link = (a: NavNode, c: NavNode, kind: LinkKind) => {
    const dist = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
    a.links.push({ to: c.id, kind, cost: dist + KIND_PENALTY[kind] });
  };
  const maxReach = REACH[LINK_BOOST];
  const span = Math.ceil(maxReach / HASH_CELL);
  for (const a of nodes) {
    const hcx = Math.floor(a.x / HASH_CELL);
    const hcz = Math.floor(a.z / HASH_CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const list = hash.get(hkey(hcx + dx, hcz + dz));
        if (!list) continue;
        for (const ci of list) {
          if (ci === a.id) continue;
          const c = nodes[ci];
          const dh = Math.hypot(c.x - a.x, c.z - a.z);
          const dy = c.y - a.y;
          if (dh < 0.3 && Math.abs(dy) < 0.3) continue;
          if (Math.abs(dy) <= 0.06) {
            if (dh > REACH[LINK_WALK]) continue;
            if (sweep(a.x, a.z, c.x, c.z, a.y + 0.02, STAND_H, a.y)) link(a, c, LINK_WALK);
            // A flat gap: jump it (room for the arc above).
            else if (sweep(a.x, a.z, c.x, c.z, a.y + 0.02, STAND_H + 1.2, null)) link(a, c, LINK_JUMP);
          } else if (dy > 0) {
            if (dy > BOOST_RISE) continue;
            const kind: LinkKind = dy <= JUMP_RISE ? LINK_JUMP : dy <= DOUBLE_RISE ? LINK_DOUBLE : LINK_BOOST;
            if (dh > REACH[kind]) continue;
            // Room to rise at the take-off, then to cross over at the landing height.
            if (!index.capsuleFree(a.x, a.y + 0.02, a.z, r9, dy + STAND_H + 0.3)) continue;
            if (sweep(a.x, a.z, c.x, c.z, c.y + 0.05, STAND_H, null)) link(a, c, kind);
          } else {
            if (-dy > MAX_DROP || dh > REACH[LINK_DROP]) continue;
            // Walk off at the take-off height, then fall clear to the landing.
            if (!sweep(a.x, a.z, c.x, c.z, a.y + 0.02, STAND_H, null)) continue;
            if (index.capsuleFree(c.x, c.y + 0.02, c.z, r9, -dy + STAND_H)) link(a, c, LINK_DROP);
          }
        }
      }
    }
  }

  const g: NavGraph = { map, index, nodes, core: [], power: [], spawnNodes: [], hash, buildMs: 0 };

  // ── core: reachable from the spawns AND able to get back ──
  g.spawnNodes = map.spawns.map((s) => nearestNode(g, s, 4));
  const seeds = g.spawnNodes.filter((i) => i >= 0);
  const fwd = new Uint8Array(nodes.length);
  const back = new Uint8Array(nodes.length);
  const rev: number[][] = nodes.map(() => []);
  for (const n of nodes) for (const l of n.links) rev[l.to].push(n.id);
  const flood = (mark: Uint8Array, next: (i: number) => Iterable<number>) => {
    const stack = [...seeds];
    for (const s of seeds) mark[s] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      for (const j of next(i)) {
        if (mark[j]) continue;
        mark[j] = 1;
        stack.push(j);
      }
    }
  };
  flood(fwd, (i) => nodes[i].links.map((l) => l.to));
  flood(back, (i) => rev[i]);
  for (const n of nodes) {
    n.core = fwd[n.id] === 1 && back[n.id] === 1;
    if (n.core) g.core.push(n.id);
  }

  // ── vis: sampled share of the core each spot can see (eye → chest) ──
  const rng = mulberry32(0x1b07 + nodes.length);
  const K = 20;
  const from: Vec3 = { x: 0, y: 0, z: 0 };
  const to: Vec3 = { x: 0, y: 0, z: 0 };
  if (g.core.length > 1) {
    for (const id of g.core) {
      const n = nodes[id];
      from.x = n.x;
      from.y = n.y + EYE_UP;
      from.z = n.z;
      let seen = 0;
      for (let k = 0; k < K; k++) {
        const o = nodes[g.core[Math.floor(rng() * g.core.length)]];
        to.x = o.x;
        to.y = o.y + 1.1;
        to.z = o.z;
        if (Math.hypot(to.x - from.x, to.z - from.z) > 70) continue;
        if (index.segmentClear(from, to)) seen++;
      }
      n.vis = seen / K;
    }
  }
  const floor = index.floorY;
  const powerOf = (n: NavNode) => n.vis + Math.min(1, (n.y - floor) / 8) * 0.35;
  g.power = [...g.core].sort((p, q) => powerOf(nodes[q]) - powerOf(nodes[p]));

  g.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return g;
}

// ── queries ──────────────────────────────────────────────────────────────────

// Nearest node a body at `p` is standing on / next to (-1 when none within
// `maxR`). Nodes above the feet are heavily penalised — you can't be standing
// on a ledge over your head.
export function nearestNode(g: NavGraph, p: Vec3, maxR = 6, coreOnly = false): number {
  let best = -1;
  let bestScore = Infinity;
  const span = Math.ceil(maxR / HASH_CELL);
  const hcx = Math.floor(p.x / HASH_CELL);
  const hcz = Math.floor(p.z / HASH_CELL);
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const list = g.hash.get(hkey(hcx + dx, hcz + dz));
      if (!list) continue;
      for (const i of list) {
        const n = g.nodes[i];
        if (coreOnly && !n.core) continue;
        const h2 = (n.x - p.x) ** 2 + (n.z - p.z) ** 2;
        if (h2 > maxR * maxR) continue;
        const dy = n.y - p.y;
        let s = h2 + dy * dy * 4;
        if (dy > 0.8) s += 60 + dy * 10;
        if (!n.core) s += 6;
        if (s < bestScore) {
          bestScore = s;
          best = i;
        }
      }
    }
  }
  return best;
}

// Node ids within a horizontal radius of (x, z).
export function nodesNear(g: NavGraph, x: number, z: number, r: number, out: number[] = []): number[] {
  out.length = 0;
  const span = Math.ceil(r / HASH_CELL);
  const hcx = Math.floor(x / HASH_CELL);
  const hcz = Math.floor(z / HASH_CELL);
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const list = g.hash.get(hkey(hcx + dx, hcz + dz));
      if (!list) continue;
      for (const i of list) {
        const n = g.nodes[i];
        if ((n.x - x) ** 2 + (n.z - z) ** 2 <= r * r) out.push(i);
      }
    }
  }
  return out;
}

export function linkKind(g: NavGraph, from: number, to: number): LinkKind {
  for (const l of g.nodes[from].links) if (l.to === to) return l.kind;
  return LINK_WALK;
}

// ── A* ───────────────────────────────────────────────────────────────────────
type SearchScratch = { g: Float64Array; came: Int32Array; seen: Uint32Array; closed: Uint32Array; mark: number };
const scratch = new WeakMap<NavGraph, SearchScratch>();

// Per-kind cost multipliers (on the link's penalty, not its length), and an
// optional set of banned links (`from * 65536 + to`) a bot recently failed.
export type PathOpts = { kindCost?: readonly number[]; banned?: ReadonlySet<number>; maxExpand?: number };

export const linkKey = (from: number, to: number) => from * 65536 + to;

export function findPath(g: NavGraph, start: number, goal: number, opts: PathOpts = {}): number[] | null {
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [start];
  let s = scratch.get(g);
  if (!s) {
    const n = g.nodes.length;
    s = { g: new Float64Array(n), came: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n), mark: 0 };
    scratch.set(g, s);
  }
  s.mark = (s.mark + 1) >>> 0;
  if (s.mark === 0) {
    s.seen.fill(0);
    s.closed.fill(0);
    s.mark = 1;
  }
  const mark = s.mark;
  const nodes = g.nodes;
  const goalN = nodes[goal];
  const h = (i: number) => {
    const n = nodes[i];
    return Math.hypot(n.x - goalN.x, n.y - goalN.y, n.z - goalN.z);
  };
  const kindCost = opts.kindCost;
  const banned = opts.banned;
  const maxExpand = opts.maxExpand ?? 8000;
  // Binary min-heap of (f, id).
  const heapF: number[] = [];
  const heapI: number[] = [];
  const push = (f: number, id: number) => {
    let k = heapF.length;
    heapF.push(f);
    heapI.push(id);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= f) break;
      heapF[k] = heapF[p];
      heapI[k] = heapI[p];
      k = p;
    }
    heapF[k] = f;
    heapI[k] = id;
  };
  const pop = (): number => {
    const top = heapI[0];
    const lf = heapF.pop() as number;
    const li = heapI.pop() as number;
    const n = heapF.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        let c = k * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lf) break;
        heapF[k] = heapF[c];
        heapI[k] = heapI[c];
        k = c;
      }
      heapF[k] = lf;
      heapI[k] = li;
    }
    return top;
  };
  s.g[start] = 0;
  s.seen[start] = mark;
  s.came[start] = -1;
  push(h(start), start);
  let expanded = 0;
  while (heapF.length) {
    const cur = pop();
    if (s.closed[cur] === mark) continue;
    if (cur === goal) {
      const path: number[] = [];
      for (let i = goal; i !== -1; i = s.came[i]) path.push(i);
      return path.reverse();
    }
    s.closed[cur] = mark;
    if (++expanded > maxExpand) return null;
    const gc = s.g[cur];
    for (const l of nodes[cur].links) {
      if (s.closed[l.to] === mark) continue;
      let cost = l.cost;
      if (kindCost) cost += KIND_PENALTY[l.kind] * (kindCost[l.kind] - 1);
      if (banned?.has(linkKey(cur, l.to))) cost += 60;
      const ng = gc + cost;
      if (s.seen[l.to] === mark && ng >= s.g[l.to]) continue;
      s.seen[l.to] = mark;
      s.g[l.to] = ng;
      s.came[l.to] = cur;
      push(ng + h(l.to), l.to);
    }
  }
  return null;
}

// A body standing at `a` can walk in a straight line to `b` (same level, clear
// capsule, ground under every step) — used to string-pull a path.
export function walkable(g: NavGraph, a: Vec3, b: Vec3): boolean {
  if (Math.abs(a.y - b.y) > 0.08) return false;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / 0.5));
  const r = BOT_RADIUS * 0.9;
  for (let s = 1; s <= n; s++) {
    const t = s / n;
    const px = a.x + (b.x - a.x) * t;
    const pz = a.z + (b.z - a.z) * t;
    if (!g.index.capsuleFree(px, b.y + 0.02, pz, r, STAND_H)) return false;
    if (Math.abs(g.index.groundBelow(px, pz, b.y + 0.05, BOT_RADIUS * 0.5) - b.y) > 0.08) return false;
  }
  return true;
}

// ── spawn helpers (used by the game for the player and bots) ─────────────────

// Box test with the X/Z faces inflated by `r` (the entity's horizontal radius)
// so a candidate whose CENTER sits just outside a face — but whose capsule would
// overlap the box — is correctly rejected (#23). Y stays exact (vertical clamp).
function pointInsideAnyBox(p: Vec3, map: ArenaMap, r = 0): boolean {
  for (const b of map.boxes) {
    if (
      p.x > b.min.x - r && p.x < b.max.x + r &&
      p.y > b.min.y && p.y < b.max.y &&
      p.z > b.min.z - r && p.z < b.max.z + r
    ) return true;
  }
  return false;
}

export function pickFreeSpot(
  map: ArenaMap,
  avoid: Vec3 | Vec3[] | null = null,
  radius = BOT_RADIUS,
): Vec3 {
  // Accept one point or many — spawn clear of EVERY live opponent, not just one,
  // so you don't drop into someone's crosshair.
  const avoidList = avoid == null ? [] : Array.isArray(avoid) ? avoid : [avoid];
  // Inset the sample box by the radius too, so we never sample flush to a wall.
  const xExt = (map.bounds.max.x - map.bounds.min.x) / 2 - 1.5 - radius;
  const zExt = (map.bounds.max.z - map.bounds.min.z) / 2 - 1.5 - radius;
  const cx = (map.bounds.min.x + map.bounds.max.x) / 2;
  const cz = (map.bounds.min.z + map.bounds.max.z) / 2;
  // Probe the WHOLE standing capsule, not just two ends — a box whose vertical
  // span sat between the old 0.5m / 1.7m samples would slip through and spawn the
  // player clipped inside cover. These heights span foot→head.
  const PROBE_YS = [0.15, 0.55, 0.95, 1.35, BOT_HEIGHT - 0.1];
  const clearAt = (x: number, z: number, y: number) =>
    PROBE_YS.every((dy) => !pointInsideAnyBox({ x, y: y + dy, z }, map, radius));
  let fallback: Vec3 | null = null;
  for (let i = 0; i < 48; i++) {
    const x = cx + (Math.random() - 0.5) * 2 * xExt;
    const z = cz + (Math.random() - 0.5) * 2 * zExt;
    const y = 0.05;
    if (clearAt(x, z, y)) {
      // First clear spot is a safe fallback; keep searching for one far from
      // every avoid point so we don't telefrag/stack on a live opponent.
      if (!fallback) fallback = { x, y, z };
      if (avoidList.every((a) => Math.hypot(x - a.x, z - a.z) > 5)) {
        return { x, y, z };
      }
    }
  }
  // A clear-but-near spot beats the old {0,0,0} fallback, which could land
  // inside a central monolith on Stadium/Hangar/Spire/Reactor/Crucible.
  if (fallback) return fallback;
  return { x: map.spawn.x, y: 0.05, z: map.spawn.z };
}

// The spawns pickSpawnPoint chooses between, safest first: hand-placed points
// ranked by distance to the nearest avoid point. Bots read spawns with this
// too — knowing where an enemy is likely to reappear is map knowledge.
export function rankSpawns(map: ArenaMap, avoid: Vec3[]): Vec3[] {
  const scored = map.spawns.map((s) => ({
    s,
    d: avoid.length ? Math.min(...avoid.map((a) => Math.hypot(s.x - a.x, s.y - a.y, s.z - a.z))) : Math.random() * 100,
  }));
  scored.sort((a, b) => b.d - a.d);
  return scored.map((e) => e.s);
}

// Hand-placed spawn point (map.spawns) farthest from every avoid point, with a
// little variety among the safest few so respawns aren't predictable. Falls
// back to a random clear floor spot on maps without a spawn list.
export function pickSpawnPoint(map: ArenaMap, avoid: Vec3[] = [], radius = BOT_RADIUS): Vec3 {
  const spawns = map.spawns;
  if (!spawns || spawns.length === 0) return pickFreeSpot(map, avoid, radius);
  const ranked = rankSpawns(map, avoid);
  const pick = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))];
  return { ...pick };
}
