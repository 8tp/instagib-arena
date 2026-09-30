// What the item-preview modal (ItemPreviewModal.tsx) shows, and which items
// it can show. THREE-free.
import { itemDef } from '../game/items/catalog';
import type { ItemInstanceWire, Look, Tier } from '../game/items/types';
import { instBaseName, instBlurb, instFullName, instLook, instTags, instTier, type Tag } from './display';

export type PreviewItem = {
  def: string;
  look: Look | null; // the rolled Look (effect…); null → the plain def
  name: string;
  tier: Tier;
  blurb?: string;
  tags?: Tag[];
};

// Cards live on the Locker's own card showcase; defaults have nothing to show.
export function canPreview(def: string): boolean {
  const d = itemDef(def);
  return !!d && !d.default && d.slot !== 'card';
}

export function previewOfInst(i: ItemInstanceWire): PreviewItem {
  return { def: i.def, look: instLook(i), name: instFullName(i) || instBaseName(i), tier: instTier(i), blurb: instBlurb(i), tags: instTags(i) };
}

export function previewOfDef(id: string): PreviewItem | null {
  const d = itemDef(id);
  return d ? { def: d.id, look: null, name: d.name, tier: d.tier, blurb: d.blurb } : null;
}
