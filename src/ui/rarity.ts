// Rarity colour language + the thumbnail hook shared by item tiles.
import { useEffect, useState } from 'react';
import type { Rarity } from '../game/cosmetics';
import { getThumbnail, peekThumbnail, thumbnailPending } from '../game/thumbs';
import { TIERS, TIER_META, type Tier } from '../game/items/types';

// 7-tier colour language (docs/economy.md). `from`/`to` = the tile's radial
// backdrop, `edge` = the rim / bar / glow (always TIER_META's colour), `text`
// = label on the tile. Unobtainable additionally gets the iridescent
// treatment (`iri`) — a CSS-animated rim, see economy.css.
export type TierColor = { from: string; to: string; edge: string; text: string };
export const TIER_COLOR: Record<Tier, TierColor> = {
  common: { from: '#56606e', to: '#1c222b', edge: TIER_META.common.color, text: '#eef1f5' },
  uncommon: { from: '#2f9a48', to: '#0c2a14', edge: TIER_META.uncommon.color, text: '#e8fbec' },
  rare: { from: '#2f6fe0', to: '#0a2450', edge: TIER_META.rare.color, text: '#e2efff' },
  epic: { from: '#9335e0', to: '#2a0a48', edge: TIER_META.epic.color, text: '#f5eaff' },
  legendary: { from: '#e8850f', to: '#4a1d04', edge: TIER_META.legendary.color, text: '#fff6e0' },
  relic: { from: '#d63030', to: '#3d0808', edge: TIER_META.relic.color, text: '#ffe9e9' },
  unobtainable: { from: '#b03be0', to: '#1a0b36', edge: TIER_META.unobtainable.color, text: '#fff0fc' },
};
export const TIER_LABEL: Record<Tier, string> = Object.fromEntries(TIERS.map((t) => [t, TIER_META[t].label])) as Record<Tier, string>;
export const TIER_RANK: Record<Tier, number> = Object.fromEntries(TIERS.map((t) => [t, TIER_META[t].rank])) as Record<Tier, number>;
export const isIridescent = (t: Tier): boolean => t === 'unobtainable';

// The legacy 4-rarity catalog maps onto the tier colours (v2 screens: road,
// rewards). Cosmetics.ts stays 4-tier; the item catalog re-tiers them.
const LEGACY_TIER: Record<Rarity, Tier> = { common: 'common', rare: 'rare', epic: 'epic', legendary: 'legendary' };
export const tierOfRarity = (r: Rarity): Tier => LEGACY_TIER[r];
export const RARITY_COLOR: Record<Rarity, TierColor> = {
  common: TIER_COLOR.common,
  rare: TIER_COLOR.rare,
  epic: TIER_COLOR.epic,
  legendary: TIER_COLOR.legendary,
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

// Sort key: higher = rarer.
export const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

export function useThumbnail(id: string): string | null {
  const [url, setUrl] = useState<string | null>(() => peekThumbnail(id));
  useEffect(() => {
    let live = true;
    setUrl(peekThumbnail(id));
    void getThumbnail(id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

// Same, plus whether it is still rendering (so a tile can hold a quiet
// placeholder rather than flash its no-thumbnail fallback).
export function useThumbnailState(id: string): { url: string | null; pending: boolean } {
  const url = useThumbnail(id);
  return { url, pending: !url && thumbnailPending(id) };
}
