import type { GameMode } from './constants';
import type { CardPayload, NetDebugStats } from './types';
import { decodeState, encodePos, toView } from './netcodec';

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
  title: string; // equipped title cosmetic id (resolved to flair text client-side)
  titleText?: string; // server-resolved flair text (dynamic ranked title → "#N"/tier); overrides the id
  railColor: string; // equipped rail-beam color id (used for this player's beam + spectator viewmodel)
  railgunFinish: string; // equipped railgun finish id (3rd-person gun skin + spectator viewmodel)
  crosshair: string; // equipped crosshair share-code string ('' = default); rendered when spectating
  ping: number; // this player's reported round-trip ping (ms)
  admin: boolean; // staff badge
  verified: boolean; // verified blue check
  receivedAt: number;
};

// A scoreboard-ready row for every player in the room, built from the meta
// roster (so killed players hidden from snapshots during their killcam still
// have a row) merged with their last-known dynamic stats.
export type RosterEntry = {
  id: string;
  name: string;
  team: number | null;
  hat: string;
  emote: string;
  title: string;
  titleText?: string; // server-resolved flair (dynamic ranked title → "#N"/tier)
  admin: boolean;
  verified: boolean;
  frags: number;
  deaths: number;
  ping: number;
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

// The per-tick dynamic snapshot row. Static identity/cosmetics moved to
// PlayerMeta (the `meta` channel), so this is now all numbers — smaller on the
// wire and cheaper to JSON.parse 40×/sec.
type StatePlayer = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnMs: number;
  ping?: number;
};

// The slow-changing per-player profile, delivered on the `meta` channel (sent
// on join/leave/resume/cosmetic-change, not per tick) and merged onto the
// dynamic snapshot in upsertRemote.
type PlayerMeta = {
  id: string;
  name: string;
  team: number | null;
  hat: string;
  unusual: string;
  emote: string;
  nameColor: string;
  spawnEffect: string;
  title: string;
  titleText?: string; // server-resolved flair (dynamic ranked title)
  railColor: string;
  railgunFinish: string;
  crosshair: string;
  admin: boolean;
  verified: boolean;
};

type WelcomeMessage = { type: 'welcome'; clientId: string; serverTime: number; resumeToken?: string };
type StateMessage = { type: 'state'; t: number; players: StatePlayer[]; resumeAt?: number };
type MetaMessage = { type: 'meta'; players: PlayerMeta[] };
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
  ranked?: boolean; // ranked Duel (first-to-N, no rounds/vote)
  team?: number | null;
  mapId: string;
  spawn: Vec3;
  state: 'active' | 'voting';
  fragLimit: number;
  resumeAt?: number; // warmup/breather end (server clock)
};

