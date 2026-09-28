import type { RoadReward } from '../game/progression';
import { ItemTile } from '../ui/item-tile';
import './menu.css';

// One Career Road reward as a square tile: cosmetics use the shared rarity
// ItemTile; credits (⛁ + amount) and case keys get their own tile in the same
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
      aria-label={onClick ? (credits ? `${reward.amount} credits` : 'Case key') : undefined}
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
          <KeyGlyph size={Math.round(size * 0.46)} />
        )}
      </span>
      {label && <span className='menu-reward-label'>{credits ? 'Credits' : 'Case key'}</span>}
    </Tag>
  );
}

export function KeyGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className='shrink-0'>
      <circle cx='8' cy='12' r='4.2' fill='none' stroke='currentColor' strokeWidth='2.2' />
      <path d='M12.2 12H21M17.5 12v3.4M20.2 12v2.4' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='square' />
    </svg>
  );
}
