// Table tabs of the admin console: recent Matches, the Players directory and
// Feedback moderation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LevelBadge } from '../ui/item-tile';
import { getJSON, postJSON, useLoad, type MatchRow, type PlayerRow } from './api';
import { Select } from './combobox';
import { ago, fmt, shortDate } from './format';
import { MODE_LABEL } from './palette';
import { Avatar, Banner, Empty, ErrorState, Loading, Plate, PlayerFlags } from './ui';

// ── Matches ─────────────────────────────────────────────────────────────────
export function MatchesTab() {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('all');
  const [result, setResult] = useState<'all' | 'win' | 'loss'>('all');
  const load = useCallback(async (before?: number) => {
    setLoading(true);
    const r = await getJSON<{ matches: MatchRow[] }>(`/api/admin/metrics/matches?limit=100${before ? `&before=${before}` : ''}`);
    setLoading(false);
    if (!r.ok) return setError(r.message);
    setError('');
    setMatches((prev) => (before ? [...prev, ...r.data.matches] : r.data.matches));
    setDone(r.data.matches.length < 100);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const keyOf = (m: MatchRow) => (m.offline ? 'practice' : m.mode ?? 'unknown');
  const modes = useMemo(() => [...new Set(matches.map(keyOf))], [matches]);
  const shown = matches.filter((m) => (mode === 'all' || keyOf(m) === mode) && (result === 'all' || (result === 'win') === m.won));
  return (
    <Plate
      title='Recent matches'
      sub={`${fmt(matches.length)} loaded · one row per player per match`}
      flush
      right={
        <>
          <div className='flex flex-wrap gap-1' role='group' aria-label='Filter by mode'>
            {['all', ...modes].map((m) => (
              <button key={m} type='button' className='adm-chip' aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === 'all' ? 'All modes' : MODE_LABEL[m] ?? m}
              </button>
            ))}
          </div>
          <Select
            label='Result'
            value={result}
            onChange={setResult}
            className='w-32'
            options={[
              { value: 'all', label: 'Any result' },
              { value: 'win', label: 'Wins' },
              { value: 'loss', label: 'Losses' },
            ]}
          />
        </>
      }
    >
      {error && matches.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : matches.length === 0 && loading ? (
        <div className='px-4 pb-4'>
          <Loading rows={6} />
        </div>
      ) : shown.length === 0 ? (
        <Empty title={matches.length ? 'No matches match these filters.' : 'No recorded matches yet.'} />
      ) : (
        <div className='adm-scroll max-h-[calc(100vh-260px)]'>
          <table className='adm-table'>
            <thead>
              <tr>
                <th>When</th>
                <th>Player</th>
                <th>Mode</th>
                <th>Result</th>
                <th className='num'>Kills</th>
                <th className='num'>Deaths</th>
                <th className='num'>HS</th>
                <th className='num'>Acc</th>
                <th className='num'>XP</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td className='whitespace-nowrap' title={new Date(m.ts).toLocaleString()}>
                    {ago(m.ts)}
                  </td>
                  <td className='strong'>
                    {m.playerName}
                    {!m.playerId && <span className='ml-1.5 text-[11px] text-[var(--adm-ink-3)]'>guest</span>}
                  </td>
                  <td>{MODE_LABEL[keyOf(m)] ?? keyOf(m)}</td>
                  <td>{m.won ? <span className='font-semibold text-[var(--adm-good)]'>Win</span> : <span className='text-[var(--adm-ink-3)]'>Loss</span>}</td>
                  <td className='num text-[var(--adm-ink)]'>{m.kills}</td>
                  <td className='num'>{m.deaths}</td>
                  <td className='num'>{m.headshots}</td>
                  <td className='num'>{m.accuracy}%</td>
                  <td className='num'>+{fmt(m.xp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!done && matches.length > 0 && (
        <div className='flex justify-center border-t border-[var(--adm-line)] py-3'>
          <button type='button' className='adm-btn' onClick={() => void load(matches[matches.length - 1]?.id)} disabled={loading}>
            {loading ? 'Loading…' : 'Load 100 more'}
          </button>
        </div>
      )}
    </Plate>
  );
}

// ── Players ─────────────────────────────────────────────────────────────────
type Sort = 'recent' | 'kills' | 'games' | 'level' | 'accuracy' | 'xp';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Last seen' },
  { value: 'level', label: 'Level' },
  { value: 'games', label: 'Games played' },
  { value: 'kills', label: 'Kills' },
  { value: 'accuracy', label: 'Best accuracy' },
  { value: 'xp', label: 'Total XP' },
];

export function PlayersTab({ onOpen }: { onOpen: (tab: 'items' | 'gifts', player: string) => void }) {
  const [sort, setSort] = useState<Sort>('recent');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 220);
    return () => clearTimeout(t);
  }, [q]);
  const players = useLoad(`/api/admin/metrics/players?sort=${sort}&limit=300&q=${encodeURIComponent(dq)}`, (r) => (r as { players: PlayerRow[] }).players);
  return (
    <Plate
      title='Players'
      sub={players.state === 'ok' ? `${fmt(players.data.length)} shown · players with at least one game` : undefined}
      flush
      right={
        <>
          <input className='adm-input w-56' style={{ height: 30 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search by name…' aria-label='Search players' />
          <Select label='Sort by' value={sort} onChange={setSort} options={SORTS} className='w-40' />
        </>
      }
    >
      {players.state === 'loading' ? (
        <div className='px-4 pb-4'>
          <Loading rows={6} />
        </div>
      ) : players.state === 'error' ? (
        <ErrorState message={players.message} onRetry={players.retry} />
      ) : players.data.length === 0 ? (
        <Empty title={dq ? `No player matches “${dq}”.` : 'No players yet.'} />
      ) : (
        <div className='adm-scroll max-h-[calc(100vh-240px)]'>
          <table className='adm-table'>
            <thead>
              <tr>
                <th>Player</th>
                <th>Level</th>
                <th className='num'>Games</th>
                <th className='num'>Kills</th>
                <th className='num'>K/D</th>
                <th className='num'>Best acc</th>
                <th className='num'>Credits</th>
                <th>Joined</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {players.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className='flex items-center gap-2.5'>
                      <Avatar name={p.userName} />
                      <span className='strong'>{p.userName}</span>
                      <PlayerFlags admin={p.admin} verified={p.verified} />
                    </span>
                  </td>
                  <td>
                    <LevelBadge level={p.level} />
                  </td>
                  <td className='num'>{fmt(p.totalGames)}</td>
                  <td className='num'>{fmt(p.totalKills)}</td>
                  <td className='num'>{p.kd.toFixed(2)}</td>
                  <td className='num'>{Math.round(p.bestAccuracy)}%</td>
                  <td className='num text-[var(--adm-credit)]'>⛁ {fmt(p.credits)}</td>
                  <td className='whitespace-nowrap'>{shortDate(p.createdAt)}</td>
                  <td className='whitespace-nowrap'>{ago(p.lastSeen)}</td>
                  <td className='text-right'>
                    <span className='flex justify-end gap-1.5'>
                      <button type='button' className='adm-btn sm' onClick={() => onOpen('items', p.id)} data-action='player-items'>
                        Items
                      </button>
                      <button type='button' className='adm-btn sm' onClick={() => onOpen('gifts', p.id)} data-action='player-gift'>
                        Gift
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Plate>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────
type FeedbackRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  type: 'bug' | 'feature' | 'general';
  title: string;
  body: string;
  status: 'open' | 'ack' | 'resolved' | 'spam';
  ip: string;
  userAgent: string;
  updatedAt: number;
};
const FB_STATUSES = ['open', 'ack', 'resolved', 'spam'] as const;
const FB_STATUS_LABEL: Record<string, string> = { open: 'Open', ack: 'Acknowledged', resolved: 'Resolved', spam: 'Spam' };
const FB_STATUS_COLOR: Record<string, string> = { open: 'var(--adm-warn)', ack: 'var(--adm-rail)', resolved: 'var(--adm-good)', spam: 'var(--adm-ink-3)' };
const FB_TYPES = ['bug', 'feature', 'general'] as const;
const FB_TYPE_LABEL: Record<string, string> = { bug: 'Bug', feature: 'Feature', general: 'General' };
const FB_TYPE_COLOR: Record<string, string> = { bug: 'var(--adm-bad)', feature: 'var(--adm-rail)', general: 'var(--adm-ink-2)' };

function FeedbackCard({ f, onStatus }: { f: FeedbackRow; onStatus: (id: number, status: FeedbackRow['status']) => void }) {
  return (
    <article className='flex flex-col gap-2 border border-[var(--adm-line)] bg-[var(--adm-plate)] p-4' style={{ borderLeft: `2px solid ${FB_STATUS_COLOR[f.status]}` }} data-feedback={f.id}>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <span className='text-[11px] font-semibold uppercase tracking-[0.12em]' style={{ color: FB_TYPE_COLOR[f.type] }}>
              {FB_TYPE_LABEL[f.type] ?? f.type}
            </span>
            <span className='text-[11px] text-[var(--adm-ink-3)]'>#{f.id}</span>
          </div>
          <h3 className='text-[15px] font-semibold text-[var(--adm-ink)]'>{f.title}</h3>
        </div>
        <Select
          label={`Status of #${f.id}`}
          value={f.status}
          onChange={(v) => onStatus(f.id, v)}
          className='w-44'
          options={FB_STATUSES.map((s) => ({ value: s, label: FB_STATUS_LABEL[s], swatch: FB_STATUS_COLOR[s] }))}
        />
      </div>
      <p className='whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--adm-ink-2)]'>{f.body}</p>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--adm-ink-3)]'>
        <span className='text-[var(--adm-ink-2)]'>
          {f.playerName}
          {f.playerId ? '' : ' · guest'}
        </span>
        <span title={new Date(f.ts).toLocaleString()}>{ago(f.ts)}</span>
        {f.ip && <span className='font-mono'>{f.ip}</span>}
        {f.userAgent && (
          <span className='max-w-[320px] truncate' title={f.userAgent}>
            {f.userAgent}
          </span>
        )}
      </div>
    </article>
  );
}

export function FeedbackTab({ onCounts }: { onCounts?: (open: number) => void }) {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>('open');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (status: string, type: string, before?: number) => {
      setLoading(true);
      const qs = `limit=50${status !== 'all' ? `&status=${status}` : ''}${type !== 'all' ? `&type=${type}` : ''}${before ? `&before=${before}` : ''}`;
      const r = await getJSON<{ feedback: FeedbackRow[]; counts: Record<string, number>; typeCounts: Record<string, number> }>(`/api/admin/metrics/feedback?${qs}`);
      setLoading(false);
      if (!r.ok) return setError(r.message);
      const list = r.data.feedback;
      setRows((prev) => (before ? [...prev, ...list] : list));
      setCounts(r.data.counts);
      setTypeCounts(r.data.typeCounts);
      onCounts?.(r.data.counts.open ?? 0);
      setDone(list.length < 50);
    },
    [onCounts],
  );

  useEffect(() => {
    void load(filter, typeFilter);
  }, [filter, typeFilter, load]);

  const updateStatus = useCallback(
    async (id: number, status: FeedbackRow['status']) => {
      const ok = await postJSON<{ ok: boolean }>(`/api/admin/feedback/${id}/status`, { status });
      if (!ok) {
        setError('Status update failed — moderation needs a signed-in admin session.');
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)).filter((r) => filter === 'all' || r.status === filter));
      const d = await getJSON<{ counts: Record<string, number> }>(`/api/admin/metrics/feedback?limit=1`);
      if (d.ok) {
        setCounts(d.data.counts);
        onCounts?.(d.data.counts.open ?? 0);
      }
    },
    [filter, onCounts],
  );

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div className='grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]'>
      <aside className='flex flex-col gap-4 lg:sticky lg:top-[120px] lg:self-start'>
        <div className='flex flex-col gap-1.5'>
          <span className='adm-section-label'>Status</span>
          {(['all', ...FB_STATUSES] as const).map((s) => (
            <button key={s} type='button' className='adm-chip justify-between' style={{ height: 32 }} aria-pressed={filter === s} onClick={() => setFilter(s)}>
              <span className='flex items-center gap-2'>
                {s !== 'all' && <span className='inline-block h-2 w-2' style={{ background: FB_STATUS_COLOR[s] }} />}
                {s === 'all' ? 'All' : FB_STATUS_LABEL[s]}
              </span>
              <span className='n'>{s === 'all' ? total : counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className='flex flex-col gap-1.5'>
          <span className='adm-section-label'>Type</span>
          {(['all', ...FB_TYPES] as const).map((t) => (
            <button key={t} type='button' className='adm-chip justify-between' style={{ height: 32 }} aria-pressed={typeFilter === t} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? 'All types' : FB_TYPE_LABEL[t]}
              <span className='n'>{t === 'all' ? total : typeCounts[t] ?? 0}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className='flex min-w-0 flex-col gap-3'>
        {error && <Banner msg={{ tone: 'err', text: error }} onClose={() => setError(null)} />}
        {rows.length === 0 && loading ? (
          <Loading rows={4} />
        ) : rows.length === 0 ? (
          <Plate>
            <Empty title={filter === 'open' ? 'Inbox zero.' : 'Nothing here.'}>{filter === 'open' ? 'No open reports — nice.' : 'No feedback with these filters.'}</Empty>
          </Plate>
        ) : (
          rows.map((f) => <FeedbackCard key={f.id} f={f} onStatus={updateStatus} />)
        )}
        {!done && rows.length > 0 && (
          <div className='flex justify-center'>
            <button type='button' className='adm-btn' onClick={() => void load(filter, typeFilter, rows[rows.length - 1]?.id)} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
