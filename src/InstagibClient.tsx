import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Game, type HudListener, type MatchResult, type NetMatchEvent } from './game/game';
import { MAPS, mapById } from './game/map';
import { LobbyClient, type LobbyRoom, type LobbyStatus } from './game/net';
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
  MATCH_FRAG_LIMIT,
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
  TEAM_COLORS,
  TEAM_NAMES,
  TOAST_FADE_SEC,
  type BotDifficulty,
  type GameMode,
  type KeybindAction,
} from './game/constants';
import type {
  BannerState,
  HitMarker,
  HudState,
  KillConfirm,
  KillcamState,
  KillfeedEntry,
  MapVoteState,
  MedalTier,
  PlayerScore,
  ToastEntry,
} from './game/types';

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

type Settings = {
  sensitivity: number; // Source/CS2-style sens number
  dpi: number; // mouse DPI (feeds cm/360 readout only)
  vertScale: number; // vertical (pitch) sensitivity multiplier
  rawInput: boolean; // pointer-lock unadjustedMovement
  keybinds: Record<KeybindAction, string>; // action → KeyboardEvent.code
  fov: number;
  zoomFov: number; // FOV while the zoom bind is held
  viewmodelOffset: { x: number; y: number; z: number }; // railgun viewmodel nudge
  hideViewmodel: boolean; // hide the first-person gun
  volume: number; // master
  sfxVolume: number;
  announcerVolume: number;
  announcerEnabled: boolean;
  showFps: boolean;
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
};

export type MatchConfig =
  | {
      mode: 'local';
      mapId: string;
      botCount: number;
      difficulty: BotDifficulty;
      training?: boolean; // endless practice — no frag-limit match end
    }
  | { mode: 'multiplayer'; mapId: string; serverUrl: string; roomId: string };

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
  rawInput: DEFAULT_RAW_INPUT,
  keybinds: DEFAULT_KEYBINDS,
  fov: DEFAULT_FOV,
  zoomFov: DEFAULT_ZOOM_FOV,
  viewmodelOffset: { ...DEFAULT_VIEWMODEL_OFFSET },
  hideViewmodel: false,
  volume: DEFAULT_VOLUME,
  sfxVolume: 1,
  announcerVolume: 1,
  announcerEnabled: true,
  showFps: false,
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
  game.setRawInput?.(s.rawInput);
  game.setKeybinds?.(s.keybinds);
  game.setFov?.(s.fov);
  game.setZoomFov?.(s.zoomFov);
  game.setViewmodel?.(s.viewmodelOffset, s.hideViewmodel);
  game.setMasterVolume?.(s.volume);
  game.setSfxVolume?.(s.sfxVolume);
  game.setAnnouncerVolume?.(s.announcerVolume);
  game.setAnnouncerEnabled?.(s.announcerEnabled);
  game.setPlayerName?.(s.playerName);
  game.setWorldStyle?.(s.worldColor, s.worldBrightness);
  game.setEnemyStyle?.(s.enemyBright ? s.enemyColor : null);
}

// Configures a freshly-created Game for a match before start().
function applyMatchConfig(game: Game, config: MatchConfig) {
  game.setMap(mapById(config.mapId));
  if (config.mode === 'multiplayer') {
    game.setBotsEnabled(false);
    game.setMultiplayer({ enabled: true, url: config.serverUrl, roomId: config.roomId });
  } else {
    game.setMultiplayer({ enabled: false, url: '' });
    game.setTraining(config.training ?? false);
    game.setBotDifficulty(config.difficulty);
    game.setBotCount(config.botCount);
    game.setBotsEnabled(true);
  }
}

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
  hitMarker: null,
  killConfirm: null,
  killcam: null,
  showScoreboard: false,
  matchOver: null,
  netStatus: 'off',
  netPeers: 0,
  netRttMs: 0,
  localInvulnMs: 0,
  vote: null,
  mode: 'ffa',
  localTeam: null,
  teamScores: null,
  duel: null,
};

