// Player dyes — the `dye` item slot (economy v3). THREE-free: client + server.
//
// A dye recolours the combatant's painted armour (and, for a few, the whole
// body) for everyone who sees you — Krunker-style skins, our own looks.
// `dye.none` = your natural name-keyed bright skin (character.ts SKIN_PALETTE).
//
// Fairness (CLAUDE.md "skill stays sacred"):
//   • Every plain colour (solids, two-tones, stripes) has relative luminance
//     ≥ 0.33 — at least the darkest natural skin — so no dye is harder to see.
//   • The dark patterns (Void, Magma, Circuit, Nebula, Event Horizon) are dark
//     on purpose but carry a bright fresnel rim + glowing detail, so their
//     silhouette reads at least as well as a natural skin.
//   • Nothing is actually transparent: Spectre's "ghost" look is opaque, with a
//     bright glowing edge — it reads MORE, not less.
//   • The viewer's enemy-highlight colour and TDM team colours always override
//     a dye (identification beats cosmetics).
//
// The renderer (character/body.ts) keys the animated looks by `pattern`.
import type { Tier } from './items/types';

export type DyePattern =
  | 'solid' // one colour (`a`), optional finish
  | 'gradient' // `a` at the boots → `b` at the helmet
  | 'stripes' // diagonal bands of `a` / `b`
  | 'chrome' // mirror metal tinted `a`
  | 'pearl' // pale base `a` with a view-angle iridescent sheen
  | 'chroma' // animated: RGB hue bands sweeping up the body
  | 'magma' // animated: cooled crust with flowing lava veins (`a` → `b`)
  | 'hologram' // animated: scanlines + fresnel glow in `a`
  | 'aurora' // animated: drifting curtains of `a` / `b` / `c`
  | 'circuit' // animated: dark plates `a`, pulsing traces `b`
  | 'spectre' // animated: pale glowing ghost, wisps rising (`a`)
  | 'void' // near-black body outlined in light `b`
  | 'nebula' // animated: deep space `a` with `b`/`c` clouds and twinkling stars
  | 'horizon'; // animated: void body with a swirling prismatic accretion band

export type DyeFinish = 'gloss' | 'matte' | 'metal';

export type DyeDef = {
  id: string;
  name: string;
  blurb: string;
  tier: Tier;
  pattern: DyePattern;
  a: string; // primary colour (also the visor / rim / tile swatch colour)
  b?: string;
  c?: string;
  finish?: DyeFinish;
  speed?: number; // animation speed multiplier (default 1)
  scale?: number; // pattern scale (stripes per metre…)
};

export const DEFAULT_DYE = 'dye.none';

export const PATTERN_ANIMATED: Record<DyePattern, boolean> = {
  solid: false,
  gradient: false,
  stripes: false,
  chrome: false,
  pearl: false,
  chroma: true,
  magma: true,
  hologram: true,
  aurora: true,
  circuit: true,
  spectre: true,
  void: false,
  nebula: true,
  horizon: true,
};

