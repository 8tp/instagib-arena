import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Game, type HudListener, type MatchResult, type NetMatchEvent } from './game/game';
import { useAuth, LoginModal, type Account } from './auth';
import { CONTROLS } from './controls';
import { MAPS, mapById } from './game/map';
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

// Default the reduced-effects toggle to the OS "reduce motion" preference.
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export type MatchConfig =
  | {
      mode: 'local';
      mapId: string;
      botCount: number;
      difficulty: BotDifficulty;
      training?: boolean; // endless practice — no frag-limit match end
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
        {CARD_STAT_DEFS.map((d) => {
          const on = settings.cardStats.includes(d.key);
          return (
            <button
              key={d.key}
              type='button'
              onClick={() => toggle(d.key)}
              className={`rounded-md border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition ${
                on
                  ? 'border-cyan-300/70 bg-cyan-300/15 text-cyan-200'
                  : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/25'
              }`}
            >
              {d.label}
            </button>
          );
        })}
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
  // Escape = play as guest (every other modal is escapable).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onPlayGuest();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPlayGuest]);
  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label='Welcome'
      className='fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md'
    >
      <div className='deck-bg w-[540px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl'>
        <div className='border-b border-white/10 px-7 py-5'>
          <h2
            className='font-display text-2xl font-bold uppercase tracking-[0.18em] text-cyan-300'
            style={{ filter: 'drop-shadow(0 0 16px rgba(34,211,238,0.4))' }}
          >
            Welcome to the Arena
          </h2>
          <p className='mt-1 text-[12px] text-white/50'>One railgun. One shot. Pure movement.</p>
        </div>
        <div className='px-7 py-5'>
          <div className='text-[10px] uppercase tracking-[0.24em] text-white/45'>Controls</div>
          <div className='mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2'>
            {CONTROLS.map(([key, action]) => (
              <div key={key} className='flex items-baseline gap-2 text-[12px]'>
                <span className='shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-cyan-200'>
                  {key}
                </span>
                <span className='text-white/60'>{action}</span>
              </div>
            ))}
          </div>
          <p className='mt-5 text-[12px] leading-relaxed text-white/50'>
            Jump in as a <span className='text-white/80'>guest</span> right now — or create a free
            account to save your XP, levels, credits, and cosmetics and climb the leaderboards.
          </p>
        </div>
        <div className='flex items-center justify-between gap-3 border-t border-white/10 px-7 py-4'>
          <button
            onClick={onPlayGuest}
            className='rounded-lg border border-white/15 bg-white/5 px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.14em] text-white/80 transition hover:bg-white/10'
          >
            Play as Guest
          </button>
          <button
            onClick={onCreateAccount}
            className='rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300'
          >
            Create account →
          </button>
        </div>
      </div>
    </div>
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
  const [endProgression, setEndProgression] = useState<ProgressionResp | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Ranked Duel end-of-match result (rating delta) → full-screen overlay.
  const [rankedResult, setRankedResult] = useState<RankedResult | null>(null);
  // Online: the results podium is shown briefly at match-end BEFORE the map vote.
  // We freeze the final standings here so a late snapshot can't change the podium.
  const [onlineResults, setOnlineResults] = useState(false);
  const [podiumScores, setPodiumScores] = useState<PlayerScore[]>([]);
  const hudRef = useRef<HudState>(INITIAL_HUD);
  const offlineMatch = config.mode !== 'multiplayer';

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const listener: HudListener = (state) => {
      hudRef.current = state;
      setHud(state);
    };
    // Match ended (frag limit): submit stats once + keep the result for the
    // results overlay. Offline navigates from the overlay buttons; online shows
    // the results podium, then continues to the server-driven map vote.
    const game = new Game(canvas, listener, (result) => {
      setEndResult(result);
      void submitMatchStats(result, offlineMatch, game.getMatchModeTag()).then((p) => {
        if (p) setEndProgression(p);
      });
      if (config.mode === 'multiplayer') {
        setPodiumScores(hudRef.current.scores);
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
    if (r && game?.hasRecordableStats()) void submitMatchStats(r, offlineMatch, game.getMatchModeTag());
    onExit(r);
  }, [onExit, offlineMatch]);

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
      {!hud.pom && <HudOverlay hud={hud} settings={settings} />}
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
          hud={hud}
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
    <div className='relative h-60 w-full shrink-0 overflow-hidden rounded-lg border border-white/10 bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
      <canvas ref={ref} className='block h-full w-full' />
      <div className='pointer-events-none absolute bottom-1.5 right-2 text-[9px] uppercase tracking-[0.18em] text-white/35'>
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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<LockerTab>('character');
  const [caseSpin, setCaseSpin] = useState<{ won: string; dupe: boolean; refund: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active || !d.profile) return;
        const p = d.profile;
        setProfile({
          unlocked: p.unlocked ?? [],
          credits: p.credits ?? 0,
          equipped: p.equipped ?? {},
          level: p.level ?? 1,
        });
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
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const owns = (id: string, source: CosmeticSource) =>
    !profile || profile.unlocked.includes(id) || source.type === 'default';

  const equip = async (sl: LockerSlotDef, id: string) => {
    if (!profile) {
      onChange(sl.apply(settings, id)); // local-only fallback
      return;
    }
    setBusy(id);
    setNote(null);
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
      } else setNote('Could not equip that.');
    } catch {
      setNote('Network error.');
    }
    setBusy(null);
  };

  const buy = async (sl: LockerSlotDef, id: string) => {
    setBusy(id);
    setNote(null);
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
        await equip(sl, id);
      } else setNote(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not buy that.');
    } catch {
      setNote('Network error.');
    }
    setBusy(null);
  };

  const openCase = async () => {
    if (busy || (profile != null && profile.credits < HAT_CASE_COST)) return;
    setBusy('__case');
    setNote(null);
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
      } else setNote(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not open the case.');
    } catch {
      setNote('Network error.');
    }
    setBusy(null);
  };

  const active = LOCKER_TABS.find((t) => t.id === tab) ?? LOCKER_TABS[0];
  const slots = LOCKER_SLOTS.filter((sl) => (active.slots as readonly string[]).includes(sl.slot));
  return (
    <>
    <LockerShell tab={tab} setTab={setTab} credits={profile?.credits ?? null} onClose={onClose}>
      <p className='text-[10px] leading-relaxed text-white/35'>
        Cosmetics — purely visual, never affect aim, movement, or hits.
      </p>
      {note && <div className='text-[11px] text-rose-300'>{note}</div>}
      {active.view && <LockerPreview key={active.view} settings={settings} view={active.view} />}
      {tab === 'card' && <CardStatsEditor settings={settings} onChange={onChange} account={account} />}
      {slots.map((sl) => (
        <div key={sl.slot} className='flex flex-col gap-2'>
          <div className='text-[10px] uppercase tracking-[0.2em] text-white/45'>{sl.label}</div>
          {sl.slot === 'hat' && (
            <button
              type='button'
              onClick={openCase}
              disabled={busy === '__case' || (profile != null && profile.credits < HAT_CASE_COST)}
              title={
                profile != null && profile.credits < HAT_CASE_COST
                  ? `Need ${HAT_CASE_COST - profile.credits} more credits — earn them by playing online matches`
                  : undefined
              }
              className='flex items-center justify-center gap-2 rounded-lg border border-fuchsia-400/40 bg-gradient-to-r from-fuchsia-500/15 to-amber-400/15 px-3 py-2 text-[12px] font-bold uppercase tracking-[0.12em] text-amber-100 transition hover:from-fuchsia-500/25 hover:to-amber-400/25 disabled:opacity-40'
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
            {sl.items.map((item) => {
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
                  className={`flex flex-col rounded-lg border px-3 py-2 ${
                    equipped
                      ? 'border-cyan-300/80 bg-cyan-300/10'
                      : owned
                        ? 'border-white/10 bg-white/[0.03]'
                        : 'border-white/5 bg-white/[0.01] opacity-80'
                  }`}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className={`text-sm font-semibold ${owned ? 'text-white' : 'text-white/60'}`}>
                      {item.name}
                    </span>
                    <span className={`text-[9px] uppercase tracking-[0.14em] ${RARITY_STYLE[item.rarity]}`}>
                      {item.rarity}
                    </span>
                  </div>
                  <div className='mt-1 flex-1 text-[11px] leading-snug text-white/50'>{item.blurb}</div>
                  <div className='mt-2'>
                    {equipped ? (
                      <div className='text-[9px] uppercase tracking-[0.18em] text-cyan-300'>
                        ✓ Equipped
                      </div>
                    ) : owned ? (
                      <button
                        type='button'
                        data-action='equip'
                        disabled={working}
                        onClick={() => equip(sl, item.id)}
                        className='w-full rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-50'
                      >
                        {working ? '…' : 'Equip'}
                      </button>
                    ) : buyable ? (
                      <button
                        type='button'
                        data-action='buy'
                        disabled={working || !affordable}
                        onClick={() => buy(sl, item.id)}
                        className='w-full rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40'
                        title={affordable ? '' : 'Not enough credits'}
                      >
                        {working ? '…' : `Buy · ${item.source.type === 'credits' ? item.source.price : 0} ⛁`}
                      </button>
                    ) : (
                      <div className='text-[10px] uppercase tracking-[0.12em] text-white/35'>
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

// The Locker's own modal frame: a wider panel with a STICKY header (title + tab
// bar + credits) so the tabs never scroll away, over a scrolling body.
function LockerShell({
  tab,
  setTab,
  credits,
  onClose,
  children,
}: {
  tab: LockerTab;
  setTab: (t: LockerTab) => void;
  credits: number | null;
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
        aria-label='Locker'
        onClick={(e) => e.stopPropagation()}
        className='clip-deck deck-rise flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col border border-cyan-500/30 bg-zinc-950/95 shadow-[0_0_60px_-12px_rgba(34,211,238,0.4)]'
      >
        <div className='shrink-0 border-b border-white/10 px-6 pb-3 pt-5'>
          <div className='flex items-center justify-between'>
            <div className='font-display text-base font-bold uppercase tracking-[0.18em] text-cyan-100'>
              Locker
            </div>
            <button
              onClick={onClose}
              className='font-mono text-[11px] uppercase tracking-[0.18em] text-white/55 transition hover:text-cyan-200'
            >
              ✕ Esc
            </button>
          </div>
          <div className='mt-3 flex items-center justify-between gap-3'>
            <div className='flex flex-wrap gap-1.5'>
              {LOCKER_TABS.map((t) => (
                <button
                  key={t.id}
                  type='button'
                  onClick={() => setTab(t.id)}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] transition ${
                    tab === t.id
                      ? 'bg-cyan-300/15 text-cyan-200 ring-1 ring-cyan-300/40'
                      : 'text-white/50 hover:text-white/80'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {credits != null && (
              <span className='shrink-0 text-[11px] font-semibold text-amber-300'>{credits} ⛁</span>
            )}
          </div>
        </div>
        <div className='flex flex-col gap-4 overflow-y-auto px-6 py-4 font-mono'>{children}</div>
      </div>
    </div>
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
  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md'
      onClick={revealed ? onClose : undefined}
    >
      <div
        className='w-[560px] max-w-[94vw] rounded-2xl border border-fuchsia-500/30 bg-zinc-950/95 p-6 font-mono shadow-2xl'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-3 text-center text-[11px] uppercase tracking-[0.3em] text-fuchsia-200/80'>
          {revealed ? (dupe ? 'Duplicate' : 'Unboxed!') : 'Opening case…'}
        </div>
        <div
          ref={vpRef}
          className='relative h-28 overflow-hidden rounded-lg border border-white/10 bg-black/40'
        >
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
          <div className='mt-4 flex flex-col items-center gap-1 text-center'>
            <div className={`text-xl font-extrabold ${RARITY_STYLE[wonHat.rarity]}`}>
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
            <button
              onClick={onClose}
              className='mt-3 rounded-lg bg-emerald-400 px-6 py-2 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300'
            >
              Nice
            </button>
          </div>
        )}
      </div>
    </div>
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
      className={`flex h-24 shrink-0 flex-col items-center justify-center gap-1 rounded-md border-2 bg-white/[0.04] px-2 ${ring}`}
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
      className={`mt-4 rounded-lg border px-4 py-3 transition-colors ${
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
        <div className='relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/10'>
          <div
            className={`h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-300 ${
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
    <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='max-h-[94vh] w-[760px] max-w-[96vw] overflow-y-auto rounded-2xl border border-cyan-500/25 bg-zinc-950/95 font-mono shadow-2xl'>
        {/* Header: Victory/Defeat title (kept clear of the 3D labels below) */}
        <div className='border-b border-white/10 bg-black/40 py-3 text-center'>
          <span
            className={`text-2xl font-extrabold uppercase tracking-[0.24em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
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
        <div className='h-[340px] w-full bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
          <PodiumResults winners={winners} />
        </div>

        <div className='p-6 pt-4'>
          {/* Full scoreboard (all players, compact) */}
          <div className='overflow-hidden rounded-lg border border-white/10'>
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

          {progression && <XpReward progression={progression} />}

          <div className='mt-6 flex gap-3'>{footer}</div>
        </div>
      </div>
    </div>
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
        <button
          onClick={onContinue}
          className='flex-1 rounded-lg bg-cyan-400 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300'
        >
          Continue to Map Vote → {secs > 0 ? `(${secs})` : ''}
        </button>
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

// Online + the connection dropped mid-match: tell the player the game stalled
// and is auto-retrying, instead of leaving them in a silent "ghost match".
function DisconnectedOverlay({ error, onLeave }: { error: boolean; onLeave: () => void }) {
  return (
    <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md pointer-events-auto'>
      <div className='w-[440px] max-w-[94vw] rounded-2xl border border-rose-500/30 bg-zinc-950/95 p-7 text-center font-mono shadow-2xl'>
        <div className='flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] text-rose-200'>
          <span className='inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-rose-300 shadow-[0_0_6px_rgba(251,113,133,0.85)]' />
          {error ? 'Connection error' : 'Connection lost'}
        </div>
        <div className='mt-3 text-xl font-bold text-white'>Reconnecting…</div>
        <p className='mt-2 text-sm text-white/55'>
          Lost contact with the server. Trying to get you back into the match — this usually
          takes a few seconds.
        </p>
        <button
          onClick={onLeave}
          className='mt-5 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-white/80 transition hover:bg-white/10'
        >
          Leave to menu
        </button>
      </div>
    </div>
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

function HudOverlay({
  hud,
  settings,
}: {
  hud: HudState;
  settings: Settings;
}) {
  const dead = hud.killcam !== null;
  const s = settings.uiScale || 1;
  // UI scale: a counter-sized wrapper rendered at 1/s then transform-scaled by s,
  // so corner-anchored HUD elements keep their anchors while everything resizes.
  return (
    <div className='pointer-events-none absolute inset-0 select-none'>
      <div
        className='absolute left-0 top-0 origin-top-left'
        style={{ width: `${100 / s}%`, height: `${100 / s}%`, transform: `scale(${s})` }}
      >
        {!dead && <BoostRing active={hud.boostReady} />}
      <KillFlashLayer flash={hud.killFlash} />
      {hud.damageFlash > 0 && (
        <div
          className='pointer-events-none absolute inset-0'
          style={{
            opacity: Math.min(1, hud.damageFlash),
            background:
              'radial-gradient(circle at center, transparent 35%, rgba(220,38,38,0.55) 100%)',
          }}
        />
      )}
      {!dead && <Crosshair cfg={settings.crosshair} />}
      {!dead && <ReloadBar railCooldown={hud.railCooldown} />}
      {!dead && <HitMarkerLayer marker={hud.hitMarker} />}
      <Killfeed entries={hud.killfeed} />
      <ToastStack toasts={hud.toasts} />
      <MiniLeaderboard scores={hud.scores} />
      {hud.mode === 'tdm' && hud.teamScores && (
        <TeamScoreBar scores={hud.teamScores} localTeam={hud.localTeam} />
      )}
      {hud.netDebug && <NetDebugOverlay s={hud.netDebug} />}
      {hud.training && <TrainingPanel t={hud.training} />}
      <BannerOverlay banner={hud.banner} />
      <CaptionLayer hud={hud} captions={settings.captions} />
      <FragPopup confirm={hud.killConfirm} />
      {/* Your own card is NOT shown on your kills — it's broadcast so the VICTIM
          sees it on their killcam. The killer's card shows on YOUR killcam below. */}
      <KillcamOverlay killcam={hud.killcam} reduced={settings.reducedEffects} />
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
      {hud.warmupMsLeft > 0 &&
        !hud.vote &&
        !hud.matchOver &&
        !hud.killcam && <WarmupOverlay remainingMs={hud.warmupMsLeft} />}
      {hud.showScoreboard && (
        <FullScoreboard
          scores={hud.scores}
          netStatus={hud.netStatus}
          mode={hud.mode}
          showPing={settings.showPing && hud.netStatus !== 'off'}
        />
      )}
      </div>
    </div>
  );
}

// Match-start "get ready" countdown. The server freezes shots during this
// window (resumeAt), so it's a fair start — nobody can be fragged on the bell.
function WarmupOverlay({ remainingMs }: { remainingMs: number }) {
  const secs = Math.max(1, Math.ceil(remainingMs / 1000));
  return (
    <div className='pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center'>
      <div className='text-[11px] font-semibold uppercase tracking-[0.4em] text-cyan-200/80'>
        Get ready
      </div>
      <div
        className='mt-1 font-mono text-7xl font-extrabold tabular-nums text-cyan-100'
        style={{ filter: 'drop-shadow(0 0 22px rgba(103,232,249,0.55))' }}
      >
        {secs}
      </div>
      <div className='mt-1 text-[10px] uppercase tracking-[0.3em] text-white/45'>
        Match starting
      </div>
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

function KillcamOverlay({ killcam, reduced = false }: { killcam: KillcamState | null; reduced?: boolean }) {
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
      {killcam.dirAngle !== undefined && (
        // Directional "the shot came from here" arrow, rotated around screen
        // center toward the killer (0 = dead ahead, clockwise). Teaches new
        // players where they're being picked off from.
        <div
          className='pointer-events-none absolute left-1/2 top-1/2'
          style={{ opacity, transform: `translate(-50%,-50%) rotate(${killcam.dirAngle}rad)` }}
        >
          <div
            className='text-3xl leading-none text-rose-400'
            style={{ transform: 'translateY(-128px)', filter: 'drop-shadow(0 0 8px rgba(244,63,94,0.85))' }}
          >
            ▲
          </div>
        </div>
      )}
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
        {killcam.killerCard && (
          <div className='mt-5'>
            <PlayerCard card={killcam.killerCard} reduced={reduced} />
          </div>
        )}
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

// Net-debug overlay (F3). Top-left live netcode readout so we can see the cause
// of jitter in a real match. The two tells: `extrap` high (frames rendering
// past the buffer = TCP stalls → UDP is the fix) vs `clkDrift` high (render
// clock wandering → a client-side cause UDP won't fix). `buffer` going negative
// means we're underrunning.
function NetDebugOverlay({ s }: { s: NonNullable<HudState['netDebug']> }) {
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

// Full-screen kill-confirmation flash: an edge vignette that pulses in and out
// so it reads as "frag!" without ever covering the crosshair. Cyan for body
// kills, amber for headshots.
function KillFlashLayer({ flash }: { flash: KillFlash | null }) {
  if (!flash) return null;
  const t = 1 - flash.remaining / flash.total;
  // Quick pulse: ramp up over the first ~25%, ease out over the rest.
  const pulse = t < 0.25 ? t / 0.25 : clamp01(1 - (t - 0.25) / 0.75);
  const edge = flash.headshot ? 'rgba(252,211,77,0.40)' : 'rgba(120,230,255,0.34)';
  return (
    <div
      key={flash.id}
      className='absolute inset-0'
      style={{
        opacity: pulse,
        background: `radial-gradient(ellipse at center, transparent 52%, ${edge} 100%)`,
      }}
    />
  );
}

function HitMarkerLayer({ marker }: { marker: HitMarker | null }) {
  if (!marker) return null;
  const max = marker.kind === 'hit' ? HIT_MARKER_DURATION_SEC : HIT_MARKER_KILL_DURATION_SEC;
  const t = 1 - marker.remaining / max;
  const isKill = marker.kind !== 'hit';
  // Kills get a snappier, bigger pop than plain hits.
  const scale = isKill ? 1.15 + t * 0.75 : 1 + t * 0.35;
  const opacity = clamp01(marker.remaining / (max * 0.6));
  const stroke =
    marker.kind === 'headshot' ? '#facc15' :
    marker.kind === 'kill' ? '#fb7185' :
    '#ffffff';
  // Use flex centering — exact crosshair alignment regardless of marker
  // size or scale. The previous translate(-50%) math drifted off-pixel
  // when the wrapper's intrinsic size didn't match the SVG viewBox.
  // Kill markers fire an expanding ring (a quick shockwave around the X).
  const ringScale = 0.5 + t * 2.0;
  const ringOpacity = isKill ? clamp01(1 - t) * 0.85 : 0;
  return (
    <div
      key={marker.id}
      className='absolute inset-0 flex items-center justify-center'
    >
      {isKill && (
        <svg
          width='42' height='42' viewBox='0 0 42 42' aria-hidden
          className='absolute'
          style={{ opacity: ringOpacity, transform: `scale(${ringScale})`, transformOrigin: '50% 50%' }}
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
        style={{ opacity, transform: `scale(${scale})`, transformOrigin: '50% 50%' }}
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
}

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

/* ───────────────────────── Training range panel ───────────────────────── */

function TrainingPanel({ t }: { t: TrainingHud }) {
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
}

/* ───────────────────────── Mini leaderboard (top-left) ───────────────────────── */

function MiniLeaderboard({ scores }: { scores: PlayerScore[] }) {
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
}

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

function CaptionLayer({ hud, captions }: { hud: HudState; captions: boolean }) {
  const text = captionText(hud);
  return (
    <>
      {/* Always present so screen readers announce callouts regardless of the
          visible-captions toggle. Only re-announces when the text changes. */}
      <div aria-live='assertive' aria-atomic='true' className='sr-only'>
        {text}
      </div>
      {captions && text && (
        <div className='pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2'>
          <span className='rounded-md bg-black/70 px-3 py-1.5 font-mono text-sm font-semibold uppercase tracking-[0.16em] text-white/90 shadow-lg'>
            {text}
          </span>
        </div>
      )}
    </>
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
      <div className='text-3xl font-bold tabular-nums leading-none'>
        {speed.toFixed(1)}
        <span className='ml-1 text-sm font-normal text-white/40'>m/s</span>
      </div>
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
}

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
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md">
      <div className="w-[420px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl">
        <div className={`px-7 py-6 text-center ${won ? 'bg-emerald-400/10' : 'bg-rose-500/10'}`}>
          <div
            className={`font-display text-4xl uppercase tracking-[0.18em] ${won ? 'text-emerald-300' : 'text-rose-300'}`}
          >
            {won ? 'Victory' : 'Defeat'}
          </div>
          <div className="mt-1 text-[12px] uppercase tracking-[0.2em] text-white/45">
            Ranked Duel · {result.winnerFrags}–{result.loserFrags}
            {result.forfeit && ' · forfeit'}
          </div>
        </div>
        <div className="px-7 py-6">
          {mine ? (
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-[0.2em] text-white/45">New rating</div>
              <div className="mt-1 flex items-center justify-center gap-3">
                <span className="font-display text-3xl tabular-nums" style={{ color: tier?.color }}>
                  {mine.rating}
                </span>
                <span
                  className={`font-mono text-lg tabular-nums ${delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                >
                  {delta >= 0 ? '+' : ''}
                  {delta}
                </span>
              </div>
              <div className="mt-1 text-[12px] text-white/55">
                {tier?.name} · ladder #{mine.rank}
              </div>
              {result.reduced && (
                <div className="mt-2 text-[11px] text-amber-300/80">
                  Reduced rating — repeat opponent
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-[12px] text-white/50">Unranked result.</div>
          )}
          {progression && (progression.xpGained > 0 || progression.creditsGained > 0) && (
            <div className="mt-4 text-center text-[12px] text-white/50">
              <span className="text-cyan-200">+{progression.xpGained} XP</span>
              {progression.creditsGained > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-200">+{progression.creditsGained} credits</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-center border-t border-white/10 px-7 py-4">
          <button
            onClick={onLobby}
            className="rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
          >
            Back to lobby
          </button>
        </div>
      </div>
    </div>
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
  const [elapsed, setElapsed] = useState(0);
  const searching = status?.state === 'searching';

  const refreshProfile = useCallback(() => {
    if (!account) return;
    fetch('/api/ranked/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { profile?: RankedProfile } | null) => setProfile(d?.profile ?? null))
      .catch(() => {});
    fetch('/api/ranked/leaderboard', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: RankedLeaderEntry[] } | null) => setLadder(d?.entries ?? []))
      .catch(() => {});
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

  return (
    <ModalShell title="Ranked Duel" onClose={onClose}>
      {!account ? (
        <div className="flex flex-col items-center gap-4 py-6 text-center font-mono">
          <p className="text-[13px] text-white/60">
            Ranked Duel is for logged-in players — your rating follows your account.
          </p>
          <button
            onClick={onOpenLogin}
            className="rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
          >
            Log in to play ranked
          </button>
        </div>
      ) : (
        <div className="grid gap-5 font-mono md:grid-cols-[1.2fr_1fr]">
          {/* Left: your rank + queue + ladder */}
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-white/12 bg-black/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/45">Your rating</div>
                  <div className="mt-0.5 flex items-baseline gap-2">
                    <span className="font-display text-3xl tabular-nums" style={{ color: tier?.color }}>
                      {profile?.rating ?? RANKED_BASE}
                    </span>
                    {tier && <span className="text-[12px] text-white/55">{tier.name}</span>}
                  </div>
                </div>
                <div className="text-right text-[11px] text-white/50">
                  {profile && profile.rank > 0 ? (
                    <div>
                      Ladder <span className="text-cyan-200">#{profile.rank}</span>
                    </div>
                  ) : (
                    <div className="text-white/35">Unranked</div>
                  )}
                  <div className="tabular-nums">
                    {profile?.wins ?? 0}W · {profile?.losses ?? 0}L
                  </div>
                  {profile?.provisional && <div className="text-amber-300/80">provisional</div>}
                </div>
              </div>
              <div className="mt-4">
                {searching ? (
                  <button
                    onClick={onCancel}
                    className="w-full rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm font-bold uppercase tracking-[0.16em] text-rose-200 transition hover:bg-rose-500/20"
                  >
                    Searching… {elapsed}s · cancel
                  </button>
                ) : (
                  <button
                    onClick={onQueue}
                    className="w-full rounded-lg bg-cyan-400 px-4 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
                  >
                    Find ranked match
                  </button>
                )}
                {status?.reason === 'account' && (
                  <p className="mt-2 text-center text-[11px] text-rose-300">Ranked needs an account.</p>
                )}
                {status?.reason === 'in-match' && (
                  <p className="mt-2 text-center text-[11px] text-rose-300">
                    You're already in a ranked match in another tab.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-white/12 bg-black/30 p-4">
              <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-white/45">Ladder</div>
              {ladder.length === 0 ? (
                <div className="py-4 text-center text-[12px] text-white/35">No ranked players yet — be the first.</div>
              ) : (
                <div className="max-h-[260px] overflow-y-auto">
                  <table className="w-full text-left text-[12px]">
                    <tbody>
                      {ladder.map((e, i) => {
                        const t = rankedTier(e.rating);
                        const me = profile?.id === e.id;
                        return (
                          <tr key={e.id} className={`border-t border-white/8 ${me ? 'bg-cyan-400/10' : ''}`}>
                            <td className="py-1.5 pr-2 tabular-nums text-white/40">{i + 1}</td>
                            <td className="py-1.5 pr-2 text-white/85">
                              <span className="flex items-center gap-1">
                                {e.userName}
                                {e.verified && <span className="text-cyan-300">✓</span>}
                              </span>
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums" style={{ color: t.color }}>
                              {e.rating}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-white/40">
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
          <div className="rounded-lg border border-white/12 bg-black/30 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/45">Live ranked duels</span>
              <span className="text-[10px] text-white/30">👁 spectate</span>
            </div>
            {rooms.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-white/35">No live ranked duels right now.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {rooms.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onSpectate(r.id, r.mapId)}
                    className="flex items-center justify-between rounded-md border border-white/12 bg-black/40 px-3 py-2 text-left transition hover:border-cyan-400/50 hover:bg-cyan-400/5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-white/80">
                      {r.players.map((p) => p.name).join('  vs  ') || 'Ranked duel'}
                    </span>
                    <span className="ml-3 shrink-0 tabular-nums text-[12px] text-cyan-200">
                      {r.players.map((p) => p.frags).join(' – ')}
                    </span>
                    {r.spectators > 0 && (
                      <span className="ml-2 shrink-0 text-[10px] text-white/35">👁 {r.spectators}</span>
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
  // Selected online game mode for Quick Match + Create Match (FFA / Duel / TDM).
  const [selectedMode, setSelectedMode] = useState<GameMode>(DEFAULT_GAME_MODE);
  // Live menu presence + global chat (pushed over the lobby socket).
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [chatNotice, setChatNotice] = useState<string | null>(null);

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
    lobby.onChatRejected = (reason) =>
      setChatNotice(
        reason === 'rate'
          ? 'Slow down — too many messages.'
          : reason === 'account'
            ? 'Log in to chat.'
            : 'Message blocked by the filter.',
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

  // Auto-dismiss a chat rejection notice (rate-limit / filter).
  useEffect(() => {
    if (!chatNotice) return;
    const t = setTimeout(() => setChatNotice(null), 3000);
    return () => clearTimeout(t);
  }, [chatNotice]);

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
                    onClick={() => setAdminOpen(true)}
                    className='border border-amber-400/40 px-1.5 py-0.5 font-bold text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100'
                  >
                    Admin
                  </button>
                )}
                <button onClick={onLogout} className='text-white/35 transition hover:text-white/70'>
                  Log&nbsp;out
                </button>
              </span>
            ) : (
              <button
                onClick={onOpenLogin}
                title='Save your progress across devices'
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
                className='clip-deck-sm inline-flex items-center gap-1.5 border border-amber-400/40 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100'
              >
                <span className='text-white/45'>Lv {lobbyProfile.level}</span>
                <span>{lobbyProfile.credits} ⛁</span>
              </button>
            )}
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
                // "Play Now" = mode-agnostic super-queue: join whatever's live so a
                // small population concentrates instead of splitting 3 ways. The
                // mode picker drives Create Match for players who want a specific one.
                lobbyRef.current?.quickMatch('any');
                window.setTimeout(() => setSearching(false), 6000);
              }}
              disabled={!online || playDisabled || searching}
              className='clip-deck deck-rise bg-emerald-400 px-6 py-5 text-left font-display text-lg font-bold uppercase tracking-[0.18em] text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40'
              style={{ animationDelay: '180ms' }}
            >
              <span className='flex items-center gap-3'>
                <span className='text-2xl leading-none'>▶</span>
                {searching ? 'Searching…' : 'Play Now'}
                <span className='ml-auto font-mono text-[11px] font-semibold tracking-[0.1em] text-zinc-950/60'>
                  Any mode · fastest
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
                    botCount: 0, // targets, not a firefight — practice aim + movement safely
                    difficulty: settings.difficulty,
                    training: true,
                  })
                }
                disabled={playDisabled}
                accent='amber'
              >
                ⌖ Training Range
              </DeckButton>
              <div className='col-span-2'>
                <DeckButton
                  onClick={() => setRankedOpen(true)}
                  disabled={!online || playDisabled}
                  accent='fuchsia'
                  full
                >
                  <span className='inline-flex items-center gap-2'>
                    🏆 Ranked Duel
                    <span className='font-mono text-[10px] uppercase tracking-[0.14em] text-white/40'>
                      1v1 · Elo ladder
                    </span>
                  </span>
                </DeckButton>
              </div>
              <div className='col-span-2'>
                <DeckButton onClick={() => setSoloOpen(true)} disabled={playDisabled} full>
                  ◭ Solo vs Bots
                </DeckButton>
              </div>
              <div className='col-span-2 grid grid-cols-2 gap-3'>
                <DeckButton onClick={() => setStatsOpen(true)}>Stats</DeckButton>
                <DeckButton onClick={() => setChallengesOpen(true)}>
                  <span className='inline-flex items-center gap-2'>
                    Challenges
                    {claimable > 0 && (
                      <span
                        title={`${claimable} reward${claimable > 1 ? 's' : ''} ready to claim`}
                        className='inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-400 px-1 text-[10px] font-bold text-emerald-950'
                      >
                        {claimable}
                      </span>
                    )}
                  </span>
                </DeckButton>
                <DeckButton onClick={() => setLeaderboardOpen(true)}>Leaderboard</DeckButton>
                <DeckButton onClick={() => setLockerOpen(true)} accent='fuchsia'>
                  🎽 Locker
                </DeckButton>
                <DeckButton onClick={() => openSettingsAt('controls')} accent='cyan' full>
                  ⚙ Settings
                </DeckButton>
              </div>
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
                notice={chatNotice}
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
  accent?: 'cyan' | 'amber' | 'fuchsia' | 'plain';
  full?: boolean;
  children: ReactNode;
}) {
  const tone =
    accent === 'cyan'
      ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:border-cyan-300/70 hover:bg-cyan-300/20'
      : accent === 'amber'
        ? 'border-amber-300/40 bg-amber-300/10 text-amber-100 hover:border-amber-300/70 hover:bg-amber-300/20'
        : accent === 'fuchsia'
          ? 'border-fuchsia-300/40 bg-fuchsia-300/10 text-fuchsia-100 hover:border-fuchsia-300/70 hover:bg-fuchsia-300/20'
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
                    {r.spectators > 0 && (
                      <span className='rounded-sm bg-white/10 px-1.5 py-0.5 text-white/60'>
                        👁 {r.spectators}
                      </span>
                    )}
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  {/* Watch is always available for live matches — the whole point
                      is that a FULL match is still watchable. */}
                  <button
                    onClick={() => onSpectate(r)}
                    title='Spectate this match'
                    className='clip-deck-sm bg-white/10 px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-100 transition hover:bg-white/20'
                  >
                    👁 Watch
                  </button>
                  <button
                    onClick={() => onJoin(r)}
                    disabled={!r.joinable}
                    className='clip-deck-sm bg-emerald-400 px-4 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40'
                  >
                    {r.joinable ? 'Join' : 'Full'}
                  </button>
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
    <div className='clip-deck shrink-0 border border-white/10 bg-black/40 backdrop-blur-sm'>
      <button
        onClick={() => setOpen((v) => !v)}
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
  notice,
  onSend,
}: {
  messages: ChatMessage[];
  online: boolean;
  canChat: boolean; // false for guests — they can read but not send
  youName: string | null;
  notice: string | null;
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
    <div className='clip-deck flex h-full min-h-0 flex-col border border-white/10 bg-black/40 backdrop-blur-sm'>
      <div className='flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3'>
        <span className='font-display text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-200/90'>
          Global Chat
        </span>
        <span className='font-mono text-[9px] uppercase tracking-[0.16em] text-white/30'>keep it clean</span>
      </div>
      <div ref={scrollRef} className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2'>
        {messages.length === 0 ? (
          <div className='flex h-full items-center justify-center px-6 py-8 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/25'>
            {online ? 'Say hi 👋' : 'Linking to server…'}
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
      {notice && (
        <div className='shrink-0 border-t border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200'>
          {notice}
        </div>
      )}
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
          placeholder={!online ? 'Offline' : !canChat ? 'Log in to chat' : 'Message everyone…'}
          className='min-w-0 flex-1 bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-white outline-none transition placeholder:text-white/30 focus:bg-white/[0.07] disabled:opacity-40'
        />
        <button
          onClick={submit}
          disabled={!canSend || draft.trim().length === 0}
          className='clip-deck-sm shrink-0 bg-cyan-400 px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40'
        >
          Send
        </button>
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
    <ModalShell title='Your Profile' onClose={onClose}>
      {state === 'loading' && <div className='text-sm text-white/55'>Loading…</div>}
      {state === 'error' && (
        <div className='text-sm text-white/55'>
          Couldn&apos;t load your profile. Finish a match to start tracking.
        </div>
      )}
      {state === 'ready' && profile && stats && (
        <>
          {/* Level ring + XP bar + credits */}
          <div className='mb-4 flex items-center gap-4 rounded-xl border border-cyan-500/20 bg-cyan-300/[0.04] p-4'>
            <div className='flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-full border-2 border-cyan-400/60 bg-cyan-300/10'>
              <div className='text-[8px] uppercase tracking-[0.18em] text-cyan-200/70'>Level</div>
              <div className='text-2xl font-extrabold leading-none text-cyan-100'>{profile.level}</div>
            </div>
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between text-[11px]'>
                <span className='uppercase tracking-[0.16em] text-white/50'>
                  {profile.xpForNext > 0 ? 'Next level' : 'Max level'}
                </span>
                <span className='font-semibold text-amber-300'>{profile.credits} ⛁ credits</span>
              </div>
              <div className='mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10'>
                <div
                  className='h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-300'
                  style={{ width: `${xpPct}%` }}
                />
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
  const [flash, setFlash] = useState<string | null>(null);

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
    setFlash(null);
    try {
      const res = await fetch('/api/challenges/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      });
      const d = (await res.json()) as { ok?: boolean; xpGained?: number; creditsGained?: number };
      if (res.ok && d.ok) {
        setFlash(`+${d.xpGained} XP · +${d.creditsGained} ⛁`);
        load();
      }
    } catch {
      /* ignore */
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
        className='rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5'
      >
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm text-white/90'>{c.title}</span>
          <span className='shrink-0 text-[10px] uppercase tracking-[0.12em] text-amber-300/90'>
            {c.rewardXp} XP · {c.rewardCredits} ⛁
          </span>
        </div>
        <div className='mt-2 flex items-center gap-2'>
          <div className='h-2 flex-1 overflow-hidden rounded-full bg-white/10'>
            <div
              className={`h-full rounded-full ${c.complete ? 'bg-emerald-400' : 'bg-cyan-400/80'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className='w-14 shrink-0 text-right text-[11px] tabular-nums text-white/55'>
            {Math.min(c.progress, c.goal)}/{c.goal}
          </span>
          {c.claimed ? (
            <span className='w-16 shrink-0 text-right text-[10px] uppercase tracking-[0.14em] text-white/35'>
              Claimed
            </span>
          ) : (
            <button
              type='button'
              data-action='claim'
              disabled={!c.complete || claiming === c.id}
              onClick={() => claim(c.id)}
              className='w-16 shrink-0 rounded-md border border-emerald-400/50 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-emerald-200 transition hover:bg-emerald-400/20 disabled:border-white/10 disabled:bg-transparent disabled:text-white/25'
            >
              {claiming === c.id ? '…' : 'Claim'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <ModalShell title='Challenges' onClose={onClose}>
      {state === 'loading' && <div className='text-sm text-white/55'>Loading…</div>}
      {state === 'error' && (
        <div className='text-sm text-white/55'>
          Couldn&apos;t load challenges. Play an online match to start earning.
        </div>
      )}
      {state === 'ready' && data && (
        <div className='flex flex-col gap-4'>
          {flash && (
            <div className='rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-center text-sm font-bold text-emerald-200'>
              Reward claimed: {flash}
            </div>
          )}
          <div>
            <div className='mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45'>
              Daily · resets every day
            </div>
            <div className='flex flex-col gap-2'>{data.daily.map(Row)}</div>
          </div>
          <div>
            <div className='mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45'>
              Weekly · bigger rewards
            </div>
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
    <div className='rounded-lg border border-white/10 bg-white/5 px-4 py-3'>
      <div className='text-[10px] uppercase tracking-[0.2em] text-white/45'>{label}</div>
      <div className='mt-1 text-2xl font-bold tabular-nums text-cyan-200'>{value}</div>
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
    <ModalShell title='Leaderboard' onClose={onClose}>
      <ButtonGroup label='Window' value={window} options={LEADERBOARD_WINDOWS} onChange={setWindow} />
      {!isRanked && (
        <ButtonGroup label='Sort by' value={sort} options={LEADERBOARD_SORTS} onChange={setSort} />
      )}
      {state === 'loading' && <div className='text-sm text-white/55'>Loading…</div>}
      {state === 'error' && isRanked && (
        <div className='text-sm text-white/55'>Couldn&apos;t load the ranked ladder.</div>
      )}
      {state === 'ready' && isRanked && rankedRows.length === 0 && (
        <div className='text-sm text-white/55'>No ranked players yet — queue a Ranked Duel to appear here.</div>
      )}
      {state === 'ready' && isRanked && rankedRows.length > 0 && (
        <div className='-mx-1 max-h-[52vh] overflow-y-auto px-1'>
          <div className='grid grid-cols-[1.75rem_1fr_4.5rem_3.5rem_3rem] gap-x-3 gap-y-1 text-[12px]'>
            <Th align='right'>#</Th>
            <Th>Player</Th>
            <Th align='right'>Rating</Th>
            <Th>Tier</Th>
            <Th align='right'>W-L</Th>
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
        <div className='text-sm text-white/55'>Couldn&apos;t load the leaderboard. Try again later.</div>
      )}
      {state === 'ready' && !isRanked && rows.length === 0 && (
        <div className='text-sm text-white/55'>No ranked players yet — finish a match to appear here.</div>
      )}
      {state === 'ready' && !isRanked && rows.length > 0 && (
        <div className='-mx-1 max-h-[52vh] overflow-y-auto px-1'>
          <div className='grid grid-cols-[1.75rem_1fr_2.75rem_2.75rem_2.5rem_3rem] gap-x-3 gap-y-1 text-[12px]'>
            <Th align='right'>#</Th>
            <Th>Player</Th>
            <Th align='right'>K</Th>
            <Th align='right'>K/D</Th>
            <Th align='right'>W</Th>
            <Th align='right'>Acc</Th>
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

function LeaderboardRow({ rank, row, you = false }: { rank: number; row: LeaderboardEntry; you?: boolean }) {
  const medal =
    rank === 1 ? 'text-amber-300' : rank === 2 ? 'text-zinc-300' : rank === 3 ? 'text-orange-300' : 'text-white/45';
  const tint = you ? 'bg-cyan-300/10 text-cyan-100' : 'text-white/90';
  return (
    <>
      <div className={`py-1.5 text-right tabular-nums font-bold ${you ? 'text-cyan-200' : medal}`}>{rank}</div>
      <div className={`flex min-w-0 items-center gap-1 py-1.5 ${tint}`}>
        <span className='truncate'>{row.userName}</span>
        <NameBadges admin={row.admin} verified={row.verified} size={12} />
        {you && <span className='ml-1 shrink-0 text-[10px] uppercase tracking-[0.1em] text-cyan-300/80'>you</span>}
      </div>
      <div className={`py-1.5 text-right tabular-nums ${you ? 'text-cyan-100' : ''}`}>{row.totalKills}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.kd.toFixed(2)}</div>
      <div className='py-1.5 text-right tabular-nums text-white/65'>{row.totalWins}</div>
      <div className='py-1.5 text-right tabular-nums text-cyan-200/80'>{row.bestAccuracy.toFixed(1)}%</div>
    </>
  );
}

// A row on the Ranked (Elo) ladder: rank, player, rating, tier, W-L.
function RankedLeaderRow({ rank, row, you = false }: { rank: number; row: RankedLeaderEntry; you?: boolean }) {
  const medal =
    rank === 1 ? 'text-amber-300' : rank === 2 ? 'text-zinc-300' : rank === 3 ? 'text-orange-300' : 'text-white/45';
  const tint = you ? 'bg-cyan-300/10 text-cyan-100' : 'text-white/90';
  const tier = rankedTier(row.rating);
  return (
    <>
      <div className={`py-1.5 text-right tabular-nums font-bold ${you ? 'text-cyan-200' : medal}`}>{rank}</div>
      <div className={`flex min-w-0 items-center gap-1 py-1.5 ${tint}`}>
        <span className='truncate'>{row.userName}</span>
        <NameBadges admin={row.admin} verified={row.verified} size={12} />
        {you && <span className='ml-1 shrink-0 text-[10px] uppercase tracking-[0.1em] text-cyan-300/80'>you</span>}
      </div>
      <div className='py-1.5 text-right font-bold tabular-nums' style={{ color: tier.color }}>{row.rating}</div>
      <div className='py-1.5 text-[11px] uppercase tracking-[0.08em]' style={{ color: tier.color }}>{tier.name}</div>
      <div className='py-1.5 text-right tabular-nums text-white/55'>
        {row.wins}-{row.losses}
      </div>
    </>
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
  const [note, setNote] = useState<string | null>(null);
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
    setNote(null);
    try {
      const r = await fetch(`/api/admin/lookup?username=${encodeURIComponent(q)}`, {
        credentials: 'same-origin',
      });
      if (r.ok) {
        setTarget((await r.json()) as AdminLookup);
      } else {
        setTarget(null);
        setNote(r.status === 404 ? `No player named “${q}”.` : 'Lookup failed.');
      }
    } catch {
      setNote('Network error.');
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback(
    async (path: 'verify' | 'grant', body: object, label: string) => {
      if (!target) return;
      setBusy(true);
      setNote(null);
      const r = await adminPost(path, { username: target.username, ...body });
      setBusy(false);
      if (r.ok) {
        setNote(label);
        await lookup(target.username);
        refreshAudit();
      } else {
        setNote(r.error === 'forbidden' ? 'Not authorized.' : `Failed (${r.error}).`);
      }
    },
    [target, lookup, refreshAudit],
  );

  return (
    <ModalShell title='Admin' onClose={onClose}>
      <div className='flex flex-col gap-3 font-mono'>
        <a
          href='/admin'
          className='flex items-center justify-between rounded-md border border-cyan-400/40 bg-cyan-400/10 px-3 py-2.5 text-[12px] font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-400/15'
        >
          <span>📊 Metrics dashboard</span>
          <span aria-hidden>→</span>
        </a>
        <div className='flex gap-2'>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup(username)}
            placeholder='Player username'
            maxLength={20}
            className='min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60'
          />
          <button
            onClick={() => lookup(username)}
            disabled={busy || !username.trim()}
            className='shrink-0 rounded-md border border-cyan-400/40 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:border-cyan-300/70 disabled:opacity-40'
          >
            Look up
          </button>
        </div>

        {target && (
          <div className='rounded-md border border-white/12 bg-black/30 p-3'>
            <div className='flex items-center gap-2 text-sm font-bold text-white'>
              {target.username}
              <NameBadges admin={target.admin} verified={target.verified} size={13} />
            </div>
            <div className='mt-1 text-[11px] uppercase tracking-[0.14em] text-white/45'>
              {target.admin ? 'Admin' : 'Player'} · {target.verified ? 'Verified' : 'Not verified'}
            </div>
            <div className='mt-3 grid grid-cols-2 gap-2'>
              <button
                onClick={() => act('verify', { verified: !target.verified }, target.verified ? 'Unverified.' : 'Verified ✓')}
                disabled={busy}
                className='rounded-md border border-sky-400/40 px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-sky-200 transition hover:border-sky-300/70 disabled:opacity-40'
              >
                {target.verified ? 'Remove verify' : 'Verify ✓'}
              </button>
              <button
                onClick={() => act('grant', { admin: !target.admin }, target.admin ? 'Admin revoked.' : 'Admin granted.')}
                disabled={busy}
                className='rounded-md border border-amber-400/40 px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-amber-200 transition hover:border-amber-300/70 disabled:opacity-40'
              >
                {target.admin ? 'Revoke admin' : 'Make admin'}
              </button>
            </div>
          </div>
        )}

        {note && <div className='text-[12px] text-cyan-200/80'>{note}</div>}

        <div className='mt-1'>
          <div className='mb-1.5 text-[10px] uppercase tracking-[0.18em] text-white/45'>Recent activity</div>
          <div className='max-h-[34vh] space-y-1 overflow-y-auto text-[11px]'>
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
  const [search, setSearch] = useState('');
  const visibleTabs = filterTabs(search);
  const onSearch = (q: string) => {
    setSearch(q);
    const m = filterTabs(q);
    if (m.length && !m.some((t) => t.id === tab)) setTab(m[0].id);
  };
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
        className='flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-xl border border-white/12 bg-zinc-950/95 p-6 font-mono shadow-2xl'
      >
        <div className='mb-4 flex items-center justify-between'>
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
        <input
          type='search'
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder='Search settings…'
          aria-label='Search settings'
          className='mb-3 w-full rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-xs text-white placeholder:text-white/30 outline-none transition focus:border-cyan-400/60'
        />
        {/* Tab bar */}
        <div
          role='tablist'
          aria-label='Settings sections'
          className='mb-4 flex flex-wrap gap-1.5 border-b border-white/10 pb-3'
        >
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              role='tab'
              aria-selected={tab === t.id}
              data-tab={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
                tab === t.id
                  ? 'bg-cyan-300/15 text-cyan-200'
                  : 'text-white/50 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Fixed-height scroll area so the modal doesn't grow/shrink (and the
            header jump) as you switch between short + tall tabs. */}
        <div className='flex h-[58vh] flex-col gap-5 overflow-y-auto pr-1' role='tabpanel'>
          {visibleTabs.length === 0 ? (
            <div className='text-sm text-white/55'>No settings match “{search.trim()}”.</div>
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
        className={`rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-xs text-white outline-none transition focus:border-emerald-400/70 ${
          readOnly ? 'cursor-not-allowed text-white/55 focus:border-white/15' : ''
        }`}
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
        <button
          type='button'
          role='switch'
          aria-checked={value}
          aria-label={label}
          onClick={() => onChange(!value)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
            value ? 'bg-emerald-400' : 'bg-white/15'
          }`}
        >
          <span
            className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${
              value ? 'left-6' : 'left-1'
            }`}
          />
        </button>
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

function SettingsShare({
  settings,
  onImport,
}: {
  settings: Settings;
  onImport: (s: Settings) => void;
}) {
  const code = encodeSettings(settings);
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
    const next = decodeSettings(paste);
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
        <span className='text-[10px] uppercase tracking-[0.16em] text-white/55'>
          All-settings code (backup / transfer)
        </span>
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
          className='shrink-0 rounded bg-emerald-400 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-emerald-300'
        >
          Copy
        </button>
      </div>
      <div className='flex items-center gap-2'>
        <input
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder='Paste an IGS- code to import…'
          className='min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-white/80 placeholder:text-white/30 outline-none'
        />
        <button
          onClick={doImport}
          disabled={!paste.trim()}
          className='shrink-0 rounded border border-white/20 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/10 disabled:opacity-40'
        >
          Import
        </button>
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
