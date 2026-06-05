// Ranked Duel ladder API (read-only). The rating itself is written only by the
// game server on an authoritative 1v1 result (see server/instagib-game.ts →
// recordRankedResult). These endpoints just surface the ladder + the caller's
// own standing for the lobby UI. Login-gated reads: a guest has no ranked id.

import { Router, type Request } from 'express';
import { getRankedLeaderboard, getRankedProfile } from './db';
import { accountId } from './auth';

export const rankedRouter = Router();

// The caller's own ranked profile (null for guests / never-played). The lobby's
// "your rank" card reads this.
rankedRouter.get('/ranked/me', (req: Request, res) => {
  res.json({ profile: getRankedProfile(accountId(req)) });
});

// The top of the ladder, plus the caller's own standing pinned (so the UI can
// show "you are #N" even when you're off the top page).
rankedRouter.get('/ranked/leaderboard', (req: Request, res) => {
  const entries = getRankedLeaderboard(50);
  res.json({ entries, me: getRankedProfile(accountId(req)) });
});
