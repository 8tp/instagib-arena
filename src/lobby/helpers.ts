import { useEffect, useState, type CSSProperties } from 'react';
import { MAPS } from '../game/map';

// Helpers shared by the lobby surfaces AND the in-match overlays in
// InstagibClient (vote screen, HUD chat) — kept here so both import one copy.

export const CHAT_CLIENT_MAX_LEN = 240;

export function mapLabel(id: string): string {
  return MAPS.find((m) => m.id === id)?.label ?? id;
}

// "Causeway (FFA/TDM)" -> { name: 'Causeway', tag: 'FFA/TDM' }
export function mapParts(id: string): { name: string; tag: string } {
  const label = mapLabel(id);
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  return m ? { name: m[1], tag: m[2] } : { name: label, tag: '' };
}

// Build a shareable ?join= invite URL for a room code (used by the invite modal
// and the waiting-for-opponents overlay).
export function inviteLink(roomId: string): string {
  if (typeof window === 'undefined') return `?join=${roomId}`;
  return `${window.location.origin}${window.location.pathname}?join=${roomId}`;
}

// Stable hue from a string (avatars, map placeholders).
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Map thumbnail: the menu backdrop's levelshot when it has one cached (it
// pre-renders each arena it visits), else a tinted gradient. `render` asks for a
// fresh offscreen render — used for ONE selected map at a time, never a grid.
// The backdrop module (Three.js) is imported lazily, like useLevelshot does.
type Backdrop = typeof import('../menu/menu-backdrop');
let backdropMod: Backdrop | null = null;
export function useMapShot(mapId: string, render = false, lowSpec = false): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      backdropMod ??= await import('../menu/menu-backdrop');
      const hit = backdropMod.cachedLevelshot(mapId);
      if (hit) return hit;
      return render ? backdropMod.renderLevelshot(mapId, { lowSpec }) : null;
    };
    run()
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mapId, render, lowSpec]);
  return url;
}

export function mapShotStyle(mapId: string, url: string | null): CSSProperties {
  const h = hueOf(mapId);
  const grad = `linear-gradient(135deg, hsl(${h} 45% 22%), hsl(${(h + 50) % 360} 50% 12%))`;
  return { backgroundImage: url ? `url(${url})` : grad };
}
