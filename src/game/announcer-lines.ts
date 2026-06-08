// ── Announcer pack line sets ─────────────────────────────────────────────────
//
// The single source of truth for what each announcer pack SAYS. Each event (a
// SoundClipName announcer clip) maps to an array of line VARIANTS, so the same
// event doesn't repeat the same line every time — the player hears variety, and
// each pack has its own personality.
//
// This module is shared by BOTH the client (audio.ts reads the variant counts to
// pick + preload `<clip>_<i>.mp3`) and the generator (scripts/gen-announcers.ts
// turns each line into that MP3). Keep the array ORDER stable: variant N maps to
// `<clip>_<N>.mp3`, so reordering/inserting mid-array re-points existing files.
//
// `legacy` is intentionally empty — it keeps the original single-file .ogg /
// procedural / TTS announcer (see audio.ts). Packs here are voiced by TTS.

import type { AnnouncerPackId, SoundClipName } from './audio';

export type AnnouncerLineSet = Partial<Record<SoundClipName, string[]>>;

export const ANNOUNCER_PACK_LINES: Record<AnnouncerPackId, AnnouncerLineSet> = {
  // Classic procedural announcer — no generated lines (uses SOUND_URLS + TTS).
  legacy: {},

  // Kuon — a cheerful, clear, steady Japanese-anime announcer. Upbeat and
  // encouraging (it hypes you up and never kicks you when you're down), with a
  // light sprinkle of anime flavor. Variety on every callout.
  kuon: {
    // Deploy / respawn — encouragement (the "never give up" voice).
    'spawn': ['Let\'s go!', 'You\'ve got this!', 'Ganbatte — do your best!', 'Show them your power!', 'Back in the fight!'],

    'first-blood': ['First blood!', 'First strike — nice!', 'You drew first blood!'],
    'double-kill': ['Double kill!', 'Two at once!', 'Nice combo!'],
    'triple-kill': ['Triple kill!', 'Three down — you\'re heating up!', 'Triple! Keep going!'],
    'quad-kill': ['Quad kill!', 'Four kills — amazing!', 'Quad kill! Sugoi!'],
    'penta-kill': ['Penta kill!', 'Five kills?! Incredible!', 'Penta kill — you\'re a star!'],

    'killing-spree': ['Killing spree!', 'You\'re on fire — keep it up!', 'Spree! Don\'t stop now!'],
    'rampage': ['Rampage!', 'They can\'t stop you!', 'You\'re rampaging!'],
    'dominating': ['Dominating!', 'You rule this arena!', 'Total domination!'],
    'unstoppable': ['Unstoppable!', 'Nobody can touch you!', 'An unstoppable force!'],
    'godlike': ['Godlike!', 'You\'ve ascended!', 'A true legend — godlike!'],

    'headshot': ['Headshot!', 'Right between the eyes!', 'Perfect aim!', 'Bullseye!'],
    'humiliation': ['Humiliation!', 'How embarrassing for them!', 'Completely outclassed!'],
    'comeback': ['Comeback!', 'What a turnaround!', 'You never gave up — comeback!'],
    'match-point': ['Match point!', 'One more — you can do it!', 'So close now!'],

    'victory': ['Victory!', 'You did it! Champion!', 'Winner — that was wonderful!'],
    // Even defeat is gentle + encouraging — Kuon's whole personality.
    'defeat': ['Defeat…', 'Don\'t give up — next time!', 'So close! You\'ll get them next round.'],
  },
};

// Variant line texts for a pack's clip (empty = pack doesn't voice this event →
// audio.ts falls back to the legacy file / procedural / TTS).
export function announcerVariants(pack: AnnouncerPackId, clip: SoundClipName): string[] {
  return ANNOUNCER_PACK_LINES[pack]?.[clip] ?? [];
}

// How many `<clip>_<i>.mp3` files this pack has for the event (0 = none).
export function announcerVariantCount(pack: AnnouncerPackId, clip: SoundClipName): number {
  return announcerVariants(pack, clip).length;
}
