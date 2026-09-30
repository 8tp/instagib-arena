// Read-only metric tabs of the admin console: Overview, Engagement, Economy,
// Retention. Data: server/db.ts (overview, retention, weekly challenge) and
// server/admin-metrics.ts (engagement, economy, cohorts, concurrency).
import { itemDef } from '../game/items/catalog';
import { CASES, TIER_META, type Tier } from '../game/items/types';
import { SLOT_LABEL } from '../economy/display';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR } from '../ui/rarity';
import { useLoad, type Cohort, type Concurrency, type EconomyMetrics, type EngagementMetrics, type LiveCounts, type Overview, type WeekCohort, type WeeklyChallengeStats } from './api';
import { BarList, Columns, Legend, LineChart } from './charts';
import { MODE_LABEL, SERIES } from './palette';
import { change, compact, dayLabel, fmt, fmtBytes, fmtClear, pct } from './format';
import { TierDot } from './ItemPicker';
import { Cr, Empty, ErrorState, Loading, Plate, StatTile } from './ui';

// Colour follows the mode (never its rank), so filters never repaint a mode.
const MODE_COLOR: Record<string, string> = { ffa: SERIES[0], duel: SERIES[1], tdm: SERIES[2], ranked: SERIES[3], practice: SERIES[4], unknown: SERIES[6] };
const modeColor = (m: string) => MODE_COLOR[m] ?? SERIES[6];
const CASE_COLOR: Record<string, string> = Object.fromEntries(CASES.map((c, i) => [c.id, SERIES[i]]));
const ORIGIN_TEXT: Record<string, string> = { case: 'Case opens', road: 'Career Road', code: 'Codes', gift: 'Gifts', admin: 'Staff mints', challenge: 'Challenges', founder: 'Founder', title: 'Titles', spin: 'Daily spin', market: 'Market', trade: 'Trades', legacy: 'Legacy' };

const vsLabel = (days: number) => `vs previous ${days} days`;

function Grid({ children, cols = 'md:grid-cols-3 xl:grid-cols-6' }: { children: React.ReactNode; cols?: string }) {
  return <div className={`grid grid-cols-2 gap-3 ${cols}`}>{children}</div>;
}

function Loaded<T>({ load, children, rows = 4 }: { load: ReturnType<typeof useLoad<T>>; children: (d: T) => React.ReactNode; rows?: number }) {
  if (load.state === 'loading') return <Loading rows={rows} />;
  if (load.state === 'error') return <ErrorState message={load.message} onRetry={load.retry} />;
  return <>{children(load.data)}</>;
}

