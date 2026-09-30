// Inventory & economy v3 — server core (docs/economy.md).
//
// Tables, the one-time reset + onboarding migration, item minting, entitlements
// (cards / titles / announcers are level- or achievement-earned, never items),
// equip-by-uid, resolved Looks, salvage, cases, strange counters and the admin
// operations. Market and trading live in market.ts / trades.ts.
//
// Layering: this module imports ONLY ./sqlite (never ./db), so db.ts can import
// it without a cycle; db.ts calls initEconomy() once at boot with the two hooks
// this module needs (audit log + admin lookup). Every statement is prepared
// lazily (see `q`) because the tables it touches are created by db.ts / here.

import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import type { Statement } from 'better-sqlite3';
import { databasePath, sqlite } from './sqlite';
import { ensureRewardsSchema } from './rewards';
import { containsProfanity } from './profanity';
import { ALL_COSMETICS, titleGrantsFrom } from '../src/game/cosmetics';
import { levelForXp, roadRewardKind, roadStepsBetween, type RoadStep } from '../src/game/progression';
import {
  CASES,
  CURRENT_SEASON,
  ITEM_SLOTS,
  KS_EFFECTS,
  KS_SHEENS,
  ONBOARDING,
  QUALITY_ODDS,
  TIER_META,
  TIERS,
  UNUSUAL_EFFECTS,
  slotAllows,
  nextUtcMidnight,
  seasonName,
  utcDayKey,
  type CaseDef,
  type CaseId,
  type ItemAttrs,
  type ItemInstanceWire,
  type ItemOrigin,
  type ItemSlot,
  type ItemState,
  type Loadout,
  type Look,
  type Quality,
  type SlotAttr,
  type Tier,
} from '../src/game/items/types';
import { DEFAULT_LOADOUT, ITEM_DEFS, casePoolFor, itemDef, vaultUnobtainables, type ItemDef } from '../src/game/items/catalog';

// ── Hooks (set by db.ts) ─────────────────────────────────────────────────────
export type AuditInput = {
  event: string;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  now?: number;
};
type Hooks = { logEvent: (e: AuditInput) => void; isAdmin: (playerId: string) => boolean };
let hooks: Hooks = { logEvent: () => {}, isAdmin: () => false };
export const audit = (e: AuditInput): void => hooks.logEvent(e);
export const isAdminAccount = (id: string): boolean => !!id && hooks.isAdmin(id);

