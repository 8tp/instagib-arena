import { useEffect, useState } from 'react';

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
