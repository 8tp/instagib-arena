// Redeem codes + the player inbox (docs/economy.md §7b).
//
// - An admin creates a CODE carrying a reward bundle (credits, free rolls, and/or
//   items minted fresh on redemption). A player redeems it once; the grant is one
//   transaction and leaves a receipt in their inbox.
// - An admin sends a GIFT (to one player or to everyone): an inbox message whose
//   attachments the player claims (one transaction; minted on claim).
// Bundles are validated when they're created (prepareAdminItem) AND re-validated
// on redemption / claim, so a catalog change can't mint something stale.

import { randomInt } from 'node:crypto';
import { sqlite } from './sqlite';
import {
  addCredits,
  addRolls,
  audit,
  econState,
  ensureOnboarded,
  mintPrepared,
  prepareAdminItem,
  q,
  toWire,
  getItemRow,
  type PreparedItem,
} from './economy';
import { levelForXp } from '../src/game/progression';
import { containsProfanity } from './profanity';
import {
  REWARD_LIMITS,
  type InboxKind,
  type InboxMessageWire,
  type ItemInstanceWire,
  type RedeemCodeWire,
  type RedeemResult,
  type RewardBundle,
} from '../src/game/items/types';

export function ensureRewardsSchema(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS instagib_codes (
  code       TEXT PRIMARY KEY,
  reward     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  max_uses   INTEGER NOT NULL DEFAULT 0,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  min_level  INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instagib_code_redemptions (
  code      TEXT NOT NULL,
  player_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (code, player_id)
);
CREATE TABLE IF NOT EXISTS instagib_inbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  sender     TEXT NOT NULL DEFAULT '',
  reward     TEXT NOT NULL DEFAULT '{}',
  granted    TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  read_at    INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbox_player ON instagib_inbox(player_id, id);
`);
}

const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ── Reward bundles ───────────────────────────────────────────────────────────
type PreparedBundle = { credits: number; rolls: number; items: PreparedItem[] };

// Validate + normalise an admin-supplied bundle. Must grant something.
export function prepareBundle(raw: unknown): { ok: true; bundle: PreparedBundle } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, max: number): number | null => {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
  };
  const credits = int(r.credits, REWARD_LIMITS.credits);
  const rolls = int(r.rolls, REWARD_LIMITS.rolls);
  if (credits == null) return { ok: false, error: 'bad_credits' };
  if (rolls == null) return { ok: false, error: 'bad_rolls' };
  const rawItems = r.items == null ? [] : r.items;
  if (!Array.isArray(rawItems) || rawItems.length > REWARD_LIMITS.items) return { ok: false, error: 'bad_items' };
  const items: PreparedItem[] = [];
  for (const it of rawItems) {
    const p = prepareAdminItem((it && typeof it === 'object' ? it : {}) as Record<string, unknown>);
    if (!p.ok) return { ok: false, error: `item_${p.error}` };
    items.push(p.item);
  }
  if (credits === 0 && rolls === 0 && items.length === 0) return { ok: false, error: 'empty_reward' };
  return { ok: true, bundle: { credits, rolls, items } };
}

const bundleWire = (b: PreparedBundle): RewardBundle => ({
  ...(b.credits ? { credits: b.credits } : {}),
  ...(b.rolls ? { rolls: b.rolls } : {}),
  ...(b.items.length ? { items: b.items.map((i) => ({ def: i.def, quality: i.quality, attrs: i.attrs, bound: i.bound })) } : {}),
});

// Grant a (re-validated) bundle to a player. Call inside a transaction; throws on
// a stale bundle so the caller's transaction rolls back.
function grantBundle(playerId: string, stored: RewardBundle, origin: 'code' | 'gift', actor: string, meta: unknown): { credits: number; rolls: number; items: ItemInstanceWire[] } {
  const prep = prepareBundle(stored);
  if (!prep.ok) throw new Error(`stale reward bundle: ${prep.error}`);
  const b = prep.bundle;
  if (b.credits && !addCredits(playerId, b.credits)) throw new Error('grant credits failed');
  if (b.rolls && !addRolls(playerId, b.rolls)) throw new Error('grant rolls failed');
  const items = b.items.map((it) => mintPrepared(playerId, it, origin, actor, meta));
  return { credits: b.credits, rolls: b.rolls, items };
}

// ── Inbox ────────────────────────────────────────────────────────────────────
type InboxRow = {
  id: number;
  player_id: string;
  kind: InboxKind;
  title: string;
  body: string;
  sender: string;
  reward: string;
  granted: string;
  created_at: number;
  read_at: number;
  claimed_at: number;
  expires_at: number;
};

function wireMessage(r: InboxRow): InboxMessageWire {
  const uids = json<string[]>(r.granted, []);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    sender: r.sender,
    createdAt: r.created_at,
    readAt: r.read_at,
    claimedAt: r.claimed_at,
    expiresAt: r.expires_at,
    reward: json<RewardBundle>(r.reward, {}),
    granted: uids.map((u) => getItemRow(u)).filter((x): x is NonNullable<typeof x> => !!x).map(toWire),
  };
}

const hasAttachments = (b: RewardBundle): boolean => !!(b.credits || b.rolls || (b.items && b.items.length));

function insertMessage(
  playerId: string,
  m: { kind: InboxKind; title: string; body?: string; sender?: string; reward?: RewardBundle; granted?: string[]; claimedAt?: number; expiresAt?: number },
  now = Date.now(),
): number {
  const info = q(
    `INSERT INTO instagib_inbox (player_id, kind, title, body, sender, reward, granted, created_at, claimed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    playerId,
    m.kind,
    m.title.slice(0, 80),
    (m.body ?? '').slice(0, 1000),
    (m.sender ?? 'Instagib Staff').slice(0, 40),
    JSON.stringify(m.reward ?? {}),
    JSON.stringify(m.granted ?? []),
    now,
    m.claimedAt ?? 0,
    m.expiresAt ?? 0,
  );
  return Number(info.lastInsertRowid);
}

export function inboxOf(playerId: string): { messages: InboxMessageWire[]; unread: number; unclaimed: number } {
  if (!playerId) return { messages: [], unread: 0, unclaimed: 0 };
  const rows = q(`SELECT * FROM instagib_inbox WHERE player_id = ? ORDER BY id DESC LIMIT 60`).all(playerId) as InboxRow[];
  return { messages: rows.map(wireMessage), ...inboxCounts(playerId) };
}

export function inboxCounts(playerId: string, now = Date.now()): { unread: number; unclaimed: number } {
  if (!playerId) return { unread: 0, unclaimed: 0 };
  const r = q(
    `SELECT SUM(read_at = 0) AS unread,
            SUM(claimed_at = 0 AND reward != '{}' AND (expires_at = 0 OR expires_at > ?)) AS unclaimed
       FROM instagib_inbox WHERE player_id = ?`,
  ).get(now, playerId) as { unread: number | null; unclaimed: number | null };
  return { unread: r.unread ?? 0, unclaimed: r.unclaimed ?? 0 };
}

export function markRead(playerId: string, id: unknown): { ok: boolean; error?: string } {
  if (!playerId) return { ok: false, error: 'guest' };
  if (id === 'all') {
    q(`UPDATE instagib_inbox SET read_at = ? WHERE player_id = ? AND read_at = 0`).run(Date.now(), playerId);
    return { ok: true };
  }
  if (!Number.isInteger(id)) return { ok: false, error: 'bad_request' };
  const r = q(`UPDATE instagib_inbox SET read_at = ? WHERE id = ? AND player_id = ? AND read_at = 0`).run(Date.now(), id, playerId);
  return r.changes > 0 || q(`SELECT 1 FROM instagib_inbox WHERE id = ? AND player_id = ?`).get(id, playerId) ? { ok: true } : { ok: false, error: 'not_found' };
}

export type ClaimResult =
  | { ok: true; message: InboxMessageWire; granted: { credits: number; rolls: number; items: ItemInstanceWire[] }; credits: number; freeRolls: number }
  | { ok: false; error: 'guest' | 'bad_request' | 'not_found' | 'nothing' | 'claimed' | 'expired' };

export function claimMessage(playerId: string, id: unknown, now = Date.now()): ClaimResult {
  if (!playerId) return { ok: false, error: 'guest' };
  if (!Number.isInteger(id)) return { ok: false, error: 'bad_request' };
  return sqlite.transaction((): ClaimResult => {
    const r = q(`SELECT * FROM instagib_inbox WHERE id = ? AND player_id = ?`).get(id, playerId) as InboxRow | undefined;
    if (!r) return { ok: false, error: 'not_found' };
    if (r.claimed_at) return { ok: false, error: 'claimed' };
    if (r.expires_at && r.expires_at <= now) return { ok: false, error: 'expired' };
    const reward = json<RewardBundle>(r.reward, {});
    if (!hasAttachments(reward)) return { ok: false, error: 'nothing' };
    ensureOnboarded(playerId);
    const granted = grantBundle(playerId, reward, 'gift', '', { inbox: r.id });
    q(`UPDATE instagib_inbox SET claimed_at = ?, read_at = CASE WHEN read_at = 0 THEN ? ELSE read_at END, granted = ? WHERE id = ?`).run(
      now,
      now,
      JSON.stringify(granted.items.map((i) => i.uid)),
      r.id,
    );
    audit({ event: 'inbox.claim', actorId: playerId, targetId: playerId, detail: { message: r.id, credits: granted.credits, rolls: granted.rolls, uids: granted.items.map((i) => i.uid) } });
    const st = econState(playerId);
    const msg = wireMessage(q(`SELECT * FROM instagib_inbox WHERE id = ?`).get(r.id) as InboxRow);
    return { ok: true, message: msg, granted, credits: st.credits, freeRolls: st.freeRolls };
  })();
}

// ── Codes ────────────────────────────────────────────────────────────────────
type CodeRow = {
  code: string;
  reward: string;
  note: string;
  max_uses: number;
  uses: number;
  expires_at: number;
  min_level: number;
  active: number;
  created_by: string;
  created_at: number;
};

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const normCode = (v: unknown): string => (typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, '') : '');

