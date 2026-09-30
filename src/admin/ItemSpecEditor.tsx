// The admin item generator: pick a catalog def (searchable thumbnails, slot /
// tier / season filters), dress it up (unusual effect, Strange + kills,
// Festive, killstreak sheen + professional effect, pattern seed, custom
// name / description / tint / tier, bound), and see the exact item a player
// will get. Controlled: the parent owns the SpecDraft. Used for direct mints
// (Items) and for each item in a code / gift reward bundle.
import '../locker/locker.css';
import '../economy/economy.css';
import { useDeferredValue, useMemo, useState } from 'react';
import { itemDef, seasonOf } from '../game/items/catalog';
import { ITEM_SLOTS, KS_EFFECTS, KS_SHEENS, SEASONS, TIERS, TIER_META, UNUSUAL_EFFECTS, type ItemSlot, type Tier } from '../game/items/types';
import { SLOT_LABEL, defSeason, instBlurb, instFullName, instTags, instTier } from '../economy/display';
import { TagPills, TierChip } from '../economy/parts';
import { specPreview } from '../inbox/reward';
import { SpecTile } from '../inbox/RewardBits';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, isIridescent } from '../ui/rarity';
import { MINTABLE, HEX6, draftToSpec, type SpecDraft } from './spec-draft';
import { Check, Field, inputCls, selectCls } from './ui';

const PICKER_CAP = 60;
const opt = 'bg-zinc-900';

