// Fixed-price market (docs/economy.md §4). Listing escrows the instance (state
// `listed`); a buy is ONE transaction: credits move, the 10% sale tax is burned,
// the owner flips, events + audit are written. All amounts are integers.

import { sqlite } from './sqlite';
import {
  addCredits,
  audit,
  econState,
  ensureOnboarded,
  getItemRow,
  itemEvent,
  q,
  tierOf,
  toWire,
  unequipUids,
  type ItemRow,
} from './economy';
import { MARKET, TIER_META, type ItemInstanceWire, type ItemSlot, type Tier, TIERS } from '../src/game/items/types';
import { ITEM_DEFS, itemDef } from '../src/game/items/catalog';

const PAGE_SIZE = 30;

export const listingFee = (price: number): number => Math.max(1, Math.round(price * MARKET.listingFeePct));
export const saleTax = (price: number): number => Math.max(1, Math.ceil(price * MARKET.saleTaxPct));
export function priceFloor(tier: Tier): number {
  return Math.max(MARKET.minPrice, Math.ceil(TIER_META[tier].salvage * MARKET.floorMult));
}

export type ListingWire = {
  id: number;
  price: number;
  sellerId: string;
  seller: string;
  createdAt: number;
  item: ItemInstanceWire;
  tier: Tier;
  suggested: number | null;
};

type ListingRow = { id: number; uid: string; seller_id: string; price: number; created_at: number; state: string; buyer_id: string; sold_at: number };

const nameOf = (id: string): string =>
  (q(`SELECT username FROM instagib_users WHERE id = ?`).get(id) as { username: string } | undefined)?.username ?? 'Player';

function wireListing(l: ListingRow, r: ItemRow): ListingWire {
  return {
    id: l.id,
    price: l.price,
    sellerId: l.seller_id,
    seller: nameOf(l.seller_id),
    createdAt: l.created_at,
    item: toWire(r),
    tier: tierOf(r),
    suggested: suggestedPrice(r.def, r.quality),
  };
}

// Median of the last 10 sales of the same def + same quality set.
export function suggestedPrice(def: string, quality: string): number | null {
  const rows = q(
    `SELECT m.price FROM instagib_market m JOIN instagib_items i ON i.uid = m.uid
      WHERE m.state = 'sold' AND i.def = ? AND i.quality = ? ORDER BY m.sold_at DESC, m.id DESC LIMIT 10`,
  ).all(def, quality) as { price: number }[];
  if (rows.length === 0) return null;
  const p = rows.map((r) => r.price).sort((a, b) => a - b);
  const mid = p.length >> 1;
  return p.length % 2 ? p[mid] : Math.round((p[mid - 1] + p[mid]) / 2);
}

export type MarketResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; need?: number };

export function listItem(playerId: string, uid: string, price: unknown): MarketResult<{ listing: ListingWire; credits: number; fee: number }> {
  if (!playerId) return { ok: false, error: 'guest' };
  if (typeof uid !== 'string' || !Number.isInteger(price)) return { ok: false, error: 'bad_request' };
  const p = price as number;
  return sqlite.transaction((): MarketResult<{ listing: ListingWire; credits: number; fee: number }> => {
    ensureOnboarded(playerId);
    const r = getItemRow(uid);
    if (!r || r.owner_id !== playerId || r.state !== 'owned') return { ok: false, error: 'not_owned' };
    if (!r.tradable) return { ok: false, error: 'bound' };
    const floor = priceFloor(tierOf(r));
    if (p < floor) return { ok: false, error: 'below_floor', need: floor };
    if (p > MARKET.maxPrice) return { ok: false, error: 'above_max', need: MARKET.maxPrice };
    const active = (q(`SELECT COUNT(*) AS n FROM instagib_market WHERE seller_id = ? AND state = 'active'`).get(playerId) as { n: number }).n;
    if (active >= MARKET.maxListings) return { ok: false, error: 'too_many_listings', need: MARKET.maxListings };
    const fee = listingFee(p);
    if (econState(playerId).credits < fee) return { ok: false, error: 'insufficient_fee', need: fee };
    const now = Date.now();
    addCredits(playerId, -fee); // non-refundable
    q(`UPDATE instagib_items SET state = 'listed', updated_at = ? WHERE uid = ?`).run(now, uid);
    unequipUids(playerId, [uid]);
    const info = q(`INSERT INTO instagib_market (uid, seller_id, price, created_at) VALUES (?, ?, ?, ?)`).run(uid, playerId, p, now);
    itemEvent(uid, 'list', playerId, '', { price: p, fee, listing: info.lastInsertRowid }, now);
    audit({ event: 'market.list', actorId: playerId, targetId: uid, detail: { def: r.def, price: p, fee, listing: Number(info.lastInsertRowid) } });
    const l = q(`SELECT * FROM instagib_market WHERE id = ?`).get(info.lastInsertRowid) as ListingRow;
    return { ok: true, listing: wireListing(l, getItemRow(uid)!), credits: econState(playerId).credits, fee };
  })();
}

