import { memo, useEffect, useRef, useState } from 'react';

// Q3-style loading screen: the levelshot full-bleed, the map name huge, the
// mode line, a checklist of REAL load steps (driven by the caller from engine
// signals), a rotating gameplay tip, and a thin progress rule along the bottom.
// When `complete` it holds for the rest of `minMs`, fades out, then calls
// onGone. Motion is CSS only (levelshot push-in, fades); nothing per-frame.

export type LoadStep = { id: string; label: string; done: boolean };

const TIPS: readonly string[] = [
  'The rail always kills. Stay moving — a still target is a free frag.',
  'Right-click near a wall or floor to boost-jump off it.',
  'Dash (Shift) snaps you sideways instantly — break an enemy’s aim.',
  'Jump into a wall mid-air to wall-jump for height and speed.',
  'The railgun recharges for 1.2 s after every shot. Count your enemy’s too.',
  'Frags while airborne earn Mid-air. Headshots flash amber.',
  'Hold Tab for the scoreboard. Esc frees the mouse.',
  'Double-jump in the air to change your arc — or save it to dodge.',
  'Fight from high ground: rails are easier to land downward.',
];

const FADE_MS = 420;

export const LoadingScreen = memo(function LoadingScreen({
  levelshot,
  kicker,
  title,
  sub,
  steps,
  complete,
  minMs = 900,
  holdMs = 0,
  shotWaitMs = 600,
  onGone,
  tips = true,
  reduced = false,
}: {
  levelshot: string | null;
  kicker: string; // mode line above the map name
  title: string; // the map name
  sub?: string; // e.g. "Room ABC123" / "Next map"
  steps: LoadStep[];
  complete: boolean;
  minMs?: number; // never flash: stay at least this long after first paint
  holdMs?: number; // extra hold after complete (interstitials)
  shotWaitMs?: number; // max extra wait for the levelshot to land
  onGone: () => void;
  tips?: boolean;
  reduced?: boolean; // reducedEffects: no levelshot push-in
}) {
  const [leaving, setLeaving] = useState(false);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // The minimum hold counts from the first frame the player actually SAW,
  // not from mount: the match boot (arena build, lightmap bake, shader
  // compile) blocks the main thread right after mount, and timing from mount
  // let a fast offline start spend its whole minimum frozen and then vanish.
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setShownAt(performance.now()));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  // Give the levelshot a short window to land so the screen reads as a
  // levelshot, never longer than shotWaitMs past the minimum.
  const hasShot = levelshot !== null;
  useEffect(() => {
    if (!complete || shownAt === null) return;
    const now = performance.now();
    const minLeft = Math.max(0, shownAt + minMs - now);
    const shotLeft = hasShot || minMs === 0 ? 0 : Math.max(0, shownAt + minMs + shotWaitMs - now);
    const wait = Math.max(minLeft, shotLeft) + holdMs;
    let gone = 0;
    const t = window.setTimeout(() => {
      setLeaving(true);
      gone = window.setTimeout(() => onGoneRef.current(), FADE_MS);
    }, wait);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(gone);
    };
  }, [complete, shownAt, minMs, holdMs, hasShot, shotWaitMs]);

  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    if (!tips) return;
    const id = window.setInterval(() => setTip((t) => (t + 1) % TIPS.length), 5200);
    return () => window.clearInterval(id);
  }, [tips]);

  const done = steps.filter((s) => s.done).length;
  const firstOpen = steps.findIndex((s) => !s.done);
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 100;

  return (
    <div
      role='status'
      aria-live='polite'
      aria-label={`Loading ${title}`}
      className={`ls-root absolute inset-0 z-[70] overflow-hidden bg-[#040507] text-white${leaving ? ' ls-out' : ''}${
        reduced ? ' ls-reduced' : ''
      }`}
    >
      {levelshot ? (
        <img src={levelshot} alt='' aria-hidden='true' className='ls-shot absolute inset-0 h-full w-full object-cover' />
      ) : (
        <div aria-hidden='true' className='ls-placeholder absolute inset-0' />
      )}
      <div aria-hidden='true' className='ls-scrim absolute inset-0' />

      <div className='absolute left-6 top-5 flex items-center gap-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.3em] text-white/55 sm:left-12 sm:top-8'>
        <svg viewBox='0 0 32 32' width='16' height='16' aria-hidden='true' className='text-cyan-300'>
          <circle cx='16' cy='16' r='9' fill='none' stroke='currentColor' strokeWidth='2.5' />
          <line x1='16' y1='3' x2='16' y2='11' stroke='currentColor' strokeWidth='2.5' />
          <line x1='16' y1='21' x2='16' y2='29' stroke='currentColor' strokeWidth='2.5' />
          <line x1='3' y1='16' x2='11' y2='16' stroke='currentColor' strokeWidth='2.5' />
          <line x1='21' y1='16' x2='29' y2='16' stroke='currentColor' strokeWidth='2.5' />
        </svg>
        Instagib Arena
      </div>

      <div className='absolute inset-x-6 bottom-10 flex flex-col gap-8 sm:inset-x-12 sm:bottom-14 lg:flex-row lg:items-end lg:justify-between'>
        <div className='min-w-0'>
          <div className='font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-300'>{kicker}</div>
          <div className='ls-title mt-2 truncate'>{title}</div>
          {sub && <div className='mt-2 font-mono text-[11px] uppercase tracking-[0.22em] text-white/55'>{sub}</div>}
          {tips && (
            <p key={tip} className='ls-tip mt-6 max-w-xl text-[15px] leading-snug text-white/75'>
              <span className='mr-3 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-amber-300'>Tip</span>
              {TIPS[tip]}
            </p>
          )}
        </div>
        <ol className='w-full max-w-[21rem] shrink-0 font-mono text-[12px] uppercase tracking-[0.14em]'>
          {steps.map((s, i) => {
            const active = i === firstOpen;
            return (
              <li key={s.id} className='flex items-baseline gap-2 py-[3px]'>
                <span className={s.done ? 'text-white/80' : active ? 'text-white' : 'text-white/35'}>{s.label}</span>
                <span aria-hidden='true' className='ls-leader min-w-4 flex-1' />
                <span
                  className={`w-9 text-right font-bold ${
                    s.done ? 'text-emerald-300' : active ? 'deck-pulse text-white/80' : 'text-white/25'
                  }`}
                >
                  {s.done ? 'OK' : active ? '···' : '—'}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div aria-hidden='true' className='absolute inset-x-0 bottom-0 h-[3px] bg-white/10'>
        <div className='ls-progress h-full' style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
});
