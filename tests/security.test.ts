import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';

const dataDir = mkdtempSync(join(tmpdir(), 'instagib-security-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'production';
process.env.APP_BASE_URL = 'https://arena.test';
process.env.TRUST_PROXY_HOPS = '0';
process.env.ADMIN_USERNAMES = 'ExistingAdmin,UnclaimedAdmin';
process.env.ADMIN_API_TOKEN = randomBytes(32).toString('hex');
const db = await import('../server/db');
const { sqlite } = await import('../server/sqlite');
const economy = await import('../server/economy');
const rewards = await import('../server/rewards');
const market = await import('../server/market');
const trades = await import('../server/trades');
const { RateLimiter, allowedOrigin, clientIp } = await import('../server/security');
const { encodeReplay, decodeReplay, summarizeReplay } = await import('../src/game/replay-codec');
const { MAPS } = await import('../src/game/arena-map-data');
const { ARENA_NET, ONLINE_MAP_POOL } = await import('../src/game/arena-data');
const { validPlayerMove } = await import('../server/game-validation');
const { rayAabb } = await import('../src/game/collision');
const { decodeState, toView } = await import('../src/game/netcodec');
const { ITEM_DEFS } = await import('../src/game/items/catalog');

let server: ChildProcess;
let url: string;
const sockets = new Set<WebSocket>();
const tokens: Record<string, string> = {};
for (const [id, username] of [['admin', 'ExistingAdmin'], ['alice', 'AliceAudit'], ['bob', 'BobAudit']]) {
  db.createUser({ id, username, usernameLower: username.toLowerCase(), pwHash: '00'.repeat(64), pwSalt: 'test', email: null, createdAt: Date.now() - 48 * 3600_000 });
  tokens[id] = randomBytes(32).toString('base64url');
  db.createSession(tokens[id], id, Date.now());
  sqlite.prepare('UPDATE instagib_stats SET total_xp = 100_000, total_games = 20, credits = 10_000 WHERE player_id = ?').run(id);
}

before(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MAX_WS_PER_IP: '5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stdout?.on('data', (data) => { logs += data; });
  server.stderr?.on('data', (data) => { logs += data; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not boot: ${logs}`);
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  if (server && server.exitCode === null) {
    const exit = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server.kill();
    await exit;
  }
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function request(path: string, body?: unknown, id?: string, extra: Record<string, string> = {}) {
  return fetch(`${url}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://arena.test' }), ...(id ? { Cookie: `igsession=${tokens[id]}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function socket(id?: string, cookie?: string) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/ws/instagib`, { origin: 'https://arena.test', headers: { Cookie: cookie ?? (id ? `igsession=${tokens[id]}` : '') } });
  sockets.add(ws);
  const messages: any[] = [];
  ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString())); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, messages, wait: async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const msg = messages.find((m) => m.type === type);
      if (msg) return msg;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`missing ${type}`);
  } };
}

