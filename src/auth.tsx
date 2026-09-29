import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { DeckButton, DeckTab, ModalShell, TextButton } from './deck';
import { Field } from './panels/parts';

// Client auth: guest by default, optional account. The session lives in an
// httpOnly cookie set by the server, so the client only holds the username (or
// null = guest). Progression is bound to the account server-side.

export type Account = { username: string; isAdmin: boolean; isVerified: boolean } | null;

export type AuthApi = {
  account: Account;
  ready: boolean; // false until the initial /me check resolves
  login: (username: string, password: string) => Promise<string | null>; // returns error code or null
  register: (username: string, password: string, email: string) => Promise<string | null>;
  logout: () => Promise<void>;
};

type AuthResponse = { user?: { username: string; isAdmin?: boolean; isVerified?: boolean } };

async function post(
  path: string,
  body: object,
): Promise<{ ok: boolean; error?: string; data?: AuthResponse }> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, data: d as AuthResponse };
    return { ok: false, error: (d as { error?: string }).error ?? `http_${r.status}` };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export function useAuth(): AuthApi {
  const [account, setAccount] = useState<Account>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user: Account }) => {
        if (active) setAccount(d.user ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await post('/api/auth/login', { username, password });
    if (r.ok) {
      const u = r.data?.user;
      setAccount({ username: u?.username ?? username, isAdmin: !!u?.isAdmin, isVerified: !!u?.isVerified });
      return null;
    }
    return r.error ?? 'invalid';
  }, []);

  const register = useCallback(async (username: string, password: string, email: string) => {
    const r = await post('/api/auth/register', { username, password, email: email || undefined });
    if (r.ok) {
      const u = r.data?.user;
      setAccount({ username: u?.username ?? username, isAdmin: !!u?.isAdmin, isVerified: !!u?.isVerified });
      return null;
    }
    return r.error ?? 'failed';
  }, []);

  const logout = useCallback(async () => {
    await post('/api/auth/logout', {});
    setAccount(null);
  }, []);

  return { account, ready, login, register, logout };
}

// Server error code → which field it belongs to + the message. Anything not
// field-specific (wrong password, rate limit, network) shows as a form alert.
const ERRORS: Record<string, { field?: 'username' | 'password'; text: string }> = {
  bad_username: { field: 'username', text: 'Use 3–20 letters, numbers, or underscores.' },
  bad_password: { field: 'password', text: 'Use at least 6 characters.' },
  taken: { field: 'username', text: 'That username is taken.' },
  reserved: { field: 'username', text: 'That username is reserved. Pick another.' },
  profane: { field: 'username', text: 'That username isn’t allowed. Pick another.' },
  invalid: { text: 'Wrong username or password.' },
  rate_limited: { text: 'Too many attempts. Wait a minute and try again.' },
  network: { text: 'Network error. Check your connection and try again.' },
};

// Mirrors server/auth.ts (the server stays authoritative).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
type FieldErrors = { username?: string; password?: string; email?: string };

function validate(mode: 'login' | 'register', username: string, password: string, email: string): FieldErrors {
  const e: FieldErrors = {};
  const u = username.trim();
  if (!u) e.username = 'Enter a username.';
  else if (mode === 'register' && !USERNAME_RE.test(u)) e.username = 'Use 3–20 letters, numbers, or underscores.';
  if (!password) e.password = 'Enter a password.';
  else if (mode === 'register' && password.length < 6) e.password = 'Use at least 6 characters.';
  if (mode === 'register' && email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) e.email = 'That doesn’t look like an email address.';
  return e;
}

