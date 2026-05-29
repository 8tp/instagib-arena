# Architecture

How Instagib Arena fits together: the client engine, the authoritative game
server, the netcode (including lag compensation and the anti-cheat boundary),
and the wire protocol.

For the high-level "what is this / how do I run it," see the
[README](../README.md). For the original (partly aspirational) design rationale,
see [`instagib-arena-plan.md`](instagib-arena-plan.md).

---

## 1. Topology

```
                    ┌──────────────────────── browser ────────────────────────┐
                    │  React (menus / HUD / lobby)   Three.js (<canvas> world) │
                    │            src/InstagibClient.tsx + src/game/*           │
                    └───────────────┬───────────────────────────┬─────────────┘
                                    │ /api/stats (HTTP)          │ /ws/instagib (WS)
                                    ▼                            ▼
                    ┌──────────────────────────  Node server  ─────────────────────────┐
                    │  express: static dist/ + stats API        ws: authoritative game  │
                    │  server/index.ts → server/stats.ts        server/instagib-game.ts │
                    │                    → server/db.ts (SQLite)                          │
                    └────────────────────────────────────────────────────────────────────┘
```

- **Dev:** Vite serves the client on `:5173` and proxies `/api` + `/ws` to the
  Node server on `:8787`. One origin in the browser.
- **Prod:** the Node server serves the built client *and* both endpoints from a
  single port. Same origin.

The browser only ever sees one origin, so the client derives its WebSocket URL
straight from `window.location` (`ws[s]://<host>/ws/instagib`) — no env config.

---

## 2. Client engine (`src/game/`)

React owns the **menus, HUD, and lobby UI**. Three.js owns the **canvas world**.
They meet at exactly one seam: `InstagibClient.tsx` mounts a `<canvas>`,
constructs a `Game`, and subscribes to a HUD listener for per-frame state
(health-free, so: ammo cooldown, frags, killfeed, medals, banners). All
hot-path state lives in plain objects and typed arrays — never React state — so
the 60–144 Hz render loop never triggers reconciliation.

Module map:

| Module            | Responsibility |
| ----------------- | -------------- |
| `game.ts`         | The main loop. Owns the scene, camera, match state, HUD/medal orchestration, and the net client. Entry point for everything. |
| `player.ts`       | The local player: a **kinematic capsule** character controller (not a physics rigid body). |
| `locomotion.ts`   | The movement math: ground friction/accel, Quake-style **air acceleration** (capped projection onto wishdir), dash, double-jump, wall-jump. |
| `weapon.ts`       | Railgun: cooldown, client-side hitscan ray, tracer/impact spawning. |
| `map.ts`          | Arena geometry, materials, and the collision representation the player controller sweeps against. |
| `arena-data.ts`   | **THREE-free.** Spawn points, bounds, the map pool, vote constants, room-code length — the table both client and server read. |
| `constants.ts`    | **THREE-free.** Tunables: frag limit, cooldowns, speeds, eye height, sensitivity defaults, keybinds. |
| `types.ts`        | **THREE-free.** Shared structural types (`Vec3`, `AABB`, …). |
| `net.ts`          | Client netcode: the `LobbyClient`, snapshot buffering, and **interpolation** of remote players against a delayed render clock. |
| `remote-player.ts`| A remote avatar: skinned model, interpolated transform, nameplate. |
| `bots.ts`         | Offline bot AI (navigation, aim with human-like error, difficulty tiers). Offline only — bots have map geometry; the online server does not. |
| `audio.ts`        | Procedural weapon SFX (Web Audio) + announcer/medal voice lines (`.ogg`, TTS fallback), with an SFX/announcer volume split. |
| `effects.ts`      | Tracers, impacts, muzzle flashes, hit sparks. |
| `renderer.ts`     | WebGL renderer + environment setup. |
| `textures.ts`     | Procedural texture generation. |
| `medals.ts`       | Streak/medal state machine (first blood, multi-kills, sprees, headshots). |
| `input.ts`        | Pointer lock, mouse-to-yaw/pitch with raw-input + cm/360 sensitivity, keybind resolution. |

