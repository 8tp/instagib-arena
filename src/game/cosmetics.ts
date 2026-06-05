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

// A career-stat an achievement-earned cosmetic (titles) keys off. Evaluated
// server-side against the player's clamped aggregate stats (see titleGrantsFrom).
export type AchievementStat = 'kills' | 'headshots' | 'wins' | 'bestStreak' | 'games' | 'accuracy';

// How a cosmetic is obtained. `default` = owned by everyone; `level` = unlocked
// by reaching an account level (prestige, can't be bought); `credits` = bought
// in the Locker with earned credits (player choice); `achievement` = earned by
// crossing a career-stat milestone (titles). A cosmetic is one source only,
// never several, to avoid "I leveled to it AND paid for it" feel-bad.
export type CosmeticSource =
  | { type: 'default' }
  | { type: 'level'; level: number }
  | { type: 'credits'; price: number }
  | { type: 'achievement'; stat: AchievementStat; min: number; minGames?: number }
  | { type: 'admin' }; // staff-exclusive: auto-granted to admins, never earnable/buyable

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
  { id: 'rail.admin',  name: 'Sovereign', blurb: 'Staff-gold rail — admin only.', rarity: 'epic', source: { type: 'admin' },              data: { core: 0xfff6d0, helix: 0xffd700 } },
];

export function railColorById(id: string): RailColorCosmetic {
  return RAIL_COLORS.find((c) => c.id === id) ?? RAIL_COLORS[0];
}
export function isRailColor(id: string): boolean {
  return RAIL_COLORS.some((c) => c.id === id);
}

// ── Railgun-finish slot ──────────────────────────────────────────────────────
// Recolors the local player's first-person railgun viewmodel (the procedural
// gun in weapon-model.ts). Local-only, exactly like the rail-beam color — you
// see your own gun skin; it's never a gameplay advantage. `gun.stock` is the
// default look (the original constants in weapon-model.ts).
export const DEFAULT_RAILGUN_FINISH = 'gun.stock';

export type RailgunFinish = {
  body: number; // dark receiver
  metal: number; // gunmetal
  metalLt: number; // lighter frame edges
  accent: number; // energy rail base color
  accentHot: number; // bright energy color
};

export type RailgunFinishCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  data: RailgunFinish;
};

export const RAILGUN_FINISHES: readonly RailgunFinishCosmetic[] = [
  { id: 'gun.stock',   name: 'Standard Issue', blurb: 'The factory gunmetal-and-cyan rail.', rarity: 'common', source: { type: 'default' },              data: { body: 0x171b22, metal: 0x2c333f, metalLt: 0x515d6e, accent: 0x37a6ff, accentHot: 0x8af2ff } },
  { id: 'gun.crimson', name: 'Crimson',        blurb: 'Blackened frame, hot red rails.',     rarity: 'rare',   source: { type: 'level', level: 6 },       data: { body: 0x1a1012, metal: 0x33252a, metalLt: 0x6e515a, accent: 0xff3b4e, accentHot: 0xff9aa6 } },
  { id: 'gun.toxic',   name: 'Biohazard',      blurb: 'Acid-green accelerator rails.',       rarity: 'rare',   source: { type: 'level', level: 11 },      data: { body: 0x121a14, metal: 0x29332b, metalLt: 0x51604f, accent: 0x6fff3b, accentHot: 0xc6ffaa } },
  { id: 'gun.carbon',  name: 'Carbon',         blurb: 'Matte-black with a white-hot core.',  rarity: 'rare',   source: { type: 'credits', price: 1200 },  data: { body: 0x0c0e12, metal: 0x1c2026, metalLt: 0x3a414b, accent: 0xdfe8f4, accentHot: 0xffffff } },
  { id: 'gun.gold',    name: 'Midas',          blurb: 'A gilded receiver fit for a champ.',  rarity: 'epic',   source: { type: 'credits', price: 2200 },  data: { body: 0x241a08, metal: 0x6e5520, metalLt: 0xb0902f, accent: 0xffd24a, accentHot: 0xfff4c0 } },
  { id: 'gun.void',    name: 'Void',           blurb: 'Deep-violet frame, arc-light rails.', rarity: 'epic',   source: { type: 'credits', price: 2800 },  data: { body: 0x12081a, metal: 0x271333, metalLt: 0x4c2d75, accent: 0xa855f7, accentHot: 0xe9d5ff } },
  { id: 'gun.admin',   name: 'Regalia',        blurb: 'Gilded staff rail — admin only.',     rarity: 'epic',   source: { type: 'admin' },                 data: { body: 0x2a2208, metal: 0x7a5f15, metalLt: 0xd4af37, accent: 0xffe9a0, accentHot: 0xffffff } },
];

