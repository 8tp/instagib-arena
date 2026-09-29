// Pure display helpers for item instances (names, tiers, Looks, prices).
// THREE-free. Everything the tiles / panels / market need to read an instance.
import { itemDef, seasonOf } from '../game/items/catalog';
import type { TradeGate } from './api';
import {
  KS_EFFECTS,
  KS_SHEENS,
  MARKET,
  TIER_META,
  TRADE,
  UNUSUAL_EFFECTS,
  SEASONS,
  qualityPrefix,
  seasonName,
  strangeRank,
  wearName,
  type ItemInstanceWire,
  type ItemSlot,
  type Look,
  type Quality,
  type Tier,
} from '../game/items/types';

export const SLOT_LABEL: Record<ItemSlot, string> = {
  hat: 'Hat',
  face: 'Face',
  back: 'Back',
  finish: 'Railgun Finish',
  beam: 'Rail Beam',
  finisher: 'Finisher',
  spawn: 'Spawn Effect',
  emote: 'Emote',
  card: 'Player Card',
  nameColor: 'Name Color',
  title: 'Title',
};
export const SLOT_SHORT: Record<ItemSlot, string> = {
  hat: 'Hat',
  face: 'Face',
  back: 'Back',
  finish: 'Finish',
  beam: 'Beam',
  finisher: 'Finisher',
  spawn: 'Spawn',
  emote: 'Emote',
  card: 'Card',
  nameColor: 'Name',
  title: 'Title',
};

// Credits always read "⛁ 1,234".
export const fmtCredits = (n: number): string => `⛁ ${Math.round(n).toLocaleString()}`;

export const instTier = (i: ItemInstanceWire): Tier => i.tier ?? itemDef(i.def)?.tier ?? 'common';
export const instSlot = (i: ItemInstanceWire): ItemSlot => itemDef(i.def)?.slot ?? 'hat';
export const instBaseName = (i: ItemInstanceWire): string => i.attrs.customName ?? itemDef(i.def)?.name ?? i.def;
export const instBlurb = (i: ItemInstanceWire): string => i.attrs.customDesc ?? itemDef(i.def)?.blurb ?? '';

// "Unusual Top Hat" / "Scarcely Lethal Strange Toxic Finish".
export function instFullName(i: ItemInstanceWire): string {
  const p = qualityPrefix(i.quality, i.attrs);
  const base = instBaseName(i);
  return p ? `${p} ${base}` : base;
}

export const effectName = (id: string | undefined): string | null =>
  (id && UNUSUAL_EFFECTS.find((e) => e.id === id)?.name) || null;
export const sheenInfo = (id: string | undefined) => (id ? (KS_SHEENS.find((s) => s.id === id) ?? null) : null);
export const ksEffectName = (id: string | undefined): string | null => (id && KS_EFFECTS.find((e) => e.id === id)?.name) || null;

export function instLook(i: ItemInstanceWire): Look {
  const a = i.attrs;
  const look: Look = { d: i.def };
  if (a.effect) look.e = a.effect;
  if (a.sheen) look.s = a.sheen;
  if (a.ksEffect) look.k = a.ksEffect;
  if (a.festive || i.quality.includes('festive')) look.f = 1;
  if (a.seed != null) look.p = a.seed;
  if (a.wear != null) look.w = a.wear;
  if (a.tint) look.t = a.tint;
  return look;
}

// Release season of a def: "S0" on tiles, "Season 0" in panels.
export type SeasonTag = { id: number; short: string; name: string; title: string };
export function defSeason(defId: string): SeasonTag | null {
  const d = itemDef(defId);
  if (!d) return null;
  const id = seasonOf(d);
  return { id, short: `S${id}`, name: seasonName(id), title: SEASONS.find((s) => s.id === id)?.title ?? '' };
}

const QUALITY_TONE: Record<Quality, string> = {
  unusual: '#a855f7',
  strange: '#cf6a32',
  festive: '#3bd16f',
  killstreak: '#ffd24a',
  professional: '#ff8a1f',
  founder: '#f59e0b',
  admin: '#ff4fd8',
};
export const qualityTone = (q: Quality): string => QUALITY_TONE[q];

export type Tag = { text: string; color: string };

// The quality prefix as coloured words (same order as qualityPrefix) — the
// reveal card animates these in ahead of the base name.
export function instPrefixParts(i: ItemInstanceWire): Tag[] {
  const q = i.quality;
  const out: Tag[] = [];
  if (q.includes('unusual')) out.push({ text: 'Unusual', color: QUALITY_TONE.unusual });
  if (q.includes('strange')) out.push({ text: strangeRank(i.attrs.kills ?? 0), color: QUALITY_TONE.strange });
  if (q.includes('festive')) out.push({ text: 'Festive', color: QUALITY_TONE.festive });
  if (q.includes('professional')) out.push({ text: 'Professional Killstreak', color: QUALITY_TONE.professional });
  else if (q.includes('killstreak')) out.push({ text: 'Killstreak', color: QUALITY_TONE.killstreak });
  return out;
}
// The attribute pills shown on tiles / the details card, most notable first.
export function instTags(i: ItemInstanceWire): Tag[] {
  const out: Tag[] = [];
  const q = i.quality;
  const a = i.attrs;
  if (q.includes('unusual')) out.push({ text: effectName(a.effect) ?? 'Unusual', color: QUALITY_TONE.unusual });
  if (q.includes('strange')) out.push({ text: `${strangeRank(a.kills ?? 0)} · ${(a.kills ?? 0).toLocaleString()} kills`, color: QUALITY_TONE.strange });
  if (q.includes('professional')) out.push({ text: `Pro Killstreak${a.ksEffect ? ` · ${ksEffectName(a.ksEffect) ?? ''}` : ''}`, color: sheenInfo(a.sheen)?.color ?? QUALITY_TONE.professional });
  else if (q.includes('killstreak')) out.push({ text: `Killstreak · ${sheenInfo(a.sheen)?.name ?? 'Sheen'}`, color: sheenInfo(a.sheen)?.color ?? QUALITY_TONE.killstreak });
  if (q.includes('festive')) out.push({ text: 'Festive', color: QUALITY_TONE.festive });
  if (a.wear != null) out.push({ text: wearName(a.wear), color: '#9fb0c6' });
  if (q.includes('founder')) out.push({ text: 'Founder', color: QUALITY_TONE.founder });
  if (q.includes('admin')) out.push({ text: 'Staff', color: QUALITY_TONE.admin });
  return out;
}

