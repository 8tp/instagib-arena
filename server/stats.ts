// Anonymous, cookie-based player stats API.
//
// There is no login. On the first request we mint a random player id and store
// it in an httpOnly cookie; every subsequent request from that browser carries
// it back, so stats persist per-browser without any auth provider. The display
// name is cosmetic (sent by the client from local settings).

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  buyCosmetic,
  claimChallenge,
  getChallenges,
  getProfile,
  getStats,
  openCase,
  recordMatch,
  setEquipped,
} from './db';

const COOKIE_NAME = 'igpid';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const PID_RE = /^[a-f0-9-]{16,64}$/i;

function playerId(req: Request, res: Response): string {
  const existing = req.cookies?.[COOKIE_NAME];
  if (typeof existing === 'string' && PID_RE.test(existing)) return existing;
  const id = randomUUID();
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
  return id;
}

// Clamp client-reported integers into a sane range — these are unranked,
// best-effort stats from a client-authoritative game (no anti-cheat).
function clampInt(value: unknown, max: number): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(max, n));
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return 'Player';
  const trimmed = value.trim().slice(0, 24);
  return trimmed || 'Player';
}

// --- POST rate limiter ------------------------------------------------------
//
// Dependency-free, in-memory sliding window. Keyed by the player cookie id when
// present, else the request IP, so a single browser (or IP) can't spam match
// submissions. We keep recent POST timestamps per identity, drop ones older
// than the window before counting, and reject once the count hits the cap.
// State is process-local (fine for a single Node process); pruning on each call
// keeps the map from growing without bound.
const RATE_WINDOW_MS = 60_000; // rolling 60s window
const RATE_MAX_POSTS = 30; // at most 30 POSTs per identity per window
const postHits = new Map<string, number[]>();

// Returns true if this POST is allowed; records the hit when so.
function allowPost(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX_POSTS) {
    // Keep the pruned list so it can't grow, but don't add this rejected hit.
    postHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  postHits.set(identity, recent);
  return true;
}

export const statsRouter = Router();

statsRouter.get('/stats', (req, res) => {
  const id = playerId(req, res);
  res.json({ stats: getStats(id) });
});

statsRouter.post('/stats', (req, res) => {
  // Rate-limit before doing any work. Prefer the existing cookie id (read
  // directly, before playerId() may mint a fresh one) and fall back to the
  // request IP for cookie-less callers. On exceed, reject without recording.
  const existingPid = req.cookies?.[COOKIE_NAME];
  const rateKey =
    typeof existingPid === 'string' && PID_RE.test(existingPid)
      ? existingPid
      : req.ip ?? 'unknown';
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const id = playerId(req, res);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Clamp to PLAUSIBLE per-match values, then cross-validate so a forged body
  // can't manufacture an impossible match (e.g. 100k headshots / 0 kills) to
  // farm cosmetic XP. This is a client-authoritative game with no in-match
  // anti-cheat, so these caps — plus the per-match XP cap and rate limit — are
  // what bound progression abuse. Stakes are low (cosmetic-only, self-affecting).
  const kills = clampInt(body.kills, 200);
  const deaths = clampInt(body.deaths, 500);
  const shotsFired = clampInt(body.shotsFired, 5_000);
  const shotsHit = Math.min(clampInt(body.shotsHit, 5_000), shotsFired);
  // You can't headshot or streak more times than you have kills.
  const headshots = Math.min(clampInt(body.headshots, 200), kills);
  const bestStreak = Math.min(clampInt(body.bestStreak, 200), kills);
  const wins = body.won === true ? 1 : 0;
  const offline = body.offline === true;
  const accuracy = shotsFired > 0 ? (shotsHit / shotsFired) * 100 : 0;

  const result = recordMatch({
    playerId: id,
    userName: cleanName(body.name),
    kills,
    deaths,
    wins,
    bestStreak,
    headshots,
    shotsFired,
    shotsHit,
    accuracy,
    offline,
    now: Date.now(),
  });

  // Stats (legacy shape) plus the progression delta so the client can show the
  // end-of-match XP bar / LEVEL UP / new-unlock moment immediately.
  res.json({
    stats: result.stats,
    xpGained: result.xpGained,
    creditsGained: result.creditsGained,
    leveledUp: result.leveledUp,
    newUnlocks: result.newUnlocks,
    progression: result.progression,
  });
});

// Full profile for the lobby (level/XP/credits/unlocked/equipped + career stats).
statsRouter.get('/profile', (req, res) => {
  const id = playerId(req, res);
  res.json({ profile: getProfile(id) });
});

// Equip an owned cosmetic. Rate-limited + server-validated.
statsRouter.post('/equip', (req, res) => {
  const existingPid = req.cookies?.[COOKIE_NAME];
  const rateKey =
    typeof existingPid === 'string' && PID_RE.test(existingPid) ? existingPid : req.ip ?? 'unknown';
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req, res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slot = typeof body.slot === 'string' ? body.slot : '';
  const cosmeticId = typeof body.id === 'string' ? body.id : '';
  const result = setEquipped(id, slot, cosmeticId);
  res.status(result.ok ? 200 : 400).json(result);
});

// Buy a credits-priced cosmetic. Rate-limited + server-validated.
statsRouter.post('/shop/buy', (req, res) => {
  const existingPid = req.cookies?.[COOKIE_NAME];
  const rateKey =
    typeof existingPid === 'string' && PID_RE.test(existingPid) ? existingPid : req.ip ?? 'unknown';
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req, res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cosmeticId = typeof body.id === 'string' ? body.id : '';
  const result = buyCosmetic(id, cosmeticId);
  res.status(result.ok ? 200 : 400).json(result);
});

// Open a hat case (credits-funded, server-authoritative roll). Rate-limited.
statsRouter.post('/shop/open-case', (req, res) => {
  const existingPid = req.cookies?.[COOKIE_NAME];
  const rateKey =
    typeof existingPid === 'string' && PID_RE.test(existingPid) ? existingPid : req.ip ?? 'unknown';
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req, res);
  res.status(200).json(openCase(id));
});

// Current daily/weekly challenges with progress + claim state.
statsRouter.get('/challenges', (req, res) => {
  const id = playerId(req, res);
  res.json({ challenges: getChallenges(id, Date.now()) });
});

// Claim a completed challenge's reward. Rate-limited + server-validated.
statsRouter.post('/challenges/claim', (req, res) => {
  const existingPid = req.cookies?.[COOKIE_NAME];
  const rateKey =
    typeof existingPid === 'string' && PID_RE.test(existingPid) ? existingPid : req.ip ?? 'unknown';
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req, res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const challengeId = typeof body.id === 'string' ? body.id : '';
  const result = claimChallenge(id, challengeId, Date.now());
  res.status(result.ok ? 200 : 400).json(result);
});
