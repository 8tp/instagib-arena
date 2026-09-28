// /rewardslab — harness for the end-of-match results + rewards reveal: fake
// payloads, no match needed. Dev-only, not linked anywhere in the UI.
//
//   ?case=levelup|multi|catchup|guest|offline|plain|legacy   (default levelup)
//        catchup = an existing player after the curve change: Career Road steps
//        from well below levelBefore are granted at once (a dense card deal)
//   ?online=1        the online variant (auto-advance countdown; loops back)
//   ?mode=ffa|tdm|duel  the board + headline (FFA = placement, else Victory/Defeat)
//   ?name=NAME       your name on the board (default Wraith; "You" = no tag)
//   ?won=0|1         override the case's win
//   ?at=MS           freeze the reveal clock MS after mount (deterministic shots)
//   ?hold=MS         freeze the clock AND pause every CSS animation MS after
//                    mount — a true mid-animation frame. Also a named moment:
//                    hold=takeover | bar | cards (from this case's timeline)
//   ?skip=1          skip to the end state (as if Space was pressed) after 900 ms
//   ?late=MS         the server reply lands MS after the panel opens
//   ?pending=1       the reply never lands (placeholder → "no rewards")
//   ?reduced=1       reducedEffects on
//   ?login=0         no onLogin wiring (guest CTA falls back to a note)
//   ?clean=1         hide the lab caption
//   ?hud=1           the in-match XP ticker instead: a fake frag every 0.9 s
//                    (every 3rd a headshot) beside a crosshair + centre-print
import { useEffect, useMemo, useState } from 'react';
import type { ProgressionResp, Settings } from '../app-types';
import type { MatchResult } from '../game/game';
import type { KillConfirm, PlayerScore } from '../game/types';
import { FragPopup } from '../game/kill-overlays';
import { XpTicker } from './hud-quake';
import {
  creditsForXp,
  levelForXp,
  matchXpLines,
  roadStepsBetween,
  totalXpForLevel,
  type ChallengeCompletion,
  type XpLine,
} from '../game/progression';
import { MatchOverOverlay, OnlineMatchResults } from './results';
import { buildRevealModel, buildTimeline } from './rewards/reveal-model';

type LabCase = 'levelup' | 'multi' | 'catchup' | 'guest' | 'offline' | 'plain' | 'legacy';
const CASES: LabCase[] = ['levelup', 'multi', 'catchup', 'guest', 'offline', 'plain', 'legacy'];

// One self-consistent fake match: the scoreboard, the stat strip, the XP lines
// and the Career Road all derive from the same MatchResult via the REAL
// progression code (matchXpLines / roadStepsBetween / creditsForXp), so the
// payload has exactly the server's shape and numbers on the live curve.
type LabSpec = {
  result: MatchResult;
  place: number; // your rank on the 8-player board (1 = won the FFA)
  before: { level: number; frac: number }; // where the XP bar started
  offline?: boolean;
  firstWin?: boolean;
  saved?: boolean;
  challenges?: ChallengeCompletion[];
  roadFrom?: number; // Career Road level already granted (catch-up when < level)
  legacy?: boolean; // today's-server reply: totals only, no breakdown
};

type LabMatch = { won: boolean; place: number; result: MatchResult; progression: ProgressionResp };

// A point `frac` of the way through `level` on the live curve.
function xpAt(level: number, frac: number): number {
  const lo = totalXpForLevel(level);
  const hi = totalXpForLevel(level + 1);
  return Math.round(lo + (hi - lo) * frac);
}

function buildMatch(spec: LabSpec): LabMatch {
  const r = spec.result;
  const accuracy = r.shotsFired > 0 ? (r.shotsHit / r.shotsFired) * 100 : 0;
  const match = matchXpLines(
    { kills: r.kills, headshots: r.headshots, bestStreak: r.bestStreak, won: r.won, accuracy, shotsFired: r.shotsFired },
    { offline: !!spec.offline, firstWin: !!spec.firstWin && !spec.offline && r.won },
  );
  const challenges = spec.challenges ?? [];
  const lines: XpLine[] = [
    ...match.lines,
    ...challenges.map((c) => ({ key: 'challenge' as const, label: c.label, xp: c.xp, detail: `+${c.credits} credits` })),
  ];
  const xp = lines.reduce((n, l) => n + l.xp, 0);
  const before = xpAt(spec.before.level, spec.before.frac);
  const after = before + xp;
  const levelBefore = levelForXp(before);
  const levelAfter = levelForXp(after);
  const roadRewards = roadStepsBetween(spec.roadFrom ?? levelBefore, levelAfter);
  const roadCredits = roadRewards.reduce(
    (n, st) => n + st.rewards.reduce((m, rw) => m + (rw.type === 'credits' ? rw.amount : 0), 0),
    0,
  );
  const credits = creditsForXp(match.xp) + challenges.reduce((n, c) => n + c.credits, 0) + roadCredits;
  const saved = spec.saved !== false;
  const base: ProgressionResp = {
    xpGained: xp,
    creditsGained: credits,
    leveledUp: levelAfter > levelBefore,
    newUnlocks: roadRewards.flatMap((st) => st.rewards.flatMap((rw) => (rw.type === 'cosmetic' ? [rw.id] : []))),
    mode: 'ffa',
    progression: {
      totalXp: saved ? after : before,
      level: saved ? levelAfter : levelBefore,
      credits: 1480 + (saved ? credits : 0),
      unlocked: [],
      equipped: {},
    },
  };
  const progression: ProgressionResp = spec.legacy
    ? base
    : {
        ...base,
        saved,
        offline: !!spec.offline,
        xpLines: lines,
        levelBefore,
        totalXpBefore: before,
        roadRewards,
        challenges,
      };
  return { won: r.won, place: spec.place, result: r, progression };
}