// ── Lazy prepared statements ─────────────────────────────────────────────────
const stmtCache = new Map<string, Statement<any[]>>();
export function q(sql: string): Statement<any[]> {
  let s = stmtCache.get(sql);
  if (!s) {
    s = sqlite.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

// ── Schema ───────────────────────────────────────────────────────────────────
// Slots whose entries are ENTITLEMENTS (owned-def set computed from level /
// achievements / staff flag / legacy purchases), never minted instances.
const ENTITLEMENT_SLOTS: ReadonlySet<ItemSlot> = new Set<ItemSlot>(['card', 'title']);

export function ensureEconomySchema(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_items (
  uid        TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  def        TEXT NOT NULL,
  mint       INTEGER NOT NULL,
  quality    TEXT NOT NULL DEFAULT '[]',
  attrs      TEXT NOT NULL DEFAULT '{}',
  origin     TEXT NOT NULL,
  tradable   INTEGER NOT NULL DEFAULT 1,
  state      TEXT NOT NULL DEFAULT 'owned',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_owner ON instagib_items(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_items_def ON instagib_items(def);
CREATE TABLE IF NOT EXISTS instagib_item_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uid     TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  from_id TEXT NOT NULL DEFAULT '',
  to_id   TEXT NOT NULL DEFAULT '',
  meta    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_item_events_uid ON instagib_item_events(uid, id);
CREATE TABLE IF NOT EXISTS instagib_mint_counters (
  def  TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instagib_market (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  uid       TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  price     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state     TEXT NOT NULL DEFAULT 'active',
  buyer_id  TEXT NOT NULL DEFAULT '',
  sold_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_market_state ON instagib_market(state, price);
CREATE INDEX IF NOT EXISTS idx_market_seller ON instagib_market(seller_id, state);
CREATE INDEX IF NOT EXISTS idx_market_uid ON instagib_market(uid);
CREATE TABLE IF NOT EXISTS instagib_trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id      TEXT NOT NULL,
  to_id        TEXT NOT NULL,
  give         TEXT NOT NULL DEFAULT '[]',
  get          TEXT NOT NULL DEFAULT '[]',
  give_credits INTEGER NOT NULL DEFAULT 0,
  get_credits  INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trades_from ON instagib_trades(from_id, state);
CREATE INDEX IF NOT EXISTS idx_trades_to ON instagib_trades(to_id, state);
CREATE INDEX IF NOT EXISTS idx_trades_state_age ON instagib_trades(state, created_at);
CREATE INDEX IF NOT EXISTS idx_market_buyer ON instagib_market(buyer_id, state, sold_at);
CREATE INDEX IF NOT EXISTS idx_market_seller_sold ON instagib_market(seller_id, state, sold_at);
CREATE TABLE IF NOT EXISTS instagib_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(instagib_stats)`).all() as { name: string }[]).map((r) => r.name),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) sqlite.exec(`ALTER TABLE instagib_stats ADD COLUMN ${ddl}`);
  };
  add('free_rolls', 'free_rolls INTEGER NOT NULL DEFAULT 0');
  add('econ_v3', 'econ_v3 INTEGER NOT NULL DEFAULT 0');
  add('legacy_unlocked', `legacy_unlocked TEXT NOT NULL DEFAULT '[]'`);
  add('equipped_items', `equipped_items TEXT NOT NULL DEFAULT '{}'`);
  add('last_spin_day', `last_spin_day TEXT NOT NULL DEFAULT ''`); // retired Daily Spin (kept: column drops need a rebuild)
  add('last_daily_case', `last_daily_case TEXT NOT NULL DEFAULT ''`);
  // Listings carry their item's def + quality (snapshot at list time) so price
  // history / suggested prices are an index range, not a scan of every sale.
  const mcols = new Set((sqlite.prepare(`PRAGMA table_info(instagib_market)`).all() as { name: string }[]).map((r) => r.name));
  if (!mcols.has('def')) {
    sqlite.exec(`ALTER TABLE instagib_market ADD COLUMN def TEXT NOT NULL DEFAULT ''`);
    sqlite.exec(`ALTER TABLE instagib_market ADD COLUMN quality TEXT NOT NULL DEFAULT '[]'`);
    sqlite.exec(
      `UPDATE instagib_market SET def = COALESCE((SELECT def FROM instagib_items i WHERE i.uid = instagib_market.uid), ''),
                                  quality = COALESCE((SELECT quality FROM instagib_items i WHERE i.uid = instagib_market.uid), '[]')`,
    );
  }
  if (!mcols.has('seller_net')) sqlite.exec(`ALTER TABLE instagib_market ADD COLUMN seller_net TEXT NOT NULL DEFAULT ''`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_market_price_hist ON instagib_market(def, quality, state, sold_at)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_market_def_hist ON instagib_market(def, state, sold_at)`);
}

// ── Small helpers ────────────────────────────────────────────────────────────
const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function newUid(): string {
  return randomBytes(9).toString('base64url'); // 12 chars
}

export function ensureStatsRow(playerId: string, now = Date.now()): void {
  q(
    `INSERT OR IGNORE INTO instagib_stats (player_id, user_name, created_at, updated_at)
     VALUES (?, COALESCE((SELECT username FROM instagib_users WHERE id = ?), 'Player'), ?, ?)`,
  ).run(playerId, playerId, now, now);
}

export type EconState = { credits: number; freeRolls: number };
export function econState(playerId: string): EconState {
  const r = q(`SELECT credits, free_rolls FROM instagib_stats WHERE player_id = ?`).get(playerId) as
    | { credits: number; free_rolls: number }
    | undefined;
  return { credits: r?.credits ?? 0, freeRolls: r?.free_rolls ?? 0 };
}

// Credits are only ever moved inside a caller's transaction with the balance
// checked first; these guard the column against going negative regardless.
export function addCredits(playerId: string, delta: number): boolean {
  if (!Number.isInteger(delta)) return false;
  ensureStatsRow(playerId);
  return (
    q(`UPDATE instagib_stats SET credits = credits + ? WHERE player_id = ? AND credits + ? >= 0`).run(delta, playerId, delta)
      .changes > 0
  );
}
export function addRolls(playerId: string, delta: number): boolean {
  if (!Number.isInteger(delta)) return false;
  ensureStatsRow(playerId);
  return (
    q(`UPDATE instagib_stats SET free_rolls = free_rolls + ? WHERE player_id = ? AND free_rolls + ? >= 0`).run(
      delta,
      playerId,
      delta,
    ).changes > 0
  );
}

// ── Item rows ────────────────────────────────────────────────────────────────
export type ItemRow = {
  uid: string;
  owner_id: string;
  def: string;
  mint: number;
  quality: string;
  attrs: string;
  origin: string;
  tradable: number;
  state: string;
  created_at: number;
  updated_at: number;
};
export type StoredAttrs = ItemAttrs & { tier?: Tier }; // admin one-offs may override the def tier

export function attrsOf(r: ItemRow): StoredAttrs {
  return json<StoredAttrs>(r.attrs, {});
}
export function tierOf(r: ItemRow): Tier {
  return attrsOf(r).tier ?? itemDef(r.def)?.tier ?? 'common';
}
export function toWire(r: ItemRow): ItemInstanceWire {
  const { tier, ...attrs } = attrsOf(r);
  const w: ItemInstanceWire = {
    uid: r.uid,
    def: r.def,
    mint: r.mint,
    quality: json<Quality[]>(r.quality, []),
    attrs,
    origin: r.origin as ItemOrigin,
    tradable: !!r.tradable,
    state: r.state as ItemState,
    createdAt: r.created_at,
  };
  if (tier) w.tier = tier;
  return w;
}

export const getItemRow = (uid: string): ItemRow | undefined =>
  q(`SELECT * FROM instagib_items WHERE uid = ?`).get(uid) as ItemRow | undefined;

export function itemEvent(uid: string, kind: string, fromId = '', toId = '', meta?: unknown, now = Date.now()): void {
  q(`INSERT INTO instagib_item_events (uid, ts, kind, from_id, to_id, meta) VALUES (?, ?, ?, ?, ?, ?)`).run(
    uid,
    now,
    kind,
    fromId,
    toId,
    meta == null ? '' : typeof meta === 'string' ? meta.slice(0, 1000) : JSON.stringify(meta).slice(0, 1000),
  );
}

export type MintOpts = {
  owner: string;
  def: string;
  quality?: Quality[];
  attrs?: StoredAttrs;
  origin: ItemOrigin;
  tradable?: boolean; // default: the def's flag
  actor?: string; // who caused the mint (admin id) — for the event row
  meta?: unknown;
  now?: number;
};

// Mint one instance (per-def serial "#N"), logged in item_events. Throws on an
// unknown def. Atomic on its own; also safe inside a caller's transaction.
export const mintItem = sqlite.transaction((o: MintOpts): ItemInstanceWire => {
  const def = itemDef(o.def);
  if (!def) throw new Error(`mint: unknown def ${o.def}`);
  const now = o.now ?? Date.now();
  q(`INSERT OR IGNORE INTO instagib_mint_counters (def, next) VALUES (?, 1)`).run(def.id);
  const mint = (q(`SELECT next FROM instagib_mint_counters WHERE def = ?`).get(def.id) as { next: number }).next;
  q(`UPDATE instagib_mint_counters SET next = next + 1 WHERE def = ?`).run(def.id);
  const tradable = o.tradable ?? def.tradable;
  let uid = newUid();
  while (getItemRow(uid)) uid = newUid();
  q(
    `INSERT INTO instagib_items (uid, owner_id, def, mint, quality, attrs, origin, tradable, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owned', ?, ?)`,
  ).run(uid, o.owner, def.id, mint, JSON.stringify(o.quality ?? []), JSON.stringify(o.attrs ?? {}), o.origin, tradable ? 1 : 0, now, now);
  itemEvent(uid, 'mint', o.actor ?? '', o.owner, { origin: o.origin, ...(o.meta && typeof o.meta === 'object' ? o.meta : {}) }, now);
  return toWire(getItemRow(uid)!);
});

// Mint a bound instance of `def` unless the account already holds a live one
// (road / staff grants are once-per-def). Returns the new instance or null.
export function grantBoundOnce(owner: string, defId: string, origin: ItemOrigin, quality: Quality[] = [], meta?: unknown): ItemInstanceWire | null {
  const have = q(`SELECT 1 FROM instagib_items WHERE owner_id = ? AND def = ? AND state IN ('owned','listed') AND tradable = 0 LIMIT 1`).get(
    owner,
    defId,
  );
  if (have) return null;
  return mintItem({ owner, def: defId, origin, tradable: false, quality, meta });
}

// ── Staff ("Sovereign") instances ────────────────────────────────────────────
// Admin-source cosmetics that are real instance slots. Cards / name colour /
// title are entitlements (see below); the wearables, gun and beam are minted.
export const STAFF_INSTANCE_DEFS: readonly string[] = (() => {
  const ids = new Set<string>(['hat.sovereign', 'back.sovereign', 'face.sovereign']);
  for (const c of ALL_COSMETICS) {
    if (c.source.type !== 'admin') continue;
    const d = itemDef(c.id);
    if (d && !d.tradable && !ENTITLEMENT_SLOTS.has(d.slot) && d.slot !== 'nameColor') ids.add(c.id);
  }
  return [...ids].filter((id) => !!itemDef(id));
})();

export function ensureStaffItems(playerId: string): ItemInstanceWire[] {
  return sqlite.transaction((): ItemInstanceWire[] => {
    const out: ItemInstanceWire[] = [];
    for (const id of STAFF_INSTANCE_DEFS) {
      const w = grantBoundOnce(playerId, id, 'admin', ['admin'], { staff: true });
      if (w) out.push(w);
    }
    return out;
  })();
}

// Demotion: staff items revert to nothing (state revoked, unequipped).
export function revokeStaffItems(playerId: string): number {
  return sqlite.transaction((): number => {
    const ph = STAFF_INSTANCE_DEFS.map(() => '?').join(',');
    const rows = q(
      `SELECT * FROM instagib_items WHERE owner_id = ? AND origin = 'admin' AND tradable = 0 AND state IN ('owned','listed') AND def IN (${ph})`,
    ).all(playerId, ...STAFF_INSTANCE_DEFS) as ItemRow[];
    for (const r of rows) revokeRow(r, '', 'staff demoted');
    return rows.length;
  })();
}

// ── Entitlements: cards / titles / announcers / staff name colour ────────────
type StatsForEnt = {
  total_xp: number;
  total_kills: number;
  headshots: number;
  total_wins: number;
  best_kill_streak: number;
  total_games: number;
  best_accuracy: number;
  legacy_unlocked: string;
};

function founderCutoff(): number {
  const r = q(`SELECT v FROM instagib_meta WHERE k = 'econ_v3_at'`).get() as { v: string } | undefined;
  return r ? Number(r.v) : Number.MAX_SAFE_INTEGER;
}

// Every def id this account may equip WITHOUT an instance: all defaults,
// level-gated cards / announcer packs, achievement titles (live from career
// stats), Founder (account predates the v3 deploy), staff-only card / title /
// name colour (live from is_admin), and — grandfathered — credit-priced cards /
// titles they had bought before the reset (legacy_unlocked).
export function entitlementsFor(playerId: string): Set<string> {
  const out = new Set<string>();
  for (const d of ITEM_DEFS) if (d.default) out.add(d.id);
  out.add('title.ranked');
  // A cosmetic whose source is 'default' but which is also a real (non-default)
  // item def — e.g. hat.cap, now a Common case hat — must be owned, not implied.
  for (const c of ALL_COSMETICS) {
    if (c.source.type !== 'default') continue;
    const d = itemDef(c.id);
    if (!d || d.default) out.add(c.id);
  }
  if (!playerId) return out;
  const s = q(
    `SELECT total_xp, total_kills, headshots, total_wins, best_kill_streak, total_games, best_accuracy, legacy_unlocked
       FROM instagib_stats WHERE player_id = ?`,
  ).get(playerId) as StatsForEnt | undefined;
  const level = levelForXp(s?.total_xp ?? 0);
  const admin = isAdminAccount(playerId);
  const legacy = new Set(json<string[]>(s?.legacy_unlocked, []));
  const earned = new Set(
    titleGrantsFrom({
      kills: s?.total_kills ?? 0,
      headshots: s?.headshots ?? 0,
      wins: s?.total_wins ?? 0,
      bestStreak: s?.best_kill_streak ?? 0,
      games: s?.total_games ?? 0,
      accuracy: s?.best_accuracy ?? 0,
    }),
  );
  for (const c of ALL_COSMETICS) {
    const d = itemDef(c.id);
    const entSlot = c.slot === 'announcer' || (d ? ENTITLEMENT_SLOTS.has(d.slot) : false) || (c.slot === 'nameColor' && c.source.type === 'admin');
    if (!entSlot) continue;
    switch (c.source.type) {
      case 'level':
        if (level >= c.source.level) out.add(c.id);
        break;
      case 'achievement':
        if (earned.has(c.id)) out.add(c.id);
        break;
      case 'admin':
        if (admin) out.add(c.id);
        break;
      case 'credits':
      case 'case':
        if (legacy.has(c.id)) out.add(c.id);
        break;
      default:
        break;
    }
  }
  const u = q(`SELECT created_at FROM instagib_users WHERE id = ?`).get(playerId) as { created_at: number } | undefined;
  if (u && u.created_at <= founderCutoff()) out.add('title.founder');
  return out;
}

// The set the legacy WS/REST code calls "unlocked": defs equippable without an
// instance, plus every def the account holds an instance of.
export function ownedDefIds(playerId: string): Set<string> {
  const s = entitlementsFor(playerId);
  if (playerId) {
    for (const r of q(`SELECT DISTINCT def FROM instagib_items WHERE owner_id = ? AND state IN ('owned','listed')`).all(playerId) as {
      def: string;
    }[])
      s.add(r.def);
  }
  return s;
}

// ── Equip + Looks ────────────────────────────────────────────────────────────
// Equipped = slot → token. A token is an instance uid, or `def:<id>` for a
// virtual default / entitlement (cards, titles, announcer, stock gear).
export type EquippedMap = Partial<Record<ItemSlot, string>>;
const isSlot = (s: unknown): s is ItemSlot => typeof s === 'string' && (ITEM_SLOTS as readonly string[]).includes(s);

export function lookOfRow(r: ItemRow): Look {
  const a = attrsOf(r);
  const l: Look = { d: r.def };
  if (a.effect) l.e = a.effect;
  if (a.sheen) l.s = a.sheen;
  if (a.ksEffect) l.k = a.ksEffect;
  if (a.festive) l.f = 1;
  if (typeof a.seed === 'number') l.p = a.seed;
  if (a.tint) l.t = a.tint;
  return l;
}

type Resolved = { slot: ItemSlot; look: Look; uid: string | null; row?: ItemRow };

// Validate one token for `playerId`. `ents` is lazily computed once by callers.
function resolveToken(playerId: string, token: string, ents: () => Set<string>): Resolved | null {
  if (token.startsWith('def:')) {
    const id = token.slice(4);
    const d = itemDef(id);
    if (!d || !ents().has(id)) return null;
    return { slot: d.slot, look: { d: id }, uid: null };
  }
  const r = getItemRow(token);
  if (!r || r.owner_id !== playerId || r.state !== 'owned') return null;
  const d = itemDef(r.def);
  if (!d) return null;
  return { slot: d.slot, look: lookOfRow(r), uid: r.uid, row: r };
}

export function equippedOf(playerId: string): EquippedMap {
  const r = q(`SELECT equipped_items FROM instagib_stats WHERE player_id = ?`).get(playerId) as { equipped_items: string } | undefined;
  const raw = json<Record<string, unknown>>(r?.equipped_items, {});
  const out: EquippedMap = {};
  for (const [k, v] of Object.entries(raw)) if (isSlot(k) && typeof v === 'string') out[k] = v;
  return out;
}

export type ResolvedLoadout = { equipped: EquippedMap; looks: Loadout; strangeUids: string[] };

// Validate the stored equipment (items that left the account / went to the
// market simply drop out) and resolve it to Looks. Persists the pruned map.
export function resolveEquipped(playerId: string): ResolvedLoadout {
  const stored = equippedOf(playerId);
  const res = resolveTokens(playerId, Object.values(stored) as string[]);
  const equipped: EquippedMap = {};
  for (const [slot, r] of Object.entries(res.bySlot)) equipped[slot as ItemSlot] = r.uid ?? `def:${r.look.d}`;
  if (JSON.stringify(equipped) !== JSON.stringify(stored)) {
    q(`UPDATE instagib_stats SET equipped_items = ? WHERE player_id = ?`).run(JSON.stringify(equipped), playerId);
  }
  return { equipped, looks: res.looks, strangeUids: res.strangeUids };
}

export function resolveTokens(playerId: string, tokens: readonly string[]): {
  bySlot: Partial<Record<ItemSlot, Resolved>>;
  looks: Loadout;
  strangeUids: string[];
} {
  const bySlot: Partial<Record<ItemSlot, Resolved>> = {};
  let ents: Set<string> | null = null;
  const getEnts = () => (ents ??= entitlementsFor(playerId));
  for (const t of tokens.slice(0, 16)) {
    if (typeof t !== 'string' || t.length > 40) continue;
    const r = resolveToken(playerId, t, getEnts);
    if (r) bySlot[r.slot] = r;
  }
  const looks: Loadout = {};
  const strangeUids: string[] = [];
  for (const [slot, r] of Object.entries(bySlot)) {
    // Stock defaults carry no information — omit them from the broadcast.
    if (DEFAULT_LOADOUT[slot as ItemSlot] === r.look.d) continue;
    looks[slot as ItemSlot] = r.look;
    if (r.row && (slot === 'finish' || slot === 'beam' || slot === 'finisher') && json<Quality[]>(r.row.quality, []).includes('strange')) {
      strangeUids.push(r.row.uid);
    }
  }
  return { bySlot, looks, strangeUids };
}

export const looksFor = (playerId: string): Loadout => (playerId ? resolveEquipped(playerId).looks : {});

export type EquipResult =
  | { ok: true; equipped: EquippedMap; looks: Loadout }
  | { ok: false; error: 'bad_slot' | 'not_owned' | 'slot_mismatch' | 'guest' };

// Equip (or clear, `token = null`) one slot. Server-validated: an instance must
// be yours and `owned` (not listed / salvaged); a `def:` token must be a default
// or an entitlement you hold. The def's slot must match.
export function equipSlot(playerId: string, slot: unknown, token: string | null): EquipResult {
  if (!playerId) return { ok: false, error: 'guest' };
  if (!isSlot(slot)) return { ok: false, error: 'bad_slot' };
  return sqlite.transaction((): EquipResult => {
    ensureStatsRow(playerId);
    const cur = resolveEquipped(playerId).equipped;
    if (token == null || token === '') delete cur[slot];
    else {
      const r = resolveToken(playerId, token, () => entitlementsFor(playerId));
      if (!r) return { ok: false, error: 'not_owned' };
      if (r.slot !== slot) return { ok: false, error: 'slot_mismatch' };
      cur[slot] = r.uid ?? `def:${r.look.d}`;
    }
    q(`UPDATE instagib_stats SET equipped_items = ? WHERE player_id = ?`).run(JSON.stringify(cur), playerId);
    const res = resolveEquipped(playerId);
    return { ok: true, equipped: res.equipped, looks: res.looks };
  })();
}

export function unequipUids(ownerId: string, uids: readonly string[]): void {
  if (!ownerId || uids.length === 0) return;
  const cur = equippedOf(ownerId);
  let changed = false;
  for (const [slot, tok] of Object.entries(cur)) {
    if (uids.includes(tok as string)) {
      delete cur[slot as ItemSlot];
      changed = true;
    }
  }
  if (changed) q(`UPDATE instagib_stats SET equipped_items = ? WHERE player_id = ?`).run(JSON.stringify(cur), ownerId);
}

// ── Inventory reads ──────────────────────────────────────────────────────────
export function inventoryOf(playerId: string, states: readonly string[] = ['owned', 'listed']): ItemInstanceWire[] {
  const ph = states.map(() => '?').join(',');
  return (
    q(`SELECT * FROM instagib_items WHERE owner_id = ? AND state IN (${ph}) ORDER BY created_at DESC, uid`).all(playerId, ...states) as ItemRow[]
  ).map(toWire);
}

export type InventoryReply = {
  items: ItemInstanceWire[];
  equipped: EquippedMap;
  looks: Loadout;
  credits: number;
  freeRolls: number;
  // Defs equippable without an instance (defaults, cards, titles, announcers…).
  entitlements: string[];
};

export function getInventory(playerId: string): InventoryReply {
  if (!playerId) return { items: [], equipped: {}, looks: {}, credits: 0, freeRolls: 0, entitlements: [...entitlementsFor('')] };
  ensureOnboarded(playerId);
  const { equipped, looks } = resolveEquipped(playerId);
  return { items: inventoryOf(playerId), equipped, looks, ...econState(playerId), entitlements: [...entitlementsFor(playerId)] };
}

// ── Revoke / salvage ─────────────────────────────────────────────────────────
function closeListings(uid: string, state: 'cancelled' | 'revoked' = 'cancelled'): void {
  q(`UPDATE instagib_market SET state = ? WHERE uid = ? AND state = 'active'`).run(state, uid);
}

function revokeRow(r: ItemRow, actor: string, reason: string): void {
  q(`UPDATE instagib_items SET state = 'revoked', updated_at = ? WHERE uid = ?`).run(Date.now(), r.uid);
  closeListings(r.uid, 'revoked');
  unequipUids(r.owner_id, [r.uid]);
  itemEvent(r.uid, 'revoke', r.owner_id, '', { reason, actor });
}

export type SalvageResult =
  | { ok: true; credits: number; gained: number; removed: string[] }
  | { ok: false; error: 'guest' | 'nothing' | 'not_owned' | 'not_salvageable'; uid?: string };

// Titles and staff/founder items are never salvageable (they aren't tradable
// goods either); other bound items (road rewards) are — they pay the tier value.
function salvageBlocked(r: ItemRow): boolean {
  const d = itemDef(r.def);
  if (!d || d.slot === 'title') return true;
  const quality = json<Quality[]>(r.quality, []);
  return quality.includes('founder') || quality.includes('admin') || STAFF_INSTANCE_DEFS.includes(r.def);
}

export function salvageItems(playerId: string, uids: readonly string[]): SalvageResult {
  if (!playerId) return { ok: false, error: 'guest' };
  const list = [...new Set(uids.filter((u) => typeof u === 'string'))].slice(0, 100);
  if (list.length === 0) return { ok: false, error: 'nothing' };
  return sqlite.transaction((): SalvageResult => {
    ensureOnboarded(playerId);
    let gained = 0;
    const rows: ItemRow[] = [];
    for (const uid of list) {
      const r = getItemRow(uid);
      if (!r || r.owner_id !== playerId || r.state !== 'owned') return { ok: false, error: 'not_owned', uid };
      if (salvageBlocked(r)) return { ok: false, error: 'not_salvageable', uid };
      rows.push(r);
    }
    const now = Date.now();
    for (const r of rows) {
      const value = TIER_META[tierOf(r)].salvage;
      gained += value;
      q(`UPDATE instagib_items SET state = 'salvaged', updated_at = ? WHERE uid = ?`).run(now, r.uid);
      itemEvent(r.uid, 'salvage', playerId, '', { credits: value }, now);
    }
    unequipUids(playerId, list);
    addCredits(playerId, gained);
    audit({ event: 'item.salvage', actorId: playerId, targetId: playerId, detail: { n: rows.length, gained, defs: rows.map((r) => r.def).slice(0, 20) } });
    return { ok: true, credits: econState(playerId).credits, gained, removed: rows.map((r) => r.uid) };
  })();
}

// ── Strange counters ─────────────────────────────────────────────────────────
// Add `n` counted frags to each given (strange) instance the player still owns.
export function addStrangeKills(playerId: string, uids: readonly string[], n: number): void {
  if (!playerId || n <= 0 || uids.length === 0) return;
  const stmt = q(
    `UPDATE instagib_items
        SET attrs = json_set(attrs, '$.kills', COALESCE(json_extract(attrs, '$.kills'), 0) + CAST(? AS INTEGER)), updated_at = ?
      WHERE uid = ? AND owner_id = ? AND state = 'owned' AND quality LIKE '%strange%'`,
  );
  const now = Date.now();
  sqlite.transaction(() => {
    for (const uid of uids) stmt.run(n, now, uid, playerId);
  })();
}

// ── Cases ────────────────────────────────────────────────────────────────────
export type Rng = (maxExclusive: number) => number;
const defaultRng: Rng = (n) => randomInt(n);

const PPM = 1_000_000;

export function caseDef(id: string): CaseDef | undefined {
  return CASES.find((c) => c.id === id);
}

export function poolFor(c: CaseDef): ItemDef[] {
  return casePoolFor(c.slots);
}

// Defs for a rolled tier; empty tier falls to the nearest LOWER tier that has
// items, then the nearest higher (catalog note). The Vault's Unobtainable roll
// draws from the tradable Unobtainable defs.
export function defsForTier(c: CaseDef, tier: Tier, pool: ItemDef[]): { tier: Tier; defs: ItemDef[] } {
  const at = (t: Tier): ItemDef[] =>
    t === 'unobtainable' ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)) : pool.filter((d) => d.tier === t);
  const start = TIERS.indexOf(tier);
  for (let i = start; i >= 0; i--) {
    const defs = at(TIERS[i]);
    if (defs.length) return { tier: TIERS[i], defs };
  }
  for (let i = start + 1; i < TIERS.length; i++) {
    const defs = at(TIERS[i]);
    if (defs.length) return { tier: TIERS[i], defs };
  }
  return { tier, defs: [] };
}

export function rollTier(c: CaseDef, rng: Rng = defaultRng): Tier {
  const ppm = TIERS.map((t) => Math.round(c.odds[t] * PPM));
  const total = ppm.reduce((a, b) => a + b, 0);
  let r = rng(total);
  for (let i = 0; i < TIERS.length; i++) {
    if (r < ppm[i]) return TIERS[i];
    r -= ppm[i];
  }
  return TIERS[0];
}

const chance = (p: number, rng: Rng): boolean => rng(PPM) < Math.round(p * PPM);
const pick = <T>(list: readonly T[], rng: Rng): T => list[rng(list.length)];

export function rollQualities(def: ItemDef, tier: Tier, rng: Rng = defaultRng): { quality: Quality[]; attrs: ItemAttrs } {
  const quality: Quality[] = [];
  const attrs: ItemAttrs = {};
  if (def.slot === 'hat') {
    const p = TIERS.indexOf(tier) >= TIERS.indexOf('legendary') ? QUALITY_ODDS.unusualHatLegendaryPlus : QUALITY_ODDS.unusualHat;
    if (chance(p, rng)) {
      quality.push('unusual');
      attrs.effect = pick(UNUSUAL_EFFECTS, rng).id;
    }
  } else if (def.slot === 'emote') {
    if (chance(QUALITY_ODDS.unusualEmote, rng)) {
      quality.push('unusual');
      attrs.effect = pick(
        UNUSUAL_EFFECTS.filter((e) => e.taunt),
        rng,
      ).id;
    }
  } else if (def.slot === 'finish' || def.slot === 'beam' || def.slot === 'finisher') {
    if (chance(QUALITY_ODDS.strange, rng)) {
      quality.push('strange');
      attrs.kills = 0;
    }
    if (def.slot === 'finish') {
      const r = rng(PPM);
      if (r < Math.round(QUALITY_ODDS.professional * PPM)) {
        quality.push('killstreak', 'professional');
        attrs.sheen = pick(KS_SHEENS, rng).id;
        attrs.ksEffect = pick(KS_EFFECTS, rng).id;
      } else if (r < Math.round(QUALITY_ODDS.killstreak * PPM)) {
        quality.push('killstreak');
        attrs.sheen = pick(KS_SHEENS, rng).id;
      }
      attrs.seed = rng(1000);
    }
  }
  return { quality, attrs };
}

export type CaseRoll = { tier: Tier; def: ItemDef; quality: Quality[]; attrs: ItemAttrs };
export function rollCase(c: CaseDef, rng: Rng = defaultRng): CaseRoll | null {
  const pool = poolFor(c);
  if (pool.length === 0) return null;
  const rolled = defsForTier(c, rollTier(c, rng), pool);
  if (rolled.defs.length === 0) return null;
  const def = pick(rolled.defs, rng);
  return { tier: rolled.tier, def, ...rollQualities(def, rolled.tier, rng) };
}

// How an open is paid for: credits, one banked free roll, or today's daily free case.
export type CasePay = 'credits' | 'roll' | 'daily';

export type CaseOpenResult =
  | { ok: true; item: ItemInstanceWire; tier: Tier; credits: number; freeRolls: number; usedRoll: boolean; pay: CasePay; nextDailyAt: number }
  | { ok: false; error: 'guest' | 'unknown_case' | 'insufficient' | 'no_rolls' | 'roll_not_allowed' | 'empty_pool' | 'daily_used'; nextDailyAt?: number };

const lastDailyCase = (playerId: string): string =>
  (q(`SELECT last_daily_case FROM instagib_stats WHERE player_id = ?`).get(playerId) as { last_daily_case: string } | undefined)?.last_daily_case ?? '';

// 0 = the daily free case is available now; otherwise when it next is (UTC midnight).
export function nextDailyCaseAt(playerId: string, now = Date.now()): number {
  if (!playerId) return 0;
  return lastDailyCase(playerId) === utcDayKey(now) ? nextUtcMidnight(now) : 0;
}

export function openCase(playerId: string, caseId: string, pay: CasePay, now = Date.now()): CaseOpenResult {
  if (!playerId) return { ok: false, error: 'guest' };
  const c = caseDef(caseId);
  if (!c) return { ok: false, error: 'unknown_case' };
  return sqlite.transaction((): CaseOpenResult => {
    ensureOnboarded(playerId);
    const st = econState(playerId);
    if (pay === 'roll' || pay === 'daily') {
      // Free opens (a banked roll or the daily case) are for STANDARD cases; the Vault needs credits.
      if (c.premium) return { ok: false, error: 'roll_not_allowed' };
      if (pay === 'roll' && st.freeRolls < 1) return { ok: false, error: 'no_rolls' };
      if (pay === 'daily' && lastDailyCase(playerId) === utcDayKey(now)) return { ok: false, error: 'daily_used', nextDailyAt: nextUtcMidnight(now) };
    } else if (st.credits < c.cost) return { ok: false, error: 'insufficient' };
    const roll = rollCase(c);
    if (!roll) return { ok: false, error: 'empty_pool' };
    if (pay === 'roll') addRolls(playerId, -1);
    else if (pay === 'daily') q(`UPDATE instagib_stats SET last_daily_case = ? WHERE player_id = ?`).run(utcDayKey(now), playerId);
    else addCredits(playerId, -c.cost);
    const free = pay !== 'credits';
    const item = mintItem({
      owner: playerId,
      def: roll.def.id,
      quality: roll.quality,
      attrs: roll.attrs,
      origin: 'case',
      meta: { case: c.id, free, pay, season: CURRENT_SEASON },
    });
    audit({
      event: 'case.open',
      actorId: playerId,
      targetId: item.uid,
      detail: { case: c.id, def: item.def, tier: roll.tier, quality: item.quality, free, pay, cost: free ? 0 : c.cost },
    });
    const after = econState(playerId);
    return { ok: true, item, tier: roll.tier, credits: after.credits, freeRolls: after.freeRolls, usedRoll: pay === 'roll', pay, nextDailyAt: nextDailyCaseAt(playerId, now) };
  })();
}

// The odds a player actually experiences: a tier with no defs in the pool
// falls to the nearest lower tier that has some (then higher) — see defsForTier.
export function effectiveOdds(c: CaseDef): Record<Tier, number> {
  const pool = poolFor(c);
  const out = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const t of TIERS) {
    if (c.odds[t] <= 0) continue;
    const landed = defsForTier(c, t, pool);
    if (landed.defs.length) out[landed.tier] += c.odds[t];
  }
  return out;
}

export type CaseInfo = {
  id: CaseId;
  name: string;
  blurb: string;
  cost: number;
  premium: boolean;
  slots: readonly ItemSlot[];
  odds: Record<Tier, number>; // EFFECTIVE tier probabilities (sum 1) — what a roll really does
  nominalOdds: Record<Tier, number>; // the case's configured odds before empty-tier fallback
  pool: Record<Tier, number>; // how many defs can drop at each tier
  qualityOdds: Record<string, number>; // the quality chances that apply to this case's pool
};

export function casesInfo(): { cases: CaseInfo[]; qualityOdds: typeof QUALITY_ODDS; season: { id: number; name: string } } {
  const cases = CASES.map((c): CaseInfo => {
    const pool = poolFor(c);
    const count = {} as Record<Tier, number>;
    for (const t of TIERS) {
      count[t] =
        t === 'unobtainable'
          ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)).length
          : pool.filter((d) => d.tier === t).length;
    }
    const slots = new Set(c.slots);
    const qo: Record<string, number> = {};
    if (slots.has('hat')) {
      qo.unusualHat = QUALITY_ODDS.unusualHat;
      qo.unusualHatLegendaryPlus = QUALITY_ODDS.unusualHatLegendaryPlus;
    }
    if (slots.has('emote')) qo.unusualEmote = QUALITY_ODDS.unusualEmote;
    if (slots.has('finish') || slots.has('beam') || slots.has('finisher')) qo.strange = QUALITY_ODDS.strange;
    if (slots.has('finish')) {
      qo.killstreak = QUALITY_ODDS.killstreak;
      qo.professional = QUALITY_ODDS.professional;
    }
    return {
      id: c.id,
      name: c.name,
      blurb: c.blurb,
      cost: c.cost,
      premium: !!c.premium,
      slots: c.slots,
      odds: effectiveOdds(c),
      nominalOdds: c.odds,
      pool: count,
      qualityOdds: qo,
    };
  });
  return { cases, qualityOdds: QUALITY_ODDS, season: { id: CURRENT_SEASON, name: seasonName(CURRENT_SEASON) } };
}

