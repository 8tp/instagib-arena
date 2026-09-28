// A cosmetic as a rarity-framed tile (Fortnite-style colour language): used by
// the Locker grid + loadout rail, the end-of-match reward cards and the Career
// Road. Rendered thumbnails come from game/thumbs.ts; slots without a 3D
// subject (name colours, titles, cards) get a CSS treatment here instead.
import type { CSSProperties, FocusEvent, HTMLAttributes, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { cardById, cosmeticById, nameColorById, titleById, type CatalogEntry, type CosmeticSource, type Rarity } from '../game/cosmetics';
import { RARITY_COLOR, useThumbnailState } from './rarity';

export function ItemTile({
  id,
  size = 96,
  fluid = false,
  selected = false,
  locked = false,
  equipped = false,
  isNew = false,
  dot = false,
  price,
  hint = 'auto',
  caption,
  label = true,
  onClick,
  onDoubleClick,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onKeyDown,
  tabIndex,
  rootProps,
  className = '',
}: {
  id: string;
  size?: number; // px square (ignored when `fluid`)
  fluid?: boolean; // fill the parent's width, stay square
  selected?: boolean;
  locked?: boolean;
  equipped?: boolean;
  isNew?: boolean;
  dot?: boolean; // small "something new inside" pip (loadout rail)
  price?: number; // overrides the credits hint on a buyable locked item
  hint?: 'auto' | 'none' | ReactNode; // locked tiles: unlock route in the name row (auto from the catalog)
  caption?: string; // tiny top-left caption (the slot name on the loadout rail)
  label?: boolean;
  onClick?: () => void;
  onDoubleClick?: (e: MouseEvent<HTMLElement>) => void;
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  tabIndex?: number;
  rootProps?: HTMLAttributes<HTMLElement> & Record<string, unknown>;
  className?: string;
}) {
  const item = cosmeticById(id);
  const rarity: Rarity = item?.rarity ?? 'common';
  const c = RARITY_COLOR[rarity];
  const { url: thumb, pending } = useThumbnailState(id);
  const interactive = !!onClick;
  const Tag = interactive ? 'button' : 'div';
  const lit = selected || equipped;
  // Every locked tile says how to get it (price / level / case / achievement).
  const shownHint: ReactNode =
    hint === 'none' || !locked
      ? null
      : hint !== 'auto'
        ? hint
        : price != null
          ? <CreditsHint amount={price} />
          : item
            ? <UnlockHint source={item.source} />
            : null;
  const style: CSSProperties & Record<'--rc', string> = {
    '--rc': c.edge,
    ...(fluid ? { width: '100%', aspectRatio: '1 / 1' } : { width: size, height: size }),
    containerType: 'inline-size',
  };
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      data-rarity={rarity}
      aria-pressed={interactive ? selected : undefined}
      aria-label={interactive ? `${item?.name ?? id}, ${rarity}${equipped ? ', equipped' : ''}${locked ? ', locked' : ''}${isNew ? ', new' : ''}` : undefined}
      {...rootProps}
      className={`group relative block shrink-0 text-left outline-none transition-transform duration-150 ease-out motion-reduce:transition-none ${
        interactive ? 'cursor-pointer hover:-translate-y-[3px] focus-visible:-translate-y-[3px] active:translate-y-0' : ''
      } ${className}`}
      style={style}
    >
      {/* Rarity glow: fades in on hover / keyboard focus, held while selected. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute -inset-[3px] transition-opacity duration-150 ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-80 group-focus-visible:opacity-100'
        }`}
        style={{
          boxShadow: `0 0 0 ${selected ? 2 : 1}px ${selected ? '#ffffff' : c.edge}, 0 10px 26px -8px ${c.edge}, 0 0 18px -4px ${c.edge}aa`,
        }}
      />
      <span
        className='relative block h-full w-full overflow-hidden'
        style={{
          background: `radial-gradient(115% 85% at 50% 22%, ${c.from}, ${c.to} 78%)`,
          boxShadow: `inset 0 0 0 1px ${c.edge}${lit ? 'cc' : '55'}`,
        }}
      >
        {/* Diagonal sheen — sells the "card" read. */}
        <span
          aria-hidden
          className='pointer-events-none absolute inset-0 opacity-60'
          style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 38%)' }}
        />
        {thumb ? (
          <img
            src={thumb}
            alt=''
            draggable={false}
            className='absolute inset-0 h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.05] motion-reduce:transition-none'
            style={locked ? { filter: 'grayscale(0.55) brightness(0.62)' } : undefined}
          />
        ) : pending ? (
          <span aria-hidden className='deck-skeleton absolute inset-[18%] opacity-40' />
        ) : (
          <Treatment item={item} id={id} locked={locked} color={c.edge} />
        )}
        {/* Rarity bar along the bottom edge. */}
        <span aria-hidden className='absolute inset-x-0 bottom-0 h-[3px]' style={{ background: c.edge }} />
        {label && (
          // Name band on a scrim: the unlock route (price / level / case)
          // right-aligned on its own line, then the name on up to two lines —
          // never "Standard Iss…", never covering the art mid-tile.
          <span
            className='absolute inset-x-0 bottom-[3px] flex flex-col items-stretch gap-[2.5cqw] px-[6cqw] pb-[5cqw] pt-[16cqw]'
            style={{ background: 'linear-gradient(180deg, rgba(4,6,10,0) 0%, rgba(4,6,10,0.74) 42%, rgba(4,6,10,0.9) 100%)' }}
          >
            {shownHint && <span className='self-end leading-none'>{shownHint}</span>}
            <span
              className='line-clamp-2 font-display font-semibold leading-[1.08]'
              style={{
                color: locked ? `${c.text}c0` : c.text,
                fontSize: 'max(12px, 9cqw)',
                overflowWrap: 'break-word',
              }}
            >
              {item?.name ?? id}
            </span>
          </span>
        )}
        {caption && (
          <span
            className='absolute left-0 top-0 bg-black/60 px-[5cqw] py-[2.5cqw] font-sans font-medium leading-none text-white/85'
            style={{ fontSize: 'max(12px, 9cqw)' }}
          >
            {caption}
          </span>
        )}
        {isNew && (
          <span
            className='lk-new-badge absolute left-[5cqw] top-[5cqw] bg-[#ffe14d] px-[5px] py-[2px] font-display text-[12px] font-bold uppercase leading-none tracking-[0.06em] text-black'
          >
            New
          </span>
        )}
        {equipped && (
          <span
            aria-hidden
            className='absolute right-0 top-0 grid place-items-center bg-cyan-300 font-bold leading-none text-black'
            style={{ width: 'max(18px, 15cqw)', height: 'max(18px, 15cqw)', fontSize: 'max(12px, 10cqw)' }}
            title='Equipped'
          >
            ✓
          </span>
        )}
        {locked && !equipped && (
          <span
            aria-hidden
            className='absolute right-[5cqw] top-[5cqw] grid place-items-center bg-black/60 text-white/85'
            style={{ width: 'max(16px, 15cqw)', height: 'max(16px, 15cqw)' }}
          >
            <LockGlyph />
          </span>
        )}
        {dot && (
          <span
            aria-hidden
            className='absolute right-[5cqw] top-[5cqw] h-2 w-2 rounded-full bg-[#ffe14d] shadow-[0_0_8px_#ffe14d]'
          />
        )}
      </span>
    </Tag>
  );
}

