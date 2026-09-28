import type { CustomGunBuild } from './types';
import { buildPrism } from './prism';

// Every custom railgun model, keyed by RailgunFinish.model (cosmetics.ts).
// Registered with the weapon track's registry on import (custom/load.ts
// glob-imports this file).
export const CUSTOM_GUN_BUILDS: Record<string, CustomGunBuild> = {
  prism: buildPrism,
};

export const CUSTOM_GUN_KEYS = Object.keys(CUSTOM_GUN_BUILDS);

// Registry shim until registry.ts (weapon track) is merged: at merge, replace
// with `import { registerCustomGun } from './registry';`.
const registerCustomGun = (_key: string, _build: CustomGunBuild): void => {};

for (const key of CUSTOM_GUN_KEYS) registerCustomGun(key, CUSTOM_GUN_BUILDS[key]);
