// Map analysis for the box-built arenas — dev tooling, no deps.
//
//   npx tsx scripts/map-check.ts [mapId…|--all] [--out design/shots/maps] [--no-png]
//
// For each map prints a report and writes `<out>/<id>-plan.png`:
//   • top-down plan: every box coloured by its TOP height (legend strip on the
//     left, 0 → 30 m), outlined by how hard its top is to reach from the floor
//     (green walk/jump · yellow double-jump · orange boost · red unreachable),
//     spawns as numbered white dots, lights as small yellow dots, a 10 m grid
//     (brighter lines through the origin);
//   • two elevations under it: looking along −z (x→, y↑) and along +x (z→, y↑).
// Checks (ERROR = must fix, WARN = look at it):
//   spawns inside a box / unsupported / outside bounds; too few spawns;
//   boxes outside bounds or degenerate; surfaces unreachable even with boosts;
//   lights not sitting on a box face; the lightmap budget; the cap height vs
//   the highest walkable surface.
// Metrics: footprint, surface tiers, spawn spread, spawn-to-spawn sightlines,
// and "openness" — the share of random standing-eye pairs that can see each
// other (lower = fewer simultaneous sightlines = less chaotic).
//
// Reachability is a HEURISTIC over top faces (no step-up in this game — every
// rise is a jump): jump ≤ 1.5 m up / ≤ 4.5 m gap, double jump ≤ 3.1 m / ≤ 6 m,
// boost ≤ 7.5 m / ≤ 8 m (any surface or wall ≤ 4 m away works as a launch),
// drops ≤ 12 m gap. It flags layouts that need a look; the game is the truth.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { MAPS, type ArenaMap, type MapBox } from '../src/game/arena-map-data';
import { DUEL_MAP_POOL } from '../src/game/arena-data';
import { rayAabb } from '../src/game/collision';
import { themeForMapId, FACE_NORMAL, type WorldTheme } from '../src/game/world/themes';
import type { TrainingLayout } from '../src/game/training/layout';

// The training range's gameplay layout, when the map module exports one.
const trainingLayout = ((await import('../src/game/maps/training')) as { TRAINING_LAYOUT?: TrainingLayout }).TRAINING_LAYOUT;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const outDir = opt('out', 'design/shots/maps');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const list = flag('all') || ids.length === 0 ? MAPS.map((m) => m.id) : ids;

type Surf = { i: number; top: number; x0: number; x1: number; z0: number; z1: number; area: number };
type Reach = 0 | 1 | 2 | 3 | 4; // walk, jump, double, boost, unreachable
const REACH_NAME = ['walk', 'jump', 'double-jump', 'boost', 'UNREACHABLE'];

const PLAYER_R = 0.4;
const PLAYER_H = 1.8;
const EYE = 1.6;

function rectGap(a: Surf, b: Surf): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dz = Math.max(0, a.z0 - b.z1, b.z0 - a.z1);
  return Math.hypot(dx, dz);
}

// Tall boundary walls (touching the bounds) — their tops aren't play space.
function isPerimeter(map: ArenaMap, b: MapBox, i: number): boolean {
  if (i < 2) return false;
  if (b.tag === 'perimeter') return true;
  const e = 1e-3;
  const o = map.bounds;
  return b.max.y - b.min.y >= 4 && (b.min.x <= o.min.x + e || b.max.x >= o.max.x - e || b.min.z <= o.min.z + e || b.max.z >= o.max.z - e);
}

