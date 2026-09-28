import { useEffect, useRef, useState } from 'react';
import { sfxProps, uiSfx } from '../deck-core';
import './menu.css';

// Small account menu in the top bar (replaces the loose "Log out" text):
// Stats · Settings · Admin (staff) · Log out. A plain disclosure: Tab moves
// through its buttons, Esc or a click outside closes it.
export function AccountMenu({
  isAdmin,
  onStats,
  onSettings,
  onAdmin,
  onLogout,
}: {
  isAdmin: boolean;
  onStats: () => void;
  onSettings: () => void;
  onAdmin: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    uiSfx('uiClick');
    setOpen(false);
    fn();
  };

  return (
    <div ref={rootRef} className='menu-acct'>
      <button
        ref={btnRef}
        type='button'
        aria-controls='menu-account-pop'
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        {...sfxProps('uiToggle')}
        className='menu-acct-btn'
      >
        Account
        <svg width={10} height={10} viewBox='0 0 10 10' aria-hidden='true'>
          <path d='M1 3l4 4 4-4' fill='none' stroke='currentColor' strokeWidth='1.8' />
        </svg>
      </button>
      {open && (
        <div id='menu-account-pop' aria-label='Account' className='menu-acct-pop'>
          <button type='button' onClick={run(onStats)}>
            Stats
          </button>
          <button type='button' onClick={run(onSettings)}>
            Settings
          </button>
          {isAdmin && (
            <button type='button' onClick={run(onAdmin)} className='text-amber-200'>
              Admin
            </button>
          )}
          <hr />
          <button type='button' onClick={run(onLogout)}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
