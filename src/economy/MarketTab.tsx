// Market: fixed-price listings. Browse (filters + sort), Sell (list one of
// your tradable items: floor, suggested price, fee / tax breakdown, net) and
// My listings (unlist). Buying is confirmed; the server does the transaction.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell, SegButton, Skeleton } from '../deck';
import { sfxProps, toast } from '../deck-core';
import { ITEM_SLOTS, MARKET, TIERS, UNUSUAL_EFFECTS, type ItemInstanceWire, type ItemSlot, type Quality, type Tier } from '../game/items/types';
import { TIER_COLOR, TIER_LABEL } from '../ui/rarity';
import { econ as api, reasonText, type HistoryResp, type Listing, type MarketQuery, type MarketResp } from './api';
import {
  SLOT_LABEL,
  fmtCredits,
  instBaseName,
  instBlurb,
  instFullName,
  instSlot,
  instTags,
  instTier,
  listingFee,
  marketFloor,
  saleNet,
  saleTax,
  timeAgo,
} from './display';
import { GateBanner, InstTile, Sparkline, TagPills, TierChip } from './parts';
import { useTradeGate } from './useTradeGate';
import type { Econ } from './useEconomy';

type Sub = 'browse' | 'sell' | 'mine';

export function MarketTab({
  econ,
  loggedIn,
  sellUid,
  clearSell,
  myName,
}: {
  econ: Econ;
  loggedIn: boolean;
  sellUid: string | null;
  clearSell: () => void;
  myName: string;
}) {
  const [sub, setSub] = useState<Sub>(sellUid ? 'sell' : 'browse');
  const [sellItem, setSellItem] = useState<ItemInstanceWire | null>(null);
  const [mineTick, setMineTick] = useState(0);
  const gate = useTradeGate(loggedIn);
  const locked = !!gate && !gate.ok;

  // Arriving from an inventory item's "List on market".
  useEffect(() => {
    if (!sellUid) return;
    const it = econ.items.find((i) => i.uid === sellUid);
    if (it) {
      setSub('sell');
      setSellItem(it);
    }
    clearSell();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellUid]);

  return (
    <div className='ec-page deck-scroll'>
      <div className='ec-page-in'>
        <div className='ec-subtabs' role='tablist' aria-label='Market'>
          {(['browse', 'sell', 'mine'] as const).map((s) => (
            <SegButton key={s} active={sub === s} onClick={() => setSub(s)} role='tab' aria-selected={sub === s} data-sub={s}>
              {s === 'browse' ? 'Browse' : s === 'sell' ? 'Sell' : 'My listings'}
            </SegButton>
          ))}
          <span className='ml-auto font-sans text-[12.5px] text-white/45'>
            Listing fee {MARKET.listingFeePct * 100}% · sale tax {MARKET.saleTaxPct * 100}% · escrowed while listed
          </span>
        </div>
        <GateBanner gate={gate} />
        {sub === 'browse' && <Browse econ={econ} loggedIn={loggedIn} myName={myName} locked={locked} />}
        {sub === 'sell' && <SellPicker econ={econ} loggedIn={loggedIn} onPick={setSellItem} />}
        {sub === 'mine' && <MyListings key={mineTick} econ={econ} />}
      </div>
      {sellItem && (
        <SellDialog
          inst={sellItem}
          econ={econ}
          locked={locked}
          onClose={() => setSellItem(null)}
          onListed={() => {
            setSellItem(null);
            setMineTick((k) => k + 1);
            setSub('mine');
          }}
        />
      )}
    </div>
  );
}

// ── Browse ──────────────────────────────────────────────────────────────────

const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'unusual', label: 'Anomalous' },
  { id: 'strange', label: 'Tracked' },
  { id: 'killstreak', label: 'Killstreak' },
  { id: 'professional', label: 'Professional' },
  { id: 'festive', label: 'Festive' },
];

