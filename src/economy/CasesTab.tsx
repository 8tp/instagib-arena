// Cases: five cases, opened with credits or a free roll. Fixed, published
// rates — the tier odds table AND the quality odds — are shown to everyone
// (guests too). Opening runs the reel; results land in the inventory.
import { useEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { sfxProps, toast, uiHover } from '../deck-core';
import { CURRENT_SEASON, SEASONS, TIERS, TIER_META, type CaseId, type ItemInstanceWire } from '../game/items/types';
import { prefetchThumbnails } from '../game/thumbs';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import { econ as api, reasonText, type CaseInfo, type CasePay, type OpenCaseResp } from './api';
import { DAILY_CASE_USED_EVENT, fmtCountdown } from './daily-case';
import { CaseReveal } from './CaseReveal';
import { CASE_HUE } from './case-hue';
import { CrateArt } from './CrateArt';
import { fallbackCases, pct, poolOf, qualityRows } from './rates';
import { fmtCredits } from './display';
import { TicketGlyph } from '../menu/RewardTile';
import { ItemHoverCard } from './ItemHoverCard';
import { ItemPreviewModal, type PreviewSettings } from './ItemPreviewModal';
import { Balance } from './parts';
import { canPreview, previewOfDef, type PreviewItem } from './preview-item';
import type { Econ } from './useEconomy';

const CARD_HIDE_MS = 140; // grace to move the pointer from a tile onto its card

const seasonLine = (id: number, name?: string): string => {
  const s = SEASONS.find((x) => x.id === id);
  return `${name ?? s?.name ?? `Season ${id}`}${s?.title ? ` · ${s.title}` : ''}`;
};

// A gift box (the daily free case) and a clock (its countdown).
function GiftGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinejoin='round'>
      <path d='M3.5 9.5h17v4h-17zM5 13.5h14V21H5zM12 9.5V21' />
      <path d='M12 9.5c-1.2-3.6-5.6-5.2-6.4-2.7-.6 1.9 2.6 2.7 6.4 2.7zM12 9.5c1.2-3.6 5.6-5.2 6.4-2.7.6 1.9-2.6 2.7-6.4 2.7z' />
    </svg>
  );
}
function ClockGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round'>
      <circle cx='12' cy='12' r='8.5' />
      <path d='M12 7.5V12l3 2' />
    </svg>
  );
}

