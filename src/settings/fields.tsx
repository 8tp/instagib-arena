import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { DeckSwitch, SegButton, UtilButton } from '../deck';
import { sfxProps, toast } from '../deck-core';
import { ANNOUNCER_PACKS, DEFAULT_ANNOUNCER_PACK, type AnnouncerPackId } from '../game/audio';
import { announcerPackCosmeticId, cosmeticById, sourceLabel } from '../game/cosmetics';
import type { CrosshairConfig, Settings } from '../app-types';
import { decodeCrosshair, decodeSettings, encodeCrosshair, encodeSettings } from './codec';
import { IconReset } from './icons';

/* ── Row chrome ─────────────────────────────────────────────────────────────
   Every setting is a SettingRow: label + short hint on the left, the control on
   the right, a "changed" dot beside the label and a reset-to-default button
   (only where the row knows its default). */

export function SettingRow({
  label,
  hint,
  dirty,
  onReset,
  disabled,
  onLabelClick,
  children,
}: {
  label: string;
  hint?: ReactNode;
  dirty?: boolean;
  onReset?: () => void;
  disabled?: boolean;
  onLabelClick?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div
      className={`st-row ${disabled ? 'is-disabled' : ''}`}
      data-dirty={dirty ? 'true' : undefined}
      role='group'
      aria-labelledby={id}
    >
      <div className='st-row-text'>
        <div className='st-row-label' id={id} onClick={disabled ? undefined : onLabelClick}>
          <span>{label}</span>
          {dirty && <span className='st-dot' role='img' aria-label='changed from default' title='Changed from default' />}
        </div>
        {hint && <p className='st-row-hint'>{hint}</p>}
      </div>
      <div className='st-row-ctl'>
        {children}
        {onReset && (
          <button
            type='button'
            className='st-reset'
            onClick={onReset}
            aria-label={`Reset ${label} to default`}
            title='Reset to default'
            tabIndex={dirty ? 0 : -1}
            aria-hidden={dirty ? undefined : true}
            data-shown={dirty ? 'true' : 'false'}
            {...sfxProps('uiClick')}
          >
            <IconReset />
          </button>
        )}
      </div>
    </div>
  );
}

/** A titled group of rows. `note` is a quiet one-liner under the title. */
export function SettingsCard({
  title,
  note,
  tag,
  children,
}: {
  title: string;
  note?: ReactNode;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <section className='st-card'>
      <header className='st-card-head'>
        <h3 className='st-card-title'>
          {tag && <span className='st-card-tag'>{tag}</span>}
          {title}
        </h3>
        {note && <p className='st-card-note'>{note}</p>}
      </header>
      <div className='st-card-body'>{children}</div>
    </section>
  );
}

/* ── Controls ───────────────────────────────────────────────────────────── */

export function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
  def,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  def?: number;
  disabled?: boolean;
}) {
  const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  const dirty = def !== undefined && Math.abs(value - def) > step / 100;
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={dirty}
      onReset={def !== undefined ? () => onChange(def) : undefined}
      disabled={disabled}
    >
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className='st-range'
        style={{ '--p': `${pct}%` } as CSSProperties}
      />
      <output className='st-value' aria-hidden>
        {format(value)}
      </output>
    </SettingRow>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onChange,
  def,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
  def?: boolean;
  disabled?: boolean;
}) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={def !== undefined && value !== def}
      disabled={disabled}
      onLabelClick={() => onChange(!value)}
    >
      <DeckSwitch value={value} onChange={onChange} label={label} disabled={disabled} />
    </SettingRow>
  );
}

export function SegRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  def,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
  def?: T;
}) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={def !== undefined && value !== def}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <div className='st-seg' role='group' aria-label={label}>
        {options.map((o) => (
          <SegButton key={o.id} active={value === o.id} onClick={() => onChange(o.id)}>
            {o.label}
          </SegButton>
        ))}
      </div>
    </SettingRow>
  );
}

export function SelectRow({
  label,
  hint,
  value,
  options,
  onChange,
  def,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (v: string) => void;
  def?: string;
}) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={def !== undefined && value !== def}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className='deck-input deck-select st-select'
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

export function ColorRow({
  label,
  hint,
  value,
  onChange,
  def,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  def?: string;
}) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={def !== undefined && value.toLowerCase() !== def.toLowerCase()}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <span className='st-color'>
        <span className='st-value st-color-hex'>{value}</span>
        <input type='color' value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      </span>
    </SettingRow>
  );
}

export function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  def,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  def?: number;
}) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      dirty={def !== undefined && value !== def}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <input
        type='number'
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
        }}
        className='deck-input st-number'
      />
    </SettingRow>
  );
}

export function TextRow({
  label,
  value,
  placeholder,
  onChange,
  readOnly,
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  hint?: ReactNode;
}) {
  return (
    <SettingRow label={label} hint={hint}>
      <input
        type='text'
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-readonly={readOnly}
        aria-label={label}
        onChange={(e) => {
          if (!readOnly) onChange(e.target.value);
        }}
        className={`deck-input st-text ${readOnly ? 'cursor-not-allowed' : ''}`}
      />
    </SettingRow>
  );
}

