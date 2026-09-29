// Case art: an isometric crate per case (lit top, shaded sides, lid band, an
// emblem on the front face and a glow pool underneath), tinted by the case hue.
// Pure SVG — no per-frame work; the float is a CSS animation on the wrapper.
// `seam` adds the unboxing layer: a light seam along the lid's lower edge in
// the case hue, which the reveal's anticipation beat brightens as the crate
// cracks. The lid is its own group (.ec-lid) so CSS can lift and jitter it.
import { useId } from 'react';
import type { CaseId } from '../game/items/types';

const EMBLEM: Record<CaseId, string> = {
  // top hat
  hat: 'M-13 6h26M-8 6V-8h16V6M-6 -3h12',
  // railgun
  weapon: 'M-15 3h20l4-3h6M-9 3v6M-3 3l2 5M-15 3v-4h14',
  // visor + strap
  accessory: 'M-14 -2h28v6h-8l-3-3h-6l-3 3h-8zM-14 1h-2M14 1h2',
  // star
  taunt: 'M0 -11l3.2 6.8 7.4 1-5.4 5.1 1.4 7.4L0 5.7l-6.6 3.6 1.4-7.4-5.4-5.1 7.4-1z',
  // vault dial
  vault: 'M0 -11a11 11 0 1 0 .01 0zM0 -5v10M-5 0h10',
};

export function CrateArt({ id, a, b, size = 88, seam = false }: { id: CaseId; a: string; b: string; size?: number; seam?: boolean }) {
  const u = useId().replace(/:/g, '');
  const premium = id === 'vault';
  return (
    <svg width={size} height={size} viewBox='0 0 100 100' aria-hidden='true' className='ec-crate-svg' overflow='visible'>
      <defs>
        <linearGradient id={`t${u}`} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor={premium ? '#ffd0f5' : a} />
          <stop offset='1' stopColor={premium ? '#8f7bff' : b} />
        </linearGradient>
        <linearGradient id={`l${u}`} x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor={a} stopOpacity='0.9' />
          <stop offset='1' stopColor={b} />
        </linearGradient>
        <linearGradient id={`r${u}`} x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor={b} />
          <stop offset='1' stopColor='#05070b' />
        </linearGradient>
        <radialGradient id={`g${u}`} cx='50%' cy='50%' r='50%'>
          <stop offset='0' stopColor={a} stopOpacity='0.55' />
          <stop offset='1' stopColor={a} stopOpacity='0' />
        </radialGradient>
      </defs>
      <ellipse cx='50' cy='90' rx='42' ry='9' fill={`url(#g${u})`} />
      {/* the body: left (front) + right faces */}
      <path d='M14 43 50 59v31L14 74z' fill={`url(#l${u})`} />
      <path d='M86 43 50 59v31l36-16z' fill={`url(#r${u})`} />
      <path d='M14 43v31l36 16 36-16V43M50 59v31' fill='none' stroke='#fff' strokeOpacity='0.35' strokeWidth='1' />
      {/* emblem on the front face */}
      <g transform='translate(31 64) skewY(24)' stroke='#fff' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' fill={id === 'taunt' ? '#fff' : 'none'} opacity='0.95'>
        <path d={EMBLEM[id]} transform='scale(0.62)' />
      </g>
      {seam && (
        // Light leaking out of the crack between lid and body.
        <g className='ec-seam'>
          <path d='M14 43 50 59l36-16' fill='none' stroke={a} strokeWidth='8' strokeLinejoin='round' strokeLinecap='round' opacity='0.6' />
          <path d='M14 43 50 59l36-16' fill='none' stroke='#fff' strokeWidth='2.4' strokeLinejoin='round' strokeLinecap='round' />
        </g>
      )}
      {/* the lid: band + top face + latch + sparkle */}
      <g className='ec-lid'>
        <path d='M14 34 50 50v9L14 43z' fill={`url(#l${u})`} />
        <path d='M86 34 50 50v9l36-16z' fill={`url(#r${u})`} />
        <path d='M14 34 50 50l36-16v9L50 59 14 43z' fill='#000' opacity='0.28' />
        <path d='M14 34 50 18l36 16-36 16z' fill={`url(#t${u})`} />
        <path d='M45 52.5 50 55l5-2.5v9l-5 2.5-5-2.5z' fill='#ffe9a8' />
        <path d='M14 34 50 18l36 16-36 16zM14 34v9l36 16 36-16v-9M50 50v9' fill='none' stroke='#fff' strokeOpacity='0.35' strokeWidth='1' />
        <path d='M50 18 50 8M44 12l6-4 6 4' stroke={a} strokeWidth='1.6' fill='none' opacity='0.8' strokeLinecap='round' />
      </g>
    </svg>
  );
}
