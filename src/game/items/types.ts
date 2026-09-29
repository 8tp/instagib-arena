// Inventory & economy v3 — shared types (THREE-free; client + server).
// Spec: docs/economy.md. Nothing here may affect gameplay.

export type Tier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'relic' | 'unobtainable';
export const TIERS: readonly Tier[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'relic', 'unobtainable'];

export const TIER_META: Record<Tier, { label: string; color: string; salvage: number; rank: number }> = {
  common: { label: 'Common', color: '#b0b7c3', salvage: 3, rank: 0 },
  uncommon: { label: 'Uncommon', color: '#5ec46b', salvage: 8, rank: 1 },
  rare: { label: 'Rare', color: '#4b8dff', salvage: 25, rank: 2 },
  epic: { label: 'Epic', color: '#a855f7', salvage: 90, rank: 3 },
  legendary: { label: 'Legendary', color: '#f59e0b', salvage: 350, rank: 4 },
  relic: { label: 'Relic', color: '#ef4444', salvage: 1500, rank: 5 },
  unobtainable: { label: 'Unobtainable', color: '#ff4fd8', salvage: 10000, rank: 6 },
};

export type ItemSlot =
  | 'hat'
  | 'face'
  | 'back'
  | 'finish' // railgun skin
  | 'beam' // rail colour
  | 'finisher' // kill effect / death animation
  | 'spawn'
  | 'emote'
  | 'card'
  | 'nameColor'
  | 'title';

export const ITEM_SLOTS: readonly ItemSlot[] = [
  'hat', 'face', 'back', 'finish', 'beam', 'finisher', 'spawn', 'emote', 'card', 'nameColor', 'title',
];

export type Quality = 'unusual' | 'strange' | 'festive' | 'killstreak' | 'professional' | 'founder' | 'admin';

// Per-instance attributes rolled at mint (or set by an admin).
export type ItemAttrs = {
  effect?: string; // unusual effect id (UNUSUAL_EFFECTS) — hats + emotes
  kills?: number; // strange counter (server-maintained)
  sheen?: string; // killstreak sheen colour id (KS_SHEENS)
  ksEffect?: string; // professional killstreak effect id (KS_EFFECTS)
  festive?: boolean;
  seed?: number; // pattern seed 0..999 (finishes)
  wear?: number; // 0..1 (finishes)
  nameTag?: string;
  customName?: string; // admin one-off
  customDesc?: string;
  tint?: string; // admin one-off tint '#rrggbb'
};

export type ItemOrigin = 'case' | 'spin' | 'admin' | 'road' | 'challenge' | 'founder' | 'title' | 'market' | 'trade' | 'legacy';
export type ItemState = 'owned' | 'listed' | 'traded' | 'salvaged' | 'revoked';

// An owned item as sent to its owner (and in market/trade views).
export type ItemInstanceWire = {
  uid: string;
  def: string;
  mint: number; // serial of this def ("#37")
  quality: Quality[];
  attrs: ItemAttrs;
  origin: ItemOrigin;
  tradable: boolean;
  state: ItemState;
  createdAt: number; // ms
  tier?: Tier; // admin one-offs may override the def tier
};

// What other players see of an equipped item (compact, in the room meta).
export type Look = {
  d: string; // def id
  e?: string; // unusual effect
  s?: string; // killstreak sheen
  k?: string; // professional killstreak effect
  f?: 1; // festive
  p?: number; // pattern seed
  w?: number; // wear
  t?: string; // admin tint
};
export type Loadout = Partial<Record<ItemSlot, Look>>;

export type CaseId = 'hat' | 'weapon' | 'accessory' | 'taunt' | 'vault';

export type CaseDef = {
  id: CaseId;
  name: string;
  blurb: string;
  cost: number; // credits
  slots: readonly ItemSlot[]; // pool = tradable case-droppable defs in these slots
  odds: Record<Tier, number>; // probabilities (sum 1); unobtainable only in the vault
  premium?: boolean;
};

const STD_ODDS: Record<Tier, number> = {
  common: 0.6, uncommon: 0.25, rare: 0.1, epic: 0.035, legendary: 0.012, relic: 0.003, unobtainable: 0,
};

