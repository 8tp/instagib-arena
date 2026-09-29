import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  DeckButton,
  ToastStack as MenuToasts, // the in-match HUD has its own ToastStack below
  } from './deck';
import { sfxProps, toast, useAnyModalOpen } from './deck-core';
import { StatsModal } from './panels/Stats';
import { LeaderboardModal } from './panels/Leaderboard';
import { RankedModal } from './panels/Ranked';
import { WeeklyChallengeModal } from './panels/WeeklyChallenge';
import { AdminModal } from './panels/AdminPanel';
import { fmtChallengeTime, type WeeklyChallengeMe } from './panels/shared';
import { MenuBackdropView } from './menu/MenuBackdropView';
import type { HeroLoadout } from './menu/menu-hero';
import { ProfileBlock } from './menu/ProfileBlock';
import { FrontDoors } from './menu/FrontDoors';
import { AccountMenu } from './menu/AccountMenu';
import { InboxButton } from './inbox/InboxButton';
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
import { mapById } from './game/map';
import { setUiVolume } from './game/audio';
import {
  LobbyClient,
  type LobbyRoom,
  type LobbyStatus,
  type PresenceState,
  type ChatMessage,
  type RankedStatus,
  type RankedRoom,
  type RankedResult,
} from './game/net';
import { withLegacyFromLooks } from './game/look-runtime';
import { itemDef } from './game/items/catalog';
import { TIER_META, qualityPrefix, wearName } from './game/items/types';
import { CHAT_CLIENT_MAX_LEN } from './lobby/helpers';
import { GlobalChatPanel, OnlinePlayersPanel, OpenLobbies, ServerStatusChip } from './lobby/ServerBrowser';
import { CreateMatchModal, CreateOnlineModal, InviteModal } from './lobby/CreateMatch';
import { DisconnectedOverlay, JoinErrorOverlay, OnboardingModal, WaitingForOpponents } from './lobby/Overlays';
import {
  AIR_JUMPS,
  DASH_COOLDOWN,
  DEFAULT_GAME_MODE,
  DEFAULT_KEYBINDS,
  DEFAULT_VIEWMODEL_OFFSET,
  HIT_MARKER_DURATION_SEC,
  HIT_MARKER_KILL_DURATION_SEC,
  M_YAW_DEG,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  RAIL_COOLDOWN,
  TOAST_FADE_SEC,
  WEEKLY_CHALLENGE_MAP,
  WEEKLY_CHALLENGE_BOTS,
  WEEKLY_CHALLENGE_DIFFICULTY,
  WEEKLY_CHALLENGE_MODE,
  type BotDifficulty,
  type GameMode,
} from './game/constants';
import type {
  BannerState,
  ChatLine,
  HitMarker,
  HudState,
  KillFlash,
  KillcamState,
  MedalTier,
  PlayerScore,
  PomState,
  ToastEntry,
  TrainingHud,
} from './game/types';
import { FragPopup } from './game/kill-overlays';
import type { CrosshairConfig, InstagibProfile, ProgressionResp, Settings } from './app-types';
import { setCharacterFxQuality } from './game/character/gibs';
import { setFxQuality } from './game/fx-pool';
import { Locker } from './locker/Locker';
import { MatchOverOverlay, OnlineMatchResults } from './ui/results';
import { MapVoteOverlay } from './ui/MapVote';
import { RankedResultOverlay } from './ui/RankedResult';
import { PlayerCard } from './ui/player-card';
import { buildCardPayload } from './ui/player-card-data';
import { SettingsModal, type SettingsTab } from './settings/SettingsModal';
import { keyLabel } from './settings/keys';
import { DEFAULT_CROSSHAIR, DEFAULT_SETTINGS, clampOutlineWidth, decodeCrosshair, encodeCrosshair, sanitizeHex } from './settings/codec';

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
  game.setEnemyOutline?.(
    !!s.enemyOutline,
    sanitizeHex(s.enemyOutlineColor, DEFAULT_SETTINGS.enemyOutlineColor),
    clampOutlineWidth(s.enemyOutlineWidth),
  );
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
        <MapVoteOverlay vote={hud.vote} onVote={voteForMap} reducedEffects={settings.reducedEffects} />
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
          reducedEffects={settings.reducedEffects}
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
  const killTotal = Math.max(0, Math.min(8, pom.killTotal ?? 0));
  const killsLanded = Math.min(killTotal, pom.hitId);

  return (
    <div className='pointer-events-none absolute inset-0 z-40 font-mono'>
      <style>{'@keyframes pomHit{0%{opacity:0;transform:scale(1.5)}25%{opacity:1}100%{opacity:0;transform:scale(1)}}@keyframes pomVerdict{0%{opacity:0;transform:scale(0.82)}55%{opacity:1;transform:scale(1.04)}100%{opacity:1;transform:scale(1)}}@keyframes pomTick{0%{transform:scaleY(1.9);filter:brightness(2.2)}100%{transform:scaleY(1);filter:none}}'}</style>

      {/* Cinematic frame: a soft edge vignette + thin feathered bands top and
          bottom (not solid bars — the frame is the star's screen, full height). */}
      <ReplayFrame />

      {/* A minimal replay tag, top-left — the rest of the frame is their screen. */}
      <ReplayTag label={isPotg ? 'Replay' : 'Final blow'} tone={isPotg ? 'cyan' : 'amber'} />

      {/* First-person framing: the crosshair + a kill flash so it's clear we're
          watching someone frag. Hidden on the VICTORY/DEFEAT card. */}
      {!isVerdict && (
        <>
          <Crosshair cfg={(pom.crosshairCode && decodeCrosshair(pom.crosshairCode)) || settings.crosshair} />
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
            className='absolute left-[4vw] bottom-[9vh] max-w-[46vw] overflow-hidden rounded-md border border-white/15 px-5 py-3 shadow-[0_6px_24px_rgba(0,0,0,0.6)]'
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
              {/* One tick per kill in the play, lit as each one lands. */}
              {killTotal > 1 ? (
                <div className='mt-2 flex gap-1.5' aria-hidden>
                  {Array.from({ length: killTotal }, (_, i) => {
                    const lit = i < killsLanded;
                    return (
                      <span
                        key={`${i}-${lit ? 1 : 0}`}
                        className='h-2.5 w-6 origin-bottom rounded-[1px]'
                        style={{
                          background: lit ? (pom.kit?.cardAccent ?? '#67e8f9') : 'rgba(255,255,255,0.18)',
                          boxShadow: lit ? `0 0 8px ${pom.kit?.cardAccent ?? '#67e8f9'}99` : undefined,
                          animation: lit && !reduced ? 'pomTick 260ms cubic-bezier(0.2,0.8,0.2,1) both' : undefined,
                        }}
                      />
                    );
                  })}
                </div>
              ) : null}
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

      {/* Auto-advance progress bar: a hairline along the bottom edge. */}
      <div className='absolute inset-x-0 bottom-0 h-[2px] bg-white/5'>
        <div
          className={`h-full ${isPotg ? 'bg-cyan-400/70' : 'bg-amber-400/70'}`}
          style={{ width: `${pct}%`, transition: 'width 80ms linear' }}
        />
      </div>
    </div>
  );
}

// The replay cinematic frame: a soft vignette and feathered bands at the
// top and bottom edges. Static (no motion), so it's the same under reduced effects.
function ReplayFrame() {
  return (
    <>
      <div
        className='absolute inset-0'
        style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 50%, transparent 60%, rgba(0,0,0,0.42) 100%)' }}
      />
      <div
        className='absolute inset-x-0 top-0 h-[9vh]'
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.62), rgba(0,0,0,0.28) 45%, transparent)' }}
      />
      <div
        className='absolute inset-x-0 bottom-0 h-[9vh]'
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.62), rgba(0,0,0,0.28) 45%, transparent)' }}
      />
    </>
  );
}

