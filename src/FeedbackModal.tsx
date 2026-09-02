import { useState } from 'react';
import { GITHUB_NEW_ISSUE } from './links';
import { DeckButton, ModalShell, SegButton, TextButton } from './deck';

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
          Prefer GitHub? ↗
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
                  disabled={busy || title.trim().length < 3 || body.trim().length < 10}
                  solid
                  accent='cyan'
                  center
                >
                  {busy ? '…' : 'Send'}
                </DeckButton>
              </>
            )
      }
    >
      {({ close }) =>
        sent ? (
          <div className='flex flex-col items-center py-6 text-center'>
            <span className='font-display text-3xl text-emerald-300' aria-hidden='true'>
              ✓
            </span>
            <p className='mt-2 text-sm text-white/80'>Thanks — your feedback was sent.</p>
            <DeckButton onClick={close} solid accent='cyan' center className='mt-5' data-autofocus>
              Close
            </DeckButton>
          </div>
        ) : (
          <>
            <div className='flex flex-col gap-4'>
              <div className='grid grid-cols-3 gap-1.5'>
                {TYPES.map((t) => (
                  <SegButton key={t.id} active={type === t.id} onClick={() => setType(t.id)}>
                    {t.label}
                  </SegButton>
                ))}
              </div>
              <label className='flex flex-col gap-1.5'>
                <span className='deck-label'>Title</span>
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  maxLength={120}
                  placeholder={type === 'bug' ? 'e.g. Rail missed at point blank' : 'One-line summary'}
                  className='deck-input'
                />
              </label>
              <label className='flex flex-col gap-1.5'>
                <span className='deck-label'>Details</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={4000}
                  rows={5}
                  placeholder={
                    type === 'bug'
                      ? 'What happened, what you expected, steps to reproduce, your browser…'
                      : 'Tell us more…'
                  }
                  className='deck-input resize-y text-[13px] leading-relaxed'
                />
              </label>
              <p className='text-[11px] text-white/35'>
                Goes straight to the dev. {playerName ? `Sent as ${playerName}.` : 'Log in first to attach your name.'}
              </p>
              {err && (
                <div role='alert' className='text-[12px] text-rose-300'>
                  {err}
                </div>
              )}
            </div>
          </>
        )
      }
    </ModalShell>
  );
}
