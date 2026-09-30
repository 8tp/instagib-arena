// In-memory stand-in for the economy server (enabled with ?mockEconomy=1).
// Mirrors docs/economy.md closely enough to develop and screenshot every
// screen: rolls use the real tier + quality odds, listings/trades/salvage
// mutate real state, and everything resets on reload. Never used in prod
// unless the URL asks for it.
import { CARD_STYLES } from '../game/cosmetics';
import { ITEM_DEFS, casePoolFor, itemDef, vaultUnobtainables, type ItemDef } from '../game/items/catalog';
import {
  CASES,
  KS_EFFECTS,
  KS_SHEENS,
  MARKET,
  QUALITY_ODDS,
  TIERS,
  TIER_META,
  TRADE,
  UNUSUAL_EFFECTS,
  REWARD_LIMITS,
  type CaseId,
  type InboxMessageWire,
  type ItemAttrs,
  type ItemInstanceWire,
  type ItemSlot,
  type Loadout,
  type Quality,
  type RedeemCodeWire,
  type RewardBundle,
  type RewardItemSpec,
  type Tier,
} from '../game/items/types';
import type {
  AdminInvResp,
  BuyResp,
  CaseInfo,
  CasesResp,
  Equipped,
  EquipResp,
  HistoryResp,
  InventoryResp,
  ItemEvent,
  ItemHistoryResp,
  ListResp,
  Listing,
  MarketQuery,
  MarketResp,
  MineResp,
  MintBody,
  OfferBody,
  OpenCaseResp,
  CasePay,
  ClaimResp,
  CreateCodeBody,
  GiftBody,
  Granted,
  InboxResp,
  InboxSummary,
  PlayerHit,
  PlayerInvResp,
  RedeemResp,
  Redemption,
  Res,
  SalvageResp,
  Trade,
  TradesResp,
} from './api';
import { instBaseName, instTier, marketFloor, listingFee, instLook } from './display';
import { specQualities } from '../inbox/reward';

const ok = <T>(d: T): Res<T> => ({ ...d, ok: true }) as unknown as Res<T>;
const fail = (status: number, reason: string): Res<never> => ({ ok: false, status, reason });
const delay = <T>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

// Deterministic seed data (stable screenshots); live actions use Math.random.
let seed = 20260928;
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
let uidN = 1000;
const newUid = (): string => `m${(uidN++).toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`.padEnd(12, '0').slice(0, 12);

const DAY = 86_400_000;
const mintCounter: Record<string, number> = {};
const nextMint = (def: string): number => (mintCounter[def] = (mintCounter[def] ?? 36) + 1);

function make(def: string, over: Partial<ItemInstanceWire> = {}): ItemInstanceWire {
  return {
    uid: newUid(),
    def,
    mint: nextMint(def),
    quality: [],
    attrs: {},
    origin: 'case',
    tradable: itemDef(def)?.tradable ?? true,
    state: 'owned',
    createdAt: Date.now() - Math.floor(rnd() * 20 * DAY),
    ...over,
  };
}

// ── Rolls (fixed odds, no pity) ─────────────────────────────────────────────
function rollTier(odds: Record<Tier, number>): Tier {
  let r = Math.random();
  for (const t of TIERS) {
    r -= odds[t];
    if (r < 0) return t;
  }
  return 'common';
}
function rollQualities(def: ItemDef, roll = Math.random): { quality: Quality[]; attrs: ItemAttrs } {
  const quality: Quality[] = [];
  const attrs: ItemAttrs = {};
  if (def.slot === 'hat') {
    const p = def.tier === 'legendary' || def.tier === 'relic' || def.tier === 'unobtainable' ? QUALITY_ODDS.unusualHatLegendaryPlus : QUALITY_ODDS.unusualHat;
    if (roll() < p) {
      quality.push('unusual');
      attrs.effect = UNUSUAL_EFFECTS[Math.floor(roll() * UNUSUAL_EFFECTS.length)].id;
    }
  }
  if (def.slot === 'emote' && roll() < QUALITY_ODDS.unusualEmote) {
    const em = UNUSUAL_EFFECTS.filter((e) => e.taunt);
    quality.push('unusual');
    attrs.effect = em[Math.floor(roll() * em.length)].id;
  }
  if ((def.slot === 'finish' || def.slot === 'beam' || def.slot === 'finisher') && roll() < QUALITY_ODDS.strange) {
    quality.push('strange');
    attrs.kills = Math.floor(roll() * 300);
  }
  if (def.slot === 'finish') {
    attrs.seed = Math.floor(roll() * 1000);
    if (roll() < QUALITY_ODDS.killstreak) {
      quality.push('killstreak');
      attrs.sheen = KS_SHEENS[Math.floor(roll() * KS_SHEENS.length)].id;
      if (roll() < QUALITY_ODDS.professional / QUALITY_ODDS.killstreak) {
        quality.push('professional');
        attrs.ksEffect = KS_EFFECTS[Math.floor(roll() * KS_EFFECTS.length)].id;
      }
    }
  }
  return { quality, attrs };
}