export const CASES: readonly CaseDef[] = [
  { id: 'hat', name: 'Hat Case', blurb: 'Hats — with a shot at an Unusual.', cost: 150, slots: ['hat'], odds: STD_ODDS },
  { id: 'weapon', name: 'Weapon Case', blurb: 'Railgun finishes and rail beams. Strange and Killstreak variants.', cost: 150, slots: ['finish', 'beam'], odds: STD_ODDS },
  { id: 'accessory', name: 'Accessory Case', blurb: 'Face gear, backpacks, wings, capes and name colours.', cost: 150, slots: ['face', 'back', 'nameColor'], odds: STD_ODDS },
  { id: 'taunt', name: 'Taunt Case', blurb: 'Emotes, finishers and spawn effects. Unusual taunts drop here.', cost: 150, slots: ['emote', 'finisher', 'spawn'], odds: STD_ODDS },
  {
    id: 'vault', name: 'Vault Case', blurb: 'Everything, weighted up — and a whisper of Unobtainable.', cost: 600, premium: true,
    slots: ['hat', 'face', 'back', 'finish', 'beam', 'finisher', 'spawn', 'emote'],
    odds: { common: 0.3, uncommon: 0.33, rare: 0.22, epic: 0.1, legendary: 0.04, relic: 0.0098, unobtainable: 0.0002 },
  },
];

// No pity (by design, like TF2/Krunker): fixed, published rates only.

// ── Seasons ──────────────────────────────────────────────────────────────────
// Every ItemDef belongs to a season. Cases only drop CURRENT_SEASON defs; when a
// new season starts the whole case pool rotates — older-season items stop
// dropping but stay owned, tradable and equippable (and keep their season tag).
// To start a season: add its SeasonDef, tag the new defs with `season: N`, and
// bump CURRENT_SEASON (client + server ship together).
export type SeasonDef = { id: number; name: string; title: string; startedAt: string };
export const SEASONS: readonly SeasonDef[] = [{ id: 0, name: 'Season 0', title: 'Origins', startedAt: '2026-09-28' }];
export const CURRENT_SEASON = 0;
export const seasonName = (id: number): string => SEASONS.find((s) => s.id === id)?.name ?? `Season ${id}`;

// ── Daily free case ──────────────────────────────────────────────────────────
// One free open of any STANDARD case (not the Vault) per UTC day per account —
// the same roll as a paid open (same odds + qualities). Separate from free rolls.
export const DAILY_CASE = { premiumAllowed: false } as const;
export const nextUtcMidnight = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
export const utcDayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

// Quality roll chances per case roll (docs/economy.md §1).
export const QUALITY_ODDS = {
  unusualHat: 0.015,
  unusualHatLegendaryPlus: 0.05,
  unusualEmote: 0.02,
  strange: 0.1, // finishes, beams, finishers
  killstreak: 0.06, // finishes
  professional: 0.015, // finishes (subset of killstreak)
} as const;

export const STRANGE_RANKS: readonly { kills: number; name: string }[] = [
  { kills: 0, name: 'Strange' },
  { kills: 10, name: 'Unremarkable' },
  { kills: 25, name: 'Scarcely Lethal' },
  { kills: 45, name: 'Mildly Menacing' },
  { kills: 70, name: 'Somewhat Threatening' },
  { kills: 100, name: 'Uncharitable' },
  { kills: 135, name: 'Notably Dangerous' },
  { kills: 175, name: 'Sufficiently Lethal' },
  { kills: 225, name: 'Truly Feared' },
  { kills: 275, name: 'Spectacularly Lethal' },
  { kills: 350, name: 'Gore-Spattered' },
  { kills: 500, name: 'Wicked Nasty' },
  { kills: 750, name: 'Positively Inhumane' },
  { kills: 999, name: 'Totally Ordinary' },
  { kills: 1000, name: 'Face-Melting' },
  { kills: 1500, name: 'Rage-Inducing' },
  { kills: 2500, name: 'Server-Clearing' },
  { kills: 5000, name: 'Epic' },
  { kills: 7500, name: 'Legendary' },
  { kills: 7616, name: 'Australian' },
  { kills: 8500, name: 'Rail God’s Own' },
];

export function strangeRank(kills: number): string {
  let name = STRANGE_RANKS[0].name;
  for (const r of STRANGE_RANKS) if (kills >= r.kills) name = r.name;
  return name;
}

export const WEAR_BANDS: readonly { max: number; name: string }[] = [
  { max: 0.07, name: 'Factory New' },
  { max: 0.15, name: 'Minimal Wear' },
  { max: 0.38, name: 'Field-Tested' },
  { max: 0.45, name: 'Well-Worn' },
  { max: 1.01, name: 'Battle-Scarred' },
];
export function wearName(w: number): string {
  return (WEAR_BANDS.find((b) => w < b.max) ?? WEAR_BANDS[WEAR_BANDS.length - 1]).name;
}

