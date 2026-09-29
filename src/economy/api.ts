// Economy REST client (docs/economy.md §10–11) + the response shapes as the
// server (server/economy-routes.ts) sends them. With `?mockEconomy=1`
// (sticky for the tab) every call is answered by an in-memory mock (./mock.ts)
// that mirrors the same shapes, so the screens can be developed and
// screenshotted without a server.
import type { CaseDef, CaseId, InboxMessageWire, ItemAttrs, ItemInstanceWire, ItemSlot, Loadout, Quality, RedeemCodeWire, RewardBundle, Tier } from '../game/items/types';

// slot → token: an instance uid, or `def:<id>` for a default / entitlement.
export type Equipped = Partial<Record<ItemSlot, string>>;

export type InventoryResp = {
  items: ItemInstanceWire[]; // owned + listed
  equipped: Equipped;
  looks: Loadout;
  credits: number;
  freeRolls: number;
  entitlements: string[]; // def ids equippable without an instance (cards, titles, defaults…)
};
export type EquipResp = { equipped: Equipped; looks: Loadout };
export type SalvageResp = { credits: number; gained: number; removed: string[] };

// GET /api/cases (public — guests too). `odds` are the EFFECTIVE tier odds
// (after empty-tier fallback) — show those; `nominalOdds` are the configured ones.
export type CaseInfo = Omit<CaseDef, 'odds'> & {
  odds: Record<Tier, number>;
  nominalOdds: Record<Tier, number>;
  pool: Record<Tier, number>; // defs per tier in this case
  qualityOdds: Partial<Record<'unusualHat' | 'unusualHatLegendaryPlus' | 'unusualEmote' | 'strange' | 'killstreak' | 'professional', number>>;
};
export type CasesResp = {
  cases: CaseInfo[];
  credits: number;
  freeRolls: number;
  dailyAvailable?: boolean; // the daily free standard-case open is ready (logged in only)
  nextDailyAt?: number; // ms — when it next is (0 = now)
  season?: { id: number; name: string };
};
// How an open is paid for: credits, a banked free roll, or today's daily free case.
export type CasePay = 'credits' | 'roll' | 'daily';
export type OpenCaseResp = { item: ItemInstanceWire; tier: Tier; credits: number; freeRolls: number; usedRoll: boolean; pay?: CasePay; nextDailyAt?: number };

export type Listing = {
  id: number;
  price: number;
  sellerId: string;
  seller: string;
  createdAt: number;
  item: ItemInstanceWire;
  tier: Tier;
  suggested: number | null; // median of the last 10 sales of the same def + quality
};
export type MarketQuery = {
  slot?: ItemSlot | '';
  tier?: Tier | '';
  quality?: Quality | '';
  effect?: string;
  q?: string;
  sort?: 'newest' | 'price_asc' | 'price_desc';
  page?: number; // 0-based
};
export type MarketResp = { listings: Listing[]; page: number; pageSize: number; total: number };
export type HistoryResp = {
  def: string;
  known: boolean;
  sales: { price: number; soldAt: number; quality: string[] }[]; // newest first
  suggested: number | null;
  floor: number | null;
};
export type ListResp = { listing: Listing; credits: number; fee: number };
export type BuyResp = { item: ItemInstanceWire; price: number; credits: number };
export type MineResp = { listings: Listing[]; recentSales: { id: number; price: number; def: string; soldAt: number; buyer: string }[] };

export type TradeState = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
// `give` = what the SENDER gives (the recipient receives it); `get` = what the
// sender asks for in return.
export type Trade = {
  id: number;
  fromId: string;
  from: string;
  toId: string;
  to: string;
  give: { items: ItemInstanceWire[]; credits: number };
  get: { items: ItemInstanceWire[]; credits: number };
  note: string;
  state: TradeState;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number;
};
// The gate reports the first unmet requirement (level → matches → age).
export type TradeGate = { ok: true } | { ok: false; reason: 'guest' | 'level' | 'matches' | 'age'; need?: number };
export type TradesResp = { incoming: Trade[]; outgoing: Trade[]; history: Trade[]; gate: TradeGate };
export type OfferBody = { to: string; giveItems: string[]; giveCredits: number; getItems: string[]; getCredits: number; note?: string };
export type PlayerInvResp = { name: string; items: ItemInstanceWire[]; canTrade: boolean };