export default function InstagibClient() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<'lobby' | 'playing'>('lobby');
  const [config, setConfig] = useState<MatchConfig | null>(null);
  const [lastResult, setLastResult] = useState<MatchResult | null>(null);
  // Bumped on every match start so GameView remounts a fresh Game (also for
  // "Play Again" with the same config).
  const [playId, setPlayId] = useState(0);

  // Load persisted settings once on mount + backfill window-dependent defaults.
  useEffect(() => {
    const loaded = loadSettings();
    if (!loaded.serverUrl) loaded.serverUrl = defaultServerUrl();
    if (!loaded.playerName) {
      const stamp = Math.random().toString(36).slice(2, 6).toUpperCase();
      loaded.playerName = `Player-${stamp}`;
    }
    setSettings(loaded);

    // Invite link: ?join=ROOMID drops straight into that room. The map is
    // unknown until the server confirms the join (Game adopts it then), so we
    // pass a placeholder map; clear the param so a refresh doesn't re-join.
    if (typeof window !== 'undefined') {
      const code = new URLSearchParams(window.location.search).get('join');
      if (code && /^[A-Z0-9]{3,10}$/i.test(code)) {
        const url = new URL(window.location.href);
        url.searchParams.delete('join');
        window.history.replaceState({}, '', url.toString());
        startMatch({
          mode: 'multiplayer',
          mapId: randomMapId(),
          serverUrl: loaded.serverUrl || defaultServerUrl(),
          roomId: code.toUpperCase(),
        });
      }
    }
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const startMatch = useCallback((cfg: MatchConfig) => {
    setLastResult(null);
    setConfig(cfg);
    setPlayId((n) => n + 1);
    setView('playing');
  }, []);

  // Leave to the lobby. GameView already submitted stats; we only carry the
  // result through for the lobby's "last match" banner (no re-submit here).
  const exitToLobby = useCallback((result: MatchResult | null) => {
    if (result) setLastResult(result);
    setView('lobby');
  }, []);

  const playAgain = useCallback(() => {
    if (config) startMatch(config);
  }, [config, startMatch]);

  if (view === 'playing' && config) {
    return (
      <GameView
        key={playId}
        config={config}
        settings={settings}
        onChangeSettings={setSettings}
        onExit={exitToLobby}
        onPlayAgain={playAgain}
      />
    );
  }
  return (
    <Lobby
      settings={settings}
      onChangeSettings={setSettings}
      onStart={startMatch}
      lastResult={lastResult}
    />
  );
}

/* ───────────────────────── In-match view ───────────────────────── */

function GameView({
  config,
  settings,
  onChangeSettings,
  onExit,
  onPlayAgain,
}: {
  config: MatchConfig;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onExit: (result: MatchResult | null) => void;
  onPlayAgain: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endResult, setEndResult] = useState<MatchResult | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const listener: HudListener = (state) => setHud(state);
    // Match ended (frag limit): submit stats once + keep the result for the
    // results overlay. Navigation happens from the overlay buttons.
    const game = new Game(canvas, listener, (result) => {
      setEndResult(result);
      void submitMatchStats(result);
    });
    gameRef.current = game;
    game.setNetEventListener((ev: NetMatchEvent) => {
      if (ev.type === 'join-failed') {
        setJoinError(
          ev.reason === 'full'
            ? 'That lobby is full.'
            : 'That lobby no longer exists.',
        );
      }
    });
    applySettingsToGame(game, settings);
    applyMatchConfig(game, config);
    void game.start();
    return () => {
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
    if (r && game?.hasRecordableStats()) void submitMatchStats(r);
    onExit(r);
  }, [onExit]);

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

  return (
    <div ref={containerRef} className='fixed inset-0 z-50 bg-black text-white'>
      <canvas ref={canvasRef} onClick={requestPlay} className='block h-full w-full' />
      <HudOverlay hud={hud} settings={settings} />
      {hud.vote && <MapVoteOverlay vote={hud.vote} onVote={voteForMap} />}
      {joinError && (
        <JoinErrorOverlay
          message={joinError}
          onLeave={() => onExit(null)}
          // Re-attempt the same room (the invite room gets a 5-min grace, so a
          // friend joining a bit late can retry without a fresh link — #17).
          onRetry={config.mode === 'multiplayer' ? () => { setJoinError(null); onPlayAgain(); } : undefined}
        />
      )}
      {waiting && (
        <WaitingForOpponents
          roomId={config.mode === 'multiplayer' ? config.roomId : ''}
          onLeave={leave}
        />
      )}
      {!hud.locked && !hud.matchOver && !hud.vote && !joinError && !waiting && (
        <ClickToPlay
          onPlay={requestPlay}
          onOpenSettings={() => setSettingsOpen(true)}
          onLeave={leave}
          hud={hud}
          settings={settings}
        />
      )}
      {hud.matchOver && (
        <MatchOverOverlay
          won={hud.matchOver.won}
          scores={hud.scores}
          result={endResult}
          onPlayAgain={() => {
            exitFullscreen();
            onPlayAgain();
          }}
          onLobby={() => {
            exitFullscreen();
            onExit(endResult);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={onChangeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function MatchOverOverlay({
  won,
  scores,
  result,
  onPlayAgain,
  onLobby,
}: {
  won: boolean;
  scores: PlayerScore[];
  result: MatchResult | null;
  onPlayAgain: () => void;
  onLobby: () => void;
}) {
  const acc = result && result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  return (
    <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='w-[520px] max-w-[94vw] rounded-2xl border border-cyan-500/25 bg-zinc-950/95 p-7 font-mono shadow-2xl'>
        <div
          className={`text-center text-3xl font-extrabold uppercase tracking-[0.22em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
          style={{
            filter: won
              ? 'drop-shadow(0 0 18px rgba(52,211,153,0.5))'
              : 'drop-shadow(0 0 18px rgba(244,63,94,0.5))',
          }}
        >
          {won ? 'Victory' : 'Defeat'}
        </div>
        <div className='mt-1 text-center text-[10px] uppercase tracking-[0.3em] text-white/45'>
          Match complete · First to {MATCH_FRAG_LIMIT}
        </div>

        <div className='mt-5 overflow-hidden rounded-lg border border-white/10'>
          <div className='grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 bg-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/45'>
            <span>#</span>
            <span>Player</span>
            <span className='text-right'>K</span>
            <span className='text-right'>D</span>
          </div>
          {scores.map((s, i) => (
            <div
              key={s.id}
              className={`grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 px-3 py-1.5 text-sm ${
                s.isLocal ? 'bg-cyan-300/10 text-cyan-100' : 'text-white/80'
              }`}
            >
              <span className='tabular-nums text-white/45'>{i + 1}</span>
              <span className='truncate'>
                {s.name}
                {s.isLocal && ' (you)'}
              </span>
              <span className='text-right tabular-nums'>{s.frags}</span>
              <span className='text-right tabular-nums'>{s.deaths}</span>
            </div>
          ))}
        </div>

        {result && (
          <div className='mt-4 grid grid-cols-4 gap-2 text-center'>
            <MiniStat label='Kills' value={result.kills} />
            <MiniStat label='Deaths' value={result.deaths} />
            <MiniStat label='Streak' value={result.bestStreak} />
            <MiniStat label='Acc' value={`${acc}%`} />
          </div>
        )}

        <div className='mt-6 flex gap-3'>
          <button
            onClick={onPlayAgain}
            className='flex-1 rounded-lg bg-emerald-400 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
          >
            Play Again
          </button>
          <button
            onClick={onLobby}
            className='flex-1 rounded-lg border border-white/20 bg-white/5 px-5 py-3 text-sm font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-white/10'
          >
            Lobby
          </button>
        </div>
      </div>
    </div>
  );
}

function mapLabel(id: string): string {
  return MAPS.find((m) => m.id === id)?.label ?? id;
}

/* ───────────────────────── Map vote (end of match) ───────────────────────── */

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
    <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='w-[520px] max-w-[94vw] rounded-2xl border border-cyan-500/25 bg-zinc-950/95 p-7 font-mono shadow-2xl'>
        <div className='text-center text-2xl font-extrabold uppercase tracking-[0.2em] text-cyan-200'>
          Vote next map
        </div>
        <div className='mt-1 text-center text-[10px] uppercase tracking-[0.3em] text-white/45'>
          {remainingSec.toFixed(0)}s · {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
        </div>
        <div className='mt-5 flex flex-col gap-2.5'>
          {vote.options.map((id) => {
            const count = vote.counts[id] ?? 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const mine = vote.myVote === id;
            return (
              <button
                key={id}
                onClick={() => onVote(id)}
                className={`relative overflow-hidden rounded-lg border px-4 py-3 text-left transition ${
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
                  <span className='text-sm font-semibold uppercase tracking-[0.12em] text-white'>
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
        <div className='mt-4 text-center text-[10px] uppercase tracking-[0.2em] text-white/35'>
          {vote.myVote ? 'Vote locked — you can change it' : 'Click a map to vote'}
        </div>
      </div>
    </div>
  );
}

// Build a shareable ?join= invite URL for a room code (used by the invite modal
// and the waiting-for-opponents overlay).
function inviteLink(roomId: string): string {
  if (typeof window === 'undefined') return `?join=${roomId}`;
  return `${window.location.origin}${window.location.pathname}?join=${roomId}`;
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
    <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='w-[460px] max-w-[94vw] rounded-2xl border border-cyan-500/25 bg-zinc-950/95 p-7 text-center font-mono shadow-2xl'>
        <div className='flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] text-cyan-200'>
          <span className='inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.85)]' />
          Waiting for opponents
        </div>
        <div className='mt-3 text-xl font-bold text-white'>You&apos;re the only one here</div>
        <p className='mt-2 text-sm text-white/55'>
          The match starts the moment another player joins. Share the link to fill the lobby.
        </p>
        <div className='mt-5 flex items-center gap-2'>
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className='min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-white/80 outline-none'
          />
          <button
            onClick={copy}
            className='rounded bg-cyan-300 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-cyan-200'
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {roomId && (
          <div className='mt-2 text-[10px] uppercase tracking-[0.16em] text-white/40'>
            Lobby code: <span className='text-white/80'>{roomId}</span>
          </div>
        )}
        <button
          onClick={onLeave}
          className='mt-6 w-full rounded-lg border border-white/20 bg-white/5 px-5 py-3 text-sm font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-white/10'
        >
          Leave to Lobby
        </button>
      </div>
    </div>
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
    <div className='absolute inset-0 z-40 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='w-[400px] max-w-[92vw] rounded-2xl border border-rose-500/30 bg-zinc-950/95 p-7 text-center font-mono shadow-2xl'>
        <div className='text-lg font-bold uppercase tracking-[0.16em] text-rose-300'>
          Couldn&apos;t join
        </div>
        <p className='mt-3 text-sm text-white/65'>{message}</p>
        <div className='mt-6 flex gap-3'>
          {onRetry && (
            <button
              onClick={onRetry}
              className='flex-1 rounded-lg bg-emerald-400 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
            >
              Try Again
            </button>
          )}
          <button
            onClick={onLeave}
            className={`flex-1 rounded-lg px-5 py-3 text-sm font-semibold uppercase tracking-[0.16em] transition ${
              onRetry
                ? 'border border-white/20 bg-white/5 text-white hover:bg-white/10'
                : 'bg-emerald-400 font-bold text-zinc-950 hover:bg-emerald-300'
            }`}
          >
            Back to Lobby
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── HUD layout ───────────────────────── */

function HudOverlay({ hud, settings }: { hud: HudState; settings: Settings }) {
  const dead = hud.killcam !== null;
  return (
    <div className='pointer-events-none absolute inset-0 select-none'>
      {!dead && <BoostRing active={hud.boostReady} />}
      {!dead && <Crosshair cfg={settings.crosshair} />}
      {!dead && <ReloadBar railCooldown={hud.railCooldown} />}
      {!dead && <HitMarkerLayer marker={hud.hitMarker} />}
      <Killfeed entries={hud.killfeed} />
      <ToastStack toasts={hud.toasts} />
      <MiniLeaderboard scores={hud.scores} />
      {hud.mode === 'tdm' && hud.teamScores && (
        <TeamScoreBar scores={hud.teamScores} localTeam={hud.localTeam} />
      )}
      {hud.mode === 'duel' && hud.duel && <DuelRoundHud duel={hud.duel} />}
      <BannerOverlay banner={hud.banner} />
      <KillConfirmOverlay confirm={hud.killConfirm} />
      <KillcamOverlay killcam={hud.killcam} />
      {!dead && <SpeedAndStreak speed={hud.speed} streak={hud.currentStreak} />}
      {!dead && (
        <CooldownCluster
          railCooldown={hud.railCooldown}
          dashCooldown={hud.dashCooldown}
          airJumpsLeft={hud.airJumpsLeft}
        />
      )}
      {settings.showFps && <FpsCounter fps={hud.fps} />}
      {hud.netStatus !== 'off' && (
        <NetStatusPill status={hud.netStatus} peers={hud.netPeers} rttMs={hud.netRttMs} />
      )}
      {hud.netStatus !== 'off' && hud.localInvulnMs > 0 && (
        <InvulnPill remainingMs={hud.localInvulnMs} />
      )}
      {hud.showScoreboard && (
        <FullScoreboard scores={hud.scores} netStatus={hud.netStatus} mode={hud.mode} />
      )}
    </div>
  );
}

function InvulnPill({ remainingMs }: { remainingMs: number }) {
  const secs = (remainingMs / 1000).toFixed(1);
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
      <div className='absolute left-1/2 top-6 -translate-x-1/2 flex items-center gap-2 rounded-full border border-cyan-300/60 bg-cyan-300/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-100 backdrop-blur-sm'>
        <span className='inline-block h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.85)]' />
        <span>Invuln</span>
        <span className='tabular-nums text-white/90'>{secs}s</span>
      </div>
    </>
  );
}

function KillConfirmOverlay({ confirm }: { confirm: KillConfirm | null }) {
  if (!confirm) return null;
  const t = 1 - confirm.remaining / confirm.total;
  const enter = Math.min(1, t / 0.12);
  const exit = confirm.remaining < 0.4 ? clamp01(confirm.remaining / 0.4) : 1;
  const opacity = enter * exit;
  const scale = 0.9 + 0.12 * enter;
  const ty = (1 - enter) * 8;
  const verb = confirm.headshot ? 'Headshot' : 'Gibbed';
  const verbColor = confirm.headshot ? 'text-amber-300' : 'text-rose-300';
  const glow = confirm.headshot
    ? 'drop-shadow(0 0 14px rgba(252,211,77,0.55))'
    : 'drop-shadow(0 0 14px rgba(244,63,94,0.55))';
  return (
    <div
      key={confirm.id}
      className='absolute inset-x-0 flex justify-center'
      style={{ top: 'calc(50% + 64px)' }}
    >
      <div
        className='flex items-baseline gap-3 font-mono'
        style={{ opacity, transform: `translateY(${ty}px) scale(${scale})` }}
      >
        <span
          className={`text-base font-extrabold uppercase tracking-[0.22em] ${verbColor}`}
          style={{ filter: glow }}
        >
          {verb}
        </span>
        <span className='text-lg font-bold tracking-wide text-white'>
          {confirm.victimName}
        </span>
      </div>
    </div>
  );
}

function KillcamOverlay({ killcam }: { killcam: KillcamState | null }) {
  if (!killcam) return null;
  const t = 1 - killcam.remaining / killcam.total;
  const enter = Math.min(1, t / 0.18);
  const exit = killcam.remaining < 0.4 ? clamp01(killcam.remaining / 0.4) : 1;
  const opacity = enter * exit;
  return (
    <>
      <div
        className='absolute inset-0'
        style={{
          background:
            'radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.55) 100%)',
          opacity,
        }}
      />
      <div className='absolute inset-x-0 top-[18%] flex flex-col items-center text-center font-mono' style={{ opacity }}>
        <div className='text-[10px] uppercase tracking-[0.4em] text-white/55'>
          You were killed by
        </div>
        <div
          className='mt-2 text-4xl font-extrabold uppercase tracking-[0.08em] text-rose-300'
          style={{ filter: 'drop-shadow(0 0 22px rgba(244,63,94,0.55))' }}
        >
          {killcam.killerName}
        </div>
        <div className='mt-6 text-[11px] uppercase tracking-[0.3em] text-white/55'>
          Respawning in{' '}
          <span className='text-white'>{Math.max(0, killcam.remaining).toFixed(1)}s</span>
        </div>
      </div>
    </>
  );
}

function NetStatusPill({
  status,
  peers,
  rttMs,
}: {
  status: HudState['netStatus'];
  peers: number;
  rttMs: number;
}) {
  const color =
    status === 'open' ? 'bg-emerald-400/85 text-emerald-950' :
    status === 'connecting' ? 'bg-amber-400/85 text-amber-950' :
    status === 'closed' || status === 'error' ? 'bg-rose-400/85 text-rose-950' :
    'bg-white/15 text-white/70';
  const label =
    status === 'open' ? `LIVE · ${peers} · ${rttMs}ms` :
    status === 'connecting' ? 'connecting…' :
    status === 'closed' ? 'reconnecting' :
    status === 'error' ? 'error' :
    'offline';
  // Bottom-left (above the Speed readout): the top-right column is the killfeed +
  // FPS, and the pill used to paint over the 2nd killfeed row in any live match (#12).
  return (
    <div className={`absolute left-6 bottom-28 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${color}`}>
      {label}
    </div>
  );
}

/* ───────────────────────── TDM team score bar (top-center) ───────────────────────── */

// Compact Red vs Blue total-frag readout. Your team gets a "YOU" tag + a glowing
// outline so it's obvious which side you're on.
function TeamScoreBar({
  scores,
  localTeam,
}: {
  scores: [number, number];
  localTeam: number | null;
}) {
  return (
    <div className='absolute left-1/2 top-4 -translate-x-1/2'>
      <div className='flex items-stretch overflow-hidden rounded-lg border border-white/15 bg-black/60 font-mono backdrop-blur-sm'>
        {([0, 1] as const).map((team) => {
          const mine = localTeam === team;
          return (
            <div
              key={team}
              className='flex min-w-[88px] flex-col items-center px-4 py-1.5'
              style={{
                backgroundColor: mine ? `${TEAM_COLORS[team]}26` : 'transparent',
                boxShadow: mine ? `inset 0 0 0 1.5px ${TEAM_COLORS[team]}` : undefined,
              }}
            >
              <div className='flex items-center gap-1.5'>
                <span
                  className='text-[10px] font-bold uppercase tracking-[0.18em]'
                  style={{ color: TEAM_COLORS[team] }}
                >
                  {TEAM_NAMES[team]}
                </span>
                {mine && (
                  <span
                    className='rounded px-1 text-[8px] font-bold uppercase tracking-[0.1em] text-black'
                    style={{ backgroundColor: TEAM_COLORS[team] }}
                  >
                    You
                  </span>
                )}
              </div>
              <div
                className='text-2xl font-extrabold tabular-nums leading-none'
                style={{ color: TEAM_COLORS[team] }}
              >
                {scores[team]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── Duel round indicator (top-center) ───────────────────────── */

// "ROUND N" + a You vs Opp round tally rendered as pips (filled = won), first to
// roundsToWin takes the match.
function DuelRoundHud({ duel }: { duel: HudState['duel'] }) {
  if (!duel) return null;
  const { roundNum, roundsToWin, myWins, oppWins } = duel;
  const pips = (won: number, color: string) =>
    Array.from({ length: roundsToWin }).map((_, i) => (
      <span
        key={i}
        className='h-2.5 w-2.5 rounded-full'
        style={{
          backgroundColor: i < won ? color : 'rgba(255,255,255,0.15)',
          boxShadow: i < won ? `0 0 6px ${color}` : undefined,
        }}
      />
    ));
  return (
    <div className='absolute left-1/2 top-4 -translate-x-1/2'>
      <div className='flex flex-col items-center gap-1 rounded-lg border border-white/15 bg-black/60 px-5 py-1.5 font-mono backdrop-blur-sm'>
        <div className='text-[10px] font-bold uppercase tracking-[0.3em] text-white/70'>
          Round {roundNum}
        </div>
        <div className='flex items-center gap-3'>
          <span className='text-[10px] uppercase tracking-[0.16em] text-emerald-300'>You</span>
          <div className='flex items-center gap-1'>{pips(myWins, '#34d399')}</div>
          <span className='text-sm font-bold tabular-nums text-white/85'>
            {myWins}–{oppWins}
          </span>
          <div className='flex items-center gap-1'>{pips(oppWins, '#fb7185')}</div>
          <span className='text-[10px] uppercase tracking-[0.16em] text-rose-300'>Opp</span>
        </div>
        <div className='text-[9px] uppercase tracking-[0.2em] text-white/35'>
          First to {roundsToWin}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Crosshair + hit marker ───────────────────────── */

// Ratz "Boost Range Indicator": a ring around the crosshair that's a faint
// dashed hint when no surface is in range, and a bright glowing cyan ring the
// moment a boostable surface is under your aim (right-click to launch off it).
function BoostRing({ active }: { active: boolean }) {
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
}

// Renders a crosshair from a CrosshairConfig as a centered SVG. Reused by the
// in-game HUD and the settings preview so they're always identical.
function CrosshairGraphic({ cfg }: { cfg: CrosshairConfig }) {
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
}

function Crosshair({ cfg }: { cfg: CrosshairConfig }) {
  return (
    <div
      className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
      style={{ filter: `drop-shadow(0 0 3px ${cfg.color}66)` }}
    >
      <CrosshairGraphic cfg={cfg} />
    </div>
  );
}

function ReloadBar({ railCooldown }: { railCooldown: number }) {
  if (railCooldown <= 0) return null;
  const pct = clamp01(1 - railCooldown / RAIL_COOLDOWN);
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
          className='absolute left-0 top-0 h-full rounded-full bg-cyan-300/85 shadow-[0_0_6px_rgba(103,232,249,0.6)]'
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

function HitMarkerLayer({ marker }: { marker: HitMarker | null }) {
  if (!marker) return null;
  const max = marker.kind === 'hit' ? HIT_MARKER_DURATION_SEC : HIT_MARKER_KILL_DURATION_SEC;
  const t = 1 - marker.remaining / max;
  const scale = 1 + t * 0.35;
  const opacity = clamp01(marker.remaining / (max * 0.6));
  const stroke =
    marker.kind === 'headshot' ? '#facc15' :
    marker.kind === 'kill' ? '#fb7185' :
    '#ffffff';
  // Use flex centering — exact crosshair alignment regardless of marker
  // size or scale. The previous translate(-50%) math drifted off-pixel
  // when the wrapper's intrinsic size didn't match the SVG viewBox.
  return (
    <div
      key={marker.id}
      className='absolute inset-0 flex items-center justify-center'
    >
      <svg
        width='42'
        height='42'
        viewBox='0 0 42 42'
        aria-hidden
        style={{ opacity, transform: `scale(${scale})`, transformOrigin: '50% 50%' }}
      >
        <g
          stroke={stroke}
          strokeWidth='2.5'
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
}

/* ───────────────────────── Killfeed (top-right) ───────────────────────── */

function Killfeed({ entries }: { entries: KillfeedEntry[] }) {
  return (
    <div className='absolute right-6 top-6 flex w-72 flex-col items-end gap-1.5 font-mono text-[13px]'>
      {entries.map((e) => (
        <KillfeedRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

function KillfeedRow({ entry }: { entry: KillfeedEntry }) {
  const opacity = entry.remaining < 0.8 ? clamp01(entry.remaining / 0.8) : 1;
  const specialBadge =
    entry.special === 'headshot'
      ? { text: 'HS', color: 'bg-amber-400/85 text-amber-950' }
      : entry.special === 'mid-air'
        ? { text: 'AIR', color: 'bg-cyan-300/85 text-cyan-950' }
        : null;
  return (
    <div
      style={{ opacity }}
      className='flex items-center gap-2 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur-sm'
    >
      <span
        className={
          entry.killerLocal ? 'font-bold text-emerald-300' : 'text-white/85'
        }
      >
        {entry.killer}
      </span>
      <span className='text-rose-300/85'>◤</span>
      <span className='text-white/65'>{entry.victim}</span>
      {specialBadge && (
        <span
          className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wider ${specialBadge.color}`}
        >
          {specialBadge.text}
        </span>
      )}
    </div>
  );
}

/* ───────────── Toast stack (top-right, under killfeed) ───────────── */

function ToastStack({ toasts }: { toasts: ToastEntry[] }) {
  return (
    <div className='absolute right-6 top-40 flex flex-col items-end gap-1.5'>
      {toasts.map((t) => (
        <ToastChip key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastChip({ toast }: { toast: ToastEntry }) {
  const enter = Math.min(1, (toast.total - toast.remaining) / 0.18);
  const exit = toast.remaining < TOAST_FADE_SEC ? clamp01(toast.remaining / TOAST_FADE_SEC) : 1;
  const opacity = enter * exit;
  const tx = (1 - enter) * 8;
  const colors = tierColors(toast.tier);
  return (
    <div
      style={{ opacity, transform: `translateX(${tx}px)` }}
      className={`flex items-center gap-2 rounded-full border ${colors.border} bg-black/60 px-3 py-1 font-mono text-xs backdrop-blur-sm`}
    >
      <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${colors.text}`}>
        {toast.title}
      </span>
      {toast.subtitle && (
        <span className='text-[10px] text-white/55'>{toast.subtitle}</span>
      )}
    </div>
  );
}

/* ───────────────────────── Mini leaderboard (top-left) ───────────────────────── */

function MiniLeaderboard({ scores }: { scores: PlayerScore[] }) {
  const top = scores.slice(0, 5);
  return (
    <div className='absolute left-6 top-6 w-64 rounded-md border border-white/10 bg-black/55 px-3 py-2.5 font-mono text-[12px] backdrop-blur-sm'>
      <div className='mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-white/55'>
        <span>Leaderboard</span>
        <span>F · D · Acc</span>
      </div>
      <div className='flex flex-col gap-1'>
        {top.map((s, i) => (
          <div key={s.id} className='flex items-center justify-between gap-2'>
            <div className='flex min-w-0 items-center gap-2'>
              <span className='w-4 text-right text-white/40'>{i + 1}.</span>
              <span
                className={`truncate ${
                  s.isLocal ? 'font-bold text-emerald-300' : 'text-white/85'
                }`}
              >
                {s.name}
              </span>
              {s.currentStreak >= 3 && (
                <span className='rounded bg-amber-400/85 px-1 text-[9px] font-bold text-amber-950'>
                  {s.currentStreak}
                </span>
              )}
            </div>
            <div className='shrink-0 tabular-nums'>
              <span className='text-white'>{s.frags}</span>
              <span className='mx-1 text-white/30'>·</span>
              <span className='text-white/55'>{s.deaths}</span>
              <span className='mx-1 text-white/30'>·</span>
              <span className='text-cyan-200/80'>{formatAccuracy(s.accuracy)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className='mt-2 border-t border-white/10 pt-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40'>
        Tab — full scoreboard
      </div>
    </div>
  );
}

/* ───────────── Banner (top-center, BIG kill announce) ───────────── */

function BannerOverlay({ banner }: { banner: BannerState | null }) {
  if (!banner) return null;
  const t = 1 - banner.remaining / banner.total;
  const enter = Math.min(1, t / 0.12);
  const exit = banner.remaining < 0.4 ? clamp01(banner.remaining / 0.4) : 1;
  const scale = 0.85 + 0.15 * enter;
  const opacity = enter * exit;
  const colors = tierColors(banner.tier);
  return (
    // Robust centering: full-width flex row at fixed top offset. No translate
    // math, no left-1/2 vs intrinsic-width games.
    <div className='absolute inset-x-0 top-[12%] flex justify-center'>
      <div
        key={banner.id}
        style={{ transform: `scale(${scale})`, opacity, transformOrigin: '50% 50%' }}
        className='flex flex-col items-center text-center'
      >
        <div
          className={`bg-gradient-to-b ${colors.gradient} bg-clip-text font-mono text-[88px] font-black uppercase leading-[0.95] tracking-[0.04em] text-transparent`}
          style={{
            textShadow: `0 4px 28px ${colors.glow}`,
            WebkitTextStroke: `1px ${colors.stroke}`,
          }}
        >
          {banner.title}
        </div>
        <div className={`mt-2 h-[3px] w-28 rounded-full ${colors.bar}`} />
        {banner.subtitle && (
          <div className='mt-2 font-mono text-sm uppercase tracking-[0.4em] text-white/75'>
            {banner.subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Speed + streak (bottom-left) ───────────────────────── */

function SpeedAndStreak({ speed, streak }: { speed: number; streak: number }) {
  return (
    <div className='absolute bottom-6 left-6 font-mono'>
      <div className='text-[10px] uppercase tracking-[0.25em] text-white/55'>Speed</div>
      <div className='text-3xl font-bold tabular-nums leading-none'>{speed.toFixed(1)}</div>
      {streak >= 2 && (
        <div className='mt-3 flex items-center gap-2'>
          <span className='text-[10px] uppercase tracking-[0.25em] text-amber-300/85'>Streak</span>
          <span className='text-xl font-bold tabular-nums text-amber-200'>{streak}</span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Cooldown cluster (bottom-right) ───────────────────────── */

function CooldownCluster({
  railCooldown,
  dashCooldown,
  airJumpsLeft,
}: {
  railCooldown: number;
  dashCooldown: number;
  airJumpsLeft: number;
}) {
  return (
    <div className='absolute bottom-6 right-6 flex items-end gap-3'>
      <CooldownPip label='Rail' value={railCooldown} max={RAIL_COOLDOWN} ready={railCooldown === 0} accent='#67e8f9' />
      <CooldownPip label='Dash' value={dashCooldown} max={DASH_COOLDOWN} ready={dashCooldown === 0} accent='#fcd34d' />
      <AirJumpPip left={airJumpsLeft} max={AIR_JUMPS} />
    </div>
  );
}

function CooldownPip({
  label,
  value,
  max,
  ready,
  accent,
}: {
  label: string;
  value: number;
  max: number;
  ready: boolean;
  accent: string;
}) {
  const pct = clamp01(value / max);
  const R = 14;
  const C = 2 * Math.PI * R;
  return (
    <div className='flex flex-col items-center gap-1 font-mono'>
      <div className='relative h-12 w-12'>
        <svg viewBox='0 0 32 32' className='h-full w-full -rotate-90'>
          <circle cx='16' cy='16' r={R} fill='none' stroke='rgba(255,255,255,0.12)' strokeWidth='3' />
          <circle
            cx='16'
            cy='16'
            r={R}
            fill='none'
            stroke={ready ? accent : 'rgba(255,255,255,0.4)'}
            strokeWidth='3'
            strokeDasharray={C}
            strokeDashoffset={pct * C}
            strokeLinecap='round'
          />
        </svg>
        <div className='absolute inset-0 flex items-center justify-center text-[11px] font-bold'>
          {ready ? '●' : value.toFixed(1)}
        </div>
      </div>
      <div className='text-[10px] uppercase tracking-[0.16em] text-white/55'>{label}</div>
    </div>
  );
}

function AirJumpPip({ left, max }: { left: number; max: number }) {
  return (
    <div className='flex flex-col items-center gap-1 font-mono'>
      <div className='flex h-12 items-end gap-1 pb-1'>
        {Array.from({ length: max }).map((_, i) => (
          <div
            key={i}
            className={`h-3 w-3 rounded-full transition-colors ${
              i < left ? 'bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]' : 'bg-white/15'
            }`}
          />
        ))}
      </div>
      <div className='text-[10px] uppercase tracking-[0.16em] text-white/55'>Air</div>
    </div>
  );
}

/* ───────────────────────── FPS counter ───────────────────────── */

function FpsCounter({ fps }: { fps: number }) {
  const color = fps >= 55 ? 'text-emerald-300' : fps >= 30 ? 'text-amber-300' : 'text-rose-300';
  return (
    <div className='absolute right-6 top-2 font-mono text-[11px] tabular-nums text-white/70'>
      <span className={`mr-1 font-bold ${color}`}>{fps}</span>
      <span className='text-white/40'>fps</span>
    </div>
  );
}

/* ───────────────────────── Full scoreboard (Tab held) ───────────────────────── */

function FullScoreboard({
  scores,
  netStatus,
  mode,
}: {
  scores: PlayerScore[];
  netStatus: HudState['netStatus'];
  mode: GameMode;
}) {
  const title = netStatus !== 'off' ? 'Instagib Arena — Online' : 'Instagib Arena';
  const tag = mode === 'tdm' ? 'TDM' : mode === 'duel' ? 'Duel' : 'FFA';
  const isTeam = mode === 'tdm';
  return (
    <div className='absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm'>
      <div className='w-[640px] max-w-[92vw] rounded-xl border border-white/15 bg-zinc-950/85 p-6 font-mono shadow-2xl'>
        <div className='mb-4 flex items-end justify-between'>
          <div>
            <div className='text-[10px] uppercase tracking-[0.3em] text-white/55'>{tag}</div>
            <div className='text-xl font-semibold'>{title}</div>
          </div>
          <div className='text-[10px] uppercase tracking-[0.25em] text-white/45'>Hold Tab</div>
        </div>
        {isTeam ? (
          <div className='flex flex-col gap-5'>
            {([0, 1] as const).map((team) => (
              <TeamScoreSection
                key={team}
                team={team}
                players={scores.filter((s) => s.team === team)}
              />
            ))}
            {scores.some((s) => s.team == null) && (
              <ScoreTable players={scores.filter((s) => s.team == null)} />
            )}
          </div>
        ) : (
          <ScoreTable players={scores} />
        )}
      </div>
    </div>
  );
}

// A scoreboard table body (header + rows). Reused for the flat FFA/Duel
// scoreboard and each TDM team section.
function ScoreTable({
  players,
  teamColor,
}: {
  players: PlayerScore[];
  teamColor?: string;
}) {
  return (
    <div className='grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 gap-y-1 text-[12px]'>
      <Th>Player</Th>
      <Th align='right'>Frags</Th>
      <Th align='right'>Deaths</Th>
      <Th align='right'>K/D</Th>
      <Th align='right'>Acc</Th>
      <Th align='right'>Best Streak</Th>
      {players.map((s) => (
        <ScoreboardRow key={s.id} score={s} nameColor={teamColor} />
      ))}
    </div>
  );
}

// A TDM team block: a colored header with the team's total frags, then the
// roster (names tinted in the team color).
function TeamScoreSection({
  team,
  players,
}: {
  team: number;
  players: PlayerScore[];
}) {
  const color = TEAM_COLORS[team] ?? '#ffffff';
  const total = players.reduce((sum, s) => sum + s.frags, 0);
  return (
    <div>
      <div
        className='mb-2 flex items-center justify-between rounded-md px-3 py-1.5'
        style={{ backgroundColor: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}55` }}
      >
        <span
          className='text-sm font-bold uppercase tracking-[0.2em]'
          style={{ color }}
        >
          {TEAM_NAMES[team] ?? `Team ${team}`}
        </span>
        <span className='text-sm font-bold tabular-nums' style={{ color }}>
          {total}
        </span>
      </div>
      <ScoreTable players={players} teamColor={color} />
    </div>
  );
}

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

function ScoreboardRow({ score, nameColor }: { score: PlayerScore; nameColor?: string }) {
  const kd =
    score.deaths === 0
      ? score.frags.toFixed(1)
      : (score.frags / Math.max(1, score.deaths)).toFixed(2);
  // Local player always stays emerald + bold (so "you" reads at a glance); other
  // players use the team tint in TDM, falling back to the neutral default.
  const useTeamTint = !score.isLocal && nameColor != null;
  return (
    <>
      <div className='flex items-center gap-2 py-1.5'>
        <span
          className={`truncate ${
            score.isLocal ? 'font-bold text-emerald-300' : useTeamTint ? 'font-semibold' : 'text-white/90'
          }`}
          style={useTeamTint ? { color: nameColor } : undefined}
        >
          {score.name}
        </span>
        {score.currentStreak >= 3 && (
          <span className='rounded bg-amber-400/85 px-1 text-[9px] font-bold text-amber-950'>
            ON FIRE
          </span>
        )}
      </div>
      <div className='py-1.5 text-right tabular-nums'>{score.frags}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{score.deaths}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{kd}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{formatAccuracy(score.accuracy)}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{score.bestStreak}</div>
    </>
  );
}

// Accuracy as a compact percent, or an em-dash when unknown (remotes) / no shots.
function formatAccuracy(acc: number | null | undefined): string {
  return acc == null ? '—' : `${Math.round(acc)}%`;
}

/* ───────────────────────── Click to play / paused ───────────────────────── */

function ClickToPlay({
  onPlay,
  onOpenSettings,
  onLeave,
  hud,
  settings,
}: {
  onPlay: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
  hud: HudState;
  settings: Settings;
}) {
  const inMatch = hud.netStatus !== 'off' ? 'Live match' : `First to ${MATCH_FRAG_LIMIT} frags`;
  const kb = settings.keybinds;
  // Build the controls hint from the actual bindings so it stays correct after a
  // rebind (#26f). Move = the 4 movement keys; the rest follow their bindings.
  const moveKeys = [kb.forward, kb.left, kb.back, kb.right].map(keyLabel).join('');
  const controls = `${moveKeys} move · ${keyLabel(kb.jump)} jump · ${keyLabel(kb.dash)} dash · RMB boost · LMB fire · ${keyLabel(kb.scoreboard)} scores · Esc menu`;
  return (
    <div className='absolute inset-0 flex flex-col items-center justify-center bg-black/75 text-white backdrop-blur-sm pointer-events-auto'>
      <div className='text-[11px] uppercase tracking-[0.35em] text-white/55'>
        Instagib Arena · {inMatch}
      </div>
      <div className='mt-3 text-3xl font-semibold'>Click to play</div>
      <div className='mt-2 text-sm text-white/60'>{controls}</div>
      <div className='mt-8 flex items-center gap-3'>
        <button
          onClick={onPlay}
          className='rounded-md bg-emerald-400 px-8 py-3 font-mono text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
        >
          Play
        </button>
        <button
          onClick={onOpenSettings}
          className='rounded-md border border-white/20 bg-white/5 px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-white/10'
        >
          Settings
        </button>
        <button
          onClick={onLeave}
          className='rounded-md border border-rose-400/50 bg-rose-400/10 px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.16em] text-rose-200 transition hover:bg-rose-400/20'
        >
          Leave
        </button>
      </div>
      {hud.frags > 0 && (
        <div className='mt-8 grid grid-cols-3 gap-6 text-center font-mono'>
          <Stat label='Frags' value={hud.frags} />
          <Stat label='Best streak' value={hud.bestStreak} />
          <Stat label='Top speed' value={hud.speed.toFixed(1)} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className='text-[10px] uppercase tracking-[0.25em] text-white/45'>{label}</div>
      <div className='text-2xl font-bold tabular-nums'>{value}</div>
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

type InstagibStats = {
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
};

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

async function submitMatchStats(result: MatchResult) {
  try {
    // Stats are keyed server-side by an anonymous per-browser cookie; the name
    // is cosmetic (for a future leaderboard), so send the local display name.
    await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ...result, name: savedPlayerName() }),
    });
  } catch {
    // Best-effort — ignore network errors so play never blocks on stats.
  }
}

function Lobby({
  settings,
  onChangeSettings,
  onStart,
  lastResult,
}: {
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onStart: (config: MatchConfig) => void;
  lastResult: MatchResult | null;
}) {
  const [soloOpen, setSoloOpen] = useState(false);
  const [createOnlineOpen, setCreateOnlineOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [lobbyStatus, setLobbyStatus] = useState<LobbyStatus>('connecting');
  const [invite, setInvite] = useState<{ roomId: string; mapId: string } | null>(null);
  const [searching, setSearching] = useState(false); // quick-match in flight (#26e)
  // Selected online game mode for Quick Match + Create Match (FFA / Duel / TDM).
  const [selectedMode, setSelectedMode] = useState<GameMode>(DEFAULT_GAME_MODE);

  const serverUrl = settings.serverUrl || defaultServerUrl();
  const lobbyRef = useRef<LobbyClient | null>(null);

  const startOnline = useCallback(
    (roomId: string, mapId: string) =>
      onStart({ mode: 'multiplayer', mapId, serverUrl, roomId }),
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
    lobby.connect();
    return () => {
      lobby.dispose();
      lobbyRef.current = null;
    };
    // Reconnect (and re-bind onResolved → startOnline) when the Server URL
    // setting changes, so a custom URL isn't silently ignored until reload (#18).
    // playerName is handled by the cheap setName effect below — not a dep here,
    // so typing a name doesn't churn the socket.
  }, [serverUrl, startOnline]);

  // Keep the server-side display name fresh without reconnecting.
  useEffect(() => {
    lobbyRef.current?.setName(settings.playerName || 'Player');
  }, [settings.playerName]);

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

  return (
    <div className='deck-bg deck-scan fixed inset-0 z-50 overflow-hidden text-white'>
      <div className='relative mx-auto flex h-full w-full max-w-6xl flex-col gap-4 px-5 py-5 sm:px-8 sm:py-6'>
        {/* ── Top status bar ─────────────────────────────────────────── */}
        <header className='deck-rise flex items-center gap-3' style={{ animationDelay: '0ms' }}>
          <h1
            className='font-display text-3xl font-bold uppercase leading-none tracking-[0.16em] text-cyan-300 sm:text-[2.5rem]'
            style={{ filter: 'drop-shadow(0 0 18px rgba(34,211,238,0.45))' }}
          >
            Instagib
          </h1>
          <span className='font-display mt-0.5 text-xs font-semibold uppercase tracking-[0.55em] text-white/35'>
            Arena
          </span>
          <div className='ml-auto flex items-center gap-3'>
            <span className='hidden font-mono text-[10px] uppercase tracking-[0.2em] text-white/40 sm:inline'>
              {settings.playerName || 'Player'}
            </span>
            <ServerStatusChip status={lobbyStatus} />
          </div>
        </header>
        <div className='h-px w-full shrink-0 bg-gradient-to-r from-cyan-400/50 via-white/10 to-transparent' />

        {/* ── Main grid: actions (left) · live feed (right) ──────────── */}
        <main className='grid min-h-0 flex-1 gap-4 lg:grid-cols-[1.15fr_0.85fr]'>
          {/* Left — mode + actions */}
          <section className='deck-scroll flex min-h-0 flex-col gap-3 overflow-y-auto pr-1'>
            <p className='deck-rise text-sm leading-relaxed text-white/50' style={{ animationDelay: '60ms' }}>
              One railgun. One shot. Pure movement — strafe, dash, wall-jump.
            </p>

            {touchOnly && (
              <div className='clip-deck-sm border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-center text-[12px] text-amber-100'>
                Instagib needs a <span className='font-bold'>mouse + keyboard</span>. Open this on a
                desktop to play.
              </div>
            )}

            <div className='deck-rise' style={{ animationDelay: '120ms' }}>
              <ModePicker value={selectedMode} onChange={setSelectedMode} />
            </div>

            {/* Primary CTA */}
            <button
              onClick={() => {
                if (searching || !online || playDisabled) return; // double-fire guard
                setSearching(true);
                lobbyRef.current?.quickMatch(selectedMode);
                // Safety reset if the server never resolves (it normally navigates
                // away via onResolved, unmounting this view).
                window.setTimeout(() => setSearching(false), 6000);
              }}
              disabled={!online || playDisabled || searching}
              className='clip-deck deck-rise bg-emerald-400 px-6 py-5 text-left font-display text-lg font-bold uppercase tracking-[0.18em] text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40'
              style={{ animationDelay: '180ms' }}
            >
              <span className='flex items-center gap-3'>
                <span className='text-2xl leading-none'>▶</span>
                {searching ? 'Searching…' : 'Quick Match'}
                <span className='ml-auto font-mono text-[11px] font-semibold tracking-[0.1em] text-zinc-950/60'>
                  {modeLabel(selectedMode)}
                </span>
              </span>
            </button>

            {/* Secondary actions */}
            <div className='deck-rise grid grid-cols-2 gap-3' style={{ animationDelay: '240ms' }}>
              <DeckButton onClick={() => setCreateOnlineOpen(true)} disabled={!online || playDisabled} accent='cyan'>
                + Create Match
              </DeckButton>
              <DeckButton
                onClick={() =>
                  onStart({
                    mode: 'local',
                    mapId: 'training',
                    botCount: 4,
                    difficulty: settings.difficulty,
                    training: true,
                  })
                }
                disabled={playDisabled}
                accent='amber'
              >
                ⌖ Practice Range
              </DeckButton>
              <div className='col-span-2'>
                <DeckButton onClick={() => setSoloOpen(true)} disabled={playDisabled} full>
                  ◭ Solo vs Bots
                </DeckButton>
              </div>
              <div className='col-span-2 grid grid-cols-3 gap-3'>
                <DeckButton onClick={() => setStatsOpen(true)}>Stats</DeckButton>
                <DeckButton onClick={() => setLeaderboardOpen(true)}>Leaderboard</DeckButton>
                <DeckButton onClick={() => setSettingsOpen(true)} accent='cyan'>
                  ⚙ Settings
                </DeckButton>
              </div>
            </div>

            {lastResult && <LastMatchBanner result={lastResult} />}
          </section>

          {/* Right — live lobby feed */}
          <aside className='deck-rise min-h-0' style={{ animationDelay: '200ms' }}>
            <OpenLobbies
              rooms={rooms}
              online={online}
              onJoin={(r) => startOnline(r.id, r.mapId)}
              onRefresh={() => lobbyRef.current?.refresh()}
            />
          </aside>
        </main>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className='flex shrink-0 items-center justify-between border-t border-white/10 pt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/35'>
          <span>Quick match · up to {MAX_PLAYERS} players</span>
          <span className='text-white/25'>Instagib Arena</span>
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
      {leaderboardOpen && <LeaderboardModal onClose={() => setLeaderboardOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={onChangeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

// Short badge label for a mode (used in lobby rows + create modal).
function modeLabel(mode: GameMode): string {
  return GAME_MODES.find((m) => m.id === mode)?.label ?? mode;
}

// Angular command-deck action button. Accent tints the hover/border; `full`
// stretches it. Labels use the squared display face for the FPS-UI feel.
function DeckButton({
  onClick,
  disabled,
  accent = 'plain',
  full,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  accent?: 'cyan' | 'amber' | 'plain';
  full?: boolean;
  children: ReactNode;
}) {
  const tone =
    accent === 'cyan'
      ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:border-cyan-300/70 hover:bg-cyan-300/20'
      : accent === 'amber'
        ? 'border-amber-300/40 bg-amber-300/10 text-amber-100 hover:border-amber-300/70 hover:bg-amber-300/20'
        : 'border-white/12 bg-white/[0.04] text-white/85 hover:border-white/30 hover:bg-white/10';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`clip-deck-sm border px-5 py-3 text-left font-display text-sm font-semibold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${tone} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

// Compact mode badge — color-coded by mode for quick scanning in lobby rows.
function ModeBadge({ mode }: { mode: GameMode }) {
  const color =
    mode === 'tdm' ? 'bg-sky-300/20 text-sky-200' :
    mode === 'duel' ? 'bg-fuchsia-300/20 text-fuchsia-200' :
    'bg-emerald-300/20 text-emerald-200';
  const short = mode === 'tdm' ? 'TDM' : mode === 'duel' ? '1v1' : 'FFA';
  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.08em] ${color}`}>
      {short}
    </span>
  );
}

// Segmented game-mode picker for the main menu, mirroring the
// ButtonGroup/DifficultyPicker patterns used elsewhere.
function ModePicker({
  value,
  onChange,
}: {
  value: GameMode;
  onChange: (m: GameMode) => void;
}) {
  const blurb = GAME_MODES.find((m) => m.id === value)?.blurb ?? '';
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='font-mono text-[10px] uppercase tracking-[0.22em] text-white/45'>Mode</span>
      <div className='grid grid-cols-3 gap-2'>
        {GAME_MODES.map((m) => {
          const active = value === m.id;
          return (
            <button
              key={m.id}
              onClick={() => onChange(m.id)}
              className={`clip-deck-sm border px-3 py-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.1em] transition ${
                active
                  ? 'border-cyan-300/70 bg-cyan-300/15 text-cyan-100 shadow-[0_0_18px_-6px_rgba(34,211,238,0.9)]'
                  : 'border-white/12 bg-white/[0.03] text-white/55 hover:bg-white/10 hover:text-white/80'
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className='font-mono text-[10px] normal-case tracking-normal text-white/40'>{blurb}</div>
    </div>
  );
}

function ServerStatusChip({ status }: { status: LobbyStatus }) {
  const map = {
    open: { dot: 'bg-emerald-400', ring: 'border-emerald-400/40 text-emerald-200', t: 'Online' },
    connecting: { dot: 'bg-amber-400', ring: 'border-amber-400/40 text-amber-200', t: 'Linking' },
    closed: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline' },
    error: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline' },
  } as const;
  const s = map[status];
  return (
    <span
      className={`clip-deck-sm inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.18em] ${s.ring}`}
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
  onRefresh,
}: {
  rooms: LobbyRoom[];
  online: boolean;
  onJoin: (r: LobbyRoom) => void;
  onRefresh: () => void;
}) {
  return (
    <div className='clip-deck flex h-full min-h-0 flex-col border border-white/10 bg-black/40 backdrop-blur-sm'>
      <div className='flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3'>
        <span className='font-display text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-200/90'>
          Live Lobbies
          {online && rooms.length > 0 && (
            <span className='ml-2 font-mono text-white/40'>[{rooms.length}]</span>
          )}
        </span>
        <button
          onClick={onRefresh}
          disabled={!online}
          className='font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300/70 transition hover:text-cyan-200 disabled:opacity-40'
        >
          ↻ Refresh
        </button>
      </div>
      <div className='deck-scroll min-h-0 flex-1 overflow-y-auto p-3'>
        {!online ? (
          <div className='flex h-full items-center justify-center px-4 py-10 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/30'>
            Linking to server…
          </div>
        ) : rooms.length === 0 ? (
          <div className='flex h-full items-center justify-center px-6 py-10 text-center font-mono text-[11px] uppercase leading-relaxed tracking-[0.12em] text-white/30'>
            No open lobbies — start one with Quick&nbsp;Match or Create.
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
                      <span className='rounded-sm bg-cyan-300/20 px-1.5 py-0.5 text-cyan-200'>voting</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onJoin(r)}
                  disabled={!r.joinable}
                  className='clip-deck-sm shrink-0 bg-emerald-400 px-4 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40'
                >
                  {r.joinable ? 'Join' : 'Full'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
  const [copied, setCopied] = useState<'idle' | 'ok' | 'selected'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
      setTimeout(() => setCopied('idle'), 1500);
    } catch {
      // Clipboard API blocked (insecure context / permission) — select the
      // field so the user can copy manually instead of a silent no-op (#26c).
      inputRef.current?.select();
      setCopied('selected');
      setTimeout(() => setCopied('idle'), 2500);
    }
  };
  return (
    <ModalShell title='Private Match' onClose={onClose}>
      <p className='text-sm text-white/60'>
        Share this link with friends — it drops them straight into your lobby.
      </p>
      <div className='flex items-center gap-2'>
        <input
          ref={inputRef}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className='min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-white/80 outline-none'
        />
        <button
          onClick={copy}
          className='shrink-0 rounded bg-cyan-300 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-cyan-200'
        >
          {copied === 'ok' ? 'Copied!' : copied === 'selected' ? 'Selected' : 'Copy'}
        </button>
      </div>
      <div className='text-[10px] uppercase tracking-[0.16em] text-white/40'>
        Lobby code: <span className='text-white/80'>{roomId}</span>
      </div>
      <button
        onClick={onEnter}
        className='mt-1 rounded-md bg-emerald-400 px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
      >
        Enter Match
      </button>
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
            className='w-full accent-emerald-400'
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
      <div className='text-[10px] normal-case tracking-normal text-white/40'>
        {isPublic
          ? 'Public matches appear in Open Lobbies for anyone to join.'
          : 'Private matches are invite-only — you’ll get a link to share.'}
      </div>
      <button
        onClick={create}
        className='mt-1 rounded-md bg-emerald-400 px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
      >
        {isPublic ? 'Create & Play' : 'Create & Get Link'}
      </button>
    </ModalShell>
  );
}

function LastMatchBanner({ result }: { result: MatchResult }) {
  const acc = result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  return (
    <div
      className={`mt-5 rounded-lg border px-4 py-3 ${
        result.won ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-white/12 bg-white/5'
      }`}
    >
      <div
        className={`text-xs font-bold uppercase tracking-[0.2em] ${
          result.won ? 'text-emerald-300' : 'text-white/70'
        }`}
      >
        {result.won ? 'Victory' : 'Match complete'}
      </div>
      <div className='mt-2 grid grid-cols-4 gap-2 text-center'>
        <MiniStat label='Kills' value={result.kills} />
        <MiniStat label='Deaths' value={result.deaths} />
        <MiniStat label='Streak' value={result.bestStreak} />
        <MiniStat label='Acc' value={`${acc}%`} />
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className='text-[9px] uppercase tracking-[0.2em] text-white/40'>{label}</div>
      <div className='text-lg font-bold tabular-nums'>{value}</div>
    </div>
  );
}

// Escape-to-close for modal dialogs (#20). Bubble phase on purpose: the
// keybind-rebind listener captures Escape (capture phase + stopPropagation) to
// cancel a rebind, so registering here in the capture phase would race it and
// close the whole modal instead. The in-game InputManager leaves Escape unbound,
// so a bubble-phase handler is safe.
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscapeToClose(onClose);
  return (
    <div
      className='absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md pointer-events-auto'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className='clip-deck deck-rise w-[440px] max-w-[92vw] border border-cyan-500/30 bg-zinc-950/95 p-6 shadow-[0_0_60px_-12px_rgba(34,211,238,0.4)]'
      >
        <div className='mb-5 flex items-center justify-between border-b border-white/10 pb-3'>
          <div className='font-display text-base font-bold uppercase tracking-[0.18em] text-cyan-100'>
            {title}
          </div>
          <button
            onClick={onClose}
            className='font-mono text-[11px] uppercase tracking-[0.18em] text-white/55 transition hover:text-cyan-200'
          >
            ✕ Esc
          </button>
        </div>
        <div className='flex flex-col gap-5 font-mono'>{children}</div>
      </div>
    </div>
  );
}

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

  const start = () => {
    onChangeSettings({ ...settings, mapId, difficulty });
    onStart({ mode: 'local', mapId, botCount: Math.max(0, players - 1), difficulty });
  };

  return (
    <ModalShell title='Solo vs Bots' onClose={onClose}>
      <SelectField label='Arena' value={mapId} options={MAPS} onChange={setMapId} />
      <label className='flex flex-col gap-1.5'>
        <div className='flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-white/65'>
          <span>Players</span>
          <span className='tabular-nums text-white/85'>
            {players} ({players - 1} {players - 1 === 1 ? 'bot' : 'bots'})
          </span>
        </div>
        <input
          type='range'
          min={2}
          max={MAX_PLAYERS}
          step={1}
          value={players}
          onChange={(e) => setPlayers(Number(e.target.value))}
          className='w-full accent-emerald-400'
        />
      </label>
      <DifficultyPicker value={difficulty} onChange={setDifficulty} />
      <button
        onClick={start}
        className='mt-1 rounded-md bg-emerald-400 px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
      >
        Start Match
      </button>
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
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`rounded-md border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
              value === o
                ? 'border-emerald-400 bg-emerald-400/15 text-emerald-200'
                : 'border-white/15 bg-white/5 text-white/65 hover:bg-white/10'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatsModal({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<InstagibStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('stats unavailable'))))
      .then((d: { stats?: InstagibStats }) => {
        if (!active) return;
        setStats(d.stats ?? null);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  const kd =
    stats && stats.totalDeaths > 0
      ? (stats.totalKills / stats.totalDeaths).toFixed(2)
      : String(stats?.totalKills ?? 0);

  return (
    <ModalShell title='Your Instagib Stats' onClose={onClose}>
      {state === 'loading' && <div className='text-sm text-white/55'>Loading…</div>}
      {state === 'error' && (
        <div className='text-sm text-white/55'>
          Couldn&apos;t load stats. Sign in and finish a match to start tracking.
        </div>
      )}
      {state === 'ready' && stats && (
        <div className='grid grid-cols-2 gap-3'>
          <BigStat label='Kills' value={stats.totalKills} />
          <BigStat label='Deaths' value={stats.totalDeaths} />
          <BigStat label='K / D' value={kd} />
          <BigStat label='Wins' value={`${stats.totalWins} / ${stats.totalGames}`} />
          <BigStat label='Best streak' value={stats.bestKillStreak} />
          <BigStat label='Headshots' value={stats.headshots} />
        </div>
      )}
    </ModalShell>
  );
}

function BigStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className='rounded-lg border border-white/10 bg-white/5 px-4 py-3'>
      <div className='text-[10px] uppercase tracking-[0.2em] text-white/45'>{label}</div>
      <div className='mt-1 text-2xl font-bold tabular-nums text-cyan-200'>{value}</div>
    </div>
  );
}

/* ───────────────────────── Global leaderboard modal ───────────────────────── */

type LeaderboardSort = 'kills' | 'wins' | 'accuracy';

type LeaderboardEntry = {
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number;
};

const LEADERBOARD_SORTS: ReadonlyArray<{ id: LeaderboardSort; label: string }> = [
  { id: 'kills', label: 'Kills' },
  { id: 'wins', label: 'Wins' },
  { id: 'accuracy', label: 'Accuracy' },
];

function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const [sort, setSort] = useState<LeaderboardSort>('kills');
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    setState('loading');
    fetch(`/api/leaderboard?sort=${sort}&limit=25`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('leaderboard unavailable'))))
      .then((d: { leaderboard?: LeaderboardEntry[] }) => {
        if (!active) return;
        setRows(Array.isArray(d.leaderboard) ? d.leaderboard : []);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [sort]);

  return (
    <ModalShell title='Leaderboard' onClose={onClose}>
      <ButtonGroup
        label='Sort by'
        value={sort}
        options={LEADERBOARD_SORTS}
        onChange={setSort}
      />
      {state === 'loading' && <div className='text-sm text-white/55'>Loading…</div>}
      {state === 'error' && (
        <div className='text-sm text-white/55'>Couldn&apos;t load the leaderboard. Try again later.</div>
      )}
      {state === 'ready' && rows.length === 0 && (
        <div className='text-sm text-white/55'>No ranked players yet — finish a match to appear here.</div>
      )}
      {state === 'ready' && rows.length > 0 && (
        <div className='-mx-1 max-h-[52vh] overflow-y-auto px-1'>
          <div className='grid grid-cols-[1.75rem_1fr_2.75rem_2.75rem_2.5rem_3rem] gap-x-3 gap-y-1 text-[12px]'>
            <Th align='right'>#</Th>
            <Th>Player</Th>
            <Th align='right'>K</Th>
            <Th align='right'>K/D</Th>
            <Th align='right'>W</Th>
            <Th align='right'>Acc</Th>
            {rows.map((row, i) => (
              <LeaderboardRow key={`${row.userName}-${i}`} rank={i + 1} row={row} />
            ))}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function LeaderboardRow({ rank, row }: { rank: number; row: LeaderboardEntry }) {
  const medal =
    rank === 1 ? 'text-amber-300' : rank === 2 ? 'text-zinc-300' : rank === 3 ? 'text-orange-300' : 'text-white/45';
  return (
    <>
      <div className={`py-1.5 text-right tabular-nums font-bold ${medal}`}>{rank}</div>
      <div className='truncate py-1.5 text-white/90'>{row.userName}</div>
      <div className='py-1.5 text-right tabular-nums'>{row.totalKills}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.kd.toFixed(2)}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.totalWins}</div>
      <div className='py-1.5 text-right tabular-nums text-cyan-200/80'>{row.bestAccuracy.toFixed(1)}%</div>
    </>
  );
}

/* ───────────────────────── Settings modal ───────────────────────── */

function SettingsModal({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const ch = settings.crosshair;
  const setCh = (patch: Partial<CrosshairConfig>) =>
    onChange({ ...settings, crosshair: { ...ch, ...patch } });
  useEscapeToClose(onClose);
  return (
    <div
      className='absolute inset-0 z-10 flex items-center justify-center bg-black/85 backdrop-blur-md pointer-events-auto'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-label='Settings'
        onClick={(e) => e.stopPropagation()}
        className='flex max-h-[88vh] w-[480px] max-w-[92vw] flex-col rounded-xl border border-white/12 bg-zinc-950/95 p-6 font-mono shadow-2xl'
      >
        <div className='mb-5 flex items-center justify-between'>
          <div className='text-base font-semibold uppercase tracking-[0.18em]'>
            Settings
          </div>
          <button
            onClick={onClose}
            className='text-[11px] uppercase tracking-[0.18em] text-white/55 transition hover:text-white'
          >
            Close
          </button>
        </div>
        <div className='flex flex-col gap-5 overflow-y-auto pr-1'>
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
          <ToggleField
            label='Show FPS'
            value={settings.showFps}
            onChange={(v) => onChange({ ...settings, showFps: v })}
          />

          <Section label='Weapon viewmodel'>
            <ToggleField
              label='Hide viewmodel'
              value={settings.hideViewmodel}
              onChange={(v) => onChange({ ...settings, hideViewmodel: v })}
            />
            {!settings.hideViewmodel && (
              <>
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
              The railgun sits centered &amp; low so it never blocks your aim. Bind “Zoom (hold)”
              under Keybinds to narrow your FOV.
            </div>
          </Section>

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
              label='Announcer'
              value={settings.announcerEnabled}
              onChange={(v) => onChange({ ...settings, announcerEnabled: v })}
            />
            {settings.announcerEnabled && (
              <SliderField
                label='Announcer volume'
                value={settings.announcerVolume}
                min={0}
                max={1}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => onChange({ ...settings, announcerVolume: v })}
              />
            )}
          </Section>

          <Section label='Crosshair'>
            <div className='flex flex-col gap-1.5'>
              <span className='font-mono text-[10px] uppercase tracking-[0.22em] text-white/45'>
                Presets
              </span>
              <div className='grid grid-cols-3 gap-2'>
                {CROSSHAIR_SHAPE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setCh(p.cfg)}
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
              <div className='flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[#1a1f29]'>
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

          <Section label='Visuals'>
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
          </Section>

          <Section label='Profile &amp; LAN'>
            <TextField
              label='Player name'
              value={settings.playerName}
              placeholder='Player'
              maxLength={24}
              onChange={(v) => onChange({ ...settings, playerName: v })}
            />
            <TextField
              label='Server URL (blank = this server)'
              value={settings.serverUrl}
              placeholder='wss://your-server.example/ws/instagib'
              onChange={(v) => onChange({ ...settings, serverUrl: v.trim() })}
            />
          </Section>
        </div>
        <div className='mt-6 flex items-center justify-between border-t border-white/10 pt-4'>
          <button
            onClick={() => onChange(DEFAULT_SETTINGS)}
            className='text-[11px] uppercase tracking-[0.18em] text-white/55 transition hover:text-white'
          >
            Reset to defaults
          </button>
          <button
            onClick={onClose}
            className='rounded-md bg-emerald-400 px-5 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-950 transition hover:bg-emerald-300'
          >
            Done
          </button>
        </div>
      </div>
    </div>
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
        className='w-full accent-emerald-400'
      />
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
        className='rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-xs text-white outline-none transition focus:border-emerald-400/70'
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} className='bg-zinc-900 text-white'>
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
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className='flex flex-col gap-1.5'>
      <span className='text-[11px] uppercase tracking-[0.16em] text-white/65'>{label}</span>
      <input
        type='text'
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className='rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-xs text-white outline-none transition focus:border-emerald-400/70'
      />
    </label>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className='flex cursor-pointer items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'>
      <span>{label}</span>
      <button
        type='button'
        role='switch'
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-6 w-11 rounded-full transition ${
          value ? 'bg-emerald-400' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${
            value ? 'left-6' : 'left-1'
          }`}
        />
      </button>
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
      <div className='flex flex-wrap gap-1.5'>
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`rounded-md border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition ${
              value === o.id
                ? 'border-emerald-400 bg-emerald-400/15 text-emerald-200'
                : 'border-white/15 bg-white/5 text-white/65 hover:bg-white/10'
            }`}
          >
            {o.label}
          </button>
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
          onChange={(e) => onChange(e.target.value)}
          className='h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent p-0'
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
            className='h-6 w-6 rounded border border-white/20 transition hover:scale-110'
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
          className='flex h-14 items-center justify-center overflow-hidden rounded-md border border-white/10'
          style={{ backgroundColor: bg }}
        >
          <CrosshairGraphic cfg={cfg} />
        </div>
      ))}
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
  const [msg, setMsg] = useState<string | null>(null);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 1500);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flash('Copied!');
    } catch {
      flash('Copy failed');
    }
  };
  const doImport = () => {
    const next = decodeCrosshair(paste);
    if (next) {
      onImport(next);
      setPaste('');
      flash('Imported!');
    } else {
      flash('Invalid code');
    }
  };

  return (
    <div className='flex flex-col gap-2 rounded-md border border-white/10 bg-black/30 p-3'>
      <div className='flex items-center justify-between'>
        <span className='text-[10px] uppercase tracking-[0.16em] text-white/55'>Share code</span>
        {msg && (
          <span className='text-[10px] uppercase tracking-[0.14em] text-emerald-300'>{msg}</span>
        )}
      </div>
      <div className='flex items-center gap-2'>
        <input
          readOnly
          value={code}
          onFocus={(e) => e.currentTarget.select()}
          className='min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-white/80 outline-none'
        />
        <button
          onClick={copy}
          className='rounded bg-emerald-400 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-emerald-300'
        >
          Copy
        </button>
      </div>
      <div className='flex items-center gap-2'>
        <input
          value={paste}
          placeholder='Paste a share code…'
          onChange={(e) => setPaste(e.target.value)}
          className='min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-white outline-none transition focus:border-emerald-400/70'
        />
        <button
          onClick={doImport}
          disabled={!paste.trim()}
          className='rounded border border-cyan-300/50 bg-cyan-300/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40'
        >
          Import
        </button>
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
        className='w-24 rounded border border-white/15 bg-black/40 px-2 py-1 text-right font-mono text-xs text-white outline-none transition focus:border-emerald-400/70'
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
            onClick={() => setListening(id)}
            className={`min-w-[5.5rem] rounded border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] transition ${
              listening === id
                ? 'animate-pulse border-emerald-400 bg-emerald-400/15 text-emerald-200'
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

function clamp01(n: number) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

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
