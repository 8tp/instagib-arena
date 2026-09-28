// Published case rates. The server (GET /api/cases, public) reports the
// EFFECTIVE tier odds, the pool sizes and the quality odds per case; this file
// formats them and provides a client-side fallback (the shared contract in
// items/types.ts) for when that call hasn't landed yet or fails. Shown to
// everyone, guests included.
import { casePoolFor, vaultUnobtainables, type ItemDef } from '../game/items/catalog';
import { CASES, QUALITY_ODDS, TIERS, type Tier } from '../game/items/types';
import type { CaseInfo } from './api';

export const pct = (p: number): string => `${(p * 100).toFixed(p < 0.01 ? 2 : p < 0.1 ? 1 : 0).replace(/\.0+$/, '')}%`;

export type QualityRow = { label: string; odds: string; note?: string; color: string };

// The quality odds rows from a case's `qualityOdds` map.
export function qualityRows(qo: CaseInfo['qualityOdds']): QualityRow[] {
  const rows: QualityRow[] = [];
  if (qo.unusualHat != null)
    rows.push({ label: 'Unusual hat', odds: pct(qo.unusualHat), note: `${pct(qo.unusualHatLegendaryPlus ?? qo.unusualHat)} on Legendary+ hats · random particle effect`, color: '#a855f7' });
  if (qo.unusualEmote != null) rows.push({ label: 'Unusual taunt', odds: pct(qo.unusualEmote), note: 'emotes only · plays its effect around you', color: '#a855f7' });
  if (qo.strange != null) rows.push({ label: 'Strange', odds: pct(qo.strange), note: 'finishes, beams and finishers · counts your kills, ranks up', color: '#cf6a32' });
  if (qo.killstreak != null) rows.push({ label: 'Killstreak', odds: pct(qo.killstreak), note: 'railgun finishes · sheen glows on a ≥5 streak', color: '#ffd24a' });
  if (qo.professional != null) rows.push({ label: 'Professional Killstreak', odds: pct(qo.professional), note: 'a subset of Killstreak · sheen + visor particles', color: '#ff8a1f' });
  return rows;
}

// What can drop from a case (the client catalog's view of its pool).
export function poolOf(c: Pick<CaseInfo, 'slots' | 'pool'>): ItemDef[] {
  const pool = casePoolFor(c.slots);
  return c.pool.unobtainable > 0 ? [...pool, ...vaultUnobtainables().filter((d) => c.slots.includes(d.slot))] : pool;
}

// Fallback case list from the shared contract (nominal odds, no server fallback
// folding) — replaced by the server's reply as soon as it arrives.
export function fallbackCases(): CaseInfo[] {
  return CASES.map((c) => {
    const has = (s: string) => (c.slots as readonly string[]).includes(s);
    const qualityOdds: CaseInfo['qualityOdds'] = {};
    if (has('hat')) {
      qualityOdds.unusualHat = QUALITY_ODDS.unusualHat;
      qualityOdds.unusualHatLegendaryPlus = QUALITY_ODDS.unusualHatLegendaryPlus;
    }
    if (has('emote')) qualityOdds.unusualEmote = QUALITY_ODDS.unusualEmote;
    if (has('finish') || has('beam') || has('finisher')) qualityOdds.strange = QUALITY_ODDS.strange;
    if (has('finish')) {
      qualityOdds.killstreak = QUALITY_ODDS.killstreak;
      qualityOdds.professional = QUALITY_ODDS.professional;
    }
    const base = casePoolFor(c.slots);
    const pool = {} as Record<Tier, number>;
    for (const t of TIERS) pool[t] = t === 'unobtainable' ? vaultUnobtainables().filter((d) => c.slots.includes(d.slot)).length : base.filter((d) => d.tier === t).length;
    return { ...c, premium: !!c.premium, odds: c.odds, nominalOdds: c.odds, pool, qualityOdds };
  });
}
