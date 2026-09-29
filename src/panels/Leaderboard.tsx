import { useEffect, useState } from 'react';
import { ModalShell } from '../deck';
import { rankedTier } from '../game/constants';
import { NameBadges } from '../ui/badges';
import { Medal, PanelState, Segmented, TableSkeleton } from './parts';
import type { RankedLeaderEntry, RankedProfile } from './shared';

/* ───────────────────────── Global leaderboard modal ───────────────────────── */

type LeaderboardSort = 'kills' | 'wins' | 'accuracy';

type LeaderboardEntry = {
  id: string;
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number;
  admin?: boolean;
  verified?: boolean;
};

type LeaderboardYou = { rank: number; entry: LeaderboardEntry } | null;

const LEADERBOARD_SORTS: ReadonlyArray<{ id: LeaderboardSort; label: string }> = [
  { id: 'kills', label: 'Kills' },
  { id: 'wins', label: 'Wins' },
  { id: 'accuracy', label: 'Accuracy' },
];

type LeaderboardWindow = 'all' | 'weekly' | 'daily' | 'ranked';
const LEADERBOARD_WINDOWS: ReadonlyArray<{ id: LeaderboardWindow; label: string }> = [
  { id: 'all', label: 'All-time' },
  { id: 'weekly', label: 'This week' },
  { id: 'daily', label: 'Today' },
  { id: 'ranked', label: 'Ranked' },
];

// A generic "row" the podium + table both render, so the two boards share code.
type Row = {
  id: string;
  key: string;
  name: string;
  admin?: boolean;
  verified?: boolean;
  rank: number;
  you: boolean;
  main: string; // podium headline figure
  mainLabel: string;
  sub: string; // podium sub line
  color?: string; // tier colour (ranked)
};

function LbName({ name, admin, verified, you }: { name: string; admin?: boolean; verified?: boolean; you: boolean }) {
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span className='truncate'>{name}</span>
      <NameBadges admin={admin} verified={verified} size={12} />
      {you && <span className='deck-chip shrink-0 border-cyan-400/40 text-cyan-300'>You</span>}
    </span>
  );
}

function Podium({ rows }: { rows: Row[] }) {
  // Visual order 2 · 1 · 3 so the winner sits centre and tallest.
  const order = [rows[1], rows[0], rows[2]].filter((r): r is Row => !!r);
  return (
    <ol
      className='pn-podium mx-auto w-full max-w-[30rem]'
      aria-label='Top three'
      style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}
    >
      {order.map((r) => (
        <li
          key={r.key}
          className='pn-podium-slot pn-in'
          data-place={r.rank}
          data-you={r.you}
          style={{ ['--i' as string]: r.rank === 1 ? 0 : r.rank }}
        >
          <Medal rank={r.rank} />
          <div className='mt-2 flex min-w-0 items-center justify-center gap-1 text-[13px] font-semibold text-white'>
            <span className='truncate'>{r.name}</span>
            <NameBadges admin={r.admin} verified={r.verified} size={12} />
          </div>
          <div className='pn-podium-stat mt-2' style={r.color && r.rank !== 1 ? { color: r.color } : undefined}>
            {r.main}
          </div>
          <div className='mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-white/40'>{r.mainLabel}</div>
          <div className='mt-1.5 truncate text-[10px] text-white/45'>{r.sub}</div>
        </li>
      ))}
    </ol>
  );
}

function BoardRow({
  row,
  cells,
  sticky = false,
  index = 0,
}: {
  row: Row;
  cells: React.ReactNode;
  sticky?: boolean;
  index?: number;
}) {
  return (
    <div
      className={`deck-tr pn-lb-row pn-in ${row.you ? 'deck-tr-you text-cyan-50' : 'text-white/90'} ${
        sticky ? 'pn-you-sticky' : ''
      }`}
      style={{ ['--i' as string]: Math.min(index, 14) }}
    >
      <span>
        <Medal rank={row.rank} />
      </span>
      <LbName name={row.name} admin={row.admin} verified={row.verified} you={row.you} />
      {cells}
    </div>
  );
}

