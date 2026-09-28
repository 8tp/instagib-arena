# Instagib Arena — Roadmap

A living, phased plan. Each phase is shippable on its own and ordered so earlier
work de-risks later work. Dates are intentionally omitted; sequence matters more
than calendar. Checkboxes track intent, not commitment.

## Guiding principles

- **Skill stays sacred.** One shot, one kill. Everything we add is cosmetic,
  social, or quality-of-life — never an advantage you can grind or buy. This is
  the single most important constraint and it shapes every decision below.
- **Account-less first.** Identity is the anonymous `igpid` cookie
  (`server/stats.ts`). We layer progression on top of it and only add optional
  recovery/identity later. No mandatory sign-up, ever.
- **Server-authoritative everything.** Stats are already clamped server-side
  (`server/db.ts`); XP, unlocks, and currency are derived on the server from
  those clamped values. The client never reports its own XP.
- **Ship thin slices.** Prefer a small end-to-end feature (DB → API → HUD) over a
  big half-wired one.

---

## Where we are (recently shipped)

- Core movement FPS: strafe/dash/double-jump/wall-jump/boost-jump, lag-compensated
  server hitscan, FFA / TDM / Duel, per-room online play, quick-match + private
  lobbies, map voting, bots (offline), practice range.
- Persistence: anonymous-cookie career stats + leaderboard, Railway + SQLite.
- Juice: procedural railgun viewmodel + third-person hold, animated soldier bots,
  killcam, medals, killfeed, audio, crosshair presets.
- **Progression (Phase 1 ✅) + cosmetics/earn loops (Phase 2 ✅)** — see below.
- **Match feel + integrity batch:** offline warmup + first-spawn invuln, 3-2-1
  countdown freeze, frame-rate-independent juice, overtime/mercy rules, spawn
  fairness, vertical speed clamp, AFK kick, an aimbot heuristic, reconnect/session
  resume, scoreboard ping, first-run onboarding, announcer captions + a
  screen-reader live region.

---

## Phase 1 — Progression foundation  ✅ shipped

The spine everything else hangs off. Spec in
[`docs/progression.md`](./progression.md).

- [x] `instagib_stats` extended with `total_xp`, `level`, `credits`, `unlocked`,
      `equipped` via additive `ALTER TABLE` guards (no migration framework).
- [x] Server-side XP formula from the clamped match delta + XP curve
      (`floor(100·n^1.5)`); `POST /api/stats` returns `xpGained`, `level`,
      `leveledUp`, `newUnlocks`, `creditsGained`.
- [x] `GET /api/profile` → level, XP, next-level threshold, credits, unlocked +
      equipped cosmetics.
- [x] Client: animated end-of-match XP + credits roll-up with a "LEVEL UP" moment;
      a Profile panel + a lobby level/credits chip.
- [x] Multi-slot cosmetic framework (`src/game/cosmetics.ts`): one manifest, slots
      `killEffect` / `railColor` / `hat` / `unusual` / `card` / `emote`.

## Phase 2 — Cosmetics content + earn loops  ✅ shipped

- [x] Catalog: kill-effect explosions, rail-beam colours, glTF **hats**, "unusual"
      hat particles, end-of-match **emotes**, and killcam **playercards**.
- [x] Credits earned per match (server-derived), spent in the **Locker** (its own
      tabbed modal with a live 3D preview) alongside milestone (level-gated)
      unlocks; a Krunker-style **unboxing** spinner for hat cases.
- [x] Daily + weekly **challenges** for bonus XP/credits, tracked server-side from
      match deltas; **first-win-of-the-day** XP bonus.
