import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { memo } from 'react';
import {
  HudStore,
  HudStoreContext,
  cssVars,
  hudTiming,
  shallowEqual,
  useExitList,
  useHudLatched,
  useHudSlice,
  useStoreSlice,
} from './hud-store';
import { Game, type HudListener, type MatchResult, type NetMatchEvent } from './game/game';
import { useAuth, LoginModal, type Account } from './auth';
import { FeedbackModal } from './FeedbackModal';
import {
  DeckButton,
  DeckSwitch,
  DeckTab,
  ModalShell,
  SegButton,
  Skeleton,
  TextButton,
  ToastStack as MenuToasts, // the in-match HUD has its own ToastStack below
  UtilButton,
} from './deck';
import { prefersReducedMotion, sfxProps, toast, useAnyModalOpen, useModalStack } from './deck-core';
import { MenuBackdropView } from './menu/MenuBackdropView';
import type { HeroLoadout } from './menu/menu-hero';
import { ProfileBlock } from './menu/ProfileBlock';
import { FrontDoors } from './menu/FrontDoors';
import { AccountMenu } from './menu/AccountMenu';
import { HeroSlot } from './menu/HeroSlot';
import { ChallengesModal, ChallengesStrip } from './menu/Challenges';
import { CareerRoad } from './menu/CareerRoad';
import { LastMatchBanner } from './menu/LastMatch';
import { fetchChallenges, useMedia, useRefetchAtReset } from './menu/menu-hooks';
import { freshCatchUp, gainFrom, type ChallengeLists, type MenuProfile } from './menu/road-data';
import { MenuItem, MenuLink, MenuPlayButton, MenuWordmark, SocialDock, type DockTabId } from './ui/menu-parts';
import { LoadingScreen, type LoadStep } from './ui/LoadingScreen';
import { useLevelshot } from './ui/levelshot';
import { NameBadges } from './ui/badges';
import { HUD_EXIT_LEAD_MS, HUD_EXIT_MS } from './ui/hud-const';
import { FightCall, HudXpTicker, Killfeed, QuakeScoreboard, ScoreBoxes, type HudMatchInfo } from './ui/hud-quake';
import { fragLimitFor, mapIdByName, mapNameById, modeLine, modeTitle, placementLine, type MatchFlavor } from './ui/match-info';
import { CONTROLS } from './controls';
import { MAPS, mapById } from './game/map';
import { ANNOUNCER_PACKS, DEFAULT_ANNOUNCER_PACK, setUiVolume, type AnnouncerPackId } from './game/audio';
import { ReplayViewer, type ReplayViewerState } from './game/replay-viewer';
import { decodeReplay, type ReplayData } from './game/replay-codec';
import {
  LobbyClient,
  type LobbyRoom,
  type LobbyStatus,
  type PresenceState,
  type PresencePlayer,
  type ChatMessage,
  type RankedStatus,
  type RankedRoom,
  type RankedResult,
} from './game/net';
import { withLegacyFromLooks } from './game/look-runtime';
import { itemDef } from './game/items/catalog';
import { TIER_META, qualityPrefix, wearName } from './game/items/types';
import { ONLINE_MAP_POOL } from './game/arena-data';
import {
  AIR_JUMPS,
  cm360,
  DASH_COOLDOWN,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_GAME_MODE,
  DEFAULT_KEYBINDS,
  DEFAULT_DPI,
  DEFAULT_FOV,
  DEFAULT_ZOOM_FOV,
  DEFAULT_VIEWMODEL_OFFSET,
  DEFAULT_RAW_INPUT,
  DEFAULT_SENSITIVITY,
  DEFAULT_VERT_SCALE,
  DEFAULT_VOLUME,
  GAME_MODES,
  HIT_MARKER_DURATION_SEC,
  HIT_MARKER_KILL_DURATION_SEC,
  M_YAW_DEG,
  MAX_DPI,
  MAX_FOV,
  MAX_ZOOM_FOV,
  MAX_VIEWMODEL_OFFSET,
  MAX_PLAYERS,
  MAX_SENSITIVITY,
  MAX_VERT_SCALE,
  MIN_DPI,
  MIN_FOV,
  MIN_ZOOM_FOV,
  MIN_VIEWMODEL_OFFSET,
  MIN_SENSITIVITY,
  MIN_VERT_SCALE,
  KEYBIND_ACTIONS,
  RAIL_COOLDOWN,
  SENSITIVITY_STEP,
  TOAST_FADE_SEC,
  rankedTier,
  WEEKLY_CHALLENGE_MAP,
  WEEKLY_CHALLENGE_BOTS,
  WEEKLY_CHALLENGE_DIFFICULTY,
  WEEKLY_CHALLENGE_MODE,
  WEEKLY_CHALLENGE_FRAG_LIMIT,
  type BotDifficulty,
  type GameMode,
  type KeybindAction,
} from './game/constants';
import type {
  BannerState,
  ChatLine,
  HitMarker,
  HudState,
  KillFlash,
  KillcamState,
  MapVoteState,
  MedalTier,
  PlayerScore,
  PomState,
  ToastEntry,
  TrainingHud,
} from './game/types';
import { FragPopup } from './game/kill-overlays';
import {
  DEFAULT_KILL_EFFECT,
  DEFAULT_RAIL_COLOR,
  DEFAULT_RAILGUN_FINISH,
  DEFAULT_HAT,
  DEFAULT_UNUSUAL,
  DEFAULT_CARD,
  DEFAULT_EMOTE,
  DEFAULT_NAME_COLOR,
  DEFAULT_SPAWN_EFFECT,
  DEFAULT_TITLE,
  announcerPackCosmeticId,
  cosmeticById,
  sourceLabel,
} from './game/cosmetics';
import type { CrosshairConfig, InstagibProfile, ProgressionResp, Settings } from './app-types';
import { setCharacterFxQuality } from './game/character/gibs';
import { setFxQuality } from './game/fx-pool';
import { Locker } from './locker/Locker';
import { MatchOverOverlay, OnlineMatchResults } from './ui/results';
import { PlayerCard } from './ui/player-card';
import { buildCardPayload } from './ui/player-card-data';

const CROSSHAIR_STYLES = ['cross', 'cross-dot', 'dot', 'circle'] as const;

// Quick-apply shape presets (each sets the full shape config; color/outline are
// kept from the current crosshair). Three visually-distinct starting points.
const CROSSHAIR_SHAPE_PRESETS: Array<{
  id: string;
  label: string;
  cfg: Partial<CrosshairConfig>;
}> = [
  { id: 'plus-gap', label: 'Plus · gap', cfg: { style: 'cross', size: 6, thickness: 2, gap: 4, dotSize: 0 } },
  { id: 'plus-solid', label: 'Plus · solid', cfg: { style: 'cross', size: 8, thickness: 2, gap: 0, dotSize: 0 } },
  { id: 'dot', label: 'Dot', cfg: { style: 'dot', size: 0, thickness: 2, gap: 0, dotSize: 3 } },
];

