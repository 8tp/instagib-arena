// Instagib Arena — authoritative game server, in-process with the Next app.
//
// Served at `/ws/instagib` on the main app port so it rides the existing
// Cloudflare tunnel (wss://<domain>/ws/instagib) — no separate port/process.
//
// ROOMS: every match is a Room. A socket is either a "lister" (browsing the
// lobby) or "in" exactly one room. Quick-match drops you into an open public
// room (or makes one); Create-Match makes a public ("Custom Lobby") or private
// (invite-only) room. Reaching the frag limit starts an end-of-match MAP VOTE,
// then the room resets onto the winning map.
//
// Trust model: the SERVER decides hits. The shooter sends a shot RAY plus the
// server-clock render time it was displaying others at; the server rewinds
// every other player IN THE SAME ROOM to that time (lag compensation) using a
// position history buffer and raycasts their hitboxes. The client supplies only
// the wall-distance cap (`maxDist`) so the server doesn't need arena geometry.
// Spawns / out-of-bounds use the THREE-free `arena-data` table.

import type { WebSocketServer, WebSocket } from 'ws';
import {
  MATCH_FRAG_LIMIT,
  RAIL_COOLDOWN,
  MAX_HORIZONTAL_SPEED,
  EYE_HEIGHT,
} from '../src/game/constants';
import {
  ARENA_NET,
  arenaNet,
  isOutOfBounds,
  ONLINE_MAP_POOL,
  DEFAULT_ARENA_ID,
  MAP_VOTE_DURATION_SEC,
  MAP_VOTE_OPTIONS,
  POST_MATCH_RESET_SEC,
  ROOM_CODE_LEN,
} from '../src/game/arena-data';
import type { Vec3 } from '../src/game/types';

const SNAPSHOT_HZ = 32;
const STALE_CLIENT_TIMEOUT_MS = 10_000;
const EMPTY_ROOM_GRACE_MS = 30_000; // post-match grace for a room that HAS been occupied
const FRESH_ROOM_GRACE_MS = 5 * 60_000; // never-occupied (invite) rooms live longer for slow joins
const KILL_MAX_RANGE = 220;
const SPAWN_INVULN_MS = 2_000;
const HISTORY_MS = 1_000; // how far back we keep position history for rewind
const MAX_REWIND_MS = 350; // clamp how far a shot may rewind targets
const DEFAULT_CAPACITY = 8;
// Anti-cheat / abuse guards. The server is authoritative for hits + score, so
// these are the trust boundary against modified clients.
const SHOT_ORIGIN_MAX_DIST = 3; // shot origin must be within this of the shooter's server eye
const FIRE_RATE_TOLERANCE_MS = 80; // jitter slack under RAIL_COOLDOWN before a shot is dropped
const MAX_MOVE_SPEED = MAX_HORIZONTAL_SPEED * 1.6; // reject pos deltas faster than this (m/s)
const MSG_RATE_WINDOW_MS = 1_000;
const MSG_RATE_LIMIT = 150; // inbound messages/sec before a socket is closed (flood guard)
// Hitbox dims (must match the client's PLAYER_RADIUS / PLAYER_HEIGHT).
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.8;
const HEADSHOT_FRAC = 0.72;

type Vec = Vec3;
type ClientId = string;
type RoomId = string;
type HistorySample = { t: number; x: number; y: number; z: number };

type ClientRecord = {
  id: ClientId;
  socket: WebSocket;
  name: string;
  roomId: RoomId | null; // null while browsing the lobby
  pos: Vec;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnUntilMs: number;
  connectedAt: number;
  lastSeen: number;
  lastRecoverMs: number; // last void-recovery time (debounces stale OOB positions)
  lastShotMs: number; // server-side fire-rate gate
  lastPosMs: number; // for the pos-update speed clamp
  msgWindowStart: number; // inbound message-rate window start
  msgCount: number; // messages seen in the current window
  history: HistorySample[]; // ascending by t
};