function Browse({ econ, loggedIn, myName, locked }: { econ: Econ; loggedIn: boolean; myName: string; locked: boolean }) {
  const [f, setF] = useState<MarketQuery>({ sort: 'newest', page: 0 });
  const [text, setText] = useState('');
  const [data, setData] = useState<MarketResp | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<Listing | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (q: MarketQuery) => {
    const n = ++seq.current;
    setErr(false);
    const r = await api.market(q);
    if (n !== seq.current) return;
    if (r.ok) setData(r);
    else setErr(true);
  }, []);
  useEffect(() => {
    void load(f);
  }, [f, load]);
  // Debounced text search.
  useEffect(() => {
    const t = window.setTimeout(() => setF((p) => (p.q === text ? p : { ...p, q: text, page: 0 })), 260);
    return () => window.clearTimeout(t);
  }, [text]);

  const set = (patch: Partial<MarketQuery>) => setF((p) => ({ ...p, ...patch, page: patch.page ?? 0 }));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className='ec-filterbar' role='search'>
        <input className='ec-input flex-1 min-w-[160px]' type='search' placeholder='Search items or sellers…' aria-label='Search the market' value={text} onChange={(e) => setText(e.target.value)} />
        <Select label='Slot' value={f.slot ?? ''} onChange={(v) => set({ slot: v as ItemSlot | '' })} options={[['', 'All slots'], ...ITEM_SLOTS.filter((s) => s !== 'title' && s !== 'card').map((s) => [s, SLOT_LABEL[s]] as [string, string])]} />
        <Select label='Tier' value={f.tier ?? ''} onChange={(v) => set({ tier: v as Tier | '' })} options={[['', 'All tiers'], ...TIERS.map((t) => [t, TIER_LABEL[t]] as [string, string])]} />
        <Select label='Quality' value={f.quality ?? ''} onChange={(v) => set({ quality: v as Quality | '' })} options={[['', 'Any quality'], ...QUALITIES.map((q) => [q.id, q.label] as [string, string])]} />
        <Select label='Effect' value={f.effect ?? ''} onChange={(v) => set({ effect: v })} options={[['', 'Any effect'], ...UNUSUAL_EFFECTS.map((e) => [e.id, e.name] as [string, string])]} />
        <Select
          label='Sort'
          value={f.sort ?? 'newest'}
          onChange={(v) => set({ sort: v as MarketQuery['sort'] })}
          options={[['newest', 'Newest'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓']]}
        />
      </div>
      {err ? (
        <div className='lk-empty'>
          Couldn&rsquo;t load the market. <button type='button' className='underline underline-offset-2 hover:text-white' onClick={() => void load(f)}>Try again</button>
        </div>
      ) : !data ? (
        <div className='ec-listing-grid'>{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className='aspect-[3/4] w-full' />)}</div>
      ) : data.listings.length === 0 ? (
        <div className='lk-empty'>No listings match those filters.</div>
      ) : (
        <>
          <div className='ec-listing-grid' role='list'>
            {data.listings.map((l) => (
              <ListingCard key={l.id} l={l} onOpen={setOpen} />
            ))}
          </div>
          {pages > 1 && (
            <div className='mt-5 flex items-center justify-center gap-3'>
              <button type='button' className='ec-btn' disabled={data.page <= 0} onClick={() => set({ page: data.page - 1 })}>‹ Prev</button>
              <span className='font-mono text-[12px] text-white/55'>Page {data.page + 1} / {pages} · {data.total} listings</span>
              <button type='button' className='ec-btn' disabled={data.page + 1 >= pages} onClick={() => set({ page: data.page + 1 })}>Next ›</button>
            </div>
          )}
        </>
      )}
      {open && (
        <ListingDialog
          l={open}
          econ={econ}
          loggedIn={loggedIn}
          myName={myName}
          locked={locked}
          onClose={() => setOpen(null)}
          onBought={() => {
            setOpen(null);
            void load(f);
          }}
        />
      )}
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className='ec-select'>
      <span className='sr-only'>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function ListingCard({ l, onOpen }: { l: Listing; onOpen: (l: Listing) => void }) {
  const below = l.suggested ? Math.round((1 - l.price / l.suggested) * 100) : 0;
  return (
    <div className='ec-listing' role='listitem' data-listing={l.id}>
      <InstTile inst={l.item} onPick={() => onOpen(l)} />
      <div className='ec-listing-meta'>
        <b className='ec-price'>{fmtCredits(l.price)}</b>
        {l.suggested != null && Math.abs(below) >= 5 && (
          <span className={below > 0 ? 'text-emerald-300' : 'text-rose-300'}>{Math.abs(below)}% {below > 0 ? 'below' : 'above'} typical</span>
        )}
        <span className='truncate text-white/45'>{l.seller} · {timeAgo(l.createdAt)}</span>
      </div>
    </div>
  );
}

// ── Listing detail + buy ────────────────────────────────────────────────────

const salePoints = (h: HistoryResp) => [...h.sales].reverse().map((x) => ({ ts: x.soldAt, price: x.price }));

function useHistory(def: string): HistoryResp | null | 'err' {
  const [h, setH] = useState<HistoryResp | null | 'err'>(null);
  useEffect(() => {
    let live = true;
    setH(null);
    void api.history(def).then((r) => live && setH(r.ok ? r : 'err'));
    return () => {
      live = false;
    };
  }, [def]);
  return h;
}

function ListingDialog({ l, econ, loggedIn, myName, locked, onClose, onBought }: { l: Listing; econ: Econ; loggedIn: boolean; myName: string; locked: boolean; onClose: () => void; onBought: () => void }) {
  const it = l.item;
  const mine = !!myName && l.seller.toLowerCase() === myName.toLowerCase();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const hist = useHistory(it.def);
  const tier = instTier(it);
  const after = econ.credits - l.price;
  const lock = useRef(false);
  const buy = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const r = await api.buy(l.id);
    lock.current = false;
    setBusy(false);
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      if (r.reason === 'not_active') onBought();
      return;
    }
    econ.setBalance({ credits: r.credits });
    econ.addItem(r.item);
    toast(`Bought · ${instFullName(it)}`, { tone: 'ok', sound: 'purchase' });
    onBought();
  };
  return (
    <ModalShell label='Listing' title={instFullName(it)} tone='cyan' fixed z='z-[70]' size='lg' onClose={onClose}>
      <div className='ec-dialog-grid'>
        <div className='w-[176px] shrink-0'>
          <InstTile inst={it} />
        </div>
        <div className='flex min-w-0 flex-1 flex-col gap-2.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <TierChip tier={tier} />
            <span className='lk-chip text-white/55' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>{SLOT_LABEL[instSlot(it)]}</span>
            <span className='font-mono text-[12px] text-white/55'>Mint #{it.mint}</span>
          </div>
          <TagPills tags={instTags(it)} />
          <p className='lk-blurb'>{instBlurb(it)}</p>
          <div className='ec-facts'>
            <div><span>Seller</span><b>{l.seller}</b></div>
            <div><span>Listed</span><b>{timeAgo(l.createdAt)}</b></div>
            {l.suggested != null && <div><span>Typical price</span><b>{fmtCredits(l.suggested)}</b></div>}
          </div>
          <div>
            <div className='ec-sub'>Price history · {instBaseName(it)}</div>
            {hist === null ? <Skeleton className='h-16 w-full' /> : hist === 'err' ? <div className='text-[13px] text-white/45'>No history available.</div> : <Sparkline points={salePoints(hist)} color={TIER_COLOR[tier].edge} label={`Recent sale prices of ${instBaseName(it)}`} />}
          </div>
        </div>
      </div>
      <div className='ec-dialog-foot'>
        <div>
          <div className='ec-price ec-price-lg'>{fmtCredits(l.price)}</div>
          {loggedIn && <div className={`font-sans text-[12.5px] ${after < 0 ? 'text-rose-300' : 'text-white/50'}`}>{after < 0 ? `Need ${fmtCredits(-after)} more` : `Balance after: ${fmtCredits(after)}`}</div>}
        </div>
        {!confirm ? (
          <button type='button' className={`lk-action ${loggedIn && after >= 0 && !mine && !locked ? 'lk-action-buy' : 'lk-action-muted'}`} data-action='buy' disabled={!loggedIn || after < 0 || mine || locked} onClick={() => setConfirm(true)} {...sfxProps('uiConfirm')}>
            {!loggedIn ? 'Log in to buy' : mine ? 'Your listing' : locked ? 'Locked' : 'Buy'}
          </button>
        ) : (
          <div className='ec-confirm'>
            <span>Buy {instBaseName(it)} for {fmtCredits(l.price)}?</span>
            <button type='button' className='lk-action lk-action-buy' data-action='buy-confirm' disabled={busy} onClick={() => void buy()}>{busy ? 'Buying…' : 'Confirm purchase'}</button>
            <button type='button' className='ec-btn' onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// ── Sell ────────────────────────────────────────────────────────────────────

function SellPicker({ econ, loggedIn, onPick }: { econ: Econ; loggedIn: boolean; onPick: (i: ItemInstanceWire) => void }) {
  const items = useMemo(() => econ.items.filter((i) => i.state === 'owned' && i.tradable), [econ.items]);
  if (!loggedIn) return <div className='lk-empty'>Log in to sell items.</div>;
  if (econ.status === 'loading') return <div className='ec-listing-grid'>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className='aspect-square w-full' />)}</div>;
  if (items.length === 0) return <div className='lk-empty'>You have no tradable items to list. Bound items (titles, founder, staff) can’t be sold.</div>;
  return (
    <>
      <p className='mb-3 font-sans text-[13.5px] text-white/60'>Pick an item to list. Its price floor is 1.5× its salvage value.</p>
      <div className='ec-listing-grid'>
        {items.map((i) => (
          <div key={i.uid} className='ec-listing'>
            <InstTile inst={i} onPick={onPick} />
            <div className='ec-listing-meta'><span className='text-white/50'>Floor {fmtCredits(marketFloor(instTier(i)))}</span></div>
          </div>
        ))}
      </div>
    </>
  );
}

function SellDialog({ inst, econ, locked, onClose, onListed }: { inst: ItemInstanceWire; econ: Econ; locked: boolean; onClose: () => void; onListed: () => void }) {
  const tier = instTier(inst);
  const floor = marketFloor(tier);
  const hist = useHistory(inst.def);
  const suggested = hist && hist !== 'err' ? (hist.suggested ?? undefined) : undefined;
  const [price, setPrice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (price === '' && hist !== null) setPrice(String(Math.max(floor, suggested ?? floor * 2)));
  }, [hist, suggested, floor, price]);
  const n = Math.floor(Number(price));
  const valid = Number.isFinite(n) && n >= floor && n <= MARKET.maxPrice;
  const fee = valid ? listingFee(n) : 0;
  const tax = valid ? saleTax(n) : 0;
  const net = valid ? saleNet(n) : 0;
  const can = valid && econ.credits >= fee && !locked;
  const lock = useRef(false);
  const submit = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const r = await api.list(inst.uid, n);
    lock.current = false;
    setBusy(false);
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      return;
    }
    econ.setBalance({ credits: r.credits });
    econ.markListed(inst.uid);
    toast(`Listed · ${instBaseName(inst)} for ${fmtCredits(n)}`, { tone: 'ok', sound: 'purchase' });
    onListed();
  };
  return (
    <ModalShell label='List on market' title='List on market' tone='amber' fixed z='z-[70]' size='lg' onClose={onClose}>
      <div className='ec-dialog-grid'>
        <div className='w-[176px] shrink-0'><InstTile inst={inst} /></div>
        <div className='flex min-w-0 flex-1 flex-col gap-3'>
          <div>
            <div className='font-display text-[22px] font-bold uppercase leading-tight' style={{ color: TIER_COLOR[tier].text }}>{instFullName(inst)}</div>
            <TagPills tags={instTags(inst)} />
          </div>
          <label className='ec-field'>
            <span>Asking price</span>
            <div className='ec-priceinput'>
              <b>⛁</b>
              <input inputMode='numeric' aria-label='Asking price in credits' value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ''))} data-field='price' />
            </div>
          </label>
          <div className='flex flex-wrap items-center gap-2 text-[12.5px]'>
            <span className='text-white/50'>Quick set:</span>
            <button type='button' className='ec-btn' onClick={() => setPrice(String(floor))}>Floor {fmtCredits(floor)}</button>
            {suggested != null && <button type='button' className='ec-btn' data-action='suggested' onClick={() => setPrice(String(Math.max(floor, suggested)))}>Suggested {fmtCredits(suggested)}</button>}
          </div>
          {!valid && price !== '' && <div className='font-sans text-[12.5px] text-rose-300'>Price must be between {fmtCredits(floor)} and {fmtCredits(MARKET.maxPrice)}.</div>}
          <table className='ec-table ec-breakdown' aria-label='Proceeds breakdown'>
            <tbody>
              <tr><th scope='row'>Listing price</th><td className='ec-num'>{valid ? fmtCredits(n) : '—'}</td></tr>
              <tr><th scope='row'>Listing fee ({MARKET.listingFeePct * 100}%) <small>paid now, non-refundable</small></th><td className='ec-num text-rose-300'>{valid ? `− ${fmtCredits(fee)}` : '—'}</td></tr>
              <tr><th scope='row'>Sale tax ({MARKET.saleTaxPct * 100}%) <small>taken when it sells</small></th><td className='ec-num text-rose-300'>{valid ? `− ${fmtCredits(tax)}` : '—'}</td></tr>
              <tr className='ec-total'><th scope='row'>You receive on sale</th><td className='ec-num text-emerald-300'>{valid ? fmtCredits(net) : '—'}</td></tr>
            </tbody>
          </table>
          <div className='ec-sub'>Price history</div>
          {hist === null ? <Skeleton className='h-14 w-full' /> : hist === 'err' ? <div className='text-[13px] text-white/45'>No history available.</div> : <Sparkline points={salePoints(hist)} color={TIER_COLOR[tier].edge} height={52} label={`Recent sale prices of ${instBaseName(inst)}`} />}
        </div>
      </div>
      <div className='ec-dialog-foot'>
        <div className='font-sans text-[12.5px] text-white/50'>Balance {fmtCredits(econ.credits)}{valid ? ` → ${fmtCredits(econ.credits - fee)} after the fee` : ''}. The item is escrowed until it sells or you unlist it.</div>
        <button type='button' className={`lk-action ${can ? 'lk-action-buy' : 'lk-action-muted'}`} data-action='list' disabled={!can || busy} onClick={() => void submit()} {...sfxProps('uiConfirm')}>
          {busy ? 'Listing…' : locked ? 'Locked' : valid && econ.credits < fee ? 'Can’t afford the fee' : 'List for sale'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── My listings ─────────────────────────────────────────────────────────────

function MyListings({ econ }: { econ: Econ }) {
  const [list, setList] = useState<Listing[] | null>(null);
  const [busy, setBusy] = useState<string | number | null>(null);
  useEffect(() => {
    let live = true;
    void api.myListings().then((r) => live && setList(r.ok ? r.listings : []));
    return () => {
      live = false;
    };
  }, []);
  const unlist = async (l: Listing) => {
    setBusy(l.id);
    const r = await api.unlist(l.id);
    setBusy(null);
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      return;
    }
    econ.patchItem(l.item.uid, { state: 'owned' });
    setList((cur) => (cur ? cur.filter((x) => x.id !== l.id) : cur));
    toast('Unlisted — back in your inventory.', { tone: 'ok' });
  };
  if (list === null) return <div className='ec-listing-grid'>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className='aspect-[3/4] w-full' />)}</div>;
  if (list.length === 0) return <div className='lk-empty'>You have no active listings. Use Sell (or “List on market” on an inventory item).</div>;
  return (
    <div className='ec-listing-grid'>
      {list.map((l) => (
        <div key={l.id} className='ec-listing' data-listing={l.id}>
          <InstTile inst={l.item} />
          <div className='ec-listing-meta'>
            <b className='ec-price'>{fmtCredits(l.price)}</b>
            <span className='text-white/50'>You get {fmtCredits(saleNet(l.price))} · {timeAgo(l.createdAt)}</span>
            <button type='button' className='ec-btn ec-btn-danger mt-1' data-action='unlist' disabled={busy === l.id} onClick={() => void unlist(l)}>{busy === l.id ? 'Unlisting…' : 'Unlist'}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
