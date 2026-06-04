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
  nameColor: string; // equipped nameplate-color cosmetic id
  spawnEffect: string; // equipped spawn-in-effect cosmetic id
  ping: number; // this player's reported round-trip ping (ms)
  admin: boolean; // staff badge
  verified: boolean; // verified blue check
  receivedAt: number;
};

export type KillEvent = {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  headshot: boolean;
  firstBlood: boolean;
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
  nameColor?: string;
  spawnEffect?: string;
  ping?: number;
  admin?: boolean; // staff badge
  verified?: boolean; // verified blue check
};

type WelcomeMessage = { type: 'welcome'; clientId: string; serverTime: number; resumeToken?: string };
type StateMessage = { type: 'state'; t: number; players: StatePlayer[]; resumeAt?: number };
type KillBroadcast = {
  type: 'kill';
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  headshot: boolean;
  firstBlood?: boolean;
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
  spawn?: Vec3; // this client's server-assigned fresh-round spawn
};
type VoteUpdateMessage = { type: 'vote-update'; counts: Record<string, number> };
type VoteResultMessage = { type: 'vote-result'; mapId: string; resumeAt: number; spawn?: Vec3 };
type RespawnMessage = { type: 'respawn'; x: number; y: number; z: number; reason?: string };
// In-game (room) chat broadcast — same shape as the lobby ChatMessage.
type ChatBroadcastMessage = { type: 'chat' } & ChatMessage;
// A rail beam fired by another player (origin → end), so we can render + sound it.
type BeamMessage = {
  type: 'beam';
  id: string;
  ox: number; oy: number; oz: number;
  ex: number; ey: number; ez: number;
};
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
  | BeamMessage
  | ChatBroadcastMessage
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
  onVoteResult?: (r: { mapId: string; resumeAtClient: number; spawn?: Vec3 }) => void;
  onRound?: (r: {
    roundNum: number;
    roundWins: Record<string, number>;
    winnerId: string | null;
    resumeAtClient: number;
    spawn?: Vec3;
  }) => void;
  onChat?: (m: ChatMessage) => void; // in-game (room) chat broadcast
  onBeam?: (b: {
    id: string;
    ox: number; oy: number; oz: number;
    ex: number; ey: number; ez: number;
  }) => void; // another player's rail beam → render + sound it
};

