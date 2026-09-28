// Locker data: the loadout slots, their grouping on the rail, the preview
// framing each slot uses, unlock copy and the "NEW" tracker. THREE-free.
import type { InstagibProfile, Settings } from '../app-types';
import type { PreviewView } from '../game/character-preview';
import {
  CARD_STYLES,
  EMOTES,
  HATS,
  KILL_EFFECTS,
  NAME_COLORS,
  RAIL_COLORS,
  RAILGUN_FINISHES,
  SPAWN_EFFECTS,
  TITLES,
  UNUSUALS,
  caseHats,
  sourceLabel,
  type CosmeticSource,
  type KillEffectStyle,
  type Rarity,
} from '../game/cosmetics';
import { RARITY_RANK } from '../ui/rarity';

export type LockerSlot =
  | 'hat'
  | 'unusual'
  | 'railgunFinish'
  | 'railColor'
  | 'killEffect'
  | 'spawnEffect'
  | 'card'
  | 'title'
  | 'nameColor'
  | 'emote';

export type LockerItem = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
};

export type SlotDef = {
  slot: LockerSlot;
  label: string; // rail caption + grid heading
  noun: string; // "Epic <noun>" in the details chip
  items: readonly LockerItem[];
  view: PreviewView; // preview framing while this slot is open
  current: (s: Settings) => string;
  apply: (s: Settings, id: string) => Settings;
};

export const SLOT_DEFS: Record<LockerSlot, SlotDef> = {
  hat: { slot: 'hat', label: 'Hat', noun: 'Hat', items: HATS, view: 'head', current: (s) => s.hat, apply: (s, id) => ({ ...s, hat: id }) },
  unusual: {
    slot: 'unusual',
    label: 'Unusual',
    noun: 'Unusual Effect',
    items: UNUSUALS,
    view: 'head',
    current: (s) => s.unusual,
    apply: (s, id) => ({ ...s, unusual: id }),
  },
  railgunFinish: {
    slot: 'railgunFinish',
    label: 'Finish',
    noun: 'Railgun Finish',
    items: RAILGUN_FINISHES,
    view: 'weapon',
    current: (s) => s.railgunFinish,
    apply: (s, id) => ({ ...s, railgunFinish: id }),
  },
  railColor: {
    slot: 'railColor',
    label: 'Rail Beam',
    noun: 'Rail Beam',
    items: RAIL_COLORS,
    view: 'weapon',
    current: (s) => s.railColor,
    apply: (s, id) => ({ ...s, railColor: id }),
  },
  killEffect: {
    slot: 'killEffect',
    label: 'Finisher',
    noun: 'Finisher',
    items: KILL_EFFECTS,
    view: 'finisher',
    current: (s) => s.killEffect,
    apply: (s, id) => ({ ...s, killEffect: id as KillEffectStyle }),
  },
  spawnEffect: {
    slot: 'spawnEffect',
    label: 'Spawn',
    noun: 'Spawn Effect',
    items: SPAWN_EFFECTS,
    view: 'spawn',
    current: (s) => s.spawnEffect,
    apply: (s, id) => ({ ...s, spawnEffect: id }),
  },
  card: { slot: 'card', label: 'Card', noun: 'Player Card', items: CARD_STYLES, view: 'full', current: (s) => s.card, apply: (s, id) => ({ ...s, card: id }) },
  title: { slot: 'title', label: 'Title', noun: 'Title', items: TITLES, view: 'identity', current: (s) => s.title, apply: (s, id) => ({ ...s, title: id }) },
  nameColor: {
    slot: 'nameColor',
    label: 'Name Color',
    noun: 'Name Color',
    items: NAME_COLORS,
    view: 'identity',
    current: (s) => s.nameColor,
    apply: (s, id) => ({ ...s, nameColor: id }),
  },
  emote: { slot: 'emote', label: 'Emote', noun: 'Emote', items: EMOTES, view: 'emote', current: (s) => s.emote, apply: (s, id) => ({ ...s, emote: id }) },
};

export const SLOT_GROUPS: ReadonlyArray<{ id: string; label: string; slots: readonly LockerSlot[] }> = [
  { id: 'character', label: 'Character', slots: ['hat', 'unusual'] },
  { id: 'weapon', label: 'Weapon', slots: ['railgunFinish', 'railColor'] },
  { id: 'effects', label: 'Finisher & Effects', slots: ['killEffect', 'spawnEffect'] },
  { id: 'identity', label: 'Identity', slots: ['card', 'title', 'nameColor'] },
  { id: 'emotes', label: 'Emotes', slots: ['emote'] },
];

