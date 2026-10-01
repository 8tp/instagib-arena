// ── Desktop client bridge ─────────────────────────────────────────────────
// The Instagib desktop client (Electron) exposes a frozen `window.instagibClient`
// from its preload. The game feature-detects it and is otherwise unchanged, so
// in a normal browser everything here is a no-op. Contract (v1):
// https://github.com/8tp/instagib-client/blob/main/docs/CLIENT-API.md
//
// Game → client traffic is coarse lifecycle state only (Discord presence, the
// match-found alert). Never put other players' names, positions, view angles or
// anything else that changes per tick in a payload.

export type ClientPresence = {
  state: 'menu' | 'queue' | 'match' | 'spectate' | 'results' | 'training';
  mode?: string; // display labels, not ids
  map?: string;
  score?: number; // own frags (or own team's in TDM)
  opponentScore?: number; // the leading opponent / the other team
  endsAt?: number; // wall-clock epoch ms the match ends
  roomId?: string; // only when other people can actually join
  partySize?: number;
  partyMax?: number;
};

export interface InstagibClientBridge {
  readonly apiVersion: 1;
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly frames: {
    readonly uncapped: boolean; // rAF is NOT display-paced: the game must cap itself
    readonly displayHz: number; // 0 = unknown
  };
  emit(type: 'presence', payload: ClientPresence): void;
  emit(type: 'match-found', payload: Record<string, never>): void;
}

// Dev-only stand-in so the bridge can be exercised in a plain browser:
// `?client-sim` (capped) or `?client-sim=uncapped`, optionally `&client-hz=144`.
// Emits are logged to the console. Compiled out of production builds.
function simulatedBridge(): InstagibClientBridge | null {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('client-sim')) return null;
  const hz = Number(q.get('client-hz') ?? 0);
  const log = (type: string, payload: unknown) => console.info('[client-sim] emit', type, payload);
  return Object.freeze({
    apiVersion: 1,
    version: '0.0.0-sim',
    platform: 'linux',
    frames: Object.freeze({
      uncapped: q.get('client-sim') === 'uncapped',
      displayHz: Number.isFinite(hz) && hz > 0 ? Math.round(hz) : 0,
    }),
    emit: log,
  } as const);
}

function detect(): InstagibClientBridge | null {
  if (typeof window === 'undefined') return null;
  const c = (window as { instagibClient?: { apiVersion?: unknown } }).instagibClient;
  if (c?.apiVersion === 1) return c as InstagibClientBridge;
  if (import.meta.env.DEV) return simulatedBridge();
  return null;
}

/** The desktop client's bridge, or null in a normal browser. */
export const instagibClient: InstagibClientBridge | null = detect();

/**
 * True when the client runs Chromium with the frame-rate limit and vsync off:
 * rAF then fires back to back, so the game paces itself inside rAF (see
 * Game.scheduleFrame). Always false in a browser.
 */
export const clientFramesUncapped = instagibClient?.frames.uncapped === true;

/** The client's "Auto" cap (fpsLimit 0): twice the display refresh, 288 if unknown. */
export function clientAutoFpsCap(): number {
  const hz = instagibClient?.frames.displayHz ?? 0;
  return hz > 0 ? 2 * Math.round(hz) : 288;
}

// The contract's room-id shape (the client builds a Discord Join button and an
// instagib://join/<roomId> link from it).
const ROOM_ID_RE = /^[A-Z0-9]{4,16}$/;
// Same-state updates (score ticks) go out at most this often.
const PRESENCE_MIN_INTERVAL_MS = 1000;

let lastKey = '';
let lastState: ClientPresence['state'] | null = null;
let lastSentAt = 0;
let pending: ClientPresence | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function send(p: ClientPresence) {
  lastKey = JSON.stringify(p);
  lastState = p.state;
  lastSentAt = Date.now();
  try {
    instagibClient?.emit('presence', p);
  } catch {
    // Fire-and-forget: a client-side failure must never break the game.
  }
}

/**
 * Report the player's coarse state. Safe to call on every HUD push: identical
 * payloads are dropped, a state change goes out immediately, and changes
 * within the same state (score) are throttled to one per second, trailing, so
 * the final value always lands.
 */
export function setClientPresence(p: ClientPresence): void {
  if (!instagibClient) return;
  const payload: ClientPresence = { ...p };
  if (payload.roomId !== undefined && !ROOM_ID_RE.test(payload.roomId)) delete payload.roomId;
  for (const k of Object.keys(payload) as (keyof ClientPresence)[]) {
    if (payload[k] === undefined) delete payload[k];
  }
  const key = JSON.stringify(payload);
  if (key === lastKey) {
    pending = null; // e.g. a score blip that reverted before the trailing send
    return;
  }
  const wait = lastSentAt + PRESENCE_MIN_INTERVAL_MS - Date.now();
  if (payload.state !== lastState || wait <= 0) {
    pending = null;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    send(payload);
    return;
  }
  pending = payload;
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (pending) send(pending);
      pending = null;
    }, wait);
  }
}

/** A queue popped / a match is about to start while the player sat in a menu. */
export function emitClientMatchFound(): void {
  try {
    instagibClient?.emit('match-found', {});
  } catch {
    // Fire-and-forget.
  }
}
