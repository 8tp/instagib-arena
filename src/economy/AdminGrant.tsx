// Admin → Grant: pick a player, then give (or take) credits / free rolls and
// mint items with the item GENERATOR — any catalog def dressed with the
// qualities its slot allows, or a custom one-off (name, description, tint,
// tier incl. Unobtainable, bound or not), previewed live and validated by the
// server before minting. Session-only routes (docs/economy.md §7). The spec
// builder is src/admin/ItemSpecEditor.tsx (the Codes / Gifts bundles reuse it).
import { useCallback, useEffect, useState } from 'react';
import '../locker/locker.css';
import './economy.css';
import type { ItemInstanceWire } from '../game/items/types';
import { ItemSpecEditor } from '../admin/ItemSpecEditor';
import { PlayerPicker, PlayerSummary } from '../admin/PlayerPicker';
import { playerCard, type AdminPlayer } from '../admin/api';
import { draftToSpec, newDraft, type SpecDraft } from '../admin/spec-draft';
import { CheckLine } from '../admin/RewardBundleEditor';
import { useBundleCheck } from '../admin/useBundleCheck';
import { ago } from '../admin/format';
import { Banner, Field, Plate, type Msg } from '../admin/ui';
import { TIER_COLOR } from '../ui/rarity';
import { econ, reasonText } from './api';
import { instFullName, instTier } from './display';
import { InstTile } from './parts';

export function AdminGrantTab({ initialPlayer, onInventory }: { initialPlayer?: string; onInventory: (playerId?: string) => void }) {
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  // Deep link from Players / Items ("Grant").
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

  useEffect(() => setMsg(null), [player?.id]);

  // Re-read the balance card after a grant or a mint.
  const refresh = useCallback(async () => {
    if (!player) return;
    const card = await playerCard(player.id);
    if (card) setPlayer(card);
  }, [player]);

  return (
    <div className='flex flex-col gap-5'>
      <Plate
        title='Player'
        sub='Everything on this tab grants to the player you pick here.'
        right={
          player && (
            <button type='button' className='adm-btn sm' onClick={() => onInventory(player.id)} data-action='open-inventory'>
              View inventory
            </button>
          )
        }
      >
        <div className='flex flex-col gap-3'>
          <PlayerPicker value={player} onChange={setPlayer} field='grant-player' autoFocus={!initialPlayer} />
          {player ? (
            <>
              <PlayerSummary p={player} />
              <GrantRow player={player} onDone={(m) => { setMsg(m); void refresh(); }} />
            </>
          ) : (
            <p className='text-[13px] text-[var(--adm-ink-3)]'>Pick a player to grant currency or mint items to them.</p>
          )}
          <Banner msg={msg} onClose={() => setMsg(null)} />
        </div>
      </Plate>

      <MintForm player={player} onMinted={() => void refresh()} />
    </div>
  );
}

// ± credits / rolls for the chosen player.
function GrantRow({ player, onDone }: { player: AdminPlayer; onDone: (m: Msg) => void }) {
  const [c, setC] = useState('');
  const [r, setR] = useState('');
  const [busy, setBusy] = useState(false);
  const cn = Math.trunc(Number(c) || 0);
  const rn = Math.trunc(Number(r) || 0);
  const grant = async () => {
    if (!cn && !rn) return;
    setBusy(true);
    const res = await econ.adminGrant(player.id, cn || undefined, rn || undefined);
    setBusy(false);
    if (!res.ok) return onDone({ tone: 'err', text: res.reason === 'insufficient' ? `${player.userName} doesn’t have that much to take.` : reasonText(res) });
    onDone({ tone: 'ok', text: `${player.userName} now has ⛁ ${res.credits.toLocaleString()} and ${res.freeRolls} free rolls.` });
    setC('');
    setR('');
  };
  const signed = (s: string) => s.replace(/[^0-9-]/g, '').replace(/(?!^)-/g, '').slice(0, 8);
  return (
    <div className='flex flex-wrap items-end gap-3 border-t border-[var(--adm-line)] pt-3'>
      <Field label='Credits' hint='negative takes'>
        <input className='adm-input mono w-32' inputMode='numeric' placeholder='+500' value={c} onChange={(e) => setC(signed(e.target.value))} data-field='grant-credits' />
      </Field>
      <Field label='Free rolls' hint='negative takes'>
        <input className='adm-input mono w-28' inputMode='numeric' placeholder='+3' value={r} onChange={(e) => setR(signed(e.target.value))} data-field='grant-rolls' />
      </Field>
      <button type='button' className='adm-btn' style={{ height: 34 }} disabled={busy || (!cn && !rn)} onClick={() => void grant()} data-action='admin-grant'>
        {busy ? 'Granting…' : cn < 0 || rn < 0 ? `Adjust ${player.userName}` : `Grant to ${player.userName}`}
      </button>
      <span className='pb-2 text-[12px] text-[var(--adm-ink-3)]'>Audit-logged.</span>
    </div>
  );
}

