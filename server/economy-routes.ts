// REST surface of the v3 economy (docs/economy.md §10). Mounted at /api.
// Cookie auth (the account id IS the identity); every write is rate-limited and
// runs in one DB transaction (economy.ts / market.ts / trades.ts).

import { Router, type Request, type Response } from 'express';
import { accountId } from './auth';
import { allowPost, rateKeyFor } from './stats';
import {
  casesInfo,
  ensureOnboarded,
  equipSlot,
  nextDailyCaseAt,
  econState,
  getInventory,
  openCase,
  publicInventory,
  q,
  salvageItems,
} from './economy';
import { browse, buyListing, listItem, myListings, netHash, priceHistory, unlistItem } from './market';
import { claimMessage, inboxCounts, inboxOf, markRead, redeemCode } from './rewards';
import { acceptTrade, cancelTrade, createOffer, declineTrade, listTrades, tradeGate } from './trades';

export const economyRouter = Router();

// Rate-limit + auth guard for writes. Returns the account id, or '' after
// having answered (429 / 401).
function writer(req: Request, res: Response): string {
  if (!allowPost(rateKeyFor(req), Date.now())) {
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return '';
  }
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ ok: false, error: 'guest' });
    return '';
  }
  return id;
}

function reader(req: Request, res: Response): string {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ ok: false, error: 'guest' });
    return '';
  }
  return id;
}

// Read limiter for the public / expensive GETs (market browse + history, player
// inventories, trades). Fixed 10 s window per IP — plenty for a human flicking
// filters, but a script can't pin the event loop that runs the game tick.
const READ_WINDOW_MS = 10_000;
const READ_MAX = 40;
const readHits = new Map<string, { start: number; n: number }>();
function allowRead(req: Request, res: Response): boolean {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const h = readHits.get(key);
  if (!h || now - h.start >= READ_WINDOW_MS) {
    readHits.set(key, { start: now, n: 1 });
    return true;
  }
  if (++h.n <= READ_MAX) return true;
  res.status(429).json({ ok: false, error: 'rate_limited' });
  return false;
}
const readSweep = setInterval(() => {
  const cutoff = Date.now() - READ_WINDOW_MS;
  for (const [k, h] of readHits) if (h.start < cutoff) readHits.delete(k);
}, 60_000);
readSweep.unref?.();

const send = (res: Response, r: { ok: boolean; error?: string }): void => {
  res.status(r.ok ? 200 : r.error === 'guest' ? 401 : r.error === 'not_found' ? 404 : 400).json(r);
};
const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── Inventory ────────────────────────────────────────────────────────────────
economyRouter.get('/inventory', (req, res) => {
  const id = accountId(req);
  res.json(getInventory(id));
});

economyRouter.post('/inventory/equip', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const b = body(req);
  if (b.uid != null && typeof b.uid !== 'string') {
    res.status(400).json({ ok: false, error: 'bad_request' });
    return;
  }
  send(res, equipSlot(id, b.slot, b.uid == null ? null : b.uid));
});

economyRouter.post('/inventory/salvage', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const list = body(req).uids;
  send(res, salvageItems(id, Array.isArray(list) ? list.map(str) : []));
});

// ── Cases ────────────────────────────────────────────────────────────────────
// Public: tier odds + quality odds are published to every player, guests included.
economyRouter.get('/cases', (req, res) => {
  const id = accountId(req);
  if (id) ensureOnboarded(id);
  const next = id ? nextDailyCaseAt(id) : 0;
  res.json({
    ...casesInfo(),
    ...(id ? econState(id) : { credits: 0, freeRolls: 0 }),
    dailyAvailable: !!id && next === 0, // one free standard-case open per UTC day
    nextDailyAt: next,
  });
});

economyRouter.post('/cases/open', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const b = body(req);
  // `pay`: 'credits' | 'roll' | 'daily' (legacy clients send useRoll).
  const pay = b.pay === 'daily' || b.pay === 'roll' || b.pay === 'credits' ? b.pay : b.useRoll === true ? 'roll' : 'credits';
  send(res, openCase(id, str(b.caseId), pay));
});