// The one-line attribute string on the tile itself (kept short).
export function instTileSub(i: ItemInstanceWire): string {
  const q = i.quality;
  if (q.includes('unusual')) return effectName(i.attrs.effect) ?? 'Unusual';
  if (q.includes('professional')) return 'Professional';
  if (q.includes('killstreak')) return 'Killstreak';
  if (q.includes('strange')) return `${(i.attrs.kills ?? 0).toLocaleString()} kills`;
  if (i.attrs.wear != null) return wearName(i.attrs.wear);
  if (q.includes('festive')) return 'Festive';
  return '';
}

export const ORIGIN_LABEL: Record<ItemInstanceWire['origin'], string> = {
  case: 'Unboxed from a case',
  spin: 'Won on the Daily Spin',
  code: 'Redeemed from a code',
  gift: 'A gift from the Instagib team',
  admin: 'Granted by staff',
  road: 'Career Road reward',
  challenge: 'Challenge reward',
  founder: 'Founder grant',
  title: 'Earned title',
  market: 'Bought on the market',
  trade: 'Received in a trade',
  legacy: 'Carried over from v2',
};

export const salvageValue = (i: ItemInstanceWire): number => TIER_META[instTier(i)].salvage;
export const marketFloor = (tier: Tier): number => Math.max(MARKET.minPrice, Math.ceil(TIER_META[tier].salvage * MARKET.floorMult));
// Listing fee is paid up front and is non-refundable; the tax comes out of the sale.
export const listingFee = (price: number): number => Math.max(1, Math.round(price * MARKET.listingFeePct));
export const saleTax = (price: number): number => Math.round(price * MARKET.saleTaxPct);
export const saleNet = (price: number): number => price - saleTax(price);

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function timeLeft(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h left`;
}

// Inventory ordering: rarest first, then unusual/strange, then name, then mint.
export function compareInst(a: ItemInstanceWire, b: ItemInstanceWire): number {
  const t = TIER_META[instTier(b)].rank - TIER_META[instTier(a)].rank;
  if (t) return t;
  const qa = a.quality.includes('unusual') ? 2 : a.quality.length ? 1 : 0;
  const qb = b.quality.includes('unusual') ? 2 : b.quality.length ? 1 : 0;
  if (qa !== qb) return qb - qa;
  const n = instBaseName(a).localeCompare(instBaseName(b));
  return n || a.mint - b.mint;
}

// The legacy `unusual.*` catalog id whose effect `kind` matches a v3 effect id
// (the preview's WornHat still drives unusuals by legacy id).
export function legacyUnusualFor(effectId: string | undefined, unusuals: readonly { id: string; kind: string }[]): string {
  const kind = UNUSUAL_EFFECTS.find((e) => e.id === effectId)?.kind;
  return (kind && unusuals.find((u) => u.kind === kind)?.id) || 'unusual.none';
}

// The three trade gates as a checklist. The server reports only the FIRST unmet
// requirement (level → matches → age), so earlier rows are known-good and later
// ones unknown (`ok: null`). A partner only reports pass / fail (`canTrade`).
export type GateRow = { label: string; ok: boolean | null; note?: string };
const GATE_LABELS = [
  `Level ${TRADE.minLevel}+`,
  `${TRADE.minMatches}+ recorded matches`,
  'Account 24 h old',
] as const;
const GATE_ORDER = ['level', 'matches', 'age'] as const;
export function gateRows(g: TradeGate | undefined): GateRow[] {
  if (!g) return [];
  if (g.ok) return GATE_LABELS.map((label) => ({ label, ok: true }));
  const at = GATE_ORDER.indexOf(g.reason as (typeof GATE_ORDER)[number]);
  return GATE_LABELS.map((label, i) => ({ label, ok: at < 0 ? null : i < at ? true : i === at ? false : null }));
}
export function partnerGateRows(canTrade: boolean | undefined): GateRow[] {
  if (canTrade === undefined) return [];
  return GATE_LABELS.map((label) => ({ label, ok: canTrade ? true : null, note: canTrade ? undefined : undefined }));
}

// Only what changes the picture is part of the thumbnail key (an unusual
// effect); pattern seeds / wear are shown as text.
export function thumbLook(inst: ItemInstanceWire | undefined): Look | undefined {
  if (!inst) return undefined;
  const l = instLook(inst);
  return l.e ? { d: l.d, e: l.e } : undefined;
}