// ── State ───────────────────────────────────────────────────────────────────
const ME = 'MockPlayer';
const SELLERS = ['Kestrel', 'Vandal', 'Nyx', 'Halcyon', 'Tobiko', 'Rook'];
type Sale = { price: number; soldAt: number; quality: string[] };
const S = {
  credits: 1240,
  freeRolls: 6,
  level: Number(new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('mockLevel')) || 12,
  equipped: {} as Equipped,
  items: [] as ItemInstanceWire[],
  market: [] as Listing[],
  sales: {} as Record<string, Sale[]>,
  trades: [] as Trade[],
  people: {} as Record<string, ItemInstanceWire[]>,
  events: {} as Record<string, ItemEvent[]>,
  listSeq: 500,
  tradeSeq: 90,
};

const wireListing = (it: ItemInstanceWire, price: number, seller: string, createdAt: number): Listing => ({
  id: S.listSeq++,
  price,
  sellerId: `acct-${seller.toLowerCase()}`,
  seller,
  createdAt,
  item: it,
  tier: instTier(it),
  suggested: null,
});
const side = (items: ItemInstanceWire[], credits: number) => ({ items, credits });
const wireTrade = (from: string, to: string, give: ItemInstanceWire[], giveC: number, get: ItemInstanceWire[], getC: number, note: string, state: Trade['state'], ageMs: number): Trade => ({
  id: S.tradeSeq++,
  fromId: `acct-${from.toLowerCase()}`,
  from,
  toId: `acct-${to.toLowerCase()}`,
  to,
  give: side(give, giveC),
  get: side(get, getC),
  note,
  state,
  createdAt: Date.now() - ageMs,
  expiresAt: Date.now() - ageMs + TRADE.expiryMs,
  resolvedAt: state === 'pending' ? 0 : Date.now() - ageMs + 600_000,
});

function seedState() {
  const add = (def: string, q: Quality[] = [], attrs: ItemAttrs = {}, over: Partial<ItemInstanceWire> = {}) => {
    const it = make(def, { quality: q, attrs, ...over });
    S.items.push(it);
    return it;
  };
  const tophat = add('hat.tophat', ['unusual'], { effect: 'fx.galaxy' });
  add('hat.wizard', ['unusual'], { effect: 'fx.embers' });
  add('hat.viking');
  add('hat.crown');
  add('hat.cap');
  add('hat.beanie');
  add('hat.fedora');
  add('hat.jester');
  add('hat.void', [], {}, { origin: 'admin' });
  add('face.aviators');
  add('face.gasmask');
  add('face.cyber');
  add('face.goggles');
  add('back.cape.crimson');
  add('back.wings.angel');
  add('back.jetpack');
  add('back.wings.energy');
  const rail = add('gun.toxic', ['strange', 'killstreak'], { kills: 412, seed: 318, sheen: 'sheen.green' });
  add('gun.gold', ['strange', 'professional', 'killstreak'], { kills: 1340, seed: 77, sheen: 'sheen.violet', ksEffect: 'ks.hypno' });
  add('gun.carbon', [], { seed: 901 });
  add('gun.spectrum', [], { seed: 5 });
  add('gun.reaper', [], { seed: 5 });
  add('rail.plasma');
  add('rail.gold', ['strange'], { kills: 88 });
  add('rail.spectrum');
  add('nova');
  add('shatter', ['strange'], { kills: 27 });
  add('overload');
  add('spawn.ring');
  add('spawn.rift');
  add('emote.flex');
  add('emote.dance', ['unusual'], { effect: 'fx.hearts' });
  add('emote.flourish');
  add('name.gold');
  add('name.violet');
  add('hat.cap');
  add('hat.cap');
  add('back.pack');
  const dyeTmp = add('dye.aurora');
  add('dye.gold');
  add('dye.hazard');
  add('dye.magma');
  add('dye.lime');
  S.equipped = { hat: tophat.uid, finish: rail.uid, dye: dyeTmp.uid };

  // Market: other players' listings.
  const defs = ITEM_DEFS.filter((d) => d.tradable && !d.default && d.slot !== 'title' && d.slot !== 'card');
  for (let i = 0; i < 42; i++) {
    const d = pick(defs);
    const { quality, attrs } = rollQualities(d, rnd);
    const it = make(d.id, { quality, attrs, state: 'listed' });
    const base = marketFloor(d.tier) * (1.3 + rnd() * 2.5) * (quality.includes('unusual') ? 6 : quality.length ? 1.6 : 1);
    S.market.push(wireListing(it, Math.max(5, Math.round(base)), pick(SELLERS), Date.now() - Math.floor(rnd() * 3 * DAY)));
  }
  // Price histories (newest first, like the server).
  for (const d of defs) {
    const base = marketFloor(d.tier) * 2;
    S.sales[d.id] = Array.from({ length: 24 }, (_, k) => ({
      soldAt: Date.now() - k * 0.6 * DAY,
      price: Math.max(5, Math.round(base * (0.75 + rnd() * 0.6 + (24 - k) * 0.006))),
      quality: [],
    }));
  }
  for (const l of S.market) l.suggested = suggestedFor(l.item);
  // My own listing.
  const mineIt = add('hat.fedora', [], {}, { state: 'listed' });
  S.market.push(wireListing(mineIt, 140, ME, Date.now() - 4 * 3600_000));

  // Other players' tradable inventories.
  for (const p of ['Kestrel', 'Vandal', 'Nyx']) {
    S.people[p] = Array.from({ length: 11 }, () => {
      const d = pick(defs);
      const { quality, attrs } = rollQualities(d, rnd);
      return make(d.id, { quality, attrs });
    });
  }
  const k = S.people.Kestrel;
  S.trades.push(wireTrade('Kestrel', ME, [k[0], k[1]], 0, [S.items.find((i) => i.def === 'back.jetpack')!], 50, 'Jetpack for my two? Fair enough I think.', 'pending', 2 * 3600_000));
  S.trades.push(wireTrade('Nyx', ME, [S.people.Nyx[0]], 0, [], 300, '', 'pending', 9 * 3600_000));
  S.trades.push(wireTrade(ME, 'Vandal', [S.items.find((i) => i.def === 'face.goggles')!], 25, [S.people.Vandal[2]], 0, '', 'pending', 5 * 3600_000));
  S.trades.push(wireTrade('Halcyon', ME, [S.people.Kestrel[5]], 0, [], 0, '', 'accepted', 3 * DAY));
}
let seeded = false;
const ensure = () => {
  if (!seeded) {
    seeded = true;
    seedState();
  }
};

