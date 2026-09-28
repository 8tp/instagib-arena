// The playercard (kill banner) + its stat picker, shared by the killcam, the
// Locker and the results screen.
import { useEffect, useState } from 'react';
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { SegButton } from '../deck';
import { cardById, titleById } from '../game/cosmetics';
import type { CardPayload } from '../game/types';
import { NameBadges } from './badges';
import { CARD_STAT_DEFS, MAX_CARD_STATS, buildCardPayload } from './player-card-data';

// Pick up to 3 career stats for the playercard, with a live preview.
export function CardStatsEditor({
  settings,
  onChange,
  account,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  account?: Account;
}) {
  const [profile, setProfile] = useState<InstagibProfile | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (active && d.profile) setProfile(d.profile);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const toggle = (key: string) => {
    const cur = settings.cardStats;
    let next: string[];
    if (cur.includes(key)) next = cur.filter((k) => k !== key);
    else if (cur.length < MAX_CARD_STATS) next = [...cur, key];
    else next = [...cur.slice(1), key]; // at the cap → drop the oldest
    onChange({ ...settings, cardStats: next });
  };

  const preview: CardPayload = profile
    ? buildCardPayload(profile, settings, account)
    : {
        name: settings.playerName || 'Player',
        level: 1,
        style: settings.card,
        stats: settings.cardStats.map((k) => ({
          label: CARD_STAT_DEFS.find((d) => d.key === k)?.label ?? k.toUpperCase(),
          value: '—',
        })),
        title: titleById(settings.title).text,
        verified: !!account?.isVerified,
        admin: !!account?.isAdmin,
      };

  return (
    <div className='mt-1 border-t border-white/10 pt-4'>
      <div className='mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55'>Card Stats</div>
      <div className='flex flex-col gap-4'>
      <div className='flex justify-center py-1'>
        <PlayerCard card={preview} size='small' reduced={settings.reducedEffects} />
      </div>
      <div className='grid grid-cols-2 gap-2'>
        {CARD_STAT_DEFS.map((d) => (
          <SegButton key={d.key} active={settings.cardStats.includes(d.key)} onClick={() => toggle(d.key)}>
            {d.label}
          </SegButton>
        ))}
      </div>
      <p className='text-[10px] normal-case tracking-normal text-white/40'>
        Pick up to {MAX_CARD_STATS}. This card is shown to a player on their killcam
        when you frag them — your graphic, level, and stats.
      </p>
      </div>
    </div>
  );
}

// The kill banner: an unlockable card graphic + the player's level + their chosen
// stats. Shown on the killcam (the killer's card) and as your own kill-confirm flex.
export function PlayerCard({
  card,
  size = 'normal',
  reduced = false,
}: {
  card: CardPayload;
  size?: 'normal' | 'small';
  reduced?: boolean;
}) {
  const style = cardById(card.style);
  const small = size === 'small';
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-white/15 font-mono shadow-2xl ${
        small ? 'w-[260px] p-3' : 'w-[340px] p-4'
      } ${reduced ? 'reduced-effects' : ''}`}
      style={{ background: style.bg }}
    >
      <div className='absolute inset-0 bg-black/10' />
      {/* Animated motion layer (epic+ cards) — sits over the static gradient,
          under the content; CSS suppresses it under reduced motion/effects. */}
      {style.anim && <div className={`pcard-anim pcard-anim-${style.anim}`} aria-hidden />}
      <div className='relative flex items-center gap-3'>
        <div
          className='flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border'
          style={{ borderColor: style.accent, color: style.accent, background: 'rgba(0,0,0,0.25)' }}
        >
          <span className='text-[7px] uppercase tracking-[0.16em] opacity-80'>Lvl</span>
          <span className='text-lg font-extrabold leading-none'>{card.level}</span>
        </div>
        <div className='min-w-0 flex-1'>
          <div className={`flex items-center gap-1 font-bold text-white ${small ? 'text-sm' : 'text-lg'}`}>
            <span className='truncate'>{card.name}</span>
            <NameBadges admin={card.admin} verified={card.verified} size={small ? 13 : 16} />
          </div>
          {card.title ? (
            <div
              className='truncate text-[10px] font-semibold uppercase tracking-[0.18em]'
              style={{ color: style.accent }}
            >
              {card.title}
            </div>
          ) : (
            <div className='text-[9px] uppercase tracking-[0.2em] text-white/55'>Instagib Arena</div>
          )}
        </div>
      </div>
      {card.stats.length > 0 && (
        <div className='relative mt-3 flex gap-2'>
          {card.stats.map((s, i) => (
            <div
              key={i}
              className='flex flex-1 flex-col items-center rounded-md bg-black/30 px-1 py-1.5'
            >
              <span className='text-base font-extrabold tabular-nums' style={{ color: style.accent }}>
                {s.value}
              </span>
              <span className='text-[8px] uppercase tracking-[0.1em] text-white/55'>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
