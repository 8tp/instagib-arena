// The unboxing: a reel of the case's items that decelerates onto the
// server-decided winner (CSS transition — no per-frame React), then a big
// tier-coloured reveal with quality / unusual callouts. Relic and Unobtainable
// drops get a special reveal (flash, rays, sparks; iridescent for the latter).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell } from '../deck';
import { sfxProps, uiSfx } from '../deck-core';
import { playUi } from '../game/audio';
import { casePoolFor, itemDef, vaultUnobtainables, type ItemDef } from '../game/items/catalog';
import { TIERS, TIER_META, type ItemInstanceWire, type Tier } from '../game/items/types';
import { ItemTile } from '../ui/item-tile';
import type { CaseInfo } from './api';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import { effectName, fmtCredits, instBaseName, instFullName, instSlot, instTags, instTier, sheenInfo, thumbLook } from './display';
import { QualityMarks, TagPills } from './parts';

const LAND = 44; // reel index the winner is placed at
const LEN = 52;
const CARD = 112;
const GAP = 10;
const STRIDE = CARD + GAP;

// A believable reel: tiers drawn from the case's own odds (so the teasers
// look like what the case actually holds), the winner fixed at LAND.
function buildReel(c: CaseInfo, won: ItemInstanceWire): { def: ItemDef; tier: Tier }[] {
  const pool = casePoolFor(c.slots);
  const byTier = (t: Tier) => (t === 'unobtainable' ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)) : pool.filter((d) => d.tier === t));
  const draw = (): ItemDef => {
    let r = Math.random();
    for (const t of TIERS) {
      r -= c.odds[t];
      if (r < 0) {
        const list = byTier(t);
        if (list.length) return list[Math.floor(Math.random() * list.length)];
      }
    }
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const wonDef = itemDef(won.def)!;
  const out: { def: ItemDef; tier: Tier }[] = [];
  for (let i = 0; i < LEN; i++) {
    if (i === LAND) out.push({ def: wonDef, tier: instTier(won) });
    else {
      // A rare-tier tease right next to the winner sells the near miss.
      const d = i === LAND + 1 || i === LAND - 1 ? (pool.filter((x) => TIER_META[x.tier].rank >= 3 && x.tier !== 'unobtainable')[0] ?? draw()) : draw();
      out.push({ def: d, tier: d.tier });
    }
  }
  return out;
}

