// SQLite-backed stats store. Self-contained: no ORM, just better-sqlite3 with
// prepared statements. The table is created on first import (CREATE TABLE IF
// NOT EXISTS), so there are no migrations to run.

import fs from 'node:fs';
import path from 'node:path';
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
};

export function getProfile(playerId: string): Profile {
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const totalXp = prog?.total_xp ?? 0;
  const lp = levelProgress(totalXp);
  return {
    level: lp.level,
    totalXp,
    xpIntoLevel: lp.xpIntoLevel,
    xpForNext: lp.xpForNext,
    credits: prog?.credits ?? 0,
    unlocked: [...ownedSet(prog, playerId)],
    equipped: parseEquipped(prog?.equipped),
    stats: getStats(playerId),
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