The three **THREE-free** modules are the contract between client and server: the
server imports `constants`, `arena-data`, and `types` directly and never pulls in
a renderer.

---

## 3. Movement model

Movement is the skill ceiling, so it is hand-rolled rather than handed to a
physics engine. The player is a kinematic capsule:

- **Ground:** friction then acceleration toward `wishdir`, capped at run speed.
- **Air:** acceleration is applied as a *projection* of `wishdir` onto velocity
  with a separate air cap — the classic Q3 trick that lets strafe-jumping
  accelerate you past straight-run speed.
- **Dash:** an impulse along the input direction on a cooldown.
- **Jumps:** ground jump + a limited number of air jumps; **wall-jump** when
  touching a wall.

The same tunables (`constants.ts`) feed both the client controller and the
server's sanity checks, so honest movement never trips anti-cheat.

---

## 4. Netcode

### Connection & clock

On connect the server sends `welcome { clientId, serverTime }`. The client
periodically `ping { ts }` / receives `pong { ts, serverTime }` to estimate RTT
and align to the **server clock**. Everything time-related (snapshot
interpolation, lag-comp rewind) is expressed in server-clock milliseconds.

### Snapshots & interpolation

The server broadcasts a `state` snapshot at **32 Hz** to every occupied room:
each player's position, yaw/pitch, frags/deaths, and remaining spawn-invuln. The
client buffers snapshots and **renders remote players in the past** (interpolated
between the two snapshots straddling a delayed render time), which hides jitter
and packet timing. The local player is **not** interpolated — it's simulated
immediately for responsiveness.

### Position updates

The client sends `pos { x, y, z, yaw, pitch }` at ~32 Hz. The server stores a
short **position history** per player (~1 s) so it can rewind them for lag
compensation.

---

## 5. Server authority & lag compensation

The server decides **every hit**. The client never reports a kill — it reports a
*shot ray*.

When a player fires, the client sends:

```
shoot { ox, oy, oz,  dx, dy, dz,  maxDist?,  renderTime? }
```

