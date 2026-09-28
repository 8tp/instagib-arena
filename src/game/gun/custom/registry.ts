import type { CustomGunBuild } from './types';

// Registry of CUSTOM gun models (high-tier finishes carry `finish.model`).
// Model authors (src/game/gun/custom/<key>.ts, registered from custom/index.ts)
// call registerCustomGun(key, build) at import; buildRailgun (viewmodel, lod
// 'high') and AttachedRailgun (third person, lod 'low') look the key up with
// customGun() and fall back to the standard railgun when it is unknown.
//
// The keys match RailgunFinish.model: 'prism' | 'dragon' | 'tesla' | 'reaper' |
// 'seraph' | 'oblivion' | 'celestial' | 'sovereign'.

const builds = new Map<string, CustomGunBuild>();

export function registerCustomGun(key: string, build: CustomGunBuild): void {
  builds.set(key, build);
}

export function customGun(key: string | undefined | null): CustomGunBuild | null {
  return key ? (builds.get(key) ?? null) : null;
}

export function hasCustomGun(key: string | undefined | null): boolean {
  return !!key && builds.has(key);
}
