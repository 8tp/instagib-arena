// End-of-match map vote: a card per candidate map (levelshot thumbnail, live
// vote count + share bar, your pick, the current leader) and a draining
// countdown. The bar is a CSS animation offset by the time already elapsed, so
// React only re-renders once a second for the number.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ModalShell } from '../deck';
import { prefersReducedMotion, sfxProps } from '../deck-core';
import { MAPS } from '../game/map';
import type { MapVoteState } from '../game/types';
import { useLevelshots } from './levelshot';
import './postgame.css';

// "Causeway (FFA/TDM)" → name "Causeway" + tag "FFA/TDM".
function mapLabel(id: string): { name: string; tag: string | null } {
  const label = MAPS.find((m) => m.id === id)?.label ?? id;
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  return m ? { name: m[1], tag: m[2] } : { name: label, tag: null };
}

// Distinct fallback tint per map while (or if) its thumbnail isn't available.
function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 18%), hsl(${(h + 50) % 360} 55% 9%))`;
}

export function MapVoteOverlay({
  vote,
  onVote,
  reducedEffects = false,
}: {
  vote: MapVoteState;
  onVote: (mapId: string) => void;
  reducedEffects?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  // Whole-second tick only: the drain bar animates in CSS.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remainingSec = Math.max(0, Math.ceil((vote.endsAtClient - now) / 1000));
  const totalVotes = Object.values(vote.counts).reduce((a, b) => a + b, 0);
  const lead = Math.max(0, ...vote.options.map((id) => vote.counts[id] ?? 0));
  const shots = useLevelshots(vote.options);
  const reduced = reducedEffects || prefersReducedMotion();

  // Drain animation: total = the vote's length, pre-advanced by what has
  // already elapsed when the overlay mounted.
  const drain = useMemo(() => {
    const total = Math.max(1, vote.durationMs);
    const elapsed = Math.min(total, Math.max(0, total - (vote.endsAtClient - Date.now())));
    return { '--pg-drain': `${total}ms`, '--pg-elapsed': `-${elapsed}ms` } as CSSProperties;
  }, [vote.endsAtClient, vote.durationMs]);
  const urgent = remainingSec <= 5;

  return (
    <ModalShell label='Vote next map' z='z-30' width='w-[780px]' backdrop='heavy' bodyClassName='gap-4'>
      <div className='pg-motion flex flex-col gap-4' data-reduced={reduced ? '1' : '0'}>
        <div className='flex items-end justify-between gap-4'>
          <div>
            <div className='font-display text-2xl font-bold uppercase leading-tight tracking-[0.16em] text-cyan-200'>
              Vote next map
            </div>
          </div>
          <div className='text-right' aria-live='polite'>
            <div
              className={`font-display text-4xl font-bold leading-none tabular-nums ${urgent ? 'text-amber-300' : 'text-white'}`}
            >
              {remainingSec}
              <span className='ml-0.5 text-base text-white/60'>s</span>
            </div>
            <div className='mt-1 font-sans text-[13px] text-white/65'>
              {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
            </div>
          </div>
        </div>

        <div aria-hidden='true' className='h-[3px] w-full overflow-hidden bg-white/10' style={drain}>
          <div
            className={`pg-drain h-full ${urgent ? 'bg-amber-300' : 'bg-cyan-300'}`}
            style={{ animationDuration: 'var(--pg-drain)', animationDelay: 'var(--pg-elapsed)' }}
          />
        </div>

        <div className='grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]'>
          {vote.options.map((id, i) => {
            const count = vote.counts[id] ?? 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const mine = vote.myVote === id;
            const leading = lead > 0 && count === lead;
            const label = mapLabel(id);
            return (
              <button
                key={id}
                type='button'
                aria-pressed={mine}
                data-lead={leading ? '1' : '0'}
                onClick={() => onVote(id)}
                {...sfxProps('uiConfirm')}
                className='pg-vote-card'
                style={{ '--i': i } as CSSProperties}
              >
                <div
                  className='pg-vote-art relative'
                  style={{
                    backgroundImage: shots[id] ? `url(${shots[id]})` : tintFor(id),
                  }}
                >
                  <div className='absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent' />
                  <div className='absolute left-2 top-2 flex gap-1.5'>
                    {mine && <span className='rw-chip rw-chip-emerald'>Your vote</span>}
                    {leading && <span className='rw-chip rw-chip-amber'>Leading</span>}
                  </div>
                  <div className='absolute inset-x-3 bottom-2 flex items-end justify-between gap-2'>
                    <span className='min-w-0'>
                      <span className='block truncate font-display text-base font-bold uppercase tracking-[0.12em] text-white [text-shadow:0_2px_6px_rgba(0,0,0,0.8)]'>
                        {label.name}
                      </span>
                      {label.tag && <span className='block text-[10px] tracking-[0.18em] text-white/55'>{label.tag}</span>}
                    </span>
                    <span className='font-display text-2xl font-bold leading-none tabular-nums text-white [text-shadow:0_2px_6px_rgba(0,0,0,0.8)]'>
                      {count}
                    </span>
                  </div>
                </div>
                <div className='h-1.5 w-full bg-white/10'>
                  <div
                    className={`pg-vote-fill h-full ${mine ? 'bg-emerald-400' : 'bg-cyan-400/80'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        <div className='text-center font-sans text-[13px] text-white/70'>
          {vote.myVote ? 'Vote locked — click another map to change it' : 'Click a map to vote'}
        </div>
      </div>
    </ModalShell>
  );
}
