// End-of-match rewards reveal: XP lines tick in with a rolling total → the XP
// bar fills (a flash per wrap) → ONE level-up takeover presents the new level
// and the best reward large → Career Road cards deal into the column →
// challenges → the credits count.
//
// Motion model: React state changes only at the timeline's event times (a few
// dozen over ~10 s, scheduled with setTimeout); everything that moves between
// them is a CSS animation that starts when its element's class/key appears
// (rewards.css). The count-ups write textContent from rAF for their few
// hundred ms — never React state per frame. Layout is reserved up front (rows
// render invisible until their beat), so nothing below jumps as lines land.
//
// Type rule (critic round 1): caps only for surface titles, buttons and short
// state chips; section labels are sentence case at 13–14 px; nothing < 12 px.
import './rewards.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ProgressionResp } from '../../app-types';
import type { MatchResult } from '../../game/game';
import { playUi, type UiSoundName } from '../../game/audio';
import { RARITY_UNLOCK } from '../../game/sfx/ui-sounds';
import { OFFLINE_XP_SCALE } from '../../game/progression';
import { cosmeticById, type CosmeticSlot } from '../../game/cosmetics';
import { DeckButton, Skeleton } from '../../deck';
import { ItemTile } from '../item-tile';
import { RARITY_COLOR } from '../rarity';
import {
  buildRevealModel,
  buildTimeline,
  isDense,
  levelSpan,
  rarityRank,
  type RevealCard,
  type RevealModel,
  type RevealTimeline,
} from './reveal-model';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const signed = (n: number) => `${n < 0 ? '−' : '+'}${fmt(Math.abs(n))}`;
const cosmeticName = (id: string) => cosmeticById(id)?.name ?? id;

