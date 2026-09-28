// Menu-side views of the progression data: the Career Road track (level →
// rewards) and the challenge reset clocks. Pure, THREE-free.
//
// The road comes from CAREER_ROAD (src/game/progression.ts). While that is
// empty, the track still shows every level, filled with the cosmetics that
// already unlock at a level (catalog `source: { type: 'level' }`) and a
// "Rewards coming" placeholder elsewhere — so it degrades to something true.

import { ALL_COSMETICS } from '../game/cosmetics';
import { CAREER_ROAD, MAX_LEVEL, type RoadReward } from '../game/progression';
import type { InstagibProfile } from '../app-types';

export type RoadNode = { level: number; rewards: RoadReward[] };

let cachedRoad: RoadNode[] | null = null;
let cachedFrom: readonly unknown[] | null = null;

export function careerRoad(): RoadNode[] {
  if (cachedRoad && cachedFrom === CAREER_ROAD) return cachedRoad;
  const byLevel = new Map<number, RoadReward[]>();
  if (CAREER_ROAD.length > 0) {
    for (const step of CAREER_ROAD) {
      const list = byLevel.get(step.level) ?? [];
      list.push(...step.rewards);
      byLevel.set(step.level, list);
    }
  } else {
    for (const c of ALL_COSMETICS) {
      if (c.source.type !== 'level') continue;
      const list = byLevel.get(c.source.level) ?? [];
      list.push({ type: 'cosmetic', id: c.id });
      byLevel.set(c.source.level, list);
    }
  }
  const out: RoadNode[] = [];
  for (let level = 1; level <= MAX_LEVEL; level++) out.push({ level, rewards: byLevel.get(level) ?? [] });
  cachedRoad = out;
  cachedFrom = CAREER_ROAD;
  return out;
}

// Short text for a reward (tooltips, the profile block's next-reward line).
export function rewardText(r: RoadReward, name?: (id: string) => string | undefined): string {
  if (r.type === 'credits') return `${r.amount.toLocaleString()} credits`;
  if (r.type === 'case') return 'Case key';
  return name?.(r.id) ?? r.id;
}

// The next level (above `level`) that grants something, and what.
export function nextRoadStep(level: number): RoadNode | null {
  for (const n of careerRoad()) if (n.level > level && n.rewards.length > 0) return n;
  return null;
}

// Fields the progression track is adding to /api/profile; optional until then.
export type MenuProfile = InstagibProfile & {
  caseKeys?: number;
  road?: unknown;
};

export function xpFraction(p: Pick<InstagibProfile, 'xpIntoLevel' | 'xpForNext'> | null): number {
  if (!p) return 0;
  if (p.xpForNext <= 0) return 1;
  return Math.max(0, Math.min(1, p.xpIntoLevel / p.xpForNext));
}

/* ── Challenges ─────────────────────────────────────────────────────────── */

export type ChallengeView = {
  id: string;
  title: string;
  period: 'daily' | 'weekly';
  goal: number;
  progress: number;
  claimed: boolean;
  complete: boolean;
  rewardXp: number;
  rewardCredits: number;
  resetsAt?: number; // optional per-row reset (ms epoch)
};

export type ChallengeLists = {
  daily: ChallengeView[];
  weekly: ChallengeView[];
  // Optional reset clock the progression track is adding (ms epoch).
  resetsAt?: { daily?: number; weekly?: number } | number;
};

const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;

// When a period's challenges roll over. Server-provided `resetsAt` wins; the
// fallback mirrors the server's own period keys (src/game/challenges.ts):
// daily = next UTC midnight, weekly = the next epoch-week boundary.
export function resetTime(period: 'daily' | 'weekly', lists: ChallengeLists | null, now: number): number {
  const r = lists?.resetsAt;
  if (typeof r === 'number' && r > now && period === 'daily') return r;
  if (r && typeof r === 'object') {
    const v = r[period];
    if (typeof v === 'number' && v > now) return v;
  }
  const row = lists?.[period]?.find((c) => typeof c.resetsAt === 'number' && c.resetsAt > now);
  if (row?.resetsAt) return row.resetsAt;
  const span = period === 'daily' ? DAY_MS : WEEK_MS;
  return (Math.floor(now / span) + 1) * span;
}

// "5h 12m", "3d 4h", "42m", "under a minute".
export function fmtCountdown(ms: number): string {
  if (ms <= 60_000) return 'under a minute';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

export type ChallengeState = 'claimable' | 'done' | 'active';

// Complete + unclaimed = claim it; complete + claimed (or auto-granted) = done.
export function challengeState(c: ChallengeView): ChallengeState {
  if (c.complete && !c.claimed) return 'claimable';
  if (c.complete || c.claimed) return 'done';
  return 'active';
}

/* ── Last match XP (lobby banner) ───────────────────────────────────────── */

// The lobby remounts after every match, so it can't remember what the profile
// looked like before. This module-level snapshot survives the remount: the
// banner shows the difference between it and the fresh post-match profile.
let lastSeen: { level: number; totalXp: number; credits: number } | null = null;

export type MatchGain = { xp: number; credits: number; levelBefore: number; levelAfter: number };

export function noteProfile(p: MenuProfile, afterMatch: boolean): MatchGain | null {
  const prev = lastSeen;
  lastSeen = { level: p.level, totalXp: p.totalXp, credits: p.credits };
  if (!afterMatch || !prev) return null;
  const xp = p.totalXp - prev.totalXp;
  if (xp <= 0) return null;
  return { xp, credits: Math.max(0, p.credits - prev.credits), levelBefore: prev.level, levelAfter: p.level };
}
