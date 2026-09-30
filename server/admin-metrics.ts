// Admin dashboard metrics beyond the basics in db.ts: economy health (faucets
// vs sinks, case opens, market, trades, mint mix, what's held), engagement
// (DAU/WAU/MAU, matches by mode, guest share, hour-of-day, top players),
// weekly retention cohorts, sampled concurrency, and the admin player search.
//
// Everything reads data we already keep — the audit log (indexed on
// (event, ts)), instagib_items / instagib_users / instagib_stats. Date ranges
// are clamped (≤ 90 days, ≤ 12 cohort weeks) so every query is an index range
// or a bounded GROUP BY on a small Railway box. All SQL is parameterized.

import type { Statement } from 'better-sqlite3';
import { sqlite } from './sqlite';
import { itemDef } from '../src/game/items/catalog';
import { TIERS, type Tier } from '../src/game/items/types';
import { CREDITS_PER_XP } from '../src/game/progression';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const dayIndex = (ts: number): number => Math.floor(ts / DAY_MS);
const dayISO = (d: number): string => new Date(d * DAY_MS).toISOString().slice(0, 10);
const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));

// Lazy statement cache (the tables live in other modules' schema blocks, which
// have run by the time a request arrives).
const cache = new Map<string, Statement<unknown[]>>();
function st(sql: string): Statement<unknown[]> {
  let s = cache.get(sql);
  if (!s) {
    s = sqlite.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

// Mint-mix queries range over instagib_items.created_at; one additive index keeps
// that a range scan instead of a table scan. Created lazily on first use.
let itemsIndexed = false;
function ensureItemsIndex(): void {
  if (itemsIndexed) return;
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_items_created ON instagib_items(created_at)`);
  itemsIndexed = true;
}

const tierOfDef = (def: string, override: unknown): Tier =>
  typeof override === 'string' && (TIERS as readonly string[]).includes(override) ? (override as Tier) : itemDef(def)?.tier ?? 'common';

// ── Player search (the admin player combobox) ───────────────────────────────
export type AdminPlayerHit = {
  id: string;
  userName: string;
  level: number;
  admin: boolean;
  verified: boolean;
  createdAt: number;
  lastSeen: number;
  credits: number;
  freeRolls: number;
  items: number; // owned + listed instances
  games: number;
  kills: number;
  deaths: number;
  wins: number;
};
type HitRow = {
  id: string;
  username: string;
  created_at: number;
  is_admin: number;
  is_verified: number;
  level: number;
  credits: number;
  rolls: number;
  games: number;
  kills: number;
  deaths: number;
  wins: number;
  last_seen: number;
  items: number;
};
const HIT_COLS = `u.id, u.username, u.created_at, u.is_admin, u.is_verified,
  COALESCE(s.level, 1) AS level, COALESCE(s.credits, 0) AS credits, COALESCE(s.free_rolls, 0) AS rolls,
  COALESCE(s.total_games, 0) AS games, COALESCE(s.total_kills, 0) AS kills, COALESCE(s.total_deaths, 0) AS deaths,
  COALESCE(s.total_wins, 0) AS wins, MAX(COALESCE(s.updated_at, 0), u.created_at) AS last_seen,
  (SELECT COUNT(*) FROM instagib_items i WHERE i.owner_id = u.id AND i.state IN ('owned','listed')) AS items`;
const toHit = (r: HitRow): AdminPlayerHit => ({
  id: r.id,
  userName: r.username,
  level: r.level,
  admin: !!r.is_admin,
  verified: !!r.is_verified,
  createdAt: r.created_at,
  lastSeen: r.last_seen,
  credits: r.credits,
  freeRolls: r.rolls,
  items: r.items,
  games: r.games,
  kills: r.kills,
  deaths: r.deaths,
  wins: r.wins,
});
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// Accounts (not just players with games — a fresh signup must be findable to
// gift). Exact name first, then prefix matches, then substring, newest-seen first.
// An empty query lists the most recently seen accounts.
export function searchPlayers(qRaw: string, limitRaw: number): AdminPlayerHit[] {
  const limit = clampInt(limitRaw, 1, 50);
  const q = qRaw.trim().toLowerCase().slice(0, 40);
  if (!q) {
    return (
      st(`SELECT ${HIT_COLS} FROM instagib_users u LEFT JOIN instagib_stats s ON s.player_id = u.id
           ORDER BY last_seen DESC LIMIT ?`).all(limit) as HitRow[]
    ).map(toHit);
  }
  const e = likeEscape(q);
  return (
    st(`SELECT ${HIT_COLS} FROM instagib_users u LEFT JOIN instagib_stats s ON s.player_id = u.id
         WHERE u.username_lower LIKE ? ESCAPE '\\' OR u.id = ?
         ORDER BY (u.username_lower = ?) DESC, (u.username_lower LIKE ? ESCAPE '\\') DESC, last_seen DESC
         LIMIT ?`).all(`%${e}%`, qRaw.trim(), q, `${e}%`, limit) as HitRow[]
  ).map(toHit);
}

// One account's card, by id or username (case-insensitive).
export function playerCard(key: string): AdminPlayerHit | null {
  const k = key.trim();
  if (!k) return null;
  const r = st(`SELECT ${HIT_COLS} FROM instagib_users u LEFT JOIN instagib_stats s ON s.player_id = u.id
                 WHERE u.id = ? OR u.username_lower = ? LIMIT 1`).get(k, k.toLowerCase()) as HitRow | undefined;
  return r ? toHit(r) : null;
}

// ── Economy health ──────────────────────────────────────────────────────────
export type EconFlows = {
  faucet: number; // credits created: match payouts (est.) + salvage + codes/gifts + admin grants
  sink: number; // credits destroyed: case opens + listing fees + sale tax
  matchPayout: number;
  salvage: number;
  rewards: number;
  grants: number;
  caseSpend: number;
  listingFees: number;
  saleTax: number;
  caseOpens: number;
  marketSales: number;
  marketVolume: number;
  trades: number;
  minted: number;
};
export type EconDay = EconFlows & { date: string; cases: Record<string, number> };
export type EconomyMetrics = {
  days: number;
  held: {
    credits: number;
    rolls: number;
    holders: number; // accounts with a positive balance
    items: number; // owned + listed
    listed: number;
    anomalous: number;
    tracked: number;
    killstreak: number;
    festive: number;
    staffMade: number; // admin one-offs (custom name / tint / tier)
  };
  cur: EconFlows;
  prev: EconFlows;
  series: EconDay[];
  mintedByOrigin: { origin: string; n: number }[];
  mintedByTier: { tier: Tier; n: number }[];
  heldByTier: { tier: Tier; n: number }[];
  topHeld: { def: string; n: number; anomalous: number }[];
};

const emptyFlows = (): EconFlows => ({
  faucet: 0,
  sink: 0,
  matchPayout: 0,
  salvage: 0,
  rewards: 0,
  grants: 0,
  caseSpend: 0,
  listingFees: 0,
  saleTax: 0,
  caseOpens: 0,
  marketSales: 0,
  marketVolume: 0,
  trades: 0,
  minted: 0,
});

type DayN = { d: number; n: number; v?: number };

// Daily economy flows from the audit log over [from, to). Each query is an
// (event, ts) index range with a GROUP BY day.
function econDaily(from: number, to: number): Map<number, EconDay> {
  const days = new Map<number, EconDay>();
  const at = (d: number): EconDay => {
    let x = days.get(d);
    if (!x) {
      x = { ...emptyFlows(), date: dayISO(d), cases: {} };
      days.set(d, x);
    }
    return x;
  };
  const byDay = (event: string, expr: string, extra = '') =>
    st(`SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n, COALESCE(SUM(${expr}), 0) AS v
          FROM instagib_audit WHERE event = ? AND ts >= ? AND ts < ? ${extra} GROUP BY d`).all(event, from, to) as DayN[];

  // Match payouts: credits = floor(xp × CREDITS_PER_XP) per account match (guests earn nothing).
  for (const r of byDay('match', `CAST(COALESCE(json_extract(detail, '$.xp'), 0) * ${CREDITS_PER_XP} AS INTEGER)`, `AND actor_id <> ''`)) at(r.d).matchPayout += r.v ?? 0;
  for (const r of byDay('item.salvage', `COALESCE(json_extract(detail, '$.gained'), 0)`)) at(r.d).salvage += r.v ?? 0;
  for (const ev of ['code.redeem', 'inbox.claim']) for (const r of byDay(ev, `COALESCE(json_extract(detail, '$.credits'), 0)`)) at(r.d).rewards += r.v ?? 0;
  for (const r of byDay('admin.grant_econ', `MAX(COALESCE(json_extract(detail, '$.credits'), 0), 0)`)) at(r.d).grants += r.v ?? 0;
  for (const r of byDay('market.list', `COALESCE(json_extract(detail, '$.fee'), 0)`)) at(r.d).listingFees += r.v ?? 0;
  for (const r of byDay('market.sale', `COALESCE(json_extract(detail, '$.tax'), 0)`)) {
    const x = at(r.d);
    x.saleTax += r.v ?? 0;
    x.marketSales += r.n;
  }
  for (const r of byDay('market.sale', `COALESCE(json_extract(detail, '$.price'), 0)`)) at(r.d).marketVolume += r.v ?? 0;
  for (const r of byDay('trade.accept', '0')) at(r.d).trades += r.n;
  // Case opens, split by case.
  const cases = st(`SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, json_extract(detail, '$.case') AS c, COUNT(*) AS n,
                           COALESCE(SUM(json_extract(detail, '$.cost')), 0) AS v
                      FROM instagib_audit WHERE event = 'case.open' AND ts >= ? AND ts < ? GROUP BY d, c`).all(from, to) as (DayN & { c: string | null })[];
  for (const r of cases) {
    const x = at(r.d);
    x.caseOpens += r.n;
    x.caseSpend += r.v ?? 0;
    const k = r.c ?? 'unknown';
    x.cases[k] = (x.cases[k] ?? 0) + r.n;
  }
  ensureItemsIndex();
  const minted = st(`SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n FROM instagib_items
                      WHERE created_at >= ? AND created_at < ? AND origin <> 'legacy' GROUP BY d`).all(from, to) as DayN[];
  for (const r of minted) at(r.d).minted += r.n;
  for (const x of days.values()) {
    x.faucet = x.matchPayout + x.salvage + x.rewards + x.grants;
    x.sink = x.caseSpend + x.listingFees + x.saleTax;
  }
  return days;
}

function sumFlows(days: Iterable<EconFlows>): EconFlows {
  const out = emptyFlows();
  for (const d of days) for (const k of Object.keys(out) as (keyof EconFlows)[]) out[k] += d[k];
  return out;
}

export function getEconomyMetrics(daysRaw: number, now = Date.now()): EconomyMetrics {
  const days = clampInt(daysRaw, 7, 90);
  const today = dayIndex(now);
  const start = today - (days - 1);
  const from = start * DAY_MS;
  const to = (today + 1) * DAY_MS;
  const cur = econDaily(from, to);
  const prev = econDaily(from - days * DAY_MS, from);
  const series: EconDay[] = [];
  for (let d = start; d <= today; d++) series.push(cur.get(d) ?? { ...emptyFlows(), date: dayISO(d), cases: {} });

  const bal = st(`SELECT COALESCE(SUM(credits), 0) AS c, COALESCE(SUM(free_rolls), 0) AS r,
                         SUM(CASE WHEN credits > 0 THEN 1 ELSE 0 END) AS h FROM instagib_stats`).get() as { c: number; r: number; h: number | null };

  // What's held right now: one grouped pass over live items (def × quality × tier override).
  const held = st(`SELECT def, quality, json_extract(attrs, '$.tier') AS t, state, COUNT(*) AS n
                     FROM instagib_items WHERE state IN ('owned','listed') GROUP BY def, quality, t, state`).all() as {
    def: string;
    quality: string;
    t: unknown;
    state: string;
    n: number;
  }[];
  const heldTier = new Map<Tier, number>();
  const byDef = new Map<string, { n: number; anomalous: number }>();
  const h = { items: 0, listed: 0, anomalous: 0, tracked: 0, killstreak: 0, festive: 0, staffMade: 0 };
  for (const r of held) {
    const q = r.quality;
    h.items += r.n;
    if (r.state === 'listed') h.listed += r.n;
    const isAnom = q.includes('"unusual"');
    if (isAnom) h.anomalous += r.n;
    if (q.includes('"strange"')) h.tracked += r.n;
    if (q.includes('"killstreak"')) h.killstreak += r.n;
    if (q.includes('"festive"')) h.festive += r.n;
    if (q.includes('"admin"')) h.staffMade += r.n;
    const tier = tierOfDef(r.def, r.t);
    heldTier.set(tier, (heldTier.get(tier) ?? 0) + r.n);
    const e = byDef.get(r.def) ?? { n: 0, anomalous: 0 };
    e.n += r.n;
    if (isAnom) e.anomalous += r.n;
    byDef.set(r.def, e);
  }

  ensureItemsIndex();
  const mintRows = st(`SELECT def, origin, json_extract(attrs, '$.tier') AS t, COUNT(*) AS n FROM instagib_items
                        WHERE created_at >= ? AND origin <> 'legacy' GROUP BY def, origin, t`).all(from) as { def: string; origin: string; t: unknown; n: number }[];
  const byOrigin = new Map<string, number>();
  const mintTier = new Map<Tier, number>();
  for (const r of mintRows) {
    byOrigin.set(r.origin, (byOrigin.get(r.origin) ?? 0) + r.n);
    const t = tierOfDef(r.def, r.t);
    mintTier.set(t, (mintTier.get(t) ?? 0) + r.n);
  }

  return {
    days,
    held: { credits: bal.c, rolls: bal.r, holders: bal.h ?? 0, ...h },
    cur: sumFlows(series),
    prev: sumFlows(prev.values()),
    series,
    mintedByOrigin: [...byOrigin].map(([origin, n]) => ({ origin, n })).sort((a, b) => b.n - a.n),
    mintedByTier: TIERS.map((tier) => ({ tier, n: mintTier.get(tier) ?? 0 })),
    heldByTier: TIERS.map((tier) => ({ tier, n: heldTier.get(tier) ?? 0 })),
    topHeld: [...byDef]
      .map(([def, v]) => ({ def, ...v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
  };
}

// ── Engagement ──────────────────────────────────────────────────────────────
export type EngagementTotals = { matches: number; onlineMatches: number; guestMatches: number; players: number; newAccounts: number; logins: number };
export type EngagementDay = { date: string; dau: number; matches: number; guest: number; newAccounts: number; modes: Record<string, number> };
export type EngagementMetrics = {
  days: number;
  dau: number;
  wau: number;
  mau: number;
  cur: EngagementTotals;
  prev: EngagementTotals;
  series: EngagementDay[];
  modes: { mode: string; n: number }[];
  hours: number[]; // matches by UTC hour of day, over the range
  topPlayers: { id: string; name: string; matches: number; wins: number; kills: number; deaths: number }[];
};

const MODE_KEY = `CASE WHEN json_extract(detail, '$.offline') = 1 THEN 'practice' ELSE COALESCE(json_extract(detail, '$.mode'), 'unknown') END`;

function activeSince(from: number, to: number): number {
  return (
    st(`SELECT COUNT(DISTINCT actor_id) AS n FROM instagib_audit
         WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ? AND ts < ?`).get(from, to) as { n: number }
  ).n;
}

function engagementTotals(from: number, to: number): EngagementTotals {
  const m = st(`SELECT COUNT(*) AS n,
                       SUM(CASE WHEN COALESCE(json_extract(detail, '$.offline'), 0) = 1 THEN 0 ELSE 1 END) AS online,
                       SUM(CASE WHEN actor_id = '' THEN 1 ELSE 0 END) AS guest
                  FROM instagib_audit WHERE event = 'match' AND ts >= ? AND ts < ?`).get(from, to) as { n: number; online: number | null; guest: number | null };
  const logins = (st(`SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'login' AND ts >= ? AND ts < ?`).get(from, to) as { n: number }).n;
  const regs = (st(`SELECT COUNT(*) AS n FROM instagib_users WHERE created_at >= ? AND created_at < ?`).get(from, to) as { n: number }).n;
  return { matches: m.n, onlineMatches: m.online ?? 0, guestMatches: m.guest ?? 0, players: activeSince(from, to), newAccounts: regs, logins };
}

export function getEngagementMetrics(daysRaw: number, now = Date.now()): EngagementMetrics {
  const days = clampInt(daysRaw, 7, 90);
  const today = dayIndex(now);
  const start = today - (days - 1);
  const from = start * DAY_MS;
  const to = (today + 1) * DAY_MS;

  const dauRows = st(`SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(DISTINCT actor_id) AS n FROM instagib_audit
                       WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ? GROUP BY d`).all(from) as DayN[];
  const modeRows = st(`SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, ${MODE_KEY} AS m, COUNT(*) AS n,
                              SUM(CASE WHEN actor_id = '' THEN 1 ELSE 0 END) AS v
                         FROM instagib_audit WHERE event = 'match' AND ts >= ? GROUP BY d, m`).all(from) as (DayN & { m: string })[];
  const regRows = st(`SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n FROM instagib_users WHERE created_at >= ? GROUP BY d`).all(from) as DayN[];
  const hourRows = st(`SELECT CAST((ts % ${DAY_MS}) / 3600000 AS INTEGER) AS h, COUNT(*) AS n FROM instagib_audit
                        WHERE event = 'match' AND ts >= ? GROUP BY h`).all(from) as { h: number; n: number }[];
  const top = st(`SELECT actor_id AS id, MAX(actor_name) AS name, COUNT(*) AS matches,
                         SUM(CASE WHEN json_extract(detail, '$.won') = 1 THEN 1 ELSE 0 END) AS wins,
                         COALESCE(SUM(json_extract(detail, '$.kills')), 0) AS kills,
                         COALESCE(SUM(json_extract(detail, '$.deaths')), 0) AS deaths
                    FROM instagib_audit WHERE event = 'match' AND actor_id <> '' AND ts >= ?
                   GROUP BY actor_id ORDER BY matches DESC, kills DESC LIMIT 10`).all(from) as EngagementMetrics['topPlayers'];

  const map = new Map<number, EngagementDay>();
  const at = (d: number): EngagementDay => {
    let x = map.get(d);
    if (!x) {
      x = { date: dayISO(d), dau: 0, matches: 0, guest: 0, newAccounts: 0, modes: {} };
      map.set(d, x);
    }
    return x;
  };
  for (const r of dauRows) at(r.d).dau = r.n;
  const modeTotals = new Map<string, number>();
  for (const r of modeRows) {
    const x = at(r.d);
    x.matches += r.n;
    x.guest += r.v ?? 0;
    x.modes[r.m] = (x.modes[r.m] ?? 0) + r.n;
    modeTotals.set(r.m, (modeTotals.get(r.m) ?? 0) + r.n);
  }
  for (const r of regRows) at(r.d).newAccounts = r.n;
  const series: EngagementDay[] = [];
  for (let d = start; d <= today; d++) series.push(map.get(d) ?? { date: dayISO(d), dau: 0, matches: 0, guest: 0, newAccounts: 0, modes: {} });
  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of hourRows) if (r.h >= 0 && r.h < 24) hours[r.h] = r.n;

  return {
    days,
    dau: activeSince(now - DAY_MS, now + 1),
    wau: activeSince(now - 7 * DAY_MS, now + 1),
    mau: activeSince(now - 30 * DAY_MS, now + 1),
    cur: engagementTotals(from, to),
    prev: engagementTotals(from - days * DAY_MS, from),
    series,
    modes: [...modeTotals].map(([mode, n]) => ({ mode, n })).sort((a, b) => b.n - a.n),
    hours,
    topPlayers: top.map((t) => ({ ...t, name: t.name || 'Player' })),
  };
}

// ── Weekly retention cohorts ────────────────────────────────────────────────
// Rows = the week an account registered (weeks start on the UTC day `weeks`
// weeks ago, aligned to now); cols = weeks since signup (W0 … W(n-1)); a cell is
// the share of that cohort active (match or login) in that week. One grouped
// pass over the (event, ts) index range, joined to signups in memory.
export type Cohort = { start: string; size: number; active: number[] }; // active[k] = accounts active in week k
export function getWeeklyCohorts(weeksRaw: number, now = Date.now()): { weeks: number; cohorts: Cohort[] } {
  const weeks = clampInt(weeksRaw, 2, 12);
  const origin = (dayIndex(now) + 1) * DAY_MS - weeks * WEEK_MS; // start of cohort week 0
  const users = st(`SELECT id, created_at FROM instagib_users WHERE created_at >= ?`).all(origin) as { id: string; created_at: number }[];
  const cohortOf = new Map<string, { c: number; t: number }>();
  const cohorts: Cohort[] = Array.from({ length: weeks }, (_, i) => ({
    start: new Date(origin + i * WEEK_MS).toISOString().slice(0, 10),
    size: 0,
    active: Array.from({ length: weeks - i }, () => 0),
  }));
  for (const u of users) {
    const c = Math.floor((u.created_at - origin) / WEEK_MS);
    if (c < 0 || c >= weeks) continue;
    cohorts[c].size += 1;
    cohortOf.set(u.id, { c, t: u.created_at });
  }
  if (cohortOf.size) {
    const act = st(`SELECT actor_id AS id, CAST((ts - ?) / ${WEEK_MS} AS INTEGER) AS w FROM instagib_audit
                     WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ? GROUP BY actor_id, w`).all(origin, origin) as { id: string; w: number }[];
    for (const r of act) {
      const u = cohortOf.get(r.id);
      if (!u) continue;
      const k = r.w - u.c; // weeks since the signup week
      if (k >= 0 && k < cohorts[u.c].active.length) cohorts[u.c].active[k] += 1;
    }
  }
  return { weeks, cohorts };
}

// ── Concurrency sampler ─────────────────────────────────────────────────────
// Online/in-match counts only exist live, so sample them once a minute into an
// in-memory ring (24 h). Resets on deploy — the dashboard says so.
type Live = { online: number; inMatch: number; rooms: number };
export type ConcurrencySample = { ts: number; online: number; inMatch: number; rooms: number };
const RING = 24 * 60;
const samples: ConcurrencySample[] = [];
let peak: ConcurrencySample | null = null;
let sampler: ReturnType<typeof setInterval> | null = null;
const bootAt = Date.now();

export function startConcurrencySampler(source: () => Live): void {
  if (sampler) clearInterval(sampler);
  const take = () => {
    try {
      const l = source();
      const s = { ts: Date.now(), online: l.online, inMatch: l.inMatch, rooms: l.rooms };
      samples.push(s);
      if (samples.length > RING) samples.splice(0, samples.length - RING);
      if (!peak || s.online > peak.online) peak = s;
    } catch {
      /* the socket isn't up yet — skip this tick */
    }
  };
  take();
  sampler = setInterval(take, 60_000);
  sampler.unref?.();
}

export function getConcurrency(): { since: number; samples: ConcurrencySample[]; peak: ConcurrencySample | null; peak24h: ConcurrencySample | null } {
  const cutoff = Date.now() - DAY_MS;
  let p24: ConcurrencySample | null = null;
  for (const s of samples) if (s.ts >= cutoff && (!p24 || s.online > p24.online)) p24 = s;
  // Downsample to ≤ 288 points (5-minute max buckets) for the wire.
  const out: ConcurrencySample[] = [];
  const step = Math.max(1, Math.ceil(samples.length / 288));
  for (let i = 0; i < samples.length; i += step) {
    const slice = samples.slice(i, i + step);
    out.push(slice.reduce((a, b) => (b.online > a.online ? b : a)));
  }
  return { since: bootAt, samples: out, peak, peak24h: p24 };
}