export type AdminInvResp = {
  player: string;
  id?: string;
  credits: number;
  freeRolls: number;
  equipped: Equipped;
  items: ItemInstanceWire[];
};
export type MintBody = {
  player: string;
  def: string; // catalog def (its art) — a one-off adds custom attrs / tier on top
  quality?: Quality[];
  attrs?: ItemAttrs; // customName / customDesc / tint / effect / kills / sheen / ksEffect / seed / wear / nameTag / festive
  tier?: Tier; // override the def's tier (incl. unobtainable)
  bound?: boolean;
  count?: number; // 1–25
};
export type ItemEvent = { id: number; uid: string; ts: number; kind: string; from: string; to: string; meta: unknown };
export type ItemHistoryResp = { item: ItemInstanceWire; owner: string; events: ItemEvent[] };

// Redeem codes + inbox (docs/economy.md §7b).
export type Granted = { credits: number; rolls: number; items: ItemInstanceWire[] };
export type InboxSummary = { unread: number; unclaimed: number };
export type InboxResp = InboxSummary & { messages: InboxMessageWire[] };
export type ClaimResp = { message: InboxMessageWire; granted: Granted; credits: number; freeRolls: number };
export type RedeemResp = { code: string; granted: Granted; credits: number; freeRolls: number; messageId: number };
export type CreateCodeBody = { code?: string; reward: RewardBundle; maxUses?: number; expiresAt?: number; minLevel?: number; note?: string };
export type GiftBody = { player?: string; all?: boolean; title: string; body?: string; reward?: RewardBundle; expiresAt?: number };
export type Redemption = { player: string; at: number };
// Admin player lookup (the metrics players endpoint, trimmed to what a picker needs).
export type PlayerHit = { id: string; userName: string; level: number; lastSeen: number; admin?: boolean };

export type Res<T> = (T & { ok: true }) | { ok: false; status: number; reason?: string; error?: string; need?: number };

export function mockOn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('mockEconomy') === '1') {
      sessionStorage.setItem('ig-mock-economy', '1');
      return true;
    }
    return sessionStorage.getItem('ig-mock-economy') === '1';
  } catch {
    return false;
  }
}

async function real<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok && d.ok !== false) return { ...d, ok: true } as unknown as Res<T>;
    const code = typeof d.error === 'string' ? d.error : typeof d.reason === 'string' ? d.reason : undefined;
    return { ok: false, status: r.status, reason: code, error: code, need: typeof d.need === 'number' ? d.need : undefined };
  } catch {
    return { ok: false, status: 0, reason: 'network' };
  }
}

const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

type Mock = typeof import('./mock');
let mockMod: Promise<Mock> | null = null;
const mock = async (): Promise<Mock> => {
  // A failed dynamic import (dev-server hiccup) must not stick: retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      return await (mockMod ??= import('./mock'));
    } catch (err) {
      mockMod = null;
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
};

// One place that decides real vs mock, so every call site is a one-liner.
async function call<T>(method: 'GET' | 'POST', url: string, body: unknown, m: (mk: Mock) => Res<T> | Promise<Res<T>>): Promise<Res<T>> {
  if (mockOn()) return m(await mock());
  return real<T>(method, url, body);
}

