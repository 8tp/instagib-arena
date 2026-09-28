# Instagib Arena — Progression (2.0)

How XP, levels, credits, the Career Road, the hat case and challenges work, as
built. **Cosmetic-only — never pay/grind-to-win.** Nothing here touches aim,
movement, hit detection or visibility.

Code map:

| Piece | Where |
|---|---|
| Curve, per-match XP lines, Career Road, reward contract types | `src/game/progression.ts` (shared client + server) |
| Cosmetic catalog: sources, prices, rarities, case pool | `src/game/cosmetics.ts` (shared) |
| Challenge pools, rotation, UTC periods | `src/game/challenges.ts` (shared) |
| Persistence, payouts, case roll, catch-up | `server/db.ts` (`recordMatch`, `getProfile`, `openCase`, …) |
| Online match recording (authoritative) | `server/instagib-game.ts` (`settleClient` / `settleRoom`) |
| REST surface | `server/stats.ts` |

---

## 1. Trust model

- **Online matches are recorded by the game server.** `server/instagib-game.ts`
  already decides every hit; it now also keeps per-player match counters —
  accepted shots, counting frags, headshots, current/best kill streak, frags per
  victim, match start — on each `ClientRecord`. They reset with frags/deaths
  (join, map-vote reset) and carry over on a reconnect-resume. At every match
  end the server calls `recordMatch` for each member and pushes the result over
  that player's socket as `{ type: 'progression', … }`. The client reports
  **nothing**.
- **You can't farm yourself.** A frag counts toward progression (kills,
  headshots, streak, accuracy, career stats, leaderboards, challenges) unless
  the victim is *you*: the same account, or anyone on the same network identity
  — the WS upgrade's client IP (CF-Connecting-IP, else the first
  X-Forwarded-For hop, else the socket address). That covers "account + own
  guest tab" and "a second account on the same machine". Guests on other
  networks count like anyone else. **Accepted trade-off:** players sharing an
  IP (a household, an office) don't earn XP off each other.
- **One account, one slot per room**: a second live tab gets `join-failed` with
  reason `'duplicate'` (and quick-match skips rooms the account is already in);
  a reconnect that lost its resume token reclaims the account's own dropped
  slot instead of adding a second record.
- **`POST /api/stats` is offline-only** (matches vs bots). Only a body with
  `offline: true` is accepted — anything else is `400 { error: 'offline_only' }`
  (the game server already recorded online matches; an old client bundle must
  not record them twice), and `training: true` is `400 { error: 'training' }`
  (the training range is not a match). Offline matches are **XP-only**: they
  never feed career totals, leaderboards or achievement titles; their XP is
  scaled ×0.3 and capped per account at **1,500 XP per UTC day**; they never
  advance challenges or the first-win bonus. The 30-writes/min rate limit still
  applies.
- **Guests** (no account) get the same computation as a *preview* — the reply
  says `saved: false` and nothing is written — so the results screen can show
  what signing up would have kept.
- The killcam **playercard level** is stamped server-side from the account's
  real XP level (guests: 1); the client's value is ignored.
- Staff (**admin-source**) cosmetics are never written to a player's stored
  unlocks; admins own them live via `is_admin`, so demotion removes them.

## 2. Level curve

```
xpForLevel(n) = 200 + 45·n          // XP to go from level n to n+1
level         = levelForXp(total_xp) // always derived; MAX_LEVEL = 100
```

L1→2 = 245 XP, L10→11 = 650, L50→51 = 2,450, L99→100 = 4,655; L100 needs
242,550 XP in total. XP keeps accruing past L100 (it still earns credits).

The stored `level` column is only a cache for the admin players table; it is
re-derived on boot and on every write and is **never** an input to grants.
Re-tuning the curve is a pure code change: players simply re-level. The switch
from the old `100·n^1.5` curve moved everyone with ≥ 535 XP up or kept them
level; only two brand-new bands drop one level — 100–244 XP (L2 → L1) and
382–534 XP (L3 → L2). Nothing is taken away: cosmetics already persisted stay
owned, and road payouts are never clawed back.

### Pacing

Matches needed, by average XP per match (all-in: match XP + first-win +
challenges amortised):

