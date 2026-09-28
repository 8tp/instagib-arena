import { useCallback, useEffect, useState } from 'react';
import { sfxProps } from '../deck-core';
import { DeckButton, ModalShell, Skeleton } from '../deck';
import { claimChallengeReward, fetchChallenges, useNow } from './menu-hooks';
import { challengeState, fmtCountdown, resetTime, type ChallengeLists, type ChallengeView } from './road-data';
import './menu.css';

// Daily + weekly challenges: a compact strip on the menu (right column) and
// the full dialog. Rows share one look: name, reward, a thin progress bar
// with the count. Completed-and-granted rows read as done; a Claim button
// only appears when a reward is actually waiting.

function CheckGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 16 16' aria-hidden='true' className='shrink-0'>
      <path d='M2.5 8.5l3.5 3.5 7.5-8' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='square' />
    </svg>
  );
}

function StripRow({
  c,
  claiming,
  onClaim,
}: {
  c: ChallengeView;
  claiming: boolean;
  onClaim?: (id: string) => void;
}) {
  const state = challengeState(c);
  const pct = c.goal > 0 ? Math.min(100, (Math.min(c.progress, c.goal) / c.goal) * 100) : 0;
  return (
    <div className='menu-ch-row' data-state={state} data-challenge={c.id}>
      <span className='menu-ch-name' title={c.title}>
        {c.title}
      </span>
      {state === 'claimable' && onClaim ? (
        <button
          type='button'
          disabled={claiming}
          onClick={() => onClaim(c.id)}
          {...sfxProps('uiConfirm')}
          className='menu-ch-claim'
        >
          {claiming ? 'Claiming' : 'Claim'}
        </button>
      ) : state === 'done' ? (
        <span className='menu-ch-reward inline-flex items-center gap-1'>
          <CheckGlyph /> Done
        </span>
      ) : (
        <span className='menu-ch-reward'>+{c.rewardXp} XP</span>
      )}
      <span className='menu-ch-bar'>
        <span className='menu-ch-track'>
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className='menu-ch-count'>
          {Math.min(c.progress, c.goal)}/{c.goal}
        </span>
      </span>
    </div>
  );
}

export function ChallengesStrip({
  lists,
  guest,
  onOpen,
  onLogin,
  onClaimed,
}: {
  lists: ChallengeLists | null;
  guest: boolean;
  onOpen: () => void;
  onLogin: () => void;
  onClaimed: () => void;
}) {
  const now = useNow();
  const [claiming, setClaiming] = useState<string | null>(null);
  const claim = async (id: string) => {
    setClaiming(id);
    if (await claimChallengeReward(id)) onClaimed();
    setClaiming(null);
  };
  const group = (period: 'daily' | 'weekly', rows: ChallengeView[]) => (
    <div key={period}>
      <div className='menu-ch-group'>
        <b>{period === 'daily' ? 'Daily' : 'Weekly'}</b>
        <span>Resets in {fmtCountdown(resetTime(period, lists, now) - now)}</span>
      </div>
      {rows.map((c) => (
        <StripRow key={c.id} c={c} claiming={claiming === c.id} onClaim={guest ? undefined : claim} />
      ))}
    </div>
  );
  return (
    <section aria-label='Challenges' className={`menu-panel ${guest ? 'menu-ch-guest' : ''}`}>
      <div className='menu-panel-head'>
        <h2 className='menu-panel-title'>Challenges</h2>
        <button type='button' onClick={onOpen} {...sfxProps('uiClick')} className='menu-panel-action'>
          View all
        </button>
      </div>
      {lists ? (
        <div className='pb-1.5'>
          {group('daily', lists.daily)}
          {group('weekly', lists.weekly)}
        </div>
      ) : (
        <div className='flex flex-col gap-3 px-[0.9rem] pb-3 pt-1' aria-busy='true' aria-label='Loading challenges'>
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className='h-3 w-3/4' />
              <Skeleton className='mt-2 h-[3px] w-full' />
            </div>
          ))}
        </div>
      )}
      {guest && (
        <p className='menu-ch-foot'>
          Challenges track for players with an account.{' '}
          <button type='button' onClick={onLogin} {...sfxProps('uiClick')}>
            Log in
          </button>
        </p>
      )}
    </section>
  );
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

