// The Locker's hero stage: the live 3D preview (one WebGL context for the
// whole Locker), a rarity tint behind it, and the DOM nameplate the preview
// keeps above the combatant's head. Everything else (details, card showcase,
// celebrations) is passed in as overlay children.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CharacterPreview, type PreviewCosmetics } from '../game/character-preview';

export type StageNameplate = { name: string; color: string; title: string };

export function LockerStage({
  cos,
  lowSpec,
  offsetX,
  offsetY,
  tint,
  watermark,
  nameplate,
  pulseKey,
  replayKey,
  children,
}: {
  cos: PreviewCosmetics;
  lowSpec: boolean;
  offsetX: number;
  offsetY: number;
  tint: string; // rarity colour of the shown item (eased in the 3D backdrop)
  watermark: string | null; // giant outlined slot name behind the subject
  nameplate: StageNameplate | null;
  pulseKey: number; // bump → celebrate() (spawn ring at the feet)
  replayKey: number; // bump → restart the current loop
  children?: ReactNode; // overlays drawn above the canvas
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const initial = useRef({ cos, lowSpec, tint, watermark });
  const [dragged, setDragged] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let preview: CharacterPreview;
    try {
      preview = new CharacterPreview(canvas, initial.current.cos, { lowSpec: initial.current.lowSpec });
    } catch {
      return; // no WebGL — the stage stays an empty backdrop, the grid still works
    }
    previewRef.current = preview;
    preview.enableOrbit(canvas);
    preview.setBackdrop({ tint: initial.current.tint, label: initial.current.watermark });
    preview.setAnchor(plateRef.current);
    preview.start();
    // Track the canvas box itself (layout changes, responsive stacking), rAF-
    // debounced to coalesce bursts.
    let pending = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => preview.resize());
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(pending);
      ro.disconnect();
      preview.dispose();
      previewRef.current = null;
    };
  }, []);

  useEffect(() => {
    previewRef.current?.setCosmetics(cos);
  }, [cos]);
  useEffect(() => {
    previewRef.current?.setBackdrop({ tint, label: watermark });
  }, [tint, watermark]);
  useEffect(() => {
    previewRef.current?.setScreenOffset(offsetX, offsetY);
  }, [offsetX, offsetY]);
  useEffect(() => {
    previewRef.current?.setAnchorVisible(!!nameplate);
  }, [nameplate]);
  useEffect(() => {
    if (pulseKey) previewRef.current?.celebrate();
  }, [pulseKey]);
  useEffect(() => {
    if (replayKey) previewRef.current?.replay();
  }, [replayKey]);

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      previewRef.current?.spin(e.key === 'ArrowLeft' ? -0.6 : 0.6);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      previewRef.current?.replay();
    }
  };

  return (
    <div className='lk-stage'>
      <canvas
        ref={canvasRef}
        className='lk-canvas'
        tabIndex={0}
        aria-label='Loadout preview. Drag or use the left and right arrow keys to rotate; Enter replays the effect.'
        onKeyDown={onKey}
        onPointerDown={() => setDragged(true)}
      />
      <div ref={plateRef} className='lk-plate' aria-hidden>
        {nameplate && (
          <div className='lk-plate-box' style={{ borderColor: `${nameplate.color}59` }}>
            <span className='lk-plate-name' style={{ color: nameplate.color }}>
              {nameplate.name}
            </span>
            {nameplate.title && <span className='lk-plate-title'>{nameplate.title}</span>}
          </div>
        )}
      </div>
      <div className={`lk-hint ${dragged ? 'lk-hint-gone' : ''}`}>Drag to rotate</div>
      {children}
    </div>
  );
}
