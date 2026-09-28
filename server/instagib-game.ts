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

import type { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  MATCH_FRAG_LIMIT,
  RAIL_COOLDOWN,
  MAX_HORIZONTAL_SPEED,
  TICK_HZ,
  EYE_HEIGHT,
  DUEL_FRAG_LIMIT,
  RANKED_DUEL_FRAG_LIMIT,
  KILLCAM_DURATION_SEC,
  TDM_FRAG_LIMIT,
  TEAM_COUNT,
  modeCapacity,
  rankedTierName,
  type GameMode,
} from '../src/game/constants';
import {
  ARENA_NET,
  arenaNet,
  isOutOfBounds,
  mapPoolForMode,
  DEFAULT_ARENA_ID,
  MAP_VOTE_DURATION_SEC,
  MAP_VOTE_OPTIONS,
  POTG_GUARD_SEC,
  POST_MATCH_RESET_SEC,
  ROOM_CODE_LEN,
} from '../src/game/arena-data';
import { randomBytes } from 'node:crypto';
import type { CardPayload, Vec3 } from '../src/game/types';
import {
  DEFAULT_RAIL_COLOR,
  DEFAULT_RAILGUN_FINISH,
  isCard,
  isKillEffectStyle,
  DEFAULT_KILL_EFFECT,
  isUnusual,
  titleById,
} from '../src/game/cosmetics';
import type { Loadout, Look } from '../src/game/items/types';
import { addStrangeKills, resolveEquipped, resolveTokens } from './economy';
import {
  encodeState,
  decodePos,
  quantizeStateCoord,
  toView,
  POS_FLAG_HOLD,
  type BinStatePlayer,
} from '../src/game/netcodec';
import {
  findUserById,
  getRankedProfile,
  getRankedRating,
  levelFor,
  logEvent,
  recordMatch,
  recordRankedResult,
} from './db';
import { accountIdFromCookieHeader } from './auth';
import { containsProfanity } from './profanity';

// Snapshot rate, paired with the client's 64Hz sim + 64Hz position upload so
// the whole pipeline runs on one cadence. The lean-snapshot split (static
// profile moved to the on-change `meta` channel — see broadcastMeta) shrank each
// row ~60%, so even at 64Hz a full 8-player room sends FEWER bytes/sec than the
// old 32Hz fat snapshot did, while giving the client twice the interpolation
// keyframes (smoother direction changes) and finer (15.6ms) lag-comp history.
const SNAPSHOT_HZ = 64;
// Opt-in production/load-test telemetry for diagnosing snapshot cadence and
// socket queueing without logging every tick. Enable with NETCODE_DIAG=1.
const NETCODE_DIAG = process.env.NETCODE_DIAG === '1';
const NETCODE_DIAG_INTERVAL_MS = 5_000;
// State snapshots are absolute, so sending another one into a backed-up TCP
// socket only makes that viewer see older truth later. Let the queue drain and
// resume from a fresh frame instead. This budget is roughly four full 8p frames.
const MAX_SNAPSHOT_BUFFERED_BYTES = 1024;
const STALE_CLIENT_TIMEOUT_MS = 10_000;
// A dropped in-match player's slot + score are held this long for a reconnect to
// reclaim (via the resume token) before the record is reaped.
const RESUME_GRACE_MS = 20_000;
const EMPTY_ROOM_GRACE_MS = 30_000; // post-match grace for a room that HAS been occupied
const FRESH_ROOM_GRACE_MS = 5 * 60_000; // never-occupied (invite) rooms live longer for slow joins
const KILL_MAX_RANGE = 220;
const SPAWN_INVULN_MS = 1_500; // spawn grace once you have control (matches offline LOCAL_RESPAWN_INVULN_SEC)
// A killed player can't act until their client's killcam finishes, so their
// post-frag invuln must SPAN the killcam and still leave SPAWN_INVULN_MS once
// they regain control — otherwise it elapses mid-killcam and they spawn exposed
// (and are spawn-killable while watching it). Mirrors the offline grace in
// game.ts handleLocalDeath (KILLCAM_DURATION_SEC + grace).
const KILL_RESPAWN_INVULN_MS = KILLCAM_DURATION_SEC * 1000 + SPAWN_INVULN_MS;
// Anti-spawn-kill: a freshly-killed player is HIDDEN from everyone's snapshot and
// untargetable for the length of their killcam, then "appears" at their (already
// away-from-killer) spawn with the remaining invuln. So nobody can see or camp
// the spawn while the victim is stuck watching their killcam — the big 1v1 issue.
const RESPAWN_HIDE_MS = KILLCAM_DURATION_SEC * 1000;
// Anti-camp spawn scoring. The server has NO map geometry (no real line-of-sight),
// so these are the geometry-free levers layered on top of "spawn far from threats":
//   1. don't drop a player into a live threat's AIM CONE (their crosshair line), and
//   2. don't reuse a spawn spot a camper might be sitting on.
// Both reshape pickSpawn's distance score (values are in "metres of safety").
const SPAWN_VIEW_RANGE = 50; // m: a threat's aim endangers a spawn within this (covers the maps)
const SPAWN_VIEW_DOT = 0.55; // cos(~57°): past this, the spawn is "in their crosshair"
// Safety cost (m-equiv) for a dead-centre aim. This is INSTAGIB — the rail is
// hitscan, so a crosshair-line spawn is just as lethal at 40m as at 5m. So the
// penalty barely falls off with range (mild 0.5 floor), and it's set ABOVE the
// max recent-spawn penalty so the anti-camp avoidance can't be out-voted by the
// variety term (i.e. we never rotate a player INTO a held sightline for variety).
const SPAWN_VIEW_PENALTY = 34;
const SPAWN_RECENT_MS = 5_000; // remember each chosen spawn spot for this long
const SPAWN_RECENT_RADIUS = 6; // m: a candidate within this of a recent spawn counts as reuse
const SPAWN_RECENT_PENALTY = 16; // safety cost (m-equiv) for reusing a just-used spot
// Hard separation: never spawn within this of ANY other player's committed
// position — including a killcam-hidden one (they're about to reappear at the
// spot already written to their record). Stops the "two players materialize on
// top of each other" case that the (live-only) threat set can't see. Enforced as
// a near-hard exclusion with graceful fallback, NOT a soft penalty, so it can't
// be out-voted by the distance/variety scoring.
const SPAWN_SEPARATION = 6;
// Warmup: a short "get ready" countdown at the start of a match. Reuses the
// existing `resumeAt` shot-freeze, so nobody can be fragged before it ends. Set
// on room creation and when a room fills from 1→2 players (a match begins).
const WARMUP_MS = 3_000;
const HISTORY_MS = 1_000; // how far back we keep position history for rewind
// Anti-alias resampling. A client sends its position at ~64Hz and the server
// snapshots at 64Hz on an INDEPENDENT timer, so the last-received position is
// 0–16ms stale by a VARYING amount — at 30–50 m/s (rocket-jump / air-strafe)
// that's ~0.3–0.8m of position wobble per snapshot, the dominant high-speed
// jitter. Instead of snapshotting the raw last-received pos, we resample each
// player to a single consistent instant `now − POS_LAG_MS` by interpolating
// their received-pos buffer (pure interpolation — no extrapolation/overshoot,
// since 64Hz sends keep a sample within 16ms). The SAME resampled pos feeds both
// the snapshot AND the lag-comp history, so what a viewer sees is exactly what
// the server rewinds to → smoother motion AND fewer "hit but no kill".
// The resample lag is PER PLAYER and adaptive: a clean ~40ms sender gets the
// floor; a player whose position arrives in bursts (TCP stalls on their upstream
// — what makes a high-ping player stutter for everyone) gets buffered more, so
// their motion stays smoothly INTERPOLATED instead of held-then-jumped. Sized to
// each sender's measured arrival-jitter. Low-ping players are unaffected.
const POS_LAG_MS = 20; // floor: minimal resample delay for a clean, steady sender
const POS_LAG_MAX_MS = 180; // ceiling: even a very bursty sender isn't delayed past this
const POS_LAG_JITTER_K = 2.5; // how many σ of a sender's arrival-jitter to buffer
const POS_SAMPLE_WINDOW_MS = 300; // received-pos buffer retention (legacy, receive-time stamped)
// ── Tick-stamped uploads (BIN_POS_TICK) ──────────────────────────────────
// A current client stamps every upload with its 64Hz simulation tick. Receive-
// time stamping (above) bakes the sender's FRAME timing into the motion: the
// client steps its sim inside requestAnimationFrame, so on a 60Hz display every
// ~16th frame runs two ticks and flushes two uploads together, on 144Hz the
// gaps alternate ~14/21ms, and any hitch flushes 2–5 at once. Stamped by
// arrival, each flush reads as "no time passed, then a jump" and every viewer
// sees that player micro-stutter, even at 20ms ping. Stamped by tick, samples
// are exactly 15.625ms apart on the sender's own timeline, whatever the frame
// pacing or the network did.
//
// The snapshot tick then plays each sender's timeline back at
//   simTime = now − playoutMs
// where playoutMs covers the 95th percentile of their recent arrival lateness
// (arrival − sim time, over a ~2.5s window) + one tick, so the sample after the
// playout point has almost always arrived (interpolation). The rare late ones —
// a GC pause or long frame on the sender, flushed as a burst — are bridged by a
// short capped extrapolation instead of raising everyone's view of that player
// by the hitch (a rolling MAX doubled the delay for a routine 45ms hitch).
// Clients send one unchanged sample before going quiet, so a stop is always
// visible as zero velocity and extrapolation never runs past it. playoutMs
// slews toward its target at a bounded rate — asymmetric: rises quickly for a
// sender that turns bursty, relaxes slowly — and snaps only on a large
// discontinuity, so playback speed never wobbles with arrival timing.
const TICK_MS = 1000 / TICK_HZ;
const POS_TICK_SAMPLE_WINDOW_MS = 600; // sample retention on the sim timeline
const POS_LATE_WINDOW = 160; // lateness samples kept (~2.5s at 64Hz)
const POS_LATE_PERCENTILE = 0.95;
const POS_LATE_RECOMPUTE_MS = 250;
const POS_EXTRAP_MAX_MS = 48; // bridge at most 3 ticks past the newest sample
const POS_PLAYOUT_MARGIN_MS = 2;
const POS_PLAYOUT_TICKS = 0.5; // headroom past the lateness target (the rest is bridged by extrapolation)
const POS_PLAYOUT_RISE_MS_PER_S = 80; // ≤8% slow-down while absorbing a burstier sender
const POS_PLAYOUT_FALL_MS_PER_S = 20; // ≤2% speed-up while relaxing
const POS_PLAYOUT_SNAP_MS = 400; // beyond any stall the cap allows: a real discontinuity, snap once
const POS_PLAYOUT_EXTRA_MAX_MS = 200; // max playout above the newest upload's lateness
// Anti-speedhack for tick-stamped uploads — two bounds, both on a MONOTONIC
// arrival clock (an NTP step can't trip them):
//  • per upload, the speed clamp's dt is the claimed sim dt but never more
//    than the real time since the last accepted upload + POS_DT_SLACK_MS, so
//    time banked by letting the sim clock fall behind can't be spent in one
//    blink (honest multi-tick flushes need only a tick of slack each);
//  • cumulatively, the sim clock may not run ahead of its lead baseline
//    (sim ms − arrival ms) by more than POS_LEAD_SLACK_MS; the baseline creeps
//    at POS_LEAD_CREEP_PER_S. A persistent overrun (POS_LEAD_RESEED_REJECTS in a
//    row, ~0.5s — e.g. a first upload that arrived very late behind a TCP
//    retransmit set the baseline low) re-seeds it rather than freezing an
//    honest player; that upload's clamp gets real time only.
const POS_DT_SLACK_MS = 50;
// Movement credit for the speed clamp, on every path: real time accrues per
// RECEIVED upload (so a player whose uploads were briefly rejected can still
// catch up), but a silent gap accrues at most POS_SILENT_CREDIT_MS — "go
// silent, then blink" used to allow 80 m/s × the whole silence. Honest clients
// never need more: idle ones heartbeat every 250ms without moving, and a
// stalled connection re-delivers every tick in order. Reset on each accept.
const POS_SILENT_CREDIT_MS = 100;
const POS_LEAD_SLACK_MS = 250;
const POS_LEAD_CREEP_PER_S = 20;
const POS_LEAD_RESEED_REJECTS = 32;
// Upload sanity: finite, in-arena magnitudes. A float32 yaw of ~1e30 used to
// spin the angle-wrap loop forever (the whole server hung).
const POS_MAX_COORD = 1e4;
const POS_MAX_ANGLE = 1e3;
const POS_RESAMPLE_TELEPORT = 5; // m between adjacent samples above which we DON'T lerp (respawn)
// Clamp how far a shot may rewind targets. The server-side rewind is uplink +
// the shooter's interp delay (≈ RTT + ~30ms with the ping-aware delay), so this
// keeps exact lag comp up to ~470ms RTT (the old fixed 110ms delay reached ~480).
const MAX_REWIND_MS = 500;
const DEFAULT_CAPACITY = 8;
// Anti-cheat / abuse guards. The server is authoritative for hits + score, so
// these are the trust boundary against modified clients.
const SHOT_ORIGIN_MAX_DIST = 3; // shot origin must be within this of the shooter's server eye
const FIRE_RATE_TOLERANCE_MS = 80; // jitter slack under RAIL_COOLDOWN before a shot is dropped
const MAX_MOVE_SPEED = MAX_HORIZONTAL_SPEED * 1.6; // reject pos deltas faster than this (m/s)
// Generous vertical cap: legit jumps/boosts/long falls peak ~45 m/s, so 80
// never flags real play but still catches noclip/fly teleports (100s of m/s).
const MAX_VERTICAL_SPEED = 80;
// Kick a player who hasn't moved or fired in this long (frees a slot in 2-cap
// duel rooms; generous so a brief alt-tab doesn't drop you).
const AFK_TIMEOUT_MS = 120_000;
const MSG_RATE_WINDOW_MS = 1_000;
const MSG_RATE_LIMIT = 150; // inbound messages/sec before a socket is closed (flood guard)
// Global lobby chat guards. Stricter than the socket flood guard above: chat is
// the one place a client picks the content, so it's rate-limited per sender,
// length-capped, sanitized, and run through the username profanity filter.
const CHAT_MAX_LEN = 240; // hard cap after sanitize
const CHAT_RATE_WINDOW_MS = 10_000; // rolling per-sender window
const CHAT_RATE_LIMIT = 6; // messages per window before we drop + notify
const CHAT_HISTORY_MAX = 50; // recent messages replayed to a client on open
// Hitbox dims (must match the client's PLAYER_RADIUS / PLAYER_HEIGHT).
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.8;
const HEADSHOT_FRAC = 0.72;
// Server-authoritative progression (see settleClient). The flat "match played"
// base XP is pro rata by time present, full at this, so join/leave (or
// join/frag/forfeit) cycling earns ~0 base.
const PRESENCE_FULL_MS = 180_000;
// A match is only recorded at all (XP, total_games, the "games" challenge) for
// a player present at least this long, or with at least one frag/death.
const MIN_RECORD_PRESENCE_MS = 45_000;
// Repeat-victim decay (FFA/TDM): the first VICTIM_FULL_KILLS frags on the same
// player (account, or network identity for a guest) in one match are full
// value, then kill/headshot/streak XP halves
// every further VICTIM_DECAY_EVERY. Duels are exempt — one opponent is the
// format, and a duel is capped at its frag limit.
const VICTIM_FULL_KILLS = 5;
const VICTIM_DECAY_EVERY = 5;
// A TDM team win only counts for a member who was in the match at least this
// long (no joining 10s before the end to collect the win + first-win bonus).
const TDM_WIN_MIN_PRESENCE_MS = 60_000;
// A forfeit (opponent left a duel/ranked) only counts as a WIN for XP if the
// survivor had reached this fraction of the frag limit — otherwise it's a no
// contest (stops two accounts trading instant forfeits for win XP). Elo is
// unaffected (endRankedMatch decides that).
const FORFEIT_WIN_MIN_FRAC = 1 / 3;

