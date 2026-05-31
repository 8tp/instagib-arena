import type { GameMode } from './constants';
import type { CardPayload } from './types';

export type Vec3 = { x: number; y: number; z: number };

export type RemotePlayerSnapshot = {
  id: string;
  name: string;
  pos: Vec3;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnMs: number; // remaining spawn-protection ms, 0 = killable
  team: number | null; // team index in TDM; null otherwise
  hat: string; // equipped hat cosmetic id
  unusual: string; // equipped unusual-effect cosmetic id
  emote: string; // equipped podium-emote cosmetic id
  receivedAt: number;
};

export type KillEvent = {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  headshot: boolean;
  victimPos: Vec3;
  respawnPos: Vec3;
  killerCard?: CardPayload;
  t: number;
};

type StatePlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnMs: number;
  team?: number | null;
  hat?: string;
  unusual?: string;
  emote?: string;
};

type WelcomeMessage = { type: 'welcome'; clientId: string; serverTime: number };
type StateMessage = { type: 'state'; t: number; players: StatePlayer[]; resumeAt?: number };
type KillBroadcast = {
  type: 'kill';
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  headshot: boolean;
  victimPos: Vec3;
  respawnPos: Vec3;
  killerCard?: CardPayload;
  t: number;
};
type JoinedMessage = {
  type: 'joined';
  roomId: string;
  mode?: GameMode;
  team?: number | null;
  mapId: string;
  spawn: Vec3;
  state: 'active' | 'voting';
  fragLimit: number;
  roundsToWin?: number;
  resumeAt?: number; // warmup/breather end (server clock)
};
type VoteStartMessage = {
  type: 'vote-start';
  options: string[];
  endsAt: number; // server-clock ms
  durationMs: number;
  winnerId?: string | null; // client who reached the frag limit (match winner)
  winnerTeam?: number | null; // winning team index in TDM
};
type RoundMessage = {
  type: 'round';
  roundNum: number;
  roundWins: Record<string, number>;
  winnerId: string | null; // who won the round that just ended
  resumeAt: number; // server-clock ms; play resumes after this breather
};
type VoteUpdateMessage = { type: 'vote-update'; counts: Record<string, number> };
type VoteResultMessage = { type: 'vote-result'; mapId: string; resumeAt: number };
type RespawnMessage = { type: 'respawn'; x: number; y: number; z: number; reason?: string };
type ServerMessage =
  | WelcomeMessage
  | StateMessage
  | KillBroadcast
  | JoinedMessage
  | VoteStartMessage
  | VoteUpdateMessage
  | VoteResultMessage
  | RoundMessage
  | RespawnMessage
  | { type: 'join-failed'; reason: string }
  | { type: 'peer-joined'; clientId: string; name: string }
  | { type: 'peer-left'; clientId: string }
  | { type: 'pong'; ts: number; serverTime: number }
  | { type: 'error'; message: string };

export type NetStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type NetListener = (
  remotes: Map<string, RemotePlayerSnapshot>,
  meta: { status: NetStatus; clientId: string | null; peers: number },
) => void;

export type KillListener = (ev: KillEvent) => void;

// Room / match lifecycle events the Game subscribes to.
export type NetEvents = {
  onKill: KillListener;
  onJoined?: (info: {
    roomId: string;
    mapId: string;
    spawn: Vec3;
    state: 'active' | 'voting';
    mode: GameMode;
    team: number | null;
    roundsToWin: number | null;
  }) => void;
  onJoinFailed?: (reason: string) => void;
  onRespawn?: (pos: Vec3, reason: string) => void;
  onVoteStart?: (v: {
    options: string[];
    endsAtClient: number;
    durationMs: number;
    winnerId: string | null;
    winnerTeam: number | null;
  }) => void;
  onVoteUpdate?: (counts: Record<string, number>) => void;
  onVoteResult?: (r: { mapId: string; resumeAtClient: number }) => void;
  onRound?: (r: {
    roundNum: number;
    roundWins: Record<string, number>;
    winnerId: string | null;
    resumeAtClient: number;
  }) => void;
};

const RECONNECT_DELAY_MS = 1500;
const PING_INTERVAL_MS = 1000;
// Render remote players this far in the past so we always have two snapshots to
// interpolate between (covers the 31.25ms snapshot interval + jitter). The
// server rewinds to the same render time when resolving our shots, so what we
// aim at is what the server tests — that's the lag compensation contract.
const INTERP_DELAY_MS = 100;
const SNAP_BUFFER_MS = 1200;

