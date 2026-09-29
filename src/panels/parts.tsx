import { useId, type ReactNode } from 'react';
import { sfxProps } from '../deck-core';
import { DeckButton, Skeleton } from '../deck';
import './panels.css';

// Small building blocks shared by the menu panels (Leaderboard, Stats, Ranked,
// Weekly Challenge) and the auth / feedback forms. Presentational only.

/* ── Segmented control ──────────────────────────────────────────────────── */

// One joined row of options (window / sort pickers). aria-pressed buttons in a
// labelled group; ←/→ move the selection like a native radio group.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  className = '',
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      role='group'
      aria-label={label}
      className={`pn-segs ${size === 'sm' ? 'pn-segs-sm' : ''} ${className}`}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = options.findIndex((o) => o.id === value);
        const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
        onChange(next.id);
        e.preventDefault();
        // Keep focus on the newly selected button.
        const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        btns[options.indexOf(next)]?.focus();
      }}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type='button'
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.id)}
            {...sfxProps(active ? 'none' : 'tabSwitch')}
            className='pn-seg'
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Rank medal ─────────────────────────────────────────────────────────── */

const MEDAL: Record<number, string> = { 1: 'pn-medal-1', 2: 'pn-medal-2', 3: 'pn-medal-3' };

// The rank cell: a clipped chip, gold / silver / bronze for the podium.
export function Medal({ rank, className = '' }: { rank: number; className?: string }) {
  return (
    <span
      className={`pn-medal ${MEDAL[rank] ?? ''} ${className}`}
      aria-label={`Rank ${rank}`}
    >
      {rank}
    </span>
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

// Empty / error block: a quiet glyph, one line of what happened, one line of
// what to do, and an optional action.
export function PanelState({
  tone = 'empty',
  title,
  hint,
  action,
}: {
  tone?: 'empty' | 'error';
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  const err = tone === 'error';
  return (
    <div role={err ? 'alert' : 'status'} className='flex flex-col items-center gap-2 px-4 py-10 text-center'>
      <span
        aria-hidden='true'
        className={`pn-state-glyph ${err ? 'border-rose-400/40 text-rose-300' : 'border-white/15 text-white/40'}`}
      >
        {err ? '!' : '—'}
      </span>
      <div className='font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-white/80'>{title}</div>
      {hint && <p className='max-w-xs text-[12px] leading-relaxed text-white/45'>{hint}</p>}
      {action && (
        <DeckButton onClick={action.onClick} accent={err ? 'rose' : 'cyan'} size='sm' center className='mt-2'>
          {action.label}
        </DeckButton>
      )}
    </div>
  );
}

// Placeholder rows for a ladder / leaderboard while it loads: rank chip, name,
// and a right-aligned figure, in the same rhythm as the real rows.
export function TableSkeleton({ rows, podium = false }: { rows: number; podium?: boolean }) {
  return (
    <div className='flex flex-col gap-3' aria-hidden='true'>
      {podium && (
        <div className='pn-podium'>
          {[1, 0, 2].map((k) => (
            <div key={k} className='pn-podium-slot' style={{ marginTop: k === 0 ? 0 : k === 1 ? 14 : 24 }}>
              <Skeleton className='mx-auto h-9 w-9' />
              <Skeleton className='mx-auto mt-3 h-3 w-20' />
              <Skeleton className='mx-auto mt-2 h-5 w-12' />
            </div>
          ))}
        </div>
      )}
      <div className='flex flex-col'>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className='deck-tr flex items-center gap-3 px-2 py-2.5'>
            <Skeleton className='h-5 w-7' />
            <Skeleton className='h-3 flex-1' style={{ maxWidth: `${52 + ((i * 17) % 30)}%` }} />
            <Skeleton className='ml-auto h-3 w-10' />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Form field (auth + feedback) ───────────────────────────────────────── */

// Label + control slot + a hint / error line wired with aria-describedby. The
// child is a render prop so the input can take the generated ids.
export function Field({
  label,
  optional = false,
  hint,
  error,
  counter,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string | null;
  counter?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  const hasMsg = !!error || !!hint;
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-baseline justify-between gap-3'>
        <label htmlFor={id} className='deck-label'>
          {label}
          {optional && <span className='text-white/30'> · optional</span>}
        </label>
        {counter && <span className='font-mono text-[10px] tabular-nums text-white/30'>{counter}</span>}
      </div>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': hasMsg ? msgId : undefined })}
      {hasMsg && (
        <div
          id={msgId}
          role={error ? 'alert' : undefined}
          className={`text-[11px] leading-snug ${error ? 'text-rose-300' : 'text-white/40'}`}
        >
          {error || hint}
        </div>
      )}
    </div>
  );
}

/* ── Rings + emblems ────────────────────────────────────────────────────── */

// Circular gauge (accuracy). `pct` 0–100. Draws with a CSS stroke transition.
export function Ring({
  pct,
  size = 92,
  stroke = 7,
  color = '#22d3ee',
  children,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className='relative shrink-0' style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden='true' className='-rotate-90'>
        <circle cx={size / 2} cy={size / 2} r={r} fill='none' stroke='rgba(255,255,255,0.09)' strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill='none'
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap='butt'
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p / 100)}
          className='pn-ring-arc'
          style={{ filter: `drop-shadow(0 0 5px ${color}66)` }}
        />
      </svg>
      <div className='absolute inset-0 flex flex-col items-center justify-center'>{children}</div>
    </div>
  );
}

// Tier emblem: a faceted shield in the tier colour with the tier initial.
export function RankEmblem({ color, letter, size = 84 }: { color: string; letter: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 64 64' aria-hidden='true' className='shrink-0'>
      <defs>
        <linearGradient id={`pn-em-${color.slice(1)}`} x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor={color} stopOpacity='0.55' />
          <stop offset='1' stopColor={color} stopOpacity='0.08' />
        </linearGradient>
      </defs>
      <path
        d='M32 3 57 12v20c0 14-10 24-25 29C17 56 7 46 7 32V12z'
        fill={`url(#pn-em-${color.slice(1)})`}
        stroke={color}
        strokeWidth='2'
        strokeLinejoin='round'
        style={{ filter: `drop-shadow(0 0 8px ${color}55)` }}
      />
      <path d='M32 9 51 15.5V32c0 11-7.5 19-19 23.5' fill='none' stroke={color} strokeOpacity='0.4' strokeWidth='1' />
      <text
        x='32'
        y='40'
        textAnchor='middle'
        fontFamily='Chakra Petch, sans-serif'
        fontWeight='700'
        fontSize='24'
        fill={color}
      >
        {letter}
      </text>
    </svg>
  );
}

// Card wrapper used across the panels: clipped hairline surface + optional
// heading row. Keeps the panels on one surface treatment.
export function PanelCard({
  title,
  aside,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`pn-card clip-deck-sm ${className}`}>
      {title && (
        <header className='flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2.5'>
          <h3 className='font-display text-[12px] font-bold uppercase tracking-[0.14em] text-white/80'>{title}</h3>
          {aside && <div className='text-[11px] text-white/40'>{aside}</div>}
        </header>
      )}
      <div className={bodyClassName || 'p-4'}>{children}</div>
    </section>
  );
}