// ── Def picker ──────────────────────────────────────────────────────────────
export function DefPicker({ value, onPick, startOpen = true }: { value: string; onPick: (id: string) => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [q, setQ] = useState('');
  const [slot, setSlot] = useState<ItemSlot | ''>('');
  const [tier, setTier] = useState<Tier | ''>('');
  const [season, setSeason] = useState<string>('');
  const dq = useDeferredValue(q);
  const list = useMemo(() => {
    const t = dq.trim().toLowerCase();
    return MINTABLE.filter(
      (d) =>
        (!slot || d.slot === slot) &&
        (!tier || d.tier === tier) &&
        (season === '' || seasonOf(d) === Number(season)) &&
        (!t || d.name.toLowerCase().includes(t) || d.id.toLowerCase().includes(t)),
    ).sort((a, b) => TIER_META[b.tier].rank - TIER_META[a.tier].rank || a.name.localeCompare(b.name));
  }, [dq, slot, tier, season]);
  const cur = itemDef(value);

  if (!open) {
    return (
      <div className='flex items-center gap-3 rounded-md border border-white/10 bg-black/30 p-2'>
        <ItemTile id={value} size={48} label={false} tier={cur?.tier} />
        <div className='min-w-0 flex-1'>
          <div className='truncate text-[13px] font-semibold text-white/90'>{cur?.name ?? value}</div>
          <div className='font-mono text-[11px] text-white/40'>
            {cur ? `${SLOT_LABEL[cur.slot]} · ${TIER_META[cur.tier].label} · ${defSeason(cur.id)?.name ?? ''}` : 'unknown def'} · {value}
          </div>
        </div>
        <button type='button' className='rounded-md border border-white/20 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/80 hover:border-cyan-400/60 hover:text-cyan-200' onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className='rounded-md border border-white/10 bg-black/30 p-3' data-def-picker>
      <div className='mb-3 flex flex-wrap gap-2'>
        <input className={`${inputCls} min-w-[10rem] flex-1`} placeholder='Search items…' value={q} onChange={(e) => setQ(e.target.value)} aria-label='Search items' data-field='def-search' />
        <select className={selectCls} value={slot} onChange={(e) => setSlot(e.target.value as ItemSlot | '')} aria-label='Slot'>
          <option value='' className={opt}>All slots</option>
          {ITEM_SLOTS.filter((s) => MINTABLE.some((d) => d.slot === s)).map((s) => (
            <option key={s} value={s} className={opt}>{SLOT_LABEL[s]}</option>
          ))}
        </select>
        <select className={selectCls} value={tier} onChange={(e) => setTier(e.target.value as Tier | '')} aria-label='Tier'>
          <option value='' className={opt}>All tiers</option>
          {TIERS.map((t) => (
            <option key={t} value={t} className={opt}>{TIER_META[t].label}</option>
          ))}
        </select>
        <select className={selectCls} value={season} onChange={(e) => setSeason(e.target.value)} aria-label='Season'>
          <option value='' className={opt}>All seasons</option>
          {SEASONS.map((s) => (
            <option key={s.id} value={s.id} className={opt}>{s.name}</option>
          ))}
        </select>
        {!startOpen && (
          <button type='button' className='px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-white/45 hover:text-white' onClick={() => setOpen(false)}>
            Done
          </button>
        )}
      </div>
      <div className='-m-1 max-h-[300px] overflow-y-auto p-1'>
        <ul className='grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2'>
          {list.slice(0, PICKER_CAP).map((d) => (
            <li key={d.id}>
              <ItemTile
                id={d.id}
                fluid
                tier={d.tier}
                selected={d.id === value}
                onClick={() => {
                  onPick(d.id);
                  if (!startOpen) setOpen(false);
                }}
                rootProps={{ 'data-def': d.id, title: `${d.name} · ${SLOT_LABEL[d.slot]} · ${TIER_META[d.tier].label}` }}
              />
            </li>
          ))}
        </ul>
        {list.length === 0 && <div className='py-6 text-center text-[12px] text-white/35'>No items match.</div>}
        {list.length > PICKER_CAP && <div className='pt-3 text-center text-[11px] text-white/35'>+{list.length - PICKER_CAP} more — refine the search.</div>}
      </div>
    </div>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────
export function SpecPreview({ draft, count }: { draft: SpecDraft; count?: number }) {
  const inst = specPreview(draftToSpec(draft));
  const tier = instTier(inst);
  const def = itemDef(inst.def);
  const season = defSeason(inst.def);
  const tint = inst.attrs.tint;
  return (
    <div className='flex flex-col items-center gap-2.5 text-center' data-spec-preview>
      <div className='text-[10px] uppercase tracking-[0.18em] text-white/40'>Live preview</div>
      <div className='relative w-[184px]'>
        <SpecTile inst={inst} fluid />
        {count != null && count > 1 && <span className='absolute -bottom-2 -right-2 rounded bg-cyan-300 px-1.5 py-0.5 font-display text-[13px] font-bold text-zinc-950'>×{count}</span>}
      </div>
      <div className={`font-display text-[17px] font-bold uppercase leading-tight ${isIridescent(tier) ? 'ec-iri-text' : ''}`} style={isIridescent(tier) ? undefined : { color: TIER_COLOR[tier].text }}>
        {instFullName(inst)}
      </div>
      <div className='flex flex-wrap items-center justify-center gap-1.5'>
        <TierChip tier={tier} />
        {def && <span className='font-mono text-[11px] text-white/45'>{SLOT_LABEL[def.slot]}</span>}
        {season && <span className='font-mono text-[11px] text-white/45'>· {season.name}</span>}
      </div>
      <TagPills tags={instTags(inst)} />
      {instBlurb(inst) && <p className='max-w-[240px] text-[12px] italic leading-snug text-white/55'>“{instBlurb(inst)}”</p>}
      <div className='flex flex-wrap items-center justify-center gap-2 font-mono text-[11px]'>
        <span className={inst.tradable ? 'text-emerald-300' : 'text-amber-300'}>{inst.tradable ? 'Tradable' : 'Bound · untradable'}</span>
        {tint && (
          <span className='flex items-center gap-1 text-white/50'>
            <span className='inline-block h-3 w-3 rounded-sm border border-white/30' style={{ background: tint }} /> {tint}
          </span>
        )}
        {inst.attrs.nameTag && <span className='text-white/50'>tag “{inst.attrs.nameTag}”</span>}
      </div>
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────
export function ItemSpecEditor({
  value,
  onChange,
  preview = true,
  pickerOpen = true,
  count,
}: {
  value: SpecDraft;
  onChange: (d: SpecDraft) => void;
  preview?: boolean;
  pickerOpen?: boolean;
  count?: number;
}) {
  const d = value;
  const set = <K extends keyof SpecDraft>(k: K, v: SpecDraft[K]) => onChange({ ...d, [k]: v });
  const def = itemDef(d.def);
  const slot = def?.slot;
  const effects = slot === 'emote' ? UNUSUAL_EFFECTS.filter((e) => e.taunt) : UNUSUAL_EFFECTS;
  const effectNote = slot === 'hat' || slot === 'emote' ? undefined : 'shows on hats + emotes';
  const ksNote = slot === 'finish' ? undefined : 'shows on finishes';
  const staffBound = !!def && !def.tradable && def.tier === 'unobtainable';

  const form = (
    <div className='flex min-w-0 flex-col gap-4'>
      <DefPicker value={d.def} onPick={(id) => set('def', id)} startOpen={pickerOpen} />

      <fieldset className='grid gap-3 sm:grid-cols-2'>
        <legend className='mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/70'>Qualities</legend>
        <Field label='Unusual effect' hint={effectNote}>
          <select className={selectCls} value={d.effect} onChange={(e) => set('effect', e.target.value)} data-field='spec-effect'>
            <option value='' className={opt}>None</option>
            {effects.map((e) => (
              <option key={e.id} value={e.id} className={opt}>{e.name}</option>
            ))}
          </select>
        </Field>
        <div className='flex flex-wrap items-end gap-x-5 gap-y-2'>
          <span className='flex items-center gap-2'>
            <Check checked={d.strange} onChange={(v) => set('strange', v)} field='spec-strange'>Strange</Check>
            {d.strange && (
              <input className={`${inputCls} w-24`} inputMode='numeric' value={d.kills} onChange={(e) => set('kills', e.target.value.replace(/[^0-9]/g, ''))} aria-label='Starting kills' title='Starting kill count' data-field='spec-kills' />
            )}
          </span>
          <Check checked={d.festive} onChange={(v) => set('festive', v)} field='spec-festive'>Festive</Check>
        </div>
        <Field label='Killstreak sheen' hint={ksNote}>
          <span className='flex items-center gap-2'>
            <select className={`${selectCls} flex-1`} value={d.sheen} onChange={(e) => onChange({ ...d, sheen: e.target.value, ksEffect: e.target.value ? d.ksEffect : '' })} data-field='spec-sheen'>
              <option value='' className={opt}>None</option>
              {KS_SHEENS.map((s) => (
                <option key={s.id} value={s.id} className={opt}>{s.name}</option>
              ))}
            </select>
            {d.sheen && <span className='inline-block h-4 w-4 shrink-0 rounded-sm' style={{ background: KS_SHEENS.find((s) => s.id === d.sheen)?.color }} aria-hidden />}
          </span>
        </Field>
        <Field label='Professional effect' hint={d.sheen ? undefined : 'needs a sheen'}>
          <select className={selectCls} value={d.ksEffect} disabled={!d.sheen} onChange={(e) => set('ksEffect', e.target.value)} data-field='spec-ksEffect'>
            <option value='' className={opt}>None</option>
            {KS_EFFECTS.map((s) => (
              <option key={s.id} value={s.id} className={opt}>{s.name}</option>
            ))}
          </select>
        </Field>
        {slot === 'finish' && (
          <>
            <Field label='Pattern seed' hint='0–999 · blank = none'>
              <input className={inputCls} inputMode='numeric' value={d.seed} onChange={(e) => set('seed', e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} placeholder='318' data-field='spec-seed' />
            </Field>
          </>
        )}
      </fieldset>

      <fieldset className='grid gap-3 sm:grid-cols-2'>
        <legend className='mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-fuchsia-300/70'>One-off</legend>
        <Field label='Custom name' hint='≤ 40'>
          <input className={inputCls} maxLength={40} value={d.customName} onChange={(e) => set('customName', e.target.value)} placeholder={def?.name} data-field='spec-name' />
        </Field>
        <Field label='Tier override'>
          <select className={selectCls} value={d.tier} onChange={(e) => set('tier', e.target.value as Tier | '')} data-field='spec-tier'>
            <option value='' className={opt}>Def default ({def ? TIER_META[def.tier].label : '—'})</option>
            {TIERS.map((t) => (
              <option key={t} value={t} className={opt}>{TIER_META[t].label}</option>
            ))}
          </select>
        </Field>
        <Field label='Custom description' hint='≤ 200' wide>
          <input className={inputCls} maxLength={200} value={d.customDesc} onChange={(e) => set('customDesc', e.target.value)} placeholder={def?.blurb} data-field='spec-desc' />
        </Field>
        <Field label='Tint'>
          <span className='flex items-center gap-2'>
            <input
              type='color'
              aria-label='Tint colour'
              value={HEX6.test(d.tint) ? d.tint : '#ff4fd8'}
              onChange={(e) => set('tint', e.target.value)}
              className='h-[30px] w-10 shrink-0 cursor-pointer rounded border border-white/15 bg-transparent'
              data-field='spec-tint-picker'
            />
            <input className={`${inputCls} w-28`} value={d.tint} onChange={(e) => set('tint', e.target.value.trim())} placeholder='none' aria-label='Tint hex' data-field='spec-tint' />
            {d.tint && (
              <button type='button' className='text-[10px] font-bold text-white/40 hover:text-rose-300' onClick={() => set('tint', '')} aria-label='Clear tint'>
                ✕
              </button>
            )}
            {d.tint && !HEX6.test(d.tint) && <span className='text-[11px] text-rose-300'>#rrggbb</span>}
          </span>
        </Field>
        <Field label='Name tag' hint='≤ 24'>
          <input className={inputCls} maxLength={24} value={d.nameTag} onChange={(e) => set('nameTag', e.target.value)} data-field='spec-nametag' />
        </Field>
        <div className='flex items-end sm:col-span-2'>
          <Check checked={d.bound || staffBound} disabled={staffBound} onChange={(v) => set('bound', v)} field='spec-bound'>
            Bound (untradable){staffBound ? ' — staff gear is always bound' : ''}
          </Check>
        </div>
      </fieldset>
    </div>
  );

  if (!preview) return form;
  return (
    <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]'>
      {form}
      <div className='lg:sticky lg:top-4 lg:self-start'>
        <div className='rounded-lg border border-white/10 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(103,232,249,0.08),transparent_70%)] p-4'>
          <SpecPreview draft={d} count={count} />
        </div>
      </div>
    </div>
  );
}
