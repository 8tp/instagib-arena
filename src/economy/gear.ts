// Adapter over the wearable builders (src/game/wearables — owned by another
// track). Resolved with a glob so this file typechecks and builds before that
// module lands; once it exists `WornGearCtor` lights up hats / faces / backs.
import type { Character } from '../game/character/character';
import type { Look } from '../game/items/types';

export type GearSlot = 'hat' | 'face' | 'back';
export interface GearLike {
  setLook(slot: GearSlot, look: Look | null): void;
  update(dt: number): void;
  dispose(): void;
  headTopY(): number;
}
type GearCtor = new (character: Character) => GearLike;

const mods = import.meta.glob('../game/wearables/index.ts', { eager: true }) as Record<string, { WornGear?: GearCtor }>;

export const WornGearCtor: GearCtor | null = Object.values(mods)[0]?.WornGear ?? null;
export const HAS_GEAR = WornGearCtor !== null;
