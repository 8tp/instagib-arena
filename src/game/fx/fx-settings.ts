// Device-level FX flags shared by every cosmetic effect that isn't driven
// through EffectsManager.setQuality(): the gib/death animations (gibs.ts),
// the worn unusuals (fx/unusuals.ts). The Game sets them through
// setCharacterFxQuality() (gibs.ts), which writes here.
//
//   reduced — accessibility "reduced effects": calmer, shorter, no flicker
//             or strobing (storm lightning, plasma crackle, derez blinking).
//   low     — low-spec tier: fewer particles, cheaper update rates.

export const fxFlags = { reduced: false, low: false };

// Recent deaths: every body that bursts (GibBurst.start) records where it
// actually is on screen (feet + 0.9 m — the kill-burst convention) and its
// colour. A kill burst requested WITHOUT a victim tint resolves one frame
// later against this list, so it explodes in the victim's colour and lines
// up with the rendered (interpolation-delayed) body rather than the server
// position. Fixed ring buffer — no allocation.
type Death = { x: number; y: number; z: number; r: number; g: number; b: number; t: number };
const DEATHS: Death[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, t: -1e9 }));
let deathHead = 0;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function noteDeath(x: number, y: number, z: number, r: number, g: number, b: number): void {
  const d = DEATHS[deathHead];
  d.x = x; d.y = y; d.z = z;
  d.r = r; d.g = g; d.b = b;
  d.t = now();
  deathHead = (deathHead + 1) % DEATHS.length;
}

// The nearest death within `maxDist` metres of (x, y, z) in the last `maxAgeMs`.
export function findDeath(x: number, y: number, z: number, maxDist: number, maxAgeMs: number): Readonly<Death> | null {
  const t = now();
  let best: Death | null = null;
  let bestD = maxDist * maxDist;
  for (const d of DEATHS) {
    if (t - d.t > maxAgeMs) continue;
    const dx = d.x - x, dy = d.y - y, dz = d.z - z;
    const q = dx * dx + dy * dy + dz * dz;
    if (q <= bestD) { bestD = q; best = d; }
  }
  return best;
}

// Finisher timing shared by the death animation (gibs.ts) and the burst
// (effects.ts) so their beats line up without a callback between them.
export const FINISHER_TIMING = {
  // Singularity: chunks spiral into the point, then the white-hot pop.
  singularityPop: 0.3,
  // Overload: arcs crawl over the armour, then the blue-white blast.
  overloadBlast: 0.26,
} as const;
