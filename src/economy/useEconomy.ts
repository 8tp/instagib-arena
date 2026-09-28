// The economy hub's shared state: your inventory, equipped uids, credits and
// free rolls. One instance lives in the Locker; every tab reads and updates it.
// Server-authoritative — every mutation goes through econ.* and the reply's
// numbers replace ours.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../app-types';
import { toast } from '../deck-core';
import type { ItemInstanceWire, ItemSlot, Loadout } from '../game/items/types';
import { econ, reasonText, type Equipped } from './api';

export type EconStatus = 'loading' | 'ready' | 'error' | 'guest';

export type EconState = {
  status: EconStatus;
  items: ItemInstanceWire[]; // owned + listed (listed are escrowed)
  equipped: Equipped;
  credits: number;
  freeRolls: number;
  entitlements: readonly string[]; // defs equippable without an instance (cards, titles, defaults)
};

export type Econ = EconState & {
  reload: () => void;
  setBalance: (b: { credits?: number; freeRolls?: number }) => void;
  addItem: (it: ItemInstanceWire) => void;
  removeItems: (uids: readonly string[]) => void;
  patchItem: (uid: string, patch: Partial<ItemInstanceWire>) => void;
  // An item went to the market: escrowed items can't stay equipped.
  markListed: (uid: string) => void;
  // token = instance uid, `def:<id>` (default / entitlement) or null (stock default)
  equip: (slot: ItemSlot, token: string | null) => Promise<boolean>;
  salvage: (uids: string[]) => Promise<boolean>;
  busy: string | null;
};

export function useEconomy(
  settings: Settings,
  onChange: (s: Settings) => void,
  loggedIn: boolean,
): Econ {
  const [st, setSt] = useState<EconState>({ status: loggedIn ? 'loading' : 'guest', items: [], equipped: {}, credits: 0, freeRolls: 0, entitlements: [] });
  // One busy key per in-flight action (equip:<slot>, salvage) so they can't clear each other.
  const [busyKeys, setBusyKeys] = useState<readonly string[]>([]);
  const busyAdd = useCallback((k: string) => setBusyKeys((b) => [...b, k]), []);
  const busyDel = useCallback((k: string) => setBusyKeys((b) => { const i = b.indexOf(k); return i < 0 ? b : [...b.slice(0, i), ...b.slice(i + 1)]; }), []);
  const busy = busyKeys.length ? busyKeys[0] : null;
  const wasLoggedIn = useRef(loggedIn);
  const [key, setKey] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const equipSeq = useRef<Partial<Record<ItemSlot, number>>>({});

  // Push the equipped Looks into the live settings (the game reads these):
  // looks + equippedUids, plus the equipped finish INSTANCE (the in-game weapon
  // inspect card and the Strange odometer read `finishItem`).
  const itemsRef = useRef<ItemInstanceWire[]>([]);
  itemsRef.current = st.items;
  const publish = useCallback((equipped: Equipped, looks: Loadout, items: readonly ItemInstanceWire[] = itemsRef.current) => {
    const tok = equipped.finish;
    const finishItem = tok && !tok.startsWith('def:') ? (items.find((i) => i.uid === tok) ?? null) : null;
    onChangeRef.current({ ...settingsRef.current, looks, equippedUids: equipped, finishItem });
  }, []);

  useEffect(() => {
    if (!loggedIn) {
      setSt({ status: 'guest', items: [], equipped: {}, credits: 0, freeRolls: 0, entitlements: [] });
      // Logging out: don't leave the last account's looks / uids in Settings.
      if (wasLoggedIn.current) onChangeRef.current({ ...settingsRef.current, looks: {}, equippedUids: {}, finishItem: null });
      wasLoggedIn.current = false;
      return;
    }
    wasLoggedIn.current = true;
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
      setSt({ status: 'ready', items: r.items, equipped: r.equipped ?? {}, credits: r.credits, freeRolls: r.freeRolls, entitlements: r.entitlements ?? [] });
      // Bring the live settings in line with the server's equipped Looks.
      const looks: Loadout = r.looks ?? {};
      const cur = settingsRef.current;
      const fTok = (r.equipped ?? {}).finish;
      const fItem = fTok && !fTok.startsWith('def:') ? (r.items.find((i) => i.uid === fTok) ?? null) : null;
      if (
        JSON.stringify(cur.equippedUids ?? {}) !== JSON.stringify(r.equipped ?? {}) ||
        JSON.stringify(cur.looks ?? {}) !== JSON.stringify(looks) ||
        JSON.stringify(cur.finishItem ?? null) !== JSON.stringify(fItem)
      ) {
        publish(r.equipped ?? {}, looks, r.items);
      }
    };
    // Only the first load shows skeletons; a reload keeps the current data on screen.
    setSt((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading' }));
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

  // Items that left the loadout (salvaged / listed): fall back to defaults in
  // Settings too, so the game doesn't keep wearing an escrowed item.
  const dropEquipped = useCallback(
    (dropped: ReadonlySet<string>) => {
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
      if (changed) publish(eqUids, looks, itemsRef.current.filter((i) => !dropped.has(i.uid)));
    },
    [publish],
  );
  const markListed = useCallback(
    (uid: string) => {
      setSt((s) => {
        const eq = { ...s.equipped };
        for (const [sl, u] of Object.entries(eq)) if (u === uid) delete eq[sl as ItemSlot];
        return { ...s, equipped: eq, items: s.items.map((i) => (i.uid === uid ? { ...i, state: 'listed' as const } : i)) };
      });
      dropEquipped(new Set([uid]));
    },
    [dropEquipped],
  );

  const equip = useCallback(
    async (slot: ItemSlot, token: string | null): Promise<boolean> => {
      const seq = (equipSeq.current[slot] ?? 0) + 1;
      equipSeq.current[slot] = seq;
      const bk = `equip:${slot}`;
      busyAdd(bk);
      const r = await econ.equip(slot, token);
      busyDel(bk);
      if (equipSeq.current[slot] !== seq) return false; // a newer equip owns the outcome
      if (!r.ok) {
        toast(reasonText(r), { tone: 'err' });
        return false;
      }
      setSt((s) => ({ ...s, equipped: r.equipped }));
      publish(r.equipped, r.looks);
      return true;
    },
    [publish, busyAdd, busyDel],
  );

  const salvage = useCallback(
    async (uids: string[]): Promise<boolean> => {
      busyAdd('salvage');
      const r = await econ.salvage(uids);
      busyDel('salvage');
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
      dropEquipped(dropped);
      return true;
    },
    [dropEquipped, busyAdd, busyDel],
  );

  return { ...st, reload, setBalance, addItem, removeItems, patchItem, markListed, equip, salvage, busy };
}
