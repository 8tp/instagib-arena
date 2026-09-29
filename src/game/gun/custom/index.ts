import type { CustomGunBuild } from './types';
import { buildPrism } from './prism';
import { buildDragon } from './dragon';
import { buildTesla } from './tesla';
import { buildReaper } from './reaper';
import { buildSeraph } from './seraph';
import { buildOblivion } from './oblivion';
import { buildCelestial } from './celestial';
import { buildSovereign } from './sovereign';
import { registerCustomGun } from './registry';

// Every custom railgun model, keyed by RailgunFinish.model (cosmetics.ts).
// Registered with the weapon track's registry on import (custom/load.ts
// glob-imports this file).
export const CUSTOM_GUN_BUILDS: Record<string, CustomGunBuild> = {
  prism: buildPrism,
  dragon: buildDragon,
  tesla: buildTesla,
  reaper: buildReaper,
  seraph: buildSeraph,
  oblivion: buildOblivion,
  celestial: buildCelestial,
  sovereign: buildSovereign,
};

export const CUSTOM_GUN_KEYS = Object.keys(CUSTOM_GUN_BUILDS);


for (const key of CUSTOM_GUN_KEYS) registerCustomGun(key, CUSTOM_GUN_BUILDS[key]);
