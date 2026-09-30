// Cosmetic catalog (THREE-free, shared client+server). Definitions live in code
// as a static manifest — the DB only ever stores unlocked IDs + the equipped
// selection (see docs/progression.md §5). Everything here is purely visual:
// nothing in this file may affect movement, hit detection, or weapon balance.
//
// v1 ships the kill-effect slot end-to-end (the "explosion when you frag
// someone" — modelled on Ratz Instagib's selectable death animations and
// Quakecraft's firework "barrels"). Future slots (rail beam color, crosshair,
// name color, announcer) slot in next to KILL_EFFECTS using the same shape.

// Four tiers (Fortnite-style colour language in the Locker): grey / blue /
// purple / gold. Legendary = the showpieces (unusuals, top finishers).
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export const RARITIES: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary'];

// A career-stat an achievement-earned cosmetic (titles) keys off. Evaluated
// server-side against the player's clamped aggregate stats (see titleGrantsFrom).
export type AchievementStat = 'kills' | 'headshots' | 'wins' | 'bestStreak' | 'games' | 'accuracy';

// How a cosmetic is obtained. `default` = owned by everyone; `level` = unlocked
// by reaching an account level — it sits on the Career Road at exactly that
// level (progression.ts derives the road from these; prestige, can't be bought);
// `credits` = bought in the Locker with earned credits (player choice);
// `achievement` = earned by crossing a career-stat milestone (titles); `case` =
// only drops from the hat case (see HAT_CASE_COST). A cosmetic is one source
// only, never several, to avoid "I leveled to it AND paid for it" feel-bad.
//
// Rarity ↔ value bands (keep new items inside them):
//   common    — credits 300–500,     or road levels ~2–15
//   rare      — credits 600–1,000,   or road levels ~5–45
//   epic      — credits 1,200–2,200, or road levels ~25–70
//   legendary — credits 2,800–5,000, road 50/62/71/75/80/90/100, or the case jackpot
export type CosmeticSource =
  | { type: 'default' }
  | { type: 'level'; level: number }
  | { type: 'credits'; price: number }
  | { type: 'achievement'; stat: AchievementStat; min: number; minGames?: number }
  | { type: 'case' } // case-exclusive: only ever drops from the hat case (the "jackpot")
  | { type: 'admin' }; // staff-exclusive: auto-granted to admins, never earnable/buyable

// ── Kill-effect slot ("Finisher") ─────────────────────────────────────────────
// How your victims die: the KILLER's equipped finisher picks both the death
// animation (how the body breaks apart — character/gibs.ts) and the burst
// (EffectsManager.spawnKillBurst). Broadcast: the server stamps the killer's
// finisher on every kill, so the victim and bystanders see it too.
export type KillEffectStyle =
  | 'pulse'
  | 'nova'
  | 'starburst'
  | 'voxel'
  | 'ember'
  | 'gibstorm'
  | 'singularity'
  | 'prism'
  | 'derez'
  | 'shatter'
  | 'confetti'
  | 'overload'
  | 'vaporize';

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
  { id: 'nova',        name: 'Nova',        blurb: 'A blooming energy bloom with twin shockwave rings.',    rarity: 'rare',   source: { type: 'level', level: 9 } },
  { id: 'starburst',   name: 'Starburst',   blurb: 'A radial star of light spikes fired outward.',          rarity: 'rare',   source: { type: 'level', level: 21 } },
  { id: 'voxel',       name: 'Voxel',       blurb: 'Shatters the target into a burst of glowing cubes.',    rarity: 'rare',   source: { type: 'credits', price: 800 } },
  { id: 'ember',       name: 'Pyre',        blurb: 'A rising column of embers and drifting sparks.',         rarity: 'rare',   source: { type: 'credits', price: 800 } },
  { id: 'gibstorm',    name: 'Gibstorm',    blurb: 'A violent, heavy shard explosion that rains down.',      rarity: 'epic',   source: { type: 'level', level: 43 } },
  { id: 'singularity', name: 'Singularity', blurb: 'Collapses inward to a point, then detonates white-hot.', rarity: 'legendary', source: { type: 'credits', price: 3000 } },
  // Finisher wave 2 — full death animations (Ratz-Instagib flavoured).
  { id: 'shatter',     name: 'Glass Jaw',   blurb: 'The body shatters like glass into glinting shards.',     rarity: 'rare',      source: { type: 'credits', price: 900 } },
  { id: 'confetti',    name: 'Party Foul',  blurb: 'Pops like a party cannon: confetti and streamers.',      rarity: 'rare',      source: { type: 'level', level: 37 } },
  { id: 'derez',       name: 'Derez',       blurb: 'Sliced into glowing bands that scatter and blink out.',  rarity: 'epic',      source: { type: 'level', level: 59 } },
  { id: 'vaporize',    name: 'Vaporize',    blurb: 'Flash-burned to ash that drifts away on the wind.',      rarity: 'epic',      source: { type: 'credits', price: 1800 } },
  { id: 'overload',    name: 'Overload',    blurb: 'Arcs rip through the armour, then a blue-white blast.',  rarity: 'epic',      source: { type: 'credits', price: 2200 } },
  { id: 'prism',       name: 'Prism',       blurb: 'Detonates into a spray of rainbow shards and rings.',    rarity: 'legendary', source: { type: 'level', level: 75 } },
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
  // 'spectrum' = the helix hue cycles along the beam (rail-beam.ts shader).
  // 'gilded' = pale white-gold rings (kept off full saturation).
  mode?: 'spectrum' | 'gilded';
};

