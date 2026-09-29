// Admin → Items: search a player's inventory (revoke, item history), grant
// credits / free rolls, and the item GENERATOR — any catalog def dressed with
// qualities or as a custom one-off (name, description, tint, tier incl.
// Unobtainable, bound or not), previewed live, minted straight into a player's
// inventory. Session-only routes (docs/economy.md §7). The spec builder is
// src/admin/ItemSpecEditor.tsx (the Codes / Gifts bundles reuse it).
import { useCallback, useState } from 'react';
import '../locker/locker.css';
import './economy.css';
import type { ItemInstanceWire } from '../game/items/types';
import { ItemSpecEditor } from '../admin/ItemSpecEditor';
import { PlayerLookup } from '../admin/PlayerLookup';
import { draftToSpec, newDraft, type SpecDraft } from '../admin/spec-draft';
import { Banner, Card, btnCls, dangerCls, inputCls, primaryCls, type Msg } from '../admin/ui';
import { TIER_COLOR } from '../ui/rarity';
import { econ, reasonText, type AdminInvResp, type ItemHistoryResp } from './api';
import { instFullName, instTags, instTier, timeAgo } from './display';
import { InstTile, TagPills, TierChip } from './parts';

export function AdminItemsTab() {
  const [player, setPlayer] = useState('');
  const [inv, setInv] = useState<AdminInvResp | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<ItemHistoryResp | null>(null);
  const [grantC, setGrantC] = useState('');
  const [grantR, setGrantR] = useState('');

  const say = (tone: 'ok' | 'err', text: string) => setMsg({ tone, text });

  const load = useCallback(
    async (name: string, all: boolean) => {
      if (!name.trim()) return;
      setBusy(true);
      const r = await econ.adminInventory(name.trim(), all);
      setBusy(false);
      if (!r.ok) {
        setInv(null);
        say('err', r.status === 404 ? `No player named “${name}”.` : reasonText(r));
        return;
      }
      setInv(r);
      setMsg(null);
    },
    [],
  );

  const revoke = async (it: ItemInstanceWire) => {
    const reason = window.prompt(`Revoke ${instFullName(it)} (${it.uid})? Reason (logged):`, 'admin action');
    if (reason === null) return;
    const r = await econ.adminRevoke(it.uid, reason);
    if (!r.ok) return say('err', reasonText(r));
    say('ok', `Revoked ${instFullName(it)}.`);
    void load(inv?.player ?? player, showAll);
  };
  const history = async (it: ItemInstanceWire) => {
    const r = await econ.adminHistory(it.uid);
    if (!r.ok) return say('err', reasonText(r));
    setHist(r);
  };
  const grant = async () => {
    const who = inv?.player ?? player.trim();
    if (!who) return say('err', 'Search a player first.');
    const c = Math.trunc(Number(grantC) || 0);
    const rr = Math.trunc(Number(grantR) || 0);
    if (!c && !rr) return say('err', 'Enter credits and / or rolls.');
    const r = await econ.adminGrant(who, c || undefined, rr || undefined);
    if (!r.ok) return say('err', reasonText(r));
    say('ok', `Granted. ${who} now has ⛁ ${r.credits.toLocaleString()} and ${r.freeRolls} free rolls.`);
    setGrantC('');
    setGrantR('');
    void load(who, showAll);
  };

  return (
    <div>
      <Card
        title='Player inventory'
        right={
          <div className='flex flex-wrap items-center gap-2'>
            <input className={inputCls} placeholder='Player name' value={player} onChange={(e) => setPlayer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load(player, showAll)} aria-label='Player name' data-field='admin-player' />
            <label className='flex items-center gap-1.5 text-[11px] text-white/50'>
              <input type='checkbox' checked={showAll} onChange={(e) => { setShowAll(e.target.checked); if (inv) void load(inv.player, e.target.checked); }} /> include salvaged / traded / revoked
            </label>
            <button type='button' className={btnCls} disabled={busy || !player.trim()} onClick={() => void load(player, showAll)} data-action='admin-search'>
              {busy ? 'Loading…' : 'Search'}
            </button>
          </div>
        }
      >
        {msg && (
          <div className='mb-3'>
            <Banner msg={msg} />
          </div>
        )}
        {!inv ? (
          <div className='py-6 text-center text-[12px] text-white/35'>Search a player to see their items.</div>
        ) : (
          <>
            <div className='mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]'>
              <b className='font-display text-lg text-cyan-200'>{inv.player}</b>
              <span className='text-amber-200'>⛁ {inv.credits.toLocaleString()}</span>
              <span className='text-cyan-200'>{inv.freeRolls} free rolls</span>
              <span className='text-white/40'>{inv.items.length} items</span>
              <span className='ml-auto flex flex-wrap items-center gap-2'>
                <input className={`${inputCls} w-24`} inputMode='numeric' placeholder='± credits' value={grantC} onChange={(e) => setGrantC(e.target.value)} aria-label='Credits to grant' data-field='grant-credits' />
                <input className={`${inputCls} w-24`} inputMode='numeric' placeholder='± rolls' value={grantR} onChange={(e) => setGrantR(e.target.value)} aria-label='Free rolls to grant' data-field='grant-rolls' />
                <button type='button' className={btnCls} onClick={() => void grant()} data-action='admin-grant'>Grant</button>
              </span>
            </div>
            <div className='overflow-x-auto'>
              <table className='w-full text-left font-mono text-[12px]'>
                <thead className='text-[10px] uppercase tracking-[0.14em] text-white/40'>
                  <tr>
                    <th className='py-2 pr-3'>Item</th>
                    <th className='py-2 pr-3'>Tier</th>
                    <th className='py-2 pr-3'>Attributes</th>
                    <th className='py-2 pr-3'>Mint</th>
                    <th className='py-2 pr-3'>State</th>
                    <th className='py-2 pr-3'>Origin</th>
                    <th className='py-2 pr-3'>uid</th>
                    <th className='py-2' />
                  </tr>
                </thead>
                <tbody>
                  {inv.items.map((it) => (
                    <tr key={it.uid} className='border-t border-white/5 align-middle'>
                      <td className='py-2 pr-3'>
                        <div className='flex items-center gap-2'>
                          <InstTile inst={it} size={48} fluid={false} label={false} />
                          <span className='text-white/90'>{instFullName(it)}</span>
                        </div>
                      </td>
                      <td className='py-2 pr-3'><TierChip tier={instTier(it)} /></td>
                      <td className='max-w-[260px] py-2 pr-3'><TagPills tags={instTags(it)} /></td>
                      <td className='py-2 pr-3 tabular-nums'>#{it.mint}</td>
                      <td className={`py-2 pr-3 ${it.state === 'owned' ? 'text-emerald-300' : it.state === 'listed' ? 'text-amber-300' : 'text-white/40'}`}>{it.state}{it.tradable ? '' : ' · bound'}</td>
                      <td className='py-2 pr-3 text-white/50'>{it.origin} · {timeAgo(it.createdAt)}</td>
                      <td className='py-2 pr-3 text-white/35'>{it.uid}</td>
                      <td className='py-2 text-right'>
                        <span className='flex justify-end gap-1.5'>
                          <button type='button' className={btnCls} onClick={() => void history(it)} data-action='item-history'>History</button>
                          {(it.state === 'owned' || it.state === 'listed') && <button type='button' className={dangerCls} onClick={() => void revoke(it)} data-action='item-revoke'>Revoke</button>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <MintForm defaultPlayer={inv?.player ?? ''} onMinted={(who) => { if (inv && inv.player.toLowerCase() === who.toLowerCase()) void load(who, showAll); }} />

      {hist && (
        <div className='fixed inset-0 z-50 grid place-items-center bg-black/70 p-4' role='dialog' aria-modal='true' aria-label='Item history' onClick={() => setHist(null)}>
          <div className='max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-white/15 bg-zinc-950 p-5' onClick={(e) => e.stopPropagation()}>
            <div className='mb-3 flex items-start justify-between gap-4'>
              <div>
                <h3 className='font-display text-lg text-cyan-200'>{instFullName(hist.item)} <span className='font-mono text-[12px] text-white/40'>#{hist.item.mint}</span></h3>
                <div className='font-mono text-[11px] text-white/40'>{hist.item.uid} · owner {hist.owner || '—'} · {hist.item.state}</div>
              </div>
              <button type='button' className={btnCls} onClick={() => setHist(null)}>Close</button>
            </div>
            <ol className='flex flex-col gap-1.5 font-mono text-[12px]'>
              {hist.events.map((e) => (
                <li key={e.id} className='flex flex-wrap items-baseline gap-x-3 rounded border border-white/8 px-3 py-1.5'>
                  <b className='w-16 uppercase text-cyan-300'>{e.kind}</b>
                  <span className='text-white/40'>{new Date(e.ts).toLocaleString()}</span>
                  <span className='text-white/70'>{e.from ? `${e.from} → ` : ''}{e.to || ''}</span>
                  {e.meta != null && typeof e.meta === 'object' && Object.keys(e.meta as object).length > 0 && <span className='text-white/40'>{JSON.stringify(e.meta)}</span>}
                </li>
              ))}
              {hist.events.length === 0 && <li className='text-white/35'>No events.</li>}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Item generator ──────────────────────────────────────────────────────────

type Minted = { at: number; who: string; items: ItemInstanceWire[] };

function MintForm({ defaultPlayer, onMinted }: { defaultPlayer: string; onMinted: (who: string) => void }) {
  const [draft, setDraft] = useState<SpecDraft>(() => newDraft('hat.tophat'));
  const [target, setTarget] = useState('');
  const [count, setCount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [log, setLog] = useState<Minted[]>([]);
  const who = (target || defaultPlayer).trim();
  const n = Math.max(1, Math.min(25, Math.floor(Number(count) || 1)));

  const mint = async () => {
    if (!who) return setMsg({ tone: 'err', text: 'Pick a player to mint to.' });
    setBusy(true);
    setMsg(null);
    const spec = draftToSpec(draft);
    const r = await econ.adminMint({ player: who, def: spec.def, quality: spec.quality, attrs: spec.attrs, tier: spec.tier, bound: spec.bound, count: n });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: 'err', text: r.status === 404 ? `No player named “${who}”.` : reasonText(r, 'admin') + (r.reason ? ` (${r.reason})` : '') });
    setMsg({ tone: 'ok', text: `Minted ${r.items.length}× ${instFullName(r.items[0])} to ${who}.` });
    setLog((l) => [{ at: Date.now(), who, items: r.items }, ...l].slice(0, 20));
    onMinted(who);
  };

  return (
    <Card title='Item generator' right={<button type='button' className={btnCls} onClick={() => setDraft(newDraft(draft.def))}>Reset attributes</button>}>
      <ItemSpecEditor value={draft} onChange={setDraft} count={n} />
      <div className='mt-5 flex flex-wrap items-end gap-3 border-t border-white/10 pt-4'>
        <label className='flex min-w-[14rem] flex-1 flex-col gap-1 sm:max-w-xs'>
          <span className='text-[10px] uppercase tracking-[0.14em] text-white/40'>Mint to player</span>
          <PlayerLookup value={target} onChange={setTarget} placeholder={defaultPlayer || 'Search a player…'} field='mint-player' />
        </label>
        <label className='flex flex-col gap-1'>
          <span className='text-[10px] uppercase tracking-[0.14em] text-white/40'>Count</span>
          <input className={`${inputCls} w-20`} inputMode='numeric' value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} aria-label='Count (1–25)' data-field='mint-count' />
        </label>
        <button type='button' className={`${primaryCls} ml-auto`} disabled={busy || !who} onClick={() => void mint()} data-action='admin-mint'>
          {busy ? 'Minting…' : `Mint ${n > 1 ? `${n}× ` : ''}to ${who || '…'}`}
        </button>
      </div>
      {msg && (
        <div className='mt-3'>
          <Banner msg={msg} />
        </div>
      )}
      {log.length > 0 && (
        <div className='mt-4'>
          <div className='mb-2 text-[10px] uppercase tracking-[0.14em] text-white/40'>Minted this session</div>
          <ul className='flex flex-col gap-1.5' data-mint-log>
            {log.map((m) => (
              <li key={`${m.at}-${m.items[0]?.uid}`} className='flex flex-wrap items-center gap-3 rounded border border-white/8 bg-black/20 px-3 py-2 font-mono text-[12px]'>
                <InstTile inst={m.items[0]} size={56} fluid={false} label={false} />
                <span className='min-w-0 flex-1'>
                  <span className='font-display text-[14px] uppercase' style={{ color: TIER_COLOR[instTier(m.items[0])].text }}>
                    {m.items.length > 1 ? `${m.items.length}× ` : ''}
                    {instFullName(m.items[0])}
                  </span>
                  <span className='block text-[11px] text-white/40'>
                    → {m.who} · #{m.items.map((i) => i.mint).join(', #')} · {m.items[0].tradable ? 'tradable' : 'bound'} · {timeAgo(m.at)}
                  </span>
                </span>
                <span className='text-[10px] text-white/30'>{m.items.map((i) => i.uid).join(' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
