import { memo } from 'react';
import type { KillfeedEntry } from '../../game/types';
import { hudTiming, useExitList } from '../../hud-store';
import { HUD_EXIT_LEAD_MS, HUD_EXIT_MS } from '../hud-const';

// The killfeed: one glass chip per kill, top-right. Each chip slides in from
// the right, holds, and fades on a pre-scheduled CSS delay (see hudTiming), so
// there are no React updates between mount and unmount. `leaving` plays the
// fade now when the engine dropped the row early (feed cap / reset).

// The weapon glyph between killer and victim: a rail beam with a hot core.
function RailGlyph() {
  return (
    <svg width='28' height='10' viewBox='0 0 28 10' aria-label='railed' className='hud-kf-glyph shrink-0'>
      <line x1='1' y1='5' x2='21' y2='5' stroke='currentColor' strokeWidth='2.6' strokeLinecap='round' opacity='0.55' />
      <line x1='1' y1='5' x2='21' y2='5' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' />
      <line x1='4' y1='5' x2='21' y2='5' stroke='#fff' strokeWidth='0.8' strokeLinecap='round' />
      <path d='M21 1.5 L27 5 L21 8.5 Z' fill='currentColor' />
    </svg>
  );
}

// Headshot: a reticle. Mid-air: upward chevrons.
function SpecialIcon({ kind }: { kind: 'headshot' | 'mid-air' }) {
  return kind === 'headshot' ? (
    <svg width='12' height='12' viewBox='0 0 12 12' aria-hidden='true'>
      <circle cx='6' cy='6' r='4.2' fill='none' stroke='currentColor' strokeWidth='1.3' />
      <circle cx='6' cy='6' r='1.1' fill='currentColor' />
      <path d='M6 0v2.4M6 9.6V12M0 6h2.4M9.6 6H12' stroke='currentColor' strokeWidth='1.3' />
    </svg>
  ) : (
    <svg width='12' height='12' viewBox='0 0 12 12' aria-hidden='true'>
      <path d='M2 6.5L6 2.5l4 4M2 10.5L6 6.5l4 4' fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinejoin='round' />
    </svg>
  );
}

export const Killfeed = memo(function Killfeed({
  entries,
  localName,
}: {
  entries: KillfeedEntry[];
  localName?: string;
}) {
  const rows = useExitList(entries, { exitMs: HUD_EXIT_MS, leadMs: HUD_EXIT_LEAD_MS });
  return (
    <div className='absolute right-5 top-5 flex w-[24rem] flex-col items-end gap-1'>
      {rows.map(({ item, leaving }) => (
        <KillfeedRow
          key={item.id}
          entry={item}
          leaving={leaving}
          victimLocal={!!localName && !item.killerLocal && item.victim === localName}
        />
      ))}
    </div>
  );
});

const KillfeedRow = memo(function KillfeedRow({
  entry,
  leaving,
  victimLocal,
}: {
  entry: KillfeedEntry;
  leaving: boolean;
  victimLocal: boolean;
}) {
  const tone = entry.killerLocal ? ' hud-kf-you' : victimLocal ? ' hud-kf-died' : '';
  const special = entry.special;
  return (
    <div
      className={`hud-chip hud-panel hud-kf${tone}${special ? ` hud-kf-${special}` : ''}${leaving ? ' hud-leaving' : ''}`}
      style={hudTiming(entry.remaining, entry.total, HUD_EXIT_LEAD_MS)}
    >
      <span className={`hud-kf-name${entry.killerLocal ? ' hud-kf-self' : ''}`}>{entry.killer}</span>
      <RailGlyph />
      <span className={`hud-kf-name ${victimLocal ? 'hud-kf-self-dead' : 'hud-kf-victim'}`}>{entry.victim}</span>
      {special && (
        <span className={`hud-kf-tag ${special === 'headshot' ? 'hud-kf-tag-hs' : 'hud-kf-tag-air'}`}>
          <SpecialIcon kind={special} />
          {special === 'headshot' ? 'HS' : 'AIR'}
        </span>
      )}
    </div>
  );
});
