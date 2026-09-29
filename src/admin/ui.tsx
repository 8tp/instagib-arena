// Shared bits for the /admin economy tabs (Items · Codes · Gifts): the same
// zinc/cyan dashboard chrome as src/AdminDashboard.tsx.
import { useEffect, useState, type ReactNode } from 'react';
import { toLocalInput } from './time';

export const inputCls =
  'rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60 placeholder:text-white/30 disabled:opacity-40';
export const selectCls = `${inputCls} pr-7`;
export const btnCls =
  'rounded-md border border-white/20 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/80 transition hover:border-cyan-400/60 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40';
export const primaryCls =
  'rounded-md border border-cyan-400/60 bg-cyan-400/15 px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-40';
export const dangerCls =
  'rounded-md border border-rose-400/40 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.1em] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-40';

export function Card({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mb-6 rounded-lg border border-white/10 bg-white/[0.03] p-4 ${className}`}>
      <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
        <h2 className='font-display text-[13px] uppercase tracking-[0.16em] text-white/70'>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children, wide, className = '' }: { label: string; hint?: string; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${wide ? 'sm:col-span-2' : ''} ${className}`}>
      <span className='text-[10px] uppercase tracking-[0.14em] text-white/40'>
        {label}
        {hint && <span className='ml-1.5 normal-case tracking-normal text-white/30'>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Check({ checked, onChange, children, disabled, field }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; field?: string }) {
  return (
    <label className={`flex items-center gap-2 text-[12px] ${disabled ? 'text-white/35' : 'text-white/75'}`}>
      <input type='checkbox' className='accent-cyan-400' checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-field={field} />
      {children}
    </label>
  );
}

// A two-or-three-way segmented toggle.
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role='radiogroup' aria-label={label} className='inline-flex rounded-md border border-white/15 bg-black/40 p-0.5'>
      {options.map((o) => (
        <button
          key={o.id}
          type='button'
          role='radio'
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] transition ${value === o.id ? 'bg-cyan-400/20 text-cyan-100' : 'text-white/45 hover:text-white/80'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type Msg = { tone: 'ok' | 'err'; text: string } | null;
export function Banner({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <div role={msg.tone === 'err' ? 'alert' : 'status'} className={`rounded border px-3 py-2 text-[12px] ${msg.tone === 'ok' ? 'border-emerald-400/40 bg-emerald-400/5 text-emerald-200' : 'border-rose-400/40 bg-rose-400/5 text-rose-200'}`}>
      {msg.text}
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
      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] transition ${done ? 'border-emerald-400/50 text-emerald-300' : 'border-white/15 text-white/50 hover:border-cyan-400/50 hover:text-cyan-200'}`}
      aria-label={`${label} ${text}`}
      data-action='copy'
    >
      {done ? 'Copied' : label}
    </button>
  );
}

// Quick expiry presets for the datetime field.
export function ExpiryField({ value, onChange, label = 'Expires' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const preset = (days: number) => onChange(toLocalInput(Date.now() + days * 86_400_000));
  return (
    <Field label={label} hint={value ? '' : 'blank = never'}>
      <span className='flex flex-wrap items-center gap-1.5'>
        <input type='datetime-local' className={`${inputCls} [color-scheme:dark]`} value={value} onChange={(e) => onChange(e.target.value)} data-field='expires' />
        {[1, 7, 30].map((d) => (
          <button key={d} type='button' className='rounded border border-white/10 px-1.5 py-1 text-[10px] font-bold text-white/50 hover:border-cyan-400/50 hover:text-cyan-200' onClick={() => preset(d)}>
            {d}d
          </button>
        ))}
        {value && (
          <button type='button' className='rounded px-1.5 py-1 text-[10px] font-bold text-white/40 hover:text-rose-300' onClick={() => onChange('')} aria-label='Clear expiry'>
            ✕
          </button>
        )}
      </span>
    </Field>
  );
}