type Room = {
  id: RoomId;
  name: string;
  mapId: string;
  isPublic: boolean;
  capacity: number;
  hostId: ClientId | null;
  members: Set<ClientId>;
  state: 'active' | 'voting';
  vote: { options: string[]; votes: Map<ClientId, string>; endsAt: number; winnerId: ClientId | null } | null;
  resumeAt: number; // ms timestamp; shots ignored until then (post-vote breather)
  emptySince: number; // ms timestamp it became empty, 0 if occupied
  wasEverOccupied: boolean; // distinguishes a never-joined invite room from a post-match empty
  createdAt: number;
};

type ClientMessage =
  | { type: 'hello'; name?: string }
  | { type: 'list' }
  | { type: 'create'; name?: string; mapId?: string; isPublic?: boolean; capacity?: number }
  | { type: 'quickmatch'; name?: string }
  | { type: 'join'; roomId?: string; name?: string }
  | { type: 'leave' }
  | { type: 'vote'; mapId?: string }
  | { type: 'pos'; x: number; y: number; z: number; yaw: number; pitch?: number }
  | { type: 'ping'; ts: number }
  | {
      type: 'shoot';
      ox: number;
      oy: number;
      oz: number;
      dx: number;
      dy: number;
      dz: number;
      maxDist?: number;
      renderTime?: number;
    };

function genId(len = 8): ClientId {
  return Math.random().toString(36).slice(2, 2 + len);
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Ray vs axis-aligned box; returns entry distance t (along a unit dir) or null.
function rayAabb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  min: Vec, max: Vec,
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [min.x, min.y, min.z];
  const hi = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (lo[i] - o[i]) * inv;
      let t2 = (hi[i] - o[i]) * inv;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin < 0 ? 0 : tmin;
}