export function CasesTab({
  econ,
  loggedIn,
  reduced,
  lowSpec = false,
  settings,
  onEquipItem,
}: {
  econ: Econ;
  loggedIn: boolean;
  reduced: boolean;
  lowSpec?: boolean;
  settings: PreviewSettings; // your loadout + name, for "Preview on you"
  onEquipItem: (item: ItemInstanceWire) => void;
}) {
  const [sel, setSel] = useState<CaseId>('hat');
  // Pool hover card (mouse hover / keyboard focus on a "What's inside" tile)
  // and the live preview modal.
  const [card, setCard] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const hideTimer = useRef(0);
  const showCard = (id: string, el: HTMLElement) => {
    window.clearTimeout(hideTimer.current);
    setCard({ id, rect: el.getBoundingClientRect() });
  };
  const hideCardSoon = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCard(null), CARD_HIDE_MS);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const openPreview = (id: string) => {
    window.clearTimeout(hideTimer.current);
    setCard(null);
    const p = previewOfDef(id);
    if (p && canPreview(id)) setPreview(p);
  };
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ key: number; caseId: CaseId; res: OpenCaseResp; pay: CasePay } | null>(null);
  // Published rates: the server's effective odds (public call), with the shared
  // contract as a fallback so guests / offline still see rates.
  const [cases, setCases] = useState<CaseInfo[]>(() => fallbackCases());
  // Daily free case: one free standard-case open per UTC day (server-tracked).
  const [daily, setDaily] = useState<{ available: boolean; nextAt: number }>({ available: false, nextAt: 0 });
  const [season, setSeason] = useState<string>(() => seasonLine(CURRENT_SEASON));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (daily.available || daily.nextAt <= 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [daily]);
  useEffect(() => {
    if (!daily.available && daily.nextAt > 0 && now >= daily.nextAt) setDaily({ available: true, nextAt: 0 });
  }, [now, daily]);
  useEffect(() => {
    let live = true;
    void api.cases().then((r) => {
      if (!live || !r.ok) return;
      if (Array.isArray(r.cases) && r.cases.length > 0) setCases(r.cases);
      setDaily({ available: !!r.dailyAvailable, nextAt: r.nextDailyAt ?? 0 });
      if (r.season) setSeason(seasonLine(r.season.id, r.season.name));
    });
    return () => {
      live = false;
    };
  }, []);
  const c = cases.find((x) => x.id === sel) ?? cases[0];
  const hue = CASE_HUE[c.id];
  const pool = useMemo(() => poolOf(c), [c]);
  // Warm the pool's thumbnails the moment a case is picked: the reveal's reel
  // draws from them and should never wait on the render queue.
  useEffect(() => {
    prefetchThumbnails(
      pool.map((d) => d.id),
      true,
    );
  }, [pool]);
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
  const open = async (caseId: CaseId, pay: CasePay) => {
    if (opening.current) return;
    opening.current = true;
    applyPending();
    setBusy(true);
    const r = await api.openCase(caseId, pay);
    setBusy(false);
    opening.current = false;
    if (!r.ok) {
      toast(reasonText(r), { tone: 'err' });
      if (r.reason === 'insufficient' || r.reason === 'no_rolls') econ.reload();
      if (r.reason === 'daily_used') setDaily({ available: false, nextAt: Date.now() + 60_000 });
      return;
    }
    if (pay === 'daily') {
      setDaily({ available: false, nextAt: r.nextDailyAt ?? 0 });
      setNow(Date.now());
      window.dispatchEvent(new Event(DAILY_CASE_USED_EVENT));
    }
    pending.current = r;
    setReveal({ key: Date.now(), caseId, res: r, pay });
  };

  const canRoll = ready && econ.freeRolls > 0 && !c.premium;
  const canPay = ready && econ.credits >= c.cost;
  const canDaily = ready && loggedIn && daily.available && !c.premium;
  const short = Math.max(0, c.cost - econ.credits);

  const counts = c.pool;
  const q = qualityRows(c.qualityOdds);
  const revealCase = reveal ? (cases.find((x) => x.id === reveal.caseId) ?? c) : c;
  const againPay: CasePay | null = !revealCase.premium && econ.freeRolls > 0 ? 'roll' : econ.credits >= revealCase.cost ? 'credits' : null;
  const dailyLeft = !daily.available && daily.nextAt > 0 ? fmtCountdown(daily.nextAt - now) : null;

  return (
    <div className='ec-page deck-scroll' onScroll={card ? () => setCard(null) : undefined}>
      <div className='ec-page-in'>
        <header className='ec-cases-head'>
          <div className='min-w-0'>
            <h2 className='ec-h1'>Cases</h2>
            <p className='ec-sub !mb-0'>Every drop is decided by the server at fixed, published odds.</p>
          </div>
          <span className='ec-season-pill' title='Cases drop items from the current season only'>
            <i aria-hidden /> {season}
          </span>
        </header>
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
                {loggedIn && daily.available && !k.premium && <span className='ec-free-ribbon'>Free today</span>}
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
                  onClick={() => void open(c.id, 'credits')}
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
                  onClick={() => void open(c.id, 'roll')}
                  {...sfxProps('uiConfirm')}
                >
                  <TicketGlyph size={18} /> {c.premium ? 'Credits only' : `Free roll · ${econ.freeRolls}`}
                </button>
                {loggedIn && !c.premium && (
                  <span className={`ec-daily ${daily.available ? 'is-ready' : 'is-used'}`}>
                    <button
                      type='button'
                      className='ec-daily-btn'
                      data-action='open-daily'
                      disabled={!canDaily || busy}
                      onClick={() => void open(c.id, 'daily')}
                      {...sfxProps('uiConfirm')}
                      title='One free standard case every day (resets 00:00 UTC)'
                    >
                      {daily.available ? <GiftGlyph /> : <ClockGlyph />}
                      <span className='ec-daily-text'>
                        <b>{daily.available ? 'Daily free case' : 'Free case claimed'}</b>
                        <small>{daily.available ? `Open this ${c.name} free` : dailyLeft ? `Next in ${dailyLeft}` : 'Back tomorrow'}</small>
                      </span>
                    </button>
                  </span>
                )}
                {loggedIn && <Balance credits={ready ? econ.credits : null} freeRolls={null} />}
              </div>
              <p className='mt-3 font-sans text-[12.5px] text-white/50'>
                {season} pool. Rolls are decided by the server. Your daily free case and free rolls open standard cases only. Duplicates are possible — salvage them or sell them on the market. Credits are earned in play, never bought.
              </p>
            </div>
          </div>

          <details className='ec-contents' open>
            <summary>
              What’s inside · {pool.length} items <small className='ec-contents-hint'>hover to inspect · click to preview on you</small>
            </summary>
            <div className='ec-contents-grid' onPointerLeave={hideCardSoon}>
              {TIERS.filter((t) => counts[t] > 0)
                .reverse()
                .map((t) => (
                  <div key={t} className='ec-tier-row'>
                    <div className='ec-tier-label' style={{ color: TIER_COLOR[t].edge }}>{TIER_LABEL[t]}</div>
                    <div className='flex flex-wrap gap-1.5'>
                      {pool.map((d) =>
                        d.tier !== t ? null : (
                          <ItemTile
                            key={d.id}
                            id={d.id}
                            size={72}
                            label={false}
                            tier={d.tier}
                            selected={card?.id === d.id}
                            onClick={canPreview(d.id) ? () => openPreview(d.id) : undefined}
                            onPointerEnter={(e: ReactPointerEvent<HTMLElement>) => {
                              if (e.pointerType === 'touch') return;
                              uiHover(e);
                              showCard(d.id, e.currentTarget);
                            }}
                            onPointerLeave={hideCardSoon}
                            onFocus={(e: FocusEvent<HTMLElement>) => {
                              if (e.currentTarget.matches(':focus-visible')) showCard(d.id, e.currentTarget);
                            }}
                            onBlur={() => setCard((cur) => (cur?.id === d.id ? null : cur))}
                            rootProps={{ 'data-pool': d.id, 'aria-label': `${d.name}, ${TIER_LABEL[d.tier]}. Preview on you` }}
                          />
                        ),
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </details>
          {card && (
            <ItemHoverCard
              id={card.id}
              anchor={card.rect}
              reduced={reduced}
              onPreview={() => openPreview(card.id)}
              onEnter={() => window.clearTimeout(hideTimer.current)}
              onLeave={hideCardSoon}
            />
          )}

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
          previewSettings={settings}
          pay={reveal.pay}
          credits={econ.credits}
          freeRolls={econ.freeRolls}
          againPay={againPay}
          onAgain={() => {
            applyPending();
            if (!againPay) return;
            const id = reveal.caseId;
            setReveal(null);
            void open(id, againPay);
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
      {preview && <ItemPreviewModal item={preview} settings={settings} onClose={() => setPreview(null)} />}
    </div>
  );
}