export const RAIL_COLORS: readonly RailColorCosmetic[] = [
  { id: 'rail.cyan',   name: 'Cyan',   blurb: 'The stock blue-cyan twin rail.', rarity: 'common', source: { type: 'default' },             data: { core: 0xd6f4ff, helix: 0x37a6ff } },
  { id: 'rail.plasma', name: 'Plasma', blurb: 'Hot magenta-violet beam.',       rarity: 'rare',   source: { type: 'level', level: 5 },      data: { core: 0xffd9ff, helix: 0xc23bff } },
  { id: 'rail.toxic',  name: 'Toxic',  blurb: 'Acid-green tracer.',             rarity: 'rare',   source: { type: 'level', level: 23 },      data: { core: 0xe8ffd6, helix: 0x6fff3b } },
  { id: 'rail.ember',  name: 'Ember',  blurb: 'Molten orange-red beam.',        rarity: 'rare',   source: { type: 'credits', price: 600 },  data: { core: 0xffd0b0, helix: 0xff4410 } },
  { id: 'rail.gold',   name: 'Gold',   blurb: 'A regal gold beam.',             rarity: 'epic',   source: { type: 'credits', price: 1800 }, data: { core: 0xffe6a8, helix: 0xffb000 } },
  { id: 'rail.admin',  name: 'Sovereign', blurb: 'Staff-gold rail — admin only.', rarity: 'epic', source: { type: 'admin' },              data: { core: 0xffffff, helix: 0xffd700 }, mode: 'gilded' },
  { id: 'rail.white',  name: 'Pure',     blurb: 'A clean white-hot rail.',              rarity: 'common', source: { type: 'case' }, data: { core: 0xffffff, helix: 0xdfe8ff } },
  { id: 'rail.crimson', name: 'Crimson', blurb: 'A blood-red tracer.',                  rarity: 'common', source: { type: 'case' }, data: { core: 0xffd6d6, helix: 0xff2a3c } },
  { id: 'rail.ratz',   name: 'Ratz',     blurb: 'Hot-pink neon, straight out of 2003.', rarity: 'epic',   source: { type: 'credits', price: 1500 }, data: { core: 0xffd6f4, helix: 0xff2bd6 } },
  { id: 'rail.void',   name: 'Void',     blurb: 'A deep violet slash of light.',        rarity: 'rare',   source: { type: 'level', level: 45 },     data: { core: 0xd9d0ff, helix: 0x5a3cff } },
  { id: 'rail.spectrum', name: 'Spectrum', blurb: 'The helix cycles through every hue.', rarity: 'legendary', source: { type: 'level', level: 50 }, data: { core: 0xffffff, helix: 0xff4fd8 }, mode: 'spectrum' },
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

// Surface pattern / material treatment a finish applies on top of its palette
// (rendered in weapon-model.ts). 'plain' (default) = the palette on stock PBR.
export type FinishPattern = 'plain' | 'carbon' | 'hex' | 'hazard' | 'plasma' | 'spectrum' | 'digital' | 'ceramic' | 'enamel' | 'void';

export type RailgunFinish = {
  body: number; // dark receiver
  metal: number; // gunmetal
  metalLt: number; // lighter frame edges
  accent: number; // energy rail base color
  accentHot: number; // bright energy color
  pattern?: FinishPattern;
  // Economy v3: high-tier finishes swap in a CUSTOM gun model (geometry +
  // VFX; src/game/gun/custom/). Absent = the standard railgun.
  model?: string;
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
  { id: 'gun.crimson', name: 'Crimson',        blurb: 'Blackened frame, hot red rails.',     rarity: 'rare',   source: { type: 'level', level: 15 },       data: { body: 0x4a0710, metal: 0x2a2226, metalLt: 0x9a2433, accent: 0xff2438, accentHot: 0xff8c8c } },
  { id: 'gun.toxic',   name: 'Biohazard',      blurb: 'Acid-green accelerator rails.',       rarity: 'rare',   source: { type: 'level', level: 31 },      data: { body: 0x121a14, metal: 0x29332b, metalLt: 0x51604f, accent: 0x6fff3b, accentHot: 0xc6ffaa } },
  { id: 'gun.carbon',  name: 'Carbon',         blurb: 'Matte-black with a white-hot core.',  rarity: 'rare',   source: { type: 'credits', price: 1000 },  data: { body: 0x0c0e12, metal: 0x1c2026, metalLt: 0x3a414b, accent: 0xdfe8f4, accentHot: 0xffffff, pattern: 'carbon' } },
  { id: 'gun.gold',    name: 'Midas',          blurb: 'A gilded receiver fit for a champ.',  rarity: 'epic',   source: { type: 'credits', price: 2200 },  data: { body: 0x241a08, metal: 0x6e5520, metalLt: 0xb0902f, accent: 0xffd24a, accentHot: 0xfff4c0 } },
  { id: 'gun.void',    name: 'Void',           blurb: 'Deep-violet frame, arc-light rails.', rarity: 'epic',   source: { type: 'credits', price: 1800 },  data: { body: 0x0b0718, metal: 0x1a1233, metalLt: 0x5a3cff, accent: 0x6a4cff, accentHot: 0xd6ccff, pattern: 'void' } },
  { id: 'gun.admin',   name: 'Sovereign Regalia', blurb: 'The staff railgun: gilded, crowned, humming with power — staff only.', rarity: 'epic', source: { type: 'admin' }, data: { body: 0xf1ece0, metal: 0xb88a22, metalLt: 0xf0c95a, accent: 0xffd24a, accentHot: 0xfff4d0, pattern: 'enamel', model: 'sovereign' } },
  // Finish wave 2 — patterned / animated treatments.
  { id: 'gun.arctic',  name: 'Arctic',         blurb: 'White ceramic plates, ice-blue rails.', rarity: 'rare',     source: { type: 'level', level: 41 },      data: { body: 0xc9d3dc, metal: 0x8b98a6, metalLt: 0xeef3f7, accent: 0x6fd6ff, accentHot: 0xe0f7ff, pattern: 'ceramic' } },
  { id: 'gun.hazard',  name: 'Hazard',         blurb: 'Industrial chevrons. Handle with care.', rarity: 'rare',    source: { type: 'credits', price: 900 },  data: { body: 0x1a1a14, metal: 0x3a3a30, metalLt: 0xd9b400, accent: 0xffc400, accentHot: 0xfff0a0, pattern: 'hazard' } },
  { id: 'gun.ratz',    name: 'Ratz',           blurb: 'Hex-plated neon, pink and cyan.',        rarity: 'epic',    source: { type: 'credits', price: 2000 },  data: { body: 0x15101c, metal: 0x2a1f38, metalLt: 0xff5fcf, accent: 0xff3ec8, accentHot: 0x9ff8ff, pattern: 'hex' } },
  { id: 'gun.glitch',  name: 'Glitch',         blurb: 'Digital camo that won\'t sit still.',    rarity: 'epic',    source: { type: 'level', level: 68 },      data: { body: 0x0d1410, metal: 0x1d2a22, metalLt: 0x3f5a48, accent: 0x3bff8a, accentHot: 0xd4ffe6, pattern: 'digital' } },
  { id: 'gun.plasma',  name: 'Plasma Core',    blurb: 'Black frame, veins of living energy.',   rarity: 'legendary', source: { type: 'credits', price: 3200 },  data: { body: 0x0a0710, metal: 0x1b1426, metalLt: 0x3b2a55, accent: 0xc23bff, accentHot: 0xffc2ff, pattern: 'plasma' } },
  { id: 'gun.spectrum', name: 'Spectrum',      blurb: 'Iridescent chrome that shifts with the light.', rarity: 'legendary', source: { type: 'level', level: 90 }, data: { body: 0x1a1d24, metal: 0x9aa3b2, metalLt: 0xe6ebf2, accent: 0xff4fd8, accentHot: 0xffffff, pattern: 'spectrum', model: 'prism' } },
  // v3 Commons (the Weapon case needs a Common tier).
  { id: 'gun.olive',     name: 'Olive Drab',     blurb: 'Field-issue green.',                   rarity: 'common', source: { type: 'case' }, data: { body: 0x1f2418, metal: 0x3a4230, metalLt: 0x6b7658, accent: 0x9fd46a, accentHot: 0xe2ffc4 } },
  { id: 'gun.desert',    name: 'Desert Tan',     blurb: 'Sun-bleached and sand-blasted.',        rarity: 'common', source: { type: 'case' }, data: { body: 0x3a3022, metal: 0x6a5a40, metalLt: 0xb89f76, accent: 0xffb45e, accentHot: 0xffe6c2 } },
  { id: 'gun.urban',     name: 'Urban Grey',     blurb: 'Concrete camo for concrete maps.',      rarity: 'common', source: { type: 'case' }, data: { body: 0x23262b, metal: 0x44484f, metalLt: 0x8b9099, accent: 0xc9d3e0, accentHot: 0xffffff } },
  // v3 custom-model guns (Legendary → Unobtainable). Tiers set in items/catalog.ts.
  { id: 'gun.dragon',    name: 'Wyrmfang',       blurb: 'A scaled dragon-bone rail that breathes embers.',          rarity: 'legendary', source: { type: 'case' }, data: { body: 0x1a0c08, metal: 0x4a2414, metalLt: 0xc2572a, accent: 0xff5a1f, accentHot: 0xffd08a, model: 'dragon' } },
  { id: 'gun.tesla',     name: 'Tesla Coilgun',  blurb: 'Exposed copper coils arcing with live current.',            rarity: 'legendary', source: { type: 'case' }, data: { body: 0x14161c, metal: 0x7a4a24, metalLt: 0xd08a4a, accent: 0x6fd6ff, accentHot: 0xe8faff, model: 'tesla' } },
  { id: 'gun.reaper',    name: 'Reaper',         blurb: 'A scythe-bladed rail wreathed in cold soulfire.',           rarity: 'legendary', source: { type: 'case' }, data: { body: 0x0c0d10, metal: 0x2a2e36, metalLt: 0x8a94a6, accent: 0x3bffb0, accentHot: 0xd4ffe6, model: 'reaper' } },
  { id: 'gun.seraph',    name: 'Seraph',         blurb: 'White-gold wings fold along a hard-light barrel.',          rarity: 'legendary', source: { type: 'case' }, data: { body: 0xece6d8, metal: 0xc9a44a, metalLt: 0xfff1c4, accent: 0xffe08a, accentHot: 0xffffff, model: 'seraph' } },
  { id: 'gun.oblivion',  name: 'Oblivion',       blurb: 'A rail forged around a captive black hole.',               rarity: 'legendary', source: { type: 'case' }, data: { body: 0x07060c, metal: 0x1a1426, metalLt: 0x6a4cff, accent: 0x9b6bff, accentHot: 0xf0e4ff, model: 'oblivion' } },
  { id: 'gun.celestial', name: 'Celestial',      blurb: 'A living starfield in the shape of a railgun.',            rarity: 'legendary', source: { type: 'case' }, data: { body: 0x05060f, metal: 0x1c2240, metalLt: 0x8fb2ff, accent: 0x7fd4ff, accentHot: 0xffffff, model: 'celestial' } },
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
  { id: 'name.gold',    name: 'Gold',    blurb: 'A name worth its weight.', rarity: 'rare',   source: { type: 'level', level: 13 },      color: '#ffd24a' },
  { id: 'name.crimson', name: 'Crimson', blurb: 'See red.',                 rarity: 'rare',   source: { type: 'level', level: 33 },     color: '#ff5566' },
  { id: 'name.toxic',   name: 'Toxic',   blurb: 'Radioactive handle.',      rarity: 'rare',   source: { type: 'credits', price: 700 },  color: '#86ff5a' },
  { id: 'name.violet',  name: 'Violet',  blurb: 'Royalty in the arena.',    rarity: 'epic',   source: { type: 'credits', price: 1400 }, color: '#c08aff' },
  { id: 'name.white',   name: 'Pristine',blurb: 'Pure, clean, unmissable.', rarity: 'epic',   source: { type: 'level', level: 56 },     color: '#ffffff' },
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
  { id: 'spawn.ring',  name: 'Shockwave',  blurb: 'A hard expanding ground ring + flash.',  rarity: 'rare',   source: { type: 'level', level: 17 },      style: 'ring' },
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
// Hats are code-built now (src/game/wearables/); `model` is only a truthy "is a
// real hat" marker for the legacy consumers.

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
  { id: 'hat.cap',        name: 'Cap',            blurb: 'A simple ballcap.',                       rarity: 'common', source: { type: 'default' },             model: 'wearable', fit: 0.92, sink: -0.03, yaw: Math.PI / 2 },
  { id: 'hat.baseball',   name: 'Ballcap Pro',    blurb: 'The fitted classic.',                    rarity: 'common', source: { type: 'level', level: 2 },     model: 'wearable', fit: 1.05, sink: -0.04, yaw: Math.PI },
  { id: 'hat.hardhat',    name: 'Hard Hat',       blurb: 'Safety first, fragging second.',         rarity: 'rare',   source: { type: 'case' }, model: 'wearable', fit: 0.94, sink: -0.04 },
  { id: 'hat.graduation', name: 'Graduate',       blurb: 'Top of the class.',                      rarity: 'rare',   source: { type: 'level', level: 19 },     model: 'wearable', fit: 0.86, sink: -0.02 },
  { id: 'hat.tophat',     name: 'Top Hat',        blurb: 'Distinguished destruction.',             rarity: 'epic',   source: { type: 'case' }, model: 'wearable', fit: 0.86, sink: 0.0, stretch: 1.45 },
  { id: 'hat.propeller',  name: 'Propeller Cap',  blurb: 'Beanie with a spin.',                    rarity: 'epic',   source: { type: 'level', level: 35 },    model: 'wearable', fit: 0.92, sink: -0.05 },
  { id: 'hat.wizard',     name: 'Wizard Hat',     blurb: 'One-shot, one spell.',                   rarity: 'epic',   source: { type: 'case' }, model: 'wearable', fit: 0.84, sink: -0.02, stretch: 1.08 },
  { id: 'hat.crown',      name: 'Crown',          blurb: 'Royalty in the arena — staff only.',     rarity: 'epic',   source: { type: 'admin' },               model: 'wearable', fit: 0.78, sink: 0.0 },
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

export type UnusualKind =
  | 'none'
  | 'embers'
  | 'orbit'
  | 'halo'
  | 'storm'
  | 'aura'
  | 'plasma'
  | 'prism'
  | 'galaxy'
  | 'ghostfire'
  | 'hearts'
  | 'binary';

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
  { id: 'unusual.embers', name: 'Searing Embers',blurb: 'Rising embers crown your hat.',        rarity: 'legendary', source: { type: 'level', level: 62 },     kind: 'embers' },
  { id: 'unusual.orbit',  name: 'Orbiting Energy',blurb: 'Motes of energy circle overhead.',    rarity: 'legendary', source: { type: 'credits', price: 3000 }, kind: 'orbit' },
  { id: 'unusual.halo',   name: 'Radiant Halo',  blurb: 'A glowing ring hovers above you.',      rarity: 'legendary', source: { type: 'level', level: 100 },     kind: 'halo' },
  { id: 'unusual.storm',  name: 'Storm Cloud',   blurb: 'A tiny thundercloud follows your head.',rarity: 'legendary', source: { type: 'credits', price: 5000 }, kind: 'storm' },
  { id: 'unusual.aura',   name: 'Sovereign Aura',blurb: 'A regal ring of golden motes — staff only.', rarity: 'legendary', source: { type: 'admin' },         kind: 'aura' },
  // Wave 2 — Ratz-flavoured showpieces. Prismatic + Galaxy are case-exclusive
  // (the hat case's jackpot roll).
  { id: 'unusual.ghostfire', name: 'Ghostfire',    blurb: 'Spectral green flames that trail as you run.', rarity: 'legendary', source: { type: 'level', level: 71 },     kind: 'ghostfire' },
  { id: 'unusual.plasma',    name: 'Plasma Arcs',  blurb: 'Crackling arcs leap around your head.',        rarity: 'legendary', source: { type: 'credits', price: 4000 }, kind: 'plasma' },
  { id: 'unusual.hearts',    name: 'Lovestruck',   blurb: 'Hearts float up and pop. Adorable. Lethal.',   rarity: 'legendary', source: { type: 'credits', price: 3500 }, kind: 'hearts' },
  { id: 'unusual.binary',    name: 'Overclocked',  blurb: 'A falling cascade of glowing digits.',         rarity: 'legendary', source: { type: 'level', level: 80 },     kind: 'binary' },
  { id: 'unusual.prism',     name: 'Prismatic',    blurb: 'A spiral of rainbow light — case jackpot.',    rarity: 'legendary', source: { type: 'case' },                 kind: 'prism' },
  { id: 'unusual.galaxy',    name: 'Galaxy',       blurb: 'A tiny spiral galaxy turns overhead — case jackpot.', rarity: 'legendary', source: { type: 'case' },          kind: 'galaxy' },
];

export function unusualById(id: string): UnusualCosmetic {
  return UNUSUALS.find((u) => u.id === id) ?? UNUSUALS[0];
}
export function isUnusual(id: string): boolean {
  return UNUSUALS.some((u) => u.id === id);
}

// ── Hat case (credits-funded unboxing) ───────────────────────────────────────
// Cosmetic-only, opened with EARNED credits or a free Career Road key (never
// real money) → stays within the "no randomized paid boxes" pillar. The roll is
// server-authoritative (server/db.ts openCase) and NEVER drops a duplicate:
//   • CASE_JACKPOT_CHANCE: an un-owned case-exclusive unusual (the jackpot);
//   • otherwise an un-owned case hat, weighted by RARITY_WEIGHT;
//   • once every case hat is owned (jackpots still missing), a non-jackpot open
//     pays CASE_CONSOLATION credits back instead — so the jackpot stays a real
//     long shot (~CASE_COST × (1 − consolation) / chance per jackpot);
//   • everything owned → the case is complete and won't open.
// Case items are `source: { type: 'case' }` — one source only, never buyable or
// on the road. Adding a hat with a case source grows the pool automatically.
export const HAT_CASE_COST = 500;
export const CASE_JACKPOT_CHANCE = 0.05;
export const CASE_CONSOLATION = 250; // credits back on a jackpot-miss once all case hats are owned
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 100, rare: 40, epic: 12, legendary: 4 };

