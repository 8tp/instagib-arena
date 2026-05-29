# Instagib Arena — Plan

> **Historical design doc.** Written while the game lived in the Holocron/Bespick
> arcade. Parts are aspirational and diverged from what shipped — the
> implementation uses a JSON wire protocol (not hand-packed binary), an
> in-process server (not one process per match), and distance/rate anti-cheat
> (not a Rapier sim). For the *current* architecture see
> [`ARCHITECTURE.md`](ARCHITECTURE.md). Kept for design rationale and roadmap.

Browser-based, server-authoritative FPS in the spirit of Quake Instagib / Ratz Instagib. Lives in the existing Bespick arcade alongside chess, 8-ball, etc., but runs against a new dedicated game-server backend on the GPU/CPU box rather than the closet Mac.

---

## 1. Game design pillars

The whole project hinges on three things; everything else is in service of these.

1. **One-shot kill.** Single weapon: railgun. ~1.2–1.5s cooldown. Always kills. No health bar, no armor, no other weapons. The whole loop is *aim + move*.
2. **Movement is the skill ceiling.** Strafe-jump acceleration, double jump, directional dash with cooldown, wall jumps. Map traversal should feel faster than running. New players can play; veterans should move ~2× their speed.
3. **Tight arenas.** Small (1v1 duel) to medium (4v4 TDM) maps with vertical layout, jump pads, ledges. No long sightlines that reward camping — railgun shouldn't be a sniper.

### Modes (in shipping order)
1. **FFA** — first to N frags. Simplest to validate everything.
2. **Duel (1v1)** — round-based, best of N. Ranked-ready.
3. **TDM 4v4** — team frag race.
4. **CTF** — much later; needs flag entities + base spawns.

