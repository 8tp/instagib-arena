import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CONTROLS } from '../controls';
import { useLiveCount } from '../live';
import { FeedbackModal } from '../FeedbackModal';
import { DISCORD_URL, GITHUB_URL } from '../links';

// Coarse pointer (phone/tablet) → this is a keyboard+mouse FPS; warn before the
// player taps into the lobby, downloads the 3D chunk, and hits disabled buttons.
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return coarse;
}

const MODES: Array<[string, string]> = [
  ['Practice', 'Offline range + bots. Warm up aim and movement.'],
  ['Quick match', 'Drop into an open public arena instantly.'],
  ['Custom / private', 'Host a lobby or share an invite code.'],
];

// The brand mark — same crosshair as the favicon, so the launcher, the tab
// icon, and the in-game reticle read as one identity.
function CrosshairMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0 text-cyan-300"
    >
      <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="3" x2="16" y2="11" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="21" x2="16" y2="29" stroke="currentColor" strokeWidth="2" />
      <line x1="3" y1="16" x2="11" y2="16" stroke="currentColor" strokeWidth="2" />
      <line x1="21" y1="16" x2="29" y2="16" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="1.6" fill="currentColor" />
    </svg>
  );
}

// Section heading inside a manual panel: label + a hard rule running to the
// edge — the command-deck idiom, no card chrome.
function PanelHeading({ children }: { children: string }) {
  return (
    <h2 className="mb-4 flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
      {children}
      <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
    </h2>
  );
}

