// Admin → Codes: create redeem codes (custom or generated XXXX-XXXX-XXXX) with a
// reward bundle, max uses, expiry, min level and a note — validated live — and
// manage them: copy, uses, expiry, active toggle, who redeemed. Server:
// server/rewards.ts (docs/economy.md §7b).
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { RedeemCodeWire, RewardBundle } from '../game/items/types';
import { econ, reasonText, type Redemption } from '../economy/api';
import { timeAgo } from '../economy/display';
import { bundleSummary, specPreview } from '../inbox/reward';
import { RewardView, SpecTile } from '../inbox/RewardBits';
import { TicketGlyph } from '../menu/RewardTile';
import { CheckLine, RewardBundleEditor } from './RewardBundleEditor';
import { bundleDraftEmpty, draftToBundle, emptyBundle, type BundleDraft } from './spec-draft';
import { fmtWhen, fromLocalInput } from './time';
import { Banner, Card, CopyButton, ExpiryField, Field, Seg, btnCls, inputCls, primaryCls, type Msg } from './ui';
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
    <div>
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
  const codeErr = mode === 'custom' && custom && !CODE_RE.test(custom) ? '3–32 characters: A–Z, 0–9 and dashes (not leading).' : '';
  const expiresAt = fromLocalInput(expires);
  const expiryErr = expires && expiresAt <= Date.now() ? 'Pick a time in the future.' : '';
  const ready = check.state === 'ok' && !codeErr && !expiryErr && !(mode === 'custom' && !custom) && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    const r = await econ.adminCreateCode({
      code: custom || undefined,
      reward: draftToBundle(bundle),
      maxUses: Math.floor(Number(maxUses) || 0),
      expiresAt: expiresAt || undefined,
      minLevel: Math.floor(Number(minLevel) || 0),
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: 'err', text: reasonText(r, 'admin') });
    setMade(r.code);
    onCreated(r.code);
    if (mode === 'custom') setCode('');
  };

  return (
    <Card title='Create a code'>
      <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]'>
        <div className='flex min-w-0 flex-col gap-4'>
          <div className='flex flex-wrap items-end gap-3'>
            <Field label='Code'>
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
              <label className='flex min-w-[14rem] flex-1 flex-col gap-1'>
                <span className='sr-only'>Custom code</span>
                <input
                  className={`${inputCls} text-[15px] font-bold uppercase tracking-[0.14em]`}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                  maxLength={32}
                  placeholder='SUMMER-2026'
                  autoComplete='off'
                  spellCheck={false}
                  aria-invalid={!!codeErr}
                  data-field='code-custom'
                />
              </label>
            ) : (
              <span className='pb-1.5 font-mono text-[13px] tracking-[0.14em] text-white/40'>XXXX-XXXX-XXXX · made on create</span>
            )}
          </div>
          {codeErr && <div className='-mt-2 text-[11px] text-rose-300'>{codeErr}</div>}

          <div>
            <div className='mb-1.5 text-[10px] uppercase tracking-[0.14em] text-white/40'>Reward</div>
            <RewardBundleEditor value={bundle} onChange={setBundle} />
            <div className='mt-2'>
              <CheckLine check={check} emptyText='Add credits, free rolls or an item.' />
            </div>
          </div>

          <div className='grid gap-3 sm:grid-cols-[1fr_1fr_minmax(0,2fr)]'>
            <Field label='Max uses' hint='0 = unlimited'>
              <input className={inputCls} inputMode='numeric' value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ''))} data-field='code-max' />
            </Field>
            <Field label='Min level' hint='0 = anyone'>
              <input className={inputCls} inputMode='numeric' value={minLevel} onChange={(e) => setMinLevel(e.target.value.replace(/[^0-9]/g, ''))} data-field='code-level' />
            </Field>
            <ExpiryField value={expires} onChange={setExpires} />
          </div>
          {expiryErr && <div className='-mt-2 text-[11px] text-rose-300'>{expiryErr}</div>}
          <Field label='Note' hint='shown to players on their receipt · ≤ 200'>
            <input className={inputCls} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder='Thanks for playing Instagib Arena.' data-field='code-note' />
          </Field>

          <div className='flex flex-wrap items-center gap-3'>
            <button type='button' className={primaryCls} disabled={!ready} onClick={() => void create()} data-action='code-create'>
              {busy ? 'Creating…' : 'Create code'}
            </button>
            <Banner msg={msg} />
          </div>

          {made && (
            <div className='flex flex-wrap items-center gap-3 rounded-md border border-emerald-400/40 bg-emerald-400/[0.06] px-4 py-3' role='status' data-code-created>
              <span className='text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300'>Created</span>
              <span className='font-display text-2xl font-bold tracking-[0.12em] text-white'>{made.code}</span>
              <CopyButton text={made.code} />
              <span className='font-mono text-[11px] text-white/45'>
                {made.maxUses ? `${made.maxUses} uses` : 'unlimited uses'} · {made.expiresAt ? `expires ${fmtWhen(made.expiresAt)}` : 'never expires'}
                {made.minLevel ? ` · Lv ${made.minLevel}+` : ''}
              </span>
            </div>
          )}
        </div>

        <aside className='flex flex-col gap-2 lg:sticky lg:top-4 lg:self-start'>
          <div className='text-[10px] uppercase tracking-[0.18em] text-white/40'>Player gets</div>
          <div className='rounded-lg border border-cyan-400/20 bg-[radial-gradient(100%_70%_at_50%_0%,rgba(103,232,249,0.1),transparent_70%)] p-4'>
            {bundleDraftEmpty(bundle) ? <div className='py-6 text-center text-[12px] text-white/35'>Nothing yet.</div> : <RewardView bundle={draftToBundle(bundle)} tile={84} />}
          </div>
        </aside>
      </div>
    </Card>
  );
}