- [x] End-of-match **podium**: top-3 pedestal, each wearing their hat + playing
      their emote (online uses each player's real broadcast loadout).
- [x] Online cosmetics are **ownership-checked** server-side (the `igpid` cookie
      rides the WS upgrade); the killcam card uses the server-known name.

## Phase 2.5 — Progression 2.0  ✅ shipped

Spec (as built) in [`docs/progression.md`](./progression.md).

- [x] **Server-authoritative online XP:** the game server records every online
      match from its own counters (shots, hits, headshots, streaks, win) and
      pushes a WS `progression` message; `POST /api/stats` is offline-only
      (×0.3, 1,500 XP/day cap, training rejected).
- [x] **Flatter curve** (`200 + 45·n`): L10 ≈ 20 matches, L50 ≈ 325, L100 ≈ 1,200.
      Level is always derived from total XP.
- [x] **Career Road:** every level 2–100 grants a reward — 36 cosmetics (legendary
      capstones at 50/75/100), a hat-case key every 10 levels, scaling credits,
      milestone bonuses; paid exactly once, with catch-up for existing players.
- [x] **Hat case without dupes:** un-owned case hats only, a real 5% jackpot,
      keys spent before credits, consolation once the hats are collected.
- [x] **Challenges auto-pay** on completion (nothing lost at reset); the weekly
      set rolls Monday 00:00 UTC like the weekly board; the UI gets `resetsAt`.
- [x] **Itemized rewards** (`xpLines`, road steps, challenge completions) for
      the results screen; guests see a `saved: false` preview.
- [x] Economy fixes: admin items never persisted, best accuracy needs ≥ 20
      shots, killcard level server-forced, rarity/price bands across the catalog.

## Phase 3 — Competitive layer

- [x] **Leaderboard time windows** — All-time / Weekly / Daily (`instagib_period_stats`),
      sortable by kills / wins / accuracy, with your own rank pinned and an
      accuracy min-games floor.
- [x] **Ranked Duel** — Elo rating (provisional for the first 5 games, diminishing
      returns vs a repeat opponent), a login-only first-to-15 1v1 queue with
      rating-gap pairing, visible tiers + a live "#N" ranked title, a ranked
      ladder with live-match spectating. Rank is **separate** from account level.
- [ ] Seasonal leaderboards (rank + season reset).
- [ ] Ranked for other modes (TDM/FFA MMR) if population supports it.

**Risk:** matchmaking quality needs population. Keep casual queues unranked and
always available.

## Phase 4 — Identity, social & retention

- [x] **Reconnect / session resume:** a mid-match disconnect holds your slot +
      score for a grace window (resume token) instead of minting a fresh identity.
- [x] First-run **onboarding** (name prompt + controls primer).
- [ ] **Profile recovery code:** optional, account-less. Server issues a secret
      code that re-binds a new browser to an existing `player_id` (solves
      "cleared cookies / new device wiped my progress"). Still no email/password.
- [ ] Public profile pages (level, top stats, equipped cosmetics, recent matches).
- [ ] Friends / parties / invite-to-lobby polish on top of existing private rooms.
- [ ] Spectate + richer post-match scoreboard.

## Phase 5 — Content cadence

- [ ] Seasons: a free seasonal track (challenges → cosmetics) with a reset and a
      fresh cosmetic set each season.
- [ ] New maps + a community map format; revisit a map editor / Steam-Workshop-
      style sharing if population supports it.
- [ ] New modes (CTF-instagib, Last-Man-Standing, Gun-Game-style ladder).

---

## Cross-cutting tracks (continuous)

- **Anti-cheat / integrity:** all scoring is server-authoritative; server sanity
  checks on fire-rate, shot origin, horizontal **and vertical** movement speed,
  plus a rolling **aimbot heuristic** (hit/headshot-rate throttle) — done. WS
  cosmetics are ownership-checked. Online XP is recorded by the game server;
  the only client-reported path (offline) is scaled, day-capped and
  rate-limited, and frags on yourself (same account or same IP) don't count
  (one slot per account per room, repeat-victim decay in FFA/TDM, a win needs
  an opponent of another identity). Still
  open: impossible-angle/snap detection; kill-trading between two distinct alt
  accounts in duels.
- **Telemetry:** lightweight, privacy-respecting match/event metrics to tune XP
  curves, mode popularity, and matchmaking — no PII (we have none).
- **Performance & polish:** keep the 3D render full-rate, HUD throttled (already
  ~20 Hz); budget particle/FX counts; verify with the headless harness pattern
  (`/podiumlab`, `/lockerlab`). Juice is now frame-rate-independent.
- **Accessibility:** reduced-effects toggle (shake/flash/particles), announcer
  **captions** + a screen-reader `aria-live` region, bright-enemy colourblind
  aid, UI scale, remappable keys, FOV/sensitivity — done. Still open: full
  colourblind-safe palettes.
- **Mobile/touch:** currently desktop-only (pointer lock). Decide whether touch
  is in scope before investing in a touch control scheme.

## Explicitly out of scope (for now)

- Real-money monetization / loot boxes. If ever added: cosmetic-only, no
  power, no randomized paid boxes.
- Anything that affects weapon balance, movement, or hit detection as a reward.