type BufferedSnapshot = { t: number; players: Map<string, StatePlayer> };

export class NetClient {
  private ws: WebSocket | null = null;
  private url: string;
  private name: string;
  private roomId: string;
  private listener: NetListener;
  private events: NetEvents;
  clientId: string | null = null;
  status: NetStatus = 'idle';
  // Interpolated view of remote players, refreshed by interpolate() each frame.
  remotes = new Map<string, RemotePlayerSnapshot>();
  localHat = 'hat.none'; // equipped hat id, sent to the server so remotes render it
  localUnusual = 'unusual.none'; // equipped unusual-effect id
  localEmote = 'emote.cheer'; // equipped podium-emote id (shown on the results podium)
  localCard: CardPayload | null = null; // playercard shown on the victim's killcam
  localFrags = 0;
  localDeaths = 0;
  localInvulnMs = 0;
  localTeam: number | null = null; // your team index in TDM; null otherwise
  mode: GameMode = 'ffa';
  rttMs = 0;
  // Warmup / breather end, converted to the local clock. `warmupMsLeft` drives
  // the client's "GET READY" countdown; 0 once play is live.
  private warmupUntilClient = 0;
  private clockOffset = 0; // serverClock - clientClock (ms); estimatedServerNow = Date.now() + offset
  private clockSeeded = false;
  private snapBuffer: BufferedSnapshot[] = [];
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { url: string; name: string; roomId: string; listener?: NetListener; events: NetEvents }) {
    this.url = opts.url;
    this.name = opts.name;
    this.roomId = opts.roomId;
    this.listener = opts.listener ?? (() => {});
    this.events = opts.events;
  }

  connect() {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    try {
      this.setStatus('connecting');
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.warn('[instagib-net] failed to construct WebSocket', err);
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.setStatus('open');
      this.send({ type: 'join', name: this.name, roomId: this.roomId });
      this.startPing();
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as ServerMessage;
        this.handle(msg);
      } catch {
        // ignore malformed
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.clientId = null;
      this.remotes.clear();
      this.snapBuffer.length = 0;
      this.stopPing();
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.setStatus('error');
    };
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  sendPosition(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.send({ type: 'pos', x, y, z, yaw, pitch });
  }

  sendVote(mapId: string) {
    this.send({ type: 'vote', mapId });
  }

  // Server-authoritative, lag-compensated shot. We send the ray + the wall
  // distance cap (so the server needn't own the geometry) + the server-clock
  // render time we were displaying others at, so the server rewinds to match.
  sendShot(origin: Vec3, dir: Vec3, maxDist: number) {
    this.send({
      type: 'shoot',
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      maxDist,
      renderTime: this.estimatedServerNow() - INTERP_DELAY_MS,
    });
  }

  estimatedServerNow(): number {
    return Date.now() + this.clockOffset;
  }

  // Equip a hat: remember it and tell the server (which echoes it in snapshots so
  // other players render it). Safe to call before connect — sent on the next hello.
  setLocalHat(id: string): void {
    this.localHat = id;
    this.send({ type: 'hat', id });
  }

  setLocalUnusual(id: string): void {
    this.localUnusual = id;
    this.send({ type: 'unusual', id });
  }

  setLocalEmote(id: string): void {
    this.localEmote = id;
    this.send({ type: 'emote', id });
  }

  setLocalCard(card: CardPayload): void {
    this.localCard = card;
    this.send({ type: 'card', card });
  }

  // ms until the current warmup/breather ends (0 once play is live).
  get warmupMsLeft(): number {
    return Math.max(0, this.warmupUntilClient - Date.now());
  }

  // Convert a server-clock `resumeAt` to the local clock and stash it.
  private setResume(serverResumeAt: number | undefined) {
    if (typeof serverResumeAt === 'number' && Number.isFinite(serverResumeAt)) {
      this.warmupUntilClient = Date.now() + (serverResumeAt - this.estimatedServerNow());
    }
  }

  // Rebuild `remotes` as the interpolated view at (serverNow - INTERP_DELAY).
  // Call once per render frame before reading positions.
  interpolate() {
    const renderT = this.estimatedServerNow() - INTERP_DELAY_MS;
    const buf = this.snapBuffer;
    const now = performance.now();
    const next = new Map<string, RemotePlayerSnapshot>();

    if (buf.length === 0) {
      this.remotes = next;
      return;
    }

    // Find the two snapshots straddling renderT.
    let older: BufferedSnapshot | null = null;
    let newer: BufferedSnapshot | null = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        older = buf[i];
        newer = buf[i + 1] ?? buf[i];
        break;
      }
    }
    if (!older) {
      // renderT is before everything buffered — use the oldest snapshot.
      older = buf[0];
      newer = buf[0];
    }
    const span = newer!.t - older!.t;
    const f = span > 0 ? Math.max(0, Math.min(1, (renderT - older!.t) / span)) : 0;

    for (const [id, b] of newer!.players) {
      if (id === this.clientId) continue;
      const a = older!.players.get(id);
      const pos: Vec3 = a
        ? { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }
        : { x: b.x, y: b.y, z: b.z };
      next.set(id, {
        id,
        name: b.name ?? id,
        pos,
        yaw: a ? lerpAngle(a.yaw, b.yaw, f) : b.yaw,
        pitch: b.pitch ?? 0,
        frags: b.frags ?? 0,
        deaths: b.deaths ?? 0,
        invulnMs: b.invulnMs ?? 0,
        team: b.team ?? null,
        hat: b.hat ?? 'hat.none',
        unusual: b.unusual ?? 'unusual.none',
        emote: b.emote ?? 'emote.cheer',
        receivedAt: now,
      });
    }
    this.remotes = next;
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ type: 'ping', ts: Date.now() });
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handle(msg: ServerMessage) {
    if (msg.type === 'welcome') {
      this.clientId = msg.clientId;
      // Tell the server our equipped cosmetics so it echoes them to other players.
      this.send({ type: 'hat', id: this.localHat });
      this.send({ type: 'unusual', id: this.localUnusual });
      this.send({ type: 'emote', id: this.localEmote });
      if (this.localCard) this.send({ type: 'card', card: this.localCard });
      // Seed the clock from the welcome (ignores one-way latency; pings refine).
      if (!this.clockSeeded) {
        this.clockOffset = msg.serverTime - Date.now();
        this.clockSeeded = true;
      }
      this.emit();
      return;
    }
    if (msg.type === 'pong') {
      const rtt = Date.now() - msg.ts;
      if (rtt >= 0 && rtt < 5000) {
        this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
        // serverTime was the server clock when it replied (~ rtt/2 ago).
        const sample = msg.serverTime + rtt / 2 - Date.now();
        this.clockOffset = this.clockSeeded ? this.clockOffset * 0.8 + sample * 0.2 : sample;
        this.clockSeeded = true;
      }
      return;
    }
    if (msg.type === 'state') {
      this.setResume(msg.resumeAt);
      const players = new Map<string, StatePlayer>();
      for (const p of msg.players) {
        players.set(p.id, p);
        if (p.id === this.clientId) {
          this.localFrags = p.frags ?? 0;
          this.localDeaths = p.deaths ?? 0;
          this.localInvulnMs = p.invulnMs ?? 0;
          if (p.team !== undefined) this.localTeam = p.team;
        }
      }
      // Keep buffer ordered by server time; drop anything older than the window.
      this.snapBuffer.push({ t: msg.t, players });
      const cutoff = msg.t - SNAP_BUFFER_MS;
      while (this.snapBuffer.length > 2 && this.snapBuffer[0].t < cutoff) {
        this.snapBuffer.shift();
      }
      return;
    }
    if (msg.type === 'kill') {
      this.events.onKill({
        killerId: msg.killerId,
        killerName: msg.killerName,
        victimId: msg.victimId,
        victimName: msg.victimName,
        headshot: msg.headshot,
        victimPos: msg.victimPos,
        respawnPos: msg.respawnPos,
        killerCard: msg.killerCard,
        t: msg.t,
      });
      return;
    }
    if (msg.type === 'joined') {
      this.mode = msg.mode ?? 'ffa';
      this.localTeam = msg.team ?? null;
      this.setResume(msg.resumeAt);
      this.events.onJoined?.({
        roomId: msg.roomId,
        mapId: msg.mapId,
        spawn: msg.spawn,
        state: msg.state,
        mode: this.mode,
        team: this.localTeam,
        roundsToWin: msg.roundsToWin ?? null,
      });
      return;
    }
    if (msg.type === 'join-failed') {
      this.events.onJoinFailed?.(msg.reason);
      return;
    }
    if (msg.type === 'respawn') {
      this.events.onRespawn?.({ x: msg.x, y: msg.y, z: msg.z }, msg.reason ?? 'void');
      return;
    }
    if (msg.type === 'vote-start') {
      // Convert the server-clock deadline to our local clock for the overlay.
      const endsAtClient = Date.now() + (msg.endsAt - this.estimatedServerNow());
      this.events.onVoteStart?.({
        options: msg.options,
        endsAtClient,
        durationMs: msg.durationMs,
        winnerId: msg.winnerId ?? null,
        winnerTeam: msg.winnerTeam ?? null,
      });
      return;
    }
    if (msg.type === 'round') {
      this.setResume(msg.resumeAt);
      const resumeAtClient = Date.now() + (msg.resumeAt - this.estimatedServerNow());
      this.events.onRound?.({
        roundNum: msg.roundNum,
        roundWins: msg.roundWins,
        winnerId: msg.winnerId ?? null,
        resumeAtClient,
      });
      return;
    }
    if (msg.type === 'vote-update') {
      this.events.onVoteUpdate?.(msg.counts);
      return;
    }
    if (msg.type === 'vote-result') {
      this.setResume(msg.resumeAt);
      const resumeAtClient = Date.now() + (msg.resumeAt - this.estimatedServerNow());
      this.events.onVoteResult?.({ mapId: msg.mapId, resumeAtClient });
      return;
    }
    if (msg.type === 'peer-left') {
      // Interpolation drops them once they fall out of fresh snapshots.
      this.remotes.delete(msg.clientId);
      this.emit();
      return;
    }
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private setStatus(s: NetStatus) {
    this.status = s;
    this.emit();
  }

  private emit() {
    this.listener(this.remotes, {
      status: this.status,
      clientId: this.clientId,
      peers: this.remotes.size,
    });
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/* ───────────────────────── Lobby browser / matchmaking ───────────────────────── */

export type LobbyRoom = {
  id: string;
  name: string;
  mode: GameMode;
  mapId: string;
  players: number;
  capacity: number;
  state: 'active' | 'voting';
  joinable: boolean;
};

export type LobbyStatus = 'connecting' | 'open' | 'closed' | 'error';

// Lightweight WS client for the main menu: lists public rooms and runs the
// create / quick-match handshakes. It does NOT join gameplay — once it resolves
// a roomId, the menu starts a match whose Game opens its own NetClient.
export class LobbyClient {
  private ws: WebSocket | null = null;
  private url: string;
  private name: string;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  onRooms: (rooms: LobbyRoom[]) => void = () => {};
  onStatus: (s: LobbyStatus) => void = () => {};
  onResolved: (info: { roomId: string; mapId: string; kind: 'created' | 'matched'; isPublic?: boolean }) => void =
    () => {};

  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
  }

  setName(name: string) {
    this.name = name;
  }

  connect() {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    try {
      this.onStatus('connecting');
      this.ws = new WebSocket(this.url);
    } catch {
      this.onStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.onStatus('open');
      this.send({ type: 'hello', name: this.name });
      this.send({ type: 'list' });
    };
    this.ws.onmessage = (e) => {
      let msg: { type?: string; rooms?: LobbyRoom[]; roomId?: string; mapId?: string; isPublic?: boolean };
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (msg.type === 'rooms' && Array.isArray(msg.rooms)) {
        this.onRooms(msg.rooms);
      } else if (msg.type === 'created' && msg.roomId && msg.mapId) {
        this.onResolved({ roomId: msg.roomId, mapId: msg.mapId, kind: 'created', isPublic: msg.isPublic });
      } else if (msg.type === 'matched' && msg.roomId && msg.mapId) {
        this.onResolved({ roomId: msg.roomId, mapId: msg.mapId, kind: 'matched' });
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.onStatus('closed');
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.onStatus('error');
  }

  refresh() {
    this.send({ type: 'list' });
  }

  quickMatch(mode: GameMode = 'ffa') {
    this.send({ type: 'quickmatch', name: this.name, mode });
  }

  createRoom(opts: { mapId: string; isPublic: boolean; capacity: number; mode: GameMode }) {
    this.send({ type: 'create', name: this.name, ...opts });
  }

  private send(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
