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

- Core movement FPS: strafe/dash/double-jump/wall-jump, lag-compensated server
  hitscan, FFA / TDM / Duel, per-room online play, quick-match + private lobbies,
  map voting, bots (offline), practice range.
- Persistence: anonymous-cookie career stats + global leaderboard (kills / wins /
  accuracy), Railway + SQLite.
- Juice: procedural railgun viewmodel + third-person hold, animated soldier
  bots, killcam, medals, killfeed, audio, crosshair presets.
- **This batch:** sleeker twin-rail railgun, view-clearing first-person
  viewmodel, in-hand gun hold that tracks the arm through idle/walk/run, and a
  punchier kill-feedback package (screen flash, shockwave hit-marker, beefier 3D
  kill burst, kill shake).

---

## Phase 1 — Progression foundation  ⭐ next

The spine everything else hangs off. Detailed spec in
[`docs/progression.md`](./progression.md).

- [ ] Extend `instagib_stats` with `total_xp`, `level`, `credits`, `unlocked`
      (JSON), `equipped` (JSON) via additive `ALTER TABLE ADD COLUMN` guards
      (no migration framework exists — see progression spec).
- [ ] Server-side XP formula derived from the already-clamped match delta;
      compute level from an XP curve; return `xpGained`, `level`,
      `leveledUp`, `unlocks` in the `POST /api/stats` response.
- [ ] `GET /api/profile` → level, XP, next-level threshold, credits, unlocked +
      equipped cosmetics.
- [ ] Client: end-of-match XP bar + "LEVEL UP" moment; a Profile panel in the
      command deck showing level/XP/career stats.
- [ ] Cosmetic framework: a static manifest of cosmetic IDs (no DB rows for
      definitions), `equipped` applied to the local player's railgun beam +
      crosshair + name color. **Reuses existing systems** (crosshair presets,
      `RAIL_CORE_COLOR`/`RAIL_HELIX_COLOR`, viewmodel).

**Decision points:** account level vs. competitive rank split (recommend: account
level now, rank later); XP curve shape (recommend: mild super-linear, see spec).

## Phase 2 — Cosmetics content + earn loops

Give the levels something to hand out and a reason to come back.

- [ ] Cosmetic catalog v1: rail-beam colors, crosshair skins, name colors,
      player-tint, kill-confirm styles, a few announcer voice packs.
- [ ] Credits: earned per match (server-derived), spent in a Locker/Shop to
      unlock cosmetics of choice — alongside milestone (level-gated) unlocks.
- [ ] Daily + weekly challenges (e.g., "10 headshots", "win 3", "5 mid-air
      frags") for bonus XP/credits. Tracked server-side from match deltas.
- [ ] "First win of the day" XP bonus.

**Decision point:** pure level-gating vs. credits-shop vs. hybrid (recommend
hybrid — milestones for prestige, credits for player choice).

## Phase 3 — Competitive layer

- [ ] Hidden MMR per mode (Glicko-2/Elo) updated from match results.
- [ ] Ranked queue with placement matches + visible rank tiers (Bronze →
      Grandmaster). Rank is **separate** from account level.
- [ ] Seasonal leaderboards (rank + season reset) on top of the existing
      all-time leaderboard.
- [ ] Mode-specific leaderboards (Duel ladder is the natural flagship).

**Risk:** matchmaking quality needs population; gate ranked behind a min level so
new players learn first. Keep casual queues unranked and always available.

## Phase 4 — Identity, social & retention

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

- **Anti-cheat / integrity:** keep all scoring server-authoritative; add server
  sanity checks on fire-rate, movement speed, and impossible-angle hits; rate-
  limit progression writes (the 30/min stats limit already exists).
- **Telemetry:** lightweight, privacy-respecting match/event metrics to tune XP
  curves, mode popularity, and matchmaking — no PII (we have none).
- **Performance & polish:** keep the 3D render full-rate, HUD throttled (already
  ~20 Hz); budget particle/FX counts; verify with the headless harness pattern.
- **Accessibility:** colorblind-safe cosmetic palettes, FX-intensity / screen-
  shake / flash toggles (the new kill flash + shake should respect a "reduced
  juice" setting), remappable keys (exists), FOV/sensitivity (exists).
- **Mobile/touch:** currently desktop-only (pointer lock). Decide whether touch
  is in scope before investing in a touch control scheme.

## Explicitly out of scope (for now)

- Real-money monetization / loot boxes. If ever added: cosmetic-only, no
  power, no randomized paid boxes.
- Anything that affects weapon balance, movement, or hit detection as a reward.
