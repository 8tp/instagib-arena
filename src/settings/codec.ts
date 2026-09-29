// Settings defaults + share codes. Split out of InstagibClient.tsx so the
// Settings UI (src/settings/*) and the client shell share one source of truth.
import {
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_DPI,
  DEFAULT_FOV,
  DEFAULT_KEYBINDS,
  DEFAULT_RAW_INPUT,
  DEFAULT_SENSITIVITY,
  DEFAULT_VERT_SCALE,
  DEFAULT_VIEWMODEL_OFFSET,
  DEFAULT_VOLUME,
  DEFAULT_ZOOM_FOV,
} from '../game/constants';
import { DEFAULT_ANNOUNCER_PACK } from '../game/audio';
import {
  DEFAULT_CARD,
  DEFAULT_EMOTE,
  DEFAULT_HAT,
  DEFAULT_KILL_EFFECT,
  DEFAULT_NAME_COLOR,
  DEFAULT_RAILGUN_FINISH,
  DEFAULT_RAIL_COLOR,
  DEFAULT_SPAWN_EFFECT,
  DEFAULT_TITLE,
  DEFAULT_UNUSUAL,
} from '../game/cosmetics';
import { prefersReducedMotion } from '../deck-core';
import type { CrosshairConfig, Settings } from '../app-types';

export const DEFAULT_CROSSHAIR: CrosshairConfig = {
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

export const DEFAULT_SETTINGS: Settings = {
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
  enemyOutline: false,
  enemyOutlineColor: '#ffffff',
  enemyOutlineWidth: 2,
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

// Enemy outline thickness range (CSS px) — "within reason": thick enough to
// read at range, never a blob that hides the body.
export const ENEMY_OUTLINE_MIN = 1;
export const ENEMY_OUTLINE_MAX = 5;

export function clampOutlineWidth(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.enemyOutlineWidth;
  return Math.max(ENEMY_OUTLINE_MIN, Math.min(ENEMY_OUTLINE_MAX, Math.round(n * 2) / 2));
}

export function sanitizeHex(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

export const CROSSHAIR_STYLES = ['cross', 'cross-dot', 'dot', 'circle'] as const;

// Quick-apply shape presets (each sets the full shape config; color/outline are
// kept from the current crosshair). Three visually-distinct starting points.
export const CROSSHAIR_SHAPE_PRESETS: Array<{
  id: string;
  label: string;
  cfg: Partial<CrosshairConfig>;
}> = [
  { id: 'plus-gap', label: 'Plus · gap', cfg: { style: 'cross', size: 6, thickness: 2, gap: 4, dotSize: 0 } },
  { id: 'plus-solid', label: 'Plus · solid', cfg: { style: 'cross', size: 8, thickness: 2, gap: 0, dotSize: 0 } },
  { id: 'dot', label: 'Dot', cfg: { style: 'dot', size: 0, thickness: 2, gap: 0, dotSize: 3 } },
];

// Compact, URL-safe, copy-pasteable share code (prefixed so it's recognizable).
export function encodeCrosshair(c: CrosshairConfig): string {
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

export function decodeCrosshair(code: string): CrosshairConfig | null {
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
export function encodeSettings(s: Settings): string {
  const b64 = btoa(JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `IGS-${b64}`;
}

export function decodeSettings(code: string): Settings | null {
  try {
    const body = code.trim().replace(/^IGS-/i, '').replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(body)) as Partial<Settings>;
    if (!parsed || typeof parsed !== 'object') return null;
    // Merge over defaults so a partial/older code fills gaps and new fields survive.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      enemyOutline: !!(parsed.enemyOutline ?? DEFAULT_SETTINGS.enemyOutline),
      enemyOutlineColor: sanitizeHex(parsed.enemyOutlineColor, DEFAULT_SETTINGS.enemyOutlineColor),
      enemyOutlineWidth: clampOutlineWidth(parsed.enemyOutlineWidth ?? DEFAULT_SETTINGS.enemyOutlineWidth),
      crosshair: { ...DEFAULT_CROSSHAIR, ...(parsed.crosshair ?? {}) },
      keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds ?? {}) },
      viewmodelOffset: { ...DEFAULT_VIEWMODEL_OFFSET, ...(parsed.viewmodelOffset ?? {}) },
    };
  } catch {
    return null;
  }
}