// Compact unlock routes for the name row. Currency always reads "⛁ 1,234";
// levels use the filled level badge.
function CreditsHint({ amount }: { amount: number }) {
  return <span className='font-mono text-[12px] font-semibold tabular-nums leading-none text-amber-200'>⛁ {amount.toLocaleString()}</span>;
}

export function LevelBadge({ level }: { level: number }) {
  return (
    <span
      className='inline-block px-[5px] py-[2px] font-display text-[12px] font-bold leading-none text-[#021216]'
      style={{
        background: 'linear-gradient(150deg, #67e8f9 0%, #22d3ee 40%, #0e7490 100%)',
        clipPath: 'polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)',
      }}
    >
      Lv {level}
    </span>
  );
}

function compactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}

function UnlockHint({ source }: { source: CosmeticSource }) {
  const muted = 'font-sans text-[12px] font-medium leading-none text-white/75';
  switch (source.type) {
    case 'credits':
      return <CreditsHint amount={source.price} />;
    case 'level':
      return <LevelBadge level={source.level} />;
    case 'case':
      return <span className={`${muted} text-amber-200`}>Case</span>;
    case 'admin':
      return <span className={muted}>Staff</span>;
    case 'achievement': {
      const n = compactCount(source.min);
      const label =
        source.stat === 'kills'
          ? `${n} frags`
          : source.stat === 'headshots'
            ? `${n} HS`
            : source.stat === 'wins'
              ? `${n} wins`
              : source.stat === 'bestStreak'
                ? `${n} streak`
                : source.stat === 'games'
                  ? `${n} games`
                  : `${source.min}% acc`;
      return <span className={muted}>{label}</span>;
    }
    default:
      return null;
  }
}

