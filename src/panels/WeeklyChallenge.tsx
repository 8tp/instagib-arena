import { useEffect, useState } from 'react';
import type { Settings } from '../app-types';
import type { Account } from '../auth';
import { sfxProps } from '../deck-core';
import { DeckButton, ModalShell, Skeleton } from '../deck';
import {
  WEEKLY_CHALLENGE_BOTS,
  WEEKLY_CHALLENGE_DIFFICULTY,
  WEEKLY_CHALLENGE_FRAG_LIMIT,
  WEEKLY_CHALLENGE_MAP,
} from '../game/constants';
import { mapById } from '../game/map';
import { NameBadges } from '../ui/badges';
import { useLevelshot } from '../ui/levelshot';
import { Medal, PanelCard, PanelState, TableSkeleton } from './parts';
import { ReplayViewerOverlay } from './ReplayOverlay';
import { fmtChallengeTime, type WeeklyChallengeEntry, type WeeklyChallengeMe } from './shared';

// Weekly Challenge: a solo SPEEDRUN — an 8-player FFA (you + 7 bots) race to
// the frag cap on a fixed map. Beat the bots to the cap and your TIME tops the
// week; lose the race and your kills count instead. Every board-defining run is
// recorded, and anyone can rewatch it (▶). Anyone can play; only logged-in runs
// are recorded (consistent with career/ranked).

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <div className='deck-label'>{label}</div>
      <div className='mt-1 truncate font-display text-[14px] font-semibold uppercase tracking-[0.06em] text-white/90'>
        {value}
      </div>
    </div>
  );
}

