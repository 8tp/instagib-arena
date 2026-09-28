// Progression math — THREE-free, shared by the client (to render the XP bar,
// level thresholds and the Career Road) and the server (to compute XP / level /
// credits / road grants authoritatively). Cosmetic-only progression: XP and
// credits unlock visuals, never power. See docs/progression.md.
//
// IMPORTANT: keep this module deterministic and free of runtime dependencies
// other than the (equally THREE-free) cosmetic manifest, which the Career Road
// is derived from. The server includes it via tsconfig.server.json.
//
// Trust model: ONLINE matches are recorded by the authoritative WS game server
// (server/instagib-game.ts) from server-known counters — the client reports
// nothing. The public POST /api/stats is OFFLINE-only (bots/practice): its
// inputs are client-reported, so it is server-clamped, scaled down and capped
// per UTC day (OFFLINE_DAILY_XP_CAP). The XP number itself is never client-sent.

import { ALL_COSMETICS } from './cosmetics';

export const MAX_LEVEL = 100;

// ── Level curve ──────────────────────────────────────────────────────────────
// XP needed to advance FROM level n TO n+1: a flat linear ramp. At ~200 XP per
// match that is L10 ≈ 19 matches, L25 ≈ 92, L50 ≈ 325, L100 ≈ 1,213
// (docs/progression.md §3 pacing table). Level is ALWAYS derived from total XP —
// re-tuning the curve is a pure code change (players simply re-level).
export const XP_LEVEL_BASE = 200;
export const XP_LEVEL_STEP = 45;

export function xpForLevel(n: number): number {
  return XP_LEVEL_BASE + XP_LEVEL_STEP * Math.max(1, Math.floor(n));
}

// LEVEL_XP[L] = cumulative XP required to REACH level L (L = 1..MAX_LEVEL).
const LEVEL_XP: readonly number[] = (() => {
  const t = [0, 0];
  for (let l = 2; l <= MAX_LEVEL; l++) t[l] = t[l - 1] + xpForLevel(l - 1);
  return t;
})();

// Cumulative XP required to REACH level n (reaching level 1 costs 0). Clamped
// to [1, MAX_LEVEL].
export function totalXpForLevel(n: number): number {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(n)));
  return LEVEL_XP[l];
}

// Level for a given lifetime XP total (capped at MAX_LEVEL). XP keeps
// accruing past the cap (it still earns credits); the level just stops.
export function levelForXp(totalXp: number): number {
  const xp = Number.isFinite(totalXp) ? totalXp : 0;
  let lo = 1;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= LEVEL_XP[mid]) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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

// ── Per-match XP ─────────────────────────────────────────────────────────────
export type MatchXpInput = {
  kills: number;
  headshots: number;
  bestStreak: number;
  won: boolean;
  accuracy: number; // 0..100
  // Shots behind `accuracy`. The accuracy bonus needs ≥ ACCURACY_MIN_SHOTS so a
  // 1-shot/1-hit "100%" match earns nothing. Omitted → treated as enough.
  shotsFired?: number;
  // 0..1 share of the flat base XP earned — online partial matches (joined late
  // / left early) scale by time present so join-leave spam earns ~nothing.
  presence?: number;
};

export type MatchXpContext = {
  offline: boolean; // bots/practice: scaled by OFFLINE_XP_SCALE, no first-win bonus
  firstWin: boolean; // server-decided: an online win and the first one today (UTC)
  // Offline XP still allowed today (OFFLINE_DAILY_XP_CAP minus what's been
  // earned). Undefined = no daily cap applies (online, or a guest preview).
  offlineXpLeft?: number;
};

export const XP_BASE = 25;
export const XP_PER_KILL = 10;
export const XP_PER_HEADSHOT = 6;
export const XP_PER_STREAK = 4;
export const XP_WIN_BONUS = 60;
export const XP_ACCURACY_MAX = 40;
export const XP_FIRST_WIN_BONUS = 150;
export const ACCURACY_MIN_SHOTS = 20; // accuracy bonus + best-accuracy stat need this many shots
// Offline (bots) is practice, not the optimal farm: a strong win vs easy bots
// (25 kills) lands ~130 XP — under an average online match (~175–200).
export const OFFLINE_XP_SCALE = 0.3;
export const OFFLINE_DAILY_XP_CAP = 1500; // per account per UTC day, then 0
export const PER_MATCH_XP_CAP = 1500; // backstop against pathological inputs
export const CREDITS_PER_XP = 0.1; // match credits ≈ match xp / 10

