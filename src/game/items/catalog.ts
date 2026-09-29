// Item definitions (v3). THREE-free, client + server. Spec: docs/economy.md.
//
// The visual data for finishes / beams / finishers / spawns / emotes / cards /
// name colours stays in ../cosmetics.ts (the renderers read it); this file
// re-tiers those as item defs and adds the code-built wearables (hat / face /
// back), whose look is the `art` key a builder in src/game/wearables/ renders.
// Ids are stable forever — instances in the DB reference them.

import {
  CARD_STYLES,
  EMOTES,
  KILL_EFFECTS,
  NAME_COLORS,
  RAIL_COLORS,
  RAILGUN_FINISHES,
  SPAWN_EFFECTS,
  TITLES,
  type Rarity,
} from '../cosmetics';
import { DEFAULT_DYE, DYES } from '../dyes';
import { CURRENT_SEASON, type ItemSlot, type Tier } from './types';

export type ItemDef = {
  id: string;
  slot: ItemSlot;
  name: string;
  blurb: string;
  tier: Tier;
  art: string; // renderer key (wearables: builder id; others: the legacy cosmetic id)
  default?: boolean; // everyone has it, virtual (not an instance)
  tradable: boolean; // false = bound (titles, staff, founder)
  inCases: boolean; // droppable from the matching case(s)
  season?: number; // release season (docs/economy.md §Seasons) — absent = Season 0; read via seasonOf()
};

export const seasonOf = (d: Pick<ItemDef, 'season'>): number => d.season ?? 0;

const fromRarity = (r: Rarity): Tier => (r === 'common' ? 'common' : r === 'rare' ? 'rare' : r === 'epic' ? 'epic' : 'legendary');

// ── Wearables (code-built — src/game/wearables/) ────────────────────────────
type W = [id: string, name: string, tier: Tier, blurb: string];
const HATS_V3: W[] = [
  ['hat.cap', 'Field Cap', 'common', 'A snug ballcap in your armour colour.'],
  ['hat.beanie', 'Beanie', 'common', 'Rolled cuff, pom-pom optional.'],
  ['hat.bandana', 'Bandana', 'common', 'Tied tight for the long fight.'],
  ['hat.party', 'Party Hat', 'common', 'Every frag is a celebration.'],
  ['hat.baseball', 'Ballcap Pro', 'uncommon', 'The fitted classic, flat brim.'],
  ['hat.hardhat', 'Hard Hat', 'uncommon', 'Safety first, fragging second.'],
  ['hat.headphones', 'Studio Cans', 'uncommon', 'Hear every footstep. (You already did.)'],
  ['hat.beret', 'Beret', 'uncommon', 'Tactical sophistication.'],
  ['hat.cone', 'Traffic Cone', 'uncommon', 'Caution: rail in use.'],
  ['hat.chef', 'Chef’s Toque', 'uncommon', 'Cooking up frags.'],
  ['hat.graduation', 'Graduate', 'rare', 'Top of the class.'],
  ['hat.tophat', 'Top Hat', 'rare', 'Distinguished destruction.'],
  ['hat.cowboy', 'Ten-Gallon', 'rare', 'Fastest rail in the west.'],
  ['hat.fedora', 'Fedora', 'rare', 'Milady, you have been gibbed.'],
  ['hat.catears', 'Cat Ears', 'rare', 'Nine lives. You have one.'],
  ['hat.propeller', 'Propeller Cap', 'epic', 'The rotor actually spins.'],
  ['hat.wizard', 'Wizard Hat', 'epic', 'One-shot, one spell.'],
  ['hat.viking', 'Viking Helm', 'epic', 'Horns, rivets, glory.'],
  ['hat.pirate', 'Captain’s Tricorn', 'epic', 'Plunder the scoreboard.'],
  ['hat.devil', 'Devil Horns', 'epic', 'Glowing, obviously.'],
  ['hat.samurai', 'Kabuto', 'legendary', 'A lacquered war helm with a golden crest.'],
  ['hat.knight', 'Plumed Great Helm', 'legendary', 'A knight’s crest, plume and all.'],
  ['hat.jester', 'Jester’s Cap', 'legendary', 'Bells that jingle as you strafe.'],
  ['hat.crown', 'Crown', 'relic', 'Heavy is the head.'],
  ['hat.halo.relic', 'Seraph Circlet', 'relic', 'A floating band of hard light.'],
  ['hat.void', 'Voidcrown', 'unobtainable', 'A crown carved from a starless night.'],
];
// Staff set (bound, admin-granted, never in cases) — the "Sovereign" set.
const STAFF_WEARABLES: [ItemSlot, string, string, string][] = [
  ['hat', 'hat.sovereign', 'Sovereign Crown', 'A floating hard-light crown with orbiting jewels — staff only.'],
  ['back', 'back.sovereign', 'Sovereign Mantle', 'A royal cloak with a hard-light halo ring — staff only.'],
  ['face', 'face.sovereign', 'Sovereign Visor', 'A gilded crowned faceplate — staff only.'],
];
const FACES_V3: W[] = [
  ['face.aviators', 'Aviators', 'common', 'Mirror-finish shades.'],
  ['face.moustache', 'Handlebar', 'uncommon', 'Distinguished facial hardware.'],
  ['face.shades', 'Shutter Shades', 'uncommon', 'Very 2007.'],
  ['face.goggles', 'Flight Goggles', 'rare', 'Brass rims, amber lenses.'],
  ['face.bandit', 'Bandit Mask', 'rare', 'Half-face kerchief.'],
  ['face.monocle', 'Monocle', 'rare', 'Rather.'],
  ['face.gasmask', 'Gas Mask', 'epic', 'Twin filters, sealed visor.'],
  ['face.hockey', 'Hockey Mask', 'epic', 'Friday the frag-teenth.'],
  ['face.cyber', 'Cyber HUD', 'legendary', 'A holographic targeting overlay (cosmetic, obviously).'],
  ['face.skull', 'Death’s Head', 'relic', 'A chrome skull faceplate.'],
];
const BACKS_V3: W[] = [
  ['back.pack', 'Field Pack', 'common', 'A rugged rucksack.'],
  ['back.quiver', 'Quiver', 'uncommon', 'Rail slugs, ironically.'],
  ['back.radio', 'Field Radio', 'uncommon', 'Whip antenna included.'],
  ['back.cape.crimson', 'Crimson Cape', 'uncommon', 'It billows when you dash.'],
  ['back.jetpack', 'Jetpack', 'rare', 'Twin thrusters (purely decorative).'],
  ['back.katana', 'Katana', 'rare', 'Sheathed across the back.'],
  ['back.shield', 'Kite Shield', 'rare', 'Emblazoned in your colour.'],
  ['back.wings.bat', 'Bat Wings', 'epic', 'Leathery, folded.'],
  ['back.guitar', 'Axe of Rock', 'epic', 'A flying-V on a strap.'],
  ['back.cape.royal', 'Royal Cape', 'epic', 'Ermine trim, gold clasp.'],
  ['back.wings.angel', 'Seraph Wings', 'legendary', 'Feathered and faintly glowing.'],
  ['back.wings.energy', 'Hardlight Wings', 'relic', 'Wings of pure energy.'],
];

