// Command-deck UI primitives shared by the lobby, the in-match menus, the
// landing page's feedback form, and the login sheet. One visual language:
// near-black opaque panels, angular clipped corners, heavy uppercase display
// type, mono micro-labels, cyan for selection, emerald = go, rose = danger,
// amber = practice/warn, fuchsia = ranked.
//
// Everything here is presentational; the plumbing (sounds, toast store, modal
// stack, reduced-motion) lives in src/deck-core.ts.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { playUi, type UiSoundName } from './game/audio';
import {
  MODAL_EXIT_MS,
  prefersReducedMotion,
  sfxProps,
  useModalStack,
  useToasts,
  type ToastItem,
  type ToastTone,
} from './deck-core';

/* ── Modal shell ────────────────────────────────────────────────────────── */

export type ModalTone = 'cyan' | 'emerald' | 'amber' | 'rose' | 'fuchsia' | 'plain';
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';
export type ModalApi = { close: () => void; closing: boolean };

const MODAL_SIZE: Record<ModalSize, string> = {
  sm: 'w-[380px]',
  md: 'w-[440px]',
  lg: 'w-[560px]',
  xl: 'w-[760px]',
};

// Tone drives the ONE accent each dialog carries: the hairline rule along the
// top edge, the border tint, and the title color. Everything else is quiet.
const MODAL_TONE: Record<ModalTone, { border: string; title: string; rule: string; glow: string }> = {
  cyan: { border: 'border-cyan-400/30', title: 'text-cyan-100', rule: 'from-cyan-300/80', glow: 'rgba(34,211,238,0.32)' },
  emerald: { border: 'border-emerald-400/30', title: 'text-emerald-100', rule: 'from-emerald-300/80', glow: 'rgba(52,211,153,0.28)' },
  amber: { border: 'border-amber-400/30', title: 'text-amber-100', rule: 'from-amber-300/80', glow: 'rgba(251,191,36,0.26)' },
  rose: { border: 'border-rose-400/30', title: 'text-rose-100', rule: 'from-rose-300/80', glow: 'rgba(251,113,133,0.28)' },
  fuchsia: { border: 'border-fuchsia-400/30', title: 'text-fuchsia-100', rule: 'from-fuchsia-300/80', glow: 'rgba(232,121,249,0.28)' },
  plain: { border: 'border-white/12', title: 'text-white/90', rule: 'from-white/40', glow: 'rgba(0,0,0,0.6)' },
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true',
  );
}

