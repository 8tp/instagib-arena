// Cosmetic catalog (THREE-free, shared client+server). Definitions live in code
// as a static manifest — the DB only ever stores unlocked IDs + the equipped
// selection (see docs/progression.md §5). Everything here is purely visual:
// nothing in this file may affect movement, hit detection, or weapon balance.
//
// v1 ships the kill-effect slot end-to-end (the "explosion when you frag
// someone" — modelled on Ratz Instagib's selectable death animations and
// Quakecraft's firework "barrels"). Future slots (rail beam color, crosshair,
// name color, announcer) slot in next to KILL_EFFECTS using the same shape.

export type Rarity = 'common' | 'rare' | 'epic';

// How a cosmetic is obtained. `default` = owned by everyone; `level` = unlocked
// by reaching an account level (prestige, can't be bought); `credits` = bought
// in the Locker with earned credits (player choice). A cosmetic is one OR the
// other, never both, to avoid "I leveled to it AND paid for it" feel-bad.
export type CosmeticSource =
  | { type: 'default' }
  | { type: 'level'; level: number }
  | { type: 'credits'; price: number };

// ── Kill-effect slot ────────────────────────────────────────────────────────
// The visual that plays at the victim when you frag them. Each style is a
// self-contained recipe in EffectsManager.spawnKillBurst().
export type KillEffectStyle =
  | 'pulse'
  | 'nova'
  | 'starburst'
  | 'voxel'
  | 'ember'
  | 'gibstorm'
  | 'singularity';

export const DEFAULT_KILL_EFFECT: KillEffectStyle = 'pulse';

export type KillEffectCosmetic = {
  id: KillEffectStyle;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
};

// Ordered roughly by unlock progression. `pulse` is the free default so the
// game looks complete before any progression is built; the rest are gated.
export const KILL_EFFECTS: readonly KillEffectCosmetic[] = [
  { id: 'pulse',       name: 'Pulse',       blurb: 'The classic triple-pop: flash, shockwave, gib spray.', rarity: 'common', source: { type: 'default' } },
  { id: 'nova',        name: 'Nova',        blurb: 'A blooming energy bloom with twin shockwave rings.',    rarity: 'rare',   source: { type: 'level', level: 3 } },
  { id: 'starburst',   name: 'Starburst',   blurb: 'A radial star of light spikes fired outward.',          rarity: 'rare',   source: { type: 'level', level: 6 } },
  { id: 'voxel',       name: 'Voxel',       blurb: 'Shatters the target into a burst of glowing cubes.',    rarity: 'rare',   source: { type: 'credits', price: 800 } },
  { id: 'ember',       name: 'Pyre',        blurb: 'A rising column of embers and drifting sparks.',         rarity: 'rare',   source: { type: 'credits', price: 800 } },
  { id: 'gibstorm',    name: 'Gibstorm',    blurb: 'A violent, heavy shard explosion that rains down.',      rarity: 'epic',   source: { type: 'level', level: 12 } },
  { id: 'singularity', name: 'Singularity', blurb: 'Collapses inward to a point, then detonates white-hot.', rarity: 'epic',   source: { type: 'credits', price: 2500 } },
] as const;

export function killEffectById(id: string): KillEffectCosmetic {
  return KILL_EFFECTS.find((k) => k.id === id) ?? KILL_EFFECTS[0];
}

export function isKillEffectStyle(id: string): id is KillEffectStyle {
  return KILL_EFFECTS.some((k) => k.id === id);
}

// ── Rail-beam color slot ────────────────────────────────────────────────────
// Recolors the local player's railgun beam (core + helix). Reuses the beam
// renderer (weapon.ts buildRailBeam); `rail.cyan` is the stock look (default).
export const DEFAULT_RAIL_COLOR = 'rail.cyan';

export type RailColorCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  data: { core: number; helix: number }; // beam core + helix colors
};