function LockGlyph() {
  return (
    <svg viewBox='0 0 12 14' width='55%' height='55%' fill='currentColor' aria-hidden>
      <path d='M3 6V4.2a3 3 0 0 1 6 0V6h.6c.5 0 .9.4.9.9v5.7c0 .5-.4.9-.9.9H2.4a.9.9 0 0 1-.9-.9V6.9c0-.5.4-.9.9-.9H3Zm1.4 0h3.2V4.2a1.6 1.6 0 0 0-3.2 0V6Z' />
    </svg>
  );
}

// CSS stand-ins for cosmetics with no 3D subject.
function Treatment({
  item,
  id,
  locked,
  color,
}: {
  item: CatalogEntry | undefined;
  id: string;
  locked: boolean;
  color: string;
}) {
  const dim = locked ? { filter: 'grayscale(0.5) brightness(0.7)' } : undefined;
  if (item?.slot === 'nameColor') {
    const col = nameColorById(id).color;
    return (
      <span className='absolute inset-0 flex flex-col items-center justify-center gap-[3cqw] pb-[14cqw]' style={dim}>
        <span
          className='font-display font-bold leading-none'
          style={{ color: col, fontSize: '38cqw', textShadow: `0 0 18px ${col}88` }}
        >
          Aa
        </span>
        <span className='h-[2px] w-[42%]' style={{ background: col, boxShadow: `0 0 8px ${col}` }} />
      </span>
    );
  }
  if (item?.slot === 'title') {
    const t = titleById(id);
    const text = t.dynamic === 'ranked' ? '#1 · Tier' : t.text;
    return (
      <span className='absolute inset-0 flex items-center justify-center px-[8cqw] pb-[14cqw]' style={dim}>
        {text ? (
          <span
            className='border px-[5cqw] py-[3cqw] text-center font-mono font-semibold uppercase leading-tight tracking-[0.14em]'
            style={{
              fontSize: 'max(12px, 10cqw)',
              color: 'rgba(226,234,255,0.92)',
              borderColor: `${color}88`,
              background: 'rgba(8,10,14,0.62)',
            }}
          >
            {text}
          </span>
        ) : (
          <span className='font-display font-bold text-white/30' style={{ fontSize: '26cqw' }}>
            —
          </span>
        )}
      </span>
    );
  }
  if (item?.slot === 'card') {
    const card = cardById(id);
    return (
      <span className='absolute inset-0 flex items-center justify-center pb-[12cqw]' style={dim}>
        <span
          className='relative flex w-[82%] flex-col gap-[4cqw] overflow-hidden border border-white/20 p-[5cqw] shadow-[0_6px_16px_rgba(0,0,0,0.5)]'
          style={{ background: card.bg, aspectRatio: '1.75 / 1' }}
        >
          <span className='flex items-center gap-[4cqw]'>
            <span
              className='shrink-0 border'
              style={{ width: '14cqw', height: '14cqw', borderColor: card.accent, background: 'rgba(0,0,0,0.3)' }}
            />
            <span className='flex flex-1 flex-col gap-[2cqw]'>
              <span className='h-[3.5cqw] w-[80%] bg-white/85' />
              <span className='h-[2.5cqw] w-[55%]' style={{ background: card.accent }} />
            </span>
          </span>
          <span className='flex gap-[3cqw]'>
            {[0, 1, 2].map((i) => (
              <span key={i} className='flex h-[10cqw] flex-1 items-center justify-center bg-black/30'>
                <span className='h-[3cqw] w-[45%]' style={{ background: card.accent }} />
              </span>
            ))}
          </span>
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className='absolute inset-0 grid place-items-center pb-[12cqw] font-display font-bold'
      style={{ color: `${color}88`, fontSize: '30cqw' }}
    >
      {(item?.name ?? '?').slice(0, 1)}
    </span>
  );
}
