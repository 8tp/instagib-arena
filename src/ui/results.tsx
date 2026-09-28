// End-of-match results: Victory/Defeat, the 3D podium, the scoreboard, match
// stats and the XP / credits roll-up (offline + online variants).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MatchResult } from '../game/game';
import type { PlayerScore } from '../game/types';
import type { ProgressionResp, Settings } from '../app-types';
import { DeckButton, ModalShell } from '../deck';
import { PodiumScene, type PodiumWinner } from '../game/podium';
import { DEFAULT_EMOTE, DEFAULT_HAT, EMOTES, caseHats, cosmeticById } from '../game/cosmetics';
import { levelProgress } from '../game/progression';

// End-of-match XP moment: animated XP bar, +XP / +credits, a LEVEL UP flourish,
// and any new cosmetic unlocks. Driven entirely by the server's POST /api/stats
// response so the numbers are authoritative.
// Eased 0→value counter for the +XP / +credits roll-ups.
function useCountUp(value: number, durationMs = 1000, startDelayMs = 250): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (value <= 0) {
      setN(value);
      return;
    }
    let raf = 0;
    let startT = 0;
    const tick = (now: number) => {
      if (!startT) startT = now;
      const t = Math.min(1, (now - startT) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    const to = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, startDelayMs);
    return () => {
      window.clearTimeout(to);
      cancelAnimationFrame(raf);
    };
  }, [value, durationMs, startDelayMs]);
  return n;
}

