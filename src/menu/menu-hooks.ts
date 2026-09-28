// Small menu-side plumbing (kept out of the component files so they stay
// Fast-Refresh friendly).
import { useEffect, useRef, useState } from 'react';
import { toast } from '../deck-core';
import { nextReset, type ChallengeLists } from './road-data';

// Wall clock for countdowns, re-rendered every `stepMs` (not an animation).
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}

// Call `refetch` just after the current challenge set rolls over (the old set
// would otherwise stay listed while the countdown jumps to the next period).
export function useRefetchAtReset(lists: ChallengeLists | null, refetch: () => void) {
  const cb = useRef(refetch);
  useEffect(() => {
    cb.current = refetch;
  }, [refetch]);
  useEffect(() => {
    if (!lists) return;
    const wait = nextReset(lists, Date.now()) - Date.now() + 1500;
    // setTimeout caps at ~24.8 days; the weekly reset is well inside that.
    const id = window.setTimeout(() => cb.current(), Math.max(1000, Math.min(wait, 2 ** 31 - 1)));
    return () => window.clearTimeout(id);
  }, [lists]);
}

// True while the viewport matches `query` (layout decisions that must mount a
// component once, not twice with one copy hidden by CSS).
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => (typeof window !== 'undefined' ? (window.matchMedia?.(query).matches ?? false) : false));
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

export async function fetchChallenges(): Promise<ChallengeLists | null> {
  try {
    const r = await fetch('/api/challenges', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const d = (await r.json()) as { challenges?: ChallengeLists } & { resetsAt?: ChallengeLists['resetsAt'] };
    if (!d.challenges) return null;
    // `resetsAt` may ride beside the lists or inside them.
    return { ...d.challenges, resetsAt: d.challenges.resetsAt ?? d.resetsAt };
  } catch {
    return null;
  }
}

// Claim a completed challenge's reward; toasts the result. True on success.
export async function claimChallengeReward(id: string): Promise<boolean> {
  try {
    const res = await fetch('/api/challenges/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id }),
    });
    const d = (await res.json()) as { ok?: boolean; xpGained?: number; creditsGained?: number };
    if (res.ok && d.ok) {
      toast(`Reward claimed · +${d.xpGained ?? 0} XP · +${d.creditsGained ?? 0} credits`, { tone: 'ok' });
      return true;
    }
    toast('Could not claim that reward.', { tone: 'err' });
  } catch {
    toast('Network error.', { tone: 'err' });
  }
  return false;
}
