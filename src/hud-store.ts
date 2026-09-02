// ── HUD store ─────────────────────────────────────────────────────────────
// The engine pushes an immutable HudState at ~20 Hz (plus event-driven pushes
// on kills, respawns, votes…). Setting that whole object into GameView state
// re-rendered every overlay component on every push. Instead the push lands
// here and each HUD piece subscribes to just the slice it draws
// (useSyncExternalStore). Two things make those slices cheap to subscribe to:
//
//  1. Structural sharing — object fields keep their previous REFERENCE while
//     semantically unchanged (same killfeed ids, same banner id, same scores…)
//     so a memoized component sees identical props and skips. Timer fields
//     (`remaining`) on a shared object are therefore frozen at first sight;
//     read `snapshot.raw` for live numbers.
//  2. Event ids — the floats that decay every push (railCooldown, dashCooldown,
//     damageFlash) and the id-less killcam become monotonic counters that bump
//     on their rising edge. React keys a CSS animation off the id and never
//     touches the element again until it unmounts (see src/hud.css).
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import type {
  HudState,
  MapVoteState,
  PlayerScore,
  SpectatorHud,
} from './game/types';

export type HudSnapshot = HudState & {
  raw: HudState; // the untouched latest push (live `remaining` values live here)
  railFireId: number; // bumps when railCooldown rises (you fired)
  dashId: number; // bumps when dashCooldown rises (you dashed)
  damageId: number; // bumps when damageFlash rises (you were hit / killed)
  killcamId: number; // bumps when a killcam starts (KillcamState carries no id)
};

const EPS = 1e-6;

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function sameIds(a: readonly { id: number }[], b: readonly { id: number }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

// Keep the previous object while both exist and carry the same id.
function keepById<T extends { id: number }>(prev: T | null, next: T | null): T | null {
  if (prev && next && prev.id === next.id) return prev;
  return next;
}

// Keep the previous object while every (primitive) field is unchanged.
function keepShallow<T extends object>(prev: T | null, next: T | null): T | null {
  if (prev && next && shallowEqual(prev, next)) return prev;
  return next;
}

function keepScores(prev: PlayerScore[], next: PlayerScore[]): PlayerScore[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i++) if (!shallowEqual(prev[i], next[i])) return next;
  return prev;
}

function keepTuple(
  prev: [number, number] | null,
  next: [number, number] | null,
): [number, number] | null {
  if (prev && next && prev[0] === next[0] && prev[1] === next[1]) return prev;
  return next;
}

function keepVote(prev: MapVoteState | null, next: MapVoteState | null): MapVoteState | null {
  if (!prev || !next) return next;
  if (
    prev.endsAtClient !== next.endsAtClient ||
    prev.durationMs !== next.durationMs ||
    prev.myVote !== next.myVote ||
    prev.options.length !== next.options.length ||
    !shallowEqual(prev.counts, next.counts)
  ) {
    return next;
  }
  for (let i = 0; i < prev.options.length; i++) if (prev.options[i] !== next.options[i]) return next;
  return prev;
}

function keepChat(prev: HudState['chat'], next: HudState['chat']): HudState['chat'] {
  return prev.open === next.open && sameIds(prev.lines, next.lines) ? prev : next;
}

function keepSpectator(prev: SpectatorHud | null, next: SpectatorHud | null): SpectatorHud | null {
  if (!prev || !next) return next;
  if (
    prev.watchingId !== next.watchingId ||
    prev.watchingName !== next.watchingName ||
    prev.index !== next.index ||
    prev.count !== next.count ||
    prev.crosshairCode !== next.crosshairCode ||
    prev.players.length !== next.players.length
  ) {
    return next;
  }
  for (let i = 0; i < prev.players.length; i++) {
    if (prev.players[i].id !== next.players[i].id || prev.players[i].name !== next.players[i].name) {
      return next;
    }
  }
  return prev;
}

