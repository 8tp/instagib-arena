// Target-player field with live suggestions (the admin players table, searched
// by name). Free text still works — the server resolves a username or an id.
import { useEffect, useId, useRef, useState } from 'react';
import { econ, type PlayerHit } from '../economy/api';
import { timeAgo } from '../economy/display';
import { inputCls } from './ui';

export function PlayerLookup({ value, onChange, placeholder = 'Player name', field = 'player' }: { value: string; onChange: (v: string) => void; placeholder?: string; field?: string }) {
  const [hits, setHits] = useState<PlayerHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const q = value.trim();
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      const r = await econ.adminFindPlayers(q);
      if (my !== seq.current) return;
      setHits(r.ok ? r.players : []);
      setActive(0);
    }, 180);
    return () => window.clearTimeout(t);
  }, [value, open]);

  const exact = hits.find((h) => h.userName.toLowerCase() === value.trim().toLowerCase());
  const pick = (h: PlayerHit) => {
    onChange(h.userName);
    setOpen(false);
  };

  return (
    <div className='relative min-w-0'>
      <div className='relative'>
        <input
          className={`${inputCls} w-full pr-7`}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            if (document.activeElement === e.target) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (!open || hits.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(hits[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          role='combobox'
          aria-expanded={open && hits.length > 0}
          aria-controls={listId}
          aria-autocomplete='list'
          autoComplete='off'
          spellCheck={false}
          data-field={field}
        />
        {exact && (
          <span className='pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-emerald-300' title='Player found' aria-label='Player found'>
            ✓
          </span>
        )}
      </div>
      {open && hits.length > 0 && (
        <ul id={listId} role='listbox' className='absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-64 overflow-y-auto rounded-md border border-white/15 bg-zinc-900 py-1 shadow-xl shadow-black/60'>
          {hits.map((h, i) => (
            <li
              key={h.id}
              role='option'
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-[12px] ${i === active ? 'bg-cyan-400/15 text-cyan-100' : 'text-white/80'}`}
            >
              <span className='truncate font-semibold'>
                {h.userName}
                {h.admin && <span className='ml-1.5 text-[10px] text-amber-300'>ADMIN</span>}
              </span>
              <span className='shrink-0 font-mono text-[10px] text-white/40'>
                Lv {h.level} · {h.lastSeen ? timeAgo(h.lastSeen) : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
