// The account's trade / market gate (level 5, 10 recorded matches, 24 h old),
// read from GET /api/trades. null until known — callers treat unknown as open
// and let the server have the final say.
import { useEffect, useState } from 'react';
import { econ, type TradeGate } from './api';

export function useTradeGate(enabled: boolean): TradeGate | null {
  const [gate, setGate] = useState<TradeGate | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void econ.trades().then((r) => {
      if (live && r.ok) setGate(r.gate);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return gate;
}
