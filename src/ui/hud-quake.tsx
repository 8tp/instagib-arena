import { memo, useState } from 'react';
import { TEAM_NAMES, type GameMode } from '../game/constants';
import { OFFLINE_XP_SCALE, XP_PER_HEADSHOT, XP_PER_KILL, XP_PER_STREAK } from '../game/progression';
import type { KillConfirm, PlayerScore } from '../game/types';
import { useHudSlice } from '../hud-store';
import { ordinal, standingOf } from './match-info';

// Quake-style HUD pieces: the score boxes (big numerals, top-centre), the
// compact killfeed, the Tab scoreboard, and the "Fight!" call. All are plain
// presentational components: the store-connected wrappers live with the HUD
// layout in InstagibClient, and every animation is CSS keyed by an id or a
// value (src/hud.css) — nothing here re-renders per frame.

export type HudMatchInfo = {
  mapName: string;
  modeLine: string; // "Free-for-all · first to 25 frags"
  fragLimit: number | null;
};

/* ── Score boxes ────────────────────────────────────────────────────────── */

function ScoreBox({ value, label, tone }: { value: number; label: string; tone: 'self' | 'other' | 'red' | 'blue' }) {
  return (
    <div className={`hud-panel hud-sbox hud-sbox-${tone}`}>
      {/* Keyed on the value: every frag ticks the numeral in. */}
      <span key={value} className='hud-sbox-num hud-tick hud-tick-center'>
        {value}
      </span>
      <span className='hud-sbox-label'>{label}</span>
    </div>
  );
}

// You vs the best other player (FFA / Duel), or Red vs Blue (TDM), with the
// frag limit under them. Your box carries your placement.
export const ScoreBoxes = memo(function ScoreBoxes({
  scores,
  mode,
  teamScores,
  localTeam,
  fragLimit,
}: {
  scores: PlayerScore[];
  mode: GameMode;
  teamScores: [number, number] | null;
  localTeam: number | null;
  fragLimit: number | null;
}) {
  let boxes: React.ReactNode;
  if (mode === 'tdm' && teamScores) {
    boxes = ([0, 1] as const).map((t) => (
      <ScoreBox
        key={t}
        value={teamScores[t]}
        label={localTeam === t ? `${TEAM_NAMES[t]} · you` : TEAM_NAMES[t]}
        tone={t === 0 ? 'red' : 'blue'}
      />
    ));
  } else {
    const st = standingOf(scores);
    if (!st || st.of < 2) return null;
    boxes = (
      <>
        <ScoreBox value={st.frags} label={st.tied ? `Tied ${ordinal(st.place)}` : ordinal(st.place)} tone='self' />
        <ScoreBox value={st.leaderFrags} label={st.leaderName} tone='other' />
      </>
    );
  }
  return (
    <div className='absolute inset-x-0 top-3 flex flex-col items-center'>
      <div className='flex items-stretch gap-[3px]'>{boxes}</div>
      {fragLimit != null && <div className='hud-panel hud-sbox-limit'>First to {fragLimit}</div>}
    </div>
  );
});

/* ── Killfeed + Tab scoreboard ──────────────────────────────────────────── */

// Extracted into src/ui/hud/ (killfeed.tsx, scoreboard.tsx); re-exported so
// existing imports keep working.
export { Killfeed } from './hud/killfeed';
export { QuakeScoreboard } from './hud/scoreboard';

/* ── Fight! ─────────────────────────────────────────────────────────────── */

// The warmup's last word: one CSS stamp-and-fade, unmounted on animation end.
export function FightCall({ onDone }: { onDone: () => void }) {
  return (
    <div className='pointer-events-none absolute inset-x-0 top-[36%] flex justify-center'>
      <span className='hud-fight' onAnimationEnd={onDone}>
        Fight!
      </span>
    </div>
  );
}

/* ── XP ticker ──────────────────────────────────────────────────────────── */

// Frags landing inside this window stack into one running "+N" (CoD style).
const XP_CHAIN_MS = 1400;

type XpTickState = {
  id: number; // the KillConfirm id this tick answers (0 = none yet)
  total: number; // running total of the current chain
  at: number; // performance.now() of the last frag in the chain
  lastBest: number; // best streak already paid for
  headshot: boolean;
  streak: boolean;
};

// A small "+16 XP" beside the crosshair on every frag, the XP counterpart of
// the centre-print. A PRESENTATIONAL ESTIMATE from the progression constants
// (kill + headshot + each new best-streak step, halved offline): the server
// computes the real number at match end, and bonuses like the win, accuracy
// or first-win only land there. One CSS animation keyed by the chain step
// (.hud-xp in src/hud.css); React re-renders only when a frag lands.
export const XpTicker = memo(function XpTicker({
  confirm,
  bestStreak,
  offline,
}: {
  confirm: KillConfirm | null;
  bestStreak: number;
  offline: boolean;
}) {
  const [st, setSt] = useState<XpTickState>(() => ({
    id: confirm?.id ?? 0,
    total: 0,
    at: 0,
    lastBest: bestStreak,
    headshot: false,
    streak: false,
  }));
  // Derived from props during render (the documented "previous props" pattern):
  // a new confirm id is a new frag; a best streak that went DOWN is a new match.
  let cur = st;
  if (confirm && confirm.id !== st.id) {
    const scale = offline ? OFFLINE_XP_SCALE : 1;
    const steps = Math.max(0, bestStreak - st.lastBest);
    const raw = XP_PER_KILL + (confirm.headshot ? XP_PER_HEADSHOT : 0) + steps * XP_PER_STREAK;
    const xp = Math.max(1, Math.round(raw * scale));
    const now = performance.now();
    cur = {
      id: confirm.id,
      total: st.total > 0 && now - st.at < XP_CHAIN_MS ? st.total + xp : xp,
      at: now,
      lastBest: bestStreak,
      headshot: confirm.headshot,
      streak: steps > 0 && bestStreak >= 2,
    };
    setSt(cur);
  } else if (bestStreak < st.lastBest) {
    cur = { ...st, lastBest: bestStreak };
    setSt(cur);
  }
  if (!confirm || cur.total <= 0) return null;
  const tags = [cur.headshot && 'Headshot', cur.streak && 'Streak'].filter(Boolean).join(' · ');
  return (
    <div className='hud-xp-anchor'>
      <div key={cur.id} className='hud-xp'>
        <span className='hud-xp-num'>+{cur.total}</span>
        <span className='hud-xp-unit'>XP</span>
        {tags && <div className='hud-xp-tag'>{tags}</div>}
      </div>
    </div>
  );
});

// Store-connected ticker, ready to mount inside the HUD root next to the frag
// centre-print. `enabled` = false for matches that never grant XP (weekly
// challenge, training range); spectators never frag, so they never see it.
export function HudXpTicker({ enabled = true }: { enabled?: boolean }) {
  const confirm = useHudSlice((s) => s.killConfirm);
  const bestStreak = useHudSlice((s) => s.bestStreak);
  const offline = useHudSlice((s) => s.netStatus === 'off');
  const training = useHudSlice((s) => s.training !== null);
  if (!enabled || training) return null;
  return <XpTicker confirm={confirm} bestStreak={bestStreak} offline={offline} />;
}
