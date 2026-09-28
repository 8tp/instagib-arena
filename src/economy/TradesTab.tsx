// Trades: direct offers. Incoming / outgoing / history, a review screen that
// shows BOTH sides before you accept, and "New trade" (look a player up by
// name, pick items + credits on both sides, add a note). Trade gates (level,
// recorded matches, account age) are shown, and block sending when unmet.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModalShell, SegButton, Skeleton } from '../deck';
import { sfxProps, toast } from '../deck-core';
import { TRADE, type ItemInstanceWire } from '../game/items/types';
import { econ as api, reasonText, type Trade, type TradeGate, type TradesResp } from './api';
import { fmtCredits, gateRows, instBaseName, timeAgo, timeLeft } from './display';
import { InstTile } from './parts';
import type { Econ } from './useEconomy';

type View = 'offers' | 'new';

export function TradesTab({
  econ,
  loggedIn,
  offerUid,
  clearOffer,
  myName,
}: {
  econ: Econ;
  loggedIn: boolean;
  offerUid: string | null;
  clearOffer: () => void;
  myName: string;
}) {
  const [view, setView] = useState<View>(offerUid ? 'new' : 'offers');
  const [data, setData] = useState<TradesResp | null>(null);
  const [err, setErr] = useState(false);
  const [review, setReview] = useState<{ t: Trade; dir: 'in' | 'out' } | null>(null);
  const [preload, setPreload] = useState<string | null>(offerUid);

  const load = useCallback(async () => {
    setErr(false);
    const r = await api.trades();
    if (r.ok) setData(r);
    else setErr(true);
  }, []);
  useEffect(() => {
    if (loggedIn) void load();
  }, [loggedIn, load]);
  useEffect(() => {
    if (offerUid) {
      setPreload(offerUid);
      setView('new');
      clearOffer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerUid]);

  if (!loggedIn) return <div className='ec-page'><div className='ec-page-in'><div className='lk-empty'>Log in to trade with other players.</div></div></div>;

  const inc = data?.incoming ?? [];
  const out = data?.outgoing ?? [];
  const past = data?.history ?? [];

  return (
    <div className='ec-page deck-scroll'>
      <div className='ec-page-in'>
        <div className='ec-subtabs' role='tablist' aria-label='Trades'>
          <SegButton active={view === 'offers'} onClick={() => setView('offers')} role='tab' aria-selected={view === 'offers'} data-sub='offers'>
            Offers{inc.length ? ` · ${inc.length}` : ''}
          </SegButton>
          <SegButton active={view === 'new'} onClick={() => setView('new')} role='tab' aria-selected={view === 'new'} data-sub='new'>
            New trade
          </SegButton>
          <span className='ml-auto font-sans text-[12.5px] text-white/45'>
            Both sides need level {TRADE.minLevel}, {TRADE.minMatches} matches and a 24 h old account · offers expire after 48 h
          </span>
        </div>

        {view === 'offers' && (
          <>
            {err && <div className='lk-empty'>Couldn&rsquo;t load trades. <button type='button' className='underline underline-offset-2 hover:text-white' onClick={() => void load()}>Try again</button></div>}
            {!data && !err && <Skeleton className='h-32 w-full' />}
            {data && (
              <>
                <TradeList title='Incoming offers' empty='No one has sent you an offer.' list={inc} dir='in' onOpen={(t) => setReview({ t, dir: 'in' })} />
                <TradeList title='Outgoing offers' empty='You have no pending offers.' list={out} dir='out' onOpen={(t) => setReview({ t, dir: 'out' })} />
                {past.length > 0 && <TradeList title='Recent' empty='' list={past.slice(0, 8)} dir='past' myName={myName} onOpen={(t) => setReview({ t, dir: t.to.toLowerCase() === myName.toLowerCase() ? 'in' : 'out' })} />}
              </>
            )}
          </>
        )}
        {view === 'new' && (
          <NewTrade
            econ={econ}
            gate={data?.me}
            preload={preload}
            onSent={() => {
              setPreload(null);
              setView('offers');
              void load();
            }}
          />
        )}
      </div>
      {review && (
        <ReviewDialog
          t={review.t}
          dir={review.dir}
          econ={econ}
          onClose={() => setReview(null)}
          onDone={() => {
            setReview(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ── Lists ───────────────────────────────────────────────────────────────────

function TradeList({ title, empty, list, dir, onOpen, myName }: { title: string; empty: string; list: Trade[]; dir: 'in' | 'out' | 'past'; onOpen: (t: Trade) => void; myName?: string }) {
  return (
    <section className='mb-7' aria-label={title}>
      <h4 className='ec-section !mt-0'>{title}</h4>
      {list.length === 0 ? (
        <div className='font-sans text-[13.5px] text-white/45'>{empty}</div>
      ) : (
        <div className='flex flex-col gap-2.5'>
          {list.map((t) => (
            <TradeRow key={t.id} t={t} dir={dir === 'past' ? (t.to.toLowerCase() === (myName ?? '').toLowerCase() ? 'in' : 'out') : dir} past={dir === 'past'} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

function Side({ items, credits, label }: { items: ItemInstanceWire[]; credits: number; label: string }) {
  return (
    <div className='ec-side'>
      <div className='ec-side-label'>{label}</div>
      <div className='flex flex-wrap items-center gap-1.5'>
        {items.map((i) => (
          <InstTile key={i.uid} inst={i} size={76} fluid={false} />
        ))}
        {credits > 0 && <span className='ec-creditchip'>{fmtCredits(credits)}</span>}
        {items.length === 0 && credits === 0 && <span className='font-sans text-[12.5px] text-white/40'>nothing</span>}
      </div>
    </div>
  );
}

function TradeRow({ t, dir, past, onOpen }: { t: Trade; dir: 'in' | 'out'; past: boolean; onOpen: (t: Trade) => void }) {
  const incoming = dir === 'in';
  const recv = incoming ? { items: t.give, credits: t.giveCredits } : { items: t.get, credits: t.getCredits };
  const give = incoming ? { items: t.get, credits: t.getCredits } : { items: t.give, credits: t.giveCredits };
  return (
    <div className='ec-traderow' data-trade={t.id} data-state={t.state}>
      <div className='ec-trade-who'>
        <b>{dir === 'in' ? t.from : t.to}</b>
        <span>{past ? t.state : dir === 'in' ? 'sent you an offer' : 'offer sent'}</span>
        <small>{timeAgo(t.createdAt)}{t.expiresAt && t.state === 'pending' ? ` · ${timeLeft(t.expiresAt)}` : ''}</small>
      </div>
      <Side items={recv.items} credits={recv.credits} label={dir === 'out' ? 'They receive' : 'You receive'} />
      <span className='ec-swap' aria-hidden>⇄</span>
      <Side items={give.items} credits={give.credits} label='You give' />
      <button type='button' className='ec-btn ec-btn-primary' data-action='review' onClick={() => onOpen(t)} {...sfxProps('uiClick')}>
        {dir === 'in' && !past ? 'Review' : 'View'}
      </button>
    </div>
  );
}

// ── Review (accept / decline / cancel) ──────────────────────────────────────

function ReviewDialog({ t, dir, econ, onClose, onDone }: { t: Trade; dir: 'in' | 'out'; econ: Econ; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const incoming = dir === 'in';
  // What lands in MY inventory vs what leaves it.
  const recv = incoming ? { items: t.give, credits: t.giveCredits } : { items: t.get, credits: t.getCredits };
  const give = incoming ? { items: t.get, credits: t.getCredits } : { items: t.give, credits: t.giveCredits };
  const afford = give.credits <= econ.credits;
  const act = async (a: 'accept' | 'decline' | 'cancel') => {
    setBusy(true);
    const r = await api.tradeAct(t.id, a);
    setBusy(false);
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      if (r.reason === 'gone') onDone();
      return;
    }
    if (a === 'accept') {
      econ.reload();
      toast('Trade complete — items added to your inventory.', { tone: 'ok', sound: 'purchase' });
    } else toast(a === 'decline' ? 'Offer declined.' : 'Offer cancelled.', { tone: 'ok' });
    onDone();
  };
  return (
    <ModalShell label='Trade offer' title={incoming ? `Offer from ${t.from}` : `Offer to ${t.to}`} tone='cyan' fixed z='z-[70]' size='xl' onClose={onClose}>
      <div className='ec-review'>
        <ReviewSide title='You receive' tone='in' items={recv.items} credits={recv.credits} />
        <div className='ec-swap ec-swap-lg' aria-hidden>⇄</div>
        <ReviewSide title='You give' tone='out' items={give.items} credits={give.credits} />
      </div>
      {t.note && <blockquote className='ec-note'>“{t.note}” <cite>— {t.from}</cite></blockquote>}
      <div className='ec-dialog-foot'>
        <div className='font-sans text-[12.5px] text-white/50'>
          {t.state === 'pending' ? (t.expiresAt ? `Expires ${timeLeft(t.expiresAt)}` : 'Pending') : `This offer was ${t.state}.`} · Your balance {fmtCredits(econ.credits)}
          {incoming && !afford && <span className='ml-2 text-rose-300'>You can’t cover the credits.</span>}
        </div>
        {t.state === 'pending' && incoming && (
          <div className='flex flex-wrap gap-2.5'>
            <button type='button' className='lk-action lk-action-equip' data-action='accept' disabled={busy || !afford} onClick={() => void act('accept')} {...sfxProps('uiConfirm')}>Accept trade</button>
            <button type='button' className='lk-action lk-action-muted' data-action='decline' disabled={busy} onClick={() => void act('decline')}>Decline</button>
          </div>
        )}
        {t.state === 'pending' && dir === 'out' && (
          <button type='button' className='lk-action lk-action-muted' data-action='cancel' disabled={busy} onClick={() => void act('cancel')}>Cancel offer</button>
        )}
      </div>
    </ModalShell>
  );
}

function ReviewSide({ title, tone, items, credits }: { title: string; tone: 'in' | 'out'; items: ItemInstanceWire[]; credits: number }) {
  return (
    <section className={`ec-review-side ec-review-${tone}`} aria-label={title}>
      <h4>{title}</h4>
      <div className='ec-review-grid'>
        {items.map((i) => (
          <div key={i.uid} title={instBaseName(i)}>
            <InstTile inst={i} />
          </div>
        ))}
      </div>
      {credits > 0 && <div className='ec-creditchip ec-creditchip-lg'>{fmtCredits(credits)}</div>}
      {items.length === 0 && credits === 0 && <div className='font-sans text-[13px] text-white/40'>Nothing</div>}
    </section>
  );
}

// ── New trade ───────────────────────────────────────────────────────────────

function NewTrade({ econ, gate, preload, onSent }: { econ: Econ; gate?: TradeGate; preload: string | null; onSent: () => void }) {
  const [name, setName] = useState('');
  const [partner, setPartner] = useState<{ name: string; items: ItemInstanceWire[]; gate?: TradeGate } | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookErr, setLookErr] = useState<string | null>(null);
  const [mine, setMine] = useState<string[]>(preload ? [preload] : []);
  const [theirs, setTheirs] = useState<string[]>([]);
  const [giveC, setGiveC] = useState('');
  const [getC, setGetC] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const myItems = useMemo(() => econ.items.filter((i) => i.state === 'owned' && i.tradable), [econ.items]);

  const lookup = async () => {
    const n = name.trim();
    if (!n) return;
    setLooking(true);
    setLookErr(null);
    const r = await api.playerInventory(n);
    setLooking(false);
    if (!r.ok) {
      setLookErr(r.status === 404 ? `No player named “${n}”.` : reasonText(r));
      setPartner(null);
      return;
    }
    setPartner({ name: r.name, items: r.items, gate: r.gate });
    setTheirs([]);
  };

  const toggle = (list: string[], set: (v: string[]) => void, uid: string) => {
    if (list.includes(uid)) set(list.filter((u) => u !== uid));
    else if (list.length < TRADE.maxItemsPerSide) set([...list, uid]);
    else toast(`Up to ${TRADE.maxItemsPerSide} items per side.`, { tone: 'warn' });
  };

  const gc = Math.max(0, Math.floor(Number(giveC) || 0));
  const rc = Math.max(0, Math.floor(Number(getC) || 0));
  const myGate = gateRows(gate);
  const theirGate = gateRows(partner?.gate);
  const blocked = [...myGate, ...theirGate].some((g) => !g.ok);
  const empty = mine.length + theirs.length + gc + rc === 0;
  const canSend = !!partner && !blocked && !empty && gc <= econ.credits && gc <= TRADE.maxCreditsPerDay && rc <= TRADE.maxCreditsPerDay;

  const send = async () => {
    if (!partner) return;
    setSending(true);
    const r = await api.offer({ to: partner.name, giveItems: mine, giveCredits: gc, getItems: theirs, getCredits: rc, note: note.trim() || undefined });
    setSending(false);
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      return;
    }
    toast(`Offer sent to ${partner.name}.`, { tone: 'ok', sound: 'purchase' });
    onSent();
  };

  return (
    <div className='ec-newtrade'>
      <div className='ec-lookup'>
        <label className='ec-field grow'>
          <span>Trade with</span>
          <div className='flex gap-2'>
            <input className='ec-input flex-1' placeholder='Player name' aria-label='Player name' value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void lookup()} data-field='player' />
            <button type='button' className='ec-btn ec-btn-primary' data-action='lookup' disabled={looking || !name.trim()} onClick={() => void lookup()}>{looking ? 'Looking…' : 'Look up'}</button>
          </div>
        </label>
        {lookErr && <div className='font-sans text-[12.5px] text-rose-300'>{lookErr}</div>}
      </div>

      {(myGate.length > 0 || theirGate.length > 0) && (
        <div className='ec-gates' aria-label='Trade requirements'>
          <GateList who='You' rows={myGate} />
          {partner && <GateList who={partner.name} rows={theirGate} />}
        </div>
      )}

      <div className='ec-picker-grid'>
        <Picker title='You give' items={myItems} sel={mine} onToggle={(u) => toggle(mine, setMine, u)} credits={giveC} setCredits={setGiveC} creditsMax={econ.credits} empty='You have no tradable items.' />
        <Picker
          title={partner ? `${partner.name} gives` : 'They give'}
          items={partner?.items ?? []}
          sel={theirs}
          onToggle={(u) => toggle(theirs, setTheirs, u)}
          credits={getC}
          setCredits={setGetC}
          empty={partner ? `${partner.name} has nothing tradable.` : 'Look a player up to see their public tradable inventory.'}
        />
      </div>

      <label className='ec-field mt-4'>
        <span>Note <small>optional</small></span>
        <input className='ec-input' maxLength={140} placeholder='Say something nice…' value={note} onChange={(e) => setNote(e.target.value)} aria-label='Note' />
      </label>

      <div className='ec-dialog-foot mt-4'>
        <div className='font-sans text-[13px] text-white/60'>
          {partner ? (
            <>
              You give {mine.length} item{mine.length === 1 ? '' : 's'}{gc ? ` + ${fmtCredits(gc)}` : ''} · you get {theirs.length} item{theirs.length === 1 ? '' : 's'}{rc ? ` + ${fmtCredits(rc)}` : ''}
            </>
          ) : (
            'Pick a player to start.'
          )}
          {blocked && <span className='ml-2 text-rose-300'>Trading is locked until the requirements above are met.</span>}
          {gc > econ.credits && <span className='ml-2 text-rose-300'>Not enough credits.</span>}
        </div>
        <button type='button' className={`lk-action ${canSend ? 'lk-action-buy' : 'lk-action-muted'}`} data-action='send-offer' disabled={!canSend || sending} onClick={() => void send()} {...sfxProps('uiConfirm')}>
          {sending ? 'Sending…' : 'Send offer'}
        </button>
      </div>
    </div>
  );
}

function GateList({ who, rows }: { who: string; rows: { label: string; have: string; ok: boolean }[] }) {
  return (
    <div className='ec-gatecol'>
      <div className='ec-side-label'>{who}</div>
      {rows.map((g) => (
        <div key={g.label} className={g.ok ? 'is-ok' : 'is-no'}>
          <span aria-hidden>{g.ok ? '✓' : '✕'}</span> {g.label} <small>· {g.have}</small>
        </div>
      ))}
    </div>
  );
}

function Picker({
  title,
  items,
  sel,
  onToggle,
  credits,
  setCredits,
  creditsMax,
  empty,
}: {
  title: string;
  items: ItemInstanceWire[];
  sel: string[];
  onToggle: (uid: string) => void;
  credits: string;
  setCredits: (v: string) => void;
  creditsMax?: number;
  empty: string;
}) {
  return (
    <section className='ec-picker' aria-label={title}>
      <div className='ec-picker-head'>
        <h4>{title}</h4>
        <span>{sel.length} / {TRADE.maxItemsPerSide}</span>
      </div>
      <div className='ec-picker-scroll deck-scroll'>
        {items.length === 0 ? (
          <div className='lk-empty !py-6'>{empty}</div>
        ) : (
          <div className='ec-picker-tiles' role='listbox' aria-multiselectable='true' aria-label={title}>
            {items.map((i) => (
              <InstTile key={i.uid} inst={i} selected={sel.includes(i.uid)} onPick={() => onToggle(i.uid)} rootProps={{ role: 'option', 'aria-selected': sel.includes(i.uid) }} />
            ))}
          </div>
        )}
      </div>
      <label className='ec-field'>
        <span>Credits{creditsMax != null ? <small> you have {fmtCredits(creditsMax)}</small> : null}</span>
        <div className='ec-priceinput'>
          <b>⛁</b>
          <input inputMode='numeric' aria-label={`${title} credits`} value={credits} placeholder='0' onChange={(e) => setCredits(e.target.value.replace(/[^0-9]/g, ''))} />
        </div>
      </label>
    </section>
  );
}