function surfaces(map: ArenaMap): Surf[] {
  const out: Surf[] = [];
  map.boxes.forEach((b, i) => {
    if (i === 1 || isPerimeter(map, b, i)) return;
    const w = b.max.x - b.min.x;
    const d = b.max.z - b.min.z;
    if (w < 0.8 || d < 0.8) return;
    // Buried top (another box sits flush on it over its whole footprint) → skip.
    const buried = map.boxes.some(
      (o, j) => j !== i && j !== 1 && o.min.y <= b.max.y + 0.01 && o.max.y > b.max.y + 0.3 &&
        o.min.x <= b.min.x && o.max.x >= b.max.x && o.min.z <= b.min.z && o.max.z >= b.max.z,
    );
    if (buried) return;
    // A top flush with the ceiling (a wall that runs to the roof) isn't play space.
    const cap = map.boxes[1];
    if (cap && b.max.y >= cap.min.y - 0.05) return;
    out.push({ i, top: b.max.y, x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z, area: w * d });
  });
  return out;
}

function edgeClass(a: Surf, b: Surf): Reach {
  const g = rectGap(a, b);
  const dh = b.top - a.top;
  if (dh <= 0.05) return g <= (dh < -0.05 ? 12 : 4.5) ? (g <= 0.9 ? 0 : 1) : 4;
  if (dh <= 1.5 && g <= 4.5) return 1;
  if (dh <= 3.1 && g <= 6) return 2;
  if (dh <= 7.5 && g <= 8) return 3;
  return 4;
}

// Minimax path class from the floor to every surface.
function reachability(surfs: Surf[]): Reach[] {
  const best: Reach[] = surfs.map((s) => (s.i === 0 ? 0 : 4));
  const done = new Array(surfs.length).fill(false);
  for (;;) {
    let k = -1;
    for (let i = 0; i < surfs.length; i++) if (!done[i] && best[i] < 4 && (k < 0 || best[i] < best[k])) k = i;
    if (k < 0) break;
    done[k] = true;
    for (let j = 0; j < surfs.length; j++) {
      if (done[j]) continue;
      const c = Math.max(best[k], edgeClass(surfs[k], surfs[j])) as Reach;
      if (c < best[j]) best[j] = c;
    }
  }
  return best;
}

function capsuleHits(map: ArenaMap, p: { x: number; y: number; z: number }, r = PLAYER_R): number[] {
  const hits: number[] = [];
  map.boxes.forEach((b, i) => {
    if (p.x - r < b.max.x && p.x + r > b.min.x && p.z - r < b.max.z && p.z + r > b.min.z &&
        p.y + 0.02 < b.max.y && p.y + PLAYER_H > b.min.y) hits.push(i);
  });
  return hits;
}

function supported(map: ArenaMap, p: { x: number; y: number; z: number }): boolean {
  return map.boxes.some((b) => p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z && b.max.y <= p.y + 0.01 && b.max.y >= p.y - 0.2);
}

function los(map: ArenaMap, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-3) return true;
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  for (let i = 0; i < map.boxes.length; i++) {
    if (i === 1) continue;
    const t = rayAabb(a, dir, map.boxes[i]);
    if (t !== null && t > 0.05 && t < len - 0.05) return false;
  }
  return true;
}

// Deterministic PRNG so metrics are comparable run to run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standingPoints(map: ArenaMap, surfs: Surf[], n: number, rand: () => number) {
  const pts: { x: number; y: number; z: number }[] = [];
  const total = surfs.reduce((a, s) => a + s.area, 0);
  let guard = 0;
  while (pts.length < n && guard++ < n * 40) {
    let r = rand() * total;
    let s = surfs[0];
    for (const c of surfs) {
      r -= c.area;
      if (r <= 0) {
        s = c;
        break;
      }
    }
    const p = { x: s.x0 + rand() * (s.x1 - s.x0), y: s.top + 0.05, z: s.z0 + rand() * (s.z1 - s.z0) };
    if (capsuleHits(map, p).length === 0) pts.push(p);
  }
  return pts;
}