export const DYES: readonly DyeDef[] = [
  // ── Common: gloss solids (luminance-banded) ────────────────────────────────
  { id: 'dye.signal', name: 'Signal Red', blurb: 'Loud, proud, impossible to miss.', tier: 'common', pattern: 'solid', a: '#ff6e6e' },
  { id: 'dye.tangerine', name: 'Tangerine', blurb: 'Zesty orange lacquer.', tier: 'common', pattern: 'solid', a: '#ff8a2a' },
  { id: 'dye.canary', name: 'Canary', blurb: 'Bright as a warning light.', tier: 'common', pattern: 'solid', a: '#ffd83a' },
  { id: 'dye.lime', name: 'Lime Rind', blurb: 'Acid-green plates.', tier: 'common', pattern: 'solid', a: '#8fe03a' },
  { id: 'dye.teal', name: 'Lagoon', blurb: 'Warm-water teal.', tier: 'common', pattern: 'solid', a: '#22c7b0' },
  { id: 'dye.sky', name: 'Sky Blue', blurb: 'Clear-day cyan-blue.', tier: 'common', pattern: 'solid', a: '#44b4ff' },
  { id: 'dye.grape', name: 'Grape Soda', blurb: 'Fizzy purple.', tier: 'common', pattern: 'solid', a: '#b484ff' },
  { id: 'dye.bubblegum', name: 'Bubblegum', blurb: 'Pop it.', tier: 'common', pattern: 'solid', a: '#ff7cc4' },
  { id: 'dye.bone', name: 'Bone', blurb: 'Off-white, clean, clinical.', tier: 'common', pattern: 'solid', a: '#e8e1cf' },
  // ── Uncommon: finishes (matte / metal) ─────────────────────────────────────
  { id: 'dye.slate', name: 'Gunship Grey', blurb: 'Matte naval grey.', tier: 'uncommon', pattern: 'solid', a: '#9aa3b2', finish: 'matte' },
  { id: 'dye.sand', name: 'Desert Tan', blurb: 'Matte field tan.', tier: 'uncommon', pattern: 'solid', a: '#d9b98a', finish: 'matte' },
  { id: 'dye.mint', name: 'Mint Chip', blurb: 'Soft matte mint.', tier: 'uncommon', pattern: 'solid', a: '#8ff0c4', finish: 'matte' },
  { id: 'dye.lavender', name: 'Lavender Haze', blurb: 'Matte and dreamy.', tier: 'uncommon', pattern: 'solid', a: '#c2a8ff', finish: 'matte' },
  { id: 'dye.rosegold', name: 'Rose Gold', blurb: 'Brushed pink metal.', tier: 'uncommon', pattern: 'solid', a: '#f2a48e', finish: 'metal' },
  { id: 'dye.copper', name: 'Burnished Copper', blurb: 'Warm brushed metal.', tier: 'uncommon', pattern: 'solid', a: '#e8874a', finish: 'metal' },
  { id: 'dye.cobaltmetal', name: 'Cobalt Flake', blurb: 'Metal-flake blue.', tier: 'uncommon', pattern: 'solid', a: '#6e9bff', finish: 'metal' },
  // ── Rare: two-tones ────────────────────────────────────────────────────────
  { id: 'dye.sunset', name: 'Sunset Strip', blurb: 'Orange at the boots, magenta at the crown.', tier: 'rare', pattern: 'gradient', a: '#ff9a2e', b: '#ff4fa8' },
  { id: 'dye.deepsea', name: 'Deep Sea', blurb: 'Teal fading up into ocean blue.', tier: 'rare', pattern: 'gradient', a: '#27d6b0', b: '#609eff' },
  { id: 'dye.toxic', name: 'Toxic Runoff', blurb: 'Radioactive green rising to acid yellow.', tier: 'rare', pattern: 'gradient', a: '#3ddc5a', b: '#e8f23a' },
  { id: 'dye.frostbite', name: 'Frostbite', blurb: 'Ice-white plates, glacier-blue feet.', tier: 'rare', pattern: 'gradient', a: '#4fb6ff', b: '#eef8ff' },
  { id: 'dye.dusk', name: 'Afterglow', blurb: 'Violet dusk into a peach horizon.', tier: 'rare', pattern: 'gradient', a: '#b586ff', b: '#ffb38a' },
  { id: 'dye.hazard', name: 'Hazard Tape', blurb: 'Diagonal yellow-and-grey warning bands.', tier: 'rare', pattern: 'stripes', a: '#ffd23a', b: '#959dae', scale: 7 },
  { id: 'dye.candy', name: 'Candy Cane', blurb: 'Red-and-white barber stripes.', tier: 'rare', pattern: 'stripes', a: '#ff6c7c', b: '#f4f1ec', scale: 8 },
  // ── Epic: special finishes ─────────────────────────────────────────────────
  { id: 'dye.chrome', name: 'Liquid Chrome', blurb: 'A mirror you can frag in.', tier: 'epic', pattern: 'chrome', a: '#dfe6ee' },
  { id: 'dye.gold', name: '24 Karat', blurb: 'Solid gold plate. Tasteful? No.', tier: 'epic', pattern: 'chrome', a: '#ffc94a' },
  { id: 'dye.pearl', name: 'Oil Slick Pearl', blurb: 'Pearl-white with a shifting rainbow sheen.', tier: 'epic', pattern: 'pearl', a: '#eef0f6' },
  { id: 'dye.neontiger', name: 'Neon Tiger', blurb: 'Hot-pink bands on electric orange.', tier: 'epic', pattern: 'stripes', a: '#ff8a1f', b: '#ff5acf', scale: 11 },
  // ── Legendary: animated ────────────────────────────────────────────────────
  { id: 'dye.chroma', name: 'Chroma Cycle', blurb: 'Full-spectrum RGB bands sweeping up the armour.', tier: 'legendary', pattern: 'chroma', a: '#ff4fd8' },
  { id: 'dye.hologram', name: 'Hardlight', blurb: 'A projected soldier: scanlines and a cyan glow.', tier: 'legendary', pattern: 'hologram', a: '#5ff4ff' },
  { id: 'dye.aurora', name: 'Aurora', blurb: 'Northern-light curtains drifting over the plates.', tier: 'legendary', pattern: 'aurora', a: '#3dffa8', b: '#6b7bff', c: '#ff6be0' },
  { id: 'dye.circuit', name: 'Mainframe', blurb: 'Dark plates, circuit traces pulsing with data.', tier: 'legendary', pattern: 'circuit', a: '#1c2640', b: '#4dfcff' },
  // ── Relic ──────────────────────────────────────────────────────────────────
  { id: 'dye.magma', name: 'Magma Core', blurb: 'Cooling crust over rivers of lava.', tier: 'relic', pattern: 'magma', a: '#ff5a1a', b: '#ffd23a' },
  { id: 'dye.spectre', name: 'Spectre', blurb: 'A pale, glowing ghost of a soldier.', tier: 'relic', pattern: 'spectre', a: '#b8f0ff' },
  { id: 'dye.void', name: 'Vantablack', blurb: 'Blacker than black — outlined in light so everyone still sees you coming.', tier: 'relic', pattern: 'void', a: '#e8f0ff', b: '#e8f0ff' },
  { id: 'dye.nebula', name: 'Nebula', blurb: 'Deep space, drifting clouds, twinkling stars.', tier: 'relic', pattern: 'nebula', a: '#1a1440', b: '#ff4fc8', c: '#39c8ff' },
  // ── Unobtainable (Vault 0.02%) ─────────────────────────────────────────────
  { id: 'dye.horizon', name: 'Event Horizon', blurb: 'A void swallowed by its own prismatic accretion ring.', tier: 'unobtainable', pattern: 'horizon', a: '#ffffff', b: '#ff4fd8', speed: 1 },
];

