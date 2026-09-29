// Ranked Duel end-of-match overlay: Victory / Defeat, a rank badge, the rating
// counting from the old value to the new one with the Elo delta ticking beside
// it, progress toward the next tier, and the XP / credits the match paid.
// The counters write straight to the DOM from a rAF loop (dt-smoothed), so
// React never re-renders for the animation.
import { useEffect, useRef, type CSSProperties } from 'react';
import type { ProgressionResp } from '../app-types';
import { DeckButton, ModalShell } from '../deck';
import { prefersReducedMotion } from '../deck-core';
import { RANKED_TIERS, rankedTier } from '../game/constants';
import type { RankedResult } from '../game/net';
import './postgame.css';

// Smoothly walks a number toward `to` and writes it into the element.
function useCountTo(from: number, to: number, reduced: boolean, delayMs: number, signed: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (v: number) => {
      const n = Math.round(v);
      return signed ? `${n >= 0 ? '+' : ''}${n}` : String(n);
    };
    if (reduced || from === to) {
      el.textContent = fmt(to);
      return;
    }
    el.textContent = fmt(from);
    let v = from;
    let last = 0;
    let raf = 0;
    const tick = (t: number) => {
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      v += (to - v) * (1 - Math.exp(-5 * dt));
      if (Math.abs(to - v) < 0.5) {
        el.textContent = fmt(to);
        return;
      }
      el.textContent = fmt(v);
      raf = requestAnimationFrame(tick);
    };
    const start = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delayMs);
    return () => {
      window.clearTimeout(start);
      cancelAnimationFrame(raf);
    };
  }, [from, to, reduced, delayMs, signed]);
  return ref;
}

export function RankedResultOverlay({
  result,
  progression,
  onLobby,
  reducedEffects = false,
}: {
  result: RankedResult;
  progression: ProgressionResp | null;
  onLobby: () => void;
  reducedEffects?: boolean;
}) {
  const won = result.won;
  const mine = result.rating ? (won ? result.rating.winner : result.rating.loser) : null;
  const delta = mine?.delta ?? 0;
  const before = mine ? mine.rating - delta : 0;
  const tier = mine ? rankedTier(mine.rating) : null;
  const tierBefore = mine ? rankedTier(before) : null;
  const reduced = reducedEffects || prefersReducedMotion();
  const ratingRef = useCountTo(before, mine?.rating ?? 0, reduced, 700, false);
  const deltaRef = useCountTo(0, delta, reduced, 700, true);

  // Progress inside the current tier band toward the next one.
  const idx = tier ? RANKED_TIERS.findIndex((t) => t.name === tier.name) : -1;
  const next = idx > 0 ? RANKED_TIERS[idx - 1] : null;
  const pct = mine && tier && next ? Math.min(100, Math.max(0, ((mine.rating - tier.min) / (next.min - tier.min)) * 100)) : 100;
  const promoted = !!(tier && tierBefore && tier.min > tierBefore.min);
  const demoted = !!(tier && tierBefore && tier.min < tierBefore.min);
  const accent = won ? 'text-emerald-300' : 'text-rose-300';

  return (
    <ModalShell
      label={won ? 'Ranked duel — victory' : 'Ranked duel — defeat'}
      tone={won ? 'emerald' : 'rose'}
      z='z-[60]'
      width='w-[460px]'
      backdrop='heavy'
      padded={false}
      bodyClassName='gap-0'
      footer={
        <DeckButton onClick={onLobby} solid accent='emerald' center className='mx-auto'>
          Back to lobby
        </DeckButton>
      }
    >
      <div
        className='pg-motion'
        data-reduced={reduced ? '1' : '0'}
      >
        <div
          className={`relative overflow-hidden px-7 py-6 text-center ${won ? 'bg-emerald-400/10' : 'bg-rose-500/10'}`}
          style={{
            background: `radial-gradient(70% 140% at 50% 0%, ${won ? 'rgba(16,185,129,0.22)' : 'rgba(225,29,72,0.22)'}, transparent 75%)`,
          }}
        >
          <div className={`rw-slam font-display text-4xl font-bold uppercase tracking-[0.18em] ${accent}`}>
            {won ? 'Victory' : 'Defeat'}
          </div>
          <div className='mt-1 text-[12px] uppercase tracking-[0.2em] text-white/45'>
            Ranked Duel · {result.winnerFrags}–{result.loserFrags}
            {result.forfeit && ' · forfeit'}
          </div>
        </div>

        <div className='px-7 pb-6 pt-5'>
          {mine && tier ? (
            <div className='flex items-center gap-5'>
              <div
                className='pg-rank-badge relative grid h-[92px] w-[80px] shrink-0 place-items-center text-center'
                style={{ '--tier': tier.color } as CSSProperties}
              >
                <div
                  aria-hidden='true'
                  className='absolute inset-0'
                  style={{
                    background: `linear-gradient(160deg, ${tier.color}, color-mix(in srgb, ${tier.color} 30%, #05070b))`,
                    clipPath: 'polygon(50% 0, 100% 16%, 100% 68%, 50% 100%, 0 68%, 0 16%)',
                    filter: `drop-shadow(0 0 14px color-mix(in srgb, ${tier.color} 55%, transparent))`,
                  }}
                />
                <div
                  aria-hidden='true'
                  className='absolute inset-[3px] bg-[#0b0f16]'
                  style={{ clipPath: 'polygon(50% 0, 100% 16%, 100% 68%, 50% 100%, 0 68%, 0 16%)' }}
                />
                <span className='relative font-display text-4xl font-bold' style={{ color: tier.color }}>
                  {tier.name[0]}
                </span>
              </div>

              <div className='min-w-0 flex-1'>
                <div className='deck-label'>New rating</div>
                <div className='flex items-baseline gap-3'>
                  <span
                    ref={ratingRef}
                    className='font-display text-5xl font-bold leading-none tabular-nums'
                    style={{ color: tier.color }}
                  />
                  <span
                    ref={deltaRef}
                    className={`font-mono text-xl font-bold tabular-nums ${delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                  />
                </div>
                <div className='mt-1.5 text-[12px] text-white/60'>
                  <span style={{ color: tier.color }}>{tier.name}</span> · ladder #{mine.rank}
                  {promoted && <span className='rw-chip rw-chip-emerald ml-2'>Promoted</span>}
                  {demoted && <span className='rw-chip rw-chip-plain ml-2'>Demoted</span>}
                </div>
                <div className='mt-2 h-1.5 w-full bg-white/10'>
                  <div className='h-full' style={{ width: `${pct}%`, background: tier.color, transition: 'width 600ms' }} />
                </div>
                <div className='mt-1 text-[11px] text-white/40'>
                  {next ? `${next.min - mine.rating} to ${next.name}` : 'Top tier'}
                </div>
              </div>
            </div>
          ) : (
            <div className='text-center text-[12px] text-white/50'>Unranked result.</div>
          )}
          {result.reduced && mine && (
            <div className='mt-3 text-[11px] text-amber-300/80'>Reduced rating — repeat opponent</div>
          )}
          {progression && (progression.xpGained > 0 || progression.creditsGained > 0) && (
            <div className='mt-5 flex items-center justify-center gap-6 border-t border-white/10 pt-4 text-sm'>
              <span className='font-display font-bold text-cyan-200'>+{progression.xpGained} XP</span>
              {progression.creditsGained > 0 && (
                <span className='font-display font-bold text-amber-200'>+{progression.creditsGained} credits</span>
              )}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
