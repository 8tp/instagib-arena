import { useCallback, useEffect, useState } from 'react';
import { sfxProps } from '../deck-core';
import { ModalShell, Skeleton } from '../deck';
import { claimChallengeReward, fetchChallenges, useNow } from './menu-hooks';
import { challengeState, fmtCountdown, resetTime, type ChallengeLists, type ChallengeView } from './road-data';
import './menu.css';

// Daily + weekly challenges: a compact widget on the menu (one line per
// challenge) and the full dialog built around progress (icon, a full-width
// bar, reward chips, the count under them). Rewards pay out automatically at
// match end; a Claim button only appears for a reward still waiting. Guests
// see the real challenges, locked, with one "Log in to earn".

/* ── Icons (one per metric) ─────────────────────────────────────────────── */

export function ChallengeIcon({ metric, size = 16 }: { metric?: string; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'square' as const };
  let body;
  switch (metric) {
    case 'wins':
      body = (
        <>
          <path {...p} d='M7 4h10v5a5 5 0 0 1-10 0V4z' />
          <path {...p} d='M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 20h8' />
        </>
      );
      break;
    case 'headshots':
      body = (
        <>
          <path {...p} d='M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.3 3 5.4V20h8v-4.6c1.8-1.1 3-3 3-5.4a7 7 0 0 0-7-7z' />
          <circle cx='9.3' cy='10.5' r='1.7' fill='currentColor' />
          <circle cx='14.7' cy='10.5' r='1.7' fill='currentColor' />
          <path {...p} d='M10.5 20v-2.5M13.5 20v-2.5' />
        </>
      );
      break;
    case 'kills':
      body = (
        <>
          <circle {...p} cx='12' cy='12' r='7' />
          <path {...p} d='M12 2v5M12 17v5M2 12h5M17 12h5' />
        </>
      );
      break;
    case 'streak':
      body = <path {...p} d='M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3-1-3 0-6 1-9z' />;
      break;
    case 'accuracy':
      body = (
        <>
          <circle {...p} cx='12' cy='12' r='8' />
          <circle {...p} cx='12' cy='12' r='4' />
          <circle cx='12' cy='12' r='1.5' fill='currentColor' />
        </>
      );
      break;
    case 'games':
      body = <path {...p} d='M5 21V4M5 4h11l-2 4 2 4H5' />;
      break;
    default:
      body = <path {...p} d='M12 3l7 9-7 9-7-9z' />;
  }
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className='shrink-0'>
      {body}
    </svg>
  );
}

function LockGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className='shrink-0'>
      <rect x='5' y='10' width='14' height='11' fill='currentColor' />
      <path d='M8 10V7a4 4 0 0 1 8 0v3' fill='none' stroke='currentColor' strokeWidth='2.4' />
    </svg>
  );
}

export function CheckGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 16 16' aria-hidden='true' className='shrink-0'>
      <path d='M2.5 8.5l3.5 3.5 7.5-8' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='square' />
    </svg>
  );
}

function pctOf(c: ChallengeView): number {
  return c.goal > 0 ? Math.min(100, (Math.min(c.progress, c.goal) / c.goal) * 100) : 0;
}

// The active challenge nearest completion (highlighted as the one to chase).
function closestId(lists: ChallengeLists | null): string | null {
  if (!lists) return null;
  let best: ChallengeView | null = null;
  for (const c of [...lists.daily, ...lists.weekly]) {
    if (challengeState(c) !== 'active' || c.progress <= 0) continue;
    if (!best || pctOf(c) > pctOf(best)) best = c;
  }
  return best?.id ?? null;
}

/* ── Menu widget ────────────────────────────────────────────────────────── */

