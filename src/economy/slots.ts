// Inventory slot layout (rail groups) and the 3D framing each slot uses, plus
// the Looks → preview-cosmetics bridge. THREE-free.
import type { Settings } from '../app-types';
import type { PreviewCosmetics, PreviewView } from '../game/character-preview';
import { UNUSUALS, cosmeticById, type KillEffectStyle } from '../game/cosmetics';
import { DEFAULT_LOADOUT } from '../game/items/catalog';
import type { ItemSlot, Loadout } from '../game/items/types';
import { legacyUnusualFor } from './display';

export const SLOT_GROUPS: ReadonlyArray<{ id: string; label: string; slots: readonly ItemSlot[] }> = [
  { id: 'character', label: 'Character', slots: ['hat', 'face', 'back'] },
  { id: 'weapon', label: 'Weapon', slots: ['finish', 'beam'] },
  { id: 'effects', label: 'Finisher & effects', slots: ['finisher', 'spawn'] },
  { id: 'identity', label: 'Identity', slots: ['card', 'title', 'nameColor'] },
  { id: 'emotes', label: 'Emotes', slots: ['emote'] },
];
export const ALL_SLOTS: readonly ItemSlot[] = SLOT_GROUPS.flatMap((g) => g.slots);

export const SLOT_VIEW: Record<ItemSlot, PreviewView> = {
  hat: 'head',
  face: 'face',
  back: 'back',
  finish: 'weapon',
  beam: 'weapon',
  finisher: 'finisher',
  spawn: 'spawn',
  emote: 'emote',
  card: 'full',
  nameColor: 'identity',
  title: 'identity',
};

// Slots whose items are level-unlocked entitlements rather than instances.
export const ENTITLEMENT_SLOTS: readonly ItemSlot[] = ['card'];

// What the 3D preview wears: the equipped Looks with `over` (the item being
// tried on) layered on top. `null` clears a slot back to its bare default.
export function previewCosmetics(
  looks: Loadout,
  over: { slot: ItemSlot; look: Loadout[ItemSlot] | null } | null,
  view: PreviewView,
  s: Pick<Settings, 'playerName' | 'reducedEffects'>,
): PreviewCosmetics {
  const L: Loadout = { ...looks };
  if (over) {
    if (over.look) L[over.slot] = over.look;
    else delete L[over.slot];
  }
  const id = (slot: ItemSlot) => L[slot]?.d ?? DEFAULT_LOADOUT[slot];
  const hat = L.hat?.d;
  return {
    hatId: hat && cosmeticById(hat)?.slot === 'hat' ? hat : 'hat.none',
    unusualId: legacyUnusualFor(L.hat?.e, UNUSUALS),
    emoteId: id('emote'),
    railColor: id('beam'),
    railgunFinish: id('finish'),
    killEffect: id('finisher') as KillEffectStyle,
    spawnEffect: id('spawn'),
    view,
    skinSeed: s.playerName || undefined,
    reducedEffects: s.reducedEffects,
    looks: L,
  };
}
