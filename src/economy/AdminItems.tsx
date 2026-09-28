// Admin → Items: search a player's inventory (revoke, item history), grant
// credits / free rolls, and MINT items — a catalog def with chosen qualities,
// or a custom one-off (name, description, tint, effect, tier incl.
// Unobtainable, bound or not). Session-only routes (docs/economy.md §7).
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import '../locker/locker.css';
import './economy.css';
import { ITEM_DEFS, itemDef } from '../game/items/catalog';
import {
  ITEM_SLOTS,
  KS_EFFECTS,
  KS_SHEENS,
  TIERS,
  TIER_META,
  UNUSUAL_EFFECTS,
  type ItemAttrs,
  type ItemInstanceWire,
  type Quality,
  type Tier,
} from '../game/items/types';
import { TIER_COLOR } from '../ui/rarity';
import { econ, reasonText, type AdminInvResp, type ItemHistoryResp } from './api';
import { SLOT_LABEL, instBaseName, instFullName, instTier, timeAgo } from './display';
import { InstTile, TagPills, TierChip } from './parts';
import { instTags } from './display';

const inputCls =
  'rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60 placeholder:text-white/30';
const btnCls =
  'rounded-md border border-white/20 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/80 transition hover:border-cyan-400/60 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40';
const dangerCls = 'rounded-md border border-rose-400/40 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.1em] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-40';

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className='mb-6 rounded-lg border border-white/10 bg-white/[0.03] p-4'>
      <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
        <h2 className='font-display text-[13px] uppercase tracking-[0.16em] text-white/70'>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className='text-[10px] uppercase tracking-[0.14em] text-white/40'>{label}</span>
      {children}
    </label>
  );
}