const BY_ID = new Map(DYES.map((d) => [d.id, d]));
export function dyeById(id: string | undefined | null): DyeDef | null {
  return (id && BY_ID.get(id)) || null;
}
export function isDye(id: string): boolean {
  return id === DEFAULT_DYE || BY_ID.has(id);
}

// A CSS background for a dye swatch (tiles, the locker rail, the case pool).
export function dyeSwatchCss(d: DyeDef | null): string {
  if (!d) return 'linear-gradient(135deg,#ff6b4e,#27b8ff 50%,#c976ff)';
  const b = d.b ?? d.a;
  switch (d.pattern) {
    case 'gradient':
      return `linear-gradient(0deg, ${d.a}, ${b})`;
    case 'stripes':
      return `repeating-linear-gradient(135deg, ${d.a} 0 9px, ${b} 9px 18px)`;
    case 'chrome':
      return `linear-gradient(160deg, #ffffff 0%, ${d.a} 28%, #3a3f48 52%, ${d.a} 74%, #ffffff 100%)`;
    case 'pearl':
      return `linear-gradient(135deg, ${d.a}, #ffd6f2 35%, #c8f3ff 65%, ${d.a})`;
    case 'chroma':
      return 'linear-gradient(0deg,#ff4d4d,#ffd84d,#5dff6b,#4dd8ff,#8a6bff,#ff4dd8)';
    case 'magma':
      return `radial-gradient(circle at 35% 60%, ${b} 0 12%, ${d.a} 22%, #1a0c08 46%), #1a0c08`;
    case 'hologram':
      return `repeating-linear-gradient(0deg, ${d.a}55 0 2px, #06222a 2px 5px)`;
    case 'aurora':
      return `linear-gradient(170deg, #061626 10%, ${d.a} 38%, ${b} 62%, ${d.c ?? b} 88%)`;
    case 'circuit':
      return `linear-gradient(90deg, ${b} 0 1px, transparent 1px) 0 0/10px 10px, linear-gradient(0deg, ${b} 0 1px, transparent 1px) 0 0/10px 10px, ${d.a}`;
    case 'spectre':
      return `radial-gradient(circle at 50% 45%, #ffffff22 0 30%, ${d.a}aa 70%, ${d.a})`;
    case 'void':
      return `radial-gradient(circle, #000 0 62%, ${b} 78%, #000 92%)`;
    case 'nebula':
      return `radial-gradient(circle at 30% 35%, ${b}cc 0 18%, transparent 40%), radial-gradient(circle at 70% 65%, ${d.c ?? b}cc 0 16%, transparent 38%), ${d.a}`;
    case 'horizon':
      return 'radial-gradient(circle, #000 0 40%, #ff4fd8 50%, #ffd84d 56%, #4dd8ff 62%, #000 74%)';
    default:
      return d.a;
  }
}