test('origin allow-list checks scheme and configured origin', () => {
  assert.equal(allowedOrigin('https://arena.test', 'anything'), true);
  for (const origin of ['https://evil.test', 'http://arena.test', 'null', 'https://arena.test/path', 'https://user@arena.test']) assert.equal(allowedOrigin(origin, 'arena.test'), false);
  assert.equal(allowedOrigin(undefined, 'arena.test', true), false);
});
test('direct requests ignore forged proxy and Cloudflare headers', () => {
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }, socket: { remoteAddress: '::ffff:127.0.0.1' } } as IncomingMessage), '127.0.0.1');
});
test('trusted proxy hops resolve from the right and do not trust a forged first hop', () => {
  const req = { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.10.11.12' }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
  assert.equal(clientIp(req, 1), '9.10.11.12');
  assert.equal(clientIp(req, 2), '5.6.7.8');
});
test('Railway uses its overwritten X-Real-IP instead of the extra XFF edge or a Cloudflare header', () => {
  const req = { headers: { 'cf-connecting-ip': '203.0.113.99', 'x-forwarded-for': '198.51.100.7, 152.233.40.2', 'x-real-ip': '198.51.100.7' }, socket: { remoteAddress: '100.64.0.13' } } as IncomingMessage;
  assert.equal(clientIp(req, 1, 'x-real-ip'), '198.51.100.7');
  assert.equal(clientIp(req, 0, 'x-real-ip'), '100.64.0.13');
  req.headers['x-real-ip'] = '::ffff:198.51.100.8';
  assert.equal(clientIp(req, 1, 'x-real-ip'), '198.51.100.8');
  req.headers['x-real-ip'] = '2606:4700::1';
  assert.equal(clientIp(req, 1, 'x-real-ip'), '2606:4700::1');
  req.headers['x-real-ip'] = '198.51.100.8, 1.2.3.4';
  assert.equal(clientIp(req, 1, 'x-real-ip'), '100.64.0.13');
  delete req.headers['x-real-ip'];
  assert.equal(clientIp(req, 1, 'x-real-ip'), '100.64.0.13');
});
test('rate limiter bounds key cardinality and restores expired windows', () => {
  const limiter = new RateLimiter(2, 100, 2);
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 1), true);
  assert.equal(limiter.allow('a', 2), false);
  assert.equal(limiter.allow('b', 2), true);
  assert.equal(limiter.allow('c', 3), false);
  assert.equal(limiter.allow('c', 101), true);
});
test('session tokens are hashed, expire, revoke and cap concurrent sessions', () => {
  const token = randomBytes(32).toString('base64url');
  db.createSession(token, 'alice', Date.now());
  assert.equal(db.userIdFromSession(token), 'alice');
  assert.equal(sqlite.prepare('SELECT 1 FROM instagib_sessions WHERE token = ?').get(token), undefined);
  db.deleteSession(token);
  assert.equal(db.userIdFromSession(token), '');
  const expired = randomBytes(32).toString('base64url');
  db.createSession(expired, 'bob', Date.now() - db.SESSION_MAX_AGE - 1);
  assert.equal(db.userIdFromSession(expired), '');
  for (let i = 0; i < 12; i++) db.createSession(randomBytes(32).toString('base64url'), 'admin', Date.now() + i);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM instagib_sessions WHERE user_id = ?').get('admin') as { n: number }).n, 8);
  // Restore the test admin's HTTP session after the session-cap check.
  db.createSession(tokens.admin, 'admin', Date.now() + 20);
});
test('legacy sessions migrate once and keep the existing browser token usable', () => {
  const legacyDir = mkdtempSync(join(tmpdir(), 'instagib-legacy-session-'));
  const token = randomBytes(32).toString('base64url');
  const env = { ...process.env, DATA_DIR: legacyDir, DATABASE_PATH: join(legacyDir, 'instagib.sqlite') };
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      const sqlite = new Database(process.env.DATABASE_PATH);
      sqlite.exec('CREATE TABLE instagib_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
      sqlite.prepare('INSERT INTO instagib_sessions VALUES (?, ?, ?)').run(${JSON.stringify(token)}, 'legacy-user', Date.now());
      sqlite.close();
    `], { env });
    const boot = `
      import assert from 'node:assert/strict';
      const db = await import('./server/db.ts');
      const { sqlite } = await import('./server/sqlite.ts');
      assert.equal(db.userIdFromSession(${JSON.stringify(token)}), 'legacy-user');
      assert.equal(sqlite.prepare('SELECT token_hashed FROM instagib_sessions').get().token_hashed, 1);
      assert.equal(sqlite.prepare('SELECT token FROM instagib_sessions').get().token.length, 64);
      sqlite.close();
    `;
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', boot], { env });
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
test('configured admins must already exist; public registration grants no admin role', async () => {
  const denied = await request('/auth/register', { username: 'UnclaimedAdmin', password: 'audit-password' });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error, 'reserved');
  const registered = await request('/auth/register', { username: 'NewAuditUser', password: 'audit-password' });
  assert.equal(registered.status, 200);
  assert.equal((await registered.json()).user.isAdmin, false);
  assert.match(registered.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.match(registered.headers.get('set-cookie') ?? '', /Secure/);
  assert.match(registered.headers.get('set-cookie') ?? '', /SameSite=Lax/);
  assert.equal(db.findUserById('admin')?.isAdmin, true);
});
test('API rejects cross-origin writes and never caches personalized data', async () => {
  assert.equal((await request('/auth/logout', {}, 'alice', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/auth/logout', {}, 'alice', { Origin: 'https://sub.arena.test' })).status, 403);
  assert.equal((await request('/auth/logout', {}, 'alice', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(db.userIdFromSession(tokens.alice), 'alice');
  const profile = await request('/profile', undefined, 'alice');
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get('cache-control'), 'no-store');
  assert.match(profile.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});
test('malformed and oversized HTTP bodies fail without stack traces', async () => {
  const malformed = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'bad_request' });
  assert.equal((await request('/auth/login', { data: 'x'.repeat(20_000) })).status, 413);
});
test('metrics token cannot mutate admin state', async () => {
  const headers = { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` };
  assert.equal((await request('/admin/metrics/live', undefined, undefined, headers)).status, 200);
  assert.equal((await request('/admin/codes', undefined, undefined, headers)).status, 403);
  assert.equal((await request('/admin/inventory/alice', undefined, undefined, headers)).status, 403);
  for (const path of ['/admin/grant', '/admin/codes', '/admin/gifts', '/admin/items/mint']) assert.equal((await request(path, {}, undefined, headers)).status, 403);
  assert.equal((await request('/admin/codes', undefined, 'alice')).status, 403);
});
test('reward claims enforce owner, expiry, once-only grants and atomic rollback', () => {
  const gift = rewards.adminSendGift('admin', { playerId: 'alice', title: 'Audit gift', reward: { credits: 13 } });
  assert.equal(gift.ok, true);
  const id = rewards.inboxOf('alice').messages[0].id;
  assert.deepEqual(rewards.claimMessage('bob', id), { ok: false, error: 'not_found' });
  const before = economy.econState('alice').credits;
  assert.equal(rewards.claimMessage('alice', id).ok, true);
  assert.equal(economy.econState('alice').credits, before + 13);
  assert.deepEqual(rewards.claimMessage('alice', id), { ok: false, error: 'claimed' });
  rewards.adminSendGift('admin', { playerId: 'alice', title: 'Expired', reward: { credits: 9 }, expiresAt: Date.now() + 1000 });
  const expiredId = rewards.inboxOf('alice').messages[0].id;
  assert.deepEqual(rewards.claimMessage('alice', expiredId, Date.now() + 2000), { ok: false, error: 'expired' });
  rewards.adminSendGift('admin', { playerId: 'alice', title: 'Stale', reward: { credits: 9 } });
  const staleId = rewards.inboxOf('alice').messages[0].id;
  sqlite.prepare('UPDATE instagib_inbox SET reward = ? WHERE id = ?').run(JSON.stringify({ credits: 9, items: [{ def: 'unknown' }] }), staleId);
  const balance = economy.econState('alice').credits;
  assert.throws(() => rewards.claimMessage('alice', staleId));
  assert.equal(economy.econState('alice').credits, balance);
  assert.equal((sqlite.prepare('SELECT claimed_at FROM instagib_inbox WHERE id = ?').get(staleId) as { claimed_at: number }).claimed_at, 0);
});
test('redeem codes enforce account uniqueness, global uses and shared IP failure limit', () => {
  assert.equal(rewards.adminCreateCode('admin', { code: 'AUDIT-CODE', maxUses: 1, reward: { credits: 11 } }).ok, true);
  assert.equal(rewards.redeemCode('alice', 'AUDIT-CODE', 'network').ok, true);
  assert.deepEqual(rewards.redeemCode('alice', 'AUDIT-CODE', 'network'), { ok: false, error: 'already_redeemed' });
  assert.deepEqual(rewards.redeemCode('bob', 'AUDIT-CODE', 'network'), { ok: false, error: 'used_up' });
  for (let i = 0; i < 10; i++) rewards.redeemCode('alice', 'MISSING', 'shared');
  assert.deepEqual(rewards.redeemCode('bob', 'MISSING', 'shared'), { ok: false, error: 'too_many_attempts' });
});
test('market and trades preserve ownership and reject repeat transfers', () => {
  const def = ITEM_DEFS.find((d) => d.tradable && !d.default && d.tier === 'common')!;
  const item = economy.mintItem({ owner: 'alice', def: def.id, origin: 'admin' });
  assert.equal(economy.equipSlot('bob', def.slot, item.uid).ok, false);
  const listed = market.listItem('alice', item.uid, Math.max(market.priceFloor('common'), 100));
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(market.buyListing('alice', listed.listing.id).ok, false);
  assert.equal(market.unlistItem('bob', listed.listing.id).ok, false);
  assert.equal(market.buyListing('bob', listed.listing.id).ok, true);
  assert.equal(market.buyListing('bob', listed.listing.id).ok, false);
  assert.equal(economy.getItemRow(item.uid)?.owner_id, 'bob');
  const offer = trades.createOffer('bob', { to: 'AliceAudit', giveItems: [item.uid], getItems: [], giveCredits: 0, getCredits: 0 });
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  assert.equal(trades.acceptTrade('bob', offer.trade.id).ok, false);
  assert.equal(trades.acceptTrade('alice', offer.trade.id).ok, true);
  assert.equal(trades.acceptTrade('alice', offer.trade.id).ok, false);
  assert.equal(economy.getItemRow(item.uid)?.owner_id, 'alice');
});
test('daily cases are once per UTC day; staff items stay bound', () => {
  assert.equal(economy.openCase('alice', 'hat', 'daily').ok, true);
  assert.equal(economy.openCase('alice', 'hat', 'daily').ok, false);
  const spec = economy.prepareAdminItem({ def: 'hat.sovereign', bound: false });
  assert.equal(spec.ok, true);
  if (spec.ok) assert.equal(spec.item.bound, true);
});
test('equipment rejects prototype keys before reading or mutating a loadout', async () => {
  const before = economy.equippedOf('alice');
  for (const slot of ['__proto__', 'constructor', 'prototype']) {
    assert.deepEqual(economy.equipSlot('alice', slot, null), { ok: false, error: 'bad_slot' });
    const res = await request('/inventory/equip', { slot, token: null }, 'alice');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_slot');
  }
  assert.deepEqual(economy.equippedOf('alice'), before);
});
test('replay actor IDs are data keys on a dictionary with no prototype', () => {
  const id = '__proto__';
  const data = encodeReplay({ version: 3, hz: 20, mapId: 'causeway', durationMs: 1000, localId: id, won: false,
    profiles: [{ id, name: 'Audit', kind: 'local', hat: 'hat.none', unusual: 'unusual.none', nameColor: 'name.default', team: null }],
    frames: [{ t: 0, poses: { [id]: { x: 1, y: 0, z: 0, yaw: 0, pitch: 0, visible: true } } }], kills: [], shots: [] });
  const poses = decodeReplay(data).frames[0].poses;
  assert.equal(Object.getPrototypeOf(poses), null);
  assert.equal(Object.hasOwn(poses, id), true);
  assert.equal(poses[id].x, 1);
});
test('replay decoder rejects hostile counts and truncated data; normal runs survive', () => {
  const data = encodeReplay({ version: 3, hz: 20, mapId: 'causeway', durationMs: 1000, localId: 'a', won: false,
    profiles: [{ id: 'a', name: 'Alice', kind: 'local', hat: 'hat.none', unusual: 'unusual.none', nameColor: 'name.default', team: null }],
    frames: [{ t: 0, poses: { a: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, visible: true } } }, { t: 1, poses: {} }], kills: [], shots: [] });
  assert.equal(decodeReplay(data).frames.length, 2);
  assert.equal(summarizeReplay(data)?.frameCount, 2);
  const bad = data.slice();
  new DataView(bad.buffer).setUint32(15, 0xffffffff, true);
  assert.equal(summarizeReplay(bad), null);
  assert.equal(summarizeReplay(data.slice(0, 25)), null);
});
test('every arena exposes the same walls to server collision checks', () => {
  for (const { map } of MAPS) {
    const b = map.boxes[0];
    assert.equal(rayAabb({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, b), 2);
    assert.ok(map.boxes.length >= 6);
  }
});
test('movement accepts safe spawns and rejects wall crossings and ceiling escapes', () => {
  for (const id of ONLINE_MAP_POOL) {
    const arena = ARENA_NET[id];
    for (const spawn of arena.spawns) assert.equal(validPlayerMove(id, spawn, spawn), true, `${id}: ${JSON.stringify(spawn)}`);
  }
  // Causeway's west pylon (x −13.75…−11.25, z 3.5…6) stands between these two floor spots.
  assert.equal(validPlayerMove('causeway', { x: -15, y: 0.05, z: 5 }, { x: -10, y: 0.05, z: 5 }), false);
  assert.equal(validPlayerMove('causeway', { x: 0, y: 0.05, z: 0 }, { x: 0, y: 50, z: 0 }), false);
});
test('replay uploads require auth before parsing the body', async () => {
  const res = await fetch(`${url}/api/challenge/weekly/replay`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(1024) });
  assert.equal(res.status, 401);
});
test('malformed WS cookies and JSON cannot break the connection handler', async () => {
  const c = await socket(undefined, 'igsession=%');
  await c.wait('welcome');
  c.ws.send('null'); c.ws.send('[]'); c.ws.send('1');
  c.ws.send(JSON.stringify({ type: 'ping', ts: 1 }));
  assert.equal((await c.wait('pong')).ts, 1);
  c.ws.close();
});
test('position uploads cannot replace the assigned spawn with an arbitrary first pose', async () => {
  const c = await socket('alice');
  c.ws.send(JSON.stringify({ type: 'create', isPublic: false, mode: 'ffa', mapId: 'causeway' }));
  const room = await c.wait('created');
  c.ws.send(JSON.stringify({ type: 'join', roomId: room.roomId }));
  await c.wait('joined');
  const state = new Promise<any>((resolve) => c.ws.on('message', (raw, binary) => { if (binary) { const s = decodeState(toView(raw as Buffer)); if (s?.players.length) resolve(s); } }));
  c.ws.send(JSON.stringify({ type: 'pos', x: 1000, y: 1000, z: 1000, yaw: 0 }));
  const snap = await state;
  assert.ok(Math.abs(snap.players[0].x) < 100);
  assert.ok(Math.abs(snap.players[0].y) < 100);
  c.ws.close();
});
test('game server blocks shots through walls and still awards clear-line hits', { timeout: 20_000 }, async () => {
  const a = await socket('alice');
  const b = await socket('bob');
  const aid = (await a.wait('welcome')).clientId;
  const bid = (await b.wait('welcome')).clientId;
  let state: any;
  a.ws.on('message', (raw, binary) => { if (binary) state = decodeState(toView(raw as Buffer)); });
  a.ws.send(JSON.stringify({ type: 'create', isPublic: false, mode: 'ffa', mapId: 'causeway' }));
  const room = await a.wait('created');
  for (const c of [a, b]) c.ws.send(JSON.stringify({ type: 'join', roomId: room.roomId }));
  const aj = await a.wait('joined');
  await b.wait('joined');
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await pause(100);
  // Walk to a floor cell through moves the server accepts. Spawns can be on a
  // raised deck, so the search runs on two levels — the spawn's height and the
  // floor — and may drop from the first to the second where the way down is clear.
  async function move(c: typeof a, id: string, tx: number, tz: number) {
    const start = state.players.find((p: any) => p.id === id);
    const sx = Math.round(start.x), sz = Math.round(start.z);
    const floor = 0.05;
    const bounds = MAPS.find((m) => m.id === 'causeway')!.map.bounds;
    const high = start.y > 0.5 ? start.y : floor;
    type Cell = [number, number, number];
    const key = (x: number, z: number, y: number) => `${x},${z},${y}`;
    const queue: Cell[] = [[sx, sz, high]];
    const prev = new Map<string, Cell | null>([[key(sx, sz, high), null]]);
    let found: Cell | null = null;
    for (let i = 0; i < queue.length; i++) {
      const [x, z, y] = queue[i];
      if (x === tx && z === tz && y === floor) {
        found = queue[i];
        break;
      }
      const next: Cell[] = [[x + 1, z, y], [x - 1, z, y], [x, z + 1, y], [x, z - 1, y]];
      if (y !== floor) next.push([x, z, floor]);
      for (const [nx, nz, ny] of next) {
        if (nx <= bounds.min.x || nx >= bounds.max.x || nz <= bounds.min.z || nz >= bounds.max.z || prev.has(key(nx, nz, ny))) continue;
        if (!validPlayerMove('causeway', { x, y, z }, { x: nx, y: ny, z: nz })) continue;
        prev.set(key(nx, nz, ny), [x, z, y]);
        queue.push([nx, nz, ny]);
      }
    }
    assert.ok(found, `no accepted path from (${sx}, ${start.y.toFixed(2)}, ${sz}) to (${tx}, ${tz})`);
    const path: Cell[] = [];
    let cursor: Cell | null = found;
    while (cursor) {
      path.unshift(cursor);
      cursor = prev.get(key(...cursor)) ?? null;
    }
    let lastY = path[0][2];
    for (const [x, z, y] of path) {
      // Fall like a player would (the server rejects a 6 m drop in one 30 ms update).
      for (let fy = lastY - 0.4; fy > y; fy -= 0.4) { c.ws.send(JSON.stringify({ type: 'pos', x, y: fy, z, yaw: 0 })); await pause(30); }
      c.ws.send(JSON.stringify({ type: 'pos', x, y, z, yaw: 0 }));
      lastY = y;
      await pause(30);
    }
    await pause(100);
    const current = state.players.find((p: any) => p.id === id);
    assert.ok(Math.abs(current.x - tx) < 0.05 && Math.abs(current.z - tz) < 0.05 && current.y < 0.2, `${id} ended at ${JSON.stringify(current)}`);
  }
  await Promise.all([move(a, aid, -15, 5), move(b, bid, -10, 5)]);
  await pause(Math.max(0, aj.resumeAt - Date.now()) + 100);
  a.ws.send(JSON.stringify({ type: 'shoot', ox: -15, oy: 1.65, oz: 5, dx: 1, dy: 0, dz: 0, maxDist: 220, renderTime: Date.now() }));
  const beam = await b.wait('beam');
  assert.ok(beam.ex <= -13.74); // stopped by the pylon face
  assert.equal(b.messages.some((m) => m.type === 'kill'), false);
  await move(b, bid, -15, 9);
  await pause(1200);
  a.ws.send(JSON.stringify({ type: 'shoot', ox: -15, oy: 1.65, oz: 5, dx: 0, dy: 0, dz: 1, maxDist: 220, renderTime: Date.now() }));
  const kill = await a.wait('kill');
  assert.equal(kill.killerId, aid);
  assert.equal(kill.victimId, bid);
  a.ws.close(); b.ws.close();
});
test('auth attempts share limits even when callers rotate forged forwarding headers', async () => {
  const statuses = [];
  for (let i = 0; i < 14; i++) statuses.push((await request('/auth/login', { username: 'NobodyAudit', password: 'wrong-password' }, undefined, { 'CF-Connecting-IP': `1.2.3.${i}`, 'X-Forwarded-For': `2.3.4.${i}` })).status);
  assert.ok(statuses.includes(401));
  assert.equal(statuses.at(-1), 429);
});