// ── Admin operations ─────────────────────────────────────────────────────────
const QUALITIES: readonly Quality[] = ['unusual', 'strange', 'festive', 'killstreak', 'professional', 'founder', 'admin'];
const HEX = /^#[0-9a-fA-F]{6}$/;

export type AdminMintInput = {
  player: string; // account id
  def: string;
  quality?: unknown;
  attrs?: unknown;
  tier?: unknown;
  bound?: unknown;
  count?: unknown;
};

// Validate + sanitise admin-supplied attrs. Returns an error string or the value.
function cleanAdminAttrs(raw: unknown, tier: unknown): { attrs: StoredAttrs; error?: string } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: StoredAttrs = {};
  if (a.effect != null) {
    if (typeof a.effect !== 'string' || !UNUSUAL_EFFECTS.some((e) => e.id === a.effect)) return { attrs: out, error: 'bad_effect' };
    out.effect = a.effect;
  }
  if (a.kills != null) out.kills = Math.max(0, Math.min(10_000_000, Math.floor(Number(a.kills) || 0)));
  if (a.sheen != null) {
    if (typeof a.sheen !== 'string' || !KS_SHEENS.some((s) => s.id === a.sheen)) return { attrs: out, error: 'bad_sheen' };
    out.sheen = a.sheen;
  }
  if (a.ksEffect != null) {
    if (typeof a.ksEffect !== 'string' || !KS_EFFECTS.some((s) => s.id === a.ksEffect)) return { attrs: out, error: 'bad_ksEffect' };
    out.ksEffect = a.ksEffect;
  }
  if (a.festive) out.festive = true;
  if (a.seed != null) out.seed = Math.max(0, Math.min(999, Math.floor(Number(a.seed) || 0)));
  for (const [key, max] of [['nameTag', 24], ['customName', 40], ['customDesc', 200]] as const) {
    if (a[key] == null) continue;
    const s = String(a[key]).trim().slice(0, max);
    if (s && containsProfanity(s)) return { attrs: out, error: `profanity_${key}` };
    if (s) out[key] = s;
  }
  if (a.tint != null) {
    if (typeof a.tint !== 'string' || !HEX.test(a.tint)) return { attrs: out, error: 'bad_tint' };
    out.tint = a.tint.toLowerCase();
  }
  tier = tier ?? a.tier;
  if (tier != null) {
    if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) return { attrs: out, error: 'bad_tier' };
    out.tier = tier as Tier;
  }
  return { attrs: out };
}