function ModalRow({
  c,
  guest,
  claiming,
  onClaim,
}: {
  c: ChallengeView;
  guest: boolean;
  claiming: boolean;
  onClaim: (id: string) => void;
}) {
  const state = challengeState(c);
  const pct = c.goal > 0 ? Math.min(100, (Math.min(c.progress, c.goal) / c.goal) * 100) : 0;
  const tone =
    state === 'claimable' ? 'border-emerald-400/45 bg-emerald-400/[0.06]' : state === 'done' ? 'deck-card-muted' : '';
  return (
    <div
      data-challenge={c.id}
      data-complete={c.complete ? '1' : '0'}
      data-claimed={c.claimed ? '1' : '0'}
      className={`deck-card px-4 py-3 ${tone}`}
    >
      <div className='flex items-baseline justify-between gap-3'>
        <span className={`font-sans text-[14px] ${state === 'done' ? 'text-white/50' : 'text-white/90'}`}>{c.title}</span>
        <span className='shrink-0 font-mono text-[11px] tabular-nums text-amber-300/90'>
          {c.rewardXp} XP · {c.rewardCredits} cr
        </span>
      </div>
      <div className='mt-2.5 flex items-center gap-3'>
        <div className='deck-bar h-1.5 flex-1'>
          <div
            className={state === 'active' ? 'bg-cyan-400' : 'bg-emerald-400'}
            style={{ width: `${pct}%`, opacity: state === 'done' ? 0.6 : 1 }}
          />
        </div>
        <span className='w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/55'>
          {Math.min(c.progress, c.goal)}/{c.goal}
        </span>
        <span className='flex w-[5.5rem] shrink-0 justify-end'>
          {state === 'claimable' && !guest ? (
            <DeckButton
              data-action='claim'
              disabled={claiming}
              onClick={() => onClaim(c.id)}
              accent='emerald'
              solid
              size='xs'
              center
              className='w-full'
            >
              {claiming ? 'Claiming' : 'Claim'}
            </DeckButton>
          ) : state === 'done' ? (
            <span className='inline-flex items-center gap-1 font-display text-[12px] font-semibold uppercase tracking-[0.1em] text-emerald-300/80'>
              <CheckGlyph /> Done
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function ChallengesModal({ guest, onClose }: { guest: boolean; onClose: () => void }) {
  const [data, setData] = useState<ChallengeLists | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [claiming, setClaiming] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(() => {
    void fetchChallenges().then((d) => {
      if (d) {
        setData(d);
        setState('ready');
      } else setState('error');
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const claim = async (id: string) => {
    setClaiming(id);
    if (await claimChallengeReward(id)) load();
    setClaiming(null);
  };

  const heading = (period: 'daily' | 'weekly') => (
    <div className='mb-2 flex items-baseline justify-between gap-3'>
      <h3 className='font-display text-[15px] font-bold uppercase tracking-[0.08em] text-white/90'>
        {period === 'daily' ? 'Daily' : 'Weekly'}
      </h3>
      <span className='font-mono text-[11px] tabular-nums text-white/45'>
        Resets in {fmtCountdown(resetTime(period, data, now) - now)}
      </span>
    </div>
  );

  const RowSkeleton = (i: number) => (
    <div key={i} className='deck-card px-4 py-3'>
      <div className='flex items-center justify-between gap-2'>
        <Skeleton className='h-3.5 w-44' />
        <Skeleton className='h-2.5 w-20' />
      </div>
      <div className='mt-3 flex items-center gap-3'>
        <Skeleton className='h-1.5 flex-1' />
        <Skeleton className='h-3 w-14' />
      </div>
    </div>
  );

  return (
    <ModalShell title='Challenges' size='lg' onClose={onClose} scroll>
      {state === 'loading' && (
        <div className='flex flex-col gap-5' aria-busy='true' aria-label='Loading challenges'>
          <div className='flex flex-col gap-2'>{[0, 1, 2].map(RowSkeleton)}</div>
          <div className='flex flex-col gap-2'>{[3, 4].map(RowSkeleton)}</div>
        </div>
      )}
      {state === 'error' && (
        <div className='font-sans text-sm text-white/55'>Couldn&apos;t load challenges. Try again in a moment.</div>
      )}
      {state === 'ready' && data && (
        <div className='flex flex-col gap-5'>
          <section>
            {heading('daily')}
            <div className='flex flex-col gap-2'>
              {data.daily.map((c) => (
                <ModalRow key={c.id} c={c} guest={guest} claiming={claiming === c.id} onClaim={claim} />
              ))}
            </div>
          </section>
          <section>
            {heading('weekly')}
            <div className='flex flex-col gap-2'>
              {data.weekly.map((c) => (
                <ModalRow key={c.id} c={c} guest={guest} claiming={claiming === c.id} onClaim={claim} />
              ))}
            </div>
          </section>
          <p className='font-sans text-[12px] leading-relaxed text-white/40'>
            {guest
              ? 'Challenges track for players with an account. Log in and they count from your next online match.'
              : 'Challenges count online matches. Finished ones pay out their XP and credits.'}
          </p>
        </div>
      )}
    </ModalShell>
  );
}
