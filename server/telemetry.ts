// Player-journey funnel: the client reports a few coarse steps (menu reached,
// match started, practice-bots started) so the admin metrics can show where new
// players drop off — online matches only reach the audit log once recorded, and
// an abandoned bot match never does. Steps are counts only: they never touch
// stats, XP, or anything another player sees, so they're not trusted beyond an
// allowlist + a rate limit. Logged to the audit table as event 'funnel'.

import { Router } from 'express';
import { accountId } from './auth';
import { logEvent } from './db';
import { clientIp } from './security';

export const FUNNEL_STEPS = ['menu', 'match_start', 'practice_start'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
const MODES = ['online', 'solo', 'training', 'challenge', 'spectate', 'ranked'] as const;
const SOURCES = ['web', 'wavedash'] as const;

export const telemetryRouter = Router();

// A real session emits a handful of steps; this only blunts a spamming client.
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_POSTS = 60;
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

const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

telemetryRouter.post('/telemetry', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const step = pick(body.step, FUNNEL_STEPS);
  if (!step) {
    res.status(400).json({ error: 'bad_step' });
    return;
  }
  const ip = clientIp(req);
  const id = accountId(req);
  if (!allowPost(id || ip, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  logEvent({
    event: 'funnel',
    actorId: id,
    detail: { step, mode: pick(body.mode, MODES), src: pick(body.src, SOURCES) ?? 'web' },
    ip,
  });
  res.status(204).end();
});
