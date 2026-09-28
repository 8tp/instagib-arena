// In-memory stand-in for the economy server (enabled with ?mockEconomy=1).
// Mirrors docs/economy.md closely enough to develop and screenshot every
// screen: rolls use the real tier + quality odds, listings/trades/salvage
// mutate real state, and everything resets on reload. Never used in prod
// unless the URL asks for it.
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
  type CaseId,
  type ItemAttrs,
  type ItemInstanceWire,
  type ItemSlot,
  type Quality,
  type Tier,
} from '../game/items/types';
import type {
  AdminInvResp,
  BuyResp,
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
  MintBody,
  OfferBody,
  OpenCaseResp,
  PlayerInvResp,
  Res,
  SalvageResp,
  Trade,
  TradesResp,
} from './api';
import { instBaseName, instTier, marketFloor, listingFee, instLook } from './display';

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
    attrs.wear = roll();
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
const S = {
  credits: 1240,
  freeRolls: 6,
  equipped: {} as Equipped,
  items: [] as ItemInstanceWire[],
  market: [] as Listing[],
  sales: {} as Record<string, { ts: number; price: number; quality?: Quality[] }[]>,
  trades: [] as Trade[],
  people: {} as Record<string, ItemInstanceWire[]>,
  events: {} as Record<string, ItemEvent[]>,
  listSeq: 500,
  tradeSeq: 90,
};

function seedState() {
  const add = (def: string, q: Quality[] = [], attrs: ItemAttrs = {}, over: Partial<ItemInstanceWire> = {}) => {
    const it = make(def, { quality: q, attrs, ...over });
    S.items.push(it);
    return it;
  };
  const tophat = add('hat.tophat', ['unusual'], { effect: 'fx.galaxy' });
  add('hat.wizard', ['unusual'], { effect: 'fx.embers' });
  add('hat.viking');
  add('hat.crown', [], {}, { tier: undefined });
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
  const rail = add('gun.toxic', ['strange', 'killstreak'], { kills: 412, seed: 318, wear: 0.05, sheen: 'sheen.green' });
  add('gun.gold', ['strange', 'professional', 'killstreak'], { kills: 1340, seed: 77, wear: 0.31, sheen: 'sheen.violet', ksEffect: 'ks.hypno' });
  add('gun.carbon', [], { seed: 901, wear: 0.42 });
  add('gun.spectrum', [], { seed: 5, wear: 0.02 });
  add('gun.reaper', [], { seed: 5, wear: 0.02 });
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
  add('title.veteran', ['founder'], {}, { origin: 'title', tradable: false });
  add('title.founder', ['founder'], {}, { origin: 'founder', tradable: false });
  add('hat.cap');
  add('hat.cap');
  add('back.pack');
  S.equipped = { hat: tophat.uid, finish: rail.uid };

  // Market: other players' listings.
  const sellers = ['Kestrel', 'Vandal', 'Nyx', 'Halcyon', 'Tobiko', 'Rook'];
  const defs = ITEM_DEFS.filter((d) => d.tradable && !d.default && d.slot !== 'title' && d.slot !== 'card');
  for (let i = 0; i < 42; i++) {
    const d = pick(defs);
    const { quality, attrs } = rollQualities(d, rnd);
    const it = make(d.id, { quality, attrs, state: 'listed' });
    const base = marketFloor(d.tier) * (1.3 + rnd() * 2.5) * (quality.includes('unusual') ? 6 : quality.length ? 1.6 : 1);
    S.market.push({ id: S.listSeq++, item: it, price: Math.max(5, Math.round(base)), seller: pick(sellers), createdAt: Date.now() - Math.floor(rnd() * 3 * DAY) });
  }
  // Price histories.
  for (const d of defs) {
    const base = marketFloor(d.tier) * 2;
    S.sales[d.id] = Array.from({ length: 24 }, (_, k) => ({
      ts: Date.now() - (24 - k) * 0.6 * DAY,
      price: Math.max(5, Math.round(base * (0.75 + rnd() * 0.6 + k * 0.006))),
    }));
  }
  // My own listing.
  const mineIt = add('hat.fedora', [], {}, { state: 'listed' });
  S.market.push({ id: S.listSeq++, item: mineIt, price: 140, seller: ME, createdAt: Date.now() - 4 * 3600_000 });

  // Other players' tradable inventories.
  for (const p of ['Kestrel', 'Vandal', 'Nyx']) {
    S.people[p] = Array.from({ length: 11 }, () => {
      const d = pick(defs);
      const { quality, attrs } = rollQualities(d, rnd);
      return make(d.id, { quality, attrs });
    });
  }
  // Trades.
  const k = S.people.Kestrel;
  S.trades.push({
    id: S.tradeSeq++,
    from: 'Kestrel',
    to: ME,
    give: [k[0], k[1]],
    get: [S.items.find((i) => i.def === 'back.jetpack')!],
    giveCredits: 0,
    getCredits: 50,
    note: 'Jetpack for my two? Fair enough I think.',
    state: 'pending',
    createdAt: Date.now() - 2 * 3600_000,
    expiresAt: Date.now() + 46 * 3600_000,
  });
  S.trades.push({
    id: S.tradeSeq++,
    from: 'Nyx',
    to: ME,
    give: [S.people.Nyx[0]],
    get: [],
    giveCredits: 0,
    getCredits: 300,
    state: 'pending',
    createdAt: Date.now() - 9 * 3600_000,
    expiresAt: Date.now() + 39 * 3600_000,
  });
  S.trades.push({
    id: S.tradeSeq++,
    from: ME,
    to: 'Vandal',
    give: [S.items.find((i) => i.def === 'face.goggles')!],
    get: [S.people.Vandal[2]],
    giveCredits: 25,
    getCredits: 0,
    state: 'pending',
    createdAt: Date.now() - 5 * 3600_000,
    expiresAt: Date.now() + 43 * 3600_000,
  });
  S.trades.push({
    id: S.tradeSeq++,
    from: 'Halcyon',
    to: ME,
    give: [S.people.Kestrel[5]],
    get: [],
    giveCredits: 0,
    getCredits: 0,
    state: 'accepted',
    createdAt: Date.now() - 3 * DAY,
    resolvedAt: Date.now() - 2.9 * DAY,
  });
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
  (S.events[uid] ??= []).push({ id: `${uid}-${(S.events[uid]?.length ?? 0) + 1}`, ts: Date.now(), kind, ...extra });
};