// The case's regular drops: hats whose only source is the case.
export function caseHats(): HatCosmetic[] {
  return HATS.filter((h) => h.model && h.source.type === 'case');
}

// The jackpot tier: every non-hat case-exclusive cosmetic (the unusuals).
export function caseJackpots(): UnusualCosmetic[] {
  return UNUSUALS.filter((u) => u.source.type === 'case');
}

// What an open can still drop for a player who owns `owned` (no dupes).
export function casePool(owned: ReadonlySet<string>): { hats: HatCosmetic[]; jackpots: UnusualCosmetic[] } {
  return {
    hats: caseHats().filter((h) => !owned.has(h.id)),
    jackpots: caseJackpots().filter((u) => !owned.has(u.id)),
  };
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
export type CardAnim =
  | 'holo'
  | 'shimmer'
  | 'pulse'
  | 'aurora'
  | 'scan'
  | 'circuit' // pulses racing along circuit traces
  | 'rain' // rain streaks + CRT scanlines
  | 'stars' // three-layer parallax starfield
  | 'plasma' // drifting plasma blobs
  | 'glitch' // RGB-split slice glitches
  | 'fire' // rising flame tongues + embers
  | 'foil' // rainbow foil sweep
  | 'boreal'; // aurora borealis ribbons

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
  { id: 'card.ember',  name: 'Ember',     blurb: 'Molten edges.',             rarity: 'rare',   source: { type: 'level', level: 11 },      bg: 'linear-gradient(135deg,#7c2d12,#180a05)',                          accent: '#fb923c' },
  { id: 'card.toxic',  name: 'Toxic',     blurb: 'Acid wash.',                rarity: 'rare',   source: { type: 'level', level: 15 },      bg: 'linear-gradient(135deg,#14532d,#05140a)',                          accent: '#86efac' },
  { id: 'card.cyber',  name: 'Cyber',     blurb: 'Neon grid.',                rarity: 'rare',   source: { type: 'level', level: 27 },     bg: 'linear-gradient(135deg,#0e7490,#3b0764)',                          accent: '#22d3ee' },
  { id: 'card.void',   name: 'Void',      blurb: 'Deep violet, slow aurora.', rarity: 'epic',   source: { type: 'level', level: 33 },      bg: 'radial-gradient(circle at 30% 20%,#4c1d95,#06010f)',                accent: '#a78bfa', anim: 'aurora' },
  { id: 'card.gold',   name: 'Gilded',    blurb: 'A drifting golden sheen.',  rarity: 'epic',   source: { type: 'level', level: 47 },     bg: 'linear-gradient(135deg,#854d0e,#1c1206)',                          accent: '#fbbf24', anim: 'shimmer' },
  { id: 'card.admin',  name: 'Sovereign', blurb: 'Staff only — holographic.', rarity: 'epic',   source: { type: 'admin' },                bg: 'linear-gradient(135deg,#3a2c05,#0c0a04)',                          accent: '#ffd700', anim: 'holo' },
  // Animated tier — the card slot's premium upgrade. Each pairs a static base
  // gradient with a CSS motion layer (.pcard-anim-*).
  { id: 'card.prism',  name: 'Prism',     blurb: 'A rotating holographic foil.', rarity: 'epic', source: { type: 'level', level: 55 },     bg: 'linear-gradient(135deg,#0b1220,#1e1b4b)',                         accent: '#a5f3fc', anim: 'holo' },
  { id: 'card.nebula', name: 'Nebula',    blurb: 'Living violet-teal aurora.',   rarity: 'epic', source: { type: 'level', level: 65 },     bg: 'radial-gradient(circle at 70% 30%,#155e75,#1e1b4b 60%,#05010f)',  accent: '#67e8f9', anim: 'aurora' },
  { id: 'card.matrix', name: 'Matrix',    blurb: 'Scrolling neon scanlines.',    rarity: 'epic', source: { type: 'level', level: 80 },     bg: 'linear-gradient(135deg,#022c22,#03140f)',                        accent: '#4ade80', anim: 'scan' },
  // v3 wave: level-unlocked, animated (levels 5–100). Never case items or tradable.
  { id: 'card.circuit',  name: 'Circuit',    blurb: 'Data pulses race along live traces.',        rarity: 'rare',      source: { type: 'level', level: 5 },   bg: 'linear-gradient(135deg,#06222b,#04121a)',                                        accent: '#67e8f9', anim: 'circuit' },
  { id: 'card.downpour', name: 'Downpour',   blurb: 'Night rain on a flickering CRT.',            rarity: 'rare',      source: { type: 'level', level: 8 },   bg: 'linear-gradient(160deg,#1b2a3f,#070b14)',                                        accent: '#9cc4ff', anim: 'rain' },
  { id: 'card.starfield',name: 'Starfield',  blurb: 'Three layers of stars drifting past.',       rarity: 'epic',      source: { type: 'level', level: 20 },  bg: 'radial-gradient(120% 100% at 50% 110%,#1a1446,#04030f 70%)',                     accent: '#c4b5fd', anim: 'stars' },
  { id: 'card.plasma',   name: 'Plasma',     blurb: 'Slow, hot blobs of magenta and cyan.',       rarity: 'epic',      source: { type: 'level', level: 40 },  bg: 'linear-gradient(135deg,#2a0a3d,#06182b)',                                        accent: '#f0abfc', anim: 'plasma' },
  { id: 'card.glitch',   name: 'Glitch',     blurb: 'The signal tears. Then it doesn’t.',         rarity: 'epic',      source: { type: 'level', level: 60 },  bg: 'linear-gradient(135deg,#150c1f,#08111a)',                                        accent: '#5eead4', anim: 'glitch' },
  { id: 'card.inferno',  name: 'Inferno',    blurb: 'Flames lick up the card, embers rising.',    rarity: 'legendary', source: { type: 'level', level: 72 },  bg: 'linear-gradient(180deg,#1c0703,#3d0e05)',                                        accent: '#fdba74', anim: 'fire' },
  { id: 'card.foil',     name: 'Holo Foil',  blurb: 'A rainbow sweep across brushed foil.',       rarity: 'legendary', source: { type: 'level', level: 90 },  bg: 'linear-gradient(135deg,#1b1f2b,#2b2f3d 50%,#141826)',                            accent: '#fde68a', anim: 'foil' },
  { id: 'card.boreal',   name: 'Boreal',     blurb: 'Aurora ribbons over a frozen night.',        rarity: 'legendary', source: { type: 'level', level: 100 }, bg: 'linear-gradient(180deg,#03101c,#071a2a 55%,#0a2233)',                            accent: '#86efac', anim: 'boreal' },
];

