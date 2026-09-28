import type { RefObject } from 'react';
import { uiHover, uiSfx } from '../deck-core';
import './menu.css';

// The box the 3D menu hero is framed into (MenuBackdropView measures it), plus
// the hit area over the character: hover squares the hero up to the camera
// and shows "Customize"; click opens the Locker. Always mounted — CSS hides it
// on layouts too narrow for a hero, and a collapsed slot hides the 3D too.
export function HeroSlot({
  slotRef,
  onCustomize,
  onHover,
  className = '',
}: {
  slotRef: RefObject<HTMLDivElement | null>;
  onCustomize: () => void;
  onHover: (on: boolean) => void;
  className?: string;
}) {
  return (
    <div ref={slotRef} className={`menu-hero-slot ${className}`}>
      <button
        type='button'
        onClick={() => {
          uiSfx('uiClick');
          onCustomize();
        }}
        onPointerEnter={(e) => {
          uiHover(e);
          if (e.pointerType !== 'touch') onHover(true);
        }}
        onPointerLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        aria-label='Customize your loadout (opens the Locker)'
        className='menu-hero-hit'
      >
        <span className='menu-hero-tag' aria-hidden='true'>
          Customize
        </span>
      </button>
    </div>
  );
}