export type AdminMintResult = { ok: true; items: ItemInstanceWire[] } | { ok: false; error: string };

// A validated admin item spec (for a direct mint, a redeem code or an inbox gift):
// the def exists and is an instance item, attrs are sanitised, qualities derived
// from attrs, staff gear forced bound.
export type PreparedItem = { def: string; quality: Quality[]; attrs: StoredAttrs; bound: boolean };
export type ItemSpecInput = { def?: unknown; quality?: unknown; attrs?: unknown; tier?: unknown; bound?: unknown };

export function prepareAdminItem(i: ItemSpecInput): { ok: true; item: PreparedItem } | { ok: false; error: string } {
  const def = typeof i.def === 'string' ? itemDef(i.def) : undefined;
  if (!def) return { ok: false, error: 'unknown_def' };
  if (def.default || ENTITLEMENT_SLOTS.has(def.slot)) return { ok: false, error: 'not_an_item' };
  const { attrs, error } = cleanAdminAttrs(i.attrs, i.tier);
  if (error) return { ok: false, error };
  // Drop what can't apply to this slot (SLOT_ATTRS) rather than failing, so a
  // code or gift saved before a rule change still grants.
  const allows = (k: SlotAttr) => slotAllows(def.slot, k);
  if (attrs.effect && !(allows('effect') && (def.slot !== 'emote' || UNUSUAL_EFFECTS.some((e) => e.id === attrs.effect && e.taunt)))) delete attrs.effect;
  if (!allows('kills')) delete attrs.kills;
  if (!allows('sheen')) delete attrs.sheen;
  if (!allows('ksEffect')) delete attrs.ksEffect;
  if (!allows('festive')) delete attrs.festive;
  if (!allows('seed')) delete attrs.seed;
  if (!allows('tint')) delete attrs.tint;
  const qIn = Array.isArray(i.quality) ? (i.quality.filter((x) => (QUALITIES as readonly unknown[]).includes(x)) as Quality[]) : [];
  const quality = new Set<Quality>(qIn);
  if (!attrs.effect) quality.delete('unusual');
  if (!allows('kills')) quality.delete('strange');
  if (!allows('sheen')) {
    quality.delete('killstreak');
    quality.delete('professional');
  }
  if (!allows('festive')) quality.delete('festive');
  if (attrs.effect) quality.add('unusual');
  if (attrs.kills != null) quality.add('strange');
  if (attrs.ksEffect) {
    quality.add('killstreak');
    quality.add('professional');
  } else if (attrs.sheen) quality.add('killstreak');
  if (attrs.festive) quality.add('festive');
  if (attrs.customName || attrs.customDesc || attrs.tint || attrs.tier) quality.add('admin');
  if (quality.has('strange') && attrs.kills == null) attrs.kills = 0;
  const bound = i.bound === true || (STAFF_INSTANCE_DEFS as readonly string[]).includes(def.id); // staff gear never reaches the market
  return { ok: true, item: { def: def.id, quality: [...quality], attrs, bound } };
}

