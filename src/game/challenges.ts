// Daily / weekly challenges — THREE-free, shared by client (labels) and server
// (rotation + tracking). Cosmetic-economy only: challenges award bonus XP +
// credits, never power. Progress comes only from ONLINE matches recorded by the
// game server, and a completed challenge is paid out automatically by the match
// that completes it (server/db.ts recordMatch). See docs/progression.md §6.
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
  { id: 'daily:headshots', period: 'daily', metric: 'headshots', track: 'add', goal: 10, title: 'Land 10 headshots',      rewardXp: 80,  rewardCredits: 25 },
  { id: 'daily:wins',      period: 'daily', metric: 'wins',      track: 'add', goal: 2,  title: 'Win 2 matches',          rewardXp: 100, rewardCredits: 30 },
  { id: 'daily:kills',     period: 'daily', metric: 'kills',     track: 'add', goal: 30, title: 'Frag 30 enemies',        rewardXp: 80,  rewardCredits: 25 },
  { id: 'daily:streak',    period: 'daily', metric: 'streak',    track: 'max', goal: 6,  title: 'Reach a 6 kill-streak',  rewardXp: 90,  rewardCredits: 25 },
  { id: 'daily:games',     period: 'daily', metric: 'games',     track: 'add', goal: 3,  title: 'Play 3 matches',         rewardXp: 60,  rewardCredits: 20 },
];

export const WEEKLY_CHALLENGES: readonly ChallengeDef[] = [
  { id: 'weekly:headshots', period: 'weekly', metric: 'headshots', track: 'add', goal: 50,  title: 'Land 50 headshots',  rewardXp: 300, rewardCredits: 120 },
  { id: 'weekly:wins',      period: 'weekly', metric: 'wins',      track: 'add', goal: 10,  title: 'Win 10 matches',     rewardXp: 400, rewardCredits: 150 },
  { id: 'weekly:kills',     period: 'weekly', metric: 'kills',     track: 'add', goal: 200, title: 'Frag 200 enemies',   rewardXp: 300, rewardCredits: 120 },
];

export const DAILY_COUNT = 3; // active daily challenges per player
export const WEEKLY_COUNT = 2; // active weekly challenges per player

const ALL_BY_ID = new Map<string, ChallengeDef>(
  [...DAILY_CHALLENGES, ...WEEKLY_CHALLENGES].map((c) => [c.id, c]),
);
export function challengeById(id: string): ChallengeDef | undefined {
  return ALL_BY_ID.get(id);
}

// UTC period keys. Daily = YYYYMMDD; weekly = `w` + YYYYMMDD of the week's
// Monday — the same Monday 00:00 UTC boundary as the weekly leaderboard
// (server/db.ts weekKey), so "this week" means one thing everywhere.
const DAY_MS = 86_400_000;
function ymdUtc(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${m}${day}`;
}
// 00:00 UTC of the day containing `now`.
function dayStartUtc(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}
// 00:00 UTC of the Monday that starts the week containing `now`.
export function weekStartUtc(now: number): number {
  const start = dayStartUtc(now);
  const dow = (new Date(start).getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  return start - dow * DAY_MS;
}
export function dailyPeriod(now: number): string {
  return ymdUtc(now);
}
export function weeklyPeriod(now: number): string {
  return `w${ymdUtc(weekStartUtc(now))}`;
}
// When the current daily / weekly set rotates (ms epoch) — for the UI countdown.
export function dailyResetsAt(now: number): number {
  return dayStartUtc(now) + DAY_MS;
}
export function weeklyResetsAt(now: number): number {
  return weekStartUtc(now) + 7 * DAY_MS;
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
