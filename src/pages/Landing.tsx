import { Link } from 'react-router-dom';

const CONTROLS: Array<[string, string]> = [
  ['Mouse', 'Aim'],
  ['Left click', 'Fire railgun — one shot, one kill'],
  ['WASD', 'Move'],
  ['Space', 'Jump (double-jump in the air)'],
  ['Shift', 'Dash (directional, on a cooldown)'],
  ['Jump at a wall', 'Wall-jump'],
  ['Esc', 'Release mouse / open menu'],
];

const MODES: Array<[string, string]> = [
  ['Practice', 'Offline range + bots. Warm up your aim and movement.'],
  ['Quick match', 'Drop into an open public arena instantly.'],
  ['Custom / private', 'Host a lobby or share an invite code with friends.'],
];

export default function Landing() {
  return (
    <div className="h-full overflow-y-auto bg-[#0a0a0b] text-neutral-100">
      {/* glow backdrop */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-cyan-500/10 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[28rem] w-[28rem] translate-x-1/3 translate-y-1/3 rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <main className="relative mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-10 px-6 py-16">
        <header className="space-y-4">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400/80">
            Browser FPS · Server-authoritative
          </p>
          <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
            Instagib&nbsp;Arena
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-neutral-400">
            Quake-style instagib in the browser. One shot, one kill. The railgun
            always kills — so the whole game is{' '}
            <span className="text-neutral-200">aim and movement</span>. Strafe,
            dash, double-jump, wall-jump. Veterans move twice as fast as anyone
            standing still.
          </p>
        </header>

        <Link
          to="/play"
          className="group inline-flex h-14 w-fit items-center gap-3 rounded-lg bg-cyan-400 px-8 text-sm font-semibold uppercase tracking-[0.18em] text-neutral-950 transition hover:bg-cyan-300"
        >
          Enter the arena
          <span className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </Link>

        <section className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-500">
              Controls
            </h2>
            <dl className="space-y-2 text-sm">
              {CONTROLS.map(([key, action]) => (
                <div key={key} className="flex items-baseline gap-3">
                  <dt className="w-28 shrink-0 font-mono text-xs text-cyan-300/90">
                    {key}
                  </dt>
                  <dd className="text-neutral-300">{action}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-500">
              Modes
            </h2>
            <dl className="space-y-3 text-sm">
              {MODES.map(([name, desc]) => (
                <div key={name}>
                  <dt className="font-medium text-neutral-200">{name}</dt>
                  <dd className="text-neutral-400">{desc}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <footer className="text-xs text-neutral-600">
          Desktop + mouse &amp; keyboard. Best in Chrome / Edge with pointer lock.
        </footer>
      </main>
    </div>
  );
}
