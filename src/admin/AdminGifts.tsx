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
import { playerCard, type AdminPlayer } from './api';
import { PlayerPicker, PlayerSummary } from './PlayerPicker';
import { draftToBundle, emptyBundle, type BundleDraft } from './spec-draft';
import { fromLocalInput } from './time';
import { Banner, ExpiryField, Field, Plate, Seg, Toggle, type Msg } from './ui';
import { useBundleCheck } from './useBundleCheck';

type Sent = { at: number; to: string; title: string; sent: number; reward: boolean };

export function AdminGiftsTab({ initialPlayer }: { initialPlayer?: string }) {
  const [target, setTarget] = useState<'one' | 'all'>('one');
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
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

  // Deep link from Players ("Gift").
  useEffect(() => {
    if (!initialPlayer) return;
    let live = true;
    void playerCard(initialPlayer).then((p) => {
      if (live && p) setPlayer(p);
    });
    return () => {
      live = false;
    };
  }, [initialPlayer]);

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
  // In form order, each pointing at the field that fixes it.
  const problems: { text: string; field: string }[] = [];
  if (target === 'one' && !player) problems.push({ text: 'Pick a recipient.', field: 'gift-player-input' });
  if (!title.trim()) problems.push({ text: 'Give the message a title.', field: 'gift-title' });
  if (attach && check.state !== 'ok') problems.push({ text: check.state === 'err' ? check.text : check.state === 'empty' ? 'Add something to attach, or turn off “Attach a reward”.' : 'Checking the reward…', field: 'bundle-credits' });
  if (expires && expiresAt <= Date.now()) problems.push({ text: 'The expiry must be in the future.', field: 'expires' });
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
      ...(target === 'all' ? { all: true } : { player: player?.id ?? '' }),
      title: title.trim(),
      body: body.trim(),
      reward: attach ? draftToBundle(bundle) : undefined,
      expiresAt: expiresAt || undefined,
    });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) return setMsg({ tone: 'err', text: r.status === 404 && target === 'one' ? `${player?.userName ?? 'That player'} no longer exists.` : reasonText(r, 'admin') });
    const to = target === 'all' ? 'everyone' : player?.userName ?? '';
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
    <div className='flex flex-col gap-5'>
      <Plate title='Send a gift or message' sub='Lands in the player’s inbox. Attachments are minted when they claim.'>
        <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]'>
          <div className='flex min-w-0 flex-col gap-5'>
            <div className='flex flex-col gap-3'>
              <Field label='Send to' as='div'>
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
                <>
                  <PlayerPicker value={player} onChange={setPlayer} field='gift-player' label='Recipient' />
                  {player && <PlayerSummary p={player} />}
                </>
              ) : (
                <div className='adm-banner' data-tone='warn'>
                  Every account{accounts != null ? ` · ${accounts.toLocaleString()} players` : ''}. You’ll confirm before it sends.
                </div>
              )}
            </div>
            <Field label='Title' hint='≤ 80'>
              <input className='adm-input text-[14px]' maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Thanks for playtesting!' data-field='gift-title' />
            </Field>
            <Field label='Message' hint='optional · ≤ 1000'>
              <textarea className='adm-input min-h-[96px] resize-y' maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder='A few words from the team…' data-field='gift-body' />
            </Field>
            <div className='flex flex-col gap-3 border-t border-[var(--adm-line)] pt-4'>
              <Toggle checked={attach} onChange={setAttach} field='gift-attach' hint='claimable from the inbox'>
                Attach a reward
              </Toggle>
              {attach && (
                <>
                  <RewardBundleEditor value={bundle} onChange={setBundle} />
                  <CheckLine check={check} emptyText='Add credits, free rolls or an item.' />
                </>
              )}
            </div>
            <div className='sm:max-w-lg'>
              <ExpiryField value={expires} onChange={setExpires} label={attach ? 'Claim by' : 'Expires'} />
            </div>

            {confirming ? (
              <div className='flex flex-col gap-3 border border-[rgba(245,181,69,0.5)] bg-[rgba(245,181,69,0.07)] p-4' role='alertdialog' aria-label='Confirm send to everyone' data-confirm-all>
                <div className='font-display text-[16px] font-semibold uppercase tracking-[0.08em] text-[var(--adm-warn)]'>Send to every account?</div>
                <p className='text-[13px] leading-relaxed text-[var(--adm-ink-2)]'>
                  “{title.trim()}” goes into the inbox of <b className='text-white'>all {accounts != null ? accounts.toLocaleString() : ''} players</b>
                  {hasReward ? ', each with their own copy of the attachments' : ''}. This can’t be recalled.
                </p>
                <div className='flex flex-wrap gap-2'>
                  <button type='button' className='adm-btn warn' disabled={busy} onClick={() => void send()} data-action='gift-confirm-all'>
                    {busy ? 'Sending…' : `Yes, send to all${accounts != null ? ` ${accounts.toLocaleString()}` : ''}`}
                  </button>
                  <button type='button' className='adm-btn' onClick={() => setConfirming(false)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className='flex flex-wrap items-center gap-3'>
                <button type='button' className='adm-btn primary' disabled={!ready} onClick={() => void send()} data-action='gift-send'>
                  {busy ? 'Sending…' : target === 'all' ? 'Send to everyone…' : `Send to ${player?.userName ?? '…'}`}
                </button>
                {problems.length > 0 && (
                  <button
                    type='button'
                    className='text-left text-[12px] text-[var(--adm-ink-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--adm-ink)]'
                    onClick={() => {
                      const el = document.querySelector<HTMLElement>(`[data-field='${problems[0].field}']`);
                      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      el?.focus({ preventScroll: true });
                    }}
                  >
                    {problems[0].text}
                  </button>
                )}
              </div>
            )}
            <Banner msg={msg} onClose={() => setMsg(null)} />
          </div>

          <aside className='flex flex-col gap-2 lg:sticky lg:top-[120px] lg:self-start'>
            <span className='adm-section-label'>In their inbox</span>
            <ul className='ib-list' data-gift-preview>
              <MessageRow m={sample} open fresh={false} claiming={false} error={null} onToggle={() => undefined} onClaim={() => undefined} preview />
            </ul>
          </aside>
        </div>
      </Plate>

      {log.length > 0 && (
        <Plate title='Sent this session' flush>
          <table className='adm-table'>
            <thead>
              <tr>
                <th>Title</th>
                <th>To</th>
                <th className='num'>Delivered</th>
                <th>Attachments</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {log.map((s) => (
                <tr key={s.at}>
                  <td className='strong'>{s.title}</td>
                  <td>{s.to}</td>
                  <td className='num'>{s.sent.toLocaleString()}</td>
                  <td>{s.reward ? 'Yes' : '—'}</td>
                  <td>{new Date(s.at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Plate>
      )}
    </div>
  );
}
