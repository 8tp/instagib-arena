// Admin / moderation + metrics API. Mounted at /api/admin. Two ways to authorize:
//   1) a logged-in session whose account has is_admin = 1 (designate admins via
//      the ADMIN_USERNAMES env var — see server/auth.ts). The browser dashboard /
//      mod-tool path; can do everything.
//   2) a bearer token equal to the ADMIN_API_TOKEN env var (Authorization: Bearer
//      <token>, or an X-Admin-Token header). The headless/script/agent path for
//      pulling metrics + traffic. READ-ONLY: state-changing routes (verify/grant)
//      reject token auth and require a real session, so a leaked read token can
//      never mutate accounts. If ADMIN_API_TOKEN is unset, token auth is disabled
//      entirely (session-only). All mutations are audit-logged.

import { timingSafeEqual } from 'node:crypto';
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
  getWeeklyChallengeStats,
  logEvent,
  setAdmin,
  setVerified,
  type AccountInfo,
} from './db';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';

export const adminRouter = Router();

type AdminVia = 'session' | 'token';
type AdminRequest = Request & { admin: AccountInfo; adminVia: AdminVia };

// Live concurrency source. The WS layer owns the real counts; index.ts injects
// them via setLiveCountsSource after attaching the socket. Default zeros so the
// report is well-formed even before the socket attaches.
type LiveCounts = { online: number; inMatch: number; rooms: number };
let liveSource: () => LiveCounts = () => ({ online: 0, inMatch: 0, rooms: 0 });
export function setLiveCountsSource(fn: () => LiveCounts): void {
  liveSource = fn;
}

const API_TOKEN = process.env.ADMIN_API_TOKEN || '';
export const adminApiTokenEnabled = API_TOKEN.length > 0;

// Constant-time check of the request's bearer/header token against ADMIN_API_TOKEN.
// Disabled (always false) when no token is configured.
function tokenOk(req: Request): boolean {
  if (!API_TOKEN) return false;
  const auth = req.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = m ? m[1].trim() : (req.get('x-admin-token') ?? '').trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Synthetic identity for a token caller (never used to mutate — denyToken blocks
// that — so it never lands in an audit row).
const TOKEN_ADMIN: AccountInfo = { id: 'api-token', username: 'api-token', isAdmin: true, isVerified: false };

// The current request's admin account, or null if the caller isn't an admin.
function currentAdmin(req: Request): AccountInfo | null {
  const id = accountId(req);
  if (!id) return null;
  const u = findUserById(id);
  return u?.isAdmin ? u : null;
}

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const admin = currentAdmin(req);
  if (admin) {
    (req as AdminRequest).admin = admin;
    (req as AdminRequest).adminVia = 'session';
    next();
    return;
  }
  if (tokenOk(req)) {
    (req as AdminRequest).admin = TOKEN_ADMIN;
    (req as AdminRequest).adminVia = 'token';
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden' });
};
adminRouter.use(requireAdmin);

// Guard for state-changing routes: a read-only API token may not mutate — only a
// real logged-in admin session can. Returns true (and responds 403) when blocked.
function denyToken(req: Request, res: Response): boolean {
  if ((req as AdminRequest).adminVia === 'token') {
    res.status(403).json({ error: 'session_required' });
    return true;
  }
  return false;
}

const cleanUsername = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Set/clear a player's verified blue-check (Krunker-style), by username.
adminRouter.post('/verify', (req, res) => {
  if (denyToken(req, res)) return;
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
  if (denyToken(req, res)) return;
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

// Live concurrency right now (online players / players in a match / open rooms).
// /api/live is the public version; this mirrors it inside the token-gated API.
adminRouter.get('/metrics/live', (_req, res) => {
  res.json({ live: liveSource() });
});

// Weekly-challenge participation this week (+ the fixed run params).
adminRouter.get('/metrics/weekly', (_req, res) => {
  res.json({
    weekly: { ...getWeeklyChallengeStats(), map: WEEKLY_CHALLENGE_MAP, fragLimit: WEEKLY_CHALLENGE_FRAG_LIMIT },
  });
});

// Tally a recent slice of matches by game mode + online/offline split — a cheap
// "what's actually being played" read for the report (mode lives in match audit
// detail; historical rows without it fall under 'unknown').
function modeBreakdown(limit: number) {
  const rows = getRecentMatches(limit);
  const byMode: Record<string, number> = {};
  let online = 0;
  let offline = 0;
  for (const m of rows) {
    const mode = m.mode ?? 'unknown';
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    if (m.offline) offline += 1;
    else online += 1;
  }
  return { sampled: rows.length, byMode, online, offline };
}

// One-call consolidated snapshot for analysis/agents: KPIs + live concurrency +
// recent daily traffic + what's being played + the weekly challenge. Everything a
// dashboard or an agent needs in a single GET. `days` (default 14) sizes the
// timeseries; `sample` (default 200, max 200) sizes the mode tally.
adminRouter.get('/metrics/report', (req, res) => {
  const days = intParam(req.query.days, 14);
  const sample = intParam(req.query.sample, 200);
  res.json({
    generatedAt: Date.now(),
    via: (req as AdminRequest).adminVia,
    live: liveSource(),
    overview: getMetricsOverview(),
    timeseries: getMetricsTimeseries(days),
    recentModeBreakdown: modeBreakdown(sample),
    weekly: { ...getWeeklyChallengeStats(), map: WEEKLY_CHALLENGE_MAP, fragLimit: WEEKLY_CHALLENGE_FRAG_LIMIT },
  });
});
