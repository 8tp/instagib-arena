// Device-level FX flags shared by every cosmetic effect that isn't driven
// through EffectsManager.setQuality(): the gib/death animations (gibs.ts),
// the worn unusuals (fx/unusuals.ts). The Game sets them through
// setCharacterFxQuality() (gibs.ts), which writes here.
//
//   reduced — accessibility "reduced effects": calmer, shorter, no flicker
//             or strobing (storm lightning, plasma crackle, derez blinking).
//   low     — low-spec tier: fewer particles, cheaper update rates.

export const fxFlags = { reduced: false, low: false };

// Finisher timing shared by the death animation (gibs.ts) and the burst
// (effects.ts) so their beats line up without a callback between them.
export const FINISHER_TIMING = {
  // Singularity: chunks spiral into the point, then the white-hot pop.
  singularityPop: 0.3,
  // Overload: arcs crawl over the armour, then the blue-white blast.
  overloadBlast: 0.26,
} as const;
