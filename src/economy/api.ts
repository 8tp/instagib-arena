// Economy REST client (docs/economy.md §10) + the response shapes the UI
// codes against. With `?mockEconomy=1` (sticky for the tab) every call is
// answered by an in-memory mock (./mock.ts) instead of the server, so the
// screens can be developed and screenshotted without the server track.
import type { CaseDef, CaseId, ItemAttrs, ItemInstanceWire, ItemOrigin, ItemSlot, Quality, Tier } from '../game/items/types';

export type Equipped = Partial<Record<ItemSlot, string>>;

export type InventoryResp = { items: ItemInstanceWire[]; equipped: Equipped; credits: number; freeRolls: number };
export type EquipResp = { equipped: Equipped; looks: import('../game/items/types').Loadout };
export type SalvageResp = { credits: number; removed: string[] };

// GET /api/cases. `cases` is optional (the client has CASES). No pity: rates are
// fixed and published (CASES odds + QUALITY_ODDS), shown to everyone.
export type CasesResp = { cases?: CaseDef[]; freeRolls: number; credits: number };
export type OpenCaseResp = { item: ItemInstanceWire; tier: Tier; credits: number; freeRolls: number };

export type Listing = {
  id: number | string;
  item: ItemInstanceWire;
  price: number;
  seller: string;
  createdAt: number;
  suggested?: number; // median of the last 10 sales of the same def + quality
  mine?: boolean;
};
export type MarketQuery = {
  slot?: ItemSlot | '';
  tier?: Tier | '';
  quality?: Quality | '';
  effect?: string;
  q?: string;
  sort?: 'newest' | 'price-asc' | 'price-desc' | 'tier';
  page?: number;
};
export type MarketResp = { listings: Listing[]; total: number; page: number; pages: number };
export type HistoryResp = { def: string; sales: { ts: number; price: number; quality?: Quality[] }[]; suggested?: number };
export type ListResp = { listing?: Listing; fee: number; credits: number };
export type BuyResp = { item: ItemInstanceWire; credits: number };

export type TradeState = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
// `give` = what the SENDER gives (the recipient receives it); `get` = what the
// sender asks for in return.
export type Trade = {
  id: number | string;
  from: string; // sender name
  to: string; // recipient name
  give: ItemInstanceWire[];
  get: ItemInstanceWire[];
  giveCredits: number;
  getCredits: number;
  note?: string;
  state: TradeState;
  createdAt: number;
  expiresAt?: number;
  resolvedAt?: number;
};
export type TradeGate = { level: number; matches: number; accountAgeMs: number };
export type TradesResp = { incoming: Trade[]; outgoing: Trade[]; history?: Trade[]; me?: TradeGate; credits?: number };
export type OfferBody = { to: string; giveItems: string[]; giveCredits: number; getItems: string[]; getCredits: number; note?: string };
export type PlayerInvResp = { name: string; items: ItemInstanceWire[]; gate?: TradeGate };

export type AdminInvResp = {
  player: string;
  credits: number;
  freeRolls: number;
  level?: number;
  items: (ItemInstanceWire & { ownerState?: string })[];
};
export type MintBody = {
  player: string;
  def?: string; // catalog def …
  custom?: { name: string; desc?: string; slot: ItemSlot; tier: Tier; tint?: string; art?: string }; // … or a one-off
  quality?: Quality[];
  attrs?: ItemAttrs;
  bound?: boolean;
  origin?: ItemOrigin;
};
export type ItemEvent = { id: number | string; ts: number; kind: string; from?: string | null; to?: string | null; meta?: Record<string, unknown> };
export type ItemHistoryResp = { item: ItemInstanceWire; owner?: string; events: ItemEvent[] };

export type Res<T> = (T & { ok: true }) | { ok: false; status: number; reason?: string; error?: string };

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
    return { ok: false, status: r.status, reason: typeof d.reason === 'string' ? d.reason : undefined, error: typeof d.error === 'string' ? d.error : undefined };
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
const mock = (): Promise<Mock> => (mockMod ??= import('./mock'));

// One place that decides real vs mock, so every call site is a one-liner.
async function call<T>(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  m: (mk: Mock) => Res<T> | Promise<Res<T>>,
): Promise<Res<T>> {
  if (mockOn()) return m(await mock());
  return real<T>(method, url, body);
}

