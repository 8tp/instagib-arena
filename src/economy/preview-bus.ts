// One live CharacterPreview at a time: while an item-preview modal is open it
// holds the "stage paused" flag, and the Locker's own stage stops its render
// loop (the canvas stays mounted; start() resumes it) until the modal closes.
import { useSyncExternalStore } from 'react';

let holds = 0;
const subs = new Set<() => void>();
const emit = () => {
  for (const f of subs) f();
};

// Pause other stages; returns the release (idempotent).
export function holdStagePause(): () => void {
  holds++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds--;
    emit();
  };
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
const snapshot = () => holds > 0;

export function useStagePaused(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
