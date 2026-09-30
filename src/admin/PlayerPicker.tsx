// The admin player combobox: typeahead against /api/admin/players/search with
// rich rows (initial, level, flags, last seen, credits, items), keyboard
// navigation, match highlighting and recent picks. Once a player is chosen the
// field collapses to that player, and PlayerSummary shows who it is.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LevelBadge } from '../ui/item-tile';
import { searchPlayers, type AdminPlayer } from './api';
import { Highlight } from './combobox';
import { useDismiss, useListNav } from './listnav';
import { ago, compact, fmt, shortDate } from './format';
import { Avatar, PlayerFlags } from './ui';

const RECENT_KEY = 'ig-admin-recent-players';
function readRecent(): AdminPlayer[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as AdminPlayer[];
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}
function pushRecent(p: AdminPlayer): void {
  try {
    const list = [p, ...readRecent().filter((x) => x.id !== p.id)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage off — recents are a nicety */
  }
}

type Row = { p: AdminPlayer; recent: boolean };

export function PlayerPicker({
  value,
  onChange,
  placeholder = 'Search players by name…',
  field = 'player',
  label = 'Player',
  autoFocus = false,
}: {
  value: AdminPlayer | null;
  onChange: (p: AdminPlayer | null) => void;
  placeholder?: string;
  field?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(!value);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<AdminPlayer[] | null>(null);
  const [err, setErr] = useState('');
  const [recent, setRecent] = useState<AdminPlayer[]>(() => readRecent());
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const seq = useRef(0);

  // A new value from outside (e.g. "open in Items") collapses the field.
  useEffect(() => {
    if (value) setEditing(false);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      const r = await searchPlayers(q, 20);
      if (my !== seq.current) return;
      if (r.ok) {
        setHits(r.players);
        setErr('');
      } else {
        setHits([]);
        setErr(r.message);
      }
    }, q ? 160 : 0);
    return () => window.clearTimeout(t);
  }, [q, open]);

  const showRecent = !q.trim() && recent.length > 0;
  const rows: Row[] = [
    ...(showRecent ? recent.map((p) => ({ p, recent: true })) : []),
    ...(hits ?? []).filter((p) => !showRecent || !recent.some((r) => r.id === p.id)).map((p) => ({ p, recent: false })),
  ];

  const pick = (p: AdminPlayer) => {
    pushRecent(p);
    setRecent(readRecent());
    onChange(p);
    setOpen(false);
    setEditing(false);
    setQ('');
  };
  const cancel = useCallback(() => {
    setOpen(false);
    if (value) {
      setEditing(false);
      setQ('');
    }
  }, [value]);
  const nav = useListNav(rows.length, { listId, onPick: (i) => pick(rows[i].p), onEscape: cancel });
  useDismiss(root, open, cancel);

  useEffect(() => {
    if (editing && (autoFocus || value)) input.current?.focus();
    // Only when switching into edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (value && !editing) {
    return (
      <div ref={root} className='relative min-w-0' data-field={field}>
        <button
          type='button'
          className='adm-input adm-trigger'
          style={{ height: 40 }}
          onClick={() => {
            setEditing(true);
            setOpen(true);
          }}
          aria-label={`${label}: ${value.userName}. Change player`}
          data-selected-player={value.userName}
        >
          <Avatar name={value.userName} />
          <span className='min-w-0 truncate font-medium'>{value.userName}</span>
          <LevelBadge level={value.level} />
          <PlayerFlags admin={value.admin} verified={value.verified} />
          <span className='ml-auto shrink-0 text-[12px] text-[var(--adm-ink-3)]'>Change</span>
        </button>
      </div>
    );
  }

  let lastGroup = '';
  return (
    <div ref={root} className='relative min-w-0' data-field={field}>
      <div className='adm-input flex items-center gap-2' data-open={open ? '' : undefined} style={{ height: 40 }}>
        <svg width='14' height='14' viewBox='0 0 16 16' aria-hidden className='shrink-0 text-[var(--adm-ink-3)]'>
          <circle cx='7' cy='7' r='5' fill='none' stroke='currentColor' strokeWidth='1.6' />
          <path d='M11 11l3.5 3.5' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
        </svg>
        <input
          ref={input}
          className='h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--adm-ink-3)]'
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            nav.setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              setOpen(true);
              return;
            }
            if (e.key === 'Tab') {
              cancel();
              return;
            }
            if (e.key === 'Enter' && nav.active < 0) {
              const exact = rows.find((r) => r.p.userName.toLowerCase() === q.trim().toLowerCase());
              if (exact) {
                e.preventDefault();
                pick(exact.p);
                return;
              }
            }
            nav.onKeyDown(e);
          }}
          role='combobox'
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? nav.activeId : undefined}
          aria-autocomplete='list'
          autoComplete='off'
          spellCheck={false}
          data-field={`${field}-input`}
        />
        {value && (
          <button type='button' className='adm-btn sm ghost' onClick={cancel}>
            Keep {value.userName}
          </button>
        )}
      </div>
      {open && (
        <div className='adm-pop'>
          <ul id={listId} role='listbox' aria-label='Players' className='adm-pop-list'>
            {rows.map((r, i) => {
              const group = r.recent ? 'Recent' : q.trim() ? 'Matches' : 'Recently active';
              const head = group !== lastGroup;
              lastGroup = group;
              return (
                <li key={`${group}-${r.p.id}`} role='presentation'>
                  {head && (
                    <div className='adm-opt-group' role='presentation'>
                      {group}
                    </div>
                  )}
                  <div
                    id={nav.optId(i)}
                    role='option'
                    aria-selected={value?.id === r.p.id}
                    data-active={i === nav.active}
                    className='adm-opt'
                    onPointerMove={() => nav.active !== i && nav.setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r.p)}
                    data-player-option={r.p.userName}
                  >
                    <PlayerRowBody p={r.p} q={q} />
                  </div>
                </li>
              );
            })}
            {hits === null && !showRecent && <li className='adm-state py-5'>Searching…</li>}
            {hits !== null && rows.length === 0 && (
              <li className='adm-state py-5'>{err || (q.trim() ? `No account matches “${q.trim()}”.` : 'No accounts yet.')}</li>
            )}
          </ul>
          <div className='adm-pop-foot flex justify-between gap-2'>
            <span>↑↓ to move · Enter to pick · Esc to close</span>
            {hits && <span>{hits.length >= 20 ? 'Top 20 — keep typing' : `${hits.length} found`}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerRowBody({ p, q }: { p: AdminPlayer; q: string }) {
  return (
    <>
      <Avatar name={p.userName} />
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex min-w-0 items-center gap-1.5'>
          <span className='truncate font-medium text-[var(--adm-ink)]'>
            <Highlight text={p.userName} q={q} />
          </span>
          <PlayerFlags admin={p.admin} verified={p.verified} />
        </span>
        <span className='truncate text-[11px] text-[var(--adm-ink-3)]'>
          {p.games ? `${fmt(p.games)} games` : 'No games yet'} · seen {ago(p.lastSeen)}
        </span>
      </span>
      <span className='hidden shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] sm:flex'>
        <span className='text-[var(--adm-credit)]'>⛁ {compact(p.credits)}</span>
        <span className='text-[var(--adm-ink-3)]'>{fmt(p.items)} items</span>
      </span>
      <span className='shrink-0'>
        <LevelBadge level={p.level} />
      </span>
    </>
  );
}

// "Who did I pick": the selected account at a glance.
export function PlayerSummary({ p, actions }: { p: AdminPlayer; actions?: React.ReactNode }) {
  const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills ? `${p.kills}.00` : '—';
  const stats: [string, string, string?][] = [
    ['Credits', `⛁ ${fmt(p.credits)}`, 'var(--adm-credit)'],
    ['Free rolls', fmt(p.freeRolls)],
    ['Items', fmt(p.items)],
    ['Games', fmt(p.games)],
    ['Wins', fmt(p.wins)],
    ['K/D', kd],
  ];
  return (
    <div className='flex flex-col gap-3 border border-[var(--adm-line)] bg-[var(--adm-plate)] p-3' data-player-summary={p.userName}>
      <div className='flex items-center gap-3'>
        <Avatar name={p.userName} large />
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='truncate text-[17px] font-semibold text-[var(--adm-ink)]'>{p.userName}</span>
            <LevelBadge level={p.level} />
            <PlayerFlags admin={p.admin} verified={p.verified} />
          </div>
          <div className='mt-0.5 truncate text-[12px] text-[var(--adm-ink-3)]'>
            Joined {p.createdAt ? shortDate(p.createdAt) : '—'} · seen {ago(p.lastSeen)} · <span className='font-mono'>{p.id}</span>
          </div>
        </div>
        {actions && <div className='flex shrink-0 flex-wrap gap-1.5'>{actions}</div>}
      </div>
      <dl className='grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6'>
        {stats.map(([k, v, c]) => (
          <div key={k} className='min-w-0'>
            <dt className='text-[11px] text-[var(--adm-ink-3)]'>{k}</dt>
            <dd className='truncate font-mono text-[14px] tabular-nums' style={{ color: c ?? 'var(--adm-ink)' }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
