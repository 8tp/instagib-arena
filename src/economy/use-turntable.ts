// Turntable intent → strip: asks the thumbnail studio (game/thumbs.ts) for a
// sprite strip once there is intent (hover / keyboard focus held ~150 ms, or
// an explicit "play"). Playback is CSS (turntable.tsx) — no per-frame React.
import { useEffect, useState } from 'react';
import { peekTurntable, requestTurntable, type Turntable } from '../game/thumbs';

const INTENT_MS = 150;

// `key`: cosmetic id or Look key. `want`: hovered / focused / told to play.
// Returns the strip while wanted (null until rendered) and whether one is on
// its way. An unstarted request is dropped when the intent ends.
export function useTurntable(key: string, want: boolean): { sheet: Turntable | null; loading: boolean } {
  const [sheet, setSheet] = useState<Turntable | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!want) {
      setLoading(false);
      return;
    }
    const hit = peekTurntable(key);
    if (hit) {
      setSheet(hit);
      return;
    }
    setSheet(null);
    let live = true;
    let release: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      const req = requestTurntable(key);
      release = req.release;
      setLoading(true);
      void req.promise.then((t) => {
        if (!live) return;
        setLoading(false);
        if (t) setSheet(t);
      });
    }, INTENT_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      release?.();
    };
  }, [key, want]);
  return { sheet: want && sheet ? sheet : null, loading: want && loading };
}
