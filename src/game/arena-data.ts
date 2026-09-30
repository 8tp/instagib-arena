// Pure (THREE-free) arena network data — the single source of truth the GAME
// SERVER uses for spawns / out-of-bounds checks. It must stay importable from
// `bespick/server/*` (Node, no DOM), so this file MUST NOT import three.js,
// `map.ts`, `textures.ts`, or anything that touches `document`/`window`.
//
// The client renders the geometry from `map.ts`; the server only needs to know
// where it's safe to (re)spawn and when a player has fallen out of the world.
// Both come straight from the map modules (src/game/maps/*): bounds + the
// hand-placed `spawns` list.

import { MAPS } from './arena-map-data';
import type { AABB, Vec3 } from './types';

export type ArenaNetData = {
  bounds: AABB;
  killY: number; // y below this → fell out of the world → respawn
  spawns: Vec3[]; // safe spawn points (standing on a surface)
};

// killY sits a few metres below each map's floor (floor min.y is -1 in every
// map), so a player who clips through or spawns into the void is recovered.
function arena(bounds: AABB, spawns: Vec3[]): ArenaNetData {
  return { bounds, killY: bounds.min.y - 6, spawns };
}

export const ARENA_NET: Record<string, ArenaNetData> = Object.fromEntries(
  MAPS.map((m) => [m.id, arena(m.map.bounds, m.map.spawns)]),
);

export const DEFAULT_ARENA_ID = 'causeway';

export function arenaNet(id: string): ArenaNetData {
  return ARENA_NET[id] ?? ARENA_NET[DEFAULT_ARENA_ID];
}

// Maps offered in public Quick-Match auto-rooms and end-of-match votes, split by
// mode. The FFA/TDM maps are ~96×72 m with 3–4 play tiers for up to 8 players;
// containeryard and derrick are ~68×58 m symmetric 1v1 arenas, too tight for a
// full FFA lobby. The single-player training range is excluded.
export const FFA_MAP_POOL = ['causeway', 'reactor', 'lounge', 'nuketown'] as const; // large — FFA + TDM
export const DUEL_MAP_POOL = ['containeryard', 'derrick'] as const; // symmetric — 1v1
// Every online map (mode-agnostic uses: known-arena checks, etc.).
export const ONLINE_MAP_POOL = [...FFA_MAP_POOL, ...DUEL_MAP_POOL] as const;

// The map pool for a given mode. Duel → the 1v1 arenas; everything else → large.
export function mapPoolForMode(mode: string): readonly string[] {
  return mode === 'duel' ? DUEL_MAP_POOL : FFA_MAP_POOL;
}

// ── Lobby / match networking constants (server + client share these) ───────
export const MAP_VOTE_DURATION_SEC = 20; // how long the end-of-match vote runs (the rewards reveal plays in its first ~12 s)
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
