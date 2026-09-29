import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ModalShell, Skeleton } from '../deck';
import { rankedTier } from '../game/constants';
import type { InstagibProfile } from '../app-types';
import { PanelCard, PanelState, Ring } from './parts';

// Career dashboard: level + XP up top, then a grid of KPI cards (accuracy ring,
// K/D, wins with win-rate, headshot share, best streak, ranked standing).
// Everything is derived from the same /api/profile payload as before.

function Kpi({
  label,
  value,
  sub,
  pct,
  accent,
  className = '',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  pct?: number; // optional share bar under the number
  accent?: string;
  className?: string;
}) {
  return (
    <div
      className={`pn-card clip-deck-sm flex flex-col px-4 py-3.5 ${className}`}
      style={accent ? ({ ['--pn-accent' as string]: accent } as CSSProperties) : undefined}
    >
      <div className='deck-label'>{label}</div>
      <div className='pn-kpi-value mt-2'>{value}</div>
      {sub && <div className='font-sans mt-1.5 text-[11px] tabular-nums text-white/65'>{sub}</div>}
      {pct != null && (
        <div className='pn-kpi-bar' aria-hidden='true'>
          <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      )}
    </div>
  );
}

export function StatsModal({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState<InstagibProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setState('loading');
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile unavailable'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active) return;
        setProfile(d.profile ?? null);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [nonce]);

  const stats = profile?.stats ?? null;
  const kd =
    stats && stats.totalDeaths > 0
      ? (stats.totalKills / stats.totalDeaths).toFixed(2)
      : String(stats?.totalKills ?? 0);
  const xpPct =
    profile && profile.xpForNext > 0
      ? Math.min(100, Math.round((profile.xpIntoLevel / profile.xpForNext) * 100))
      : 100;
  const winRate = stats && stats.totalGames > 0 ? Math.round((stats.totalWins / stats.totalGames) * 100) : 0;
  const hsRate = stats && stats.totalKills > 0 ? Math.round((stats.headshots / stats.totalKills) * 100) : 0;
  const acc = stats?.bestAccuracy ?? 0;
  const tier = profile?.ranked ? rankedTier(profile.ranked.rating) : null;

  return (
    <ModalShell title='Career stats' size='lg' onClose={onClose} bodyClassName='gap-3'>
      {state === 'loading' && (
        <div className='flex flex-col gap-3' aria-busy='true' aria-label='Loading profile'>
          <div className='pn-card clip-deck-sm flex items-center gap-4 p-4'>
            <Skeleton className='h-16 w-16 shrink-0' />
            <div className='min-w-0 flex-1'>
              <Skeleton className='h-3 w-24' />
              <Skeleton className='mt-3 h-2.5 w-full' />
              <Skeleton className='mt-2.5 h-2.5 w-2/5' />
            </div>
          </div>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className='pn-card clip-deck-sm px-4 py-3.5'>
                <Skeleton className='h-2.5 w-16' />
                <Skeleton className='mt-3 h-7 w-14' />
                <Skeleton className='mt-3 h-2 w-20' />
              </div>
            ))}
          </div>
        </div>
      )}
      {state === 'error' && (
        <PanelState
          tone='error'
          title='Couldn’t load your profile'
          hint='Stats sync from the server. Check your connection and try again.'
          action={{ label: 'Retry', onClick: () => setNonce((n) => n + 1) }}
        />
      )}
      {state === 'ready' && !profile && (
        <PanelState title='No career yet' hint='Finish a match to start tracking your stats.' />
      )}
      {state === 'ready' && profile && stats && (
        <>
          {/* Level + XP + credits — the one accented block. */}
          <div className='clip-deck-sm flex items-center gap-4 border border-cyan-400/25 bg-cyan-300/[0.05] p-4'>
            <div className='clip-deck-sm flex h-16 w-16 shrink-0 flex-col items-center justify-center border-2 border-cyan-400/60 bg-cyan-300/10'>
              <div className='font-mono text-[8px] uppercase tracking-[0.18em] text-cyan-200/70'>Level</div>
              <div className='font-display text-2xl font-bold leading-none text-cyan-100'>{profile.level}</div>
            </div>
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between gap-3 text-[11px]'>
                <span className='font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-white/70'>
                  {profile.xpForNext > 0 ? `${xpPct}% to level ${profile.level + 1}` : 'Max level'}
                </span>
                <span className='shrink-0 font-semibold tabular-nums text-amber-300'>{profile.credits} ⛁</span>
              </div>
              <div className='deck-bar mt-2 h-2.5'>
                <div className='bg-gradient-to-r from-cyan-400 to-sky-300' style={{ width: `${xpPct}%` }} />
              </div>
              <div className='font-sans mt-1.5 text-[11px] tabular-nums text-white/65'>
                {profile.xpForNext > 0
                  ? `${profile.xpIntoLevel} / ${profile.xpForNext} XP · ${profile.totalXp} total`
                  : `${profile.totalXp} XP total`}
              </div>
            </div>
          </div>

          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
            {/* Accuracy ring spans two rows on wide layouts. */}
            <div className='pn-card clip-deck-sm flex flex-col items-center justify-center gap-2 px-4 py-4 max-sm:col-span-2 sm:row-span-2'>
              <div className='deck-label self-start'>Best accuracy</div>
              <Ring pct={acc} size={104} stroke={8}>
                <span className='pn-kpi-value text-[26px]'>{acc.toFixed(1)}</span>
                <span className='font-mono text-[10px] text-white/40'>%</span>
              </Ring>
              <div className='font-sans text-[11px] text-white/65'>best single match</div>
            </div>
            <Kpi label='Kills' value={stats.totalKills} sub={`${stats.totalDeaths} deaths`} />
            <Kpi label='K / D' value={kd} sub='lifetime ratio' accent='#67e8f9' />
            <Kpi
              label='Wins'
              value={stats.totalWins}
              sub={`${winRate}% of ${stats.totalGames} game${stats.totalGames === 1 ? '' : 's'}`}
              pct={winRate}
              accent='#34d399'
            />
            <Kpi
              label='Headshots'
              value={stats.headshots}
              sub={`${hsRate}% of kills`}
              pct={hsRate}
              accent='#fbbf24'
            />
            <div className='pn-card pn-streak clip-deck-sm col-span-2 flex items-center gap-4 px-4 py-3.5 sm:col-span-3'>
              <svg viewBox='0 0 24 24' width='30' height='30' aria-hidden='true' className='shrink-0 text-orange-300'>
                <path
                  d='M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1-.4-2-1-3 3 1.5 5 4 5 7a7 7 0 0 1-14 0c0-6 5-7 7-13z'
                  fill='currentColor'
                  opacity='0.9'
                />
              </svg>
              <div className='min-w-0 flex-1'>
                <div className='deck-label !text-orange-200/60'>Best kill streak</div>
                <div className='pn-kpi-value mt-1.5 !text-orange-100'>{stats.bestKillStreak}</div>
              </div>
              <div className='font-sans text-right text-[11px] text-white/65'>kills without dying</div>
            </div>
          </div>

          {profile.ranked && tier && (
            <PanelCard
              title='Ranked duel'
              aside={profile.ranked.rank > 0 ? `Ladder #${profile.ranked.rank}` : 'Unranked'}
              bodyClassName='flex items-center justify-between gap-4 px-4 py-3'
            >
              <div className='flex items-baseline gap-2.5'>
                <span className='font-display text-2xl font-bold tabular-nums' style={{ color: tier.color }}>
                  {profile.ranked.rating}
                </span>
                <span className='font-display text-[12px] font-semibold uppercase tracking-[0.12em]' style={{ color: tier.color }}>
                  {tier.name}
                </span>
              </div>
              {profile.ranked.provisional && <span className='deck-chip border-amber-400/40 text-amber-300'>Provisional</span>}
            </PanelCard>
          )}
        </>
      )}
    </ModalShell>
  );
}
