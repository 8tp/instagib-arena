import type { GameMode } from './constants';

export type Vec3 = { x: number; y: number; z: number };

export type AABB = { min: Vec3; max: Vec3 };

export type EntityId = string;

export type InputState = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  jumpPressed: boolean;
  dash: boolean;
  dashPressed: boolean;
  boost: boolean;
  boostPressed: boolean;
  fire: boolean;
  firePressed: boolean;
  zoom: boolean; // held → narrow FOV
  scoreboard: boolean;
  chatPressed: boolean; // edge: the chat key was just pressed (open the composer)
  yawDelta: number;
  pitchDelta: number;
};

export type BotState = {
  id: EntityId;
  name: string;
  pos: Vec3;
  alive: boolean;
  respawnTimer: number;
  moveTimer: number;
};

export type Medal =
  | 'first-blood'
  | 'headshot'
  | 'mid-air'
  | 'double-kill'
  | 'multi-kill'
  | 'ultra-kill'
  | 'monster-kill'
  | 'killing-spree'
  | 'rampage'
  | 'dominating'
  | 'unstoppable'
  | 'godlike'
  | 'comeback';

export type MedalTier = 'multi' | 'streak' | 'special';

export type PlayerScore = {
  id: EntityId;
  name: string;
  isLocal: boolean;
  frags: number;
  deaths: number;
  bestStreak: number;
  currentStreak: number;
  // Accuracy as a percent (0..100), or null when unknown (e.g. remote players —
  // the server doesn't report their shot counts).
  accuracy: number | null;
  // Team index (0 = red, 1 = blue) in TDM; null in FFA/Duel.
  team?: number | null;
  // Equipped cosmetics, used to render this player on the end-of-match podium.
  // Known for the local player + (online) remotes; absent for offline bots.
  hat?: string;
  emote?: string;
  // Round-trip ping (ms) for online players; undefined for bots / offline.
  ping?: number;
  // Account moderation flags (online only): staff badge + verified blue check.
  admin?: boolean;
  verified?: boolean;
};

// Duel HUD: round number + each side's round wins.
export type DuelHud = {
  roundNum: number;
  roundsToWin: number;
  myWins: number;
  oppWins: number;
};

export type KillfeedEntry = {
  id: number;
  killer: string;
  killerLocal: boolean;
  victim: string;
  weapon: 'rail';
  special: 'mid-air' | 'headshot' | null;
  remaining: number;
  total: number;
};

export type ToastEntry = {
  id: number;
  medal: Medal;
  title: string;
  subtitle?: string;
  tier: MedalTier;
  remaining: number;
  total: number;
};

// One line in the in-game chat log. Identity is server-authoritative; `at` is a
// Date.now() stamp used purely for the idle fade-out when the composer is closed.
export type ChatLine = {
  id: number;
  name: string;
  text: string;
  admin: boolean;
  verified: boolean;
  guest: boolean;
  at: number;
};

export type BannerState = {
  id: number;
  tier: MedalTier;
  title: string;
  subtitle?: string;
  remaining: number;
  total: number;
};

export type HitMarker = {
  id: number;
  kind: 'hit' | 'kill' | 'headshot';
  remaining: number;
  total: number;
};

// "Gibbed <victim>" floating text when YOU score a kill.
export type KillConfirm = {
  id: number;
  victimName: string;
  headshot: boolean;
  remaining: number;
  total: number;
};

// Brief full-screen confirmation pulse when YOU score a kill (edge vignette, so
// it never covers the crosshair). Tinted amber for headshots, cyan otherwise.
export type KillFlash = {
  id: number;
  headshot: boolean;
  remaining: number;
  total: number;
};

// Killcam state when YOU are dead. While non-null, the camera is locked
// onto the killer and the player's input is ignored — clears when the
// timer runs out and gameplay resumes from the new spawn.
// A player's "card" shown on kill (Valorant-style kill banner): card graphic +
// level + the player's chosen career stats. Built client-side from the profile.
export type CardPayload = {
  name: string;
  level: number;
  style: string; // card cosmetic id
  stats: { label: string; value: string }[]; // up to 3
  verified?: boolean; // blue verified check (server-set from the account)
  admin?: boolean; // staff badge (server-set from the account)
};

