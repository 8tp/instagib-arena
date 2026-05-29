// Pure (THREE-free) arena network data — the single source of truth the GAME
// SERVER uses for spawns / out-of-bounds checks. It must stay importable from
// `bespick/server/*` (Node, no DOM), so this file MUST NOT import three.js,
// `map.ts`, `textures.ts`, or anything that touches `document`/`window`.
//
// The client renders the geometry from `map.ts`; the server only needs to know
// where it's safe to (re)spawn and when a player has fallen out of the world.
// Spawn points below are hand-authored open-floor positions (y≈0.05) inside
// each map's bounds, picked to avoid the boxes in `map.ts`.

import type { AABB, Vec3 } from './types';

export type ArenaNetData = {
  bounds: AABB;
  killY: number; // y below this → fell out of the world → respawn
  spawns: Vec3[]; // safe ground spawn points
};

const Y = 0.05;
const p = (x: number, z: number): Vec3 => ({ x, y: Y, z });

// killY sits a few metres below each map's floor (floor min.y is -1 in every
// map), so a player who clips through or spawns into the void is recovered.
function arena(
  bounds: AABB,
  spawns: Vec3[],
): ArenaNetData {
  return { bounds, killY: bounds.min.y - 6, spawns };
}

export const ARENA_NET: Record<string, ArenaNetData> = {
  causeway: arena(
    { min: { x: -35, y: -1, z: -25 }, max: { x: 35, y: 22, z: 25 } },
    [p(0, 19), p(0, -19), p(-28, 0), p(28, 0), p(-12, 12), p(12, -12)],
  ),
  spire: arena(
    { min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 26, z: 20 } },
    [p(0, 14), p(0, -14), p(-14, 0), p(14, 0), p(8, 8), p(-8, -8)],
  ),
  reactor: arena(
    { min: { x: -40, y: -1, z: -28 }, max: { x: 40, y: 24, z: 28 } },
    [p(-30, 0), p(30, 0), p(0, 12), p(0, -12), p(-30, 12), p(30, -12)],
  ),
  lounge: arena(
    { min: { x: -30, y: -1, z: -22 }, max: { x: 30, y: 20, z: 22 } },
    [p(0, 16), p(0, -16), p(-20, 0), p(20, 0), p(-12, 12), p(12, -12)],
  ),
  containeryard: arena(
    { min: { x: -13, y: -1, z: -11 }, max: { x: 13, y: 13, z: 11 } },
    [p(-10.5, 8.5), p(10.5, -8.5), p(-10.5, -8.5), p(10.5, 8.5), p(0, 9), p(0, -9)],
  ),
  derrick: arena(
    { min: { x: -12, y: -1, z: -12 }, max: { x: 12, y: 23, z: 12 } },
    [p(-8.5, 8.5), p(8.5, -8.5), p(8.5, 8.5), p(-8.5, -8.5), p(0, 9), p(0, -9)],
  ),
  scrapyard: arena(
    { min: { x: -14, y: -1, z: -10 }, max: { x: 14, y: 15, z: 10 } },
    [p(-11, 7), p(11, -7), p(-11, -7), p(11, 7), p(0, 8), p(0, -8)],
  ),
  training: arena(
    { min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 25, z: 20 } },
    [p(0, 17), p(-18, -10), p(18, -10), p(-18, 10), p(18, 10), p(0, 0)],
  ),
  hangar: arena(
    { min: { x: -40, y: -1, z: -30 }, max: { x: 40, y: 23, z: 30 } },
    [p(0, 22), p(0, -22), p(-30, 0), p(30, 0), p(-15, 15), p(15, -15)],
  ),
  stadium: arena(
    { min: { x: -25, y: -1, z: -19 }, max: { x: 25, y: 17, z: 19 } },
    [p(0, 12), p(0, -12), p(-20, 0), p(20, 0), p(-12, 6), p(12, -6)],
  ),
  crucible: arena(
    { min: { x: -15, y: -1, z: -15 }, max: { x: 15, y: 13, z: 15 } },
    [p(0, 11), p(0, -11), p(-11, 0), p(11, 0), p(11, -11), p(-11, 11)],
  ),
  lockdown: arena(
    { min: { x: -12, y: -1, z: -10 }, max: { x: 12, y: 11, z: 10 } },
    [p(0, 7.5), p(0, -7.5), p(-5, 7), p(5, -7), p(5, 7), p(-5, -7)],
  ),
};

export const DEFAULT_ARENA_ID = 'causeway';

export function arenaNet(id: string): ArenaNetData {
  return ARENA_NET[id] ?? ARENA_NET[DEFAULT_ARENA_ID];
}

// Maps offered in public Quick-Match auto-rooms and as end-of-match vote
// options. Mirrors the client's quick pool; excludes the single-player-only
// training range and the legacy alt maps.
export const ONLINE_MAP_POOL = ['causeway', 'spire', 'reactor', 'lounge', 'containeryard', 'derrick'] as const;

// ── Lobby / match networking constants (server + client share these) ───────
export const MAP_VOTE_DURATION_SEC = 15; // how long the end-of-match vote runs
export const MAP_VOTE_OPTIONS = 3; // map choices presented in the vote
export const POST_MATCH_RESET_SEC = 4; // delay after vote result before resume
export const ROOM_CODE_LEN = 5; // invite-code / room-id length

// True if a position has left the play space (fell through, or pushed past the
// walls) and should be recovered with a respawn.
export function isOutOfBounds(pos: Vec3, a: ArenaNetData): boolean {
  if (pos.y < a.killY) return true;
  const m = 2; // margin so legitimate wall-hugging never trips this
  return (
    pos.x < a.bounds.min.x - m ||
    pos.x > a.bounds.max.x + m ||
    pos.z < a.bounds.min.z - m ||
    pos.z > a.bounds.max.z + m
  );
}