// Small "you're watching a replay" chip (REPLAY / FINAL BLOW), top-left over the
// bare cinematic.
function ReplayTag({ label, tone }: { label: string; tone: 'cyan' | 'amber' }) {
  const dot = tone === 'cyan' ? 'bg-cyan-300' : 'bg-amber-300';
  return (
    <div className='absolute left-[2.2vw] top-[3.2vh] flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.32em] text-white/80 [text-shadow:0_1px_4px_rgba(0,0,0,0.9)]'>
      <span className={`h-1.5 w-1.5 rounded-full ${dot} shadow-[0_0_6px_currentColor]`} />
      {label}
    </div>
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
  // Holding Tab over the killcam: the scoreboard takes the screen, so the death
  // recap steps aside instead of printing through it.
  const scoreboard = useHudSlice((s) => s.showScoreboard);
  return (
    <KillcamOverlay
      killcam={killcam}
      killcamId={killcamId}
      reduced={reduced}
      recapHidden={scoreboard}
    />
  );
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
  recapHidden = false,
}: {
  killcam: KillcamState | null;
  killcamId: number;
  reduced?: boolean;
  recapHidden?: boolean;
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
        <KillcamCard
          key={item.id}
          item={item}
          leaving={leaving}
          reduced={reduced}
          recapHidden={recapHidden}
        />
      ))}
    </>
  );
});

const KillcamCard = memo(function KillcamCard({
  item,
  leaving,
  reduced,
  recapHidden,
}: {
  item: KillcamItem;
  leaving: boolean;
  reduced: boolean;
  recapHidden: boolean;
}) {
  const { cam } = item;
  return (
    <div
      className={`hud-killcam absolute inset-0 z-10${leaving ? ' hud-leaving' : ''}`}
      style={hudTiming(item.remaining, item.total, KILLCAM_FADE_LEAD_MS)}
    >
      {/* A light edge vignette: the killer showcase is the picture here. */}
      <div
        className='absolute inset-0'
        style={{
          background:
            'radial-gradient(ellipse 80% 75% at 50% 45%, transparent 50%, rgba(0,0,0,0.5) 100%)',
        }}
      />
      {/* Lower third, hugging the bottom edge: the killcam frames the killer at
          centre (feet sit ~70% down), so the print sits below that. */}
      {/* (The wrapper carries the scoreboard fade: the card's own entrance
          animation holds its opacity.) */}
      <div
        className='absolute inset-x-0 bottom-[3.5%]'
        style={{ opacity: recapHidden ? 0 : 1, transition: 'opacity 120ms ease-out' }}
      >
        <div
          className='hud-killcam-card flex items-end justify-between gap-6 px-[5vw] font-mono'
        >
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
const CHAT_LOG_MAX = 120;

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
            <InboxButton
              loggedIn={!!account}
              reduced={settings.reducedEffects}
              lowSpec={settings.lowSpec}
              credits={lobbyProfile?.credits ?? null}
              refreshKey={refreshTick}
              onGranted={refreshMeta}
            />
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
                    status={lobbyStatus}
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
