# Instagib Arena — Progression System Design

A concrete, implementable design for an account-less progression system that fits
the existing backend (anonymous `igpid` cookie, single `instagib_stats` SQLite
table, server-clamped match deltas). **Cosmetic-only — never pay/grind-to-win.**

> Status: design proposal. Nothing here is built yet. File:line references point
> at the integration seams in today's code.

---

## 1. Goals & non-goals

**Goals**
- Give players a sense of investment and a reason to return, without accounts.
- 100% fair: rewards are cosmetic or informational only.
- Server-authoritative and abuse-resistant (reuse the existing clamp + rate-limit).
- Incremental: ship the XP/level spine first, layer cosmetics/credits/challenges
  after.

**Non-goals**
- No weapon/movement/hit-detection advantages, ever.
- No mandatory sign-up, email, or password.
- No randomized paid boxes.

---

## 2. Identity & persistence model

Identity stays the **`igpid` httpOnly cookie** (`server/stats.ts:12–26`),
1-year expiry, per-browser. Progression is keyed on `player_id`.

**Known limitation:** clearing cookies or switching devices loses progress.
Mitigation is a later, optional **profile recovery code** (Roadmap Phase 4): the
server mints a short secret that maps to `player_id`; entering it on a new
browser re-binds the cookie. No email/password — just a code the player can
choose to save. Until then, progression is explicitly "casual, per-browser."

### Schema changes (additive, no migration framework)

The DB is created with `CREATE TABLE IF NOT EXISTS` and has **no migration
system** (`server/db.ts:22–39`). SQLite supports `ALTER TABLE ADD COLUMN` but not
`ADD COLUMN IF NOT EXISTS`, so guard each add by inspecting `pragma table_info`:

```ts
// server/db.ts — run once at startup, after the CREATE TABLE.
function ensureColumns(db: Database) {
  const cols = new Set(
    db.prepare(`PRAGMA table_info(instagib_stats)`).all().map((r: any) => r.name),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE instagib_stats ADD COLUMN ${ddl}`);
  };
  add('total_xp',  'total_xp INTEGER NOT NULL DEFAULT 0');
  add('level',     'level INTEGER NOT NULL DEFAULT 1');
  add('credits',   'credits INTEGER NOT NULL DEFAULT 0');
  add('unlocked',  `unlocked TEXT NOT NULL DEFAULT '[]'`);   // JSON array of cosmetic IDs
  add('equipped',  `equipped TEXT NOT NULL DEFAULT '{}'`);   // JSON map slot -> cosmetic ID
  add('first_win_day', 'first_win_day INTEGER NOT NULL DEFAULT 0'); // YYYYMMDD of last "first win"
}
```

Challenges need their own table (per the "new tables need raw `CREATE TABLE`"
convention):

```sql
CREATE TABLE IF NOT EXISTS instagib_challenges (
  player_id  TEXT NOT NULL,
  challenge  TEXT NOT NULL,          -- e.g. 'daily:headshots'
  period     TEXT NOT NULL,          -- 'YYYYMMDD' (daily) or 'YYYY-Wnn' (weekly)
  progress   INTEGER NOT NULL DEFAULT 0,
  goal       INTEGER NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, challenge, period)
);
```

No definitions live in the DB — cosmetic and challenge **definitions** are a
static manifest in code (see §5, §7). The DB only stores IDs + progress.

---

## 3. XP — sources & formula

XP is computed **on the server** in `recordMatch()` (`server/db.ts:93–117`) from
the already-clamped `MatchDelta`. The client never sends XP.

Per-match XP:

```
xp =  base                                  // 25  flat "you played"
    + kills        * 10
    + headshots    * 6
    + bestStreak   * 4                       // rewards not dying
    + (won ? 60 : 0)
    + accuracyBonus                          // round(accuracy/100 * 40), capped 40
    + firstWinOfDay ? 150 : 0                // big daily hook, server-dated
    + challengeBonuses                       // from §7