// The dialog frame every menu surface uses. Handles:
//  - enter/exit motion (exit = fade + slight drop, then a delayed unmount via
//    the parent's onClose; instant under prefers-reduced-motion)
//  - Escape / backdrop / ✕ to close — only when this is the topmost dialog
//  - focus: first body control (or [data-autofocus], or the close button) on
//    open, Tab/Shift+Tab trapped inside, focus restored to the opener on close
//  - role="dialog" + aria-modal + aria-labelledby (or aria-label via `label`)
// `children` may be a function to get the animated `close` for programmatic
// dismissal (a submit that succeeds, a "Back to lobby" button, …).
// `fixed` dialogs portal to <body> so a clip-path / transform on an ancestor
// panel can never clip them (Settings → Feedback).
export function ModalShell({
  title,
  label,
  onClose,
  children,
  size = 'md',
  width,
  tone = 'cyan',
  fixed = false,
  z,
  header,
  actions,
  footer,
  scroll = false,
  padded = true,
  bodyClassName = '',
  className = '',
  backdrop = 'dim',
  dismissOnBackdrop = true,
  closeSound = 'uiBack',
  closeLabel = '✕ Esc',
}: {
  title?: string;
  label?: string; // aria-label when there is no visible title
  onClose?: () => void; // omit for a dialog with no dismissal (results, ranked result)
  children: ReactNode | ((api: ModalApi) => ReactNode);
  size?: ModalSize;
  width?: string; // Tailwind width class override
  tone?: ModalTone;
  fixed?: boolean;
  z?: string; // z-index class; default z-20 inside the lobby / match root
  header?: ReactNode; // sticky strip under the title (tabs, search)
  actions?: ReactNode; // extra controls in the title row, left of ✕
  footer?: ReactNode | ((api: ModalApi) => ReactNode);
  scroll?: boolean; // body scrolls inside a max-height panel
  padded?: boolean;
  bodyClassName?: string;
  className?: string;
  backdrop?: 'dim' | 'heavy';
  dismissOnBackdrop?: boolean;
  closeSound?: UiSoundName | 'none';
  closeLabel?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timerRef = useRef(0);
  const isTop = useModalStack();

  const close = useCallback(() => {
    if (closingRef.current || !onCloseRef.current) return;
    closingRef.current = true;
    if (closeSound !== 'none') playUi(closeSound);
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(() => onCloseRef.current?.(), MODAL_EXIT_MS);
  }, [closeSound]);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // Initial focus + restore-on-close. Layout effect so a React `autoFocus`
  // inside the body (which fires during commit) is respected, not overridden.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.contains(document.activeElement)) {
      const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
      const body = bodyRef.current ? focusables(bodyRef.current)[0] : undefined;
      (explicit ?? body ?? closeBtnRef.current ?? panel).focus({ preventScroll: true });
    }
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  // Escape + the Tab trap. Bubble phase on purpose: the keybind-rebind
  // listener captures Escape (capture + stopPropagation) to cancel a rebind,
  // and must win over closing the whole modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (onCloseRef.current && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, close]);

  const t = MODAL_TONE[tone];
  const api: ModalApi = { close, closing };
  const body = typeof children === 'function' ? children(api) : children;
  const foot = typeof footer === 'function' ? footer(api) : footer;
  const hasTitleRow = !!title || !!onClose || !!actions;

  const node = (
    <div className={`${fixed ? 'fixed' : 'absolute'} inset-0 ${z ?? 'z-20'} flex items-center justify-center p-3 pointer-events-auto`}>
      <div
        aria-hidden='true'
        onMouseDown={dismissOnBackdrop && onClose ? close : undefined}
        className={`absolute inset-0 ${backdrop === 'heavy' ? 'bg-black/85 backdrop-blur-sm' : 'bg-black/80'} ${
          closing ? 'deck-backdrop-exit' : 'deck-backdrop-enter'
        }`}
      />
      <div
        ref={panelRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] ${width ?? MODAL_SIZE[size]} max-w-[94vw] flex-col text-white outline-none ${
          closing ? 'deck-modal-exit' : 'deck-modal-enter'
        }`}
        style={{ boxShadow: `0 0 60px -12px ${t.glow}` }}
      >
        <div className={`clip-deck flex min-h-0 flex-1 flex-col border bg-[#0b0c0f] ${t.border} ${className}`}>
          {/* The one accent: a hairline in the dialog's tone along the top edge. */}
          <div aria-hidden='true' className={`h-px w-full shrink-0 bg-gradient-to-r ${t.rule} via-white/10 to-transparent`} />
          {hasTitleRow && (
            <div className='flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 pb-3 pt-4'>
              {title ? (
                <h2 id={titleId} className={`font-display text-base font-bold uppercase tracking-[0.18em] ${t.title}`}>
                  {title}
                </h2>
              ) : (
                <span />
              )}
              <div className='flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.18em]'>
                {actions}
                {onClose && (
                  <button
                    ref={closeBtnRef}
                    type='button'
                    onClick={close}
                    {...sfxProps('none')}
                    className='text-white/55 transition hover:text-cyan-200'
                  >
                    {closeLabel}
                  </button>
                )}
              </div>
            </div>
          )}
          {header && <div className='shrink-0 border-b border-white/10 px-6 py-3'>{header}</div>}
          <div
            ref={bodyRef}
            className={`${scroll ? 'deck-scroll min-h-0 flex-1 overflow-y-auto' : ''} ${
              padded ? 'px-6 py-5' : ''
            } flex flex-col gap-5 font-mono ${bodyClassName}`}
          >
            {body}
          </div>
          {foot && (
            <div className='flex shrink-0 items-center justify-between gap-3 border-t border-white/10 px-6 py-4'>
              {foot}
            </div>
          )}
        </div>
      </div>
    </div>
  );
  return fixed && typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

/* ── Buttons ────────────────────────────────────────────────────────────── */

export type DeckAccent = 'cyan' | 'emerald' | 'amber' | 'rose' | 'fuchsia' | 'plain';

const OUTLINE: Record<DeckAccent, string> = {
  plain: 'border-white/12 bg-white/[0.04] text-white/85 hover:border-white/30 hover:bg-white/10',
  cyan: 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:border-cyan-300/70 hover:bg-cyan-300/20',
  emerald: 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100 hover:border-emerald-300/70 hover:bg-emerald-300/20',
  amber: 'border-amber-300/40 bg-amber-300/10 text-amber-100 hover:border-amber-300/70 hover:bg-amber-300/20',
  rose: 'border-rose-300/40 bg-rose-300/10 text-rose-100 hover:border-rose-300/70 hover:bg-rose-300/20',
  fuchsia: 'border-fuchsia-300/40 bg-fuchsia-300/10 text-fuchsia-100 hover:border-fuchsia-300/70 hover:bg-fuchsia-300/20',
};
const SOLID: Record<DeckAccent, string> = {
  plain: 'border-white/80 bg-white/90 text-zinc-950 hover:bg-white',
  cyan: 'border-cyan-300 bg-cyan-300 text-zinc-950 hover:bg-cyan-200',
  emerald: 'border-emerald-400 bg-emerald-400 text-zinc-950 hover:bg-emerald-300',
  amber: 'border-amber-300 bg-amber-300 text-zinc-950 hover:bg-amber-200',
  rose: 'border-rose-400 bg-rose-400 text-zinc-950 hover:bg-rose-300',
  fuchsia: 'border-fuchsia-400 bg-fuchsia-400 text-zinc-950 hover:bg-fuchsia-300',
};
const SIZE = {
  xs: 'px-2 py-1 text-[10px]',
  sm: 'px-3.5 py-2 text-[11px]',
  md: 'px-5 py-3 text-sm',
  lg: 'px-6 py-4 text-base tracking-[0.18em]',
} as const;

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'className' | 'type'>;

// Angular command-deck action button. Outline (default) tints the border and
// wash by accent; `solid` is the filled CTA form (emerald = go, cyan = confirm,
// rose = leave). Labels use the squared display face. An optional `sub` rides
// the right edge as a quiet mono qualifier. Plays a hover blip + a click cue
// (`sound`; solid buttons default to the confirm cue).
export function DeckButton({
  onClick,
  disabled,
  accent = 'plain',
  solid = false,
  full,
  sub,
  size = 'md',
  center = false,
  sound,
  type = 'button',
  className = '',
  children,
  ...rest
}: NativeButton & {
  onClick?: () => void;
  disabled?: boolean;
  accent?: DeckAccent;
  solid?: boolean;
  full?: boolean;
  sub?: string;
  size?: keyof typeof SIZE;
  center?: boolean;
  sound?: UiSoundName | 'none';
  type?: 'button' | 'submit';
  className?: string;
  children: ReactNode;
}) {
  const tone = solid ? SOLID[accent] : OUTLINE[accent];
  const dis = solid
    ? 'disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-white/40'
    : 'disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...sfxProps(sound ?? (solid ? 'uiConfirm' : 'uiClick'))}
      className={`clip-deck-sm border font-display uppercase tracking-[0.12em] transition active:translate-y-px ${
        solid ? 'font-bold' : 'font-semibold'
      } ${SIZE[size]} ${tone} ${dis} ${full ? 'w-full' : ''} ${center ? 'text-center' : 'text-left'} ${className}`}
      {...rest}
    >
      <span className={`flex items-baseline gap-3 ${center ? 'justify-center' : 'justify-between'}`}>
        <span>{children}</span>
        {sub && (
          <span className='shrink-0 font-mono text-[10px] font-medium normal-case tracking-[0.08em] text-current opacity-55'>
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}

const UTIL_TONE = {
  plain: 'border-white/10 bg-white/[0.03] text-white/60 hover:border-white/25 hover:text-white/90',
  cyan: 'border-cyan-400/40 bg-cyan-400/[0.06] text-cyan-200 hover:border-cyan-300/70 hover:text-cyan-100',
  amber: 'border-amber-400/40 bg-amber-400/[0.06] text-amber-200 hover:border-amber-300/70 hover:text-amber-100',
  rose: 'border-rose-400/40 bg-rose-400/[0.06] text-rose-200 hover:border-rose-300/70 hover:text-rose-100',
} as const;

// Low-emphasis utility action (Stats / Locker / Settings / Cancel / Copy …):
// quiet mono chrome at the same hit size, so the accented DeckButtons stay
// reserved for the ways to actually play.
export function UtilButton({
  onClick,
  children,
  disabled,
  tone = 'plain',
  sound = 'uiClick',
  type = 'button',
  className = '',
  ...rest
}: NativeButton & {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: keyof typeof UTIL_TONE;
  sound?: UiSoundName | 'none';
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...sfxProps(sound)}
      className={`clip-deck-sm border px-3.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition disabled:cursor-not-allowed disabled:opacity-40 ${UTIL_TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// Bare text action (the "Stay a guest" / "Reset to defaults" kind): a mono
// micro-label that brightens on hover, no chrome.
export function TextButton({
  onClick,
  children,
  disabled,
  sound = 'uiClick',
  className = '',
  ...rest
}: NativeButton & {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  sound?: UiSoundName | 'none';
  className?: string;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      {...sfxProps(sound)}
      className={`font-mono text-[11px] uppercase tracking-[0.16em] text-white/45 transition hover:text-white/85 disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Tabs / segments / switch ───────────────────────────────────────────── */

// Tab in a role="tablist" row (Settings sections, Locker categories, Login
// mode). Styling is the .deck-tab hairline; state via aria-selected.
export function DeckTab({
  active,
  onClick,
  children,
  className = '',
  ...rest
}: NativeButton & { active: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type='button'
      role='tab'
      aria-selected={active}
      onClick={onClick}
      {...sfxProps('uiClick')}
      className={`deck-tab ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// One option of a segmented picker (mode, difficulty, sort, style…). State via
// aria-pressed so the CSS and assistive tech agree.
export function SegButton({
  active,
  onClick,
  children,
  disabled,
  className = '',
  ...rest
}: NativeButton & {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      {...sfxProps('uiClick')}
      className={`deck-seg ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// Accessible switch (role="switch") in the deck's square-knob style.
export function DeckSwitch({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        playUi('uiToggle');
        onChange(!value);
      }}
      onPointerEnter={sfxProps('none').onPointerEnter}
      className='deck-switch disabled:cursor-not-allowed disabled:opacity-40'
    />
  );
}

/* ── Skeleton ───────────────────────────────────────────────────────────── */

// A shimmering placeholder block; size it with className / style to the shape
// of the content it stands in for. Hidden from assistive tech — the caller's
// aria-busy / "Loading" copy carries the state.
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden='true' className={`deck-skeleton ${className}`} style={style} />;
}

/* ── Toasts ─────────────────────────────────────────────────────────────── */

const TOAST_TONE: Record<ToastTone, { text: string; bar: string; border: string }> = {
  plain: { text: 'text-white/85', bar: 'bg-white/40', border: 'border-white/15' },
  ok: { text: 'text-emerald-100', bar: 'bg-emerald-400', border: 'border-emerald-400/45' },
  warn: { text: 'text-amber-100', bar: 'bg-amber-400', border: 'border-amber-400/45' },
  err: { text: 'text-rose-100', bar: 'bg-rose-400', border: 'border-rose-400/45' },
};

function ToastChip({ item }: { item: ToastItem }) {
  const t = TOAST_TONE[item.tone];
  return (
    <div
      className={`pointer-events-auto clip-deck-sm flex items-stretch border bg-[#0b0c0f] font-mono text-[11px] uppercase tracking-[0.14em] ${
        t.border
      } ${t.text} ${item.leaving ? 'deck-toast-exit' : 'deck-toast-enter'}`}
    >
      <span aria-hidden='true' className={`w-[3px] shrink-0 ${t.bar}`} />
      <span className='px-3.5 py-2.5'>{item.text}</span>
    </div>
  );
}

// The menu toast rail — mount once per menu surface (lobby, in-match pause
// menu). Portals to <body> above every modal; the live region always exists
// so screen readers announce toasts as they arrive.
export function ToastStack() {
  const list = useToasts();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      aria-live='polite'
      className='pointer-events-none fixed bottom-5 right-5 z-[300] flex w-[320px] max-w-[calc(100vw-2.5rem)] flex-col items-end gap-2'
    >
      {list.map((item) => (
        <ToastChip key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
