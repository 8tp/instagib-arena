import { memo } from 'react';
import type { KillConfirm } from './types';
import { hudTiming } from '../hud-store';

// The Q3 centre-print on every frag:
//
//     You fragged Razor
//     1st place with 12
//
// Pops on EVERY kill (the multi-kill banner only fires on streaks), sits in
// the upper third so it never covers the crosshair, and is one CSS animation
// keyed on the confirm id (.hud-frag in src/hud.css): it runs at display rate
// and React never touches the element again. The placement line is derived
// from the scoreboard by the caller; it may update in place for a moment
// online, where the authoritative score lands a snapshot after the kill.
export const FragPopup = memo(function FragPopup({
  confirm,
  placement,
}: {
  confirm: KillConfirm | null;
  placement?: string | null;
}) {
  if (!confirm) return null;
  const headshot = confirm.headshot;
  return (
    // Anchored by its BOTTOM edge at 42% of the height and growing upward, so
    // it can never cover the crosshair (at 50%) whatever the viewport height or
    // UI scale — a top-anchored print overlapped it on ≤680px-tall windows.
    <div className='absolute inset-x-0 bottom-[58%] flex justify-center px-6'>
      <div
        key={confirm.id}
        className='hud-frag hud-cprint flex flex-col items-center text-center'
        style={hudTiming(confirm.remaining, confirm.total)}
      >
        {headshot && <div className='hud-cprint-tag'>Headshot</div>}
        <div className='hud-cprint-main'>
          You fragged <span className={headshot ? 'text-amber-300' : 'text-cyan-300'}>{confirm.victimName}</span>
        </div>
        {placement && <div className='hud-cprint-sub'>{placement}</div>}
      </div>
    </div>
  );
});
