// /rewardslab — harness for the end-of-match results + rewards reveal: fake
// payloads, no match needed. Dev-only, not linked anywhere in the UI.
//
//   ?case=levelup|multi|guest|offline|plain|legacy   (default levelup)
//   ?online=1        the online variant (auto-advance countdown; loops back)
//   ?won=0|1         override the case's Victory/Defeat
//   ?at=MS           freeze the reveal clock MS after mount (deterministic shots)
//   ?hold=MS         freeze the clock AND pause every CSS animation MS after
//                    mount — a true mid-animation frame (e.g. a level stamp)
//   ?skip=1          skip to the end state (as if Space was pressed) after 900 ms
//   ?late=MS         the server reply lands MS after the panel opens
//   ?pending=1       the reply never lands (placeholder → "no rewards")
//   ?reduced=1       reducedEffects on
//   ?login=0         no onLogin wiring (guest CTA falls back to a note)
//   ?clean=1         hide the lab caption
import { useEffect, useMemo, useState } from 'react';
import type { ProgressionResp, Settings } from '../app-types';
import type { MatchResult } from '../game/game';
import type { PlayerScore } from '../game/types';
import { creditsForXp, levelForXp, totalXpForLevel, type RewardExtras, type XpLine } from '../game/progression';
import { MatchOverOverlay, OnlineMatchResults } from './results';

type LabCase = 'levelup' | 'multi' | 'guest' | 'offline' | 'plain' | 'legacy';
const CASES: LabCase[] = ['levelup', 'multi', 'guest', 'offline', 'plain', 'legacy'];

// A point `frac` of the way through `level` on the live curve (so the lab never
// hard-codes thresholds the progression track may retune).
function xpAt(level: number, frac: number): number {
  const lo = totalXpForLevel(level);
  const hi = totalXpForLevel(level + 1);
  return Math.round(lo + (hi - lo) * frac);
}

function sum(lines: XpLine[]): number {
  return lines.reduce((s, l) => s + l.xp, 0);
}

function payload(
  base: { before: number; lines: XpLine[]; extraCredits?: number; newUnlocks?: string[] },
  extras: Partial<RewardExtras> | null,
): ProgressionResp {
  const xp = sum(base.lines);
  const after = base.before + xp;
  const credits = creditsForXp(xp) + (base.extraCredits ?? 0);
  const saved = extras?.saved !== false;
  const levelBefore = levelForXp(base.before);
  const levelAfter = levelForXp(after);
  const resp: ProgressionResp = {
    xpGained: xp,
    creditsGained: credits,
    leveledUp: levelAfter > levelBefore,
    newUnlocks: base.newUnlocks ?? [],
    progression: {
      totalXp: saved ? after : base.before,
      level: saved ? levelAfter : levelBefore,
      credits: 1480 + (saved ? credits : 0),
      unlocked: [],
      equipped: {},
    },
  };
  if (!extras) return resp;
  return {
    ...resp,
    saved: true,
    offline: false,
    xpLines: base.lines,
    levelBefore,
    totalXpBefore: base.before,
    roadRewards: [],
    challenges: [],
    ...extras,
  };
}

const MATCH: MatchResult = { won: true, kills: 18, deaths: 7, bestStreak: 6, headshots: 5, shotsFired: 44, shotsHit: 18 };

