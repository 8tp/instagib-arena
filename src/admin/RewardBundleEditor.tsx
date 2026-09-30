// A reward bundle (docs/economy.md §7b) as a form: credits, free rolls and up to
// ten items, each built with the ItemSpecEditor. Checked live against the
// server's own validator (POST /api/admin/rewards/validate) so "Create" /
// "Send" only goes out with a bundle the server will accept.
import { useState } from 'react';
import { REWARD_LIMITS } from '../game/items/types';
import { instFullName, instTags } from '../economy/display';
import { TagPills } from '../economy/parts';
import { specPreview } from '../inbox/reward';
import { SpecTile } from '../inbox/RewardBits';
import { TicketGlyph } from '../menu/RewardTile';
import { ItemSpecEditor } from './ItemSpecEditor';
import type { BundleCheck } from './useBundleCheck';
import { draftToSpec, newDraft, type BundleDraft, type SpecDraft } from './spec-draft';

export function CheckLine({ check, emptyText }: { check: BundleCheck; emptyText: string }) {
  const color = check.state === 'ok' ? 'var(--adm-good)' : check.state === 'err' ? 'var(--adm-bad)' : 'var(--adm-ink-3)';
  const text = check.state === 'ok' ? 'Server accepts this reward.' : check.state === 'err' ? check.text : check.state === 'checking' ? 'Checking with the server…' : emptyText;
  const glyph = check.state === 'ok' ? '✓' : check.state === 'err' ? '✕' : '·';
  return (
    <div className='flex items-center gap-2 text-[12px]' style={{ color }} role='status' data-bundle-check={check.state}>
      <span aria-hidden className='font-mono'>
        {glyph}
      </span>
      {text}
    </div>
  );
}

function Amount({
  label,
  glyph,
  value,
  onChange,
  max,
  presets,
  field,
  color,
}: {
  label: string;
  glyph: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  max: number;
  presets: number[];
  field: string;
  color: string;
}) {
  const n = Number(value) || 0;
  const over = n > max;
  return (
    <div className='flex min-w-0 flex-col gap-1.5'>
      <span className='adm-label'>
        {label}
        <span className='hint'>max {max.toLocaleString()}</span>
      </span>
      <div className='adm-input flex items-center gap-2' aria-invalid={over} style={{ height: 38 }}>
        <span style={{ color }} className='shrink-0'>
          {glyph}
        </span>
        <input
          className='mono h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none'
          inputMode='numeric'
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
          placeholder='0'
          aria-label={label}
          data-field={field}
        />
        {value && (
          <button type='button' className='text-[12px] text-[var(--adm-ink-3)] hover:text-[var(--adm-ink)]' onClick={() => onChange('')} aria-label={`Clear ${label}`}>
            ✕
          </button>
        )}
      </div>
      <div className='flex flex-wrap gap-1'>
        {presets.map((p) => (
          <button key={p} type='button' className='adm-chip' onClick={() => onChange(String(Math.min(max, n + p)))}>
            +{p.toLocaleString()}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RewardBundleEditor({ value, onChange }: { value: BundleDraft; onChange: (b: BundleDraft) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const b = value;
  const setItem = (key: number, d: SpecDraft) => onChange({ ...b, items: b.items.map((x) => (x.key === key ? d : x)) });
  const add = () => {
    const d = newDraft(b.items.length ? b.items[b.items.length - 1].def : 'hat.tophat');
    onChange({ ...b, items: [...b.items, d] });
    setEditing(d.key);
  };
  const remove = (key: number) => {
    onChange({ ...b, items: b.items.filter((x) => x.key !== key) });
    if (editing === key) setEditing(null);
  };
  const cur = b.items.find((x) => x.key === editing) ?? null;

  return (
    <div className='flex flex-col gap-4' data-bundle-editor>
      <div className='grid gap-4 sm:grid-cols-2'>
        <Amount label='Credits' glyph='⛁' color='var(--adm-credit)' value={b.credits} onChange={(v) => onChange({ ...b, credits: v })} max={REWARD_LIMITS.credits} presets={[100, 500, 1000, 5000]} field='bundle-credits' />
        <Amount label='Free rolls' glyph={<TicketGlyph size={14} />} color='var(--adm-rail)' value={b.rolls} onChange={(v) => onChange({ ...b, rolls: v })} max={REWARD_LIMITS.rolls} presets={[1, 3, 5, 10]} field='bundle-rolls' />
      </div>

      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between gap-2'>
          <span className='adm-label'>
            Items
            <span className='hint'>
              {b.items.length} of {REWARD_LIMITS.items} · minted fresh when claimed
            </span>
          </span>
          <button type='button' className='adm-btn' onClick={add} disabled={b.items.length >= REWARD_LIMITS.items} data-action='bundle-add-item'>
            + Add item
          </button>
        </div>
        {b.items.length === 0 ? (
          <button type='button' onClick={add} className='border border-dashed border-[var(--adm-line-2)] px-4 py-5 text-center text-[13px] text-[var(--adm-ink-3)] transition hover:border-[var(--adm-rail)] hover:text-[var(--adm-ink)]'>
            No items attached. Add one to build it with the item generator.
          </button>
        ) : (
          <ul className='flex flex-col border border-[var(--adm-line)]'>
            {b.items.map((d, i) => {
              const inst = specPreview(draftToSpec(d), d.key);
              const on = editing === d.key;
              return (
                <li key={d.key} className={`border-b border-[var(--adm-line)] last:border-b-0 ${on ? 'bg-[rgba(91,227,255,0.04)]' : ''}`}>
                  <div className='flex items-center gap-3 px-2.5 py-2'>
                    <span className='w-5 text-center font-mono text-[11px] text-[var(--adm-ink-3)]'>{i + 1}</span>
                    <SpecTile inst={inst} size={44} />
                    <span className='flex min-w-0 flex-1 flex-col gap-1'>
                      <span className='truncate text-[13px] font-medium text-[var(--adm-ink)]'>{instFullName(inst)}</span>
                      <TagPills tags={instTags(inst)} />
                    </span>
                    <button type='button' className='adm-btn sm' onClick={() => setEditing(on ? null : d.key)} aria-expanded={on} data-action='bundle-edit-item'>
                      {on ? 'Done' : 'Edit'}
                    </button>
                    <button type='button' className='adm-btn sm danger' onClick={() => remove(d.key)} data-action='bundle-remove-item' aria-label={`Remove item ${i + 1}`}>
                      Remove
                    </button>
                  </div>
                  {on && cur && (
                    <div className='border-t border-[var(--adm-line)] p-3'>
                      <ItemSpecEditor key={cur.key} value={cur} onChange={(nd) => setItem(cur.key, nd)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
