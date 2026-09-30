// Account auth: guest-by-default, optional username/password account (Krunker
// model). Progression keys off the account id — guests save nothing. Passwords
// are scrypt-hashed (Node built-in, no dependency) with a per-user salt and
// compared in constant time. The session is an opaque httpOnly cookie token.

import { Router, type Request } from 'express';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  createSession,
  createUser,
  deleteSession,
  findUserById,
  findUserByName,
  logEvent,
  SESSION_MAX_AGE,
  userIdFromSession,
} from './db';
import { containsProfanity, isReservedName } from './profanity';
import { clientIp, RateLimiter } from './security';

// Usernames designated as admins via the ADMIN_USERNAMES env var (comma- or
// space-separated, case-insensitive). Only existing accounts are promoted at
// boot; configured names are reserved against public registration.
export function adminUsernamesFromEnv(): string[] {
  return (process.env.ADMIN_USERNAMES ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SESSION_COOKIE = 'igsession';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_MAX_AGE,
  path: '/',
};

let activeHashes = 0;
async function hashPw(password: string, salt: string): Promise<Buffer> {
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, (err, hash) => err ? reject(err) : resolve(hash));
    });
  } finally {
    activeHashes--;
  }
}
function genId(): string {
  return randomBytes(12).toString('hex');
}
function genToken(): string {
  return randomBytes(32).toString('base64url');
}

// The account id behind a request's session cookie ('' = guest). This IS the
// progression identity used by the stats API.
export function accountId(req: Request): string {
  const token = req.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' ? userIdFromSession(token) : '';
}

// Same, but from a raw `Cookie:` header — for the game WebSocket upgrade, which
// doesn't go through Express's cookie parser.
export function accountIdFromCookieHeader(header: string | undefined): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      try {
        return userIdFromSession(decodeURIComponent(part.slice(i + 1).trim()));
      } catch {
        return '';
      }
    }
  }
  return '';
}

// Lightweight per-IP attempt limiter so register/login can't be brute-forced.
const attempts = new RateLimiter(12, 60_000);
function rateLimited(ip: string, now: number): boolean {
  return !attempts.allow(ip, now);
}

export const authRouter = Router();

// Who am I? → the account behind the session, or null (guest).
authRouter.get('/auth/me', (req, res) => {
  const id = accountId(req);
  const user = id ? findUserById(id) : undefined;
  res.json({
    user: user
      ? { username: user.username, isAdmin: user.isAdmin, isVerified: user.isVerified }
      : null,
  });
});

authRouter.post('/auth/register', async (req, res, next) => {
  try {
    if (rateLimited(clientIp(req), Date.now())) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const email =
      typeof body.email === 'string' && body.email.trim() ? body.email.trim().slice(0, 200) : null;
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'bad_username' });
      return;
    }
    // Block slurs/profanity (this is the only place a name is human-chosen — see
    // server/profanity.ts) and names reserved for staff / the guest slot.
    if (isReservedName(username) || adminUsernamesFromEnv().includes(username.toLowerCase())) {
      res.status(400).json({ error: 'reserved' });
      return;
    }
    if (containsProfanity(username)) {
      res.status(400).json({ error: 'profane' });
      return;
    }
    if (password.length < 6 || password.length > 200) {
      res.status(400).json({ error: 'bad_password' });
      return;
    }
    const lower = username.toLowerCase();
    if (findUserByName(lower)) {
      res.status(409).json({ error: 'taken' });
      return;
    }
    const salt = randomBytes(16).toString('hex');
    const id = genId();
    if (activeHashes >= 4) {
      res.status(503).json({ error: 'auth_busy' });
      return;
    }
    const pwHash = (await hashPw(password, salt)).toString('hex');
    // Another registration may have completed while hashing ran in a worker.
    if (findUserByName(lower)) {
      res.status(409).json({ error: 'taken' });
      return;
    }
    createUser({
      id,
      username,
      usernameLower: lower,
      pwHash,
      pwSalt: salt,
      email,
      createdAt: Date.now(),
    });
    const token = genToken();
    createSession(token, id, Date.now());
    res.cookie(SESSION_COOKIE, token, cookieOpts);
    logEvent({ event: 'register', actorId: id, actorName: username, ip: clientIp(req) });
    res.json({ user: { username, isAdmin: false, isVerified: false } });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    if (rateLimited(clientIp(req), Date.now())) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username) || password.length < 6 || password.length > 200) {
      res.status(401).json({ error: 'invalid' });
      return;
    }
    if (activeHashes >= 4) {
      res.status(503).json({ error: 'auth_busy' });
      return;
    }
    const user = findUserByName(username.toLowerCase());
    // Always run the hash even on unknown users so timing doesn't leak existence.
    const salt = user?.pw_salt ?? 'x';
    const calc = await hashPw(password, salt);
    const stored = user ? Buffer.from(user.pw_hash, 'hex') : Buffer.alloc(calc.length);
    const ok = !!user && calc.length === stored.length && timingSafeEqual(calc, stored);
    if (!ok) {
      res.status(401).json({ error: 'invalid' });
      return;
    }
    const token = genToken();
    createSession(token, user!.id, Date.now());
    res.cookie(SESSION_COOKIE, token, cookieOpts);
    const acct = findUserById(user!.id);
    logEvent({ event: 'login', actorId: user!.id, actorName: user!.username, ip: clientIp(req) });
    res.json({
      user: { username: user!.username, isAdmin: !!acct?.isAdmin, isVerified: !!acct?.isVerified },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string') deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