export function creditsForXp(xp: number): number {
  return Math.floor(Math.max(0, xp) * CREDITS_PER_XP);
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
  label: string; // "Kills", "First win of the day", "Daily: Land 10 headshots"…
  xp: number; // signed
  detail?: string; // "12 × 10", "43% accuracy"…
};

const fmt = (n: number): string => n.toLocaleString('en-US');

// The itemized XP for one match, in display order (base → kills → headshots →
// streak → win → accuracy → offline scale → first win → caps). `xp` is the sum
// of the lines (≥ 0). Challenge lines are appended by the server after this.
export function matchXpLines(d: MatchXpInput, ctx: MatchXpContext): { xp: number; lines: XpLine[] } {
  const lines: XpLine[] = [];
  const int = (v: number) => Math.max(0, Math.floor(Number.isFinite(v) ? v : 0));
  const kills = int(d.kills);
  const headshots = int(d.headshots);
  const streak = int(d.bestStreak);
  const presence = d.presence == null ? 1 : Math.max(0, Math.min(1, d.presence));

  const base = Math.round(XP_BASE * presence);
  lines.push({ key: 'base', label: 'Match played', xp: base, detail: presence < 1 ? 'partial match' : undefined });
  if (kills > 0) lines.push({ key: 'kills', label: 'Kills', xp: kills * XP_PER_KILL, detail: `${kills} × ${XP_PER_KILL}` });
  if (headshots > 0)
    lines.push({ key: 'headshots', label: 'Headshots', xp: headshots * XP_PER_HEADSHOT, detail: `${headshots} × ${XP_PER_HEADSHOT}` });
  if (streak > 0)
    lines.push({ key: 'streak', label: 'Best streak', xp: streak * XP_PER_STREAK, detail: `${streak} × ${XP_PER_STREAK}` });
  if (d.won) lines.push({ key: 'win', label: 'Victory', xp: XP_WIN_BONUS });
  const acc = Math.max(0, Math.min(100, Number.isFinite(d.accuracy) ? d.accuracy : 0));
  const enoughShots = d.shotsFired == null || d.shotsFired >= ACCURACY_MIN_SHOTS;
  const accXp = enoughShots ? Math.round((acc / 100) * XP_ACCURACY_MAX) : 0;
  if (accXp > 0) lines.push({ key: 'accuracy', label: 'Accuracy', xp: accXp, detail: `${Math.round(acc)}% accuracy` });

  let xp = lines.reduce((s, l) => s + l.xp, 0);
  if (ctx.offline) {
    const scaled = Math.floor(xp * OFFLINE_XP_SCALE);
    if (scaled < xp) {
      lines.push({ key: 'offline', label: 'Practice vs bots', xp: scaled - xp, detail: `× ${OFFLINE_XP_SCALE}` });
      xp = scaled;
    }
  } else if (ctx.firstWin) {
    lines.push({ key: 'firstWin', label: 'First win of the day', xp: XP_FIRST_WIN_BONUS });
    xp += XP_FIRST_WIN_BONUS;
  }
  if (xp > PER_MATCH_XP_CAP) {
    lines.push({ key: 'cap', label: 'Match cap', xp: PER_MATCH_XP_CAP - xp, detail: `${fmt(PER_MATCH_XP_CAP)} XP per match` });
    xp = PER_MATCH_XP_CAP;
  }
  if (ctx.offlineXpLeft != null) {
    const left = Math.max(0, Math.floor(ctx.offlineXpLeft));
    if (xp > left) {
      lines.push({ key: 'cap', label: 'Daily practice cap', xp: left - xp, detail: `${fmt(OFFLINE_DAILY_XP_CAP)} XP per day vs bots` });
      xp = left;
    }
  }
  return { xp: Math.max(0, xp), lines };
}

// The unscaled per-match XP (no offline scale, first win or caps). Kept for
// callers that just want the headline number.
export function baseMatchXp(d: MatchXpInput): number {
  return matchXpLines(d, { offline: false, firstWin: false }).lines.reduce((s, l) => s + l.xp, 0);
}

// One Career Road reward. Every level on the road grants at least one.
export type RoadReward =
  | { type: 'cosmetic'; id: string }
  | { type: 'credits'; amount: number }
  | { type: 'case' }; // one free hat-case opening (a "case key")

