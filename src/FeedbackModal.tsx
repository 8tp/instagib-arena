import { useEffect, useState } from 'react';
import { GITHUB_NEW_ISSUE } from './links';

// In-game feedback / bug report form. POSTs to /api/feedback (stored server-side,
// surfaced in the /admin "Feedback" tab). Guests may submit; when the player is
// logged in the server records their account name regardless of what's sent.
// Mirrors the LoginModal styling in auth.tsx.

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="deck-bg w-[460px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-7 py-4">
          <h2 className="text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-300">Send feedback</h2>
          <a
            href={GITHUB_NEW_ISSUE}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] uppercase tracking-[0.14em] text-white/35 transition hover:text-white/70"
          >
            Prefer GitHub? →
          </a>
        </div>

        {sent ? (
          <div className="px-7 py-10 text-center">
            <p className="text-2xl text-emerald-300">✓</p>
            <p className="mt-2 text-sm text-white/80">Thanks — your feedback was sent.</p>
            <button
              onClick={onClose}
              className="mt-5 rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="px-7 py-6">
              <div className="flex gap-1.5">
                {TYPES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setType(t.id)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition ${
                      type === t.id
                        ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300'
                        : 'border-white/10 text-white/40 hover:text-white/70'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <label className="mt-5 block text-[10px] uppercase tracking-[0.24em] text-white/45">Title</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                maxLength={120}
                placeholder={type === 'bug' ? 'e.g. Rail missed at point blank' : 'One-line summary'}
                className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60"
              />

              <label className="mt-4 block text-[10px] uppercase tracking-[0.24em] text-white/45">Details</label>
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
                className="mt-1.5 w-full resize-y rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-white outline-none focus:border-cyan-400/60"
              />
              <p className="mt-2 text-[11px] text-white/35">
                Goes straight to the dev. {playerName ? `Sent as ${playerName}.` : 'Log in first to attach your name.'}
              </p>
              {err && <div className="mt-3 text-[12px] text-rose-300">{err}</div>}
            </div>
            <div className="flex items-center justify-between border-t border-white/10 px-7 py-4">
              <button
                onClick={onClose}
                className="text-[11px] uppercase tracking-[0.16em] text-white/40 hover:text-white/70"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy || title.trim().length < 3 || body.trim().length < 10}
                className="rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-50"
              >
                {busy ? '…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
