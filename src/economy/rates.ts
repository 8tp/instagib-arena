// Published case rates: the tier odds (CASES) and the quality odds that apply
// to a case given the slots it can drop. Shown to everyone, guests included.
import { casePoolFor, vaultUnobtainables } from '../game/items/catalog';
import { QUALITY_ODDS, type CaseDef } from '../game/items/types';

export const pct = (p: number): string => `${(p * 100).toFixed(p < 0.01 ? 2 : p < 0.1 ? 1 : 0).replace(/\.0+$/, '')}%`;

// The quality odds that apply to a case, from the slots it can drop.
export function qualityRows(c: CaseDef): { label: string; odds: string; note?: string; color: string }[] {
  const has = (s: string) => (c.slots as readonly string[]).includes(s);
  const rows: { label: string; odds: string; note?: string; color: string }[] = [];
  if (has('hat')) rows.push({ label: 'Unusual hat', odds: pct(QUALITY_ODDS.unusualHat), note: `${pct(QUALITY_ODDS.unusualHatLegendaryPlus)} on Legendary+ hats · random particle effect`, color: '#a855f7' });
  if (has('emote')) rows.push({ label: 'Unusual taunt', odds: pct(QUALITY_ODDS.unusualEmote), note: 'emotes only · plays its effect around you', color: '#a855f7' });
  if (has('finish') || has('beam') || has('finisher')) rows.push({ label: 'Strange', odds: pct(QUALITY_ODDS.strange), note: 'finishes, beams and finishers · counts your kills, ranks up', color: '#cf6a32' });
  if (has('finish')) {
    rows.push({ label: 'Killstreak', odds: pct(QUALITY_ODDS.killstreak), note: 'railgun finishes · sheen glows on a ≥5 streak', color: '#ffd24a' });
    rows.push({ label: 'Professional Killstreak', odds: pct(QUALITY_ODDS.professional), note: 'a subset of Killstreak · sheen + visor particles', color: '#ff8a1f' });
  }
  return rows;
}

export function poolOf(c: CaseDef) {
  const pool = casePoolFor(c.slots);
  return c.odds.unobtainable > 0 ? [...pool, ...vaultUnobtainables()] : pool;
}

