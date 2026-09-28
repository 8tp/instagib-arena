import type { CSSProperties } from 'react';
import './menu.css';

// Shared progression primitives — ONE look on every surface:
//  - LevelEmblem: the clipped cyan badge with the level numeral (the menu
//    profile's badge is the reference; the road header, the road track and the
//    rewards screen should all use this).
//  - XpBar: the segmented bar (ten notches), as on the end-of-match rewards.
//  - Credits: "⛁ 1,234" — the glyph always leads.

export function LevelEmblem({
  level,
  size = 56,
  tone = 'you',
  label = true,
}: {
  level: number | string;
  size?: number;
  tone?: 'you' | 'guest' | 'locked';
  label?: boolean; // the small "Lv" caption (hidden below ~44 px)
}) {
  const style = { width: size, height: size, ['--emb' as string]: `${size}px` } as CSSProperties;
  return (
    <span className='menu-emblem' data-tone={tone} style={style} aria-hidden='true'>
      {label && size >= 44 && <span className='menu-emblem-cap'>Lv</span>}
      <span className='menu-emblem-num'>{level}</span>
    </span>
  );
}

export function XpBar({
  frac,
  height = 10,
  className = '',
  label,
}: {
  frac: number; // 0..1
  height?: number;
  className?: string;
  label?: string;
}) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <div
      className={`menu-xpbar ${className}`}
      style={{ height }}
      role='progressbar'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
      aria-label={label ?? 'Progress to next level'}
    >
      <span className='menu-xpbar-fill' style={{ transform: `scaleX(${f})` }} />
      <span className='menu-xpbar-notch' />
    </div>
  );
}

export function Credits({ amount, sign = false, className = '' }: { amount: number; sign?: boolean; className?: string }) {
  return (
    <span className={`menu-credits ${className}`}>
      <span aria-hidden='true' className='menu-credits-glyph'>
        ⛁
      </span>
      {sign && amount > 0 ? '+' : ''}
      {amount.toLocaleString()}
      <span className='sr-only'> credits</span>
    </span>
  );
}
