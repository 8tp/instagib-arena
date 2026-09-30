// Hand-rolled SVG charts for the admin console (no charting dependency).
// Rendered at the container's real pixel width (ResizeObserver) so text never
// scales. Marks follow one spec: 2px lines, ≤ 24px columns with a 4px rounded
// cap and a 2px surface gap between stacked segments, hairline recessive grid,
// a crosshair + tooltip on hover. Colour = identity only; text stays in ink.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { compact, dayLabel, fmt } from './format';
import { SERIES } from './palette';
const SURFACE = '#0c1016';
const GRID = '#1b2430';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// 0-based "nice" ticks: 0, step, 2·step … ≥ max (4–5 ticks).
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // Counts never get fractional ticks (0, 0.5, 1 would round to 0, 1, 1).
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw);
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// Which x labels to print: first, last and a few evenly spaced in between.
function xTickIdx(n: number, width: number): number[] {
  if (n <= 1) return [0];
  const slots = Math.max(2, Math.min(n, Math.floor(width / 90)));
  const out = new Set<number>();
  for (let i = 0; i < slots; i++) out.add(Math.round((i / (slots - 1)) * (n - 1)));
  return [...out];
}

export type Series = { key: string; label: string; color: string; points: number[] };

type TipRow = { label: string; color: string; value: string; line?: boolean };
function Tip({ x, width, title, rows, total }: { x: number; width: number; title: string; rows: TipRow[]; total?: string }) {
  const left = Math.min(Math.max(0, x + 14), Math.max(0, width - 170));
  return (
    <div className='adm-tip' style={{ left, top: 4 }} role='status'>
      <div className='mb-1 text-[11px] text-[var(--adm-ink-2)]'>{title}</div>
      {rows.map((r) => (
        <div key={r.label} className='adm-tip-row'>
          <span className={`adm-key ${r.line ? 'line' : ''}`} style={{ background: r.color }} />
          <span className='text-[var(--adm-ink-2)]'>{r.label}</span>
          <span className='v'>{r.value}</span>
        </div>
      ))}
      {total && (
        <div className='adm-tip-row mt-1 border-t border-[var(--adm-line-2)] pt-1'>
          <span className='text-[var(--adm-ink-2)]'>Total</span>
          <span className='v'>{total}</span>
        </div>
      )}
    </div>
  );
}

export function Legend({ items, line = false }: { items: { label: string; color: string }[]; line?: boolean }) {
  return (
    <div className='adm-legend'>
      {items.map((it) => (
        <span key={it.label}>
          <span className={`adm-key ${line ? 'line' : ''}`} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

const PAD = { l: 44, r: 12, t: 10, b: 24 };

// Multi-series line chart on ONE y-axis (same unit only — never dual-axis).
export function LineChart({
  labels,
  series,
  height = 220,
  format = fmt,
  area = true,
  xLabel = dayLabel,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  format?: (n: number) => string;
  area?: boolean;
  xLabel?: (s: string) => string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = Math.max(0, ...series.flatMap((s) => s.points));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const iw = Math.max(1, W - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + (1 - v / top) * ih;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / r.width) * (n - 1)))));
  };
  return (
    <div ref={ref} className='adm-chart' style={{ height }}>
      {W > 0 && (
        <svg width={W} height={height} role='img' aria-label={`${series.map((s) => s.label).join(', ')} over ${n} days`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text className='axis' x={PAD.l - 8} y={y(t) + 4} textAnchor='end'>
                {compact(t)}
              </text>
            </g>
          ))}
          {xTickIdx(n, iw).map((i) => (
            <text key={i} className='axis' x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {labels[i] ? xLabel(labels[i]) : ''}
            </text>
          ))}
          {series.map((s) => {
            const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join('');
            return (
              <g key={s.key}>
                {area && n > 1 && <path d={`${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`} fill={s.color} opacity={0.1} />}
                <path d={d} fill='none' stroke={s.color} strokeWidth={2} strokeLinejoin='round' strokeLinecap='round' />
                {n > 0 && <circle cx={x(n - 1)} cy={y(s.points[n - 1] ?? 0)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />}
              </g>
            );
          })}
          {hover != null && (
            <g pointerEvents='none'>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} stroke='#3a4859' strokeWidth={1} />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.points[hover] ?? 0)} r={4.5} fill={s.color} stroke={SURFACE} strokeWidth={2} />
              ))}
            </g>
          )}
          <rect x={PAD.l} y={0} width={iw} height={height} fill='transparent' onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover != null && W > 0 && (
        <Tip
          x={x(hover)}
          width={W}
          title={labels[hover] ? xLabel(labels[hover]) : ''}
          rows={series.map((s) => ({ label: s.label, color: s.color, value: format(s.points[hover] ?? 0), line: true }))}
        />
      )}
    </div>
  );
}

