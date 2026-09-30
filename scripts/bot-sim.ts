// Headless bot QA — dev tooling, no deps. Runs the real bot brain
// (src/game/bot-brain.ts) without a renderer.
//
//   npx tsx scripts/bot-sim.ts [nav|brawl|aim|all] [--maps a,b] [--secs 180] [--seed-runs 1]
//
//   nav    per map: nav graph size, link kinds, core coverage, build time,
//          spawns off the graph (ERROR).
//   brawl  per map: 6 bots (2 easy / 2 medium / 2 hard) FFA for --secs
//          simulated seconds at 64 Hz. Reports per difficulty: frags and deaths
//          per minute, accuracy, stuck seconds per minute, jump/boost
//          traversal success, share of time moving, and map coverage.
//          ERRORs: NaN / fell out of the world.
//   aim    per difficulty: shots at a scripted "human" (ADAD strafing at run
//          speed with hops) and at a standing target on an open floor, at 12 /
//          22 / 35 m — hit rate and time to first shot. The pre-overhaul aim
//          model runs alongside as a baseline.

import { MAPS, type ArenaMap } from '../src/game/arena-map-data';
import { BotBrain, type BotShot, type BotTarget } from '../src/game/bot-brain';
import { buildNav, navFor, LINK_NAMES, pickSpawnPoint } from '../src/game/bot-nav';
import { rayAabb } from '../src/game/collision';
import { BOT_HEIGHT, BOT_RADIUS, PLAYER_RADIUS, TICK_DT, type BotDifficulty } from '../src/game/constants';
import { shell, spawnAt } from '../src/game/maps/kit';
import type { AABB, Vec3 } from '../src/game/types';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const mode = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) ?? 'all';
const mapIds = opt('maps', MAPS.filter((m) => m.id !== 'training').map((m) => m.id).join(',')).split(',');
const SECS = Number(opt('secs', '180'));
const DIFFS: BotDifficulty[] = ['easy', 'medium', 'hard'];
let errors = 0;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const f1 = (n: number) => n.toFixed(1);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

// ── nav ──────────────────────────────────────────────────────────────────────
function navReport() {
  console.log('\n== nav ==');
  for (const id of mapIds) {
    const map = MAPS.find((m) => m.id === id)?.map;
    if (!map) continue;
    const g = buildNav(map);
    const kinds = [0, 0, 0, 0, 0];
    for (const n of g.nodes) for (const l of n.links) kinds[l.kind]++;
    const off = g.spawnNodes.filter((i) => i < 0 || !g.nodes[i].core).length;
    if (off) errors++;
    console.log(
      `${pad(id, 14)} nodes ${pad(g.nodes.length, 5)} core ${pct(g.core.length / g.nodes.length).padEnd(5)}` +
        ` ${kinds.map((k, i) => `${LINK_NAMES[i]} ${k}`).join(' · ')}  build ${g.buildMs.toFixed(0)}ms` +
        (off ? `  ERROR ${off} spawn(s) off the core graph` : ''),
    );
  }
}

// ── shot resolution ──────────────────────────────────────────────────────────
function wallT(map: ArenaMap, o: Vec3, d: Vec3): number {
  let best = 200;
  for (const b of map.boxes) {
    const t = rayAabb(o, d, b);
    if (t !== null && t > 0 && t < best) best = t;
  }
  return best;
}
const boxOf = (p: Vec3, r: number): AABB => ({
  min: { x: p.x - r, y: p.y, z: p.z - r },
  max: { x: p.x + r, y: p.y + BOT_HEIGHT, z: p.z + r },
});

// ── brawl ────────────────────────────────────────────────────────────────────
type SimBot = {
  brain: BotBrain;
  diff: BotDifficulty;
  alive: boolean;
  respawn: number;
  frags: number;
  deaths: number;
  hits: number;
  moving: number;
  ticks: number;
  cells: Set<number>;
};