// Mint a prepared spec (call inside the caller's transaction).
export function mintPrepared(owner: string, p: PreparedItem, origin: ItemOrigin, actor: string, meta: unknown): ItemInstanceWire {
  return mintItem({ owner, def: p.def, quality: [...p.quality], attrs: { ...p.attrs }, origin, tradable: !p.bound, actor, meta });
}

export function adminMint(actor: string, i: AdminMintInput): AdminMintResult {
  const prep = prepareAdminItem(i);
  if (!prep.ok) return prep;
  const spec = prep.item;
  const owner = i.player;
  if (!q(`SELECT 1 FROM instagib_users WHERE id = ?`).get(owner)) return { ok: false, error: 'no_player' };
  const n = Math.max(1, Math.min(25, Math.floor(Number(i.count) || 1)));
  return sqlite.transaction((): AdminMintResult => {
    ensureOnboarded(owner);
    const items: ItemInstanceWire[] = [];
    for (let k = 0; k < n; k++) items.push(mintPrepared(owner, spec, 'admin', actor, { admin: actor }));
    audit({ event: 'admin.mint', actorId: actor, targetId: owner, detail: { def: spec.def, n, quality: spec.quality, bound: spec.bound, attrs: spec.attrs, uids: items.map((x) => x.uid) } });
    return { ok: true, items };
  })();
}