export function CaseReveal({
  caseDef,
  item,
  reduced,
  lowSpec = false,
  usedRoll,
  credits,
  freeRolls,
  canAgain,
  onAgain,
  onEquip,
  onLanded,
  onClose,
}: {
  caseDef: CaseInfo;
  item: ItemInstanceWire;
  reduced: boolean;
  lowSpec?: boolean;
  usedRoll: boolean;
  credits: number;
  freeRolls: number;
  canAgain: boolean;
  onAgain: () => void;
  onEquip: (item: ItemInstanceWire) => void;
  onLanded: () => void;
  onClose: () => void;
}) {
  const reel = useMemo(() => buildReel(caseDef, item), [caseDef, item]);
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const vpRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const SPIN_MS = reduced ? 900 : 4600;
  const tier = instTier(item);
  const big = tier === 'relic' || tier === 'unobtainable';
  const c = TIER_COLOR[tier];

  useEffect(() => {
    const vp = vpRef.current?.clientWidth ?? 520;
    const jitter = reduced ? 0 : (Math.random() - 0.5) * (CARD * 0.55);
    const target = LAND * STRIDE + CARD / 2 - vp / 2 + jitter;
    const a = requestAnimationFrame(() => requestAnimationFrame(() => setOffset(-target)));
    let t2 = 0;
    const t = window.setTimeout(() => {
      setRevealed(true);
      onLanded();
      uiSfx('caseReveal');
      t2 = window.setTimeout(() => playUi('unlock', TIER_META[tier].rank), 140);
    }, SPIN_MS + 120);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(t);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (revealed) revealRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [revealed]);

  const tags = instTags(item);
  const unusual = item.quality.includes('unusual');
  const fx = effectName(item.attrs.effect);
  const sparks = useMemo(
    () => Array.from({ length: big ? 28 : 0 }, (_, i) => ({ a: `${(i / 28) * 360 + Math.random() * 12}deg`, d: `${170 + Math.random() * 190}px`, dl: `${Math.random() * 0.18}s` })),
    [big],
  );

  return (
    <ModalShell label={`${caseDef.name} result`} tone='amber' fixed z='z-[70]' size='xl' width='w-[min(1240px,96vw)]' backdrop='heavy' onClose={revealed ? onClose : undefined}>
      {({ close }) => (
        <div className={`ec-reveal-wrap ${revealed && big && !reduced ? 'ec-big' : ''}`} style={{ ['--rc' as string]: c.edge }}>
          {revealed && big && !reduced && <div className='ec-flash' aria-hidden />}
          <div className='mb-2 text-center font-sans text-[14px] font-medium text-amber-200/85' aria-live='polite'>
            {revealed ? (unusual ? 'Unusual!' : big ? `${TIER_LABEL[tier]}!` : 'Unboxed!') : `Opening ${caseDef.name}…`}
          </div>
          <div
            ref={vpRef}
            className='relative h-[140px] overflow-hidden border border-white/10 bg-black/50'
            style={{ maskImage: 'linear-gradient(90deg, transparent, black 12%, black 88%, transparent)' }}
          >
            <div className='lk-reel-marker' />
            <div
              className='absolute top-1/2 flex -translate-y-1/2'
              style={{ gap: GAP, transform: `translateX(${offset}px)`, transition: offset !== 0 ? `transform ${SPIN_MS}ms cubic-bezier(0.12,0.85,0.18,1)` : 'none' }}
            >
              {reel.map((r, i) =>
                // Thumbnails only where the eye can rest: the first screen, the
                // approach to the landing cell and the landing cell itself (on
                // lowSpec just the last few). The rest are tier-colour cells.
                (lowSpec ? Math.abs(i - LAND) <= 4 : i < 10 || Math.abs(i - LAND) <= 7) ? (
                  <ItemTile key={i} id={r.def.id} size={CARD} tier={r.tier} look={i === LAND ? thumbLook(item) : undefined} selected={revealed && i === LAND} />
                ) : (
                  <div key={i} className='ec-reel-ph' style={{ width: CARD, height: CARD, ['--a' as string]: TIER_COLOR[r.tier].from, ['--b' as string]: TIER_COLOR[r.tier].to, ['--e' as string]: TIER_COLOR[r.tier].edge }}>
                    <span>{r.def.name}</span>
                  </div>
                ),
              )}
            </div>
          </div>
          {revealed && (
            <div ref={revealRef} className='lk-reveal relative mt-4 flex flex-col items-center gap-1.5 text-center'>
              {big && !reduced && (
                <div className='ec-burst' aria-hidden>
                  <div className={`ec-rays ${isIridescent(tier) ? 'ec-rays-iri' : ''}`} />
                  {sparks.map((s, i) => (
                    <span key={i} className='lk-spark' style={{ ['--a' as string]: s.a, ['--d' as string]: s.d, ['--dl' as string]: s.dl }} />
                  ))}
                </div>
              )}
              <div className='relative z-[1] flex flex-col items-center gap-1.5'>
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
                  className={`font-display text-[34px] font-bold uppercase leading-[1.02] tracking-[0.05em] ${isIridescent(tier) ? 'ec-iri-text' : ''}`}
                  style={isIridescent(tier) ? undefined : { color: c.edge, textShadow: `0 0 26px ${c.edge}99` }}
                >
                  {instFullName(item)}
                </div>
                <div className='font-sans text-[13px] text-white/55'>
                  {TIER_LABEL[tier]} {instSlot(item) === 'finish' ? 'railgun finish' : instSlot(item) === 'beam' ? 'rail beam' : instSlot(item)}
                  {' · '}
                  {instBaseName(item)}
                </div>
                {(unusual || item.quality.length > 0) && (
                  <div className='mt-1 flex flex-col items-center gap-1.5'>
                    {unusual && fx && (
                      <div className='ec-callout' style={{ color: '#c58bff', borderColor: '#a855f7' }}>
                        ✦ UNUSUAL · {fx}
                      </div>
                    )}
                    <TagPills tags={tags.filter((t) => !(unusual && t.text === fx))} />
                    {item.quality.includes('killstreak') && sheenInfo(item.attrs.sheen) && (
                      <div className='font-sans text-[12px] text-white/50'>Sheen: {sheenInfo(item.attrs.sheen)!.name}</div>
                    )}
                  </div>
                )}
                <div className='mt-1 font-sans text-[13px] text-white/50'>
                  {usedRoll ? 'Free roll used' : `${fmtCredits(caseDef.cost)} spent`} · {fmtCredits(credits)} · {freeRolls} free roll{freeRolls === 1 ? '' : 's'} left
                </div>
                <div className='mt-3 flex flex-wrap justify-center gap-3'>
                  <button type='button' className='lk-action lk-action-equip' data-action='reveal-equip' {...sfxProps('none')} onClick={() => { onEquip(item); close(); }}>
                    Equip now
                  </button>
                  <button type='button' className='lk-action lk-action-buy' data-action='open-again' disabled={!canAgain} {...sfxProps('none')} onClick={onAgain}>
                    {canAgain ? 'Open again' : 'Can’t afford another'}
                  </button>
                  <button type='button' className='lk-action lk-action-muted' {...sfxProps('uiClick')} onClick={close}>
                    To inventory
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