export const econ = {
  inventory: () => call<InventoryResp>('GET', '/api/inventory', undefined, (m) => m.inventory()),
  // `uid` = an owned instance (null → the slot's default); `id` = a level-unlocked
  // entitlement (player cards) by def id.
  equip: (slot: ItemSlot, uid: string | null, id?: string) =>
    call<EquipResp>('POST', '/api/inventory/equip', id ? { slot, id } : { slot, uid }, (m) => m.equip(slot, uid, id)),
  salvage: (uids: string[]) => call<SalvageResp>('POST', '/api/inventory/salvage', { uids }, (m) => m.salvage(uids)),
  cases: () => call<CasesResp>('GET', '/api/cases', undefined, (m) => m.cases()),
  openCase: (caseId: CaseId, useRoll: boolean) => call<OpenCaseResp>('POST', '/api/cases/open', { caseId, useRoll }, (m) => m.openCase(caseId, useRoll)),
  market: (q: MarketQuery) =>
    call<MarketResp>('GET', `/api/market${qs({ slot: q.slot, tier: q.tier, quality: q.quality, effect: q.effect, q: q.q, sort: q.sort, page: q.page })}`, undefined, (m) => m.market(q)),
  history: (def: string) => call<HistoryResp>('GET', `/api/market/history/${encodeURIComponent(def)}`, undefined, (m) => m.history(def)),
  list: (uid: string, price: number) => call<ListResp>('POST', '/api/market/list', { uid, price }, (m) => m.list(uid, price)),
  unlist: (id: Listing['id']) => call<{ credits?: number }>('POST', '/api/market/unlist', { id }, (m) => m.unlist(id)),
  buy: (id: Listing['id']) => call<BuyResp>('POST', '/api/market/buy', { id }, (m) => m.buy(id)),
  myListings: () => call<{ listings: Listing[] }>('GET', '/api/market/mine', undefined, (m) => m.myListings()),
  trades: () => call<TradesResp>('GET', '/api/trades', undefined, (m) => m.trades()),
  offer: (b: OfferBody) => call<{ trade?: Trade }>('POST', '/api/trades/offer', b, (m) => m.offer(b)),
  tradeAct: (id: Trade['id'], act: 'accept' | 'decline' | 'cancel') =>
    call<{ credits?: number }>('POST', `/api/trades/${id}/${act}`, {}, (m) => m.tradeAct(id, act)),
  playerInventory: (name: string) => call<PlayerInvResp>('GET', `/api/players/${encodeURIComponent(name)}/inventory`, undefined, (m) => m.playerInventory(name)),
  // Admin
  adminInventory: (player: string) => call<AdminInvResp>('GET', `/api/admin/inventory/${encodeURIComponent(player)}`, undefined, (m) => m.adminInventory(player)),
  adminMint: (b: MintBody) => call<{ item: ItemInstanceWire }>('POST', '/api/admin/items/mint', b, (m) => m.adminMint(b)),
  adminRevoke: (uid: string, reason?: string) => call<{ done?: boolean }>('POST', '/api/admin/items/revoke', { uid, reason }, (m) => m.adminRevoke(uid)),
  adminGrant: (player: string, credits?: number, rolls?: number) =>
    call<{ credits: number; freeRolls: number }>('POST', '/api/admin/grant', { player, credits, rolls }, (m) => m.adminGrant(player, credits, rolls)),
  adminHistory: (uid: string) => call<ItemHistoryResp>('GET', `/api/admin/items/${uid}/history`, undefined, (m) => m.adminHistory(uid)),
};

// Human copy for the common failure reasons (server reasons are best-effort).
export function reasonText(r: { status: number; reason?: string; error?: string }): string {
  switch (r.reason) {
    case 'insufficient':
    case 'credits':
      return 'Not enough credits.';
    case 'no-rolls':
      return 'No free rolls left.';
    case 'gone':
    case 'sold':
      return 'That item is no longer available.';
    case 'own':
      return 'You can’t buy your own listing.';
    case 'price':
      return 'That price is out of range.';
    case 'limit':
      return 'Listing limit reached.';
    case 'level':
      return 'Trading needs a higher level.';
    case 'matches':
      return 'Trading needs more recorded matches.';
    case 'age':
      return 'Trading unlocks 24 h after account creation.';
    case 'bound':
      return 'Bound items can’t be traded or listed.';
    case 'network':
      return 'Network error.';
    default:
  }
  if (r.status === 429) return 'Slow down a moment.';
  if (r.status === 401) return 'Log in first.';
  return r.error || 'That didn’t work.';
}