const SLOT_NAME: Record<CosmeticSlot, string> = {
  killEffect: 'Finisher',
  railColor: 'Rail beam',
  railgunFinish: 'Railgun finish',
  hat: 'Hat',
  unusual: 'Unusual',
  card: 'Player card',
  emote: 'Emote',
  nameColor: 'Name colour',
  spawnEffect: 'Spawn effect',
  title: 'Title',
  announcer: 'Announcer',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Why +224 XP can pay out eleven levels of rewards (after the curve change).
const CATCH_UP_REASON = "Includes rewards for levels you'd already reached on the new curve.";
const levelRange = (a: number, b: number) => (a === b ? `Lv ${a}` : `Lv ${a}–${b}`);

/* ── Shared primitives ──────────────────────────────────────────────────── */

// Currency is always "⛁ 1,234" (a gain: "+⛁ 1,234").
export function Credits({ n, gain = false, className = '' }: { n: number; gain?: boolean; className?: string }) {
  return (
    <span className={`whitespace-nowrap tabular-nums ${className}`}>
      {gain && '+'}
      <span aria-hidden='true'>⛁</span>
      <span className='sr-only'>credits</span> {fmt(n)}
    </span>
  );
}

// The level emblem: the menu's filled, corner-cut badge ("Lv" over the number,
// like the profile badge).
// `xl` is the takeover's hero numeral.
export function LevelEmblem({
  level,
  size = 'sm',
  guest = false,
  className = '',
}: {
  level: number;
  size?: 'sm' | 'xl';
  guest?: boolean;
  className?: string;
}) {
  return (
    <span className={`rw-level rw-level-${size} ${guest ? 'rw-level-guest' : ''} ${className}`} aria-label={`Level ${level}`}>
      <span className='rw-level-cap' aria-hidden='true'>
        Lv
      </span>
      <span className='rw-level-num'>{level}</span>
    </span>
  );
}

function Chip({ tone, children }: { tone: 'cyan' | 'amber' | 'emerald' | 'plain'; children: ReactNode }) {
  return <span className={`rw-chip rw-chip-${tone}`}>{children}</span>;
}

/* ── Count-up ───────────────────────────────────────────────────────────── */

// Eases the displayed number from wherever it is to `value` over `ms`, writing
// textContent directly (React renders the first value once and never again).
function CountUp({ value, ms = 320, from = 0, instant = false }: { value: number; ms?: number; from?: number; instant?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(from);
  const [initial] = useState(() => fmt(from));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = shown.current;
    if (instant || a === value || ms <= 0) {
      shown.current = value;
      el.textContent = fmt(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      shown.current = a + (value - a) * e;
      el.textContent = fmt(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
      else shown.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, instant]);
  return <span ref={ref}>{initial}</span>;
}

/* ── Clock ──────────────────────────────────────────────────────────────── */

type Cue = { at: number; run: () => void };

// The reveal's "now" in ms since mount, advanced only at event times. Cues run
// inside those same timers (never during render). `freezeAt` (the lab) stops
// the clock at a given moment so a screenshot is deterministic.
function useRevealClock(times: number[], cues: Cue[], skipped: boolean, freezeAt?: number): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (skipped) return;
    const stops = [...new Set(times)].filter((x) => freezeAt === undefined || x <= freezeAt).sort((a, b) => a - b);
    const ids = stops.map((at) =>
      window.setTimeout(() => {
        setT(at);
        for (const c of cues) if (c.at === at) c.run();
      }, at),
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [times, cues, skipped, freezeAt]);
  return skipped ? Number.POSITIVE_INFINITY : t;
}

// Delay from the takeover's start to its reward tiles flipping in (the sting).
const TO_TILE_MS = 620;
// Column card sizes: the spotlit hero(es) and the small tiles beside them.
const SPOT = 110;
const SMALL = 72;

function cardSting(c: RevealCard): UiSoundName {
  if (c.kind === 'cosmetic') return RARITY_UNLOCK[rarityRank(c.rarity)];
  return c.kind === 'credits' ? 'purchase' : 'caseReveal';
}

function buildCues(m: RevealModel, tl: RevealTimeline): { times: number[]; cues: Cue[] } {
  const cues: Cue[] = [];
  const cue = (at: number, name: UiSoundName, detail?: number) => cues.push({ at, run: () => playUi(name, detail) });
  m.lines.forEach((l, i) => cue(tl.lineAt[i], l.xp < 0 ? 'uiBack' : 'xpTick', i));
  // Early wraps get a bright tick; the last one's fanfare belongs to the takeover.
  m.segments.forEach((s, k) => {
    if (s.levelUp && !(tl.takeover && tl.takeover.start - tl.seg[k].end < 400)) cue(tl.seg[k].end, 'xpTick', 10);
  });
  if (tl.takeover) {
    cue(tl.takeover.start, 'levelUp');
    if (m.spotlight[0]) cue(tl.takeover.start + TO_TILE_MS, cardSting(m.spotlight[0]));
  }
  // Cards already presented by the takeover (or a dense catch-up deal) tick up
  // the ladder; otherwise each gets its rarity sting.
  const brisk = !!tl.takeover || isDense(m);
  let tick = 0;
  m.cards.forEach((c, i) => {
    if (brisk) cue(tl.cardAt[i], 'xpTick', Math.min(12, tick++));
    else cue(tl.cardAt[i], cardSting(c));
  });
  m.challenges.forEach((_, i) => cue(tl.challengeAt[i], 'uiConfirm'));
  if (m.credits > 0) cue(tl.creditsAt + 560, 'purchase');
  const times = [
    ...tl.lineAt,
    tl.totalAt,
    ...tl.seg.flatMap((s) => [s.start, s.end]),
    ...(tl.takeover ? [tl.takeover.start, tl.takeover.end] : []),
    ...tl.cardAt,
    ...tl.challengeAt,
    tl.creditsAt,
    tl.creditsAt + 560,
    tl.ctaAt,
    tl.doneAt,
    ...cues.map((c) => c.at),
  ];
  return { times, cues };
}

/* ── XP bar ─────────────────────────────────────────────────────────────── */

function XpBar({ m, tl, t }: { m: RevealModel; tl: RevealTimeline; t: number }) {
  // The segment currently shown: the last one whose fill has started.
  let k = -1;
  for (let i = 0; i < tl.seg.length; i++) if (t >= tl.seg[i].start) k = i;
  const seg = k >= 0 ? m.segments[k] : m.segments[0];
  const segT = k >= 0 ? tl.seg[k] : null;
  const barDone = k === m.segments.length - 1 && segT !== null && t >= segT.end;
  // Level shown on the emblem: bumps the moment a wrap lands.
  let level = m.levelBefore;
  let latestWrap = -1;
  m.segments.forEach((s, i) => {
    if (s.levelUp && t >= tl.seg[i].end) {
      level = s.level + 1;
      latestWrap = i;
    }
  });
  const holdingWrap = !!segT && seg.levelUp && t >= segT.end; // between a wrap and the next fill
  const dur = segT ? segT.end - segT.start : 0;
  const vars = { '--rw-from': seg.from, '--rw-to': seg.to, '--rw-dur': `${dur}ms` } as CSSProperties;
  const { into, span } = levelSpan(barDone ? m.totalAfter : m.totalBefore, barDone ? m.levelAfter : m.levelBefore);
  // The "into" readout climbs with the fill of the active segment.
  const segSpan = levelSpan(m.totalBefore, seg.level).span || span;
  const readInto = k < 0 ? into : barDone ? into : Math.round((holdingWrap ? 1 : seg.to) * segSpan);
  const readSpan = k < 0 || barDone ? span : segSpan;
  const maxed = span === 0 && barDone;
  const leveled = m.levelAfter > m.levelBefore;

  return (
    <div className='relative'>
      <div className='flex items-center gap-3'>
        <LevelEmblem key={level} level={level} guest={!m.saved} className={level > m.levelBefore ? 'rw-badge-tick' : ''} />
        <div className='min-w-0 flex-1'>
          <div className='rw-track'>
            <div className='rw-fill rw-fill-base' style={{ transform: `scaleX(${k < 0 ? m.segments[0].from : seg.from})` }} />
            {k >= 0 && (
              <>
                <div key={`g${k}`} className='rw-fill rw-fill-gain' style={vars} />
                <div key={`h${k}`} className='rw-head' style={vars} />
              </>
            )}
            <div className='rw-track-notch' />
          </div>
          <div className='mt-1.5 flex items-baseline justify-between gap-3 text-[12px] text-white/50'>
            <span className='font-mono tabular-nums'>
              {maxed ? (
                'Max level'
              ) : (
                <>
                  <CountUp
                    key={`i${k}:${barDone ? 1 : 0}`}
                    value={readInto}
                    from={k < 0 || barDone ? readInto : Math.round(seg.from * segSpan)}
                    ms={holdingWrap || barDone ? 0 : dur}
                  />{' '}
                  / {fmt(readSpan)} XP
                </>
              )}
            </span>
            {barDone && leveled ? (
              <span className='rw-fade font-display text-[14px] font-semibold text-emerald-200'>
                Lv {m.levelBefore} → {m.levelAfter}
              </span>
            ) : (
              !maxed && !holdingWrap && <span className='font-sans'>Next: Lv {level + 1}</span>
            )}
          </div>
        </div>
      </div>
      {latestWrap >= 0 && <div key={`f${latestWrap}`} className='rw-flash' />}
    </div>
  );
}

/* ── Reward cards ───────────────────────────────────────────────────────── */

function KeyGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' className='text-sky-200'>
      <circle cx='8' cy='12' r='4.2' fill='none' stroke='currentColor' strokeWidth='2' />
      <path d='M12 12h9M18 12v3.5M15.5 12v2.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='square' />
    </svg>
  );
}

