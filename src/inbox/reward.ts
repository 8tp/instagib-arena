// Pure helpers for reward bundles (docs/economy.md §7b): turn an item SPEC (a
// code's / gift's attachment, not yet minted) into a preview instance the tiles
// can draw, and summarise a bundle in one line. THREE-free; shared by the inbox,
// the admin editors and the economy mock.
import { itemDef } from '../game/items/catalog';
import { TIER_META, type InboxMessageWire, type ItemAttrs, type ItemInstanceWire, type Quality, type RewardBundle, type RewardItemSpec, type Tier } from '../game/items/types';
import { instFullName } from '../economy/display';

// The qualities an admin spec ends up with — mirrors server prepareAdminItem().
export function specQualities(spec: Pick<RewardItemSpec, 'quality' | 'attrs' | 'tier'>): Quality[] {
  const a = (spec.attrs ?? {}) as ItemAttrs & { tier?: Tier };
  const q = new Set<Quality>(spec.quality ?? []);
  if (a.effect) q.add('unusual');
  if (a.kills != null) q.add('strange');
  if (a.ksEffect) {
    q.add('killstreak');
    q.add('professional');
  } else if (a.sheen) q.add('killstreak');
  if (a.festive) q.add('festive');
  if (a.customName || a.customDesc || a.tint || a.tier || spec.tier) q.add('admin');
  return [...q];
}

// A spec as a (never-minted) instance, for tiles / names / tags.
export function specPreview(spec: RewardItemSpec, key: string | number = 'preview'): ItemInstanceWire {
  const { tier: attrTier, ...attrs } = (spec.attrs ?? {}) as ItemAttrs & { tier?: Tier };
  const tier = spec.tier ?? attrTier;
  const def = itemDef(spec.def);
  const out: ItemInstanceWire = {
    uid: `spec-${key}`,
    def: spec.def,
    mint: 0,
    quality: specQualities(spec),
    attrs,
    origin: 'gift',
    tradable: !spec.bound && (def?.tradable ?? true),
    state: 'owned',
    createdAt: 0,
  };
  if (tier) out.tier = tier;
  return out;
}

export const bundleHasItems = (b: RewardBundle | undefined): boolean => !!b?.items?.length;
export const bundleIsEmpty = (b: RewardBundle | undefined): boolean => !b || (!b.credits && !b.rolls && !bundleHasItems(b));

// "⛁ 500 · 3 rolls · Unusual Top Hat +1"
export function bundleSummary(b: RewardBundle | undefined): string {
  if (bundleIsEmpty(b)) return 'Nothing attached';
  const parts: string[] = [];
  if (b!.credits) parts.push(`⛁ ${b!.credits.toLocaleString()}`);
  if (b!.rolls) parts.push(`${b!.rolls} free roll${b!.rolls === 1 ? '' : 's'}`);
  const items = b!.items ?? [];
  if (items.length) parts.push(items.length === 1 ? instFullName(specPreview(items[0])) : `${instFullName(specPreview(items[0]))} +${items.length - 1}`);
  return parts.join(' · ');
}

// The highest tier among some instances (drives the reveal's colour + juice).
export function topTier(items: readonly ItemInstanceWire[]): Tier | null {
  let best: Tier | null = null;
  for (const it of items) {
    const t = it.tier ?? itemDef(it.def)?.tier ?? 'common';
    if (!best || TIER_META[t].rank > TIER_META[best].rank) best = t;
  }
  return best;
}

// ── Inbox message state ─────────────────────────────────────────────────────
export const isExpired = (m: InboxMessageWire, t = Date.now()): boolean => m.expiresAt > 0 && m.expiresAt <= t;
export const claimable = (m: InboxMessageWire, t = Date.now()): boolean => !m.claimedAt && !bundleIsEmpty(m.reward) && !isExpired(m, t);
// The same counts the server's `GET /api/inbox?summary=1` returns.
export function summarize(ms: readonly InboxMessageWire[]): { unread: number; unclaimed: number } {
  const t = Date.now();
  return { unread: ms.filter((m) => !m.readAt).length, unclaimed: ms.filter((m) => claimable(m, t)).length };
}
