// Daily / weekly challenges — THREE-free, shared by client (labels) and server
// (rotation + tracking). Cosmetic-economy only: challenges award bonus XP +
// credits, never power. See docs/progression.md §7.
//
// Definitions are a static manifest; the DB only stores per-player progress
// (instagib_challenges). Which challenges are "active" for a player in a given
// period is derived deterministically from (player_id, period) — no scheduler.

export type ChallengePeriod = 'daily' | 'weekly';
export type ChallengeMetric = 'kills' | 'headshots' | 'wins' | 'streak' | 'games';
// How a match's metric folds into progress: 'add' accumulates across matches,
// 'max' keeps the best single match (e.g. a kill-streak).
export type ChallengeTrack = 'add' | 'max';

export type ChallengeDef = {
  id: string; // 'daily:headshots'
  period: ChallengePeriod;
  metric: ChallengeMetric;
  track: ChallengeTrack;
  goal: number;
  title: string;
  rewardXp: number;
  rewardCredits: number;
};

export const DAILY_CHALLENGES: readonly ChallengeDef[] = [
  { id: 'daily:headshots', period: 'daily', metric: 'headshots', track: 'add', goal: 10, title: 'Land 10 headshots',      rewardXp: 80,  rewardCredits: 8 },
  { id: 'daily:wins',      period: 'daily', metric: 'wins',      track: 'add', goal: 2,  title: 'Win 2 matches',          rewardXp: 100, rewardCredits: 10 },
  { id: 'daily:kills',     period: 'daily', metric: 'kills',     track: 'add', goal: 30, title: 'Frag 30 enemies',        rewardXp: 80,  rewardCredits: 8 },
  { id: 'daily:streak',    period: 'daily', metric: 'streak',    track: 'max', goal: 6,  title: 'Reach a 6 kill-streak',  rewardXp: 90,  rewardCredits: 9 },
  { id: 'daily:games',     period: 'daily', metric: 'games',     track: 'add', goal: 3,  title: 'Play 3 matches',         rewardXp: 60,  rewardCredits: 6 },
];

export const WEEKLY_CHALLENGES: readonly ChallengeDef[] = [
  { id: 'weekly:headshots', period: 'weekly', metric: 'headshots', track: 'add', goal: 50,  title: 'Land 50 headshots',  rewardXp: 300, rewardCredits: 40 },
  { id: 'weekly:wins',      period: 'weekly', metric: 'wins',      track: 'add', goal: 10,  title: 'Win 10 matches',     rewardXp: 400, rewardCredits: 60 },
  { id: 'weekly:kills',     period: 'weekly', metric: 'kills',     track: 'add', goal: 200, title: 'Frag 200 enemies',   rewardXp: 300, rewardCredits: 40 },
];

export const DAILY_COUNT = 3; // active daily challenges per player
export const WEEKLY_COUNT = 2; // active weekly challenges per player

const ALL_BY_ID = new Map<string, ChallengeDef>(
  [...DAILY_CHALLENGES, ...WEEKLY_CHALLENGES].map((c) => [c.id, c]),
);
export function challengeById(id: string): ChallengeDef | undefined {
  return ALL_BY_ID.get(id);
}

// UTC period keys. Daily = YYYYMMDD; weekly = a stable 7-day bucket index so we
// don't need ISO-week math (deterministic + timezone-independent).
export function dailyPeriod(now: number): string {
  const d = new Date(now);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${m}${day}`;
}
export function weeklyPeriod(now: number): string {
  return `w${Math.floor(now / 86_400_000 / 7)}`;
}

// FNV-1a → unsigned 32-bit, for deterministic per-player rotation.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The active challenges for a player in a period: a stable pseudo-random subset
// of the pool, keyed by (playerId, period) so it's per-player and rotates over
// time without any stored schedule.
export function activeChallenges(
  playerId: string,
  pool: readonly ChallengeDef[],
  period: string,
  count: number,
): ChallengeDef[] {
  return [...pool]
    .map((c) => ({ c, k: fnv1a(`${playerId}|${period}|${c.id}`) }))
    .sort((a, b) => a.k - b.k || a.c.id.localeCompare(b.c.id))
    .slice(0, count)
    .map((x) => x.c);
}
