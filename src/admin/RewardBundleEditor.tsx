// A reward bundle (docs/economy.md §7b) as a form: credits, free rolls and up to
// ten items, each built with the ItemSpecEditor. Checked live against the
// server's own validator (POST /api/admin/rewards/validate) so "Create" /
// "Send" can only go out with a bundle the server will accept.
import { useState } from 'react';
import { REWARD_LIMITS } from '../game/items/types';
import { instFullName } from '../economy/display';
import { specPreview } from '../inbox/reward';
import { SpecTile } from '../inbox/RewardBits';
import { ItemSpecEditor } from './ItemSpecEditor';
import type { BundleCheck } from './useBundleCheck';
import { draftToSpec, newDraft, type BundleDraft, type SpecDraft } from './spec-draft';
import { Field, btnCls, inputCls } from './ui';

export function CheckLine({ check, emptyText }: { check: BundleCheck; emptyText: string }) {
  const tone = check.state === 'ok' ? 'text-emerald-300' : check.state === 'err' ? 'text-rose-300' : 'text-white/40';
  const text = check.state === 'ok' ? '✓ Server accepts this reward' : check.state === 'err' ? `✕ ${check.text}` : check.state === 'checking' ? 'Checking…' : emptyText;
  return (
    <div className={`font-mono text-[11px] ${tone}`} role='status' data-bundle-check={check.state}>
      {text}
    </div>
  );
}

export function RewardBundleEditor({ value, onChange }: { value: BundleDraft; onChange: (b: BundleDraft) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [fresh, setFresh] = useState<number | null>(null); // a just-added item opens on the picker
  const b = value;
  const setItem = (key: number, d: SpecDraft) => onChange({ ...b, items: b.items.map((x) => (x.key === key ? d : x)) });
  const add = () => {
    const d = newDraft(b.items.length ? b.items[b.items.length - 1].def : 'hat.tophat');
    onChange({ ...b, items: [...b.items, d] });
    setEditing(d.key);
    setFresh(d.key);
  };
  const remove = (key: number) => {
    onChange({ ...b, items: b.items.filter((x) => x.key !== key) });
    if (editing === key) setEditing(null);
  };
  const num = (s: string) => s.replace(/[^0-9]/g, '');
  const cur = b.items.find((x) => x.key === editing) ?? null;

  return (
    <div className='flex flex-col gap-3 rounded-md border border-white/10 bg-black/20 p-3' data-bundle-editor>
      <div className='grid grid-cols-2 gap-3 sm:max-w-md'>
        <Field label='Credits ⛁' hint={`≤ ${REWARD_LIMITS.credits.toLocaleString()}`}>
          <input className={inputCls} inputMode='numeric' value={b.credits} onChange={(e) => onChange({ ...b, credits: num(e.target.value) })} placeholder='0' data-field='bundle-credits' />
        </Field>
        <Field label='Free rolls' hint={`≤ ${REWARD_LIMITS.rolls}`}>
          <input className={inputCls} inputMode='numeric' value={b.rolls} onChange={(e) => onChange({ ...b, rolls: num(e.target.value) })} placeholder='0' data-field='bundle-rolls' />
        </Field>
      </div>

      <div>
        <div className='mb-2 flex items-center justify-between gap-2'>
          <span className='text-[10px] uppercase tracking-[0.14em] text-white/40'>
            Items <span className='text-white/30'>{b.items.length} / {REWARD_LIMITS.items} · minted fresh when claimed</span>
          </span>
          <button type='button' className={btnCls} onClick={add} disabled={b.items.length >= REWARD_LIMITS.items} data-action='bundle-add-item'>
            + Add item
          </button>
        </div>
        {b.items.length > 0 && (
          <ul className='flex flex-wrap gap-2'>
            {b.items.map((d, i) => {
              const inst = specPreview(draftToSpec(d), d.key);
              const on = editing === d.key;
              return (
                <li key={d.key} className={`flex w-[132px] flex-col items-center gap-1 rounded-md border p-1.5 ${on ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-white/10 bg-black/30'}`}>
                  <button type='button' className='w-full' onClick={() => setEditing(on ? null : d.key)} aria-pressed={on} aria-label={`Edit item ${i + 1}: ${instFullName(inst)}`} data-action='bundle-edit-item'>
                    <SpecTile inst={inst} fluid />
                  </button>
                  <span className='line-clamp-2 min-h-[2.2em] text-center text-[11px] leading-tight text-white/75'>{instFullName(inst)}</span>
                  <span className='flex gap-2'>
                    <button type='button' className='text-[10px] font-bold uppercase tracking-[0.1em] text-cyan-300/80 hover:text-cyan-200' onClick={() => setEditing(on ? null : d.key)}>
                      {on ? 'Close' : 'Edit'}
                    </button>
                    <button type='button' className='text-[10px] font-bold uppercase tracking-[0.1em] text-rose-300/70 hover:text-rose-200' onClick={() => remove(d.key)} data-action='bundle-remove-item'>
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {cur && (
        <div className='rounded-md border border-cyan-400/25 bg-cyan-400/[0.03] p-3'>
          <div className='mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-200/80'>
            <span>Item {b.items.indexOf(cur) + 1}</span>
            <button type='button' className='text-white/45 hover:text-white' onClick={() => setEditing(null)}>
              Done
            </button>
          </div>
          <ItemSpecEditor key={cur.key} value={cur} onChange={(d) => setItem(cur.key, d)} pickerOpen={cur.key === fresh} />
        </div>
      )}
    </div>
  );
}
