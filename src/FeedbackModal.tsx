import { useState } from 'react';
import { GITHUB_NEW_ISSUE } from './links';
import { DeckButton, ModalShell, SegButton, TextButton } from './deck';
import { Field } from './panels/parts';

// In-game feedback / bug report form. POSTs to /api/feedback (stored server-side,
// surfaced in the /admin "Feedback" tab). Guests may submit; when the player is
// logged in the server records their account name regardless of what's sent.
// Opens from the landing page and from Settings (nested — the ModalShell is
// `fixed`, so it portals out of the Settings panel's clipped frame).

type FeedbackType = 'bug' | 'feature' | 'general';
const TYPES: { id: FeedbackType; label: string }[] = [
  { id: 'bug', label: 'Bug' },
  { id: 'feature', label: 'Idea' },
  { id: 'general', label: 'General' },
];
const TITLE_MIN = 3;
const BODY_MIN = 10;

const ERRORS: Record<string, string> = {
  bad_type: 'Pick a category.',
  bad_title: 'Give it a short title (3–120 characters).',
  bad_body: 'Add a few more details (10–4000 characters).',
  rate_limited: 'You’ve sent a lot recently — try again in a bit.',
  server_error: 'Something went wrong — try again.',
  network: 'Network error — try again.',
};

export function FeedbackModal({ onClose, playerName }: { onClose: () => void; playerName?: string }) {
  const [type, setType] = useState<FeedbackType>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [touched, setTouched] = useState({ title: false, body: false });

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type, title: title.trim(), body: body.trim(), name: playerName }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) setSent(true);
      else setErr(ERRORS[d.error ?? ''] ?? 'Something went wrong.');
    } catch {
      setErr(ERRORS.network);
    }
    setBusy(false);
  };

  return (
    <ModalShell
      title='Send feedback'
      onClose={onClose}
      fixed
      z='z-[70]'
      width='w-[460px]'
      actions={
        <a
          href={GITHUB_NEW_ISSUE}
          target='_blank'
          rel='noreferrer'
          className='text-[10px] tracking-[0.14em] text-white/35 transition hover:text-white/70'
        >
          <span className='max-sm:hidden'>Prefer GitHub? </span>
          <span className='sm:hidden'>GitHub </span>↗
        </a>
      }
      footer={
        sent
          ? undefined
          : ({ close }) => (
              <>
                <TextButton onClick={close} sound='uiBack'>
                  Cancel
                </TextButton>
                <DeckButton
                  onClick={submit}
                  disabled={busy || title.trim().length < TITLE_MIN || body.trim().length < BODY_MIN}
                  solid
                  accent='cyan'
                  center
                >
                  {busy ? 'Sending…' : 'Send feedback'}
                </DeckButton>
              </>
            )
      }
    >
      {({ close }) =>
        sent ? (
          <div className='flex flex-col items-center py-6 text-center'>
            <span className='pn-emblem-ok' aria-hidden='true'>
              ✓
            </span>
            <p className='mt-4 font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-white'>Feedback sent</p>
            <p className='mt-1.5 max-w-xs text-[12px] leading-relaxed text-white/50'>
              Thanks. It goes straight to the dev and helps decide what gets fixed next.
            </p>
            <DeckButton onClick={close} solid accent='cyan' center className='mt-5' data-autofocus>
              Close
            </DeckButton>
          </div>
        ) : (
          <form
            className='flex flex-col gap-4'
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div role='group' aria-label='Category' className='grid grid-cols-3 gap-1.5'>
              {TYPES.map((t) => (
                <SegButton key={t.id} active={type === t.id} onClick={() => setType(t.id)}>
                  {t.label}
                </SegButton>
              ))}
            </div>
            <Field
              label='Title'
              counter={`${title.length}/120`}
              error={touched.title && title.trim().length < TITLE_MIN ? 'Give it a short title (3+ characters).' : null}
            >
              {(p) => (
                <input
                  {...p}
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => title && setTouched((t) => ({ ...t, title: true }))}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  maxLength={120}
                  placeholder={type === 'bug' ? 'e.g. Rail missed at point blank' : 'One-line summary'}
                  className='deck-input'
                />
              )}
            </Field>
            <Field
              label='Details'
              counter={`${body.length}/4000`}
              error={touched.body && body.trim().length < BODY_MIN ? 'Add a few more details (10+ characters).' : null}
              hint={type === 'bug' ? 'What happened, what you expected, and how to reproduce it.' : undefined}
            >
              {(p) => (
                <textarea
                  {...p}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onBlur={() => body && setTouched((t) => ({ ...t, body: true }))}
                  maxLength={4000}
                  rows={5}
                  placeholder={type === 'bug' ? 'Steps, your browser, anything that helps…' : 'Tell us more…'}
                  className='deck-input resize-y text-[13px] leading-relaxed'
                />
              )}
            </Field>
            <p className='text-[11px] text-white/35'>
              {playerName ? `Sent as ${playerName}.` : 'Log in first to attach your name.'}
            </p>
            {err && (
              <div
                role='alert'
                className='clip-deck-sm border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200'
              >
                {err}
              </div>
            )}
          </form>
        )
    }
    </ModalShell>
  );
}