// The card face alone (no caption): a cosmetic tile, a credits drop or a key.
function CardFace({ c, size }: { c: RevealCard; size: number }) {
  if (c.kind === 'cosmetic') return <ItemTile id={c.id} size={size} label={false} />;
  if (c.kind === 'credits') {
    return (
      <div
        className='flex flex-col items-center justify-center'
        style={{ width: size, height: size, background: 'radial-gradient(120% 90% at 50% 20%, #7a4a0b, #2a1703)', boxShadow: 'inset 0 0 0 1px #fbbf2466' }}
      >
        <span aria-hidden='true' className='leading-none text-amber-200/80' style={{ fontSize: Math.round(size * 0.3) }}>
          ⛁
        </span>
        <span className='font-display font-bold tabular-nums leading-tight text-amber-100' style={{ fontSize: Math.max(13, Math.round(size * 0.2)) }}>
          {fmt(c.amount)}
        </span>
      </div>
    );
  }
  return (
    <div
      className='flex flex-col items-center justify-center'
      style={{ width: size, height: size, background: 'radial-gradient(120% 90% at 50% 20%, #1d4f8f, #0a1a33)', boxShadow: 'inset 0 0 0 1px #60a5fa66' }}
    >
      <KeyGlyph size={Math.round(size * 0.46)} />
    </div>
  );
}