function buildCase(c: LabCase): { won: boolean; result: MatchResult; progression: ProgressionResp } {
  switch (c) {
    case 'levelup': {
      const lines: XpLine[] = [
        { key: 'base', label: 'Match played', xp: 25 },
        { key: 'kills', label: 'Frags', xp: 180, detail: '18 × 10' },
        { key: 'headshots', label: 'Headshots', xp: 30, detail: '5 × 6' },
        { key: 'streak', label: 'Best streak', xp: 24, detail: '6 × 4' },
        { key: 'win', label: 'Victory', xp: 60 },
        { key: 'accuracy', label: 'Accuracy', xp: 16, detail: '41%' },
        { key: 'firstWin', label: 'First win of the day', xp: 150 },
        { key: 'challenge', label: 'Daily: land 5 headshots', xp: 100 },
      ];
      const lvl = 6;
      const before = xpAt(lvl + 1, 0) - Math.round(sum(lines) * 0.62);
      return {
        won: true,
        result: MATCH,
        progression: payload(
          { before, lines, extraCredits: 175 },
          {
            roadRewards: [{ level: lvl + 1, rewards: [{ type: 'cosmetic', id: 'hat.tophat' }, { type: 'credits', amount: 150 }] }],
            challenges: [{ id: 'daily-hs', label: 'Daily · Land 5 headshots', xp: 100, credits: 25 }],
          },
        ),
      };
    }
    case 'multi': {
      const lines: XpLine[] = [
        { key: 'base', label: 'Match played', xp: 25 },
        { key: 'kills', label: 'Frags', xp: 250, detail: '25 × 10' },
        { key: 'headshots', label: 'Headshots', xp: 66, detail: '11 × 6' },
        { key: 'streak', label: 'Best streak', xp: 48, detail: '12 × 4' },
        { key: 'win', label: 'Victory', xp: 60 },
        { key: 'accuracy', label: 'Accuracy', xp: 23, detail: '58%' },
        { key: 'firstWin', label: 'First win of the day', xp: 150 },
        { key: 'challenge', label: 'Daily: win a match', xp: 150 },
        { key: 'challenge', label: 'Weekly: 100 frags', xp: 400 },
      ];
      const lvl = 2;
      const target = xpAt(lvl + 3, 0.35);
      // Scale the lines so the gain spans exactly three wraps on this curve.
      const want = target - xpAt(lvl, 0.55);
      const k = want / sum(lines);
      const scaled = lines.map((l) => ({ ...l, xp: Math.max(1, Math.round(l.xp * k)) }));
      const before = target - sum(scaled);
      return {
        won: true,
        result: { ...MATCH, kills: 25, headshots: 11, bestStreak: 12 },
        progression: payload(
          { before, lines: scaled, extraCredits: 400 },
          {
            roadRewards: [
              { level: lvl + 1, rewards: [{ type: 'cosmetic', id: 'rail.plasma' }] },
              { level: lvl + 2, rewards: [{ type: 'case' }, { type: 'cosmetic', id: 'gun.gold' }] },
              { level: lvl + 3, rewards: [{ type: 'cosmetic', id: 'prism' }, { type: 'credits', amount: 250 }] },
            ],
            challenges: [
              { id: 'daily-win', label: 'Daily · Win a match', xp: 150, credits: 30 },
              { id: 'weekly-frags', label: 'Weekly · 100 frags', xp: 400, credits: 120 },
            ],
          },
        ),
      };
    }
    case 'guest': {
      const lines: XpLine[] = [
        { key: 'base', label: 'Match played', xp: 25 },
        { key: 'kills', label: 'Frags', xp: 120, detail: '12 × 10' },
        { key: 'headshots', label: 'Headshots', xp: 18, detail: '3 × 6' },
        { key: 'streak', label: 'Best streak', xp: 16, detail: '4 × 4' },
        { key: 'accuracy', label: 'Accuracy', xp: 14, detail: '35%' },
      ];
      return {
        won: false,
        result: { ...MATCH, won: false, kills: 12, headshots: 3, bestStreak: 4 },
        progression: payload(
          { before: 0, lines },
          { saved: false, roadRewards: levelForXp(sum(lines)) > 1 ? [{ level: 2, rewards: [{ type: 'cosmetic', id: 'nova' }] }] : [] },
        ),
      };
    }
    case 'offline': {
      const full: XpLine[] = [
        { key: 'base', label: 'Match played', xp: 25 },
        { key: 'kills', label: 'Frags', xp: 200, detail: '20 × 10' },
        { key: 'headshots', label: 'Headshots', xp: 42, detail: '7 × 6' },
        { key: 'streak', label: 'Best streak', xp: 32, detail: '8 × 4' },
        { key: 'win', label: 'Victory', xp: 60 },
        { key: 'accuracy', label: 'Accuracy', xp: 19, detail: '47%' },
      ];
      const t = sum(full);
      const lines = [...full, { key: 'offline' as const, label: 'Offline practice', xp: Math.floor(t * 0.5) - t, detail: '× 0.5' }];
      return {
        won: true,
        result: { ...MATCH, kills: 20, headshots: 7, bestStreak: 8 },
        progression: payload({ before: xpAt(9, 0.18), lines }, { offline: true }),
      };
    }
    case 'plain': {
      const lines: XpLine[] = [
        { key: 'base', label: 'Match played', xp: 25 },
        { key: 'kills', label: 'Frags', xp: 90, detail: '9 × 10' },
        { key: 'headshots', label: 'Headshots', xp: 12, detail: '2 × 6' },
        { key: 'streak', label: 'Best streak', xp: 12, detail: '3 × 4' },
        { key: 'accuracy', label: 'Accuracy', xp: 11, detail: '28%' },
      ];
      return {
        won: false,
        result: { ...MATCH, won: false, kills: 9, deaths: 14, headshots: 2, bestStreak: 3 },
        progression: payload({ before: xpAt(14, 0.3), lines }, {}),
      };
    }
    case 'legacy': {
      // Today's server: totals only, no breakdown — the lines are estimated.
      const lines: XpLine[] = [{ key: 'base', label: 'x', xp: 25 + 180 + 30 + 24 + 60 + 16 }];
      const before = xpAt(4, 0.8);
      const resp = payload({ before, lines, newUnlocks: levelForXp(before + sum(lines)) > 4 ? ['rail.toxic'] : [] }, null);
      return { won: true, result: MATCH, progression: resp };
    }
  }
}

