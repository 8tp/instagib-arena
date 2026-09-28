// Menu-side views of the progression data: the Career Road track (level →
// rewards) and the challenge reset clocks. Pure, THREE-free.
//
// The road comes from CAREER_ROAD (src/game/progression.ts). While that is
// empty, the track still shows every level, filled with the cosmetics that
// already unlock at a level (catalog `source: { type: 'level' }`) and a
// "Rewards coming" placeholder elsewhere — so it degrades to something true.

import { ALL_COSMETICS, cosmeticById, type CosmeticSlot } from '../game/cosmetics';
import { CAREER_ROAD, MAX_LEVEL, type RoadReward, type RoadStep } from '../game/progression';
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

const SLOT_NOUN: Record<CosmeticSlot, string> = {
  killEffect: 'finisher',
  railColor: 'rail beam',
  railgunFinish: 'railgun finish',
  hat: 'hat',
  unusual: 'unusual effect',
  card: 'playercard',
  emote: 'emote',
  nameColor: 'name colour',
  spawnEffect: 'spawn effect',
  title: 'title',
  announcer: 'announcer pack',
};

// "Epic railgun finish" / "Credits" / "Free roll" — the kind line under a
// reward's name.
export function rewardKind(r: RoadReward): string {
  if (r.type === 'credits') return 'Credits';
  if (r.type === 'case') return (r.count ?? 1) > 1 ? `${r.count} free case rolls` : 'Free case roll';
  const c = cosmeticById(r.id);
  if (!c) return 'Cosmetic';
  const rarity = c.rarity.charAt(0).toUpperCase() + c.rarity.slice(1);
  return `${rarity} ${SLOT_NOUN[c.slot] ?? 'cosmetic'}`;
}

// Short text for a reward (tooltips, the profile block's next-reward line).
export function rewardText(r: RoadReward, name?: (id: string) => string | undefined): string {
  if (r.type === 'credits') return `${r.amount.toLocaleString()} credits`;
  if (r.type === 'case') return (r.count ?? 1) > 1 ? `${r.count} free rolls` : 'Free roll';
  return name?.(r.id) ?? r.id;
}

// The next level (above `level`) that grants something, and what.
export function nextRoadStep(level: number): RoadNode | null {
  for (const n of careerRoad()) if (n.level > level && n.rewards.length > 0) return n;
  return null;
}

// Fields the progression track adds to /api/profile; optional so an older
// server (or a guest) still renders.
export type MenuProfile = InstagibProfile & {
  caseKeys?: number; // == freeRolls (back-compat alias)
  freeRolls?: number; // unspent free case rolls (v3)
  roadLevel?: number; // highest Career Road level granted
  catchUp?: RoadStep[]; // road steps granted by this fetch (e.g. after a curve change)
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
  metric?: string; // wins / kills / headshots / games / streak / accuracy (icon)
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

// When a period's challenges roll over. Server-provided `resetsAt` wins; the
// fallback is next UTC midnight (daily) / next Monday 00:00 UTC (weekly).
export function resetTime(period: 'daily' | 'weekly', lists: ChallengeLists | null, now: number): number {
  const r = lists?.resetsAt;
  if (typeof r === 'number' && r > now && period === 'daily') return r;
  if (r && typeof r === 'object') {
    const v = r[period];
    if (typeof v === 'number' && v > now) return v;
  }
  const row = lists?.[period]?.find((c) => typeof c.resetsAt === 'number' && c.resetsAt > now);
  if (row?.resetsAt) return row.resetsAt;
  if (period === 'daily') return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  // Epoch day 0 was a Thursday, so Mondays are days ≡ 4 (mod 7).
  const day = Math.floor(now / DAY_MS);
  const monday = Math.floor((day - 4) / 7) * 7 + 4;
  return (monday + 7) * DAY_MS;
}

// Road steps the server granted on this profile fetch, reported once per
// session (the menu toasts them).
const seenCatchUp = new Set<string>();
export function freshCatchUp(p: MenuProfile): RoadStep[] {
  const steps = Array.isArray(p.catchUp) ? p.catchUp : [];
  const key = steps.map((s) => s.level).join(',');
  if (!key || seenCatchUp.has(key)) return [];
  seenCatchUp.add(key);
  return steps;
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

// The next roll-over of either period (the lists are stale after it).
export function nextReset(lists: ChallengeLists | null, now: number): number {
  return Math.min(resetTime('daily', lists, now), resetTime('weekly', lists, now));
}

export type ChallengeState = 'claimable' | 'done' | 'active';

// Complete + unclaimed = claim it; complete + claimed (or auto-granted) = done.
export function challengeState(c: ChallengeView): ChallengeState {
  if (c.complete && !c.claimed) return 'claimable';
  if (c.complete || c.claimed) return 'done';
  return 'active';
}

/* ── Last match XP (lobby banner) ───────────────────────────────────────── */

// Per-match gain for the banner — ONLY from the server's reward for that match
// (never a profile diff, which would sum several rounds). Guests' rewards are
// computed but not saved, so they show none.
export type MatchGain = { xp: number; credits: number; levelBefore: number; levelAfter: number };

export function gainFrom(
  p: { xpGained: number; creditsGained: number; leveledUp: boolean; saved?: boolean; levelBefore?: number; progression: { level: number } } | null,
): MatchGain | null {
  if (!p || p.saved === false || p.xpGained <= 0) return null;
  const levelAfter = p.progression.level;
  const levelBefore = p.levelBefore ?? (p.leveledUp ? levelAfter - 1 : levelAfter);
  return { xp: p.xpGained, credits: p.creditsGained, levelBefore, levelAfter };
}
