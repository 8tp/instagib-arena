import type { RoadReward } from '../game/progression';
import { ItemTile } from '../ui/item-tile';
import './menu.css';

// One Career Road reward as a square tile: cosmetics use the shared rarity
// ItemTile; credits and case keys get their own tile in the same frame so a
// row of mixed rewards reads as one set.
export function RewardTile({
  reward,
  size = 96,
  label = true,
  locked = false,
}: {
  reward: RoadReward;
  size?: number;
  label?: boolean;
  locked?: boolean;
}) {
  if (reward.type === 'cosmetic') return <ItemTile id={reward.id} size={size} label={label} locked={locked} />;
  const credits = reward.type === 'credits';
  return (
    <div
      className={`menu-reward ${credits ? 'menu-reward-credits' : 'menu-reward-key'}`}
      style={{ width: size, height: size, opacity: locked ? 0.72 : 1 }}
    >
      {credits ? (
        <span className='menu-reward-amount' style={{ fontSize: Math.max(13, size * 0.24) }}>
          {reward.amount.toLocaleString()}
        </span>
      ) : (
        <KeyGlyph size={Math.round(size * 0.44)} />
      )}
      {label && <span className='menu-reward-label'>{credits ? 'Credits' : 'Case key'}</span>}
    </div>
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
