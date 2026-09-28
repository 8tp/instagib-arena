import type { Account } from '../auth';
import { sfxProps } from '../deck-core';
import { Skeleton } from '../deck';
import { nameColorById, titleById } from '../game/cosmetics';
import { NameBadges } from '../ui/badges';
import { rankedStandingText } from '../ui/player-card-data';
import { KeyGlyph, RewardTile } from './RewardTile';
import { nextRoadStep, xpFraction, type MenuProfile } from './road-data';
import './menu.css';

// Top-left identity: level badge, name + title, XP bar with numbers, credits,
// the next Career Road reward, and the way into the road. Guests get one
// quiet line about what logging in keeps, not a wall.
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
  if (!account) {
    return (
      <div className='menu-profile clip-deck-sm'>
        <div className='menu-level menu-level-guest' aria-hidden='true'>
          <span className='menu-level-num'>1</span>
          <span className='menu-level-cap'>LV</span>
        </div>
        <div className='min-w-0 flex-1'>
          <div className='menu-profile-name text-white/80'>Guest</div>
          <p className='mt-1 font-sans text-[12.5px] leading-snug text-white/50'>
            Log in to keep your level, unlocks and challenge progress.
          </p>
        </div>
        <button
          type='button'
          onClick={onLogin}
          {...sfxProps('uiClick')}
          className='clip-deck-sm shrink-0 bg-cyan-300 px-3 py-1.5 font-display text-[13px] font-bold uppercase tracking-[0.1em] text-[#021216] transition hover:bg-cyan-200'
        >
          Log in
        </button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className='menu-profile clip-deck-sm' aria-busy='true' aria-label='Loading your profile'>
        <Skeleton className='h-[3.35rem] w-[3.35rem] shrink-0' />
        <div className='min-w-0 flex-1'>
          <Skeleton className='h-4 w-32' />
          <Skeleton className='mt-2 h-1.5 w-full' />
          <Skeleton className='mt-2 h-2.5 w-40' />
        </div>
      </div>
    );
  }

  const titleDef = titleById(title);
  const titleText = titleDef.dynamic === 'ranked' ? rankedStandingText(profile.ranked) : titleDef.text;
  const frac = xpFraction(profile);
  const maxed = profile.xpForNext <= 0;
  const next = nextRoadStep(profile.level);
  const keys = typeof profile.caseKeys === 'number' ? profile.caseKeys : 0;

  return (
    <button
      type='button'
      onClick={onOpenRoad}
      {...sfxProps('uiClick')}
      aria-label={`Level ${profile.level}. Open the Career Road`}
      className='menu-profile clip-deck-sm'
    >
      <div className='menu-level' aria-hidden='true'>
        <span className='menu-level-num'>{profile.level}</span>
        <span className='menu-level-cap'>LV</span>
      </div>
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='menu-profile-name' style={{ color: nameColorById(nameColor).color }}>
            {name}
          </span>
          <NameBadges admin={account.isAdmin} verified={account.isVerified} size={13} />
          {titleText && <span className='menu-profile-title truncate'>{titleText}</span>}
        </div>
        <div className='menu-xp mt-1.5' role='progressbar' aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label='Progress to next level'>
          <span style={{ width: `${frac * 100}%` }} />
        </div>
        <div className='menu-profile-meta mt-1.5'>
          <span>
            {maxed ? (
              `${profile.totalXp.toLocaleString()} XP`
            ) : (
              <>
                <span className='text-white/85'>{profile.xpIntoLevel.toLocaleString()}</span> / {profile.xpForNext.toLocaleString()} XP
              </>
            )}
          </span>
          <span className='text-amber-200/90'>{profile.credits.toLocaleString()} cr</span>
          {keys > 0 && (
            <span className='inline-flex items-center gap-1 text-cyan-200/90' title={`${keys} case key${keys === 1 ? '' : 's'}`}>
              <KeyGlyph size={12} /> {keys}
            </span>
          )}
          <span className='menu-profile-link ml-auto hidden sm:inline'>Career Road</span>
        </div>
      </div>
      {next && (
        <div className='menu-profile-next max-sm:hidden' title={`Next reward at level ${next.level}`}>
          <RewardTile reward={next.rewards[0]} size={44} label={false} />
          <span>Lv {next.level}</span>
        </div>
      )}
    </button>
  );
}
