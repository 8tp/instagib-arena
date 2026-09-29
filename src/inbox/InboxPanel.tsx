// The player inbox (docs/economy.md §7b): redeem a code at the top, then your
// messages — gifts from the team (claimable attachments), code receipts and
// announcements. Opening a message marks it read; claiming a gift mints its
// items server-side and the reply's balance replaces ours (and the Locker's,
// when opened from there). Motion is CSS only, keyed by id; `reduced` turns it
// off along with the reveal's screen FX.
import '../locker/locker.css';
import '../economy/economy.css';
import './inbox.css';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { DeckButton, ModalShell, Skeleton, TextButton } from '../deck';
import { uiSfx } from '../deck-core';
import { playUi } from '../game/audio';
import { TIER_META, type InboxMessageWire, type ItemInstanceWire, type Tier } from '../game/items/types';
import { econ as api, reasonText, type Granted, type InboxSummary, type RedeemResp } from '../economy/api';
import { instFullName, instTier, timeAgo, timeLeft } from '../economy/display';
import { Balance } from '../economy/parts';
import { RevealFx, type FxOrigin } from '../economy/RevealFx';
import type { Econ } from '../economy/useEconomy';
import { TIER_COLOR } from '../ui/rarity';
import { CodeIcon, EnvelopeIcon, KindIcon } from './icons';
import { RewardView } from './RewardBits';
import { bundleIsEmpty, claimable, isExpired, summarize, topTier } from './reward';

export type InboxEconomy = Pick<Econ, 'setBalance' | 'addItem'>;

const now = () => Date.now();

const UNLOCK_SFX: Record<Tier, Parameters<typeof playUi>[0]> = {
  common: 'unlockCommon',
  uncommon: 'unlockCommon',
  rare: 'unlockRare',
  epic: 'unlockEpic',
  legendary: 'unlockLegendary',
  relic: 'unlockLegendary',
  unobtainable: 'unlockLegendary',
};

function grantSfx(items: readonly ItemInstanceWire[]) {
  playUi('purchase');
  const t = topTier(items);
  if (t) window.setTimeout(() => playUi(UNLOCK_SFX[t]), 180);
}

type Floater = { id: number; text: string; tone: 'credits' | 'rolls' | 'items' };

