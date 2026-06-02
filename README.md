# Instagib Arena

Browser-based, **server-authoritative** Quake-style instagib FPS. One weapon, one
shot, one kill — the whole game is **aim and movement**. Strafe-jump, dash,
double-jump, and wall-jump your way around tight arenas; the railgun does the
rest.

Rendered with raw **Three.js**, served by a small **Node + WebSocket** game
server with lag compensation and server-side hit detection. No framework lock-in
on the hot path, no per-frame React reconciliation.

> Broken out of the Holocron arcade into its own standalone repo. It runs on its
> own — a Vite client and one Node server, nothing else.

---

## Features

- **One-shot railgun.** No health, no armor, no other weapons. Pure duel of aim + movement.
- **Quake-style movement.** Strafe-jump acceleration, air control, directional dash, double-jump, wall-jump, and a damage-free boost-jump off surfaces.
- **Three game modes** — Free-for-all, **Duel** (1v1, best-of rounds with deuce/advantage), and **Team Deathmatch** (Red vs Blue, friendly-fire off). Pre-match 3-2-1 countdown, mercy-rule blowout ends.
- **Server-authoritative multiplayer** over WebSocket:
  - Lag compensation — the server rewinds every target to the shooter's render time before raycasting hitboxes.
  - Clock sync, 32 Hz snapshots, client-side interpolation of remote players.
  - Anti-cheat: fire-rate gate, shot-origin sanity, horizontal **and vertical** speed clamps, message-rate flood guard, and a statistical **aimbot heuristic** (rolling hit/headshot-rate throttle).
  - **Reconnect / session resume** — a mid-match drop holds your slot + score for a grace window so a network blip doesn't wipe your game.
