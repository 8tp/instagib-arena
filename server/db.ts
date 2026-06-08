// SQLite-backed stats store. Self-contained: no ORM, just better-sqlite3 with
// prepared statements. The table is created on first import (CREATE TABLE IF
// NOT EXISTS), so there are no migrations to run.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import {
  baseMatchXp,
  creditsForXp,
  levelForXp,
  levelProgress,
  OFFLINE_XP_SCALE,
  PER_MATCH_XP_CAP,
  XP_FIRST_WIN_BONUS,
} from '../src/game/progression';
import {
  ALL_COSMETICS,
  caseHats,
  cosmeticById,
  defaultUnlockedIds,
  DUPE_REFUND_FRAC,
  HAT_CASE_COST,
  levelGrantsAt,
  RARITY_WEIGHT,
  slotOf,
  titleGrantsFrom,
} from '../src/game/cosmetics';
import {
  activeChallenges,
  challengeById,
  DAILY_CHALLENGES,
  DAILY_COUNT,
  dailyPeriod,
  WEEKLY_CHALLENGES,
  WEEKLY_COUNT,
  weeklyPeriod,
  type ChallengeDef,
  type ChallengeMetric,
} from '../src/game/challenges';

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'instagib.sqlite');

const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');

sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_stats (
  player_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  total_kills INTEGER NOT NULL DEFAULT 0,
  total_deaths INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  best_kill_streak INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0,
  shots_fired INTEGER NOT NULL DEFAULT 0,
  shots_hit INTEGER NOT NULL DEFAULT 0,
  best_accuracy REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instagib_stats_kills ON instagib_stats(total_kills);

-- Per-window (daily/weekly) leaderboard buckets. Same shape as instagib_stats but
-- keyed by a period string ("d:YYYYMMDD" / "w:YYYYMMDD" of the week's Monday, UTC),
-- upserted alongside the all-time row on every recorded match.
CREATE TABLE IF NOT EXISTS instagib_period_stats (
  player_id        TEXT NOT NULL,
  period_key       TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  total_kills      INTEGER NOT NULL DEFAULT 0,
  total_deaths     INTEGER NOT NULL DEFAULT 0,
  total_games      INTEGER NOT NULL DEFAULT 0,
  total_wins       INTEGER NOT NULL DEFAULT 0,
  best_kill_streak INTEGER NOT NULL DEFAULT 0,
  headshots        INTEGER NOT NULL DEFAULT 0,
  best_accuracy    REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (player_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_period_kills ON instagib_period_stats(period_key, total_kills);

-- Registered accounts. Progression keys off the account id (= instagib_stats
-- player_id), so guests (no account) accrue nothing. Passwords are scrypt-hashed
-- with a per-user salt (see server/auth.ts). Email is optional, recovery-only.
CREATE TABLE IF NOT EXISTS instagib_users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  pw_hash        TEXT NOT NULL,
  pw_salt        TEXT NOT NULL,
  email          TEXT,
  created_at     INTEGER NOT NULL
);
-- Opaque session tokens (httpOnly cookie) → account id. Revocable; reaped on logout.
CREATE TABLE IF NOT EXISTS instagib_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON instagib_sessions(user_id);
`);

// Additive progression columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, and we
// run no migration framework, so guard each add against the live schema
// (docs/progression.md §2). Safe to run on every boot.
function ensureColumns() {
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(instagib_stats)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) sqlite.exec(`ALTER TABLE instagib_stats ADD COLUMN ${ddl}`);
  };
  add('total_xp', 'total_xp INTEGER NOT NULL DEFAULT 0');
  add('level', 'level INTEGER NOT NULL DEFAULT 1');
  add('credits', 'credits INTEGER NOT NULL DEFAULT 0');
  add('unlocked', `unlocked TEXT NOT NULL DEFAULT '[]'`); // JSON array of cosmetic IDs
  add('equipped', `equipped TEXT NOT NULL DEFAULT '{}'`); // JSON map slot -> cosmetic ID
  add('first_win_day', 'first_win_day INTEGER NOT NULL DEFAULT 0'); // YYYYMMDD (UTC)
}
ensureColumns();

// Additive account-moderation columns on instagib_users (same no-migration
// pattern): is_admin gates the /api/admin actions + grants all cosmetics;
// is_verified drives the blue "verified player" check. Both default off.
function ensureUserColumns() {
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(instagib_users)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!cols.has('is_admin'))
    sqlite.exec(`ALTER TABLE instagib_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('is_verified'))
    sqlite.exec(`ALTER TABLE instagib_users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0`);
}
ensureUserColumns();

// Append-only audit log: account registrations, logins, recorded matches, and
// admin actions. Powers auditing now and a metrics dashboard later. `detail` is
// a small JSON blob; `ip` is best-effort (proxy-forwarded) for abuse triage.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  actor_id   TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  target_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON instagib_audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_event ON instagib_audit(event, ts);
`);

const insertAuditStmt = sqlite.prepare(`
  INSERT INTO instagib_audit (ts, event, actor_id, actor_name, target_id, detail, ip)
  VALUES (@ts, @event, @actorId, @actorName, @targetId, @detail, @ip)`);

export type AuditInput = {
  event: string;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  now?: number;
};

// Record an audit event. Never throws into the request path — a logging failure
// must not break a match submission or a login.
export function logEvent(e: AuditInput): void {
  try {
    insertAuditStmt.run({
      ts: e.now ?? Date.now(),
      event: e.event,
      actorId: e.actorId ?? '',
      actorName: e.actorName ?? '',
      targetId: e.targetId ?? '',
      detail:
        e.detail == null
          ? ''
          : typeof e.detail === 'string'
            ? e.detail.slice(0, 2000)
            : JSON.stringify(e.detail).slice(0, 2000),
      ip: (e.ip ?? '').slice(0, 64),
    });
  } catch (err) {
    console.error('[audit] log failed', err);
  }
}

export type AuditRow = {
  id: number;
  ts: number;
  event: string;
  actor_id: string;
  actor_name: string;
  target_id: string;
  detail: string;
  ip: string;
};
const auditAllStmt = sqlite.prepare(
  `SELECT * FROM instagib_audit ORDER BY ts DESC, id DESC LIMIT ?`,
);
const auditByEventStmt = sqlite.prepare(
  `SELECT * FROM instagib_audit WHERE event = ? ORDER BY ts DESC, id DESC LIMIT ?`,
);
export function getAuditLog(limit: number, event?: string): AuditRow[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return (event ? auditByEventStmt.all(event, n) : auditAllStmt.all(n)) as AuditRow[];
}

// Per-player challenge progress (Phase 2). Definitions live in code
// (src/game/challenges.ts); this only stores progress + claim state, keyed by
// (player, challenge, period) so each daily/weekly instance is independent.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_challenges (
  player_id  TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  period     TEXT NOT NULL,
  progress   INTEGER NOT NULL DEFAULT 0,
  goal       INTEGER NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, challenge, period)
);
`);

export type PublicStats = {
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
};

export const ZERO_STATS: PublicStats = {
  totalKills: 0,
  totalDeaths: 0,
  totalGames: 0,
  totalWins: 0,
  bestKillStreak: 0,
  headshots: 0,
  bestAccuracy: 0,
};

type Row = {
  total_kills: number;
  total_deaths: number;
  total_games: number;
  total_wins: number;
  best_kill_streak: number;
  headshots: number;
  best_accuracy: number;
};

const toPublic = (row: Row | undefined): PublicStats =>
  row
    ? {
        totalKills: row.total_kills,
        totalDeaths: row.total_deaths,
        totalGames: row.total_games,
        totalWins: row.total_wins,
        bestKillStreak: row.best_kill_streak,
        headshots: row.headshots,
        bestAccuracy: row.best_accuracy,
      }
    : { ...ZERO_STATS };

const selectStmt = sqlite.prepare(
  `SELECT total_kills, total_deaths, total_games, total_wins,
          best_kill_streak, headshots, best_accuracy
     FROM instagib_stats WHERE player_id = ?`,
);

// Atomic upsert: increments are applied in SQL (column + delta), not
// read-modify-write in JS, so two near-simultaneous POSTs for the same player
// can't clobber each other's deltas. RETURNING hands back the final row.
const upsertStmt = sqlite.prepare(`
INSERT INTO instagib_stats (
  player_id, user_name, total_kills, total_deaths, total_games, total_wins,
  best_kill_streak, headshots, shots_fired, shots_hit, best_accuracy,
  created_at, updated_at
) VALUES (
  @playerId, @userName, @kills, @deaths, 1, @wins,
  @bestStreak, @headshots, @shotsFired, @shotsHit, @accuracy,
  @now, @now
)
ON CONFLICT(player_id) DO UPDATE SET
  user_name        = excluded.user_name,
  total_kills      = total_kills + excluded.total_kills,
  total_deaths     = total_deaths + excluded.total_deaths,
  total_games      = total_games + 1,
  total_wins       = total_wins + excluded.total_wins,
  best_kill_streak = max(best_kill_streak, excluded.best_kill_streak),
  headshots        = headshots + excluded.headshots,
  shots_fired      = shots_fired + excluded.shots_fired,
  shots_hit        = shots_hit + excluded.shots_hit,
  best_accuracy    = max(best_accuracy, excluded.best_accuracy),
  updated_at       = excluded.updated_at
RETURNING total_kills, total_deaths, total_games, total_wins,
          best_kill_streak, headshots, best_accuracy
`);