export function adminRevoke(actor: string, uid: string, reason: string): { ok: true; item: ItemInstanceWire } | { ok: false; error: string } {
  return sqlite.transaction((): { ok: true; item: ItemInstanceWire } | { ok: false; error: string } => {
    const r = getItemRow(uid);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.state === 'revoked' || r.state === 'salvaged') return { ok: false, error: 'not_active' };
    revokeRow(r, actor, reason.slice(0, 200));
    audit({ event: 'admin.revoke_item', actorId: actor, targetId: r.owner_id, detail: { uid, def: r.def, reason: reason.slice(0, 200) } });
    return { ok: true, item: toWire(getItemRow(uid)!) };
  })();
}

export function adminGrant(actor: string, player: string, credits: number, rolls: number): { ok: true; credits: number; freeRolls: number } | { ok: false; error: string } {
  if (!q(`SELECT 1 FROM instagib_users WHERE id = ?`).get(player)) return { ok: false, error: 'no_player' };
  const c = Math.max(-1_000_000, Math.min(1_000_000, Math.floor(credits) || 0));
  const r = Math.max(-1000, Math.min(1000, Math.floor(rolls) || 0));
  return sqlite.transaction((): { ok: true; credits: number; freeRolls: number } | { ok: false; error: string } => {
    ensureOnboarded(player);
    // Validate BOTH before writing: better-sqlite3 only rolls back on a throw.
    const cur = econState(player);
    if (cur.credits + c < 0 || cur.freeRolls + r < 0) return { ok: false, error: 'insufficient' };
    if (c && !addCredits(player, c)) throw new Error('adminGrant: credits changed mid-transaction');
    if (r && !addRolls(player, r)) throw new Error('adminGrant: rolls changed mid-transaction');
    audit({ event: 'admin.grant_econ', actorId: actor, targetId: player, detail: { credits: c, rolls: r } });
    return { ok: true, ...econState(player) };
  })();
}

