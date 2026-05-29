// SQLite-backed stats store. Self-contained: no ORM, just better-sqlite3 with
// prepared statements. The table is created on first import (CREATE TABLE IF
// NOT EXISTS), so there are no migrations to run.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
  now: number;
};

export function getStats(playerId: string): PublicStats {
  return toPublic(selectStmt.get(playerId) as Row | undefined);
}

export function recordMatch(delta: MatchDelta): PublicStats {
  return toPublic(upsertStmt.get(delta) as Row | undefined);
}

// --- Global leaderboard -----------------------------------------------------

export type LeaderboardEntry = {
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number; // totalDeaths > 0 ? kills/deaths : kills, rounded to 2dp
};

// One prepared statement per sort column so we never interpolate user input
// into SQL — the router whitelists `sort`, and we pick a stmt from this map.
// kills uses the existing idx_instagib_stats_kills index; all tiebreak on
// total_kills DESC. We only surface players who have actually played a match
// (total_games > 0). `limit` is bound as a parameter (and clamped by callers).
const LEADERBOARD_COLS = `user_name, total_kills, total_deaths, total_games,
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
     WHERE total_games > 0
     ORDER BY best_accuracy DESC, total_kills DESC
     LIMIT ?`),
} as const;

type LeaderboardRow = Row & { user_name: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toLeaderboardEntry = (row: LeaderboardRow): LeaderboardEntry => ({
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
});

export function getLeaderboard(opts: {
  sort: 'kills' | 'wins' | 'accuracy';
  limit: number;
}): LeaderboardEntry[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const stmt = leaderboardStmts[opts.sort] ?? leaderboardStmts.kills;
  const rows = stmt.all(limit) as LeaderboardRow[];
  return rows.map(toLeaderboardEntry);
}
