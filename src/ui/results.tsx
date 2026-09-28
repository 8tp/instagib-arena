// End-of-match results: the Victory/Defeat slam, the 3D podium, the scoreboard,
// match stats and the rewards reveal (offline + online variants).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MatchResult } from '../game/game';
import type { PlayerScore } from '../game/types';
import type { ProgressionResp, Settings } from '../app-types';
import { DeckButton, ModalShell } from '../deck';
import { prefersReducedMotion } from '../deck-core';
import { playUi } from '../game/audio';
import { PodiumScene, type PodiumWinner } from '../game/podium';
import { DEFAULT_EMOTE, DEFAULT_HAT, EMOTES, HATS } from '../game/cosmetics';
import { ordinal } from './match-info';
import { RewardsPending, RewardsReveal } from './rewards/RewardsReveal';

// Deterministic 32-bit hash (FNV-1a) so a given name always maps to the same
// podium hat/emote when we don't know its real loadout (offline bots / remotes).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build the top-3 podium roster from the final scoreboard. Each player's real
// equipped hat/emote is used when known — the local player from settings, and
// (online) remotes from the broadcast carried on their PlayerScore. Offline bots
// have no known loadout, so they fall back to a stable name-hashed hat/emote.
function buildPodiumWinners(scores: PlayerScore[], settings: Settings): PodiumWinner[] {
  // Any modelled, non-staff hat (caseHats() is only the few case exclusives).
  const caseHatIds = HATS.filter((h) => h.model && h.source.type !== 'admin').map((h) => h.id);
  const emoteIds = EMOTES.map((e) => e.id);
  return scores.slice(0, 3).map((s, i) => {
    const h = hashStr(s.name);
    const hatId = s.isLocal ? settings.hat : s.hat ?? caseHatIds[h % caseHatIds.length] ?? DEFAULT_HAT;
    const emoteId = s.isLocal
      ? settings.emote
      : s.emote ?? emoteIds[(h >>> 4) % emoteIds.length] ?? DEFAULT_EMOTE;
    return { place: i + 1, name: s.name, score: s.frags, hatId, emoteId };
  });
}

// Mounts the Three.js podium scene on a canvas and tears it down on unmount.
function PodiumResults({ winners }: { winners: PodiumWinner[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scene = new PodiumScene(canvas);
    void scene.setWinners(winners);
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      scene.dispose();
    };
  }, [winners]);
  return <canvas ref={ref} className='block h-full w-full' />;
}

// Reward props shared by both results variants.
type RewardProps = {
  // Guests: "Log in to keep your progress" calls this (the button is hidden
  // when absent — a quiet "log in from the menu" line shows instead).
  onLogin?: () => void;
  // False for matches that never earn XP (weekly challenge): skip the reward
  // column's "tallying" placeholder and show the quiet note right away.
  expectRewards?: boolean;
  // /rewardslab only: stop the reveal clock at this many ms after mount.
  revealFreezeAt?: number;
};

// How long to wait for the server's reward reply before showing "no rewards".
const REWARDS_WAIT_MS = 6000;

function placementLine(scores: PlayerScore[]): string {
  const me = scores.find((s) => s.isLocal);
  if (!me) return 'Final standings';
  const rank = scores.filter((o) => o.frags > me.frags).length + 1;
  return `Final standings · ${ordinal(rank)} of ${scores.length} · ${me.frags} frag${me.frags === 1 ? '' : 's'}`;
}