### Out of scope for v1
- Pickups (no armor/health to grab; instagib doesn't need them). Maybe jump pads and teleporters.
- Custom skins / cosmetics. Reuse the existing Bespick store framework if/when added.
- Mobile/touch. Desktop + mouse + keyboard only.

---

## 2. Tech stack — chosen, with rationale

### Rendering: **Three.js (raw, not react-three-fiber)**
- R3F is great for declarative scenes but adds reconciliation overhead in the per-frame hot path. For a 60–120Hz FPS render loop with thousands of state writes per frame, imperative Three.js is the standard.
- Mount in a Next.js client component as a single `<canvas>` ref. React owns the menus/HUD; Three.js owns the canvas.
- Postprocessing via `three/examples/jsm/postprocessing`. Keep it cheap — bloom on tracers/muzzle flash, FXAA, that's it for v1.

### Physics: **Rapier (WASM) + custom kinematic character controller**
- Rapier for world collision queries (raycasts for hitscan, capsule sweeps for player vs. world).
- The player *movement* is not done by a rigid body. Quake-style air control (allowing strafe acceleration that exceeds straight-run speed) is not what a physics engine gives you out of the box. Roll a kinematic capsule that does:
  - Ground friction + ground accel
  - Air accel with capped projection onto wishdir (this is the Q3 air-control trick)
  - Step-up, slope handling
  - Optional ramp-jump preservation (don't kill upward velocity on landing into a ramp)
- Same controller runs on client (for prediction) and server (for authority). **Must be deterministic and identical** — see §4.

### Networking: **WebSocket binary frames, msgpack or hand-rolled**
- The repo already ships `ws` 8 in the existing custom Next server (`bespick/server/index.ts`), so we have a battle-tested websocket transport in-process.
- TCP head-of-line blocking is the obvious downside for game traffic. For v1 it's acceptable at LAN/regional latency. Plan: ship on WS, then evaluate WebTransport (HTTP/3, UDP-like reliability levels) once it stabilizes across browsers — the code path can be abstracted behind a `Transport` interface.
- Use a binary protocol. Don't ship JSON. Either msgpack (`@msgpack/msgpack`) or hand-pack typed arrays. Hand-packed wins on size for the hot snapshot path.

### Server runtime: **Node.js + TypeScript, one process per match**
- Reuses the existing toolchain (`tsx`, `ws`, drizzle, etc.). Shared code (movement, weapons, map loading) lives in a workspace package consumed by both client and game-server.
- A long-running **orchestrator** process spawns one game-server child per active match, on a port from a pool. The lobby tells the client which `(host, port, matchId)` to connect to.
- The new server box is overprovisioned for this: 256GB RAM is irrelevant (each match server is ~100–300MB), but the CPU core count matters — pin ~1 match per core, leave headroom for the OS and the Next.js front-end.

### Why the GPUs don't help (and what they could do)
Game logic is CPU/RAM bound — GPUs sit idle for a multiplayer hitscan FPS. Possible future uses for the GPU hardware:
- Offline **lightmap baking** for maps.
- **ML bot opponents** trained against replays (long-tail, not v1).
- **Server-side replay rendering** — generate MP4 highlights of frags using a headless Three.js + GPU.
- Hosting a Stockfish-style **analysis service** for replays.

Treat the GPUs as a future-features budget, not a v1 dependency.

---

## 3. Repo layout

Targeted shape. Nothing here exists yet — this is what the first PR scaffolds.

```
bespick/
  src/app/(tools)/arcade/instagib/          # Next.js client routes
    page.tsx                                # lobby / mode select
    play/page.tsx                           # mounts the game canvas
    _components/
      GameCanvas.tsx                        # Three.js mount + lifecycle
      HUD.tsx                               # React HUD overlay
      ScoreboardOverlay.tsx
    _game/                                  # Three.js / game code (client-only)
      renderer/
      input/
      net/
      prediction/

packages/instagib-shared/                   # workspace pkg (new)
  src/
    movement.ts                             # MUST be identical on client + server
    weapons.ts
    types.ts                                # snapshot/command schemas
    constants.ts                            # tickrate, speeds, etc.
    map.ts                                  # map loading + collision baking

services/instagib-game-server/              # new top-level service
  src/
    index.ts                                # orchestrator (spawns children)
    match.ts                                # single-match worker entrypoint
    sim.ts                                  # tick loop, authority
    transport.ts                            # ws server, binary framing
```

The arcade route slots into the existing pattern (`/arcade/8-ball/`, `/arcade/chess/`, etc.). The game server is a sibling service, not part of the Next app — it has its own deploy/process lifecycle.

---

## 4. Authority model

Industry-standard FPS netcode. The two canonical references are Glenn Fiedler's GafferOnGames series and Gabriel Gambetta's *Fast-Paced Multiplayer*. Implementing what's already well-trodden:

- **Server tick rate: 64Hz** (matches CS / Quake conventions; 15.625ms per tick).
- **Client send rate: 64Hz commands.** Each command stamped with `(sequence, clientTickAtSend, inputBits, viewAngles)`.
- **Server broadcast rate: 32Hz snapshots** (delta-compressed against last acked). Halving the broadcast rate vs. tick rate is a fine tradeoff at v1.
- **Client-side prediction** for own movement: when the client sends a command, it immediately runs `movement.step()` locally and renders the result. The server runs the same `movement.step()` authoritatively. On snapshot receive, the client checks its predicted position vs. server's; if they diverge beyond ε, *replay* unacked commands from the server's authoritative state. This is why movement must be deterministic and shared.
- **Snapshot interpolation** for other players: render remote entities ~100ms in the past, interpolating between two received snapshots. Smooth, jitter-free at the cost of seeing-them-where-they-were.
- **Lag compensation** for hitscan: when the server processes a fire command from player P at server tick T, it rewinds *all other players* to where P was seeing them (`T − P.rtt/2 − P.interpDelay`) and raycasts. This is the only way one-shot hitscan feels fair across regions.

### Anti-cheat baseline (server-authoritative is most of it)
- Server validates every command: input bits are bools, viewAngles are normalized, movement runs the same kinematic step regardless of what the client claims.
- Rate-limit commands per second.
- Bound-check positions; teleport-snap clients that diverge wildly.
- Hitscan validation runs server-side against rewound state — client never tells the server who it hit, only what direction it fired.

---

## 5. Movement — the spec to nail first

Without good movement, this is just a slow railgun shooter. Tuning targets, subject to playtesting:

| Param | Initial value | Notes |
|---|---|---|
| Walk speed (max ground) | 320 ups | Quake-style "units per second". Map at ~32 units = 1m for scale. |
| Air accel | 12 ups² × wishdir·velocity | The Q3 strafe-jump magic; uncapped projection onto wishdir. |
| Ground accel | 10 ups² | High enough to feel responsive. |
| Friction | 6 (ground only) | None airborne. |
| Jump impulse | 270 ups | ~52 unit jump. |
| Gravity | 800 ups² | |
| Double jump | Yes, refreshes on ground touch | Ratz-style. |
| Dash | 600 ups, 0.15s, 2.5s cooldown | Cancels gravity for duration; directional based on wishdir or facing. |
| Wall jump | Detect normal within 35° of vertical, impulse = (normal × 220) + (up × 200) | Refresh count: 1 per wall surface until ground touch. |

These are starting points — expect ~2 weeks of tuning during the prototype phase.

---

## 6. Maps & assets

- **Source format:** Blender → glTF 2.0. One file per map, with custom properties on objects (`spawn`, `jumppad`, `teleporter_src`, etc.).
- **Collision:** strip visual meshes, bake a simplified trimesh for Rapier. Tag mesh names with `_col` suffix or use Blender custom property.
- **First map:** "Crucible" — small symmetric 2-tier arena, four spawn points, two jump pads, no teleporters. Keep it boxy and gray. Playability first, art later.
- **Placeholder assets:** Kenney.nl, Quaternius, Sketchfab CC0. Avoid any asset that can't be licensed cleanly.
- **Player model:** capsule + arms-only viewmodel for v1. Third-person model later.

### Audio
- WebAudio API directly (don't bring in Howler for this scope).
- Footsteps, jump grunts, dash whoosh, railgun charge/fire/impact, hit confirm "tink", kill announcer voice.
- Spatialize via PannerNode for other players' sounds.

---

## 7. Server infrastructure (the new box)

**Layout on the GPU server:**
- **Nginx (or Caddy)** terminates TLS for both Next.js and the game-server WebSocket connections. Game traffic on a port range, e.g. `wss://games.bespick.us:7000-7099`.
- **Next.js app** runs as today (PM2 cluster), behind nginx on 443.
- **Instagib orchestrator** runs as a PM2 process. It owns a port pool (e.g. 7000–7099 = 100 concurrent matches), maintains a match registry, and spawns child Node processes per match.
- **Match child process** binds to its assigned port, runs the 64Hz sim, accepts up to N WS connections (mode-dependent), closes itself when the match ends + 30s drain.

**Match lifecycle:**
1. Player clicks "Find match" in `/arcade/instagib`.
2. Next.js API hits orchestrator: "request match for mode=duel, players=[A,B]".
3. Orchestrator allocates port, spawns child, returns `(host, port, matchId, token)` per player.
4. Each player's browser connects directly to that port over WSS, presenting the token.
5. Match runs. On end, child posts results to Next API (frags, kills, duration), then exits.
6. Next API writes match results into the existing arcade-match tables (drizzle).

**Capacity sketch:**
- 100 concurrent matches × ~200MB = 20GB RAM. Trivial against 256GB.
- 100 concurrent matches × ~1 CPU each, but most ticks are <0.5ms — realistically 1 core handles many matches. Cap by player count and tick budget, not by process count.

---

## 8. Phases & milestones

Each phase ends with something playable, even if ugly.

### Phase 0 — Plan + branch (this commit)
- This document.
- Empty scaffolds *not* yet created — wait for sign-off on scope.

### Phase 1 — Offline prototype (1–2 weeks)
- Three.js scene, single hardcoded boxy map.
- Custom kinematic character controller, no networking.
- Mouse-look, WASD, jump, dash, wall-jump.
- Railgun: raycast on click, draw beam, target dummy "explodes" (despawns + respawns 2s later).
- HUD: crosshair, frag counter.
- **Goal:** movement feels good in single-player. If it doesn't feel good here, nothing else matters.

### Phase 2 — Networking spike (1–2 weeks)
- Stand up `services/instagib-game-server` minimal: one process, fixed port, WS endpoint, no orchestrator yet.
- Two browsers connect to same room, see each other as capsules.
- No prediction, no lag comp — just naïve "render where the server says they are" to validate the wire format.

### Phase 3 — Real netcode (2–3 weeks)
- Client prediction + reconciliation.
- Snapshot interpolation.
- Lag-compensated hitscan.
- Binary protocol + delta snapshots.
- Validate with artificial latency (Chrome devtools throttle, plus a `LATENCY_MS` env var on the server that delays packet send/recv).

### Phase 4 — Maps & assets (1–2 weeks)
- Blender → glTF pipeline + map loader.
- Two real maps: "Crucible" (duel) and "Sprawl" (FFA-sized).
- Placeholder weapon viewmodel, kill feed, scoreboard.

### Phase 5 — Modes (1 week)
- FFA → Duel → TDM, in that order. Mostly scoring/state-machine work.

### Phase 6 — Orchestrator + lobby integration (1–2 weeks)
- Match-spawning orchestrator.
- Hook into existing arcade match flow + Clerk auth + drizzle match tables.
- Match results persist; leaderboard integrates with existing arcade leaderboard pages.

### Phase 7 — Polish (ongoing)
- Sound pass. Particles. Damage indicators (hit direction). Spectator mode. Demo recording.
- Anti-cheat hardening pass.

---

## 9. Risks & open questions

- **Movement feel.** The single biggest risk. Mitigation: spend Phase 1 entirely on it; tune against video reference of Q3/Ratz; don't move on until ~3 testers say it feels good.
- **WebSocket vs. WebTransport.** WS is fine to ship on; if competitive duels suffer from TCP HoL blocking, port the `Transport` layer to WebTransport. Don't ship both at once.
- **Determinism across client/server.** JS floating-point is consistent enough on identical inputs within v8, but watch out for `Math.random` (use a seeded PRNG in shared code) and any platform-conditional code.
- **Hosting the game server.** The new box is a single point of failure. Long-term, run a second instance at another location for redundancy + regional latency. Out of scope for v1 but architect so the lobby can route to multiple regions.
- **Tab throttling.** Background tabs throttle timers — affects client prediction but not server. Document the behavior; consider Page Visibility API to pause input.
- **Cheating.** Aimbots are unsolvable in-browser long-term (the client renders the world). Server-authoritative everything keeps casual cheaters out; we accept aimbots as a long-tail problem and plan replay review for ranked.

---

## 10. Decisions still needed before Phase 1

- Workspace tooling: this repo isn't currently a monorepo. Do we add pnpm/turbo, or just symlink a `packages/` directory consumed via tsconfig paths? **Recommendation:** start with tsconfig path aliases to keep tooling change small; promote to a real workspace when a second consumer of `instagib-shared` appears.
- Authentication for game-server connections: short-lived JWT minted by Next API, validated by orchestrator on connect. Clerk session does not extend to the game-server process directly.
- Match persistence schema: extend the existing arcade match tables vs. dedicated `instagib_match`? **Recommendation:** dedicated table — frag-by-frag detail won't fit the existing shape, and arcade aggregates can read from it.
- Naming. "Instagib Arena" is the working title; if there's a Bespick brand pun, swap before going public.
