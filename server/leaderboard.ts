// Public, read-only global leaderboard API.
//
// No auth, no cookie — anyone can read the standings. The heavy lifting lives
// in db.ts (one prepared statement per sort column); this router only validates
// query params and shapes the JSON. `sort` is whitelisted to kills|wins|accuracy
// (default kills) and `limit` is parsed/clamped to [1,100] (default 25), so no
// caller input ever reaches SQL unchecked. The main process mounts this under
// /api, exposing GET /api/leaderboard.

import { Router } from 'express';
import { getLeaderboard, getPlayerRank } from './db';

type Sort = 'kills' | 'wins' | 'accuracy';
const SORTS: readonly Sort[] = ['kills', 'wins', 'accuracy'];
const DEFAULT_SORT: Sort = 'kills';
const DEFAULT_LIMIT = 25;

function parseSort(raw: unknown): Sort {
  return SORTS.includes(raw as Sort) ? (raw as Sort) : DEFAULT_SORT;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, n));
}

export const leaderboardRouter = Router();

leaderboardRouter.get('/leaderboard', (req, res) => {
  const sort = parseSort(req.query.sort);
  const limit = parseLimit(req.query.limit);
  const leaderboard = getLeaderboard({ sort, limit });
  // If the caller carries the anonymous progression cookie, also return their
  // own rank + entry so the client can pin "you are #N" even when outside top-N.
  const igpid = (req.cookies?.igpid as string | undefined) ?? '';
  const you = igpid ? getPlayerRank(igpid, sort) : null;
  res.json({ leaderboard, sort, count: leaderboard.length, you });
});
