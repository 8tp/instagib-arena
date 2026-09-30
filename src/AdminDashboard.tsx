// Instagib Ops — the admin console (/admin). A sticky header with live
// telemetry and two tab groups: OBSERVE (read-only metrics) and OPERATE (tabs
// that change accounts: items, codes, gifts, feedback moderation). Gated on
// isAdmin here (UX) and server-side (every /api/admin/* route runs
// requireAdmin). Tabs live in src/admin/*; styles in src/admin/admin.css.
import './admin/admin.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { AdminItemsTab } from './economy/AdminItems';
import { AdminGrantTab } from './economy/AdminGrant';
import { AdminCodesTab } from './admin/AdminCodes';
import { AdminGiftsTab } from './admin/AdminGifts';
import { getJSON, type LiveCounts } from './admin/api';
import { EconomyTab, EngagementTab, OverviewTab, RetentionTab } from './admin/tabs-metrics';
import { FeedbackTab, MatchesTab, PlayersTab } from './admin/tabs-tables';
import { fmt } from './admin/format';
import { Seg } from './admin/ui';

type Tab = 'overview' | 'engagement' | 'economy' | 'retention' | 'matches' | 'players' | 'items' | 'grant' | 'codes' | 'gifts' | 'feedback';
const GROUPS: { label: string; tabs: { id: Tab; label: string }[] }[] = [
  {
    label: 'Observe',
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'engagement', label: 'Engagement' },
      { id: 'economy', label: 'Economy' },
      { id: 'retention', label: 'Retention' },
      { id: 'matches', label: 'Matches' },
      { id: 'players', label: 'Players' },
    ],
  },
  {
    label: 'Operate',
    tabs: [
      { id: 'items', label: 'Items' },
      { id: 'grant', label: 'Grant' },
      { id: 'codes', label: 'Codes' },
      { id: 'gifts', label: 'Gifts' },
      { id: 'feedback', label: 'Feedback' },
    ],
  },
];
const ALL_TABS = GROUPS.flatMap((g) => g.tabs.map((t) => t.id));
const RANGED: ReadonlySet<Tab> = new Set(['overview', 'engagement', 'economy']);