const wearables = (slot: ItemSlot, list: W[]): ItemDef[] =>
  list.map(([id, name, tier, blurb]) => ({
    id,
    slot,
    name,
    blurb,
    tier,
    art: id,
    tradable: true,
    inCases: tier !== 'unobtainable',
  }));

// ── Re-tiered legacy looks ──────────────────────────────────────────────────
const LEGACY_TIER: Record<string, Tier> = {
  // finishes
  'gun.crimson': 'uncommon', 'gun.toxic': 'uncommon', 'gun.carbon': 'rare', 'gun.arctic': 'rare',
  'gun.hazard': 'rare', 'gun.gold': 'epic', 'gun.void': 'epic', 'gun.glitch': 'epic',
  'gun.ratz': 'epic', 'gun.plasma': 'epic', 'gun.spectrum': 'legendary', 'gun.admin': 'unobtainable',
  'gun.dragon': 'legendary', 'gun.tesla': 'legendary', 'gun.reaper': 'relic', 'gun.seraph': 'relic',
  'gun.oblivion': 'unobtainable', 'gun.celestial': 'unobtainable',
  // beams
  'rail.plasma': 'uncommon', 'rail.toxic': 'uncommon', 'rail.ember': 'uncommon', 'rail.void': 'rare',
  'rail.ratz': 'epic', 'rail.gold': 'epic', 'rail.spectrum': 'legendary', 'rail.admin': 'unobtainable',
  // finishers
  nova: 'uncommon', starburst: 'uncommon', ember: 'rare', shatter: 'rare', confetti: 'rare',
  voxel: 'epic', gibstorm: 'epic', derez: 'epic', vaporize: 'epic', overload: 'legendary',
  singularity: 'legendary', prism: 'relic',
  // spawns
  'emote.headbang': 'uncommon', 'emote.kneel': 'uncommon',
  // emotes (v3.1 meme taunts)
  'emote.facepalm': 'uncommon', 'emote.pushups': 'uncommon',
  'emote.crab': 'rare', 'emote.gg': 'rare', 'emote.teatime': 'rare',
  'emote.tpose': 'epic', 'emote.micdrop': 'epic', 'emote.takethel': 'legendary',
  'spawn.ring': 'uncommon', 'spawn.ember': 'rare', 'spawn.rift': 'epic',
};