// ── Inventory ───────────────────────────────────────────────────────────────
export function inventory(): Promise<Res<InventoryResp>> {
  ensure();
  return delay(ok({ items: owned().map((i) => ({ ...i })), equipped: { ...S.equipped }, credits: S.credits, freeRolls: S.freeRolls }));
}
export function equip(slot: ItemSlot, uid: string | null, id?: string): Promise<Res<EquipResp>> {
  ensure();
  if (uid) {
    const it = byUid(uid);
    if (!it || it.state !== 'owned' || itemDef(it.def)?.slot !== slot) return delay(fail(400, 'invalid'));
    S.equipped[slot] = uid;
  } else delete S.equipped[slot];
  const looks: EquipResp['looks'] = {};
  for (const [sl, u] of Object.entries(S.equipped)) {
    const it = u ? byUid(u) : undefined;
    if (it) looks[sl as ItemSlot] = instLook(it);
  }
  void id;
  return delay(ok({ equipped: { ...S.equipped }, looks }), 80);
}
export function salvage(uids: string[]): Promise<Res<SalvageResp>> {
  ensure();
  const removed: string[] = [];
  for (const u of uids) {
    const it = byUid(u);
    if (!it || it.state !== 'owned') continue;
    it.state = 'salvaged';
    S.credits += TIER_META[instTier(it)].salvage;
    removed.push(u);
    for (const [sl, eq] of Object.entries(S.equipped)) if (eq === u) delete S.equipped[sl as ItemSlot];
    log(u, 'salvage');
  }
  return delay(ok({ credits: S.credits, removed }));
}

