// Keyboard + dismissal model shared by the admin listboxes (Select,
// PlayerPicker, ItemPicker).
//   useListNav — active-descendant navigation (↑ ↓ Home End PgUp PgDn Enter Esc)
//   useDismiss — close a popover on an outside pointer-down
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [ref, open, close]);
}

// Active-descendant navigation over `count` rows. `isDisabled` skips rows.
export function useListNav(count: number, opts: { onPick: (i: number) => void; onEscape?: () => void; isDisabled?: (i: number) => boolean; listId: string }) {
  const [active, setActive] = useState(-1);
  const clampActive = active >= count ? count - 1 : active;
  const move = (from: number, dir: 1 | -1, steps = 1) => {
    if (count === 0) return -1;
    let i = from;
    let left = steps;
    for (let guard = 0; guard < count * 2 && left > 0; guard++) {
      const next = i + dir;
      if (next < 0 || next >= count) break;
      i = next;
      if (!opts.isDisabled?.(i)) left--;
    }
    return opts.isDisabled?.(i) ? from : i;
  };
  useEffect(() => {
    if (clampActive < 0) return;
    document.getElementById(`${opts.listId}-o${clampActive}`)?.scrollIntoView({ block: 'nearest' });
  }, [clampActive, opts.listId]);
  const onKeyDown = (e: KeyboardEvent): boolean => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => move(a < 0 ? -1 : Math.min(a, count - 1), 1));
        return true;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => move(a < 0 ? count : Math.min(a, count), -1));
        return true;
      case 'PageDown':
        e.preventDefault();
        setActive((a) => move(Math.max(-1, a), 1, 8));
        return true;
      case 'PageUp':
        e.preventDefault();
        setActive((a) => move(a < 0 ? count : a, -1, 8));
        return true;
      case 'Home':
        if (e.currentTarget instanceof HTMLInputElement && e.currentTarget.value) return false;
        e.preventDefault();
        setActive(move(-1, 1));
        return true;
      case 'End':
        if (e.currentTarget instanceof HTMLInputElement && e.currentTarget.value) return false;
        e.preventDefault();
        setActive(move(count, -1));
        return true;
      case 'Enter':
        if (clampActive >= 0 && !opts.isDisabled?.(clampActive)) {
          e.preventDefault();
          opts.onPick(clampActive);
          return true;
        }
        return false;
      case 'Escape':
        if (opts.onEscape) {
          e.preventDefault();
          e.stopPropagation();
          opts.onEscape();
          return true;
        }
        return false;
      default:
        return false;
    }
  };
  const optId = (i: number) => `${opts.listId}-o${i}`;
  return { active: clampActive, setActive, onKeyDown, optId, activeId: clampActive >= 0 ? optId(clampActive) : undefined };
}
