// End-of-match rewards reveal — the pure half: turn the server's reward payload
// (ProgressionResp, with or without the RewardExtras breakdown) into what the
// reveal shows, and lay the sequence out on a timeline. No React, no DOM.
import type { ProgressionResp } from '../../app-types';
import type { MatchResult } from '../../game/game';
import { cosmeticById, type Rarity } from '../../game/cosmetics';
import {
  MAX_LEVEL,
  OFFLINE_XP_SCALE,
  XP_ACCURACY_MAX,
  XP_BASE,
  XP_PER_HEADSHOT,
  XP_PER_KILL,
  XP_PER_STREAK,
  XP_WIN_BONUS,
  levelForXp,
  totalXpForLevel,
  type ChallengeCompletion,
  type RoadStep,
  type XpLine,
} from '../../game/progression';

export type RevealLine = XpLine & { running: number }; // running total after this line

// One pass of the XP bar within a level: `from`/`to` are 0..1 fills. A segment
// with `levelUp` ends by wrapping into `level + 1`.
export type BarSegment = { level: number; from: number; to: number; levelUp: boolean };

export type RevealCard =
  | { kind: 'cosmetic'; key: string; level: number; id: string; rarity: Rarity }
  | { kind: 'credits'; key: string; level: number; amount: number }
  | { kind: 'case'; key: string; level: number };

export type RevealModel = {
  saved: boolean; // false → guest: "you would have earned"
  offline: boolean;
  legacy: boolean; // no server breakdown (today's server) — lines were estimated
  xp: number;
  credits: number;
  lines: RevealLine[];
  levelBefore: number;
  levelAfter: number;
  totalBefore: number;
  totalAfter: number;
  segments: BarSegment[];
  skippedLevels: number; // wraps folded out of a very long level run
  cards: RevealCard[];
  challenges: ChallengeCompletion[];
  balance: number | null; // credit balance after the match (saved players only)
};

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
export function rarityRank(r: Rarity): number {
  return RARITY_RANK[r];
}

// Fill of `total` XP within `level` (0..1). Max level reads as full.
function fillWithin(total: number, level: number): number {
  if (level >= MAX_LEVEL) return 1;
  const lo = totalXpForLevel(level);
  const hi = totalXpForLevel(level + 1);
  if (hi <= lo) return 1;
  return Math.max(0, Math.min(1, (total - lo) / (hi - lo)));
}

// Level span readout for the bar caption: XP into the level / XP the level costs.
export function levelSpan(total: number, level: number): { into: number; span: number } {
  if (level >= MAX_LEVEL) return { into: 0, span: 0 };
  const lo = totalXpForLevel(level);
  return { into: Math.max(0, total - lo), span: totalXpForLevel(level + 1) - lo };
}

const MAX_WRAPS = 6;

function buildSegments(before: number, after: number, lvBefore: number, lvAfter: number) {
  const all: BarSegment[] = [];
  for (let lv = lvBefore; lv <= lvAfter; lv++) {
    all.push({
      level: lv,
      from: lv === lvBefore ? fillWithin(before, lv) : 0,
      to: lv === lvAfter ? fillWithin(after, lv) : 1,
      levelUp: lv < lvAfter,
    });
  }
  // A huge jump (first match after a big grant) would be a long wait: keep the
  // first wraps and the landing, fold the middle into the last stamp.
  if (all.length <= MAX_WRAPS) return { segments: all, skipped: 0 };
  const keep = [...all.slice(0, MAX_WRAPS - 2), ...all.slice(-2)];
  return { segments: keep, skipped: all.length - keep.length };
}

// Legacy servers send only the total: estimate the itemized lines from the
// match result with the same constants the server uses, and reconcile any
// difference (offline scale, first-win bonus, caps) into one honest line so
// the rows always add up to the real total.
function estimateLines(xp: number, result: MatchResult | null, offline: boolean): XpLine[] {
  if (!result) return xp > 0 ? [{ key: 'base', label: 'Match XP', xp }] : [];
  const acc = result.shotsFired > 0 ? (result.shotsHit / result.shotsFired) * 100 : 0;
  const accXp = Math.round((Math.max(0, Math.min(100, acc)) / 100) * XP_ACCURACY_MAX);
  const lines: XpLine[] = [{ key: 'base', label: 'Match played', xp: XP_BASE }];
  if (result.kills > 0) lines.push({ key: 'kills', label: 'Frags', xp: result.kills * XP_PER_KILL, detail: `${result.kills} × ${XP_PER_KILL}` });
  if (result.headshots > 0)
    lines.push({ key: 'headshots', label: 'Headshots', xp: result.headshots * XP_PER_HEADSHOT, detail: `${result.headshots} × ${XP_PER_HEADSHOT}` });
  if (result.bestStreak > 0)
    lines.push({ key: 'streak', label: 'Best streak', xp: result.bestStreak * XP_PER_STREAK, detail: `${result.bestStreak} × ${XP_PER_STREAK}` });
  if (result.won) lines.push({ key: 'win', label: 'Victory', xp: XP_WIN_BONUS });
  if (accXp > 0) lines.push({ key: 'accuracy', label: 'Accuracy', xp: accXp, detail: `${Math.round(acc)}%` });
  let sum = lines.reduce((s, l) => s + l.xp, 0);
  if (offline && sum > 0) {
    const scaled = Math.floor(sum * OFFLINE_XP_SCALE);
    lines.push({ key: 'offline', label: 'Offline practice', xp: scaled - sum, detail: `× ${OFFLINE_XP_SCALE}` });
    sum = scaled;
  }
  const diff = xp - sum;
  if (diff > 0) lines.push({ key: 'firstWin', label: 'Bonus', xp: diff });
  else if (diff < 0) lines.push({ key: 'cap', label: 'Adjusted', xp: diff });
  return lines;
}

