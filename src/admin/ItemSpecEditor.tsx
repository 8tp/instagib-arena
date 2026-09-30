// The admin item generator. Pick a base item (ItemPicker), then dress it — but
// only with what that item's slot can carry: the quality fields come straight
// from SLOT_ATTRS (game/items/types.ts), the same table the server enforces in
// prepareAdminItem. Switching the base item clears whatever the new slot can't
// take. One editor feeds direct mints (Items), code rewards and gifts.
import '../locker/locker.css';
import '../economy/economy.css';
import { useEffect } from 'react';
import { itemDef } from '../game/items/catalog';
import { prefetchThumbnails } from '../game/thumbs';
import { lookKey } from '../economy/look';
import { KS_EFFECTS, KS_SHEENS, SLOT_ATTRS, TIERS, TIER_META, strangeRank, type SlotAttr, type Tier } from '../game/items/types';
import { SLOT_LABEL, defSeason, instBaseName, instBlurb, instPrefixParts, instTags, instTier, thumbLook } from '../economy/display';
import { TagPills, TierChip } from '../economy/parts';
import { specPreview } from '../inbox/reward';
import { SpecTile } from '../inbox/RewardBits';
import { TIER_COLOR, isIridescent } from '../ui/rarity';
import { Select } from './combobox';
import { ItemPicker, TierDot } from './ItemPicker';
import { HEX6, draftToSpec, effectsFor, retarget, type SpecDraft } from './spec-draft';
import { Field, Toggle } from './ui';

const ATTR_LABEL: Record<SlotAttr, string> = {
  effect: 'Anomalous effect',
  kills: 'Tracked',
  sheen: 'Killstreak sheen',
  ksEffect: 'Professional effect',
  festive: 'Festive',
  seed: 'Pattern seed',
  tint: 'Tint',
};
const ALL_ATTRS = Object.keys(ATTR_LABEL) as SlotAttr[];

function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <fieldset className='flex min-w-0 flex-col gap-3 border-t border-[var(--adm-line)] pt-4'>
      <legend className='sr-only'>{title}</legend>
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1'>
        <span className='adm-section-label'>{title}</span>
        {note && <span className='text-[12px] text-[var(--adm-ink-3)]'>{note}</span>}
      </div>
      {children}
    </fieldset>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────
