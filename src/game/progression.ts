// Progression math — THREE-free, shared by the client (to render the XP bar and
// level thresholds) and the server (to compute level/credits authoritatively).
// Cosmetic-only progression: XP and credits unlock visuals, never power. See
// docs/progression.md §3.
//
// IMPORTANT: keep this module dependency-free and deterministic. The server adds
// it to tsconfig.server.json's include list and derives XP/level/credits from
// the match delta. Trust model: this is a client-authoritative game with no
// in-match anti-cheat, so the *inputs* (kills/headshots/streak/won/accuracy) are
// client-reported and server-CLAMPED + cross-validated (server/stats.ts) — the
// XP number itself is never client-reported. Stakes are low: cosmetic-only,
// self-affecting. Hardening path: record online matches from the authoritative
// WS server (server/instagib-game.ts) instead of the public POST. See ROADMAP
// "Anti-cheat / integrity".

export const MAX_LEVEL = 100;

// XP needed to advance FROM level n TO n+1. A mild super-linear curve: early
// levels are quick, later ones a slow burn (L1→2 = 100, L10→11 ≈ 3162).
export function xpForLevel(n: number): number {
  return Math.floor(100 * Math.pow(n, 1.5));
}

// Cumulative XP required to REACH level n (reaching level 1 costs 0).
export function totalXpForLevel(n: number): number {
  let sum = 0;
  for (let i = 1; i < n; i++) sum += xpForLevel(i);
  return sum;
}

// Level for a given lifetime XP total (capped at MAX_LEVEL).
export function levelForXp(totalXp: number): number {
  let lvl = 1;
  while (lvl < MAX_LEVEL && totalXp >= totalXpForLevel(lvl + 1)) lvl++;
  return lvl;
}

export type LevelProgress = {
  level: number;
  totalXp: number;
  xpIntoLevel: number; // XP earned past the current level's threshold
  xpForNext: number; // XP span of the current level (0 at max level)
};

// Where a player sits within their current level — drives the XP bar fill.
export function levelProgress(totalXp: number): LevelProgress {
  const level = levelForXp(totalXp);
  const floor = totalXpForLevel(level);
  const xpForNext = level >= MAX_LEVEL ? 0 : xpForLevel(level);
  return { level, totalXp, xpIntoLevel: totalXp - floor, xpForNext };
}

// Per-match XP from the (already server-clamped) match outcome. First-win and
// offline scaling are applied by the server on top of this base (it owns the
// date state + the offline flag). See docs/progression.md §3.
export type MatchXpInput = {
  kills: number;
  headshots: number;
  bestStreak: number;
  won: boolean;
  accuracy: number; // 0..100
};

export const XP_BASE = 25;
export const XP_PER_KILL = 10;
export const XP_PER_HEADSHOT = 6;
export const XP_PER_STREAK = 4;
export const XP_WIN_BONUS = 60;
export const XP_ACCURACY_MAX = 40;
export const XP_FIRST_WIN_BONUS = 150;
export const OFFLINE_XP_SCALE = 0.5; // practice still rewards, but isn't the optimal farm
export const PER_MATCH_XP_CAP = 1500; // backstop against pathological inputs
export const CREDITS_PER_XP = 0.1; // credits ≈ xp / 10

export function baseMatchXp(d: MatchXpInput): number {
  const acc = Math.max(0, Math.min(100, d.accuracy));
  const accuracyBonus = Math.round((acc / 100) * XP_ACCURACY_MAX);
  return (
    XP_BASE +
    d.kills * XP_PER_KILL +
    d.headshots * XP_PER_HEADSHOT +
    d.bestStreak * XP_PER_STREAK +
    (d.won ? XP_WIN_BONUS : 0) +
    accuracyBonus
  );
}

export function creditsForXp(xp: number): number {
  return Math.floor(xp * CREDITS_PER_XP);
}

// ── Reward contract (server → client), shared by the results screen ─────────
// The server returns these alongside the legacy { xpGained, creditsGained,
// leveledUp, newUnlocks, progression } fields — for the offline POST
// /api/stats reply and the online WS `progression` push alike.

export type XpLineKey =
  | 'base'
  | 'kills'
  | 'headshots'
  | 'streak'
  | 'win'
  | 'accuracy'
  | 'firstWin'
  | 'challenge'
  | 'offline' // the offline scale-down (a negative line)
  | 'cap'; // a per-match/per-day cap trim (a negative line)

// One itemized row of the end-of-match XP breakdown, in display order.
export type XpLine = {
  key: XpLineKey;
  label: string; // "Kills", "First win of the day", "Daily: 10 headshots"…
  xp: number; // signed
  detail?: string; // "12 × 10", "43% accuracy"…
};

// One Career Road reward. Every level on the road grants at least one.
export type RoadReward =
  | { type: 'cosmetic'; id: string }
  | { type: 'credits'; amount: number }
  | { type: 'case' }; // one free hat-case opening

export type RoadStep = { level: number; rewards: RoadReward[] };

// A daily/weekly challenge completed (and auto-granted) by this match.
export type ChallengeCompletion = { id: string; label: string; xp: number; credits: number };

export type RewardExtras = {
  saved: boolean; // false for guests: computed so the UI can show what they'd earn, never persisted
  offline: boolean;
  xpLines: XpLine[];
  levelBefore: number;
  totalXpBefore: number;
  roadRewards: RoadStep[]; // Career Road steps reached by this match (levelBefore+1 … levelAfter)
  challenges: ChallengeCompletion[];
};

// The Career Road: level → rewards. Filled in by the progression track.
export const CAREER_ROAD: readonly RoadStep[] = [];

export function roadStepAt(level: number): RoadStep | undefined {
  return CAREER_ROAD.find((s) => s.level === level);
}
