// The item-definition combobox: a trigger that shows the chosen def (thumbnail,
// tier colour, slot, season) and a popover with search, slot / tier filter
// chips and a scrollable list of every mintable def with its rendered thumbnail.
// Thumbnails come from the shared ItemTile (game/thumbs.ts) — nothing new drawn.
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { itemDef, seasonOf } from '../game/items/catalog';
import { ITEM_SLOTS, SEASONS, TIERS, TIER_META, type ItemSlot, type Tier } from '../game/items/types';
import { SLOT_LABEL, SLOT_SHORT } from '../economy/display';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR } from '../ui/rarity';
import { Highlight } from './combobox';
import { useDismiss, useListNav } from './listnav';
import { MINTABLE } from './spec-draft';

const CAP = 120;
const MINT_SLOTS = ITEM_SLOTS.filter((s) => MINTABLE.some((d) => d.slot === s));
const SLOT_COUNT = Object.fromEntries(MINT_SLOTS.map((s) => [s, MINTABLE.filter((d) => d.slot === s).length])) as Record<ItemSlot, number>;

export function TierDot({ tier }: { tier: Tier }) {
  return <span className='adm-key' style={{ background: tier === 'unobtainable' ? 'linear-gradient(135deg,#ff4fd8,#5be3ff,#f3c152)' : TIER_META[tier].color }} aria-hidden />;
}

