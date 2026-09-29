import { useEffect, useRef, useState } from 'react';
import type { Account } from '../auth';
import { sfxProps } from '../deck-core';
import { Skeleton } from '../deck';
import { nameColorById, titleById } from '../game/cosmetics';
import { NameBadges } from '../ui/badges';
import { rankedStandingText } from '../ui/player-card-data';
import { Credits, LevelEmblem, XpBar } from './Progress';
import { xpFraction, type MenuProfile } from './road-data';
import './menu.css';

// Bumps (a new key) each time `n` rises — the credits flash when a gift or a
// code lands. Never on first load.
function useRiseKey(n: number | undefined): number {
  const prev = useRef(n);
  const [k, setK] = useState(0);
  useEffect(() => {
    if (n != null && prev.current != null && n > prev.current) setK((x) => x + 1);
    prev.current = n;
  }, [n]);
  return k;
}

// Top-left identity strip: level emblem, name + title, the segmented XP bar
// with numbers, credits. The whole strip opens the Career Road. Guests get
// "Lv 1" and one button — no paragraph.
export function ProfileBlock({
  account,
  profile,
  name,
  nameColor,
  title,
  onOpenRoad,
  onLogin,
}: {
  account: Account;
  profile: MenuProfile | null;
  name: string;
  nameColor: string; // equipped nameplate cosmetic id
  title: string; // equipped title cosmetic id
  onOpenRoad: () => void;
  onLogin: () => void;
}) {
  const creditsKey = useRiseKey(profile?.credits);
  if (!account) {
    return (
      <div className='menu-profile clip-deck-sm'>
        <button
          type='button'
          onClick={onOpenRoad}
          {...sfxProps('uiClick')}
          aria-label='Guest, level 1. Preview the Career Road'
          className='menu-profile-main'
        >
          <LevelEmblem level={1} tone='guest' />
          <span className='menu-profile-name text-white/85'>Guest</span>
        </button>
        <button type='button' onClick={onLogin} {...sfxProps('uiConfirm')} className='menu-cta'>
          Log in to save progress
        </button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className='menu-profile clip-deck-sm' aria-busy='true' aria-label='Loading your profile'>
        <Skeleton className='h-14 w-14 shrink-0' />
        <div className='min-w-0 flex-1'>
          <Skeleton className='h-4 w-32' />
          <Skeleton className='mt-2.5 h-2.5 w-full' />
          <Skeleton className='mt-2 h-3 w-40' />
        </div>
      </div>
    );
  }

  const titleDef = titleById(title);
  const titleText = titleDef.dynamic === 'ranked' ? rankedStandingText(profile.ranked) : titleDef.text;
  const maxed = profile.xpForNext <= 0;

  return (
    <button
      type='button'
      onClick={onOpenRoad}
      {...sfxProps('uiClick')}
      aria-label={`${name}, level ${profile.level}. Open the Career Road`}
      className='menu-profile menu-profile-btn clip-deck-sm'
    >
      <LevelEmblem level={profile.level} />
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='flex min-w-0 items-baseline gap-2'>
          <span className='menu-profile-name' style={{ color: nameColorById(nameColor).color }}>
            {name}
          </span>
          <NameBadges admin={account.isAdmin} verified={account.isVerified} size={13} />
          {titleText && <span className='menu-profile-title truncate'>{titleText}</span>}
        </span>
        <XpBar frac={xpFraction(profile)} className='mt-2' />
        <span className='menu-profile-meta mt-1.5'>
          <span>
            {maxed ? (
              `${profile.totalXp.toLocaleString()} XP`
            ) : (
              <>
                <span className='text-white/90'>{profile.xpIntoLevel.toLocaleString()}</span> / {profile.xpForNext.toLocaleString()} XP
              </>
            )}
          </span>
          <Credits key={creditsKey} amount={profile.credits} className={creditsKey ? 'menu-credits-bump' : ''} />
        </span>
      </span>
    </button>
  );
}