// Per-period bucket upsert — same accumulation as the all-time row, keyed by period.
const periodUpsertStmt = sqlite.prepare(`
INSERT INTO instagib_period_stats (
  player_id, period_key, user_name, total_kills, total_deaths, total_games,
  total_wins, best_kill_streak, headshots, best_accuracy, updated_at
) VALUES (
  @playerId, @periodKey, @userName, @kills, @deaths, 1,
  @wins, @bestStreak, @headshots, @accuracy, @now
)
ON CONFLICT(player_id, period_key) DO UPDATE SET
  user_name        = excluded.user_name,
  total_kills      = total_kills + excluded.total_kills,
  total_deaths     = total_deaths + excluded.total_deaths,
  total_games      = total_games + 1,
  total_wins       = total_wins + excluded.total_wins,
  best_kill_streak = max(best_kill_streak, excluded.best_kill_streak),
  headshots        = headshots + excluded.headshots,
  best_accuracy    = max(best_accuracy, excluded.best_accuracy),
  updated_at       = excluded.updated_at
`);

// Period keys for a timestamp (UTC): "d:YYYYMMDD" (today) and "w:YYYYMMDD" of the
// current week's Monday. Both are the buckets a match contributes to.
function dayKey(now: number): string {
  return `d:${ymd(now)}`;
}
function weekKey(now: number): string {
  const d = new Date(now);
  // UTC Monday-of-week: getUTCDay() is 0=Sun..6=Sat; shift to Monday-based.
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return `w:${ymd(monday.getTime())}`;
}

export type MatchDelta = {
  playerId: string;
  userName: string;
  kills: number;
  deaths: number;
  wins: number;
  bestStreak: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number;
  offline: boolean; // bot/practice match — XP is scaled down, no first-win bonus
  now: number;
};

export function getStats(playerId: string): PublicStats {
  return toPublic(selectStmt.get(playerId) as Row | undefined);
}

// --- Progression (XP / level / credits / cosmetics) -------------------------

type ProgRow = {
  total_xp: number;
  level: number;
  credits: number;
  unlocked: string;
  equipped: string;
  first_win_day: number;
};

const progSelectStmt = sqlite.prepare(
  `SELECT total_xp, level, credits, unlocked, equipped, first_win_day
     FROM instagib_stats WHERE player_id = ?`,
);

const progUpdateStmt = sqlite.prepare(`
  UPDATE instagib_stats
     SET total_xp = @totalXp, level = @level, credits = @credits,
         unlocked = @unlocked, equipped = @equipped, first_win_day = @firstWinDay
   WHERE player_id = @playerId`);

const equipUpdateStmt = sqlite.prepare(
  `UPDATE instagib_stats SET equipped = @equipped WHERE player_id = @playerId`,
);

const buyUpdateStmt = sqlite.prepare(
  `UPDATE instagib_stats SET credits = @credits, unlocked = @unlocked WHERE player_id = @playerId`,
);

// Create a bare row for a player who is equipping/buying before ever recording a
// match, so the UPDATEs above have a row to touch.
const ensureRowStmt = sqlite.prepare(
  `INSERT OR IGNORE INTO instagib_stats (player_id, user_name, created_at, updated_at)
   VALUES (?, 'Player', ?, ?)`,
);

function parseIdList(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseEquipped(json: string | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
    return out;
  } catch {
    return {};
  }
}

// Every cosmetic id in the manifest — admins own all of them (incl. the
// admin-exclusive crown/aura), so this is their entitlement set.
const ALL_COSMETIC_IDS: readonly string[] = ALL_COSMETICS.map((c) => c.id);

// Is this account id an admin? Cheap point lookup; cached statement.
const adminCheckStmt = sqlite.prepare(`SELECT is_admin FROM instagib_users WHERE id = ?`);
export function isAdminId(playerId: string): boolean {
  if (!playerId) return false;
  const r = adminCheckStmt.get(playerId) as { is_admin: number } | undefined;
  return !!r?.is_admin;
}

// Owned set = the default freebies ∪ whatever the row has stored. Admins own
// EVERYTHING (every manifest id), which is also the only way the admin-exclusive
// cosmetics become equippable — non-admins can never have them in their set.
function ownedSet(prog: ProgRow | undefined, playerId: string): Set<string> {
  if (isAdminId(playerId)) return new Set(ALL_COSMETIC_IDS);
  return new Set([...defaultUnlockedIds(), ...parseIdList(prog?.unlocked)]);
}

// The unlocked-cosmetic set for an account id (from the igsession cookie),
// used to ownership-check WS cosmetic equips. An empty/unknown id → defaults
// only (so guests still get the free cosmetics, nothing locked); admins → all.
export function unlockedSetFor(playerId: string): Set<string> {
  if (!playerId) return new Set(defaultUnlockedIds());
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  return ownedSet(prog, playerId);
}

