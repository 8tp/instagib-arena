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
import { prefersReducedMotion, sfxProps, toast, useModalStack } from './deck-core';
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
  rankedTier,
  rankedTierName,
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
  CardPayload,
  ChatLine,
  HitMarker,
  HudState,
  KillFlash,
  KillcamState,
  KillfeedEntry,
  MapVoteState,
  MedalTier,
  PlayerScore,
  PomState,
  ToastEntry,
  TrainingHud,
} from './game/types';
import { FragPopup } from './game/kill-overlays';
import { PodiumScene, type PodiumWinner } from './game/podium';
import { CharacterPreview, type PreviewCosmetics } from './game/character-preview';
import {
  KILL_EFFECTS,
  RAIL_COLORS,
  RAILGUN_FINISHES,
  HATS,
  UNUSUALS,
  CARD_STYLES,
  EMOTES,
  NAME_COLORS,
  SPAWN_EFFECTS,
  TITLES,
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
  cardById,
  cosmeticById,
  HAT_CASE_COST,
  caseHats,
  hatById,
  sourceLabel,
  titleById,
  type KillEffectStyle,
  type Rarity,
  type CosmeticSource,
  type HatCosmetic,
} from './game/cosmetics';
import { levelProgress } from './game/progression';

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

type Settings = {
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
  volume: number; // master
  sfxVolume: number;
  announcerVolume: number;
  announcerEnabled: boolean;
  announcerPack: AnnouncerPackId; // which announcer voice pack (legacy = default procedural)
  captions: boolean; // a11y: show announcer/medal/match callouts as on-screen text
  showFps: boolean;
  showPing: boolean; // show each player's ping in the Tab scoreboard (online)
  fpsLimit: number; // 0 = VSync (display), >0 = cap to N fps, -1 = uncapped
  resolutionScale: number; // render resolution multiplier (perf ↔ sharpness)
  lowSpec: boolean; // cap high-DPI at 1× + thin particle effects
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
  | { mode: 'multiplayer'; mapId: string; serverUrl: string; roomId: string }
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
  volume: DEFAULT_VOLUME,
  sfxVolume: 1,
  announcerVolume: 1,
  announcerEnabled: true,
  announcerPack: DEFAULT_ANNOUNCER_PACK,
  captions: false,
  showFps: false,
  showPing: true,
  fpsLimit: 0,
  resolutionScale: 1,
  lowSpec: false,
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

// Rarity → accent color for cosmetic cards in the Locker.
const RARITY_STYLE: Record<'common' | 'rare' | 'epic', string> = {
  common: 'text-white/45',
  rare: 'text-sky-300',
  epic: 'text-fuchsia-300',
};

// Career stats a player can show on their playercard (the kill banner).
const CARD_STAT_DEFS: ReadonlyArray<{
  key: string;
  label: string;
  from: (p: InstagibProfile) => string;
}> = [
  { key: 'kills', label: 'KILLS', from: (p) => String(p.stats.totalKills) },
  { key: 'deaths', label: 'DEATHS', from: (p) => String(p.stats.totalDeaths) },
  { key: 'wins', label: 'WINS', from: (p) => String(p.stats.totalWins) },
  { key: 'games', label: 'GAMES', from: (p) => String(p.stats.totalGames) },
  {
    key: 'kd',
    label: 'K/D',
    from: (p) =>
      p.stats.totalDeaths > 0
        ? (p.stats.totalKills / p.stats.totalDeaths).toFixed(2)
        : String(p.stats.totalKills),
  },
  { key: 'streak', label: 'BEST STREAK', from: (p) => String(p.stats.bestKillStreak) },
  { key: 'headshots', label: 'HEADSHOTS', from: (p) => String(p.stats.headshots) },
  { key: 'accuracy', label: 'ACCURACY', from: (p) => `${Math.round(p.stats.bestAccuracy)}%` },
  // Ranked Elo — "Unranked" until you've played a ranked match.
  { key: 'rating', label: 'RANKED', from: (p) => (p.ranked ? String(p.ranked.rating) : 'Unranked') },
];

const MAX_CARD_STATS = 3;

function buildCardPayload(
  profile: InstagibProfile,
  settings: Settings,
  account?: Account,
): CardPayload {
  const stats = settings.cardStats
    .map((k) => CARD_STAT_DEFS.find((d) => d.key === k))
    .filter((d): d is (typeof CARD_STAT_DEFS)[number] => !!d)
    .slice(0, MAX_CARD_STATS)
    .map((d) => ({ label: d.label, value: d.from(profile) }));
  // A dynamic ranked title resolves to the live standing locally for the preview +
  // the player's own kill-confirm card; the server re-forces it on the killcard
  // others see, so this can't be faked.
  const titleDef = titleById(settings.title);
  const title = titleDef.dynamic === 'ranked' ? rankedStandingText(profile.ranked) : titleDef.text;
  // Badges mirror the account (server overrides them on the killcard others see,
  // so this only drives the local Locker preview). Guests carry neither.
  return {
    name: settings.playerName || 'Player',
    level: profile.level,
    style: settings.card,
    stats,
    title,
    verified: !!account?.isVerified,
    admin: !!account?.isAdmin,
  };
}

// Pick up to 3 career stats for the playercard, with a live preview.
function CardStatsEditor({
  settings,
  onChange,
  account,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  account?: Account;
}) {
  const [profile, setProfile] = useState<InstagibProfile | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (active && d.profile) setProfile(d.profile);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const toggle = (key: string) => {
    const cur = settings.cardStats;
    let next: string[];
    if (cur.includes(key)) next = cur.filter((k) => k !== key);
    else if (cur.length < MAX_CARD_STATS) next = [...cur, key];
    else next = [...cur.slice(1), key]; // at the cap → drop the oldest
    onChange({ ...settings, cardStats: next });
  };

  const preview: CardPayload = profile
    ? buildCardPayload(profile, settings, account)
    : {
        name: settings.playerName || 'Player',
        level: 1,
        style: settings.card,
        stats: settings.cardStats.map((k) => ({
          label: CARD_STAT_DEFS.find((d) => d.key === k)?.label ?? k.toUpperCase(),
          value: '—',
        })),
        title: titleById(settings.title).text,
        verified: !!account?.isVerified,
        admin: !!account?.isAdmin,
      };

  return (
    <Section label='Card Stats'>
      <div className='flex justify-center py-1'>
        <PlayerCard card={preview} size='small' reduced={settings.reducedEffects} />
      </div>
      <div className='grid grid-cols-2 gap-2'>
        {CARD_STAT_DEFS.map((d) => (
          <SegButton key={d.key} active={settings.cardStats.includes(d.key)} onClick={() => toggle(d.key)}>
            {d.label}
          </SegButton>
        ))}
      </div>
      <p className='text-[10px] normal-case tracking-normal text-white/40'>
        Pick up to {MAX_CARD_STATS}. This card is shown to a player on their killcam
        when you frag them — your graphic, level, and stats.
      </p>
    </Section>
  );
}

// The kill banner: an unlockable card graphic + the player's level + their chosen
// stats. Shown on the killcam (the killer's card) and as your own kill-confirm flex.
/* ── Player badges: staff crown + verified blue check. Server-authoritative —
   these components are purely presentational. Shown beside player names on the
   scoreboard, the leaderboard, and the playercard. (Extensible: future badges
   slot in here.) ── */
function VerifiedBadge({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox='0 0 24 24' role='img' aria-label='Verified'
      className='inline-block shrink-0 align-[-0.15em]'
    >
      <title>Verified</title>
      <circle cx='12' cy='12' r='11' fill='#3b9eff' />
      <path
        d='M6.5 12.5l3.4 3.4L17.6 8.4' fill='none' stroke='#fff' strokeWidth='2.5'
        strokeLinecap='round' strokeLinejoin='round'
      />
    </svg>
  );
}
function AdminBadge({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox='0 0 24 24' role='img' aria-label='Staff'
      className='inline-block shrink-0 align-[-0.15em]'
    >
      <title>Staff</title>
      <path
        d='M2.6 8.4l4 3.3L12 4.6l5.4 7.1 4-3.3-1.7 10H4.3z'
        fill='#ffcf3f' stroke='#7a5a10' strokeWidth='1.1' strokeLinejoin='round'
      />
      <circle cx='2.6' cy='8.4' r='1.4' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
      <circle cx='21.4' cy='8.4' r='1.4' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
      <circle cx='12' cy='4.6' r='1.5' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
    </svg>
  );
}
// Crown (admin) then check (verified), placed to the right of a player name.
function NameBadges({
  admin,
  verified,
  size,
}: {
  admin?: boolean;
  verified?: boolean;
  size?: number;
}) {
  if (!admin && !verified) return null;
  return (
    <span className='inline-flex shrink-0 items-center gap-0.5'>
      {admin && <AdminBadge size={size} />}
      {verified && <VerifiedBadge size={size} />}
    </span>
  );
}

function PlayerCard({
  card,
  size = 'normal',
  reduced = false,
}: {
  card: CardPayload;
  size?: 'normal' | 'small';
  reduced?: boolean;
}) {
  const style = cardById(card.style);
  const small = size === 'small';
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-white/15 font-mono shadow-2xl ${
        small ? 'w-[260px] p-3' : 'w-[340px] p-4'
      } ${reduced ? 'reduced-effects' : ''}`}
      style={{ background: style.bg }}
    >
      <div className='absolute inset-0 bg-black/10' />
      {/* Animated motion layer (epic+ cards) — sits over the static gradient,
          under the content; CSS suppresses it under reduced motion/effects. */}
      {style.anim && <div className={`pcard-anim pcard-anim-${style.anim}`} aria-hidden />}
      <div className='relative flex items-center gap-3'>
        <div
          className='flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border'
          style={{ borderColor: style.accent, color: style.accent, background: 'rgba(0,0,0,0.25)' }}
        >
          <span className='text-[7px] uppercase tracking-[0.16em] opacity-80'>Lvl</span>
          <span className='text-lg font-extrabold leading-none'>{card.level}</span>
        </div>
        <div className='min-w-0 flex-1'>
          <div className={`flex items-center gap-1 font-bold text-white ${small ? 'text-sm' : 'text-lg'}`}>
            <span className='truncate'>{card.name}</span>
            <NameBadges admin={card.admin} verified={card.verified} size={small ? 13 : 16} />
          </div>
          {card.title ? (
            <div
              className='truncate text-[10px] font-semibold uppercase tracking-[0.18em]'
              style={{ color: style.accent }}
            >
              {card.title}
            </div>
          ) : (
            <div className='text-[9px] uppercase tracking-[0.2em] text-white/55'>Instagib Arena</div>
          )}
        </div>
      </div>
      {card.stats.length > 0 && (
        <div className='relative mt-3 flex gap-2'>
          {card.stats.map((s, i) => (
            <div
              key={i}
              className='flex flex-1 flex-col items-center rounded-md bg-black/30 px-1 py-1.5'
            >
              <span className='text-base font-extrabold tabular-nums' style={{ color: style.accent }}>
                {s.value}
              </span>
              <span className='text-[8px] uppercase tracking-[0.1em] text-white/55'>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  game.setKeybinds?.(s.keybinds);
  game.setFov?.(s.fov);
  game.setZoomFov?.(s.zoomFov);
  game.setViewmodel?.(s.viewmodelOffset, s.hideViewmodel);
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
  killFlash: null,
  damageFlash: 0,
  killcam: null,
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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<'lobby' | 'playing'>('lobby');
  const [config, setConfig] = useState<MatchConfig | null>(null);
  const [lastResult, setLastResult] = useState<MatchResult | null>(null);
  // Bumped on every match start so GameView remounts a fresh Game (also for
  // "Play Again" with the same config).
  const [playId, setPlayId] = useState(0);
  // First-run onboarding (pick a name + a controls primer), shown once.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // A ?join= invite arriving on the FIRST run is held here until onboarding is
  // done, so a first-time invitee still sees the controls primer before locking.
  const pendingJoinRef = useRef<MatchConfig | null>(null);

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
  // sliders as gameplay audio, so muting SFX also mutes the deck chrome.
  useEffect(() => {
    setUiVolume(settings.volume, settings.sfxVolume);
  }, [settings.volume, settings.sfxVolume]);

  // Your in-game name is your identity: the account username when logged in,
  // or "Guest" otherwise. This is the source of truth (overrides any old local
  // name) so guests always read "Guest" and accounts always read their handle.
  useEffect(() => {
    if (!auth.ready) return;
    const name = auth.account?.username ?? 'Guest';
    setSettings((s) => (s.playerName === name ? s : { ...s, playerName: name }));
  }, [auth.ready, auth.account]);

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endResult, setEndResult] = useState<MatchResult | null>(null);
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
  const [joinError, setJoinError] = useState<string | null>(null);
  // Ranked Duel end-of-match result (rating delta) → full-screen overlay.
  const [rankedResult, setRankedResult] = useState<RankedResult | null>(null);
  // Weekly-challenge end-of-run standing (rank/best) → small result banner.
  const [challengeResult, setChallengeResult] = useState<WeeklyChallengeMe | null>(null);
  // Online: the results podium is shown briefly at match-end BEFORE the map vote.
  // We freeze the final standings here so a late snapshot can't change the podium.
  const [onlineResults, setOnlineResults] = useState(false);
  const [podiumScores, setPodiumScores] = useState<PlayerScore[]>([]);
  const offlineMatch = config.mode !== 'multiplayer';
  // Weekly-challenge run: submits the speedrun (time/kills) + full replay to the
  // weekly board, NOT career K/D. The engine owns the authoritative run time.
  const isChallenge = config.mode === 'local' && config.challenge === true;

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
      } else {
        void submitMatchStats(result, offlineMatch, game.getMatchModeTag()).then((p) => {
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
    game.setNetEventListener((ev: NetMatchEvent) => {
      if (ev.type === 'join-failed') {
        setJoinError(
          ev.reason === 'full'
            ? 'That lobby is full.'
            : 'That lobby no longer exists.',
        );
      } else if (ev.type === 'ranked-result') {
        setRankedResult(ev.result);
      }
    });
    applySettingsToGame(game, settings);
    applyMatchConfig(game, config);
    void game.start();
    // Bulletproof activation: ?netdebug in the URL turns the overlay on with no
    // keypress (so a macOS F3/Mission-Control conflict can't block it).
    if (new URLSearchParams(window.location.search).has('netdebug')) game.toggleNetDebug();
    return () => {
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
    if (!isChallenge && r && game?.hasRecordableStats()) {
      void submitMatchStats(r, offlineMatch, game.getMatchModeTag());
    }
    onExit(r);
  }, [onExit, offlineMatch, isChallenge]);

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
      {!hud.pom && <HudOverlay store={hudStore} settings={settings} />}
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
          onContinue={() => setOnlineResults(false)}
        />
      )}
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
        />
      )}
      {rankedResult && (
        <RankedResultOverlay
          result={rankedResult}
          progression={endProgression}
          onLobby={() => {
            exitFullscreen();
            onExit(endResult);
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
    void game.start();
    return () => {
      gameRef.current?.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; settings re-applied below
  }, []);

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
        <FullScoreboard
          scores={hud.scores}
          netStatus={hud.netStatus}
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
    </div>
  );
}

type LockerProfile = {
  unlocked: string[];
  credits: number;
  equipped: Record<string, string>;
  level: number;
};

type LockerItem = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
};
type LockerSlotDef = {
  slot:
    | 'killEffect'
    | 'railColor'
    | 'railgunFinish'
    | 'hat'
    | 'unusual'
    | 'card'
    | 'emote'
    | 'nameColor'
    | 'spawnEffect'
    | 'title';
  label: string;
  items: readonly LockerItem[];
  current: (s: Settings) => string;
  apply: (s: Settings, id: string) => Settings;
};
const LOCKER_SLOTS: LockerSlotDef[] = [
  {
    slot: 'killEffect',
    label: 'Kill Effect',
    items: KILL_EFFECTS,
    current: (s) => s.killEffect,
    apply: (s, id) => ({ ...s, killEffect: id as KillEffectStyle }),
  },
  {
    slot: 'railColor',
    label: 'Rail Beam',
    items: RAIL_COLORS,
    current: (s) => s.railColor,
    apply: (s, id) => ({ ...s, railColor: id }),
  },
  {
    slot: 'railgunFinish',
    label: 'Railgun Finish',
    items: RAILGUN_FINISHES,
    current: (s) => s.railgunFinish,
    apply: (s, id) => ({ ...s, railgunFinish: id }),
  },
  {
    slot: 'spawnEffect',
    label: 'Spawn Effect',
    items: SPAWN_EFFECTS,
    current: (s) => s.spawnEffect,
    apply: (s, id) => ({ ...s, spawnEffect: id }),
  },
  {
    slot: 'hat',
    label: 'Hat',
    items: HATS,
    current: (s) => s.hat,
    apply: (s, id) => ({ ...s, hat: id }),
  },
  {
    slot: 'unusual',
    label: 'Unusual Effect',
    items: UNUSUALS,
    current: (s) => s.unusual,
    apply: (s, id) => ({ ...s, unusual: id }),
  },
  {
    slot: 'nameColor',
    label: 'Name Color',
    items: NAME_COLORS,
    current: (s) => s.nameColor,
    apply: (s, id) => ({ ...s, nameColor: id }),
  },
  {
    slot: 'title',
    label: 'Title',
    items: TITLES,
    current: (s) => s.title,
    apply: (s, id) => ({ ...s, title: id }),
  },
  {
    slot: 'card',
    label: 'Player Card',
    items: CARD_STYLES,
    current: (s) => s.card,
    apply: (s, id) => ({ ...s, card: id }),
  },
  {
    slot: 'emote',
    label: 'Podium Emote',
    items: EMOTES,
    current: (s) => s.emote,
    apply: (s, id) => ({ ...s, emote: id }),
  },
];

// The Locker: pick your equipped cosmetics across every slot. Server-backed —
// owned items can be equipped, credit-priced ones bought, level-gated ones show
// their unlock. Degrades to local-only selection if the profile can't be
// fetched (offline / no backend), so the picker always works.
// Per-tab focus → the preview shows ONE thing, framed for that slot:
//  character = hat + unusual, head-zoomed, slowly turning
//  emote     = the equipped emote on the whole player model
//  weapon    = just the railgun firing the rail beam (colour) into a kill burst
type LockerView = 'character' | 'emote' | 'weapon';

// Live 3D preview of the equipped loadout for a single Locker tab. A fresh
// instance mounts per tab (so only one WebGL context runs at a time).
function LockerPreview({ settings, view }: { settings: Settings; view: LockerView }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const cosmetics = (): PreviewCosmetics => ({
    hatId: settings.hat,
    unusualId: settings.unusual,
    emoteId: settings.emote,
    railColor: settings.railColor,
    railgunFinish: settings.railgunFinish,
    killEffect: settings.killEffect,
    view,
  });
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const preview = new CharacterPreview(canvas, cosmetics());
    previewRef.current = preview;
    preview.start();
    const onResize = () => preview.resize();
    window.addEventListener('resize', onResize);
    // Track the canvas box itself so the preview stays crisp when the panel
    // reflows (open/close, tab switch, responsive width) — not just on window
    // resize. rAF-debounced to coalesce layout bursts.
    let pending = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => preview.resize());
    });
    ro.observe(canvas);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(pending);
      ro.disconnect();
      preview.dispose();
      previewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => {
    previewRef.current?.setCosmetics(cosmetics());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hat, settings.unusual, settings.emote, settings.railColor, settings.railgunFinish, settings.killEffect, view]);
  return (
    <div className='clip-deck-sm relative h-60 w-full shrink-0 overflow-hidden border border-white/10 bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
      <canvas ref={ref} className='block h-full w-full' />
      <div className='pointer-events-none absolute bottom-1.5 right-3 text-[9px] uppercase tracking-[0.18em] text-white/35'>
        Live preview
      </div>
    </div>
  );
}

const LOCKER_TABS = [
  { id: 'character', label: 'Character', slots: ['hat', 'unusual', 'nameColor', 'title'], view: 'character' as const },
  { id: 'emote', label: 'Emotes', slots: ['emote'], view: 'emote' as const },
  { id: 'weapon', label: 'Weapon', slots: ['railColor', 'railgunFinish', 'killEffect', 'spawnEffect'], view: 'weapon' as const },
  { id: 'card', label: 'Card', slots: ['card'], view: null },
] as const;
type LockerTab = (typeof LOCKER_TABS)[number]['id'];

function Locker({
  settings,
  onChange,
  onClose,
  account,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  account?: Account;
}) {
  const [profile, setProfile] = useState<LockerProfile | null>(null);
  // 'loading' until /api/profile answers: the grid shows a skeleton instead of
  // a flash of "everything owned" that then snaps to locks. 'offline' = no
  // backend → local-only selection (everything equippable, nothing buyable).
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<LockerTab>('character');
  const [caseSpin, setCaseSpin] = useState<{ won: string; dupe: boolean; refund: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active) return;
        if (!d.profile) {
          setProfileState('offline');
          return;
        }
        const p = d.profile;
        setProfile({
          unlocked: p.unlocked ?? [],
          credits: p.credits ?? 0,
          equipped: p.equipped ?? {},
          level: p.level ?? 1,
        });
        setProfileState('ready');
        // Sync the server's equipped choices into the live game (once, on open).
        let patch: Settings | null = null;
        for (const sl of LOCKER_SLOTS) {
          const eq = p.equipped?.[sl.slot];
          if (eq && eq !== sl.current(settings) && (p.unlocked ?? []).includes(eq)) {
            patch = sl.apply(patch ?? settings, eq);
          }
        }
        if (patch) onChange(patch);
      })
      .catch(() => {
        /* offline / no backend → local-only selection below */
        if (active) setProfileState('offline');
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const owns = (id: string, source: CosmeticSource) =>
    !profile || profile.unlocked.includes(id) || source.type === 'default';

  const itemName = (id: string) => cosmeticById(id)?.name ?? id;

  // `quiet` skips the "Equipped" toast (buy() reports the purchase instead).
  const equip = async (sl: LockerSlotDef, id: string, quiet = false) => {
    if (!profile) {
      onChange(sl.apply(settings, id)); // local-only fallback
      if (!quiet) toast(`Equipped · ${itemName(id)}`, { tone: 'ok' });
      return;
    }
    setBusy(id);
    try {
      const res = await fetch('/api/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ slot: sl.slot, id }),
      });
      const d = (await res.json()) as { ok?: boolean; equipped?: Record<string, string> };
      if (res.ok && d.ok) {
        onChange(sl.apply(settings, id));
        setProfile((p) => (p ? { ...p, equipped: d.equipped ?? p.equipped } : p));
        if (!quiet) toast(`Equipped · ${itemName(id)}`, { tone: 'ok' });
      } else toast('Could not equip that.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const buy = async (sl: LockerSlotDef, id: string) => {
    setBusy(id);
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        credits?: number;
        unlocked?: string[];
      };
      if (res.ok && d.ok) {
        setProfile((p) =>
          p ? { ...p, credits: d.credits ?? p.credits, unlocked: d.unlocked ?? p.unlocked } : p,
        );
        toast(`Unlocked + equipped · ${itemName(id)}`, { tone: 'ok' });
        await equip(sl, id, true);
      } else toast(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not buy that.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const openCase = async () => {
    if (busy || (profile != null && profile.credits < HAT_CASE_COST)) return;
    setBusy('__case');
    try {
      const res = await fetch('/api/shop/open-case', { method: 'POST', credentials: 'same-origin' });
      const d = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        won?: string;
        dupe?: boolean;
        refund?: number;
        credits?: number;
        unlocked?: string[];
      };
      if (res.ok && d.ok && d.won) {
        // Apply the new credits/unlocked now; the spinner reveals the win.
        setProfile((p) =>
          p ? { ...p, credits: d.credits ?? p.credits, unlocked: d.unlocked ?? p.unlocked } : p,
        );
        setCaseSpin({ won: d.won, dupe: !!d.dupe, refund: d.refund ?? 0 });
      } else toast(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not open the case.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const active = LOCKER_TABS.find((t) => t.id === tab) ?? LOCKER_TABS[0];
  const slots = LOCKER_SLOTS.filter((sl) => (active.slots as readonly string[]).includes(sl.slot));
  const loading = profileState === 'loading';
  return (
    <>
    <LockerShell tab={tab} setTab={setTab} credits={profile?.credits ?? null} loading={loading} onClose={onClose}>
      <p className='text-[10px] leading-relaxed text-white/35'>
        Cosmetics — purely visual, never affect aim, movement, or hits.
      </p>
      {active.view && <LockerPreview key={active.view} settings={settings} view={active.view} />}
      {tab === 'card' && <CardStatsEditor settings={settings} onChange={onChange} account={account} />}
      {slots.map((sl) => (
        <div key={sl.slot} className='flex flex-col gap-2' aria-busy={loading}>
          <div className='deck-label'>{sl.label}</div>
          {sl.slot === 'hat' && (
            <button
              type='button'
              onClick={openCase}
              disabled={loading || busy === '__case' || (profile != null && profile.credits < HAT_CASE_COST)}
              title={
                profile != null && profile.credits < HAT_CASE_COST
                  ? `Need ${HAT_CASE_COST - profile.credits} more credits — earn them by playing online matches`
                  : undefined
              }
              {...sfxProps('uiConfirm')}
              className='clip-deck-sm flex items-center justify-center gap-2 border border-amber-300/50 bg-gradient-to-r from-fuchsia-500/15 to-amber-400/15 px-3 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-amber-100 transition hover:from-fuchsia-500/25 hover:to-amber-400/25 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40'
            >
              🎁{' '}
              {busy === '__case'
                ? 'Opening…'
                : profile != null && profile.credits < HAT_CASE_COST
                  ? `Need ${HAT_CASE_COST - profile.credits} more ⛁`
                  : `Open Hat Case · ${HAT_CASE_COST} ⛁`}
            </button>
          )}
          <div className='grid grid-cols-2 gap-2'>
            {loading
              ? sl.items.slice(0, 4).map((item) => <LockerItemSkeleton key={item.id} />)
              : sl.items.map((item) => {
              const equipped = sl.current(settings) === item.id;
              const owned = owns(item.id, item.source);
              const buyable = !owned && item.source.type === 'credits';
              const affordable =
                !owned &&
                item.source.type === 'credits' &&
                profile != null &&
                profile.credits >= item.source.price;
              const working = busy === item.id;
              return (
                <div
                  key={item.id}
                  data-cosmetic={item.id}
                  data-state={equipped ? 'equipped' : owned ? 'owned' : buyable ? 'buyable' : 'locked'}
                  className={`deck-card flex flex-col px-3 py-2.5 ${
                    equipped ? 'deck-card-active' : owned ? '' : 'deck-card-muted'
                  }`}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className={`font-display text-[13px] font-semibold ${owned ? 'text-white' : 'text-white/60'}`}>
                      {item.name}
                    </span>
                    <span className={`text-[9px] uppercase tracking-[0.14em] ${RARITY_STYLE[item.rarity]}`}>
                      {item.rarity}
                    </span>
                  </div>
                  <div className='mt-1 flex-1 font-sans text-[11px] leading-snug text-white/50'>{item.blurb}</div>
                  <div className='mt-2.5'>
                    {equipped ? (
                      <div className='py-1 text-[9px] uppercase tracking-[0.18em] text-cyan-300'>
                        ✓ Equipped
                      </div>
                    ) : owned ? (
                      <DeckButton
                        data-action='equip'
                        disabled={working}
                        onClick={() => equip(sl, item.id)}
                        accent='cyan'
                        size='sm'
                        full
                        center
                      >
                        {working ? '…' : 'Equip'}
                      </DeckButton>
                    ) : buyable ? (
                      <DeckButton
                        data-action='buy'
                        disabled={working || !affordable}
                        onClick={() => buy(sl, item.id)}
                        accent='amber'
                        size='sm'
                        full
                        center
                        title={affordable ? undefined : 'Not enough credits'}
                      >
                        {working ? '…' : `Buy · ${item.source.type === 'credits' ? item.source.price : 0} ⛁`}
                      </DeckButton>
                    ) : (
                      <div className='py-1 text-[10px] uppercase tracking-[0.12em] text-white/35'>
                        🔒 {sourceLabel(item.source)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </LockerShell>
    {caseSpin && (
      <CaseSpinner
        won={caseSpin.won}
        dupe={caseSpin.dupe}
        refund={caseSpin.refund}
        onClose={() => setCaseSpin(null)}
      />
    )}
    </>
  );
}

// A placeholder tile the shape of a locker item, shown while the profile
// (ownership + credits) is still loading.
function LockerItemSkeleton() {
  return (
    <div className='deck-card flex flex-col px-3 py-2.5'>
      <div className='flex items-center justify-between gap-2'>
        <Skeleton className='h-3.5 w-24' />
        <Skeleton className='h-2 w-8' />
      </div>
      <Skeleton className='mt-2 h-2.5 w-full' />
      <Skeleton className='mt-1 h-2.5 w-3/4' />
      <Skeleton className='mt-3 h-7 w-full' />
    </div>
  );
}

// The Locker's frame: the shared ModalShell, wide, with a STICKY tab row +
// credits readout under the title so the tabs never scroll away, over a
// scrolling body.
function LockerShell({
  tab,
  setTab,
  credits,
  loading,
  onClose,
  children,
}: {
  tab: LockerTab;
  setTab: (t: LockerTab) => void;
  credits: number | null;
  loading: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalShell
      title='Locker'
      onClose={onClose}
      size='lg'
      scroll
      bodyClassName='gap-4'
      header={
        <div className='-mx-2 -mt-1 -mb-3 flex items-center justify-between gap-3'>
          <div role='tablist' aria-label='Locker categories' className='flex flex-wrap'>
            {LOCKER_TABS.map((t) => (
              <DeckTab key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </DeckTab>
            ))}
          </div>
          {loading ? (
            <Skeleton className='mr-2 h-3.5 w-14' />
          ) : (
            credits != null && (
              <span className='mr-2 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-amber-300'>
                {credits} ⛁
              </span>
            )
          )}
        </div>
      }
    >
      {children}
    </ModalShell>
  );
}

// Krunker-style unboxing roulette: a horizontal reel of hat cards that decelerates
// onto the server-decided winner under a center ticker, then reveals it.
function CaseSpinner({
  won,
  dupe,
  refund,
  onClose,
}: {
  won: string;
  dupe: boolean;
  refund: number;
  onClose: () => void;
}) {
  const LAND = 48; // index the winner is placed at in the reel
  const LEN = 56;
  const CARD = 104;
  const GAP = 8;
  const STRIDE = CARD + GAP;
  const reelRef = useRef<HatCosmetic[] | null>(null);
  if (!reelRef.current) {
    const pool = caseHats();
    const arr: HatCosmetic[] = [];
    for (let i = 0; i < LEN; i++) {
      arr.push(i === LAND ? hatById(won) : pool[Math.floor(Math.random() * pool.length)]);
    }
    reelRef.current = arr;
  }
  const reel = reelRef.current;
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const vpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vp = vpRef.current?.clientWidth ?? 480;
    const jitter = (Math.random() - 0.5) * (CARD * 0.55); // land slightly off-center for suspense
    const target = LAND * STRIDE + CARD / 2 - vp / 2 + jitter;
    const a = requestAnimationFrame(() => requestAnimationFrame(() => setOffset(-target)));
    const t = window.setTimeout(() => setRevealed(true), 4500);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wonHat = hatById(won);
  // Not dismissable until the reel has landed — the reveal is the payoff.
  return (
    <ModalShell
      label='Hat case'
      tone='fuchsia'
      fixed
      z='z-50'
      size='lg'
      backdrop='heavy'
      onClose={revealed ? onClose : undefined}
    >
      {({ close }) => (
        <>
          <div className='-mb-2 text-center text-[11px] uppercase tracking-[0.3em] text-fuchsia-200/80' aria-live='polite'>
            {revealed ? (dupe ? 'Duplicate' : 'Unboxed!') : 'Opening case…'}
          </div>
          <div ref={vpRef} className='relative h-28 overflow-hidden border border-white/10 bg-black/40'>
            <div className='pointer-events-none absolute left-1/2 top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.9)]' />
            <div
              className='absolute top-1/2 flex -translate-y-1/2 gap-2'
              style={{
                transform: `translateX(${offset}px)`,
                transition: offset !== 0 ? 'transform 4.4s cubic-bezier(0.12,0.85,0.18,1)' : 'none',
              }}
            >
              {reel.map((h, i) => (
                <HatReelCard key={i} hat={h} width={CARD} />
              ))}
            </div>
          </div>
          {revealed && (
            <div className='flex flex-col items-center gap-1 text-center'>
              <div className={`font-display text-xl font-bold uppercase tracking-[0.08em] ${RARITY_STYLE[wonHat.rarity]}`}>
                {wonHat.name}
              </div>
              <div className='text-[10px] uppercase tracking-[0.2em] text-white/45'>
                {wonHat.rarity} hat
              </div>
              {dupe && (
                <div className='mt-1 text-sm font-semibold text-amber-300'>
                  Duplicate — refunded {refund} ⛁
                </div>
              )}
              <DeckButton onClick={close} solid accent='emerald' center className='mt-3' data-autofocus>
                Nice
              </DeckButton>
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}

function HatReelCard({ hat, width }: { hat: HatCosmetic; width: number }) {
  const ring =
    hat.rarity === 'epic'
      ? 'border-fuchsia-400/60'
      : hat.rarity === 'rare'
        ? 'border-sky-400/50'
        : 'border-white/15';
  return (
    <div
      style={{ width }}
      className={`flex h-24 shrink-0 flex-col items-center justify-center gap-1 border-2 bg-white/[0.04] px-2 ${ring}`}
    >
      <span className='text-2xl'>🎩</span>
      <span className='line-clamp-2 text-center text-[10px] leading-tight text-white/80'>
        {hat.name}
      </span>
      <span className={`text-[8px] uppercase tracking-[0.12em] ${RARITY_STYLE[hat.rarity]}`}>
        {hat.rarity}
      </span>
    </div>
  );
}

// End-of-match XP moment: animated XP bar, +XP / +credits, a LEVEL UP flourish,
// and any new cosmetic unlocks. Driven entirely by the server's POST /api/stats
// response so the numbers are authoritative.
// Eased 0→value counter for the +XP / +credits roll-ups.
function useCountUp(value: number, durationMs = 1000, startDelayMs = 250): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (value <= 0) {
      setN(value);
      return;
    }
    let raf = 0;
    let startT = 0;
    const tick = (now: number) => {
      if (!startT) startT = now;
      const t = Math.min(1, (now - startT) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    const to = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, startDelayMs);
    return () => {
      window.clearTimeout(to);
      cancelAnimationFrame(raf);
    };
  }, [value, durationMs, startDelayMs]);
  return n;
}

function XpReward({ progression }: { progression: ProgressionResp }) {
  const lp = levelProgress(progression.progression.totalXp);
  const preLp = levelProgress(Math.max(0, progression.progression.totalXp - progression.xpGained));
  const pct = (l: ReturnType<typeof levelProgress>) =>
    l.xpForNext > 0 ? Math.min(100, (l.xpIntoLevel / l.xpForNext) * 100) : 100;
  const startFill = pct(preLp);
  const target = pct(lp);

  // Animate the bar from where it was BEFORE the match to the new value, wrapping
  // through 100% with a flash on level-up so the gain is felt, not just shown.
  const [fill, setFill] = useState(startFill);
  const [noAnim, setNoAnim] = useState(false);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setFill(progression.leveledUp ? 100 : target), 300));
    if (progression.leveledUp) {
      timers.push(
        window.setTimeout(() => {
          setFlash(true);
          setNoAnim(true);
          setFill(0);
        }, 300 + 760),
      );
      timers.push(
        window.setTimeout(() => {
          setNoAnim(false);
          setFill(target);
        }, 300 + 820),
      );
      timers.push(window.setTimeout(() => setFlash(false), 300 + 1400));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const xpN = useCountUp(progression.xpGained);
  const credN = useCountUp(progression.creditsGained);
  const unlocks = progression.newUnlocks.map((id) => cosmeticById(id)?.name ?? id);

  return (
    <div
      className={`clip-deck-sm mt-4 border px-4 py-3 transition-colors ${
        flash ? 'border-emerald-400/60 bg-emerald-300/[0.08]' : 'border-cyan-500/20 bg-cyan-300/[0.04]'
      }`}
    >
      <div className='flex items-baseline justify-between'>
        <span className='text-[10px] uppercase tracking-[0.28em] text-cyan-200/70'>Experience</span>
        <span className='text-sm font-bold tabular-nums text-cyan-200'>
          +{xpN} XP
          {progression.creditsGained > 0 && (
            <span className='ml-2 text-amber-300'>+{credN} ⛁</span>
          )}
        </span>
      </div>
      <div className='mt-2 flex items-center gap-2'>
        <span className='text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-200/80'>
          Lv {lp.level}
        </span>
        <div className='deck-bar relative h-2.5 flex-1'>
          <div
            className={`bg-gradient-to-r from-cyan-400 to-sky-300 ${
              noAnim ? '' : 'transition-[width] duration-700 ease-out'
            }`}
            style={{ width: `${fill}%`, boxShadow: '0 0 10px rgba(56,189,248,0.55)' }}
          />
        </div>
      </div>
      <div className='mt-1 flex items-center justify-between text-[10px] tabular-nums text-white/40'>
        <span>{lp.xpForNext > 0 ? `${lp.xpIntoLevel} / ${lp.xpForNext}` : 'MAX LEVEL'}</span>
        {progression.leveledUp && (
          <span
            className='font-bold uppercase tracking-[0.18em] text-emerald-300'
            style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.6))' }}
          >
            ★ Level up! → Lv {lp.level}
          </span>
        )}
      </div>
      {unlocks.length > 0 && (
        <div className='mt-2 text-[11px] text-amber-200'>
          Unlocked: <span className='font-semibold'>{unlocks.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

// Deterministic 32-bit hash (FNV-1a) so a given name always maps to the same
// podium hat/emote when we don't know its real loadout (offline bots / remotes).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build the top-3 podium roster from the final scoreboard. Each player's real
// equipped hat/emote is used when known — the local player from settings, and
// (online) remotes from the broadcast carried on their PlayerScore. Offline bots
// have no known loadout, so they fall back to a stable name-hashed hat/emote.
function buildPodiumWinners(scores: PlayerScore[], settings: Settings): PodiumWinner[] {
  const caseHatIds = caseHats().map((h) => h.id);
  const emoteIds = EMOTES.map((e) => e.id);
  return scores.slice(0, 3).map((s, i) => {
    const h = hashStr(s.name);
    const hatId = s.isLocal ? settings.hat : s.hat ?? caseHatIds[h % caseHatIds.length] ?? DEFAULT_HAT;
    const emoteId = s.isLocal
      ? settings.emote
      : s.emote ?? emoteIds[(h >>> 4) % emoteIds.length] ?? DEFAULT_EMOTE;
    return { place: i + 1, name: s.name, score: s.frags, hatId, emoteId };
  });
}

// Mounts the Three.js podium scene on a canvas and tears it down on unmount.
function PodiumResults({ winners }: { winners: PodiumWinner[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scene = new PodiumScene(canvas);
    void scene.setWinners(winners);
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      scene.dispose();
    };
  }, [winners]);
  return <canvas ref={ref} className='block h-full w-full' />;
}

// Shared results panel: Victory/Defeat header, the 3D top-3 podium, the full
// scoreboard, match stats + XP reward, and a caller-supplied footer (offline =
// Play Again/Lobby; online = Continue to the map vote).
function ResultsPanel({
  won,
  scores,
  settings,
  result,
  progression,
  footer,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  footer: ReactNode;
}) {
  const acc = result && result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  // Stable winners identity so the 3D scene mounts once (not every HUD tick).
  const rosterKey = scores.slice(0, 3).map((s) => `${s.id}:${s.frags}:${s.hat ?? ''}:${s.emote ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const winners = useMemo(() => buildPodiumWinners(scores, settings), [rosterKey, settings.hat, settings.emote]);

  return (
    <ModalShell
      label={won ? 'Victory — final standings' : 'Defeat — final standings'}
      tone={won ? 'emerald' : 'rose'}
      size='xl'
      z='z-30'
      backdrop='heavy'
      scroll
      padded={false}
      bodyClassName='gap-0'
    >
      {/* Header: Victory/Defeat title (kept clear of the 3D labels below) */}
      <div className='border-b border-white/10 bg-black/40 py-3 text-center'>
        <span
          className={`font-display text-2xl font-bold uppercase tracking-[0.24em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
          style={{
            filter: won
              ? 'drop-shadow(0 0 16px rgba(52,211,153,0.55))'
              : 'drop-shadow(0 0 16px rgba(244,63,94,0.55))',
          }}
        >
          {won ? 'Victory' : 'Defeat'}
        </span>
        <span className='ml-3 text-[10px] uppercase tracking-[0.3em] text-white/40'>Final Standings</span>
      </div>
      {/* Hero: the 3D podium of the top 3 (hats + emotes) */}
      <div className='h-[340px] w-full shrink-0 bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
        <PodiumResults winners={winners} />
      </div>

      <div className='p-6 pt-4'>
        {/* Full scoreboard (all players, compact) */}
        <div className='overflow-hidden border border-white/10'>
          <div className='grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 bg-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/45'>
            <span>#</span>
            <span>Player</span>
            <span className='text-right'>K</span>
            <span className='text-right'>D</span>
          </div>
          {scores.map((s, i) => (
            <div
              key={s.id}
              className={`deck-tr grid grid-cols-[2rem_1fr_3rem_3rem] gap-2 px-3 py-1.5 text-sm ${
                s.isLocal ? 'deck-tr-you text-cyan-100' : 'text-white/80'
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

        {progression && <XpReward progression={progression} />}

        <div className='mt-6 flex gap-3'>{footer}</div>
      </div>
    </ModalShell>
  );
}

// Offline (vs-bots) results — replay or bail to the lobby.
function MatchOverOverlay({
  won,
  scores,
  settings,
  result,
  progression,
  onPlayAgain,
  onLobby,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onPlayAgain: () => void;
  onLobby: () => void;
}) {
  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      footer={
        <>
          <DeckButton onClick={onPlayAgain} solid accent='emerald' center className='flex-1'>
            Play Again
          </DeckButton>
          <DeckButton onClick={onLobby} center className='flex-1' sound='uiBack'>
            Lobby
          </DeckButton>
        </>
      }
    />
  );
}

// Online results — same podium, then auto-advances to the map vote (or click).
// Kept shorter than the 15s vote so players still get time to pick a map.
function OnlineMatchResults({
  won,
  scores,
  settings,
  result,
  progression,
  onContinue,
}: {
  won: boolean;
  scores: PlayerScore[];
  settings: Settings;
  result: MatchResult | null;
  progression: ProgressionResp | null;
  onContinue: () => void;
}) {
  const [secs, setSecs] = useState(8);
  useEffect(() => {
    if (secs <= 0) {
      onContinue();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs]);

  return (
    <ResultsPanel
      won={won}
      scores={scores}
      settings={settings}
      result={result}
      progression={progression}
      footer={
        <DeckButton onClick={onContinue} solid accent='cyan' center className='flex-1'>
          Continue to Map Vote {secs > 0 ? `(${secs})` : ''}
        </DeckButton>
      }
    />
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
            <div className='text-[11px] uppercase tracking-[0.55em] text-cyan-300/80'>
              Play of the Match
            </div>
          </div>

          <div className='absolute left-[4vw] bottom-[14vh]'>
            <div className='text-3xl font-extrabold uppercase tracking-[0.04em] text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]'>
              {pom.star}
            </div>
            <div className='mt-1 text-lg font-bold uppercase tracking-[0.25em] text-cyan-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]'>
              {pom.label}
              {pom.subLabel ? <span className='ml-3 text-white/55'>· {pom.subLabel}</span> : null}
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

// Must match --hud-out in src/hud.css: the fade-only exit every HUD element uses.
const HUD_EXIT_MS = 240;
// How long before the engine drops a timed entry its pre-scheduled CSS fade
// starts: the fade itself plus slack so it has finished by the time the next
// HudState push unmounts the element.
const HUD_EXIT_LEAD_MS = HUD_EXIT_MS + 120;

function HudOverlay({ store, settings }: { store: HudStore; settings: Settings }) {
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
          <HudLayout settings={settings} />
        </div>
      </div>
    </HudStoreContext.Provider>
  );
}

// Static layout. Each piece below subscribes to its own slice of the store, so
// a HudState push only re-renders the pieces whose slice actually changed (a
// push with only `speed` changed re-renders the speed readout alone).
const HudLayout = memo(function HudLayout({ settings }: { settings: Settings }) {
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
      <HudTeamScoreBar />
      <HudNetDebug />
      <HudTraining />
      <HudBanner />
      <HudCaptions captions={settings.captions} />
      <HudFragPopup />
      {/* Your own card is NOT shown on your kills — it's broadcast so the VICTIM
          sees it on their killcam. The killer's card shows on YOUR killcam below. */}
      <HudKillcam reduced={settings.reducedEffects} />
      {!dead && <HudSpeedAndStreak />}
      {!dead && <HudCooldowns />}
      {settings.showFps && <HudFps />}
      <HudNetStatus />
      <HudInvuln />
      <HudWarmup />
      <HudScoreboard showPing={settings.showPing} />
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
  return <Killfeed entries={useHudSlice((s) => s.killfeed)} />;
}

function HudToasts() {
  return <ToastStack toasts={useHudSlice((s) => s.toasts)} />;
}

function HudMiniLeaderboard() {
  return <MiniLeaderboard scores={useHudSlice((s) => s.scores)} />;
}

function HudTeamScoreBar() {
  const t = useHudSlice(
    (s) => ({ tdm: s.mode === 'tdm', scores: s.teamScores, localTeam: s.localTeam }),
    shallowEqual,
  );
  if (!t.tdm || !t.scores) return null;
  return <TeamScoreBar scores={t.scores} localTeam={t.localTeam} />;
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
  return <FragPopup confirm={useHudSlice((s) => s.killConfirm)} />;
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
    s.warmupMsLeft > 0 && !s.vote && !s.matchOver && !s.killcam
      ? Math.max(1, Math.ceil(s.warmupMsLeft / 1000))
      : 0,
  );
  return secs > 0 ? <WarmupOverlay secs={secs} /> : null;
}

function HudScoreboard({ showPing }: { showPing: boolean }) {
  const b = useHudSlice(
    (s) => (s.showScoreboard ? { scores: s.scores, netStatus: s.netStatus, mode: s.mode } : null),
    shallowEqual,
  );
  if (!b) return null;
  return (
    <FullScoreboard
      scores={b.scores}
      netStatus={b.netStatus}
      mode={b.mode}
      showPing={showPing && b.netStatus !== 'off'}
    />
  );
}

// Match-start "get ready" countdown. The server freezes shots during this
// window (resumeAt), so it's a fair start — nobody can be fragged on the bell.
const WarmupOverlay = memo(function WarmupOverlay({ secs }: { secs: number }) {
  return (
    <div className='pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center'>
      <div className='text-[11px] font-semibold uppercase tracking-[0.4em] text-cyan-200/80'>
        Get ready
      </div>
      {/* Keyed on the second so each count ticks in (CSS .hud-tick). */}
      <div
        key={secs}
        className='hud-tick hud-tick-center mt-1 font-mono text-7xl font-extrabold tabular-nums text-cyan-100'
        style={{ filter: 'drop-shadow(0 0 22px rgba(103,232,249,0.55))' }}
      >
        {secs}
      </div>
      <div className='mt-1 text-[10px] uppercase tracking-[0.3em] text-white/45'>
        Match starting
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
      <div className='absolute left-1/2 top-6 -translate-x-1/2 flex items-center gap-2 rounded-full border border-cyan-300/60 bg-cyan-300/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-100 backdrop-blur-sm'>
        <span className='inline-block h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.85)]' />
        <span>Invuln</span>
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
      className={`hud-killcam absolute inset-0${leaving ? ' hud-leaving' : ''}`}
      style={hudTiming(item.remaining, item.total, KILLCAM_FADE_LEAD_MS)}
    >
      <div
        className='absolute inset-0'
        style={{
          background:
            'radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      {cam.dirAngle !== undefined && (
        // Directional "the shot came from here" arrow, rotated around screen
        // center toward the killer (0 = dead ahead, clockwise). Teaches new
        // players where they're being picked off from.
        <div
          className='pointer-events-none absolute left-1/2 top-1/2'
          style={{ transform: `translate(-50%,-50%) rotate(${cam.dirAngle}rad)` }}
        >
          <div
            className='text-3xl leading-none text-rose-400'
            style={{ transform: 'translateY(-128px)', filter: 'drop-shadow(0 0 8px rgba(244,63,94,0.85))' }}
          >
            ▲
          </div>
        </div>
      )}
      <div className='hud-killcam-card absolute inset-x-0 top-[18%] flex flex-col items-center text-center font-mono'>
        <div className='text-[10px] uppercase tracking-[0.4em] text-white/55'>
          You were killed by
        </div>
        <div
          className='mt-2 text-4xl font-extrabold uppercase tracking-[0.08em] text-rose-300'
          style={{ filter: 'drop-shadow(0 0 22px rgba(244,63,94,0.55))' }}
        >
          {cam.killerName}
        </div>
        {cam.killerCard && (
          <div className='mt-5'>
            <PlayerCard card={cam.killerCard} reduced={reduced} />
          </div>
        )}
        <div className='mt-6 text-[11px] uppercase tracking-[0.3em] text-white/55'>
          Respawning in{' '}
          <span className='text-white'>
            <KillcamCountdown />s
          </span>
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
});

/* ───────────────────────── TDM team score bar (top-center) ───────────────────────── */

// Compact Red vs Blue total-frag readout. Your team gets a "YOU" tag + a glowing
// outline so it's obvious which side you're on.
const TeamScoreBar = memo(function TeamScoreBar({
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
          'radial-gradient(circle at center, transparent 35%, rgba(220,38,38,0.55) 100%)',
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

/* ───────────────────────── Killfeed (top-right) ───────────────────────── */

const Killfeed = memo(function Killfeed({ entries }: { entries: KillfeedEntry[] }) {
  const rows = useExitList(entries, { exitMs: HUD_EXIT_MS, leadMs: HUD_EXIT_LEAD_MS });
  return (
    <div className='absolute right-6 top-6 flex w-72 flex-col items-end gap-1.5 font-mono text-[13px]'>
      {rows.map(({ item, leaving }) => (
        <KillfeedRow key={item.id} entry={item} leaving={leaving} />
      ))}
    </div>
  );
});

// Slides in from the right, holds, and fades on a pre-scheduled CSS delay (see
// hudTiming) — no React updates between mount and unmount. `leaving` plays the
// fade now when the engine dropped the row early (feed cap / reset).
const KillfeedRow = memo(function KillfeedRow({
  entry,
  leaving,
}: {
  entry: KillfeedEntry;
  leaving: boolean;
}) {
  const specialBadge =
    entry.special === 'headshot'
      ? { text: 'HS', color: 'bg-amber-400/85 text-amber-950' }
      : entry.special === 'mid-air'
        ? { text: 'AIR', color: 'bg-cyan-300/85 text-cyan-950' }
        : null;
  return (
    <div
      className={`hud-chip flex items-center gap-2 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur-sm${
        leaving ? ' hud-leaving' : ''
      }`}
      style={hudTiming(entry.remaining, entry.total, HUD_EXIT_LEAD_MS)}
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
});

/* ───────────── Toast stack (top-right, under killfeed) ───────────── */

// Medal toasts fade over the engine's TOAST_FADE_SEC window: the fade itself is
// the shared HUD_EXIT_MS, the rest is slack for push jitter.
const TOAST_FADE_LEAD_MS = TOAST_FADE_SEC * 1000;

const ToastStack = memo(function ToastStack({ toasts }: { toasts: ToastEntry[] }) {
  const chips = useExitList(toasts, { exitMs: HUD_EXIT_MS, leadMs: TOAST_FADE_LEAD_MS });
  return (
    <div className='absolute right-6 top-40 flex flex-col items-end gap-1.5'>
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
      className={`hud-chip flex items-center gap-2 rounded-full border ${colors.border} bg-black/60 px-3 py-1 font-mono text-xs backdrop-blur-sm${
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
      <div className='flex items-center gap-1 rounded-lg border border-amber-400/25 bg-black/55 px-2 py-2 backdrop-blur-sm'>
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
  const top = scores.slice(0, 5);
  // If you're not in the top 5, show your own rank in a pinned extra row.
  const localIndex = scores.findIndex((s) => s.isLocal);
  const you = localIndex >= 5 ? scores[localIndex] : null;
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
              {/* '▸' marks your row without relying on color (colorblind + the
                  bright-enemy recolor both wash out the emerald tint). */}
              <span className='w-4 text-right text-white/40'>{s.isLocal ? '▸' : `${i + 1}.`}</span>
              <span
                className={`truncate ${
                  s.isLocal ? 'font-bold text-emerald-300' : 'text-white/85'
                }`}
              >
                {s.name}
              </span>
              <NameBadges admin={s.admin} verified={s.verified} size={11} />
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
        {you && (
          <div className='mt-0.5 flex items-center justify-between gap-2 border-t border-white/10 pt-1'>
            <div className='flex min-w-0 items-center gap-2'>
              <span className='w-4 text-right text-emerald-300/70'>{localIndex + 1}.</span>
              <span className='truncate font-bold text-emerald-300'>{you.name}</span>
              <NameBadges admin={you.admin} verified={you.verified} size={11} />
              {you.currentStreak >= 3 && (
                <span className='rounded bg-amber-400/85 px-1 text-[9px] font-bold text-amber-950'>
                  {you.currentStreak}
                </span>
              )}
            </div>
            <div className='shrink-0 tabular-nums'>
              <span className='text-white'>{you.frags}</span>
              <span className='mx-1 text-white/30'>·</span>
              <span className='text-white/55'>{you.deaths}</span>
              <span className='mx-1 text-white/30'>·</span>
              <span className='text-cyan-200/80'>{formatAccuracy(you.accuracy)}</span>
            </div>
          </div>
        )}
      </div>
      <div className='mt-2 border-t border-white/10 pt-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40'>
        Tab — full scoreboard
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
    <div className='absolute inset-x-0 top-[12%]'>
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
          className={`bg-gradient-to-b ${colors.gradient} bg-clip-text font-mono text-[88px] font-black uppercase leading-[0.95] tracking-[0.04em] text-transparent`}
          style={{
            textShadow: `0 4px 28px ${colors.glow}`,
            WebkitTextStroke: `1px ${colors.stroke}`,
          }}
        >
          {banner.title}
        </div>
        <div className={`hud-banner-bar mt-2 h-[3px] w-28 rounded-full ${colors.bar}`} />
        {banner.subtitle && (
          <div className='hud-banner-sub mt-2 font-mono text-sm uppercase tracking-[0.4em] text-white/75'>
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
    <div className='absolute bottom-6 left-6 font-mono'>
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
    <>
      <div className='text-[10px] uppercase tracking-[0.25em] text-white/55'>Speed</div>
      <div className='text-3xl font-bold tabular-nums leading-none'>
        <span key={dashId} className={dashId > 0 ? 'hud-tick' : undefined}>
          {text}
        </span>
        <span className='ml-1 text-sm font-normal text-white/40'>m/s</span>
      </div>
    </>
  );
}

function StreakReadout() {
  const streak = useHudSlice((s) => s.currentStreak);
  if (streak < 2) return null;
  return (
    <div className='mt-3 flex items-center gap-2'>
      <span className='text-[10px] uppercase tracking-[0.25em] text-amber-300/85'>Streak</span>
      {/* Keyed on the count so every increment ticks in. */}
      <span key={streak} className='hud-tick text-xl font-bold tabular-nums text-amber-200'>
        {streak}
      </span>
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
  const R = 14;
  const C = 2 * Math.PI * R;
  return (
    <div className='flex flex-col items-center gap-1 font-mono'>
      <div className='relative h-12 w-12'>
        <svg viewBox='0 0 32 32' className='h-full w-full -rotate-90'>
          <circle cx='16' cy='16' r={R} fill='none' stroke='rgba(255,255,255,0.12)' strokeWidth='3' />
          {ready ? (
            <circle cx='16' cy='16' r={R} fill='none' stroke={accent} strokeWidth='3' strokeLinecap='round' />
          ) : (
            <circle
              key={eventId}
              className='hud-cd-ring'
              cx='16'
              cy='16'
              r={R}
              fill='none'
              stroke='rgba(255,255,255,0.4)'
              strokeWidth='3'
              strokeDasharray={C}
              strokeLinecap='round'
              style={cssVars({
                '--cd-c': C,
                '--cd-total': `${total}s`,
                '--cd-elapsed': `${Math.max(0, Math.round(elapsedMs))}ms`,
              })}
            />
          )}
        </svg>
        <div className='absolute inset-0 flex items-center justify-center text-[11px] font-bold'>
          {ready ? (
            <span key={eventId} className='hud-tick hud-tick-center'>
              ●
            </span>
          ) : (
            text
          )}
        </div>
      </div>
      <div className='text-[10px] uppercase tracking-[0.16em] text-white/55'>{label}</div>
    </div>
  );
});

const AirJumpPip = memo(function AirJumpPip({ left, max }: { left: number; max: number }) {
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
});

/* ───────────────────────── FPS counter ───────────────────────── */

const FpsCounter = memo(function FpsCounter({ fps }: { fps: number }) {
  const color = fps >= 55 ? 'text-emerald-300' : fps >= 30 ? 'text-amber-300' : 'text-rose-300';
  return (
    <div className='absolute right-6 top-2 font-mono text-[11px] tabular-nums text-white/70'>
      <span className={`mr-1 font-bold ${color}`}>{fps}</span>
      <span className='text-white/40'>fps</span>
    </div>
  );
});

/* ───────────────────────── Full scoreboard (Tab held) ───────────────────────── */

const FullScoreboard = memo(function FullScoreboard({
  scores,
  netStatus,
  mode,
  showPing = false,
}: {
  scores: PlayerScore[];
  netStatus: HudState['netStatus'];
  mode: GameMode;
  showPing?: boolean;
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
                showPing={showPing}
              />
            ))}
            {scores.some((s) => s.team == null) && (
              <ScoreTable players={scores.filter((s) => s.team == null)} showPing={showPing} />
            )}
          </div>
        ) : (
          <ScoreTable players={scores} showPing={showPing} />
        )}
      </div>
    </div>
  );
});

// A scoreboard table body (header + rows). Reused for the flat FFA/Duel
// scoreboard and each TDM team section.
function ScoreTable({
  players,
  teamColor,
  showPing = false,
}: {
  players: PlayerScore[];
  teamColor?: string;
  showPing?: boolean;
}) {
  const cols = showPing
    ? 'grid-cols-[1fr_auto_auto_auto_auto_auto_auto]'
    : 'grid-cols-[1fr_auto_auto_auto_auto_auto]';
  return (
    <div className={`grid ${cols} gap-x-6 gap-y-1 text-[12px]`}>
      <Th>Player</Th>
      <Th align='right'>Frags</Th>
      <Th align='right'>Deaths</Th>
      <Th align='right'>K/D</Th>
      <Th align='right'>Acc</Th>
      <Th align='right'>Best Streak</Th>
      {showPing && <Th align='right'>Ping</Th>}
      {players.map((s) => (
        <ScoreboardRow key={s.id} score={s} nameColor={teamColor} showPing={showPing} />
      ))}
    </div>
  );
}

// A TDM team block: a colored header with the team's total frags, then the
// roster (names tinted in the team color).
function TeamScoreSection({
  team,
  players,
  showPing = false,
}: {
  team: number;
  players: PlayerScore[];
  showPing?: boolean;
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
      <ScoreTable players={players} teamColor={color} showPing={showPing} />
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

// Ping → connection-quality colour (green good / amber ok / rose poor).
function pingColor(ping: number): string {
  return ping <= 60 ? 'text-emerald-300' : ping <= 120 ? 'text-amber-300' : 'text-rose-300';
}

function ScoreboardRow({
  score,
  nameColor,
  showPing = false,
}: {
  score: PlayerScore;
  nameColor?: string;
  showPing?: boolean;
}) {
  const kd =
    score.deaths === 0
      ? score.frags.toFixed(1)
      : (score.frags / Math.max(1, score.deaths)).toFixed(2);
  // Local player always stays emerald + bold (so "you" reads at a glance); other
  // players use the team tint in TDM, falling back to the neutral default.
  const useTeamTint = !score.isLocal && nameColor != null;
  return (
    <>
      <div className='flex min-w-0 flex-col py-1.5'>
        <div className='flex items-center gap-2'>
          <span
            className={`truncate ${
              score.isLocal ? 'font-bold text-emerald-300' : useTeamTint ? 'font-semibold' : 'text-white/90'
            }`}
            style={useTeamTint ? { color: nameColor } : undefined}
          >
            {score.name}
          </span>
          <NameBadges admin={score.admin} verified={score.verified} size={13} />
          {score.currentStreak >= 3 && (
            <span className='rounded bg-amber-400/85 px-1 text-[9px] font-bold text-amber-950'>
              ON FIRE
            </span>
          )}
        </div>
        {score.title && (
          <span className='truncate text-[9px] font-semibold uppercase tracking-[0.16em] text-white/40'>
            {score.title}
          </span>
        )}
      </div>
      <div className='py-1.5 text-right tabular-nums'>{score.frags}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{score.deaths}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{kd}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{formatAccuracy(score.accuracy)}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{score.bestStreak}</div>
      {showPing && (
        <div className={`py-1.5 text-right tabular-nums ${score.ping == null ? 'text-white/30' : pingColor(score.ping)}`}>
          {score.ping == null ? '—' : `${score.ping}ms`}
        </div>
      )}
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
  // The pause menu: a dimmed sheet over the live arena with the deck's big
  // display type. Clicking anywhere (the canvas underneath) re-locks the
  // pointer; the buttons are the explicit paths. Menu toasts (e.g. from the
  // in-match Settings sheet) rail here — never over live gameplay.
  return (
    <div className='deck-scan absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white pointer-events-auto'>
      <div className='relative flex flex-col items-center px-6 text-center'>
        <div className='font-mono text-[11px] uppercase tracking-[0.35em] text-cyan-300/80'>
          Instagib Arena · {inMatch}
        </div>
        <div className='mt-3 font-display text-4xl font-bold uppercase tracking-[0.16em] sm:text-5xl'>
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

// Progression delta returned by POST /api/stats — drives the end-of-match XP
// moment. Mirrors the server `MatchRecordResult` (minus the legacy `stats`).
type ProgressionResp = {
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
    <div className='clip-deck-sm pointer-events-none absolute left-1/2 top-3 z-[60] -translate-x-1/2 border border-cyan-400/30 bg-[#0b0c0f]/85 px-4 py-1.5 text-center font-mono'>
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
// The live flair text for the dynamic ranked title from a profile's standing:
// top-10 → "#N", otherwise the tier name; '' if the player has no ranked games.
function rankedStandingText(ranked: InstagibProfile['ranked']): string {
  if (!ranked) return '';
  return ranked.rank >= 1 && ranked.rank <= 10 ? `#${ranked.rank}` : rankedTierName(ranked.rating);
}

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
}: {
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onStart: (config: MatchConfig) => void;
  lastResult: MatchResult | null;
  account: Account;
  onOpenLogin: () => void;
  onLogout: () => void;
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
  const [lobbyProfile, setLobbyProfile] = useState<InstagibProfile | null>(null);
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

  // Pull credits/level + the claimable-challenge count for the lobby chrome.
  // Re-pulls whenever a modal that can change them closes (refreshTick).
  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (active && d.profile) setLobbyProfile(d.profile);
      })
      .catch(() => {});
    fetch('/api/challenges', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ch'))))
      .then((d: { challenges?: { daily: ChallengeView[]; weekly: ChallengeView[] } }) => {
        if (!active || !d.challenges) return;
        const all = [...d.challenges.daily, ...d.challenges.weekly];
        setClaimable(all.filter((c) => c.complete && !c.claimed).length);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [refreshTick]);

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

  return (
    <div className='deck-bg deck-scan fixed inset-0 z-50 overflow-hidden text-white'>
      <a href='#lobby-main' className='deck-skip-link'>
        Skip to content
      </a>
      <MenuToasts />
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
            {account ? (
              <span className='hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] sm:inline-flex'>
                <span className='inline-flex items-center gap-1 text-cyan-200'>
                  {account.username}
                  <NameBadges admin={account.isAdmin} verified={account.isVerified} size={12} />
                </span>
                {account.isAdmin && (
                  <button
                    type='button'
                    onClick={() => setAdminOpen(true)}
                    {...sfxProps('uiClick')}
                    className='border border-amber-400/40 px-1.5 py-0.5 font-bold text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100'
                  >
                    Admin
                  </button>
                )}
                <button
                  type='button'
                  onClick={onLogout}
                  {...sfxProps('uiBack')}
                  className='text-white/35 transition hover:text-white/70'
                >
                  Log&nbsp;out
                </button>
              </span>
            ) : (
              <button
                type='button'
                onClick={onOpenLogin}
                title='Save your progress across devices'
                {...sfxProps('uiClick')}
                className='clip-deck-sm inline-flex items-center gap-1.5 border border-cyan-400/40 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:border-cyan-300/70 hover:text-cyan-100'
              >
                <span className='text-white/40'>Guest ·</span> Log in / Register
              </button>
            )}
            {lobbyProfile && account && (
              <button
                type='button'
                onClick={() => setLockerOpen(true)}
                title='Open the Locker — spend credits on cosmetics'
                {...sfxProps('uiClick')}
                className='clip-deck-sm inline-flex items-center gap-1.5 border border-amber-400/40 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100'
              >
                <span className='text-white/45'>Lv {lobbyProfile.level}</span>
                <span>{lobbyProfile.credits.toLocaleString()} CR</span>
              </button>
            )}
            <ServerStatusChip status={lobbyStatus} />
          </div>
        </header>
        <div className='h-px w-full shrink-0 bg-gradient-to-r from-cyan-400/50 via-white/10 to-transparent' />

        {/* ── Main grid: actions (left) · live feed (right). Scrolls as one
            page on mobile; splits into two fixed columns on desktop. ─────── */}
        <main
          id='lobby-main'
          tabIndex={-1}
          className='grid min-h-0 flex-1 gap-4 overflow-y-auto outline-none lg:grid-cols-[1.15fr_0.85fr] lg:overflow-visible'
        >
          {/* Left — mode + actions */}
          <section className='deck-scroll flex min-h-0 flex-col gap-3 pr-1 lg:overflow-y-auto'>
            <p className='deck-rise max-w-md text-sm leading-relaxed text-white/50' style={{ animationDelay: '60ms' }}>
              One railgun. One shot. One kill — the whole game is aim and movement.
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
              type='button'
              onClick={() => {
                if (searching || !online || playDisabled) return; // double-fire guard
                setSearching(true);
                // "Play Now" = mode-agnostic super-queue: join whatever's live so a
                // small population concentrates instead of splitting 3 ways. The
                // mode picker drives Create Match for players who want a specific one.
                lobbyRef.current?.quickMatch('any');
                window.setTimeout(() => setSearching(false), 6000);
              }}
              disabled={!online || playDisabled || searching}
              aria-busy={searching}
              {...sfxProps('uiConfirm')}
              className='clip-deck deck-rise group bg-emerald-400 px-6 py-5 text-left font-display text-lg font-bold uppercase tracking-[0.18em] text-zinc-950 transition hover:bg-emerald-300 active:translate-y-px disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40'
              style={{ animationDelay: '180ms' }}
            >
              <span className='flex items-center gap-3'>
                {searching ? 'Searching…' : 'Play Now'}
                <span aria-hidden className='transition-transform group-hover:translate-x-1'>→</span>
                <span className='ml-auto font-mono text-[11px] font-semibold tracking-[0.1em] text-zinc-950/60'>
                  {searching ? 'Looking for a live lobby' : 'Any mode · fastest'}
                </span>
              </span>
            </button>

            {/* Ways to play — online first, then offline practice. */}
            <div className='deck-rise grid grid-cols-2 gap-3' style={{ animationDelay: '240ms' }}>
              <DeckButton onClick={() => setCreateOnlineOpen(true)} disabled={!online || playDisabled} accent='cyan'>
                Create Match
              </DeckButton>
              <DeckButton onClick={() => setRankedOpen(true)} disabled={!online || playDisabled} accent='fuchsia' sub='1v1 · Elo ladder'>
                Ranked Duel
              </DeckButton>
              <DeckButton
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
              >
                Training Range
              </DeckButton>
              <DeckButton onClick={() => setSoloOpen(true)} disabled={playDisabled}>
                Solo vs Bots
              </DeckButton>
              <div className='col-span-2'>
                <DeckButton onClick={() => setWeeklyOpen(true)} disabled={playDisabled} accent='amber' sub='8p FFA speedrun' full>
                  Weekly Challenge
                </DeckButton>
              </div>
            </div>

            {/* Utility row — meta surfaces kept visually subordinate to the ways
                to play, so the menu reads top-down: queue → host → practice →
                profile / settings. */}
            <div className='deck-rise flex flex-wrap gap-2' style={{ animationDelay: '300ms' }}>
              <UtilButton onClick={() => setStatsOpen(true)}>Stats</UtilButton>
              <UtilButton onClick={() => setChallengesOpen(true)}>
                <span className='inline-flex items-center gap-1.5'>
                  Challenges
                  {claimable > 0 && (
                    <span
                      title={`${claimable} reward${claimable > 1 ? 's' : ''} ready to claim`}
                      className='clip-deck-sm inline-flex h-4 min-w-4 items-center justify-center bg-emerald-400 px-1.5 text-[10px] font-bold tabular-nums text-emerald-950'
                    >
                      {claimable}
                    </span>
                  )}
                </span>
              </UtilButton>
              <UtilButton onClick={() => setLeaderboardOpen(true)}>Leaderboard</UtilButton>
              <UtilButton onClick={() => setLockerOpen(true)}>Locker</UtilButton>
              <UtilButton onClick={() => openSettingsAt('controls')}>Settings</UtilButton>
            </div>

            {lastResult && <LastMatchBanner result={lastResult} />}
          </section>

          {/* Right — social column: who's online, open lobbies, global chat */}
          <aside className='deck-rise flex min-h-0 flex-col gap-3' style={{ animationDelay: '200ms' }}>
            <OnlinePlayersPanel presence={presence} youName={account?.username ?? null} />
            <div className='min-h-[10rem] flex-1'>
              <OpenLobbies
                rooms={rooms}
                online={online}
                onJoin={(r) => startOnline(r.id, r.mapId)}
                onSpectate={(r) => startSpectate(r.id, r.mapId)}
                onRefresh={() => lobbyRef.current?.refresh()}
              />
            </div>
            <div className='min-h-[13rem] flex-1'>
              <GlobalChatPanel
                messages={chatLog}
                online={online}
                canChat={!!account}
                youName={account?.username ?? null}
                onSend={(text) => lobbyRef.current?.sendChat(text)}
              />
            </div>
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
      {challengesOpen && (
        <ChallengesModal
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
                  ? 'border-cyan-300/70 bg-cyan-300/15 text-cyan-100'
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
    open: { dot: 'bg-emerald-400', ring: 'border-emerald-400/40 text-emerald-200', t: 'Online', title: 'Connected — online play available' },
    connecting: { dot: 'bg-amber-400', ring: 'border-amber-400/40 text-amber-200', t: 'Linking', title: 'Connecting to the match server…' },
    closed: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
    error: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
  } as const;
  const s = map[status];
  return (
    <span
      title={s.title}
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
  onSpectate,
  onRefresh,
}: {
  rooms: LobbyRoom[];
  online: boolean;
  onJoin: (r: LobbyRoom) => void;
  onSpectate: (r: LobbyRoom) => void;
  onRefresh: () => void;
}) {
  return (
    <div className='clip-deck deck-panel flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3'>
        <span className='font-display text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-200/90'>
          Live Lobbies
          {online && rooms.length > 0 && (
            <span className='ml-2 font-mono text-white/40'>[{rooms.length}]</span>
          )}
        </span>
        <button
          type='button'
          onClick={onRefresh}
          disabled={!online}
          {...sfxProps('uiClick')}
          className='font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300/70 transition hover:text-cyan-200 disabled:opacity-40'
        >
          Refresh
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
    </div>
  );
}

// Expandable "who's online" panel. Registered players are listed by name (with
// staff/verified badges + an in-match dot); guests are shown only as an
// aggregate count (never named — they're anonymous and a name list would be a
// slur vector). All values are server-authoritative.
function OnlinePlayersPanel({
  presence,
  youName,
}: {
  presence: PresenceState | null;
  youName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const players: PresencePlayer[] = presence?.players ?? [];
  const guests = presence?.guests ?? 0;
  return (
    <div className='clip-deck deck-panel shrink-0'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...sfxProps('uiToggle')}
        className='flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]'
      >
        <span className='flex items-center gap-2 font-display text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-200/90'>
          <span className='deck-pulse h-1.5 w-1.5 rounded-full bg-emerald-400' />
          {presence ? `${presence.online} Online` : 'Online…'}
        </span>
        <span className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/40'>
          {open ? 'Hide ▾' : 'Show ▸'}
        </span>
      </button>
      {open && (
        <div className='deck-scroll max-h-44 overflow-y-auto border-t border-white/10 px-3 py-2'>
          {players.length === 0 && guests === 0 ? (
            <div className='px-1 py-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-white/30'>
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
      )}
    </div>
  );
}

// Live global chat (one room). Identity + content are server-authoritative and
// server-moderated (sanitized, length-capped, profanity-filtered, rate-limited);
// we render names/text as React text nodes, so they're escaped — no raw HTML.
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
    <div className='clip-deck deck-panel flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3'>
        <span className='font-display text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-200/90'>
          Global Chat
        </span>
        <span className='font-mono text-[9px] uppercase tracking-[0.16em] text-white/30'>keep it clean</span>
      </div>
      <div ref={scrollRef} className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2'>
        {messages.length === 0 ? (
          <div className='flex h-full items-center justify-center px-6 py-8 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/25'>
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

function LastMatchBanner({ result }: { result: MatchResult }) {
  const acc = result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  return (
    <div
      className={`clip-deck-sm mt-2 border px-4 py-3 ${
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

type InstagibProfile = {
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

type ChallengeView = {
  id: string;
  title: string;
  period: 'daily' | 'weekly';
  goal: number;
  progress: number;
  claimed: boolean;
  complete: boolean;
  rewardXp: number;
  rewardCredits: number;
};

function ChallengesModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ daily: ChallengeView[]; weekly: ChallengeView[] } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/challenges', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('challenges'))))
      .then((d: { challenges?: { daily: ChallengeView[]; weekly: ChallengeView[] } }) => {
        if (d.challenges) {
          setData(d.challenges);
          setState('ready');
        } else setState('error');
      })
      .catch(() => setState('error'));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const claim = async (id: string) => {
    setClaiming(id);
    try {
      const res = await fetch('/api/challenges/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      });
      const d = (await res.json()) as { ok?: boolean; xpGained?: number; creditsGained?: number };
      if (res.ok && d.ok) {
        toast(`Reward claimed · +${d.xpGained} XP · +${d.creditsGained} ⛁`, { tone: 'ok' });
        load();
      } else toast('Could not claim that reward.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setClaiming(null);
  };

  const Row = (c: ChallengeView) => {
    const pct = Math.min(100, Math.round((c.progress / c.goal) * 100));
    return (
      <div
        key={c.id}
        data-challenge={c.id}
        data-complete={c.complete ? '1' : '0'}
        data-claimed={c.claimed ? '1' : '0'}
        className={`deck-card px-3 py-2.5 ${c.complete && !c.claimed ? 'border-emerald-400/40' : ''}`}
      >
        <div className='flex items-center justify-between gap-2'>
          <span className='font-sans text-sm text-white/90'>{c.title}</span>
          <span className='shrink-0 text-[10px] uppercase tracking-[0.12em] text-amber-300/90'>
            {c.rewardXp} XP · {c.rewardCredits} ⛁
          </span>
        </div>
        <div className='mt-2 flex items-center gap-2'>
          <div className='deck-bar h-2 flex-1'>
            <div className={c.complete ? 'bg-emerald-400' : 'bg-cyan-400/80'} style={{ width: `${pct}%` }} />
          </div>
          <span className='w-14 shrink-0 text-right text-[11px] tabular-nums text-white/55'>
            {Math.min(c.progress, c.goal)}/{c.goal}
          </span>
          {c.claimed ? (
            <span className='w-[4.5rem] shrink-0 text-right text-[10px] uppercase tracking-[0.14em] text-white/35'>
              Claimed
            </span>
          ) : (
            <DeckButton
              data-action='claim'
              disabled={!c.complete || claiming === c.id}
              onClick={() => claim(c.id)}
              accent='emerald'
              size='xs'
              center
              className='w-[4.5rem] shrink-0'
            >
              {claiming === c.id ? '…' : 'Claim'}
            </DeckButton>
          )}
        </div>
      </div>
    );
  };

  const RowSkeleton = (i: number) => (
    <div key={i} className='deck-card px-3 py-2.5'>
      <div className='flex items-center justify-between gap-2'>
        <Skeleton className='h-3.5 w-40' />
        <Skeleton className='h-2.5 w-16' />
      </div>
      <div className='mt-2.5 flex items-center gap-2'>
        <Skeleton className='h-2 flex-1' />
        <Skeleton className='h-3 w-14' />
        <Skeleton className='h-6 w-[4.5rem]' />
      </div>
    </div>
  );

  return (
    <ModalShell title='Challenges' onClose={onClose}>
      {state === 'loading' && (
        <div className='flex flex-col gap-4' aria-busy='true' aria-label='Loading challenges'>
          <div>
            <div className='deck-label mb-2'>Daily · resets every day</div>
            <div className='flex flex-col gap-2'>{[0, 1, 2].map(RowSkeleton)}</div>
          </div>
          <div>
            <div className='deck-label mb-2'>Weekly · bigger rewards</div>
            <div className='flex flex-col gap-2'>{[3, 4].map(RowSkeleton)}</div>
          </div>
        </div>
      )}
      {state === 'error' && (
        <div className='font-sans text-sm text-white/55'>
          Couldn&apos;t load challenges. Play an online match to start earning.
        </div>
      )}
      {state === 'ready' && data && (
        <div className='flex flex-col gap-4'>
          <div>
            <div className='deck-label mb-2'>Daily · resets every day</div>
            <div className='flex flex-col gap-2'>{data.daily.map(Row)}</div>
          </div>
          <div>
            <div className='deck-label mb-2'>Weekly · bigger rewards</div>
            <div className='flex flex-col gap-2'>{data.weekly.map(Row)}</div>
          </div>
          <div className='text-[10px] normal-case tracking-normal text-white/35'>
            Challenges progress from online matches only. Complete one, then Claim
            its XP + credits.
          </div>
        </div>
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
  { id: 'video', label: 'Video', keywords: 'fps framerate frame rate vsync unlimited resolution quality low spec performance ui scale hud viewmodel weapon offset map brightness tint shadows particles ping' },
  { id: 'audio', label: 'Audio', keywords: 'audio volume sound sfx announcer master mute captions' },
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
              The railgun sits low and to the side so it never blocks your aim. Bind “Zoom (hold)”
              under Keybinds to narrow your FOV.
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
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className='flex cursor-pointer flex-col gap-1'>
      <span className='flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-white/65'>
        <span>{label}</span>
        <DeckSwitch value={value} onChange={onChange} label={label} />
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
