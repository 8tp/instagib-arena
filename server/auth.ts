// Account auth: guest-by-default, optional username/password account (Krunker
// model). Progression keys off the account id — guests save nothing. Passwords
// are scrypt-hashed (Node built-in, no dependency) with a per-user salt and
// compared in constant time. The session is an opaque httpOnly cookie token.

import { Router, type Request } from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  createSession,
  createUser,
  deleteSession,
  findUserById,
  findUserByName,
  userIdFromSession,
} from './db';
import { containsProfanity, isReservedName } from './profanity';

const SESSION_COOKIE = 'igsession';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_MAX_AGE,
  path: '/',
};

function hashPw(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64);
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
      return userIdFromSession(decodeURIComponent(part.slice(i + 1).trim()));
    }
  }
  return '';
}

// Lightweight per-IP attempt limiter so register/login can't be brute-forced.
const attempts = new Map<string, { n: number; resetAt: number }>();
const ATTEMPT_WINDOW = 60_000;
const ATTEMPT_MAX = 12;
function rateLimited(ip: string, now: number): boolean {
  const a = attempts.get(ip);
  if (!a || now > a.resetAt) {
    attempts.set(ip, { n: 1, resetAt: now + ATTEMPT_WINDOW });
    return false;
  }
  a.n += 1;
  return a.n > ATTEMPT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now > a.resetAt) attempts.delete(ip);
}, ATTEMPT_WINDOW).unref?.();

export const authRouter = Router();

// Who am I? → the account behind the session, or null (guest).
authRouter.get('/auth/me', (req, res) => {
  const id = accountId(req);
  const user = id ? findUserById(id) : undefined;
  res.json({ user: user ? { username: user.username } : null });
});

authRouter.post('/auth/register', (req, res) => {
  if (rateLimited(req.ip ?? 'unknown', Date.now())) {
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
  if (isReservedName(username)) {
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
  createUser({
    id,
    username,
    usernameLower: lower,
    pwHash: hashPw(password, salt).toString('hex'),
    pwSalt: salt,
    email,
    createdAt: Date.now(),
  });
  const token = genToken();
  createSession(token, id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  res.json({ user: { username } });
});

authRouter.post('/auth/login', (req, res) => {
  if (rateLimited(req.ip ?? 'unknown', Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = findUserByName(username.toLowerCase());
  // Always run the hash even on unknown users so timing doesn't leak existence.
  const salt = user?.pw_salt ?? 'x';
  const calc = hashPw(password, salt);
  const stored = user ? Buffer.from(user.pw_hash, 'hex') : Buffer.alloc(calc.length);
  const ok = !!user && calc.length === stored.length && timingSafeEqual(calc, stored);
  if (!ok) {
    res.status(401).json({ error: 'invalid' });
    return;
  }
  const token = genToken();
  createSession(token, user!.id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  res.json({ user: { username: user!.username } });
});

authRouter.post('/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string') deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
