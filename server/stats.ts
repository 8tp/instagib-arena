import { clientIp } from './security';
// Account-bound player stats API.
//
// Progression is tied to a registered account (see server/auth.ts). A guest (no
// session) resolves to an empty id, so the DB layer saves nothing for them. The
// display name is still cosmetic (sent by the client), but the *identity* — what
// the leaderboard and progression key off — is the authenticated account.

import { Router, type Request } from 'express';
import {
  challengeResets,
  claimChallenge,
  findUserById,
  getChallenges,
  getProfile,
  getStats,
  logEvent,
  recordMatch,
} from './db';
import { accountId } from './auth';

// The progression identity for a request: the logged-in account, or '' (guest).
function playerId(req: Request): string {
  return accountId(req);
}

// Rate-limit key: the account when logged in, else the client IP.
export function rateKeyFor(req: Request): string {
  return accountId(req) || clientIp(req);
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
export function allowPost(identity: string, now: number): boolean {
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

// allowPost only prunes a key when that key is hit again, so identities that
// stop posting (rotated cookies / transient IPs) would linger forever. Sweep
// the whole map periodically and drop fully-expired entries so it can't leak.
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

export const statsRouter = Router();

statsRouter.get('/stats', (req, res) => {
  const id = playerId(req);
  res.json({ stats: getStats(id) });
});

statsRouter.post('/stats', (req, res) => {
  // Rate-limit before doing any work. Prefer the existing cookie id (read
  // directly, before playerId() may mint a fresh one) and fall back to the
  // request IP for cookie-less callers. On exceed, reject without recording.
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // OFFLINE-ONLY. Online matches are recorded by the authoritative game server
  // (server/instagib-game.ts → recordMatch, pushed as a WS `progression`
  // message), so this only accepts bot/practice matches (`offline: true`):
  // XP-only (never career totals, leaderboards or titles), scaled down, capped
  // per UTC day, and it never advances challenges or the first-win bonus. The
  // training range is not a match at all.
  if (body.training === true) {
    res.status(400).json({ error: 'training' });
    return;
  }
  // Only an explicit offline match is accepted. An older client bundle still
  // POSTs its online matches (offline:false) — the game server has already
  // recorded those, so refuse rather than record them twice.
  if (body.offline !== true) {
    res.status(400).json({ error: 'offline_only' });
    return;
  }

  // Clamp to PLAUSIBLE per-match values, then cross-validate so a forged body
  // can't manufacture an impossible match (e.g. 100k headshots / 0 kills). The
  // offline XP scale, per-match cap and per-day cap (progression.ts) bound what
  // a forged body can earn; the rate limit bounds the rest.
  const kills = clampInt(body.kills, 200);
  const deaths = clampInt(body.deaths, 500);
  const shotsFired = clampInt(body.shotsFired, 5_000);
  const shotsHit = Math.min(clampInt(body.shotsHit, 5_000), shotsFired);
  // You can't headshot or streak more times than you have kills.
  const headshots = Math.min(clampInt(body.headshots, 200), kills);
  const bestStreak = Math.min(clampInt(body.bestStreak, 200), kills);
  const wins = body.won === true ? 1 : 0;
  const offline = true; // enforced above
  const accuracy = shotsFired > 0 ? (shotsHit / shotsFired) * 100 : 0;
  // Game mode is metadata for the audit row only (drives the admin dashboard's
  // mode breakdown). Whitelisted so a forged body can't pollute the breakdown.
  const mode =
    typeof body.mode === 'string' && ['ffa', 'duel', 'tdm', 'ranked'].includes(body.mode)
      ? body.mode
      : undefined;

  // Leaderboard name is the account username (moderated at registration), never
  // the client-supplied display name — so the standings can't show a forged
  // slur. Guests (id === '') don't record a row at all; the fallback is defensive.
  const account = id ? findUserById(id) : undefined;
  const result = recordMatch({
    playerId: id,
    userName: account?.username ?? cleanName(body.name),
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

  // Audit every recorded match (account + guest) for moderation + future metrics.
  logEvent({
    event: 'match',
    actorId: id,
    actorName: account?.username ?? cleanName(body.name),
    detail: {
      kills,
      deaths,
      won: wins === 1,
      headshots,
      accuracy: Math.round(accuracy),
      offline,
      xp: result.xpGained,
      credits: result.creditsGained,
      mode,
      src: 'post',
    },
    ip: clientIp(req),
  });

  // Stats (legacy shape) plus the full reward payload (legacy xpGained /
  // creditsGained / leveledUp / newUnlocks / progression + the itemized
  // RewardExtras) — the same shape the WS `progression` push uses online.
  res.json(result);
});

// Full profile for the lobby (level/XP/credits/unlocked/equipped + career stats).
statsRouter.get('/profile', (req, res) => {
  const id = playerId(req);
  res.json({ profile: getProfile(id) });
});

// Economy v3: the old per-cosmetic equip / shop / hat-case endpoints moved to the
// inventory API (server/economy-routes.ts). Kept as 410s so a stale client
// bundle gets a clear answer instead of a 404.
//   equip      -> POST /api/inventory/equip {slot, uid|null}
//   shop/buy   -> gone (no shop; earn credits, open cases, use the market)
//   open-case  -> POST /api/cases/open {caseId, useRoll}
for (const route of ['/equip', '/shop/buy', '/shop/open-case']) {
  statsRouter.post(route, (_req, res) => {
    res.status(410).json({ error: 'moved' });
  });
}

// Current daily/weekly challenges with progress + claim state.
statsRouter.get('/challenges', (req, res) => {
  const id = playerId(req);
  const now = Date.now();
  // resetsAt: ms epoch when the daily (00:00 UTC) / weekly (Monday 00:00 UTC) sets rotate.
  res.json({ challenges: getChallenges(id, now), resetsAt: challengeResets(now) });
});

// Claim a completed challenge's reward. Rate-limited + server-validated.
statsRouter.post('/challenges/claim', (req, res) => {
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const challengeId = typeof body.id === 'string' ? body.id : '';
  const result = claimChallenge(id, challengeId, Date.now());
  res.status(result.ok ? 200 : 400).json(result);
});