export function ItemPicker({ value, onChange, field = 'def' }: { value: string; onChange: (id: string) => void; field?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [slot, setSlot] = useState<ItemSlot | ''>('');
  const [tier, setTier] = useState<Tier | ''>('');
  const [season, setSeason] = useState<number | ''>('');
  const dq = useDeferredValue(q);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const cur = itemDef(value);

  const list = useMemo(() => {
    const t = dq.trim().toLowerCase();
    return MINTABLE.filter(
      (d) =>
        (!slot || d.slot === slot) &&
        (!tier || d.tier === tier) &&
        (season === '' || seasonOf(d) === season) &&
        (!t || d.name.toLowerCase().includes(t) || d.id.toLowerCase().includes(t) || SLOT_LABEL[d.slot].toLowerCase().includes(t)),
    ).sort((a, b) => TIER_META[b.tier].rank - TIER_META[a.tier].rank || a.name.localeCompare(b.name));
  }, [dq, slot, tier, season]);
  const shown = list.slice(0, CAP);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const nav = useListNav(shown.length, {
    listId,
    onPick: (i) => {
      onChange(shown[i].id);
      close();
    },
    onEscape: () => close(),
  });
  useDismiss(root, open, () => close(false));
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  const openList = () => {
    setOpen(true);
    nav.setActive(Math.max(0, shown.findIndex((d) => d.id === value)));
  };

  return (
    <div ref={root} className='relative min-w-0' data-field={field}>
      <button
        ref={trigger}
        type='button'
        className='adm-input adm-trigger'
        style={{ height: 60, paddingLeft: 6 }}
        data-open={open ? '' : undefined}
        aria-haspopup='listbox'
        aria-expanded={open}
        aria-label={`Item: ${cur?.name ?? value}. Change item`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openList();
          }
        }}
        data-def-trigger={value}
      >
        <ItemTile id={value} size={48} label={false} season={false} tier={cur?.tier} />
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='truncate text-[14px] font-semibold' style={{ color: cur ? TIER_COLOR[cur.tier].text : undefined }}>
            {cur?.name ?? value}
          </span>
          <span className='flex items-center gap-2 text-[12px] text-[var(--adm-ink-2)]'>
            {cur && (
              <>
                <TierDot tier={cur.tier} />
                {TIER_META[cur.tier].label} · {SLOT_LABEL[cur.slot]} · S{seasonOf(cur)}
              </>
            )}
            <span className='truncate font-mono text-[11px] text-[var(--adm-ink-3)]'>{value}</span>
          </span>
        </span>
        <span className='adm-caret' aria-hidden />
      </button>

      {open && (
        <div className='adm-pop' style={{ width: 'min(680px, calc(100vw - 48px))', right: 'auto', maxHeight: 'min(560px, 70vh)' }}>
          <div className='adm-pop-head flex flex-col gap-2'>
            <input
              ref={search}
              className='adm-input w-full'
              placeholder={`Search ${MINTABLE.length} items by name, slot or id…`}
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
              aria-label='Search items'
              data-field='def-search'
            />
            <div className='flex flex-wrap gap-1' role='group' aria-label='Filter by slot'>
              <button type='button' className='adm-chip' aria-pressed={slot === ''} onClick={() => setSlot('')}>
                All slots
              </button>
              {MINT_SLOTS.map((s) => (
                <button key={s} type='button' className='adm-chip' aria-pressed={slot === s} onClick={() => setSlot(slot === s ? '' : s)} data-slot-chip={s}>
                  {SLOT_SHORT[s]} <span className='n'>{SLOT_COUNT[s]}</span>
                </button>
              ))}
            </div>
            <div className='flex flex-wrap gap-1' role='group' aria-label='Filter by tier'>
              <button type='button' className='adm-chip' aria-pressed={tier === ''} onClick={() => setTier('')}>
                All tiers
              </button>
              {TIERS.map((t) => (
                <button key={t} type='button' className='adm-chip' aria-pressed={tier === t} onClick={() => setTier(tier === t ? '' : t)}>
                  <TierDot tier={t} />
                  {TIER_META[t].label}
                </button>
              ))}
              {SEASONS.length > 1 &&
                SEASONS.map((s) => (
                  <button key={s.id} type='button' className='adm-chip' aria-pressed={season === s.id} onClick={() => setSeason(season === s.id ? '' : s.id)}>
                    {s.name}
                  </button>
                ))}
            </div>
          </div>
          <ul id={listId} role='listbox' aria-label='Items' className='adm-pop-list'>
            {shown.map((d, i) => (
              <li
                key={d.id}
                id={nav.optId(i)}
                role='option'
                aria-selected={d.id === value}
                data-active={i === nav.active}
                className='adm-opt'
                style={{ paddingTop: 5, paddingBottom: 5 }}
                onPointerMove={() => nav.active !== i && nav.setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(d.id);
                  close();
                }}
                data-def={d.id}
              >
                <ItemTile id={d.id} size={40} label={false} season={false} tier={d.tier} />
                <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
                  <span className='truncate font-medium' style={{ color: TIER_COLOR[d.tier].text }}>
                    <Highlight text={d.name} q={dq} />
                  </span>
                  <span className='truncate font-mono text-[11px] text-[var(--adm-ink-3)]'>{d.id}</span>
                </span>
                <span className='w-[92px] shrink-0 text-[12px] text-[var(--adm-ink-2)]'>{SLOT_LABEL[d.slot]}</span>
                <span className='flex w-[112px] shrink-0 items-center gap-1.5 text-[12px] text-[var(--adm-ink-2)]'>
                  <TierDot tier={d.tier} />
                  {TIER_META[d.tier].label}
                </span>
                <span className='w-7 shrink-0 text-right font-mono text-[11px] text-[var(--adm-ink-3)]'>S{seasonOf(d)}</span>
                {!d.tradable && <span className='adm-flag staff shrink-0'>Bound</span>}
              </li>
            ))}
            {shown.length === 0 && <li className='adm-state py-6'>No items match. Clear a filter or change the search.</li>}
          </ul>
          <div className='adm-pop-foot flex justify-between'>
            <span>↑↓ to move · Enter to pick · Esc to close</span>
            <span>{list.length > CAP ? `Showing ${CAP} of ${list.length} — refine to see the rest` : `${list.length} item${list.length === 1 ? '' : 's'}`}</span>
          </div>
        </div>
      )}
    </div>
  );
}
