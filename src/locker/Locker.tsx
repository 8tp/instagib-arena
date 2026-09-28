// The Locker: a full-screen, Fortnite-style loadout screen. Left: a big live
// 3D stage of YOUR combatant, framed for the slot you're browsing, with the
// selected item's details. Middle: the loadout rail (one tile per slot, grouped).
// Right: the slot's rarity grid — hover or focus to try an item on (never
// equips), click to select, click again / Equip to wear it, Buy for credits.
// Server-backed (profile / equip / buy / hat case); degrades to local-only
// selection with everything equippable when there's no backend.
import './locker.css';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { SegButton, Skeleton } from '../deck';
import { MODAL_EXIT_MS, prefersReducedMotion, sfxProps, toast, uiHover, uiSfx, useModalStack } from '../deck-core';
import type { PreviewCosmetics } from '../game/character-preview';
import {
  HAT_CASE_COST,
  cosmeticById,
  nameColorById,
  titleById,
  type CosmeticSource,
  type KillEffectStyle,
  type Rarity,
} from '../game/cosmetics';
import { prefetchThumbnails } from '../game/thumbs';
import { ItemTile, LevelBadge } from '../ui/item-tile';
import { CardStatsEditor, PlayerCard } from '../ui/player-card';
import { buildCardPayload, rankedStandingText } from '../ui/player-card-data';
import { RARITY_COLOR, RARITY_LABEL } from '../ui/rarity';
import { CaseSpinner, HatCaseCard, type CaseWin } from './CaseSpinner';
import { LockerStage, type StageNameplate } from './LockerStage';
import {
  ALL_SLOTS,
  SLOT_DEFS,
  SLOT_GROUPS,
  casePool,
  credits as fmtCredits,
  loadSeen,
  saveSeen,
  slotOfItem,
  sortItems,
  unlockInfo,
  type LockerItem,
  type LockerSlot,
} from './slots';

type LockerProfile = {
  unlocked: string[];
  credits: number;
  equipped: Record<string, string>;
  level: number;
  caseKeys: number; // free case keys (progression track; 0 on older servers)
  raw: InstagibProfile;
};

// POST /api/shop/open-case. Finalized: `won` (a case hat or jackpot unusual,
// or null → everything owned, `consolation` credits instead), `jackpot`,
// `usedKey`, `caseKeys`; failures carry reason 'insufficient' | 'complete'.
// Older servers sent `dupe` + `refund` — still handled.
type CaseResp = {
  ok?: boolean;
  reason?: string;
  won?: string | null;
  jackpot?: boolean;
  consolation?: number;
  usedKey?: boolean;
  dupe?: boolean;
  refund?: number;
  credits?: number;
  caseKeys?: number;
  unlocked?: string[];
};

