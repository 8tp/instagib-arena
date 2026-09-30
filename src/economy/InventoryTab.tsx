// Inventory: the TF2/Fortnite backpack. Left: the live 3D stage wearing your
// loadout (hover / select an item to try it on, with its real Look — unusual
// effect and all). Middle: the loadout rail. Right: owned INSTANCES of the
// open slot (each its own tile: tier, quality marks, mint #), plus the level
// unlocked player-card collection, and the details / actions dock.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { SegButton, Skeleton } from '../deck';
import { sfxProps, toast, uiHover, uiSfx } from '../deck-core';
import { cosmeticById, nameColorById, sourceLabel, titleById } from '../game/cosmetics';
import { DEFAULT_LOADOUT, ITEM_DEFS, itemDef } from '../game/items/catalog';
import { TIER_META, strangeRank, STRANGE_RANKS, QUALITY_LABEL, type ItemInstanceWire, type ItemSlot, type Loadout } from '../game/items/types';
import { prefetchThumbnails } from '../game/thumbs';
import { LockerStage, type StageNameplate } from '../locker/LockerStage';
import { DyeSwatch, ItemTile } from '../ui/item-tile';
import { PlayerCard, CardStatsEditor } from '../ui/player-card';
import { buildCardPayload, rankedStandingText } from '../ui/player-card-data';
import { TIER_COLOR } from '../ui/rarity';
import {
  ORIGIN_LABEL,
  SLOT_LABEL,
  compareInst,
  defSeason,
  fmtCredits,
  instBaseName,
  instBlurb,
  instFullName,
  instLook,
  instSlot,
  instTags,
  instTier,
  salvageValue,
} from './display';
import { ItemPreviewModal } from './ItemPreviewModal';
import { DefTile, InstTile, TagPills, TierChip, type Entry } from './parts';
import { canPreview, previewOfDef, previewOfInst, type PreviewItem } from './preview-item';
import { ALL_SLOTS, SLOT_GROUPS, SLOT_VIEW, previewCosmetics } from './slots';
import { loadSeen, saveSeen } from './seen';
import type { Econ } from './useEconomy';

const FOCUSABLE_TILE = '[data-tile]';

// Arrow-key roving focus across a grid of [data-tile] buttons.
function onTileArrows(e: ReactKeyboardEvent<HTMLElement>) {
  const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2, Home: -9, End: 9 };
  if (!(e.key in map)) return;
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_TILE)];
  const i = tiles.indexOf(document.activeElement as HTMLElement);
  if (i < 0 || tiles.length === 0) return;
  const top0 = tiles[0].getBoundingClientRect().top;
  let cols = tiles.findIndex((t) => Math.abs(t.getBoundingClientRect().top - top0) > 4);
  if (cols <= 0) cols = tiles.length;
  const d = map[e.key];
  let j = i;
  if (d === -1 || d === 1) j = i + d;
  else if (d === -2) j = i - cols;
  else if (d === 2) j = i + cols;
  else j = d < 0 ? 0 : tiles.length - 1;
  if (j < 0 || j >= tiles.length) return;
  e.preventDefault();
  tiles[j].focus();
}

type Sort = 'rarity' | 'newest' | 'name';

