// The economy hub's shared state: your inventory, equipped uids, credits and
// free rolls. One instance lives in the Locker; every tab reads and updates it.
// Server-authoritative — every mutation goes through econ.* and the reply's
// numbers replace ours.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../app-types';
import { toast } from '../deck-core';
import type { ItemInstanceWire, ItemSlot, Loadout } from '../game/items/types';
import { econ, reasonText, type Equipped } from './api';
import { instLook } from './display';

export type EconStatus = 'loading' | 'ready' | 'error' | 'guest';

export type EconState = {
  status: EconStatus;
  items: ItemInstanceWire[]; // owned + listed (listed are escrowed)
  equipped: Equipped;
  credits: number;
  freeRolls: number;
};

export type Econ = EconState & {
  reload: () => void;
  setBalance: (b: { credits?: number; freeRolls?: number }) => void;
  addItem: (it: ItemInstanceWire) => void;
  removeItems: (uids: readonly string[]) => void;
  patchItem: (uid: string, patch: Partial<ItemInstanceWire>) => void;
  equip: (slot: ItemSlot, uid: string | null, id?: string) => Promise<boolean>;
  salvage: (uids: string[]) => Promise<boolean>;
  busy: string | null;
};

export function useEconomy(
  settings: Settings,
  onChange: (s: Settings) => void,
  loggedIn: boolean,
): Econ {
  const [st, setSt] = useState<EconState>({ status: loggedIn ? 'loading' : 'guest', items: [], equipped: {}, credits: 0, freeRolls: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const equipSeq = useRef<Partial<Record<ItemSlot, number>>>({});

  // Push the equipped Looks into the live settings (the game reads these).
  const publish = useCallback((equipped: Equipped, looks: Loadout) => {
    onChangeRef.current({ ...settingsRef.current, looks, equippedUids: equipped });
  }, []);

  useEffect(() => {
    if (!loggedIn) {
      setSt({ status: 'guest', items: [], equipped: {}, credits: 0, freeRolls: 0 });
      return;
    }
    let live = true;
    let retry = 0;
    const run = async (attempt: number) => {
      const r = await econ.inventory();
      if (!live) return;
      if (!r.ok) {
        if (attempt < 2) retry = window.setTimeout(() => void run(attempt + 1), 600 * 2 ** attempt);
        else setSt((s) => ({ ...s, status: 'error' }));
        return;
      }
      setSt({ status: 'ready', items: r.items, equipped: r.equipped ?? {}, credits: r.credits, freeRolls: r.freeRolls });
      // Bring the live settings in line with the server's equipped instances.
      const looks: Loadout = {};
      for (const [slot, uid] of Object.entries(r.equipped ?? {})) {
        const it = r.items.find((i) => i.uid === uid);
        if (it) looks[slot as ItemSlot] = instLook(it);
      }
      const cur = settingsRef.current;
      if (JSON.stringify(cur.equippedUids ?? {}) !== JSON.stringify(r.equipped ?? {}) || JSON.stringify(cur.looks ?? {}) !== JSON.stringify(looks)) {
        publish(r.equipped ?? {}, looks);
      }
    };
    setSt((s) => ({ ...s, status: 'loading' }));
    void run(0);
    return () => {
      live = false;
      window.clearTimeout(retry);
    };
  }, [loggedIn, key, publish]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  const setBalance = useCallback((b: { credits?: number; freeRolls?: number }) => {
    setSt((s) => ({ ...s, credits: b.credits ?? s.credits, freeRolls: b.freeRolls ?? s.freeRolls }));
  }, []);
  const addItem = useCallback((it: ItemInstanceWire) => setSt((s) => ({ ...s, items: [...s.items.filter((x) => x.uid !== it.uid), it] })), []);
  const removeItems = useCallback(
    (uids: readonly string[]) => {
      setSt((s) => {
        const drop = new Set(uids);
        const equipped = { ...s.equipped };
        for (const [sl, u] of Object.entries(equipped)) if (u && drop.has(u)) delete equipped[sl as ItemSlot];
        return { ...s, items: s.items.filter((i) => !drop.has(i.uid)), equipped };
      });
    },
    [],
  );
  const patchItem = useCallback((uid: string, patch: Partial<ItemInstanceWire>) => {
    setSt((s) => ({ ...s, items: s.items.map((i) => (i.uid === uid ? { ...i, ...patch } : i)) }));
  }, []);

  const equip = useCallback(
    async (slot: ItemSlot, uid: string | null, id?: string): Promise<boolean> => {
      const seq = (equipSeq.current[slot] ?? 0) + 1;
      equipSeq.current[slot] = seq;
      setBusy(uid ?? id ?? `default:${slot}`);
      const r = await econ.equip(slot, uid, id);
      if (equipSeq.current[slot] !== seq) return false; // a newer equip owns the outcome
      setBusy(null);
      if (!r.ok) {
        toast(reasonText(r), { tone: 'err' });
        return false;
      }
      setSt((s) => ({ ...s, equipped: r.equipped }));
      publish(r.equipped, r.looks);
      return true;
    },
    [publish],
  );

  const salvage = useCallback(
    async (uids: string[]): Promise<boolean> => {
      setBusy('salvage');
      const r = await econ.salvage(uids);
      setBusy(null);
      if (!r.ok) {
        toast(reasonText(r), { tone: 'err' });
        return false;
      }
      const dropped = new Set(r.removed);
      setSt((s) => {
        const eq = { ...s.equipped };
        for (const [sl, u] of Object.entries(eq)) if (u && dropped.has(u)) delete eq[sl as ItemSlot];
        return { ...s, credits: r.credits, items: s.items.filter((i) => !dropped.has(i.uid)), equipped: eq };
      });
      // A salvaged equipped item falls back to the default: keep settings honest.
      const cur = settingsRef.current;
      const looks: Loadout = { ...(cur.looks ?? {}) };
      const eqUids = { ...(cur.equippedUids ?? {}) };
      let changed = false;
      for (const [sl, u] of Object.entries(eqUids)) {
        if (u && dropped.has(u)) {
          delete eqUids[sl as ItemSlot];
          delete looks[sl as ItemSlot];
          changed = true;
        }
      }
      if (changed) publish(eqUids, looks);
      return true;
    },
    [publish],
  );

  return { ...st, reload, setBalance, addItem, removeItems, patchItem, equip, salvage, busy };
}
