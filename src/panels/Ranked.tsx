import { useCallback, useEffect, useState } from 'react';
import type { Account } from '../auth';
import { sfxProps } from '../deck-core';
import { DeckButton, ModalShell, Skeleton } from '../deck';
import { RANKED_TIERS, rankedTier } from '../game/constants';
import type { RankedRoom, RankedStatus } from '../game/net';
import { NameBadges } from '../ui/badges';
import { Medal, PanelCard, PanelState, RankEmblem, TableSkeleton } from './parts';
import { RANKED_BASE, type RankedLeaderEntry, type RankedProfile } from './shared';

// Ranked Duel lobby modal: your rank card (emblem, Elo, progress to the next
// tier, form), the queue as the primary CTA, the ladder, and a side panel of
// live ranked duels to spectate. Login-gated (a guest sees a prompt).

// The next tier above a rating (null at the top) + 0–100 progress toward it.
function tierProgress(rating: number) {
  const cur = rankedTier(rating);
  const next = [...RANKED_TIERS].reverse().find((t) => t.min > rating) ?? null;
  const pct = next ? Math.max(0, Math.min(100, ((rating - cur.min) / (next.min - cur.min)) * 100)) : 100;
  return { cur, next, pct };
}

// Five pips showing the current streak (the server keeps the running streak,
// not a per-match history): + wins, − losses, greyed when there is no streak.
function FormPips({ streak }: { streak: number }) {
  const n = Math.min(5, Math.abs(streak));
  const kind = streak > 0 ? 'w' : streak < 0 ? 'l' : 'n';
  return (
    <div
      className='flex items-center gap-1'
      role='img'
      aria-label={streak === 0 ? 'No current streak' : `${Math.abs(streak)} ${streak > 0 ? 'win' : 'loss'} streak`}
    >
      {Array.from({ length: 5 }, (_, i) => {
        const on = i < n;
        return (
          <span key={i} className={`pn-pip ${on ? (kind === 'w' ? 'pn-pip-w' : 'pn-pip-l') : 'pn-pip-n'}`}>
            {on ? (kind === 'w' ? 'W' : 'L') : ''}
          </span>
        );
      })}
    </div>
  );
}

