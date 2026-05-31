import type { KillConfirm } from './types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Prominent per-frag confirmation — the "you got a kill" callout that pops on
// EVERY kill (the multi-kill banner only fires on streaks). Big punchy centered
// text that slams in, holds, then fades. Sits in the upper third so it never
// covers the crosshair. Cyan for body kills, amber for headshots — matching the
// kill flash + hit marker.
export function FragPopup({ confirm }: { confirm: KillConfirm | null }) {
  if (!confirm) return null;
  const t = 1 - confirm.remaining / confirm.total; // 0 → 1 over its lifetime
  const enter = clamp01(t / 0.08); // pop in fast
  const exit = confirm.remaining < 0.45 ? clamp01(confirm.remaining / 0.45) : 1;
  const opacity = enter * exit;

  // Overshoot pop: 0.55 → 1.15 → settle to 1.0.
  let scale: number;
  if (t < 0.08) scale = 0.55 + 0.6 * (t / 0.08);
  else if (t < 0.2) scale = 1.15 - 0.15 * ((t - 0.08) / 0.12);
  else scale = 1.0;
  const ty = (1 - enter) * -12;

  const headshot = confirm.headshot;
  const accent = headshot ? '#fcd34d' : '#7ce8ff';
  const glow = headshot ? 'rgba(252,211,77,0.55)' : 'rgba(124,232,255,0.5)';
  const verb = headshot ? 'HEADSHOT' : 'FRAGGED';

  return (
    <div className='absolute inset-x-0 top-[30%] flex justify-center'>
      <div
        key={confirm.id}
        className='flex flex-col items-center text-center'
        style={{
          opacity,
          transform: `translateY(${ty}px) scale(${scale})`,
          transformOrigin: '50% 50%',
        }}
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
}
