import { type ReactNode } from 'react';
import { sfxProps } from '../deck-core';

// Main-menu building blocks. Game-menu grammar over the live arena: one big
// wordmark, one solid Play block, a vertical list of big display-type items
// (accent bar + quiet qualifier on hover/focus, no hover-lift), and quiet text
// links for the meta surfaces. Styling lives in index.css (.menu-*).

export type MenuAccent = 'cyan' | 'fuchsia' | 'amber' | 'emerald' | 'plain';

export function MenuWordmark({ as = 'h1' }: { as?: 'h1' | 'div' }) {
  const Tag = as;
  return (
    <Tag className='menu-wordmark select-none'>
      <span className='menu-wordmark-main'>Instagib</span>
      <span className='menu-wordmark-sub'>
        <span aria-hidden='true' className='menu-beam' />
        <span>Arena</span>
      </span>
    </Tag>
  );
}

// The one primary action. Solid, heavy, wide. `sub` rides the right edge;
// `busy` swaps in the search sweep.
export function MenuPlayButton({
  onClick,
  disabled,
  busy,
  label = 'Play',
  sub,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  sub: string;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      {...sfxProps('uiConfirm')}
      className='menu-play clip-deck'
    >
      <span className='menu-play-label'>{label}</span>
      <span className='menu-play-sub'>{sub}</span>
      {busy && <span aria-hidden='true' className='menu-play-sweep' />}
    </button>
  );
}

export function MenuItem({
  onClick,
  disabled,
  accent = 'plain',
  sub,
  badge,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  accent?: MenuAccent;
  sub?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      data-accent={accent}
      {...sfxProps('uiClick')}
      className='menu-item'
    >
      <span className='menu-item-label'>{children}</span>
      {badge}
      {sub && <span className='menu-item-sub'>{sub}</span>}
    </button>
  );
}

// Quiet meta link (Stats / Locker / Settings …).
export function MenuLink({
  onClick,
  children,
  badge,
}: {
  onClick: () => void;
  children: ReactNode;
  badge?: number;
}) {
  return (
    <button type='button' onClick={onClick} {...sfxProps('uiClick')} className='menu-link'>
      {children}
      {badge != null && badge > 0 && (
        <span className='menu-link-badge' title={`${badge} reward${badge > 1 ? 's' : ''} ready to claim`}>
          {badge}
        </span>
      )}
    </button>
  );
}

export type DockTabId = 'lobbies' | 'chat' | 'online';

// The social column, demoted: one panel, three tabs, collapsible. The body is
// supplied by the lobby (it owns the sockets and the data).
export function SocialDock({
  open,
  onToggle,
  tab,
  onTab,
  lobbies,
  online,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  tab: DockTabId;
  onTab: (t: DockTabId) => void;
  lobbies: number;
  online: number | null;
  children: ReactNode;
}) {
  const tabs: { id: DockTabId; label: string; count?: number | null }[] = [
    { id: 'lobbies', label: 'Lobbies', count: lobbies },
    { id: 'chat', label: 'Chat' },
    { id: 'online', label: 'Online', count: online },
  ];
  if (!open) return null;
  return (
    <aside aria-label='Lobbies and chat' className='menu-dock clip-deck'>
      <div className='flex shrink-0 items-center justify-between border-b border-white/10 pl-2 pr-3'>
        <div role='tablist' aria-label='Social' className='flex'>
          {tabs.map((t) => (
            <button
              key={t.id}
              type='button'
              role='tab'
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
              {...sfxProps('uiClick')}
              className='deck-tab'
            >
              {t.label}
              {t.count != null && t.count > 0 && <span className='ml-1.5 tabular-nums text-white/40'>{t.count}</span>}
            </button>
          ))}
        </div>
        <button
          type='button'
          onClick={onToggle}
          aria-expanded={open}
          {...sfxProps('uiBack')}
          className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/40 transition hover:text-white/80'
        >
          Hide
        </button>
      </div>
      <div role='tabpanel' className='flex min-h-0 flex-1 flex-col'>
        {children}
      </div>
    </aside>
  );
}
