import { useEffect, useState } from 'react';
import { sfxProps } from '../deck-core';
import { econ } from '../economy/api';
import { SPIN_USED_EVENT, SPIN_TAB_KEY } from '../economy/spin-link';
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
  // A free daily spin is waiting: one public GET on mount (logged-in players only).
  const [freeSpin, setFreeSpin] = useState(false);
  useEffect(() => {
    if (guest) {
      setFreeSpin(false);
      return;
    }
    let live = true;
    void econ.spinInfo().then((r) => {
      if (live && r.ok) setFreeSpin(!!r.freeAvailable);
    });
    const used = () => setFreeSpin(false);
    window.addEventListener(SPIN_USED_EVENT, used);
    return () => {
      live = false;
      window.removeEventListener(SPIN_USED_EVENT, used);
    };
  }, [guest]);
  const openLocker = () => {
    // Deep-link: the Locker opens on the Spin tab (read once on its mount).
    if (freeSpin) {
      try {
        sessionStorage.setItem(SPIN_TAB_KEY, 'spin');
      } catch {
        /* private mode — the hub alone is fine */
      }
    }
    onLocker();
  };
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
      <button
        type='button'
        onClick={openLocker}
        {...sfxProps('uiClick')}
        className='menu-door clip-deck-sm'
        aria-label={`Locker${freeSpin ? '. Free daily spin ready' : ''}${keys > 0 ? `. ${keys} free roll${keys === 1 ? '' : 's'}` : ''}`}
      >
        <ItemTile id={wearing} size={52} label={false} />
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='menu-door-title'>Locker</span>
          <span className='truncate font-sans text-[13px] text-white/70'>Inventory · cases · market</span>
        </span>
        {freeSpin && <span className='menu-door-spin' title='Your free daily spin is ready'>FREE SPIN</span>}
        {keys > 0 && (
          <span className='menu-door-keys' title={`${keys} free roll${keys === 1 ? '' : 's'} — open a case for free`}>
            <KeyGlyph size={15} /> {keys}
          </span>
        )}
      </button>
    </div>
  );
}