// ── Item generator ──────────────────────────────────────────────────────────
type Minted = { at: number; who: string; items: ItemInstanceWire[] };

function MintForm({ player, onMinted }: { player: AdminPlayer | null; onMinted: () => void }) {
  const [draft, setDraft] = useState<SpecDraft>(() => newDraft('hat.tophat'));
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [log, setLog] = useState<Minted[]>([]);
  const check = useBundleCheck({ credits: '', rolls: '', items: [draft] });

  const mint = async () => {
    if (!player || check.state !== 'ok') return;
    setBusy(true);
    setMsg(null);
    const spec = draftToSpec(draft);
    const r = await econ.adminMint({ player: player.id, def: spec.def, quality: spec.quality, attrs: spec.attrs, tier: spec.tier, bound: spec.bound, count });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: 'err', text: r.status === 404 ? `${player.userName} no longer exists.` : reasonText(r, 'admin') + (r.reason ? ` (${r.reason})` : '') });
    setMsg({ tone: 'ok', text: `Minted ${r.items.length}× ${instFullName(r.items[0])} to ${player.userName}.` });
    setLog((l) => [{ at: Date.now(), who: player.userName, items: r.items }, ...l].slice(0, 20));
    onMinted();
  };

  return (
    <Plate
      title='Item generator'
      sub='Only the fields the chosen item’s slot can carry are shown.'
      right={
        <button type='button' className='adm-btn sm' onClick={() => setDraft(newDraft(draft.def))}>
          Reset fields
        </button>
      }
    >
      <ItemSpecEditor value={draft} onChange={setDraft} count={count} />
      <div className='mt-5 flex flex-wrap items-center gap-4 border-t border-[var(--adm-line)] pt-4'>
        <Field label='Count' hint='1–25' as='div'>
          <span className='flex items-center'>
            <button type='button' className='adm-btn' style={{ height: 34, width: 34 }} onClick={() => setCount((n) => Math.max(1, n - 1))} aria-label='One fewer'>
              −
            </button>
            <input
              className='adm-input mono w-14 text-center'
              style={{ borderLeft: 0, borderRight: 0 }}
              inputMode='numeric'
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(25, Math.floor(Number(e.target.value.replace(/[^0-9]/g, '')) || 1))))}
              aria-label='Count (1–25)'
              data-field='mint-count'
            />
            <button type='button' className='adm-btn' style={{ height: 34, width: 34 }} onClick={() => setCount((n) => Math.min(25, n + 1))} aria-label='One more'>
              +
            </button>
          </span>
        </Field>
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <CheckLine check={check} emptyText='' />
          {!player && <span className='text-[12px] text-[var(--adm-warn)]'>Pick a player at the top of the page to mint to.</span>}
        </div>
        <button type='button' className='adm-btn primary' disabled={busy || !player || check.state !== 'ok'} onClick={() => void mint()} data-action='admin-mint'>
          {busy ? 'Minting…' : `Mint ${count > 1 ? `${count}× ` : ''}to ${player?.userName ?? '…'}`}
        </button>
      </div>
      {msg && (
        <div className='mt-3'>
          <Banner msg={msg} onClose={() => setMsg(null)} />
        </div>
      )}
      {log.length > 0 && (
        <div className='mt-5 flex flex-col gap-2'>
          <span className='adm-section-label'>Minted this session</span>
          <ul className='flex flex-col border border-[var(--adm-line)]' data-mint-log>
            {log.map((m) => (
              <li key={`${m.at}-${m.items[0]?.uid}`} className='flex flex-wrap items-center gap-3 border-b border-[var(--adm-line)] px-3 py-2 text-[13px] last:border-b-0'>
                <InstTile inst={m.items[0]} size={44} fluid={false} label={false} />
                <span className='min-w-0 flex-1'>
                  <span className='font-medium' style={{ color: TIER_COLOR[instTier(m.items[0])].text }}>
                    {m.items.length > 1 ? `${m.items.length}× ` : ''}
                    {instFullName(m.items[0])}
                  </span>
                  <span className='block text-[12px] text-[var(--adm-ink-3)]'>
                    → {m.who} · #{m.items.map((i) => i.mint).join(', #')} · {m.items[0].tradable ? 'tradable' : 'bound'} · {ago(m.at)}
                  </span>
                </span>
                <span className='font-mono text-[11px] text-[var(--adm-ink-3)]'>{m.items.map((i) => i.uid).join(' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Plate>
  );
}
