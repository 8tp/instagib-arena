// Shapes + tiny helpers shared by the menu panels (Ranked, Weekly Challenge,
// Leaderboard, Stats) and the in-match code that submits / reports the same data.

// One row on the weekly-challenge board (GET /api/challenge/weekly/leaderboard).
export type WeeklyChallengeEntry = {
  id: string;
  userName: string;
  kills: number;
  timeMs: number; // best winning time (0 = never beat the bots)
  won: boolean;
  runs: number;
  admin: boolean;
  verified: boolean;
  hasReplay: boolean; // a rewatchable run is stored this week
};
export type WeeklyChallengeMe = WeeklyChallengeEntry & { rank: number };

// mm:ss.s from a millisecond duration (for the challenge win time).
export function fmtChallengeTime(ms: number): string {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
}

// Shared profile shape from GET /api/ranked/me (mirrors server db.ts RankedProfile).
export type RankedProfile = {
  id: string;
  userName: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  rank: number;
  provisional: boolean;
};
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

// Starting Elo for a brand-new ranked player (mirrors server RANKED_BASE_RATING).
export const RANKED_BASE = 1000;
