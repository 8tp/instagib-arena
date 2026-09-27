// Kept apart from menu-backdrop.ts so the landing page can read it without
// pulling Three.js into its eager chunk.

/* ── Prefs outside the game client ─────────────────────────────────────── */

// The landing page has no settings object; read the two flags the backdrop
// cares about straight from the persisted settings (same key the client uses).
export function readMenuPrefs(): { lowSpec: boolean; reducedEffects: boolean } {
  let reducedEffects = false;
  try {
    reducedEffects = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    /* no matchMedia */
  }
  let lowSpec = false;
  try {
    const raw = window.localStorage.getItem('instagib-settings-v2');
    if (raw) {
      const s = JSON.parse(raw) as { lowSpec?: unknown; reducedEffects?: unknown };
      if (typeof s.lowSpec === 'boolean') lowSpec = s.lowSpec;
      if (typeof s.reducedEffects === 'boolean') reducedEffects = s.reducedEffects;
    }
  } catch {
    /* storage blocked */
  }
  return { lowSpec, reducedEffects };
}
