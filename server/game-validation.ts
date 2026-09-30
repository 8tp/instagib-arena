import { mapById } from '../src/game/arena-map-data';
import { rayAabb } from '../src/game/collision';
import { EYE_HEIGHT } from '../src/game/constants';
import type { Vec3 } from '../src/game/types';

// Check solid occupancy and the path between uploaded eyes. The small inset
// tolerates collision rounding at floor/wall contacts without permitting noclip.
export function validPlayerMove(mapId: string, from: Vec3, to: Vec3): boolean {
  const map = mapById(mapId);
  if (to.y + 1.8 > map.bounds.max.y + 0.02) return false;
  const origin = { x: from.x, y: from.y + EYE_HEIGHT, z: from.z };
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  for (const box of map.boxes) {
    if (to.x - 0.38 < box.max.x && to.x + 0.38 > box.min.x &&
        to.z - 0.38 < box.max.z && to.z + 0.38 > box.min.z &&
        to.y + 0.02 < box.max.y && to.y + 1.78 > box.min.y) return false;
    const hit = rayAabb(origin, delta, box);
    if (hit !== null && hit <= 1) return false;
  }
  return true;
}