const SPECS: Record<LabCase, LabSpec> = {
  // A win, the first of the day, a daily challenge — crosses one level.
  levelup: {
    result: { won: true, kills: 25, deaths: 7, bestStreak: 6, headshots: 5, shotsFired: 61, shotsHit: 27 },
    place: 1,
    before: { level: 6, frac: 0.55 },
    firstWin: true,
    challenges: [{ id: 'daily-hs', label: 'Daily: land 5 headshots', xp: 100, credits: 25 }],
  },
  // A big session: two challenges on top of a strong win — several levels.
  multi: {
    result: { won: true, kills: 25, deaths: 5, bestStreak: 12, headshots: 11, shotsFired: 52, shotsHit: 30 },
    place: 1,
    before: { level: 2, frac: 0.5 },
    firstWin: true,
    challenges: [
      { id: 'daily-win', label: 'Daily: win a match', xp: 150, credits: 30 },
      { id: 'weekly-frags', label: 'Weekly: 100 kills', xp: 400, credits: 120 },
    ],
  },
  // An existing player after the curve change: Lv 14 on XP, but the road was
  // only granted to Lv 4 — this reply pays the catch-up and a new level.
  catchup: {
    result: { won: false, kills: 14, deaths: 9, bestStreak: 5, headshots: 4, shotsFired: 40, shotsHit: 15 },
    place: 2,
    before: { level: 14, frac: 0.82 },
    roadFrom: 4,
  },
  guest: {
    result: { won: false, kills: 18, deaths: 16, bestStreak: 4, headshots: 3, shotsFired: 55, shotsHit: 20 },
    place: 3,
    before: { level: 1, frac: 0 },
    saved: false,
  },
  offline: {
    result: { won: true, kills: 25, deaths: 7, bestStreak: 8, headshots: 7, shotsFired: 60, shotsHit: 28 },
    place: 1,
    before: { level: 9, frac: 0.18 },
    offline: true,
  },
  plain: {
    result: { won: false, kills: 9, deaths: 14, bestStreak: 3, headshots: 2, shotsFired: 38, shotsHit: 11 },
    place: 5,
    before: { level: 14, frac: 0.3 },
  },
  legacy: {
    result: { won: true, kills: 25, deaths: 7, bestStreak: 6, headshots: 5, shotsFired: 61, shotsHit: 27 },
    place: 1,
    before: { level: 4, frac: 0.8 },
    legacy: true,
  },
};

const NAMES = ['Razor', 'Kestrel', 'Nyx', 'Halcyon', 'Vex', 'Orbit', 'Tamsin', 'Quill'];
const HATS_LAB = ['hat.crown', 'hat.tophat', 'hat.wizard', 'hat.cap', 'hat.propeller', 'hat.hardhat', 'hat.graduation', 'hat.baseball'];
const EMOTES_LAB = ['emote.cheer', 'emote.dance', 'emote.wave', 'emote.flex', 'emote.salute', 'emote.cheer', 'emote.dance', 'emote.wave'];

// An 8-player board with you at `place` holding the match's kill count; TDM
// splits it into two teams, duel keeps one opponent.
function fakeScores(m: LabMatch, mode: 'ffa' | 'tdm' | 'duel', myName: string): PlayerScore[] {
  const mine = m.result.kills;
  const n = mode === 'duel' ? 2 : 8;
  const place = mode === 'duel' ? (m.won ? 1 : 2) : Math.min(m.place, n);
  const others: number[] = [];
  for (let i = 1; i < n; i++) others.push(Math.max(0, 25 - i * 3 - (i % 2)));
  // Players above you: strictly more; below: strictly fewer.
  const above = Array.from({ length: place - 1 }, (_, i) => Math.min(25, mine + (place - 1 - i) * 2 + 1));
  const below = others.slice(place - 1).map((f, i) => Math.min(f, Math.max(0, mine - 1 - i * 2)));
  const frags = [...above, mine, ...below];
  let bot = 0;
  return frags.slice(0, n).map((f, i) => {
    const you = i === place - 1;
    const k = you ? -1 : bot++;
    return {
      id: `p${i}`,
      name: you ? myName : NAMES[k % NAMES.length],
      isLocal: you,
      frags: f,
      deaths: you ? m.result.deaths : 6 + ((k * 5) % 11),
      bestStreak: you ? m.result.bestStreak : Math.max(1, Math.round(f / 4)),
      currentStreak: 0,
      accuracy: you ? null : 30 + ((k * 7) % 25),
      team: mode === 'tdm' ? i % 2 : null,
      hat: you ? undefined : HATS_LAB[k % HATS_LAB.length],
      emote: you ? undefined : EMOTES_LAB[k % EMOTES_LAB.length],
    };
  });
}