// Slots' entries: the virtual default, your instances, and the entitlement
// collection (level-unlocked cards, earned titles, staff extras): owned ones,
// plus — for cards and titles — the locked ones with how to get them.
const COLLECTION_SLOTS: readonly ItemSlot[] = ['card', 'title'];
function buildEntries(slot: ItemSlot, items: readonly ItemInstanceWire[], ent: ReadonlySet<string>): Entry[] {
  const out: Entry[] = [];
  const dflt = itemDef(DEFAULT_LOADOUT[slot]);
  if (dflt) out.push({ key: `def:${dflt.id}`, slot, def: dflt });
  const coll: Entry[] = [];
  for (const def of ITEM_DEFS) {
    if (def.slot !== slot || def.id === DEFAULT_LOADOUT[slot]) continue;
    const owned = ent.has(def.id);
    if (!owned && !COLLECTION_SLOTS.includes(slot)) continue;
    const src = cosmeticById(def.id)?.source;
    if (!owned && (!src || src.type === 'admin' || src.type === 'default')) continue;
    coll.push({
      key: `def:${def.id}`,
      slot,
      def,
      locked: !owned,
      lockNote: !owned && src ? (src.type === 'level' ? `Lv ${src.level}` : sourceLabel(src)) : undefined,
    });
  }
  coll.sort((a, b) => Number(a.locked ?? false) - Number(b.locked ?? false) || levelNeed(a) - levelNeed(b) || a.def.name.localeCompare(b.def.name));
  out.push(...coll);
  for (const i of items.filter((x) => instSlot(x) === slot)) {
    const def = itemDef(i.def);
    if (def) out.push({ key: i.uid, slot, def, inst: i });
  }
  return out;
}
const isDefaultEntry = (e: Entry): boolean => !e.inst && e.def.id === DEFAULT_LOADOUT[e.slot];
function levelNeed(e: Entry): number {
  const s = cosmeticById(e.def.id)?.source;
  return s?.type === 'level' ? s.level : 0;
}

