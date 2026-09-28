// The Hat Case: the prominent case card at the top of the Hat slot, and the
// Krunker-style unboxing reel that lands on the server-decided winner.
import { useEffect, useRef, useState } from 'react';
import { ModalShell } from '../deck';
import { sfxProps } from '../deck-core';
import { HAT_CASE_COST, cosmeticById, type Rarity } from '../game/cosmetics';
import { ItemTile } from '../ui/item-tile';
import { RARITY_COLOR, RARITY_LABEL } from '../ui/rarity';
import { caseJackpotItems, casePool, type LockerItem } from './slots';

// `won` is the server-decided item (a case hat or a jackpot unusual). Older
// servers can still report a duplicate + refund; the finalized one never does.
export type CaseWin = { won: string; jackpot: boolean; dupe: boolean; refund: number };

export function HatCaseCard({
  credits,
  keys,
  owned,
  complete,
  busy,
  loading,
  guest,
  onOpen,
}: {
  credits: number | null; // null = offline (no server case)
  keys: number; // free case keys — spent before credits
  owned: (id: string) => boolean;
  complete: boolean;
  busy: boolean;
  loading: boolean;
  guest: boolean;
  onOpen: () => void;
}) {
  const offline = credits === null;
  const short = !offline && keys <= 0 && credits < HAT_CASE_COST ? HAT_CASE_COST - credits : 0;
  const disabled = loading || busy || offline || guest || complete || short > 0;
  const label = busy
    ? 'Opening…'
    : offline
      ? 'Offline'
      : guest
        ? 'Log in to open'
        : complete
          ? 'Collection complete'
          : keys > 0
            ? `Open · 1 key`
            : short > 0
              ? `Need ${short.toLocaleString()} more ⛁`
              : `Open · ${HAT_CASE_COST} ⛁`;
  const pool = casePool();
  const jackpots = caseJackpotItems();
  return (
    <div className='lk-case' data-case>
      <div className='lk-crate' aria-hidden>
        <b>?</b>
      </div>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='lk-case-title'>Hat Case</div>
          {keys > 0 && (
            <span className='lk-chip' style={{ background: '#ffc23d', color: '#1c1204' }}>
              {keys} key{keys === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className='mt-1.5 font-sans text-[13px] leading-snug text-white/65'>
          Case-exclusive hats{jackpots.length ? `, with a rare shot at a jackpot unusual` : ''}.
          {keys > 0 ? ' Keys are used before credits.' : ''}
        </p>
        <div className='mt-2 flex flex-wrap gap-1.5' aria-label='Case contents'>
          {pool.map((i) => (
            <ItemTile key={i.id} id={i.id} size={40} label={false} locked={!owned(i.id)} equipped={false} />
          ))}
        </div>
      </div>
      <button
        type='button'
        onClick={onOpen}
        disabled={disabled}
        {...sfxProps('uiConfirm')}
        className={`lk-action shrink-0 ${disabled ? 'lk-action-muted' : 'lk-action-buy'}`}
        title={short > 0 ? `Need ${short} more credits — earn them by playing online matches` : undefined}
      >
        {label}
      </button>
    </div>
  );
}

// A reel of case items that decelerates onto the winner under the centre
// marker (CSS transition — no per-frame React), then reveals it.
export function CaseSpinner({
  win,
  reduced,
  canEquip,
  onEquip,
  onClose,
}: {
  win: CaseWin;
  reduced: boolean;
  canEquip: boolean;
  onEquip: (id: string) => void;
  onClose: () => void;
}) {
  const LAND = 44; // reel index the winner is placed at
  const LEN = 52;
  const CARD = 112;
  const GAP = 10;
  const STRIDE = CARD + GAP;
  const reelRef = useRef<LockerItem[] | null>(null);
  if (!reelRef.current) {
    const jackpots = caseJackpotItems();
    const hats = casePool().filter((p) => !jackpots.includes(p));
    const wonItem = (cosmeticById(win.won) as LockerItem | undefined) ?? hats[0];
    const arr: LockerItem[] = [];
    for (let i = 0; i < LEN; i++) {
      if (i === LAND) arr.push(wonItem);
      // A jackpot teaser now and then (and one just past the winner).
      else if (jackpots.length && (i === LAND + 1 || Math.random() < 0.05))
        arr.push(jackpots[Math.floor(Math.random() * jackpots.length)]);
      else arr.push(hats[Math.floor(Math.random() * hats.length)]);
    }
    reelRef.current = arr;
  }
  const reel = reelRef.current;
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const vpRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const SPIN_MS = reduced ? 900 : 4400;

  useEffect(() => {
    const vp = vpRef.current?.clientWidth ?? 520;
    const jitter = reduced ? 0 : (Math.random() - 0.5) * (CARD * 0.55); // land a touch off-centre
    const target = LAND * STRIDE + CARD / 2 - vp / 2 + jitter;
    const a = requestAnimationFrame(() => requestAnimationFrame(() => setOffset(-target)));
    const t = window.setTimeout(() => setRevealed(true), SPIN_MS + 120);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move focus to the reveal's first action once the reel lands.
  useEffect(() => {
    if (revealed) revealRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [revealed]);

  const item = cosmeticById(win.won);
  const rarity: Rarity = item?.rarity ?? 'common';
  const rc = RARITY_COLOR[rarity];
  // Not dismissable until the reel has landed — the reveal is the payoff.
  return (
    <ModalShell
      label='Hat case'
      tone='amber'
      fixed
      z='z-[70]'
      size='xl'
      backdrop='heavy'
      onClose={revealed ? onClose : undefined}
    >
      {({ close }) => (
        <>
          <div className='-mb-1 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-amber-200/80' aria-live='polite'>
            {revealed ? (win.jackpot ? 'Jackpot!' : win.dupe ? 'Duplicate' : 'Unboxed!') : 'Opening case…'}
          </div>
          <div
            ref={vpRef}
            className='relative h-[140px] overflow-hidden border border-white/10 bg-black/50'
            style={{ maskImage: 'linear-gradient(90deg, transparent, black 12%, black 88%, transparent)' }}
          >
            <div className='lk-reel-marker' />
            <div
              className='absolute top-1/2 flex -translate-y-1/2'
              style={{
                gap: GAP,
                transform: `translateX(${offset}px)`,
                transition: offset !== 0 ? `transform ${SPIN_MS}ms cubic-bezier(0.12,0.85,0.18,1)` : 'none',
              }}
            >
              {reel.map((h, i) => (
                <ItemTile key={i} id={h.id} size={CARD} selected={revealed && i === LAND} />
              ))}
            </div>
          </div>
          {revealed && (
            <div ref={revealRef} className='lk-reveal flex flex-col items-center gap-1 text-center'>
              {win.jackpot && (
                <div className='lk-chip mb-1' style={{ background: '#ffc23d', color: '#1c1204' }}>
                  Case-exclusive jackpot
                </div>
              )}
              <div
                className='font-display text-3xl font-bold uppercase tracking-[0.06em]'
                style={{ color: rc.edge, textShadow: `0 0 22px ${rc.edge}88` }}
              >
                {item?.name ?? win.won}
              </div>
              <div className='font-mono text-[10px] uppercase tracking-[0.2em] text-white/50'>
                {RARITY_LABEL[rarity]} {item?.slot === 'unusual' ? 'unusual' : 'hat'}
              </div>
              {win.dupe && (
                <div className='mt-1 text-sm font-semibold text-amber-300'>
                  Already owned · refunded {win.refund} ⛁
                </div>
              )}
              <div className='mt-3 flex gap-3'>
                {!win.dupe && canEquip && (
                  <button
                    type='button'
                    className='lk-action lk-action-equip'
                    {...sfxProps('none')}
                    onClick={() => {
                      onEquip(win.won);
                      close();
                    }}
                  >
                    Equip now
                  </button>
                )}
                <button type='button' className='lk-action lk-action-muted' {...sfxProps('uiClick')} onClick={close}>
                  {win.dupe || !canEquip ? 'Nice' : 'Later'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}