// Unusual effects (renderer: src/game/fx/unusuals.ts keys by `kind`). `taunt` = also valid on emotes.
export const UNUSUAL_EFFECTS: readonly { id: string; name: string; kind: string; taunt?: boolean }[] = [
  { id: 'fx.embers', name: 'Searing Embers', kind: 'embers', taunt: true },
  { id: 'fx.orbit', name: 'Orbiting Energy', kind: 'orbit' },
  { id: 'fx.halo', name: 'Radiant Halo', kind: 'halo' },
  { id: 'fx.storm', name: 'Storm Cloud', kind: 'storm', taunt: true },
  { id: 'fx.aura', name: 'Sovereign Aura', kind: 'aura' },
  { id: 'fx.plasma', name: 'Plasma Arcs', kind: 'plasma', taunt: true },
  { id: 'fx.prism', name: 'Prismatic', kind: 'prism', taunt: true },
  { id: 'fx.galaxy', name: 'Galaxy', kind: 'galaxy', taunt: true },
  { id: 'fx.ghostfire', name: 'Ghostfire', kind: 'ghostfire', taunt: true },
  { id: 'fx.hearts', name: 'Lovestruck', kind: 'hearts', taunt: true },
  { id: 'fx.binary', name: 'Overclocked', kind: 'binary' },
  // v3 additions (renderers added by the VFX track)
  { id: 'fx.sunbeams', name: 'Sunbeams', kind: 'sunbeams', taunt: true },
  { id: 'fx.bubbles', name: 'Bubbling', kind: 'bubbles' },
  { id: 'fx.frostbite', name: 'Frostbite', kind: 'frostbite', taunt: true },
  { id: 'fx.voidrift', name: 'Void Rift', kind: 'voidrift', taunt: true },
  { id: 'fx.fireflies', name: 'Fireflies', kind: 'fireflies' },
  { id: 'fx.cosmic', name: 'Cosmic Crown', kind: 'cosmic' },
  { id: 'fx.lightning', name: 'Thunderhead', kind: 'lightning', taunt: true },
  { id: 'fx.sakura', name: 'Sakura Drift', kind: 'sakura', taunt: true },
];

export const KS_SHEENS: readonly { id: string; name: string; color: string }[] = [
  { id: 'sheen.team', name: 'Team Shine', color: '#5cc8ff' },
  { id: 'sheen.gold', name: 'Deadly Daffodil', color: '#ffd24a' },
  { id: 'sheen.orange', name: 'Manndarin', color: '#ff8a1f' },
  { id: 'sheen.green', name: 'Mean Green', color: '#7dff5a' },
  { id: 'sheen.lime', name: 'Agonizing Emerald', color: '#3bffb0' },
  { id: 'sheen.violet', name: 'Villainous Violet', color: '#b86bff' },
  { id: 'sheen.pink', name: 'Hot Rod', color: '#ff5fcf' },
];

export const KS_EFFECTS: readonly { id: string; name: string }[] = [
  { id: 'ks.fire', name: 'Fire Horns' },
  { id: 'ks.cerebral', name: 'Cerebral Discharge' },
  { id: 'ks.tornado', name: 'Tornado' },
  { id: 'ks.flames', name: 'Flames' },
  { id: 'ks.singularity', name: 'Singularity' },
  { id: 'ks.incinerator', name: 'Incinerator' },
  { id: 'ks.hypno', name: 'Hypno-Beam' },
];

// Economy constants (docs/economy.md §4–6).
export const MARKET = {
  listingFeePct: 0.02,
  saleTaxPct: 0.1,
  floorMult: 1.5,
  minPrice: 5,
  maxPrice: 1_000_000,
  maxListings: 25,
} as const;

export const TRADE = {
  minLevel: 5,
  minMatches: 10,
  minAccountAgeMs: 24 * 3600_000,
  maxItemsPerSide: 8,
  maxTradesPerDay: 20,
  maxCreditsPerDay: 5000,
  expiryMs: 48 * 3600_000,
} as const;

export const ONBOARDING = {
  credits: (level: number) => Math.min(3000, 300 + 25 * level),
  rolls: (level: number) => (level >= 20 ? 12 : level >= 10 ? 8 : level >= 5 ? 5 : 3),
} as const;

export function qualityPrefix(q: readonly Quality[], attrs: ItemAttrs): string {
  const parts: string[] = [];
  if (q.includes('unusual')) parts.push('Unusual');
  if (q.includes('strange')) parts.push(strangeRank(attrs.kills ?? 0));
  if (q.includes('festive')) parts.push('Festive');
  if (q.includes('professional')) parts.push('Professional Killstreak');
  else if (q.includes('killstreak')) parts.push('Killstreak');
  return parts.join(' ');
}
