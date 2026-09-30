// The admin item-spec form state (strings for the inputs) ⇄ a RewardItemSpec
// the server accepts (server/economy.ts prepareAdminItem). Shared by the Items
// tab (direct mint) and the Codes / Gifts reward bundles.
import { ITEM_DEFS, itemDef } from '../game/items/catalog';
import { UNUSUAL_EFFECTS, slotAllows, type ItemAttrs, type ItemSlot, type RewardBundle, type RewardItemSpec, type SlotAttr, type Tier } from '../game/items/types';
import { specQualities } from '../inbox/reward';

// Everything an admin can mint: not a virtual default, not an entitlement slot.
export const MINTABLE = ITEM_DEFS.filter((d) => !d.default && d.slot !== 'card' && d.slot !== 'title');

export type SpecDraft = {
  key: number;
  def: string;
  effect: string;
  strange: boolean;
  kills: string;
  festive: boolean;
  sheen: string;
  ksEffect: string;
  seed: string;
  customName: string;
  customDesc: string;
  nameTag: string;
  tint: string; // '' = none, else '#rrggbb'
  tier: Tier | '';
  bound: boolean;
};

let seq = 1;
export function newDraft(def = 'hat.tophat'): SpecDraft {
  return { key: seq++, def, effect: '', strange: false, kills: '0', festive: false, sheen: '', ksEffect: '', seed: '', customName: '', customDesc: '', nameTag: '', tint: '', tier: '', bound: false };
}

export const HEX6 = /^#[0-9a-fA-F]{6}$/;

// Which attributes a def's slot takes (types.ts SLOT_ATTRS — the same table the
// server's prepareAdminItem enforces). Unknown def → nothing slot-specific.
export const allows = (def: string, attr: SlotAttr): boolean => {
  const slot = itemDef(def)?.slot;
  return !!slot && slotAllows(slot, attr);
};
// Anomalous effects valid on a slot (emotes take only the taunt-capable ones).
export const effectsFor = (slot: ItemSlot | undefined) =>
  !slot || !slotAllows(slot, 'effect') ? [] : slot === 'emote' ? UNUSUAL_EFFECTS.filter((e) => e.taunt) : UNUSUAL_EFFECTS;

// Re-point a draft at another def, clearing whatever the new slot can't carry
// (the universal fields — name, description, tag, tier, bound — survive).
export function retarget(d: SpecDraft, def: string): SpecDraft {
  const next: SpecDraft = { ...d, def };
  const slot = itemDef(def)?.slot;
  if (!allows(def, 'effect') || !effectsFor(slot).some((e) => e.id === d.effect)) next.effect = '';
  if (!allows(def, 'kills')) {
    next.strange = false;
    next.kills = '0';
  }
  if (!allows(def, 'festive')) next.festive = false;
  if (!allows(def, 'sheen')) next.sheen = '';
  if (!allows(def, 'ksEffect') || !next.sheen) next.ksEffect = '';
  if (!allows(def, 'seed')) next.seed = '';
  if (!allows(def, 'tint')) next.tint = '';
  return next;
}

// Only the attributes the def's slot takes go out — the preview, the validator
// and the server all see the same item.
export function draftToSpec(draft: SpecDraft): RewardItemSpec {
  const d = retarget(draft, draft.def);
  const attrs: ItemAttrs = {};
  if (d.effect) attrs.effect = d.effect;
  if (d.strange) attrs.kills = Math.max(0, Math.min(10_000_000, Math.floor(Number(d.kills) || 0)));
  if (d.festive) attrs.festive = true;
  if (d.sheen) attrs.sheen = d.sheen;
  if (d.ksEffect) attrs.ksEffect = d.ksEffect;
  if (d.seed.trim() !== '') attrs.seed = Math.max(0, Math.min(999, Math.floor(Number(d.seed) || 0)));
  if (d.customName.trim()) attrs.customName = d.customName.trim().slice(0, 40);
  if (d.customDesc.trim()) attrs.customDesc = d.customDesc.trim().slice(0, 200);
  if (d.nameTag.trim()) attrs.nameTag = d.nameTag.trim().slice(0, 24);
  if (HEX6.test(d.tint)) attrs.tint = d.tint.toLowerCase();
  const spec: RewardItemSpec = { def: d.def, attrs };
  if (d.tier) spec.tier = d.tier;
  if (d.bound) spec.bound = true;
  spec.quality = specQualities(spec);
  return spec;
}

// A stored spec (from a code / gift) back into a form draft.
export function specToDraft(s: RewardItemSpec): SpecDraft {
  const a = (s.attrs ?? {}) as ItemAttrs & { tier?: Tier };
  return retarget({
    ...newDraft(s.def),
    effect: a.effect ?? '',
    strange: a.kills != null,
    kills: String(a.kills ?? 0),
    festive: !!a.festive,
    sheen: a.sheen ?? '',
    ksEffect: a.ksEffect ?? '',
    seed: a.seed != null ? String(a.seed) : '',
    customName: a.customName ?? '',
    customDesc: a.customDesc ?? '',
    nameTag: a.nameTag ?? '',
    tint: a.tint ?? '',
    tier: s.tier ?? a.tier ?? '',
    bound: !!s.bound,
  }, s.def);
}

// The Codes / Gifts bundle form.
export type BundleDraft = { credits: string; rolls: string; items: SpecDraft[] };
export const emptyBundle = (): BundleDraft => ({ credits: '', rolls: '', items: [] });

const intOr = (s: string): number | null => {
  const t = s.trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
export function draftToBundle(b: BundleDraft): RewardBundle {
  const out: RewardBundle = {};
  const c = intOr(b.credits);
  const r = intOr(b.rolls);
  // Invalid numbers go through as-is so the server's validator names them.
  if (c === null || c) out.credits = c === null ? (b.credits as unknown as number) : c;
  if (r === null || r) out.rolls = r === null ? (b.rolls as unknown as number) : r;
  if (b.items.length) out.items = b.items.map(draftToSpec);
  return out;
}
export const bundleDraftEmpty = (b: BundleDraft): boolean => !b.credits.trim() && !b.rolls.trim() && b.items.length === 0;