export default function Landing() {
  const coarse = useCoarsePointer();
  const live = useLiveCount();
  const [showFeedback, setShowFeedback] = useState(false);
  const navigate = useNavigate();

  // Launcher convention: Enter deploys straight into the menu. Never hijack the
  // key while a dialog is open (explicit state guard — don't rely on focus
  // location alone) or while focus sits on a link/button/field.
  useEffect(() => {
    if (coarse || showFeedback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || showFeedback) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('a, button, input, textarea, select, [role="dialog"]')) return;
      e.preventDefault();
      navigate('/play');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [coarse, showFeedback, navigate]);

  return (
    <div className="deck-bg relative h-full overflow-hidden text-white">
      {/* CRT veil: fixed so it stays glued to the viewport while the page
          scrolls on small screens (the lobby is non-scrolling, so it can use
          deck-scan directly on its root). */}
      <div className="deck-scan pointer-events-none fixed inset-0 z-10" aria-hidden="true" />

      <div className="relative h-full overflow-y-auto">
        {/* ── Utility bar: identity + outbound links ──────────────────── */}
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
          <div className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
              Instagib Arena
            </span>
          </div>
          <nav
            aria-label="External links"
            className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45"
          >
            {DISCORD_URL && (
              <a href={DISCORD_URL} target="_blank" rel="noreferrer" className="transition hover:text-white/90">
                Discord
              </a>
            )}
            {/* The codebase is open source (AGPL); keep it one click away. */}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition hover:text-white/90">
              Source ↗
            </a>
            <button type="button" onClick={() => setShowFeedback(true)} className="uppercase tracking-[0.18em] transition hover:text-white/90">
              Feedback
            </button>
          </nav>
        </header>

        {/* ── Hero (left) · field manual (right) ──────────────────────── */}
        <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 pb-12 pt-12 sm:px-8 lg:min-h-[calc(100%-3.75rem)] lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-14 lg:pt-0">
          <section className="max-w-xl">
            <p className="deck-rise font-mono text-[11px] uppercase tracking-[0.32em] text-cyan-300/90">
              Server-authoritative · browser FPS
            </p>
            <h1
              className="deck-rise mt-4 font-display text-6xl font-bold uppercase leading-[0.92] tracking-[0.04em] sm:text-7xl"
              style={{ animationDelay: '60ms' }}
            >
              Instagib
              <br />
              <span className="text-cyan-300">Arena</span>
            </h1>
            <p
              className="deck-rise mt-6 font-display text-sm font-semibold uppercase tracking-[0.24em] text-white/80"
              style={{ animationDelay: '120ms' }}
            >
              One railgun. One shot. One kill.
            </p>
            <p className="deck-rise mt-3 max-w-md text-[15px] leading-relaxed text-white/55" style={{ animationDelay: '150ms' }}>
              Quake-style instagib, free in the browser. The railgun always kills —
              so the whole game is <span className="text-white/85">aim and movement</span>.
              Strafe, dash, double-jump, wall-jump.
            </p>

            {coarse ? (
              <div className="deck-rise clip-deck-sm mt-8 max-w-md border border-amber-400/40 bg-amber-400/10 px-5 py-4" style={{ animationDelay: '200ms' }}>
                <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-amber-200">
                  Best played on a computer
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-white/70">
                  Instagib Arena needs a <span className="text-white">mouse and keyboard</span> —
                  open this link on a desktop to play. You can still look around below.
                </p>
                <Link
                  to="/play"
                  className="mt-3 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/90 underline-offset-4 hover:underline"
                >
                  Continue anyway →
                </Link>
              </div>
            ) : (
              <div className="deck-rise mt-9 flex flex-wrap items-center gap-x-5 gap-y-3" style={{ animationDelay: '200ms' }}>
                <Link
                  to="/play"
                  className="clip-deck group inline-flex items-center gap-4 bg-cyan-300 py-4 pl-7 pr-6 font-display text-base font-bold uppercase tracking-[0.2em] text-zinc-950 transition hover:bg-cyan-200 active:translate-y-px"
                >
                  Enter the arena
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
                </Link>
                <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-white/35 sm:block">
                  or press{' '}
                  <kbd className="border border-white/20 bg-white/5 px-1.5 py-0.5 text-white/60">Enter</kbd>
                </span>
              </div>
            )}

            {/* Status strip: live population when there is one, otherwise the
                zero-friction pitch. Hard rule, mono readouts — no badges. */}
            <div
              className="deck-rise mt-9 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4 font-mono text-[11px] uppercase tracking-[0.16em] text-white/40"
              style={{ animationDelay: '260ms' }}
            >
              {live && live.online > 0 ? (
                <span className="inline-flex items-center gap-2 text-white/60">
                  <span className="deck-pulse inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="tabular-nums text-white/90">{live.online}</span> online
                  {live.inMatch > 0 && <span className="text-white/35">· {live.inMatch} in match</span>}
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/25" />
                  Free · no download · no account
                </span>
              )}
              <span className="text-white/30">Mouse + keyboard · pointer lock</span>
            </div>
          </section>

          {/* Field manual: the two things a new player needs before deploying —
              how to move, and what to queue for. */}
          <aside className="deck-rise flex flex-col gap-4 lg:max-w-md lg:justify-self-end" style={{ animationDelay: '240ms' }}>
            <section className="deck-panel clip-deck p-6">
              <PanelHeading>Controls</PanelHeading>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {CONTROLS.map(([key, action]) => (
                  <div key={key} className="flex items-baseline gap-2.5">
                    <dt className="shrink-0 border border-white/15 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-cyan-200">
                      {key}
                    </dt>
                    <dd className="text-[12px] leading-snug text-white/55">{action}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="deck-panel clip-deck p-6">
              <PanelHeading>Modes</PanelHeading>
              <ul className="flex flex-col divide-y divide-white/8">
                {MODES.map(([name, desc], i) => (
                  <li key={name} className="flex items-baseline gap-4 py-3 first:pt-0 last:pb-0">
                    <span className="w-6 shrink-0 font-mono text-[10px] tabular-nums text-white/30">
                      0{i + 1}
                    </span>
                    <div>
                      <div className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-white/90">
                        {name}
                      </div>
                      <div className="mt-0.5 text-[12px] leading-snug text-white/45">{desc}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </main>

        <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-white/10 px-5 py-4 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30 sm:px-8">
          <span>Desktop · best in Chrome / Edge</span>
          <span>Open source · AGPL</span>
        </footer>
      </div>

      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  );
}
