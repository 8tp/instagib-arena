// Admin → Codes: create redeem codes (custom or generated XXXX-XXXX-XXXX) with a
// reward bundle, max uses, expiry, min level and a note — validated live — and
// manage them: copy, uses, expiry, active toggle, who redeemed. Server:
// server/rewards.ts (docs/economy.md §7b).
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { RedeemCodeWire, RewardBundle } from '../game/items/types';
import { econ, reasonText, type Redemption } from '../economy/api';
import { bundleSummary, specPreview } from '../inbox/reward';
import { RewardView, SpecTile } from '../inbox/RewardBits';
import { TicketGlyph } from '../menu/RewardTile';
import { CheckLine, RewardBundleEditor } from './RewardBundleEditor';
import { bundleDraftEmpty, draftToBundle, emptyBundle, type BundleDraft } from './spec-draft';
import { ago, fmt } from './format';
import { fmtWhen, fromLocalInput } from './time';
import { Avatar, Banner, CopyButton, Empty, ExpiryField, Field, Loading, Plate, Seg, type Msg } from './ui';
import { useBundleCheck } from './useBundleCheck';

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export function AdminCodesTab() {
  const [codes, setCodes] = useState<RedeemCodeWire[] | null>(null);
  const [listErr, setListErr] = useState('');
  const load = useCallback(async () => {
    const r = await econ.adminCodes();
    if (!r.ok) {
      setListErr(reasonText(r, 'admin'));
      setCodes((c) => c ?? []);
      return;
    }
    setListErr('');
    setCodes(r.codes);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className='flex flex-col gap-5'>
      <CreateCode onCreated={(c) => setCodes((cs) => [c, ...(cs ?? []).filter((x) => x.code !== c.code)])} />
      <CodeList codes={codes} error={listErr} onRefresh={() => void load()} onPatch={(c) => setCodes((cs) => (cs ?? []).map((x) => (x.code === c.code ? c : x)))} />
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────
function CreateCode({ onCreated }: { onCreated: (c: RedeemCodeWire) => void }) {
  const [mode, setMode] = useState<'auto' | 'custom'>('auto');
  const [code, setCode] = useState('');
  const [bundle, setBundle] = useState<BundleDraft>(() => ({ ...emptyBundle(), credits: '500' }));
  const [maxUses, setMaxUses] = useState('0');
  const [expires, setExpires] = useState('');
  const [minLevel, setMinLevel] = useState('0');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [made, setMade] = useState<RedeemCodeWire | null>(null);
  const check = useBundleCheck(bundle);

  const custom = mode === 'custom' ? code.trim() : '';
  const codeErr = mode === 'custom' && custom && !CODE_RE.test(custom) ? '3–32 characters: A–Z, 0–9 and dashes, not starting with a dash.' : '';
  const expiresAt = fromLocalInput(expires);
  const expiryErr = expires && expiresAt <= Date.now() ? 'Pick a time in the future.' : '';
  const problem = check.state !== 'ok' ? (check.state === 'err' ? 'Fix the reward first.' : check.state === 'empty' ? 'Add credits, free rolls or an item.' : 'Checking the reward…') : mode === 'custom' && !custom ? 'Type the custom code.' : codeErr || expiryErr || '';
  const ready = !problem && !busy;
  const uses = Math.floor(Number(maxUses) || 0);
  const lvl = Math.floor(Number(minLevel) || 0);

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    const r = await econ.adminCreateCode({
      code: custom || undefined,
      reward: draftToBundle(bundle),
      maxUses: uses,
      expiresAt: expiresAt || undefined,
      minLevel: lvl,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: 'err', text: reasonText(r, 'admin') });
    setMade(r.code);
    onCreated(r.code);
    if (mode === 'custom') setCode('');
  };

  return (
    <Plate title='Create a code' sub='Players redeem it from the inbox. Everything here is checked by the server before you can create it.'>
      <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'>
        <div className='flex min-w-0 flex-col gap-5'>
          <div className='flex flex-wrap items-end gap-3'>
            <Field label='Code' as='div'>
              <Seg
                label='Code source'
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'auto', label: 'Generate' },
                  { id: 'custom', label: 'Custom' },
                ]}
              />
            </Field>
            {mode === 'custom' ? (
              <input
                className='adm-input mono min-w-[14rem] flex-1 text-[15px] font-bold uppercase tracking-[0.14em]'
                style={{ height: 34 }}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                maxLength={32}
                placeholder='SUMMER-2026'
                autoComplete='off'
                spellCheck={false}
                aria-label='Custom code'
                aria-invalid={!!codeErr}
                data-field='code-custom'
              />
            ) : (
              <span className='pb-2 font-mono text-[13px] tracking-[0.14em] text-[var(--adm-ink-3)]'>XXXX-XXXX-XXXX · generated on create</span>
            )}
          </div>
          {codeErr && <div className='-mt-3 text-[12px] text-[var(--adm-bad)]'>{codeErr}</div>}

          <div className='flex flex-col gap-2'>
            <span className='adm-section-label'>Reward</span>
            <RewardBundleEditor value={bundle} onChange={setBundle} />
            <CheckLine check={check} emptyText='Add credits, free rolls or an item.' />
          </div>

          <div className='flex flex-col gap-3 border-t border-[var(--adm-line)] pt-4'>
            <span className='adm-section-label'>Limits</span>
            <div className='grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]'>
              <Field label='Max uses' hint={uses ? `${fmt(uses)} total` : 'unlimited'} as='div'>
                <input className='adm-input mono' aria-label='Max uses' inputMode='numeric' value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} data-field='code-max' />
                <span className='flex flex-wrap gap-1'>
                  {[1, 100, 1000].map((n) => (
                    <button key={n} type='button' className='adm-chip' aria-pressed={uses === n} onClick={() => setMaxUses(String(n))}>
                      {fmt(n)}
                    </button>
                  ))}
                  <button type='button' className='adm-chip' aria-pressed={uses === 0} onClick={() => setMaxUses('0')}>
                    ∞
                  </button>
                </span>
              </Field>
              <Field label='Min level' hint={lvl ? `Lv ${lvl}+` : 'anyone'} as='div'>
                <input className='adm-input mono' aria-label='Min level' inputMode='numeric' value={minLevel} onChange={(e) => setMinLevel(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} data-field='code-level' />
                <span className='flex flex-wrap gap-1'>
                  {[0, 5, 10, 25].map((n) => (
                    <button key={n} type='button' className='adm-chip' aria-pressed={lvl === n} onClick={() => setMinLevel(String(n))}>
                      {n ? `Lv ${n}` : 'Any'}
                    </button>
                  ))}
                </span>
              </Field>
              <ExpiryField value={expires} onChange={setExpires} />
            </div>
            {expiryErr && <div className='text-[12px] text-[var(--adm-bad)]'>{expiryErr}</div>}
            <Field label='Note' hint='shown to players on their receipt · ≤ 200'>
              <input className='adm-input' maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder='Thanks for playing Instagib Arena.' data-field='code-note' />
            </Field>
          </div>

          <div className='flex flex-wrap items-center gap-3'>
            <button type='button' className='adm-btn primary' disabled={!ready} onClick={() => void create()} data-action='code-create'>
              {busy ? 'Creating…' : 'Create code'}
            </button>
            {problem && <span className='text-[12px] text-[var(--adm-ink-3)]'>{problem}</span>}
          </div>
          <Banner msg={msg} onClose={() => setMsg(null)} />

          {made && (
            <div className='flex flex-wrap items-center gap-x-4 gap-y-2 border border-[rgba(63,214,154,0.4)] bg-[rgba(63,214,154,0.06)] px-4 py-3' role='status' data-code-created>
              <span className='text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--adm-good)]'>Created</span>
              <span className='font-mono text-[22px] font-bold tracking-[0.12em] text-white'>{made.code}</span>
              <CopyButton text={made.code} />
              <span className='text-[12px] text-[var(--adm-ink-2)]'>
                {made.maxUses ? `${fmt(made.maxUses)} uses` : 'Unlimited uses'} · {made.expiresAt ? `expires ${fmtWhen(made.expiresAt)}` : 'never expires'}
                {made.minLevel ? ` · Lv ${made.minLevel}+` : ''}
              </span>
            </div>
          )}
        </div>

        <aside className='flex flex-col gap-2 lg:sticky lg:top-[120px] lg:self-start'>
          <span className='adm-section-label'>Player gets</span>
          <div className='border border-[var(--adm-line)] bg-[radial-gradient(100%_70%_at_50%_0%,rgba(91,227,255,0.08),transparent_70%)] p-4'>
            {bundleDraftEmpty(bundle) ? <Empty title='Nothing yet'>Add credits, rolls or items.</Empty> : <RewardView bundle={draftToBundle(bundle)} tile={84} />}
          </div>
          <div className='text-[12px] leading-relaxed text-[var(--adm-ink-3)]'>
            {uses ? `First ${fmt(uses)} players` : 'Every player'}
            {lvl ? ` at level ${lvl}+` : ''}
            {expiresAt ? `, until ${fmtWhen(expiresAt)}` : ', with no end date'}. One redemption per account.
          </div>
        </aside>
      </div>
    </Plate>
  );
}

