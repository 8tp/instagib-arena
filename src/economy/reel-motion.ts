// Case reel: the strip's contents and its motion curve. Pure (no React, no
// DOM) so the reveal only samples it from its rAF loop.
//
// Motion is a function of elapsed time, never a per-frame step, so it runs the
// same at 30, 60 or 144 Hz. Two phases with a continuous velocity:
//   1. the spin — velocity decays quadratically from v0 to a creep speed v1;
//   2. the creep — v1 falls linearly to zero over the last `creep` seconds,
//      inching over the final cell or so (the near-miss beat).
import { casePoolFor, itemDef, vaultUnobtainables, type ItemDef } from '../game/items/catalog';
import { TIERS, TIER_META, type ItemInstanceWire, type Tier } from '../game/items/types';
import type { CaseInfo } from './api';
import { instTier } from './display';

export type ReelCell = { def: ItemDef; tier: Tier };

export type ReelProfile = { dist: number; t1: number; creep: number; v0: number; v1: number };

// `dist` px in `total` s, of which the last `creep` s cover `creepDist` px.
export function reelProfile(dist: number, total: number, creep: number, creepDist: number): ReelProfile {
  const t1 = Math.max(0.05, total - creep);
  let dc = Math.min(creepDist, dist * 0.4);
  let v1 = (2 * dc) / creep;
  // The spin phase must cover more than it would at a constant creep speed
  // (else v0 < v1); a short hop just shrinks the creep.
  if (dist - dc <= v1 * t1) {
    dc = dist * 0.15;
    v1 = (2 * dc) / creep;
  }
  const dm = dist - dc;
  const v0 = v1 + ((dm - v1 * t1) * 3) / t1;
  return { dist, t1, creep, v0, v1 };
}

export function reelPos(p: ReelProfile, t: number): number {
  if (t <= 0) return 0;
  if (t < p.t1) {
    const k = 1 - t / p.t1;
    return p.v1 * t + ((p.v0 - p.v1) * p.t1 * (1 - k * k * k)) / 3;
  }
  const dm = p.dist - (p.v1 * p.creep) / 2;
  const tau = Math.min(p.creep, t - p.t1);
  return dm + p.v1 * tau - (p.v1 * tau * tau) / (2 * p.creep);
}

export function reelVel(p: ReelProfile, t: number): number {
  if (t <= 0) return p.v0;
  if (t < p.t1) {
    const k = 1 - t / p.t1;
    return p.v1 + (p.v0 - p.v1) * k * k;
  }
  return Math.max(0, p.v1 * (1 - (t - p.t1) / p.creep));
}

export const reelDuration = (p: ReelProfile): number => p.t1 + p.creep;

// A believable reel: tiers drawn from the case's own odds (so the teasers look
// like what the case actually holds), the winner fixed at `land`. `ready(id)`
// says a def's thumbnail is already rendered — teasers prefer those so the
// strip never waits on the thumbnail queue.
export function buildReel(c: CaseInfo, won: ItemInstanceWire, len: number, land: number, ready: (id: string) => boolean): ReelCell[] {
  const pool = casePoolFor(c.slots);
  const unob = vaultUnobtainables().filter((d) => c.slots.includes(d.slot));
  const list = (t: Tier) => (t === 'unobtainable' ? unob : pool.filter((d) => d.tier === t));
  const pick = (from: ItemDef[]): ItemDef | undefined => {
    if (!from.length) return undefined;
    const warm = from.filter((d) => ready(d.id));
    const src = warm.length ? warm : from;
    return src[Math.floor(Math.random() * src.length)];
  };
  const draw = (): ItemDef => {
    let r = Math.random();
    for (const t of TIERS) {
      r -= c.odds[t];
      if (r < 0) {
        const d = pick(list(t));
        if (d) return d;
      }
    }
    return pick(pool) ?? itemDef(won.def)!;
  };
  // Near-miss teases: a high tier just past the winner (what the creep almost
  // reaches), a mid-high one just before it.
  const hi = pool.filter((d) => TIER_META[d.tier].rank >= 3);
  const mid = pool.filter((d) => TIER_META[d.tier].rank >= 2);
  const wonDef = itemDef(won.def)!;
  const out: ReelCell[] = [];
  let prev = '';
  for (let i = 0; i < len; i++) {
    let d: ItemDef;
    if (i === land) d = wonDef;
    else if (i === land + 1) d = pick(hi) ?? draw();
    else if (i === land - 1 || i === land + 3) d = pick(mid) ?? draw();
    else {
      d = draw();
      // No identical neighbours (reads as a stutter at speed).
      for (let k = 0; k < 3 && d.id === prev; k++) d = draw();
    }
    prev = d.id;
    out.push(i === land ? { def: wonDef, tier: instTier(won) } : { def: d, tier: d.tier });
  }
  return out;
}