```

Tuning notes:
- Numbers are starting points; instrument and adjust (Roadmap → Telemetry).
- A full FFA win with decent aim lands ~250–400 XP; a quick loss ~80–150.
- All inputs are already clamped (`server/db.ts:93–100`), so XP can't be inflated
  by a forged POST. Also keep the existing 30-POST/min rate limit
  (`server/stats.ts`).
- **Bots/offline matches:** decide whether offline XP counts. Recommend **yes but
  reduced** (e.g., ×0.5 and no challenge credit) so practice still feels
  rewarding without being the optimal farm. Mark offline submissions with a flag
  in the POST body and scale server-side.

### Level curve

Cumulative XP → level. Use a mild super-linear curve so early levels are fast and
later ones are a slow burn:

```
xpForLevel(n) = floor(100 * n^1.5)          // XP needed to go from level n -> n+1
```

Level 1→2 = 100, 2→3 ≈ 283, 10→11 ≈ 3162, 50→51 ≈ 35355. Convert by accumulating.
Keep a hard cap (e.g., level 100) or let it run; recommend a soft cap with
"prestige"-style cosmetic borders past max if we want a long tail. Store
`total_xp` and derive `level`; recomputing level from total XP is cheap and makes
curve re-tuning a pure code change.

---

## 4. What XP/levels unlock vs. what credits buy (hybrid)

- **Milestone unlocks (level-gated):** prestige items you can't buy — earned by
  reaching a level. Signals investment. (e.g., a rail-beam color at L5, an
  announcer pack at L15, a name-color at L25.)
- **Credits (earned per match, ~ xp/10):** spent in the **Locker/Shop** to unlock
  cosmetics of the player's *choice* from the buyable pool. Gives agency without
  forcing a grind order.
- A cosmetic is either milestone-gated **or** buyable, not both (avoids "I leveled
  to it AND it costs credits" feel-bad).

---

## 5. Cosmetic catalog (v1)

All cosmetic, all server-validated against the static manifest. Reuse existing
systems wherever possible:

| Slot | What it changes | Reuses |
|------|------------------|--------|
| `railColor` | rail beam core/helix color | `RAIL_CORE_COLOR` / `RAIL_HELIX_COLOR` (`constants.ts`), `buildRailBeam` (`weapon.ts`) |
| `crosshair` | crosshair preset/skin | existing crosshair presets + `CrosshairConfig` (`InstagibClient.tsx`) |
| `viewmodelSkin` | railgun body tint/material | `buildRailgun` colors (`weapon-model.ts`) |
| `playerTint` | your soldier's accent color | bot/remote material highlight (`applyHighlight`, `bots.ts`) |
| `nameColor` | your name in killfeed/scoreboard | killfeed/scoreboard render (`InstagibClient.tsx`) |
| `killConfirm` | style of the "Gibbed" text / kill flash hue | `KillConfirmOverlay`, `KillFlashLayer` (`InstagibClient.tsx`) |
| `announcer` | multi-kill voice pack | `MEDAL_VOICE` / audio (`audio.ts`, `medals.ts`) |

Manifest shape (static, in code — e.g. `src/game/cosmetics.ts`, shared with
server):

```ts
export type Cosmetic = {
  id: string;            // 'rail.plasma'
  slot: CosmeticSlot;    // 'railColor'
  name: string;          // 'Plasma'
  rarity: 'common' | 'rare' | 'epic';
  source: { type: 'level'; level: number } | { type: 'credits'; price: number }
        | { type: 'challenge'; id: string } | { type: 'default' };
  data: unknown;         // slot-specific (e.g. { core: 0x..., helix: 0x.. })
};
```

Equipping: client sends `POST /api/equip { slot, id }`; server verifies the id is
in the player's `unlocked` set and writes `equipped`. Other players receive a
player's equipped cosmetics in the match snapshot so beams/tints render for
everyone (extend the `state`/`joined` payloads in `server/instagib-game.ts`).

---

## 6. API changes

Extend the existing surface (all cookie-identified):

- `POST /api/stats` (exists) — response gains
  `{ xpGained, totalXp, level, leveledUp, newUnlocks: string[], credits }` so the
  client can show the end-of-match XP/level moment immediately.
- `GET /api/profile` (new) — `{ level, totalXp, xpThisLevel, xpForNextLevel,
  credits, unlocked: string[], equipped: Record<slot,id> }`.
- `POST /api/equip` (new) — `{ slot, id }` → validated equip.
- `POST /api/shop/buy` (new) — `{ id }` → deduct credits, add to `unlocked`.
- `GET /api/challenges` (new) — current daily/weekly with progress + claim state.
- `POST /api/challenges/claim` (new) — claim a completed challenge's reward.

Keep all writes rate-limited and idempotent where possible.

---

## 7. Challenges (Phase 2)

- **Daily (3, rotating):** "Land 10 headshots", "Win 2 matches", "5 mid-air
  frags", "Reach a 5 streak", "Play 3 matches".
- **Weekly (1–2, bigger):** "50 headshots", "Win 10 matches", "Reach level X".
- Tracked server-side from the same `MatchDelta` (some need extra fields, e.g.
  `midAirKills` — already known client-side via the Jump-Shot medal path in
  `game.ts`; add it to the POST body, server-clamped).
- Rewards: bonus XP + credits; claimed from the Profile/Challenges panel.
- Rotation is date-derived (no scheduler needed): pick from the pool by hashing
  `player_id + period`.

---

## 8. Client integration

- **End-of-match:** the results screen (already shown post-match) gains an XP bar
  that fills + a "LEVEL UP" / "UNLOCKED: X" flourish using the existing toast/
  banner system (`awardMedal`/`BannerOverlay` patterns in `game.ts` /
  `InstagibClient.tsx`). Drive it off the new `POST /api/stats` response fields.
- **Command deck:** a **Profile** panel (level ring + XP bar + career stats) and a
  **Locker** (equip cosmetics) + **Shop** (spend credits) + **Challenges** tabs.
  These are pure React over the new endpoints — no engine changes.
- **In-match application:** equipped `railColor` feeds `buildRailBeam`; `crosshair`
  feeds the existing crosshair renderer; `viewmodelSkin` feeds `buildRailgun`;
  `playerTint`/`nameColor` feed the bot/remote material + scoreboard. Remote
  players' cosmetics come from the snapshot payload.
- Respect a **"reduced juice"** accessibility setting for the louder cosmetics
  (kill-flash hue, announcer volume).

---

## 9. Anti-abuse

- XP/credits/challenge progress derived **only** from server-clamped deltas
  (`server/db.ts:93–100`); never trust client-reported XP.
- Keep the 30-POST/min/IP+id rate limit (`server/stats.ts`).
- Offline/bot matches flagged and XP-scaled (or challenge-excluded) so practice
  isn't the optimal farm.
- Equip/buy endpoints validate IDs against the static manifest and the player's
  `unlocked` set — a forged equip can't grant an item.
- Consider a per-match XP ceiling as a backstop against pathological inputs.

---

## 10. Phased build checklist

**P1 — Spine (smallest end-to-end slice):**
1. `ensureColumns()` adds `total_xp`, `level`, `credits`, `unlocked`, `equipped`.
2. Server XP formula in `recordMatch`; return XP/level fields from `POST /api/stats`.
3. `GET /api/profile`.
4. End-of-match XP bar + Profile panel (read-only).
5. One real cosmetic slot wired end-to-end: `railColor` (3 colors, level-gated)
   → proves manifest → unlock → equip → render-for-everyone.

**P2 — Earn loops:**
6. Credits + Locker/Shop; expand catalog (crosshair, nameColor, killConfirm,
   announcer).
7. `instagib_challenges` table + daily/weekly + claim flow.
8. First-win-of-day bonus.

**P3+:** competitive rank, seasons — see [`ROADMAP.md`](./ROADMAP.md).

---

## 11. Open decisions

- Offline/bot XP: count reduced (recommended) vs. not at all.
- Level cap: hard cap vs. soft cap + prestige borders (recommended soft).
- Milestone vs. credits split per cosmetic (recommended hybrid, §4).
- Recovery code timing: Phase 1 (reduces churn pain early) vs. Phase 4
  (recommended later, to ship the spine faster).
- Do remote players see each other's cosmetics at launch (needs snapshot payload
  growth) or is it self-only first? Recommend beams/tints shared at launch (cheap,
  high-visibility), rarer slots self-only until proven.
