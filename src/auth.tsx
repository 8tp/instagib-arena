import { useCallback, useEffect, useState } from 'react';
import { DeckButton, DeckTab, ModalShell, TextButton } from './deck';

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

const ERRORS: Record<string, string> = {
  bad_username: 'Username must be 3–20 letters, numbers, or _',
  bad_password: 'Password must be at least 6 characters',
  taken: 'That username is taken',
  reserved: 'That username is reserved — pick another',
  profane: 'That username isn’t allowed — pick another',
  invalid: 'Wrong username or password',
  rate_limited: 'Too many attempts — wait a minute',
  network: 'Network error — try again',
};

// Login / Register sheet. `mode` is the initial tab. Deck ModalShell (fixed:
// it opens over the lobby root and over onboarding) with the two modes as a
// tab row under the title; Escape / backdrop / "Stay a guest" all dismiss.
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (close: () => void) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const code =
      mode === 'login'
        ? await auth.login(username.trim(), password)
        : await auth.register(username.trim(), password, email.trim());
    setBusy(false);
    if (code) setErr(ERRORS[code] ?? 'Something went wrong');
    else close();
  };

  return (
    <ModalShell
      title='Account'
      onClose={onClose}
      fixed
      z='z-[70]'
      header={
        <div role='tablist' aria-label='Account mode' className='-mx-2 -mt-1 -mb-3 flex'>
          {(['register', 'login'] as const).map((m) => (
            <DeckTab
              key={m}
              active={mode === m}
              onClick={() => {
                setMode(m);
                setErr(null);
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
          <DeckButton onClick={() => submit(close)} disabled={busy} solid accent='cyan' center>
            {busy ? '…' : mode === 'register' ? 'Create account' : 'Log in'}
          </DeckButton>
        </>
      )}
    >
      {({ close }) => (
        <>
          <div className='flex flex-col gap-4'>
            <p className='text-[12px] leading-relaxed text-white/50'>
              {mode === 'register'
                ? 'Create an account to save your XP, levels, credits, and cosmetics, and climb the leaderboards. Email is optional (for password recovery).'
                : 'Log in to pick up your progress on any device.'}
            </p>
            <label className='flex flex-col gap-1.5'>
              <span className='deck-label'>Username</span>
              <input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit(close)}
                maxLength={20}
                autoComplete='username'
                placeholder='3–20 letters, numbers, _'
                className='deck-input'
              />
            </label>
            <label className='flex flex-col gap-1.5'>
              <span className='deck-label'>Password</span>
              <input
                type='password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit(close)}
                maxLength={200}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder='At least 6 characters'
                className='deck-input'
              />
            </label>
            {mode === 'register' && (
              <label className='flex flex-col gap-1.5'>
                <span className='deck-label'>
                  Email <span className='text-white/30'>(optional)</span>
                </span>
                <input
                  type='email'
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit(close)}
                  autoComplete='email'
                  placeholder='for password recovery'
                  className='deck-input'
                />
              </label>
            )}
            {err && (
              <div role='alert' className='text-[12px] text-rose-300'>
                {err}
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
}
