// Admin → Gifts: drop a message into one player's inbox — or everyone's — with
// optional claimable attachments (a reward bundle, minted on claim) and an
// optional expiry. Sending to ALL goes through a confirm step that names the
// account count. Server: adminSendGift (server/rewards.ts).
import '../inbox/inbox.css';
import { useEffect, useState } from 'react';
import type { InboxMessageWire } from '../game/items/types';
import { econ, reasonText } from '../economy/api';
import { MessageRow } from '../inbox/InboxPanel';
import { CheckLine, RewardBundleEditor } from './RewardBundleEditor';
import { PlayerLookup } from './PlayerLookup';
import { draftToBundle, emptyBundle, type BundleDraft } from './spec-draft';
import { fromLocalInput } from './time';
import { Banner, Card, Check, ExpiryField, Field, Seg, inputCls, primaryCls, btnCls, type Msg } from './ui';
import { useBundleCheck } from './useBundleCheck';

type Sent = { at: number; to: string; title: string; sent: number; reward: boolean };

export function AdminGiftsTab() {
  const [target, setTarget] = useState<'one' | 'all'>('one');
  const [player, setPlayer] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [attach, setAttach] = useState(true);
  const [bundle, setBundle] = useState<BundleDraft>(() => ({ ...emptyBundle(), credits: '250' }));
  const [expires, setExpires] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [accounts, setAccounts] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [log, setLog] = useState<Sent[]>([]);
  const check = useBundleCheck(bundle, attach);

  // "Everyone" means every account: fetch the number so the confirm can say it.
  useEffect(() => {
    if (target !== 'all' || accounts !== null) return;
    let live = true;
    void econ.adminAccountCount().then((r) => {
      if (live && r.ok) setAccounts(r.overview.totalAccounts);
    });
    return () => {
      live = false;
    };
  }, [target, accounts]);

  const expiresAt = fromLocalInput(expires);
  const problems: string[] = [];
  if (!title.trim()) problems.push('Add a title.');
  if (target === 'one' && !player.trim()) problems.push('Pick a player.');
  if (attach && check.state !== 'ok') problems.push(check.state === 'err' ? check.text : check.state === 'empty' ? 'Add something to attach (or untick attachments).' : 'Checking the reward…');
  if (expires && expiresAt <= Date.now()) problems.push('The expiry must be in the future.');
  const ready = problems.length === 0 && !busy;

  const send = async () => {
    if (!ready) return;
    if (target === 'all' && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await econ.adminGift({
      ...(target === 'all' ? { all: true } : { player: player.trim() }),
      title: title.trim(),
      body: body.trim(),
      reward: attach ? draftToBundle(bundle) : undefined,
      expiresAt: expiresAt || undefined,
    });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) return setMsg({ tone: 'err', text: r.status === 404 && target === 'one' ? `No player named “${player.trim()}”.` : reasonText(r, 'admin') });
    const to = target === 'all' ? 'everyone' : player.trim();
    setMsg({ tone: 'ok', text: `✓ Sent to ${r.sent.toLocaleString()} player${r.sent === 1 ? '' : 's'}${target === 'one' ? ` (${to})` : ''}.` });
    setLog((l) => [{ at: Date.now(), to, title: title.trim(), sent: r.sent, reward: attach }, ...l].slice(0, 12));
  };

  // What it will look like in their inbox (the real component, inert).
  const reward = attach ? draftToBundle(bundle) : {};
  const hasReward = attach && !!(reward.credits || reward.rolls || reward.items?.length);
  const sample: InboxMessageWire = {
    id: -1,
    kind: hasReward ? 'gift' : 'system',
    title: title.trim() || 'Your title here',
    body: body.trim(),
    sender: 'Instagib Staff',
    createdAt: Date.now(),
    readAt: 0,
    claimedAt: 0,
    expiresAt: expiresAt > Date.now() ? expiresAt : 0,
    reward: hasReward ? reward : {},
    granted: [],
  };

  return (
    <div>
      <Card title='Send a gift or message'>
        <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]'>
          <div className='flex min-w-0 flex-col gap-4'>
            <div className='flex flex-wrap items-end gap-3'>
              <Field label='Send to'>
                <Seg
                  label='Recipients'
                  value={target}
                  onChange={(v) => {
                    setTarget(v);
                    setConfirming(false);
                  }}
                  options={[
                    { id: 'one', label: 'One player' },
                    { id: 'all', label: 'Everyone' },
                  ]}
                />
              </Field>
              {target === 'one' ? (
                <label className='flex min-w-[14rem] flex-1 flex-col gap-1 sm:max-w-xs'>
                  <span className='sr-only'>Player</span>
                  <PlayerLookup value={player} onChange={setPlayer} placeholder='Search a player…' field='gift-player' />
                </label>
              ) : (
                <span className='pb-1.5 text-[12px] text-amber-200/90'>Every account{accounts != null ? ` · ${accounts.toLocaleString()} players` : ''}</span>
              )}
            </div>
            <Field label='Title' hint='≤ 80'>
              <input className={`${inputCls} text-[14px]`} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Thanks for playtesting!' data-field='gift-title' />
            </Field>
            <Field label='Message' hint='optional · ≤ 1000'>
              <textarea className={`${inputCls} min-h-[84px] resize-y font-sans text-[13px] leading-relaxed`} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder='A few words from the team…' data-field='gift-body' />
            </Field>
            <div>
              <div className='mb-2'>
                <Check checked={attach} onChange={setAttach} field='gift-attach'>
                  Attach a reward (claimable from the inbox)
                </Check>
              </div>
              {attach && (
                <>
                  <RewardBundleEditor value={bundle} onChange={setBundle} />
                  <div className='mt-2'>
                    <CheckLine check={check} emptyText='Add credits, free rolls or an item.' />
                  </div>
                </>
              )}
            </div>
            <div className='sm:max-w-md'>
              <ExpiryField value={expires} onChange={setExpires} label={attach ? 'Claim by' : 'Expires'} />
            </div>

            {confirming ? (
              <div className='flex flex-col gap-3 rounded-md border border-amber-400/50 bg-amber-400/[0.07] p-4' role='alertdialog' aria-label='Confirm send to everyone' data-confirm-all>
                <div className='font-display text-[16px] font-bold uppercase tracking-[0.08em] text-amber-200'>Send to every account?</div>
                <p className='text-[13px] leading-relaxed text-white/75'>
                  “{title.trim()}” goes into the inbox of <b className='text-white'>all {accounts != null ? accounts.toLocaleString() : ''} players</b>
                  {hasReward ? ', each with their own copy of the attachments' : ''}. This can’t be recalled.
                </p>
                <div className='flex flex-wrap gap-2'>
                  <button type='button' className='rounded-md border border-amber-300 bg-amber-300 px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-amber-200 disabled:opacity-50' disabled={busy} onClick={() => void send()} data-action='gift-confirm-all'>
                    {busy ? 'Sending…' : `Yes, send to all${accounts != null ? ` ${accounts.toLocaleString()}` : ''}`}
                  </button>
                  <button type='button' className={btnCls} onClick={() => setConfirming(false)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className='flex flex-wrap items-center gap-3'>
                <button type='button' className={primaryCls} disabled={!ready} onClick={() => void send()} data-action='gift-send'>
                  {busy ? 'Sending…' : target === 'all' ? 'Send to everyone…' : `Send to ${player.trim() || '…'}`}
                </button>
                {problems.length > 0 && <span className='text-[11px] text-white/40'>{problems[0]}</span>}
              </div>
            )}
            <Banner msg={msg} />
          </div>

          <aside className='flex flex-col gap-2 lg:sticky lg:top-4 lg:self-start'>
            <div className='text-[10px] uppercase tracking-[0.18em] text-white/40'>In their inbox</div>
            <ul className='ib-list' data-gift-preview>
              <MessageRow m={sample} open fresh={false} claiming={false} error={null} onToggle={() => undefined} onClaim={() => undefined} preview />
            </ul>
          </aside>
        </div>
      </Card>

      {log.length > 0 && (
        <Card title='Sent this session'>
          <ul className='flex flex-col gap-1.5 font-mono text-[12px]'>
            {log.map((s) => (
              <li key={s.at} className='flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-white/8 bg-black/20 px-3 py-2'>
                <b className='text-white/90'>{s.title}</b>
                <span className='text-white/50'>→ {s.to}</span>
                <span className='text-emerald-300'>{s.sent.toLocaleString()} delivered</span>
                {s.reward && <span className='text-amber-200'>with attachments</span>}
                <span className='ml-auto text-white/35'>{new Date(s.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