- `o*` — ray origin (the shooter's eye), `d*` — ray direction (normalized server-side).
- `maxDist` — the distance at which the shot hit a **wall** on the client. The
  server owns no map geometry, so the client supplies this wall cap; the server
  only needs to know "the ray was occluded at this range."
- `renderTime` — the server-clock time the shooter was *displaying others at*
  (i.e. the interpolation delay). This is the key to lag comp.

The server then, for the shooter's room:

1. **Rewinds** every other player to `renderTime` by interpolating their
   position history — reconstructing what the shooter actually saw.
2. Builds each rewound player's **AABB hitbox** (`PLAYER_RADIUS` × `PLAYER_HEIGHT`)
   and raycasts the shot against them.
3. Takes the **nearest** hit inside `maxDist` (so walls still block) and resolves
   a kill — headshot if the hit Y is in the top fraction of the box.

A kill broadcasts `kill { killerId, victimId, headshot, victimPos, respawnPos }`;
the victim is respawned server-side with brief spawn invulnerability. Reaching
the frag limit opens the end-of-match map vote.

This is why online play has **no bots**: bots need map geometry to navigate, and
the server intentionally has none.

---

## 6. Anti-cheat boundary

Because the server is authoritative for hits and score, a modified client is the
threat model. The server is *geometry-free*, so anti-cheat is distance/rate
based rather than occlusion based:

- **Fire-rate gate** — shots faster than the railgun cooldown (minus a small
  jitter tolerance) are dropped.
- **Shot-origin sanity** — the ray origin must be within a few meters of the
  shooter's authoritative server-side eye, so a modified client can't place the
  origin flush against a victim and fire "through" walls.
- **Speed clamp** — `pos` updates implying faster-than-possible movement are
  rejected (they'd otherwise poison both the broadcast snapshot and the
  lag-comp rewind buffer).
- **Rewind clamp** — a shot may only rewind targets so far into the past, so a
  spoofed `renderTime` can't resurrect long-dead positions.
- **Message-rate flood guard** — a socket exceeding an inbound message budget per
  second is closed.

These make modified clients *bounded*, not impossible — stats are explicitly
unranked and best-effort.

---

## 7. Rooms, lobby & map voting (`server/instagib-game.ts`)

Every match is a **Room**. A socket is either a **lister** (browsing the lobby)
or **in** exactly one room. Each room has a **mode** (`ffa` | `duel` | `tdm`)
chosen at create/quick-match time; the mode drives capacity and the win
condition, evaluated server-side after every kill:

- **FFA** — first player to `MATCH_FRAG_LIMIT` ends the match → map vote.
- **Duel** — capacity 2. A kill that reaches `DUEL_ROUND_FRAG_LIMIT` ends the
  round; the server bumps `roundNum`, resets both scoreboards, repositions both
  players, and broadcasts `round` (with the round tally) after a short freeze.
  First to `DUEL_ROUNDS_TO_WIN` rounds wins the match → vote. A mid-match leave
  forfeits to the survivor.
- **TDM** — players are balanced onto two teams on join (`team` index 0/1).
  Friendly fire is rejected in `handleShoot`; the first team whose summed frags
  reach `TDM_FRAG_LIMIT` wins (the win rides `vote-start` as `winnerTeam`).

- **Quick-match** drops you into the fullest joinable public room, or makes one.
- **Create** makes a public ("Custom Lobby") or private (invite-code) room.
- **Join** enters a room by id/code; fails with `join-failed { reason }` if it's
  gone or full.

Lobby listers receive `rooms` updates (public, occupied rooms only). When a
player reaches the frag limit the room enters a **vote**: `vote-start` ships a
ballot of maps (excluding the current one); players `vote { mapId }`;
`vote-update` streams the tally; `vote-result` picks the winner (random on ties),
resets the scoreboard, and repositions everyone onto the new map after a short
breather. Empty rooms are reaped on a grace timer (longer for never-joined
invite rooms so a shared code doesn't race a reap).

---

## 8. Wire protocol summary

**Client → server:** `hello` · `list` · `create` · `quickmatch` · `join` ·
`leave` · `vote` · `pos` · `ping` · `shoot`
(`create` and `quickmatch` carry a `mode` — `ffa` | `duel` | `tdm`.)

**Server → client:** `welcome` · `rooms` · `created` · `matched` · `joined` ·
`join-failed` · `peer-joined` · `peer-left` · `state` · `kill` · `respawn` ·
`vote-start` · `vote-update` · `vote-result` · `round` · `pong`
(`joined` carries `mode`/`team`/`roundsToWin`; `state` players carry `team`;
`vote-start` carries `winnerTeam` for TDM; `round` is the Duel between-round
reset with the round tally.)

The wire format is JSON. (The original plan called for a hand-packed binary
snapshot path; JSON is what ships today and is comfortable at the current snapshot
rate — see the plan doc for the binary-protocol notes if you want to revisit it.)

---

## 9. Stats subsystem

`/api/stats` (Express, `server/stats.ts`) is auth-free:

- First request mints a random id into an `httpOnly`, `SameSite=Lax` cookie
  (`igpid`); subsequent requests carry it back. No login, no external provider.
- `GET` returns the player's aggregate stats; `POST` records one match.
- Reported integers are **clamped** server-side, then applied as an **atomic
  SQL upsert** (`column + delta`, with `max()` for bests) in `server/db.ts`, so
  concurrent submits can't clobber each other.

The store is a single SQLite table created on first import — no ORM, no
migrations. It lives under `DATA_DIR` (default `./data`).

`GET /api/leaderboard?sort=kills|wins|accuracy&limit=N` (`server/leaderboard.ts`)
reads the same table — one prepared statement per sort column (no user input
reaches SQL), `kills` riding the `idx_instagib_stats_kills` index, only surfacing
players with `total_games > 0`. To keep the board from being trivially inflated,
`POST /api/stats` is rate-limited (a dependency-free in-memory sliding window:
~30 submits per identity per minute, keyed by the player cookie or IP).
```