// ── Inbox + redeem codes ─────────────────────────────────────────────────────
economyRouter.get('/inbox', (req, res) => {
  const id = reader(req, res);
  if (!id) return;
  res.json(req.query.summary === '1' ? inboxCounts(id) : inboxOf(id));
});
economyRouter.post('/inbox/:id/read', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const raw = str(req.params.id);
  send(res, markRead(id, raw === 'all' ? 'all' : parseInt(raw, 10)));
});
economyRouter.post('/inbox/:id/claim', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  try {
    send(res, claimMessage(id, parseInt(str(req.params.id), 10)));
  } catch (err) {
    console.error('[inbox] claim failed', err);
    res.status(400).json({ ok: false, error: 'stale_reward' });
  }
});
economyRouter.post('/codes/redeem', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  try {
    send(res, redeemCode(id, body(req).code, rateKeyFor(req) + '|' + (req.ip ?? '')));
  } catch (err) {
    console.error('[codes] redeem failed', err);
    res.status(400).json({ ok: false, error: 'stale_reward' });
  }
});

// ── Market ───────────────────────────────────────────────────────────────────
economyRouter.get('/market', (req, res) => {
  if (!allowRead(req, res)) return;
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  res.json(
    browse({
      slot: s(req.query.slot),
      tier: s(req.query.tier),
      quality: s(req.query.quality),
      effect: s(req.query.effect),
      q: s(req.query.q),
      sort: s(req.query.sort),
      page: parseInt(str(req.query.page), 10) || 0,
    }),
  );
});

economyRouter.get('/market/history/:def', (req, res) => {
  if (!allowRead(req, res)) return;
  res.json(priceHistory(str(req.params.def).slice(0, 60)));
});

economyRouter.get('/market/mine', (req, res) => {
  if (!allowRead(req, res)) return;
  const id = reader(req, res);
  if (!id) return;
  res.json(myListings(id));
});

economyRouter.post('/market/list', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const b = body(req);
  send(res, listItem(id, str(b.uid), b.price, netHash(req.ip)));
});
economyRouter.post('/market/unlist', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  send(res, unlistItem(id, body(req).id));
});
economyRouter.post('/market/buy', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  send(res, buyListing(id, body(req).id, netHash(req.ip)));
});

// ── Trades ───────────────────────────────────────────────────────────────────
economyRouter.get('/trades', (req, res) => {
  if (!allowRead(req, res)) return;
  const id = reader(req, res);
  if (!id) return;
  res.json(listTrades(id));
});
economyRouter.post('/trades/offer', (req, res) => {
  const id = writer(req, res);
  if (!id) return;
  const b = body(req);
  send(res, createOffer(id, { to: str(b.to), giveItems: b.giveItems, giveCredits: b.giveCredits, getItems: b.getItems, getCredits: b.getCredits, note: b.note }));
});
for (const [action, fn] of [
  ['accept', acceptTrade],
  ['decline', declineTrade],
  ['cancel', cancelTrade],
] as const) {
  economyRouter.post(`/trades/:id/${action}`, (req, res) => {
    const id = writer(req, res);
    if (!id) return;
    send(res, fn(id, parseInt(str(req.params.id), 10)));
  });
}

// Public: another player's tradable, unlisted instances (for building an offer)
// plus whether they pass the trade gates.
economyRouter.get('/players/:name/inventory', (req, res) => {
  if (!allowRead(req, res)) return;
  const row = q(`SELECT id, username FROM instagib_users WHERE username_lower = ?`).get(str(req.params.name).toLowerCase()) as
    | { id: string; username: string }
    | undefined;
  if (!row) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  ensureOnboarded(row.id);
  res.json({ name: row.username, items: publicInventory(row.id), canTrade: tradeGate(row.id).ok });
});