// YYYYMMDD in UTC — a stable, timezone-independent "today" for the first-win bonus.
function ymd(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export type Progression = {
  totalXp: number;
  level: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
};

export type MatchRecordResult = {
  stats: PublicStats;
  xpGained: number;
  creditsGained: number;
  leveledUp: boolean;
  newUnlocks: string[];
  progression: Progression;
};

// Records a match: applies the atomic stat upsert, then derives XP/level/credits
// and milestone unlocks from the (already-clamped) delta. better-sqlite3 is
// synchronous and Node is single-threaded, so the read-compute-write below can't
// interleave with another request — no XP-clobbering race. The client never
// reports its own XP; everything here is server-derived.
export function recordMatch(delta: MatchDelta): MatchRecordResult {
  // Guests (no account) accrue nothing — no row, no XP, no leaderboard seeding.
  if (!delta.playerId) {
    return {
      stats: toPublic(undefined),
      xpGained: 0,
      creditsGained: 0,
      leveledUp: false,
      newUnlocks: [],
      progression: { totalXp: 0, level: 1, credits: 0, unlocked: [...defaultUnlockedIds()], equipped: {} },
    };
  }
  const stats = toPublic(upsertStmt.get(delta) as Row | undefined); // also creates the row

  // Daily/weekly leaderboard buckets — online matches only (these are the
  // competitive ladders; offline bot grinding shouldn't seed them).
  if (!delta.offline) {
    periodUpsertStmt.run({ ...delta, periodKey: dayKey(delta.now) });
    periodUpsertStmt.run({ ...delta, periodKey: weekKey(delta.now) });
  }

  const prog = progSelectStmt.get(delta.playerId) as ProgRow | undefined;
  const curXp = prog?.total_xp ?? 0;
  const curCredits = prog?.credits ?? 0;
  const owned = ownedSet(prog, delta.playerId);
  const equipped = parseEquipped(prog?.equipped);
  const firstWinDay = prog?.first_win_day ?? 0;

  const won = delta.wins > 0;
  const today = ymd(delta.now);
  const isFirstWinToday = won && !delta.offline && firstWinDay !== today;

  let xpGained = baseMatchXp({
    kills: delta.kills,
    headshots: delta.headshots,
    bestStreak: delta.bestStreak,
    won,
    accuracy: delta.accuracy,
  });
  if (delta.offline) xpGained = Math.floor(xpGained * OFFLINE_XP_SCALE);
  if (isFirstWinToday) xpGained += XP_FIRST_WIN_BONUS;
  xpGained = Math.max(0, Math.min(PER_MATCH_XP_CAP, xpGained));
  const creditsGained = creditsForXp(xpGained);

  const prevLevel = levelForXp(curXp);
  const newXp = curXp + xpGained;
  const newLevel = levelForXp(newXp);
  const leveledUp = newLevel > prevLevel;

  // Grant milestone (level-gated) unlocks + achievement titles the player has
  // now earned. `stats` is the post-match clamped aggregate, so titles unlock the
  // moment a career threshold is crossed and surface in newUnlocks (end-of-match
  // "UNLOCKED" moment). Both grant sets are server-derived — never client-claimed.
  const before = new Set(owned);
  for (const id of levelGrantsAt(newLevel)) owned.add(id);
  for (const id of titleGrantsFrom({
    kills: stats.totalKills,
    headshots: stats.headshots,
    wins: stats.totalWins,
    bestStreak: stats.bestKillStreak,
    games: stats.totalGames,
    accuracy: stats.bestAccuracy,
  })) {
    owned.add(id);
  }
  const newUnlocks = [...owned].filter((id) => !before.has(id));

  const newCredits = curCredits + creditsGained;
  const newFirstWinDay = isFirstWinToday ? today : firstWinDay;

  progUpdateStmt.run({
    playerId: delta.playerId,
    totalXp: newXp,
    level: newLevel,
    credits: newCredits,
    unlocked: JSON.stringify([...owned]),
    equipped: JSON.stringify(equipped),
    firstWinDay: newFirstWinDay,
  });

  // Advance daily/weekly challenges from this match (online matches only).
  trackChallenges(delta.playerId, delta);

  return {
    stats,
    xpGained,
    creditsGained,
    leveledUp,
    newUnlocks,
    progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
  };
}

export type Profile = {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNext: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
  stats: PublicStats;
  // Ranked Duel standing (null = never played ranked) — drives the rating card
  // stat + the live rank title. `getRankedProfile` is declared below (hoisted).
  ranked: { rating: number; rank: number; provisional: boolean } | null;
};

export function getProfile(playerId: string): Profile {
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const totalXp = prog?.total_xp ?? 0;
  const lp = levelProgress(totalXp);
  const rp = getRankedProfile(playerId);
  return {
    level: lp.level,
    totalXp,
    xpIntoLevel: lp.xpIntoLevel,
    xpForNext: lp.xpForNext,
    credits: prog?.credits ?? 0,
    unlocked: [...ownedSet(prog, playerId)],
    equipped: parseEquipped(prog?.equipped),
    stats: getStats(playerId),
    ranked: rp ? { rating: rp.rating, rank: rp.rank, provisional: rp.provisional } : null,
  };
}

export type EquipResult =
  | { ok: true; equipped: Record<string, string> }
  | { ok: false; reason: 'unknown' | 'slot_mismatch' | 'locked'; equipped: Record<string, string> };

// Equip a cosmetic the player owns. Server-validated against the manifest and
// the owned set, so a forged equip can't grant or apply a locked item.
export function setEquipped(playerId: string, slot: string, id: string): EquipResult {
  if (!playerId) return { ok: false, reason: 'locked', equipped: {} }; // guest: no persistence
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const equipped = parseEquipped(prog?.equipped);
  if (!cosmeticById(id)) return { ok: false, reason: 'unknown', equipped };
  if (slotOf(id) !== slot) return { ok: false, reason: 'slot_mismatch', equipped };
  if (!ownedSet(prog, playerId).has(id)) return { ok: false, reason: 'locked', equipped };
  equipped[slot] = id;
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  equipUpdateStmt.run({ playerId, equipped: JSON.stringify(equipped) });
  return { ok: true, equipped };
}

export type BuyResult =
  | { ok: true; credits: number; unlocked: string[] }
  | {
      ok: false;
      reason: 'unknown' | 'not_for_sale' | 'owned' | 'insufficient';
      credits: number;
      unlocked: string[];
    };

// Spend credits to unlock a buyable cosmetic. Validated server-side.
export function buyCosmetic(playerId: string, id: string): BuyResult {
  if (!playerId) return { ok: false, reason: 'insufficient', credits: 0, unlocked: [...defaultUnlockedIds()] };
  const c = cosmeticById(id);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const credits = prog?.credits ?? 0;
  const owned = ownedSet(prog, playerId);
  if (!c) return { ok: false, reason: 'unknown', credits, unlocked: [...owned] };
  if (c.source.type !== 'credits')
    return { ok: false, reason: 'not_for_sale', credits, unlocked: [...owned] };
  if (owned.has(id)) return { ok: false, reason: 'owned', credits, unlocked: [...owned] };
  if (credits < c.source.price)
    return { ok: false, reason: 'insufficient', credits, unlocked: [...owned] };
  const newCredits = credits - c.source.price;
  owned.add(id);
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  buyUpdateStmt.run({ playerId, credits: newCredits, unlocked: JSON.stringify([...owned]) });
  return { ok: true, credits: newCredits, unlocked: [...owned] };
}

export type CaseResult =
  | { ok: true; won: string; dupe: boolean; refund: number; credits: number; unlocked: string[] }
  | { ok: false; reason: 'insufficient'; credits: number };

// Open a hat case: spend credits, roll a hat weighted by rarity (server-
// authoritative), unlock it — or, if already owned, refund part of the cost.
export function openCase(playerId: string): CaseResult {
  if (!playerId) return { ok: false, reason: 'insufficient', credits: 0 };
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const credits = prog?.credits ?? 0;
  if (credits < HAT_CASE_COST) return { ok: false, reason: 'insufficient', credits };

  const pool = caseHats();
  const total = pool.reduce((s, h) => s + (RARITY_WEIGHT[h.rarity] ?? 1), 0);
  let r = Math.random() * total;
  let won = pool[pool.length - 1];
  for (const h of pool) {
    r -= RARITY_WEIGHT[h.rarity] ?? 1;
    if (r <= 0) {
      won = h;
      break;
    }
  }

  const owned = ownedSet(prog, playerId);
  const dupe = owned.has(won.id);
  let newCredits = credits - HAT_CASE_COST;
  let refund = 0;
  if (dupe) {
    refund = Math.floor(HAT_CASE_COST * DUPE_REFUND_FRAC);
    newCredits += refund;
  } else {
    owned.add(won.id);
  }
  buyUpdateStmt.run({ playerId, credits: newCredits, unlocked: JSON.stringify([...owned]) });
  return { ok: true, won: won.id, dupe, refund, credits: newCredits, unlocked: [...owned] };
}

// --- Challenges (Phase 2) ---------------------------------------------------

// Focused XP/credits/unlock update (leaves equipped + first_win_day untouched) —
// used to pay out challenge rewards on top of match XP.
const progXpUpdateStmt = sqlite.prepare(
  `UPDATE instagib_stats
      SET total_xp = @totalXp, level = @level, credits = @credits, unlocked = @unlocked
    WHERE player_id = @playerId`,
);

// Progress upserts. 'add' accumulates, 'max' keeps the best single match; both
// clamp at the goal. SQLite's 2-arg MIN/MAX are scalar.
const chAddStmt = sqlite.prepare(`
  INSERT INTO instagib_challenges (player_id, challenge, period, progress, goal, claimed)
  VALUES (@playerId, @challenge, @period, MIN(@goal, @value), @goal, 0)
  ON CONFLICT(player_id, challenge, period) DO UPDATE SET progress = MIN(goal, progress + @value)`);
const chMaxStmt = sqlite.prepare(`
  INSERT INTO instagib_challenges (player_id, challenge, period, progress, goal, claimed)
  VALUES (@playerId, @challenge, @period, MIN(@goal, @value), @goal, 0)
  ON CONFLICT(player_id, challenge, period) DO UPDATE SET progress = MIN(goal, MAX(progress, @value))`);
const chRowStmt = sqlite.prepare(
  `SELECT progress, claimed FROM instagib_challenges
    WHERE player_id = ? AND challenge = ? AND period = ?`,
);
const chClaimStmt = sqlite.prepare(
  `UPDATE instagib_challenges SET claimed = 1
    WHERE player_id = @playerId AND challenge = @challenge AND period = @period AND claimed = 0`,
);

function metricValue(metric: ChallengeMetric, d: MatchDelta): number {
  switch (metric) {
    case 'kills': return d.kills;
    case 'headshots': return d.headshots;
    case 'wins': return d.wins; // 0 or 1
    case 'streak': return d.bestStreak;
    case 'games': return 1;
  }
}

function periodFor(def: ChallengeDef, now: number): string {
  return def.period === 'daily' ? dailyPeriod(now) : weeklyPeriod(now);
}

function activeFor(playerId: string, def: ChallengeDef, now: number): boolean {
  const pool = def.period === 'daily' ? DAILY_CHALLENGES : WEEKLY_CHALLENGES;
  const count = def.period === 'daily' ? DAILY_COUNT : WEEKLY_COUNT;
  return activeChallenges(playerId, pool, periodFor(def, now), count).some((c) => c.id === def.id);
}

// Advance the player's active challenges from a match. Online-only: offline /
// practice matches earn no challenge credit (docs/progression.md §3, §9).
function trackChallenges(playerId: string, delta: MatchDelta): void {
  if (delta.offline) return;
  const now = delta.now;
  const daily = activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT);
  const weekly = activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT);
  for (const c of [...daily, ...weekly]) {
    const value = metricValue(c.metric, delta);
    if (value <= 0) continue; // nothing to record this match
    const stmt = c.track === 'max' ? chMaxStmt : chAddStmt;
    stmt.run({ playerId, challenge: c.id, period: periodFor(c, now), goal: c.goal, value });
  }
}

