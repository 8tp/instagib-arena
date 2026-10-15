import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { sqlite } from './sqlite';
import { createUser, findUserById, findUserByName } from './db';
import { containsProfanity, isReservedName } from './profanity';

const jwks = createRemoteJWKSet(new URL('https://auth.wavedash.com/.well-known/jwks.json'));
const gameCloudIds = new Set((process.env.WAVEDASH_GAME_CLOUD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// Verify both the Wavedash signer and this game's scope. A valid token from
// another game must never authenticate an Instagib account.
export async function verifyWavedashIdentity(token: string, key: JWTVerifyGetKey = jwks, allowedGames = gameCloudIds): Promise<string> {
  const { payload } = await jwtVerify(token, key, {
    issuer: 'https://auth.wavedash.com', audience: 'gameplay.wavedash.com', algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'gcid', 'scope'],
  });
  if (payload.scope !== 'gameplay' || typeof payload.gcid !== 'string' || !allowedGames.has(payload.gcid)
    || typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub)) {
    throw new Error('Invalid Wavedash game identity');
  }
  return payload.sub;
}

sqlite.exec(`CREATE TABLE IF NOT EXISTS instagib_wavedash_accounts (
  wavedash_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);`);

export function hasWavedashAccount(userId: string): boolean {
  return !!sqlite.prepare('SELECT 1 FROM instagib_wavedash_accounts WHERE user_id = ?').get(userId);
}

export function hasWavedashIdentity(wavedashId: string): boolean {
  return !!sqlite.prepare('SELECT 1 FROM instagib_wavedash_accounts WHERE wavedash_id = ?').get(wavedashId);
}

export function wavedashIdForAccount(userId: string): string | null {
  const row = sqlite.prepare('SELECT wavedash_id FROM instagib_wavedash_accounts WHERE user_id = ?').get(userId) as { wavedash_id: string } | undefined;
  return row?.wavedash_id ?? null;
}

// SDK usernames are cosmetic, never identity or permission. Collisions create
// a distinct account; an existing account requires an explicit authenticated link.
export const wavedashAccount = sqlite.transaction((wavedashId: string, displayName: string, linkUserId?: string) => {
  const existing = sqlite.prepare('SELECT user_id FROM instagib_wavedash_accounts WHERE wavedash_id = ?').get(wavedashId) as { user_id: string } | undefined;
  if (existing) {
    if (linkUserId && existing.user_id !== linkUserId) throw new Error('already_linked');
    return findUserById(existing.user_id)!;
  }
  if (linkUserId) {
    if (hasWavedashAccount(linkUserId)) throw new Error('already_linked');
    const account = findUserById(linkUserId);
    if (!account) throw new Error('invalid_account');
    sqlite.prepare('INSERT INTO instagib_wavedash_accounts VALUES (?, ?, ?)').run(wavedashId, linkUserId, Date.now());
    return account;
  }
  const digest = createHash('sha256').update(wavedashId).digest('hex');
  const id = `wd_${digest.slice(0,32)}`;
  const proposed = displayName.replace(/[^a-zA-Z0-9_]/g, '').slice(0,20);
  const staff = (process.env.ADMIN_USERNAMES ?? '').toLowerCase().split(/[,\s]+/);
  const safeName = proposed.length >= 3 && !containsProfanity(proposed) && !isReservedName(proposed) && !staff.includes(proposed.toLowerCase());
  const username = safeName && !findUserByName(proposed.toLowerCase()) ? proposed : `Wavedash_${digest.slice(0,11)}`;
  // No password credential is created for a platform-only account.
  createUser({ id, username, usernameLower: username.toLowerCase(), pwHash: '', pwSalt: '', email: null, createdAt: Date.now() });
  sqlite.prepare('INSERT INTO instagib_wavedash_accounts VALUES (?, ?, ?)').run(wavedashId, id, Date.now());
  return findUserById(id)!;
});