function lightChecks(map: ArenaMap, theme: WorldTheme): string[] {
  const warns: string[] = [];
  theme.lights.forEach((l, k) => {
    if (l.free) {
      const b = map.bounds;
      if (l.at[0] > b.min.x && l.at[0] < b.max.x && l.at[2] > b.min.z && l.at[2] < b.max.z) warns.push(`light #${k} is free-standing but inside the arena bounds`);
      return;
    }
    const n = FACE_NORMAL[l.face];
    const axis = n[0] ? 0 : n[1] ? 1 : 2;
    const sign = n[axis];
    const key = ['x', 'y', 'z'] as const;
    const on = map.boxes.some((b, i) => {
      if (i === 1 && theme.openSky) return false;
      const plane = sign > 0 ? b.max[key[axis]] : b.min[key[axis]];
      if (Math.abs(plane - l.at[axis]) > 0.03) return false;
      for (let a = 0; a < 3; a++) {
        if (a === axis) continue;
        if (l.at[a] < b.min[key[a]] - 0.05 || l.at[a] > b.max[key[a]] + 0.05) return false;
      }
      return true;
    });
    if (!on) warns.push(`light #${k} at [${l.at.map((v) => +v.toFixed(2)).join(', ')}] face ${l.face} is not on any box face`);
  });
  return warns;
}

function lightmapEstimate(map: ArenaMap, theme: WorldTheme): { texels: number; effTexel: number } {
  let area = 0;
  map.boxes.forEach((b, i) => {
    if (i === 1 && (map.openTop || theme.openSky)) return;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    area += 2 * (sx * sy + sy * sz + sx * sz) * (i === 1 ? 0.25 : 1);
  });
  const t = theme.bake.texel;
  const texels = area / (t * t);
  const max = theme.bake.maxTexels ?? 120_000;
  return { texels, effTexel: texels > max ? t * Math.sqrt(texels / max) : t };
}

// ── PNG ─────────────────────────────────────────────────────────────────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 3×5 digits for spawn numbers and scale labels.
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

class Canvas {
  px: Uint8Array;
  constructor(public w: number, public h: number, bg: [number, number, number]) {
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x: number, y: number, c: [number, number, number], a = 1) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.px[o + k] = Math.round(this.px[o + k] * (1 - a) + c[k] * a);
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], a = 1) {
    for (let y = Math.floor(Math.min(y0, y1)); y < Math.ceil(Math.max(y0, y1)); y++) for (let x = Math.floor(Math.min(x0, x1)); x < Math.ceil(Math.max(x0, x1)); x++) this.set(x, y, c, a);
  }
  frame(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], t = 1) {
    this.rect(x0, y0, x1, y0 + t, c);
    this.rect(x0, y1 - t, x1, y1, c);
    this.rect(x0, y0, x0 + t, y1, c);
    this.rect(x1 - t, y0, x1, y1, c);
  }
  disc(cx: number, cy: number, r: number, c: [number, number, number]) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, c);
  }
  text(s: string, x: number, y: number, c: [number, number, number], scale = 2) {
    for (const ch of s) {
      const g = DIGITS[+ch];
      if (g) for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === '1') this.rect(x + q * scale, y + r * scale, x + (q + 1) * scale, y + (r + 1) * scale, c);
      x += 4 * scale;
    }
  }
}