type Vec = Vec3;
type ClientId = string;
type RoomId = string;
type HistorySample = { t: number; x: number; y: number; z: number };
// Received-pos sample used to resample to snapshot time. `t` is the RECEIVE
// time for legacy uploads, or the sender's SIM time (tick × TICK_MS) for
// tick-stamped ones — see PosTimeline.
type PosSample = { t: number; x: number; y: number; z: number; yaw: number };
// Per-sender playback state for tick-stamped uploads (see TICK_MS above).
type PosTimeline = {
  lastTick: number; // last accepted sim tick (-1 = none yet → legacy path until one arrives)
  lastArrival: number; // server ms (Date.now) of the last accepted upload
  lastMono: number; // monotonic ms (performance.now) of the last accepted upload
  leadBase: number; // anti-speedhack baseline of (sim ms − monotonic arrival ms)
  leadRejects: number; // consecutive over-lead rejections (→ re-seed)
  late: Float64Array; // ring of recent (arrival ms − sim ms)
  lateCount: number;
  lateIdx: number;
  lateTarget: number; // POS_LATE_PERCENTILE of the ring, refreshed every POS_LATE_RECOMPUTE_MS
  lateRecomputeAt: number;
  lastLate: number; // lateness of the newest upload
  playoutMs: number; // APPLIED offset: render the sim time now − playoutMs (0 = unseeded)
};

type ClientRecord = {
  id: ClientId;
  socket: WebSocket;
  name: string;
  roomId: RoomId | null; // null while browsing the lobby OR spectating
  spectating: RoomId | null; // room this connection is watching (read-only); null when playing/browsing
  pos: Vec;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnUntilMs: number;
  respawnAt: number; // >0 and in the future → hidden + untargetable (killcam window); 0 = live
  connectedAt: number;
  lastSeen: number;
  lastActiveMs: number; // last meaningful input (real movement or a shot) — for AFK
  rttMs: number; // client-reported round-trip ping, echoed to the scoreboard
  resumeToken: string; // opaque token a reconnecting client presents to reclaim this slot
  disconnectedAt: number; // ms timestamp the socket dropped (0 = connected); resume grace
  lastRecoverMs: number; // last void-recovery time (debounces stale OOB positions)
  lastShotMs: number; // server-side fire-rate gate
  lastPosMs: number; // for the pos-update speed clamp
  lastPosRxMono: number; // monotonic ms of the last RECEIVED pos (accepted or not)
  posCreditMs: number; // movement time the speed clamp allows (see POS_SILENT_CREDIT_MS)
  msgWindowStart: number; // inbound message-rate window start
  msgCount: number; // messages seen in the current window
  roomWindowStart: number; // room-creation rate window start
  roomCount: number; // rooms created in the current window
  chatWindowStart: number; // global-chat rate window start
  chatCount: number; // chat messages sent in the current window
  history: HistorySample[]; // ascending by t (RESAMPLED positions — see snapshot tick)
  posSamples: PosSample[]; // received-pos buffer (receive- or sim-time stamped) for resampling
  posTl: PosTimeline; // tick-stamped playback timeline (unused by legacy uploads)
  renderPos: { x: number; y: number; z: number; yaw: number }; // resampled pos for snapshot + history
  posGapEma: number; // EMA of inter-arrival gap of this player's pos (while moving)
  posGapJitterEma: number; // EMA of that gap's deviation → sizes their adaptive resample lag
  // Rolling aim stats for the anti-aimbot heuristic (decayed each window).
  aimShots: number;
  aimHits: number;
  aimHeadshots: number;
  aimFlagged: boolean; // statistical outlier → frags throttled
  // Per-match counters for server-authoritative progression. Reset with
  // frags/deaths (join, map-vote reset), carried over on resume, consumed by
  // settleClient at match end / mid-match leave.
  mShots: number; // accepted shots (past the fire-rate/origin/warmup gates), minus shots spent on non-counting victims
  mHits: number; // shots that landed a counting frag
  mKills: number; // counting frags: victims that aren't you (see sameIdentity)
  mKillWeight: number; // Σ repeat-victim weights of those frags (≤ mKills)
  mVictims: Map<string, number>; // victim identity (identityKey) → counting frags on them this match
  mHeadshots: number; // frags that were headshots
  mStreak: number; // current kill streak (reset on death)
  mBestStreak: number;
  mStartedAt: number; // ms: when this player's current match began (join / reset)
  mSettled: boolean; // this match's progression is already recorded
  undeliveredProgression: object | null; // a `progression` push that found the socket closed (resent on resume)
  team: number | null; // team index (0/1) in TDM; null otherwise
  hat: string; // equipped hat cosmetic id (echoed to other players in snapshots)
  unusual: string; // equipped unusual-effect cosmetic id
  emote: string; // equipped podium-emote cosmetic id
  nameColor: string; // equipped nameplate-color cosmetic id (echoed in snapshots)
  spawnEffect: string; // equipped spawn-in-effect cosmetic id (echoed in snapshots)
  killEffect: string; // equipped finisher (kill-effect style) — stamped on this player's kills
  title: string; // equipped title cosmetic id (flair under the name; echoed in snapshots)
  railColor: string; // equipped rail-beam color cosmetic id (echoed so others/spectators see your beam)
  railgunFinish: string; // equipped railgun-finish (gun skin) cosmetic id (echoed for the 3rd-person gun)
  looks: Loadout; // v3: resolved Looks of the equipped items (broadcast in `meta`)
  strangeUids: string[]; // equipped Strange instances that earn this match's counted frags
  lastTauntMs: number; // taunt rate-limit
  crosshair: string; // equipped crosshair as a share-code string ('' = default); echoed for spectators
  card: CardPayload | null; // playercard shown on the victim's killcam
  playerId: string; // account id from the igsession cookie on the WS upgrade, '' if guest
  netId: string; // client network identity (IP) from the WS upgrade — see netIdFrom
  admin: boolean; // account is_admin — drives the staff badge (echoed in snapshots)
  verified: boolean; // account is_verified — drives the blue check (echoed in snapshots)
};

type Room = {
  id: RoomId;
  name: string;
  mode: GameMode;
  mapId: string;
  isPublic: boolean;
  // Ranked Duel: a single first-to-N 1v1 (no rounds, no map vote). Reuses the
  // duel room machinery (capacity 2, 1v1 maps + spawns) but ends via Elo update +
  // room dissolve instead of rounds/vote. Kept out of the public lobby list.
  isRanked: boolean;
  capacity: number;
  hostId: ClientId | null;
  members: Set<ClientId>;
  spectators: Set<ClientId>; // read-only observers; not players (never in snapshots/shots/teams/votes)
  state: 'active' | 'voting';
  vote: {
    options: string[];
    votes: Map<ClientId, string>;
    endsAt: number;
    winnerId: ClientId | null;
    winnerTeam: number | null;
  } | null;
  resumeAt: number; // ms timestamp; shots ignored until then (post-vote breather)
  firstBloodAwarded: boolean; // first kill of the current match has landed
  emptySince: number; // ms timestamp it became empty, 0 if occupied
  wasEverOccupied: boolean; // distinguishes a never-joined invite room from a post-match empty
  createdAt: number;
  // Recently-used spawn spots (anti-camp): pickSpawn penalizes candidates near
  // these so a camper can't farm the same spawn. Pruned by age (SPAWN_RECENT_MS).
  recentSpawns: { x: number; z: number; t: number }[];
  // Players who already left this match with a recorded partial — they still
  // count as opponents for the "someone else played" win rule. Reset per match.
  matchLeft: { id: ClientId; playerId: string; netId: string }[];
};

type ClientMessage =
  | { type: 'hello'; name?: string }
  | { type: 'list' }
  | { type: 'create'; name?: string; mapId?: string; isPublic?: boolean; capacity?: number; mode?: string }
  | { type: 'quickmatch'; name?: string; mode?: string }
  | { type: 'ranked-queue' }
  | { type: 'ranked-cancel' }
  | { type: 'ranked-rooms' }
  | { type: 'join'; roomId?: string; name?: string }
  | { type: 'spectate'; roomId?: string; name?: string }
  | { type: 'resume'; token?: string; roomId?: string; name?: string }
  | { type: 'leave' }
  | { type: 'vote'; mapId?: string }
  | { type: 'hat'; id?: string }
  | { type: 'unusual'; id?: string }
  | { type: 'emote'; id?: string }
  | { type: 'nameColor'; id?: string }
  | { type: 'spawnEffect'; id?: string }
  | { type: 'killEffect'; id?: string }
  | { type: 'title'; id?: string }
  | { type: 'railColor'; id?: string }
  | { type: 'railgunFinish'; id?: string }
  | { type: 'loadout'; uids?: unknown }
  | { type: 'taunt' }
  | { type: 'crosshair'; code?: string }
  | { type: 'card'; card?: unknown }
  | { type: 'chat'; text?: string }
  | { type: 'pos'; x: number; y: number; z: number; yaw: number; pitch?: number; tick?: number; flags?: number }
  | { type: 'ping'; ts: number; rtt?: number }
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

// Server→client lobby social payloads (presence list + global chat). Identity
// fields are SERVER-set from the account, never the client, so chat can't be
// used to impersonate or to inject an unmoderated name.
type PresencePlayer = { name: string; admin: boolean; verified: boolean; inMatch: boolean };
type PresenceBroadcast = {
  type: 'presence';
  online: number; // distinct accounts + guest sockets currently connected
  guests: number; // connected sockets without an account
  players: PresencePlayer[]; // registered, deduped by account, name-sorted
};
type ChatBroadcast = {
  type: 'chat';
  id: number;
  name: string; // account username, or "Guest N" for anonymous senders
  text: string; // sanitized + length-capped
  ts: number;
  admin: boolean;
  verified: boolean;
  guest: boolean;
  spectator?: boolean; // true when the sender is watching, not playing
};

// Economy v3: what a player wears is a set of Looks resolved SERVER-SIDE from
// their equipped item instances (server/economy.ts) — the client only names the
// uids it wants shown ({type:'loadout'}), and each is ownership-checked. The
// legacy per-slot fields on ClientRecord (hat, railColor…) are derived from the
// Looks so pre-v3 code paths keep working.
const TAUNT_COOLDOWN_MS = 3_000;

// Unusual-effect id ('fx.embers') → the legacy per-slot unusual id, if one exists.
function legacyUnusual(look: Look | undefined): string {
  const id = look?.e ? `unusual.${look.e.replace(/^fx\./, '')}` : '';
  return id && isUnusual(id) ? id : 'unusual.none';
}

// Copy resolved Looks onto a record (+ the derived legacy fields).
function applyLooks(c: ClientRecord, looks: Loadout, strangeUids: string[]): void {
  c.looks = looks;
  c.strangeUids = strangeUids;
  c.hat = looks.hat?.d ?? 'hat.none';
  c.unusual = legacyUnusual(looks.hat);
  c.emote = looks.emote?.d ?? 'emote.cheer';
  c.nameColor = looks.nameColor?.d ?? 'name.default';
  c.spawnEffect = looks.spawn?.d ?? 'spawn.beam';
  const fin = looks.finisher?.d;
  c.killEffect = fin && isKillEffectStyle(fin) ? fin : DEFAULT_KILL_EFFECT;
  c.title = looks.title?.d ?? 'title.none';
  c.railColor = looks.beam?.d ?? DEFAULT_RAIL_COLOR;
  c.railgunFinish = looks.finish?.d ?? DEFAULT_RAILGUN_FINISH;
  // Keep the killcard in step with the equipped card + title.
  if (c.card) {
    const cardId = looks.card?.d;
    c.card.style = cardId && isCard(cardId) ? cardId : 'card.slate';
    c.card.title = titleById(c.title).text;
  }
}

// Per-connection room-creation budget: a client may mint at most ROOM_BUDGET
// rooms per ROOM_WINDOW_MS. Stops `create`/`quickmatch` spam from flooding the
// room map with phantom lobbies (each otherwise lives out a reap grace window).
const ROOM_WINDOW_MS = 15_000;
const ROOM_BUDGET = 8;
function chargeRoomCreate(record: ClientRecord, ts: number): boolean {
  if (ts - record.roomWindowStart > ROOM_WINDOW_MS) {
    record.roomWindowStart = ts;
    record.roomCount = 0;
  }
  if (record.roomCount >= ROOM_BUDGET) return false;
  record.roomCount += 1;
  return true;
}

// Sanitize a client-sent playercard into a bounded, trusted shape before we
// relay it to other players (cosmetic-only). The NAME is forced to the
// server-known name (clients can't impersonate on the killcam), the LEVEL to
// the account's real level (guests 1), the STYLE is
// ownership-checked, the TITLE is forced from the player's server-validated
// equipped title (never the client payload), and stat strings are length-clamped.
function sanitizeCard(
  raw: unknown,
  serverName: string,
  equippedStyle: string,
  flags: { admin: boolean; verified: boolean; title: string; level: number },
): CardPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = serverName.slice(0, 24);
  // The account's real (XP-derived) level — never the client's claim.
  const level = flags.level;
  // The card style is the server-validated equipped card, never the client's claim.
  const style = isCard(equippedStyle) ? equippedStyle : 'card.slate';
  const stats: { label: string; value: string }[] = [];
  if (Array.isArray(o.stats)) {
    for (const s of o.stats.slice(0, 3)) {
      if (s && typeof s === 'object') {
        const ss = s as Record<string, unknown>;
        stats.push({
          label: typeof ss.label === 'string' ? ss.label.slice(0, 16) : '',
          value: typeof ss.value === 'string' ? ss.value.slice(0, 12) : '',
        });
      }
    }
  }
  // verified/admin/title are SERVER-set (from the account + validated equipped
  // title), never the client payload, so a modified client can't fake a blue
  // check, staff badge, or a title it hasn't earned on its killcard.
  return { name, level, style, stats, title: flags.title, verified: flags.verified, admin: flags.admin };
}

// The flair text shown under a player's name / on their killcard for their
// equipped title. Static titles use their manifest text; the live 'ranked' title
// resolves to the player's CURRENT standing — top-10 → "#N", otherwise their tier
// name, and '' if they've never played ranked. Resolved server-side so the badge
// is authoritative (a client can't fake "#1") and stays live as ratings move.
function resolveTitleText(playerId: string, titleId: string): string {
  const t = titleById(titleId);
  if (t.dynamic === 'ranked') {
    if (!playerId) return '';
    const p = getRankedProfile(playerId);
    if (!p || p.games === 0) return '';
    return p.rank >= 1 && p.rank <= 10 ? `#${p.rank}` : rankedTierName(p.rating);
  }
  return t.text;
}