// Announcer-pack picker, gated by ownership. Packs are registered as cosmetics
// (see cosmetics.ts) so the server's `unlocked` list already reflects admin-all +
// level/credit grants — we just fetch the profile and lock the rest. The default
// pack is always free; admins get everything. A locked pack that's somehow active
// (persisted, then lost) is reset to default.
export function AnnouncerPackRow({
  value,
  onChange,
}: {
  value: AnnouncerPackId;
  onChange: (v: AnnouncerPackId) => void;
}) {
  const [unlocked, setUnlocked] = useState<Set<string> | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: { unlocked?: string[] } } | null) => {
        if (active) setUnlocked(new Set(d?.profile?.unlocked ?? [])); // empty (e.g. guest) → only default
      })
      .catch(() => active && setUnlocked(new Set()));
    return () => {
      active = false;
    };
  }, []);
  const isUnlocked = useCallback(
    (packId: string): boolean => {
      const cos = cosmeticById(announcerPackCosmeticId(packId));
      if (!cos || cos.source.type === 'default') return true; // default pack is always free
      return unlocked?.has(cos.id) ?? false;
    },
    [unlocked],
  );
  // If the active pack isn't owned (locked / persisted from a prior unlock), drop to default.
  useEffect(() => {
    if (unlocked && value !== DEFAULT_ANNOUNCER_PACK && !isUnlocked(value)) onChange(DEFAULT_ANNOUNCER_PACK);
  }, [unlocked, value, isUnlocked, onChange]);
  return (
    <SettingRow
      label='Announcer pack'
      hint='Premium packs unlock by level (or are staff-granted). Admins have all of them.'
      dirty={value !== DEFAULT_ANNOUNCER_PACK}
      onReset={() => onChange(DEFAULT_ANNOUNCER_PACK)}
    >
      <select
        value={value}
        aria-label='Announcer pack'
        onChange={(e) => {
          const v = e.target.value as AnnouncerPackId;
          if (isUnlocked(v)) onChange(v);
        }}
        className='deck-input deck-select st-select'
      >
        {ANNOUNCER_PACKS.map((p) => {
          const ok = isUnlocked(p.id);
          const cos = cosmeticById(announcerPackCosmeticId(p.id));
          const lock = !ok && cos ? ` 🔒 ${sourceLabel(cos.source)}` : '';
          return (
            <option key={p.id} value={p.id} disabled={!ok} className='bg-zinc-900 text-white'>
              {p.name}
              {lock}
            </option>
          );
        })}
      </select>
    </SettingRow>
  );
}

/* ── Share / import blocks ──────────────────────────────────────────────── */

function CodeBlock({
  title,
  hint,
  code,
  codeLabel,
  importLabel,
  placeholder,
  copiedMsg,
  importedMsg,
  invalidMsg,
  decode,
}: {
  title: string;
  hint: string;
  code: string;
  codeLabel: string;
  importLabel: string;
  placeholder: string;
  copiedMsg: string;
  importedMsg: string;
  invalidMsg: string;
  decode: (code: string) => boolean;
}) {
  const [paste, setPaste] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast(copiedMsg, { tone: 'ok' });
    } catch {
      toast('Copy failed', { tone: 'err' });
    }
  };
  const doImport = () => {
    if (decode(paste)) {
      setPaste('');
      toast(importedMsg, { tone: 'ok' });
    } else {
      toast(invalidMsg, { tone: 'err' });
    }
  };
  return (
    <div className='st-share'>
      <div className='st-share-head'>
        <span className='st-row-label'>{title}</span>
        <p className='st-row-hint'>{hint}</p>
      </div>
      <div className='st-share-line'>
        <input
          readOnly
          value={code}
          aria-label={codeLabel}
          onFocus={(e) => e.currentTarget.select()}
          className='deck-input st-code'
        />
        <UtilButton onClick={copy} tone='cyan' sound='none' className='shrink-0'>
          Copy
        </UtilButton>
      </div>
      <div className='st-share-line'>
        <input
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={placeholder}
          aria-label={importLabel}
          className='deck-input st-code'
        />
        <UtilButton onClick={doImport} disabled={!paste.trim()} sound='none' className='shrink-0'>
          Import
        </UtilButton>
      </div>
    </div>
  );
}

export function SettingsShare({
  settings,
  onImport,
}: {
  settings: Settings;
  onImport: (s: Settings) => void;
}) {
  return (
    <CodeBlock
      title='All-settings code'
      hint='Back up or move your whole config between browsers.'
      code={encodeSettings(settings)}
      codeLabel='Settings share code'
      importLabel='Import settings code'
      placeholder='Paste an IGS- code to import…'
      copiedMsg='Copied settings code'
      importedMsg='Settings imported'
      invalidMsg='Invalid settings code'
      decode={(c) => {
        const next = decodeSettings(c);
        if (next) onImport(next);
        return !!next;
      }}
    />
  );
}

export function CrosshairShare({
  cfg,
  onImport,
}: {
  cfg: CrosshairConfig;
  onImport: (c: CrosshairConfig) => void;
}) {
  return (
    <CodeBlock
      title='Share code'
      hint='Send your crosshair to a friend, or paste one to try it.'
      code={encodeCrosshair(cfg)}
      codeLabel='Crosshair share code'
      importLabel='Import crosshair code'
      placeholder='Paste a share code…'
      copiedMsg='Copied crosshair code'
      importedMsg='Crosshair imported'
      invalidMsg='Invalid crosshair code'
      decode={(c) => {
        const next = decodeCrosshair(c);
        if (next) onImport(next);
        return !!next;
      }}
    />
  );
}

/* ── Legacy pickers ─────────────────────────────────────────────────────────
   Still used by the lobby's Create-Match / filter dialogs (InstagibClient.tsx);
   the settings screen itself uses the *Row variants above. */

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className='deck-input deck-select deck-input-sm'
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ButtonGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <div className='flex flex-wrap gap-1.5' role='group' aria-label={label}>
        {options.map((o) => (
          <SegButton key={o.id} active={value === o.id} onClick={() => onChange(o.id)} className='px-2.5 py-1.5 text-[10px]'>
            {o.label}
          </SegButton>
        ))}
      </div>
    </div>
  );
}