function derive(prev: HudSnapshot, next: HudState): HudSnapshot {
  const p = prev.raw;
  return {
    ...next,
    raw: next,
    killfeed: sameIds(prev.killfeed, next.killfeed) ? prev.killfeed : next.killfeed,
    toasts: sameIds(prev.toasts, next.toasts) ? prev.toasts : next.toasts,
    banner: keepById(prev.banner, next.banner),
    hitMarker: keepById(prev.hitMarker, next.hitMarker),
    killConfirm: keepById(prev.killConfirm, next.killConfirm),
    killFlash: keepById(prev.killFlash, next.killFlash),
    // One death per killcam: while it stays non-null it is the same death.
    killcam: prev.killcam && next.killcam ? prev.killcam : next.killcam,
    scores: keepScores(prev.scores, next.scores),
    teamScores: keepTuple(prev.teamScores, next.teamScores),
    matchOver: keepShallow(prev.matchOver, next.matchOver),
    vote: keepVote(prev.vote, next.vote),
    pom: keepShallow(prev.pom, next.pom),
    training: keepShallow(prev.training, next.training),
    netDebug: keepShallow(prev.netDebug, next.netDebug),
    chat: keepChat(prev.chat, next.chat),
    spectator: keepSpectator(prev.spectator, next.spectator),
    railFireId: prev.railFireId + (next.railCooldown > p.railCooldown + EPS ? 1 : 0),
    dashId: prev.dashId + (next.dashCooldown > p.dashCooldown + EPS ? 1 : 0),
    damageId: prev.damageId + (next.damageFlash > p.damageFlash + EPS ? 1 : 0),
    killcamId: prev.killcamId + (next.killcam && !p.killcam ? 1 : 0),
  };
}

export class HudStore {
  private snap: HudSnapshot;
  private listeners = new Set<() => void>();

  constructor(initial: HudState) {
    this.snap = { ...initial, raw: initial, railFireId: 0, dashId: 0, damageId: 0, killcamId: 0 };
  }

  getSnapshot = (): HudSnapshot => this.snap;
  // The latest raw push — for one-off reads outside the subscription model.
  getState = (): HudState => this.snap.raw;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  push(next: HudState): void {
    this.snap = derive(this.snap, next);
    for (const l of this.listeners) l();
  }
}

export const HudStoreContext = createContext<HudStore | null>(null);

export function useHudStore(): HudStore {
  const store = useContext(HudStoreContext);
  if (!store) throw new Error('useHudSlice must be used inside <HudStoreContext.Provider>');
  return store;
}

type SliceCache<T> = { snap: HudSnapshot; selector: (s: HudSnapshot) => T; value: T };