// Per-side rating change after a ranked match (mirrors server db.ts RankedResult).
export type RankedSide = {
  id: string;
  userName: string;
  rating: number;
  delta: number;
  rank: number;
};
type RankedResultMessage = {
  type: 'ranked-result';
  winnerId: string;
  winnerName: string;
  loserId: string | null;
  loserName: string | null;
  forfeit: boolean;
  winnerFrags: number;
  loserFrags: number;
  fragLimit: number;
  reduced?: boolean; // rating change damped (repeat opponent)
  rating: { winner: RankedSide; loser: RankedSide } | null; // null if a guest slipped in
};
// What the Game forwards to the UI for the ranked end-of-match overlay.
export type RankedResult = {
  won: boolean;
  forfeit: boolean;
  reduced: boolean;
  winnerName: string;
  loserName: string | null;
  winnerFrags: number;
  loserFrags: number;
  fragLimit: number;
  rating: { winner: RankedSide; loser: RankedSide } | null;
};
// Confirmation that this connection is now watching a room (read-only). No spawn
// or team — a spectator never plays. The client adopts the room's map + mode.
type SpectatingMessage = {
  type: 'spectating';
  roomId: string;
  mode?: GameMode;
  mapId: string;
  state: 'active' | 'voting';
};
type VoteStartMessage = {
  type: 'vote-start';
  options: string[];
  endsAt: number; // server-clock ms
  durationMs: number;
  winnerId?: string | null; // client who reached the frag limit (match winner)
  winnerTeam?: number | null; // winning team index in TDM
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
  | MetaMessage
  | KillBroadcast
  | JoinedMessage
  | SpectatingMessage
  | VoteStartMessage
  | VoteUpdateMessage
  | VoteResultMessage
  | RankedResultMessage
  | RespawnMessage
  | BeamMessage
  | ChatBroadcastMessage
  | { type: 'join-failed'; reason: string }
  | { type: 'spectate-failed'; reason: string }
  | { type: 'spectate-ended' }
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
    ranked: boolean;
    team: number | null;
  }) => void;
  // Ranked match resolved (frag limit or forfeit): rating deltas for the overlay.
  onRankedResult?: (r: RankedResult) => void;
  onJoinFailed?: (reason: string) => void;
  // Spectating confirmed: adopt the watched room's map/mode (no spawn — read-only).
  onSpectating?: (info: { mapId: string; mode: GameMode; state: 'active' | 'voting' }) => void;
  // The watched match ended / the room was reaped → return to the lobby.
  onSpectateEnded?: () => void;
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
// FIXED interpolation delay — render remote players this far in the past. A
// fixed delay is the key to smoothness: renderT = serverNow − CONST advances at
// exactly real time, so playback never speeds up or slows down. (We tried sizing
// it adaptively from measured snapshot-arrival jitter, but our transport is TCP,
// where snapshots arrive in BURSTS after any head-of-line stall — so the measured
// "jitter" spiked, the delay wobbled, and that wobble became the dominant jitter
// source. Lesson: don't drive the playback clock off arrival timing.) Keep the
// delay deterministic between roster changes, but give larger rooms more fixed
// headroom because their state frames consume more of a constrained TCP link.
// The server rewinds shots to exactly the active delay, so favor-the-shooter
// hit-reg is unaffected by the value; it only trades a little peeker's advantage.
const INTERP_DELAY_MIN_MS = 110;
const INTERP_DELAY_MAX_MS = 170;
const INTERP_DELAY_MAX_PLAYERS = 8;
const interpDelayForPlayerCount = (players: number): number => {
  const extraPlayers = Math.max(0, Math.min(INTERP_DELAY_MAX_PLAYERS, players) - 2);
  return INTERP_DELAY_MIN_MS +
    (extraPlayers / (INTERP_DELAY_MAX_PLAYERS - 2)) * (INTERP_DELAY_MAX_MS - INTERP_DELAY_MIN_MS);
};
// How fast the APPLIED interp delay moves toward the roster-scaled target
// (ms per second). A roster change used to snap the delay, which shifts renderT
// by up to 60ms in one frame — every remote visibly hitched on join/leave.
// Slewing instead bends playback speed by at most ~12% for under half a second,
// which is imperceptible. Still roster-driven (never arrival-timing-driven —
// see the FIXED-delay rationale above), and the shot renderTime always reports
// the applied value, so server rewind matches what was rendered mid-slew too.
const INTERP_DELAY_SLEW_MS_PER_S = 120;
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
  // When true this connection WATCHES the room (sends `spectate`, never `pos`/
  // `shoot`/`join`) and renders every player as a remote (no local player).
  private spectate: boolean;
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
  // Slow-changing per-player profile (name, team, cosmetics, badges) from the
  // `meta` channel, merged onto each dynamic snapshot in upsertRemote. Persists
  // between snapshots — meta is only re-sent on change, not per tick.
  private metaById = new Map<string, PlayerMeta>();
  // Last-known dynamic stats (frags/deaths/ping) per remote, retained even while
  // a player is hidden from snapshots during their killcam — so their scoreboard
  // row keeps its score instead of vanishing. Swept alongside metaById.
  private lastStatsById = new Map<string, { frags: number; deaths: number; ping: number }>();
  localHat = 'hat.none'; // equipped hat id, sent to the server so remotes render it
  localUnusual = 'unusual.none'; // equipped unusual-effect id
  localEmote = 'emote.cheer'; // equipped podium-emote id (shown on the results podium)
  localNameColor = 'name.default'; // equipped nameplate-color id (seen by others)
  localSpawnEffect = 'spawn.beam'; // equipped spawn-in-effect id (seen by others)
  localTitle = 'title.none'; // equipped title id (flair shown under the name, seen by others)
  localTitleText = ''; // server-resolved flair for our own title (dynamic ranked → "#N"/tier)
  localRailColor = 'rail.cyan'; // equipped rail-beam color id (echoed so others see your beam)
  localRailgunFinish = 'gun.stock'; // equipped railgun finish id (echoed for the 3rd-person gun)
  localCrosshair = ''; // equipped crosshair share-code (echoed so spectators can render it)
  localCard: CardPayload | null = null; // playercard shown on the victim's killcam
  localFrags = 0;
  localDeaths = 0;
  localInvulnMs = 0;
  localName = ''; // your SERVER-ASSIGNED name (account username, or "Guest N"); from snapshots
  localAdmin = false; // your staff badge (server-authoritative; from snapshots)
  localVerified = false; // your verified blue check (server-authoritative; from snapshots)
  localTeam: number | null = null; // your team index in TDM; null otherwise
  mode: GameMode = 'ffa';
  ranked = false; // this room is a ranked Duel (first-to-N, no rounds/vote)
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
  // Fixed interpolation delay (see interpDelayForPlayerCount). Also reported as the shot
  // renderTime so the server rewinds to exactly what we rendered. The applied
  // value slews toward the roster-scaled target in interpolate() (see
  // INTERP_DELAY_SLEW_MS_PER_S); only the first roster of a connection snaps.
  private interpDelayMs = INTERP_DELAY_MIN_MS;
  private interpDelayTargetMs = INTERP_DELAY_MIN_MS;
  // True when the last interpolate() pass had to EXTRAPOLATE (buffer underrun):
  // the rendered remotes are then ahead of the server's truth, so the Game skips
  // predicted hitmarkers that frame (they'd "hit" something the server won't).
  extrapolating = false;
  // Read-only diagnostics for the in-match net-debug overlay (telemetry only —
  // none of this drives behavior; it exists because localhost probes can't
  // reproduce real-match feel). EMAs of snapshot arrival timing, extrapolation
  // rate, buffer headroom, and clock-offset stability.
  private dbgSnapIntervalMs = 0;
  private dbgSnapJitterMs = 0;
  private dbgLastArrival = 0;
  private dbgExtrapEma = 0;
  private dbgBufferMs = 0;
  private dbgClockMeanMs = 0;
  private dbgClockDriftMs = 0;
  private snapBuffer: BufferedSnapshot[] = [];
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Resume token from the last welcome — kept across reconnects so we can reclaim
  // our in-match slot + score instead of re-joining fresh (zeroed).
  private resumeToken: string | null = null;

  constructor(opts: {
    url: string;
    name: string;
    roomId: string;
    spectate?: boolean;
    listener?: NetListener;
    events: NetEvents;
  }) {
    this.url = opts.url;
    this.name = opts.name;
    this.roomId = opts.roomId;
    this.spectate = opts.spectate ?? false;
    this.listener = opts.listener ?? (() => {});
    this.events = opts.events;
  }

  connect() {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    try {
      this.setStatus('connecting');
      this.ws = new WebSocket(this.url);
      // Receive binary frames as ArrayBuffer (synchronous decode) rather than the
      // default Blob — the state snapshot arrives as a binary frame at 64Hz.
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      console.warn('[instagib-net] failed to construct WebSocket', err);
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.setStatus('open');
      if (this.spectate) {
        // Read-only observer: ask to watch the room (no slot, no score, no resume).
        this.send({ type: 'spectate', roomId: this.roomId, name: this.name });
      } else if (this.resumeToken) {
        // A held resume token means this is a RECONNECT — try to reclaim our slot;
        // the server falls back to a fresh join if the grace window has lapsed.
        this.send({ type: 'resume', token: this.resumeToken, roomId: this.roomId, name: this.name });
      } else {
        this.send({ type: 'join', name: this.name, roomId: this.roomId });
      }
      this.startPing();
    };
    this.ws.onmessage = (e) => {
      try {
        if (typeof e.data === 'string') {
          this.handle(JSON.parse(e.data) as ServerMessage);
        } else if (e.data instanceof ArrayBuffer) {
          // The hot state snapshot rides a binary frame; decode → same handler.
          const dec = decodeState(toView(e.data));
          if (dec) this.handle({ type: 'state', t: dec.t, players: dec.players, resumeAt: dec.resumeAt });
        }
      } catch {
        // ignore malformed
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.clientId = null;
      this.remotes.clear();
      this.metaById.clear();
      this.lastStatsById.clear();
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
    if (this.spectate) return; // observers have no position
    // The hottest client→server message (64Hz) — send it as a compact binary
    // frame instead of JSON. The server decodes it back to a `pos` message.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodePos(x, y, z, yaw, pitch));
    }
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
    if (this.spectate) return; // observers can't fire
    this.send({
      type: 'shoot',
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      maxDist,
      // The EXACT delay we're currently rendering remotes at, so the server
      // rewinds targets to precisely what was on our screen (favor-the-shooter).
      renderTime: this.estimatedServerNow() - this.interpDelayMs,
    });
  }

  estimatedServerNow(): number {
    return performance.now() + this.clockOffset;
  }

  // Snapshot of live net diagnostics for the debug overlay (read-only).
  getDebugStats(): NetDebugStats {
    return {
      rttMs: Math.round(this.rttMs),
      interpDelayMs: Math.round(this.interpDelayMs),
      snapHz: this.dbgSnapIntervalMs > 0 ? Math.round(1000 / this.dbgSnapIntervalMs) : 0,
      snapJitterMs: Math.round(this.dbgSnapJitterMs),
      extrapPct: Math.round(this.dbgExtrapEma * 100),
      bufferMs: Math.round(this.dbgBufferMs),
      clockDriftMs: Math.round(this.dbgClockDriftMs),
      transport: 'ws',
      peers: this.remotes.size,
    };
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

  setLocalTitle(id: string): void {
    this.localTitle = id;
    this.send({ type: 'title', id });
  }

  // Rail-beam color / railgun finish / crosshair: echoed to the server so other
  // players + spectators render this player's weapon loadout (previously local).
  setLocalRailColor(id: string): void {
    this.localRailColor = id;
    this.send({ type: 'railColor', id });
  }

  setLocalRailgunFinish(id: string): void {
    this.localRailgunFinish = id;
    this.send({ type: 'railgunFinish', id });
  }

  setLocalCrosshair(code: string): void {
    this.localCrosshair = code;
    this.send({ type: 'crosshair', code });
  }

  // The weapon cosmetics a remote player has equipped (from the meta roster), so
  // the renderer can color their beam / build their gun. Null if unknown yet.
  cosmeticsOf(id: string): { railColor: string; railgunFinish: string; crosshair: string } | null {
    const m = this.metaById.get(id);
    if (!m) return null;
    return { railColor: m.railColor, railgunFinish: m.railgunFinish, crosshair: m.crosshair };
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

  // Rebuild `remotes` as the interpolated view at (serverNow - interpDelayMs).
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
    // Ease the applied interp delay toward the roster-scaled target at a bounded
    // rate, so a join/leave bends playback speed briefly instead of teleporting
    // every remote by the delay delta (a constant-rate ramp caps the time-
    // dilation, unlike an exponential ease whose first frame carries most of it).
    if (dt > 0 && this.interpDelayMs !== this.interpDelayTargetMs) {
      const step = INTERP_DELAY_SLEW_MS_PER_S * dt;
      const gap = this.interpDelayTargetMs - this.interpDelayMs;
      this.interpDelayMs += Math.abs(gap) <= step ? gap : Math.sign(gap) * step;
    }
    // Read-only diagnostics for the net-debug overlay (no behavior impact):
    // clock-offset stability + how often we extrapolate (the TCP-stall tell).
    this.dbgClockMeanMs =
      this.dbgClockMeanMs === 0 ? this.clockOffset : this.dbgClockMeanMs + (this.clockOffset - this.dbgClockMeanMs) * 0.02;
    this.dbgClockDriftMs += (Math.abs(this.clockOffset - this.dbgClockMeanMs) - this.dbgClockDriftMs) * 0.05;
    this.dbgExtrapEma += ((this.extrapolating ? 1 : 0) - this.dbgExtrapEma) * 0.05; // last frame's value
    const renderT = this.estimatedServerNow() - this.interpDelayMs;
    const buf = this.snapBuffer;
    const now = performance.now();
    const seen = this.scratchSeen;
    seen.clear();
    this.extrapolating = false;

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
    this.dbgBufferMs = newest.t - renderT; // headroom: + = buffered ahead of renderT
    if (renderT > newest.t && buf.length >= 2) {
      this.extrapolating = true; // rendering ahead of the newest snapshot
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
    // Static fields come from the meta channel; default gracefully if a profile
    // hasn't landed yet (shouldn't happen — the server flushes meta before any
    // snapshot referencing a new player — but a one-frame default is harmless).
    const m = this.metaById.get(b.id);
    let s = this.remotes.get(b.id);
    if (!s) {
      s = { id: b.id, name: m?.name ?? b.id, pos: { x: px, y: py, z: pz }, yaw, pitch: 0,
        frags: 0, deaths: 0, invulnMs: 0, team: null, hat: 'hat.none', unusual: 'unusual.none',
        emote: 'emote.cheer', nameColor: 'name.default', spawnEffect: 'spawn.beam', title: 'title.none',
        railColor: 'rail.cyan', railgunFinish: 'gun.stock', crosshair: '',
        ping: 0, admin: false, verified: false, receivedAt: now };
      this.remotes.set(b.id, s);
    }
    // Dynamic (per-tick snapshot):
    s.pos.x = px;
    s.pos.y = py;
    s.pos.z = pz;
    s.yaw = yaw;
    s.pitch = b.pitch ?? 0;
    s.frags = b.frags ?? 0;
    s.deaths = b.deaths ?? 0;
    s.invulnMs = b.invulnMs ?? 0;
    s.ping = b.ping ?? 0;
    // Static (meta channel):
    s.name = m?.name ?? b.id;
    s.team = m?.team ?? null;
    s.hat = m?.hat ?? 'hat.none';
    s.unusual = m?.unusual ?? 'unusual.none';
    s.emote = m?.emote ?? 'emote.cheer';
    s.nameColor = m?.nameColor ?? 'name.default';
    s.spawnEffect = m?.spawnEffect ?? 'spawn.beam';
    s.title = m?.title ?? 'title.none';
    s.titleText = m?.titleText;
    s.railColor = m?.railColor ?? 'rail.cyan';
    s.railgunFinish = m?.railgunFinish ?? 'gun.stock';
    s.crosshair = m?.crosshair ?? '';
    s.admin = m?.admin ?? false;
    s.verified = m?.verified ?? false;
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
      this.send({ type: 'title', id: this.localTitle });
      this.send({ type: 'railColor', id: this.localRailColor });
      this.send({ type: 'railgunFinish', id: this.localRailgunFinish });
      this.send({ type: 'crosshair', code: this.localCrosshair });
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
      // Telemetry: snapshot arrival interval + jitter (EMA), for the overlay.
      const arr = performance.now();
      if (this.dbgLastArrival > 0) {
        const gap = arr - this.dbgLastArrival;
        if (gap > 0 && gap < 500) {
          this.dbgSnapIntervalMs =
            this.dbgSnapIntervalMs === 0 ? gap : this.dbgSnapIntervalMs + (gap - this.dbgSnapIntervalMs) * 0.1;
          this.dbgSnapJitterMs += (Math.abs(gap - this.dbgSnapIntervalMs) - this.dbgSnapJitterMs) * 0.1;
        }
      }
      this.dbgLastArrival = arr;
      const players = new Map<string, StatePlayer>();
      for (const p of msg.players) {
        players.set(p.id, p);
        if (p.id === this.clientId) {
          // Dynamic self-state. Identity (name/admin/verified/team) now arrives
          // on the `meta` channel instead — see the 'meta' handler.
          this.localFrags = p.frags ?? 0;
          this.localDeaths = p.deaths ?? 0;
          this.localInvulnMs = p.invulnMs ?? 0;
        } else {
          // Retain each remote's latest score so their scoreboard row survives
          // the killcam window when they're temporarily absent from snapshots.
          this.lastStatsById.set(p.id, {
            frags: p.frags ?? 0,
            deaths: p.deaths ?? 0,
            ping: p.ping ?? 0,
          });
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
    if (msg.type === 'meta') {
      // Full room roster of slow-changing profiles. Replace ours wholesale, then
      // sweep anyone no longer present (a leaver) so metaById stays authoritative.
      // Cold path (only on join/leave/equip), so a local set is fine here.
      // This is also the stable source for the player-count-scaled FIXED
      // interpolation delay: unlike state snapshots, the roster does not wobble
      // when a dead player is temporarily hidden during their killcam. Set the
      // TARGET; interpolate() slews the applied delay toward it. The first
      // roster of a connection snaps — nothing has been rendered yet, and
      // metaById is empty both on a fresh join and after a reconnect (onclose
      // clears it), so a stale carried-over delay can't survive into a new room.
      this.interpDelayTargetMs = interpDelayForPlayerCount(msg.players.length);
      if (this.metaById.size === 0) this.interpDelayMs = this.interpDelayTargetMs;
      const seen = new Set<string>();
      for (const p of msg.players) {
        seen.add(p.id);
        this.metaById.set(p.id, p);
        if (p.id === this.clientId) {
          if (p.name) this.localName = p.name; // server's authoritative name for us
          this.localAdmin = !!p.admin;
          this.localVerified = !!p.verified;
          this.localTeam = p.team ?? null;
          this.localTitleText = p.titleText ?? ''; // live #N/tier for our own scoreboard row
        }
      }
      for (const id of this.metaById.keys()) {
        if (!seen.has(id)) {
          this.metaById.delete(id);
          this.lastStatsById.delete(id);
        }
      }
      this.emit();
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
      this.ranked = msg.ranked === true;
      this.localTeam = msg.team ?? null;
      this.setResume(msg.resumeAt);
      this.events.onJoined?.({
        roomId: msg.roomId,
        mapId: msg.mapId,
        spawn: msg.spawn,
        state: msg.state,
        mode: this.mode,
        ranked: this.ranked,
        team: this.localTeam,
      });
      return;
    }
    if (msg.type === 'ranked-result') {
      const won = msg.winnerId === this.clientId;
      this.events.onRankedResult?.({
        won,
        forfeit: msg.forfeit,
        reduced: msg.reduced === true,
        winnerName: msg.winnerName,
        loserName: msg.loserName,
        winnerFrags: msg.winnerFrags,
        loserFrags: msg.loserFrags,
        fragLimit: msg.fragLimit,
        rating: msg.rating,
      });
      return;
    }
    if (msg.type === 'join-failed') {
      this.events.onJoinFailed?.(msg.reason);
      return;
    }
    if (msg.type === 'spectating') {
      this.mode = msg.mode ?? 'ffa';
      this.events.onSpectating?.({ mapId: msg.mapId, mode: this.mode, state: msg.state });
      return;
    }
    if (msg.type === 'spectate-failed') {
      this.events.onJoinFailed?.(msg.reason); // surfaced by the same overlay
      return;
    }
    if (msg.type === 'spectate-ended') {
      this.events.onSpectateEnded?.();
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
      this.metaById.delete(msg.clientId);
      this.lastStatsById.delete(msg.clientId);
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
        spectator: msg.spectator,
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

  // How many OTHER players share this room, by the authoritative `meta` roster
  // (not the interpolated `remotes` view). A killed player is hidden from
  // snapshots for their killcam — so `remotes.size` briefly drops to 0 in a 1v1
  // — but they're still in the room. Presence/"waiting for opponents" must key
  // off membership, not visibility, or the match falsely pauses mid-killcam.
  otherPeers(): number {
    let n = 0;
    for (const id of this.metaById.keys()) {
      if (id !== this.clientId) n++;
    }
    return n;
  }

  // Scoreboard rows for every OTHER player in the room, from the meta roster (so
  // a player hidden mid-killcam keeps their row + last-known score) merged with
  // retained dynamic stats. Use this for the scoreboard instead of `remotes`,
  // which only holds currently-visible players.
  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const [id, m] of this.metaById) {
      if (id === this.clientId) continue;
      const s = this.lastStatsById.get(id);
      out.push({
        id,
        name: m.name,
        team: m.team,
        hat: m.hat,
        emote: m.emote,
        title: m.title,
        titleText: m.titleText,
        admin: m.admin,
        verified: m.verified,
        frags: s?.frags ?? 0,
        deaths: s?.deaths ?? 0,
        ping: s?.ping ?? 0,
      });
    }
    return out;
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
  spectators: number; // how many are currently watching this room
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
  spectator?: boolean; // sender is watching the match, not playing
};
export type ChatRejectReason = 'rate' | 'blocked' | 'account';

// Ranked queue status pushed by the server (searching / idle). `reason` explains
// an idle rejection: 'account' = a guest tried to queue (login-only); 'in-match' =
// already in a ranked match in another tab.
export type RankedStatus = {
  state: 'searching' | 'idle';
  size?: number; // players currently in the ranked queue
  since?: number; // server-clock ms the search began
  reason?: 'account' | 'in-match';
};
// A live ranked duel available to spectate (the ladder side-panel).
export type RankedRoom = {
  id: string;
  mapId: string;
  spectators: number;
  players: { name: string; frags: number }[];
};

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
  onRankedStatus: (s: RankedStatus) => void = () => {};
  onRankedRooms: (rooms: RankedRoom[]) => void = () => {};

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
        state?: string; // ranked-status
        size?: number; // ranked queue size
        since?: number; // ranked search start (server clock)
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
        case 'ranked-status': {
          const reason = (msg as { reason?: string }).reason;
          this.onRankedStatus({
            state: msg.state === 'searching' ? 'searching' : 'idle',
            size: typeof msg.size === 'number' ? msg.size : undefined,
            since: typeof msg.since === 'number' ? msg.since : undefined,
            reason: reason === 'account' ? 'account' : reason === 'in-match' ? 'in-match' : undefined,
          });
          break;
        }
        case 'ranked-rooms': {
          const rr = (msg as unknown as { rooms?: RankedRoom[] }).rooms;
          this.onRankedRooms(Array.isArray(rr) ? rr : []);
          break;
        }
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

  // Enter the ranked Duel queue (server pairs you with the closest-rated waiter →
  // a 'matched' resolves the room, same as quick-match). Login-only server-side.
  rankedQueue() {
    this.send({ type: 'ranked-queue' });
  }
  rankedCancel() {
    this.send({ type: 'ranked-cancel' });
  }
  // Ask for the list of live ranked duels to spectate (the ladder side-panel).
  requestRankedRooms() {
    this.send({ type: 'ranked-rooms' });
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