// Login / Register sheet. `mode` is the initial tab. Deck ModalShell (fixed:
// it opens over the lobby root and over onboarding) with the two modes as a
// tab row under the title; Escape / backdrop / "Stay a guest" all dismiss.
// Fields validate on blur and on submit; server errors land on the field they
// belong to (or as a form-level alert for wrong password / rate limit).
export function LoginModal({
  auth,
  onClose,
  initialMode = 'register',
}: {
  auth: AuthApi;
  onClose: () => void;
  initialMode?: 'login' | 'register';
}) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof FieldErrors, boolean>>>({});
  const [serverErr, setServerErr] = useState<{ field?: 'username' | 'password'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  const errors = validate(mode, username, password, email);
  const shown = (k: keyof FieldErrors): string | null =>
    (touched[k] ? errors[k] : undefined) ??
    (serverErr?.field === k ? serverErr.text : undefined) ??
    null;
  const touch = (k: keyof FieldErrors) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  const submit = async (close: () => void) => {
    if (busy) return;
    setTouched({ username: true, password: true, email: true });
    const bad = (['username', 'password', 'email'] as const).find((k) => errors[k]);
    if (bad) {
      formRef.current?.querySelector<HTMLInputElement>(`[name="${bad}"]`)?.focus();
      return;
    }
    setBusy(true);
    setServerErr(null);
    const code =
      mode === 'login'
        ? await auth.login(username.trim(), password)
        : await auth.register(username.trim(), password, email.trim());
    setBusy(false);
    if (code) {
      const e = ERRORS[code] ?? { text: 'Something went wrong. Try again.' };
      setServerErr(e);
      if (e.field) formRef.current?.querySelector<HTMLInputElement>(`[name="${e.field}"]`)?.focus();
    } else close();
  };

  const formLevelErr = serverErr && !serverErr.field ? serverErr.text : null;
  const register = mode === 'register';

  return (
    <ModalShell
      title='Account'
      onClose={onClose}
      fixed
      z='z-[70]'
      size='sm'
      header={
        <div role='tablist' aria-label='Account mode' className='-mx-2 -mt-1 -mb-3 flex'>
          {(['register', 'login'] as const).map((m) => (
            <DeckTab
              key={m}
              active={mode === m}
              onClick={() => {
                setMode(m);
                setServerErr(null);
                setTouched({});
              }}
            >
              {m === 'register' ? 'Create account' : 'Log in'}
            </DeckTab>
          ))}
        </div>
      }
      footer={({ close }) => (
        <>
          <TextButton onClick={close} sound='uiBack'>
            Stay a guest
          </TextButton>
          <DeckButton
            type='submit'
            form={formId}
            onClick={() => void submit(close)}
            disabled={busy}
            solid
            accent='cyan'
            center
          >
            {busy ? 'Working…' : register ? 'Create account' : 'Log in'}
          </DeckButton>
        </>
      )}
    >
      {({ close }) => (
        <form
          id={formId}
          ref={formRef}
          noValidate
          className='flex flex-col gap-4'
          onSubmit={(e) => {
            e.preventDefault();
          }}
          onKeyDown={(e) => {
            // Enter in a field submits (the footer button owns click).
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
              e.preventDefault();
              void submit(close);
            }
          }}
        >
          {register ? (
            <ul className='flex flex-col gap-1.5 border-b border-white/[0.07] pb-4'>
              <li className='pn-perk'>Keep your XP, levels, credits and cosmetics on any device</li>
              <li className='pn-perk'>Appear on the leaderboards and play Ranked Duel</li>
            </ul>
          ) : (
            <p className='border-b border-white/[0.07] pb-4 text-[12px] leading-relaxed text-white/50'>
              Log in to pick up your progress on any device.
            </p>
          )}

          <Field label='Username' error={shown('username')} hint={register ? '3–20 letters, numbers or _' : undefined}>
            {(p) => (
              <input
                {...p}
                name='username'
                autoFocus
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (serverErr?.field === 'username') setServerErr(null);
                }}
                onBlur={() => username && touch('username')}
                maxLength={20}
                autoComplete='username'
                autoCapitalize='off'
                spellCheck={false}
                className='deck-input'
              />
            )}
          </Field>

          <Field label='Password' error={shown('password')} hint={register ? 'At least 6 characters' : undefined}>
            {(p) => (
              <div className='relative'>
                <input
                  {...p}
                  name='password'
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (serverErr?.field === 'password') setServerErr(null);
                  }}
                  onBlur={() => password && touch('password')}
                  maxLength={200}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  className='deck-input pr-16'
                />
                <button
                  type='button'
                  onClick={() => setShowPw((v) => !v)}
                  aria-pressed={showPw}
                  className='absolute inset-y-0 right-0 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45 transition hover:text-white/85'
                >
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            )}
          </Field>

          {register && (
            <Field label='Email' optional error={shown('email')} hint='Only used for password recovery'>
              {(p) => (
                <input
                  {...p}
                  name='email'
                  type='email'
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => email && touch('email')}
                  autoComplete='email'
                  className='deck-input'
                />
              )}
            </Field>
          )}

          {formLevelErr && (
            <div
              role='alert'
              className='clip-deck-sm border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200'
            >
              {formLevelErr}
            </div>
          )}
        </form>
      )}
    </ModalShell>
  );
}
