import { useEffect, useState } from 'react';

// Several levelshots at once (the map-vote cards). Renders the missing ones one
// after another so only a single offscreen WebGL context exists at a time; the
// ones already cached (menu backdrop, loading screen) appear immediately. Thumbnails
// are small, so uncached ones render on the cheap 800px tier.
export function useLevelshots(mapIds: readonly string[]): Record<string, string> {
  const [shots, setShots] = useState<Record<string, string>>({});
  const key = mapIds.join('|');
  useEffect(() => {
    let alive = true;
    const ids = key ? key.split('|') : [];
    void (async () => {
      try {
        const m = await import('../menu/menu-backdrop');
        for (const id of ids) {
          if (!alive) return;
          const url = m.cachedLevelshot(id) ?? (await m.renderLevelshot(id, { lowSpec: true }));
          if (alive && url) setShots((s) => (s[id] === url ? s : { ...s, [id]: url }));
        }
      } catch {
        /* no thumbnails: the cards fall back to gradient art */
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);
  return shots;
}

// Levelshot for the loading screen: the menu backdrop pre-renders one per map
// it visits; otherwise a short-lived offscreen render makes one. The backdrop
// module (and Three.js) is imported lazily so this hook costs nothing until a
// match actually starts.
export function useLevelshot(mapId: string | null, lowSpec: boolean): string | null {
  const [shot, setShot] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!mapId) return;
    let alive = true;
    import('../menu/menu-backdrop')
      .then((m) => {
        const hit = m.cachedLevelshot(mapId);
        if (hit) return hit;
        return m.renderLevelshot(mapId, { lowSpec });
      })
      .then((url) => {
        if (alive && url) setShot({ id: mapId, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mapId, lowSpec]);
  return shot && shot.id === mapId ? shot.url : null;
}
