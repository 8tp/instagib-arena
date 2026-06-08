// Weekly Challenge API: submit a solo SPEEDRUN run (8p FFA vs easy bots) + read
// the weekly board, plus upload/serve the full-run REPLAY for each board entry.
// Account-only and SEPARATE from career stats (it never records K/D). The match
// is offline (vs bots), so the score is client-reported + clamped — but every
// board-defining run also uploads its complete replay, which anyone can rewatch
// (transparency / anti-cheat) and which the server cross-checks against the
// reported score before storing.

import zlib from 'node:zlib';
import express, { Router, type Request } from 'express';
import {
  findUserById,
  getWeeklyChallengeLeaderboard,
  getWeeklyChallengeMe,
  getWeeklyReplayGz,
  recordWeeklyChallenge,
  storeWeeklyReplay,
} from './db';
import { accountId } from './auth';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';
import { summarizeReplay } from '../src/game/replay-codec';

export const challengeRouter = Router();

const clampInt = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.max(lo, Math.min(hi, n));
};

// Light per-account submit limiter (a run takes minutes; this only blocks spam).
const last = new Map<string, number>();
const MIN_GAP_MS = 5_000;

// A win takes at least a few seconds; cap the run window at an hour.
const MIN_WIN_MS = 1_000;
const MAX_WIN_MS = 3_600_000;
// Upload guards: a recorded run is a few hundred KB gzipped-on-disk; the raw
// upload is bounded here. Validation tolerances are generous (the score is
// client-reported best-effort — the replay just has to plausibly match it).
const MAX_REPLAY_BYTES = 12 * 1024 * 1024;
const TIME_TOLERANCE_MS = 3_000;
const KILL_TOLERANCE = 2;

// Submit a finished challenge run. `won` = you reached the frag cap before any
// bot. Returns the updated standing + whether the client should now upload this
// run's replay (it's the player's new board-defining run).
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
  const kills = clampInt(body.kills, 0, WEEKLY_CHALLENGE_FRAG_LIMIT);
  const won = body.won === true && kills >= WEEKLY_CHALLENGE_FRAG_LIMIT; // a win means you hit the cap
  const timeMs = won ? clampInt(body.timeMs, MIN_WIN_MS, MAX_WIN_MS) : 0;
  const account = findUserById(id);
  const result = recordWeeklyChallenge(id, account?.username ?? 'Player', kills, won, timeMs, now);
  if (!result) {
    res.status(401).json({ error: 'account_required' });
    return;
  }
  res.json({ me: result.me, acceptReplay: result.acceptReplay });
});

// Upload the full-run replay for the caller's just-submitted board-defining run.
// Body is the raw replay-codec binary (application/octet-stream). The server
// decodes its header and stores it only if it plausibly matches the player's
// current board entry (right map, win/loss + time/kills agree within tolerance).
challengeRouter.post(
  '/challenge/weekly/replay',
  express.raw({ type: 'application/octet-stream', limit: MAX_REPLAY_BYTES }),
  (req: Request, res) => {
    const id = accountId(req);
    if (!id) {
      res.status(401).json({ error: 'account_required' });
      return;
    }
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'empty' });
      return;
    }
    const summary = summarizeReplay(buf);
    if (!summary) {
      res.status(400).json({ error: 'bad_replay' });
      return;
    }
    if (summary.mapId !== WEEKLY_CHALLENGE_MAP) {
      res.status(400).json({ error: 'wrong_map' });
      return;
    }
    // The replay must correspond to the player's current board entry (which the
    // immediately-preceding submit set). Reject anything that doesn't line up.
    const me = getWeeklyChallengeMe(id);
    if (!me) {
      res.status(409).json({ error: 'no_entry' });
      return;
    }
    if (summary.won !== me.won) {
      res.status(400).json({ error: 'score_mismatch' });
      return;
    }
    if (me.won) {
      if (Math.abs(summary.durationMs - me.timeMs) > TIME_TOLERANCE_MS) {
        res.status(400).json({ error: 'time_mismatch' });
        return;
      }
    } else if (Math.abs(summary.localKills - me.kills) > KILL_TOLERANCE) {
      res.status(400).json({ error: 'kills_mismatch' });
      return;
    }
    storeWeeklyReplay(
      id,
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      { durationMs: summary.durationMs, kills: summary.localKills, won: summary.won },
    );
    res.json({ ok: true });
  },
);

// Serve a player's stored run for the week as raw replay-codec bytes. Public —
// anyone can rewatch any board entry's run.
challengeRouter.get('/challenge/weekly/replay', (req: Request, res) => {
  const player = typeof req.query.player === 'string' ? req.query.player : '';
  if (!player) {
    res.status(400).json({ error: 'player_required' });
    return;
  }
  const rec = getWeeklyReplayGz(player);
  if (!rec) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  // The blob only changes when the player sets a new board-defining run; a short
  // cache cuts bandwidth on repeated/concurrent watches without serving a beaten
  // run for long.
  res.setHeader('Cache-Control', 'public, max-age=60');
  // The blob is stored gzipped. Serve it as-is with Content-Encoding: gzip so the
  // client inflates it (browsers + Node undici do this transparently) — ~3-5×
  // less bandwidth and no server-side gunzip. Fall back to gunzipping for a rare
  // client that can't take gzip.
  if (req.acceptsEncodings('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.send(rec.gz);
  } else {
    res.send(zlib.gunzipSync(rec.gz));
  }
});

// The current week's board + the caller's standing + the run parameters.
challengeRouter.get('/challenge/weekly/leaderboard', (req: Request, res) => {
  res.json({
    entries: getWeeklyChallengeLeaderboard(50),
    me: getWeeklyChallengeMe(accountId(req)),
    map: WEEKLY_CHALLENGE_MAP,
    fragLimit: WEEKLY_CHALLENGE_FRAG_LIMIT,
  });
});
