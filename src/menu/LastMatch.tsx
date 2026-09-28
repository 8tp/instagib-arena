import type { MatchResult } from '../game/game';
import type { MatchGain } from './road-data';
import './menu.css';

// "Last match" card under the ways to play: the outcome, four numbers, and
// what it earned (XP / credits / a level-up) when the profile moved.
export function LastMatchBanner({ result, gain }: { result: MatchResult; gain: MatchGain | null }) {
  const acc = result.shotsFired > 0 ? Math.round((result.shotsHit / result.shotsFired) * 100) : 0;
  const stats: [string, string | number][] = [
    ['Kills', result.kills],
    ['Deaths', result.deaths],
    ['Streak', result.bestStreak],
    ['Accuracy', `${acc}%`],
  ];
  const leveled = gain && gain.levelAfter > gain.levelBefore;
  return (
    <div className='menu-last menu-panel' data-won={result.won ? '1' : '0'}>
      <div className='flex items-baseline justify-between gap-3'>
        <span
          className={`font-display text-[22px] font-bold uppercase leading-none tracking-[0.1em] ${
            result.won ? 'text-emerald-300' : 'text-white/75'
          }`}
        >
          {result.won ? 'Victory' : 'Last match'}
        </span>
        {gain && (
          <span className='flex items-baseline gap-3'>
            <span className='menu-last-gain'>+{gain.xp.toLocaleString()} XP</span>
            {gain.credits > 0 && (
              <span className='font-mono text-[12px] tabular-nums text-amber-200/90'>+{gain.credits.toLocaleString()} cr</span>
            )}
          </span>
        )}
      </div>
      {leveled && (
        <div className='mt-1 font-display text-[13px] font-semibold uppercase tracking-[0.1em] text-cyan-200'>
          Level up · now level {gain.levelAfter}
        </div>
      )}
      <div className='mt-2.5 grid grid-cols-4 gap-2'>
        {stats.map(([label, value]) => (
          <div key={label}>
            <div className='font-mono text-[10px] text-white/40'>{label}</div>
            <div className='font-display text-xl font-bold tabular-nums leading-tight text-white/90'>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