// Pay out a reward (challenge claim): add XP + credits, recompute level + any
// milestone unlocks. Returns the post-reward progression for the client.
function grantXpCredits(
  playerId: string,
  xp: number,
  credits: number,
): { progression: Progression; newUnlocks: string[] } {
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const owned = ownedSet(prog, playerId);
  const equipped = parseEquipped(prog?.equipped);
  const newXp = (prog?.total_xp ?? 0) + Math.max(0, Math.floor(xp));
  const newLevel = levelForXp(newXp);
  const before = new Set(owned);
  for (const id of levelGrantsAt(newLevel)) owned.add(id);
  const newUnlocks = [...owned].filter((id) => !before.has(id));
  const newCredits = (prog?.credits ?? 0) + Math.max(0, Math.floor(credits));
  progXpUpdateStmt.run({
    playerId,
    totalXp: newXp,
    level: newLevel,
    credits: newCredits,
    unlocked: JSON.stringify([...owned]),
  });
  return {
    progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
    newUnlocks,
  };
}

export type ChallengeView = {
  id: string;
  title: string;
  metric: ChallengeMetric;
  period: 'daily' | 'weekly';
  goal: number;
  progress: number;
  claimed: boolean;
  complete: boolean;
  rewardXp: number;
  rewardCredits: number;
};

export function getChallenges(
  playerId: string,
  now: number,
): { daily: ChallengeView[]; weekly: ChallengeView[] } {
  const view = (def: ChallengeDef): ChallengeView => {
    const row = chRowStmt.get(playerId, def.id, periodFor(def, now)) as
      | { progress: number; claimed: number }
      | undefined;
    const progress = row?.progress ?? 0;
    return {
      id: def.id,
      title: def.title,
      metric: def.metric,
      period: def.period,
      goal: def.goal,
      progress,
      claimed: !!row?.claimed,
      complete: progress >= def.goal,
      rewardXp: def.rewardXp,
      rewardCredits: def.rewardCredits,
    };
  };
  return {
    daily: activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT).map(view),
    weekly: activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT).map(view),
  };
}

export type ClaimResult =
  | { ok: true; xpGained: number; creditsGained: number; progression: Progression; newUnlocks: string[] }
  | { ok: false; reason: 'unknown' | 'not_active' | 'incomplete' | 'claimed' };

export function claimChallenge(playerId: string, id: string, now: number): ClaimResult {
  if (!playerId) return { ok: false, reason: 'not_active' }; // guest: no challenges
  const def = challengeById(id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (!activeFor(playerId, def, now)) return { ok: false, reason: 'not_active' };
  const period = periodFor(def, now);
  const row = chRowStmt.get(playerId, id, period) as
    | { progress: number; claimed: number }
    | undefined;
  const progress = row?.progress ?? 0;
  if (progress < def.goal) return { ok: false, reason: 'incomplete' };
  if (row?.claimed) return { ok: false, reason: 'claimed' };
  // Atomic claim: the `AND claimed = 0` guard means a second (even concurrent)
  // claim flips no rows → no double payout, independent of JS ordering.
  const info = chClaimStmt.run({ playerId, challenge: id, period });
  if (info.changes === 0) return { ok: false, reason: 'claimed' };
  const { progression, newUnlocks } = grantXpCredits(playerId, def.rewardXp, def.rewardCredits);
  return { ok: true, xpGained: def.rewardXp, creditsGained: def.rewardCredits, progression, newUnlocks };
}

// --- Global leaderboard -----------------------------------------------------

export type LeaderboardEntry = {
  id: string; // player_id — lets the client highlight the local player's row
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number; // totalDeaths > 0 ? kills/deaths : kills, rounded to 2dp
  admin: boolean; // staff badge on the standings
  verified: boolean; // blue verified check on the standings
};

// One prepared statement per sort column so we never interpolate user input
// into SQL — the router whitelists `sort`, and we pick a stmt from this map.
// kills uses the existing idx_instagib_stats_kills index; all tiebreak on
// total_kills DESC. We only surface players who have actually played a match
// (total_games > 0). `limit` is bound as a parameter (and clamped by callers).
// Minimum games before a player appears on / is ranked by the accuracy board —
// stops a single lucky 1-shot 100% match from topping the standings.
const MIN_ACC_GAMES = 5;

const LEADERBOARD_COLS = `player_id, user_name, total_kills, total_deaths, total_games,
          total_wins, best_kill_streak, headshots, best_accuracy`;

const leaderboardStmts = {
  kills: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM instagib_stats
     WHERE total_games > 0
     ORDER BY total_kills DESC
     LIMIT ?`),
  wins: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM instagib_stats
     WHERE total_games > 0
     ORDER BY total_wins DESC, total_kills DESC
     LIMIT ?`),
  accuracy: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM instagib_stats
     WHERE total_games >= ${MIN_ACC_GAMES}
     ORDER BY best_accuracy DESC, total_kills DESC
     LIMIT ?`),
} as const;

// Rank = 1 + (players strictly ahead on the primary metric). Ties share a rank.
const rankStmts = {
  kills: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_stats WHERE total_games > 0 AND total_kills > ?`),
  wins: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_stats WHERE total_games > 0 AND total_wins > ?`),
  accuracy: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_stats WHERE total_games >= ${MIN_ACC_GAMES} AND best_accuracy > ?`),
} as const;

const playerStatsRowStmt = sqlite.prepare(
  `SELECT ${LEADERBOARD_COLS} FROM instagib_stats WHERE player_id = ?`,
);

// Same queries against the period table, parameterised by period_key (bound, not
// interpolated). Window 'daily'/'weekly' use these; 'all' uses the statements above.
const periodLeaderboardStmts = {
  kills: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM instagib_period_stats
     WHERE period_key = ? AND total_games > 0
     ORDER BY total_kills DESC LIMIT ?`),
  wins: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM instagib_period_stats
     WHERE period_key = ? AND total_games > 0
     ORDER BY total_wins DESC, total_kills DESC LIMIT ?`),
  accuracy: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM instagib_period_stats
     WHERE period_key = ? AND total_games >= ${MIN_ACC_GAMES}
     ORDER BY best_accuracy DESC, total_kills DESC LIMIT ?`),
} as const;

const periodRankStmts = {
  kills: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_period_stats WHERE period_key = ? AND total_games > 0 AND total_kills > ?`),
  wins: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_period_stats WHERE period_key = ? AND total_games > 0 AND total_wins > ?`),
  accuracy: sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_period_stats WHERE period_key = ? AND total_games >= ${MIN_ACC_GAMES} AND best_accuracy > ?`),
} as const;

const periodRowStmt = sqlite.prepare(
  `SELECT ${LEADERBOARD_COLS} FROM instagib_period_stats WHERE player_id = ? AND period_key = ?`,
);

export type LeaderWindow = 'all' | 'daily' | 'weekly';
// The period_key a window resolves to right now (null for all-time).
function windowKey(win: LeaderWindow, now: number): string | null {
  return win === 'daily' ? dayKey(now) : win === 'weekly' ? weekKey(now) : null;
}

