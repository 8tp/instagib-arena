import type { RoadReward } from '../game/progression';
import { ItemTile } from '../ui/item-tile';
import './menu.css';

// One Career Road reward as a square tile: cosmetics use the shared rarity
// ItemTile; credits (⛁ + amount) and free rolls get their own tile in the same
// frame so a row of mixed rewards reads as one set. Clickable when `onClick`.
export function RewardTile({
  reward,
  size = 96,
  label = true,
  locked = false,
  selected = false,
  onClick,
}: {
  reward: RoadReward;
  size?: number;
  label?: boolean;
  locked?: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  if (reward.type === 'cosmetic') {
    return <ItemTile id={reward.id} size={size} label={label} locked={locked} selected={selected} onClick={onClick} />;
  }
  const credits = reward.type === 'credits';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      aria-label={onClick ? (credits ? `${reward.amount} credits` : freeRollText(reward)) : undefined}
      className={`menu-reward ${credits ? 'menu-reward-credits' : 'menu-reward-key'}`}
      data-locked={locked ? '1' : '0'}
      data-selected={selected ? '1' : '0'}
      style={{ width: size, height: size }}
    >
      <span className='menu-reward-art' style={{ fontSize: Math.max(14, size * 0.2) }}>
        {credits ? (
          <>
            <span aria-hidden='true' className='menu-reward-coin' style={{ fontSize: Math.max(16, size * 0.3) }}>
              ⛁
            </span>
            <span className='menu-reward-amount'>{reward.amount.toLocaleString()}</span>
          </>
        ) : (
          <>
            <KeyGlyph size={Math.round(size * 0.46)} />
            {reward.type === 'case' && (reward.count ?? 1) > 1 && <span className='menu-reward-amount'>×{reward.count}</span>}
          </>
        )}
      </span>
      {label && <span className='menu-reward-label'>{credits ? 'Credits' : 'Free roll'}</span>}
    </Tag>
  );
}

// A free case roll (v3: the road's "key" is now a free roll of any standard
// case). Drawn as a ticket; KeyGlyph is the old name every caller still uses.
function freeRollText(r: { type: 'case'; count?: number } | { type: string }): string {
  const n = 'count' in r ? ((r as { count?: number }).count ?? 1) : 1;
  return n > 1 ? `${n} free rolls` : 'Free roll';
}

export function KeyGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className='shrink-0'>
      <path d='M3 7h18v3.2a2 2 0 0 0 0 3.6V17H3v-3.2a2 2 0 0 0 0-3.6V7Z' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinejoin='round' />
      <path d='M14.5 8v8' stroke='currentColor' strokeWidth='2' strokeDasharray='2 2' />
    </svg>
  );
}
export { KeyGlyph as TicketGlyph };