export function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const [sort, setSort] = useState<LeaderboardSort>('kills');
  const [window, setWindow] = useState<LeaderboardWindow>('all');
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [you, setYou] = useState<LeaderboardYou>(null);
  const [rankedRows, setRankedRows] = useState<RankedLeaderEntry[]>([]);
  const [rankedMe, setRankedMe] = useState<RankedProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [nonce, setNonce] = useState(0); // bump to retry
  const isRanked = window === 'ranked';

  useEffect(() => {
    let active = true;
    setState('loading');
    if (window === 'ranked') {
      fetch('/api/ranked/leaderboard', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ranked unavailable'))))
        .then((d: { entries?: RankedLeaderEntry[]; me?: RankedProfile | null }) => {
          if (!active) return;
          setRankedRows(Array.isArray(d.entries) ? d.entries : []);
          setRankedMe(d.me ?? null);
          setState('ready');
        })
        .catch(() => {
          if (active) setState('error');
        });
      return () => {
        active = false;
      };
    }
    fetch(`/api/leaderboard?sort=${sort}&window=${window}&limit=25`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('leaderboard unavailable'))))
      .then((d: { leaderboard?: LeaderboardEntry[]; you?: LeaderboardYou }) => {
        if (!active) return;
        setRows(Array.isArray(d.leaderboard) ? d.leaderboard : []);
        setYou(d.you ?? null);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [sort, window, nonce]);

  const youId = you?.entry.id;

  // Normalise whichever board is showing into shared Rows for the podium.
  const podiumRows: Row[] = isRanked
    ? rankedRows.slice(0, 3).map((e, i) => {
        const t = rankedTier(e.rating);
        return {
          id: e.id,
          key: e.id,
          name: e.userName,
          admin: e.admin,
          verified: e.verified,
          rank: i + 1,
          you: e.id === rankedMe?.id,
          main: String(e.rating),
          mainLabel: t.name,
          sub: `${e.wins}W · ${e.losses}L`,
          color: t.color,
        };
      })
    : rows.slice(0, 3).map((e, i) => ({
        id: e.id,
        key: e.id || `${e.userName}-${i}`,
        name: e.userName,
        admin: e.admin,
        verified: e.verified,
        rank: i + 1,
        you: e.id === youId,
        main: sort === 'kills' ? String(e.totalKills) : sort === 'wins' ? String(e.totalWins) : `${e.bestAccuracy.toFixed(1)}%`,
        mainLabel: sort === 'kills' ? 'kills' : sort === 'wins' ? 'wins' : 'accuracy',
        sub: `${e.kd.toFixed(2)} K/D · ${e.totalGames} games`,
      }));

  const rankedEntryOf = (e: RankedLeaderEntry, i: number): Row => ({
    id: e.id,
    key: e.id,
    name: e.userName,
    admin: e.admin,
    verified: e.verified,
    rank: i + 1,
    you: e.id === rankedMe?.id,
    main: '',
    mainLabel: '',
    sub: '',
  });
  const rankedCells = (e: RankedLeaderEntry) => {
    const t = rankedTier(e.rating);
    return (
      <>
        <span className='font-bold' style={{ color: t.color }}>
          {e.rating}
        </span>
        <span className='pn-tier pn-hide-sm text-[10px] uppercase tracking-[0.1em]' style={{ color: t.color }}>
          {t.name}
        </span>
        <span className='text-white/55'>
          {e.wins}-{e.losses}
        </span>
      </>
    );
  };
  const globalCells = (e: LeaderboardEntry) => (
    <>
      <span className='font-semibold'>{e.totalKills}</span>
      <span className='pn-hide-sm text-white/60'>{e.kd.toFixed(2)}</span>
      <span className='pn-hide-sm text-white/60'>{e.totalWins}</span>
      <span className='text-cyan-200/85'>{e.bestAccuracy.toFixed(1)}%</span>
    </>
  );

  const rankedMeEntry: RankedLeaderEntry | null =
    rankedMe && rankedMe.rank > 0
      ? {
          id: rankedMe.id,
          userName: rankedMe.userName,
          rating: rankedMe.rating,
          games: rankedMe.games,
          wins: rankedMe.wins,
          losses: rankedMe.losses,
          streak: rankedMe.streak,
          admin: false,
          verified: false,
        }
      : null;

  const empty =
    state === 'ready' && (isRanked ? rankedRows.length === 0 : rows.length === 0);

  return (
    <ModalShell title='Leaderboard' size='lg' onClose={onClose} bodyClassName='gap-3.5'>
      <div className='flex flex-col gap-2.5'>
        <Segmented label='Time window' value={window} options={LEADERBOARD_WINDOWS} onChange={setWindow} className='w-full' />
        {!isRanked && (
          <div className='flex items-center gap-3'>
            <span className='deck-label'>Sort by</span>
            <Segmented label='Sort by' value={sort} options={LEADERBOARD_SORTS} onChange={setSort} size='sm' />
          </div>
        )}
      </div>

      {state === 'loading' && (
        <div aria-busy='true' aria-label='Loading leaderboard'>
          <TableSkeleton rows={6} podium />
        </div>
      )}
      {state === 'error' && (
        <PanelState
          tone='error'
          title={isRanked ? 'Couldn’t load the ranked ladder' : 'Couldn’t load the leaderboard'}
          hint='Check your connection and try again.'
          action={{ label: 'Retry', onClick: () => setNonce((n) => n + 1) }}
        />
      )}
      {empty && (
        <PanelState
          title={isRanked ? 'No ranked players yet' : 'Nobody on the board yet'}
          hint={
            isRanked
              ? 'Queue a Ranked Duel to put the first rating on the ladder.'
              : window === 'all'
                ? 'Finish a match while logged in to appear here.'
                : 'Play a match while logged in to take the first spot.'
          }
        />
      )}

      {state === 'ready' && !empty && (
        <div key={`${window}-${sort}`} className='flex flex-col gap-3'>
          <Podium rows={podiumRows} />

          <div className='deck-scroll max-h-[38vh] overflow-y-auto'>
            {isRanked ? (
              <div className='pn-lb pn-lb-ranked'>
                <div className='pn-lb-row pn-lb-head'>
                  <span>#</span>
                  <span className='!text-left'>Player</span>
                  <span>Rating</span>
                  <span className='pn-tier pn-hide-sm'>Tier</span>
                  <span>W-L</span>
                </div>
                {rankedRows.slice(3).map((e, i) => (
                  <BoardRow key={e.id} row={rankedEntryOf(e, i + 3)} cells={rankedCells(e)} index={i} />
                ))}
                {rankedMeEntry && (
                  <BoardRow
                    row={{ ...rankedEntryOf(rankedMeEntry, rankedMe!.rank - 1), you: true }}
                    cells={rankedCells(rankedMeEntry)}
                    sticky
                  />
                )}
              </div>
            ) : (
              <div className='pn-lb'>
                <div className='pn-lb-row pn-lb-head'>
                  <span>#</span>
                  <span className='!text-left'>Player</span>
                  <span>K</span>
                  <span className='pn-hide-sm'>K/D</span>
                  <span className='pn-hide-sm'>W</span>
                  <span>Acc</span>
                </div>
                {rows.slice(3).map((e, i) => (
                  <BoardRow
                    key={e.id || `${e.userName}-${i + 3}`}
                    row={{
                      id: e.id,
                      key: e.id,
                      name: e.userName,
                      admin: e.admin,
                      verified: e.verified,
                      rank: i + 4,
                      you: e.id === youId,
                      main: '',
                      mainLabel: '',
                      sub: '',
                    }}
                    cells={globalCells(e)}
                    index={i}
                  />
                ))}
                {/* Your standing stays pinned to the bottom of the list. */}
                {you && you.rank > 0 && (
                  <BoardRow
                    row={{
                      id: you.entry.id,
                      key: you.entry.id,
                      name: you.entry.userName,
                      admin: you.entry.admin,
                      verified: you.entry.verified,
                      rank: you.rank,
                      you: true,
                      main: '',
                      mainLabel: '',
                      sub: '',
                    }}
                    cells={globalCells(you.entry)}
                    sticky
                  />
                )}
              </div>
            )}
          </div>

          {!isRanked && sort === 'accuracy' && (
            <p className='text-[11px] text-white/40'>Accuracy board needs at least 5 games played.</p>
          )}
          {!isRanked && you && you.rank === 0 && sort === 'accuracy' && (
            <p className='text-[11px] text-amber-200/75'>
              Play {5 - you.entry.totalGames} more game{5 - you.entry.totalGames === 1 ? '' : 's'} to rank on accuracy.
            </p>
          )}
        </div>
      )}
    </ModalShell>
  );
}
