// Direct trade offers (docs/economy.md §5). Offers are immutable; accept
// re-validates every item + credit and swaps atomically; offers expire after 48 h.

import { sqlite } from './sqlite';
import { containsProfanity } from './profanity';
import { levelForXp } from '../src/game/progression';
import { TRADE, type ItemInstanceWire } from '../src/game/items/types';
import { addCredits, audit, econState, ensureOnboarded, getItemRow, itemEvent, q, toWire, unequipUids } from './economy';

export type TradeGate = { ok: true } | { ok: false; reason: 'guest' | 'level' | 'matches' | 'age'; need?: number };

// Both sides of a trade must be logged in, level ≥ 5, ≥ 10 recorded matches and
// an account ≥ 24 h old.
export function tradeGate(playerId: string, now = Date.now()): TradeGate {
  if (!playerId) return { ok: false, reason: 'guest' };
  const s = q(`SELECT total_xp, total_games FROM instagib_stats WHERE player_id = ?`).get(playerId) as { total_xp: number; total_games: number } | undefined;
  const u = q(`SELECT created_at FROM instagib_users WHERE id = ?`).get(playerId) as { created_at: number } | undefined;
  if (!u) return { ok: false, reason: 'guest' };
  if (levelForXp(s?.total_xp ?? 0) < TRADE.minLevel) return { ok: false, reason: 'level', need: TRADE.minLevel };
  if ((s?.total_games ?? 0) < TRADE.minMatches) return { ok: false, reason: 'matches', need: TRADE.minMatches };
  if (now - u.created_at < TRADE.minAccountAgeMs) return { ok: false, reason: 'age', need: TRADE.minAccountAgeMs };
  return { ok: true };
}

type TradeRow = {
  id: number;
  from_id: string;
  to_id: string;
  give: string;
  get: string;
  give_credits: number;
  get_credits: number;
  note: string;
  state: string;
  created_at: number;
  resolved_at: number;
};

export type TradeWire = {
  id: number;
  fromId: string;
  from: string;
  toId: string;
  to: string;
  give: { items: ItemInstanceWire[]; credits: number }; // what the sender gives
  get: { items: ItemInstanceWire[]; credits: number }; // what the sender asks for
  note: string;
  state: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt: number;
  resolvedAt: number;
};

const nameOf = (id: string): string =>
  (q(`SELECT username FROM instagib_users WHERE id = ?`).get(id) as { username: string } | undefined)?.username ?? 'Player';
const uids = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const itemsOf = (list: string[]): ItemInstanceWire[] => list.map((u) => getItemRow(u)).filter((r): r is NonNullable<typeof r> => !!r).map(toWire);

function wireTrade(t: TradeRow): TradeWire {
  return {
    id: t.id,
    fromId: t.from_id,
    from: nameOf(t.from_id),
    toId: t.to_id,
    to: nameOf(t.to_id),
    give: { items: itemsOf(uids(t.give)), credits: t.give_credits },
    get: { items: itemsOf(uids(t.get)), credits: t.get_credits },
    note: t.note,
    state: t.state as TradeWire['state'],
    createdAt: t.created_at,
    expiresAt: t.created_at + TRADE.expiryMs,
    resolvedAt: t.resolved_at,
  };
}

export function sweepExpiredTrades(now = Date.now()): number {
  return q(`UPDATE instagib_trades SET state = 'expired', resolved_at = ? WHERE state = 'pending' AND created_at <= ?`).run(now, now - TRADE.expiryMs).changes;
}

// Accepted trades + credits moved in the trailing 24 h for one account.
function dailyUsage(playerId: string, now: number): { trades: number; credits: number } {
  const r = q(
    `SELECT COUNT(*) AS n, COALESCE(SUM(give_credits + get_credits), 0) AS c FROM instagib_trades
      WHERE state = 'accepted' AND resolved_at >= ? AND (from_id = ? OR to_id = ?)`,
  ).get(now - 24 * 3600_000, playerId, playerId) as { n: number; c: number };
  return { trades: r.n, credits: r.c };
}

export type TradeResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; need?: number; uid?: string };

export type OfferInput = { to: string; giveItems: unknown; giveCredits: unknown; getItems: unknown; getCredits: unknown; note?: unknown };

const cleanUids = (v: unknown): string[] | null => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 40)) return null;
  return [...new Set(v as string[])];
};
const cleanCredits = (v: unknown): number | null => {
  if (v == null || v === '') return 0;
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= TRADE.maxCreditsPerDay ? (v as number) : null;
};

