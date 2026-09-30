// Adapter over the wearable builders (src/game/wearables — owned by another
// track). Resolved with a glob so this file typechecks and builds before that
// module lands; once it exists `WornGearCtor` lights up hats / faces / backs.
import type { Character } from '../game/character/character';
import { UNUSUAL_EFFECTS, type Look } from '../game/items/types';

export type GearSlot = 'hat' | 'face' | 'back';
export interface GearLike {
  setLook(slot: GearSlot, look: Look | null): void;
  setUnusual(kind: string | null): void;
  update(dt: number): void;
  dispose(): void;
  headTopY(): number;
}
type GearCtor = new (character: Character) => GearLike;

const mods = import.meta.glob('../game/wearables/index.ts', { eager: true }) as Record<string, { WornGear?: GearCtor }>;

export const WornGearCtor: GearCtor | null = Object.values(mods)[0]?.WornGear ?? null;
export const HAS_GEAR = WornGearCtor !== null;

// Put a Look on a gear slot AND seat its Unusual effect (a hat's `e`). setLook
// alone leaves the unusual off — every preview / podium / thumbnail path goes
// through here so an Unusual hat always shows its effect.
export function wearLook(gear: GearLike, slot: GearSlot, look: Look | null): void {
  gear.setLook(slot, look);
  if (slot === 'hat') gear.setUnusual((look?.e && UNUSUAL_EFFECTS.find((u) => u.id === look.e)?.kind) || null);
}
