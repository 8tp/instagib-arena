import { useCallback, useEffect, useState } from 'react';

// Client auth: guest by default, optional account. The session lives in an
// httpOnly cookie set by the server, so the client only holds the username (or
// null = guest). Progression is bound to the account server-side.

export type Account = { username: string } | null;

export type AuthApi = {
  account: Account;
  ready: boolean; // false until the initial /me check resolves
  login: (username: string, password: string) => Promise<string | null>; // returns error code or null
  register: (username: string, password: string, email: string) => Promise<string | null>;
  logout: () => Promise<void>;
};

async function post(path: string, body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
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
      setAccount({ username });
      return null;
    }
    return r.error ?? 'invalid';
  }, []);

  const register = useCallback(async (username: string, password: string, email: string) => {
    const r = await post('/api/auth/register', { username, password, email: email || undefined });
    if (r.ok) {
      setAccount({ username });
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
  invalid: 'Wrong username or password',
  rate_limited: 'Too many attempts — wait a minute',
  network: 'Network error — try again',
};

// Login / Register modal. `mode` is the initial tab.
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
    const code =
      mode === 'login'
        ? await auth.login(username.trim(), password)
        : await auth.register(username.trim(), password, email.trim());
    setBusy(false);
    if (code) setErr(ERRORS[code] ?? 'Something went wrong');
    else onClose();
  };

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label={mode === 'login' ? 'Log in' : 'Create account'}
      className='fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className='deck-bg w-[420px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl'>
        <div className='flex border-b border-white/10'>
          {(['register', 'login'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setErr(null);
              }}
              className={`flex-1 px-5 py-3.5 text-[11px] font-bold uppercase tracking-[0.18em] transition ${
                mode === m ? 'bg-cyan-400/10 text-cyan-300' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {m === 'register' ? 'Create account' : 'Log in'}
            </button>
          ))}
        </div>
        <div className='px-7 py-6'>
          <p className='mb-4 text-[12px] leading-relaxed text-white/50'>
            {mode === 'register'
              ? 'Create an account to save your XP, levels, credits, and cosmetics, and climb the leaderboards. Email is optional (for password recovery).'
              : 'Log in to pick up your progress on any device.'}
          </p>
          <label className='block text-[10px] uppercase tracking-[0.24em] text-white/45'>Username</label>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            maxLength={20}
            placeholder='3–20 letters, numbers, _'
            className='mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60'
          />
          <label className='mt-4 block text-[10px] uppercase tracking-[0.24em] text-white/45'>Password</label>
          <input
            type='password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            maxLength={200}
            placeholder='At least 6 characters'
            className='mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60'
          />
          {mode === 'register' && (
            <>
              <label className='mt-4 block text-[10px] uppercase tracking-[0.24em] text-white/45'>
                Email <span className='text-white/30'>(optional)</span>
              </label>
              <input
                type='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder='for password recovery'
                className='mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60'
              />
            </>
          )}
          {err && <div className='mt-4 text-[12px] text-rose-300'>{err}</div>}
        </div>
        <div className='flex items-center justify-between border-t border-white/10 px-7 py-4'>
          <button onClick={onClose} className='text-[11px] uppercase tracking-[0.16em] text-white/40 hover:text-white/70'>
            Stay a guest
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className='rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-50'
          >
            {busy ? '…' : mode === 'register' ? 'Create account' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  );
}
