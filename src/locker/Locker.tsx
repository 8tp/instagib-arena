// The Locker is the economy hub (docs/economy.md): a full-screen shell with
// four tabs — Inventory (the 3D loadout + your item instances), Cases (the
// reel, published odds), Market (fixed-price listings) and Trades (direct
// offers). One shared economy state feeds all four; the server is the only
// authority (equip / open / list / buy / trade are all round-trips).
import './locker.css';
import '../economy/economy.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { MODAL_EXIT_MS, prefersReducedMotion, sfxProps, toast, uiSfx, useModalStack } from '../deck-core';
import { Skeleton } from '../deck';
import { mockOn } from '../economy/api';
import { CasesTab } from '../economy/CasesTab';
import { instSlot, instFullName } from '../economy/display';
import { InventoryTab } from '../economy/InventoryTab';
import { MarketTab } from '../economy/MarketTab';
import { Balance } from '../economy/parts';
import { TradesTab } from '../economy/TradesTab';
import { useEconomy } from '../economy/useEconomy';

export type LockerTab = 'inventory' | 'cases' | 'market' | 'trades';
const TABS: { id: LockerTab; label: string }[] = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'cases', label: 'Cases' },
  { id: 'market', label: 'Market' },
  { id: 'trades', label: 'Trades' },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useNarrow(): boolean {
  const q = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Locker({
  settings,
  onChange,
  onClose,
  account,
  initialTab,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  account?: Account;
  initialTab?: LockerTab;
}) {
  const reduced = settings.reducedEffects || prefersReducedMotion();
  const narrow = useNarrow();
  const mock = mockOn();
  const loggedIn = !!account || mock;
  const [tab, setTabState] = useState<LockerTab>(initialTab ?? 'inventory');
  const [closing, setClosing] = useState(false);
  const [sellUid, setSellUid] = useState<string | null>(null);
  const [offerUid, setOfferUid] = useState<string | null>(null);
  const [profile, setProfile] = useState<InstagibProfile | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const econ = useEconomy(settings, onChange, loggedIn);

  // Level + stats (card collection, trade gates, card showcase).
  useEffect(() => {
    if (!account) return;
    let live = true;
    void fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: InstagibProfile } | null) => {
        if (live && d?.profile) setProfile(d.profile);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account]);
  const shownProfile = profile ?? (mock ? ({ level: Number(new URLSearchParams(window.location.search).get('mockLevel')) || 12 } as InstagibProfile) : null);

  const setTab = useCallback((t: LockerTab) => {
    uiSfx('tabSwitch');
    setTabState(t);
  }, []);

  // ── Shell: Esc, focus trap, enter/exit ───────────────────────────────────
  const isTop = useModalStack();
  const close = useCallback(() => {
    if (closing) return;
    uiSfx('uiBack');
    if (reduced) {
      onClose();
      return;
    }
    setClosing(true);
    window.setTimeout(onClose, MODAL_EXIT_MS);
  }, [closing, reduced, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (!e.defaultPrevented) {
          e.preventDefault();
          close();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const els = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const a = document.activeElement;
      const inside = a instanceof Node && root.contains(a);
      if (e.shiftKey ? !inside || a === first : !inside || a === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, close]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  const loading = econ.status === 'loading';
  const node = (
    <div
      ref={rootRef}
      role='dialog'
      aria-modal='true'
      aria-label='Locker'
      data-tab={tab}
      data-economy={econ.status}
      tabIndex={-1}
      className={`lk-root ec-root ${closing ? 'lk-exit' : 'lk-enter'} ${reduced ? 'lk-reduced' : ''}`}
    >
      <header className='lk-top ec-top'>
        <div className='flex min-w-0 items-center gap-3'>
          <h2 className='lk-title'>Locker</h2>
          <span className='lk-info' tabIndex={0} role='note' aria-label='Cosmetic only. Nothing here affects aim, movement or hits.'>
            <span aria-hidden>i</span>
            <span className='lk-info-tip' aria-hidden>
              Cosmetic only. Nothing here affects aim, movement or hits. Credits are earned by playing — never bought.
            </span>
          </span>
        </div>
        <nav className='ec-tabs' role='tablist' aria-label='Locker sections'>
          {TABS.map((t) => (
            <button
              key={t.id}
              type='button'
              role='tab'
              aria-selected={tab === t.id}
              data-tab-id={t.id}
              className={`ec-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
              {...sfxProps('none')}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className='ml-auto flex items-center gap-4'>
          {loading ? <Skeleton className='h-5 w-24' /> : <Balance credits={econ.status === 'ready' ? econ.credits : null} freeRolls={econ.status === 'ready' ? econ.freeRolls : null} compact={narrow} />}
          <button type='button' className='lk-close' onClick={close} aria-label='Close the Locker' {...sfxProps('none')}>
            ✕ ESC
          </button>
        </div>
      </header>

      {tab === 'inventory' && (
        <InventoryTab
          settings={settings}
          onChange={onChange}
          econ={econ}
          account={account}
          profile={shownProfile}
          narrow={narrow}
          reduced={reduced}
          onSell={(uid) => {
            setSellUid(uid);
            setTabState('market');
          }}
          onTrade={(uid) => {
            setOfferUid(uid);
            setTabState('trades');
          }}
          onViewListings={() => setTab('market')}
        />
      )}
      {tab === 'cases' && (
        <CasesTab
          econ={econ}
          loggedIn={loggedIn}
          reduced={reduced}
          onEquipItem={(item) => {
            void econ.equip(instSlot(item), item.uid).then((ok) => ok && toast(`Equipped · ${instFullName(item)}`, { tone: 'ok', sound: 'equip' }));
          }}
        />
      )}
      {tab === 'market' && <MarketTab econ={econ} loggedIn={loggedIn} sellUid={sellUid} clearSell={() => setSellUid(null)} myName={mock ? 'MockPlayer' : (account?.username ?? '')} />}
      {tab === 'trades' && (
        <TradesTab econ={econ} loggedIn={loggedIn} offerUid={offerUid} clearOffer={() => setOfferUid(null)} myName={mock ? 'MockPlayer' : (account?.username ?? '')} />
      )}
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