const VIEW_OFFSET: Partial<Record<PreviewCosmetics['view'], number>> = {
  head: 0.16,
  crown: 0.16,
  identity: 0.17,
  weapon: 0.07,
  full: 0.2,
  emote: 0.2,
  finisher: 0.1,
  spawn: 0.14,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useNarrow(): boolean {
  const q = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

// Arrow-key roving focus across a grid of [data-tile] buttons (columns are
// read from the live layout, so it follows the responsive grid).
function onTileArrows(e: ReactKeyboardEvent<HTMLElement>) {
  const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2, Home: -9, End: 9 };
  if (!(e.key in map)) return;
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tile]')];
  const i = tiles.indexOf(document.activeElement as HTMLElement);
  if (i < 0 || tiles.length === 0) return;
  const top0 = tiles[0].getBoundingClientRect().top;
  let cols = tiles.findIndex((t) => Math.abs(t.getBoundingClientRect().top - top0) > 4);
  if (cols <= 0) cols = tiles.length;
  // A single-row strip (narrow rail) navigates with ←/→ only.
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

export function Locker({
  settings,
  onChange,
  onClose,
  account,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  account?: Account;
}) {
  const reduced = settings.reducedEffects || prefersReducedMotion();
  const narrow = useNarrow();
  const [profile, setProfile] = useState<LockerProfile | null>(null);
  // 'loading' until /api/profile answers: the grid shows skeletons instead of
  // a flash of "everything owned" that then snaps to locks. 'offline' = no
  // backend → local-only selection (everything equippable, nothing buyable).
  // 'error' = a logged-in profile that wouldn't load after retries — never fall
  // back to "everything owned" for an account (it would equip locally only).
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'offline' | 'error'>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [slot, setSlotState] = useState<LockerSlot>('hat');
  const [selected, setSelected] = useState<string>(() => settings.hat);
  const [hover, setHover] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'owned'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [caseWin, setCaseWin] = useState<CaseWin | null>(null);
  const [fx, setFx] = useState<{ key: number; kind: 'equip' | 'unlock'; id: string } | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [replayKey, setReplayKey] = useState(0);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [closing, setClosing] = useState(false);
  const seenRef = useRef<Set<string> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rootRef = useRef<HTMLDivElement>(null);
  const owner = account?.username ?? 'guest';
  const loading = profileState === 'loading';
  const guest = profileState === 'ready' && !account;

  // ── Profile (ownership, credits) + one-time server → settings sync ─────────
  useEffect(() => {
    let active = true;
    let retry = 0;
    const run = (attempt: number) => fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no profile'))))
      .then((d: { profile?: InstagibProfile & { caseKeys?: number } }) => {
        if (!active) return;
        if (!d.profile) {
          setProfileState('offline');
          return;
        }
        const p = d.profile;
        const unlocked = p.unlocked ?? [];
        setProfile({
          unlocked,
          credits: p.credits ?? 0,
          equipped: p.equipped ?? {},
          level: p.level ?? 1,
          caseKeys: typeof p.caseKeys === 'number' ? p.caseKeys : 0,
          raw: p,
        });
        setProfileState('ready');
        // NEW = owned (non-default) items not seen before. First visit ever →
        // baseline everything already owned.
        const ownedNonDefault = unlocked.filter((id) => cosmeticById(id)?.source.type !== 'default');
        let seen = loadSeen(owner);
        if (!seen) {
          seen = new Set(ownedNonDefault);
          saveSeen(owner, seen);
        }
        seenRef.current = seen;
        setNewIds(new Set(ownedNonDefault.filter((id) => !seen!.has(id) && slotOfItem(id))));
        // Sync the server's equipped choices into the live game (once, on open).
        let patch: Settings | null = null;
        for (const s of ALL_SLOTS) {
          const sl = SLOT_DEFS[s];
          const eq = p.equipped?.[s];
          if (eq && eq !== sl.current(settingsRef.current) && unlocked.includes(eq)) {
            patch = sl.apply(patch ?? settingsRef.current, eq);
          }
        }
        if (patch) {
          onChange(patch);
          setSelected((cur) => (cur === settingsRef.current.hat ? patch!.hat : cur));
        }
      })
      .catch(() => {
        if (!active) return;
        // A logged-in player retries (backoff), then gets a Retry state; a
        // guest / no-backend session falls back to local-only selection.
        if (account && attempt < 3) retry = window.setTimeout(() => void run(attempt + 1), 700 * 2 ** attempt);
        else setProfileState(account ? 'error' : 'offline');
      });
    setProfileState('loading');
    void run(0);
    return () => {
      active = false;
      window.clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const owns = useCallback(
    (id: string, source: CosmeticSource) => !profile || profile.unlocked.includes(id) || source.type === 'default',
    [profile],
  );

  const markSeen = useCallback(
    (id: string) => {
      if (!newIds.has(id)) return;
      const next = new Set(newIds);
      next.delete(id);
      setNewIds(next);
      const seen = seenRef.current ?? new Set<string>();
      seen.add(id);
      seenRef.current = seen;
      saveSeen(owner, seen);
    },
    [newIds, owner],
  );

  const def = SLOT_DEFS[slot];
  // Staff-only items are listed only for whoever actually owns them.
  const items = useMemo(
    () => sortItems(def.items).filter((i) => i.source.type !== 'admin' || !!profile?.unlocked.includes(i.id)),
    [def, profile],
  );
  const shown = useMemo(
    () => (filter === 'owned' && profileState !== 'loading' ? items.filter((i) => owns(i.id, i.source)) : items),
    [filter, items, owns, profileState],
  );
  const ownedCount = items.filter((i) => owns(i.id, i.source)).length;

  // Warm this slot's thumbnails (the rail's equipped ones go first).
  useEffect(() => {
    prefetchThumbnails(ALL_SLOTS.map((s) => SLOT_DEFS[s].current(settingsRef.current)));
  }, []);
  useEffect(() => {
    prefetchThumbnails(
      items.map((i) => i.id),
      true,
    );
  }, [items]);

  const setSlot = (s: LockerSlot) => {
    if (s === slot) {
      setReplayKey((k) => k + 1);
      return;
    }
    setSlotState(s);
    setSelected(SLOT_DEFS[s].current(settingsRef.current));
    setHover(null);
  };

  // ── Try-on ────────────────────────────────────────────────────────────────
  const tryOn = hover ?? selected;
  const inSlot = (s: LockerSlot, id: string) => slot === s && SLOT_DEFS[s].items.some((i) => i.id === id);
  const pick = (s: LockerSlot, cur: string) => (inSlot(s, tryOn) ? tryOn : cur);
  const cosKey = [
    slot,
    tryOn,
    settings.hat,
    settings.unusual,
    settings.emote,
    settings.railColor,
    settings.railgunFinish,
    settings.killEffect,
    settings.spawnEffect,
    settings.playerName,
    settings.reducedEffects,
  ].join('|');
  const cos = useMemo<PreviewCosmetics>(
    () => ({
      hatId: pick('hat', settings.hat),
      unusualId: pick('unusual', settings.unusual),
      emoteId: pick('emote', settings.emote),
      railColor: pick('railColor', settings.railColor),
      railgunFinish: pick('railgunFinish', settings.railgunFinish),
      killEffect: pick('killEffect', settings.killEffect) as KillEffectStyle,
      spawnEffect: pick('spawnEffect', settings.spawnEffect),
      view: def.view,
      skinSeed: settings.playerName || undefined,
      reducedEffects: settings.reducedEffects,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cosKey],
  );

  const titleText = (id: string) => {
    const t = titleById(id);
    return t.dynamic === 'ranked' ? rankedStandingText(profile?.raw.ranked ?? null) || 'Unranked' : t.text;
  };
  const nameplate = useMemo<StageNameplate | null>(
    () =>
      slot === 'title' || slot === 'nameColor'
        ? {
            name: settings.playerName || 'Player',
            color: nameColorById(pick('nameColor', settings.nameColor)).color,
            title: titleText(pick('title', settings.title)),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot, tryOn, settings.playerName, settings.nameColor, settings.title, profile],
  );

  const shownItem = cosmeticById(tryOn);
  const tint = RARITY_COLOR[shownItem?.rarity ?? 'common'].edge;
  // Desktop: the details panel sits bottom-left over the stage, so the subject
  // shifts right (and the gun up) to clear it.
  const offsetX = narrow ? 0 : slot === 'card' ? 0.24 : (VIEW_OFFSET[def.view] ?? 0.18);
  const offsetY = def.view === 'weapon' ? (narrow ? -0.04 : -0.1) : 0;

  // ── Actions ───────────────────────────────────────────────────────────────
  const itemName = (id: string) => cosmeticById(id)?.name ?? id;

  const flourish = (id: string, kind: 'equip' | 'unlock') => {
    setFx({ key: Date.now(), kind, id });
    setPulseKey((k) => k + 1);
  };

  // `quiet` skips the "Equipped" toast (a purchase reports itself); `fx`
  // picks the stage flourish ('none' when a celebration already played).
  const equip = async (id: string, opts: { quiet?: boolean; fx?: 'equip' | 'none' } = {}) => {
    const s = slotOfItem(id) ?? slot;
    const sl = SLOT_DEFS[s];
    const apply = () => {
      onChange(sl.apply(settingsRef.current, id));
      if (opts.fx !== 'none') flourish(id, 'equip');
      if (!opts.quiet) toast(`Equipped · ${itemName(id)}`, { tone: 'ok', sound: 'equip' });
    };
    markSeen(id);
    if (!profile) {
      apply(); // offline → local-only
      return;
    }
    setBusy(id);
    try {
      const res = await fetch('/api/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ slot: s, id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; equipped?: Record<string, string> };
      if (res.ok && d.ok) {
        apply();
        setProfile((p) => (p ? { ...p, equipped: d.equipped ?? p.equipped } : p));
      } else if (!account && owns(id, cosmeticById(id)?.source ?? { type: 'default' })) {
        apply(); // guests keep free cosmetics locally (the server stores nothing for them)
      } else if (res.status === 429) toast('Slow down a moment.', { tone: 'warn' });
      else toast('Could not equip that.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const buy = async (id: string) => {
    if (!account) {
      toast('Log in to buy cosmetics.', { tone: 'warn' });
      return;
    }
    setBusy(id);
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; credits?: number; unlocked?: string[] };
      if (res.ok && d.ok) {
        setProfile((p) => (p ? { ...p, credits: d.credits ?? p.credits, unlocked: d.unlocked ?? [...p.unlocked, id] } : p));
        flourish(id, 'unlock');
        toast(`Unlocked · ${itemName(id)}`, { tone: 'ok', sound: 'purchase' });
        setBusy(null);
        await equip(id, { quiet: true, fx: 'none' });
        return;
      }
      toast(
        d.reason === 'insufficient' ? 'Not enough credits.' : d.reason === 'owned' ? 'You already own that.' : 'Could not buy that.',
        { tone: 'err' },
      );
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const openCase = async () => {
    if (busy) return;
    setBusy('__case');
    try {
      const res = await fetch('/api/shop/open-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      const d = (await res.json().catch(() => ({}))) as CaseResp;
      // Credits / keys / unlocks ride along on success AND failure.
      const won = typeof d.won === 'string' && cosmeticById(d.won) ? d.won : null;
      setProfile((p) =>
        p
          ? {
              ...p,
              credits: typeof d.credits === 'number' ? d.credits : p.credits,
              caseKeys: typeof d.caseKeys === 'number' ? d.caseKeys : p.caseKeys,
              unlocked: d.unlocked ?? (won && !d.dupe && !p.unlocked.includes(won) ? [...p.unlocked, won] : p.unlocked),
            }
          : p,
      );
      if (res.ok && d.ok && won) {
        if (!d.dupe) setNewIds((n) => new Set([...n, won]));
        setCaseWin({
          won,
          dupe: !!d.dupe,
          refund: d.refund ?? 0,
          jackpot: !!d.jackpot || (cosmeticById(won)?.source.type === 'case' && slotOfItem(won) === 'unusual'),
        });
      } else if (res.ok && d.ok) {
        // Nothing left to win: the server paid a consolation instead.
        toast(`Case complete · +${fmtCredits(d.consolation ?? 0)}`, { tone: 'ok' });
      } else if (res.status === 429) toast('Slow down a moment.', { tone: 'warn' });
      else
        toast(
          d.reason === 'insufficient'
            ? 'Not enough credits.'
            : d.reason === 'complete'
              ? 'You already own everything in the case.'
              : 'Could not open the case.',
          { tone: 'err' },
        );
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  // Tile click: select (try it on, show details); clicking the selected,
  // owned item again equips it.
  const onTile = (item: LockerItem) => {
    markSeen(item.id);
    if (selected === item.id && owns(item.id, item.source) && def.current(settings) !== item.id && !busy) {
      void equip(item.id);
      return;
    }
    uiSfx('uiClick');
    setSelected(item.id);
  };

  // ── Shell: Esc, focus trap, enter/exit ────────────────────────────────────
  const isTop = useModalStack();
  const close = useCallback(() => {
    if (closing) return;
    uiSfx('uiBack');
    if (reduced) {
      onClose();
      return;
    }
    setClosing(true);
    window.setTimeout(onClose, MODAL_EXIT_MS);
  }, [closing, reduced, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (!e.defaultPrevented) {
          e.preventDefault();
          close();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const els = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const a = document.activeElement;
      const inside = a instanceof Node && root.contains(a);
      if (e.shiftKey ? !inside || a === first : !inside || a === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, close]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  // ── Derived for the details panel ─────────────────────────────────────────
  const selItem = (def.items.find((i) => i.id === selected) ?? def.items[0]) as LockerItem;
  const selEquipped = def.current(settings) === selItem.id;
  const selOwned = owns(selItem.id, selItem.source);
  const tryingOn = !loading && tryOn !== def.current(settings) && inSlot(slot, tryOn);
  const caseComplete = !!profile && casePool().every((i) => profile.unlocked.includes(i.id));
  const credits = profile?.credits ?? null;

  const details = (
    <ItemDetails
      item={selItem}
      noun={def.noun}
      equipped={selEquipped}
      owned={selOwned}
      loading={loading}
      busy={busy === selItem.id}
      credits={credits}
      level={profile?.level ?? null}
      stats={profile?.raw.stats}
      guest={guest}
      stampKey={fx && fx.id === selItem.id ? fx.key : 0}
      reducedNote={
        settings.reducedEffects && (slot === 'killEffect' || slot === 'spawnEffect')
          ? slot === 'killEffect'
            ? 'Reduced effects is on: in-match, finishers play as a small spark.'
            : 'Reduced effects is on: spawn effects are hidden in-match.'
          : null
      }
      slot={slot}
      caseAction={
        selItem.source.type === 'case' && !selOwned && profileState === 'ready'
          ? {
              label:
                busy === '__case'
                  ? 'Opening…'
                  : guest
                    ? 'Log in to open'
                    : (profile?.caseKeys ?? 0) > 0
                      ? 'Open Hat Case · 1 key'
                      : `Open Hat Case · ${fmtCredits(HAT_CASE_COST)}`,
              disabled:
                guest || !!busy || caseComplete || ((profile?.caseKeys ?? 0) <= 0 && (credits ?? 0) < HAT_CASE_COST),
              onOpen: () => void openCase(),
            }
          : undefined
      }
      onEquip={() => void equip(selItem.id)}
      onBuy={() => void buy(selItem.id)}
    />
  );

  const fxItem = fx ? cosmeticById(fx.id) : undefined;
  const fxColor = RARITY_COLOR[fxItem?.rarity ?? 'common'].edge;
  const cardPayload =
    slot === 'card'
      ? profile
        ? buildCardPayload(profile.raw, { ...settings, card: pick('card', settings.card) }, account)
        : {
            name: settings.playerName || 'Player',
            level: 1,
            style: pick('card', settings.card),
            stats: [],
            title: titleText(settings.title),
            verified: !!account?.isVerified,
            admin: !!account?.isAdmin,
          }
      : null;

  const node = (
    <div
      ref={rootRef}
      role='dialog'
      aria-modal='true'
      aria-label='Locker'
      data-profile={profileState}
      tabIndex={-1}
      className={`lk-root ${closing ? 'lk-exit' : 'lk-enter'} ${reduced ? 'lk-reduced' : ''}`}
    >
      <header className='lk-top'>
        <div className='flex min-w-0 flex-1 items-center gap-3'>
          <h2 className='lk-title'>Locker</h2>
          <span className='lk-info' tabIndex={0} role='note' aria-label='Cosmetic only. Nothing here affects aim, movement or hits.'>
            <span aria-hidden>i</span>
            <span className='lk-info-tip' aria-hidden>
              Cosmetic only. Nothing here affects aim, movement or hits.
            </span>
          </span>
        </div>
        {loading ? (
          <Skeleton className='h-5 w-24' />
        ) : (
          credits != null && (
            <div className='lk-credits' aria-label={`${credits} credits`} title='Credits'>
              <b>{fmtCredits(credits)}</b>
              {profile && profile.caseKeys > 0 && (
                <span className='lk-chip ml-2' style={{ color: '#ffe7a3', boxShadow: 'inset 0 0 0 1px #ffc23d88' }}>
                  {profile.caseKeys} case key{profile.caseKeys === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )
        )}
        <button type='button' className='lk-close' onClick={close} aria-label='Close the Locker' {...sfxProps('none')}>
          ✕ Esc
        </button>
      </header>

      <div className='lk-body'>
        <LockerStage
          cos={cos}
          lowSpec={settings.lowSpec}
          offsetX={offsetX}
          offsetY={offsetY}
          tint={tint}
          nameplate={nameplate}
          pulseKey={pulseKey}
          replayKey={replayKey}
          backdrop={
            // Giant slot name behind the subject — skipped where the nameplate
            // or the card showcase owns the top of the stage.
            def.view !== 'identity' && slot !== 'card' ? (
              <div
                className='lk-watermark'
                aria-hidden
                style={{ fontSize: `min(140px, ${(88 / (Math.max(4, def.label.length) * 0.66)).toFixed(1)}cqw)` }}
              >
                {def.label}
              </div>
            ) : null
          }
        >
          {tryingOn && shownItem && (
            <div className='lk-tryon'>
              Trying on
              <span style={{ color: RARITY_COLOR[shownItem.rarity].from }}>{shownItem.name}</span>
            </div>
          )}
          {cardPayload && (
            <div className='lk-card-show' style={{ transform: narrow ? 'scale(0.9)' : 'scale(1.12)' }}>
              <PlayerCard card={cardPayload} reduced={settings.reducedEffects} />
            </div>
          )}
          {fx && (
            <div key={fx.key} className='pointer-events-none absolute inset-0' style={{ ['--rc' as string]: fxColor }}>
              {fx.kind === 'equip' ? <div className='lk-flash' /> : <Celebration name={fxItem?.name ?? ''} />}
            </div>
          )}
          {!narrow && details}
        </LockerStage>
        {narrow && details}

        <nav className='lk-rail' aria-label='Loadout slots' onKeyDown={onTileArrows}>
          {SLOT_GROUPS.map((g) => (
            <div key={g.id} className='lk-group'>
              <div className='lk-group-label'>{g.label}</div>
              <div className='lk-rail-grid'>
                {g.slots.map((s) => {
                  const sd = SLOT_DEFS[s];
                  const eq = sd.current(settings);
                  const hasNew = sd.items.some((i) => newIds.has(i.id));
                  return (
                    <div key={s} className='lk-rail-cell'>
                      <ItemTile
                        id={eq}
                        fluid
                        selected={slot === s}
                        dot={hasNew}
                        tabIndex={slot === s ? 0 : -1}
                        onClick={() => {
                          uiSfx('tabSwitch');
                          setSlot(s);
                        }}
                        onPointerEnter={uiHover}
                        rootProps={{ 'data-tile': '', 'data-slot': s, title: sd.label, 'aria-label': `${sd.label}: ${cosmeticById(eq)?.name ?? eq}${hasNew ? ', new items' : ''}` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <section className='lk-main' aria-label={`${def.label} items`}>
          <div className='lk-main-head'>
            <div>
              <h3 className='lk-slot-title'>{def.noun}</h3>
              <div className='lk-count'>
                {loading ? 'Loading…' : profileState === 'error' ? 'Not loaded' : `${ownedCount} / ${items.length} owned`}
              </div>
            </div>
            <div className='flex gap-1' role='group' aria-label='Filter'>
              <SegButton active={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </SegButton>
              <SegButton active={filter === 'owned'} onClick={() => setFilter('owned')}>
                Owned
              </SegButton>
            </div>
          </div>
          <div className='lk-scroll deck-scroll'>
            {slot === 'hat' && (
              <HatCaseCard
                credits={profileState === 'offline' ? null : (credits ?? 0)}
                keys={profile?.caseKeys ?? 0}
                owned={(id) => !!profile?.unlocked.includes(id)}
                complete={caseComplete}
                busy={busy === '__case'}
                loading={loading}
                guest={guest}
                onOpen={() => void openCase()}
              />
            )}
            {profileState === 'error' && (
              <div className='lk-empty'>
                Couldn&rsquo;t load your Locker.{' '}
                <button type='button' className='underline underline-offset-2 hover:text-white' onClick={() => setLoadKey((k) => k + 1)}>
                  Try again
                </button>
              </div>
            )}
            {profileState !== 'error' && <div
              className='lk-grid'
              role='listbox'
              aria-label={`${def.label} items`}
              aria-busy={loading}
              onKeyDown={onTileArrows}
              onPointerLeave={() => setHover(null)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
              }}
            >
              {loading
                ? items.slice(0, 8).map((i) => <Skeleton key={i.id} className='aspect-square w-full' />)
                : shown.map((item, idx) => {
                    const owned = owns(item.id, item.source);
                    const equipped = def.current(settings) === item.id;
                    const isSel = selected === item.id;
                    const selVisible = shown.some((x) => x.id === selected);
                    return (
                      <ItemTile
                        key={item.id}
                        id={item.id}
                        fluid
                        selected={isSel}
                        equipped={equipped}
                        locked={!owned}
                        isNew={newIds.has(item.id)}
                        price={!owned && item.source.type === 'credits' ? item.source.price : undefined}
                        tabIndex={isSel || (!selVisible && idx === 0) ? 0 : -1}
                        onClick={() => onTile(item)}
                        onPointerEnter={(e) => {
                          uiHover(e);
                          setHover(item.id);
                          markSeen(item.id);
                        }}
                        onFocus={() => {
                          setHover(item.id);
                          markSeen(item.id);
                        }}
                        rootProps={{
                          'data-tile': '',
                          'data-cosmetic': item.id,
                          'data-state': equipped ? 'equipped' : owned ? 'owned' : item.source.type === 'credits' ? 'buyable' : 'locked',
                          role: 'option',
                          'aria-selected': isSel,
                        }}
                      />
                    );
                  })}
            </div>}
            {!loading && profileState !== 'error' && shown.length === 0 && (
              <div className='lk-empty'>Nothing owned in this slot yet — switch the filter to All to see what you can unlock.</div>
            )}
            {slot === 'card' && (
              <div className='mt-6 max-w-[520px] font-mono'>
                <CardStatsEditor
                  settings={settings}
                  onChange={onChange}
                  account={account}
                  profile={profileState === 'loading' ? undefined : (profile?.raw ?? null)}
                  showPreview={false}
                />
              </div>
            )}
          </div>
        </section>
      </div>

      {caseWin && (
        <CaseSpinner
          win={caseWin}
          reduced={reduced}
          canEquip={!caseWin.dupe}
          onEquip={(id) => {
            const s = slotOfItem(id);
            if (s && s !== slot) setSlot(s);
            setSelected(id);
            void equip(id);
          }}
          onClose={() => {
            const s = slotOfItem(caseWin.won);
            if (s === slot) setSelected(caseWin.won);
            setCaseWin(null);
          }}
        />
      )}
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

// Rays + sparks + "UNLOCKED <name>" over the stage (CSS only; the rays and
// sparks are dropped under reduced effects).
function Celebration({ name }: { name: string }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        a: `${(i / 16) * 360 + Math.random() * 14}deg`,
        d: `${150 + Math.random() * 130}px`,
        dl: `${Math.random() * 0.12}s`,
      })),
    [],
  );
  return (
    <div className='lk-celebrate'>
      <div className='lk-rays' />
      {sparks.map((s, i) => (
        <span key={i} className='lk-spark' style={{ ['--a' as string]: s.a, ['--d' as string]: s.d, ['--dl' as string]: s.dl }} />
      ))}
      <div className='lk-cele-text'>
        <small>Unlocked</small>
        <strong>{name}</strong>
      </div>
    </div>
  );
}

function ItemDetails({
  item,
  noun,
  equipped,
  owned,
  loading,
  busy,
  credits,
  level,
  stats,
  guest,
  stampKey,
  reducedNote,
  slot,
  caseAction,
  onEquip,
  onBuy,
}: {
  item: LockerItem;
  noun: string;
  equipped: boolean;
  owned: boolean;
  loading: boolean;
  busy: boolean;
  credits: number | null;
  level: number | null;
  stats: InstagibProfile['stats'] | undefined;
  guest: boolean;
  stampKey: number;
  reducedNote: string | null;
  slot: LockerSlot;
  caseAction?: { label: string; disabled: boolean; onOpen: () => void };
  onEquip: () => void;
  onBuy: () => void;
}) {
  const rarity: Rarity = item.rarity;
  const rc = RARITY_COLOR[rarity];
  const info = unlockInfo(item.source, level, stats, slot);
  const price = item.source.type === 'credits' ? item.source.price : 0;
  const short = item.source.type === 'credits' && credits != null ? Math.max(0, price - credits) : 0;
  let action: ReactNode;
  if (loading) action = <Skeleton className='h-[46px] w-44' />;
  else if (equipped)
    action = (
      <span key={stampKey} className={`lk-action lk-action-done ${stampKey ? 'lk-stamp' : ''}`} role='status'>
        ✓ Equipped
      </span>
    );
  else if (owned)
    action = (
      <button type='button' className='lk-action lk-action-equip' disabled={busy} onClick={onEquip} data-action='equip' {...sfxProps('none')}>
        {busy ? 'Equipping…' : 'Equip'}
      </button>
    );
  else if (item.source.type === 'credits')
    action = (
      <button
        type='button'
        className={`lk-action ${short > 0 || guest ? 'lk-action-muted' : 'lk-action-buy'}`}
        disabled={busy || short > 0 || guest}
        onClick={onBuy}
        data-action='buy'
        {...sfxProps('none')}
      >
        {busy ? 'Buying…' : guest ? 'Log in to buy' : short > 0 ? `Need ${fmtCredits(short)} more` : `Buy · ${fmtCredits(price)}`}
      </button>
    );
  else if (caseAction)
    action = (
      <button
        type='button'
        className={`lk-action ${caseAction.disabled ? 'lk-action-muted' : 'lk-action-buy'}`}
        disabled={caseAction.disabled}
        onClick={caseAction.onOpen}
        data-action='open-case'
        {...sfxProps('uiConfirm')}
      >
        {caseAction.label}
      </button>
    );
  else
    action = (
      <span className='lk-action lk-action-muted' aria-disabled>
        Locked
      </span>
    );
  return (
    <div className='lk-details' style={{ ['--rc' as string]: rc.edge }} aria-live='polite'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='lk-chip' style={{ background: rc.edge, color: '#0a0b0e' }}>
          {RARITY_LABEL[rarity]}
        </span>
        <span className='lk-chip text-white/55' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>
          {noun}
        </span>
      </div>
      <div className='lk-name' style={{ color: rc.text }}>
        {item.name}
      </div>
      <p className='lk-blurb'>{item.blurb}</p>
      {!owned && !loading && (
        <div className='lk-unlock'>
          {item.source.type === 'level' ? (
            <span className='inline-flex flex-wrap items-center gap-x-2 gap-y-1'>
              <LevelBadge level={item.source.level} /> Career Road reward
              {level != null && (
                <span className='inline-flex items-center gap-2 text-white/45'>
                  · you&rsquo;re <LevelBadge level={level} />
                </span>
              )}
            </span>
          ) : (
            <span>
              {info.line}
              {info.detail ? <span className='text-white/45'> · {info.detail}</span> : null}
            </span>
          )}
          {info.progress != null && (
            <div className='lk-bar' aria-hidden>
              <i style={{ width: `${Math.round(info.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {owned && item.source.type !== 'default' && !loading && credits != null && (
        <div className='lk-unlock text-white/45'>
          {item.source.type === 'credits' ? 'Purchased' : item.source.type === 'level' ? `Career Road reward · Lv ${item.source.level}` : info.line}
        </div>
      )}
      {reducedNote && <div className='lk-unlock text-white/40'>{reducedNote}</div>}
      <div className='mt-1 flex items-center gap-3'>{action}</div>
    </div>
  );
}