function XpReward({ progression }: { progression: ProgressionResp }) {
  const lp = levelProgress(progression.progression.totalXp);
  const preLp = levelProgress(Math.max(0, progression.progression.totalXp - progression.xpGained));
  const pct = (l: ReturnType<typeof levelProgress>) =>
    l.xpForNext > 0 ? Math.min(100, (l.xpIntoLevel / l.xpForNext) * 100) : 100;
  const startFill = pct(preLp);
  const target = pct(lp);

  // Animate the bar from where it was BEFORE the match to the new value, wrapping
  // through 100% with a flash on level-up so the gain is felt, not just shown.
  const [fill, setFill] = useState(startFill);
  const [noAnim, setNoAnim] = useState(false);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setFill(progression.leveledUp ? 100 : target), 300));
    if (progression.leveledUp) {
      timers.push(
        window.setTimeout(() => {
          setFlash(true);
          setNoAnim(true);
          setFill(0);
        }, 300 + 760),
      );
      timers.push(
        window.setTimeout(() => {
          setNoAnim(false);
          setFill(target);
        }, 300 + 820),
      );
      timers.push(window.setTimeout(() => setFlash(false), 300 + 1400));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const xpN = useCountUp(progression.xpGained);
  const credN = useCountUp(progression.creditsGained);
  const unlocks = progression.newUnlocks.map((id) => cosmeticById(id)?.name ?? id);

  return (
    <div
      className={`clip-deck-sm mt-4 border px-4 py-3 transition-colors ${
        flash ? 'border-emerald-400/60 bg-emerald-300/[0.08]' : 'border-cyan-500/20 bg-cyan-300/[0.04]'
      }`}
    >
      <div className='flex items-baseline justify-between'>
        <span className='text-[10px] uppercase tracking-[0.28em] text-cyan-200/70'>Experience</span>
        <span className='text-sm font-bold tabular-nums text-cyan-200'>
          +{xpN} XP
          {progression.creditsGained > 0 && (
            <span className='ml-2 text-amber-300'>+{credN} ⛁</span>
          )}
        </span>
      </div>
      <div className='mt-2 flex items-center gap-2'>
        <span className='text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-200/80'>
          Lv {lp.level}
        </span>
        <div className='deck-bar relative h-2.5 flex-1'>
          <div
            className={`bg-gradient-to-r from-cyan-400 to-sky-300 ${
              noAnim ? '' : 'transition-[width] duration-700 ease-out'
            }`}
            style={{ width: `${fill}%`, boxShadow: '0 0 10px rgba(56,189,248,0.55)' }}
          />
        </div>
      </div>
      <div className='mt-1 flex items-center justify-between text-[10px] tabular-nums text-white/40'>
        <span>{lp.xpForNext > 0 ? `${lp.xpIntoLevel} / ${lp.xpForNext}` : 'MAX LEVEL'}</span>
        {progression.leveledUp && (
          <span
            className='font-bold uppercase tracking-[0.18em] text-emerald-300'
            style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.6))' }}
          >
            ★ Level up! → Lv {lp.level}
          </span>
        )}
      </div>
      {unlocks.length > 0 && (
        <div className='mt-2 text-[11px] text-amber-200'>
          Unlocked: <span className='font-semibold'>{unlocks.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

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
  const caseHatIds = caseHats().map((h) => h.id);
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

// Shared results panel: Victory/Defeat header, the 3D top-3 podium, the full
// scoreboard, match stats + XP reward, and a caller-supplied footer (offline =
// Play Again/Lobby; online = Continue to the map vote).
function ResultsPanel({
  won,
  scores,
  settings,
  result,
  progression,
  footer,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  footer: ReactNode;
}) {
  const acc = result && result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  // Stable winners identity so the 3D scene mounts once (not every HUD tick).
  const rosterKey = scores.slice(0, 3).map((s) => `${s.id}:${s.frags}:${s.hat ?? ''}:${s.emote ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const winners = useMemo(() => buildPodiumWinners(scores, settings), [rosterKey, settings.hat, settings.emote]);

  return (
    <ModalShell
      label={won ? 'Victory — final standings' : 'Defeat — final standings'}
      tone={won ? 'emerald' : 'rose'}
      size='xl'
      z='z-30'
      backdrop='heavy'
      scroll
      padded={false}
      bodyClassName='gap-0'
    >
      {/* Header: Victory/Defeat title (kept clear of the 3D labels below) */}
      <div className='border-b border-white/10 bg-black/40 py-3 text-center'>
        <span
          className={`font-display text-2xl font-bold uppercase tracking-[0.24em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
          style={{
            filter: won
              ? 'drop-shadow(0 0 16px rgba(52,211,153,0.55))'
              : 'drop-shadow(0 0 16px rgba(244,63,94,0.55))',
          }}
        >
          {won ? 'Victory' : 'Defeat'}
        </span>
        <span className='ml-3 text-[10px] uppercase tracking-[0.3em] text-white/40'>Final Standings</span>
      </div>
      {/* Hero: the 3D podium of the top 3 (hats + emotes) */}
      <div className='h-[340px] w-full shrink-0 bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
        <PodiumResults winners={winners} />
      </div>

      <div className='p-6 pt-4'>
        {/* Full scoreboard (all players, compact) */}
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
              className={`deck-tr grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 px-3 py-1.5 text-sm ${
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
          <div className='mt-4 grid grid-cols-4 gap-2 text-center'>
            <MiniStat label='Kills' value={result.kills} />
            <MiniStat label='Deaths' value={result.deaths} />
            <MiniStat label='Streak' value={result.bestStreak} />
            <MiniStat label='Acc' value={`${acc}%`} />
          </div>
        )}

        {progression && <XpReward progression={progression} />}

        <div className='mt-6 flex gap-3'>{footer}</div>
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
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onPlayAgain: () => void;
  onLobby: () => void;
}) {
  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      footer={
        <>
          <DeckButton onClick={onPlayAgain} solid accent='emerald' center className='flex-1'>
            Play Again
          </DeckButton>
          <DeckButton onClick={onLobby} center className='flex-1' sound='uiBack'>
            Lobby
          </DeckButton>
        </>
      }
    />
  );
}

// Online results — same podium, then auto-advances to the map vote (or click).
// Kept shorter than the 15s vote so players still get time to pick a map.
export function OnlineMatchResults({
  won,
  scores,
  settings,
  result,
  progression,
  onContinue,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onContinue: () => void;
}) {
  const [secs, setSecs] = useState(8);
  useEffect(() => {
    if (secs <= 0) {
      onContinue();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs]);

  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      footer={
        <DeckButton onClick={onContinue} solid accent='cyan' center className='flex-1'>
          Continue to Map Vote {secs > 0 ? `(${secs})` : ''}
        </DeckButton>
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