const nameOf = (id: string): string =>
  (q(`SELECT username FROM instagib_users WHERE id = ?`).get(id) as { username: string } | undefined)?.username ?? id;

function wireCode(r: CodeRow): RedeemCodeWire {
  return {
    code: r.code,
    reward: json<RewardBundle>(r.reward, {}),
    note: r.note,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    minLevel: r.min_level,
    active: !!r.active,
    createdBy: nameOf(r.created_by),
    createdAt: r.created_at,
  };
}

// Brute-force guard: failed redemptions per key (account + IP) in a sliding window.
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 10;
const fails = new Map<string, number[]>();
const recentFails = (key: string, now: number): number[] => (fails.get(key) ?? []).filter((t) => t > now - FAIL_WINDOW_MS);
const failSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fails) if (!v.some((t) => t > now - FAIL_WINDOW_MS)) fails.delete(k);
}, FAIL_WINDOW_MS);
failSweep.unref?.();

export function redeemCode(playerId: string, rawCode: unknown, rateKey: string, now = Date.now()): RedeemResult {
  if (!playerId) return { ok: false, error: 'guest' };
  const keys = [`a:${playerId}`, `k:${rateKey}`];
  if (keys.some((k) => recentFails(k, now).length >= FAIL_MAX)) return { ok: false, error: 'too_many_attempts' };
  const fail = (r: Extract<RedeemResult, { ok: false }>): RedeemResult => {
    for (const k of keys) fails.set(k, [...recentFails(k, now), now]);
    return r;
  };
  const code = normCode(rawCode);
  if (!CODE_RE.test(code)) return fail({ ok: false, error: 'bad_code' });
  return sqlite.transaction((): RedeemResult => {
    const c = q(`SELECT * FROM instagib_codes WHERE code = ?`).get(code) as CodeRow | undefined;
    if (!c) return fail({ ok: false, error: 'not_found' });
    if (!c.active) return { ok: false, error: 'inactive' };
    if (c.expires_at && c.expires_at <= now) return { ok: false, error: 'expired' };
    if (q(`SELECT 1 FROM instagib_code_redemptions WHERE code = ? AND player_id = ?`).get(code, playerId)) return { ok: false, error: 'already_redeemed' };
    if (c.max_uses > 0 && c.uses >= c.max_uses) return { ok: false, error: 'used_up' };
    if (c.min_level > 0) {
      const xp = (q(`SELECT total_xp FROM instagib_stats WHERE player_id = ?`).get(playerId) as { total_xp: number } | undefined)?.total_xp ?? 0;
      if (levelForXp(xp) < c.min_level) return { ok: false, error: 'level', need: c.min_level };
    }
    ensureOnboarded(playerId);
    const reward = json<RewardBundle>(c.reward, {});
    const granted = grantBundle(playerId, reward, 'code', c.created_by, { code });
    q(`INSERT INTO instagib_code_redemptions (code, player_id, at) VALUES (?, ?, ?)`).run(code, playerId, now);
    q(`UPDATE instagib_codes SET uses = uses + 1 WHERE code = ?`).run(code);
    const messageId = insertMessage(
      playerId,
      {
        kind: 'code',
        title: `Code redeemed: ${code}`,
        body: c.note ? c.note : 'Thanks for playing Instagib Arena.',
        reward,
        granted: granted.items.map((i) => i.uid),
        claimedAt: now,
      },
      now,
    );
    q(`UPDATE instagib_inbox SET read_at = ? WHERE id = ?`).run(now, messageId);
    audit({ event: 'code.redeem', actorId: playerId, targetId: code, detail: { credits: granted.credits, rolls: granted.rolls, uids: granted.items.map((i) => i.uid) } });
    const st = econState(playerId);
    return { ok: true, code, granted, credits: st.credits, freeRolls: st.freeRolls, messageId };
  })();
}

