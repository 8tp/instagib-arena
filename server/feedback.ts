// Player feedback / bug reports. The in-game form (FeedbackModal) POSTs here; the
// admin panel reads them back via /api/admin/metrics/feedback. Guests may submit
// (identity = '' like the stats API). This is free-text shown only to admins — it
// is never trusted or rendered to other players — so the guard rails are just
// length caps + a tight rate limit to blunt spam.

import { Router, type Request } from 'express';
import { accountId } from './auth';
import { FEEDBACK_TYPES, findUserById, logEvent, submitFeedback, type FeedbackType } from './db';

export const feedbackRouter = Router();

// --- POST rate limiter (mirrors server/stats.ts) ----------------------------
// Human-typed feedback is low-volume, so the cap is tight: a handful per window
// per identity (the cookie account when present, else the client IP).
const RATE_WINDOW_MS = 10 * 60_000; // rolling 10 min
const RATE_MAX_POSTS = 6;
const postHits = new Map<string, number[]>();

function allowPost(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX_POSTS) {
    postHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  postHits.set(identity, recent);
  return true;
}

// Periodic sweep so identities that stop posting don't linger in the map.
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 4000;

function asType(v: unknown): FeedbackType | null {
  return typeof v === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(v)
    ? (v as FeedbackType)
    : null;
}

function str(req: Request, ...keys: string[]): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string') return v.trim();
  }
  return '';
}

feedbackRouter.post('/feedback', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  const rateKey = id || req.ip || 'unknown';
  if (!allowPost(rateKey, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const type = asType((req.body as Record<string, unknown>)?.type);
  const title = str(req, 'title');
  const text = str(req, 'body', 'description', 'message');

  if (!type) {
    res.status(400).json({ error: 'bad_type' });
    return;
  }
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    res.status(400).json({ error: 'bad_title' });
    return;
  }
  if (text.length < BODY_MIN || text.length > BODY_MAX) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }

  // Display name: trust the account username when logged in; otherwise the
  // client-supplied name (cosmetic only); otherwise Guest.
  const account = id ? findUserById(id) : null;
  const playerName = account?.username || str(req, 'name').slice(0, 32) || 'Guest';

  const newId = submitFeedback({
    playerId: id,
    playerName,
    type,
    title,
    body: text,
    ip: req.ip,
    userAgent: (req.get('user-agent') ?? '').slice(0, 256),
    now,
  });
  if (!newId) {
    res.status(500).json({ error: 'server_error' });
    return;
  }

  logEvent({
    event: 'feedback.submitted',
    actorId: id,
    actorName: playerName,
    targetId: String(newId),
    detail: { type, title },
    ip: req.ip,
    now,
  });

  res.json({ ok: true, id: newId });
});
