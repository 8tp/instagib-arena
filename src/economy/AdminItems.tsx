// Admin → Items: pick a player, then browse their inventory (filter, item
// history, revoke). Granting currency and minting items lives on the Grant tab
// (AdminGrant.tsx). Session-only routes (docs/economy.md §7).
import { useCallback, useEffect, useMemo, useState } from 'react';
import '../locker/locker.css';
import './economy.css';
import { TIERS, TIER_META, type ItemInstanceWire, type Tier } from '../game/items/types';
import { TierDot } from '../admin/ItemPicker';
import { PlayerPicker, PlayerSummary } from '../admin/PlayerPicker';
import { playerCard, type AdminPlayer } from '../admin/api';
import { ago, fmt } from '../admin/format';
import { Banner, CopyButton, Empty, Loading, Plate, Toggle, type Msg } from '../admin/ui';
import { TIER_COLOR } from '../ui/rarity';
import { econ, reasonText, type AdminInvResp, type ItemHistoryResp } from './api';
import { ORIGIN_LABEL, instFullName, instTags, instTier } from './display';
import { InstTile, TagPills, TierChip } from './parts';

const STATE_COLOR: Record<string, string> = { owned: 'var(--adm-good)', listed: 'var(--adm-warn)' };

export function AdminItemsTab({ initialPlayer, onGrant }: { initialPlayer?: string; onGrant: (playerId?: string) => void }) {
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
  const [inv, setInv] = useState<AdminInvResp | null>(null);
  const [invLoading, setInvLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [hist, setHist] = useState<ItemHistoryResp | null>(null);

  // Deep link from Players ("Open in Items").
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

  const load = useCallback(async (p: AdminPlayer, all: boolean) => {
    setInvLoading(true);
    const r = await econ.adminInventory(p.id, all);
    setInvLoading(false);
    if (!r.ok) {
      setInv(null);
      setMsg({ tone: 'err', text: r.status === 404 ? `${p.userName} no longer exists.` : reasonText(r) });
      return;
    }
    setInv(r);
  }, []);

  // Re-read the player card + inventory after anything that changes them.
  const refresh = useCallback(async () => {
    if (!player) return;
    const [card] = await Promise.all([playerCard(player.id), load(player, showAll)]);
    if (card) setPlayer(card);
  }, [player, showAll, load]);

  useEffect(() => {
    setInv(null);
    setMsg(null);
    if (player) void load(player, showAll);
    // Reload when the chosen account or the filter changes — not on card refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player?.id, showAll, load]);

  return (
    <div className='flex flex-col gap-5'>
      <Plate
        title='Player'
        sub='Pick a player to browse and moderate their inventory.'
        right={
          <button type='button' className='adm-btn sm' onClick={() => onGrant(player?.id)} data-action='open-grant'>
            {player ? `Grant to ${player.userName}` : 'Grant items'}
          </button>
        }
      >
        <div className='flex flex-col gap-3'>
          <PlayerPicker value={player} onChange={setPlayer} field='admin-player' autoFocus={!initialPlayer} />
          {player ? (
            <PlayerSummary p={player} />
          ) : (
            <p className='text-[13px] text-[var(--adm-ink-3)]'>Pick a player to see their inventory. Currency and item grants are on the Grant tab.</p>
          )}
          <Banner msg={msg} onClose={() => setMsg(null)} />
        </div>
      </Plate>

      {player && (
        <Inventory
          inv={inv}
          loading={invLoading}
          showAll={showAll}
          setShowAll={setShowAll}
          onHistory={async (it) => {
            const r = await econ.adminHistory(it.uid);
            if (!r.ok) return setMsg({ tone: 'err', text: reasonText(r) });
            setHist(r);
          }}
          onRevoked={(it) => {
            setMsg({ tone: 'ok', text: `Revoked ${instFullName(it)} from ${player.userName}.` });
            void refresh();
          }}
          onError={(text) => setMsg({ tone: 'err', text })}
        />
      )}

      {hist && <HistoryDialog hist={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

function Inventory({
  inv,
  loading,
  showAll,
  setShowAll,
  onHistory,
  onRevoked,
  onError,
}: {
  inv: AdminInvResp | null;
  loading: boolean;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onHistory: (it: ItemInstanceWire) => void;
  onRevoked: (it: ItemInstanceWire) => void;
  onError: (t: string) => void;
}) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<Tier | ''>('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState('admin action');
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (inv?.items ?? []).filter((it) => (!tier || instTier(it) === tier) && (!t || instFullName(it).toLowerCase().includes(t) || it.uid.toLowerCase().includes(t) || it.def.includes(t)));
  }, [inv, q, tier]);
  const tierCounts = useMemo(() => {
    const m: Partial<Record<Tier, number>> = {};
    for (const it of inv?.items ?? []) m[instTier(it)] = (m[instTier(it)] ?? 0) + 1;
    return m;
  }, [inv]);
  const revoke = async (it: ItemInstanceWire) => {
    const r = await econ.adminRevoke(it.uid, reason.trim() || 'admin action');
    setRevoking(null);
    if (!r.ok) return onError(reasonText(r));
    onRevoked(it);
  };

  return (
    <Plate
      title='Inventory'
      sub={inv ? `${fmt(inv.items.length)} item${inv.items.length === 1 ? '' : 's'}${showAll ? ' incl. gone' : ''}` : undefined}
      flush
      right={
        <>
          <input className='adm-input w-48' style={{ height: 28 }} placeholder='Find in inventory…' value={q} onChange={(e) => setQ(e.target.value)} aria-label='Filter inventory' />
          <Toggle checked={showAll} onChange={setShowAll} hint='salvaged · traded · revoked'>
            Show gone
          </Toggle>
        </>
      }
    >
      <div className='flex flex-wrap gap-1 px-[18px] pb-3' role='group' aria-label='Filter by tier'>
        <button type='button' className='adm-chip' aria-pressed={tier === ''} onClick={() => setTier('')}>
          All <span className='n'>{inv?.items.length ?? 0}</span>
        </button>
        {TIERS.filter((t) => tierCounts[t]).map((t) => (
          <button key={t} type='button' className='adm-chip' aria-pressed={tier === t} onClick={() => setTier(tier === t ? '' : t)}>
            <TierDot tier={t} /> {TIER_META[t].label} <span className='n'>{tierCounts[t]}</span>
          </button>
        ))}
      </div>
      {!inv || loading ? (
        <div className='px-[18px] pb-4'>
          <Loading />
        </div>
      ) : items.length === 0 ? (
        <Empty title={inv.items.length ? 'Nothing matches.' : 'No items.'}>{inv.items.length ? 'Clear the search or tier filter.' : 'Mint them something from the Grant tab.'}</Empty>
      ) : (
        <div className='adm-scroll max-h-[560px]'>
          <table className='adm-table'>
            <thead>
              <tr>
                <th>Item</th>
                <th>Tier</th>
                <th className='num'>Mint</th>
                <th>State</th>
                <th>Origin</th>
                <th>uid</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.uid} data-uid={it.uid}>
                  <td>
                    <div className='flex items-center gap-3'>
                      <InstTile inst={it} size={44} fluid={false} label={false} />
                      <span className='flex min-w-0 flex-col gap-1'>
                        <span className='truncate font-medium' style={{ color: TIER_COLOR[instTier(it)].text }}>
                          {instFullName(it)}
                        </span>
                        <TagPills tags={instTags(it)} />
                      </span>
                    </div>
                  </td>
                  <td>
                    <TierChip tier={instTier(it)} />
                  </td>
                  <td className='num'>#{it.mint}</td>
                  <td className='whitespace-nowrap' style={{ color: STATE_COLOR[it.state] ?? 'var(--adm-ink-3)' }}>
                    {it.state}
                    {it.tradable ? '' : <span className='text-[var(--adm-ink-3)]'> · bound</span>}
                  </td>
                  <td className='whitespace-nowrap' title={ORIGIN_LABEL[it.origin]}>
                    {it.origin} <span className='text-[var(--adm-ink-3)]'>· {ago(it.createdAt)}</span>
                  </td>
                  <td>
                    <span className='font-mono text-[11px] text-[var(--adm-ink-3)]'>{it.uid}</span>
                  </td>
                  <td className='text-right'>
                    {revoking === it.uid ? (
                      <span className='flex items-center justify-end gap-1.5'>
                        <input className='adm-input w-40' style={{ height: 26 }} value={reason} onChange={(e) => setReason(e.target.value)} aria-label='Revoke reason (logged)' autoFocus onKeyDown={(e) => e.key === 'Escape' && setRevoking(null)} />
                        <button type='button' className='adm-btn sm danger' onClick={() => void revoke(it)} data-action='item-revoke-confirm'>
                          Revoke
                        </button>
                        <button type='button' className='adm-btn sm ghost' onClick={() => setRevoking(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className='flex justify-end gap-1.5'>
                        <button type='button' className='adm-btn sm' onClick={() => onHistory(it)} data-action='item-history'>
                          History
                        </button>
                        {(it.state === 'owned' || it.state === 'listed') && (
                          <button type='button' className='adm-btn sm danger' onClick={() => setRevoking(it.uid)} data-action='item-revoke'>
                            Revoke
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Plate>
  );
}

function HistoryDialog({ hist, onClose }: { hist: ItemHistoryResp; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className='fixed inset-0 z-50 grid place-items-center bg-black/70 p-4' role='dialog' aria-modal='true' aria-label='Item history' onClick={onClose}>
      <div className='adm-plate max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5' onClick={(e) => e.stopPropagation()}>
        <div className='mb-4 flex items-start gap-4'>
          <InstTile inst={hist.item} size={64} fluid={false} label={false} />
          <div className='min-w-0 flex-1'>
            <h3 className='text-[17px] font-semibold' style={{ color: TIER_COLOR[instTier(hist.item)].text }}>
              {instFullName(hist.item)} <span className='font-mono text-[12px] text-[var(--adm-ink-3)]'>#{hist.item.mint}</span>
            </h3>
            <div className='mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--adm-ink-2)]'>
              <span className='font-mono'>{hist.item.uid}</span>
              <CopyButton text={hist.item.uid} />
              <span>· owner {hist.owner || '—'} · {hist.item.state}</span>
            </div>
          </div>
          <button type='button' className='adm-btn sm' onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <ol className='relative flex flex-col gap-0 border-l border-[var(--adm-line-2)] pl-4'>
          {hist.events.map((e) => (
            <li key={e.id} className='relative py-2 text-[13px]'>
              <span className='absolute -left-[21px] top-3 h-2 w-2 bg-[var(--adm-rail)]' aria-hidden />
              <div className='flex flex-wrap items-baseline gap-x-3'>
                <b className='font-mono text-[12px] uppercase text-[var(--adm-rail)]'>{e.kind}</b>
                <span className='text-[var(--adm-ink)]'>
                  {e.from ? `${e.from} → ` : ''}
                  {e.to || ''}
                </span>
                <span className='ml-auto text-[12px] text-[var(--adm-ink-3)]'>{new Date(e.ts).toLocaleString()}</span>
              </div>
              {e.meta != null && typeof e.meta === 'object' && Object.keys(e.meta as object).length > 0 && <div className='mt-0.5 break-all font-mono text-[11px] text-[var(--adm-ink-3)]'>{JSON.stringify(e.meta)}</div>}
            </li>
          ))}
          {hist.events.length === 0 && <li className='py-2 text-[var(--adm-ink-3)]'>No events recorded.</li>}
        </ol>
      </div>
    </div>
  );
}