export const RAIL_COLORS: readonly RailColorCosmetic[] = [
  { id: 'rail.cyan',   name: 'Cyan',   blurb: 'The stock blue-cyan twin rail.', rarity: 'common', source: { type: 'default' },             data: { core: 0xd6f4ff, helix: 0x37a6ff } },
  { id: 'rail.plasma', name: 'Plasma', blurb: 'Hot magenta-violet beam.',       rarity: 'rare',   source: { type: 'level', level: 4 },      data: { core: 0xffd9ff, helix: 0xc23bff } },
  { id: 'rail.toxic',  name: 'Toxic',  blurb: 'Acid-green tracer.',             rarity: 'rare',   source: { type: 'level', level: 8 },      data: { core: 0xe8ffd6, helix: 0x6fff3b } },
  { id: 'rail.ember',  name: 'Ember',  blurb: 'Molten orange-red beam.',        rarity: 'rare',   source: { type: 'credits', price: 600 },  data: { core: 0xffe0b0, helix: 0xff6a1a } },
  { id: 'rail.gold',   name: 'Gold',   blurb: 'A regal gold beam.',             rarity: 'epic',   source: { type: 'credits', price: 1800 }, data: { core: 0xfff4c0, helix: 0xffb000 } },
];

export function railColorById(id: string): RailColorCosmetic {
  return RAIL_COLORS.find((c) => c.id === id) ?? RAIL_COLORS[0];
}
export function isRailColor(id: string): boolean {
  return RAIL_COLORS.some((c) => c.id === id);
}

// ── Hat slot ─────────────────────────────────────────────────────────────────
// A glTF model worn on the player model's head bone (mixamorigHead). `model` is
// a path under public/; null = bare-headed (the free default). Models are
// CC-BY 3.0 from Poly Pizza — see public/models/instagib/hats/ATTRIBUTION.md.
export const DEFAULT_HAT = 'hat.none';
const HAT_DIR = '/models/instagib/hats';

export type HatCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  model: string | null; // glb path, or null for bare-headed
};

export const HATS: readonly HatCosmetic[] = [
  { id: 'hat.none',       name: 'Bare Head',      blurb: 'No hat — classic.',                      rarity: 'common', source: { type: 'default' },             model: null },
  { id: 'hat.cap',        name: 'Cap',            blurb: 'A simple ballcap.',                       rarity: 'common', source: { type: 'default' },             model: `${HAT_DIR}/cap.glb` },
  { id: 'hat.baseball',   name: 'Ballcap Pro',    blurb: 'The fitted classic.',                    rarity: 'common', source: { type: 'level', level: 2 },     model: `${HAT_DIR}/baseball-cap.glb` },
  { id: 'hat.hardhat',    name: 'Hard Hat',       blurb: 'Safety first, fragging second.',         rarity: 'rare',   source: { type: 'credits', price: 400 }, model: `${HAT_DIR}/hard-hat.glb` },
  { id: 'hat.graduation', name: 'Graduate',       blurb: 'Top of the class.',                      rarity: 'rare',   source: { type: 'level', level: 5 },     model: `${HAT_DIR}/graduation-cap.glb` },
  { id: 'hat.fedora',     name: 'Fedora',         blurb: 'Tip of the brim.',                       rarity: 'rare',   source: { type: 'credits', price: 600 }, model: `${HAT_DIR}/fedora.glb` },
  { id: 'hat.cowboy',     name: 'Wrangler',       blurb: 'A ten-gallon hat.',                      rarity: 'rare',   source: { type: 'level', level: 9 },     model: `${HAT_DIR}/cowboy-hat.glb` },
  { id: 'hat.tophat',     name: 'Top Hat',        blurb: 'Distinguished destruction.',             rarity: 'epic',   source: { type: 'credits', price: 1000 }, model: `${HAT_DIR}/top-hat.glb` },
  { id: 'hat.propeller',  name: 'Propeller Cap',  blurb: 'Beanie with a spin.',                    rarity: 'epic',   source: { type: 'level', level: 14 },    model: `${HAT_DIR}/propeller-hat.glb` },
  { id: 'hat.wizard',     name: 'Wizard Hat',     blurb: 'One-shot, one spell.',                   rarity: 'epic',   source: { type: 'credits', price: 1800 }, model: `${HAT_DIR}/wizard-hat.glb` },
];

export function hatById(id: string): HatCosmetic {
  return HATS.find((h) => h.id === id) ?? HATS[0];
}
export function isHat(id: string): boolean {
  return HATS.some((h) => h.id === id);
}

// ── Unusual slot ─────────────────────────────────────────────────────────────
// A looping particle effect worn ON TOP of the equipped hat — the "unusual"
// (TF2-style). `kind` selects the emitter recipe in hats.ts. The rare/premium
// tier: high level, big credits, or the case jackpot.
export const DEFAULT_UNUSUAL = 'unusual.none';

