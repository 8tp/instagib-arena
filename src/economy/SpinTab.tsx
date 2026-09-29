// Spin: the Daily Spin wheel (docs/economy.md §3b). A FREE spin once per UTC day
// (credits / a free case roll / a plain low-tier item) and a PREMIUM spin for
// credits (always an item, Uncommon floor, qualities rolled like a case). The
// request goes first, the wheel then lands on the server's answer; balance,
// rolls and inventory update only once it has landed. Odds are published and
// fixed — no pity.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sfxProps, toast, uiSfx } from '../deck-core';
import { casePoolFor } from '../game/items/catalog';
import { SPIN, SPIN_SLOTS, TIERS, type ItemInstanceWire, type SpinInfo, type SpinKind, type SpinSegment, type Tier } from '../game/items/types';
import { TicketGlyph } from '../menu/RewardTile';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import { econ as api, reasonText } from './api';
import { fmtCredits } from './display';
import { Balance } from './parts';
import { pct } from './rates';
import { SpinReveal, type SpinWin } from './SpinReveal';
import { SpinWheel, type Wedge, type WheelHandle } from './SpinWheel';
import type { Econ } from './useEconomy';
import { SPIN_USED_EVENT, visualWeights } from './spin-link';
import './spin.css';

// What the wheel shows before (or without) the public call: the shared contract.
function fallbackInfo(): SpinInfo {
  const pool = casePoolFor(SPIN_SLOTS);
  const pc = Object.fromEntries(TIERS.map((t) => [t, t === 'unobtainable' ? 0 : pool.filter((d) => d.tier === t).length])) as Record<Tier, number>;
  return { free: SPIN.free.map((s) => ({ ...s })), premiumCost: SPIN.premiumCost, premiumOdds: { ...SPIN.premium }, pool: pc, freeAvailable: false, nextFreeAt: 0, credits: 0, freeRolls: 0 };
}

const CREDIT_HUE: Record<number, { from: string; to: string }> = {
  25: { from: '#d6981a', to: '#5e3b04' },
  50: { from: '#f0b52a', to: '#7a4a05' },
  150: { from: '#ffe066', to: '#b26f0a' },
};
const creditHue = (n: number) => CREDIT_HUE[n] ?? { from: '#e8a91f', to: '#6a4205' };

function freeWedges(free: SpinSegment[]): Wedge[] {
  const w = visualWeights(free.map((s) => s.odds));
  return free.map((s, i) => {
    if (s.reward.type === 'credits') {
      const h = creditHue(s.reward.amount);
      return { id: s.id, label: s.label, pct: s.odds, weight: w[i], from: h.from, to: h.to, edge: '#ffd35a' };
    }
    if (s.reward.type === 'roll') return { id: s.id, label: '+1 ROLL', pct: s.odds, weight: w[i], from: '#2fd8f2', to: '#083f4e', edge: '#67e8f9' };
    const c = TIER_COLOR[s.reward.tier];
    return { id: s.id, label: TIER_LABEL[s.reward.tier], pct: s.odds, weight: w[i], from: c.from, to: c.to, edge: c.edge };
  });
}
function premiumWedges(odds: Record<Tier, number>): Wedge[] {
  const tiers = TIERS.filter((t) => odds[t] > 0);
  const w = visualWeights(tiers.map((t) => odds[t]), 0.07);
  return tiers.map((t, i) => ({ id: t, label: TIER_LABEL[t], pct: odds[t], weight: w[i], from: TIER_COLOR[t].from, to: TIER_COLOR[t].to, edge: TIER_COLOR[t].edge }));
}

const two = (n: number) => String(n).padStart(2, '0');
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