export function railgunFinishById(id: string): RailgunFinishCosmetic {
  return RAILGUN_FINISHES.find((c) => c.id === id) ?? RAILGUN_FINISHES[0];
}
export function isRailgunFinish(id: string): boolean {
  return RAILGUN_FINISHES.some((c) => c.id === id);
}

// ── Name-color slot ──────────────────────────────────────────────────────────
// Tints the floating nameplate other players see above your head (and your row
// on the scoreboard). Broadcast in snapshots like the hat. TDM team colors take
// precedence over this so teams stay readable. `name.default` is the stock blue.
export const DEFAULT_NAME_COLOR = 'name.default';

export type NameColorCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  color: string; // hex string for canvas/CSS
};

export const NAME_COLORS: readonly NameColorCosmetic[] = [
  { id: 'name.default', name: 'Frost',   blurb: 'The stock icy blue.',     rarity: 'common', source: { type: 'default' },             color: '#c7e0ff' },
  { id: 'name.gold',    name: 'Gold',    blurb: 'A name worth its weight.', rarity: 'rare',   source: { type: 'level', level: 7 },      color: '#ffd24a' },
  { id: 'name.crimson', name: 'Crimson', blurb: 'See red.',                 rarity: 'rare',   source: { type: 'level', level: 13 },     color: '#ff5566' },
  { id: 'name.toxic',   name: 'Toxic',   blurb: 'Radioactive handle.',      rarity: 'rare',   source: { type: 'credits', price: 700 },  color: '#86ff5a' },
  { id: 'name.violet',  name: 'Violet',  blurb: 'Royalty in the arena.',    rarity: 'epic',   source: { type: 'credits', price: 1400 }, color: '#c08aff' },
  { id: 'name.white',   name: 'Pristine',blurb: 'Pure, clean, unmissable.', rarity: 'epic',   source: { type: 'level', level: 22 },     color: '#ffffff' },
  { id: 'name.admin',   name: 'Sovereign',blurb: 'Staff gold — admin only.', rarity: 'epic',  source: { type: 'admin' },                color: '#ffd700' },
];

export function nameColorById(id: string): NameColorCosmetic {
  return NAME_COLORS.find((c) => c.id === id) ?? NAME_COLORS[0];
}
export function isNameColor(id: string): boolean {
  return NAME_COLORS.some((c) => c.id === id);
}

// ── Spawn-effect slot ────────────────────────────────────────────────────────
// A materialize burst that plays where a player (re)spawns. Broadcast like the
// hat so others see you warp in (and you see them). Each style is a recipe in
// EffectsManager.spawnInBurst(). `spawn.beam` is the free default.
export type SpawnEffectStyle = 'beam' | 'ring' | 'ember' | 'rift';
export const DEFAULT_SPAWN_EFFECT = 'spawn.beam';

export type SpawnEffectCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  style: SpawnEffectStyle;
};