const owned = () => S.items.filter((i) => i.state === 'owned' || i.state === 'listed');
const byUid = (u: string) => S.items.find((i) => i.uid === u);
const log = (uid: string, kind: string, extra: Partial<ItemEvent> = {}) => {
  (S.events[uid] ??= []).push({ id: (S.events[uid]?.length ?? 0) + 1, uid, ts: Date.now(), kind, from: '', to: '', meta: {}, ...extra });
};

// Level-gated / earned entitlements the mock account owns.
function entitlements(): string[] {
  const out = ITEM_DEFS.filter((d) => d.default).map((d) => d.id);
  for (const c of CARD_STYLES) if (c.source.type === 'level' && c.source.level <= S.level) out.push(c.id);
  for (const t of ['title.veteran', 'title.centurion', 'title.headhunter', 'title.founder']) out.push(t);
  return out;
}

const looksOf = (eq: Equipped): Loadout => {
  const looks: Loadout = {};
  for (const [sl, tok] of Object.entries(eq)) {
    if (!tok) continue;
    if (tok.startsWith('def:')) looks[sl as ItemSlot] = { d: tok.slice(4) };
    else {
      const it = byUid(tok);
      if (it) looks[sl as ItemSlot] = instLook(it);
    }
  }
  return looks;
};

// ── Inventory ───────────────────────────────────────────────────────────────
export function inventory(): Promise<Res<InventoryResp>> {
  ensure();
  return delay(ok({ items: owned().map((i) => ({ ...i })), equipped: { ...S.equipped }, looks: looksOf(S.equipped), credits: S.credits, freeRolls: S.freeRolls, entitlements: entitlements() }));
}
export function equip(slot: ItemSlot, token: string | null): Promise<Res<EquipResp>> {
  ensure();
  if (token) {
    if (token.startsWith('def:')) {
      if (!entitlements().includes(token.slice(4)) || itemDef(token.slice(4))?.slot !== slot) return delay(fail(400, 'not_owned'));
    } else {
      const it = byUid(token);
      if (!it || it.state !== 'owned') return delay(fail(400, 'not_owned'));
      if (itemDef(it.def)?.slot !== slot) return delay(fail(400, 'slot_mismatch'));
    }
    S.equipped[slot] = token;
  } else delete S.equipped[slot];
  return delay(ok({ equipped: { ...S.equipped }, looks: looksOf(S.equipped) }), 80);
}
export function salvage(uids: string[]): Promise<Res<SalvageResp>> {
  ensure();
  const removed: string[] = [];
  let gained = 0;
  for (const u of uids) {
    const it = byUid(u);
    if (!it || it.state !== 'owned') continue;
    it.state = 'salvaged';
    gained += TIER_META[instTier(it)].salvage;
    removed.push(u);
    for (const [sl, eq] of Object.entries(S.equipped)) if (eq === u) delete S.equipped[sl as ItemSlot];
    log(u, 'salvage');
  }
  S.credits += gained;
  return delay(ok({ credits: S.credits, gained, removed }));
}

