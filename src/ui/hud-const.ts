// Must match --hud-out in src/hud.css: the fade-only exit every HUD element uses.
export const HUD_EXIT_MS = 240;
// How long before the engine drops a timed entry its pre-scheduled CSS fade
// starts: the fade itself plus slack so it has finished by the time the next
// HudState push unmounts the element.
export const HUD_EXIT_LEAD_MS = HUD_EXIT_MS + 120;
