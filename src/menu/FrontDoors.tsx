import { sfxProps } from '../deck-core';
import { cosmeticById, hatById } from '../game/cosmetics';
import { MAX_LEVEL } from '../game/progression';
import { ItemTile } from '../ui/item-tile';
import { KeyGlyph, RewardTile } from './RewardTile';
import { XpBar } from './Progress';
import { nextRoadStep, rewardText, xpFraction, type MenuProfile } from './road-data';
import './menu.css';

// The two headline surfaces get real doors on the menu: a Career Road tile
// (the next reward, how far away it is) and a Locker tile (what you're
// wearing, your free rolls).
export function FrontDoors({
  profile,
  guest,
  hat,
  railgunFinish,
  onRoad,
  onLocker,
}: {
  profile: MenuProfile | null;
  guest: boolean;
  hat: string;
  railgunFinish: string;
  onRoad: () => void;
  onLocker: () => void;
}) {
  const level = guest ? 1 : (profile?.level ?? 1);
  const next = nextRoadStep(level);
  const toNext = !guest && profile && profile.xpForNext > 0 ? Math.max(0, profile.xpForNext - profile.xpIntoLevel) : 0;
  const keys = !guest ? (profile?.freeRolls ?? profile?.caseKeys ?? 0) : 0;
  const wearing = hatById(hat).model ? hat : railgunFinish;
  const nextName = next ? rewardText(next.rewards[0], (id) => cosmeticById(id)?.name) : '';

  const roadLine =
    level >= MAX_LEVEL
      ? 'Road complete'
      : next
        ? guest
          ? `Lv ${next.level} · ${nextName}`
          : toNext > 0 && next.level === level + 1
            ? `Lv ${next.level} · ${toNext.toLocaleString()} XP to go`
            : `Lv ${next.level} · ${nextName}`
        : 'Next level';
  return (
    <div className='flex flex-col gap-2'>
      <button type='button' onClick={onRoad} {...sfxProps('uiClick')} className='menu-door clip-deck-sm' aria-label={`Career Road. ${roadLine}`}>
        {next ? <RewardTile reward={next.rewards[0]} size={52} label={false} /> : <span className='h-[52px] w-[52px] shrink-0 bg-white/5' />}
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='menu-door-title'>Career Road</span>
          <span className='truncate font-sans text-[13px] text-white/70'>{roadLine}</span>
          <XpBar frac={guest ? 0 : xpFraction(profile)} height={5} label='Progress to next level' />
        </span>
      </button>
      <button type='button' onClick={onLocker} {...sfxProps('uiClick')} className='menu-door clip-deck-sm' aria-label={`Locker${keys > 0 ? `. ${keys} free roll${keys === 1 ? '' : 's'}` : ''}`}>
        <ItemTile id={wearing} size={52} label={false} />
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='menu-door-title'>Locker</span>
          <span className='truncate font-sans text-[13px] text-white/70'>Inventory · cases · market</span>
        </span>
        {keys > 0 && (
          <span className='menu-door-keys' title={`${keys} free roll${keys === 1 ? '' : 's'} — open a case for free`}>
            <KeyGlyph size={15} /> {keys}
          </span>
        )}
      </button>
    </div>
  );
}
