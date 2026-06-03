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
    // Open-floor spawns: NE/SW corners + the four mid-edges. Avoids the
    // generator roofs (NW/SE corners), central derrick, and flank pillars.
    [p(9, 9), p(-9, -9), p(0, 9), p(0, -9), p(-9, 0), p(9, 0)],
  ),
  training: arena(
    { min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 25, z: 20 } },
    [p(0, 17), p(-18, -10), p(18, -10), p(-18, 10), p(18, 10), p(0, 0)],
  ),
};

export const DEFAULT_ARENA_ID = 'causeway';

export function arenaNet(id: string): ArenaNetData {
  return ARENA_NET[id] ?? ARENA_NET[DEFAULT_ARENA_ID];
}

// Maps offered in public Quick-Match auto-rooms and end-of-match votes, split by
// mode. containeryard (26×22) and derrick (24×24) are tight 1v1 arenas — far too
// small for free-for-all — so FFA/TDM (the main queue) use only the large maps,
// and duel gets the small ones. The single-player training range is excluded.
export const FFA_MAP_POOL = ['causeway', 'reactor', 'lounge'] as const; // large — FFA + TDM
export const DUEL_MAP_POOL = ['containeryard', 'derrick'] as const; // small — 1v1
// Every online map (mode-agnostic uses: known-arena checks, etc.).
export const ONLINE_MAP_POOL = [...FFA_MAP_POOL, ...DUEL_MAP_POOL] as const;

// The map pool for a given mode. Duel → tight arenas; everything else → large.
export function mapPoolForMode(mode: string): readonly string[] {
  return mode === 'duel' ? DUEL_MAP_POOL : FFA_MAP_POOL;
}

// ── Lobby / match networking constants (server + client share these) ───────
export const MAP_VOTE_DURATION_SEC = 15; // how long the end-of-match vote runs
export const MAP_VOTE_OPTIONS = 3; // max map choices presented in the vote
// The map vote is held open this long PAST the match-end moment before its timer
// can lapse, so the (non-skippable) Play-of-the-Match cinematic always finishes
// first and players get the full vote window after it. Must exceed the longest
// possible PotG: finale (≤1.6s clip @0.5x = 3.2s + 1.9s freeze ≈ 5.1s) + highlight
// (≤8s) ≈ 13.1s, so 14s covers it with margin. (See replay.ts CLIP_MAX_SEC.)
export const POTG_GUARD_SEC = 14;
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
