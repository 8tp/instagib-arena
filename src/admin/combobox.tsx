// Accessible listbox primitives for the admin console (keyboard model in
// ./listnav.ts).
//   Highlight    — marks the matched part of a label
//   Select       — styled single-select (button trigger + listbox popover,
//                  with an inline filter when there are many options)
// The typeahead comboboxes (PlayerPicker, ItemPicker) build on the same hooks.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDismiss, useListNav } from './listnav';

export function Highlight({ text, q }: { text: string; q: string }) {
  const t = q.trim().toLowerCase();
  if (!t) return <>{text}</>;
  const i = text.toLowerCase().indexOf(t);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className='adm-mark-hit'>{text.slice(i, i + t.length)}</mark>
      {text.slice(i + t.length)}
    </>
  );
}

// ── Select ──────────────────────────────────────────────────────────────────
export type SelectOption<V extends string> = {
  value: V;
  label: string;
  hint?: string; // right-aligned muted text
  swatch?: string; // colour square before the label
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: string;
};

export function Select<V extends string>({
  value,
  onChange,
  options,
  label,
  placeholder = 'Choose…',
  searchable,
  disabled,
  field,
  className = '',
  renderOption,
}: {
  value: V;
  onChange: (v: V) => void;
  options: readonly SelectOption<V>[];
  label: string; // accessible name
  placeholder?: string;
  searchable?: boolean; // default: more than 8 options
  disabled?: boolean;
  field?: string;
  className?: string;
  renderOption?: (o: SelectOption<V>, q: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const canSearch = searchable ?? options.length > 8;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => `${o.label} ${o.keywords ?? ''} ${o.hint ?? ''}`.toLowerCase().includes(t)) : options;
  }, [options, q]);
  const cur = options.find((o) => o.value === value);
  const close = (refocus = true) => {
    setOpen(false);
    setQ('');
    if (refocus) trigger.current?.focus();
  };
  const nav = useListNav(shown.length, {
    listId,
    onPick: (i) => {
      onChange(shown[i].value);
      close();
    },
    onEscape: () => close(),
    isDisabled: (i) => !!shown[i]?.disabled,
  });
  useDismiss(root, open, () => close(false));
  const openList = () => {
    if (disabled) return;
    setOpen(true);
    const at = options.findIndex((o) => o.value === value);
    nav.setActive(at);
  };
  useEffect(() => {
    if (!open) return;
    (canSearch ? search.current : listRef.current)?.focus();
  }, [open, canSearch]);

  return (
    <div ref={root} className={`relative min-w-0 ${className}`} data-field={field}>
      <button
        ref={trigger}
        type='button'
        className='adm-input adm-trigger'
        data-open={open ? '' : undefined}
        disabled={disabled}
        aria-haspopup='listbox'
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${cur?.label ?? placeholder}`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openList();
          }
        }}
      >
        {cur?.swatch && <span className='adm-key' style={{ background: cur.swatch }} />}
        {cur?.icon}
        <span className={`min-w-0 flex-1 truncate ${cur ? '' : 'text-[var(--adm-ink-3)]'}`}>{cur?.label ?? placeholder}</span>
        {cur?.hint && <span className='shrink-0 text-[11px] text-[var(--adm-ink-3)]'>{cur.hint}</span>}
        <span className='adm-caret' aria-hidden />
      </button>
      {open && (
        <div className='adm-pop' style={{ minWidth: 220 }}>
          {canSearch && (
            <div className='adm-pop-head'>
              <input
                ref={search}
                className='adm-input w-full'
                style={{ height: 30 }}
                placeholder={`Filter ${label.toLowerCase()}…`}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  nav.setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') close(false);
                  nav.onKeyDown(e);
                }}
                role='combobox'
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={nav.activeId}
                aria-autocomplete='list'
                aria-label={`Filter ${label}`}
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role='listbox'
            aria-label={label}
            tabIndex={canSearch ? undefined : -1}
            aria-activedescendant={canSearch ? undefined : nav.activeId}
            className='adm-pop-list outline-none'
            onKeyDown={(e) => {
              if (e.key === 'Tab') close(false);
              nav.onKeyDown(e);
            }}
          >
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={nav.optId(i)}
                role='option'
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === nav.active}
                className='adm-opt'
                onPointerMove={() => nav.active !== i && nav.setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  close();
                }}
              >
                {renderOption ? (
                  renderOption(o, q)
                ) : (
                  <>
                    {o.swatch && <span className='adm-key' style={{ background: o.swatch }} />}
                    {o.icon}
                    <span className='min-w-0 flex-1 truncate'>
                      <Highlight text={o.label} q={q} />
                    </span>
                    {o.hint && <span className='shrink-0 text-[11px] text-[var(--adm-ink-3)]'>{o.hint}</span>}
                    {o.value === value && <span className='shrink-0 text-[var(--adm-rail)]'>✓</span>}
                  </>
                )}
              </li>
            ))}
            {shown.length === 0 && <li className='adm-state py-4'>Nothing matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
