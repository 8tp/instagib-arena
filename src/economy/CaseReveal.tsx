// The unboxing. The server has already decided the item; this only stages it:
//   1. crate  — the crate drops, rattles, the lid cracks with light leaking in
//               the case's hue and bursts (~0.8 s). Doubles as the thumbnail
//               prewarm: the reel never starts until every cell's picture is
//               ready (capped, so a slow GPU can't stall it).
//   2. spin   — the reel decelerates onto the winner (rAF sampling a pure
//               time→position curve — no per-frame React), ticking per cell
//               with the pitch rising as it slows, a ghost strip for motion
//               blur while fast, and a slow creep over the last cell or so.
//   3. hold   — Legendary+ only: a beat on the landed cell (the slow-mo pause).
//   4. reveal — the item card, with juice escalating by tier (RevealFx).
// Click or Space skips straight to the reveal at any point. Reduced effects:
// no crate, a short reel, no flashes / shakes / particles.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ModalShell } from '../deck';
import { sfxProps } from '../deck-core';
import { playUi } from '../game/audio';
import { getThumbnail, peekThumbnail, prefetchThumbnails, thumbnailPending } from '../game/thumbs';
import { TIER_META, type ItemInstanceWire, type Tier } from '../game/items/types';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, isIridescent } from '../ui/rarity';
import type { CaseInfo, CasePay } from './api';
import { CASE_HUE } from './case-hue';
import { CrateArt } from './CrateArt';
import { SLOT_LABEL, defSeason, effectName, fmtCredits, instBaseName, instPrefixParts, instSlot, instTags, instTier, sheenInfo, thumbLook } from './display';
import { lookKey } from './look';
import { ItemPreviewModal, type PreviewSettings } from './ItemPreviewModal';
import { QualityMarks, TagPills, TierChip } from './parts';
import { canPreview, previewOfInst } from './preview-item';
import { buildReel, reelDuration, reelPos, reelProfile, reelVel, type ReelCell } from './reel-motion';
import { HoldFx, RevealFx, type FxOrigin } from './RevealFx';

const LEN = 48;
const LAND = 40; // reel index the winner sits at
const GAP = 10;
const CRATE_MS = 640; // drop → land → rattle → crack; the burst follows
const BURST_MS = 170;
const PREWARM_CAP_MS = 2600; // never hold the crate longer than this for thumbnails
const SPIN_S = 5.1;
const CREEP_S = 0.9;
const SHORT_SPIN_S = 1.0;

type Phase = 'crate' | 'spin' | 'hold' | 'reveal';
type CrateState = 'drop' | 'wait' | 'burst' | 'gone';

// How long the landed cell is held before the card, per tier (ms).
const HOLD_MS: Partial<Record<Tier, number>> = { legendary: 300, relic: 560, unobtainable: 1250 };

const KICKER: Record<Tier, string> = {
  common: 'Unboxed',
  uncommon: 'Unboxed',
  rare: 'Rare drop',
  epic: 'Epic drop',
  legendary: 'Legendary!',
  relic: 'Relic!!',
  unobtainable: 'Unobtainable',
};

// The land sting, composed from the UI bank (src/game/sfx/ui-sounds.ts).
function revealSfx(tier: Tier, unusual: boolean, held: boolean): number[] {
  const at = (ms: number, f: () => void) => window.setTimeout(f, ms);
  const ids: number[] = [];
  switch (tier) {
    case 'common':
      playUi('unlockCommon');
      break;
    case 'uncommon':
      playUi('caseReveal');
      ids.push(at(90, () => playUi('unlockCommon')));
      break;
    case 'rare':
      playUi('caseReveal');
      ids.push(at(90, () => playUi('unlockRare')));
      break;
    case 'epic':
      playUi('caseReveal');
      ids.push(at(60, () => playUi('unlockEpic')));
      break;
    case 'legendary':
      if (!held) playUi('unlockLegendary');
      playUi('caseReveal');
      break;
    case 'relic':
      if (!held) playUi('unlockLegendary');
      playUi('stamp', 1);
      break;
    case 'unobtainable':
      if (!held) playUi('unlockLegendary');
      playUi('stamp', 1);
      ids.push(at(520, () => playUi('levelUp')));
      break;
  }
  if (unusual && tier !== 'unobtainable') ids.push(at(460, () => playUi('levelUp')));
  return ids;
}