export type KillcamState = {
  killerId: string;
  killerName: string;
  deathPos: Vec3;
  remaining: number;
  total: number;
  killerCard?: CardPayload; // the killer's playercard (shown on the death screen)
  // On-screen bearing (radians) from your view-forward to the killer at the
  // moment of death: 0 = dead ahead, +π/2 = your right. Drives the directional
  // "shot came from here" arrow so you learn where you're getting picked from.
  dirAngle?: number;
};

export type NetStatus = 'off' | 'idle' | 'connecting' | 'open' | 'closed' | 'error';

// End-of-match map vote (multiplayer). While non-null the pointer is released
// and the vote overlay is shown; the countdown self-ticks off `endsAtClient`
// (already converted to the local Date.now() clock).
export type MapVoteState = {
  options: string[]; // mapIds on the ballot
  endsAtClient: number; // Date.now()-domain deadline
  durationMs: number;
  counts: Record<string, number>; // mapId → votes
  myVote: string | null;
};

// "Play of the Match" cinematic state. While non-null the end-of-match replay
// is playing in the live 3D scene (camera taken over by the ReplayPlayer) and
// the results/podium/vote overlays are suppressed in React until it clears.
export type PomState = {
  // Sequence: slow-mo of the final blow → VICTORY/DEFEAT card → Play of the Match.
  phase: 'finale' | 'verdict' | 'potg';
  won: boolean; // drives the VICTORY/DEFEAT card
  star: string; // star player's name
  label: string; // headline, e.g. "TRIPLE KILL"
  subLabel?: string; // e.g. "3 KILLS"
  remaining: number; // seconds left in the clip (drives the auto-advance bar)
  total: number; // clip duration in seconds
  // Bumps each time the POV star scores a kill during the replay, so the overlay
  // can flash a hit-marker (clarifies what's happening). `hitHeadshot` colours it.
  hitId: number;
  hitHeadshot: boolean;
};

export type HudState = {
  frags: number;
  railCooldown: number;
  dashCooldown: number;
  airJumpsLeft: number;
  boostReady: boolean; // a boostable surface is in range under the crosshair
  speed: number;
  locked: boolean;
  currentStreak: number;
  bestStreak: number;
  fps: number;
  scores: PlayerScore[];
  killfeed: KillfeedEntry[];
  toasts: ToastEntry[];
  banner: BannerState | null;
  hitMarker: HitMarker | null;
  killConfirm: KillConfirm | null;
  killFlash: KillFlash | null;
  damageFlash: number; // 0..1 red "you were hit" vignette intensity (decays)
  killcam: KillcamState | null;
  showScoreboard: boolean;
  matchOver: { won: boolean } | null; // non-null freezes the match → results screen
  netStatus: NetStatus;
  netPeers: number;
  netRttMs: number; // round-trip time to the game server (0 when offline)
  warmupMsLeft: number; // ms left in the match-start "get ready" warmup; 0 when live
  localInvulnMs: number; // remaining server-tracked invuln; 0 when killable
  vote: MapVoteState | null; // non-null → end-of-match map vote in progress
  // Active game mode (offline defaults to 'ffa').
  mode: GameMode;
  localTeam: number | null; // your team index in TDM; null otherwise
  // TDM team frag totals [red, blue]; null outside TDM.
  teamScores: [number, number] | null;
  // Duel round state; null outside Duel.
  duel: DuelHud | null;
  // Training-range live stats; null outside the training range.
  training: TrainingHud | null;
  // Play of the Match cinematic; non-null → replay playing, results deferred.
  pom: PomState | null;
  // In-game chat: the composer's open state + the recent message log.
  chat: { open: boolean; lines: ChatLine[] };
};

export type TrainingHud = {
  shots: number;
  hits: number;
  destroyed: number;
  streak: number;
  bestStreak: number;
  accuracy: number; // 0..1
  elapsed: number; // seconds
};