export const econ = {
  inventory: () => call<InventoryResp>('GET', '/api/inventory', undefined, (m) => m.inventory()),
  // `token` = an owned instance uid, `def:<id>` (default / entitlement), or null (→ stock default).
  equip: (slot: ItemSlot, token: string | null) => call<EquipResp>('POST', '/api/inventory/equip', { slot, uid: token }, (m) => m.equip(slot, token)),
  salvage: (uids: string[]) => call<SalvageResp>('POST', '/api/inventory/salvage', { uids }, (m) => m.salvage(uids)),
  cases: () => call<CasesResp>('GET', '/api/cases', undefined, (m) => m.cases()),
  openCase: (caseId: CaseId, pay: CasePay) => call<OpenCaseResp>('POST', '/api/cases/open', { caseId, pay }, (m) => m.openCase(caseId, pay)),
  market: (q: MarketQuery) =>
    call<MarketResp>('GET', `/api/market${qs({ slot: q.slot, tier: q.tier, quality: q.quality, effect: q.effect, q: q.q, sort: q.sort, page: q.page })}`, undefined, (m) => m.market(q)),
  history: (def: string) => call<HistoryResp>('GET', `/api/market/history/${encodeURIComponent(def)}`, undefined, (m) => m.history(def)),
  list: (uid: string, price: number) => call<ListResp>('POST', '/api/market/list', { uid, price }, (m) => m.list(uid, price)),
  unlist: (id: Listing['id']) => call<{ item: ItemInstanceWire }>('POST', '/api/market/unlist', { id }, (m) => m.unlist(id)),
  buy: (id: Listing['id']) => call<BuyResp>('POST', '/api/market/buy', { id }, (m) => m.buy(id)),
  myListings: () => call<MineResp>('GET', '/api/market/mine', undefined, (m) => m.myListings()),
  trades: () => call<TradesResp>('GET', '/api/trades', undefined, (m) => m.trades()),
  offer: (b: OfferBody) => call<{ trade?: Trade }>('POST', '/api/trades/offer', b, (m) => m.offer(b)),
  tradeAct: (id: Trade['id'], act: 'accept' | 'decline' | 'cancel') => call<{ trade?: Trade }>('POST', `/api/trades/${id}/${act}`, {}, (m) => m.tradeAct(id, act)),
  playerInventory: (name: string) => call<PlayerInvResp>('GET', `/api/players/${encodeURIComponent(name)}/inventory`, undefined, (m) => m.playerInventory(name)),
  // Inbox + redeem codes (logged-in players)
  inbox: () => call<InboxResp>('GET', '/api/inbox', undefined, (m) => m.inbox()),
  inboxSummary: () => call<InboxSummary>('GET', '/api/inbox?summary=1', undefined, (m) => m.inboxSummary()),
  inboxRead: (id: number | 'all') => call<object>('POST', `/api/inbox/${id}/read`, {}, (m) => m.inboxRead(id)),
  inboxClaim: (id: number) => call<ClaimResp>('POST', `/api/inbox/${id}/claim`, {}, (m) => m.inboxClaim(id)),
  redeem: (code: string) => call<RedeemResp>('POST', '/api/codes/redeem', { code }, (m) => m.redeem(code)),
  // Admin (session-only routes)
  adminInventory: (player: string, all = false) =>
    call<AdminInvResp>('GET', `/api/admin/inventory/${encodeURIComponent(player)}${all ? '?all=1' : ''}`, undefined, (m) => m.adminInventory(player, all)),
  adminMint: (b: MintBody) => call<{ items: ItemInstanceWire[] }>('POST', '/api/admin/items/mint', b, (m) => m.adminMint(b)),
  adminRevoke: (uid: string, reason?: string) => call<{ item: ItemInstanceWire }>('POST', '/api/admin/items/revoke', { uid, reason }, (m) => m.adminRevoke(uid)),
  adminGrant: (player: string, credits?: number, rolls?: number) =>
    call<{ credits: number; freeRolls: number; username?: string }>('POST', '/api/admin/economy/grant', { player, credits, rolls }, (m) => m.adminGrant(player, credits, rolls)),
  adminHistory: (uid: string) => call<ItemHistoryResp>('GET', `/api/admin/items/${uid}/history`, undefined, (m) => m.adminHistory(uid)),
  adminCodes: () => call<{ codes: RedeemCodeWire[] }>('GET', '/api/admin/codes', undefined, (m) => m.adminCodes()),
  adminCreateCode: (b: CreateCodeBody) => call<{ code: RedeemCodeWire }>('POST', '/api/admin/codes', b, (m) => m.adminCreateCode(b)),
  adminCodeActive: (code: string, active: boolean) =>
    call<{ code: RedeemCodeWire }>('POST', `/api/admin/codes/${encodeURIComponent(code)}/active`, { active }, (m) => m.adminCodeActive(code, active)),
  adminCodeRedemptions: (code: string) =>
    call<{ redemptions: Redemption[] }>('GET', `/api/admin/codes/${encodeURIComponent(code)}/redemptions`, undefined, (m) => m.adminCodeRedemptions(code)),
  adminGift: (b: GiftBody) => call<{ sent: number }>('POST', '/api/admin/gifts', b, (m) => m.adminGift(b)),
  adminValidateReward: (reward: RewardBundle) => call<object>('POST', '/api/admin/rewards/validate', { reward }, (m) => m.adminValidateReward(reward)),
  adminFindPlayers: (q: string) =>
    call<{ players: PlayerHit[] }>('GET', `/api/admin/metrics/players${qs({ sort: 'recent', limit: 8, q })}`, undefined, (m) => m.adminFindPlayers(q)),
  adminAccountCount: () =>
    call<{ overview: { totalAccounts: number } }>('GET', '/api/admin/metrics/overview', undefined, (m) => m.adminAccountCount()),
};