// ── Admin ────────────────────────────────────────────────────────────────────
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const randomCode = (): string =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')).join('-');

export type CreateCodeInput = { code?: unknown; reward?: unknown; maxUses?: unknown; expiresAt?: unknown; minLevel?: unknown; note?: unknown };

export function adminCreateCode(actor: string, i: CreateCodeInput, now = Date.now()): { ok: true; code: RedeemCodeWire } | { ok: false; error: string } {
  const prep = prepareBundle(i.reward);
  if (!prep.ok) return prep;
  let code = i.code == null || i.code === '' ? '' : normCode(i.code);
  if (code && !CODE_RE.test(code)) return { ok: false, error: 'bad_code' };
  if (code && containsProfanity(code)) return { ok: false, error: 'profanity' };
  const maxUses = i.maxUses == null || i.maxUses === '' ? 0 : Number(i.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 1_000_000) return { ok: false, error: 'bad_max_uses' };
  const expiresAt = i.expiresAt == null || i.expiresAt === '' ? 0 : Number(i.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < 0 || (expiresAt > 0 && expiresAt <= now)) return { ok: false, error: 'bad_expiry' };
  const minLevel = i.minLevel == null || i.minLevel === '' ? 0 : Number(i.minLevel);
  if (!Number.isInteger(minLevel) || minLevel < 0 || minLevel > 1000) return { ok: false, error: 'bad_min_level' };
  const note = typeof i.note === 'string' ? i.note.trim().slice(0, 200) : '';
  if (note && containsProfanity(note)) return { ok: false, error: 'profanity' };
  return sqlite.transaction((): { ok: true; code: RedeemCodeWire } | { ok: false; error: string } => {
    if (!code) {
      do code = randomCode();
      while (q(`SELECT 1 FROM instagib_codes WHERE code = ?`).get(code));
    } else if (q(`SELECT 1 FROM instagib_codes WHERE code = ?`).get(code)) return { ok: false, error: 'code_taken' };
    q(
      `INSERT INTO instagib_codes (code, reward, note, max_uses, expires_at, min_level, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(code, JSON.stringify(bundleWire(prep.bundle)), note, maxUses, Math.floor(expiresAt), minLevel, actor, now);
    audit({ event: 'admin.code_create', actorId: actor, targetId: code, detail: { reward: bundleWire(prep.bundle), maxUses, expiresAt, minLevel, note } });
    return { ok: true, code: wireCode(q(`SELECT * FROM instagib_codes WHERE code = ?`).get(code) as CodeRow) };
  })();
}

export function adminListCodes(): RedeemCodeWire[] {
  return (q(`SELECT * FROM instagib_codes ORDER BY created_at DESC LIMIT 200`).all() as CodeRow[]).map(wireCode);
}

export function adminSetCodeActive(actor: string, rawCode: unknown, active: unknown): { ok: true; code: RedeemCodeWire } | { ok: false; error: string } {
  const code = normCode(rawCode);
  if (typeof active !== 'boolean') return { ok: false, error: 'bad_request' };
  const r = q(`UPDATE instagib_codes SET active = ? WHERE code = ?`).run(active ? 1 : 0, code);
  if (r.changes === 0) return { ok: false, error: 'not_found' };
  audit({ event: 'admin.code_active', actorId: actor, targetId: code, detail: { active } });
  return { ok: true, code: wireCode(q(`SELECT * FROM instagib_codes WHERE code = ?`).get(code) as CodeRow) };
}

export function adminCodeRedemptions(rawCode: unknown): { player: string; at: number }[] {
  const code = normCode(rawCode);
  return (q(`SELECT player_id, at FROM instagib_code_redemptions WHERE code = ? ORDER BY at DESC LIMIT 500`).all(code) as { player_id: string; at: number }[]).map((r) => ({
    player: nameOf(r.player_id),
    at: r.at,
  }));
}

export type GiftInput = { playerId?: string; all?: boolean; title?: unknown; body?: unknown; reward?: unknown; expiresAt?: unknown };

// Send an inbox message (optionally with claimable attachments) to one player or
// to every account. Rewards are validated now and re-validated on claim.
export function adminSendGift(actor: string, i: GiftInput, now = Date.now()): { ok: true; sent: number } | { ok: false; error: string } {
  const title = typeof i.title === 'string' ? i.title.trim().slice(0, 80) : '';
  const body = typeof i.body === 'string' ? i.body.trim().slice(0, 1000) : '';
  if (!title) return { ok: false, error: 'no_title' };
  if (containsProfanity(title) || containsProfanity(body)) return { ok: false, error: 'profanity' };
  let reward: RewardBundle = {};
  if (i.reward != null && !(typeof i.reward === 'object' && Object.keys(i.reward as object).length === 0)) {
    const prep = prepareBundle(i.reward);
    if (!prep.ok) return prep;
    reward = bundleWire(prep.bundle);
  }
  const expiresAt = i.expiresAt == null || i.expiresAt === '' ? 0 : Number(i.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < 0 || (expiresAt > 0 && expiresAt <= now)) return { ok: false, error: 'bad_expiry' };
  const targets: string[] = i.all
    ? (q(`SELECT id FROM instagib_users`).all() as { id: string }[]).map((r) => r.id)
    : i.playerId && q(`SELECT 1 FROM instagib_users WHERE id = ?`).get(i.playerId)
      ? [i.playerId]
      : [];
  if (targets.length === 0) return { ok: false, error: 'no_player' };
  sqlite.transaction(() => {
    for (const pid of targets) insertMessage(pid, { kind: hasAttachments(reward) ? 'gift' : 'system', title, body, reward, expiresAt: Math.floor(expiresAt) }, now);
  })();
  audit({ event: 'admin.gift', actorId: actor, targetId: i.all ? '*' : (i.playerId ?? ''), detail: { title, reward, sent: targets.length, expiresAt } });
  return { ok: true, sent: targets.length };
}
