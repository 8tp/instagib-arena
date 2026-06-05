// Admin / moderation API. Every route requires the caller's session to resolve
// to an account with is_admin = 1 (designate admins via the ADMIN_USERNAMES env
// var — see server/auth.ts). Mounted at /api/admin, so the requireAdmin gate
// only ever runs for admin routes. All state-changing actions are audit-logged.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { accountId } from './auth';
import {
  findAccountByName,
  findUserById,
  getAuditLog,
  getMetricsOverview,
  getMetricsTimeseries,
  getPlayersTable,
  getRecentMatches,
  getRetention,
  logEvent,
  setAdmin,
  setVerified,
  type AccountInfo,
} from './db';

export const adminRouter = Router();

type AdminRequest = Request & { admin: AccountInfo };

// The current request's admin account, or null if the caller isn't an admin.
function currentAdmin(req: Request): AccountInfo | null {
  const id = accountId(req);
  if (!id) return null;
  const u = findUserById(id);
  return u?.isAdmin ? u : null;
}

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const admin = currentAdmin(req);
  if (!admin) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  (req as AdminRequest).admin = admin;
  next();
};
adminRouter.use(requireAdmin);

const cleanUsername = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Set/clear a player's verified blue-check (Krunker-style), by username.
adminRouter.post('/verify', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const value = body.verified !== false; // default true
  setVerified(target.id, value);
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: value ? 'admin.verify' : 'admin.unverify',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, verified: value });
});

// Promote/demote an admin, by username.
adminRouter.post('/grant', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const value = body.admin !== false; // default true
  setAdmin(target.id, value);
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: value ? 'admin.grant' : 'admin.revoke',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, admin: value });
});

// Look up a player's current flags so the admin UI can show/toggle state.
adminRouter.get('/lookup', (req, res) => {
  const target = findAccountByName(cleanUsername(req.query.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ username: target.username, admin: target.isAdmin, verified: target.isVerified });
});

// Recent audit events for moderation review / the future metrics dashboard.
// Optional ?event= filter and ?limit= (clamped server-side).
adminRouter.get('/audit', (req, res) => {
  const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
  const event =
    typeof req.query.event === 'string' && req.query.event ? req.query.event : undefined;
  res.json({ events: getAuditLog(Number.isFinite(rawLimit) ? rawLimit : 100, event) });
});

// ── Metrics dashboard (read-only aggregates) ─────────────────────────────────
// All gated by requireAdmin (router-level). The dashboard at /admin renders these.
const intParam = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

// Headline KPIs + 24h/7d/30d activity windows + live concurrency.
adminRouter.get('/metrics/overview', (_req, res) => {
  res.json({ overview: getMetricsOverview() });
});

// Dense daily series (matches / logins / registrations / active players).
adminRouter.get('/metrics/timeseries', (req, res) => {
  res.json({ series: getMetricsTimeseries(intParam(req.query.days, 30)) });
});

// D1/D7 cohort retention by registration day.
adminRouter.get('/metrics/retention', (req, res) => {
  res.json({ cohorts: getRetention(intParam(req.query.days, 14)) });
});

// Recent recorded matches, keyset-paginated by audit id (?before=<lastId>).
adminRouter.get('/metrics/matches', (req, res) => {
  const before = intParam(req.query.before, 0);
  res.json({ matches: getRecentMatches(intParam(req.query.limit, 50), before > 0 ? before : undefined) });
});

// Searchable player table (?sort=kills|games|level|accuracy|xp|recent &q=&limit=).
adminRouter.get('/metrics/players', (req, res) => {
  const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json({ players: getPlayersTable({ sort, q, limit: intParam(req.query.limit, 100) }) });
});
