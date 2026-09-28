// Shared app-level types (settings, profile, progression) — split out of
// InstagibClient.tsx so the Locker, results and menu modules can import them
// without a runtime import cycle.
import type { AnnouncerPackId } from './game/audio';
import type { BotDifficulty, KeybindAction } from './game/constants';
import type { KillEffectStyle } from './game/cosmetics';
import type { RewardExtras } from './game/progression';

export type CrosshairConfig = {
  style: 'cross' | 'cross-dot' | 'dot' | 'circle';
  color: string; // hex
  size: number; // arm length px
  thickness: number; // px
  gap: number; // px from center
  dotSize: number; // px (center dot radius)
  outline: boolean; // outline for contrast
  outlineThickness: number; // outline stroke width px
  outlineColor: string; // hex
};

export type Settings = {
  sensitivity: number; // Source/CS2-style sens number
  dpi: number; // mouse DPI (feeds cm/360 readout only)
  vertScale: number; // vertical (pitch) sensitivity multiplier
  zoomSens: number; // ADS/zoom sensitivity multiplier (1 = FOV-scaled default)
  rawInput: boolean; // pointer-lock unadjustedMovement
  keybinds: Record<KeybindAction, string>; // action → KeyboardEvent.code
  fov: number;
  zoomFov: number; // FOV while the zoom bind is held
  viewmodelOffset: { x: number; y: number; z: number }; // railgun viewmodel nudge
  hideViewmodel: boolean; // hide the first-person gun
  viewmodelMotion: number; // 0..1 bob / sway / landing-dip intensity (fire kick always stays)
  volume: number; // master
  sfxVolume: number;
  uiSounds: boolean; // menu clicks / hovers / toggles (still scaled by master × SFX)
  announcerVolume: number;
  announcerEnabled: boolean;
  announcerPack: AnnouncerPackId; // which announcer voice pack (legacy = default procedural)
  captions: boolean; // a11y: show announcer/medal/match callouts as on-screen text
  showFps: boolean;
  showPing: boolean; // show each player's ping in the Tab scoreboard (online)
  fpsLimit: number; // 0 = VSync (display), >0 = cap to N fps, -1 = uncapped
  resolutionScale: number; // render resolution multiplier (perf ↔ sharpness)
  lowSpec: boolean; // cap high-DPI at 1× + thin particle effects
  // Post-processing toggles (Game.setPostFx). Low-spec forces all four off.
  bloom: boolean;
  shadows: boolean;
  antialias: boolean; // SMAA
  vignette: boolean;
  uiScale: number; // HUD scale multiplier
  botsEnabled: boolean;
  multiplayer: boolean;
  serverUrl: string;
  playerName: string;
  mapId: string; // remembered Create-Match map
  difficulty: BotDifficulty; // remembered Create-Match / quick-match bot difficulty
  crosshair: CrosshairConfig;
  worldColor: string; // hex tint on arena surfaces ('#ffffff' = neutral)
  worldBrightness: number; // 0..1 full-bright emissive boost on surfaces
  enemyColor: string; // hex highlight applied to enemies when enemyBright is on
  enemyBright: boolean; // make enemies glow bright for visibility (Ratz-style)
  killEffect: KillEffectStyle; // equipped kill-effect cosmetic (the frag explosion)
  railColor: string; // equipped rail-beam color cosmetic
  railgunFinish: string; // equipped railgun finish (first-person gun skin)
  hat: string; // equipped hat cosmetic (worn on the player model)
  unusual: string; // equipped unusual particle effect (on the hat)
  card: string; // equipped playercard style (kill banner)
  cardStats: string[]; // up to 3 career-stat keys shown on the card
  emote: string; // equipped emote (played on the end-of-match podium)
  nameColor: string; // equipped nameplate color (seen by others)
  spawnEffect: string; // equipped spawn-in effect
  title: string; // equipped title flair (shown under the name + on the scoreboard/card)
  reducedEffects: boolean; // accessibility: suppress camera shake + kill flash + heavy bursts
  hideChat: boolean; // hide the in-game chat log + disable opening the composer
};

export type InstagibStats = {
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
};

// Progression delta returned by POST /api/stats — drives the end-of-match XP
// moment. Mirrors the server `MatchRecordResult` (minus the legacy `stats`).
export type ProgressionResp = Partial<RewardExtras> & {
  xpGained: number;
  creditsGained: number;
  leveledUp: boolean;
  newUnlocks: string[];
  progression: {
    totalXp: number;
    level: number;
    credits: number;
    unlocked: string[];
    equipped: Record<string, string>;
  };
};

export type InstagibProfile = {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNext: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
  stats: InstagibStats;
  ranked: { rating: number; rank: number; provisional: boolean } | null;
};
