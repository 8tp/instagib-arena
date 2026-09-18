// Non-component plumbing for the command-deck UI (src/deck.tsx holds the
// components). Split out so the component file stays Fast-Refresh friendly.
//
//  - motion helpers (reduced-motion + the modal exit duration)
//  - UI sound helpers (hover blip throttle, click cues, gesture unlock)
//  - the modal stack (only the topmost open dialog handles Esc / Tab)
//  - the menu toast store + hook (rendered by <ToastStack /> in deck.tsx)

import { useCallback, useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { playUi, unlockUiAudio, type UiSoundName } from './game/audio';

/* ── Motion ─────────────────────────────────────────────────────────────── */

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// Must match the .deck-modal-exit / .deck-toast-exit durations in index.css.
export const MODAL_EXIT_MS = 140;
export const TOAST_EXIT_MS = 140;

/* ── UI sounds ──────────────────────────────────────────────────────────── */

// The UI AudioContext may only be created inside a user gesture. Arm it on the
// very first pointer/key interaction anywhere on the page (capture phase, so
// it runs before any handler that might want to play a cue).
if (typeof window !== 'undefined') {
  const unlock = () => unlockUiAudio();
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

const HOVER_GAP_MS = 70;
let lastHoverAt = 0;

// Hover blip: pointer hover only (never keyboard focus — the focus ring is the
// keyboard's feedback), never touch, never on disabled controls, and throttled
// so sweeping the mouse across a row of buttons doesn't machine-gun.
export function uiHover(e?: ReactPointerEvent<HTMLElement>) {
  if (e) {
    if (e.pointerType === 'touch') return;
    const el = e.currentTarget as HTMLElement & { disabled?: boolean };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  }
  const now = performance.now();
  if (now - lastHoverAt < HOVER_GAP_MS) return;
  lastHoverAt = now;
  playUi('uiHover');
}

export function uiSfx(name: UiSoundName | 'none') {
  if (name !== 'none') playUi(name);
}

// Spread onto any interactive element: hover blip + a click cue (fired in the
// capture phase so it never interferes with the element's own onClick).
export function sfxProps(sound: UiSoundName | 'none' = 'uiClick'): {
  onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture?: () => void;
} {
  return {
    onPointerEnter: uiHover,
    onClickCapture: sound === 'none' ? undefined : () => playUi(sound),
  };
}

/* ── Modal stack ────────────────────────────────────────────────────────── */

// Every open dialog registers here on mount. Escape and the Tab focus trap are
// only honoured by the topmost entry, so a nested modal (Settings → Feedback,
// Weekly → replay viewer) never closes or fights the one under it.
const modalStack: object[] = [];

export function useModalStack(): () => boolean {
  const token = useRef<object | null>(null);
  if (token.current === null) token.current = {};
  useEffect(() => {
    const t = token.current as object;
    modalStack.push(t);
    return () => {
      const i = modalStack.lastIndexOf(t);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, []);
  return useCallback(() => modalStack[modalStack.length - 1] === token.current, []);
}

/* ── Menu toasts ────────────────────────────────────────────────────────── */

export type ToastTone = 'plain' | 'ok' | 'warn' | 'err';
export type ToastItem = { id: number; text: string; tone: ToastTone; leaving: boolean };

const MAX_TOASTS = 4;
let toastList: ToastItem[] = [];
let nextToastId = 1;
const toastListeners = new Set<() => void>();

function emitToasts() {
  for (const l of toastListeners) l();
}

function subscribeToasts(l: () => void) {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
}

function getToasts() {
  return toastList;
}

// Push a menu toast. Confirmations get the confirm cue, errors the error cue;
// pass `sound: 'none'` to stay silent (e.g. when the triggering button already
// played one).
export function toast(
  text: string,
  opts: { tone?: ToastTone; ttl?: number; sound?: UiSoundName | 'none' } = {},
): number {
  const tone = opts.tone ?? 'plain';
  const id = nextToastId++;
  const ttl = opts.ttl ?? (tone === 'err' ? 4200 : 2600);
  toastList = [...toastList.slice(-(MAX_TOASTS - 1)), { id, text, tone, leaving: false }];
  emitToasts();
  const sound = opts.sound ?? (tone === 'err' ? 'uiError' : tone === 'ok' ? 'uiConfirm' : 'none');
  uiSfx(sound);
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id: number) {
  const t = toastList.find((x) => x.id === id);
  if (!t || t.leaving) return;
  if (prefersReducedMotion() || typeof window === 'undefined') {
    toastList = toastList.filter((x) => x.id !== id);
    emitToasts();
    return;
  }
  toastList = toastList.map((x) => (x.id === id ? { ...x, leaving: true } : x));
  emitToasts();
  window.setTimeout(() => {
    toastList = toastList.filter((x) => x.id !== id);
    emitToasts();
  }, TOAST_EXIT_MS);
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}