type LeaderboardRow = Row & { user_name: string; player_id: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toLeaderboardEntry = (row: LeaderboardRow): LeaderboardEntry => ({
  id: row.player_id,
  userName: row.user_name,
  totalKills: row.total_kills,
  totalDeaths: row.total_deaths,
  totalGames: row.total_games,
  totalWins: row.total_wins,
  bestKillStreak: row.best_kill_streak,
  headshots: row.headshots,
  bestAccuracy: row.best_accuracy,
  kd: round2(
    row.total_deaths > 0 ? row.total_kills / row.total_deaths : row.total_kills,
  ),
  admin: false,
  verified: false,
});

// Fill in admin/verified for a batch of entries with one parameterized query
// (player ids are the account ids, which is the users table PK). Mutates + returns.
function attachUserFlags(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  if (entries.length === 0) return entries;
  const ids = entries.map((e) => e.id);
  const ph = ids.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT id, is_admin, is_verified FROM instagib_users WHERE id IN (${ph})`)
    .all(...ids) as { id: string; is_admin: number; is_verified: number }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of entries) {
    const f = byId.get(e.id);
    if (f) {
      e.admin = !!f.is_admin;
      e.verified = !!f.is_verified;
    }
  }
  return entries;
}

export function getLeaderboard(opts: {
  sort: 'kills' | 'wins' | 'accuracy';
  limit: number;
  window?: LeaderWindow;
}): LeaderboardEntry[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const win = opts.window ?? 'all';
  const key = windowKey(win, Date.now());
  const stmt = key
    ? (periodLeaderboardStmts[opts.sort] ?? periodLeaderboardStmts.kills)
    : (leaderboardStmts[opts.sort] ?? leaderboardStmts.kills);
  const rows = (key ? stmt.all(key, limit) : stmt.all(limit)) as LeaderboardRow[];
  return attachUserFlags(rows.map(toLeaderboardEntry));
}

// The requesting player's rank + their own entry within the window, for the "you
// are #N" pin. `rank: 0` = unranked (no games this window, or below the accuracy
// floor). Returns null if the player has no row in the window at all.
export function getPlayerRank(
  playerId: string,
  sort: 'kills' | 'wins' | 'accuracy',
  window: LeaderWindow = 'all',
): { rank: number; entry: LeaderboardEntry } | null {
  if (!playerId) return null;
  const key = windowKey(window, Date.now());
  const row = (
    key ? periodRowStmt.get(playerId, key) : playerStatsRowStmt.get(playerId)
  ) as LeaderboardRow | undefined;
  if (!row || row.total_games <= 0) return null;
  const [entry] = attachUserFlags([toLeaderboardEntry(row)]);
  if (sort === 'accuracy' && row.total_games < MIN_ACC_GAMES) return { rank: 0, entry };
  const metric =
    sort === 'kills' ? row.total_kills : sort === 'wins' ? row.total_wins : row.best_accuracy;
  const above = (
    key
      ? (periodRankStmts[sort].get(key, metric) as { n: number })
      : (rankStmts[sort].get(metric) as { n: number })
  ).n;
  return { rank: above + 1, entry };
}

// ── Accounts (auth) ──────────────────────────────────────────────────────────
// Registered users + opaque session tokens. Passwords are hashed in
// server/auth.ts (scrypt); this layer only stores/reads. The account id is the
// progression player_id, so logging in carries your XP/cosmetics across devices.
const insertUserStmt = sqlite.prepare(
  `INSERT INTO instagib_users (id, username, username_lower, pw_hash, pw_salt, email, created_at)
   VALUES (@id, @username, @usernameLower, @pwHash, @pwSalt, @email, @createdAt)`,
);
const userByLowerStmt = sqlite.prepare(
  `SELECT id, username, pw_hash, pw_salt FROM instagib_users WHERE username_lower = ?`,
);
const userByIdStmt = sqlite.prepare(
  `SELECT id, username, is_admin, is_verified FROM instagib_users WHERE id = ?`,
);
const accountByLowerStmt = sqlite.prepare(
  `SELECT id, username, is_admin, is_verified FROM instagib_users WHERE username_lower = ?`,
);
const insertSessionStmt = sqlite.prepare(
  `INSERT INTO instagib_sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
);
const sessionStmt = sqlite.prepare(`SELECT user_id FROM instagib_sessions WHERE token = ?`);
const deleteSessionStmt = sqlite.prepare(`DELETE FROM instagib_sessions WHERE token = ?`);
const setVerifiedStmt = sqlite.prepare(`UPDATE instagib_users SET is_verified = @v WHERE id = @id`);
const setAdminStmt = sqlite.prepare(`UPDATE instagib_users SET is_admin = @v WHERE id = @id`);

export type UserRow = { id: string; username: string; pw_hash: string; pw_salt: string };
// Public account info (no secrets) — id, name, and moderation flags.
export type AccountInfo = { id: string; username: string; isAdmin: boolean; isVerified: boolean };
type FlagsRow = { id: string; username: string; is_admin: number; is_verified: number };
const toAccountInfo = (r: FlagsRow | undefined): AccountInfo | undefined =>
  r ? { id: r.id, username: r.username, isAdmin: !!r.is_admin, isVerified: !!r.is_verified } : undefined;

export function createUser(u: {
  id: string;
  username: string;
  usernameLower: string;
  pwHash: string;
  pwSalt: string;
  email: string | null;
  createdAt: number;
}): void {
  insertUserStmt.run(u);
}
export function findUserByName(usernameLower: string): UserRow | undefined {
  return userByLowerStmt.get(usernameLower) as UserRow | undefined;
}
export function findUserById(id: string): AccountInfo | undefined {
  return toAccountInfo(userByIdStmt.get(id) as FlagsRow | undefined);
}
// Resolve a username (lowercased) to its public account info — used by the admin
// API to verify/promote a player by name without touching password fields.
export function findAccountByName(usernameLower: string): AccountInfo | undefined {
  return toAccountInfo(accountByLowerStmt.get(usernameLower) as FlagsRow | undefined);
}
export function setVerified(id: string, value: boolean): boolean {
  return setVerifiedStmt.run({ id, v: value ? 1 : 0 }).changes > 0;
}
export function setAdmin(id: string, value: boolean): boolean {
  return setAdminStmt.run({ id, v: value ? 1 : 0 }).changes > 0;
}
// Promote the configured ADMIN_USERNAMES to admin on boot (idempotent). Lets you
// designate your account on Railway via an env var — register first, set the var,
// redeploy. Returns the number of rows flipped.
export function syncAdminsFromEnv(usernamesLower: string[]): number {
  if (usernamesLower.length === 0) return 0;
  const ph = usernamesLower.map(() => '?').join(',');
  return sqlite
    .prepare(`UPDATE instagib_users SET is_admin = 1 WHERE username_lower IN (${ph})`)
    .run(...usernamesLower).changes;
}
export function createSession(token: string, userId: string, now: number): void {
  insertSessionStmt.run(token, userId, now);
}
// Resolve a session token to its account id ('' if missing/unknown). This is the
// progression identity used by the stats API and the game WS.
export function userIdFromSession(token: string): string {
  if (!token) return '';
  const row = sessionStmt.get(token) as { user_id: string } | undefined;
  return row?.user_id ?? '';
}
export function deleteSession(token: string): void {
  deleteSessionStmt.run(token);
}

// ── Admin metrics (dashboard) ────────────────────────────────────────────────
// Read-only aggregates for the /admin dashboard. Everything here derives from
// data we already keep: instagib_stats (career totals + created_at/updated_at),
// instagib_users (registrations), and instagib_audit (the per-event timeline —
// every 'match', 'login', 'register' with a ts). All callers go through the
// requireAdmin gate. Statements are prepared once; the queries run infrequently.

const DAY_MS = 86_400_000;

// Floor a timestamp to its UTC day index (days since epoch). Used to bucket the
// audit/registration timelines without pulling strftime into hot SQL.
function dayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}
function dayIndexToISO(d: number): string {
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

const mAccountsTotal = sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_users`);
const mPlayersWithGames = sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_stats WHERE total_games > 0`);
const mMatchesTotal = sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'match'`);
// Offline/practice matches serialize "offline":true into the detail JSON; the
// online count is everything that isn't that. A coarse but reliable LIKE — our
// detail serialization is stable (see server/stats.ts).
const mOnlineMatchesTotal = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'match' AND detail NOT LIKE '%"offline":true%'`,
);
const mAgg = sqlite.prepare(`
  SELECT COALESCE(SUM(total_kills),0)  AS kills,
         COALESCE(SUM(total_deaths),0) AS deaths,
         COALESCE(SUM(shots_fired),0)  AS fired,
         COALESCE(SUM(shots_hit),0)    AS hit,
         COALESCE(SUM(total_xp),0)     AS xp
    FROM instagib_stats`);
const mLifetime = sqlite.prepare(
  `SELECT AVG(updated_at - created_at) AS ms FROM instagib_stats WHERE total_games > 0`,
);
const mWinMatches = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'match' AND ts >= ?`,
);
const mWinActive = sqlite.prepare(
  `SELECT COUNT(DISTINCT actor_id) AS n FROM instagib_audit
     WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ?`,
);
const mWinNewAccounts = sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_users WHERE created_at >= ?`);
const mWinLogins = sqlite.prepare(`SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'login' AND ts >= ?`);

export type MetricsWindow = {
  matches: number;
  activePlayers: number;
  newAccounts: number;
  logins: number;
};
export type MetricsOverview = {
  totalAccounts: number;
  playersWithGames: number;
  totalMatches: number; // recorded match submissions (incl. offline/practice)
  onlineMatches: number; // excludes offline/practice
  totalKills: number;
  totalDeaths: number;
  globalAccuracy: number; // SUM(hit)/SUM(fired) × 100, 0 if no shots
  totalXp: number;
  avgLifetimeDays: number; // mean (updated_at − created_at) over players with games
  stickiness: number; // DAU / MAU, 0..1
  windows: { day: MetricsWindow; week: MetricsWindow; month: MetricsWindow };
};

const num = (r: unknown): number => (r as { n: number }).n;
function windowMetrics(sinceTs: number): MetricsWindow {
  return {
    matches: num(mWinMatches.get(sinceTs)),
    activePlayers: num(mWinActive.get(sinceTs)),
    newAccounts: num(mWinNewAccounts.get(sinceTs)),
    logins: num(mWinLogins.get(sinceTs)),
  };
}