function Mini({ label, value, mono = false }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className='min-w-0'>
      <div className='deck-label'>{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums leading-none text-white ${mono ? 'font-mono' : 'font-display'}`}>{value}</div>
    </div>
  );
}

export function RankedModal({
  account,
  status,
  rooms,
  onQueue,
  onCancel,
  onRequestRooms,
  onSpectate,
  onOpenLogin,
  onClose,
}: {
  account: Account;
  status: RankedStatus | null;
  rooms: RankedRoom[];
  onQueue: () => void;
  onCancel: () => void;
  onRequestRooms: () => void;
  onSpectate: (roomId: string, mapId: string) => void;
  onOpenLogin: () => void;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [ladder, setLadder] = useState<RankedLeaderEntry[]>([]);
  // Both fetches answered (ok or not) → the skeletons give way to real data /
  // the empty state, never a flash of "1000 · Unranked" before the answer.
  const [loaded, setLoaded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const searching = status?.state === 'searching';

  const refreshProfile = useCallback(() => {
    if (!account) return;
    const me = fetch('/api/ranked/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: RankedProfile } | null) => setProfile(d?.profile ?? null))
      .catch(() => {});
    const board = fetch('/api/ranked/leaderboard', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: RankedLeaderEntry[] } | null) => setLadder(d?.entries ?? []))
      .catch(() => {});
    void Promise.all([me, board]).then(() => setLoaded(true));
  }, [account]);

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  // Poll live ranked duels for the spectate panel while the modal is open.
  useEffect(() => {
    onRequestRooms();
    const t = setInterval(onRequestRooms, 3000);
    return () => clearInterval(t);
  }, [onRequestRooms]);

  // Tick the "searching… Ns" label.
  useEffect(() => {
    if (!searching) {
      setElapsed(0);
      return;
    }
    const since = status?.since ?? Date.now();
    const t = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000))), 500);
    return () => clearInterval(t);
  }, [searching, status?.since]);

  const rating = profile?.rating ?? RANKED_BASE;
  const { cur: tier, next, pct } = tierProgress(rating);
  const loading = !!account && !loaded;
  const games = profile?.games ?? 0;
  const winRate = games > 0 ? Math.round(((profile?.wins ?? 0) / games) * 100) : 0;

  return (
    <ModalShell title='Ranked Duel' tone='emerald' size={account ? 'xl' : 'md'} onClose={onClose} bodyClassName='gap-4'>
      {!account ? (
        <div className='flex flex-col items-center gap-4 py-4 text-center'>
          <RankEmblem color={RANKED_TIERS[RANKED_TIERS.length - 3].color} letter='?' size={72} />
          <p className='max-w-xs font-sans text-[13px] leading-relaxed text-white/60'>
            Ranked Duel is 1v1 on the Elo ladder. Your rating follows your account, so log in to play.
          </p>
          <DeckButton onClick={onOpenLogin} solid accent='emerald' center>
            Log in to play ranked
          </DeckButton>
        </div>
      ) : (
        <div className='flex flex-col gap-4' aria-busy={loading}>
          {/* Rank hero: emblem + Elo + tier progress + the queue CTA. */}
          <div
            className='pn-hero clip-deck-sm grid gap-5 p-4 sm:grid-cols-[1fr_15rem] sm:items-center sm:p-5'
            style={
              {
                ['--pn-hero-glow' as string]: `${tier.color}26`,
                ['--pn-hero-edge' as string]: `${tier.color}55`,
                ['--pn-tier' as string]: tier.color,
              } as React.CSSProperties
            }
          >
            <div className='flex min-w-0 items-center gap-4'>
              {loading ? (
                <Skeleton className='h-[84px] w-[84px] shrink-0' />
              ) : (
                <RankEmblem color={tier.color} letter={tier.name[0]} />
              )}
              <div className='min-w-0 flex-1'>
                {loading ? (
                  <>
                    <Skeleton className='h-9 w-28' />
                    <Skeleton className='mt-3 h-2 w-full' />
                    <Skeleton className='mt-3 h-3 w-40' />
                  </>
                ) : (
                  <>
                    <div className='flex flex-wrap items-baseline gap-x-3 gap-y-0.5'>
                      <span className='font-display text-4xl font-bold leading-none tabular-nums' style={{ color: tier.color }}>
                        {rating}
                      </span>
                      <span className='font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-white/80'>
                        {tier.name}
                      </span>
                      {profile?.provisional && <span className='deck-chip border-amber-400/40 text-amber-300'>Provisional</span>}
                    </div>
                    <div className='pn-tierbar mt-3' role='progressbar' aria-label='Progress to next tier' aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <div className='mt-1.5 text-[11px] tabular-nums text-white/50'>
                      {next ? (
                        <>
                          {next.min - rating} to <span style={{ color: next.color }}>{next.name}</span>
                        </>
                      ) : (
                        'Top tier reached'
                      )}
                      {profile && profile.rank > 0 ? (
                        <>
                          {' · '}Ladder <span className='text-cyan-200'>#{profile.rank}</span>
                        </>
                      ) : (
                        <span className='text-white/35'> · Unranked</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className='flex flex-col gap-2.5'>
              {searching ? (
                <DeckButton onClick={onCancel} accent='rose' full center size='lg' sound='uiBack'>
                  Searching… {elapsed}s
                </DeckButton>
              ) : (
                <DeckButton onClick={onQueue} solid accent='emerald' full center size='lg' className='whitespace-nowrap'>
                  Find match
                </DeckButton>
              )}
              <div className='min-h-[1rem] text-center text-[11px] text-white/45'>
                {searching ? (
                  <>
                    In queue{status?.size ? ` · ${status.size} searching` : ''}. Click to cancel.
                  </>
                ) : status?.reason === 'account' ? (
                  <span className='text-rose-300'>Ranked needs an account.</span>
                ) : status?.reason === 'in-match' ? (
                  <span className='text-rose-300'>You&apos;re already in a ranked match in another tab.</span>
                ) : (
                  'First to 15 frags. 1v1.'
                )}
              </div>
            </div>

            {/* Career line: record, win rate, peak, form. */}
            {!loading && (
              <div className='flex flex-wrap items-end gap-x-7 gap-y-3 border-t border-white/[0.08] pt-4 sm:col-span-2'>
                <Mini label='Record' value={`${profile?.wins ?? 0}W · ${profile?.losses ?? 0}L`} mono />
                <Mini label='Win rate' value={games > 0 ? `${winRate}%` : '—'} />
                <Mini label='Peak' value={profile?.peak ?? RANKED_BASE} />
                <div className='ml-auto'>
                  <div className='deck-label mb-1.5'>Form</div>
                  <FormPips streak={profile?.streak ?? 0} />
                </div>
              </div>
            )}
          </div>

          <div className='grid gap-4 md:grid-cols-[1.2fr_1fr]'>
            <PanelCard title='Ladder' aside={ladder.length > 0 ? `Top ${ladder.length}` : undefined} bodyClassName='p-0'>
              {loading ? (
                <div className='p-3'>
                  <TableSkeleton rows={6} />
                </div>
              ) : ladder.length === 0 ? (
                <PanelState title='No ranked players yet' hint='Play the first ranked match to claim the top of the ladder.' />
              ) : (
                <div className='deck-scroll max-h-[264px] overflow-y-auto'>
                  <table className='w-full text-left text-[12px]'>
                    <tbody>
                      {ladder.map((e, i) => {
                        const t = rankedTier(e.rating);
                        const me = profile?.id === e.id;
                        return (
                          <tr key={e.id} className={`deck-tr ${me ? 'deck-tr-you' : ''}`}>
                            <td className='w-11 py-1.5 pl-3 pr-2'>
                              <Medal rank={i + 1} />
                            </td>
                            <td className='py-1.5 pr-2 text-white/90'>
                              <span className='flex min-w-0 items-center gap-1.5'>
                                <span className='truncate'>{e.userName}</span>
                                <NameBadges admin={e.admin} verified={e.verified} size={12} />
                              </span>
                            </td>
                            <td className='py-1.5 pr-2 text-right font-bold tabular-nums' style={{ color: t.color }}>
                              {e.rating}
                            </td>
                            <td className='py-1.5 pr-3 text-right tabular-nums text-white/40'>
                              {e.wins}-{e.losses}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </PanelCard>

            {/* Live ranked duels to spectate */}
            <PanelCard
              title='Live duels'
              aside={
                rooms.length > 0 ? (
                  <span className='flex items-center gap-1.5'>
                    <span className='pn-live-dot' aria-hidden='true' />
                    {rooms.length} live
                  </span>
                ) : undefined
              }
              bodyClassName='p-3'
            >
              {rooms.length === 0 ? (
                <PanelState title='No live duels' hint='When a ranked match starts, you can watch it from here.' />
              ) : (
                <div className='flex flex-col gap-2'>
                  {rooms.map((r) => (
                    <button
                      key={r.id}
                      type='button'
                      onClick={() => onSpectate(r.id, r.mapId)}
                      {...sfxProps('uiConfirm')}
                      aria-label={`Spectate ${r.players.map((p) => p.name).join(' versus ') || 'ranked duel'}`}
                      className='clip-deck-sm flex items-center justify-between gap-3 border border-white/12 bg-black/40 px-3 py-2.5 text-left transition hover:border-cyan-400/50 hover:bg-cyan-400/5'
                    >
                      <span className='min-w-0 flex-1 truncate text-[12px] text-white/85'>
                        {r.players.map((p) => p.name).join('  vs  ') || 'Ranked duel'}
                      </span>
                      <span className='shrink-0 font-display text-[14px] font-bold tabular-nums text-cyan-200'>
                        {r.players.map((p) => p.frags).join(' – ')}
                      </span>
                      {r.spectators > 0 && (
                        <span className='shrink-0 font-mono text-[10px] text-white/35'>{r.spectators} watching</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </PanelCard>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
