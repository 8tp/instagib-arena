// The Daily Spin wheel: an SVG wheel with a glowing rim, marquee bulbs, a
// spring pointer and a hub cap. The rotation runs in ONE requestAnimationFrame
// loop that writes the transform straight to the DOM (no per-frame React
// state): an idle drift, then an ease-out spin (dt-based, ~4.8 s; short under
// reduced effects) that lands inside the server-chosen wedge. The pointer
// ticks (caseTick) and kicks as each wedge boundary passes under it.
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { playUi } from '../game/audio';

export type Wedge = {
  id: string;
  label: string; // short text on the wedge
  pct: number; // true probability 0..1 (printed in the odds panel)
  weight: number; // visual size (min-clamped so tiny wedges stay legible)
  from: string; // gradient inner colour
  to: string; // gradient rim colour
  edge: string; // divider / glow colour
  ink?: string; // label colour
};

export type WheelHandle = { spinTo: (id: string) => Promise<void> };

const R = 188; // wedge radius
const VB = 232; // viewBox half-extent
const BULBS = 28;
const HUB_R = 40; // hub cap radius
const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (deg: number, r: number): [number, number] => [Math.sin(rad(deg)) * r, -Math.cos(rad(deg)) * r];

function wedgePath(a0: number, a1: number): string {
  const [x0, y0] = pt(a0, R);
  const [x1, y1] = pt(a1, R);
  return `M0 0 L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export function SpinWheel({
  wedges,
  reduced,
  ref,
  winId,
  hub = 'SPIN',
  accent = '#ffc23d',
  label,
  dim = false,
  onSpinning,
}: {
  wedges: Wedge[];
  reduced: boolean;
  ref?: Ref<WheelHandle>;
  winId?: string | null; // the landed wedge (glows)
  hub?: string;
  accent?: string;
  label: string;
  dim?: boolean;
  onSpinning?: (spinning: boolean) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const wheelRef = useRef<SVGGElement>(null);
  const pointerRef = useRef<SVGGElement>(null);
  const angle = useRef(Math.random() * 360);
  const anim = useRef<{ from: number; delta: number; t0: number; dur: number; done: () => void } | null>(null);
  const [spinning, setSpinning] = useState(false);

  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const onSpinningRef = useRef(onSpinning);
  onSpinningRef.current = onSpinning;

  // Wedge angles (clockwise from 12 o'clock).
  const geo = useMemo(() => {
    const total = wedges.reduce((a, w) => a + w.weight, 0) || 1;
    let a = 0;
    return wedges.map((w) => {
      const span = (w.weight / total) * 360;
      const g = { w, a0: a, a1: a + span, mid: a + span / 2, span };
      a += span;
      return g;
    });
  }, [wedges]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useImperativeHandle(
    ref,
    () => ({
      spinTo: (id: string) =>
        new Promise<void>((resolve) => {
          const g = geoRef.current.find((x) => x.w.id === id);
          if (!g || anim.current) {
            resolve();
            return;
          }
          // Land somewhere inside the wedge (never on a divider): the wheel angle
          // under the pointer is (-rotation) mod 360.
          const margin = Math.min(g.span * 0.2, 6);
          const inside = g.a0 + margin + Math.random() * Math.max(0.1, g.span - margin * 2);
          const turns = reducedRef.current ? 2 : 5 + Math.floor(Math.random() * 2);
          const cur = angle.current;
          let target = -inside; // rotation that puts `inside` under the pointer, mod 360
          target += 360 * Math.ceil((cur - target) / 360 + turns);
          anim.current = { from: cur, delta: target - cur, t0: performance.now(), dur: reducedRef.current ? 1500 : 4800, done: resolve };
          setSpinning(true);
          onSpinningRef.current?.(true);
        }),
    }),
    [],
  );

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let kick = 0;
    let prevBoundary = -1;
    const boundaryIndex = (rot: number): number => {
      const under = (((-rot % 360) + 360) % 360) + 0; // wheel angle under the pointer
      const gs = geoRef.current;
      for (let i = 0; i < gs.length; i++) if (under < gs[i].a1) return i;
      return 0;
    };
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const a = anim.current;
      if (a) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const e = 1 - Math.pow(1 - t, 3.6);
        angle.current = a.from + a.delta * e;
        const idx = boundaryIndex(angle.current);
        if (prevBoundary >= 0 && idx !== prevBoundary) {
          playUi('caseTick', t);
          kick = 1;
        }
        prevBoundary = idx;
        if (t >= 1) {
          anim.current = null;
          prevBoundary = -1;
          setSpinning(false);
          onSpinningRef.current?.(false);
          a.done();
        }
      } else if (!reducedRef.current) {
        angle.current += 5 * dt; // idle drift
      }
      kick *= Math.exp(-16 * dt); // frame-rate independent pointer settle
      wheelRef.current?.setAttribute('transform', `rotate(${angle.current.toFixed(3)})`);
      pointerRef.current?.setAttribute('transform', `rotate(${(-26 * kick).toFixed(2)} 0 ${-R - 22})`);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      // A spin cut short (tab switch) must still resolve so the caller can apply its result.
      const a = anim.current;
      anim.current = null;
      a?.done();
    };
  }, []);

  const bulbs = useMemo(() => Array.from({ length: BULBS }, (_, i) => pt((i / BULBS) * 360, R + 17)), []);

  return (
    <div className={`sp-wheel ${spinning ? 'is-spinning' : ''} ${dim ? 'is-dim' : ''}`} style={{ ['--acc' as string]: accent }}>
      <svg viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`} role='img' aria-label={label} className='sp-svg'>
        <defs>
          {geo.map(({ w }) => (
            <radialGradient key={w.id} id={`${uid}-g-${w.id}`} cx='0' cy='0' r={R} gradientUnits='userSpaceOnUse'>
              <stop offset='0.12' stopColor={w.from} />
              <stop offset='1' stopColor={w.to} />
            </radialGradient>
          ))}
          <radialGradient id={`${uid}-rim`} cx='0' cy='0' r={R + 30} gradientUnits='userSpaceOnUse'>
            <stop offset='0.84' stopColor='#171b24' />
            <stop offset='0.93' stopColor='#2a3040' />
            <stop offset='1' stopColor='#0c0f15' />
          </radialGradient>
          <radialGradient id={`${uid}-hub`} cx='-7' cy='-9' r='40' gradientUnits='userSpaceOnUse'>
            <stop offset='0' stopColor='#5b6478' />
            <stop offset='0.55' stopColor='#222836' />
            <stop offset='1' stopColor='#0b0e15' />
          </radialGradient>
          <linearGradient id={`${uid}-ptr`} x1='0' y1='0' x2='0' y2='1'>
            <stop offset='0' stopColor='#fff2c4' />
            <stop offset='1' stopColor={accent} />
          </linearGradient>
          <filter id={`${uid}-glow`} x='-20%' y='-20%' width='140%' height='140%'>
            <feGaussianBlur stdDeviation='6' />
          </filter>
        </defs>

        {/* Glow halo behind the rim */}
        <circle r={R + 26} fill='none' stroke={accent} strokeWidth='10' opacity='0.5' filter={`url(#${uid}-glow)`} className='sp-halo' />
        <circle r={R + 30} fill={`url(#${uid}-rim)`} stroke={accent} strokeOpacity='0.55' strokeWidth='1.5' />
        <circle r={R + 6} fill='#05070b' />

        {/* The rotating wheel */}
        <g ref={wheelRef}>
          {geo.map(({ w, a0, a1, mid, span }) => {
            const win = winId === w.id && !spinning;
            const [lx, ly] = pt(mid, R * 0.93);
            // Radial label along the wedge (reads outward-in from the rim). The
            // size is capped so the text always ends clear of the hub cap.
            const fs0 = span < 26 ? 15 : span < 44 ? 19 : 22;
            const avail = R * 0.93 - (HUB_R + 8);
            const fs = Math.min(fs0, avail / (Math.max(1, w.label.length) * 0.92));
            return (
              <g key={w.id} className={win ? 'sp-win' : undefined} style={{ ['--wc' as string]: w.edge }}>
                <path d={wedgePath(a0, a1)} fill={`url(#${uid}-g-${w.id})`} stroke='rgba(6,8,12,0.85)' strokeWidth='2.5' strokeLinejoin='round' />
                <path d={wedgePath(a0, a1)} fill='none' stroke={w.edge} strokeOpacity='0.55' strokeWidth='1' className='sp-wedge-line' />
                <text
                  x={lx}
                  y={ly}
                  transform={`rotate(${mid - 90} ${lx} ${ly})`}
                  textAnchor='end'
                  dominantBaseline='central'
                  className='sp-wedge-text'
                  fontSize={fs}
                  fill={w.ink ?? '#fff'}
                >
                  {w.label}
                </text>
              </g>
            );
          })}
          {/* inner ring shading */}
          <circle r={HUB_R + 6} fill='none' stroke='rgba(0,0,0,0.35)' strokeWidth='2' />
        </g>

        {/* Marquee bulbs (fixed) */}
        {bulbs.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r='4.2' className={`sp-bulb ${i % 2 ? 'b' : 'a'}`} />
        ))}

        {/* Hub cap */}
        <circle r={HUB_R} fill={`url(#${uid}-hub)`} stroke={accent} strokeWidth='3' />
        <circle r={HUB_R - 8} fill='none' stroke='rgba(255,255,255,0.14)' strokeWidth='1.5' />
        <text y='1' textAnchor='middle' dominantBaseline='central' className='sp-hub-text' fill={accent}>
          {hub}
        </text>

        {/* Pointer */}
        <g ref={pointerRef} className='sp-pointer'>
          <path d={`M-19 ${-R - 34} L19 ${-R - 34} L19 ${-R - 16} L0 ${-R + 14} L-19 ${-R - 16} Z`} fill='rgba(0,0,0,0.55)' transform='translate(0 3)' />
          <path d={`M-19 ${-R - 34} L19 ${-R - 34} L19 ${-R - 16} L0 ${-R + 14} L-19 ${-R - 16} Z`} fill={`url(#${uid}-ptr)`} stroke='#0b0e15' strokeWidth='2.5' strokeLinejoin='round' />
          <circle cx='0' cy={-R - 22} r='5.5' fill='#0b0e15' stroke={accent} strokeWidth='1.5' />
        </g>
      </svg>
    </div>
  );
}