// ── Cases ───────────────────────────────────────────────────────────────────
export function cases(): Promise<Res<CasesResp>> {
  ensure();
  return delay(ok({ freeRolls: S.freeRolls, credits: S.credits }), 60);
}
export function openCase(caseId: CaseId, useRoll: boolean): Promise<Res<OpenCaseResp>> {
  ensure();
  const c = CASES.find((x) => x.id === caseId);
  if (!c) return delay(fail(400, 'invalid'));
  if (useRoll) {
    if (S.freeRolls <= 0) return delay(fail(400, 'no-rolls'));
  } else if (S.credits < c.cost) return delay(fail(400, 'insufficient'));
  // ?mockTier=relic|unobtainable|… forces the roll (screenshots / QA of the reveals).
  const forced = new URLSearchParams(window.location.search).get('mockTier') as Tier | null;
  let tier = forced && TIERS.includes(forced) ? forced : rollTier(c.odds);
  const pool = tier === 'unobtainable' ? vaultUnobtainables() : casePoolFor(c.slots).filter((d) => d.tier === tier);
  let list = pool;
  // Fall back to the nearest lower tier that has items.
  let ti = TIERS.indexOf(tier);
  while (list.length === 0 && ti > 0) {
    ti--;
    tier = TIERS[ti];
    list = casePoolFor(c.slots).filter((d) => d.tier === tier);
  }
  const def = list[Math.floor(Math.random() * list.length)];
  const { quality, attrs } = rollQualities(def, new URLSearchParams(window.location.search).get('mockLucky') ? () => 0.001 : Math.random);
  if (useRoll) S.freeRolls--;
  else S.credits -= c.cost;
  const it = make(def.id, { quality, attrs, origin: 'case', createdAt: Date.now() });
  S.items.push(it);
  log(it.uid, 'mint', { meta: { case: caseId } });
  return delay(ok({ item: { ...it }, tier, credits: S.credits, freeRolls: S.freeRolls }), 200);
}

// ── Market ──────────────────────────────────────────────────────────────────
const suggestedFor = (it: ItemInstanceWire): number | undefined => {
  const s = (S.sales[it.def] ?? []).slice(-10).map((x) => x.price).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};