// ── Cases ───────────────────────────────────────────────────────────────────
function poolCounts(c: (typeof CASES)[number]): Record<Tier, number> {
  const pool = casePoolFor(c.slots);
  const out = {} as Record<Tier, number>;
  for (const t of TIERS) out[t] = t === 'unobtainable' ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)).length : pool.filter((d) => d.tier === t).length;
  return out;
}
// Empty tiers fold into the nearest lower tier (as the server reports it).
function effectiveOdds(c: (typeof CASES)[number]): Record<Tier, number> {
  const pool = poolCounts(c);
  const out = { ...c.odds };
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i];
    if (out[t] > 0 && pool[t] === 0) {
      let j = i - 1;
      while (j >= 0 && pool[TIERS[j]] === 0) j--;
      const to = j >= 0 ? TIERS[j] : TIERS[i + 1];
      if (to) {
        out[to] += out[t];
        out[t] = 0;
      }
    }
  }
  return out;
}
export function cases(): Promise<Res<CasesResp>> {
  ensure();
  const list: CaseInfo[] = CASES.map((c) => {
    const has = (s: string) => (c.slots as readonly string[]).includes(s);
    const qo: CaseInfo['qualityOdds'] = {};
    if (has('hat')) {
      qo.unusualHat = QUALITY_ODDS.unusualHat;
      qo.unusualHatLegendaryPlus = QUALITY_ODDS.unusualHatLegendaryPlus;
    }
    if (has('emote')) qo.unusualEmote = QUALITY_ODDS.unusualEmote;
    if (has('finish') || has('beam') || has('finisher')) qo.strange = QUALITY_ODDS.strange;
    if (has('finish')) {
      qo.killstreak = QUALITY_ODDS.killstreak;
      qo.professional = QUALITY_ODDS.professional;
    }
    return { ...c, odds: effectiveOdds(c), nominalOdds: c.odds, pool: poolCounts(c), qualityOdds: qo };
  });
  const used = mockDailyUsed();
  return delay(ok({ cases: list, freeRolls: S.freeRolls, credits: S.credits, dailyAvailable: !used, nextDailyAt: used ? mockNextDaily() : 0, season: { id: 0, name: 'Season 0' } }), 60);
}
// The mock's daily-case day (in-memory; ?mockDaily=used starts it spent).
let mockDailyDay: string | null = null;
const mockDailyUsed = (): boolean => {
  const day = new Date().toISOString().slice(0, 10);
  if (mockDailyDay === null) mockDailyDay = new URLSearchParams(window.location.search).get('mockDaily') === 'used' ? day : '';
  return mockDailyDay === day;
};
const mockNextDaily = (): number => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
export function openCase(caseId: CaseId, pay: CasePay): Promise<Res<OpenCaseResp>> {
  ensure();
  const c = CASES.find((x) => x.id === caseId);
  if (!c) return delay(fail(400, 'unknown_case'));
  const useRoll = pay === 'roll';
  if (pay !== 'credits') {
    if (c.premium) return delay(fail(400, 'roll_not_allowed'));
    if (useRoll && S.freeRolls <= 0) return delay(fail(400, 'no_rolls'));
    if (pay === 'daily' && mockDailyUsed()) return delay(fail(400, 'daily_used'));
  } else if (S.credits < c.cost) return delay(fail(400, 'insufficient'));
  // ?mockTier=relic|unobtainable|… forces the roll (screenshots / QA of the reveals).
  const forced = new URLSearchParams(window.location.search).get('mockTier') as Tier | null;
  let tier = forced && TIERS.includes(forced) ? forced : rollTier(effectiveOdds(c));
  const pool = casePoolFor(c.slots);
  let list = tier === 'unobtainable' ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)) : pool.filter((d) => d.tier === tier);
  let ti = TIERS.indexOf(tier);
  while (list.length === 0 && ti > 0) {
    ti--;
    tier = TIERS[ti];
    list = pool.filter((d) => d.tier === tier);
  }
  const def = list[Math.floor(Math.random() * list.length)];
  const { quality, attrs } = rollQualities(def, new URLSearchParams(window.location.search).get('mockLucky') ? () => 0.001 : Math.random);
  if (useRoll) S.freeRolls--;
  else if (pay === 'daily') mockDailyDay = new Date().toISOString().slice(0, 10);
  else S.credits -= c.cost;
  const it = make(def.id, { quality, attrs, origin: 'case', createdAt: Date.now() });
  S.items.push(it);
  log(it.uid, 'mint', { meta: { case: caseId } });
  return delay(ok({ item: { ...it }, tier, credits: S.credits, freeRolls: S.freeRolls, usedRoll: useRoll, pay, nextDailyAt: mockDailyUsed() ? mockNextDaily() : 0 }), 200);
}

