import { memo } from 'react';
import type { KillConfirm } from './types';
import { hudTiming } from '../hud-store';

// Prominent per-frag confirmation — the "you got a kill" callout that pops on
// EVERY kill (the multi-kill banner only fires on streaks). Big punchy centered
// text that slams in, holds, then fades. The slam is the HUD's one overshoot
// and lives in the .hud-frag keyframes (src/hud.css), keyed on the confirm id:
// it runs at display rate and React never touches the element again. Sits in
// the upper third so it never covers the crosshair. Cyan for body kills,
// amber for headshots — matching the kill flash + hit marker.
export const FragPopup = memo(function FragPopup({ confirm }: { confirm: KillConfirm | null }) {
  if (!confirm) return null;
  const headshot = confirm.headshot;
  const accent = headshot ? '#fcd34d' : '#7ce8ff';
  const glow = headshot ? 'rgba(252,211,77,0.55)' : 'rgba(124,232,255,0.5)';
  const verb = headshot ? 'HEADSHOT' : 'FRAGGED';

  return (
    <div className='absolute inset-x-0 top-[30%] flex justify-center'>
      <div
        key={confirm.id}
        className='hud-frag flex flex-col items-center text-center'
        style={hudTiming(confirm.remaining, confirm.total)}
      >
        <div
          className='font-mono text-6xl font-black uppercase leading-none tracking-[0.06em]'
          style={{
            color: accent,
            textShadow: `0 4px 26px ${glow}`,
            WebkitTextStroke: '1px rgba(0,0,0,0.35)',
          }}
        >
          {verb}
        </div>
        <div
          className='mt-2 font-mono text-lg font-bold uppercase tracking-[0.3em] text-white'
          style={{ textShadow: '0 2px 10px rgba(0,0,0,0.65)' }}
        >
          {confirm.victimName}
        </div>
      </div>
    </div>
  );
});
