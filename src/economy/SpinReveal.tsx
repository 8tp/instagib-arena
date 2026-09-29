// The Daily Spin result: same visual language as the case reveal — a tier-lit
// item card (relic / unobtainable get flash, rays and sparks), a credit burst
// for credit wins, and a ticket for a free roll. Shown only after the wheel
// has landed.
import { useEffect, useMemo, useRef } from 'react';
import { ModalShell } from '../deck';
import { sfxProps, uiSfx } from '../deck-core';
import { playUi } from '../game/audio';
import { TIER_META, type ItemInstanceWire, type SpinKind, type SpinResult } from '../game/items/types';
import { TicketGlyph } from '../menu/RewardTile';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import { ItemTile } from '../ui/item-tile';
import { effectName, fmtCredits, instBaseName, instFullName, instSlot, instTags, instTier, thumbLook } from './display';
import { QualityMarks, TagPills } from './parts';

export type SpinWin = Extract<SpinResult, { ok: true }>;

const GOLD = '#ffc23d';

export function SpinReveal({
  win,
  kind,
  reduced,
  credits,
  cost,
  canAgain,
  onAgain,
  onEquip,
  onClose,
}: {
  win: SpinWin;
  kind: SpinKind;
  reduced: boolean;
  credits: number;
  cost: number;
  canAgain: boolean;
  onAgain: () => void;
  onEquip: (item: ItemInstanceWire) => void;
  onClose: () => void;
}) {
  const item = win.gained.item;
  const tier = item ? instTier(item) : 'common';
  const big = !!item && (tier === 'relic' || tier === 'unobtainable');
  const c = item ? TIER_COLOR[tier] : { edge: win.gained.roll ? '#22d3ee' : GOLD };
  const ref = useRef<HTMLDivElement>(null);
  const sparks = useMemo(
    () => Array.from({ length: big || win.gained.credits ? 26 : 0 }, (_, i) => ({ a: `${(i / 26) * 360 + Math.random() * 12}deg`, d: `${150 + Math.random() * 170}px`, dl: `${Math.random() * 0.16}s` })),
    [big, win.gained.credits],
  );

  useEffect(() => {
    uiSfx('caseReveal');
    const t = window.setTimeout(() => playUi(win.gained.credits ? 'purchase' : 'unlock', item ? TIER_META[tier].rank : 1), 140);
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = item ? (item.quality.includes('unusual') ? 'Unusual!' : big ? `${TIER_LABEL[tier]}!` : 'You won!') : win.gained.credits ? 'Credits!' : 'Free roll!';
  const tags = item ? instTags(item) : [];
  const fx = item ? effectName(item.attrs.effect) : null;
  const unusual = !!item?.quality.includes('unusual');

  return (
    <ModalShell label='Daily Spin result' tone='amber' fixed z='z-[70]' size='lg' width='w-[min(760px,96vw)]' backdrop='heavy' onClose={onClose}>
      {({ close }) => (
        <div className={`ec-reveal-wrap ${big && !reduced ? 'ec-big' : ''}`} style={{ ['--rc' as string]: c.edge }}>
          {big && !reduced && <div className='ec-flash' aria-hidden />}
          <div className='mb-2 text-center font-sans text-[14px] font-medium text-amber-200/85' aria-live='polite'>
            {title}
          </div>
          <div ref={ref} className='lk-reveal relative flex flex-col items-center gap-1.5 text-center'>
            {!reduced && (big || win.gained.credits) && (
              <div className='ec-burst' aria-hidden>
                {big && <div className={`ec-rays ${isIridescent(tier) ? 'ec-rays-iri' : ''}`} />}
                {sparks.map((s, i) => (
                  <span key={i} className='lk-spark' style={{ ['--a' as string]: s.a, ['--d' as string]: s.d, ['--dl' as string]: s.dl }} />
                ))}
              </div>
            )}
            <div className='relative z-[1] flex flex-col items-center gap-1.5'>
              {item ? (
                <>
                  <div className='ec-hero' style={{ ['--rc' as string]: c.edge }}>
                    <ItemTile id={item.def} size={140} tier={tier} look={thumbLook(item)} label={false} />
                  </div>
                  <div className='flex items-center gap-2'>
                    <span className={`lk-chip ${isIridescent(tier) ? 'ec-iri-chip' : ''}`} style={isIridescent(tier) ? undefined : { background: c.edge, color: tier === 'common' || tier === 'legendary' || tier === 'uncommon' ? '#0a0b0e' : '#fff' }}>
                      {TIER_LABEL[tier]}
                    </span>
                    <span className='font-mono text-[13px] text-white/60'>Mint #{item.mint}</span>
                    <span className='flex gap-1'><QualityMarks inst={item} /></span>
                  </div>
                  <div
                    className={`font-display text-[32px] font-bold uppercase leading-[1.02] tracking-[0.05em] ${isIridescent(tier) ? 'ec-iri-text' : ''}`}
                    style={isIridescent(tier) ? undefined : { color: c.edge, textShadow: `0 0 26px ${c.edge}99` }}
                  >
                    {instFullName(item)}
                  </div>
                  <div className='font-sans text-[13px] text-white/55'>
                    {TIER_LABEL[tier]} {instSlot(item) === 'finish' ? 'railgun finish' : instSlot(item) === 'beam' ? 'rail beam' : instSlot(item)} · {instBaseName(item)}
                  </div>
                  {(unusual || item.quality.length > 0) && (
                    <div className='mt-1 flex flex-col items-center gap-1.5'>
                      {unusual && fx && (
                        <div className='ec-callout' style={{ color: '#c58bff', borderColor: '#a855f7' }}>
                          ✦ UNUSUAL · {fx}
                        </div>
                      )}
                      <TagPills tags={tags.filter((t) => !(unusual && t.text === fx))} />
                    </div>
                  )}
                </>
              ) : win.gained.credits ? (
                <>
                  <div className='sp-coin' aria-hidden>⛁</div>
                  <div className='font-display text-[54px] font-bold leading-none tracking-[0.04em]' style={{ color: GOLD, textShadow: `0 0 30px ${GOLD}99` }}>
                    +{win.gained.credits.toLocaleString()} ⛁
                  </div>
                  <div className='font-sans text-[13px] text-white/55'>Credits added to your balance</div>
                </>
              ) : (
                <>
                  <div className='sp-coin sp-coin-roll' aria-hidden><TicketGlyph size={52} /></div>
                  <div className='font-display text-[46px] font-bold uppercase leading-none tracking-[0.05em]' style={{ color: '#67e8f9', textShadow: '0 0 28px #22d3ee88' }}>
                    +1 free roll
                  </div>
                  <div className='font-sans text-[13px] text-white/55'>Open any standard case for free — find it under Cases.</div>
                </>
              )}
              <div className='mt-1 font-sans text-[13px] text-white/50'>
                {kind === 'premium' ? `${fmtCredits(cost)} spent · ` : ''}
                {fmtCredits(credits)} · {win.freeRolls} free roll{win.freeRolls === 1 ? '' : 's'}
              </div>
              <div className='mt-3 flex flex-wrap justify-center gap-3'>
                {item && (
                  <button type='button' className='lk-action lk-action-equip' data-action='reveal-equip' {...sfxProps('none')} onClick={() => { onEquip(item); close(); }}>
                    Equip now
                  </button>
                )}
                {kind === 'premium' && (
                  <button type='button' className='lk-action lk-action-buy' data-action='spin-again' disabled={!canAgain} {...sfxProps('none')} onClick={onAgain}>
                    {canAgain ? `Spin again · ${fmtCredits(cost)}` : 'Can’t afford another'}
                  </button>
                )}
                <button type='button' className='lk-action lk-action-muted' {...sfxProps('uiClick')} onClick={close}>
                  {item ? 'To inventory' : 'Nice'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