export const SPAWN_EFFECTS: readonly SpawnEffectCosmetic[] = [
  { id: 'spawn.beam',  name: 'Teleport',   blurb: 'A column of light and a ground ring.',   rarity: 'common', source: { type: 'default' },             style: 'beam' },
  { id: 'spawn.ring',  name: 'Shockwave',  blurb: 'A hard expanding ground ring + flash.',  rarity: 'rare',   source: { type: 'level', level: 9 },      style: 'ring' },
  { id: 'spawn.ember', name: 'Cinder',     blurb: 'Materialize from a swirl of embers.',    rarity: 'rare',   source: { type: 'credits', price: 900 },  style: 'ember' },
  { id: 'spawn.rift',  name: 'Rift',       blurb: 'Tear in from a violet singularity.',     rarity: 'epic',   source: { type: 'credits', price: 1600 }, style: 'rift' },
];

export function spawnEffectById(id: string): SpawnEffectCosmetic {
  return SPAWN_EFFECTS.find((c) => c.id === id) ?? SPAWN_EFFECTS[0];
}
export function isSpawnEffect(id: string): boolean {
  return SPAWN_EFFECTS.some((c) => c.id === id);
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
  // Extra size multiplier on the auto-fit (default 1). Low-profile hats whose
  // brim dominates the auto-fit width (cap, propeller) shrink their on-head crown
  // to a faint skullcap — bumping this makes them read at a glance.
  fit?: number;
  // Metres to drop the hat down onto the head (default 0). Brim/skull-cap hats
  // anchor their bounding-box floor (a low brim) at the crown, so they perch too
  // high; `sink` settles them down around the head. Tuned in /hatgrid.
  sink?: number;
  // Vertical (Y) scale multiplier (default 1). Hats whose silhouette is defined
  // by HEIGHT (top hat) get squashed flat by the width-based auto-fit — a stretch
  // restores their proportions without touching width. Tuned in /hatgrid.
  stretch?: number;
  // Yaw (radians) to spin the model so its brim faces the wearer's front. The
  // CC0 models don't share a forward axis, so this is per-hat. Default 0.
  yaw?: number;
};

export const HATS: readonly HatCosmetic[] = [
  { id: 'hat.none',       name: 'Bare Head',      blurb: 'No hat — classic.',                      rarity: 'common', source: { type: 'default' },             model: null },
  { id: 'hat.cap',        name: 'Cap',            blurb: 'A simple ballcap.',                       rarity: 'common', source: { type: 'default' },             model: `${HAT_DIR}/cap.glb`, fit: 0.92, sink: -0.07, yaw: Math.PI / 2 },
  { id: 'hat.baseball',   name: 'Ballcap Pro',    blurb: 'The fitted classic.',                    rarity: 'common', source: { type: 'level', level: 2 },     model: `${HAT_DIR}/baseball-cap.glb`, fit: 1.05, sink: -0.01, yaw: Math.PI },
  { id: 'hat.hardhat',    name: 'Hard Hat',       blurb: 'Safety first, fragging second.',         rarity: 'rare',   source: { type: 'credits', price: 400 }, model: `${HAT_DIR}/hard-hat.glb`, fit: 0.94, sink: -0.04 },
  { id: 'hat.graduation', name: 'Graduate',       blurb: 'Top of the class.',                      rarity: 'rare',   source: { type: 'level', level: 5 },     model: `${HAT_DIR}/graduation-cap.glb`, fit: 0.86, sink: 0.03 },
  { id: 'hat.tophat',     name: 'Top Hat',        blurb: 'Distinguished destruction.',             rarity: 'epic',   source: { type: 'credits', price: 1000 }, model: `${HAT_DIR}/top-hat.glb`, fit: 0.86, sink: 0.03, stretch: 1.45 },
  { id: 'hat.propeller',  name: 'Propeller Cap',  blurb: 'Beanie with a spin.',                    rarity: 'epic',   source: { type: 'level', level: 14 },    model: `${HAT_DIR}/propeller-hat.glb`, fit: 0.92, sink: -0.05 },
  { id: 'hat.wizard',     name: 'Wizard Hat',     blurb: 'One-shot, one spell.',                   rarity: 'epic',   source: { type: 'credits', price: 1800 }, model: `${HAT_DIR}/wizard-hat.glb`, fit: 0.84, sink: 0.0, stretch: 1.08 },
  { id: 'hat.crown',      name: 'Crown',          blurb: 'Royalty in the arena — staff only.',     rarity: 'epic',   source: { type: 'admin' },               model: `${HAT_DIR}/crown.glb`, fit: 0.78, sink: 0.03 },
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

export type UnusualKind = 'none' | 'embers' | 'orbit' | 'halo' | 'storm' | 'aura';

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
  { id: 'unusual.aura',   name: 'Sovereign Aura',blurb: 'A regal ring of golden motes — staff only.', rarity: 'epic', source: { type: 'admin' },         kind: 'aura' },
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

// Droppable hats (everything but bare-head and staff-exclusive items), the
// case's pool — admin cosmetics never drop from a credits-funded case.
export function caseHats(): HatCosmetic[] {
  return HATS.filter((h) => h.model && h.source.type !== 'admin');
}

// ── Player-card slot ─────────────────────────────────────────────────────────
// A card graphic shown on kill (Valorant-style): the VICTIM sees the killer's
// card (background + level + the killer's chosen stats) on the killcam, and you
// see your own as a kill-confirm flourish. `bg`/`accent` are CSS for the card.
export const DEFAULT_CARD = 'card.slate';

// Optional motion layer drawn over the card's static `bg`. Pure CSS (see the
// .pcard-anim-* classes in src/index.css); the static gradient stays the base so
// the card is always legible, and the animation is suppressed under reduced
// effects / prefers-reduced-motion. `undefined` = a plain static card.
export type CardAnim = 'holo' | 'shimmer' | 'pulse' | 'aurora' | 'scan';

export type CardCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
  bg: string; // CSS background (gradient)
  accent: string; // hex accent for the level badge + stat numbers
  anim?: CardAnim; // optional animated overlay (epic+ tier)
};

