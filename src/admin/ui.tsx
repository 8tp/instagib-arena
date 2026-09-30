// Shared atoms for the /admin console: plates, fields, toggles, segmented
// controls, banners, stat tiles, loading / empty / error states. Styles live in
// ./admin.css (tokens under .adm).
import { useEffect, useState, type ReactNode } from 'react';
import { Sparkline } from './charts';
import { avatarColor, pct } from './format';
import { toLocalInput } from './time';

// Class names for native controls (kept as exports so forms read the same).
export const inputCls = 'adm-input';
export const btnCls = 'adm-btn';
export const primaryCls = 'adm-btn primary';
export const dangerCls = 'adm-btn sm danger';

export function Plate({
  title,
  sub,
  right,
  children,
  className = '',
  flush = false,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean; // body without padding (tables run edge to edge)
  id?: string;
}) {
  return (
    <section className={`adm-plate ${className}`} aria-labelledby={id} data-plate>
      {(title || right) && (
        <header className='adm-plate-head'>
          <div className='min-w-0'>
            {title && (
              <h2 className='adm-plate-title' id={id}>
                {title}
              </h2>
            )}
            {sub && <div className='adm-plate-sub'>{sub}</div>}
          </div>
          {right && <div className='flex flex-wrap items-center gap-2'>{right}</div>}
        </header>
      )}
      <div className={flush ? 'pt-3' : 'adm-plate-body'}>{children}</div>
    </section>
  );
}

// A labelled field. `as='div'` for custom controls (comboboxes) so a click on
// the label text doesn't activate the trigger button.
export function Field({
  label,
  hint,
  children,
  className = '',
  as = 'label',
  error,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'label' | 'div';
  error?: string;
}) {
  const Tag = as;
  return (
    <Tag className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className='adm-label'>
        {label}
        {hint && <span className='hint'>{hint}</span>}
      </span>
      {children}
      {error && <span className='text-[12px] text-[var(--adm-bad)]'>{error}</span>}
    </Tag>
  );
}

// A switch with its label. role=switch; Space/Enter toggle (native button).
export function Toggle({
  checked,
  onChange,
  children,
  hint,
  disabled,
  field,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  field?: string;
}) {
  return (
    <button
      type='button'
      className='group flex items-center gap-2.5 text-left disabled:cursor-not-allowed'
      onClick={() => onChange(!checked)}
      disabled={disabled}
      role='switch'
      aria-checked={checked}
      data-field={field}
    >
      <span className='adm-switch' data-on={checked ? '' : undefined} aria-hidden />
      <span className={`text-[13px] ${disabled ? 'text-[var(--adm-ink-3)]' : 'text-[var(--adm-ink)]'}`}>
        {children}
        {hint && <span className='ml-2 text-[12px] text-[var(--adm-ink-3)]'>{hint}</span>}
      </span>
    </button>
  );
}
// Back-compat name used by older forms.
export const Check = Toggle;

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role='radiogroup' aria-label={label} className='adm-seg'>
      {options.map((o) => (
        <button key={o.id} type='button' role='radio' aria-checked={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type Msg = { tone: 'ok' | 'err' | 'warn'; text: ReactNode } | null;
export function Banner({ msg, onClose }: { msg: Msg; onClose?: () => void }) {
  if (!msg) return null;
  return (
    <div role={msg.tone === 'err' ? 'alert' : 'status'} className='adm-banner' data-tone={msg.tone}>
      <span className='min-w-0 flex-1'>{msg.text}</span>
      {onClose && (
        <button type='button' className='text-[12px] opacity-60 hover:opacity-100' onClick={onClose} aria-label='Dismiss'>
          ✕
        </button>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type='button'
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => undefined,
        );
      }}
      className='adm-btn sm'
      style={done ? { borderColor: 'var(--adm-good)', color: 'var(--adm-good)' } : undefined}
      aria-label={`${label} ${text}`}
      data-action='copy'
    >
      {done ? 'Copied' : label}
    </button>
  );
}

// Datetime + quick presets. '' = never.
export function ExpiryField({ value, onChange, label = 'Expires' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const preset = (days: number) => onChange(toLocalInput(Date.now() + days * 86_400_000));
  return (
    <Field label={label} hint={value ? undefined : 'never'} as='div'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <input type='datetime-local' aria-label={label} className='adm-input mono' value={value} onChange={(e) => onChange(e.target.value)} data-field='expires' />
        {[1, 7, 30].map((d) => (
          <button key={d} type='button' className='adm-chip' onClick={() => preset(d)}>
            +{d}d
          </button>
        ))}
        {value && (
          <button type='button' className='adm-btn sm ghost' onClick={() => onChange('')} aria-label={`Clear ${label.toLowerCase()}`}>
            Never
          </button>
        )}
      </span>
    </Field>
  );
}

// ── Figures ─────────────────────────────────────────────────────────────────
// A credit amount: the game's ⛁ glyph as a small amber prefix.
export function Cr({ n }: { n: string | number }) {
  return (
    <span className='whitespace-nowrap'>
      <span className='adm-cr' aria-hidden>
        ⛁
      </span>
      <span className='sr-only'>credits </span>
      {typeof n === 'number' ? n.toLocaleString() : n}
    </span>
  );
}

// Signed change vs the previous period. `good` says which direction is good.
export function Delta({ value, good = 'up', vs }: { value: number | null; good?: 'up' | 'down' | 'none'; vs?: string }) {
  if (value == null) return <span className='adm-delta' data-tone='flat' title={vs ? `no baseline ${vs}` : undefined}>new</span>;
  const flat = Math.abs(value) < 0.005;
  const up = value > 0;
  const tone = flat || good === 'none' ? 'flat' : (up ? good === 'up' : good === 'down') ? 'good' : 'bad';
  return (
    <span className='adm-delta' data-tone={tone} title={vs}>
      {flat ? '±0%' : `${up ? '▲' : '▼'} ${pct(Math.abs(value), Math.abs(value) < 0.1 ? 1 : 0)}`}
    </span>
  );
}

export function StatTile({
  label,
  value,
  sub,
  delta,
  good,
  vs,
  spark,
  accent,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  delta?: number | null;
  good?: 'up' | 'down' | 'none';
  vs?: string;
  spark?: number[];
  accent?: boolean;
}) {
  return (
    <div className='adm-tile' data-accent={accent ? '' : undefined} data-tile>
      <div className='adm-tile-label'>{label}</div>
      <div className='flex items-end justify-between gap-2'>
        <div className='adm-tile-value'>{value}</div>
        {spark && <Sparkline points={spark} />}
      </div>
      <div className='flex min-w-0 items-center gap-2'>
        {delta !== undefined && <Delta value={delta} good={good} vs={vs} />}
        {sub && <span className='adm-tile-sub'>{sub}</span>}
      </div>
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────
export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className='flex flex-col gap-2 py-2' role='status' aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='adm-skel h-9' style={{ opacity: 1 - i * 0.2 }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className='adm-state' role='alert'>
      <strong>Couldn’t load this.</strong>
      <span>{message}</span>
      {onRetry && (
        <button type='button' className='adm-btn sm mt-2' onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className='adm-state'>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

// ── Players ─────────────────────────────────────────────────────────────────
export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span className={`adm-avatar ${large ? 'lg' : ''}`} style={{ background: avatarColor(name.toLowerCase()) }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function PlayerFlags({ admin, verified }: { admin?: boolean; verified?: boolean }) {
  return (
    <>
      {admin && <span className='adm-flag staff'>Staff</span>}
      {verified && (
        <span className='adm-flag verified' title='Verified'>
          ✓ Verified
        </span>
      )}
    </>
  );
}