export function InventoryTab({
  settings,
  onChange,
  econ,
  account,
  profile,
  narrow,
  reduced,
  onSell,
  onTrade,
  onViewListings,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  econ: Econ;
  account?: Account;
  profile: InstagibProfile | null;
  narrow: boolean;
  reduced: boolean;
  onSell: (uid: string) => void;
  onTrade: (uid: string) => void;
  onViewListings: () => void;
}) {
  const [slot, setSlotState] = useState<ItemSlot>('hat');
  const [selected, setSelected] = useState<string | null>(null); // Entry.key
  const [hover, setHover] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('rarity');
  const [tradableOnly, setTradableOnly] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null); // uid awaiting salvage confirm
  const [pulseKey, setPulseKey] = useState(0);
  const [replayKey, setReplayKey] = useState(0);
  const [stamp, setStamp] = useState(0);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [newUids, setNewUids] = useState<ReadonlySet<string>>(() => new Set());
  const seenRef = useRef<Set<string> | null>(null);
  const owner = account?.username ?? 'guest';
  const level = profile?.level ?? null;
  const loading = econ.status === 'loading';

  // NEW badges: instances not seen before (first visit baselines everything).
  useEffect(() => {
    if (econ.status !== 'ready') return;
    let seen = loadSeen(owner);
    if (!seen) {
      seen = new Set(econ.items.map((i) => i.uid));
      saveSeen(owner, seen);
    }
    seenRef.current = seen;
    setNewUids(new Set(econ.items.filter((i) => !seen!.has(i.uid)).map((i) => i.uid)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [econ.status, econ.items.length, owner]);
  const newRef = useRef(newUids);
  newRef.current = newUids;
  const markSeen = useCallback(
    (uid: string) => {
      if (!newRef.current.has(uid)) return;
      setNewUids((cur) => {
        const n = new Set(cur);
        n.delete(uid);
        return n;
      });
      const seen = seenRef.current ?? new Set<string>();
      seen.add(uid);
      seenRef.current = seen;
      saveSeen(owner, seen);
    },
    [owner],
  );

  const entSet = useMemo(() => new Set(econ.entitlements), [econ.entitlements]);
  const entries = useMemo(() => buildEntries(slot, econ.items, entSet), [slot, econ.items, entSet]);
  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    const rank = (e: Entry) => (e.inst ? TIER_META[instTier(e.inst)].rank : TIER_META[e.def.tier].rank);
    const list = entries.filter((e) => {
      if (isDefaultEntry(e)) return true; // the default tile is always there
      if (tradableOnly && !(e.inst?.tradable && e.inst.state === 'owned')) return false;
      if (text && !(e.inst ? instFullName(e.inst) : e.def.name).toLowerCase().includes(text)) return false;
      return true;
    });
    const head = list.filter(isDefaultEntry);
    const insts = list.filter((e) => e.inst).sort((a, b) => (sort === 'newest' ? b.inst!.createdAt - a.inst!.createdAt : sort === 'name' ? instBaseName(a.inst!).localeCompare(instBaseName(b.inst!)) || a.inst!.mint - b.inst!.mint : compareInst(a.inst!, b.inst!)));
    const coll = list.filter((e) => !e.inst && !isDefaultEntry(e)).sort((a, b) => (sort === 'rarity' ? rank(b) - rank(a) : 0));
    return { head, insts, coll };
  }, [entries, q, sort, tradableOnly]);
  const flat = useMemo(() => [...shown.head, ...shown.insts, ...shown.coll], [shown]);

  const equippedKey = useCallback(
    (e: Entry): boolean => {
      const eq = econ.equipped[e.slot]; // instance uid, `def:<id>`, or unset (→ stock default)
      if (e.inst) return eq === e.inst.uid;
      if (e.def.id === DEFAULT_LOADOUT[e.slot]) return !eq || eq === `def:${e.def.id}`;
      return eq === `def:${e.def.id}`;
    },
    [econ.equipped],
  );

  const sel = flat.find((e) => e.key === selected) ?? flat.find((e) => equippedKey(e)) ?? flat[0] ?? null;
  const hovered = hover ? (flat.find((e) => e.key === hover) ?? null) : null;
  const shownEntry = hovered ?? sel;

  // Warm thumbnails for the slot (rail equipped first).
  useEffect(() => {
    const keys = ALL_SLOTS.map((s) => settings.looks?.[s]?.d).filter((x): x is string => !!x);
    prefetchThumbnails(keys);
  }, [settings.looks]);
  useEffect(() => {
    prefetchThumbnails(flat.map((e) => e.def.id), true);
  }, [flat]);

  const setSlot = (s: ItemSlot) => {
    if (s === slot) {
      setReplayKey((k) => k + 1);
      return;
    }
    uiSfx('tabSwitch');
    setSlotState(s);
    setSelected(null);
    setHover(null);
    setConfirm(null);
  };

  // ── Preview ──────────────────────────────────────────────────────────────
  const baseLooks: Loadout = useMemo(() => settings.looks ?? {}, [settings.looks]);
  const tryLook = shownEntry ? (shownEntry.inst ? instLook(shownEntry.inst) : shownEntry.def.default ? null : { d: shownEntry.def.id }) : null;
  // An Anomalous hat (tried on, or the one you wear) needs the taller crown framing.
  const hatFx = shownEntry ? tryLook?.e : baseLooks.hat?.e;
  const previewView = slot === 'hat' && hatFx ? 'crown' : SLOT_VIEW[slot];
  const tryKey = shownEntry ? `${shownEntry.key}|${shownEntry.slot}` : '';
  // The gun on the stage carries its Tracked counter: the finish being tried on,
  // else the equipped one.
  const finishInst = shownEntry?.slot === 'finish' ? (shownEntry.inst ?? null) : (settings.finishItem ?? null);
  const trackedKills = finishInst?.quality.includes('strange') ? (finishInst.attrs.kills ?? 0) : null;
  const cos = useMemo(
    () => ({ ...previewCosmetics(baseLooks, shownEntry ? { slot: shownEntry.slot, look: tryLook } : null, previewView, settings), trackedKills }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseLooks, tryKey, previewView, settings.playerName, settings.reducedEffects, trackedKills],
  );

  const titleText = (id: string) => {
    const t = titleById(id);
    return t.dynamic === 'ranked' ? rankedStandingText(profile?.ranked ?? null) || 'Unranked' : t.text;
  };
  const lookD = (s: ItemSlot) => (slot === s && tryLook ? tryLook.d : (baseLooks[s]?.d ?? DEFAULT_LOADOUT[s]));
  const nameplate = useMemo<StageNameplate | null>(
    () =>
      slot === 'title' || slot === 'nameColor'
        ? {
            name: settings.playerName || 'Player',
            color: nameColorById(slot === 'nameColor' && shownEntry ? (tryLook?.d ?? DEFAULT_LOADOUT.nameColor) : (baseLooks.nameColor?.d ?? DEFAULT_LOADOUT.nameColor)).color,
            title: titleText(slot === 'title' && shownEntry ? (tryLook?.d ?? DEFAULT_LOADOUT.title) : (baseLooks.title?.d ?? DEFAULT_LOADOUT.title)),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot, tryKey, settings.playerName, baseLooks, profile],
  );
  const tint = TIER_COLOR[shownEntry ? (shownEntry.inst ? instTier(shownEntry.inst) : shownEntry.def.tier) : 'common'].edge;
  const offsetX = narrow ? 0 : slot === 'card' ? 0.24 : slot === 'finish' || slot === 'beam' ? 0.02 : 0;
  const offsetY = SLOT_VIEW[slot] === 'weapon' ? (narrow ? -0.04 : -0.1) : 0;
  const cardPayload =
    slot === 'card'
      ? profile?.stats
        ? buildCardPayload(profile, { ...settings, card: lookD('card') }, account)
        : { name: settings.playerName || 'Player', level: level ?? 1, style: lookD('card'), stats: [], title: titleText(lookD('title')), verified: !!account?.isVerified, admin: !!account?.isAdmin }
      : null;

  // ── Actions ──────────────────────────────────────────────────────────────
  const doEquip = async (e: Entry) => {
    if (e.inst) markSeen(e.inst.uid);
    const ok = await econ.equip(e.slot, e.inst ? e.inst.uid : e.def.id === DEFAULT_LOADOUT[e.slot] ? null : `def:${e.def.id}`);
    if (ok) {
      setStamp(Date.now());
      setPulseKey((k) => k + 1);
      toast(`Equipped · ${e.inst ? instFullName(e.inst) : e.def.name}`, { tone: 'ok', sound: 'equip' });
    }
  };
  const doSalvage = async (i: ItemInstanceWire) => {
    const gain = salvageValue(i);
    const ok = await econ.salvage([i.uid]);
    setConfirm(null);
    if (ok) {
      setSelected(null);
      toast(`Salvaged · +${fmtCredits(gain)}`, { tone: 'ok', sound: 'purchase' });
    }
  };

  const onPickRef = useRef<(e: Entry) => void>(() => {});
  const onPickInstRef = useRef<(i: ItemInstanceWire) => void>(() => {});
  const onPick = useCallback((e: Entry) => onPickRef.current(e), []);
  const onPickInst = useCallback((i: ItemInstanceWire) => onPickInstRef.current(i), []);
  const onHoverEntry = useCallback((e: Entry) => setHover(e.key), []);
  const onHoverInst = useCallback(
    (i: ItemInstanceWire) => {
      setHover(i.uid);
      markSeen(i.uid);
    },
    [markSeen],
  );
  const onPickSlot = useCallback((s: ItemSlot) => setSlotRef.current(s), []);
  const setSlotRef = useRef(setSlot);
  setSlotRef.current = setSlot;
  onPickRef.current = (e) => {
    uiSfx('uiClick');
    setSelected(e.key);
    setConfirm(null);
  };
  onPickInstRef.current = (i) => {
    markSeen(i.uid);
    const e = flat.find((x) => x.key === i.uid);
    if (!e) return;
    // Click the selected, unequipped instance again to equip it.
    if (sel?.key === e.key && !equippedKey(e) && i.state === 'owned' && !econ.busy) void doEquip(e);
    else onPickRef.current(e);
  };

  const equippedFor = (s: ItemSlot): { id: string; inst?: ItemInstanceWire } => {
    const uid = econ.equipped[s];
    const inst = uid ? econ.items.find((i) => i.uid === uid) : undefined;
    return { id: inst?.def ?? baseLooks[s]?.d ?? DEFAULT_LOADOUT[s], inst };
  };

  const noun = SLOT_LABEL[slot];
  const ownedCount = shown.insts.length;

  const details = (
    <Details
      entry={sel}
      loading={loading}
      equipped={sel ? equippedKey(sel) : false}
      busy={!!econ.busy}
      level={level}
      stampKey={stamp}
      confirm={confirm}
      setConfirm={setConfirm}
      onEquip={(e) => void doEquip(e)}
      onSalvage={(i) => void doSalvage(i)}
      onSell={onSell}
      onTrade={onTrade}
      onViewListings={onViewListings}
      onPreview={(e) => setPreview(e.inst ? previewOfInst(e.inst) : previewOfDef(e.def.id))}
      guest={econ.status === 'guest'}
    />
  );

  return (
    <div className='lk-body ec-inv'>
      <LockerStage
        cos={cos}
        lowSpec={settings.lowSpec}
        offsetX={offsetX}
        offsetY={offsetY}
        tint={tint}
        nameplate={nameplate}
        pulseKey={pulseKey}
        replayKey={replayKey}
        watermark={SLOT_VIEW[slot] !== 'identity' && slot !== 'card' ? SLOT_LABEL[slot] : null}
      >
        {hovered && hovered.key !== sel?.key && (
          <div className='lk-tryon'>
            Trying on
            <span style={{ color: TIER_COLOR[hovered.inst ? instTier(hovered.inst) : hovered.def.tier].edge }}>
              {hovered.inst ? instFullName(hovered.inst) : hovered.def.name}
            </span>
          </div>
        )}
        {cardPayload && (
          <div className='lk-card-show' style={{ transform: narrow ? 'scale(0.9)' : 'scale(1.12)' }}>
            <PlayerCard card={cardPayload} reduced={settings.reducedEffects || reduced} />
          </div>
        )}
      </LockerStage>
      {narrow && details}

      <nav className='lk-rail' aria-label='Loadout slots' onKeyDown={onTileArrows}>
        {SLOT_GROUPS.map((g) => (
          <div key={g.id} className='lk-group'>
            <div className='lk-group-label'>{g.label}</div>
            <div className='lk-rail-grid'>
              {g.slots.map((s) => (
                <RailTile
                  key={s}
                  slot={s}
                  eq={equippedFor(s)}
                  active={slot === s}
                  hasNew={econ.items.some((i) => newUids.has(i.uid) && instSlot(i) === s)}
                  onPick={onPickSlot}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <section className='lk-main' aria-label={`${noun} items`}>
        <div className='lk-main-head'>
          <div>
            <h3 className='lk-slot-title'>{noun}</h3>
            <div className='lk-count'>
              {loading
                ? 'Loading…'
                : econ.status === 'error'
                  ? 'Not loaded'
                  : econ.status === 'guest' && slot !== 'card'
                    ? 'Log in to collect items'
                    : slot === 'card'
                      ? `${shown.coll.filter((e) => !e.locked).length + 1} / ${shown.coll.length + 1} cards unlocked`
                      : `${ownedCount} item${ownedCount === 1 ? '' : 's'}${shown.coll.length ? ` · ${shown.coll.filter((e) => !e.locked).length} unlocked extras` : ''}`}
            </div>
          </div>
          <div className='ec-filters'>
            <input
              className='ec-input w-[150px]'
              type='search'
              placeholder='Search…'
              aria-label='Search this slot'
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className='flex gap-1' role='group' aria-label='Sort'>
              <SegButton active={sort === 'rarity'} onClick={() => setSort('rarity')}>Rarity</SegButton>
              <SegButton active={sort === 'newest'} onClick={() => setSort('newest')}>Newest</SegButton>
              <SegButton active={sort === 'name'} onClick={() => setSort('name')}>A–Z</SegButton>
            </div>
            <SegButton active={tradableOnly} onClick={() => setTradableOnly((v) => !v)}>Tradable</SegButton>
          </div>
        </div>
        <div className='lk-scroll deck-scroll'>
          {econ.status === 'error' && (
            <div className='lk-empty'>
              Couldn&rsquo;t load your inventory.{' '}
              <button type='button' className='underline underline-offset-2 hover:text-white' onClick={econ.reload}>
                Try again
              </button>
            </div>
          )}
          {econ.status !== 'error' && (
            <div className='lk-grid' role='listbox' aria-label={`${noun} items`} aria-busy={loading} onKeyDown={onTileArrows} onPointerLeave={() => setHover(null)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null); }}>
              {loading
                ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className='aspect-square w-full' />)
                : [...shown.head, ...shown.insts].map((e, idx) =>
                    e.inst ? (
                      <InstTile
                        key={e.key}
                        inst={e.inst}
                        selected={sel?.key === e.key}
                        equipped={equippedKey(e)}
                        isNew={newUids.has(e.inst.uid)}
                        tabbable={sel?.key === e.key || (!sel && idx === 0)}
                        price={e.inst.state === 'listed' ? <ListedChip /> : undefined}
                        onPick={onPickInst}
                        onHover={onHoverInst}
                        spin={!reduced}
                        rootProps={{ role: 'option', 'aria-selected': sel?.key === e.key, 'data-state': equippedKey(e) ? 'equipped' : e.inst.state }}
                      />
                    ) : (
                      <DefTile key={e.key} entry={e} selected={sel?.key === e.key} equipped={equippedKey(e)} tabbable={sel?.key === e.key || (!sel && idx === 0)} onPick={onPick} onHover={onHoverEntry} spin={!reduced} />
                    ),
                  )}
            </div>
          )}
          {!loading && econ.status === 'ready' && shown.insts.length === 0 && slot !== 'card' && (
            <div className='lk-empty'>
              {q || tradableOnly ? 'Nothing matches.' : `No ${noun.toLowerCase()} items yet — open a case or check the market.`}
            </div>
          )}
          {shown.coll.length > 0 && (
            <>
              <h4 className='ec-section'>{slot === 'card' ? 'Cards' : 'Collection'} <small>{slot === 'card' ? 'unlocked by Career level — not tradable' : 'unlocked / earned — not tradable'}</small></h4>
              <div className='lk-grid' role='listbox' aria-label='Level-unlocked cards' onKeyDown={onTileArrows} onPointerLeave={() => setHover(null)}>
                {shown.coll.map((e) => (
                  <DefTile key={e.key} entry={e} selected={sel?.key === e.key} equipped={equippedKey(e)} tabbable={false} onPick={onPick} onHover={onHoverEntry} spin={!reduced} />
                ))}
              </div>
            </>
          )}
          {slot === 'card' && (
            <div className='mt-6 max-w-[520px] font-mono'>
              <CardStatsEditor settings={settings} onChange={onChange} account={account} profile={econ.status === 'loading' ? undefined : profile?.stats ? profile : null} showPreview={false} />
            </div>
          )}
        </div>
        {!narrow && details}
      </section>
      {preview && <ItemPreviewModal item={preview} settings={settings} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ListedChip() {
  return (
    <span className='inline-flex bg-black/60 px-[5px] py-[3px] font-display text-[12px] font-bold leading-none text-amber-300'>Listed</span>
  );
}

const RailTile = memo(function RailTile({
  slot,
  eq,
  active,
  hasNew,
  onPick,
}: {
  slot: ItemSlot;
  eq: { id: string; inst?: ItemInstanceWire };
  active: boolean;
  hasNew: boolean;
  onPick: (s: ItemSlot) => void;
}) {
  const inst = eq.inst;
  return (
    <div className='lk-rail-cell'>
      <ItemTile
        id={eq.id}
        fluid
        tier={inst ? instTier(inst) : undefined}
        name={inst ? instBaseName(inst) : undefined}
        look={inst ? (instLook(inst).e ? { d: inst.def, e: instLook(inst).e } : undefined) : undefined}
        // A worn dye reads small on a rail-sized body: its paint chip in the corner too.
        badge={slot === 'dye' && eq.id !== DEFAULT_LOADOUT.dye ? <DyeSwatch id={eq.id} size={16} /> : undefined}
        selected={active}
        dot={hasNew}
        tabIndex={active ? 0 : -1}
        onClick={() => onPick(slot)}
        onPointerEnter={uiHover}
        rootProps={{
          'data-tile': '',
          'data-slot': slot,
          title: SLOT_LABEL[slot],
          'aria-label': `${SLOT_LABEL[slot]}: ${inst ? instFullName(inst) : (itemDef(eq.id)?.name ?? eq.id)}${hasNew ? ', new items' : ''}`,
        }}
      />
    </div>
  );
});

// ── Details / actions dock ──────────────────────────────────────────────────

function Details({
  entry,
  loading,
  equipped,
  busy,
  level,
  stampKey,
  confirm,
  setConfirm,
  onEquip,
  onSalvage,
  onSell,
  onTrade,
  onViewListings,
  onPreview,
  guest,
}: {
  entry: Entry | null;
  loading: boolean;
  equipped: boolean;
  busy: boolean;
  level: number | null;
  stampKey: number;
  confirm: string | null;
  setConfirm: (uid: string | null) => void;
  onEquip: (e: Entry) => void;
  onSalvage: (i: ItemInstanceWire) => void;
  onSell: (uid: string) => void;
  onTrade: (uid: string) => void;
  onViewListings: () => void;
  onPreview: (e: Entry) => void;
  guest: boolean;
}) {
  if (loading || !entry) {
    return (
      <div className='lk-details' aria-live='polite'>
        <div className='lk-details-info'>{loading ? <Skeleton className='h-16 w-72' /> : <span className='text-white/45'>{guest ? 'Log in to collect items.' : 'Nothing selected.'}</span>}</div>
      </div>
    );
  }
  const inst = entry.inst;
  const tier = inst ? instTier(inst) : entry.def.tier;
  const c = TIER_COLOR[tier];
  const name = inst ? instFullName(inst) : entry.def.name;
  const tags = inst ? instTags(inst) : [];
  const listed = inst?.state === 'listed';
  const gain = inst ? salvageValue(inst) : 0;
  const cardNeed = entry.locked ? levelNeed(entry) : 0;
  const season = defSeason(entry.def.id);
  return (
    <div className='lk-details' style={{ ['--rc' as string]: c.edge }} aria-live='polite' data-uid={inst?.uid}>
      <div className='lk-details-info'>
        <div className='flex flex-wrap items-center gap-2'>
          <TierChip tier={tier} />
          <span className='lk-chip text-white/55' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>{SLOT_LABEL[entry.slot]}</span>
          {inst && <span className='lk-chip font-mono text-white/70' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>Mint #{inst.mint}</span>}
          {season && !entry.def.default && (
            <span className='lk-chip ec-season-chip' title={season.title ? `${season.name} · ${season.title}` : season.name}>
              {season.name}
            </span>
          )}
          {inst && !inst.tradable && <span className='lk-chip text-white/55' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>Bound</span>}
        </div>
        <div className='lk-name' style={{ color: c.text }}>{name}</div>
        <TagPills tags={tags} />
        <p className='lk-blurb'>{inst ? instBlurb(inst) : entry.def.blurb}</p>
        {inst && <InstFacts inst={inst} />}
        {entry.locked && (
          <div className='lk-unlock'>
            <span>Unlocks at Career level {cardNeed || '—'}{level != null && cardNeed ? <span className='text-white/45'> · you’re level {level}</span> : null}</span>
            {level != null && cardNeed > 0 && (
              <div className='lk-bar' aria-hidden><i style={{ width: `${Math.round(Math.min(1, level / cardNeed) * 100)}%` }} /></div>
            )}
          </div>
        )}
      </div>
      <div className='lk-details-action'>
        {equipped ? (
          <span key={stampKey} className={`lk-action lk-action-done ${stampKey ? 'lk-stamp' : ''}`} role='status'>✓ Equipped</span>
        ) : entry.locked ? (
          <span className='lk-action lk-action-muted' aria-disabled>Locked</span>
        ) : listed ? (
          <button type='button' className='lk-action lk-action-muted' onClick={onViewListings} {...sfxProps('uiClick')}>Listed · view</button>
        ) : (
          <button type='button' className='lk-action lk-action-equip' data-action='equip' disabled={busy} onClick={() => onEquip(entry)} {...sfxProps('none')}>
            {busy ? 'Equipping…' : 'Equip'}
          </button>
        )}
        {canPreview(entry.def.id) && (
          <button type='button' className='lk-action lk-action-ghost' data-action='preview' onClick={() => onPreview(entry)} {...sfxProps('uiClick')} title='Open a live 3D preview on your character'>
            <EyeGlyph /> Preview
          </button>
        )}
        {inst && inst.state === 'owned' && (
          <div className='ec-actions'>
            {inst.tradable && (
              <>
                <button type='button' className='ec-btn' data-action='sell' onClick={() => onSell(inst.uid)} {...sfxProps('uiClick')}>List on market</button>
                <button type='button' className='ec-btn' data-action='trade' onClick={() => onTrade(inst.uid)} {...sfxProps('uiClick')}>Add to trade</button>
              </>
            )}
            {confirm === inst.uid ? (
              <span className='ec-confirm' role='alertdialog' aria-label='Confirm salvage'>
                <span>
                  Salvage{inst.quality.includes('unusual') || TIER_META[tier].rank >= 3 ? ` this ${TIER_META[tier].label}${inst.quality.includes('unusual') ? ` ${QUALITY_LABEL.unusual}` : ''}` : ''} for {fmtCredits(gain)}? Can’t be undone.
                </span>
                <button type='button' className='ec-btn ec-btn-danger' data-action='salvage-confirm' disabled={busy} onClick={() => onSalvage(inst)}>Salvage · {fmtCredits(gain)}</button>
                <button type='button' className='ec-btn' onClick={() => setConfirm(null)}>Cancel</button>
              </span>
            ) : (
              <button type='button' className='ec-btn ec-btn-danger' data-action='salvage' onClick={() => setConfirm(inst.uid)} {...sfxProps('uiClick')}>Salvage · {fmtCredits(gain)}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg width={18} height={18} viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinejoin='round'>
      <path d='M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' />
      <circle cx='12' cy='12' r='3' />
    </svg>
  );
}

// Provenance-ish facts: origin, minted date, Tracked progress, pattern seed.
function InstFacts({ inst }: { inst: ItemInstanceWire }) {
  const a = inst.attrs;
  const rows: [string, string][] = [
    ['Origin', ORIGIN_LABEL[inst.origin]],
    ['Minted', new Date(inst.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })],
  ];
  if (a.seed != null) rows.push(['Pattern seed', String(a.seed)]);
  if (a.nameTag) rows.push(['Name tag', `“${a.nameTag}”`]);
  rows.push(['Trade', inst.tradable ? 'Tradable' : 'Bound to your account']);
  const strange = inst.quality.includes('strange');
  const kills = a.kills ?? 0;
  const next = STRANGE_RANKS.find((r) => r.kills > kills);
  const cur = [...STRANGE_RANKS].reverse().find((r) => kills >= r.kills);
  return (
    <div className='ec-facts'>
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
      {strange && (
        <div className='ec-facts-wide'>
          <span>{QUALITY_LABEL.strange}</span>
          <b>
            {strangeRank(kills)} · {kills.toLocaleString()} kills{next ? ` · ${(next.kills - kills).toLocaleString()} to ${next.name}` : ' · top rank'}
          </b>
          {next && cur && (
            <div className='lk-bar mt-1.5' aria-hidden>
              <i style={{ width: `${Math.round(((kills - cur.kills) / Math.max(1, next.kills - cur.kills)) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