// ── List ────────────────────────────────────────────────────────────────────
function RewardMini({ reward }: { reward: RewardBundle }) {
  const items = reward.items ?? [];
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {!!reward.credits && <span className='bg-[rgba(243,193,82,0.1)] px-1.5 py-0.5 font-mono text-[12px] font-semibold text-[var(--adm-credit)]'>⛁ {reward.credits.toLocaleString()}</span>}
      {!!reward.rolls && (
        <span className='inline-flex items-center gap-1 bg-[var(--adm-rail-dim)] px-1.5 py-0.5 font-mono text-[12px] font-semibold text-[var(--adm-rail)]'>
          <TicketGlyph size={12} /> {reward.rolls}
        </span>
      )}
      {items.slice(0, 4).map((s, i) => (
        <span key={i} title={bundleSummary({ items: [s] })}>
          <SpecTile inst={specPreview(s, i)} size={32} />
        </span>
      ))}
      {items.length > 4 && <span className='text-[12px] text-[var(--adm-ink-3)]'>+{items.length - 4}</span>}
    </div>
  );
}

function UsesBar({ uses, max }: { uses: number; max: number }) {
  const frac = max > 0 ? Math.min(1, uses / max) : 0;
  return (
    <div className='min-w-[84px]'>
      <div className='font-mono tabular-nums text-[var(--adm-ink)]'>
        {uses.toLocaleString()} <span className='text-[var(--adm-ink-3)]'>/ {max > 0 ? max.toLocaleString() : '∞'}</span>
      </div>
      {max > 0 && (
        <div className='mt-1 h-1 w-full bg-[var(--adm-line-2)]'>
          <div className='h-full' style={{ width: `${frac * 100}%`, background: frac >= 1 ? 'var(--adm-warn)' : 'var(--adm-rail)' }} />
        </div>
      )}
    </div>
  );
}