// ── List ────────────────────────────────────────────────────────────────────
function RewardMini({ reward }: { reward: RewardBundle }) {
  const items = reward.items ?? [];
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {!!reward.credits && <span className='rounded bg-amber-300/10 px-1.5 py-0.5 font-display text-[13px] font-bold text-amber-200'>⛁ {reward.credits.toLocaleString()}</span>}
      {!!reward.rolls && (
        <span className='inline-flex items-center gap-1 rounded bg-cyan-300/10 px-1.5 py-0.5 font-display text-[13px] font-bold text-cyan-200'>
          <TicketGlyph size={12} /> {reward.rolls}
        </span>
      )}
      {items.slice(0, 4).map((s, i) => (
        <span key={i} title={bundleSummary({ items: [s] })}>
          <SpecTile inst={specPreview(s, i)} size={34} />
        </span>
      ))}
      {items.length > 4 && <span className='text-[11px] text-white/45'>+{items.length - 4}</span>}
    </div>
  );
}

function UsesBar({ uses, max }: { uses: number; max: number }) {
  const frac = max > 0 ? Math.min(1, uses / max) : 0;
  return (
    <div className='min-w-[84px]'>
      <div className='tabular-nums text-white/80'>
        {uses.toLocaleString()} <span className='text-white/35'>/ {max > 0 ? max.toLocaleString() : '∞'}</span>
      </div>
      {max > 0 && (
        <div className='mt-1 h-1 w-full overflow-hidden rounded bg-white/10'>
          <div className={`h-full ${frac >= 1 ? 'bg-rose-400' : 'bg-cyan-400'}`} style={{ width: `${frac * 100}%` }} />
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
      <button
        type='button'
        role='switch'
        aria-checked={code.active}
        aria-label={`${code.code} active`}
        disabled={busy}
        onClick={() => void flip()}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition disabled:opacity-50 ${code.active ? 'border-emerald-400/60 bg-emerald-400/30' : 'border-white/20 bg-white/5'}`}
        data-action='code-active'
      >
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${code.active ? 'left-[18px] bg-emerald-300' : 'left-0.5 bg-white/40'}`} />
      </button>
      {err && <span className='text-[10px] text-rose-300'>{err}</span>}
    </span>
  );
}

function statusOf(c: RedeemCodeWire): { text: string; cls: string } {
  if (!c.active) return { text: 'Off', cls: 'text-white/40' };
  if (c.expiresAt && c.expiresAt <= Date.now()) return { text: 'Expired', cls: 'text-rose-300' };
  if (c.maxUses > 0 && c.uses >= c.maxUses) return { text: 'Used up', cls: 'text-amber-300' };
  return { text: 'Live', cls: 'text-emerald-300' };
}

function CodeList({ codes, error, onRefresh, onPatch }: { codes: RedeemCodeWire[] | null; error: string; onRefresh: () => void; onPatch: (c: RedeemCodeWire) => void }) {
  const [q, setQ] = useState('');
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
  const shown = (codes ?? []).filter((c) => !t || c.code.includes(t) || c.note.toUpperCase().includes(t));
  return (
    <Card
      title={`Codes${codes ? ` · ${codes.length}` : ''}`}
      right={
        <span className='flex items-center gap-2'>
          <input className={inputCls} placeholder='Filter…' value={q} onChange={(e) => setQ(e.target.value)} aria-label='Filter codes' />
          <button type='button' className={btnCls} onClick={onRefresh}>
            Refresh
          </button>
        </span>
      }
    >
      {error && <Banner msg={{ tone: 'err', text: error }} />}
      {codes === null ? (
        <div className='py-8 text-center text-[12px] uppercase tracking-[0.2em] text-white/35'>Loading…</div>
      ) : shown.length === 0 ? (
        <div className='py-8 text-center text-[12px] text-white/35'>{codes.length ? 'No codes match.' : 'No codes yet — make one above.'}</div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-left font-mono text-[12px]' data-code-list>
            <thead className='text-[10px] uppercase tracking-[0.14em] text-white/40'>
              <tr>
                <th className='py-2 pr-3'>Code</th>
                <th className='py-2 pr-3'>Reward</th>
                <th className='py-2 pr-3'>Uses</th>
                <th className='py-2 pr-3'>Expires</th>
                <th className='py-2 pr-3'>Min Lv</th>
                <th className='py-2 pr-3'>Active</th>
                <th className='py-2 pr-3'>Created</th>
                <th className='py-2' />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const st = statusOf(c);
                const rs = reds[c.code];
                return (
                  <Fragment key={c.code}>
                    <tr className={`border-t border-white/5 align-middle ${c.active ? '' : 'opacity-60'}`} data-code={c.code}>
                      <td className='py-2 pr-3'>
                        <div className='flex items-center gap-2'>
                          <b className='text-[13px] tracking-[0.08em] text-white'>{c.code}</b>
                          <CopyButton text={c.code} />
                        </div>
                        <div className='mt-0.5 flex gap-2 text-[10px]'>
                          <span className={`font-bold uppercase tracking-[0.12em] ${st.cls}`}>{st.text}</span>
                          {c.note && <span className='max-w-[220px] truncate text-white/35' title={c.note}>{c.note}</span>}
                        </div>
                      </td>
                      <td className='py-2 pr-3'>
                        <RewardMini reward={c.reward} />
                      </td>
                      <td className='py-2 pr-3'>
                        <UsesBar uses={c.uses} max={c.maxUses} />
                      </td>
                      <td className={`py-2 pr-3 ${c.expiresAt && c.expiresAt <= Date.now() ? 'text-rose-300' : 'text-white/60'}`}>{c.expiresAt ? fmtWhen(c.expiresAt) : <span className='text-white/30'>never</span>}</td>
                      <td className='py-2 pr-3 text-white/60'>{c.minLevel || <span className='text-white/30'>—</span>}</td>
                      <td className='py-2 pr-3'>
                        <ActiveToggle code={c} onPatch={onPatch} />
                      </td>
                      <td className='py-2 pr-3 text-white/50'>
                        {c.createdBy}
                        <div className='text-[10px] text-white/30' title={new Date(c.createdAt).toLocaleString()}>
                          {timeAgo(c.createdAt)}
                        </div>
                      </td>
                      <td className='py-2 text-right'>
                        <button type='button' className={btnCls} onClick={() => void drill(c.code)} aria-expanded={open === c.code} data-action='code-redemptions'>
                          Redemptions
                        </button>
                      </td>
                    </tr>
                    {open === c.code && (
                      <tr className='bg-black/30'>
                        <td colSpan={8} className='px-3 py-3'>
                          {rs === 'loading' || rs === undefined ? (
                            <span className='text-white/40'>Loading…</span>
                          ) : rs === 'error' ? (
                            <span className='text-rose-300'>Couldn’t load redemptions.</span>
                          ) : rs.length === 0 ? (
                            <span className='text-white/40'>Nobody has redeemed {c.code} yet.</span>
                          ) : (
                            <>
                              <div className='mb-2 text-[10px] uppercase tracking-[0.14em] text-white/40'>
                                {rs.length} redemption{rs.length === 1 ? '' : 's'}
                                {rs.length >= 500 ? ' (latest 500)' : ''}
                              </div>
                              <ul className='grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-6 gap-y-1'>
                                {rs.map((x, i) => (
                                  <li key={`${x.player}-${i}`} className='flex justify-between gap-3'>
                                    <span className='truncate text-white/85'>{x.player}</span>
                                    <span className='shrink-0 text-white/40' title={new Date(x.at).toLocaleString()}>
                                      {timeAgo(x.at)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
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
    </Card>
  );
}