// The WS upgrade request, as far as this module reads it.
type UpgradeReq = {
  headers?: {
    cookie?: string;
    'cf-connecting-ip'?: string | string[];
    'x-forwarded-for'?: string | string[];
  };
  socket?: { remoteAddress?: string };
};

// Client network identity (IP) for the progression self-farm guard. Same
// precedence as server/index.ts clientIp(): Cloudflare's CF-Connecting-IP, else
// the first X-Forwarded-For hop (Railway's proxy), else the socket address.
function netIdFrom(req?: UpgradeReq): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const cf = one(req?.headers?.['cf-connecting-ip'])?.trim();
  if (cf) return cf;
  const xff = one(req?.headers?.['x-forwarded-for']);
  const ip = (xff ? xff.split(',')[0] : req?.socket?.remoteAddress ?? '').trim();
  return ip.replace(/^::ffff:/, '') || 'unknown';
}

// Are these the same player for progression purposes? Same account, or the
// same network identity (your own guest tab, a second account on this
// machine). Shared-IP households therefore don't earn XP off each other — an
// accepted trade-off. An undeterminable IP never matches.
function sameIdentity(
  a: { playerId: string; netId: string },
  b: { playerId: string; netId: string },
): boolean {
  if (a.playerId && a.playerId === b.playerId) return true;
  return a.netId !== 'unknown' && a.netId === b.netId;
}

// Stable per-player key for repeat-victim decay: the account, else the network.
function identityKey(c: { playerId: string; netId: string }): string {
  return c.playerId ? `a:${c.playerId}` : `ip:${c.netId}`;
}

function genId(len = 8): ClientId {
  return Math.random().toString(36).slice(2, 2 + len);
}

// Cryptographically-strong token for slot reclaim — it's the only secret
// guarding the resume path, so it must not come from predictable Math.random().
// Wrap an angle to [-π, π] in closed form (a subtract-2π loop never ends for
// huge inputs).
function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

function newPosTimeline(): PosTimeline {
  return {
    lastTick: -1,
    lastArrival: 0,
    lastMono: 0,
    leadBase: 0,
    leadRejects: 0,
    late: new Float64Array(POS_LATE_WINDOW),
    lateCount: 0,
    lateIdx: 0,
    lateTarget: 0,
    lateRecomputeAt: 0,
    lastLate: 0,
    playoutMs: 0,
  };
}