export function unlistItem(playerId: string, id: unknown): MarketResult<{ item: ItemInstanceWire }> {
  if (!playerId) return { ok: false, error: 'guest' };
  if (!Number.isInteger(id)) return { ok: false, error: 'bad_request' };
  return sqlite.transaction((): MarketResult<{ item: ItemInstanceWire }> => {
    const l = q(`SELECT * FROM instagib_market WHERE id = ?`).get(id) as ListingRow | undefined;
    if (!l || l.state !== 'active') return { ok: false, error: 'not_active' };
    if (l.seller_id !== playerId) return { ok: false, error: 'not_yours' };
    const now = Date.now();
    q(`UPDATE instagib_market SET state = 'cancelled' WHERE id = ?`).run(l.id);
    q(`UPDATE instagib_items SET state = 'owned', updated_at = ? WHERE uid = ? AND state = 'listed'`).run(now, l.uid);
    itemEvent(l.uid, 'unlist', playerId, '', { listing: l.id }, now);
    audit({ event: 'market.unlist', actorId: playerId, targetId: l.uid, detail: { listing: l.id } });
    return { ok: true, item: toWire(getItemRow(l.uid)!) };
  })();
}

export function buyListing(playerId: string, id: unknown): MarketResult<{ item: ItemInstanceWire; price: number; credits: number }> {
  if (!playerId) return { ok: false, error: 'guest' };
  if (!Number.isInteger(id)) return { ok: false, error: 'bad_request' };
  return sqlite.transaction((): MarketResult<{ item: ItemInstanceWire; price: number; credits: number }> => {
    ensureOnboarded(playerId);
    const l = q(`SELECT * FROM instagib_market WHERE id = ?`).get(id) as ListingRow | undefined;
    if (!l || l.state !== 'active') return { ok: false, error: 'not_active' };
    if (l.seller_id === playerId) return { ok: false, error: 'own_listing' };
    const r = getItemRow(l.uid);
    if (!r || r.state !== 'listed' || r.owner_id !== l.seller_id) return { ok: false, error: 'not_active' };
    if (econState(playerId).credits < l.price) return { ok: false, error: 'insufficient', need: l.price };
    const now = Date.now();
    const tax = saleTax(l.price);
    addCredits(playerId, -l.price);
    addCredits(l.seller_id, l.price - tax); // the tax is burned
    q(`UPDATE instagib_items SET owner_id = ?, state = 'owned', origin = 'market', updated_at = ? WHERE uid = ?`).run(playerId, now, l.uid);
    q(`UPDATE instagib_market SET state = 'sold', buyer_id = ?, sold_at = ? WHERE id = ?`).run(playerId, now, l.id);
    unequipUids(l.seller_id, [l.uid]);
    itemEvent(l.uid, 'sale', l.seller_id, playerId, { price: l.price, tax, listing: l.id }, now);
    audit({
      event: 'market.sale',
      actorId: playerId,
      targetId: l.seller_id,
      detail: { listing: l.id, uid: l.uid, def: r.def, price: l.price, tax },
    });
    return { ok: true, item: toWire(getItemRow(l.uid)!), price: l.price, credits: econState(playerId).credits };
  })();
}

export type BrowseFilter = {
  slot?: string;
  tier?: string;
  quality?: string;
  effect?: string;
  q?: string;
  sort?: string;
  page?: number;
};

