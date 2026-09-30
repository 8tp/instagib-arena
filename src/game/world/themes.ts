// World-theme registry: map id → look (world/looks/<mapId>.ts). Types and
// helpers live in theme-kit.ts and are re-exported here for the renderer.
import { VOID } from './looks/causeway';
import { NIGHTPORT } from './looks/containeryard';
import { RUSTDUSK } from './looks/derrick';
import { LOUNGE } from './looks/lounge';
import { DUSK } from './looks/nuketown';
import { REACTOR } from './looks/reactor';
import { LAB } from './looks/training';
import type { WorldTheme } from './theme-kit';

export * from './theme-kit';

const BY_MAP: Record<string, WorldTheme> = {
  causeway: VOID,
  reactor: REACTOR,
  lounge: LOUNGE,
  nuketown: DUSK,
  containeryard: NIGHTPORT,
  derrick: RUSTDUSK,
  training: LAB,
};

// Theme for a map id (unknown maps get the neutral lab look).
export function themeForMapId(id: string | undefined): WorldTheme {
  return (id && BY_MAP[id]) || LAB;
}