export function market(q: MarketQuery): Promise<Res<MarketResp>> {
  ensure();
  const text = (q.q ?? '').trim().toLowerCase();
  let list = S.market.filter((l) => l.seller !== ME);
  if (q.slot) list = list.filter((l) => itemDef(l.item.def)?.slot === q.slot);
  if (q.tier) list = list.filter((l) => instTier(l.item) === q.tier);
  if (q.quality) list = list.filter((l) => l.item.quality.includes(q.quality as Quality));
  if (q.effect) list = list.filter((l) => l.item.attrs.effect === q.effect);
  if (text) list = list.filter((l) => instBaseName(l.item).toLowerCase().includes(text) || l.seller.toLowerCase().includes(text));
  const sort = q.sort ?? 'newest';
  list = [...list].sort((a, b) =>
    sort === 'price-asc' ? a.price - b.price : sort === 'price-desc' ? b.price - a.price : sort === 'tier' ? TIER_META[instTier(b.item)].rank - TIER_META[instTier(a.item)].rank : b.createdAt - a.createdAt,
  );
  const per = 24;
  const page = Math.max(1, q.page ?? 1);
  const pages = Math.max(1, Math.ceil(list.length / per));
  return delay(ok({ listings: list.slice((page - 1) * per, page * per).map((l) => ({ ...l, suggested: suggestedFor(l.item) })), total: list.length, page, pages }));
}
export function history(def: string): Promise<Res<HistoryResp>> {
  ensure();
  const sales = (S.sales[def] ?? []).slice(-50);
  return delay(ok({ def, sales, suggested: sales.length ? sales.slice(-10).map((s) => s.price).sort((a, b) => a - b)[Math.floor(Math.min(10, sales.length) / 2)] : undefined }), 80);
}
export function list(uid: string, price: number): Promise<Res<ListResp>> {
  ensure();
  const it = byUid(uid);
  if (!it || it.state !== 'owned') return delay(fail(400, 'gone'));
  if (!it.tradable) return delay(fail(400, 'bound'));
  if (price < marketFloor(instTier(it)) || price > MARKET.maxPrice) return delay(fail(400, 'price'));
  if (S.market.filter((l) => l.seller === ME).length >= MARKET.maxListings) return delay(fail(400, 'limit'));
  const fee = listingFee(price);
  if (S.credits < fee) return delay(fail(400, 'insufficient'));
  S.credits -= fee;
  it.state = 'listed';
  for (const [sl, eq] of Object.entries(S.equipped)) if (eq === uid) delete S.equipped[sl as ItemSlot];
  const l: Listing = { id: S.listSeq++, item: it, price, seller: ME, createdAt: Date.now() };
  S.market.push(l);
  log(uid, 'list', { meta: { price } });
  return delay(ok({ listing: l, fee, credits: S.credits }));
}
export function unlist(id: Listing['id']): Promise<Res<{ credits?: number }>> {
  const i = S.market.findIndex((l) => l.id === id && l.seller === ME);
  if (i < 0) return delay(fail(404, 'gone'));
  S.market[i].item.state = 'owned';
  S.market.splice(i, 1);
  return delay(ok({ credits: S.credits }));
}
export function buy(id: Listing['id']): Promise<Res<BuyResp>> {
  const i = S.market.findIndex((l) => l.id === id);
  if (i < 0) return delay(fail(404, 'gone'));
  const l = S.market[i];
  if (l.seller === ME) return delay(fail(400, 'own'));
  if (S.credits < l.price) return delay(fail(400, 'insufficient'));
  S.credits -= l.price;
  S.market.splice(i, 1);
  const it = { ...l.item, state: 'owned' as const, origin: 'market' as const };
  S.items.push(it);
  (S.sales[it.def] ??= []).push({ ts: Date.now(), price: l.price, quality: it.quality });
  log(it.uid, 'sale', { from: l.seller, to: ME, meta: { price: l.price } });
  return delay(ok({ item: { ...it }, credits: S.credits }));
}
export function myListings(): Promise<Res<{ listings: Listing[] }>> {
  ensure();
  return delay(ok({ listings: S.market.filter((l) => l.seller === ME).map((l) => ({ ...l, mine: true, suggested: suggestedFor(l.item) })) }), 80);
}