export function browse(f: BrowseFilter): { listings: ListingWire[]; page: number; pageSize: number; total: number } {
  const where: string[] = [`m.state = 'active'`];
  const args: unknown[] = [];
  const defIds = (pred: (d: (typeof ITEM_DEFS)[number]) => boolean): string[] => ITEM_DEFS.filter(pred).map((d) => d.id);
  if (f.slot) {
    const ids = defIds((d) => d.slot === (f.slot as ItemSlot));
    if (ids.length === 0) return { listings: [], page: 0, pageSize: PAGE_SIZE, total: 0 };
    where.push(`i.def IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (f.tier && (TIERS as readonly string[]).includes(f.tier)) {
    const ids = defIds((d) => d.tier === f.tier);
    // Admin one-offs may override the def's tier (attrs.tier).
    where.push(`(COALESCE(json_extract(i.attrs, '$.tier'), '') = ? OR (json_extract(i.attrs, '$.tier') IS NULL AND i.def IN (${ids.map(() => '?').join(',') || "''"})))`);
    args.push(f.tier, ...ids);
  }
  if (f.quality) {
    where.push(`i.quality LIKE ?`);
    args.push(`%"${f.quality.replace(/[^a-z]/g, '')}"%`);
  }
  if (f.effect) {
    where.push(`json_extract(i.attrs, '$.effect') = ?`);
    args.push(f.effect);
  }
  if (f.q) {
    const needle = f.q.toLowerCase().slice(0, 40);
    const ids = defIds((d) => d.name.toLowerCase().includes(needle) || d.id.includes(needle));
    if (ids.length === 0) return { listings: [], page: 0, pageSize: PAGE_SIZE, total: 0 };
    where.push(`i.def IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const order = f.sort === 'price_asc' ? 'm.price ASC, m.id DESC' : f.sort === 'price_desc' ? 'm.price DESC, m.id DESC' : 'm.id DESC';
  const from = `FROM instagib_market m JOIN instagib_items i ON i.uid = m.uid WHERE ${where.join(' AND ')}`;
  const total = (sqlite.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n;
  const page = Math.max(0, Math.min(10_000, Math.floor(f.page ?? 0)));
  const rows = sqlite
    .prepare(`SELECT m.id AS mid FROM instagib_market m JOIN instagib_items i ON i.uid = m.uid WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, PAGE_SIZE, page * PAGE_SIZE) as { mid: number }[];
  const listings: ListingWire[] = [];
  for (const { mid } of rows) {
    const l = q(`SELECT * FROM instagib_market WHERE id = ?`).get(mid) as ListingRow;
    const r = getItemRow(l.uid);
    if (r) listings.push(wireListing(l, r));
  }
  return { listings, page, pageSize: PAGE_SIZE, total };
}

export function myListings(playerId: string): { listings: ListingWire[]; recentSales: { id: number; price: number; def: string; soldAt: number; buyer: string }[] } {
  const rows = q(`SELECT * FROM instagib_market WHERE seller_id = ? AND state = 'active' ORDER BY id DESC`).all(playerId) as ListingRow[];
  const listings: ListingWire[] = [];
  for (const l of rows) {
    const r = getItemRow(l.uid);
    if (r) listings.push(wireListing(l, r));
  }
  const sold = q(
    `SELECT m.id, m.price, i.def, m.sold_at, m.buyer_id FROM instagib_market m JOIN instagib_items i ON i.uid = m.uid
      WHERE m.seller_id = ? AND m.state = 'sold' ORDER BY m.sold_at DESC LIMIT 20`,
  ).all(playerId) as { id: number; price: number; def: string; sold_at: number; buyer_id: string }[];
  return {
    listings,
    recentSales: sold.map((s) => ({ id: s.id, price: s.price, def: s.def, soldAt: s.sold_at, buyer: nameOf(s.buyer_id) })),
  };
}

export function priceHistory(def: string): { def: string; known: boolean; sales: { price: number; soldAt: number; quality: string[] }[]; suggested: number | null; floor: number | null } {
  const d = itemDef(def);
  const rows = q(
    `SELECT m.price, m.sold_at, i.quality FROM instagib_market m JOIN instagib_items i ON i.uid = m.uid
      WHERE m.state = 'sold' AND i.def = ? ORDER BY m.sold_at DESC, m.id DESC LIMIT 50`,
  ).all(def) as { price: number; sold_at: number; quality: string }[];
  const sales = rows.map((r) => {
    let quality: string[] = [];
    try {
      quality = JSON.parse(r.quality) as string[];
    } catch {
      /* corrupt row: show no quality */
    }
    return { price: r.price, soldAt: r.sold_at, quality };
  });
  // Suggested for the plain (no-quality) version of the def.
  return { def, known: !!d, sales, suggested: suggestedPrice(def, '[]'), floor: d ? priceFloor(d.tier) : null };
}