export type UnusualKind = 'none' | 'embers' | 'orbit' | 'halo' | 'storm';

export type UnusualCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  kind: UnusualKind;
};

export const UNUSUALS: readonly UnusualCosmetic[] = [
  { id: 'unusual.none',   name: 'None',          blurb: 'No effect.',                          rarity: 'common', source: { type: 'default' },              kind: 'none' },
  { id: 'unusual.embers', name: 'Searing Embers',blurb: 'Rising embers crown your hat.',        rarity: 'epic',   source: { type: 'level', level: 18 },     kind: 'embers' },
  { id: 'unusual.orbit',  name: 'Orbiting Energy',blurb: 'Motes of energy circle overhead.',    rarity: 'epic',   source: { type: 'credits', price: 3000 }, kind: 'orbit' },
  { id: 'unusual.halo',   name: 'Radiant Halo',  blurb: 'A glowing ring hovers above you.',      rarity: 'epic',   source: { type: 'level', level: 25 },     kind: 'halo' },
  { id: 'unusual.storm',  name: 'Storm Cloud',   blurb: 'A tiny thundercloud follows your head.',rarity: 'epic',   source: { type: 'credits', price: 5000 }, kind: 'storm' },
];

export function unusualById(id: string): UnusualCosmetic {
  return UNUSUALS.find((u) => u.id === id) ?? UNUSUALS[0];
}
export function isUnusual(id: string): boolean {
  return UNUSUALS.some((u) => u.id === id);
}

// ── Hat case (credits-funded unboxing) ───────────────────────────────────────
// Cosmetic-only, bought with EARNED credits (never real money) → stays within
// the "no randomized paid boxes" pillar. The roll is server-authoritative.
export const HAT_CASE_COST = 500;
export const DUPE_REFUND_FRAC = 0.4; // duplicate roll refunds this much of the cost
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 100, rare: 40, epic: 12 };

// Droppable hats (everything but bare-head), the case's pool.
export function caseHats(): HatCosmetic[] {
  return HATS.filter((h) => h.model);
}

// ── Player-card slot ─────────────────────────────────────────────────────────
// A card graphic shown on kill (Valorant-style): the VICTIM sees the killer's
// card (background + level + the killer's chosen stats) on the killcam, and you
// see your own as a kill-confirm flourish. `bg`/`accent` are CSS for the card.
export const DEFAULT_CARD = 'card.slate';

export type CardCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  bg: string; // CSS background (gradient)
  accent: string; // hex accent for the level badge + stat numbers
};

export const CARD_STYLES: readonly CardCosmetic[] = [
  { id: 'card.slate',  name: 'Slate',     blurb: 'Clean gunmetal.',          rarity: 'common', source: { type: 'default' },              bg: 'linear-gradient(135deg,#1e293b,#0b1220)',                          accent: '#67e8f9' },
  { id: 'card.ember',  name: 'Ember',     blurb: 'Molten edges.',            rarity: 'rare',   source: { type: 'level', level: 4 },      bg: 'linear-gradient(135deg,#7c2d12,#180a05)',                          accent: '#fb923c' },
  { id: 'card.toxic',  name: 'Toxic',     blurb: 'Acid wash.',               rarity: 'rare',   source: { type: 'credits', price: 600 },  bg: 'linear-gradient(135deg,#14532d,#05140a)',                          accent: '#86efac' },
  { id: 'card.cyber',  name: 'Cyber',     blurb: 'Neon grid.',               rarity: 'rare',   source: { type: 'level', level: 10 },     bg: 'linear-gradient(135deg,#0e7490,#3b0764)',                          accent: '#22d3ee' },
  { id: 'card.void',   name: 'Void',      blurb: 'Deep violet.',             rarity: 'epic',   source: { type: 'credits', price: 1500 }, bg: 'radial-gradient(circle at 30% 20%,#4c1d95,#06010f)',                accent: '#a78bfa' },
  { id: 'card.gold',   name: 'Gilded',    blurb: 'For the elite.',           rarity: 'epic',   source: { type: 'level', level: 20 },     bg: 'linear-gradient(135deg,#854d0e,#1c1206)',                          accent: '#fbbf24' },
];