function brawl() {
  console.log(`\n== brawl (${SECS}s per map, 6 bots FFA) ==`);
  const agg: Record<BotDifficulty, { frags: number; deaths: number; shots: number; hits: number; stuck: number; ok: number; fail: number; moving: number; ticks: number; mins: number }> = {
    easy: { frags: 0, deaths: 0, shots: 0, hits: 0, stuck: 0, ok: 0, fail: 0, moving: 0, ticks: 0, mins: 0 },
    medium: { frags: 0, deaths: 0, shots: 0, hits: 0, stuck: 0, ok: 0, fail: 0, moving: 0, ticks: 0, mins: 0 },
    hard: { frags: 0, deaths: 0, shots: 0, hits: 0, stuck: 0, ok: 0, fail: 0, moving: 0, ticks: 0, mins: 0 },
  };
  const travOk = [0, 0, 0, 0, 0];
  const travFail = [0, 0, 0, 0, 0];
  for (const id of mapIds) {
    const map = MAPS.find((m) => m.id === id)?.map;
    if (!map) continue;
    const nav = navFor(map);
    const bots: SimBot[] = [];
    const diffs: BotDifficulty[] = ['easy', 'easy', 'medium', 'medium', 'hard', 'hard'];
    diffs.forEach((diff, i) => {
      const spot = pickSpawnPoint(map, bots.map((b) => b.brain.pos));
      const brain = new BotBrain(`b${i}`, spot, diff);
      brain.respawn(spot, map);
      bots.push({ brain, diff, alive: true, respawn: 0, frags: 0, deaths: 0, hits: 0, moving: 0, ticks: 0, cells: new Set() });
    });
    const ticks = Math.round(SECS / TICK_DT);
    let bad = 0;
    for (const b of bots) b.brain.stats.travOkKind.fill(0);
    for (let t = 0; t < ticks; t++) {
      const enemies: BotTarget[] = bots.filter((b) => b.alive).map((b) => ({ id: b.brain.id, pos: b.brain.pos, team: null }));
      const shots: { b: SimBot; s: BotShot }[] = [];
      for (const b of bots) {
        if (!b.alive) {
          b.respawn -= TICK_DT;
          if (b.respawn <= 0) {
            const spot = pickSpawnPoint(map, bots.filter((o) => o.alive).map((o) => o.brain.pos));
            b.brain.respawn(spot, map);
            b.alive = true;
          }
          continue;
        }
        const shot = b.brain.step(TICK_DT, map, enemies);
        if (shot) shots.push({ b, s: shot });
        const p = b.brain.pos;
        if (!Number.isFinite(p.x + p.y + p.z) || p.y < -3) {
          bad++;
          b.brain.respawn(pickSpawnPoint(map, []), map);
        }
        b.ticks++;
        if (Math.hypot(b.brain.vel.x, b.brain.vel.z) > 1) b.moving++;
        b.cells.add(Math.floor(p.x / 8) * 1000 + Math.floor(p.z / 8) + Math.round(p.y / 3) * 1e6);
      }
      for (const { b, s } of shots) {
        const wt = wallT(map, s.origin, s.dir);
        let hit: SimBot | null = null;
        let best = wt;
        for (const o of bots) {
          if (o === b || !o.alive) continue;
          const tt = rayAabb(s.origin, s.dir, boxOf(o.brain.pos, BOT_RADIUS));
          if (tt !== null && tt > 0 && tt < best) {
            best = tt;
            hit = o;
          }
        }
        const end = { x: s.origin.x + s.dir.x * best, y: s.origin.y + s.dir.y * best, z: s.origin.z + s.dir.z * best };
        for (const o of bots) if (o.alive) o.brain.hearShot(s.origin, end, b.brain.id, null);
        if (hit) {
          b.hits++;
          b.frags++;
          hit.deaths++;
          hit.alive = false;
          hit.respawn = 1.5;
        }
      }
    }
    for (const b of bots) {
      b.brain.stats.travOkKind.forEach((v, k) => (travOk[k] += v));
      b.brain.stats.travFailKind.forEach((v, k) => (travFail[k] += v));
    }
    if (bad) {
      errors++;
      console.log(`${id}: ERROR ${bad} NaN/out-of-world resets`);
    }
    const mins = SECS / 60;
    const coverTotal = new Set(nav.core.map((i) => {
      const n = nav.nodes[i];
      return Math.floor(n.x / 8) * 1000 + Math.floor(n.z / 8) + Math.round(n.y / 3) * 1e6;
    })).size;
    const line: string[] = [];
    for (const d of DIFFS) {
      const bs = bots.filter((b) => b.diff === d);
      const a = agg[d];
      const shotsN = bs.reduce((s, b) => s + b.brain.stats.shots, 0);
      const hits = bs.reduce((s, b) => s + b.hits, 0);
      const frags = bs.reduce((s, b) => s + b.frags, 0);
      const deaths = bs.reduce((s, b) => s + b.deaths, 0);
      const stuck = bs.reduce((s, b) => s + b.brain.stats.stuckSec, 0);
      const ok = bs.reduce((s, b) => s + b.brain.stats.travOk, 0);
      const fail = bs.reduce((s, b) => s + b.brain.stats.travFail, 0);
      const moving = bs.reduce((s, b) => s + b.moving, 0);
      const tks = bs.reduce((s, b) => s + b.ticks, 0);
      const cover = new Set(bs.flatMap((b) => [...b.cells])).size / coverTotal;
      Object.assign(a, {
        frags: a.frags + frags, deaths: a.deaths + deaths, shots: a.shots + shotsN, hits: a.hits + hits,
        stuck: a.stuck + stuck, ok: a.ok + ok, fail: a.fail + fail, moving: a.moving + moving, ticks: a.ticks + tks, mins: a.mins + mins * bs.length,
      });
      line.push(
        `${d[0].toUpperCase()} k/m ${f1(frags / mins / bs.length)} d/m ${f1(deaths / mins / bs.length)} acc ${pct(hits / Math.max(1, shotsN))}` +
          ` stuck ${f1(stuck / mins / bs.length)}s/m trav ${ok}/${ok + fail} mov ${pct(moving / Math.max(1, tks))} cov ${pct(cover)}`,
      );
    }
    console.log(`${pad(id, 14)} ${line.join(' | ')}`);
  }
  console.log('— totals —');
  console.log(`traversal ok/fail by kind: ${LINK_NAMES.map((n, k) => `${n} ${travOk[k]}/${travFail[k]}`).join(' · ')}`);
  for (const d of DIFFS) {
    const a = agg[d];
    console.log(
      `${pad(d, 7)} frags/min ${f1(a.frags / a.mins)}  deaths/min ${f1(a.deaths / a.mins)}  acc ${pct(a.hits / Math.max(1, a.shots))}` +
        `  stuck ${f1(a.stuck / a.mins)}s/min  traversals ${pct(a.ok / Math.max(1, a.ok + a.fail))} of ${a.ok + a.fail}  moving ${pct(a.moving / Math.max(1, a.ticks))}`,
    );
  }
}