export function SpecPreview({ draft, count }: { draft: SpecDraft; count?: number }) {
  const inst = specPreview(draftToSpec(draft));
  const tier = instTier(inst);
  const def = itemDef(inst.def);
  const season = defSeason(inst.def);
  const prefix = instPrefixParts(inst);
  const blurb = instBlurb(inst);
  // The preview is what the admin is looking at: its render jumps the queue.
  const look = thumbLook(inst);
  const key = look ? lookKey(look) : inst.def;
  useEffect(() => {
    prefetchThumbnails([key], true);
  }, [key]);
  return (
    <div className='flex flex-col items-center gap-3 text-center' data-spec-preview>
      <div className='relative w-[176px]'>
        <SpecTile inst={inst} fluid />
        {count != null && count > 1 && (
          <span className='absolute -bottom-2 -right-2 bg-[var(--adm-rail)] px-1.5 py-0.5 font-mono text-[13px] font-bold text-[#041016]'>×{count}</span>
        )}
      </div>
      <div className='font-display text-[18px] font-semibold uppercase leading-tight' data-preview-name>
        {prefix.map((p) => (
          <span key={p.text} style={{ color: p.color }}>
            {p.text}{' '}
          </span>
        ))}
        <span className={isIridescent(tier) ? 'ec-iri-text' : ''} style={isIridescent(tier) ? undefined : { color: TIER_COLOR[tier].text }}>
          {instBaseName(inst)}
        </span>
      </div>
      <div className='flex flex-wrap items-center justify-center gap-1.5 text-[12px] text-[var(--adm-ink-2)]'>
        <TierChip tier={tier} />
        {def && <span>{SLOT_LABEL[def.slot]}</span>}
        {season && <span>· {season.name}</span>}
      </div>
      <TagPills tags={instTags(inst)} />
      {blurb && <p className='max-w-[240px] text-[12px] italic leading-snug text-[var(--adm-ink-2)]'>“{blurb}”</p>}
      <div className='flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px]'>
        <span style={{ color: inst.tradable ? 'var(--adm-good)' : 'var(--adm-warn)' }}>{inst.tradable ? 'Tradable' : 'Bound · untradable'}</span>
        {inst.attrs.tint && (
          <span className='flex items-center gap-1 font-mono text-[var(--adm-ink-2)]'>
            <span className='adm-key' style={{ background: inst.attrs.tint }} /> {inst.attrs.tint}
          </span>
        )}
        {inst.attrs.seed != null && <span className='font-mono text-[var(--adm-ink-2)]'>Pattern #{inst.attrs.seed}</span>}
        {inst.attrs.nameTag && <span className='text-[var(--adm-ink-2)]'>Tag “{inst.attrs.nameTag}”</span>}
      </div>
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────
export function ItemSpecEditor({ value, onChange, preview = true, count }: { value: SpecDraft; onChange: (d: SpecDraft) => void; preview?: boolean; count?: number }) {
  const d = value;
  const set = <K extends keyof SpecDraft>(k: K, v: SpecDraft[K]) => onChange({ ...d, [k]: v });
  const def = itemDef(d.def);
  const slot = def?.slot;
  const has = (a: SlotAttr) => !!slot && SLOT_ATTRS[slot].includes(a);
  const effects = effectsFor(slot);
  const missing = slot ? ALL_ATTRS.filter((a) => !has(a)) : [];
  const staffBound = !!def && !def.tradable && def.tier === 'unobtainable'; // staff gear (server: STAFF_INSTANCE_DEFS)
  const slotName = slot ? SLOT_LABEL[slot] : 'item';
  const any = slot ? SLOT_ATTRS[slot].length > 0 : false;
  const kills = Math.floor(Number(d.kills) || 0);

  const form = (
    <div className='flex min-w-0 flex-col gap-4'>
      <Field label='Base item' hint='the art, slot and default tier' as='div'>
        <ItemPicker value={d.def} onChange={(id) => onChange(retarget(d, id))} />
      </Field>

      <Section
        title={`${slotName} qualities`}
        note={
          any && missing.length ? (
            <>
              {slotName}s can’t carry: {missing.map((a) => ATTR_LABEL[a]).join(', ')}
            </>
          ) : undefined
        }
      >
        {!any ? (
          <p className='text-[13px] text-[var(--adm-ink-3)]' data-no-qualities>
            {slotName}s take no qualities. The one-off fields below still apply.
          </p>
        ) : (
          <div className='grid gap-x-4 gap-y-3 sm:grid-cols-2'>
            {has('effect') && (
              <Field label='Anomalous effect' hint={slot === 'emote' ? 'taunt-capable only' : undefined} as='div'>
                <Select
                  label='Anomalous effect'
                  value={d.effect}
                  onChange={(v) => set('effect', v)}
                  options={[{ value: '', label: 'None' }, ...effects.map((e) => ({ value: e.id, label: e.name, hint: e.taunt && slot !== 'emote' ? 'taunt' : undefined }))]}
                  field='spec-effect'
                />
              </Field>
            )}
            {has('kills') && (
              <Field label='Tracked kill counter' hint={d.strange ? `rank: ${strangeRank(kills)}` : undefined} as='div'>
                <span className='flex h-[34px] items-center gap-3'>
                  <Toggle checked={d.strange} onChange={(v) => set('strange', v)} field='spec-strange'>
                    Tracked
                  </Toggle>
                  {d.strange && (
                    <input
                      className='adm-input mono w-28'
                      inputMode='numeric'
                      value={d.kills}
                      onChange={(e) => set('kills', e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                      aria-label='Starting kills'
                      placeholder='0'
                      data-field='spec-kills'
                    />
                  )}
                </span>
              </Field>
            )}
            {has('sheen') && (
              <Field label='Killstreak sheen' as='div'>
                <Select
                  label='Killstreak sheen'
                  value={d.sheen}
                  onChange={(v) => onChange({ ...d, sheen: v, ksEffect: v ? d.ksEffect : '' })}
                  options={[{ value: '', label: 'None' }, ...KS_SHEENS.map((s) => ({ value: s.id, label: s.name, swatch: s.color }))]}
                  field='spec-sheen'
                />
              </Field>
            )}
            {has('ksEffect') && (
              <Field label='Professional effect' hint={d.sheen ? 'makes it Professional' : 'pick a sheen first'} as='div'>
                <Select
                  label='Professional effect'
                  value={d.ksEffect}
                  disabled={!d.sheen}
                  onChange={(v) => set('ksEffect', v)}
                  options={[{ value: '', label: 'None' }, ...KS_EFFECTS.map((s) => ({ value: s.id, label: s.name }))]}
                  field='spec-ksEffect'
                />
              </Field>
            )}
            {has('seed') && (
              <Field label='Pattern seed' hint='0–999 · blank = none' as='div'>
                <span className='flex gap-2'>
                  <input
                    className='adm-input mono w-24'
                    inputMode='numeric'
                    aria-label='Pattern seed'
                    value={d.seed}
                    onChange={(e) => set('seed', e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                    placeholder='318'
                    data-field='spec-seed'
                  />
                  <button type='button' className='adm-btn' onClick={() => set('seed', String(Math.floor(Math.random() * 1000)))}>
                    Random
                  </button>
                </span>
              </Field>
            )}
            {has('tint') && (
              <Field label='Tint' hint='one-off colour' as='div'>
                <span className='flex items-center gap-2'>
                  {/* Empty = a "no colour" swatch over the native picker (still clickable). */}
                  <span className='relative h-[34px] w-11 shrink-0'>
                    <input
                      type='color'
                      aria-label='Tint colour'
                      value={HEX6.test(d.tint) ? d.tint : '#ff4fd8'}
                      onChange={(e) => set('tint', e.target.value)}
                      className='h-full w-full cursor-pointer border border-[var(--adm-line-2)] bg-[var(--adm-plate)] p-0.5'
                      data-field='spec-tint-picker'
                    />
                    {!HEX6.test(d.tint) && (
                      <span
                        aria-hidden
                        className='pointer-events-none absolute inset-0 border border-[var(--adm-line-2)] bg-[var(--adm-plate)]'
                        style={{ backgroundImage: 'linear-gradient(to top right, transparent calc(50% - 1px), var(--adm-ink-3) calc(50% - 1px), var(--adm-ink-3) calc(50% + 1px), transparent calc(50% + 1px))' }}
                      />
                    )}
                  </span>
                  <input
                    className='adm-input mono w-28'
                    value={d.tint}
                    onChange={(e) => set('tint', e.target.value.trim())}
                    placeholder='none'
                    aria-label='Tint hex'
                    aria-invalid={!!d.tint && !HEX6.test(d.tint)}
                    data-field='spec-tint'
                  />
                  {d.tint && (
                    <button type='button' className='adm-btn sm ghost' onClick={() => set('tint', '')}>
                      Clear
                    </button>
                  )}
                </span>
              </Field>
            )}
            {has('festive') && (
              <div className='flex items-end pb-1.5'>
                <Toggle checked={d.festive} onChange={(v) => set('festive', v)} field='spec-festive' hint='holiday lights'>
                  Festive
                </Toggle>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title='One-off' note='applies to every item'>
        <div className='grid gap-x-4 gap-y-3 sm:grid-cols-2'>
          <Field label='Custom name' hint='≤ 40'>
            <input className='adm-input' maxLength={40} value={d.customName} onChange={(e) => set('customName', e.target.value)} placeholder={def?.name} data-field='spec-name' />
          </Field>
          <Field label='Tier' as='div'>
            <Select<Tier | ''>
              label='Tier'
              value={d.tier}
              onChange={(v) => set('tier', v)}
              options={[
                { value: '', label: def ? `Default · ${TIER_META[def.tier].label}` : 'Default', icon: def ? <TierDot tier={def.tier} /> : undefined },
                ...TIERS.map((t) => ({ value: t, label: TIER_META[t].label, icon: <TierDot tier={t} /> })),
              ]}
              field='spec-tier'
            />
          </Field>
          <Field label='Custom description' hint='≤ 200' className='sm:col-span-2'>
            <input className='adm-input' maxLength={200} value={d.customDesc} onChange={(e) => set('customDesc', e.target.value)} placeholder={def?.blurb} data-field='spec-desc' />
          </Field>
          <Field label='Name tag' hint='≤ 24'>
            <input className='adm-input' maxLength={24} value={d.nameTag} onChange={(e) => set('nameTag', e.target.value)} placeholder='None' data-field='spec-nametag' />
          </Field>
          <div className='flex items-end pb-1.5'>
            <Toggle checked={d.bound || staffBound} disabled={staffBound} onChange={(v) => set('bound', v)} field='spec-bound' hint={staffBound ? 'this item is always bound' : 'can’t be traded or sold'}>
              Bound
            </Toggle>
          </div>
        </div>
      </Section>
    </div>
  );

  if (!preview) return form;
  return (
    <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]'>
      {form}
      <aside className='lg:sticky lg:top-[120px] lg:self-start'>
        <div className='adm-section-label mb-2'>Player gets</div>
        <div className='border border-[var(--adm-line)] bg-[radial-gradient(120%_70%_at_50%_0%,rgba(91,227,255,0.07),transparent_70%)] p-4'>
          <SpecPreview draft={d} count={count} />
        </div>
      </aside>
    </div>
  );
}