function genToken(): string {
  return randomBytes(24).toString('base64url');
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function parseMode(v: unknown): GameMode {
  return v === 'duel' || v === 'tdm' ? v : 'ffa';
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
  // Ranked Duel matchmaking queue: account-only sockets waiting for a 1v1. The
  // pairing tick (below) matches the two closest-rated waiters, widening the
  // acceptable rating gap the longer someone waits. Keyed by connection id.
  const rankedQueue = new Map<ClientId, { rating: number; joinedAt: number }>();
  // Anti match-fixing (office-friendly): matches are NEVER blocked by IP or
  // rematch limits — colleagues on one office IP must be able to duel freely.
  // Instead, beating the SAME opponent repeatedly within a rolling window earns
  // DIMINISHING Elo, so self-farming / win-trading is pointless while a normal
  // game (even a rematch or two) still moves full rating. We track each account
  // PAIR's recent match times (sorted, sorted-id key) and derive a rating weight.
  const recentRankedPairs = new Map<string, number[]>();
  const RANKED_REPEAT_WINDOW_MS = 60 * 60_000; // 1h rolling window for "repeat opponent"
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  // Rating weight from how many times this pair already played in the window:
  // 0→1.0 (full), 1→0.5, 2→0.25, … (2^-n). Farming decays to ~nothing fast.
  const repeatWeight = (priorMatches: number): number => 2 ** -Math.max(0, priorMatches);
  // Is this account already in a live ranked match (on any of its connections)?
  // Stops queueing a second tab while playing ranked.
  const accountInRankedMatch = (playerId: string): boolean => {
    for (const c of clients.values()) {
      if (c.playerId !== playerId || !c.roomId) continue;
      const r = rooms.get(c.roomId);
      if (r?.isRanked && r.state === 'active' && r.members.has(c.id)) return true;
    }
    return false;
  };

  // ── Global lobby presence + chat ──────────────────────────────────────
  // One global room. Recent chat is kept in memory only (cleared on restart)
  // and replayed to a client when it opens the menu. `listers` (clients that
  // sent `list`, i.e. are sitting in the menu) is both the chat audience and
  // the set allowed to send — in-match sockets aren't listers.
  const chatHistory: ChatBroadcast[] = [];
  let chatSeq = 0;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Strip control chars, zero-width, and BiDi-override characters, collapse
  // whitespace, and length-cap. Returns null for empty/non-string. React escapes
  // on render, so this is defense-in-depth (anti spoofing / layout abuse), not
  // the sole XSS guard.
  const sanitizeChat = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const cleaned = raw
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned ? cleaned.slice(0, CHAT_MAX_LEN) : null;
  };

  // Online presence for the menu: registered players are deduped by account
  // (multi-tab → one entry) and listed by name; guests are only counted, never
  // named (anonymous → indistinguishable, and a name list would be a slur vector).
  const buildPresence = (): PresenceBroadcast => {
    const byAccount = new Map<string, PresencePlayer>();
    let guests = 0;
    for (const c of clients.values()) {
      if (c.disconnectedAt > 0) continue; // dropped, awaiting resume — not live
      if (c.playerId) {
        const seen = byAccount.get(c.playerId);
        if (seen) seen.inMatch = seen.inMatch || c.roomId != null;
        else
          byAccount.set(c.playerId, {
            name: c.name,
            admin: c.admin,
            verified: c.verified,
            inMatch: c.roomId != null,
          });
      } else {
        guests += 1;
      }
    }
    const players = [...byAccount.values()].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    return { type: 'presence', online: players.length + guests, guests, players };
  };

  const broadcastPresence = () => {
    if (listers.size === 0) return;
    const payload = JSON.stringify(buildPresence());
    for (const id of listers) {
      const c = clients.get(id);
      if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
    }
  };

  // Coalesce bursts (e.g. a room emptying mid-sweep) into one presence push.
  const schedulePresence = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      broadcastPresence();
    }, 200);
    presenceTimer.unref?.();
  };

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
    // Spectators receive the same room broadcasts (meta/beam/kill/vote/chat/peer)
    // so the watched match looks identical to what players see. They never appear
    // in members, so they're excluded from snapshots, shots, teams, and votes.
    for (const id of room.spectators) {
      if (id === exceptId) continue;
      const c = clients.get(id);
      if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  };

  // ── Transport seam (UDP plan Phase 1 — docs/NETCODE-UDP-PLAN.md §4) ────
  // The two hot, loss-tolerant message types — `pos` up, `state` down — cross
  // this seam instead of touching the WebSocket directly. Both are idempotent
  // absolute state, so a lost frame needs no recovery: the next one fully
  // replaces it. Today the seam is backed by the same WS (TCP) and behavior is
  // unchanged; Phase 2 points these two functions at an unreliable datagram
  // channel (WebTransport) per client, while everything that must not be lost
  // or reordered (join/meta/kill/vote/chat…) stays on the WS.

  // Decode one unreliable client→server frame, whatever pipe it arrived on
  // (today: the 64Hz binary pos riding the WS as a binary frame).
  const decodeUnreliable = (raw: RawData): ClientMessage | null => {
    const data = Array.isArray(raw) ? Buffer.concat(raw as Buffer[]) : (raw as Buffer);
    const p = decodePos(toView(data));
    if (!p) return null; // unknown/garbage binary → ignore
    return { type: 'pos', x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, tick: p.tick, flags: p.flags };
  };

  // Fan one server→client state frame out to a single client. Backpressure: a
  // socket already holding a backlog gets this frame SKIPPED rather than queued
  // behind it (absolute state — the next frame fully replaces this one).
  // Diag counters live here so player and spectator sends are tallied alike;
  // they're initialized before the snapshot timer ever fires.
  const sendUnreliable = (c: ClientRecord, buf: Uint8Array): void => {
    if (c.socket.readyState !== c.socket.OPEN) return;
    if (NETCODE_DIAG) snapshotDiagBufferedMax = Math.max(snapshotDiagBufferedMax, c.socket.bufferedAmount);
    if (c.socket.bufferedAmount > MAX_SNAPSHOT_BUFFERED_BYTES) {
      if (NETCODE_DIAG) snapshotDiagSkipped += 1;
      return;
    }
    c.socket.send(buf);
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
    mode: GameMode;
    mapId: string;
    isPublic: boolean;
    capacity: number;
    hostId: ClientId | null;
    isRanked?: boolean;
  }): Room => {
    // Duel is locked to 2; ffa/tdm clamp the requested capacity to the mode max.
    const maxCap = modeCapacity(opts.mode);
    const capacity =
      opts.mode === 'duel' ? 2 : clampInt(opts.capacity, 2, maxCap, maxCap);
    const room: Room = {
      id: genRoomCode(),
      name: opts.name,
      mode: opts.mode,
      isRanked: opts.isRanked === true,
      // Enforce the mode's map pool server-side: a duel can't be created on a
      // huge FFA map and FFA can't be created on a tight 1v1 arena, regardless
      // of what the client requested.
      mapId:
        isKnownArena(opts.mapId) && mapPoolForMode(opts.mode).includes(opts.mapId)
          ? opts.mapId
          : mapPoolForMode(opts.mode)[0] ?? DEFAULT_ARENA_ID,
      isPublic: opts.isPublic,
      capacity,
      hostId: opts.hostId,
      members: new Set(),
      spectators: new Set(),
      state: 'active',
      vote: null,
      resumeAt: Date.now() + WARMUP_MS, // initial get-ready before the first frag
      firstBloodAwarded: false,
      emptySince: Date.now(),
      wasEverOccupied: false,
      createdAt: Date.now(),
      recentSpawns: [],
      matchLeft: [],
    };
    rooms.set(room.id, room);
    return room;
  };

  // Give a guest a per-room display name "Guest N". N is the smallest positive
  // integer not already taken by another guest in the room (held/disconnected
  // members still count, so a reconnecting peer can't collide), so a lobby reads
  // Guest 1 / Guest 2 / Guest 3 …. Logged-in players keep their account username.
  const assignGuestName = (room: Room, record: ClientRecord) => {
    const used = new Set<number>();
    for (const memberId of room.members) {
      if (memberId === record.id) continue;
      const c = clients.get(memberId);
      if (!c || c.playerId) continue; // only other guests claim a number
      const m = /^Guest (\d+)$/.exec(c.name);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n += 1;
    record.name = `Guest ${n}`;
  };

  // ── Teams (TDM) ───────────────────────────────────────────────────────
  // Assign the joining player to the smaller team (ties → team 0) so sides
  // stay balanced. Returns null outside TDM.
  const assignTeam = (room: Room): number | null => {
    if (room.mode !== 'tdm') return null;
    const counts = new Array<number>(TEAM_COUNT).fill(0);
    for (const id of room.members) {
      const c = clients.get(id);
      if (c && c.team != null) counts[c.team] += 1;
    }
    let team = 0;
    for (let i = 1; i < TEAM_COUNT; i++) if (counts[i] < counts[team]) team = i;
    return team;
  };

  const teamFrags = (room: Room, team: number): number => {
    let total = 0;
    for (const id of room.members) {
      const c = clients.get(id);
      if (c && c.team === team) total += c.frags;
    }
    return total;
  };

  // Anti-aimbot heuristic: feed each resolved shot (hit/miss + headshot) into a
  // rolling, decayed window and flag a shooter whose accuracy is statistically
  // impossible for a human in one-shot instagib. Thresholds are deliberately
  // extreme (no real player sustains >95% hit-rate or >90% headshots) so legit
  // aces are never flagged; a flagged shooter has frags throttled (see below).
  const recordAim = (s: ClientRecord, hit: boolean, headshot: boolean) => {
    s.aimShots += 1;
    if (hit) s.aimHits += 1;
    if (hit && headshot) s.aimHeadshots += 1;
    if (s.aimShots >= 40) {
      const hr = s.aimHits / s.aimShots;
      const hsr = s.aimHits >= 12 ? s.aimHeadshots / s.aimHits : 0;
      const outlier = hr > 0.95 || hsr > 0.9;
      if (outlier && !s.aimFlagged) {
        console.warn(
          `[instagib] aim outlier ${s.id} (${s.name}): hitRate=${hr.toFixed(2)} hsRate=${hsr.toFixed(2)} — throttling frags`,
        );
      }
      s.aimFlagged = outlier;
      // Halve the window so it stays recent-weighted (and a reformed player un-flags).
      s.aimShots = Math.floor(s.aimShots / 2);
      s.aimHits = Math.floor(s.aimHits / 2);
      s.aimHeadshots = Math.floor(s.aimHeadshots / 2);
    }
  };

  // The frag target the HUD shows: ranked / casual duel are both first-to-N 1v1
  // races; tdm is the team total; ffa is the per-match limit.
  const fragLimitFor = (room: Room): number =>
    room.isRanked
      ? RANKED_DUEL_FRAG_LIMIT
      : room.mode === 'duel'
        ? DUEL_FRAG_LIMIT
        : room.mode === 'tdm'
          ? TDM_FRAG_LIMIT
          : MATCH_FRAG_LIMIT;

  // ── Server-authoritative progression ─────────────────────────────────────
  // Every online match is recorded HERE from server-known counters (frags,
  // deaths, accepted shots, frag hits, headshots, streaks) — the client reports
  // nothing. Accounts are persisted; guests get the same computation as a
  // preview (saved: false). Each player is sent `{ type: 'progression', … }`.
  const resetMatchStats = (c: ClientRecord, now: number) => {
    c.mShots = 0;
    c.mHits = 0;
    c.mKills = 0;
    c.mKillWeight = 0;
    c.mVictims.clear();
    c.mHeadshots = 0;
    c.mStreak = 0;
    c.mBestStreak = 0;
    c.mStartedAt = now;
    c.mSettled = false;
    // A push held for a resume belongs to the match that just ended — never
    // deliver it into the next one.
    c.undeliveredProgression = null;
  };

  // Did this player take part enough for a match to count (total_games, the
  // "games" challenge, any XP)? ≥ MIN_RECORD_PRESENCE_MS present, or at least
  // one frag/death. Applies to every settle path (end, forfeit, leave).
  const recordable = (c: ClientRecord, now: number): boolean =>
    now - c.mStartedAt >= MIN_RECORD_PRESENCE_MS || c.frags > 0 || c.deaths > 0;

  // Record one player's match (full at match end, or `partial` when they leave
  // an active match) and push the reward payload. Idempotent per match.
  // Returns true if a match was recorded.
  const settleClient = (c: ClientRecord, room: Room, won: boolean, partial: boolean, now: number): boolean => {
    if (c.mSettled) return false;
    c.mSettled = true;
    if (!recordable(c, now)) return false; // a bounce, not a match
    const mode = room.isRanked ? 'ranked' : room.mode;
    const accuracy = c.mShots > 0 ? (c.mHits / c.mShots) * 100 : 0;
    let reply: ReturnType<typeof recordMatch>;
    try {
      reply = recordMatch({
        playerId: c.playerId,
        userName: c.name,
        // Progression counts only frags on OTHER accounts (not guests, not a
        // second tab of your own) — see handleShoot.
        kills: c.mKills,
        deaths: c.deaths,
        wins: won ? 1 : 0,
        bestStreak: c.mBestStreak,
        headshots: c.mHeadshots,
        shotsFired: c.mShots,
        shotsHit: c.mHits,
        accuracy,
        offline: false,
        now,
        // Base XP is always pro rata by time present (full at PRESENCE_FULL_MS).
        presence: Math.max(0, Math.min(1, (now - c.mStartedAt) / PRESENCE_FULL_MS)),
        killWeight: c.mKills > 0 ? c.mKillWeight / c.mKills : 1,
      });
    } catch (err) {
      console.error('[instagib] recordMatch failed', err);
      return false;
    }
    logEvent({
      event: 'match',
      actorId: c.playerId,
      actorName: c.name,
      detail: {
        kills: c.mKills,
        deaths: c.deaths,
        won,
        headshots: c.mHeadshots,
        accuracy: Math.round(accuracy),
        offline: false,
        xp: reply.xpGained,
        mode,
        src: 'ws',
        partial,
      },
      now,
    });
    // Strange items: each counted frag ticks the equipped Strange finish / beam /
    // finisher instances (batched here, not per kill — keeps the WS loop cheap).
    if (c.mKills > 0 && c.strangeUids.length > 0 && c.playerId) {
      try {
        addStrangeKills(c.playerId, c.strangeUids, c.mKills);
      } catch (err) {
        console.error('[instagib] addStrangeKills failed', err);
      }
    }
    // Keep the killcam card's level in step with the account's real level.
    if (reply.saved && c.card) c.card.level = reply.progression.level;
    const msg = { type: 'progression' as const, mode, partial, ...reply };
    if (c.socket.readyState === c.socket.OPEN) {
      c.socket.send(JSON.stringify(msg));
      c.undeliveredProgression = null;
    } else {
      c.undeliveredProgression = msg; // dropped mid-grace: deliver on resume
    }
    return true;
  };

  // Match over: record every member. `winnerId` (FFA/duel/ranked) or
  // `winnerTeam` (TDM) decides `won`; `forfeit` = the opponent left.
  const settleRoom = (
    room: Room,
    winnerId: ClientId | null,
    winnerTeam: number | null,
    forfeit: boolean,
  ) => {
    const now = Date.now();
    const minForfeitFrags = Math.ceil(fragLimitFor(room) * FORFEIT_WIN_MIN_FRAC);
    // Everyone who took part: recordable members + those who left with a
    // recorded partial. A win (and with it the first-win bonus) only counts if
    // at least one of them is a genuine opponent — a different identity (not
    // your account, not your network) — so you can't win against yourself.
    const participants: { id: ClientId; playerId: string; netId: string }[] = [...room.matchLeft];
    for (const id of room.members) {
      const c = clients.get(id);
      if (c && recordable(c, now)) participants.push({ id: c.id, playerId: c.playerId, netId: c.netId });
    }
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      const contested = participants.some((p) => p.id !== c.id && !sameIdentity(p, c));
      let won =
        contested &&
        (winnerTeam != null
          ? c.team === winnerTeam && now - c.mStartedAt >= TDM_WIN_MIN_PRESENCE_MS
          : c.id === winnerId);
      if (won && forfeit && c.frags < minForfeitFrags) won = false; // no contest
      settleClient(c, room, won, false, now);
    }
  };

  // An account already holding a slot in `room` on another connection.
  const sameAccountMember = (room: Room, record: ClientRecord): ClientRecord | null => {
    if (!record.playerId) return null;
    for (const id of room.members) {
      const c = clients.get(id);
      if (c && c !== record && c.playerId === record.playerId) return c;
    }
    return null;
  };

  // Pick a spawn for `forClient`. Two independent concerns:
  //  • SAFETY (soft, tunable): distance to nearest live threat, docked for sitting
  //    in a threat's aim cone or reusing a just-used (campable) spot. Drives
  //    "spawn away from danger" and keeps variety (random among the near-safest).
  //  • SEPARATION (hard): never land within SPAWN_SEPARATION of ANY other player's
  //    committed position — even a killcam-hidden one (excluded from threats since
  //    it can't shoot, but it's about to reappear at that exact spot). This is what
  //    stops players materializing on top of each other; kept as a near-hard
  //    exclusion so the safety/variety scoring can't override it.
  // `avoid` is an extra point to stay away from (the killer's pos on a frag).
  const pickSpawn = (room: Room, forClient: ClientRecord | null, avoid: Vec | null): Vec => {
    const spawns = arenaNet(room.mapId).spawns;
    if (spawns.length === 0) return { x: 0, y: 0.05, z: 0 };
    const now = Date.now();
    type Threat = { x: number; z: number; fx: number; fz: number; aimed: boolean };
    const threats: Threat[] = []; // live enemies (danger/aim-cone) — excludes hidden + teammates
    const occupants: { x: number; z: number }[] = []; // ANY present player (overlap avoidance)
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      if (forClient && c.id === forClient.id) continue;
      if (c.disconnectedAt > 0) continue; // gone (awaiting resume) → not present, gets its own pick
      // Present body → never spawn on top of it, regardless of whether it's a threat.
      occupants.push({ x: c.pos.x, z: c.pos.z });
      if (c.respawnAt > now) continue; // dead/hidden → occupies space but isn't a threat
      if (room.mode === 'tdm' && forClient && c.team != null && c.team === forClient.team) continue;
      // Forward dir from yaw matches the client: forward = (-sin yaw, -cos yaw).
      threats.push({ x: c.pos.x, z: c.pos.z, fx: -Math.sin(c.yaw), fz: -Math.cos(c.yaw), aimed: true });
    }
    if (avoid) threats.push({ x: avoid.x, z: avoid.z, fx: 0, fz: 0, aimed: false });
    // Forget stale spawn history so it only steers us off CURRENTLY-hot spots.
    room.recentSpawns = room.recentSpawns.filter((r) => now - r.t < SPAWN_RECENT_MS);
    const scored = spawns.map((s) => {
      let nearest = Infinity;
      let viewPenalty = 0;
      for (const t of threats) {
        const dx = s.x - t.x;
        const dz = s.z - t.z;
        const dist = Math.hypot(dx, dz);
        if (dist < nearest) nearest = dist;
        // In a threat's crosshair line? (only meaningful for aimed threats, in range)
        if (t.aimed && dist > 0.01 && dist < SPAWN_VIEW_RANGE) {
          const dot = (t.fx * dx + t.fz * dz) / dist; // 1 = dead ahead of them
          if (dot > SPAWN_VIEW_DOT) {
            const centre = (dot - SPAWN_VIEW_DOT) / (1 - SPAWN_VIEW_DOT); // 0..1 centredness
            const close = 1 - 0.5 * (dist / SPAWN_VIEW_RANGE); // 1.0 → 0.5 (hitscan: range barely matters)
            viewPenalty = Math.max(viewPenalty, SPAWN_VIEW_PENALTY * centre * close);
          }
        }
      }
      let recentPenalty = 0;
      for (const r of room.recentSpawns) {
        if (Math.hypot(s.x - r.x, s.z - r.z) < SPAWN_RECENT_RADIUS) {
          recentPenalty = Math.max(recentPenalty, SPAWN_RECENT_PENALTY * (1 - (now - r.t) / SPAWN_RECENT_MS));
        }
      }
      // Hard overlap guard: is another present body too close to this spot?
      let occupied = false;
      for (const o of occupants) {
        if (Math.hypot(s.x - o.x, s.z - o.z) < SPAWN_SEPARATION) { occupied = true; break; }
      }
      const base = Number.isFinite(nearest) ? nearest : SPAWN_VIEW_RANGE * 2; // no threats → all equal
      return { s, safety: base - viewPenalty - recentPenalty, occupied };
    });
    // Prefer spawns that aren't already occupied; only fall back to occupied ones
    // if EVERY spawn is crowded (tiny map / more players than spread allows).
    const free = scored.filter((c) => !c.occupied);
    const pool = free.length > 0 ? free : scored;
    pool.sort((a, b) => b.safety - a.safety);
    // Keep variety among the near-safest so spawns aren't a predictable pattern
    // (a fixed rotation is itself campable) — random within a band of the best.
    const best = pool[0].safety;
    const band = Math.max(4, Math.abs(best) * 0.15);
    const eligible = pool.filter((c) => c.safety >= best - band);
    const chosen = eligible[Math.floor(Math.random() * eligible.length)].s;
    room.recentSpawns.push({ x: chosen.x, z: chosen.z, t: now });
    // Small jitter so simultaneous respawns don't perfectly overlap.
    return { x: chosen.x + (Math.random() - 0.5), y: chosen.y, z: chosen.z + (Math.random() - 0.5) };
  };

  const joinRoom = (record: ClientRecord, room: Room) => {
    leaveRoom(record); // ensure single-room invariant
    listers.delete(record.id);
    record.roomId = room.id;
    record.team = assignTeam(room); // null outside TDM
    room.members.add(record.id);
    // Guests get a per-room "Guest N" label; logged-in players keep their
    // account username (set on connect). Assigned before the joined/peer-joined
    // broadcasts below so everyone sees the final name immediately.
    if (!record.playerId) assignGuestName(room, record);
    room.emptySince = 0;
    room.wasEverOccupied = true;
    if (!room.hostId) room.hostId = record.id;
    // A match begins the moment a room fills from 1→2: give BOTH players a
    // get-ready warmup (the existing resumeAt shot-freeze) so neither can be
    // fragged on the join frame. Guard on a FRESH match (nobody has scored yet)
    // so a leave→rejoin (2→1→2) can't re-freeze a live game; later joiners drop
    // into the live match (covered by spawn invuln) without freezing it.
    const anyScore = [...room.members].some((id) => {
      const c = clients.get(id);
      return c != null && (c.frags > 0 || c.deaths > 0);
    });
    if (room.state === 'active' && room.members.size === 2 && !anyScore) {
      room.resumeAt = Date.now() + WARMUP_MS;
    }
    // Spawn into the room's current map.
    const spawn = pickSpawn(room, record, null);
    record.pos = { ...spawn };
    record.yaw = 0;
    record.pitch = 0;
    record.frags = 0;
    record.deaths = 0;
    resetMatchStats(record, Date.now());
    record.invulnUntilMs = Date.now() + SPAWN_INVULN_MS;
    record.history.length = 0;
    resetPosTimeline(record);
    sendRaw(record.socket, {
      type: 'joined',
      roomId: room.id,
      mode: room.mode,
      ranked: room.isRanked,
      team: record.team,
      mapId: room.mapId,
      spawn,
      state: room.state,
      fragLimit: fragLimitFor(room),
      resumeAt: room.resumeAt, // warmup/breather end (server clock)
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
    // Ship the full room profile so the joiner sees everyone's name/cosmetics/
    // team immediately and peers get the joiner's. The joiner's own cosmetics
    // arrive moments later (after the welcome handshake) and re-broadcast via
    // bumpMeta — see the cosmetic setters.
    broadcastMeta(room);
  };

  // Reclaim a dropped player's slot: migrate the OLD record's match state onto
  // the new connection `record`, swap the room bookkeeping over, and resume the
  // client right where it was (score intact). Returns false if not resumable.
  const resumeMatch = (record: ClientRecord, old: ClientRecord): boolean => {
    const room = old.roomId ? rooms.get(old.roomId) : null;
    if (!room || !room.members.has(old.id)) return false;
    leaveRoom(record); // the fresh conn isn't in a room, but keep the invariant
    listers.delete(record.id);
    record.roomId = room.id;
    record.team = old.team;
    record.name = old.name; // keep the held slot's name (account username / "Guest N")
    record.pos = { ...old.pos };
    record.yaw = old.yaw;
    record.pitch = old.pitch;
    record.frags = old.frags;
    record.deaths = old.deaths;
    record.mShots = old.mShots;
    record.mHits = old.mHits;
    record.mKills = old.mKills;
    record.mKillWeight = old.mKillWeight;
    record.mVictims = old.mVictims;
    record.mHeadshots = old.mHeadshots;
    record.mStreak = old.mStreak;
    record.mBestStreak = old.mBestStreak;
    record.mStartedAt = old.mStartedAt;
    record.mSettled = old.mSettled;
    record.hat = old.hat;
    record.unusual = old.unusual;
    record.emote = old.emote;
    record.nameColor = old.nameColor;
    record.spawnEffect = old.spawnEffect;
    record.killEffect = old.killEffect;
    record.title = old.title;
    record.railColor = old.railColor;
    record.railgunFinish = old.railgunFinish;
    record.crosshair = old.crosshair;
    record.looks = old.looks;
    record.strangeUids = old.strangeUids;
    record.lastTauntMs = old.lastTauntMs;
    record.card = old.card;
    record.invulnUntilMs = Date.now() + SPAWN_INVULN_MS; // brief grace on return
    record.history.length = 0;
    resetPosTimeline(record);
    // Hand the old slot's room bookkeeping to the new id.
    room.members.delete(old.id);
    room.members.add(record.id);
    if (room.hostId === old.id) room.hostId = record.id;
    if (room.vote?.votes.has(old.id)) {
      room.vote.votes.set(record.id, room.vote.votes.get(old.id)!);
      room.vote.votes.delete(old.id);
    }
    clients.delete(old.id);
    sendRaw(record.socket, {
      type: 'joined',
      roomId: room.id,
      mode: room.mode,
      ranked: room.isRanked,
      team: record.team,
      mapId: room.mapId,
      spawn: record.pos,
      state: room.state,
      fragLimit: fragLimitFor(room),
      resumeAt: room.resumeAt,
    });
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
    broadcastMeta(room); // reclaimed slot: refresh the room profile for everyone
    // The match ended while they were dropped: deliver the rewards they missed.
    if (old.undeliveredProgression) sendRaw(record.socket, old.undeliveredProgression);
    return true;
  };

  // One account, one slot per room. If this account already holds a slot in
  // `room`: a dropped one (a reconnect that lost its resume token — same
  // account, so the same player) is reclaimed via resumeMatch; a live one (a
  // second tab) is refused with join-failed 'duplicate'. Returns true when it
  // handled the join (the caller stops).
  const handleSameAccount = (record: ClientRecord, room: Room): boolean => {
    const dup = sameAccountMember(room, record);
    if (!dup) return false;
    if (dup.disconnectedAt > 0 && resumeMatch(record, dup)) return true;
    sendRaw(record.socket, { type: 'join-failed', reason: 'duplicate' });
    return true;
  };

  const leaveRoom = (record: ClientRecord) => {
    if (!record.roomId) return;
    const room = rooms.get(record.roomId);
    // Leaving a live match (leave button, AFK/stale kick, resume grace expiry,
    // joining elsewhere) records what they played so far as a loss.
    if (room && room.state === 'active' && room.members.has(record.id)) {
      if (settleClient(record, room, false, true, Date.now())) {
        room.matchLeft.push({ id: record.id, playerId: record.playerId, netId: record.netId });
      }
    }
    record.roomId = null;
    record.team = null;
    if (!room) return;
    room.members.delete(record.id);
    broadcastRoom(room, { type: 'peer-left', clientId: record.id });
    broadcastMeta(room); // refresh the roster profile sans the departed player
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
      // No players left to watch → release any spectators back to the menu (the
      // room is now empty and will be reaped shortly).
      endSpectators(room);
    } else if (room.hostId === record.id) {
      room.hostId = room.members.values().next().value ?? null;
    }
    // Duel: a player bailing mid-match forfeits — the lone survivor wins and the
    // map vote opens (size === 1 means the room had 2 and one just left).
    if (room.mode === 'duel' && !room.isRanked && room.state === 'active' && room.members.size === 1) {
      const remaining = room.members.values().next().value;
      if (remaining) startVote(room, remaining, null, true);
    }
    // Ranked: bailing mid-match is a forfeit — the survivor wins (the leaver takes
    // the loss + Elo hit). `record` is the departing loser (already removed above).
    if (room.isRanked && room.state === 'active' && room.members.size === 1) {
      const remainingId = room.members.values().next().value;
      const remaining = remainingId ? clients.get(remainingId) : undefined;
      if (remaining) endRankedMatch(room, remaining, record);
    }
    broadcastRoomList();
    schedulePresence(); // this player's inMatch flag just cleared
  };

  // Stop watching: remove this connection from its room's spectator set. Safe to
  // call when not spectating (no-op).
  const leaveSpectate = (record: ClientRecord) => {
    if (!record.spectating) return;
    const room = rooms.get(record.spectating);
    record.spectating = null;
    room?.spectators.delete(record.id);
    schedulePresence();
  };

  // Release every spectator of a room back to the menu (the match ended / the
  // room is being reaped). Tells each client so its SpectatorView returns to the
  // lobby instead of freezing on a stale final frame.
  const endSpectators = (room: Room) => {
    for (const id of room.spectators) {
      const c = clients.get(id);
      if (c) c.spectating = null;
      if (c && c.socket.readyState === c.socket.OPEN) {
        c.socket.send(JSON.stringify({ type: 'spectate-ended' }));
      }
    }
    room.spectators.clear();
  };

  // Socket dropped: if mid-match, HOLD the slot + score for a reconnect (the
  // client presents its resume token within RESUME_GRACE_MS). Otherwise — lobby,
  // post-match vote, or already-disconnected — reap immediately.
  const handleDisconnect = (rec: ClientRecord) => {
    if (rec.disconnectedAt > 0) return; // already handled (error then close)
    rankedQueue.delete(rec.id); // a queued socket dropping leaves the queue
    const room = rec.roomId ? rooms.get(rec.roomId) : null;
    if (room && room.state === 'active' && room.members.has(rec.id)) {
      rec.disconnectedAt = Date.now();
      schedulePresence(); // held for resume, but hidden from the live list meanwhile
      return;
    }
    leaveRoom(rec);
    leaveSpectate(rec);
    listers.delete(rec.id);
    clients.delete(rec.id);
    schedulePresence();
  };

  // ── Lobby listing ─────────────────────────────────────────────────────
  const publicRoomList = () =>
    [...rooms.values()]
      .filter((r) => r.isPublic && r.members.size > 0)
      .sort((a, b) => b.members.size - a.members.size || a.createdAt - b.createdAt)
      .map((r) => ({
        id: r.id,
        name: r.name,
        mode: r.mode,
        mapId: r.mapId,
        players: r.members.size,
        capacity: r.capacity,
        spectators: r.spectators.size,
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
  // The high-rate snapshot: ONLY the fields that change per tick. Everything
  // static (name, team, cosmetics, badges) rides the `meta` channel below, sent
  // on change, so it isn't re-serialized + re-parsed 40×/sec for no reason.
  // `now` defaults to the wall clock; the snapshot tick passes ITS `now` so the
  // frame's timestamp is exactly the one the lag-comp history was stamped with.
  const roomSnapshot = (room: Room, now = Date.now()) => {
    const players: object[] = [];
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      if (c.disconnectedAt > 0) continue; // dropped (awaiting resume) → hidden, untargetable
      if (c.respawnAt > now) continue; // dead, watching killcam → hidden (anti-spawn-camp)
      players.push({
        id: c.id,
        // Resampled, anti-aliased pose (set on the snapshot tick before this runs);
        // matches what the lag-comp history recorded so render == rewind.
        x: c.renderPos.x,
        y: c.renderPos.y,
        z: c.renderPos.z,
        yaw: c.renderPos.yaw,
        pitch: c.pitch,
        frags: c.frags,
        deaths: c.deaths,
        invulnMs: Math.max(0, c.invulnUntilMs - now),
        ping: Math.round(c.rttMs),
      });
    }
    return { type: 'state' as const, t: now, players, resumeAt: room.resumeAt };
  };

  // The slow-changing per-player profile, factored out of the snapshot. Sent as
  // a full room roster whenever something here changes (join, leave, resume, a
  // cosmetic equip) — not per tick. Safe because the WebSocket is TCP (reliable
  // + ordered): a send-on-change update can never be lost on a live connection,
  // and Node's single-threaded loop guarantees this is flushed before any
  // snapshot that could reference a newly-joined player (members.add and
  // broadcastMeta run without an await between them). The client merges these
  // onto the dynamic snapshot, defaulting gracefully if a profile hasn't arrived.
  const playerMeta = (c: ClientRecord) => ({
    id: c.id,
    name: c.name,
    team: c.team,
    hat: c.hat,
    unusual: c.unusual,
    emote: c.emote,
    nameColor: c.nameColor,
    spawnEffect: c.spawnEffect,
    title: c.title,
    // Live-resolved flair text (dynamic ranked title → "#N"/tier). The client
    // prefers this over the static manifest text for the id.
    titleText: resolveTitleText(c.playerId, c.title),
    railColor: c.railColor,
    railgunFinish: c.railgunFinish,
    looks: c.looks,
    crosshair: c.crosshair,
    admin: c.admin,
    verified: c.verified,
  });

  const roomMeta = (room: Room) => {
    const players: object[] = [];
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c || c.disconnectedAt > 0) continue;
      players.push(playerMeta(c));
    }
    return { type: 'meta' as const, players };
  };

  const broadcastMeta = (room: Room) => broadcastRoom(room, roomMeta(room));

  // Re-broadcast a player's room profile after a meta field changed (cosmetic
  // equip). No-op while they're browsing the lobby (not in a room yet).
  const bumpMeta = (c: ClientRecord) => {
    if (!c.roomId) return;
    const room = rooms.get(c.roomId);
    if (room) broadcastMeta(room);
  };

  // Record a tick-stamped sender's arrival lateness; a few times a second,
  // refresh their percentile target (one shared scratch buffer — no allocation).
  const lateScratch = new Float64Array(POS_LATE_WINDOW);
  const noteLateness = (tl: PosTimeline, arrival: number, late: number): void => {
    tl.late[tl.lateIdx] = late;
    tl.lateIdx = (tl.lateIdx + 1) % POS_LATE_WINDOW;
    if (tl.lateCount < POS_LATE_WINDOW) tl.lateCount += 1;
    tl.lastLate = late;
    if (tl.lateCount === 1) tl.lateTarget = late;
    if (arrival < tl.lateRecomputeAt) return;
    tl.lateRecomputeAt = arrival + POS_LATE_RECOMPUTE_MS;
    const n = tl.lateCount;
    const view = lateScratch.subarray(0, n);
    view.set(tl.late.subarray(0, n));
    view.sort();
    tl.lateTarget = view[Math.min(n - 1, Math.floor(n * POS_LATE_PERCENTILE))];
  };
  // Advance a sender's applied playout offset toward its target by one snapshot
  // tick (`dtMs`), at the bounded rates above; returns the sim time to render.
  const playoutSimTime = (tl: PosTimeline, now: number, dtMs: number): number => {
    // A lone long stall shouldn't delay this sender for everyone: cap how far
    // the playout may sit behind their current lateness (it then holds briefly).
    const late = Math.min(tl.lateTarget, tl.lastLate + POS_PLAYOUT_EXTRA_MAX_MS);
    const target = late + TICK_MS * POS_PLAYOUT_TICKS + POS_PLAYOUT_MARGIN_MS;
    if (tl.playoutMs === 0 || Math.abs(target - tl.playoutMs) > POS_PLAYOUT_SNAP_MS) {
      tl.playoutMs = target;
    } else if (target > tl.playoutMs) {
      tl.playoutMs = Math.min(target, tl.playoutMs + (POS_PLAYOUT_RISE_MS_PER_S * dtMs) / 1000);
    } else {
      tl.playoutMs = Math.max(target, tl.playoutMs - (POS_PLAYOUT_FALL_MS_PER_S * dtMs) / 1000);
    }
    return now - tl.playoutMs;
  };
  // Forget a sender's upload timeline (new room / resumed slot): their next
  // upload re-seeds it.
  const resetPosTimeline = (c: ClientRecord): void => {
    c.posSamples.length = 0;
    c.posTl = newPosTimeline();
  };

  // Resample a received-pos buffer at server-clock time `t` — pure interpolation
  // between the two straddling samples (clamped to the ends). Across a
  // teleport-sized gap (respawn) it returns the newer sample instead of sliding.
  const sampleAt = (samples: PosSample[], t: number): PosSample | null => {
    const n = samples.length;
    if (n === 0) return null;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[n - 1].t) return samples[n - 1];
    for (let i = n - 1; i > 0; i--) {
      const a = samples[i - 1];
      const b = samples[i];
      if (t >= a.t && t <= b.t) {
        if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > POS_RESAMPLE_TELEPORT) return b;
        const span = b.t - a.t || 1;
        const f = (t - a.t) / span;
        const dyaw = wrapAngle(b.yaw - a.yaw);
        return {
          t,
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          yaw: a.yaw + dyaw * f,
        };
      }
    }
    return samples[n - 1];
  };

  // sampleAt for a tick-stamped timeline: past the newest sample (a late burst
  // from a sender hitch) it extrapolates from the last two samples for at most
  // POS_EXTRAP_MAX_MS instead of freezing, then holds. A stop is always two
  // equal samples (clients send one unchanged tick before going quiet), so this
  // never coasts past where the player actually stopped.
  const sampleAtTick = (samples: PosSample[], t: number, out: PosSample): PosSample | null => {
    const n = samples.length;
    if (n === 0) return null;
    const b = samples[n - 1];
    if (t <= b.t || n < 2) return sampleAt(samples, t);
    const a = samples[n - 2];
    const span = b.t - a.t;
    if (span <= 0 || span > TICK_MS * 4 || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > POS_RESAMPLE_TELEPORT) {
      return b;
    }
    const k = Math.min(t - b.t, POS_EXTRAP_MAX_MS) / span;
    out.t = t;
    out.x = b.x + (b.x - a.x) * k;
    out.y = b.y + (b.y - a.y) * k;
    out.z = b.z + (b.z - a.z) * k;
    out.yaw = b.yaw; // angle overshoot reads worse than a still head
    return out;
  };
  const extrapScratch: PosSample = { t: 0, x: 0, y: 0, z: 0, yaw: 0 };

  // Interpolate a player's position at a past server-clock time `t`. History now
  // holds RESAMPLED positions (what viewers actually render), so the clamps must
  // return the newest/oldest HISTORY entry — NOT the raw c.pos, which a viewer
  // never sees. Returning raw c.pos for `t >= newest` was a latent ghost-miss:
  // the client renders the resampled (delayed) pos but the server would rewind to
  // the raw (ahead) pos. Raw c.pos is only the fallback when there's no history.
  const rewind = (c: ClientRecord, t: number): Vec => {
    const h = c.history;
    if (h.length === 0) return { ...c.pos };
    const last = h[h.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y, z: last.z };
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
    return { x: last.x, y: last.y, z: last.z };
  };

  // ── Map voting ────────────────────────────────────────────────────────
  // `winnerId` is the client who reached the frag limit — the match winner. It
  // rides the vote-start so each client can latch its own win/loss for stats
  // (the match "ends" the moment the vote opens).
  const startVote = (
    room: Room,
    winnerId: ClientId | null = null,
    winnerTeam: number | null = null,
    forfeit = false,
  ) => {
    room.state = 'voting';
    // Ballot from THIS mode's pool (duel = small arenas, FFA/TDM = large), with
    // the current map dropped for variety. If that leaves fewer than two choices
    // (the 2-map duel pool), fall back to the full pool so there's still a real
    // vote (re-running the current map is then a valid option).
    const pool = mapPoolForMode(room.mode);
    let candidates = pool.filter((m) => m !== room.mapId);
    if (candidates.length < 2 && pool.length >= 2) candidates = [...pool];
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    const options: string[] = shuffled.slice(0, Math.min(MAP_VOTE_OPTIONS, shuffled.length));
    if (options.length === 0) options.push(room.mapId);
    // Hold the vote open past the Play-of-the-Match cinematic (which is now
    // non-skippable) so its timer never lapses mid-replay; players get the full
    // MAP_VOTE_DURATION after PotG. The client hides the vote UI behind the
    // replay and clamps the displayed countdown to MAP_VOTE_DURATION.
    const endsAt = Date.now() + (POTG_GUARD_SEC + MAP_VOTE_DURATION_SEC) * 1000;
    room.vote = {
      options,
      votes: new Map(),
      endsAt,
      winnerId,
      winnerTeam,
    };
    broadcastRoom(room, {
      type: 'vote-start',
      options,
      endsAt,
      durationMs: MAP_VOTE_DURATION_SEC * 1000,
      winnerId,
      winnerTeam,
    });
    // The match is over the moment the vote opens: record everyone's match and
    // push their rewards (after vote-start, so "match over" lands first).
    settleRoom(room, winnerId, winnerTeam, forfeit);
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
    room.firstBloodAwarded = false;
    room.matchLeft.length = 0;

    // Reset scoreboard + reposition everyone onto the new map.
    const now = Date.now();
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      c.frags = 0;
      c.deaths = 0;
      resetMatchStats(c, now);
      c.history.length = 0;
      c.pos = { ...pickSpawn(room, c, null) };
      c.invulnUntilMs = now + SPAWN_INVULN_MS + POST_MATCH_RESET_SEC * 1000;
      c.respawnAt = 0; // fresh match — everyone visible
    }
    // Per-client so each gets their OWN server-assigned spawn — otherwise every
    // client would self-pick the same default spot and stack on one spawn.
    for (const id of room.members) {
      const c = clients.get(id);
      if (!c) continue;
      sendRaw(c.socket, {
        type: 'vote-result',
        mapId: winner,
        resumeAt: room.resumeAt,
        spawn: { ...c.pos },
      });
    }
    // Spectators follow the rotation too (no spawn — they don't play). Without
    // this they'd keep rendering the old arena while players move on the new one.
    for (const id of room.spectators) {
      const c = clients.get(id);
      if (c) sendRaw(c.socket, { type: 'vote-result', mapId: winner, resumeAt: room.resumeAt });
    }
    broadcastRoomList();
  };

  // Ranked match over (frag limit reached, or a forfeit). Applies the
  // server-authoritative Elo update, broadcasts the result (rating deltas) to
  // both players + spectators, and freezes the room so no more shots land — the
  // clients show the result then return to the lobby and the room reaps empty.
  // `loserOverride` is the departed player on a forfeit (already out of members).
  const endRankedMatch = (room: Room, winner: ClientRecord, loserOverride?: ClientRecord) => {
    if (room.state !== 'active') return; // guard against double-resolve
    const loserId = loserOverride ? null : [...room.members].find((id) => id !== winner.id);
    const loser = loserOverride ?? (loserId ? clients.get(loserId) : undefined);
    // Only move Elo between two DISTINCT accounts (a self-match moves nothing).
    const legit = !!loser && !!winner.playerId && !!loser.playerId && winner.playerId !== loser.playerId;
    // Diminishing returns vs the SAME opponent: count this pair's matches inside
    // the rolling window, weight the rating change by 2^-priorMatches, then record
    // this match. Repeat-farming a single opponent earns ~nothing; a normal game
    // (incl. an occasional rematch) still moves full Elo. Office-friendly: never
    // blocks the match, only scales what a repeated win is worth.
    const now = Date.now();
    let weight = 1;
    if (legit && loser) {
      const key = pairKey(winner.playerId, loser.playerId);
      const times = (recentRankedPairs.get(key) ?? []).filter((t) => now - t < RANKED_REPEAT_WINDOW_MS);
      weight = repeatWeight(times.length);
      times.push(now);
      recentRankedPairs.set(key, times);
    }
    const rating =
      legit && loser
        ? recordRankedResult(winner.playerId, winner.name, loser.playerId, loser.name, now, weight)
        : null;
    room.state = 'voting'; // reuse the shot-freeze guard; no actual map vote for ranked
    room.vote = null;
    const payload = {
      type: 'ranked-result' as const,
      winnerId: winner.id,
      winnerName: winner.name,
      loserId: loser?.id ?? null,
      loserName: loser?.name ?? null,
      forfeit: !!loserOverride,
      winnerFrags: winner.frags,
      loserFrags: loser?.frags ?? 0,
      fragLimit: RANKED_DUEL_FRAG_LIMIT,
      reduced: weight < 1, // rating change was damped (repeat opponent) — UI hint
      rating, // { winner: { rating, delta, rank }, loser: {...} } | null (guests/missing)
    };
    broadcastRoom(room, payload);
    // Record the match for everyone still in it (a forfeiting loser was already
    // recorded as a partial loss by leaveRoom).
    settleRoom(room, winner.id, null, !!loserOverride);
    broadcastRoomList(); // room left the joinable/active set
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
    shooter.mShots += 1; // an accepted shot (progression accuracy)
    shooter.lastActiveMs = now; // firing counts as activity (AFK timer)
    // Firing ends your own spawn invuln — you can't shoot from behind protection.
    if (shooter.invulnUntilMs > now) shooter.invulnUntilMs = 0;

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
      // TDM: no friendly fire — teammates can't be hit.
      if (room.mode === 'tdm' && victim.team != null && victim.team === shooter.team) continue;
      if (victim.invulnUntilMs > now) continue;
      if (victim.respawnAt > now) continue; // hidden during their killcam → untargetable
      if (victim.disconnectedAt > 0) continue; // dropped player can't be fragged mid-grace
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

    // Broadcast the rail beam to the rest of the room (the shooter already drew
    // their own) so other players SEE + HEAR the shot, hit or miss. The beam ends
    // at the victim if hit, else at the wall (wallCap). Sent before the miss /
    // aim-throttle returns below so a missed or throttled shot still shows.
    const beamLen = bestId ? bestT : wallCap;
    broadcastRoom(
      room,
      {
        type: 'beam',
        id: shooter.id,
        ox: msg.ox,
        oy: msg.oy,
        oz: msg.oz,
        ex: msg.ox + dx * beamLen,
        ey: msg.oy + dy * beamLen,
        ez: msg.oz + dz * beamLen,
      },
      shooter.id,
    );

    if (!bestId || !bestPos) {
      recordAim(shooter, false, false); // a miss
      return;
    }
    const victim = clients.get(bestId);
    if (!victim) return;
    // Final range backstop against the REWOUND hit point (bestPos), not the
    // victim's live pos — otherwise a fast-moving victim could dodge/eat a hit
    // that was legitimately in range at the rewound render time.
    if (dist(shooter.pos, bestPos) > KILL_MAX_RANGE + 5) {
      recordAim(shooter, false, false);
      return;
    }
    recordAim(shooter, true, bestHeadshot);
    // Throttle a flagged aimbot: the shot landed but we drop the frag (the stat
    // window keeps decaying, so a legit player who dips back under the threshold
    // un-flags within a window or two).
    if (shooter.aimFlagged) return;

    shooter.frags += 1;
    victim.deaths += 1;
    // Progression counters (a throttled aimbot shot above never gets here).
    // A frag counts unless the victim is YOU — the same account, or anyone on
    // your network identity (your own guest tab, a second account on the same
    // machine). Guests from elsewhere count normally. A shot spent on a
    // non-counting victim leaves accuracy untouched (out of hits and shots).
    if (!sameIdentity(victim, shooter)) {
      shooter.mKills += 1;
      shooter.mHits += 1;
      const vKey = identityKey(victim); // decay per victim identity (account, else network)
      const n = (shooter.mVictims.get(vKey) ?? 0) + 1;
      shooter.mVictims.set(vKey, n);
      shooter.mKillWeight +=
        room.mode === 'duel' || n <= VICTIM_FULL_KILLS
          ? 1
          : 2 ** -Math.ceil((n - VICTIM_FULL_KILLS) / VICTIM_DECAY_EVERY);
      if (bestHeadshot) shooter.mHeadshots += 1;
      shooter.mStreak += 1;
      if (shooter.mStreak > shooter.mBestStreak) shooter.mBestStreak = shooter.mStreak;
    } else {
      shooter.mShots = Math.max(0, shooter.mShots - 1);
    }
    victim.mStreak = 0;
    const respawnPos = pickSpawn(room, victim, shooter.pos);
    const firstBlood = !room.firstBloodAwarded;
    room.firstBloodAwarded = true;
    broadcastRoom(room, {
      type: 'kill',
      killerId: shooter.id,
      killerName: shooter.name,
      victimId: victim.id,
      victimName: victim.name,
      headshot: bestHeadshot,
      firstBlood,
      victimPos: { ...victim.pos },
      respawnPos,
      finisher: shooter.killEffect, // the killer's finisher → how the victim dies, for everyone
      // The killer's playercard → victim's killcam. Re-resolve the title here so a
      // live ranked title (#N) on the card reflects the killer's CURRENT standing,
      // not whatever it was when they last equipped the card.
      killerCard: shooter.card
        ? { ...shooter.card, title: resolveTitleText(shooter.playerId, shooter.title) }
        : shooter.card,
      t: now,
    });
    victim.pos = { ...respawnPos };
    victim.history.length = 0;
    victim.posSamples.length = 0; // reappear cleanly at the spawn (no resample slide)
    // Hide the victim (snapshot + targeting) for their killcam, so nobody can see
    // or spawn-camp them while they're stuck watching it. They reappear at the
    // (already away-from-killer) spawn when it ends — see RESPAWN_HIDE_MS.
    victim.respawnAt = now + RESPAWN_HIDE_MS;
    // Invuln spans the killcam + a full spawn grace after they reappear (see
    // KILL_RESPAWN_INVULN_MS) so they're protected the whole time they can't act.
    victim.invulnUntilMs = now + KILL_RESPAWN_INVULN_MS;

    // Mode-aware resolution of the kill.
    if (room.isRanked) {
      // Ranked Duel: a flat first-to-N race. No rounds, no vote — reaching the
      // limit ends the match (Elo update + result + dissolve).
      if (shooter.frags >= RANKED_DUEL_FRAG_LIMIT) endRankedMatch(room, shooter);
    } else if (room.mode === 'tdm') {
      if (shooter.team != null) {
        const mine = teamFrags(room, shooter.team);
        // First team to the frag limit wins; matches always play to the limit.
        if (mine >= TDM_FRAG_LIMIT) startVote(room, null, shooter.team);
      }
    } else if (room.mode === 'duel') {
      // Casual Duel: a single first-to-N 1v1 race (same format as ranked, but it
      // ends in the normal map vote instead of an Elo update + dissolve).
      if (shooter.frags >= DUEL_FRAG_LIMIT) startVote(room, shooter.id);
    } else {
      // FFA: first to the frag limit ends the match (no early mercy stop).
      if (shooter.frags >= MATCH_FRAG_LIMIT) startVote(room, shooter.id);
    }
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
    const spawn = pickSpawn(room, c, null);
    c.pos = { ...spawn };
    c.deaths += 1;
    c.mStreak = 0;
    c.history.length = 0;
    c.invulnUntilMs = now + SPAWN_INVULN_MS;
    sendRaw(c.socket, { type: 'respawn', x: spawn.x, y: spawn.y, z: spawn.z, reason: 'void' });
  };

  // ── Connection ────────────────────────────────────────────────────────
  wss.on('connection', (socket: WebSocket, req?: UpgradeReq) => {
    const id = genId();
    const now = Date.now();
    // The progression identity (the logged-in account behind the httpOnly
    // `igsession` cookie) rides the WS upgrade on the same origin — we use it to
    // ownership-check cosmetic equips. Guests resolve to '' (defaults only).
    const playerId = accountIdFromCookieHeader(req?.headers?.cookie);
    // The display name is SERVER-AUTHORITATIVE — never taken from the client.
    // A logged-in player gets their account username (moderated at registration,
    // see server/profanity.ts); a guest starts as "Guest" and is renumbered to a
    // per-room "Guest N" on join (assignGuestName). This is the only name other
    // players ever see, so a modified client can't inject a slur via `name`.
    const account = playerId ? findUserById(playerId) : undefined;
    const accountName = account?.username;
    const record: ClientRecord = {
      id,
      socket,
      name: accountName ?? 'Guest',
      roomId: null,
      spectating: null,
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      frags: 0,
      deaths: 0,
      invulnUntilMs: 0,
      respawnAt: 0,
      connectedAt: now,
      lastSeen: now,
      lastActiveMs: now,
      rttMs: 0,
      resumeToken: genToken(),
      disconnectedAt: 0,
      lastRecoverMs: 0,
      lastShotMs: 0,
      lastPosMs: 0,
      lastPosRxMono: 0,
      posCreditMs: 0,
      msgWindowStart: now,
      msgCount: 0,
      roomWindowStart: now,
      roomCount: 0,
      chatWindowStart: now,
      chatCount: 0,
      hat: 'hat.none',
      unusual: 'unusual.none',
      emote: 'emote.cheer',
      nameColor: 'name.default',
      spawnEffect: 'spawn.beam',
      killEffect: DEFAULT_KILL_EFFECT,
      title: 'title.none',
      railColor: DEFAULT_RAIL_COLOR,
      railgunFinish: DEFAULT_RAILGUN_FINISH,
      looks: {},
      strangeUids: [],
      lastTauntMs: 0,
      crosshair: '',
      card: null,
      playerId,
      netId: netIdFrom(req),
      admin: !!account?.isAdmin,
      verified: !!account?.isVerified,
      history: [],
      posSamples: [],
      posTl: newPosTimeline(),
      renderPos: { x: 0, y: 0, z: 0, yaw: 0 },
      posGapEma: 0,
      posGapJitterEma: 0,
      aimShots: 0,
      aimHits: 0,
      aimHeadshots: 0,
      aimFlagged: false,
      mShots: 0,
      mHits: 0,
      mKills: 0,
      mKillWeight: 0,
      mVictims: new Map(),
      mHeadshots: 0,
      mStreak: 0,
      mBestStreak: 0,
      mStartedAt: now,
      mSettled: false,
      undeliveredProgression: null,
      team: null,
    };
    // Start from the account's persisted equipment (guests: stock defaults) so
    // even a client that never sends `loadout` is shown correctly.
    if (playerId) {
      try {
        const eq = resolveEquipped(playerId);
        applyLooks(record, eq.looks, eq.strangeUids);
      } catch (err) {
        console.error('[instagib] resolveEquipped failed', err);
      }
    }
    clients.set(id, record);
    sendRaw(socket, { type: 'welcome', clientId: id, serverTime: now, resumeToken: record.resumeToken });
    schedulePresence(); // a new socket bumps the online count for everyone in the menu

    socket.on('message', (raw, isBinary) => {
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
      if (isBinary) {
        // The only binary frame a client sends is the hot 64Hz position update;
        // it crosses the transport seam (see decodeUnreliable above).
        const decoded = decodeUnreliable(raw);
        if (!decoded) return;
        msg = decoded;
      } else {
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return;
        }
      }
      record.lastSeen = ts;
      switch (msg.type) {
        case 'hello':
          // Names are server-authoritative (set on connect from the account, or
          // assigned as "Guest N" on join), so the client's name is ignored.
          break;

        case 'list':
          listers.add(record.id);
          sendRaw(socket, { type: 'rooms', rooms: publicRoomList() });
          // Opening the menu: seed the live online list + recent chat, then
          // refresh everyone else (this client's inMatch flag just cleared).
          sendRaw(socket, buildPresence());
          if (chatHistory.length > 0) sendRaw(socket, { type: 'chat-history', messages: chatHistory });
          schedulePresence();
          break;

        case 'chat': {
          // Three contexts share this message: a player IN A ROOM → match chat
          // (everyone in the match, GMod-style); a SPECTATOR → the watched room's
          // match chat (tagged so players can tell it's an observer); a menu
          // client (lister) → the global lobby chat. Identity is server-
          // authoritative; content is sanitized, length-capped, profanity-
          // filtered, and rate-limited for all. In-room/spectating take priority.
          const inRoom = !!record.roomId;
          const isSpectator = !inRoom && !!record.spectating;
          const inLobby = !inRoom && !isSpectator && listers.has(record.id);
          if (!inRoom && !isSpectator && !inLobby) break;
          const text = sanitizeChat(msg.text);
          if (!text) break;
          // Global lobby chat is accounts-only — anonymous broadcast is the abuse
          // vector. Match chat (playing OR spectating) allows everyone (guests
          // show as their room/"Guest N" name).
          if (!inRoom && !isSpectator && !record.playerId) {
            sendRaw(socket, { type: 'chat-rejected', reason: 'account' });
            break;
          }
          if (ts - record.chatWindowStart >= CHAT_RATE_WINDOW_MS) {
            record.chatWindowStart = ts;
            record.chatCount = 0;
          }
          record.chatCount += 1;
          if (record.chatCount > CHAT_RATE_LIMIT) {
            sendRaw(socket, { type: 'chat-rejected', reason: 'rate' });
            break;
          }
          if (containsProfanity(text)) {
            sendRaw(socket, { type: 'chat-rejected', reason: 'blocked' });
            break;
          }
          const out: ChatBroadcast = {
            type: 'chat',
            id: (chatSeq += 1),
            name: record.name, // server-authoritative (account username or "Guest N")
            text,
            ts,
            admin: record.admin,
            verified: record.verified,
            guest: !record.playerId,
            spectator: isSpectator, // UI shows a "spec" tag on observer lines
          };
          if (inRoom || isSpectator) {
            const room = rooms.get((record.roomId ?? record.spectating)!);
            if (room) broadcastRoom(room, out); // sender included (member or spectator) → sees own line
          } else {
            chatHistory.push(out);
            if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
            const payload = JSON.stringify(out);
            for (const lid of listers) {
              const c = clients.get(lid);
              if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
            }
          }
          break;
        }

        case 'create': {
          rankedQueue.delete(record.id); // creating a room → leave the ranked queue
          if (!chargeRoomCreate(record, ts)) {
            sendRaw(socket, { type: 'join-failed', reason: 'rate' });
            break;
          }
          const isPublic = msg.isPublic !== false; // default public
          const mode = parseMode(msg.mode);
          const label =
            isPublic ? `${record.name}'s Lobby` : `${record.name}'s Private Match`;
          const room = createRoom({
            name: label,
            mode,
            mapId: typeof msg.mapId === 'string' ? msg.mapId : DEFAULT_ARENA_ID,
            isPublic,
            capacity: clampInt(msg.capacity, 2, DEFAULT_CAPACITY, DEFAULT_CAPACITY),
            hostId: record.id,
          });
          sendRaw(socket, {
            type: 'created',
            roomId: room.id,
            mode: room.mode,
            mapId: room.mapId,
            isPublic: room.isPublic,
          });
          break;
        }

        case 'quickmatch': {
          // Find the fullest joinable public room. `mode: 'any'` (the "Play Now"
          // super-queue) matches ANY mode so a small population concentrates
          // instead of fragmenting three ways; otherwise the SAME mode only. A
          // room JUST created (empty during the matched→join handoff) counts as a
          // target too (#9), so two players quick-matching within ~1s land
          // together instead of in two empties.
          const anyMode = msg.mode === 'any';
          const mode = anyMode ? 'ffa' : parseMode(msg.mode); // 'any' creates FFA if nothing's live
          let target: Room | null = null;
          for (const r of rooms.values()) {
            if (!r.isPublic) continue;
            if (!anyMode && r.mode !== mode) continue;
            if (r.members.size >= r.capacity) continue;
            if (r.state !== 'active') continue;
            if (sameAccountMember(r, record)) continue; // this account is already in there (another tab)
            const reserved =
              r.members.size === 0 &&
              !r.wasEverOccupied &&
              ts - r.emptySince < 8_000; // create→join reservation window
            if (r.members.size === 0 && !reserved) continue;
            if (!target || r.members.size > target.members.size) target = r;
          }
          if (!target) {
            if (!chargeRoomCreate(record, ts)) {
              sendRaw(socket, { type: 'join-failed', reason: 'rate' });
              break;
            }
            const pool = mapPoolForMode(mode);
            const mapId = pool[Math.floor(Math.random() * pool.length)];
            target = createRoom({
              name: mode === 'duel' ? 'Quick Duel' : mode === 'tdm' ? 'Quick TDM' : 'Quick Match',
              mode,
              mapId,
              isPublic: true,
              capacity: modeCapacity(mode),
              hostId: null,
            });
          }
          rankedQueue.delete(record.id); // chose casual → leave the ranked queue
          sendRaw(socket, { type: 'matched', roomId: target.id, mapId: target.mapId });
          break;
        }

        case 'ranked-queue': {
          // Ranked Duel is account-only — a guest has no persistent rating.
          if (!record.playerId) {
            sendRaw(socket, { type: 'ranked-status', state: 'idle', reason: 'account' });
            break;
          }
          if (record.roomId || record.spectating) break; // can't queue mid-match
          // Anti-abuse: one account may hold at most ONE queue slot. Drop any other
          // connection of the same account already queued (a second tab) so a
          // player can never be matched against themselves.
          for (const [qid] of rankedQueue) {
            const qc = clients.get(qid);
            if (qid !== record.id && qc?.playerId === record.playerId) rankedQueue.delete(qid);
          }
          // And can't queue while already playing a ranked match in another tab.
          if (accountInRankedMatch(record.playerId)) {
            sendRaw(socket, { type: 'ranked-status', state: 'idle', reason: 'in-match' });
            break;
          }
          rankedQueue.set(record.id, { rating: getRankedRating(record.playerId), joinedAt: ts });
          sendRaw(socket, { type: 'ranked-status', state: 'searching', size: rankedQueue.size, since: ts });
          break;
        }

        case 'ranked-cancel': {
          rankedQueue.delete(record.id);
          sendRaw(socket, { type: 'ranked-status', state: 'idle' });
          break;
        }

        case 'ranked-rooms': {
          // Live ranked duels available to spectate (the ladder side-panel).
          const list: {
            id: string;
            mapId: string;
            spectators: number;
            players: { name: string; frags: number }[];
          }[] = [];
          for (const r of rooms.values()) {
            if (!r.isRanked || r.members.size === 0 || r.state !== 'active') continue;
            const players: { name: string; frags: number }[] = [];
            for (const mid of r.members) {
              const c = clients.get(mid);
              if (c) players.push({ name: c.name, frags: c.frags });
            }
            list.push({ id: r.id, mapId: r.mapId, spectators: r.spectators.size, players });
          }
          sendRaw(socket, { type: 'ranked-rooms', rooms: list });
          break;
        }

        case 'join': {
          rankedQueue.delete(record.id); // joining a room → leave the ranked queue
          const room = msg.roomId ? rooms.get(msg.roomId) : undefined;
          if (!room) {
            sendRaw(socket, { type: 'join-failed', reason: 'gone' });
            break;
          }
          if (handleSameAccount(record, room)) break; // reclaimed own slot, or 'duplicate'
          if (room.members.size >= room.capacity && !room.members.has(record.id)) {
            sendRaw(socket, { type: 'join-failed', reason: 'full' });
            break;
          }
          joinRoom(record, room);
          break;
        }

        case 'spectate': {
          // Watch a live match read-only. No capacity check — full matches are
          // exactly what you can't join but should be able to watch. Spectators
          // never enter members, so they're excluded from snapshots, shots,
          // teams, and votes; they only receive the room's broadcasts + state.
          const room = msg.roomId ? rooms.get(msg.roomId) : undefined;
          if (!room) {
            sendRaw(socket, { type: 'spectate-failed', reason: 'gone' });
            break;
          }
          rankedQueue.delete(record.id); // watching instead → leave the ranked queue
          leaveRoom(record); // can't be a player and a spectator at once
          leaveSpectate(record); // single-spectate invariant
          // If THIS connection was the room's last member, leaveRoom just emptied
          // it (and released any other spectators) — there's nothing live to
          // watch, so refuse rather than freeze on a 0-member room until reap.
          if (room.members.size === 0) {
            sendRaw(socket, { type: 'spectate-failed', reason: 'gone' });
            break;
          }
          listers.delete(record.id);
          record.spectating = room.id;
          room.spectators.add(record.id);
          sendRaw(socket, {
            type: 'spectating',
            roomId: room.id,
            mode: room.mode,
            mapId: room.mapId,
            state: room.state,
          });
          // Ship the current roster immediately so names/cosmetics resolve before
          // the first state frame, and replay an in-progress vote (mirrors join).
          sendRaw(socket, roomMeta(room));
          if (room.state === 'voting' && room.vote) {
            sendRaw(socket, {
              type: 'vote-start',
              options: room.vote.options,
              endsAt: room.vote.endsAt,
              durationMs: MAP_VOTE_DURATION_SEC * 1000,
            });
          }
          broadcastRoomList(); // spectator count changed
          schedulePresence();
          break;
        }

        case 'resume': {
          // A reconnecting client presents its previous resume token to reclaim
          // its in-match slot + score. On miss/expiry, fall back to a fresh join.
          const token = typeof msg.token === 'string' ? msg.token : '';
          let old: ClientRecord | null = null;
          if (token) {
            for (const c of clients.values()) {
              if (c !== record && c.disconnectedAt > 0 && c.resumeToken === token) {
                old = c;
                break;
              }
            }
          }
          if (old && Date.now() - old.disconnectedAt <= RESUME_GRACE_MS && resumeMatch(record, old)) {
            break;
          }
          // No resumable slot → behave like a normal join (or fail).
          const room = msg.roomId ? rooms.get(msg.roomId) : undefined;
          if (!room) {
            sendRaw(socket, { type: 'join-failed', reason: 'gone' });
            break;
          }
          if (handleSameAccount(record, room)) break; // reclaimed own slot, or 'duplicate'
          if (room.members.size >= room.capacity && !room.members.has(record.id)) {
            sendRaw(socket, { type: 'join-failed', reason: 'full' });
            break;
          }
          joinRoom(record, room);
          break;
        }

        case 'leave':
          leaveRoom(record);
          leaveSpectate(record); // also covers a spectator stopping watching
          broadcastRoomList(); // refresh players/spectator counts in the lobby
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

        // Economy v3 loadout: the client names the equipped tokens (instance uids,
        // or `def:<id>` for defaults / entitlements); the server checks ownership
        // and resolves the Looks itself. Guests: stock defaults only.
        case 'loadout': {
          const tokens = Array.isArray(msg.uids) ? (msg.uids as unknown[]).filter((u): u is string => typeof u === 'string') : [];
          if (!record.playerId) break;
          const res = resolveTokens(record.playerId, tokens);
          const before = JSON.stringify(record.looks);
          applyLooks(record, res.looks, res.strangeUids);
          if (JSON.stringify(record.looks) !== before) bumpMeta(record);
          break;
        }

        // Pre-v3 per-slot cosmetic messages: the payload is ignored (ownership is
        // instance-based now) — re-read the account's persisted equipment instead.
        case 'hat':
        case 'unusual':
        case 'emote':
        case 'nameColor':
        case 'spawnEffect':
        case 'killEffect':
        case 'title':
        case 'railColor':
        case 'railgunFinish': {
          if (!record.playerId) break;
          const eq = resolveEquipped(record.playerId);
          const before = JSON.stringify(record.looks);
          applyLooks(record, eq.looks, eq.strangeUids);
          if (JSON.stringify(record.looks) !== before) bumpMeta(record);
          break;
        }

        case 'taunt': {
          // Plays the equipped emote for everyone in the room. Alive players only,
          // 3 s cooldown; the payload carries the emote Look (incl. an unusual effect).
          if (!record.roomId || record.disconnectedAt > 0) break;
          const room = rooms.get(record.roomId);
          if (!room || !room.members.has(record.id) || room.state !== 'active') break;
          if (record.respawnAt > ts) break; // dead / in the killcam
          if (ts - record.lastTauntMs < TAUNT_COOLDOWN_MS) break;
          record.lastTauntMs = ts;
          broadcastRoom(room, { type: 'taunt', id: record.id, look: record.looks.emote ?? { d: 'emote.cheer' } });
          break;
        }

        case 'crosshair': {
          // Crosshair as an opaque share-code string (the client encodes/decodes
          // it). Not an unlockable, so no ownership check — just length-cap it.
          // Echoed via meta so a spectator can render the watched player's reticle.
          const next = typeof msg.code === 'string' ? msg.code.slice(0, 200) : '';
          if (next !== record.crosshair) { record.crosshair = next; bumpMeta(record); }
          break;
        }

        case 'card':
          record.card = sanitizeCard(msg.card, record.name, record.looks.card?.d ?? 'card.slate', {
            admin: record.admin,
            verified: record.verified,
            title: resolveTitleText(record.playerId, record.title),
            level: levelFor(record.playerId),
          });
          break;

        case 'pos': {
          if (
            !record.roomId ||
            !Number.isFinite(msg.x) ||
            !Number.isFinite(msg.y) ||
            !Number.isFinite(msg.z) ||
            !Number.isFinite(msg.yaw) ||
            Math.abs(msg.x) > POS_MAX_COORD ||
            Math.abs(msg.y) > POS_MAX_COORD ||
            Math.abs(msg.z) > POS_MAX_COORD ||
            Math.abs(msg.yaw) > POS_MAX_ANGLE
          ) {
            break;
          }
          // Only a well-formed u32 tick opts into the tick timeline (JSON uploads
          // could otherwise carry negative / huge / fractional ticks).
          const hasTick = msg.tick !== undefined;
          const ticked =
            hasTick && Number.isInteger(msg.tick) && (msg.tick as number) >= 0 && (msg.tick as number) <= 0xffffffff;
          if (hasTick && !ticked) break;
          const flags = Number.isInteger(msg.flags) ? (msg.flags as number) & 0xff : 0;
          const yaw = wrapAngle(msg.yaw);
          {
            const tl = record.posTl;
            const prevPosMs = record.lastPosMs;
            // Movement credit (see POS_SILENT_CREDIT_MS): real time since the
            // previous RECEIVED upload, silence capped. The speed clamp below
            // allows at most this much movement time since the last ACCEPTED pos.
            const mono = performance.now();
            if (record.lastPosRxMono > 0) {
              record.posCreditMs += Math.min(mono - record.lastPosRxMono, POS_SILENT_CREDIT_MS);
            }
            record.lastPosRxMono = mono;
            // Elapsed movement time for the clamp. Tick-stamped uploads use the
            // sender's SIM dt, bounded by the credit + POS_DT_SLACK_MS (the old
            // receive-time dt read a flush of several ticks landing ~1ms apart as
            // 100+ m/s and DROPPED legitimate movement); legacy uploads use the credit.
            let clampMs = record.posCreditMs;
            let simMs = ts;
            let hold: PosSample | null = null;
            if (ticked) {
              const tick = msg.tick as number;
              simMs = tick * TICK_MS;
              const lead = simMs - mono;
              if (tl.lastTick >= 0) {
                if (tick <= tl.lastTick) break; // stale/duplicate (a reordered datagram)
                const creep = ((mono - tl.lastMono) / 1000) * POS_LEAD_CREEP_PER_S;
                if (lead > tl.leadBase + creep + POS_LEAD_SLACK_MS) {
                  // Sim clock ahead of real time: drop — unless it persists, which
                  // is a genuine shift (see POS_LEAD_RESEED_REJECTS), not a hack.
                  tl.leadRejects += 1;
                  if (tl.leadRejects < POS_LEAD_RESEED_REJECTS) break;
                  tl.leadBase = lead;
                  tl.leadRejects = 0;
                  // (the re-seed upload's clamp gets the real-time credit only)
                } else {
                  tl.leadRejects = 0;
                  tl.leadBase = Math.max(tl.leadBase, Math.min(lead, tl.leadBase + creep));
                  clampMs = Math.min((tick - tl.lastTick) * TICK_MS, record.posCreditMs + POS_DT_SLACK_MS);
                }
                // The sender skipped uploads because nothing changed (or its sim
                // froze): hold the last pose up to the tick before this one
                // instead of gliding across the gap.
                const last = record.posSamples[record.posSamples.length - 1];
                if ((flags & POS_FLAG_HOLD) !== 0 && tick - tl.lastTick > 1 && last) {
                  hold = { t: simMs - TICK_MS, x: last.x, y: last.y, z: last.z, yaw: last.yaw };
                }
              } else {
                // First tick-stamped upload of this timeline: seed the baseline
                // (the clamp uses the real-time credit).
                tl.leadBase = lead;
                tl.leadRejects = 0;
              }
            }
            // Speed clamp (#3): reject implausible teleports/speedhacks — these
            // positions feed both the snapshot broadcast and lag-comp rewind, so
            // a spoof would poison what every other player sees + shoots. Skip
            // the first packet after a teleport (history cleared by a server
            // respawn/vote) so legitimate repositions aren't flagged. A zero
            // allowance (two uploads in the same instant) still bounds the move.
            if (record.history.length > 0 && prevPosMs > 0) {
              const horiz = Math.hypot(msg.x - record.pos.x, msg.z - record.pos.z);
              const vert = Math.abs(msg.y - record.pos.y);
              const dtSec = Math.max(clampMs, 1) / 1000;
              // Clamp BOTH axes — vertical was previously untrusted, letting a
              // client fly/noclip straight up (moving its hitbox + snapshot).
              if (horiz / dtSec > MAX_MOVE_SPEED || vert / dtSec > MAX_VERTICAL_SPEED) {
                break; // drop, keep last good pos (credit keeps accruing)
              }
            }
            record.posCreditMs = 0;
            record.lastPosMs = ts;
            if (ticked) {
              tl.lastTick = msg.tick as number;
              tl.lastArrival = ts;
              tl.lastMono = mono;
              noteLateness(tl, ts, ts - simMs);
            }
            // Count real movement as activity (resets the AFK timer; pings don't),
            // and break spawn invuln — protection lasts only while you hold still.
            const moved = Math.hypot(msg.x - record.pos.x, msg.z - record.pos.z);
            if (moved > 0.1) {
              record.lastActiveMs = ts;
              if (record.invulnUntilMs > ts) record.invulnUntilMs = 0;
              // Legacy uploads: track this sender's arrival cadence ONLY while
              // moving (idle-dedup heartbeats would otherwise inflate the gap).
              // Drives their adaptive resample lag at snapshot time.
              if (!ticked && prevPosMs > 0) {
                const gap = ts - prevPosMs;
                if (gap > 0 && gap < 500) {
                  record.posGapEma =
                    record.posGapEma === 0 ? gap : record.posGapEma + (gap - record.posGapEma) * 0.1;
                  record.posGapJitterEma += (Math.abs(gap - record.posGapEma) - record.posGapJitterEma) * 0.1;
                }
              }
            }
            record.pos.x = msg.x;
            record.pos.y = msg.y;
            record.pos.z = msg.z;
            record.yaw = yaw;
            if (typeof msg.pitch === 'number' && Number.isFinite(msg.pitch)) {
              record.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, msg.pitch));
            }
            // Buffer the sample (sim- or receive-time stamped) so the snapshot
            // tick can resample to a consistent instant (see POS_LAG_MS / TICK_MS).
            if (hold) record.posSamples.push(hold);
            record.posSamples.push({ t: simMs, x: msg.x, y: msg.y, z: msg.z, yaw });
            const sCut = simMs - (ticked ? POS_TICK_SAMPLE_WINDOW_MS : POS_SAMPLE_WINDOW_MS);
            while (record.posSamples.length > 2 && record.posSamples[0].t < sCut) {
              record.posSamples.shift();
            }
            // (Lag-comp history is sampled — from the RESAMPLED pos — on the snapshot tick.)
            const room = rooms.get(record.roomId);
            if (room) recoverIfOob(record, room, ts);
          }
          break;
        }

        case 'ping':
          if (typeof msg.rtt === 'number' && msg.rtt >= 0 && msg.rtt < 2000) {
            record.rttMs = msg.rtt; // client-measured ping, echoed in snapshots
          }
          sendRaw(socket, { type: 'pong', ts: msg.ts, serverTime: Date.now() });
          break;

        case 'shoot':
          handleShoot(record, msg);
          break;

        default:
          break;
      }
    });

    socket.on('close', () => handleDisconnect(record));
    socket.on('error', () => handleDisconnect(record));
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
  let snapshotDiagLastTick = 0;
  let snapshotDiagStarted = Date.now();
  let snapshotDiagTicks = 0;
  let snapshotDiagTickGapTotal = 0;
  let snapshotDiagTickGapMax = 0;
  let snapshotDiagFrames = 0;
  let snapshotDiagBytes = 0;
  let snapshotDiagBufferedMax = 0;
  let snapshotDiagSkipped = 0;

  // Always-on event-loop health gauge (vs NETCODE_DIAG which is opt-in + log-only).
  // The 64Hz tick is the canary: ANY synchronous stall on the shared event loop —
  // a slow better-sqlite3 query, a GC pause, host CPU steal/throttling on the
  // platform — delays the NEXT tick, and with it every player's pong, which is
  // exactly the "all players' ping spiked at once" symptom. Measuring how late
  // each tick fires surfaces that class of problem regardless of its source.
  // Surfaced via liveCounts() → /api/live so it can be read without a redeploy.
  const TICK_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
  let lastTickAt = 0;
  let loopLagEmaMs = 0; // smoothed recent lag (~150ms time constant)
  let loopLagMaxMs = 0; // peak lag over a rolling ≤30s window
  let loopLagMaxResetAt = 0;
  let loopLagWarnAt = 0;

  const snapshotTimer = setInterval(() => {
    const now = Date.now();
    const tickDtMs = lastTickAt > 0 ? Math.min(100, now - lastTickAt) : TICK_INTERVAL_MS;
    if (lastTickAt > 0) {
      const lag = Math.max(0, now - lastTickAt - TICK_INTERVAL_MS);
      loopLagEmaMs += (lag - loopLagEmaMs) * 0.1;
      if (now - loopLagMaxResetAt > 30_000) {
        loopLagMaxMs = 0;
        loopLagMaxResetAt = now;
      }
      if (lag > loopLagMaxMs) loopLagMaxMs = lag;
      if (lag >= 50 && now - loopLagWarnAt > 2_000) {
        loopLagWarnAt = now;
        console.warn(
          `[loop-lag] tick fired ${Math.round(lag)}ms late (event loop stalled) — clients:${clients.size} rooms:${rooms.size}`,
        );
      }
    }
    lastTickAt = now;
    if (NETCODE_DIAG) {
      if (snapshotDiagLastTick > 0) {
        const gap = now - snapshotDiagLastTick;
        snapshotDiagTickGapTotal += gap;
        snapshotDiagTickGapMax = Math.max(snapshotDiagTickGapMax, gap);
      }
      snapshotDiagLastTick = now;
      snapshotDiagTicks += 1;
    }
    for (const room of rooms.values()) {
      if (room.members.size === 0) continue;
      // Record each member's pose into the lag-comp history AT SNAPSHOT TIME (not
      // at pos-receive time). Clients interpolate remotes by snapshot timestamp,
      // so stamping history on the same timeline makes a rewind reconstruct the
      // exact position the shooter saw — hits land where you aimed regardless of
      // the target's ping (a high-ping target is no longer harder to hit).
      for (const id of room.members) {
        const c = clients.get(id);
        if (!c || c.disconnectedAt > 0) continue;
        // Resample to a consistent instant (anti-alias). The SAME resampled pos
        // is what the snapshot sends AND what the lag-comp history records, so a
        // viewer's render and the server's rewind agree exactly. Falls back to
        // the raw latest pos until a sample buffer exists (just-joined / respawn).
        // PER-PLAYER lag: buffer a bursty sender enough to stay interpolating
        // (smooth) instead of holding-then-jumping; clean senders get the floor.
        let sp: PosSample | null;
        if (c.posTl.lastTick >= 0) {
          // Tick-stamped sender: play their own sim timeline back at a bounded-
          // rate playout offset (see TICK_MS / playoutSimTime).
          sp = sampleAtTick(c.posSamples, playoutSimTime(c.posTl, now, tickDtMs), extrapScratch);
        } else {
          const lag = Math.max(
            POS_LAG_MS,
            Math.min(POS_LAG_MAX_MS, c.posGapEma + POS_LAG_JITTER_K * c.posGapJitterEma),
          );
          sp = sampleAt(c.posSamples, now - lag);
        }
        if (sp) {
          c.renderPos.x = sp.x; c.renderPos.y = sp.y; c.renderPos.z = sp.z; c.renderPos.yaw = sp.yaw;
        } else {
          c.renderPos.x = c.pos.x; c.renderPos.y = c.pos.y; c.renderPos.z = c.pos.z; c.renderPos.yaw = c.yaw;
        }
        // Snap the outgoing position to the wire grid BEFORE recording history.
        // The browser decodes these exact values, so lag-comp rewinds to the
        // same pose the shooter rendered (render == rewind stays intact).
        c.renderPos.x = quantizeStateCoord(c.renderPos.x);
        c.renderPos.y = quantizeStateCoord(c.renderPos.y);
        c.renderPos.z = quantizeStateCoord(c.renderPos.z);
        c.history.push({ t: now, x: c.renderPos.x, y: c.renderPos.y, z: c.renderPos.z });
        const cutoff = now - HISTORY_MS;
        while (c.history.length > 2 && c.history[0].t < cutoff) c.history.shift();
      }
      // Encode the snapshot ONCE as a binary frame and fan it out (vs JSON per
      // tick). ~3× smaller and no JSON.parse on the client's hot path.
      const snap = roomSnapshot(room, now);
      const buf = encodeState(snap.t, snap.players as unknown as BinStatePlayer[], snap.resumeAt ?? 0);
      if (NETCODE_DIAG) {
        snapshotDiagFrames += 1;
        snapshotDiagBytes += buf.byteLength;
      }
      for (const id of room.members) {
        const c = clients.get(id);
        if (c) sendUnreliable(c, buf);
      }
      // Spectators get the same state frames (they observe but don't appear in
      // the snapshot, since they're not in members).
      for (const id of room.spectators) {
        const c = clients.get(id);
        if (c) sendUnreliable(c, buf);
      }
    }
    if (NETCODE_DIAG && now - snapshotDiagStarted >= NETCODE_DIAG_INTERVAL_MS) {
      console.log('[netcode-diag]', JSON.stringify({
        elapsedMs: now - snapshotDiagStarted,
        rooms: rooms.size,
        clients: clients.size,
        tickHz: Number((snapshotDiagTicks * 1000 / (now - snapshotDiagStarted)).toFixed(1)),
        tickGapMeanMs: Number((snapshotDiagTickGapTotal / Math.max(1, snapshotDiagTicks - 1)).toFixed(1)),
        tickGapMaxMs: snapshotDiagTickGapMax,
        frameBytesMean: Math.round(snapshotDiagBytes / Math.max(1, snapshotDiagFrames)),
        socketBufferedMax: snapshotDiagBufferedMax,
        snapshotsSkipped: snapshotDiagSkipped,
      }));
      snapshotDiagStarted = now;
      snapshotDiagTicks = 0;
      snapshotDiagTickGapTotal = 0;
      snapshotDiagTickGapMax = 0;
      snapshotDiagFrames = 0;
      snapshotDiagBytes = 0;
      snapshotDiagBufferedMax = 0;
      snapshotDiagSkipped = 0;
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

  // Ranked matchmaking: pair the closest-rated waiters (oldest waiter first), the
  // acceptable rating gap widening the longer they've waited so a lone outlier
  // still gets a game. The ONLY hard block is same-account (you can't be matched
  // against your own second tab); everything else — including two accounts on one
  // office IP — is allowed to match freely. Match-fixing is neutralized by the
  // diminishing-Elo-vs-repeat-opponent rule in endRankedMatch, not by blocking
  // matches. Pairs spawn a private ranked room — both clients are 'matched' in.
  const rankedTimer = setInterval(() => {
    const now = Date.now();
    // Prune stale entries (socket gone, or the client moved into a match/spectate).
    for (const [id] of rankedQueue) {
      const c = clients.get(id);
      if (!c || c.socket.readyState !== c.socket.OPEN || c.roomId || c.spectating || !c.playerId) {
        rankedQueue.delete(id);
      }
    }
    let guard = 0;
    let progressed = true;
    while (progressed && rankedQueue.size >= 2 && guard++ < 64) {
      progressed = false;
      const waiting = [...rankedQueue.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      // Pair the oldest waiter that has an eligible partner (only same-account is
      // skipped). An oldest waiter with no eligible partner just waits while
      // others can still match.
      for (let wi = 0; wi < waiting.length && !progressed; wi++) {
        const [aId, a] = waiting[wi];
        const ca = clients.get(aId);
        if (!ca) {
          rankedQueue.delete(aId);
          progressed = true;
          break;
        }
        let bestId: ClientId | null = null;
        let bestGap = Infinity;
        for (let j = 0; j < waiting.length; j++) {
          if (j === wi) continue;
          const [cid, cv] = waiting[j];
          const cc = clients.get(cid);
          if (!cc) continue;
          if (cc.playerId === ca.playerId) continue; // same account (two tabs) — never self-match
          const gap = Math.abs(cv.rating - a.rating);
          if (gap < bestGap) {
            bestGap = gap;
            bestId = cid;
          }
        }
        if (!bestId) continue; // this waiter has no eligible partner yet — try the next
        const allowedGap = 150 + ((now - a.joinedAt) / 1000) * 75; // ~75 elo/sec wider
        if (bestGap > allowedGap) continue; // closest eligible still too far — keep waiting
        const cb = clients.get(bestId);
        rankedQueue.delete(aId);
        rankedQueue.delete(bestId);
        progressed = true;
        if (!cb) break;
        const pool = mapPoolForMode('duel');
        const mapId = pool[Math.floor(Math.random() * pool.length)] ?? DEFAULT_ARENA_ID;
        const room = createRoom({
          name: 'Ranked Duel',
          mode: 'duel',
          mapId,
          isPublic: false,
          capacity: 2,
          hostId: null,
          isRanked: true,
        });
        sendRaw(ca.socket, { type: 'matched', roomId: room.id, mapId: room.mapId, ranked: true });
        sendRaw(cb.socket, { type: 'matched', roomId: room.id, mapId: room.mapId, ranked: true });
      }
    }
  }, 1500);

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    // Drop stale clients (socket dead) and AFK players (alive socket but no real
    // input in a while — pings alone keep `lastSeen` fresh but not `lastActiveMs`,
    // so an idle client used to hold a slot, e.g. blocking a 2-cap duel room).
    for (const [id, c] of clients) {
      // Dropped-but-held for a possible resume: reap once the grace expires
      // (skip the stale/AFK paths — its socket is already gone).
      if (c.disconnectedAt > 0) {
        if (now - c.disconnectedAt > RESUME_GRACE_MS) {
          leaveRoom(c);
          leaveSpectate(c);
          listers.delete(id);
          clients.delete(id);
        }
        continue;
      }
      const stale = now - c.lastSeen > STALE_CLIENT_TIMEOUT_MS;
      const afk = c.roomId != null && now - c.lastActiveMs > AFK_TIMEOUT_MS;
      if (stale || afk) {
        try {
          if (afk && !stale) sendRaw(c.socket, { type: 'error', message: 'Kicked for inactivity' });
          c.socket.close();
        } catch {
          // ignore
        }
        leaveRoom(c);
        leaveSpectate(c); // a stale spectator socket must also leave room.spectators
        listers.delete(id);
        clients.delete(id);
      }
    }
    // Reap rooms that have been empty past the grace window. A room that has
    // never been joined (a private invite waiting for its first player) gets a
    // much longer grace so sharing a code over chat doesn't race a 30s reap (#16).
    for (const [rid, room] of rooms) {
      if (room.members.size !== 0 || room.emptySince <= 0) continue;
      // Long grace ONLY for never-occupied PRIVATE invite rooms (a shared code
      // waiting for a slow join). Public/quickmatch rooms that nobody joined are
      // phantoms — reap them on the short window so spam can't pile them up.
      const grace =
        !room.wasEverOccupied && !room.isPublic ? FRESH_ROOM_GRACE_MS : EMPTY_ROOM_GRACE_MS;
      if (now - room.emptySince > grace) {
        if (room.spectators.size > 0) endSpectators(room); // release stragglers before delete
        rooms.delete(rid);
      }
    }
    // Catch-all so the menu's online list reflects in-match joins/leaves and any
    // reaped sockets even on paths that don't call schedulePresence() directly.
    broadcastPresence();
  }, 5000);

  snapshotTimer.unref?.();
  voteTimer.unref?.();
  rankedTimer.unref?.();
  sweepTimer.unref?.();

  // Live counts for the lobby/landing "N playing now" social-proof readout.
  return {
    liveCounts() {
      let inMatch = 0;
      for (const c of clients.values()) if (c.roomId) inMatch++;
      let activeRooms = 0;
      for (const r of rooms.values()) if (r.members.size > 0) activeRooms++;
      return {
        online: clients.size,
        inMatch,
        rooms: activeRooms,
        loopLagMs: Math.round(loopLagEmaMs), // smoothed event-loop lag
        loopLagMaxMs: Math.round(loopLagMaxMs), // peak lag, rolling ≤30s window
      };
    },
  };
}
