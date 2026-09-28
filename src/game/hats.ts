import type * as THREE from 'three';
import { unusualById } from './cosmetics';
import { characterOfSocket } from './character/character';
import { WornGear, type GearMotion } from './wearables';

// Legacy hat API — a thin wrapper over WornGear (src/game/wearables/), kept so
// existing callers (remote players, bots, podium, previews, thumbnails, labs)
// work unchanged until they move to WornGear directly. Hats are now built in
// code (no glTF): setHat() takes the same ids ('hat.tophat', …) and resolves
// synchronously; 'hat.none' / unknown = bare. setUnusual() takes the legacy
// 'unusual.*' ids.

export class WornHat {
  // The underlying gear (null only if the socket isn't a combatant's).
  readonly gear: WornGear | null;
  private current = '';

  constructor(socket: THREE.Object3D) {
    const ch = characterOfSocket(socket);
    this.gear = ch ? new WornGear(ch) : null;
  }

  // Equip a hat by id. Kept async for API compatibility; resolves at once.
  async setHat(id: string): Promise<void> {
    if (id === this.current) return;
    this.current = id;
    this.gear?.setLook('hat', id && id !== 'hat.none' ? { d: id } : null);
  }

  // Equip an unusual particle effect by legacy id. 'unusual.none' = off.
  setUnusual(id: string): void {
    const kind = unusualById(id).kind;
    this.gear?.setUnusual(kind === 'none' ? null : kind);
  }

  update(dt: number, motion?: GearMotion): void {
    this.gear?.update(dt, motion);
  }

  setVisible(v: boolean): void {
    this.gear?.setVisible(v);
  }

  dispose(): void {
    this.gear?.dispose();
  }
}