// ── Trades ──────────────────────────────────────────────────────────────────
export function trades(): Promise<Res<TradesResp>> {
  ensure();
  const mine = S.trades;
  return delay(
    ok({
      incoming: mine.filter((t) => t.to === ME && t.state === 'pending'),
      outgoing: mine.filter((t) => t.from === ME && t.state === 'pending'),
      history: mine.filter((t) => t.state !== 'pending'),
      me: { level: 12, matches: 34, accountAgeMs: 9 * DAY },
      credits: S.credits,
    }),
  );
}
export function offer(b: OfferBody): Promise<Res<{ trade?: Trade }>> {
  ensure();
  const theirs = S.people[b.to] ?? S.people[Object.keys(S.people).find((k) => k.toLowerCase() === b.to.toLowerCase()) ?? ''];
  if (!theirs) return delay(fail(404, 'no-player'));
  const give = b.giveItems.map((u) => byUid(u)).filter((x): x is ItemInstanceWire => !!x && x.state === 'owned' && x.tradable);
  const get = b.getItems.map((u) => theirs.find((i) => i.uid === u)).filter((x): x is ItemInstanceWire => !!x);
  if (give.length !== b.giveItems.length || get.length !== b.getItems.length) return delay(fail(400, 'gone'));
  if (b.giveCredits > S.credits) return delay(fail(400, 'insufficient'));
  if (give.length + get.length + b.giveCredits + b.getCredits === 0) return delay(fail(400, 'empty'));
  const t: Trade = {
    id: S.tradeSeq++,
    from: ME,
    to: b.to,
    give,
    get,
    giveCredits: b.giveCredits,
    getCredits: b.getCredits,
    note: b.note,
    state: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + TRADE.expiryMs,
  };
  S.trades.unshift(t);
  return delay(ok({ trade: t }));
}
export function tradeAct(id: Trade['id'], act: 'accept' | 'decline' | 'cancel'): Promise<Res<{ credits?: number }>> {
  const t = S.trades.find((x) => x.id === id);
  if (!t || t.state !== 'pending') return delay(fail(404, 'gone'));
  if (act === 'accept' && t.to === ME) {
    if (t.getCredits > S.credits) return delay(fail(400, 'insufficient'));
    S.credits += t.giveCredits - t.getCredits;
    for (const it of t.get) {
      const m = byUid(it.uid);
      if (m) m.state = 'traded';
    }
    for (const it of t.give) S.items.push({ ...it, state: 'owned', origin: 'trade' });
    t.state = 'accepted';
  } else t.state = act === 'accept' ? 'declined' : act === 'decline' ? 'declined' : 'cancelled';
  t.resolvedAt = Date.now();
  return delay(ok({ credits: S.credits }));
}
export function playerInventory(name: string): Promise<Res<PlayerInvResp>> {
  ensure();
  const key = Object.keys(S.people).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return delay(fail(404, 'no-player'));
  const gate = key === 'Vandal' ? { level: 3, matches: 6, accountAgeMs: 3 * DAY } : { level: 22, matches: 180, accountAgeMs: 40 * DAY };
  return delay(ok({ name: key, items: S.people[key].map((i) => ({ ...i })), gate }));
}

// ── Admin ───────────────────────────────────────────────────────────────────
export function adminInventory(player: string): Promise<Res<AdminInvResp>> {
  ensure();
  if (player.toLowerCase() === ME.toLowerCase()) {
    return delay(ok({ player: ME, credits: S.credits, freeRolls: S.freeRolls, level: 12, items: S.items.map((i) => ({ ...i, ownerState: i.state })) }));
  }
  const key = Object.keys(S.people).find((k) => k.toLowerCase() === player.toLowerCase());
  if (!key) return delay(fail(404, 'no-player'));
  return delay(ok({ player: key, credits: 420, freeRolls: 2, level: 18, items: S.people[key].map((i) => ({ ...i })) }));
}
export function adminMint(b: MintBody): Promise<Res<{ item: ItemInstanceWire }>> {
  ensure();
  const defId = b.def ?? b.custom?.art ?? 'hat.cap';
  const base = itemDef(defId);
  const it = make(defId, {
    quality: [...(b.quality ?? []), 'admin' as const].filter((q, i, a) => a.indexOf(q) === i),
    attrs: { ...(b.attrs ?? {}), ...(b.custom ? { customName: b.custom.name, customDesc: b.custom.desc, tint: b.custom.tint } : {}) },
    origin: 'admin',
    tradable: !b.bound && (base?.tradable ?? true),
    tier: b.custom?.tier,
    createdAt: Date.now(),
  });
  if (b.player.toLowerCase() === ME.toLowerCase()) S.items.push(it);
  else (S.people[b.player] ??= []).push(it);
  log(it.uid, 'admin', { meta: { player: b.player } });
  return delay(ok({ item: it }));
}
export function adminRevoke(uid: string): Promise<Res<{ done?: boolean }>> {
  const it = byUid(uid);
  if (it) it.state = 'revoked';
  log(uid, 'revoke');
  return delay(ok({}));
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
  const ev = S.events[uid] ?? [
    { id: 'a', ts: it.createdAt, kind: 'mint', meta: { origin: it.origin } },
    { id: 'b', ts: it.createdAt + 3600_000, kind: 'list', meta: { price: 120 } },
    { id: 'c', ts: it.createdAt + 7200_000, kind: 'sale', from: 'Kestrel', to: ME, meta: { price: 120 } },
  ];
  return delay(ok({ item: it, owner: ME, events: ev }), 80);
}