export function attachInstagibWs(wss: WebSocketServer) {
  const clients = new Map<ClientId, ClientRecord>();
  const rooms = new Map<RoomId, Room>();
  const listers = new Set<ClientId>();

  const sendRaw = (socket: WebSocket, msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const broadcastRoom = (room: Room, msg: unknown, exceptId?: ClientId) => {
    const data = JSON.stringify(msg);
    for (const id of room.members) {
      if (id === exceptId) continue;
      const c = clients.get(id);
      if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  };

  // ── Room lifecycle ────────────────────────────────────────────────────
  const genRoomCode = (): RoomId => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      if (!rooms.has(code)) return code;
    }
    return genId(ROOM_CODE_LEN).toUpperCase();
  };

  const isKnownArena = (id: string | undefined): id is string =>
    typeof id === 'string' && Object.prototype.hasOwnProperty.call(ARENA_NET, id);

  const createRoom = (opts: {
    name: string;
    mapId: string;
    isPublic: boolean;
    capacity: number;
    hostId: ClientId | null;
  }): Room => {
    const room: Room = {
      id: genRoomCode(),
      name: opts.name,
      mapId: isKnownArena(opts.mapId) ? opts.mapId : DEFAULT_ARENA_ID,
      isPublic: opts.isPublic,
      capacity: clampInt(opts.capacity, 2, DEFAULT_CAPACITY, DEFAULT_CAPACITY),
      hostId: opts.hostId,
      members: new Set(),
      state: 'active',
      vote: null,
      resumeAt: 0,
      emptySince: Date.now(),
      wasEverOccupied: false,
      createdAt: Date.now(),
    };
    rooms.set(room.id, room);
    return room;
  };

  const pickSpawn = (room: Room, avoid: Vec | null): Vec => {
    const spawns = arenaNet(room.mapId).spawns;
    if (spawns.length === 0) return { x: 0, y: 0.05, z: 0 };
    let best = spawns[Math.floor(Math.random() * spawns.length)];
    if (avoid) {
      // Bias toward the spawn farthest from `avoid` (with a little randomness).
      const shuffled = [...spawns].sort(() => Math.random() - 0.5);
      let bestD = -Infinity;
      for (const s of shuffled) {
        const d = Math.hypot(s.x - avoid.x, s.z - avoid.z);
        if (d > bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    // Small jitter so stacked respawns don't perfectly overlap.
    return { x: best.x + (Math.random() - 0.5), y: best.y, z: best.z + (Math.random() - 0.5) };
  };

  const joinRoom = (record: ClientRecord, room: Room) => {
    leaveRoom(record); // ensure single-room invariant
    listers.delete(record.id);
    record.roomId = room.id;
    room.members.add(record.id);
    room.emptySince = 0;
    room.wasEverOccupied = true;
    if (!room.hostId) room.hostId = record.id;
    // Spawn into the room's current map.
    const spawn = pickSpawn(room, null);
    record.pos = { ...spawn };
    record.yaw = 0;
    record.pitch = 0;
    record.frags = 0;
    record.deaths = 0;
    record.invulnUntilMs = Date.now() + SPAWN_INVULN_MS;
    record.history.length = 0;
    sendRaw(record.socket, {
      type: 'joined',
      roomId: room.id,
      mapId: room.mapId,
      spawn,
      state: room.state,
      fragLimit: MATCH_FRAG_LIMIT,
    });
    // Late joiner during an end-of-match vote: replay the ballot so they get
    // the overlay + pointer release instead of running around firing dead shots.
    if (room.state === 'voting' && room.vote) {
      sendRaw(record.socket, {
        type: 'vote-start',
        options: room.vote.options,
        endsAt: room.vote.endsAt,
        durationMs: MAP_VOTE_DURATION_SEC * 1000,
      });
    }
    broadcastRoom(room, { type: 'peer-joined', clientId: record.id, name: record.name }, record.id);
    broadcastRoomList();
  };

  const leaveRoom = (record: ClientRecord) => {
    if (!record.roomId) return;
    const room = rooms.get(record.roomId);
    record.roomId = null;
    if (!room) return;
    room.members.delete(record.id);
    broadcastRoom(room, { type: 'peer-left', clientId: record.id });
    // Drop their ballot so a departed player can't skew the tally or trip the
    // "everyone voted" early-resolve. Re-check resolution after pruning.
    if (room.vote) {
      room.vote.votes.delete(record.id);
      if (room.state === 'voting' && room.members.size > 0) {
        if (room.vote.votes.size >= room.members.size) resolveVote(room);
        else broadcastRoom(room, { type: 'vote-update', counts: tallyVotes(room) });
      }
    }
    if (room.members.size === 0) {
      room.emptySince = Date.now();
      room.hostId = null;
    } else if (room.hostId === record.id) {
      room.hostId = room.members.values().next().value ?? null;
    }
    broadcastRoomList();
  };

  // ── Lobby listing ─────────────────────────────────────────────────────
  const publicRoomList = () =>
    [...rooms.values()]
      .filter((r) => r.isPublic && r.members.size > 0)
      .sort((a, b) => b.members.size - a.members.size || a.createdAt - b.createdAt)
      .map((r) => ({
        id: r.id,
        name: r.name,
        mapId: r.mapId,
        players: r.members.size,
        capacity: r.capacity,
        state: r.state,
        joinable: r.members.size < r.capacity,
      }));

  const broadcastRoomList = () => {
    if (listers.size === 0) return;
    const payload = JSON.stringify({ type: 'rooms', rooms: publicRoomList() });
    for (const id of listers) {
      const c = clients.get(id);
      if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
    }
  };

  // ── Snapshots ─────────────────────────────────────────────────────────
  const roomSnapshot = (room: Room) => {
    const now = Date.now();
    const players: object[] = [];
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      players.push({
        id: c.id,
        name: c.name,
        x: c.pos.x,
        y: c.pos.y,
        z: c.pos.z,
        yaw: c.yaw,
        pitch: c.pitch,
        frags: c.frags,
        deaths: c.deaths,
        invulnMs: Math.max(0, c.invulnUntilMs - now),
      });
    }
    return { type: 'state' as const, t: now, players };
  };

  // Interpolate a player's position at a past server-clock time `t`.
  const rewind = (c: ClientRecord, t: number): Vec => {
    const h = c.history;
    if (h.length === 0) return { ...c.pos };
    if (t >= h[h.length - 1].t) return { ...c.pos };
    if (t <= h[0].t) return { x: h[0].x, y: h[0].y, z: h[0].z };
    for (let i = h.length - 1; i > 0; i--) {
      const b = h[i];
      const a = h[i - 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t || 1;
        const f = (t - a.t) / span;
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
        };
      }
    }
    return { ...c.pos };
  };

  // ── Map voting ────────────────────────────────────────────────────────
  // `winnerId` is the client who reached the frag limit — the match winner. It
  // rides the vote-start so each client can latch its own win/loss for stats
  // (the match "ends" the moment the vote opens).
  const startVote = (room: Room, winnerId: ClientId | null = null) => {
    room.state = 'voting';
    const pool: string[] = ONLINE_MAP_POOL.filter((m) => m !== room.mapId);
    // Shuffle and take the first N as the ballot.
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const options: string[] = shuffled.slice(0, Math.min(MAP_VOTE_OPTIONS, shuffled.length));
    if (options.length === 0) options.push(room.mapId);
    room.vote = { options, votes: new Map(), endsAt: Date.now() + MAP_VOTE_DURATION_SEC * 1000, winnerId };
    broadcastRoom(room, {
      type: 'vote-start',
      options,
      endsAt: room.vote.endsAt,
      durationMs: MAP_VOTE_DURATION_SEC * 1000,
      winnerId,
    });
    broadcastRoomList();
  };

  const resolveVote = (room: Room) => {
    if (!room.vote) return;
    const counts = new Map<string, number>();
    for (const opt of room.vote.options) counts.set(opt, 0);
    for (const choice of room.vote.votes.values()) {
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
    }
    let winner = room.vote.options[0];
    let bestN = -1;
    const tied: string[] = [];
    for (const [opt, n] of counts) {
      if (n > bestN) {
        bestN = n;
        tied.length = 0;
        tied.push(opt);
      } else if (n === bestN) {
        tied.push(opt);
      }
    }
    winner = tied[Math.floor(Math.random() * tied.length)] ?? winner;

    room.mapId = winner;
    room.state = 'active';
    room.vote = null;
    room.resumeAt = Date.now() + POST_MATCH_RESET_SEC * 1000;

    // Reset scoreboard + reposition everyone onto the new map.
    const now = Date.now();
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      c.frags = 0;
      c.deaths = 0;
      c.history.length = 0;
      c.pos = { ...pickSpawn(room, null) };
      c.invulnUntilMs = now + SPAWN_INVULN_MS + POST_MATCH_RESET_SEC * 1000;
    }
    broadcastRoom(room, {
      type: 'vote-result',
      mapId: winner,
      resumeAt: room.resumeAt,
    });
    broadcastRoomList();
  };

  // ── Shooting ──────────────────────────────────────────────────────────
  const handleShoot = (
    shooter: ClientRecord,
    msg: Extract<ClientMessage, { type: 'shoot' }>,
  ) => {
    if (!shooter.roomId) return;
    const room = rooms.get(shooter.roomId);
    if (!room || room.state !== 'active') return;
    const now = Date.now();
    if (now < room.resumeAt) return; // post-vote breather

    // Fire-rate gate (#2): RAIL_COOLDOWN is only client-enforced, so a modified
    // client could stream shots. Drop anything faster than the cooldown (minus
    // a small jitter tolerance) and stamp the accepted shot time.
    if (now - shooter.lastShotMs < RAIL_COOLDOWN * 1000 - FIRE_RATE_TOLERANCE_MS) return;

    let { dx, dy, dz } = msg;
    const dl = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(dl) || dl < 1e-6) return;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    if (![msg.ox, msg.oy, msg.oz].every(Number.isFinite)) return;

    // Anti-wallhack (#1): the ray is cast from the CLIENT-supplied origin, but
    // the server owns no geometry to occlude with — so a modified client could
    // place the origin flush against any victim and fire through walls. Reject
    // origins implausibly far from the shooter's authoritative server eye. (Lag
    // comp rewinds the victim, not the origin, so honest clients are unaffected.)
    const ex = shooter.pos.x;
    const ey = shooter.pos.y + EYE_HEIGHT;
    const ez = shooter.pos.z;
    if (Math.hypot(msg.ox - ex, msg.oy - ey, msg.oz - ez) > SHOT_ORIGIN_MAX_DIST) return;
    shooter.lastShotMs = now;

    const wallCap = Number.isFinite(msg.maxDist)
      ? Math.min(KILL_MAX_RANGE, Math.max(0, msg.maxDist as number))
      : KILL_MAX_RANGE;
    const rt = Number.isFinite(msg.renderTime)
      ? Math.max(now - MAX_REWIND_MS, Math.min(now, msg.renderTime as number))
      : now - MAX_REWIND_MS;

    let bestId: ClientId | null = null;
    let bestT = Infinity;
    let bestHeadshot = false;
    let bestPos: Vec | null = null;

    for (const id of room.members) {
      if (id === shooter.id) continue;
      const victim = clients.get(id);
      if (!victim) continue;
      if (victim.invulnUntilMs > now) continue;
      const pp = rewind(victim, rt);
      const min: Vec = { x: pp.x - PLAYER_RADIUS, y: pp.y, z: pp.z - PLAYER_RADIUS };
      const max: Vec = { x: pp.x + PLAYER_RADIUS, y: pp.y + PLAYER_HEIGHT, z: pp.z + PLAYER_RADIUS };
      const t = rayAabb(msg.ox, msg.oy, msg.oz, dx, dy, dz, min, max);
      if (t === null || t <= 0 || t >= wallCap || t >= bestT) continue;
      bestT = t;
      bestId = id;
      bestPos = pp;
      const hitY = msg.oy + dy * t;
      bestHeadshot = hitY >= pp.y + PLAYER_HEIGHT * HEADSHOT_FRAC;
    }

    if (!bestId || !bestPos) return;
    const victim = clients.get(bestId);
    if (!victim) return;
    if (dist(shooter.pos, victim.pos) > KILL_MAX_RANGE + 5) return;

    shooter.frags += 1;
    victim.deaths += 1;
    const respawnPos = pickSpawn(room, shooter.pos);
    broadcastRoom(room, {
      type: 'kill',
      killerId: shooter.id,
      killerName: shooter.name,
      victimId: victim.id,
      victimName: victim.name,
      headshot: bestHeadshot,
      victimPos: { ...victim.pos },
      respawnPos,
      t: now,
    });
    victim.pos = { ...respawnPos };
    victim.history.length = 0;
    victim.invulnUntilMs = now + SPAWN_INVULN_MS;

    if (shooter.frags >= MATCH_FRAG_LIMIT) startVote(room, shooter.id);
  };

  // Out-of-bounds recovery: if a live player has fallen out of the world, snap
  // them to a spawn (counts as a death) and tell only them to reposition.
  const recoverIfOob = (c: ClientRecord, room: Room, now: number) => {
    if (room.state !== 'active') return;
    if (!isOutOfBounds(c.pos, arenaNet(room.mapId))) return;
    // Debounce: stale OOB positions can keep arriving for a few frames after we
    // teleport the client, before its respawn applies — only recover once.
    if (now - c.lastRecoverMs < 1500) return;
    c.lastRecoverMs = now;
    const spawn = pickSpawn(room, null);
    c.pos = { ...spawn };
    c.deaths += 1;
    c.history.length = 0;
    c.invulnUntilMs = now + SPAWN_INVULN_MS;
    sendRaw(c.socket, { type: 'respawn', x: spawn.x, y: spawn.y, z: spawn.z, reason: 'void' });
  };

  // ── Connection ────────────────────────────────────────────────────────
  wss.on('connection', (socket: WebSocket) => {
    const id = genId();
    const now = Date.now();
    const record: ClientRecord = {
      id,
      socket,
      name: `Player-${id.slice(0, 4)}`,
      roomId: null,
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      frags: 0,
      deaths: 0,
      invulnUntilMs: 0,
      connectedAt: now,
      lastSeen: now,
      lastRecoverMs: 0,
      lastShotMs: 0,
      lastPosMs: 0,
      msgWindowStart: now,
      msgCount: 0,
      history: [],
    };
    clients.set(id, record);
    sendRaw(socket, { type: 'welcome', clientId: id, serverTime: now });

    socket.on('message', (raw) => {
      const ts = Date.now();
      // Inbound message-rate guard (#2): a flood of pos/shoot/list is a cheap
      // DoS. Count per rolling second and close a socket that blows past the cap.
      if (ts - record.msgWindowStart >= MSG_RATE_WINDOW_MS) {
        record.msgWindowStart = ts;
        record.msgCount = 0;
      }
      record.msgCount += 1;
      if (record.msgCount > MSG_RATE_LIMIT) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      record.lastSeen = ts;
      switch (msg.type) {
        case 'hello':
          if (typeof msg.name === 'string' && msg.name.trim()) {
            record.name = msg.name.slice(0, 24);
          }
          break;

        case 'list':
          listers.add(record.id);
          sendRaw(socket, { type: 'rooms', rooms: publicRoomList() });
          break;

        case 'create': {
          if (typeof msg.name === 'string' && msg.name.trim()) {
            record.name = msg.name.slice(0, 24);
          }
          const isPublic = msg.isPublic !== false; // default public
          const label =
            isPublic ? `${record.name}'s Lobby` : `${record.name}'s Private Match`;
          const room = createRoom({
            name: label,
            mapId: typeof msg.mapId === 'string' ? msg.mapId : DEFAULT_ARENA_ID,
            isPublic,
            capacity: clampInt(msg.capacity, 2, DEFAULT_CAPACITY, DEFAULT_CAPACITY),
            hostId: record.id,
          });
          sendRaw(socket, {
            type: 'created',
            roomId: room.id,
            mapId: room.mapId,
            isPublic: room.isPublic,
          });
          break;
        }

        case 'quickmatch': {
          if (typeof msg.name === 'string' && msg.name.trim()) {
            record.name = msg.name.slice(0, 24);
          }
          // Find the fullest joinable public room that isn't mid-vote. A room
          // that was JUST created (still empty during the matched→join handoff)
          // counts as a target too (#9), so two players who quick-match within
          // the same ~second land together instead of in two separate empties.
          let target: Room | null = null;
          for (const r of rooms.values()) {
            if (!r.isPublic) continue;
            if (r.members.size >= r.capacity) continue;
            if (r.state !== 'active') continue;
            const reserved =
              r.members.size === 0 &&
              !r.wasEverOccupied &&
              ts - r.emptySince < 8_000; // create→join reservation window
            if (r.members.size === 0 && !reserved) continue;
            if (!target || r.members.size > target.members.size) target = r;
          }
          if (!target) {
            const mapId = ONLINE_MAP_POOL[Math.floor(Math.random() * ONLINE_MAP_POOL.length)];
            target = createRoom({
              name: 'Quick Match',
              mapId,
              isPublic: true,
              capacity: DEFAULT_CAPACITY,
              hostId: null,
            });
          }
          sendRaw(socket, { type: 'matched', roomId: target.id, mapId: target.mapId });
          break;
        }

        case 'join': {
          if (typeof msg.name === 'string' && msg.name.trim()) {
            record.name = msg.name.slice(0, 24);
          }
          const room = msg.roomId ? rooms.get(msg.roomId) : undefined;
          if (!room) {
            sendRaw(socket, { type: 'join-failed', reason: 'gone' });
            break;
          }
          if (room.members.size >= room.capacity && !room.members.has(record.id)) {
            sendRaw(socket, { type: 'join-failed', reason: 'full' });
            break;
          }
          joinRoom(record, room);
          break;
        }

        case 'leave':
          leaveRoom(record);
          break;

        case 'vote': {
          if (!record.roomId) break;
          const room = rooms.get(record.roomId);
          if (!room || room.state !== 'voting' || !room.vote) break;
          if (typeof msg.mapId === 'string' && room.vote.options.includes(msg.mapId)) {
            room.vote.votes.set(record.id, msg.mapId);
            broadcastRoom(room, { type: 'vote-update', counts: tallyVotes(room) });
            // Everyone voted → resolve early.
            if (room.vote.votes.size >= room.members.size) resolveVote(room);
          }
          break;
        }

        case 'pos':
          if (
            record.roomId &&
            Number.isFinite(msg.x) &&
            Number.isFinite(msg.y) &&
            Number.isFinite(msg.z) &&
            Number.isFinite(msg.yaw)
          ) {
            // Speed clamp (#3): reject implausible teleports/speedhacks — these
            // positions feed both the snapshot broadcast and lag-comp rewind, so
            // a spoof would poison what every other player sees + shoots. Skip
            // the first packet after a teleport (history cleared by a server
            // respawn/vote) so legitimate repositions aren't flagged.
            const prevPosMs = record.lastPosMs;
            record.lastPosMs = ts;
            if (record.history.length > 0 && prevPosMs > 0) {
              const dtSec = (ts - prevPosMs) / 1000;
              const horiz = Math.hypot(msg.x - record.pos.x, msg.z - record.pos.z);
              if (dtSec > 0 && horiz / dtSec > MAX_MOVE_SPEED) break; // drop, keep last good pos
            }
            record.pos.x = msg.x;
            record.pos.y = msg.y;
            record.pos.z = msg.z;
            record.yaw = msg.yaw;
            if (typeof msg.pitch === 'number' && Number.isFinite(msg.pitch)) {
              record.pitch = msg.pitch;
            }
            record.history.push({ t: ts, x: msg.x, y: msg.y, z: msg.z });
            const cutoff = ts - HISTORY_MS;
            while (record.history.length > 2 && record.history[0].t < cutoff) {
              record.history.shift();
            }
            const room = rooms.get(record.roomId);
            if (room) recoverIfOob(record, room, ts);
          }
          break;

        case 'ping':
          sendRaw(socket, { type: 'pong', ts: msg.ts, serverTime: Date.now() });
          break;

        case 'shoot':
          handleShoot(record, msg);
          break;

        default:
          break;
      }
    });

    socket.on('close', () => {
      leaveRoom(record);
      listers.delete(id);
      clients.delete(id);
    });
    socket.on('error', () => {
      leaveRoom(record);
      listers.delete(id);
      clients.delete(id);
    });
  });

  const tallyVotes = (room: Room): Record<string, number> => {
    const counts: Record<string, number> = {};
    if (!room.vote) return counts;
    for (const opt of room.vote.options) counts[opt] = 0;
    for (const choice of room.vote.votes.values()) {
      counts[choice] = (counts[choice] ?? 0) + 1;
    }
    return counts;
  };

  // ── Timers ────────────────────────────────────────────────────────────
  const snapshotTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.members.size === 0) continue;
      broadcastRoom(room, roomSnapshot(room));
    }
  }, 1000 / SNAPSHOT_HZ);

  const voteTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.state === 'voting' && room.vote && now >= room.vote.endsAt) {
        resolveVote(room);
      }
    }
  }, 250);

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    // Drop stale clients.
    for (const [id, c] of clients) {
      if (now - c.lastSeen > STALE_CLIENT_TIMEOUT_MS) {
        try {
          c.socket.close();
        } catch {
          // ignore
        }
        leaveRoom(c);
        listers.delete(id);
        clients.delete(id);
      }
    }
    // Reap rooms that have been empty past the grace window. A room that has
    // never been joined (a private invite waiting for its first player) gets a
    // much longer grace so sharing a code over chat doesn't race a 30s reap (#16).
    for (const [rid, room] of rooms) {
      if (room.members.size !== 0 || room.emptySince <= 0) continue;
      const grace = room.wasEverOccupied ? EMPTY_ROOM_GRACE_MS : FRESH_ROOM_GRACE_MS;
      if (now - room.emptySince > grace) rooms.delete(rid);
    }
  }, 5000);

  snapshotTimer.unref?.();
  voteTimer.unref?.();
  sweepTimer.unref?.();
}