function useNarrow(): boolean {
  const [n] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  return n;
}

export function CaseReveal({
  caseDef,
  item,
  reduced,
  lowSpec = false,
  previewSettings,
  pay,
  credits,
  freeRolls,
  againPay,
  onAgain,
  onEquip,
  onLanded,
  onClose,
}: {
  caseDef: CaseInfo;
  item: ItemInstanceWire;
  reduced: boolean;
  lowSpec?: boolean;
  previewSettings?: PreviewSettings; // enables "Preview on you"
  pay: CasePay;
  credits: number;
  freeRolls: number;
  againPay: CasePay | null; // how "Open another" would pay (null = can't)
  onAgain: () => void;
  onEquip: (item: ItemInstanceWire) => void;
  onLanded: () => void;
  onClose: () => void;
}) {
  const narrow = useNarrow();
  const CARD = narrow ? 92 : 112;
  const STRIDE = CARD + GAP;
  const tier = instTier(item);
  const rank = TIER_META[tier].rank;
  const c = TIER_COLOR[tier];
  const hue = CASE_HUE[caseDef.id];
  const unusual = item.quality.includes('unusual');
  const look = thumbLook(item);
  const winKey = look ? lookKey(look) : item.def;

  // Teasers prefer defs whose thumbnail is already rendered (the Cases tab
  // prefetches the pool), so the prewarm below is usually instant.
  const [reel] = useState<ReelCell[]>(() => buildReel(caseDef, item, LEN, LAND, (id) => !thumbnailPending(id)));
  const keys = useMemo(() => [...new Set([winKey, ...reel.map((r) => r.def.id)])], [reel, winKey]);

  const [phase, setPhase] = useState<Phase>('crate');
  const [crate, setCrate] = useState<CrateState>('drop');
  const [origin, setOrigin] = useState<FxOrigin | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [crateAt, setCrateAt] = useState<FxOrigin | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Once the reveal juice has settled, the hero turns on its turntable.
  const [autoSpin, setAutoSpin] = useState(false);
  const vpRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>('crate');
  phaseRef.current = phase;
  const timers = useRef<number[]>([]);
  const raf = useRef(0);
  const geo = useRef({ vpW: 0, start: 0, target: 0, centre: 0 });
  const landedRef = useRef(false);
  const revealAt = useRef(0);
  const cuePlayed = useRef(false); // the Legendary+ cue already went out during the hold
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;

  const later = (ms: number, f: () => void) => {
    timers.current.push(window.setTimeout(f, ms));
  };
  const clearAll = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    cancelAnimationFrame(raf.current);
  };
  useEffect(() => clearAll, []);

  const place = (markerX: number) => {
    const x = geo.current.vpW / 2 - markerX;
    if (stripRef.current) stripRef.current.style.transform = `translate3d(${x}px,0,0)`;
  };

  // Geometry: where the marker starts and where it lands (a random spot in the
  // winning cell — biased to its far edge on low tiers, so the creep nearly
  // reaches the tease next door).
  useLayoutEffect(() => {
    const vpW = vpRef.current?.clientWidth ?? 520;
    const centre = LAND * STRIDE + CARD / 2;
    const edgeBias = rank <= 2 && Math.random() < 0.6;
    const jitter = reduced ? 0 : edgeBias ? CARD * (0.3 + Math.random() * 0.14) : (Math.random() - 0.5) * CARD * 0.7;
    const target = centre + jitter;
    const start = reduced ? target - 9 * STRIDE : vpW / 2 - STRIDE * 0.5;
    geo.current = { vpW, start, target, centre };
    place(start);
    const r = vpRef.current?.getBoundingClientRect();
    if (r) setCrateAt({ x: r.left + r.width / 2, y: r.top + r.height / 2 - 6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reveal ──
  const reveal = (wasSkipped: boolean) => {
    if (phaseRef.current === 'reveal') return;
    const held = cuePlayed.current;
    clearAll();
    place(geo.current.centre);
    phaseRef.current = 'reveal';
    revealAt.current = performance.now();
    setSkipped(wasSkipped);
    setPhase('reveal');
    if (!landedRef.current) {
      landedRef.current = true;
      onLandedRef.current();
    }
    timers.current.push(...revealSfx(tier, unusual, held));
  };

  // The reel stopped on the winner: a tier-dependent beat, then the card.
  const landed = () => {
    const cells = stripRef.current?.children;
    (cells?.[LAND] as HTMLElement | undefined)?.classList.add('is-won');
    const hold = reduced ? 0 : (HOLD_MS[tier] ?? 160);
    if (hold >= 300) {
      phaseRef.current = 'hold';
      setPhase('hold');
      if (tier === 'unobtainable') playUi('stamp', 0);
      else playUi('countdownTick', 1);
      // Time the legendary cue's riser so its hit lands with the card.
      later(Math.max(0, hold - 340), () => {
        cuePlayed.current = true;
        playUi('unlockLegendary');
      });
    }
    later(hold, () => reveal(false));
  };

  // ── Spin ──
  const spin = () => {
    phaseRef.current = 'spin';
    setPhase('spin');
    const g = geo.current;
    const total = reduced ? SHORT_SPIN_S : SPIN_S;
    const creep = reduced ? 0.25 : CREEP_S;
    const prof = reelProfile(g.target - g.start, total, creep, (reduced ? 0.3 : 1.1) * STRIDE);
    const dur = reelDuration(prof);
    const settle = reduced ? 0 : 0.28;
    const cells = stripRef.current?.children;
    const ghost = ghostRef.current;
    let t0 = -1;
    let lastIdx = -1;
    let lastTick = 0;
    const frame = (now: number) => {
      if (t0 < 0) t0 = now;
      const t = (now - t0) / 1000;
      let mx: number;
      let v = 0;
      if (t < dur) {
        mx = g.start + reelPos(prof, t);
        v = reelVel(prof, t);
      } else {
        // Settle: ease the marker onto the winner's centre.
        const k = Math.min(1, settle > 0 ? (t - dur) / settle : 1);
        const e = k * k * (3 - 2 * k);
        mx = g.target + (g.centre - g.target) * e;
      }
      place(mx);
      if (ghost) {
        const a = Math.min(0.42, Math.max(0, (v - 500) / 2400) * 0.5);
        ghost.style.opacity = a.toFixed(3);
        ghost.style.transform = `translate3d(${g.vpW / 2 - mx + Math.min(34, v * 0.013)}px,0,0)`;
      }
      const idx = Math.floor(mx / STRIDE);
      if (idx !== lastIdx && t < dur) {
        (cells?.[lastIdx] as HTMLElement | undefined)?.classList.remove('is-hot');
        (cells?.[idx] as HTMLElement | undefined)?.classList.add('is-hot');
        lastIdx = idx;
        if (now - lastTick > 26) {
          lastTick = now;
          playUi('caseTick', 1 - v / prof.v0);
        }
      }
      if (t >= dur + settle) {
        (cells?.[lastIdx] as HTMLElement | undefined)?.classList.remove('is-hot');
        if (ghost) ghost.style.opacity = '0';
        landed();
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };

  // ── Crate + prewarm ──
  useEffect(() => {
    let live = true;
    let ready = false;
    let crateDone = false;
    const go = () => {
      if (!live || phaseRef.current !== 'crate') return;
      if (reduced) {
        spin();
        return;
      }
      setCrate('burst');
      playUi('stamp', 0);
      later(BURST_MS - 40, spin);
      later(BURST_MS + 260, () => setCrate('gone'));
    };
    const maybeGo = () => {
      if (ready && crateDone) go();
    };
    prefetchThumbnails(keys, true);
    void Promise.all(keys.map((k) => getThumbnail(k))).then(() => {
      ready = true;
      maybeGo();
    });
    later(PREWARM_CAP_MS, () => {
      ready = true;
      maybeGo();
    });
    if (reduced) {
      crateDone = true;
      setCrate('gone');
      maybeGo();
    } else {
      later(200, () => playUi('equip'));
      later(400, () => playUi('modalOpen'));
      later(CRATE_MS, () => {
        crateDone = true;
        if (!ready) setCrate('wait');
        maybeGo();
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skip: click anywhere on the stage, or Space / Enter. Right after the card
  // lands, a mashed key is swallowed so it can't fire "Equip" by accident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k !== ' ' && k !== 'Enter' && k !== 'Spacebar') return;
      if (phaseRef.current !== 'reveal') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) reveal(true);
      } else if (performance.now() - revealAt.current < 450) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The card is in: measure the hero for the FX origin, then move focus in.
  useLayoutEffect(() => {
    if (phase !== 'reveal') return;
    const r = heroRef.current?.getBoundingClientRect();
    if (r) setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const t = window.setTimeout(() => cardRef.current?.querySelector<HTMLElement>('[data-action=reveal-equip]')?.focus({ preventScroll: true }), 460);
    const spinAt = window.setTimeout(() => setAutoSpin(true), tier === 'unobtainable' ? 2600 : 1500);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(spinAt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const revealed = phase === 'reveal';
  const fx = !reduced;
  const heroSize = narrow ? 172 : 216;
  const prefix = instPrefixParts(item);
  const tags = instTags(item);
  const fxName = effectName(item.attrs.effect);
  const season = defSeason(item.def);
  const slot = instSlot(item);
  const iri = isIridescent(tier);
  const status = revealed ? KICKER[tier] : phase === 'hold' ? '…' : `Opening ${caseDef.name}`;

  // Ghost strip (motion blur): plain cells with the cached pictures, no hooks.
  const ghostCells: ReactNode =
    fx && !lowSpec
      ? reel.map((r, i) => {
          const url = peekThumbnail(i === LAND ? winKey : r.def.id);
          return (
            <div key={i} className='ec-gcell' style={{ width: CARD, height: CARD, background: `radial-gradient(115% 85% at 50% 22%, ${TIER_COLOR[r.tier].from}, ${TIER_COLOR[r.tier].to} 78%)` }}>
              {url && <img src={url} alt='' draggable={false} />}
            </div>
          );
        })
      : null;

  const spent = pay === 'daily' ? 'Daily free case' : pay === 'roll' ? 'Free roll used' : `${fmtCredits(caseDef.cost)} spent`;
  const againText = againPay === 'roll' ? 'Open another · free roll' : againPay === 'credits' ? `Open another · ${fmtCredits(caseDef.cost)}` : 'Can’t afford another';

  return (
    <ModalShell
      label={`${caseDef.name} result`}
      tone='amber'
      fixed
      z='z-[70]'
      size='xl'
      width='w-[min(1180px,96vw)]'
      backdrop='heavy'
      scroll
      openSound='none'
      // The frame takes the tier's colour once the item is out (never before:
      // an early tint would leak the result mid-spin).
      className={revealed ? `ec-rv-frame ec-rv-frame-${tier}` : ''}
      panelClassName={revealed ? `ec-rv-framed ec-rv-frame-${tier}` : ''}
      onClose={revealed ? onClose : undefined}
    >
      {({ close }) => (
        <div
          className={`ec-rv ec-rv-${tier} is-${phase} crate-${crate} ${fx ? '' : 'is-reduced'} ${skipped ? 'is-skipped' : ''}`}
          style={{ '--rc': c.edge, '--ca': hue.a, '--cb': hue.b, '--cell': `${CARD}px` } as CSSProperties}
          onClick={revealed ? undefined : () => reveal(true)}
        >
          <div className='ec-rv-status' aria-live='polite'>
            <span className={revealed && iri ? 'ec-iri-text' : ''}>{status}</span>
          </div>

          {!revealed && (
            <div className='ec-stage'>
              <div ref={vpRef} className='ec-reel'>
                {ghostCells && (
                  <div ref={ghostRef} className='ec-reel-strip ec-reel-ghost' aria-hidden style={{ gap: GAP }}>
                    {ghostCells}
                  </div>
                )}
                <div ref={stripRef} className='ec-reel-strip' style={{ gap: GAP }}>
                  {reel.map((r, i) => (
                    <div key={i} className='ec-rcell' style={{ '--tc': TIER_COLOR[r.tier].edge, width: CARD, height: CARD } as CSSProperties}>
                      <ItemTile id={r.def.id} size={CARD} tier={r.tier} look={i === LAND ? look : undefined} season={false} />
                    </div>
                  ))}
                </div>
                <div className='ec-reel-marker' aria-hidden />
              </div>
              {fx &&
                crate !== 'gone' &&
                crateAt &&
                // Portalled so the crate, its glow and its rays can spill past
                // the dialog's clipped edges; centred on the reel it bursts into.
                createPortal(
                  <div
                    className={`ec-open-crate is-${crate}`}
                    style={{ left: crateAt.x, top: crateAt.y, '--ca': hue.a, '--cb': hue.b } as CSSProperties}
                    aria-hidden
                  >
                    <div className='ec-open-glow' />
                    <div className='ec-open-rays' />
                    <div className='ec-open-box'>
                      <CrateArt id={caseDef.id} a={hue.a} b={hue.b} size={narrow ? 150 : 200} seam />
                    </div>
                    <div className='ec-open-flash' />
                  </div>,
                  document.body,
                )}
              <div className='ec-skip'>{phase === 'hold' ? '' : 'Click or press Space to skip'}</div>
            </div>
          )}
          {phase === 'hold' && fx && <HoldFx tier={tier} />}

          {revealed && (
            <div ref={cardRef} className='ec-rv-card'>
              <div className='ec-rv-hero-wrap'>
                {fx && rank >= 2 && <div className={`ec-rv-rays ${iri ? 'ec-rays-iri' : ''}`} aria-hidden />}
                <div className='ec-rv-floor' aria-hidden />
                <div ref={heroRef} className='ec-rv-hero'>
                  <div className='ec-rv-hero-in'>
                    <ItemTile
                      id={item.def}
                      size={heroSize}
                      tier={tier}
                      look={look}
                      label={false}
                      season={false}
                      turntable={fx ? (autoSpin && !previewing ? 'play' : 'hover') : false}
                    />
                  </div>
                </div>
              </div>

              {unusual && (
                <div className='ec-rv-unusual'>
                  <span className='ec-rv-unusual-star'>★ Anomalous</span>
                  {fxName && <span className='ec-rv-unusual-fx'>{fxName}</span>}
                </div>
              )}

              <h3 className='ec-rv-name'>
                {prefix.map((p, i) => (
                  <span key={p.text} className='ec-rv-q' style={{ color: p.color, animationDelay: `${180 + i * 120}ms` }}>
                    {p.text}
                  </span>
                ))}
                <span className={`ec-rv-base ${iri ? 'ec-iri-text' : ''}`} style={iri ? undefined : { color: c.edge }}>
                  {instBaseName(item)}
                </span>
              </h3>

              <div className='ec-rv-meta'>
                <TierChip tier={tier} />
                <span className='ec-meta-chip'>{SLOT_LABEL[slot]}</span>
                <span className='ec-meta-chip font-mono'>Mint #{item.mint}</span>
                {season && <span className='ec-meta-chip ec-season-chip' title={season.title ? `${season.name} · ${season.title}` : season.name}>{season.name}</span>}
                <span className='flex gap-1'><QualityMarks inst={item} /></span>
              </div>

              {tags.length > 0 && (
                <div className='ec-rv-tags'>
                  <TagPills tags={tags.filter((t) => !(unusual && t.text === fxName))} />
                  {item.quality.includes('killstreak') && sheenInfo(item.attrs.sheen) && (
                    <div className='font-sans text-[12px] text-white/50'>Sheen: {sheenInfo(item.attrs.sheen)!.name}</div>
                  )}
                </div>
              )}

              <div className='ec-rv-spent'>
                {spent} · {caseDef.name} · {fmtCredits(credits)} · {freeRolls} free roll{freeRolls === 1 ? '' : 's'} left
              </div>
              <div className='ec-rv-actions'>
                <button type='button' className='lk-action lk-action-equip' data-action='reveal-equip' {...sfxProps('none')} onClick={() => { onEquip(item); close(); }}>
                  Equip now
                </button>
                {previewSettings && canPreview(item.def) && (
                  <button type='button' className='lk-action lk-action-ghost' data-action='reveal-preview' {...sfxProps('uiClick')} onClick={() => setPreviewing(true)}>
                    Preview
                  </button>
                )}
                <button type='button' className='lk-action lk-action-buy' data-action='open-again' disabled={!againPay} {...sfxProps('none')} onClick={onAgain}>
                  {againText}
                </button>
                <button type='button' className='lk-action lk-action-muted' data-action='to-inventory' {...sfxProps('uiClick')} onClick={close}>
                  To inventory
                </button>
              </div>
            </div>
          )}
          {revealed && fx && origin && (!skipped || rank >= 2 || unusual) && (
            <RevealFx tier={tier} unusual={unusual} origin={origin} lowSpec={lowSpec} name={instBaseName(item)} />
          )}
          {previewing && previewSettings && <ItemPreviewModal item={previewOfInst(item)} settings={previewSettings} onClose={() => setPreviewing(false)} />}
        </div>
      )}
    </ModalShell>
  );
}
