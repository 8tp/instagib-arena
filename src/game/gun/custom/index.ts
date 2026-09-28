import type { CustomGunBuild } from './types';
import { buildPrism } from './prism';
import { buildDragon } from './dragon';
import { buildTesla } from './tesla';
import { buildReaper } from './reaper';
import { buildSeraph } from './seraph';

// Every custom railgun model, keyed by RailgunFinish.model (cosmetics.ts).
// Registered with the weapon track's registry on import (custom/load.ts
// glob-imports this file).
export const CUSTOM_GUN_BUILDS: Record<string, CustomGunBuild> = {
  prism: buildPrism,
  dragon: buildDragon,
  tesla: buildTesla,
  reaper: buildReaper,
  seraph: buildSeraph,
};

export const CUSTOM_GUN_KEYS = Object.keys(CUSTOM_GUN_BUILDS);

// Registry shim until registry.ts (weapon track) is merged: at merge, replace
// with `import { registerCustomGun } from './registry';`.
const registerCustomGun = (_key: string, _build: CustomGunBuild): void => {};

for (const key of CUSTOM_GUN_KEYS) registerCustomGun(key, CUSTOM_GUN_BUILDS[key]);
