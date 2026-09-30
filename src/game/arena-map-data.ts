// Shared collision geometry + the map registry. Pure data: safe to import on
// the game server. Each arena lives in its own module under ./maps/ (built
// with the helpers in ./maps/kit.ts); its look (materials, lights, sky) lives
// in ./world/looks/<id>.ts.
import type { AABB, Vec3 } from './types';
import type { MapBox } from './maps/kit';
import { CAUSEWAY } from './maps/causeway';
import { CONTAINERYARD } from './maps/containeryard';
import { DERRICK } from './maps/derrick';
import { LOUNGE } from './maps/lounge';
import { NUKETOWN } from './maps/nuketown';
import { REACTOR } from './maps/reactor';
import { TRAINING } from './maps/training';

export type { MapBox };

export type ArenaMap = {
  name: string;
  boxes: MapBox[];
  // Offline start position (solo vs bots / practice). Online spawns come
  // from `spawns` (arena-data.ts reads them for the server).
  spawn: Vec3;
  // Hand-placed spawn points: open, standing room (y = surface top + 0.05),
  // spread over the map so the server's pickSpawn always has a safe choice.
  spawns: Vec3[];
  bounds: AABB;
  // Open-air arena: the ceiling box (index 1) still collides but isn't drawn,
  // so the skybox shows. Use with tall perimeter walls + a high invisible cap.
  openTop?: boolean;
  // Emissive edge-light colour (trim bars on platforms + cover). Defaults to
  // the brand cyan.
  accent?: number;
};

export { CAUSEWAY, CONTAINERYARD, DERRICK, LOUNGE, NUKETOWN, REACTOR, TRAINING };

// Selectable map registry — the competitive pool plus the single-player
// practice range. The large maps carry FFA/TDM; the duel maps carry 1v1.
export const MAPS: ReadonlyArray<{ id: string; label: string; map: ArenaMap }> = [
  // larger FFA / TDM maps
  { id: 'causeway', label: 'Causeway (FFA/TDM)', map: CAUSEWAY },
  { id: 'reactor', label: 'Reactor (FFA/TDM)', map: REACTOR },
  { id: 'lounge', label: 'Lounge (FFA/TDM)', map: LOUNGE },
  { id: 'nuketown', label: 'Nuketown (FFA/TDM)', map: NUKETOWN },
  // 1v1 duel maps
  { id: 'containeryard', label: 'Container Yard (1v1)', map: CONTAINERYARD },
  { id: 'derrick', label: 'Derrick (1v1)', map: DERRICK },
  // practice
  { id: 'training', label: 'Training Range', map: TRAINING },
];

export const DEFAULT_MAP: ArenaMap = CAUSEWAY;

export function mapById(id: string): ArenaMap {
  return MAPS.find((m) => m.id === id)?.map ?? DEFAULT_MAP;
}