// Every item on a side must belong to that side, be `owned`, and be tradable.
function checkItems(owner: string, list: string[]): { ok: true } | { ok: false; error: string; uid: string } {
  for (const uid of list) {
    const r = getItemRow(uid);
    if (!r || r.owner_id !== owner || r.state !== 'owned') return { ok: false, error: 'item_unavailable', uid };
    if (!r.tradable) return { ok: false, error: 'item_bound', uid };
  }
  return { ok: true };
}

export function createOffer(fromId: string, o: OfferInput): TradeResult<{ trade: TradeWire }> {
  if (!fromId) return { ok: false, error: 'guest' };
  const give = cleanUids(o.giveItems);
  const get = cleanUids(o.getItems);
  const giveCredits = cleanCredits(o.giveCredits);
  const getCredits = cleanCredits(o.getCredits);
  if (!give || !get || giveCredits == null || getCredits == null) return { ok: false, error: 'bad_request' };
  if (give.length > TRADE.maxItemsPerSide || get.length > TRADE.maxItemsPerSide) return { ok: false, error: 'too_many_items', need: TRADE.maxItemsPerSide };
  if (give.length + get.length + giveCredits + getCredits === 0) return { ok: false, error: 'empty_offer' };
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 140) : '';
  if (note && containsProfanity(note)) return { ok: false, error: 'profanity' };
  const target = typeof o.to === 'string' ? (q(`SELECT id FROM instagib_users WHERE username_lower = ?`).get(o.to.trim().toLowerCase()) as { id: string } | undefined) : undefined;
  if (!target) return { ok: false, error: 'no_player' };
  if (target.id === fromId) return { ok: false, error: 'self_trade' };
  return sqlite.transaction((): TradeResult<{ trade: TradeWire }> => {
    ensureOnboarded(fromId);
    ensureOnboarded(target.id);
    sweepExpiredTrades();
    const now = Date.now();
    const g1 = tradeGate(fromId, now);
    if (!g1.ok) return { ok: false, error: `gate_${g1.reason}`, need: g1.need };
    const g2 = tradeGate(target.id, now);
    if (!g2.ok) return { ok: false, error: `partner_gate_${g2.reason}`, need: g2.need };
    const c1 = checkItems(fromId, give);
    if (!c1.ok) return c1;
    const c2 = checkItems(target.id, get);
    if (!c2.ok) return { ok: false, error: 'partner_' + c2.error, uid: c2.uid };
    if (econState(fromId).credits < giveCredits) return { ok: false, error: 'insufficient', need: giveCredits };
    const pending = (q(`SELECT COUNT(*) AS n FROM instagib_trades WHERE from_id = ? AND state = 'pending'`).get(fromId) as { n: number }).n;
    if (pending >= 10) return { ok: false, error: 'too_many_pending', need: 10 };
    const info = q(
      `INSERT INTO instagib_trades (from_id, to_id, give, get, give_credits, get_credits, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fromId, target.id, JSON.stringify(give), JSON.stringify(get), giveCredits, getCredits, note, now);
    audit({ event: 'trade.offer', actorId: fromId, targetId: target.id, detail: { trade: Number(info.lastInsertRowid), give, get, giveCredits, getCredits } });
    return { ok: true, trade: wireTrade(q(`SELECT * FROM instagib_trades WHERE id = ?`).get(info.lastInsertRowid) as TradeRow) };
  })();
}

function loadPending(id: unknown): TradeRow | null {
  if (!Number.isInteger(id)) return null;
  sweepExpiredTrades();
  const t = q(`SELECT * FROM instagib_trades WHERE id = ?`).get(id) as TradeRow | undefined;
  return t ?? null;
}

export function acceptTrade(playerId: string, id: unknown): TradeResult<{ trade: TradeWire; credits: number }> {
  if (!playerId) return { ok: false, error: 'guest' };
  return sqlite.transaction((): TradeResult<{ trade: TradeWire; credits: number }> => {
    const t = loadPending(id);
    if (!t) return { ok: false, error: 'not_found' };
    if (t.state !== 'pending') return { ok: false, error: t.state === 'expired' ? 'expired' : 'not_pending' };
    if (t.to_id !== playerId) return { ok: false, error: 'not_recipient' };
    const now = Date.now();
    ensureOnboarded(playerId);
    // Re-validate everything at accept time (gates, ownership, balances, daily limits).
    for (const pid of [t.from_id, t.to_id]) {
      const g = tradeGate(pid, now);
      if (!g.ok) return { ok: false, error: `${pid === playerId ? '' : 'partner_'}gate_${g.reason}`, need: g.need };
      const u = dailyUsage(pid, now);
      if (u.trades >= TRADE.maxTradesPerDay) return { ok: false, error: pid === playerId ? 'daily_trades' : 'partner_daily_trades', need: TRADE.maxTradesPerDay };
      if (u.credits + t.give_credits + t.get_credits > TRADE.maxCreditsPerDay && t.give_credits + t.get_credits > 0)
        return { ok: false, error: pid === playerId ? 'daily_credits' : 'partner_daily_credits', need: TRADE.maxCreditsPerDay };
    }
    const give = uids(t.give);
    const get = uids(t.get);
    const c1 = checkItems(t.from_id, give);
    if (!c1.ok) return { ok: false, error: 'offer_stale', uid: c1.uid };
    const c2 = checkItems(t.to_id, get);
    if (!c2.ok) return { ok: false, error: 'offer_stale', uid: c2.uid };
    if (econState(t.from_id).credits < t.give_credits) return { ok: false, error: 'offer_stale' };
    if (econState(t.to_id).credits < t.get_credits) return { ok: false, error: 'insufficient', need: t.get_credits };
    // Swap.
    const move = q(`UPDATE instagib_items SET owner_id = ?, origin = 'trade', updated_at = ? WHERE uid = ?`);
    for (const uid of give) {
      move.run(t.to_id, now, uid);
      itemEvent(uid, 'trade', t.from_id, t.to_id, { trade: t.id }, now);
    }
    for (const uid of get) {
      move.run(t.from_id, now, uid);
      itemEvent(uid, 'trade', t.to_id, t.from_id, { trade: t.id }, now);
    }
    unequipUids(t.from_id, give);
    unequipUids(t.to_id, get);
    if (t.give_credits || t.get_credits) {
      addCredits(t.from_id, t.get_credits - t.give_credits);
      addCredits(t.to_id, t.give_credits - t.get_credits);
    }
    q(`UPDATE instagib_trades SET state = 'accepted', resolved_at = ? WHERE id = ?`).run(now, t.id);
    audit({ event: 'trade.accept', actorId: playerId, targetId: t.from_id, detail: { trade: t.id, give, get, giveCredits: t.give_credits, getCredits: t.get_credits } });
    return { ok: true, trade: wireTrade(q(`SELECT * FROM instagib_trades WHERE id = ?`).get(t.id) as TradeRow), credits: econState(playerId).credits };
  })();
}

function resolveTrade(playerId: string, id: unknown, who: 'to' | 'from', state: 'declined' | 'cancelled'): TradeResult<{ trade: TradeWire }> {
  if (!playerId) return { ok: false, error: 'guest' };
  return sqlite.transaction((): TradeResult<{ trade: TradeWire }> => {
    const t = loadPending(id);
    if (!t) return { ok: false, error: 'not_found' };
    if (t.state !== 'pending') return { ok: false, error: t.state === 'expired' ? 'expired' : 'not_pending' };
    if ((who === 'to' ? t.to_id : t.from_id) !== playerId) return { ok: false, error: who === 'to' ? 'not_recipient' : 'not_sender' };
    q(`UPDATE instagib_trades SET state = ?, resolved_at = ? WHERE id = ?`).run(state, Date.now(), t.id);
    audit({ event: `trade.${state}`, actorId: playerId, targetId: who === 'to' ? t.from_id : t.to_id, detail: { trade: t.id } });
    return { ok: true, trade: wireTrade(q(`SELECT * FROM instagib_trades WHERE id = ?`).get(t.id) as TradeRow) };
  })();
}
export const declineTrade = (playerId: string, id: unknown) => resolveTrade(playerId, id, 'to', 'declined');
export const cancelTrade = (playerId: string, id: unknown) => resolveTrade(playerId, id, 'from', 'cancelled');

export function listTrades(playerId: string): { incoming: TradeWire[]; outgoing: TradeWire[]; history: TradeWire[]; gate: TradeGate } {
  sweepExpiredTrades();
  const rows = (sql: string, ...a: unknown[]) => (q(sql).all(...a) as TradeRow[]).map(wireTrade);
  return {
    incoming: rows(`SELECT * FROM instagib_trades WHERE to_id = ? AND state = 'pending' ORDER BY id DESC`, playerId),
    outgoing: rows(`SELECT * FROM instagib_trades WHERE from_id = ? AND state = 'pending' ORDER BY id DESC`, playerId),
    history: rows(`SELECT * FROM instagib_trades WHERE (from_id = ? OR to_id = ?) AND state != 'pending' ORDER BY id DESC LIMIT 30`, playerId, playerId),
    gate: tradeGate(playerId),
  };
}

let sweepTimer: NodeJS.Timeout | null = null;
// Expire stale offers every minute (also swept lazily on every trade call).
export function startTradeSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepExpiredTrades();
    } catch (err) {
      console.error('[trades] sweep failed', err);
    }
  }, 60_000);
  sweepTimer.unref?.();
}