export function buildRevealModel(
  p: ProgressionResp,
  opts: { result?: MatchResult | null; offline?: boolean } = {},
): RevealModel {
  const xp = Math.max(0, p.xpGained | 0);
  const saved = p.saved !== false;
  const offline = p.offline ?? opts.offline ?? false;
  const legacy = !p.xpLines;
  // Guests are never persisted, so `progression.totalXp` may not include this
  // match: derive "after" from "before" + the gain for them.
  const totalBefore = Math.max(0, p.totalXpBefore ?? p.progression.totalXp - xp);
  const totalAfter = saved ? Math.max(totalBefore, p.progression.totalXp) : totalBefore + xp;
  const levelBefore = p.levelBefore ?? levelForXp(totalBefore);
  const levelAfter = Math.max(levelBefore, levelForXp(totalAfter));

  const raw = p.xpLines ?? estimateLines(xp, opts.result ?? null, offline);
  let running = 0;
  const lines: RevealLine[] = raw
    .filter((l) => l.xp !== 0)
    .map((l) => {
      running += l.xp;
      return { ...l, running };
    });

  const { segments, skipped } = buildSegments(totalBefore, totalAfter, levelBefore, levelAfter);

  const steps: RoadStep[] =
    p.roadRewards ??
    (p.newUnlocks.length > 0
      ? [{ level: levelAfter, rewards: p.newUnlocks.map((id) => ({ type: 'cosmetic' as const, id })) }]
      : []);
  const cards: RevealCard[] = [];
  for (const step of steps) {
    step.rewards.forEach((r, i) => {
      const key = `${step.level}:${i}`;
      if (r.type === 'cosmetic') {
        cards.push({ kind: 'cosmetic', key, level: step.level, id: r.id, rarity: cosmeticById(r.id)?.rarity ?? 'common' });
      } else if (r.type === 'credits') {
        cards.push({ kind: 'credits', key, level: step.level, amount: r.amount });
      } else {
        cards.push({ kind: 'case', key, level: step.level });
      }
    });
  }

  return {
    saved,
    offline,
    legacy,
    xp,
    credits: Math.max(0, p.creditsGained | 0),
    lines,
    levelBefore,
    levelAfter,
    totalBefore,
    totalAfter,
    segments,
    skippedLevels: skipped,
    cards,
    challenges: p.challenges ?? [],
    balance: saved ? p.progression.credits : null,
  };
}

/* ── Timeline ───────────────────────────────────────────────────────────── */

export type RevealTimeline = {
  start: number;
  lineAt: number[];
  totalAt: number;
  seg: { start: number; end: number }[]; // fill runs start → end; a level-up lands at end
  cardAt: number[];
  challengeAt: number[];
  creditsAt: number;
  ctaAt: number;
  doneAt: number;
};

// ms from mount. The header stamp owns the first ~0.7 s.
export function buildTimeline(m: RevealModel, startMs = 750): RevealTimeline {
  let t = startMs;
  const lineGap = m.lines.length > 8 ? 190 : 260;
  const lineAt = m.lines.map((_, i) => t + i * lineGap);
  t += Math.max(1, m.lines.length) * lineGap;
  const totalAt = t;
  t += 320;

  const seg: RevealTimeline['seg'] = [];
  const speed = m.segments.length > 3 ? 0.6 : 1;
  for (const s of m.segments) {
    const dist = Math.max(0, s.to - s.from);
    const dur = Math.round(Math.max(260, 900 * dist) * speed);
    seg.push({ start: t, end: t + dur });
    t += dur + (s.levelUp ? 720 : 0);
  }
  t += 260;

  const cardAt: number[] = [];
  for (const c of m.cards) {
    // A beat of anticipation before the rarer drops.
    if (c.kind === 'cosmetic' && c.rarity === 'legendary') t += 260;
    cardAt.push(t);
    t += c.kind === 'cosmetic' ? (c.rarity === 'legendary' ? 900 : c.rarity === 'epic' ? 620 : 420) : 360;
  }
  if (m.cards.length) t += 160;

  const challengeAt = m.challenges.map((_, i) => t + i * 320);
  t += m.challenges.length * 320;
  if (m.challenges.length) t += 120;

  const creditsAt = t;
  t += m.credits > 0 ? 820 : 300;
  const ctaAt = t;
  const doneAt = t + 200;
  return { start: startMs, lineAt, totalAt, seg, cardAt, challengeAt, creditsAt, ctaAt, doneAt };
}