// ── aim calibration ──────────────────────────────────────────────────────────
const OPEN: ArenaMap = (() => {
  const { boxes, bounds } = shell(70, 70, 24);
  return { name: 'open', boxes, bounds, spawn: spawnAt(0, 0), spawns: [spawnAt(-40, 0), spawnAt(40, 0), spawnAt(0, -40), spawnAt(0, 40)] };
})();

// A scripted human: runs across the bot's line at run speed — mixing quick
// ADAD reversals with longer runs down a lane, the odd hop and dash (or
// stands still).
class Dummy {
  pos: Vec3;
  private vx = 0;
  private vy = 0;
  private dir = 1;
  private flip = 0.5;
  private dash = 0;
  private readonly anchor: Vec3;
  constructor(p: Vec3, private readonly strafe: boolean, private readonly axis: { x: number; z: number }) {
    this.pos = { ...p };
    this.anchor = { ...p };
  }
  step(dt: number) {
    if (!this.strafe) return;
    this.flip -= dt;
    const off = (this.pos.x - this.anchor.x) * this.axis.x + (this.pos.z - this.anchor.z) * this.axis.z;
    if (this.flip <= 0 || Math.abs(off) > 9) {
      this.dir = Math.abs(off) > 9 ? -Math.sign(off) : -this.dir;
      this.flip = Math.random() < 0.5 ? 0.25 + Math.random() * 0.5 : 0.8 + Math.random() * 1.2;
      if (Math.random() < 0.15) this.dash = 0.15;
    }
    const target = this.dir * (this.dash > 0 ? 22 : 9);
    this.dash = Math.max(0, this.dash - dt);
    this.vx += (target - this.vx) * (1 - Math.exp(-14 * dt));
    if (this.pos.y <= 0.001 && Math.random() < dt * 0.8) this.vy = 9;
    this.vy -= 25 * dt;
    this.pos.x += this.axis.x * this.vx * dt;
    this.pos.z += this.axis.z * this.vx * dt;
    this.pos.y = Math.max(0, this.pos.y + this.vy * dt);
    if (this.pos.y === 0) this.vy = Math.max(0, this.vy);
  }
}

// The pre-overhaul aim model (smoothed aim point + speed-scaled error cone).
const OLD = {
  easy: { reaction: 0.75, aimError: 0.05, moveErr: 0.022, aimTrack: 5, whiff: 0.18, cd: 2.2 },
  medium: { reaction: 0.4, aimError: 0.028, moveErr: 0.009, aimTrack: 13, whiff: 0.06, cd: 1.6 },
  hard: { reaction: 0.26, aimError: 0.019, moveErr: 0.008, aimTrack: 22, whiff: 0.06, cd: 1.35 },
};
const tri = (m: number) => (Math.random() + Math.random() - 1) * m;

