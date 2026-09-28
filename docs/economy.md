# Inventory & Economy (v3) — design spec

Status: in development on `feat/inventory-economy`. This file is the contract every track
codes against. Shared types live in `src/game/items/types.ts` (THREE-free, client + server).

Pillars (unchanged): **cosmetic only** — nothing here touches aim, movement, hits or visibility;
**server authoritative** — the client never mints, prices or moves items; **credits are earned,
never bought** — no real money anywhere.

References: TF2 (item instances, qualities, unusual-as-attribute, strange counters, trading),
Krunker (7 tiers, spins, market with listing tax, level-gated trading), CS2 (wear/pattern seed,
per-tier odds each ~4–5× rarer). Research notes: see the PR description.

---

## 1. Items: definitions vs instances

- **ItemDef** (static, in code — `src/game/items/catalog.ts`): what an item *is* — id, slot,
  name, blurb, tier, art key (the code-built model / effect it renders), `tradable`, and which
  cases drop it. Ids are stable forever (`hat.tophat`, `face.aviators`, `back.cape.crimson`…).
- **ItemInstance** (DB row, `instagib_items`): one owned copy — `uid` (random 12-char id), `def`,
  `mint` (serial per def: "#37"), `quality`, `attrs`, `origin`, `tradable`, `created_at`,
  `owner_id`, `state` (`owned | listed | traded-away | salvaged | revoked`).
- **Defaults** (bare head, stock finish, cyan beam, pulse finisher, cheer emote, slate card…) are
  *virtual*: everyone has them, they're not instances, not tradable.
- **Player cards** stay **unlockable by level** (entitlements, not instances, not tradable, not in cases) — like titles.
- **Titles** stay achievement/level-earned and **bound** (untradable instances minted on grant).
  Announcer packs stay level-gated entitlements (not items).

### Slots
`hat · face · back · finish (railgun skin) · beam (rail colour) · finisher · spawn · emote ·
card · nameColor · title`. The old `unusual` slot is **gone**: an unusual effect is an
**attribute of a hat (or emote) instance** (TF2 style). Face = visor/mask/goggles/moustache on the
head bone's front; back = backpacks, jetpacks, wings, quivers, **capes** (spring-simulated).

### Tiers (7)
| tier | colour | case odds | salvage (⛁) |
|---|---|---|---|
| Common | `#b0b7c3` grey | 60% | 3 |
| Uncommon | `#5ec46b` green | 25% | 8 |
| Rare | `#4b8dff` blue | 10% | 25 |
| Epic | `#a855f7` purple | 3.5% | 90 |
| Legendary | `#f59e0b` orange | 1.2% | 350 |
| Relic | `#ef4444` red | 0.3% | 1,500 |
| Unobtainable | `#ff4fd8` pink→iridescent | 0 (Vault case 0.02%) | 10,000 |

**No pity** — fixed rates, like TF2/Krunker. Every case's tier odds AND quality odds
(unusual / strange / killstreak / professional) are published in-game to all players.

### Qualities & attributes (rolled per instance at mint)
- **Unusual** (hats, emotes): an `effect` id from `UNUSUAL_EFFECTS`. Hat case: 1.5% per hat roll
  (Legendary+ hats 5%); Taunt case emotes 2%. Shown as "Unusual <Hat>" with the effect name.
