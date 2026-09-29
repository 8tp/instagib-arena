// Daily Spin (docs/economy.md §3b) — a Krunker-style wheel. One FREE spin per
// UTC day per account (credits / a free case roll / a plain low-tier item) and
// PREMIUM spins for credits (always an item, Uncommon floor, qualities rolled
// like a case). Fixed, published odds; crypto RNG; one DB transaction each.

import { randomInt } from 'node:crypto';
import { sqlite } from './sqlite';
import {
  addCredits,
  addRolls,
  audit,
  defsForTier,
  econState,
  ensureOnboarded,
  mintItem,
  poolFor,
  q,
  rollQualities,
  rollTier,
  type Rng,
} from './economy';
import {
  SPIN,
  SPIN_SLOTS,
  TIERS,
  type CaseDef,
  type ItemAttrs,
  type SpinInfo,
  type SpinKind,
  type SpinResult,
  type SpinSegment,
  type Tier,
} from '../src/game/items/types';

const defaultRng: Rng = (n) => randomInt(n);
const PPM = 1_000_000;

// A synthetic case over every droppable slot, used for both wheels' item pools.
const spinCase = (odds: Record<Tier, number>): CaseDef => ({
  id: 'vault',
  name: 'Daily Spin',
  blurb: '',
  cost: SPIN.premiumCost,
  slots: SPIN_SLOTS,
  odds,
});
const PREMIUM_CASE = spinCase(SPIN.premium);

export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);
const nextUtcMidnight = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

function lastSpinDay(playerId: string): string {
  return (q(`SELECT last_spin_day FROM instagib_stats WHERE player_id = ?`).get(playerId) as { last_spin_day: string } | undefined)?.last_spin_day ?? '';
}

function nextFreeAt(playerId: string, now: number): number {
  return lastSpinDay(playerId) === dayKey(now) ? nextUtcMidnight(now) : 0;
}

export function pickSegment(rng: Rng = defaultRng): SpinSegment {
  const ppm = SPIN.free.map((s) => Math.round(s.odds * PPM));
  let r = rng(ppm.reduce((a, b) => a + b, 0));
  for (let i = 0; i < SPIN.free.length; i++) {
    if (r < ppm[i]) return SPIN.free[i];
    r -= ppm[i];
  }
  return SPIN.free[0];
}

// Premium effective odds (a tier with no defs falls to the nearest lower tier).
function premiumEffective(): { odds: Record<Tier, number>; pool: Record<Tier, number> } {
  const pool = poolFor(PREMIUM_CASE);
  const odds = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  const count = Object.fromEntries(TIERS.map((t) => [t, t === 'unobtainable' ? 0 : pool.filter((d) => d.tier === t).length])) as Record<Tier, number>;
  for (const t of TIERS) {
    if (SPIN.premium[t] <= 0) continue;
    const landed = defsForTier(PREMIUM_CASE, t, pool);
    if (landed.defs.length) odds[landed.tier] += SPIN.premium[t];
  }
  return { odds, pool: count };
}

export function spinInfo(playerId: string, now = Date.now()): SpinInfo {
  const eff = premiumEffective();
  const st = playerId ? econState(playerId) : { credits: 0, freeRolls: 0 };
  const next = playerId ? nextFreeAt(playerId, now) : 0;
  return {
    free: SPIN.free.map((s) => ({ ...s })),
    premiumCost: SPIN.premiumCost,
    premiumOdds: eff.odds,
    pool: eff.pool,
    freeAvailable: !!playerId && next === 0,
    nextFreeAt: next,
    credits: st.credits,
    freeRolls: st.freeRolls,
  };
}

// Plain low-tier item for the free wheel: no unusual / strange / killstreak —
// finishes keep a pattern seed + wear so each is still a unique mint.
function freeItemAttrs(slot: string, rng: Rng): ItemAttrs {
  return slot === 'finish' ? { seed: rng(1000), wear: rng(1001) / 1000 } : {};
}

export function spin(playerId: string, kind: unknown, rng: Rng = defaultRng, now = Date.now()): SpinResult {
  if (!playerId) return { ok: false, error: 'guest' };
  if (kind !== 'free' && kind !== 'premium') return { ok: false, error: 'bad_kind' };
  const k: SpinKind = kind;
  return sqlite.transaction((): SpinResult => {
    ensureOnboarded(playerId);
    const gained: Extract<SpinResult, { ok: true }>['gained'] = {};
    let segment: string;
    if (k === 'free') {
      if (lastSpinDay(playerId) === dayKey(now)) return { ok: false, error: 'already_spun', nextFreeAt: nextUtcMidnight(now) };
      const seg = pickSegment(rng);
      segment = seg.id;
      const rw = seg.reward;
      if (rw.type === 'credits') {
        addCredits(playerId, rw.amount);
        gained.credits = rw.amount;
      } else if (rw.type === 'roll') {
        addRolls(playerId, 1);
        gained.roll = true;
      } else {
        const pool = poolFor(PREMIUM_CASE);
        const landed = defsForTier(PREMIUM_CASE, rw.tier, pool);
        if (landed.defs.length === 0) return { ok: false, error: 'empty_pool' };
        const def = landed.defs[rng(landed.defs.length)];
        gained.item = mintItem({ owner: playerId, def: def.id, attrs: freeItemAttrs(def.slot, rng), origin: 'spin', meta: { spin: 'free', segment: seg.id } });
        gained.tier = landed.tier;
      }
      q(`UPDATE instagib_stats SET last_spin_day = ? WHERE player_id = ?`).run(dayKey(now), playerId);
    } else {
      if (econState(playerId).credits < SPIN.premiumCost) return { ok: false, error: 'insufficient', need: SPIN.premiumCost };
      const pool = poolFor(PREMIUM_CASE);
      const landed = defsForTier(PREMIUM_CASE, rollTier(PREMIUM_CASE, rng), pool);
      if (landed.defs.length === 0) return { ok: false, error: 'empty_pool' };
      const def = landed.defs[rng(landed.defs.length)];
      const { quality, attrs } = rollQualities(def, landed.tier, rng);
      addCredits(playerId, -SPIN.premiumCost);
      gained.item = mintItem({ owner: playerId, def: def.id, quality, attrs, origin: 'spin', meta: { spin: 'premium' } });
      gained.tier = landed.tier;
      segment = landed.tier;
    }
    audit({
      event: 'spin',
      actorId: playerId,
      targetId: gained.item?.uid ?? playerId,
      detail: { kind: k, segment, credits: gained.credits ?? 0, roll: !!gained.roll, def: gained.item?.def, tier: gained.tier, cost: k === 'premium' ? SPIN.premiumCost : 0 },
    });
    const st = econState(playerId);
    return { ok: true, kind: k, segment, credits: st.credits, freeRolls: st.freeRolls, nextFreeAt: nextFreeAt(playerId, now), gained };
  })();
}