// ── Market ──────────────────────────────────────────────────────────────────
const suggestedFor = (it: ItemInstanceWire): number | null => {
  const s = (S.sales[it.def] ?? []).slice(0, 10).map((x) => x.price).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
export function market(q: MarketQuery): Promise<Res<MarketResp>> {
  ensure();
  const text = (q.q ?? '').trim().toLowerCase();
  let list = S.market.filter((l) => l.seller !== ME);
  if (q.slot) list = list.filter((l) => itemDef(l.item.def)?.slot === q.slot);
  if (q.tier) list = list.filter((l) => l.tier === q.tier);
  if (q.quality) list = list.filter((l) => l.item.quality.includes(q.quality as Quality));
  if (q.effect) list = list.filter((l) => l.item.attrs.effect === q.effect);
  if (text) list = list.filter((l) => instBaseName(l.item).toLowerCase().includes(text));
  const sort = q.sort ?? 'newest';
  list = [...list].sort((a, b) => (sort === 'price_asc' ? a.price - b.price : sort === 'price_desc' ? b.price - a.price : b.id - a.id));
  const size = 30;
  const page = Math.max(0, q.page ?? 0);
  return delay(ok({ listings: list.slice(page * size, (page + 1) * size), page, pageSize: size, total: list.length }));
}
export function history(def: string): Promise<Res<HistoryResp>> {
  ensure();
  const sales = (S.sales[def] ?? []).slice(0, 50);
  const d = itemDef(def);
  return delay(ok({ def, known: !!d, sales, suggested: sales.length ? sales.slice(0, 10).map((s) => s.price).sort((a, b) => a - b)[Math.floor(Math.min(10, sales.length) / 2)] : null, floor: d ? marketFloor(d.tier) : null }), 80);
}
export function list(uid: string, price: number): Promise<Res<ListResp>> {
  ensure();
  const it = byUid(uid);
  if (!it || it.state !== 'owned') return delay(fail(400, 'not_owned'));
  if (!it.tradable) return delay(fail(400, 'bound'));
  const floor = marketFloor(instTier(it));
  if (price < floor) return delay({ ok: false, status: 400, reason: 'below_floor', error: 'below_floor', need: floor } as Res<never>);
  if (price > MARKET.maxPrice) return delay(fail(400, 'above_max'));
  if (S.market.filter((l) => l.seller === ME).length >= MARKET.maxListings) return delay(fail(400, 'too_many_listings'));
  const fee = listingFee(price);
  if (S.credits < fee) return delay(fail(400, 'insufficient_fee'));
  S.credits -= fee;
  it.state = 'listed';
  for (const [sl, eq] of Object.entries(S.equipped)) if (eq === uid) delete S.equipped[sl as ItemSlot];
  const l = wireListing(it, price, ME, Date.now());
  S.market.push(l);
  log(uid, 'list', { meta: { price } });
  return delay(ok({ listing: l, fee, credits: S.credits }));
}
export function unlist(id: Listing['id']): Promise<Res<{ item: ItemInstanceWire }>> {
  const i = S.market.findIndex((l) => l.id === id && l.seller === ME);
  if (i < 0) return delay(fail(400, 'not_active'));
  const it = S.market[i].item;
  it.state = 'owned';
  S.market.splice(i, 1);
  return delay(ok({ item: it }));
}
export function buy(id: Listing['id']): Promise<Res<BuyResp>> {
  const i = S.market.findIndex((l) => l.id === id);
  if (i < 0) return delay(fail(400, 'not_active'));
  const l = S.market[i];
  if (l.seller === ME) return delay(fail(400, 'own_listing'));
  if (S.credits < l.price) return delay({ ok: false, status: 400, reason: 'insufficient', error: 'insufficient', need: l.price } as Res<never>);
  S.credits -= l.price;
  S.market.splice(i, 1);
  const it = { ...l.item, state: 'owned' as const, origin: 'market' as const };
  S.items.push(it);
  (S.sales[it.def] ??= []).unshift({ soldAt: Date.now(), price: l.price, quality: it.quality });
  log(it.uid, 'sale', { from: l.seller, to: ME, meta: { price: l.price } });
  return delay(ok({ item: { ...it }, price: l.price, credits: S.credits }));
}
export function myListings(): Promise<Res<MineResp>> {
  ensure();
  return delay(ok({ listings: S.market.filter((l) => l.seller === ME), recentSales: [] }), 80);
}

// ── Trades ──────────────────────────────────────────────────────────────────
export function trades(): Promise<Res<TradesResp>> {
  ensure();
  return delay(
    ok({
      incoming: S.trades.filter((t) => t.to === ME && t.state === 'pending'),
      outgoing: S.trades.filter((t) => t.from === ME && t.state === 'pending'),
      history: S.trades.filter((t) => t.state !== 'pending'),
      gate: (new URLSearchParams(window.location.search).get('mockGate') === 'level' ? { ok: false, reason: 'level', need: TRADE.minLevel } : { ok: true }) as TradesResp['gate'],
    }),
  );
}
export function offer(b: OfferBody): Promise<Res<{ trade?: Trade }>> {
  ensure();
  const key = Object.keys(S.people).find((k) => k.toLowerCase() === b.to.toLowerCase());
  if (!key) return delay(fail(404, 'no_player'));
  const give = b.giveItems.map((u) => byUid(u)).filter((x): x is ItemInstanceWire => !!x && x.state === 'owned' && x.tradable);
  const get = b.getItems.map((u) => S.people[key].find((i) => i.uid === u)).filter((x): x is ItemInstanceWire => !!x);
  if (give.length !== b.giveItems.length || get.length !== b.getItems.length) return delay(fail(400, 'item_unavailable'));
  if (b.giveCredits > S.credits) return delay(fail(400, 'insufficient'));
  if (give.length + get.length + b.giveCredits + b.getCredits === 0) return delay(fail(400, 'empty_offer'));
  const t = wireTrade(ME, key, give, b.giveCredits, get, b.getCredits, b.note ?? '', 'pending', 0);
  S.trades.unshift(t);
  return delay(ok({ trade: t }));
}
export function tradeAct(id: Trade['id'], act: 'accept' | 'decline' | 'cancel'): Promise<Res<{ trade?: Trade }>> {
  const t = S.trades.find((x) => x.id === id);
  if (!t || t.state !== 'pending') return delay(fail(404, 'not_found'));
  if (act === 'accept' && t.to === ME) {
    if (t.get.credits > S.credits) return delay(fail(400, 'insufficient'));
    S.credits += t.give.credits - t.get.credits;
    for (const it of t.get.items) {
      const m = byUid(it.uid);
      if (m) m.state = 'traded';
    }
    for (const it of t.give.items) S.items.push({ ...it, state: 'owned', origin: 'trade' });
    t.state = 'accepted';
  } else t.state = act === 'cancel' ? 'cancelled' : 'declined';
  t.resolvedAt = Date.now();
  return delay(ok({ trade: t }));
}
export function playerInventory(name: string): Promise<Res<PlayerInvResp>> {
  ensure();
  const key = Object.keys(S.people).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return delay(fail(404, 'not_found'));
  return delay(ok({ name: key, items: S.people[key].map((i) => ({ ...i })), canTrade: key !== 'Vandal' }));
}

// ── Admin ───────────────────────────────────────────────────────────────────
export function adminInventory(player: string, all = false): Promise<Res<AdminInvResp>> {
  ensure();
  if (player.toLowerCase() === ME.toLowerCase()) {
    return delay(ok({ player: ME, credits: S.credits, freeRolls: S.freeRolls, equipped: { ...S.equipped }, items: S.items.filter((i) => all || i.state === 'owned' || i.state === 'listed') }));
  }
  const key = Object.keys(S.people).find((k) => k.toLowerCase() === player.toLowerCase());
  if (!key) return delay(fail(404, 'not_found'));
  return delay(ok({ player: key, credits: 420, freeRolls: 2, equipped: {}, items: S.people[key].map((i) => ({ ...i })) }));
}
export function adminMint(b: MintBody): Promise<Res<{ items: ItemInstanceWire[] }>> {
  ensure();
  const base = itemDef(b.def);
  if (!base) return delay(fail(400, 'unknown_def'));
  const q = new Set<Quality>(b.quality ?? []);
  if (b.attrs?.effect) q.add('unusual');
  if (b.attrs?.kills != null) q.add('strange');
  if (b.attrs?.sheen) q.add('killstreak');
  if (b.attrs?.ksEffect) q.add('professional');
  if (b.attrs?.customName || b.attrs?.tint || b.tier) q.add('admin');
  const items: ItemInstanceWire[] = [];
  for (let n = 0; n < Math.max(1, Math.min(25, b.count ?? 1)); n++) {
    const it = make(b.def, { quality: [...q], attrs: { ...(b.attrs ?? {}) }, origin: 'admin', tradable: !b.bound && base.tradable, tier: b.tier, createdAt: Date.now() });
    if (b.player.toLowerCase() === ME.toLowerCase()) S.items.push(it);
    else (S.people[b.player] ??= []).push(it);
    log(it.uid, 'admin', { meta: { player: b.player } });
    items.push(it);
  }
  return delay(ok({ items }));
}
export function adminRevoke(uid: string): Promise<Res<{ item: ItemInstanceWire }>> {
  const it = byUid(uid);
  if (!it) return delay(fail(404, 'not_found'));
  it.state = 'revoked';
  log(uid, 'revoke');
  return delay(ok({ item: it }));
}
export function adminGrant(player: string, credits?: number, rolls?: number): Promise<Res<{ credits: number; freeRolls: number }>> {
  if (player.toLowerCase() === ME.toLowerCase()) {
    S.credits += credits ?? 0;
    S.freeRolls += rolls ?? 0;
  }
  return delay(ok({ credits: S.credits, freeRolls: S.freeRolls }));
}
export function adminHistory(uid: string): Promise<Res<ItemHistoryResp>> {
  ensure();
  const it = byUid(uid) ?? S.items[0];
  const ev: ItemEvent[] = S.events[uid] ?? [
    { id: 1, uid, ts: it.createdAt, kind: 'mint', from: '', to: ME, meta: { origin: it.origin } },
    { id: 2, uid, ts: it.createdAt + 3600_000, kind: 'list', from: ME, to: '', meta: { price: 120 } },
    { id: 3, uid, ts: it.createdAt + 7200_000, kind: 'sale', from: 'Kestrel', to: ME, meta: { price: 120 } },
  ];
  return delay(ok({ item: it, owner: ME, events: ev }), 80);
}


// ── Inbox + redeem codes (docs/economy.md §7b) ──────────────────────────────
// ?mockInbox=empty starts with no messages; ?mockInbox=error fails the list.
const mockInboxMode = (): string => new URLSearchParams(window.location.search).get('mockInbox') ?? '';
const IB = {
  seeded: false,
  seq: 40,
  messages: [] as InboxMessageWire[],
  codes: [] as RedeemCodeWire[],
  redemptions: {} as Record<string, Redemption[]>,
  fails: [] as number[],
};
const HOUR = 3600_000;
function ibMsg(m: Partial<InboxMessageWire> & Pick<InboxMessageWire, 'kind' | 'title'>): InboxMessageWire {
  return { id: IB.seq++, body: '', sender: 'Instagib Staff', createdAt: Date.now(), readAt: 0, claimedAt: 0, expiresAt: 0, reward: {}, granted: [], ...m };
}
function ibCode(c: Partial<RedeemCodeWire> & Pick<RedeemCodeWire, 'code' | 'reward'>): RedeemCodeWire {
  return { note: '', maxUses: 0, uses: 0, expiresAt: 0, minLevel: 0, active: true, createdBy: 'Huddled', createdAt: Date.now() - 2 * DAY, ...c };
}
function ibEnsure() {
  ensure();
  if (IB.seeded) return;
  IB.seeded = true;
  IB.codes.push(
    ibCode({ code: 'WELCOME-ARENA', reward: { credits: 500, rolls: 3, items: [{ def: 'hat.tophat', quality: ['unusual'], attrs: { effect: 'fx.sunbeams' }, bound: true }] }, note: 'Welcome to the arena. Have a hat on us.', maxUses: 1000, uses: 212 }),
    ibCode({ code: 'LAUNCH-2026', reward: { credits: 250 }, maxUses: 100, uses: 100, createdAt: Date.now() - 9 * DAY }),
    ibCode({ code: 'SUMMER-HEAT', reward: { rolls: 5 }, expiresAt: Date.now() - DAY, uses: 57, createdAt: Date.now() - 40 * DAY }),
    ibCode({ code: 'VETERAN-50', reward: { items: [{ def: 'back.wings.energy', quality: ['strange'], attrs: { kills: 0 } }] }, minLevel: 50, uses: 3 }),
  );
  IB.redemptions['WELCOME-ARENA'] = [
    { player: 'Kestrel', at: Date.now() - 3 * HOUR },
    { player: 'Nyx', at: Date.now() - 20 * HOUR },
  ];
  if (mockInboxMode() === 'empty') return;
  const receiptItem = make('face.aviators', { origin: 'code', createdAt: Date.now() - 3 * DAY });
  S.items.push(receiptItem);
  IB.messages.push(
    ibMsg({ kind: 'code', title: 'Code redeemed: LAUNCH-2026', body: 'Thanks for playing Instagib Arena.', createdAt: Date.now() - 3 * DAY, readAt: Date.now() - 3 * DAY, claimedAt: Date.now() - 3 * DAY, reward: { credits: 250, items: [{ def: 'face.aviators' }] }, granted: [receiptItem] }),
    ibMsg({ kind: 'system', title: 'Season 0 is live', body: 'Cases now drop the Origins collection. Older items stay yours forever — tradable, equippable, and tagged with their season.', createdAt: Date.now() - 26 * HOUR, readAt: Date.now() - 20 * HOUR }),
    ibMsg({
      kind: 'gift',
      title: 'Thanks for playtesting!',
      body: 'You found bugs, you sent clips, you kept the servers warm. Here’s a little something from all of us.',
      createdAt: Date.now() - 2 * HOUR,
      expiresAt: Date.now() + 6 * DAY,
      reward: {
        credits: 1500,
        rolls: 5,
        items: [
          { def: 'hat.crown', quality: ['unusual'], attrs: { effect: 'fx.galaxy' }, bound: true },
          { def: 'gun.gold', quality: ['strange', 'killstreak'], attrs: { kills: 0, sheen: 'sheen.violet', seed: 77 } },
        ],
      },
    }),
    ibMsg({ kind: 'gift', title: 'Weekend double-XP bonus', body: 'A few free rolls for the weekend grind.', createdAt: Date.now() - 20 * 60_000, reward: { rolls: 3 } }),
  );
}
const ibCounts = (): InboxSummary => ({
  unread: IB.messages.filter((m) => !m.readAt).length,
  unclaimed: IB.messages.filter((m) => !m.claimedAt && (m.reward.credits || m.reward.rolls || m.reward.items?.length) && (!m.expiresAt || m.expiresAt > Date.now())).length,
});
// Mint a bundle into the mock inventory (no validation beyond known defs).
function ibGrant(b: RewardBundle, origin: 'code' | 'gift'): Granted {
  S.credits += b.credits ?? 0;
  S.freeRolls += b.rolls ?? 0;
  const items = (b.items ?? []).map((spec) => {
    const { tier, ...attrs } = (spec.attrs ?? {}) as ItemAttrs & { tier?: Tier };
    const it = make(spec.def, { quality: specQualities(spec), attrs, origin, tradable: !spec.bound && (itemDef(spec.def)?.tradable ?? true), tier: spec.tier ?? tier, createdAt: Date.now() });
    S.items.push(it);
    return { ...it };
  });
  return { credits: b.credits ?? 0, rolls: b.rolls ?? 0, items };
}
function mockValidate(raw: RewardBundle | undefined): string | null {
  const b = raw ?? {};
  const int = (v: unknown, max: number) => v == null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max);
  if (!int(b.credits, REWARD_LIMITS.credits)) return 'bad_credits';
  if (!int(b.rolls, REWARD_LIMITS.rolls)) return 'bad_rolls';
  const items = b.items ?? [];
  if (items.length > REWARD_LIMITS.items) return 'bad_items';
  for (const it of items as RewardItemSpec[]) {
    const d = itemDef(it.def);
    if (!d) return 'item_unknown_def';
    if (d.default || d.slot === 'card' || d.slot === 'title') return 'item_not_an_item';
  }
  if (!b.credits && !b.rolls && items.length === 0) return 'empty_reward';
  return null;
}