// Stacked columns (one series = plain columns). `rows[i][key]` = value.
export function Columns({
  labels,
  series,
  rows,
  height = 200,
  format = fmt,
  xLabel = dayLabel,
}: {
  labels: string[];
  series: { key: string; label: string; color: string }[];
  rows: Record<string, number>[];
  height?: number;
  format?: (n: number) => string;
  xLabel?: (s: string) => string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const totals = rows.map((r) => series.reduce((s, k) => s + (r[k.key] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1] || 1;
  const iw = Math.max(1, W - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const band = iw / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band * 0.68));
  const y = (v: number) => PAD.t + (1 - v / top) * ih;
  const cx = (i: number) => PAD.l + band * i + band / 2;
  return (
    <div ref={ref} className='adm-chart' style={{ height }}>
      {W > 0 && (
        <svg width={W} height={height} role='img' aria-label={`${series.map((s) => s.label).join(', ')} per day`} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text className='axis' x={PAD.l - 8} y={y(t) + 4} textAnchor='end'>
                {compact(t)}
              </text>
            </g>
          ))}
          {xTickIdx(n, iw).map((i) => (
            <text key={i} className='axis' x={cx(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {labels[i] ? xLabel(labels[i]) : ''}
            </text>
          ))}
          {rows.map((r, i) => {
            let acc = 0;
            const segs = series
              .map((s) => ({ s, v: r[s.key] ?? 0 }))
              .filter((z) => z.v > 0);
            return (
              <g key={i} opacity={hover == null || hover === i ? 1 : 0.55}>
                {segs.map(({ s, v }, j) => {
                  const y0 = y(acc);
                  acc += v;
                  const y1 = y(acc);
                  const last = j === segs.length - 1;
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between segments
                  const x0 = cx(i) - bw / 2;
                  const rad = last ? Math.min(4, h, bw / 2) : 0;
                  const d = `M${x0},${y1 + h}V${y1 + rad}Q${x0},${y1} ${x0 + rad},${y1}H${x0 + bw - rad}Q${x0 + bw},${y1} ${x0 + bw},${y1 + rad}V${y1 + h}Z`;
                  return h > 0 ? <path key={s.key} d={d} fill={s.color} /> : null;
                })}
              </g>
            );
          })}
          {Array.from({ length: n }, (_, i) => (
            <rect key={i} x={PAD.l + band * i} y={0} width={band} height={height - PAD.b} fill='transparent' onPointerEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && W > 0 && (
        <Tip
          x={cx(hover)}
          width={W}
          title={labels[hover] ? xLabel(labels[hover]) : ''}
          rows={series
            .filter((s) => (rows[hover]?.[s.key] ?? 0) > 0 || series.length === 1)
            .map((s) => ({ label: s.label, color: s.color, value: format(rows[hover]?.[s.key] ?? 0) }))}
          total={series.length > 1 ? format(totals[hover] ?? 0) : undefined}
        />
      )}
    </div>
  );
}

// Horizontal magnitude rows: label · bar · value. Colour optional (defaults to
// one hue — magnitude, not identity).
export function BarList({
  rows,
  format = fmt,
  color = SERIES[0],
  max,
}: {
  rows: { key: string; label: ReactNode; value: number; color?: string; note?: string }[];
  format?: (n: number) => string;
  color?: string;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className='adm-barlist'>
      {rows.map((r) => (
        <div key={r.key} className='contents' title={r.note}>
          <span className='min-w-0 truncate text-[var(--adm-ink-2)]'>{r.label}</span>
          <span className='track'>
            <span className='fill' style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100)}%`, background: r.color ?? color }} />
          </span>
          <span className='val'>{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

// A tiny trend line for stat tiles (de-emphasis hue, current point in accent).
export function Sparkline({ points, width = 92, height = 26, accent = '#5be3ff' }: { points: number[]; width?: number; height?: number; accent?: string }) {
  const n = points.length;
  if (n < 2) return null;
  const max = Math.max(1, ...points);
  const x = (i: number) => 2 + (i / (n - 1)) * (width - 6);
  const y = (v: number) => 3 + (1 - v / max) * (height - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} aria-hidden className='block'>
      <path d={d} fill='none' stroke='#3a4859' strokeWidth={1.5} strokeLinejoin='round' strokeLinecap='round' />
      <circle cx={x(n - 1)} cy={y(points[n - 1])} r={2.5} fill={accent} />
    </svg>
  );
}