// The XP ticker in context: crosshair, centre-print and a stream of frags.
function HudTickerLab({ hold, reduced }: { hold?: number; reduced: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((k) => (hold !== undefined && k >= 3 ? k : k + 1)), 900);
    return () => window.clearInterval(id);
  }, [hold]);
  useEffect(() => {
    if (hold === undefined) return;
    const id = window.setTimeout(() => document.getAnimations().forEach((a) => a.pause()), hold);
    return () => window.clearTimeout(id);
  }, [hold]);
  const confirm: KillConfirm | null =
    n > 0 ? { id: n, victimName: NAMES[n % NAMES.length], headshot: n % 3 === 0, remaining: 1.6, total: 1.6 } : null;
  return (
    <div
      className={`hud-root absolute inset-0 bg-[radial-gradient(circle_at_50%_55%,#3a4656,#12161d)] ${reduced ? 'hud-reduced' : ''}`}
    >
      <div className='absolute left-1/2 top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-cyan-300' />
      <div className='absolute left-1/2 top-1/2 h-[2px] w-5 -translate-x-1/2 -translate-y-1/2 bg-cyan-300' />
      <FragPopup confirm={confirm} placement={n > 0 ? `1st place with ${10 + n}` : null} />
      <XpTicker confirm={confirm} bestStreak={n} offline={false} />
    </div>
  );
}

export default function RewardsLab() {
  const q = useMemo(() => new URLSearchParams(window.location.search), []);
  if (q.get('hud') === '1') {
    return <HudTickerLab hold={q.get('hold') !== null ? Number(q.get('hold')) : undefined} reduced={q.get('reduced') === '1'} />;
  }
  return <ResultsLab q={q} />;
}

function ResultsLab({ q }: { q: URLSearchParams }) {
  const labCase = (CASES.includes(q.get('case') as LabCase) ? q.get('case') : 'levelup') as LabCase;
  const online = q.get('online') === '1';
  const mode = (['ffa', 'tdm', 'duel'].includes(q.get('mode') ?? '') ? q.get('mode') : 'ffa') as 'ffa' | 'tdm' | 'duel';
  const myName = q.get('name') ?? 'Wraith';
  const c = useMemo(() => buildMatch(SPECS[labCase]), [labCase]);
  // Named moments of this case's timeline (the reveal starts 750 ms in):
  // ?hold=takeover (mid level-up beat), ?hold=bar (mid first fill).
  const tl = useMemo(() => buildTimeline(buildRevealModel(c.progression, { result: c.result }), 750), [c]);
  const moment = (v: string | null): number | undefined => {
    if (v === null) return undefined;
    if (v === 'takeover') return tl.takeover ? tl.takeover.start + 1500 : tl.seg[0].end;
    if (v === 'end') return tl.doneAt;
    if (v === 'bar') return Math.round((tl.seg[0].start + tl.seg[0].end) / 2);
    if (v === 'cards') return tl.cardAt.length ? tl.cardAt[tl.cardAt.length - 1] + 500 : tl.creditsAt;
    return Number(v);
  };
  const hold = moment(q.get('hold'));
  const at = hold ?? moment(q.get('at'));
  const late = Number(q.get('late') ?? 0);
  const pending = q.get('pending') === '1';
  const reduced = q.get('reduced') === '1';
  const clean = q.get('clean') === '1';
  const withLogin = q.get('login') !== '0';

  const scores = useMemo(() => fakeScores(c, mode, myName), [c, mode, myName]);
  // TDM: the win is your team's; everything else follows the case.
  const teamWon = (() => {
    const me = scores.find((x) => x.isLocal);
    if (mode !== 'tdm' || !me) return c.won;
    const total = (t: number) => scores.filter((x) => x.team === t).reduce((n, x) => n + x.frags, 0);
    return total(me.team ?? 0) > total(1 - (me.team ?? 0));
  })();
  const won = q.get('won') !== null ? q.get('won') === '1' : teamWon;
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
    const pauseAll = () => document.getAnimations().forEach((a) => a.pause());
    // hold=takeover: pause 1.5 s after the takeover ACTUALLY mounts, so a slow
    // or busy page can't freeze it before its reward card has flipped in.
    if (q.get('hold') === 'takeover' && tl.takeover) {
      let pauseId = 0;
      const poll = window.setInterval(() => {
        if (!document.querySelector('.rw-takeover')) return;
        window.clearInterval(poll);
        pauseId = window.setTimeout(pauseAll, 1500);
      }, 30);
      return () => {
        window.clearInterval(poll);
        window.clearTimeout(pauseId);
      };
    }
    const id = window.setTimeout(pauseAll, hold);
    return () => window.clearTimeout(id);
  }, [hold, run, q, tl]);

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
          mode={mode}
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
          mode={mode}
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