function heightColor(h: number): [number, number, number] {
  // 0 m dark slate → 4 blue → 8 teal → 12 green → 16 yellow → 22 orange → 30 red
  const stops: [number, [number, number, number]][] = [
    [0, [52, 56, 66]], [1.5, [70, 86, 120]], [4, [58, 110, 190]], [8, [40, 170, 170]], [12, [80, 190, 90]],
    [16, [220, 210, 70]], [22, [235, 140, 50]], [30, [220, 60, 60]],
  ];
  if (h <= 0) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (h <= stops[i][0]) {
      const [h0, c0] = stops[i - 1];
      const [h1, c1] = stops[i];
      const t = (h - h0) / (h1 - h0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}
const REACH_COLOR: [number, number, number][] = [[90, 220, 110], [90, 220, 110], [240, 210, 60], [255, 140, 40], [255, 40, 60]];

function render(map: ArenaMap, theme: WorldTheme, surfs: Surf[], reach: Reach[], file: string) {
  const b = map.bounds;
  const W = b.max.x - b.min.x;
  const D = b.max.z - b.min.z;
  const H = b.max.y - b.min.y;
  const s = Math.max(4, Math.min(12, Math.floor(1100 / Math.max(W, D))));
  const pad = 36;
  const legend = 28;
  const planW = W * s;
  const planH = D * s;
  const es = Math.max(3, Math.floor(s * 0.6)); // elevation scale
  const e1W = W * es;
  const e2W = D * es;
  const eH = H * es;
  const cw = Math.max(legend + pad + planW + pad, legend + pad + e1W + pad + e2W + pad);
  const ch = pad + planH + pad + eH + pad;
  const c = new Canvas(Math.ceil(cw), Math.ceil(ch), [18, 20, 26]);
  const ox = legend + pad;
  const oy = pad;
  const X = (x: number) => ox + (x - b.min.x) * s;
  const Z = (z: number) => oy + (z - b.min.z) * s;

  // legend: height ramp 0..30 m
  for (let y = 0; y < planH; y++) {
    const h = 30 * (1 - y / planH);
    c.rect(8, oy + y, 8 + 14, oy + y + 1, heightColor(h));
  }
  for (const h of [0, 10, 20, 30]) c.text(String(h), 6, oy + (1 - h / 30) * planH - 5, [220, 220, 220], 1);

  // plan: boxes by top height ascending
  c.rect(X(b.min.x), Z(b.min.z), X(b.max.x), Z(b.max.z), heightColor(0));
  const order = map.boxes.map((_, i) => i).filter((i) => i > 1).sort((p, q) => map.boxes[p].max.y - map.boxes[q].max.y);
  const reachOf = new Map<number, Reach>();
  surfs.forEach((sf, k) => reachOf.set(sf.i, reach[k]));
  for (const i of order) {
    const bx = map.boxes[i];
    const col = heightColor(bx.max.y);
    c.rect(X(bx.min.x), Z(bx.min.z), X(bx.max.x), Z(bx.max.z), col);
    const r = reachOf.get(i);
    c.frame(X(bx.min.x), Z(bx.min.z), X(bx.max.x), Z(bx.max.z), r === undefined ? [10, 10, 12] : REACH_COLOR[r], r !== undefined && r >= 2 ? 2 : 1);
  }
  // grid
  for (let x = Math.ceil(b.min.x / 10) * 10; x <= b.max.x; x += 10) c.rect(X(x), Z(b.min.z), X(x) + 1, Z(b.max.z), [255, 255, 255], x === 0 ? 0.35 : 0.12);
  for (let z = Math.ceil(b.min.z / 10) * 10; z <= b.max.z; z += 10) c.rect(X(b.min.x), Z(z), X(b.max.x), Z(z) + 1, [255, 255, 255], z === 0 ? 0.35 : 0.12);
  // lights
  for (const l of theme.lights) c.disc(X(l.at[0]), Z(l.at[2]), 2, [255, 230, 120]);
  // spawns
  map.spawns.forEach((p, k) => {
    c.disc(X(p.x), Z(p.z), 6, [10, 10, 10]);
    c.disc(X(p.x), Z(p.z), 5, [255, 255, 255]);
    c.text(String(k), X(p.x) + 8, Z(p.z) - 5, [255, 255, 255], 2);
  });
  c.disc(X(map.spawn.x), Z(map.spawn.z), 2, [255, 60, 200]);

  // elevations
  const ey = oy + planH + pad;
  const e1x = legend + pad;
  const e2x = e1x + e1W + pad;
  c.rect(e1x, ey, e1x + e1W, ey + eH, [26, 28, 36]);
  c.rect(e2x, ey, e2x + e2W, ey + eH, [26, 28, 36]);
  const YY = (y: number) => ey + eH - (y - b.min.y) * es;
  // draw far-to-near isn't needed for a silhouette; tall first then short so low detail shows
  // Perimeter walls would hide everything — draw only their outline.
  const byH = map.boxes.map((_, i) => i).filter((i) => i > 1 && !isPerimeter(map, map.boxes[i], i)).sort((p, q) => map.boxes[q].max.y - map.boxes[p].max.y);
  const wallTop = Math.max(0, ...map.boxes.filter((bx, i) => isPerimeter(map, bx, i)).map((bx) => bx.max.y));
  c.frame(e1x, YY(wallTop), e1x + e1W, YY(0), [200, 200, 90]);
  c.frame(e2x, YY(wallTop), e2x + e2W, YY(0), [200, 200, 90]);
  for (const i of byH) {
    const bx = map.boxes[i];
    const col = heightColor(bx.max.y);
    c.rect(e1x + (bx.min.x - b.min.x) * es, YY(bx.max.y), e1x + (bx.max.x - b.min.x) * es, YY(bx.min.y), col, 0.55);
    c.rect(e2x + (bx.min.z - b.min.z) * es, YY(bx.max.y), e2x + (bx.max.z - b.min.z) * es, YY(bx.min.y), col, 0.55);
  }
  for (let y = 0; y <= b.max.y; y += 5) {
    c.rect(e1x, YY(y), e1x + e1W, YY(y) + 1, [255, 255, 255], y === 0 ? 0.4 : 0.1);
    c.rect(e2x, YY(y), e2x + e2W, YY(y) + 1, [255, 255, 255], y === 0 ? 0.4 : 0.1);
    if (y % 10 === 0) c.text(String(y), e1x - 14, YY(y) - 3, [200, 200, 200], 1);
  }
  for (const p of map.spawns) {
    c.disc(e1x + (p.x - b.min.x) * es, YY(p.y + 0.9), 2, [255, 255, 255]);
    c.disc(e2x + (p.z - b.min.z) * es, YY(p.y + 0.9), 2, [255, 255, 255]);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(c.w, c.h, c.px));
}


// Training layout contract (src/game/training/layout.ts): standable starts and
// pads, targets clear of geometry and visible from the firing line, clear
// strafe lanes, gates in open air.
function trainingChecks(map: ArenaMap, L: TrainingLayout, errs: string[], warns: string[], info: string[]) {
  const stand = (name: string, p: { x: number; y: number; z: number }) => {
    if (capsuleHits(map, p).length) errs.push(`${name} (${p.x}, ${p.y}, ${p.z}) is inside geometry`);
    else if (!supported(map, p)) errs.push(`${name} (${p.x}, ${p.y}, ${p.z}) is not standing on a surface`);
  };
  stand('hub.spawn', L.hub.spawn);
  stand('gallery.start', L.gallery.start);
  stand('course.start', L.course.start);
  for (const [id, pad] of Object.entries(L.pads)) {
    stand(`pad ${id}`, { ...pad.center, y: pad.center.y + 0.05 });
    const inHub = pad.center.x >= L.hub.area.min.x && pad.center.x <= L.hub.area.max.x && pad.center.z >= L.hub.area.min.z && pad.center.z <= L.hub.area.max.z;
    if (!inHub) warns.push(`pad ${id} is outside hub.area`);
  }
  const fl = L.gallery.firingLine;
  if (!(L.gallery.start.x >= fl.min.x && L.gallery.start.x <= fl.max.x && L.gallery.start.z >= fl.min.z && L.gallery.start.z <= fl.max.z)) errs.push('gallery.start is outside the firing line');
  const eyeY = fl.min.y + EYE;
  const eyes = [
    { x: (fl.min.x + fl.max.x) / 2, y: eyeY, z: (fl.min.z + fl.max.z) / 2 },
    { x: fl.min.x + 0.5, y: eyeY, z: fl.min.z + 0.5 },
    { x: fl.max.x - 0.5, y: eyeY, z: fl.max.z - 0.5 },
  ];
  const clearOf = (p: { x: number; y: number; z: number }, r: number) =>
    !map.boxes.some((b, i) => i !== 1 && p.x > b.min.x - r && p.x < b.max.x + r && p.y > b.min.y - r && p.y < b.max.y + r && p.z > b.min.z - r && p.z < b.max.z + r);
  let hidden = 0;
  const dists: number[] = [];
  L.gallery.anchors.forEach((a, k) => {
    if (!clearOf(a, 0.6)) errs.push(`gallery anchor ${k} is within 0.6 m of geometry`);
    const seen = eyes.filter((e) => los(map, e, a)).length;
    if (seen < eyes.length) hidden++;
    if (seen === 0) errs.push(`gallery anchor ${k} is not visible from the firing line`);
    dists.push(Math.hypot(a.x - eyes[0].x, a.z - eyes[0].z));
  });
  if (hidden) warns.push(`${hidden} gallery anchors are hidden from part of the firing line`);
  // Lanes are FEET positions of player-sized strafers: standing room and
  // support all along, plus room for a 1.4 m hop.
  L.gallery.strafeLanes.forEach((ln, k) => {
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = { x: ln.a.x + (ln.b.x - ln.a.x) * t, y: ln.a.y + (ln.b.y - ln.a.y) * t + 0.05, z: ln.a.z + (ln.b.z - ln.a.z) * t };
      if (capsuleHits(map, p).length || capsuleHits(map, { ...p, y: p.y + 1.4 }).length) {
        errs.push(`strafe lane ${k} is blocked near t=${t.toFixed(1)}`);
        break;
      }
      if (!supported(map, p)) {
        errs.push(`strafe lane ${k} is unsupported near t=${t.toFixed(1)}`);
        break;
      }
    }
    const mid = { x: (ln.a.x + ln.b.x) / 2, y: (ln.a.y + ln.b.y) / 2 + 1.2, z: (ln.a.z + ln.b.z) / 2 }; // chest
    if (!los(map, eyes[0], mid)) warns.push(`strafe lane ${k} midpoint is hidden from the firing-line centre`);
  });
  L.course.gates.forEach((g, k) => {
    const c = { x: (g.min.x + g.max.x) / 2, y: g.min.y + 0.9, z: (g.min.z + g.max.z) / 2 };
    if (!clearOf(c, 0)) errs.push(`course gate ${k} centre is inside geometry`);
  });
  L.course.targets.forEach((t, k) => {
    if (!clearOf(t, 0.6)) errs.push(`gauntlet target ${k} is within 0.6 m of geometry`);
  });
  let route = Math.hypot(L.course.gates[0] ? (L.course.gates[0].min.x + L.course.gates[0].max.x) / 2 - L.course.start.x : 0, L.course.gates[0] ? (L.course.gates[0].min.z + L.course.gates[0].max.z) / 2 - L.course.start.z : 0);
  for (let k = 1; k < L.course.gates.length; k++) {
    const a = L.course.gates[k - 1];
    const b = L.course.gates[k];
    route += Math.hypot((a.min.x + a.max.x) / 2 - (b.min.x + b.max.x) / 2, (a.min.y + a.max.y) / 2 - (b.min.y + b.max.y) / 2, (a.min.z + a.max.z) / 2 - (b.min.z + b.max.z) / 2);
  }
  dists.sort((p, q) => p - q);
  info.push(`training: ${L.gallery.anchors.length} anchors ${dists.length ? `${dists[0].toFixed(0)}–${dists[dists.length - 1].toFixed(0)} m` : ''}, ${L.gallery.strafeLanes.length} strafe lanes, ${L.course.gates.length} gates (straight-line route ≈ ${route.toFixed(0)} m, par ${L.course.par} s), ${L.course.targets.length} gauntlet targets`);
}

// ── report ──────────────────────────────────────────────────────────────────
let errors = 0;
for (const id of list) {
  const entry = MAPS.find((m) => m.id === id);
  if (!entry) {
    console.log(`unknown map ${id}`);
    errors++;
    continue;
  }
  const map = entry.map;
  const theme = themeForMapId(id);
  const errs: string[] = [];
  const warns: string[] = [];
  const b = map.bounds;
  const W = b.max.x - b.min.x;
  const D = b.max.z - b.min.z;
  const duel = (DUEL_MAP_POOL as readonly string[]).includes(id);

  // structure
  const f = map.boxes[0];
  if (!f || f.max.y !== 0 || f.min.x > b.min.x || f.max.x < b.max.x || f.min.z > b.min.z || f.max.z < b.max.z) errs.push('boxes[0] must be the floor slab (top y=0) covering the bounds');
  const cap = map.boxes[1];
  if (!cap || Math.abs(cap.min.y - (b.max.y - 1)) > 0.01) errs.push('boxes[1] must be the cap with min.y = bounds.max.y - 1');
  map.boxes.forEach((bx, i) => {
    if (bx.max.x - bx.min.x <= 0 || bx.max.y - bx.min.y <= 0 || bx.max.z - bx.min.z <= 0) errs.push(`box ${i} is degenerate`);
    if (bx.min.x < b.min.x - 1e-6 || bx.max.x > b.max.x + 1e-6 || bx.min.z < b.min.z - 1e-6 || bx.max.z > b.max.z + 1e-6 || bx.max.y > b.max.y + 1e-6)
      errs.push(`box ${i}${bx.tag ? ` (${bx.tag})` : ''} pokes outside the bounds`);
  });

  // surfaces + reach
  const surfs = surfaces(map);
  const reach = reachability(surfs);
  const unreachable = surfs.filter((_, k) => reach[k] === 4 && surfs[k].i >= 2);
  for (const sf of unreachable) warns.push(`surface of box ${sf.i}${map.boxes[sf.i].tag ? ` (${map.boxes[sf.i].tag})` : ''} at y=${sf.top.toFixed(1)} looks unreachable`);
  const maxTop = Math.max(0, ...surfs.map((sf) => sf.top));
  const headroom = cap ? cap.min.y - maxTop : 0;
  if (headroom < 8) warns.push(`only ${headroom.toFixed(1)} m between the highest walkable top (${maxTop.toFixed(1)}) and the cap — a boost there hits the ceiling`);
  const tiers = new Map<string, number>();
  for (const sf of surfs) {
    if (sf.i === 0) continue;
    const t = sf.top < 0.5 ? 'ground 0–0.5' : sf.top < 3 ? 'low 0.5–3' : sf.top < 7 ? 'mid 3–7' : sf.top < 12 ? 'high 7–12' : 'apex 12+';
    tiers.set(t, (tiers.get(t) ?? 0) + (sf.i === 0 ? 0 : sf.area));
  }
  const byReach = [0, 0, 0, 0, 0];
  surfs.forEach((sf, k) => sf.i >= 2 && (byReach[reach[k]] += sf.area));

  // spawns
  const sp = map.spawns;
  if (sp.length < (duel ? 6 : 10)) warns.push(`${sp.length} spawns (want ≥ ${duel ? 6 : 10} for ${duel ? 'duel' : 'FFA/TDM'})`);
  sp.forEach((p, k) => {
    const hits = capsuleHits(map, p);
    if (hits.length) errs.push(`spawn ${k} (${p.x}, ${p.y}, ${p.z}) overlaps box ${hits.join(', ')}`);
    if (!supported(map, p)) errs.push(`spawn ${k} (${p.x}, ${p.y}, ${p.z}) is not standing on a surface`);
    // The server jitters every spawn ±0.5 m in x/z: the jittered capsule must
    // stay clear and supported too.
    else if (capsuleHits(map, p, PLAYER_R + 0.55).length || [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].some(([jx, jz]) => !supported(map, { x: p.x + jx, y: p.y, z: p.z + jz })))
      errs.push(`spawn ${k} (${p.x}, ${p.y}, ${p.z}) has < 1 m of clear, supported room around it (server jitters spawns ±0.5 m)`);
    if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z) errs.push(`spawn ${k} is outside the bounds`);
  });
  if (capsuleHits(map, map.spawn).length || !supported(map, map.spawn)) errs.push('map.spawn (offline start) is blocked or unsupported');
  let minPair = Infinity;
  let visPairs = 0;
  let pairs = 0;
  const nn: number[] = [];
  for (let i = 0; i < sp.length; i++) {
    let near = Infinity;
    for (let j = 0; j < sp.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(sp[i].x - sp[j].x, sp[i].y - sp[j].y, sp[i].z - sp[j].z);
      near = Math.min(near, d);
      if (j > i) {
        minPair = Math.min(minPair, d);
        pairs++;
        if (los(map, { ...sp[i], y: sp[i].y + EYE }, { ...sp[j], y: sp[j].y + 1.0 })) visPairs++;
      }
    }
    nn.push(near);
  }
  if (minPair < 6) warns.push(`two spawns only ${minPair.toFixed(1)} m apart`);

  // openness
  const rand = rng(1234);
  const pts = standingPoints(map, surfs, 260, rand);
  let seen = 0;
  let tested = 0;
  let longest = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j += 3) {
      tested++;
      const a = { ...pts[i], y: pts[i].y + EYE };
      const c2 = { ...pts[j], y: pts[j].y + 1.0 };
      if (los(map, a, c2)) {
        seen++;
        longest = Math.max(longest, Math.hypot(a.x - c2.x, a.y - c2.y, a.z - c2.z));
      }
    }
  }

  warns.push(...lightChecks(map, theme));
  const lmE = lightmapEstimate(map, theme);
  if (lmE.effTexel > theme.bake.texel * 1.35) warns.push(`lightmap ≈ ${Math.round(lmE.texels / 1000)}k texels at ${theme.bake.texel} m → coarsened to ${lmE.effTexel.toFixed(2)} m (raise bake.maxTexels or texel)`);

  const info: string[] = [];
  if (id === 'training' && trainingLayout) trainingChecks(map, trainingLayout, errs, warns, info);

  console.log(`\n══ ${id} — ${map.name} (${duel ? 'duel' : 'FFA/TDM'}) ══`);
  console.log(`footprint ${W}×${D} m, cap at ${cap?.min.y ?? '?'} m, ${map.boxes.length} boxes, highest walkable ${maxTop.toFixed(1)} m`);
  console.log(`surfaces (m² of tops): ${[...tiers].map(([k, v]) => `${k}: ${Math.round(v)}`).join(' · ')}`);
  console.log(`reach (m² of raised tops): ${REACH_NAME.map((n, k) => `${n} ${Math.round(byReach[k])}`).join(' · ')}`);
  console.log(`spawns ${sp.length}: min pair ${minPair.toFixed(1)} m, mean nearest ${(nn.reduce((a, v) => a + v, 0) / Math.max(1, nn.length)).toFixed(1)} m, spawn→spawn sightlines ${visPairs}/${pairs} (${Math.round((100 * visPairs) / Math.max(1, pairs))}%)`);
  console.log(`openness ${Math.round((100 * seen) / Math.max(1, tested))}% of random eye pairs see each other (longest ${longest.toFixed(0)} m)`);
  console.log(`lightmap ≈ ${Math.round(lmE.texels / 1000)}k texels → texel ${lmE.effTexel.toFixed(2)} m · ${theme.lights.length} lights`);
  for (const line of info) console.log(line);
  for (const e of errs) console.log(`  ERROR ${e}`);
  for (const w of warns) console.log(`  WARN  ${w}`);
  errors += errs.length;
  if (!flag('no-png')) {
    const file = join(outDir, `${id}-plan.png`);
    render(map, theme, surfs, reach, file);
    console.log(`plan → ${file}`);
  }
}
process.exit(errors ? 1 : 0);