export type ItemEventWire = { id: number; uid: string; ts: number; kind: string; from: string; to: string; meta: unknown };
export function itemHistory(uid: string): { item: ItemInstanceWire; owner: string; events: ItemEventWire[] } | null {
  const r = getItemRow(uid);
  if (!r) return null;
  const name = (id: string): string => (id ? ((q(`SELECT username FROM instagib_users WHERE id = ?`).get(id) as { username: string } | undefined)?.username ?? id) : '');
  const events = (
    q(`SELECT * FROM instagib_item_events WHERE uid = ? ORDER BY id`).all(uid) as {
      id: number; uid: string; ts: number; kind: string; from_id: string; to_id: string; meta: string;
    }[]
  ).map((e) => ({ id: e.id, uid: e.uid, ts: e.ts, kind: e.kind, from: name(e.from_id), to: name(e.to_id), meta: json<unknown>(e.meta, e.meta) }));
  return { item: toWire(r), owner: name(r.owner_id), events };
}

export function adminInventory(playerId: string, all: boolean): { items: ItemInstanceWire[]; credits: number; freeRolls: number; equipped: EquippedMap } {
  ensureOnboarded(playerId);
  return {
    items: inventoryOf(playerId, all ? ['owned', 'listed', 'traded', 'salvaged', 'revoked'] : ['owned', 'listed']),
    ...econState(playerId),
    equipped: resolveEquipped(playerId).equipped,
  };
}