export function WeeklyChallengeModal({
  account,
  settings,
  onPlay,
  onClose,
}: {
  account: Account;
  settings: Settings;
  onPlay: () => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<WeeklyChallengeEntry[]>([]);
  const [me, setMe] = useState<WeeklyChallengeMe | null>(null);
  const [info, setInfo] = useState<{ map: string; fragLimit: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // The board entry whose run we're rewatching (null = no viewer open).
  const [watch, setWatch] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let active = true;
    setFailed(false);
    fetch('/api/challenge/weekly/leaderboard', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: WeeklyChallengeEntry[]; me?: WeeklyChallengeMe | null; map?: string; fragLimit?: number } | null) => {
        if (!active) return;
        if (!d) {
          setFailed(true);
          setReady(true);
          return;
        }
        setEntries(d.entries ?? []);
        setMe(d.me ?? null);
        setInfo({ map: d.map ?? WEEKLY_CHALLENGE_MAP, fragLimit: d.fragLimit ?? WEEKLY_CHALLENGE_FRAG_LIMIT });
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [nonce]);

  const mapId = info?.map ?? WEEKLY_CHALLENGE_MAP;
  const mapName = mapById(mapId)?.name ?? mapId;
  const fragLimit = info?.fragLimit ?? WEEKLY_CHALLENGE_FRAG_LIMIT;
  // The levelshot is a small offscreen render — skip it on the low tier.
  const shot = useLevelshot(settings.lowSpec || settings.reducedEffects ? null : mapId, settings.lowSpec);

  return (
    <ModalShell title='Weekly Challenge' tone='amber' size='lg' onClose={onClose} bodyClassName='gap-4'>
      {/* Hero: this week's map + rules on the left, your best + the CTA on the right. */}
      <div
        className='pn-hero clip-deck-sm grid gap-5 p-4 sm:grid-cols-[1fr_13rem] sm:p-5'
        style={
          {
            ['--pn-hero-glow' as string]: 'rgba(251,191,36,0.16)',
            ['--pn-hero-edge' as string]: 'rgba(251,191,36,0.35)',
          } as React.CSSProperties
        }
      >
        {shot && (
          <div className='pn-hero-shot' aria-hidden='true'>
            <img src={shot} alt='' />
          </div>
        )}
        <div className='min-w-0'>
          <div className='font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300/80'>This week</div>
          <div className='mt-1 font-display text-3xl font-bold uppercase leading-none tracking-[0.02em] text-white'>
            {info ? mapName : <Skeleton className='h-8 w-44' />}
          </div>
          <p className='mt-2.5 max-w-md text-[12.5px] leading-relaxed text-white/60'>
            Race seven bots to the frag cap. Beat them and your <span className='text-amber-200'>clear time</span> tops
            the week; lose the race and your kills count. Its own board, so it never touches your K/D.
          </p>
          <div className='mt-4 grid grid-cols-3 gap-4 border-t border-white/[0.08] pt-3.5'>
            <Rule label='Format' value={`${WEEKLY_CHALLENGE_BOTS + 1}-player FFA`} />
            <Rule label='Frag cap' value={String(fragLimit)} />
            <Rule label='Bots' value={`${WEEKLY_CHALLENGE_BOTS} ${WEEKLY_CHALLENGE_DIFFICULTY}`} />
          </div>
        </div>

        <div className='flex flex-col justify-between gap-3 sm:border-l sm:border-white/[0.08] sm:pl-5'>
          <div>
            <div className='deck-label'>Your best</div>
            {!ready ? (
              <Skeleton className='mt-2 h-8 w-24' />
            ) : me ? (
              <>
                <div className='mt-1 font-display text-3xl font-bold tabular-nums leading-none text-amber-200'>
                  {me.won ? fmtChallengeTime(me.timeMs) : `${me.kills} kills`}
                </div>
                <div className='mt-1.5 text-[11px] text-white/50'>
                  Rank <span className='text-white/85'>#{me.rank}</span>
                  {me.won ? ' · cleared' : ' · not cleared yet'}
                </div>
              </>
            ) : (
              <div className='mt-1.5 text-[12px] leading-snug text-white/50'>
                {account ? 'No run yet this week.' : 'Log in to save your score.'}
              </div>
            )}
          </div>
          <DeckButton onClick={onPlay} solid accent='amber' center full>
            Play challenge
          </DeckButton>
        </div>
      </div>

      <PanelCard
        title='Leaderboard'
        aside={entries.length > 0 ? 'clear time, then kills' : undefined}
        bodyClassName='p-0'
      >
        <div aria-busy={!ready}>
          {!ready ? (
            <div className='p-3'>
              <TableSkeleton rows={6} />
            </div>
          ) : failed ? (
            <PanelState
              tone='error'
              title='Couldn’t load the board'
              hint='Check your connection and try again.'
              action={{ label: 'Retry', onClick: () => setNonce((n) => n + 1) }}
            />
          ) : entries.length === 0 ? (
            <PanelState title='No runs yet' hint='Clear the bots first and your time takes the top spot.' />
          ) : (
            <div className='deck-scroll max-h-[300px] overflow-y-auto'>
              <div className='pn-lb pn-lb-weekly'>
                {entries.map((e, i) => {
                  const you = e.id === me?.id;
                  return (
                    <div
                      key={e.id}
                      className={`deck-tr pn-lb-row pn-in ${you ? 'deck-tr-you text-cyan-50' : 'text-white/90'}`}
                      style={{ ['--i' as string]: Math.min(i, 14) }}
                    >
                      <span>
                        <Medal rank={i + 1} />
                      </span>
                      <span className='flex min-w-0 items-center gap-1.5'>
                        <span className='truncate'>{e.userName}</span>
                        <NameBadges admin={e.admin} verified={e.verified} size={12} />
                        {you && <span className='deck-chip shrink-0 border-cyan-400/40 text-cyan-300'>You</span>}
                      </span>
                      <span className='pn-mid'>
                        {e.hasReplay && (
                          <button
                            type='button'
                            onClick={() => setWatch({ id: e.id, name: e.userName })}
                            title={`Rewatch ${e.userName}'s run`}
                            aria-label={`Rewatch ${e.userName}'s run`}
                            {...sfxProps('uiConfirm')}
                            className='clip-deck-sm border border-cyan-400/30 px-1.5 py-0.5 text-[10px] text-cyan-300 transition hover:border-cyan-300/70 hover:bg-cyan-400/15 hover:text-cyan-100'
                          >
                            ▶
                          </button>
                        )}
                      </span>
                      <span className={`font-semibold ${e.won ? 'text-amber-200' : 'text-white/55'}`}>
                        {e.won ? fmtChallengeTime(e.timeMs) : `${e.kills} K`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PanelCard>

      {watch && (
        <ReplayViewerOverlay
          key={watch.id} // fresh canvas per replay (the viewer force-loses its context on dispose)
          playerId={watch.id}
          playerName={watch.name}
          settings={settings}
          onClose={() => setWatch(null)}
        />
      )}
    </ModalShell>
  );
}
