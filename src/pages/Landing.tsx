import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MenuBackdropView } from '../menu/MenuBackdropView';
import { readMenuPrefs } from '../menu/prefs';
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
    <h2 className="mb-4 flex items-center gap-3 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-cyan-200/90">
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
  const [arena, setArena] = useState('');
  const onArena = useCallback((_id: string, name: string) => setArena(name), []);
  // Decide once on mount: no 3D on touch-only devices or Save-Data; a still
  // frame under the player's low-spec / reduced-effects settings.
  const [backdrop, setBackdrop] = useState<{ still: boolean; lowSpec: boolean } | null>(null);
  useEffect(() => {
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (touch || saveData) return;
    const prefs = readMenuPrefs();
    setBackdrop({ still: prefs.lowSpec || prefs.reducedEffects, lowSpec: prefs.lowSpec });
  }, []);

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
      {/* The hero is the game itself: a live arena flyover behind everything.
          Lazy (Three.js loads after first paint), skipped on phones and
          Save-Data (they can't play here anyway), one still frame under
          low-spec / reduced-effects. */}
      {backdrop && (
        <MenuBackdropView
          delayMs={250}
          still={backdrop.still}
          lowSpec={backdrop.lowSpec}
          onMap={onArena}
        />
      )}
      <div className="menu-scrim pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative h-full overflow-y-auto">
        {/* ── Utility bar: identity + outbound links ──────────────────── */}
        <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 pt-5 sm:px-10">
          <div className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-display text-[13px] font-semibold uppercase tracking-[0.1em] text-white/75">
              Instagib Arena
            </span>
          </div>
          <nav
            aria-label="External links"
            className="flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55 sm:gap-2"
          >
            {DISCORD_URL && (
              <a href={DISCORD_URL} target="_blank" rel="noreferrer" className="px-2 py-1.5 transition hover:text-white/90">
                Discord
              </a>
            )}
            {/* The codebase is open source (AGPL); keep it one click away. */}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="px-2 py-1.5 transition hover:text-white/90">
              Source ↗
            </a>
            <button
              type="button"
              onClick={() => setShowFeedback(true)}
              className="deck-press clip-deck-sm border border-white/15 bg-white/[0.04] px-3 py-1.5 text-white/75 transition hover:border-cyan-300/60 hover:text-cyan-100"
            >
              Feedback
            </button>
          </nav>
        </header>

        {/* ── Hero (left) · field manual (right) ──────────────────────── */}
        <main className="mx-auto grid w-full max-w-7xl gap-10 px-5 pb-12 pt-10 sm:px-10 lg:min-h-[calc(100%-7rem)] lg:grid-cols-[1fr_22rem] lg:items-end lg:gap-14 lg:pt-0">
          <section className="menu-enter max-w-xl lg:self-center">
            <h1 className="menu-wordmark landing-wordmark">
              <span className="menu-wordmark-main">Instagib</span>
              <span className="menu-wordmark-sub">
                <span aria-hidden="true" className="menu-beam" />
                <span>Arena</span>
              </span>
            </h1>
            {/* Sentences never split: if the line must wrap, it wraps between them. */}
            <p className="mt-7 font-display text-[14px] font-semibold uppercase tracking-[0.12em] text-white/90 sm:text-base sm:tracking-[0.22em]">
              <span className="whitespace-nowrap">One railgun.</span> <span className="whitespace-nowrap">One shot.</span>{' '}
              <span className="whitespace-nowrap">One kill.</span>
            </p>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-white/65">
              Quake-style instagib, free in the browser and server-authoritative. The railgun
              always kills — so the whole game is <span className="text-white/90">aim and movement</span>.
              Strafe, dash, double-jump, wall-jump.
            </p>

            {coarse ? (
              <div className="clip-deck-sm mt-8 max-w-md border border-amber-400/40 bg-amber-400/10 px-5 py-4">
                <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-amber-200">
                  Best played on a computer
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-white/70">
                  Instagib Arena needs a <span className="text-white">mouse and keyboard</span> —
                  open this link on a desktop to play. You can still look around below.
                </p>
                <Link
                  to="/play"
                  className="mt-3 inline-flex items-center gap-2 text-[13px] font-semibold text-amber-200/90 underline-offset-4 hover:underline"
                >
                  Continue anyway
                </Link>
              </div>
            ) : (
              <div className="mt-9 flex max-w-[30rem] flex-col gap-3">
                <Link to="/play" className="menu-play landing-cta clip-deck">
                  <span className="menu-play-label landing-cta-label">Enter the arena</span>
                </Link>
                <span className="hidden text-[12px] text-white/45 sm:block">
                  or press{' '}
                  <kbd className="border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/70">Enter</kbd>
                </span>
              </div>
            )}

            {/* Status strip: live population when there is one, otherwise the
                zero-friction pitch. Hard rule, mono readouts — no badges. */}
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4 text-[13px] text-white/55">
              {live && live.online > 0 ? (
                <span className="inline-flex items-center gap-2 text-white/65">
                  <span className="deck-pulse inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="tabular-nums text-white/90">{live.online}</span> online
                  {live.inMatch > 0 && <span className="text-white/40">· {live.inMatch} in match</span>}
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/25" />
                  Free · no download · no account
                </span>
              )}
            </div>
          </section>

          {/* Field manual: the two things a new player needs before deploying —
              how to move, and what to queue for. */}
          <aside className="menu-enter-late flex flex-col gap-3 lg:justify-self-end">
            {/* Narrow screens: the controls card would fill the fold, and
                there's no keyboard here anyway — one line instead. (The full
                list stays in the DOM for crawlers.) */}
            {!coarse && (
              <p className="landing-panel clip-deck-sm px-4 py-3 text-[13px] text-white/70 sm:hidden">
                Play on desktop with <span className="text-white">mouse + keyboard</span>.
              </p>
            )}
            <section className={`landing-panel clip-deck p-5 max-sm:hidden ${coarse ? 'hidden' : ''}`}>
              <PanelHeading>Controls</PanelHeading>
              <dl className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-1">
                {CONTROLS.map(([key, action]) => (
                  <div key={key} className="flex items-baseline gap-2.5">
                    <dt className="shrink-0 border border-white/15 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-cyan-200">
                      {key}
                    </dt>
                    <dd className="text-[12px] leading-snug text-white/60">{action}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="landing-panel clip-deck p-5">
              <PanelHeading>Modes</PanelHeading>
              <ul className="flex flex-col divide-y divide-white/8">
                {MODES.map(([name, desc]) => (
                  <li key={name} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-white/90">
                      {name}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-snug text-white/50">{desc}</div>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </main>

        <footer className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 text-[12px] text-white/40 sm:px-10">
          <span>Desktop · best in Chrome / Edge</span>
          {arena && (
            <span className="hidden sm:inline">
              Live arena <span className="text-white/65">{arena}</span>
            </span>
          )}
          <span>Open source · AGPL</span>
        </footer>
      </div>

      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  );
}
