// Screen-level juice for the case reveal: flashes, edge glow, shockwaves, the
// Unobtainable takeover + title card, and one canvas-2D particle layer (sparks,
// embers, the iridescent storm, unusual sparkles). Portalled over the whole
// viewport, pointer-events none, and short-lived: everything is a CSS keyframe
// except the particles, which run their own rAF with a dt clamp (motion from
// velocity × dt and exp(-k·dt) drag — frame-rate independent) and stop and
// unmount their loop once the last particle dies. Never mounted when effects
// are reduced; lowSpec gets roughly a third of the particles at 1× DPR.
import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { TIER_META, type Tier } from '../game/items/types';
import { TIER_COLOR } from '../ui/rarity';

export type FxOrigin = { x: number; y: number };

const IRI = ['#ff4fd8', '#7c5cff', '#2ee6d6', '#ffe14d', '#ffffff'];
const GOLD = ['#ffd35a', '#ffb020', '#fff1c2', '#f59e0b'];
const CRIMSON = ['#ff3b3b', '#ff7a45', '#ffd0c0', '#b91c1c'];
const PURPLE = ['#c58bff', '#a855f7', '#f0dcff', '#7c3aed'];

type Shape = 'streak' | 'dot' | 'star';
type P = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number; // gravity px/s²
  drag: number; // 1/s
  life: number;
  max: number;
  size: number;
  color: string;
  shape: Shape;
  delay: number; // s before it appears
  // storm swirl (polar around the origin) when orbit > 0
  orbit: number;
  ang: number;
  rad: number;
  vr: number;
};

type Emit = {
  n: number;
  colors: string[];
  shape: Shape;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  g?: number;
  drag?: number;
  spread?: number; // spawn jitter radius
  delay?: [number, number];
  up?: number; // bias upwards (px/s)
  storm?: boolean;
  ring?: number; // spawn on a ring of this radius around the origin (twinkles)
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function plan(tier: Tier, unusual: boolean): Emit[] {
  const out: Emit[] = [];
  const edge = TIER_COLOR[tier].edge;
  switch (tier) {
    case 'rare':
      out.push({ n: 18, colors: [edge, '#dbe8ff', '#ffffff'], shape: 'streak', speed: [280, 620], life: [0.5, 0.9], size: [1.5, 2.5], drag: 2.6 });
      break;
    case 'epic':
      out.push({ n: 28, colors: [edge, '#e9d5ff', '#ffffff'], shape: 'streak', speed: [320, 720], life: [0.55, 1], size: [1.6, 2.8], drag: 2.4 });
      break;
    case 'legendary':
      out.push({ n: 60, colors: GOLD, shape: 'streak', speed: [380, 980], life: [0.6, 1.3], size: [1.8, 3.2], drag: 2.2, g: 260 });
      out.push({ n: 26, colors: GOLD, shape: 'dot', speed: [60, 220], life: [1.2, 2.2], size: [1.4, 2.6], drag: 1.2, g: -30, spread: 60, delay: [0.05, 0.6] });
      break;
    case 'relic':
      out.push({ n: 74, colors: CRIMSON, shape: 'streak', speed: [520, 1300], life: [0.45, 1], size: [2, 3.6], drag: 2.8, g: 380 });
      out.push({ n: 30, colors: CRIMSON, shape: 'dot', speed: [40, 180], life: [1.2, 2.4], size: [1.6, 3], drag: 1, g: -40, spread: 90, delay: [0.1, 0.8] });
      break;
    case 'unobtainable':
      out.push({ n: 70, colors: IRI, shape: 'streak', speed: [500, 1400], life: [0.6, 1.3], size: [2, 3.6], drag: 2.2, g: 160 });
      out.push({ n: 170, colors: IRI, shape: 'star', speed: [0, 0], life: [0.9, 1.7], size: [2.5, 6], storm: true, delay: [0, 0.8] });
      break;
    default:
      break;
  }
  if (unusual) out.push({ n: 44, colors: PURPLE, shape: 'star', speed: [10, 70], life: [0.7, 1.5], size: [3, 7], drag: 1.5, g: -24, ring: 120, delay: [0.25, 1.9] });
  return out;
}

function spawn(e: Emit, o: FxOrigin, scale: number, w: number, h: number): P[] {
  const n = Math.max(1, Math.round(e.n * scale));
  const ps: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rnd(e.speed[0], e.speed[1]);
    const max = rnd(e.life[0], e.life[1]);
    const color = e.colors[Math.floor(Math.random() * e.colors.length)];
    const base: P = {
      x: o.x,
      y: o.y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - (e.up ?? 0),
      g: e.g ?? 0,
      drag: e.drag ?? 0,
      life: max,
      max,
      size: rnd(e.size[0], e.size[1]),
      color,
      shape: e.shape,
      delay: e.delay ? rnd(e.delay[0], e.delay[1]) : 0,
      orbit: 0,
      ang: a,
      rad: 0,
      vr: 0,
    };
    if (e.spread) {
      base.x += Math.cos(a) * Math.random() * e.spread;
      base.y += Math.sin(a) * Math.random() * e.spread;
    }
    if (e.ring) {
      const r = e.ring * (0.55 + Math.random() * 0.6);
      base.x = o.x + Math.cos(a) * r * 1.25;
      base.y = o.y + Math.sin(a) * r;
    }
    if (e.storm) {
      // Spiral in from the whole screen towards the card, then flung out.
      base.orbit = (Math.random() < 0.5 ? -1 : 1) * rnd(1.2, 2.6);
      base.rad = rnd(0.25, 0.75) * Math.hypot(w, h) * 0.5;
      base.vr = rnd(-260, 120);
    }
    ps.push(base);
  }
  return ps;
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const k = r * 0.28;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + k, y - k);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x + k, y + k);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - k, y + k);
  ctx.lineTo(x - r, y);
  ctx.lineTo(x - k, y - k);
  ctx.closePath();
  ctx.fill();
}

