// Weekly Challenge API: submit a "1v1 vs hard bot" run + read the weekly board.
// Account-only and SEPARATE from career stats (it never records K/D). The match
// is offline (vs a bot), so the score is client-reported + clamped — best-effort,
// like the career stats, for a cosmetic weekly leaderboard.

import { Router, type Request } from 'express';
import {
  findUserById,
  getWeeklyChallengeLeaderboard,
  getWeeklyChallengeMe,
  recordWeeklyChallenge,
} from './db';
import { accountId } from './auth';
import { DUEL_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';

export const challengeRouter = Router();

const clampInt = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.max(lo, Math.min(hi, n));
};

// Light per-account submit limiter (a run takes minutes; this only blocks spam).
const last = new Map<string, number>();
const MIN_GAP_MS = 5_000;

// Submit a finished challenge run. `won` = reached the frag cap before the bot.
challengeRouter.post('/challenge/weekly', (req: Request, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'account_required' });
    return;
  }
  const now = Date.now();
  if (now - (last.get(id) ?? 0) < MIN_GAP_MS) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  last.set(id, now);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kills = clampInt(body.kills, 0, DUEL_FRAG_LIMIT);
  const won = body.won === true && kills >= DUEL_FRAG_LIMIT; // a win means you hit the cap
  // A real win takes a few seconds minimum; clamp to a plausible window.
  const timeMs = won ? clampInt(body.timeMs, 1_000, 3_600_000) : 0;
  const account = findUserById(id);
  const me = recordWeeklyChallenge(id, account?.username ?? 'Player', kills, won, timeMs, now);
  res.json({ me });
});

// The current week's board + the caller's standing + the run parameters.
challengeRouter.get('/challenge/weekly/leaderboard', (req: Request, res) => {
  res.json({
    entries: getWeeklyChallengeLeaderboard(50),
    me: getWeeklyChallengeMe(accountId(req)),
    map: WEEKLY_CHALLENGE_MAP,
    fragLimit: DUEL_FRAG_LIMIT,
  });
});
