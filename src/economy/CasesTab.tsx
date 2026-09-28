// Cases: five cases, opened with credits or a free roll. Fixed, published
// rates — the tier odds table AND the quality odds — are shown to everyone
// (guests too). Opening runs the reel; results land in the inventory.
import { useEffect, useMemo, useRef, useState } from 'react';
import { sfxProps, toast } from '../deck-core';
import { TIERS, TIER_META, type CaseId, type ItemInstanceWire } from '../game/items/types';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import { econ as api, reasonText, type CaseInfo, type OpenCaseResp } from './api';
import { CaseReveal } from './CaseReveal';
import { CrateArt } from './CrateArt';
import { fallbackCases, pct, poolOf, qualityRows } from './rates';
import { fmtCredits } from './display';
import { TicketGlyph } from '../menu/RewardTile';
import { Balance } from './parts';
import type { Econ } from './useEconomy';

const CASE_HUE: Record<CaseId, { a: string; b: string; glyph: string }> = {
  hat: { a: '#f59e0b', b: '#5a2f04', glyph: 'H' },
  weapon: { a: '#ef4444', b: '#4a0d0d', glyph: 'W' },
  accessory: { a: '#4b8dff', b: '#0d2452', glyph: 'A' },
  taunt: { a: '#a855f7', b: '#2d0c4e', glyph: 'T' },
  vault: { a: '#ff4fd8', b: '#1d0a3a', glyph: 'V' },
};