export function cardById(id: string): CardCosmetic {
  return CARD_STYLES.find((c) => c.id === id) ?? CARD_STYLES[0];
}
export function isCard(id: string): boolean {
  return CARD_STYLES.some((c) => c.id === id);
}

// ── Emote slot ───────────────────────────────────────────────────────────────
// A celebratory animation your character plays on the end-of-match podium (and,
// later, as an in-lobby/taunt). Authored full-body keyframe clips on the code-
// built combatant's skeleton — see game/emotes.ts.
export const DEFAULT_EMOTE = 'emote.cheer';

export type EmoteKind =
  | 'idle'
  | 'cheer'
  | 'wave'
  | 'flex'
  | 'spin'
  | 'dance'
  | 'salute'
  | 'beckon'
  | 'slowclap'
  | 'flourish'
  | 'airguitar'
  | 'headbang'
  | 'robot'
  | 'kneel'
  | 'railspin'
  | 'laugh'
  // v3.1 meme taunts (hard-light props via emote-props.ts)
  | 'takethel'
  | 'tpose'
  | 'crab'
  | 'facepalm'
  | 'micdrop'
  | 'gg'
  | 'pushups'
  | 'teatime';

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
  { id: 'emote.wave',  name: 'Wave',          blurb: 'A friendly hello.',          rarity: 'common', source: { type: 'level', level: 7 },      kind: 'wave' },
  { id: 'emote.flex',  name: 'Flex',          blurb: 'Show off those gains.',      rarity: 'common', source: { type: 'credits', price: 400 },  kind: 'flex' },
  { id: 'emote.spin',  name: 'Spin',          blurb: 'Round and round.',           rarity: 'rare',   source: { type: 'level', level: 29 },      kind: 'spin' },
  { id: 'emote.dance', name: 'Disco',         blurb: 'Hips and hands, all night.', rarity: 'epic',   source: { type: 'credits', price: 1200 }, kind: 'dance' },
  // Quake-flavoured taunts (authored full-body clips — see game/emotes.ts).
  { id: 'emote.salute',   name: 'Salute',        blurb: 'Snap to attention.',                     rarity: 'common', source: { type: 'level', level: 4 },      kind: 'salute' },
  { id: 'emote.beckon',   name: 'Come Get Some', blurb: 'Palm up, fingers curl. Bring it.',       rarity: 'rare',   source: { type: 'level', level: 39 },     kind: 'beckon' },
  { id: 'emote.slowclap', name: 'Slow Clap',     blurb: 'Deeply, deeply unimpressed.',            rarity: 'rare',   source: { type: 'credits', price: 700 },  kind: 'slowclap' },
  { id: 'emote.flourish', name: 'Present Arms',  blurb: 'A railgun twirl, snapped to attention.', rarity: 'epic',   source: { type: 'level', level: 53 },     kind: 'flourish' },
  // v3 taunts (Taunt Case). Tiers in items/catalog.ts LEGACY_TIER.
  { id: 'emote.laugh',     name: 'Belly Laugh',  blurb: 'Doubled over. Merciless.',              rarity: 'common',    source: { type: 'case' }, kind: 'laugh' },
  { id: 'emote.headbang',  name: 'Headbang',     blurb: 'The rail was the riff.',                rarity: 'common',    source: { type: 'case' }, kind: 'headbang' },
  { id: 'emote.kneel',     name: 'Take a Knee',  blurb: 'A moment of silence for the fragged.',  rarity: 'common',    source: { type: 'case' }, kind: 'kneel' },
  { id: 'emote.robot',     name: 'Robot',        blurb: 'Beep. Boop. Gibbed.',                   rarity: 'rare',      source: { type: 'case' }, kind: 'robot' },
  { id: 'emote.airguitar', name: 'Air Guitar',   blurb: 'Shred on the corpse.',                  rarity: 'epic',      source: { type: 'case' }, kind: 'airguitar' },
  { id: 'emote.railspin',  name: 'Rail Spin',    blurb: 'A showboat gun twirl, caught clean.',   rarity: 'legendary', source: { type: 'case' }, kind: 'railspin' },
  // v3.1 meme taunts (hard-light props via emotes.ts + emote-props.ts). Tiers in items/catalog.ts LEGACY_TIER.
  { id: 'emote.facepalm', name: 'Facepalm',     blurb: 'For when the feed says it all.',        rarity: 'common',    source: { type: 'case' }, kind: 'facepalm' },
  { id: 'emote.pushups',  name: 'Drop and Give', blurb: 'Three reps. One clap. Show-off.',       rarity: 'common',    source: { type: 'case' }, kind: 'pushups' },
  { id: 'emote.crab',     name: 'Crab Walk',    blurb: 'Sideways scuttle, claws snipping.',      rarity: 'rare',      source: { type: 'case' }, kind: 'crab' },
  { id: 'emote.gg',       name: 'GG',           blurb: 'A hard-light sign for a well-fragged foe.', rarity: 'rare',   source: { type: 'case' }, kind: 'gg' },
  { id: 'emote.teatime',  name: 'Tea Time',     blurb: 'A satisfied sip. None of your business.', rarity: 'rare',     source: { type: 'case' }, kind: 'teatime' },
  { id: 'emote.tpose',    name: 'Assert Dominance', blurb: 'A rigid T and a slow, creepy rotate.', rarity: 'epic',    source: { type: 'case' }, kind: 'tpose' },
  { id: 'emote.micdrop',  name: 'Mic Drop',     blurb: 'Last words. Dropped mic. Walk away.',    rarity: 'epic',      source: { type: 'case' }, kind: 'micdrop' },
  { id: 'emote.takethel', name: 'Take the L',   blurb: 'Forehead L, hop-kicks, zero mercy.',     rarity: 'legendary', source: { type: 'case' }, kind: 'takethel' },
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
  // Live-resolved titles: `text` is a placeholder and the real flair is computed
  // at display time (server for the nameplate/scoreboard/killcard, client for the
  // local preview). 'ranked' → your current ladder standing (#1–#10, else tier).
  dynamic?: 'ranked';
};