// #tab or #tab/player — survives reloads and lets Players deep-link.
function readHash(): { tab: Tab; player?: string } {
  const [t, p] = window.location.hash.replace(/^#/, '').split('/');
  const tab = (ALL_TABS as string[]).includes(t) ? (t as Tab) : 'overview';
  return { tab, player: p ? decodeURIComponent(p) : undefined };
}

export default function AdminDashboard() {
  const auth = useAuth();
  const [{ tab, player }, setRoute] = useState(readHash);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [live, setLive] = useState<LiveCounts | null>(null);
  const [openFeedback, setOpenFeedback] = useState<number | null>(null);
  const isAdmin = !!auth.account?.isAdmin;
  // The console is its own scroll container: the game shell locks body
  // scrolling (index.css `body { overflow: hidden }`), so the window never scrolls.
  const scroller = useRef<HTMLDivElement>(null);

  const go = useCallback((t: Tab, p?: string) => {
    const h = `#${t}${p ? `/${encodeURIComponent(p)}` : ''}`;
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
    setRoute({ tab: t, player: p });
    scroller.current?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    const pull = () => {
      void getJSON<LiveCounts>('/api/live').then((r) => active && r.ok && setLive(r.data));
    };
    pull();
    const t = setInterval(pull, 15_000);
    void getJSON<{ counts: Record<string, number> }>('/api/admin/metrics/feedback?limit=1').then((r) => active && r.ok && setOpenFeedback(r.data.counts.open ?? 0));
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [isAdmin]);

  if (!auth.ready) return <Centered>Loading…</Centered>;
  if (!auth.account || !isAdmin) {
    return (
      <Centered>
        <div className='flex flex-col items-center gap-3 text-center'>
          <span className='adm-mark'>
            Instagib <b>Ops</b>
          </span>
          <p className='text-[var(--adm-ink-2)]'>{auth.account ? 'This console is for staff accounts.' : 'Sign in with a staff account to use the console.'}</p>
          <a href='/play' className='adm-btn'>
            ← Back to the arena
          </a>
        </div>
      </Centered>
    );
  }

  return (
    <div className='adm adm-scroller' ref={scroller}>
      <header className='adm-head'>
        <div className='mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 pt-3'>
          <div className='flex items-center gap-4'>
            <a href='/play' className='adm-mark' title='Back to the arena'>
              Instagib <b>Ops</b>
            </a>
            <span className='adm-telemetry' aria-live='polite'>
              <span className='adm-pulse' data-off={live ? undefined : ''} aria-hidden />
              <span>
                <strong>{live ? fmt(live.online) : '—'}</strong> online
              </span>
              <span>
                <strong>{live ? fmt(live.inMatch) : '—'}</strong> in match
              </span>
              <span>
                <strong>{live ? fmt(live.rooms) : '—'}</strong> rooms
              </span>
            </span>
          </div>
          <div className='flex items-center gap-3 text-[12px] text-[var(--adm-ink-3)]'>
            <span>
              Signed in as <span className='text-[var(--adm-ink-2)]'>{auth.account.username}</span>
            </span>
            <a href='/play' className='adm-btn sm'>
              Arena
            </a>
          </div>
        </div>
        <div className='mx-auto flex max-w-[1440px] items-end justify-between gap-4 px-6'>
          <TabRail tab={tab} onPick={(t) => go(t)} badge={{ feedback: openFeedback ?? 0 }} />
          {RANGED.has(tab) && (
            <div className='hidden shrink-0 pb-2 xl:block'>
              <Seg
                label='Date range'
                value={String(days) as '7' | '30' | '90'}
                onChange={(v) => setDays(Number(v) as 7 | 30 | 90)}
                options={[
                  { id: '7', label: '7d' },
                  { id: '30', label: '30d' },
                  { id: '90', label: '90d' },
                ]}
              />
            </div>
          )}
        </div>
      </header>

      <main className='mx-auto max-w-[1440px] px-6 py-6' id={`panel-${tab}`} role='tabpanel' aria-labelledby={`tab-${tab}`}>
        {RANGED.has(tab) && (
          <div className='mb-4 flex justify-end xl:hidden'>
            <Seg
              label='Date range'
              value={String(days) as '7' | '30' | '90'}
              onChange={(v) => setDays(Number(v) as 7 | 30 | 90)}
              options={[
                { id: '7', label: '7d' },
                { id: '30', label: '30d' },
                { id: '90', label: '90d' },
              ]}
            />
          </div>
        )}
        {tab === 'overview' && <OverviewTab days={days} live={live} onOpen={(t) => go(t)} />}
        {tab === 'engagement' && <EngagementTab days={days} />}
        {tab === 'economy' && <EconomyTab days={days} />}
        {tab === 'retention' && <RetentionTab />}
        {tab === 'matches' && <MatchesTab />}
        {tab === 'players' && <PlayersTab onOpen={(t, p) => go(t, p)} />}
        {tab === 'items' && <AdminItemsTab key={player ?? ''} initialPlayer={player} onGrant={(p) => go('grant', p)} />}
        {tab === 'grant' && <AdminGrantTab key={player ?? ''} initialPlayer={player} onInventory={(p) => go('items', p)} />}
        {tab === 'codes' && <AdminCodesTab />}
        {tab === 'gifts' && <AdminGiftsTab key={player ?? ''} initialPlayer={player} />}
        {tab === 'feedback' && <FeedbackTab onCounts={setOpenFeedback} />}
      </main>
    </div>
  );
}

// Grouped tabs with the sliding rail under the active one.
function TabRail({ tab, onPick, badge }: { tab: Tab; onPick: (t: Tab) => void; badge: Partial<Record<Tab, number>> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = wrap.current?.querySelector<HTMLElement>(`[data-tab='${tab}']`);
      const root = wrap.current;
      if (!el || !root) return;
      const a = el.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      setRail({ x: a.left - b.left + root.scrollLeft + 10, w: a.width - 20 });
    };
    place();
    const ro = new ResizeObserver(place);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [tab, badge.feedback]);
  const onKey = (e: React.KeyboardEvent) => {
    const i = ALL_TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? ALL_TABS[(i + 1) % ALL_TABS.length] : e.key === 'ArrowLeft' ? ALL_TABS[(i - 1 + ALL_TABS.length) % ALL_TABS.length] : null;
    if (!next) return;
    e.preventDefault();
    onPick(next);
    wrap.current?.querySelector<HTMLElement>(`[data-tab='${next}']`)?.focus();
  };
  return (
    <div ref={wrap} className='adm-tabs min-w-0' role='tablist' aria-label='Console sections' onKeyDown={onKey}>
      {GROUPS.map((g) => (
        <div key={g.label} className='adm-tabgroup' role='presentation'>
          <span className='adm-tabgroup-label' aria-hidden>
            {g.label}
          </span>
          {g.tabs.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type='button'
              role='tab'
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className='adm-tab'
              onClick={() => onPick(t.id)}
              data-tab={t.id}
            >
              {t.label}
              {!!badge[t.id] && <span className='adm-tab-count'>{badge[t.id]}</span>}
            </button>
          ))}
        </div>
      ))}
      {rail && <span className='adm-rail' style={{ left: 0, width: rail.w, transform: `translateX(${rail.x}px)` }} aria-hidden />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className='adm flex min-h-screen items-center justify-center text-sm'>{children}</div>;
}