function Particles({ tier, unusual, origin, lowSpec }: { tier: Tier; unusual: boolean; origin: FxOrigin; lowSpec: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = lowSpec ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const scale = lowSpec ? 0.35 : 1;
    const ps: P[] = plan(tier, unusual).flatMap((e) => spawn(e, origin, scale, w, h));
    if (!ps.length) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      let alive = 0;
      for (const p of ps) {
        if (p.delay > 0) {
          p.delay -= dt;
          alive++;
          continue;
        }
        p.life -= dt;
        if (p.life <= 0) continue;
        alive++;
        const t = 1 - p.life / p.max; // 0 → 1
        if (p.orbit) {
          p.ang += p.orbit * dt * (1.4 - t);
          p.rad = Math.max(0, p.rad + p.vr * dt - 220 * dt * (1 - t));
          const nx = origin.x + Math.cos(p.ang) * p.rad * 1.3;
          const ny = origin.y + Math.sin(p.ang) * p.rad;
          p.vx = (nx - p.x) / Math.max(dt, 1e-3);
          p.vy = (ny - p.y) / Math.max(dt, 1e-3);
          p.x = nx;
          p.y = ny;
        } else {
          const k = Math.exp(-p.drag * dt);
          p.vx *= k;
          p.vy = p.vy * k + p.g * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
        ctx.globalAlpha = Math.max(0, fade);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;
        if (p.shape === 'streak') {
          const len = Math.min(0.045, 0.02 + (1 - t) * 0.03);
          ctx.lineWidth = p.size;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * len, p.y - p.vy * len);
          ctx.stroke();
        } else if (p.shape === 'star') {
          const tw = p.orbit ? 1 : Math.sin(t * Math.PI);
          star(ctx, p.x, p.y, p.size * (0.4 + tw * 0.9));
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (alive > 0) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tier, unusual, origin, lowSpec]);
  return <canvas ref={ref} className='ecfx-canvas' aria-hidden />;
}

// The land-and-reveal layer. `origin` = the hero thumbnail's centre (viewport px).
export function RevealFx({ tier, unusual, origin, lowSpec, name }: { tier: Tier; unusual: boolean; origin: FxOrigin; lowSpec: boolean; name: string }) {
  if (typeof document === 'undefined') return null;
  const c = TIER_COLOR[tier].edge;
  const rank = TIER_META[tier].rank;
  const vars = { '--fc': c, '--ox': `${origin.x}px`, '--oy': `${origin.y}px` } as CSSProperties;
  return createPortal(
    <div className={`ecfx ecfx-${tier}`} style={vars} aria-hidden>
      {rank >= 2 && <div className='ecfx-flash' />}
      {rank >= 4 && <div className='ecfx-edge' />}
      {tier === 'legendary' && <div className='ecfx-streak' />}
      {rank >= 5 && (
        <>
          <div className='ecfx-wave' />
          <div className='ecfx-wave ecfx-wave-2' />
        </>
      )}
      {tier === 'unobtainable' && (
        <>
          <div className='ecfx-settle' />
          <div className='ecfx-takeover' />
          <div className='ecfx-title'>
            <span className='ecfx-title-kicker'>You unboxed</span>
            <span className='ecfx-title-main'>Unobtainable</span>
            <span className='ecfx-title-name'>{name}</span>
          </div>
        </>
      )}
      <Particles tier={tier} unusual={unusual} origin={origin} lowSpec={lowSpec} />
    </div>,
    document.body,
  );
}

// The slow-mo beat before a Relic / Unobtainable reveal: the world dims to a
// vignette around the reel's centre while the landed cell pulses.
export function HoldFx({ tier }: { tier: Tier }) {
  if (typeof document === 'undefined') return null;
  return createPortal(<div className={`ecfx-hold ecfx-hold-${tier}`} style={{ '--fc': TIER_COLOR[tier].edge } as CSSProperties} aria-hidden />, document.body);
}