// 1 Hz countdown to the daily reset; fires onDone once at zero.
function Countdown({ until, onDone }: { until: number; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const left = until - now;
  useEffect(() => {
    if (until > 0 && left <= 0) done.current();
  }, [until, left]);
  return (
    <span className='sp-count' role='timer' aria-label={`Next free spin in ${fmtCountdown(left)}`}>
      {fmtCountdown(left)}
    </span>
  );
}

export function SpinTab({
  econ,
  loggedIn,
  reduced,
  onEquipItem,
  onLogin,
}: {
  econ: Econ;
  loggedIn: boolean;
  reduced: boolean;
  onEquipItem: (item: ItemInstanceWire) => void;
  onLogin?: () => void;
}) {
  const [info, setInfo] = useState<SpinInfo>(() => fallbackInfo());
  const [mode, setMode] = useState<SpinKind>('free');
  const [busy, setBusy] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [winId, setWinId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ key: number; kind: SpinKind; win: SpinWin } | null>(null);
  const wheel = useRef<WheelHandle>(null);
  const ready = econ.status === 'ready';

  const loadInfo = useCallback(() => {
    void api.spinInfo().then((r) => {
      if (r.ok && Array.isArray(r.free) && r.free.length > 0) setInfo(r);
    });
  }, []);
  useEffect(() => {
    loadInfo();
  }, [loadInfo, loggedIn]);

  const free = useMemo(() => freeWedges(info.free), [info.free]);
  const prem = useMemo(() => premiumWedges(info.premiumOdds), [info.premiumOdds]);
  const wedges = mode === 'free' ? free : prem;

  // Balance / inventory are applied when the wheel LANDS (or on unmount / a
  // new spin), so the counters never move mid-spin.
  const pending = useRef<SpinWin | null>(null);
  const applyPending = useCallback(() => {
    const r = pending.current;
    if (!r) return;
    pending.current = null;
    econ.setBalance({ credits: r.credits, freeRolls: r.freeRolls });
    if (r.gained.item) econ.addItem(r.gained.item);
    if (r.kind === 'free') window.dispatchEvent(new Event(SPIN_USED_EVENT));
    if (r.kind === 'free') setInfo((i) => ({ ...i, freeAvailable: false, nextFreeAt: r.nextFreeAt, credits: r.credits, freeRolls: r.freeRolls }));
    else setInfo((i) => ({ ...i, credits: r.credits, freeRolls: r.freeRolls }));
  }, [econ]);
  const applyRef = useRef(applyPending);
  applyRef.current = applyPending;
  useEffect(() => () => applyRef.current(), []);

  const inFlight = useRef(false);
  const spin = async (kind: SpinKind) => {
    if (inFlight.current) return;
    inFlight.current = true;
    applyPending();
    setWinId(null);
    setBusy(true);
    const r = await api.spin(kind);
    setBusy(false);
    if (!r.ok) {
      inFlight.current = false;
      toast(reasonText(r), { tone: 'err' });
      if (r.reason === 'already_spun' || r.reason === 'insufficient') {
        econ.reload();
        loadInfo();
      }
      return;
    }
    pending.current = r;
    uiSfx('uiConfirm');
    await wheel.current?.spinTo(r.segment);
    inFlight.current = false;
    applyPending();
    setWinId(r.segment);
    if (r.gained.roll) toast('+1 free roll', { tone: 'ok', sound: 'unlock' });
    window.setTimeout(() => setReveal({ key: Date.now(), kind, win: r }), reduced ? 0 : 520);
  };

  const cost = info.premiumCost;
  const canPay = ready && econ.credits >= cost;
  const canFree = loggedIn && info.freeAvailable;
  const short = Math.max(0, cost - econ.credits);
  const locked = busy || spinning;
  const accent = mode === 'free' ? '#ffc23d' : '#c58bff';
  const modeWedges = wedges;

  return (
    <div className='ec-page deck-scroll' data-spin-mode={mode}>
      <div className='ec-page-in'>
        <div className='ec-subtabs' role='tablist' aria-label='Wheel'>
          <button type='button' role='tab' aria-selected={mode === 'free'} data-spin-tab='free' className={`sp-mode ${mode === 'free' ? 'is-sel' : ''}`} disabled={locked} onClick={() => { setMode('free'); setWinId(null); }} {...sfxProps('tabSwitch')}>
            Daily wheel
            {canFree && <i className='sp-pip' aria-label='Free spin ready' />}
          </button>
          <button type='button' role='tab' aria-selected={mode === 'premium'} data-spin-tab='premium' className={`sp-mode ${mode === 'premium' ? 'is-sel is-prem' : ''}`} disabled={locked} onClick={() => { setMode('premium'); setWinId(null); }} {...sfxProps('tabSwitch')}>
            Premium wheel · {fmtCredits(cost)}
          </button>
        </div>

        <section className={`sp-stage ${mode === 'premium' ? 'is-prem' : ''}`} aria-label={mode === 'free' ? 'Daily spin' : 'Premium spin'}>
          <div className='sp-wheel-col'>
            <SpinWheel
              key={mode}
              ref={wheel}
              wedges={modeWedges}
              reduced={reduced}
              winId={winId}
              accent={accent}
              hub={mode === 'free' ? 'FREE' : 'PRO'}
              dim={!loggedIn}
              label={mode === 'free' ? 'Daily spin wheel' : 'Premium spin wheel'}
              onSpinning={setSpinning}
            />
          </div>

          <div className='sp-side'>
            <h3 className='ec-h1'>{mode === 'free' ? 'Daily Spin' : 'Premium Spin'}</h3>
            <p className='lk-blurb mt-2'>
              {mode === 'free'
                ? 'One free spin every day, resetting at 00:00 UTC. Win credits, a free case roll, or a plain item.'
                : `Spend ${fmtCredits(cost)} for a guaranteed item — Uncommon or better. Qualities roll exactly like a case.`}
            </p>

            <div className='sp-cta'>
              {!loggedIn ? (
                onLogin ? (
                  <button type='button' className='lk-action lk-action-buy sp-go' data-action='spin-login' onClick={onLogin} {...sfxProps('uiConfirm')}>
                    Sign in to spin
                  </button>
                ) : (
                  <div className='sp-guest' data-action='spin-login'>
                    <b>Sign in to spin</b>
                    <span>Create a free account to claim a daily spin.</span>
                  </div>
                )
              ) : mode === 'free' ? (
                canFree ? (
                  <button type='button' className='lk-action lk-action-buy sp-go sp-go-ready' data-action='spin-free' disabled={locked || !ready} onClick={() => void spin('free')} {...sfxProps('none')}>
                    {busy ? 'Spinning…' : spinning ? 'Spinning…' : 'Free spin'}
                  </button>
                ) : (
                  <>
                    <button type='button' className='lk-action lk-action-muted sp-go' data-action='spin-free' disabled>
                      {spinning || busy ? 'Spinning…' : 'Free spin used'}
                    </button>
                    {!spinning && !busy && info.nextFreeAt > 0 && (
                      <div className='sp-next'>
                        <small>Next free spin in</small>
                        <Countdown until={info.nextFreeAt} onDone={loadInfo} />
                      </div>
                    )}
                  </>
                )
              ) : (
                <button
                  type='button'
                  className={`lk-action sp-go ${canPay ? 'lk-action-buy sp-go-prem' : 'lk-action-muted'}`}
                  data-action='spin-premium'
                  disabled={locked || !canPay}
                  onClick={() => void spin('premium')}
                  {...sfxProps('none')}
                >
                  {busy || spinning ? 'Spinning…' : ready && !canPay ? `Need ${fmtCredits(short)} more` : `Premium spin — ${fmtCredits(cost)}`}
                </button>
              )}
              {loggedIn && <Balance credits={ready ? econ.credits : null} freeRolls={ready ? econ.freeRolls : null} />}
            </div>

            <ul className='sp-notes'>
              {mode === 'free' ? (
                <>
                  <li>Item wins are plain — no Unusual, Strange or Killstreak.</li>
                  <li>
                    A <TicketGlyph size={14} /> free roll opens any standard case.
                  </li>
                </>
              ) : (
                <>
                  <li>Any number of spins per day. Duplicates are possible — salvage or sell them.</li>
                  <li>Relic is the top prize; Unobtainables stay Vault-only.</li>
                </>
              )}
              <li>The server picks the result before the wheel moves. Credits are earned in play, never bought.</li>
            </ul>
          </div>
        </section>

        <div className='ec-rates sp-odds'>
          <div>
            <h4 className='ec-section !mt-0'>Daily wheel odds <small>fixed · same for everyone</small></h4>
            <table className='ec-table' aria-label='Free spin odds'>
              <tbody>
                {info.free.map((s, i) => (
                  <tr key={s.id}>
                    <th scope='row'>
                      <span className='ec-dot' style={{ background: free[i]?.edge }} />
                      {s.label}
                    </th>
                    <td className='w-full'>
                      <span className='ec-bar' aria-hidden>
                        <i style={{ width: `${Math.max(1.5, Math.min(100, s.odds * 100 * 2.6))}%`, background: free[i]?.edge }} />
                      </span>
                    </td>
                    <td className='ec-num'>{pct(s.odds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className='mt-2 font-sans text-[12px] text-white/45'>Item wins pick one item of that tier evenly from the wheel’s pool.</p>
          </div>
          <div>
            <h4 className='ec-section !mt-0'>Premium wheel odds <small>{fmtCredits(cost)} per spin</small></h4>
            <table className='ec-table' aria-label='Premium spin odds'>
              <tbody>
                {TIERS.filter((t) => info.premiumOdds[t] > 0).map((t) => (
                  <tr key={t}>
                    <th scope='row'>
                      <span className={`ec-dot ${isIridescent(t) ? 'ec-iri-bg' : ''}`} style={isIridescent(t) ? undefined : { background: TIER_COLOR[t].edge }} />
                      {TIER_LABEL[t]}
                    </th>
                    <td className='w-full'>
                      <span className='ec-bar' aria-hidden>
                        <i style={{ width: `${Math.max(1.5, Math.min(100, info.premiumOdds[t] * 100 * 1.8))}%`, background: TIER_COLOR[t].edge }} />
                      </span>
                    </td>
                    <td className='ec-num'>{pct(info.premiumOdds[t])}</td>
                    <td className='ec-num text-white/45'>{info.pool[t]} item{info.pool[t] === 1 ? '' : 's'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className='mt-2 font-sans text-[12px] text-white/45'>Each spin picks a tier, then one item of that tier evenly. Qualities (Unusual, Strange, Killstreak) roll at case rates.</p>
          </div>
        </div>
        <p className='sp-nopity'>No pity — fixed published rates.</p>
      </div>

      {reveal && (
        <SpinReveal
          key={reveal.key}
          win={reveal.win}
          kind={reveal.kind}
          reduced={reduced}
          credits={econ.credits}
          cost={cost}
          canAgain={econ.credits >= cost}
          onAgain={() => {
            setReveal(null);
            void spin('premium');
          }}
          onEquip={(it) => onEquipItem(it)}
          onClose={() => setReveal(null)}
        />
      )}
    </div>
  );
}