export function CasesTab({
  econ,
  loggedIn,
  reduced,
  lowSpec = false,
  onEquipItem,
}: {
  econ: Econ;
  loggedIn: boolean;
  reduced: boolean;
  lowSpec?: boolean;
  onEquipItem: (item: ItemInstanceWire) => void;
}) {
  const [sel, setSel] = useState<CaseId>('hat');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ key: number; caseId: CaseId; res: OpenCaseResp; usedRoll: boolean } | null>(null);
  // Published rates: the server's effective odds (public call), with the shared
  // contract as a fallback so guests / offline still see rates.
  const [cases, setCases] = useState<CaseInfo[]>(() => fallbackCases());
  useEffect(() => {
    let live = true;
    void api.cases().then((r) => {
      if (live && r.ok && Array.isArray(r.cases) && r.cases.length > 0) setCases(r.cases);
    });
    return () => {
      live = false;
    };
  }, []);
  const c = cases.find((x) => x.id === sel) ?? cases[0];
  const hue = CASE_HUE[c.id];
  const pool = useMemo(() => poolOf(c), [c]);
  const ready = econ.status === 'ready';

  // The balance and the new item are applied when the reel LANDS (or the
  // reveal is dismissed / unmounted), so the counters never move mid-spin.
  const pending = useRef<OpenCaseResp | null>(null);
  const applyPending = () => {
    const r = pending.current;
    if (!r) return;
    pending.current = null;
    econ.setBalance({ credits: r.credits, freeRolls: r.freeRolls });
    econ.addItem(r.item);
  };
  const applyRef = useRef(applyPending);
  applyRef.current = applyPending;
  useEffect(() => () => applyRef.current(), []);

  const opening = useRef(false);
  const open = async (caseId: CaseId, useRoll: boolean) => {
    if (opening.current) return;
    opening.current = true;
    applyPending();
    setBusy(true);
    const r = await api.openCase(caseId, useRoll);
    setBusy(false);
    opening.current = false;
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      if (r.reason === 'insufficient' || r.reason === 'no_rolls') econ.reload();
      return;
    }
    pending.current = r;
    setReveal({ key: Date.now(), caseId, res: r, usedRoll: useRoll });
  };

  const canRoll = ready && econ.freeRolls > 0 && !c.premium;
  const canPay = ready && econ.credits >= c.cost;
  const short = Math.max(0, c.cost - econ.credits);

  const counts = c.pool;
  const q = qualityRows(c.qualityOdds);
  const revealCase = reveal ? (cases.find((x) => x.id === reveal.caseId) ?? c) : c;

  return (
    <div className='ec-page deck-scroll'>
      <div className='ec-page-in'>
        <div className='ec-cases' role='tablist' aria-label='Cases'>
          {cases.map((k) => {
            const h = CASE_HUE[k.id];
            return (
              <button
                key={k.id}
                type='button'
                role='tab'
                aria-selected={sel === k.id}
                data-case={k.id}
                className={`ec-case ${sel === k.id ? 'is-sel' : ''} ${k.premium ? 'ec-case-premium' : ''}`}
                style={{ ['--ca' as string]: h.a, ['--cb' as string]: h.b }}
                onClick={() => setSel(k.id)}
                {...sfxProps('tabSwitch')}
              >
                <span className='ec-crate' aria-hidden><CrateArt id={k.id} a={h.a} b={h.b} size={96} /></span>
                <span className='ec-case-name'>{k.name}</span>
                <span className='ec-case-cost'>{fmtCredits(k.cost)}</span>
              </button>
            );
          })}
        </div>

        <section className='ec-case-panel' style={{ ['--ca' as string]: hue.a, ['--cb' as string]: hue.b }} aria-label={`${c.name} details`}>
          <div className='ec-case-head'>
            <div className='ec-crate ec-crate-lg' aria-hidden><CrateArt id={c.id} a={hue.a} b={hue.b} size={150} /></div>
            <div className='min-w-0 flex-1'>
              <h3 className='ec-h1'>{c.name}</h3>
              <p className='lk-blurb mt-1'>{c.blurb}</p>
              <div className='mt-3 flex flex-wrap items-center gap-3'>
                <button
                  type='button'
                  className={`lk-action ${canPay ? 'lk-action-buy' : 'lk-action-muted'}`}
                  data-action='open-credits'
                  disabled={!canPay || busy}
                  onClick={() => void open(c.id, false)}
                  {...sfxProps('uiConfirm')}
                  title={!loggedIn ? 'Log in to open cases' : short > 0 ? `Need ${fmtCredits(short)} more` : undefined}
                >
                  {busy ? 'Opening…' : !loggedIn ? 'Log in to open' : short > 0 && ready ? `Need ${fmtCredits(short)} more` : `Open · ${fmtCredits(c.cost)}`}
                </button>
                <button
                  type='button'
                  className={`lk-action ${canRoll ? 'lk-action-equip' : 'lk-action-muted'}`}
                  data-action='open-roll'
                  disabled={!canRoll || busy}
                  onClick={() => void open(c.id, true)}
                  {...sfxProps('uiConfirm')}
                >
                  <TicketGlyph size={18} /> {c.premium ? 'Credits only' : `Free roll · ${econ.freeRolls}`}
                </button>
                {loggedIn && <Balance credits={ready ? econ.credits : null} freeRolls={null} />}
              </div>
              <p className='mt-3 font-sans text-[12.5px] text-white/50'>
                Rolls are decided by the server. Free rolls open standard cases only. Duplicates are possible — salvage them or sell them on the market. Credits are earned in play, never bought.
              </p>
            </div>
          </div>

          <details className='ec-contents' open>
            <summary>What’s inside · {pool.length} items</summary>
            <div className='ec-contents-grid'>
              {TIERS.filter((t) => counts[t] > 0)
                .reverse()
                .map((t) => (
                  <div key={t} className='ec-tier-row'>
                    <div className='ec-tier-label' style={{ color: TIER_COLOR[t].edge }}>{TIER_LABEL[t]}</div>
                    <div className='flex flex-wrap gap-1.5'>
                      {pool.filter((d) => d.tier === t).map((d) => (
                        <ItemTile key={d.id} id={d.id} size={72} label={false} tier={d.tier} rootProps={{ title: d.name }} />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          </details>

          <div className='ec-rates'>
            <div>
              <h4 className='ec-section !mt-0'>Drop rates <small>fixed · no pity · same for everyone</small></h4>
              <table className='ec-table' aria-label={`${c.name} tier odds`}>
                <tbody>
                  {TIERS.filter((t) => c.odds[t] > 0).map((t) => (
                    <tr key={t}>
                      <th scope='row'>
                        <span className={`ec-dot ${isIridescent(t) ? 'ec-iri-bg' : ''}`} style={isIridescent(t) ? undefined : { background: TIER_COLOR[t].edge }} />
                        {TIER_LABEL[t]}
                      </th>
                      <td className='w-full'>
                        <span className='ec-bar' aria-hidden>
                          <i className={isIridescent(t) ? 'ec-iri-bg' : ''} style={{ width: `${Math.max(1.5, Math.min(100, c.odds[t] * 100 * (c.odds.common > 0.5 ? 1.5 : 2.6)))}%`, background: isIridescent(t) ? undefined : TIER_COLOR[t].edge }} />
                        </span>
                      </td>
                      <td className='ec-num'>{pct(c.odds[t])}</td>
                      <td className='ec-num text-white/45'>{counts[t]} item{counts[t] === 1 ? '' : 's'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className='mt-2 font-sans text-[12px] text-white/45'>Each roll picks a tier, then one item of that tier evenly. Salvage: {TIERS.filter((t) => c.odds[t] > 0).map((t) => `${TIER_META[t].label} ${fmtCredits(TIER_META[t].salvage)}`).join(' · ')}.</p>
            </div>
            <div>
              <h4 className='ec-section !mt-0'>Quality odds <small>rolled on each drop</small></h4>
              {q.length === 0 ? (
                <p className='font-sans text-[13px] text-white/50'>No special qualities drop from this case.</p>
              ) : (
                <table className='ec-table' aria-label={`${c.name} quality odds`}>
                  <tbody>
                    {q.map((r) => (
                      <tr key={r.label}>
                        <th scope='row'>
                          <span className='ec-dot' style={{ background: r.color }} />
                          {r.label}
                        </th>
                        <td className='ec-num' style={{ color: r.color }}>{r.odds}</td>
                        <td className='font-sans text-[12px] text-white/50'>{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className='mt-2 font-sans text-[12px] text-white/45'>Qualities stack — a Strange Professional Killstreak finish is possible. Festive only comes from seasonal cases.</p>
            </div>
          </div>

        </section>
      </div>

      {reveal && (
        <CaseReveal
          key={reveal.key}
          caseDef={revealCase}
          item={reveal.res.item}
          reduced={reduced}
          lowSpec={lowSpec}
          usedRoll={reveal.usedRoll}
          credits={econ.credits}
          freeRolls={econ.freeRolls}
          canAgain={(!revealCase.premium && econ.freeRolls > 0) || econ.credits >= revealCase.cost}
          onAgain={() => {
            applyPending();
            const id = reveal.caseId;
            const roll = econ.freeRolls > 0 && !revealCase.premium;
            setReveal(null);
            void open(id, roll);
          }}
          onLanded={applyPending}
          onEquip={(it) => {
            applyPending();
            onEquipItem(it);
          }}
          onClose={() => {
            applyPending();
            setReveal(null);
          }}
        />
      )}
    </div>
  );
}