export function getMetricsOverview(now: number = Date.now()): MetricsOverview {
  const agg = mAgg.get() as { kills: number; deaths: number; fired: number; hit: number; xp: number };
  const day = windowMetrics(now - DAY_MS);
  const week = windowMetrics(now - 7 * DAY_MS);
  const month = windowMetrics(now - 30 * DAY_MS);
  const lifeMs = (mLifetime.get() as { ms: number | null }).ms ?? 0;
  return {
    totalAccounts: num(mAccountsTotal.get()),
    playersWithGames: num(mPlayersWithGames.get()),
    totalMatches: num(mMatchesTotal.get()),
    onlineMatches: num(mOnlineMatchesTotal.get()),
    totalKills: agg.kills,
    totalDeaths: agg.deaths,
    globalAccuracy: agg.fired > 0 ? round2((agg.hit / agg.fired) * 100) : 0,
    totalXp: agg.xp,
    avgLifetimeDays: round2(lifeMs / DAY_MS),
    stickiness: month.activePlayers > 0 ? round2(day.activePlayers / month.activePlayers) : 0,
    windows: { day, week, month },
  };
}

const mTsMatches = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM instagib_audit WHERE event = 'match' AND ts >= ? GROUP BY d`,
);
const mTsLogins = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM instagib_audit WHERE event = 'login' AND ts >= ? GROUP BY d`,
);
const mTsActive = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(DISTINCT actor_id) AS n
     FROM instagib_audit WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ? GROUP BY d`,
);
const mTsRegs = sqlite.prepare(
  `SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM instagib_users WHERE created_at >= ? GROUP BY d`,
);

export type DayPoint = {
  date: string; // YYYY-MM-DD (UTC)
  matches: number;
  logins: number;
  registrations: number;
  activePlayers: number;
};

// A continuous daily series (gaps filled with zeros) for the last `days` days —
// charts need a dense series, so we materialize every day in the range.
export function getMetricsTimeseries(days: number, now: number = Date.now()): DayPoint[] {
  const span = Math.max(1, Math.min(180, Math.floor(days)));
  const today = dayIndex(now);
  const start = today - (span - 1);
  const cutoff = start * DAY_MS;
  const toMap = (rows: unknown[]): Map<number, number> =>
    new Map((rows as { d: number; n: number }[]).map((r) => [r.d, r.n]));
  const matches = toMap(mTsMatches.all(cutoff));
  const logins = toMap(mTsLogins.all(cutoff));
  const active = toMap(mTsActive.all(cutoff));
  const regs = toMap(mTsRegs.all(cutoff));
  const out: DayPoint[] = [];
  for (let d = start; d <= today; d++) {
    out.push({
      date: dayIndexToISO(d),
      matches: matches.get(d) ?? 0,
      logins: logins.get(d) ?? 0,
      registrations: regs.get(d) ?? 0,
      activePlayers: active.get(d) ?? 0,
    });
  }
  return out;
}

// Cohort retention: of the accounts that registered on day D, how many came back
// (a 'match' or 'login') within the next 1 day (D1) and the next 7 days (D7).
// Both windows exclude the registration day itself. A single correlated-subquery
// pass — fine at alpha volume, all indexed on (event, ts) / (actor_id implicit).
const mRetention = sqlite.prepare(`
  SELECT CAST(u.created_at/${DAY_MS} AS INTEGER) AS d,
         COUNT(*) AS size,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM instagib_audit a
            WHERE a.actor_id = u.id AND a.event IN ('match','login')
              AND a.ts >= u.created_at + ${DAY_MS} AND a.ts < u.created_at + 2*${DAY_MS}
         ) THEN 1 ELSE 0 END) AS d1,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM instagib_audit a
            WHERE a.actor_id = u.id AND a.event IN ('match','login')
              AND a.ts >= u.created_at + ${DAY_MS} AND a.ts < u.created_at + 8*${DAY_MS}
         ) THEN 1 ELSE 0 END) AS d7
    FROM instagib_users u
   WHERE u.created_at >= ?
   GROUP BY d ORDER BY d`);

export type RetentionCohort = { date: string; size: number; d1: number; d7: number };
export function getRetention(days: number, now: number = Date.now()): RetentionCohort[] {
  const span = Math.max(1, Math.min(120, Math.floor(days)));
  const cutoff = (dayIndex(now) - (span - 1)) * DAY_MS;
  return (mRetention.all(cutoff) as { d: number; size: number; d1: number; d7: number }[]).map(
    (r) => ({ date: dayIndexToISO(r.d), size: r.size, d1: r.d1, d7: r.d7 }),
  );
}

const mRecentMatches = sqlite.prepare(
  `SELECT id, ts, actor_id, actor_name, detail FROM instagib_audit
     WHERE event = 'match' ORDER BY id DESC LIMIT ?`,
);
const mRecentMatchesBefore = sqlite.prepare(
  `SELECT id, ts, actor_id, actor_name, detail FROM instagib_audit
     WHERE event = 'match' AND id < ? ORDER BY id DESC LIMIT ?`,
);

export type MatchRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  kills: number;
  deaths: number;
  won: boolean;
  headshots: number;
  accuracy: number;
  offline: boolean;
  xp: number;
  mode: string | null;
};

// Recent recorded matches, newest first, keyset-paginated by audit id (pass the
// last id you saw as `beforeId`). The per-match detail blob is parsed here.
export function getRecentMatches(limit: number, beforeId?: number): MatchRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = (
    beforeId && beforeId > 0 ? mRecentMatchesBefore.all(beforeId, n) : mRecentMatches.all(n)
  ) as { id: number; ts: number; actor_id: string; actor_name: string; detail: string }[];
  return rows.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      /* malformed/empty detail → zeros */
    }
    const intOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      id: r.id,
      ts: r.ts,
      playerId: r.actor_id,
      playerName: r.actor_name || 'Guest',
      kills: intOf(d.kills),
      deaths: intOf(d.deaths),
      won: d.won === true,
      headshots: intOf(d.headshots),
      accuracy: intOf(d.accuracy),
      offline: d.offline === true,
      xp: intOf(d.xp),
      mode: typeof d.mode === 'string' ? d.mode : null,
    };
  });
}

export type PlayerRow = {
  id: string;
  userName: string;
  level: number;
  totalGames: number;
  totalKills: number;
  totalDeaths: number;
  headshots: number;
  bestAccuracy: number;
  totalXp: number;
  credits: number;
  kd: number;
  lastSeen: number; // updated_at
  createdAt: number; // registration (users) or first stat row
  admin: boolean;
  verified: boolean;
};

type PlayerTableRow = {
  player_id: string;
  user_name: string;
  level: number;
  total_games: number;
  total_kills: number;
  total_deaths: number;
  headshots: number;
  best_accuracy: number;
  total_xp: number;
  credits: number;
  updated_at: number;
  created_at: number;
  is_admin: number;
  is_verified: number;
};

// Whitelisted sort → ORDER BY clause. The key is validated against this map's
// own keys, so nothing user-supplied is ever interpolated into the SQL string.
const PLAYER_SORTS: Record<string, string> = {
  kills: 's.total_kills DESC',
  games: 's.total_games DESC',
  level: 's.level DESC, s.total_xp DESC',
  accuracy: 's.best_accuracy DESC, s.total_games DESC',
  xp: 's.total_xp DESC',
  recent: 's.updated_at DESC',
};
const PLAYER_COLS = `s.player_id, s.user_name, s.level, s.total_games, s.total_kills,
  s.total_deaths, s.headshots, s.best_accuracy, s.total_xp, s.credits, s.updated_at,
  COALESCE(u.created_at, s.created_at) AS created_at,
  COALESCE(u.is_admin, 0) AS is_admin, COALESCE(u.is_verified, 0) AS is_verified`;

export function getPlayersTable(opts: {
  sort?: string;
  q?: string;
  limit?: number;
}): PlayerRow[] {
  const orderBy = PLAYER_SORTS[opts.sort ?? 'recent'] ?? PLAYER_SORTS.recent;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const like = `%${(opts.q ?? '').slice(0, 40)}%`;
  const rows = sqlite
    .prepare(
      `SELECT ${PLAYER_COLS}
         FROM instagib_stats s LEFT JOIN instagib_users u ON u.id = s.player_id
        WHERE s.total_games > 0 AND s.user_name LIKE ?
        ORDER BY ${orderBy} LIMIT ?`,
    )
    .all(like, limit) as PlayerTableRow[];
  return rows.map((r) => ({
    id: r.player_id,
    userName: r.user_name,
    level: r.level,
    totalGames: r.total_games,
    totalKills: r.total_kills,
    totalDeaths: r.total_deaths,
    headshots: r.headshots,
    bestAccuracy: r.best_accuracy,
    totalXp: r.total_xp,
    credits: r.credits,
    kd: round2(r.total_deaths > 0 ? r.total_kills / r.total_deaths : r.total_kills),
    lastSeen: r.updated_at,
    createdAt: r.created_at,
    admin: !!r.is_admin,
    verified: !!r.is_verified,
  }));
}

// ── Ranked Duel ladder (Elo) ─────────────────────────────────────────────────
// Separate from career stats: a hidden-then-shown Elo rating per account, updated
// only by ranked 1v1 results (server-authoritative — the game server reports the
// winner, the client never sends a rating). Login-gated, so player_id is always a
// real account id. Cosmetic-adjacent: rank is bragging rights, never an advantage.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_ranked (
  player_id  TEXT PRIMARY KEY,
  user_name  TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 1000,
  peak       INTEGER NOT NULL DEFAULT 1000,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranked_rating ON instagib_ranked(rating);
`);