- **Rooms & lobby.** Quick-match (per mode), public custom lobbies, and private invite-code matches. End-of-match **map voting** + a **3D podium** of the top 3 (wearing their hats, playing their emotes).
- **Progression (account-less).** Server-derived XP / levels / credits off the `igpid` cookie, end-of-match XP + credits roll-up, daily/weekly **challenges**, and a first-win-of-the-day bonus.
- **Cosmetics Locker.** Hats (glTF), kill-effect explosions, rail-beam colours, "unusual" hat particles, end-of-match emotes, and Valorant-style killcam playercards. Level- or credit-gated, with a Krunker-style **unboxing** spinner and a live 3D preview. Purely visual — never an advantage. Ownership-checked server-side in MP.
- **Offline play.** Bots with adjustable difficulty (human-like aim/movement, wearing cosmetics) + a training range — no server needed.
- **Juice + feedback.** Killcams (showing the killer's playercard), multi-kill medals, an announcer (with optional captions), shockwave hit-markers, a red damage vignette, and a fully configurable crosshair.
- **Anonymous stats + leaderboard.** Per-browser K/D, accuracy, streaks, headshots (no login) and a server-wide leaderboard with **All-time / Weekly / Daily** windows, sortable by kills / wins / accuracy, with your own rank pinned.
- **Onboarding & accessibility.** First-run name prompt + controls primer; reduced-effects toggle, announcer captions + a screen-reader live region, bright-enemy colourblind aid, UI scale, and a scoreboard ping readout.

---

## Tech stack

| Layer        | Choice                                                              |
| ------------ | ------------------------------------------------------------------ |
| Rendering    | [Three.js](https://threejs.org) (imperative, single `<canvas>`)    |
| Client app   | React 19 + React Router, bundled by [Vite](https://vitejs.dev)     |
| Styling      | Tailwind CSS v4                                                     |
| Game server  | Node.js + [`ws`](https://github.com/websockets/ws), run via `tsx`  |
| HTTP / API   | Express (static client + stats endpoint)                           |
| Stats store  | SQLite via `better-sqlite3` (no ORM, no migrations)                |
| Language     | TypeScript end to end                                              |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit
together (engine modules, netcode, lag compensation, anti-cheat, wire protocol).

---

## Quick start

**Prerequisites:** Node **≥ 20.19** (the build/toolchain needs it). With
[`fnm`](https://github.com/Schniz/fnm) or `nvm`, e.g. `fnm use 20.19.0`.

```bash
git clone https://github.com/8tp/instagib-arena.git
cd instagib-arena
npm install
```

### Development

```bash
npm run dev
```

This runs two processes together (via `concurrently`):

- **Vite** dev server on <http://localhost:5173> — the client, with HMR.
- **Game server** on `:8787` — the WebSocket game + stats API.

Vite proxies `/api` and `/ws/instagib` to the game server, so the browser always
talks to a **single origin** — exactly like production. Open
<http://localhost:5173> and hit **Enter the arena**.

You can also run them separately: `npm run dev:web` and `npm run dev:server`.

### Production

```bash
npm run build      # vite build -> dist/
npm start          # NODE_ENV=production tsx server/index.ts
# or both at once:
npm run serve
```

In production the **single Node server** (default port `8787`) serves the built
client from `dist/`, the stats API at `/api/stats`, and the game socket at
`/ws/instagib` — all on one port. Put any TLS terminator / reverse proxy /
tunnel in front of it; the WebSocket rides the same origin.

---

## Controls

| Input              | Action                              |
| ------------------ | ----------------------------------- |
| Mouse              | Aim                                 |
| Left click         | Fire railgun (one shot, one kill)   |
| `W` `A` `S` `D`    | Move                                |
| `Space`            | Jump (double-jump in the air)       |
| `Shift`            | Dash (directional, on a cooldown)   |
| Jump into a wall   | Wall-jump                           |
| `Esc`              | Release mouse / open the menu        |

All keybinds, mouse sensitivity (cm/360), FOV, crosshair, and volumes are
configurable in the in-game **Settings** menu and persist in `localStorage`.

---

## Game modes

Pick a mode in the menu before Quick Match or Create Match (quick-match only
pairs you with rooms of the same mode).

| Mode | Players | Win condition |
| ---- | ------- | ------------- |
| **Free-for-all** | up to 8 | First player to the frag limit ends the match → map vote. |
| **Duel (1v1)** | 2 | Best-of rounds: each round is a race to a frag count; first to win the round majority takes the match. A short freeze + reset between rounds. Leaving mid-match forfeits. |
| **Team Deathmatch** | up to 8 | Red vs Blue. Friendly fire is off; first team to the team frag limit wins. Teammates are tinted green, foes wear their team color. |

Mode tunables (frag/round limits, team sizes, colors) live in
`src/game/constants.ts` and are shared verbatim by the client and the
authoritative server.

---

## Configuration

Copy `.env.example` to `.env` (or set the vars in your process manager). All are
optional:

| Variable        | Default            | Purpose                                                        |
| --------------- | ------------------ | -------------------------------------------------------------- |
| `PORT`          | `8787`             | Port the Node server listens on.                               |
| `HOST`          | `0.0.0.0` (prod)   | Bind address.                                                  |
| `DATA_DIR`      | `./data`           | Directory for runtime data (the SQLite DB).                    |
| `DATABASE_PATH` | `./data/instagib.sqlite` | Explicit DB file path (overrides `DATA_DIR`).           |
| `APP_BASE_URL`  | _(unset)_          | Production WebSocket origin allow-list. When set, only browsers loading the app from this origin may open the game socket. Unset = same-origin only. |
| `AIM_ASSIST_ALLOWLIST` | _(unset)_ | Comma-separated account IDs allowed to activate the aim-assist bridge in multiplayer. Admin accounts are allowed by default. |

---

## Project structure

```
instagib-arena/
├─ index.html             # Vite entry
├─ vite.config.ts         # React + Tailwind plugins; dev proxy for /api + /ws
├─ src/
│  ├─ main.tsx            # React root + router (/ and /play)
│  ├─ pages/Landing.tsx   # marketing / controls splash
│  ├─ InstagibClient.tsx  # the game client: canvas mount, HUD, menus, lobby
│  └─ game/               # the Three.js engine (framework-agnostic)
│     ├─ game.ts          #   main loop, match/HUD orchestration
│     ├─ player.ts        #   kinematic character controller
│     ├─ locomotion.ts    #   strafe-jump / air-accel / dash math
│     ├─ weapon.ts        #   railgun + hitscan
│     ├─ map.ts           #   arena geometry + collision
│     ├─ arena-data.ts    #   THREE-free arena table (shared with the server)
│     ├─ constants.ts     #   tunables (shared with the server)
│     ├─ types.ts         #   shared types (shared with the server)
│     ├─ net.ts           #   client netcode: lobby + snapshot interpolation
│     ├─ remote-player.ts #   interpolated remote avatars
│     ├─ bots.ts          #   offline bot AI
│     ├─ audio.ts         #   SFX (procedural) + announcer (ogg/TTS)
│     ├─ effects.ts, renderer.ts, textures.ts, medals.ts, input.ts
├─ server/
│  ├─ index.ts            # http + express static + /api + WS upgrade routing
│  ├─ instagib-game.ts    # authoritative game server (modes, rooms, lag comp, anti-cheat)
│  ├─ stats.ts            # anonymous cookie identity + /api/stats router (rate-limited)
│  ├─ leaderboard.ts      # GET /api/leaderboard router
│  └─ db.ts               # better-sqlite3 store (stats + leaderboard queries)
├─ public/
│  ├─ models/instagib/    # *.glb player models
│  └─ sounds/instagib/    # *.ogg announcer + medal callouts
└─ docs/                  # ARCHITECTURE.md + original design plan
```

The three modules under `src/game/` marked **shared** (`arena-data`,
`constants`, `types`) are deliberately Three.js-free so the Node server can
import them directly — the server owns spawns, tunables, and out-of-bounds tests
without pulling in a renderer.

---

## Stats & privacy

There is **no login**. On a player's first request the server mints a random id
and stores it in an `httpOnly` cookie; stats persist per-browser in SQLite. The
display name is cosmetic (sent from local settings). Stats are **best-effort and
unranked** — the in-browser game reports them, so they're clamped server-side but
not anti-cheated. Clearing cookies resets a player's stats.

The **global leaderboard** (`GET /api/leaderboard?sort=kills|wins|accuracy`)
ranks all stored players; the in-game **Leaderboard** menu shows it. Because
identity is per-browser, `POST /api/stats` is rate-limited as a light abuse guard.

---

## Audio assets

Announcer voice lines and multi-kill medal callouts ship as `.ogg` files in
`public/sounds/instagib/`. The railgun **fire / hit / kill** SFX have no bundled
clip and are **synthesized procedurally** via the Web Audio API at runtime. Drop
a matching `.ogg` at the path listed in `src/game/audio.ts` (`SOUND_URLS`) to
override any sound; missing announcer lines fall back to speech synthesis.

---

## npm scripts

| Script             | What it does                                              |
| ------------------ | -------------------------------------------------------- |
| `npm run dev`      | Vite client + game server together (dev).               |
| `npm run dev:web`  | Vite client only.                                       |
| `npm run dev:server` | Game server only (`tsx watch`).                       |
| `npm run build`    | Production client build to `dist/`.                     |
| `npm start`        | Run the production server (expects `dist/`).            |
| `npm run serve`    | `build` then `start`.                                   |
| `npm run typecheck`| Type-check client and server projects.                 |
| `npm run lint`     | ESLint.                                                  |

---

## Provenance & license

Extracted from the Holocron arcade as a standalone project. Original design
rationale (some of it aspirational and ahead of the current implementation)
lives in [`docs/instagib-arena-plan.md`](docs/instagib-arena-plan.md).

Private repository — all rights reserved unless a `LICENSE` says otherwise.