function StripRow({
  c,
  guest,
  closest,
  claiming,
  onClaim,
}: {
  c: ChallengeView;
  guest: boolean;
  closest: boolean;
  claiming: boolean;
  onClaim: (id: string) => void;
}) {
  const state = guest ? 'locked' : challengeState(c);
  return (
    <div className='menu-ch-row' data-state={state} data-closest={closest ? '1' : '0'} data-challenge={c.id}>
      <span className='menu-ch-icon'>
        {guest ? <LockGlyph /> : state === 'done' ? <CheckGlyph size={15} /> : <ChallengeIcon metric={c.metric} />}
      </span>
      <span className='menu-ch-name' title={c.title}>
        {c.title}
      </span>
      <span className='menu-ch-xp'>+{c.rewardXp} XP</span>
      {state === 'claimable' ? (
        <button
          type='button'
          disabled={claiming}
          onClick={() => onClaim(c.id)}
          {...sfxProps('uiConfirm')}
          className='menu-ch-claim'
        >
          {claiming ? 'Claiming' : 'Claim'}
        </button>
      ) : (
        <span className='menu-ch-count'>{state === 'done' ? 'Done' : `${Math.min(c.progress, c.goal)}/${c.goal}`}</span>
      )}
      <span className='menu-ch-line' aria-hidden='true'>
        <span style={{ width: `${pctOf(c)}%` }} />
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
  const closest = guest ? null : closestId(lists);
  const group = (period: 'daily' | 'weekly', rows: ChallengeView[]) => (
    <div key={period}>
      <div className='menu-ch-group'>
        <b>{period === 'daily' ? 'Daily' : 'Weekly'}</b>
        <span>Resets in {fmtCountdown(resetTime(period, lists, now) - now)}</span>
      </div>
      {rows.map((c) => (
        <StripRow key={c.id} c={c} guest={guest} closest={closest === c.id} claiming={claiming === c.id} onClaim={claim} />
      ))}
    </div>
  );
  return (
    <section aria-label='Challenges' className={`menu-panel ${guest ? 'menu-ch-guest' : ''}`}>
      <div className='menu-panel-head'>
        <h2 className='menu-panel-title'>Challenges</h2>
        {guest ? (
          <button type='button' onClick={onLogin} {...sfxProps('uiConfirm')} className='menu-chip-btn'>
            Log in to earn
          </button>
        ) : (
          <button type='button' onClick={onOpen} {...sfxProps('uiClick')} className='menu-panel-action'>
            View all
          </button>
        )}
      </div>
      {lists ? (
        <div className='pb-2'>
          {group('daily', lists.daily)}
          {group('weekly', lists.weekly)}
        </div>
      ) : (
        <div className='flex flex-col gap-3 px-[0.9rem] pb-3 pt-1' aria-busy='true' aria-label='Loading challenges'>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className='h-4 w-full' />
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

function RewardChips({ xp, credits }: { xp: number; credits: number }) {
  return (
    <span className='flex items-center gap-1.5'>
      <span className='menu-chip menu-chip-xp'>+{xp} XP</span>
      {credits > 0 && (
        <span className='menu-chip menu-chip-cr'>
          <span aria-hidden='true'>⛁</span> {credits}
        </span>
      )}
    </span>
  );
}

function ModalRow({
  c,
  guest,
  closest,
  claiming,
  onClaim,
}: {
  c: ChallengeView;
  guest: boolean;
  closest: boolean;
  claiming: boolean;
  onClaim: (id: string) => void;
}) {
  const state = guest ? 'locked' : challengeState(c);
  return (
    <div
      data-challenge={c.id}
      data-complete={c.complete ? '1' : '0'}
      data-claimed={c.claimed ? '1' : '0'}
      data-state={state}
      data-closest={closest ? '1' : '0'}
      className='menu-chm-row'
    >
      <span className='menu-chm-icon'>
        {state === 'locked' ? <LockGlyph size={18} /> : state === 'done' ? <CheckGlyph size={22} /> : <ChallengeIcon metric={c.metric} size={22} />}
      </span>
      <div className='min-w-0 flex-1'>
        <div className='menu-chm-title'>
          {c.title}
          {closest && <span className='menu-chm-tag'>Almost there</span>}
        </div>
        <div className='menu-chm-bar'>
          <span style={{ width: `${pctOf(c)}%` }} />
        </div>
      </div>
      <div className='menu-chm-side'>
        <RewardChips xp={c.rewardXp} credits={c.rewardCredits} />
        {state === 'claimable' ? (
          <button
            type='button'
            data-action='claim'
            disabled={claiming}
            onClick={() => onClaim(c.id)}
            {...sfxProps('uiConfirm')}
            className='menu-chm-claim'
          >
            {claiming ? 'Claiming' : 'Claim reward'}
          </button>
        ) : state === 'done' ? (
          <span className='menu-chm-done'>
            <CheckGlyph /> Done
          </span>
        ) : (
          <span className='menu-chm-count'>
            {Math.min(c.progress, c.goal)} / {c.goal}
          </span>
        )}
      </div>
    </div>
  );
}

function Summary({ lists, guest }: { lists: ChallengeLists; guest: boolean }) {
  const all = [...lists.daily, ...lists.weekly];
  const done = all.filter((c) => c.complete).length;
  const open = all.filter((c) => !c.complete);
  const xp = open.reduce((n, c) => n + c.rewardXp, 0);
  const cr = open.reduce((n, c) => n + c.rewardCredits, 0);
  return (
    <div className='menu-chm-sum'>
      <div className='min-w-0 flex-1'>
        <div className='font-sans text-[14px] text-white/70'>
          {guest ? 'Up for grabs with an account' : open.length ? 'Still up for grabs' : 'Everything done — new ones at the reset'}
        </div>
        {open.length > 0 && (
          <div className='mt-1.5 flex items-center gap-2'>
            <RewardChips xp={xp} credits={cr} />
          </div>
        )}
      </div>
      <div className='flex flex-col items-end gap-1.5'>
        <span className='font-display text-[22px] font-bold tabular-nums text-white'>
          {done}
          <span className='text-[15px] text-white/45'> / {all.length}</span>
        </span>
        <span className='font-sans text-[12px] text-white/50'>done</span>
      </div>
    </div>
  );
}

export function ChallengesModal({ guest, onClose, onLogin }: { guest: boolean; onClose: () => void; onLogin: () => void }) {
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

  const closest = guest ? null : closestId(data);
  const section = (period: 'daily' | 'weekly', rows: ChallengeView[]) => {
    const done = rows.filter((c) => c.complete).length;
    return (
      <section>
        <div className='mb-2.5 flex items-baseline justify-between gap-3'>
          <h3 className='font-sans text-[17px] font-semibold text-white/90'>
            {period === 'daily' ? 'Daily' : 'Weekly'}
            <span className='ml-2.5 font-sans text-[13px] font-medium normal-case tracking-normal text-white/50'>
              {done} of {rows.length} done
            </span>
          </h3>
          <span className='font-sans text-[13px] tabular-nums text-white/50'>
            Resets in {fmtCountdown(resetTime(period, data, now) - now)}
          </span>
        </div>
        <div className='flex flex-col gap-2'>
          {rows.map((c) => (
            <ModalRow key={c.id} c={c} guest={guest} closest={closest === c.id} claiming={claiming === c.id} onClaim={claim} />
          ))}
        </div>
      </section>
    );
  };

  return (
    <ModalShell
      title='Challenges'
      size='lg'
      width='w-[640px]'
      onClose={onClose}
      closeLabel='✕ ESC'
      scroll
      actions={
        guest ? (
          <button type='button' onClick={onLogin} {...sfxProps('uiConfirm')} className='menu-chip-btn normal-case tracking-normal'>
            Log in to earn
          </button>
        ) : undefined
      }
    >
      {state === 'loading' && (
        <div className='flex flex-col gap-2' aria-busy='true' aria-label='Loading challenges'>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className='h-[72px] w-full' />
          ))}
        </div>
      )}
      {state === 'error' && (
        <div className='font-sans text-sm text-white/55'>Couldn&apos;t load challenges. Try again in a moment.</div>
      )}
      {state === 'ready' && data && (
        <div className='flex flex-col gap-6'>
          <Summary lists={data} guest={guest} />
          {section('daily', data.daily)}
          {section('weekly', data.weekly)}
        </div>
      )}
    </ModalShell>
  );
}