// Where an error came from, for the codes that mean different things in
// different places (`not_found`, `level`, `expired`, `profanity`).
export type ReasonCtx = 'code' | 'inbox' | 'admin';

// Copy for an admin item-spec error (`item_<code>` inside a reward bundle, or
// the bare code from a direct mint). Null = not an item-spec error.
function itemSpecText(code: string): string | null {
  switch (code) {
    case 'unknown_def':
      return 'Unknown item — pick one from the catalog.';
    case 'not_an_item':
      return 'That item is a default or an unlock (card / title) — it can’t be minted.';
    case 'bad_effect':
      return 'Unknown unusual effect.';
    case 'bad_sheen':
      return 'Unknown killstreak sheen.';
    case 'bad_ksEffect':
      return 'Unknown professional killstreak effect.';
    case 'bad_tint':
      return 'Tint must be a #rrggbb colour.';
    case 'bad_tier':
      return 'Unknown tier.';
    case 'profanity_customName':
      return 'The custom name was flagged — keep it clean.';
    case 'profanity_customDesc':
      return 'The custom description was flagged — keep it clean.';
    case 'profanity_nameTag':
      return 'The name tag was flagged — keep it clean.';
    default:
      return null;
  }
}

// Human copy for the server's error codes.
export function reasonText(r: { status: number; reason?: string; error?: string; need?: number }, ctx?: ReasonCtx): string {
  const n = r.need != null ? r.need.toLocaleString() : '';
  const code = r.reason ?? r.error ?? '';
  // Codes whose meaning depends on the screen.
  if (ctx === 'code') {
    if (code === 'not_found') return 'That code doesn’t exist — check the spelling.';
    if (code === 'level') return `This code unlocks at Level ${r.need ?? '?'} — keep playing!`;
    if (code === 'expired') return 'This code has expired.';
  }
  if (ctx === 'inbox') {
    if (code === 'not_found') return 'That message is gone.';
    if (code === 'expired') return 'This gift has expired.';
  }
  if (ctx === 'admin' && code === 'profanity') return 'That text was flagged by the filter — reword it.';
  if (code.startsWith('item_')) {
    const t = itemSpecText(code.slice(5));
    if (t) return `Item: ${t}`;
  }
  const spec = itemSpecText(code);
  if (spec) return spec;
  switch (code) {
    // Redeem codes + inbox
    case 'already_redeemed':
      return 'You’ve already redeemed this code.';
    case 'used_up':
      return 'This code has been fully claimed — too slow this time.';
    case 'expired':
      return 'That has expired.';
    case 'inactive':
      return 'This code is no longer active.';
    case 'bad_code':
      return 'Codes are 3–32 letters, numbers and dashes.';
    case 'too_many_attempts':
      return 'Too many tries — wait a few minutes, then try again.';
    case 'claimed':
      return 'Already claimed — check your Locker.';
    case 'nothing':
      return 'Nothing to claim on this message.';
    case 'stale_reward':
      return 'This reward is out of date and couldn’t be granted — contact staff.';
    case 'empty_reward':
      return 'A reward needs credits, free rolls or at least one item.';
    case 'bad_credits':
      return 'Credits must be a whole number from 0 to 1,000,000.';
    case 'bad_rolls':
      return 'Free rolls must be a whole number from 0 to 1,000.';
    case 'bad_items':
      return 'Up to 10 items per reward.';
    case 'code_taken':
      return 'That code already exists — pick another.';
    case 'bad_max_uses':
      return 'Max uses must be 0 (unlimited) or a whole number.';
    case 'bad_expiry':
      return 'The expiry must be in the future.';
    case 'bad_min_level':
      return 'Min level must be a whole number from 0 to 1,000.';
    case 'no_title':
      return 'Give the message a title.';
    case 'bad_request':
      return 'That request was malformed.';
    case 'insufficient':
    case 'insufficient_fee':
      return r.need != null ? `Not enough credits (need ⛁ ${n}).` : 'Not enough credits.';
    case 'daily_used':
      return 'You’ve already opened today’s free case — it resets at 00:00 UTC.';
    case 'empty_pool':
      return 'This case is being restocked — try again shortly.';
    case 'partner_inbox_full':
      return 'That player has too many pending offers — try again later.';
    case 'no_rolls':
      return 'No free rolls left.';
    case 'roll_not_allowed':
      return 'Free rolls only open standard cases — the Vault needs credits.';
    case 'not_active':
    case 'not_owned':
    case 'item_unavailable':
    case 'offer_stale':
      return 'That item is no longer available.';
    case 'own_listing':
      return 'You can’t buy your own listing.';
    case 'below_floor':
      return `Price is below the floor (⛁ ${n}).`;
    case 'above_max':
      return `Price is above the maximum (⛁ ${n}).`;
    case 'too_many_listings':
      return `Listing limit reached (${n}).`;
    case 'bound':
    case 'item_bound':
      return 'Bound items can’t be traded or listed.';
    case 'not_salvageable':
      return 'That item can’t be salvaged.';
    case 'too_many_items':
      return `Up to ${n} items per side.`;
    case 'empty_offer':
      return 'An offer needs something in it.';
    case 'profanity':
      return 'Keep the note clean.';
    case 'no_player':
    case 'not_found':
      return 'Player not found.';
    case 'same_network':
      return 'You can’t trade with an account on your own network.';
    case 'seller_daily_cap':
      return 'This seller has hit today’s sales limit — try again later.';
    case 'self_trade':
      return 'You can’t trade with yourself.';
    case 'too_many_pending':
      return 'Too many pending offers — cancel one first.';
    case 'level':
    case 'gate_level':
      return `Trading and the market unlock at Level ${r.need ?? 5}.`;
    case 'matches':
    case 'gate_matches':
      return `Trading and the market need ${r.need ?? 10} recorded matches.`;
    case 'age':
    case 'gate_age':
      return 'Trading and the market unlock 24 h after account creation.';
    case 'gate_guest':
      return 'Log in to trade.';
    case 'guest':
      return 'Log in first.';
    case 'rate_limited':
      return 'Slow down a moment.';
    case 'network':
      return 'Network error.';
    default:
  }
  if ((r.reason ?? '').startsWith('partner_')) return 'The other player can’t trade yet (level / matches / account age).';
  if (r.status === 429) return 'Slow down a moment.';
  if (r.status === 401) return 'Log in first.';
  return 'That didn’t work.';
}