export function cardById(id: string): CardCosmetic {
  return CARD_STYLES.find((c) => c.id === id) ?? CARD_STYLES[0];
}
export function isCard(id: string): boolean {
  return CARD_STYLES.some((c) => c.id === id);
}

// ── Emote slot ───────────────────────────────────────────────────────────────
// A celebratory animation your character plays on the end-of-match podium (and,
// later, as an in-lobby/taunt). Procedural (bone-driven) — see podium.ts.
export const DEFAULT_EMOTE = 'emote.cheer';

export type EmoteKind = 'idle' | 'cheer' | 'wave' | 'flex' | 'spin' | 'dance';

export type EmoteCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  kind: EmoteKind;
};

export const EMOTES: readonly EmoteCosmetic[] = [
  { id: 'emote.cheer', name: 'Victory Cheer', blurb: 'Arms up, jumping for joy.', rarity: 'common', source: { type: 'default' },             kind: 'cheer' },
  { id: 'emote.wave',  name: 'Wave',          blurb: 'A friendly hello.',          rarity: 'rare',   source: { type: 'level', level: 3 },      kind: 'wave' },
  { id: 'emote.flex',  name: 'Flex',          blurb: 'Show off those gains.',      rarity: 'rare',   source: { type: 'credits', price: 500 },  kind: 'flex' },
  { id: 'emote.spin',  name: 'Spin',          blurb: 'Round and round.',           rarity: 'rare',   source: { type: 'level', level: 8 },      kind: 'spin' },
  { id: 'emote.dance', name: 'Disco',         blurb: 'Hips and hands, all night.', rarity: 'epic',   source: { type: 'credits', price: 1200 }, kind: 'dance' },
];

export function emoteById(id: string): EmoteCosmetic {
  return EMOTES.find((e) => e.id === id) ?? EMOTES[0];
}
export function isEmote(id: string): boolean {
  return EMOTES.some((e) => e.id === id);
}

// ── Cross-slot helpers (the seam the progression backend reads) ──────────────
export type CosmeticSlot = 'killEffect' | 'railColor' | 'hat' | 'unusual' | 'card' | 'emote';

// Each catalog entry tagged with its slot, so a single id-keyed lookup works
// across all slots. Future slots (name color…) concat here.
export type CatalogEntry =
  | (KillEffectCosmetic & { slot: 'killEffect' })
  | (RailColorCosmetic & { slot: 'railColor' })
  | (HatCosmetic & { slot: 'hat' })
  | (UnusualCosmetic & { slot: 'unusual' })
  | (CardCosmetic & { slot: 'card' })
  | (EmoteCosmetic & { slot: 'emote' });

export const ALL_COSMETICS: readonly CatalogEntry[] = [
  ...KILL_EFFECTS.map((c) => ({ ...c, slot: 'killEffect' as const })),
  ...RAIL_COLORS.map((c) => ({ ...c, slot: 'railColor' as const })),
  ...HATS.map((c) => ({ ...c, slot: 'hat' as const })),
  ...UNUSUALS.map((c) => ({ ...c, slot: 'unusual' as const })),
  ...CARD_STYLES.map((c) => ({ ...c, slot: 'card' as const })),
  ...EMOTES.map((c) => ({ ...c, slot: 'emote' as const })),
];

export function cosmeticById(id: string): CatalogEntry | undefined {
  return ALL_COSMETICS.find((c) => c.id === id);
}

// IDs everyone owns from the start (source: default) — across all slots.
export function defaultUnlockedIds(): string[] {
  return ALL_COSMETICS.filter((c) => c.source.type === 'default').map((c) => c.id);
}

// IDs a player is entitled to purely by having reached `level` (milestone
// unlocks). Used server-side to grant new unlocks on level-up.
export function levelGrantsAt(level: number): string[] {
  return ALL_COSMETICS.filter(
    (c) => c.source.type === 'level' && c.source.level <= level,
  ).map((c) => c.id);
}

// The slot a cosmetic id occupies (for the equipped map + equip validation).
export function slotOf(id: string): CosmeticSlot {
  return cosmeticById(id)?.slot ?? 'killEffect';
}

// Short human label for a cosmetic's unlock requirement (used in the Locker UI).
export function sourceLabel(source: CosmeticSource): string {
  switch (source.type) {
    case 'default':
      return 'Default';
    case 'level':
      return `Level ${source.level}`;
    case 'credits':
      return `${source.price} credits`;
  }
}
