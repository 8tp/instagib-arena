import { useEffect, useRef, useState } from 'react';
import type { MenuBackdrop } from './menu-backdrop';

// React host for the live 3D menu backdrop. The engine module (and Three.js
// with it) is imported lazily, so the landing page can mount this without
// paying for the 3D chunk on first paint; the canvas fades in once the first
// frame is drawn. A 2D overlay canvas carries the map-to-map crossfade.
//
// `active` pauses the loop (modal open, match starting). `still` renders a
// single frame and never loops (lowSpec / reducedEffects).
export function MenuBackdropView({
  active = true,
  still = false,
  lowSpec = false,
  delayMs = 0,
  className = '',
  onMap,
}: {
  active?: boolean;
  still?: boolean;
  lowSpec?: boolean;
  delayMs?: number; // defer the 3D import (landing: let the page paint first)
  className?: string;
  onMap?: (id: string, name: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<MenuBackdrop | null>(null);
  const activeRef = useRef(active);
  const onMapRef = useRef(onMap);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onMapRef.current = onMap;
  }, [onMap]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const boot = () => {
      import('./menu-backdrop')
        .then((m) => {
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          try {
            // Dev: `?bdmap=<id>` pins the first arena (screenshot harness).
            const pinned = import.meta.env.DEV
              ? (new URLSearchParams(window.location.search).get('bdmap') ?? undefined)
              : undefined;
            const bd = new m.MenuBackdrop(canvas, fadeRef.current, {
              still,
              lowSpec,
              startMap: pinned,
              onMap: (id, name) => onMapRef.current?.(id, name),
            });
            backdropRef.current = bd;
            if (import.meta.env.DEV) (window as unknown as { __menuBackdrop?: MenuBackdrop }).__menuBackdrop = bd;
            bd.setActive(activeRef.current);
            setReady(true);
          } catch (err) {
            // No WebGL (or it failed to init): the CSS ground behind stays.
            console.warn('[menu] backdrop unavailable', err);
          }
        })
        .catch(() => {});
    };
    if (delayMs > 0) timer = window.setTimeout(boot, delayMs);
    else boot();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      backdropRef.current?.dispose();
      backdropRef.current = null;
      setReady(false);
    };
  }, [still, lowSpec, delayMs]);

  useEffect(() => {
    activeRef.current = active;
    backdropRef.current?.setActive(active);
  }, [active]);

  return (
    <div aria-hidden='true' className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <canvas
        // Fresh canvas per backdrop instance: the old one's context is
        // force-lost on dispose and a lost context can't be re-acquired, so
        // re-creating on the same element (toggling lowSpec / reduced effects
        // in Settings) left the menu black.
        key={`bd-${still ? 1 : 0}-${lowSpec ? 1 : 0}`}
        ref={canvasRef}
        className={`menu-bd-canvas absolute inset-0 h-full w-full ${ready ? 'menu-bd-ready' : ''}`}
      />
      <canvas ref={fadeRef} className='absolute inset-0 h-full w-full' style={{ opacity: 0 }} />
    </div>
  );
}