export const RANKED_BASE_RATING = 1000;
export const RANKED_PLACEMENT_GAMES = 5; // below this, rating shows as "provisional"

// Classic Elo K-factor: volatile while provisional, calmer once established, and
// smallest at the top so elite ratings don't swing on a single game.
function kFactor(games: number, rating: number): number {
  if (games < 10) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

const rankedRowStmt = sqlite.prepare(`SELECT * FROM instagib_ranked WHERE player_id = ?`);
const rankedEnsureStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO instagib_ranked (player_id, user_name, rating, peak, created_at, updated_at)
  VALUES (@playerId, @userName, ${RANKED_BASE_RATING}, ${RANKED_BASE_RATING}, @now, @now)`);
const rankedUpdateStmt = sqlite.prepare(`
  UPDATE instagib_ranked
     SET user_name = @userName, rating = @rating, peak = max(peak, @rating),
         games = games + 1, wins = wins + @win, losses = losses + @loss,
         streak = @streak, updated_at = @now
   WHERE player_id = @playerId`);
const rankedRankStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM instagib_ranked WHERE games > 0 AND rating > ?`,
);

type RankedRow = {
  player_id: string;
  user_name: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  created_at: number;
  updated_at: number;
};

export type RankedProfile = {
  id: string;
  userName: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  rank: number; // ladder position (1 = top); 0 if unranked (no games)
  provisional: boolean;
};

function toRankedProfile(r: RankedRow): RankedProfile {
  return {
    id: r.player_id,
    userName: r.user_name,
    rating: r.rating,
    peak: r.peak,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    streak: r.streak,
    rank: r.games > 0 ? num(rankedRankStmt.get(r.rating)) + 1 : 0,
    provisional: r.games < RANKED_PLACEMENT_GAMES,
  };
}

// A player's ranked profile (null = never queued ranked). The base rating for a
// brand-new ranked player (so the queue can match on it before their first game).
export function getRankedProfile(playerId: string): RankedProfile | null {
  if (!playerId) return null;
  const r = rankedRowStmt.get(playerId) as RankedRow | undefined;
  return r ? toRankedProfile(r) : null;
}

// Current rating for matchmaking — the stored value, or the base for a newcomer.
export function getRankedRating(playerId: string): number {
  const r = rankedRowStmt.get(playerId) as RankedRow | undefined;
  return r?.rating ?? RANKED_BASE_RATING;
}

export type RankedResult = {
  winner: { id: string; userName: string; rating: number; delta: number; rank: number };
  loser: { id: string; userName: string; rating: number; delta: number; rank: number };
};

// Apply a ranked 1v1 result (server-authoritative). Symmetric Elo: the winner
// gains what the loser sheds, scaled by the upset. `weight` (0..1) damps the
// rating change for a repeat opponent (anti match-fixing — see endRankedMatch);
// at weight 1 it's a normal full-value game. Both rows are created on demand,
// floored at 100 so a rating can't go negative. Synchronous + single-threaded,
// so the read-compute-write can't interleave. Audited as 'ranked.match'.
export function recordRankedResult(
  winnerId: string,
  winnerName: string,
  loserId: string,
  loserName: string,
  now: number = Date.now(),
  weight: number = 1,
): RankedResult | null {
  if (!winnerId || !loserId || winnerId === loserId) return null;
  const w8 = Math.max(0, Math.min(1, weight));
  rankedEnsureStmt.run({ playerId: winnerId, userName: winnerName, now });
  rankedEnsureStmt.run({ playerId: loserId, userName: loserName, now });
  const w = rankedRowStmt.get(winnerId) as RankedRow;
  const l = rankedRowStmt.get(loserId) as RankedRow;
  const expectedW = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
  const dW = Math.round(kFactor(w.games, w.rating) * (1 - expectedW) * w8);
  const dL = Math.round(kFactor(l.games, l.rating) * (0 - (1 - expectedW)) * w8);
  const newW = Math.max(100, w.rating + dW);
  const newL = Math.max(100, l.rating + dL);
  rankedUpdateStmt.run({
    playerId: winnerId,
    userName: winnerName,
    rating: newW,
    win: 1,
    loss: 0,
    streak: w.streak >= 0 ? w.streak + 1 : 1,
    now,
  });
  rankedUpdateStmt.run({
    playerId: loserId,
    userName: loserName,
    rating: newL,
    win: 0,
    loss: 1,
    streak: l.streak <= 0 ? l.streak - 1 : -1,
    now,
  });
  logEvent({
    event: 'ranked.match',
    actorId: winnerId,
    actorName: winnerName,
    targetId: loserId,
    detail: { winnerRating: newW, loserRating: newL, dW, dL, weight: w8, loser: loserName },
    now,
  });
  return {
    winner: { id: winnerId, userName: winnerName, rating: newW, delta: newW - w.rating, rank: num(rankedRankStmt.get(newW)) + 1 },
    loser: { id: loserId, userName: loserName, rating: newL, delta: newL - l.rating, rank: num(rankedRankStmt.get(newL)) + 1 },
  };
}

const rankedLeaderboardStmt = sqlite.prepare(
  `SELECT * FROM instagib_ranked WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT ?`,
);
export type RankedLeaderEntry = {
  id: string;
  userName: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  admin: boolean;
  verified: boolean;
};
export function getRankedLeaderboard(limit: number): RankedLeaderEntry[] {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = rankedLeaderboardStmt.all(n) as RankedRow[];
  const base: RankedLeaderEntry[] = rows.map((r) => ({
    id: r.player_id,
    userName: r.user_name,
    rating: r.rating,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    streak: r.streak,
    admin: false,
    verified: false,
  }));
  if (base.length) {
    const ph = base.map(() => '?').join(',');
    const flags = sqlite
      .prepare(`SELECT id, is_admin, is_verified FROM instagib_users WHERE id IN (${ph})`)
      .all(...base.map((e) => e.id)) as { id: string; is_admin: number; is_verified: number }[];
    const byId = new Map(flags.map((f) => [f.id, f]));
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = !!f.is_admin;
        e.verified = !!f.is_verified;
      }
    }
  }
  return base;
}

// ── Weekly Challenge ─────────────────────────────────────────────────────────
// A weekly leaderboard for the "1v1 vs a hard bot" challenge mode. Ranked by most
// kills, then fastest WIN (best_time_ms, only set on a run that reached the cap).
// Account-only and SEPARATE from career stats — it never touches K/D. The match
// is offline (vs a bot) so scores are client-reported + clamped (best-effort,
// like career stats); the stakes are a cosmetic weekly board.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_weekly_challenge (
  player_id    TEXT NOT NULL,
  week_key     TEXT NOT NULL,
  user_name    TEXT NOT NULL,
  best_kills   INTEGER NOT NULL DEFAULT 0,
  best_time_ms INTEGER NOT NULL DEFAULT 0,  -- fastest winning run (0 = never won)
  runs         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, week_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_challenge ON instagib_weekly_challenge(week_key, best_kills);
`);

const wcRowStmt = sqlite.prepare(
  `SELECT * FROM instagib_weekly_challenge WHERE player_id = ? AND week_key = ?`,
);
const wcEnsureStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO instagib_weekly_challenge (player_id, week_key, user_name, updated_at)
  VALUES (@playerId, @weekKey, @userName, @now)`);
const wcUpdateStmt = sqlite.prepare(`
  UPDATE instagib_weekly_challenge
     SET user_name = @userName, best_kills = @bestKills, best_time_ms = @bestTimeMs,
         runs = runs + 1, updated_at = @now
   WHERE player_id = @playerId AND week_key = @weekKey`);
// SPEEDRUN order: anyone who beat the bots (best_time_ms > 0) ranks above anyone
// who didn't, fastest win first; non-winners then rank by most kills. Recency
// breaks any remaining tie.
const WC_ORDER = `ORDER BY
  (CASE WHEN best_time_ms > 0 THEN 0 ELSE 1 END) ASC,
  (CASE WHEN best_time_ms > 0 THEN best_time_ms ELSE 9.0e18 END) ASC,
  best_kills DESC,
  updated_at ASC`;