// ── Overview ────────────────────────────────────────────────────────────────
export function OverviewTab({ days, live, onOpen }: { days: number; live: LiveCounts | null; onOpen: (tab: 'engagement' | 'economy') => void }) {
  const ov = useLoad(`/api/admin/metrics/overview`, (r) => (r as { overview: Overview }).overview);
  const eng = useLoad(`/api/admin/metrics/engagement?days=${days}`, (r) => (r as { engagement: EngagementMetrics }).engagement);
  const eco = useLoad(`/api/admin/metrics/economy?days=${days}`, (r) => (r as { economy: EconomyMetrics }).economy);
  const conc = useLoad(`/api/admin/metrics/concurrency`, (r) => (r as { concurrency: Concurrency }).concurrency);
  const e = eng.state === 'ok' ? eng.data : null;
  const peak = conc.state === 'ok' ? conc.data.peak24h : null;

  return (
    <div className='flex flex-col gap-5'>
      <Grid>
        <StatTile accent label='Online now' value={live ? fmt(live.online) : '—'} sub={live ? `${fmt(live.inMatch)} in a match · ${fmt(live.rooms)} rooms` : 'connecting…'} />
        <StatTile label='Peak online · 24h' value={peak ? fmt(peak.online) : '—'} sub={peak ? `at ${new Date(peak.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'sampling since deploy'} />
        <StatTile label='Daily active' value={e ? fmt(e.dau) : '—'} sub={e ? `${pct(e.mau ? e.dau / e.mau : 0)} of monthly · stickiness` : undefined} spark={e?.series.map((d) => d.dau)} />
        <StatTile label='Monthly active' value={e ? fmt(e.mau) : '—'} sub={e ? `${fmt(e.wau)} weekly active` : undefined} />
        <StatTile label={`Matches · ${days}d`} value={e ? compact(e.cur.matches) : '—'} delta={e ? change(e.cur.matches, e.prev.matches) : undefined} vs={vsLabel(days)} spark={e?.series.map((d) => d.matches)} />
        <StatTile label={`New accounts · ${days}d`} value={e ? fmt(e.cur.newAccounts) : '—'} delta={e ? change(e.cur.newAccounts, e.prev.newAccounts) : undefined} vs={vsLabel(days)} spark={e?.series.map((d) => d.newAccounts)} />
      </Grid>

      <div className='grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]'>
        <Plate
          title='Daily active players'
          sub='Accounts that played or signed in, per UTC day'
          right={
            <button type='button' className='adm-btn sm' onClick={() => onOpen('engagement')}>
              Engagement →
            </button>
          }
        >
          <Loaded load={eng}>{(d) => <LineChart labels={d.series.map((p) => p.date)} series={[{ key: 'dau', label: 'Daily active', color: SERIES[0], points: d.series.map((p) => p.dau) }]} height={240} />}</Loaded>
        </Plate>
        <Plate
          title='Economy pulse'
          sub={`Last ${days} days, ${vsLabel(days)}`}
          right={
            <button type='button' className='adm-btn sm' onClick={() => onOpen('economy')}>
              Economy →
            </button>
          }
        >
          <Loaded load={eco}>
            {(x) => {
              const net = x.cur.faucet - x.cur.sink;
              return (
                <div className='grid grid-cols-2 gap-3'>
                  <StatTile label='Credits held' value={<Cr n={compact(x.held.credits)} />} sub={`${fmt(x.held.holders)} holders`} />
                  <StatTile label='Net credit flow' value={`${net >= 0 ? '+' : '−'}${compact(Math.abs(net))}`} sub={net >= 0 ? 'more minted than burned' : 'more burned than minted'} />
                  <StatTile label='Case opens' value={compact(x.cur.caseOpens)} delta={change(x.cur.caseOpens, x.prev.caseOpens)} vs={vsLabel(days)} />
                  <StatTile label='Market volume' value={<Cr n={compact(x.cur.marketVolume)} />} delta={change(x.cur.marketVolume, x.prev.marketVolume)} vs={vsLabel(days)} />
                </div>
              );
            }}
          </Loaded>
        </Plate>
      </div>

      <div className='grid items-start gap-5 xl:grid-cols-2'>
        <Plate title='All time'>
          <Loaded load={ov} rows={2}>
            {(o) => (
              <dl className='grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4'>
                {(
                  [
                    ['Accounts', fmt(o.totalAccounts), `${fmt(o.playersWithGames)} have played`],
                    ['Matches recorded', compact(o.totalMatches), `${compact(o.onlineMatches)} online`],
                    ['Kills', compact(o.totalKills), `${compact(o.totalDeaths)} deaths`],
                    ['Rail accuracy', `${o.globalAccuracy}%`, 'hits / shots'],
                    ['XP awarded', compact(o.totalXp), ''],
                    ['Avg player lifetime', `${o.avgLifetimeDays}d`, 'first → last seen'],
                    ['Logins · 30d', compact(o.windows.month.logins), `${fmt(o.windows.day.logins)} in 24h`],
                    ['Active · 7d', fmt(o.windows.week.activePlayers), `${fmt(o.windows.week.matches)} matches`],
                  ] as const
                ).map(([k, v, s]) => (
                  <div key={k} className='min-w-0'>
                    <dt className='text-[12px] text-[var(--adm-ink-3)]'>{k}</dt>
                    <dd className='mt-0.5 text-[20px] font-semibold text-[var(--adm-ink)]'>{v}</dd>
                    {s && <dd className='truncate text-[12px] text-[var(--adm-ink-3)]'>{s}</dd>}
                  </div>
                ))}
              </dl>
            )}
          </Loaded>
        </Plate>
        <WeeklyChallengePanel />
      </div>
    </div>
  );
}

function WeeklyChallengePanel() {
  const w = useLoad(`/api/admin/metrics/weekly`, (r) => (r as { weekly: WeeklyChallengeStats }).weekly);
  return (
    <Plate title='Weekly challenge' sub={w.state === 'ok' ? `${w.data.week} · ${w.data.map} · first to ${w.data.fragLimit}` : undefined}>
      <Loaded load={w} rows={2}>
        {(x) => (
          <div className='grid grid-cols-2 gap-3'>
            <StatTile label='Participants' value={fmt(x.participants)} sub={`${fmt(x.runs)} runs`} />
            <StatTile label='Beat the bots' value={fmt(x.winners)} sub={x.participants ? `${pct(x.winners / x.participants)} of entrants` : 'no entrants yet'} />
            <StatTile label='Fastest clear' value={fmtClear(x.bestTimeMs)} sub={x.winners ? 'this week' : 'no winner yet'} />
            <StatTile label='Replays stored' value={fmt(x.replaysStored)} sub={fmtBytes(x.replayBytes)} />
          </div>
        )}
      </Loaded>
    </Plate>
  );
}

// ── Engagement ──────────────────────────────────────────────────────────────
export function EngagementTab({ days }: { days: number }) {
  const eng = useLoad(`/api/admin/metrics/engagement?days=${days}`, (r) => (r as { engagement: EngagementMetrics }).engagement);
  const conc = useLoad(`/api/admin/metrics/concurrency`, (r) => (r as { concurrency: Concurrency }).concurrency);
  if (eng.state !== 'ok') return <Plate>{eng.state === 'loading' ? <Loading rows={6} /> : <ErrorState message={eng.message} onRetry={eng.retry} />}</Plate>;
  const e = eng.data;
  const labels = e.series.map((p) => p.date);
  const modes = e.modes.map((m) => m.mode);
  const vs = vsLabel(days);
  return (
    <div className='flex flex-col gap-5'>
      <Grid>
        <StatTile accent label={`Active players · ${days}d`} value={fmt(e.cur.players)} delta={change(e.cur.players, e.prev.players)} vs={vs} />
        <StatTile label={`Matches · ${days}d`} value={compact(e.cur.matches)} delta={change(e.cur.matches, e.prev.matches)} vs={vs} />
        <StatTile label='Matches per active player' value={e.cur.players ? (e.cur.matches / e.cur.players).toFixed(1) : '—'} sub={`prev ${e.prev.players ? (e.prev.matches / e.prev.players).toFixed(1) : '—'}`} />
        <StatTile label='Online share' value={e.cur.matches ? pct(e.cur.onlineMatches / e.cur.matches) : '—'} sub='of matches vs practice' />
        <StatTile label='Guest share' value={e.cur.matches ? pct(e.cur.guestMatches / e.cur.matches) : '—'} sub={`${fmt(e.cur.guestMatches)} guest matches`} />
        <StatTile label={`Logins · ${days}d`} value={compact(e.cur.logins)} delta={change(e.cur.logins, e.prev.logins)} vs={vs} />
      </Grid>

      <Plate title='Daily active players' sub='Accounts that played or signed in, per UTC day'>
        <div className='-mt-1 mb-3 text-[12px] text-[var(--adm-ink-2)]'>
          DAU {fmt(e.dau)} · WAU {fmt(e.wau)} · MAU {fmt(e.mau)} · stickiness <b className='text-[var(--adm-ink)]'>{e.mau ? pct(e.dau / e.mau) : '—'}</b>
        </div>
        <LineChart labels={labels} series={[{ key: 'dau', label: 'Daily active', color: SERIES[0], points: e.series.map((p) => p.dau) }]} height={220} />
      </Plate>

      <Plate title='Matches per day by mode' right={<Legend items={modes.map((m) => ({ label: MODE_LABEL[m] ?? m, color: modeColor(m) }))} />}>
        <Columns labels={labels} series={modes.map((m) => ({ key: m, label: MODE_LABEL[m] ?? m, color: modeColor(m) }))} rows={e.series.map((p) => p.modes)} height={240} />
      </Plate>

      <div className='grid gap-5 lg:grid-cols-2'>
        <Plate title='What’s being played' sub={`Share of ${fmt(e.cur.matches)} matches`}>
          {e.modes.length === 0 ? (
            <Empty title='No matches in this range.' />
          ) : (
            <BarList rows={e.modes.map((m) => ({ key: m.mode, label: MODE_LABEL[m.mode] ?? m.mode, value: m.n, color: modeColor(m.mode) }))} format={(n) => `${fmt(n)} · ${pct(n / Math.max(1, e.cur.matches))}`} />
          )}
        </Plate>
        <Plate title='When people play' sub='Matches by hour of day (UTC)'>
          <Columns
            labels={e.hours.map((_, h) => String(h).padStart(2, '0'))}
            xLabel={(s) => `${s}:00`}
            series={[{ key: 'n', label: 'Matches', color: SERIES[0] }]}
            rows={e.hours.map((n) => ({ n }))}
            height={200}
          />
        </Plate>
      </div>

      <div className='grid gap-5 lg:grid-cols-2'>
        <Plate title='Concurrent players · 24h' sub='Sampled every minute in memory — resets when the server deploys'>
          <Loaded load={conc} rows={3}>
            {(c) =>
              c.samples.length < 2 ? (
                <Empty title='Not enough samples yet.'>The server records one sample a minute since it started.</Empty>
              ) : (
                <>
                  <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
                    <Legend
                      line
                      items={[
                        { label: 'Online', color: SERIES[0] },
                        { label: 'In a match', color: SERIES[2] },
                      ]}
                    />
                    <span className='text-[12px] text-[var(--adm-ink-2)]'>Peak {c.peak24h ? fmt(c.peak24h.online) : '—'} · since deploy {c.peak ? fmt(c.peak.online) : '—'}</span>
                  </div>
                  <LineChart
                    labels={c.samples.map((s) => String(s.ts))}
                    xLabel={(s) => new Date(Number(s)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    series={[
                      { key: 'online', label: 'Online', color: SERIES[0], points: c.samples.map((s) => s.online) },
                      { key: 'inMatch', label: 'In a match', color: SERIES[2], points: c.samples.map((s) => s.inMatch) },
                    ]}
                    area={false}
                    height={200}
                  />
                </>
              )
            }
          </Loaded>
        </Plate>
        <Plate title='New accounts per day'>
          <Columns labels={labels} series={[{ key: 'n', label: 'New accounts', color: SERIES[2] }]} rows={e.series.map((p) => ({ n: p.newAccounts }))} height={228} />
        </Plate>
      </div>

      <Plate title={`Most active players · ${days}d`} flush>
        {e.topPlayers.length === 0 ? (
          <Empty title='No account matches in this range.' />
        ) : (
          <div className='adm-scroll'>
            <table className='adm-table'>
              <thead>
                <tr>
                  <th className='num'>#</th>
                  <th>Player</th>
                  <th className='num'>Matches</th>
                  <th className='num'>Wins</th>
                  <th className='num'>Win rate</th>
                  <th className='num'>Kills</th>
                  <th className='num'>K/D</th>
                </tr>
              </thead>
              <tbody>
                {e.topPlayers.map((p, i) => (
                  <tr key={p.id}>
                    <td className='num'>{i + 1}</td>
                    <td className='strong'>{p.name}</td>
                    <td className='num'>{fmt(p.matches)}</td>
                    <td className='num'>{fmt(p.wins)}</td>
                    <td className='num'>{pct(p.wins / Math.max(1, p.matches))}</td>
                    <td className='num'>{fmt(p.kills)}</td>
                    <td className='num'>{p.deaths ? (p.kills / p.deaths).toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Plate>
    </div>
  );
}

// ── Economy ─────────────────────────────────────────────────────────────────
export function EconomyTab({ days }: { days: number }) {
  const eco = useLoad(`/api/admin/metrics/economy?days=${days}`, (r) => (r as { economy: EconomyMetrics }).economy);
  if (eco.state !== 'ok') return <Plate>{eco.state === 'loading' ? <Loading rows={6} /> : <ErrorState message={eco.message} onRetry={eco.retry} />}</Plate>;
  const x = eco.data;
  const labels = x.series.map((p) => p.date);
  const vs = vsLabel(days);
  const net = x.cur.faucet - x.cur.sink;
  const prevNet = x.prev.faucet - x.prev.sink;
  const caseIds = CASES.map((c) => c.id as string).concat(Object.keys(x.series.reduce<Record<string, 1>>((m, d) => (Object.keys(d.cases).forEach((k) => (m[k] = 1)), m), {})).filter((k) => !CASES.some((c) => c.id === k)));
  const tierRows = (rows: { tier: Tier; n: number }[]) =>
    rows.filter((r) => r.n > 0).reverse().map((r) => ({ key: r.tier, label: <span className='inline-flex items-center gap-2'><TierDot tier={r.tier} />{TIER_META[r.tier].label}</span>, value: r.n, color: TIER_META[r.tier].color }));
  return (
    <div className='flex flex-col gap-5'>
      <div className='flex flex-col gap-2'>
        <span className='adm-section-label'>Held right now</span>
        <Grid>
          <StatTile accent label='Credits in circulation' value={<Cr n={compact(x.held.credits)} />} sub={`${fmt(x.held.holders)} accounts hold credits`} />
          <StatTile label='Free rolls unspent' value={fmt(x.held.rolls)} />
          <StatTile label='Items in circulation' value={compact(x.held.items)} sub={`${fmt(x.held.listed)} listed on the market`} />
          <StatTile label='Anomalous items' value={fmt(x.held.anomalous)} sub={x.held.items ? `${pct(x.held.anomalous / x.held.items, 1)} of items` : undefined} />
          <StatTile label='Tracked items' value={fmt(x.held.tracked)} sub={`${fmt(x.held.killstreak)} killstreak · ${fmt(x.held.festive)} festive`} />
          <StatTile label='Staff one-offs' value={fmt(x.held.staffMade)} sub='custom name / tint / tier' />
        </Grid>
      </div>

      <div className='flex flex-col gap-2'>
        <span className='adm-section-label'>Flows · last {days} days</span>
        <Grid>
          <StatTile label='Credits created' value={<Cr n={compact(x.cur.faucet)} />} delta={change(x.cur.faucet, x.prev.faucet)} good='none' vs={vs} spark={x.series.map((d) => d.faucet)} />
          <StatTile label='Credits removed' value={<Cr n={compact(x.cur.sink)} />} delta={change(x.cur.sink, x.prev.sink)} good='none' vs={vs} spark={x.series.map((d) => d.sink)} />
          <StatTile label='Net flow' value={`${net >= 0 ? '+' : '−'}${compact(Math.abs(net))}`} sub={`prev ${prevNet >= 0 ? '+' : '−'}${compact(Math.abs(prevNet))}`} />
          <StatTile label='Case opens' value={compact(x.cur.caseOpens)} delta={change(x.cur.caseOpens, x.prev.caseOpens)} vs={vs} spark={x.series.map((d) => d.caseOpens)} />
          <StatTile label='Market volume' value={<Cr n={compact(x.cur.marketVolume)} />} delta={change(x.cur.marketVolume, x.prev.marketVolume)} vs={vs} sub={`${fmt(x.cur.marketSales)} sales · ⛁ ${compact(x.cur.saleTax)} tax`} />
          <StatTile label='Trades completed' value={fmt(x.cur.trades)} delta={change(x.cur.trades, x.prev.trades)} vs={vs} />
        </Grid>
      </div>

      <Plate
        title='Credits created vs removed'
        sub='Per UTC day. Created = match payouts (estimated from XP) + salvage + codes & gifts + staff grants. Removed = case opens + listing fees + sale tax.'
        right={
          <Legend
            line
            items={[
              { label: 'Created', color: SERIES[0] },
              { label: 'Removed', color: SERIES[1] },
            ]}
          />
        }
      >
        <LineChart
          labels={labels}
          format={(n) => `⛁ ${fmt(n)}`}
          series={[
            { key: 'faucet', label: 'Created', color: SERIES[0], points: x.series.map((d) => d.faucet) },
            { key: 'sink', label: 'Removed', color: SERIES[1], points: x.series.map((d) => d.sink) },
          ]}
          height={240}
        />
      </Plate>

      <div className='grid gap-5 lg:grid-cols-2'>
        <Plate title='Where credits come from' sub={`⛁ ${fmt(x.cur.faucet)} created`}>
          <BarList
            format={(n) => `⛁ ${compact(n)}`}
            max={Math.max(x.cur.faucet, x.cur.sink, 1)}
            rows={[
              { key: 'match', label: 'Match payouts (est.)', value: x.cur.matchPayout, note: 'floor(match XP × 0.1) per account match' },
              { key: 'salvage', label: 'Salvage', value: x.cur.salvage },
              { key: 'rewards', label: 'Codes & gifts', value: x.cur.rewards },
              { key: 'grants', label: 'Staff grants', value: x.cur.grants },
            ]}
          />
        </Plate>
        <Plate title='Where credits go' sub={`⛁ ${fmt(x.cur.sink)} removed`}>
          <BarList
            format={(n) => `⛁ ${compact(n)}`}
            color={SERIES[1]}
            max={Math.max(x.cur.faucet, x.cur.sink, 1)}
            rows={[
              { key: 'cases', label: 'Case opens', value: x.cur.caseSpend },
              { key: 'fees', label: 'Listing fees', value: x.cur.listingFees },
              { key: 'tax', label: 'Sale tax', value: x.cur.saleTax },
            ]}
          />
        </Plate>
      </div>

      <Plate title='Case opens per day' right={<Legend items={caseIds.map((id) => ({ label: CASES.find((c) => c.id === id)?.name ?? id, color: CASE_COLOR[id] ?? SERIES[6] }))} />}>
        <Columns labels={labels} series={caseIds.map((id) => ({ key: id, label: CASES.find((c) => c.id === id)?.name ?? id, color: CASE_COLOR[id] ?? SERIES[6] }))} rows={x.series.map((d) => d.cases)} height={230} />
      </Plate>

      <div className='grid gap-5 lg:grid-cols-3'>
        <Plate title='Minted by tier' sub={`${fmt(x.cur.minted)} items in ${days} days`}>
          {x.cur.minted ? <BarList rows={tierRows(x.mintedByTier)} /> : <Empty title='Nothing minted in this range.' />}
        </Plate>
        <Plate title='Minted by source'>
          {x.mintedByOrigin.length ? <BarList rows={x.mintedByOrigin.map((o) => ({ key: o.origin, label: ORIGIN_TEXT[o.origin] ?? o.origin, value: o.n }))} /> : <Empty title='Nothing minted in this range.' />}
        </Plate>
        <Plate title='Held by tier' sub={`${fmt(x.held.items)} items owned or listed`}>
          {x.held.items ? <BarList rows={tierRows(x.heldByTier)} /> : <Empty title='No items yet.' />}
        </Plate>
      </div>

      <div className='grid items-start gap-5 lg:grid-cols-2'>
        <Plate title='Market activity' sub='Sales volume per day'>
          <Columns labels={labels} format={(n) => `⛁ ${fmt(n)}`} series={[{ key: 'v', label: 'Volume', color: SERIES[2] }]} rows={x.series.map((d) => ({ v: d.marketVolume }))} height={220} />
        </Plate>
        <Plate title='Most held items' flush>
          {x.topHeld.length === 0 ? (
            <Empty title='No items yet.' />
          ) : (
            <div className='adm-scroll'>
              <table className='adm-table'>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Slot</th>
                    <th className='num'>Held</th>
                    <th className='num'>Anomalous</th>
                  </tr>
                </thead>
                <tbody>
                  {x.topHeld.slice(0, 8).map((h) => {
                    const d = itemDef(h.def);
                    return (
                      <tr key={h.def}>
                        <td>
                          <span className='flex items-center gap-2.5'>
                            <ItemTile id={h.def} size={32} label={false} season={false} tier={d?.tier} />
                            <span className='truncate font-medium' style={{ color: d ? TIER_COLOR[d.tier].text : undefined }}>
                              {d?.name ?? h.def}
                            </span>
                          </span>
                        </td>
                        <td>{d ? SLOT_LABEL[d.slot] : '—'}</td>
                        <td className='num'>{fmt(h.n)}</td>
                        <td className='num'>{h.anomalous ? fmt(h.anomalous) : <span className='text-[var(--adm-ink-3)]'>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Plate>
      </div>
    </div>
  );
}

// ── Retention ───────────────────────────────────────────────────────────────
export function RetentionTab() {
  const daily = useLoad(`/api/admin/metrics/retention?days=28`, (r) => (r as { cohorts: Cohort[] }).cohorts);
  const weekly = useLoad(`/api/admin/metrics/cohorts?weeks=8`, (r) => (r as { cohorts: WeekCohort[] }).cohorts);
  const eligible = daily.state === 'ok' ? daily.data.filter((c) => c.size > 0) : [];
  const size = eligible.reduce((s, c) => s + c.size, 0);
  // Rates only over cohorts whose window has fully elapsed (an open window
  // would read as churn).
  const d1Done = eligible.filter((c) => windowClosed(c.date, 1));
  const d7Done = eligible.filter((c) => windowClosed(c.date, 7));
  const d1Base = d1Done.reduce((s, c) => s + c.size, 0);
  const d7Base = d7Done.reduce((s, c) => s + c.size, 0);
  const d1 = d1Done.reduce((s, c) => s + c.d1, 0);
  const d7 = d7Done.reduce((s, c) => s + c.d7, 0);
  // W1: of cohorts whose week 1 has finished, the share active in it.
  const w = weekly.state === 'ok' ? weekly.data : [];
  const w1Done = w.filter((c) => c.active.length > 2);
  const w1base = w1Done.reduce((s, c) => s + c.size, 0);
  const w1 = w1Done.reduce((s, c) => s + c.active[1], 0);
  return (
    <div className='flex flex-col gap-5'>
      <Grid cols='md:grid-cols-4'>
        <StatTile accent label='New players · 28d' value={fmt(size)} sub={`${fmt(eligible.length)} days with signups`} />
        <StatTile label='Day-1 retention' value={d1Base ? pct(d1 / d1Base) : '—'} sub={`${fmt(d1)} of ${fmt(d1Base)} came back the next day`} />
        <StatTile label='Day-7 retention' value={d7Base ? pct(d7 / d7Base) : '—'} sub={`${fmt(d7)} of ${fmt(d7Base)} came back within a week`} />
        <StatTile label='Week-1 retention' value={w1base ? pct(w1 / w1base) : '—'} sub='active in their second week (finished weeks)' />
      </Grid>

      <Plate
        title='Weekly cohorts'
        sub='Each row is the accounts that signed up that week. Each cell is the share that played a match or signed in during week N after signup. W0 is the signup week itself, so accounts that registered and never played count as inactive there. Outlined cells are the current, unfinished week.'
      >
        {weekly.state === 'loading' ? <Loading /> : weekly.state === 'error' ? <ErrorState message={weekly.message} onRetry={weekly.retry} /> : <CohortGrid cohorts={w} />}
      </Plate>

      <Plate title='By signup day' flush>
        {daily.state === 'loading' ? (
          <div className='px-4 pb-4'>
            <Loading />
          </div>
        ) : daily.state === 'error' ? (
          <ErrorState message={daily.message} onRetry={daily.retry} />
        ) : eligible.length === 0 ? (
          <Empty title='No signups in the last 28 days.' />
        ) : (
          <div className='adm-scroll max-h-[520px]'>
            <table className='adm-table'>
              <thead>
                <tr>
                  <th>Signup day</th>
                  <th className='num'>New</th>
                  <th>Day 1</th>
                  <th>Day 7</th>
                </tr>
              </thead>
              <tbody>
                {eligible
                  .slice()
                  .reverse()
                  .map((c) => (
                    <tr key={c.date}>
                      <td className='strong'>{dayLabel(c.date)}</td>
                      <td className='num'>{fmt(c.size)}</td>
                      <td>
                        <RetentionBar value={c.d1} total={c.size} open={!windowClosed(c.date, 1)} />
                      </td>
                      <td>
                        <RetentionBar value={c.d7} total={c.size} open={!windowClosed(c.date, 7)} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Plate>
    </div>
  );
}

// A signup day D's day-N window ([signup + 1d, signup + (N+1)d)) has closed for
// every account in the cohort once the day after D plus N+1 days has started.
function windowClosed(isoDay: string, n: 1 | 7, now = Date.now()): boolean {
  const start = Date.parse(`${isoDay}T00:00:00Z`);
  return now >= start + (n + 2) * 86_400_000;
}

function RetentionBar({ value, total, open }: { value: number; total: number; open?: boolean }) {
  const frac = total > 0 ? value / total : 0;
  if (open)
    return (
      <span className='font-mono text-[12px] text-[var(--adm-ink-3)]' title='This window hasn’t finished yet'>
        — <span className='font-sans'>still open</span>
      </span>
    );
  return (
    <div className='flex items-center gap-3'>
      <div className='h-2 w-28 bg-[var(--adm-line)]'>
        <div className='h-full' style={{ width: `${frac * 100}%`, background: SERIES[0], borderRadius: '0 3px 3px 0' }} />
      </div>
      <span className='font-mono text-[12px] tabular-nums text-[var(--adm-ink-2)]'>
        {pct(frac)} <span className='text-[var(--adm-ink-3)]'>
          ({value}/{total})
        </span>
      </span>
    </div>
  );
}

// Ink on a cohort cell: the cell is rail cyan at alpha `a` over the plate, so
// pick dark text once that blend is light enough (WCAG relative luminance).
const lin = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
function cellIsLight(a: number): boolean {
  const mix = (fg: number, bg: number) => fg * a + bg * (1 - a);
  const L = 0.2126 * lin(mix(91, 12)) + 0.7152 * lin(mix(227, 16)) + 0.0722 * lin(mix(255, 22));
  // Contrast vs white ((1.05)/(L+.05)) and vs #041016 ((L+.05)/(~0.055)): dark wins above L ≈ 0.18.
  return L > 0.18;
}

// Sequential single-hue heat (rail cyan): 0 = surface, 100% = full.
function CohortGrid({ cohorts }: { cohorts: WeekCohort[] }) {
  const weeks = cohorts.length;
  if (!cohorts.some((c) => c.size > 0)) return <Empty title='No signups in the last 8 weeks.' />;
  return (
    <div className='adm-scroll'>
      <table className='w-full border-separate text-[12px]' style={{ borderSpacing: 2 }}>
        <thead>
          <tr className='text-[var(--adm-ink-3)]'>
            <th className='px-2 py-1 text-left font-medium'>Week of</th>
            <th className='px-2 py-1 text-right font-medium'>Signups</th>
            {Array.from({ length: weeks }, (_, k) => (
              <th key={k} className='px-1 py-1 text-center font-medium'>
                W{k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.start}>
              <td className='whitespace-nowrap px-2 py-1 text-[var(--adm-ink-2)]'>{dayLabel(c.start)}</td>
              <td className='px-2 py-1 text-right font-mono text-[var(--adm-ink)]'>{fmt(c.size)}</td>
              {Array.from({ length: weeks }, (_, k) => {
                if (k >= c.active.length) return <td key={k} />;
                const v = c.size ? c.active[k] / c.size : 0;
                const a = 0.06 + v * 0.74;
                const current = k === c.active.length - 1; // the week in progress
                return (
                  <td
                    key={k}
                    className='h-8 min-w-[52px] text-center font-mono tabular-nums'
                    style={{
                      background: c.size ? `rgba(91, 227, 255, ${a.toFixed(3)})` : 'transparent',
                      color: c.size && cellIsLight(a) ? '#041016' : 'var(--adm-ink)',
                      outline: current ? '1px dashed var(--adm-ink-3)' : undefined,
                      outlineOffset: -3,
                    }}
                    title={`${fmt(c.active[k])} of ${fmt(c.size)} active in week ${k}${current ? ' (week still in progress)' : ''}`}
                  >
                    {c.size ? pct(v) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