- **Strange** (finishes, finishers, beams): 10%. Carries `kills` (server-counted, on the item,
  survives trades) and a rank name from `STRANGE_RANKS` (Strange → … → Hale's Own-style top rank).
- **Killstreak** (finishes only): 6%. `sheen` (colour glow on the gun while on a ≥5 streak) and,
  at 1.5%, **Professional**: `sheen` + `ksEffect` (eye/visor particles while on a streak, like TF2).
- **Festive** (finishes, hats): only from seasonal cases or admin — festive lights / wrapping.
- **Pattern** (finishes): `seed` 0–999 (pattern offset/scale variation) and `wear` 0–1 (band:
  Factory New < .07, Minimal Wear < .15, Field-Tested < .38, Well-Worn < .45, Battle-Scarred).
- **Name tag** (admin or future item): `nameTag` string (profanity-filtered, 24 chars).
- **Admin custom**: `customName`, `customDesc`, `tint` (hex) — an admin can mint a one-off.
Multiple qualities stack (e.g. Strange Professional Killstreak finish). Display order:
`[Unusual] [Strange] [Festive] [Killstreak/Professional] <name>`.

### Equipped look (broadcast)
Equipped = `slot → uid` (server-validated: you own it and it's `owned`). What other players see is
a compact **Look** per slot: `{ d: defId, e?: effect, s?: sheen, k?: ksEffect, f?: 1 (festive),
p?: seed, w?: wear, t?: tint }` carried in the room `meta`. Strange kill counts are NOT broadcast
per tick; the killcam card may show "Strange Railgun — 1,234 kills".

## 2. Cases ("rolls")

Cases are opened directly with credits or a **free roll** token (no keys). Standard 150 ⛁,
Vault 600 ⛁. Families:
| case | pool |
|---|---|
| Hat Case | hats |
| Weapon Case | finishes + beams |
| Accessory Case | face + back |
| Taunt Case | emotes + finishers + spawn effects |
| Vault Case (premium) | everything; tier odds shifted up; Unobtainable 0.02% |
Roll = tier (fixed odds) → def uniformly among that tier in the pool → qualities → mint. RNG:
`crypto.randomInt`. Every open is logged (`item_events` + audit).
Duplicates are allowed (it's an economy now); salvage or sell them.

### Custom gun models
High-tier finishes carry `data.model` (cosmetics.ts) → a CUSTOM railgun model + signature VFX
(src/game/gun/custom/): Legendary (Spectrum, Wyrmfang, Tesla Coilgun), Relic (Reaper, Seraph),
Unobtainable (Oblivion, Celestial — the most extreme VFX; Vault 0.02% or admin mint) and the staff
**Sovereign Regalia**. Same screen footprint/fairness as the standard gun.

### Staff "Sovereign" set (bound, admin-only, Unobtainable)
Sovereign Crown (hat), Sovereign Mantle (back), Sovereign Visor (face), Sovereign Regalia (gun),
Sovereign beam (gilded), Sovereign card, name colour, title. Granted to staff as bound instances.

## 3. Credits in / out
In: matches (existing formula), **daily challenges** (raised: 40–60 ⛁ + XP each), weekly
(200–300 ⛁), Career Road credits + **free rolls** (road "case key" → 1 free roll), first win.
Out: cases, market tax, listing fee. Salvage returns credits below case EV (~12%).

## 4. Market (fixed-price listings)
- List an owned tradable instance for a price ≥ floor (= tier salvage × 1.5, min 5) and ≤
  1,000,000. **Listing fee 2%** (min 1, non-refundable) + **sale tax 10%** (seller gets 90%).
- Listed items are escrowed (state `listed`, can't equip/trade/salvage); unlist anytime.
- Max 25 active listings per seller. A listing can't be bought by its seller.
- Browse/filter by slot, tier, quality, effect; sort by price/newest. Per-def **price history**
  (last 50 sales) + **suggested price** (median of last 10 sales of the same def+quality).
- Buy is one DB transaction: credits move, tax burned, item owner flips, events logged.

## 5. Trading (direct offers)
- Offer = `{ to, giveItems[], giveCredits, getItems[], getCredits, note? }` (≤ 8 items per side).
  Recipient accepts or declines; the sender can cancel. Accept re-validates every item/credit and
  swaps atomically; any change = a new offer (offers are immutable). Offers expire after 48 h.
- Gates (both sides): logged in, **level ≥ 5 and ≥ 10 recorded matches**, account age ≥ 24 h.
  Max 20 accepted trades/day; credits in trades ≤ 5,000/day per account.
- Bound items (titles, founder, road rewards, admin items flagged bound) never trade/list.

## 6. Reset + onboarding (migration)
- `instagib_stats.unlocked` is copied to `legacy_unlocked` (kept for audit, never read again);
  `unlocked`/`equipped`/`case_keys` are cleared; equipped resets to defaults.
- Every existing account gets, once (idempotent flag `econ_v3`): credits `300 + 25 × level`
  (cap 3,000) and free rolls by level: L1–4: 3, L5–9: 5, L10–19: 8, L20+: 12. Plus a bound
  **Founder** title instance for accounts created before the deploy.
- Earned titles are re-minted as bound instances from career stats; admins get the staff items as
  bound instances.

## 7. Admin
Admin API + dashboard tab: search a player's inventory; mint any def with chosen quality/attrs
(or a custom one-off: name, description, tint, effect, tier incl. Unobtainable, bound or not);
grant credits / free rolls; revoke an item (state `revoked`, logged); view an item's provenance.

## 8. In-game taunts
Taunt key (default `G`) plays your equipped emote in-match: the camera swings to a third-person
orbit around you for the clip, you can't fire while taunting (movement locked for the clip,
cancel by jumping), the server relays a `taunt` event to the room so everyone sees it, and an
**unusual taunt** plays its effect around you. 3 s cooldown.

## 9. Tables (server)
- `instagib_items(uid PK, owner_id, def, mint, quality TEXT(json array), attrs TEXT(json),
  origin, tradable INT, state, created_at, updated_at)` + indexes (owner_id,state), (def).
- `instagib_item_events(id PK, uid, ts, kind, from_id, to_id, meta TEXT)` — mint / trade /
  list / unlist / sale / salvage / equip? (no) / revoke / admin.
- `instagib_mint_counters(def PK, next INT)`.
- `instagib_market(id PK, uid, seller_id, price, created_at, state, buyer_id, sold_at)`.
- `instagib_trades(id PK, from_id, to_id, give TEXT, get TEXT, give_credits, get_credits, note,
  state, created_at, resolved_at)`.
- `instagib_stats` new cols: `free_rolls INT`, `econ_v3 INT`,
  `legacy_unlocked TEXT`, `equipped_items TEXT(json slot→uid)`.

## 10. API (REST, cookie auth; all writes rate-limited + transactional)
- `GET /api/inventory` → `{ items: ItemInstanceWire[], equipped: slot→uid, credits, freeRolls }`
- `POST /api/inventory/equip {slot, uid|null}` → `{ ok, equipped, looks }`
- `POST /api/inventory/salvage {uids[]}` → `{ ok, credits, removed }`
- `GET /api/cases` → case defs + your pity/free rolls; `POST /api/cases/open {caseId, useRoll}`
  → `{ ok, item: ItemInstanceWire, tier, credits, freeRolls }`
- `GET /api/market?slot&tier&quality&q&sort&page` · `GET /api/market/history/:def` ·
  `POST /api/market/list {uid, price}` · `POST /api/market/unlist {id}` ·
  `POST /api/market/buy {id}` · `GET /api/market/mine`
- `GET /api/trades` · `POST /api/trades/offer {…}` · `POST /api/trades/:id/accept|decline|cancel`
- `GET /api/players/:name/inventory` (public, tradable items only, for building offers)
- Admin: `POST /api/admin/items/mint`, `POST /api/admin/items/revoke`, `POST /api/admin/grant`
  `{player, credits?, rolls?}`, `GET /api/admin/items/:uid/history`, `GET /api/admin/inventory/:player`
- WS: `{type:'equipLooks'}` is no longer needed — the client sends `{type:'loadout', uids}` and
  the server resolves Looks from the DB; `{type:'taunt'}` → broadcast `{type:'taunt', id, look}`.
