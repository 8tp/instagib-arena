// End-of-match rewards reveal: XP lines tick in with a rolling total → the XP
// bar fills (a flash + LEVEL stamp + fanfare per level gained) → Career Road
// reward cards flip in with a rarity sting → challenges → the credits count.
//
// Motion model: React state changes only at the timeline's event times (a few
// dozen over ~8 s, scheduled with setTimeout); everything that moves between
// them is a CSS animation that starts when its element's class/key appears
// (rewards.css). The two count-ups write textContent from rAF for their few
// hundred ms — never React state per frame. Layout is reserved up front (rows
// render invisible until their beat), so nothing below jumps as lines land.
import './rewards.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ProgressionResp } from '../../app-types';
import type { MatchResult } from '../../game/game';
import { playUi, type UiSoundName } from '../../game/audio';
import { RARITY_UNLOCK } from '../../game/sfx/ui-sounds';
import { OFFLINE_XP_SCALE } from '../../game/progression';
import { DeckButton, Skeleton } from '../../deck';
import { cosmeticById } from '../../game/cosmetics';
import { ItemTile } from '../item-tile';
import { RARITY_COLOR } from '../rarity';
import {
  buildRevealModel,
  buildTimeline,
  levelSpan,
  rarityRank,
  type RevealCard,
  type RevealModel,
  type RevealTimeline,
} from './reveal-model';

const cosmeticName = (id: string) => cosmeticById(id)?.name ?? id;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const signed = (n: number) => `${n < 0 ? '−' : '+'}${fmt(Math.abs(n))}`;

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

