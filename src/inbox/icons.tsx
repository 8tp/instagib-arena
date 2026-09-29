// Inline glyphs for the inbox (stroke = currentColor, so the caller tints them).
import type { InboxKind } from '../game/items/types';

type P = { size?: number; className?: string };

export function EnvelopeIcon({ size = 18, className = '' }: P) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className={className}>
      <path d='M3 6.5h18v11H3z' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinejoin='round' />
      <path d='M3.5 7l8.5 6.5L20.5 7' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinejoin='round' />
    </svg>
  );
}

export function GiftIcon({ size = 18, className = '' }: P) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className={className}>
      <path d='M4 11h16v9H4zM3 7.5h18V11H3zM12 7.5V20' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinejoin='round' />
      <path d='M12 7.5C10.5 4 7 3.5 7 5.6 7 7.2 9.6 7.5 12 7.5zM12 7.5c1.5-3.5 5-4 5-1.9 0 1.6-2.6 1.9-5 1.9z' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinejoin='round' />
    </svg>
  );
}

// A key: redeem codes (the ticket glyph already means "free roll").
export function CodeIcon({ size = 18, className = '' }: P) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className={className}>
      <circle cx='8' cy='12' r='4' fill='none' stroke='currentColor' strokeWidth='1.8' />
      <path d='M12 12h9M18 12v3.5M21 12v2.5' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' />
    </svg>
  );
}

// Megaphone: system announcements.
export function SystemIcon({ size = 18, className = '' }: P) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className={className}>
      <path d='M4 10v4h3l8 4.5v-13L7 10z' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinejoin='round' />
      <path d='M18 9.5a3.5 3.5 0 0 1 0 5M7.5 14.5l1.2 4.5' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' />
    </svg>
  );
}

export function KindIcon({ kind, size }: { kind: InboxKind; size?: number }) {
  if (kind === 'gift') return <GiftIcon size={size} />;
  if (kind === 'code') return <CodeIcon size={size} />;
  return <SystemIcon size={size} />;
}