function ActiveToggle({ code, onPatch }: { code: RedeemCodeWire; onPatch: (c: RedeemCodeWire) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const flip = async () => {
    setBusy(true);
    setErr('');
    const r = await econ.adminCodeActive(code.code, !code.active);
    setBusy(false);
    if (!r.ok) return setErr(reasonText(r, 'admin'));
    onPatch(r.code);
  };
  return (
    <span className='flex items-center gap-2'>
      <button type='button' role='switch' aria-checked={code.active} aria-label={`${code.code} active`} disabled={busy} onClick={() => void flip()} data-action='code-active' className='disabled:opacity-50'>
        <span className='adm-switch block' data-on={code.active ? '' : undefined} aria-hidden />
      </button>
      {err && <span className='text-[11px] text-[var(--adm-bad)]'>{err}</span>}
    </span>
  );
}

type Status = 'live' | 'off' | 'expired' | 'used';
function statusOf(c: RedeemCodeWire): Status {
  if (!c.active) return 'off';
  if (c.expiresAt && c.expiresAt <= Date.now()) return 'expired';
  if (c.maxUses > 0 && c.uses >= c.maxUses) return 'used';
  return 'live';
}
const STATUS: Record<Status, { label: string; color: string }> = {
  live: { label: 'Live', color: 'var(--adm-good)' },
  off: { label: 'Off', color: 'var(--adm-ink-3)' },
  expired: { label: 'Expired', color: 'var(--adm-bad)' },
  used: { label: 'Used up', color: 'var(--adm-warn)' },
};

function Redemptions({ code, rs }: { code: string; rs: Redemption[] | 'loading' | 'error' | undefined }) {
  if (rs === 'loading' || rs === undefined) return <Loading rows={2} label='Loading redemptions' />;
  if (rs === 'error') return <span className='text-[var(--adm-bad)]'>Couldn’t load redemptions. Close and reopen to retry.</span>;
  if (rs.length === 0) return <span className='text-[var(--adm-ink-3)]'>Nobody has redeemed {code} yet.</span>;
  const first = rs.reduce((a, b) => (b.at < a.at ? b : a));
  const last = rs.reduce((a, b) => (b.at > a.at ? b : a));
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-[var(--adm-ink-2)]'>
        <span>
          <b className='font-mono text-[var(--adm-ink)]'>{fmt(rs.length)}</b> redemption{rs.length === 1 ? '' : 's'}
          {rs.length >= 500 ? ' (latest 500)' : ''}
        </span>
        <span>First {new Date(first.at).toLocaleString()}</span>
        <span>Latest {ago(last.at)}</span>
      </div>
      <ul className='grid max-h-[260px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6 gap-y-1.5 overflow-y-auto'>
        {rs.map((x, i) => (
          <li key={`${x.player}-${i}`} className='flex items-center gap-2'>
            <Avatar name={x.player} />
            <span className='min-w-0 flex-1 truncate text-[var(--adm-ink)]'>{x.player}</span>
            <span className='shrink-0 text-[12px] text-[var(--adm-ink-3)]' title={new Date(x.at).toLocaleString()}>
              {ago(x.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeList({ codes, error, onRefresh, onPatch }: { codes: RedeemCodeWire[] | null; error: string; onRefresh: () => void; onPatch: (c: RedeemCodeWire) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [reds, setReds] = useState<Record<string, Redemption[] | 'loading' | 'error'>>({});
  const drill = async (code: string) => {
    if (open === code) return setOpen(null);
    setOpen(code);
    setReds((r) => ({ ...r, [code]: 'loading' }));
    const r = await econ.adminCodeRedemptions(code);
    setReds((m) => ({ ...m, [code]: r.ok ? r.redemptions : 'error' }));
  };
  const t = q.trim().toUpperCase();
  const all = codes ?? [];
  const counts = all.reduce<Record<string, number>>((m, c) => ((m[statusOf(c)] = (m[statusOf(c)] ?? 0) + 1), m), {});
  const shown = all.filter((c) => (status === 'all' || statusOf(c) === status) && (!t || c.code.includes(t) || c.note.toUpperCase().includes(t)));
  return (
    <Plate
      title='Codes'
      sub={codes ? `${fmt(all.length)} total · ${fmt(counts.live ?? 0)} live` : undefined}
      flush
      right={
        <>
          <div className='flex flex-wrap gap-1' role='group' aria-label='Filter by status'>
            {(['all', 'live', 'off', 'expired', 'used'] as const).map((s) => (
              <button key={s} type='button' className='adm-chip' aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s === 'all' ? 'All' : STATUS[s].label}
                <span className='n'>{s === 'all' ? all.length : counts[s] ?? 0}</span>
              </button>
            ))}
          </div>
          <input className='adm-input w-44' style={{ height: 28 }} placeholder='Find code or note…' value={q} onChange={(e) => setQ(e.target.value)} aria-label='Filter codes' />
          <button type='button' className='adm-btn sm' onClick={onRefresh}>
            Refresh
          </button>
        </>
      }
    >
      {error && (
        <div className='px-4 pb-3'>
          <Banner msg={{ tone: 'err', text: error }} />
        </div>
      )}
      {codes === null ? (
        <div className='px-4 pb-4'>
          <Loading />
        </div>
      ) : shown.length === 0 ? (
        <Empty title={all.length ? 'No codes match.' : 'No codes yet.'}>{all.length ? 'Clear the filter to see every code.' : 'Create one above — it shows up here.'}</Empty>
      ) : (
        <div className='adm-scroll max-h-[720px]'>
          <table className='adm-table' data-code-list>
            <thead>
              <tr>
                <th>Code</th>
                <th>Reward</th>
                <th>Uses</th>
                <th>Expires</th>
                <th className='num'>Min Lv</th>
                <th>Active</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const st = STATUS[statusOf(c)];
                const isOpen = open === c.code;
                return (
                  <Fragment key={c.code}>
                    <tr data-code={c.code} style={c.active ? undefined : { opacity: 0.6 }}>
                      <td>
                        <div className='flex items-center gap-2'>
                          <b className='font-mono text-[13px] tracking-[0.06em] text-[var(--adm-ink)]'>{c.code}</b>
                          <CopyButton text={c.code} />
                        </div>
                        <div className='mt-1 flex items-center gap-2 text-[11px]'>
                          <span className='inline-flex items-center gap-1 font-semibold' style={{ color: st.color }}>
                            <span className='inline-block h-1.5 w-1.5' style={{ background: st.color }} />
                            {st.label}
                          </span>
                          {c.note && (
                            <span className='max-w-[220px] truncate text-[var(--adm-ink-3)]' title={c.note}>
                              {c.note}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <RewardMini reward={c.reward} />
                      </td>
                      <td>
                        <UsesBar uses={c.uses} max={c.maxUses} />
                      </td>
                      <td className='whitespace-nowrap' style={{ color: c.expiresAt && c.expiresAt <= Date.now() ? 'var(--adm-bad)' : undefined }}>
                        {c.expiresAt ? fmtWhen(c.expiresAt) : <span className='text-[var(--adm-ink-3)]'>Never</span>}
                      </td>
                      <td className='num'>{c.minLevel || <span className='text-[var(--adm-ink-3)]'>—</span>}</td>
                      <td>
                        <ActiveToggle code={c} onPatch={onPatch} />
                      </td>
                      <td className='whitespace-nowrap'>
                        {c.createdBy}
                        <div className='text-[11px] text-[var(--adm-ink-3)]' title={new Date(c.createdAt).toLocaleString()}>
                          {ago(c.createdAt)}
                        </div>
                      </td>
                      <td className='text-right'>
                        <button type='button' className='adm-btn sm' onClick={() => void drill(c.code)} aria-expanded={isOpen} data-action='code-redemptions'>
                          {isOpen ? 'Hide' : `Redemptions${c.uses ? ` · ${fmt(c.uses)}` : ''}`}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} className='bg-[var(--adm-plate)]' style={{ padding: '12px 16px' }}>
                          <Redemptions code={c.code} rs={reds[c.code]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Plate>
  );
}