export const ALL_SLOTS: readonly LockerSlot[] = SLOT_GROUPS.flatMap((g) => g.slots);

export function slotOfItem(id: string): LockerSlot | null {
  for (const s of ALL_SLOTS) if (SLOT_DEFS[s].items.some((i) => i.id === id)) return s;
  return null;
}

// "None"-style defaults (bare head, no effect, no title) pin to the front;
// then rarest first, then name.
export function sortItems(items: readonly LockerItem[]): LockerItem[] {
  return [...items].sort((a, b) => {
    const an = a.id.endsWith('.none') ? 1 : 0;
    const bn = b.id.endsWith('.none') ? 1 : 0;
    if (an !== bn) return bn - an;
    const r = RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });
}

// ── Unlock copy ──────────────────────────────────────────────────────────────

export type UnlockInfo = {
  line: string; // "Career Road · Level 35"
  detail?: string; // "you're Level 12" / "412 so far"
  progress?: number; // 0..1 toward the unlock, when measurable
};

type Stats = InstagibProfile['stats'] | undefined;

function achievementValue(source: Extract<CosmeticSource, { type: 'achievement' }>, stats: Stats): number | null {
  if (!stats) return null;
  switch (source.stat) {
    case 'kills':
      return stats.totalKills;
    case 'headshots':
      return stats.headshots;
    case 'wins':
      return stats.totalWins;
    case 'bestStreak':
      return stats.bestKillStreak;
    case 'games':
      return stats.totalGames;
    case 'accuracy':
      return Math.round(stats.bestAccuracy);
  }
  return null;
}

export function unlockInfo(source: CosmeticSource, level: number | null, stats: Stats, slot?: LockerSlot): UnlockInfo {
  switch (source.type) {
    case 'default':
      return { line: 'Default · everyone has this' };
    case 'level':
      return level != null
        ? { line: `Career Road · Level ${source.level}`, detail: `you're Level ${level}`, progress: Math.min(1, level / source.level) }
        : { line: `Career Road · Level ${source.level}` };
    case 'credits':
      return { line: `Shop · ${source.price.toLocaleString()} credits` };
    case 'achievement': {
      const v = achievementValue(source, stats);
      return {
        line: `Achievement · ${sourceLabel(source)}`,
        detail: v != null ? `${v.toLocaleString()} so far` : undefined,
        progress: v != null ? Math.min(1, v / source.min) : undefined,
      };
    }
    case 'case':
      return { line: slot === 'hat' ? 'Hat Case · case exclusive' : 'Hat Case jackpot · rare drop' };
    case 'admin':
      return { line: 'Staff exclusive' };
  }
}

// The Hat Case pool. Works with both catalog generations: the finalized
// progression catalog makes caseHats() the case-exclusive hats and adds
// caseJackpots(); the older one's caseHats() is every droppable hat. The
// jackpots are always the case-sourced unusuals.
// TODO(integration): switch to cosmetics.casePool(owned) / caseJackpots()
// once the progression catalog is merged (same result).
export function caseJackpotItems(): LockerItem[] {
  return UNUSUALS.filter((u) => u.source.type === 'case');
}
export function casePool(): LockerItem[] {
  return [...caseHats(), ...caseJackpotItems()];
}

// A non-case-exclusive hat that can ALSO drop from the case (older catalog).
export function dropsFromCase(id: string): boolean {
  return caseHats().some((h) => h.id === id && h.source.type !== 'case');
}

// ── "NEW" tracking ───────────────────────────────────────────────────────────
// Items unlocked since you last looked. The seen set lives in localStorage per
// account; the very first visit baselines everything you already own (no wall
// of NEW badges). Hovering, focusing or selecting an item marks it seen.

const SEEN_KEY = 'instagib-locker-seen:';

export function loadSeen(owner: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY + owner);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : null;
  } catch {
    return null;
  }
}

export function saveSeen(owner: string, seen: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SEEN_KEY + owner, JSON.stringify([...seen]));
  } catch {
    /* storage blocked — NEW badges just reset next visit */
  }
}