export type RoadStep = { level: number; rewards: RoadReward[] };

// A daily/weekly challenge completed (and auto-granted) by this match.
export type ChallengeCompletion = { id: string; label: string; xp: number; credits: number };

export type RewardExtras = {
  saved: boolean; // false for guests: computed so the UI can show what they'd earn, never persisted
  offline: boolean;
  xpLines: XpLine[];
  levelBefore: number;
  totalXpBefore: number;
  // Career Road steps granted by this call, ascending. Normally levelBefore+1 …
  // levelAfter; can start lower when it also pays out a catch-up (road_level
  // behind the XP-derived level, e.g. after a curve change).
  roadRewards: RoadStep[];
  challenges: ChallengeCompletion[];
};

// ── Career Road ──────────────────────────────────────────────────────────────
// Level → rewards, levels 2..MAX_LEVEL, every level grants ≥ 1 reward. The road
// is DERIVED from the cosmetic manifest: every `{ type: 'level', level: N }`
// cosmetic sits at exactly level N (move an item by editing its source in
// cosmetics.ts). Other levels are filled with credits, every CASE_KEY_EVERY-th
// level adds a free hat-case key, and every ROAD_BONUS_EVERY-th level adds a
// milestone credit bonus. Asserted at module load (see buildRoad).
export const CASE_KEY_EVERY = 10;
export const ROAD_BONUS_EVERY = 25;

// Credits for a road level that has no cosmetic: scales with level, doubled on
// every 5th level so the rhythm has beats.
export function roadFillerCredits(level: number): number {
  const raw = 40 + 3 * level;
  const amt = Math.round(raw / 10) * 10;
  return level % 5 === 0 ? amt * 2 : amt;
}
// Milestone bonus at L25/50/75/100 (on top of whatever else the level holds).
export function roadMilestoneCredits(level: number): number {
  return level % ROAD_BONUS_EVERY === 0 ? (level / ROAD_BONUS_EVERY) * 500 : 0;
}

function buildRoad(): RoadStep[] {
  const byLevel = new Map<number, string[]>();
  for (const c of ALL_COSMETICS) {
    if (c.source.type !== 'level') continue;
    const l = c.source.level;
    if (!Number.isInteger(l) || l < 2 || l > MAX_LEVEL) {
      throw new Error(`[progression] ${c.id}: level source ${l} is off the Career Road (2..${MAX_LEVEL})`);
    }
    const list = byLevel.get(l) ?? [];
    list.push(c.id);
    byLevel.set(l, list);
  }
  const road: RoadStep[] = [];
  for (let level = 2; level <= MAX_LEVEL; level++) {
    const rewards: RoadReward[] = [];
    const cosmetics = byLevel.get(level) ?? [];
    for (const id of cosmetics) rewards.push({ type: 'cosmetic', id });
    if (level % CASE_KEY_EVERY === 0) rewards.push({ type: 'case' });
    const credits = (cosmetics.length === 0 ? roadFillerCredits(level) : 0) + roadMilestoneCredits(level);
    if (credits > 0) rewards.push({ type: 'credits', amount: credits });
    if (rewards.length === 0) throw new Error(`[progression] Career Road level ${level} has no reward`);
    road.push({ level, rewards });
  }
  return road;
}

export const CAREER_ROAD: readonly RoadStep[] = buildRoad();
const ROAD_BY_LEVEL: readonly (RoadStep | undefined)[] = (() => {
  const a: (RoadStep | undefined)[] = [];
  for (const s of CAREER_ROAD) a[s.level] = s;
  return a;
})();

export function roadStepAt(level: number): RoadStep | undefined {
  return ROAD_BY_LEVEL[level];
}

// Road steps in (fromLevel, toLevel], ascending — what a level-up (or a
// catch-up from a stale road_level) grants.
export function roadStepsBetween(fromLevel: number, toLevel: number): RoadStep[] {
  const out: RoadStep[] = [];
  const lo = Math.max(2, Math.floor(fromLevel) + 1);
  const hi = Math.min(MAX_LEVEL, Math.floor(toLevel));
  for (let l = lo; l <= hi; l++) {
    const s = ROAD_BY_LEVEL[l];
    if (s) out.push(s);
  }
  return out;
}
