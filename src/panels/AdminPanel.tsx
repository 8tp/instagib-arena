import { useCallback, useEffect, useState } from 'react';
import { sfxProps, toast } from '../deck-core';
import { DeckButton, ModalShell, UtilButton } from '../deck';
import { NameBadges } from '../ui/badges';

/* ───────────────────────── Admin / moderation modal ───────────────────────── */

type AdminLookup = { username: string; admin: boolean; verified: boolean };
type AuditEntry = {
  id: number;
  ts: number;
  event: string;
  actor_name: string;
  detail: string;
};

async function adminPost(path: string, body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/admin/${path}`, {
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

function formatAuditTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// Admins-only panel: look a player up by name, toggle their verified check or
// admin role, and scan the recent audit feed. Server enforces admin on every
// call (403 otherwise) — this UI only ever shows for is_admin accounts.
export function AdminModal({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<AdminLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditState, setAuditState] = useState<'loading' | 'ready'>('loading');

  const refreshAudit = useCallback(() => {
    fetch('/api/admin/audit?limit=25', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('audit'))))
      .then((d: { events?: AuditEntry[] }) => setAudit(Array.isArray(d.events) ? d.events : []))
      .catch(() => setAudit([]))
      .finally(() => setAuditState('ready'));
  }, []);
  useEffect(() => {
    refreshAudit();
  }, [refreshAudit]);

  const lookup = useCallback(async (name: string) => {
    const q = name.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/lookup?username=${encodeURIComponent(q)}`, {
        credentials: 'same-origin',
      });
      if (r.ok) {
        setTarget((await r.json()) as AdminLookup);
      } else {
        setTarget(null);
        toast(r.status === 404 ? `No player named “${q}”.` : 'Lookup failed.', { tone: 'err' });
      }
    } catch {
      toast('Network error.', { tone: 'err' });
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback(
    async (path: 'verify' | 'grant', body: object, label: string) => {
      if (!target) return;
      setBusy(true);
      const r = await adminPost(path, { username: target.username, ...body });
      setBusy(false);
      if (r.ok) {
        toast(label, { tone: 'ok' });
        await lookup(target.username);
        refreshAudit();
      } else {
        toast(r.error === 'forbidden' ? 'Not authorized.' : `Failed (${r.error}).`, { tone: 'err' });
      }
    },
    [target, lookup, refreshAudit],
  );

  return (
    <ModalShell title='Admin' tone='amber' size='lg' onClose={onClose} bodyClassName='gap-3'>
      <a
        href='/admin'
        {...sfxProps('uiClick')}
        className='clip-deck-sm flex items-center justify-between border border-cyan-400/35 bg-cyan-400/[0.08] px-3.5 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-400/15'
      >
        <span>Metrics dashboard</span>
        <span className='font-mono text-[10px] font-medium tracking-[0.16em] text-cyan-200/60'>Open ↗</span>
      </a>

      <form
        className='flex gap-2'
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(username);
        }}
      >
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder='Player username'
          aria-label='Player username'
          maxLength={20}
          autoComplete='off'
          spellCheck={false}
          className='deck-input min-w-0 flex-1'
        />
        <UtilButton type='submit' disabled={busy || !username.trim()} tone='cyan' className='shrink-0'>
          Look up
        </UtilButton>
      </form>

      {target && (
        <div className='pn-card clip-deck-sm flex flex-wrap items-center justify-between gap-3 px-3.5 py-3'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2 font-display text-[15px] font-bold text-white'>
              <span className='truncate'>{target.username}</span>
              <NameBadges admin={target.admin} verified={target.verified} size={13} />
            </div>
            <div className='mt-1.5 flex gap-1.5'>
              <span className={`deck-chip ${target.admin ? 'border-amber-400/50 text-amber-300' : 'text-white/45'}`}>
                {target.admin ? 'Admin' : 'Player'}
              </span>
              <span className={`deck-chip ${target.verified ? 'border-sky-400/50 text-sky-300' : 'text-white/45'}`}>
                {target.verified ? 'Verified' : 'Not verified'}
              </span>
            </div>
          </div>
          <div className='grid w-full grid-cols-2 gap-2 sm:w-auto'>
            <DeckButton
              onClick={() => act('verify', { verified: !target.verified }, target.verified ? 'Unverified.' : 'Verified ✓')}
              disabled={busy}
              accent='cyan'
              size='sm'
              center
            >
              {target.verified ? 'Remove verify' : 'Verify'}
            </DeckButton>
            <DeckButton
              onClick={() => act('grant', { admin: !target.admin }, target.admin ? 'Admin revoked.' : 'Admin granted.')}
              disabled={busy}
              accent={target.admin ? 'rose' : 'amber'}
              size='sm'
              center
            >
              {target.admin ? 'Revoke admin' : 'Make admin'}
            </DeckButton>
          </div>
        </div>
      )}

      <section aria-label='Recent activity'>
        <div className='mb-1.5 flex items-center justify-between'>
          <span className='deck-label'>Recent activity</span>
          <button
            type='button'
            onClick={refreshAudit}
            {...sfxProps('uiClick')}
            className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/40 transition hover:text-white/80'
          >
            Refresh
          </button>
        </div>
        <div className='deck-scroll max-h-[34vh] overflow-y-auto border border-white/[0.07] bg-black/25 text-[11px]'>
          {auditState === 'ready' && audit.length === 0 && <div className='px-3 py-4 text-white/40'>No events yet.</div>}
          {audit.map((e) => (
            <div key={e.id} className='deck-tr grid grid-cols-[6.5rem_7rem_minmax(0,1fr)] items-baseline gap-2 px-2.5 py-1.5'>
              <span className='font-mono tabular-nums text-white/35'>{formatAuditTime(e.ts)}</span>
              <span className='truncate font-semibold text-cyan-200/85'>{e.event}</span>
              <span className='truncate text-white/60'>
                {e.actor_name}
                {e.detail ? ` · ${e.detail}` : ''}
              </span>
            </div>
          ))}
        </div>
      </section>
    </ModalShell>
  );
}