| XP / match | L10 | L25 | L50 | L75 | L100 |
|---:|---:|---:|---:|---:|---:|
| 150 | 26 | 122 | 433 | 932 | 1,617 |
| **200** | **20** | **92** | **325** | **699** | **1,213** |
| 250 | 16 | 74 | 260 | 559 | 971 |

Reference matches (from `matchXpLines`):
- Average online FFA loss (10 kills, 3 HS, best streak 3, 35% acc): **169 XP**.
- FFA win, 25 kills, first win of the day: **~580 XP**.
- Strong offline win vs easy bots (25 kills): **132 XP** — below an average
  online match, and at most 1,500 XP/day in total.

## 3. Per-match XP

Itemized in display order as `xpLines` (`{ key, label, xp, detail? }`):

| key | XP | notes |
|---|---|---|
| `base` | 25 | "Match played", always pro rata by time present (full at 3 min), detail `"N% of a full match"` when scaled. |
| `kills` | 10 × kills | counting frags only (victim isn't you — see §1); detail `"12 × 10"` |
| `headshots` | 6 × headshots | |
| `streak` | 4 × best streak | |
| `win` | 60 | see "won" below |
| `accuracy` | round(acc% / 100 × 40) | only with ≥ 20 shots |
| `offline` | negative | offline: total × 0.3 (floored) |
| `firstWin` | 150 | online win, first of the UTC day |
| `cap` | negative | per-match cap 1,500; offline daily cap 1,500 |
| `challenge` | + reward XP | one line per challenge this match completed, detail `"+25 credits"` |

**Repeat-victim decay** (FFA/TDM): the first 5 counting frags on the same
player in a match — keyed on the victim's identity: account, or IP for a
guest — are full value; after that the kill / headshot / streak XP halves every
further 5 (the lines' detail gains `· repeat victims ×0.86`). Duels are exempt —
one opponent is the format and a duel is capped at its frag limit.

**Won** (online) — only if at least one **opponent of a different identity**
(not your account, not your IP) played the match; beating your own tabs never
earns a win or the first-win bonus. Then:
FFA/duel — reached the frag limit; TDM — on the winning team *and* present
≥ 60 s; ranked — the ranked winner. A **forfeit** (opponent left a duel/ranked
match) only counts as a win if the survivor had reached a third of the frag
limit — otherwise it's a no-contest for XP (ranked Elo is unaffected).

**Credits per match** = floor(match XP × 0.1). Challenge and road credits come
on top.

**What counts as a match.** A player's match is recorded at all (XP,
`total_games`, the "games" challenge) only if they were present ≥ 45 s or had
at least one frag/death — on every path: match end, forfeit, and leaving
mid-match (recorded as a loss, `partial: true`). Anything less is a bounce and
records nothing.

## 4. Career Road

`CAREER_ROAD` (levels 2–100) — **every level grants at least one reward**. It is
*derived* from the catalog: every `{ type: 'level', level: N }` cosmetic sits at
exactly level N (move an item by editing its source in `cosmetics.ts`); the
module throws at load if a level source falls outside 2–100. Around the
cosmetics:

- **Credits** on every level without a cosmetic: `round10(40 + 3·L)`, doubled on
  every 5th level (L3 = 50 … L99 = 340).
- **A free hat-case key** every 10 levels (10 keys by L100).
- **Milestone bonus** at L25/50/75/100: 500 / 1,000 / 1,500 / 2,000 credits.

Totals: 36 cosmetics, 10 keys, 20,230 credits.

| Level | Cosmetic | | Level | Cosmetic |
|---:|---|---|---:|---|
| 2 | Ballcap Pro (hat, common) | | 41 | Arctic (gun, rare) |
| 4 | Salute (emote, common) | | 43 | Gibstorm (finisher, epic) |
| 5 | Plasma (rail, rare) | | 45 | Void (rail, rare) |
| 7 | Wave (emote, common) | | 47 | Gilded (card, epic) |
| 9 | Nova (finisher, rare) | | **50** | **Spectrum (rail, legendary)** + key + 1,000 |
| 11 | Ember (card, rare) | | 53 | Present Arms (emote, epic) |
| 13 | Gold (name, rare) | | 56 | Pristine (name, epic) |
| 15 | Crimson (gun, rare) | | 59 | Derez (finisher, epic) |
| 17 | Shockwave (spawn, rare) | | 62 | Searing Embers (unusual, legendary) |
| 19 | Graduate (hat, rare) | | 65 | Nebula (card, epic) |
| 21 | Starburst (finisher, rare) | | 68 | Glitch (gun, epic) |
| 23 | Toxic (rail, rare) | | 71 | Ghostfire (unusual, legendary) |
| 25 | Kuon (announcer, epic) + 500 | | **75** | **Prism (finisher, legendary)** + 1,500 |
| 27 | Cyber (card, rare) | | 80 | Overclocked (unusual, legendary) + key |
| 29 | Spin (emote, rare) | | 90 | Spectrum (gun, legendary) + key |
| 31 | Biohazard (gun, rare) | | **100** | **Radiant Halo (unusual, legendary)** + key + 2,000 |
| 33 | Crimson (name, rare) | | | |
| 35 | Propeller Cap (hat, epic) | | | |
| 37 | Party Foul (finisher, rare) | | | |
| 39 | Come Get Some (emote, rare) | | | |

**Payout.** `instagib_stats.road_level` is the highest road level already paid.
Whenever XP moves (a match, a challenge claim) or on `GET /api/profile`, the
server pays every step in `(road_level, level]` — credits, free rolls, items —
and sets `road_level = level`. That makes each step pay exactly once and gives
players a one-time **catch-up** for every level their XP now reaches.

**Economy v3 (docs/economy.md).** The road no longer writes `unlocked`:
- a level-sourced **item** cosmetic (hat / gun / beam / finisher / spawn / emote /
  name colour) is minted as a **bound item instance** (untradable, origin
  `road`) — see `roadRewardKind()` in `progression.ts`;
- **cards, titles and announcer packs are entitlements**, owned live from the
  level / achievements (`entitlementsFor` in `server/economy.ts`), nothing minted;
- the old case "key" is now a **free roll** (`{ type: 'case', count? }`), and the
  removed per-slot `unusual.*` road items (L62/71/80/100) pay **2 free rolls**
  (+ filler credits) each so those levels still reward.

## 5. Credits and rarity

There is no shop any more (v3): credits come from matches, challenges, the
Career Road and salvage, and are spent on **cases** and the **market**
(docs/economy.md). Rarity is now a 7-tier ladder (`TIER_META` in
`src/game/items/types.ts`).

## 6. Cases

Replaced by the case system in docs/economy.md §2 (`POST /api/cases/open`).
`POST /api/shop/open-case`, `/api/shop/buy` and `/api/equip` return
`410 { error: 'moved' }`.

## 7. Challenges

- Pools in `challenges.ts`: 3 of 5 dailies, 2 of 3 weeklies, picked per player
  by hashing `(player, period)`. Rewards (v3): dailies 70–110 XP + **40–60
  credits**, weeklies 320–420 XP + **220–300 credits**.
- Progress comes **only from online matches** recorded by the game server.
- **Auto-payout**: the match that completes a challenge pays it (XP + credits),
  adds a `challenge` XP line and a `challenges` entry to the reply. Any
  completed-but-unpaid row from the **current or previous** daily/weekly period
  (legacy rows from the manual-claim era; the pre-Monday weekly keys are
  included for the switchover) is swept and paid by the next recorded match, so
  a completion is never lost to a rollover — older backlog never pays, so it
  can't land as one windfall. `POST /api/challenges/claim` still works for a
  legacy current-period row and returns the full reward payload.
- Periods: daily = UTC day (`YYYYMMDD`); weekly = **Monday 00:00 UTC**
  (`w` + YYYYMMDD of the Monday) — the same boundary as the weekly leaderboard.
  `GET /api/challenges` returns `resetsAt: { daily, weekly }` (ms epoch).

## 8. Anti-abuse summary

- Online XP only from server-known counters; the only client-reported path is
  offline, which is XP-only (no career totals / titles / leaderboards), ×0.3,
  1,500 XP/day, rate-limited.
- Frags on yourself (same account or same IP) don't count; one slot per
  account per room; a win needs an opponent of a different identity;
  repeat-victim decay in FFA/TDM keyed on the victim's identity. The IP guard is
  only as trustworthy as the proxy headers — lock the Railway origin to
  Cloudflare so X-Forwarded-For can't be forged by a direct connection.
- A match is only recorded with ≥ 45 s present or a frag/death; the base XP is
  always time-scaled; TDM wins need 60 s presence; early forfeits are
  no-contest for XP.
- Accuracy bonus and the best-accuracy stat (Sharpshooter) need ≥ 20 shots.
- The existing aimbot heuristic drops throttled frags before they count.
- Per-match XP cap 1,500. Case, buy, claim and match writes run in single
  SQLite transactions; claims are guarded by `claimed = 0`.
- Known gap: two *distinct* colluding accounts can still trade kills (~10 XP
  per frag, rate-bounded by the killcam respawn; FFA/TDM decays after 5 frags
  per victim, duels don't).

## 9. Data

`instagib_stats` (additive `ALTER TABLE` guards in `ensureColumns`):

| Column | Meaning |
|---|---|
| `total_xp` | lifetime XP — the source of truth for level |
| `level` | cache of `levelForXp(total_xp)` (admin table only) |
| `credits` | spendable balance |
| `unlocked` | legacy (v2) — cleared by the v3 reset; never read or written again |
| `equipped` | legacy (v2) — cleared; equipment is `equipped_items` (economy.md §9) |
| `first_win_day` | YYYYMMDD of the last first-win bonus |
| `road_level` | highest Career Road level paid out (default 1) |
| `case_keys` | legacy — cleared by the v3 reset (replaced by `free_rolls`) |
| `free_rolls`, `econ_v3`, `legacy_unlocked`, `equipped_items` | economy v3 (docs/economy.md §9) |
| `offline_day`, `offline_xp` | offline XP earned on that UTC day (daily cap) |

`instagib_challenges (player_id, challenge, period, progress, goal, claimed)` —
progress per challenge instance; definitions live in code.

## 10. API

**Reward payload** — the `POST /api/stats` reply and the WS `progression` push
share it:

```ts
{
  // legacy
  xpGained: number;        // total XP added (match + challenges)
  creditsGained: number;   // total credits added (match + challenges + road)
  leveledUp: boolean;
  newUnlocks: string[];    // def ids newly owned / entitled (titles, cards, road items)
  newItems: ItemInstanceWire[]; // v3: bound instances minted by this call (road rewards)
  progression: { totalXp, level, credits, unlocked, equipped, caseKeys, freeRolls, roadLevel };
  // caseKeys is a back-compat alias of freeRolls; unlocked/equipped are derived (def ids)
  // RewardExtras (progression.ts)
  saved: boolean;          // false = guest preview, nothing persisted
  offline: boolean;
  xpLines: XpLine[];
  levelBefore: number;
  totalXpBefore: number;
  roadRewards: RoadStep[]; // road steps paid by this call (incl. any catch-up)
  challenges: ChallengeCompletion[];
  stats: PublicStats;      // career stats after the match (guest: this match)
}
```

WS push: `{ type: 'progression', mode: 'ffa'|'duel'|'tdm'|'ranked', partial: boolean, ...payload }`
— sent after `vote-start` / `ranked-result` at match end, or right after a
mid-match leave (`partial: true`). A player who is mid-reconnect gets it on
resume.

- `GET /api/profile` → `{ profile: { level, totalXp, xpIntoLevel, xpForNext,
  credits, unlocked, equipped, equippedUids, looks, stats, ranked, freeRolls,
  caseKeys, roadLevel, catchUp } }`. `catchUp` lists road steps this request
  just paid (usually `[]`); `equipped` / `unlocked` are back-compat def-id views —
  v3 clients use `GET /api/inventory`.
- `POST /api/stats` (offline only) → the reward payload, or `400 { error:
  'offline_only' | 'training' }`, or `429 { error: 'rate_limited' }`.
- WS `join` / `resume` (fallback join) can now fail with `{ type: 'join-failed',
  reason: 'duplicate' }` — this account already holds a live slot in that room.
- `GET /api/challenges` → `{ challenges: { daily, weekly }, resetsAt: { daily, weekly } }`.
- `POST /api/challenges/claim { id }` → `{ ok: true, ...reward payload }` or
  `{ ok: false, reason }`.
- `POST /api/equip`, `POST /api/shop/buy`, `POST /api/shop/open-case` — **410 `{ error: 'moved' }`** (economy v3).