function buildCues(m: RevealModel, tl: RevealTimeline): { times: number[]; cues: Cue[] } {
  const cues: Cue[] = [];
  const cue = (at: number, name: UiSoundName, detail?: number) => cues.push({ at, run: () => playUi(name, detail) });
  m.lines.forEach((l, i) => cue(tl.lineAt[i], l.xp < 0 ? 'uiBack' : 'xpTick', i));
  m.segments.forEach((s, k) => {
    if (s.levelUp) cue(tl.seg[k].end, 'levelUp');
  });
  m.cards.forEach((c, i) => {
    if (c.kind === 'cosmetic') cue(tl.cardAt[i], RARITY_UNLOCK[rarityRank(c.rarity)]);
    else if (c.kind === 'credits') cue(tl.cardAt[i], 'purchase');
    else cue(tl.cardAt[i], 'caseReveal');
  });
  m.challenges.forEach((_, i) => cue(tl.challengeAt[i], 'uiConfirm'));
  if (m.credits > 0) cue(tl.creditsAt + 560, 'purchase');
  const times = [
    ...tl.lineAt,
    tl.totalAt,
    ...tl.seg.flatMap((s) => [s.start, s.end]),
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

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function Chip({ tone, children }: { tone: 'cyan' | 'amber' | 'emerald' | 'plain'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-amber-300/40 text-amber-200'
      : tone === 'emerald'
        ? 'border-emerald-300/50 bg-emerald-300/10 text-emerald-200'
        : tone === 'cyan'
          ? 'border-cyan-300/40 text-cyan-200'
          : 'border-white/15 text-white/55';
  return <span className={`deck-chip ${cls}`}>{children}</span>;
}

function XpBar({ m, tl, t }: { m: RevealModel; tl: RevealTimeline; t: number }) {
  // The segment currently shown: the last one whose fill has started.
  let k = -1;
  for (let i = 0; i < tl.seg.length; i++) if (t >= tl.seg[i].start) k = i;
  const seg = k >= 0 ? m.segments[k] : m.segments[0];
  const segT = k >= 0 ? tl.seg[k] : null;
  const barDone = k === m.segments.length - 1 && segT !== null && t >= segT.end;
  // Level shown on the badge: bumps the moment a wrap lands.
  let level = m.levelBefore;
  m.segments.forEach((s, i) => {
    if (s.levelUp && t >= tl.seg[i].end) level = s.level + 1;
  });
  const holdingWrap = !!segT && seg.levelUp && t >= segT.end; // between a wrap and the next fill
  const dur = segT ? segT.end - segT.start : 0;
  const vars = { '--rw-from': seg.from, '--rw-to': seg.to, '--rw-dur': `${dur}ms` } as CSSProperties;
  const { into, span } = levelSpan(
    barDone ? m.totalAfter : m.totalBefore,
    barDone ? m.levelAfter : m.levelBefore,
  );
  // The "into" readout climbs with the fill of the active segment.
  const segSpan = levelSpan(m.totalBefore, seg.level).span || span;
  const readInto = k < 0 ? into : barDone ? into : Math.round((holdingWrap ? 1 : seg.to) * segSpan);
  const readSpan = k < 0 || barDone ? span : segSpan;
  const latestWrap = (() => {
    let w = -1;
    m.segments.forEach((s, i) => {
      if (s.levelUp && t >= tl.seg[i].end) w = i;
    });
    return w;
  })();
  const maxed = span === 0 && barDone;

  return (
    <div className='relative'>
      <div className='flex items-center gap-3'>
        <div
          key={level}
          className={`grid h-11 w-11 shrink-0 place-items-center border font-display text-xl font-bold tabular-nums ${
            level > m.levelBefore ? 'rw-badge-tick border-emerald-300/70 bg-emerald-300/15 text-emerald-100' : 'border-cyan-300/40 bg-cyan-300/[0.08] text-cyan-100'
          }`}
          aria-label={`Level ${level}`}
        >
          {level}
        </div>
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
          <div className='mt-1.5 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-white/45'>
            <span className='tabular-nums'>
              {maxed ? (
                'Max level'
              ) : (
                <>
                  <CountUp key={`i${k}:${barDone ? 1 : 0}`} value={readInto} from={k < 0 || barDone ? readInto : Math.round(seg.from * segSpan)} ms={holdingWrap || barDone ? 0 : dur} /> /{' '}
                  {fmt(readSpan)} XP
                </>
              )}
            </span>
            {!maxed && !holdingWrap && <span>Next: Lv {level + 1}</span>}
          </div>
        </div>
      </div>
      {latestWrap >= 0 && (
        <>
          <div key={`f${latestWrap}`} className='rw-flash' />
          <div key={`s${latestWrap}`} className='pointer-events-none absolute inset-x-0 -top-2 bottom-3 grid place-items-center'>
            <span
              className='rw-lvstamp border border-emerald-300/80 bg-[#04140d] px-5 py-1 font-display text-2xl font-bold uppercase tracking-[0.2em] text-emerald-100'
              style={{ boxShadow: '0 0 34px rgba(52,211,153,0.55), inset 0 0 18px rgba(52,211,153,0.25)' }}
            >
              Level {m.segments[latestWrap].level + 1}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function KeyGlyph() {
  return (
    <svg width='34' height='34' viewBox='0 0 24 24' aria-hidden='true' className='text-sky-200'>
      <circle cx='8' cy='12' r='4.2' fill='none' stroke='currentColor' strokeWidth='2' />
      <path d='M12 12h9M18 12v3.5M15.5 12v2.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='square' />
    </svg>
  );
}

function RewardCardView({ c, size }: { c: RevealCard; size: number }) {
  const CARD = size;
  const caption = (text: string, color: string) => (
    <div className='mt-1 truncate text-center font-mono text-[9px] font-bold uppercase tracking-[0.14em]' style={{ color }}>
      {text}
    </div>
  );
  if (c.kind === 'cosmetic') {
    const col = RARITY_COLOR[c.rarity];
    const style = { '--rw-glow': `${col.edge}cc` } as CSSProperties;
    return (
      <div className='rw-card' style={style} role='img' aria-label={`${cosmeticName(c.id)}, ${c.rarity}, level ${c.level} reward`}>
        <div className='rw-card-burst' />
        {c.rarity === 'legendary' && <div className='rw-card-rays' />}
        <div className='rw-card-body'>
          {(c.rarity === 'epic' || c.rarity === 'legendary') && <div className='rw-card-halo' />}
          <ItemTile id={c.id} size={CARD} />
          {c.rarity === 'legendary' && <div className='rw-card-shine' />}
        </div>
        {caption(`Lv ${c.level}`, col.edge)}
      </div>
    );
  }
  if (c.kind === 'credits') {
    const style = { '--rw-glow': '#fbbf24aa' } as CSSProperties;
    return (
      <div className='rw-card' style={style}>
        <div className='rw-card-burst' />
        <div
          className='rw-card-body flex flex-col items-center justify-center'
          style={{ width: CARD, height: CARD, background: 'radial-gradient(120% 90% at 50% 20%, #7a4a0b, #2a1703)', boxShadow: 'inset 0 0 0 1px #fbbf2466' }}
        >
          <span className={`font-display font-bold tabular-nums text-amber-200 ${CARD < 80 ? 'text-xl' : 'text-2xl'}`}>+{fmt(c.amount)}</span>
          <span className='font-mono text-[9px] uppercase tracking-[0.16em] text-amber-200/70'>Credits</span>
        </div>
        {caption(`Lv ${c.level}`, '#fcd34dcc')}
      </div>
    );
  }
  const style = { '--rw-glow': '#60a5facc' } as CSSProperties;
  return (
    <div className='rw-card' style={style}>
      <div className='rw-card-burst' />
      <div
        className='rw-card-body flex flex-col items-center justify-center gap-1'
        style={{ width: CARD, height: CARD, background: 'radial-gradient(120% 90% at 50% 20%, #1d4f8f, #0a1a33)', boxShadow: 'inset 0 0 0 1px #60a5fa66' }}
      >
        <KeyGlyph />
        <span className='text-center font-mono text-[9px] uppercase leading-tight tracking-[0.12em] text-sky-100/80'>Case key</span>
      </div>
      {caption(`Lv ${c.level}`, '#7dd3fccc')}
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

  const cardSize = m.cards.length > 4 ? 64 : 78;
  const visibleLines = m.lines.filter((_, i) => t >= tl.lineAt[i]);
  const shownTotal = t >= tl.totalAt ? m.xp : visibleLines.length ? visibleLines[visibleLines.length - 1].running : 0;
  const leveled = m.levelAfter > m.levelBefore;
  const guest = !m.saved;
  const instant = skipped;

  const summary = done
    ? `${guest ? 'You would have earned' : 'Earned'} ${m.xp} XP${m.credits ? ` and ${m.credits} credits` : ''}${
        leveled ? `, reaching level ${m.levelAfter}` : ''
      }${m.cards.length ? `. ${m.cards.length} Career Road reward${m.cards.length > 1 ? 's' : ''}` : ''}.`
    : '';

  return (
    <div ref={rootRef} className={`rw-root flex flex-col gap-3 ${reduced ? 'rw-reduced' : ''} ${skipped ? 'rw-skip' : ''} ${guest ? 'rw-guest' : ''}`}>
      {/* Header: the rolling total, with its qualifiers on the right. */}
      <div>
        {guest && <div className='deck-label mb-1'>You would have earned</div>}
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
            {m.offline && <Chip tone='amber'>Offline · XP ×{OFFLINE_XP_SCALE}</Chip>}
            {guest && <Chip tone='plain'>Not saved</Chip>}
            {leveled && t >= tl.seg[tl.seg.length - 1].end && (
              <span className='rw-fade'>
                <Chip tone='emerald'>Level up</Chip>
              </span>
            )}
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
                <span className='truncate font-sans text-[13px] text-white/85'>{l.label}</span>
                <span className='font-mono text-[11px] tabular-nums text-white/40'>{l.detail ?? ''}</span>
                <span className={`text-right font-display text-[15px] font-bold tabular-nums ${l.xp < 0 ? 'text-amber-300' : 'text-cyan-200'}`}>
                  {on && <span className='rw-line-xp'>{signed(l.xp)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className='font-mono text-[11px] text-white/45'>No XP this match.</p>
      )}

      {/* XP bar (wraps once per level gained). */}
      <div data-beat={t >= tl.seg[0].start ? 'on' : undefined}>
        <XpBar m={m} tl={tl} t={t} />
      </div>

      {/* Career Road rewards. */}
      {m.cards.length > 0 && (
        <div>
          <div className='deck-label mb-2'>{guest ? 'Career Road · would unlock' : 'Career Road'}</div>
          <div className={`flex flex-wrap ${m.cards.length > 4 ? 'gap-2' : 'gap-2.5'}`}>
            {m.cards.map((c, i) => (
              <div
                key={c.key}
                data-beat={t >= tl.cardAt[i] ? 'on' : undefined}
                style={{ width: cardSize }}
                className={t >= tl.cardAt[i] ? '' : 'invisible'}
              >
                {t >= tl.cardAt[i] ? <RewardCardView c={c} size={cardSize} /> : <div style={{ height: cardSize + 17 }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Challenges completed by this match. */}
      {m.challenges.length > 0 && (
        <div>
          <div className='deck-label mb-1.5'>Challenges</div>
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
                <span className='min-w-0 flex-1 truncate font-sans text-[12.5px] text-white/85'>{c.label}</span>
                {c.xp > 0 && <span className='font-display text-[13px] font-bold tabular-nums text-cyan-200'>+{fmt(c.xp)} XP</span>}
                {c.credits > 0 && <span className='font-display text-[13px] font-bold tabular-nums text-amber-200'>+{fmt(c.credits)} ⛁</span>}
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
        <span className='deck-label'>Credits</span>
        <span className='flex items-baseline gap-3'>
          <span className='font-display text-2xl font-bold tabular-nums text-amber-200'>
            +{t >= tl.creditsAt ? <CountUp value={m.credits} ms={560} instant={instant} /> : '0'} ⛁
          </span>
          {m.balance !== null && (
            <span className='font-mono text-[10px] uppercase tracking-[0.14em] text-white/40'>Balance {fmt(m.balance)}</span>
          )}
        </span>
      </div>

      {/* Guests: nothing above is kept — say so, and offer the fix. */}
      {guest && (
        <div
          data-beat={t >= tl.ctaAt ? 'on' : undefined}
          className={`clip-deck-sm border border-cyan-300/35 bg-cyan-300/[0.06] px-3.5 py-3 ${t >= tl.ctaAt ? 'rw-cta' : 'invisible'}`}
        >
          <p className='mb-2.5 font-sans text-[12.5px] leading-snug text-white/75'>
            Guest matches aren&apos;t saved. Log in and your XP, level and unlocks stick.
          </p>
          {onLogin ? (
            <DeckButton solid accent='cyan' size='sm' center full onClick={onLogin}>
              Log in to keep your progress
            </DeckButton>
          ) : (
            <p className='font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/80'>Log in from the main menu to keep your progress.</p>
          )}
        </div>
      )}

      <p className={`font-mono text-[10px] uppercase tracking-[0.16em] text-white/30 ${done ? 'invisible' : ''}`}>
        Click or press Space to skip
      </p>
      <p className='sr-only' aria-live='polite'>
        {summary}
      </p>
    </div>
  );
}

// Placeholder column while the server's reward reply is in flight (or, after a
// few seconds without one, a quiet note instead of an endless shimmer).
export function RewardsPending({ gaveUp }: { gaveUp: boolean }) {
  if (gaveUp) {
    return (
      <div className='rw-root flex flex-col gap-2'>
        <span className='deck-label'>Rewards</span>
        <p className='font-mono text-[11px] text-white/45'>No rewards for this match.</p>
      </div>
    );
  }
  return (
    <div className='rw-root rw-wait flex flex-col gap-3' aria-busy='true'>
      <span className='deck-label'>Tallying rewards</span>
      <Skeleton className='h-11 w-40' />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className='h-4 w-full' />
      ))}
      <Skeleton className='mt-2 h-3.5 w-full' />
    </div>
  );
}
