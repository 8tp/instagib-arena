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
  accepted shots, frag hits, headshots, current/best kill streak, match start —
  on each `ClientRecord`. They reset with frags/deaths (join, map-vote reset)
  and carry over on a reconnect-resume. At every match end the server calls
  `recordMatch` for each member and pushes the result over that player's socket
  as `{ type: 'progression', … }`. The client reports **nothing**.
- **`POST /api/stats` is offline-only** (matches vs bots). Whatever the body
  says, the server forces `offline: true`: inputs are client-reported, so they
  are clamped, scaled ×0.3, capped per account at **1,500 XP per UTC day**, and
  they never advance challenges or the first-win bonus. A body with
  `training: true` is rejected (`400 { error: 'training' }`) — the training
  range is not a match. The 30-writes/min rate limit still applies.
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
Re-tuning the curve is a pure code change: players simply re-level (the switch
from the old `100·n^1.5` curve moved everyone *up*).

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
| `base` | 25 | "Match played". Full only for a match played to its frag limit; a partial (left early) or forfeit earns it pro rata by time present (full at 3 min), detail `"N% of a full match"`. |
| `kills` | 10 × kills | detail `"12 × 10"` |
| `headshots` | 6 × headshots | |
| `streak` | 4 × best streak | |
| `win` | 60 | see "won" below |
| `accuracy` | round(acc% / 100 × 40) | only with ≥ 20 shots |
| `offline` | negative | offline: total × 0.3 (floored) |
| `firstWin` | 150 | online win, first of the UTC day |
| `cap` | negative | per-match cap 1,500; offline daily cap 1,500 |
| `challenge` | + reward XP | one line per challenge this match completed, detail `"+25 credits"` |

**Won** (online): FFA/duel — reached the frag limit; TDM — on the winning team
*and* present ≥ 60 s; ranked — the ranked winner. A **forfeit** (opponent left a
duel/ranked match) only counts as a win if the survivor had reached a third of
the frag limit — otherwise it's a no-contest for XP (ranked Elo is unaffected).

**Credits per match** = floor(match XP × 0.1). Challenge and road credits come
on top.

**Leaving mid-match** records the partial match as a loss (`partial: true`).
An empty bounce (no shots, frags or deaths) records nothing.

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
server pays every step in `(road_level, level]` — credits, keys, cosmetics
(persisted) — and sets `road_level = level`. That makes each step pay exactly
once and gives existing players a one-time **catch-up** for every level their
XP now reaches. Level cosmetics are *also* owned live from the XP level, so a
newly added one is owned at once by everyone past it; previously persisted
unlocks are never taken away (e.g. Kuon, formerly L5, stays owned).

## 5. Credits, shop and rarity

Shop (`source: credits`) — 30 items, 53,000 credits in total. Rarity ↔ value
bands, which new items should stay inside:

| Rarity | Shop price | Road levels |
|---|---|---|
| common | 300–500 | ~2–15 |
| rare | 600–1,000 | ~5–45 |
| epic | 1,200–2,200 | ~25–70 |
| legendary | 2,800–5,000 | 50, 62, 71, 75, 80, 90, 100, or the case jackpot |

Income to L100 at ~200 XP/match ≈ 24k match credits + 20k road credits (+
challenge credits) — most of the shop, not all of it; the case consolation is
the long-term sink. Admin items are outside the economy.

## 6. Hat case

`POST /api/shop/open-case` — server-authoritative, **never a duplicate**:

1. Costs a **key** if the player has one (keys are spent first), else
   **500 credits**.
2. **5 % jackpot**: an un-owned case-exclusive unusual (Prismatic, Galaxy).
3. Otherwise an un-owned **case hat** (Hard Hat, Top Hat, Wizard Hat — case is
   their only source), weighted by rarity (common 100 / rare 40 / epic 12 /
   legendary 4).
4. Once every case hat is owned (jackpots still missing), a jackpot miss pays
   **250 credits** back (`consolation`) — so a jackpot stays a long shot
   (~5,000 credits expected) instead of a guaranteed drop.
5. Everything owned → `{ ok: false, reason: 'complete' }` and nothing is spent.

Adding a hat with `source: { type: 'case' }` grows the pool automatically.

## 7. Challenges

- Pools in `challenges.ts`: 3 of 5 dailies, 2 of 3 weeklies, picked per player
  by hashing `(player, period)`. Rewards: dailies 60–100 XP + 20–30 credits,
  weeklies 300–400 XP + 120–150 credits.
- Progress comes **only from online matches** recorded by the game server.
- **Auto-payout**: the match that completes a challenge pays it (XP + credits),
  adds a `challenge` XP line and a `challenges` entry to the reply. Any
  completed-but-unpaid row from *any* period (legacy rows from the manual-claim
  era) is swept and paid by the next recorded match, so nothing completed is
  lost to a rollover. `POST /api/challenges/claim` still works for a legacy
  current-period row and returns the full reward payload.
- Periods: daily = UTC day (`YYYYMMDD`); weekly = **Monday 00:00 UTC**
  (`w` + YYYYMMDD of the Monday) — the same boundary as the weekly leaderboard.
  `GET /api/challenges` returns `resetsAt: { daily, weekly }` (ms epoch).

## 8. Anti-abuse summary

- Online XP only from server-known counters; the only client-reported path is
  offline, which is ×0.3, 1,500 XP/day, rate-limited.
- Partial matches and forfeits earn a time-scaled base; empty bounces nothing;
  TDM wins need 60 s presence; early forfeits are no-contest for XP.
- Accuracy bonus and the best-accuracy stat (Sharpshooter) need ≥ 20 shots.
- The existing aimbot heuristic drops throttled frags before they count.
- Per-match XP cap 1,500. Case, buy, claim and match writes run in single
  SQLite transactions; claims are guarded by `claimed = 0`.
- Known gap: two colluding accounts can still trade kills for kill XP (~10 XP
  per frag, rate-bounded by the killcam respawn). Diminishing returns vs the same
  victim would close it.

## 9. Data

`instagib_stats` (additive `ALTER TABLE` guards in `ensureColumns`):

| Column | Meaning |
|---|---|
| `total_xp` | lifetime XP — the source of truth for level |
| `level` | cache of `levelForXp(total_xp)` (admin table only) |
| `credits` | spendable balance |
| `unlocked` | JSON array: bought / dropped / road / title unlocks (never admin items) |
| `equipped` | JSON map slot → id |
| `first_win_day` | YYYYMMDD of the last first-win bonus |
| `road_level` | highest Career Road level paid out (default 1) |
| `case_keys` | unspent free hat-case opens |
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
  newUnlocks: string[];    // cosmetic ids newly owned
  progression: { totalXp, level, credits, unlocked, equipped, caseKeys, roadLevel };
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
  credits, unlocked, equipped, stats, ranked, caseKeys, roadLevel, catchUp } }`.
  `catchUp` lists road steps this request just paid (usually `[]`); `equipped`
  omits items the player no longer owns.
- `POST /api/shop/open-case` → `{ ok: true, won: id | null, jackpot, consolation,
  usedKey, credits, caseKeys, unlocked }` or `{ ok: false, reason:
  'insufficient' | 'complete', credits, caseKeys }`.
- `GET /api/challenges` → `{ challenges: { daily, weekly }, resetsAt: { daily, weekly } }`.
- `POST /api/challenges/claim { id }` → `{ ok: true, ...reward payload }` or
  `{ ok: false, reason }`.
- `POST /api/equip`, `POST /api/shop/buy` — unchanged shapes.