// Compact, URL-safe, copy-pasteable share code (prefixed so it's recognizable).
function encodeCrosshair(c: CrosshairConfig): string {
  const arr = [
    CROSSHAIR_STYLES.indexOf(c.style),
    c.color.replace('#', ''),
    c.size,
    c.thickness,
    c.gap,
    c.dotSize,
    c.outline ? 1 : 0,
    c.outlineThickness,
    c.outlineColor.replace('#', ''),
  ];
  const b64 = btoa(JSON.stringify(arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `IGX-${b64}`;
}

function decodeCrosshair(code: string): CrosshairConfig | null {
  try {
    const body = code.trim().replace(/^IGX-/i, '').replace(/-/g, '+').replace(/_/g, '/');
    const arr = JSON.parse(atob(body)) as unknown[];
    if (!Array.isArray(arr)) return null;
    const hex = (v: unknown, fb: string) =>
      typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v}` : fb;
    const num = (v: unknown, lo: number, hi: number, fb: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fb;
    };
    const style = CROSSHAIR_STYLES[Number(arr[0])] ?? DEFAULT_CROSSHAIR.style;
    return {
      style,
      color: hex(arr[1], DEFAULT_CROSSHAIR.color),
      size: num(arr[2], 0, 40, DEFAULT_CROSSHAIR.size),
      thickness: num(arr[3], 1, 10, DEFAULT_CROSSHAIR.thickness),
      gap: num(arr[4], 0, 30, DEFAULT_CROSSHAIR.gap),
      dotSize: num(arr[5], 0, 12, DEFAULT_CROSSHAIR.dotSize),
      outline: !!arr[6],
      outlineThickness: num(arr[7], 1, 4, DEFAULT_CROSSHAIR.outlineThickness),
      outlineColor: hex(arr[8], DEFAULT_CROSSHAIR.outlineColor),
    };
  } catch {
    return null;
  }
}

// Full-settings share code (IGS-) — base64url of the settings JSON, for backing
// up / moving a complete config between browsers. Mirrors the crosshair code.
function encodeSettings(s: Settings): string {
  const b64 = btoa(JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `IGS-${b64}`;
}

function decodeSettings(code: string): Settings | null {
  try {
    const body = code.trim().replace(/^IGS-/i, '').replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(body)) as Partial<Settings>;
    if (!parsed || typeof parsed !== 'object') return null;
    // Merge over defaults so a partial/older code fills gaps and new fields survive.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      crosshair: { ...DEFAULT_CROSSHAIR, ...(parsed.crosshair ?? {}) },
      keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds ?? {}) },
      viewmodelOffset: { ...DEFAULT_VIEWMODEL_OFFSET, ...(parsed.viewmodelOffset ?? {}) },
    };
  } catch {
    return null;
  }
}

// (The reduced-effects toggle defaults to the OS "reduce motion" preference —
// prefersReducedMotion() is shared with the deck chrome in src/deck-core.ts.)

export type MatchConfig =
  | {
      mode: 'local';
      mapId: string;
      botCount: number;
      difficulty: BotDifficulty;
      training?: boolean; // endless practice — no frag-limit match end
      gameMode?: GameMode; // ffa (default) / duel / tdm for Solo vs Bots
      challenge?: boolean; // weekly-challenge run (8p FFA speedrun vs easy bots → weekly board, not career)
    }
  // pendingMap: the map is a placeholder until the server confirms the join
  // (invite links) — the loading screen waits for the real one.
  | { mode: 'multiplayer'; mapId: string; serverUrl: string; roomId: string; pendingMap?: boolean }
  // Watch a live match read-only (first-person POV). mapId is a placeholder until
  // the server confirms which room/map we're spectating (Game adopts it then).
  | { mode: 'spectator'; mapId: string; serverUrl: string; roomId: string };

// The game server is served on the same origin as the web client (the Node
// server hosts both the static build and the /ws/instagib socket), so the
// default multiplayer URL is derived from the current location: ws in dev,
// wss behind TLS. In dev, Vite proxies /ws to the backend (see vite.config.ts).
function defaultServerUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws/instagib';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/instagib`;
}

const DEFAULT_CROSSHAIR: CrosshairConfig = {
  style: 'cross',
  color: '#00ff88',
  size: 6,
  thickness: 2,
  gap: 4,
  dotSize: 0,
  outline: true,
  outlineThickness: 1,
  outlineColor: '#000000',
};

const DEFAULT_SETTINGS: Settings = {
  sensitivity: DEFAULT_SENSITIVITY,
  dpi: DEFAULT_DPI,
  vertScale: DEFAULT_VERT_SCALE,
  zoomSens: 1,
  rawInput: DEFAULT_RAW_INPUT,
  keybinds: DEFAULT_KEYBINDS,
  fov: DEFAULT_FOV,
  zoomFov: DEFAULT_ZOOM_FOV,
  viewmodelOffset: { ...DEFAULT_VIEWMODEL_OFFSET },
  hideViewmodel: false,
  viewmodelMotion: 1,
  volume: DEFAULT_VOLUME,
  sfxVolume: 1,
  uiSounds: true,
  announcerVolume: 1,
  announcerEnabled: true,
  announcerPack: DEFAULT_ANNOUNCER_PACK,
  captions: false,
  showFps: false,
  showPing: true,
  fpsLimit: 0,
  resolutionScale: 1,
  lowSpec: false,
  bloom: true,
  bloomIntensity: 0.8,
  shadows: true,
  antialias: true,
  vignette: true,
  uiScale: 1,
  botsEnabled: true,
  multiplayer: false,
  serverUrl: '',
  playerName: '',
  mapId: 'causeway',
  difficulty: DEFAULT_BOT_DIFFICULTY,
  crosshair: DEFAULT_CROSSHAIR,
  worldColor: '#ffffff',
  worldBrightness: 0,
  enemyColor: '#ff2bd6',
  enemyBright: false,
  killEffect: DEFAULT_KILL_EFFECT,
  railColor: DEFAULT_RAIL_COLOR,
  railgunFinish: DEFAULT_RAILGUN_FINISH,
  hat: DEFAULT_HAT,
  unusual: DEFAULT_UNUSUAL,
  card: DEFAULT_CARD,
  cardStats: ['kills', 'wins', 'kd'],
  emote: DEFAULT_EMOTE,
  nameColor: DEFAULT_NAME_COLOR,
  spawnEffect: DEFAULT_SPAWN_EFFECT,
  title: DEFAULT_TITLE,
  reducedEffects: prefersReducedMotion(),
  hideChat: false,
};

const SETTINGS_KEY = 'instagib-settings-v2';

function loadSettings(): Settings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // Nested objects need an explicit merge so newly-added fields survive.
      crosshair: { ...DEFAULT_CROSSHAIR, ...(parsed.crosshair ?? {}) },
      keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds ?? {}) },
      viewmodelOffset: { ...DEFAULT_VIEWMODEL_OFFSET, ...(parsed.viewmodelOffset ?? {}) },
    };
    // Migrate legacy sensitivity: the old model stored radians/pixel (~0.0022).
    // Anything below the new minimum is a legacy value → convert to the
    // Source-style sens number so people keep roughly the same feel.
    if (typeof parsed.sensitivity === 'number' && parsed.sensitivity < MIN_SENSITIVITY) {
      merged.sensitivity = Math.min(
        MAX_SENSITIVITY,
        parsed.sensitivity / (M_YAW_DEG * (Math.PI / 180)),
      );
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Auto-generated placeholder name (see the mount effect). Matches the shape we
// create so we can avoid persisting it.
const AUTO_NAME_RE = /^Player-[0-9A-Z]{4}$/;

function saveSettings(s: Settings) {
  if (typeof window === 'undefined') return;
  try {
    // Don't persist the auto-generated name (#21): if we did, every tab on this
    // machine would load the same "Player-XXXX", making the scoreboard/killfeed
    // ambiguous when testing with two tabs. Each tab regenerates its own until
    // the user types a real one (which is then persisted normally).
    const toSave = AUTO_NAME_RE.test(s.playerName) ? { ...s, playerName: '' } : s;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
  } catch {
    // ignore
  }
}

// Optional-chained setters tolerate stale Game instances surviving a Fast
// Refresh, so a missing newly-added method never crashes the component.
// Player preferences only. Map / bots / multiplayer are driven by the match
// config (see applyMatchConfig), not by persisted settings.
function applySettingsToGame(game: Game, s: Settings) {
  game.setSensitivity?.(s.sensitivity);
  game.setVertScale?.(s.vertScale);
  game.setZoomSens?.(s.zoomSens);
  game.setRawInput?.(s.rawInput);
  game.setQuality?.(s.resolutionScale, s.lowSpec);
  game.setPostFx?.({ bloom: s.bloom, shadows: s.shadows, aa: s.antialias, vignette: s.vignette });
  game.setBloomScale?.(s.bloomIntensity ?? 0.8);
  game.setKeybinds?.(s.keybinds);
  game.setFov?.(s.fov);
  game.setZoomFov?.(s.zoomFov);
  game.setViewmodel?.(s.viewmodelOffset, s.hideViewmodel);
  game.setViewmodelMotion?.(s.viewmodelMotion);
  game.setMasterVolume?.(s.volume);
  game.setSfxVolume?.(s.sfxVolume);
  game.setAnnouncerVolume?.(s.announcerVolume);
  game.setAnnouncerEnabled?.(s.announcerEnabled);
  game.setAnnouncerPack?.(s.announcerPack);
  game.setPlayerName?.(s.playerName);
  game.setWorldStyle?.(s.worldColor, s.worldBrightness);
  game.setEnemyStyle?.(s.enemyBright ? s.enemyColor : null);
  game.setKillEffect?.(s.killEffect);
  game.setRailColor?.(s.railColor);
  game.setRailgunFinish?.(s.railgunFinish);
  // Echo the crosshair (as a share-code) so a spectator can render the same
  // reticle we use; the local HUD still draws it from settings.crosshair.
  game.setCrosshairCode?.(encodeCrosshair(s.crosshair));
  const strange = s.finishItem?.quality.includes('strange') ? (s.finishItem.attrs.kills ?? 0) : null;
  game.setLooks?.(s.looks, s.equippedUids, strange);
  game.setHat?.(s.hat);
  game.setUnusual?.(s.unusual);
  game.setEmote?.(s.emote);
  game.setNameColor?.(s.nameColor);
  game.setSpawnEffect?.(s.spawnEffect);
  game.setTitle?.(s.title);
  game.setReducedEffects?.(s.reducedEffects);
  game.setHideChat?.(s.hideChat);
  game.setFpsLimit?.(s.fpsLimit);
}

// Configures a freshly-created Game for a match before start().
function applyMatchConfig(game: Game, config: MatchConfig) {
  game.setMap(mapById(config.mapId));
  if (config.mode === 'spectator') {
    game.setBotsEnabled(false);
    game.setMultiplayer({ enabled: true, url: config.serverUrl, roomId: config.roomId, spectate: true });
  } else if (config.mode === 'multiplayer') {
    game.setBotsEnabled(false);
    game.setMultiplayer({ enabled: true, url: config.serverUrl, roomId: config.roomId });
  } else {
    game.setMultiplayer({ enabled: false, url: '' });
    game.setTraining(config.training ?? false);
    game.setBotDifficulty(config.difficulty);
    game.setBotCount(config.botCount);
    game.setBotsEnabled(true);
    game.setBotMode(config.gameMode ?? 'ffa'); // after the bots exist (sets teams in TDM)
    // Weekly challenge: a fixed-map FFA speedrun whose whole run is recorded for a
    // rewatchable replay (and a dedicated frag cap). Marks the run on the engine.
    if (config.challenge) game.setChallenge(config.mapId);
  }
}

// Touch-first or Save-Data devices get a still backdrop frame instead of the
// live 30 fps arena (the Landing page skips 3D on these entirely).
const LIGHT_DEVICE =
  typeof window !== 'undefined' &&
  ((window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true);

const INITIAL_HUD: HudState = {
  frags: 0,
  railCooldown: 0,
  dashCooldown: 0,
  airJumpsLeft: AIR_JUMPS,
  boostReady: false,
  speed: 0,
  locked: false,
  currentStreak: 0,
  bestStreak: 0,
  fps: 60,
  scores: [],
  killfeed: [],
  toasts: [],
  banner: null,
  mapId: '',
  netJoined: false,
  mapSwitchId: 0,
  hitMarker: null,
  killConfirm: null,
  killFlash: null,
  damageFlash: 0,
  killcam: null,
  taunting: false,
  showScoreboard: false,
  matchOver: null,
  netStatus: 'off',
  netPeers: 0,
  netRttMs: 0,
  warmupMsLeft: 0,
  localInvulnMs: 0,
  vote: null,
  mode: 'ffa',
  localTeam: null,
  teamScores: null,
  training: null,
  pom: null,
  chat: { open: false, lines: [] },
  netDebug: null,
  spectator: null,
};

export default function InstagibClient() {
  const auth = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  // Every settings write keeps the legacy per-slot ids in step with `looks`.
  const [settings, setSettingsRaw] = useState<Settings>(DEFAULT_SETTINGS);
  const setSettings = useCallback(
    (u: Settings | ((s: Settings) => Settings)) =>
      setSettingsRaw((prev) => withLegacyFromLooks(typeof u === 'function' ? u(prev) : u)),
    [],
  );
  const [view, setView] = useState<'lobby' | 'playing'>('lobby');
  const [config, setConfig] = useState<MatchConfig | null>(null);
  const [lastResult, setLastResult] = useState<MatchResult | null>(null);
  // The last match's reward payload, for the lobby's last-match banner.
  const [lastProgression, setLastProgression] = useState<ProgressionResp | null>(null);
  // Bumped on every match start so GameView remounts a fresh Game (also for
  // "Play Again" with the same config).
  const [playId, setPlayId] = useState(0);
  // First-run onboarding (pick a name + a controls primer), shown once.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // A ?join= invite arriving on the FIRST run is held here until onboarding is
  // done, so a first-time invitee still sees the controls primer before locking.
  const pendingJoinRef = useRef<MatchConfig | null>(null);

  // Menu-side 3D (Locker / Career Road previews, thumbnails, the menu hero)
  // honours Reduce effects + Low spec too — the Game only sets these while a
  // match is mounted.
  useEffect(() => {
    setCharacterFxQuality({ reducedEffects: settings.reducedEffects, lowSpec: settings.lowSpec });
    setFxQuality(settings.lowSpec ? 0.5 : 1);
  }, [settings.reducedEffects, settings.lowSpec]);

  // Load persisted settings once on mount + backfill window-dependent defaults.
  useEffect(() => {
    const loaded = loadSettings();
    if (!loaded.serverUrl) loaded.serverUrl = defaultServerUrl();
    if (!loaded.playerName) {
      const stamp = Math.random().toString(36).slice(2, 6).toUpperCase();
      loaded.playerName = `Player-${stamp}`;
    }
    setSettings(loaded);
    // First visit (no onboarded flag) → show the welcome / name / controls primer.
    const firstRun =
      typeof window !== 'undefined' && !window.localStorage.getItem('instagib-onboarded');
    if (firstRun) setShowOnboarding(true);

    // Invite link: ?join=ROOMID drops straight into that room. The map is
    // unknown until the server confirms the join (Game adopts it then), so we
    // pass a placeholder map; clear the param so a refresh doesn't re-join.
    if (typeof window !== 'undefined') {
      const code = new URLSearchParams(window.location.search).get('join');
      if (code && /^[A-Z0-9]{3,10}$/i.test(code)) {
        const url = new URL(window.location.href);
        url.searchParams.delete('join');
        window.history.replaceState({}, '', url.toString());
        const joinCfg: MatchConfig = {
          mode: 'multiplayer',
          mapId: randomMapId(),
          serverUrl: loaded.serverUrl || defaultServerUrl(),
          roomId: code.toUpperCase(),
          pendingMap: true,
        };
        // On a first-run invite, hold the join until onboarding finishes so the
        // newcomer isn't dropped straight into pointer-lock with no primer.
        if (firstRun) pendingJoinRef.current = joinCfg;
        else startMatch(joinCfg);
      }
    }
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // The menu UI sounds (src/game/audio.ts) follow the same master × SFX
  // sliders as gameplay audio, so muting SFX also mutes the deck chrome. The
  // "UI sounds" toggle zeroes just this bus without touching gameplay audio.
  useEffect(() => {
    setUiVolume(settings.uiSounds ? settings.volume : 0, settings.sfxVolume);
  }, [settings.volume, settings.sfxVolume, settings.uiSounds]);

  // Your in-game name is your identity: the account username when logged in,
  // or "Guest" otherwise. This is the source of truth (overrides any old local
  // name) so guests always read "Guest" and accounts always read their handle.
  useEffect(() => {
    if (!auth.ready) return;
    const name = auth.account?.username ?? 'Guest';
    setSettings((s) => (s.playerName === name ? s : { ...s, playerName: name }));
  }, [auth.ready, auth.account]);

  // Bumped per match so a late offline-stats reply can't land on a newer one.
  const exitToken = useRef(0);
  const startMatch = useCallback((cfg: MatchConfig) => {
    exitToken.current++;
    setLastResult(null);
    setLastProgression(null);
    setConfig(cfg);
    setPlayId((n) => n + 1);
    setView('playing');
  }, []);

  // Leave to the lobby. GameView already submitted stats; we only carry the
  // result through for the lobby's "last match" banner (no re-submit here).
  // `pending` = an offline POST /api/stats still in flight: its reply fills in
  // the lobby's last-match rewards when it lands (the lobby is already up).
  const exitToLobby = useCallback(
    (result: MatchResult | null, progression?: ProgressionResp | null, pending?: Promise<ProgressionResp | null> | null) => {
      if (result) setLastResult(result);
      setLastProgression(progression ?? null);
      setView('lobby');
      if (!progression && pending) {
        const token = exitToken.current;
        void pending.then((p) => {
          if (p && token === exitToken.current) setLastProgression(p);
        });
      }
    },
    [],
  );

  const playAgain = useCallback(() => {
    if (config) startMatch(config);
  }, [config, startMatch]);

  const finishOnboarding = useCallback(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('instagib-onboarded', '1');
    setShowOnboarding(false);
    // A held invite-join now proceeds (the player saw the primer first).
    if (pendingJoinRef.current) {
      const cfg = pendingJoinRef.current;
      pendingJoinRef.current = null;
      startMatch(cfg);
    }
  }, [startMatch]);

  if (view === 'playing' && config) {
    if (config.mode === 'spectator') {
      return (
        <SpectatorView
          key={playId}
          config={config}
          settings={settings}
          onChangeSettings={setSettings}
          onExit={() => exitToLobby(null)}
        />
      );
    }
    return (
      <GameView
        key={playId}
        config={config}
        settings={settings}
        onChangeSettings={setSettings}
        onExit={exitToLobby}
        onPlayAgain={playAgain}
        loggedIn={!!auth.account}
        onLogin={(r) => {
          exitToLobby(r);
          setLoginOpen(true);
        }}
      />
    );
  }

  return (
    <>
      <Lobby
        settings={settings}
        onChangeSettings={setSettings}
        onStart={startMatch}
        lastResult={lastResult}
        lastProgression={lastProgression}
        account={auth.account}
        onOpenLogin={() => setLoginOpen(true)}
        onLogout={auth.logout}
      />
      {showOnboarding && (
        <OnboardingModal
          onPlayGuest={finishOnboarding}
          onCreateAccount={() => {
            finishOnboarding();
            setLoginOpen(true);
          }}
        />
      )}
      {loginOpen && <LoginModal auth={auth} onClose={() => setLoginOpen(false)} />}
    </>
  );
}

// First-run welcome: pick a display name + a quick controls primer. Shown once
// (guarded by the `instagib-onboarded` localStorage flag).
function OnboardingModal({
  onPlayGuest,
  onCreateAccount,
}: {
  onPlayGuest: () => void;
  onCreateAccount: () => void;
}) {
  // Escape / backdrop = play as guest (every other modal is escapable). The
  // drifting deck grid inside the sheet is this dialog's one flourish — it is
  // the first thing a new player sees.
  return (
    <ModalShell
      title='Welcome to the Arena'
      onClose={onPlayGuest}
      fixed
      z='z-[60]'
      size='lg'
      className='deck-bg'
      footer={({ close }) => (
        <>
          <DeckButton onClick={close} size='sm' center sound='uiBack'>
            Play as Guest
          </DeckButton>
          <DeckButton onClick={onCreateAccount} solid accent='cyan' center>
            Create account
          </DeckButton>
        </>
      )}
    >
      <p className='-mt-1 font-display text-sm font-semibold uppercase tracking-[0.24em] text-white/80'>
        One railgun. One shot. Pure movement.
      </p>
      <div>
        <div className='deck-label'>Controls</div>
        <div className='mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2'>
          {CONTROLS.map(([key, action]) => (
            <div key={key} className='flex items-baseline gap-2.5 text-[12px]'>
              <kbd className='deck-kbd'>{key}</kbd>
              <span className='font-sans text-white/60'>{action}</span>
            </div>
          ))}
        </div>
      </div>
      <p className='font-sans text-[13px] leading-relaxed text-white/55'>
        Jump in as a <span className='text-white/85'>guest</span> right now — or create a free account
        to save your XP, levels, credits, and cosmetics and climb the leaderboards.
      </p>
    </ModalShell>
  );
}

/* ───────────────────────── In-match view ───────────────────────── */

function GameView({
  config,
  settings,
  onChangeSettings,
  onExit,
  onPlayAgain,
  onLogin,
  loggedIn,
}: {
  config: MatchConfig;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onExit: (
    result: MatchResult | null,
    progression?: ProgressionResp | null,
    pending?: Promise<ProgressionResp | null> | null,
  ) => void;
  onPlayAgain: () => void;
  onLogin: (result: MatchResult | null) => void; // guest → back to the lobby with the login sheet open
  loggedIn: boolean; // the in-match +XP ticker only means something with an account
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endResult, setEndResult] = useState<MatchResult | null>(null);
  // Weapon inspect: while the first-person gun look-over plays, the item card shows.
  const [inspect, setInspect] = useState<{ kills: number | null } | null>(null);
  // Every HudState push (20 Hz + events) lands in this store. GameView itself
  // only re-renders on the SLOW fields it gates overlays with; the in-match
  // HUD pieces subscribe to their own slices inside HudOverlay. The paused
  // card (ClickToPlay) reads live numbers, so those count only while the
  // pointer is unlocked.
  const [hudStore] = useState(() => new HudStore(INITIAL_HUD));
  const hud = useStoreSlice(
    hudStore,
    (s) => ({
      locked: s.locked,
      matchOver: s.matchOver,
      netStatus: s.netStatus,
      netPeers: s.netPeers,
      vote: s.vote,
      pom: s.pom,
      chat: s.chat,
      scores: s.scores,
      frags: s.locked ? 0 : s.frags,
      bestStreak: s.locked ? 0 : s.bestStreak,
      speed: s.locked ? 0 : s.speed,
    }),
    shallowEqual,
  );
  const [endProgression, setEndProgression] = useState<ProgressionResp | null>(null);
  const statsPending = useRef<Promise<ProgressionResp | null> | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Already in this room in another tab: retrying would hit the same refusal.
  const [joinDuplicate, setJoinDuplicate] = useState(false);
  // Ranked Duel end-of-match result (rating delta) → full-screen overlay.
  const [rankedResult, setRankedResult] = useState<RankedResult | null>(null);
  // Weekly-challenge end-of-run standing (rank/best) → small result banner.
  const [challengeResult, setChallengeResult] = useState<WeeklyChallengeMe | null>(null);
  // Online: the results podium is shown briefly at match-end BEFORE the map vote.
  // We freeze the final standings here so a late snapshot can't change the podium.
  const [onlineResults, setOnlineResults] = useState(false);
  const [podiumScores, setPodiumScores] = useState<PlayerScore[]>([]);
  const offlineMatch = config.mode !== 'multiplayer';
  // Only offline (vs-bots) matches are self-reported via POST /api/stats — the
  // server records online matches itself and pushes the rewards over the socket.
  // The training range and spectating never count as a match.
  const reportsOwnStats = config.mode === 'local' && !config.training;
  // The results headline: FFA shows a Q3 placement, TDM/duel Victory/Defeat.
  const modeTag = gameRef.current?.getMatchModeTag();
  const resultsMode: 'ffa' | 'tdm' | 'duel' =
    modeTag === 'ranked' || modeTag === 'duel' ? 'duel' : modeTag === 'tdm' ? 'tdm' : 'ffa';
  // Weekly-challenge run: submits the speedrun (time/kills) + full replay to the
  // weekly board, NOT career K/D. The engine owns the authoritative run time.
  const isChallenge = config.mode === 'local' && config.challenge === true;
  // Q3-style loading screen: the real engine load steps (set in the effect
  // below) + the online handshake read from the HUD stream.
  const [boot, setBoot] = useState({ geometry: false, sounds: false, lighting: false, models: false });
  const [loadGone, setLoadGone] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const listener: HudListener = (state) => hudStore.push(state);
    // Match ended (frag limit): submit stats once + keep the result for the
    // results overlay. Offline navigates from the overlay buttons; online shows
    // the results podium, then continues to the server-driven map vote.
    const game = new Game(canvas, listener, (result) => {
      setEndResult(result);
      if (isChallenge) {
        // Weekly challenge: submit the speedrun (win time, or kills on a loss) to
        // the weekly board + upload the full run's replay. Never touches career
        // K/D. The engine owns the authoritative run time + the recorded replay.
        const run = game.getChallengeRun();
        if (run) {
          void submitChallengeRun(run).then((me) => {
            if (me) setChallengeResult(me);
          });
        }
      } else if (reportsOwnStats) {
        const pending = submitMatchStats(result, offlineMatch, game.getMatchModeTag());
        statsPending.current = pending;
        void pending.then((p) => {
          if (p) setEndProgression(p);
        });
      }
      if (config.mode === 'multiplayer') {
        setPodiumScores(hudStore.getState().scores);
        setOnlineResults(true);
      }
    });
    gameRef.current = game;
    // Toggle the net-debug overlay. F3 (often Mission Control on macOS) OR the
    // backtick/tilde key (`) which has no OS conflict. Works locked or not.
    const onDebugKey = (e: KeyboardEvent) => {
      if (e.code === 'F3' || e.code === 'Backquote') {
        e.preventDefault();
        gameRef.current?.toggleNetDebug();
      }
    };
    window.addEventListener('keydown', onDebugKey);
    game.setInspectListener((active, kills) => setInspect(active ? { kills } : null));
    game.setNetEventListener((ev: NetMatchEvent) => {
      if (ev.type === 'join-failed') {
        setJoinDuplicate(ev.reason === 'duplicate');
        setJoinError(
          ev.reason === 'full'
            ? 'That lobby is full.'
            : ev.reason === 'afk'
              ? 'You were removed from the match for inactivity.'
              : ev.reason === 'duplicate'
                ? "You're already in this match in another tab."
                : 'That lobby no longer exists.',
        );
      } else if (ev.type === 'ranked-result') {
        setRankedResult(ev.result);
      } else if (ev.type === 'progression') {
        // A partial (mid-match leave) push never opens the results screen.
        if (!ev.progression.partial) setEndProgression(ev.progression);
      }
    });
    applySettingsToGame(game, settings);
    applyMatchConfig(game, config);
    // Loading-screen signals, all real: the arena mesh + audio graph are built
    // synchronously above; "lighting" = the first frame (and its shader
    // compile) has rendered — two rAFs after start() queues the loop; "models"
    // = start() resolved (it awaits the combatant model).
    setBoot((b) => ({ ...b, geometry: true, sounds: true }));
    let alive = true;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (alive) setBoot((b) => ({ ...b, lighting: true }));
      });
    });
    void game.start().then(() => {
      if (alive) setBoot((b) => ({ ...b, models: true }));
    });
    // Bulletproof activation: ?netdebug in the URL turns the overlay on with no
    // keypress (so a macOS F3/Mission-Control conflict can't block it).
    if (new URLSearchParams(window.location.search).has('netdebug')) game.toggleNetDebug();
    return () => {
      alive = false;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('keydown', onDebugKey);
      gameRef.current?.dispose();
      gameRef.current = null;
    };
  }, []);

  const voteForMap = useCallback((mapId: string) => {
    gameRef.current?.voteForMap(mapId);
  }, []);

  // Apply live preference changes to the running game.
  useEffect(() => {
    const game = gameRef.current;
    if (game) applySettingsToGame(game, settings);
  }, [settings]);

  // Build the playercard from the live profile + card settings, hand it to the
  // engine (which broadcasts it for the victim's killcam), and keep a copy for
  // the local kill-confirm flex.
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active || !d.profile) return;
        const card = buildCardPayload(d.profile, settings);
        gameRef.current?.setCardPayload?.(card);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [settings.card, settings.cardStats, settings.playerName]);

  const requestPlay = useCallback(() => {
    const game = gameRef.current;
    const container = containerRef.current;
    if (!game) return;
    game.requestLock();
    if (
      typeof document !== 'undefined' &&
      !document.fullscreenElement &&
      container?.requestFullscreen
    ) {
      container.requestFullscreen().catch(() => {});
    }
  }, []);

  const exitFullscreen = () => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  };

  // Mid-match leave: submit the partial run (only if it actually recorded
  // something, so an enter→leave / empty-lobby bounce doesn't inflate totalGames
  // with an all-zero run — #4), then to lobby.
  const leave = useCallback(() => {
    exitFullscreen();
    const game = gameRef.current;
    const r = game?.getStats() ?? null;
    // A weekly-challenge run only counts when it FINISHES (match-end); leaving
    // mid-run abandons it. Other matches submit the partial run to career stats.
    if (!isChallenge && reportsOwnStats && r && game?.hasRecordableStats()) {
      statsPending.current = submitMatchStats(r, offlineMatch, game.getMatchModeTag());
    }
    // Leaving from the post-match vote still carries this match's rewards (or
    // the in-flight offline reply, which lands after the lobby is up).
    onExit(r, endProgression, statsPending.current);
  }, [onExit, offlineMatch, isChallenge, reportsOwnStats, endProgression]);

  // Online + alone in the room: release the cursor so the waiting overlay's
  // buttons (copy invite / leave) are clickable, and so the player isn't stuck
  // running around an empty arena (#6a).
  const waiting =
    config.mode === 'multiplayer' &&
    hud.netStatus === 'open' &&
    hud.netPeers === 0 &&
    !hud.vote &&
    !hud.matchOver &&
    !joinError;
  useEffect(() => {
    if (waiting && typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, [waiting]);

  // Online + the socket dropped mid-match: the net layer auto-retries, but the
  // local sim keeps running against an empty arena. Surface it + release the
  // cursor so the player knows the game stalled and isn't a "ghost match" (#H2).
  const disconnected =
    config.mode === 'multiplayer' &&
    (hud.netStatus === 'closed' || hud.netStatus === 'error') &&
    !hud.matchOver &&
    !onlineResults &&
    !joinError;
  useEffect(() => {
    if (disconnected && typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, [disconnected]);

  // ── Loading screen ────────────────────────────────────────────────────
  // Online handshake, all from HudState: socket open → the join ack
  // (netJoined; names the server's map) → the first server round trip
  // after it (ping measured / a peer in the roster). The join banner is
  // latched so a later banner can't un-complete it, and it names the real map
  // for invite joins whose config map is only a placeholder.
  const online = config.mode === 'multiplayer';
  const netLoad = useStoreSlice(
    hudStore,
    (s) => ({
      status: s.netStatus,
      joinMap: s.netJoined ? mapNameById(s.mapId) : null,
      live: s.netRttMs > 0 || s.netPeers > 0,
      mode: s.mode,
    }),
    shallowEqual,
  );
  const [joinedMap, setJoinedMap] = useState<string | null>(null);
  if (netLoad.joinMap && joinedMap === null) setJoinedMap(netLoad.joinMap);
  const joined = joinedMap !== null;
  const [snapSeen, setSnapSeen] = useState(false);
  if (joined && netLoad.live && !snapSeen) setSnapSeen(true);
  useEffect(() => {
    const t = window.setTimeout(() => setLoadTimedOut(true), 15000); // fail open
    return () => window.clearTimeout(t);
  }, []);
  const loadSteps: LoadStep[] = [
    { id: 'geometry', label: 'Map geometry', done: boot.geometry },
    { id: 'lighting', label: 'Lighting', done: boot.lighting },
    { id: 'models', label: 'Models', done: boot.models },
    { id: 'sounds', label: 'Sounds', done: boot.sounds },
  ];
  if (online) {
    loadSteps.push(
      { id: 'connect', label: 'Connecting', done: netLoad.status === 'open' || joined },
      { id: 'gamestate', label: 'Awaiting gamestate', done: joined },
      { id: 'snapshot', label: 'Awaiting snapshot', done: snapSeen },
    );
  }
  const loadAbort = !!joinError || disconnected || loadTimedOut;
  const loadDone = loadSteps.every((st) => st.done) || loadAbort;
  const loadMapId =
    config.mode === 'multiplayer' && config.pendingMap
      ? joinedMap
        ? mapIdByName(joinedMap)
        : null
      : config.mapId;
  const flavor: MatchFlavor = online
    ? { mode: netLoad.mode, ranked: joined && gameRef.current?.getMatchModeTag() === 'ranked' }
    : {
        mode: config.mode === 'local' ? (config.gameMode ?? 'ffa') : 'ffa',
        training: config.mode === 'local' && config.training,
        challenge: isChallenge,
      };
  const loadShot = useLevelshot(loadGone ? null : loadMapId, settings.lowSpec);

  // Map switch after an online vote: a short levelshot interstitial keyed on
  // HudState.mapSwitchId (the swap itself is synchronous).
  const nextMap = useStoreSlice(
    hudStore,
    (s) => (s.mapSwitchId > 0 ? { id: s.mapSwitchId, name: mapNameById(s.mapId) } : null),
    shallowEqual,
  );
  const [interDoneId, setInterDoneId] = useState(0);
  // A new online match (the vote resolved → map switch): the previous match's
  // rewards no longer belong to what a later leave carries to the lobby.
  const switchId = nextMap?.id ?? 0;
  useEffect(() => {
    if (switchId > 0) setEndProgression(null);
  }, [switchId]);
  // The map on the Tab scoreboard: the latest join / next-map announcement
  // online, else the configured map.
  const [latestNext, setLatestNext] = useState<string | null>(null);
  if (nextMap && nextMap.name !== latestNext) setLatestNext(nextMap.name);
  const currentMapName = latestNext ?? joinedMap ?? (loadMapId ? mapNameById(loadMapId) : '');
  const infoLine = modeLine(flavor);
  const infoLimit = fragLimitFor(flavor);
  const hudInfo = useMemo<HudMatchInfo>(
    () => ({ mapName: currentMapName, modeLine: infoLine, fragLimit: infoLimit }),
    [currentMapName, infoLine, infoLimit],
  );
  const showInter = online && loadGone && nextMap !== null && nextMap.id !== interDoneId;
  const interShot = useLevelshot(showInter && nextMap ? mapIdByName(nextMap.name) : null, settings.lowSpec);
  // Warm the levelshots of the ballot while the vote runs, so the interstitial
  // opens on a finished image.
  const voteKey = hud.vote ? hud.vote.options.join(',') : '';
  // Each uncached shot is a ~250ms main-thread render (+ a lightmap bake), so
  // skip the warm-up on low-spec and spread the rest out between idle frames.
  useEffect(() => {
    if (!voteKey || settings.lowSpec) return;
    let alive = true;
    const idle = () =>
      new Promise<void>((r) => {
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
          .requestIdleCallback;
        if (ric) ric(() => r(), { timeout: 1500 });
        else window.setTimeout(r, 300);
      });
    void import('./menu/menu-backdrop').then(async (m) => {
      for (const id of voteKey.split(',')) {
        await idle();
        if (!alive) return;
        await m.renderLevelshot(id, { lowSpec: settings.lowSpec });
      }
    });
    return () => {
      alive = false;
    };
  }, [voteKey, settings.lowSpec]);

  // Match's over (results / online results screen): always free the cursor so
  // the buttons are clickable without the player having to hit Esc first.
  useEffect(() => {
    if (
      (hud.matchOver || onlineResults) &&
      typeof document !== 'undefined' &&
      document.pointerLockElement
    ) {
      document.exitPointerLock();
    }
  }, [hud.matchOver, onlineResults]);

  return (
    <div ref={containerRef} className='fixed inset-0 z-50 bg-black text-white'>
      <canvas ref={canvasRef} onClick={requestPlay} className='block h-full w-full' />
      {/* The HUD is hidden while the Play-of-the-Match clip plays cinematically. */}
      {!hud.pom && <HudOverlay store={hudStore} settings={settings} info={hudInfo} xpTicker={!isChallenge && loggedIn} />}
      {!hud.pom && inspect && <InspectCard settings={settings} kills={inspect.kills} />}
      {/* In-game chat (online matches): message log + composer. Survives the
          PotG/results screens being shown, but is hidden by the Hide-chat setting. */}
      {!settings.hideChat && config.mode === 'multiplayer' && (
        <InGameChat
          chat={hud.chat}
          onSend={(t) => gameRef.current?.sendChat(t)}
          onCancel={() => gameRef.current?.closeChat()}
        />
      )}
      {hud.pom && (
        <PlayOfTheMatchOverlay pom={hud.pom} settings={settings} />
      )}
      {hud.vote && !onlineResults && !hud.pom && (
        <MapVoteOverlay vote={hud.vote} onVote={voteForMap} />
      )}
      {onlineResults && !hud.pom && (
        <OnlineMatchResults
          won={endResult?.won ?? false}
          scores={podiumScores}
          settings={settings}
          result={endResult}
          progression={endProgression}
          mode={resultsMode}
          voteEndsAt={hud.vote?.endsAtClient}
          onLogin={() => {
            exitFullscreen();
            onLogin(endResult);
          }}
          onContinue={() => setOnlineResults(false)}
        />
      )}
      {joinError && (
        <JoinErrorOverlay
          message={joinError}
          onLeave={() => onExit(null)}
          // Re-attempt the same room (the invite room gets a 5-min grace, so a
          // friend joining a bit late can retry without a fresh link — #17).
          onRetry={
            config.mode === 'multiplayer' && !joinDuplicate
              ? () => {
                  setJoinError(null);
                  onPlayAgain();
                }
              : undefined
          }
        />
      )}
      {waiting && (
        <WaitingForOpponents
          roomId={config.mode === 'multiplayer' ? config.roomId : ''}
          onLeave={leave}
        />
      )}
      {disconnected && !waiting && (
        <DisconnectedOverlay error={hud.netStatus === 'error'} onLeave={leave} />
      )}
      {!hud.locked && !hud.matchOver && !hud.vote && !onlineResults && !joinError && !waiting && !hud.pom && !rankedResult && (
        <ClickToPlay
          onPlay={requestPlay}
          onOpenSettings={() => setSettingsOpen(true)}
          onLeave={leave}
          // Latest raw push: the slice above re-renders us whenever a field the
          // paused card shows changes (only while unlocked, i.e. while it's shown).
          hud={hudStore.getState()}
          settings={settings}
          info={hudInfo}
        />
      )}
      {rankedResult && (
        <RankedResultOverlay
          result={rankedResult}
          progression={endProgression}
          onLobby={() => {
            exitFullscreen();
            onExit(endResult, endProgression, statsPending.current);
          }}
        />
      )}
      {/* Weekly challenge: live count-up run timer at top-center (hidden once the
          match ends — the result banner below takes over). */}
      {isChallenge && !hud.matchOver && !hud.pom && <ChallengeTimer gameRef={gameRef} />}
      {isChallenge && challengeResult && hud.matchOver && (
        <div className='pointer-events-none absolute left-1/2 top-6 z-[55] -translate-x-1/2 rounded-lg border border-amber-400/40 bg-zinc-950/90 px-5 py-2.5 text-center font-mono shadow-lg'>
          <div className='text-[10px] uppercase tracking-[0.2em] text-amber-300'>Weekly Challenge</div>
          <div className='mt-1 text-sm text-white'>
            {challengeResult.won
              ? `Cleared in ${fmtChallengeTime(challengeResult.timeMs)}`
              : `${challengeResult.kills} kills`}
            <span className='text-white/50'> · best #{challengeResult.rank}</span>
          </div>
        </div>
      )}
      {!rankedResult && hud.matchOver && !hud.pom && (
        <MatchOverOverlay
          won={hud.matchOver.won}
          scores={hud.scores}
          settings={settings}
          result={endResult}
          progression={endProgression}
          onPlayAgain={() => {
            exitFullscreen();
            onPlayAgain();
          }}
          onLobby={() => {
            exitFullscreen();
            onExit(endResult, endProgression, statsPending.current);
          }}
          onLogin={() => {
            exitFullscreen();
            onLogin(endResult);
          }}
          // Training never reports stats; the weekly challenge goes to its own board.
          expectRewards={!isChallenge && reportsOwnStats}
          mode={resultsMode}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={onChangeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {!loadGone && (
        <LoadingScreen
          levelshot={loadShot}
          kicker={online && !joined ? 'Online match' : modeLine(flavor)}
          title={loadMapId ? mapNameById(loadMapId) : 'Joining'}
          sub={config.mode === 'multiplayer' ? `Room ${config.roomId}` : undefined}
          steps={loadSteps}
          complete={loadDone}
          // Offline boots in a blink — hold long enough to read; online the
          // handshake itself usually takes longer, so the floor is lower.
          minMs={loadAbort ? 0 : online ? 500 : 900}
          shotWaitMs={online ? 0 : 600}
          reduced={settings.reducedEffects}
          onGone={() => {
            setLoadGone(true);
            gameRef.current?.restartLocalWarmup(); // offline 3-2-1 starts in view
          }}
        />
      )}
      {showInter && nextMap && (
        <LoadingScreen
          key={nextMap.id}
          levelshot={interShot}
          kicker={modeLine(flavor)}
          title={nextMap.name}
          sub='Next map'
          steps={[
            { id: 'geometry', label: 'Map geometry', done: true },
            { id: 'gamestate', label: 'Gamestate', done: true },
          ]}
          complete
          minMs={1500}
          tips={false}
          reduced={settings.reducedEffects}
          onGone={() => setInterDoneId(nextMap.id)}
        />
      )}
    </div>
  );
}

// Read-only spectator. Mounts the same Game engine in spectator mode (no local
// player, no fire, no pointer lock) and rides a chosen player's first-person POV
// — so you see THEIR viewmodel, beam color, and crosshair. Cycle players with
// the arrows / A·D / number keys, or by clicking the view.
function SpectatorView({
  config,
  settings,
  onChangeSettings,
  onExit,
}: {
  config: Extract<MatchConfig, { mode: 'spectator' }>;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onExit: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showScores, setShowScores] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Loading screen (same real signals as GameView; the join ack here is the
  // engine's "Spectating <map>" banner).
  const [boot, setBoot] = useState({ geometry: false, lighting: false, models: false });
  const [loadGone, setLoadGone] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const listener: HudListener = (state) => setHud(state);
    // matchEnd never fires in spectator mode (no local frag limit / stats).
    const game = new Game(canvas, listener, () => {});
    gameRef.current = game;
    game.setNetEventListener((ev: NetMatchEvent) => {
      if (ev.type === 'spectate-ended') onExit();
      else if (ev.type === 'join-failed') {
        setError(ev.reason === 'full' ? 'That match is no longer available.' : 'That match no longer exists.');
      }
    });
    applySettingsToGame(game, settings);
    applyMatchConfig(game, config);
    setBoot((b) => ({ ...b, geometry: true }));
    let alive = true;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (alive) setBoot((b) => ({ ...b, lighting: true }));
      });
    });
    void game.start().then(() => {
      if (alive) setBoot((b) => ({ ...b, models: true }));
    });
    const timeout = window.setTimeout(() => setLoadTimedOut(true), 15000); // fail open
    return () => {
      alive = false;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timeout);
      gameRef.current?.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; settings re-applied below
  }, []);

  const [specMap, setSpecMap] = useState<string | null>(null);
  const specBanner = hud.netJoined ? mapNameById(hud.mapId) : null;
  if (specBanner && specMap === null) setSpecMap(specBanner);
  const [specLive, setSpecLive] = useState(false);
  if (specMap !== null && !specLive && (hud.netPeers > 0 || hud.netRttMs > 0)) setSpecLive(true);
  const specSteps: LoadStep[] = [
    { id: 'geometry', label: 'Map geometry', done: boot.geometry },
    { id: 'lighting', label: 'Lighting', done: boot.lighting },
    { id: 'models', label: 'Models', done: boot.models },
    { id: 'sounds', label: 'Sounds', done: boot.geometry },
    { id: 'connect', label: 'Connecting', done: hud.netStatus === 'open' || specMap !== null },
    { id: 'gamestate', label: 'Awaiting gamestate', done: specMap !== null },
    { id: 'snapshot', label: 'Awaiting snapshot', done: specLive },
  ];
  // 'error' is immediately followed by 'closed' (net.ts), and the HUD samples
  // status at 20 Hz — so 'closed' is the state that sticks when unreachable.
  const specAbort = !!error || loadTimedOut || hud.netStatus === 'error' || hud.netStatus === 'closed';
  const specMapId = specMap ? mapIdByName(specMap) : config.mapId;
  const specShot = useLevelshot(loadGone ? null : specMapId, settings.lowSpec);

  // Live preference changes (sensitivity is irrelevant here, but FOV / volume /
  // quality still apply to the spectated view).
  useEffect(() => {
    const game = gameRef.current;
    if (game) applySettingsToGame(game, settings);
  }, [settings]);

  // Spectator controls. The chat composer stops propagation while focused, so
  // these never fire mid-message.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chatOpen) return;
      const game = gameRef.current;
      if (!game) return;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === ']') {
        game.spectateNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A' || e.key === '[') {
        game.spectatePrev();
      } else if (e.key >= '1' && e.key <= '9') {
        game.spectateByIndex(Number(e.key) - 1);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setShowScores((v) => !v);
      } else if (e.key === 'Enter') {
        // Don't open a composer that isn't rendered (hideChat) — that would set
        // chatOpen with no input to focus/escape and soft-lock these controls.
        if (!settings.hideChat) {
          e.preventDefault();
          setChatOpen(true);
        }
      } else if (e.key === 'Escape') {
        setShowScores(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen, settings.hideChat]);

  const spec = hud.spectator;
  const crosshairCfg = (spec && decodeCrosshair(spec.crosshairCode)) || settings.crosshair;
  const leave = () => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    onExit();
  };

  return (
    <div ref={containerRef} className='fixed inset-0 z-50 bg-black text-white'>
      <canvas
        ref={canvasRef}
        onClick={() => gameRef.current?.spectateNext()}
        className='block h-full w-full cursor-pointer'
      />
      {/* The watched player's crosshair (their reticle, centered). */}
      {spec?.watchingId && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <CrosshairGraphic cfg={crosshairCfg} />
        </div>
      )}
      <Killfeed entries={hud.killfeed} />
      <BannerOverlay banner={hud.banner} />
      {hud.netStatus !== 'off' && (
        <NetStatusPill status={hud.netStatus} peers={hud.netPeers} rttMs={hud.netRttMs} />
      )}

      {/* Top banner: who you're watching + how to switch. */}
      <div className='pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-4'>
        <div className='clip-deck flex items-center gap-3 border border-cyan-300/25 bg-black/60 px-4 py-2 backdrop-blur-sm'>
          <span className='font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/80'>👁 Spectating</span>
          {spec && spec.watchingId ? (
            <>
              <span className='font-display text-sm font-bold text-white'>{spec.watchingName}</span>
              <span className='font-mono text-[11px] tabular-nums text-white/45'>
                {spec.index}/{spec.count}
              </span>
            </>
          ) : (
            <span className='font-display text-sm text-white/60'>Waiting for players…</span>
          )}
        </div>
      </div>

      {/* Player switcher + leave. */}
      <div className='absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-center gap-2 p-4'>
        <button
          onClick={() => gameRef.current?.spectatePrev()}
          disabled={!spec || spec.count === 0}
          className='clip-deck-sm bg-white/10 px-3 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20 disabled:opacity-30'
        >
          ◄ Prev
        </button>
        <div className='flex max-w-[60vw] flex-wrap items-center justify-center gap-1.5'>
          {spec?.players.map((p) => (
            <button
              key={p.id}
              onClick={() => gameRef.current?.spectateByIndex(spec.players.findIndex((q) => q.id === p.id))}
              className={`clip-deck-sm px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] transition ${
                p.id === spec.watchingId
                  ? 'bg-cyan-400 text-zinc-950'
                  : 'bg-white/8 text-white/70 hover:bg-white/16'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <button
          onClick={() => gameRef.current?.spectateNext()}
          disabled={!spec || spec.count === 0}
          className='clip-deck-sm bg-white/10 px-3 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20 disabled:opacity-30'
        >
          Next ►
        </button>
        <div className='mx-2 h-6 w-px bg-white/15' />
        <button
          onClick={() => setShowScores((v) => !v)}
          className='clip-deck-sm bg-white/10 px-3 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20'
        >
          Scores
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className='clip-deck-sm bg-white/10 px-3 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20'
        >
          Settings
        </button>
        <button
          onClick={leave}
          className='clip-deck-sm bg-rose-500/90 px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-rose-400'
        >
          Leave
        </button>
      </div>

      {/* Read + send match chat (server tags our lines as spectator). */}
      {!settings.hideChat && (
        <InGameChat
          chat={{ open: chatOpen, lines: hud.chat.lines }}
          onSend={(t) => {
            gameRef.current?.sendChat(t);
            setChatOpen(false);
          }}
          onCancel={() => setChatOpen(false)}
        />
      )}

      {showScores && (
        <QuakeScoreboard
          scores={hud.scores}
          online
          mode={hud.mode}
          showPing={settings.showPing && hud.netStatus !== 'off'}
        />
      )}

      {error && (
        <JoinErrorOverlay message={error} onLeave={onExit} />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={onChangeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {!loadGone && (
        <LoadingScreen
          levelshot={specShot}
          kicker={specMap ? `Spectating · ${modeTitle({ mode: hud.mode })}` : 'Spectating'}
          title={specMapId ? mapNameById(specMapId) : 'Joining'}
          sub={`Room ${config.roomId}`}
          steps={specSteps}
          complete={specSteps.every((st) => st.done) || specAbort}
          minMs={specAbort ? 0 : 500}
          shotWaitMs={0}
          reduced={settings.reducedEffects}
          onGone={() => setLoadGone(true)}
        />
      )}
    </div>
  );
}

function mapLabel(id: string): string {
  return MAPS.find((m) => m.id === id)?.label ?? id;
}

/* ───────────────────────── Map vote (end of match) ───────────────────────── */

// Play of the Match: a mostly-transparent cinematic frame over the live 3D
// replay (the engine owns the camera + actors). Letterbox bars, a "PLAY OF THE
// MATCH" title that fades, a lower-third nameplate, a Skip button, and an
// auto-advance progress bar driven by the clip clock.
// A hit-marker X that flashes over the crosshair each time the spectated star
// scores a kill during the replay. Keyed by `hitId` so the animation restarts
// on every kill; colour reflects body vs. headshot.
function ReplayKillMarker({ hitId, headshot }: { hitId: number; headshot: boolean }) {
  if (hitId <= 0) return null;
  const stroke = headshot ? '#facc15' : '#fb7185';
  return (
    <div
      key={hitId}
      className='absolute inset-0 flex items-center justify-center'
      style={{ animation: 'pomHit 460ms ease-out forwards' }}
    >
      <svg width='48' height='48' viewBox='0 0 42 42' aria-hidden>
        {[
          [8, 8, 15, 15],
          [34, 8, 27, 15],
          [8, 34, 15, 27],
          [34, 34, 27, 27],
        ].map((l, i) => (
          <line
            key={i}
            x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]}
            stroke={stroke} strokeWidth='2.5' strokeLinecap='round'
            style={{ filter: `drop-shadow(0 0 4px ${stroke}cc)` }}
          />
        ))}
      </svg>
    </div>
  );
}

function PlayOfTheMatchOverlay({
  pom,
  settings,
}: {
  pom: PomState;
  settings: Settings;
}) {
  const reduced = settings.reducedEffects;
  const isPotg = pom.phase === 'potg';
  const isVerdict = pom.phase === 'verdict';
  // Fade the PotG title in on its beat (re-armed when the phase flips to potg).
  const [titleVisible, setTitleVisible] = useState(true);
  useEffect(() => {
    setTitleVisible(true);
    const t = setTimeout(() => setTitleVisible(false), 1900);
    return () => clearTimeout(t);
  }, [pom.phase]);
  // The Play-of-the-Match cinematic is intentionally NOT skippable — it always
  // plays to completion, and the map vote opens after it (see POTG_GUARD_SEC).

  const pct = pom.total > 0 ? Math.max(0, Math.min(100, (1 - pom.remaining / pom.total) * 100)) : 0;
  const barH = reduced ? '8vh' : '11vh';

  return (
    <div className='pointer-events-none absolute inset-0 z-40 font-mono'>
      <style>{'@keyframes pomHit{0%{opacity:0;transform:scale(1.5)}25%{opacity:1}100%{opacity:0;transform:scale(1)}}@keyframes pomVerdict{0%{opacity:0;transform:scale(0.82)}55%{opacity:1;transform:scale(1.04)}100%{opacity:1;transform:scale(1)}}'}</style>

      {/* Cinematic letterbox bars */}
      <div className='absolute inset-x-0 top-0 bg-black' style={{ height: barH }} />
      <div className='absolute inset-x-0 bottom-0 bg-black' style={{ height: barH }} />

      {/* First-person framing: the crosshair + a kill flash so it's clear we're
          watching someone frag. Hidden on the VICTORY/DEFEAT card. */}
      {!isVerdict && (
        <>
          <Crosshair cfg={settings.crosshair} />
          <ReplayKillMarker hitId={pom.hitId} headshot={pom.hitHeadshot} />
        </>
      )}

      {/* VICTORY / DEFEAT card — the slow-mo freeze beat between the final blow
          and the Play of the Match. */}
      {isVerdict && (
        <div className='absolute inset-0 flex flex-col items-center justify-center'>
          <div
            className={`text-7xl font-black uppercase tracking-[0.12em] drop-shadow-[0_4px_16px_rgba(0,0,0,0.95)] ${
              pom.won ? 'text-emerald-300' : 'text-rose-400'
            }`}
            style={{ animation: 'pomVerdict 520ms cubic-bezier(0.2,0.8,0.2,1) forwards' }}
          >
            {pom.won ? 'Victory' : 'Defeat'}
          </div>
        </div>
      )}

      {/* Play of the Match: title + lower-third. */}
      {isPotg && (
        <>
          <div
            className='absolute inset-x-0 top-[16%] flex flex-col items-center transition-opacity duration-700'
            style={{ opacity: titleVisible ? 1 : 0 }}
          >
            <div className='text-[15px] font-semibold uppercase tracking-[0.5em] text-cyan-300/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]'>
              Play of the Match
            </div>
          </div>

          {/* Lower third on the star's equipped playercard background. */}
          <div
            className='absolute left-[4vw] bottom-[14vh] max-w-[46vw] overflow-hidden rounded-md border border-white/15 px-5 py-3 shadow-[0_6px_24px_rgba(0,0,0,0.6)]'
            style={{ background: pom.kit?.cardBg ?? 'rgba(0,0,0,0.55)' }}
          >
            <div className='absolute inset-0 bg-black/35' />
            <div className='relative'>
              <div
                className='text-3xl font-extrabold uppercase tracking-[0.04em] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]'
                style={{ color: pom.kit?.nameColor ?? '#ffffff' }}
              >
                {pom.star}
              </div>
              {pom.kit?.title ? (
                <div className='text-[12px] font-bold uppercase tracking-[0.4em] text-white/70'>{pom.kit.title}</div>
              ) : null}
              <div
                className='mt-1 text-lg font-bold uppercase tracking-[0.25em] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]'
                style={{ color: pom.kit?.cardAccent ?? '#67e8f9' }}
              >
                {pom.label}
                {pom.subLabel ? <span className='ml-3 text-white/60'>· {pom.subLabel}</span> : null}
              </div>
              {pom.kit ? (
                <div className='mt-1.5 text-[15px] font-semibold uppercase tracking-[0.1em] text-amber-200 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]'>
                  {pom.kit.weapon}
                  {pom.kit.weaponKills != null ? ` · ${pom.kit.weaponKills.toLocaleString('en-US')} kills` : ''}
                  {pom.kit.finisher ? <span className='text-white/60'>{` · ${pom.kit.finisher}`}</span> : null}
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}

      {/* Auto-advance progress bar pinned to the bottom letterbox edge. */}
      <div className='absolute inset-x-0' style={{ bottom: barH, height: '2px' }}>
        <div
          className={`h-full ${isPotg ? 'bg-cyan-400/80' : 'bg-amber-400/80'}`}
          style={{ width: `${pct}%`, transition: 'width 80ms linear' }}
        />
      </div>
    </div>
  );
}

function MapVoteOverlay({
  vote,
  onVote,
}: {
  vote: MapVoteState;
  onVote: (mapId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const remainingSec = Math.max(0, (vote.endsAtClient - now) / 1000);
  const totalVotes = Object.values(vote.counts).reduce((a, b) => a + b, 0);

  return (
    <ModalShell label='Vote next map' z='z-30' width='w-[520px]' backdrop='heavy' bodyClassName='gap-4'>
      <div className='text-center'>
        <div className='font-display text-2xl font-bold uppercase tracking-[0.2em] text-cyan-200'>
          Vote next map
        </div>
        <div className='mt-1 text-[10px] uppercase tracking-[0.3em] text-white/45' aria-live='polite'>
          {remainingSec.toFixed(0)}s · {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
        </div>
      </div>
      <div className='flex flex-col gap-2.5'>
        {vote.options.map((id) => {
          const count = vote.counts[id] ?? 0;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          const mine = vote.myVote === id;
          return (
            <button
              key={id}
              type='button'
              aria-pressed={mine}
              onClick={() => onVote(id)}
              {...sfxProps('uiConfirm')}
              className={`clip-deck-sm relative overflow-hidden border px-4 py-3 text-left transition ${
                mine
                  ? 'border-emerald-400 bg-emerald-400/10'
                  : 'border-white/15 bg-white/5 hover:bg-white/10'
              }`}
            >
              <div
                className='absolute inset-y-0 left-0 bg-cyan-400/15 transition-all'
                style={{ width: `${pct}%` }}
              />
              <div className='relative flex items-center justify-between'>
                <span className='font-display text-sm font-semibold uppercase tracking-[0.12em] text-white'>
                  {mapLabel(id)}
                </span>
                <span className='text-xs tabular-nums text-white/70'>
                  {count} · {pct}%
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <div className='text-center text-[10px] uppercase tracking-[0.2em] text-white/35'>
        {vote.myVote ? 'Vote locked — you can change it' : 'Click a map to vote'}
      </div>
    </ModalShell>
  );
}

// Build a shareable ?join= invite URL for a room code (used by the invite modal
// and the waiting-for-opponents overlay).
function inviteLink(roomId: string): string {
  if (typeof window === 'undefined') return `?join=${roomId}`;
  return `${window.location.origin}${window.location.pathname}?join=${roomId}`;
}

// Online + the connection dropped mid-match: tell the player the game stalled
// and is auto-retrying, instead of leaving them in a silent "ghost match".
function DisconnectedOverlay({ error, onLeave }: { error: boolean; onLeave: () => void }) {
  return (
    <ModalShell label='Connection lost' tone='rose' z='z-30' backdrop='heavy' bodyClassName='items-center text-center'>
      <div className='flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] text-rose-200'>
        <span className='deck-pulse inline-block h-1.5 w-1.5 rounded-full bg-rose-300 shadow-[0_0_6px_rgba(251,113,133,0.85)]' />
        {error ? 'Connection error' : 'Connection lost'}
      </div>
      <div className='-mt-2'>
        <div className='font-display text-xl font-bold uppercase tracking-[0.12em] text-white'>Reconnecting…</div>
        <p className='mt-2 font-sans text-sm text-white/55'>
          Lost contact with the server. Trying to get you back into the match — this usually
          takes a few seconds.
        </p>
      </div>
      <DeckButton onClick={onLeave} size='sm' center sound='uiBack'>
        Leave to menu
      </DeckButton>
    </ModalShell>
  );
}

// Online + alone: instead of a silent empty arena, show what's happening and a
// one-click way to fill the lobby (#6a).
function WaitingForOpponents({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const link = inviteLink(roomId);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <ModalShell label='Waiting for opponents' z='z-30' width='w-[460px]' backdrop='heavy' bodyClassName='text-center'>
      <div className='flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] text-cyan-200'>
        <span className='deck-pulse inline-block h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.85)]' />
        Waiting for opponents
      </div>
      <div className='-mt-2'>
        <div className='font-display text-xl font-bold uppercase tracking-[0.12em] text-white'>You&apos;re the only one here</div>
        <p className='mt-2 font-sans text-sm text-white/55'>
          The match starts the moment another player joins. Share the link to fill the lobby.
        </p>
      </div>
      <div>
        <div className='flex items-center gap-2'>
          <input
            readOnly
            value={link}
            aria-label='Invite link'
            onFocus={(e) => e.currentTarget.select()}
            className='deck-input deck-input-sm min-w-0 flex-1'
          />
          <UtilButton onClick={copy} tone='cyan' sound='uiConfirm' className='shrink-0'>
            {copied ? 'Copied!' : 'Copy'}
          </UtilButton>
        </div>
        {roomId && (
          <div className='mt-2 text-[10px] uppercase tracking-[0.16em] text-white/40'>
            Lobby code: <span className='text-white/80'>{roomId}</span>
          </div>
        )}
      </div>
      <DeckButton onClick={onLeave} full center sound='uiBack'>
        Leave to Lobby
      </DeckButton>
    </ModalShell>
  );
}

function JoinErrorOverlay({
  message,
  onLeave,
  onRetry,
}: {
  message: string;
  onLeave: () => void;
  onRetry?: () => void;
}) {
  return (
    <ModalShell label="Couldn't join" tone='rose' z='z-40' size='sm' backdrop='heavy' bodyClassName='text-center'>
      <div>
        <div className='font-display text-lg font-bold uppercase tracking-[0.16em] text-rose-300'>
          Couldn&apos;t join
        </div>
        <p className='mt-3 font-sans text-sm text-white/65'>{message}</p>
      </div>
      <div className='flex gap-3'>
        {onRetry && (
          <DeckButton onClick={onRetry} solid accent='emerald' center className='flex-1'>
            Try Again
          </DeckButton>
        )}
        <DeckButton onClick={onLeave} solid={!onRetry} accent={onRetry ? 'plain' : 'emerald'} center className='flex-1' sound='uiBack'>
          Back to Lobby
        </DeckButton>
      </div>
    </ModalShell>
  );
}

/* ───────────────────────── HUD layout ───────────────────────── */

// The equipped finish's card while you inspect the gun: full name (quality
// prefix + name), Strange kills + rank, wear, pattern seed, mint number, in the
// tier colour. Data is the equipped instance the hub put in Settings.finishItem;
// a plain stock/bought finish shows just its name.
function InspectCard({ settings, kills }: { settings: Settings; kills: number | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const item = settings.finishItem ?? null;
  const def = itemDef(item?.def ?? settings.looks?.finish?.d ?? settings.railgunFinish);
  const tier = item?.tier ?? def?.tier ?? 'common';
  const color = TIER_META[tier].color;
  const attrs = item?.attrs ?? {};
  const base = attrs.customName ?? def?.name ?? 'Railgun';
  const prefix = item ? qualityPrefix(item.quality, { ...attrs, kills: kills ?? attrs.kills }) : '';
  const title = prefix ? `${prefix} ${base}` : base;
  const bits: string[] = [];
  if (kills !== null) bits.push(`${kills.toLocaleString()} kills`);
  if (typeof attrs.wear === 'number') bits.push(wearName(attrs.wear));
  if (typeof attrs.seed === 'number') bits.push(`Pattern ${attrs.seed}`);
  if (item) bits.push(`#${item.mint}`);
  return (
    <div
      aria-hidden='true'
      className='pointer-events-none absolute bottom-44 right-8 max-w-[22rem] text-right font-mono'
      style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(6px)', transition: 'opacity 180ms ease, transform 180ms ease' }}
    >
      <div className='text-[10px] uppercase tracking-[0.25em] text-white/40'>{TIER_META[tier].label}</div>
      <div className='text-lg font-semibold leading-tight' style={{ color, textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>
        {title}
      </div>
      {bits.length > 0 && <div className='mt-0.5 text-[11px] text-white/60'>{bits.join(' · ')}</div>}
    </div>
  );
}

function HudOverlay({
  store,
  settings,
  info,
  xpTicker,
}: {
  store: HudStore;
  settings: Settings;
  info: HudMatchInfo;
  xpTicker: boolean;
}) {
  const s = settings.uiScale || 1;
  // UI scale: a counter-sized wrapper rendered at 1/s then transform-scaled by s,
  // so corner-anchored HUD elements keep their anchors while everything resizes.
  // .hud-reduced mirrors the reducedEffects setting into CSS (src/hud.css) so
  // entrances become instant and pops/slides/shockwaves are neutralised.
  return (
    <HudStoreContext.Provider value={store}>
      <div
        className={`hud-root pointer-events-none absolute inset-0 select-none${
          settings.reducedEffects ? ' hud-reduced' : ''
        }`}
      >
        <div
          className='absolute left-0 top-0 origin-top-left'
          style={{ width: `${100 / s}%`, height: `${100 / s}%`, transform: `scale(${s})` }}
        >
          <HudLayout settings={settings} info={info} xpTicker={xpTicker} />
        </div>
      </div>
    </HudStoreContext.Provider>
  );
}

// Static layout. Each piece below subscribes to its own slice of the store, so
// a HudState push only re-renders the pieces whose slice actually changed (a
// push with only `speed` changed re-renders the speed readout alone).
const HudLayout = memo(function HudLayout({
  settings,
  info,
  xpTicker,
}: {
  settings: Settings;
  info: HudMatchInfo;
  xpTicker: boolean;
}) {
  const dead = useHudSlice((s) => s.killcam !== null);
  return (
    <>
      {!dead && <HudBoostRing />}
      <HudKillFlash />
      <HudDamageVignette />
      {!dead && <Crosshair cfg={settings.crosshair} />}
      {!dead && <HudReloadBar />}
      {!dead && <HudHitMarker />}
      <HudKillfeed />
      <HudToasts />
      <HudMiniLeaderboard />
      <HudScoreBoxes fragLimit={info.fragLimit} />
      <HudNetDebug />
      <HudTraining />
      <HudBanner />
      <HudCaptions captions={settings.captions} />
      <HudFragPopup />
      <HudXpTicker enabled={xpTicker} />
      {/* Your own card is NOT shown on your kills — it's broadcast so the VICTIM
          sees it on their killcam. The killer's card shows on YOUR killcam below. */}
      <HudKillcam reduced={settings.reducedEffects} />
      {!dead && <HudSpeedAndStreak />}
      {!dead && <HudCooldowns />}
      {settings.showFps && <HudFps />}
      <HudNetStatus />
      <HudInvuln />
      <HudWarmup />
      <HudScoreboard showPing={settings.showPing} info={info} />
    </>
  );
});

/* Store-connected wrappers: each selects one slice (primitives or structurally
   shared references from the store) and hands it to a memoized presentational
   component below. Presentational components keep plain props so the
   spectator view can reuse them without the store. */

function HudBoostRing() {
  return <BoostRing active={useHudSlice((s) => s.boostReady)} />;
}

function HudKillFlash() {
  return <KillFlashLayer flash={useHudSlice((s) => s.killFlash)} />;
}

function HudDamageVignette() {
  return <DamageVignette id={useHudSlice((s) => (s.damageFlash > 0 ? s.damageId : 0))} />;
}

function HudReloadBar() {
  const fireId = useHudSlice((s) => s.railFireId);
  const cooling = useHudSlice((s) => s.railCooldown > 0);
  // How far into the cooldown the bar was when this shot registered (or when
  // the HUD mounted mid-cooldown) — pinned per shot so the fill never restarts.
  const elapsedMs = useHudLatched(fireId, (s) => (RAIL_COOLDOWN - s.railCooldown) * 1000);
  if (!cooling) return null;
  return <ReloadBar fireId={fireId} elapsedMs={elapsedMs} />;
}

function HudHitMarker() {
  return <HitMarkerLayer marker={useHudSlice((s) => s.hitMarker)} />;
}

function HudKillfeed() {
  const entries = useHudSlice((s) => s.killfeed);
  const localName = useHudSlice((s) => s.scores.find((p) => p.isLocal)?.name ?? '');
  return <Killfeed entries={entries} localName={localName} />;
}

function HudToasts() {
  return <ToastStack toasts={useHudSlice((s) => s.toasts)} />;
}

function HudMiniLeaderboard() {
  return <MiniLeaderboard scores={useHudSlice((s) => s.scores)} />;
}

function HudScoreBoxes({ fragLimit }: { fragLimit: number | null }) {
  const b = useHudSlice(
    (s) => ({
      scores: s.scores,
      mode: s.mode,
      teamScores: s.teamScores,
      localTeam: s.localTeam,
      hidden: s.training !== null || s.spectator !== null,
    }),
    shallowEqual,
  );
  if (b.hidden) return null;
  return (
    <ScoreBoxes
      scores={b.scores}
      mode={b.mode}
      teamScores={b.teamScores}
      localTeam={b.localTeam}
      fragLimit={fragLimit}
    />
  );
}

function HudNetDebug() {
  const stats = useHudSlice((s) => s.netDebug);
  return stats ? <NetDebugOverlay s={stats} /> : null;
}

function HudTraining() {
  // Whole seconds for the running clock so the panel re-renders ~1 Hz, not per push.
  const t = useHudSlice(
    (s) => (s.training ? { ...s.training, elapsed: Math.floor(s.training.elapsed) } : null),
    shallowEqual,
  );
  return t ? <TrainingPanel t={t} /> : null;
}

function HudBanner() {
  return <BannerOverlay banner={useHudSlice((s) => s.banner)} />;
}

function HudCaptions({ captions }: { captions: boolean }) {
  return <CaptionLayer text={useHudSlice(captionText)} captions={captions} />;
}

function HudFragPopup() {
  const confirm = useHudSlice((s) => s.killConfirm);
  // Only reads the board while a centre-print is up (a string → re-renders
  // only when the line's text changes).
  const placement = useHudSlice((s) =>
    s.killConfirm ? placementLine(s.scores, s.mode, s.teamScores) : null,
  );
  return <FragPopup confirm={confirm} placement={placement} />;
}

function HudKillcam({ reduced }: { reduced: boolean }) {
  const killcam = useHudSlice((s) => s.killcam);
  const killcamId = useHudSlice((s) => s.killcamId);
  return <KillcamOverlay killcam={killcam} killcamId={killcamId} reduced={reduced} />;
}

function HudFps() {
  return <FpsCounter fps={useHudSlice((s) => s.fps)} />;
}

function HudNetStatus() {
  const n = useHudSlice(
    (s) => ({ status: s.netStatus, peers: s.netPeers, rttMs: s.netRttMs }),
    shallowEqual,
  );
  if (n.status === 'off') return null;
  return <NetStatusPill status={n.status} peers={n.peers} rttMs={n.rttMs} />;
}

function HudInvuln() {
  const secs = useHudSlice((s) =>
    s.netStatus !== 'off' && s.localInvulnMs > 0 ? (s.localInvulnMs / 1000).toFixed(1) : '',
  );
  return secs ? <InvulnPill secs={secs} /> : null;
}

function HudWarmup() {
  const secs = useHudSlice((s) =>
    s.warmupMsLeft > 0 && !s.vote && !s.matchOver && !s.killcam && !s.taunting
      ? Math.max(1, Math.ceil(s.warmupMsLeft / 1000))
      : 0,
  );
  const taunting = useHudSlice((s) => s.taunting);
  // The countdown's last word: "Fight!" the moment the gun goes live.
  const [fight, setFight] = useState(false);
  const [prevSecs, setPrevSecs] = useState(secs);
  if (secs !== prevSecs) {
    setPrevSecs(secs);
    if (prevSecs > 0 && secs === 0) setFight(true);
  }
  if (secs > 0) return <WarmupOverlay secs={secs} />;
  return fight && !taunting ? <FightCall onDone={() => setFight(false)} /> : null;
}

function HudScoreboard({ showPing, info }: { showPing: boolean; info: HudMatchInfo }) {
  const b = useHudSlice(
    (s) => (s.showScoreboard ? { scores: s.scores, netStatus: s.netStatus, mode: s.mode } : null),
    shallowEqual,
  );
  if (!b) return null;
  return (
    <QuakeScoreboard
      scores={b.scores}
      online={b.netStatus !== 'off'}
      mode={b.mode}
      showPing={showPing && b.netStatus !== 'off'}
      info={info}
    />
  );
}

// Match-start "get ready" countdown. The server freezes shots during this
// window (resumeAt), so it's a fair start — nobody can be fragged on the bell.
const WarmupOverlay = memo(function WarmupOverlay({ secs }: { secs: number }) {
  return (
    <div className='pointer-events-none absolute inset-x-0 top-[max(34%,17rem)] z-20 flex flex-col items-center'>
      <div className='hud-cprint-sub'>Match starts in</div>
      {/* Keyed on the second so each count ticks in (CSS .hud-tick). */}
      <div key={secs} className='hud-tick hud-tick-center hud-count'>
        {secs}
      </div>
    </div>
  );
});

const InvulnPill = memo(function InvulnPill({ secs }: { secs: string }) {
  return (
    <>
      {/* Subtle cyan vignette so it's obvious the player is in grace */}
      <div
        className='absolute inset-0 pointer-events-none'
        style={{
          background:
            'radial-gradient(circle at center, transparent 55%, rgba(103,232,249,0.18) 100%)',
        }}
      />
      {/* Under the score boxes (top-centre belongs to them). */}
      <div className='hud-panel absolute left-1/2 top-[5.9rem] flex -translate-x-1/2 items-center gap-2 border-t-2 !border-t-cyan-300 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-100'>
        <span>Spawn shield</span>
        <span className='tabular-nums text-white/90'>{secs}s</span>
      </div>
    </>
  );
});

// The killcam's old React-driven fade covered its last 0.4 s; the CSS fade is
// pre-scheduled to start then (and finishes before the engine clears it).
const KILLCAM_FADE_LEAD_MS = 400;

type KillcamItem = { id: number; remaining: number; total: number; cam: KillcamState };

const KillcamOverlay = memo(function KillcamOverlay({
  killcam,
  killcamId,
  reduced = false,
}: {
  killcam: KillcamState | null;
  killcamId: number;
  reduced?: boolean;
}) {
  // One item per death (KillcamState has no id; the store numbers them). It is
  // kept for the exit fade after the engine clears it on respawn.
  const items = useExitList<KillcamItem>(
    killcam ? [{ id: killcamId, remaining: killcam.remaining, total: killcam.total, cam: killcam }] : [],
    { exitMs: HUD_EXIT_MS, leadMs: KILLCAM_FADE_LEAD_MS },
  );
  return (
    <>
      {items.map(({ item, leaving }) => (
        <KillcamCard key={item.id} item={item} leaving={leaving} reduced={reduced} />
      ))}
    </>
  );
});

const KillcamCard = memo(function KillcamCard({
  item,
  leaving,
  reduced,
}: {
  item: KillcamItem;
  leaving: boolean;
  reduced: boolean;
}) {
  const { cam } = item;
  return (
    <div
      className={`hud-killcam absolute inset-0 z-10${leaving ? ' hud-leaving' : ''}`}
      style={hudTiming(item.remaining, item.total, KILLCAM_FADE_LEAD_MS)}
    >
      <div
        className='absolute inset-0'
        style={{
          background:
            'radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      {/* Lower third, hugging the bottom edge: the killcam frames the killer at
          centre (legs + gibs reach ~65% down), so the print sits below that. */}
      <div className='hud-killcam-card absolute inset-x-0 bottom-[3.5%] flex items-end justify-between gap-6 px-[5vw] font-mono'>
        <div className='hud-killcam-print !px-6 !py-3 text-left'>
          <div className='hud-cprint-sub'>You were fragged by</div>
          <div className='font-display text-4xl font-bold uppercase tracking-[0.03em] text-rose-300 [text-shadow:0_3px_0_rgba(0,0,0,0.7),0_0_14px_rgba(0,0,0,0.9)]'>
            {cam.killerName}
          </div>
          {cam.killerKit && (
            <div className='mt-1.5 text-[16px] font-semibold uppercase tracking-[0.08em] text-amber-200 [text-shadow:0_2px_0_rgba(0,0,0,0.8)]'>
              {cam.killerKit.weapon}
              {cam.killerKit.weaponKills != null ? ` · ${cam.killerKit.weaponKills.toLocaleString('en-US')} kills` : ''}
              {cam.killerKit.finisher ? <span className='text-white/75'>{` · ${cam.killerKit.finisher}`}</span> : null}
            </div>
          )}
          <div className='mt-2 inline-block bg-black/55 px-3 py-1 text-[12px] uppercase tracking-[0.2em] text-white/80'>
            Respawning in{' '}
            <span className='text-white'>
              <KillcamCountdown />s
            </span>
          </div>
        </div>
        {cam.killerCard && (
          <div className='pb-1'>
            <PlayerCard card={cam.killerCard} reduced={reduced} />
          </div>
        )}
      </div>
    </div>
  );
});

// The one live number on the death screen: the respawn countdown (10 Hz text
// updates on this span alone; the card around it never re-renders).
function KillcamCountdown() {
  const secs = useHudSlice((s) =>
    s.raw.killcam ? Math.max(0, s.raw.killcam.remaining).toFixed(1) : '0.0',
  );
  return <>{secs}</>;
}

const NetStatusPill = memo(function NetStatusPill({
  status,
  peers,
  rttMs,
}: {
  status: HudState['netStatus'];
  peers: number;
  rttMs: number;
}) {
  const dot =
    status === 'open' ? 'bg-emerald-400' :
    status === 'connecting' ? 'bg-amber-400' :
    status === 'closed' || status === 'error' ? 'bg-rose-400' :
    'bg-white/40';
  const label =
    status === 'open' ? `LIVE · ${peers} · ${rttMs}ms` :
    status === 'connecting' ? 'connecting…' :
    status === 'closed' ? 'reconnecting' :
    status === 'error' ? 'error' :
    'offline';
  // Bottom-left (above the Speed readout): the top-right column is the killfeed +
  // FPS, and the pill used to paint over the 2nd killfeed row in any live match (#12).
  return (
    <div className='hud-panel absolute bottom-[5.5rem] left-6 flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/85'>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </div>
  );
});

// Net-debug overlay (F3). Top-left live netcode readout so we can see the cause
// of jitter in a real match. The two tells: `extrap` high (frames rendering
// past the buffer = TCP stalls → UDP is the fix) vs `clkDrift` high (render
// clock wandering → a client-side cause UDP won't fix). `buffer` going negative
// means we're underrunning.
const NetDebugOverlay = memo(function NetDebugOverlay({ s }: { s: NonNullable<HudState['netDebug']> }) {
  const warn = (b: boolean) => (b ? 'text-rose-400' : 'text-emerald-300');
  const Row = ({ k, v, cls }: { k: string; v: string; cls?: string }) => (
    <div className="flex justify-between gap-4">
      <span className="text-white/45">{k}</span>
      <span className={`tabular-nums ${cls ?? 'text-white/85'}`}>{v}</span>
    </div>
  );
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-50 rounded-md border border-white/15 bg-black/70 px-3 py-2 font-mono text-[10px] leading-relaxed backdrop-blur-sm">
      <div className="mb-1 font-bold uppercase tracking-[0.2em] text-cyan-300">net · F3</div>
      <Row k="transport" v={s.transport.toUpperCase()} cls={s.transport === 'wt' ? 'text-cyan-300' : 'text-amber-300'} />
      <Row k="ping" v={`${s.rttMs}ms`} cls={warn(s.rttMs > 120)} />
      <Row k="snap rate" v={`${s.snapHz}Hz`} cls={warn(s.snapHz < 45)} />
      <Row k="snap jitter" v={`${s.snapJitterMs}ms`} cls={warn(s.snapJitterMs > 12)} />
      <Row k="extrap" v={`${s.extrapPct}%`} cls={warn(s.extrapPct > 5)} />
      <Row k="buffer" v={`${s.bufferMs}ms`} cls={warn(s.bufferMs < 20)} />
      <Row k="clk drift" v={`${s.clockDriftMs}ms`} cls={warn(s.clockDriftMs > 8)} />
      <Row k="interp" v={`${s.interpDelayMs}ms`} />
      <Row k="peers" v={`${s.peers}`} />
    </div>
  );
});

/* ───────────────────────── Crosshair + hit marker ───────────────────────── */

// Ratz "Boost Range Indicator": a ring around the crosshair that's a faint
// dashed hint when no surface is in range, and a bright glowing cyan ring the
// moment a boostable surface is under your aim (right-click to launch off it).
const BoostRing = memo(function BoostRing({ active }: { active: boolean }) {
  return (
    <div className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'>
      <svg width='52' height='52' viewBox='0 0 52 52' aria-hidden>
        <circle
          cx='26'
          cy='26'
          r='21'
          fill='none'
          stroke={active ? '#67e8f9' : 'rgba(255,255,255,0.16)'}
          strokeWidth={active ? 2 : 1.25}
          strokeDasharray={active ? undefined : '2 6'}
          style={{
            transition: 'stroke 90ms linear, stroke-width 90ms linear',
            filter: active ? 'drop-shadow(0 0 5px rgba(103,232,249,0.9))' : 'none',
          }}
        />
      </svg>
    </div>
  );
});

// Renders a crosshair from a CrosshairConfig as a centered SVG. Reused by the
// in-game HUD and the settings preview so they're always identical.
const CrosshairGraphic = memo(function CrosshairGraphic({ cfg }: { cfg: CrosshairConfig }) {
  const { style, color, size, thickness, gap, dotSize, outline } = cfg;
  const arms = style === 'cross' || style === 'cross-dot';
  const ring = style === 'circle';
  const ringR = gap + size;
  const dotR =
    style === 'dot' || style === 'cross-dot' ? Math.max(dotSize, thickness) : dotSize;
  const showDot = dotR > 0;
  const ext = Math.max(
    arms ? gap + size : 0,
    ring ? ringR + thickness : 0,
    showDot ? dotR : 0,
  );
  const sw = outline ? cfg.outlineThickness : 0;
  const stroke = outline ? cfg.outlineColor : 'none';
  const pad = sw + thickness + 2;
  const half = ext + pad;
  const w = half * 2;
  const c = half;
  return (
    <svg width={w} height={w} viewBox={`0 0 ${w} ${w}`} aria-hidden>
      {arms && (
        <g fill={color} stroke={stroke} strokeWidth={sw}>
          <rect x={c - thickness / 2} y={c - gap - size} width={thickness} height={size} />
          <rect x={c - thickness / 2} y={c + gap} width={thickness} height={size} />
          <rect x={c - gap - size} y={c - thickness / 2} width={size} height={thickness} />
          <rect x={c + gap} y={c - thickness / 2} width={size} height={thickness} />
        </g>
      )}
      {ring && (
        <circle cx={c} cy={c} r={ringR} fill='none' stroke={color} strokeWidth={thickness} />
      )}
      {showDot && <circle cx={c} cy={c} r={dotR} fill={color} stroke={stroke} strokeWidth={sw} />}
    </svg>
  );
});

const Crosshair = memo(function Crosshair({ cfg }: { cfg: CrosshairConfig }) {
  return (
    <div
      className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
      style={{ filter: `drop-shadow(0 0 3px ${cfg.color}66)` }}
    >
      <CrosshairGraphic cfg={cfg} />
    </div>
  );
});

// Reload bar under the crosshair. The fill is a CSS scaleX over the rail
// cooldown keyed on the shot (railFireId); `elapsedMs` (pinned when the shot
// registered) lets a late mount join mid-fill. Same duration as before — the
// engine's cooldown is still what gates the next shot.
const ReloadBar = memo(function ReloadBar({
  fireId,
  elapsedMs,
}: {
  fireId: number;
  elapsedMs: number;
}) {
  // Full-width row 24px below the viewport center, flex-centered. No
  // translate math, no intrinsic-width gotchas — the bar sits dead
  // under the crosshair regardless of viewport size or DPI.
  return (
    <div
      className='absolute inset-x-0 flex justify-center'
      style={{ top: 'calc(50% + 24px)' }}
    >
      <div className='relative h-1 w-16 overflow-hidden rounded-full bg-white/15'>
        <div
          key={fireId}
          className='hud-fill-x absolute left-0 top-0 h-full w-full rounded-full bg-cyan-300/85 shadow-[0_0_6px_rgba(103,232,249,0.6)]'
          style={cssVars({
            '--cd-total': `${RAIL_COOLDOWN}s`,
            '--cd-elapsed': `${Math.max(0, Math.round(elapsedMs))}ms`,
          })}
        />
      </div>
    </div>
  );
});

// Full-screen kill-confirmation flash: an edge vignette that pulses in and out
// so it reads as "frag!" without ever covering the crosshair. Cyan for body
// kills, amber for headshots.
const KillFlashLayer = memo(function KillFlashLayer({ flash }: { flash: KillFlash | null }) {
  if (!flash) return null;
  const edge = flash.headshot ? 'rgba(252,211,77,0.40)' : 'rgba(120,230,255,0.34)';
  // Keyed on the flash id: the pulse is the .hud-killflash keyframes.
  return (
    <div
      key={flash.id}
      className='hud-killflash absolute inset-0'
      style={{
        ...hudTiming(flash.remaining, flash.total),
        background: `radial-gradient(ellipse at center, transparent 52%, ${edge} 100%)`,
      }}
    />
  );
});

// "You were hit" red vignette. Keyed on the damage event so the engine's 0.5 s
// linear decay is a CSS fade; unmounts once damageFlash reaches 0.
const DamageVignette = memo(function DamageVignette({ id }: { id: number }) {
  if (id === 0) return null;
  return (
    <div
      key={id}
      className='hud-damage pointer-events-none absolute inset-0'
      style={{
        background:
          'radial-gradient(circle at center, transparent 40%, rgba(220,38,38,0.25) 100%)',
      }}
    />
  );
});

const HitMarkerLayer = memo(function HitMarkerLayer({ marker }: { marker: HitMarker | null }) {
  if (!marker) return null;
  const isKill = marker.kind !== 'hit';
  const max = isKill ? HIT_MARKER_KILL_DURATION_SEC : HIT_MARKER_DURATION_SEC;
  const stroke =
    marker.kind === 'headshot' ? '#facc15' :
    marker.kind === 'kill' ? '#fb7185' :
    '#ffffff';
  // Use flex centering — exact crosshair alignment regardless of marker
  // size or scale. Keyed on the marker id: the pop-and-settle (and, on
  // kills, the expanding shockwave ring) are the .hud-hm / .hud-hm-ring
  // keyframes, run once per id at display rate.
  return (
    <div
      key={marker.id}
      className='absolute inset-0 flex items-center justify-center'
      style={cssVars({ '--hud-total': `${max}s` })}
    >
      {isKill && (
        <svg
          width='42' height='42' viewBox='0 0 42 42' aria-hidden
          className='hud-hm-ring absolute'
        >
          <circle
            cx='21' cy='21' r='13' fill='none' stroke={stroke} strokeWidth='2'
            style={{ filter: `drop-shadow(0 0 5px ${stroke}aa)` }}
          />
        </svg>
      )}
      <svg
        width='42'
        height='42'
        viewBox='0 0 42 42'
        aria-hidden
        className={`hud-hm ${isKill ? 'hud-hm-kill' : 'hud-hm-hit'}`}
      >
        <g
          stroke={stroke}
          strokeWidth={isKill ? '3' : '2.5'}
          strokeLinecap='round'
          style={{ filter: `drop-shadow(0 0 4px ${stroke}aa)` }}
        >
          <line x1='6' y1='6' x2='12' y2='12' />
          <line x1='36' y1='6' x2='30' y2='12' />
          <line x1='6' y1='36' x2='12' y2='30' />
          <line x1='36' y1='36' x2='30' y2='30' />
        </g>
      </svg>
    </div>
  );
});

/* ───────────────────────── In-game chat (bottom-left) ───────────────────────── */

// How long a chat line stays fully shown after it arrives (composer closed),
// and how long it then fades out. While the composer is open, all lines show.
const CHAT_LINE_FADE_MS = 9000;
const CHAT_LINE_FADE_OUT_MS = 1200;

function InGameChat({
  chat,
  onSend,
  onCancel,
}: {
  chat: { open: boolean; lines: ChatLine[] };
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the composer the moment it opens; reset the draft on open/close.
  useEffect(() => {
    if (!chat.open) return;
    setDraft('');
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [chat.open]);

  // Tick only while closed with visible lines, to drive the idle fade-out.
  useEffect(() => {
    if (chat.open || chat.lines.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [chat.open, chat.lines.length]);

  const visible = chat.lines
    .map((l) => {
      if (chat.open) return { l, opacity: 1 };
      const age = now - l.at;
      if (age >= CHAT_LINE_FADE_MS) return { l, opacity: 0 };
      const opacity =
        age > CHAT_LINE_FADE_MS - CHAT_LINE_FADE_OUT_MS
          ? Math.max(0, (CHAT_LINE_FADE_MS - age) / CHAT_LINE_FADE_OUT_MS)
          : 1;
      return { l, opacity };
    })
    .filter((v) => v.opacity > 0.01);

  if (!chat.open && visible.length === 0) return null;

  const submit = () => {
    const t = draft.trim();
    setDraft('');
    onSend(t); // empty just closes — game.sendChat ignores blank text
  };

  // Anchored above the net-status pill (bottom-28) + speed/streak (bottom-6) so
  // the message log + composer never overlap the live player count/ping.
  return (
    <div className='pointer-events-none absolute bottom-40 left-6 z-30 flex w-[28rem] max-w-[44vw] flex-col gap-1 font-mono'>
      {visible.map(({ l, opacity }) => (
        <div
          key={l.id}
          style={{ opacity }}
          className='w-fit max-w-full rounded bg-black/55 px-2.5 py-1 text-[12px] leading-snug backdrop-blur-sm transition-opacity'
        >
          <span
            className={`mr-1.5 inline-flex items-center gap-0.5 font-semibold ${
              l.guest ? 'text-white/55' : 'text-cyan-300/90'
            }`}
          >
            {l.name}
            <NameBadges admin={l.admin} verified={l.verified} size={11} />
            <span className='text-white/30'>:</span>
          </span>
          <span className='break-words text-white/90'>{l.text}</span>
        </div>
      ))}
      {chat.open && (
        <div className='pointer-events-auto mt-1 flex items-center gap-2 rounded bg-black/70 px-2.5 py-2 backdrop-blur-sm'>
          <span className='shrink-0 text-[11px] uppercase tracking-[0.2em] text-cyan-300/80'>Say</span>
          <input
            ref={inputRef}
            value={draft}
            maxLength={CHAT_CLIENT_MAX_LEN}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Keep keystrokes out of the game's window listeners (belt-and-
              // suspenders; the InputManager is already in chatting mode).
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
            className='min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-white/35'
            placeholder='Message your match — Enter to send, Esc to cancel'
          />
        </div>
      )}
    </div>
  );
}

/* ───────────── Toast stack (top-right, under killfeed) ───────────── */

// Medal toasts fade over the engine's TOAST_FADE_SEC window: the fade itself is
// the shared HUD_EXIT_MS, the rest is slack for push jitter.
const TOAST_FADE_LEAD_MS = TOAST_FADE_SEC * 1000;

const ToastStack = memo(function ToastStack({ toasts }: { toasts: ToastEntry[] }) {
  const chips = useExitList(toasts, { exitMs: HUD_EXIT_MS, leadMs: TOAST_FADE_LEAD_MS });
  return (
    <div className='absolute right-5 top-[13.75rem] flex flex-col items-end gap-1'>
      {chips.map(({ item, leaving }) => (
        <ToastChip key={item.id} toast={item} leaving={leaving} />
      ))}
    </div>
  );
});

const ToastChip = memo(function ToastChip({
  toast,
  leaving,
}: {
  toast: ToastEntry;
  leaving: boolean;
}) {
  const colors = tierColors(toast.tier);
  return (
    <div
      className={`hud-chip hud-panel flex items-center gap-2 border-l-[3px] ${colors.border} px-3 py-1 font-mono text-xs${
        leaving ? ' hud-leaving' : ''
      }`}
      style={hudTiming(toast.remaining, toast.total, TOAST_FADE_LEAD_MS)}
    >
      <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${colors.text}`}>
        {toast.title}
      </span>
      {toast.subtitle && (
        <span className='text-[10px] text-white/55'>{toast.subtitle}</span>
      )}
    </div>
  );
});

/* ───────────────────────── Training range panel ───────────────────────── */

const TrainingPanel = memo(function TrainingPanel({ t }: { t: TrainingHud }) {
  const acc = Math.round(t.accuracy * 100);
  const mins = Math.floor(t.elapsed / 60);
  const secs = Math.floor(t.elapsed % 60);
  const Stat = ({ label, value, accent }: { label: string; value: string; accent?: string }) => (
    <div className='flex flex-col items-center px-3'>
      <span className={`text-xl font-extrabold tabular-nums ${accent ?? 'text-white'}`}>{value}</span>
      <span className='text-[9px] uppercase tracking-[0.18em] text-white/45'>{label}</span>
    </div>
  );
  return (
    <div className='pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 font-mono'>
      <div className='hud-panel flex items-center gap-1 !border-amber-400/25 px-2 py-2'>
        <div className='px-3 text-[10px] uppercase leading-tight tracking-[0.18em] text-amber-300/90'>
          Training<br />Range
        </div>
        <div className='h-8 w-px bg-white/10' />
        <Stat label='Accuracy' value={`${acc}%`} accent='text-cyan-200' />
        <Stat label='Streak' value={`${t.streak}`} accent={t.streak >= 5 ? 'text-amber-300' : 'text-white'} />
        <Stat label='Best' value={`${t.bestStreak}`} />
        <Stat label='Targets' value={`${t.destroyed}`} />
        <Stat label='Time' value={`${mins}:${secs.toString().padStart(2, '0')}`} />
      </div>
      <div className='mt-1 text-center text-[9px] uppercase tracking-[0.2em] text-white/35'>
        Free practice · no respawns · drill aim &amp; movement
      </div>
    </div>
  );
});

/* ───────────────────────── Mini leaderboard (top-left) ───────────────────────── */

const MiniLeaderboard = memo(function MiniLeaderboard({ scores }: { scores: PlayerScore[] }) {
  if (scores.length < 2) return null;
  const top = scores.slice(0, 5);
  // If you're not in the top 5, pin your own row under a gap.
  const localIndex = scores.findIndex((s) => s.isLocal);
  const you = localIndex >= 5 ? scores[localIndex] : null;
  const row = (s: PlayerScore, rank: number) => (
    <div
      key={s.id}
      className={`hud-panel flex items-center gap-2 px-2.5 py-[3px] ${
        s.isLocal ? '!border-cyan-300/40 !bg-cyan-400/15 shadow-[inset_3px_0_0_#67e8f9]' : ''
      }`}
    >
      <span className='w-4 shrink-0 text-right tabular-nums text-white/40'>{rank}</span>
      <span className={`min-w-0 flex-1 truncate ${s.isLocal ? 'font-semibold text-cyan-100' : 'text-white/80'}`}>
        {s.name}
      </span>
      <NameBadges admin={s.admin} verified={s.verified} size={11} />
      {s.currentStreak >= 3 && (
        <span className='bg-amber-400/85 px-1 text-[9px] font-bold text-amber-950'>{s.currentStreak}</span>
      )}
      <span className='w-6 shrink-0 text-right font-semibold tabular-nums text-white'>{s.frags}</span>
    </div>
  );
  return (
    <div className='absolute left-5 top-5 flex w-56 flex-col gap-[3px] font-mono text-[12px]' aria-label='Leaderboard'>
      {top.map((s) => row(s, scores.filter((o) => o.frags > s.frags).length + 1))}
      {you && <div className='mt-1'>{row(you, localIndex + 1)}</div>}
      <div className='hud-panel mt-1 flex items-center gap-1.5 self-start px-2 py-[2px] font-sans text-[11px] text-white/60'>
        <kbd className='rounded-[3px] border border-white/25 px-1 font-mono text-[9px] font-bold leading-[1.4] text-white/80'>Tab</kbd>
        scoreboard
      </div>
    </div>
  );
});

/* ───────────── Accessibility: announcer captions + SR live region ───────────── */

// The medal/drama/match callouts are otherwise audio + transient visuals only.
// This mirrors the current callout into an always-on screen-reader live region
// (so AT users hear "Double Kill", "Victory", etc.) and, when captions are on,
// shows it as on-screen text for deaf/HoH players.
function captionText(hud: HudState): string {
  if (hud.matchOver) return hud.matchOver.won ? 'Victory' : 'Defeat';
  if (hud.warmupMsLeft > 0) return 'Match starting…';
  if (hud.banner) return hud.banner.subtitle ? `${hud.banner.title} — ${hud.banner.subtitle}` : hud.banner.title;
  return '';
}

const CaptionLayer = memo(function CaptionLayer({
  text,
  captions,
}: {
  text: string;
  captions: boolean;
}) {
  return (
    <>
      {/* Always present so screen readers announce callouts regardless of the
          visible-captions toggle. Only re-announces when the text changes. */}
      <div aria-live='assertive' aria-atomic='true' className='sr-only'>
        {text}
      </div>
      {captions && text && (
        <div
          key={text}
          className='hud-caption pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2'
        >
          <span className='rounded-md bg-black/70 px-3 py-1.5 font-mono text-sm font-semibold uppercase tracking-[0.16em] text-white/90 shadow-lg'>
            {text}
          </span>
        </div>
      )}
    </>
  );
});

/* ───────────── Banner (top-center, BIG kill announce) ───────────── */

const BannerOverlay = memo(function BannerOverlay({ banner }: { banner: BannerState | null }) {
  // A replaced or cleared banner fades out under the incoming one (leaving
  // first in DOM order so the new banner paints on top).
  const items = useExitList(banner ? [banner] : [], {
    exitMs: HUD_EXIT_MS,
    leadMs: HUD_EXIT_LEAD_MS,
    leavingFirst: true,
  });
  if (items.length === 0) return null;
  return (
    <div className='absolute inset-x-0 top-[max(13%,8.75rem)]'>
      {items.map(({ item, leaving }) => (
        <BannerCard key={item.id} banner={item} leaving={leaving} />
      ))}
    </div>
  );
});

// One orchestrated in/out (.hud-banner*): title scales in, the bar under it
// draws, the subtitle rises in; the block fades on its pre-scheduled delay.
const BannerCard = memo(function BannerCard({
  banner,
  leaving,
}: {
  banner: BannerState;
  leaving: boolean;
}) {
  const colors = tierColors(banner.tier);
  return (
    // Robust centering: full-width flex row at fixed top offset. No translate
    // math, no left-1/2 vs intrinsic-width games.
    <div className='absolute inset-x-0 top-0 flex justify-center'>
      <div
        className={`hud-banner flex flex-col items-center text-center${leaving ? ' hud-leaving' : ''}`}
        style={hudTiming(banner.remaining, banner.total, HUD_EXIT_LEAD_MS)}
      >
        <div
          className={`bg-gradient-to-b ${colors.gradient} bg-clip-text font-display text-[72px] font-bold uppercase leading-[0.9] tracking-[0.03em] text-transparent`}
          style={{
            filter: `drop-shadow(0 3px 0 rgba(0,0,0,0.45)) drop-shadow(0 0 22px ${colors.glow})`,
          }}
        >
          {banner.title}
        </div>
        <div className={`hud-banner-bar mt-2 h-[3px] w-32 ${colors.bar}`} />
        {banner.subtitle && (
          <div className='hud-banner-sub mt-2 font-mono text-[13px] font-semibold uppercase tracking-[0.34em] text-white/80'>
            {banner.subtitle}
          </div>
        )}
      </div>
    </div>
  );
});

/* ───────────────────────── Speed + streak (bottom-left) ───────────────────────── */

function HudSpeedAndStreak() {
  return (
    <div className='absolute bottom-6 left-6 flex items-end gap-6'>
      <SpeedReadout />
      <StreakReadout />
    </div>
  );
}

// Live speed — re-renders only when the displayed tenth changes. The number
// ticks (CSS scale pop) on each dash, the action that changes it.
function SpeedReadout() {
  const text = useHudSlice((s) => s.speed.toFixed(1));
  const dashId = useHudSlice((s) => s.dashId);
  return (
    <div>
      <div className='hud-num-label'>Speed</div>
      <div className='hud-num'>
        <span key={dashId} className={dashId > 0 ? 'hud-tick' : undefined}>
          {text}
        </span>
        <span className='ml-1 font-mono text-xs font-normal text-white/45'>m/s</span>
      </div>
    </div>
  );
}

function StreakReadout() {
  const streak = useHudSlice((s) => s.currentStreak);
  if (streak < 2) return null;
  return (
    <div>
      <div className='hud-num-label text-amber-300/90'>Streak</div>
      {/* Keyed on the count so every increment ticks in. */}
      <div key={streak} className='hud-tick hud-num text-amber-200'>
        {streak}
      </div>
    </div>
  );
}

/* ───────────────────────── Cooldown cluster (bottom-right) ───────────────────────── */

function HudCooldowns() {
  return (
    <div className='absolute bottom-6 right-6 flex items-end gap-3'>
      <HudRailPip />
      <HudDashPip />
      <HudAirJumps />
    </div>
  );
}

function HudRailPip() {
  const fireId = useHudSlice((s) => s.railFireId);
  const ready = useHudSlice((s) => s.railCooldown <= 0);
  const text = useHudSlice((s) => s.railCooldown.toFixed(1));
  const elapsedMs = useHudLatched(fireId, (s) => (RAIL_COOLDOWN - s.railCooldown) * 1000);
  return (
    <CooldownPip
      label='Rail'
      eventId={fireId}
      ready={ready}
      text={text}
      total={RAIL_COOLDOWN}
      elapsedMs={elapsedMs}
      accent='#67e8f9'
    />
  );
}

function HudDashPip() {
  const dashId = useHudSlice((s) => s.dashId);
  const ready = useHudSlice((s) => s.dashCooldown <= 0);
  const text = useHudSlice((s) => s.dashCooldown.toFixed(1));
  const elapsedMs = useHudLatched(dashId, (s) => (DASH_COOLDOWN - s.dashCooldown) * 1000);
  return (
    <CooldownPip
      label='Dash'
      eventId={dashId}
      ready={ready}
      text={text}
      total={DASH_COOLDOWN}
      elapsedMs={elapsedMs}
      accent='#fcd34d'
    />
  );
}

function HudAirJumps() {
  return <AirJumpPip left={useHudSlice((s) => s.airJumpsLeft)} max={AIR_JUMPS} />;
}

// Ring pip. While cooling, the ring fill is a CSS stroke-dashoffset animation
// over the cooldown keyed on the use (`eventId`) and joined mid-way through
// `elapsedMs`; only the tenths readout in the middle updates from React. On
// ready the dot ticks in.
const CooldownPip = memo(function CooldownPip({
  label,
  eventId,
  ready,
  text,
  total,
  elapsedMs,
  accent,
}: {
  label: string;
  eventId: number;
  ready: boolean;
  text: string;
  total: number;
  elapsedMs: number;
  accent: string;
}) {
  // A charge gauge, not a hollow ring: a dim track, and while cooling a pie
  // that fills (a stroke as wide as its radius) under a bright rim arc. Both
  // are the same CSS dashoffset animation over the cooldown, keyed on the use
  // and joined mid-way via --cd-elapsed — React never drives the fill. When
  // charged the whole disc lights up and pops once.
  const R = 14; // rim radius
  const C = 2 * Math.PI * R;
  const P = R / 2; // pie radius (stroke-width R covers 0..R)
  const CP = 2 * Math.PI * P;
  const timing = {
    '--cd-total': `${total}s`,
    '--cd-elapsed': `${Math.max(0, Math.round(elapsedMs))}ms`,
  } as const;
  return (
    <div className='flex flex-col items-center gap-1'>
      <div className='relative h-[52px] w-[52px]'>
        <svg viewBox='0 0 32 32' overflow='visible' className='h-full w-full -rotate-90' aria-hidden>
          <circle cx='16' cy='16' r={R} fill='rgba(0,0,0,0.45)' stroke={accent} strokeOpacity='0.22' strokeWidth='3' />
          {ready ? (
            <g key={eventId} className='hud-tick hud-tick-center'>
              {/* Soft halo as a wide faint stroke (a CSS filter on SVG
                  groups paints a boxy bounding region in Chrome). */}
              <circle cx='16' cy='16' r={R + 1.2} fill='none' stroke={accent} strokeOpacity='0.22' strokeWidth='2.5' />
              <circle cx='16' cy='16' r={R - 1.5} fill={accent} fillOpacity='0.32' />
              <circle cx='16' cy='16' r={R} fill='none' stroke={accent} strokeWidth='3' />
            </g>
          ) : (
            <g key={eventId}>
              <circle
                className='hud-cd-ring'
                cx='16'
                cy='16'
                r={P}
                fill='none'
                stroke={accent}
                strokeOpacity='0.38'
                strokeWidth={R}
                strokeDasharray={CP}
                style={cssVars({ '--cd-c': CP, ...timing })}
              />
              <circle
                className='hud-cd-ring'
                cx='16'
                cy='16'
                r={R}
                fill='none'
                stroke={accent}
                strokeWidth='3'
                strokeDasharray={C}
                style={cssVars({ '--cd-c': C, ...timing })}
              />
            </g>
          )}
        </svg>
        {!ready && (
          <div className='absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold tabular-nums text-white'>
            {text}
          </div>
        )}
      </div>
      <div className='font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70'>{label}</div>
    </div>
  );
});

const AirJumpPip = memo(function AirJumpPip({ left, max }: { left: number; max: number }) {
  return (
    <div className='flex flex-col items-center gap-1'>
      <div className='flex h-[52px] items-center gap-1'>
        {Array.from({ length: max }).map((_, i) => (
          <div
            key={i}
            className={`h-3 w-3 rounded-full transition-colors ${
              i < left ? 'bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]' : 'bg-white/15'
            }`}
          />
        ))}
      </div>
      <div className='font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70'>Air</div>
    </div>
  );
});

/* ───────────────────────── FPS counter ───────────────────────── */

const FpsCounter = memo(function FpsCounter({ fps }: { fps: number }) {
  const color = fps >= 55 ? 'text-emerald-300' : fps >= 30 ? 'text-amber-300' : 'text-rose-300';
  return (
    <div className='hud-panel absolute right-5 top-0.5 px-1.5 font-mono text-[10px] tabular-nums text-white/70'>
      <span className={`mr-1 font-bold ${color}`}>{fps}</span>
      <span className='text-white/40'>fps</span>
    </div>
  );
});

// Table header cell (leaderboards / ladders).
function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <div
      className={`border-b border-white/10 pb-2 text-[10px] uppercase tracking-[0.16em] text-white/55 ${
        align === 'right' ? 'text-right' : ''
      }`}
    >
      {children}
    </div>
  );
}

/* ───────────────────────── Click to play / paused ───────────────────────── */

function ClickToPlay({
  onPlay,
  onOpenSettings,
  onLeave,
  hud,
  settings,
  info,
}: {
  onPlay: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
  hud: HudState;
  settings: Settings;
  info: HudMatchInfo;
}) {
  const kb = settings.keybinds;
  // Build the controls hint from the actual bindings so it stays correct after a
  // rebind (#26f). Move = the 4 movement keys; the rest follow their bindings.
  const moveKeys = [kb.forward, kb.left, kb.back, kb.right].map(keyLabel).join('');
  const controls = `${moveKeys} move · ${keyLabel(kb.jump)} jump · ${keyLabel(kb.dash)} dash · RMB boost · LMB fire · ${keyLabel(kb.scoreboard)} scores · Esc menu`;
  // The pause menu: a dimmed sheet over the live arena with the deck's big
  // display type. Clicking anywhere (the canvas underneath) re-locks the
  // pointer; the buttons are the explicit paths. Menu toasts (e.g. from the
  // in-match Settings sheet) rail here — never over live gameplay.
  return (
    <div className='absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white pointer-events-auto'>
      <div className='relative flex flex-col items-center px-6 text-center'>
        <div className='font-mono text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-300'>
          {info.mapName ? `${info.mapName} · ` : ''}
          {info.modeLine}
        </div>
        <div className='mt-3 font-display text-5xl font-bold uppercase tracking-[0.06em] sm:text-6xl'>
          Click to play
        </div>
        <div className='mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white/50'>{controls}</div>
        <div className='mt-8 flex flex-wrap items-center justify-center gap-3'>
          <DeckButton onClick={onPlay} solid accent='emerald' size='lg' center className='min-w-[10rem]'>
            Play
          </DeckButton>
          <DeckButton onClick={onOpenSettings} center>
            Settings
          </DeckButton>
          <DeckButton onClick={onLeave} accent='rose' center sound='uiBack'>
            Leave
          </DeckButton>
        </div>
        {hud.frags > 0 && (
          <div className='mt-10 grid grid-cols-3 gap-8 border-t border-white/10 pt-5 text-center font-mono'>
            <Stat label='Frags' value={hud.frags} />
            <Stat label='Best streak' value={hud.bestStreak} />
            <Stat label='Top speed' value={hud.speed.toFixed(1)} />
          </div>
        )}
      </div>
      <MenuToasts />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className='deck-label'>{label}</div>
      <div className='mt-1 font-display text-2xl font-bold tabular-nums'>{value}</div>
    </div>
  );
}

/* ───────────────────────── Lobby ───────────────────────── */

const QUICK_MAP_POOL = ['causeway', 'reactor', 'lounge'];
// Maps offered for online matches (no bots online → human-friendly pool).
const ONLINE_MAP_IDS: readonly string[] = ONLINE_MAP_POOL;

function randomMapId(): string {
  return QUICK_MAP_POOL[Math.floor(Math.random() * QUICK_MAP_POOL.length)];
}

function savedPlayerName(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return undefined;
    const name = (JSON.parse(raw) as Partial<Settings>)?.playerName;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function submitMatchStats(
  result: MatchResult,
  offline: boolean,
  mode?: GameMode | 'ranked',
): Promise<ProgressionResp | null> {
  try {
    // Stats are keyed server-side by an anonymous per-browser cookie; the name
    // is cosmetic (for the leaderboard), so send the local display name. The
    // `offline` flag scales XP server-side (practice shouldn't be the best farm).
    // `mode` is recorded on the audit row only (powers the dashboard breakdown).
    const res = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ...result, name: savedPlayerName(), offline, mode }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ProgressionResp;
  } catch {
    // Best-effort — ignore network errors so play never blocks on stats.
    return null;
  }
}

// ── Weekly Challenge ─────────────────────────────────────────────────────────
type WeeklyChallengeEntry = {
  id: string;
  userName: string;
  kills: number;
  timeMs: number; // best winning time (0 = never beat the bots)
  won: boolean;
  runs: number;
  admin: boolean;
  verified: boolean;
  hasReplay: boolean; // a rewatchable run is stored this week
};
type WeeklyChallengeMe = WeeklyChallengeEntry & { rank: number };

// mm:ss.s from a millisecond duration (for the challenge win time).
function fmtChallengeTime(ms: number): string {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
}

// Submit a finished weekly-challenge run + (if it's the new board-defining run)
// upload its full replay so anyone can rewatch it. Records to the weekly board
// only — never career K/D. Returns the player's updated standing, or null.
async function submitChallengeRun(
  run: { kills: number; won: boolean; timeMs: number; replay: Uint8Array },
): Promise<WeeklyChallengeMe | null> {
  try {
    const res = await fetch('/api/challenge/weekly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ kills: run.kills, won: run.won, timeMs: run.timeMs }),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { me?: WeeklyChallengeMe | null; acceptReplay?: boolean };
    // Upload the replay only when the server says this run now defines the board
    // row (best-effort — a failed upload just leaves the row without a replay).
    if (d.acceptReplay && run.replay.length) {
      void fetch('/api/challenge/weekly/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        credentials: 'same-origin',
        // Copy into a standalone ArrayBuffer so the typed-array view's offset
        // doesn't ship extra bytes.
        body: run.replay.slice().buffer,
      }).catch(() => {});
    }
    return d.me ?? null;
  } catch {
    return null;
  }
}

// Top-center count-up run timer for the weekly challenge. Shows the live run time
// (the engine's recorder clock — starts at the gun-go, freezes at match end), so
// it matches the time that gets submitted exactly. rAF-polls the engine for a
// smooth count without coupling to the throttled HUD stream.
function ChallengeTimer({ gameRef }: { gameRef: { current: Game | null } }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = gameRef.current;
      if (g) setMs(g.getChallengeElapsedMs());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameRef]);
  // Stay hidden until gameplay actually begins (the recorder clock starts at the
  // gun-go, so ms only leaves 0 once you can frag — never during load/countdown).
  if (ms <= 0) return null;
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const clock = `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  return (
    <div className='clip-deck-sm pointer-events-none absolute left-1/2 top-[5.75rem] z-[60] -translate-x-1/2 border border-cyan-400/30 bg-[#0b0c0f]/85 px-4 py-1.5 text-center font-mono'>
      <div className='text-[9px] uppercase tracking-[0.22em] text-cyan-300/80'>Run time</div>
      <div className='mt-0.5 font-display text-xl font-bold tabular-nums tracking-wide text-white'>{clock}</div>
    </div>
  );
}

// Menu chat caps. CLIENT_LEN mirrors the server's CHAT_MAX_LEN (the server is
// authoritative; this is just so the input + counter agree). LOG_MAX bounds the
// in-memory log (the server already trims replayed history to 50).
const CHAT_CLIENT_MAX_LEN = 240;
const CHAT_LOG_MAX = 120;

// ── Ranked Duel ──────────────────────────────────────────────────────────────
// Shared profile shape from GET /api/ranked/me (mirrors server db.ts RankedProfile).
type RankedProfile = {
  id: string;
  userName: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  rank: number;
  provisional: boolean;
};
type RankedLeaderEntry = {
  id: string;
  userName: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  admin: boolean;
  verified: boolean;
};

// Starting Elo for a brand-new ranked player (mirrors server RANKED_BASE_RATING).
const RANKED_BASE = 1000;
// Full-screen ranked end-of-match overlay: VICTORY/DEFEAT + the rating delta.
function RankedResultOverlay({
  result,
  progression,
  onLobby,
}: {
  result: RankedResult;
  progression: ProgressionResp | null;
  onLobby: () => void;
}) {
  const won = result.won;
  const mine = result.rating ? (won ? result.rating.winner : result.rating.loser) : null;
  const tier = mine ? rankedTier(mine.rating) : null;
  const delta = mine?.delta ?? 0;
  return (
    <ModalShell
      label={won ? 'Ranked duel — victory' : 'Ranked duel — defeat'}
      tone={won ? 'emerald' : 'rose'}
      z='z-[60]'
      width='w-[420px]'
      backdrop='heavy'
      padded={false}
      bodyClassName='gap-0'
      footer={
        <DeckButton onClick={onLobby} solid accent='cyan' center className='mx-auto'>
          Back to lobby
        </DeckButton>
      }
    >
      <div className={`px-7 py-6 text-center ${won ? 'bg-emerald-400/10' : 'bg-rose-500/10'}`}>
        <div
          className={`font-display text-4xl font-bold uppercase tracking-[0.18em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
        >
          {won ? 'Victory' : 'Defeat'}
        </div>
        <div className='mt-1 text-[12px] uppercase tracking-[0.2em] text-white/45'>
          Ranked Duel · {result.winnerFrags}–{result.loserFrags}
          {result.forfeit && ' · forfeit'}
        </div>
      </div>
      <div className='px-7 py-6'>
        {mine ? (
          <div className='text-center'>
            <div className='deck-label'>New rating</div>
            <div className='mt-1 flex items-center justify-center gap-3'>
              <span className='font-display text-3xl font-bold tabular-nums' style={{ color: tier?.color }}>
                {mine.rating}
              </span>
              <span
                className={`font-mono text-lg tabular-nums ${delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
              >
                {delta >= 0 ? '+' : ''}
                {delta}
              </span>
            </div>
            <div className='mt-1 text-[12px] text-white/55'>
              {tier?.name} · ladder #{mine.rank}
            </div>
            {result.reduced && (
              <div className='mt-2 text-[11px] text-amber-300/80'>
                Reduced rating — repeat opponent
              </div>
            )}
          </div>
        ) : (
          <div className='text-center text-[12px] text-white/50'>Unranked result.</div>
        )}
        {progression && (progression.xpGained > 0 || progression.creditsGained > 0) && (
          <div className='mt-4 text-center text-[12px] text-white/50'>
            <span className='text-cyan-200'>+{progression.xpGained} XP</span>
            {progression.creditsGained > 0 && (
              <>
                {' · '}
                <span className='text-amber-200'>+{progression.creditsGained} credits</span>
              </>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// Ranked Duel lobby modal: your rank card, the queue, the ladder, and a side
// panel of live ranked duels to spectate. Login-gated (a guest sees a prompt).
function RankedModal({
  account,
  status,
  rooms,
  onQueue,
  onCancel,
  onRequestRooms,
  onSpectate,
  onOpenLogin,
  onClose,
}: {
  account: Account;
  status: RankedStatus | null;
  rooms: RankedRoom[];
  onQueue: () => void;
  onCancel: () => void;
  onRequestRooms: () => void;
  onSpectate: (roomId: string, mapId: string) => void;
  onOpenLogin: () => void;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [ladder, setLadder] = useState<RankedLeaderEntry[]>([]);
  // Both fetches answered (ok or not) → the skeletons give way to real data /
  // the empty state, never a flash of "1000 · Unranked" before the answer.
  const [loaded, setLoaded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const searching = status?.state === 'searching';

  const refreshProfile = useCallback(() => {
    if (!account) return;
    const me = fetch('/api/ranked/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: RankedProfile } | null) => setProfile(d?.profile ?? null))
      .catch(() => {});
    const board = fetch('/api/ranked/leaderboard', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: RankedLeaderEntry[] } | null) => setLadder(d?.entries ?? []))
      .catch(() => {});
    void Promise.all([me, board]).then(() => setLoaded(true));
  }, [account]);

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  // Poll live ranked duels for the spectate panel while the modal is open.
  useEffect(() => {
    onRequestRooms();
    const t = setInterval(onRequestRooms, 3000);
    return () => clearInterval(t);
  }, [onRequestRooms]);

  // Tick the "searching… Ns" label.
  useEffect(() => {
    if (!searching) {
      setElapsed(0);
      return;
    }
    const since = status?.since ?? Date.now();
    const t = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000))), 500);
    return () => clearInterval(t);
  }, [searching, status?.since]);

  const tier = profile ? rankedTier(profile.rating) : null;
  const loading = !!account && !loaded;

  return (
    <ModalShell title='Ranked Duel' tone='fuchsia' size={account ? 'xl' : 'md'} onClose={onClose}>
      {!account ? (
        <div className='flex flex-col items-center gap-4 py-4 text-center'>
          <p className='font-sans text-[13px] text-white/60'>
            Ranked Duel is for logged-in players — your rating follows your account.
          </p>
          <DeckButton onClick={onOpenLogin} solid accent='cyan' center>
            Log in to play ranked
          </DeckButton>
        </div>
      ) : (
        <div className='grid gap-5 md:grid-cols-[1.2fr_1fr]' aria-busy={loading}>
          {/* Left: your rank + queue + ladder */}
          <div className='flex flex-col gap-4'>
            <div className='border border-white/10 bg-black/30 p-4'>
              <div className='flex items-center justify-between'>
                <div>
                  <div className='deck-label'>Your rating</div>
                  {loading ? (
                    <Skeleton className='mt-1.5 h-8 w-24' />
                  ) : (
                    <div className='mt-0.5 flex items-baseline gap-2'>
                      <span className='font-display text-3xl font-bold tabular-nums' style={{ color: tier?.color }}>
                        {profile?.rating ?? RANKED_BASE}
                      </span>
                      {tier && <span className='text-[12px] text-white/55'>{tier.name}</span>}
                    </div>
                  )}
                </div>
                <div className='text-right text-[11px] text-white/50'>
                  {loading ? (
                    <>
                      <Skeleton className='ml-auto h-3 w-16' />
                      <Skeleton className='ml-auto mt-1.5 h-3 w-12' />
                    </>
                  ) : (
                    <>
                      {profile && profile.rank > 0 ? (
                        <div>
                          Ladder <span className='text-cyan-200'>#{profile.rank}</span>
                        </div>
                      ) : (
                        <div className='text-white/35'>Unranked</div>
                      )}
                      <div className='tabular-nums'>
                        {profile?.wins ?? 0}W · {profile?.losses ?? 0}L
                      </div>
                      {profile?.provisional && <div className='text-amber-300/80'>provisional</div>}
                    </>
                  )}
                </div>
              </div>
              <div className='mt-4'>
                {searching ? (
                  <DeckButton onClick={onCancel} accent='rose' full center sound='uiBack'>
                    Searching… {elapsed}s · cancel
                  </DeckButton>
                ) : (
                  <DeckButton onClick={onQueue} solid accent='fuchsia' full center>
                    Find ranked match
                  </DeckButton>
                )}
                {status?.reason === 'account' && (
                  <p className='mt-2 text-center text-[11px] text-rose-300'>Ranked needs an account.</p>
                )}
                {status?.reason === 'in-match' && (
                  <p className='mt-2 text-center text-[11px] text-rose-300'>
                    You're already in a ranked match in another tab.
                  </p>
                )}
              </div>
            </div>

            <div className='border border-white/10 bg-black/30 p-4'>
              <div className='deck-label mb-2'>Ladder</div>
              {loading ? (
                <TableSkeleton rows={6} />
              ) : ladder.length === 0 ? (
                <div className='py-4 text-center text-[12px] text-white/35'>No ranked players yet — be the first.</div>
              ) : (
                <div className='deck-scroll max-h-[260px] overflow-y-auto'>
                  <table className='w-full text-left text-[12px]'>
                    <tbody>
                      {ladder.map((e, i) => {
                        const t = rankedTier(e.rating);
                        const me = profile?.id === e.id;
                        return (
                          <tr key={e.id} className={`deck-tr ${me ? 'deck-tr-you' : ''}`}>
                            <td className='py-1.5 pl-2 pr-2 tabular-nums text-white/40'>{i + 1}</td>
                            <td className='py-1.5 pr-2 text-white/85'>
                              <span className='flex items-center gap-1'>
                                {e.userName}
                                {e.verified && <span className='text-cyan-300'>✓</span>}
                              </span>
                            </td>
                            <td className='py-1.5 pr-2 text-right tabular-nums' style={{ color: t.color }}>
                              {e.rating}
                            </td>
                            <td className='py-1.5 pr-2 text-right tabular-nums text-white/40'>
                              {e.wins}-{e.losses}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Right: live ranked duels to spectate */}
          <div className='border border-white/10 bg-black/30 p-4'>
            <div className='mb-2 flex items-center justify-between'>
              <span className='deck-label'>Live ranked duels</span>
              <span className='text-[10px] text-white/30'>👁 spectate</span>
            </div>
            {rooms.length === 0 ? (
              <div className='py-6 text-center text-[12px] text-white/35'>No live ranked duels right now.</div>
            ) : (
              <div className='flex flex-col gap-2'>
                {rooms.map((r) => (
                  <button
                    key={r.id}
                    type='button'
                    onClick={() => onSpectate(r.id, r.mapId)}
                    {...sfxProps('uiConfirm')}
                    className='clip-deck-sm flex items-center justify-between border border-white/12 bg-black/40 px-3 py-2 text-left transition hover:border-cyan-400/50 hover:bg-cyan-400/5'
                  >
                    <span className='min-w-0 flex-1 truncate text-[12px] text-white/80'>
                      {r.players.map((p) => p.name).join('  vs  ') || 'Ranked duel'}
                    </span>
                    <span className='ml-3 shrink-0 tabular-nums text-[12px] text-cyan-200'>
                      {r.players.map((p) => p.frags).join(' – ')}
                    </span>
                    {r.spectators > 0 && (
                      <span className='ml-2 shrink-0 text-[10px] text-white/35'>👁 {r.spectators}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// Placeholder rows for a ladder / leaderboard while it loads: rank, name, and
// a right-aligned figure, in the same rhythm as the real rows.
function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className='flex flex-col' aria-hidden='true'>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='deck-tr flex items-center gap-3 px-2 py-2'>
          <Skeleton className='h-3 w-4' />
          <Skeleton className='h-3 flex-1' style={{ maxWidth: `${52 + ((i * 17) % 30)}%` }} />
          <Skeleton className='ml-auto h-3 w-10' />
        </div>
      ))}
    </div>
  );
}

// Weekly Challenge: a solo SPEEDRUN — an 8-player FFA (you + 7 easy bots) race to
// the frag cap on a fixed map. Beat the bots to the cap and your TIME tops the
// week; lose the race and your kills count instead. Every board-defining run is
// recorded, and anyone can rewatch it (▶). Anyone can play; only logged-in runs
// are recorded (consistent with career/ranked).
function WeeklyChallengeModal({
  account,
  settings,
  onPlay,
  onClose,
}: {
  account: Account;
  settings: Settings;
  onPlay: () => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<WeeklyChallengeEntry[]>([]);
  const [me, setMe] = useState<WeeklyChallengeMe | null>(null);
  const [info, setInfo] = useState<{ map: string; fragLimit: number } | null>(null);
  const [ready, setReady] = useState(false);
  // The board entry whose run we're rewatching (null = no viewer open).
  const [watch, setWatch] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/challenge/weekly/leaderboard', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: WeeklyChallengeEntry[]; me?: WeeklyChallengeMe | null; map?: string; fragLimit?: number } | null) => {
        if (!active || !d) return;
        setEntries(d.entries ?? []);
        setMe(d.me ?? null);
        setInfo({ map: d.map ?? WEEKLY_CHALLENGE_MAP, fragLimit: d.fragLimit ?? WEEKLY_CHALLENGE_FRAG_LIMIT });
        setReady(true);
      })
      .catch(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);
  const mapName = info ? (mapById(info.map)?.name ?? info.map) : '';
  return (
    <ModalShell title='Weekly Challenge' tone='amber' size='lg' onClose={onClose} bodyClassName='gap-4'>
      <p className='font-sans text-[13px] leading-relaxed text-white/65'>
        Solo <span className='text-rose-300'>8-player FFA</span> vs 7 easy bots
        {info ? ` on ${mapName} — first to ${info.fragLimit}` : ''}. Beat them to the cap and your{' '}
        <span className='text-amber-200'>clear time</span> tops the week; lose the race and your kills
        count instead. Every best run is recorded — hit <span className='text-cyan-300'>▶</span> to
        rewatch anyone&apos;s. Its own board — never touches your K/D.
      </p>

      <div className='flex items-center justify-between gap-4 border border-white/10 bg-black/30 px-4 py-3'>
        <div className='min-w-0'>
          <div className='deck-label'>Your week</div>
          {!ready ? (
            <Skeleton className='mt-1.5 h-3.5 w-40' />
          ) : me ? (
            <div className='mt-0.5 text-[13px] text-white/85'>
              {me.won ? `Best clear ${fmtChallengeTime(me.timeMs)}` : `${me.kills} kills`}
              <span className='text-white/45'> · rank #{me.rank}</span>
            </div>
          ) : (
            <div className='mt-0.5 text-[12px] text-white/45'>
              {account ? 'No run yet this week.' : 'Log in to save your score.'}
            </div>
          )}
        </div>
        <DeckButton onClick={onPlay} solid accent='amber' center className='shrink-0'>
          Play challenge
        </DeckButton>
      </div>

      <div className='border border-white/10 bg-black/30 p-4' aria-busy={!ready}>
        <div className='mb-2 flex items-center justify-between'>
          <span className='deck-label'>This week</span>
          <span className='text-[10px] text-white/30'>clear time · then kills</span>
        </div>
        {!ready ? (
          <TableSkeleton rows={6} />
        ) : entries.length === 0 ? (
          <div className='py-4 text-center text-[12px] text-white/35'>No runs yet — be the first.</div>
        ) : (
          <div className='deck-scroll max-h-[300px] overflow-y-auto'>
            <table className='w-full text-left text-[12px]'>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id} className={`deck-tr ${e.id === me?.id ? 'deck-tr-you' : ''}`}>
                    <td className='py-1.5 pl-2 pr-2 tabular-nums text-white/40'>{i + 1}</td>
                    <td className='py-1.5 pr-2 text-white/85'>
                      <span className='flex items-center gap-1'>
                        {e.userName}
                        {e.verified && <span className='text-cyan-300'>✓</span>}
                      </span>
                    </td>
                    <td className='w-8 py-1 pr-1 text-center'>
                      {e.hasReplay && (
                        <button
                          type='button'
                          onClick={() => setWatch({ id: e.id, name: e.userName })}
                          title={`Rewatch ${e.userName}'s run`}
                          aria-label={`Rewatch ${e.userName}'s run`}
                          {...sfxProps('uiConfirm')}
                          className='px-1.5 py-0.5 text-[11px] text-cyan-300 transition hover:bg-cyan-400/15 hover:text-cyan-200'
                        >
                          ▶
                        </button>
                      )}
                    </td>
                    <td
                      className={`py-1.5 pr-2 text-right tabular-nums ${e.won ? 'text-amber-200/90' : 'text-white/55'}`}
                    >
                      {e.won ? fmtChallengeTime(e.timeMs) : `${e.kills} K`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {watch && (
        <ReplayViewerOverlay
          key={watch.id} // fresh canvas per replay (the viewer force-loses its context on dispose)
          playerId={watch.id}
          playerName={watch.name}
          settings={settings}
          onClose={() => setWatch(null)}
        />
      )}
    </ModalShell>
  );
}

// Full-screen rewatch of a recorded weekly-challenge run: fetches the replay
// blob, decodes it, and drives a standalone ReplayViewer (first-person through
// the runner's eyes) with play/pause/scrub/speed controls.
const REPLAY_SPEEDS = [0.5, 1, 2] as const;

function ReplayViewerOverlay({
  playerId,
  playerName,
  settings,
  onClose,
}: {
  playerId: string;
  playerName: string;
  settings: Settings;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<ReplayViewer | null>(null);
  const [state, setState] = useState<ReplayViewerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  // Snapshot the graphics settings once so the viewer matches the game's look
  // without re-creating on every settings change mid-watch.
  const gfxRef = useRef({
    fov: settings.fov,
    resolutionScale: settings.resolutionScale,
    lowSpec: settings.lowSpec,
    volume: settings.volume,
    sfxVolume: settings.sfxVolume,
    announcerVolume: settings.announcerVolume,
    announcerEnabled: settings.announcerEnabled,
    announcerPack: settings.announcerPack,
  });
  // onClose changes identity on every parent (Lobby) re-render — keep it in a ref
  // so the viewer effect can depend only on playerId. Otherwise the Lobby's
  // polling re-renders would tear down + recreate the viewer mid-watch, snapping
  // playback back to 0.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Sit on top of the modal stack so the Weekly dialog underneath ignores the
  // Escape that closes this viewer (instead of both closing at once).
  useModalStack();

  useEffect(() => {
    let cancelled = false;
    let viewer: ReplayViewer | null = null;
    (async () => {
      try {
        const res = await fetch(
          `/api/challenge/weekly/replay?player=${encodeURIComponent(playerId)}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) throw new Error('unavailable');
        const buf = await res.arrayBuffer();
        let data: ReplayData;
        try {
          data = decodeReplay(buf);
        } catch {
          throw new Error('corrupt');
        }
        if (cancelled || !canvasRef.current) return;
        viewer = new ReplayViewer(
          canvasRef.current,
          data,
          (s) => {
            if (!cancelled) setState(s);
          },
          gfxRef.current,
        );
        viewerRef.current = viewer;
        await viewer.start(); // starts paused on the first frame
      } catch {
        if (!cancelled) setError('This run could not be loaded.');
      }
    })();
    // Esc closes (or exits fullscreen first); Space toggles play.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return; // browser handles fullscreen exit
        onCloseRef.current();
      } else if (e.code === 'Space') {
        e.preventDefault();
        viewerRef.current?.togglePlay();
      }
    };
    const onFsChange = () => setIsFs(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, [playerId]);

  // Once the scene is loaded + the first frame is rendering (behind the black
  // cover), run a short 3-2-1 countdown, then auto-play. The cover masks the
  // initial load/first-frame warm-up so the rewatch never flashes a blank frame.
  const ready = state?.ready ?? false;
  const startedRef = useRef(false);
  useEffect(() => {
    if (!ready || error || startedRef.current) return;
    startedRef.current = true;
    let n = 3;
    setCountdown(n);
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(id);
        setCountdown(null);
        viewerRef.current?.play();
      } else {
        setCountdown(n);
      }
    }, 700);
    return () => clearInterval(id);
  }, [ready, error]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  }, []);

  const duration = state?.duration ?? 0;
  const t = state?.t ?? 0;
  const playing = state?.playing ?? false;
  // Cover the canvas (black) until the scene is loaded AND the intro countdown has
  // finished — masks the initial load + first-frame warm-up so it never flashes.
  const showCover = !!error || !ready || countdown !== null;

  // Portal to <body> so the overlay escapes the modal's clip-path / transform
  // (which otherwise traps a position:fixed child into a tiny clipped square).
  return createPortal(
    <div ref={rootRef} className='fixed inset-0 z-[200] flex flex-col bg-black font-mono'>
      <canvas ref={canvasRef} className='absolute inset-0 block h-full w-full' />

      {/* Loading / countdown cover */}
      {showCover && (
        <div
          className={`absolute inset-0 z-[5] flex flex-col items-center justify-center ${
            countdown !== null ? 'bg-black/55' : 'bg-black'
          }`}
        >
          {error ? (
            <div className='text-[13px] text-rose-300'>{error}</div>
          ) : countdown !== null ? (
            <>
              <div className='text-[10px] uppercase tracking-[0.3em] text-cyan-300/80'>Starting run</div>
              <div className='mt-1 font-display text-7xl font-bold tabular-nums text-white drop-shadow-[0_0_24px_rgba(34,211,238,0.5)]'>
                {countdown}
              </div>
            </>
          ) : (
            <div className='flex flex-col items-center gap-3'>
              <div className='h-7 w-7 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300' />
              <div className='text-[12px] uppercase tracking-[0.2em] text-white/55'>Loading replay…</div>
            </div>
          )}
        </div>
      )}

      {/* Top bar */}
      <div className='relative z-10 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent px-5 py-3'>
        <div className='flex items-baseline gap-2'>
          <span className='text-[10px] uppercase tracking-[0.2em] text-cyan-300'>Replay</span>
          <span className='font-display text-sm font-semibold text-white/90'>{playerName}&apos;s run</span>
        </div>
        <div className='flex items-center gap-2'>
          <UtilButton onClick={toggleFullscreen}>{isFs ? '⤢ Windowed' : '⛶ Fullscreen'}</UtilButton>
          <UtilButton onClick={onClose} sound='uiBack'>
            Close ✕
          </UtilButton>
        </div>
      </div>

      <div className='flex-1' />

      {/* Bottom controls */}
      <div className='relative z-10 bg-gradient-to-t from-black/85 to-transparent px-5 pb-5 pt-8'>
        {error ? (
          <div className='text-center text-[13px] text-rose-300'>{error}</div>
        ) : !ready ? (
          <div className='text-center text-[11px] uppercase tracking-[0.2em] text-white/50'>Loading replay…</div>
        ) : (
          <div className='mx-auto flex max-w-3xl items-center gap-3'>
            <DeckButton
              onClick={() => viewerRef.current?.togglePlay()}
              solid
              accent='cyan'
              size='sm'
              center
              className='w-16'
              aria-label={playing ? 'Pause' : 'Play'}
              sound='uiClick'
            >
              {playing ? '❚❚' : '▶'}
            </DeckButton>
            <span className='w-12 shrink-0 text-right text-[11px] tabular-nums text-white/70'>
              {fmtChallengeTime(t * 1000)}
            </span>
            <input
              type='range'
              aria-label='Scrub'
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={Math.min(t, duration)}
              onChange={(ev) => viewerRef.current?.seek(parseFloat(ev.target.value))}
              className='deck-range h-1.5 flex-1'
            />
            <span className='w-12 shrink-0 text-[11px] tabular-nums text-white/40'>
              {fmtChallengeTime(duration * 1000)}
            </span>
            <div className='flex items-center gap-1' role='group' aria-label='Playback speed'>
              {REPLAY_SPEEDS.map((s) => (
                <SegButton
                  key={s}
                  active={state?.speed === s}
                  onClick={() => viewerRef.current?.setSpeed(s)}
                  className='px-2 py-1 font-mono text-[11px] normal-case tabular-nums tracking-normal'
                >
                  {s}×
                </SegButton>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Lobby({
  settings,
  onChangeSettings,
  onStart,
  lastResult,
  account,
  onOpenLogin,
  onLogout,
  lastProgression = null,
}: {
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onStart: (config: MatchConfig) => void;
  lastResult: MatchResult | null;
  account: Account;
  onOpenLogin: () => void;
  onLogout: () => void;
  // The finished match's server reward (when the shell passes it through);
  // otherwise the banner diffs the profile before/after the match.
  lastProgression?: ProgressionResp | null;
}) {
  const [soloOpen, setSoloOpen] = useState(false);
  const [createOnlineOpen, setCreateOnlineOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [challengesOpen, setChallengesOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('controls');
  const [lockerOpen, setLockerOpen] = useState(false);
  const [lobbyProfile, setLobbyProfile] = useState<MenuProfile | null>(null);
  const [challenges, setChallenges] = useState<ChallengeLists | null>(null);
  const [roadOpen, setRoadOpen] = useState(false);
  const [heroHover, setHeroHover] = useState(false);
  const heroSlotRef = useRef<HTMLDivElement>(null);
  const [claimable, setClaimable] = useState(0); // completed-but-unclaimed challenges
  const [refreshTick, setRefreshTick] = useState(0); // bump to re-pull profile/challenges
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [lobbyStatus, setLobbyStatus] = useState<LobbyStatus>('connecting');
  const [invite, setInvite] = useState<{ roomId: string; mapId: string } | null>(null);
  const [searching, setSearching] = useState(false); // quick-match in flight (#26e)
  const [rankedOpen, setRankedOpen] = useState(false);
  const [rankedStatus, setRankedStatus] = useState<RankedStatus | null>(null);
  const [rankedRooms, setRankedRooms] = useState<RankedRoom[]>([]);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  // Selected online game mode for Quick Match + Create Match (FFA / Duel / TDM).
  const [selectedMode, setSelectedMode] = useState<GameMode>(DEFAULT_GAME_MODE);
  // Live menu presence + global chat (pushed over the lobby socket).
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);

  // A custom server URL is a dev/LAN-only convenience. In production we ALWAYS
  // use the same-origin server and ignore any persisted/imported serverUrl, so
  // the live client can't be pointed at another server (the setting is hidden).
  const serverUrl =
    import.meta.env.DEV && settings.serverUrl ? settings.serverUrl : defaultServerUrl();
  const lobbyRef = useRef<LobbyClient | null>(null);
  // Presence anti-flicker: apply increases immediately, but hold a DECREASE for a
  // short beat before showing it. A player switching menu↔match briefly drops one
  // socket before the other connects, which would otherwise blip the count down
  // and back up; this absorbs those transient dips so the live count stays steady.
  const presenceRef = useRef<PresenceState | null>(null);
  const presenceDipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyPresence = useCallback((p: PresenceState) => {
    if (presenceDipTimer.current) {
      clearTimeout(presenceDipTimer.current);
      presenceDipTimer.current = null;
    }
    const cur = presenceRef.current;
    if (!cur || p.online >= cur.online) {
      presenceRef.current = p;
      setPresence(p);
    } else {
      presenceDipTimer.current = setTimeout(() => {
        presenceDipTimer.current = null;
        presenceRef.current = p;
        setPresence(p);
      }, 1000);
    }
  }, []);

  const startOnline = useCallback(
    (roomId: string, mapId: string) =>
      onStart({ mode: 'multiplayer', mapId, serverUrl, roomId }),
    [onStart, serverUrl],
  );

  const startSpectate = useCallback(
    (roomId: string, mapId: string) =>
      onStart({ mode: 'spectator', mapId, serverUrl, roomId }),
    [onStart, serverUrl],
  );

  // Connect the lobby browser once: it lists public rooms and runs the
  // quick-match / create handshakes. Resolved rooms start a multiplayer match.
  useEffect(() => {
    const lobby = new LobbyClient(serverUrl, settings.playerName || 'Player');
    lobbyRef.current = lobby;
    lobby.onRooms = setRooms;
    lobby.onStatus = setLobbyStatus;
    lobby.onResolved = (info) => {
      if (info.kind === 'matched') {
        startOnline(info.roomId, info.mapId);
      } else if (info.isPublic) {
        startOnline(info.roomId, info.mapId);
      } else {
        // Private: show the invite link; the host enters when ready.
        setInvite({ roomId: info.roomId, mapId: info.mapId });
      }
    };
    lobby.onPresence = applyPresence;
    lobby.onChatHistory = (m) => setChatLog(m.slice(-CHAT_LOG_MAX));
    lobby.onChat = (m) =>
      setChatLog((log) => {
        const next = [...log, m];
        return next.length > CHAT_LOG_MAX ? next.slice(next.length - CHAT_LOG_MAX) : next;
      });
    // A rejected chat line surfaces as a menu toast (warn tone).
    lobby.onChatRejected = (reason) =>
      toast(
        reason === 'rate'
          ? 'Slow down — too many messages.'
          : reason === 'account'
            ? 'Log in to chat.'
            : 'Message blocked by the filter.',
        { tone: 'warn', sound: 'uiError' },
      );
    lobby.onRankedStatus = setRankedStatus;
    lobby.onRankedRooms = setRankedRooms;
    lobby.connect();
    return () => {
      lobby.dispose();
      lobbyRef.current = null;
      if (presenceDipTimer.current) {
        clearTimeout(presenceDipTimer.current);
        presenceDipTimer.current = null;
      }
    };
    // Reconnect (and re-bind onResolved → startOnline) when the Server URL
    // setting changes, so a custom URL isn't silently ignored until reload (#18).
    // playerName is handled by the cheap setName effect below — not a dep here,
    // so typing a name doesn't churn the socket. applyPresence is stable.
  }, [serverUrl, startOnline, applyPresence]);

  // Keep the server-side display name fresh without reconnecting.
  useEffect(() => {
    lobbyRef.current?.setName(settings.playerName || 'Player');
  }, [settings.playerName]);

  // Pull the profile (level/XP/credits) + challenges for the lobby chrome.
  // Re-pulls whenever a modal that can change them closes (refreshTick) and
  // when you log in or out.
  const accountName = account?.username ?? '';
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile'))))
      .then((d: { profile?: MenuProfile }) => {
        if (!active || !d.profile) return;
        setLobbyProfile(d.profile);
        const granted = freshCatchUp(d.profile);
        if (granted.length > 0) {
          const top = granted[granted.length - 1].level;
          toast(
            granted.length === 1
              ? `Career Road reward granted · level ${top}`
              : `Career Road rewards granted · ${granted.length} levels, up to ${top}`,
            { tone: 'ok' },
          );
        }
      })
      .catch(() => {});
    void fetchChallenges().then((d) => {
      if (!active || !d) return;
      setChallenges(d);
      setClaimable([...d.daily, ...d.weekly].filter((c) => c.complete && !c.claimed).length);
    });
    return () => {
      active = false;
    };
  }, [refreshTick, accountName]);
  const refreshMeta = useCallback(() => setRefreshTick((t) => t + 1), []);

  // What your combatant wears in the menu (reacts as the Locker changes it).
  const heroLoadout = useMemo<HeroLoadout>(
    () => ({
      seed: settings.playerName || 'you',
      hat: settings.hat,
      unusual: settings.unusual,
      railgunFinish: settings.railgunFinish,
      emote: settings.emote,
      looks: settings.looks,
    }),
    [settings.playerName, settings.hat, settings.unusual, settings.railgunFinish, settings.emote, settings.looks],
  );
  // Career Road try-on: your loadout, with the previewed reward swapped in.
  const roadLoadout = useMemo(
    () => ({
      seed: settings.playerName || 'you',
      hat: settings.hat,
      unusual: settings.unusual,
      railgunFinish: settings.railgunFinish,
      railColor: settings.railColor,
      killEffect: settings.killEffect,
      emote: settings.emote,
      spawnEffect: settings.spawnEffect,
    }),
    [
      settings.playerName,
      settings.hat,
      settings.unusual,
      settings.railgunFinish,
      settings.railColor,
      settings.killEffect,
      settings.emote,
      settings.spawnEffect,
    ],
  );
  // Per-match XP for the Last match banner: the server's reward for that match
  // only (it may arrive a beat after the lobby mounts); nothing for guests.
  const lastGain = gainFrom(lastProgression);
  // The challenge set rolls over at its reset: pull the new one.
  useRefetchAtReset(challenges, refreshMeta);
  // Doors + challenges live in the right column on wide layouts, under the
  // menu on narrow ones — mounted once, where they're shown.
  const wide = useMedia('(min-width: 1024px)');

  const openSettingsAt = (t: SettingsTab) => {
    setSettingsTab(t);
    setSettingsOpen(true);
  };

  const online = lobbyStatus === 'open';

  // The game needs a mouse + keyboard + pointer lock. On touch-only devices that
  // all silently fails, so flag it and steer the player away (#14).
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    setTouchOnly((navigator.maxTouchPoints ?? 0) > 0 && coarse);
  }, []);
  const playDisabled = touchOnly;

  // Live 3D backdrop pauses under any open dialog (it's mostly dimmed out).
  const modalOpen = useAnyModalOpen();
  const [arenaName, setArenaName] = useState('');
  const onBackdropMap = useCallback((_id: string, name: string) => setArenaName(name), []);
  // Social dock (lobbies / chat / who's online): open by default on wide
  // screens, remembered per browser. Secondary to the ways to play.
  const [dockOpen, setDockOpen] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem('instagib-social-dock');
      if (v === '1' || v === '0') return v === '1';
    } catch {
      /* storage blocked */
    }
    return typeof window !== 'undefined' && window.innerWidth >= 1500;
  });
  const toggleDock = useCallback(() => {
    setDockExpanded((e) => !e);
    setDockOpen((o) => {
      try {
        window.localStorage.setItem('instagib-social-dock', o ? '0' : '1');
      } catch {
        /* storage blocked */
      }
      return !o;
    });
  }, []);
  const [dockTab, setDockTab] = useState<DockTabId>('lobbies');
  // An empty dock (no lobbies, no chat) is just a one-line chip until asked.
  const [dockExpanded, setDockExpanded] = useState(false);
  const dockEmpty = rooms.length === 0 && chatLog.length === 0;
  const dockCompact = dockOpen && dockEmpty && !dockExpanded;
  const lobbyCount = online ? rooms.length : 0;
  const onlineCount = presence?.online ?? 0;
  const offline = lobbyStatus === 'closed' || lobbyStatus === 'error';

  const playNow = () => {
    if (playDisabled) return;
    // Server unreachable: Play still plays — offline vs bots.
    if (offline) {
      setSoloOpen(true);
      return;
    }
    if (searching || !online) return; // double-fire guard
    setSearching(true);
    // "Play" = mode-agnostic super-queue: join whatever's live so a small
    // population concentrates instead of splitting 3 ways. Create Match picks
    // a specific mode.
    lobbyRef.current?.quickMatch('any');
    window.setTimeout(() => setSearching(false), 6000);
  };
  const playSub = searching
    ? 'Finding a live arena…'
    : offline
      ? 'Server offline · play vs bots'
      : !online
        ? 'Linking to server…'
        : 'Quick match · any mode';

  return (
    <div className={`menu-root fixed inset-0 z-50 overflow-hidden text-white ${settings.reducedEffects ? 'menu-reduced' : ''}`}>
      <MenuBackdropView
        active={!modalOpen}
        still={settings.lowSpec || settings.reducedEffects || LIGHT_DEVICE}
        lowSpec={settings.lowSpec}
        bloomScale={settings.bloomIntensity ?? 0.8}
        onMap={onBackdropMap}
        hero={heroLoadout}
        heroSlot={heroSlotRef}
        heroHover={heroHover && !modalOpen}
      />
      <div aria-hidden='true' className='menu-scrim pointer-events-none absolute inset-0' />
      <a href='#lobby-main' className='deck-skip-link'>
        Skip to content
      </a>
      <MenuToasts />
      <div className='relative flex h-full w-full flex-col px-5 pb-4 pt-4 sm:px-10 sm:pt-5 lg:px-14'>
        {/* ── Top bar: who you are (left) · account + server (right) ─── */}
        <header className='relative z-20 flex shrink-0 flex-wrap items-start justify-between gap-3'>
          <div className='menu-in-top w-full sm:w-auto sm:min-w-[19rem] sm:max-w-[29rem] sm:flex-1' style={{ ['--d' as string]: 0 }}>
            <ProfileBlock
              account={account}
              profile={lobbyProfile}
              name={account?.username ?? settings.playerName}
              nameColor={settings.nameColor}
              title={settings.title}
              onOpenRoad={() => setRoadOpen(true)}
              onLogin={onOpenLogin}
            />
          </div>
          <div className='menu-in-top ml-auto flex items-center gap-3 sm:pt-1' style={{ ['--d' as string]: 1 }}>
            {account && (
              <AccountMenu
                isAdmin={account.isAdmin}
                onStats={() => setStatsOpen(true)}
                onSettings={() => openSettingsAt('controls')}
                onAdmin={() => setAdminOpen(true)}
                onLogout={onLogout}
              />
            )}
            <ServerStatusChip status={lobbyStatus} />
            {!dockOpen && (
              <button
                type='button'
                onClick={toggleDock}
                aria-expanded={false}
                {...sfxProps('uiToggle')}
                className='clip-deck-sm inline-flex items-center gap-1.5 border border-white/15 bg-black/40 px-2.5 py-1 font-display text-[13px] font-semibold uppercase tracking-[0.06em] text-white/75 transition hover:border-cyan-300/60 hover:text-cyan-100'
              >
                Lobbies &amp; chat
                {online && rooms.length > 0 && <span className='tabular-nums text-cyan-300'>{rooms.length}</span>}
              </button>
            )}
          </div>
        </header>

        <main id='lobby-main' tabIndex={-1} className='relative flex min-h-0 flex-1 gap-6 outline-none'>
          {/* ── Left: identity + ways to play ─────────────────────────── */}
          <section className='deck-scroll flex min-h-0 w-full max-w-[31rem] shrink-0 flex-col overflow-y-auto'>
            <div className='my-auto flex flex-col py-4'>
              <div className='menu-in' style={{ ['--d' as string]: 0 }}>
                <MenuWordmark />
              </div>
              <p className='menu-tagline menu-in' style={{ ['--d' as string]: 1 }}>
                One railgun. One shot. One kill.
              </p>

              {touchOnly && (
                <div className='clip-deck-sm mt-6 border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-[12px] text-amber-100'>
                  Instagib needs a <span className='font-bold'>mouse + keyboard</span>. Open this on a
                  desktop to play.
                </div>
              )}

              <div className='menu-in mt-8' style={{ ['--d' as string]: 2 }}>
                <MenuPlayButton
                  onClick={playNow}
                  disabled={playDisabled || searching || (!online && !offline)}
                  busy={searching}
                  sub={playSub}
                />
              </div>

              <nav aria-label='Ways to play' className='mt-4 flex flex-col'>
                <MenuItem
                  onClick={() => setCreateOnlineOpen(true)}
                  disabled={!online || playDisabled}
                  accent='cyan'
                  sub='Host FFA, duel or TDM'
                  delay={3}
                >
                  Create match
                </MenuItem>
                <MenuItem
                  onClick={() => setRankedOpen(true)}
                  disabled={!online || playDisabled}
                  accent='fuchsia'
                  sub='1v1 on the Elo ladder'
                  delay={4}
                >
                  Ranked duel
                </MenuItem>
                <MenuItem onClick={() => setSoloOpen(true)} disabled={playDisabled} accent='emerald' sub='Offline, your rules' delay={5}>
                  Solo vs bots
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    onStart({
                      mode: 'local',
                      mapId: 'training',
                      botCount: 0, // targets, not a firefight — practice aim + movement safely
                      difficulty: settings.difficulty,
                      training: true,
                    })
                  }
                  disabled={playDisabled}
                  accent='amber'
                  sub='Aim drills, no pressure'
                  delay={6}
                >
                  Training range
                </MenuItem>
                <MenuItem onClick={() => setWeeklyOpen(true)} disabled={playDisabled} accent='amber' sub='8-player speedrun' delay={7}>
                  Weekly challenge
                </MenuItem>
              </nav>

              {/* Meta surfaces: quiet links, visually subordinate to playing. */}
              <div
                className='menu-in mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4'
                style={{ ['--d' as string]: 8 }}
              >
                <MenuLink onClick={() => setStatsOpen(true)}>Stats</MenuLink>
                <MenuLink onClick={() => setChallengesOpen(true)} badge={claimable}>
                  Challenges
                </MenuLink>
                <MenuLink onClick={() => setLeaderboardOpen(true)}>Leaderboard</MenuLink>
                <MenuLink onClick={() => openSettingsAt('controls')}>Settings</MenuLink>
              </div>

              {lastResult && (
                <div className='menu-in' style={{ ['--d' as string]: 9 }}>
                  <LastMatchBanner result={lastResult} gain={lastGain} />
                </div>
              )}

              {/* Narrow layouts: the doors + challenges ride under the menu. */}
              {!wide && (
                <div className='menu-in mt-5 flex flex-col gap-3' style={{ ['--d' as string]: 10 }}>
                  <FrontDoors
                    profile={lobbyProfile}
                    guest={!account}
                    hat={settings.hat}
                    railgunFinish={settings.railgunFinish}
                    onRoad={() => setRoadOpen(true)}
                    onLocker={() => setLockerOpen(true)}
                  />
                  <ChallengesStrip
                    lists={challenges}
                    guest={!account}
                    onOpen={() => setChallengesOpen(true)}
                    onLogin={onOpenLogin}
                    onClaimed={refreshMeta}
                  />
                </div>
              )}
            </div>
          </section>

          {/* ── Centre: your combatant (3D, drawn by the backdrop) ─────── */}
          <HeroSlot
            slotRef={heroSlotRef}
            onCustomize={() => setLockerOpen(true)}
            onHover={setHeroHover}
            hover={heroHover}
            className='max-lg:hidden lg:!absolute lg:inset-y-0 lg:left-[32.5rem] lg:right-[20.5rem] 2xl:right-28'
          />

          {/* ── Right: challenges over the social dock ─────────────────── */}
          <div className='menu-in-right flex min-h-0 flex-col gap-3 pb-2 lg:relative lg:z-10 lg:ml-auto lg:w-[19.5rem] lg:shrink-0 xl:w-[21rem] max-lg:pointer-events-none max-lg:absolute max-lg:inset-x-5 max-lg:bottom-3 max-lg:top-2 max-lg:z-10'>
            {wide && (
              <div className='flex flex-col gap-3'>
                <FrontDoors
                  profile={lobbyProfile}
                  guest={!account}
                  hat={settings.hat}
                  railgunFinish={settings.railgunFinish}
                  onRoad={() => setRoadOpen(true)}
                  onLocker={() => setLockerOpen(true)}
                />
                <ChallengesStrip
                  lists={challenges}
                  guest={!account}
                  onOpen={() => setChallengesOpen(true)}
                  onLogin={onOpenLogin}
                  onClaimed={refreshMeta}
                />
              </div>
            )}
            <div className='menu-dock-col pointer-events-none flex min-h-0 flex-1 flex-col items-end justify-end [&>*]:pointer-events-auto'>
              {dockCompact && (
                <button
                  type='button'
                  onClick={() => setDockExpanded(true)}
                  aria-expanded={false}
                  {...sfxProps('uiToggle')}
                  className='menu-dock-chip clip-deck-sm'
                >
                  <span aria-hidden='true' className={`h-2 w-2 rounded-full ${online ? 'deck-pulse bg-emerald-400' : 'bg-amber-400'}`} />
                  {online ? (
                    <>
                      <span className='menu-dock-stat'>
                        <b>{onlineCount}</b> online
                      </span>
                      <span className='menu-dock-stat'>
                        <b>{lobbyCount}</b> {lobbyCount === 1 ? 'lobby' : 'lobbies'}
                      </span>
                    </>
                  ) : (
                    <span>Linking to server</span>
                  )}
                  <span className='menu-dock-open'>Chat</span>
                </button>
              )}
              <SocialDock
                open={dockOpen && !dockCompact}
                onToggle={toggleDock}
                tab={dockTab}
                onTab={setDockTab}
                lobbies={online ? rooms.length : 0}
                online={presence?.online ?? null}
              >
                {dockTab === 'lobbies' ? (
                  <OpenLobbies
                    rooms={rooms}
                    online={online}
                    onJoin={(r) => startOnline(r.id, r.mapId)}
                    onSpectate={(r) => startSpectate(r.id, r.mapId)}
                    onRefresh={() => lobbyRef.current?.refresh()}
                  />
                ) : dockTab === 'chat' ? (
                  <GlobalChatPanel
                    messages={chatLog}
                    online={online}
                    canChat={!!account}
                    youName={account?.username ?? null}
                    onSend={(text) => lobbyRef.current?.sendChat(text)}
                  />
                ) : (
                  <OnlinePlayersPanel presence={presence} youName={account?.username ?? null} />
                )}
              </SocialDock>
            </div>
          </div>
        </main>

        {/* ── Footer: what you're looking at, whisper-quiet ─────────────── */}
        <footer className='flex shrink-0 items-center justify-between gap-4 pt-3 font-sans text-[12px] text-white/45'>
          <span className='truncate'>
            {arenaName && (
              <>
                Arena · <span className='text-white/75'>{arenaName}</span>
              </>
            )}
          </span>
        </footer>
      </div>
      {soloOpen && (
        <CreateMatchModal
          settings={settings}
          onChangeSettings={onChangeSettings}
          onClose={() => setSoloOpen(false)}
          onStart={(c) => {
            setSoloOpen(false);
            onStart(c);
          }}
        />
      )}
      {createOnlineOpen && (
        <CreateOnlineModal
          settings={settings}
          mode={selectedMode}
          onChangeSettings={onChangeSettings}
          onChangeMode={setSelectedMode}
          onClose={() => setCreateOnlineOpen(false)}
          onCreate={(opts) => {
            setCreateOnlineOpen(false);
            lobbyRef.current?.createRoom(opts);
          }}
        />
      )}
      {invite && (
        <InviteModal
          roomId={invite.roomId}
          onEnter={() => {
            const { roomId, mapId } = invite;
            setInvite(null);
            startOnline(roomId, mapId);
          }}
          onClose={() => setInvite(null)}
        />
      )}
      {statsOpen && <StatsModal onClose={() => setStatsOpen(false)} />}
      {challengesOpen && (
        <ChallengesModal
          guest={!account}
          onLogin={() => {
            setChallengesOpen(false);
            onOpenLogin();
          }}
          onClose={() => {
            setChallengesOpen(false);
            setRefreshTick((t) => t + 1); // claiming changed credits + claim count
          }}
        />
      )}
      {leaderboardOpen && <LeaderboardModal onClose={() => setLeaderboardOpen(false)} />}
      {rankedOpen && (
        <RankedModal
          account={account}
          status={rankedStatus}
          rooms={rankedRooms}
          onQueue={() => lobbyRef.current?.rankedQueue()}
          onCancel={() => lobbyRef.current?.rankedCancel()}
          onRequestRooms={() => lobbyRef.current?.requestRankedRooms()}
          onSpectate={(roomId, mapId) => {
            setRankedOpen(false);
            onStart({ mode: 'spectator', mapId, serverUrl, roomId });
          }}
          onOpenLogin={() => {
            setRankedOpen(false);
            onOpenLogin();
          }}
          onClose={() => {
            // Leaving the ranked screen cancels any pending search.
            if (rankedStatus?.state === 'searching') lobbyRef.current?.rankedCancel();
            setRankedOpen(false);
          }}
        />
      )}
      {weeklyOpen && (
        <WeeklyChallengeModal
          account={account}
          settings={settings}
          onPlay={() =>
            onStart({
              mode: 'local',
              mapId: WEEKLY_CHALLENGE_MAP,
              botCount: WEEKLY_CHALLENGE_BOTS,
              difficulty: WEEKLY_CHALLENGE_DIFFICULTY,
              gameMode: WEEKLY_CHALLENGE_MODE,
              challenge: true,
            })
          }
          onClose={() => setWeeklyOpen(false)}
        />
      )}
      {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={onChangeSettings}
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {roadOpen && (
        <CareerRoad
          profile={lobbyProfile}
          guest={!account}
          reduced={settings.reducedEffects}
          lowSpec={settings.lowSpec}
          loadout={roadLoadout}
          onClose={() => setRoadOpen(false)}
          onLogin={() => {
            setRoadOpen(false);
            onOpenLogin();
          }}
        />
      )}
      {lockerOpen && (
        <Locker
          settings={settings}
          onChange={onChangeSettings}
          account={account}
          onClose={() => {
            setLockerOpen(false);
            setRefreshTick((t) => t + 1); // buys/cases changed credits
          }}
        />
      )}
    </div>
  );
}

// (DeckButton / UtilButton — the angular action buttons — live in src/deck.tsx
// so the login sheet and the landing page's feedback form share them.)

// Compact mode badge — color-coded by mode for quick scanning in lobby rows.
function ModeBadge({ mode }: { mode: GameMode }) {
  const color =
    mode === 'tdm' ? 'border-sky-300/40 bg-sky-300/15 text-sky-200' :
    mode === 'duel' ? 'border-fuchsia-300/40 bg-fuchsia-300/15 text-fuchsia-200' :
    'border-emerald-300/40 bg-emerald-300/15 text-emerald-200';
  const short = mode === 'tdm' ? 'TDM' : mode === 'duel' ? '1v1' : 'FFA';
  return <span className={`deck-chip ${color}`}>{short}</span>;
}

function ServerStatusChip({ status }: { status: LobbyStatus }) {
  const map = {
    open: { dot: 'bg-emerald-400', ring: 'border-emerald-400/40 text-emerald-200', t: 'Online', title: 'Connected — online play available' },
    connecting: { dot: 'bg-amber-400', ring: 'border-amber-400/40 text-amber-200', t: 'Linking', title: 'Connecting to the match server…' },
    closed: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
    error: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
  } as const;
  const s = map[status];
  return (
    <span
      title={s.title}
      className={`clip-deck-sm inline-flex items-center gap-1.5 border px-2.5 py-1 font-display text-[12px] font-bold uppercase tracking-[0.1em] ${s.ring}`}
    >
      <span className={`deck-pulse h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.t}
    </span>
  );
}

function OpenLobbies({
  rooms,
  online,
  onJoin,
  onSpectate,
  onRefresh,
}: {
  rooms: LobbyRoom[];
  online: boolean;
  onJoin: (r: LobbyRoom) => void;
  onSpectate: (r: LobbyRoom) => void;
  onRefresh: () => void;
}) {
  // Body of the menu's social dock (the dock supplies the frame + tabs).
  return (
    <>
      <div className='flex shrink-0 items-center justify-between px-4 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40'>
        <span>{online ? `${rooms.length} open ${rooms.length === 1 ? 'lobby' : 'lobbies'}` : 'Linking to server…'}</span>
        <button
          type='button'
          onClick={onRefresh}
          disabled={!online}
          {...sfxProps('uiClick')}
          className='text-cyan-300/70 transition hover:text-cyan-200 disabled:opacity-40'
        >
          Refresh
        </button>
      </div>
      <div className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1'>
        {!online ? (
          <div className='flex h-full items-center justify-center px-4 py-10 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/30'>
            Linking to server…
          </div>
        ) : rooms.length === 0 ? (
          <div className='flex h-full flex-col items-center justify-center gap-1 px-6 py-10 text-center'>
            <span className='font-display text-sm font-semibold uppercase tracking-[0.14em] text-white/55'>No open lobbies</span>
            <span className='text-[12px] text-white/35'>Hit Play to start one, or create a match.</span>
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {rooms.map((r) => (
              <div
                key={r.id}
                className='clip-deck-sm flex items-center justify-between gap-3 border border-white/8 bg-white/[0.03] px-3 py-2.5 transition hover:border-cyan-300/30 hover:bg-white/[0.06]'
              >
                <div className='min-w-0'>
                  <div className='truncate font-display text-[13px] font-semibold text-white'>{r.name}</div>
                  <div className='mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-white/45'>
                    <ModeBadge mode={r.mode} />
                    <span>{mapLabel(r.mapId)}</span>
                    <span className='text-white/20'>·</span>
                    <span className='tabular-nums text-white/70'>
                      {r.players}/{r.capacity}
                    </span>
                    {r.state === 'voting' && (
                      <span className='deck-chip border-cyan-300/40 bg-cyan-300/15 text-cyan-200'>voting</span>
                    )}
                    {r.spectators > 0 && (
                      <span className='deck-chip text-white/60'>{r.spectators} watching</span>
                    )}
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  {/* Watch is always available for live matches — the whole point
                      is that a FULL match is still watchable. */}
                  <DeckButton onClick={() => onSpectate(r)} title='Spectate this match' size='sm' center>
                    Watch
                  </DeckButton>
                  <DeckButton onClick={() => onJoin(r)} disabled={!r.joinable} solid accent='emerald' size='sm' center>
                    {r.joinable ? 'Join' : 'Full'}
                  </DeckButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// "Who's online" tab of the social dock. Registered players are listed by name
// (with staff/verified badges + an in-match dot); guests are shown only as an
// aggregate count (never named — they're anonymous and a name list would be a
// slur vector). All values are server-authoritative.
function OnlinePlayersPanel({
  presence,
  youName,
}: {
  presence: PresenceState | null;
  youName: string | null;
}) {
  const players: PresencePlayer[] = presence?.players ?? [];
  const guests = presence?.guests ?? 0;
  return (
    <div className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3'>
      <div className='mb-2 flex items-center gap-2 px-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40'>
        <span className='deck-pulse h-1.5 w-1.5 rounded-full bg-emerald-400' />
        {presence ? `${presence.online} online` : 'Linking…'}
      </div>
      {players.length === 0 && guests === 0 ? (
        <div className='px-1 py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-white/30'>
          No one online
        </div>
      ) : (
        <div className='flex flex-col gap-0.5'>
          {players.map((p) => {
            const you = !!youName && p.name === youName;
            return (
              <div
                key={p.name}
                className={`flex items-center gap-1.5 px-1.5 py-1 text-[12px] ${you ? 'text-cyan-100' : 'text-white/85'}`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.inMatch ? 'bg-amber-400' : 'bg-emerald-400/70'}`}
                  title={p.inMatch ? 'In a match' : 'In the menu'}
                />
                <span className='truncate'>{p.name}</span>
                <NameBadges admin={p.admin} verified={p.verified} size={11} />
                {you && (
                  <span className='ml-0.5 shrink-0 text-[9px] uppercase tracking-[0.1em] text-cyan-300/80'>
                    you
                  </span>
                )}
              </div>
            );
          })}
          {guests > 0 && (
            <div className='mt-1 border-t border-white/8 px-1.5 pt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/40'>
              + {guests} {guests === 1 ? 'guest' : 'guests'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Live global chat (one room) — the social dock's Chat tab. Identity + content
// are server-authoritative and server-moderated (sanitized, length-capped,
// profanity-filtered, rate-limited); we render names/text as React text nodes,
// so they're escaped — no raw HTML.
function GlobalChatPanel({
  messages,
  online,
  canChat,
  youName,
  onSend,
}: {
  messages: ChatMessage[];
  online: boolean;
  canChat: boolean; // false for guests — they can read but not send
  youName: string | null;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stick to the newest message as the log grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const canSend = online && canChat;
  const submit = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    onSend(text.slice(0, CHAT_CLIENT_MAX_LEN));
    setDraft('');
  };

  return (
    <>
      <div ref={scrollRef} className='deck-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3'>
        {messages.length === 0 ? (
          <div className='flex h-full items-center justify-center px-6 py-8 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/30'>
            {online ? 'No messages yet — say hi.' : 'Linking to server…'}
          </div>
        ) : (
          <div className='flex flex-col gap-1'>
            {messages.map((m) => {
              const mine = !!youName && !m.guest && m.name === youName;
              return (
                <div key={m.id} className='text-[12px] leading-snug'>
                  <span
                    className={`mr-1 inline-flex items-center gap-0.5 font-semibold ${
                      m.guest ? 'text-white/45' : mine ? 'text-cyan-200' : 'text-cyan-300/90'
                    }`}
                  >
                    {m.name}
                    <NameBadges admin={m.admin} verified={m.verified} size={11} />
                    <span className='text-white/30'>:</span>
                  </span>
                  <span className='break-words text-white/85'>{m.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className='flex shrink-0 items-center gap-2 border-t border-white/10 p-2'>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={CHAT_CLIENT_MAX_LEN}
          disabled={!canSend}
          aria-label='Chat message'
          placeholder={!online ? 'Offline' : !canChat ? 'Log in to chat' : 'Message everyone…'}
          className='min-w-0 flex-1 bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-white outline-none transition placeholder:text-white/30 focus:bg-white/[0.07] disabled:opacity-40'
        />
        <DeckButton
          onClick={submit}
          disabled={!canSend || draft.trim().length === 0}
          solid
          accent='cyan'
          size='sm'
          center
          className='shrink-0'
          sound='uiClick'
        >
          Send
        </DeckButton>
      </div>
    </>
  );
}

function InviteModal({
  roomId,
  onEnter,
  onClose,
}: {
  roomId: string;
  onEnter: () => void;
  onClose: () => void;
}) {
  const link = inviteLink(roomId);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Copied invite link', { tone: 'ok' });
    } catch {
      // Clipboard API blocked (insecure context / permission) — select the
      // field so the user can copy manually instead of a silent no-op (#26c).
      inputRef.current?.select();
      toast('Link selected — press Ctrl/⌘+C to copy', { tone: 'warn' });
    }
  };
  return (
    <ModalShell title='Private Match' tone='emerald' onClose={onClose}>
      <p className='font-sans text-sm text-white/60'>
        Share this link with friends — it drops them straight into your lobby.
      </p>
      <div>
        <div className='flex items-center gap-2'>
          <input
            ref={inputRef}
            readOnly
            value={link}
            aria-label='Invite link'
            onFocus={(e) => e.currentTarget.select()}
            className='deck-input deck-input-sm min-w-0 flex-1'
          />
          <UtilButton onClick={copy} tone='cyan' sound='none' className='shrink-0'>
            Copy
          </UtilButton>
        </div>
        <div className='mt-2 text-[10px] uppercase tracking-[0.16em] text-white/40'>
          Lobby code: <span className='text-white/80'>{roomId}</span>
        </div>
      </div>
      <DeckButton onClick={onEnter} solid accent='emerald' full center>
        Enter Match
      </DeckButton>
    </ModalShell>
  );
}

function CreateOnlineModal({
  settings,
  mode,
  onChangeSettings,
  onChangeMode,
  onClose,
  onCreate,
}: {
  settings: Settings;
  mode: GameMode;
  onChangeSettings: (s: Settings) => void;
  onChangeMode: (m: GameMode) => void;
  onClose: () => void;
  onCreate: (opts: { mapId: string; isPublic: boolean; capacity: number; mode: GameMode }) => void;
}) {
  const [players, setPlayers] = useState(MAX_PLAYERS);
  const [mapId, setMapId] = useState(settings.mapId);
  const [isPublic, setIsPublic] = useState(true);

  // Online play has no bots — restrict to the human-friendly online pool.
  const onlineMaps = MAPS.filter((m) => ONLINE_MAP_IDS.includes(m.id));

  // Duel is always 1v1 — force the capacity to 2 regardless of the slider.
  const isDuel = mode === 'duel';
  const capacity = isDuel ? 2 : players;

  const create = () => {
    onChangeSettings({ ...settings, mapId });
    onCreate({ mapId, isPublic, capacity, mode });
  };

  return (
    <ModalShell title='Create Match' onClose={onClose}>
      <ButtonGroup
        label='Game mode'
        value={mode}
        options={GAME_MODES.map((m) => ({ id: m.id, label: m.label }))}
        onChange={(v) => onChangeMode(v)}
      />
      <SelectField label='Arena' value={mapId} options={onlineMaps} onChange={setMapId} />
      {isDuel ? (
        <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/65'>
          <span>Players</span>
          <span className='tabular-nums text-white/85'>1v1 (2 players)</span>
        </div>
      ) : (
        <label className='flex flex-col gap-1.5'>
          <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/65'>
            <span>Max players</span>
            <span className='tabular-nums text-white/85'>{players}</span>
          </div>
          <input
            type='range'
            min={2}
            max={MAX_PLAYERS}
            step={1}
            value={players}
            onChange={(e) => setPlayers(Number(e.target.value))}
            className='deck-range'
          />
        </label>
      )}
      <ButtonGroup
        label='Visibility'
        value={isPublic ? 'public' : 'private'}
        options={[
          { id: 'public', label: 'Public (Custom Lobby)' },
          { id: 'private', label: 'Private (Invite only)' },
        ]}
        onChange={(v) => setIsPublic(v === 'public')}
      />
      <div className='-mt-3 text-[10px] normal-case tracking-normal text-white/40'>
        {isPublic
          ? 'Public matches appear in Open Lobbies for anyone to join.'
          : 'Private matches are invite-only — you’ll get a link to share.'}
      </div>
      <DeckButton onClick={create} solid accent='emerald' full center>
        {isPublic ? 'Create & Play' : 'Create & Get Link'}
      </DeckButton>
    </ModalShell>
  );
}

// (ModalShell — the shared dialog frame with Escape/backdrop close, exit motion,
// focus trap + restore, and the modal stack — lives in src/deck.tsx.)

function CreateMatchModal({
  settings,
  onChangeSettings,
  onClose,
  onStart,
}: {
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onClose: () => void;
  onStart: (config: MatchConfig) => void;
}) {
  const [players, setPlayers] = useState(MAX_PLAYERS);
  const [mapId, setMapId] = useState(settings.mapId);
  const [difficulty, setDifficulty] = useState<BotDifficulty>(settings.difficulty);
  const [gameMode, setGameMode] = useState<GameMode>('ffa');

  // Duel is always 1v1 (1 bot); FFA/TDM use the slider.
  const effPlayers = gameMode === 'duel' ? 2 : players;

  const start = () => {
    onChangeSettings({ ...settings, mapId, difficulty });
    onStart({
      mode: 'local',
      mapId,
      botCount: Math.max(1, effPlayers - 1),
      difficulty,
      gameMode,
    });
  };

  return (
    <ModalShell title='Solo vs Bots' tone='amber' onClose={onClose}>
      <SelectField label='Arena' value={mapId} options={MAPS} onChange={setMapId} />
      <div className='flex flex-col gap-1.5'>
        <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>Mode</span>
        <div className='grid grid-cols-3 gap-2'>
          {GAME_MODES.map((m) => (
            <SegButton key={m.id} active={gameMode === m.id} onClick={() => setGameMode(m.id)} title={m.blurb}>
              {m.id === 'ffa' ? 'FFA' : m.id === 'tdm' ? 'TDM' : 'Duel'}
            </SegButton>
          ))}
        </div>
      </div>
      <label className={`flex flex-col gap-1.5 ${gameMode === 'duel' ? 'opacity-40' : ''}`}>
        <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/65'>
          <span>Players</span>
          <span className='tabular-nums text-white/85'>
            {gameMode === 'duel'
              ? '2 (1 bot · 1v1)'
              : `${effPlayers} (${effPlayers - 1} ${effPlayers - 1 === 1 ? 'bot' : 'bots'}${gameMode === 'tdm' ? ' · 2 teams' : ''})`}
          </span>
        </div>
        <input
          type='range'
          min={2}
          max={MAX_PLAYERS}
          step={1}
          value={effPlayers}
          disabled={gameMode === 'duel'}
          onChange={(e) => setPlayers(Number(e.target.value))}
          className='deck-range'
        />
      </label>
      <DifficultyPicker value={difficulty} onChange={setDifficulty} />
      <DeckButton onClick={start} solid accent='emerald' full center>
        Start Match
      </DeckButton>
    </ModalShell>
  );
}

function DifficultyPicker({
  value,
  onChange,
}: {
  value: BotDifficulty;
  onChange: (d: BotDifficulty) => void;
}) {
  const opts: BotDifficulty[] = ['easy', 'medium', 'hard'];
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>Bot difficulty</span>
      <div className='grid grid-cols-3 gap-2'>
        {opts.map((o) => (
          <SegButton key={o} active={value === o} onClick={() => onChange(o)}>
            {o}
          </SegButton>
        ))}
      </div>
    </div>
  );
}

function StatsModal({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState<InstagibProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile unavailable'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active) return;
        setProfile(d.profile ?? null);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  const stats = profile?.stats ?? null;
  const kd =
    stats && stats.totalDeaths > 0
      ? (stats.totalKills / stats.totalDeaths).toFixed(2)
      : String(stats?.totalKills ?? 0);
  const xpPct =
    profile && profile.xpForNext > 0
      ? Math.min(100, Math.round((profile.xpIntoLevel / profile.xpForNext) * 100))
      : 100;

  return (
    <ModalShell title='Your Profile' onClose={onClose} bodyClassName='gap-4'>
      {state === 'loading' && (
        <div className='flex flex-col gap-4' aria-busy='true' aria-label='Loading profile'>
          <div className='clip-deck-sm flex items-center gap-4 border border-white/10 bg-white/[0.02] p-4'>
            <Skeleton className='h-16 w-16 shrink-0' />
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between'>
                <Skeleton className='h-3 w-20' />
                <Skeleton className='h-3 w-24' />
              </div>
              <Skeleton className='mt-2 h-2.5 w-full' />
              <Skeleton className='mt-2 h-2.5 w-2/5' />
            </div>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className='deck-card px-4 py-3'>
                <Skeleton className='h-2.5 w-16' />
                <Skeleton className='mt-2.5 h-6 w-12' />
              </div>
            ))}
          </div>
        </div>
      )}
      {state === 'error' && (
        <div className='font-sans text-sm text-white/55'>
          Couldn&apos;t load your profile. Finish a match to start tracking.
        </div>
      )}
      {state === 'ready' && profile && stats && (
        <>
          {/* Level tile + XP bar + credits — the one accented block. */}
          <div className='clip-deck-sm flex items-center gap-4 border border-cyan-400/25 bg-cyan-300/[0.04] p-4'>
            <div className='clip-deck-sm flex h-16 w-16 shrink-0 flex-col items-center justify-center border-2 border-cyan-400/60 bg-cyan-300/10'>
              <div className='text-[8px] uppercase tracking-[0.18em] text-cyan-200/70'>Level</div>
              <div className='font-display text-2xl font-bold leading-none text-cyan-100'>{profile.level}</div>
            </div>
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between text-[11px]'>
                <span className='uppercase tracking-[0.16em] text-white/50'>
                  {profile.xpForNext > 0 ? 'Next level' : 'Max level'}
                </span>
                <span className='font-semibold tabular-nums text-amber-300'>{profile.credits} ⛁ credits</span>
              </div>
              <div className='deck-bar mt-1.5 h-2.5'>
                <div className='bg-gradient-to-r from-cyan-400 to-sky-300' style={{ width: `${xpPct}%` }} />
              </div>
              <div className='mt-1 text-[10px] tabular-nums text-white/40'>
                {profile.xpForNext > 0
                  ? `${profile.xpIntoLevel} / ${profile.xpForNext} XP · ${profile.totalXp} total`
                  : `${profile.totalXp} XP total`}
              </div>
            </div>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <BigStat label='Kills' value={stats.totalKills} />
            <BigStat label='Deaths' value={stats.totalDeaths} />
            <BigStat label='K / D' value={kd} />
            <BigStat label='Wins' value={`${stats.totalWins} / ${stats.totalGames}`} />
            <BigStat label='Best streak' value={stats.bestKillStreak} />
            <BigStat label='Headshots' value={stats.headshots} />
          </div>
        </>
      )}
    </ModalShell>
  );
}

function BigStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className='deck-card px-4 py-3'>
      <div className='deck-label'>{label}</div>
      <div className='mt-1 font-display text-2xl font-bold tabular-nums text-cyan-200'>{value}</div>
    </div>
  );
}

/* ───────────────────────── Global leaderboard modal ───────────────────────── */

type LeaderboardSort = 'kills' | 'wins' | 'accuracy';

type LeaderboardEntry = {
  id: string;
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number;
  admin?: boolean;
  verified?: boolean;
};

type LeaderboardYou = { rank: number; entry: LeaderboardEntry } | null;

const LEADERBOARD_SORTS: ReadonlyArray<{ id: LeaderboardSort; label: string }> = [
  { id: 'kills', label: 'Kills' },
  { id: 'wins', label: 'Wins' },
  { id: 'accuracy', label: 'Accuracy' },
];

type LeaderboardWindow = 'all' | 'weekly' | 'daily' | 'ranked';
const LEADERBOARD_WINDOWS: ReadonlyArray<{ id: LeaderboardWindow; label: string }> = [
  { id: 'all', label: 'All-time' },
  { id: 'weekly', label: 'This week' },
  { id: 'daily', label: 'Today' },
  { id: 'ranked', label: 'Ranked' },
];

function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const [sort, setSort] = useState<LeaderboardSort>('kills');
  const [window, setWindow] = useState<LeaderboardWindow>('all');
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [you, setYou] = useState<LeaderboardYou>(null);
  const [rankedRows, setRankedRows] = useState<RankedLeaderEntry[]>([]);
  const [rankedMe, setRankedMe] = useState<RankedProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const isRanked = window === 'ranked';

  useEffect(() => {
    let active = true;
    setState('loading');
    if (window === 'ranked') {
      fetch('/api/ranked/leaderboard', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ranked unavailable'))))
        .then((d: { entries?: RankedLeaderEntry[]; me?: RankedProfile | null }) => {
          if (!active) return;
          setRankedRows(Array.isArray(d.entries) ? d.entries : []);
          setRankedMe(d.me ?? null);
          setState('ready');
        })
        .catch(() => {
          if (active) setState('error');
        });
      return () => {
        active = false;
      };
    }
    fetch(`/api/leaderboard?sort=${sort}&window=${window}&limit=25`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('leaderboard unavailable'))))
      .then((d: { leaderboard?: LeaderboardEntry[]; you?: LeaderboardYou }) => {
        if (!active) return;
        setRows(Array.isArray(d.leaderboard) ? d.leaderboard : []);
        setYou(d.you ?? null);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [sort, window]);

  const youId = you?.entry.id;
  // Is the local player already visible in the top-N? If not, we pin them below.
  const youInTop = youId != null && rows.some((r) => r.id === youId);
  const rankedMeInTop = rankedMe != null && rankedRows.some((r) => r.id === rankedMe.id);

  return (
    <ModalShell title='Leaderboard' size='lg' onClose={onClose}>
      <ButtonGroup label='Window' value={window} options={LEADERBOARD_WINDOWS} onChange={setWindow} />
      {!isRanked && (
        <ButtonGroup label='Sort by' value={sort} options={LEADERBOARD_SORTS} onChange={setSort} />
      )}
      {state === 'loading' && (
        <div aria-busy='true' aria-label='Loading leaderboard'>
          <TableSkeleton rows={8} />
        </div>
      )}
      {state === 'error' && isRanked && (
        <div className='font-sans text-sm text-white/55'>Couldn&apos;t load the ranked ladder.</div>
      )}
      {state === 'ready' && isRanked && rankedRows.length === 0 && (
        <div className='font-sans text-sm text-white/55'>No ranked players yet — queue a Ranked Duel to appear here.</div>
      )}
      {state === 'ready' && isRanked && rankedRows.length > 0 && (
        <div className='deck-scroll -mx-2 max-h-[52vh] overflow-y-auto px-1'>
          <div className='grid grid-cols-[1.75rem_1fr_4.5rem_3.5rem_3rem] gap-x-3 text-[12px]'>
            <div className='col-span-5 grid grid-cols-subgrid gap-x-3 px-1'>
              <Th align='right'>#</Th>
              <Th>Player</Th>
              <Th align='right'>Rating</Th>
              <Th>Tier</Th>
              <Th align='right'>W-L</Th>
            </div>
            {rankedRows.map((row, i) => (
              <RankedLeaderRow key={row.id} rank={i + 1} row={row} you={row.id === rankedMe?.id} />
            ))}
            {rankedMe && rankedMe.rank > 0 && !rankedMeInTop && (
              <>
                <div className='col-span-5 my-1 border-t border-dashed border-white/15' />
                <RankedLeaderRow
                  rank={rankedMe.rank}
                  row={{
                    id: rankedMe.id,
                    userName: rankedMe.userName,
                    rating: rankedMe.rating,
                    games: rankedMe.games,
                    wins: rankedMe.wins,
                    losses: rankedMe.losses,
                    streak: rankedMe.streak,
                    admin: false,
                    verified: false,
                  }}
                  you
                />
              </>
            )}
          </div>
        </div>
      )}
      {state === 'error' && !isRanked && (
        <div className='font-sans text-sm text-white/55'>Couldn&apos;t load the leaderboard. Try again later.</div>
      )}
      {state === 'ready' && !isRanked && rows.length === 0 && (
        <div className='font-sans text-sm text-white/55'>No ranked players yet — finish a match to appear here.</div>
      )}
      {state === 'ready' && !isRanked && rows.length > 0 && (
        <div className='deck-scroll -mx-2 max-h-[52vh] overflow-y-auto px-1'>
          <div className='grid grid-cols-[1.75rem_1fr_2.75rem_2.75rem_2.5rem_3rem] gap-x-3 text-[12px]'>
            <div className='col-span-6 grid grid-cols-subgrid gap-x-3 px-1'>
              <Th align='right'>#</Th>
              <Th>Player</Th>
              <Th align='right'>K</Th>
              <Th align='right'>K/D</Th>
              <Th align='right'>W</Th>
              <Th align='right'>Acc</Th>
            </div>
            {rows.map((row, i) => (
              <LeaderboardRow key={row.id || `${row.userName}-${i}`} rank={i + 1} row={row} you={row.id === youId} />
            ))}
            {/* Pin the local player below the top-N if they didn't make the cut. */}
            {you && you.rank > 0 && !youInTop && (
              <>
                <div className='col-span-6 my-1 border-t border-dashed border-white/15' />
                <LeaderboardRow rank={you.rank} row={you.entry} you />
              </>
            )}
          </div>
          {sort === 'accuracy' && (
            <div className='mt-3 text-[10px] text-white/40'>
              Accuracy board needs at least 5 games played.
            </div>
          )}
          {you && you.rank === 0 && sort === 'accuracy' && (
            <div className='mt-1 text-[10px] text-amber-200/70'>
              Play {5 - you.entry.totalGames} more game{5 - you.entry.totalGames === 1 ? '' : 's'} to rank on accuracy.
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// One leaderboard row: a subgrid row div so the hairline / hover / "you" tint
// spans the whole line, cells inheriting the parent grid's columns.
function LeaderboardRow({ rank, row, you = false }: { rank: number; row: LeaderboardEntry; you?: boolean }) {
  const medal =
    rank === 1 ? 'text-amber-300' : rank === 2 ? 'text-zinc-300' : rank === 3 ? 'text-orange-300' : 'text-white/45';
  return (
    <div className={`deck-tr col-span-6 grid grid-cols-subgrid gap-x-3 px-1 ${you ? 'deck-tr-you text-cyan-100' : 'text-white/90'}`}>
      <div className={`py-1.5 text-right tabular-nums font-bold ${you ? 'text-cyan-200' : medal}`}>{rank}</div>
      <div className='flex min-w-0 items-center gap-1 py-1.5'>
        <span className='truncate'>{row.userName}</span>
        <NameBadges admin={row.admin} verified={row.verified} size={12} />
        {you && <span className='ml-1 shrink-0 text-[10px] uppercase tracking-[0.1em] text-cyan-300/80'>you</span>}
      </div>
      <div className={`py-1.5 text-right tabular-nums ${you ? 'text-cyan-100' : ''}`}>{row.totalKills}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.kd.toFixed(2)}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.totalWins}</div>
      <div className='py-1.5 text-right tabular-nums text-cyan-200/80'>{row.bestAccuracy.toFixed(1)}%</div>
    </div>
  );
}

// A row on the Ranked (Elo) ladder: rank, player, rating, tier, W-L.
function RankedLeaderRow({ rank, row, you = false }: { rank: number; row: RankedLeaderEntry; you?: boolean }) {
  const medal =
    rank === 1 ? 'text-amber-300' : rank === 2 ? 'text-zinc-300' : rank === 3 ? 'text-orange-300' : 'text-white/45';
  const tier = rankedTier(row.rating);
  return (
    <div className={`deck-tr col-span-5 grid grid-cols-subgrid gap-x-3 px-1 ${you ? 'deck-tr-you text-cyan-100' : 'text-white/90'}`}>
      <div className={`py-1.5 text-right tabular-nums font-bold ${you ? 'text-cyan-200' : medal}`}>{rank}</div>
      <div className='flex min-w-0 items-center gap-1 py-1.5'>
        <span className='truncate'>{row.userName}</span>
        <NameBadges admin={row.admin} verified={row.verified} size={12} />
        {you && <span className='ml-1 shrink-0 text-[10px] uppercase tracking-[0.1em] text-cyan-300/80'>you</span>}
      </div>
      <div className='py-1.5 text-right font-bold tabular-nums' style={{ color: tier.color }}>{row.rating}</div>
      <div className='py-1.5 text-[11px] uppercase tracking-[0.08em]' style={{ color: tier.color }}>{tier.name}</div>
      <div className='py-1.5 text-right tabular-nums text-white/55'>
        {row.wins}-{row.losses}
      </div>
    </div>
  );
}

/* ───────────────────────── Admin / moderation modal ───────────────────────── */

type AdminLookup = { username: string; admin: boolean; verified: boolean };
type AuditEntry = {
  id: number;
  ts: number;
  event: string;
  actor_name: string;
  detail: string;
};

async function adminPost(path: string, body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/admin/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    return { ok: false, error: (d as { error?: string }).error ?? `http_${r.status}` };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// Admins-only panel: look a player up by name, toggle their verified check or
// admin role, and scan the recent audit feed. Server enforces admin on every
// call (403 otherwise) — this UI only ever shows for is_admin accounts.
function AdminModal({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<AdminLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const refreshAudit = useCallback(() => {
    fetch('/api/admin/audit?limit=25', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('audit'))))
      .then((d: { events?: AuditEntry[] }) => setAudit(Array.isArray(d.events) ? d.events : []))
      .catch(() => setAudit([]));
  }, []);
  useEffect(() => {
    refreshAudit();
  }, [refreshAudit]);

  const lookup = useCallback(async (name: string) => {
    const q = name.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/lookup?username=${encodeURIComponent(q)}`, {
        credentials: 'same-origin',
      });
      if (r.ok) {
        setTarget((await r.json()) as AdminLookup);
      } else {
        setTarget(null);
        toast(r.status === 404 ? `No player named “${q}”.` : 'Lookup failed.', { tone: 'err' });
      }
    } catch {
      toast('Network error.', { tone: 'err' });
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback(
    async (path: 'verify' | 'grant', body: object, label: string) => {
      if (!target) return;
      setBusy(true);
      const r = await adminPost(path, { username: target.username, ...body });
      setBusy(false);
      if (r.ok) {
        toast(label, { tone: 'ok' });
        await lookup(target.username);
        refreshAudit();
      } else {
        toast(r.error === 'forbidden' ? 'Not authorized.' : `Failed (${r.error}).`, { tone: 'err' });
      }
    },
    [target, lookup, refreshAudit],
  );

  return (
    <ModalShell title='Admin' tone='amber' onClose={onClose}>
      <div className='flex flex-col gap-3'>
        <a
          href='/admin'
          {...sfxProps('uiClick')}
          className='clip-deck-sm flex items-center justify-between border border-cyan-400/40 bg-cyan-400/10 px-3.5 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-400/15'
        >
          <span>Metrics dashboard</span>
          <span className='font-mono text-[10px] font-medium tracking-[0.16em] text-cyan-200/60'>Open</span>
        </a>
        <div className='flex gap-2'>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup(username)}
            placeholder='Player username'
            aria-label='Player username'
            maxLength={20}
            className='deck-input min-w-0 flex-1'
          />
          <UtilButton onClick={() => lookup(username)} disabled={busy || !username.trim()} tone='cyan' className='shrink-0'>
            Look up
          </UtilButton>
        </div>

        {target && (
          <div className='border border-white/10 bg-black/30 p-3'>
            <div className='flex items-center gap-2 font-display text-sm font-bold text-white'>
              {target.username}
              <NameBadges admin={target.admin} verified={target.verified} size={13} />
            </div>
            <div className='mt-1 text-[11px] uppercase tracking-[0.14em] text-white/45'>
              {target.admin ? 'Admin' : 'Player'} · {target.verified ? 'Verified' : 'Not verified'}
            </div>
            <div className='mt-3 grid grid-cols-2 gap-2'>
              <DeckButton
                onClick={() => act('verify', { verified: !target.verified }, target.verified ? 'Unverified.' : 'Verified ✓')}
                disabled={busy}
                accent='cyan'
                size='sm'
                center
              >
                {target.verified ? 'Remove verify' : 'Verify ✓'}
              </DeckButton>
              <DeckButton
                onClick={() => act('grant', { admin: !target.admin }, target.admin ? 'Admin revoked.' : 'Admin granted.')}
                disabled={busy}
                accent='amber'
                size='sm'
                center
              >
                {target.admin ? 'Revoke admin' : 'Make admin'}
              </DeckButton>
            </div>
          </div>
        )}

        <div className='mt-1'>
          <div className='deck-label mb-1.5'>Recent activity</div>
          <div className='deck-scroll max-h-[34vh] space-y-1 overflow-y-auto text-[11px]'>
            {audit.length === 0 && <div className='text-white/40'>No events yet.</div>}
            {audit.map((e) => (
              <div key={e.id} className='flex items-baseline gap-2 border-b border-white/5 pb-1'>
                <span className='shrink-0 text-white/35'>{formatAuditTime(e.ts)}</span>
                <span className='shrink-0 font-semibold text-cyan-200/80'>{e.event}</span>
                <span className='truncate text-white/55'>
                  {e.actor_name}
                  {e.detail ? ` · ${e.detail}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function formatAuditTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/* ───────────────────────── Settings modal ───────────────────────── */

type SettingsTab =
  | 'controls'
  | 'crosshair'
  | 'video'
  | 'audio'
  | 'accessibility'
  | 'profile';

// `keywords` powers the settings search (matched alongside the label). The
// Locker is now its own modal (a lobby button), no longer a settings tab.
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; keywords: string }> = [
  { id: 'controls', label: 'Controls', keywords: 'sensitivity sens mouse dpi raw input fov zoom ads aim keybind bind move jump dash strafe vertical' },
  { id: 'crosshair', label: 'Crosshair', keywords: 'crosshair reticle dot cross circle color outline gap size thickness preset share' },
  { id: 'video', label: 'Video', keywords: 'fps framerate frame rate vsync unlimited resolution quality low spec performance ui scale hud viewmodel weapon offset motion bob sway map brightness tint shadows shadow bloom glow smaa aa anti-aliasing antialiasing vignette post processing effects particles ping' },
  { id: 'audio', label: 'Audio', keywords: 'audio volume sound sfx announcer master mute captions ui click menu sounds interface' },
  { id: 'accessibility', label: 'Access.', keywords: 'accessibility reduced effects shake flash motion bright enemies colorblind visibility' },
  { id: 'profile', label: 'Profile', keywords: 'profile name player server url lan import export share code backup' },
];

function filterTabs(query: string): typeof SETTINGS_TABS {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_TABS;
  return SETTINGS_TABS.filter((t) => `${t.label} ${t.keywords}`.toLowerCase().includes(q));
}

function SettingsModal({
  settings,
  onChange,
  onClose,
  initialTab = 'controls',
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const ch = settings.crosshair;
  const setCh = (patch: Partial<CrosshairConfig>) =>
    onChange({ ...settings, crosshair: { ...ch, ...patch } });
  // Your name is your identity (account username, or "Guest" — set by the auth
  // effect in the parent), and is server-authoritative, so the field is shown
  // read-only. Guests can't pick a name; in matches they appear as "Guest N".
  const isGuestName = !settings.playerName || settings.playerName === 'Guest';
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [search, setSearch] = useState('');
  const visibleTabs = filterTabs(search);
  const onSearch = (q: string) => {
    setSearch(q);
    const m = filterTabs(q);
    if (m.length && !m.some((t) => t.id === tab)) setTab(m[0].id);
  };
  // Settings save continuously; "Done" only confirms (toast) if anything
  // actually changed while the sheet was open.
  const openedWith = useRef(settings);
  return (
    <ModalShell
      title='Settings'
      onClose={onClose}
      width='w-[520px]'
      actions={
        <TextButton onClick={() => setFeedbackOpen(true)} className='text-cyan-300/70 hover:text-cyan-200'>
          Feedback
        </TextButton>
      }
      header={
        <div className='flex flex-col gap-2'>
          <input
            type='search'
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder='Search settings…'
            aria-label='Search settings'
            className='deck-input deck-input-sm'
          />
          {/* Tab bar — sits flush on the header's bottom rule so the active
              tab's hairline reads as part of it. */}
          <div role='tablist' aria-label='Settings sections' className='-mx-2 -mb-3 flex flex-wrap'>
            {visibleTabs.map((t) => (
              <DeckTab key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} data-tab={t.id}>
                {t.label}
              </DeckTab>
            ))}
          </div>
        </div>
      }
      footer={({ close }) => (
        <>
          <TextButton onClick={() => onChange(DEFAULT_SETTINGS)}>Reset to defaults</TextButton>
          <DeckButton
            onClick={() => {
              if (settings !== openedWith.current) toast('Settings saved', { tone: 'ok', sound: 'none' });
              close();
            }}
            solid
            accent='emerald'
            size='sm'
            center
          >
            Done
          </DeckButton>
        </>
      )}
      // Fixed-height scroll area so the sheet doesn't grow/shrink (and the
      // header jump) as you switch between short + tall tabs.
      bodyClassName='deck-scroll h-[58vh] overflow-y-auto'
    >
      {feedbackOpen && (
        <FeedbackModal
          onClose={() => setFeedbackOpen(false)}
          playerName={isGuestName ? undefined : settings.playerName}
        />
      )}
      <div className='flex flex-col gap-5' role='tabpanel'>
          {visibleTabs.length === 0 ? (
            <div className='font-sans text-sm text-white/55'>No settings match “{search.trim()}”.</div>
          ) : (
            <>
          {tab === 'controls' && (
            <>
              <MouseSettings settings={settings} onChange={onChange} />
              <KeybindsSection
                keybinds={settings.keybinds}
                onChange={(b) => onChange({ ...settings, keybinds: b })}
              />
              <SliderField
                label='Field of view'
                value={settings.fov}
                min={MIN_FOV}
                max={MAX_FOV}
                step={1}
                format={(v) => `${v.toFixed(0)}°`}
                onChange={(v) => onChange({ ...settings, fov: v })}
              />
              <SliderField
                label='Zoom FOV'
                value={settings.zoomFov}
                min={MIN_ZOOM_FOV}
                max={MAX_ZOOM_FOV}
                step={1}
                format={(v) => `${v.toFixed(0)}°`}
                onChange={(v) => onChange({ ...settings, zoomFov: v })}
              />
              <SliderField
                label='ADS / zoom sensitivity'
                value={settings.zoomSens}
                min={0.1}
                max={2}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                onChange={(v) => onChange({ ...settings, zoomSens: v })}
              />
              <div className='-mt-2 text-[10px] normal-case tracking-normal text-white/40'>
                Look speed while zoomed, multiplied on top of the FOV-scaled
                default. 1.00× keeps the standard feel; lower it for precise
                long-range flicks.
              </div>
            </>
          )}

          {tab === 'video' && (
            <>
              <ToggleField
                label='Show FPS'
                value={settings.showFps}
                onChange={(v) => onChange({ ...settings, showFps: v })}
              />
              <ToggleField
                label='Show ping on scoreboard'
                hint='Each player’s connection to the server, shown on the Tab scoreboard (online matches).'
                value={settings.showPing}
                onChange={(v) => onChange({ ...settings, showPing: v })}
              />
              <SelectField
                label='Frame rate limit'
                value={String(settings.fpsLimit)}
                options={[
                  { id: '0', label: 'VSync (display refresh)' },
                  { id: '240', label: '240 fps' },
                  { id: '144', label: '144 fps' },
                  { id: '120', label: '120 fps' },
                  { id: '60', label: '60 fps' },
                  { id: '-1', label: 'Unlimited (uncapped)' },
                ]}
                onChange={(v) => onChange({ ...settings, fpsLimit: Number(v) })}
              />
              <div className='-mt-2 text-[10px] normal-case tracking-normal text-white/40'>
                VSync matches your monitor (smoothest). Caps below it save power.
                “Unlimited” renders past your refresh rate for the lowest input
                latency — at much higher CPU/GPU use.
              </div>

              <Section label='Quality'>
                <SliderField
                  label='Resolution scale'
                  value={settings.resolutionScale}
                  min={0.5}
                  max={2}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, resolutionScale: v })}
                />
                <ToggleField
                  label='Low-spec mode'
                  value={settings.lowSpec}
                  onChange={(v) => onChange({ ...settings, lowSpec: v })}
                />
                <SliderField
                  label='UI scale'
                  value={settings.uiScale}
                  min={0.7}
                  max={1.5}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, uiScale: v })}
                />
                <div className='text-[10px] normal-case tracking-normal text-white/40'>
                  Lower resolution scale or Low-spec mode (caps high-DPI rendering
                  and thins particle effects) if the game runs hot. UI scale resizes
                  the in-match HUD.
                </div>
              </Section>

              <Section label='Post-processing'>
                <ToggleField
                  label='Bloom'
                  value={settings.bloom}
                  disabled={settings.lowSpec}
                  onChange={(v) => onChange({ ...settings, bloom: v })}
                />
                <SliderField
                  label='Bloom intensity'
                  value={settings.bloomIntensity ?? 0.8}
                  min={0}
                  max={1.5}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, bloomIntensity: v })}
                />
                <ToggleField
                  label='Shadows'
                  value={settings.shadows}
                  disabled={settings.lowSpec}
                  onChange={(v) => onChange({ ...settings, shadows: v })}
                />
                <ToggleField
                  label='Anti-aliasing'
                  value={settings.antialias}
                  disabled={settings.lowSpec}
                  onChange={(v) => onChange({ ...settings, antialias: v })}
                />
                <ToggleField
                  label='Vignette'
                  value={settings.vignette}
                  disabled={settings.lowSpec}
                  onChange={(v) => onChange({ ...settings, vignette: v })}
                />
                <div className='text-[10px] normal-case tracking-normal text-white/40'>
                  {settings.lowSpec
                    ? 'Off on low-spec. Turn off Low-spec mode to use these.'
                    : 'Bloom glows rail beams and lights, shadows ground the arena, anti-aliasing (SMAA) smooths edges, vignette darkens the screen corners. Each costs a little GPU.'}
                </div>
              </Section>

              <Section label='Weapon viewmodel'>
            <ToggleField
              label='Hide viewmodel'
              value={settings.hideViewmodel}
              onChange={(v) => onChange({ ...settings, hideViewmodel: v })}
            />
            {!settings.hideViewmodel && (
              <>
                <SliderField
                  label='Weapon motion'
                  value={settings.viewmodelMotion}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, viewmodelMotion: v })}
                />
                <SliderField
                  label='Offset X'
                  value={settings.viewmodelOffset.x}
                  min={MIN_VIEWMODEL_OFFSET}
                  max={MAX_VIEWMODEL_OFFSET}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) =>
                    onChange({ ...settings, viewmodelOffset: { ...settings.viewmodelOffset, x: v } })
                  }
                />
                <SliderField
                  label='Offset Y'
                  value={settings.viewmodelOffset.y}
                  min={MIN_VIEWMODEL_OFFSET}
                  max={MAX_VIEWMODEL_OFFSET}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) =>
                    onChange({ ...settings, viewmodelOffset: { ...settings.viewmodelOffset, y: v } })
                  }
                />
                <SliderField
                  label='Offset Z'
                  value={settings.viewmodelOffset.z}
                  min={MIN_VIEWMODEL_OFFSET}
                  max={MAX_VIEWMODEL_OFFSET}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) =>
                    onChange({ ...settings, viewmodelOffset: { ...settings.viewmodelOffset, z: v } })
                  }
                />
              </>
            )}
            <div className='text-[10px] normal-case tracking-normal text-white/40'>
              Weapon motion scales the bob, sway, and landing dip (0% holds the gun
              still; the fire kick always stays). The railgun sits low and to the side
              so it never blocks your aim. Bind “Zoom (hold)” under Keybinds to narrow
              your FOV.
            </div>
          </Section>

              <Section label='Map'>
                <ColorField
                  label='Map tint'
                  value={settings.worldColor}
                  onChange={(v) => onChange({ ...settings, worldColor: v })}
                />
                <SliderField
                  label='Map brightness'
                  value={settings.worldBrightness}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, worldBrightness: v })}
                />
              </Section>
            </>
          )}

          {tab === 'audio' && (
            <Section label='Audio'>
            <SliderField
              label='Master volume'
              value={settings.volume}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => onChange({ ...settings, volume: v })}
            />
            <SliderField
              label='SFX volume'
              value={settings.sfxVolume}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => onChange({ ...settings, sfxVolume: v })}
            />
            <ToggleField
              label='UI sounds'
              hint='Menu clicks, hovers, and toggles. Follows the master and SFX sliders.'
              value={settings.uiSounds}
              onChange={(v) => onChange({ ...settings, uiSounds: v })}
            />
            <ToggleField
              label='Announcer'
              value={settings.announcerEnabled}
              onChange={(v) => onChange({ ...settings, announcerEnabled: v })}
            />
            {settings.announcerEnabled && (
              <>
                <SliderField
                  label='Announcer volume'
                  value={settings.announcerVolume}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onChange({ ...settings, announcerVolume: v })}
                />
                <AnnouncerPackField
                  value={settings.announcerPack}
                  onChange={(v) => onChange({ ...settings, announcerPack: v })}
                />
              </>
            )}
            <ToggleField
              label='Announcer captions'
              hint='Show medal/match callouts as on-screen text (for deaf/HoH players). Callouts are also exposed to screen readers.'
              value={settings.captions}
              onChange={(v) => onChange({ ...settings, captions: v })}
            />
            </Section>
          )}

          {tab === 'crosshair' && (
            <Section label='Crosshair'>
            <div className='flex flex-col gap-1.5'>
              <span className='font-mono text-[10px] uppercase tracking-[0.22em] text-white/45'>
                Presets
              </span>
              <div className='grid grid-cols-3 gap-2'>
                {CROSSHAIR_SHAPE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type='button'
                    onClick={() => setCh(p.cfg)}
                    {...sfxProps('uiClick')}
                    className='clip-deck-sm flex flex-col items-center gap-1.5 border border-white/12 bg-white/[0.03] px-2 py-2.5 transition hover:border-cyan-300/50 hover:bg-white/10'
                  >
                    <span className='flex h-7 items-center justify-center'>
                      <CrosshairGraphic
                        cfg={{ ...DEFAULT_CROSSHAIR, ...p.cfg, color: '#d6f4ff', outline: false }}
                      />
                    </span>
                    <span className='font-mono text-[9px] uppercase tracking-[0.1em] text-white/60'>
                      {p.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className='flex items-center justify-between gap-4'>
              <div className='flex-1'>
                <ButtonGroup
                  label='Style'
                  value={ch.style}
                  options={[
                    { id: 'cross', label: 'Cross' },
                    { id: 'cross-dot', label: 'Cross+Dot' },
                    { id: 'dot', label: 'Dot' },
                    { id: 'circle', label: 'Circle' },
                  ]}
                  onChange={(v) => setCh({ style: v as CrosshairConfig['style'] })}
                />
              </div>
              <div className='clip-deck-sm flex h-16 w-16 shrink-0 items-center justify-center border border-white/10 bg-[#1a1f29]'>
                <CrosshairGraphic cfg={ch} />
              </div>
            </div>
            <ColorField label='Color' value={ch.color} onChange={(v) => setCh({ color: v })} />
            <CrosshairColorPresets onPick={(c) => setCh({ color: c })} />
            <CrosshairVisibilityPreview cfg={ch} />
            <SliderField label='Size' value={ch.size} min={0} max={30} step={1} format={(v) => `${v}px`} onChange={(v) => setCh({ size: v })} />
            <SliderField label='Thickness' value={ch.thickness} min={1} max={8} step={1} format={(v) => `${v}px`} onChange={(v) => setCh({ thickness: v })} />
            <SliderField label='Gap' value={ch.gap} min={0} max={20} step={1} format={(v) => `${v}px`} onChange={(v) => setCh({ gap: v })} />
            <SliderField label='Center dot' value={ch.dotSize} min={0} max={10} step={1} format={(v) => (v === 0 ? 'off' : `${v}px`)} onChange={(v) => setCh({ dotSize: v })} />
            <ToggleField label='Outline' value={ch.outline} onChange={(v) => setCh({ outline: v })} />
            {ch.outline && (
              <>
                <SliderField label='Outline width' value={ch.outlineThickness} min={1} max={4} step={1} format={(v) => `${v}px`} onChange={(v) => setCh({ outlineThickness: v })} />
                <ColorField label='Outline color' value={ch.outlineColor} onChange={(v) => setCh({ outlineColor: v })} />
              </>
            )}
            <CrosshairShare cfg={ch} onImport={(next) => onChange({ ...settings, crosshair: next })} />
            </Section>
          )}

          {tab === 'accessibility' && (
            <Section label='Accessibility'>
              <ToggleField
                label='Reduced effects (shake & flash)'
                value={settings.reducedEffects}
                onChange={(v) => onChange({ ...settings, reducedEffects: v })}
              />
              <ToggleField
                label='Hide chat'
                value={settings.hideChat}
                onChange={(v) => onChange({ ...settings, hideChat: v })}
              />
              <ToggleField
                label='Bright enemies'
                value={settings.enemyBright}
                onChange={(v) => onChange({ ...settings, enemyBright: v })}
              />
              {settings.enemyBright && (
                <ColorField
                  label='Enemy color'
                  value={settings.enemyColor}
                  onChange={(v) => onChange({ ...settings, enemyColor: v })}
                />
              )}
              <div className='text-[10px] normal-case tracking-normal text-white/40'>
                “Reduced effects” suppresses camera shake, the kill-flash, and heavy
                explosions (uses small sparks instead) — defaults to your system’s
                reduce-motion setting. “Hide chat” hides the in-game chat log and
                disables opening it (rebind the Chat key under Controls). “Bright
                enemies” makes opponents glow a color you pick, for visibility /
                colorblindness.
              </div>
            </Section>
          )}

          {tab === 'profile' && (
            <Section label='Profile &amp; LAN'>
              <TextField
                label='Player name'
                value={isGuestName ? 'Guest' : settings.playerName}
                readOnly
                hint={
                  isGuestName
                    ? 'Guests appear as Guest 1, 2, 3… in matches. Log in or create an account to set a name.'
                    : 'Your account username, shown to other players. Set when you register.'
                }
                onChange={() => {}}
              />
              {/* Custom server URL is dev/LAN-only — hidden in production, where
                  the client always uses the same-origin server (see serverUrl). */}
              {import.meta.env.DEV && (
                <TextField
                  label='Server URL (blank = this server)'
                  value={settings.serverUrl}
                  placeholder='wss://your-server.example/ws/instagib'
                  onChange={(v) => onChange({ ...settings, serverUrl: v.trim() })}
                />
              )}
              <SettingsShare settings={settings} onImport={onChange} />
            </Section>
          )}
            </>
          )}
      </div>
    </ModalShell>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className='flex flex-col gap-1.5'>
      <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/65'>
        <span>{label}</span>
        <span className='tabular-nums text-white/85'>{format(value)}</span>
      </div>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className='deck-range'
      />
    </label>
  );
}

// Announcer-pack picker, gated by ownership. Packs are registered as cosmetics
// (see cosmetics.ts) so the server's `unlocked` list already reflects admin-all +
// level/credit grants — we just fetch the profile and lock the rest. The default
// pack is always free; admins get everything. A locked pack that's somehow active
// (persisted, then lost) is reset to default.
function AnnouncerPackField({
  value,
  onChange,
}: {
  value: AnnouncerPackId;
  onChange: (v: AnnouncerPackId) => void;
}) {
  const [unlocked, setUnlocked] = useState<Set<string> | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: { unlocked?: string[] } } | null) => {
        if (active) setUnlocked(new Set(d?.profile?.unlocked ?? [])); // empty (e.g. guest) → only default
      })
      .catch(() => active && setUnlocked(new Set()));
    return () => {
      active = false;
    };
  }, []);
  const isUnlocked = useCallback(
    (packId: string): boolean => {
      const cos = cosmeticById(announcerPackCosmeticId(packId));
      if (!cos || cos.source.type === 'default') return true; // default pack is always free
      return unlocked?.has(cos.id) ?? false;
    },
    [unlocked],
  );
  // If the active pack isn't owned (locked / persisted from a prior unlock), drop to default.
  useEffect(() => {
    if (unlocked && value !== DEFAULT_ANNOUNCER_PACK && !isUnlocked(value)) onChange(DEFAULT_ANNOUNCER_PACK);
  }, [unlocked, value, isUnlocked, onChange]);
  return (
    <label className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>Announcer pack</span>
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value as AnnouncerPackId;
          if (isUnlocked(v)) onChange(v);
        }}
        className='deck-input deck-select deck-input-sm'
      >
        {ANNOUNCER_PACKS.map((p) => {
          const ok = isUnlocked(p.id);
          const cos = cosmeticById(announcerPackCosmeticId(p.id));
          const lock = !ok && cos ? ` 🔒 ${sourceLabel(cos.source)}` : '';
          return (
            <option key={p.id} value={p.id} disabled={!ok} className='bg-zinc-900 text-white'>
              {p.name}
              {lock}
            </option>
          );
        })}
      </select>
      <span className='text-[10px] text-white/35'>
        Premium packs unlock by level (or are staff-granted). Admins have all of them.
      </span>
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className='deck-input deck-select deck-input-sm'
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  placeholder,
  maxLength,
  onChange,
  readOnly,
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (v: string) => void;
  readOnly?: boolean;
  hint?: string;
}) {
  return (
    <label className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <input
        type='text'
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        readOnly={readOnly}
        aria-readonly={readOnly}
        onChange={(e) => {
          if (!readOnly) onChange(e.target.value);
        }}
        className={`deck-input deck-input-sm ${readOnly ? 'cursor-not-allowed' : ''}`}
      />
      {hint && (
        <span className='text-[10px] normal-case tracking-normal text-white/40'>{hint}</span>
      )}
    </label>
  );
}

function ToggleField({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
      <span
        className={`flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] ${
          disabled ? 'text-white/35' : 'text-white/65'
        }`}
      >
        <span>{label}</span>
        <DeckSwitch value={value} onChange={onChange} label={label} disabled={disabled} />
      </span>
      {hint && <span className='text-[10px] normal-case tracking-normal text-white/35'>{hint}</span>}
    </label>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='mt-1 border-t border-white/10 pt-4'>
      <div className='mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55'>
        {label}
      </div>
      <div className='flex flex-col gap-4'>{children}</div>
    </div>
  );
}

function ButtonGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <div className='flex flex-wrap gap-1.5' role='group' aria-label={label}>
        {options.map((o) => (
          <SegButton key={o.id} active={value === o.id} onClick={() => onChange(o.id)} className='px-2.5 py-1.5 text-[10px]'>
            {o.label}
          </SegButton>
        ))}
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className='flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'>
      <span>{label}</span>
      <span className='flex items-center gap-2'>
        <span className='tabular-nums text-white/85'>{value}</span>
        <input
          type='color'
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          className='h-7 w-10 cursor-pointer border border-white/20 bg-transparent p-0'
        />
      </span>
    </label>
  );
}

// Quick high-visibility color presets for the crosshair (#26d).
const CROSSHAIR_PRESETS = ['#00ff88', '#ffffff', '#ff2bd6', '#ffe100', '#00e5ff', '#ff3b30'];

function CrosshairColorPresets({ onPick }: { onPick: (c: string) => void }) {
  return (
    <div className='flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'>
      <span>Presets</span>
      <div className='flex items-center gap-1.5'>
        {CROSSHAIR_PRESETS.map((c) => (
          <button
            key={c}
            type='button'
            aria-label={`Use ${c}`}
            onClick={() => onPick(c)}
            {...sfxProps('uiClick')}
            className='h-6 w-6 border border-white/20 transition hover:scale-110'
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  );
}

// Preview the crosshair against light / mid / dark backgrounds so the player can
// judge visibility across map tones before committing to a color (#26d).
function CrosshairVisibilityPreview({ cfg }: { cfg: CrosshairConfig }) {
  const bgs = ['#dce3ec', '#6b7480', '#10141b'];
  return (
    <div className='grid grid-cols-3 gap-1.5'>
      {bgs.map((bg) => (
        <div
          key={bg}
          className='flex h-14 items-center justify-center overflow-hidden border border-white/10'
          style={{ backgroundColor: bg }}
        >
          <CrosshairGraphic cfg={cfg} />
        </div>
      ))}
    </div>
  );
}

function SettingsShare({
  settings,
  onImport,
}: {
  settings: Settings;
  onImport: (s: Settings) => void;
}) {
  const code = encodeSettings(settings);
  const [paste, setPaste] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied settings code', { tone: 'ok' });
    } catch {
      toast('Copy failed', { tone: 'err' });
    }
  };
  const doImport = () => {
    const next = decodeSettings(paste);
    if (next) {
      onImport(next);
      setPaste('');
      toast('Settings imported', { tone: 'ok' });
    } else {
      toast('Invalid settings code', { tone: 'err' });
    }
  };
  return (
    <div className='flex flex-col gap-2 border border-white/10 bg-black/30 p-3'>
      <span className='text-[10px] uppercase tracking-[0.16em] text-white/55'>
        All-settings code (backup / transfer)
      </span>
      <div className='flex items-center gap-2'>
        <input
          readOnly
          value={code}
          aria-label='Settings share code'
          onFocus={(e) => e.currentTarget.select()}
          className='deck-input deck-input-sm min-w-0 flex-1'
        />
        <UtilButton onClick={copy} tone='cyan' sound='none' className='shrink-0'>
          Copy
        </UtilButton>
      </div>
      <div className='flex items-center gap-2'>
        <input
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder='Paste an IGS- code to import…'
          aria-label='Import settings code'
          className='deck-input deck-input-sm min-w-0 flex-1'
        />
        <UtilButton onClick={doImport} disabled={!paste.trim()} sound='none' className='shrink-0'>
          Import
        </UtilButton>
      </div>
    </div>
  );
}

function CrosshairShare({
  cfg,
  onImport,
}: {
  cfg: CrosshairConfig;
  onImport: (c: CrosshairConfig) => void;
}) {
  const code = encodeCrosshair(cfg);
  const [paste, setPaste] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied crosshair code', { tone: 'ok' });
    } catch {
      toast('Copy failed', { tone: 'err' });
    }
  };
  const doImport = () => {
    const next = decodeCrosshair(paste);
    if (next) {
      onImport(next);
      setPaste('');
      toast('Crosshair imported', { tone: 'ok' });
    } else {
      toast('Invalid crosshair code', { tone: 'err' });
    }
  };

  return (
    <div className='flex flex-col gap-2 border border-white/10 bg-black/30 p-3'>
      <span className='text-[10px] uppercase tracking-[0.16em] text-white/55'>Share code</span>
      <div className='flex items-center gap-2'>
        <input
          readOnly
          value={code}
          aria-label='Crosshair share code'
          onFocus={(e) => e.currentTarget.select()}
          className='deck-input deck-input-sm min-w-0 flex-1'
        />
        <UtilButton onClick={copy} tone='cyan' sound='none' className='shrink-0'>
          Copy
        </UtilButton>
      </div>
      <div className='flex items-center gap-2'>
        <input
          value={paste}
          placeholder='Paste a share code…'
          aria-label='Import crosshair code'
          onChange={(e) => setPaste(e.target.value)}
          className='deck-input deck-input-sm min-w-0 flex-1'
        />
        <UtilButton onClick={doImport} disabled={!paste.trim()} sound='none' className='shrink-0'>
          Import
        </UtilButton>
      </div>
    </div>
  );
}

function MouseSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const cm = cm360(settings.sensitivity, settings.dpi);
  return (
    <Section label='Mouse'>
      <SliderField
        label='Sensitivity'
        value={settings.sensitivity}
        min={MIN_SENSITIVITY}
        max={MAX_SENSITIVITY}
        step={SENSITIVITY_STEP}
        format={(v) => v.toFixed(2)}
        onChange={(v) => onChange({ ...settings, sensitivity: v })}
      />
      <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/55'>
        <span>cm / 360°</span>
        <span className='tabular-nums text-cyan-200'>
          {cm.toFixed(1)} cm · {(cm / 2.54).toFixed(1)} in
        </span>
      </div>
      <NumberField
        label='Mouse DPI'
        value={settings.dpi}
        min={MIN_DPI}
        max={MAX_DPI}
        step={50}
        onChange={(v) => onChange({ ...settings, dpi: v })}
      />
      <SliderField
        label='Vertical sens'
        value={settings.vertScale}
        min={MIN_VERT_SCALE}
        max={MAX_VERT_SCALE}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(v) => onChange({ ...settings, vertScale: v })}
      />
      <ToggleField
        label='Raw input (no accel)'
        value={settings.rawInput}
        onChange={(v) => onChange({ ...settings, rawInput: v })}
      />
    </Section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className='flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'>
      <span>{label}</span>
      <input
        type='number'
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
        }}
        className='deck-input deck-input-sm w-24 text-right'
      />
    </label>
  );
}

// Friendly label for a KeyboardEvent.code.
function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt',
    AltRight: 'R-Alt',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: 'Bksp',
    CapsLock: 'Caps',
    Backquote: '`',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  return map[code] ?? code;
}

function KeybindsSection({
  keybinds,
  onChange,
}: {
  keybinds: Record<KeybindAction, string>;
  onChange: (b: Record<KeybindAction, string>) => void;
}) {
  const [listening, setListening] = useState<KeybindAction | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(null);
        return;
      }
      const next = { ...keybinds };
      const prev = next[listening];
      // Swap with any action already using this key so nothing ends up unbound.
      const conflict = (Object.keys(next) as KeybindAction[]).find(
        (a) => a !== listening && next[a] === e.code,
      );
      next[listening] = e.code;
      if (conflict) next[conflict] = prev;
      onChange(next);
      setListening(null);
    };
    // Capture phase + stopPropagation so the in-game InputManager doesn't also
    // see the rebind keypress.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, keybinds, onChange]);

  return (
    <Section label='Keybinds'>
      {KEYBIND_ACTIONS.map(({ id, label }) => (
        <div
          key={id}
          className='flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'
        >
          <span>{label}</span>
          <button
            type='button'
            onClick={() => setListening(id)}
            aria-pressed={listening === id}
            {...sfxProps('uiClick')}
            className={`clip-deck-sm min-w-[5.5rem] border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] transition ${
              listening === id
                ? 'deck-pulse border-cyan-400 bg-cyan-400/15 text-cyan-200'
                : 'border-white/15 bg-black/40 text-white/85 hover:bg-white/10'
            }`}
          >
            {listening === id ? 'press…' : keyLabel(keybinds[id])}
          </button>
        </div>
      ))}
      <div className='text-[10px] normal-case tracking-normal text-white/40'>
        Click a slot, then press a key (Esc cancels). Fire = LMB · Boost = RMB.
      </div>
    </Section>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function tierColors(tier: MedalTier): {
  gradient: string;
  glow: string;
  stroke: string;
  bar: string;
  border: string;
  text: string;
} {
  switch (tier) {
    case 'multi':
      return {
        gradient: 'from-rose-300 via-rose-200 to-orange-200',
        glow: 'rgba(244,63,94,0.45)',
        stroke: 'rgba(244,63,94,0.45)',
        bar: 'bg-gradient-to-r from-rose-400 to-orange-300',
        border: 'border-rose-400/45',
        text: 'text-rose-200',
      };
    case 'streak':
      return {
        gradient: 'from-amber-200 via-yellow-200 to-amber-100',
        glow: 'rgba(252,211,77,0.45)',
        stroke: 'rgba(245,158,11,0.45)',
        bar: 'bg-gradient-to-r from-amber-400 to-yellow-300',
        border: 'border-amber-300/45',
        text: 'text-amber-200',
      };
    case 'special':
    default:
      return {
        gradient: 'from-cyan-200 via-sky-200 to-white',
        glow: 'rgba(103,232,249,0.45)',
        stroke: 'rgba(103,232,249,0.45)',
        bar: 'bg-gradient-to-r from-cyan-300 to-sky-200',
        border: 'border-cyan-300/45',
        text: 'text-cyan-200',
      };
  }
}
