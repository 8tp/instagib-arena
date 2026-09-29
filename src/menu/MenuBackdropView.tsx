import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MenuBackdrop } from './menu-backdrop';
import type { HeroLoadout } from './menu-hero';

// React host for the live 3D menu backdrop. The engine module (and Three.js
// with it) is imported lazily, so the landing page can mount this without
// paying for the 3D chunk on first paint; the canvas fades in once the first
// frame is drawn. A 2D overlay canvas carries the map-to-map crossfade.
//
// `active` pauses the loop (modal open, match starting). `still` renders a
// single frame and never loops (lowSpec / reducedEffects).
//
// Hero (menu only): `hero` is the loadout your combatant wears and `heroSlot`
// the DOM box it stands in — measured here and handed to the backdrop, which
// frames the character into it. `heroHover` squares it up to the camera;
// bumping `heroEmote` plays the equipped emote now.
export function MenuBackdropView({
  active = true,
  still = false,
  lowSpec = false,
  delayMs = 0,
  className = '',
  onMap,
  hero = null,
  heroSlot,
  heroHover = false,
  heroEmote = 0,
  bloomScale = 0.8,
}: {
  active?: boolean;
  still?: boolean;
  lowSpec?: boolean;
  delayMs?: number; // defer the 3D import (landing: let the page paint first)
  className?: string;
  onMap?: (id: string, name: string) => void;
  hero?: HeroLoadout | null;
  heroSlot?: RefObject<HTMLElement | null>;
  heroHover?: boolean;
  heroEmote?: number;
  bloomScale?: number; // player's Bloom intensity setting (0..1.5)
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<MenuBackdrop | null>(null);
  const activeRef = useRef(active);
  const onMapRef = useRef(onMap);
  const heroRef = useRef(hero);
  const hoverRef = useRef(heroHover);
  const bloomRef = useRef(bloomScale);
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
              hero: heroRef.current,
            });
            backdropRef.current = bd;
            if (import.meta.env.DEV) (window as unknown as { __menuBackdrop?: MenuBackdrop }).__menuBackdrop = bd;
            bd.setActive(activeRef.current);
            bd.setHeroHover(hoverRef.current);
            bd.setBloomScale(bloomRef.current);
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

  useEffect(() => {
    heroRef.current = hero;
    backdropRef.current?.setHero(hero);
  }, [hero, ready]);

  useEffect(() => {
    hoverRef.current = heroHover;
    backdropRef.current?.setHeroHover(heroHover);
  }, [heroHover]);

  useEffect(() => {
    bloomRef.current = bloomScale;
    backdropRef.current?.setBloomScale(bloomScale);
  }, [bloomScale, ready]);

  useEffect(() => {
    if (heroEmote > 0) backdropRef.current?.heroEmote();
  }, [heroEmote]);

  // Measure the hero slot (relative to the canvas) and hand it to the 3D.
  useEffect(() => {
    if (!ready || !heroSlot) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const bd = backdropRef.current;
      const slot = heroSlot.current;
      const root = rootRef.current;
      if (!bd || !root) return;
      if (!slot) {
        bd.setHeroFrame(null);
        return;
      }
      const r = slot.getBoundingClientRect();
      const c = root.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || c.width < 2) {
        bd.setHeroFrame(null);
        return;
      }
      bd.setHeroFrame({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, vw: c.width, vh: c.height });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro) {
      if (heroSlot.current) ro.observe(heroSlot.current);
      if (rootRef.current) ro.observe(rootRef.current);
    }
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ready, heroSlot, hero]);

  return (
    <div ref={rootRef} aria-hidden='true' className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
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