export function AdminItemsTab() {
  const [player, setPlayer] = useState('');
  const [inv, setInv] = useState<AdminInvResp | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
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
        {msg && <div className={`mb-3 rounded border px-3 py-2 text-[12px] ${msg.tone === 'ok' ? 'border-emerald-400/40 text-emerald-200' : 'border-rose-400/40 text-rose-200'}`}>{msg.text}</div>}
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

      <MintForm defaultPlayer={inv?.player ?? player} onMinted={(who) => { if (inv && inv.player.toLowerCase() === who.toLowerCase()) void load(who, showAll); }} say={say} />

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

// ── Mint ─────────────────────────────────────────────────────────────────────

const MINTABLE = ITEM_DEFS.filter((d) => !d.default && d.slot !== 'card' && d.slot !== 'title');

function MintForm({ defaultPlayer, onMinted, say }: { defaultPlayer: string; onMinted: (who: string) => void; say: (t: 'ok' | 'err', s: string) => void }) {
  const [target, setTarget] = useState('');
  const [defId, setDefId] = useState('hat.tophat');
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [tier, setTier] = useState<Tier | ''>('');
  const [tint, setTint] = useState('');
  const [effect, setEffect] = useState('');
  const [strange, setStrange] = useState(false);
  const [kills, setKills] = useState('0');
  const [sheen, setSheen] = useState('');
  const [proFx, setProFx] = useState('');
  const [festive, setFestive] = useState(false);
  const [nameTag, setNameTag] = useState('');
  const [wear, setWear] = useState('');
  const [seed, setSeed] = useState('');
  const [bound, setBound] = useState(false);
  const [count, setCount] = useState('1');
  const [busy, setBusy] = useState(false);

  const def = itemDef(defId);
  const who = (target || defaultPlayer).trim();

  const built = useMemo(() => {
    const attrs: ItemAttrs = {};
    const quality: Quality[] = [];
    if (custom) {
      if (name.trim()) attrs.customName = name.trim().slice(0, 40);
      if (desc.trim()) attrs.customDesc = desc.trim().slice(0, 160);
      if (/^#[0-9a-fA-F]{6}$/.test(tint)) attrs.tint = tint;
    }
    if (effect) {
      attrs.effect = effect;
      quality.push('unusual');
    }
    if (strange) {
      attrs.kills = Math.max(0, Math.floor(Number(kills) || 0));
      quality.push('strange');
    }
    if (sheen) {
      attrs.sheen = sheen;
      quality.push('killstreak');
      if (proFx) {
        attrs.ksEffect = proFx;
        quality.push('professional');
      }
    }
    if (festive) {
      attrs.festive = true;
      quality.push('festive');
    }
    if (nameTag.trim()) attrs.nameTag = nameTag.trim().slice(0, 24);
    if (wear !== '') attrs.wear = Math.max(0, Math.min(1, Number(wear) || 0));
    if (seed !== '') attrs.seed = Math.max(0, Math.min(999, Math.floor(Number(seed) || 0)));
    const t: Tier | undefined = custom && tier ? tier : undefined;
    if (custom && (attrs.customName || attrs.tint || t)) quality.push('admin');
    return { attrs, quality, tier: t };
  }, [custom, name, desc, tier, tint, effect, strange, kills, sheen, proFx, festive, nameTag, wear, seed]);

  const preview: ItemInstanceWire = {
    uid: 'preview',
    def: defId,
    mint: 1,
    quality: built.quality,
    attrs: built.attrs,
    origin: 'admin',
    tradable: !bound && (def?.tradable ?? true),
    state: 'owned',
    createdAt: Date.now(),
    tier: built.tier,
  };

  const mint = async () => {
    if (!who) return say('err', 'Enter a player name (search above or type it here).');
    setBusy(true);
    const r = await econ.adminMint({
      player: who,
      def: defId,
      quality: built.quality,
      attrs: built.attrs,
      tier: built.tier,
      bound,
      count: Math.max(1, Math.min(25, Math.floor(Number(count) || 1))),
    });
    setBusy(false);
    if (!r.ok) return say('err', reasonText(r) + (r.reason ? ` (${r.reason})` : ''));
    say('ok', `Minted ${r.items.length}× ${instFullName(r.items[0])} to ${who}.`);
    onMinted(who);
  };

  return (
    <Card title='Mint an item'>
      <div className='grid gap-6 lg:grid-cols-[1fr_240px]'>
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field label='Player'>
            <input className={inputCls} placeholder={defaultPlayer || 'Player name'} value={target} onChange={(e) => setTarget(e.target.value)} data-field='mint-player' />
          </Field>
          <Field label={custom ? 'Base def (the art / model)' : 'Item def'}>
            <select className={inputCls} value={defId} onChange={(e) => setDefId(e.target.value)} data-field='mint-def'>
              {ITEM_SLOTS.filter((s) => MINTABLE.some((d) => d.slot === s)).map((s) => (
                <optgroup key={s} label={SLOT_LABEL[s]} className='bg-zinc-900'>
                  {MINTABLE.filter((d) => d.slot === s).map((d) => (
                    <option key={d.id} value={d.id} className='bg-zinc-900'>{d.name} · {TIER_META[d.tier].label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <label className='flex items-center gap-2 text-[12px] text-white/70 sm:col-span-2'>
            <input type='checkbox' checked={custom} onChange={(e) => setCustom(e.target.checked)} data-field='mint-custom' /> Custom one-off (name, description, tint, tier override)
          </label>
          {custom && (
            <>
              <Field label='Name'><input className={inputCls} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={def?.name} data-field='mint-name' /></Field>
              <Field label='Tier'>
                <select className={inputCls} value={tier} onChange={(e) => setTier(e.target.value as Tier | '')} data-field='mint-tier'>
                  <option value='' className='bg-zinc-900'>Def default ({def ? TIER_META[def.tier].label : '—'})</option>
                  {TIERS.map((t) => <option key={t} value={t} className='bg-zinc-900'>{TIER_META[t].label}</option>)}
                </select>
              </Field>
              <Field label='Description' wide><input className={inputCls} maxLength={160} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={def?.blurb} data-field='mint-desc' /></Field>
              <Field label='Tint (#rrggbb)'>
                <span className='flex gap-2'>
                  <input className={`${inputCls} flex-1`} value={tint} onChange={(e) => setTint(e.target.value)} placeholder='#ff4fd8' data-field='mint-tint' />
                  <input type='color' aria-label='Tint colour' value={/^#[0-9a-fA-F]{6}$/.test(tint) ? tint : '#ffffff'} onChange={(e) => setTint(e.target.value)} className='h-[34px] w-10 cursor-pointer rounded border border-white/15 bg-transparent' />
                </span>
              </Field>
            </>
          )}
          <Field label='Unusual effect'>
            <select className={inputCls} value={effect} onChange={(e) => setEffect(e.target.value)} data-field='mint-effect'>
              <option value='' className='bg-zinc-900'>None</option>
              {UNUSUAL_EFFECTS.map((e) => <option key={e.id} value={e.id} className='bg-zinc-900'>{e.name}{e.taunt ? ' (taunt ok)' : ''}</option>)}
            </select>
          </Field>
          <Field label='Name tag'><input className={inputCls} maxLength={24} value={nameTag} onChange={(e) => setNameTag(e.target.value)} /></Field>
          <div className='flex items-end gap-3'>
            <label className='flex items-center gap-2 text-[12px] text-white/70'><input type='checkbox' checked={strange} onChange={(e) => setStrange(e.target.checked)} /> Strange</label>
            {strange && <input className={`${inputCls} w-24`} inputMode='numeric' value={kills} onChange={(e) => setKills(e.target.value)} aria-label='Kills' />}
          </div>
          <label className='flex items-center gap-2 self-end text-[12px] text-white/70'><input type='checkbox' checked={festive} onChange={(e) => setFestive(e.target.checked)} /> Festive</label>
          <Field label='Killstreak sheen'>
            <select className={inputCls} value={sheen} onChange={(e) => setSheen(e.target.value)}>
              <option value='' className='bg-zinc-900'>None</option>
              {KS_SHEENS.map((s) => <option key={s.id} value={s.id} className='bg-zinc-900'>{s.name}</option>)}
            </select>
          </Field>
          <Field label='Professional effect'>
            <select className={inputCls} value={proFx} onChange={(e) => setProFx(e.target.value)} disabled={!sheen}>
              <option value='' className='bg-zinc-900'>None</option>
              {KS_EFFECTS.map((s) => <option key={s.id} value={s.id} className='bg-zinc-900'>{s.name}</option>)}
            </select>
          </Field>
          {def?.slot === 'finish' && (
            <>
              <Field label='Wear (0–1)'><input className={inputCls} inputMode='decimal' value={wear} onChange={(e) => setWear(e.target.value)} placeholder='0.05' /></Field>
              <Field label='Pattern seed (0–999)'><input className={inputCls} inputMode='numeric' value={seed} onChange={(e) => setSeed(e.target.value)} placeholder='318' /></Field>
            </>
          )}
          <div className='flex flex-wrap items-center gap-4 sm:col-span-2'>
            <label className='flex items-center gap-2 text-[12px] text-white/70'><input type='checkbox' checked={bound} onChange={(e) => setBound(e.target.checked)} data-field='mint-bound' /> Bound (untradable)</label>
            <label className='flex items-center gap-2 text-[12px] text-white/70'>Count <input className={`${inputCls} w-16`} inputMode='numeric' value={count} onChange={(e) => setCount(e.target.value)} data-field='mint-count' /></label>
            <button type='button' className={`${btnCls} ml-auto border-cyan-400/50 text-cyan-200`} disabled={busy || !who} onClick={() => void mint()} data-action='admin-mint'>
              {busy ? 'Minting…' : `Mint to ${who || '…'}`}
            </button>
          </div>
        </div>
        <div className='flex flex-col items-center gap-2'>
          <div className='text-[10px] uppercase tracking-[0.14em] text-white/40'>Preview</div>
          <div className='w-[200px]'><InstTile inst={preview} /></div>
          <div className='text-center font-display text-[15px] uppercase leading-tight' style={{ color: TIER_COLOR[instTier(preview)].text }}>{instFullName(preview) || instBaseName(preview)}</div>
          <TagPills tags={instTags(preview)} />
        </div>
      </div>
    </Card>
  );
}
