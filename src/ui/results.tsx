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
import { TEAM_COLORS, TEAM_NAMES } from '../game/constants';
import { ordinal } from './match-info';
import { RewardsPending, RewardsReveal } from './rewards/RewardsReveal';
import './postgame.css';

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
    return { place: i + 1, name: s.name, score: s.frags, hatId, emoteId, you: !!s.isLocal, looks: s.isLocal ? settings.looks : undefined };
  });
}

// Mounts the Three.js podium scene on a canvas and tears it down on unmount.
function PodiumResults({ winners, lowSpec, reduced }: { winners: PodiumWinner[]; lowSpec: boolean; reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scene = new PodiumScene(canvas, { lowSpec, reducedEffects: reduced });
    void scene.setWinners(winners);
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      scene.dispose();
    };
  }, [winners, lowSpec, reduced]);
  return <canvas ref={ref} className='block h-full w-full' />;
}

export type ResultsMode = 'ffa' | 'tdm' | 'duel';

// Reward props shared by both results variants.
type RewardProps = {
  // The match's mode (FFA gets a placement headline, TDM / duel Victory /
  // Defeat). Inferred from the scoreboard + the reward reply when absent.
  mode?: ResultsMode;
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

// What the header says. FFA gets a Q3 centre-print ("3rd place" / "18 frags ·
// 3rd of 8"); team deathmatch and duels keep Victory / Defeat.
type Headline = { title: string; sub: string; tone: 'win' | 'loss' | 'place'; stamp: number };

function resultMode(scores: PlayerScore[], explicit?: ResultsMode, fromServer?: string): ResultsMode {
  if (explicit) return explicit;
  if (fromServer === 'tdm' || fromServer === 'duel' || fromServer === 'ffa') return fromServer;
  if (fromServer === 'ranked') return 'duel';
  if (scores.some((s) => s.team === 0 || s.team === 1)) return 'tdm';
  return scores.length === 2 ? 'duel' : 'ffa';
}

function headlineFor(won: boolean, scores: PlayerScore[], mode: ResultsMode): Headline {
  const me = scores.find((s) => s.isLocal);
  const frags = (n: number) => `${n} frag${n === 1 ? '' : 's'}`;
  if (mode === 'ffa' && me) {
    const rank = scores.filter((o) => o.frags > me.frags).length + 1;
    const tied = scores.some((o) => o !== me && o.frags === me.frags);
    return {
      title: `${tied ? 'Tied for ' : ''}${ordinal(rank)} place`,
      sub: `${frags(me.frags)} · ${ordinal(rank)} of ${scores.length}`,
      tone: rank === 1 ? 'win' : 'place',
      stamp: rank === 1 ? 1 : 0,
    };
  }
  let sub = 'Final standings';
  if (mode === 'tdm') {
    const total = (t: number) => scores.filter((s) => s.team === t).reduce((n, s) => n + s.frags, 0);
    sub = `${TEAM_NAMES[0]} ${total(0)} – ${total(1)} ${TEAM_NAMES[1]}`;
  } else if (me) {
    const opp = scores.find((s) => !s.isLocal);
    if (opp) sub = `${me.frags} – ${opp.frags} against ${opp.name}`;
  }
  return { title: won ? 'Victory' : 'Defeat', sub, tone: won ? 'win' : 'loss', stamp: won ? 1 : -1 };
}

// "You" is already the name for an unnamed local player; otherwise a tag.
function isPlainYou(name: string): boolean {
  return name.trim().toLowerCase() === 'you';
}

// ── Personal bests (local, display-only: the server owns real records) ──────
const PB_KEY = 'ig.postgame.pb.v1';
type PbRecord = { kills: number; streak: number; headshots: number; acc: number; kd: number };

function loadPb(): PbRecord | null {
  try {
    const raw = localStorage.getItem(PB_KEY);
    return raw ? (JSON.parse(raw) as PbRecord) : null;
  } catch {
    return null;
  }
}

function accOf(r: MatchResult): number {
  return r.shotsFired > 0 ? Math.round((r.shotsHit / r.shotsFired) * 100) : 0;
}
function kdOf(r: MatchResult): number {
  return r.deaths > 0 ? r.kills / r.deaths : r.kills;
}

// "You beat your best" flags for this match against the stored record. Nothing
// is flagged on the very first recorded match (everything would be a "best").
function usePersonalBests(result: MatchResult | null): Set<keyof PbRecord> {
  const [prior] = useState(loadPb);
  useEffect(() => {
    if (!result) return;
    const cur: PbRecord = {
      kills: result.kills,
      streak: result.bestStreak,
      headshots: result.headshots,
      acc: result.shotsFired >= 10 ? accOf(result) : 0,
      kd: kdOf(result),
    };
    const next: PbRecord = prior
      ? {
          kills: Math.max(prior.kills, cur.kills),
          streak: Math.max(prior.streak, cur.streak),
          headshots: Math.max(prior.headshots, cur.headshots),
          acc: Math.max(prior.acc, cur.acc),
          kd: Math.max(prior.kd, cur.kd),
        }
      : cur;
    try {
      localStorage.setItem(PB_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: bests just aren't remembered */
    }
  }, [result, prior]);
  return useMemo(() => {
    const out = new Set<keyof PbRecord>();
    if (!prior || !result) return out;
    if (result.kills > prior.kills && result.kills > 0) out.add('kills');
    if (result.bestStreak > prior.streak && result.bestStreak > 1) out.add('streak');
    if (result.headshots > prior.headshots && result.headshots > 0) out.add('headshots');
    if (result.shotsFired >= 10 && accOf(result) > prior.acc) out.add('acc');
    if (kdOf(result) > prior.kd + 0.005 && result.kills > 0) out.add('kd');
    return out;
  }, [prior, result]);
}

type Tile = { key: keyof PbRecord | 'deaths'; label: string; value: string | number; sub?: string; tone?: string };

// The personal performance card: your numbers for the match, with a gold PB
// tag on any that beat your stored best. Tiles rise in one after another.
function PerformanceCard({ result }: { result: MatchResult }) {
  const pbs = usePersonalBests(result);
  const hsPct = result.kills > 0 ? Math.round((result.headshots / result.kills) * 100) : 0;
  const tiles: Tile[] = [
    { key: 'kd', label: 'K/D ratio', value: kdOf(result).toFixed(2), sub: `${result.kills} / ${result.deaths}`, tone: 'text-cyan-100' },
    { key: 'acc', label: 'Accuracy', value: `${accOf(result)}%`, sub: `${result.shotsHit} / ${result.shotsFired} hit` },
    { key: 'streak', label: 'Best streak', value: result.bestStreak, sub: 'in a row' },
    { key: 'headshots', label: 'Headshots', value: result.headshots, sub: `${hsPct}% of kills` },
    { key: 'kills', label: 'Kills', value: result.kills, tone: 'text-emerald-200' },
    { key: 'deaths', label: 'Deaths', value: result.deaths, tone: 'text-rose-200' },
  ];
  return (
    <section aria-label='Your performance'>
      <div className='pg-section-label pg-rise mb-2 [--pg-base:700ms]'>Your performance</div>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6'>
        {tiles.map((t, i) => {
          const pb = t.key !== 'deaths' && pbs.has(t.key);
          const st = { '--i': i, '--pg-base': '800ms' } as CSSProperties;
          return (
            <div key={t.key} data-pb={pb ? '1' : '0'} className='pg-tile pg-rise' style={st}>
              {pb && (
                <span className='pg-pb' style={st}>
                  PB
                </span>
              )}
              <div className={`pg-tile-value ${t.tone ?? 'text-white'}`}>{t.value}</div>
              <div className='pg-tile-label'>{t.label}</div>
              {t.sub && <div className='pg-tile-sub truncate'>{t.sub}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const MEDAL = ['#fbbf24', '#cbd5e1', '#d6a06a'];

// Full scoreboard: rank medals for the top 3, a frag-share bar behind each row,
// team pips in TDM, K/D per player. Rows stagger in after the performance card.
function Scoreboard({ scores, mode }: { scores: PlayerScore[]; mode: ResultsMode }) {
  const top = Math.max(1, ...scores.map((s) => s.frags));
  const cols = 'grid-cols-[1.75rem_1fr_3rem_3rem_3.25rem]';
  return (
    <section aria-label='Scoreboard'>
      <div className='pg-section-label pg-rise mb-2 [--pg-base:950ms]'>Scoreboard</div>
      <div className='overflow-hidden border border-white/10'>
        <div className={`grid ${cols} gap-2 bg-white/5 px-3 py-1.5 text-[12px] text-white/50`}>
          <span>#</span>
          <span>Player</span>
          <span className='text-right'>Kills</span>
          <span className='text-right'>Deaths</span>
          <span className='text-right'>K/D</span>
        </div>
        {scores.map((s, i) => {
          const st = { '--i': i, '--pg-base': '1000ms' } as CSSProperties;
          return (
            <div
              key={s.id}
              className={`deck-tr pg-row pg-rise grid ${cols} items-center gap-2 px-3 py-[5px] text-sm ${
                s.isLocal ? 'deck-tr-you text-cyan-100' : 'text-white/80'
              }`}
              style={st}
            >
              <span
                aria-hidden='true'
                className='pg-row-bar'
                style={{ ...st, width: `${Math.max(4, (s.frags / top) * 100)}%` }}
              />
              <span>
                {i < 3 ? (
                  <span className='pg-medal' style={{ background: MEDAL[i] }}>
                    {i + 1}
                  </span>
                ) : (
                  <span className='tabular-nums text-white/45'>{i + 1}</span>
                )}
              </span>
              <span className='flex min-w-0 items-center gap-2'>
                {mode === 'tdm' && s.team != null && (
                  <span
                    aria-hidden='true'
                    className='h-2 w-2 shrink-0 rounded-full'
                    style={{ background: TEAM_COLORS[s.team] ?? '#888' }}
                  />
                )}
                <span className='truncate'>{s.name}</span>
                {s.isLocal && !isPlainYou(s.name) && <span className='rw-chip rw-chip-cyan shrink-0'>You</span>}
              </span>
              <span className='text-right tabular-nums'>{s.frags}</span>
              <span className='text-right tabular-nums'>{s.deaths}</span>
              <span className='text-right tabular-nums text-white/55'>
                {(s.deaths > 0 ? s.frags / s.deaths : s.frags).toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
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
  mode: modeProp,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  footer: ReactNode;
  onHoverChange?: (hovered: boolean) => void;
} & RewardProps) {
  // Stable winners identity so the 3D scene mounts once (not every HUD tick).
  const rosterKey = scores.slice(0, 3).map((s) => `${s.id}:${s.frags}:${s.hat ?? ''}:${s.emote ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const winners = useMemo(() => buildPodiumWinners(scores, settings), [rosterKey, settings.hat, settings.emote, settings.looks]);
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

  const mode = resultMode(scores, modeProp, progression?.mode);
  const head = headlineFor(won, scores, mode);

  // The slam's sound, on its impact frame.
  const stampRef = useRef(head.stamp);
  useEffect(() => {
    const id = window.setTimeout(() => playUi('stamp', stampRef.current), 170);
    return () => window.clearTimeout(id);
  }, []);

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

  const tone =
    head.tone === 'win'
      ? { text: 'text-emerald-300', glow: 'rgba(52,211,153,0.6)', line: '#6ee7b7', wash: 'rgba(16,185,129,0.16)' }
      : head.tone === 'loss'
        ? { text: 'text-rose-300', glow: 'rgba(244,63,94,0.6)', line: '#fda4af', wash: 'rgba(225,29,72,0.16)' }
        : { text: 'text-cyan-100', glow: 'rgba(34,211,238,0.45)', line: '#a5f3fc', wash: 'rgba(34,211,238,0.12)' };

  return (
    <ModalShell
      label={`${head.title} — final standings`}
      tone={head.tone === 'win' ? 'emerald' : head.tone === 'loss' ? 'rose' : 'cyan'}
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
          className='rw-shake relative overflow-hidden px-4 pb-3 pt-3.5 text-center sm:px-6'
          style={{
            background: `radial-gradient(60% 150% at 50% 0%, ${tone.wash}, rgba(0,0,0,0.5) 72%)`,
            borderBottom: `1px solid ${tone.line}33`,
          }}
        >
          <div
            aria-hidden='true'
            className='rw-flare pointer-events-none absolute inset-x-0 h-[2px]'
            style={{ top: 'calc(50% - 8px)', background: `linear-gradient(90deg, transparent, ${tone.line}, transparent)` }}
          />
          <div className='rw-sub-in mb-1.5 font-display text-[10px] font-bold uppercase tracking-[0.42em] text-white/40'>
            Match complete
          </div>
          <div
            className={`rw-slam font-display text-[1.85rem] font-bold uppercase leading-none tracking-[0.16em] sm:text-[2.75rem] sm:tracking-[0.22em] ${tone.text}`}
            style={{ textShadow: `0 3px 0 rgba(0,0,0,0.55), 0 0 28px ${tone.glow}` }}
          >
            {head.title}
          </div>
          <div className='rw-sub-in mt-2 font-sans text-[14px] text-white/60'>{head.sub}</div>
        </div>

        <div className='grid [grid-template-areas:"podium"_"rewards"_"board"] lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[auto_1fr] lg:[grid-template-areas:"podium_rewards"_"board_rewards"]'>
          {/* Hero: the 3D podium of the top 3 (full looks + emotes), framed as a
              stage that fades into the panel below. */}
          <div className='pg-stage [grid-area:podium]' data-tone={head.tone} style={{ '--pg-accent': tone.line } as CSSProperties}>
            <PodiumResults winners={winners} lowSpec={!!settings.lowSpec} reduced={reduced} />
            <div aria-hidden='true' className='pg-stage-vignette' />
            <div aria-hidden='true' className='pg-stage-fade' />
            <i aria-hidden='true' className='pg-corner pg-corner-tl' />
            <i aria-hidden='true' className='pg-corner pg-corner-tr' />
          </div>

          {/* Rewards: the reveal (or its placeholder while the reply is in flight). */}
          <aside
            aria-label='Rewards'
            style={{ '--pg-accent': tone.line } as CSSProperties}
            className='pg-rewards border-b border-white/10 px-5 py-4 [grid-area:rewards] lg:border-b-0 lg:border-l'
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

          {/* Personal performance card, then the full scoreboard. */}
          <div className='flex flex-col gap-4 p-5 pt-3.5 [grid-area:board]'>
            {result && <PerformanceCard result={result} />}
            <Scoreboard scores={scores} mode={mode} />
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
            <div className='absolute -top-6 right-0 text-[12px] text-white/50'>Paused</div>
          )}
        </div>
      }
    />
  );
}

export function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className='text-[12px] text-white/50'>{label}</div>
      <div className='text-lg font-bold tabular-nums'>{value}</div>
    </div>
  );
}