type Legacy = { id: string; name: string; blurb: string; rarity: Rarity; source: { type: string } };
function legacy(slot: ItemSlot, list: readonly Legacy[]): ItemDef[] {
  return list.map((c) => {
    const isDefault = c.source.type === 'default';
    const staff = c.source.type === 'admin';
    return {
      id: c.id,
      slot,
      name: c.name,
      blurb: c.blurb,
      tier: LEGACY_TIER[c.id] ?? (staff ? 'unobtainable' : fromRarity(c.rarity)),
      art: c.id,
      default: isDefault || undefined,
      tradable: !isDefault && !staff,
      inCases: !isDefault && !staff,
    };
  });
}

// Titles: earned, bound, never in cases.
const titles: ItemDef[] = TITLES.map((t) => ({
  id: t.id,
  slot: 'title' as const,
  name: t.name,
  blurb: t.blurb,
  tier: fromRarity(t.rarity),
  art: t.id,
  default: t.source.type === 'default' || undefined,
  tradable: false,
  inCases: false,
}));
titles.push({ id: 'title.founder', slot: 'title', name: 'Founder', blurb: 'Played before the v3 economy. Thank you.', tier: 'legendary', art: 'title.founder', tradable: false, inCases: false });

export const ITEM_DEFS: readonly ItemDef[] = [
  { id: 'hat.none', slot: 'hat', name: 'Bare Head', blurb: 'No hat — classic.', tier: 'common', art: 'hat.none', default: true, tradable: false, inCases: false },
  ...wearables('hat', HATS_V3),
  { id: 'face.none', slot: 'face', name: 'No Face Item', blurb: 'Just the visor.', tier: 'common', art: 'face.none', default: true, tradable: false, inCases: false },
  ...wearables('face', FACES_V3),
  { id: 'back.none', slot: 'back', name: 'No Back Item', blurb: 'Travel light.', tier: 'common', art: 'back.none', default: true, tradable: false, inCases: false },
  ...wearables('back', BACKS_V3),
  { id: DEFAULT_DYE, slot: 'dye', name: 'Natural Skin', blurb: 'Your own bright colour, keyed to your name.', tier: 'common', art: DEFAULT_DYE, default: true, tradable: false, inCases: false },
  ...DYES.map((d): ItemDef => ({ id: d.id, slot: 'dye', name: d.name, blurb: d.blurb, tier: d.tier, art: d.id, tradable: true, inCases: d.tier !== 'unobtainable' })),
  ...STAFF_WEARABLES.map(([slot, id, name, blurb]): ItemDef => ({ id, slot, name, blurb, tier: 'unobtainable', art: id, tradable: false, inCases: false })),
  ...legacy('finish', RAILGUN_FINISHES),
  ...legacy('beam', RAIL_COLORS),
  ...legacy('finisher', KILL_EFFECTS),
  ...legacy('spawn', SPAWN_EFFECTS),
  ...legacy('emote', EMOTES),
  // Cards stay UNLOCKABLE (level-gated entitlements, like titles) — never case items / tradable.
  ...legacy('card', CARD_STYLES).map((d) => ({ ...d, tradable: false, inCases: false })),
  ...legacy('nameColor', NAME_COLORS),
  ...titles,
];

const BY_ID = new Map(ITEM_DEFS.map((d) => [d.id, d]));
export function itemDef(id: string): ItemDef | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_LOADOUT: Record<ItemSlot, string> = {
  hat: 'hat.none',
  face: 'face.none',
  back: 'back.none',
  dye: DEFAULT_DYE,
  finish: 'gun.stock',
  beam: 'rail.cyan',
  finisher: 'pulse',
  spawn: 'spawn.beam',
  emote: 'emote.cheer',
  card: 'card.slate',
  nameColor: 'name.default',
  title: 'title.none',
};

export function defaultDefs(): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.default);
}

// Case pool for a set of slots: tradable, case-droppable defs.
export function casePoolFor(slots: readonly ItemSlot[]): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.inCases && d.tradable && seasonOf(d) === CURRENT_SEASON && slots.includes(d.slot));
}

// A rolled tier with no defs in the pool falls to the nearest LOWER tier that
// has items (then the nearest higher). The Vault's Unobtainable roll draws from
// tradable Unobtainable defs (never case-listed otherwise).
export function vaultUnobtainables(): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.tier === 'unobtainable' && d.tradable && seasonOf(d) === CURRENT_SEASON);
}