function aimTrial(diff: BotDifficulty, range: number, strafe: boolean, old: boolean): { hits: number; shots: number; first: number } {
  const secs = 40;
  const botPos = spawnAt(0, 0);
  const d = new Dummy({ x: 0, y: 0, z: range }, strafe, { x: 1, z: 0 });
  let hits = 0;
  let shots = 0;
  let first = -1;
  const eyeY = BOT_HEIGHT * 0.85;
  if (old) {
    const o = OLD[diff];
    let seen = 0;
    let cd = 0;
    const aim = { x: d.pos.x, y: d.pos.y + 0.9, z: d.pos.z };
    let last = { ...d.pos };
    let lat = 0;
    for (let t = 0; t < secs / TICK_DT; t++) {
      d.step(TICK_DT);
      seen += TICK_DT;
      cd = Math.max(0, cd - TICK_DT);
      const tc = { x: d.pos.x, y: d.pos.y + 0.9, z: d.pos.z };
      const k = 1 - Math.exp(-o.aimTrack * TICK_DT);
      aim.x += (tc.x - aim.x) * k;
      aim.y += (tc.y - aim.y) * k;
      aim.z += (tc.z - aim.z) * k;
      const lv = Math.abs(d.pos.x - last.x) / TICK_DT;
      lat = lat * 0.6 + lv * 0.4;
      last = { ...d.pos };
      if (seen >= o.reaction && cd <= 0) {
        cd = o.cd * (0.85 + Math.random() * 0.3);
        const eye = { x: botPos.x, y: eyeY, z: botPos.z };
        let dx = aim.x - eye.x;
        let dy = aim.y - eye.y;
        let dz = aim.z - eye.z;
        const l = Math.hypot(dx, dy, dz);
        dx /= l;
        dy /= l;
        dz /= l;
        let e = o.aimError + o.moveErr * lat;
        if (Math.random() < o.whiff) e *= 4.5;
        dx += tri(e);
        dy += tri(e);
        dz += tri(e);
        const l2 = Math.hypot(dx, dy, dz);
        shots++;
        if (first < 0) first = t * TICK_DT;
        if (rayAabb(eye, { x: dx / l2, y: dy / l2, z: dz / l2 }, boxOf(d.pos, PLAYER_RADIUS)) !== null) hits++;
      }
    }
    return { hits, shots, first };
  }
  const brain = new BotBrain('aim', botPos, diff);
  brain.respawn(botPos, OPEN);
  brain.yaw = 0; // facing the dummy (+z)
  for (let t = 0; t < secs / TICK_DT; t++) {
    d.step(TICK_DT);
    const shot = brain.step(TICK_DT, OPEN, [{ id: 'dummy', pos: d.pos, team: null }]);
    if (shot) {
      shots++;
      if (first < 0) first = t * TICK_DT;
      if (rayAabb(shot.origin, shot.dir, boxOf(d.pos, PLAYER_RADIUS)) !== null) hits++;
    }
  }
  return { hits, shots, first };
}

function aimReport() {
  console.log('\n== aim (hit rate per shot; strafer = ADAD at 9 m/s with hops) ==');
  const ranges = [12, 22, 35];
  const runs = 6;
  for (const old of [true, false]) {
    console.log(old ? '-- old model --' : '-- new model --');
    for (const diff of DIFFS) {
      const parts: string[] = [];
      for (const strafe of [false, true]) {
        for (const r of ranges) {
          let h = 0;
          let s = 0;
          let first = 0;
          for (let k = 0; k < runs; k++) {
            const res = aimTrial(diff, r, strafe, old);
            h += res.hits;
            s += res.shots;
            first += res.first;
          }
          parts.push(`${strafe ? 'strafe' : 'still'}@${r} ${pct(h / Math.max(1, s)).padStart(4)}${strafe ? '' : ` (1st ${(first / runs).toFixed(2)}s)`}`);
        }
      }
      console.log(`${pad(diff, 7)} ${parts.join('  ')}`);
    }
  }
}

if (mode === 'nav' || mode === 'all') navReport();
if (mode === 'aim' || mode === 'all') aimReport();
if (mode === 'brawl' || mode === 'all') brawl();
if (errors) {
  console.log(`\n${errors} ERROR(s)`);
  process.exit(1);
}