export function inbox(): Promise<Res<InboxResp>> {
  ibEnsure();
  if (mockInboxMode() === 'error') return delay(fail(500, 'network'), 300);
  return delay(ok({ messages: [...IB.messages].sort((a, b) => b.id - a.id).map((m) => ({ ...m })), ...ibCounts() }), 180);
}
export function inboxSummary(): Promise<Res<InboxSummary>> {
  ibEnsure();
  return delay(ok(ibCounts()), 60);
}
export function inboxRead(id: number | 'all'): Promise<Res<object>> {
  ibEnsure();
  for (const m of IB.messages) if ((id === 'all' || m.id === id) && !m.readAt) m.readAt = Date.now();
  return delay(ok({}), 60);
}
export function inboxClaim(id: number): Promise<Res<ClaimResp>> {
  ibEnsure();
  const m = IB.messages.find((x) => x.id === id);
  if (!m) return delay(fail(404, 'not_found'));
  if (m.claimedAt) return delay(fail(400, 'claimed'));
  if (m.expiresAt && m.expiresAt <= Date.now()) return delay(fail(400, 'expired'));
  if (!m.reward.credits && !m.reward.rolls && !m.reward.items?.length) return delay(fail(400, 'nothing'));
  const granted = ibGrant(m.reward, 'gift');
  m.claimedAt = Date.now();
  m.readAt ||= m.claimedAt;
  m.granted = granted.items;
  return delay(ok({ message: { ...m }, granted, credits: S.credits, freeRolls: S.freeRolls }), 380);
}
export function redeem(raw: string): Promise<Res<RedeemResp>> {
  ibEnsure();
  const now = Date.now();
  IB.fails = IB.fails.filter((t) => t > now - 10 * 60_000);
  if (IB.fails.length >= 10) return delay(fail(429, 'too_many_attempts'));
  const code = raw.trim().toUpperCase().replace(/\s+/g, '');
  const miss = (r: string) => {
    IB.fails.push(now);
    return delay(fail(400, r));
  };
  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code)) return miss('bad_code');
  const c = IB.codes.find((x) => x.code === code);
  if (!c) return miss('not_found');
  if (!c.active) return delay(fail(400, 'inactive'));
  if (c.expiresAt && c.expiresAt <= now) return delay(fail(400, 'expired'));
  if (c.maxUses > 0 && c.uses >= c.maxUses) return delay(fail(400, 'used_up'));
  if ((IB.redemptions[code] ?? []).some((r) => r.player === ME)) return delay(fail(400, 'already_redeemed'));
  if (c.minLevel > S.level) return delay({ ok: false, status: 400, reason: 'level', error: 'level', need: c.minLevel } as Res<never>);
  const granted = ibGrant(c.reward, 'code');
  c.uses++;
  (IB.redemptions[code] ??= []).unshift({ player: ME, at: now });
  const msg = ibMsg({ kind: 'code', title: `Code redeemed: ${code}`, body: c.note || 'Thanks for playing Instagib Arena.', reward: c.reward, granted: granted.items, claimedAt: now, readAt: now });
  IB.messages.push(msg);
  return delay(ok({ code, granted, credits: S.credits, freeRolls: S.freeRolls, messageId: msg.id }), 520);
}

