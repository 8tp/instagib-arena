import { useEffect, useState } from 'react';

// Live concurrency for the "N playing now" social-proof readout. Polled gently
// (20s) — it makes an empty alpha feel alive and tells returning players the
// game has a pulse. Fails closed (null) if the API is unreachable.
export type LiveCounts = { online: number; inMatch: number; rooms: number };

export function useLiveCount(): LiveCounts | null {
  const [counts, setCounts] = useState<LiveCounts | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () =>
      fetch('/api/live', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: LiveCounts | null) => {
          if (active && d && typeof d.online === 'number') setCounts(d);
        })
        .catch(() => {});
    poll();
    const id = window.setInterval(poll, 20_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);
  return counts;
}