export const TITLES: readonly TitleCosmetic[] = [
  { id: 'title.none',         name: 'No Title',     blurb: 'No flair under your name.',                     rarity: 'common', source: { type: 'default' },                                              text: '' },
  { id: 'title.centurion',    name: 'Centurion',    blurb: 'Land 100 career frags.',                        rarity: 'common', source: { type: 'achievement', stat: 'kills', min: 100 },                  text: 'Centurion' },
  { id: 'title.executioner',  name: 'Executioner',  blurb: 'Land 1,000 career frags.',                      rarity: 'rare',   source: { type: 'achievement', stat: 'kills', min: 1000 },                 text: 'Executioner' },
  { id: 'title.railgod',      name: 'Rail God',     blurb: 'Land 5,000 career frags.',                      rarity: 'legendary', source: { type: 'achievement', stat: 'kills', min: 5000 },                 text: 'Rail God' },
  { id: 'title.headhunter',   name: 'Headhunter',   blurb: 'Land 500 career headshots.',                    rarity: 'rare',   source: { type: 'achievement', stat: 'headshots', min: 500 },              text: 'Headhunter' },
  { id: 'title.champion',     name: 'Champion',     blurb: 'Win 50 matches.',                               rarity: 'rare',   source: { type: 'achievement', stat: 'wins', min: 50 },                    text: 'Champion' },
  { id: 'title.untouchable',  name: 'Untouchable',  blurb: 'Reach a 20-frag streak.',                       rarity: 'epic',   source: { type: 'achievement', stat: 'bestStreak', min: 20 },              text: 'Untouchable' },
  { id: 'title.sharpshooter', name: 'Sharpshooter', blurb: 'Finish a match at 50%+ accuracy (20+ shots, 20+ games).', rarity: 'rare',   source: { type: 'achievement', stat: 'accuracy', min: 50, minGames: 20 },  text: 'Sharpshooter' },
  { id: 'title.veteran',      name: 'Veteran',      blurb: 'Play 200 matches.',                             rarity: 'common', source: { type: 'achievement', stat: 'games', min: 200 },                  text: 'Veteran' },
  // Live ranked standing — owned by everyone; the flair is resolved at display
  // time (top-10 → "#N", otherwise your tier) and updates as your rating moves.
  { id: 'title.ranked',       name: 'Ranked Standing', blurb: 'Show your live ladder rank — #1–#10 at the top, else your tier.', rarity: 'rare', source: { type: 'default' },                       text: '', dynamic: 'ranked' },
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

// ── Announcer-pack slot ──────────────────────────────────────────────────────
// Announcer voice packs (the actual audio + selection live in game/audio.ts +
// Settings → Audio). They're registered here ONLY for ownership/unlock gating, so
// they ride the same machinery as every other cosmetic: admins auto-own all of
// them, and non-admins unlock by level (or credits). The default 'legacy' pack is
// free; 'kuon' is level-gated. Cosmetic id = `announcer.<packId>`.
export type AnnouncerPackCosmetic = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
};
export const ANNOUNCER_PACK_COSMETICS: readonly AnnouncerPackCosmetic[] = [
  { id: 'announcer.legacy', name: 'Classic',      blurb: 'The original deep-voice announcer.',                                  rarity: 'common', source: { type: 'default' } },
  { id: 'announcer.kuon',   name: 'Kuon (Anime)', blurb: 'A cheerful Japanese-anime announcer — hype, variety, encouragement.', rarity: 'epic',   source: { type: 'level', level: 25 } },
];
export function announcerPackCosmeticId(packId: string): string {
  return `announcer.${packId}`;
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
  | 'title'
  | 'announcer';

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
  | (TitleCosmetic & { slot: 'title' })
  | (AnnouncerPackCosmetic & { slot: 'announcer' });

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
  ...ANNOUNCER_PACK_COSMETICS.map((c) => ({ ...c, slot: 'announcer' as const })),
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
    case 'case':
      return 'Hat Case';
    case 'admin':
      return 'Admin';
  }
}