// Shared results panel: the Victory/Defeat slam, the 3D top-3 podium, the full
// scoreboard + match stats, the rewards reveal (a column beside the board on
// wide screens, right under the podium on narrow ones), and a caller-supplied
// footer (offline = Play Again/Lobby; online = Continue to the map vote).
function ResultsPanel({
  won,
  scores,
  settings,
  result,
  progression,
  footer,
  onLogin,
  expectRewards = true,
  revealFreezeAt,
  onHoverChange,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  footer: ReactNode;
  onHoverChange?: (hovered: boolean) => void;
} & RewardProps) {
  const acc = result && result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  // Stable winners identity so the 3D scene mounts once (not every HUD tick).
  const rosterKey = scores.slice(0, 3).map((s) => `${s.id}:${s.frags}:${s.hat ?? ''}:${s.emote ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const winners = useMemo(() => buildPodiumWinners(scores, settings), [rosterKey, settings.hat, settings.emote]);
  const reduced = settings.reducedEffects || prefersReducedMotion();

  // The reveal starts ~0.75 s after the panel (the header slam lands first);
  // a late server reply starts it sooner rather than stacking the wait.
  const [mountedAt] = useState(() => performance.now());
  const [skipped, setSkipped] = useState(false);
  const [revealDone, setRevealDone] = useState(false);
  const [gaveUp, setGaveUp] = useState(!expectRewards);
  useEffect(() => {
    if (progression || gaveUp) return;
    const id = window.setTimeout(() => setGaveUp(true), REWARDS_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [progression, gaveUp]);
  const revealing = !!progression && !revealDone && !skipped;

  // The slam's sound, on its impact frame.
  useEffect(() => {
    const id = window.setTimeout(() => playUi('stamp', won ? 1 : -1), 170);
    return () => window.clearTimeout(id);
  }, [won]);

  // Space skips the reveal to its end state (and only that, while it runs: the
  // matching keyup is swallowed too so a focused button isn't activated).
  useEffect(() => {
    if (!revealing) return;
    let swallowUp = false;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      // Typing (the in-game chat composer survives the results screen).
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      swallowUp = true;
      setSkipped(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && swallowUp) {
        e.preventDefault();
        swallowUp = false;
      }
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [revealing]);

  const tone = won
    ? { text: 'text-emerald-300', glow: 'rgba(52,211,153,0.6)', line: '#6ee7b7', wash: 'rgba(16,185,129,0.16)' }
    : { text: 'text-rose-300', glow: 'rgba(244,63,94,0.6)', line: '#fda4af', wash: 'rgba(225,29,72,0.16)' };

  return (
    <ModalShell
      label={won ? 'Victory — final standings' : 'Defeat — final standings'}
      tone={won ? 'emerald' : 'rose'}
      width='w-[1120px]'
      z='z-30'
      backdrop='heavy'
      scroll
      padded={false}
      bodyClassName='gap-0'
      openSound='none'
      footer={footer}
    >
      <div
        className={`rw-root ${reduced ? 'rw-reduced' : ''}`}
        onPointerEnter={() => onHoverChange?.(true)}
        onPointerLeave={() => onHoverChange?.(false)}
        onPointerDown={(e) => {
          // Click anywhere (but a control) skips the reveal to the end.
          if (!revealing) return;
          if ((e.target as Element).closest('button, a, input, select, textarea')) return;
          setSkipped(true);
        }}
      >
        {/* Header: the Victory / Defeat slam. */}
        <div
          className='rw-shake relative overflow-hidden border-b border-white/10 px-6 pb-2.5 pt-3.5 text-center'
          style={{ background: `radial-gradient(60% 140% at 50% 0%, ${tone.wash}, rgba(0,0,0,0.5) 70%)` }}
        >
          <div
            aria-hidden='true'
            className='rw-flare pointer-events-none absolute inset-x-0 h-[2px]'
            style={{ top: 'calc(50% - 8px)', background: `linear-gradient(90deg, transparent, ${tone.line}, transparent)` }}
          />
          <div
            className={`rw-slam font-display text-[2.75rem] font-bold uppercase leading-none tracking-[0.22em] ${tone.text}`}
            style={{ textShadow: `0 3px 0 rgba(0,0,0,0.55), 0 0 28px ${tone.glow}` }}
          >
            {won ? 'Victory' : 'Defeat'}
          </div>
          <div className='rw-sub-in mt-2 font-mono text-[10px] uppercase tracking-[0.26em] text-white/45'>
            {placementLine(scores)}
          </div>
        </div>

        <div className='grid [grid-template-areas:"podium"_"rewards"_"board"] lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[auto_1fr] lg:[grid-template-areas:"podium_rewards"_"board_rewards"]'>
          {/* Hero: the 3D podium of the top 3 (hats + emotes). */}
          <div className='h-[240px] w-full bg-gradient-to-b from-[#161d29] to-[#0b0e14] [grid-area:podium] lg:h-[262px]'>
            <PodiumResults winners={winners} />
          </div>

          {/* Rewards: the reveal (or its placeholder while the reply is in flight). */}
          <aside
            aria-label='Rewards'
            className='border-b border-white/10 bg-white/[0.015] px-5 py-3.5 [grid-area:rewards] lg:border-b-0 lg:border-l'
          >
            {progression ? (
              <RewardsReveal
                key={`${progression.xpGained}:${progression.progression.totalXp}`}
                progression={progression}
                result={result}
                skipped={skipped}
                reduced={reduced}
                startMs={Math.max(200, 750 - (performance.now() - mountedAt))}
                freezeAt={revealFreezeAt}
                onDone={() => setRevealDone(true)}
                onLogin={onLogin}
              />
            ) : (
              <RewardsPending gaveUp={gaveUp} />
            )}
          </aside>

          {/* Full scoreboard (all players, compact) + your match stats. */}
          <div className='p-5 pt-3.5 [grid-area:board]'>
            <div className='overflow-hidden border border-white/10'>
              <div className='grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 bg-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/45'>
                <span>#</span>
                <span>Player</span>
                <span className='text-right'>K</span>
                <span className='text-right'>D</span>
              </div>
              {scores.map((s, i) => (
                <div
                  key={s.id}
                  className={`deck-tr grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 px-3 py-[5px] text-sm ${
                    s.isLocal ? 'deck-tr-you text-cyan-100' : 'text-white/80'
                  }`}
                >
                  <span className='tabular-nums text-white/45'>{i + 1}</span>
                  <span className='truncate'>
                    {s.name}
                    {s.isLocal && ' (you)'}
                  </span>
                  <span className='text-right tabular-nums'>{s.frags}</span>
                  <span className='text-right tabular-nums'>{s.deaths}</span>
                </div>
              ))}
            </div>

            {result && (
              <div className='mt-3 grid grid-cols-4 gap-2 text-center'>
                <MiniStat label='Kills' value={result.kills} />
                <MiniStat label='Deaths' value={result.deaths} />
                <MiniStat label='Streak' value={result.bestStreak} />
                <MiniStat label='Acc' value={`${acc}%`} />
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// Offline (vs-bots) results — replay or bail to the lobby.
export function MatchOverOverlay({
  won,
  scores,
  settings,
  result,
  progression,
  onPlayAgain,
  onLobby,
  ...reward
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onPlayAgain: () => void;
  onLobby: () => void;
} & RewardProps) {
  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      {...reward}
      footer={
        <>
          <DeckButton onClick={onPlayAgain} solid accent='emerald' center className='flex-1'>
            Play again
          </DeckButton>
          <DeckButton onClick={onLobby} center className='flex-1' sound='uiBack'>
            Lobby
          </DeckButton>
        </>
      }
    />
  );
}

// How long the online results hold before the map vote (paused on hover).
const ONLINE_RESULTS_MS = 12000;
// Never eat into the last seconds of the vote, however long it was hovered.
const VOTE_RESERVE_MS = 6000;

// Online results — same podium + reveal, then auto-advances to the map vote (or
// click). The countdown pauses while the pointer is over the results, but never
// runs past `voteEndsAt − VOTE_RESERVE_MS` so there is always time to vote.
export function OnlineMatchResults({
  won,
  scores,
  settings,
  result,
  progression,
  onContinue,
  voteEndsAt,
  ...reward
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onContinue: () => void;
  voteEndsAt?: number; // Date.now()-domain end of the map vote (HudState.vote.endsAtClient)
} & RewardProps) {
  const [hovered, setHovered] = useState(false);
  const [secs, setSecs] = useState(Math.ceil(ONLINE_RESULTS_MS / 1000));
  const hoveredRef = useRef(false);
  hoveredRef.current = hovered;
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;
  const voteEndsRef = useRef(voteEndsAt);
  voteEndsRef.current = voteEndsAt;

  // Wall-clock countdown (dt-based, so it is frame-rate and throttle proof);
  // React only hears about it once per whole second.
  useEffect(() => {
    let left = ONLINE_RESULTS_MS;
    let last = performance.now();
    let shown = Math.ceil(left / 1000);
    let fired = false;
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (!hoveredRef.current) left -= dt;
      const cap = voteEndsRef.current;
      const hardStop = cap !== undefined && Date.now() >= cap - VOTE_RESERVE_MS;
      if ((left <= 0 || hardStop) && !fired) {
        fired = true;
        window.clearInterval(id);
        onContinueRef.current();
        return;
      }
      const s = Math.max(0, Math.ceil(left / 1000));
      if (s !== shown) {
        shown = s;
        setSecs(s);
        if (s >= 1 && s <= 3) playUi('countdownTick', s);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const barStyle = { '--rw-total': `${ONLINE_RESULTS_MS}ms` } as CSSProperties;
  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      onHoverChange={setHovered}
      {...reward}
      footer={
        <div className='relative flex-1'>
          <DeckButton onClick={onContinue} solid accent='cyan' center full>
            Continue to map vote{secs > 0 ? ` · ${secs}` : ''}
          </DeckButton>
          <div aria-hidden='true' className='pointer-events-none absolute inset-x-0 -bottom-1.5 h-[2px] bg-white/10'>
            <div className='rw-countdown h-full bg-cyan-300' data-paused={hovered} style={barStyle} />
          </div>
          {hovered && (
            <div className='absolute -top-5 right-0 font-mono text-[9px] uppercase tracking-[0.18em] text-white/40'>Paused</div>
          )}
        </div>
      }
    />
  );
}

export function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className='text-[9px] uppercase tracking-[0.2em] text-white/40'>{label}</div>
      <div className='text-lg font-bold tabular-nums'>{value}</div>
    </div>
  );
}