export function InboxPanel({
  onClose,
  reduced,
  lowSpec,
  balance,
  economy,
  onSummary,
  onGranted,
  focusRedeem = false,
}: {
  onClose: () => void;
  reduced: boolean;
  lowSpec: boolean;
  balance?: { credits: number | null; freeRolls?: number | null };
  economy?: InboxEconomy;
  onSummary?: (s: InboxSummary) => void;
  onGranted?: () => void;
  focusRedeem?: boolean;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState('');
  const [messages, setMessages] = useState<InboxMessageWire[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [claiming, setClaiming] = useState<number | null>(null);
  const [claimErr, setClaimErr] = useState<{ id: number; text: string } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const [bal, setBal] = useState<{ credits: number | null; freeRolls: number | null }>(() => ({ credits: balance?.credits ?? null, freeRolls: balance?.freeRolls ?? null }));
  const [bump, setBump] = useState(0);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [reveal, setReveal] = useState<{ code: string; granted: Granted; key: number } | null>(null);
  const floatSeq = useRef(0);
  const timers = useRef<number[]>([]);
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;
  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;
  const listId = useId();

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const load = useCallback(async () => {
    const r = await api.inbox();
    if (!r.ok) {
      setLoadErr(reasonText(r, 'inbox'));
      setStatus((s) => (s === 'ready' ? s : 'error'));
      return;
    }
    setMessages(r.messages);
    setStatus('ready');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the badge in step with what's on screen.
  useEffect(() => {
    if (status === 'ready') onSummaryRef.current?.(summarize(messages));
  }, [messages, status]);

  const retry = () => {
    setStatus('loading');
    void load();
  };

  const toggle = (m: InboxMessageWire) => {
    const next = openId === m.id ? null : m.id;
    setOpenId(next);
    setClaimErr(null);
    if (next !== null && !m.readAt) {
      setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, readAt: now() } : x)));
      void api.inboxRead(m.id);
    }
  };

  const markAll = () => {
    if (!messages.some((m) => !m.readAt)) return;
    const t = now();
    setMessages((ms) => ms.map((m) => (m.readAt ? m : { ...m, readAt: t })));
    void api.inboxRead('all');
  };

  // Credits / rolls / items landed: update every balance we know about, float
  // the amounts up toward the balance readout, and ping the menu.
  const land = useCallback(
    (g: Granted, credits: number, freeRolls: number) => {
      setBal({ credits, freeRolls });
      setBump((b) => b + 1);
      economy?.setBalance({ credits, freeRolls });
      for (const it of g.items) economy?.addItem(it);
      onGrantedRef.current?.();
      grantSfx(g.items);
      if (reduced) return;
      const add: Floater[] = [];
      if (g.credits) add.push({ id: ++floatSeq.current, text: `+⛁ ${g.credits.toLocaleString()}`, tone: 'credits' });
      if (g.rolls) add.push({ id: ++floatSeq.current, text: `+${g.rolls} roll${g.rolls === 1 ? '' : 's'}`, tone: 'rolls' });
      if (g.items.length) add.push({ id: ++floatSeq.current, text: `+${g.items.length} item${g.items.length === 1 ? '' : 's'}`, tone: 'items' });
      setFloaters((f) => [...f, ...add]);
      const ids = new Set(add.map((a) => a.id));
      timers.current.push(window.setTimeout(() => setFloaters((f) => f.filter((x) => !ids.has(x.id))), 1600));
    },
    [economy, reduced],
  );

  const claim = async (m: InboxMessageWire) => {
    if (claiming !== null) return;
    setClaiming(m.id);
    setClaimErr(null);
    const r = await api.inboxClaim(m.id);
    setClaiming(null);
    if (!r.ok) {
      uiSfx('uiError');
      setClaimErr({ id: m.id, text: reasonText(r, 'inbox') });
      if (r.reason === 'claimed' || r.reason === 'expired' || r.reason === 'not_found') void load();
      return;
    }
    setMessages((ms) => ms.map((x) => (x.id === m.id ? r.message : x)));
    setFresh((f) => new Set(f).add(m.id));
    land(r.granted, r.credits, r.freeRolls);
  };

  const redeemed = (r: RedeemResp) => {
    land(r.granted, r.credits, r.freeRolls);
    setReveal({ code: r.code, granted: r.granted, key: r.messageId });
    void load(); // the receipt
  };

  const unread = messages.filter((m) => !m.readAt).length;

  return (
    <ModalShell
      title='Inbox'
      onClose={onClose}
      width='w-[720px]'
      tone='cyan'
      fixed
      z='z-[70]'
      scroll
      className={`ib-root ${reduced ? 'ib-reduced' : ''}`}
      actions={
        bal.credits != null ? (
          <span className='ib-balance' key={bump} data-bump={bump > 0 && !reduced ? '' : undefined}>
            <Balance credits={bal.credits} freeRolls={bal.freeRolls} compact />
            {floaters.map((f) => (
              <span key={f.id} className={`ib-floater ib-floater-${f.tone}`} aria-hidden>
                {f.text}
              </span>
            ))}
          </span>
        ) : undefined
      }
      header={<RedeemBox autoFocus={focusRedeem} onRedeemed={redeemed} />}
      bodyClassName='ib-body'
    >
      {reveal ? (
        <RedeemReveal key={reveal.key} code={reveal.code} granted={reveal.granted} reduced={reduced} lowSpec={lowSpec} onDone={() => setReveal(null)} />
      ) : (
        <section aria-labelledby={`${listId}-h`} className='ib-list-wrap'>
          <div className='ib-list-head'>
            <h3 id={`${listId}-h`}>
              Messages
              {status === 'ready' && unread > 0 && <span className='ib-count'>{unread} unread</span>}
            </h3>
            {status === 'ready' && messages.length > 0 && (
              <TextButton onClick={markAll} disabled={unread === 0} data-action='inbox-read-all'>
                Mark all read
              </TextButton>
            )}
          </div>

          {status === 'loading' && (
            <ul className='ib-list' aria-busy='true' aria-label='Loading messages'>
              {[0, 1, 2].map((i) => (
                <li key={i} className='ib-skel'>
                  <Skeleton className='h-10 w-10 shrink-0' />
                  <span className='flex flex-1 flex-col gap-2'>
                    <Skeleton className='h-4 w-2/3' />
                    <Skeleton className='h-3 w-1/3' />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {status === 'error' && (
            <div className='ib-state ib-state-err' role='alert'>
              <b>Couldn’t load your inbox.</b>
              <span>{loadErr}</span>
              <DeckButton size='sm' accent='cyan' onClick={retry}>
                Try again
              </DeckButton>
            </div>
          )}

          {status === 'ready' && messages.length === 0 && (
            <div className='ib-state'>
              <span className='ib-state-icon' aria-hidden>
                <EnvelopeIcon size={30} />
              </span>
              <b>No mail yet</b>
              <span>Gifts from the team and your code receipts land here.</span>
            </div>
          )}

          {status === 'ready' && messages.length > 0 && (
            <ul className='ib-list' data-inbox-list>
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  open={openId === m.id}
                  fresh={fresh.has(m.id)}
                  claiming={claiming === m.id}
                  error={claimErr?.id === m.id ? claimErr.text : null}
                  onToggle={() => toggle(m)}
                  onClaim={() => void claim(m)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </ModalShell>
  );
}

// ── One message ─────────────────────────────────────────────────────────────
// Also the admin Gifts tab's "what they'll see" preview (`preview`: inert).
export function MessageRow({
  m,
  open,
  fresh,
  claiming,
  error,
  onToggle,
  onClaim,
  preview = false,
}: {
  preview?: boolean;
  m: InboxMessageWire;
  open: boolean;
  fresh: boolean;
  claiming: boolean;
  error: string | null;
  onToggle: () => void;
  onClaim: () => void;
}) {
  const bodyId = useId();
  const expired = isExpired(m);
  const canClaim = claimable(m);
  const hasReward = !bundleIsEmpty(m.reward);
  const pill =
    m.kind === 'code' ? (
      <span className='ib-pill ib-pill-code'>Redeemed</span>
    ) : canClaim ? (
      <span className='ib-pill ib-pill-gift'>Gift</span>
    ) : m.claimedAt ? (
      <span className='ib-pill ib-pill-done'>✓ Claimed</span>
    ) : expired && hasReward ? (
      <span className='ib-pill ib-pill-off'>Expired</span>
    ) : null;
  return (
    <li className={`ib-msg ib-kind-${m.kind} ${open ? 'is-open' : ''} ${m.readAt ? '' : 'is-unread'} ${canClaim ? 'is-claimable' : ''}`} data-msg={m.id}>
      <button type='button' className='ib-msg-head' aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className='ib-msg-icon'>
          <KindIcon kind={m.kind} size={20} />
        </span>
        <span className='ib-msg-main'>
          <span className='ib-msg-title'>{m.title}</span>
          <span className='ib-msg-meta'>
            <span>{m.sender || 'Instagib Staff'}</span>
            <time dateTime={new Date(m.createdAt).toISOString()} title={new Date(m.createdAt).toLocaleString()}>
              {timeAgo(m.createdAt)}
            </time>
            {m.expiresAt > 0 && !m.claimedAt && <span className={expired ? 'ib-exp is-gone' : 'ib-exp'}>{expired ? 'expired' : `expires in ${timeLeft(m.expiresAt).replace(' left', '')}`}</span>}
          </span>
        </span>
        {pill}
        {!m.readAt && (
          <span className='ib-dot'>
            <span className='sr-only'>Unread</span>
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className='ib-msg-body'>
          {m.body && <p className='ib-msg-text'>{m.body}</p>}
          {hasReward && (
            <div className={`ib-attach ${fresh ? 'is-fresh' : ''} ${canClaim ? 'is-waiting' : ''}`}>
              <div className='ib-attach-label'>{m.claimedAt ? (m.kind === 'code' ? 'You received' : 'Claimed') : expired ? 'This gift expired' : 'Attached'}</div>
              <RewardView key={m.claimedAt ? 'granted' : 'preview'} bundle={m.reward} granted={m.claimedAt ? m.granted : undefined} tile={96} />
              {canClaim && (
                <DeckButton solid accent='amber' size='lg' full center disabled={claiming} onClick={preview ? undefined : onClaim} tabIndex={preview ? -1 : undefined} sound='none' data-action='inbox-claim'>
                  {claiming ? 'Claiming…' : 'Claim'}
                </DeckButton>
              )}
              {!!m.claimedAt && (
                <div className='ib-claimed-note'>
                  ✓ {m.kind === 'code' ? 'Redeemed' : 'Claimed'} {timeAgo(m.claimedAt)}
                  {m.granted.length > 0 && ' · in your Locker'}
                </div>
              )}
              {error && (
                <div className='ib-err' role='alert'>
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Redeem a code ───────────────────────────────────────────────────────────
function RedeemBox({ onRedeemed, autoFocus }: { onRedeemed: (r: RedeemResp) => void; autoFocus: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const submit = async () => {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setErr(null);
    const r = await api.redeem(c);
    setBusy(false);
    if (!r.ok) {
      uiSfx('uiError');
      setErr(reasonText(r, 'code'));
      return;
    }
    setCode('');
    onRedeemed(r);
  };
  return (
    <form
      className='ib-redeem'
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className='ib-redeem-label'>
        <CodeIcon size={16} /> Redeem a code
      </label>
      <div className={`ib-redeem-row ${err ? 'has-err' : ''}`}>
        <input
          id={id}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
            if (err) setErr(null);
          }}
          placeholder='XXXX-XXXX-XXXX'
          maxLength={32}
          autoComplete='off'
          autoCapitalize='characters'
          spellCheck={false}
          aria-invalid={!!err}
          aria-describedby={err ? `${id}-err` : undefined}
          className='ib-redeem-input'
          data-field='redeem-code'
          {...(autoFocus ? { 'data-autofocus': '' } : {})}
        />
        <button type='submit' className='ib-redeem-btn' disabled={busy || code.trim().length < 3} data-action='redeem'>
          {busy ? <span className='ib-spin' aria-label='Redeeming' /> : 'Redeem'}
        </button>
      </div>
      {err && (
        <div id={`${id}-err`} className='ib-err' role='alert'>
          {err}
        </div>
      )}
    </form>
  );
}

// ── The redeem reveal ───────────────────────────────────────────────────────
// A lighter cousin of the case reveal: rays + the code stamped in, the rewards
// popping in one by one, and the case FX burst (capped at Legendary — no
// "You unboxed" takeover) unless effects are reduced.
function RedeemReveal({ code, granted, reduced, lowSpec, onDone }: { code: string; granted: Granted; reduced: boolean; lowSpec: boolean; onDone: () => void }) {
  const top = topTier(granted.items);
  const tier: Tier = top ? (TIER_META[top].rank > TIER_META.legendary.rank ? 'legendary' : top) : 'rare';
  const color = top ? TIER_COLOR[top].edge : '#67e8f9';
  const unusual = granted.items.some((i) => i.quality.includes('unusual'));
  const ref = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState<FxOrigin | null>(null);
  useLayoutEffect(() => {
    if (reduced || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setOrigin({ x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 160) });
  }, [reduced]);
  const best = top ? (granted.items.find((i) => instTier(i) === top) ?? granted.items[0]) : null;
  return (
    <div ref={ref} className='ib-reveal' style={{ '--rc': color } as CSSProperties} role='status' aria-live='polite' data-reveal>
      {!reduced && <div className='ib-reveal-rays' aria-hidden />}
      <span className='ib-reveal-kicker'>Code redeemed</span>
      <div className='ib-reveal-code'>{code}</div>
      <RewardView bundle={{ credits: granted.credits, rolls: granted.rolls }} granted={granted.items} tile={116} big className='ib-reveal-reward' />
      <p className='ib-reveal-note'>{granted.items.length ? `${granted.items.length === 1 ? instFullName(granted.items[0]) + ' is' : 'Everything is'} in your Locker.` : 'Added to your balance.'}</p>
      <DeckButton solid accent='cyan' size='md' center onClick={onDone} data-action='reveal-done' data-autofocus>
        Nice!
      </DeckButton>
      {origin && <RevealFx tier={tier} unusual={unusual} origin={origin} lowSpec={lowSpec} name={best ? instFullName(best) : code} />}
    </div>
  );
}
