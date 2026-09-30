// Turntable playback for item tiles, hover cards and the case reveal: the
// strip from game/thumbs.ts played with a CSS steps() animation (frame-rate
// independent; see use-turntable.ts for when one is asked for).
import type { CSSProperties } from 'react';
import type { Turntable } from '../game/thumbs';

// The strip, clipped to its box: one frame per step, looping.
export function TurntableSprite({ sheet, className = '', style }: { sheet: Turntable; className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden className={`ec-turn ${className}`} style={style}>
      <img
        src={sheet.url}
        alt=''
        draggable={false}
        className='ec-turn-strip'
        style={{ width: `${sheet.frames * 100}%`, animation: `ec-turn ${sheet.ms}ms steps(${sheet.frames}) infinite` }}
      />
    </span>
  );
}

// A quiet "rendering the spin" hint: a thin sweep along the top edge.
export function TurntableLoading() {
  return <span aria-hidden className='ec-turn-loading' />;
}