const RECONNECT_DELAY_MS = 1500;
const PING_INTERVAL_MS = 1000;
// The lobby socket heartbeats this often so the server's idle-client sweep
// (STALE_CLIENT_TIMEOUT_MS = 10s) never reaps a player just sitting in the menu —
// that reap was what made the "online" chip flicker every ~10s as the socket
// dropped and reconnected. Comfortably under the 10s timeout.
const LOBBY_PING_MS = 5000;
// Keep showing the last "online" status through a brief drop+reconnect so a
// transient blip doesn't flash the chip to "offline". If we're still down after
// this, surface it.
const LOBBY_STATUS_GRACE_MS = 4000;
// Bounded dead-reckoning when the snapshot buffer runs dry (packet loss / a
// frame hitch): extrapolate a remote from its last known velocity for up to this
// long instead of freezing in place, then snapping when data resumes.
const EXTRAPOLATION_CAP_MS = 120;
// Render remote players this far in the past so we always have two snapshots to
// interpolate between (covers the 31.25ms snapshot interval + jitter). The
// server rewinds to the same render time when resolving our shots, so what we
// aim at is what the server tests — that's the lag compensation contract.
const INTERP_DELAY_MS = 100;
const SNAP_BUFFER_MS = 1200;
// How fast the applied clock offset eases toward the ping-refined target (per
// second). Small ongoing corrections slew imperceptibly; a big gap snaps once.
const CLOCK_SLEW_HZ = 3;
const CLOCK_SLEW_SNAP_MS = 250;

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
  // Ids touched in the current interpolate() pass. We update `remotes` IN PLACE
  // (mark-and-sweep against this set) instead of allocating a fresh Map + N
  // snapshot objects every render frame — that steady per-frame garbage was a
  // source of GC pauses that show up as micro-stutter at high refresh rates.
  private scratchSeen = new Set<string>();
  localHat = 'hat.none'; // equipped hat id, sent to the server so remotes render it
  localUnusual = 'unusual.none'; // equipped unusual-effect id
  localEmote = 'emote.cheer'; // equipped podium-emote id (shown on the results podium)
  localNameColor = 'name.default'; // equipped nameplate-color id (seen by others)
  localSpawnEffect = 'spawn.beam'; // equipped spawn-in-effect id (seen by others)
  localCard: CardPayload | null = null; // playercard shown on the victim's killcam
  localFrags = 0;
  localDeaths = 0;
  localInvulnMs = 0;
  localName = ''; // your SERVER-ASSIGNED name (account username, or "Guest N"); from snapshots
  localAdmin = false; // your staff badge (server-authoritative; from snapshots)
  localVerified = false; // your verified blue check (server-authoritative; from snapshots)
  localTeam: number | null = null; // your team index in TDM; null otherwise
  mode: GameMode = 'ffa';
  rttMs = 0;
  // Warmup / breather end, converted to the local clock. `warmupMsLeft` drives
  // the client's "GET READY" countdown; 0 once play is live.
  private warmupUntilClient = 0;
  // serverClock - performance.now() (ms). `clockOffset` is the APPLIED value
  // (used by estimatedServerNow); it slews toward `clockOffsetTarget` (the
  // ping-refined estimate) a little each frame so the interpolation render-time
  // advances smoothly instead of hitching ~1×/sec when a pong nudges the
  // estimate. We deliberately key the offset off the MONOTONIC performance.now()
  // clock, not Date.now(): Date.now() is wall-clock, so an NTP step or its
  // coarse (1ms) quantization can jump the derived render time and pop every
  // remote's position. performance.now() only ever moves forward, smoothly.
  private clockOffset = 0;
  private clockOffsetTarget = 0;
  private clockSeeded = false;
  private snapBuffer: BufferedSnapshot[] = [];
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Resume token from the last welcome — kept across reconnects so we can reclaim
  // our in-match slot + score instead of re-joining fresh (zeroed).
  private resumeToken: string | null = null;

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
      // A held resume token means this is a RECONNECT — try to reclaim our slot;
      // the server falls back to a fresh join if the grace window has lapsed.
      if (this.resumeToken) {
        this.send({ type: 'resume', token: this.resumeToken, roomId: this.roomId, name: this.name });
      } else {
        this.send({ type: 'join', name: this.name, roomId: this.roomId });
      }
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

  // In-game chat to the match room. Server sanitizes/profanity-filters/rate-limits
  // and stamps the authoritative sender identity, then broadcasts to the room
  // (sender included), so we render our own line from the echo.
  sendChat(text: string) {
    this.send({ type: 'chat', text });
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
    return performance.now() + this.clockOffset;
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

  setLocalNameColor(id: string): void {
    this.localNameColor = id;
    this.send({ type: 'nameColor', id });
  }

  setLocalSpawnEffect(id: string): void {
    this.localSpawnEffect = id;
    this.send({ type: 'spawnEffect', id });
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
  // Call once per render frame before reading positions; `dt` is the real frame
  // delta (s), used to slew the clock smoothly.
  interpolate(dt = 0) {
    // Ease the applied clock offset toward the ping-refined target so renderT
    // advances smoothly. A large gap (first good ping after a bad seed, a big
    // drift) snaps once rather than slewing for seconds.
    if (Math.abs(this.clockOffsetTarget - this.clockOffset) > CLOCK_SLEW_SNAP_MS) {
      this.clockOffset = this.clockOffsetTarget;
    } else if (dt > 0) {
      this.clockOffset += (this.clockOffsetTarget - this.clockOffset) * (1 - Math.exp(-CLOCK_SLEW_HZ * dt));
    }
    const renderT = this.estimatedServerNow() - INTERP_DELAY_MS;
    const buf = this.snapBuffer;
    const now = performance.now();
    const seen = this.scratchSeen;
    seen.clear();

    if (buf.length === 0) {
      this.remotes.clear();
      return;
    }

    // Buffer underrun (packet loss / a render hitch): renderT is past our newest
    // snapshot. Dead-reckon each remote from the last two snapshots' velocity for
    // a short, capped window so they keep gliding instead of freezing then
    // snapping when data resumes. Yaw holds at the latest — extrapolated angle
    // overshoot reads worse than a still head.
    const newest = buf[buf.length - 1];
    if (renderT > newest.t && buf.length >= 2) {
      const prev = buf[buf.length - 2];
      const dtPrev = newest.t - prev.t;
      const ahead = Math.min(renderT - newest.t, EXTRAPOLATION_CAP_MS);
      const k = dtPrev > 0 ? ahead / dtPrev : 0;
      for (const [id, b] of newest.players) {
        if (id === this.clientId) continue;
        const a = prev.players.get(id);
        const px = a ? b.x + (b.x - a.x) * k : b.x;
        const py = a ? b.y + (b.y - a.y) * k : b.y;
        const pz = a ? b.z + (b.z - a.z) * k : b.z;
        this.upsertRemote(b, px, py, pz, b.yaw, now, seen);
      }
      this.sweepUnseen(seen);
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
      const px = a ? a.x + (b.x - a.x) * f : b.x;
      const py = a ? a.y + (b.y - a.y) * f : b.y;
      const pz = a ? a.z + (b.z - a.z) * f : b.z;
      const yaw = a ? lerpAngle(a.yaw, b.yaw, f) : b.yaw;
      this.upsertRemote(b, px, py, pz, yaw, now, seen);
    }
    this.sweepUnseen(seen);
  }

  // Update (or create) the public remote snapshot for `b` IN PLACE from a
  // resolved position/yaw (interpolated or extrapolated), reusing the existing
  // object + its `pos` so a steady-state frame allocates nothing. `seen` records
  // that this id is still live this pass. Centralized so the interp and
  // dead-reckoning paths stay in sync.
  private upsertRemote(
    b: StatePlayer,
    px: number,
    py: number,
    pz: number,
    yaw: number,
    now: number,
    seen: Set<string>,
  ): void {
    seen.add(b.id);
    let s = this.remotes.get(b.id);
    if (!s) {
      s = { id: b.id, name: b.name ?? b.id, pos: { x: px, y: py, z: pz }, yaw, pitch: 0,
        frags: 0, deaths: 0, invulnMs: 0, team: null, hat: 'hat.none', unusual: 'unusual.none',
        emote: 'emote.cheer', nameColor: 'name.default', spawnEffect: 'spawn.beam', ping: 0,
        admin: false, verified: false, receivedAt: now };
      this.remotes.set(b.id, s);
    }
    s.name = b.name ?? b.id;
    s.pos.x = px;
    s.pos.y = py;
    s.pos.z = pz;
    s.yaw = yaw;
    s.pitch = b.pitch ?? 0;
    s.frags = b.frags ?? 0;
    s.deaths = b.deaths ?? 0;
    s.invulnMs = b.invulnMs ?? 0;
    s.team = b.team ?? null;
    s.hat = b.hat ?? 'hat.none';
    s.unusual = b.unusual ?? 'unusual.none';
    s.emote = b.emote ?? 'emote.cheer';
    s.nameColor = b.nameColor ?? 'name.default';
    s.spawnEffect = b.spawnEffect ?? 'spawn.beam';
    s.ping = b.ping ?? 0;
    s.admin = b.admin ?? false;
    s.verified = b.verified ?? false;
    s.receivedAt = now;
  }

  // Drop any remote not refreshed this interpolate() pass (left the room / fell
  // out of fresh snapshots). Deleting during Map iteration is safe per spec.
  private sweepUnseen(seen: Set<string>): void {
    for (const id of this.remotes.keys()) {
      if (!seen.has(id)) this.remotes.delete(id);
    }
  }

  private startPing() {
    this.stopPing();
    // Report our latest measured RTT with each ping so the server can echo every
    // player's ping in the scoreboard (the server can't measure it itself).
    const ping = () => this.send({ type: 'ping', ts: Date.now(), rtt: Math.round(this.rttMs) });
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
      if (msg.resumeToken) this.resumeToken = msg.resumeToken; // for the next reconnect
      // Tell the server our equipped cosmetics so it echoes them to other players.
      this.send({ type: 'hat', id: this.localHat });
      this.send({ type: 'unusual', id: this.localUnusual });
      this.send({ type: 'emote', id: this.localEmote });
      this.send({ type: 'nameColor', id: this.localNameColor });
      this.send({ type: 'spawnEffect', id: this.localSpawnEffect });
      if (this.localCard) this.send({ type: 'card', card: this.localCard });
      // Seed the clock from the welcome (ignores one-way latency; pings refine).
      // Keyed off performance.now() to match estimatedServerNow().
      if (!this.clockSeeded) {
        this.clockOffset = msg.serverTime - performance.now();
        this.clockOffsetTarget = this.clockOffset;
        this.clockSeeded = true;
      }
      this.emit();
      return;
    }
    if (msg.type === 'pong') {
      const rtt = Date.now() - msg.ts;
      if (rtt >= 0 && rtt < 5000) {
        this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
        // serverTime was the server clock when it replied (~ rtt/2 ago). Refine
        // the TARGET; the applied offset slews toward it in interpolate() so the
        // correction doesn't land as a one-frame jump. Keyed off performance.now()
        // (monotonic) to match estimatedServerNow().
        const sample = msg.serverTime + rtt / 2 - performance.now();
        this.clockOffsetTarget = this.clockSeeded ? this.clockOffsetTarget * 0.8 + sample * 0.2 : sample;
        if (!this.clockSeeded) this.clockOffset = this.clockOffsetTarget;
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
          if (p.name) this.localName = p.name; // server's authoritative name for us
          this.localAdmin = !!p.admin;
          this.localVerified = !!p.verified;
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
        firstBlood: !!msg.firstBlood,
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
        spawn: msg.spawn,
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
      this.events.onVoteResult?.({ mapId: msg.mapId, resumeAtClient, spawn: msg.spawn });
      return;
    }
    if (msg.type === 'peer-left') {
      // Interpolation drops them once they fall out of fresh snapshots.
      this.remotes.delete(msg.clientId);
      this.emit();
      return;
    }
    if (msg.type === 'chat') {
      this.events.onChat?.({
        id: msg.id,
        name: msg.name,
        text: msg.text,
        ts: msg.ts,
        admin: msg.admin,
        verified: msg.verified,
        guest: msg.guest,
      });
      return;
    }
    if (msg.type === 'beam') {
      this.events.onBeam?.({
        id: msg.id,
        ox: msg.ox, oy: msg.oy, oz: msg.oz,
        ex: msg.ex, ey: msg.ey, ez: msg.ez,
      });
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

// Live menu presence + global chat (server-authoritative; see server/instagib-game.ts).
export type PresencePlayer = { name: string; admin: boolean; verified: boolean; inMatch: boolean };
export type PresenceState = { online: number; guests: number; players: PresencePlayer[] };
export type ChatMessage = {
  id: number;
  name: string;
  text: string;
  ts: number;
  admin: boolean;
  verified: boolean;
  guest: boolean;
};
export type ChatRejectReason = 'rate' | 'blocked' | 'account';

// Lightweight WS client for the main menu: lists public rooms and runs the
// create / quick-match handshakes. It does NOT join gameplay — once it resolves
// a roomId, the menu starts a match whose Game opens its own NetClient.
export class LobbyClient {
  private ws: WebSocket | null = null;
  private url: string;
  private name: string;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private uiStatus: LobbyStatus = 'connecting'; // last status surfaced to onStatus
  onRooms: (rooms: LobbyRoom[]) => void = () => {};
  onStatus: (s: LobbyStatus) => void = () => {};
  onResolved: (info: { roomId: string; mapId: string; kind: 'created' | 'matched'; isPublic?: boolean }) => void =
    () => {};
  onPresence: (p: PresenceState) => void = () => {};
  onChat: (m: ChatMessage) => void = () => {};
  onChatHistory: (m: ChatMessage[]) => void = () => {};
  onChatRejected: (reason: ChatRejectReason) => void = () => {};

  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
  }

  setName(name: string) {
    this.name = name;
  }

  // Surface a status to the UI at most once per change.
  private setStatus(s: LobbyStatus) {
    if (this.uiStatus === s) return;
    this.uiStatus = s;
    this.onStatus(s);
  }

  connect() {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    // Only show "connecting" on a cold start — during a brief reconnect we keep
    // the last "open" status (covered by the grace timer) so the chip doesn't
    // flicker to "linking"/"offline" and back.
    if (this.uiStatus !== 'open') this.setStatus('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.handleDrop();
      return;
    }
    this.ws.onopen = () => {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.setStatus('open');
      this.startHeartbeat();
      this.send({ type: 'hello', name: this.name });
      this.send({ type: 'list' });
    };
    this.ws.onmessage = (e) => {
      let msg: {
        type?: string;
        rooms?: LobbyRoom[];
        roomId?: string;
        mapId?: string;
        isPublic?: boolean;
        online?: number;
        guests?: number;
        players?: PresencePlayer[];
        messages?: ChatMessage[];
        reason?: ChatRejectReason;
      } & Partial<ChatMessage>;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      switch (msg.type) {
        case 'rooms':
          if (Array.isArray(msg.rooms)) this.onRooms(msg.rooms);
          break;
        case 'created':
          if (msg.roomId && msg.mapId)
            this.onResolved({ roomId: msg.roomId, mapId: msg.mapId, kind: 'created', isPublic: msg.isPublic });
          break;
        case 'matched':
          if (msg.roomId && msg.mapId)
            this.onResolved({ roomId: msg.roomId, mapId: msg.mapId, kind: 'matched' });
          break;
        case 'presence':
          if (typeof msg.online === 'number' && Array.isArray(msg.players))
            this.onPresence({ online: msg.online, guests: msg.guests ?? 0, players: msg.players });
          break;
        case 'chat':
          if (typeof msg.id === 'number' && typeof msg.name === 'string' && typeof msg.text === 'string')
            this.onChat({
              id: msg.id,
              name: msg.name,
              text: msg.text,
              ts: msg.ts ?? 0,
              admin: !!msg.admin,
              verified: !!msg.verified,
              guest: !!msg.guest,
            });
          break;
        case 'chat-history':
          if (Array.isArray(msg.messages)) this.onChatHistory(msg.messages);
          break;
        case 'chat-rejected':
          this.onChatRejected(
            msg.reason === 'rate' ? 'rate' : msg.reason === 'account' ? 'account' : 'blocked',
          );
          break;
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.handleDrop();
    };
    this.ws.onerror = () => {
      // onclose follows onerror; let handleDrop there do the work (with grace).
    };
  }

  // Socket dropped: keep the heartbeat off, hold "online" for a grace window so a
  // quick reconnect doesn't flicker the chip, and schedule the reconnect.
  private handleDrop() {
    this.stopHeartbeat();
    if (this.disposed) return;
    if (this.uiStatus === 'open') {
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.setStatus('closed');
        }, LOBBY_STATUS_GRACE_MS);
      }
    } else {
      this.setStatus('closed');
    }
    this.scheduleReconnect();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'ping', ts: Date.now() });
    }, LOBBY_PING_MS);
  }

  private stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  refresh() {
    this.send({ type: 'list' });
  }

  // Send a global-chat message. The server sanitizes, length-caps, profanity-
  // filters, rate-limits, and stamps the authoritative sender identity, then
  // echoes it back via onChat (so we render our own message from the broadcast,
  // never optimistically).
  sendChat(text: string) {
    this.send({ type: 'chat', text });
  }

  // `mode: 'any'` is the mode-agnostic "Play Now" super-queue (joins the fullest
  // live public room of any mode; concentrates a small population).
  quickMatch(mode: GameMode | 'any' = 'ffa') {
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
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.stopHeartbeat();
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
