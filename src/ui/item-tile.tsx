// A cosmetic as a rarity-framed tile (Fortnite-style colour language): used by
// the Locker grid, the end-of-match reward cards and the Career Road.
import { cosmeticById, type Rarity } from '../game/cosmetics';
import { RARITY_COLOR, useThumbnail } from './rarity';

export function ItemTile({
  id,
  size = 96,
  selected = false,
  locked = false,
  label = true,
  onClick,
}: {
  id: string;
  size?: number;
  selected?: boolean;
  locked?: boolean;
  label?: boolean;
  onClick?: () => void;
}) {
  const item = cosmeticById(id);
  const rarity: Rarity = item?.rarity ?? 'common';
  const c = RARITY_COLOR[rarity];
  const thumb = useThumbnail(id);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      data-rarity={rarity}
      aria-pressed={onClick ? selected : undefined}
      className='relative flex shrink-0 flex-col overflow-hidden text-left'
      style={{
        width: size,
        height: size,
        background: `radial-gradient(120% 90% at 50% 20%, ${c.from}, ${c.to})`,
        boxShadow: selected ? `inset 0 0 0 2px ${c.edge}, 0 0 14px ${c.edge}66` : `inset 0 0 0 1px ${c.edge}55`,
        opacity: locked ? 0.72 : 1,
      }}
    >
      {thumb ? (
        <img src={thumb} alt='' draggable={false} className='absolute inset-0 h-full w-full object-cover' />
      ) : (
        <span aria-hidden className='absolute inset-0 grid place-items-center font-display text-3xl font-bold' style={{ color: `${c.edge}88` }}>
          {(item?.name ?? '?').slice(0, 1)}
        </span>
      )}
      {label && (
        <span
          className='absolute inset-x-0 bottom-0 truncate px-1.5 pb-1 pt-3 font-display text-[11px] font-semibold uppercase tracking-[0.06em]'
          style={{ color: c.text, background: 'linear-gradient(transparent, rgba(0,0,0,0.75))' }}
        >
          {item?.name ?? id}
        </span>
      )}
      {locked && <span className='absolute right-1 top-1 text-[11px]' aria-label='Locked'>🔒</span>}
    </Tag>
  );
}
