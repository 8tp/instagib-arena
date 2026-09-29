// The envelope in the menu's top bar (logged-in players): a badge with what's
// waiting (unread messages / gifts to claim) that opens the Inbox. The count is
// the cheap `?summary=1` read — on mount, every couple of minutes while the
// menu is up, whenever `refreshKey` changes (a modal closed), and live from the
// panel while it's open.
import { useCallback, useEffect, useState } from 'react';
import { sfxProps } from '../deck-core';
import { econ, mockOn, type InboxSummary } from '../economy/api';
import { EnvelopeIcon } from './icons';
import { InboxPanel } from './InboxPanel';
import './inbox.css';

const POLL_MS = 120_000;

// Logged-in players only (or the ?mockEconomy=1 dev mock).
export function InboxButton({ loggedIn, ...rest }: { loggedIn: boolean } & Parameters<typeof InboxButtonInner>[0]) {
  if (!loggedIn && !mockOn()) return null;
  // The mock's guest profile has no real balance — let the panel learn it from a grant.
  return <InboxButtonInner {...rest} credits={loggedIn ? rest.credits : null} />;
}

function InboxButtonInner({
  reduced,
  lowSpec,
  credits,
  refreshKey = 0,
  onGranted,
}: {
  reduced: boolean;
  lowSpec: boolean;
  credits?: number | null;
  refreshKey?: number;
  onGranted?: () => void;
}) {
  const [sum, setSum] = useState<InboxSummary | null>(null);
  const [open, setOpen] = useState(false);

  const pull = useCallback(async () => {
    const r = await econ.inboxSummary();
    if (r.ok) setSum({ unread: r.unread ?? 0, unclaimed: r.unclaimed ?? 0 });
  }, []);

  useEffect(() => {
    void pull();
  }, [pull, refreshKey]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pull();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [pull]);

  const unread = sum?.unread ?? 0;
  const gifts = sum?.unclaimed ?? 0;
  const count = Math.max(unread, gifts);
  const label = ['Inbox', unread ? `${unread} unread` : '', gifts ? `${gifts} gift${gifts === 1 ? '' : 's'} to claim` : ''].filter(Boolean).join(', ');

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        {...sfxProps('uiClick')}
        aria-label={label}
        title={label}
        className={`menu-inbox-btn ${gifts ? 'has-gift' : count ? 'has-unread' : ''}`}
        data-action='open-inbox'
      >
        <EnvelopeIcon size={18} />
        <span className='menu-inbox-text'>Inbox</span>
        {count > 0 && (
          <span className='menu-inbox-badge' aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <InboxPanel
          onClose={() => {
            setOpen(false);
            void pull();
          }}
          reduced={reduced}
          lowSpec={lowSpec}
          balance={credits != null ? { credits } : undefined}
          onSummary={setSum}
          onGranted={onGranted}
        />
      )}
    </>
  );
}