export const CARD_STYLES: readonly CardCosmetic[] = [
  { id: 'card.slate',  name: 'Slate',     blurb: 'Clean gunmetal.',           rarity: 'common', source: { type: 'default' },              bg: 'linear-gradient(135deg,#1e293b,#0b1220)',                          accent: '#67e8f9' },
  { id: 'card.ember',  name: 'Ember',     blurb: 'Molten edges.',             rarity: 'rare',   source: { type: 'level', level: 4 },      bg: 'linear-gradient(135deg,#7c2d12,#180a05)',                          accent: '#fb923c' },
  { id: 'card.toxic',  name: 'Toxic',     blurb: 'Acid wash.',                rarity: 'rare',   source: { type: 'credits', price: 600 },  bg: 'linear-gradient(135deg,#14532d,#05140a)',                          accent: '#86efac' },
  { id: 'card.cyber',  name: 'Cyber',     blurb: 'Neon grid.',                rarity: 'rare',   source: { type: 'level', level: 10 },     bg: 'linear-gradient(135deg,#0e7490,#3b0764)',                          accent: '#22d3ee' },
  { id: 'card.void',   name: 'Void',      blurb: 'Deep violet, slow aurora.', rarity: 'epic',   source: { type: 'credits', price: 1500 }, bg: 'radial-gradient(circle at 30% 20%,#4c1d95,#06010f)',                accent: '#a78bfa', anim: 'aurora' },
  { id: 'card.gold',   name: 'Gilded',    blurb: 'A drifting golden sheen.',  rarity: 'epic',   source: { type: 'level', level: 20 },     bg: 'linear-gradient(135deg,#854d0e,#1c1206)',                          accent: '#fbbf24', anim: 'shimmer' },
  { id: 'card.admin',  name: 'Sovereign', blurb: 'Staff only — holographic.', rarity: 'epic',   source: { type: 'admin' },                bg: 'linear-gradient(135deg,#3a2c05,#0c0a04)',                          accent: '#ffd700', anim: 'holo' },
  // Animated tier — the card slot's premium upgrade. Each pairs a static base
  // gradient with a CSS motion layer (.pcard-anim-*).
  { id: 'card.prism',  name: 'Prism',     blurb: 'A rotating holographic foil.', rarity: 'epic', source: { type: 'credits', price: 2600 }, bg: 'linear-gradient(135deg,#0b1220,#1e1b4b)',                         accent: '#a5f3fc', anim: 'holo' },
  { id: 'card.nebula', name: 'Nebula',    blurb: 'Living violet-teal aurora.',   rarity: 'epic', source: { type: 'level', level: 28 },     bg: 'radial-gradient(circle at 70% 30%,#155e75,#1e1b4b 60%,#05010f)',  accent: '#67e8f9', anim: 'aurora' },
  { id: 'card.matrix', name: 'Matrix',    blurb: 'Scrolling neon scanlines.',    rarity: 'epic', source: { type: 'credits', price: 2200 }, bg: 'linear-gradient(135deg,#022c22,#03140f)',                        accent: '#4ade80', anim: 'scan' },
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

// ── Title / flair slot ───────────────────────────────────────────────────────
// An earned text "flair" shown UNDER the player's name on the in-world nameplate
// (small + faint), beside their row on the scoreboard, and on their playercard.
// Titles are ACHIEVEMENT-earned — granted when a career-stat milestone is crossed
// (see titleGrantsFrom, evaluated server-side from clamped aggregate stats) — so
// they read as a badge of what you've actually done. `title.none` is the free
// default (no flair).
export const DEFAULT_TITLE = 'title.none';

export type TitleCosmetic = {
  id: string;
  name: string; // Locker label
  blurb: string; // Locker description / unlock hint
  rarity: Rarity;
  source: CosmeticSource;
  text: string; // the flair text actually displayed ('' = no title)
};

export const TITLES: readonly TitleCosmetic[] = [
  { id: 'title.none',         name: 'No Title',     blurb: 'No flair under your name.',                     rarity: 'common', source: { type: 'default' },                                              text: '' },
  { id: 'title.centurion',    name: 'Centurion',    blurb: 'Land 100 career frags.',                        rarity: 'common', source: { type: 'achievement', stat: 'kills', min: 100 },                  text: 'Centurion' },
  { id: 'title.executioner',  name: 'Executioner',  blurb: 'Land 1,000 career frags.',                      rarity: 'rare',   source: { type: 'achievement', stat: 'kills', min: 1000 },                 text: 'Executioner' },
  { id: 'title.railgod',      name: 'Rail God',     blurb: 'Land 5,000 career frags.',                      rarity: 'epic',   source: { type: 'achievement', stat: 'kills', min: 5000 },                 text: 'Rail God' },
  { id: 'title.headhunter',   name: 'Headhunter',   blurb: 'Land 500 career headshots.',                    rarity: 'rare',   source: { type: 'achievement', stat: 'headshots', min: 500 },              text: 'Headhunter' },
  { id: 'title.champion',     name: 'Champion',     blurb: 'Win 50 matches.',                               rarity: 'rare',   source: { type: 'achievement', stat: 'wins', min: 50 },                    text: 'Champion' },
  { id: 'title.untouchable',  name: 'Untouchable',  blurb: 'Reach a 20-frag streak.',                       rarity: 'rare',   source: { type: 'achievement', stat: 'bestStreak', min: 20 },              text: 'Untouchable' },
  { id: 'title.sharpshooter', name: 'Sharpshooter', blurb: 'Finish a match at 50%+ accuracy (20+ games).',  rarity: 'rare',   source: { type: 'achievement', stat: 'accuracy', min: 50, minGames: 20 },  text: 'Sharpshooter' },
  { id: 'title.veteran',      name: 'Veteran',      blurb: 'Play 200 matches.',                             rarity: 'common', source: { type: 'achievement', stat: 'games', min: 200 },                  text: 'Veteran' },
  { id: 'title.sovereign',    name: 'Sovereign',    blurb: 'Staff only.',                                   rarity: 'epic',   source: { type: 'admin' },                                                text: 'Sovereign' },
];

export function titleById(id: string): TitleCosmetic {
  return TITLES.find((t) => t.id === id) ?? TITLES[0];
}
export function isTitle(id: string): boolean {
  return TITLES.some((t) => t.id === id);
}

// Career aggregate the achievement titles evaluate against (server-side, from the
// player's clamped stats). `accuracy` is best single-match accuracy (0..100).
export type TitleStats = {
  kills: number;
  headshots: number;
  wins: number;
  bestStreak: number;
  games: number;
  accuracy: number;
};

// IDs a player has earned purely from career stats (achievement titles). Used
// server-side to grant titles on match record and client-side to label locked
// items. default/admin/level/credits titles are never granted here.
export function titleGrantsFrom(stats: TitleStats): string[] {
  return TITLES.filter((t) => {
    if (t.source.type !== 'achievement') return false;
    const s = t.source;
    if (s.minGames != null && stats.games < s.minGames) return false;
    const val =
      s.stat === 'kills'
        ? stats.kills
        : s.stat === 'headshots'
          ? stats.headshots
          : s.stat === 'wins'
            ? stats.wins
            : s.stat === 'bestStreak'
              ? stats.bestStreak
              : s.stat === 'games'
                ? stats.games
                : stats.accuracy;
    return val >= s.min;
  }).map((t) => t.id);
}

// ── Cross-slot helpers (the seam the progression backend reads) ──────────────
export type CosmeticSlot =
  | 'killEffect'
  | 'railColor'
  | 'railgunFinish'
  | 'hat'
  | 'unusual'
  | 'card'
  | 'emote'
  | 'nameColor'
  | 'spawnEffect'
  | 'title';

// Each catalog entry tagged with its slot, so a single id-keyed lookup works
// across all slots. Future slots (name color…) concat here.
export type CatalogEntry =
  | (KillEffectCosmetic & { slot: 'killEffect' })
  | (RailColorCosmetic & { slot: 'railColor' })
  | (RailgunFinishCosmetic & { slot: 'railgunFinish' })
  | (HatCosmetic & { slot: 'hat' })
  | (UnusualCosmetic & { slot: 'unusual' })
  | (CardCosmetic & { slot: 'card' })
  | (EmoteCosmetic & { slot: 'emote' })
  | (NameColorCosmetic & { slot: 'nameColor' })
  | (SpawnEffectCosmetic & { slot: 'spawnEffect' })
  | (TitleCosmetic & { slot: 'title' });

export const ALL_COSMETICS: readonly CatalogEntry[] = [
  ...KILL_EFFECTS.map((c) => ({ ...c, slot: 'killEffect' as const })),
  ...RAIL_COLORS.map((c) => ({ ...c, slot: 'railColor' as const })),
  ...RAILGUN_FINISHES.map((c) => ({ ...c, slot: 'railgunFinish' as const })),
  ...HATS.map((c) => ({ ...c, slot: 'hat' as const })),
  ...UNUSUALS.map((c) => ({ ...c, slot: 'unusual' as const })),
  ...CARD_STYLES.map((c) => ({ ...c, slot: 'card' as const })),
  ...EMOTES.map((c) => ({ ...c, slot: 'emote' as const })),
  ...NAME_COLORS.map((c) => ({ ...c, slot: 'nameColor' as const })),
  ...SPAWN_EFFECTS.map((c) => ({ ...c, slot: 'spawnEffect' as const })),
  ...TITLES.map((c) => ({ ...c, slot: 'title' as const })),
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
    case 'achievement': {
      const games = source.minGames ? ` (${source.minGames}+ games)` : '';
      switch (source.stat) {
        case 'kills':
          return `${source.min.toLocaleString()} frags`;
        case 'headshots':
          return `${source.min.toLocaleString()} headshots`;
        case 'wins':
          return `${source.min} wins`;
        case 'bestStreak':
          return `${source.min}-frag streak`;
        case 'games':
          return `${source.min} matches played`;
        case 'accuracy':
          return `${source.min}% match accuracy${games}`;
      }
      return 'Achievement';
    }
    case 'admin':
      return 'Admin';
  }
}