function cardGlow(c: RevealCard): string {
  if (c.kind === 'cosmetic') return `${RARITY_COLOR[c.rarity].edge}cc`;
  return c.kind === 'credits' ? '#fbbf24aa' : '#60a5facc';
}

function cardName(c: RevealCard): string {
  if (c.kind === 'cosmetic') return cosmeticName(c.id);
  return c.kind === 'credits' ? `${fmt(c.amount)} credits` : 'Case key';
}

function cardAria(c: RevealCard): string {
  const what = c.kind === 'cosmetic' ? `${cosmeticName(c.id)}, ${c.rarity}` : cardName(c);
  return `${what}, level ${c.level} reward`;
}

// A reward card in the column: the face with its reveal (flip + rarity burst;
// epic/legendary halo; legendary rays + shine), then a sentence-case caption.
function RewardCardView({ c, size, captioned = true }: { c: RevealCard; size: number; captioned?: boolean }) {
  const rarity = c.kind === 'cosmetic' ? c.rarity : null;
  const edge = c.kind === 'cosmetic' ? RARITY_COLOR[c.rarity].edge : c.kind === 'credits' ? '#fcd34d' : '#7dd3fc';
  return (
    <div className='rw-card' style={{ '--rw-glow': cardGlow(c) } as CSSProperties} role='img' aria-label={cardAria(c)}>
      <div className='rw-card-burst' />
      {rarity === 'legendary' && <div className='rw-card-rays' />}
      <div className='rw-card-body'>
        {(rarity === 'epic' || rarity === 'legendary') && <div className='rw-card-halo' />}
        <CardFace c={c} size={size} />
        {rarity === 'legendary' && <div className='rw-card-shine' />}
      </div>
      {captioned && (
        <div className='mt-1 text-[12px] leading-tight'>
          {size >= 78 && <div className='truncate text-white/85'>{cardName(c)}</div>}
          <div className='font-mono tabular-nums' style={{ color: edge }}>
            Lv {c.level}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Level-up takeover ──────────────────────────────────────────────────── */

// The one beat that stops and presents the new level: a hero emblem, "Lv 6 → 7"
// and the best reward(s) large, then it collapses back into the column. It is
// absolutely positioned against the dialog panel (no positioned ancestor sits
// between the reveal and the ModalShell panel), so it covers the whole results
// dialog without scrolling with it — also inside a fullscreened game root.
function LevelTakeover({ m }: { m: RevealModel }) {
  const leveled = m.levelAfter > m.levelBefore;
  const two = m.spotlight.length > 1;
  const tile = two ? 184 : 224;
  const rewardCount = m.cards.length;
  const more = rewardCount - m.spotlight.length;
  return (
    <div className='rw-takeover absolute inset-0 z-20 flex items-center justify-center overflow-hidden font-sans' role='status'>
      <div className='rw-takeover-scrim absolute inset-0' />
      <div className='rw-takeover-body relative flex flex-col items-center gap-7 px-6 lg:flex-row lg:gap-16'>
        <div className='flex flex-col items-center text-center'>
          <div className='rw-to-emblem'>
            <LevelEmblem level={m.levelAfter} size='xl' guest={!m.saved} />
          </div>
          <div className='rw-to-title mt-4 font-display text-[2.6rem] font-bold uppercase leading-none tracking-[0.14em] text-emerald-200'>
            {leveled ? 'Level up' : 'Career Road'}
          </div>
          <div className='rw-to-sub mt-2.5 font-display text-[20px] font-semibold text-white/85'>
            {leveled ? `Lv ${m.levelBefore} → ${m.levelAfter}` : `Lv ${m.levelAfter}`}
            {rewardCount > 0 && <span className='text-white/50'> · {rewardCount} reward{rewardCount === 1 ? '' : 's'}</span>}
          </div>
          {m.catchUp && <div className='rw-to-sub mt-2 max-w-[22rem] text-[14px] text-white/55'>{CATCH_UP_REASON}</div>}
          {!m.saved && <div className='rw-to-sub mt-2 text-[14px] text-amber-200/80'>Not saved · log in to keep it</div>}
        </div>
        {m.spotlight.length > 0 && (
          <div className='flex flex-col items-center gap-3'>
            <div className='flex items-start gap-5'>
              {m.spotlight.map((c, i) => (
                <div key={c.key} className='rw-to-tile flex flex-col items-center' style={{ animationDelay: `${TO_TILE_MS + i * 180}ms`, width: tile }}>
                  <div className='rw-card' style={{ '--rw-glow': cardGlow(c) } as CSSProperties} role='img' aria-label={cardAria(c)}>
                    <div className='rw-card-burst' style={{ animationDelay: `${TO_TILE_MS + 80 + i * 180}ms` }} />
                    {c.kind === 'cosmetic' && c.rarity === 'legendary' && <div className='rw-card-rays' />}
                    {c.kind === 'cosmetic' && rarityRank(c.rarity) >= 2 && <div className='rw-card-halo' />}
                    <CardFace c={c} size={tile} />
                  </div>
                  <div className='mt-3 max-w-full truncate font-display text-[22px] font-semibold leading-tight text-white'>{cardName(c)}</div>
                  <div className='mt-0.5 text-[14px]' style={{ color: c.kind === 'cosmetic' ? RARITY_COLOR[c.rarity].edge : '#cbd5e1' }}>
                    {c.kind === 'cosmetic' ? `${cap(c.rarity)} ${SLOT_NAME[cosmeticById(c.id)?.slot ?? 'hat'].toLowerCase()}` : c.kind === 'case' ? 'One free hat-case opening' : 'Credits'}
                    <span className='text-white/40'> · Lv {c.level}</span>
                  </div>
                </div>
              ))}
            </div>
            {more > 0 && <div className='rw-to-sub text-[14px] text-white/55'>+{more} more below</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── The column ─────────────────────────────────────────────────────────── */

export function RewardsReveal({
  progression,
  result = null,
  offline,
  skipped,
  reduced,
  startMs = 750,
  freezeAt,
  onDone,
  onLogin,
}: {
  progression: ProgressionResp;
  result?: MatchResult | null;
  offline?: boolean;
  skipped: boolean;
  reduced: boolean;
  startMs?: number;
  freezeAt?: number; // /rewardslab: stop the clock here for a deterministic shot
  onDone?: () => void;
  onLogin?: () => void;
}) {
  const m = useMemo(() => buildRevealModel(progression, { result, offline }), [progression, result, offline]);
  const [start] = useState(startMs);
  const tl = useMemo(() => buildTimeline(m, start), [m, start]);
  const { times, cues } = useMemo(() => buildCues(m, tl), [m, tl]);
  const t = useRevealClock(times, cues, skipped, freezeAt);
  const done = t >= tl.doneAt;

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (done) onDoneRef.current?.();
  }, [done]);

  // Skipping lands on the end state with one summary cue instead of the run.
  const skipCueRef = useRef(false);
  useEffect(() => {
    if (!skipped || skipCueRef.current) return;
    skipCueRef.current = true;
    const leveled = m.levelAfter > m.levelBefore;
    const best = m.cards.reduce((r, c) => (c.kind === 'cosmetic' ? Math.max(r, rarityRank(c.rarity)) : r), -1);
    playUi(best >= 2 ? RARITY_UNLOCK[best] : leveled ? 'levelUp' : best >= 0 ? RARITY_UNLOCK[best] : 'uiConfirm');
  }, [skipped, m]);

  // Keep the newest beat in view when the column runs below the fold (narrow
  // layouts, long reveals) — until the player scrolls on their own.
  const rootRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const stop = () => {
      followRef.current = false;
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchmove', stop, { passive: true });
    return () => {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
    };
  }, []);
  useEffect(() => {
    if (!followRef.current || skipped) return;
    const beats = rootRef.current?.querySelectorAll('[data-beat="on"]');
    const last = beats && beats.length ? beats[beats.length - 1] : null;
    last?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [t, skipped, reduced]);

  // The best 1–2 rewards lead the list as hero tiles; the rest fill a fixed
  // grid beside them, capped at two rows with a "+N more" tile so the column
  // never runs past the fold (catch-up can pay a dozen).
  const heroes = m.spotlight;
  const rest = m.cards.filter((c) => !heroes.includes(c));
  const smallCols = heroes.length > 1 ? 1 : 3;
  const slots = smallCols * 2;
  const shownRest = rest.length > slots ? rest.slice(0, slots - 1) : rest;
  const moreCount = rest.length - shownRest.length;
  const firstRoadLevel = m.cards.length ? Math.min(...m.cards.map((c) => c.level)) : m.levelAfter;
  const lastRoadLevel = m.cards.length ? Math.max(...m.cards.map((c) => c.level)) : m.levelAfter;
  const visibleLines = m.lines.filter((_, i) => t >= tl.lineAt[i]);
  const shownTotal = t >= tl.totalAt ? m.xp : visibleLines.length ? visibleLines[visibleLines.length - 1].running : 0;
  const guest = !m.saved;
  const instant = skipped;
  const inTakeover = !!tl.takeover && t >= tl.takeover.start && t < tl.takeover.end;
  const cardOn = (c: RevealCard) => t >= tl.cardAt[m.cards.indexOf(c)];

  const summary = done
    ? `${guest ? 'You would have earned' : 'Earned'} ${m.xp} XP${m.credits ? ` and ${m.credits} credits` : ''}${
        m.levelAfter > m.levelBefore ? `, reaching level ${m.levelAfter}` : ''
      }${m.cards.length ? `. ${m.cards.length} Career Road reward${m.cards.length > 1 ? 's' : ''}` : ''}.`
    : '';

  return (
    <div ref={rootRef} className={`rw-root flex flex-col gap-3 font-sans ${reduced ? 'rw-reduced' : ''} ${skipped ? 'rw-skip' : ''} ${guest ? 'rw-guest' : ''}`}>
      {/* Header: the rolling total, with its qualifiers on the right. */}
      <div>
        {guest && <div className='rw-label mb-1'>You would have earned</div>}
        <div className='flex items-end justify-between gap-3'>
          <div className='flex items-baseline gap-2'>
            <span
              key={shownTotal}
              className={`rw-bump font-display text-[2.75rem] font-bold leading-none tabular-nums ${guest ? 'text-cyan-200/80' : 'text-cyan-200'}`}
              style={{ textShadow: '0 0 24px rgba(34,211,238,0.35)' }}
            >
              +<CountUp value={shownTotal} ms={220} instant={instant} />
            </span>
            <span className='font-display text-xl font-bold uppercase text-cyan-200/70'>XP</span>
          </div>
          <span className='mb-1 flex flex-wrap justify-end gap-1.5'>
            {m.offline && <Chip tone='amber'>Practice ×{OFFLINE_XP_SCALE}</Chip>}
            {guest && <Chip tone='plain'>Not saved</Chip>}
          </span>
        </div>
      </div>

      {/* Itemized lines (reserved up front, revealed on their beat). */}
      {m.lines.length > 0 ? (
        <ul className='flex flex-col'>
          {m.lines.map((l, i) => {
            const on = t >= tl.lineAt[i];
            return (
              <li
                key={`${l.key}:${i}`}
                data-beat={on ? 'on' : undefined}
                className={`grid grid-cols-[minmax(0,1fr)_auto_4.25rem] items-baseline gap-3 border-t border-white/[0.06] py-[2px] ${on ? 'rw-line' : 'invisible'}`}
              >
                <span className='flex min-w-0 items-center gap-1.5 font-sans text-[13px] text-white/85'>
                  {l.key === 'challenge' && (
                    <span aria-hidden='true' className='grid h-3.5 w-3.5 shrink-0 place-items-center bg-emerald-400 text-[10px] font-bold leading-none text-zinc-950'>
                      ✓
                    </span>
                  )}
                  <span className='truncate'>{l.label}</span>
                </span>
                {l.key === 'challenge' && l.credits ? (
                  <Credits n={l.credits} gain className='font-mono text-[12px] text-amber-200/80' />
                ) : (
                  <span className='font-mono text-[12px] tabular-nums text-white/40'>{l.detail ?? ''}</span>
                )}
                <span className={`text-right font-display text-[15px] font-bold tabular-nums ${l.xp < 0 ? 'text-amber-300' : 'text-cyan-200'}`}>
                  {on && <span className='rw-line-xp'>{signed(l.xp)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className='text-[13px] text-white/50'>No XP this match.</p>
      )}

      {/* XP bar (a flash per level gained; the takeover owns the big beat). */}
      <div data-beat={t >= tl.seg[0].start ? 'on' : undefined}>
        <XpBar m={m} tl={tl} t={t} />
      </div>

      {/* Career Road rewards. */}
      {m.cards.length > 0 && (
        <div>
          <div className='mb-2'>
            <div className='flex items-baseline justify-between gap-2'>
              <span className='rw-label'>{guest ? 'Career Road · would unlock' : 'Career Road'}</span>
              <span className='text-[13px] text-white/50'>
                {m.cards.length} reward{m.cards.length === 1 ? '' : 's'} · {levelRange(firstRoadLevel, lastRoadLevel)}
              </span>
            </div>
            {m.catchUp && <p className='mt-0.5 text-[13px] leading-snug text-white/45'>{CATCH_UP_REASON}</p>}
          </div>
          <div
            className='grid gap-2'
            style={{ gridTemplateColumns: `repeat(${heroes.length}, ${SPOT}px) repeat(${smallCols}, ${SMALL}px)`, gridAutoRows: 'min-content' }}
          >
            {heroes.map((c) => (
              <div key={c.key} data-beat={cardOn(c) ? 'on' : undefined} className={`row-span-2 ${cardOn(c) ? '' : 'invisible'}`}>
                {cardOn(c) ? <RewardCardView c={c} size={SPOT} /> : <div style={{ height: SPOT + 36 }} />}
              </div>
            ))}
            {shownRest.map((c) => (
              <div key={c.key} data-beat={cardOn(c) ? 'on' : undefined} className={cardOn(c) ? '' : 'invisible'}>
                {cardOn(c) ? <RewardCardView c={c} size={SMALL} /> : <div style={{ height: SMALL + 20 }} />}
              </div>
            ))}
            {moreCount > 0 && (
              <div className={cardOn(rest[rest.length - 1]) ? 'rw-fade' : 'invisible'}>
                <div
                  className='deck-card flex flex-col items-center justify-center'
                  style={{ width: SMALL, height: SMALL }}
                  title={rest
                    .slice(shownRest.length)
                    .map((c) => `${cardName(c)} (Lv ${c.level})`)
                    .join(', ')}
                >
                  <span className='font-display text-[22px] font-bold leading-none text-white/85'>+{moreCount}</span>
                  <span className='mt-0.5 text-[12px] text-white/50'>more</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Challenges completed by this match. */}
      {m.challenges.length > 0 && (
        <div>
          <div className='rw-label mb-1.5'>Challenges</div>
          <ul className='flex flex-col gap-1'>
            {m.challenges.map((c, i) => (
              <li
                key={c.id}
                data-beat={t >= tl.challengeAt[i] ? 'on' : undefined}
                className={`deck-card flex items-center gap-2.5 px-2.5 py-1.5 ${t >= tl.challengeAt[i] ? 'rw-row' : 'invisible'}`}
              >
                <span className='rw-check grid h-5 w-5 shrink-0 place-items-center bg-emerald-400 text-[12px] font-bold text-zinc-950' aria-hidden='true'>
                  ✓
                </span>
                <span className='min-w-0 flex-1 truncate font-sans text-[13px] text-white/85'>{c.label}</span>
                {c.xp > 0 && <span className='font-display text-[14px] font-bold tabular-nums text-cyan-200'>+{fmt(c.xp)} XP</span>}
                {c.credits > 0 && <Credits n={c.credits} gain className='font-display text-[14px] font-bold text-amber-200' />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Credits. */}
      <div
        data-beat={t >= tl.creditsAt ? 'on' : undefined}
        className={`flex items-baseline justify-between border-t border-white/10 pt-2.5 ${t >= tl.creditsAt ? 'rw-fade' : 'invisible'}`}
      >
        <span className='rw-label'>Credits</span>
        <span className='flex items-baseline gap-3'>
          <span className='font-display text-2xl font-bold tabular-nums text-amber-200'>
            +<span aria-hidden='true'>⛁</span> {t >= tl.creditsAt ? <CountUp value={m.credits} ms={560} instant={instant} /> : '0'}
          </span>
          {m.balance !== null && (
            <span className='text-[13px] text-white/50'>
              Balance <Credits n={m.balance} className='text-white/70' />
            </span>
          )}
        </span>
      </div>

      {/* Guests: nothing above is kept — say so, and offer the fix. */}
      {guest && (
        <div
          data-beat={t >= tl.ctaAt ? 'on' : undefined}
          className={`clip-deck-sm border border-cyan-300/35 bg-cyan-300/[0.06] px-3.5 py-3 ${t >= tl.ctaAt ? 'rw-cta' : 'invisible'}`}
        >
          <p className='mb-2.5 font-sans text-[13px] leading-snug text-white/75'>
            Guest matches aren&apos;t saved. Log in and your XP, level and unlocks stick.
          </p>
          {onLogin ? (
            <DeckButton solid accent='cyan' size='sm' center full onClick={onLogin}>
              Log in to keep your progress
            </DeckButton>
          ) : (
            <p className='text-[13px] text-cyan-200/80'>Log in from the main menu to keep your progress.</p>
          )}
        </div>
      )}

      <p className={`text-[13px] text-white/35 ${done ? 'invisible' : ''}`}>Click or press Space to skip</p>
      <p className='sr-only' aria-live='polite'>
        {summary}
      </p>

      {inTakeover && tl.takeover && <LevelTakeover key={tl.takeover.start} m={m} />}
    </div>
  );
}

// Placeholder column while the server's reward reply is in flight (or, after a
// few seconds without one, a quiet note instead of an endless shimmer).
export function RewardsPending({ gaveUp }: { gaveUp: boolean }) {
  if (gaveUp) {
    return (
      <div className='rw-root flex flex-col gap-2 font-sans'>
        <span className='rw-label'>Rewards</span>
        <p className='text-[13px] text-white/50'>No rewards for this match.</p>
      </div>
    );
  }
  return (
    <div className='rw-root rw-wait flex flex-col gap-3 font-sans' aria-busy='true'>
      <span className='rw-label'>Tallying rewards</span>
      <Skeleton className='h-11 w-40' />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className='h-4 w-full' />
      ))}
      <Skeleton className='mt-2 h-3.5 w-full' />
    </div>
  );
}