// Subscribe to `selector(snapshot)`. The component re-renders only when the
// selected value changes by `equal` (Object.is by default — return primitives
// or structurally-shared references; pass `shallowEqual` for fresh objects).
export function useStoreSlice<T>(
  store: HudStore,
  selector: (s: HudSnapshot) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  // useSyncExternalStore needs getSnapshot to hand back the SAME value for the
  // same store state (it calls it repeatedly to detect tearing), so the last
  // selection is cached per snapshot + selector identity.
  const cache = useRef<SliceCache<T> | null>(null);
  const getSnapshot = () => {
    const snap = store.getSnapshot();
    const c = cache.current;
    if (c && c.snap === snap && c.selector === selector) return c.value;
    const value = selector(snap);
    if (c && equal(c.value, value)) {
      cache.current = { snap, selector, value: c.value };
      return c.value;
    }
    cache.current = { snap, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useHudSlice<T>(
  selector: (s: HudSnapshot) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  return useStoreSlice(useHudStore(), selector, equal);
}

// A value captured from the snapshot the moment `key` changes (and at mount)
// and held until the next key. Used to pin CSS timing vars — e.g. how far into
// a cooldown the ring was when its animation started — so a re-render never
// rewrites an animated element's style.
export function useHudLatched<T>(key: number, selector: (s: HudSnapshot) => T): T {
  const store = useHudStore();
  const [latched, setLatched] = useState(() => ({ key, value: selector(store.getSnapshot()) }));
  if (latched.key !== key) {
    const next = { key, value: selector(store.getSnapshot()) };
    setLatched(next);
    return next.value;
  }
  return latched.value;
}

// ── Exit animations ───────────────────────────────────────────────────────
// The engine drops timed entries (killfeed rows, toasts, the banner, the
// killcam) the moment `remaining` hits 0 — and may drop them EARLY (list cap,
// match reset, a banner replaced by a newer one). Every such element
// pre-schedules its own fade in CSS (see hudTiming) so a natural end needs no
// React work; this hook only covers the early case: an id that vanished while
// still visible is kept for `exitMs` with `leaving: true` so the row can play
// its exit before unmounting. An id whose pre-scheduled fade (`leadMs` before
// its end) already started is unmounted immediately — re-triggering a fade on
// a half-faded element would flash it back to full opacity.

export type Exiting<T> = { item: T; leaving: boolean };

type Track<T> = { item: T; endAt: number; leaving: boolean; leaveAt: number };
type ExitState<T> = { src: readonly T[]; list: Track<T>[] };

function reconcile<T extends { id: number; remaining: number }>(
  list: Track<T>[],
  items: readonly T[],
  leadMs: number,
): Track<T>[] {
  const now = performance.now();
  const byId = new Map<number, Track<T>>();
  for (const t of list) byId.set(t.item.id, t);
  const live: Track<T>[] = [];
  let changed = false;
  for (const it of items) {
    const t = byId.get(it.id);
    if (t) {
      byId.delete(it.id);
      if (t.leaving) {
        changed = true;
        live.push({ ...t, leaving: false });
      } else {
        live.push(t);
      }
    } else {
      changed = true;
      live.push({ item: it, endAt: now + it.remaining * 1000, leaving: false, leaveAt: 0 });
    }
  }
  const leaving: Track<T>[] = [];
  for (const t of byId.values()) {
    if (t.leaving) {
      leaving.push(t); // already on its way out (the timer prunes it)
      continue;
    }
    changed = true;
    if (now < t.endAt - leadMs) leaving.push({ ...t, leaving: true, leaveAt: now });
    // else: its pre-scheduled fade already ran → drop now.
  }
  if (!changed) {
    // Same membership — but did the live order change?
    let i = 0;
    for (const t of list) {
      if (t.leaving) continue;
      if (live[i++] !== t) {
        changed = true;
        break;
      }
    }
  }
  return changed ? [...live, ...leaving] : list;
}

export function useExitList<T extends { id: number; remaining: number }>(
  items: readonly T[],
  opts: { exitMs: number; leadMs?: number; leavingFirst?: boolean },
): readonly Exiting<T>[] {
  const { exitMs, leadMs = exitMs, leavingFirst = false } = opts;
  const [state, setState] = useState<ExitState<T>>(() => ({
    src: items,
    list: reconcile([], items, leadMs),
  }));
  // Derive from props during render (the documented "information from previous
  // renders" pattern): React re-runs this render with the new state before
  // committing, so the returned list is always in sync with `items`.
  let cur = state;
  if (state.src !== items) {
    const list = reconcile(state.list, items, leadMs);
    if (list !== state.list) {
      cur = { src: items, list };
      setState(cur);
    }
  }

  // Prune leaving tracks once their exit animation has had time to finish.
  useEffect(() => {
    const pending = state.list.filter((t) => t.leaving);
    if (pending.length === 0) return;
    const due = Math.min(...pending.map((t) => t.leaveAt + exitMs));
    const handle = window.setTimeout(
      () => {
        setState((s) => {
          const now = performance.now();
          const list = s.list.filter((t) => !t.leaving || t.leaveAt + exitMs > now);
          return list.length === s.list.length ? s : { ...s, list };
        });
      },
      Math.max(0, due - performance.now()) + 8,
    );
    return () => window.clearTimeout(handle);
  }, [state, exitMs]);

  if (!leavingFirst) return cur.list;
  const out: Exiting<T>[] = [];
  for (const t of cur.list) if (t.leaving) out.push(t);
  for (const t of cur.list) if (!t.leaving) out.push(t);
  return out;
}

// Inline custom properties that let a CSS-animated HUD element
//  - know its full lifetime (`--hud-total`),
//  - join its entrance mid-way if React first saw it late (`--hud-age`, used as
//    a negative animation-delay), and
//  - pre-schedule its fade so it STARTS `leadMs` before the engine drops the
//    entry (`--hud-out-delay`) — no React updates in between.
// Call it with the first-seen `remaining`/`total` so the style never changes
// while the element is mounted.
export function hudTiming(remaining: number, total: number, leadMs = 0): CSSProperties {
  const age = Math.max(0, Math.round((total - remaining) * 1000));
  const outDelay = Math.max(0, Math.round(remaining * 1000 - leadMs));
  return {
    '--hud-total': `${total}s`,
    '--hud-age': `${age}ms`,
    '--hud-out-delay': `${outDelay}ms`,
  } as CSSProperties;
}

// Typed helper for ad-hoc custom properties in a React style prop.
export function cssVars(vars: Record<`--${string}`, string | number>): CSSProperties {
  return vars as CSSProperties;
}