// Public view of a player's tradable items (for building trade offers).
export function publicInventory(playerId: string): ItemInstanceWire[] {
  return (q(`SELECT * FROM instagib_items WHERE owner_id = ? AND state = 'owned' AND tradable = 1 ORDER BY created_at DESC, uid LIMIT 500`).all(playerId) as ItemRow[]).map(toWire);
}

// ── Road rewards (used by db.ts grantRoad + the migration) ───────────────────
// A level-sourced cosmetic reward with an item def is minted as a BOUND
// instance (origin 'road'); entitlement slots and 'replaced' rewards mint nothing.
export function mintRoadRewards(playerId: string, steps: readonly RoadStep[]): ItemInstanceWire[] {
  const out: ItemInstanceWire[] = [];
  for (const step of steps) {
    for (const r of step.rewards) {
      if (r.type !== 'cosmetic' || roadRewardKind(r.id) !== 'item') continue;
      const w = grantBoundOnce(playerId, r.id, 'road', [], { level: step.level });
      if (w) out.push(w);
    }
  }
  return out;
}

// ── One-time reset + onboarding (docs/economy.md §6) ─────────────────────────
type OnboardRow = { total_xp: number; road_level: number; unlocked: string; equipped: string; case_keys: number; econ_v3: number };
export type OnboardResult = { done: boolean; credits: number; rolls: number; minted: number };

// Idempotent per account (`econ_v3`): copy unlocked → legacy_unlocked, grant
// credits + free rolls by level, mint the road cosmetics already earned as bound
// instances, and staff items for admins. The pre-v3 columns (unlocked / equipped /
// case_keys) are left untouched — v3 never reads them — so rolling the deploy
// back to the old code is lossless.
export const onboardAccount = sqlite.transaction((playerId: string): OnboardResult => {
  ensureStatsRow(playerId);
  const r = q(`SELECT total_xp, road_level, unlocked, equipped, case_keys, econ_v3 FROM instagib_stats WHERE player_id = ?`).get(playerId) as OnboardRow;
  if (r.econ_v3) return { done: false, credits: 0, rolls: 0, minted: 0 };
  const level = levelForXp(r.total_xp);
  const credits = ONBOARDING.credits(level);
  const rolls = ONBOARDING.rolls(level);
  q(
    `UPDATE instagib_stats
        SET legacy_unlocked = ?, equipped_items = '{}',
            credits = credits + ?, free_rolls = free_rolls + ?, econ_v3 = 1
      WHERE player_id = ?`,
  ).run(r.unlocked || '[]', credits, rolls, playerId);
  const minted = mintRoadRewards(playerId, roadStepsBetween(1, Math.max(1, r.road_level))).length;
  let staff = 0;
  if (isAdminAccount(playerId)) staff = ensureStaffItems(playerId).length;
  audit({ event: 'econ.onboard', targetId: playerId, detail: { level, credits, rolls, road: minted, staff, legacyEquipped: json<unknown>(r.equipped, r.equipped), legacyCaseKeys: r.case_keys } });
  return { done: true, credits, rolls, minted: minted + staff };
});

// Cheap guard used by every economy entry point (and account creation): a
// no-op after the first call for an account.
export function ensureOnboarded(playerId: string): void {
  if (!playerId) return;
  const r = q(`SELECT econ_v3 FROM instagib_stats WHERE player_id = ?`).get(playerId) as { econ_v3: number } | undefined;
  if (r?.econ_v3) return;
  if (!q(`SELECT 1 FROM instagib_users WHERE id = ?`).get(playerId)) return; // guests / unknown ids: nothing to onboard
  onboardAccount(playerId);
}

// One-time snapshot of the whole DB before the v3 reset first runs (no
// `econ_v3_at` marker yet and accounts exist). VACUUM INTO is synchronous and
// consistent; it runs once at boot, before the server accepts connections.
function backupBeforeFirstMigration(now: number): void {
  if (q(`SELECT 1 FROM instagib_meta WHERE k = 'econ_v3_at'`).get()) return;
  if (!q(`SELECT 1 FROM instagib_users LIMIT 1`).get()) return;
  const file = path.join(path.dirname(databasePath), `instagib-pre-econ-v3-${now}.sqlite`);
  try {
    sqlite.prepare(`VACUUM INTO ?`).run(file);
    console.log(`[economy] pre-v3 backup written to ${file}`);
  } catch (err) {
    console.error('[economy] pre-v3 backup FAILED (continuing):', err);
  }
}

export function initEconomy(h: Hooks): void {
  hooks = h;
  ensureEconomySchema();
  ensureRewardsSchema();
  const now = Date.now();
  backupBeforeFirstMigration(now);
  q(`INSERT OR IGNORE INTO instagib_meta (k, v) VALUES ('econ_v3_at', ?)`).run(String(now));
  // Wear bands were retired: drop the leftover attribute (idempotent).
  q(`UPDATE instagib_items SET attrs = json_remove(attrs, '$.wear') WHERE json_extract(attrs, '$.wear') IS NOT NULL`).run();
  const ids = q(
    `SELECT u.id FROM instagib_users u LEFT JOIN instagib_stats s ON s.player_id = u.id WHERE s.player_id IS NULL OR s.econ_v3 = 0`,
  ).all() as { id: string }[];
  let n = 0;
  for (const { id } of ids) {
    try {
      if (onboardAccount(id).done) n += 1;
    } catch (err) {
      console.error('[economy] onboarding failed for', id, err);
    }
  }
  // Staff accounts promoted since (env sync happens after this): make sure they hold their set.
  for (const { id } of q(`SELECT id FROM instagib_users WHERE is_admin = 1`).all() as { id: string }[]) {
    try {
      ensureStaffItems(id);
    } catch (err) {
      console.error('[economy] staff items failed for', id, err);
    }
  }
  if (n > 0) console.log(`[economy] v3 reset + onboarding applied to ${n} account(s)`);
}