const NAMES = ['Razor', 'Kestrel', 'Nyx', 'Halcyon', 'Vex', 'Orbit', 'Tamsin', 'Quill'];

function fakeScores(won: boolean): PlayerScore[] {
  const frags = [25, 21, 18, 15, 12, 9, 7, 4];
  const youAt = won ? 0 : 2;
  return frags.map((f, i) => ({
    id: `p${i}`,
    name: i === youAt ? 'You' : NAMES[i],
    isLocal: i === youAt,
    frags: f,
    deaths: 6 + ((i * 5) % 11),
    bestStreak: Math.max(1, Math.round(f / 4)),
    currentStreak: 0,
    accuracy: 30 + ((i * 7) % 25),
    hat: ['hat.crown', 'hat.tophat', 'hat.wizard', 'hat.cap', 'hat.propeller', 'hat.hardhat', 'hat.graduation', 'hat.baseball'][i],
    emote: ['emote.cheer', 'emote.dance', 'emote.wave', 'emote.flex', 'emote.salute', 'emote.cheer', 'emote.dance', 'emote.wave'][i],
  }));
}

export default function RewardsLab() {
  const q = useMemo(() => new URLSearchParams(window.location.search), []);
  const labCase = (CASES.includes(q.get('case') as LabCase) ? q.get('case') : 'levelup') as LabCase;
  const online = q.get('online') === '1';
  const hold = q.get('hold') !== null ? Number(q.get('hold')) : undefined;
  const at = hold ?? (q.get('at') !== null ? Number(q.get('at')) : undefined);
  const late = Number(q.get('late') ?? 0);
  const pending = q.get('pending') === '1';
  const reduced = q.get('reduced') === '1';
  const clean = q.get('clean') === '1';
  const withLogin = q.get('login') !== '0';

  const c = useMemo(() => buildCase(labCase), [labCase]);
  const won = q.get('won') !== null ? q.get('won') === '1' : c.won;
  const scores = useMemo(() => fakeScores(won), [won]);
  const settings = useMemo(
    () => ({ hat: 'hat.crown', emote: 'emote.cheer', reducedEffects: reduced }) as Settings,
    [reduced],
  );

  const [run, setRun] = useState(0);
  const [prog, setProg] = useState<ProgressionResp | null>(!pending && late <= 0 ? c.progression : null);
  useEffect(() => {
    if (pending || late <= 0) return;
    const id = window.setTimeout(() => setProg(c.progression), late);
    return () => window.clearTimeout(id);
  }, [c, late, pending, run]);
  useEffect(() => {
    if (q.get('skip') !== '1') return;
    const id = window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' })), 900);
    return () => window.clearTimeout(id);
  }, [q, run]);

  useEffect(() => {
    if (hold === undefined) return;
    const id = window.setTimeout(() => document.getAnimations().forEach((a) => a.pause()), hold);
    return () => window.clearTimeout(id);
  }, [hold, run]);

  const restart = () => {
    setProg(!pending && late <= 0 ? c.progression : null);
    setRun((r) => r + 1);
  };

  return (
    <div className='fixed inset-0 bg-[radial-gradient(circle_at_50%_30%,#1a2230,#07090d)] text-white'>
      {online ? (
        <OnlineMatchResults
          key={run}
          won={won}
          scores={scores}
          settings={settings}
          result={c.result}
          progression={prog}
          onContinue={restart}
          onLogin={withLogin ? () => alert('onLogin') : undefined}
          revealFreezeAt={at}
        />
      ) : (
        <MatchOverOverlay
          key={run}
          won={won}
          scores={scores}
          settings={settings}
          result={c.result}
          progression={prog}
          onPlayAgain={restart}
          onLobby={restart}
          onLogin={withLogin ? () => alert('onLogin') : undefined}
          revealFreezeAt={at}
        />
      )}
      {!clean && (
        <div className='pointer-events-none fixed bottom-2 left-3 z-50 font-mono text-[11px] text-white/35'>
          rewardslab · case={labCase} · {CASES.map((x) => `?case=${x}`).join(' ')} · &amp;online=1 &amp;at=ms &amp;skip=1
        </div>
      )}
    </div>
  );
}
