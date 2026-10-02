// Personal bests for the training challenges — local only (localStorage).
// Training never reports anything to the server: no XP, no stats, no
// leaderboard, so a best here is purely your own benchmark.

import type { ChallengeId } from './layout';

// A finished run. `score` is what ranks runs: hits for the timed aim
// challenges (higher is better), seconds for the races (lower is better).
export type RunRecord = {
  score: number;
  hits: number;
  shots: number;
  landed?: number; // shots that hit something (older records: use hits)
  penalty: number; // seconds added (Gauntlet: targets left standing × 2)
  at: number; // Date.now()
};

// Ghost of the best race: feet positions sampled every GHOST_STEP seconds
// plus the split time at each gate.
export type GhostRecord = {
  step: number;
  xyz: number[]; // flat [x, y, z, x, y, z, …] rounded to cm
  splits: number[];
};

// v2: Flick got a fast rail, Strafers player-sized hitboxes and the course
// new boost gaps — v1 bests and ghosts no longer compare, so they start over.
const KEY = 'instagib-training-v2';

type Store = {
  best: Partial<Record<ChallengeId, RunRecord>>;
  ghost: Partial<Record<ChallengeId, GhostRecord>>;
};

const IDS: ChallengeId[] = ['flick', 'strafers', 'course', 'gauntlet'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Anything malformed (hand-edited, from an older build) is dropped, per record.
function load(): Store {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      const best: Store['best'] = {};
      const ghost: Store['ghost'] = {};
      for (const id of IDS) {
        const b = s.best?.[id];
        if (b && isNum(b.score) && isNum(b.hits) && isNum(b.shots) && isNum(b.penalty)) best[id] = b;
        const g = s.ghost?.[id];
        if (g && isNum(g.step) && g.step > 0 && Array.isArray(g.xyz) && g.xyz.every(isNum) && g.xyz.length % 3 === 0 && Array.isArray(g.splits) && g.splits.every(isNum)) ghost[id] = g;
      }
      return { best, ghost };
    }
  } catch {
    // Corrupt or blocked storage — start clean.
  }
  return { best: {}, ghost: {} };
}

function save(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota / private mode: bests just don't persist this session.
  }
}

export const LOWER_IS_BETTER: Record<ChallengeId, boolean> = {
  flick: false,
  strafers: false,
  course: true,
  gauntlet: true,
};

export function isBetter(id: ChallengeId, run: RunRecord, prev: RunRecord | undefined): boolean {
  if (!prev) return true;
  if (run.score !== prev.score) return LOWER_IS_BETTER[id] ? run.score < prev.score : run.score > prev.score;
  // Tie on hits: the more accurate run wins.
  const acc = (r: RunRecord) => (r.shots > 0 ? Math.min(r.hits, r.landed ?? r.hits) / r.shots : 0);
  return acc(run) > acc(prev);
}

export class TrainingBests {
  private s = load();

  best(id: ChallengeId): RunRecord | undefined {
    return this.s.best[id];
  }

  ghost(id: ChallengeId): GhostRecord | undefined {
    return this.s.ghost[id];
  }

  // Records the run if it beats the stored best; returns true when it did.
  submit(id: ChallengeId, run: RunRecord, ghost?: GhostRecord): boolean {
    if (!isBetter(id, run, this.s.best[id])) return false;
    this.s.best[id] = run;
    if (ghost) this.s.ghost[id] = ghost;
    save(this.s);
    return true;
  }
}