// Admin
export function adminCodes(): Promise<Res<{ codes: RedeemCodeWire[] }>> {
  ibEnsure();
  return delay(ok({ codes: [...IB.codes].sort((a, b) => b.createdAt - a.createdAt).map((c) => ({ ...c })) }), 100);
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function adminCreateCode(b: CreateCodeBody): Promise<Res<{ code: RedeemCodeWire }>> {
  ibEnsure();
  const bad = mockValidate(b.reward);
  if (bad) return delay(fail(400, bad));
  let code = (b.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (code && !/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code)) return delay(fail(400, 'bad_code'));
  if (code && IB.codes.some((c) => c.code === code)) return delay(fail(400, 'code_taken'));
  if (b.expiresAt && b.expiresAt <= Date.now()) return delay(fail(400, 'bad_expiry'));
  if (!code) code = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('')).join('-');
  const c = ibCode({ code, reward: b.reward, note: b.note ?? '', maxUses: b.maxUses ?? 0, expiresAt: b.expiresAt ?? 0, minLevel: b.minLevel ?? 0, createdBy: ME, createdAt: Date.now() });
  IB.codes.push(c);
  return delay(ok({ code: { ...c } }), 160);
}
export function adminCodeActive(code: string, active: boolean): Promise<Res<{ code: RedeemCodeWire }>> {
  ibEnsure();
  const c = IB.codes.find((x) => x.code === code);
  if (!c) return delay(fail(404, 'not_found'));
  c.active = active;
  return delay(ok({ code: { ...c } }), 80);
}
export function adminCodeRedemptions(code: string): Promise<Res<{ redemptions: Redemption[] }>> {
  ibEnsure();
  return delay(ok({ redemptions: IB.redemptions[code] ?? [] }), 80);
}
export function adminGift(b: GiftBody): Promise<Res<{ sent: number }>> {
  ibEnsure();
  if (!b.title?.trim()) return delay(fail(400, 'no_title'));
  const hasReward = !!b.reward && Object.keys(b.reward).length > 0;
  if (hasReward) {
    const bad = mockValidate(b.reward);
    if (bad) return delay(fail(400, bad));
  }
  if (b.expiresAt && b.expiresAt <= Date.now()) return delay(fail(400, 'bad_expiry'));
  const known = [ME, ...Object.keys(S.people)];
  if (!b.all && !known.some((k) => k.toLowerCase() === (b.player ?? '').toLowerCase())) return delay(fail(404, 'not_found'));
  if (b.all || (b.player ?? '').toLowerCase() === ME.toLowerCase()) {
    IB.messages.push(ibMsg({ kind: hasReward ? 'gift' : 'system', title: b.title.trim(), body: b.body ?? '', reward: hasReward ? b.reward! : {}, expiresAt: b.expiresAt ?? 0 }));
  }
  return delay(ok({ sent: b.all ? 1287 : 1 }), 220);
}
export function adminValidateReward(reward: RewardBundle): Promise<Res<object>> {
  const bad = mockValidate(reward);
  return delay(bad ? fail(400, bad) : ok({}), 90);
}
export function adminFindPlayers(q: string): Promise<Res<{ players: PlayerHit[] }>> {
  ensure();
  const all: PlayerHit[] = [ME, ...Object.keys(S.people), ...SELLERS.filter((s) => !(s in S.people))].map((name, i) => ({ id: `acct-${name.toLowerCase()}`, userName: name, level: 40 - i * 4, lastSeen: Date.now() - i * 5 * HOUR }));
  const t = q.trim().toLowerCase();
  return delay(ok({ players: all.filter((p) => !t || p.userName.toLowerCase().includes(t)).slice(0, 8) }), 90);
}
export function adminAccountCount(): Promise<Res<{ overview: { totalAccounts: number } }>> {
  return delay(ok({ overview: { totalAccounts: 1287 } }), 60);
}