const wcLeaderboardStmt = sqlite.prepare(
  `SELECT * FROM instagib_weekly_challenge WHERE week_key = ? ${WC_ORDER} LIMIT ?`,
);
// Count entries strictly ahead of (@timeMs, @kills): every winner beats a
// non-winner; among winners the faster one beats; among non-winners more kills
// beats. @timeMs <= 0 means the caller is a non-winner.
const wcRankStmt = sqlite.prepare(`
  SELECT COUNT(*) AS n FROM instagib_weekly_challenge
   WHERE week_key = @weekKey AND (
     (best_time_ms > 0 AND (@timeMs <= 0 OR best_time_ms < @timeMs))
     OR
     (best_time_ms = 0 AND @timeMs <= 0 AND best_kills > @kills)
   )`);

// ── Weekly-challenge REPLAYS ─────────────────────────────────────────────────
// The full recorded run for a player's board-defining run, so anyone can rewatch
// it (transparency / anti-cheat). One row per (player, week); overwritten when a
// player sets a new board-defining run. The blob is the gzipped replay-codec
// binary. Storage is bounded by pruning every week but the current one on write.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_weekly_replay (
  player_id   TEXT NOT NULL,
  week_key    TEXT NOT NULL,
  data        BLOB NOT NULL,       -- gzipped replay-codec binary
  raw_bytes   INTEGER NOT NULL,    -- uncompressed size
  duration_ms INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  won         INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, week_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_replay_week ON instagib_weekly_replay(week_key);
`);

const wrUpsertStmt = sqlite.prepare(`
  INSERT INTO instagib_weekly_replay
    (player_id, week_key, data, raw_bytes, duration_ms, kills, won, created_at)
  VALUES (@playerId, @weekKey, @data, @rawBytes, @durationMs, @kills, @won, @createdAt)
  ON CONFLICT(player_id, week_key) DO UPDATE SET
    data = @data, raw_bytes = @rawBytes, duration_ms = @durationMs,
    kills = @kills, won = @won, created_at = @createdAt`);
const wrGetStmt = sqlite.prepare(
  `SELECT data, raw_bytes, duration_ms, kills, won FROM instagib_weekly_replay
    WHERE player_id = ? AND week_key = ?`,
);
const wrPruneStmt = sqlite.prepare(`DELETE FROM instagib_weekly_replay WHERE week_key != ?`);
const wrWeekPlayersStmt = sqlite.prepare(
  `SELECT player_id FROM instagib_weekly_replay WHERE week_key = ?`,
);

// Store (gzip) a player's board-defining run for the week, overwriting any prior
// one, and prune replays from previous weeks (keeps the table ~one week deep).
export function storeWeeklyReplay(
  playerId: string,
  raw: Uint8Array,
  meta: { durationMs: number; kills: number; won: boolean },
  now: number = Date.now(),
): void {
  if (!playerId || raw.length === 0) return;
  const wk = weekKey(now);
  const gz = zlib.gzipSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  wrUpsertStmt.run({
    playerId,
    weekKey: wk,
    data: gz,
    rawBytes: raw.length,
    durationMs: Math.max(0, Math.floor(meta.durationMs)),
    kills: Math.max(0, Math.floor(meta.kills)),
    won: meta.won ? 1 : 0,
    createdAt: now,
  });
  wrPruneStmt.run(wk);
}

// Fetch + gunzip a player's stored run for the week. Returns the raw replay-codec
// bytes (ready to decode) or null.
export function getWeeklyReplay(
  playerId: string,
  now: number = Date.now(),
): { data: Buffer; durationMs: number; kills: number; won: boolean } | null {
  if (!playerId) return null;
  const row = wrGetStmt.get(playerId, weekKey(now)) as
    | { data: Buffer; raw_bytes: number; duration_ms: number; kills: number; won: number }
    | undefined;
  if (!row) return null;
  try {
    return {
      data: zlib.gunzipSync(row.data),
      durationMs: row.duration_ms,
      kills: row.kills,
      won: !!row.won,
    };
  } catch {
    return null;
  }
}

// Player ids with a stored replay this week (for the leaderboard's Watch flag).
function weeklyReplayPlayerIds(weekKeyStr: string): Set<string> {
  const rows = wrWeekPlayersStmt.all(weekKeyStr) as { player_id: string }[];
  return new Set(rows.map((r) => r.player_id));
}

type WcRow = {
  player_id: string;
  week_key: string;
  user_name: string;
  best_kills: number;
  best_time_ms: number;
  runs: number;
  updated_at: number;
};

export type WeeklyChallengeEntry = {
  id: string;
  userName: string;
  kills: number;
  timeMs: number; // best winning time, 0 = never beat the bots
  won: boolean;
  runs: number;
  admin: boolean;
  verified: boolean;
  hasReplay: boolean; // a rewatchable run is stored for this player this week
};
export type WeeklyChallengeMe = WeeklyChallengeEntry & { rank: number };

// Record a challenge run, keeping the player's BEST for the week: the fastest
// WINNING time (the speedrun), plus most kills (the fallback for runs that never
// beat the bots). Account-only. Also reports whether THIS run is now the player's
// board-defining run — if so the caller should store its replay (so the stored
// replay always matches the row shown on the leaderboard).
export function recordWeeklyChallenge(
  playerId: string,
  userName: string,
  kills: number,
  won: boolean,
  timeMs: number,
  now: number = Date.now(),
): { me: WeeklyChallengeMe; acceptReplay: boolean } | null {
  if (!playerId) return null;
  const wk = weekKey(now);
  wcEnsureStmt.run({ playerId, weekKey: wk, userName, now });
  const cur = wcRowStmt.get(playerId, wk) as WcRow;
  const isWin = won && timeMs > 0;
  const bestKills = Math.max(cur.best_kills, kills);
  const bestTimeMs = isWin
    ? cur.best_time_ms > 0
      ? Math.min(cur.best_time_ms, timeMs)
      : timeMs
    : cur.best_time_ms;
  wcUpdateStmt.run({ playerId, weekKey: wk, userName, bestKills, bestTimeMs, now });
  const rank =
    num(wcRankStmt.get({ weekKey: wk, kills: bestKills, timeMs: bestTimeMs })) + 1;
  // The board shows a player's fastest win if they've ever won, else their
  // most-kills loss. This run becomes the defining run when it's a new best win,
  // or — for a player who has never won — a new best-kills loss.
  const neverWonBefore = cur.best_time_ms === 0;
  const isNewBestWin = isWin && (cur.best_time_ms === 0 || timeMs < cur.best_time_ms);
  const isNewBestKillsLoss = !isWin && neverWonBefore && kills > cur.best_kills;
  const acceptReplay = isNewBestWin || isNewBestKillsLoss;
  return {
    me: {
      id: playerId,
      userName,
      kills: bestKills,
      timeMs: bestTimeMs,
      won: bestTimeMs > 0,
      runs: cur.runs + 1,
      rank,
      admin: false,
      verified: false,
      hasReplay: false,
    },
    acceptReplay,
  };
}

function toWcEntry(r: WcRow): WeeklyChallengeEntry {
  return {
    id: r.player_id,
    userName: r.user_name,
    kills: r.best_kills,
    timeMs: r.best_time_ms,
    won: r.best_time_ms > 0,
    runs: r.runs,
    admin: false,
    verified: false,
    hasReplay: false,
  };
}

export function getWeeklyChallengeLeaderboard(
  limit: number,
  now: number = Date.now(),
): WeeklyChallengeEntry[] {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const wk = weekKey(now);
  const rows = wcLeaderboardStmt.all(wk, n) as WcRow[];
  const base = rows.map(toWcEntry);
  if (base.length) {
    const ph = base.map(() => '?').join(',');
    const flags = sqlite
      .prepare(`SELECT id, is_admin, is_verified FROM instagib_users WHERE id IN (${ph})`)
      .all(...base.map((e) => e.id)) as { id: string; is_admin: number; is_verified: number }[];
    const byId = new Map(flags.map((f) => [f.id, f]));
    const withReplay = weeklyReplayPlayerIds(wk);
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = !!f.is_admin;
        e.verified = !!f.is_verified;
      }
      e.hasReplay = withReplay.has(e.id);
    }
  }
  return base;
}

export function getWeeklyChallengeMe(
  playerId: string,
  now: number = Date.now(),
): WeeklyChallengeMe | null {
  if (!playerId) return null;
  const wk = weekKey(now);
  const r = wcRowStmt.get(playerId, wk) as WcRow | undefined;
  if (!r) return null;
  const rank =
    num(wcRankStmt.get({ weekKey: wk, kills: r.best_kills, timeMs: r.best_time_ms })) + 1;
  const entry = toWcEntry(r);
  entry.hasReplay = weeklyReplayPlayerIds(wk).has(playerId);
  return { ...entry, rank };
}
